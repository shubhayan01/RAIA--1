import * as cheerio from 'cheerio';
import { config } from '../config';
import { followChain, absolutize } from '../lib/http';
import { fetchPage } from '../sources/render';
import { assertPublicUrl } from '../lib/ssrf';
import { safeOrigin } from '../lib/html';
import { pool } from '../lib/concurrency';
import { Report, b } from '../lib/report';
import { dataPath, safeDomainKey, readJson, writeJson } from '../lib/jsonStore';
import {
  WpCreds, resolveCreds, wordpressConfigured, findPostBySlug, updatePost, getPostContent, slugFromUrl,
} from './cms';

/**
 * Automated Structured Data / JSON-LD injection (on-page execution).
 *
 * The third on-page auto-fix the market leaders sell (Alli AI, Page Optimizer Pro,
 * AIOSEO): generate valid schema.org JSON-LD and put it on the page. SAGE already
 * detects whether a page HAS schema; this generates the RIGHT schema and injects it.
 *
 * Design principles that keep it safe:
 *   - ONLY-MISSING: it reads the schema types already on the live page and generates
 *     ONLY types that are absent. On a Yoast/RankMath site those plugins already emit
 *     Organization/Article/Breadcrumb, so SAGE detects them and adds nothing — no
 *     duplicate, competing markup. On a bare site with no schema, it adds real value.
 *   - NO FABRICATION: every field is read from the page itself (og tags, meta, H1,
 *     headings, URL path). Fields we cannot read (author, publish date) are omitted,
 *     never invented.
 *   - DRY-RUN by default: it reports the exact JSON-LD it would add. Apply (opt-in,
 *     WordPress connected) appends the <script type="application/ld+json"> to the post
 *     body, guarded by a marker so re-runs are idempotent.
 *
 * Types generated (deterministically): Organization + WebSite (home), BreadcrumbList
 * (from the URL path), BlogPosting (article/blog pages), FAQPage (pages with a
 * detectable Q&A block).
 */

/* ---------------------------------- Types --------------------------------- */

interface SchemaPage {
  url: string;
  norm: string;
  slug: string;
  title: string;
  metaDescription: string;
  h1: string;
  ogSiteName: string;
  ogImage: string;
  ogType: string;
  publishedTime: string;        // date VALUE for the schema (meta or a <time> tag)
  articlePublishedMeta: string; // article:published_time meta ONLY — a real article signal
  modifiedTime: string;
  existingTypes: Set<string>;
  faq: { q: string; a: string }[];
  noindex: boolean;
  wordCount: number;
}

export interface SchemaEntry {
  url: string;
  addedTypes: string[];
  jsonld: string;               // the JSON-LD (array) that would be / was injected
  status: 'proposed' | 'injected' | 'skipped' | 'failed';
  reason?: string;
  postId?: number;
}

export interface SchemaRun {
  ranAt: string;
  origin: string;
  domain: string;
  apply: boolean;
  wpConfigured: boolean;
  pagesScanned: number;
  pagesWithNewSchema: number;
  objectsGenerated: number;
  injected: number;
  postsUpdated: number;
  byType: Record<string, number>;
  items: SchemaEntry[];
}

/* --------------------------------- Tuning --------------------------------- */

const DEFAULT_MAX_PAGES = 40;
const HARD_MAX_PAGES = 150;
const MAX_APPLY_POSTS = 25;
const MARKER = '<!-- SAGE schema -->';

/* -------------------------------- Helpers --------------------------------- */

function normalize(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) u.port = '';
    return u.toString();
  } catch {
    return url;
  }
}

function isAsset(url: string): boolean {
  return /\.(jpg|jpeg|png|gif|webp|svg|ico|css|js|json|pdf|zip|mp4|webm|woff2?|ttf|eot|xml)(\?|$)/i.test(url);
}

const titleize = (seg: string) =>
  decodeURIComponent(seg).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();

/** Collect every schema.org @type already declared on the page (string, array, or @graph). */
function collectExistingTypes($: cheerio.CheerioAPI): Set<string> {
  const types = new Set<string>();
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const t = node['@type'];
    if (typeof t === 'string') types.add(t);
    else if (Array.isArray(t)) t.forEach((x) => typeof x === 'string' && types.add(x));
    if (node['@graph']) walk(node['@graph']);
    for (const k of Object.keys(node)) if (typeof node[k] === 'object') walk(node[k]);
  };
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    try { walk(JSON.parse(raw)); } catch { /* ignore malformed */ }
  });
  return types;
}

/** Detect a Q&A block: headings ending in "?" followed by answer text. */
function extractFaq($: cheerio.CheerioAPI): { q: string; a: string }[] {
  const faq: { q: string; a: string }[] = [];
  $('h2, h3').each((_, el) => {
    if (faq.length >= 10) return;
    const q = $(el).text().replace(/\s+/g, ' ').trim();
    if (!/\?$/.test(q) || q.length < 12) return;
    const answer = $(el).nextUntil('h1, h2, h3').text().replace(/\s+/g, ' ').trim();
    if (answer.length >= 40) faq.push({ q, a: answer.slice(0, 900) });
  });
  return faq;
}

export function extractSignals(html: string, url: string): SchemaPage {
  const $ = cheerio.load(html);
  const og = (p: string) => $(`meta[property="${p}"], meta[name="${p}"]`).attr('content')?.trim() || '';
  const robots = $('meta[name="robots"]').attr('content')?.toLowerCase() || '';
  const bodyText = (() => { const c = $.root().clone(); c.find('script, style, noscript, svg, template').remove(); return c.text().replace(/\s+/g, ' ').trim(); })();
  return {
    url,
    norm: normalize(url),
    slug: slugFromUrl(url),
    title: $('title').first().text().replace(/\s+/g, ' ').trim(),
    metaDescription: $('meta[name="description"]').attr('content')?.trim() || '',
    h1: $('h1').first().text().replace(/\s+/g, ' ').trim(),
    ogSiteName: og('og:site_name'),
    ogImage: og('og:image') ? absolutize(og('og:image'), url) : '',
    ogType: og('og:type').toLowerCase(),
    publishedTime: og('article:published_time') || $('time[datetime]').first().attr('datetime') || '',
    articlePublishedMeta: og('article:published_time'),
    modifiedTime: og('article:modified_time') || '',
    existingTypes: collectExistingTypes($),
    faq: extractFaq($),
    noindex: /noindex/.test(robots),
    wordCount: bodyText ? bodyText.split(/\s+/).length : 0,
  };
}

/* ---------------------------------- Crawl --------------------------------- */

async function crawlSite(startUrlRaw: string, maxPages: number): Promise<{ origin: string; pages: SchemaPage[] }> {
  let startUrl = startUrlRaw.trim();
  if (!/^https?:\/\//i.test(startUrl)) startUrl = 'https://' + startUrl;
  startUrl = normalize(startUrl);
  try {
    const landed = (await followChain(startUrl)).final;
    if (landed && landed.status >= 200 && landed.status < 400 && safeOrigin(landed.url)) startUrl = normalize(landed.url);
  } catch { /* keep seed */ }

  const origin = safeOrigin(startUrl) || '';
  if (!origin) throw new Error('Invalid URL');
  await assertPublicUrl(startUrl); // SSRF guard

  const cap = Math.min(Math.max(maxPages, 1), HARD_MAX_PAGES);
  const pages: SchemaPage[] = [];
  const enqueued = new Set<string>([startUrl]);
  const queue: string[] = [startUrl];
  let fetched = 0;
  const maxFetches = cap * 4;

  while (queue.length && pages.length < cap && fetched < maxFetches) {
    const batch = queue.splice(0, config.crawl.concurrency);
    await pool(batch, config.crawl.concurrency, async (url) => {
      if (pages.length >= cap || fetched >= maxFetches) return;
      fetched++;
      const res = await fetchPage(url);
      if (res.redirected && res.location) {
        const n = normalize(res.location);
        if (safeOrigin(n) === origin && !isAsset(n) && !enqueued.has(n) && enqueued.size < maxFetches) { enqueued.add(n); queue.push(n); }
        return;
      }
      if (res.status !== 200 || !/text\/html/i.test(res.contentType) || !res.body) return;
      const $ = cheerio.load(res.body);
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href') || '';
        if (!href || /^(#|mailto:|tel:|javascript:)/i.test(href)) return;
        const n = normalize(absolutize(href, res.finalUrl || url).split('#')[0]);
        if (safeOrigin(n) !== origin || isAsset(n)) return;
        if (!enqueued.has(n) && enqueued.size < maxFetches) { enqueued.add(n); queue.push(n); }
      });
      pages.push(extractSignals(res.body, res.finalUrl || url));
    });
  }
  return { origin, pages };
}

/* ----------------------------- Schema builders ---------------------------- */

const CTX = 'https://schema.org';
const clean = (o: Record<string, any>) => { for (const k of Object.keys(o)) if (o[k] === '' || o[k] == null) delete o[k]; return o; };

function buildBreadcrumb(page: SchemaPage, origin: string): any | null {
  let path: string;
  try { path = new URL(page.url).pathname; } catch { return null; }
  const segs = path.split('/').filter(Boolean);
  if (!segs.length) return null; // home has no breadcrumb
  const items: any[] = [{ '@type': 'ListItem', position: 1, name: 'Home', item: origin }];
  let acc = origin;
  segs.forEach((seg, i) => {
    acc += '/' + seg;
    const last = i === segs.length - 1;
    items.push({ '@type': 'ListItem', position: i + 2, name: last ? (page.h1 || page.title || titleize(seg)) : titleize(seg), item: acc });
  });
  return { '@context': CTX, '@type': 'BreadcrumbList', itemListElement: items };
}

function buildArticle(page: SchemaPage, origin: string): any {
  return clean({
    '@context': CTX,
    '@type': 'BlogPosting',
    headline: (page.h1 || page.title).slice(0, 110),
    description: page.metaDescription,
    image: page.ogImage,
    datePublished: page.publishedTime,
    dateModified: page.modifiedTime || page.publishedTime,
    mainEntityOfPage: { '@type': 'WebPage', '@id': page.url },
    publisher: clean({ '@type': 'Organization', name: page.ogSiteName || new URL(origin).hostname }),
  });
}

function buildFaq(page: SchemaPage): any {
  return {
    '@context': CTX,
    '@type': 'FAQPage',
    mainEntity: page.faq.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  };
}

function isArticlePage(page: SchemaPage, isHome: boolean): boolean {
  if (isHome) return false;
  // A real article signal only: og:type=article, an article:published_time meta, or
  // a blog/news URL path. A bare <time> tag (common on About/contact pages) is NOT
  // enough — that previously mislabelled static pages as BlogPosting.
  return page.ogType === 'article'
    || !!page.articlePublishedMeta
    || /\/(blog|news|article|post|insights|resources|guide)s?\//i.test(page.url);
}

const hasAny = (have: Set<string>, want: string[]) => want.some((w) => have.has(w));

/** Generate the JSON-LD objects a page is MISSING. */
export function generate(page: SchemaPage, origin: string, isHome: boolean): { objects: any[]; types: string[] } {
  const objects: any[] = [];
  const types: string[] = [];
  const push = (obj: any | null, type: string) => { if (obj) { objects.push(obj); types.push(type); } };

  if (isHome) {
    if (!page.existingTypes.has('Organization')) {
      push(clean({ '@context': CTX, '@type': 'Organization', name: page.ogSiteName || page.title || new URL(origin).hostname, url: origin, logo: page.ogImage }), 'Organization');
    }
    if (!page.existingTypes.has('WebSite')) {
      push({ '@context': CTX, '@type': 'WebSite', name: page.ogSiteName || page.title || new URL(origin).hostname, url: origin,
        potentialAction: { '@type': 'SearchAction', target: { '@type': 'EntryPoint', urlTemplate: `${origin}/?s={search_term_string}` }, 'query-input': 'required name=search_term_string' } }, 'WebSite');
    }
  }

  if (!page.existingTypes.has('BreadcrumbList')) push(buildBreadcrumb(page, origin), 'BreadcrumbList');

  if (isArticlePage(page, isHome) && !hasAny(page.existingTypes, ['BlogPosting', 'Article', 'NewsArticle'])) {
    push(buildArticle(page, origin), 'BlogPosting');
  }

  if (page.faq.length >= 2 && !page.existingTypes.has('FAQPage')) push(buildFaq(page), 'FAQPage');

  return { objects, types };
}

/* ------------------------------- Apply to WP ------------------------------ */

async function injectToWordPress(entries: SchemaEntry[], creds: WpCreds): Promise<SchemaEntry[]> {
  const out: SchemaEntry[] = [];
  let touched = 0;
  for (const e of entries) {
    if (touched >= MAX_APPLY_POSTS) { out.push({ ...e, status: 'skipped', reason: `run cap of ${MAX_APPLY_POSTS} posts reached` }); continue; }
    const slug = slugFromUrl(e.url);
    if (!slug) { out.push({ ...e, status: 'skipped', reason: 'could not derive a slug from the URL' }); continue; }

    let target: Awaited<ReturnType<typeof findPostBySlug>> = null;
    try { target = await findPostBySlug(creds, slug); } catch { /* below */ }
    if (!target) { out.push({ ...e, status: 'skipped', reason: 'no matching WordPress post/page for this URL' }); continue; }

    let body: string;
    try { body = (await getPostContent(creds, target.type, target.id)).raw; }
    catch (err: any) { out.push({ ...e, status: 'failed', reason: `read post: ${String(err?.message || err)}` }); continue; }

    if (body.includes(MARKER)) { out.push({ ...e, status: 'skipped', reason: 'SAGE schema already present (idempotent)', postId: target.id }); continue; }

    const block = `\n${MARKER}\n<script type="application/ld+json">\n${e.jsonld}\n</script>\n`;
    try {
      await updatePost(creds, target.type, target.id, {
        content: body + block,
        meta: { sage_schema_jsonld: e.jsonld },
      });
      touched++;
      out.push({ ...e, status: 'injected', postId: target.id });
    } catch (err: any) {
      out.push({ ...e, status: 'failed', reason: `write post: ${String(err?.message || err)}` });
    }
  }
  return out;
}

/* ------------------------------- Orchestrate ------------------------------ */

export async function runSchema(input: {
  startUrl: string;
  apply?: boolean;
  maxPages?: number;
  creds?: Partial<WpCreds>;
}): Promise<Report> {
  const startUrl = (input.startUrl || '').trim();
  if (!startUrl) return { tag: 'Schema', title: 'No URL', blocks: [b.note('Give me a site URL, e.g. "add schema to https://clientsite.com".')] };

  const maxPages = Math.min(input.maxPages || DEFAULT_MAX_PAGES, HARD_MAX_PAGES);
  let crawl: { origin: string; pages: SchemaPage[] };
  try { crawl = await crawlSite(startUrl, maxPages); }
  catch (e: any) { return { tag: 'Schema', title: 'Could not crawl that site', blocks: [b.note(String(e?.message || e))] }; }
  const { origin, pages } = crawl;
  if (!pages.length) return { tag: 'Schema', title: `No crawlable pages — ${origin}`, blocks: [b.note('The crawler could not read any indexable HTML pages. The site may block bots or render entirely client-side.')] };

  const homeNorm = normalize(origin + '/');
  const homeNormBare = normalize(origin);

  let entries: SchemaEntry[] = [];
  const byType: Record<string, number> = {};
  for (const page of pages) {
    if (page.noindex) continue;
    // Treat both the bare origin and origin+"/" as the home page.
    const isHome = page.norm === homeNorm || page.norm === homeNormBare;
    const { objects, types } = generate(page, origin, isHome);
    if (!objects.length) continue;
    for (const t of types) byType[t] = (byType[t] || 0) + 1;
    entries.push({ url: page.url, addedTypes: types, jsonld: JSON.stringify(objects.length === 1 ? objects[0] : objects, null, 2), status: 'proposed' });
  }

  const creds = resolveCreds(input.creds);
  const wpConfigured = wordpressConfigured(creds);
  const apply = !!input.apply && wpConfigured && entries.length > 0;
  if (apply) entries = await injectToWordPress(entries, creds);

  const run: SchemaRun = {
    ranAt: new Date().toISOString(),
    origin,
    domain: safeDomainKey(origin),
    apply,
    wpConfigured,
    pagesScanned: pages.length,
    pagesWithNewSchema: entries.length,
    objectsGenerated: entries.reduce((s, e) => s + e.addedTypes.length, 0),
    injected: entries.filter((e) => e.status === 'injected').length,
    postsUpdated: new Set(entries.filter((e) => e.status === 'injected').map((e) => e.postId)).size,
    byType,
    items: entries,
  };

  await storeRun(run);
  return toReport(run, { apply, wpConfigured });
}

/* -------------------------------- Storage --------------------------------- */

function historyPath(domain: string): string { return dataPath('schema', `${safeDomainKey(domain)}.json`); }

async function storeRun(run: SchemaRun): Promise<void> {
  const file = historyPath(run.domain);
  const existing = await readJson<{ domain: string; runs: SchemaRun[] }>(file, { domain: run.domain, runs: [] });
  existing.domain = run.domain;
  existing.runs.unshift(run);
  existing.runs = existing.runs.slice(0, 50);
  await writeJson(file, existing);
}

export async function schemaHistory(domain: string): Promise<any> {
  return readJson<{ domain: string; runs: SchemaRun[] }>(historyPath(domain), { domain: safeDomainKey(domain), runs: [] });
}

/* --------------------------------- Report --------------------------------- */

const short = (u: string) => u.replace(/^https?:\/\//, '').replace(/\/$/, '');

function toReport(run: SchemaRun, ctx: { apply: boolean; wpConfigured: boolean }): Report {
  const blocks = [];
  blocks.push(b.p(
    `Scanned ${run.pagesScanned} page${run.pagesScanned === 1 ? '' : 's'} on ${short(run.origin)}. ` +
    `${run.pagesWithNewSchema} page${run.pagesWithNewSchema === 1 ? '' : 's'} are missing schema SAGE can add (${run.objectsGenerated} JSON-LD object${run.objectsGenerated === 1 ? '' : 's'})` +
    (ctx.apply ? `. Injected ${run.injected} into ${run.postsUpdated} WordPress post${run.postsUpdated === 1 ? '' : 's'}.` : ' — dry run, nothing changed yet.'),
  ));

  const typeSummary = Object.entries(run.byType).map(([t, n]) => `${t} ×${n}`);
  blocks.push(b.kv([
    { k: 'Pages scanned', v: String(run.pagesScanned) },
    { k: 'Pages needing schema', v: String(run.pagesWithNewSchema) },
    { k: 'Schema types generated', v: typeSummary.length ? typeSummary.join(' · ') : 'none' },
    { k: 'Mode', v: ctx.apply ? 'INJECTED to WordPress' : (ctx.wpConfigured ? 'Dry run (WordPress connected)' : 'Dry run (WordPress not connected)') },
    ...(ctx.apply ? [{ k: 'Objects injected', v: String(run.injected) }, { k: 'Posts updated', v: String(run.postsUpdated) }] : []),
  ]));

  const shown = run.items.slice(0, 25);
  if (shown.length) {
    blocks.push(b.p(ctx.apply ? 'Schema added (page → types):' : 'Proposed schema (page → types):'));
    blocks.push(b.table(
      ['Page', 'Schema types', ...(ctx.apply ? ['Status'] : [])],
      shown.map((e) => [
        short(e.url),
        e.addedTypes.join(', '),
        ...(ctx.apply ? [e.status === 'injected' ? '✓ injected' : e.status === 'failed' ? `✗ ${e.reason || 'failed'}` : `— ${e.reason || 'skipped'}`] : []),
      ]),
    ));
    if (run.items.length > shown.length) blocks.push(b.note(`Showing ${shown.length} of ${run.items.length}. Full list in the run data.`));
    // Show one concrete JSON-LD sample so the value is tangible.
    const sample = shown.find((e) => e.jsonld);
    if (sample) { blocks.push(b.p(`Example JSON-LD for ${short(sample.url)}:`)); blocks.push(b.note(sample.jsonld.slice(0, 1200))); }
  } else {
    blocks.push(b.note('No missing schema found. Every scanned page already declares the structured data SAGE generates (likely an SEO plugin is emitting it) — which is the correct outcome, not a failure.'));
  }

  if (!ctx.apply && run.pagesWithNewSchema > 0) {
    blocks.push(b.note(ctx.wpConfigured
      ? 'Dry run. Re-run with "apply" (or apply=true) to inject this JSON-LD into the matching WordPress posts. SAGE only adds types a page is MISSING, so it never duplicates existing plugin schema, and a marker keeps re-runs idempotent.'
      : 'Connect WordPress (WP_URL / WP_USERNAME / WP_APP_PASSWORD) to inject automatically. Until then, copy the JSON-LD above into each page\'s <head>.'));
  }
  if (ctx.apply) blocks.push(b.note('Note: WordPress may strip <script> tags for non-administrator roles or on multisite. Use an admin Application Password. The JSON-LD is also stored in the sage_schema_jsonld post meta as a durable record.'));
  blocks.push(b.note('All fields are read from each page (og tags, meta, H1, headings, URL path). Fields that cannot be read (author, publish date on non-article pages) are omitted, never invented.'));

  return { tag: 'Schema', title: `Schema markup — ${short(run.origin)}${ctx.apply ? ` (${run.injected} injected)` : ` (${run.objectsGenerated} proposed)`}`, blocks, data: run };
}
