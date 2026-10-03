import { execFile } from 'node:child_process';
import { type Classification, forbid, N0, N2, N3, type Policy } from '@jarvis/policy';

export type OpsServer = Policy['ops']['servers'][number];
export type OpsApp = OpsServer['apps'][number];

/** One word for the remote shell: single-quoted, so the server runs exactly this argv. */
export function shQuote(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
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

/** Read-only commands Jarvis may run on a server without asking (argv prefixes). */
const READ_ONLY: readonly (readonly string[])[] = [
  ['uptime'],
  ['hostname'],
  ['whoami'],
  ['nproc'],
  ['df'],
  ['free'],
  ['ls'],
  ['ps'],
  ['docker', 'ps'],
  ['docker', 'images'],
  ['docker', 'logs'],
  ['docker', 'stats', '--no-stream'],
  ['docker', 'inspect'],
  ['docker', 'compose', 'ps'],
  ['docker', 'compose', 'logs'],
  ['systemctl', 'status'],
  ['systemctl', 'is-active'],
  ['systemctl', 'list-units'],
  ['journalctl'],
  ['git', 'status'],
  ['git', 'log'],
  ['kubectl', 'get'],
  ['kubectl', 'describe'],
  ['kubectl', 'logs'],
  ['kubectl', 'top'],
  ['nginx', '-t'],
];

/** Options that turn a reader into a writer or a runner (git log --output, docker logs is safe…). */
const WRITE_FLAGS = /^(--output|-o$|--exec|--follow$|-f$|--watch|-w$)/;

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
];

/**
 * Level of a command Jarvis wants to run on a server. Reads are N0; anything else asks: the PIN on
 * production (N3), a confirmation elsewhere (N2); destructive or opaque commands are never run.
 */
export function classifyRemote(server: OpsServer, argv: readonly string[]): Classification {
  const [name = ''] = argv;
  const base = name.split('/').pop() ?? '';
  const never = NEVER[base] ?? (base.startsWith('mkfs') ? NEVER.mkfs : undefined);
  if (never) return forbid(`ops.deny.${base}`, `${base} : ${never}`);
  for (const r of NEVER_SUB) if (r.match(argv)) return forbid(`ops.deny.${r.rule}`, r.why);
  if (argv.some((a) => /[\0\n\r]/.test(a))) return forbid('ops.invalid', 'caractère interdit');
  const reads =
    READ_ONLY.some((p) => startsWith(argv, p)) && !argv.some((a) => WRITE_FLAGS.test(a));
  if (reads) return { level: N0, rule: 'ops.read', reason: `lecture sur ${server.id}` };
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
