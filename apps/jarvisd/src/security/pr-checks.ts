import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { ARGV, OK_CODES } from './catalogue.ts';
import { oneLine, parseGitleaks, parseJson } from './parse.ts';
import { type Locate, runArgv } from './run.ts';

/**
 * Checks on a worker's pull request that need no network and no install: the dependencies it
 * adds (read from the manifests before and after) and, when gitleaks is installed, the lines it
 * adds. Registry facts (existence, age, downloads) would need the network: not done here.
 */

export type Ecosystem = 'npm' | 'pypi' | 'go';

export interface NewDep {
  ecosystem: Ecosystem;
  name: string;
  spec: string;
  file: string;
}

export interface DepWarning {
  dep: NewDep;
  reason: string;
}

export interface DepReport {
  deps: NewDep[];
  warnings: DepWarning[];
}

export interface ManifestChange {
  path: string;
  /** Content on the base branch; null when the file is new. */
  before: string | null;
  /** Content in the PR; null when the file is deleted. */
  after: string | null;
}

/** Manifests whose new dependencies are checked. Others (Cargo, pyproject) are not parsed yet. */
export const isManifest = (path: string): boolean => {
  const name = basename(path);
  return name === 'package.json' || name === 'go.mod' || /^requirements[\w.-]*\.txt$/.test(name);
};

/** Lockfiles next to an npm manifest (or at the repository root) that prove an install. */
export const NPM_LOCKFILES = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
];

/** Lockfile texts for an npm manifest: next to it, then at the repository root (workspaces). */
export function readLockfiles(root: string, manifestPath: string): string[] {
  const dirs = [...new Set([join(root, dirname(manifestPath)), root])];
  const out: string[] = [];
  for (const dir of dirs)
    for (const name of NPM_LOCKFILES) {
      const p = join(dir, name);
      const st = lstatSync(p, { throwIfNoEntry: false });
      // Regular files only (no symlink out of the worktree), bounded.
      if (st?.isFile() && st.size <= 50_000_000) out.push(readFileSync(p, 'utf8'));
    }
  return out;
}

/** Most-installed names, the usual typosquatting targets. A name in the list is never flagged. */
const POPULAR: Record<'npm' | 'pypi', readonly string[]> = {
  npm: [
    'react',
    'react-dom',
    'preact',
    'vue',
    'svelte',
    'next',
    'nuxt',
    'vite',
    'webpack',
    'rollup',
    'esbuild',
    'typescript',
    'lodash',
    'underscore',
    'axios',
    'express',
    'koa',
    'fastify',
    'chalk',
    'commander',
    'yargs',
    'debug',
    'dotenv',
    'moment',
    'dayjs',
    'date-fns',
    'uuid',
    'zod',
    'yup',
    'joi',
    'ajv',
    'jest',
    'mocha',
    'vitest',
    'eslint',
    'prettier',
    'jsonwebtoken',
    'bcrypt',
    'bcryptjs',
    'mongoose',
    'sequelize',
    'prisma',
    'pg',
    'mysql2',
    'redis',
    'ioredis',
    'socket.io',
    'cors',
    'helmet',
    'body-parser',
    'cookie-parser',
    'nodemon',
    'rimraf',
    'glob',
    'minimist',
    'semver',
    'cross-env',
    'request',
    'node-fetch',
    'tslib',
    'rxjs',
    'classnames',
    'tailwindcss',
    'postcss',
    'autoprefixer',
    'sass',
    'electron',
    'puppeteer',
    'playwright',
    'cheerio',
    'jquery',
    'bootstrap',
    'redux',
    'zustand',
    'graphql',
    'apollo-server',
    'ws',
    'nanoid',
    'colors',
    'ua-parser-js',
    'event-stream',
  ],
  pypi: [
    'requests',
    'urllib3',
    'numpy',
    'pandas',
    'scipy',
    'matplotlib',
    'django',
    'flask',
    'fastapi',
    'uvicorn',
    'pydantic',
    'sqlalchemy',
    'boto3',
    'botocore',
    'pyyaml',
    'setuptools',
    'wheel',
    'pip',
    'six',
    'certifi',
    'idna',
    'charset-normalizer',
    'cryptography',
    'pyjwt',
    'jinja2',
    'click',
    'pytest',
    'python-dateutil',
    'pillow',
    'beautifulsoup4',
    'lxml',
    'selenium',
    'scikit-learn',
    'tensorflow',
    'torch',
    'openai',
    'anthropic',
    'httpx',
    'aiohttp',
    'celery',
    'redis',
    'psycopg2',
    'psycopg2-binary',
    'colorama',
    'tqdm',
    'rich',
  ],
};

const squash = (s: string) => s.toLowerCase().replace(/[-_.]/g, '');

/** Optimal string alignment distance (Damerau-Levenshtein with adjacent swaps), capped. */
export function editDistance(a: string, b: string, cap = 3): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    const row = d[i] as number[];
    const prev = d[i - 1] as number[];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(
        (prev[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        v = Math.min(v, ((d[i - 2] as number[])[j - 2] as number) + 1);
      row[j] = v;
    }
  }
  return (d[a.length] as number[])[b.length] as number;
}

/** The popular package a name imitates, if it looks like a typo of one. */
export function lookalike(ecosystem: 'npm' | 'pypi', name: string): string | null {
  const lower = name.toLowerCase();
  const bare = lower.replace(/^@[^/]+\//, '');
  const list = POPULAR[ecosystem];
  if (list.includes(lower) || list.includes(bare)) return null;
  for (const p of list) {
    if (squash(bare) === squash(p) && bare !== p) return p; // separator games: lo-dash, py_yaml
    if (bare.length >= 5 && editDistance(bare, p, 1) === 1) return p;
  }
  return null;
}

const NON_REGISTRY_NPM = /^(git\+|git:|github:|gitlab:|bitbucket:|gist:|https?:|file:|link:)/i;
const GITHUB_SHORTHAND = /^[\w.-]+\/[\w.-]+(#.*)?$/;
const LOCAL_NPM = /^(workspace:|catalog:|portal:)/;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function npmDeps(json: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!json) return out;
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    return out;
  }
  const root = (doc ?? {}) as Record<string, unknown>;
  for (const section of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    const s = root[section];
    if (!s || typeof s !== 'object' || Array.isArray(s)) continue;
    for (const [name, spec] of Object.entries(s as Record<string, unknown>))
      if (typeof spec === 'string' && !out.has(name)) out.set(name, spec);
  }
  return out;
}

const addedLines = (before: string | null, after: string | null) => {
  const old = new Set((before ?? '').split('\n').map((l) => l.trim()));
  return (after ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !old.has(l));
};

/**
 * New dependencies between two versions of each manifest, with the reasons to look twice.
 * `lockfiles(dir)` returns the lockfile texts found for an npm manifest (empty: unknown).
 */
export function newDependencies(
  changes: readonly ManifestChange[],
  lockfiles: (manifestPath: string) => string[],
): DepReport {
  const deps: NewDep[] = [];
  const warnings: DepWarning[] = [];
  const warn = (dep: NewDep, reason: string) => warnings.push({ dep, reason });

  for (const c of changes) {
    const name = basename(c.path);
    if (name === 'package.json') {
      const before = npmDeps(c.before);
      const locks = lockfiles(c.path);
      for (const [dep, spec] of npmDeps(c.after)) {
        if (before.has(dep)) continue;
        const d: NewDep = { ecosystem: 'npm', name: dep, spec, file: c.path };
        deps.push(d);
        if (LOCAL_NPM.test(spec)) continue;
        if (NON_REGISTRY_NPM.test(spec) || GITHUB_SHORTHAND.test(spec) || /\.tgz$/i.test(spec))
          warn(d, `source hors registre (${oneLine(spec, 80)}) : aucun contrôle du registre`);
        else if (spec.startsWith('npm:'))
          warn(d, `alias vers un autre paquet (${oneLine(spec, 80)})`);
        else if (/^(\*|latest|x|)$/i.test(spec.trim()) || /^>=?\s*[\w.-]+$/.test(spec.trim()))
          warn(
            d,
            `version non bornée (${spec || 'vide'}) : la prochaine version s’installera seule`,
          );
        const like = lookalike('npm', dep);
        if (like) warn(d, `nom très proche de « ${like} » (typosquatting ?)`);
        const seen = new RegExp(`(^|[\\s"'/])${escapeRe(dep)}(@|['"]?:)`, 'm');
        if (locks.length > 0 && !locks.some((l) => seen.test(l)))
          warn(d, 'absente du lockfile : jamais installée (nom inventé ?)');
      }
    } else if (name === 'go.mod') {
      // A version bump is not a new dependency: compare module names, not lines.
      const before = new Set(
        (c.before ?? '')
          .split('\n')
          .map((l) => GO_MODULE.exec(l.trim())?.[1])
          .filter(Boolean),
      );
      for (const line of addedLines(c.before, c.after)) {
        if (/^replace\s*\($/.test(line)) continue; // block opener: its entries are flagged
        if (/^replace\b/.test(line) || /=>/.test(line)) {
          const d: NewDep = { ecosystem: 'go', name: oneLine(line, 80), spec: '', file: c.path };
          warn(d, 'directive replace : module remplacé par un fork ou un chemin local');
          continue;
        }
        const m = GO_MODULE.exec(line);
        if (!m || /\/\/\s*indirect/.test(line) || before.has(m[1])) continue;
        deps.push({ ecosystem: 'go', name: m[1] ?? '', spec: m[2] ?? '', file: c.path });
      }
    } else if (isManifest(c.path)) {
      const before = new Set(
        (c.before ?? '')
          .split('\n')
          .map((l) =>
            PY_NAME.exec(l.trim())?.[1]
              ?.toLowerCase()
              .replace(/[-_.]+/g, '-'),
          )
          .filter(Boolean),
      );
      for (const line of addedLines(c.before, c.after)) {
        const l = line.replace(/\s+#.*$/, '');
        if (!l || l.startsWith('#')) continue;
        // A bare URL or path is a package from outside the registry, not a package named "https".
        if (/^(https?|file|git\+\w+|hg\+\w+|svn\+\w+):/i.test(l)) {
          const d: NewDep = { ecosystem: 'pypi', name: oneLine(l, 80), spec: '', file: c.path };
          deps.push(d);
          warn(d, `source hors registre (${oneLine(l, 80)})`);
          continue;
        }
        if (/^(-i|--index-url|--extra-index-url)\b/.test(l)) {
          const d: NewDep = { ecosystem: 'pypi', name: oneLine(l, 80), spec: '', file: c.path };
          warn(d, 'index de paquets ajouté : risque de confusion de dépendances');
          continue;
        }
        if (l.startsWith('-')) {
          if (/^(-e|--editable)\b/.test(l)) {
            const d: NewDep = { ecosystem: 'pypi', name: oneLine(l, 80), spec: '', file: c.path };
            warn(d, 'installation éditable depuis un chemin ou un dépôt');
          }
          continue;
        }
        const m = PY_NAME.exec(l);
        if (!m) continue;
        // A version bump of a dependency already there is not a new one.
        if (before.has((m[1] ?? '').toLowerCase().replace(/[-_.]+/g, '-'))) continue;
        const d: NewDep = {
          ecosystem: 'pypi',
          name: m[1] ?? '',
          spec: (m[3] ?? '').trim(),
          file: c.path,
        };
        deps.push(d);
        if (/(git\+|https?:|file:)/i.test(d.spec))
          warn(d, `source hors registre (${oneLine(d.spec, 80)})`);
        const like = lookalike('pypi', d.name);
        if (like) warn(d, `nom très proche de « ${like} » (typosquatting ?)`);
      }
    }
  }
  return { deps, warnings };
}

const GO_MODULE = /^(?:require\s+)?([\w.~-]+\.[\w.~-]+\/[\w./~-]+)\s+(v[\w.+-]+)/;
const PY_NAME = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*(.*)$/;

const code = (s: string) => `\`${s.replaceAll('`', "'")}\``;

/** PR body section; empty when the PR adds no dependency. */
export function depsMarkdown(r: DepReport): string {
  if (r.deps.length === 0 && r.warnings.length === 0) return '';
  const out = ['### Nouvelles dépendances (contrôle local, sans réseau)'];
  if (r.warnings.length) {
    out.push('⚠️ **À vérifier avant de merger :**');
    for (const w of r.warnings.slice(0, 20))
      out.push(`- ${code(w.dep.name)} (${w.dep.ecosystem}, ${w.dep.file}) : ${w.reason}`);
  }
  if (r.deps.length)
    out.push(
      `Ajoutées : ${r.deps
        .slice(0, 30)
        .map((d) => `${code(d.name)}${d.spec ? ` ${oneLine(d.spec, 40)}` : ''}`)
        .join(', ')}${r.deps.length > 30 ? ` … (+${r.deps.length - 30})` : ''}`,
    );
  return out.join('\n');
}

/**
 * gitleaks on the lines a PR adds (removed lines may be a secret being deleted). Returns the
 * rule ids found, [] when clean, null when it could not run: the pipeline then keeps its own
 * pattern check and never waits on a missing tool.
 */
export function diffSecretScanner(o: {
  locate: Locate;
  home: string;
  tmpDir: string;
  timeoutMs?: number;
}): (diff: string, signal: AbortSignal) => Promise<string[] | null> {
  return async (diff, signal) => {
    const bin = o.locate('gitleaks');
    if (!bin) return null;
    const added = diff
      .split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
      .map((l) => l.slice(1))
      .join('\n');
    if (!added.trim()) return [];
    let dir: string | null = null;
    try {
      mkdirSync(o.tmpDir, { recursive: true, mode: 0o700 });
      dir = mkdtempSync(join(o.tmpDir, 'leaks-'));
      const file = join(dir, 'added-lines.txt');
      writeFileSync(file, added, { mode: 0o600 });
      const r = await runArgv(bin, ARGV.gitleaks(file), {
        cwd: dir,
        home: o.home,
        timeoutMs: o.timeoutMs ?? 30_000,
        signal,
        maxBytes: 4_000_000,
      });
      if (r.status !== 'ok' || r.exitCode === null || !OK_CODES.gitleaks.includes(r.exitCode))
        return null;
      const found = parseGitleaks(parseJson(r.stdout), {
        root: dir,
        check: 'secrets',
        secret: () => undefined,
      });
      return [...new Set(found.map((f) => oneLine(f.rule, 60)))];
    } catch {
      return null;
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  };
}
