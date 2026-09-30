import type { HookCallback, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import type { KillSwitch } from '@jarvis/policy';

const decide = (
  permissionDecision: 'allow' | 'deny',
  reason: string,
  stop = false,
): HookJSONOutput => ({
  ...(stop ? { continue: false, stopReason: reason } : {}),
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision,
    permissionDecisionReason: reason,
  },
});

/**
 * First lock (the authoritative one is the Gate inside each tool handler). Runs on every tool
 * call — the SDK docs name PreToolUse as the only always-on chokepoint — and lets through only
 * tools served by our in-process `jarvis` server.
 */
export function preToolUseHook(killswitch: KillSwitch, allowed: ReadonlySet<string>): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    if (killswitch.engaged) return decide('deny', `STOP engaged: ${killswitch.reason}`, true);

    const server = input.mcp_server;
    // Trust is keyed on provenance (`source: 'sdk'` = registered by this process), not on the name.
    const ours = server ? server.source === 'sdk' && server.name === 'jarvis' : true;
    if (!ours || !allowed.has(input.tool_name)) {
      return decide('deny', `tool ${input.tool_name} is not available to Jarvis`);
    }
    return decide('allow', 'Jarvis tool; the policy gate decides inside the handler');
  };
}
