import * as cheerio from 'cheerio';
import { config } from '../config';
import { requestOnce, absolutize } from '../lib/http';
import { safeOrigin } from '../lib/html';
import { pool } from '../lib/concurrency';
import { completeJSON, llmConfigured } from '../llm';
import { seoptimerEnabled, seoptimerReport, SeoptimerKeywordRank } from '../sources/seoptimer';
import { Report, b } from '../lib/report';

/**
 * Keyword Cannibalization detector (ported from the user's CaniPro).
 * Crawls the site, reads each page's title + H1 + meta, and groups pages whose
 * primary target overlaps — i.e. multiple pages competing for the same query.
 * Fully deterministic (token overlap + union-find). No LLM, no invented data.
 */

interface Page { url: string; title: string; h1: string; wordCount: number; tokens: Set<string> }

interface Group {
  keyword: string;
  pages: { url: string; title: string; h1: string; wordCount: number }[];
  severity: 'critical' | 'high' | 'medium' | 'low';
}

const STOP = new Set(('a an the of for to in on at and or vs versus with your you our we is are be how what why when which who best top guide ' +
  'review reviews 2024 2025 2026 free online buy price cost near me services service tips ideas home page').split(/\s+/));

const MAX_PAGES = 60;

export async function runCannibal(input: { text: string; domain?: string }): Promise<Report> {
  let start = (input.domain || input.text || '').trim();
  const m = start.match(/\b((?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,})(\/[^\s]*)?/i);
  if (m) start = m[0];
  start = start.replace(/\b(cannibali[sz]ation|cannibali[sz]e|check|for|on|site|website)\b/gi, ' ').trim();
  if (!start) throw new Error('Give me a site to check, e.g. “cannibalization for clientsite.com”.');
  if (!/^https?:\/\//i.test(start)) start = 'https://' + start;
  const origin = safeOrigin(start);
  if (!origin) throw new Error('Invalid URL.');

  const pages = await crawl(origin);
  if (pages.length < 2) {
    return { tag: 'Cannibalization', title: `Cannibalization — ${origin.replace(/^https?:\/\//, '')}`,
      blocks: [b.note(`Only ${pages.length} page(s) could be crawled — not enough to compare. Check the site is reachable.`)] };
  }

  // brand words: tokens appearing on most pages (site name, nav) — drop from matching
  const brand = brandTokens(pages);
  for (const p of pages) for (const w of brand) p.tokens.delete(w);

  const groups = cluster(pages);

  const blocks = [
    b.p(`Crawled ${pages.length} pages on ${origin.replace(/^https?:\/\//, '')}. Compared their title + H1 targets for overlap.`),
  ];

  if (!groups.length) {
    blocks.push(b.note('No keyword cannibalization detected — each page targets a distinct primary topic. 👍'));
    return { tag: 'Cannibalization', title: `No cannibalization found`, blocks, data: { pages: pages.length, groups } };
  }

  // FIX 2: enrich each cluster page with REAL SEOptimer ranking data (position,
  // keyword, estimated traffic) before the narrative call. Credit cost + latency
  // are accepted deliberately so the strategist can cite actual positions rather
  // than only structural overlap. URLs with no SEOptimer match keep undefined
  // fields — never faked.
  const rankByUrl = await seoptimerRankMap(origin);

  // Optional senior-strategist narrative (only when an LLM key is set); the
  // deterministic clusters + evidence below remain the source of truth.
  const analysis = await cannibalNarrative(origin, groups, rankByUrl);

  blocks.push(b.p(`Found ${groups.length} cannibalization cluster(s) — pages competing for the same query:`));
  groups.slice(0, 12).forEach((g, i) => {
    const a = analysis?.clusters?.[i];
    if (a) {
      const detail = [
        a.diagnosis && `Diagnosis: ${a.diagnosis}`,
        a.businessImpact && `Business impact: ${a.businessImpact}`,
        (a.fixType || a.fix) && `Fix (${a.fixType || 'action'}): ${a.fix || ''}`,
        (a.effort || a.who) && `${a.effort ? `Effort: ${a.effort}` : ''}${a.effort && a.who ? ' — ' : ''}${a.who ? `Owner: ${a.who}` : ''}`,
      ].filter(Boolean).join('  •  ');
      blocks.push(b.tasks([{
        title: `“${a.keyword || g.keyword}” — ${g.pages.length} pages competing`,
        priority: normSeverity(a.priority, g.severity),
        detail: detail || fix(g),
      }]));
    } else {
      blocks.push(b.tasks([{
        title: `“${g.keyword}” — ${g.pages.length} pages competing`,
        priority: g.severity,
        detail: fix(g),
      }]));
    }
    blocks.push(b.list(g.pages.map((p) => `${p.title || '(no title)'} — ${shortUrl(p.url)}${p.wordCount ? ` (${p.wordCount}w)` : ''}`)));
  });

  if (analysis?.summary) {
    blocks.push(b.p('Cannibalization summary:'));
    blocks.push(b.p(analysis.summary));
  }

  blocks.push(b.note('Fix by consolidating into one page (301 the rest), setting a canonical, or clearly differentiating each page’s target intent. Connect Search Console for query-level confirmation.'));

  return { tag: 'Cannibalization', title: `Cannibalization — ${origin.replace(/^https?:\/\//, '')}`, blocks, data: { pages: pages.length, groups } };
}

/* ------------------------------------------------------------------ */
/* Optional LLM narrative — senior strategist voice.                   */
/* Runs ONLY over the measured clusters (URLs, titles, H1s, word count).*/
/* ------------------------------------------------------------------ */
async function cannibalNarrative(origin: string, groups: Group[], rankByUrl: Map<string, SeoptimerKeywordRank>): Promise<any | null> {
  if (!llmConfigured() || !groups.length) return null;

  const payload = {
    site: origin.replace(/^https?:\/\//, ''),
    clusters: groups.slice(0, 12).map((g) => ({
      sharedKeyword: g.keyword,
      severity: g.severity,
      pageCount: g.pages.length,
      pages: g.pages.map((p) => {
        const rank = rankByUrl.get(urlKey(p.url));
        return {
          url: p.url, title: p.title || null, h1: p.h1 || null, wordCount: p.wordCount || null,
          // Real SEOptimer position data — present only when SEOptimer tracks this URL.
          ...(rank ? {
            topPosition: rank.position || undefined,
            topKeyword: rank.keyword || undefined,
            estimatedTraffic: rank.estimatedTraffic ?? undefined,
          } : {}),
        };
      }),
    })),
  };

  const system = `You are a senior SEO strategist writing a keyword cannibalization audit for a digital marketing agency's client. This report will be presented to the client's marketing director or CEO. Every word must earn its place.

You will receive cannibalization clusters — groups of pages on the same site competing for overlapping search intent. For each cluster produce exactly this structure:

CLUSTER DIAGNOSIS
- The shared keyword/intent these pages are competing for
- Why Google is confused: specific overlap in title, H1, or content angle
- The measurable consequence: split authority, ranking instability, neither page performing to its potential

BUSINESS IMPACT
One sentence. Translate the SEO problem into a business consequence the client actually cares about — lost traffic, wasted content budget, suppressed conversions. Be specific. Use the URL data provided.

RECOMMENDED FIX
Choose exactly one of these and defend it:
- CONSOLIDATE: merge pages. State which URL survives and why (stronger backlinks, better position, higher word count). Give the exact merge instruction.
- REDIRECT 301: state which page gets redirected and which receives it. Give the exact implementation instruction.
- DIFFERENTIATE: only valid for 2-page clusters where intents are genuinely separable. State the new distinct angle for each page with specific rewrite direction.
- CANONICAL TAG: only for content that must exist on multiple URLs for non-SEO reasons. State which URL is canonical and why.
Never recommend DIFFERENTIATE for clusters of 3 or more pages.

PRIORITY
CRITICAL — indexing or ranking directly broken
HIGH — significant traffic being suppressed right now
MEDIUM — opportunity being missed
One line explaining the rating.

IMPLEMENTATION EFFORT
LOW (under 2 hours) / MEDIUM (half day) / HIGH (full sprint)
State who needs to do this: developer, content writer, or SEO manager.

Rules you must never break:
- Never say "consider", "you might", "could potentially" — give a direct recommendation every time
- Never invent ranking data, traffic numbers, or metrics not in the data passed to you
- Some pages include real SEOptimer position data (topPosition, topKeyword, estimatedTraffic). When present, use it to decide which page in a cluster is strongest (best position wins) and to quantify the business impact — but never infer these numbers for a page that does not provide them
- Every fix must name the actual URLs from the cluster, not generic advice
- If a cluster has 4 or more pages, CONSOLIDATE or REDIRECT is the only valid recommendation — differentiation at that scale never works
- Close with a one-paragraph CANNIBALIZATION SUMMARY across all clusters: total pages affected, the single biggest win available, and the recommended sequence to fix them (what to do first and why)

OUTPUT FORMAT — return ONLY minified JSON. Provide one entry per cluster in the SAME ORDER as the input clusters. The affected-URL list for each cluster is already rendered beneath your entry.
{"clusters": [{"keyword": string, "diagnosis": string, "businessImpact": string, "fixType": "CONSOLIDATE|REDIRECT 301|DIFFERENTIATE|CANONICAL", "fix": string (name the actual URLs), "priority": "CRITICAL|HIGH|MEDIUM", "effort": "LOW|MEDIUM|HIGH", "who": "developer|content writer|SEO manager"}],
 "summary": string (the closing CANNIBALIZATION SUMMARY paragraph)}`;

  try {
    return await completeJSON<any>(system, JSON.stringify(payload), { temperature: 0.3, maxTokens: 4000 });
  } catch {
    return null; // deterministic clusters still render fully
  }
}

/**
 * Fetch the site's SEOptimer report once and index its keyword rankings by the
 * ranking URL, keeping the best (lowest) position per URL. Empty map when
 * SEOptimer is not configured, fails, or reports no per-URL ranking data.
 */
async function seoptimerRankMap(origin: string): Promise<Map<string, SeoptimerKeywordRank>> {
  const map = new Map<string, SeoptimerKeywordRank>();
  if (!seoptimerEnabled()) return map;
  const so = await seoptimerReport(origin).catch(() => null);
  if (!so || !so.ok) return map;
  for (const r of so.keywordRankings) {
    if (!r.url) continue; // no URL on this ranking → cannot attribute it to a page
    const key = urlKey(r.url);
    const cur = map.get(key);
    if (!cur || (r.position && r.position < cur.position)) map.set(key, r);
  }
  return map;
}

/** Normalize a URL to a comparison key (host+path, no scheme/www/trailing slash). */
function urlKey(u: string): string {
  try {
    const p = new URL(u);
    return (p.hostname.replace(/^www\./, '') + p.pathname).replace(/\/+$/, '').toLowerCase();
  } catch {
    return u.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
  }
}

function normSeverity(v: string, fallback: Group['severity']): Group['severity'] {
  const s = String(v || '').toLowerCase();
  return s === 'critical' || s === 'high' || s === 'medium' || s === 'low' ? s : fallback;
}

/* ------- crawl (BFS, same-origin, HTML only) ------- */
async function crawl(origin: string): Promise<Page[]> {
  const pages: Page[] = [];
  const seen = new Set<string>([origin]);
  let frontier = [origin];
  const conc = config.crawl.concurrency;

  while (frontier.length && pages.length < MAX_PAGES) {
    const batch = frontier.splice(0, Math.max(conc, 8));
    const found: string[] = [];
    await pool(batch, conc, async (url) => {
      if (pages.length >= MAX_PAGES) return;
      const res = await requestOnce(url);
      if (!res.body || res.status >= 400 || !/text\/html/i.test(res.contentType)) return;
      const $ = cheerio.load(res.body);
      const title = ($('title').first().text() || '').replace(/\s+/g, ' ').trim();
      const h1 = ($('h1').first().text() || '').replace(/\s+/g, ' ').trim();
      const noindex = /noindex/i.test($('meta[name="robots"]').attr('content') || '');
      const bodyText = $('body').clone().find('script, style, noscript').remove().end().text().replace(/\s+/g, ' ').trim();
      const wordCount = bodyText ? bodyText.split(/\s+/).length : 0;
      if (!noindex) pages.push({ url, title, h1, wordCount, tokens: tokenize(`${title} ${h1}`) });
      $('a[href]').each((_, el) => {
        const abs = absolutize($(el).attr('href') || '', url).split('#')[0];
        if (safeOrigin(abs) === origin && !seen.has(abs) && !isAsset(abs) && seen.size < MAX_PAGES * 6) {
          seen.add(abs); found.push(abs);
        }
      });
    });
    frontier.push(...found);
  }
  return pages;
}

/* ------- clustering via token overlap + union-find ------- */
function cluster(pages: Page[]): Group[] {
  const parent = pages.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b2: number) => { parent[find(a)] = find(b2); };

  for (let i = 0; i < pages.length; i++) {
    for (let j = i + 1; j < pages.length; j++) {
      if (pages[i].tokens.size < 2 || pages[j].tokens.size < 2) continue;
      if (jaccard(pages[i].tokens, pages[j].tokens) >= 0.6) union(i, j);
    }
  }

  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < pages.length; i++) {
    const r = find(i);
    (byRoot.get(r) || byRoot.set(r, []).get(r)!).push(i);
  }

  const groups: Group[] = [];
  for (const [, idxs] of byRoot) {
    if (idxs.length < 2) continue;
    const members = idxs.map((i) => pages[i]);
    groups.push({
      keyword: commonKeyword(members),
      pages: members.map((p) => ({ url: p.url, title: p.title, h1: p.h1, wordCount: p.wordCount })),
      severity: idxs.length >= 4 ? 'critical' : idxs.length === 3 ? 'high' : 'medium',
    });
  }
  return groups.sort((a, c) => c.pages.length - a.pages.length);
}

/* ------- helpers ------- */
function tokenize(s: string): Set<string> {
  return new Set(
    s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w)),
  );
}
function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  const uni = a.size + b.size - inter;
  return uni ? inter / uni : 0;
}
function brandTokens(pages: Page[]): Set<string> {
  const count = new Map<string, number>();
  for (const p of pages) for (const w of p.tokens) count.set(w, (count.get(w) || 0) + 1);
  const brand = new Set<string>();
  const threshold = Math.max(3, pages.length * 0.6);
  for (const [w, c] of count) if (c >= threshold) brand.add(w);
  return brand;
}
function commonKeyword(members: Page[]): string {
  const count = new Map<string, number>();
  for (const p of members) for (const w of p.tokens) count.set(w, (count.get(w) || 0) + 1);
  const top = [...count.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).map(([w]) => w).slice(0, 4);
  return top.join(' ') || (members[0].title || members[0].url);
}
function fix(g: Group): string {
  return `These ${g.pages.length} pages target the same query, so Google splits authority and may rank the wrong one. ` +
    `Consolidate into the strongest page (301 the others) or set canonicals; if each serves a distinct intent, differentiate titles/H1s.`;
}
function isAsset(url: string): boolean {
  return /\.(jpg|jpeg|png|gif|webp|svg|ico|css|js|json|pdf|zip|mp4|webm|woff2?|ttf|eot|xml)(\?|$)/i.test(url);
}
function shortUrl(u: string): string {
  try { const p = new URL(u); return (p.pathname === '/' ? p.hostname : p.pathname).slice(0, 60); } catch { return u.slice(0, 60); }
}
