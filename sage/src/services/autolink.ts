import { config } from '../config';
import { followChain } from '../lib/http';
import { fetchPage } from '../sources/render';
import { assertPublicUrl } from '../lib/ssrf';
import { parseHtml, safeOrigin } from '../lib/html';
import { pool } from '../lib/concurrency';
import { Report, b } from '../lib/report';
import { dataPath, safeDomainKey, readJson, writeJson } from '../lib/jsonStore';
import {
  WpCreds, resolveCreds, wordpressConfigured, findPostBySlug, updatePost, getPostContent, slugFromUrl,
} from './cms';

/**
 * Automated Internal Linking (on-page execution).
 *
 * The single highest-ROI on-page task the market automates (Link Whisper, Alli AI,
 * AIOSEO): find contextually relevant internal-link opportunities across a site and
 * insert them. SAGE already crawls the site and builds the link graph for the audit;
 * this turns that graph into real, applied on-page fixes.
 *
 * How it works (deterministic first — no LLM needed for the core, so it is cheap and
 * predictable):
 *   1. Crawl the same-origin site (indexable HTML pages only).
 *   2. Build a TARGET INDEX: each page contributes an anchor phrase it deserves to be
 *      linked to by (its H1/title, brand suffix stripped). Ambiguous anchors claimed
 *      by more than one page are dropped so we never link to the wrong page.
 *   3. Find OPPORTUNITIES: for every source page, scan its visible text for a target's
 *      anchor phrase that (a) is not the page itself, (b) is not already linked, and
 *      (c) appears as a whole phrase in the body. Capped per source and per target so
 *      the result reads natural, never spammy.
 *   4. DRY-RUN by default: report every proposed link (source -> anchor -> target) for
 *      review. This alone matches what paid "internal link suggestion" tools sell.
 *   5. APPLY (opt-in, WordPress connected): read each source post's raw body, insert
 *      the link with a tag-aware inserter that never touches existing anchors,
 *      headings, scripts or block comments, and push it back via the REST API.
 *
 * Nothing is published live that was not already live — we edit existing post bodies
 * in place, and only when `apply` is explicitly set.
 */

/* ---------------------------------- Types --------------------------------- */

interface LinkPage {
  url: string;
  norm: string;
  title: string;
  h1: string;
  text: string;
  wordCount: number;
  noindex: boolean;
  outLinks: Set<string>;   // normalized internal links already on the page
  slug: string;
}

interface Target {
  anchor: string;          // display anchor (original casing)
  anchorLower: string;
  url: string;
  norm: string;
}

export interface LinkOpportunity {
  sourceUrl: string;
  targetUrl: string;
  anchor: string;
  status: 'proposed' | 'inserted' | 'skipped' | 'failed';
  reason?: string;
  postId?: number;
}

export interface AutoLinkRun {
  ranAt: string;
  origin: string;
  domain: string;
  apply: boolean;
  wpConfigured: boolean;
  pagesScanned: number;
  opportunities: number;
  inserted: number;
  postsUpdated: number;
  orphansHelped: number;
  items: LinkOpportunity[];
}

/* --------------------------------- Tuning --------------------------------- */

const DEFAULT_MAX_PAGES = 40;
const HARD_MAX_PAGES = 150;
const DEFAULT_MAX_PER_PAGE = 3;   // new internal links inserted per source page
const MAX_INBOUND_PER_TARGET = 5; // avoid every page linking to the same target
const MIN_TARGET_WORDS = 150;     // don't send links to thin pages
const MAX_APPLY_POSTS = 25;       // cap WP writes per run

// Anchors that are navigation/boilerplate, never a good contextual link phrase.
const GENERIC = new Set([
  'home', 'homepage', 'about', 'about us', 'contact', 'contact us', 'blog', 'services',
  'products', 'shop', 'store', 'privacy policy', 'terms', 'terms of service', 'login',
  'sign in', 'sign up', 'cart', 'search', 'menu', 'faq', 'faqs', 'news', 'portfolio',
  'gallery', 'team', 'careers', 'pricing', 'get started', 'read more', 'learn more',
]);

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

/** Whole-phrase, case-insensitive, whitespace-flexible matcher for an anchor. */
function phraseRegex(phrase: string): RegExp {
  const esc = phrase.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(^|[^\\w])(${esc})(?![\\w])`, 'i');
}

/**
 * Clean a candidate anchor phrase: strip a trailing brand suffix, enforce a safe
 * length/word-count, and reject generic navigation labels. Returns null when the
 * phrase is not a safe anchor.
 */
function cleanAnchorPhrase(raw: string): string | null {
  let a = (raw || '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  // Strip a trailing pipe/dash-separated brand segment ("Topic | Acme" -> "Topic").
  const stripped = a.replace(/\s*[|–—-]\s*[^|–—-]{2,40}$/, '').trim();
  if (stripped.split(' ').length >= 2) a = stripped;
  const words = a.split(' ');
  if (words.length < 2 || words.length > 6) return null;
  if (a.length < 8) return null;
  if (!/[a-z]/i.test(a)) return null;
  if (GENERIC.has(a.toLowerCase())) return null;
  return a;
}

/**
 * The anchor phrases a page deserves inbound links for. Two sources so we catch more
 * real opportunities without lowering quality: the page's H1/title, and its URL slug
 * (client sites — especially WordPress — use descriptive slugs like
 * "best-running-shoes-for-flat-feet" even when the title is brand-heavy). Both pass
 * the same safety gates.
 */
function deriveAnchors(p: LinkPage): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (s: string | null) => { if (s && !seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); out.push(s); } };
  add(cleanAnchorPhrase(p.h1 || p.title || ''));
  add(cleanAnchorPhrase(p.slug));
  return out;
}

/* ---------------------------------- Crawl --------------------------------- */

async function crawlSite(startUrlRaw: string, maxPages: number): Promise<{ origin: string; pages: LinkPage[] }> {
  let startUrl = startUrlRaw.trim();
  if (!/^https?:\/\//i.test(startUrl)) startUrl = 'https://' + startUrl;
  startUrl = normalize(startUrl);

  // Resolve the seed's redirect chain so the crawl origin matches where the site lives.
  try {
    const landed = (await followChain(startUrl)).final;
    if (landed && landed.status >= 200 && landed.status < 400 && safeOrigin(landed.url)) startUrl = normalize(landed.url);
  } catch { /* keep seed */ }

  const origin = safeOrigin(startUrl) || '';
  if (!origin) throw new Error('Invalid URL');
  await assertPublicUrl(startUrl); // SSRF guard

  const cap = Math.min(Math.max(maxPages, 1), HARD_MAX_PAGES);
  const pages: LinkPage[] = [];
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
        if (safeOrigin(n) === origin && !isAsset(n) && !enqueued.has(n) && enqueued.size < maxFetches) {
          enqueued.add(n); queue.push(n);
        }
        return;
      }
      if (res.status !== 200 || !/text\/html/i.test(res.contentType) || !res.body) return;
      const parse = parseHtml(res.body, res.finalUrl || url);
      const out = new Set<string>();
      for (const link of parse.internalLinks) {
        const n = normalize(link);
        if (safeOrigin(n) !== origin || isAsset(n)) continue;
        out.add(n);
        if (!enqueued.has(n) && enqueued.size < maxFetches) { enqueued.add(n); queue.push(n); }
      }
      pages.push({
        url: res.finalUrl || url,
        norm: normalize(res.finalUrl || url),
        title: parse.title || '',
        h1: parse.h1[0] || '',
        text: parse.text,
        wordCount: parse.wordCount,
        noindex: parse.noindex,
        outLinks: out,
        slug: slugFromUrl(res.finalUrl || url),
      });
    });
  }

  return { origin, pages };
}

/* ------------------------------ Opportunities ----------------------------- */

function buildTargets(origin: string, pages: LinkPage[]): Target[] {
  const homeNorm = normalize(origin + '/');
  const byAnchor = new Map<string, { t: Target; page: LinkPage }[]>();
  for (const p of pages) {
    if (p.noindex) continue;
    if (p.norm === homeNorm || p.norm === normalize(origin)) continue; // homepage: everything links to it already
    if (p.wordCount < MIN_TARGET_WORDS) continue;                      // never point links at thin pages
    for (const anchor of deriveAnchors(p)) {
      const key = anchor.toLowerCase();
      const arr = byAnchor.get(key) || [];
      arr.push({ t: { anchor, anchorLower: key, url: p.url, norm: p.norm }, page: p });
      byAnchor.set(key, arr);
    }
  }
  // When more than one page claims the same anchor, pick the page whose SLUG best
  // matches the anchor words (that page is what a reader means by the phrase); only
  // when it is a genuine tie do we drop the anchor, so a link never points at the
  // wrong page. This finds more links than dropping every collision outright.
  const targets: Target[] = [];
  for (const [key, arr] of byAnchor) {
    if (arr.length === 1) { targets.push(arr[0].t); continue; }
    const words = key.split(' ');
    const scored = arr
      .map((x) => ({ t: x.t, score: words.filter((w) => x.page.slug.includes(w)).length }))
      .sort((a, c) => c.score - a.score);
    if (scored[0].score > (scored[1]?.score ?? -1)) targets.push(scored[0].t);
  }
  // Longer, more specific anchors first.
  return targets.sort((a, c) => c.anchor.split(' ').length - a.anchor.split(' ').length);
}

function findOpportunities(pages: LinkPage[], targets: Target[], maxPerPage: number): LinkOpportunity[] {
  const inbound = new Map<string, number>();   // target.norm -> inbound links proposed this run
  const opportunities: LinkOpportunity[] = [];

  for (const source of pages) {
    if (source.noindex || !source.text) continue;
    let perSource = 0;
    for (const t of targets) {
      if (perSource >= maxPerPage) break;
      if (t.norm === source.norm) continue;                      // no self-links
      if (source.outLinks.has(t.norm)) continue;                 // already linked
      if ((inbound.get(t.norm) || 0) >= MAX_INBOUND_PER_TARGET) continue;
      if (!phraseRegex(t.anchor).test(source.text)) continue;    // phrase not mentioned in body
      opportunities.push({ sourceUrl: source.url, targetUrl: t.url, anchor: t.anchor, status: 'proposed' });
      inbound.set(t.norm, (inbound.get(t.norm) || 0) + 1);
      perSource++;
    }
  }
  return opportunities;
}

/* ----------------------------- Link insertion ----------------------------- */

/**
 * Insert a single internal link into raw HTML, tag-aware: it wraps the FIRST safe,
 * whole-phrase occurrence of `phrase` in visible text and never edits inside an
 * existing <a>, a heading, a <script>/<style>, or a WordPress block comment.
 */
export function insertLink(raw: string, phrase: string, url: string): { html: string; inserted: boolean } {
  const re = phraseRegex(phrase);
  const parts = raw.split(/(<!--[\s\S]*?-->|<[^>]+>)/g);
  let inAnchor = false, inHeading = 0, inSkip = false;

  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (!seg) continue;
    if (/^<!--/.test(seg)) continue;                 // block/HTML comment — skip
    if (/^</.test(seg)) {
      const t = seg.toLowerCase();
      if (/^<a\b/.test(t)) inAnchor = true;
      else if (/^<\/a>/.test(t)) inAnchor = false;
      else if (/^<h[1-6]\b/.test(t)) inHeading++;
      else if (/^<\/h[1-6]>/.test(t)) inHeading = Math.max(0, inHeading - 1);
      else if (/^<(script|style)\b/.test(t)) inSkip = true;
      else if (/^<\/(script|style)>/.test(t)) inSkip = false;
      continue;
    }
    if (inAnchor || inHeading > 0 || inSkip) continue;
    const m = seg.match(re);
    if (m) {
      const matched = m[2].replace(/\$/g, '$$$$'); // escape $ for the replacement string
      parts[i] = seg.replace(re, `$1<a href="${url}">${matched}</a>`);
      return { html: parts.join(''), inserted: true };
    }
  }
  return { html: raw, inserted: false };
}

/* ------------------------------- Apply to WP ------------------------------ */

async function applyToWordPress(opportunities: LinkOpportunity[], creds: WpCreds): Promise<LinkOpportunity[]> {
  // Group by source page so each post is fetched and written exactly once.
  const bySource = new Map<string, LinkOpportunity[]>();
  for (const o of opportunities) {
    const arr = bySource.get(o.sourceUrl) || [];
    arr.push(o);
    bySource.set(o.sourceUrl, arr);
  }

  const results: LinkOpportunity[] = [];
  let postsTouched = 0;

  for (const [sourceUrl, ops] of bySource) {
    if (postsTouched >= MAX_APPLY_POSTS) {
      for (const o of ops) results.push({ ...o, status: 'skipped', reason: `run cap of ${MAX_APPLY_POSTS} posts reached` });
      continue;
    }

    const slug = slugFromUrl(sourceUrl);
    if (!slug) { for (const o of ops) results.push({ ...o, status: 'skipped', reason: 'could not derive a slug from the source URL' }); continue; }

    let target: Awaited<ReturnType<typeof findPostBySlug>> = null;
    try { target = await findPostBySlug(creds, slug); } catch { /* handled below */ }
    if (!target) { for (const o of ops) results.push({ ...o, status: 'skipped', reason: 'no matching WordPress post/page for this URL' }); continue; }

    let body: string;
    try { body = (await getPostContent(creds, target.type, target.id)).raw; }
    catch (e: any) { for (const o of ops) results.push({ ...o, status: 'failed', reason: `read post: ${String(e?.message || e)}` }); continue; }

    if (!body) { for (const o of ops) results.push({ ...o, status: 'skipped', reason: 'post body was empty or not editable' }); continue; }

    let changed = false;
    const staged: LinkOpportunity[] = [];
    for (const o of ops) {
      const ins = insertLink(body, o.anchor, o.targetUrl);
      if (ins.inserted) { body = ins.html; changed = true; staged.push({ ...o, status: 'inserted', postId: target.id }); }
      else staged.push({ ...o, status: 'skipped', reason: 'anchor not found in editable body (likely built by a page builder, not post content)' });
    }

    if (changed) {
      try {
        await updatePost(creds, target.type, target.id, { content: body });
        postsTouched++;
        results.push(...staged);
      } catch (e: any) {
        for (const o of ops) results.push({ ...o, status: 'failed', reason: `write post: ${String(e?.message || e)}` });
      }
    } else {
      results.push(...staged);
    }
  }

  return results;
}

/* ------------------------------- Orchestrate ------------------------------ */

export async function runAutoLink(input: {
  startUrl: string;
  apply?: boolean;
  maxPages?: number;
  maxPerPage?: number;
  creds?: Partial<WpCreds>;
}): Promise<Report> {
  const startUrl = (input.startUrl || '').trim();
  if (!startUrl) {
    return { tag: 'Internal Links', title: 'No URL', blocks: [b.note('Give me a site URL, e.g. "internal links for https://clientsite.com".')] };
  }

  const maxPages = Math.min(input.maxPages || DEFAULT_MAX_PAGES, HARD_MAX_PAGES);
  const maxPerPage = Math.min(Math.max(input.maxPerPage || DEFAULT_MAX_PER_PAGE, 1), 8);

  let crawl: { origin: string; pages: LinkPage[] };
  try { crawl = await crawlSite(startUrl, maxPages); }
  catch (e: any) { return { tag: 'Internal Links', title: 'Could not crawl that site', blocks: [b.note(String(e?.message || e))] }; }
  const { origin, pages } = crawl;
  if (!pages.length) {
    return { tag: 'Internal Links', title: `No crawlable pages — ${origin}`, blocks: [b.note('The crawler could not read any indexable HTML pages. The site may block bots, render entirely client-side, or sit behind auth.')] };
  }

  const targets = buildTargets(origin, pages);
  let opportunities = findOpportunities(pages, targets, maxPerPage);

  const creds = resolveCreds(input.creds);
  const wpConfigured = wordpressConfigured(creds);
  const apply = !!input.apply && wpConfigured && opportunities.length > 0;

  if (apply) {
    opportunities = await applyToWordPress(opportunities, creds);
  }

  // Orphan pages (no inbound internal links found anywhere in the crawl) that this
  // run gives at least one inbound link to — the clearest "we fixed something" signal.
  const linkedTargets = new Set(opportunities.filter((o) => o.status === 'inserted' || o.status === 'proposed').map((o) => normalize(o.targetUrl)));
  const inboundExisting = new Set<string>();
  for (const p of pages) for (const l of p.outLinks) inboundExisting.add(l);
  const orphansHelped = [...linkedTargets].filter((t) => !inboundExisting.has(t)).length;

  const run: AutoLinkRun = {
    ranAt: new Date().toISOString(),
    origin,
    domain: safeDomainKey(origin),
    apply,
    wpConfigured,
    pagesScanned: pages.length,
    opportunities: opportunities.length,
    inserted: opportunities.filter((o) => o.status === 'inserted').length,
    postsUpdated: new Set(opportunities.filter((o) => o.status === 'inserted').map((o) => o.postId)).size,
    orphansHelped,
    items: opportunities,
  };

  await storeRun(run);
  return toReport(run, { apply, wpConfigured });
}

/* -------------------------------- Storage --------------------------------- */

function historyPath(domain: string): string {
  return dataPath('autolinks', `${safeDomainKey(domain)}.json`);
}

async function storeRun(run: AutoLinkRun): Promise<void> {
  const file = historyPath(run.domain);
  const existing = await readJson<{ domain: string; runs: AutoLinkRun[] }>(file, { domain: run.domain, runs: [] });
  existing.domain = run.domain;
  existing.runs.unshift(run);
  existing.runs = existing.runs.slice(0, 50);
  await writeJson(file, existing);
}

export async function autoLinkHistory(domain: string): Promise<any> {
  return readJson<{ domain: string; runs: AutoLinkRun[] }>(historyPath(domain), { domain: safeDomainKey(domain), runs: [] });
}

/* --------------------------------- Report --------------------------------- */

const short = (u: string) => u.replace(/^https?:\/\//, '').replace(/\/$/, '');

function toReport(run: AutoLinkRun, ctx: { apply: boolean; wpConfigured: boolean }): Report {
  const blocks = [];

  blocks.push(b.p(
    `Scanned ${run.pagesScanned} page${run.pagesScanned === 1 ? '' : 's'} on ${short(run.origin)} and found ${run.opportunities} internal-link opportunit${run.opportunities === 1 ? 'y' : 'ies'}` +
    (ctx.apply ? `. Inserted ${run.inserted} link${run.inserted === 1 ? '' : 's'} across ${run.postsUpdated} WordPress post${run.postsUpdated === 1 ? '' : 's'}.` : ' (dry run — nothing changed yet).'),
  ));

  blocks.push(b.kv([
    { k: 'Pages scanned', v: String(run.pagesScanned) },
    { k: 'Link opportunities', v: String(run.opportunities) },
    { k: 'Orphan pages given a link', v: String(run.orphansHelped) },
    { k: 'Mode', v: ctx.apply ? 'APPLIED to WordPress' : (ctx.wpConfigured ? 'Dry run (WordPress connected)' : 'Dry run (WordPress not connected)') },
    ...(ctx.apply ? [
      { k: 'Links inserted', v: String(run.inserted) },
      { k: 'Posts updated', v: String(run.postsUpdated) },
    ] : []),
  ]));

  const shown = run.items.slice(0, 25);
  if (shown.length) {
    blocks.push(b.p(ctx.apply ? 'Internal links (source → anchor → target):' : 'Proposed internal links (source → anchor → target):'));
    blocks.push(b.table(
      ['Source page', 'Anchor text', 'Links to', ...(ctx.apply ? ['Status'] : [])],
      shown.map((o) => [
        short(o.sourceUrl),
        o.anchor,
        short(o.targetUrl),
        ...(ctx.apply ? [o.status === 'inserted' ? '✓ inserted' : o.status === 'failed' ? `✗ ${o.reason || 'failed'}` : `— ${o.reason || 'skipped'}`] : []),
      ]),
    ));
    if (run.items.length > shown.length) blocks.push(b.note(`Showing ${shown.length} of ${run.items.length}. The full list is in the run data.`));
  } else {
    blocks.push(b.note('No safe internal-link opportunities were found. Pages may already be well-linked, or titles/H1s are too generic to match confidently.'));
  }

  if (!ctx.apply && run.opportunities > 0) {
    blocks.push(b.note(ctx.wpConfigured
      ? 'This was a dry run. Re-run with "apply" (or set apply=true) to insert these links into the matching WordPress posts. Existing links, headings and page-builder content are never touched.'
      : 'Connect WordPress (WP_URL / WP_USERNAME / WP_APP_PASSWORD) to let SAGE insert these links automatically. Until then, the list above is a ready-to-action plan.'));
  }
  blocks.push(b.note('Anchors come from each page\'s own H1/title (brand suffix stripped); ambiguous anchors claimed by more than one page are dropped so a link never points at the wrong page. Deterministic, so no AI cost.'));

  return { tag: 'Internal Links', title: `Internal linking — ${short(run.origin)}${ctx.apply ? ` (${run.inserted} inserted)` : ` (${run.opportunities} found)`}`, blocks, data: run };
}
