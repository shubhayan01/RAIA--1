import { complete, completeJSON, llmConfigured, llmInfo } from '../llm';
import { config } from '../config';
import { serpEnabled } from '../sources/serp';
import { Report, b } from '../lib/report';

/**
 * Conversation + command routing.
 *
 * This is the ONLY place the LLM is allowed to "talk". Its two jobs here are:
 *   1. reply to normal conversation (hi / thanks / who are you), and
 *   2. decide which REAL tool a request maps to (command execution).
 *
 * It must never fabricate SEO data — every metric, ranking, audit or brief
 * comes from the real services (crawler, SERP, Google Search Console/GA4).
 */

export type ToolMode = 'keywords' | 'audit' | 'briefs' | 'intel' | 'competitors' | 'aio' | 'ranks' | 'cannibal' | 'opportunity' | 'autolink' | 'schema';
export type Intent =
  | { kind: 'smalltalk' }
  | { kind: 'capabilities' }
  | { kind: 'tool'; mode: ToolMode; arg: string };

/* ---------- cheap deterministic signals ---------- */
const GREETING = /^\s*(hi+|hey+|hello+|hlo|yo|sup|hola|namaste|namaskar|good\s*(morning|afternoon|evening|day)|howdy|greetings|wassup|what'?s up)\b/i;
const THANKS = /\b(thanks|thank you|thx|ty|cheers|appreciate (it|you))\b/i;
const BYE = /\b(bye|goodbye|see (ya|you)|cya|later|good ?night)\b/i;
const HELP = /(what can you do|what do you do|what are you able|how (do|does) (you|this|sage) work|who are you|what are you|your (capabilities|features)|\bcapabilities\b|\bhelp\b|\bcommands?\b|\bmenu\b|get(ting)? started|show me (what|everything))/i;

const wordCount = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

/** A quick regex-only check routes.ts uses to catch chit-chat typed into any mode. */
export function looksConversational(text: string): 'smalltalk' | 'capabilities' | null {
  const t = (text || '').trim();
  if (!t) return null;
  if (HELP.test(t)) return 'capabilities';
  if (wordCount(t) <= 6 && (GREETING.test(t) || THANKS.test(t) || BYE.test(t))) return 'smalltalk';
  return null;
}

/** Pull the first URL or bare domain out of free text (e.g. "audit example.com/blog"). */
function extractUrlOrDomain(text: string): string {
  const m = text.match(/\b((?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})(\/[^\s]*)?/i);
  if (!m) return '';
  // ignore things like "e.g." or "vs." that sneak past the TLD rule
  const host = m[1].toLowerCase();
  if (/^(e\.g|i\.e|vs|etc|no|a\.m|p\.m)\.?$/.test(host)) return '';
  return (m[0]).trim();
}

/** Strip leading command verbs so "research keywords for running shoes" → "running shoes". */
function stripCommandWords(text: string): string {
  let t = text.trim();
  t = t.replace(/^(please|hey|ok|okay|can you|could you|would you|pls|plz)\s+/i, '');
  t = t.replace(/^(do|run|give me|get me|find|show me|build|create|make|generate|write)\s+/i, '');
  t = t.replace(/\b(a |the )?(keyword|key word|keywords?)\s+(research|ideas?|list|clusters?)\b/i, '');
  t = t.replace(/\b(research|cluster|clustering|analyze|analyse)\b/i, '');
  t = t.replace(/\b(content )?brief\b/i, '');
  t = t.replace(/\b(an? )?(outline|content plan)\b/i, '');
  t = t.replace(/\b(topics?|ideas?|keywords?)\s+(for|on|about|around|to target)\b/i, '');
  t = t.replace(/\b(for|on|about|around)\b\s*/i, ''); // leftover connector
  return t.replace(/\s{2,}/g, ' ').trim();
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

  const url = extractUrlOrDomain(t);

  // Automated GSC Opportunity Loop — "run opportunity loop" / "find quick wins".
  if (/\b(opportunity loop|quick wins?|striking[- ]distance (automation|loop)|find (me )?(quick )?wins)\b/.test(low))
    return tool('opportunity', t);

  // Schema / structured-data injection — "add schema to <url>". Pass the full text
  // so the "apply/inject" keyword survives to runTool.
  if (/\b(schema|structured data|json[- ]?ld|rich results?|rich snippets?)\b/.test(low))
    return tool('schema', t);

  // Automated internal linking — "internal links for <url>", "interlink <site>".
  if (/\b(internal link(s|ing)?|inter[- ]?link(s|ing)?|auto[- ]?link(s|ing)?)\b/.test(low))
    return tool('autolink', t);

  // AI Overview content gap (GEO/AEO) — check before generic "content gap".
  if (/\b(ai overviews?|ai snapshot|\baio\b|\bsge\b|ai citations?|google ai overview)\b/.test(low))
    return tool('aio', t);

  // Keyword cannibalization — check before generic competitors/gap.
  if (/\b(cannibali[sz]ation|cannibali[sz]e|competing pages|duplicate keywords?|keyword overlap)\b/.test(low))
    return tool('cannibal', t);

  // Rank tracking
  if (/\b(rank tracker|track (my |our )?ranks?|rankings? for|check (my |our )?rank|serp position|where (do|does) .* rank)\b/.test(low))
    return tool('ranks', t);

  // Intelligence report (no argument needed)
  if (/\b(intelligence|intel|gsc|search console|analytics|ga4|traffic report|monthly report|performance (report|data)|how are we (doing|ranking|performing))\b/.test(low))
    return tool('intel', '');

  // Competitive / gap analysis
  if (/\b(competitors?|competition|competitive|rivals?|gap analysis|content gaps?|keyword gaps?|who (am i|are we) (competing|up against))\b/.test(low))
    return tool('competitors', url || stripCommandWords(low.replace(/\b(competitors?|competition|competitive|rivals?|gap analysis|content gaps?|keyword gaps?)\b/gi, '')));

  // Technical audit
  if (/\b(audit|crawl|technical seo|site health|broken links?|status codes?|indexing issues?|check (my|the|this) site)\b/.test(low))
    return tool('audit', url || stripCommandWords(low));

  // Content brief
  if (/\b(brief|outline|content plan|content brief)\b/.test(low))
    return tool('briefs', stripCommandWords(t));

  // Keyword research
  if (/\b(keywords?|key ?word|clusters?|search terms|rank(ing)? for|topics? to target)\b/.test(low))
    return tool('keywords', stripCommandWords(t) || t);

  // A bare URL/domain on its own is almost always "audit this".
  if (url && wordCount(t) <= 3) return tool('audit', url);

  // Ambiguous → let the LLM route it (command execution only, no data invented).
  if (llmConfigured()) {
    try {
      const system =
        'You route a user message to ONE SEO tool, or to chat. Tools: ' +
        'keywords (keyword research & clustering), audit (crawl a site for technical/on-page issues), ' +
        'briefs (content brief for a keyword), intel (pull Google Search Console + GA4 report), ' +
        'competitors (competitive/content-gap analysis for a domain), ' +
        'aio (AI Overview content gap: what Google’s AI Overview cites for a keyword vs the client article), ' +
        'ranks (track a domain’s Google position for a list of keywords), ' +
        'cannibal (find pages on a site competing for the same keyword), ' +
        'schema (generate & inject structured-data JSON-LD for a site’s pages), ' +
        'autolink (find & insert internal links across a site). ' +
        'If the message is small talk or a question about you, use "smalltalk". If they ask what you can do, use "capabilities". ' +
        'Extract the argument: a domain/URL for audit, competitors, ranks, cannibal, schema & autolink, a keyword/topic for keywords, briefs & aio, empty for intel. ' +
        'Return JSON: {"intent":"keywords|audit|briefs|intel|competitors|aio|ranks|cannibal|schema|autolink|smalltalk|capabilities","arg":string}.';
      const r = await completeJSON<{ intent: string; arg?: string }>(system, t, { temperature: 0 });
      const arg = String(r.arg || '').trim();
      switch (r.intent) {
        case 'keywords': case 'audit': case 'briefs': case 'competitors': case 'aio': case 'ranks': case 'cannibal': case 'schema': case 'autolink':
          return tool(r.intent as ToolMode, arg);
        case 'intel': return tool('intel', '');
        case 'capabilities': return { kind: 'capabilities' };
        default: return { kind: 'smalltalk' };
      }
    } catch { /* fall through to smalltalk */ }
  }

  return { kind: 'smalltalk' };
}

/* ---------- conversation replies ---------- */
const SMALLTALK_SYSTEM =
  'You are S.A.G.E, an autonomous SEO agent for a digital marketing agency. You are making brief, friendly small talk. ' +
  'Reply in 1-3 short, warm sentences, no lists. You are allowed to chat, but you must NEVER invent SEO data, rankings, ' +
  'traffic numbers, audit results or briefs in conversation — those only come from running the real tools. ' +
  'If the user seems to want SEO work, invite them to give a command (e.g. "audit example.com" or "research keywords for running shoes"). ' +
  'Keep it human and concise.';

export async function smalltalkReport(text: string): Promise<Report> {
  const t = (text || '').trim();
  if (llmConfigured()) {
    try {
      const reply = await complete(SMALLTALK_SYSTEM, t || 'Hi', { temperature: 0.6, maxTokens: 180 });
      const clean = reply.trim().replace(/^["“]|["”]$/g, '');
      return {
        tag: 'S.A.G.E',
        title: '',
        blocks: [b.p(clean), b.note('Tip: tap “What can you do?” to see everything I can actually run.')],
      };
    } catch { /* fall back to template */ }
  }
  return {
    tag: 'S.A.G.E',
    title: '',
    blocks: [
      b.p(templateReply(t)),
      b.note('Tip: tap “What can you do?” to see everything I can actually run.'),
    ],
  };
}

function templateReply(text: string): string {
  const low = text.toLowerCase();
  if (THANKS.test(low)) return "You're welcome — happy to help. Point me at a site or a keyword whenever you're ready.";
  if (BYE.test(low)) return 'Catch you later — I’ll be here when you need an audit, keywords, or a report.';
  if (GREETING.test(low) || !text) return "Hey! I’m S.A.G.E, your SEO agent. I can research keywords, audit a site, build content briefs, pull Search Console/GA4 reports, and run competitor gap analysis. What are we working on?";
  return "I’m S.A.G.E — I handle the SEO grunt work. Give me a command like “audit example.com” or “research keywords for running shoes”, or tap “What can you do?”.";
}

/* ---------- capabilities (deterministic, reflects live status) ---------- */
export function capabilitiesReport(): Report {
  const llm = llmInfo();
  const g = config.google;
  const gscOn = !!g.gscSiteUrl && (!!g.accessToken || !!g.refreshToken);
  const ga4On = !!g.ga4PropertyId && (!!g.accessToken || !!g.refreshToken);

  const blocks = [
    b.p('I’m S.A.G.E — an autonomous SEO agent. You just talk to me. I chat normally, and when you give a command I run the real job live (crawling sites, calling Google, analysing SERPs) — I don’t make numbers up.'),
    b.table(
      ['What I do', 'Just say…', 'Runs on (real data)'],
      [
        ['Keyword research & clustering', '“research keywords for <topic>”', 'Google Autocomplete + SERP'],
        ['Technical + on-page audit', '“audit <site.com>”', 'Live crawler, robots, sitemap, PageSpeed'],
        ['Content brief', '“content brief for <keyword>”', 'Live SERP + competitor page HTML'],
        ['AI Overview content gap', '“ai overview gap for <keyword> vs <your-url>”', 'AI Overview sources + page scraping'],
        ['Rank tracker', '“rankings for <site.com>: kw1, kw2, kw3”', 'Live SERP positions'],
        ['Keyword cannibalization', '“cannibalization for <site.com>”', 'Site crawl (title/H1 overlap)'],
        ['Auto internal linking', '“internal links for <site.com>” (add “apply” to push)', 'Site crawl → WordPress'],
        ['Auto schema / JSON-LD', '“add schema to <site.com>” (add “apply” to inject)', 'Site crawl → WordPress'],
        ['SEO intelligence report', '“pull the SEO report”', 'Google Search Console + GA4'],
        ['Competitive gap analysis', '“competitors for <site.com>”', 'SERP overlap + competitor pages'],
      ],
    ),
    b.p('You can also just say hi, ask questions, or use the pills below to force a specific tool.'),
    b.kv([
      { k: 'AI (chat + routing)', v: llm.configured ? `Connected · ${llm.provider}/${llm.model}` : 'Not configured — add an LLM key in .env' },
      { k: 'SERP data', v: serpEnabled() ? `On · ${config.serp.provider}` : 'Off — set SERP_PROVIDER' },
      { k: 'PageSpeed (Core Web Vitals)', v: g.pagespeedKey ? 'Connected' : 'Optional — add PAGESPEED_API_KEY' },
      { k: 'Search Console', v: gscOn ? `Connected · ${g.gscSiteUrl}` : 'Connect for the Intelligence report' },
      { k: 'GA4 analytics', v: ga4On ? `Connected · ${g.ga4PropertyId}` : 'Optional — add GA4_PROPERTY_ID' },
    ]),
    b.note('Everything runs live on real data. The AI is only used to chat and to understand your command — never to invent SEO results.'),
  ];

  return { tag: 'S.A.G.E', title: 'Here’s everything I can do', blocks };
}
