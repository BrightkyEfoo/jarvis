import {
  type Classification,
  defineTool,
  forbid,
  N0,
  N3,
  type Policy,
  type ToolDef,
} from '@jarvis/policy';
import type { Redactor } from '@jarvis/secrets';
import { z } from 'zod';
import type { RepoSecrets } from '../ops/secrets.ts';
import {
  classifyRemote,
  deployLevel,
  type OpsApp,
  type OpsServer,
  remoteCommand,
  type SshRunner,
} from '../ops/ssh.ts';
import { generatedSecret, VAULT_NAME, type Vault } from '../ops/vault.ts';

export interface OpsToolDeps {
  policy: Policy;
  ssh: SshRunner;
  vault: Vault;
  redactor: Redactor;
  secrets: RepoSecrets;
  keyPair: (comment: string) => Promise<{ privateKey: string; publicKey: string }>;
  knownHosts: (host: string, port?: number) => Promise<string>;
  fetch?: typeof fetch;
}

const serverId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
const repoPath = z.string().regex(/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+){1,5}$/);
/** CI secret names: upper case, never GitHub's reserved prefix. */
const secretName = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{0,99}$/, 'MAJUSCULES_ET_CHIFFRES')
  .refine((n) => !n.startsWith('GITHUB_'), 'GITHUB_ est réservé');

const done = (code: number | null, timedOut: boolean) =>
  timedOut
    ? 'interrompu (délai dépassé)'
    : code === 0
      ? 'terminé (code 0)'
      : `échec (code ${code ?? '?'})`;

/** GitHub Actions job using the restricted deploy key (the key can only run the deploy command). */
export function githubDeployWorkflow(branch: string): string {
  return `name: Deploy
on:
  push:
    branches: [${branch}]
  workflow_dispatch:
concurrency: deploy
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - name: Deploy over SSH (this key can only run the deploy command)
        env:
          KEY: \${{ secrets.DEPLOY_SSH_KEY }}
          KNOWN_HOSTS: \${{ secrets.DEPLOY_KNOWN_HOSTS }}
        run: |
          install -m 700 -d ~/.ssh
          printf '%s\\n' "$KEY" > ~/.ssh/deploy && chmod 600 ~/.ssh/deploy
          printf '%s\\n' "$KNOWN_HOSTS" > ~/.ssh/known_hosts
          ssh -i ~/.ssh/deploy -o StrictHostKeyChecking=yes -p "\${{ secrets.DEPLOY_PORT }}" \\
            "\${{ secrets.DEPLOY_USER }}@\${{ secrets.DEPLOY_HOST }}" deploy
`;
}

export function createOpsTools(d: OpsToolDeps): ToolDef[] {
  const servers = d.policy.ops.servers;
  const findServer = (id: string): OpsServer | undefined => servers.find((s) => s.id === id);
  const findApp = (s: OpsServer | undefined, id: string): OpsApp | undefined =>
    s?.apps.find((a) => a.id === id);
  const unknown = (id: string) =>
    forbid('ops.unknown_server', `${id} n'est pas déclaré dans la politique (ops.servers)`);

  const list = defineTool({
    name: 'ops_servers',
    description:
      'Servers Jarvis may reach over SSH and the apps it can deploy or read logs of (declared by Brightky ' +
      'in the sealed policy), plus the names (never values) in his vault.',
    input: {},
    classify: () => ({ level: N0, rule: 'ops.list', reason: 'read-only' }),
    summarize: () => 'List servers and deployable apps',
    run: async () => {
      if (servers.length === 0)
        return 'Aucun serveur déclaré. Ajoute-les dans la politique (section ops.servers) puis re-scelle-la.';
      const lines = servers.map((s) => {
        const apps = s.apps
          .map(
            (a) =>
              `${a.id}${a.deploy ? ' [déploiement ssh]' : a.coolify ? ' [Coolify]' : ''}${a.logs ? ' [logs]' : ''}${a.repo ? ` (${a.repo})` : ''}`,
          )
          .join(', ');
        return `- ${s.id} (${s.env}) : ${s.user ? `${s.user}@` : ''}${s.host}${s.port ? `:${s.port}` : ''}${apps ? ` — apps : ${apps}` : ''}`;
      });
      const vault = d.vault.names();
      return [
        ...lines,
        `Coffre : ${vault.length ? vault.join(', ') : 'vide (jarvis vault set NOM)'}`,
      ].join('\n');
    },
  });

  const run = defineTool({
    name: 'server_run',
    description:
      'Run one command (argv, no shell) on a declared server over SSH. Reads (status, logs, docker ps, ' +
      'systemctl status, df…) run directly; anything else asks Brightky: his PIN on production. ' +
      'Destructive commands (rm, sudo, prune, delete, destroy, curl…) are refused: deploy scripts declared ' +
      'in the policy do the privileged work.',
    input: {
      server: serverId,
      command: z.array(z.string().min(1).max(1000)).min(1).max(60),
      timeout_sec: z.number().int().min(5).max(600).optional(),
    },
    classify: (a): Classification => {
      const s = findServer(a.server);
      return s ? classifyRemote(s, a.command) : unknown(a.server);
    },
    summarize: (a) =>
      `Run on ${a.server}${findServer(a.server) ? ` (${findServer(a.server)?.env})` : ''}: ${a.command.join(' ').slice(0, 300)}`,
    ingestsExternal: true,
    run: async (a, ctx) => {
      const s = findServer(a.server);
      if (!s) throw new Error('serveur inconnu');
      const r = await d.ssh.run(s, a.command, {
        timeoutMs: (a.timeout_sec ?? 60) * 1000,
        signal: ctx.signal,
      });
      return `${a.server} : ${done(r.code, r.timedOut)}\n${r.output || '(aucune sortie)'}`;
    },
  });

  const logs = defineTool({
    name: 'server_logs',
    description:
      'Recent logs of a declared app on its server (the logs command Brightky declared).',
    input: { server: serverId, app: serverId },
    classify: (a): Classification => {
      const s = findServer(a.server);
      if (!s) return unknown(a.server);
      return findApp(s, a.app)?.logs
        ? { level: N0, rule: 'ops.logs', reason: 'lecture des logs' }
        : forbid('ops.no_logs', `pas de commande de logs déclarée pour ${a.app} sur ${a.server}`);
    },
    summarize: (a) => `Read logs of ${a.app} on ${a.server}`,
    ingestsExternal: true,
    run: async (a, ctx) => {
      const s = findServer(a.server);
      const app = findApp(s, a.app);
      if (!s || !app?.logs) throw new Error('application inconnue');
      const r = await d.ssh.run(s, app.logs, { timeoutMs: 60_000, signal: ctx.signal });
      return `${a.app}@${a.server} : ${done(r.code, r.timedOut)}\n${r.output || '(aucune sortie)'}`;
    },
  });

  const deploy = defineTool({
    name: 'deploy',
    description:
      'Deploy a declared app: runs the deploy command Brightky declared for it on its server (or triggers ' +
      'its Coolify webhook). Production needs his PIN and a conversation that has not read external ' +
      'content; staging/dev a confirmation. Report the outcome and the end of the output.',
    input: { server: serverId, app: serverId },
    classify: (a): Classification => {
      const s = findServer(a.server);
      if (!s) return unknown(a.server);
      const app = findApp(s, a.app);
      if (!app) return forbid('ops.unknown_app', `${a.app} n'est pas déclarée sur ${a.server}`);
      if (!app.deploy && !app.coolify)
        return forbid('ops.no_deploy', `aucun déploiement déclaré pour ${a.app}`);
      return deployLevel(s);
    },
    summarize: (a) => {
      const s = findServer(a.server);
      const app = findApp(s, a.app);
      const how = app?.coolify
        ? `Coolify ${app.coolify.uuid}`
        : app?.deploy
          ? remoteCommand(app.deploy).slice(0, 200)
          : '?';
      return `Deploy ${a.app} on ${a.server} (${s?.env ?? '?'}): ${how}`;
    },
    ingestsExternal: true,
    run: async (a, ctx) => {
      const s = findServer(a.server);
      const app = findApp(s, a.app);
      if (!s || !app) throw new Error('application inconnue');
      if (app.coolify) {
        const token = d.vault.read(app.coolify.token_vault);
        const url = new URL('/api/v1/deploy', app.coolify.url);
        url.searchParams.set('uuid', app.coolify.uuid);
        const res = await (d.fetch ?? fetch)(url, {
          headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)]),
        });
        const body = (await res.text()).slice(0, 2000);
        if (!res.ok) throw new Error(`Coolify a répondu ${res.status} : ${body}`);
        return `Déploiement de ${a.app} lancé sur Coolify.\n${body}`;
      }
      if (!app.deploy) throw new Error('aucun déploiement déclaré');
      const r = await d.ssh.run(s, app.deploy, {
        timeoutMs: d.policy.ops.deploy_timeout_sec * 1000,
        signal: ctx.signal,
      });
      return `Déploiement de ${a.app} sur ${a.server} : ${done(r.code, r.timedOut)}\n${r.output || '(aucune sortie)'}`;
    },
  });

  const secret = defineTool({
    name: 'repo_secret_set',
    description:
      'Set a CI secret (GitHub Actions secret or GitLab CI/CD variable) on a repository. The value never ' +
      "passes through you: it comes from Brightky's vault (vault: name, see ops_servers) or is generated " +
      '(generate: true, kept in the vault too). Always needs his PIN.',
    input: {
      forge: z.enum(['github', 'gitlab']).optional(),
      repo: repoPath,
      name: secretName,
      vault: z.string().regex(VAULT_NAME).optional(),
      generate: z.boolean().optional(),
    },
    classify: (a): Classification =>
      Boolean(a.vault) === Boolean(a.generate)
        ? forbid('input.invalid', 'choisis vault (nom dans le coffre) ou generate: true')
        : {
            level: N3,
            rule: 'ops.repo_secret',
            reason: 'un secret de CI peut déployer ou accéder à la production',
          },
    summarize: (a) =>
      `Set ${a.forge ?? 'github'} secret ${a.name} on ${a.repo} from ${a.vault ? `vault "${a.vault}"` : 'a generated value'}`,
    run: async (a) => {
      let value: string;
      if (a.vault) value = d.vault.read(a.vault);
      else {
        value = generatedSecret(d.redactor);
        d.vault.set(`gen.${a.name.toLowerCase()}`.slice(0, 40), value);
      }
      await d.secrets.set(a.forge ?? 'github', a.repo, a.name, value, { protected: true });
      return `Secret ${a.name} défini sur ${a.repo} (valeur jamais affichée)${a.generate ? `, copie gardée dans le coffre : gen.${a.name.toLowerCase()}` : ''}.`;
    },
  });

  const deployKey = defineTool({
    name: 'deploy_key_setup',
    description:
      'Wire continuous deployment for a declared app: generate an SSH key pair, install the public key on ' +
      "the server restricted to the app's deploy command (it can run nothing else), and store the private " +
      "key, host, user, port and known_hosts as CI secrets of the app's repository. Returns the CI job to " +
      'add. Always needs his PIN.',
    input: { server: serverId, app: serverId },
    classify: (a): Classification => {
      const s = findServer(a.server);
      if (!s) return unknown(a.server);
      const app = findApp(s, a.app);
      if (!app?.deploy)
        return forbid('ops.no_deploy', `aucune commande de déploiement déclarée pour ${a.app}`);
      if (!app.repo) return forbid('ops.no_repo', `aucun dépôt déclaré pour ${a.app} (champ repo)`);
      return { level: N3, rule: 'ops.deploy_key', reason: 'donne à la CI un accès au serveur' };
    },
    summarize: (a) => {
      const app = findApp(findServer(a.server), a.app);
      return `Set up CI deploy key for ${a.app} on ${a.server}: key restricted to its deploy command, secrets on ${app?.repo ?? '?'}`;
    },
    run: async (a, ctx) => {
      const s = findServer(a.server);
      const app = findApp(s, a.app);
      if (!s || !app?.deploy || !app.repo) throw new Error('application incomplète');
      const known = await d.knownHosts(s.host, s.port);
      const pair = await d.keyPair(`jarvis-deploy:${app.id}`);
      d.redactor.register('deploy_private_key', pair.privateKey);
      // Whatever the CI asks, the server runs only this app's deploy command.
      const forced = remoteCommand(app.deploy).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
      const line = `restrict,command="${forced}" ${pair.publicKey}`;
      const install = [
        'sh',
        '-c',
        'umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && (grep -qxF "$1" ~/.ssh/authorized_keys || printf "%s\\n" "$1" >> ~/.ssh/authorized_keys)',
        'jarvis',
        line,
      ];
      const r = await d.ssh.run(s, install, { timeoutMs: 30_000, signal: ctx.signal });
      if (r.code !== 0)
        throw new Error(
          `installation de la clé sur ${s.id} : ${done(r.code, r.timedOut)} ${r.output}`,
        );
      const forge = app.forge;
      const set = (name: string, value: string) =>
        d.secrets.set(forge, app.repo as string, name, value, { protected: true });
      await set('DEPLOY_SSH_KEY', pair.privateKey);
      await set('DEPLOY_HOST', s.host);
      await set('DEPLOY_USER', s.user ?? 'root');
      await set('DEPLOY_PORT', String(s.port ?? 22));
      await set('DEPLOY_KNOWN_HOSTS', known);
      return [
        `Clé de déploiement installée sur ${s.id}, limitée à : ${remoteCommand(app.deploy)}`,
        `Secrets définis sur ${app.repo} : DEPLOY_SSH_KEY, DEPLOY_HOST, DEPLOY_USER, DEPLOY_PORT, DEPLOY_KNOWN_HOSTS.`,
        forge === 'github'
          ? `Workflow à ajouter dans .github/workflows/deploy.yml (Brightky le relit et le pousse ; les workers ne touchent jamais à la CI) :\n${githubDeployWorkflow('main')}`
          : 'Côté GitLab : un job qui écrit $DEPLOY_SSH_KEY (variable fichier) et lance ssh vers $DEPLOY_USER@$DEPLOY_HOST.',
      ].join('\n');
    },
  });

  return [list, run, logs, deploy, secret, deployKey] as unknown as ToolDef[];
}
