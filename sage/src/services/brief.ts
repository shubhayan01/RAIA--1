import { serp, serpEnabled, serpErrorNote } from '../sources/serp';
import { requestOnce } from '../lib/http';
import { extractOutline } from '../lib/html';
import { questionKeywords } from '../sources/autocomplete';
import { pool } from '../lib/concurrency';
import { completeJSON, llmConfigured } from '../llm';
import { Report, b } from '../lib/report';

export interface BriefData {
  primaryKeyword: string;
  intent: string;
  secondaryIntent: string;
  targetReader: string;
  wordCount: number;
  competitorAvgWordCount: number;
  contentFormat: string;
  formatJustification: string;
  intentAnalysis: { commonalities: string; requirements: string; gap: string };
  titleOptions: string[];
  titleRecommended: string;
  titleReason: string;
  metaOptions: string[];
  h1Options: string[];
  structure: { h2: string; purpose: string; mustCover: string[]; competitorGap: string; format: string; wordCount: number; h3: string[] }[];
  faq: { q: string; answerFramework: string }[];
  entities: string[];
  lsiTerms: string[];
  termsToAvoid: string[];
  internalLinks: string[];
  schema: string[];
  eeat: string[];
  cta: string;
  competitors: { url: string; title: string; wordCount: number; headings: string[] }[];
  questions: string[];
  // FIX 4 — rewrite mode: set when the brief targets an existing client page.
  existingPageUrl?: string;
  rewriteAnalysis?: { keep: string[]; cut: string[]; add: string[]; restructure: string[]; summary: string };
}

/**
 * Content Brief:
 *  keyword -> SERP -> top competitors -> analyze content -> common topics
 *  -> missing topics -> intent -> structure -> brief -> (human approval) -> writer
 */
export async function runBrief(input: { primaryKeyword: string; existingPageUrl?: string }): Promise<Report> {
  const kw = input.primaryKeyword.trim();
  const existingPageUrl = (input.existingPageUrl || '').trim();
  if (!kw) throw new Error('Provide a primary keyword.');
  if (!llmConfigured()) return { tag: 'Content Brief', title: 'LLM not configured', blocks: [b.note('Add an LLM key to .env to enable briefs.')] };
  if (!serpEnabled()) return { tag: 'Content Brief', title: 'SERP disabled', blocks: [b.note('Set SERP_PROVIDER=scrape (free) or a paid provider to build briefs.')] };

  // SERP → competitor URLs
  const s = await serp(kw, 8);
  const serpErr = serpErrorNote(s);
  if (serpErr) {
    return {
      tag: 'Content Brief', title: `Brief: ${kw}`,
      blocks: [
        b.p(`I couldn't fetch the live SERP for “${kw}”, so I won't guess at a brief — a real brief must be built from the pages actually ranking.`),
        b.note(serpErr),
      ],
    };
  }
  const topUrls = s.results.slice(0, 6);

  // fetch + extract outlines
  const outlines = await pool(topUrls, 4, async (r) => {
    const res = await requestOnce(r.url);
    if (!res.body) return null;
    const o = extractOutline(res.body);
    return { url: r.url, title: o.title || r.title, wordCount: o.wordCount, headings: [...o.h1, ...o.h2, ...o.h3].slice(0, 40) };
  });
  const competitors = outlines.filter(Boolean) as BriefData['competitors'];

  const questions = await questionKeywords(kw);

  // FIX 4 — rewrite mode: fetch + extract the existing client page's own outline
  // so the LLM can compare it against the competitor structure and produce a
  // rewrite brief (keep / cut / add / restructure) instead of a new-page brief.
  let existingPage: { url: string; title: string; wordCount: number; headings: string[] } | null = null;
  if (existingPageUrl) {
    try {
      const res = await requestOnce(existingPageUrl);
      if (res.body) {
        const o = extractOutline(res.body);
        existingPage = {
          url: existingPageUrl,
          title: o.title || '',
          wordCount: o.wordCount,
          headings: [...o.h1, ...o.h2, ...o.h3].slice(0, 40),
        };
      }
    } catch { /* fetch failed — fall back to a new-page brief below */ }
  }

  const competitorAvg = competitors.length
    ? Math.round(competitors.reduce((s2, c) => s2 + c.wordCount, 0) / competitors.length)
    : 0;

  const rewriteMode = !!existingPage;

  // LLM synthesizes the brief from real competitor structure
  const system = `You are a senior content strategist at a top SEO agency writing a ${rewriteMode ? 'REWRITE brief for an EXISTING client page so it can climb into the top 3' : 'content brief that a writer will use to produce a page that ranks in the top 3'} for its target keyword. The brief must be specific enough that the writer needs zero additional research.

You will receive the target keyword, top-ranking competitor outlines, question data from Google, and SERP intent signals${rewriteMode ? ", plus the CURRENT outline of the existing client page being rewritten (its title, word count and headings)" : ''}. Produce this structure:
${rewriteMode ? `
REWRITE ANALYSIS (do this FIRST — this is a rewrite, not a new page)
You are given the existing page's own outline under "existingPage". Compare it directly against the competitor outlines and the intent for this keyword, then state:
- KEEP: existing sections/headings that already work and should stay (name them from the existing outline)
- CUT: existing sections that are off-intent, thin, redundant or hurting the page (name them)
- ADD: sections the competitors cover that the existing page is missing (name them)
- RESTRUCTURE: sections that exist but need reordering, merging, splitting or reframing (name the existing heading and the change)
Frame the entire brief that follows as a rewrite of this specific URL — the FULL CONTENT STRUCTURE below is the TARGET outline the rewritten page should end up with, and it must reconcile with your KEEP/CUT/ADD/RESTRUCTURE calls.
` : ''}

BRIEF HEADER
Target keyword: [keyword]
Primary intent: [Informational / Commercial / Transactional / Navigational]
Secondary intent signals: [what else the searcher likely wants]
Target reader: [specific description — not "someone interested in X" but "a marketing manager at a mid-size e-commerce brand evaluating..."]
Target word count: [specific number based on competitor average, rounded to nearest 100. State the competitor average you used.]
Content format: [Article / Guide / Landing Page / Comparison / Listicle / Tool Page — with one sentence justification]

SEARCH INTENT ANALYSIS
What the top-ranking pages have in common: structure, angle, content depth, format choices. What a page needs to match searcher intent for this keyword. What the current results are NOT covering well (the gap this page should exploit).

RECOMMENDED TITLE TAG
Format: [Primary Keyword] — [Compelling angle] | [Brand]
Under 60 characters. Write 3 options and recommend one with a reason.

RECOMMENDED META DESCRIPTION
Under 155 characters. Include the primary keyword, a benefit, and a soft CTA. Write 2 options.

RECOMMENDED H1
Different from the title tag. Conversational, benefit-led. Write 2 options.

FULL CONTENT STRUCTURE
For each section:
H2: [exact recommended heading text]
Purpose: [what this section must accomplish for the reader]
Must cover: [specific points, questions, or data this section needs]
Competitor gap: [what the top results miss that this section should add]
Suggested format: [prose / bullet list / table / numbered steps / FAQ]
Approx word count: [specific number]
Repeat for every H2. Include H3s where the data shows competitors use them for sub-topics.

FAQ SECTION
10 questions from Google autocomplete and PAA data provided.
For each: the exact question as an H3, a 2-3 sentence answer framework (not the full answer — the writer fills this in).

ENTITIES & SEMANTICS
Key entities to include: [people, places, tools, brands, concepts that top-ranking pages reference — from the data provided]
LSI terms to use naturally: [related terms from the keyword data]
Terms to avoid: [overused phrases in the current top results that signal thin content]

INTERNAL LINKING
3-5 suggested internal link opportunities based on the content structure. Format: "In the [section name] section, link to [page type] using anchor text '[suggested anchor]'"

SCHEMA MARKUP
Recommended schema type with one-line justification.

E-E-A-T SIGNALS
3 specific ways to demonstrate Experience, Expertise, Authority, and Trust for this topic — original data, expert quotes, case study hooks, credentials to surface.

CTA RECOMMENDATION
What action should the reader take after reading this page. Match the intent — informational pages need soft CTAs, transactional pages need hard CTAs.

Rules you must never break:
- Every heading recommendation must be specific — no [add heading here] placeholders
- Word counts must be based on the competitor data provided, not generic guidance
- Never invent competitor content not in the outlines passed to you
- The writer should be able to start writing immediately after reading this brief with zero additional questions

OUTPUT FORMAT — return ONLY minified JSON with exactly these keys:
{"intent": string, "secondaryIntent": string, "targetReader": string,
 "wordCount": number (rounded to nearest 100), "contentFormat": string, "formatJustification": string,
 "intentAnalysis": {"commonalities": string, "requirements": string, "gap": string},
 "titleOptions": [string, string, string], "titleRecommended": string, "titleReason": string,
 "metaOptions": [string, string], "h1Options": [string, string],
 "structure": [{"h2": string, "purpose": string, "mustCover": string[], "competitorGap": string, "format": string, "wordCount": number, "h3": string[]}],
 "faq": [{"q": string, "answerFramework": string}] (up to 10),
 "entities": string[], "lsiTerms": string[], "termsToAvoid": string[],
 "internalLinks": string[], "schema": string[], "eeat": [string, string, string], "cta": string${rewriteMode ? `,
 "rewriteAnalysis": {"keep": string[], "cut": string[], "add": string[], "restructure": string[], "summary": string (one paragraph: what this rewrite changes overall and why it will outrank the current version)}` : ''}}
The competitor average word count provided is ${competitorAvg}; base your target word count on it and state it in formatJustification.`;
  const user = JSON.stringify({
    primaryKeyword: kw,
    competitorAvgWordCount: competitorAvg,
    autocompleteQuestions: questions.slice(0, 25),
    peopleAlsoAsk: (s.paa || []).slice(0, 12),
    relatedSearches: (s.relatedSearches || []).slice(0, 12),
    rankingCompetitors: competitors.map((c) => ({
      url: c.url,
      title: c.title,
      wordCount: c.wordCount,
      headings: c.headings.slice(0, 30),
    })),
    ...(existingPage ? {
      existingPage: {
        url: existingPage.url,
        title: existingPage.title,
        wordCount: existingPage.wordCount,
        headings: existingPage.headings,
      },
    } : {}),
  });

  const p = await completeJSON<any>(system, user, { temperature: 0.35, maxTokens: 8000 });

  const data: BriefData = {
    primaryKeyword: kw,
    intent: String(p.intent || 'informational'),
    secondaryIntent: String(p.secondaryIntent || ''),
    targetReader: String(p.targetReader || ''),
    wordCount: Number(p.wordCount) || competitorAvg || 1500,
    competitorAvgWordCount: competitorAvg,
    contentFormat: String(p.contentFormat || 'Article'),
    formatJustification: String(p.formatJustification || ''),
    intentAnalysis: {
      commonalities: String(p.intentAnalysis?.commonalities || ''),
      requirements: String(p.intentAnalysis?.requirements || ''),
      gap: String(p.intentAnalysis?.gap || ''),
    },
    titleOptions: arr(p.titleOptions),
    titleRecommended: String(p.titleRecommended || ''),
    titleReason: String(p.titleReason || ''),
    metaOptions: arr(p.metaOptions),
    h1Options: arr(p.h1Options),
    structure: Array.isArray(p.structure)
      ? p.structure.map((x: any) => ({
          h2: String(x.h2 || ''),
          purpose: String(x.purpose || ''),
          mustCover: arr(x.mustCover),
          competitorGap: String(x.competitorGap || ''),
          format: String(x.format || ''),
          wordCount: Number(x.wordCount) || 0,
          h3: arr(x.h3),
        })).filter((x: any) => x.h2)
      : [],
    faq: Array.isArray(p.faq)
      ? p.faq.map((x: any) => ({ q: String(x.q || ''), answerFramework: String(x.answerFramework || '') })).filter((x: any) => x.q).slice(0, 10)
      : [],
    entities: arr(p.entities),
    lsiTerms: arr(p.lsiTerms),
    termsToAvoid: arr(p.termsToAvoid),
    internalLinks: arr(p.internalLinks),
    schema: arr(p.schema),
    eeat: arr(p.eeat),
    cta: String(p.cta || ''),
    competitors,
    questions,
    ...(existingPage ? { existingPageUrl: existingPage.url } : {}),
    ...(rewriteMode && p.rewriteAnalysis ? {
      rewriteAnalysis: {
        keep: arr(p.rewriteAnalysis.keep),
        cut: arr(p.rewriteAnalysis.cut),
        add: arr(p.rewriteAnalysis.add),
        restructure: arr(p.rewriteAnalysis.restructure),
        summary: String(p.rewriteAnalysis.summary || ''),
      },
    } : {}),
  };

  return toReport(data);
}

function toReport(d: BriefData): Report {
  const blocks = [];

  // ---- Brief header ----
  blocks.push(b.kv([
    { k: 'Target keyword', v: d.primaryKeyword },
    { k: 'Primary intent', v: d.intent },
    ...(d.secondaryIntent ? [{ k: 'Secondary intent', v: d.secondaryIntent }] : []),
    { k: 'Target reader', v: d.targetReader || '—' },
    { k: 'Target word count', v: `~${d.wordCount}${d.competitorAvgWordCount ? ` (competitor avg ${d.competitorAvgWordCount})` : ''}` },
    { k: 'Content format', v: d.contentFormat + (d.formatJustification ? ` — ${d.formatJustification}` : '') },
  ]));
  blocks.push(b.p(`Built from ${d.competitors.length} ranking competitor page${d.competitors.length === 1 ? '' : 's'} actually in the top results today.`));

  // ---- Rewrite analysis (only when an existing page was supplied) ----
  if (d.existingPageUrl) {
    blocks.push(b.note(`Rewrite brief for existing page: ${d.existingPageUrl}`));
  }
  if (d.rewriteAnalysis) {
    const ra = d.rewriteAnalysis;
    blocks.push(b.p('Rewrite analysis — existing page vs. the target outline:'));
    if (ra.keep.length) { blocks.push(b.p('Keep:')); blocks.push(b.list(ra.keep.slice(0, 12))); }
    if (ra.cut.length) { blocks.push(b.p('Cut:')); blocks.push(b.list(ra.cut.slice(0, 12))); }
    if (ra.add.length) { blocks.push(b.p('Add:')); blocks.push(b.list(ra.add.slice(0, 12))); }
    if (ra.restructure.length) { blocks.push(b.p('Restructure:')); blocks.push(b.list(ra.restructure.slice(0, 12))); }
    if (ra.summary) blocks.push(b.p(ra.summary));
  }

  // ---- Search intent analysis ----
  if (d.intentAnalysis.commonalities || d.intentAnalysis.requirements || d.intentAnalysis.gap) {
    blocks.push(b.p('Search intent analysis:'));
    const ia: string[] = [];
    if (d.intentAnalysis.commonalities) ia.push(`What top pages share: ${d.intentAnalysis.commonalities}`);
    if (d.intentAnalysis.requirements) ia.push(`What this page must do: ${d.intentAnalysis.requirements}`);
    if (d.intentAnalysis.gap) ia.push(`The gap to exploit: ${d.intentAnalysis.gap}`);
    blocks.push(b.list(ia));
  }

  // ---- Title / meta / H1 ----
  if (d.titleOptions.length) {
    blocks.push(b.p('Title tag options (under 60 chars):'));
    blocks.push(b.list(d.titleOptions.slice(0, 3)));
    if (d.titleRecommended) blocks.push(b.note(`Recommended: “${d.titleRecommended}”${d.titleReason ? ` — ${d.titleReason}` : ''}`));
  }
  if (d.metaOptions.length) {
    blocks.push(b.p('Meta description options (under 155 chars):'));
    blocks.push(b.list(d.metaOptions.slice(0, 2)));
  }
  if (d.h1Options.length) {
    blocks.push(b.p('H1 options (distinct from the title):'));
    blocks.push(b.list(d.h1Options.slice(0, 2)));
  }

  // ---- Full content structure ----
  if (d.structure.length) {
    blocks.push(b.p('Full content structure — write to this outline:'));
    for (const s of d.structure.slice(0, 12)) {
      blocks.push(b.p(`H2 — ${s.h2}${s.wordCount ? `  (~${s.wordCount} words)` : ''}`));
      const detail: string[] = [];
      if (s.purpose) detail.push(`Purpose: ${s.purpose}`);
      if (s.mustCover.length) detail.push(`Must cover: ${s.mustCover.join('; ')}`);
      if (s.competitorGap) detail.push(`Competitor gap: ${s.competitorGap}`);
      if (s.format) detail.push(`Format: ${s.format}`);
      for (const h3 of (s.h3 || []).slice(0, 6)) detail.push(`H3 — ${h3}`);
      if (detail.length) blocks.push(b.list(detail));
    }
  }

  // ---- FAQ ----
  if (d.faq.length) {
    blocks.push(b.p('FAQ section (H3 questions + answer frameworks for the writer):'));
    blocks.push(b.list(d.faq.slice(0, 10).map((f) => `${f.q}${f.answerFramework ? ` — ${f.answerFramework}` : ''}`)));
  }

  // ---- Entities & semantics ----
  if (d.entities.length) {
    blocks.push(b.p('Key entities to include:'));
    blocks.push(b.chips(d.entities.slice(0, 20)));
  }
  if (d.lsiTerms.length) {
    blocks.push(b.p('LSI / related terms to use naturally:'));
    blocks.push(b.chips(d.lsiTerms.slice(0, 20)));
  }
  if (d.termsToAvoid.length) {
    blocks.push(b.p('Overused phrases to avoid (signal thin content):'));
    blocks.push(b.chips(d.termsToAvoid.slice(0, 15)));
  }

  // ---- Internal links / schema / E-E-A-T / CTA ----
  if (d.internalLinks.length) {
    blocks.push(b.p('Internal linking:'));
    blocks.push(b.list(d.internalLinks.slice(0, 5)));
  }
  if (d.eeat.length) {
    blocks.push(b.p('E-E-A-T signals to build in:'));
    blocks.push(b.list(d.eeat.slice(0, 3)));
  }
  const meta: string[] = [];
  if (d.schema.length) meta.push(`Schema: ${d.schema.join(', ')}`);
  if (d.cta) meta.push(`CTA: ${d.cta}`);
  if (meta.length) blocks.push(b.note(meta.join('  •  ')));

  blocks.push(b.note('Awaiting human approval → hand to writer.'));

  const title = d.existingPageUrl ? `Rewrite brief: ${d.primaryKeyword}` : `Brief: ${d.primaryKeyword}`;
  return { tag: 'Content Brief', title, blocks, data: d };
}

const arr = (x: any): string[] => (Array.isArray(x) ? x.map((s) => String(s)).filter(Boolean) : []);
