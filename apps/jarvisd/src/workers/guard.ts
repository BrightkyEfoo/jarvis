import { basename, relative, sep } from 'node:path';
import { FsPolicy, type PathError, parseShell, ShellParseError } from '@jarvis/policy';
import { auditIndex, flagValue, isBrowser, loopbackUrl, shellWords, type UiTools } from './ui.ts';

export interface GuardVerdict {
  allow: boolean;
  rule: string;
  reason: string;
}

const allow = (rule: string, reason = 'allowed'): GuardVerdict => ({ allow: true, rule, reason });
const deny = (rule: string, reason: string): GuardVerdict => ({ allow: false, rule, reason });

/** Never, even sandboxed: privilege, credentials, network clients, other machines, publishing. */
const DENY_PROGRAMS: Record<string, string> = {
  sudo: 'privilege escalation',
  su: 'privilege escalation',
  doas: 'privilege escalation',
  security: 'Keychain access',
  osascript: 'drives other apps',
  open: 'opens apps outside the worktree',
  launchctl: 'system services',
  defaults: 'system preferences',
  crontab: 'scheduled jobs',
  curl: 'network client: data could leave the Mac',
  wget: 'network client: data could leave the Mac',
  ssh: 'remote shell',
  scp: 'remote copy',
  sftp: 'remote copy',
  rsync: 'remote copy',
  nc: 'raw network',
  ncat: 'raw network',
  netcat: 'raw network',
  socat: 'raw network',
  telnet: 'raw network',
  ftp: 'raw network',
  gh: 'acts on GitHub as Brightky: Jarvis does that itself, after review',
  glab: 'acts on GitLab as Brightky: Jarvis does that itself, after review',
  docker: 'escapes the sandbox',
  podman: 'escapes the sandbox',
  kubectl: 'production infrastructure',
  terraform: 'production infrastructure',
  aws: 'cloud account',
  gcloud: 'cloud account',
  az: 'cloud account',
  vercel: 'deployment',
  netlify: 'deployment',
  heroku: 'deployment',
  flyctl: 'deployment',
  dd: 'raw disk writes',
  diskutil: 'disks',
  shutdown: 'power control',
  reboot: 'power control',
  passwd: 'password change',
  dscl: 'accounts',
  eval: 'unanalysable code',
  exec: 'replaces the shell',
};

/** git subcommands that publish, re-point or configure: Jarvis pushes itself after review. */
const GIT_DENY = new Set([
  'push',
  'remote',
  'config',
  'credential',
  'send-email',
  'request-pull',
  'filter-branch',
  'filter-repo',
  'submodule',
  'daemon',
  'http-backend',
  'clone',
]);
const PUBLISH = new Set([
  'publish',
  'login',
  'logout',
  'adduser',
  'token',
  'owner',
  'deprecate',
  'unpublish',
  'dist-tag',
]);
const PACKAGE_MANAGERS = new Set([
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'cargo',
  'gem',
  'twine',
  'poetry',
  'uv',
]);
const DELETE = new Set(['rm', 'rmdir', 'unlink']);

/** Paths a worker never writes even inside its worktree: CI runs with the repo's secrets. */
export const PROTECTED = [
  /^\.git(\/|$)/,
  /^\.github\/workflows\//,
  /^\.gitlab-ci\.ya?ml$/,
  /^\.gitlab\/ci\//,
  /^\.circleci\//,
  /(^|\/)\.env(\.|$)/,
  /\.pem$/,
  /(^|\/)id_(rsa|ed25519|ecdsa)/,
];

export interface WorkerGuardOptions {
  worktree: string;
  home: string;
  /** Paths denied on top of the built-in list (policy.filesystem.deny). */
  extraDeny: readonly string[];
  /** Browser checks of a web frontend (ADR-036); absent, the guard is exactly the S6 one. */
  ui?: WorkerUiGuard;
}

export interface WorkerUiGuard {
  /** Loopback ports the headless browser and the audits may open. */
  ports: readonly number[];
  /** The task's folder for screenshots, reports and the throwaway profile (outside the repo). */
  dir: string;
  /** Audit tools the project declares: the others are never fetched on the fly. */
  tools: UiTools;
}

/** Flags that name the address a dev server listens on. */
const HOST_FLAGS = new Set(['--host', '--hostname', '-H', '--bind', '--listen']);
const ANY_ADDRESS = new Set(['0.0.0.0', '::', '[::]', '::0']);
/** Browser flags that would open it to other processes, other pages or Brightky's profiles. */
const BROWSER_DENY = new Set([
  '--remote-debugging-port',
  '--remote-debugging-address',
  '--remote-allow-origins',
  '--load-extension',
  '--disable-extensions-except',
  '--disable-web-security',
  '--allow-file-access-from-files',
  '--profile-directory',
  '--app',
  '--proxy-server',
  '--proxy-pac-url',
  '--host-resolver-rules',
  '--enable-logging',
]);
/** Browser flags that write files: only in the task's folder. */
const BROWSER_OUTPUT = new Set([
  '--screenshot',
  '--print-to-pdf',
  '--user-data-dir',
  '--crash-dumps-dir',
  '--disk-cache-dir',
]);
/** Packages that `npx` or `dlx` would download just to check a page. */
const UI_PACKAGES: Record<string, keyof UiTools> = {
  lighthouse: 'lighthouse',
  axe: 'axe',
  '@axe-core/cli': 'axe',
  playwright: 'playwright',
  '@playwright/test': 'playwright',
};

/**
 * Decides every tool call of a Claude Code worker. The worker only reads and writes its own git
 * worktree; Bash also runs in Claude Code's macOS sandbox (writes confined, network allowlisted),
 * so the command rules here only stop what the sandbox cannot judge: credentials, publishing,
 * remote machines, CI configuration.
 */
export function workerGuard(
  o: WorkerGuardOptions,
): (tool: string, input: Record<string, unknown>) => GuardVerdict {
  const fs = new FsPolicy({
    home: o.home,
    readRoots: [o.worktree],
    writeRoots: [o.worktree],
    extraDeny: o.extraDeny,
  });
  const root = fs.resolve(o.worktree, o.worktree);

  const inside = (path: string, mode: 'read' | 'write'): GuardVerdict => {
    let abs: string;
    try {
      abs = fs.resolve(path, root);
    } catch (e) {
      return deny('worker.path.invalid', (e as PathError).message);
    }
    const rel = relative(root, abs);
    if (rel.startsWith('..') || rel.startsWith(sep) || /^[a-z]:/i.test(rel)) {
      return deny('worker.path.outside', `${path} is outside the worktree`);
    }
    const posix = rel.split(sep).join('/');
    if (mode === 'write' && PROTECTED.some((re) => re.test(posix))) {
      return deny(
        'worker.path.protected',
        `${posix} is protected (git internals, CI configuration, secrets)`,
      );
    }
    const c = fs.check(abs, mode, root);
    return c.level >= 3 ? deny(c.rule, c.reason) : allow(`worker.${mode}`);
  };

  const ui = o.ui;
  const uiRoot = ui ? fs.resolve(ui.dir, root) : '';
  const inUi = (path: string): boolean => {
    if (!ui) return false;
    let abs: string;
    try {
      abs = fs.resolve(path, root);
    } catch {
      return false;
    }
    const rel = relative(uiRoot, abs);
    return !rel.startsWith('..') && !rel.startsWith(sep) && !/^[a-z]:/i.test(rel);
  };

  /** Extra rules of a frontend task; null when none applies to this command. */
  const uiCommand = (argv: readonly string[], u: WorkerUiGuard): GuardVerdict | null => {
    const [bin = '', ...args] = argv;
    const base = basename(bin).toLowerCase();

    // A dev server stays on loopback: on 0.0.0.0 the local network could reach it.
    for (let i = 0; i < args.length; i++) {
      const a = args[i] ?? '';
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(0, eq) : a;
      if (!HOST_FLAGS.has(name)) continue;
      const value = eq > 0 ? a.slice(eq + 1) : args[i + 1];
      if (ANY_ADDRESS.has(value ?? '') || (name === '--host' && (!value || value.startsWith('-'))))
        return deny(
          'worker.ui.bind_all',
          `${a}: the dev server listens on 127.0.0.1 only (e.g. --host 127.0.0.1)`,
        );
    }

    // Nothing is downloaded for a check: no browser bundles, no one-shot audit tools.
    const pw = argv.findIndex((a) => basename(a) === 'playwright');
    if (pw >= 0 && ['install', 'install-deps'].includes(argv[pw + 1] ?? ''))
      return deny(
        'worker.ui.no_download',
        "playwright install: browsers are never downloaded (metered connection); the Mac's Chrome takes the screenshots",
      );
    const dlx = (base === 'pnpm' || base === 'yarn') && argv[1] === 'dlx';
    if (base === 'npx' || base === 'bunx' || dlx || (base === 'npm' && argv[1] === 'exec')) {
      const spec = argv.slice(1).find((a) => !a.startsWith('-') && a !== 'dlx' && a !== 'exec');
      const name = spec?.replace(/^(@[^/]+\/[^@]+|[^@]+)@.*$/, '$1') ?? '';
      const tool = UI_PACKAGES[name];
      if (tool && (dlx || !u.tools[tool]))
        return deny(
          'worker.ui.no_download',
          `${name} is not a dependency of this project: it is never downloaded for a check`,
        );
    }

    // The Mac's browser: headless, throwaway profile, files in the task's folder, loopback only.
    if (isBrowser(bin)) {
      if (!args.some((a) => a === '--headless' || a.startsWith('--headless=')))
        return deny('worker.ui.browser', 'the browser runs headless only (--headless=new)');
      const profile = args.find((a) => a.startsWith('--user-data-dir='));
      if (!profile || !inUi(profile.slice('--user-data-dir='.length)))
        return deny(
          'worker.ui.browser',
          `a throwaway profile is required: --user-data-dir=<folder in ${u.dir}>`,
        );
      for (const a of args) {
        const name = a.split('=')[0] ?? a;
        if (BROWSER_DENY.has(name)) return deny('worker.ui.browser', `${name} is not allowed`);
        if (BROWSER_OUTPUT.has(name)) {
          const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : '';
          if (!v || !inUi(v))
            return deny('worker.ui.output', `${name} writes only in ${u.dir} (${name}=<path>)`);
        }
        if (!a.startsWith('-') && !loopbackUrl(a, u.ports))
          return deny(
            'worker.ui.url',
            `${a}: only http://127.0.0.1:<port>/ on ports ${u.ports.join(', ')}`,
          );
      }
      return null;
    }

    // Lighthouse and axe: loopback pages only, reports in the task's folder.
    const at = auditIndex(argv);
    if (at < 0) return null;
    const tool = basename(argv[at] ?? '');
    const rest = argv.slice(at + 1);
    for (const a of rest) {
      if (a.startsWith('-') || !a.includes('://')) continue;
      for (const url of a.split(','))
        if (!loopbackUrl(url, u.ports))
          return deny(
            'worker.ui.url',
            `${url}: only http://127.0.0.1:<port>/ on ports ${u.ports.join(', ')}`,
          );
    }
    const chromeFlags = shellWords(flagValue(rest, '--chrome-flags') ?? '');
    const bad = chromeFlags.find((f) => BROWSER_DENY.has(f.split('=')[0] ?? f));
    if (bad) return deny('worker.ui.browser', `${bad} is not allowed`);
    const profile = flagValue(chromeFlags, '--user-data-dir');
    if (profile !== undefined && !inUi(profile))
      return deny('worker.ui.browser', `--user-data-dir must be in ${u.dir}`);
    if (tool === 'lighthouse') {
      const out = flagValue(rest, '--output-path');
      if (!out || !inUi(out))
        return deny(
          'worker.ui.output',
          `lighthouse writes its report in ${u.dir} only: --output-path=<file in that folder>`,
        );
    } else if (rest.some((a) => a === '--save' || a === '-s' || a.startsWith('--save='))) {
      const dir = flagValue(rest, '--dir');
      if (!dir || !inUi(dir))
        return deny('worker.ui.output', `axe saves its results in ${u.dir} only: --dir <folder>`);
    }
    return null;
  };

  const bash = (command: string): GuardVerdict => {
    let plan: ReturnType<typeof parseShell>;
    try {
      plan = parseShell(command, o.home);
    } catch (e) {
      const msg = e instanceof ShellParseError ? e.message : String(e);
      return deny('worker.shell.parse', `${msg}: write a script file in the worktree instead`);
    }
    for (const step of plan.steps) {
      for (const cmd of step.pipeline.commands) {
        const [name = '', ...args] = cmd.argv;
        const base = basename(name).toLowerCase();
        const why = DENY_PROGRAMS[base];
        if (why) return deny(`worker.shell.deny.${base}`, `${base}: ${why}`);
        if (base === 'git') {
          const sub = args.find((a) => !a.startsWith('-')) ?? '';
          if (
            args.some(
              (a) =>
                a === '-c' ||
                a.startsWith('--exec-path') ||
                a.startsWith('--git-dir') ||
                a.startsWith('--work-tree'),
            )
          ) {
            return deny('worker.shell.git_override', 'git configuration overrides are not allowed');
          }
          if (GIT_DENY.has(sub))
            return deny(
              `worker.shell.git.${sub}`,
              `git ${sub}: Jarvis publishes the branch itself after review`,
            );
        }
        if (PACKAGE_MANAGERS.has(base) && args.some((a) => PUBLISH.has(a))) {
          return deny(
            'worker.shell.publish',
            `${base} ${args.join(' ')}: never publish or log in from a worker`,
          );
        }
        if (DELETE.has(base)) {
          for (const a of args.filter((x) => !x.startsWith('-'))) {
            const v = inside(a, 'write');
            if (!v.allow) return deny('worker.shell.delete_outside', `${base} ${a}: ${v.reason}`);
          }
        }
        for (const r of cmd.redirects) {
          if (r.op === 'dup' || r.target === '/dev/null') continue;
          const v = inside(r.target, r.op === '<' ? 'read' : 'write');
          if (!v.allow)
            return deny('worker.shell.redirect', `redirect to ${r.target}: ${v.reason}`);
        }
        if (ui) {
          const v = uiCommand(cmd.argv, ui);
          if (v) return v;
        }
      }
    }
    return allow('worker.shell', 'sandboxed command');
  };

  return (tool, input) => {
    const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined);
    switch (tool) {
      case 'Read': {
        // Frontend tasks: the worker looks at its own screenshots.
        const path = str('file_path') ?? str('notebook_path') ?? '';
        if (ui && path && inUi(path)) return allow('worker.ui.read');
        return inside(path, 'read');
      }
      case 'NotebookRead':
        return inside(str('file_path') ?? str('notebook_path') ?? '', 'read');
      case 'Glob':
      case 'Grep':
      case 'LS':
        return inside(str('path') ?? root, 'read');
      case 'Write':
      case 'Edit':
      case 'MultiEdit':
      case 'NotebookEdit':
        return inside(str('file_path') ?? str('notebook_path') ?? '', 'write');
      case 'Bash':
        return bash(str('command') ?? '');
      case 'BashOutput':
      case 'KillShell':
      case 'KillBash':
      case 'TodoWrite':
        return allow(`worker.${tool}`);
      default:
        return deny('worker.tool', `${tool} is not available to workers`);
    }
  };
}
