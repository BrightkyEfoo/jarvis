import { dirname } from 'node:path';

/** Fixed lookup path for shell commands: never inherited, so it cannot be hijacked by env. */
export const SHELL_PATH_DIRS: readonly string[] = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
  dirname(process.execPath), // node + pnpm of the running Node 24
];

/** Environment for commands run by shell_run: no inherited variables, so no secrets. */
export function shellEnv(home: string): Record<string, string> {
  return {
    PATH: SHELL_PATH_DIRS.join(':'),
    HOME: home,
    LANG: 'en_US.UTF-8',
    TERM: 'dumb',
    NO_COLOR: '1',
    GIT_TERMINAL_PROMPT: '0',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
  };
}

export interface SdkEnvInput {
  home: string;
  oauthToken: string;
  claudeConfigDir: string;
  tmpDir: string;
}

/**
 * Environment for the Claude Code subprocess. Built from scratch (the SDK `env` option replaces
 * process.env): ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN can never leak in, so billing stays on
 * the subscription token.
 */
export function sdkEnv(i: SdkEnvInput): Record<string, string> {
  return {
    HOME: i.home,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'en_US.UTF-8',
    TMPDIR: i.tmpDir,
    CLAUDE_CODE_OAUTH_TOKEN: i.oauthToken,
    CLAUDE_CONFIG_DIR: i.claudeConfigDir,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_AGENT_SDK_CLIENT_APP: 'jarvis/0.1',
  };
}
