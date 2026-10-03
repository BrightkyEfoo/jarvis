import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsPolicy, N0, N4, Refusal, Session, type ToolDef } from '@jarvis/policy';
import { Redactor } from '@jarvis/secrets';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ARGV, type ScannerId } from '../src/security/catalogue.ts';
import {
  type Finding,
  parseCheckov,
  parseGitleaks,
  parseGrype,
  parseJson,
  parseOsv,
  parseSemgrep,
  parseTrivy,
  parseZizmor,
  pickFix,
} from '../src/security/parse.ts';
import {
  depsMarkdown,
  diffSecretScanner,
  editDistance,
  lookalike,
  newDependencies,
} from '../src/security/pr-checks.ts';
import { binaryLocator, versionOf } from '../src/security/run.ts';
import { planScan, rankFindings, summarize } from '../src/security/scan.ts';
import { createSecurityTools } from '../src/tools/security.ts';
import {
  CHECKOV_EMPTY,
  CHECKOV_GITLAB,
  CHECKOV_IAC,
  FAKE_KEY,
  FAKE_TOKEN,
  type FakeScanners,
  fakeScanners,
  GITLEAKS_RAW,
  GITLEAKS_REDACTED,
  GRYPE,
  makeProject,
  OSV,
  SEMGREP,
  TRIVY_CONFIG,
  TRIVY_IMAGE,
  ZIZMOR,
} from './scanner-fixtures.ts';

const ROOT = '/Users/b/jarvis-work/app';
const sub = (doc: unknown) => JSON.parse(JSON.stringify(doc).replaceAll('__ROOT__', ROOT));
const ctx = (check: Finding['check'] = 'secrets', secrets: string[] = []) => ({
  root: ROOT,
  check,
  secret: (v: string) => secrets.push(v),
});

// Fake scanners are real processes: give them room when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 20_000 });

describe('parsers (one per scanner, fixtures shaped like the real reports)', () => {
  it('gitleaks: rule, file:line, never the value; raw values are registered for scrubbing', () => {
    const seen: string[] = [];
    const [f] = parseGitleaks(sub(GITLEAKS_REDACTED), ctx('secrets', seen));
    expect(f).toMatchObject({
      tool: 'gitleaks',
      severity: 'high',
      rule: 'github-pat',
      file: 'src/config.ts',
      line: 1,
    });
    expect(f?.message).toContain('(valeur masquée)');
    expect(seen).toEqual([]);

    const raw = parseGitleaks(sub(GITLEAKS_RAW), ctx('secrets', seen));
    expect(raw).toHaveLength(2);
    expect(seen).toEqual(expect.arrayContaining([FAKE_TOKEN, FAKE_KEY]));
    // Match and Line are never copied.
    expect(JSON.stringify(raw)).not.toContain(FAKE_TOKEN);
  });

  it('osv-scanner: one finding per alias group, CVSS severity, fix for the installed version, reachability', () => {
    const fs = parseOsv(sub(OSV), ctx('dependencies'));
    expect(fs).toHaveLength(3);
    expect(fs[0]).toMatchObject({
      severity: 'high',
      rule: 'CVE-2021-23337 / GHSA-35jh-r3h4-6jhm',
      file: 'package-lock.json',
      message: 'lodash 4.17.20 (npm) : Command Injection in lodash',
      fix: 'corrigé en 4.17.21',
      signals: ['reachable'],
    });
    expect(fs[1]).toMatchObject({
      severity: 'critical',
      fix: 'corrigé en 1.2.6',
      signals: ['dev_only'],
    });
    expect(fs[2]).toMatchObject({
      severity: 'medium',
      rule: 'CVE-2023-3978 / GHSA-2wrh-6pvc-2jm9',
      signals: ['unreachable'],
    });
    expect(pickFix('1.2.0', ['0.2.4', '1.2.6'])).toEqual(['1.2.6']);
    expect(pickFix('9.0.0', ['1.0.0', '2.0.0'])).toEqual(['1.0.0', '2.0.0']);
  });

  it('zizmor: 1-based lines, ignored findings dropped, attacker-reachable audits marked exposed', () => {
    const fs = parseZizmor(sub(ZIZMOR), ctx('ci'));
    expect(fs).toHaveLength(2);
    expect(fs[0]).toMatchObject({
      severity: 'high',
      rule: 'template-injection',
      file: '.github/workflows/ci.yml',
      line: 15,
      signals: ['exposed'],
      fix: 'https://docs.zizmor.sh/audits/#template-injection',
    });
    expect(fs[0]?.message).toBe(
      'code injection via template expansion : may expand into attacker-controllable code',
    );
    expect(fs[1]).toMatchObject({ severity: 'medium', rule: 'unpinned-uses', line: 6 });
  });

  it('checkov: array of reports, single report or bare summary; null severity stays unknown', () => {
    const fs = parseCheckov(sub(CHECKOV_IAC), ctx('iac'));
    expect(fs.map((f) => [f.rule, f.file, f.line])).toEqual([
      ['CKV_AWS_20', 'infra/main.tf', 1],
      ['CKV_AWS_18', 'infra/main.tf', 1],
      ['CKV_DOCKER_3', 'Dockerfile', 1],
    ]);
    expect(fs[0]).toMatchObject({ severity: 'unknown', signals: ['exposed'] });
    expect(fs[0]?.message).toContain('(aws_s3_bucket.data)');
    expect(JSON.stringify(fs)).not.toContain(FAKE_KEY); // code_block is never read
    expect(parseCheckov(sub(CHECKOV_GITLAB), ctx('ci'))[0]).toMatchObject({
      rule: 'CKV_GITLABCI_1',
      file: '.gitlab-ci.yml',
      line: 5,
    });
    expect(parseCheckov(CHECKOV_EMPTY, ctx('iac'))).toEqual([]);
  });

  it('trivy: vulnerabilities with fixed versions, failed misconfigurations only', () => {
    const img = parseTrivy(TRIVY_IMAGE, ctx('image'));
    expect(img.map((f) => [f.severity, f.rule, f.fix])).toEqual([
      ['high', 'CVE-2024-6387', 'corrigé en 1:9.2p1-2+deb12u3'],
      ['critical', 'CVE-2023-45853', 'pas de version corrigée connue'],
    ]);
    const conf = parseTrivy(sub(TRIVY_CONFIG), ctx('iac'));
    expect(conf).toHaveLength(1);
    expect(conf[0]).toMatchObject({
      rule: 'AVD-AWS-0092',
      file: 'infra/main.tf',
      line: 2,
      severity: 'high',
      signals: ['exposed'],
    });
  });

  it('grype: CISA KEV means actively exploited', () => {
    const fs = parseGrype(GRYPE, ctx('image'));
    expect(fs[0]).toMatchObject({
      severity: 'critical',
      rule: 'CVE-2021-44228',
      message: 'log4j-core 2.14.1 (java-archive)',
      fix: 'corrigé en 2.15.0',
      signals: ['exploited'],
      file: '/app/lib/log4j-core-2.14.1.jar',
    });
    expect(fs[1]).toMatchObject({ severity: 'medium', fix: 'pas de version corrigée connue' });
  });

  it('semgrep/opengrep: severity words, the matched code (extra.lines) is never read', () => {
    const fs = parseSemgrep('opengrep')(sub(SEMGREP), ctx('sast'));
    expect(fs[0]).toMatchObject({
      tool: 'opengrep',
      severity: 'high',
      rule: 'js.eval-injection',
      file: 'src/server.js',
      line: 12,
    });
    expect(JSON.stringify(fs)).not.toContain(FAKE_KEY);
  });

  it('JSON: tolerates a banner before the document, rejects garbage', () => {
    expect(parseJson('checkov 3.2 update available\n[{"a":1}]')).toEqual([{ a: 1 }]);
    expect(() => parseJson('')).toThrow('sortie vide');
    expect(() => parseJson('panic: oops')).toThrow('illisible');
  });

  it('every argv puts flags before the target and never asks for network rules', () => {
    expect(ARGV.gitleaks('/p')).toEqual([
      'dir',
      '--report-format',
      'json',
      '--report-path',
      '-',
      '--redact',
      '--no-banner',
      '/p',
    ]);
    expect(ARGV.osvScanner('/p', true).at(-1)).toBe('/p');
    expect(ARGV.osvScanner('/p', true)).toContain('--offline');
    expect(ARGV.zizmor('/p')).toContain('--offline');
    expect(ARGV.checkov('/p', ['gitlab_ci'])).toContain('--skip-download');
    expect(ARGV.trivyImage('nginx:1', false).slice(-2)).toEqual(['--', 'nginx:1']);
    expect(ARGV.semgrep('/p/.semgrep.yml', '/p')).not.toContain('auto');
  });
});

describe('project config', () => {
  it("checkov is not run on a project that ships a .checkov.yml (it could load the project's Python)", () => {
    const root = mkdtempSync(join(tmpdir(), 'ckv-'));
    writeFileSync(join(root, '.checkov.yml'), 'external-checks-dir: [checks]\n');
    const plan = planScan({ root, checks: ['iac'], image: null, offline: true }, (id) =>
      id === 'checkov' ? '/opt/homebrew/bin/checkov' : null,
    );
    expect(plan.invocations).toHaveLength(0);
    expect(plan.skipped[0]?.reason).toMatch(/\.checkov\.yml/);
  });
});

describe('ranking and summary', () => {
  const f = (o: Partial<Finding>): Finding => ({
    tool: 'osv-scanner',
    check: 'dependencies',
    severity: 'medium',
    rule: 'R',
    file: null,
    line: null,
    message: 'm',
    fix: null,
    signals: [],
    ...o,
  });

  it('severity first, adjusted by about one level for reachability, exposure and KEV', () => {
    const ranked = rankFindings([
      f({ rule: 'crit-unreachable', severity: 'critical', signals: ['unreachable'] }),
      f({ rule: 'high', severity: 'high' }),
      f({ rule: 'high-reachable', severity: 'high', signals: ['reachable'] }),
      f({ rule: 'crit', severity: 'critical' }),
      f({ rule: 'high-kev', severity: 'high', signals: ['exploited'] }),
      f({ rule: 'low', severity: 'low' }),
      f({ rule: 'low', severity: 'low' }),
    ]);
    expect(ranked.map((x) => x.rule)).toEqual([
      'high-kev',
      'crit',
      'high-reachable',
      'crit-unreachable',
      'high',
      'low',
    ]);
  });

  it('is bounded: findings beyond the cap are counted, not listed', () => {
    const many = Array.from({ length: 120 }, (_, i) => f({ rule: `R${i}`, severity: 'low' }));
    const text = summarize({
      target: '~/x',
      checks: ['dependencies'],
      runs: [
        {
          tool: 'osv-scanner',
          check: 'dependencies',
          status: 'ok',
          ms: 1200,
          count: 120,
          detail: null,
          network: 'noms et versions envoyés à api.osv.dev',
        },
      ],
      skipped: [],
      findings: many,
      maxFindings: 10,
    });
    expect(text).toContain('120 problèmes : 120 faibles.');
    expect(text).toContain('… et 110 autre(s) non listé(s) : 110 faibles.');
    expect(text).toContain('Réseau : osv-scanner — noms et versions envoyés à api.osv.dev.');
    expect(text.length).toBeLessThan(8000);
  });
});

describe('pr checks (no network, no install)', () => {
  it('new npm dependencies: outside the registry, unbounded, lookalike, never installed', () => {
    const before = JSON.stringify({ dependencies: { zod: '^4.0.0' } });
    const after = JSON.stringify({
      dependencies: {
        zod: '^4.0.0',
        lodahs: '^1.0.0',
        'left-pad': 'github:stevemao/left-pad',
        chalk: '*',
        dayjs: '^1.11.0',
        '@acme/ui': 'workspace:*',
      },
    });
    const lock =
      "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      dayjs:\n        specifier: ^1.11.0\n      chalk:\n      left-pad:\n";
    const r = newDependencies([{ path: 'package.json', before, after }], () => [lock]);
    expect(r.deps.map((d) => d.name)).toEqual(['lodahs', 'left-pad', 'chalk', 'dayjs', '@acme/ui']);
    const reasons = r.warnings.map((w) => `${w.dep.name}: ${w.reason}`);
    expect(reasons).toEqual([
      'lodahs: nom très proche de « lodash » (typosquatting ?)',
      'lodahs: absente du lockfile : jamais installée (nom inventé ?)',
      'left-pad: source hors registre (github:stevemao/left-pad) : aucun contrôle du registre',
      'chalk: version non bornée (*) : la prochaine version s’installera seule',
    ]);
    const md = depsMarkdown(r);
    expect(md).toMatch(/^### Nouvelles dépendances \(contrôle local, sans réseau\)\n⚠️/);
    expect(md).toContain('Ajoutées : `lodahs` ^1.0.0, `left-pad` github:stevemao/left-pad');
    expect(depsMarkdown(newDependencies([], () => []))).toBe('');
  });

  it('requirements and go.mod: index changes, editable installs, replace directives, typos', () => {
    const r = newDependencies(
      [
        {
          path: 'api/requirements.txt',
          before: 'flask==3.0.0\n',
          after:
            'flask==3.0.0\nreqeusts==2.32.0\n--extra-index-url https://pkgs.example.com/simple\n-e git+https://github.com/x/y.git#egg=y\nhttpx>=0.27\n',
        },
        {
          path: 'go.mod',
          before: 'module x\n\nrequire (\n\tgithub.com/a/b v1.0.0\n)\n',
          after:
            'module x\n\nrequire (\n\tgithub.com/a/b v1.0.0\n\tgithub.com/c/d v0.3.1\n\tgolang.org/x/text v0.14.0 // indirect\n)\n\nreplace github.com/a/b => ../b\n',
        },
      ],
      () => [],
    );
    expect(r.deps.map((d) => `${d.ecosystem}:${d.name}`)).toEqual([
      'pypi:reqeusts',
      'pypi:httpx',
      'go:github.com/c/d',
    ]);
    expect(r.warnings.map((w) => w.reason)).toEqual([
      'nom très proche de « requests » (typosquatting ?)',
      'index de paquets ajouté : risque de confusion de dépendances',
      'installation éditable depuis un chemin ou un dépôt',
      'directive replace : module remplacé par un fork ou un chemin local',
    ]);
  });

  it('version bumps are not new dependencies; a bare URL is an outside source (review L8/L9)', () => {
    const r = newDependencies(
      [
        {
          path: 'requirements.txt',
          before: 'requests==2.0\nDjango==4.2\n',
          after: 'requests==2.1\ndjango==5.0\nhttps://evil.example/pkg.whl\nfile:///tmp/x.whl\n',
        },
        {
          path: 'go.mod',
          before: 'module x\n\nrequire github.com/a/b v1.0.0\n',
          after: 'module x\n\nrequire github.com/a/b v1.1.0\n',
        },
      ],
      () => [],
    );
    expect(r.deps.map((d) => d.name)).toEqual([
      'https://evil.example/pkg.whl',
      'file:///tmp/x.whl',
    ]);
    expect(r.warnings.map((w) => w.reason)).toEqual([
      'source hors registre (https://evil.example/pkg.whl)',
      'source hors registre (file:///tmp/x.whl)',
    ]);
  });

  it('lookalikes: typos and separator games, not the popular names themselves', () => {
    expect(editDistance('lodash', 'lodahs')).toBe(1);
    expect(lookalike('npm', 'expres')).toBe('express');
    expect(lookalike('npm', 'lo-dash')).toBe('lodash');
    expect(lookalike('npm', 'preact')).toBeNull();
    expect(lookalike('npm', '@types/react')).toBeNull();
    expect(lookalike('pypi', 'py_yaml')).toBe('pyyaml');
    expect(lookalike('npm', 'fastest-validator')).toBeNull();
  });
});

// Fake executables in a temp dir, a real FsPolicy, the real tools: everything but the scanners.
describe('security tools against fake scanner binaries', () => {
  let base: string;
  let home: string;
  let work: string;
  let project: string;
  let fs: FsPolicy;
  let fake: FakeScanners;
  const fakes: FakeScanners[] = [];

  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'jarvis-sec-')));
    home = join(base, 'h');
    work = join(home, 'jarvis-work');
    project = makeProject(join(work, 'app'));
    mkdirSync(join(home, '.ssh'), { recursive: true });
    writeFileSync(join(home, '.ssh', 'id_ed25519'), 'PRIVATE');
    symlinkSync(join(home, '.ssh'), join(work, 'keys'));
    mkdirSync(join(work, '.env.d'), { recursive: true });
    fs = new FsPolicy({ home, readRoots: [work], writeRoots: [work], extraDeny: [] });
  });
  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
    for (const f of fakes) f.cleanup();
  });

  const tools = (
    o: { timeoutMs?: number; readRoots?: string[]; locate?: FakeScanners['locate'] } = {},
  ) => {
    const policy = o.readRoots
      ? new FsPolicy({ home, readRoots: o.readRoots, writeRoots: [work], extraDeny: [] })
      : fs;
    const redactor = new Redactor();
    const list = createSecurityTools({
      fs: policy,
      home,
      locate: o.locate ?? fake.locate,
      redact: (s) => redactor.redact(s),
      timeoutMs: o.timeoutMs ?? 20_000,
    });
    const get = (name: string) => list.find((t) => t.name === name) as ToolDef;
    const call = async (name: string, args: Record<string, unknown>) => {
      const t = get(name);
      const c = { session: new Session('user'), signal: new AbortController().signal, cwd: work };
      const parsed = z.object(t.input).strict().parse(args);
      const classification = t.classify(parsed, c);
      if (classification.level >= N4) return { classification, text: null };
      const out = await t.run(parsed, { ...c, classification });
      return { classification, text: typeof out === 'string' ? out : out.text };
    };
    return { get, call };
  };

  const installAll = () => {
    fake = fakeScanners();
    fakes.push(fake);
    fake.install('gitleaks', GITLEAKS_RAW, { exit: 1 });
    fake.install('osv-scanner', OSV, { exit: 1 });
    fake.install('zizmor', ZIZMOR, { exit: 13 });
    fake.install(
      'checkov',
      { __byArg: { terraform: CHECKOV_IAC, gitlab_ci: CHECKOV_GITLAB } },
      { exit: 1 },
    );
  };

  it('runs the fixed argv, sorts by severity and signals, and never prints a secret', async () => {
    installAll();
    process.env.JARVIS_TEST_LEAK = 'must-not-reach-scanners';
    try {
      const { classification, text } = await tools().call('security_scan', { path: 'app' });
      expect(classification).toMatchObject({ level: N0, rule: 'security.scan' });
      expect(text).not.toBeNull();
      const out = text ?? '';
      // Secrets: neither the token (redactor pattern) nor the key (known only from the report).
      expect(out).not.toContain(FAKE_TOKEN);
      expect(out).not.toContain(FAKE_KEY);
      expect(out).toContain('[secret masqué]');
      expect(out).toContain(
        'Scan sécurité de ~/jarvis-work/app (secrets, dépendances, CI, IaC, SAST).',
      );
      expect(out).toContain(
        '10 problèmes : 1 critique, 4 élevés, 2 moyens, 3 de gravité inconnue.',
      );
      expect(out).toContain(
        'Signaux : 1 atteignable(s), 2 exposée(s), 1 non appelée(s) par le code, 1 en dépendance de dev.',
      );
      expect(out).toContain(
        'Réseau : osv-scanner — noms et versions des paquets envoyés à api.osv.dev (jamais le code) ; offline: true pour la base locale.',
      );
      expect(out).toContain('Non lancé : SAST — aucun jeu de règles local');
      const lines = out.split('\n').filter((l) => /^\d+\. /.test(l));
      expect(lines[0]).toBe(
        '1. [élevé · atteignable (code appelé)] CVE-2021-23337 / GHSA-35jh-r3h4-6jhm — lodash 4.17.20 (npm) : Command Injection in lodash — package-lock.json — corrigé en 4.17.21 (osv-scanner)',
      );
      expect(lines[1]).toMatch(
        /^2\. \[élevé · exposée\] template-injection — .* — \.github\/workflows\/ci\.yml:15 — https:\/\/docs\.zizmor\.sh/,
      );
      expect(lines[2]).toMatch(/^3\. \[critique · dépendance de dev\] CVE-2021-44906/);
      expect(lines).toHaveLength(10);
      expect(lines[3]).toMatch(
        /^4\. \[élevé\] generic-api-key — Detected a Generic API Key \[secret masqué\]/,
      );
      expect(lines[3]).toContain('deploy/values-[secret masqué].yaml:4');
      expect(lines[9]).toMatch(/^10\. \[moyen · non appelée par le code\] CVE-2023-3978/);

      // Exactly the catalogue argv, with the resolved project path as the only variable part.
      expect(fake.calls('gitleaks')).toEqual([ARGV.gitleaks(project)]);
      expect(fake.calls('osv-scanner')).toEqual([ARGV.osvScanner(project, false)]);
      expect(fake.calls('zizmor')).toEqual([ARGV.zizmor(project)]);
      expect(fake.calls('checkov')).toEqual([
        ARGV.checkov(project, [
          'terraform',
          'cloudformation',
          'kubernetes',
          'dockerfile',
          'serverless',
          'arm',
          'bicep',
          'ansible',
        ]),
      ]);
      // Environment built from scratch: nothing inherited from the daemon.
      const env = fake.env('gitleaks') ?? {};
      expect(env.JARVIS_TEST_LEAK).toBeUndefined();
      expect(env.HOME).toBe(home);
    } finally {
      delete process.env.JARVIS_TEST_LEAK;
    }
  });

  it('offline: no network at all; GitLab CI goes to checkov; a local ruleset enables SAST', async () => {
    installAll();
    fake.install('opengrep', SEMGREP);
    const repo = makeProject(join(work, 'gl'));
    rmSync(join(repo, '.github'), { recursive: true });
    writeFileSync(join(repo, '.gitlab-ci.yml'), 'deploy:\n  script: curl -d "$TOKEN" x\n');
    writeFileSync(join(repo, '.semgrep.yml'), 'rules: []\n');
    const out =
      (
        await tools().call('security_scan', {
          path: 'gl',
          offline: true,
          checks: ['dependencies', 'ci', 'sast'],
        })
      ).text ?? '';
    expect(fake.calls('osv-scanner').at(-1)).toContain('--offline');
    expect(fake.calls('zizmor')).toEqual([]);
    expect(fake.calls('checkov').at(-1)).toEqual(ARGV.checkov(repo, ['gitlab_ci']));
    expect(fake.calls('opengrep').at(-1)).toEqual(ARGV.opengrep(join(repo, '.semgrep.yml'), repo));
    expect(out).toContain('Réseau : aucun appel (scan entièrement local).');
    expect(out).toContain('CKV_GITLABCI_1');
    expect(out).toContain('js.eval-injection');
    expect(out).not.toContain(FAKE_KEY);
  });

  it('refuses symlink escapes, protected folders, .env* targets and anything outside the roots', async () => {
    installAll();
    const t = tools();
    const rule = async (path: string) =>
      (await t.call('security_scan', { path })).classification.rule;
    expect(await rule('keys')).toBe('fs.deny.protected'); // → ~/.ssh through a symlink
    expect(await rule('.env.d')).toBe('fs.deny.secret_file');
    expect(await rule(home)).toBe('fs.outside_roots');
    expect(await rule('/etc')).toBe('fs.deny.protected');
    expect(await rule('../../..')).toBe('fs.outside_roots');
    // A read root that contains credential stores (here: ~) is still not scannable as a whole.
    expect(
      (await tools({ readRoots: [home] }).call('security_scan', { path: home })).classification
        .rule,
    ).toBe('security.scan.contains_protected');
    expect(fake.calls('gitleaks')).toEqual([]);

    // run() re-checks on its own: a call that skipped classification is refused too.
    const scan = t.get('security_scan');
    await expect(
      scan.run(
        { path: 'keys', offline: false },
        {
          session: new Session('user'),
          signal: new AbortController().signal,
          cwd: work,
          classification: { level: N0, rule: 'x', reason: 'x' },
        },
      ),
    ).rejects.toBeInstanceOf(Refusal);
    // Image references that would make grype read a local path.
    expect(
      (await t.call('security_scan', { path: 'app', image: 'file:foo' })).classification.rule,
    ).toBe('security.image_scheme');
    for (const image of ['dir:/etc', '--config=/etc/x', 'a b', '../x'])
      expect(() =>
        z.object(t.get('security_scan').input).strict().parse({ path: 'app', image }),
      ).toThrow();
  });

  it('missing scanners: says what to install and never pretends it scanned', async () => {
    const none = () => null;
    const out = (await tools({ locate: none }).call('security_scan', { path: 'app' })).text ?? '';
    expect(out).toContain('Aucun scanner n’a pu tourner : rien n’a été vérifié.');
    expect(out).toContain('secrets → brew install gitleaks (~8 Mo)');
    expect(out).toContain(
      'IaC → brew install checkov (~100 Mo avec Python, sur Wi-Fi) ou brew install trivy (~45 Mo',
    );
    expect(out).toContain('Jarvis n’installe rien lui-même.');

    const list = (await tools({ locate: none }).call('security_tools', {})).text ?? '';
    expect(list).toContain(
      '✗ gitleaks — secrets dans les fichiers — brew install gitleaks (~8 Mo)',
    );
    expect(list).toContain('Pour compléter : brew install gitleaks osv-scanner zizmor (~29 Mo).');
    expect(list).toContain('Sur Wi-Fi : brew install checkov (~100 Mo).');
    expect(list).toContain(
      'Non proposé : la vérification en ligne des secrets (trufflehog --verify)',
    );
  });

  it('security_tools: path and version; a compromised release is identified without running it', async () => {
    installAll();
    fake.install('grype', GRYPE);
    // Homebrew layout: the version is read from the Cellar path, the binary is never executed.
    const cellar = join(fake.dir, 'Cellar', 'trivy', '0.69.4', 'bin');
    mkdirSync(cellar, { recursive: true });
    const marker = join(base, 'trivy-ran');
    const trivy = join(cellar, 'trivy');
    writeFileSync(trivy, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
    const locate = (id: ScannerId) => (id === 'trivy' ? trivy : fake.locate(id));

    const list = (await tools({ locate }).call('security_tools', {})).text ?? '';
    expect(list).toContain(`✓ gitleaks 1.2.3 — secrets dans les fichiers — ${fake.dir}/gitleaks`);
    expect(list).toContain('✓ trivy 0.69.4 — ');
    expect(list).toContain('⚠ trivy 0.69.4 est une version compromise');
    expect(list).not.toContain('Images (au choix)');

    const out =
      (
        await tools({ locate }).call('security_scan', {
          path: 'app',
          image: 'acme/api:1.4',
          checks: ['image'],
        })
      ).text ?? '';
    expect(out).toContain('⚠ trivy 0.69.4 : version compromise, non lancée');
    expect(out).toContain('CVE-2021-44228'); // grype took over
    expect(out).toContain('exploitée activement (CISA KEV)');
    expect(out).toContain('Réseau : grype — base de vulnérabilités mise à jour si besoin');
    expect(fake.calls('grype').at(-1)).toEqual(ARGV.grypeImage('acme/api:1.4'));
    expect(fake.env('grype')?.GRYPE_CHECK_FOR_APP_UPDATE).toBe('false');
    expect(existsSync(marker)).toBe(false);
  });

  it('timeout: a hanging scanner is killed, the others still report', async () => {
    installAll();
    fake.hang('gitleaks');
    const t0 = performance.now();
    const out =
      (
        await tools({ timeoutMs: 3000 }).call('security_scan', {
          path: 'app',
          checks: ['secrets', 'dependencies'],
        })
      ).text ?? '';
    expect(performance.now() - t0).toBeLessThan(8000);
    expect(out).toContain('gitleaks ✗ délai dépassé (3 s)');
    expect(out).toMatch(/osv-scanner ✓ 3 \(/);
  });

  it('errors and empty projects are reported, not parsed', async () => {
    installAll();
    fake.install('osv-scanner', null, { exit: 127, stderr: 'fatal: cannot read lockfile\npanic' });
    fake.install('checkov', CHECKOV_EMPTY);
    const out =
      (await tools().call('security_scan', { path: 'app', checks: ['dependencies', 'iac'] }))
        .text ?? '';
    expect(out).toContain('osv-scanner ✗ code 127 : fatal: cannot read lockfile | panic');
    expect(out).toContain('checkov ✓ 0');
    expect(out).toContain('Aucun problème trouvé par les scanners qui ont tourné.');
    fake.install('osv-scanner', null, { exit: 128 });
    expect(
      (await tools().call('security_scan', { path: 'app', checks: ['dependencies'] })).text,
    ).toContain('osv-scanner ✓ rien à analyser');
  });

  it('a scanner binary inside the scanned project is never run', async () => {
    installAll();
    const inside = join(project, 'node_modules', '.bin');
    mkdirSync(inside, { recursive: true });
    const bin = join(inside, 'gitleaks');
    writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const out =
      (
        await tools({ locate: (id) => (id === 'gitleaks' ? bin : null) }).call('security_scan', {
          path: 'app',
          checks: ['secrets'],
        })
      ).text ?? '';
    expect(out).toContain('secrets → brew install gitleaks');
    rmSync(join(project, 'node_modules'), { recursive: true });
  });

  it('locator: Homebrew, ~/.local/bin, absolute PATH entries only', () => {
    const dir = join(base, 'bin');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'zizmor'), '#!/bin/sh\n', { mode: 0o755 });
    writeFileSync(join(dir, 'syft'), 'not executable', { mode: 0o644 });
    const locate = binaryLocator({ home, pathEnv: `relative/bin:${dir}`, fixedDirs: [] });
    expect(locate('zizmor')).toBe(join(dir, 'zizmor'));
    expect(locate('syft')).toBeNull();
    expect(versionOf('osv-scanner version: 2.2.3\ncommit: abc')).toBe('2.2.3');
    expect(versionOf('Version: v0.69.3')).toBe('0.69.3');
  });

  it('diff secret scan for worker PRs: added lines only, null when gitleaks cannot run', async () => {
    installAll();
    const tmp = join(base, 'tmp');
    const scan = diffSecretScanner({ locate: fake.locate, home, tmpDir: tmp });
    const signal = new AbortController().signal;
    expect(await scan('+++ b/x\n+const k = "x";\n', signal)).toEqual([
      'github-pat',
      'generic-api-key',
    ]);
    expect(await scan('--- a/x\n-const old = "secret";\n', signal)).toEqual([]);
    fake.install('gitleaks', null, { exit: 2 });
    expect(await scan('+x\n', signal)).toBeNull();
    expect(
      await diffSecretScanner({ locate: () => null, home, tmpDir: tmp })('+x', signal),
    ).toBeNull();
  });
});
