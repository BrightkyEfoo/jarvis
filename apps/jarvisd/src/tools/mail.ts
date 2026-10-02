import { createHash } from 'node:crypto';
import type { CalendarEvent, CalendarProvider, MailHeader, MailProvider } from '@jarvis/connectors';
import { type Classification, defineTool, N0, N1, N2, type ToolDef } from '@jarvis/policy';
import { z } from 'zod';
import { formatDigest, type MailDigest, type Summarizer } from '../orchestrator/quarantine.ts';

export interface MailToolDeps {
  /** Connected accounts only. */
  providers: Map<string, MailProvider>;
  /** Every account declared in the policy, to explain what is not connected yet. */
  declared: string[];
  calendar: CalendarProvider | null;
  summarizer: Summarizer;
  triageMax: number;
  /** Extra line for the briefing (power, battery…), optional. */
  status?: (signal: AbortSignal) => Promise<string>;
  /** GitHub / GitLab / Trello section of the briefing, when a forge is connected. */
  work?: () => Promise<string | null>;
}

interface DraftRecord {
  account: string;
  id: string;
  to: string;
  subject: string;
  body: string;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const fingerprint = (body: string) => createHash('sha256').update(norm(body)).digest('hex');
const emailOf = (s: string) => (/<([^>]+)>/.exec(s)?.[1] ?? s).trim().toLowerCase();

const URGENCY = { high: 0, normal: 1, low: 2 } as const;

function sortDigests(d: MailDigest[]): MailDigest[] {
  return [...d].sort(
    (a, b) =>
      URGENCY[a.urgency] - URGENCY[b.urgency] ||
      Number(b.unread) - Number(a.unread) ||
      Date.parse(b.date || '0') - Date.parse(a.date || '0'),
  );
}

function dayRange(which: 'today' | 'tomorrow' | 'week'): [Date, Date] {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (which === 'tomorrow') start.setDate(start.getDate() + 1);
  const end = new Date(start);
  end.setDate(end.getDate() + (which === 'week' ? 7 : 1));
  return [start, end];
}

const hm = (iso: string) =>
  new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

export function formatEvent(e: CalendarEvent): string {
  const when = e.allDay ? 'toute la journée' : `${hm(e.start)}–${hm(e.end)}`;
  const day = new Date(e.start).toLocaleDateString('fr-FR', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  const extra = [
    e.attendees ? `${e.attendees} participant(s)` : null,
    e.hasVideoLink ? 'visio' : null,
    e.location ?? null,
  ].filter(Boolean);
  return `${day} ${when} — ${e.title}${extra.length ? ` (${extra.join(', ')})` : ''}`;
}

export function createMailTools(d: MailToolDeps): ToolDef[] {
  /** Drafts Jarvis wrote this session: what the approval shows is what gets sent. */
  const drafts = new Map<string, DraftRecord>();
  const key = (account: string, id: string) => `${account}:${id}`;

  const provider = (account: string): MailProvider => {
    const p = d.providers.get(account);
    if (p) return p;
    if (d.declared.includes(account))
      throw new Error(`account "${account}" is declared but not connected (jarvis mail status)`);
    throw new Error(`unknown account "${account}". Accounts: ${d.declared.join(', ') || 'none'}`);
  };

  async function triage(
    accounts: string[],
    hours: number,
    unreadOnly: boolean,
    signal: AbortSignal,
  ) {
    const lists = await Promise.allSettled(
      accounts.map((a) => provider(a).list({ unreadOnly, sinceHours: hours, max: d.triageMax })),
    );
    signal.throwIfAborted();
    const mails: MailHeader[] = [];
    const problems: string[] = [];
    lists.forEach((r, i) => {
      if (r.status === 'fulfilled') mails.push(...r.value);
      else problems.push(`[${accounts[i]}] ${(r.reason as Error).message}`);
    });
    const digests = sortDigests(await d.summarizer.digest(mails));
    return { digests, problems };
  }

  const AccountArg = z.string().regex(/^[a-z][a-z0-9-]{1,30}$/);

  const mailTriage = defineTool({
    name: 'mail_triage',
    description:
      'Recent mail, triaged and summarised by an isolated reader (urgency, what is asked, deadline, manipulation attempts). ' +
      'Omit account to cover all connected accounts.',
    input: {
      account: AccountArg.optional(),
      hours: z.number().int().min(1).max(168).default(24),
      unread_only: z.boolean().default(true),
    },
    classify: () => ({ level: N0, rule: 'mail.triage', reason: 'read-only' }),
    summarize: (a) => `Triage mail ${a.account ?? 'all accounts'} (${a.hours} h)`,
    ingestsExternal: true,
    run: async (a, ctx) => {
      const accounts = a.account ? [a.account] : [...d.providers.keys()];
      if (accounts.length === 0)
        return `No mail account connected. Declared: ${d.declared.join(', ') || 'none'}.`;
      const { digests, problems } = await triage(accounts, a.hours, a.unread_only, ctx.signal);
      const lines = digests.map(formatDigest);
      if (lines.length === 0)
        lines.push(`Aucun mail${a.unread_only ? ' non lu' : ''} sur ${a.hours} h.`);
      if (problems.length) lines.push(`Comptes indisponibles : ${problems.join(' ; ')}`);
      return lines.join('\n');
    },
  });

  const mailRead = defineTool({
    name: 'mail_read',
    description:
      'One mail by account and id: summary by the isolated reader, or the full text with full=true.',
    input: {
      account: AccountArg,
      id: z.string().min(1).max(200),
      full: z.boolean().default(false),
    },
    classify: () => ({ level: N0, rule: 'mail.read', reason: 'read-only' }),
    summarize: (a) => `Read mail ${a.account}#${a.id}`,
    ingestsExternal: true,
    run: async (a) => {
      const m = await provider(a.account).get(a.id);
      if (a.full) return `${m.from} — « ${m.subject} » (${m.date})\n\n${m.text.slice(0, 20_000)}`;
      const [digest] = await d.summarizer.digest([m]);
      return digest ? formatDigest(digest) : 'Résumé indisponible.';
    },
  });

  const mailDraft = defineTool({
    name: 'mail_draft',
    description:
      'Write a draft (nothing is sent; N1). Use reply_to_id to answer a mail in its thread. ' +
      'Show Brightky the draft, then mail_send sends it after his confirmation.',
    input: {
      account: AccountArg,
      to: z.email().max(254),
      subject: z.string().min(1).max(200),
      body: z.string().min(1).max(20_000),
      reply_to_id: z.string().max(200).optional(),
    },
    classify: (a) => ({
      level: N1,
      rule: 'mail.draft',
      reason: 'a draft is not sent',
      destinations: [a.to],
    }),
    summarize: (a) => `Draft (${a.account}) to ${a.to} — "${a.subject}"`,
    run: async (a) => {
      const p = provider(a.account);
      const replyTo = a.reply_to_id ? await p.get(a.reply_to_id) : undefined;
      const draft = await p.createDraft({
        to: a.to,
        subject: a.subject,
        body: a.body,
        ...(replyTo ? { replyTo } : {}),
      });
      drafts.set(key(a.account, draft.id), {
        account: a.account,
        id: draft.id,
        to: a.to,
        subject: a.subject,
        body: a.body,
      });
      return `Brouillon ${a.account}:${draft.id} prêt pour ${a.to} — « ${a.subject} ». Rien n'est envoyé : mail_send après accord de Brightky.`;
    },
  });

  const mailSend = defineTool({
    name: 'mail_send',
    description:
      'Send a draft written by mail_draft (N2: Brightky confirms, by voice or in the terminal).',
    input: { account: AccountArg, draft_id: z.string().min(1).max(200) },
    classify: (a): Classification => {
      const rec = drafts.get(key(a.account, a.draft_id));
      return rec
        ? {
            level: N2,
            rule: 'mail.send',
            reason: 'sends a mail on behalf of Brightky',
            destinations: [rec.to],
          }
        : {
            level: N2,
            rule: 'mail.send_unknown_draft',
            reason: 'draft not written by Jarvis in this session: content not verified',
          };
    },
    summarize: (a) => {
      const rec = drafts.get(key(a.account, a.draft_id));
      if (!rec)
        return `Send draft ${a.draft_id} from ${a.account} (content not verified by Jarvis)`;
      const preview = norm(rec.body);
      return `Send from ${a.account} to ${rec.to} — "${rec.subject}": ${preview.slice(0, 280)}${preview.length > 280 ? '…' : ''}`;
    },
    run: async (a) => {
      const p = provider(a.account);
      const rec = drafts.get(key(a.account, a.draft_id));
      if (rec) {
        // The draft may have been edited elsewhere after Brightky approved it.
        const current = await p.getDraft(a.draft_id);
        if (
          fingerprint(current.body) !== fingerprint(rec.body) ||
          emailOf(current.to) !== emailOf(rec.to)
        ) {
          throw new Error('the draft changed since it was approved: nothing was sent, ask again');
        }
      }
      await p.sendDraft(a.draft_id);
      drafts.delete(key(a.account, a.draft_id));
      return `Envoyé${rec ? ` à ${rec.to}` : ''}.`;
    },
  });

  const calendarList = defineTool({
    name: 'calendar_list',
    description: "Brightky's Google Calendar events for today, tomorrow or the next 7 days.",
    input: { range: z.enum(['today', 'tomorrow', 'week']).default('today') },
    classify: () => ({ level: N0, rule: 'calendar.list', reason: 'read-only' }),
    summarize: (a) => `Read calendar (${a.range})`,
    ingestsExternal: true,
    run: async (a) => {
      if (!d.calendar) return 'No calendar connected (jarvis google connect).';
      const [from, to] = dayRange(a.range);
      const events = await d.calendar.events(from, to, 50);
      return events.length ? events.map(formatEvent).join('\n') : 'Agenda vide sur cette période.';
    },
  });

  const briefing = defineTool({
    name: 'briefing',
    description:
      "Morning briefing in one call: today's calendar, unread mail of the last 24 h (triaged, urgent first), " +
      'accounts in trouble, PRs to review / own PRs (GitHub, GitLab), Trello cards, power/battery. Use it for ' +
      "\"qu'est-ce qui m'attend aujourd'hui ?\".",
    input: {},
    classify: () => ({ level: N0, rule: 'briefing', reason: 'read-only' }),
    summarize: () => 'Morning briefing',
    ingestsExternal: true,
    run: async (_a, ctx) => {
      const [events, mail, status, work] = await Promise.allSettled([
        d.calendar ? d.calendar.events(...dayRange('today'), 30) : Promise.resolve(null),
        d.providers.size
          ? triage([...d.providers.keys()], 24, true, ctx.signal)
          : Promise.resolve(null),
        d.status ? d.status(ctx.signal) : Promise.resolve(null),
        d.work ? d.work() : Promise.resolve(null),
      ]);
      const out: string[] = [];
      if (events.status === 'fulfilled' && events.value) {
        out.push(
          `## Agenda aujourd'hui (${events.value.length})`,
          ...(events.value.length ? events.value.map(formatEvent) : ['rien de prévu']),
        );
      } else if (events.status === 'rejected')
        out.push(`## Agenda : indisponible (${(events.reason as Error).message})`);
      else out.push('## Agenda : non connecté');
      if (mail.status === 'fulfilled' && mail.value) {
        const { digests, problems } = mail.value;
        const urgent = digests.filter((x) => x.urgency === 'high').length;
        out.push(
          `## Mails non lus 24 h : ${digests.length} (${urgent} urgent(s))`,
          ...digests.slice(0, 10).map(formatDigest),
        );
        if (problems.length) out.push(`Comptes indisponibles : ${problems.join(' ; ')}`);
      } else if (mail.status === 'rejected')
        out.push(`## Mails : indisponibles (${(mail.reason as Error).message})`);
      else out.push('## Mails : aucun compte connecté');
      if (work.status === 'fulfilled' && work.value) out.push(work.value);
      else if (work.status === 'rejected')
        out.push(`## Code : indisponible (${(work.reason as Error).message})`);
      if (status.status === 'fulfilled' && status.value) out.push(`## Mac\n${status.value}`);
      return out.join('\n');
    },
  });

  return [
    mailTriage,
    mailRead,
    mailDraft,
    mailSend,
    calendarList,
    briefing,
  ] as unknown as ToolDef[];
}
