import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface GitAuth {
  user: string;
  token: string;
}

/**
 * git through argv (never a shell). Over https the token reaches git through a one-shot credential
 * helper reading an environment variable of that git process only: never in a URL, never in
 * .git/config, never in the audit log.
 */
export class Git {
  readonly #bin: string;
  readonly #env: NodeJS.ProcessEnv;

  constructor(o: { bin?: string; env?: NodeJS.ProcessEnv } = {}) {
    this.#bin = o.bin ?? '/usr/bin/git';
    this.#env = {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin',
      HOME: process.env.HOME ?? '',
      GIT_TERMINAL_PROMPT: '0',
      LANG: 'en_US.UTF-8',
      ...o.env,
    };
  }

  async run(
    args: string[],
    o: { cwd?: string; signal?: AbortSignal; auth?: GitAuth; timeoutMs?: number } = {},
  ): Promise<string> {
    const pre = o.auth
      ? [
          '-c',
          'credential.helper=',
          '-c',
          // Single-quoted literal: git runs it with sh, the token comes from this process's env.
          'credential.helper=!f() { echo "username=$JARVIS_GIT_USER"; echo "password=$JARVIS_GIT_TOKEN"; }; f',
        ]
      : [];
    const env = o.auth
      ? { ...this.#env, JARVIS_GIT_USER: o.auth.user, JARVIS_GIT_TOKEN: o.auth.token }
      : this.#env;
    try {
      const { stdout } = await run(this.#bin, [...pre, ...args], {
        cwd: o.cwd,
        env,
        signal: o.signal,
        timeout: o.timeoutMs ?? 300_000,
        maxBuffer: 50_000_000,
      });
      return stdout;
    } catch (e) {
      const err = e as { stderr?: string; message: string };
      const detail = (err.stderr || err.message).trim().split('\n').slice(-3).join(' | ');
      throw new Error(
        `git ${args[0]} failed: ${detail.replaceAll(o.auth?.token || '\0', '[REDACTED]')}`,
      );
    }
  }
}

/** Branch names Jarvis may push: its own, never the default branch. */
export const BRANCH = /^jarvis\/[a-z0-9][a-z0-9._-]{0,80}$/;

export const slug = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'tache';

/** Trailers no commit of Brightky's may carry (ADR-023, global rule). */
export const AI_TRAILER =
  /^(co-authored-by:.*(claude|anthropic|noreply@anthropic)|generated with \[?claude|🤖 generated)/im;
