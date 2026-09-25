import * as cheerio from 'cheerio';
import { config } from '../config';
import { serp, serpEnabled, serpErrorNote, SerpResult } from '../sources/serp';
import { requestOnce, getJSON, timedFetch } from '../lib/http';
import { pool } from '../lib/concurrency';
import { completeJSON, llmConfigured } from '../llm';
import { seoptimerEnabled, seoptimerReport, checksBySection, SeoptimerKeywordRank } from '../sources/seoptimer';
import { Report, b } from '../lib/report';

interface SeoptimerGeo {
  grade: string;
  title: string;
  checks: { title: string; passed: boolean | null; shortAnswer: string; recommendation: string }[];
  aiRankings: SeoptimerKeywordRank[];
  aiTraffic: number | null;
}

/**
 * AI Overview Content Gap.
 * Ported from the user's `ai_SEO_agent`: find the pages Google's AI Overview
 * cites for a keyword, scrape their structural signals, compare to the client
 * article, and (only for the write-up) have the LLM synthesise gaps + fixes.
 *
 * Real data: SERP (AI Overview sources) + live page scraping. The LLM never
 * invents metrics — every number below is measured from a real page.
 */

interface Signals {
  url: string;
  ok: boolean;
  wordCount: number;
  h1: number;
  h2: number;
  h3: number;
  hasFaq: boolean;
  hasTable: boolean;
  hasNumberedList: boolean;
  hasBulletList: boolean;
  hasCalculator: boolean;
  hasComparison: boolean;
  headings: string[];
  textSample: string;
}

export interface AioData {
  keyword: string;
  clientUrl: string | null;
  mode: 'serpapi' | 'serper' | 'organic' | 'browser';
  hasAiOverview: boolean;
  sources: string[];
  rankings: { top10: SerpResult[]; clientPosition: number | null };
  client: Signals | null;
  competitors: Signals[];
  comparison: {
    clientWordCount: number;
    avgCompetitorWordCount: number;
    competitorsWithFaq: number;
    competitorsWithTable: number;
    competitorsWithNumberedList: number;
    total: number;
  };
  contentGaps: { gap: string; detail: string }[];
  recommendations: { title: string; detail: string }[];
  executiveSummary: string;
  seoptimerGeo?: SeoptimerGeo;
}

const URL_RE = /\b((?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})(\/[^\s]*)?/i;

export async function runAioverview(input: { text: string; clientUrl?: string; country?: string }): Promise<Report> {
  const raw = (input.text || '').trim();
  // Split the request into a client URL + a keyword.
  let clientUrl = (input.clientUrl || '').trim();
  const m = raw.match(URL_RE);
  if (!clientUrl && m) clientUrl = m[0];
  let keyword = raw;
  if (m) keyword = keyword.replace(m[0], ' ');
  keyword = keyword
    .replace(/\b(ai overviews?|ai snapshot|google ai overview|aio|sge|content gaps?|gaps?|gap analysis|for|vs\.?|versus|against|client|my (article|page|url)|compare)\b/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (!keyword && !clientUrl) throw new Error('Give me a keyword, e.g. “AI overview gap for best crm software vs https://yoursite.com/crm”.');
  if (clientUrl && !/^https?:\/\//i.test(clientUrl)) clientUrl = 'https://' + clientUrl;

  // Real GEO / AI-readiness audit of the client page (SEOptimer, page-level).
  const seoptimerGeo = clientUrl && seoptimerEnabled() ? await seoptimerGeoAudit(clientUrl) : undefined;

  // Without a live SERP we can't find AI-Overview-cited pages — but if we have a
  // real GEO audit for the client page, that's still worth returning.
  if (!serpEnabled()) {
    if (seoptimerGeo) return geoOnlyReport(keyword, clientUrl, seoptimerGeo);
    return { tag: 'AI Overview Gap', title: 'SERP disabled', blocks: [b.note('Set SERP_PROVIDER (serpapi/serper give real AI Overview sources; the free scraper falls back to top organic). Add SEOPTIMER_API_KEY + a client URL for a real GEO audit.')] };
  }
  if (!keyword) {
    if (seoptimerGeo) return geoOnlyReport(keyword, clientUrl, seoptimerGeo);
    throw new Error('Give me a keyword, e.g. “AI overview gap for best crm software vs https://yoursite.com/crm”.');
  }

  // 1) AI Overview sources + organic rankings
  const src = await aiOverviewSources(keyword, input.country || 'us');
  if (src.error && !src.sources.length) {
    if (seoptimerGeo) return geoOnlyReport(keyword, clientUrl, seoptimerGeo, src.error);
    return {
      tag: 'AI Overview Gap', title: `AI Overview gap — “${keyword}”`,
      blocks: [
        b.p(`I couldn't fetch the SERP / AI Overview for “${keyword}”, so there's nothing real to compare against.`),
        b.note(src.error),
      ],
    };
  }

  // 2) scrape sources + client article for structural signals
  const compUrls = src.sources.slice(0, 6);
  const competitors = (await pool(compUrls, 4, (u) => extractSignals(u))).filter((s) => s.ok);
  const client = clientUrl ? await extractSignals(clientUrl) : null;

  // 3) comparison matrix (deterministic)
  const total = competitors.length || 1;
  const avgWc = Math.round(competitors.reduce((s, c) => s + c.wordCount, 0) / total);
  const comparison = {
    clientWordCount: client?.wordCount || 0,
    avgCompetitorWordCount: avgWc,
    competitorsWithFaq: competitors.filter((c) => c.hasFaq).length,
    competitorsWithTable: competitors.filter((c) => c.hasTable).length,
    competitorsWithNumberedList: competitors.filter((c) => c.hasNumberedList).length,
    total: competitors.length,
  };

  // client ranking position (from organic)
  let clientPosition: number | null = null;
  if (clientUrl) {
    const cd = domainOf(clientUrl);
    const hit = src.organic.find((r) => r.url === clientUrl || r.domain === cd);
    clientPosition = hit ? hit.position : null;
  }

  // 4) LLM synthesis — ONLY the gap write-up, over real measured signals
  let contentGaps: AioData['contentGaps'] = [];
  let recommendations: AioData['recommendations'] = [];
  let executiveSummary = '';
  if (llmConfigured() && competitors.length) {
    try {
      const synth = await synthesize(keyword, client, competitors, comparison);
      contentGaps = synth.contentGaps;
      recommendations = synth.recommendations;
      executiveSummary = synth.executiveSummary;
    } catch { /* report still renders with measured data */ }
  }

  const data: AioData = {
    keyword,
    clientUrl: clientUrl || null,
    mode: src.mode,
    hasAiOverview: src.hasAiOverview,
    sources: src.sources,
    rankings: { top10: src.organic.slice(0, 10), clientPosition },
    client,
    competitors,
    comparison,
    contentGaps,
    recommendations,
    executiveSummary,
    seoptimerGeo,
  };

  return toReport(data);
}

/* ------------------------------------------------------------------ */
/* SEOptimer GEO / AI-readiness audit (real, page-level)               */
/* ------------------------------------------------------------------ */
async function seoptimerGeoAudit(url: string): Promise<SeoptimerGeo | undefined> {
  const so = await seoptimerReport(url);
  if (!so.ok) return undefined;
  return {
    grade: so.scores.geo?.grade || '—',
    title: so.scores.geo?.title || '',
    checks: checksBySection(so, 'geo').map((c) => ({
      title: c.title, passed: c.passed, shortAnswer: c.shortAnswer, recommendation: c.recommendation,
    })),
    aiRankings: so.aiOverviewRankings,
    aiTraffic: so.trafficFromSearch?.ai ?? null,
  };
}

function geoBlocks(geo: SeoptimerGeo) {
  const blocks = [
    b.p(`SEOptimer GEO / AI-readiness for the client page — grade ${geo.grade}${geo.title ? ` (${geo.title})` : ''}:`),
  ];
  if (geo.checks.length) {
    blocks.push(b.table(
      ['GEO check', 'Status', 'Finding'],
      geo.checks.map((c) => [c.title, c.passed ? '✓' : '✗', c.shortAnswer || (c.recommendation || '—')]),
    ));
  }
  if (geo.aiRankings.length) {
    blocks.push(b.p('Keywords where this domain already appears in Google AI Overviews (SEOptimer):'));
    blocks.push(b.table(
      ['Keyword', 'Country', 'Position', 'Searches'],
      geo.aiRankings.slice(0, 8).map((r) => [r.keyword, r.country || '—', r.position || '—', r.totalSearches ?? '—']),
    ));
  }
  if (geo.aiTraffic != null) {
    blocks.push(b.kv([{ k: 'Est. AI/LLM search traffic', v: geo.aiTraffic.toLocaleString('en-US') }]));
  }
  return blocks;
}

function geoOnlyReport(keyword: string, clientUrl: string, geo: SeoptimerGeo, serpErr?: string): Report {
  const blocks = [];
  if (serpErr) blocks.push(b.p(`Live AI-Overview sources were unavailable (${serpErr}). Here's a real GEO audit of your page instead:`));
  else blocks.push(b.p('Returning a real GEO / AI-readiness audit of your page:'));
  blocks.push(...geoBlocks(geo));
  blocks.push(b.note('Add a SERP source (SERP_PROVIDER=serpapi or SERPER_API_KEY) with a keyword to also compare against the pages Google’s AI Overview cites.'));
  return { tag: 'AI Overview Gap', title: keyword ? `AI Overview / GEO — “${keyword}”` : 'GEO / AI-readiness audit', blocks, data: { clientUrl, seoptimerGeo: geo } };
}

/* ------------------------------------------------------------------ */
/* AI Overview source discovery                                        */
/* ------------------------------------------------------------------ */
async function aiOverviewSources(keyword: string, country: string): Promise<{
  sources: string[]; organic: SerpResult[]; mode: AioData['mode']; hasAiOverview: boolean; error?: string;
}> {
  const serperKey = process.env.SERPER_API_KEY || '';

  // SerpApi — reads the real ai_overview.sources block
  if (config.serp.provider === 'serpapi' && config.serp.apiKey) {
    const url = `https://serpapi.com/search.json?engine=google&num=10&gl=${encodeURIComponent(country)}&hl=en&q=${encodeURIComponent(keyword)}&api_key=${config.serp.apiKey}`;
    const d = await getJSON<any>(url, {}, 20000);
    const organic = mapOrganic((d.organic_results || []).map((r: any) => ({ position: r.position, link: r.link, title: r.title, snippet: r.snippet })));
    const aio = (d.ai_overview?.sources || []).map((s: any) => s.link).filter(Boolean) as string[];
    if (aio.length) return { sources: aio, organic, mode: 'serpapi', hasAiOverview: true };
    return { sources: organic.slice(0, 5).map((r) => r.url), organic, mode: 'serpapi', hasAiOverview: false };
  }

  // Serper.dev — reads answerBox.references (its AI Overview proxy)
  if (serperKey) {
    const res = await timedFetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': serperKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: keyword, gl: country, num: 10 }),
    }, 20000);
    const d: any = await res.json();
    const organic = mapOrganic((d.organic || []).map((r: any) => ({ position: r.position, link: r.link, title: r.title, snippet: r.snippet })));
    const refs = (d.answerBox?.references || []).map((r: any) => r.link).filter(Boolean) as string[];
    if (refs.length) return { sources: refs, organic, mode: 'serper', hasAiOverview: true };
    return { sources: organic.slice(0, 5).map((r) => r.url), organic, mode: 'serper', hasAiOverview: false };
  }

  // Default: the configured provider (free Google browser, or DuckDuckGo scrape).
  const s = await serp(keyword, 10);
  const err = serpErrorNote(s);
  if (err) return { sources: [], organic: [], mode: 'browser', hasAiOverview: false, error: err };
  const ai = s.aiOverviewSources || [];
  if (ai.length) return { sources: ai, organic: s.results, mode: 'browser', hasAiOverview: true };
  return { sources: s.results.slice(0, 5).map((r) => r.url), organic: s.results, mode: 'browser', hasAiOverview: false };
}

function mapOrganic(items: { position?: number; link?: string; title?: string; snippet?: string }[]): SerpResult[] {
  return items
    .filter((r) => r.link)
    .map((r, i) => ({ position: r.position || i + 1, title: r.title || '', url: r.link!, domain: domainOf(r.link!), snippet: r.snippet || '' }));
}

/* ------------------------------------------------------------------ */
/* Structural signal extraction (deterministic)                        */
/* ------------------------------------------------------------------ */
async function extractSignals(url: string): Promise<Signals> {
  const empty: Signals = {
    url, ok: false, wordCount: 0, h1: 0, h2: 0, h3: 0,
    hasFaq: false, hasTable: false, hasNumberedList: false, hasBulletList: false,
    hasCalculator: false, hasComparison: false, headings: [], textSample: '',
  };
  try {
    const res = await requestOnce(url);
    if (!res.body || res.status >= 400) return empty;
    const $ = cheerio.load(res.body);
    $('script, style, noscript, template, svg, nav, header, footer').remove();

    const headings: string[] = [];
    $('h1, h2, h3').each((_, el) => {
      const t = $(el).text().replace(/\s+/g, ' ').trim();
      if (t) headings.push(t);
    });
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
    const low = bodyText.toLowerCase();
    const headingClassText = ($('[class]').map((_, el) => $(el).attr('class') || '').get().join(' ') + ' ' + headings.join(' ')).toLowerCase();

    return {
      url,
      ok: true,
      wordCount: bodyText ? bodyText.split(/\s+/).length : 0,
      h1: $('h1').length,
      h2: $('h2').length,
      h3: $('h3').length,
      hasFaq: /faq|frequently asked/.test(headingClassText) || $('script[type="application/ld+json"]:contains("FAQPage")').length > 0,
      hasTable: $('table').length > 0,
      hasNumberedList: $('ol').length > 0,
      hasBulletList: $('ul').length > 0,
      hasCalculator: /\b(calculator|calculate|compute)\b/.test(low),
      hasComparison: /\b(vs|versus|compare|comparison)\b/.test(low),
      headings: headings.slice(0, 25),
      textSample: bodyText.slice(0, 800),
    };
  } catch {
    return empty;
  }
}

/* ------------------------------------------------------------------ */
/* LLM synthesis (write-up only)                                       */
/* ------------------------------------------------------------------ */
async function synthesize(keyword: string, client: Signals | null, competitors: Signals[], cmp: AioData['comparison']) {
  const system =
    'You are an SEO strategist analysing why Google’s AI Overview cites certain pages. You are given REAL measured signals ' +
    'from those cited pages and (optionally) the client article. Identify SPECIFIC content gaps — topics or formats the client ' +
    'lacks versus the cited pages — and 3-5 CONCRETE, actionable recommendations. Do not invent statistics; reason only from the ' +
    'signals and headings provided. Return JSON: {"executiveSummary":string,"contentGaps":[{"gap":string,"detail":string}],' +
    '"recommendations":[{"title":string,"detail":string}]}.';
  const user = JSON.stringify({
    keyword,
    comparison: cmp,
    client: client ? { wordCount: client.wordCount, headings: client.headings.slice(0, 20), hasFaq: client.hasFaq, hasTable: client.hasTable, hasNumberedList: client.hasNumberedList } : 'NO CLIENT ARTICLE PROVIDED',
    citedPages: competitors.map((c) => ({
      url: c.url, wordCount: c.wordCount, headings: c.headings.slice(0, 15),
      hasFaq: c.hasFaq, hasTable: c.hasTable, hasNumberedList: c.hasNumberedList, hasComparison: c.hasComparison,
      sample: c.textSample.slice(0, 500),
    })),
  });
  const p = await completeJSON<any>(system, user, { temperature: 0.3 });
  const arr = (x: any) => (Array.isArray(x) ? x : []);
  return {
    executiveSummary: String(p.executiveSummary || ''),
    contentGaps: arr(p.contentGaps).map((g: any) => ({ gap: String(g.gap || ''), detail: String(g.detail || '') })).filter((g: any) => g.gap),
    recommendations: arr(p.recommendations).map((r: any) => ({ title: String(r.title || ''), detail: String(r.detail || '') })).filter((r: any) => r.title),
  };
}

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */
function toReport(d: AioData): Report {
  const blocks = [];

  const srcLabel = d.hasAiOverview
    ? `Found ${d.sources.length} page(s) cited in Google’s AI Overview for “${d.keyword}”.`
    : `No AI Overview block available on ${d.mode === 'organic' ? 'the free SERP source' : 'this query'} — analysing the top ${d.sources.length} organic results as a proxy.`;
  blocks.push(b.p(srcLabel));

  // format comparison
  const c = d.comparison;
  blocks.push(b.kv([
    { k: 'Client word count', v: d.client ? String(c.clientWordCount) : 'no client URL given' },
    { k: 'Avg cited-page words', v: String(c.avgCompetitorWordCount) },
    { k: 'Cited pages with FAQ', v: `${c.competitorsWithFaq}/${c.total}` },
    { k: 'Cited pages with table', v: `${c.competitorsWithTable}/${c.total}` },
    { k: 'Cited pages with numbered list', v: `${c.competitorsWithNumberedList}/${c.total}` },
    ...(d.rankings.clientPosition != null ? [{ k: 'Client organic position', v: `#${d.rankings.clientPosition}` }] : []),
  ]));

  // per-source signals table
  if (d.competitors.length) {
    blocks.push(b.table(
      ['Cited page', 'Words', 'H2', 'FAQ', 'Table', 'List'],
      d.competitors.map((s) => [
        domainOf(s.url), s.wordCount, s.h2,
        s.hasFaq ? '✓' : '—', s.hasTable ? '✓' : '—', s.hasNumberedList ? '✓' : (s.hasBulletList ? '•' : '—'),
      ]),
    ));
  }

  if (d.executiveSummary) blocks.push(b.p(d.executiveSummary));

  if (d.contentGaps.length) {
    blocks.push(b.p('Content gaps vs the cited pages:'));
    blocks.push(b.list(d.contentGaps.map((g) => (g.detail ? `${g.gap} — ${g.detail}` : g.gap))));
  }

  if (d.recommendations.length) {
    blocks.push(b.tasks(d.recommendations.slice(0, 6).map((r, i) => ({
      title: r.title,
      priority: (i === 0 ? 'high' : 'medium') as any,
      detail: r.detail,
    }))));
  }

  // Real GEO / AI-readiness audit of the client page (SEOptimer).
  if (d.seoptimerGeo) blocks.push(...geoBlocks(d.seoptimerGeo));

  if (!d.client) blocks.push(b.note('Add a client URL (e.g. “…vs https://yoursite.com/page”) to get a direct gap analysis for your article.'));
  if (!d.hasAiOverview) blocks.push(b.note('For real AI Overview citations set SERP_PROVIDER=serpapi (with SERP_API_KEY) or add SERPER_API_KEY.'));

  return {
    tag: 'AI Overview Gap',
    title: `AI Overview gap — “${d.keyword}”`,
    blocks,
    data: d,
  };
}

function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}
