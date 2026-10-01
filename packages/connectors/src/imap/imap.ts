import { randomUUID } from 'node:crypto';
import type { ConnectionOptions } from 'node:tls';
import { type FetchMessageObject, ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { buildMessage, htmlToText } from '../mime.ts';
import {
  ConnectorError,
  type Draft,
  type DraftInput,
  type ListOptions,
  type MailHeader,
  type MailMessage,
  type MailProvider,
} from '../types.ts';

export interface ImapAccountConfig {
  account: string;
  email: string;
  /** Login when it differs from the address. */
  user?: string;
  imap: { host: string; port: number; secure: boolean };
  smtp: { host: string; port: number; secure: boolean };
  /** Trust exactly this (self-signed) certificate. Verification itself is never turned off. */
  caPem?: string;
}

/** TLS is mandatory: implicit TLS, or STARTTLS required — never plaintext credentials. */
export function tlsOptions(cfg: ImapAccountConfig): ConnectionOptions {
  return {
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2',
    ...(cfg.caPem ? { ca: [cfg.caPem] } : {}),
  };
}

export type ImapFactory = () => ImapFlow;
export type SmtpSend = (raw: Buffer, from: string, to: string[]) => Promise<void>;

function classify(e: unknown): ConnectorError {
  const err = e as { authenticationFailed?: boolean; code?: string; message?: string };
  if (err.authenticationFailed)
    return new ConnectorError('auth', 'IMAP login refused (check the account password)');
  if (
    err.code &&
    ['ENOTFOUND', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH'].includes(err.code)
  ) {
    return new ConnectorError('network', `mail server unreachable (${err.code})`);
  }
  if (
    err.code?.startsWith('CERT_') ||
    err.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    err.code === 'SELF_SIGNED_CERT_IN_CHAIN'
  ) {
    return new ConnectorError(
      'protocol',
      `untrusted server certificate (${err.code}): add its certificate (ca_pem) to the account, never disable verification`,
    );
  }
  return new ConnectorError('protocol', err.message ?? String(e));
}

const addr = (list?: { name?: string; address?: string }[]) =>
  (list ?? [])
    .map((a) => (a.name ? `${a.name} <${a.address ?? ''}>` : (a.address ?? '')))
    .join(', ');

export class ImapProvider implements MailProvider {
  readonly account: string;
  readonly email: string;
  readonly #cfg: ImapAccountConfig;
  readonly #factory: ImapFactory;
  readonly #send: SmtpSend;
  /** Drafts are kept as built: what Brightky approved is byte-for-byte what is sent. */
  readonly #drafts = new Map<
    string,
    { draft: Draft; raw: Buffer; mailbox?: string; uid?: number }
  >();

  constructor(
    cfg: ImapAccountConfig,
    password: string,
    deps: { factory?: ImapFactory; send?: SmtpSend } = {},
  ) {
    this.account = cfg.account;
    this.email = cfg.email;
    this.#cfg = cfg;
    const user = cfg.user ?? cfg.email;
    const tls = tlsOptions(cfg);
    this.#factory =
      deps.factory ??
      (() =>
        new ImapFlow({
          host: cfg.imap.host,
          port: cfg.imap.port,
          secure: cfg.imap.secure,
          doSTARTTLS: cfg.imap.secure ? undefined : true,
          auth: { user, pass: password },
          tls,
          logger: false,
        }));
    this.#send =
      deps.send ??
      (async (raw, from, to) => {
        const transport = nodemailer.createTransport({
          host: cfg.smtp.host,
          port: cfg.smtp.port,
          secure: cfg.smtp.secure,
          requireTLS: !cfg.smtp.secure,
          auth: { user, pass: password },
          tls,
        });
        try {
          await transport.sendMail({ envelope: { from, to }, raw });
        } finally {
          transport.close();
        }
      });
  }

  async #with<T>(fn: (c: ImapFlow) => Promise<T>): Promise<T> {
    const c = this.#factory();
    try {
      await c.connect();
    } catch (e) {
      throw classify(e);
    }
    try {
      return await fn(c);
    } catch (e) {
      throw e instanceof ConnectorError ? e : classify(e);
    } finally {
      await c.logout().catch(() => undefined);
    }
  }

  async #inbox<T>(fn: (c: ImapFlow) => Promise<T>): Promise<T> {
    return this.#with(async (c) => {
      const lock = await c.getMailboxLock('INBOX');
      try {
        return await fn(c);
      } finally {
        lock.release();
      }
    });
  }

  #header(m: FetchMessageObject, snippet: string): MailHeader {
    const e = m.envelope;
    const h: MailHeader = {
      id: String(m.uid),
      account: this.account,
      from: addr(e?.from),
      to: addr(e?.to),
      subject: e?.subject ?? '',
      date: e?.date ? new Date(e.date).toISOString() : '',
      snippet,
      unread: !m.flags?.has('\\Seen'),
    };
    if (e?.messageId) h.messageId = e.messageId;
    return h;
  }

  /** Verifies login on both protocols (used by `jarvis mail test`). */
  async test(): Promise<void> {
    await this.#with(async () => undefined);
  }

  async list(o: ListOptions): Promise<MailHeader[]> {
    return this.#inbox(async (c) => {
      const since = new Date(Date.now() - o.sinceHours * 3_600_000);
      const uids =
        (await c.search({ since, ...(o.unreadOnly ? { seen: false } : {}) }, { uid: true })) || [];
      const pick = uids.slice(-o.max);
      if (pick.length === 0) return [];
      // Only the first 16 KB of each message: enough for a snippet, light on mobile data.
      const msgs = await c.fetchAll(
        pick,
        { uid: true, envelope: true, flags: true, source: { start: 0, maxLength: 16_384 } },
        { uid: true },
      );
      const headers = await Promise.all(
        msgs.map(async (m) => {
          const parsed = m.source ? await simpleParser(m.source).catch(() => null) : null;
          const text = parsed?.text ?? (parsed?.html ? htmlToText(parsed.html) : '');
          return this.#header(m, text.replace(/\s+/g, ' ').trim().slice(0, 200));
        }),
      );
      return headers.reverse();
    });
  }

  async get(id: string): Promise<MailMessage> {
    return this.#inbox(async (c) => {
      const m = await c.fetchOne(
        id,
        { uid: true, envelope: true, flags: true, source: true },
        { uid: true },
      );
      if (!m || !m.source) throw new ConnectorError('not_found', `no message ${id} in INBOX`);
      const parsed = await simpleParser(m.source);
      const text = parsed.text ?? (parsed.html ? htmlToText(parsed.html) : '');
      const msg: MailMessage = { ...this.#header(m, text.slice(0, 200)), text };
      const refs = parsed.references;
      if (refs) msg.references = Array.isArray(refs) ? refs.join(' ') : refs;
      return msg;
    });
  }

  async #specialMailbox(
    c: ImapFlow,
    use: '\\Drafts' | '\\Sent',
    fallback: string,
  ): Promise<string> {
    const boxes = await c.list();
    return boxes.find((b) => b.specialUse === use)?.path ?? fallback;
  }

  async createDraft(d: DraftInput): Promise<Draft> {
    const raw = await buildMessage(this.email, d);
    const id = `local-${randomUUID().slice(0, 8)}`;
    const draft: Draft = { id, account: this.account, to: d.to, subject: d.subject, body: d.body };
    const entry: { draft: Draft; raw: Buffer; mailbox?: string; uid?: number } = { draft, raw };
    // Also visible in the server's Drafts folder, so Brightky can finish it from any client.
    await this.#with(async (c) => {
      const mailbox = await this.#specialMailbox(c, '\\Drafts', 'Drafts');
      const res = await c.append(mailbox, raw, ['\\Draft', '\\Seen']);
      entry.mailbox = mailbox;
      if (res && res.uid) entry.uid = res.uid;
    });
    this.#drafts.set(id, entry);
    return draft;
  }

  async getDraft(id: string): Promise<Draft> {
    const e = this.#drafts.get(id);
    if (!e)
      throw new ConnectorError(
        'not_found',
        `unknown draft ${id} (drafts are kept until jarvisd restarts)`,
      );
    return e.draft;
  }

  async sendDraft(id: string): Promise<{ id: string }> {
    const e = this.#drafts.get(id);
    if (!e) throw new ConnectorError('not_found', `unknown draft ${id}`);
    try {
      await this.#send(e.raw, this.email, [e.draft.to]);
    } catch (err) {
      throw classify(err);
    }
    this.#drafts.delete(id);
    // Housekeeping is best effort: the mail is already sent.
    await this.#with(async (c) => {
      const sent = await this.#specialMailbox(c, '\\Sent', 'Sent');
      await c.append(sent, e.raw, ['\\Seen']);
      if (e.mailbox && e.uid) {
        const lock = await c.getMailboxLock(e.mailbox);
        try {
          await c.messageDelete(String(e.uid), { uid: true });
        } finally {
          lock.release();
        }
      }
    }).catch(() => undefined);
    return { id };
  }
}
