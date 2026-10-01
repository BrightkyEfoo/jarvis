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
