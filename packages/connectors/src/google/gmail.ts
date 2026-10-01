import { base64url, buildMessage, htmlToText } from '../mime.ts';
import type {
  Draft,
  DraftInput,
  ListOptions,
  MailHeader,
  MailMessage,
  MailProvider,
} from '../types.ts';
import type { GoogleAuth } from './oauth.ts';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

interface Part {
  mimeType?: string;
  body?: { data?: string };
  parts?: Part[];
  headers?: { name: string; value: string }[];
}

interface GmailMessage {
  id: string;
  threadId: string;
  snippet?: string;
  labelIds?: string[];
  payload?: Part;
}

const header = (p: Part | undefined, name: string) =>
  p?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

const decode = (data?: string) => (data ? Buffer.from(data, 'base64url').toString('utf8') : '');

/** text/plain when present, otherwise text/html flattened. */
export function extractText(p: Part | undefined): string {
  if (!p) return '';
  const all: Part[] = [];
  const walk = (x: Part) => {
    all.push(x);
    for (const c of x.parts ?? []) walk(c);
  };
  walk(p);
  const plain = all.find((x) => x.mimeType === 'text/plain' && x.body?.data);
  if (plain) return decode(plain.body?.data);
  const html = all.find((x) => x.mimeType === 'text/html' && x.body?.data);
  return html ? htmlToText(decode(html.body?.data)) : '';
}

async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i] as T);
      }
    }),
  );
  return out;
}

export class GmailProvider implements MailProvider {
  readonly account: string;
  readonly email: string;
  readonly #auth: GoogleAuth;

  constructor(account: string, email: string, auth: GoogleAuth) {
    this.account = account;
    this.email = email;
    this.#auth = auth;
  }

  #header(m: GmailMessage): MailHeader {
    const h: MailHeader = {
      id: m.id,
      account: this.account,
      threadId: m.threadId,
      from: header(m.payload, 'From'),
      to: header(m.payload, 'To'),
      subject: header(m.payload, 'Subject'),
      date: header(m.payload, 'Date'),
      snippet: m.snippet ?? '',
      unread: m.labelIds?.includes('UNREAD') ?? false,
    };
    const messageId = header(m.payload, 'Message-ID');
    if (messageId) h.messageId = messageId;
    return h;
  }

  async list(o: ListOptions): Promise<MailHeader[]> {
    const after = Math.floor((Date.now() - o.sinceHours * 3_600_000) / 1000);
    const q = `in:inbox after:${after}${o.unreadOnly ? ' is:unread' : ''}`;
    const res = await this.#auth.api<{ messages?: { id: string }[] }>(
      `${API}/messages?${new URLSearchParams({ q, maxResults: String(o.max) })}`,
    );
    const ids = (res.messages ?? []).map((m) => m.id);
    // Metadata only: bodies are fetched on demand, keeping data usage small.
    return pool(ids, 8, (id) =>
      this.#auth
        .api<GmailMessage>(
          `${API}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Message-ID`,
        )
        .then((m) => this.#header(m)),
    );
  }

  async get(id: string): Promise<MailMessage> {
    const m = await this.#auth.api<GmailMessage>(
      `${API}/messages/${encodeURIComponent(id)}?format=full`,
    );
    const msg: MailMessage = { ...this.#header(m), text: extractText(m.payload) };
    const refs = header(m.payload, 'References');
    if (refs) msg.references = refs;
    return msg;
  }

  async createDraft(d: DraftInput): Promise<Draft> {
    const raw = base64url(await buildMessage(this.email, d));
    const res = await this.#auth.api<{ id: string }>(`${API}/drafts`, {
      method: 'POST',
      body: JSON.stringify({
        message: { raw, ...(d.replyTo?.threadId ? { threadId: d.replyTo.threadId } : {}) },
      }),
    });
    return { id: res.id, account: this.account, to: d.to, subject: d.subject, body: d.body };
  }

  async getDraft(id: string): Promise<Draft> {
    const res = await this.#auth.api<{ id: string; message: GmailMessage }>(
      `${API}/drafts/${encodeURIComponent(id)}?format=full`,
    );
    return {
      id: res.id,
      account: this.account,
      to: header(res.message.payload, 'To'),
      subject: header(res.message.payload, 'Subject'),
      body: extractText(res.message.payload),
    };
  }

  async sendDraft(id: string): Promise<{ id: string }> {
    const res = await this.#auth.api<{ id: string }>(`${API}/drafts/send`, {
      method: 'POST',
      body: JSON.stringify({ id }),
    });
    return { id: res.id };
  }
}
