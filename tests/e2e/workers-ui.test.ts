import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KillSwitch } from '@jarvis/policy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Git } from '../../apps/jarvisd/src/workers/git.ts';
import { WorkerManager } from '../../apps/jarvisd/src/workers/manager.ts';
import { ProofRecorder } from '../../apps/jarvisd/src/workers/proof.ts';
import type {
  WorkerOutcome,
  WorkerRun,
  WorkerRunner,
} from '../../apps/jarvisd/src/workers/runner.ts';
import { TaskStore } from '../../apps/jarvisd/src/workers/store.ts';
import { detectUi, fsProbe, type UiChecksPolicy } from '../../apps/jarvisd/src/workers/ui.ts';
import { FakeForge } from './harness.ts';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64),
]);

vi.setConfig({ testTimeout: 30_000 });

class ScriptedRunner implements WorkerRunner {
  script: (r: WorkerRun) => Promise<WorkerOutcome> = async () => {
    throw new Error('no script');
  };
  readonly runs: WorkerRun[] = [];
  async run(r: WorkerRun) {
    this.runs.push(r);
    return this.script(r);
  }
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    '/usr/bin/git',
    ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', ...args],
    { cwd, encoding: 'utf8' },
  ).trim();

let base: string;
let stopped: (() => Promise<void>) | null = null;
afterEach(async () => {
  await stopped?.();
  stopped = null;
  rmSync(base, { recursive: true, force: true });
});

/** A Vite app on a bare repository playing GitHub, and a manager with the UI policy given. */
function setup(uiChecks: UiChecksPolicy, packageJson: object = { devDependencies: { vite: '7' } }) {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'jvu-')));
  const home = join(base, 'h');
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, '.gitconfig'),
    '[user]\n\tname = Brightky Test\n\temail = b@example.com\n',
  );
  const bare = join(base, 'origin.git');
  const seed = join(base, 'seed');
  execFileSync('/usr/bin/git', ['init', '--bare', '-b', 'main', bare]);
  mkdirSync(seed);
  git(seed, 'init', '-b', 'main');
  writeFileSync(join(seed, 'package.json'), JSON.stringify(packageJson));
  git(seed, 'add', '-A');
  git(seed, 'commit', '-m', 'init');
  git(seed, 'push', bare, 'main');

  const forge = new FakeForge();
  forge.remotes.set('acme/web', bare);
  const runner = new ScriptedRunner();
  const audit: { rule?: string; data?: unknown }[] = [];
  const logsDir = join(base, 'logs');
  const dir = join(home, 'jarvis-work', '.jarvis-workers');
  const store = new TaskStore(join(base, 'tasks.db'));
  const manager = new WorkerManager({
    store,
    git: new Git({ env: { HOME: home } }),
    runner,
    forges: new Map([['github', forge]]),
    audit: { append: (e) => audit.push(e) },
    killswitch: new KillSwitch(join(base, 'STOP')),
    containsSecret: () => false,
    emit: () => undefined,
    home,
    dir,
    logsDir,
    extraDeny: [],
    maxParallel: 1,
    draftPr: false,
    quotaOk: () => true,
    uiChecks,
    // Real detection on the worktree; only Chrome's presence is faked (no browser in tests).
    detectUi: (w) => detectUi(w, home, { ...fsProbe, exists: (p) => p === CHROME }),
  });
  stopped = () => manager.shutdown();
  const run = async (task: string) => {
    const t = manager.enqueue({
      forge: 'github',
      repo: 'acme/web',
      task,
      source: 'test',
      external: false,
      model: 'm',
    });
    for (let i = 0; i < 800; i++) {
      const cur = store.get(t.id);
      if (cur && ['done', 'failed', 'cancelled'].includes(cur.status)) return cur;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('task stuck');
  };
  return { forge, runner, audit, logsDir, dir, bare, run };
}

const ON: UiChecksPolicy = { enabled: true, ports: [5173], widths: [375, 1280] };

/** What the worker would really run: the commands go through the guard and the proof hooks. */
function worker(r: WorkerRun, opts: { writePng: boolean }): WorkerOutcome {
  const ui = r.ui;
  if (!ui) throw new Error('no ui');
  const proof = new ProofRecorder();
  const bash = (command: string, ok: boolean) => {
    const v = r.guard('Bash', { command });
    if (!v.allow) throw new Error(`refused: ${command} (${v.reason})`);
    proof.bash(command, ok);
  };
  writeFileSync(join(r.worktree, 'App.tsx'), 'export const App = () => null;\n');
  proof.tool('Write');
  bash('pnpm test', true);
  for (const w of ui.widths) {
    const file = join(ui.dir, `home-${w}.png`);
    bash(
      `"${CHROME}" --headless=new --user-data-dir=${join(ui.dir, 'profile')} --window-size=${w},800 --screenshot=${file} http://127.0.0.1:5173/`,
      true,
    );
    if (opts.writePng) writeFileSync(file, PNG);
  }
  // Leftovers a browser test run may leave in the repository.
  mkdirSync(join(r.worktree, 'test-results'), { recursive: true });
  writeFileSync(join(r.worktree, 'test-results', 'failure.png'), PNG);
  return {
    ok: true,
    title: 'Ajoute la page d’accueil',
    summary: 'Ajoute `App`.',
    tests: 'pnpm test OK ; captures 375 et 1280',
    costUsd: 0.1,
    turns: 3,
    ...proof.result(),
  };
}

describe('workers: browser checks of a web frontend (ADR-036)', () => {
  it('on: the worker gets the task folder, the PR gets "Interface vérifiée", screenshots stay out of git', async () => {
    const s = setup(ON);
    s.runner.script = async (r) => {
      // The guard handed to the worker knows the loopback ports and the folder.
      expect(
        r.guard('Bash', { command: `"${CHROME}" --headless=new https://example.com` }).allow,
      ).toBe(false);
      expect(r.guard('Bash', { command: 'pnpm exec vite --host 0.0.0.0' }).allow).toBe(false);
      expect(r.guard('Read', { file_path: join(r.ui?.dir ?? '', 'home-375.png') }).allow).toBe(
        true,
      );
      return worker(r, { writePng: true });
    };
    const t = await s.run('Ajoute une page d’accueil');
    expect(t.status).toBe('done');
    const r = s.runner.runs[0];
    expect(r?.ui).toMatchObject({
      frameworks: ['Vite'],
      chrome: CHROME,
      ports: [5173],
      widths: [375, 1280],
      dir: join(s.dir, 'ui', t.id),
    });

    const pr = s.forge.opened[0];
    expect(pr?.draft).toBe(false);
    expect(pr?.body).toContain('- ✅ `pnpm test`\n- ✅ captures d’écran : 2/2 produites');
    expect(pr?.body).toContain('### Interface vérifiée');
    expect(pr?.body).toContain('| `127.0.0.1:5173/` | ✅ | ✅ |');
    expect(pr?.body).toContain('Lighthouse n’est pas une dépendance du projet');
    expect(pr?.body).toContain('home-1280.png, home-375.png');
    expect(pr?.body).not.toContain(s.dir);

    // Screenshots next to the task log; the task folder (with the browser profile) is gone.
    expect(readdirSync(join(s.logsDir, `${t.id}-ui`)).sort()).toEqual([
      'home-1280.png',
      'home-375.png',
    ]);
    expect(existsSync(join(s.dir, 'ui', t.id))).toBe(false);
    const files = git(s.bare, 'ls-tree', '-r', '--name-only', t.branch ?? '');
    expect(files.split('\n')).toEqual(['App.tsx', 'package.json']);
    expect(readFileSync(join(s.logsDir, `${t.id}.log`), 'utf8')).toContain(
      'rapports de navigateur écartés du commit : test-results/',
    );
    expect(s.audit.some((e) => e.rule === 'worker.ui')).toBe(true);
  });

  it('a capture Chrome did not really write is red: the PR is a draft', async () => {
    const s = setup(ON);
    s.runner.script = async (r) => worker(r, { writePng: false });
    const t = await s.run('Ajoute une page d’accueil');
    expect(t.step).toBe('PR en brouillon, 2 vérification(s) en échec');
    expect(s.forge.opened[0]?.draft).toBe(true);
    expect(s.forge.opened[0]?.body).toContain('| `127.0.0.1:5173/` | ❌ | ❌ |');
  });

  it('off, or not a web frontend: the worker and the PR are exactly the S6 ones', async () => {
    for (const [policy, pkg] of [
      [{ ...ON, enabled: false }, { devDependencies: { vite: '7' } }],
      [ON, { dependencies: { express: '5' } }],
    ] as const) {
      const s = setup(policy, pkg);
      s.runner.script = async (r) => {
        expect(r.ui).toBeUndefined();
        expect(r.guard('Bash', { command: 'pnpm exec vite --host 0.0.0.0' }).allow).toBe(true);
        writeFileSync(join(r.worktree, 'a.ts'), 'export const a = 1;\n');
        return {
          ok: true,
          title: 'Ajoute a',
          summary: 'Ajoute a.',
          tests: '',
          costUsd: 0,
          turns: 1,
          checks: [{ command: 'pnpm test', ok: true }],
        };
      };
      await s.run('Ajoute une constante a');
      const body = s.forge.opened[0]?.body ?? '';
      expect(body).not.toContain('Interface vérifiée');
      expect(body).toBe(
        'Ajoute a.\n\n### Vérifié par Jarvis\nCommandes réellement exécutées, dernier résultat de chacune :\n- ✅ `pnpm test`\n\n---\nTâche : Ajoute une constante a',
      );
      expect(existsSync(join(s.dir, 'ui'))).toBe(false);
      await stopped?.();
      stopped = null;
      rmSync(base, { recursive: true, force: true });
    }
  });
});
