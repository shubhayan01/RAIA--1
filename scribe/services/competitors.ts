import { fetchPageContent } from '../sources/content';
import { pool } from '../lib/concurrency';
import { completeJSON, llmConfigured } from '../llm';
import { config } from '../config';
import { Report, b } from '../lib/report';
import { ContentProject, CompetitorAnalysis, loadProject, saveProject, advanceStatus } from '../lib/project';
import { runResearch } from './research';

/**
 * Competitor content analysis (SCRIBE Feature 2).
 *
 * Deep-fetches each top-ranking page and extracts REAL structural signals: word
 * count, heading outline, FAQ/table/list presence, images, byline. The LLM then
 * summarises "what the winning content has in common" — but ONLY over the real
 * scraped outlines it is handed. It never invents a competitor's structure.
 */

export interface CompetitorSynthesis {
  commonThemes: string[];       // topics every top page covers
  formatPatterns: string[];     // structural patterns (FAQ sections, comparison tables, etc.)
  depthNote: string;            // how deep/comprehensive the winners are
  toBeatBar: string;            // what it takes to outrank them
}

export async function runCompetitorAnalysis(keyword: string, opts: { siteUrl?: string; extraInfo?: string } = {}): Promise<Report> {
  let project = await loadProject(keyword);
  if (!project?.research?.topBlogs?.length) {
    // Research is a prerequisite — run it first, then re-load.
    await runResearch(keyword, opts);
    project = await loadProject(keyword);
  }
  if (!project?.research?.topBlogs?.length) {
    return { tag: 'Competitors', title: 'No ranking pages', blocks: [b.note('I could not fetch ranking pages for this keyword. Check the SERP source (TAVILY_API_KEY or SERP_PROVIDER=google) and retry.')] };
  }

  const analyses = await analyzeCompetitors(project);
  project.competitors = analyses;
  advanceStatus(project, 'analyzed');
  await saveProject(project);

  const synthesis = await synthesize(project.keyword, analyses);
  return competitorReport(project, synthesis);
}

/** Deep-fetch + analyse the top N ranking pages. Reusable by the workflow. */
export async function analyzeCompetitors(project: ContentProject): Promise<CompetitorAnalysis[]> {
  const urls = (project.research!.topBlogs || []).slice(0, config.content.competitorDepth);
  const results = await pool(urls, 4, async (blog): Promise<CompetitorAnalysis> => {
    const page = await fetchPageContent(blog.url).catch(() => null);
    if (!page || !page.reachable) {
      return {
        url: blog.url, domain: blog.domain, title: blog.title, wordCount: 0,
        h2Count: 0, h3Count: 0, headings: [], hasFAQ: false, hasTable: false, hasList: false,
        imageCount: 0, authorHint: null, reachable: false, error: page?.error || 'unreachable',
      };
    }
    return {
      url: page.finalUrl, domain: page.domain, title: page.title || blog.title,
      wordCount: page.wordCount, h2Count: page.h2Count, h3Count: page.h3Count,
      headings: page.headings.slice(0, 25),
      hasFAQ: page.hasFAQ, hasTable: page.hasTable, hasList: page.hasList,
      imageCount: page.imageCount, authorHint: page.authorHint, reachable: true,
    };
  });
  return results;
}

/* ------------------------------ LLM synthesis ------------------------------ */

const SYNTH_SYSTEM = `You are a senior content strategist. You will receive REAL scraped structural data for the pages currently ranking for a keyword: each page's word count and its heading outline (H2/H3), plus whether it has FAQ, table and list elements.

Summarise the pattern of the winning content. Return ONLY minified JSON with these keys:
{"commonThemes": string[],   // subtopics that MOST of the top pages cover (from their real headings)
 "formatPatterns": string[], // structural patterns you actually see (e.g. "FAQ section", "comparison table", "step-by-step list")
 "depthNote": string,        // one sentence on how comprehensive the winners are, referencing the real word counts
 "toBeatBar": string}        // one sentence: what a new page must do to outrank these

Rules:
- Base every theme on headings that ACTUALLY appear in the data. Do not invent subtopics.
- Do not fabricate word counts or claims. Reference only the numbers provided.
- Keep each array to 4-8 concise items.`;

export async function synthesize(keyword: string, analyses: CompetitorAnalysis[]): Promise<CompetitorSynthesis | null> {
  if (!llmConfigured()) return null;
  const reachable = analyses.filter((a) => a.reachable);
  if (!reachable.length) return null;
  const payload = {
    keyword,
    pages: reachable.map((a) => ({
      domain: a.domain,
      wordCount: a.wordCount,
      headings: a.headings.map((h) => `H${h.level}: ${h.text}`),
      hasFAQ: a.hasFAQ, hasTable: a.hasTable, hasList: a.hasList,
    })),
  };
  try {
    return await completeJSON<CompetitorSynthesis>(SYNTH_SYSTEM, JSON.stringify(payload), { temperature: 0.3, maxTokens: 1500 });
  } catch {
    return null;
  }
}

/* ------------------------------ report ------------------------------ */

export function competitorReport(project: ContentProject, synthesis: CompetitorSynthesis | null): Report {
  const analyses = project.competitors || [];
  const reachable = analyses.filter((a) => a.reachable);
  const blocks = [];

  blocks.push(b.p(`Deep content analysis of the top ${reachable.length} ranking page${reachable.length === 1 ? '' : 's'} for "${project.keyword}". Every number below is measured from the live page.`));

  blocks.push(b.table(
    ['Domain', 'Words', 'H2', 'H3', 'FAQ', 'Table', 'List'],
    reachable.map((a) => [
      a.domain,
      a.wordCount.toLocaleString(),
      a.h2Count,
      a.h3Count,
      a.hasFAQ ? '✓' : '—',
      a.hasTable ? '✓' : '—',
      a.hasList ? '✓' : '—',
    ]),
  ));

  const unreachable = analyses.filter((a) => !a.reachable);
  if (unreachable.length) {
    blocks.push(b.note(`${unreachable.length} page(s) could not be fetched for deep analysis: ${unreachable.map((u) => u.domain).join(', ')}.`));
  }

  if (synthesis) {
    if (synthesis.commonThemes?.length) {
      blocks.push(b.p('Subtopics the winners consistently cover:'));
      blocks.push(b.list(synthesis.commonThemes));
    }
    if (synthesis.formatPatterns?.length) {
      blocks.push(b.p('Format patterns that rank:'));
      blocks.push(b.chips(synthesis.formatPatterns));
    }
    if (synthesis.depthNote) blocks.push(b.note(`Depth: ${synthesis.depthNote}`));
    if (synthesis.toBeatBar) blocks.push(b.note(`To outrank them: ${synthesis.toBeatBar}`));
  } else if (!llmConfigured()) {
    blocks.push(b.note('Add an LLM key to get the strategic synthesis of what the winning content has in common. The measured table above is real regardless.'));
  }

  blocks.push(b.chips(['Find content gaps', 'Write draft']));

  return { tag: 'Competitors', title: `Competitor analysis — ${project.keyword}`, blocks, data: { key: project.key, keyword: project.keyword } };
}
