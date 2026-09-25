import { config } from '../config';
import { followChain } from '../lib/http';
import { fetchPage } from '../sources/render';
import { assertPublicUrl } from '../lib/ssrf';
import { parseHtml, PageParse, safeOrigin, contentFingerprint } from '../lib/html';
import { pool } from '../lib/concurrency';
import { pageSpeed, PsiResult } from '../sources/psi';
import { seoptimerEnabled, seoptimerReport, SeoptimerReport } from '../sources/seoptimer';
import { completeJSON, llmConfigured } from '../llm';
import { Report, b } from '../lib/report';

interface CrawledPage {
  url: string;
  status: number;
  contentType: string;
  redirectTo: string | null;
  timeMs: number;
  error?: string;
  parse?: PageParse;
  fingerprint?: string;
}

export interface AuditData {
  startUrl: string;
  origin: string;
  https: boolean;
  pagesCrawled: number;
  robotsTxt: { found: boolean; disallowAll: boolean; sitemaps: string[]; issues: string[] };
  sitemap: { found: boolean; urlCount: number; issues: string[] };
  issues: IssueGroup[];
  pagespeed?: PsiResult;
  seoptimer?: SeoptimerReport;
  stats?: {
    htmlPages: number;
    indexable: number;
    avgWords: number;
    withSchema: number;
    httpsPages: number;
    avgResponseMs: number;
  };
  // Accurate whole-site counts (NOT the display-capped issue examples) for reporting.
  counts?: AuditCounts;
  homepage?: PageParse;
}

export interface AuditCounts {
  totalPages: number;
  missingTitle: number;
  dupTitle: number;
  missingMeta: number;
  dupMeta: number;
  missingH1: number;
  multiH1: number;
  thin: number;
  noindex: number;
  canonicalIssues: number;
  imagesTotal: number;
  imagesMissingAlt: number;
  notFound: number;
  brokenInternalLinks: number;
}

interface IssueGroup {
  id: string;
  label: string;
  category: 'technical' | 'onpage' | 'content';
  severity: 'critical' | 'high' | 'medium' | 'low';
  count: number;
  examples: string[];
  explanation: string;
}

const HTML_RE = /text\/html/i;

/** Normalize a URL for dedupe/comparison (drop hash, sort nothing, lowercase host). */
function normalize(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    // collapse default ports
    if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) u.port = '';
    return u.toString();
  } catch {
    return url;
  }
}

export async function runAudit(startUrlRaw: string, opts: { maxPages?: number; cwv?: boolean } = {}): Promise<Report> {
  let startUrl = startUrlRaw.trim();
  if (!/^https?:\/\//i.test(startUrl)) startUrl = 'https://' + startUrl;
  startUrl = normalize(startUrl);

  // Resolve the seed's redirect chain up front (apex -> www, http -> https, a
  // trailing-slash canonical, etc.) so the crawl origin matches where the site
  // actually lives. Without this, a homepage that 301s (very common) yields a
  // single unparsed redirect page and the whole crawl stops at one URL.
  try {
    const chain = await followChain(startUrl);
    const landed = chain.final;
    if (landed && landed.status >= 200 && landed.status < 400 && safeOrigin(landed.url)) {
      startUrl = normalize(landed.url);
    }
  } catch { /* keep the original seed if resolution fails */ }

  const origin = safeOrigin(startUrl);
  if (!origin) throw new Error('Invalid URL');

  // SSRF guard: reject internal / private / metadata targets before any fetch.
  await assertPublicUrl(startUrl);

  const maxPages = Math.min(opts.maxPages || config.crawl.maxPages, 500);
  const pages = new Map<string, CrawledPage>();          // fetched URLs (incl. redirect hops)
  const linkedFrom = new Map<string, Set<string>>();     // normalized url -> linking pages
  const queue: string[] = [startUrl];
  const enqueued = new Set<string>([startUrl]);

  // The budget counts TERMINAL pages (real 200/404/… responses), NOT redirect
  // hops. A site that canonicalises URLs (trailing-slash, www, http->https)
  // answers most links with a 301; if those counted, the budget would be spent
  // on hops and their real targets never fetched. A hard fetch cap still bounds
  // total work (and any redirect loop) regardless.
  let terminalPages = 0;
  const maxFetches = maxPages * 6;
  const enqueueCap = maxPages * 8;

  // ---- robots.txt ----
  const robots = await readRobots(origin);

  // ---- BFS crawl (same-origin) ----
  while (queue.length && terminalPages < maxPages && pages.size < maxFetches) {
    const batch = queue.splice(0, config.crawl.concurrency);
    await pool(batch, config.crawl.concurrency, async (url) => {
      if (pages.has(url) || terminalPages >= maxPages || pages.size >= maxFetches) return;
      const res = await fetchPage(url);
      const page: CrawledPage = {
        url,
        status: res.status,
        contentType: res.contentType,
        redirectTo: res.redirected ? res.location : null,
        timeMs: res.timeMs,
        error: res.error,
      };

      if (HTML_RE.test(res.contentType) && res.body && !res.redirected) {
        const parse = parseHtml(res.body, res.finalUrl || url);
        page.parse = parse;
        page.fingerprint = contentFingerprint(parse.text);
        for (const link of parse.internalLinks) {
          const n = normalize(link);
          if (safeOrigin(n) !== origin || isAsset(n)) continue;
          if (!linkedFrom.has(n)) linkedFrom.set(n, new Set());
          linkedFrom.get(n)!.add(url);
          if (!enqueued.has(n) && enqueued.size < enqueueCap) {
            enqueued.add(n);
            queue.push(n);
          }
        }
      } else if (res.redirected && res.location) {
        // Follow same-origin redirects into the crawl so a redirecting URL
        // doesn't dead-end the branch. Redirect hops do NOT count against the
        // page budget (see terminalPages) — only their final target does.
        const n = normalize(res.location);
        if (safeOrigin(n) === origin && !isAsset(n) && !enqueued.has(n) && enqueued.size < enqueueCap) {
          enqueued.add(n);
          queue.push(n);
        }
      }
      if (!res.redirected) terminalPages++;
      pages.set(url, page);
    });
  }

  const all = [...pages.values()];

  // ---- sitemap ----
  const sitemap = await readSitemaps(robots.sitemaps.length ? robots.sitemaps : [origin + '/sitemap.xml']);

  // ---- issue detection ----
  const issues = detectIssues(all, startUrl, origin, sitemap.urls, linkedFrom);

  // ---- crawl statistics (all measured, no LLM) ----
  // "Pages" means terminal responses (real pages), not the redirect hops we
  // followed to reach them — so counts and percentages describe actual pages.
  const htmlPages = all.filter((p) => p.parse);
  const responded = all.filter((p) => p.status > 0 && !p.redirectTo);
  const stats = {
    htmlPages: htmlPages.length,
    indexable: htmlPages.filter((p) => p.status === 200 && !p.parse!.noindex).length,
    avgWords: htmlPages.length ? Math.round(htmlPages.reduce((s, p) => s + (p.parse!.wordCount || 0), 0) / htmlPages.length) : 0,
    withSchema: htmlPages.filter((p) => p.parse!.hasSchema).length,
    httpsPages: responded.filter((p) => p.url.startsWith('https://')).length,
    avgResponseMs: responded.length ? Math.round(responded.reduce((s, p) => s + p.timeMs, 0) / responded.length) : 0,
  };

  const counts = computeCounts(all, htmlPages, responded.length);
  const homepage = pages.get(normalize(startUrl))?.parse
    ?? htmlPages.find((p) => p.status === 200)?.parse;

  const data: AuditData = {
    startUrl,
    origin,
    https: startUrl.startsWith('https://'),
    pagesCrawled: responded.length,
    robotsTxt: { found: robots.found, disallowAll: robots.disallowAll, sitemaps: robots.sitemaps, issues: robots.issues },
    sitemap: { found: sitemap.found, urlCount: sitemap.urls.length, issues: sitemap.issues },
    issues,
    stats,
    counts,
    homepage,
  };

  // ---- Trusted third-party data, fetched in parallel ----
  // Google PageSpeed/Lighthouse (free) + SEOptimer graded audit (when a key is set).
  // Both are measured, not inferred — the LLM never sees these.
  const [psi, seopt] = await Promise.all([
    opts.cwv !== false ? pageSpeed(startUrl, 'mobile').catch(() => undefined) : Promise.resolve(undefined),
    seoptimerEnabled() ? seoptimerReport(startUrl).catch(() => undefined) : Promise.resolve(undefined),
  ]);
  if (psi) data.pagespeed = psi;
  if (seopt) data.seoptimer = seopt;

  return await toReport(data);
}

/* ------------------------------------------------------------------ */
/* Accurate whole-site counts (uncapped) for reporting                 */
/* ------------------------------------------------------------------ */
function computeCounts(all: CrawledPage[], htmlPages: CrawledPage[], totalPages: number): AuditCounts {
  const dupCount = (pick: (p: CrawledPage) => string | null) => {
    const map = new Map<string, number>();
    for (const p of htmlPages) {
      const v = pick(p);
      if (!v) continue;
      const key = v.trim().toLowerCase();
      map.set(key, (map.get(key) || 0) + 1);
    }
    let n = 0;
    for (const [, c] of map) if (c > 1) n += c;
    return n;
  };
  let canonicalIssues = 0;
  for (const p of htmlPages) {
    const c = p.parse!.canonical;
    if (c && safeOrigin(c) && normalize(c) !== normalize(p.url) && !c.includes('?')) canonicalIssues++;
  }
  return {
    totalPages,
    missingTitle: htmlPages.filter((p) => !p.parse!.title).length,
    dupTitle: dupCount((p) => p.parse!.title),
    missingMeta: htmlPages.filter((p) => !p.parse!.metaDescription).length,
    dupMeta: dupCount((p) => p.parse!.metaDescription),
    missingH1: htmlPages.filter((p) => p.parse!.h1.length === 0).length,
    multiH1: htmlPages.filter((p) => p.parse!.h1.length > 1).length,
    thin: htmlPages.filter((p) => p.status === 200 && p.parse!.wordCount < 300 && !p.parse!.noindex).length,
    noindex: htmlPages.filter((p) => p.parse!.noindex).length,
    canonicalIssues,
    imagesTotal: htmlPages.reduce((s, p) => s + (p.parse!.imagesTotal || 0), 0),
    imagesMissingAlt: htmlPages.reduce((s, p) => s + (p.parse!.imagesMissingAlt || 0), 0),
    notFound: all.filter((p) => p.status === 404).length,
    brokenInternalLinks: all.filter((p) => p.status === 404).length,
  };
}

/* ------------------------------------------------------------------ */
/* Issue detection                                                     */
/* ------------------------------------------------------------------ */
function detectIssues(pages: CrawledPage[], startUrl: string, origin: string, sitemapUrls: string[], linkedFrom: Map<string, Set<string>>): IssueGroup[] {
  const groups: IssueGroup[] = [];
  const htmlPages = pages.filter((p) => p.parse);

  const add = (g: Omit<IssueGroup, 'count'> & { examples: string[] }) => {
    if (g.examples.length === 0) return;
    groups.push({ ...g, count: g.examples.length });
  };

  // 404 / 5xx / errors
  add({ id: '404', label: '404 Not Found', category: 'technical', severity: 'critical',
    explanation: 'Pages returning 404 waste crawl budget and lose link equity. Fix links or 301-redirect to a relevant page.',
    examples: pages.filter((p) => p.status === 404).map((p) => p.url) });
  add({ id: '5xx', label: '5xx Server Errors', category: 'technical', severity: 'critical',
    explanation: 'Server errors block indexing entirely and signal instability to Google. Investigate server/app logs.',
    examples: pages.filter((p) => p.status >= 500).map((p) => `${p.url} (${p.status})`) });
  add({ id: 'unreachable', label: 'Unreachable / timed out', category: 'technical', severity: 'high',
    explanation: 'These URLs failed to respond. Check DNS, TLS, firewall or timeouts.',
    examples: pages.filter((p) => p.status === 0 && p.error).map((p) => `${p.url} (${p.error})`) });

  // redirect chains & loops
  const redirects = pages.filter((p) => p.redirectTo);
  const chainExamples: string[] = [];
  const loopExamples: string[] = [];
  for (const p of redirects.slice(0, 40)) {
    const c = trace(p.url, pages);
    if (c.loop) loopExamples.push(p.url);
    else if (c.hops >= 2) chainExamples.push(`${p.url} → ${c.hops} hops`);
  }
  add({ id: 'redirect-chain', label: 'Redirect chains', category: 'technical', severity: 'medium',
    explanation: 'Multi-hop redirects slow crawling and dilute link equity. Point the first URL directly to the final destination.',
    examples: chainExamples });
  add({ id: 'redirect-loop', label: 'Redirect loops', category: 'technical', severity: 'critical',
    explanation: 'Redirect loops make pages permanently inaccessible to users and crawlers.',
    examples: loopExamples });

  // canonical issues
  const canonicalIssues: string[] = [];
  for (const p of htmlPages) {
    const c = p.parse!.canonical;
    if (c && safeOrigin(c) && normalize(c) !== normalize(p.url) && !p.parse!.canonical!.includes('?')) {
      // canonical points elsewhere — flag only if target wasn't the page itself
      canonicalIssues.push(`${p.url} → canonical ${c}`);
    }
  }
  add({ id: 'canonical', label: 'Canonical points elsewhere', category: 'technical', severity: 'medium',
    explanation: 'These pages declare a different canonical URL. Confirm that is intended — otherwise the page may be deindexed in favor of another.',
    examples: canonicalIssues.slice(0, 30) });

  // noindex / indexability
  add({ id: 'noindex', label: 'Noindex pages', category: 'technical', severity: 'high',
    explanation: 'These pages tell Google not to index them. Confirm this is intentional; accidental noindex removes pages from search.',
    examples: htmlPages.filter((p) => p.parse!.noindex).map((p) => p.url) });

  // duplicate URLs (trailing slash / case variants)
  const dupUrl = findDuplicateUrls(pages.map((p) => p.url));
  add({ id: 'dup-url', label: 'Duplicate URL variants', category: 'technical', severity: 'medium',
    explanation: 'The same content is reachable at multiple URLs (trailing slash / case). Standardize and 301 to one canonical form.',
    examples: dupUrl });

  // orphan pages (in sitemap but never linked internally)
  if (sitemapUrls.length) {
    const linked = new Set([...linkedFrom.keys()]);
    const orphans = sitemapUrls
      .map(normalize)
      .filter((u) => safeOrigin(u) === origin && !linked.has(u) && normalize(startUrl) !== u)
      .slice(0, 30);
    add({ id: 'orphan', label: 'Orphan pages', category: 'technical', severity: 'medium',
      explanation: 'Pages in the sitemap with no internal links pointing to them. Add internal links so users and crawlers can reach them.',
      examples: orphans });
  }

  // duplicate content (same fingerprint)
  const fpMap = new Map<string, string[]>();
  for (const p of htmlPages) {
    if (!p.fingerprint) continue;
    const arr = fpMap.get(p.fingerprint) || [];
    arr.push(p.url);
    fpMap.set(p.fingerprint, arr);
  }
  const dupContent: string[] = [];
  for (const [, urls] of fpMap) if (urls.length > 1) dupContent.push(urls.slice(0, 3).join('  ·  '));
  add({ id: 'dup-content', label: 'Duplicate content', category: 'content', severity: 'high',
    explanation: 'These URLs share near-identical body content. Consolidate or canonicalize to avoid keyword cannibalization.',
    examples: dupContent.slice(0, 25) });

  // ---- on-page ----
  add({ id: 'title-missing', label: 'Missing title tag', category: 'onpage', severity: 'high',
    explanation: 'Title tags are the single strongest on-page signal and the clickable headline in search. Every page needs a unique one.',
    examples: htmlPages.filter((p) => !p.parse!.title).map((p) => p.url) });
  add(dupGroup('title-dup', 'Duplicate titles', 'onpage', 'high',
    'Duplicate titles confuse Google about which page to rank and split relevance. Make each unique.',
    htmlPages, (p) => p.parse!.title));
  add({ id: 'meta-missing', label: 'Missing meta description', category: 'onpage', severity: 'medium',
    explanation: 'Missing meta descriptions let Google auto-generate snippets, hurting CTR. Write a compelling 140–160 char description.',
    examples: htmlPages.filter((p) => !p.parse!.metaDescription).map((p) => p.url) });
  add(dupGroup('meta-dup', 'Duplicate meta descriptions', 'onpage', 'low',
    'Duplicate descriptions waste the SERP snippet opportunity. Differentiate each.',
    htmlPages, (p) => p.parse!.metaDescription));
  add({ id: 'h1-missing', label: 'Missing H1', category: 'onpage', severity: 'medium',
    explanation: 'The H1 states the page topic to users and crawlers. Add exactly one descriptive H1 per page.',
    examples: htmlPages.filter((p) => p.parse!.h1.length === 0).map((p) => p.url) });
  add({ id: 'h1-multi', label: 'Multiple H1s', category: 'onpage', severity: 'low',
    explanation: 'Multiple H1s dilute topical focus. Use one H1 and structure the rest as H2/H3.',
    examples: htmlPages.filter((p) => p.parse!.h1.length > 1).map((p) => `${p.url} (${p.parse!.h1.length})`) });
  add({ id: 'heading-order', label: 'Broken heading order', category: 'onpage', severity: 'low',
    explanation: 'H3s appearing with no H2 above them break the document outline for accessibility and crawlers.',
    examples: htmlPages.filter((p) => p.parse!.h3.length > 0 && p.parse!.h2.length === 0).map((p) => p.url) });
  add({ id: 'alt-missing', label: 'Images missing alt text', category: 'onpage', severity: 'low',
    explanation: 'Alt text drives image search and accessibility. Add descriptive alt to meaningful images.',
    examples: htmlPages.filter((p) => p.parse!.imagesMissingAlt > 0).map((p) => `${p.url} (${p.parse!.imagesMissingAlt} imgs)`) });

  // ---- content ----
  add({ id: 'thin', label: 'Thin content', category: 'content', severity: 'medium',
    explanation: 'Pages under ~250 words rarely satisfy intent or rank. Expand with useful, original content or consolidate.',
    examples: htmlPages.filter((p) => p.status === 200 && p.parse!.wordCount < 250 && !p.parse!.noindex).map((p) => `${p.url} (${p.parse!.wordCount}w)`) });

  // ---- mobile / viewport ----
  add({ id: 'viewport', label: 'Missing mobile viewport', category: 'technical', severity: 'high',
    explanation: 'Without a viewport meta tag the page will not render well on mobile — a direct ranking and UX problem under mobile-first indexing.',
    examples: htmlPages.filter((p) => !p.parse!.hasViewport).map((p) => p.url) });

  return groups.sort((a, b2) => sevRank(b2.severity) - sevRank(a.severity) || b2.count - a.count);
}

function dupGroup(
  id: string, label: string, category: IssueGroup['category'], severity: IssueGroup['severity'],
  explanation: string, pages: CrawledPage[], pick: (p: CrawledPage) => string | null,
): Omit<IssueGroup, 'count'> & { examples: string[] } {
  const map = new Map<string, string[]>();
  for (const p of pages) {
    const v = pick(p);
    if (!v) continue;
    const key = v.trim().toLowerCase();
    const arr = map.get(key) || [];
    arr.push(p.url);
    map.set(key, arr);
  }
  const examples: string[] = [];
  for (const [val, urls] of map) if (urls.length > 1) examples.push(`"${val.slice(0, 55)}" ×${urls.length}`);
  return { id, label, category, severity, explanation, examples: examples.slice(0, 25) };
}

function findDuplicateUrls(urls: string[]): string[] {
  const map = new Map<string, string[]>();
  for (const u of urls) {
    const key = normalize(u).toLowerCase().replace(/\/$/, '');
    const arr = map.get(key) || [];
    if (!arr.includes(u)) arr.push(u);
    map.set(key, arr);
  }
  const out: string[] = [];
  for (const [, group] of map) if (group.length > 1) out.push(group.join('  ·  '));
  return out.slice(0, 20);
}

function trace(url: string, pages: CrawledPage[]) {
  const byUrl = new Map(pages.map((p) => [normalize(p.url), p]));
  const seen = new Set<string>();
  let cur = normalize(url);
  let hops = 0;
  while (hops < 10) {
    if (seen.has(cur)) return { loop: true, hops };
    seen.add(cur);
    const p = byUrl.get(cur);
    if (p?.redirectTo) { cur = normalize(p.redirectTo); hops++; } else break;
  }
  return { loop: false, hops };
}

const sevRank = (s: IssueGroup['severity']) => ({ critical: 4, high: 3, medium: 2, low: 1 }[s]);
const fmtScore = (n: number | null) => (n == null ? '—' : `${n}/100`);
const ms = (n: number | null) => (n == null ? '—' : `${n}ms`);
const fmtNum = (n: number | null) => (n == null ? '—' : n.toLocaleString('en-US'));
const recRank = (p: string) => ({ high: 3, medium: 2, low: 1 } as Record<string, number>)[String(p).toLowerCase()] ?? 2;
const normPriority = (p: string): 'critical' | 'high' | 'medium' | 'low' => {
  const v = String(p).toLowerCase();
  return v === 'high' || v === 'medium' || v === 'low' ? v : 'medium';
};

function isAsset(url: string): boolean {
  return /\.(jpg|jpeg|png|gif|webp|svg|ico|css|js|json|pdf|zip|mp4|webm|woff2?|ttf|eot|xml)(\?|$)/i.test(url);
}

/* ------------------------------------------------------------------ */
/* robots.txt + sitemaps                                               */
/* ------------------------------------------------------------------ */
async function readRobots(origin: string) {
  const out = { found: false, disallowAll: false, sitemaps: [] as string[], issues: [] as string[] };
  // Follow redirects — many sites 301 /robots.txt (www ↔ apex, http→https).
  const res = (await followChain(origin + '/robots.txt', 5)).final;
  if (!res || res.status !== 200 || !res.body) {
    out.issues.push('robots.txt not found or unreadable (Google assumes full crawl allowed).');
    return out;
  }
  out.found = true;
  const lines = res.body.split('\n').map((l) => l.trim());
  let uaAll = false;
  for (const line of lines) {
    const [k, ...rest] = line.split(':');
    const key = k.toLowerCase().trim();
    const val = rest.join(':').trim();
    if (key === 'user-agent') uaAll = val === '*';
    if (key === 'disallow' && uaAll && val === '/') out.disallowAll = true;
    if (key === 'sitemap' && val) out.sitemaps.push(val);
  }
  if (out.disallowAll) out.issues.push('robots.txt blocks the entire site (Disallow: / for *). This prevents all indexing.');
  if (!out.sitemaps.length) out.issues.push('No Sitemap directive in robots.txt — add one to help discovery.');
  return out;
}

async function readSitemaps(urls: string[]) {
  const out = { found: false, urls: [] as string[], issues: [] as string[] };
  const seen = new Set<string>();
  const queue = [...urls];
  let fetches = 0;
  while (queue.length && fetches < 15) {
    const sm = queue.shift()!;
    if (seen.has(sm)) continue;
    seen.add(sm);
    fetches++;
    const res = (await followChain(sm, 5)).final;
    if (!res || res.status !== 200 || !res.body) { if (fetches === 1) out.issues.push(`Sitemap not reachable: ${sm}`); continue; }
    out.found = true;
    // sitemap index?
    const childSitemaps = [...res.body.matchAll(/<sitemap>[\s\S]*?<loc>\s*([^<]+)\s*<\/loc>/gi)].map((m) => m[1].trim());
    if (childSitemaps.length) { for (const c of childSitemaps.slice(0, 20)) queue.push(c); continue; }
    const locs = [...res.body.matchAll(/<url>[\s\S]*?<loc>\s*([^<]+)\s*<\/loc>/gi)].map((m) => m[1].trim());
    for (const l of locs) if (!out.urls.includes(l)) out.urls.push(l);
  }
  if (out.found && out.urls.length === 0) out.issues.push('Sitemap found but contains no URLs.');
  return out;
}

/* ------------------------------------------------------------------ */
/* Report: Detect -> Group -> Prioritize -> Explain -> Create task     */
/* ------------------------------------------------------------------ */
async function toReport(data: AuditData): Promise<Report> {
  const blocks = [];
  const totalIssues = data.issues.reduce((s, g) => s + g.count, 0);

  // ---- Optional senior-consultant narrative (only when an LLM key is set) ----
  // The LLM works STRICTLY over the measured crawl / Lighthouse / SEOptimer data
  // assembled below. The deterministic blocks remain the hallucination-proof
  // backbone and render whether or not the LLM is available.
  const analysis = await auditNarrative(data, totalIssues);
  if (analysis?.executiveSummary) blocks.push(b.p(analysis.executiveSummary));

  blocks.push(b.p(
    `Crawled ${data.pagesCrawled} page${data.pagesCrawled === 1 ? '' : 's'} on ${data.origin}. ` +
    `Detected ${totalIssues} issue${totalIssues === 1 ? '' : 's'} across ${data.issues.length} groups.`,
  ));

  const site = [];
  site.push({ k: 'HTTPS', v: data.https ? 'Yes' : 'No — insecure' });
  site.push({ k: 'robots.txt', v: data.robotsTxt.found ? (data.robotsTxt.disallowAll ? 'Blocks whole site!' : 'OK') : 'Missing' });
  site.push({ k: 'Sitemap', v: data.sitemap.found ? `${data.sitemap.urlCount} URLs` : 'Not found' });
  if (data.stats) {
    site.push({ k: 'HTML pages', v: `${data.stats.htmlPages} (${data.stats.indexable} indexable)` });
    site.push({ k: 'Avg content length', v: `${data.stats.avgWords} words` });
    site.push({ k: 'Structured data', v: `${data.stats.withSchema}/${data.stats.htmlPages} pages` });
    site.push({ k: 'Avg response time', v: `${data.stats.avgResponseMs} ms` });
  }
  blocks.push(b.kv(site));

  // ---- Google Lighthouse / PageSpeed (trusted, free Google data) ----
  const ps = data.pagespeed;
  if (ps && !ps.error && (ps.performanceScore != null || ps.seoScore != null)) {
    blocks.push(b.p('Google Lighthouse (PageSpeed Insights, mobile):'));
    blocks.push(b.table(
      ['Performance', 'SEO', 'Accessibility', 'Best practices'],
      [[fmtScore(ps.performanceScore), fmtScore(ps.seoScore), fmtScore(ps.accessibilityScore), fmtScore(ps.bestPracticesScore)]],
    ));
    blocks.push(b.kv([
      { k: `Core Web Vitals ${ps.fieldData ? '(field/CrUX)' : '(lab)'}`, v: `LCP ${ms(ps.lcpMs)} · CLS ${ps.cls ?? '—'} · INP ${ms(ps.inpMs)} · TTFB ${ms(ps.ttfbMs)}` },
    ]));
    if (ps.opportunities.length) {
      blocks.push(b.p('Speed opportunities (est. savings):'));
      blocks.push(b.list(ps.opportunities.map((o) => `${o.title} — ~${(o.savingsMs / 1000).toFixed(1)}s`)));
    }
    if (ps.seoIssues.length) {
      blocks.push(b.p('Google Lighthouse SEO checks failing:'));
      blocks.push(b.list(ps.seoIssues));
    }
    if (ps.accessibilityIssues.length) {
      blocks.push(b.p('Accessibility issues (affect UX signals):'));
      blocks.push(b.chips(ps.accessibilityIssues));
    }
  }

  // ---- SEOptimer graded audit (real third-party data) ----
  const so = data.seoptimer;
  if (so && so.ok) {
    const gradeOrder = ['overall', 'seo', 'geo', 'links', 'performance', 'social', 'ui', 'security'];
    const graded = gradeOrder.filter((k) => so.scores[k]?.grade);
    if (graded.length) {
      blocks.push(b.p('SEOptimer graded audit:'));
      blocks.push(b.table(
        graded.map((k) => k === 'ui' ? 'Usability' : k[0].toUpperCase() + k.slice(1)),
        [graded.map((k) => so.scores[k].grade)],
      ));
    }

    if (so.backlinks && so.backlinks.backlinks != null) {
      const bl = so.backlinks;
      blocks.push(b.kv([
        { k: 'Backlinks', v: fmtNum(bl.backlinks) },
        { k: 'Referring domains', v: fmtNum(bl.referringDomains) },
        { k: 'Domain strength', v: bl.domainStrength != null ? `${bl.domainStrength}/100` : '—' },
        { k: 'Dofollow / nofollow', v: `${fmtNum(bl.dofollow)} / ${fmtNum(bl.nofollow)}` },
      ]));
    }

    if (so.keywordRankings.length) {
      blocks.push(b.p(`Top keyword rankings (SEOptimer — real positions, ${so.keywordRankings.length} tracked):`));
      blocks.push(b.table(
        ['Keyword', 'Country', 'Position', 'Searches', 'Est. traffic'],
        so.keywordRankings.slice(0, 10).map((r) => [
          r.keyword, r.country || '—', r.position || '—', r.totalSearches ?? '—', r.estimatedTraffic ?? '—',
        ]),
      ));
    }

    if (so.recommendations.length) {
      const top = so.recommendations
        .slice()
        .sort((x, y) => recRank(y.priority) - recRank(x.priority))
        .slice(0, 10);
      blocks.push(b.p('SEOptimer prioritized recommendations:'));
      blocks.push(b.tasks(top.map((r) => ({
        title: r.recommendation,
        priority: normPriority(r.priority),
        detail: r.section ? `Section: ${r.section}` : undefined,
      }))));
    }

    if (so.technologies.length) {
      blocks.push(b.p('Detected technologies:'));
      blocks.push(b.chips(so.technologies.slice(0, 18)));
    }
  } else if (seoptimerEnabled() && so && !so.ok) {
    blocks.push(b.note(`SEOptimer data unavailable (${so.error}). The crawler + Lighthouse results above are unaffected.`));
  }

  // Issue table (from Sage's own crawl)
  blocks.push(b.p('Issues detected by the crawler:'));
  blocks.push(b.table(
    ['Issue', 'Category', 'Pages', 'Priority'],
    data.issues.slice(0, 16).map((g) => [g.label, g.category, g.count, g.severity.toUpperCase()]),
  ));

  // Prioritized fix list — built DETERMINISTICALLY from the detected issues.
  // No LLM here: every task and count maps to something the crawler actually found.
  if (data.issues.length) {
    const tasks = data.issues.slice(0, 8).map((g) => ({
      title: `Fix: ${g.label}`,
      priority: g.severity,
      detail: `${g.count} page${g.count === 1 ? '' : 's'} affected. ${g.explanation}`,
      count: g.count,
    }));
    blocks.push(b.p('Prioritized fixes (grounded in the crawl — nothing inferred):'));
    blocks.push(b.tasks(tasks));
  }

  // ---- Consultant analysis (LLM, over the measured data above) ----
  if (analysis) {
    if (Array.isArray(analysis.criticalIssues) && analysis.criticalIssues.length) {
      blocks.push(b.p('Critical issues — what they mean and exactly how to fix them:'));
      blocks.push(b.tasks(analysis.criticalIssues.slice(0, 10).map((c: any) => ({
        title: String(c.name || 'Issue'),
        priority: normPriority(String(c.severity || 'high')),
        detail: [
          c.meaning && `What it means: ${c.meaning}`,
          c.whyNow && `Why it matters now: ${c.whyNow}`,
          c.fix && `Fix: ${c.fix}`,
          (c.effortImpact || c.who) && `${c.effortImpact || ''}${c.effortImpact && c.who ? ' — ' : ''}${c.who ? `Owner: ${c.who}` : ''}`,
        ].filter(Boolean).join('  •  '),
      }))));
    }
    if (Array.isArray(analysis.quickWins) && analysis.quickWins.length) {
      blocks.push(b.p('Quick wins (under 2 hours, direct ranking impact):'));
      blocks.push(b.list(analysis.quickWins.slice(0, 8)));
    }
    // Only surface the LLM Lighthouse / CWV narrative when real PageSpeed data
    // actually came back — otherwise these degrade into "No data" filler lines.
    const psiOk = !!(data.pagespeed && !data.pagespeed.error && data.pagespeed.performanceScore != null);
    if (psiOk && Array.isArray(analysis.lighthouse) && analysis.lighthouse.length) {
      blocks.push(b.p('Lighthouse breakdown:'));
      blocks.push(b.list(analysis.lighthouse.slice(0, 4).map((l: any) =>
        `${l.category} ${l.score ?? ''} — ${l.meaning || ''}${Array.isArray(l.topFailures) && l.topFailures.length ? ` Top failures: ${l.topFailures.join('; ')}.` : ''}${l.fix ? ` Fix: ${l.fix}` : ''}`)));
    }
    if (psiOk && (data.pagespeed!.lcpMs != null || data.pagespeed!.cls != null) && Array.isArray(analysis.coreWebVitals) && analysis.coreWebVitals.length) {
      blocks.push(b.p('Core Web Vitals:'));
      blocks.push(b.list(analysis.coreWebVitals.slice(0, 4).map((v: any) =>
        `${v.metric} (${v.status || '—'}${v.value ? `, ${v.value}` : ''}): ${v.cause || ''}${v.fix ? ` → ${v.fix}` : ''}`)));
    }
    if (analysis.siteHealthSummary) blocks.push(b.p(analysis.siteHealthSummary));
  }

  const notes: string[] = [];
  data.robotsTxt.issues.forEach((i) => notes.push(i));
  data.sitemap.issues.forEach((i) => notes.push(i));
  if (data.pagespeed?.error) notes.push('PageSpeed/Lighthouse unavailable — add PAGESPEED_API_KEY for reliable Google data.');
  if (notes.length) blocks.push(b.note(notes.join('  •  ')));

  return {
    tag: 'SEO Audit',
    title: `Audit complete — ${data.origin.replace(/^https?:\/\//, '')}`,
    blocks,
    data,
  };
}

/* ------------------------------------------------------------------ */
/* Optional LLM narrative — senior technical-SEO consultant voice.     */
/* Runs ONLY over the measured crawl / Lighthouse / SEOptimer data.    */
/* ------------------------------------------------------------------ */
async function auditNarrative(data: AuditData, totalIssues: number): Promise<any | null> {
  if (!llmConfigured()) return null;

  const ps = data.pagespeed;
  const so = data.seoptimer;
  const payload = {
    origin: data.origin,
    https: data.https,
    pagesCrawled: data.pagesCrawled,
    totalIssues,
    robotsTxt: { found: data.robotsTxt.found, disallowAll: data.robotsTxt.disallowAll, sitemaps: data.robotsTxt.sitemaps.length },
    sitemap: { found: data.sitemap.found, urlCount: data.sitemap.urlCount },
    crawlStats: data.stats,       // htmlPages, indexable, avgWords, withSchema, httpsPages, avgResponseMs
    wholeSiteCounts: data.counts, // uncapped counts: 404s, dup/missing titles/metas, thin, noindex, canonical, alt, brokenInternalLinks…
    lighthouse: ps && !ps.error ? {
      performanceScore: ps.performanceScore, seoScore: ps.seoScore,
      accessibilityScore: ps.accessibilityScore, bestPracticesScore: ps.bestPracticesScore,
      fieldData: ps.fieldData,
      coreWebVitals: { lcpMs: ps.lcpMs, cls: ps.cls, inpMs: ps.inpMs, ttfbMs: ps.ttfbMs },
      topOpportunities: ps.opportunities.slice(0, 6),
      failingSeoAudits: ps.seoIssues,
      failingAccessibilityAudits: ps.accessibilityIssues,
      failingBestPractices: ps.bestPracticeIssues,
    } : null,
    seoptimer: so && so.ok ? {
      grades: Object.fromEntries(Object.entries(so.scores).map(([k, v]) => [k, v.grade])),
      backlinks: so.backlinks,
      topRecommendations: so.recommendations.slice(0, 10),
      keywordRankings: so.keywordRankings.slice(0, 10),
    } : null,
    issues: data.issues.map((g) => ({
      id: g.id, label: g.label, category: g.category, severity: g.severity,
      count: g.count, explanation: g.explanation,
      affectedUrls: g.examples.slice(0, 20), // real URLs the crawler saw
    })),
  };

  const system = `You are a senior technical SEO consultant writing an audit report for a digital marketing agency. This report goes directly to the client. The agency's reputation depends on the quality of your analysis.

You will receive crawl data, Lighthouse scores, Core Web Vitals, SEOptimer grades, and a prioritized issue list. Produce this structure:

EXECUTIVE SUMMARY
3-4 sentences maximum. Lead with the single most critical finding and its direct business consequence. State the overall site health honestly. End with the one action that will have the biggest impact in the next 30 days. Write this like a board briefing — zero filler.

CRITICAL ISSUES
For each CRITICAL and HIGH severity issue:
Issue name (plain English, not technical jargon)
What it means: one sentence a non-technical marketing director understands
Why it matters right now: the specific SEO consequence — lost indexing, suppressed rankings, poor Core Web Vitals score affecting Page Experience signals, etc.
Exact fix: not "improve your title tags" but "Rewrite the title tag on [URL] from '[current title]' to follow this format: [Primary Keyword] — [Secondary Keyword] | [Brand Name], keeping it under 60 characters"
Effort vs Impact: [LOW/MED/HIGH effort] — [LOW/MED/HIGH impact]
Who does it: Developer / Content Writer / SEO Manager

QUICK WINS
Issues fixable in under 2 hours with direct ranking impact. List these separately and explicitly. Agency owners love this section — it shows immediate value without a full engagement.

LIGHTHOUSE BREAKDOWN
For each category score provided (Performance, SEO, Accessibility, Best Practices):
- Score and what it means in plain English
- The top 2-3 failing audits driving that score down
- The fix that moves the needle most

CORE WEB VITALS
For each metric provided (LCP, CLS, FID/INP):
- Pass or fail and the measured value
- What is causing the problem based on the data
- Specific fix with implementation detail

SITE HEALTH SUMMARY
A single confident paragraph summarizing overall crawl health — pages crawled, issues found by severity, what the site does well, what needs immediate attention.

Rules you must never break:
- Never invent a metric, score, or URL not in the data passed to you
- Never use hedging language — no "may", "could", "might", "consider"
- Every recommendation must include the actual URL or page type affected
- If a data source failed or returned no data, say so explicitly in one line rather than skipping that section entirely
- Severity hierarchy: CRITICAL (indexing/crawling broken), HIGH (significant rankings suppressed), MEDIUM (missed opportunity), LOW (polish and best practice)
- Never pad the report. If there are only 2 critical issues, write 2 — do not invent problems to fill space

OUTPUT FORMAT — the site snapshot, the raw Lighthouse/SEOptimer tables and the full issue table are already rendered from measured data around your narrative. Return ONLY minified JSON with exactly these keys:
{"executiveSummary": string,
 "criticalIssues": [{"name": string, "severity": "critical|high", "meaning": string, "whyNow": string, "fix": string (name the actual affected URL(s) from affectedUrls), "effortImpact": string (e.g. "LOW effort — HIGH impact"), "who": "Developer|Content Writer|SEO Manager"}],
 "quickWins": string[],
 "lighthouse": [{"category": string, "score": string, "meaning": string, "topFailures": string[], "fix": string}] (only categories present in the data),
 "coreWebVitals": [{"metric": string, "status": "pass|fail", "value": string, "cause": string, "fix": string}] (only metrics present in the data),
 "siteHealthSummary": string}
Only include CRITICAL and HIGH issues in criticalIssues. If Lighthouse or SEOptimer data is null, state that in one line inside the relevant section rather than fabricating it.`;

  try {
    return await completeJSON<any>(system, JSON.stringify(payload), { temperature: 0.3, maxTokens: 5000 });
  } catch {
    return null; // report still renders fully with the deterministic blocks
  }
}
