import { config } from '../config';
import {
  createCampaign, listCampaigns, getCampaign, saveCampaign, deleteCampaign,
  parseContacts, fillTemplate, defaultTemplates,
  Campaign, Contact, Stage, STAGES, STAGE_STATUS, STAGE_LABEL, Template, ContactStatus,
} from '../lib/campaign';
import { sendMail, emailConfigured } from '../lib/email';
import { complete, llmConfigured } from '../llm';
import { pool } from '../lib/concurrency';
import { Report, b } from '../lib/report';

/**
 * Campaign / bulk-outreach service. Import a list of emails, configure the four
 * templates, and bulk-send a chosen stage to eligible contacts. Every send is a
 * placeholder fill of the user's own template — the LLM never invents send copy
 * (it can only *draft a template* on request, which the user then edits/approves).
 */

export { createCampaign, listCampaigns, getCampaign, deleteCampaign };

function agencyIdentity() {
  return { name: config.agency.name, sender: config.agency.senderName, role: config.agency.senderRole };
}

/** Import contacts from an uploaded file's text content. */
export async function importContacts(campaignId: string, content: string): Promise<{ ok: boolean; added?: number; skipped?: number; total?: number; error?: string }> {
  const campaign = await getCampaign(campaignId);
  if (!campaign) return { ok: false, error: 'Campaign not found.' };
  const { contacts, skipped } = parseContacts(content || '');
  if (!contacts.length) return { ok: false, error: 'No valid email addresses found in that file.' };

  const existing = new Set(campaign.contacts.map((c) => c.email));
  let added = 0;
  for (const c of contacts) {
    if (existing.has(c.email)) continue;
    existing.add(c.email);
    campaign.contacts.push({ ...c, status: 'new', addedAt: new Date().toISOString(), history: [] });
    added++;
  }
  await saveCampaign(campaign);
  return { ok: true, added, skipped: skipped + (contacts.length - added), total: campaign.contacts.length };
}

export async function updateTemplates(campaignId: string, templates: Partial<Record<Stage, Template>>): Promise<{ ok: boolean; error?: string }> {
  const campaign = await getCampaign(campaignId);
  if (!campaign) return { ok: false, error: 'Campaign not found.' };
  for (const s of STAGES) {
    if (templates[s]) {
      campaign.templates[s] = {
        subject: String(templates[s]!.subject ?? campaign.templates[s].subject),
        body: String(templates[s]!.body ?? campaign.templates[s].body),
      };
    }
  }
  await saveCampaign(campaign);
  return { ok: true };
}

/** Is a contact eligible for a given stage (hasn't successfully received it yet)? */
function eligible(contact: Contact, stage: Stage): boolean {
  if (contact.status === 'closed' && stage !== 'closing') return false;
  return !contact.history.some((h) => h.stage === stage && h.ok);
}

export interface BulkResult {
  ok: boolean;
  error?: string;
  stage?: Stage;
  attempted?: number;
  sent?: number;
  failed?: number;
  skipped?: number;
  results?: { email: string; ok: boolean; error?: string }[];
}

/** Bulk-send one stage to eligible contacts (or an explicit subset). */
export async function bulkSend(campaignId: string, stage: Stage, opts: { onlyEligible?: boolean; emails?: string[] } = {}): Promise<BulkResult> {
  const campaign = await getCampaign(campaignId);
  if (!campaign) return { ok: false, error: 'Campaign not found.' };
  if (!emailConfigured()) return { ok: false, error: 'SMTP not configured — set SMTP_HOST, SMTP_USER, SMTP_PASS to send.' };
  if (!STAGES.includes(stage)) return { ok: false, error: `Unknown stage "${stage}".` };

  const tpl = campaign.templates[stage];
  const agency = agencyIdentity();

  const subset = opts.emails && opts.emails.length ? new Set(opts.emails.map((e) => e.toLowerCase())) : null;
  const onlyEligible = opts.onlyEligible !== false;
  const targets = campaign.contacts.filter((c) => {
    if (subset && !subset.has(c.email)) return false;
    if (onlyEligible && !eligible(c, stage)) return false;
    return true;
  });

  const skipped = campaign.contacts.length - targets.length;
  if (!targets.length) return { ok: true, stage, attempted: 0, sent: 0, failed: 0, skipped, results: [] };

  const results = await pool(targets, 4, async (c) => {
    const subject = fillTemplate(tpl.subject, c, agency);
    const body = fillTemplate(tpl.body, c, agency);
    try {
      await sendMail({ to: c.email, subject, text: body });
      c.history.push({ stage, sentAt: new Date().toISOString(), subject, ok: true });
      if (c.status !== 'replied') c.status = STAGE_STATUS[stage];
      return { email: c.email, ok: true };
    } catch (e: any) {
      const error = String(e?.message || e);
      c.history.push({ stage, sentAt: new Date().toISOString(), subject, ok: false, error });
      c.status = 'failed';
      return { email: c.email, ok: false, error };
    }
  });

  await saveCampaign(campaign);
  const sent = results.filter((r) => r.ok).length;
  return { ok: true, stage, attempted: targets.length, sent, failed: targets.length - sent, skipped, results };
}

export async function setContactStatus(campaignId: string, email: string, status: ContactStatus): Promise<{ ok: boolean; error?: string }> {
  const campaign = await getCampaign(campaignId);
  if (!campaign) return { ok: false, error: 'Campaign not found.' };
  const c = campaign.contacts.find((x) => x.email === email.toLowerCase());
  if (!c) return { ok: false, error: 'Contact not found.' };
  c.status = status;
  await saveCampaign(campaign);
  return { ok: true };
}

export async function removeContact(campaignId: string, email: string): Promise<{ ok: boolean }> {
  const campaign = await getCampaign(campaignId);
  if (!campaign) return { ok: false };
  campaign.contacts = campaign.contacts.filter((c) => c.email !== email.toLowerCase());
  await saveCampaign(campaign);
  return { ok: true };
}

/** Optional: let the LLM DRAFT a template (user still edits/approves before sending). */
export async function draftTemplate(stage: Stage, context: { audience?: string; tone?: string }): Promise<{ ok: boolean; template?: Template; error?: string }> {
  if (!llmConfigured()) return { ok: false, error: 'Add an LLM key to draft templates.' };
  const guide: Record<Stage, string> = {
    first: 'a first cold outreach email — short, leads with the prospect’s problem, one clear CTA for a 20-minute call',
    thankyou: 'a warm thank-you email after a prospect replied — brief, appreciative, sets up next steps',
    followup: 'a follow-up email to a non-reply — different angle, under 90 words, one question',
    closing: 'a break-up / closing email — gracious, leaves the door open, under 70 words',
  };
  const system = `You are a senior business-development writer. Draft ${guide[stage]} for a mass campaign. Use these EXACT placeholders where personalisation belongs: {{firstName}}, {{company}}, {{agency}}, {{sender}}. Do not invent statistics or specific facts about the recipient (this goes to many companies). No "AI"/"automation" mentions, no "I hope this email finds you". Audience: ${context.audience || 'small businesses'}. Tone: ${context.tone || 'direct and human'}.

Return the email as PLAIN TEXT in exactly this format and nothing else:
Subject: <the subject line>
<blank line>
<the email body over multiple lines>`;
  try {
    const raw = await complete(system, 'Draft the template.', { temperature: 0.6, maxTokens: 500 });
    const text = raw.trim().replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/i, '').trim();
    const m = text.match(/^\s*subject\s*:\s*(.+?)\s*\n([\s\S]*)$/i);
    let subject: string, body: string;
    if (m) {
      subject = m[1].trim();
      body = m[2].trim();
    } else {
      // No "Subject:" prefix — treat the first line as the subject.
      const lines = text.split('\n');
      subject = (lines.shift() || '').replace(/^subject\s*:\s*/i, '').trim();
      body = lines.join('\n').trim();
    }
    if (!subject && !body) return { ok: false, error: 'The model returned empty copy — try again.' };
    return { ok: true, template: { subject, body } };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/* ------------------------- chat surface ------------------------- */

export async function campaignsReport(): Promise<Report> {
  const campaigns = await listCampaigns();
  if (!campaigns.length) {
    return { tag: 'Campaigns', title: 'No campaigns yet', blocks: [b.p('Open the Campaigns tab to create one, upload a list of emails, set your four templates, and bulk-send.')] };
  }
  const blocks = [b.p(`You have ${campaigns.length} campaign${campaigns.length === 1 ? '' : 's'}. Manage them in the Campaigns tab.`)];
  blocks.push(b.table(
    ['Campaign', 'Contacts', 'New', 'Sent', 'Replied', 'Closed'],
    campaigns.map((c) => {
      const s = summarize(c);
      return [c.name, c.contacts.length, s.new, s.sentAny, s.replied, s.closed];
    }),
  ));
  return { tag: 'Campaigns', title: 'Campaign overview', blocks, data: { campaigns: campaigns.map((c) => c.id) } };
}

function summarize(c: Campaign) {
  const s = { new: 0, sentAny: 0, replied: 0, closed: 0 };
  for (const ct of c.contacts) {
    if (ct.status === 'new') s.new++;
    if (ct.history.some((h) => h.ok)) s.sentAny++;
    if (ct.status === 'replied') s.replied++;
    if (ct.status === 'closed') s.closed++;
  }
  return s;
}

export async function campaignsStatus() {
  const campaigns = await listCampaigns();
  const contacts = campaigns.reduce((n, c) => n + c.contacts.length, 0);
  return { campaigns: campaigns.length, contacts };
}
