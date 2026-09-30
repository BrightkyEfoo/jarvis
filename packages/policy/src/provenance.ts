import { randomUUID } from 'node:crypto';

export type Origin = 'user' | 'external' | 'scheduler';

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;
const PHONE = /\+?\d[\d\s().-]{6,}\d/g;

const digits = (s: string): string => s.replace(/\D/g, '');

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * One conversation context. Once external content (mail, web page, WhatsApp, PR text) has been
 * read into it, the session is tainted until it ends: that content stays in the model's context,
 * so an injected instruction could surface several turns later.
 */
export class Session {
  readonly id = randomUUID();
  readonly origin: Origin;
  #tainted: boolean;
  readonly #emails = new Set<string>();
  readonly #hosts = new Set<string>();
  readonly #phones = new Set<string>();

  constructor(origin: Origin = 'user') {
    this.origin = origin;
    this.#tainted = origin === 'external';
  }

  get tainted(): boolean {
    return this.#tainted;
  }

  ingestExternal(text: string): void {
    this.#tainted = true;
    for (const m of text.matchAll(EMAIL)) this.#emails.add(m[0].toLowerCase());
    for (const m of text.matchAll(URL_RE)) {
      const h = hostOf(m[0]);
      if (h) this.#hosts.add(h);
    }
    for (const m of text.matchAll(PHONE)) {
      const d = digits(m[0]);
      if (d.length >= 8) this.#phones.add(d);
    }
  }

  /** True when a destination only appeared in external content, never from Brightky himself. */
  isExternalDestination(dest: string): boolean {
    const d = dest.trim().toLowerCase();
    if (this.#emails.has(d)) return true;
    const h = hostOf(d);
    if (h && this.#hosts.has(h)) return true;
    const p = digits(d);
    return p.length >= 8 && this.#phones.has(p);
  }
}
