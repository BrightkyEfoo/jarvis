import type { FetchFn } from '../google/oauth.ts';

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface HttpOptions {
  base: string;
  /** Called per request so a token rotated in the Keychain is picked up; never logged. */
  auth: () => Record<string, string>;
  fetch?: FetchFn;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export interface Page<T> {
  data: T;
  headers: Headers;
}

/**
 * Minimal JSON client for forge APIs. Credentials only ever travel in headers (never in URLs,
 * which end up in errors and logs), every call has a timeout, errors carry no secret.
 */
export class HttpJson {
  readonly #o: HttpOptions;

  constructor(o: HttpOptions) {
    this.#o = o;
  }

  url(path: string, query?: Record<string, string | number | boolean | undefined>): string {
    const u = new URL(path.startsWith('http') ? path : `${this.#o.base}${path}`);
    for (const [k, v] of Object.entries(query ?? {}))
      if (v !== undefined) u.searchParams.set(k, String(v));
    return u.href;
  }

  async request<T>(
    method: string,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
  ): Promise<Page<T>> {
    const url = this.url(path, opts.query);
    if (!url.startsWith(this.#o.base.replace(/\/+$/, '')))
      throw new Error(`refusing to call ${new URL(url).host}`);
    const res = await (this.#o.fetch ?? fetch)(url, {
      method,
      headers: {
        accept: 'application/json',
        'user-agent': 'jarvis-assistant',
        ...(opts.body !== undefined && { 'content-type': 'application/json' }),
        ...this.#o.headers,
        ...this.#o.auth(),
      },
      ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }),
      signal: AbortSignal.timeout(this.#o.timeoutMs ?? 20_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 300);
      try {
        const j = JSON.parse(text) as { message?: string; error?: string };
        detail = j.message ?? j.error ?? detail;
      } catch {
        // not JSON
      }
      throw new HttpError(
        res.status,
        `${method} ${new URL(url).pathname} → ${res.status} ${detail}`,
      );
    }
    return { data: (text ? JSON.parse(text) : null) as T, headers: res.headers };
  }

  async get<T>(
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    return (await this.request<T>('GET', path, { query })).data;
  }

  /**
   * The end of a plain-text resource (a CI log: the error is at the end). A redirect to another host
   * (GitHub's signed download URL) is followed *without* credentials. At most `maxBytes` are
   * downloaded (metered connection); only the last `tailChars` are kept.
   */
  async textTail(path: string, tailChars: number, maxBytes = 3_000_000): Promise<string> {
    const url = this.url(path);
    if (!url.startsWith(this.#o.base.replace(/\/+$/, '')))
      throw new Error(`refusing to call ${new URL(url).host}`);
    const f = this.#o.fetch ?? fetch;
    const signal = AbortSignal.timeout(this.#o.timeoutMs ?? 20_000);
    let res = await f(url, {
      headers: { 'user-agent': 'jarvis-assistant', ...this.#o.headers, ...this.#o.auth() },
      redirect: 'manual',
      signal,
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      const next = location ? new URL(location, url) : null;
      if (next?.protocol !== 'https:') throw new Error('redirection de log refusée');
      res = await f(next.href, {
        headers: { 'user-agent': 'jarvis-assistant' },
        redirect: 'error',
        signal,
      });
    }
    if (!res.ok || !res.body)
      throw new HttpError(res.status, `GET ${new URL(url).pathname} → ${res.status}`);
    const decoder = new TextDecoder();
    let tail = '';
    let read = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value.byteLength;
      tail = (tail + decoder.decode(value, { stream: true })).slice(-tailChars);
      if (read >= maxBytes) {
        await reader.cancel();
        tail = `[… log tronqué après ${Math.round(maxBytes / 1e6)} Mo …]\n${tail}`;
        break;
      }
    }
    return tail;
  }

  /** Follows `next` (Link header or X-Next-Page) until `max` items. */
  async all<T>(
    path: string,
    query: Record<string, string | number | boolean | undefined>,
    max: number,
    next: (headers: Headers, url: string) => string | null,
  ): Promise<T[]> {
    const out: T[] = [];
    let url: string | null = this.url(path, query);
    for (let pages = 0; url && out.length < max && pages < 20; pages++) {
      const page: Page<T[]> = await this.request<T[]>('GET', url);
      out.push(...page.data);
      url = page.data.length ? next(page.headers, url) : null;
    }
    return out.slice(0, max);
  }
}

/** RFC 8288 `Link: <…>; rel="next"` (GitHub). */
export const linkNext = (h: Headers): string | null =>
  /<([^>]+)>;\s*rel="next"/.exec(h.get('link') ?? '')?.[1] ?? null;
