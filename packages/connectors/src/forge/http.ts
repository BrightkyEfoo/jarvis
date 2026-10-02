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
