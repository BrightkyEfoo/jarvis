import { connect } from 'node:net';
import { N0, PolicyEngine, parseShell, Session } from '@jarvis/policy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from '../e2e/harness.ts';

/**
 * Performance budgets from the Sprint 0 plan. CI machines are slower and noisier:
 * PERF_BUDGET_FACTOR scales every budget (default 1 on the Mac).
 */
const FACTOR = Number(process.env.PERF_BUDGET_FACTOR ?? 1);

function p99(samples: number[]): number {
  const s = [...samples].sort((a, b) => a - b);
  return s[Math.floor(s.length * 0.99)] ?? Number.POSITIVE_INFINITY;
}

async function measure(n: number, fn: () => unknown): Promise<number> {
  for (let i = 0; i < Math.min(200, n); i++) await fn(); // warm-up (JIT, caches)
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await fn();
    out.push(performance.now() - t);
  }
  return p99(out);
}

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

describe('performance budgets', () => {
  it('daemon cold start (runtime + socket) < 300 ms', async () => {
    const t0 = performance.now();
    const other = await startHarness();
    const ms = performance.now() - t0;
    await other.close();
    console.log(`cold start: ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(300 * FACTOR);
  });

  it('policy evaluate (shell parse + classify + engine) p99 < 1 ms', async () => {
    const engine = new PolicyEngine([]);
    const session = new Session();
    // Reach the classifier the way shell_run does, through the registered tool.
    const shell = h.rt.gate.tools.find((t) => t.name === 'shell_run');
    if (!shell) throw new Error('shell_run missing');
    const ctx = { session, signal: new AbortController().signal, cwd: h.work };
    const cmd = { command: 'git log --oneline -n 20 | head -5 && pnpm test' };
    const ms = await measure(5000, () =>
      engine.evaluate('shell_run', cmd, shell.classify(cmd, ctx), session),
    );
    console.log(`evaluate p99: ${(ms * 1000).toFixed(0)} µs`);
    expect(parseShell(cmd.command, h.home).steps).toHaveLength(2);
    expect(ms).toBeLessThan(1 * FACTOR);
  });

  it('gate overhead with durable audit writes p99 < 2 ms', async () => {
    const session = new Session();
    const ms = await measure(2000, () =>
      h.rt.gate.invoke('system_time', {}, session, { trigger: 'perf' }),
    );
    console.log(`gate p99: ${(ms * 1000).toFixed(0)} µs`);
    expect(ms).toBeLessThan(2 * FACTOR);
    expect(
      h.rt.gate.tools
        .find((t) => t.name === 'system_time')
        ?.classify({}, { session, signal: new AbortController().signal, cwd: h.work }).level,
    ).toBe(N0);
  });

  it('memory search p99 < 1 ms and session snapshot < 5 ms (500 facts)', async () => {
    for (let i = 0; i < 500; i++)
      h.rt.memory.remember(
        'note',
        `Projet numéro ${i} : client ${i % 37}, stack Next.js et Coolify`,
        'jarvis',
      );
    const search = await measure(2000, () => h.rt.memory.search('client coolify', 10));
    const snapshot = await measure(200, () => h.rt.memory.promptSnapshot(8000));
    console.log(
      `memory search p99: ${(search * 1000).toFixed(0)} µs, snapshot p99: ${(snapshot * 1000).toFixed(0)} µs`,
    );
    expect(search).toBeLessThan(1 * FACTOR);
    expect(snapshot).toBeLessThan(5 * FACTOR);
  });

  it('CLI ↔ daemon round trip p99 < 5 ms', async () => {
    const s = connect(h.socket);
    await new Promise<void>((r) => s.once('connect', () => r()));
    s.setEncoding('utf8');
    let resolveReply: (() => void) | null = null;
    s.on('data', () => resolveReply?.());
    let i = 0;
    const ms = await measure(
      1000,
      () =>
        new Promise<void>((r) => {
          resolveReply = r;
          s.write(`${JSON.stringify({ id: `p${i++}`, cmd: 'ping' })}\n`);
        }),
    );
    s.end();
    console.log(`IPC RTT p99: ${(ms * 1000).toFixed(0)} µs`);
    expect(ms).toBeLessThan(5 * FACTOR);
  });
});
