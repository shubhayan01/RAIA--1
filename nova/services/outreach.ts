import { loadProspectRecord, saveProspectRecord } from './prospect';
import { completeJSON, llmConfigured } from '../llm';
import { sendMail, emailConfigured, assertColdSendAllowed, recordColdSend } from '../lib/email';
import { recordContact, getProspect } from '../lib/crm';
import { scheduleSequence } from './followup';
import { config } from '../config';
import { Report, b } from '../lib/report';

/**
 * Outreach email generation + send (Feature 2).
 *
 * The LLM WRITES the cold-email copy (that is a legitimate writing task), working
 * only from the real research object. It never fabricates the data points it
 * cites — those come straight from the prospect record. Nothing is ever sent
 * without an explicit user confirmation (a send API call).
 */

export interface OutreachVariant {
  subject: string;
  body: string;
  hook: string;
  strengthScore: number;
  strengthReason: string;
}

const GEN_SYSTEM = `You are a senior business development writer at a digital marketing agency. Write 3 cold outreach email variants for this prospect. Each variant uses a different hook angle but all are:
- Under 150 words (cold emails must be short)
- Personalised to the specific prospect — no generic lines that could apply to anyone
- Leading with their problem, not our services
- One specific data point from the research (SEO score, social inactivity, a specific issue)
- One clear CTA: a 20-minute discovery call
- No subject line fluff — direct and specific
- Written like a human, not a marketing department

Variant 1: SEO/website problem hook
Variant 2: Competitor angle (their competitors are doing X, they are not)
Variant 3: Quick win hook (we found one specific fix that would immediately improve their results)

For each variant return: subject (under 50 chars, no clickbait), body (plain text, under 150 words), hook (one line — what angle this uses), strengthScore (1-10), strengthReason (one line).

Rules:
- Never mention "AI" or "automation" in the email
- Never use phrases like "I hope this email finds you"
- Never use bullet points in the email body
- The prospect's name or company must appear in the first sentence
- Every email must be different in angle, not just tone

GROUNDING (critical — these emails go to real prospects):
- Only cite data that is actually present in the research payload. Never invent a
  statistic, percentage, score, or specific issue.
- Do NOT claim a specific SEO problem (e.g. "missing meta description", "slow
  load time", "no title tags") unless it appears in seoIssues or the audit shows
  it. If seoIssues is empty and lighthouse scores are null, DO NOT fabricate an
  SEO problem or a made-up percentage — instead build the hook from something
  real that IS in the payload (their services, tech stack, market, brief pitch
  angle, or social presence), framed as a question or observation.
- Never state a made-up number like "boosts clicks by 15%". Quantified claims are
  only allowed when the number is in the payload.
- Never reference internal data-structure or field names in the email (e.g.
  "socialSignals array", "seoIssues", "payload", "the data shows"). Translate
  everything into natural business language a founder would actually read.
- NEVER build a hook on something we could not access or measure. A blocked page, a
  301/403/429, a "not found", an unknown/empty follower count or any missing signal
  is OUR data gap, not the prospect's problem. Do not imply a prospect is weak,
  invisible, or inactive because we failed to read their data. If a signal is
  missing or inaccessible, ignore it completely and build the hook from a signal we
  DID measure. When the payload has no strong measured weakness, lead with a
  value/observation hook about their business or market instead of inventing a flaw.

Return ONLY minified JSON: {"variants":[{"subject":string,"body":string,"hook":string,"strengthScore":number,"strengthReason":string}]}`;

/**
 * Remove sentences that describe OUR data-collection gaps (a blocked page, a
 * 3xx/4xx status, a missing/empty field, an unknown follower count) from any free
 * text before it reaches the writer. The prompt already forbids using these as
 * hooks, but a smaller model doesn't always obey — stripping them at the source is
 * what actually guarantees a failed scrape never becomes an outreach angle.
 */
const GAP_RE = /block|invisible|\b(301|302|403|404|429|5\d\d)\b|couldn'?t (?:access|read|fetch|find)|not (?:found|accessible|listed|available)|no (?:email|contact|listing)|empty|unknown|follower count|no followers|array\b/i;
function scrubDataGaps<T>(value: T): T {
  if (typeof value === 'string') {
    const kept = value
      .split(/(?<=[.!?;])\s+|\n+/)
      .filter((sent) => !GAP_RE.test(sent));
    return (kept.join(' ').trim()) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => scrubDataGaps(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubDataGaps(v);
    return out;
  }
  return value;
}

export async function generateOutreach(domainRaw: string): Promise<Report> {
  const rec = await loadProspectRecord(domainRaw);
  if (!rec) {
    return {
      tag: 'Outreach', title: 'Research first',
      blocks: [b.note(`I have no research on ${domainRaw} yet. Say "research ${domainRaw}" and I'll build the intelligence brief, then draft the outreach.`)],
    };
  }
  if (!llmConfigured()) {
    return { tag: 'Outreach', title: 'LLM required', blocks: [b.note('Add an LLM key in .env — outreach copy is written by the model over the real research.')] };
  }

  const payload = {
    domain: rec.domain,
    companyName: rec.scrape.companyName,
    // Free text that can carry our own data-collection gaps → scrub before the model
    // sees it, so a failed scrape can never become an outreach hook.
    whatTheyDo: scrubDataGaps(rec.scrape.whatTheyDo),
    services: rec.scrape.services,
    techStack: rec.scrape.techStack,
    brief: scrubDataGaps(rec.brief),
    seoIssues: rec.audit.topIssues,
    lighthouse: rec.audit.lighthouse,
    coreWebVitals: rec.audit.coreWebVitals,
    // Only hand the writer social signals we actually MEASURED. Entries we couldn't
    // read (blocked page, 3xx/4xx, "not found", unknown follower count) are our data
    // gaps, not the prospect's problem — passing them lets the model turn a failed
    // scrape into an embarrassing "your presence is invisible" hook. Drop them.
    social: rec.social
      .filter((s) => s.followers != null && !/block|error|unavail|not[ -]?found|denied|forbidden|\b(301|302|403|404|429|5\d\d)\b/i.test(String(s.status || '')))
      .map((s) => ({ platform: s.platform, followers: s.followers, status: s.status })),
    contactName: (await getProspect(rec.domain))?.contactName || '',
    agencyName: config.agency.name,
    senderName: config.agency.senderName,
    senderRole: config.agency.senderRole,
  };

  let variants: OutreachVariant[] = [];
  try {
    const r = await completeJSON<{ variants: OutreachVariant[] }>(GEN_SYSTEM, JSON.stringify(payload), { temperature: 0.6, maxTokens: 2000 });
    variants = (r.variants || []).slice(0, 3);
  } catch (e: any) {
    return { tag: 'Outreach', title: 'Draft failed', blocks: [b.note(`Could not generate outreach: ${e?.message || e}`)] };
  }

  // Persist the drafts on the record so the send call can retrieve the exact copy.
  rec.meta = { ...(rec.meta || {}), outreachDrafts: variants, outreachDraftedAt: new Date().toISOString() };
  await saveProspectRecord(rec);

  const blocks = [];
  blocks.push(b.p(`Three outreach variants for ${rec.scrape.companyName || rec.domain}. Each leads with a real, measured hook — edit any before sending. Nothing sends until you confirm.`));
  variants.forEach((v, i) => {
    blocks.push(b.p(`Variant ${i + 1} — ${v.hook} · strength ${v.strengthScore}/10 (${v.strengthReason})`));
    blocks.push(b.kv([{ k: 'Subject', v: v.subject }]));
    blocks.push(b.note(v.body));
  });

  const to = rec.emailHint || rec.scrape.contacts.emails[0] || '';
  blocks.push(b.kv([{ k: 'Send to', v: to || 'no email found — add one before sending' }]));
  blocks.push(b.chips(emailConfigured()
    ? ['Send Variant 1', 'Send Variant 2', 'Send Variant 3']
    : ['SMTP not configured — set SMTP_* to enable sending']));

  return {
    tag: 'Outreach',
    title: `Outreach drafts — ${rec.scrape.companyName || rec.domain}`,
    blocks,
    data: { domain: rec.domain, to, variants },
  };
}

/**
 * Send one selected variant. Explicit confirmation required (this is only called
 * from a user action). Logs the send, moves the prospect to CONTACTED, and arms
 * the follow-up sequence.
 */
export async function sendOutreach(input: { domain: string; variantIndex?: number; variant?: OutreachVariant; toEmail?: string }): Promise<{ ok: boolean; error?: string; to?: string; subject?: string }> {
  const rec = await loadProspectRecord(input.domain);
  if (!rec) return { ok: false, error: 'No research on that prospect.' };
  if (!emailConfigured()) return { ok: false, error: 'SMTP not configured — set SMTP_HOST, SMTP_USER, SMTP_PASS.' };

  const drafts: OutreachVariant[] = (rec.meta?.outreachDrafts as OutreachVariant[]) || [];
  const variant = input.variant || drafts[input.variantIndex ?? 0];
  if (!variant) return { ok: false, error: 'No draft to send — generate outreach first.' };

  const to = input.toEmail || rec.emailHint || rec.scrape.contacts.emails[0] || '';
  if (!to) return { ok: false, error: 'No recipient email — none was found on the site. Add one and retry.' };

  try {
    await assertColdSendAllowed(); // kill-switch + daily cap
    const sent = await sendMail({ to, subject: variant.subject, text: variant.body });
    await recordColdSend();
    // Log to the prospect record.
    rec.outreach = rec.outreach || [];
    rec.outreach.push({
      type: 'outreach', sentAt: new Date().toISOString(), subject: variant.subject,
      hook: variant.hook, to, from: sent.from, messageId: sent.messageId,
    });
    await saveProspectRecord(rec);

    // Pipeline: RESEARCHED -> CONTACTED, bump counters.
    await recordContact(rec.domain, { moveToContacted: true });

    // Arm the follow-up sequence (day 3 / 7 / 14).
    await scheduleSequence(rec.domain);

    return { ok: true, to, subject: variant.subject };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}
