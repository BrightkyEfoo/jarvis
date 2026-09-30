import type { Policy } from '@jarvis/policy';
import type { RateLimitInfo } from './quota.ts';

export type Tier = 'conversation' | 'planning';

export interface Route {
  tier: Tier;
  model: string;
  reason: string;
}

/** Latest known state per subscription window (five_hour, seven_day_opus…). */
export type QuotaState = ReadonlyMap<string, RateLimitInfo>;

// French and English: Brightky speaks both.
const PLANNING =
  /\b(planifie\w*|plan d'action|architectur\w*|con[çc]oi\w*|concevoir|refactor\w*|strat[ée]gi\w*|analyse en profondeur|r[ée]fl[ée]chis|compare\w*|avantages et inconv[ée]nients|trade-?offs?|adr|sp[ée]cification|plan (it|this|out)|architect\w*|design\w*|think (hard|deeply|carefully)|deep[- ]dive|in depth|strategy|pros and cons)\b/i;
const FORCE_PLANNING = /\b(opus|mode r[ée]flexion|think mode)\b/i;
const FORCE_FAST = /\b(sonnet|vite|rapide(ment)?|quick(ly)?|fast)\b/i;

const OPUS_WINDOWS = ['seven_day_opus'];

function opusSaturated(q: QuotaState): string | null {
  for (const w of OPUS_WINDOWS) {
    const info = q.get(w);
    if (info?.status === 'rejected') return `${w} limit reached`;
    if (info?.utilization !== undefined && info.utilization >= 0.9)
      return `${w} at ${Math.round(info.utilization * 100)}%`;
  }
  return null;
}

/**
 * Local, instant routing (no model call): Sonnet by default for speed, Opus when the request asks
 * for planning or deep reasoning — unless the Opus quota is nearly spent.
 */
export function routeModel(prompt: string, models: Policy['models'], quota: QuotaState): Route {
  const conversation: Route = {
    tier: 'conversation',
    model: models.conversation,
    reason: 'default',
  };
  if (FORCE_FAST.test(prompt)) return { ...conversation, reason: 'asked for speed' };
  const wantsPlanning = FORCE_PLANNING.test(prompt)
    ? 'asked for Opus'
    : PLANNING.test(prompt)
      ? 'planning / deep reasoning'
      : null;
  if (!wantsPlanning) return conversation;
  const saturated = opusSaturated(quota);
  if (saturated) return { ...conversation, reason: `planning requested but ${saturated}` };
  return { tier: 'planning', model: models.planning, reason: wantsPlanning };
}
