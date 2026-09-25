import { config } from '../config';
import { getJSON } from '../lib/http';

export interface PsiResult {
  configured: boolean;
  url: string;
  strategy: 'mobile' | 'desktop';
  // Lighthouse category scores (0-100)
  performanceScore: number | null;
  seoScore: number | null;
  accessibilityScore: number | null;
  bestPracticesScore: number | null;
  // Core Web Vitals
  lcpMs: number | null;
  cls: number | null;
  inpMs: number | null;
  ttfbMs: number | null;
  fcpMs: number | null;
  loadMs: number | null;       // lab "interactive" / full load estimate
  pageWeightBytes: number | null;
  fieldData: boolean; // true = real CrUX field data, false = lab only
  // Actionable detail
  opportunities: { title: string; savingsMs: number }[];
  seoIssues: string[];
  accessibilityIssues: string[];
  bestPracticeIssues: string[];
  error?: string;
}

// Back-compat alias — older code referred to CoreWebVitals.
export type CoreWebVitals = PsiResult;

/**
 * Full PageSpeed Insights (Lighthouse) pull via Google's FREE API.
 * A PAGESPEED_API_KEY just raises the rate limit; the data is identical.
 * This is trusted Google data — Lighthouse scores + real Core Web Vitals (CrUX).
 */
export async function pageSpeed(url: string, strategy: 'mobile' | 'desktop' = 'mobile'): Promise<PsiResult> {
  const base: PsiResult = {
    configured: true, url, strategy,
    performanceScore: null, seoScore: null, accessibilityScore: null, bestPracticesScore: null,
    lcpMs: null, cls: null, inpMs: null, ttfbMs: null, fcpMs: null, loadMs: null, pageWeightBytes: null, fieldData: false,
    opportunities: [], seoIssues: [], accessibilityIssues: [], bestPracticeIssues: [],
  };
  try {
    const key = config.google.pagespeedKey ? `&key=${config.google.pagespeedKey}` : '';
    const cats = ['performance', 'seo', 'accessibility', 'best-practices'].map((c) => `&category=${c}`).join('');
    const api = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=${strategy}${cats}${key}`;
    const data = await getJSON<any>(api, {}, 60000);

    const lr = data?.lighthouseResult;
    const categories = lr?.categories || {};
    const audits = lr?.audits || {};

    base.performanceScore = scoreOf(categories.performance);
    base.seoScore = scoreOf(categories.seo);
    base.accessibilityScore = scoreOf(categories.accessibility);
    base.bestPracticesScore = scoreOf(categories['best-practices']);

    // Prefer real-user (CrUX) field metrics; fall back to lab audits.
    const field = data?.loadingExperience?.metrics;
    if (field) {
      base.fieldData = true;
      base.lcpMs = field?.LARGEST_CONTENTFUL_PAINT_MS?.percentile ?? null;
      base.cls = field?.CUMULATIVE_LAYOUT_SHIFT_SCORE ? field.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile / 100 : null;
      base.inpMs = field?.INTERACTION_TO_NEXT_PAINT?.percentile ?? null;
      base.ttfbMs = field?.EXPERIENCED_TIME_TO_FIRST_BYTE_MS?.percentile ?? null;
    }
    if (base.lcpMs == null) base.lcpMs = num(audits['largest-contentful-paint']?.numericValue);
    if (base.cls == null) base.cls = num(audits['cumulative-layout-shift']?.numericValue);
    if (base.ttfbMs == null) base.ttfbMs = num(audits['server-response-time']?.numericValue);
    base.fcpMs = num(audits['first-contentful-paint']?.numericValue);
    // "Load" estimate: prefer interactive (TTI), fall back to speed-index.
    base.loadMs = num(audits['interactive']?.numericValue) ?? num(audits['speed-index']?.numericValue);
    base.pageWeightBytes = num(audits['total-byte-weight']?.numericValue);

    // Performance opportunities (with estimated savings)
    const opps: { title: string; savingsMs: number }[] = [];
    for (const ref of categories.performance?.auditRefs || []) {
      const a = audits[ref.id];
      const savings = a?.details?.overallSavingsMs;
      if (a && typeof savings === 'number' && savings >= 100) opps.push({ title: a.title, savingsMs: Math.round(savings) });
    }
    base.opportunities = opps.sort((x, y) => y.savingsMs - x.savingsMs).slice(0, 8);

    base.seoIssues = failingAudits(categories.seo, audits);
    base.accessibilityIssues = failingAudits(categories.accessibility, audits);
    base.bestPracticeIssues = failingAudits(categories['best-practices'], audits);

    return base;
  } catch (e: any) {
    return { ...base, error: String(e?.message || e) };
  }
}

/** Kept for backward compatibility with existing imports. */
export const coreWebVitals = pageSpeed;

function scoreOf(cat: any): number | null {
  return typeof cat?.score === 'number' ? Math.round(cat.score * 100) : null;
}
function num(v: any): number | null {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : null;
}
function failingAudits(cat: any, audits: any): string[] {
  const out: string[] = [];
  for (const ref of cat?.auditRefs || []) {
    const a = audits[ref.id];
    if (!a) continue;
    if (a.scoreDisplayMode === 'informative' || a.scoreDisplayMode === 'notApplicable' || a.scoreDisplayMode === 'manual') continue;
    if (typeof a.score === 'number' && a.score < 0.9) out.push(a.title);
  }
  return out.slice(0, 10);
}
