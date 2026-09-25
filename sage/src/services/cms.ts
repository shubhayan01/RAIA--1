import { config } from '../config';
import { timedFetch } from '../lib/http';
import { BriefData } from './brief';

/**
 * WordPress CMS connector.
 *
 * Pushes an approved SAGE content brief into a WordPress site as a DRAFT post via
 * the WordPress REST API (POST /wp-json/wp/v2/posts), authenticated with a WP
 * Application Password over HTTP Basic auth. The writer opens the draft and
 * executes it — nothing is copied by hand, and nothing is ever published live.
 *
 * Also exposes the low-level REST helpers (createPost / updatePost / findPostBySlug
 * / resolveTermId) reused by the meta-tag push (Feature 3) and the opportunity
 * loop (Feature 5).
 */

/* --------------------------------- Types -------------------------------- */

export interface WpCreds {
  url: string;        // site root, e.g. https://client.com (no trailing slash)
  username: string;
  appPassword: string;
}

export interface WpPushResult {
  ok: boolean;
  postId?: number;
  status?: string;
  link?: string;       // public/permalink
  editLink?: string;   // wp-admin editor URL
  detectedSeoPlugin?: 'yoast' | 'rankmath' | 'none';
  error?: string;
}

/* ------------------------------- Config --------------------------------- */

export function wordpressConfigured(creds?: Partial<WpCreds>): boolean {
  const c = resolveCreds(creds);
  return !!c.url && !!c.username && !!c.appPassword;
}

/** Merge caller-supplied creds over the .env defaults. */
export function resolveCreds(creds?: Partial<WpCreds>): WpCreds {
  return {
    url: (creds?.url || config.wordpress.url || '').replace(/\/+$/, ''),
    username: creds?.username || config.wordpress.username || '',
    appPassword: creds?.appPassword || config.wordpress.appPassword || '',
  };
}

function authHeader(c: WpCreds): string {
  return 'Basic ' + Buffer.from(`${c.username}:${c.appPassword}`).toString('base64');
}

function api(c: WpCreds, path: string): string {
  return `${c.url}/wp-json/wp/v2/${path.replace(/^\/+/, '')}`;
}

/* ------------------------- Low-level REST helpers ----------------------- */

async function wpFetch(c: WpCreds, path: string, init: RequestInit = {}): Promise<any> {
  const res = await timedFetch(api(c, path), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: authHeader(c),
      ...(init.headers || {}),
    },
  }, 25000);
  const text = await res.text().catch(() => '');
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  if (!res.ok) {
    const msg = json?.message || `WordPress ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

/**
 * Resolve a taxonomy term (category/tag) to an ID by name, creating it if absent.
 * taxonomy: 'categories' | 'tags'.
 */
export async function resolveTermId(c: WpCreds, taxonomy: 'categories' | 'tags', name: string): Promise<number | null> {
  const clean = name.trim();
  if (!clean) return null;
  try {
    const found = await wpFetch(c, `${taxonomy}?search=${encodeURIComponent(clean)}&per_page=100`);
    if (Array.isArray(found)) {
      const exact = found.find((t: any) => String(t.name).toLowerCase() === clean.toLowerCase());
      if (exact) return exact.id;
    }
    const created = await wpFetch(c, taxonomy, { method: 'POST', body: JSON.stringify({ name: clean }) });
    return created?.id ?? null;
  } catch {
    return null; // never block a push on taxonomy resolution
  }
}

async function resolveTermIds(c: WpCreds, taxonomy: 'categories' | 'tags', names: string[]): Promise<number[]> {
  const ids: number[] = [];
  for (const n of names) {
    const id = await resolveTermId(c, taxonomy, n);
    if (id != null) ids.push(id);
  }
  return ids;
}

export interface WpPostInput {
  title: string;
  content: string;
  status?: string;
  slug?: string;
  tags?: number[];
  categories?: number[];
  meta?: Record<string, unknown>;
}

export async function createPost(c: WpCreds, input: WpPostInput): Promise<any> {
  return wpFetch(c, 'posts', { method: 'POST', body: JSON.stringify({ status: 'draft', ...input }) });
}

export async function updatePost(c: WpCreds, type: 'posts' | 'pages', id: number, fields: Record<string, unknown>): Promise<any> {
  return wpFetch(c, `${type}/${id}`, { method: 'POST', body: JSON.stringify(fields) });
}

/**
 * Read a post/page's EDITABLE raw body (context=edit returns `content.raw`, the
 * source WordPress stores — not the rendered HTML). Needed to safely edit a
 * post's content (e.g. inject an internal link) without clobbering it. Requires
 * an authenticated request with edit rights, which the Application Password has.
 */
export async function getPostContent(c: WpCreds, type: 'posts' | 'pages', id: number): Promise<{ raw: string; title: string; link: string }> {
  const row = await wpFetch(c, `${type}/${id}?context=edit`);
  return {
    raw: row?.content?.raw ?? row?.content?.rendered ?? '',
    title: row?.title?.raw ?? row?.title?.rendered ?? '',
    link: row?.link ?? '',
  };
}

/** Find a published post or page by slug. Returns { id, type } or null. */
export async function findPostBySlug(c: WpCreds, slug: string): Promise<{ id: number; type: 'posts' | 'pages'; link: string } | null> {
  for (const type of ['posts', 'pages'] as const) {
    try {
      const rows = await wpFetch(c, `${type}?slug=${encodeURIComponent(slug)}&per_page=1&status=publish,draft,pending,private`);
      if (Array.isArray(rows) && rows.length) return { id: rows[0].id, type, link: rows[0].link };
    } catch { /* try the other type */ }
  }
  return null;
}

/** Derive the WP slug from a URL's last path segment. */
export function slugFromUrl(url: string): string {
  try {
    const p = new URL(url);
    const seg = p.pathname.replace(/\/+$/, '').split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(seg).toLowerCase();
  } catch {
    return '';
  }
}

/* ------------------------- Brief → WordPress draft ---------------------- */

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));

/** Render a full brief as structured HTML for the WordPress post body. */
export function briefToHtml(d: BriefData): string {
  const out: string[] = [];

  if (d.existingPageUrl) {
    out.push(`<div class="brief-section"><p><strong>Rewrite brief</strong> for existing page: <a href="${esc(d.existingPageUrl)}">${esc(d.existingPageUrl)}</a></p></div>`);
  }

  // Brief header
  out.push('<div class="brief-section">');
  out.push('<h2>Brief overview</h2>');
  out.push('<ul>');
  out.push(`<li><strong>Target keyword:</strong> ${esc(d.primaryKeyword)}</li>`);
  out.push(`<li><strong>Primary intent:</strong> ${esc(d.intent)}</li>`);
  if (d.targetReader) out.push(`<li><strong>Target reader:</strong> ${esc(d.targetReader)}</li>`);
  out.push(`<li><strong>Target word count:</strong> ~${esc(d.wordCount)}${d.competitorAvgWordCount ? ` (competitor avg ${esc(d.competitorAvgWordCount)})` : ''}</li>`);
  out.push(`<li><strong>Content format:</strong> ${esc(d.contentFormat)}${d.formatJustification ? ` — ${esc(d.formatJustification)}` : ''}</li>`);
  if (d.titleRecommended) out.push(`<li><strong>Recommended title tag:</strong> ${esc(d.titleRecommended)}</li>`);
  if (d.metaOptions[0]) out.push(`<li><strong>Meta description:</strong> ${esc(d.metaOptions[0])}</li>`);
  out.push('</ul>');
  out.push('</div>');

  // Rewrite analysis
  if (d.rewriteAnalysis) {
    const ra = d.rewriteAnalysis;
    out.push('<div class="brief-section">');
    out.push('<h2>Rewrite analysis</h2>');
    const chunk = (label: string, items: string[]) => {
      if (!items.length) return;
      out.push(`<p><strong>${esc(label)}:</strong></p><ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`);
    };
    chunk('Keep', ra.keep); chunk('Cut', ra.cut); chunk('Add', ra.add); chunk('Restructure', ra.restructure);
    if (ra.summary) out.push(`<p>${esc(ra.summary)}</p>`);
    out.push('</div>');
  }

  // Full content structure — each H2 becomes a real <h2> inside a brief-section
  for (const s of d.structure) {
    out.push('<div class="brief-section">');
    out.push(`<h2>${esc(s.h2)}${s.wordCount ? ` (~${esc(s.wordCount)} words)` : ''}</h2>`);
    const bits: string[] = [];
    if (s.purpose) bits.push(`<li><strong>Purpose:</strong> ${esc(s.purpose)}</li>`);
    if (s.mustCover?.length) bits.push(`<li><strong>Must cover:</strong> ${esc(s.mustCover.join('; '))}</li>`);
    if (s.competitorGap) bits.push(`<li><strong>Competitor gap:</strong> ${esc(s.competitorGap)}</li>`);
    if (s.format) bits.push(`<li><strong>Format:</strong> ${esc(s.format)}</li>`);
    for (const h3 of s.h3 || []) bits.push(`<li><strong>H3:</strong> ${esc(h3)}</li>`);
    if (bits.length) out.push(`<ul>${bits.join('')}</ul>`);
    out.push('</div>');
  }

  // FAQ
  if (d.faq.length) {
    out.push('<div class="faq">');
    out.push('<h2>FAQ</h2>');
    for (const f of d.faq) {
      out.push(`<h3>${esc(f.q)}</h3>`);
      if (f.answerFramework) out.push(`<p>${esc(f.answerFramework)}</p>`);
    }
    out.push('</div>');
  }

  // Entities as a <ul>
  if (d.entities.length) {
    out.push('<div class="brief-section">');
    out.push('<h2>Key entities to include</h2>');
    out.push(`<ul>${d.entities.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`);
    out.push('</div>');
  }

  // CTA as a <blockquote>
  if (d.cta) {
    out.push(`<blockquote>${esc(d.cta)}</blockquote>`);
  }

  return out.join('\n');
}

/** SEO meta keys for both Yoast and RankMath — sent together (harmless if one is absent). */
function seoMeta(d: BriefData): Record<string, unknown> {
  const focus = d.primaryKeyword;
  const metaDesc = d.metaOptions[0] || '';
  return {
    _yoast_wpseo_focuskw: focus,
    _yoast_wpseo_metadesc: metaDesc,
    rank_math_focus_keyword: focus,
    rank_math_description: metaDesc,
    // Generic keys SAGE can read back on future runs.
    sage_target_keyword: focus,
    sage_secondary_keywords: d.lsiTerms.slice(0, 10).join(', '),
    sage_target_word_count: d.wordCount,
  };
}

/**
 * Push an approved brief into WordPress as a draft post.
 * Returns the post link + wp-admin edit link, or an { ok:false, error }.
 */
export async function pushBriefToWordPress(brief: BriefData, creds?: Partial<WpCreds>, extraTags: string[] = []): Promise<WpPushResult> {
  const c = resolveCreds(creds);
  if (!c.url || !c.username || !c.appPassword) {
    return { ok: false, error: 'WordPress not configured — set WP_URL, WP_USERNAME, WP_APP_PASSWORD (or pass them in).' };
  }

  // Title = the recommended H1 from the brief (first H1 option), falling back to
  // the recommended title tag, then the keyword.
  const title = brief.h1Options[0] || brief.titleRecommended || brief.primaryKeyword;

  try {
    const [tagIds, catIds] = await Promise.all([
      resolveTermIds(c, 'tags', [brief.primaryKeyword, ...extraTags].filter(Boolean)),
      resolveTermIds(c, 'categories', [brief.contentFormat].filter(Boolean)),
    ]);

    const post = await createPost(c, {
      title,
      content: briefToHtml(brief),
      status: 'draft',
      tags: tagIds,
      categories: catIds,
      meta: seoMeta(brief),
    });

    const editLink = `${c.url}/wp-admin/post.php?post=${post.id}&action=edit`;
    return {
      ok: true,
      postId: post.id,
      status: post.status,
      link: post.link,
      editLink,
      detectedSeoPlugin: 'none',
    };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}
