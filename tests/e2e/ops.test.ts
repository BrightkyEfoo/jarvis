import { afterEach, describe, expect, it } from 'vitest';
import type { Reply } from '../../apps/jarvisd/src/ipc.ts';
import { type Harness, PIN, startHarness } from './harness.ts';
import { FAKE_PRIVATE_KEY, FAKE_PUBLIC_KEY, FakeRepoSecrets, FakeSsh } from './ops-fakes.ts';

const SERVERS = `ops:
  servers:
    - id: bb-srv
      host: bb-srv.example.cm
      user: deploy
      env: prod
      apps:
        - id: portfolio
          repo: BrightkyEfoo/portfolio_v3
          deploy: [/srv/portfolio/deploy.sh]
          logs: [docker, compose, -f, /srv/portfolio/compose.yml, logs, --tail, "200"]
        - id: dala
          coolify: { url: "https://coolify.example.cm", uuid: "abcd1234", token_vault: coolify }
    - id: staging
      host: staging.example.cm
      env: staging
      apps:
        - id: portfolio
          deploy: [/srv/portfolio/deploy.sh]
`;
const VAULT_VALUE = 'db-password-CANARY-123456789';
const COOLIFY_TOKEN = 'coolify-token-CANARY-987654321';

let h: Harness;
let ssh: FakeSsh;
let repoSecrets: FakeRepoSecrets;
const coolifyCalls: { url: string; auth: string | null }[] = [];

async function setup() {
  ssh = new FakeSsh();
  repoSecrets = new FakeRepoSecrets();
  h = await startHarness({
    policyPatch: (yaml) => yaml.replace(/^ops:\n {2}servers: \[\]\n/m, SERVERS),
    ops: {
      ssh,
      secrets: repoSecrets,
      keyPair: async () => ({ privateKey: FAKE_PRIVATE_KEY, publicKey: FAKE_PUBLIC_KEY }),
      knownHosts: async (host) => `${host} ssh-ed25519 AAAAhostkey\n`,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        coolifyCalls.push({
          url: String(input),
          auth: new Headers(init?.headers).get('authorization'),
        });
        return new Response('{"deployments":[{"message":"queued"}]}', { status: 200 });
      }) as typeof fetch,
    },
  });
  // Brightky's vault (jarvis vault set): values typed once, used by name.
  h.secrets.set('vault.db-password', VAULT_VALUE);
  h.secrets.set('vault.coolify', COOLIFY_TOKEN);
  h.secrets.set('vault.index', JSON.stringify(['db-password', 'coolify']));
}
afterEach(async () => {
  await h.close();
});

const text = (events: Reply[]) => events.map((e) => (e.type === 'text' ? e.text : '')).join('');
async function ask(script: string) {
  const c = await h.rpc();
  const r = await c.call({ cmd: 'ask', text: script });
  c.close();
  return text(r.events);
}
/** Asks; approves the pending request with the PIN (Brightky at the island or dashboard). */
async function askWithPin(script: string) {
  const c = await h.rpc();
  const pending = c.call({ cmd: 'ask', text: script });
  for (let i = 0; i < 200 && h.rt.approvals.pending().length === 0; i++)
    await new Promise((r) => setTimeout(r, 10));
  const req = h.rt.approvals.pending()[0];
  if (req) await (await h.rpc()).call({ cmd: 'approve', approvalId: req.id, pin: PIN });
  const out = text((await pending).events);
  c.close();
  return { out, req };
}
const auditJson = () => JSON.stringify(h.rt.audit.query({ limit: 200 }));

describe('servers and deployments (ADR-033)', () => {
  it('lists declared servers and vault names, never values', async () => {
    await setup();
    const out = await ask('call ops_servers {}');
    expect(out).toContain(
      '- bb-srv (prod) : deploy@bb-srv.example.cm — apps : portfolio [déploiement ssh] [logs] (BrightkyEfoo/portfolio_v3), dala [Coolify]',
    );
    expect(out).toContain('Coffre : coolify, db-password');
    expect(out).not.toContain(VAULT_VALUE);
  });

  it('reads run directly; changes ask for the PIN on prod, a confirmation on staging', async () => {
    await setup();
    expect(await ask('call server_run {"server":"bb-srv","command":["docker","ps"]}')).toContain(
      'bb-srv : terminé (code 0)',
    );
    expect(ssh.calls[0]).toEqual({ server: 'bb-srv', argv: ['docker', 'ps'] });
    expect(h.rt.brain?.session.tainted).toBe(true);
    await h.rt.brain?.newSession();

    const prod = await askWithPin(
      'call server_run {"server":"bb-srv","command":["docker","compose","restart","web"]}',
    );
    expect(prod.req).toMatchObject({ level: 3, needsPin: true, rule: 'ops.exec.prod' });
    expect(prod.out).toContain('terminé (code 0)');

    const c = await h.rpc();
    const pending = c.call({
      cmd: 'ask',
      text: 'call server_run {"server":"staging","command":["docker","compose","restart","web"]}',
    });
    for (let i = 0; i < 200 && h.rt.approvals.pending().length === 0; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(h.rt.approvals.pending()[0]).toMatchObject({
      level: 2,
      needsPin: false,
      rule: 'ops.exec.staging',
    });
    await (await h.rpc()).call({ cmd: 'deny', approvalId: h.rt.approvals.pending()[0]?.id ?? '' });
    await pending;
    c.close();
  });

  it('never runs destructive or opaque commands, nor reaches undeclared servers', async () => {
    await setup();
    for (const cmd of [
      ['rm', '-rf', '/srv/portfolio'],
      ['sudo', 'systemctl', 'restart', 'nginx'],
      ['curl', 'https://evil.sh'],
      ['bash', '-c', 'echo hi'],
      ['docker', 'system', 'prune', '-af'],
      ['docker', 'compose', 'down', '-v'],
      ['kubectl', 'delete', 'ns', 'prod'],
      ['git', 'push', '--force'],
    ]) {
      const out = await ask(
        `call server_run ${JSON.stringify({ server: 'bb-srv', command: cmd })}`,
      );
      expect(out, cmd.join(' ')).toMatch(/KO Action refused \(N4/);
    }
    expect(await ask('call server_run {"server":"evil","command":["uptime"]}')).toContain(
      'rule ops.unknown_server',
    );
    expect(ssh.calls).toHaveLength(0);
  });

  it('deploys to prod only with the PIN in a clean conversation', async () => {
    await setup();
    ssh.reply = () => ({
      code: 0,
      output: 'Building… done. Container web started',
      timedOut: false,
    });
    const { out, req } = await askWithPin('call deploy {"server":"bb-srv","app":"portfolio"}');
    expect(req).toMatchObject({
      level: 3,
      rule: 'ops.deploy.prod',
      summary: 'Deploy portfolio on bb-srv (prod): /srv/portfolio/deploy.sh',
    });
    expect(out).toContain('Déploiement de portfolio sur bb-srv : terminé (code 0)');
    expect(ssh.calls.at(-1)?.argv).toEqual(['/srv/portfolio/deploy.sh']);
    // After reading logs (external content), a prod deploy is refused: new conversation first.
    await ask('call server_logs {"server":"bb-srv","app":"portfolio"}');
    expect(await ask('call deploy {"server":"bb-srv","app":"portfolio"}')).toMatch(/KO/);
    expect(ssh.calls.filter((c) => c.argv[0] === '/srv/portfolio/deploy.sh')).toHaveLength(1);
  });

  it('Coolify: the token comes from the vault and never shows', async () => {
    await setup();
    const { out } = await askWithPin('call deploy {"server":"bb-srv","app":"dala"}');
    expect(out).toContain('Déploiement de dala lancé sur Coolify.');
    expect(coolifyCalls.at(-1)).toEqual({
      url: 'https://coolify.example.cm/api/v1/deploy?uuid=abcd1234',
      auth: `Bearer ${COOLIFY_TOKEN}`,
    });
    expect(out).not.toContain(COOLIFY_TOKEN);
    expect(auditJson()).not.toContain(COOLIFY_TOKEN);
  });

  it('repository secrets: from the vault or generated, PIN, value never in output or audit', async () => {
    await setup();
    const a = await askWithPin(
      'call repo_secret_set {"repo":"BrightkyEfoo/portfolio_v3","name":"DB_PASSWORD","vault":"db-password"}',
    );
    expect(a.req).toMatchObject({ level: 3, rule: 'ops.repo_secret' });
    expect(a.out).toContain(
      'Secret DB_PASSWORD défini sur BrightkyEfoo/portfolio_v3 (valeur jamais affichée)',
    );
    expect(repoSecrets.stored[0]).toEqual({
      forge: 'github',
      repo: 'BrightkyEfoo/portfolio_v3',
      name: 'DB_PASSWORD',
      value: VAULT_VALUE,
      protected: true,
    });

    await askWithPin(
      'call repo_secret_set {"repo":"BrightkyEfoo/portfolio_v3","name":"JWT_SECRET","generate":true}',
    );
    const generated = repoSecrets.stored[1]?.value ?? '';
    expect(generated.length).toBeGreaterThanOrEqual(40);
    expect(h.secrets.get('vault.gen.jwt_secret')).toBe(generated);
    expect(auditJson()).not.toContain(VAULT_VALUE);
    expect(auditJson()).not.toContain(generated);

    expect(
      await ask('call repo_secret_set {"repo":"a/b","name":"GITHUB_TOKEN","generate":true}'),
    ).toMatch(/KO/);
    expect(await ask('call repo_secret_set {"repo":"a/b","name":"X_KEY"}')).toContain(
      'rule input.invalid',
    );
  });

  it('deploy key: restricted to the deploy command on the server, secrets on the repo, private key never shown', async () => {
    await setup();
    const { out, req } = await askWithPin(
      'call deploy_key_setup {"server":"bb-srv","app":"portfolio"}',
    );
    expect(req).toMatchObject({ level: 3, rule: 'ops.deploy_key' });
    const install = ssh.calls.at(-1)?.argv ?? [];
    expect(install.slice(0, 2)).toEqual(['sh', '-c']);
    expect(install.at(-1)).toBe(`restrict,command="/srv/portfolio/deploy.sh" ${FAKE_PUBLIC_KEY}`);
    expect(repoSecrets.stored.map((s) => s.name)).toEqual([
      'DEPLOY_SSH_KEY',
      'DEPLOY_HOST',
      'DEPLOY_USER',
      'DEPLOY_PORT',
      'DEPLOY_KNOWN_HOSTS',
    ]);
    expect(repoSecrets.stored[0]?.value).toBe(FAKE_PRIVATE_KEY);
    expect(out).toContain('limitée à : /srv/portfolio/deploy.sh');
    expect(out).toContain('secrets.DEPLOY_SSH_KEY');
    expect(out).not.toContain('BEGIN OPENSSH PRIVATE KEY');
    expect(auditJson()).not.toContain('b3BlbnNzaC1rZXktdjEAAAAAFAKE');
  });
});
