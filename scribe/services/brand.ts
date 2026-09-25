import { fetchPageContent, normalizeUrl, domainOf } from '../sources/content';
import { requestOnce } from '../lib/http';
import * as cheerio from 'cheerio';
import { completeJSON, llmConfigured } from '../llm';
import { config } from '../config';
import { Report, b } from '../lib/report';
import { ContentProject, loadProject, saveProject } from '../lib/project';

/**
 * Brand voice & tone extraction (SCRIBE Feature — "approach for the brand content").
 *
 * Fetches the user's OWN site (homepage + a couple of interior/blog pages),
 * hands the REAL scraped copy to the LLM, and asks it to describe the brand's
 * existing voice, tone, vocabulary and audience — plus the topics the site
 * already covers (used later for clustering + gap analysis). The LLM only
 * DESCRIBES real copy it is given; it does not invent a brand identity.
 */

export interface BrandProfile {
  siteUrl: string;
  brandName: string | null;
  analyzedAt: string;
  voiceSummary: string;
  toneAttributes: string[];
  vocabulary: string[];
  audience: string;
  avoid: string[];
  topicsCovered: string[];
  reachable: boolean;
  pagesRead: string[];
  error?: string;
}

/** Standalone entry: analyse a site's brand voice and (optionally) attach to a project. */
export async function runBrandAnalysis(siteUrl: string, keyword?: string): Promise<Report> {
  const url = normalizeUrl(siteUrl);
  if (!url || !domainOf(url)) {
    return { tag: 'Brand Voice', title: 'No site URL', blocks: [b.note('Give me your website URL, e.g. "brand voice for yourbrand.com".')] };
  }

  const profile = await extractBrandProfile(url);

  // Attach to the keyword project when one is in play.
  if (keyword) {
    const project = await loadProject(keyword);
    if (project) { project.brand = profile; if (!project.siteUrl) project.siteUrl = url; await saveProject(project); }
  }

  return brandReport(profile, keyword);
}

/** Fetch the site's copy and derive a brand profile. Reusable by the workflow. */
export async function extractBrandProfile(siteUrl: string): Promise<BrandProfile> {
  const url = normalizeUrl(siteUrl);
  const base: BrandProfile = {
    siteUrl: url, brandName: null, analyzedAt: new Date().toISOString(),
    voiceSummary: '', toneAttributes: [], vocabulary: [], audience: '', avoid: [],
    topicsCovered: [], reachable: false, pagesRead: [],
  };

  const home = await fetchPageContent(url).catch(() => null);
  if (!home || !home.reachable) {
    base.error = home?.error || 'could not reach the site';
    return base;
  }
  base.reachable = true;
  base.brandName = home.title?.split(/\s[|–—-]\s/)[0]?.trim() || domainOf(url);
  base.pagesRead.push(home.finalUrl);

  // Pull a couple of interior pages (blog/about) for richer voice signal.
  const interiorUrls = await discoverInteriorPages(home.finalUrl);
  const samples = [home.bodyText];
  for (const iu of interiorUrls.slice(0, 2)) {
    const p = await fetchPageContent(iu).catch(() => null);
    if (p?.reachable && p.bodyText) { samples.push(p.bodyText); base.pagesRead.push(p.finalUrl); }
  }

  if (!llmConfigured()) {
    base.voiceSummary = config.brand.defaultVoice;
    base.error = 'LLM not configured — returning the default voice. Add an LLM key to extract the real brand voice from your copy.';
    return base;
  }

  try {
    const derived = await completeJSON<Partial<BrandProfile>>(BRAND_SYSTEM, JSON.stringify({
      brandName: base.brandName,
      homepageTitle: home.title,
      copy: samples.join('\n\n---\n\n').slice(0, 12000),
    }), { temperature: 0.3, maxTokens: 1200 });
    Object.assign(base, {
      voiceSummary: derived.voiceSummary || config.brand.defaultVoice,
      toneAttributes: derived.toneAttributes || [],
      vocabulary: derived.vocabulary || [],
      audience: derived.audience || '',
      avoid: derived.avoid || [],
      topicsCovered: derived.topicsCovered || [],
    });
  } catch (e: any) {
    base.voiceSummary = config.brand.defaultVoice;
    base.error = `Voice extraction failed (${e?.message || e}); using the default voice.`;
  }
  return base;
}

async function discoverInteriorPages(homeUrl: string): Promise<string[]> {
  try {
    const res = await requestOnce(homeUrl);
    if (!res.ok || !res.body) return [];
    const $ = cheerio.load(res.body);
    const origin = new URL(homeUrl).origin;
    const found: string[] = [];
    $('a[href]').each((_, el) => {
      const href = ($(el).attr('href') || '').trim();
      if (!href) return;
      let abs: string;
      try { abs = new URL(href, homeUrl).toString(); } catch { return; }
      if (!abs.startsWith(origin)) return;
      if (/\/(blog|about|articles?|resources|insights|guides?)(\/|$)/i.test(abs) && !found.includes(abs)) found.push(abs);
    });
    return found;
  } catch { return []; }
}

const BRAND_SYSTEM = `You are a brand-voice analyst. You will receive REAL copy scraped from a company's own website. Describe the brand's existing voice so another writer can match it exactly.

Return ONLY minified JSON:
{"voiceSummary": string,       // 2-3 sentences describing how this brand writes
 "toneAttributes": string[],   // 4-6 adjectives grounded in the copy (e.g. "confident", "warm", "plain-spoken")
 "vocabulary": string[],       // 5-10 signature words/phrases the brand actually uses
 "audience": string,           // who they appear to write for
 "avoid": string[],            // things that would feel off-brand (inferred from what they never do)
 "topicsCovered": string[]}    // 5-12 topics/themes the site already covers (from the copy)

Rules:
- Base everything on the ACTUAL copy provided. Do not invent a persona the copy does not support.
- If the copy is thin, say so in voiceSummary and keep arrays short rather than padding them.`;

/* ------------------------------ report ------------------------------ */

export function brandReport(p: BrandProfile, keyword?: string): Report {
  const blocks = [];
  if (!p.reachable) {
    blocks.push(b.note(`Could not reach ${p.siteUrl} (${p.error || 'no response'}). I need to read your site to match its voice.`));
    return { tag: 'Brand Voice', title: 'Brand voice', blocks };
  }

  blocks.push(b.p(p.voiceSummary || config.brand.defaultVoice));
  blocks.push(b.kv([
    { k: 'Brand', v: p.brandName || domainOf(p.siteUrl) },
    { k: 'Audience', v: p.audience || '—' },
    { k: 'Pages read', v: String(p.pagesRead.length) },
  ]));
  if (p.toneAttributes.length) { blocks.push(b.p('Tone:')); blocks.push(b.chips(p.toneAttributes)); }
  if (p.vocabulary.length) { blocks.push(b.p('Signature vocabulary:')); blocks.push(b.chips(p.vocabulary)); }
  if (p.avoid.length) { blocks.push(b.p('Keep off-brand:')); blocks.push(b.list(p.avoid)); }
  if (p.topicsCovered.length) { blocks.push(b.p('Topics your site already covers:')); blocks.push(b.chips(p.topicsCovered)); }
  if (p.error) blocks.push(b.note(p.error));
  if (keyword) blocks.push(b.chips(['Write draft', 'Find content gaps']));

  return { tag: 'Brand Voice', title: `Brand voice — ${p.brandName || domainOf(p.siteUrl)}`, blocks, data: { siteUrl: p.siteUrl, keyword } };
}
