import crypto from 'node:crypto';
import { dataPath, readJson, writeJson } from './jsonStore';

/**
 * Campaign data layer (bulk outreach). A campaign = a set of imported contacts
 * plus four editable email templates (first / thank-you / follow-up / closing).
 * Sending does simple {{placeholder}} substitution from the contact's REAL data
 * — no LLM invention on the send path.
 */

export type Stage = 'first' | 'thankyou' | 'followup' | 'closing';
export const STAGES: Stage[] = ['first', 'thankyou', 'followup', 'closing'];
export const STAGE_LABEL: Record<Stage, string> = {
  first: 'First email', thankyou: 'Thank-you email', followup: 'Follow-up email', closing: 'Closing email',
};

export type ContactStatus = 'new' | 'first_sent' | 'thankyou_sent' | 'followup_sent' | 'closed' | 'replied' | 'failed';
export const STAGE_STATUS: Record<Stage, ContactStatus> = {
  first: 'first_sent', thankyou: 'thankyou_sent', followup: 'followup_sent', closing: 'closed',
};

export interface Template { subject: string; body: string; }
export interface SendEvent { stage: Stage; sentAt: string; subject: string; ok: boolean; error?: string; }

export interface Contact {
  email: string;
  name: string;
  company: string;
  status: ContactStatus;
  addedAt: string;
  history: SendEvent[];
}

export interface Campaign {
  id: string;
  name: string;
  createdAt: string;
  templates: Record<Stage, Template>;
  contacts: Contact[];
}

interface CampaignsDoc { campaigns: Record<string, Campaign>; }

const FILE = dataPath('campaigns', 'index.json');
async function load(): Promise<CampaignsDoc> { return readJson<CampaignsDoc>(FILE, { campaigns: {} }); }
async function save(doc: CampaignsDoc): Promise<void> { await writeJson(FILE, doc); }

/** Starter templates — editable in the UI. {{placeholders}} are filled from real data. */
export function defaultTemplates(): Record<Stage, Template> {
  return {
    first: {
      subject: 'Quick idea for {{company}}',
      body: 'Hi {{firstName}},\n\nI came across {{company}} and had a specific idea that could help you win more customers online. We work with businesses like yours to turn their website and marketing into a reliable source of leads.\n\nWould you be open to a quick 20-minute call this week to talk it through?\n\nBest,\n{{sender}}\n{{agency}}',
    },
    thankyou: {
      subject: 'Thanks, {{firstName}}',
      body: 'Hi {{firstName}},\n\nThank you for getting back to me — really appreciate it. I’ll put together a couple of concrete next steps for {{company}} and send them over shortly.\n\nTalk soon,\n{{sender}}\n{{agency}}',
    },
    followup: {
      subject: 'Following up — {{company}}',
      body: 'Hi {{firstName}},\n\nJust floating this back to the top of your inbox in case it slipped through. I still think there’s a real opportunity for {{company}} here.\n\nIs a short call worth setting up?\n\nBest,\n{{sender}}\n{{agency}}',
    },
    closing: {
      subject: 'Closing the loop, {{firstName}}',
      body: 'Hi {{firstName}},\n\nI don’t want to keep cluttering your inbox, so I’ll close your file for now. If the timing is ever better for {{company}}, just reply here and I’ll pick it right back up.\n\nAll the best,\n{{sender}}\n{{agency}}',
    },
  };
}

export async function createCampaign(name: string): Promise<Campaign> {
  const doc = await load();
  const id = crypto.randomBytes(5).toString('hex');
  const campaign: Campaign = {
    id, name: name || 'Untitled campaign', createdAt: new Date().toISOString(),
    templates: defaultTemplates(), contacts: [],
  };
  doc.campaigns[id] = campaign;
  await save(doc);
  return campaign;
}

export async function listCampaigns(): Promise<Campaign[]> {
  return Object.values((await load()).campaigns).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export async function getCampaign(id: string): Promise<Campaign | null> {
  return (await load()).campaigns[id] || null;
}
export async function saveCampaign(c: Campaign): Promise<void> {
  const doc = await load();
  doc.campaigns[c.id] = c;
  await save(doc);
}
export async function deleteCampaign(id: string): Promise<boolean> {
  const doc = await load();
  if (!doc.campaigns[id]) return false;
  delete doc.campaigns[id];
  await save(doc);
  return true;
}

/** Parse a CSV / newline list into contacts. Detects email/name/company columns. */
export function parseContacts(content: string): { contacts: Omit<Contact, 'status' | 'addedAt' | 'history'>[]; skipped: number } {
  const emailRe = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
  const lines = content.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  const out: Omit<Contact, 'status' | 'addedAt' | 'history'>[] = [];
  let skipped = 0;

  // Optional header row to locate columns.
  let emailCol = -1, nameCol = -1, companyCol = -1, hasHeader = false;
  if (lines.length) {
    const cells = splitRow(lines[0]);
    const lower = cells.map((c) => c.toLowerCase());
    if (lower.some((c) => /email|e-mail/.test(c)) && !emailRe.test(lines[0])) {
      hasHeader = true;
      emailCol = lower.findIndex((c) => /email|e-mail/.test(c));
      nameCol = lower.findIndex((c) => /name|contact/.test(c) && !/company|user\s*name/.test(c));
      companyCol = lower.findIndex((c) => /company|organi[sz]ation|business/.test(c));
    }
  }

  const seen = new Set<string>();
  for (let i = hasHeader ? 1 : 0; i < lines.length; i++) {
    const cells = splitRow(lines[i]);
    let email = '', name = '', company = '';
    if (hasHeader && emailCol >= 0) {
      email = (cells[emailCol] || '').match(emailRe)?.[0] || '';
      name = nameCol >= 0 ? (cells[nameCol] || '') : '';
      company = companyCol >= 0 ? (cells[companyCol] || '') : '';
    } else {
      // No header: find the email token anywhere; take a non-email cell as name.
      const emailCell = cells.find((c) => emailRe.test(c));
      email = emailCell?.match(emailRe)?.[0] || '';
      const others = cells.filter((c) => c && !emailRe.test(c));
      name = others[0] || '';
      company = others[1] || '';
    }
    email = email.toLowerCase().trim();
    if (!email || !emailRe.test(email)) { skipped++; continue; }
    if (seen.has(email)) { skipped++; continue; }
    seen.add(email);
    // Fall back to the email's local part / domain when name/company are absent.
    if (!company) company = email.split('@')[1]?.split('.')[0] || '';
    out.push({ email, name: name.trim(), company: company.trim() });
  }
  return { contacts: out, skipped };
}

function splitRow(line: string): string[] {
  // Split on comma / semicolon / tab, respecting simple double-quoted cells.
  const cells: string[] = [];
  let cur = '', q = false;
  for (const ch of line) {
    if (ch === '"') { q = !q; continue; }
    if (!q && (ch === ',' || ch === ';' || ch === '\t')) { cells.push(cur); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

/** Fill {{placeholders}} from a contact + agency identity. Real data only. */
export function fillTemplate(tpl: string, contact: Contact, agency: { name: string; sender: string; role: string }): string {
  const firstName = (contact.name || '').split(/\s+/)[0] || 'there';
  const map: Record<string, string> = {
    name: contact.name || 'there',
    firstName,
    company: contact.company || 'your company',
    email: contact.email,
    agency: agency.name,
    sender: agency.sender,
    senderRole: agency.role,
  };
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => (map[k] != null ? map[k] : `{{${k}}}`));
}

export const CONTACT_STATUS_LABEL: Record<ContactStatus, string> = {
  new: 'New', first_sent: 'First sent', thankyou_sent: 'Thanked', followup_sent: 'Followed up',
  closed: 'Closed', replied: 'Replied', failed: 'Failed',
};
