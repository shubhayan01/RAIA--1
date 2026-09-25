import * as cheerio from 'cheerio';
import { requestOnce, followChain } from '../lib/http';

/**
 * Content-page fetch + structural analysis (SCRIBE's core reading primitive).
 *
 * Fetches a blog/article URL and extracts REAL, on-page content signals: word
 * count, heading outline, links, images, schema, and the readable body text.
 * Nothing here is inferred by the LLM — every number is measured from the page.
 * When a page can't be fetched we say so honestly rather than guessing.
 */

export interface PageContent {
  url: string;
  finalUrl: string;
  reachable: boolean;
  status: number;
  title: string | null;
  metaDescription: string | null;
  wordCount: number;
  readingTimeMins: number;
  headings: { level: number; text: string }[];
  h2Count: number;
  h3Count: number;
  paragraphCount: number;
  imageCount: number;
  linkCount: number;
  hasSchema: boolean;
  hasFAQ: boolean;
  hasTable: boolean;
  hasList: boolean;
  publishedHint: string | null;   // dateline / published time if exposed
  authorHint: string | null;      // byline if exposed
  bodyText: string;               // trimmed readable text (for LLM analysis)
  domain: string;
  error?: string;
}

export function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/** Fetch a URL (following redirects) and analyse its content structure. */
export async function fetchPageContent(rawUrl: string): Promise<PageContent> {
  const url = normalizeUrl(rawUrl);
  const base: PageContent = {
    url, finalUrl: url, reachable: false, status: 0,
    title: null, metaDescription: null, wordCount: 0, readingTimeMins: 0,
    headings: [], h2Count: 0, h3Count: 0, paragraphCount: 0, imageCount: 0, linkCount: 0,
    hasSchema: false, hasFAQ: false, hasTable: false, hasList: false,
    publishedHint: null, authorHint: null, bodyText: '', domain: domainOf(url),
  };

  // Resolve redirects to the final article URL.
  let target = url;
  try {
    const chain = await followChain(url);
    if (chain.final?.finalUrl) target = chain.final.finalUrl;
  } catch { /* keep default */ }

  const res = await requestOnce(target).catch(() => null);
  if (!res || !res.ok || !res.body) {
    base.status = res?.status || 0;
    base.error = res?.error || `page returned ${res?.status ?? 'no response'}`;
    return base;
  }
  base.reachable = true;
  base.finalUrl = res.finalUrl || target;
  base.status = res.status;
  base.domain = domainOf(base.finalUrl);

  analyze(res.body, base);
  return base;
}

function analyze(html: string, r: PageContent) {
  const $ = cheerio.load(html);

  r.title = clean($('meta[property="og:title"]').attr('content') || $('title').first().text()) || null;
  r.metaDescription = clean($('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '') || null;
  r.hasSchema = $('script[type="application/ld+json"]').length > 0;

  // Author / published hints (structured or common patterns) — real, not inferred.
  r.authorHint =
    clean($('meta[name="author"]').attr('content') || '') ||
    clean($('[rel="author"]').first().text() || '') ||
    clean($('.author, .byline, [class*="author"]').first().text() || '').slice(0, 80) || null;
  r.publishedHint =
    $('meta[property="article:published_time"]').attr('content')?.trim() ||
    $('time[datetime]').first().attr('datetime')?.trim() ||
    clean($('time').first().text() || '') || null;

  // Prefer the <article>/<main> region for content signals; fall back to <body>.
  const $scope = $('article').length ? $('article').first()
    : $('main').length ? $('main').first()
    : $('body');

  // Headings outline.
  $scope.find('h1, h2, h3').each((_, el) => {
    const level = Number(el.tagName.replace('h', '')) || 2;
    const text = clean($(el).text());
    if (text) r.headings.push({ level, text });
  });
  r.h2Count = r.headings.filter((h) => h.level === 2).length;
  r.h3Count = r.headings.filter((h) => h.level === 3).length;

  r.hasFAQ = /faq|frequently asked|people also ask/i.test($scope.text());
  r.hasTable = $scope.find('table').length > 0;
  r.hasList = $scope.find('ul li, ol li').length >= 3;
  r.imageCount = $scope.find('img').length;
  r.linkCount = $scope.find('a[href]').length;
  r.paragraphCount = $scope.find('p').length;

  // Readable text: strip noise, then measure.
  const $body = cheerio.load(html);
  $body('script, style, noscript, template, svg, nav, footer, header, aside, form').remove();
  const scopeText = ($body('article').text() || $body('main').text() || $body('body').text());
  const text = scopeText.replace(/\s+/g, ' ').trim();
  r.wordCount = text ? text.split(/\s+/).length : 0;
  r.readingTimeMins = Math.max(1, Math.round(r.wordCount / 230));
  r.bodyText = text.slice(0, 18000);
}

export function normalizeUrl(input: string): string {
  let s = (input || '').trim();
  if (!s) return s;
  // Pull a URL/host token out of any surrounding command text.
  const m = s.match(/https?:\/\/[^\s]+/i) || s.match(/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\s]*)?/i);
  if (m) s = m[0];
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  return s.replace(/[)\].,;'"]+$/, '');
}

const clean = (s: string) => (s || '').replace(/\s+/g, ' ').trim();
