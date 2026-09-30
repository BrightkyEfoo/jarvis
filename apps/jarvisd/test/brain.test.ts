import type { ModelUsage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { turnFooter } from '../src/format.ts';
import type { RateLimitInfo } from '../src/orchestrator/quota.ts';
import { routeModel } from '../src/orchestrator/router.ts';
import { turnUsage } from '../src/orchestrator/usage.ts';

const models = {
  conversation: 'claude-sonnet-5-5',
  planning: 'claude-opus-5-5',
  effort: 'medium' as const,
};
const none = new Map<string, RateLimitInfo>();

describe('routeModel (FR + EN)', () => {
  it.each([
    'quelle heure est-il ?',
    'ouvre VS Code sur CodeVault',
    'what is on my calendar today?',
    'réponds à Paul que je valide le devis',
  ])('keeps everyday requests on Sonnet: %s', (p) => {
    expect(routeModel(p, models, none)).toMatchObject({
      tier: 'conversation',
      model: 'claude-sonnet-5-5',
    });
  });

  it.each([
    'Planifie le sprint 3 pour la voix',
    'Conçois l’architecture du module de paiement',
    'Compare Tauri et Electron pour notre HUD',
    'think hard about the migration strategy',
    'design the worker queue',
    'utilise opus pour ça',
  ])('sends planning and deep reasoning to Opus: %s', (p) => {
    expect(routeModel(p, models, none)).toMatchObject({
      tier: 'planning',
      model: 'claude-opus-5-5',
    });
  });

  it('honours an explicit request for speed', () => {
    expect(routeModel('compare vite les deux options', models, none).tier).toBe('conversation');
  });

  it('falls back to Sonnet when the weekly Opus quota is nearly spent', () => {
    const q = new Map<string, RateLimitInfo>([
      ['seven_day_opus', { status: 'allowed_warning', utilization: 0.93 }],
    ]);
    expect(routeModel('Planifie le sprint', models, q)).toMatchObject({
      tier: 'conversation',
      reason: expect.stringMatching(/seven_day_opus at 93%/),
    });
  });
});

const mu = (input: number, output: number, cacheRead: number, cost: number): ModelUsage => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadInputTokens: cacheRead,
  cacheCreationInputTokens: 0,
  webSearchRequests: 0,
  costUSD: cost,
  contextWindow: 1_000_000,
  maxOutputTokens: 128_000,
});

describe('turnUsage', () => {
  it('turns cumulative session totals into per-turn usage', () => {
    const t1 = { costUsd: 0.01, byModel: { 'claude-sonnet-5-5': mu(1000, 100, 0, 0.01) } };
    const t2 = {
      costUsd: 0.025,
      byModel: {
        'claude-sonnet-5-5': mu(1300, 180, 9000, 0.013),
        'claude-opus-5-5': mu(200, 50, 0, 0.012),
      },
    };
    expect(turnUsage(null, t1)).toMatchObject({
      costUsd: 0.01,
      inputTokens: 1000,
      model: 'claude-sonnet-5-5',
    });
    const d = turnUsage(t1, t2);
    expect(d.costUsd).toBeCloseTo(0.015);
    expect(d).toMatchObject({
      inputTokens: 500,
      outputTokens: 130,
      cacheReadTokens: 9000,
      model: 'claude-opus-5-5',
    });
  });
});

describe('turnFooter', () => {
  it('shows model, latency, tokens, API-equivalent cost and quota', () => {
    const line = turnFooter({
      ok: true,
      model: 'claude-opus-5-5',
      route: { tier: 'planning', reason: 'planning / deep reasoning' },
      ttftMs: 910,
      usage: { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 8800 },
      costUsd: 0.0123,
      quota: { five_hour: 23 },
    });
    expect(line).toBe(
      "opus-5-5 (planning / deep reasoning) · TTFT 910 ms · 10.0k in dont 8.8k en cache / 340 out · ≈ $0.0123 équivalent API (payé par l'abonnement) · quota 5 h : 23 %",
    );
  });
});
