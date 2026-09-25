import { requestOnce } from '../lib/http';
import { parseHtml } from '../lib/html';
import { pool } from '../lib/concurrency';
import { completeJSON, llmConfigured } from '../llm';
import {
  WpCreds, resolveCreds, wordpressConfigured, findPostBySlug, updatePost, slugFromUrl,
} from './cms';

/**
 * Title & Meta Tag push (Feature 3).
 *
 * Takes the audit output, finds pages with title/meta problems, uses the LLM to
 * write optimized replacements (within the character limits), and pushes them to
 * WordPress via the REST API — core post title plus Yoast/RankMath title & meta
 * keys, so it works whichever SEO plugin (or none) the site runs.
 */

const TITLE_MAX = 60;
const META_MAX = 155;
const MAX_PAGES = 20; // cap LLM + WP calls per run

export interface MetaPushEntry {
  url: string;
  problem: string;                 // human-readable list of what was wrong
  before: { title: string | null; metaDescription: string | null };
  after?: { title: string; metaDescription: string };
  status: 'updated' | 'skipped' | 'failed';
  reason?: string;                 // why skipped/failed
  postId?: number;
}

export interface MetaPushReport {
  ok: boolean;
  wpConfigured: boolean;
  updated: number;
  skipped: number;
  failed: number;
  entries: MetaPushEntry[];
  error?: string;
}

/** Pull every http(s) URL that appears in the audit's issue examples. */
export function collectAuditUrls(auditData: any): string[] {
  const urls = new Set<string>();
  const push = (s: string) => {
    const m = String(s).match(/https?:\/\/[^\s"'()]+/g);
    if (m) m.forEach((u) => urls.add(u.replace(/[.,;]+$/, '')));
  };
  if (auditData?.origin) urls.add(String(auditData.origin));
  for (const g of auditData?.issues || []) {
    // Only mine the on-page groups whose examples carry URLs.
    if (['title-missing', 'meta-missing', 'h1-missing', 'thin', 'noindex', '404'].includes(g.id)) {
      for (const ex of g.examples || []) push(ex);
    } else {
      for (const ex of g.examples || []) push(ex); // still catch any URL-bearing example
    }
  }
  return [...urls];
}

interface PageState {
  url: string;
  title: string | null;
  metaDescription: string | null;
  h1: string;
  excerpt: string;
  titleProblem: 'missing' | 'too_long' | 'duplicate' | null;
  metaProblem: 'missing' | 'too_long' | null;
}

export async function runMetaPush(input: { auditData: any; creds?: Partial<WpCreds> }): Promise<MetaPushReport> {
  const creds = resolveCreds(input.creds);
  const wpConfigured = wordpressConfigured(creds);

  if (!llmConfigured()) {
    return { ok: false, wpConfigured, updated: 0, skipped: 0, failed: 0, entries: [], error: 'LLM not configured — a key is required to generate optimized tags.' };
  }
  if (!wpConfigured) {
    return { ok: false, wpConfigured, updated: 0, skipped: 0, failed: 0, entries: [], error: 'WordPress not configured — set WP_URL, WP_USERNAME, WP_APP_PASSWORD.' };
  }

  const candidateUrls = collectAuditUrls(input.auditData).slice(0, MAX_PAGES * 2);

  // Fetch + parse each candidate page to read its CURRENT title/meta and classify.
  const parsed = await pool(candidateUrls, 4, async (url): Promise<PageState | null> => {
    try {
      const res = await requestOnce(url);
      if (!res.body || res.status >= 400) return null;
      const p = parseHtml(res.body, res.finalUrl || url);
      const titleProblem: PageState['titleProblem'] =
        !p.title ? 'missing' : (p.title.length > TITLE_MAX ? 'too_long' : null);
      const metaProblem: PageState['metaProblem'] =
        !p.metaDescription ? 'missing' : (p.metaDescription.length > META_MAX ? 'too_long' : null);
      return {
        url,
        title: p.title,
        metaDescription: p.metaDescription,
        h1: p.h1[0] || '',
        excerpt: p.text.slice(0, 600),
        titleProblem,
        metaProblem,
      };
    } catch {
      return null;
    }
  });

  const pages = parsed.filter(Boolean) as PageState[];

  // Duplicate-title detection across the fetched set.
  const titleCounts = new Map<string, number>();
  for (const p of pages) {
    if (p.title) titleCounts.set(p.title.trim().toLowerCase(), (titleCounts.get(p.title.trim().toLowerCase()) || 0) + 1);
  }
  for (const p of pages) {
    if (!p.titleProblem && p.title && (titleCounts.get(p.title.trim().toLowerCase()) || 0) > 1) p.titleProblem = 'duplicate';
  }

  const affected = pages.filter((p) => p.titleProblem || p.metaProblem).slice(0, MAX_PAGES);

  const entries: MetaPushEntry[] = [];
  // Sequential: keep WP write load low and predictable.
  for (const page of affected) {
    const problem = [
      page.titleProblem && `title ${page.titleProblem.replace('_', ' ')}`,
      page.metaProblem && `meta description ${page.metaProblem.replace('_', ' ')}`,
    ].filter(Boolean).join(', ');

    const entry: MetaPushEntry = {
      url: page.url,
      problem,
      before: { title: page.title, metaDescription: page.metaDescription },
      status: 'skipped',
    };

    try {
      const gen = await generateTags(page);
      entry.after = gen;

      const slug = slugFromUrl(page.url);
      if (!slug) { entry.reason = 'could not derive a slug from the URL'; entries.push(entry); continue; }

      const target = await findPostBySlug(creds, slug);
      if (!target) { entry.reason = 'no matching WordPress post/page found for this URL'; entries.push(entry); continue; }

      // Update core post title AND both plugins' SEO title + meta description keys,
      // so the change applies whether the site runs Yoast, RankMath, or neither.
      await updatePost(creds, target.type, target.id, {
        title: gen.title,
        meta: {
          _yoast_wpseo_title: gen.title,
          _yoast_wpseo_metadesc: gen.metaDescription,
          rank_math_title: gen.title,
          rank_math_description: gen.metaDescription,
        },
      });
      entry.status = 'updated';
      entry.postId = target.id;
    } catch (e: any) {
      entry.status = 'failed';
      entry.reason = String(e?.message || e);
    }
    entries.push(entry);
  }

  return {
    ok: true,
    wpConfigured,
    updated: entries.filter((e) => e.status === 'updated').length,
    skipped: entries.filter((e) => e.status === 'skipped').length,
    failed: entries.filter((e) => e.status === 'failed').length,
    entries,
  };
}

/* --------------------------- LLM tag generation ------------------------- */

const SYSTEM = `You are an SEO copywriter. Write a title tag and meta description for this page. Never exceed character limits. Never use clickbait. Return JSON only: {title, metaDescription}`;

async function generateTags(page: PageState): Promise<{ title: string; metaDescription: string }> {
  const user = JSON.stringify({
    url: page.url,
    currentTitle: page.title,
    currentMetaDescription: page.metaDescription,
    h1: page.h1,
    pageExcerpt: page.excerpt,
    rules: {
      titleFormat: 'Primary KW — Secondary KW | Brand',
      titleMaxChars: TITLE_MAX,
      metaMaxChars: META_MAX,
      metaMustInclude: 'primary keyword + benefit + CTA',
    },
  });
  const r = await completeJSON<{ title?: string; metaDescription?: string }>(SYSTEM, user, { temperature: 0.4, maxTokens: 400 });
  let title = String(r.title || '').trim();
  let metaDescription = String(r.metaDescription || '').trim();
  // Hard clamp — never exceed the limits even if the model drifts.
  if (title.length > TITLE_MAX) title = title.slice(0, TITLE_MAX).trim();
  if (metaDescription.length > META_MAX) metaDescription = metaDescription.slice(0, META_MAX).trim();
  return { title, metaDescription };
}
