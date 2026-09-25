import { config } from '../config';
import { timedFetch } from '../lib/http';

/**
 * SEOptimer adapter — REAL graded audit data for a single URL/domain.
 *
 * One call to SEOptimer returns: category grades (SEO/GEO/Links/Performance/
 * Social/UI/Security), ~90 individual checks, a prioritized recommendation list,
 * the domain's real keyword rankings (with search volume + estimated traffic),
 * its backlink profile, AI-Overview rankings and GEO signals.
 *
 * The LLM never touches this — it's measured third-party data, surfaced as-is.
 * Reports cost 1 API credit each, so results are cached per-URL (see CACHE_TTL)
 * and shared across capabilities (Audit / Ranks) that hit the same domain.
 *
 * Flow (queue-and-wait):
 *   POST /v1/report/create  { url }          -> { success, data:{ id } }
 *   GET  /v1/report/get/:id                  -> { success:false } while pending,
 *                                               { success:true, data:{ output } } when ready
 *
 * Roadmap: a DataForSEO adapter can replace this later behind the same shape.
 */

/* ----------------------------- Public types ----------------------------- */

export interface SeoptimerScore {
  grade: string;        // "A+" .. "F" ("" when a section could not be graded)
  title: string;
  description: string;
}

export interface SeoptimerCheck {
  key: string;          // e.g. "title", "canonicalCheck"
  title: string;
  section: string;      // seo | geo | links | performance | social | ui | security | technology | localseo | rankings
  passed: boolean | null;
  shortAnswer: string;
  recommendation: string;
  value?: string;
  data?: unknown;
}

export interface SeoptimerRecommendation {
  priority: 'high' | 'medium' | 'low' | string;
  section: string;
  recommendation: string;
}

export interface SeoptimerKeywordRank {
  keyword: string;
  country: string;
  position: number;
  totalSearches: string | null;      // kept as the API's formatted string, e.g. "301,000"
  estimatedTraffic: string | null;
  url: string | null;                // the ranking/landing URL, when the API reports one (else null)
}

export interface SeoptimerBacklinks {
  backlinks: number | null;
  referringDomains: number | null;
  domainStrength: number | null;
  pageStrength: number | null;
  dofollow: number | null;
  nofollow: number | null;
  eduBacklinks: number | null;
  govBacklinks: number | null;
}

export interface SeoptimerReport {
  ok: boolean;
  url: string;
  finalUrl: string;
  screenshot?: string;
  scores: Record<string, SeoptimerScore>;   // keys: overall, seo, geo, links, performance, social, ui, security
  checks: SeoptimerCheck[];
  recommendations: SeoptimerRecommendation[];
  keywordRankings: SeoptimerKeywordRank[];
  keywordPositions: Record<string, number>; // "Position 1": 119, "Position 2-3": 56, ...
  aiOverviewRankings: SeoptimerKeywordRank[];
  backlinks: SeoptimerBacklinks | null;
  trafficFromSearch: { total: number | null; paid: number | null; ai: number | null } | null;
  technologies: string[];
  error?: string;                            // set (with ok:false) when the report could not be produced
  raw?: any;                                 // full output payload for export / API consumers
}

/** All checks belonging to one SEOptimer section (e.g. "geo", "social"). */
export function checksBySection(report: SeoptimerReport, section: string): SeoptimerCheck[] {
  return report.checks.filter((c) => c.section === section);
}

/** A flat, display-ready snapshot of the headline numbers (for head-to-head tables). */
export interface SeoptimerProfile {
  domain: string;
  overallGrade: string;
  seoGrade: string;
  geoGrade: string;
  domainStrength: number | null;
  referringDomains: number | null;
  backlinks: number | null;
  searchTraffic: number | null;
  aiTraffic: number | null;
  topKeywordCount: number;
}

export function profileOf(report: SeoptimerReport): SeoptimerProfile {
  return {
    domain: report.url.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, ''),
    overallGrade: report.scores.overall?.grade || '—',
    seoGrade: report.scores.seo?.grade || '—',
    geoGrade: report.scores.geo?.grade || '—',
    domainStrength: report.backlinks?.domainStrength ?? null,
    referringDomains: report.backlinks?.referringDomains ?? null,
    backlinks: report.backlinks?.backlinks ?? null,
    searchTraffic: report.trafficFromSearch?.total ?? null,
    aiTraffic: report.trafficFromSearch?.ai ?? null,
    topKeywordCount: report.keywordRankings.length,
  };
}

export function seoptimerEnabled(): boolean {
  return !!config.seoptimer.apiKey;
}

/* ------------------------------- Cache ---------------------------------- */

const CACHE_TTL = 15 * 60 * 1000; // 15 min — reports cost credits; reuse across capabilities
const cache = new Map<string, { at: number; report: SeoptimerReport }>();

function cacheKey(url: string): string {
  return url.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
}

/* ------------------------------ Entry point ----------------------------- */

/**
 * Run (or reuse) a SEOptimer report for a URL. Never throws — on failure it
 * returns { ok:false, error } so callers can fail honestly and fall back.
 */
export async function seoptimerReport(url: string, opts: { fresh?: boolean } = {}): Promise<SeoptimerReport> {
  const key = cacheKey(url);
  if (!opts.fresh) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL) return hit.report;
  }

  if (!config.seoptimer.apiKey) {
    return emptyReport(url, 'SEOPTIMER_API_KEY not set');
  }

  try {
    const id = await createReport(url);
    const output = await pollReport(id);
    const report = parseOutput(url, output);
    cache.set(key, { at: Date.now(), report });
    return report;
  } catch (e: any) {
    return emptyReport(url, String(e?.message || e));
  }
}

/* ------------------------------ API calls ------------------------------- */

function headers() {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'x-api-key': config.seoptimer.apiKey,
  };
}

async function createReport(url: string): Promise<number> {
  const res = await timedFetch(
    `${config.seoptimer.baseUrl}/v1/report/create`,
    { method: 'POST', headers: headers(), body: JSON.stringify({ url }) },
    20000,
  );
  const data: any = await res.json().catch(() => null);
  if (!res.ok || !data?.success || !data?.data?.id) {
    const msg = data?.data?.message || data?.message || `HTTP ${res.status}`;
    throw new Error(`SEOptimer create failed: ${msg}`);
  }
  return data.data.id as number;
}

/**
 * Poll the get endpoint until the report is ready. SEOptimer returns
 * { success:false, data:{ message, code } } while the report is still running.
 * A typical report completes in ~40s; we allow up to ~2.5 min.
 */
async function pollReport(id: number): Promise<any> {
  const url = `${config.seoptimer.baseUrl}/v1/report/get/${id}`;
  const maxWaitMs = 150000;
  const started = Date.now();
  let delay = 6000;
  await sleep(8000); // report isn't ready instantly — don't waste the first poll

  let lastMessage = 'still processing';
  while (Date.now() - started < maxWaitMs) {
    const res = await timedFetch(url, { method: 'GET', headers: headers() }, 20000);
    const data: any = await res.json().catch(() => null);
    if (data?.success && data?.data?.output) return data.data.output;
    lastMessage = data?.data?.message || data?.message || lastMessage;
    await sleep(delay);
    delay = Math.min(delay + 2000, 12000);
  }
  throw new Error(`SEOptimer report timed out (${lastMessage})`);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ------------------------------- Parsing -------------------------------- */

const SCORE_KEYS = ['overall', 'seo', 'geo', 'links', 'performance', 'social', 'ui', 'security'];
// Keys in the output that are metadata / arrays, not individual checks.
const NON_CHECK_KEYS = new Set([
  'success', 'callback', 'pdf', 'screenshot', 'finalUrl', 'report_generation_time',
  'request_completion_time', 'scores', 'recommendations', 'recommendation_count',
]);

function parseOutput(url: string, out: any): SeoptimerReport {
  const scores: Record<string, SeoptimerScore> = {};
  for (const k of SCORE_KEYS) {
    const s = out?.scores?.[k];
    if (s) scores[k] = { grade: s.grade || '', title: s.title || '', description: s.description || '' };
  }

  const checks: SeoptimerCheck[] = [];
  for (const [k, v] of Object.entries(out || {})) {
    if (NON_CHECK_KEYS.has(k)) continue;
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const c: any = v;
    if (!('section' in c) && !('shortAnswer' in c)) continue;
    checks.push({
      key: k,
      title: c.title || k,
      section: c.section || '',
      passed: typeof c.passed === 'boolean' ? c.passed : null,
      shortAnswer: c.shortAnswer || '',
      recommendation: c.recommendation || '',
      value: c.value,
      data: c.data,
    });
  }

  const recommendations: SeoptimerRecommendation[] = Array.isArray(out?.recommendations)
    ? out.recommendations.map((r: any) => ({
        priority: r.priority || 'medium',
        section: r.section || '',
        recommendation: r.recommendation || '',
      }))
    : [];

  const keywordRankings = parseKeywordList(out?.topKeywordRankings?.data?.keywords);
  const aiOverviewRankings = parseKeywordList(out?.topAIOverviewRankings?.data?.keywords);

  const keywordPositions: Record<string, number> = {};
  const posData = out?.keywordPositions?.data;
  if (posData && typeof posData === 'object') {
    for (const [k, v] of Object.entries(posData)) {
      const n = Number(v);
      if (Number.isFinite(n)) keywordPositions[k] = n;
    }
  }

  const bl = out?.backlinks?.data;
  const backlinks: SeoptimerBacklinks | null = bl && typeof bl === 'object'
    ? {
        backlinks: numOrNull(bl.backlinks ?? bl.allbacklinks),
        referringDomains: numOrNull(bl.referring_domains),
        domainStrength: numOrNull(bl.domain_strength),
        pageStrength: numOrNull(bl.page_strength),
        dofollow: numOrNull(bl.dofollow_backlinks),
        nofollow: numOrNull(bl.nofollow_backlinks),
        eduBacklinks: numOrNull(bl.edu_backlinks),
        govBacklinks: numOrNull(bl.gov_backlinks),
      }
    : null;

  const technologies = parseTechnologies(out?.technologies?.data);

  const tfs = out?.totalTrafficFromSearch?.data;
  const trafficFromSearch = tfs && typeof tfs === 'object'
    ? { total: numOrNull(tfs.total), paid: numOrNull(tfs.paidtotal), ai: numOrNull(tfs.aitotal) }
    : null;

  return {
    ok: true,
    url,
    finalUrl: out?.finalUrl || url,
    screenshot: out?.screenshot || undefined,
    scores,
    checks,
    recommendations,
    keywordRankings,
    keywordPositions,
    aiOverviewRankings,
    backlinks,
    trafficFromSearch,
    technologies,
    raw: out,
  };
}

function parseKeywordList(arr: any): SeoptimerKeywordRank[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((r: any) => ({
      keyword: String(r.keyword || ''),
      country: String(r.country || ''),
      position: Number(r.position) || 0,
      totalSearches: r.total_searches != null ? String(r.total_searches) : null,
      estimatedTraffic: r.estimated_traffic != null ? String(r.estimated_traffic) : null,
      // SEOptimer does not always attach the ranking URL to a keyword; capture it
      // when present (across the field names it has used) so callers can match a
      // page URL to its position. Left null when the API gives nothing — never faked.
      url: firstString(r.url, r.landing_page, r.ranking_url, r.page, r.result_url),
    }))
    .filter((r) => r.keyword);
}

function parseTechnologies(data: any): string[] {
  if (!data) return [];
  if (Array.isArray(data)) {
    return data.map((t: any) => (typeof t === 'string' ? t : t?.name || t?.title || '')).filter(Boolean);
  }
  if (typeof data === 'object') {
    // sometimes grouped { category: [names] }
    const out: string[] = [];
    for (const v of Object.values(data)) {
      if (Array.isArray(v)) out.push(...v.map((x: any) => (typeof x === 'string' ? x : x?.name || '')).filter(Boolean));
      else if (typeof v === 'string') out.push(v);
    }
    return out;
  }
  return [];
}

/** First argument that is a non-empty string, else null (for tolerant field-name mapping). */
function firstString(...vals: any[]): string | null {
  for (const v of vals) if (typeof v === 'string' && v.trim()) return v.trim();
  return null;
}

function numOrNull(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function emptyReport(url: string, error: string): SeoptimerReport {
  return {
    ok: false,
    url,
    finalUrl: url,
    scores: {},
    checks: [],
    recommendations: [],
    keywordRankings: [],
    keywordPositions: {},
    aiOverviewRankings: [],
    backlinks: null,
    trafficFromSearch: null,
    technologies: [],
    error,
  };
}

/**
 * Map a SEOptimer letter grade to a 0-100 score (for mixing with Lighthouse etc.).
 * Returns null for an empty/unknown grade.
 */
export function gradeToScore(grade: string): number | null {
  const map: Record<string, number> = {
    'A+': 98, A: 92, 'A-': 88,
    'B+': 84, B: 80, 'B-': 76,
    'C+': 72, C: 68, 'C-': 64,
    'D+': 60, D: 55, 'D-': 50,
    E: 40, F: 25,
  };
  const g = (grade || '').trim().toUpperCase();
  return g in map ? map[g] : null;
}
