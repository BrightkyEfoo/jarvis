import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectFakeFigma, raw } from '../../../tests/e2e/fake-figma.ts';
import { admit, FigmaBridge, FigmaError, type Incoming } from '../src/figma/bridge.ts';

const TOKEN = 'test-token-0123456789abcdefghijklmnopqrstu';
const PORT = 47830;

const ok: Incoming = {
  method: 'POST',
  url: '/poll',
  remoteAddress: '127.0.0.1',
  headers: {
    host: `127.0.0.1:${PORT}`,
    origin: 'null',
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
  },
};
const withHeaders = (h: Record<string, string | undefined>): Incoming => ({
  ...ok,
  headers: { ...ok.headers, ...h },
});

describe('admit (pure)', () => {
  it('admits the plugin: loopback, right Host, null Origin, token, JSON', () => {
    expect(admit(ok, PORT, TOKEN)).toEqual({ ok: true, preflight: false, cors: true });
    expect(admit(withHeaders({ host: `localhost:${PORT}` }), PORT, TOKEN).ok).toBe(true);
    expect(admit({ ...ok, remoteAddress: '::ffff:127.0.0.1' }, PORT, TOKEN).ok).toBe(true);
    // A local tool without Origin still needs the token.
    expect(admit(withHeaders({ origin: undefined }), PORT, TOKEN).ok).toBe(true);
  });

  it('refuses non-loopback addresses', () => {
    for (const remoteAddress of ['192.168.1.20', '::ffff:10.0.0.2', '10.0.0.1', undefined]) {
      expect(admit({ ...ok, remoteAddress }, PORT, TOKEN)).toMatchObject({
        ok: false,
        status: 403,
        reason: 'not_loopback',
        cors: false,
      });
    }
  });

  it('refuses a bad Host (DNS rebinding)', () => {
    for (const host of [
      'evil.example',
      `evil.example:${PORT}`,
      '127.0.0.1:1234',
      `127.0.0.2:${PORT}`,
      `[::1]:${PORT}`,
      '',
    ]) {
      expect(admit(withHeaders({ host }), PORT, TOKEN)).toMatchObject({
        status: 403,
        reason: 'bad_host',
      });
    }
    expect(
      admit({ ...ok, headers: { ...ok.headers, host: undefined } }, PORT, TOKEN),
    ).toMatchObject({ reason: 'bad_host' });
  });

  it('refuses web pages by Origin, before looking at the token', () => {
    for (const origin of [
      'https://evil.example',
      'http://localhost:3000',
      `http://127.0.0.1:${PORT}`,
      'https://www.figma.com.evil.example',
      'file://',
    ]) {
      expect(admit(withHeaders({ origin }), PORT, TOKEN)).toMatchObject({
        status: 403,
        reason: 'bad_origin',
        cors: false,
      });
    }
    expect(admit(withHeaders({ origin: 'https://www.figma.com' }), PORT, TOKEN).ok).toBe(true);
  });

  it('answers CORS preflights without the token, only for allowed origins', () => {
    const pre = { ...ok, method: 'OPTIONS', headers: { host: ok.headers.host, origin: 'null' } };
    expect(admit(pre, PORT, TOKEN)).toEqual({ ok: true, preflight: true, cors: true });
    expect(
      admit({ ...pre, headers: { ...pre.headers, origin: 'https://evil.example' } }, PORT, TOKEN),
    ).toMatchObject({ ok: false, reason: 'bad_origin' });
  });

  it('requires POST, the exact token, JSON and a known route', () => {
    expect(admit({ ...ok, method: 'GET' }, PORT, TOKEN)).toMatchObject({ status: 405 });
    for (const authorization of [undefined, '', `Bearer ${TOKEN}x`, `Basic ${TOKEN}`, 'Bearer ']) {
      expect(admit(withHeaders({ authorization }), PORT, TOKEN)).toMatchObject({
        status: 401,
        reason: 'bad_token',
      });
    }
    expect(admit(withHeaders({ 'content-type': 'text/plain' }), PORT, TOKEN)).toMatchObject({
      status: 415,
    });
    expect(admit({ ...ok, url: '/eval' }, PORT, TOKEN)).toMatchObject({ status: 404 });
  });
});

describe('FigmaBridge over HTTP', () => {
  let dir: string;
  let bridge: FigmaBridge;
  let port: number;
  let audits: { outcome: string; data: Record<string, unknown> }[];
  const never = new AbortController().signal;

  beforeEach(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'jv-figma-')));
    audits = [];
    bridge = new FigmaBridge({
      pollMs: 300,
      timeoutMs: 400,
      audit: (outcome, data) => audits.push({ outcome, data }),
    });
    port = await bridge.listen({
      port: 0,
      token: TOKEN,
      tokenFile: join(dir, 'run', 'figma-token'),
    });
  });
  afterEach(async () => {
    await bridge.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the token to a 0600 file, and removes it on close', async () => {
    const file = join(dir, 'run', 'figma-token');
    expect(readFileSync(file, 'utf8')).toBe(`${TOKEN}\n`);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    await bridge.close();
    expect(() => lstatSync(file)).toThrow();
  });

  it('a symlink planted at the token path is replaced, never followed', async () => {
    await bridge.close();
    const target = join(dir, 'victim');
    writeFileSync(target, 'keep me');
    const file = join(dir, 'run', 'figma-token');
    symlinkSync(target, file);
    const b = new FigmaBridge();
    await b.listen({ port: 0, tokenFile: file });
    expect(readFileSync(target, 'utf8')).toBe('keep me');
    expect(lstatSync(file).isSymbolicLink()).toBe(false);
    expect(readFileSync(file, 'utf8').trim()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await b.close();
  });

  it('listens on 127.0.0.1 only', () => {
    expect(bridge.info()).toMatchObject({ listening: true, port, connected: false });
  });

  it('refuses requests without the token, with a bad Host or Origin, and audits it', async () => {
    const body = { session: 'abcdefgh', catalogue: 1 };
    expect((await raw(port, '/hello', { origin: 'null', body })).status).toBe(401);
    expect((await raw(port, '/hello', { token: 'nope', origin: 'null', body })).status).toBe(401);
    const rebinding = await raw(port, '/hello', {
      token: TOKEN,
      host: `evil.example:${port}`,
      body,
    });
    expect(rebinding.status).toBe(403);
    expect(rebinding.headers['access-control-allow-origin']).toBeUndefined();
    const page = await raw(port, '/hello', { token: TOKEN, origin: 'https://evil.example', body });
    expect(page.status).toBe(403);
    // No Host at all: Node itself answers 400 (HTTP/1.1 requires it).
    expect((await raw(port, '/hello', { token: TOKEN, host: null, body })).status).toBe(400);
    expect((await raw(port, '/poll', { method: 'GET', token: TOKEN })).status).toBe(405);
    expect(bridge.connected).toBe(false);
    expect(audits.filter((a) => a.outcome === 'figma_rejected').map((a) => a.data.reason)).toEqual(
      expect.arrayContaining(['bad_token', 'bad_host', 'bad_origin']),
    );
  });

  it('answers the preflight with CORS and Private Network Access headers', async () => {
    const r = await raw(port, '/poll', {
      method: 'OPTIONS',
      origin: 'null',
      headers: {
        'access-control-request-method': 'POST',
        'access-control-request-private-network': 'true',
      },
    });
    expect(r.status).toBe(204);
    expect(r.headers['access-control-allow-headers']).toBe('authorization, content-type');
    expect(r.headers['access-control-allow-private-network']).toBe('true');
  });

  it('fails at once when no plugin is connected', async () => {
    const t0 = Date.now();
    await expect(bridge.perform('status', {}, never)).rejects.toThrow('not connected');
    expect(Date.now() - t0).toBeLessThan(100);
  });

  it('never sends an operation outside the catalogue', async () => {
    await connectFakeFigma(port, TOKEN, () => ({ ok: true, result: {} }));
    const bad = { node_id: '1:2', text: 'x', expect: { fp: 'zz' }, scope: 'draft' } as never;
    await expect(bridge.perform('set_text', bad, never)).rejects.toThrow('outside the catalogue');
    await expect(
      bridge.perform('status', { script: 'figma.root.remove()' } as never, never),
    ).rejects.toThrow('outside the catalogue');
  });

  it('hands an operation to the polling plugin and returns its answer', async () => {
    const fake = await connectFakeFigma(port, TOKEN, (op) => ({
      ok: true,
      result: { echo: op.kind },
    }));
    await expect(bridge.perform('status', {}, never)).resolves.toEqual({ echo: 'status' });
    expect(fake.ops[0]).toMatchObject({ v: 1, kind: 'status', args: {} });
    expect(audits.some((a) => a.outcome === 'figma_connected')).toBe(true);
    fake.close();
  });

  it('passes plugin errors as plugin errors, with an unknown code turned into "error"', async () => {
    const fake = await connectFakeFigma(port, TOKEN, (op) =>
      op.kind === 'status'
        ? { ok: false, code: 'stale', error: 'changed' }
        : { ok: false, code: 'rm -rf', error: 'x' },
    );
    const e1 = await bridge.perform('status', {}, never).catch((e: FigmaError) => e);
    expect(e1).toMatchObject({ code: 'stale', fromPlugin: true });
    const e2 = await bridge.perform('variables', {}, never).catch((e: FigmaError) => e);
    expect(e2).toMatchObject({ code: 'error', fromPlugin: true });
    fake.close();
  });

  it('times out when the plugin takes an operation and never answers', async () => {
    const fake = await connectFakeFigma(port, TOKEN, () => 'hang');
    await expect(bridge.perform('status', {}, never, 150)).rejects.toThrow('did not answer');
    expect(fake.ops).toHaveLength(1);
    fake.close();
  });

  it('a timed-out or aborted operation is not handed out later', async () => {
    const fake = await connectFakeFigma(port, TOKEN, () => ({ ok: true, result: 1 }));
    fake.close();
    // Still counted as connected for a moment after a normal poll ended: the op waits, then fails.
    await new Promise((r) => setTimeout(r, 20));
    const ac = new AbortController();
    const pending = bridge.perform('status', {}, ac.signal).then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    ac.abort();
    const message = await pending;
    expect(message === 'aborted' || message.includes('not connected')).toBe(true);
    const again = await connectFakeFigma(port, TOKEN, () => ({ ok: true, result: 2 }));
    await expect(bridge.perform('variables', {}, never)).resolves.toBe(2);
    expect(again.ops.map((o) => o.kind)).toEqual(['variables']);
    again.close();
  });

  it('closing the plugin while it waits disconnects it at once', async () => {
    const fake = await connectFakeFigma(port, TOKEN, () => ({ ok: true, result: {} }));
    await new Promise((r) => setTimeout(r, 30));
    expect(bridge.connected).toBe(true);
    fake.close();
    for (let i = 0; i < 50 && bridge.connected; i++) await new Promise((r) => setTimeout(r, 10));
    expect(bridge.connected).toBe(false);
    await expect(bridge.perform('status', {}, never)).rejects.toThrow('not connected');
  });

  it('one plugin at a time: the newest wins, the old one is told it was replaced', async () => {
    const a = await connectFakeFigma(port, TOKEN, () => ({ ok: true, result: 'a' }), 'session-a');
    const b = await connectFakeFigma(port, TOKEN, () => ({ ok: true, result: 'b' }), 'session-b');
    expect(bridge.session).toBe('session-b');
    await expect(bridge.perform('status', {}, never)).resolves.toBe('b');
    const stale = await raw(port, '/poll', {
      token: TOKEN,
      origin: 'null',
      body: { session: 'session-a' },
    });
    expect(stale.status).toBe(409);
    // The replaced session cannot answer anything either.
    const late = await raw(port, '/result', {
      token: TOKEN,
      origin: 'null',
      body: { session: 'session-a', id: crypto.randomUUID(), ok: true },
    });
    expect(late.status).toBe(409);
    a.close();
    b.close();
  });

  it('an answer for an unknown operation is ignored', async () => {
    const fake = await connectFakeFigma(port, TOKEN, () => 'hang', 'session-c');
    const r = await raw(port, '/result', {
      token: TOKEN,
      origin: 'null',
      body: { session: 'session-c', id: crypto.randomUUID(), ok: true, result: 'forged' },
    });
    expect(r.json).toEqual({ ok: true, ignored: true });
    fake.close();
  });

  it('refuses a plugin built for another catalogue version, and oversized bodies', async () => {
    const v = await raw(port, '/hello', {
      token: TOKEN,
      origin: 'null',
      body: { session: 'abcdefgh', catalogue: 99 },
    });
    expect(v.status).toBe(409);
    expect(v.json).toMatchObject({ error: 'version' });
    const big = await raw(port, '/poll', {
      token: TOKEN,
      origin: 'null',
      body: { session: 'x'.repeat(40_000) },
    }).catch(() => ({ status: 413 }));
    expect(big.status).toBe(413);
  });
});

describe('FigmaBridge lifecycle', () => {
  it('perform fails cleanly before listen and after close', async () => {
    const b = new FigmaBridge();
    await expect(b.perform('status', {}, new AbortController().signal)).rejects.toBeInstanceOf(
      FigmaError,
    );
    await b.listen({ port: 0 });
    await b.close();
    expect(b.info()).toMatchObject({ listening: false, connected: false });
  });
});
