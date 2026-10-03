import { execFile } from 'node:child_process';
import { type Classification, forbid, N0, N2, N3, type Policy } from '@jarvis/policy';

export type OpsServer = Policy['ops']['servers'][number];
export type OpsApp = OpsServer['apps'][number];

/**
 * One word for the remote shell: single-quoted unless it is plainly safe, so the server runs exactly
 * this argv. `=` is not "plainly safe": an unquoted `X=1` before a command is an assignment that
 * would hide the real program from the classifier.
 */
export function shQuote(word: string): string {
  return /^[A-Za-z0-9_@%+:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

export const remoteCommand = (argv: readonly string[]) => argv.map(shQuote).join(' ');

/**
 * ssh arguments: Brightky's keys or agent (ssh reads them, never Jarvis), no password prompt, and
 * the server must already be in known_hosts (a changed host key is refused, not accepted).
 */
export function sshArgs(server: OpsServer, argv: readonly string[]): string[] {
  return [
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ServerAliveInterval=15',
    ...(server.port ? ['-p', String(server.port)] : []),
    server.user ? `${server.user}@${server.host}` : server.host,
    '--',
    remoteCommand(argv),
  ];
}

const flagsOnly = (allowed: RegExp) => (rest: readonly string[]) =>
  rest.every((a) => allowed.test(a));
const none = (rest: readonly string[]) => rest.length === 0;
/** Arguments that are names or paths, never options (a path cannot start with "-"). */
const plain = /^[^-]/;

/** Options that turn a reader into a writer, a runner or an endless stream. */
const NOT_READING = /^(--output|-o$|--ext-diff|--textconv|--exec|--follow$|-f$|--watch|-w$)/;
/** journalctl options that delete, rotate or move logs. */
const JOURNAL_WRITES =
  /^--(vacuum|rotate|flush|sync|relinquish|smart-relinquish|setup-keys|update-catalog|new-id128)/;

/**
 * Read-only commands Jarvis may run on a server without asking: an exact prefix and a check of
 * every remaining argument. Commands that print secrets are not here (kubectl get, docker inspect,
 * env, cat): they need Brightky's approval like any other command.
 */
const READ_ONLY: readonly {
  prefix: readonly string[];
  rest: (rest: readonly string[]) => boolean;
}[] = [
  { prefix: ['uptime'], rest: none },
  { prefix: ['hostname'], rest: none },
  { prefix: ['whoami'], rest: none },
  { prefix: ['nproc'], rest: none },
  { prefix: ['df'], rest: (r) => r.every((a) => /^-[hHTilP]+$/.test(a) || plain.test(a)) },
  { prefix: ['free'], rest: flagsOnly(/^-[bkmgthw]+$|^--(human|total|wide)$/) },
  { prefix: ['ls'], rest: (r) => r.every((a) => /^-[lahtrRS1dFG]+$/.test(a) || plain.test(a)) },
  // `ps e` / `ps -e…` variants with e in BSD syntax print the environment: only these forms.
  {
    prefix: ['ps'],
    rest: (r) => r.length === 0 || (r.length === 1 && ['aux', '-ef', '-e'].includes(r[0] ?? '')),
  },
  { prefix: ['docker', 'ps'], rest: flagsOnly(/^(-a|--all|--no-trunc|-q|--quiet|-s|--size)$/) },
  { prefix: ['docker', 'images'], rest: flagsOnly(/^(-a|--all|--no-trunc|-q|--quiet|--digests)$/) },
  {
    prefix: ['docker', 'stats', '--no-stream'],
    rest: (r) => r.every((a) => plain.test(a) || a === '--no-trunc'),
  },
  { prefix: ['docker', 'logs'], rest: (r) => r.every((a) => !NOT_READING.test(a)) },
  { prefix: ['docker', 'compose', 'ps'], rest: (r) => r.every((a) => !NOT_READING.test(a)) },
  { prefix: ['docker', 'compose', 'logs'], rest: (r) => r.every((a) => !NOT_READING.test(a)) },
  {
    prefix: ['systemctl', 'status'],
    rest: (r) =>
      r.every((a) => plain.test(a) || /^(--no-pager|-n\d*|--lines=\d+|-l|--full)$/.test(a)),
  },
  { prefix: ['systemctl', 'is-active'], rest: (r) => r.every((a) => plain.test(a)) },
  {
    prefix: ['systemctl', 'list-units'],
    rest: (r) => r.every((a) => plain.test(a) || /^--(type|state)=\w+$|^--no-pager$/.test(a)),
  },
  {
    prefix: ['journalctl'],
    rest: (r) => r.every((a) => !JOURNAL_WRITES.test(a) && !NOT_READING.test(a)),
  },
  { prefix: ['git', 'status'], rest: (r) => r.every((a) => !NOT_READING.test(a)) },
  { prefix: ['git', 'log'], rest: (r) => r.every((a) => !NOT_READING.test(a)) },
  {
    prefix: ['kubectl', 'describe'],
    rest: (r) => r.every((a) => !NOT_READING.test(a) && !a.startsWith('--kubeconfig')),
  },
  {
    prefix: ['kubectl', 'logs'],
    rest: (r) => r.every((a) => !NOT_READING.test(a) && !a.startsWith('--kubeconfig')),
  },
  { prefix: ['kubectl', 'top'], rest: (r) => r.every((a) => !a.startsWith('--kubeconfig')) },
  { prefix: ['nginx', '-t'], rest: none },
];

/** Run another program given as an argument: the real command would escape the checks. */
const WRAPPERS = new Set([
  'env',
  'nice',
  'ionice',
  'nohup',
  'timeout',
  'stdbuf',
  'time',
  'command',
  'exec',
  'builtin',
  'xargs',
  'watch',
  'chroot',
  'setsid',
  'unshare',
  'nsenter',
  'flock',
  'script',
  'busybox',
  'parallel',
]);
/** Network clients: data would leave the server, or something would come in. */
const NETWORK = new Set([
  'ssh',
  'scp',
  'sftp',
  'rsync',
  'nc',
  'ncat',
  'netcat',
  'socat',
  'telnet',
  'ftp',
  'tftp',
]);

/** Never, even with the PIN: destroys data, changes access, or runs code that cannot be read. */
const NEVER: Record<string, string> = {
  rm: 'suppression sur le serveur',
  rmdir: 'suppression sur le serveur',
  shred: 'suppression sur le serveur',
  dd: 'écriture brute sur un disque',
  mkfs: 'formatage',
  fdisk: 'partitionnement',
  sudo: 'élévation de privilèges (seulement dans un déploiement déclaré)',
  su: 'élévation de privilèges',
  doas: 'élévation de privilèges',
  passwd: 'mot de passe',
  chpasswd: 'mot de passe',
  useradd: 'comptes',
  userdel: 'comptes',
  usermod: 'comptes',
  chown: 'droits',
  chmod: 'droits',
  iptables: 'pare-feu',
  nft: 'pare-feu',
  ufw: 'pare-feu',
  shutdown: 'arrêt du serveur',
  reboot: 'redémarrage du serveur',
  halt: 'arrêt du serveur',
  poweroff: 'arrêt du serveur',
  crontab: 'tâches planifiées',
  curl: 'téléchargement (et exécution possible)',
  wget: 'téléchargement (et exécution possible)',
  eval: 'code non analysable',
  bash: 'shell : code non analysable',
  sh: 'shell : code non analysable',
  zsh: 'shell : code non analysable',
  python: 'interpréteur : code non analysable',
  python3: 'interpréteur : code non analysable',
  node: 'interpréteur : code non analysable',
  perl: 'interpréteur : code non analysable',
  ruby: 'interpréteur : code non analysable',
  php: 'interpréteur : code non analysable',
  dash: 'shell : code non analysable',
  fish: 'shell : code non analysable',
  ksh: 'shell : code non analysable',
  source: 'code non analysable',
};

const startsWith = (argv: readonly string[], prefix: readonly string[]) =>
  prefix.every((w, i) => argv[i] === w);

/** Sub-commands that destroy data or history (flags may come in any order after them). */
const NEVER_SUB: { rule: string; why: string; match: (argv: readonly string[]) => boolean }[] = [
  {
    rule: 'docker_prune',
    why: 'suppression de données Docker',
    match: (a) => a[0] === 'docker' && a.includes('prune'),
  },
  {
    rule: 'docker_rm',
    why: 'suppression de conteneurs ou de volumes',
    match: (a) =>
      a[0] === 'docker' &&
      (a[1] === 'rm' || (a[1] === 'volume' && a[2] === 'rm') || a[1] === 'rmi'),
  },
  {
    rule: 'compose_down_volumes',
    why: 'suppression de volumes (données)',
    match: (a) =>
      startsWith(a, ['docker', 'compose']) &&
      a.includes('down') &&
      (a.includes('-v') || a.includes('--volumes')),
  },
  {
    rule: 'kubectl_delete',
    why: 'suppression dans le cluster',
    match: (a) => a[0] === 'kubectl' && a[1] === 'delete',
  },
  {
    rule: 'terraform_destroy',
    why: 'destruction de l’infrastructure',
    match: (a) => a[0] === 'terraform' && (a[1] === 'destroy' || a.includes('-destroy')),
  },
  {
    rule: 'git_force',
    why: 'réécriture de l’historique',
    match: (a) =>
      a[0] === 'git' &&
      a[1] === 'push' &&
      a.some((x) => x === '-f' || x.startsWith('--force') || x.startsWith('+')),
  },
  {
    rule: 'git_reset_hard',
    why: 'perte de modifications',
    match: (a) => a[0] === 'git' && a[1] === 'reset' && a.includes('--hard'),
  },
  {
    rule: 'git_clean',
    why: 'suppression de fichiers',
    match: (a) => a[0] === 'git' && a[1] === 'clean',
  },
  {
    rule: 'find_exec',
    why: 'find qui supprime ou exécute',
    match: (a) =>
      a[0] === 'find' && a.some((x) => /^-(delete|exec|execdir|ok|okdir|fprint)/.test(x)),
  },
  {
    rule: 'truncate',
    why: 'vidage de fichiers',
    match: (a) => a[0] === 'truncate',
  },
];

/**
 * Level of a command Jarvis wants to run on a server. Reads are N0; anything else asks: the PIN on
 * production (N3), a confirmation elsewhere (N2); destructive or opaque commands are never run.
 */
export function classifyRemote(server: OpsServer, argv: readonly string[]): Classification {
  const [name = ''] = argv;
  if (argv.some((a) => /[\0\n\r]/.test(a))) return forbid('ops.invalid', 'caractère interdit');
  if (/=/.test(name) || !/^[A-Za-z0-9_./+-]+$/.test(name))
    return forbid(
      'ops.invalid_program',
      'le premier mot doit être un programme (pas d’affectation)',
    );
  const base = name.split('/').pop() ?? '';
  if (WRAPPERS.has(base))
    return forbid(`ops.deny.wrapper`, `${base} lance un autre programme : appelle-le directement`);
  if (NETWORK.has(base))
    return forbid(`ops.deny.network`, `${base} : sortie ou entrée de données réseau`);
  const never = NEVER[base] ?? (base.startsWith('mkfs') ? NEVER.mkfs : undefined);
  if (never) return forbid(`ops.deny.${base}`, `${base} : ${never}`);
  for (const r of NEVER_SUB) if (r.match(argv)) return forbid(`ops.deny.${r.rule}`, r.why);
  const read = READ_ONLY.find((r) => startsWith(argv, r.prefix));
  if (read?.rest(argv.slice(read.prefix.length)))
    return { level: N0, rule: 'ops.read', reason: `lecture sur ${server.id}` };
  return server.env === 'prod'
    ? { level: N3, rule: 'ops.exec.prod', reason: `modifie le serveur de production ${server.id}` }
    : {
        level: N2,
        rule: `ops.exec.${server.env}`,
        reason: `modifie le serveur ${server.id} (${server.env})`,
      };
}

/** A deploy changes production: the PIN there, a confirmation elsewhere. */
export function deployLevel(server: OpsServer): Classification {
  return server.env === 'prod'
    ? { level: N3, rule: 'ops.deploy.prod', reason: `déploie en production sur ${server.id}` }
    : {
        level: N2,
        rule: `ops.deploy.${server.env}`,
        reason: `déploie sur ${server.id} (${server.env})`,
      };
}

export interface RunResult {
  code: number | null;
  /** stdout and stderr, interleaved by stream, the end kept when long. */
  output: string;
  timedOut: boolean;
}

export interface SshRunner {
  run(
    server: OpsServer,
    argv: readonly string[],
    o: { timeoutMs: number; signal: AbortSignal; input?: string },
  ): Promise<RunResult>;
}

const tail = (s: string, max: number) => (s.length > max ? `[…]\n${s.slice(-max)}` : s);

/** /usr/bin/ssh, without a shell on this side. Output capped (the end matters: errors). */
export class OpenSsh implements SshRunner {
  readonly #maxChars: number;

  constructor(maxChars = 20_000) {
    this.#maxChars = maxChars;
  }

  run(
    server: OpsServer,
    argv: readonly string[],
    o: { timeoutMs: number; signal: AbortSignal; input?: string },
  ): Promise<RunResult> {
    return new Promise((resolve) => {
      let timedOut = false;
      const child = execFile(
        '/usr/bin/ssh',
        sshArgs(server, argv),
        { timeout: o.timeoutMs, maxBuffer: 20_000_000, signal: o.signal, env: sshEnv() },
        (err, stdout, stderr) => {
          if (err && (err as { killed?: boolean }).killed) timedOut = true;
          const code =
            err === null
              ? 0
              : typeof (err as { code?: unknown }).code === 'number'
                ? (err as { code: number }).code
                : null;
          resolve({
            code,
            output: tail(`${stdout}${stderr ? `\n${stderr}` : ''}`.trim(), this.#maxChars),
            timedOut,
          });
        },
      );
      if (o.input !== undefined) child.stdin?.end(o.input);
      else child.stdin?.end();
    });
  }
}

/** ssh needs HOME and the agent socket, nothing else from the daemon's environment. */
function sshEnv(): NodeJS.ProcessEnv {
  const keep = ['HOME', 'USER', 'LOGNAME', 'SSH_AUTH_SOCK', 'PATH', 'LANG'];
  return Object.fromEntries(keep.flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : [])));
}
