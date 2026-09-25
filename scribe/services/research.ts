import { serp, serpErrorNote } from '../sources/serp';
import { fetchPageContent } from '../sources/content';
import { pool } from '../lib/concurrency';
import { config } from '../config';
import { Report, b } from '../lib/report';
import { ContentProject, ResearchData, ensureProject, saveProject, advanceStatus } from '../lib/project';

/**
 * Keyword research (SCRIBE Feature 1).
 *
 * Runs a REAL search for the keyword (Tavily / live Google / etc.), takes the
 * top-ranking blogs, measures each one's actual word count by fetching the page,
 * and reports the average/median. Related searches and People-Also-Ask come from
 * the SERP response. NOTHING here is invented by the LLM — every ranking, URL and
 * word count is measured. Honest failure on a blocked/empty SERP.
 */

export async function runResearch(keyword: string, opts: { siteUrl?: string; extraInfo?: string } = {}): Promise<Report> {
  const kw = keyword.trim();
  if (!kw) {
    return { tag: 'Research', title: 'No keyword', blocks: [b.note('Give me a keyword to research, e.g. "research best running shoes for flat feet".')] };
  }

  const project = await ensureProject(kw, opts.siteUrl, opts.extraInfo);
  const research = await gatherResearch(kw);
  project.research = research;
  advanceStatus(project, 'researched');
  await saveProject(project);

  return researchReport(project);
}

/** The measurement pipeline, reusable by the full workflow. */
export async function gatherResearch(keyword: string): Promise<ResearchData> {
  const resp = await serp(keyword, 10);
  const note = serpErrorNote(resp);

  const ranked = resp.results.slice(0, config.content.competitorDepth + 4);

  // In fast mode we skip fetching every ranking page just to MEASURE its word
  // count — that is ~10 page fetches (~30-40s) that fast mode does not need (it
  // uses a default word target and mines snippets, not page bodies). Deep mode
  // still measures, since it fetches those pages for evidence anyway.
  const measured = config.content.researchMode === 'fast'
    ? ranked.map((r) => ({ r, wordCount: null as number | null }))
    : await pool(ranked, 4, async (r) => {
        const page = await fetchPageContent(r.url).catch(() => null);
        return { r, wordCount: page?.reachable ? page.wordCount : null };
      });

  const topBlogs = measured.map(({ r, wordCount }) => ({
    position: r.position,
    title: r.title,
    url: r.url,
    domain: r.domain,
    snippet: r.snippet,
    wordCount,
  }));

  // Keep only plausible article lengths — drop mis-scraped pages (tiny JS shells,
  // or huge docs whose nav/boilerplate inflate the count) so the average and the
  // downstream word target aren't skewed by outliers.
  const counts = topBlogs
    .map((t) => t.wordCount)
    .filter((n): n is number => typeof n === 'number' && n >= 250 && n <= 6000);
  const avg = counts.length ? Math.round(counts.reduce((a, c) => a + c, 0) / counts.length) : null;
  const median = counts.length ? medianOf(counts) : null;

  return {
    keyword,
    provider: resp.provider,
    fetchedAt: new Date().toISOString(),
    topBlogs,
    avgWordCount: avg,
    medianWordCount: median,
    relatedSearches: resp.relatedSearches || [],
    peopleAlsoAsk: resp.paa || [],
    aiOverviewSources: resp.aiOverviewSources || [],
    serpError: note,
  };
}

function medianOf(nums: number[]): number {
  const s = [...nums].sort((a, c) => a - c);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/**
 * A realistic word target for the draft: prefer the median competitor length
 * (robust to outliers), fall back to the average, then the configured default —
 * and clamp to a range a single well-structured article (and one generation run)
 * can actually deliver densely, rather than an unreachable number.
 */
export function targetWordCount(research?: { avgWordCount: number | null; medianWordCount: number | null } | null): number {
  const base = research?.medianWordCount ?? research?.avgWordCount ?? config.content.defaultWordTarget;
  const withHeadroom = Math.round(base * 1.1);
  const FLOOR = 900;
  // Ceiling is configurable: a lower cap keeps the single write call within a small
  // per-minute token budget. Raise SCRIBE_WORD_CEIL on a faster/paid LLM tier.
  const CEIL = config.content.wordTargetCeil;
  return Math.max(FLOOR, Math.min(CEIL, withHeadroom));
}

/* ------------------------------ report ------------------------------ */

export function researchReport(project: ContentProject): Report {
  const r = project.research!;
  const blocks = [];

  if (!r.topBlogs.length) {
    blocks.push(b.note(r.serpError || 'The search returned no results for this keyword. Set TAVILY_API_KEY (SERP_PROVIDER=tavily) or SERP_PROVIDER=google for live search.'));
    return { tag: 'Research', title: `Keyword research — ${r.keyword}`, blocks, data: { key: project.key, keyword: r.keyword } };
  }

  blocks.push(b.p(`Top-ranking content for "${r.keyword}" (via ${r.provider}). Word counts are measured live from each page — that is the length you'll need to compete.`));

  blocks.push(b.kv([
    { k: 'Ranking pages found', v: String(r.topBlogs.length) },
    { k: 'Average word count', v: r.avgWordCount != null ? `${r.avgWordCount.toLocaleString()} words` : 'could not measure' },
    { k: 'Median word count', v: r.medianWordCount != null ? `${r.medianWordCount.toLocaleString()} words` : '—' },
    { k: 'Suggested draft target', v: `${targetWordCount(r).toLocaleString()} words${r.medianWordCount != null ? ' (from the median, outliers dropped)' : ''}` },
  ]));

  blocks.push(b.table(
    ['#', 'Title', 'Domain', 'Words'],
    r.topBlogs.slice(0, 10).map((t) => [
      t.position,
      (t.title || t.url).slice(0, 60),
      t.domain,
      t.wordCount != null ? t.wordCount.toLocaleString() : '—',
    ]),
  ));

  if (r.peopleAlsoAsk.length) {
    blocks.push(b.p('People also ask:'));
    blocks.push(b.list(r.peopleAlsoAsk.slice(0, 8)));
  }
  if (r.relatedSearches.length) {
    blocks.push(b.p('Related searches:'));
    blocks.push(b.chips(r.relatedSearches.slice(0, 12)));
  }
  if (r.serpError) blocks.push(b.note(r.serpError));

  blocks.push(b.chips(['Analyze competitors', 'Find content gaps', 'Expand keywords', 'Write draft']));

  return {
    tag: 'Research',
    title: `Keyword research — ${r.keyword}`,
    blocks,
    data: { key: project.key, keyword: r.keyword },
  };
}
