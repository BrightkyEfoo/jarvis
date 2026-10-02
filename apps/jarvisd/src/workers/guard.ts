import { basename, relative, sep } from 'node:path';
import { FsPolicy, type PathError, parseShell, ShellParseError } from '@jarvis/policy';

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
}

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
      }
    }
    return allow('worker.shell', 'sandboxed command');
  };

  return (tool, input) => {
    const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined);
    switch (tool) {
      case 'Read':
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
