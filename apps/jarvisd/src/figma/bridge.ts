import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, mkdirSync, openSync, rmSync, writeSync } from 'node:fs';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  CATALOGUE_VERSION,
  type FigmaOp,
  OP_ARGS,
  type OpKind,
  PLUGIN_ERRORS,
} from './catalogue.ts';

/**
 * Where the Figma plugin meets jarvisd (ADR-034). The plugin's UI iframe long-polls this loopback
 * HTTP server: Node 24 has no WebSocket server and adding a package is not an option.
 *
 * A request is admitted only from a loopback address, with Host 127.0.0.1:<port> or
 * localhost:<port> (DNS rebinding), with no Origin or the plugin iframe's opaque `null` (a web page
 * in the browser is refused before anything else), and with the per-launch bearer token. The
 * bridge only carries operations of the fixed catalogue; the tools decide their level.
 */

export const ROUTES = ['/hello', '/poll', '/result'] as const;

/** The plugin iframe has an opaque origin; figma.com is tolerated in case the app serves it. */
const ALLOWED_ORIGINS = new Set(['null', 'https://www.figma.com', 'https://figma.com']);
const LOOPBACK = new Set(['127.0.0.1', '::ffff:127.0.0.1', '::1']);

export interface Incoming {
  method?: string | undefined;
  url?: string | undefined;
  remoteAddress?: string | undefined;
  headers: IncomingHttpHeaders;
}

export type Admission =
  | { ok: true; preflight: boolean; cors: boolean }
  | { ok: false; status: number; reason: string; cors: boolean };

const digest = (s: string) => createHash('sha256').update(s).digest();

/** Pure admission check, in this order: address, Host, Origin, preflight, method, token, type. */
export function admit(r: Incoming, port: number, token: string): Admission {
  if (!r.remoteAddress || !LOOPBACK.has(r.remoteAddress))
    return { ok: false, status: 403, reason: 'not_loopback', cors: false };
  const host = (r.headers.host ?? '').toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)
    return { ok: false, status: 403, reason: 'bad_host', cors: false };
  const origin = r.headers.origin;
  if (origin !== undefined && !ALLOWED_ORIGINS.has(origin))
    return { ok: false, status: 403, reason: 'bad_origin', cors: false };
  // From here the caller is the plugin or a local tool: errors are readable (CORS) by the plugin.
  if (r.method === 'OPTIONS') return { ok: true, preflight: true, cors: true };
  if (r.method !== 'POST') return { ok: false, status: 405, reason: 'bad_method', cors: true };
  const auth = r.headers.authorization ?? '';
  const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!given || !timingSafeEqual(digest(given), digest(token)))
    return { ok: false, status: 401, reason: 'bad_token', cors: true };
  if (!(r.headers['content-type'] ?? '').toLowerCase().startsWith('application/json'))
    return { ok: false, status: 415, reason: 'bad_content_type', cors: true };
  const path = (r.url ?? '').split('?')[0] ?? '';
  if (!(ROUTES as readonly string[]).includes(path))
    return { ok: false, status: 404, reason: 'bad_path', cors: true };
  return { ok: true, preflight: false, cors: true };
}

export class FigmaError extends Error {
  readonly code: string;
  /** Reported by the plugin (its text may quote the file) rather than by the bridge itself. */
  readonly fromPlugin: boolean;
  constructor(code: string, message: string, fromPlugin = false) {
    super(message);
    this.code = code;
    this.fromPlugin = fromPlugin;
  }
}

const SESSION = z.string().regex(/^[A-Za-z0-9-]{8,64}$/);
const Hello = z.object({
  session: SESSION,
  catalogue: z.number().int(),
  plugin: z.string().max(40).optional(),
});
const Poll = z.object({ session: SESSION });
const Result = z.object({
  session: SESSION,
  id: z.uuid(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  code: z.string().max(40).optional(),
  error: z.string().max(2000).optional(),
});

const SMALL_BODY = 16 * 1024;
/** A PNG export (≤ 3.5 MB raw) in base64 plus JSON. */
const RESULT_BODY = 6 * 1024 * 1024;
const QUEUE_MAX = 8;

interface Pending {
  op: FigmaOp;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  /** Session it was handed to; null while queued. */
  session: string | null;
  cleanup: () => void;
}

interface Waiting {
  session: string;
  res: ServerResponse;
  timer: NodeJS.Timeout;
}

export interface FigmaBridgeOptions {
  /** Audit hook: connections and (throttled) rejected requests. */
  audit?: (outcome: string, data: Record<string, unknown>) => void;
  /** How long a poll waits for an operation before answering `{ op: null }`. */
  pollMs?: number;
  /** Default time the plugin has to pick an operation up and answer it. */
  timeoutMs?: number;
}

export interface FigmaBridgeInfo {
  listening: boolean;
  port: number | null;
  connected: boolean;
  plugin: string | null;
}

/** HTTP long-poll bridge to the Jarvis plugin running in Figma desktop. */
export class FigmaBridge {
  readonly #o: Required<Omit<FigmaBridgeOptions, 'audit'>> & Pick<FigmaBridgeOptions, 'audit'>;
  #server: Server | null = null;
  #port: number | null = null;
  #token: string | null = null;
  #tokenFile: string | null = null;
  #session: string | null = null;
  #plugin: string | null = null;
  #waiting: Waiting | null = null;
  #lastSeen = 0;
  readonly #queue: Pending[] = [];
  readonly #pending = new Map<string, Pending>();
  readonly #rejections = new Map<string, number>();

  constructor(o: FigmaBridgeOptions = {}) {
    this.#o = { pollMs: 25_000, timeoutMs: 20_000, ...o };
  }

  get port(): number | null {
    return this.#port;
  }

  /** Current plugin session (changes when the plugin is relaunched or replaced). */
  get session(): string | null {
    return this.#session;
  }

  /** A plugin said hello and is polling (or polled within the last few seconds). */
  get connected(): boolean {
    if (!this.#session) return false;
    return this.#waiting !== null || Date.now() - this.#lastSeen < 5_000;
  }

  info(): FigmaBridgeInfo {
    return {
      listening: this.#server !== null,
      port: this.#port,
      connected: this.connected,
      plugin: this.#plugin,
    };
  }

  /**
   * Starts the loopback listener with a fresh random token. The token goes to `tokenFile`
   * (0600, created exclusively) for Brightky to paste into the plugin once per launch.
   */
  async listen(o: { port: number; tokenFile?: string; token?: string }): Promise<number> {
    if (this.#server) throw new Error('Figma bridge already listening');
    const token = o.token ?? randomBytes(32).toString('base64url');
    const server = createServer(
      { requestTimeout: 30_000, headersTimeout: 10_000, keepAliveTimeout: 5_000 },
      (req, res) => this.#handle(req, res),
    );
    server.maxConnections = 16;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(o.port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    server.on('error', () => undefined);
    this.#server = server;
    this.#port = (server.address() as AddressInfo).port;
    this.#token = token;
    if (o.tokenFile) {
      writeTokenFile(o.tokenFile, token);
      this.#tokenFile = o.tokenFile;
    }
    return this.#port;
  }

  /**
   * Sends one catalogue operation and resolves with the plugin's raw answer (the caller validates
   * it). Fails at once when no plugin is connected.
   */
  perform<K extends OpKind>(
    kind: K,
    args: FigmaOp<K>['args'],
    signal: AbortSignal,
    timeoutMs = this.#o.timeoutMs,
  ): Promise<unknown> {
    // Never send anything outside the catalogue, even by mistake.
    const parsed = OP_ARGS[kind].safeParse(args);
    if (!parsed.success)
      return Promise.reject(
        new FigmaError('outside_catalogue', `operation outside the catalogue: ${kind}`),
      );
    if (!this.#server)
      return Promise.reject(new FigmaError('not_listening', 'the Figma bridge is not listening'));
    if (!this.connected) {
      return Promise.reject(
        new FigmaError(
          'not_connected',
          'the Jarvis plugin is not connected: Brightky must open the file in Figma desktop and run ' +
            'Plugins › Development › Jarvis (token: docs/SETUP-FIGMA.md)',
        ),
      );
    }
    if (signal.aborted) return Promise.reject(new Error('aborted'));
    if (this.#queue.length >= QUEUE_MAX)
      return Promise.reject(new FigmaError('busy', 'too many Figma operations waiting'));

    const op: FigmaOp<K> = { id: randomUUID(), v: CATALOGUE_VERSION, kind, args };
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        p.cleanup();
        reject(new Error('aborted'));
      };
      const timer = setTimeout(() => {
        p.cleanup();
        reject(
          new FigmaError(
            'timeout',
            `the Figma plugin did not answer within ${Math.round(timeoutMs / 1000)} s`,
          ),
        );
      }, timeoutMs);
      const p: Pending = {
        op: op as FigmaOp,
        resolve,
        reject,
        session: null,
        cleanup: () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          this.#pending.delete(op.id);
          const i = this.#queue.indexOf(p);
          if (i >= 0) this.#queue.splice(i, 1);
        },
      };
      this.#pending.set(op.id, p);
      this.#queue.push(p);
      signal.addEventListener('abort', onAbort, { once: true });
      this.#pump();
    });
  }

  async close(): Promise<void> {
    this.#failAll('the Figma bridge is closing');
    this.#endWaiting({ op: null });
    this.#session = null;
    if (this.#tokenFile) rmSync(this.#tokenFile, { force: true });
    this.#tokenFile = null;
    const server = this.#server;
    this.#server = null;
    this.#token = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // ── HTTP ──

  #handle(req: IncomingMessage, res: ServerResponse) {
    const port = this.#port ?? -1;
    const a = admit(
      {
        method: req.method,
        url: req.url,
        remoteAddress: req.socket.remoteAddress,
        headers: req.headers,
      },
      port,
      this.#token ?? randomUUID(),
    );
    if (!a.ok) {
      this.#rejected(a.reason, req);
      req.resume();
      return send(res, a.status, { error: a.reason }, a.cors);
    }
    if (a.preflight) {
      res.writeHead(204, {
        ...CORS,
        'access-control-allow-methods': 'POST',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-max-age': '600',
        // Chromium's Private Network Access preflight, from the Figma page to loopback.
        ...(req.headers['access-control-request-private-network'] === 'true' && {
          'access-control-allow-private-network': 'true',
        }),
      });
      res.end();
      return;
    }
    const path = (req.url ?? '').split('?')[0];
    readBody(req, path === '/result' ? RESULT_BODY : SMALL_BODY).then(
      (raw) => {
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          return send(res, 400, { error: 'bad_json' });
        }
        if (path === '/hello') return this.#hello(body, res);
        if (path === '/poll') return this.#poll(body, res);
        return this.#result(body, res);
      },
      () => {
        send(res, 413, { error: 'too_large' });
        req.destroy();
      },
    );
  }

  #hello(body: unknown, res: ServerResponse) {
    const h = Hello.safeParse(body);
    if (!h.success) return send(res, 400, { error: 'bad_request' });
    if (h.data.catalogue !== CATALOGUE_VERSION)
      return send(res, 409, { error: 'version', catalogue: CATALOGUE_VERSION });
    if (h.data.session !== this.#session) {
      // One plugin at a time: the newest replaces the previous one. Whatever was meant for the
      // previous one (possibly another file) fails rather than running in the new one.
      if (this.#waiting && this.#waiting.session !== h.data.session)
        this.#endWaiting({ error: 'replaced' }, 409);
      for (const p of [...this.#pending.values()]) {
        p.cleanup();
        p.reject(
          new FigmaError('replaced', 'the Figma plugin was relaunched or another file took over'),
        );
      }
      this.#session = h.data.session;
      this.#plugin = h.data.plugin ?? null;
      this.#o.audit?.('figma_connected', { plugin: this.#plugin });
    }
    this.#lastSeen = Date.now();
    send(res, 200, { ok: true, catalogue: CATALOGUE_VERSION, pollMs: this.#o.pollMs });
  }

  #poll(body: unknown, res: ServerResponse) {
    const p = Poll.safeParse(body);
    if (!p.success) return send(res, 400, { error: 'bad_request' });
    if (p.data.session !== this.#session) return send(res, 409, { error: 'replaced' });
    this.#endWaiting({ op: null });
    this.#lastSeen = Date.now();
    const timer = setTimeout(() => this.#endWaiting({ op: null }), this.#o.pollMs);
    const w: Waiting = { session: p.data.session, res, timer };
    this.#waiting = w;
    res.on('close', () => {
      if (this.#waiting !== w) return;
      // The plugin went away while waiting (window closed): disconnected at once.
      clearTimeout(w.timer);
      this.#waiting = null;
      this.#lastSeen = 0;
    });
    this.#pump();
  }

  #result(body: unknown, res: ServerResponse) {
    const r = Result.safeParse(body);
    if (!r.success) return send(res, 400, { error: 'bad_request' });
    if (r.data.session !== this.#session) return send(res, 409, { error: 'replaced' });
    this.#lastSeen = Date.now();
    const p = this.#pending.get(r.data.id);
    // Only the session that received the operation may answer it; late answers are ignored.
    if (!p || p.session !== r.data.session) return send(res, 200, { ok: true, ignored: true });
    p.cleanup();
    if (r.data.ok) p.resolve(r.data.result);
    else {
      const code = (PLUGIN_ERRORS as readonly string[]).includes(r.data.code ?? '')
        ? (r.data.code as string)
        : 'error';
      p.reject(new FigmaError(code, (r.data.error ?? '').slice(0, 300), true));
    }
    send(res, 200, { ok: true });
  }

  #pump(): void {
    const w = this.#waiting;
    if (!w || w.session !== this.#session) return;
    if (w.res.destroyed) {
      clearTimeout(w.timer);
      this.#waiting = null;
      return;
    }
    const p = this.#queue.shift();
    if (!p) return;
    p.session = w.session;
    this.#endWaiting({ op: p.op });
  }

  #endWaiting(body: unknown, status = 200): void {
    const w = this.#waiting;
    if (!w) return;
    this.#waiting = null;
    clearTimeout(w.timer);
    this.#lastSeen = Date.now();
    send(w.res, status, body);
  }

  #failAll(reason: string): void {
    for (const p of [...this.#pending.values()]) {
      p.cleanup();
      p.reject(new FigmaError('closed', reason));
    }
  }

  /** Audits refused requests, at most once a minute per reason. */
  #rejected(reason: string, req: IncomingMessage): void {
    const now = Date.now();
    if (now - (this.#rejections.get(reason) ?? 0) < 60_000) return;
    this.#rejections.set(reason, now);
    this.#o.audit?.('figma_rejected', {
      reason,
      origin: req.headers.origin?.slice(0, 100) ?? null,
      host: req.headers.host?.slice(0, 100) ?? null,
    });
  }
}

const CORS = { 'access-control-allow-origin': '*' } as const;

function send(res: ServerResponse, status: number, body: unknown, cors = true): void {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...(cors && CORS),
  });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        req.removeAllListeners('data');
        reject(new Error('too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (size <= max) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

/** 0600, created exclusively (a pre-existing file or symlink is replaced, never followed). */
function writeTokenFile(path: string, token: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  rmSync(path, { force: true });
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, `${token}\n`);
  } finally {
    closeSync(fd);
  }
}
