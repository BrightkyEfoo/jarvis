import type { CalendarEvent, CalendarProvider } from '../types.ts';
import type { GoogleAuth } from './oauth.ts';

const API = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

interface GEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: unknown[];
  organizer?: { email?: string; displayName?: string };
  hangoutLink?: string;
  conferenceData?: unknown;
}

/** Several Google calendars (one per connected account) read as one, sorted by start. */
export class MergedCalendar implements CalendarProvider {
  readonly #parts: CalendarProvider[];

  constructor(parts: CalendarProvider[]) {
    this.#parts = parts;
  }

  async events(from: Date, to: Date, max: number): Promise<CalendarEvent[]> {
    const all = await Promise.allSettled(this.#parts.map((p) => p.events(from, to, max)));
    const ok = all.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    if (ok.length === 0 && all.every((r) => r.status === 'rejected')) {
      throw (all[0] as PromiseRejectedResult).reason;
    }
    const seen = new Set<string>();
    return ok
      .filter((e) => {
        // The same meeting shared between two of Brightky's accounts appears once.
        const key = `${e.title}|${e.start}`;
        return !seen.has(key) && seen.add(key) !== undefined;
      })
      .sort((a, b) => a.start.localeCompare(b.start))
      .slice(0, max);
  }
}

export class GoogleCalendar implements CalendarProvider {
  readonly #auth: GoogleAuth;

  constructor(auth: GoogleAuth) {
    this.#auth = auth;
  }

  async events(from: Date, to: Date, max: number): Promise<CalendarEvent[]> {
    const params = new URLSearchParams({
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: String(max),
    });
    const res = await this.#auth.api<{ items?: GEvent[] }>(`${API}?${params}`);
    return (res.items ?? [])
      .filter((e) => e.status !== 'cancelled')
      .map((e) => {
        const ev: CalendarEvent = {
          id: e.id,
          title: e.summary ?? '(sans titre)',
          start: e.start?.dateTime ?? e.start?.date ?? '',
          end: e.end?.dateTime ?? e.end?.date ?? '',
          allDay: !e.start?.dateTime,
          attendees: e.attendees?.length ?? 0,
          hasVideoLink: Boolean(e.hangoutLink || e.conferenceData),
        };
        if (e.location) ev.location = e.location;
        const org = e.organizer?.displayName ?? e.organizer?.email;
        if (org) ev.organizer = org;
        if (e.description) ev.description = e.description.slice(0, 500);
        return ev;
      });
  }
}
