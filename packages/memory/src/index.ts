import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

export type FactKind = 'preference' | 'contact' | 'project' | 'note';
/** Who the fact comes from. `external` facts are data and never reach the system prompt. */
export type FactSource = 'brightky' | 'jarvis' | 'external';

export interface Fact {
  id: number;
  kind: FactKind;
  text: string;
  source: FactSource;
  createdAt: string;
}

export interface UsageRecord {
  ts?: string;
  model: string;
  trigger: string;
  route: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Client-side estimate at API list prices; the subscription is what is actually used. */
  costUsd: number;
  ttftMs: number | null;
  durationMs: number | null;
}

export interface UsageSummary {
  since: string;
  turns: number;
  costUsd: number;
  avgTtftMs: number | null;
  byModel: Record<
    string,
    {
      turns: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      costUsd: number;
    }
  >;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(text, content='facts', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
  INSERT INTO facts_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  model TEXT NOT NULL,
  trigger TEXT NOT NULL,
  route TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  ttft_ms REAL,
  duration_ms REAL
);
CREATE INDEX IF NOT EXISTS usage_ts ON usage(ts);
`;

const NOTE_TEMPLATES: Record<string, string> = {
  'profil.md': `# Profil

<!-- Notes de Brightky. Jarvis les lit au début de chaque conversation, il ne les modifie jamais. -->
- Nom : Brightky Efo'o
- Ville : Douala, Cameroun
- Langues : français et anglais (Jarvis répond dans la langue utilisée)
`,
  'preferences.md': `# Préférences

<!-- Une préférence par ligne. Exemple : « Ton des mails : pro, direct, sans formules longues. » -->
`,
};

/** FTS5 query from free text: each word becomes a quoted prefix term (no operator injection). */
export function ftsQuery(text: string): string {
  const words = text.normalize('NFKC').match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  return words
    .slice(0, 12)
    .map((w) => `"${w.replaceAll('"', '""')}"*`)
    .join(' ');
}

interface FactRow {
  id: number;
  kind: FactKind;
  text: string;
  source: FactSource;
  created_at: string;
}

const toFact = (r: FactRow): Fact => ({
  id: r.id,
  kind: r.kind,
  text: r.text,
  source: r.source,
  createdAt: r.created_at,
});

export interface MemoryOptions {
  dbPath: string;
  notesDir: string;
}

/**
 * Long-lived memory v1. Two stores with different trust:
 *  - notesDir/*.md — written by Brightky, trusted, loaded into every session;
 *  - SQLite facts — written through tools, each tagged with its provenance.
 */
export class Memory {
  readonly #db: Database.Database;
  readonly #notesDir: string;
  // Prepared once: preparing on every call dominated search latency.
  readonly #stmt: {
    insert: Database.Statement;
    forget: Database.Statement;
    list: Database.Statement;
    search: Database.Statement;
    snapshotFacts: Database.Statement;
    insertUsage: Database.Statement;
  };

  constructor(opts: MemoryOptions) {
    mkdirSync(dirname(opts.dbPath), { recursive: true, mode: 0o700 });
    this.#db = new Database(opts.dbPath);
    this.#db.pragma('journal_mode = WAL');
    this.#db.pragma('synchronous = NORMAL');
    this.#db.exec(SCHEMA);
    this.#notesDir = opts.notesDir;
    this.#stmt = {
      insert: this.#db.prepare(
        'INSERT INTO facts (kind, text, source, created_at) VALUES (?, ?, ?, ?)',
      ),
      forget: this.#db.prepare(
        'UPDATE facts SET archived_at = ? WHERE id = ? AND archived_at IS NULL',
      ),
      list: this.#db.prepare(
        'SELECT id, kind, text, source, created_at FROM facts WHERE archived_at IS NULL ORDER BY id DESC LIMIT ?',
      ),
      search: this.#db.prepare(
        `SELECT f.id, f.kind, f.text, f.source, f.created_at FROM facts_fts
         JOIN facts f ON f.id = facts_fts.rowid
         WHERE facts_fts MATCH ? AND f.archived_at IS NULL
         ORDER BY bm25(facts_fts) LIMIT ?`,
      ),
      snapshotFacts: this.#db.prepare(
        "SELECT id, kind, text, source, created_at FROM facts WHERE archived_at IS NULL AND source != 'external' ORDER BY id DESC LIMIT 200",
      ),
      insertUsage: this.#db.prepare(
        `INSERT INTO usage (ts, model, trigger, route, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, ttft_ms, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
    };
    this.#ensureNotes();
  }

  #ensureNotes(): void {
    if (existsSync(this.#notesDir)) return;
    mkdirSync(this.#notesDir, { recursive: true, mode: 0o700 });
    for (const [name, body] of Object.entries(NOTE_TEMPLATES)) {
      writeFileSync(join(this.#notesDir, name), body, { mode: 0o600 });
    }
  }

  get notesDir(): string {
    return this.#notesDir;
  }

  remember(kind: FactKind, text: string, source: FactSource): Fact {
    const createdAt = new Date().toISOString();
    const info = this.#stmt.insert.run(kind, text.trim(), source, createdAt);
    return { id: Number(info.lastInsertRowid), kind, text: text.trim(), source, createdAt };
  }

  /** Soft delete: the row stays for the record, it just stops being recalled. */
  forget(id: number): boolean {
    return this.#stmt.forget.run(new Date().toISOString(), id).changes === 1;
  }

  list(limit = 50): Fact[] {
    const rows = this.#stmt.list.all(limit) as FactRow[];
    return rows.map(toFact);
  }

  search(text: string, limit = 10): Fact[] {
    const q = ftsQuery(text);
    if (!q) return [];
    const rows = this.#stmt.search.all(q, limit) as FactRow[];
    return rows.map(toFact);
  }

  /** Brightky's notes, in file order. */
  notes(): { file: string; text: string }[] {
    if (!existsSync(this.#notesDir)) return [];
    return readdirSync(this.#notesDir)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((file) => ({
        file,
        text: readFileSync(join(this.#notesDir, file), 'utf8')
          .replace(/<!--[\s\S]*?-->/g, '')
          .trim(),
      }))
      .filter((n) => n.text.length > 0);
  }

  /**
   * What goes into the system prompt at session start: Brightky's notes, then what Jarvis was
   * asked to remember. Facts from external content are left out on purpose (search only).
   */
  promptSnapshot(maxChars: number): string {
    if (maxChars <= 0) return '';
    const parts: string[] = [];
    const notes = this.notes();
    if (notes.length > 0)
      parts.push(`## Notes de Brightky\n${notes.map((n) => n.text).join('\n\n')}`);
    const facts = (this.#stmt.snapshotFacts.all() as FactRow[]).map(toFact);
    if (facts.length > 0)
      parts.push(`## Retenu par Jarvis\n${facts.map((f) => `- [${f.kind}] ${f.text}`).join('\n')}`);
    const out = parts.join('\n\n');
    return out.length > maxChars ? `${out.slice(0, maxChars)}\n[… mémoire tronquée]` : out;
  }

  recordUsage(u: UsageRecord): void {
    this.#stmt.insertUsage.run(
      u.ts ?? new Date().toISOString(),
      u.model,
      u.trigger,
      u.route,
      u.inputTokens,
      u.outputTokens,
      u.cacheReadTokens,
      u.cacheWriteTokens,
      u.costUsd,
      u.ttftMs,
      u.durationMs,
    );
  }

  usageSummary(since: Date): UsageSummary {
    const iso = since.toISOString();
    const rows = this.#db
      .prepare(
        `SELECT model, COUNT(*) AS turns, SUM(input_tokens) AS i, SUM(output_tokens) AS o,
                SUM(cache_read_tokens) AS cr, SUM(cost_usd) AS c
         FROM usage WHERE ts >= ? GROUP BY model ORDER BY c DESC`,
      )
      .all(iso) as { model: string; turns: number; i: number; o: number; cr: number; c: number }[];
    const ttft = this.#db
      .prepare('SELECT AVG(ttft_ms) AS a FROM usage WHERE ts >= ? AND ttft_ms IS NOT NULL')
      .get(iso) as { a: number | null };
    const byModel: UsageSummary['byModel'] = {};
    for (const r of rows)
      byModel[r.model] = {
        turns: r.turns,
        inputTokens: r.i,
        outputTokens: r.o,
        cacheReadTokens: r.cr,
        costUsd: r.c,
      };
    return {
      since: iso,
      turns: rows.reduce((n, r) => n + r.turns, 0),
      costUsd: rows.reduce((n, r) => n + r.c, 0),
      avgTtftMs: ttft.a === null ? null : Math.round(ttft.a),
      byModel,
    };
  }

  close(): void {
    this.#db.close();
  }
}
