import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export type AuditEventKind = 'intent' | 'result' | 'approval' | 'llm' | 'system';

export interface AuditEvent {
  event: AuditEventKind;
  actionId?: string;
  tool?: string;
  level?: number;
  rule?: string;
  verdict?: string;
  trigger?: string;
  origin?: string;
  tainted?: boolean;
  approval?: string;
  outcome?: string;
  durationMs?: number;
  /** Must already be redacted by the caller. */
  data?: unknown;
}

export interface AuditRecord extends AuditEvent {
  seq: number;
  ts: string;
  prevHash: string;
  hash: string;
}

export type VerifyResult =
  | { ok: true; count: number }
  | { ok: false; count: number; brokenAt: number; reason: string };

const GENESIS = '0'.repeat(64);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  event TEXT NOT NULL,
  action_id TEXT,
  tool TEXT,
  level INTEGER,
  rule TEXT,
  verdict TEXT,
  trigger TEXT,
  origin TEXT,
  tainted INTEGER,
  approval TEXT,
  outcome TEXT,
  duration_ms REAL,
  data TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit
  BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit
  BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
`;

interface Row {
  seq: number;
  ts: string;
  event: AuditEventKind;
  action_id: string | null;
  tool: string | null;
  level: number | null;
  rule: string | null;
  verdict: string | null;
  trigger: string | null;
  origin: string | null;
  tainted: number | null;
  approval: string | null;
  outcome: string | null;
  duration_ms: number | null;
  data: string | null;
  prev_hash: string;
  hash: string;
}

type Columns = Omit<Row, 'seq' | 'hash'>;

/** Field order is part of the hash format: never reorder, only append. */
function chainHash(c: Columns): string {
  const canonical = JSON.stringify([
    c.prev_hash,
    c.ts,
    c.event,
    c.action_id,
    c.tool,
    c.level,
    c.rule,
    c.verdict,
    c.trigger,
    c.origin,
    c.tainted,
    c.approval,
    c.outcome,
    c.duration_ms,
    c.data,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

function toRecord(r: Row): AuditRecord {
  const rec: AuditRecord = {
    seq: r.seq,
    ts: r.ts,
    event: r.event,
    prevHash: r.prev_hash,
    hash: r.hash,
  };
  if (r.action_id !== null) rec.actionId = r.action_id;
  if (r.tool !== null) rec.tool = r.tool;
  if (r.level !== null) rec.level = r.level;
  if (r.rule !== null) rec.rule = r.rule;
  if (r.verdict !== null) rec.verdict = r.verdict;
  if (r.trigger !== null) rec.trigger = r.trigger;
  if (r.origin !== null) rec.origin = r.origin;
  if (r.tainted !== null) rec.tainted = r.tainted === 1;
  if (r.approval !== null) rec.approval = r.approval;
  if (r.outcome !== null) rec.outcome = r.outcome;
  if (r.duration_ms !== null) rec.durationMs = r.duration_ms;
  if (r.data !== null) rec.data = JSON.parse(r.data);
  return rec;
}

export interface AuditLogOptions {
  dbPath: string;
  /** Human-greppable mirror; one JSON object per line. */
  jsonlPath?: string;
}

/**
 * Append-only audit log. SQLite triggers refuse UPDATE/DELETE, and each row carries the
 * SHA-256 of the previous one so any edit made around the triggers is detectable by verify().
 */
export class AuditLog {
  readonly #db: Database.Database;
  readonly #insert: Database.Statement<Columns & { hash: string }>;
  readonly #jsonlFd: number | null;
  readonly #listeners = new Set<(r: AuditRecord) => void>();
  #lastHash: string;

  constructor(opts: AuditLogOptions) {
    mkdirSync(dirname(opts.dbPath), { recursive: true, mode: 0o700 });
    this.#db = new Database(opts.dbPath);
    this.#db.pragma('journal_mode = WAL');
    // Power cuts are frequent where this runs: durability over the last few µs.
    this.#db.pragma('synchronous = FULL');
    this.#db.exec(SCHEMA);
    this.#insert = this.#db.prepare(`
      INSERT INTO audit (ts, event, action_id, tool, level, rule, verdict, trigger, origin, tainted,
                         approval, outcome, duration_ms, data, prev_hash, hash)
      VALUES (@ts, @event, @action_id, @tool, @level, @rule, @verdict, @trigger, @origin, @tainted,
              @approval, @outcome, @duration_ms, @data, @prev_hash, @hash)`);
    const last = this.#db.prepare('SELECT hash FROM audit ORDER BY seq DESC LIMIT 1').get() as
      | { hash: string }
      | undefined;
    this.#lastHash = last?.hash ?? GENESIS;
    this.#jsonlFd = opts.jsonlPath ? openSync(opts.jsonlPath, 'a', 0o600) : null;
  }

  append(e: AuditEvent): AuditRecord {
    const cols: Columns = {
      ts: new Date().toISOString(),
      event: e.event,
      action_id: e.actionId ?? null,
      tool: e.tool ?? null,
      level: e.level ?? null,
      rule: e.rule ?? null,
      verdict: e.verdict ?? null,
      trigger: e.trigger ?? null,
      origin: e.origin ?? null,
      tainted: e.tainted === undefined ? null : e.tainted ? 1 : 0,
      approval: e.approval ?? null,
      outcome: e.outcome ?? null,
      duration_ms: e.durationMs ?? null,
      data: e.data === undefined ? null : JSON.stringify(e.data),
      prev_hash: this.#lastHash,
    };
    const hash = chainHash(cols);
    const info = this.#insert.run({ ...cols, hash });
    this.#lastHash = hash;
    const record = toRecord({ ...cols, seq: Number(info.lastInsertRowid), hash });
    if (this.#jsonlFd !== null) writeSync(this.#jsonlFd, `${JSON.stringify(record)}\n`);
    for (const fn of this.#listeners) {
      try {
        fn(record);
      } catch {
        // a dashboard listener must never break the audit trail
      }
    }
    return record;
  }

  /** Live feed for the dashboard. Returns an unsubscribe function. */
  onAppend(fn: (r: AuditRecord) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** History page, newest first, optionally filtered. */
  query(opts: {
    limit: number;
    beforeSeq?: number;
    tool?: string;
    event?: AuditEventKind;
    verdict?: string;
  }): AuditRecord[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.beforeSeq !== undefined) {
      where.push('seq < ?');
      args.push(opts.beforeSeq);
    }
    if (opts.tool) {
      where.push('tool = ?');
      args.push(opts.tool);
    }
    if (opts.event) {
      where.push('event = ?');
      args.push(opts.event);
    }
    if (opts.verdict) {
      where.push('verdict = ?');
      args.push(opts.verdict);
    }
    const sql = `SELECT * FROM audit ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT ?`;
    return (this.#db.prepare(sql).all(...args, opts.limit) as Row[]).map(toRecord);
  }

  tail(limit = 20): AuditRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM audit ORDER BY seq DESC LIMIT ?')
      .all(limit) as Row[];
    return rows.reverse().map(toRecord);
  }

  verify(): VerifyResult {
    let prev = GENESIS;
    let count = 0;
    for (const row of this.#db
      .prepare('SELECT * FROM audit ORDER BY seq')
      .iterate() as Iterable<Row>) {
      count++;
      if (row.prev_hash !== prev) {
        return {
          ok: false,
          count,
          brokenAt: row.seq,
          reason: 'chain link mismatch (row removed or reordered)',
        };
      }
      const { seq: _seq, hash, ...cols } = row;
      if (chainHash(cols) !== hash) {
        return {
          ok: false,
          count,
          brokenAt: row.seq,
          reason: 'row content does not match its hash',
        };
      }
      prev = hash;
    }
    return { ok: true, count };
  }

  close(): void {
    if (this.#jsonlFd !== null) closeSync(this.#jsonlFd);
    this.#db.close();
  }
}
