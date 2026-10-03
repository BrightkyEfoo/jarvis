import { type ClientRequest, request } from 'node:http';
import type { FigmaOp } from '../../apps/jarvisd/src/figma/catalogue.ts';

export interface Raw {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  json: Record<string, unknown> | null;
}

export interface RawOptions {
  method?: string;
  token?: string;
  /** Host header; null sends none. Default 127.0.0.1:<port>. */
  host?: string | null;
  origin?: string;
  contentType?: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  onRequest?: (req: ClientRequest) => void;
}

/** One HTTP request to the bridge with full control over Host, Origin and the token. */
export function raw(port: number, path: string, o: RawOptions = {}): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...o.headers };
    if (o.host !== null) headers.host = o.host ?? `127.0.0.1:${port}`;
    if (o.origin !== undefined) headers.origin = o.origin;
    if (o.token !== undefined) headers.authorization = `Bearer ${o.token}`;
    const method = o.method ?? 'POST';
    const body =
      typeof o.body === 'string' ? o.body : o.body === undefined ? '' : JSON.stringify(o.body);
    if (method === 'POST') headers['content-type'] = o.contentType ?? 'application/json';
    const req = request(
      { host: '127.0.0.1', port, path, method, headers, setHost: false, signal: o.signal },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          text += c;
        });
        res.on('end', () => {
          let json: Record<string, unknown> | null = null;
          try {
            json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, json });
        });
      },
    );
    req.on('error', reject);
    o.onRequest?.(req);
    req.end(body);
  });
}

export type Answer =
  | { ok: true; result: unknown }
  | { ok: false; code: string; error?: string }
  | 'hang';

export interface FakeFigma {
  readonly session: string;
  /** Every operation received, in order. */
  readonly ops: FigmaOp[];
  /** Stops polling and drops the poll in flight, like closing the plugin window. */
  close(): void;
}

/**
 * Stands in for the plugin's ui.html + code.js: says hello, then long-polls the bridge and
 * answers each operation with `answer` ('hang' never answers).
 */
export async function connectFakeFigma(
  port: number,
  token: string,
  answer: (op: FigmaOp) => Answer | Promise<Answer>,
  session = `fake-${Math.random().toString(16).slice(2, 12)}`,
): Promise<FakeFigma> {
  const hello = await raw(port, '/hello', {
    token,
    origin: 'null',
    body: { session, catalogue: 1, plugin: 'test' },
  });
  if (hello.status !== 200) throw new Error(`hello failed: ${hello.status}`);
  const ops: FigmaOp[] = [];
  let stopped = false;
  let current: ClientRequest | null = null;
  void (async () => {
    while (!stopped) {
      let r: Raw;
      try {
        r = await raw(port, '/poll', {
          token,
          origin: 'null',
          body: { session },
          onRequest: (req) => {
            current = req;
          },
        });
      } catch {
        return;
      }
      if (r.status !== 200 || stopped) return;
      const op = r.json?.op as FigmaOp | null | undefined;
      if (!op) continue;
      ops.push(op);
      const a = await answer(op);
      if (a === 'hang') continue;
      await raw(port, '/result', { token, origin: 'null', body: { session, id: op.id, ...a } });
    }
  })();
  return {
    session,
    ops,
    close: () => {
      stopped = true;
      (current as ClientRequest | null)?.destroy();
    },
  };
}
