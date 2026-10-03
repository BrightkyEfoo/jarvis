import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Reply } from '../../apps/jarvisd/src/ipc.ts';
import type {
  WorkerOutcome,
  WorkerRun,
  WorkerRunner,
} from '../../apps/jarvisd/src/workers/runner.ts';
import {
  CHECKOV_IAC,
  FAKE_KEY,
  FAKE_TOKEN,
  type FakeScanners,
  fakeScanners,
  GITLEAKS_RAW,
  makeProject,
  OSV,
  ZIZMOR,
} from '../../apps/jarvisd/test/scanner-fixtures.ts';
import { type Harness, startHarness } from './harness.ts';

// Fake scanners are node scripts: a few hundred ms each on a cold start.
vi.setConfig({ testTimeout: 30_000 });

let fake: FakeScanners;
let clean: FakeScanners;
beforeAll(() => {
  fake = fakeScanners();
  fake.install('gitleaks', GITLEAKS_RAW, { exit: 1 });
  fake.install('osv-scanner', OSV, { exit: 1 });
  fake.install('zizmor', ZIZMOR, { exit: 14 });
  fake.install('checkov', CHECKOV_IAC, { exit: 1 });
  clean = fakeScanners();
  clean.install('gitleaks', []);
});
afterAll(() => {
  fake.cleanup();
  clean.cleanup();
});

let h: Harness;
afterEach(async () => {
  await h.close();
});

const text = (events: Reply[]) => events.map((e) => (e.type === 'text' ? e.text : '')).join('');
async function ask(script: string) {
  const c = await h.rpc();
  const r = await c.call({ cmd: 'ask', text: script });
  c.close();
  return text(r.events);
}

describe('security scanners (ADR-035)', () => {
  it('security_scan through the gate: N0, no approval, fenced and tainting, sorted, no secret anywhere', async () => {
    h = await startHarness({ securityLocate: fake.locate });
    makeProject(join(h.work, 'app'));
    const out = await ask('call security_scan {"path":"app"}');
    expect(out).toContain('OK <external_data source="security_scan">');
    expect(out).toContain(
      'Scan sécurité de ~/jarvis-work/app (secrets, dépendances, CI, IaC, SAST).',
    );
    expect(out).toMatch(
      /\n1\. \[élevé · atteignable \(code appelé\)\] CVE-2021-23337 \/ GHSA-35jh-r3h4-6jhm — lodash 4\.17\.20/,
    );
    expect(out).toContain(
      'Réseau : osv-scanner — noms et versions des paquets envoyés à api.osv.dev',
    );
    expect(out).not.toContain(FAKE_TOKEN);
    expect(out).not.toContain(FAKE_KEY);
    expect(h.rt.brain?.session.tainted).toBe(true);
    expect(h.rt.approvals.pending()).toHaveLength(0);

    const audit = JSON.stringify(h.rt.audit.query({ limit: 50 }));
    expect(audit).toContain('"rule":"security.scan"');
    expect(audit).not.toContain(FAKE_TOKEN);
    expect(audit).not.toContain(FAKE_KEY);
  });

  it('refuses a symlink to ~/.ssh, folders outside the roots, protected paths and local image schemes', async () => {
    h = await startHarness({ securityLocate: fake.locate });
    makeProject(join(h.work, 'app'));
    const before = fake.calls('gitleaks').length;
    expect(await ask('call security_scan {"path":"shortcut"}')).toContain(
      'KO Action refused (N4, rule fs.deny.protected)',
    );
    expect(await ask('call security_scan {"path":".."}')).toContain(
      'KO Action refused (N4, rule fs.outside_roots)',
    );
    expect(await ask('call security_scan {"path":"/etc"}')).toContain('rule fs.deny.protected');
    expect(await ask('call security_scan {"path":"app","image":"file:x"}')).toContain(
      'rule security.image_scheme',
    );
    expect(await ask('call security_scan {"path":"app","image":"--config=x"}')).toContain(
      'rule input.invalid',
    );
    expect(fake.calls('gitleaks')).toHaveLength(before);
    expect(h.rt.brain?.session.tainted).toBe(false);
  });

  it('security_tools: installed versions, install commands for the rest', async () => {
    h = await startHarness({ securityLocate: fake.locate });
    const out = await ask('call security_tools {}');
    expect(out).toContain('OK Scanners de sécurité (catalogue fixe');
    expect(out).toContain('✓ gitleaks 1.2.3');
    expect(out).toContain('✗ trivy — CVE des images (IaC en secours) — brew install trivy');
    expect(out).toContain('Images (au choix) : brew install grype');
  });

  it('without any scanner the answer is an install list, not a clean bill of health', async () => {
    h = await startHarness();
    makeProject(join(h.work, 'app'));
    const out = await ask('call security_scan {"path":"app","checks":["secrets"]}');
    expect(out).toContain('Aucun scanner n’a pu tourner : rien n’a été vérifié.');
    expect(out).toContain('secrets → brew install gitleaks (~8 Mo)');
  });
});

/** Stands in for Claude Code, as in workers.test.ts. */
class ScriptedRunner implements WorkerRunner {
  script: (r: WorkerRun) => Promise<WorkerOutcome> = async () => {
    throw new Error('no script');
  };
  async run(r: WorkerRun) {
    return this.script(r);
  }
}

const done = (title: string): WorkerOutcome => ({
  ok: true,
  title,
  summary: 'Fait.',
  tests: 'pnpm test : OK',
  costUsd: 0.1,
  turns: 3,
  checks: [
    { command: 'pnpm test', ok: true },
    { command: 'pnpm lint', ok: true },
  ],
});

function write(r: WorkerRun, rel: string, content: string): void {
  const file = join(r.worktree, rel);
  if (!r.guard('Write', { file_path: file, content }).allow) throw new Error(`refused ${rel}`);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content);
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    '/usr/bin/git',
    ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', ...args],
    { cwd, encoding: 'utf8' },
  ).trim();

function makeOrigin(): string {
  const bare = join(h.home, '..', 'origin.git');
  const seed = join(h.home, '..', 'seed');
  execFileSync('/usr/bin/git', ['init', '--bare', '-b', 'main', bare]);
  mkdirSync(seed, { recursive: true });
  git(seed, 'init', '-b', 'main');
  writeFileSync(join(seed, 'README.md'), '# app\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-m', 'init');
  git(seed, 'push', '-q', bare, 'main');
  h.forge.remotes.set('acme/app', bare);
  return bare;
}

async function until(id: string, timeoutMs = 20_000) {
  const t0 = Date.now();
  for (;;) {
    const t = h.rt.workers.store.get(id);
    if (t && (t.status === 'done' || t.status === 'failed')) return t;
    if (Date.now() - t0 > timeoutMs) throw new Error(`task ${id} stuck in ${t?.status}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const lastId = () => h.rt.workers.store.list(1)[0]?.id ?? '';

describe('worker PR hygiene (no network, no install)', () => {
  it('new dependencies are flagged at the top of the PR, which stays a draft', async () => {
    const runner = new ScriptedRunner();
    h = await startHarness({ workerRunner: runner, securityLocate: clean.locate });
    makeOrigin();
    runner.script = async (r) => {
      write(
        r,
        'package.json',
        JSON.stringify({
          name: 'app',
          dependencies: { lodahs: '^1.0.0', 'left-pad': 'github:stevemao/left-pad' },
        }),
      );
      return done('Ajoute des utilitaires');
    };
    await ask('call worker_start {"repo":"acme/app","task":"Ajoute des utilitaires de texte"}');
    const t = await until(lastId());
    expect(t.status).toBe('done');
    expect(t.step).toBe(
      'PR en brouillon, vérifiée (2 commandes au vert), 2 dépendance(s) à vérifier',
    );
    const pr = h.forge.opened[0];
    expect(pr?.draft).toBe(true);
    expect(pr?.body).toMatch(
      /^### Nouvelles dépendances \(contrôle local, sans réseau\)\n⚠️ \*\*À vérifier avant de merger :\*\*/,
    );
    expect(pr?.body).toContain(
      '- `lodahs` (npm, package.json) : nom très proche de « lodash » (typosquatting ?)',
    );
    expect(pr?.body).toContain('- `left-pad` (npm, package.json) : source hors registre');
    // gitleaks ran on the added lines and found nothing.
    expect(clean.calls('gitleaks')).toHaveLength(1);
  });

  it('gitleaks stops a secret the token patterns miss: nothing is pushed', async () => {
    const runner = new ScriptedRunner();
    h = await startHarness({ workerRunner: runner, securityLocate: fake.locate });
    const bare = makeOrigin();
    runner.script = async (r) => {
      write(r, 'src/k.ts', `export const k = "${FAKE_KEY}";\n`);
      return done('Ajoute la clé');
    };
    await ask('call worker_start {"repo":"acme/app","task":"Ajoute la clé du service"}');
    const t = await until(lastId());
    expect(t.status).toBe('failed');
    expect(t.error).toBe(
      'gitleaks signale un secret dans le diff (github-pat, generic-api-key) : rien n’est publié',
    );
    expect(git(bare, 'branch', '--list', 'jarvis/*')).toBe('');
    expect(h.forge.opened).toHaveLength(0);
    expect(JSON.stringify(h.rt.audit.query({ limit: 50 }))).not.toContain(FAKE_KEY);
  });
});
