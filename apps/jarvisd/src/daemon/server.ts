import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import type { ApprovalOutcome, ApprovalRequest } from '@jarvis/policy';
import {
  type ApprovalView,
  MAX_ACTUATOR_LINE,
  MAX_LINE,
  onLines,
  type Reply,
  writeLine,
} from '../ipc.ts';
import { type Request, RequestSchema } from '../ipc-schema.ts';
import type { Activity, Runtime } from './runtime.ts';

const view = (r: ApprovalRequest): ApprovalView => ({
  id: r.id,
  tool: r.tool,
  level: r.level,
  rule: r.rule,
  summary: r.summary,
  reason: r.reason,
  needsPin: r.needsPin,
  tainted: r.tainted,
  externalDestinations: r.externalDestinations,
  expiresAt: r.expiresAt,
});

function alive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(path);
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });
}

/** Unix socket in a 0700 directory, itself 0600: only Brightky's user can connect. */
export async function startServer(rt: Runtime, socketPath: string): Promise<Server> {
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(socketPath), 0o700);
  if (existsSync(socketPath)) {
    if (await alive(socketPath)) throw new Error('jarvisd is already running');
    rmSync(socketPath);
  }

  const server = createServer((socket) => serve(rt, socket));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  chmodSync(socketPath, 0o600);
  return server;
}

function serve(rt: Runtime, socket: Socket): void {
  const send = (r: Reply) => writeLine(socket, r);
  const cleanups: (() => void)[] = [];
  socket.on('close', () => {
    for (const c of cleanups) c();
  });
  socket.on('error', () => undefined);

  /** Streams approval requests to this client while `reqId` is active. */
  const forwardApprovals = (reqId: string): (() => void) => {
    const onRequest = (r: ApprovalRequest) =>
      send({ id: reqId, type: 'approval', request: view(r) });
    const onResolved = (r: ApprovalRequest, o: ApprovalOutcome) =>
      send({
        id: reqId,
        type: 'approval_resolved',
        approvalId: r.id,
        approved: o.approved,
        channel: o.channel,
      });
    rt.approvals.on('request', onRequest);
    rt.approvals.on('resolved', onResolved);
    const off = () => {
      rt.approvals.off('request', onRequest);
      rt.approvals.off('resolved', onResolved);
    };
    cleanups.push(off);
    return off;
  };

  /** Set once this connection is Jarvis.app's actuator: only it may answer actions. */
  let actuator = false;
  const actuatorCmd = (req: Request & { cmd: 'actuator_register' | 'actuator_result' }) => {
    if (req.cmd === 'actuator_result') {
      if (actuator) rt.bridge.settle(req.reqId, req.ok, req.result, req.error);
      return;
    }
    if (actuator) return send({ id: req.id, type: 'error', error: 'already registered' });
    actuator = true;
    const detach = rt.bridge.attach({
      version: req.version,
      capabilities: req.capabilities,
      send: (m) =>
        'cancel' in m
          ? send({ id: req.id, type: 'actuate_cancel', reqId: m.reqId })
          : send({ id: req.id, type: 'actuate', reqId: m.reqId, action: m.action }),
    });
    rt.audit.append({
      event: 'system',
      outcome: 'actuator_connected',
      data: { version: req.version, capabilities: req.capabilities },
    });
    rt.events.emit('activity', { kind: 'actuator', connected: true });
    cleanups.push(() => {
      detach();
      rt.events.emit('activity', { kind: 'actuator', connected: false });
      try {
        rt.audit.append({ event: 'system', outcome: 'actuator_disconnected' });
      } catch {
        // daemon shutting down: the audit log is already closed
      }
    });
    send({ id: req.id, type: 'event', event: { kind: 'registered' } });
  };

  onLines(
    socket,
    (line) => {
      let req: Request;
      try {
        req = RequestSchema.parse(JSON.parse(line));
      } catch {
        send({ id: 'unknown', type: 'error', error: 'invalid request' });
        return;
      }
      if (req.cmd === 'actuator_register' || req.cmd === 'actuator_result') return actuatorCmd(req);
      handle(rt, req, send, forwardApprovals, (fn) => cleanups.push(fn)).catch((e: Error) =>
        send({ id: req.id, type: 'error', error: e.message }),
      );
    },
    () => (actuator ? MAX_ACTUATOR_LINE : MAX_LINE),
  );
}

async function handle(
  rt: Runtime,
  req: Request,
  send: (r: Reply) => void,
  forwardApprovals: (id: string) => () => void,
  onClose: (fn: () => void) => void,
): Promise<void> {
  const done = (data?: unknown) =>
    send(data === undefined ? { id: req.id, type: 'done' } : { id: req.id, type: 'done', data });
  const fail = (error: string) => send({ id: req.id, type: 'error', error });

  switch (req.cmd) {
    case 'ping':
      return done({ pong: true });

    case 'status': {
      const s = rt.brain?.session;
      return done({
        stop: rt.killswitch.engaged ? rt.killswitch.reason : null,
        devMode: rt.devMode,
        policy: { sha256: rt.policy.sha256.slice(0, 12), sealed: rt.policy.sealed },
        brain: rt.brain ? 'ready' : 'no subscription token (jarvis auth set-token)',
        session: s ? { id: s.id.slice(0, 8), tainted: s.tainted } : null,
        pendingApprovals: rt.approvals.pending().length,
        quotaWarning: rt.quotaWarning,
        quota: quotaView(rt),
        memoryNotes: rt.memory.notesDir,
        actuator: rt.actuatorInfo(),
        tools: rt.gate.tools.map((t) => t.name),
      });
    }

    case 'ask': {
      if (!rt.brain)
        return fail('no Claude subscription token stored: run `jarvis auth set-token`');
      const off = forwardApprovals(req.id);
      const trigger = req.trigger ?? 'cli';
      rt.events.emit('activity', { kind: 'turn_start', trigger, preview: req.text.slice(0, 120) });
      let r: Awaited<ReturnType<NonNullable<Runtime['brain']>['ask']>> | undefined;
      try {
        r = await rt.brain.ask(
          req.text,
          {
            onText: (text) => send({ id: req.id, type: 'text', text }),
            onTool: (name) => {
              send({ id: req.id, type: 'tool', name });
              rt.events.emit('activity', { kind: 'tool', name: name.replace('mcp__jarvis__', '') });
            },
          },
          trigger,
        );
        return done({ ...r, quota: quotaView(rt) });
      } finally {
        off();
        rt.events.emit('activity', {
          kind: 'turn_end',
          ok: r?.ok ?? false,
          ...(r?.model ? { model: r.model } : {}),
          ...(r?.costUsd !== undefined ? { costUsd: r.costUsd } : {}),
          ...(r?.ttftMs !== undefined ? { ttftMs: r.ttftMs } : {}),
        });
      }
    }

    case 'dashboard':
      return done(dashboardSnapshot(rt));

    case 'watch': {
      // Live feed until the client disconnects: audit rows, approvals, STOP, activity.
      const offAudit = rt.audit.onAppend((record) =>
        send({ id: req.id, type: 'event', event: { kind: 'audit', record } }),
      );
      const onActivity = (a: Activity) =>
        send({ id: req.id, type: 'event', event: { kind: 'activity', activity: a } });
      rt.events.on('activity', onActivity);
      const offApprovals = forwardApprovals(req.id);
      onClose(() => {
        offAudit();
        rt.events.off('activity', onActivity);
        offApprovals();
      });
      send({ id: req.id, type: 'event', event: { kind: 'hello', at: new Date().toISOString() } });
      return;
    }

    case 'workers':
      return done({
        tasks: rt.workers.store.list(req.limit ?? 20),
        active: rt.workers.manager.active,
      });

    case 'upcoming': {
      const cal = rt.mail.calendar;
      if (!cal) return done({ events: [], note: 'agenda non connecté' });
      const from = new Date();
      const to = new Date(from);
      to.setDate(to.getDate() + 2);
      to.setHours(0, 0, 0, 0);
      try {
        return done({ events: await cal.events(from, to, 20) });
      } catch (e) {
        return done({ events: [], note: (e as Error).message });
      }
    }

    case 'audit_query':
      return done(
        rt.audit.query({
          limit: req.limit ?? 100,
          ...(req.beforeSeq ? { beforeSeq: req.beforeSeq } : {}),
          ...(req.tool ? { tool: req.tool } : {}),
          ...(req.event ? { event: req.event } : {}),
          ...(req.verdict ? { verdict: req.verdict } : {}),
        }),
      );

    case 'interrupt':
      await rt.brain?.interrupt();
      return done({ interrupted: true });

    case 'stop':
      rt.stop(req.reason ?? 'STOP requested from the CLI');
      return done({ stopped: true });

    case 'resume': {
      if (!rt.killswitch.engaged) return done({ resumed: false, reason: 'not stopped' });
      const r = rt.pin.verify(req.pin);
      if (!r.ok) {
        rt.audit.append({ event: 'system', outcome: 'resume_refused', data: { reason: r.reason } });
        return fail(
          r.reason === 'locked'
            ? 'PIN locked'
            : r.reason === 'not_set'
              ? 'no PIN configured (jarvis pin set)'
              : 'wrong PIN',
        );
      }
      rt.killswitch.release();
      rt.audit.append({ event: 'system', outcome: 'resumed' });
      return done({ resumed: true });
    }

    case 'new_session':
      await rt.brain?.newSession();
      return done({ newSession: true });

    case 'approvals':
      if (req.watch) forwardApprovals(req.id);
      for (const r of rt.approvals.pending())
        send({ id: req.id, type: 'approval', request: view(r) });
      if (!req.watch) return done({ pending: rt.approvals.pending().length });
      return;

    case 'approve': {
      const channel = req.channel ?? 'cli';
      // A spoken "yes" can be overheard or replayed: N3 is never approved by voice.
      const pending = rt.approvals.pending().find((p) => p.id === req.approvalId);
      if (channel === 'voice' && pending?.needsPin)
        return fail('N3 actions need the PIN in the terminal, never by voice');
      const r = rt.approvals.resolve(req.approvalId, {
        approve: true,
        channel,
        ...(req.pin && channel !== 'voice' ? { pin: req.pin } : {}),
      });
      return r.ok ? done() : fail(r.error);
    }

    case 'deny': {
      const r = rt.approvals.resolve(req.approvalId, {
        approve: false,
        channel: req.channel ?? 'cli',
      });
      return r.ok ? done() : fail(r.error);
    }

    case 'mail_status': {
      const accounts = rt.mail.status.map((s) => ({ ...s, test: undefined as string | undefined }));
      if (req.test) {
        await Promise.all(
          accounts.map(async (a) => {
            const p = rt.mail.providers.get(a.id);
            if (!p) return;
            const t0 = performance.now();
            try {
              await Promise.race([
                p.list({ unreadOnly: false, sinceHours: 24, max: 1 }),
                new Promise((_, reject) =>
                  setTimeout(() => reject(new Error('timeout after 20 s')), 20_000),
                ),
              ]);
              a.test = `ok (${Math.round(performance.now() - t0)} ms)`;
            } catch (e) {
              a.test = `error: ${(e as Error).message}`;
            }
          }),
        );
      }
      return done(accounts);
    }

    case 'audit_tail':
      return done(rt.audit.tail(req.limit ?? 20));

    case 'audit_verify':
      return done(rt.audit.verify());

    case 'costs': {
      const since = new Date();
      since.setHours(0, 0, 0, 0);
      if (req.period === 'week') since.setDate(since.getDate() - 6);
      if (req.period === 'month') since.setDate(1);
      return done({ ...rt.memory.usageSummary(since), quota: quotaView(rt) });
    }

    case 'memory_list':
      return done(rt.memory.list(req.limit ?? 50));

    case 'memory_search':
      return done(rt.memory.search(req.query, 20));

    case 'memory_forget':
      return rt.memory.forget(req.factId) ? done() : fail(`no active memory #${req.factId}`);
  }
}

/** Utilisation per subscription window, in percent, for the CLI footer and `jarvis costs`. */
function quotaView(rt: Runtime): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const [window, info] of rt.quota) {
    out[window] = info.utilization !== undefined ? Math.round(info.utilization * 100) : info.status;
  }
  return out;
}

/** Everything the dashboard needs to render at once; live updates then come from `watch`. */
function dashboardSnapshot(rt: Runtime) {
  const now = new Date();
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const week = new Date(day);
  week.setDate(week.getDate() - 6);
  const month = new Date(day);
  month.setDate(1);
  const monthSoFar = rt.memory.usageSummary(month);
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const session = rt.brain?.session;
  return {
    status: {
      stop: rt.killswitch.engaged ? rt.killswitch.reason : null,
      devMode: rt.devMode,
      policy: { sha256: rt.policy.sha256.slice(0, 12), sealed: rt.policy.sealed },
      brain: rt.brain ? 'ready' : 'no_token',
      session: session ? { id: session.id.slice(0, 8), tainted: session.tainted } : null,
      startedAt: new Date(rt.startedAt).toISOString(),
      quotaWarning: rt.quotaWarning,
      actuator: rt.actuatorInfo(),
    },
    pendingApprovals: rt.approvals.pending().map(view),
    audit: rt.audit.query({ limit: 150 }),
    costs: {
      today: rt.memory.usageSummary(day),
      week: rt.memory.usageSummary(week),
      month: monthSoFar,
    },
    daily: rt.memory.usageDaily(30, now),
    quota: [...rt.quota.entries()].map(([window, info]) => ({
      window,
      utilization: info.utilization ?? null,
      status: info.status,
      resetsAt: info.resetsAt ? new Date(info.resetsAt * 1000).toISOString() : null,
      forecast: rt.memory.quotaForecast(window, now),
    })),
    forecast: {
      monthCostUsd: (monthSoFar.costUsd / now.getDate()) * daysInMonth,
      turnsPerDay: monthSoFar.turns / now.getDate(),
    },
    mail: rt.mail.status,
    forges: rt.forgeStatus(),
    workers: rt.workers.store.list(8).map((t) => ({
      id: t.id,
      repo: t.repo,
      title: t.title,
      status: t.status,
      step: t.step,
      prUrl: t.prUrl,
      error: t.error,
      createdAt: t.createdAt,
    })),
    memory: { facts: rt.memory.list(100), notesDir: rt.memory.notesDir },
    tools: rt.gate.tools.map((t) => ({ name: t.name, description: t.description })),
    signature: "fait avec ❤️ par Brightky Efo'o — https://brightkyefoo.cm",
  };
}
