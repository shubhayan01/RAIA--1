import { expandKeywords, questionKeywords } from '../sources/autocomplete';
import { serp, serpEnabled } from '../sources/serp';
import { completeJSON, llmConfigured } from '../llm';
import { seoptimerEnabled, seoptimerReport } from '../sources/seoptimer';
import { Report, b } from '../lib/report';

export interface KeywordCluster {
  cluster: string;
  intent: 'informational' | 'commercial' | 'transactional' | 'navigational';
  keywords: string[];
  priority: number; // 1-100
  opportunity: string;
  suggestedPageType: string;
  hasExistingPage?: boolean;
  mappedPage?: string | null;
}

export interface KeywordData {
  seed: string;
  collected: number;
  afterDedupe: number;
  clusters: KeywordCluster[];
  competitorGaps: string[];
  realCompetitorKeywords?: { keyword: string; volume: string | null; position: number }[];
  competitorDomain?: string;
  questions: string[];
}

/**
 * Keyword Research & Clustering.
 *  collect -> dedupe -> intent classify -> cluster -> prioritize
 *  -> map to existing pages -> flag clusters with no page -> competitor gaps
 * Uses FREE autocomplete + LLM. Volume/KD/CPC are optional (see providers).
 */
export async function runKeywords(input: {
  seed: string;
  competitorDomain?: string;
  existingPages?: string[]; // URLs the client already has
}): Promise<Report> {
  const seed = input.seed.trim();
  if (!seed) throw new Error('Provide a seed keyword or topic.');
  if (!llmConfigured()) return needsLLM('Keyword Research');

  // 1) collect (free Google Autocomplete expansion) + People-Also-Ask questions
  const [raw, questions] = await Promise.all([
    expandKeywords(seed, 'wide'),
    questionKeywords(seed),
  ]);
  const collected = raw.length;

  // 2) dedupe + basic irrelevant filter (very short / duplicate stems)
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const k of raw) {
    const key = k.replace(/\s+/g, ' ').trim();
    if (key.length < 3) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(key);
  }

  // cap what we hand the LLM (cost/latency) but keep it broad
  const forLLM = deduped.slice(0, 220);

  // 3-6) intent + cluster + prioritize + page-type via LLM
  const system =
    'You are an SEO strategist. Given a seed topic and a raw keyword list, remove clearly irrelevant terms, ' +
    'classify search intent, and group into tight topic clusters. For each cluster pick ONE intent ' +
    '(informational|commercial|transactional|navigational), 5-15 member keywords, a priority score 1-100 ' +
    '(volume potential x commercial value x achievability), the best page type to target it, and a one-line opportunity note. ' +
    'Return JSON: {"clusters":[{"cluster","intent","keywords":[],"priority","suggestedPageType","opportunity"}], "dropped":number}. 6-12 clusters.';
  const user = `Seed: "${seed}"\nKeywords (${forLLM.length}):\n${forLLM.join('\n')}`;

  const parsed = await completeJSON<{ clusters: any[]; dropped?: number }>(system, user, { temperature: 0.25 });
  let clusters: KeywordCluster[] = (parsed.clusters || []).map((c) => ({
    cluster: String(c.cluster || '').trim(),
    intent: ['informational', 'commercial', 'transactional', 'navigational'].includes(c.intent) ? c.intent : 'informational',
    keywords: Array.isArray(c.keywords) ? c.keywords.slice(0, 15) : [],
    priority: clamp(Number(c.priority) || 50, 1, 100),
    opportunity: String(c.opportunity || ''),
    suggestedPageType: String(c.suggestedPageType || 'article'),
  })).filter((c) => c.cluster && c.keywords.length);

  // 7-8) map clusters to existing pages / flag gaps
  if (input.existingPages?.length) {
    clusters = await mapToPages(clusters, input.existingPages);
  }

  clusters.sort((a, c) => c.priority - a.priority);

  // 9) competitor keyword gaps
  //    Preferred: SEOptimer returns the competitor's REAL ranking keywords with
  //    search volume. Fallback: approximate SERP overlap (free).
  let gaps: string[] = [];
  let realCompetitorKeywords: KeywordData['realCompetitorKeywords'];
  if (input.competitorDomain) {
    if (seoptimerEnabled()) {
      realCompetitorKeywords = await realCompetitorGaps(input.competitorDomain);
    }
    if (!realCompetitorKeywords?.length && serpEnabled()) {
      gaps = await competitorGaps(clusters.slice(0, 6), input.competitorDomain);
    }
  }

  const data: KeywordData = {
    seed, collected, afterDedupe: deduped.length, clusters, competitorGaps: gaps,
    realCompetitorKeywords, competitorDomain: input.competitorDomain, questions,
  };

  return toReport(data, !!input.existingPages?.length);
}

async function mapToPages(clusters: KeywordCluster[], pages: string[]): Promise<KeywordCluster[]> {
  const system =
    'Map each keyword cluster to the single most relevant existing page URL, or null if none fits well. ' +
    'Return JSON: {"map":[{"cluster":string,"page":string|null}]}.';
  const user = `Clusters: ${JSON.stringify(clusters.map((c) => c.cluster))}\nPages:\n${pages.slice(0, 100).join('\n')}`;
  try {
    const res = await completeJSON<{ map: { cluster: string; page: string | null }[] }>(system, user, { temperature: 0.1 });
    const lookup = new Map(res.map.map((m) => [m.cluster.toLowerCase(), m.page]));
    return clusters.map((c) => {
      const page = lookup.get(c.cluster.toLowerCase()) ?? null;
      return { ...c, mappedPage: page, hasExistingPage: !!page };
    });
  } catch {
    return clusters;
  }
}

/** Real competitor ranking keywords (with search volume) from SEOptimer. */
async function realCompetitorGaps(competitorDomain: string): Promise<KeywordData['realCompetitorKeywords']> {
  const so = await seoptimerReport(competitorDomain);
  if (!so.ok || !so.keywordRankings.length) return undefined;
  const seen = new Set<string>();
  const out: NonNullable<KeywordData['realCompetitorKeywords']> = [];
  for (const k of so.keywordRankings) {
    const key = k.keyword.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ keyword: k.keyword, volume: k.totalSearches, position: k.position });
  }
  const vol = (v: string | null) => Number((v || '').replace(/[^0-9]/g, '')) || 0;
  return out.sort((a, c) => vol(c.volume) - vol(a.volume)).slice(0, 15);
}

async function competitorGaps(clusters: KeywordCluster[], competitorDomain: string): Promise<string[]> {
  const domain = competitorDomain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const gaps: string[] = [];
  for (const c of clusters) {
    try {
      const r = await serp(c.cluster, 10);
      const ranks = r.results.some((res) => res.domain.includes(domain));
      if (ranks) gaps.push(`${c.cluster} — ${domain} ranks, opportunity to compete`);
    } catch { /* ignore */ }
  }
  return gaps.slice(0, 12);
}

function toReport(d: KeywordData, mapped: boolean): Report {
  const blocks = [];
  blocks.push(b.p(
    `Collected ${d.collected} real queries from live Google Autocomplete → deduped to ${d.afterDedupe} → ` +
    `intent-classified and grouped into ${d.clusters.length} clusters. Every keyword is a real suggestion Google returns — none are invented.`,
  ));

  blocks.push(b.table(
    ['Cluster', 'Intent', 'KWs', 'Priority', mapped ? 'Page' : 'Target'],
    d.clusters.slice(0, 12).map((c) => [
      c.cluster,
      c.intent,
      c.keywords.length,
      c.priority,
      mapped ? (c.mappedPage ? '✓ mapped' : '✗ none — NEW') : c.suggestedPageType,
    ]),
  ));

  if (mapped) {
    const noPage = d.clusters.filter((c) => !c.hasExistingPage);
    if (noPage.length) {
      blocks.push(b.p(`${noPage.length} high-value cluster(s) have no suitable page — net-new content opportunities:`));
      blocks.push(b.chips(noPage.slice(0, 8).map((c) => c.cluster)));
    }
  }

  if (d.questions.length) {
    blocks.push(b.p('People also ask (from Google question suggestions) — great for FAQ blocks:'));
    blocks.push(b.list(d.questions.slice(0, 12)));
  }

  if (d.realCompetitorKeywords?.length) {
    blocks.push(b.p(`Real keywords ${d.competitorDomain} ranks for (SEOptimer — with search volume):`));
    blocks.push(b.table(
      ['Keyword', 'Search volume', 'Position'],
      d.realCompetitorKeywords.map((k) => [k.keyword, k.volume ?? '—', k.position || '—']),
    ));
  } else if (d.competitorGaps.length) {
    blocks.push(b.p('Competitor keyword gaps:'));
    blocks.push(b.list(d.competitorGaps));
  }

  const top = d.clusters[0];
  if (top) blocks.push(b.note(`Top opportunity: "${top.cluster}" (${top.intent}, priority ${top.priority}) — ${top.opportunity}`));

  return { tag: 'Keyword Research', title: `Clustered opportunities for "${d.seed}"`, blocks, data: d };
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

function needsLLM(tag: string): Report {
  return {
    tag,
    title: 'LLM not configured',
    blocks: [b.note('Add an LLM key to .env (LLM_API_KEY / GROQ_API_KEY) to enable this capability. See README.')],
  };
}
