import type { RepoSecrets } from '../../apps/jarvisd/src/ops/secrets.ts';
import type { OpsServer, RunResult, SshRunner } from '../../apps/jarvisd/src/ops/ssh.ts';

/** Records every command sent to a server; answers with `reply`. */
export class FakeSsh implements SshRunner {
  readonly calls: { server: string; argv: string[] }[] = [];
  reply: (server: OpsServer, argv: readonly string[]) => RunResult = () => ({
    code: 0,
    output: 'ok',
    timedOut: false,
  });
  async run(server: OpsServer, argv: readonly string[]): Promise<RunResult> {
    this.calls.push({ server: server.id, argv: [...argv] });
    return this.reply(server, argv);
  }
}

export class FakeRepoSecrets implements RepoSecrets {
  readonly stored: {
    forge: string;
    repo: string;
    name: string;
    value: string;
    protected: boolean;
  }[] = [];
  async set(
    forge: 'github' | 'gitlab',
    repo: string,
    name: string,
    value: string,
    o: { protected: boolean },
  ): Promise<void> {
    this.stored.push({ forge, repo, name, value, protected: o.protected });
  }
}

export const FAKE_PRIVATE_KEY =
  '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAAFAKEFAKEFAKE\n-----END OPENSSH PRIVATE KEY-----\n';
export const FAKE_PUBLIC_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFAKEFAKE jarvis-deploy:portfolio';
