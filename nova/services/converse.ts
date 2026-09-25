import { complete, completeJSON, llmConfigured, llmInfo } from '../llm';
import { config } from '../config';
import { emailConfigured } from '../lib/email';
import { imapConfigured } from '../sources/mailbox';
import { calendarConfigured } from '../lib/calendar';
import { Report, b } from '../lib/report';

/**
 * Conversation + command routing (same pattern as SAGE's converse.ts).
 *
 * This is the ONLY place the LLM is allowed to "talk". Its jobs: reply to normal
 * conversation, and decide which REAL NOVA tool a request maps to. It must never
 * fabricate prospect data — every fact comes from the real services (scrape,
 * Lighthouse, IMAP, the JSON stores).
 */

export type ToolMode =
  | 'research' | 'outreach' | 'pipeline' | 'followup' | 'replies'
  | 'meeting' | 'clientcare' | 'audit' | 'report' | 'campaigns';

export type Intent =
  | { kind: 'smalltalk' }
  | { kind: 'capabilities' }
  | { kind: 'tool'; mode: ToolMode; arg: string };

/* ---------- cheap deterministic signals ---------- */
const GREETING = /^\s*(hi+|hey+|hello+|hlo|yo|sup|hola|namaste|namaskar|good\s*(morning|afternoon|evening|day)|howdy|greetings|wassup|what'?s up)\b/i;
const THANKS = /\b(thanks|thank you|thx|ty|cheers|appreciate (it|you))\b/i;
const BYE = /\b(bye|goodbye|see (ya|you)|cya|later|good ?night)\b/i;
const HELP = /(what can you do|what do you do|what are you able|how (do|does) (you|this|nova) work|who are you|what are you|your (capabilities|features)|\bcapabilities\b|\bhelp\b|\bcommands?\b|\bmenu\b|get(ting)? started|show me (what|everything))/i;

const wordCount = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

export function looksConversational(text: string): 'smalltalk' | 'capabilities' | null {
  const t = (text || '').trim();
  if (!t) return null;
  if (HELP.test(t)) return 'capabilities';
  if (wordCount(t) <= 6 && (GREETING.test(t) || THANKS.test(t) || BYE.test(t))) return 'smalltalk';
  return null;
}

function extractDomain(text: string): string {
  const m = text.match(/\b((?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})(\/[^\s]*)?/i);
  if (!m) return '';
  const host = m[1].toLowerCase();
  if (/^(e\.g|i\.e|vs|etc|no|a\.m|p\.m)\.?$/.test(host)) return '';
  return m[0].trim();
}

const tool = (mode: ToolMode, arg: string): Intent => ({ kind: 'tool', mode, arg });

/**
 * Decide what a message means. Deterministic rules first (free, instant);
 * the LLM is only a fallback classifier for genuinely ambiguous input.
 */
export async function classify(text: string): Promise<Intent> {
  const t = (text || '').trim();
  if (!t) return { kind: 'smalltalk' };
  const low = t.toLowerCase();

  if (HELP.test(low)) return { kind: 'capabilities' };
  if (wordCount(t) <= 6 && (GREETING.test(low) || THANKS.test(low) || BYE.test(low))) return { kind: 'smalltalk' };

  const domain = extractDomain(t);

  // Replies / inbox
  if (/\b(replies|reply|inbox|responded|check (the )?(mail|email|inbox)|any responses?)\b/.test(low))
    return tool('replies', '');

  // Meetings / scheduling
  if (/\b(meeting|schedule|book (a )?(call|meeting)|calendar|discovery call|upcoming (calls?|meetings?)|my meetings?)\b/.test(low))
    return tool('meeting', t);

  // Campaigns / bulk outreach
  if (/\b(campaigns?|bulk (email|send|outreach)|mass email|blast|upload (a )?(list|file|csv|contacts?)|email list)\b/.test(low))
    return tool('campaigns', '');

  // Client care
  if (/\b(client care|birthday|anniversary|check[- ]?in|check clients?|care actions?)\b/.test(low))
    return tool('clientcare', '');

  // Follow-ups
  if (/\b(follow[- ]?up|followup|chase|sequence|nudge|due follow)\b/.test(low))
    return tool('followup', domain);

  // Pipeline
  if (/\b(pipeline|deals?|prospects?( status)?|where are we|stage|show me (the )?(pipeline|deals)|going cold|stale)\b/.test(low))
    return tool('pipeline', '');

  // Outreach
  if (/\b(outreach|cold email|write (to|an? email)|reach out|contact them|draft (an? )?email|email (them|to))\b/.test(low))
    return tool('outreach', domain || stripVerbs(low));

  // Full report
  if (/\b(full report|prospect report|full prospect report|complete report|report for)\b/.test(low))
    return tool('report', domain || stripVerbs(low));

  // Audit
  if (/\b(audit|seo|check (the )?site|lighthouse|site health|page ?speed)\b/.test(low))
    return tool('audit', domain || stripVerbs(low));

  // Research (also: a bare domain / list of domains)
  if (/\b(research|prospect|look up|check out|investigate|find out about|intel on)\b/.test(low))
    return tool('research', domain ? sliceDomains(t) : stripVerbs(low));

  // A bare domain (or list) on its own → research it.
  if (domain) return tool('research', sliceDomains(t));

  // Ambiguous → LLM router (command execution only, no data invented).
  if (llmConfigured()) {
    try {
      const system =
        'You route a user message to ONE business-development tool, or to chat. Tools: ' +
        'research (research a prospect company from its domain), outreach (write a cold outreach email), ' +
        'pipeline (show the deal pipeline), followup (manage follow-up sequences), replies (check inbound replies), ' +
        'meeting (schedule/show meetings), clientcare (client birthdays/anniversaries/check-ins), ' +
        'campaigns (bulk outreach — upload an email list, configure templates, mass send), ' +
        'audit (lightweight SEO audit of a site), report (full prospect report). ' +
        'If the message is small talk or a question about you, use "smalltalk". If they ask what you can do, use "capabilities". ' +
        'Extract the argument: a domain for research/outreach/audit/report/followup, empty for pipeline/replies/clientcare/meeting. ' +
        'Return JSON: {"intent":"research|outreach|pipeline|followup|replies|meeting|clientcare|audit|report|smalltalk|capabilities","arg":string}.';
      const r = await completeJSON<{ intent: string; arg?: string }>(system, t, { temperature: 0 });
      const arg = String(r.arg || '').trim();
      switch (r.intent) {
        case 'research': case 'outreach': case 'followup': case 'meeting': case 'audit': case 'report':
          return tool(r.intent as ToolMode, arg);
        case 'pipeline': return tool('pipeline', '');
        case 'replies': return tool('replies', '');
        case 'clientcare': return tool('clientcare', '');
        case 'campaigns': return tool('campaigns', '');
        case 'capabilities': return { kind: 'capabilities' };
        default: return { kind: 'smalltalk' };
      }
    } catch { /* fall through */ }
  }

  return { kind: 'smalltalk' };
}

function stripVerbs(text: string): string {
  return text
    .replace(/^(please|hey|ok|okay|can you|could you|would you|pls|plz)\s+/i, '')
    .replace(/^(do|run|give me|get me|find|show me|build|create|make|generate|write|research|audit|email)\s+/i, '')
    .replace(/\b(for|on|about|to)\b\s*/i, '')
    .replace(/\s{2,}/g, ' ').trim();
}
/** Keep the domain/email tokens (bulk research) out of a free-text command. */
function sliceDomains(text: string): string {
  const tokens = text.split(/[\s,]+/).filter((tok) => /[a-z0-9-]+\.[a-z]{2,}/i.test(tok));
  return tokens.join(', ') || text;
}

/* ---------- conversation replies ---------- */
const SMALLTALK_SYSTEM =
  `You are NOVA, an autonomous business-development agent for ${config.agency.name}, a digital marketing agency. You are making brief, friendly small talk. ` +
  'Reply in 1-3 short, warm sentences, no lists. You may chat, but NEVER invent prospect data, SEO scores, reply contents or pipeline numbers in conversation — those only come from running the real tools. ' +
  'If the user seems to want work done, invite a command (e.g. "research acmedigital.com" or "show pipeline"). Keep it human and concise.';

export async function smalltalkReport(text: string): Promise<Report> {
  const t = (text || '').trim();
  if (llmConfigured()) {
    try {
      const reply = await complete(SMALLTALK_SYSTEM, t || 'Hi', { temperature: 0.6, maxTokens: 180 });
      const clean = reply.trim().replace(/^["“]|["”]$/g, '');
      return { tag: 'NOVA', title: '', blocks: [b.p(clean), b.note('Tip: tap “What can you do?” to see everything I can run.')] };
    } catch { /* fall back */ }
  }
  return { tag: 'NOVA', title: '', blocks: [b.p(templateReply(t)), b.note('Tip: tap “What can you do?” to see everything I can run.')] };
}

function templateReply(text: string): string {
  const low = text.toLowerCase();
  if (THANKS.test(low)) return "You're welcome — point me at a domain whenever you're ready to prospect.";
  if (BYE.test(low)) return 'Catch you later — I’ll keep the pipeline warm.';
  if (GREETING.test(low) || !text) return `Hey! I’m NOVA, ${config.agency.name}'s business-development agent. I research prospects, write outreach, run the pipeline, chase follow-ups, read replies, book meetings and look after clients. Who are we going after?`;
  return 'I’m NOVA — I handle business development. Try “research acmedigital.com” or “show pipeline”, or tap “What can you do?”.';
}

/* ---------- capabilities (deterministic, reflects live status) ---------- */
export function capabilitiesReport(): Report {
  const llm = llmInfo();
  const blocks = [
    b.p(`I’m NOVA — ${config.agency.name}'s autonomous business-development agent. You just talk to me. I chat normally, and when you give a command I run the real job live (scraping prospect sites, calling Google Lighthouse, reading the inbox, managing the CRM) — I don’t make data up.`),
    b.table(
      ['What I do', 'Just say…', 'Runs on (real data)'],
      [
        ['Research a prospect', '“research acmedigital.com”', 'Website scrape + Lighthouse + socials'],
        ['Generate outreach', '“write outreach for acme.com”', 'LLM over the real research'],
        ['Manage pipeline', '“show pipeline”', 'CRM JSON store'],
        ['Follow-up sequences', '“follow up with acme.com”', 'Day 3/7/14 queue'],
        ['Parse replies', '“check replies”', 'IMAP inbox + LLM classify'],
        ['Schedule meetings', '“book meeting with acme.com”', 'Availability + calendar'],
        ['Client care', '“client care”', 'Client store (birthdays/anniversaries)'],
        ['Bulk campaigns', '“campaigns”', 'Upload a list → templates → mass send'],
        ['Run audit', '“audit acme.com”', 'Lighthouse + shallow crawl'],
        ['Full prospect report', '“full report for acme.com”', 'Everything above, aggregated'],
      ],
    ),
    b.kv([
      { k: 'AI (chat + routing + copy)', v: llm.configured ? `Connected · ${llm.provider}/${llm.model}` : 'Not configured — add an LLM key in .env' },
      { k: 'Email send (SMTP)', v: emailConfigured() ? 'Connected' : 'Set SMTP_* to send outreach' },
      { k: 'Inbox read (IMAP)', v: imapConfigured() ? 'Connected' : 'Set IMAP_* to parse replies' },
      { k: 'Google Calendar', v: calendarConfigured() ? 'Connected' : 'Optional — set GOOGLE_CALENDAR_TOKEN' },
    ]),
    b.note('Everything runs live on real data. The AI chats, routes your command, and writes the outreach/reply/care copy — it never invents prospect facts, scores or numbers.'),
  ];
  return { tag: 'NOVA', title: 'Here’s everything I can do', blocks };
}
