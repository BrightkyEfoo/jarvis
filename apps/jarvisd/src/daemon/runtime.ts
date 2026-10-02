import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AuditLog } from '@jarvis/audit';
import {
  type CalendarProvider,
  type ForgeClient,
  type ForgeId,
  GitHubClient,
  GitLabClient,
  GmailProvider,
  GoogleAuth,
  GoogleCalendar,
  type GoogleClient,
  ImapProvider,
  type MailProvider,
  TrelloClient,
} from '@jarvis/connectors';
import { Memory } from '@jarvis/memory';
import {
  ApprovalBroker,
  FsPolicy,
  Gate,
  KillSwitch,
  loadPolicy,
  PinGuard,
  type Policy,
  PolicyEngine,
  ShellClassifier,
} from '@jarvis/policy';
import { Redactor, SecretName, type SecretStore } from '@jarvis/secrets';
import { type Actuator, ActuatorBridge } from '../computer/bridge.ts';
import type { Brain } from '../orchestrator/brain.ts';
import { ClaudeBrain } from '../orchestrator/claude.ts';
import {
  MetadataSummarizer,
  QuarantineSummarizer,
  type Summarizer,
} from '../orchestrator/quarantine.ts';
import { quotaAction, type RateLimitInfo } from '../orchestrator/quota.ts';
import { ClaudeResearcher, type Researcher } from '../orchestrator/research.ts';
import type { AppPaths } from '../paths.ts';
import { createComputerTools } from '../tools/computer.ts';
import { createForgeTools, workBriefing } from '../tools/forge.ts';
import { createTools } from '../tools/index.ts';
import { createMacTools, type MacOps, realMacOps } from '../tools/macos.ts';
import { createMailTools } from '../tools/mail.ts';
import { createMemoryTools } from '../tools/memory.ts';
import { createResearchTools, type YouTube, YtDlp } from '../tools/research.ts';
import { createTrelloWorkerTools, trelloFollowUp } from '../tools/trello-workers.ts';
import { createWorkerTools } from '../tools/workers.ts';
import { Git } from '../workers/git.ts';
import { WorkerManager } from '../workers/manager.ts';
import { ClaudeWorkerRunner, type WorkerRunner } from '../workers/runner.ts';
import { TaskStore } from '../workers/store.ts';

export interface BrainContext {
  gate: Gate;
  killswitch: KillSwitch;
  audit: AuditLog;
  policy: Policy;
  memory: Memory;
}

export interface RuntimeOptions {
  paths: AppPaths;
  home: string;
  policyPath: string;
  secrets: SecretStore;
  /** Unsealed policy allowed; N3 refused outright. For demos and tests only. */
  devMode: boolean;
  /** Root ownership check. Defaults to !devMode; only tests override it (the hash is still checked). */
  requireSealed?: boolean;
  /** Tests inject a scripted brain; production builds ClaudeBrain. */
  brainFactory?: (ctx: BrainContext) => Brain;
  /** Tests inject fake macOS side effects; production uses open/osascript/shortcuts. */
  mac?: MacOps;
  /** Tests inject fake mailboxes / calendar / summarizer; production builds them from policy + Keychain. */
  connectors?: {
    providers: Map<string, MailProvider>;
    calendar: CalendarProvider | null;
    summarizer?: Summarizer;
  };
  /** Tests inject a fake research agent and YouTube access. */
  research?: { researcher: Researcher | null; youtube: YouTube | null };
  /** Tests inject a fake Jarvis.app; production waits for the real one on the socket. */
  actuator?: Actuator;
  /** Tests inject a scripted coding worker; production runs Claude Code through the SDK. */
  workerRunner?: WorkerRunner;
  /** Tests inject fake forges; production builds them from the Keychain tokens. */
  forges?: { forges: Map<ForgeId, ForgeClient>; trello: TrelloClient | null };
}

export type Activity =
  | { kind: 'turn_start'; trigger: string; preview: string }
  | { kind: 'tool'; name: string }
  | { kind: 'turn_end'; ok: boolean; model?: string; costUsd?: number; ttftMs?: number }
  | { kind: 'quota'; window: string; utilization: number | null; status: string }
  | { kind: 'stop'; reason: string }
  | { kind: 'actuator'; connected: boolean }
  | {
      kind: 'worker';
      id: string;
      status: string;
      step: string;
      title: string;
      repo: string;
      prUrl?: string | null;
      error?: string | null;
    }
  | { kind: 'resume' };

export interface AccountStatus {
  id: string;
  type: 'gmail' | 'imap';
  email: string;
  connected: boolean;
  /** What is missing when not connected. */
  missing?: string;
}

/** Mail + calendar providers from the sealed account list and the Keychain. */
function buildConnectors(policy: Policy, secrets: SecretStore, redactor: Redactor) {
  const providers = new Map<string, MailProvider>();
  const auths = new Map<string, GoogleAuth>();
  const status: AccountStatus[] = [];
  const clientJson = secrets.get(SecretName.googleClient);
  const client = clientJson ? (JSON.parse(clientJson) as GoogleClient) : null;
  redactor.register('google_client_secret', client?.client_secret);

  for (const acc of policy.mail.accounts) {
    if (acc.type === 'gmail') {
      const refresh = secrets.get(SecretName.googleRefreshToken(acc.id));
      redactor.register('google_refresh_token', refresh);
      if (client && refresh) {
        const auth = new GoogleAuth({ client, refreshToken: refresh });
        auths.set(acc.id, auth);
        providers.set(acc.id, new GmailProvider(acc.id, acc.email, auth));
        status.push({ id: acc.id, type: 'gmail', email: acc.email, connected: true });
      } else {
        status.push({
          id: acc.id,
          type: 'gmail',
          email: acc.email,
          connected: false,
          missing: `jarvis google connect <client.json> ${acc.id}`,
        });
      }
    } else {
      const password = secrets.get(SecretName.mailPassword(acc.id));
      redactor.register('mail_password', password);
      if (password) {
        providers.set(
          acc.id,
          new ImapProvider(
            {
              account: acc.id,
              email: acc.email,
              imap: acc.imap,
              smtp: acc.smtp,
              ...(acc.user ? { user: acc.user } : {}),
              ...(acc.ca_pem ? { caPem: acc.ca_pem } : {}),
            },
            password,
          ),
        );
        status.push({ id: acc.id, type: 'imap', email: acc.email, connected: true });
      } else {
        status.push({
          id: acc.id,
          type: 'imap',
          email: acc.email,
          connected: false,
          missing: `jarvis mail add ${acc.id}`,
        });
      }
    }
  }
  const calId =
    policy.calendar.google_account ?? policy.mail.accounts.find((a) => a.type === 'gmail')?.id;
  const calAuth = calId ? auths.get(calId) : undefined;
  return { providers, calendar: calAuth ? new GoogleCalendar(calAuth) : null, status };
}

/** GitHub / GitLab / Trello clients for the tokens present in the Keychain. */
function buildForges(policy: Policy, secrets: SecretStore, redactor: Redactor) {
  const forges = new Map<ForgeId, ForgeClient>();
  const secret = (name: string) => {
    const v = secrets.get(name);
    if (v) redactor.register(name, v);
    return v;
  };
  // Re-read at each call: `jarvis github connect` takes effect without restarting the daemon.
  const live = (name: string) => () => secrets.get(name) ?? '';
  const githubOwners = (): string[] => {
    try {
      return JSON.parse(secrets.get(SecretName.githubOwners) ?? '[]') as string[];
    } catch {
      return [];
    }
  };
  for (const o of githubOwners()) secret(SecretName.githubOwnerToken(o));
  if (secret(SecretName.githubToken)) {
    forges.set(
      'github',
      new GitHubClient({
        token: (owner) =>
          secrets.get(owner ? SecretName.githubOwnerToken(owner) : SecretName.githubToken) ?? '',
        owners: githubOwners,
      }),
    );
  }
  if (secret(SecretName.gitlabToken)) {
    forges.set(
      'gitlab',
      new GitLabClient({ token: live(SecretName.gitlabToken), base: policy.forges.gitlab_url }),
    );
  }
  const trello =
    secret(SecretName.trelloKey) && secret(SecretName.trelloToken)
      ? new TrelloClient({ key: live(SecretName.trelloKey), token: live(SecretName.trelloToken) })
      : null;
  return { forges, trello };
}

export interface Runtime {
  policy: Policy;
  audit: AuditLog;
  killswitch: KillSwitch;
  approvals: ApprovalBroker;
  pin: PinGuard;
  gate: Gate;
  memory: Memory;
  mail: {
    providers: Map<string, MailProvider>;
    status: AccountStatus[];
    calendar: CalendarProvider | null;
  };
  /** Live activity for the dashboard: turns, tools, quota. */
  events: EventEmitter<{ activity: [Activity] }>;
  startedAt: number;
  /** Latest subscription window states (five_hour, seven_day, seven_day_opus…). */
  quota: Map<string, RateLimitInfo>;
  /** Null when no subscription token is stored yet (`jarvis auth set-token`). */
  brain: Brain | null;
  /** Where Jarvis.app registers as the actuator (browser, apps, screen). */
  bridge: ActuatorBridge;
  actuatorInfo(): { connected: boolean; version?: string; capabilities?: string[] };
  forgeStatus(): { id: string; connected: boolean; connect: string }[];
  workers: { manager: WorkerManager; store: TaskStore };
  devMode: boolean;
  /** Last quota warning, shown by `jarvis status`. */
  quotaWarning: string | null;
  stop(reason: string): void;
  close(): Promise<void>;
}

export function createRuntime(o: RuntimeOptions): Runtime {
  const { paths, secrets } = o;
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });

  const policy = loadPolicy({
    path: o.policyPath,
    expectedSha256: o.devMode ? null : secrets.get(SecretName.policySha256),
    requireSealed: o.requireSealed ?? !o.devMode,
    home: o.home,
  });

  const audit = new AuditLog({ dbPath: paths.auditDb, jsonlPath: paths.auditJsonl });
  const oauthToken = secrets.get(SecretName.claudeOauthToken);
  const redactor = new Redactor();
  redactor.register('claude_oauth_token', oauthToken);

  const killswitch = new KillSwitch(paths.stopFlag);
  const pin = new PinGuard({
    store: secrets,
    secretName: SecretName.pinHash,
    statePath: paths.pinState,
    maxAttempts: policy.pin.max_attempts,
    lockoutMin: policy.pin.lockout_min,
  });
  const approvals = new ApprovalBroker({
    timeoutMs: policy.approvals.timeout_sec * 1000,
    verifyPin: (p) => pin.verify(p),
  });

  const memory = new Memory({ dbPath: paths.memoryDb, notesDir: policy.memory.notes_dir });
  const fs = new FsPolicy({
    home: o.home,
    readRoots: policy.filesystem.read_roots,
    writeRoots: policy.filesystem.write_roots,
    // Memory changes only through the memory tools, so its provenance stays recorded.
    extraDeny: [...policy.filesystem.deny, policy.memory.notes_dir],
  });
  const cwd = policy.filesystem.write_roots[0] ?? o.home;
  mkdirSync(cwd, { recursive: true });

  const gate = new Gate({
    engine: new PolicyEngine(policy.auto_approve),
    approvals,
    killswitch,
    audit,
    redact: (s) => redactor.redact(s),
    cwd,
    toolTimeoutMs: policy.shell.timeout_sec * 1000,
    devMode: o.devMode,
  });
  for (const t of createTools({
    fs,
    shell: new ShellClassifier(policy.shell, fs),
    policy,
    home: o.home,
    outboxDir: paths.outbox,
  })) {
    gate.register(t);
  }
  for (const t of createMacTools({
    fs,
    policy,
    mac: o.mac ?? realMacOps,
    scratchDir: paths.scratch,
  }))
    gate.register(t);
  for (const t of createMemoryTools(memory)) gate.register(t);

  const forges = o.forges ?? buildForges(policy, secrets, redactor);
  const built = o.connectors
    ? {
        providers: o.connectors.providers,
        calendar: o.connectors.calendar,
        status: [...o.connectors.providers.values()].map((p) => ({
          id: p.account,
          type: 'imap' as const,
          email: p.email,
          connected: true,
        })),
      }
    : buildConnectors(policy, secrets, redactor);
  const summarizer: Summarizer =
    o.connectors?.summarizer ??
    (oauthToken
      ? new QuarantineSummarizer({
          policy,
          paths,
          home: o.home,
          oauthToken,
          onViolation: (problem) => killswitch.engage(`quarantine violation: ${problem}`),
        })
      : new MetadataSummarizer());
  for (const t of createMailTools({
    providers: built.providers,
    declared: o.connectors ? [...built.providers.keys()] : policy.mail.accounts.map((a) => a.id),
    calendar: built.calendar,
    summarizer,
    triageMax: policy.mail.triage_max,
    status: (signal) => (o.mac ?? realMacOps).status(signal),
    work: () => workBriefing(forges),
  })) {
    gate.register(t);
  }

  const ytdlp = YtDlp.locate();
  const research = o.research ?? {
    researcher: oauthToken
      ? new ClaudeResearcher({
          policy,
          paths,
          home: o.home,
          oauthToken,
          onViolation: (problem) => killswitch.engage(`research agent violation: ${problem}`),
        })
      : null,
    youtube: ytdlp ? new YtDlp({ binary: ytdlp, scratch: paths.scratch }) : null,
  };
  for (const t of createResearchTools(research)) gate.register(t);

  const bridge = new ActuatorBridge();
  const actuator = o.actuator ?? bridge;
  for (const t of createComputerTools({ policy, actuator })) gate.register(t);

  for (const t of createForgeTools({ ...forges, maxDiffChars: policy.forges.max_diff_chars }))
    gate.register(t);
  const quota = new Map<string, RateLimitInfo>();

  // Coding workers (S6): Claude Code on the subscription, sandboxed, one worktree per task.
  const events = new EventEmitter<{ activity: [Activity] }>();
  const taskStore = new TaskStore(paths.workersDb);
  const workerRunner =
    o.workerRunner ??
    (oauthToken
      ? new ClaudeWorkerRunner({
          home: o.home,
          oauthToken,
          configDir: paths.workerConfig,
          tmpDir: join(policy.workers.dir, 'tmp'),
          cacheDir: join(policy.workers.dir, 'cache'),
          maxTurns: policy.workers.max_turns,
          maxBudgetUsd: policy.workers.max_budget_usd,
          network: policy.workers.network,
          denyRead: [
            ...[
              '.ssh',
              '.aws',
              '.gnupg',
              '.config/gh',
              '.netrc',
              '.npmrc',
              '.docker',
              '.kube',
              'Library/Keychains',
              'Library/Cookies',
            ].map((p) => join(o.home, p)),
            paths.root,
            ...policy.filesystem.deny,
          ],
        })
      : null);
  const reserve = policy.quota.reserve_interactive_pct / 100;
  const workerManager = new WorkerManager({
    store: taskStore,
    git: new Git({ env: { HOME: o.home } }),
    runner: workerRunner,
    forges: forges.forges,
    audit,
    killswitch,
    containsSecret: (text) => redactor.redact(text) !== text,
    emit: (e) => events.emit('activity', { kind: 'worker', ...e }),
    home: o.home,
    dir: policy.workers.dir,
    logsDir: paths.workerLogs,
    extraDeny: policy.filesystem.deny,
    maxParallel: policy.workers.max_parallel,
    draftPr: policy.workers.draft_pr,
    // Background work stops before eating the share kept for Brightky's own requests.
    quotaOk: () => (quota.get('five_hour')?.utilization ?? 0) < 1 - reserve,
    onFinished: async (t) => {
      const column = await trelloFollowUp({ trello: forges.trello, policy }, t).catch(
        (e: Error) => {
          audit.append({
            event: 'result',
            tool: 'trello_followup',
            rule: 'trello.followup',
            outcome: 'error',
            data: { id: t.id, error: e.message },
          });
          return null;
        },
      );
      if (column !== null) {
        audit.append({
          event: 'result',
          tool: 'trello_followup',
          level: 2,
          rule: 'trello.followup',
          outcome: 'ok',
          data: { id: t.id, card: t.source, column, pr: t.prUrl },
        });
      }
    },
  });
  for (const t of createWorkerTools({
    manager: workerManager,
    store: taskStore,
    policy,
    forges: () => [...forges.forges.keys()],
  }))
    gate.register(t);
  for (const t of createTrelloWorkerTools({
    trello: forges.trello,
    manager: workerManager,
    store: taskStore,
    policy,
  }))
    gate.register(t);
  workerManager.pump();

  const rt: Runtime = {
    policy,
    audit,
    killswitch,
    approvals,
    pin,
    gate,
    memory,
    mail: { providers: built.providers, status: built.status, calendar: built.calendar },
    events,
    startedAt: Date.now(),
    quota,
    brain: null,
    bridge,
    workers: { manager: workerManager, store: taskStore },
    forgeStatus: () =>
      (['github', 'gitlab', 'trello'] as const).map((id) => ({
        id,
        connected: id === 'trello' ? forges.trello !== null : forges.forges.has(id),
        connect: `jarvis ${id} connect`,
      })),
    actuatorInfo: () =>
      actuator.info
        ? { connected: actuator.connected, ...actuator.info }
        : { connected: actuator.connected },
    devMode: o.devMode,
    quotaWarning: null,
    stop: (reason) => killswitch.engage(reason),
    close: async () => {
      await rt.brain?.close();
      audit.append({ event: 'system', outcome: 'shutdown' });
      await workerManager.shutdown();
      audit.close();
      taskStore.close();
      memory.close();
    },
  };

  const ctx: BrainContext = { gate, killswitch, audit, policy, memory };
  if (o.brainFactory) {
    rt.brain = o.brainFactory(ctx);
  } else if (oauthToken) {
    rt.brain = new ClaudeBrain({
      ...ctx,
      paths,
      home: o.home,
      cwd,
      oauthToken,
      memorySnapshot: () => memory.promptSnapshot(policy.memory.prompt_max_chars),
      quota: () => quota,
      onTurn: (t) =>
        memory.recordUsage({
          model: t.model,
          trigger: t.trigger,
          route: t.route.tier,
          inputTokens: t.usage.inputTokens,
          outputTokens: t.usage.outputTokens,
          cacheReadTokens: t.usage.cacheReadTokens,
          cacheWriteTokens: t.usage.cacheWriteTokens,
          costUsd: t.usage.costUsd,
          ttftMs: t.ttftMs,
          durationMs: t.durationMs,
        }),
      onRateLimit: (info) => {
        if (info.rateLimitType) {
          quota.set(info.rateLimitType, info);
          memory.recordQuota(
            info.rateLimitType,
            info.utilization ?? null,
            info.status,
            info.resetsAt ? new Date(info.resetsAt * 1000) : null,
          );
          rt.events.emit('activity', {
            kind: 'quota',
            window: info.rateLimitType,
            utilization: info.utilization ?? null,
            status: info.status,
          });
        }
        const a = quotaAction(info);
        if (a.warn) rt.quotaWarning = a.warn;
        audit.append({
          event: 'system',
          outcome: 'rate_limit',
          data: {
            status: info.status,
            type: info.rateLimitType,
            utilization: info.utilization,
            overage: info.isUsingOverage ?? false,
          },
        });
        if (a.stop) killswitch.engage(a.stop);
      },
    });
  }

  killswitch.onEngage((reason) => {
    audit.append({ event: 'system', outcome: 'stop', data: { reason } });
    rt.events.emit('activity', { kind: 'stop', reason });
    void rt.brain?.stop(reason);
  });
  killswitch.onRelease(() => rt.events.emit('activity', { kind: 'resume' }));

  audit.append({
    event: 'system',
    outcome: 'boot',
    data: {
      policySha256: policy.sha256,
      sealed: policy.sealed,
      devMode: o.devMode,
      stopEngaged: killswitch.engaged,
      brain: rt.brain ? 'ready' : 'no_token',
    },
  });
  return rt;
}
