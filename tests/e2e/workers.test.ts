import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Reply } from '../../apps/jarvisd/src/ipc.ts';
import type {
  WorkerOutcome,
  WorkerRun,
  WorkerRunner,
} from '../../apps/jarvisd/src/workers/runner.ts';
import { type Harness, startHarness } from './harness.ts';

/** Stands in for Claude Code: edits the worktree through the same guard, then reports. */
class ScriptedRunner implements WorkerRunner {
  script: (r: WorkerRun) => Promise<WorkerOutcome> = async () => ({
    ok: false,
    title: '',
    summary: '',
    tests: '',
    costUsd: 0,
    turns: 0,
    error: 'no script',
  });
  readonly runs: WorkerRun[] = [];
  async run(r: WorkerRun) {
    this.runs.push(r);
    return this.script(r);
  }
}

const done = (
  title: string,
  summary = 'Ajoute la fonction.',
  extra: Partial<WorkerOutcome> = {},
): WorkerOutcome => ({
  ok: true,
  title,
  summary,
  tests: 'pnpm test : 12 tests OK',
  costUsd: 0.42,
  turns: 9,
  ...extra,
});

function write(r: WorkerRun, rel: string, content: string): boolean {
  const file = join(r.worktree, rel);
  if (!r.guard('Write', { file_path: file, content }).allow) return false;
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content);
  return true;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    '/usr/bin/git',
    ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', ...args],
    { cwd, encoding: 'utf8' },
  ).trim();

/** A bare repository playing GitHub, with one commit on main. */
function makeOrigin(h: Harness): string {
  const bare = join(h.home, '..', 'origin.git');
  const seed = join(h.home, '..', 'seed');
  execFileSync('/usr/bin/git', ['init', '--bare', '-b', 'main', bare]);
  mkdirSync(seed, { recursive: true });
  git(seed, 'init', '-b', 'main');
  writeFileSync(join(seed, 'README.md'), '# app\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-m', 'init');
  git(seed, 'push', bare, 'main');
  h.forge.remotes.set('acme/app', bare);
  return bare;
}

let h: Harness;
let runner: ScriptedRunner;
afterEach(async () => {
  await h.close();
});

async function setup() {
  runner = new ScriptedRunner();
  h = await startHarness({ workerRunner: runner });
  return makeOrigin(h);
}

const text = (events: Reply[]) => events.map((e) => (e.type === 'text' ? e.text : '')).join('');
async function ask(script: string) {
  const c = await h.rpc();
  const r = await c.call({ cmd: 'ask', text: script });
  c.close();
  return text(r.events);
}
async function until(id: string, status: string[], timeoutMs = 20_000) {
  const t0 = Date.now();
  for (;;) {
    const t = h.rt.workers.store.get(id);
    if (t && status.includes(t.status)) return t;
    if (Date.now() - t0 > timeoutMs) throw new Error(`task ${id} stuck in ${t?.status}/${t?.step}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const lastId = () => h.rt.workers.store.list(1)[0]?.id ?? '';

describe('workers (S6)', () => {
  it("task → worktree → one clean commit in Brightky's name → jarvis/ branch → PR, no approval", async () => {
    const bare = await setup();
    runner.script = async (r) => {
      write(r, 'src/hello.ts', 'export const hello = () => "bonjour";\n');
      // A worker that commits on its own, with an AI trailer: Jarvis squashes and cleans.
      execFileSync('/usr/bin/git', ['add', '-A'], { cwd: r.worktree });
      execFileSync(
        '/usr/bin/git',
        [
          '-c',
          'user.name=Worker',
          '-c',
          'user.email=worker@example.com',
          'commit',
          '-m',
          'wip\n\nCo-Authored-By: Claude <noreply@anthropic.com>',
        ],
        { cwd: r.worktree },
      );
      return done(
        'Ajoute la fonction hello',
        'Ajoute `hello()`.\n\nCo-Authored-By: Claude <noreply@anthropic.com>',
      );
    };
    const out = await ask(
      'call worker_start {"repo":"acme/app","task":"Ajoute une fonction hello qui dit bonjour"}',
    );
    expect(out).toMatch(/OK Tâche [a-f0-9]{8} en file/);
    expect(h.rt.approvals.pending()).toHaveLength(0);
    const t = await until(lastId(), ['done', 'failed']);
    expect(t).toMatchObject({
      status: 'done',
      prUrl: 'https://github.com/acme/app/pull/41',
      base: 'main',
    });
    expect(t.branch).toMatch(/^jarvis\/ajoute-une-fonction-hello[a-z-]*-[a-f0-9]{8}$/);

    const pr = h.forge.opened[0];
    expect(pr).toMatchObject({
      repo: 'acme/app',
      head: t.branch,
      base: 'main',
      title: 'Ajoute la fonction hello',
      draft: false,
    });
    expect(pr?.body).toContain('pnpm test : 12 tests OK');
    expect(pr?.body).not.toMatch(/claude|anthropic|generated/i);

    const log = git(bare, 'log', '--format=%an <%ae>|%s|%b', `refs/heads/${t.branch}`, '-n', '2');
    const [head, parent] = log.split('\n\n').length > 1 ? log.split('\n\n') : log.split('\n');
    expect(head).toContain('Brightky Test <brightky@example.com>|Ajoute la fonction hello|');
    expect(log).not.toMatch(/co-authored|claude/i);
    expect(parent ?? log).toContain('init');
    expect(git(bare, 'show', `${t.branch}:src/hello.ts`)).toContain('bonjour');
    expect(git(bare, 'rev-parse', 'main')).toBe(git(bare, 'rev-parse', `${t.branch}~1`));
    // The worktree is gone; the log stays.
    expect(existsSync(runner.runs[0]?.worktree ?? '')).toBe(false);
    expect(await ask(`call worker_log {"id":"${t.id}"}`)).toContain(
      'PR https://github.com/acme/app/pull/41',
    );
  });

  it('CI files are refused to the worker; a secret in the diff stops the push', async () => {
    const bare = await setup();
    runner.script = async (r) => {
      expect(write(r, '.github/workflows/ci.yml', 'on: push')).toBe(false);
      write(
        r,
        'src/config.ts',
        'export const token = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";\n',
      );
      return done('Configure le token');
    };
    await ask('call worker_start {"repo":"acme/app","task":"Configure le client avec le token"}');
    const t = await until(lastId(), ['done', 'failed']);
    expect(t.status).toBe('failed');
    expect(t.error).toContain('secret');
    expect(git(bare, 'branch', '--list', 'jarvis/*')).toBe('');
    expect(h.forge.opened).toHaveLength(0);
    const audit = JSON.stringify(h.rt.audit.query({ limit: 50 }));
    expect(audit).toContain('worker.path.protected');
    expect(audit).not.toContain('ghp_0123456789');
  });

  it('a worker that changes nothing produces no PR', async () => {
    await setup();
    runner.script = async () => done('Rien');
    await ask(
      'call worker_start {"repo":"acme/app","task":"Vérifie que tout va bien dans le dépôt"}',
    );
    expect(await until(lastId(), ['done', 'failed'])).toMatchObject({
      status: 'failed',
      error: 'aucun changement produit',
    });
  });

  it('STOP cancels the running worker and the queue; status lists everything', async () => {
    await setup();
    runner.script = (r) =>
      new Promise((resolve) =>
        r.signal.addEventListener('abort', () =>
          resolve({
            ok: false,
            title: '',
            summary: '',
            tests: '',
            costUsd: 0,
            turns: 0,
            error: 'cancelled',
          }),
        ),
      );
    await ask('call worker_start {"repo":"acme/app","task":"Tâche longue numéro un à faire"}');
    const first = lastId();
    await until(first, ['running']);
    await ask('call worker_start {"repo":"acme/app","task":"Tâche numéro deux en attente"}');
    const second = lastId();
    expect(await ask('call worker_status {}')).toMatch(/en file[\s\S]*en cours/);
    h.rt.stop('test');
    expect((await until(first, ['cancelled', 'failed'])).status).toBe('cancelled');
    expect((await until(second, ['cancelled'])).status).toBe('cancelled');
  });

  it('task text written after reading external content is fenced for the worker', async () => {
    await setup();
    runner.script = async (r) => {
      write(r, 'a.txt', 'x');
      return done('Tâche externe');
    };
    await ask(
      'ingest Carte Trello : ajoute un fichier a.txt\ncall worker_start {"repo":"acme/app","task":"Ajoute un fichier a.txt comme demandé sur la carte"}',
    );
    await until(lastId(), ['done', 'failed']);
    expect(runner.runs[0]?.external).toBe(true);
  });

  it('unknown forge or repo fails cleanly', async () => {
    await setup();
    expect(
      await ask(
        'call worker_start {"repo":"acme/app","task":"Tâche sur GitLab non connecté","forge":"gitlab"}',
      ),
    ).toContain("gitlab n'est pas connecté");
    await ask('call worker_start {"repo":"acme/inconnu","task":"Tâche sur un dépôt inconnu"}');
    expect(await until(lastId(), ['failed'])).toMatchObject({ error: 'no such repo acme/inconnu' });
  });
});
