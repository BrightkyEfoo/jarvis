import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Level } from './levels.ts';
import type { PinResult } from './pin.ts';

export interface ApprovalRequest {
  id: string;
  tool: string;
  level: Level;
  rule: string;
  /** Human-readable description of exactly what will happen. */
  summary: string;
  reason: string;
  needsPin: boolean;
  tainted: boolean;
  externalDestinations: string[];
  createdAt: number;
  expiresAt: number;
}

export interface ApprovalOutcome {
  approved: boolean;
  /** cli | voice | hud | telegram | timeout | stop */
  channel: string;
  reason: string;
}

export type ApprovalInput = Omit<ApprovalRequest, 'id' | 'createdAt' | 'expiresAt'>;

interface Pending {
  req: ApprovalRequest;
  settle: (o: ApprovalOutcome) => void;
}

interface BrokerEvents {
  request: [ApprovalRequest];
  resolved: [ApprovalRequest, ApprovalOutcome];
}

export type ResolveResult = { ok: true } | { ok: false; error: string };

/**
 * Holds actions waiting for Brightky. Channels (CLI now; voice, HUD, Telegram later) only call
 * resolve(); none of them can bypass the PIN check for N3.
 */
export class ApprovalBroker extends EventEmitter<BrokerEvents> {
  readonly #pending = new Map<string, Pending>();
  readonly #timeoutMs: number;
  readonly #verifyPin: (pin: string) => PinResult;

  constructor(opts: { timeoutMs: number; verifyPin: (pin: string) => PinResult }) {
    super();
    this.#timeoutMs = opts.timeoutMs;
    this.#verifyPin = opts.verifyPin;
  }

  request(input: ApprovalInput, signal: AbortSignal): Promise<ApprovalOutcome> {
    const now = Date.now();
    const req: ApprovalRequest = {
      ...input,
      id: randomUUID().slice(0, 8),
      createdAt: now,
      expiresAt: now + this.#timeoutMs,
    };

    return new Promise<ApprovalOutcome>((resolveOutcome) => {
      let done = false;
      const settle = (o: ApprovalOutcome) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.#pending.delete(req.id);
        this.emit('resolved', req, o);
        resolveOutcome(o);
      };
      const timer = setTimeout(
        () =>
          settle({
            approved: false,
            channel: 'timeout',
            reason: `no answer within ${Math.round(this.#timeoutMs / 1000)}s`,
          }),
        this.#timeoutMs,
      );
      const onAbort = () => settle({ approved: false, channel: 'stop', reason: 'STOP engaged' });
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      this.#pending.set(req.id, { req, settle });
      this.emit('request', req);
    });
  }

  resolve(id: string, d: { approve: boolean; pin?: string; channel: string }): ResolveResult {
    const p = this.#pending.get(id);
    if (!p) return { ok: false, error: `no pending approval ${id}` };

    if (!d.approve) {
      p.settle({ approved: false, channel: d.channel, reason: 'refused by Brightky' });
      return { ok: true };
    }
    if (p.req.needsPin) {
      if (!d.pin) return { ok: false, error: 'this action is N3: PIN required' };
      const r = this.#verifyPin(d.pin);
      if (!r.ok) {
        if (r.reason === 'locked') {
          p.settle({
            approved: false,
            channel: d.channel,
            reason: 'PIN locked after too many failures',
          });
          return { ok: false, error: 'PIN locked: action refused' };
        }
        return {
          ok: false,
          error: r.reason === 'not_set' ? 'no PIN configured' : `wrong PIN (${r.remaining} left)`,
        };
      }
    }
    p.settle({
      approved: true,
      channel: d.channel,
      reason: p.req.needsPin ? 'approved with PIN' : 'approved',
    });
    return { ok: true };
  }

  pending(): ApprovalRequest[] {
    return [...this.#pending.values()].map((p) => p.req);
  }
}
