import type { SDKRateLimitEvent } from '@anthropic-ai/claude-agent-sdk';

export type RateLimitInfo = SDKRateLimitEvent['rate_limit_info'];

export interface QuotaAction {
  /** Engage STOP with this reason. */
  stop?: string;
  /** Tell Brightky, keep running. */
  warn?: string;
}

const when = (epochSec?: number): string =>
  epochSec
    ? new Date(epochSec * 1000).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })
    : 'bientôt';

/** Subscription only: any paid overage stops Jarvis instead of billing extra usage. */
export function quotaAction(info: RateLimitInfo): QuotaAction {
  if (info.isUsingOverage || info.overageInUse) {
    return { stop: 'paid extra usage (overage) would be billed: Jarvis stops instead' };
  }
  if (info.status === 'rejected') {
    return {
      warn: `Subscription limit reached (${info.rateLimitType ?? 'unknown window'}), resets ${when(info.resetsAt)}.`,
    };
  }
  if (info.status === 'allowed_warning') {
    const pct = info.utilization !== undefined ? ` ${Math.round(info.utilization * 100)}%` : '';
    return {
      warn: `Subscription usage high${pct} (${info.rateLimitType ?? 'window'}), resets ${when(info.resetsAt)}.`,
    };
  }
  return {};
}
