import { mkdirSync } from 'node:fs';
import {
  createSdkMcpServer,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  startup,
  tool,
} from '@anthropic-ai/claude-agent-sdk';
import type { AuditLog } from '@jarvis/audit';
import { type Gate, type KillSwitch, type Policy, Session } from '@jarvis/policy';
import { sdkEnv } from '../env.ts';
import { subscriptionProblems, surfaceProblems, TOOL_PREFIX } from '../guards.ts';
import type { AppPaths } from '../paths.ts';
import type { AskHandlers, AskResult, Brain } from './brain.ts';
import { preToolUseHook } from './hooks.ts';
import { SYSTEM_PROMPT } from './prompt.ts';
import type { RateLimitInfo } from './quota.ts';
import { type QuotaState, type Route, routeModel } from './router.ts';
import { type Totals, type TurnUsage, turnUsage } from './usage.ts';

/** Every built-in Claude Code tool, removed by name as a second layer on top of `tools: []`. */
const BUILTIN_TOOLS = [
  'Agent',
  'AskUserQuestion',
  'Bash',
  'BashOutput',
  'Edit',
  'ExitPlanMode',
  'Glob',
  'Grep',
  'KillShell',
  'MultiEdit',
  'NotebookEdit',
  'Read',
  'Skill',
  'SlashCommand',
  'Task',
  'TodoWrite',
  'ToolSearch',
  'WebFetch',
  'WebSearch',
  'Write',
];

/** Push-based prompt stream: keeps one Claude Code process alive across turns (no cold start). */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  readonly #items: SDKUserMessage[] = [];
  readonly #waiters: ((r: IteratorResult<SDKUserMessage>) => void)[] = [];
  #closed = false;

  push(m: SDKUserMessage): void {
    const w = this.#waiters.shift();
    if (w) w({ value: m, done: false });
    else this.#items.push(m);
  }

  close(): void {
    this.#closed = true;
    for (const w of this.#waiters.splice(0)) w({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.#items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => this.#waiters.push(r));
      },
    };
  }
}

interface Turn {
  handlers: AskHandlers;
  resolve: (r: AskResult) => void;
  text: string;
  /** API-level failure reported on an assistant message (auth, billing, overload…). */
  error: string | undefined;
  route: Route;
}

export interface TurnRecord {
  trigger: string;
  route: Route;
  usage: TurnUsage;
  model: string;
  ttftMs: number | null;
  durationMs: number;
}

export interface ClaudeBrainDeps {
  gate: Gate;
  policy: Policy;
  killswitch: KillSwitch;
  audit: AuditLog;
  paths: AppPaths;
  home: string;
  cwd: string;
  oauthToken: string;
  onRateLimit: (info: RateLimitInfo) => void;
  /** Memory snapshot for the system prompt, read at each session start. */
  memorySnapshot: () => string;
  quota: () => QuotaState;
  onTurn: (t: TurnRecord) => void;
}

export class ClaudeBrain implements Brain {
  readonly #d: ClaudeBrainDeps;
  #session = new Session('user');
  #trigger = 'cli';
  #q: Query | null = null;
  #input: InputQueue | null = null;
  #starting: Promise<void> | null = null;
  #turn: Turn | null = null;
  #lock: Promise<unknown> = Promise.resolve();
  #surfaceLogged = false;
  #model: string;
  #totals: Totals | null = null;

  constructor(deps: ClaudeBrainDeps) {
    this.#d = deps;
    this.#model = deps.policy.models.conversation;
  }

  get session(): Session {
    return this.#session;
  }

  #options(): Options {
    const d = this.#d;
    const tools = d.gate.tools.map((def) =>
      tool(
        def.name,
        def.description,
        def.input,
        async (args) => {
          const r = await d.gate.invoke(def.name, args, this.#session, { trigger: this.#trigger });
          return { content: [{ type: 'text', text: r.content }], isError: !r.ok };
        },
        { alwaysLoad: true },
      ),
    );
    const allowed = d.gate.tools.map((t) => `${TOOL_PREFIX}${t.name}`);
    mkdirSync(d.paths.claudeConfig, { recursive: true, mode: 0o700 });
    mkdirSync(d.paths.scratch, { recursive: true, mode: 0o700 });

    return {
      model: d.policy.models.conversation,
      effort: d.policy.models.effort,
      // Static prefix (globally cacheable) | per-session memory snapshot.
      systemPrompt: [
        SYSTEM_PROMPT,
        SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
        memoryBlock(d.memorySnapshot()),
      ],
      cwd: d.cwd,
      env: sdkEnv({
        home: d.home,
        oauthToken: d.oauthToken,
        claudeConfigDir: d.paths.claudeConfig,
        tmpDir: d.paths.scratch,
      }),
      // Isolation: no ~/.claude settings, hooks, CLAUDE.md, plugins, skills or foreign MCP servers.
      settingSources: [],
      strictMcpConfig: true,
      persistSession: false,
      tools: [],
      disallowedTools: BUILTIN_TOOLS,
      mcpServers: {
        jarvis: createSdkMcpServer({ name: 'jarvis', version: '0.1.0', tools, alwaysLoad: true }),
      },
      allowedTools: allowed,
      permissionMode: 'dontAsk',
      permissionPrompts: 'none',
      // No canUseTool: with permissionPrompts 'none' the SDK never calls it. The PreToolUse hook
      // and the Gate inside each handler are the enforcement points.
      hooks: { PreToolUse: [{ hooks: [preToolUseHook(d.killswitch, new Set(allowed))] }] },
      maxTurns: d.policy.limits.max_turns,
      maxBudgetUsd: d.policy.limits.max_budget_usd_per_query,
      includePartialMessages: true,
    };
  }

  async warm(): Promise<void> {
    if (this.#q || this.#d.killswitch.engaged) return;
    this.#starting ??= this.#start().finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }

  async #start(): Promise<void> {
    const input = new InputQueue();
    const warm = await startup({ options: this.#options(), initializeTimeoutMs: 30_000 });
    const q = warm.query(input);

    const info = await q.accountInfo();
    const problems = subscriptionProblems(info);
    this.#d.audit.append({
      event: 'system',
      outcome: problems.length ? 'brain_refused' : 'brain_started',
      data: {
        subscriptionType: info.subscriptionType,
        tokenSource: info.tokenSource,
        apiKeySource: info.apiKeySource,
        apiProvider: info.apiProvider,
        problems,
      },
    });
    if (problems.length > 0) {
      input.close();
      q.close();
      throw new Error(`refusing to run: ${problems.join('; ')}`);
    }
    this.#q = q;
    this.#input = input;
    this.#model = this.#d.policy.models.conversation;
    this.#totals = null;
    void this.#pump(q);
  }

  async #pump(q: Query): Promise<void> {
    try {
      for await (const m of q) this.#handle(m);
    } catch (e) {
      this.#finish({ ok: false, text: this.#turn?.text ?? '', error: (e as Error).message });
    } finally {
      if (this.#q === q) {
        this.#q = null;
        this.#input = null;
      }
      this.#finish({ ok: false, text: this.#turn?.text ?? '', error: 'model process ended' });
    }
  }

  #handle(m: SDKMessage): void {
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          const problems = [
            ...surfaceProblems(m.tools, m.mcp_servers),
            ...subscriptionProblems({ apiKeySource: m.apiKeySource }),
          ];
          if (!this.#surfaceLogged) {
            this.#surfaceLogged = true;
            this.#d.audit.append({
              event: 'system',
              outcome: 'model_surface',
              data: {
                model: m.model,
                tools: m.tools,
                mcpServers: m.mcp_servers,
                apiKeySource: m.apiKeySource,
                permissionMode: m.permissionMode,
                claudeCode: m.claude_code_version,
              },
            });
          }
          if (problems.length > 0) {
            this.#d.audit.append({
              event: 'system',
              outcome: 'surface_violation',
              data: { problems },
            });
            this.#d.killswitch.engage(`model surface violation: ${problems.join('; ')}`);
          }
        }
        return;
      case 'stream_event':
        if (
          m.parent_tool_use_id === null &&
          m.event.type === 'content_block_delta' &&
          m.event.delta.type === 'text_delta'
        ) {
          const chunk = m.event.delta.text;
          if (this.#turn) {
            this.#turn.text += chunk;
            this.#turn.handlers.onText(chunk);
          }
        }
        return;
      case 'assistant':
        if (m.error && this.#turn) this.#turn.error = m.error;
        for (const block of m.message.content) {
          if (block.type === 'tool_use') this.#turn?.handlers.onTool?.(block.name);
        }
        return;
      case 'rate_limit_event':
        this.#d.onRateLimit(m.rate_limit_info);
        return;
      case 'result': {
        const turnError = this.#turn?.error;
        const ok = m.subtype === 'success' && !m.is_error && !turnError;
        const ttftMs = m.subtype === 'success' ? m.ttft_ms : undefined;
        this.#d.audit.append({
          event: 'llm',
          outcome: m.subtype,
          durationMs: m.duration_ms,
          trigger: this.#trigger,
          origin: this.#session.origin,
          tainted: this.#session.tainted,
          data: {
            ttftMs,
            turns: m.num_turns,
            estimatedCostUsd: m.total_cost_usd,
            modelUsage: m.modelUsage,
          },
        });
        // Totals are cumulative over the long-lived session: this turn is the difference.
        const totals: Totals = { costUsd: m.total_cost_usd, byModel: m.modelUsage };
        const usage = turnUsage(this.#totals, totals);
        this.#totals = totals;
        const route = this.#turn?.route ?? {
          tier: 'conversation',
          model: this.#model,
          reason: 'default',
        };
        const model = usage.model ?? this.#model;
        this.#d.onTurn({
          trigger: this.#trigger,
          route,
          usage,
          model,
          ttftMs: ttftMs ?? null,
          durationMs: m.duration_ms,
        });

        // Locally generated messages (auth errors…) are not streamed: fall back to `result`.
        const streamed = this.#turn?.text ?? '';
        const result: AskResult = {
          ok,
          text: streamed || (m.subtype === 'success' ? m.result : ''),
          turns: m.num_turns,
          costUsd: usage.costUsd,
          model,
          route: { tier: route.tier, reason: route.reason },
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens,
            cacheWriteTokens: usage.cacheWriteTokens,
          },
        };
        if (ttftMs !== undefined) result.ttftMs = ttftMs;
        if (!ok) result.error = turnError ?? (m.subtype === 'success' ? 'error' : m.subtype);
        this.#finish(result);
        return;
      }
      default:
        return;
    }
  }

  #finish(r: AskResult): void {
    const t = this.#turn;
    this.#turn = null;
    t?.resolve(r);
  }

  ask(prompt: string, handlers: AskHandlers, trigger: string): Promise<AskResult> {
    const run = async (): Promise<AskResult> => {
      if (this.#d.killswitch.engaged)
        return { ok: false, text: '', error: `STOP engaged: ${this.#d.killswitch.reason}` };
      await this.warm();
      const input = this.#input;
      const q = this.#q;
      if (!input || !q) return { ok: false, text: '', error: 'model not available' };
      this.#trigger = trigger;
      let route = routeModel(prompt, this.#d.policy.models, this.#d.quota());
      if (route.model !== this.#model) {
        try {
          await q.setModel(route.model);
          this.#model = route.model;
        } catch (e) {
          // A failed switch (model unavailable, quota…) must not cost Brightky his answer.
          const reason = (e as Error).message.slice(0, 200);
          this.#d.audit.append({
            event: 'system',
            outcome: 'model_switch_failed',
            data: { to: route.model, reason },
          });
          route = {
            tier: 'conversation',
            model: this.#model,
            reason: `switch to ${route.model} failed: ${reason}`,
          };
        }
      }
      return new Promise<AskResult>((resolve) => {
        this.#turn = { handlers, resolve, text: '', error: undefined, route };
        input.push({
          type: 'user',
          message: { role: 'user', content: prompt },
          parent_tool_use_id: null,
        });
      });
    };
    // One turn at a time: a second question waits for the first answer.
    const p = this.#lock.then(run, run);
    this.#lock = p.catch(() => undefined);
    return p;
  }

  async stop(reason: string): Promise<void> {
    const q = this.#q;
    this.#q = null;
    this.#input?.close();
    this.#input = null;
    if (q) {
      await Promise.race([
        q.interrupt().catch(() => undefined),
        new Promise((r) => setTimeout(r, 300)),
      ]);
      q.close();
    }
    this.#finish({ ok: false, text: this.#turn?.text ?? '', error: `stopped: ${reason}` });
  }

  async newSession(): Promise<void> {
    await this.stop('new session');
    this.#session = new Session('user');
  }

  async close(): Promise<void> {
    await this.stop('shutdown');
  }
}

function memoryBlock(snapshot: string): string {
  return snapshot
    ? `# Mémoire\nCe que Brightky t'a appris ou t'a demandé de retenir (fiable) :\n\n${snapshot}`
    : '# Mémoire\n(vide)';
}
