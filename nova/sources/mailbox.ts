import { config } from '../config';
import { dataPath, readJson, writeJson } from '../lib/jsonStore';

/**
 * Inbound mailbox reader (Feature 5, IMAP).
 *
 * imap-simple is imported LAZILY so the server boots even before `npm install`.
 * The poller reads recent INBOX messages, skips ones it has already processed
 * (tracked by UID in a local store — NON-destructive, it does not mark your real
 * inbox as read), and returns parsed messages for services/reply.ts to classify.
 */

export interface InboundMessage {
  uid: number;
  fromEmail: string;
  fromDomain: string;
  fromName: string;
  subject: string;
  date: string;
  text: string;
}

export function imapConfigured(): boolean {
  return !!config.imap.host && !!config.imap.user && !!config.imap.pass;
}

const SEEN_FILE = dataPath('mailbox-seen.json');
async function loadSeen(): Promise<number[]> {
  return readJson<number[]>(SEEN_FILE, []);
}
async function markSeen(uids: number[]): Promise<void> {
  const seen = await loadSeen();
  const merged = [...new Set([...seen, ...uids])].slice(-2000); // cap growth
  await writeJson(SEEN_FILE, merged);
}

/** Fetch recent, not-yet-processed INBOX messages. */
export async function getNewMessages(sinceDays = 3): Promise<InboundMessage[]> {
  if (!imapConfigured()) throw new Error('IMAP not configured — set IMAP_HOST, IMAP_USER, IMAP_PASS.');

  const pkg = 'imap-simple';
  const mod: any = await import(pkg).catch(() => {
    throw new Error('imap-simple is not installed — run `npm install` to enable reply parsing.');
  });
  const imaps = mod.default || mod;

  const connection = await imaps.connect({
    imap: {
      user: config.imap.user,
      password: config.imap.pass,
      host: config.imap.host,
      port: config.imap.port,
      tls: config.imap.tls,
      authTimeout: 15000,
      tlsOptions: { servername: config.imap.host },
    },
  });

  try {
    await connection.openBox('INBOX');
    const since = new Date(Date.now() - sinceDays * 86_400_000);
    const criteria = [['SINCE', since]];
    const fetchOptions = { bodies: ['HEADER.FIELDS (FROM SUBJECT DATE)', 'TEXT'], markSeen: false, struct: true };
    const results = await connection.search(criteria, fetchOptions);

    const already = new Set(await loadSeen());
    const messages: InboundMessage[] = [];
    const newlySeen: number[] = [];

    for (const item of results) {
      const uid = item.attributes?.uid;
      if (uid == null || already.has(uid)) continue;
      newlySeen.push(uid);

      const headerPart = item.parts.find((p: any) => p.which && p.which.startsWith('HEADER'));
      const textPart = item.parts.find((p: any) => p.which === 'TEXT');
      const header = headerPart?.body || {};
      const fromRaw = (header.from && header.from[0]) || '';
      const subject = (header.subject && header.subject[0]) || '(no subject)';
      const date = (header.date && header.date[0]) || new Date().toISOString();

      const { name, email } = parseFrom(fromRaw);
      const fromDomain = email.split('@')[1]?.toLowerCase() || '';
      const text = stripQuotedReply(String(textPart?.body || '')).slice(0, 8000);

      messages.push({ uid, fromEmail: email, fromDomain, fromName: name, subject, date, text });
    }

    if (newlySeen.length) await markSeen(newlySeen);
    return messages;
  } finally {
    try { connection.end(); } catch { /* ignore */ }
  }
}

function parseFrom(raw: string): { name: string; email: string } {
  const m = raw.match(/"?([^"<]*)"?\s*<([^>]+)>/) || raw.match(/([^\s<]+@[^\s>]+)/);
  if (!m) return { name: raw.trim(), email: '' };
  if (m.length === 3) return { name: (m[1] || '').trim(), email: (m[2] || '').trim().toLowerCase() };
  return { name: '', email: (m[1] || '').trim().toLowerCase() };
}

/** Drop the quoted portion of a reply so the LLM classifies only the new text. */
function stripQuotedReply(body: string): string {
  const lines = body.replace(/\r/g, '').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) break;
    if (/^\s*On .+ wrote:\s*$/.test(line)) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line)) break;
    out.push(line);
  }
  return out.join('\n').trim() || body.trim();
}
