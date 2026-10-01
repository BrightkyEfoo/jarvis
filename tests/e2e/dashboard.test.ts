import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Memory } from '@jarvis/memory';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Reply } from '../../apps/jarvisd/src/ipc.ts';
import { type Harness, PIN, startHarness } from './harness.ts';

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

type Ev = {
  kind: string;
  activity?: { kind: string; name?: string };
  record?: { event: string; tool?: string };
};
const events = (rs: Reply[]) => rs.flatMap((r) => (r.type === 'event' ? [r.event as Ev] : []));

describe('dashboard snapshot', () => {
  it('has everything the dashboard renders, signature included', async () => {
    h.rt.memory.recordUsage({
      model: 'claude-sonnet-5-5',
      trigger: 'voice',
      route: 'conversation',
      inputTokens: 900,
      outputTokens: 120,
      cacheReadTokens: 8000,
      cacheWriteTokens: 0,
      costUsd: 0.004,
      ttftMs: 700,
      durationMs: 1500,
    });
    const c = await h.rpc();
    await c.call({ cmd: 'ask', text: 'call system_time {}' });
    const r = await c.call({ cmd: 'dashboard' });
    c.close();
    expect(r.final.type).toBe('done');
    const d = (r.final as { data: Record<string, unknown> }).data as {
      status: { stop: null; brain: string; policy: { sealed: boolean } };
      audit: { seq: number; tool?: string }[];
      costs: { today: { turns: number } };
      daily: unknown[];
      mail: { id: string }[];
      tools: { name: string }[];
      signature: string;
      forecast: { monthCostUsd: number };
    };
    expect(d.status).toMatchObject({ stop: null, brain: 'ready' });
    expect(d.audit[0]?.seq).toBeGreaterThan(d.audit[1]?.seq ?? 0); // newest first
    expect(d.audit.some((a) => a.tool === 'system_time')).toBe(true);
    expect(d.costs.today.turns).toBe(1);
    expect(d.daily).toHaveLength(30);
    expect(d.mail.map((m) => m.id)).toEqual(['perso', 'scriptify']);
    expect(d.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['briefing', 'web_research', 'mail_send', 'shell_run']),
    );
    expect(d.forecast.monthCostUsd).toBeGreaterThan(0);
    expect(d.signature).toBe("fait avec ❤️ par Brightky Efo'o — https://brightkyefoo.cm");
  });
});

describe('live feed (watch)', () => {
  it('streams activity, audit rows, approvals and STOP/resume as they happen', async () => {
    const watcher = await h.rpc();
    const seen: Reply[] = [];
    void watcher.call({ cmd: 'watch' }, (e) => seen.push(e));
    await new Promise((r) => setTimeout(r, 30));

    const asker = await h.rpc();
    const pending = asker.call({
      cmd: 'ask',
      text: 'call outbox_send {"to":"paul@example.com","subject":"x","body":"y"}',
    });
    for (let i = 0; i < 200 && h.rt.approvals.pending().length === 0; i++)
      await new Promise((r) => setTimeout(r, 10));
    const req = h.rt.approvals.pending()[0];

    // The dashboard approves through its own channel, recorded as `hud`.
    const hud = await h.rpc();
    expect(
      (await hud.call({ cmd: 'approve', approvalId: req?.id ?? '', channel: 'hud' })).final.type,
    ).toBe('done');
    await pending;
    await hud.call({ cmd: 'stop', reason: 'dashboard' });
    await hud.call({ cmd: 'resume', pin: PIN });
    await new Promise((r) => setTimeout(r, 30));

    const ev = events(seen);
    expect(ev[0]?.kind).toBe('hello');
    const activity = ev.flatMap((e) => (e.activity ? [e.activity.kind] : []));
    expect(activity).toEqual(
      expect.arrayContaining(['turn_start', 'tool', 'turn_end', 'stop', 'resume']),
    );
    expect(ev.some((e) => e.record?.event === 'approval')).toBe(true);
    expect(seen.some((r) => r.type === 'approval')).toBe(true);
    expect(h.rt.audit.query({ limit: 20, event: 'approval' })[0]).toMatchObject({
      approval: 'hud',
      outcome: 'approved',
    });
    watcher.close();
    asker.close();
    hud.close();
  });
});

describe('history (audit_query)', () => {
  it('filters by tool and verdict, newest first, with paging', async () => {
    const c = await h.rpc();
    await c.call({
      cmd: 'ask',
      text: 'call shell_run {"command":"rm -rf ~"}\ncall system_time {}\ncall shell_run {"command":"sudo ls"}',
    });
    const denied = await c.call({ cmd: 'audit_query', event: 'intent', verdict: 'deny' });
    const rows = (denied.final as { data: { seq: number; rule: string }[] }).data;
    expect(rows.map((r) => r.rule)).toEqual(['shell.deny.sudo', 'shell.deny.rm']);
    const page = await c.call({
      cmd: 'audit_query',
      limit: 1,
      beforeSeq: rows[0]?.seq ?? 0,
      tool: 'shell_run',
      event: 'intent',
    });
    expect((page.final as { data: { rule: string }[] }).data.map((r) => r.rule)).toEqual([
      'shell.deny.rm',
    ]);
    c.close();
  });
});

describe('forecasts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-forecast-'));
  afterEach(() => undefined);

  it('projects when a subscription window fills up at the current pace', () => {
    const mem = new Memory({ dbPath: join(dir, 'a.db'), notesDir: join(dir, 'notes-a') });
    const t0 = new Date('2026-10-01T08:00:00Z');
    const reset = new Date('2026-10-01T13:00:00Z');
    const at = (min: number) => new Date(t0.getTime() + min * 60_000);
    mem.recordQuota('five_hour', 0.9, 'allowed', reset, at(-120)); // previous window
    mem.recordQuota('five_hour', 0.1, 'allowed', reset, at(0)); // reset happened
    mem.recordQuota('five_hour', 0.3, 'allowed', reset, at(60));
    const f = mem.quotaForecast('five_hour', at(60));
    expect(f?.perHour).toBeCloseTo(0.2);
    expect(f?.fullAt).toBe(new Date(at(60).getTime() + 3.5 * 3_600_000).toISOString()); // 12:30 < reset
    // Usage flattens: the average pace drops and the window no longer fills before its reset.
    mem.recordQuota('five_hour', 0.3, 'allowed', reset, at(90));
    expect(mem.quotaForecast('five_hour', at(90))?.fullAt).toBeNull();
    mem.close();
  });

  it('says "not before the reset" when the pace is slow, and charts days', () => {
    const mem = new Memory({ dbPath: join(dir, 'b.db'), notesDir: join(dir, 'notes-b') });
    const now = new Date('2026-10-01T10:00:00Z');
    mem.recordQuota(
      'seven_day',
      0.2,
      'allowed',
      new Date('2026-10-02T00:00:00Z'),
      new Date('2026-10-01T09:00:00Z'),
    );
    mem.recordQuota('seven_day', 0.21, 'allowed', new Date('2026-10-02T00:00:00Z'), now);
    expect(mem.quotaForecast('seven_day', now)).toMatchObject({ fullAt: null, utilization: 0.21 });
    expect(mem.usageDaily(7, now)).toHaveLength(7);
    mem.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
