import { complete, completeJSON, llmConfigured, llmInfo } from '../llm';
import { config } from '../config';
import { serpEnabled } from '../sources/serp';
import { Report, b } from '../lib/report';

/**
 * Conversation + command routing (same pattern as SAGE/NOVA converse.ts).
 *
 * This is the ONLY place the LLM "talks": it replies to small talk and decides
 * which REAL SCRIBE tool a request maps to. It never fabricates research,
 * rankings, word counts or verdicts — those come from the real services.
 */

export type ToolMode =
  | 'research' | 'competitors' | 'gap' | 'keywords' | 'brand'
  | 'evidence' | 'write' | 'factcheck' | 'aicheck' | 'eeat' | 'audit' | 'gate' | 'workflow';

export type Intent =
  | { kind: 'smalltalk' }
  | { kind: 'capabilities' }
  | { kind: 'tool'; mode: ToolMode; arg: string };

const GREETING = /^\s*(hi+|hey+|hello+|hlo|yo|sup|hola|namaste|namaskar|good\s*(morning|afternoon|evening|day)|howdy|greetings|wassup|what'?s up)\b/i;
const THANKS = /\b(thanks|thank you|thx|ty|cheers|appreciate (it|you))\b/i;
const BYE = /\b(bye|goodbye|see (ya|you)|cya|later|good ?night)\b/i;
const HELP = /(what can you do|what do you do|what are you able|how (do|does) (you|this|scribe) work|who are you|what are you|your (capabilities|features)|\bcapabilities\b|\bhelp\b|\bcommands?\b|\bmenu\b|get(ting)? started|show me (what|everything))/i;

const wordCount = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

export function looksConversational(text: string): 'smalltalk' | 'capabilities' | null {
  const t = (text || '').trim();
  if (!t) return null;
  if (HELP.test(t)) return 'capabilities';
  if (wordCount(t) <= 6 && (GREETING.test(t) || THANKS.test(t) || BYE.test(t))) return 'smalltalk';
  return null;
}

const tool = (mode: ToolMode, arg: string): Intent => ({ kind: 'tool', mode, arg });

/** Strip a leading command verb + connective words to isolate the keyword/topic. */
export function stripVerbs(text: string): string {
  // Strip only LEADING request scaffolding (never global — topic words like
  // "content", "of", "blog" are legitimate keywords, e.g. "content marketing").
  let s = text.trim()
    .replace(/^(please|hey|ok|okay|can you|could you|would you|pls|plz)\s+/i, '')
    .replace(/^(do|run|give me|get me|find|show me|build|create|make|generate|write|research|analyze|analyse|check|expand|cluster)\s+/i, '')
    .replace(/^(the\s+)?(full\s+)?(content\s+)?(workflow|pipeline)\s+(for|on|about)?\s*/i, '')
    .replace(/^(the\s+)?keyword\s+/i, '')
    // "a blog on <topic>", "an article about <topic>", "a post for <topic>"
    .replace(/^(a|an|the)\s+(blog post|blog|article|post|guide|piece|draft)\s+(on|about|for|around|covering|regarding)\s+/i, '')
    // a bare leading connective, then a leftover leading article
    .replace(/^(on|about|for|regarding)\s+/i, '')
    .replace(/^(a|an|the)\s+/i, '');
  return s.replace(/\s{2,}/g, ' ').trim();
}

export function extractUrl(text: string): string {
  const m = (text || '').match(/https?:\/\/[^\s]+/i) || (text || '').match(/\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\s]*)?/i);
  if (!m) return '';
  const host = m[0].toLowerCase();
  if (/^(e\.g|i\.e|vs|etc|no|a\.m|p\.m)\.?$/.test(host)) return '';
  return m[0].trim();
}

export async function classify(text: string): Promise<Intent> {
  const t = (text || '').trim();
  if (!t) return { kind: 'smalltalk' };
  const low = t.toLowerCase();

  if (HELP.test(low)) return { kind: 'capabilities' };
  if (wordCount(t) <= 6 && (GREETING.test(low) || THANKS.test(low) || BYE.test(low))) return { kind: 'smalltalk' };

  // Full workflow.
  if (/\b(full (workflow|pipeline|run)|do everything|whole (thing|workflow)|end[- ]to[- ]end|complete (workflow|content))\b/.test(low))
    return tool('workflow', stripVerbs(low));

  // Review tools (operate on a draft/pasted content).
  if (/\b(fact[- ]?check|verify (facts?|claims?|statistics?)|check (facts?|sources?|accuracy))\b/.test(low))
    return tool('factcheck', stripVerbs(low));
  if (/\b(ai[- ]?(check|scan|detection|detector)|is this ai|written by ai|humanize|human-ish|ai patterns?)\b/.test(low))
    return tool('aicheck', stripVerbs(low));
  if (/\b(e-?e-?a-?t|eeat|experience.*expertise|authoritativeness|trust(worthiness)?|quality (score|rater))\b/.test(low))
    return tool('eeat', stripVerbs(low));
  if (/\b(self[- ]?audit|audit (this|the |my )?(draft|post|article|content)?|second pass|checklist|self[- ]?check|compliance check)\b/.test(low))
    return tool('audit', stripVerbs(low));
  if (/\b(publish gate|run (the )?gate|gate (this|the )?(draft)?|autonomous fix|auto[- ]?fix|verify (and|&) fix|publish[- ]?ready)\b/.test(low))
    return tool('gate', stripVerbs(low));
  if (/\b(evidence|gather evidence|collect evidence|find (real )?(stats|statistics|sources)|verify sources first|evidence pack)\b/.test(low))
    return tool('evidence', stripVerbs(low));

  // Brand voice (usually with a URL).
  if (/\b(brand (voice|tone)|tone of voice|voice (and|&) tone|analyze my site|my (brand|voice))\b/.test(low))
    return tool('brand', extractUrl(t) || stripVerbs(low));

  // Keyword expansion / clustering.
  if (/\b(expand keywords?|similar keywords?|keyword (clusters?|ideas?|research)|cluster|related keywords?|topic clusters?)\b/.test(low))
    return tool('keywords', stripVerbs(low));

  // Content gap.
  if (/\b(content gaps?|gap analysis|what('?s| is) missing|opportunit)/.test(low))
    return tool('gap', stripVerbs(low));

  // Competitor analysis.
  if (/\b(competitors?|competitor (content|analysis)|top (ranking|blogs?|content)|analyze competitors?|serp analysis)\b/.test(low))
    return tool('competitors', stripVerbs(low));

  // Write / generate.
  if (/\b(write|draft|generate|create) (a |an |the )?(blog|article|post|content|draft|piece)|\bwrite about\b|\bdraft (a|an|the)\b/.test(low))
    return tool('write', stripVerbs(low));

  // Research (default for keyword-y input).
  if (/\b(research|analyze|analyse|look up|investigate|serp|rankings?|word count|top results?)\b/.test(low))
    return tool('research', stripVerbs(low));

  // Ambiguous → LLM router (routing only, no data invented).
  if (llmConfigured()) {
    try {
      const system =
        'You route a user message to ONE content-automation tool, or to chat. Tools: ' +
        'research (search a keyword, find top-ranking blogs, avg word count, related terms), ' +
        'competitors (deep content analysis of the top-ranking pages), ' +
        'gap (content-gap analysis vs competitors + the user site), ' +
        'keywords (similar keywords + topic clustering), ' +
        'brand (extract brand voice/tone from the user site), ' +
        'evidence (gather + verify real statistics/quotes/case studies BEFORE writing; halts on low evidence), ' +
        'write (generate a content draft constrained to the evidence), ' +
        'gate (autonomous verify-and-fix loop that makes a draft publish-ready or flags exactly what needs a human), ' +
        'factcheck (verify claims in content against live search), ' +
        'aicheck (detect AI-writing patterns), ' +
        'eeat (score content on E-E-A-T), ' +
        'audit (second-pass self-audit of a draft against the anti-hallucination + house-style checklist: em dashes, placeholders, unattributed stats, fabricated quotes/case studies, word count), ' +
        'workflow (run the entire pipeline end to end). ' +
        'If small talk or a question about you, use "smalltalk". If they ask what you can do, use "capabilities". ' +
        'The argument is the keyword/topic (or a URL for brand). ' +
        'Return JSON: {"intent":"research|competitors|gap|keywords|brand|evidence|write|factcheck|aicheck|eeat|audit|gate|workflow|smalltalk|capabilities","arg":string}.';
      const r = await completeJSON<{ intent: string; arg?: string }>(system, t, { temperature: 0 });
      const arg = String(r.arg || '').trim();
      const modes: ToolMode[] = ['research', 'competitors', 'gap', 'keywords', 'brand', 'evidence', 'write', 'factcheck', 'aicheck', 'eeat', 'audit', 'gate', 'workflow'];
      if (modes.includes(r.intent as ToolMode)) return tool(r.intent as ToolMode, arg);
      if (r.intent === 'capabilities') return { kind: 'capabilities' };
      return { kind: 'smalltalk' };
    } catch { /* fall through */ }
  }

  // A bare keyword on its own → research it.
  return tool('research', t);
}

/* ---------- conversation replies ---------- */
const SMALLTALK_SYSTEM =
  `You are SCRIBE, a content-automation agent for ${config.brand.name || 'a content team'}. You are making brief, friendly small talk. ` +
  'Reply in 1-3 short, warm sentences, no lists. You may chat, but NEVER invent research, rankings, word counts or fact-check verdicts in conversation — those only come from running the real tools. ' +
  'If the user seems to want work done, invite a command (e.g. "research \'best running shoes\'" or "run the full workflow"). Keep it human and concise.';

export async function smalltalkReport(text: string): Promise<Report> {
  const t = (text || '').trim();
  if (llmConfigured()) {
    try {
      const reply = await complete(SMALLTALK_SYSTEM, t || 'Hi', { temperature: 0.6, maxTokens: 180 });
      const clean = reply.trim().replace(/^["“]|["”]$/g, '');
      return { tag: 'SCRIBE', title: '', blocks: [b.p(clean), b.note('Tip: tap “What can you do?” to see everything I can run.')] };
    } catch { /* fall back */ }
  }
  return { tag: 'SCRIBE', title: '', blocks: [b.p(templateReply(t)), b.note('Tip: tap “What can you do?” to see everything I can run.')] };
}

function templateReply(text: string): string {
  const low = text.toLowerCase();
  if (THANKS.test(low)) return "You're welcome — hand me a keyword whenever you want to research or draft something.";
  if (BYE.test(low)) return 'Catch you later — I’ll keep the drafts warm.';
  if (GREETING.test(low) || !text) return `Hey! I’m SCRIBE. Give me a keyword and your site, and I’ll research the SERP, analyse competitors, find gaps, cluster keywords, write a draft in your voice, fact-check it and score its E-E-A-T. Where shall we start?`;
  return 'I’m SCRIBE — content automation. Try “research \'best running shoes\'” or “run the full workflow”, or tap “What can you do?”.';
}

/* ---------- capabilities (deterministic, reflects live status) ---------- */
export function capabilitiesReport(): Report {
  const llm = llmInfo();
  const blocks = [
    b.p(`I’m SCRIBE — a content-automation agent. Give me a keyword and your website; I run each job live on real data (search results, competitor pages, live fact-check sources) and only use the AI to write and structure — never to invent research.`),
    b.table(
      ['What I do', 'Just say…', 'Runs on (real data)'],
      [
        ['Keyword research', '“research \'flat feet running shoes\'”', 'Live SERP + measured word counts'],
        ['Competitor analysis', '“analyze competitors”', 'Deep scrape of top-ranking pages'],
        ['Content gaps', '“find content gaps”', 'Competitor outlines vs your site'],
        ['Keyword clusters', '“expand keywords”', 'Real related searches + PAA'],
        ['Brand voice', '“brand voice yoursite.com”', 'Your site’s real copy'],
        ['Gather evidence', '“evidence for <keyword>”', 'Verified stats/quotes (pre-write gate)'],
        ['Write a draft', '“write about <keyword>”', 'Evidence-constrained generation'],
        ['Publish gate', '“run the gate”', 'Autonomous verify-and-fix loop'],
        ['Fact-check', '“fact-check my draft”', 'Live search per claim'],
        ['AI-pattern scan', '“ai-check this”', 'Deterministic text signals'],
        ['E-E-A-T score', '“check E-E-A-T”', 'Detected signals + your params'],
        ['Self-audit (2nd pass)', '“audit this draft”', 'Measured checks + honesty flags'],
        ['Full workflow', '“run the full workflow”', 'Everything, end to end'],
      ],
    ),
    b.kv([
      { k: 'AI (chat + routing + writing)', v: llm.configured ? `Connected · ${llm.provider}/${llm.model}` : 'Not configured — add an LLM key in .env' },
      { k: 'Search (SERP)', v: serpEnabled() ? `Enabled · ${config.serp.provider}` : 'Disabled — set SERP_PROVIDER' },
    ]),
    b.note('Every research number is measured live. The AI chats, routes your command, and writes/structures content — it never invents rankings, word counts or fact-check verdicts.'),
  ];
  return { tag: 'SCRIBE', title: 'Here’s everything I can do', blocks };
}
