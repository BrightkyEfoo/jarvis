import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ApprovalBroker } from './approvals.ts';
import type { Decision, PolicyEngine } from './engine.ts';
import type { KillSwitch } from './killswitch.ts';
import { type Classification, forbid, levelName, N3 } from './levels.ts';
import type { Session } from './provenance.ts';

export interface ToolContext {
  session: Session;
  signal: AbortSignal;
  cwd: string;
}

export interface RunContext extends ToolContext {
  classification: Classification;
}

type Args<S extends z.ZodRawShape> = z.infer<z.ZodObject<S>>;

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  /** snake_case; exposed to the model as mcp__jarvis__<name>. */
  name: string;
  description: string;
  input: S;
  /** Decides the level from the concrete arguments. Must be pure and fast. */
  classify: (args: Args<S>, ctx: ToolContext) => Classification;
  /** One line shown to Brightky when approval is needed. */
  summarize: (args: Args<S>) => string;
  /** Output comes from outside Brightky (files, web, mail…): taints the session. */
  ingestsExternal?: boolean;
  run: (args: Args<S>, ctx: RunContext) => Promise<string>;
}

const TOOL_NAME = /^[a-z][a-z0-9_]{1,40}$/;

export function defineTool<S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef<S> {
  if (!TOOL_NAME.test(def.name)) throw new Error(`invalid tool name ${def.name}`);
  return Object.freeze(def);
}

/** Structural so the policy package does not depend on the audit implementation. */
export interface AuditSink {
  append(e: {
    event: 'intent' | 'result' | 'approval';
    actionId?: string;
    tool?: string;
    level?: number;
    rule?: string;
    verdict?: string;
    trigger?: string;
    origin?: string;
    tainted?: boolean;
    approval?: string;
    outcome?: string;
    durationMs?: number;
    data?: unknown;
  }): unknown;
}

export interface GateDeps {
  engine: PolicyEngine;
  approvals: ApprovalBroker;
  killswitch: KillSwitch;
  audit: AuditSink;
  redact: (text: string) => string;
  cwd: string;
  toolTimeoutMs: number;
  maxOutputChars?: number;
  devMode?: boolean;
}

export interface GateResult {
  ok: boolean;
  content: string;
  actionId: string;
  decision?: Decision;
}

export interface InvokeMeta {
  /** What started this: `cli`, `voice`, `scheduler`, `test`… */
  trigger: string;
  toolUseId?: string;
}

interface Registered {
  def: ToolDef;
  schema: z.ZodObject;
}

const EXTERNAL_OPEN = '<external_data';
const EXTERNAL_CLOSE = '</external_data>';

/** External text is data, never instructions: fence it and neutralise fake closing tags. */
function fenceExternal(source: string, text: string): string {
  const safe = text
    .replaceAll(EXTERNAL_CLOSE, '</external_data_>')
    .replaceAll(EXTERNAL_OPEN, '<external_data_');
  return `${EXTERNAL_OPEN} source="${source}">\n${safe}\n${EXTERNAL_CLOSE}`;
}

/**
 * The only way a tool runs. Order: STOP → input validation → classification → policy →
 * approval → audit → execution → redaction → audit. Everything fails closed.
 */
export class Gate {
  readonly #d: GateDeps;
  readonly #tools = new Map<string, Registered>();

  constructor(deps: GateDeps) {
    this.#d = deps;
  }

  register<S extends z.ZodRawShape>(def: ToolDef<S>): void {
    if (this.#tools.has(def.name)) throw new Error(`tool ${def.name} registered twice`);
    this.#tools.set(def.name, {
      def: def as unknown as ToolDef,
      schema: z.object(def.input).strict(),
    });
  }

  get tools(): ToolDef[] {
    return [...this.#tools.values()].map((t) => t.def);
  }

  async invoke(
    name: string,
    rawInput: unknown,
    session: Session,
    meta: InvokeMeta,
  ): Promise<GateResult> {
    const d = this.#d;
    const actionId = randomUUID();
    const t0 = performance.now();
    const who = {
      actionId,
      tool: name,
      trigger: meta.trigger,
      origin: session.origin,
      tainted: session.tainted,
    };
    const refuse = (cls: Classification, verdict: string, decision?: Decision): GateResult => {
      d.audit.append({
        event: 'result',
        ...who,
        level: cls.level,
        rule: cls.rule,
        verdict,
        outcome: 'refused',
        data: { reason: cls.reason },
      });
      const content = `Action refused (${levelName(cls.level)}, rule ${cls.rule}): ${cls.reason}`;
      return decision
        ? { ok: false, content, actionId, decision }
        : { ok: false, content, actionId };
    };

    const tool = this.#tools.get(name);
    if (!tool) return refuse(forbid('tool.unknown', `no tool named ${name}`), 'deny');
    if (d.killswitch.engaged)
      return refuse(forbid('killswitch', `STOP engaged: ${d.killswitch.reason}`), 'deny');

    const parsed = tool.schema.safeParse(rawInput);
    if (!parsed.success) {
      return refuse(forbid('input.invalid', z.prettifyError(parsed.error).slice(0, 400)), 'deny');
    }
    const args = parsed.data as Record<string, unknown>;
    const ctx: ToolContext = { session, signal: d.killswitch.signal, cwd: d.cwd };

    let cls: Classification;
    try {
      cls = tool.def.classify(args, ctx);
    } catch (e) {
      cls = forbid('classify.error', (e as Error).message);
    }
    const decision = d.engine.evaluate(name, args, cls, session, { devMode: d.devMode ?? false });
    const summary = d.redact(tool.def.summarize(args));
    d.audit.append({
      event: 'intent',
      ...who,
      level: decision.level,
      rule: decision.rule,
      verdict: decision.verdict,
      data: {
        input: JSON.parse(d.redact(JSON.stringify(args))),
        summary,
        toolUseId: meta.toolUseId,
      },
    });

    if (decision.verdict === 'deny') return refuse(decision, 'deny', decision);

    if (decision.verdict === 'confirm' || decision.verdict === 'confirm_pin') {
      const outcome = await d.approvals.request(
        {
          tool: name,
          level: decision.level,
          rule: decision.rule,
          summary,
          reason: decision.reason,
          needsPin: decision.verdict === 'confirm_pin' || decision.level >= N3,
          tainted: session.tainted,
          externalDestinations: decision.externalDestinations,
        },
        d.killswitch.signal,
      );
      d.audit.append({
        event: 'approval',
        ...who,
        level: decision.level,
        approval: outcome.channel,
        outcome: outcome.approved ? 'approved' : 'refused',
        data: { reason: outcome.reason, summary },
      });
      if (!outcome.approved) {
        return refuse(
          { ...decision, rule: `approval.${outcome.channel}`, reason: outcome.reason },
          'refused',
          decision,
        );
      }
    }

    if (d.killswitch.engaged)
      return refuse(forbid('killswitch', `STOP engaged: ${d.killswitch.reason}`), 'deny', decision);

    const signal = AbortSignal.any([d.killswitch.signal, AbortSignal.timeout(d.toolTimeoutMs)]);
    let output: string;
    try {
      output = await tool.def.run(args, { ...ctx, signal, classification: cls });
    } catch (e) {
      const message = d.redact((e as Error).message ?? String(e));
      d.audit.append({
        event: 'result',
        ...who,
        level: decision.level,
        rule: decision.rule,
        outcome: 'error',
        durationMs: performance.now() - t0,
        data: { error: message, summary },
      });
      return { ok: false, content: `Tool error: ${message}`, actionId, decision };
    }

    if (tool.def.ingestsExternal) session.ingestExternal(output);
    const max = d.maxOutputChars ?? 100_000;
    let content = d.redact(output);
    if (content.length > max)
      content = `${content.slice(0, max)}\n[… truncated ${content.length - max} chars]`;
    if (tool.def.ingestsExternal) content = fenceExternal(name, content);

    d.audit.append({
      event: 'result',
      ...who,
      tainted: session.tainted,
      level: decision.level,
      rule: decision.rule,
      outcome: 'ok',
      durationMs: performance.now() - t0,
      data: { chars: content.length, autoApproved: decision.autoApproved, summary },
    });
    return { ok: true, content, actionId, decision };
  }
}
