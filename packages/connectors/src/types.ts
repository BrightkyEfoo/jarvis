/** Provider-neutral mail and calendar shapes. Every text field here is external content. */

export interface MailHeader {
  id: string;
  account: string;
  threadId?: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  unread: boolean;
  /** RFC 5322 Message-ID, used to thread replies. */
  messageId?: string;
}

export interface MailMessage extends MailHeader {
  text: string;
  references?: string;
}

export interface DraftInput {
  to: string;
  subject: string;
  body: string;
  /** When replying: keeps the thread (In-Reply-To / References / threadId). */
  replyTo?: MailMessage;
}

export interface Draft {
  id: string;
  account: string;
  to: string;
  subject: string;
  body: string;
}

export interface ListOptions {
  unreadOnly: boolean;
  sinceHours: number;
  max: number;
}

export interface MailProvider {
  readonly account: string;
  readonly email: string;
  list(opts: ListOptions): Promise<MailHeader[]>;
  get(id: string): Promise<MailMessage>;
  createDraft(d: DraftInput): Promise<Draft>;
  getDraft(id: string): Promise<Draft>;
  sendDraft(id: string): Promise<{ id: string }>;
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  attendees: number;
  organizer?: string;
  hasVideoLink: boolean;
  description?: string;
}

export interface CalendarProvider {
  events(from: Date, to: Date, max: number): Promise<CalendarEvent[]>;
}

export class ConnectorError extends Error {
  override name = 'ConnectorError';
  /** `auth` means Brightky must reconnect the account; `network` is retryable. */
  readonly kind: 'auth' | 'network' | 'not_found' | 'protocol';

  constructor(kind: ConnectorError['kind'], message: string) {
    super(message);
    this.kind = kind;
  }
}
