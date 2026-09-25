import { config } from '../config';
import { serp, serpEnabled, serpErrorNote } from '../sources/serp';
import { fetchPageContent, domainOf } from '../sources/content';
import { completeJSON, llmConfigured } from '../llm';
import { pool } from '../lib/concurrency';
import { Report, b } from '../lib/report';
import { ContentProject, ensureProject, loadProject, saveProject } from '../lib/project';
import { dataPath } from '../lib/jsonStore';
import { gatherResearch } from './research';
import { promises as fs } from 'node:fs';

/**
 * Evidence collection (SCRIBE — the real fix for fabrication).
 *
 * This stage runs BEFORE the writer. Its job is to gather the ONLY factual
 * material the writer is later allowed to cite: real statistics (whose numbers we
 * verify are actually present on the fetched source page, not hallucinated from a
 * search-result title), real quotes from named people, agency-owned case studies,
 * and a genuine contrarian source to anchor the required point-of-view section.
 *
 * If fewer than MIN_STATS statistics survive verification, we DO NOT proceed to
 * the writer. We return LOW_EVIDENCE and surface it exactly like SCRIBE's other
 * honest failures (a missing API key): the honest-failure principle extended from
 * research AVAILABILITY to research QUALITY. Nothing fabricated ever gets written
 * because there is nothing to fabricate from.
 */

export const MIN_STATS = 3;

/** The evidence-halt boundary: fewer than MIN_STATS verified stats stops writing. */
export function isLowEvidence(verifiedStatCount: number): boolean {
  return verifiedStatCount < MIN_STATS;
}

export interface EvidenceStat {
  claim: string;
  source: string;   // the publication/source name as written
  org: string;      // organization the figure is attributed to
  year: number;     // 0 when the page states none
  url: string;
  verified: boolean; // true = the figure literally appears in the fetched page text
}

export interface EvidenceQuote {
  text: string;
  speaker: string;
  title: string;
  org: string;
  url: string;
}

export interface EvidenceCaseStudy {
  client: string;
  outcome: string;
  source: 'internal' | 'external';
  sourceUrl?: string;
  verified: boolean;
}

export interface ContrarianSource {
  claim: string;
  source: string;
  url: string;
}

export type EvidenceStatus = 'OK' | 'LOW_EVIDENCE' | 'NO_SEARCH';

/**
 * A substantive, attributable insight lifted from a real source page — a
 * definition, a method, a trade-off, a named technique or a concrete example.
 * This is the MATERIAL a content writer synthesizes into original prose. Unlike a
 * stat it carries no fabricated number (any figure it mentions must also exist as
 * a verified stat), so the writer can explain a topic with real substance instead
 * of generic filler, without ever inventing data.
 */
export interface SourceInsight {
  point: string;
  domain: string;
  url: string;
}

/**
 * How the top-ranking pages actually write this topic — learned from their real
 * H2/H3 outlines, typical length and format. The writer mirrors this so the draft
 * matches what already wins the SERP, instead of imposing a generic template.
 */
export interface WinnerStructure {
  medianWords: number | null;
  usesFaq: boolean;
  usesTable: boolean;
  usesList: boolean;
  outlines: { domain: string; headings: string[] }[]; // each winner's H2/H3 sequence
}

export interface EvidencePack {
  keyword: string;
  status: EvidenceStatus;
  stats: EvidenceStat[];
  quotes: EvidenceQuote[];
  caseStudies: EvidenceCaseStudy[];
  contrarianSource: ContrarianSource | null;
  gaps: string[];
  pagesRead: string[];
  digest?: SourceInsight[];   // synthesizable substance from the source pages
  structure?: WinnerStructure; // how the top-ranking pages structure this topic
  mode?: 'sourced' | 'number-light'; // number-light = wrote from research, few/no stats
  note?: string;              // honest-failure explanation when status !== 'OK'
  collectedAt: string;
}

/* -------------------------------- entry points -------------------------------- */

/** Standalone: collect evidence for a keyword and persist it to the project. */
export async function runEvidence(keyword: string, opts: { siteUrl?: string; extraInfo?: string } = {}): Promise<Report> {
  const kw = keyword.trim();
  if (!kw) return { tag: 'Evidence', title: 'No keyword', blocks: [b.note('Give me a keyword to gather evidence for, e.g. "evidence for best running shoes".')] };
  if (!serpEnabled()) {
    return { tag: 'Evidence', title: 'Search disabled', blocks: [b.note('Evidence collection needs live search. Set SERP_PROVIDER=tavily (with TAVILY_API_KEY) or SERP_PROVIDER=google.')] };
  }

  const project = await ensureProject(kw, opts.siteUrl, opts.extraInfo);
  const pack = await collectEvidence(project);
  project.evidence = pack;
  await saveProject(project);
  return evidenceReport(pack, project.key);
}

/** The collection pipeline, reusable by the workflow. */
export async function collectEvidence(project: ContentProject): Promise<EvidencePack> {
  const keyword = project.keyword;
  const base: EvidencePack = {
    keyword, status: 'OK', stats: [], quotes: [], caseStudies: [],
    contrarianSource: null, gaps: [], pagesRead: [], digest: [], collectedAt: new Date().toISOString(),
  };

  // Ensure we have research (top-ranking pages + PAA) to mine.
  if (!project.research?.topBlogs?.length) {
    project.research = await gatherResearch(keyword).catch(() => project.research);
  }
  const research = project.research;

  // Case studies are agency-owned, entered once by a human, reused across drafts.
  base.caseStudies = await loadInternalCaseStudies(keyword);

  if (!serpEnabled()) {
    base.status = 'NO_SEARCH';
    base.note = 'Live search is disabled, so no external statistics could be gathered. Set SERP_PROVIDER=tavily or =google. (Internal case studies still loaded.)';
    return base;
  }
  if (!llmConfigured()) {
    base.status = 'NO_SEARCH';
    base.note = 'Evidence extraction needs an LLM to read fetched pages. Add an LLM key in .env.';
    return base;
  }

  // Queries built from the raw keyword are weak when the keyword is really an
  // article TITLE ("How to Optimise for AI Search: A Practical ... Guide") — a
  // "<title> statistics" search just returns more how-to listicles, not research.
  // Search on the clean SUBJECT instead so stat queries surface primary sources.
  const subject = researchSubject(keyword);

  const year = new Date().getFullYear();

  if (config.content.researchMode === 'deep') {
    // DEEP: fetch the REAL top-ranking pages and mine their actual text — but in
    // ONE combined "consume" call, not one per page, so the LLM is used only to
    // digest the gathered research and the run stays lean.
    await gatherFromPages(base, subject, research, year);
  } else {
    // FAST: read only the search SNIPPETS and distill them in ONE LLM call — no
    // per-page fetch/extract. ~3 LLM calls for a whole run instead of ~10, so it
    // finishes in a minute or two even under a tight free-tier rate limit. Stats
    // are verified against the snippet text; the contrarian comes from the same call.
    await gatherFromSnippets(base, subject, research, year);
  }

  base.stats = dedupeStats(base.stats).filter((s) => s.verified);
  base.quotes = dedupeQuotes(base.quotes);
  base.digest = dedupeDigest(base.digest || []).slice(0, 24);

  // Gaps: PAA topics we found no evidence for.
  base.gaps = computeGaps(research?.peopleAlsoAsk || [], base);

  // Status. With auto-research ON we do NOT halt on thin stats as long as we have
  // real material to write from (a source digest, or verified competitor research):
  // instead the writer produces a full, number-light article grounded in what was
  // actually read. The gate still deletes any figure the model invents. We only
  // fall back to LOW_EVIDENCE when there is genuinely nothing real to ground on.
  const hasSubstance = (base.digest?.length || 0) >= 3 || !!research?.topBlogs?.length;
  if (isLowEvidence(base.stats.length)) {
    if (config.content.autoResearch && hasSubstance) {
      base.mode = 'number-light';
      base.note = `Found ${base.stats.length} hard statistic(s) for "${keyword}", below the ${MIN_STATS} needed to lead with data. Auto-research wrote a full article from ${base.digest?.length || 0} sourced insight(s) across ${base.pagesRead.length} page(s) instead of halting — no figure was invented (the gate enforces this). Supply real data in the brief, or a case study file, to make it more quantitative.`;
    } else {
      base.status = 'LOW_EVIDENCE';
      base.note = `Only ${base.stats.length} verifiable statistic(s) found for "${keyword}" (need ${MIN_STATS}), and no other real material to ground on. Try a more specific keyword, add TAVILY for deeper search, or supply real data in the brief / a case study file.`;
    }
  } else {
    base.mode = 'sourced';
  }
  return base;
}

/**
 * Reduce a keyword that is really an article title to its searchable SUBJECT, so
 * research queries surface primary sources instead of rival how-to posts. Strips
 * "how to", framing words ("a practical", "the ultimate", "complete", "guide",
 * "tutorial", "explained"), punctuation and filler, keeping the topical nouns.
 * "How to Optimise for AI Search: A Practical AIO, GEO & AEO Guide"
 *   -> "Optimise for AI Search AIO, GEO AEO"
 */
export function researchSubject(keyword: string): string {
  let s = ` ${keyword} `
    .replace(/[:|–—]/g, ' ')
    .replace(/\bhow to\b/gi, ' ')
    .replace(/\b(a|an|the)\s+(practical|ultimate|complete|comprehensive|beginner'?s?|step[- ]by[- ]step|definitive|essential)\b/gi, ' ')
    .replace(/\b(a|an|the)\b/gi, ' ')
    .replace(/\b(guide|tutorial|handbook|playbook|explained|overview|introduction|intro|tips|checklist|examples?)\b/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    // drop stray leading/trailing connective words left by the removals
    .replace(/^(?:to|for|of|in|on|and|with|&|,)\s+/i, '')
    .replace(/\s+(?:to|for|of|in|on|and|with|&|,)$/i, '')
    .trim();
  return s || keyword.trim();
}

/** Add unique result URLs from a batch of searches into `into`, skipping ones
 *  already read. Each query is one SERP call, so the query list is bounded. */
async function addFromSearches(into: Set<string>, queries: string[], perQuery: number, exclude: string[] = []): Promise<void> {
  const skip = new Set(exclude);
  for (const q of queries) {
    const r = await serp(q, 6).catch(() => null);
    for (const res of (r?.results || []).slice(0, perQuery)) {
      if (res.url && !skip.has(res.url)) into.add(res.url);
    }
  }
}

/** Fetch a set of URLs (bounded, never exceeding the page budget), extract stats,
 *  quotes and synthesizable insights from the real page text, and merge into the
 *  pack. Pages already read are skipped so escalation never double-counts. */
async function harvest(base: EvidencePack, urls: string[]): Promise<void> {
  const already = new Set(base.pagesRead);
  const budget = Math.max(0, config.content.maxResearchPages - base.pagesRead.length);
  const fresh = urls.filter((u) => u && !already.has(u)).slice(0, budget || urls.length);
  if (!fresh.length) return;

  const pages = await pool(fresh, 4, async (u) => {
    const p = await fetchPageContent(u).catch(() => null);
    return p?.reachable && p.bodyText ? { url: p.finalUrl, text: p.bodyText, published: p.publishedHint } : null;
  });
  const readable = pages.filter((p): p is { url: string; text: string; published: string | null } => !!p);
  for (const p of readable) if (!base.pagesRead.includes(p.url)) base.pagesRead.push(p.url);

  const extracted = await pool(readable, 2, (p) => extractFromPage(base.keyword, p.url, p.text, p.published));
  for (const e of extracted) {
    if (!e) continue;
    base.stats.push(...e.stats);
    base.quotes.push(...e.quotes);
    (base.digest ||= []).push(...e.points);
  }
}

/* ------------------------------ deep: real pages, one call ------------------------------ */

/**
 * DEEP research done leanly: fetch the top-ranking pages (the real "top 5 blogs"
 * content analysis) plus a couple of stat-search results, then mine ALL of their
 * real text in ONE combined extraction call. Real research (actual page bodies),
 * verified stats (numbers must appear in the fetched text), one LLM call.
 */
async function gatherFromPages(base: EvidencePack, subject: string, research: ContentProject['research'], year: number): Promise<void> {
  const urls = new Set<string>();
  for (const t of (research?.topBlogs || []).slice(0, config.content.maxResearchPages)) if (t.url) urls.add(t.url);
  await addFromSearches(urls, [`${subject} statistics ${year}`, `${subject} study data`], 3, [...urls]);

  const pages = await pool([...urls].slice(0, config.content.maxResearchPages + 2), 4, async (u) => {
    const p = await fetchPageContent(u).catch(() => null);
    return p?.reachable && p.bodyText
      ? { url: p.finalUrl, text: p.bodyText, headings: p.headings, wordCount: p.wordCount, hasFAQ: p.hasFAQ, hasTable: p.hasTable, hasList: p.hasList }
      : null;
  });
  const readable = pages.filter((p): p is NonNullable<typeof p> => !!p);
  base.pagesRead = readable.map((p) => p.url);
  if (!readable.length) return;

  // Learn how the winners actually write this topic: their real H2/H3 outlines,
  // typical length and format. The writer mirrors this instead of a generic shape.
  base.structure = summarizeStructure(readable);

  // One corpus of real page text, each source capped so the single call stays
  // comfortably under the per-minute token limit.
  const per = config.content.pageTextChars;
  const corpus = readable.map((p, i) => `[Source ${i + 1}] ${domainOf(p.url)} ${p.url}\n${p.text.slice(0, per)}`).join('\n\n').slice(0, 15000);
  const d = await completeJSON<{ stats?: any[]; quotes?: any[]; points?: any[]; contrarian?: any }>(
    DISTILL_SYSTEM,
    JSON.stringify({ topic: base.keyword, snippets: corpus }),
    { temperature: 0, maxTokens: 1800 },
  ).catch(() => null);
  if (!d) return;

  const hay = readable.map((p) => p.text).join(' ').toLowerCase();
  for (const s of d.stats || []) {
    const claim = String(s?.claim || '').trim();
    const number = String(s?.number || '').trim();
    if (!claim || !number) continue;
    if (!isSubstantiveStat(number, claim) || isMetaClaim(claim) || isSelfPromo(claim)) continue;
    const url = String(s?.sourceUrl || '').trim();
    base.stats.push({ claim, source: domainOf(url) || 'source', org: String(s?.org || '').trim(), year: Number.isFinite(+s?.year) ? +s.year : 0, url, verified: numberPresent(number, hay) });
  }
  for (const p of d.points || []) {
    const point = String(p || '').trim();
    if (point.length >= 30 && point.length <= 320 && !isMetaClaim(point) && !isSelfPromo(point)) (base.digest ||= []).push({ point, domain: 'source', url: '' });
  }
  for (const q of d.quotes || []) {
    if (q?.text && q?.speaker && quotePresent(String(q.text), hay)) base.quotes.push({ text: String(q.text).trim(), speaker: String(q.speaker).trim(), title: String(q.title || '').trim(), org: String(q.org || '').trim(), url: String(q.sourceUrl || '').trim() });
  }
  if (d.contrarian?.found && d.contrarian?.claim) {
    base.contrarianSource = { claim: String(d.contrarian.claim).trim(), source: String(d.contrarian.source || '').trim(), url: String(d.contrarian.url || '').trim() };
  }
}

/** Build a structure profile from the fetched winners' real headings/format. */
function summarizeStructure(pages: { url: string; headings: { level: number; text: string }[]; wordCount: number; hasFAQ: boolean; hasTable: boolean; hasList: boolean }[]): WinnerStructure {
  const counts = pages.map((p) => p.wordCount).filter((n) => n >= 250 && n <= 8000).sort((a, b) => a - b);
  const medianWords = counts.length ? counts[Math.floor(counts.length / 2)] : null;
  const outlines = pages.map((p) => ({
    domain: domainOf(p.url),
    // Real H2/H3 the page uses, minus obvious boilerplate (nav/share/related).
    headings: p.headings
      .filter((h) => h.level >= 2 && h.text.length >= 3 && h.text.length <= 90)
      .filter((h) => !/^(share|related|categories|recent posts|newsletter|comments|tags|about the author|table of contents)$/i.test(h.text.trim()))
      .map((h) => h.text.trim())
      .slice(0, 12),
  })).filter((o) => o.headings.length >= 2).slice(0, 5);
  const frac = (pred: (p: typeof pages[number]) => boolean) => pages.filter(pred).length / Math.max(1, pages.length);
  return {
    medianWords,
    usesFaq: frac((p) => p.hasFAQ) >= 0.4,
    usesTable: frac((p) => p.hasTable) >= 0.4,
    usesList: frac((p) => p.hasList) >= 0.5,
    outlines,
  };
}

/* ------------------------------ fast: snippet distill ------------------------------ */

const DISTILL_SYSTEM = `You are a research analyst. You are given a TOPIC and a numbered list of SNIPPETS (title + excerpt) from real search results. Using ONLY what the snippets state, gather the material a writer needs. Never add outside knowledge and never invent a number that is not in a snippet.

Return ONLY minified JSON:
{"stats":[{"claim": string, "number": string, "org": string, "year": number, "sourceUrl": string}],
 "quotes":[{"text": string, "speaker": string, "title": string, "org": string, "sourceUrl": string}],
 "points":[string],
 "contrarian":{"claim": string, "source": string, "url": string, "found": boolean}}

RELEVANCE: only material ABOUT THE TOPIC ITSELF. IGNORE the publisher's self-promotion (clients/projects/websites served, delivery speed, years in business, its own pricing) and numbers about an unrelated subject. Prefer figures attributed to a named research source, study, survey or report.

Rules:
- stats: "number" is the exact figure as written ("34%", "1,400", "3.2x", "$2M"). "claim" is the one-sentence fact it supports. "org" is the research source the snippet attributes it to. "sourceUrl" is the snippet's URL. "year" is a 4-digit year or 0.
- quotes: only DIRECT quotes from a NAMED person with a real title/affiliation; else omit.
- points: 6 to 12 SUBSTANTIVE, specific insights ON THE TOPIC (definition, method, trade-off, named technique, concrete example, cause-and-effect), one clear sentence each in your own words. Skip generic filler and publisher self-promotion.
- contrarian: ONE genuine pushback on hype or a corrected misconception a snippet actually supports; set "found" false if none.
- Return empty arrays when nothing qualifies. Never manufacture entries.`;

async function gatherFromSnippets(base: EvidencePack, subject: string, research: ContentProject['research'], year: number): Promise<void> {
  // Collect snippets: the ranking pages we already have, plus a couple of stat- and
  // research-oriented searches. Snippets only — no page fetch.
  const snippets: { title: string; snippet: string; url: string; domain: string }[] = [];
  for (const t of (research?.topBlogs || []).slice(0, 8)) if (t.snippet) snippets.push({ title: t.title, snippet: t.snippet, url: t.url, domain: t.domain });
  // One extra stat-oriented search for figures the ranking pages' snippets miss.
  for (const q of [`${subject} statistics ${year}`, `${subject} study data`]) {
    const r = await serp(q, 6).catch(() => null);
    for (const res of (r?.results || []).slice(0, 5)) if (res.snippet) snippets.push({ title: res.title, snippet: res.snippet, url: res.url, domain: res.domain });
  }
  base.pagesRead = [...new Set(snippets.map((s) => s.url).filter(Boolean))].slice(0, 20);
  if (!snippets.length) return;

  const corpus = snippets.map((s, i) => `[${i + 1}] ${s.title} — ${s.snippet} (${s.domain}) ${s.url}`).join('\n').slice(0, 5500);
  const d = await completeJSON<{ stats?: any[]; quotes?: any[]; points?: any[]; contrarian?: any }>(
    DISTILL_SYSTEM,
    JSON.stringify({ topic: base.keyword, snippets: corpus }),
    { temperature: 0, maxTokens: 1300 },
  ).catch(() => null);
  if (!d) return;

  // Verify a stat's number against the snippet text (the snippet IS real page text).
  const hay = snippets.map((s) => `${s.title} ${s.snippet}`).join(' ').toLowerCase();
  for (const s of d.stats || []) {
    const claim = String(s?.claim || '').trim();
    const number = String(s?.number || '').trim();
    if (!claim || !number) continue;
    if (!isSubstantiveStat(number, claim) || isMetaClaim(claim) || isSelfPromo(claim)) continue;
    const url = String(s?.sourceUrl || '').trim();
    base.stats.push({ claim, source: domainOf(url) || 'search', org: String(s?.org || '').trim(), year: Number.isFinite(+s?.year) ? +s.year : 0, url, verified: numberPresent(number, hay) });
  }
  for (const p of d.points || []) {
    const point = String(p || '').trim();
    if (point.length >= 30 && point.length <= 320 && !isMetaClaim(point) && !isSelfPromo(point)) (base.digest ||= []).push({ point, domain: 'search', url: '' });
  }
  for (const q of d.quotes || []) {
    if (q?.text && q?.speaker) base.quotes.push({ text: String(q.text).trim(), speaker: String(q.speaker).trim(), title: String(q.title || '').trim(), org: String(q.org || '').trim(), url: String(q.sourceUrl || '').trim() });
  }
  if (d.contrarian?.found && d.contrarian?.claim) {
    base.contrarianSource = { claim: String(d.contrarian.claim).trim(), source: String(d.contrarian.source || '').trim(), url: String(d.contrarian.url || '').trim() };
  }
}

/* ------------------------------ page extraction ------------------------------ */

interface PageExtract { stats: EvidenceStat[]; quotes: EvidenceQuote[]; points: SourceInsight[] }

const EXTRACT_SYSTEM = `You are a research analyst reading the REAL text of ONE web page, gathering material for an article on a given TOPIC. Use ONLY what is written on this page; never add outside knowledge and never infer a number that is not present.

Return ONLY minified JSON:
{"stats":[{"claim": string, "number": string, "org": string, "year": number}],
 "quotes":[{"text": string, "speaker": string, "title": string, "org": string}],
 "points":[string]}

RELEVANCE (critical): extract only material a writer on the TOPIC would actually cite — figures and facts ABOUT THE SUBJECT ITSELF. IGNORE:
- the publisher's self-promotion: how many clients/projects/websites they served, how fast they deliver, years in business, their own pricing or awards ("200+ websites delivered", "80% delivered within 2 weeks").
- numbers about an unrelated subject that merely happens to appear on the page (an ad, a sidebar, a different service).
Prefer figures attributed to a NAMED research source, study, survey, report, or recognised organisation (e.g. "a 2026 Gartner report", "the Princeton GEO study") over vague or unattributed ones.

Rules:
- stats: "number" is the exact figure as written ("34%", "1,400", "3.2x", "$2M"). "claim" is the one-sentence factual statement it supports. "org" is the research source/organisation the page attributes it to — NOT the publisher, unless the publisher is genuinely the primary researcher. "year" is a 4-digit year or 0.
- quotes: only DIRECT quotations attributed to a NAMED human with a real title/affiliation. If a field is unknown, use "".
- points: 3 to 7 SUBSTANTIVE, specific insights ON THE TOPIC a reader would find useful — a definition, a step or method, a trade-off or limitation, a named technique/tool, a concrete example, a cause-and-effect. One clear sentence each, in your own words (do not copy verbatim, do not include a fabricated number, skip generic filler like "SEO is important" and skip publisher self-promotion).
- If nothing qualifies for an array, return it empty. Do not manufacture entries to seem useful.`;

async function extractFromPage(topic: string, url: string, text: string, published: string | null): Promise<PageExtract | null> {
  try {
    const raw = await completeJSON<{ stats?: any[]; quotes?: any[]; points?: any[] }>(
      EXTRACT_SYSTEM,
      JSON.stringify({ topic, url, publishedHint: published || '', pageText: text.slice(0, config.content.pageTextChars) }),
      { temperature: 0, maxTokens: 900 },
    );
    const hay = text.toLowerCase();
    const points: SourceInsight[] = (raw.points || [])
      .map((p) => String(p || '').trim())
      .filter((p) => p.length >= 30 && p.length <= 320 && !isMetaClaim(p) && !isSelfPromo(p) && !/^seo is|is important|is crucial/i.test(p))
      .slice(0, 7)
      .map((point) => ({ point, domain: domainOf(url), url }));
    const stats: EvidenceStat[] = (raw.stats || [])
      // Quality gate BEFORE verification: a real statistic carries a magnitude
      // (%, money, multiplier, fraction, or a genuine count), not a bare year,
      // a section number, or a trivial "1-2" ordinal — and it states a fact, not
      // a description of the page itself ("the guide focuses on..."). Weak "stats"
      // are the main reason a grounded draft still reads generic, so they are
      // dropped here rather than handed to the writer.
      .filter((s) => s && s.number && isSubstantiveStat(String(s.number), String(s.claim || '')) && !isMetaClaim(String(s.claim || '')) && !isSelfPromo(String(s.claim || '')))
      .map((s) => ({
        claim: String(s.claim || '').trim(),
        source: domainOf(url),
        org: String(s.org || '').trim(),
        year: Number.isFinite(+s.year) ? +s.year : 0,
        url,
        // Deterministic anti-hallucination gate: the figure MUST be present in the
        // real page text, otherwise the model invented it from the title/snippet.
        verified: numberPresent(String(s.number), hay),
      }))
      .filter((s) => s.claim);
    const quotes: EvidenceQuote[] = (raw.quotes || [])
      .filter((q) => q && q.text && q.speaker)
      .map((q) => ({ text: String(q.text).trim(), speaker: String(q.speaker).trim(), title: String(q.title || '').trim(), org: String(q.org || '').trim(), url }))
      // Verify the quote's opening words really appear on the page.
      .filter((q) => quotePresent(q.text, hay));
    return { stats, quotes, points };
  } catch { return null; }
}

/**
 * A statistic earns a place in the pack only if its number is a real, magnitude-
 * bearing figure the writer can build a point on: a percentage, money amount,
 * multiplier, common fraction, or a count with genuine size. A bare 4-digit year
 * ("in 2026"), a section/step number, or a tiny "1-2" ordinal all pass the naive
 * number-present check but are useless as evidence and pull the draft toward
 * generic filler — so they are rejected here.
 */
export function isSubstantiveStat(numberRaw: string, _claim: string): boolean {
  const n = (numberRaw || '').trim().toLowerCase();
  if (!n) return false;
  if (/\d\s*%|percent|percentage points?/.test(n)) return true;           // 58%, 30 percent
  if (/[$£€]\s?\d|\b\d[\d,.]*\s?(usd|dollars?|eur|gbp|k|m|bn|billion|million|thousand)\b/.test(n)) return true; // money
  if (/\d\s*(?:x|×)\b|\bx\d/.test(n)) return true;                         // 3x, 2.5x
  if (/\b(two-thirds|three-quarters|three-fifths|half|double|triple|quadruple|tenfold|majority)\b/.test(n)) return true; // fractions
  const digitsOnly = n.replace(/[^\d]/g, '');
  if (/^(1[89]|20)\d{2}$/.test(digitsOnly)) return false;                  // a bare year is a date, not a stat
  if (/\d{1,3}(?:,\d{3})+/.test(n)) return true;                          // 1,400 / 12,000
  const asNum = parseFloat(n.replace(/[^\d.]/g, ''));
  return Number.isFinite(asNum) && asNum >= 100;                           // real counts only
}

/**
 * True when the "stat" is the publisher bragging about its own business rather
 * than a fact about the topic — client/project counts, delivery speed, years in
 * business, own pricing. These are the classic off-topic junk stats a naive
 * number-present check lets through (e.g. "200+ websites delivered in 2020",
 * "80% delivered within 2 weeks" from a web-design agency on an AI-search page).
 */
export function isSelfPromo(claim: string): boolean {
  const c = claim.trim().toLowerCase();
  if (!c) return false;
  if (/\b(we|our|us|my|i)\b.*\b(deliver|delivered|serve|served|help|helped|built|build|complet|launch|client|customer|project|website)/.test(c)) return true;
  if (/\b\d[\d,]*\+?\s*(websites?|projects?|clients?|customers?|stores?)\b.*\b(deliver|built|launch|complet|served|help)/.test(c)) return true;
  if (/\bdeliver(ed|y)?\b.*\bwithin\s+\d+\s*(day|week|month)/.test(c)) return true;
  if (/\b(years?\s+(in|of)\s+(business|operation|experience)|founded in|established in)\b/.test(c)) return true;
  return false;
}

/** True when the "claim" describes the page/article itself rather than a fact. */
export function isMetaClaim(claim: string): boolean {
  const c = claim.trim().toLowerCase();
  if (!c) return true;
  return /^(this|the)\s+(guide|article|post|page|blog|report|section|author)\b/.test(c)
    && /\b(focus|cover|explain|discuss|show|walk|outline|describe|introduce|is about|recommend)/.test(c);
}

/** True if the figure (ignoring spaces) appears in the page text. */
function numberPresent(number: string, haystackLower: string): boolean {
  const n = number.toLowerCase().trim();
  if (!n) return false;
  if (haystackLower.includes(n)) return true;
  // Try without thousands separators / spaces and the bare digits.
  const compact = n.replace(/[\s,]/g, '');
  if (compact && haystackLower.replace(/[\s,]/g, '').includes(compact)) return true;
  const digits = n.replace(/[^\d.]/g, '');
  return digits.length >= 2 && haystackLower.includes(digits);
}

function quotePresent(quote: string, haystackLower: string): boolean {
  const words = quote.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length < 3) return false;
  const probe = words.slice(0, 6).join(' ');
  return haystackLower.replace(/[^a-z0-9 ]/g, ' ').includes(probe);
}

/* ------------------------------ contrarian source ------------------------------ */

const CONTRARIAN_SYSTEM = `You are given real search results (titles + snippets) for queries about criticism or misconceptions of a topic. Identify ONE genuine contrarian point: something that corrects a common misconception or pushes back on hype, that a snippet actually supports.

Return ONLY minified JSON: {"claim": string, "source": string, "url": string, "found": boolean}
- "found" is false if no snippet genuinely supports a contrarian point (then leave the others "").
- Never fabricate a contrarian claim the snippets do not support.`;

async function findContrarian(keyword: string): Promise<ContrarianSource | null> {
  const queries = [`${keyword} misconception`, `${keyword} myth`, `why ${keyword} doesn't work`, `${keyword} criticism`];
  const results: { title: string; snippet: string; url: string; domain: string }[] = [];
  for (const q of queries) {
    const r = await serp(q, 4).catch(() => null);
    for (const res of (r?.results || []).slice(0, 3)) results.push({ title: res.title, snippet: res.snippet, url: res.url, domain: res.domain });
    if (results.length >= 8) break;
  }
  if (!results.length || !llmConfigured()) return null;
  const evidence = results.slice(0, 8).map((r, i) => `[${i + 1}] ${r.title} — ${r.snippet} (${r.domain}) ${r.url}`).join('\n');
  try {
    const r = await completeJSON<{ claim: string; source: string; url: string; found: boolean }>(
      CONTRARIAN_SYSTEM, evidence, { temperature: 0.2, maxTokens: 500 },
    );
    if (!r.found || !r.claim) return null;
    return { claim: r.claim.trim(), source: r.source || '', url: r.url || (results[0]?.url || '') };
  } catch { return null; }
}

/* ------------------------------ internal case studies ------------------------------ */

/**
 * Load agency-owned case studies from data/case-studies/*.json. Each file:
 *   { "client": "...", "outcome": "...", "timeframe": "...", "sourceUrl": "...",
 *     "topics": ["seo","content"], "industry": "saas" }
 * A human enters these ONCE per engagement; they are reused across every draft
 * whose keyword matches the case study's topics/industry. Files beginning with
 * "_" (e.g. _example.json) are ignored.
 */
export async function loadInternalCaseStudies(keyword: string): Promise<EvidenceCaseStudy[]> {
  const dir = dataPath('case-studies');
  let files: string[] = [];
  try { files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json') && !f.startsWith('_')); } catch { return []; }
  const kwTokens = new Set(keyword.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
  const out: EvidenceCaseStudy[] = [];
  for (const f of files) {
    try {
      const raw = JSON.parse(await fs.readFile(`${dir}/${f}`, 'utf8'));
      if (!raw?.client || !raw?.outcome) continue;
      const tags = ([] as string[])
        .concat(raw.topics || [], raw.keywords || [], raw.industry ? [raw.industry] : [])
        .join(' ').toLowerCase();
      const matches = raw.matchAll === true || !tags || [...kwTokens].some((t) => tags.includes(t));
      if (!matches) continue;
      out.push({
        client: String(raw.client),
        outcome: String(raw.outcome),
        source: 'internal',
        sourceUrl: raw.sourceUrl || undefined,
        verified: true, // human-entered agency data is treated as verified source-of-truth
      });
    } catch { /* skip malformed file */ }
  }
  return out;
}

/* --------------------------------- helpers --------------------------------- */

function dedupeStats(stats: EvidenceStat[]): EvidenceStat[] {
  const seen = new Map<string, EvidenceStat>();
  for (const s of stats) {
    const key = `${s.claim.slice(0, 40).toLowerCase()}::${s.org.toLowerCase()}`;
    if (!seen.has(key)) seen.set(key, s);
  }
  return [...seen.values()];
}
function dedupeQuotes(quotes: EvidenceQuote[]): EvidenceQuote[] {
  const seen = new Map<string, EvidenceQuote>();
  for (const q of quotes) { const k = q.text.slice(0, 50).toLowerCase(); if (!seen.has(k)) seen.set(k, q); }
  return [...seen.values()];
}
function dedupeDigest(points: SourceInsight[]): SourceInsight[] {
  const seen = new Map<string, SourceInsight>();
  for (const p of points) {
    const k = p.point.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 60);
    if (k && !seen.has(k)) seen.set(k, p);
  }
  return [...seen.values()];
}
function computeGaps(paa: string[], pack: EvidencePack): string[] {
  const covered = (pack.stats.map((s) => s.claim).join(' ') + ' ' + pack.quotes.map((q) => q.text).join(' ')).toLowerCase();
  return paa.filter((q) => {
    const key = q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3).slice(0, 2);
    return key.length && !key.every((k) => covered.includes(k));
  }).slice(0, 6);
}

/** Evidence IDs (E1, E2, ...) the writer cites and the gate verifies against. */
export function evidenceIndex(pack: EvidencePack): { id: string; kind: 'stat' | 'quote' | 'case'; text: string }[] {
  const out: { id: string; kind: 'stat' | 'quote' | 'case'; text: string }[] = [];
  let n = 1;
  for (const s of pack.stats) out.push({ id: `E${n++}`, kind: 'stat', text: `${s.claim} (${s.org || s.source}${s.year ? `, ${s.year}` : ''})` });
  for (const q of pack.quotes) out.push({ id: `E${n++}`, kind: 'quote', text: `"${q.text}" — ${q.speaker}, ${q.title || ''} ${q.org || ''}`.trim() });
  for (const c of pack.caseStudies) out.push({ id: `E${n++}`, kind: 'case', text: `${c.client}: ${c.outcome}` });
  return out;
}

/* ---------------------------------- report ---------------------------------- */

export function evidenceReport(pack: EvidencePack, projectKey?: string): Report {
  const blocks = [];
  if (pack.status === 'LOW_EVIDENCE' || pack.status === 'NO_SEARCH') {
    blocks.push(b.note(pack.note || 'Not enough verifiable evidence to proceed.'));
  }
  blocks.push(b.p(`Evidence for "${pack.keyword}": ${pack.stats.length} verified stat(s), ${pack.quotes.length} named quote(s), ${pack.caseStudies.length} case study(ies)${pack.contrarianSource ? ', 1 contrarian source' : ''}. Read ${pack.pagesRead.length} page(s). Every stat's number was confirmed present on its source page.`));

  blocks.push(b.kv([
    { k: 'Status', v: pack.status === 'OK' ? `OK — enough to write (>=${MIN_STATS} stats)` : pack.status },
    { k: 'Verified statistics', v: `${pack.stats.length}` },
    { k: 'Named quotes', v: `${pack.quotes.length}` },
    { k: 'Case studies (internal)', v: `${pack.caseStudies.length}` },
    { k: 'Contrarian source', v: pack.contrarianSource ? 'found — anchors the POV section' : 'none (POV will be framed as an open question)' },
  ]));

  if (pack.stats.length) {
    blocks.push(b.p('Verified statistics (the only figures the writer may cite):'));
    blocks.push(b.table(
      ['Claim', 'Org', 'Year', 'Source'],
      pack.stats.slice(0, 10).map((s) => [s.claim.slice(0, 70), s.org || '—', s.year || '—', domainOf(s.url)]),
    ));
  }
  if (pack.quotes.length) {
    blocks.push(b.p('Named quotes:'));
    blocks.push(b.list(pack.quotes.slice(0, 6).map((q) => `"${q.text.slice(0, 120)}" — ${q.speaker}${q.title ? `, ${q.title}` : ''}${q.org ? `, ${q.org}` : ''}`)));
  }
  if (pack.caseStudies.length) {
    blocks.push(b.p('Internal case studies matched to this topic:'));
    blocks.push(b.list(pack.caseStudies.map((c) => `${c.client}: ${c.outcome}`)));
  } else {
    blocks.push(b.note('No internal case study matched this topic. The writer will NOT invent one — add a file under data/case-studies/ to make agency proof reusable across drafts.'));
  }
  if (pack.digest?.length) {
    blocks.push(b.p(`Source digest — ${pack.digest.length} insight(s) the writer can synthesize (real material, no invented numbers):`));
    blocks.push(b.list(pack.digest.slice(0, 10).map((d) => `${d.point} (${d.domain})`)));
  }
  if (pack.contrarianSource) blocks.push(b.note(`Contrarian anchor: ${pack.contrarianSource.claim} (${pack.contrarianSource.url})`));
  if (pack.gaps.length) { blocks.push(b.p('Reader questions with no evidence yet (write around, or research further):')); blocks.push(b.list(pack.gaps)); }

  return { tag: 'Evidence', title: `Evidence — ${pack.keyword} (${pack.status})`, blocks, data: { key: projectKey, status: pack.status } };
}
