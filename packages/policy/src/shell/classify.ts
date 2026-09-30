import { basename } from 'node:path';
import { type Classification, type Level, N0, N1, N2, N3, N4 } from '../levels.ts';
import type { Policy } from '../load.ts';
import type { FsMode, FsPolicy } from '../paths.ts';
import type { ShellPlan, SimpleCommand } from './parse.ts';

/** Hardcoded N4. policy.yaml cannot allowlist any of these. */
const DENY_COMMANDS: Record<string, string> = {
  rm: 'permanent deletion: use the Trash (fs_trash) instead',
  rmdir: 'permanent deletion: use the Trash (fs_trash) instead',
  unlink: 'permanent deletion: use the Trash (fs_trash) instead',
  shred: 'irreversible destruction',
  srm: 'irreversible destruction',
  sudo: 'privilege escalation',
  su: 'privilege escalation',
  doas: 'privilege escalation',
  login: 'account switch',
  passwd: 'password change is N4 (Brightky does it himself)',
  chpass: 'account change',
  dscl: 'account/password database',
  dsenableroot: 'root account',
  sysadminctl: 'account administration',
  pwpolicy: 'password policy',
  dseditgroup: 'group administration',
  fdesetup: 'FileVault',
  csrutil: 'System Integrity Protection',
  spctl: 'Gatekeeper',
  socketfilterfw: 'firewall',
  pfctl: 'firewall',
  nvram: 'firmware variables',
  bless: 'boot configuration',
  kmutil: 'kernel extensions',
  kextload: 'kernel extensions',
  security: 'Keychain access',
  dd: 'raw disk writes',
  diskutil: 'disk erase/partition',
  asr: 'disk restore',
  newfs_apfs: 'filesystem creation',
  newfs_hfs: 'filesystem creation',
  tmutil: 'Time Machine snapshots',
  shutdown: 'power control',
  reboot: 'power control',
  halt: 'power control',
  // Wrappers that execute another command we would then fail to classify.
  env: 'command wrapper',
  xargs: 'command wrapper',
  exec: 'command wrapper',
  eval: 'command wrapper',
  command: 'command wrapper',
  builtin: 'command wrapper',
  nohup: 'command wrapper',
  time: 'command wrapper',
  nice: 'command wrapper',
  timeout: 'command wrapper',
  watch: 'command wrapper',
  parallel: 'command wrapper',
  source: 'command wrapper',
  '.': 'command wrapper',
};

const INTERPRETERS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'csh',
  'tcsh',
  'python',
  'python3',
  'node',
  'deno',
  'bun',
  'perl',
  'ruby',
  'php',
  'lua',
  'tclsh',
  'osascript',
  'swift',
  'awk',
  'gawk',
  'expect',
  'jshell',
]);
const INLINE_CODE_FLAGS = new Set(['-c', '-e', '-E', '-p', '--eval', '--print', '-exec']);

/** Commands whose path arguments are written, not read. */
const WRITERS = new Set([
  'cp',
  'mv',
  'mkdir',
  'touch',
  'ln',
  'tee',
  'install',
  'rsync',
  'ditto',
  'truncate',
]);

const FIND_EXEC = new Set([
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-delete',
  '-fprint',
  '-fprint0',
  '-fprintf',
  '-fls',
]);

const GIT_GLOBAL_WITH_VALUE = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--config-env',
]);
const GIT_DANGEROUS_GLOBAL = new Set([
  '-c',
  '--config-env',
  '--exec-path',
  '--git-dir',
  '--work-tree',
]);
const GIT_FORCE = new Set([
  '-f',
  '--force',
  '--force-with-lease',
  '--force-if-includes',
  '--mirror',
  '--delete',
  '-d',
  '--prune',
]);
const PROTECTED_BRANCHES = new Set([
  'main',
  'master',
  'refs/heads/main',
  'refs/heads/master',
  'head',
]);

interface Verdict extends Classification {
  /** Per-command detail kept for the approval prompt and the audit log. */
  command: string;
}

const v = (level: Level, rule: string, reason: string, command: string): Verdict => ({
  level,
  rule,
  reason,
  command,
});

/** Keeps the first verdict on ties: used across commands. */
function worst(a: Verdict, b: Verdict): Verdict {
  return b.level > a.level ? b : a;
}

/** Within one command an escalation is more specific than the base rule, so it wins ties. */
function escalate(a: Verdict, b: Verdict): Verdict {
  return b.level >= a.level ? b : a;
}

function looksLikeUrl(s: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
}

function gitSplit(args: string[]): { globals: string[]; sub: string | null; rest: string[] } {
  const globals: string[] = [];
  let i = 0;
  while (i < args.length) {
    const a = args[i] as string;
    if (!a.startsWith('-')) break;
    globals.push(a);
    if (GIT_GLOBAL_WITH_VALUE.has(a) && i + 1 < args.length) globals.push(args[++i] as string);
    i++;
  }
  return { globals, sub: args[i] ?? null, rest: args.slice(i + 1) };
}

function classifyGit(args: string[], display: string): Verdict | null {
  const { globals, sub, rest } = gitSplit(args);
  for (const g of globals) {
    const flag = g.split('=')[0] as string;
    if (GIT_DANGEROUS_GLOBAL.has(flag)) {
      return v(
        N4,
        'shell.deny.git_config_override',
        `git ${flag} can run arbitrary programs`,
        display,
      );
    }
  }
  if (
    rest.some(
      (a) =>
        a.startsWith('--output') ||
        a === '--upload-pack' ||
        a === '--receive-pack' ||
        a.startsWith('--exec='),
    )
  ) {
    return v(
      N3,
      'shell.git.side_channel_flag',
      'flag writes files or runs a helper program',
      display,
    );
  }
  if (sub === 'push') {
    const refspecs = rest.filter((a) => !a.startsWith('-')).slice(1); // first positional = remote
    const forced =
      rest.some((a) => GIT_FORCE.has(a)) ||
      refspecs.some((r) => r.startsWith('+') || r.startsWith(':'));
    const targets = refspecs.map((r) =>
      (r.replace(/^\+/, '').split(':').at(-1) ?? '').toLowerCase(),
    );
    const touchesProtected = targets.length === 0 || targets.some((t) => PROTECTED_BRANCHES.has(t));
    if (forced && touchesProtected) {
      return v(
        N4,
        'shell.deny.git_force_push_main',
        'force/delete push to main (or to an implicit target)',
        display,
      );
    }
    if (forced)
      return v(N3, 'shell.git.force_push', 'force/delete push rewrites a shared branch', display);
    if (touchesProtected) {
      return v(
        N3,
        'shell.git.push_main',
        targets.length === 0 ? 'push target is implicit' : 'direct push to main',
        display,
      );
    }
    return null; // plain push of a named branch: allowlist decides (N2 by default)
  }
  const destructive =
    sub === 'clean' ||
    (sub === 'reset' && rest.includes('--hard')) ||
    (sub === 'checkout' && rest.includes('--')) ||
    sub === 'restore' ||
    (sub === 'branch' && rest.some((a) => a === '-D' || a === '--delete' || a === '-d')) ||
    (sub === 'stash' && (rest[0] === 'drop' || rest[0] === 'clear')) ||
    sub === 'filter-branch' ||
    sub === 'update-ref' ||
    (sub === 'reflog' && rest[0] === 'expire');
  if (destructive)
    return v(N3, 'shell.git.destructive', `git ${sub} discards work irreversibly`, display);
  return null;
}

export interface ShellRules {
  allow: Policy['shell']['allow'];
  deny: Policy['shell']['deny'];
}

export interface ShellClassification extends Classification {
  commands: Verdict[];
}

/**
 * Levels a parsed plan. The result is the worst level over every command, redirect and path
 * argument. Rules are matched on the lowercased basename (APFS: `RM` runs /bin/rm).
 */
export class ShellClassifier {
  readonly #rules: ShellRules;
  readonly #fs: FsPolicy;

  constructor(rules: ShellRules, fs: FsPolicy) {
    this.#rules = rules;
    this.#fs = fs;
  }

  classify(plan: ShellPlan, cwd: string): ShellClassification {
    const commands: Verdict[] = [];
    for (const step of plan.steps) {
      step.pipeline.commands.forEach((cmd, i) => {
        commands.push(this.#command(cmd, cwd, i > 0));
      });
    }
    const top = commands.reduce(worst);
    return { level: top.level, rule: top.rule, reason: `${top.command}: ${top.reason}`, commands };
  }

  #path(arg: string, mode: FsMode, cwd: string, display: string): Verdict | null {
    if (looksLikeUrl(arg)) return null;
    const c = this.#fs.check(arg, mode, cwd);
    return c.level > N0 ? v(c.level, c.rule, c.reason, display) : null;
  }

  #command(cmd: SimpleCommand, cwd: string, piped: boolean): Verdict {
    const [name = '', ...args] = cmd.argv;
    const display = cmd.argv.join(' ').slice(0, 200);
    const base = basename(name).toLowerCase();

    const builtin = DENY_COMMANDS[base];
    if (builtin) return v(N4, `shell.deny.${base}`, builtin, display);

    const userDeny = this.#rules.deny.find(
      (d) => d.cmd.toLowerCase() === base && (!d.sub || d.sub.includes(args[0] ?? '')),
    );
    if (userDeny) return v(N4, `shell.deny.policy.${base}`, userDeny.reason, display);

    if (INTERPRETERS.has(base)) {
      if (piped)
        return v(
          N4,
          'shell.deny.pipe_to_interpreter',
          'piping data into an interpreter runs untrusted code',
          display,
        );
      if (args.some((a) => INLINE_CODE_FLAGS.has(a)))
        return v(N4, 'shell.deny.inline_code', 'inline code cannot be analysed', display);
    }
    if (base === 'find' && args.some((a) => FIND_EXEC.has(a))) {
      return v(
        N4,
        'shell.deny.find_exec',
        'find -exec/-delete runs or deletes without review',
        display,
      );
    }

    // Allowlist on (command, subcommand); git subcommands come after its global options.
    const sub = base === 'git' ? gitSplit(args).sub : (args[0] ?? null);
    const rule = this.#rules.allow.find(
      (r) => r.cmd.toLowerCase() === base && (!r.sub || (sub !== null && r.sub.includes(sub))),
    );
    let out = rule
      ? v(rule.level as Level, `shell.allow.${base}`, rule.reason ?? 'allowlisted', display)
      : v(N3, 'shell.unlisted', 'command is not in the allowlist', display);

    if (base === 'git') {
      const g = classifyGit(args, display);
      if (g?.level === N4) return g;
      if (g) out = escalate(out, g);
      // A push always speaks outside the machine, whatever the allowlist says.
      if (sub === 'push')
        out = escalate(out, v(N2, 'shell.git.push', 'publishes commits', display));
    }
    if (name.includes('/')) {
      out = escalate(
        out,
        v(N3, 'shell.path_invocation', 'binary invoked by path, not from the system PATH', display),
      );
    }

    // Every argument that could be a path is checked like a file access (`--out=/x` included).
    const mode: FsMode = WRITERS.has(base) ? 'write' : 'read';
    for (const a of args) {
      const value = a.startsWith('-') ? (a.includes('=') ? a.slice(a.indexOf('=') + 1) : '') : a;
      if (value === '') continue;
      const p = this.#path(value, mode, cwd, display);
      if (p?.level === N4) return p;
      if (p) out = escalate(out, p);
    }
    for (const r of cmd.redirects) {
      if (r.op === 'dup') continue;
      const p = this.#path(r.target, r.op === '<' ? 'read' : 'write', cwd, display);
      if (p?.level === N4) return p;
      if (p) out = escalate(out, p);
      if (r.op !== '<')
        out = escalate(out, v(N1, 'shell.redirect.write', 'writes a file', display));
    }
    return out;
  }
}
