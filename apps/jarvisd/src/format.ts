/** Pure formatting helpers shared by the CLI (kept out of cli.ts, which runs on import). */

export interface TurnView {
  ok: boolean;
  error?: string;
  ttftMs?: number;
  costUsd?: number;
  model?: string;
  route?: { tier: string; reason: string };
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
  quota?: Record<string, number | string>;
}

export const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** Per-request cost line: model, routing reason, latency, tokens, API-equivalent cost, quota. */
export function turnFooter(d: TurnView): string {
  const parts: string[] = [];
  if (d.model)
    parts.push(
      d.model.replace(/^claude-/, '') +
        (d.route?.tier === 'planning' ? ` (${d.route.reason})` : ''),
    );
  if (d.ttftMs !== undefined) parts.push(`TTFT ${d.ttftMs} ms`);
  if (d.usage) {
    const cache = d.usage.cacheReadTokens ? ` dont ${k(d.usage.cacheReadTokens)} en cache` : '';
    parts.push(
      `${k(d.usage.inputTokens + d.usage.cacheReadTokens)} in${cache} / ${k(d.usage.outputTokens)} out`,
    );
  }
  if (d.costUsd !== undefined)
    parts.push(`≈ $${d.costUsd.toFixed(4)} équivalent API (payé par l'abonnement)`);
  const fiveHour = d.quota?.five_hour;
  if (fiveHour !== undefined)
    parts.push(`quota 5 h : ${typeof fiveHour === 'number' ? `${fiveHour} %` : fiveHour}`);
  return parts.join(' · ');
}
