import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export type TaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface Task {
  id: string;
  forge: 'github' | 'gitlab';
  repo: string;
  base: string | null;
  branch: string | null;
  title: string;
  prompt: string;
  /** Where the task came from: "voice", "cli", "trello:<card id>"… */
  source: string;
  /** The task text came from external content (issue, card): fenced in the worker prompt. */
  external: boolean;
  model: string;
  status: TaskStatus;
  step: string;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  prUrl: string | null;
  summary: string | null;
  error: string | null;
  costUsd: number;
  turns: number;
}

type Row = Omit<Task, 'external'> & { external: number };

/** The worker queue survives restarts: a task interrupted mid-run is marked failed, never resumed blindly. */
export class TaskStore {
  readonly #db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#db = new Database(path);
    this.#db.pragma('journal_mode = WAL');
    this.#db.exec(`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, forge TEXT NOT NULL, repo TEXT NOT NULL, base TEXT, branch TEXT,
      title TEXT NOT NULL, prompt TEXT NOT NULL, source TEXT NOT NULL, external INTEGER NOT NULL,
      model TEXT NOT NULL, status TEXT NOT NULL, step TEXT NOT NULL, createdAt TEXT NOT NULL,
      startedAt TEXT, endedAt TEXT, prUrl TEXT, summary TEXT, error TEXT,
      costUsd REAL NOT NULL DEFAULT 0, turns INTEGER NOT NULL DEFAULT 0)`);
    this.#db
      .prepare(
        `UPDATE tasks SET status = 'failed', step = 'interrompue', error = 'Jarvis a redémarré pendant la tâche', endedAt = ? WHERE status = 'running'`,
      )
      .run(new Date().toISOString());
  }

  add(
    t: Pick<
      Task,
      'id' | 'forge' | 'repo' | 'base' | 'title' | 'prompt' | 'source' | 'external' | 'model'
    >,
  ): Task {
    this.#db
      .prepare(`INSERT INTO tasks (id, forge, repo, base, branch, title, prompt, source, external, model, status, step, createdAt)
                VALUES (@id, @forge, @repo, @base, NULL, @title, @prompt, @source, @external, @model, 'queued', 'en file', @createdAt)`)
      .run({ ...t, external: t.external ? 1 : 0, createdAt: new Date().toISOString() });
    return this.get(t.id) as Task;
  }

  update(id: string, patch: Partial<Omit<Task, 'id'>>): Task {
    const keys = Object.keys(patch).filter((k) => /^[a-zA-Z]+$/.test(k));
    if (keys.length) {
      const values = Object.fromEntries(
        keys.map((k) => [
          k,
          (patch as Record<string, unknown>)[k] === true
            ? 1
            : (patch as Record<string, unknown>)[k] === false
              ? 0
              : (patch as Record<string, unknown>)[k],
        ]),
      );
      this.#db
        .prepare(`UPDATE tasks SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`)
        .run({ ...values, id });
    }
    return this.get(id) as Task;
  }

  get(id: string): Task | null {
    const r = this.#db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    return r ? { ...r, external: r.external === 1 } : null;
  }

  list(limit = 20): Task[] {
    return (
      this.#db.prepare('SELECT * FROM tasks ORDER BY createdAt DESC LIMIT ?').all(limit) as Row[]
    ).map((r) => ({ ...r, external: r.external === 1 }));
  }

  next(): Task | null {
    const r = this.#db
      .prepare(`SELECT * FROM tasks WHERE status = 'queued' ORDER BY createdAt ASC LIMIT 1`)
      .get() as Row | undefined;
    return r ? { ...r, external: r.external === 1 } : null;
  }

  running(): number {
    return (
      this.#db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status = 'running'`).get() as {
        n: number;
      }
    ).n;
  }

  close(): void {
    this.#db.close();
  }
}
