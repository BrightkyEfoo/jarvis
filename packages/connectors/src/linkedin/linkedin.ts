import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { FetchFn } from '../google/oauth.ts';

/**
 * LinkedIn through its official, free "Share on LinkedIn" product (w_member_social) and Sign In
 * with LinkedIn (OpenID Connect). Posting only: the member APIs give no read access to posts or
 * analytics to individuals (those come from the creator-analytics export Brightky downloads).
 */
export const LINKEDIN_SCOPES = ['openid', 'profile', 'email', 'w_member_social'];
export const LINKEDIN_VERSION = '202609';
export const LINKEDIN_REDIRECT_PORT = 8765;
export const LINKEDIN_REDIRECT = `http://127.0.0.1:${LINKEDIN_REDIRECT_PORT}/callback`;

const AUTH_URL = 'https://www.linkedin.com/oauth/v2/authorization';
const TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';
const API = 'https://api.linkedin.com';

export interface LinkedInApp {
  client_id: string;
  client_secret: string;
}

export interface LinkedInToken {
  access_token: string;
  /** Epoch ms. Tokens last 60 days and cannot be refreshed: reconnect before. */
  expires_at: number;
  /** urn:li:person:… */
  person: string;
  name?: string;
}

/**
 * LinkedIn's "little text" format: these characters must be escaped or the post is cut or garbled
 * (code in posts is full of them).
 */
export function escapeLittleText(text: string): string {
  return text.replace(/[\\|{}@[\]()<>#*_~]/g, (c) => `\\${c}`);
}

/** Authorization code flow on a fixed loopback port (LinkedIn wants the exact redirect URL). */
export async function connectLinkedIn(opts: {
  app: LinkedInApp;
  openUrl: (url: string) => Promise<void>;
  fetch?: FetchFn;
  timeoutMs?: number;
}): Promise<LinkedInToken> {
  const f = opts.fetch ?? fetch;
  const state = randomBytes(16).toString('hex');
  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const err = url.searchParams.get('error_description') ?? url.searchParams.get('error');
      const got = url.searchParams.get('code');
      const ok = !err && got && url.searchParams.get('state') === state;
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        ok
          ? '<h2>Jarvis est connecté à LinkedIn. Tu peux fermer cet onglet.</h2>'
          : '<h2>Connexion refusée.</h2>',
      );
      server.close();
      clearTimeout(timer);
      if (ok) resolve(got);
      else reject(new Error(err ? `LinkedIn : ${err}` : 'LinkedIn : état OAuth invalide'));
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('pas de réponse du navigateur en 5 minutes'));
    }, opts.timeoutMs ?? 300_000);
    server.once('error', reject);
    server.listen(LINKEDIN_REDIRECT_PORT, '127.0.0.1', () => {
      const url = new URL(AUTH_URL);
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: opts.app.client_id,
        redirect_uri: LINKEDIN_REDIRECT,
        scope: LINKEDIN_SCOPES.join(' '),
        state,
      }).toString();
      opts.openUrl(url.toString()).catch(reject);
    });
  });
  const res = await f(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: LINKEDIN_REDIRECT,
      client_id: opts.app.client_id,
      client_secret: opts.app.client_secret,
    }),
  });
  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
  };
  if (!res.ok || !json.access_token)
    throw new Error(`LinkedIn a refusé le jeton : ${json.error_description ?? res.status}`);
  const me = await new LinkedInClient({ token: () => json.access_token as string, fetch: f }).me();
  return {
    access_token: json.access_token,
    expires_at: Date.now() + (json.expires_in ?? 60 * 86_400) * 1000,
    person: me.urn,
    ...(me.name && { name: me.name }),
  };
}

export interface LinkedInPost {
  text: string;
  images?: { bytes: Uint8Array; mime: 'image/png' | 'image/jpeg'; alt: string }[];
  /** A PDF shown as a swipeable document ("carousel") post. */
  document?: { bytes: Uint8Array; title: string };
}

export class LinkedInClient {
  readonly #token: () => string;
  readonly #fetch: FetchFn;

  constructor(o: { token: () => string; fetch?: FetchFn }) {
    this.#token = o.token;
    this.#fetch = o.fetch ?? fetch;
  }

  #headers(json = true): Record<string, string> {
    return {
      authorization: `Bearer ${this.#token()}`,
      'linkedin-version': LINKEDIN_VERSION,
      'x-restli-protocol-version': '2.0.0',
      ...(json && { 'content-type': 'application/json' }),
    };
  }

  async #call(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await this.#fetch(`${API}${path}`, {
      method,
      headers: this.#headers(body !== undefined),
      ...(body !== undefined && { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      throw new Error(`LinkedIn ${method} ${path.split('?')[0]} → ${res.status} ${detail}`);
    }
    return res;
  }

  async me(): Promise<{ urn: string; name?: string }> {
    const res = await this.#fetch(`${API}/v2/userinfo`, {
      headers: { authorization: `Bearer ${this.#token()}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`LinkedIn userinfo → ${res.status}`);
    const u = (await res.json()) as { sub?: string; name?: string };
    if (!u.sub) throw new Error('LinkedIn : profil sans identifiant');
    return { urn: `urn:li:person:${u.sub}`, ...(u.name && { name: u.name }) };
  }

  /** initializeUpload, then PUT the bytes to the returned URL (LinkedIn's own host only). */
  async #upload(kind: 'images' | 'documents', owner: string, bytes: Uint8Array): Promise<string> {
    const init = await this.#call('POST', `/rest/${kind}?action=initializeUpload`, {
      initializeUploadRequest: { owner },
    });
    const v = (
      (await init.json()) as { value?: { uploadUrl?: string; image?: string; document?: string } }
    ).value;
    const urn = v?.image ?? v?.document;
    const upload = v?.uploadUrl ? new URL(v.uploadUrl) : null;
    if (
      !urn ||
      !upload ||
      upload.protocol !== 'https:' ||
      !/(^|\.)linkedin\.com$|(^|\.)licdn\.com$/.test(upload.hostname)
    )
      throw new Error('LinkedIn : adresse de dépôt inattendue');
    const put = await this.#fetch(upload, {
      method: 'PUT',
      headers: { authorization: `Bearer ${this.#token()}` },
      body: bytes,
      redirect: 'error',
      signal: AbortSignal.timeout(120_000),
    });
    if (!put.ok) throw new Error(`LinkedIn : dépôt du fichier refusé (${put.status})`);
    return urn;
  }

  /** Publishes now, as Brightky. Returns the post URN and its public URL. */
  async post(author: string, p: LinkedInPost): Promise<{ urn: string; url: string }> {
    let content: unknown;
    if (p.document) {
      const id = await this.#upload('documents', author, p.document.bytes);
      content = { media: { id, title: p.document.title } };
    } else if (p.images?.length === 1) {
      const [img] = p.images;
      const id = await this.#upload('images', author, img?.bytes ?? new Uint8Array());
      content = { media: { id, altText: img?.alt ?? '' } };
    } else if (p.images && p.images.length > 1) {
      const images = [];
      for (const img of p.images.slice(0, 20))
        images.push({ id: await this.#upload('images', author, img.bytes), altText: img.alt });
      content = { multiImage: { images } };
    }
    const res = await this.#call('POST', '/rest/posts', {
      author,
      commentary: escapeLittleText(p.text),
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      ...(content !== undefined && { content }),
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    });
    const urn = res.headers.get('x-restli-id') ?? res.headers.get('x-linkedin-id') ?? '';
    if (!urn) throw new Error('LinkedIn : publication sans identifiant');
    return { urn, url: `https://www.linkedin.com/feed/update/${urn}/` };
  }
}
