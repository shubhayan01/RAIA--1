import * as cheerio from 'cheerio';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from '../config';
import { timedFetch, getJSON } from '../lib/http';

export interface SerpResult {
  position: number;
  title: string;
  url: string;
  domain: string;
  snippet: string;
}

export interface SerpResponse {
  query: string;
  provider: string;
  results: SerpResult[];
  relatedSearches: string[];
  paa?: string[];                // People Also Ask
  aiOverviewSources?: string[];  // links cited in Google's AI Overview (when present)
  error?: string;                // set when the provider could not fetch (captcha, no key, timeout)
  captcha?: boolean;             // true = Google served a bot challenge
}

/**
 * Adapter. Default FREE provider = real Chromium via Playwright (Python) hitting
 * live Google. Set SERP_PROVIDER=serpapi|dataforseo|serper for a guaranteed,
 * key-based SERP source ("SERP reports"). `scrape` = legacy DuckDuckGo fallback.
 */
export async function serp(query: string, count = 10): Promise<SerpResponse> {
  switch (config.serp.provider) {
    case 'tavily':
      return tavily(query, count);
    case 'serpapi':
      return serpApi(query, count);
    case 'dataforseo':
      return dataForSeo(query, count);
    case 'scrape':
      return duckduckgo(query, count);
    case 'none':
      return { query, provider: 'none', results: [], relatedSearches: [], error: 'SERP disabled' };
    case 'google':
    case 'browser':
    default:
      return googleBrowser(query, count);
  }
}

export function serpEnabled(): boolean {
  return config.serp.provider !== 'none';
}

/**
 * A user-facing explanation when a SERP call came back with no usable results,
 * so tools can be HONEST (challenge / not-set-up) instead of implying "no data = truth".
 * Returns null when the response actually has results.
 */
export function serpErrorNote(resp: SerpResponse): string | null {
  if (resp.results.length) return null;
  if (resp.captcha)
    return 'Google served a bot challenge — this network looks automated to it. Fixes: run with SERP_HEADLESS=0 (shows the browser, far less likely to be blocked), set SERP_PROXY to a residential proxy, wait and retry, or set SERP_PROVIDER=serpapi for guaranteed SERP reports.';
  if (resp.error)
    return `Live SERP source unavailable (${resp.error}). Try SERP_HEADLESS=0, a residential SERP_PROXY, or SERP_PROVIDER=serpapi.`;
  return 'The SERP source returned no results for this query.';
}

/* -------- FREE: real Google via Playwright browser (Python) -------- */
const HERE = dirname(fileURLToPath(import.meta.url));
const SERP_SCRIPT = join(HERE, '..', '..', 'python', 'google_serp.py');

async function googleBrowser(query: string, count: number): Promise<SerpResponse> {
  try {
    const raw = await runPython(query, count);
    const data = JSON.parse(raw);
    const results: SerpResult[] = (data.results || []).map((r: any, i: number) => ({
      position: r.position || i + 1,
      title: r.title || '',
      url: r.url || '',
      domain: domainOf(r.url || ''),
      snippet: r.snippet || '',
    }));
    return {
      query,
      provider: 'google-browser',
      results,
      relatedSearches: data.related || [],
      paa: data.paa || [],
      aiOverviewSources: data.aiOverview || [],
      error: data.error || undefined,
      captcha: !!data.captcha,
    };
  } catch (e: any) {
    return { query, provider: 'google-browser', results: [], relatedSearches: [], error: String(e?.message || e) };
  }
}

function runPython(query: string, count: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.serp.pythonBin, [SERP_SCRIPT, query, String(count)], {
      env: {
        ...process.env,
        SERP_HEADLESS: config.serp.headless ? '1' : '0',
        SERP_GL: config.serp.gl,
        SERP_HL: config.serp.hl,
        SERP_PROXY: config.serp.proxy,
      },
    });
    let out = '', errOut = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('browser SERP timed out')); }, 90000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (errOut += d));
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`cannot run python (${config.serp.pythonBin}): ${e.message}`)); });
    child.on('close', () => {
      clearTimeout(timer);
      if (out.trim()) resolve(out.trim());
      else reject(new Error(errOut.trim().slice(0, 200) || 'browser SERP returned nothing'));
    });
  });
}

function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/* -------- FREE: DuckDuckGo HTML -------- */
async function duckduckgo(query: string, count: number): Promise<SerpResponse> {
  const res = await timedFetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': config.crawl.userAgent,
    },
    body: new URLSearchParams({ q: query, kl: 'us-en' }).toString(),
  }, 12000);

  const html = await res.text();
  // DuckDuckGo now serves a 202 "anomaly" challenge instead of results when it
  // suspects automation — report that honestly rather than "0 results".
  if (res.status === 202 || /anomaly|challenge/i.test(html.slice(0, 500))) {
    return { query, provider: 'duckduckgo', results: [], relatedSearches: [], error: 'DuckDuckGo served a bot challenge', captcha: true };
  }
  const $ = cheerio.load(html);
  const results: SerpResult[] = [];

  $('.result').each((_, el) => {
    if (results.length >= count) return;
    const a = $(el).find('.result__a').first();
    let href = a.attr('href') || '';
    // DDG wraps links in a redirect: /l/?uddg=<encoded>
    const m = href.match(/[?&]uddg=([^&]+)/);
    if (m) href = decodeURIComponent(m[1]);
    if (!href || !/^https?:\/\//.test(href)) return;
    const title = a.text().replace(/\s+/g, ' ').trim();
    const snippet = $(el).find('.result__snippet').text().replace(/\s+/g, ' ').trim();
    if (!title) return;
    results.push({ position: results.length + 1, title, url: href, domain: domainOf(href), snippet });
  });

  return { query, provider: 'duckduckgo', results, relatedSearches: [] };
}

/* -------- KEY-BASED: Tavily (LLM search API, no CAPTCHA) -------- */
async function tavily(query: string, count: number): Promise<SerpResponse> {
  const key = config.serp.tavilyKey || config.serp.apiKey;
  if (!key) return { query, provider: 'tavily', results: [], relatedSearches: [], error: 'TAVILY_API_KEY missing for tavily' };
  try {
    const res = await timedFetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        query,
        max_results: count,
        search_depth: 'advanced',      // richer ranking; pulls more relevant organic pages
        include_answer: true,          // Tavily's synthesized answer ~= AI-Overview proxy
        include_raw_content: false,
      }),
    }, 20000);
    const data: any = await res.json();
    if (!res.ok) {
      return { query, provider: 'tavily', results: [], relatedSearches: [], error: data?.error || `tavily -> ${res.status}` };
    }
    const results: SerpResult[] = (data.results || []).slice(0, count).map((r: any, i: number) => ({
      position: i + 1,
      title: r.title || '',
      url: r.url || '',
      domain: domainOf(r.url || ''),
      snippet: r.content || '',
    }));
    // Tavily returns follow-up questions rather than Google "related searches".
    const relatedSearches: string[] = Array.isArray(data.follow_up_questions) ? data.follow_up_questions.filter(Boolean) : [];
    // When Tavily generates an answer it cites the pages it drew from — treat the
    // top results as the AI-Overview-style source set so the AI Overview tool works.
    const aiOverviewSources = data.answer ? results.slice(0, 5).map((r) => r.url) : [];
    return { query, provider: 'tavily', results, relatedSearches, aiOverviewSources };
  } catch (e: any) {
    return { query, provider: 'tavily', results: [], relatedSearches: [], error: String(e?.message || e) };
  }
}

/* -------- PAID: SerpApi (Google) -------- */
async function serpApi(query: string, count: number): Promise<SerpResponse> {
  if (!config.serp.apiKey) throw new Error('SERP_API_KEY missing for serpapi');
  const url = `https://serpapi.com/search.json?engine=google&num=${count}&q=${encodeURIComponent(query)}&api_key=${config.serp.apiKey}`;
  const data = await getJSON<any>(url, {}, 15000);
  const results: SerpResult[] = (data.organic_results || []).slice(0, count).map((r: any, i: number) => ({
    position: r.position || i + 1,
    title: r.title || '',
    url: r.link || '',
    domain: domainOf(r.link || ''),
    snippet: r.snippet || '',
  }));
  const relatedSearches = (data.related_searches || []).map((r: any) => r.query).filter(Boolean);
  return { query, provider: 'serpapi', results, relatedSearches };
}

/* -------- PAID: DataForSEO (Google Live) -------- */
async function dataForSeo(query: string, count: number): Promise<SerpResponse> {
  if (!config.serp.apiKey) throw new Error('SERP_API_KEY (base64 login:password) missing for dataforseo');
  const res = await timedFetch('https://api.dataforseo.com/v3/serp/google/organic/live/advanced', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${config.serp.apiKey}` },
    body: JSON.stringify([{ keyword: query, language_code: 'en', location_code: 2840, depth: count }]),
  }, 20000);
  const data: any = await res.json();
  const items = data?.tasks?.[0]?.result?.[0]?.items || [];
  const results: SerpResult[] = items
    .filter((i: any) => i.type === 'organic')
    .slice(0, count)
    .map((r: any, i: number) => ({
      position: r.rank_absolute || i + 1,
      title: r.title || '',
      url: r.url || '',
      domain: domainOf(r.url || ''),
      snippet: r.description || '',
    }));
  return { query, provider: 'dataforseo', results, relatedSearches: [] };
}
