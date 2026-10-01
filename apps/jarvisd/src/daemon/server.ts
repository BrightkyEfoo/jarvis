import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import type { ApprovalOutcome, ApprovalRequest } from '@jarvis/policy';
import { type ApprovalView, onLines, type Reply, writeLine } from '../ipc.ts';
import { type Request, RequestSchema } from '../ipc-schema.ts';
import type { Runtime } from './runtime.ts';

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

  onLines(socket, (line) => {
    let req: Request;
    try {
      req = RequestSchema.parse(JSON.parse(line));
    } catch {
      send({ id: 'unknown', type: 'error', error: 'invalid request' });
      return;
    }
    handle(rt, req, send, forwardApprovals).catch((e: Error) =>
      send({ id: req.id, type: 'error', error: e.message }),
    );
  });
}

async function handle(
  rt: Runtime,
  req: Request,
  send: (r: Reply) => void,
  forwardApprovals: (id: string) => () => void,
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
        tools: rt.gate.tools.map((t) => t.name),
      });
    }

    case 'ask': {
      if (!rt.brain)
        return fail('no Claude subscription token stored: run `jarvis auth set-token`');
      const off = forwardApprovals(req.id);
      try {
        const r = await rt.brain.ask(
          req.text,
          {
            onText: (text) => send({ id: req.id, type: 'text', text }),
            onTool: (name) => send({ id: req.id, type: 'tool', name }),
          },
          req.trigger ?? 'cli',
        );
        return done({ ...r, quota: quotaView(rt) });
      } finally {
        off();
      }
    }

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
        ...(req.pin && channel === 'cli' ? { pin: req.pin } : {}),
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
