import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookInput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { KillSwitch } from '@jarvis/policy';
import { describe, expect, it } from 'vitest';
import { sdkEnv, shellEnv } from '../src/env.ts';
import { environmentProblems, subscriptionProblems, surfaceProblems } from '../src/guards.ts';
import { preToolUseHook } from '../src/orchestrator/hooks.ts';
import { quotaAction } from '../src/orchestrator/quota.ts';

describe('environmentProblems', () => {
  it('refuses disabled TLS verification and old Node', () => {
    expect(environmentProblems({ NODE_TLS_REJECT_UNAUTHORIZED: '0' }, '24.21.0')).toHaveLength(1);
    expect(environmentProblems({}, '22.17.0')).toHaveLength(1);
    expect(environmentProblems({}, '24.21.0')).toEqual([]);
  });
});

describe('subscriptionProblems (zero cost beyond the subscription)', () => {
  it.each(['ANTHROPIC_API_KEY', 'apiKeyHelper', '/login managed key'])(
    'refuses API-key billing via %s',
    (apiKeySource) => {
      expect(subscriptionProblems({ apiKeySource })).toHaveLength(1);
    },
  );
  it('refuses third-party providers', () => {
    expect(subscriptionProblems({ apiProvider: 'bedrock' })).toHaveLength(1);
  });
  it('accepts claude.ai OAuth', () => {
    expect(
      subscriptionProblems({
        apiKeySource: 'none',
        apiProvider: 'firstParty',
        subscriptionType: 'max',
      }),
    ).toEqual([]);
  });
});

describe('surfaceProblems', () => {
  it('accepts only our tools and our in-process server', () => {
    expect(surfaceProblems(['mcp__jarvis__fs_read'], [{ name: 'jarvis', source: 'sdk' }])).toEqual(
      [],
    );
    expect(surfaceProblems(['Bash', 'mcp__jarvis__fs_read'], [])).toHaveLength(1);
    expect(surfaceProblems([], [{ name: 'claude_ai_Gmail', source: 'claudeai' }])).toHaveLength(1);
    expect(surfaceProblems([], [{ name: 'jarvis', source: 'user' }])).toHaveLength(1);
  });
});

describe('child environments', () => {
  it('never carry API keys or inherited variables', () => {
    const env = sdkEnv({
      home: '/h',
      oauthToken: 'sk-ant-oat01-x',
      claudeConfigDir: '/c',
      tmpDir: '/t',
    });
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/c');
    expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false');
    expect(Object.keys(shellEnv('/h'))).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });
});

describe('preToolUseHook', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-hook-'));
  const ks = new KillSwitch(join(dir, 'STOP'));
  const hook = preToolUseHook(ks, new Set(['mcp__jarvis__fs_read']));
  const input = (tool_name: string, mcp_server?: { name: string; source: string }): HookInput =>
    ({
      hook_event_name: 'PreToolUse',
      tool_name,
      tool_input: {},
      tool_use_id: 't',
      session_id: 's',
      transcript_path: '',
      cwd: '/',
      ...(mcp_server ? { mcp_server } : {}),
    }) as HookInput;
  const decision = async (i: HookInput) =>
    ((await hook(i, 't', { signal: new AbortController().signal })) as SyncHookJSONOutput)
      .hookSpecificOutput as { permissionDecision: string };

  it('allows our registered tools only', async () => {
    expect(
      (await decision(input('mcp__jarvis__fs_read', { name: 'jarvis', source: 'sdk' })))
        .permissionDecision,
    ).toBe('allow');
    expect((await decision(input('Bash'))).permissionDecision).toBe('deny');
    expect(
      (await decision(input('mcp__jarvis__fs_read', { name: 'jarvis', source: 'user' })))
        .permissionDecision,
    ).toBe('deny');
    expect(
      (
        await decision(
          input('mcp__claude_ai_Gmail__send_message', {
            name: 'claude_ai_Gmail',
            source: 'claudeai',
          }),
        )
      ).permissionDecision,
    ).toBe('deny');
  });

  it('denies everything and stops the turn under STOP', async () => {
    ks.engage('test');
    const out = (await hook(input('mcp__jarvis__fs_read', { name: 'jarvis', source: 'sdk' }), 't', {
      signal: new AbortController().signal,
    })) as SyncHookJSONOutput;
    expect(out.continue).toBe(false);
    expect((out.hookSpecificOutput as { permissionDecision: string }).permissionDecision).toBe(
      'deny',
    );
    ks.release();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('quotaAction', () => {
  it('stops on paid overage, warns on limits', () => {
    expect(quotaAction({ status: 'allowed', isUsingOverage: true }).stop).toBeDefined();
    expect(quotaAction({ status: 'rejected', rateLimitType: 'five_hour' }).warn).toMatch(
      /limit reached/,
    );
    expect(quotaAction({ status: 'allowed_warning', utilization: 0.83 }).warn).toMatch(/83%/);
    expect(quotaAction({ status: 'allowed' })).toEqual({});
  });
});
