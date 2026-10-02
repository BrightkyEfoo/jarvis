import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { ConnectorError } from '../types.ts';

/**
 * Least privilege for Sprint 4: read mail, write drafts (gmail.compose also allows sending —
 * Google has no drafts-only scope — so sending is gated as N2 by the policy engine), read the
 * calendar.
 */
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/calendar.readonly',
];

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface GoogleClient {
  client_id: string;
  client_secret: string;
}

export type FetchFn = typeof fetch;

/** The "Desktop app" credentials file downloaded from the Google Cloud console. */
export function parseClientFile(json: string): GoogleClient {
  const doc = JSON.parse(json) as { installed?: Partial<GoogleClient> };
  const c = doc.installed;
  if (!c?.client_id || !c.client_secret) {
    throw new ConnectorError(
      'protocol',
      'expected a Google "Desktop app" OAuth client file ({"installed": {...}})',
    );
  }
  return { client_id: c.client_id, client_secret: c.client_secret };
}

async function tokenRequest(
  f: FetchFn,
  body: Record<string, string>,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await f(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new ConnectorError(
      'network',
      `Google token endpoint unreachable: ${(e as Error).message}`,
    );
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const kind = json.error === 'invalid_grant' ? 'auth' : 'protocol';
    throw new ConnectorError(
      kind,
      `Google token error: ${String(json.error ?? res.status)} — ${kind === 'auth' ? 'run `jarvis google connect` again' : String(json.error_description ?? '')}`,
    );
  }
  return json;
}

/** Access tokens live in memory only; the refresh token comes from the Keychain. */
export class GoogleAuth {
  readonly #client: GoogleClient;
  readonly #refreshToken: string;
  readonly #fetch: FetchFn;
  readonly #now: () => number;
  #access: { token: string; expiresAt: number } | null = null;
  #inflight: Promise<string> | null = null;

  constructor(opts: {
    client: GoogleClient;
    refreshToken: string;
    fetch?: FetchFn;
    now?: () => number;
  }) {
    this.#client = opts.client;
    this.#refreshToken = opts.refreshToken;
    this.#fetch = opts.fetch ?? fetch;
    this.#now = opts.now ?? Date.now;
  }

  /** Every token value this object knows, for the redactor. */
  get secrets(): string[] {
    return [this.#refreshToken, this.#access?.token].filter((s): s is string => Boolean(s));
  }

  async accessToken(): Promise<string> {
    if (this.#access && this.#access.expiresAt - 60_000 > this.#now()) return this.#access.token;
    this.#inflight ??= this.#refresh().finally(() => {
      this.#inflight = null;
    });
    return this.#inflight;
  }

  async #refresh(): Promise<string> {
    const json = await tokenRequest(this.#fetch, {
      grant_type: 'refresh_token',
      refresh_token: this.#refreshToken,
      client_id: this.#client.client_id,
      client_secret: this.#client.client_secret,
    });
    const token = String(json.access_token);
    this.#access = { token, expiresAt: this.#now() + Number(json.expires_in ?? 3600) * 1000 };
    return token;
  }

  /** JSON API call with the bearer token; one transparent retry after a 401. */
  async api<T>(url: string, init: RequestInit = {}, retried = false): Promise<T> {
    const token = await this.accessToken();
    let res: Response;
    try {
      res = await this.#fetch(url, {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        signal: init.signal ?? AbortSignal.timeout(20_000),
      });
    } catch (e) {
      throw new ConnectorError('network', `Google API unreachable: ${(e as Error).message}`);
    }
    if (res.status === 401 && !retried) {
      this.#access = null;
      return this.api<T>(url, init, true);
    }
    if (res.status === 404)
      throw new ConnectorError('not_found', `not found: ${new URL(url).pathname}`);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new ConnectorError(
        res.status === 401 || res.status === 403 ? 'auth' : 'protocol',
        `Google API ${res.status}: ${body.slice(0, 200)}`,
      );
    }
    return (await res.json()) as T;
  }
}

/**
 * Desktop OAuth with PKCE on a loopback port (no client secret is relied on for security).
 * Returns the refresh token; the caller stores it in the Keychain.
 */
export async function connectGoogle(opts: {
  client: GoogleClient;
  openUrl: (url: string) => Promise<void>;
  scopes?: string[];
  fetch?: FetchFn;
  timeoutMs?: number;
}): Promise<{ refreshToken: string; scope: string }> {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('hex');

  let redirectUri = '';
  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const err = url.searchParams.get('error');
      const got = url.searchParams.get('code');
      const ok = !err && got && url.searchParams.get('state') === state;
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        ok
          ? '<h2>Jarvis est connecté à Google. Tu peux fermer cet onglet.</h2>'
          : '<h2>Connexion refusée.</h2>',
      );
      server.close();
      clearTimeout(timer);
      if (ok) resolve(got);
      else
        reject(new ConnectorError('auth', err ? `Google consent: ${err}` : 'OAuth state mismatch'));
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new ConnectorError('auth', 'no answer from the browser within 5 minutes'));
    }, opts.timeoutMs ?? 300_000);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      redirectUri = `http://127.0.0.1:${port}`;
      const url = new URL(AUTH_URL);
      url.search = new URLSearchParams({
        client_id: opts.client.client_id,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: (opts.scopes ?? GOOGLE_SCOPES).join(' '),
        code_challenge: challenge,
        code_challenge_method: 'S256',
        access_type: 'offline',
        // select_account: each connection may be a different Gmail (several personal accounts).
        prompt: 'consent select_account',
        state,
      }).toString();
      opts.openUrl(url.toString()).catch(reject);
    });
  });

  const json = await tokenRequest(opts.fetch ?? fetch, {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    client_id: opts.client.client_id,
    client_secret: opts.client.client_secret,
  });
  if (typeof json.refresh_token !== 'string') {
    throw new ConnectorError(
      'auth',
      'Google returned no refresh token (remove Jarvis from your Google account permissions and retry)',
    );
  }
  return { refreshToken: json.refresh_token, scope: String(json.scope ?? '') };
}
