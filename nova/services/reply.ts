import { config } from '../config';
import { getNewMessages, imapConfigured, InboundMessage } from '../sources/mailbox';
import { loadProspectRecord, saveProspectRecord } from './prospect';
import { getProspect, updateStage, listProspects } from '../lib/crm';
import { cancelSequence, rescheduleSequence } from './followup';
import { sendMail, emailConfigured } from '../lib/email';
import { completeJSON, llmConfigured } from '../llm';
import { Report, b } from '../lib/report';

/**
 * Inbound reply parser (Feature 5).
 *
 * Polls INBOX via IMAP, keeps only messages whose sender domain matches a tracked
 * prospect, classifies each with the LLM, drafts a suggested response, moves the
 * pipeline, cancels/reschedules the follow-up sequence, and raises an alert
 * (emailing NOVA_NOTIFY_EMAIL when urgency is HIGH). Drafts are never auto-sent.
 */

type Classification = 'INTERESTED' | 'NOT_INTERESTED' | 'MEETING_REQUEST' | 'PRICING_QUESTION' | 'OBJECTION' | 'OUT_OF_OFFICE' | 'REFERRAL';

export interface ReplyAnalysis {
  classification: Classification;
  sentiment: 'positive' | 'neutral' | 'negative';
  urgency: 'HIGH' | 'MEDIUM' | 'LOW';
  keyPoints: string[];
  draftReply: string;
  suggestedNextAction: string;
  rescheduleDate?: string;
}

const CLASSIFY_SYSTEM = `You are a business development manager reading a prospect's reply to a cold outreach email.

Classify this reply and draft the appropriate response.

CLASSIFICATION (choose exactly one):
  INTERESTED — they want to know more, asked a question, or expressed openness
  NOT_INTERESTED — clear no, unsubscribe, or "not right now"
  MEETING_REQUEST — they explicitly want to meet or have asked for a call
  PRICING_QUESTION — they asked about cost/packages
  OBJECTION — they have a specific concern (not a flat no)
  OUT_OF_OFFICE — auto-reply, will return on X date
  REFERRAL — they referred someone else

SENTIMENT: positive / neutral / negative
URGENCY: HIGH (respond today) / MEDIUM (respond within 24h) / LOW (respond within 48h)
KEY POINTS: what specifically did they say (max 3)

DRAFT REPLY: write the ideal response for this classification. Rules:
- Under 100 words unless it is a PRICING_QUESTION
- Match their tone
- If INTERESTED: suggest 2 specific time slots for a discovery call (use placeholders [TIME_SLOT_1] and [TIME_SLOT_2])
- If MEETING_REQUEST: confirm enthusiasm, ask for their availability or suggest slots
- If PRICING_QUESTION: do not quote prices in email — invite them to a call to discuss fit first
- If OBJECTION: acknowledge it directly, reframe with one specific counter, soft CTA to a quick call
- If NOT_INTERESTED: one sentence, gracious, leave the door open in 6 months
- If OUT_OF_OFFICE: no reply needed, reschedule follow-up to their return date

Return ONLY minified JSON: {"classification":string,"sentiment":string,"urgency":string,"keyPoints":string[],"draftReply":string,"suggestedNextAction":string,"rescheduleDate":string?}`;

async function classify(msg: InboundMessage, context: any): Promise<ReplyAnalysis | null> {
  if (!llmConfigured()) return null;
  const payload = {
    from: `${msg.fromName} <${msg.fromEmail}>`,
    subject: msg.subject,
    replyText: msg.text,
    prospect: context,
  };
  try {
    const r = await completeJSON<ReplyAnalysis>(CLASSIFY_SYSTEM, JSON.stringify(payload), { temperature: 0.3, maxTokens: 900 });
    return r;
  } catch {
    return null;
  }
}

const STAGE_FOR: Partial<Record<Classification, Parameters<typeof updateStage>[1]>> = {
  INTERESTED: 'REPLIED',
  MEETING_REQUEST: 'MEETING_BOOKED', // pending confirmation
  NOT_INTERESTED: 'CLOSED_LOST',
};

export interface ProcessedReply {
  domain: string;
  from: string;
  subject: string;
  analysis: ReplyAnalysis | null;
}

/** Poll the inbox, process replies from tracked prospects. Returns what it handled. */
export async function processInbound(): Promise<ProcessedReply[]> {
  if (!imapConfigured()) return [];
  const prospects = await listProspects();
  const domainSet = new Set(prospects.map((p) => p.domain));

  let messages: InboundMessage[] = [];
  try {
    messages = await getNewMessages(config.followup.dayOffsets[2] ?? 14);
  } catch {
    return [];
  }

  const handled: ProcessedReply[] = [];
  for (const msg of messages) {
    // Match sender domain to a tracked prospect (exact, or apex match).
    const domain = [...domainSet].find((d) => msg.fromDomain === d || msg.fromDomain.endsWith('.' + d) || d.endsWith('.' + msg.fromDomain));
    if (!domain) continue; // NOVA only processes prospect replies

    const entry = await getProspect(domain);
    const rec = await loadProspectRecord(domain);
    const analysis = await classify(msg, {
      companyName: entry?.companyName, stage: entry?.stage,
      whatTheyDo: rec?.scrape.whatTheyDo, brief: rec?.brief,
    });

    // Log the reply on the record.
    if (rec) {
      rec.outreach = rec.outreach || [];
      rec.outreach.push({ type: 'reply', receivedAt: new Date().toISOString(), from: msg.fromEmail, subject: msg.subject, analysis });
      await saveProspectRecord(rec);
    }

    if (analysis) {
      // Cancel the sequence on any real reply except a pure auto-responder.
      if (analysis.classification !== 'OUT_OF_OFFICE') await cancelSequence(domain);
      else if (analysis.rescheduleDate) await rescheduleSequence(domain, analysis.rescheduleDate);

      const stage = STAGE_FOR[analysis.classification];
      if (stage) await updateStage(domain, stage, `Reply classified ${analysis.classification}`);

      // HIGH urgency → team alert email.
      if (analysis.urgency === 'HIGH' && config.agency.notifyEmail && emailConfigured()) {
        await sendMail({
          to: config.agency.notifyEmail,
          subject: `NOVA Alert: ${entry?.companyName || domain} replied — action needed today`,
          text: `${entry?.companyName || domain} replied (${analysis.classification}, ${analysis.sentiment}).\n\nKey points:\n- ${analysis.keyPoints.join('\n- ')}\n\nSuggested next action: ${analysis.suggestedNextAction}\n\nDraft reply:\n${analysis.draftReply}`,
        }).catch(() => { /* alert is best-effort */ });
      }
    }

    handled.push({ domain, from: msg.fromEmail, subject: msg.subject, analysis });
  }
  return handled;
}

/** "check replies" / "inbox" — process and render alert cards. */
export async function replyReport(): Promise<Report> {
  if (!imapConfigured()) {
    return { tag: 'Replies', title: 'IMAP not configured', blocks: [b.note('Set IMAP_HOST, IMAP_USER, IMAP_PASS in .env to let NOVA read prospect replies.')] };
  }
  const handled = await processInbound();
  if (!handled.length) {
    return { tag: 'Replies', title: 'No new prospect replies', blocks: [b.p('I checked the inbox — no new replies from tracked prospects.')] };
  }
  const blocks = [b.p(`${handled.length} prospect repl${handled.length === 1 ? 'y' : 'ies'} processed.`)];
  for (const h of handled) {
    const a = h.analysis;
    blocks.push(b.p(`${h.domain} replied — ${a?.classification || 'unclassified'} — ${a?.urgency || '—'} priority`));
    if (a) {
      blocks.push(b.kv([
        { k: 'Sentiment', v: a.sentiment },
        { k: 'Key points', v: a.keyPoints.join(' · ') || '—' },
        { k: 'Next action', v: a.suggestedNextAction },
      ]));
      blocks.push(b.note(a.draftReply));
      blocks.push(b.chips([`Send reply to ${h.domain}`, `Edit reply`, `Book meeting with ${h.domain}`]));
    }
  }
  return { tag: 'Replies', title: 'Inbound replies', blocks, data: { handled } };
}

/* ------------------------- poller ------------------------- */
let timer: any = null;
export function initReplyPoller(): void {
  if (timer || !imapConfigured()) return;
  const everyMs = Math.max(5, config.imap.pollMinutes) * 60_000;
  timer = setInterval(() => { void processInbound(); }, everyMs);
  console.log(`  ▸ IMAP reply poller: ON (every ${config.imap.pollMinutes} min)`);
}
