import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { CheckRun } from './proof.ts';

/**
 * Browser checks for web frontends (ADR-036, opt-in through workers.ui_checks). What exists is
 * found at run time, nothing is downloaded: the Mac's own Chrome takes headless screenshots, and
 * Lighthouse, axe or Playwright run only when the project already depends on them.
 */
export interface UiChecksPolicy {
  enabled: boolean;
  ports: readonly number[];
  widths: readonly number[];
}

export interface UiTools {
  playwright: boolean;
  lighthouse: boolean;
  axe: boolean;
}

/** What a task's worktree offers for checking its interface. */
export interface UiEnv {
  frameworks: string[];
  /** The Mac's Chrome binary, or null. */
  chrome: string | null;
  /** Audit tools the project declares in its package.json files. */
  tools: UiTools;
  /** What is unavailable, in French, for the pull request. */
  notes: string[];
}

/** UI checks of one task: only set when the feature is on and the repository is a web frontend. */
export interface UiRun extends UiEnv {
  /** The task's folder for screenshots, reports and the browser profile: outside any repository. */
  dir: string;
  ports: readonly number[];
  widths: readonly number[];
}

export interface UiProbe {
  exists(path: string): boolean;
  read(path: string): string | null;
  list(dir: string): string[];
}

export const fsProbe: UiProbe = {
  exists: (p) => existsSync(p),
  read: (p) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  },
  list: (d) => {
    try {
      return readdirSync(d);
    } catch {
      return [];
    }
  },
};

export const chromeCandidates = (home: string): string[] => [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

const FRAMEWORKS: [name: string, is: (dep: string) => boolean, port: number][] = [
  ['Next.js', (d) => d === 'next', 3000],
  ['Vite', (d) => d === 'vite', 5173],
  ['Storybook', (d) => d === 'storybook' || d.startsWith('@storybook/'), 6006],
  ['Create React App', (d) => d === 'react-scripts', 3000],
  ['React', (d) => d === 'react-dom', 3000],
];
const AXE = new Set(['axe-core', 'axe-playwright', 'jest-axe', 'vitest-axe']);
/** Where a monorepo keeps its web app, one level down. */
const GROUPS = ['apps', 'packages'];
const SINGLE = ['web', 'frontend', 'client', 'site', 'www', 'ui'];

function dependencies(text: string | null): string[] {
  if (!text) return [];
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    return ['dependencies', 'devDependencies'].flatMap((k) => {
      const v = j[k];
      return v && typeof v === 'object' ? Object.keys(v) : [];
    });
  } catch {
    return [];
  }
}

/** Null when the worktree is not a web frontend: nothing about the worker changes then. */
export function detectUi(worktree: string, home: string, probe: UiProbe = fsProbe): UiEnv | null {
  const manifests = [
    join(worktree, 'package.json'),
    ...SINGLE.map((d) => join(worktree, d, 'package.json')),
    ...GROUPS.flatMap((g) =>
      probe
        .list(join(worktree, g))
        .slice(0, 30)
        .map((n) => join(worktree, g, n, 'package.json')),
    ),
  ];
  const deps = [...new Set(manifests.flatMap((p) => dependencies(probe.read(p))))];
  let frameworks = FRAMEWORKS.filter(([, is]) => deps.some(is)).map(([n]) => n);
  if (frameworks.length === 0) return null;
  if (frameworks.length > 1) frameworks = frameworks.filter((f) => f !== 'React');
  const chrome = chromeCandidates(home).find((p) => probe.exists(p)) ?? null;
  const tools: UiTools = {
    playwright: deps.includes('@playwright/test') || deps.includes('playwright'),
    lighthouse: deps.includes('lighthouse'),
    axe: deps.some((d) => AXE.has(d) || d.startsWith('@axe-core/')),
  };
  const notes: string[] = [];
  if (!chrome)
    notes.push('Google Chrome est introuvable dans /Applications : aucune capture d’écran.');
  if (!tools.lighthouse)
    notes.push(
      'Lighthouse n’est pas une dépendance du projet : pas de scores (rien n’est téléchargé).',
    );
  if (!tools.axe)
    notes.push(
      'axe n’est pas une dépendance du projet : accessibilité non auditée automatiquement.',
    );
  return { frameworks, chrome, tools, notes };
}

export const heightFor = (width: number): number =>
  width <= 480 ? 812 : width <= 1024 ? 1024 : 800;

function defaultPort(ui: Pick<UiRun, 'frameworks' | 'ports'>): number {
  for (const [name, , port] of FRAMEWORKS)
    if (ui.frameworks.includes(name) && ui.ports.includes(port)) return port;
  return ui.ports[0] ?? 3000;
}

const q = (p: string) => (/\s/.test(p) ? `"${p}"` : p);

/** Worker instructions for a frontend task. Advice only: the guard and the sandbox enforce. */
export function uiRules(ui: UiRun): string {
  const url = `http://127.0.0.1:${defaultPort(ui)}/`;
  const w = ui.widths[0] ?? 375;
  const lines = [
    '',
    '# Checking the web interface (enabled by Brightky; enforced by code)',
    `This repository is a web frontend (${ui.frameworks.join(', ')}). When your change affects what users see, check it in a real browser before finishing.`,
    `- Dev server: start it with run_in_background, bound to 127.0.0.1 on one of the ports ${ui.ports.join(', ')} (e.g. \`next dev -H 127.0.0.1 -p 3000\`, \`vite --host 127.0.0.1 --port 5173 --strictPort\`, \`storybook dev --host 127.0.0.1 -p 6006 --ci\`). 0.0.0.0, :: and a bare --host are refused. Stop it with KillShell when you are done.`,
    '- Loopback is open to your shell for this only: never connect to another local service.',
  ];
  if (ui.chrome) {
    lines.push(
      `- Screenshots: the Mac's Chrome, headless, with a throwaway profile, files only in ${ui.dir} (outside the repository: never commit screenshots). One run per page and per width (${ui.widths.join(', ')} px), named <page>-<width>.png, for example:`,
      `  "${ui.chrome}" --headless=new --disable-gpu --hide-scrollbars --no-first-run --no-default-browser-check --virtual-time-budget=5000 --user-data-dir=${q(join(ui.dir, 'profile'))} --window-size=${w},${heightFor(w)} --screenshot=${q(join(ui.dir, `home-${w}.png`))} ${url}`,
      `  Only http://127.0.0.1:<port>/ or http://localhost:<port>/ URLs on those ports. Look at each PNG with Read and fix what looks wrong. If Chrome exits at once, retry once with --no-sandbox (the macOS sandbox still contains it).`,
    );
  } else {
    lines.push('- This Mac has no Chrome: no screenshots. Say so in your result.');
  }
  if (ui.tools.lighthouse)
    lines.push(
      `- Lighthouse (a project dependency), through the project's package manager, report in that folder: e.g. \`pnpm exec lighthouse ${url} --quiet --output=json --output-path=${q(join(ui.dir, 'lighthouse-home.json'))} --chrome-flags="--headless=new"\`.`,
    );
  if (ui.tools.axe)
    lines.push(
      `- axe (a project dependency): run the project's accessibility tests, or the axe CLI with --dir ${q(ui.dir)}.`,
    );
  if (ui.tools.playwright)
    lines.push(
      "- Playwright (a project dependency): run the project's browser tests. Browsers are never downloaded (`playwright install` is refused).",
    );
  const missing = [!ui.tools.lighthouse && 'Lighthouse', !ui.tools.axe && 'axe'].filter(Boolean);
  if (missing.length)
    lines.push(
      `- Not in this project: ${missing.join(', ')}. Never install or download them (metered connection); say in your result that they were skipped.`,
    );
  lines.push(
    '- In the tests field of your result, list the pages and widths you checked and what you saw.',
  );
  return lines.join('\n');
}

/** Extra environment of a frontend task: the Mac's Chrome for Lighthouse/Puppeteer, no downloads. */
export function uiEnv(ui: UiRun): Record<string, string> {
  return {
    PUPPETEER_SKIP_DOWNLOAD: '1',
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
    ...(ui.chrome ? { CHROME_PATH: ui.chrome, PUPPETEER_EXECUTABLE_PATH: ui.chrome } : {}),
  };
}

// ---- Command helpers shared by the guard and the proof ----

const BROWSERS = new Set([
  'google chrome',
  'google chrome canary',
  'google chrome for testing',
  'chromium',
  'chromium-browser',
  'chrome',
  'chrome-headless-shell',
  'headless_shell',
  'microsoft edge',
  'brave browser',
]);
export const isBrowser = (bin: string): boolean => BROWSERS.has(basename(bin).toLowerCase());

/** Audit CLIs and the one-shot runners that may launch them. */
export const AUDIT_TOOLS = new Set(['lighthouse', 'axe']);
export const RUNNERS = new Set(['npx', 'bunx', 'pnpm', 'yarn', 'npm']);

/** Index of an audit CLI in argv, run directly or through `npx`, `pnpm exec`…; else -1. */
export function auditIndex(argv: readonly string[]): number {
  const i = argv.findIndex((a) => AUDIT_TOOLS.has(basename(a)));
  if (i <= 0) return i;
  if (!RUNNERS.has(basename(argv[0] ?? ''))) return -1;
  // `pnpm add lighthouse` installs it, it does not run it.
  const between = argv.slice(1, i);
  return between.every((a) => a === 'exec' || a === 'dlx' || a === '--' || a.startsWith('-'))
    ? i
    : -1;
}

/** `--name=value` or `--name value`. */
export function flagValue(args: readonly string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
    if (a === name) return args[i + 1];
  }
  return undefined;
}

/** Words of a plain command line (quotes removed). Commands reach here already parsed by the guard. */
export function shellWords(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let word = false;
  let quote: string | null = null;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      word = true;
    } else if (/\s/.test(ch)) {
      if (word) out.push(cur);
      cur = '';
      word = false;
    } else {
      cur += ch;
      word = true;
    }
  }
  if (word) out.push(cur);
  return out;
}

/** Splits on && || ; | outside quotes. */
export function shellSegments(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] ?? '';
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ';' || ch === '|' || (ch === '&' && command[i + 1] === '&')) {
      out.push(cur);
      cur = '';
      if ((ch === '|' || ch === '&') && command[i + 1] === ch) i++;
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** http(s) on 127.0.0.1 / localhost / [::1], on one of the allowed ports. */
export function loopbackUrl(s: string, ports: readonly number[]): boolean {
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (!LOOPBACK.has(u.hostname) || u.username || u.password) return false;
  return ports.includes(Number(u.port || (u.protocol === 'https:' ? 443 : 80)));
}

/** Real path of the deepest existing ancestor, plus the rest. */
function canonical(path: string): string {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    const parent = dirname(abs);
    return parent === abs ? abs : join(canonical(parent), basename(abs));
  }
}

/** Strictly below dir, symlinks resolved. */
export function isInside(path: string, dir: string): boolean {
  const rel = relative(canonical(dir), canonical(path));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

// ---- After the run: what Chrome really wrote, then the PR section ----

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_PNG = 10_000_000;
const MAX_KEPT = 40;

/** A regular file (never a symlink) starting with the PNG signature. */
function isPng(path: string): boolean {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size < PNG.length || st.size > MAX_PNG) return false;
    const fd = openSync(path, 'r');
    try {
      const head = Buffer.alloc(PNG.length);
      readSync(fd, head, 0, PNG.length, 0);
      return head.equals(PNG);
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** A capture is green only if Chrome exited 0 *and* a PNG really sits in the task's folder. */
export function confirmCaptures(checks: readonly CheckRun[], dir: string): CheckRun[] {
  return checks.map((c) =>
    c.ui?.kind === 'capture' && c.ok && !(isInside(c.ui.file, dir) && isPng(c.ui.file))
      ? { ...c, ok: false }
      : c,
  );
}

/** Copies the screenshots next to the task log (PNG only, capped); returns their names. */
export function keepCaptures(dir: string, dest: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((n) => n.toLowerCase().endsWith('.png') && isPng(join(dir, n)))
      .sort()
      .slice(0, MAX_KEPT);
  } catch {
    return [];
  }
  if (names.length === 0) return [];
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  for (const n of names) copyFileSync(join(dir, n), join(dest, n));
  return names;
}

const CATEGORIES: [id: string, label: string][] = [
  ['performance', 'performance'],
  ['accessibility', 'accessibilité'],
  ['best-practices', 'bonnes pratiques'],
  ['seo', 'SEO'],
];

/** Category scores (0-100) of a Lighthouse JSON report in the task's folder, or null. */
export function lighthouseScores(report: string, dir: string): Record<string, number> | null {
  if (!isInside(report, dir)) return null;
  try {
    const st = lstatSync(report);
    if (!st.isFile() || st.size > 50_000_000) return null;
    const j = JSON.parse(readFileSync(report, 'utf8')) as {
      categories?: Record<string, { score?: unknown }>;
    };
    const out: Record<string, number> = {};
    for (const [id] of CATEGORIES) {
      const s = j.categories?.[id]?.score;
      if (typeof s === 'number' && s >= 0 && s <= 1) out[id] = Math.round(s * 100);
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

const tick = (ok: boolean) => (ok ? '✅' : '❌');
const page = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}${u.search}`.slice(0, 80).replaceAll('`', "'");
  } catch {
    return url.slice(0, 80).replaceAll('`', "'") || '?';
  }
};

/** "### Interface vérifiée": pages × widths, Lighthouse scores, axe, what was unavailable. */
export function uiSection(ui: UiRun, checks: readonly CheckRun[], kept: readonly string[]): string {
  const out = ['### Interface vérifiée'];
  out.push(
    `Serveur de dev local (${ui.frameworks.join(', ')}), Chrome du Mac sans interface, profil jetable.`,
  );
  const shots = checks.flatMap((c) => (c.ui?.kind === 'capture' ? [{ ...c.ui, ok: c.ok }] : []));
  if (shots.length) {
    const widths = [...new Set(shots.map((s) => s.width))].sort((a, b) => a - b);
    const pages = [...new Set(shots.map((s) => page(s.url)))];
    out.push(
      '',
      `| Page | ${widths.map((w) => `${w} px`).join(' | ')} |`,
      `|---|${widths.map(() => '---').join('|')}|`,
      ...pages.map((p) => {
        const cells = widths.map((w) => {
          const s = shots.find((x) => page(x.url) === p && x.width === w);
          return s ? tick(s.ok) : '—';
        });
        return `| \`${p}\` | ${cells.join(' | ')} |`;
      }),
      '',
      '✅ = Chrome a produit la capture ; le rendu reste à regarder.',
    );
  }
  const audits: string[] = [];
  for (const c of checks) {
    if (c.ui?.kind === 'lighthouse') {
      const scores = c.ok && c.ui.report ? lighthouseScores(c.ui.report, ui.dir) : null;
      const detail = scores
        ? CATEGORIES.filter(([id]) => scores[id] !== undefined)
            .map(([id, label]) => `${label} ${scores[id]}`)
            .join(' · ')
        : c.ok
          ? 'rapport JSON illisible'
          : 'en échec';
      audits.push(`- ${tick(c.ok)} Lighthouse \`${page(c.ui.url)}\` : ${detail}`);
    } else if (c.ui?.kind === 'axe') {
      audits.push(
        `- ${tick(c.ok)} axe \`${page(c.ui.url)}\` : ${c.ok ? 'aucune violation remontée' : 'violations ou échec'}`,
      );
    } else if (/\bplaywright\s+test\b/.test(c.command)) {
      audits.push(`- ${tick(c.ok)} tests navigateur \`${c.command.replaceAll('`', "'")}\``);
    }
  }
  if (audits.length) out.push('', ...audits);
  if (!shots.length && !audits.length)
    out.push('', '⚠️ Aucune page n’a été ouverte dans le navigateur : interface non vérifiée.');
  if (ui.notes.length) out.push('', 'Non disponible :', ...ui.notes.map((n) => `- ${n}`));
  if (kept.length)
    out.push(
      '',
      `Captures hors du dépôt, gardées par Jarvis avec le journal de la tâche : ${kept.join(', ')}.`,
    );
  return out.join('\n');
}
