import Database from 'better-sqlite3';
import type { PostFeatures } from './insights.ts';
import type { PostStats } from './xlsx.ts';

export interface StoredPost {
  id: string;
  urn: string | null;
  url: string | null;
  text: string;
  createdAt: string;
  features: PostFeatures;
}

export interface Asset {
  id: string;
  kind: 'card' | 'screenshot' | 'file';
  path: string;
  alt: string;
  createdAt: string;
}

/** Brightky's LinkedIn history, local: what Jarvis published, the exported stats, the assets. */
export class LinkedInStore {
  readonly #db: Database.Database;

  constructor(file: string) {
    this.#db = new Database(file);
    this.#db.pragma('journal_mode = WAL');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS posts (id TEXT PRIMARY KEY, urn TEXT, url TEXT, text TEXT NOT NULL,
        createdAt TEXT NOT NULL, features TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS stats (url TEXT PRIMARY KEY, date TEXT, impressions REAL, engagements REAL,
        importedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, kind TEXT NOT NULL, path TEXT NOT NULL,
        alt TEXT NOT NULL, createdAt TEXT NOT NULL);
    `);
  }

  addPost(p: StoredPost): void {
    this.#db
      .prepare(
        'INSERT INTO posts (id, urn, url, text, createdAt, features) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(p.id, p.urn, p.url, p.text, p.createdAt, JSON.stringify(p.features));
  }

  posts(limit = 50): StoredPost[] {
    return (
      this.#db.prepare('SELECT * FROM posts ORDER BY createdAt DESC LIMIT ?').all(limit) as (Omit<
        StoredPost,
        'features'
      > & {
        features: string;
      })[]
    ).map((r) => ({ ...r, features: JSON.parse(r.features) as PostFeatures }));
  }

  upsertStats(rows: PostStats[]): number {
    const st = this.#db.prepare(
      `INSERT INTO stats (url, date, impressions, engagements, importedAt) VALUES (@url, @date, @impressions, @engagements, @at)
       ON CONFLICT(url) DO UPDATE SET date = coalesce(excluded.date, date),
         impressions = coalesce(excluded.impressions, impressions),
         engagements = coalesce(excluded.engagements, engagements), importedAt = excluded.importedAt`,
    );
    const at = new Date().toISOString();
    this.#db.transaction(() => {
      for (const r of rows) st.run({ ...r, at });
    })();
    return rows.length;
  }

  stats(): PostStats[] {
    return this.#db
      .prepare('SELECT url, date, impressions, engagements FROM stats')
      .all() as PostStats[];
  }

  addAsset(a: Asset): void {
    this.#db
      .prepare('INSERT INTO assets (id, kind, path, alt, createdAt) VALUES (?, ?, ?, ?, ?)')
      .run(a.id, a.kind, a.path, a.alt, a.createdAt);
  }

  asset(id: string): Asset | undefined {
    return this.#db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as Asset | undefined;
  }

  close(): void {
    this.#db.close();
  }
}
