import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ForgeClient, ForgeId } from '@jarvis/connectors';
import type { KillSwitch } from '@jarvis/policy';
import { AI_TRAILER, BRANCH, type Git, type GitAuth, slug } from './git.ts';
import { PROTECTED, workerGuard } from './guard.ts';
import type { WorkerOutcome, WorkerRunner } from './runner.ts';
import { fileLogger } from './runner.ts';
import type { Task, TaskStore } from './store.ts';

export interface WorkerEvent {
  id: string;
  status: Task['status'];
  step: string;
  title: string;
  repo: string;
  prUrl?: string | null;
  error?: string | null;
}

interface Audit {
  append(e: {
    event: 'intent' | 'result' | 'system';
    tool?: string;
    level?: number;
    rule?: string;
    verdict?: string;
    outcome?: string;
    data?: unknown;
  }): unknown;
}

export interface WorkerManagerDeps {
  store: TaskStore;
  git: Git;
  /** Null when no subscription token is stored: tasks wait in the queue. */
  runner: WorkerRunner | null;
  forges: Map<ForgeId, ForgeClient>;
  audit: Audit;
  killswitch: KillSwitch;
  /** True when a string contains a known secret or a token pattern. */
  containsSecret: (text: string) => boolean;
  emit: (e: WorkerEvent) => void;
  home: string;
  dir: string;
  logsDir: string;
  extraDeny: readonly string[];
  maxParallel: number;
  draftPr: boolean;
  /** Quota left for background work (the interactive reserve is kept for Brightky). */
  quotaOk: () => boolean;
  /** Called once a task ends (Trello follow-up…); errors are logged, never fatal. */
  onFinished?: (t: Task) => Promise<void>;
}

class Stop extends Error {}

/**
 * Task → own clone → worktree → Claude Code (sandboxed, guarded) → checks → one clean commit in
 * Brightky's name → push of a jarvis/… branch → pull request. Never merges, never pushes the
 * default branch.
 */
export class WorkerManager {
  readonly #d: WorkerManagerDeps;
  readonly #running = new Map<string, AbortController>();
  readonly #promises = new Set<Promise<void>>();
  /** Serialises git operations on a shared clone (clone, fetch, worktree add/remove). */
  readonly #repoLocks = new Map<string, Promise<unknown>>();
  #timer: NodeJS.Timeout | null = null;
  #closing = false;

  constructor(d: WorkerManagerDeps) {
    this.#d = d;
    d.killswitch.signal.addEventListener('abort', () => this.cancelAll('STOP'));
  }

  enqueue(t: {
    forge: ForgeId;
    repo: string;
    task: string;
    base?: string;
    source: string;
    external: boolean;
    model: string;
  }): Task {
    if (!this.#d.forges.has(t.forge))
      throw new Error(`${t.forge} n'est pas connecté : jarvis ${t.forge} connect`);
    const title = t.task.split('\n')[0]?.slice(0, 100) ?? 'tâche';
    const task = this.#d.store.add({
      id: randomUUID().slice(0, 8),
      forge: t.forge,
      repo: t.repo,
      base: t.base ?? null,
      title,
      prompt: t.task,
      source: t.source,
      external: t.external,
      model: t.model,
    });
    this.#emit(task);
    queueMicrotask(() => this.pump());
    return task;
  }

  cancel(id: string): Task | null {
    const t = this.#d.store.get(id);
    if (!t) return null;
    if (t.status === 'queued')
      return this.#emit(
        this.#d.store.update(id, {
          status: 'cancelled',
          step: 'annulée',
          endedAt: new Date().toISOString(),
        }),
      );
    this.#running.get(id)?.abort();
    return t;
  }

  cancelAll(reason: string): void {
    for (const t of this.#d.store.list(200)) {
      if (t.status === 'queued')
        this.#d.store.update(t.id, {
          status: 'cancelled',
          step: reason,
          endedAt: new Date().toISOString(),
        });
    }
    for (const a of this.#running.values()) a.abort();
  }

  /** Cancels everything and waits until the tasks have cleaned up (daemon shutdown). */
  async shutdown(): Promise<void> {
    this.#closing = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.cancelAll('arrêt du daemon');
    await Promise.allSettled([...this.#promises]);
  }

  get active(): number {
    return this.#running.size;
  }

  /** Starts what the parallelism, the quota and STOP allow; re-checks every minute. */
  pump(): void {
    if (this.#closing || this.#d.killswitch.engaged || !this.#d.runner) return;
    while (this.#running.size < this.#d.maxParallel) {
      if (!this.#d.quotaOk()) {
        this.#later();
        return;
      }
      const next = this.#d.store.next();
      if (!next) return;
      const abort = new AbortController();
      this.#running.set(next.id, abort);
      this.#d.store.update(next.id, {
        status: 'running',
        step: 'préparation',
        startedAt: new Date().toISOString(),
      });
      const p = this.#process(next, abort.signal)
        .then(async () => {
          const t = this.#d.store.get(next.id);
          if (t && this.#d.onFinished && !this.#closing)
            await this.#d.onFinished(t).catch(() => undefined);
        })
        .finally(() => {
          this.#running.delete(next.id);
          this.#promises.delete(p);
          this.pump();
        });
      this.#promises.add(p);
    }
  }

  #later(): void {
    this.#timer ??= setTimeout(() => {
      this.#timer = null;
      this.pump();
    }, 60_000);
    this.#timer.unref();
  }

  #locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#repoLocks.get(key) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    this.#repoLocks.set(key, tail);
    void tail.then(() => {
      if (this.#repoLocks.get(key) === tail) this.#repoLocks.delete(key);
    });
    return run;
  }

  #emit(t: Task): Task {
    this.#d.emit({
      id: t.id,
      status: t.status,
      step: t.step,
      title: t.title,
      repo: t.repo,
      prUrl: t.prUrl,
      error: t.error,
    });
    return t;
  }

  #step(t: Task, step: string, signal: AbortSignal): void {
    if (signal.aborted) throw new Stop('annulée');
    this.#emit(this.#d.store.update(t.id, { step }));
  }

  async #process(task: Task, signal: AbortSignal): Promise<void> {
    const d = this.#d;
    const log = fileLogger(d.logsDir, task.id);
    const forge = d.forges.get(task.forge);
    let worktree: string | null = null;
    let repoDir: string | null = null;
    let branch: string | null = null;
    let auth: GitAuth | undefined;
    d.audit.append({
      event: 'intent',
      tool: 'worker',
      level: 1,
      rule: 'worker.start',
      verdict: 'allow',
      data: { id: task.id, repo: task.repo, source: task.source, title: task.title },
    });
    try {
      if (!forge) throw new Error(`${task.forge} n'est plus connecté`);
      const info = await forge.repoInfo(task.repo);
      const base = task.base ?? info.defaultBranch;
      const token = forge.gitToken(task.repo);
      auth = token ? { user: forge.gitUser, token } : undefined;

      // 1. Jarvis's own partial clone (never Brightky's working copies), then a fresh worktree.
      const dir = join(d.dir, 'repos', task.forge, ...task.repo.split('/'));
      repoDir = dir;
      branch = `jarvis/${slug(task.title)}-${task.id}`;
      if (!BRANCH.test(branch) || branch === base) throw new Error(`branche invalide ${branch}`);
      const wt = join(d.dir, 'worktrees', task.id);
      const b = branch;
      const withAuth = { signal, ...(auth && { auth }) };
      // Two workers on the same repository share the clone: its git operations take turns.
      await this.#locked(dir, async () => {
        if (!existsSync(join(dir, '.git'))) {
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          log(`clone ${task.repo}`);
          await d.git.run(
            ['clone', '--filter=blob:none', '--no-checkout', info.cloneUrl, dir],
            withAuth,
          );
        }
        await d.git.run(
          ['fetch', '--prune', info.cloneUrl, `+refs/heads/${base}:refs/remotes/origin/${base}`],
          { cwd: dir, ...withAuth },
        );
        await d.git.run(['worktree', 'add', '-b', b, wt, `origin/${base}`], {
          cwd: dir,
          ...withAuth,
        });
      });
      worktree = wt;
      d.store.update(task.id, { base, branch });

      // 2. The worker codes, guarded tool by tool and sandboxed.
      this.#step(task, 'implémentation', signal);
      const guard = workerGuard({ worktree, home: d.home, extraDeny: d.extraDeny });
      const runner = d.runner;
      if (!runner) throw new Error('aucun token d’abonnement');
      const outcome: WorkerOutcome = await runner.run({
        worktree,
        repo: task.repo,
        branch,
        base,
        task: task.prompt,
        external: task.external,
        model: task.model,
        signal,
        log,
        guard: (tool, input) => {
          const v = guard(tool, input);
          if (!v.allow)
            d.audit.append({
              event: 'result',
              tool: `worker:${tool}`,
              level: 4,
              rule: v.rule,
              verdict: 'deny',
              outcome: 'refused',
              data: { id: task.id, reason: v.reason },
            });
          return v;
        },
      });
      d.store.update(task.id, {
        costUsd: outcome.costUsd,
        turns: outcome.turns,
        summary: outcome.summary,
      });
      if (signal.aborted) throw new Stop('annulée');
      if (!outcome.ok) throw new Error(outcome.error ?? 'le worker a échoué');

      // 3. Checks before anything leaves the Mac.
      this.#step(task, 'vérification', signal);
      await d.git.run(['add', '-A'], { cwd: worktree, signal });
      // One commit, whatever the worker did with git: squash onto the base.
      await d.git.run(['reset', '--soft', `origin/${base}`], { cwd: worktree, signal });
      const files = (
        await d.git.run(['diff', '--cached', '--name-only'], { cwd: worktree, signal })
      )
        .split('\n')
        .filter(Boolean);
      if (files.length === 0) throw new Error('aucun changement produit');
      const bad = files.filter((f) => PROTECTED.some((re) => re.test(f)));
      if (bad.length) throw new Error(`fichiers protégés modifiés : ${bad.join(', ')}`);
      const diff = await d.git.run(['diff', '--cached'], { cwd: worktree, signal });
      if (d.containsSecret(diff))
        throw new Error('un secret apparaît dans le diff : rien n’est publié');

      const clean = (s: string) =>
        s
          .split('\n')
          .filter((l) => !AI_TRAILER.test(l))
          .join('\n')
          .trim();
      const title = clean(outcome.title || task.title).split('\n')[0] || task.title;
      const body = clean(outcome.summary);
      await d.git.run(['commit', '--no-verify', '-m', title, ...(body ? ['-m', body] : [])], {
        cwd: worktree,
        signal,
      });
      const message = await d.git.run(['log', '-1', '--format=%B'], { cwd: worktree, signal });
      if (AI_TRAILER.test(message)) throw new Error('le message de commit contient une mention IA');

      // 4. Publish: a jarvis/… branch, then a pull request (never a merge).
      this.#step(task, 'publication', signal);
      await d.git.run(['push', info.cloneUrl, `HEAD:refs/heads/${branch}`], {
        cwd: worktree,
        signal,
        ...(auth && { auth }),
      });
      const pr = await forge.openChange({
        repo: task.repo,
        head: branch,
        base,
        title,
        draft: d.draftPr,
        body: [
          body || title,
          outcome.tests ? `\n### Vérifications\n${clean(outcome.tests)}` : '',
          `\n---\nTâche : ${task.prompt.slice(0, 500)}`,
        ].join('\n'),
      });
      log(`PR ${pr.url}`);
      d.audit.append({
        event: 'result',
        tool: 'worker',
        level: 1,
        rule: 'worker.pr',
        outcome: 'ok',
        data: {
          id: task.id,
          repo: task.repo,
          branch,
          pr: pr.url,
          files: files.length,
          costUsd: outcome.costUsd,
        },
      });
      this.#emit(
        d.store.update(task.id, {
          status: 'done',
          step: 'PR ouverte',
          prUrl: pr.url,
          endedAt: new Date().toISOString(),
        }),
      );
    } catch (e) {
      const stopped = e instanceof Stop || signal.aborted;
      const error = stopped ? 'annulée' : (e as Error).message.slice(0, 500);
      log(`✗ ${error}`);
      d.audit.append({
        event: 'result',
        tool: 'worker',
        level: 1,
        rule: 'worker.failed',
        outcome: stopped ? 'cancelled' : 'error',
        data: { id: task.id, error },
      });
      this.#emit(
        d.store.update(task.id, {
          status: stopped ? 'cancelled' : 'failed',
          step: stopped ? 'annulée' : 'échec',
          error,
          endedAt: new Date().toISOString(),
        }),
      );
    } finally {
      if (worktree && repoDir) {
        const [dir, wt, b] = [repoDir, worktree, branch];
        await this.#locked(dir, async () => {
          await d.git
            .run(['worktree', 'remove', '--force', wt], { cwd: dir })
            .catch(() => undefined);
          if (b) await d.git.run(['branch', '-D', b], { cwd: dir }).catch(() => undefined);
        });
      }
    }
  }

  log(id: string, lines: number): string {
    const p = join(this.#d.logsDir, `${id}.log`);
    if (!existsSync(p)) return '';
    return readFileSync(p, 'utf8').split('\n').slice(-lines).join('\n');
  }
}
