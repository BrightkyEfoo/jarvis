import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import {
  type Classification,
  defineTool,
  type FsPolicy,
  forbid,
  N0,
  N1,
  N2,
  N3,
  type Policy,
  type ToolDef,
} from '@jarvis/policy';
import { z } from 'zod';

const run = promisify(execFile);

/** Side effects on the Mac, injected so tests never launch real apps. */
export interface MacOps {
  open(args: string[], signal: AbortSignal): Promise<void>;
  runningApps(signal: AbortSignal): Promise<string[]>;
  shortcuts(signal: AbortSignal): Promise<string[]>;
  runShortcut(name: string, inputPath: string | null, signal: AbortSignal): Promise<string>;
  status(signal: AbortSignal): Promise<string>;
}

const RUNNING_APPS_JXA =
  'ObjC.import("AppKit"); $.NSWorkspace.sharedWorkspace.runningApplications.js' +
  '.filter(a => a.activationPolicy == 0).map(a => a.localizedName.js).join("\\n")';

export const realMacOps: MacOps = {
  async open(args, signal) {
    await run('/usr/bin/open', args, { signal, timeout: 15_000 });
  },
  async runningApps(signal) {
    const { stdout } = await run(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', RUNNING_APPS_JXA],
      { signal, timeout: 5_000 },
    );
    return stdout.split('\n').filter(Boolean);
  },
  async shortcuts(signal) {
    const { stdout } = await run('/usr/bin/shortcuts', ['list'], { signal, timeout: 10_000 });
    return stdout.split('\n').filter(Boolean);
  },
  async runShortcut(name, inputPath, signal) {
    const args = ['run', name, '--output-path', '-'];
    if (inputPath) args.push('--input-path', inputPath);
    const { stdout } = await run('/usr/bin/shortcuts', args, {
      signal,
      timeout: 120_000,
      maxBuffer: 1_000_000,
    });
    return stdout;
  },
  async status(signal) {
    const [batt, boot, disk] = await Promise.all([
      run('/usr/bin/pmset', ['-g', 'batt'], { signal }),
      run('/usr/sbin/sysctl', ['-n', 'kern.boottime'], { signal }),
      run('/bin/df', ['-k', '/'], { signal }),
    ]);
    const secs = Number(/sec = (\d+)/.exec(boot.stdout)?.[1] ?? 0);
    const up = secs ? Math.round((Date.now() / 1000 - secs) / 3600) : null;
    const free = Number(disk.stdout.trim().split('\n')[1]?.split(/\s+/)[3] ?? 0);
    return [
      batt.stdout.trim(),
      `uptime: ${up ?? '?'} h`,
      `free disk: ${(free / 1024 / 1024).toFixed(1)} GiB`,
    ].join('\n');
  },
};

/** Apps that execute whatever document they are given, or change the system. */
const EXECUTOR_APPS = new Set([
  'terminal',
  'iterm',
  'iterm2',
  'script editor',
  'automator',
  'shortcuts',
  'installer',
  'keychain access',
  'disk utility',
  'system settings',
  'system preferences',
  'console',
  'activity monitor',
  'directory utility',
  'migration assistant',
  'boot camp assistant',
  'screen sharing',
  'ssh',
  'warp',
  'ghostty',
  'kitty',
  'alacritty',
]);

/** Payments and money transfers are out of scope (N4), whatever the policy says. */
const PAYMENT_SHORTCUT =
  /money|pay|paiement|payment|virement|transfer|transfert|bank|banque|momo|wallet|crypto/i;

const APP_NAME = /^[\p{L}\p{N} ._+&()'-]{1,60}$/u;

export interface Project {
  name: string;
  path: string;
  branch: string | null;
  kind: string[];
}

function gitBranch(dir: string): string | null {
  try {
    const head = readFileSync(join(dir, '.git', 'HEAD'), 'utf8').trim();
    return head.startsWith('ref: refs/heads/') ? head.slice(16) : head.slice(0, 12);
  } catch {
    return null;
  }
}

const MARKERS: Record<string, string> = {
  'package.json': 'node',
  'pnpm-workspace.yaml': 'pnpm-monorepo',
  'Cargo.toml': 'rust',
  'pyproject.toml': 'python',
  'go.mod': 'go',
  'pubspec.yaml': 'flutter',
  'app.json': 'expo',
  'CMakeLists.txt': 'cmake',
};

/** Projects found under the configured roots, plus the explicit project paths. */
export function discoverProjects(policy: Policy): Project[] {
  const dirs: string[] = [...policy.projects.paths];
  for (const root of policy.projects.roots) {
    if (!existsSync(root)) continue;
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('.')) dirs.push(join(root, e.name));
    }
  }
  return dirs
    .filter((d) => existsSync(d) && statSync(d).isDirectory())
    .map((path) => ({
      name: basename(path),
      path,
      branch: gitBranch(path),
      kind: Object.entries(MARKERS).flatMap(([f, k]) => (existsSync(join(path, f)) ? [k] : [])),
    }));
}

const normalize = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();

export interface MacToolDeps {
  fs: FsPolicy;
  policy: Policy;
  mac: MacOps;
  scratchDir: string;
}

export function createMacTools(d: MacToolDeps): ToolDef[] {
  const allowedApps = new Set(d.policy.macos.apps.map((a) => a.toLowerCase()));
  const shortcutLevels = new Map(
    d.policy.macos.shortcuts.map((s) => [s.name.toLowerCase(), s.level as 0 | 1 | 2 | 3]),
  );
  const deniedShortcuts = new Set(d.policy.macos.shortcuts_deny.map((s) => s.toLowerCase()));

  const projectsList = defineTool({
    name: 'projects_list',
    description:
      'List Brightky\'s projects (name, path, git branch, stack). Optional fuzzy filter, e.g. "codevault".',
    input: { query: z.string().max(100).optional() },
    classify: () => ({ level: N0, rule: 'macos.projects_list', reason: 'read-only' }),
    summarize: (a) => `List projects${a.query ? ` matching "${a.query}"` : ''}`,
    run: async (a) => {
      const q = a.query ? normalize(a.query) : '';
      const found = discoverProjects(d.policy).filter((p) => !q || normalize(p.name).includes(q));
      if (found.length === 0) return 'No matching project in the configured project folders.';
      return found
        .map((p) => `${p.name}\t${p.path}\t${p.branch ?? '-'}\t${p.kind.join(',') || '-'}`)
        .join('\n');
    },
  });

  const appOpen = defineTool({
    name: 'app_open',
    description:
      'Open a macOS application, optionally on a file or folder inside the allowed folders ' +
      '(e.g. app "Visual Studio Code" + a project path). Allowlisted apps are N1, others N2.',
    input: { app: z.string().min(1).max(60), path: z.string().max(1024).optional() },
    classify: (a, ctx): Classification => {
      if (!APP_NAME.test(a.app))
        return forbid('macos.invalid_app_name', 'unexpected characters in app name');
      const app = a.app.toLowerCase().replace(/\.app$/, '');
      if (EXECUTOR_APPS.has(app)) {
        return a.path
          ? forbid('macos.deny.executor_with_document', `${a.app} would execute the document`)
          : {
              level: N3,
              rule: 'macos.executor_app',
              reason: `${a.app} can run commands or change the system`,
            };
      }
      if (a.path) {
        const c = d.fs.check(a.path, 'read', ctx.cwd);
        if (c.level >= 4) return c;
      }
      return allowedApps.has(app)
        ? { level: N1, rule: 'macos.app.allowlisted', reason: 'allowlisted app' }
        : { level: N2, rule: 'macos.app.unlisted', reason: 'app not in the allowlist' };
    },
    summarize: (a) => `Open ${a.app}${a.path ? ` on ${a.path}` : ''}`,
    run: async (a, ctx) => {
      const args = ['-a', a.app.replace(/\.app$/i, '')];
      if (a.path) {
        const c = d.fs.check(a.path, 'read', ctx.cwd);
        if (c.level >= 4) throw new Error(c.reason);
        args.push(c.path);
      }
      await d.mac.open(args, ctx.signal);
      return `Opened ${a.app}${a.path ? ` on ${args.at(-1)}` : ''}.`;
    },
  });

  const urlOpen = defineTool({
    name: 'url_open',
    description:
      'Open an http(s) URL in the default browser (N1; N2 if the URL came from external content).',
    input: { url: z.string().max(2048) },
    classify: (a, ctx): Classification => {
      let u: URL;
      try {
        u = new URL(a.url);
      } catch {
        return forbid('macos.invalid_url', 'not a valid URL');
      }
      if (u.protocol !== 'https:' && u.protocol !== 'http:') {
        return forbid('macos.deny.url_scheme', `${u.protocol} URLs can launch local handlers`);
      }
      // A link planted in a mail or a page can carry data out in its query string.
      if (ctx.session.isExternalDestination(a.url)) {
        return {
          level: N2,
          rule: 'macos.url.external',
          reason: 'URL comes from external content',
          destinations: [a.url],
        };
      }
      return { level: N1, rule: 'macos.url', reason: 'opens a web page', destinations: [a.url] };
    },
    summarize: (a) => `Open ${a.url}`,
    run: async (a, ctx) => {
      await d.mac.open([new URL(a.url).href], ctx.signal);
      return `Opened ${a.url}.`;
    },
  });

  const appsRunning = defineTool({
    name: 'apps_running',
    description: 'List the applications currently open on the Mac.',
    input: {},
    classify: () => ({ level: N0, rule: 'macos.apps_running', reason: 'read-only' }),
    summarize: () => 'List open apps',
    run: async (_a, ctx) => (await d.mac.runningApps(ctx.signal)).join('\n'),
  });

  const shortcutsList = defineTool({
    name: 'shortcuts_list',
    description: 'List the Shortcuts (Raccourcis) available on the Mac.',
    input: {},
    classify: () => ({ level: N0, rule: 'macos.shortcuts_list', reason: 'read-only' }),
    summarize: () => 'List shortcuts',
    run: async (_a, ctx) => (await d.mac.shortcuts(ctx.signal)).join('\n') || 'No shortcuts.',
  });

  const shortcutRun = defineTool({
    name: 'shortcut_run',
    description:
      'Run a macOS Shortcut by name, optionally with text input. Level comes from the policy (unlisted: N3). ' +
      'Payment/money shortcuts are always refused.',
    input: { name: z.string().min(1).max(100), input: z.string().max(20_000).optional() },
    classify: (a): Classification => {
      const key = a.name.toLowerCase();
      if (PAYMENT_SHORTCUT.test(a.name))
        return forbid('macos.deny.shortcut_payment', 'payments and transfers are out of scope');
      if (deniedShortcuts.has(key))
        return forbid('macos.deny.shortcut_policy', 'shortcut denied by policy');
      const level = shortcutLevels.get(key);
      return level === undefined
        ? {
            level: N3,
            rule: 'macos.shortcut.unlisted',
            reason: 'a shortcut can do anything: not in the policy',
          }
        : { level, rule: 'macos.shortcut.policy', reason: 'level set in the policy' };
    },
    summarize: (a) =>
      `Run shortcut "${a.name}"${a.input ? ` with ${a.input.length} chars of input` : ''}`,
    ingestsExternal: true,
    run: async (a, ctx) => {
      let inputPath: string | null = null;
      if (a.input) {
        mkdirSync(d.scratchDir, { recursive: true, mode: 0o700 });
        inputPath = join(d.scratchDir, `shortcut-${randomUUID()}.txt`);
        writeFileSync(inputPath, a.input, { mode: 0o600 });
      }
      try {
        return (
          (await d.mac.runShortcut(a.name, inputPath, ctx.signal)) ||
          `Shortcut "${a.name}" ran (no output).`
        );
      } finally {
        if (inputPath) rmSync(inputPath, { force: true });
      }
    },
  });

  const systemStatus = defineTool({
    name: 'system_status',
    description: 'Battery / power source, uptime and free disk space of the Mac.',
    input: {},
    classify: () => ({ level: N0, rule: 'macos.system_status', reason: 'read-only' }),
    summarize: () => 'Read system status',
    run: async (_a, ctx) => d.mac.status(ctx.signal),
  });

  return [
    projectsList,
    appOpen,
    urlOpen,
    appsRunning,
    shortcutsList,
    shortcutRun,
    systemStatus,
  ] as unknown as ToolDef[];
}
