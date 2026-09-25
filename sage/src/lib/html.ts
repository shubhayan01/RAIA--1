import * as cheerio from 'cheerio';
import { absolutize } from './http';

export interface PageParse {
  title: string | null;
  titleLength: number;
  metaDescription: string | null;
  metaDescriptionLength: number;
  h1: string[];
  h2: string[];
  h3: string[];
  canonical: string | null;
  robotsMeta: string | null;
  noindex: boolean;
  nofollow: boolean;
  lang: string | null;
  wordCount: number;
  text: string;
  imagesTotal: number;
  imagesMissingAlt: number;
  internalLinks: string[];
  externalLinks: string[];
  hasViewport: boolean;
  hasSchema: boolean;
  hreflang: string[];
}

export function parseHtml(html: string, pageUrl: string): PageParse {
  const $ = cheerio.load(html);
  const origin = safeOrigin(pageUrl);

  const title = text($('title').first());
  const metaDescription = $('meta[name="description"]').attr('content')?.trim() || null;
  const robotsMeta = $('meta[name="robots"]').attr('content')?.toLowerCase().trim() || null;
  const canonical = $('link[rel="canonical"]').attr('href')?.trim() || null;
  const lang = $('html').attr('lang')?.trim() || null;

  const h1 = collect($, 'h1');
  const h2 = collect($, 'h2');
  const h3 = collect($, 'h3');

  // visible-ish text (strip script/style/nav noise)
  $('script, style, noscript, template, svg').remove();
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  const wordCount = bodyText ? bodyText.split(/\s+/).length : 0;

  let imagesTotal = 0;
  let imagesMissingAlt = 0;
  $('img').each((_, el) => {
    imagesTotal++;
    const alt = $(el).attr('alt');
    if (alt === undefined || alt.trim() === '') imagesMissingAlt++;
  });

  const internal = new Set<string>();
  const external = new Set<string>();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) return;
    const abs = absolutize(href, pageUrl).split('#')[0];
    const o = safeOrigin(abs);
    if (!o) return;
    if (o === origin) internal.add(abs);
    else external.add(abs);
  });

  const hreflang: string[] = [];
  $('link[rel="alternate"][hreflang]').each((_, el) => {
    const h = $(el).attr('hreflang');
    if (h) hreflang.push(h);
  });

  return {
    title,
    titleLength: title?.length || 0,
    metaDescription,
    metaDescriptionLength: metaDescription?.length || 0,
    h1,
    h2,
    h3,
    canonical: canonical ? absolutize(canonical, pageUrl) : null,
    robotsMeta,
    noindex: !!robotsMeta && /noindex/.test(robotsMeta),
    nofollow: !!robotsMeta && /nofollow/.test(robotsMeta),
    lang,
    wordCount,
    text: bodyText.slice(0, 20000),
    imagesTotal,
    imagesMissingAlt,
    internalLinks: [...internal],
    externalLinks: [...external],
    hasViewport: $('meta[name="viewport"]').length > 0,
    hasSchema: $('script[type="application/ld+json"]').length > 0,
    hreflang,
  };
}

/** Extract just headings + title + intro for competitor analysis (cheaper than full parse). */
export function extractOutline(html: string) {
  const $ = cheerio.load(html);
  const title = text($('title').first());
  const h1 = collect($, 'h1');
  const h2 = collect($, 'h2');
  const h3 = collect($, 'h3');
  $('script, style, noscript, svg').remove();
  const intro = $('p').first().text().replace(/\s+/g, ' ').trim().slice(0, 400);
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  return { title, h1, h2, h3, intro, wordCount: bodyText ? bodyText.split(/\s+/).length : 0 };
}

function collect($: cheerio.CheerioAPI, sel: string): string[] {
  const out: string[] = [];
  $(sel).each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (t) out.push(t);
  });
  return out;
}

function text(node: cheerio.Cheerio<any>): string | null {
  const t = node.text().replace(/\s+/g, ' ').trim();
  return t || null;
}

export function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** A shingled fingerprint for near-duplicate content detection. */
export function contentFingerprint(text: string): string {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
  if (words.length < 12) return '';
  const shingles: string[] = [];
  for (let i = 0; i + 4 <= words.length; i += 4) shingles.push(words.slice(i, i + 4).join(' '));
  // cheap hash of sorted sample
  const sample = shingles.filter((_, i) => i % 3 === 0).slice(0, 40).sort().join('|');
  let h = 0;
  for (let i = 0; i < sample.length; i++) h = (Math.imul(31, h) + sample.charCodeAt(i)) | 0;
  return String(h >>> 0);
}
