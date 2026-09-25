import { config } from '../config';

export interface FetchResult {
  url: string;
  finalUrl: string;
  status: number;
  ok: boolean;
  redirected: boolean;
  location: string | null;
  contentType: string;
  headers: Record<string, string>;
  body: string;
  timeMs: number;
  error?: string;
}

const DEFAULT_HEADERS = {
  'User-Agent': config.crawl.userAgent,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

/** fetch with an AbortController timeout. */
export async function timedFetch(url: string, init: RequestInit = {}, timeoutMs = config.crawl.timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Single request WITHOUT auto-follow so we can observe redirects (chains/loops).
 * Reads body only for HTML/XML/text content.
 */
export async function requestOnce(url: string, opts: { method?: string; readBody?: boolean } = {}): Promise<FetchResult> {
  const start = Date.now();
  const base: FetchResult = {
    url,
    finalUrl: url,
    status: 0,
    ok: false,
    redirected: false,
    location: null,
    contentType: '',
    headers: {},
    body: '',
    timeMs: 0,
  };
  try {
    const res = await timedFetch(url, {
      method: opts.method || 'GET',
      redirect: 'manual',
      headers: DEFAULT_HEADERS,
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    const contentType = headers['content-type'] || '';
    const location = headers['location'] || null;
    const redirected = res.status >= 300 && res.status < 400 && !!location;

    let body = '';
    const readable = /text\/html|xml|text\/plain|json/i.test(contentType);
    if (opts.readBody !== false && readable && !redirected) {
      body = await res.text();
    } else {
      // drain to free the socket
      try { await res.arrayBuffer(); } catch { /* ignore */ }
    }

    return {
      ...base,
      finalUrl: res.url || url,
      status: res.status,
      ok: res.status >= 200 && res.status < 300,
      redirected,
      location: location ? absolutize(location, url) : null,
      contentType,
      headers,
      body,
      timeMs: Date.now() - start,
    };
  } catch (e: any) {
    return { ...base, status: 0, error: e?.name === 'AbortError' ? 'timeout' : String(e?.message || e), timeMs: Date.now() - start };
  }
}

/** Follow redirects manually up to `max`, returning the chain and loop detection. */
export async function followChain(url: string, max = 8) {
  const chain: { url: string; status: number }[] = [];
  const seen = new Set<string>();
  let current = url;
  let loop = false;
  let last: FetchResult | null = null;

  for (let i = 0; i < max; i++) {
    if (seen.has(current)) { loop = true; break; }
    seen.add(current);
    const res = await requestOnce(current);
    last = res;
    chain.push({ url: current, status: res.status });
    if (res.redirected && res.location) {
      current = res.location;
    } else {
      break;
    }
  }
  return { chain, loop, final: last, hops: chain.length - 1 };
}

export function absolutize(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

/** simple JSON GET helper */
export async function getJSON<T = any>(url: string, init: RequestInit = {}, timeoutMs?: number): Promise<T> {
  const res = await timedFetch(url, { ...init, headers: { Accept: 'application/json', ...(init.headers || {}) } }, timeoutMs);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return (await res.json()) as T;
}
