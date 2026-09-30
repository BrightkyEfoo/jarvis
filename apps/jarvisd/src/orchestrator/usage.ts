import type { ModelUsage } from '@anthropic-ai/claude-agent-sdk';

export interface Totals {
  costUsd: number;
  byModel: Record<string, ModelUsage>;
}

export interface TurnUsage {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Model that did most of the work this turn. */
  model: string | null;
}

/**
 * The SDK reports cumulative totals for a long-lived session; a turn's usage is the difference
 * with the previous result. Unknown previous totals (fresh process) count from zero.
 */
export function turnUsage(prev: Totals | null, cur: Totals): TurnUsage {
  const out: TurnUsage = {
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    model: null,
  };
  let top = -1;
  for (const [model, u] of Object.entries(cur.byModel)) {
    const p = prev?.byModel[model];
    const d = {
      input: u.inputTokens - (p?.inputTokens ?? 0),
      output: u.outputTokens - (p?.outputTokens ?? 0),
      cacheRead: u.cacheReadInputTokens - (p?.cacheReadInputTokens ?? 0),
      cacheWrite: u.cacheCreationInputTokens - (p?.cacheCreationInputTokens ?? 0),
      cost: u.costUSD - (p?.costUSD ?? 0),
    };
    out.inputTokens += Math.max(0, d.input);
    out.outputTokens += Math.max(0, d.output);
    out.cacheReadTokens += Math.max(0, d.cacheRead);
    out.cacheWriteTokens += Math.max(0, d.cacheWrite);
    if (d.cost > top) {
      top = d.cost;
      out.model = model;
    }
  }
  out.costUsd = Math.max(0, cur.costUsd - (prev?.costUsd ?? 0));
  return out;
}
