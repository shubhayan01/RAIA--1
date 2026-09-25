import { serp } from '../sources/serp';
import { completeJSON, llmConfigured } from '../llm';
import { Report, b } from '../lib/report';
import { ContentProject, loadProject, saveProject } from '../lib/project';
import { ensureProject } from '../lib/project';
import { extractBrandProfile, BrandProfile } from './brand';

/**
 * Similar-keyword expansion + blog clustering (SCRIBE Feature 4).
 *
 * Seeds come from REAL search data — the SERP's related searches and
 * People-Also-Ask questions for the keyword (and a few autocomplete-style
 * variants). The LLM then GROUPS those real seed terms into topic clusters and
 * maps each cluster to a blog title, weighted toward the user's site focus. It
 * clusters real seeds; it does not fabricate search terms as if they were
 * measured volumes.
 */

export interface KeywordCluster {
  clusterName: string;
  intent: 'informational' | 'commercial' | 'transactional' | 'navigational' | string;
  keywords: string[];
  suggestedBlogTitle: string;
  fitForYourSite: string;   // why this fits (or doesn't) the user's site
}

export interface KeywordExpansion {
  seedKeyword: string;
  seeds: string[];          // the real related/PAA terms we clustered
  clusters: KeywordCluster[];
  generatedAt: string;
}

export async function runKeywordExpansion(keyword: string, opts: { siteUrl?: string; extraInfo?: string } = {}): Promise<Report> {
  const kw = keyword.trim();
  if (!kw) return { tag: 'Keywords', title: 'No keyword', blocks: [b.note('Give me a seed keyword, e.g. "expand keywords for running shoes".')] };

  const project = await ensureProject(kw, opts.siteUrl, opts.extraInfo);

  // Gather real seed terms from search.
  const seeds = await gatherSeeds(kw, project);
  if (!seeds.length) {
    return { tag: 'Keywords', title: `Keyword clusters — ${kw}`, blocks: [b.note('The search source returned no related terms to cluster. Set TAVILY_API_KEY or SERP_PROVIDER=google, then retry.')] };
  }
  if (!llmConfigured()) {
    const blocks = [b.p(`Real related terms for "${kw}" (from live search). Add an LLM key to cluster these into blog topics.`), b.chips(seeds.slice(0, 24))];
    return { tag: 'Keywords', title: `Related terms — ${kw}`, blocks };
  }

  const siteUrl = opts.siteUrl || project.siteUrl;
  let brand = project.brand as BrandProfile | undefined;
  if (!brand && siteUrl) { brand = await extractBrandProfile(siteUrl).catch(() => undefined); if (brand) { project.brand = brand; } }

  const clusters = await clusterSeeds(kw, seeds, brand);
  const expansion: KeywordExpansion = { seedKeyword: kw, seeds, clusters: clusters?.clusters || [], generatedAt: new Date().toISOString() };
  project.keywords = expansion;
  await saveProject(project);

  return keywordReport(project, expansion);
}

async function gatherSeeds(keyword: string, project: ContentProject): Promise<string[]> {
  const set = new Set<string>();
  // Reuse research seeds if already gathered.
  for (const s of project.research?.relatedSearches || []) set.add(s);
  for (const q of project.research?.peopleAlsoAsk || []) set.add(q);
  // Always pull a fresh SERP for related/PAA to widen the pool.
  try {
    const resp = await serp(keyword, 10);
    for (const s of resp.relatedSearches || []) set.add(s);
    for (const q of resp.paa || []) set.add(q);
  } catch { /* ignore */ }
  return [...set].map((s) => s.trim()).filter(Boolean).slice(0, 40);
}

const CLUSTER_SYSTEM = `You are an SEO content architect. You receive a seed keyword, a list of REAL related search terms and People-Also-Ask questions, and (optionally) the topics the user's own site covers.

Group the related terms into topic clusters, each mappable to one blog post. Weight the clusters toward the user's site focus when provided.

Return ONLY minified JSON:
{"clusters": [{
  "clusterName": string,
  "intent": "informational|commercial|transactional|navigational",
  "keywords": string[],            // terms from the provided list that belong here
  "suggestedBlogTitle": string,
  "fitForYourSite": string         // one line: why this fits the user's site (or "broad audience" if no site given)
}]}

Rules:
- Only cluster terms from the provided list; you may lightly normalise phrasing but do not invent new search terms.
- 3-7 clusters. Order by relevance to the user's site.
- Do not attach fake search-volume numbers — you were not given any.`;

async function clusterSeeds(keyword: string, seeds: string[], brand?: BrandProfile): Promise<{ clusters: KeywordCluster[] } | null> {
  try {
    return await completeJSON<{ clusters: KeywordCluster[] }>(CLUSTER_SYSTEM, JSON.stringify({
      seedKeyword: keyword,
      relatedTerms: seeds,
      yourSiteTopics: brand?.topicsCovered || [],
    }), { temperature: 0.4, maxTokens: 1800 });
  } catch { return null; }
}

export function keywordReport(project: ContentProject, expansion: KeywordExpansion): Report {
  const blocks = [];
  blocks.push(b.p(`Keyword clusters for "${expansion.seedKeyword}", built from ${expansion.seeds.length} real related terms and ordered by fit to your site.`));

  if (!expansion.clusters.length) {
    blocks.push(b.p('Related terms found (uncluster­ed):'));
    blocks.push(b.chips(expansion.seeds.slice(0, 24)));
    return { tag: 'Keywords', title: `Keyword clusters — ${expansion.seedKeyword}`, blocks };
  }

  expansion.clusters.forEach((c, i) => {
    blocks.push(b.p(`Cluster ${i + 1}: ${c.clusterName} · ${c.intent}`));
    blocks.push(b.kv([
      { k: 'Blog title', v: c.suggestedBlogTitle },
      { k: 'Fit', v: c.fitForYourSite },
    ]));
    blocks.push(b.chips(c.keywords.slice(0, 12)));
  });
  blocks.push(b.chips(['Write draft', 'Research a cluster keyword']));

  return { tag: 'Keywords', title: `Keyword clusters — ${expansion.seedKeyword}`, blocks, data: { key: project.key, keyword: project.keyword } };
}
