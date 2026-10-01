import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { DraftInput } from './types.ts';

const reSubject = (s: string) => (/^(re|tr|fwd?)\s*:/i.test(s) ? s : `Re: ${s}`);

/** RFC 5322 message for a draft; replies keep their thread through In-Reply-To/References. */
export async function buildMessage(from: string, d: DraftInput): Promise<Buffer> {
  const reply = d.replyTo;
  const composer = new MailComposer({
    from,
    to: d.to,
    subject: reply && d.subject === reply.subject ? reSubject(d.subject) : d.subject,
    text: d.body,
    ...(reply?.messageId
      ? {
          inReplyTo: reply.messageId,
          references: [reply.references, reply.messageId].filter(Boolean).join(' '),
        }
      : {}),
  });
  return composer.compile().build();
}

export const base64url = (buf: Buffer): string => buf.toString('base64url');

/** Plain text from HTML when a mail has no text part: enough to summarise, never rendered. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}
