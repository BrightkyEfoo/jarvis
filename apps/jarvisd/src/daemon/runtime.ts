import { mkdirSync } from 'node:fs';
import { AuditLog } from '@jarvis/audit';
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
import type { Brain } from '../orchestrator/brain.ts';
import { ClaudeBrain } from '../orchestrator/claude.ts';
import { quotaAction } from '../orchestrator/quota.ts';
import type { AppPaths } from '../paths.ts';
import { createTools } from '../tools/index.ts';

export interface BrainContext {
  gate: Gate;
  killswitch: KillSwitch;
  audit: AuditLog;
  policy: Policy;
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
}

export interface Runtime {
  policy: Policy;
  audit: AuditLog;
  killswitch: KillSwitch;
  approvals: ApprovalBroker;
  pin: PinGuard;
  gate: Gate;
  /** Null when no subscription token is stored yet (`jarvis auth set-token`). */
  brain: Brain | null;
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

  const fs = new FsPolicy({
    home: o.home,
    readRoots: policy.filesystem.read_roots,
    writeRoots: policy.filesystem.write_roots,
    extraDeny: policy.filesystem.deny,
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

  const rt: Runtime = {
    policy,
    audit,
    killswitch,
    approvals,
    pin,
    gate,
    brain: null,
    devMode: o.devMode,
    quotaWarning: null,
    stop: (reason) => killswitch.engage(reason),
    close: async () => {
      await rt.brain?.close();
      audit.append({ event: 'system', outcome: 'shutdown' });
      audit.close();
    },
  };

  const ctx: BrainContext = { gate, killswitch, audit, policy };
  if (o.brainFactory) {
    rt.brain = o.brainFactory(ctx);
  } else if (oauthToken) {
    rt.brain = new ClaudeBrain({
      ...ctx,
      paths,
      home: o.home,
      cwd,
      oauthToken,
      onRateLimit: (info) => {
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
    void rt.brain?.stop(reason);
  });

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
