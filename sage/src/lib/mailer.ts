import { config } from '../config';

/**
 * Shared SMTP transport for the execution-layer features (Scheduled Reports +
 * Ranking Alerts). nodemailer is imported LAZILY so the server still boots if the
 * dependency has not been `npm install`-ed yet — the email features simply report
 * that they are unconfigured instead of crashing startup.
 */

export function mailerConfigured(): boolean {
  return !!config.smtp.host && !!config.smtp.user && !!config.smtp.pass;
}

let _transport: any = null;

async function transport(): Promise<any> {
  if (_transport) return _transport;
  // Dynamic import with a non-literal specifier: keeps `nodemailer` out of the
  // startup path AND out of compile-time module resolution (installed at runtime).
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

export interface MailInput {
  to: string | string[];
  from?: string;
  subject: string;
  html: string;
  text?: string;
}

/** Send one email. Throws if SMTP is not configured or the send fails. */
export async function sendMail(input: MailInput): Promise<{ messageId: string; accepted: string[] }> {
  if (!mailerConfigured()) throw new Error('SMTP not configured — set SMTP_HOST, SMTP_USER, SMTP_PASS in .env.');
  const from = input.from || config.smtp.user;
  const t = await transport();
  const info = await t.sendMail({
    from,
    to: Array.isArray(input.to) ? input.to.join(', ') : input.to,
    subject: input.subject,
    html: input.html,
    text: input.text,
  });
  return { messageId: info.messageId, accepted: (info.accepted || []).map(String) };
}
