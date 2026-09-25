import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from '../config';
import { requestOnce, FetchResult } from '../lib/http';

/**
 * JavaScript rendering fallback for the crawlers.
 *
 * `fetchPage` is a drop-in replacement for `requestOnce`: it does the normal fast
 * HTTP fetch, and ONLY when RENDER_JS=1 and the page comes back thin (a JS-only SPA
 * shell or a bot-wall placeholder) does it re-fetch through a real Chromium browser
 * (Python Playwright, the same engine the 'google' SERP provider uses). With
 * RENDER_JS off (the default) it behaves exactly like `requestOnce`, so nothing
 * changes for the common case of server-rendered client sites.
 *
 * Graceful degradation: if Python or Playwright is not installed, the render step
 * fails quietly and the original plain-fetch result is returned.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const RENDER_SCRIPT = join(HERE, '..', '..', 'python', 'render_page.py');

export function renderEnabled(): boolean {
  return config.render.enabled;
}

/** Count visible-ish words in raw HTML (cheap — no full parse). */
function wordsIn(html: string): number {
  const text = (html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.split(' ').length : 0;
}

/** Render a URL in a real browser and return its fully-rendered HTML. */
export function renderPage(url: string): Promise<{ html: string; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(config.render.pythonBin, [RENDER_SCRIPT, url], {
      env: {
        ...process.env,
        SERP_HEADLESS: config.serp.headless ? '1' : '0',
        SERP_PROXY: config.serp.proxy,
        CRAWL_UA: config.crawl.userAgent,
      },
    });
    let out = '';
    let errOut = '';
    const timer = setTimeout(() => { child.kill(); resolve({ html: '', error: 'render timed out' }); }, config.render.timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (errOut += d));
    child.on('error', (e) => { clearTimeout(timer); resolve({ html: '', error: `cannot run python (${config.render.pythonBin}): ${e.message}` }); });
    child.on('close', () => {
      clearTimeout(timer);
      if (out.trim()) resolve({ html: out });
      else resolve({ html: '', error: errOut.trim().slice(0, 200) || 'render returned nothing' });
    });
  });
}

/**
 * Fetch a page, rendering it in a real browser when RENDER_JS=1 and the plain body
 * looks like a JS shell. Returns the same FetchResult shape as `requestOnce`, so it
 * is a drop-in replacement inside any crawl loop.
 */
export async function fetchPage(url: string): Promise<FetchResult> {
  const res = await requestOnce(url);
  if (!config.render.enabled) return res;
  // Only render terminal HTML 200s — never redirects, errors, or non-HTML.
  if (res.redirected || res.status !== 200 || !/text\/html/i.test(res.contentType)) return res;
  if (wordsIn(res.body) >= config.render.minWords) return res;

  const rendered = await renderPage(res.finalUrl || url);
  if (rendered.html && wordsIn(rendered.html) > wordsIn(res.body)) {
    return { ...res, body: rendered.html };
  }
  return res;
}
