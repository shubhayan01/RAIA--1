import { serp, serpEnabled, serpErrorNote } from '../sources/serp';
import { seoptimerEnabled, seoptimerReport, SeoptimerReport, SeoptimerKeywordRank } from '../sources/seoptimer';
import { pool } from '../lib/concurrency';
import { Report, b } from '../lib/report';

/**
 * Rank Tracker.
 * Preferred source = SEOptimer (real Google positions with search volume +
 * estimated traffic, no CAPTCHA). Falls back to the live SERP for any keywords
 * SEOptimer doesn't already track, and when no SEOptimer key is set.
 * No LLM — positions are read straight from the data source.
 */

export interface RankRow {
  keyword: string;
  position: number | null; // null = not found in the checked depth
  url: string | null;
  bucket: 'Top 3' | 'Top 10' | 'Top 30' | 'Not found' | 'No data';
  error?: boolean;         // true = source itself failed (do NOT read as "not ranking")
  source?: 'seoptimer' | 'serp';
  country?: string;
  searches?: string | null;
  traffic?: string | null;
}

const DEPTH = 30;
const MAX_KEYWORDS = 25;

export async function runRanks(input: { text: string; domain?: string; keywords?: string[] }): Promise<Report> {
  const parsed = parseInput(input);
  const domain = parsed.domain;
  const keywords = (input.keywords?.length ? input.keywords : parsed.keywords).slice(0, MAX_KEYWORDS);

  if (!domain) throw new Error('Give me a domain and keywords, e.g. “yoursite.com: running shoes, best trainers, marathon shoes”.');

  // ---- Preferred: SEOptimer real rankings (no CAPTCHA) ----
  if (seoptimerEnabled()) {
    const so = await seoptimerReport(domain);
    if (so.ok) return ranksFromSeoptimer(domain, keywords, so);
    // SEOptimer failed — fall back to live SERP only if we can.
    if (!keywords.length || !serpEnabled()) {
      return {
        tag: 'Rank Tracker', title: `Rankings for ${domain}`,
        blocks: [
          b.p(`Could not fetch rankings for ${domain}.`),
          b.note(`SEOptimer unavailable (${so.error}). Add keywords and a SERP_PROVIDER to check positions live, or retry.`),
        ],
        data: { domain },
      };
    }
    // else: continue to the live SERP path below with the supplied keywords.
  }

  // ---- Fallback: live SERP per keyword ----
  if (!keywords.length) throw new Error(`Add the keywords to track for ${domain}, comma-separated.`);
  if (!serpEnabled()) return { tag: 'Rank Tracker', title: 'SERP disabled', blocks: [b.note('Set SEOPTIMER_API_KEY for real rankings, or SERP_PROVIDER (serpapi/dataforseo) for live positions.')] };

  // Throttle: rank checks hit Google repeatedly — keep concurrency low to avoid bans.
  const rows = await pool(keywords, 2, (kw) => serpRank(kw, domain));
  rows.sort((a, c) => (a.position ?? 9999) - (c.position ?? 9999));

  if (rows.every((r) => r.error)) {
    return {
      tag: 'Rank Tracker', title: `Rankings for ${domain}`,
      blocks: [
        b.p(`Could not check rankings for ${domain} — the live SERP source did not return results.`),
        b.note(serpErrorNote({ query: '', provider: '', results: [], relatedSearches: [], captcha: true })!),
      ],
      data: { domain, rows },
    };
  }

  return renderRows(domain, rows, `Checked ${rows.filter((r) => !r.error).length} keyword(s) for ${domain} against live Google results (depth ${DEPTH}).`,
    'Positions come straight from the live SERP. Set SEOPTIMER_API_KEY for real rankings with search volume and estimated traffic.');
}

/* ------------------------------------------------------------------ */
/* SEOptimer-backed rankings                                           */
/* ------------------------------------------------------------------ */
async function ranksFromSeoptimer(domain: string, keywords: string[], so: SeoptimerReport): Promise<Report> {
  const best = bestRankByKeyword(so.keywordRankings);

  // Discovery view: no specific keywords -> show what the domain already ranks for.
  if (!keywords.length) {
    const blocks = [];
    if (!so.keywordRankings.length) {
      blocks.push(b.p(`SEOptimer did not return tracked keyword rankings for ${domain}.`));
      blocks.push(b.note('This is common for very new or low-traffic domains. Give me specific keywords to check their live positions instead.'));
      return { tag: 'Rank Tracker', title: `Rankings for ${domain}`, blocks, data: { domain, seoptimer: so.raw } };
    }
    const top = so.keywordRankings.slice().sort((a, c) => a.position - c.position).slice(0, MAX_KEYWORDS);
    blocks.push(b.p(`Real keyword rankings for ${domain} (SEOptimer — ${so.keywordRankings.length} tracked). Give me specific keywords to check any of your own targets.`));

    const dist = so.keywordPositions;
    if (Object.keys(dist).length) {
      blocks.push(b.kv(Object.entries(dist).map(([k, v]) => ({ k, v: v.toLocaleString('en-US') }))));
    }
    blocks.push(b.table(
      ['Keyword', 'Country', 'Position', 'Searches', 'Est. traffic'],
      top.map((r) => [r.keyword, r.country || '—', r.position || '—', r.totalSearches ?? '—', r.estimatedTraffic ?? '—']),
    ));
    blocks.push(b.note('Positions and volumes are measured by SEOptimer — not estimated by the AI.'));
    return { tag: 'Rank Tracker', title: `Rankings for ${domain}`, blocks, data: { domain, rankings: so.keywordRankings } };
  }

  // Targeted view: cross-match supplied keywords; live-SERP the misses.
  const rows: RankRow[] = [];
  const misses: string[] = [];
  for (const kw of keywords) {
    const m = best.get(kw.trim().toLowerCase());
    if (m) {
      rows.push({
        keyword: kw, position: m.position, url: null, bucket: bucketOf(m.position),
        source: 'seoptimer', country: m.country, searches: m.totalSearches, traffic: m.estimatedTraffic,
      });
    } else {
      misses.push(kw);
    }
  }

  let missNote = '';
  if (misses.length) {
    if (serpEnabled()) {
      const fb = await pool(misses, 2, (kw) => serpRank(kw, domain));
      rows.push(...fb);
      missNote = ` ${misses.length} keyword(s) not in SEOptimer's tracked set were checked live against Google.`;
    } else {
      for (const kw of misses) rows.push({ keyword: kw, position: null, url: null, bucket: 'No data', source: 'seoptimer' });
      missNote = ` ${misses.length} keyword(s) are not in SEOptimer's top-ranking set — they may still rank lower. Set a SERP_PROVIDER to confirm live.`;
    }
  }

  rows.sort((a, c) => (a.position ?? 9999) - (c.position ?? 9999));
  return renderRows(domain, rows,
    `Checked ${rows.length} keyword(s) for ${domain}. Real positions from SEOptimer where available.${missNote}`,
    'SEOptimer positions include real search volume and estimated traffic. The AI does not invent any of these numbers.');
}

/** Collapse SEOptimer's per-country rankings to the best (lowest) position per keyword. */
function bestRankByKeyword(list: SeoptimerKeywordRank[]): Map<string, SeoptimerKeywordRank> {
  const map = new Map<string, SeoptimerKeywordRank>();
  for (const r of list) {
    const key = r.keyword.trim().toLowerCase();
    const cur = map.get(key);
    if (!cur || (r.position && r.position < cur.position)) map.set(key, r);
  }
  return map;
}

/* ------------------------------------------------------------------ */
/* Live SERP check for one keyword                                     */
/* ------------------------------------------------------------------ */
async function serpRank(kw: string, domain: string): Promise<RankRow> {
  try {
    const r = await serp(kw, DEPTH);
    if (serpErrorNote(r)) return { keyword: kw, position: null, url: null, bucket: 'No data', error: true, source: 'serp' };
    const hit = r.results.find((res) => domainMatch(res.domain, domain));
    const position = hit ? hit.position : null;
    return { keyword: kw, position, url: hit ? hit.url : null, bucket: bucketOf(position), source: 'serp' };
  } catch {
    return { keyword: kw, position: null, url: null, bucket: 'No data', error: true, source: 'serp' };
  }
}

/* ------------------------------------------------------------------ */
/* Shared rendering                                                    */
/* ------------------------------------------------------------------ */
function renderRows(domain: string, rows: RankRow[], summary: string, footnote: string): Report {
  const checked = rows.filter((r) => !r.error);
  const errored = rows.length - checked.length;
  const top3 = checked.filter((r) => r.bucket === 'Top 3').length;
  const top10 = checked.filter((r) => r.position != null && r.position <= 10).length;
  const found = checked.filter((r) => r.position != null).length;
  const hasMetrics = rows.some((r) => r.searches || r.traffic);

  const blocks = [];
  blocks.push(b.p(summary + (errored ? ` ${errored} could not be checked (source blocked).` : '')));
  blocks.push(b.kv([
    { k: 'In top 3', v: String(top3) },
    { k: 'In top 10', v: String(top10) },
    { k: 'Ranking (top 30)', v: `${found}/${checked.length}` },
    { k: 'Not ranking (checked)', v: String(checked.length - found) },
    ...(errored ? [{ k: 'Could not check', v: String(errored) }] : []),
  ]));

  const head = hasMetrics
    ? ['Keyword', 'Position', 'Bucket', 'Searches', 'Est. traffic', 'Source']
    : ['Keyword', 'Position', 'Bucket', 'Ranking URL'];
  const body = rows.map((r) => hasMetrics
    ? [r.keyword, r.error ? '—' : (r.position ?? '—'), r.bucket, r.searches ?? '—', r.traffic ?? '—', r.source ?? '—']
    : [r.keyword, r.error ? '—' : (r.position ?? '—'), r.bucket, r.url ? shortUrl(r.url) : '—']);
  blocks.push(b.table(head, body));

  const striking = rows.filter((r) => r.position != null && r.position >= 4 && r.position <= 15);
  if (striking.length) {
    blocks.push(b.p('Striking distance (pos 4–15 — quick wins with on-page tweaks):'));
    blocks.push(b.chips(striking.map((r) => `${r.keyword} (#${r.position})`)));
  }

  blocks.push(b.note(footnote));
  return { tag: 'Rank Tracker', title: `Rankings for ${domain}`, blocks, data: { domain, rows } };
}

/* ------------------------------------------------------------------ */
/* Parsing + helpers                                                   */
/* ------------------------------------------------------------------ */
function parseInput(input: { text: string; domain?: string; keywords?: string[] }): { domain: string; keywords: string[] } {
  let domain = (input.domain || '').trim();
  let rest = (input.text || '').trim();

  // domain: before a colon, or the first URL/domain token
  const colon = rest.match(/^\s*([^\s:,]+\.[a-z]{2,}[^\s:,]*)\s*[:\-]\s*(.*)$/i);
  if (!domain && colon) { domain = colon[1]; rest = colon[2]; }
  if (!domain) {
    const m = rest.match(/\b((?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,})(\/[^\s]*)?/i);
    if (m) { domain = m[0]; rest = rest.replace(m[0], ' '); }
  }
  domain = normDomain(domain);

  rest = rest.replace(/\b(rank|ranks|ranking|rankings|track|tracker|for|keywords?|position|serp)\b/gi, ' ');
  const keywords = rest
    .split(/[,\n;]+/)
    .map((k) => k.replace(/\s{2,}/g, ' ').trim())
    .filter((k) => k.length >= 2);

  return { domain, keywords };
}

function bucketOf(pos: number | null): RankRow['bucket'] {
  if (pos == null) return 'Not found';
  if (pos <= 3) return 'Top 3';
  if (pos <= 10) return 'Top 10';
  if (pos <= 30) return 'Top 30';
  return 'Not found';
}
function domainMatch(a: string, b: string): boolean {
  const x = normDomain(a), y = normDomain(b);
  return !!x && !!y && (x === y || x.endsWith('.' + y) || y.endsWith('.' + x));
}
function normDomain(x: string): string {
  return (x || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
}
function shortUrl(u: string): string {
  try { const p = new URL(u); return (p.hostname + p.pathname).replace(/\/$/, '').slice(0, 60); } catch { return u.slice(0, 60); }
}
