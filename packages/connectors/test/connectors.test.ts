import type { ImapFlow } from 'imapflow';
import { describe, expect, it } from 'vitest';
import {
  buildMessage,
  ConnectorError,
  extractText,
  GmailProvider,
  GoogleAuth,
  GoogleCalendar,
  htmlToText,
  ImapProvider,
  parseClientFile,
  tlsOptions,
} from '../src/index.ts';

const client = { client_id: 'cid.apps.googleusercontent.com', client_secret: 'csecret' };
const b64 = (s: string) => Buffer.from(s).toString('base64url');

/** Minimal fake of fetch: routes by URL prefix, records calls. */
function fakeFetch(
  routes: Record<string, (url: string, init?: RequestInit) => { status?: number; body: unknown }>,
) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(init ? { url, init } : { url });
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) return new Response('not found', { status: 404 });
    const r = routes[key]?.(url, init) ?? { body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { f, calls };
}

const tokenRoute = {
  'https://oauth2.googleapis.com/token': () => ({
    body: { access_token: 'ya29.access-token-value-0000000000', expires_in: 3600 },
  }),
};

describe('Google OAuth', () => {
  it('reads a Desktop client file and rejects anything else', () => {
    expect(parseClientFile(JSON.stringify({ installed: client }))).toEqual(client);
    expect(() => parseClientFile(JSON.stringify({ web: client }))).toThrow(ConnectorError);
  });

  it('refreshes once, caches the access token, and retries a 401 transparently', async () => {
    let n = 0;
    let first = true;
    const { f, calls } = fakeFetch({
      'https://oauth2.googleapis.com/token': () => ({
        body: { access_token: `tok-${++n}`, expires_in: 3600 },
      }),
      'https://api.test/x': () => {
        if (!first) return { body: { ok: true } };
        first = false; // the first call answers 401: the token must be refreshed once
        return { status: 401, body: {} };
      },
    });
    const auth = new GoogleAuth({ client, refreshToken: 'refresh-1', fetch: f });
    expect(await Promise.all([auth.accessToken(), auth.accessToken()])).toEqual(['tok-1', 'tok-1']);
    expect(await auth.api('https://api.test/x')).toEqual({ ok: true });
    expect(calls.filter((c) => c.url.includes('token'))).toHaveLength(2); // initial + after 401
    expect(auth.secrets).toContain('refresh-1');
  });

  it('turns invalid_grant into an auth error asking to reconnect', async () => {
    const { f } = fakeFetch({
      'https://oauth2.googleapis.com/token': () => ({
        status: 400,
        body: { error: 'invalid_grant' },
      }),
    });
    await expect(
      new GoogleAuth({ client, refreshToken: 'r', fetch: f }).accessToken(),
    ).rejects.toMatchObject({ kind: 'auth' });
  });
});

describe('GmailProvider', () => {
  const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
  const meta = (id: string, subject: string) => ({
    id,
    threadId: `t${id}`,
    snippet: `snippet ${id}`,
    labelIds: ['INBOX', 'UNREAD'],
    payload: {
      headers: [
        { name: 'From', value: 'Paul <paul@client.cm>' },
        { name: 'Subject', value: subject },
        { name: 'Message-ID', value: `<${id}@mail>` },
      ],
    },
  });

  it('lists recent inbox mail with metadata only', async () => {
    const { f, calls } = fakeFetch({
      ...tokenRoute,
      [`${API}/messages?`]: () => ({ body: { messages: [{ id: 'm1' }, { id: 'm2' }] } }),
      [`${API}/messages/m1`]: () => ({ body: meta('m1', 'Devis') }),
      [`${API}/messages/m2`]: () => ({ body: meta('m2', 'Facture') }),
    });
    const gmail = new GmailProvider(
      'perso',
      'brightkyefoo@gmail.com',
      new GoogleAuth({ client, refreshToken: 'r', fetch: f }),
    );
    const list = await gmail.list({ unreadOnly: true, sinceHours: 24, max: 10 });
    expect(list.map((m) => [m.id, m.subject, m.unread, m.messageId])).toEqual([
      ['m1', 'Devis', true, '<m1@mail>'],
      ['m2', 'Facture', true, '<m2@mail>'],
    ]);
    const q = new URL(
      calls.find((c) => c.url.startsWith(`${API}/messages?`))?.url ?? '',
    ).searchParams.get('q');
    expect(q).toMatch(/^in:inbox after:\d+ is:unread$/);
    expect(calls.filter((c) => c.url.includes('format=metadata'))).toHaveLength(2);
  });

  it('creates a threaded reply draft and sends exactly that draft', async () => {
    let posted: { message: { raw: string; threadId?: string } } | undefined;
    const { f, calls } = fakeFetch({
      ...tokenRoute,
      [`${API}/drafts/send`]: () => ({ body: { id: 'sent-1' } }),
      [`${API}/drafts`]: (_u, init) => {
        posted = JSON.parse(String(init?.body));
        return { body: { id: 'd1' } };
      },
    });
    const gmail = new GmailProvider(
      'perso',
      'brightkyefoo@gmail.com',
      new GoogleAuth({ client, refreshToken: 'r', fetch: f }),
    );
    const original = {
      id: 'm1',
      account: 'perso',
      threadId: 't1',
      from: 'paul@client.cm',
      to: '',
      subject: 'Devis',
      date: '',
      snippet: '',
      unread: true,
      messageId: '<m1@mail>',
      text: '',
    };
    const d = await gmail.createDraft({
      to: 'paul@client.cm',
      subject: 'Devis',
      body: 'Je valide le devis.',
      replyTo: original,
    });
    expect(d).toMatchObject({ id: 'd1', to: 'paul@client.cm' });
    const raw = Buffer.from(posted?.message.raw ?? '', 'base64url').toString();
    expect(posted?.message.threadId).toBe('t1');
    expect(raw).toMatch(/In-Reply-To: <m1@mail>/);
    expect(raw).toMatch(/Subject: Re: Devis/);
    expect(await gmail.sendDraft('d1')).toEqual({ id: 'sent-1' });
    expect(JSON.parse(String(calls.at(-1)?.init?.body))).toEqual({ id: 'd1' });
  });

  it('extracts text/plain, else flattens HTML', () => {
    expect(
      extractText({
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/html', body: { data: b64('<p>html</p>') } },
          { mimeType: 'text/plain', body: { data: b64('plain') } },
        ],
      }),
    ).toBe('plain');
    expect(
      extractText({
        mimeType: 'text/html',
        body: { data: b64('<style>x</style><p>Bonjour&nbsp;Paul</p><br>Fin') },
      }),
    ).toBe('Bonjour Paul\n\nFin');
  });
});

describe('GoogleCalendar', () => {
  it('lists events, skipping cancelled ones', async () => {
    const { f } = fakeFetch({
      ...tokenRoute,
      'https://www.googleapis.com/calendar/v3/calendars/primary/events': () => ({
        body: {
          items: [
            {
              id: 'e1',
              summary: 'Démo client',
              start: { dateTime: '2026-10-01T11:00:00+01:00' },
              end: { dateTime: '2026-10-01T12:00:00+01:00' },
              attendees: [{}, {}],
              hangoutLink: 'https://meet',
            },
            {
              id: 'e2',
              status: 'cancelled',
              summary: 'Annulé',
              start: { date: '2026-10-01' },
              end: { date: '2026-10-02' },
            },
            { id: 'e3', start: { date: '2026-10-01' }, end: { date: '2026-10-02' } },
          ],
        },
      }),
    });
    const events = await new GoogleCalendar(
      new GoogleAuth({ client, refreshToken: 'r', fetch: f }),
    ).events(new Date(), new Date(), 10);
    expect(events.map((e) => [e.id, e.title, e.allDay, e.attendees, e.hasVideoLink])).toEqual([
      ['e1', 'Démo client', false, 2, true],
      ['e3', '(sans titre)', true, 0, false],
    ]);
  });
});

describe('ImapProvider', () => {
  const cfg = {
    account: 'pro',
    email: 'brightky@scriptify.cm',
    imap: { host: 'imap.test', port: 993, secure: true },
    smtp: { host: 'smtp.test', port: 587, secure: false },
  };
  const mail = (uid: number, subject: string, body: string) =>
    Buffer.from(
      `From: Client <c@x.cm>\r\nTo: brightky@scriptify.cm\r\nSubject: ${subject}\r\nMessage-ID: <${uid}@x>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`,
    );

  function fakeImap() {
    const appended: { box: string; raw: string; flags?: string[] }[] = [];
    const deleted: string[] = [];
    let loggedOut = 0;
    const msgs = new Map([
      [11, mail(11, 'Relance facture', 'Bonjour, la facture 42 est en retard.')],
      [12, mail(12, 'Réunion', 'On décale à jeudi ?')],
    ]);
    const env = (uid: number, subject: string) => ({
      subject,
      messageId: `<${uid}@x>`,
      date: new Date('2026-10-01T08:00:00Z'),
      from: [{ name: 'Client', address: 'c@x.cm' }],
      to: [{ address: 'brightky@scriptify.cm' }],
    });
    const fake = {
      connect: async () => undefined,
      logout: async () => void loggedOut++,
      getMailboxLock: async () => ({ release: () => undefined }),
      search: async () => [11, 12],
      fetchAll: async (uids: number[]) =>
        uids.map((uid) => ({
          uid,
          flags: new Set(uid === 11 ? [] : ['\\Seen']),
          envelope: env(uid, uid === 11 ? 'Relance facture' : 'Réunion'),
          source: msgs.get(uid),
        })),
      fetchOne: async (uid: string) => ({
        uid: Number(uid),
        flags: new Set(),
        envelope: env(Number(uid), 'Relance facture'),
        source: msgs.get(Number(uid)),
      }),
      list: async () => [
        { path: 'INBOX' },
        { path: 'Brouillons', specialUse: '\\Drafts' },
        { path: 'Envoyés', specialUse: '\\Sent' },
      ],
      append: async (box: string, raw: Buffer, flags?: string[]) => {
        appended.push({ box, raw: raw.toString(), flags });
        return { destination: box, uid: 99 };
      },
      messageDelete: async (range: string) => {
        deleted.push(range);
        return true;
      },
    };
    return { fake, appended, deleted, loggedOut: () => loggedOut };
  }

  it('lists newest first with snippets and unread state, and always logs out', async () => {
    const { fake, loggedOut } = fakeImap();
    const p = new ImapProvider(cfg, 'pw', {
      factory: () => fake as unknown as ImapFlow,
      send: async () => undefined,
    });
    const list = await p.list({ unreadOnly: false, sinceHours: 24, max: 10 });
    expect(list.map((m) => [m.id, m.subject, m.unread])).toEqual([
      ['12', 'Réunion', false],
      ['11', 'Relance facture', true],
    ]);
    expect(list[1]?.snippet).toBe('Bonjour, la facture 42 est en retard.');
    expect(loggedOut()).toBe(1);
  });

  it('drafts into the Drafts folder and sends exactly the approved bytes', async () => {
    const { fake, appended, deleted } = fakeImap();
    const sent: { raw: string; from: string; to: string[] }[] = [];
    const p = new ImapProvider(cfg, 'pw', {
      factory: () => fake as unknown as ImapFlow,
      send: async (raw, from, to) => void sent.push({ raw: raw.toString(), from, to }),
    });
    const original = await p.get('11');
    const d = await p.createDraft({
      to: 'c@x.cm',
      subject: original.subject,
      body: 'Réglée ce matin.',
      replyTo: original,
    });
    expect(appended[0]).toMatchObject({ box: 'Brouillons', flags: ['\\Draft', '\\Seen'] });
    expect(appended[0]?.raw).toMatch(/In-Reply-To: <11@x>/);
    await p.sendDraft(d.id);
    expect(sent[0]?.raw).toBe(appended[0]?.raw);
    expect(sent[0]?.to).toEqual(['c@x.cm']);
    expect(appended[1]?.box).toBe('Envoyés');
    expect(deleted).toEqual(['99']);
    await expect(p.sendDraft(d.id)).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('maps failures to actionable errors', async () => {
    const failing = (e: object) => ({
      connect: async () => Promise.reject(Object.assign(new Error('x'), e)),
      logout: async () => undefined,
    });
    const p = (e: object) =>
      new ImapProvider(cfg, 'pw', { factory: () => failing(e) as unknown as ImapFlow });
    await expect(
      p({ authenticationFailed: true }).list({ unreadOnly: true, sinceHours: 1, max: 1 }),
    ).rejects.toMatchObject({ kind: 'auth' });
    await expect(
      p({ code: 'ETIMEDOUT' }).list({ unreadOnly: true, sinceHours: 1, max: 1 }),
    ).rejects.toMatchObject({ kind: 'network' });
    await expect(
      p({ code: 'CERT_HAS_EXPIRED' }).list({ unreadOnly: true, sinceHours: 1, max: 1 }),
    ).rejects.toThrow(/never disable verification/);
  });

  it('never turns certificate verification off', () => {
    expect(tlsOptions(cfg)).toMatchObject({ rejectUnauthorized: true, minVersion: 'TLSv1.2' });
    expect(tlsOptions({ ...cfg, caPem: 'PEM' })).toMatchObject({
      rejectUnauthorized: true,
      ca: ['PEM'],
    });
  });
});

describe('mime', () => {
  it('builds UTF-8 messages and does not double the Re:', async () => {
    const raw = (
      await buildMessage('a@b.cm', { to: 'p@x.cm', subject: 'Re: Devis', body: 'Merci ✓' })
    ).toString();
    expect(raw).toMatch(/Subject: Re: Devis\r\n/);
    expect(htmlToText('<script>evil()</script><b>ok</b>')).toBe('ok');
  });
});
