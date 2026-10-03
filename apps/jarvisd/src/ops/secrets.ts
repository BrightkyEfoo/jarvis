import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GitLabClient } from '@jarvis/connectors';

/** Repository / CI secrets. The value goes to the forge and nowhere else (never argv, never logs). */
export interface RepoSecrets {
  set(
    forge: 'github' | 'gitlab',
    repo: string,
    name: string,
    value: string,
    o: { protected: boolean },
  ): Promise<void>;
}

const GH = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'];

/**
 * GitHub through `gh secret set` (it encrypts with the repository's public key; Brightky's gh login
 * has the right scope, Jarvis's fine-grained tokens deliberately do not), the value on stdin.
 * GitLab through its API (CI/CD variables).
 */
export class ForgeSecrets implements RepoSecrets {
  readonly #gitlab: () => GitLabClient | null;

  constructor(gitlab: () => GitLabClient | null) {
    this.#gitlab = gitlab;
  }

  async set(
    forge: 'github' | 'gitlab',
    repo: string,
    name: string,
    value: string,
    o: { protected: boolean },
  ): Promise<void> {
    if (forge === 'gitlab') {
      const gl = this.#gitlab();
      if (!gl) throw new Error("GitLab n'est pas connecté : jarvis gitlab connect");
      await gl.setVariable(repo, name, value, o);
      return;
    }
    const gh = GH.find((p) => existsSync(p));
    if (!gh) throw new Error('GitHub CLI absent : brew install gh, puis gh auth login');
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        gh,
        ['secret', 'set', name, '--repo', repo, '--app', 'actions'],
        { timeout: 30_000, env: { HOME: process.env.HOME ?? '', PATH: '/usr/bin:/bin' } },
        (err, _out, stderr) =>
          err
            ? reject(
                new Error(`gh secret set a échoué : ${stderr.trim().slice(0, 300) || err.message}`),
              )
            : resolve(),
      );
      child.stdin?.end(value);
    });
  }
}

/** A fresh ed25519 key pair for one deploy; the private key exists on disk for milliseconds. */
export function ed25519KeyPair(
  comment: string,
): Promise<{ privateKey: string; publicKey: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-key-'));
  const file = join(dir, 'key');
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/ssh-keygen',
      ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', file],
      { timeout: 15_000 },
      (err) => {
        try {
          if (err) throw err;
          resolve({
            privateKey: readFileSync(file, 'utf8'),
            publicKey: readFileSync(`${file}.pub`, 'utf8').trim(),
          });
        } catch (e) {
          reject(e);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );
  });
}

/** The server's line(s) in known_hosts, printed by ssh-keygen (public data: host keys). */
export function knownHostsFor(host: string, port?: number): Promise<string> {
  const name = port && port !== 22 ? `[${host}]:${port}` : host;
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/ssh-keygen', ['-F', name], { timeout: 10_000 }, (err, out) => {
      const lines = out
        .split('\n')
        .filter((l) => l.trim() && !l.startsWith('#'))
        .join('\n');
      if (err || !lines)
        reject(
          new Error(
            `${name} n'est pas dans known_hosts : connecte-toi une fois à la main (ssh ${name})`,
          ),
        );
      else resolve(`${lines}\n`);
    });
  });
}
