import { config } from '../config';
import { dataPath, readJson, writeJson } from './jsonStore';

/**
 * Outbound email wrapper (nodemailer). Same lazy-import pattern as SAGE's
 * mailer.ts so the server boots even before `npm install` — the email features
 * simply report "not configured" instead of crashing.
 *
 * Inbound email (reading prospect replies) lives in sources/mailbox.ts (IMAP).
 */

export function emailConfigured(): boolean {
  return !!config.smtp.host && !!config.smtp.user && !!config.smtp.pass;
}

/* ----------------------- Cold-send safety guardrails ---------------------- */
/**
 * Extra operator-level guardrails for COLD outreach + follow-ups only (not
 * transactional mail like meeting invites). A hard kill-switch plus a per-day cap
 * so a warming or paused domain can't blast volume and wreck its reputation. These
 * layer ON TOP of the existing rule that every send needs explicit human approval.
 */
const capFile = () => dataPath('sending', 'daily.json');
const today = () => new Date().toISOString().slice(0, 10);

export async function coldSendCountToday(): Promise<number> {
  const doc = await readJson<{ date: string; count: number }>(capFile(), { date: today(), count: 0 });
  return doc.date === today() ? doc.count : 0;
}

/** Throw a user-safe error if cold sending is disabled or today's cap is reached. */
export async function assertColdSendAllowed(): Promise<void> {
  if (!config.sending.enabled) {
    throw new Error('Outbound sending is turned OFF (NOVA_SENDING_ENABLED=false). Nothing was sent.');
  }
  if ((await coldSendCountToday()) >= config.sending.dailyCap) {
    throw new Error(`Daily send cap reached (${config.sending.dailyCap} today). Nothing was sent — this protects your domain reputation. Raise NOVA_DAILY_SEND_CAP if this is intentional.`);
  }
}

/** Record one successful cold send against today's cap. */
export async function recordColdSend(): Promise<void> {
  const doc = await readJson<{ date: string; count: number }>(capFile(), { date: today(), count: 0 });
  const cur = doc.date === today() ? doc.count : 0;
  await writeJson(capFile(), { date: today(), count: cur + 1 });
}

let _transport: any = null;

async function transport(): Promise<any> {
  if (_transport) return _transport;
  const pkg = 'nodemailer';
  const mod: any = await import(pkg).catch(() => {
    throw new Error('nodemailer is not installed — run `npm install` to enable email features.');
  });
  const nodemailer = mod.default || mod;
  _transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465, // 465 = implicit TLS; 587/25 = STARTTLS
    auth: { user: config.smtp.user, pass: config.smtp.pass },
  });
  return _transport;
}

/** The "From" header NOVA sends as. */
export function defaultFrom(): string {
  const email = config.smtp.fromEmail || config.smtp.user;
  const name = config.smtp.fromName;
  return name ? `"${name}" <${email}>` : email;
}

export interface MailInput {
  to: string | string[];
  from?: string;
  subject: string;
  text?: string;
  html?: string;
  icsAttachment?: { filename: string; content: string };
}

/** Send one email. Throws if SMTP is not configured or the send fails. */
export async function sendMail(input: MailInput): Promise<{ messageId: string; accepted: string[]; from: string }> {
  if (!emailConfigured()) throw new Error('SMTP not configured — set SMTP_HOST, SMTP_USER, SMTP_PASS in .env.');
  const from = input.from || defaultFrom();
  const t = await transport();
  const message: any = {
    from,
    to: Array.isArray(input.to) ? input.to.join(', ') : input.to,
    subject: input.subject,
    text: input.text,
    html: input.html || (input.text ? `<pre style="font:14px/1.5 -apple-system,system-ui,sans-serif;white-space:pre-wrap">${escapeHtml(input.text)}</pre>` : undefined),
  };
  if (input.icsAttachment) {
    message.attachments = [{
      filename: input.icsAttachment.filename,
      content: input.icsAttachment.content,
      contentType: 'text/calendar; method=REQUEST',
    }];
  }
  const info = await t.sendMail(message);
  return { messageId: info.messageId, accepted: (info.accepted || []).map(String), from };
}

/** Minimal ICS (iCalendar) VEVENT builder for meeting invites. */
export function buildIcs(opts: {
  uid: string;
  start: Date;
  durationMins: number;
  title: string;
  description?: string;
  location?: string;
  organizerEmail?: string;
  attendeeEmail?: string;
}): string {
  const dt = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const end = new Date(opts.start.getTime() + opts.durationMins * 60_000);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//NOVA//Business Development//EN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${opts.uid}`,
    `DTSTAMP:${dt(new Date())}`,
    `DTSTART:${dt(opts.start)}`,
    `DTEND:${dt(end)}`,
    `SUMMARY:${icsEscape(opts.title)}`,
    opts.description ? `DESCRIPTION:${icsEscape(opts.description)}` : '',
    opts.location ? `LOCATION:${icsEscape(opts.location)}` : '',
    opts.organizerEmail ? `ORGANIZER:mailto:${opts.organizerEmail}` : '',
    opts.attendeeEmail ? `ATTENDEE;RSVP=TRUE:mailto:${opts.attendeeEmail}` : '',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);
  return lines.join('\r\n');
}

function icsEscape(s: string): string {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}
function escapeHtml(s: string): string {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
}
