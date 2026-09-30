import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface KeyValueStore {
  get(name: string): string | null;
  set(name: string, value: string): void;
}

const LOG2_N = 14; // 16 MiB, ~40 ms on M1: slow for offline guessing, fast enough per approval
const R = 8;
const P = 1;
const KEYLEN = 32;
const PIN_RE = /^\d{6,12}$/;

function derive(pin: string, salt: Buffer, log2n: number, r: number, p: number): Buffer {
  return scryptSync(pin, salt, KEYLEN, { N: 2 ** log2n, r, p, maxmem: 64 * 1024 * 1024 });
}

export function hashPin(pin: string): string {
  if (!PIN_RE.test(pin)) throw new Error('PIN must be 6 to 12 digits');
  const salt = randomBytes(16);
  const hash = derive(pin, salt, LOG2_N, R, P);
  return `scrypt$${LOG2_N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function matches(pin: string, encoded: string): boolean {
  const [scheme, n, r, p, salt, hash] = encoded.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = derive(pin, Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export type PinResult =
  | { ok: true }
  | { ok: false; reason: 'not_set' | 'locked' | 'wrong'; lockedUntil?: number; remaining?: number };

interface LockState {
  failures: number;
  lockedUntil: number;
}

export interface PinGuardOptions {
  store: KeyValueStore;
  secretName: string;
  /** Failure counter; lives in Jarvis' data dir, which no tool can write. */
  statePath: string;
  maxAttempts: number;
  lockoutMin: number;
  now?: () => number;
}

export class PinGuard {
  readonly #o: PinGuardOptions;
  readonly #now: () => number;

  constructor(opts: PinGuardOptions) {
    this.#o = opts;
    this.#now = opts.now ?? Date.now;
  }

  isSet(): boolean {
    return this.#o.store.get(this.#o.secretName) !== null;
  }

  set(pin: string): void {
    this.#o.store.set(this.#o.secretName, hashPin(pin));
    this.#save({ failures: 0, lockedUntil: 0 });
  }

  verify(pin: string): PinResult {
    const encoded = this.#o.store.get(this.#o.secretName);
    if (!encoded) return { ok: false, reason: 'not_set' };

    const state = this.#load();
    if (state.lockedUntil > this.#now())
      return { ok: false, reason: 'locked', lockedUntil: state.lockedUntil };

    if (PIN_RE.test(pin) && matches(pin, encoded)) {
      this.#save({ failures: 0, lockedUntil: 0 });
      return { ok: true };
    }

    const failures = state.failures + 1;
    if (failures >= this.#o.maxAttempts) {
      const lockedUntil = this.#now() + this.#o.lockoutMin * 60_000;
      this.#save({ failures: 0, lockedUntil });
      return { ok: false, reason: 'locked', lockedUntil };
    }
    this.#save({ failures, lockedUntil: 0 });
    return { ok: false, reason: 'wrong', remaining: this.#o.maxAttempts - failures };
  }

  #load(): LockState {
    try {
      const s = JSON.parse(readFileSync(this.#o.statePath, 'utf8')) as Partial<LockState>;
      return { failures: Number(s.failures) || 0, lockedUntil: Number(s.lockedUntil) || 0 };
    } catch {
      return { failures: 0, lockedUntil: 0 };
    }
  }

  #save(s: LockState): void {
    mkdirSync(dirname(this.#o.statePath), { recursive: true, mode: 0o700 });
    writeFileSync(this.#o.statePath, JSON.stringify(s), { mode: 0o600 });
  }
}
