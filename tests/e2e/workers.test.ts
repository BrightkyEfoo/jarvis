import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

// Real git operations (clone, worktree, push) take a few hundred ms each.
vi.setConfig({ testTimeout: 30_000 });

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
/** Asks, approving every confirmation that shows up (Brightky saying yes). */
async function askApproved(script: string) {
  const c = await h.rpc();
  const pending = c.call({ cmd: 'ask', text: script });
  let finished = false;
  void pending.then(() => {
    finished = true;
  });
  const approver = await h.rpc();
  while (!finished) {
    const req = h.rt.approvals.pending()[0];
    if (req) await approver.call({ cmd: 'approve', approvalId: req.id });
    await new Promise((r) => setTimeout(r, 10));
  }
  approver.close();
  c.close();
  return text((await pending).events);
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
    expect(await ask('call worker_status {}')).toMatch(/en cours[\s\S]*en cours/);
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

describe('Trello → workers (S7)', () => {
  it('takes the labelled cards in one confirmation, moves them, then posts the PR link and moves to review', async () => {
    await setup();
    h.trello.desc = 'Ajouter un thème sombre.\nrepo: acme/app';
    runner.script = async (r) => {
      write(r, 'src/theme.ts', 'export const dark = true;\n');
      return done('Ajoute le mode sombre');
    };
    const c = await h.rpc();
    const pending = c.call({ cmd: 'ask', text: 'call trello_take {}' });
    const { FakeTrello } = await import('./harness.ts');
    const req = await (async () => {
      for (let i = 0; i < 200; i++) {
        const r = h.rt.approvals.pending()[0];
        if (r) return r;
        await new Promise((x) => setTimeout(x, 10));
      }
      throw new Error('no approval');
    })();
    expect(req).toMatchObject({ level: 2, rule: 'trello.take' });
    expect(req.summary).toContain('card → En cours, then PR link + card → À relire');
    await (await h.rpc()).call({ cmd: 'approve', approvalId: req.id });
    const out = text((await pending).events);
    expect(out).toContain('1 carte(s) confiée(s) aux workers :');
    expect(out).toMatch(
      /« Mode sombre » → acme\/app \(tâche [a-f0-9]{8}\), carte dans « En cours »/,
    );
    expect(h.trello.moves[0]).toEqual({ id: FakeTrello.CARD, list: FakeTrello.DOING });

    const t = await until(lastId(), ['done', 'failed']);
    expect(t).toMatchObject({
      status: 'done',
      source: `trello:${FakeTrello.CARD}`,
      external: true,
    });
    expect(runner.runs[0]?.task).toContain('Ajouter un thème sombre.');
    expect(runner.runs[0]?.task).not.toContain('repo: acme/app');
    for (let i = 0; i < 100 && h.trello.comments.length === 0; i++)
      await new Promise((x) => setTimeout(x, 20));
    expect(h.trello.comments).toEqual([
      { id: FakeTrello.CARD, text: 'PR : https://github.com/acme/app/pull/41' },
    ]);
    expect(h.trello.moves.at(-1)).toEqual({ id: FakeTrello.CARD, list: FakeTrello.REVIEW });

    // Already taken: not taken twice.
    expect(await askApproved('call trello_take {}')).toContain(
      'Aucune nouvelle carte étiquetée « jarvis »',
    );
    c.close();
  });

  it('cards without a repository are skipped with the fix', async () => {
    await setup();
    h.trello.desc = 'Pas de dépôt ici';
    const c = await h.rpc();
    const pending = c.call({ cmd: 'ask', text: 'call trello_take {}' });
    for (let i = 0; i < 200 && h.rt.approvals.pending().length === 0; i++)
      await new Promise((x) => setTimeout(x, 10));
    await (await h.rpc()).call({
      cmd: 'approve',
      approvalId: h.rt.approvals.pending()[0]?.id ?? '',
    });
    const out = text((await pending).events);
    expect(out).toContain('Aucune carte confiée.');
    expect(out).toContain('pas de dépôt — ajoute « repo: owner/repo »');
    expect(h.trello.moves).toHaveLength(0);
    c.close();
  });

  it('runs two workers in parallel (workers.max_parallel: 2)', async () => {
    await setup();
    let started = 0;
    let release: () => void = () => undefined;
    const both = new Promise<void>((r) => {
      release = r;
    });
    runner.script = async (r) => {
      started += 1;
      if (started === 2) release();
      await both;
      write(r, `f${started}.txt`, 'x');
      return done('Parallèle');
    };
    await ask('call worker_start {"repo":"acme/app","task":"Première tâche en parallèle"}');
    await ask('call worker_start {"repo":"acme/app","task":"Seconde tâche en parallèle"}');
    await both;
    expect(started).toBe(2);
    const ids = h.rt.workers.store.list(2).map((t) => t.id);
    for (const id of ids) expect((await until(id, ['done', 'failed'])).status).toBe('done');
    expect(h.forge.opened).toHaveLength(2);
  });
});
