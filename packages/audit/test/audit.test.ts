import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/index.ts';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jarvis-audit-'));
  dbPath = join(dir, 'audit.db');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('AuditLog', () => {
  it('chains records and verifies a clean log', () => {
    const log = new AuditLog({ dbPath, jsonlPath: join(dir, 'audit.jsonl') });
    const a = log.append({ event: 'intent', tool: 'fs_read', level: 0, verdict: 'allow' });
    const b = log.append({ event: 'result', tool: 'fs_read', outcome: 'ok', data: { bytes: 12 } });
    expect(b.prevHash).toBe(a.hash);
    expect(log.verify()).toEqual({ ok: true, count: 2 });
    expect(log.tail(1)[0]?.data).toEqual({ bytes: 12 });
    expect(readFileSync(join(dir, 'audit.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
    log.close();
  });

  it('refuses UPDATE and DELETE through the triggers', () => {
    const log = new AuditLog({ dbPath });
    log.append({ event: 'system', outcome: 'boot' });
    log.close();
    const raw = new Database(dbPath);
    expect(() => raw.prepare("UPDATE audit SET outcome = 'x'").run()).toThrow(/append-only/);
    expect(() => raw.prepare('DELETE FROM audit').run()).toThrow(/append-only/);
    raw.close();
  });

  it('detects a row edited after the triggers were dropped', () => {
    const log = new AuditLog({ dbPath });
    log.append({ event: 'intent', tool: 'outbox_send', verdict: 'confirm' });
    log.append({ event: 'result', tool: 'outbox_send', outcome: 'denied' });
    log.close();

    const raw = new Database(dbPath);
    raw.exec('DROP TRIGGER audit_no_update');
    raw.prepare("UPDATE audit SET outcome = 'ok' WHERE seq = 2").run();
    raw.close();

    const reopened = new AuditLog({ dbPath });
    expect(reopened.verify()).toMatchObject({ ok: false, brokenAt: 2 });
    reopened.close();
  });

  it('detects a deleted row', () => {
    const log = new AuditLog({ dbPath });
    for (let i = 0; i < 3; i++) log.append({ event: 'system', outcome: `e${i}` });
    log.close();

    const raw = new Database(dbPath);
    raw.exec('DROP TRIGGER audit_no_delete');
    raw.prepare('DELETE FROM audit WHERE seq = 2').run();
    raw.close();

    const reopened = new AuditLog({ dbPath });
    expect(reopened.verify()).toMatchObject({ ok: false, brokenAt: 3 });
    reopened.close();
  });

  it('continues the chain across restarts', () => {
    const first = new AuditLog({ dbPath });
    first.append({ event: 'system', outcome: 'boot' });
    first.close();
    const second = new AuditLog({ dbPath });
    second.append({ event: 'system', outcome: 'boot' });
    expect(second.verify()).toEqual({ ok: true, count: 2 });
    second.close();
  });
});
