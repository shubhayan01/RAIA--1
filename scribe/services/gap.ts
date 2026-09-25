import { completeJSON, llmConfigured } from '../llm';
import { Report, b } from '../lib/report';
import { ContentProject, loadProject, saveProject } from '../lib/project';
import { runResearch } from './research';
import { analyzeCompetitors } from './competitors';
import { extractBrandProfile, BrandProfile } from './brand';

/**
 * Content-gap analysis (SCRIBE Feature 3).
 *
 * Compares what the top-ranking pages cover (REAL scraped headings) against the
 * user's own site (REAL scraped topics) and the People-Also-Ask questions, then
 * asks the LLM to name the gaps the user can exploit. The LLM reasons only over
 * the real coverage data it is handed — it never invents competitor coverage.
 */

export interface GapReport {
  gaps: { topic: string; whyItMatters: string; evidence: string }[];
  underservedQuestions: string[];
  differentiationAngle: string;
  quickWins: string[];
}

export async function runGapAnalysis(keyword: string, opts: { siteUrl?: string; extraInfo?: string } = {}): Promise<Report> {
  let project = await loadProject(keyword);
  if (!project) { await runResearch(keyword, opts); project = await loadProject(keyword); }
  if (!project) return { tag: 'Content Gap', title: 'No project', blocks: [b.note('Could not start a project for that keyword.')] };

  // Ensure prerequisites: competitor outlines + (optional) brand topics.
  if (!project.competitors?.length && project.research?.topBlogs?.length) {
    project.competitors = await analyzeCompetitors(project);
    await saveProject(project);
  }
  const siteUrl = opts.siteUrl || project.siteUrl;
  let brand = project.brand as BrandProfile | undefined;
  if (!brand && siteUrl) {
    brand = await extractBrandProfile(siteUrl);
    project.brand = brand;
    await saveProject(project);
  }

  if (!project.competitors?.length) {
    return { tag: 'Content Gap', title: 'Need competitor data', blocks: [b.note('I could not fetch competitor pages to compare against. Check the SERP source and retry.')] };
  }
  if (!llmConfigured()) {
    return { tag: 'Content Gap', title: 'LLM required', blocks: [b.note('Add an LLM key — the gap analysis reasons over the real scraped coverage to name opportunities.')] };
  }

  const gap = await computeGaps(project, brand);
  project.gap = gap;
  await saveProject(project);
  return gapReport(project, gap, brand);
}

async function computeGaps(project: ContentProject, brand?: BrandProfile): Promise<GapReport | null> {
  const competitorHeadings = (project.competitors || [])
    .filter((c) => c.reachable)
    .map((c) => ({ domain: c.domain, headings: c.headings.map((h) => h.text) }));

  const payload = {
    keyword: project.keyword,
    extraInfo: project.extraInfo || '',
    peopleAlsoAsk: project.research?.peopleAlsoAsk || [],
    relatedSearches: project.research?.relatedSearches || [],
    competitorCoverage: competitorHeadings,
    yourSiteTopics: brand?.topicsCovered || [],
    yourBrand: brand?.brandName || '',
  };
  try {
    return await completeJSON<GapReport>(GAP_SYSTEM, JSON.stringify(payload), { temperature: 0.4, maxTokens: 1600 });
  } catch { return null; }
}

const GAP_SYSTEM = `You are a content strategist finding the openings a new article can exploit to outrank incumbents.

You receive: the keyword, the REAL heading outlines of the top-ranking pages (competitorCoverage), the People-Also-Ask questions, related searches, and the topics the user's own site already covers (yourSiteTopics).

Find the GAPS: angles or subtopics that are under-covered by competitors, or questions readers ask that the top pages answer poorly, or angles the user's own expertise (yourSiteTopics) uniquely positions them to own.

Return ONLY minified JSON:
{"gaps": [{"topic": string, "whyItMatters": string, "evidence": string}],  // evidence must reference the real data (a PAA question, a missing subtopic across competitors, etc.)
 "underservedQuestions": string[],       // reader questions the current top results answer weakly
 "differentiationAngle": string,         // the single strongest way for the user to stand out
 "quickWins": string[]}                  // 3-5 concrete sections/additions to include

Rules:
- Every gap's "evidence" must be traceable to the data provided (do not invent competitor coverage).
- Prefer gaps the user's own topics position them to win.
- 4-7 gaps maximum.`;

export function gapReport(project: ContentProject, gap: GapReport | null, brand?: BrandProfile): Report {
  const blocks = [];
  if (!gap) {
    return { tag: 'Content Gap', title: `Content gaps — ${project.keyword}`, blocks: [b.note('Could not compute the gap analysis. Retry, or check the LLM configuration.')] };
  }

  blocks.push(b.p(`Content gaps for "${project.keyword}" — openings where the current top results are weak or your site is uniquely positioned.`));
  if (gap.differentiationAngle) blocks.push(b.note(`Differentiation angle: ${gap.differentiationAngle}`));

  if (gap.gaps?.length) {
    blocks.push(b.list(gap.gaps.map((g) => `${g.topic} — Why: ${g.whyItMatters}. Evidence: ${g.evidence}`)));
  }
  if (gap.underservedQuestions?.length) {
    blocks.push(b.p('Under-served reader questions:'));
    blocks.push(b.list(gap.underservedQuestions.slice(0, 8)));
  }
  if (gap.quickWins?.length) {
    blocks.push(b.p('Quick wins to include:'));
    blocks.push(b.chips(gap.quickWins));
  }
  if (!brand?.topicsCovered?.length && project.siteUrl) {
    blocks.push(b.note('Tip: I compared against competitors only. Run "brand voice" so I can weigh your own site\'s expertise into the gaps.'));
  }
  blocks.push(b.chips(['Write draft', 'Expand keywords']));

  return { tag: 'Content Gap', title: `Content gaps — ${project.keyword}`, blocks, data: { key: project.key, keyword: project.keyword } };
}
