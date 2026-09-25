import { complete, completeJSON, llmConfigured, llmInfo } from '../llm';
import { config } from '../config';
import { Report, b } from '../lib/report';
import { ContentProject, loadProject, ensureProject, saveProject, advanceStatus } from '../lib/project';
import { gatherResearch, targetWordCount } from './research';
import { BrandProfile, extractBrandProfile } from './brand';
import { GapReport } from './gap';
import { CompetitorSynthesis, synthesize } from './competitors';
import { compactCatalog, paramsById, PARAM_RULES, EeatParam } from '../lib/eeatParams';
import { collectEvidence, evidenceIndex, evidenceReport, EvidencePack } from './evidence';
import { publishGate, unverifiedAgainstPack } from './gate';

/**
 * Content generation (SCRIBE Feature 5 — the writer).
 *
 * Two passes, the way an experienced writer works:
 *   1. PLAN — an outline (title, meta, slug, sections with per-section word
 *      budgets, FAQ) grounded in the real research, gaps and PAA.
 *   2. DRAFT — the full article written from that plan to a REALISTIC target,
 *      as plain markdown (no JSON wrapping the body, so nothing truncates).
 *
 * The LLM writes — a legitimate task — but works entirely from the real research
 * and is HARD-forbidden from inventing statistics, benchmarks or case studies.
 * The word target is the robust competitor median (outliers dropped), clamped to
 * a length one dense article can genuinely fill — never an unreachable number.
 */

export interface ContentDraft {
  title: string;
  metaDescription: string;
  slug: string;
  wordTarget: number;
  competitorMedian: number | null;
  outline: string[];
  markdown: string;
  wordCount: number;
  appliedParams: string[];      // E-E-A-T parameter ids applied to this piece
  skippedParams: { id: string; reason: string }[];
  evidenceStatus?: string;      // EvidencePack status the draft was written under
  evidenceMode?: string;        // 'sourced' | 'number-light' — how it was grounded
  digestUsed?: number;          // count of source-digest insights available to the writer
  evidenceIdsUsed?: string[];   // [E#] ids the writer cited (tags stripped from markdown)
  generatedAt: string;
  model: string;
}

interface OutlinePlan {
  title: string;
  metaDescription: string;
  slug: string;
  sections: { heading: string; keyPoints: string[]; words: number }[];
  faq: string[];
  appliedParams?: string[];
  skippedParams?: { id: string; reason: string }[];
}

export async function runWrite(keyword: string, opts: { siteUrl?: string; extraInfo?: string; gate?: boolean } = {}): Promise<Report> {
  const kw = keyword.trim();
  if (!kw) return { tag: 'Draft', title: 'No keyword', blocks: [b.note('Give me a keyword to write about, e.g. "write about best running shoes for flat feet".')] };
  if (!llmConfigured()) return { tag: 'Draft', title: 'LLM required', blocks: [b.note('Add an LLM key in .env — the draft is written by the model over the real research.')] };

  const project = await ensureProject(kw, opts.siteUrl, opts.extraInfo);

  if (!project.research?.topBlogs?.length) {
    project.research = await gatherResearch(kw);
    await saveProject(project);
  }

  // Evidence FIRST. The writer may only cite what evidence collection verified.
  // If a real search found fewer than the minimum statistics, HALT here with an
  // honest failure rather than let the model invent numbers to fill the gap.
  let pack = project.evidence as EvidencePack | undefined;
  if (!pack) { pack = await collectEvidence(project); project.evidence = pack; await saveProject(project); }
  if (pack.status === 'LOW_EVIDENCE') {
    const rep = evidenceReport(pack, project.key);
    rep.blocks.unshift(b.note('Writing halted: not enough verifiable evidence to write without fabricating. Resolve the evidence gap below, then write again.'));
    return { ...rep, tag: 'Draft', title: `Draft halted — ${kw} (LOW_EVIDENCE)` };
  }

  let brand = project.brand as BrandProfile | undefined;
  const siteUrl = opts.siteUrl || project.siteUrl;
  if (!brand && siteUrl) { brand = await extractBrandProfile(siteUrl).catch(() => undefined); if (brand) { project.brand = brand; await saveProject(project); } }
  let synth: CompetitorSynthesis | null = null;
  if (project.competitors?.length) synth = await synthesize(kw, project.competitors).catch(() => null);

  const draft = await generateDraft(project, brand, synth, pack);
  if (!draft) return { tag: 'Draft', title: 'Draft failed', blocks: [b.note('Could not generate the draft. Retry, or check the LLM configuration.')] };

  project.draft = draft;
  advanceStatus(project, 'drafted');
  await saveProject(project);

  // The publish gate runs BY DEFAULT, even on a bare "write" (the workflow passes
  // gate:false because it runs the gate itself as a later step). SCRIBE's small
  // model invents stats and quotes despite every instruction, so a deterministic,
  // evidence-anchored gate — not the prompt — is what actually guarantees no
  // fabricated number survives: it deletes any figure not present in the pack,
  // strips em dashes, and rewrites templated filler. Best-effort: a gate failure
  // never sinks a usable draft.
  // The LLM publish gate adds 2-3 model calls. In FAST mode we skip it for speed
  // (a bare fast run is then ~2 calls): the draft is number-light and the writer is
  // held to citing only pack stats, and sanitizeProse already stripped em dashes.
  // DEEP mode still runs the full gate. The workflow passes gate:false either way.
  // FAST mode: a deterministic, no-LLM safety net in place of the full gate — flag
  // any number in the draft that is NOT backed by the evidence pack, so a fabricated
  // figure is at least surfaced to the user (not silently shipped) without a slow
  // extra model call.
  if (config.content.researchMode !== 'deep') {
    const unbacked = unverifiedAgainstPack(draft.markdown, pack);
    if (unbacked.length) {
      const report0 = draftReport(project, draft);
      report0.blocks.push(b.note(`⚠️ Fast mode skips the LLM publish gate for speed. ${unbacked.length} figure(s) in this draft are not backed by the collected evidence — verify or delete them before publishing (or re-run in deep mode: SCRIBE_RESEARCH_MODE=deep). Flagged: ${unbacked.slice(0, 4).map((s) => `"${s.slice(0, 60)}"`).join('; ')}`));
      return report0;
    }
  }

  if (opts.gate !== false && config.content.researchMode === 'deep') {
    const gated = await publishGate({ draft: draft.markdown, pack }, {}, config.content.gateIterations).catch(() => null);
    if (gated) {
      // Re-run the deterministic sanitizer on the gate's output: its LLM fixer can
      // reintroduce em/en dashes while repairing other issues, so this guarantees
      // the final draft has none regardless of what the model did.
      draft.markdown = sanitizeProse(gated.draft);
      draft.wordCount = countWords(draft.markdown);
      const hh = extractHeadings(gated.draft);
      if (hh.h1) draft.title = hh.h1;
      if (hh.h2s.length) draft.outline = hh.h2s;
      project.draft = draft;
      project.gate = { status: gated.status, iterations: gated.iterations, history: gated.history, remainingViolations: gated.remainingViolations, warnings: gated.warnings, estimatedTokens: gated.estimatedTokens, ranAt: new Date().toISOString() };
      if (gated.status === 'READY') advanceStatus(project, 'reviewed');
      await saveProject(project);
    }
  }

  const report = draftReport(project, draft);
  const g = project.gate as { status?: string; remainingViolations?: { category: string; detail: string; evidence?: string }[] } | undefined;
  if (g?.status) {
    report.blocks.push(b.note(g.status === 'READY'
      ? '✅ Publish gate: READY — zero fabricated figures and zero unverified claims. The draft above is the gated, cleaned version.'
      : '⚠️ Publish gate: NEEDS_HUMAN — the items below could not be auto-fixed without judgement. Everything else was cleaned automatically.'));
    if (g.status !== 'READY' && g.remainingViolations?.length) {
      report.blocks.push(b.list(g.remainingViolations.slice(0, 8).map((v) => `${v.category}: ${v.detail}${v.evidence ? ` — "${String(v.evidence).slice(0, 100)}"` : ''}`)));
    }
    (report.data as any) = { ...(report.data as any), gateStatus: g.status };
  }

  return report;
}

/** Word count using the same rule everywhere (strip markdown punctuation). */
function countWords(md: string): number {
  return md.replace(/[#*_>`~\-|]/g, ' ').split(/\s+/).filter(Boolean).length;
}

/* --------------------------- shared grounding facts --------------------------- */

/**
 * A draft is only as concrete as its inputs. Asking a model for "concrete
 * examples" while handing it nothing real forces it to choose between sounding
 * specific and staying honest — and it will pick specific every time. So we parse
 * the brief into explicit slots (real client outcomes, a genuine opinion/
 * contrarian take, an internal tool/process) and tell the writer: anchor examples
 * to THESE, and if a slot is empty, OMIT that section — never invent to fill it.
 *
 * Slots can be labelled in the brief ("Outcome:", "Opinion:", "Process:") or, if
 * unlabelled, the whole brief is treated as available first-party material.
 */
export interface StructuredBrief {
  realOutcomes: string[];     // real (even directional) client results — no fake %
  opinion: string;            // a genuine POV / contrarian take the brand holds
  internalProcess: string;    // a real tool/method/process used internally
  otherFacts: string;         // remaining first-party facts (volumes, years, area, credentials)
  hasRealInputs: boolean;     // false → the writer must stay general and omit specifics
}

export function parseBrief(raw?: string): StructuredBrief {
  const text = (raw || '').trim();
  const empty: StructuredBrief = { realOutcomes: [], opinion: '', internalProcess: '', otherFacts: '', hasRealInputs: false };
  if (!text) return empty;

  const grab = (labels: string[]): string => {
    for (const l of labels) {
      const re = new RegExp(`(?:^|\\n)\\s*(?:${l})\\s*[:\\-]\\s*(.+?)(?=\\n\\s*\\w[\\w ]{0,20}[:\\-]|$)`, 'is');
      const m = text.match(re);
      if (m && m[1].trim()) return m[1].trim();
    }
    return '';
  };

  const outcomeRaw = grab(['outcomes?', 'results?', 'client (?:outcomes?|results?|stor(?:y|ies))', 'case stud(?:y|ies)']);
  const opinion = grab(['opinion', 'pov', 'point of view', 'take', 'contrarian(?: take)?', 'we believe', 'our (?:view|stance)']);
  const internalProcess = grab(['process', 'method(?:ology)?', 'how we (?:do|work)', 'internal (?:tool|process)', 'tool']);
  const otherFacts = grab(['facts?', 'about', 'brand', 'credentials?', 'volume', 'years?', 'service area', 'location']);

  const realOutcomes = outcomeRaw ? outcomeRaw.split(/\n|;|(?<=\.)\s+(?=[A-Z])/).map((s) => s.trim()).filter(Boolean) : [];
  const labelled = !!(outcomeRaw || opinion || internalProcess || otherFacts);
  // If nothing was labelled but a brief exists, treat the whole thing as raw facts.
  const other = labelled ? otherFacts : text;
  const hasRealInputs = !!(realOutcomes.length || opinion || internalProcess || other);

  return { realOutcomes, opinion, internalProcess, otherFacts: other, hasRealInputs };
}

function groundingFacts(project: ContentProject, brand?: BrandProfile, synth?: CompetitorSynthesis | null) {
  const r = project.research;
  const gap = project.gap as GapReport | undefined;
  const brief = parseBrief(project.extraInfo);
  return {
    topic: project.keyword,
    currentYear: new Date().getFullYear(),
    extraBrief: project.extraInfo || '',
    winnersCoverSubtopics: synth?.commonThemes || [],
    formatPatterns: synth?.formatPatterns || [],
    contentGaps: (gap?.gaps || []).map((g) => g.topic),
    differentiationAngle: gap?.differentiationAngle || '',
    quickWins: gap?.quickWins || [],
    peopleAlsoAsk: r?.peopleAlsoAsk || [],
    relatedSearches: (r?.relatedSearches || []).slice(0, 10),
    brand: brand ? {
      name: brand.brandName, voiceSummary: brand.voiceSummary,
      toneAttributes: brand.toneAttributes, vocabulary: brand.vocabulary,
      audience: brand.audience, avoid: brand.avoid,
    } : { voiceSummary: config.brand.defaultVoice, name: config.brand.name },
    // The brief split into explicit slots (see parseBrief). This is what lets the
    // writer anchor real examples instead of fabricating them.
    structuredBrief: brief,
    // Raw first-party material an honest first-party/external parameter can draw on.
    availableFirstPartyData: project.extraInfo || '(none provided)',
    brandGuidelines: [project.extraInfo, brand?.voiceSummary, (brand?.avoid || []).length ? `Avoid: ${(brand!.avoid).join('; ')}` : '']
      .filter(Boolean).join(' | ') || '(none)',
  };
}

/* --------------------------------- pass 1: plan --------------------------------- */

const PLAN_SYSTEM = `You are an experienced content strategist outlining an article that must rank on Google AND read as genuine expert writing.

TOPIC HANDLING (important):
- Use the topic naturally and grammatically. Correct obvious casing (write "AI", "SEO", "B2B", "SaaS", not lowercase).
- NEVER force an ungrammatical exact-match string. If the given topic is awkward (e.g. "a ai"), rewrite it into the correct, natural subject ("AI") in the title and headings.

FRESHNESS (write for "currentYear", not from stale memory):
- Plan the piece for the current year given in the input. Do NOT anchor the article to a specific dated product launch or announcement from your training data (for example, leading with "Google's SGE, announced in 2023"). Those framings age badly and read as out-of-date.
- Describe the current state of the practice, not a moment in the past. Only reference a specific dated event if it appears in the real research/evidence you are given.

You receive the topic, the real subtopics the ranking pages cover, related searches and People-Also-Ask, the brand's audience/voice, a "sourceDigest" of concrete insights pulled from the pages that actually rank, a "winnerStructure" (the ACTUAL H2/H3 outlines, typical length and format of the current top-ranking pages), and a "structuredBrief" of any real first-party material. Plan around what is really there.

MIRROR THE WINNERS (most important): "winnerStructure.outlines" is how the pages that already rank for this topic are actually written. Base your outline on the sections those pages share — same core topics, similar order and grouping, adapted and improved, NOT copied verbatim and NOT padded with sections the winners do not cover. If most winners have an FAQ / comparison table / step list, include that format. Match roughly their scope and length ("winnerStructure.medianWords"); do not balloon far beyond it. This keeps the article on-topic and structured like what readers and Google already reward, instead of a generic template.

Build sections from the winners' structure, the sourceDigest and the PAA so each section has real substance to cover; do not plan a section that would need specifics none of this material contains. If "writingMode" is "number-light", still plan a full, substantive article.

You are ALSO given an E-E-A-T parameter catalog and the rules for applying it. SELECT the parameters that fit this topic and theme, honestly gated: apply first-party/external parameters only when the real data or a verifiable source is actually available in the brief/brand data; skip the rest; drop any parameter that contradicts the brand guidelines.

Return ONLY minified JSON:
{"title": string,                 // compelling, natural, includes the real subject
 "metaDescription": string,       // <=155 chars, specific, no fluff
 "slug": string,                  // kebab-case
 "sections": [{"heading": string, "keyPoints": string[], "words": number}],  // 5-8 H2 sections
 "faq": string[],                 // 3-6 real questions (prefer the provided PAA)
 "appliedParams": string[],       // parameter IDs (e.g. "P16") to satisfy in the draft
 "skippedParams": [{"id": string, "reason": string}]}  // params deliberately skipped (irrelevant, no real data, or brand conflict)

Rules:
- Build sections from the sourceDigest, the winners' subtopics AND the content gaps (the gaps are the edge). Every section must have real material to cover.
- Phrase headings as the real questions a reader asks ("How does X work?", "What does X cost?"), not vague labels ("Overview", "Background").
- If the topic has meaningfully different variants (platforms, tiers, segments, tools), give the strongest of them their own focused section or clearly-scoped sub-points, rather than one vague catch-all. Specificity is the edge.
- Reserve ONE section for a genuine point of view or de-hyping: an argument, a pushback on common practice, a "what's overrated / what doesn't work" take (not a neutral explainer). If the brief supplies an "opinion" slot or the evidence has a contrarian source, build this section on it. Mark its intent in the keyPoints.
- Make the FINAL body section a tiered "where to start / how to begin" that gives the reader different first steps depending on their situation.
- Weight the word budget toward the 2 or 3 strongest, most differentiated sections rather than spreading it evenly; thin sections should be short, not padded. The total should still land near the target.
- Do NOT list an "Introduction", "Key Takeaways", "Conclusion", "FAQ" or "Table of Contents" as sections — the writer adds those. Plan only the substantive H2 body sections.
- Plan for DEPTH: give each section enough of a word budget to explain the mechanism, give concrete steps, and cite evidence. Favour fewer, deeper sections over many shallow ones.
- keyPoints are angles to cover, not fabricated facts. Never put an invented statistic or a template placeholder (e.g. "[Company Name]") in the title, headings, or keyPoints.
- Be honest about skips: it is CORRECT to skip a first-party parameter when no real data was provided.`;

async function planOutline(facts: any, target: number): Promise<OutlinePlan | null> {
  try {
    const plan = await completeJSON<OutlinePlan>(
      PLAN_SYSTEM,
      JSON.stringify({
        ...facts,
        targetWordCount: target,
        eeatParameterCatalog: compactCatalog(),
        parameterRules: PARAM_RULES,
      }),
      // completeJSON sets low reasoning effort (so reasoning tokens are ~35, not
      // hundreds), which means the plan needs only enough budget for the JSON
      // itself. 4000 is ample for 5-8 sections and keeps the call cheap.
      { temperature: 0.4, maxTokens: 4000 },
    );
    if (!plan?.sections?.length) return null;
    return plan;
  } catch (e) { console.error('[planOutline] failed:', (e as any)?.message || e); return null; }
}

/* -------------------------------- pass 2: draft -------------------------------- */

const DRAFT_SYSTEM = `You are a seasoned human content writer — the kind a reader trusts because you clearly know the subject and waste none of their time. Write the FULL article in markdown from the outline you are given, in the brand's voice, by SYNTHESIZING the real research you are handed into original, specific prose. Return ONLY the markdown, with no JSON, preamble, or commentary. A publish gate will audit this draft against every rule below and auto-reject fabrication, so follow them exactly.

USE THE RESEARCH (this is what separates a real writer from a generic one):
- SOURCE_DIGEST is real, source-grounded material — definitions, methods, trade-offs, named techniques and concrete examples pulled from the pages that actually rank for this topic. Build the article's substance from it: explain HOW and WHY, walk through the real mechanics, name the specific techniques. Rephrase it in your own words and weave points together; never copy a line verbatim and never just list the digest back.
- The reader should finish a section knowing something concrete they did not know before. If you find yourself writing a sentence that could appear in any article on any topic, cut it and replace it with a specific point from the research.

WRITE LIKE THE PAGES THAT ALREADY RANK: you are given "winnerStructure" — the real H2/H3 outlines, typical length and format of the current top-ranking pages for this topic. Follow the OUTLINE you were given (it was built from those winners): cover the same core sections in a similar order, match their scope and roughly their length, and use the formats they use (FAQ, comparison table, step list) when winnerStructure shows them. Do not invent extra sections the winners do not cover, and do not balloon far past their length.

STAY ON TOPIC — no random detail: include a fact, statistic, or paragraph ONLY if it directly answers the reader's question for that section. Do not drop in a tangential number or aside just because it appears in the research. If a detail does not help the reader with THIS topic, cut it.

ARTICLE METHOD (follow this arc, do not label it):
1. ANSWER THE TOPIC FIRST, then expand. The very first paragraph directly answers the core question the title asks, in 2 to 4 plain sentences the reader can act on right away. ONLY AFTER that direct answer do you add context: why it matters, what has changed, and one line on what the guide covers. Do NOT open with a hook, a dictionary definition ("X is defined as"), a rhetorical question, or backstory before the answer.
2. KEY TAKEAWAYS. Right after that opening, a "## Key Takeaways" list of 4 to 6 specific, standalone lines that summarise the article's real answers (not a table of contents, not one-word bullets).
3. SECTIONS — answer-first, then only as much depth as the topic needs. Each H2 is a real reader question; open with a 40-60 word standalone answer, THEN add the supporting detail that a reader actually needs: the mechanism (why/how), concrete steps, and evidence. Match the depth of the winning pages — enough to be genuinely useful, without padding or tangents. A tight, on-topic section beats a long rambling one.
4. EVIDENCE DENSITY, ATTRIBUTED INLINE. Support claims with the EVIDENCE_PACK stats and quotes, naming the source inline ("a 2026 Conductor analysis of 3.3B sessions found..."), not in a footnote. A claim with no evidence and no reasoning is filler — cut it or ground it.
5. BREAK A MONOLITHIC TOPIC INTO SPECIFIC SUB-CASES. If the subject has meaningfully different variants (platforms, tiers, segments), give each its own specific treatment instead of one vague catch-all. Specificity is how expertise shows.
6. DE-HYPE. Somewhere, tell the reader plainly what is overrated, what does NOT work, or a common misconception — ideally anchored to EVIDENCE_PACK.contrarianSource. Naming what to skip builds trust.
7. FIRST-PARTY PROOF, IF REAL. If structuredBrief supplies a real outcome/case, weave in exactly ONE, stated directionally (a real number only if given). Never invent one; if none, skip it.
8. "WHERE TO START" CLOSE. End the body with tiered next steps ("If you are doing nothing yet, start with X. If you already have Y, do Z."), then a specific, honest CTA tied to this topic — never "contact us today".
9. FAQ. Answer the provided questions with NEW, specific information (real timeframes, conditions, numbers from the pack), not restatements of the sections.

EVIDENCE CONTRACT (authoritative — this overrides any urge to sound specific):
- NUMBERS are special: you may state a statistic, percentage, benchmark or dollar figure ONLY if it appears in EVIDENCE_PACK below, exactly as given. A point from SOURCE_DIGEST is qualitative material to explain — never attach a number to it that EVIDENCE_PACK does not contain.
- You may cite ONLY the statistics, quotes, and case studies present in EVIDENCE_PACK, exactly as given. Do not alter numbers, sources, or attributions, and do not generalize a stat beyond what its source claims.
- If \`writingMode\` is "number-light", few or no hard statistics were available. That is FINE: write a genuinely strong, useful article the way an expert would when they are explaining from knowledge rather than quoting a study. Lean on SOURCE_DIGEST, mechanisms, examples and clear reasoning. Do NOT paper over the lack of stats by inventing any. A confident, specific, number-free explanation beats a fabricated figure every time.
- If a section would benefit from a statistic, quote, or example NOT present in EVIDENCE_PACK, either omit that specific claim or write the surrounding point without a fabricated number.
- If EVIDENCE_PACK.hasCaseStudy is false, do NOT invent an illustrative scenario with specific outcome numbers. Either omit the example entirely, or describe a hypothetical WITHOUT quantified outcomes ("a team might see faster iteration", never "a 7% lift").
- EVIDENCE TAGGING: immediately after each sentence where you cite a fact from EVIDENCE_PACK, append its id in square brackets, e.g. "... found adoption rising [E3]." Tag every cited fact. These tags are stripped before the article is shown; they exist so the gate can verify your sourcing. A statistic with no [E#] tag will be treated as unverified and flagged.

GROUNDING, DO NOT FABRICATE (the most important rules):
- NEVER invent statistics, percentages, benchmarks, or study names. No "up to 50%", no "30 to 40% boost", no made-up "cost reduction" numbers. If you were not handed a real, sourced figure, make the point QUALITATIVELY with no number ("many teams report gains", never "a 34% increase").
- Every statistic you DO state must name a real source, organization plus year at minimum (for example "a 2026 HubSpot survey of 1,400 marketers found..."). Never write "studies show" with no attribution.
- Every quote must come from a real, named person with a real title or affiliation. Never fabricate a quote or attribute one to someone who did not say it.
- NEVER invent a case study, client name, or outcome number. If no real case study appears in "availableFirstPartyData", OMIT the case-study section entirely. A missing section beats a fake one.
- Do NOT claim first-hand testing, awards, or specific results you were not given.
- Tables are fine only for qualitative comparisons, never for fabricated metrics.
- If a claim genuinely needs a number or source you do not have, DO NOT invent it: write a bracketed flag inline, "[NEEDS SOURCE: the claim about X]", and move on. Leaving that flag is correct behaviour.
- NEVER leave a template placeholder in the final draft (for example "[Company Name]", "[insert topic]", "{brand}", or an ungrammatical stub like "a AI"). If a variable was not supplied, flag it with a bracket note rather than guessing.

LENGTH & DEPTH:
- The target word count is a guide, not a quota to pad toward. Reach it by expanding the 2 or 3 STRONGEST sections with more real evidence, detail, and worked examples, not by stretching every section evenly. A shorter, denser article that earns every sentence beats a padded one that hits the number. Never add filler, restatement, or throat-clearing to reach length.

TAKE A POSITION (required dedicated section, 150 to 250 words):
- Include ONE dedicated section built around EVIDENCE_PACK.contrarianSource: a genuine position (disagree with common practice, challenge hype, make an underrated case), not a restatement of a fact. Cite the contrarian source and tag it.
- If EVIDENCE_PACK.contrarianSource is null, write this section as an open question the industry has not resolved, drawn from the strongest ambiguity in the evidence, rather than fabricating a confident contrarian claim.
- If a real opinion is supplied in the brief's "opinion" slot, fold it in.
- Every draft should contain at least one sentence a competing generalist guide would NOT write. Avoid sentences interchangeable with any other article on this topic.

FRESHNESS (write for the current year given in the input):
- Do NOT frame the article around a dated product launch or announcement recalled from training data (e.g. "Google's SGE, announced in 2023"). Such framing reads as 18 months out of date. Write about the current state of the practice; cite a specific dated event only if it appears in EVIDENCE_PACK.
- Explain the topic with real substance and specifics, not a generic dictionary definition. It is good to orient the reader on what the topic is and why it matters; just make every sentence carry information a practitioner would value.

VOICE:
- Match the brand voice, tone and vocabulary provided. If none, write as a clear, credible human expert.
- Vary sentence and paragraph length. Do NOT open sections with the same structure repeatedly.
- NO EM DASHES. Do not use the "—" character anywhere. Use a period, a comma, "and", or parentheses instead.
- Cut redundant qualifiers. Never stack vague adjectives ("robust", "seamless", "cutting-edge", "holistic", "disciplined, rigorous, customer-focused"). Pick one precise word, or a concrete noun or verb. Every adjective must add concrete meaning.
- Do NOT restate the same fact, statistic, or sentence in more than one place (for example the same benchmark in two adjacent paragraphs). State each point once, in its strongest place.
- Ban these AI-tell phrases entirely: "in today's fast-paced world", "in the ever-evolving", "it's important to note", "when it comes to", "at the end of the day", "let's dive in", "delve into", "a testament to", "plays a crucial/vital role", "unlock the power", "elevate your", "to the next level", "game-changer", "seamless", "robust", "leverage", "navigating the world of", "in conclusion".

CONCRETE EXAMPLES, ANCHORED TO REAL INPUTS (do not fabricate to sound specific):
- Anchor concrete examples to the "structuredBrief" you are given (realOutcomes, opinion, internalProcess, otherFacts). Those are the ONLY real specifics you have. Use them.
- If "structuredBrief.hasRealInputs" is false or a slot is empty, DO NOT invent a specific client, result, or case to fill it. Either OMIT that example/section, or use an openly-hypothetical illustration that is clearly framed as such ("Say a store grouped its pages by intent: it might..."). A clearly-hypothetical illustration must never name a real-sounding company or carry a number.
- A real client outcome from "realOutcomes" may be stated directionally without a fake precise figure ("a client saw meaningful traffic growth after doing X"). Do not attach an invented percentage to it.
- Never present a hypothetical as if it were something the brand actually did.

E-E-A-T PARAMETERS:
- Satisfy the "eeatRequirements" provided, but obey "parameterRules" exactly. Only the listed parameters apply; do not chase others.
- Honesty gate (critical): for any requirement that would need a real figure, case story, client quote, credential, location, statistic or citation, include it ONLY if that real data appears in "availableFirstPartyData" or is a genuinely verifiable, well-known fact. If it is not available, DO NOT fabricate it, leave it out or flag it with [NEEDS SOURCE: ...]. A missing honest detail is fine; an invented one is a failure.
- Follow "brandGuidelines"; if a guideline conflicts with a requirement, follow the guideline.

STRUCTURE:
- Start with an H1 title, then the direct answer to the topic (ARTICLE METHOD 1), then Key Takeaways, then the sections that follow the given outline in order (it mirrors the top-ranking pages). Phrase headings as real reader questions, never vague labels ("Overview", "Background").
- The word target is a guide, not a quota. Match the length and scope of the winning pages; never pad to reach a number.
- Close briefly (a short "where to start" and, if the winners use one, an FAQ). Do not tack on sections the winners do not have.

NEVER PRINT SCAFFOLDING (hard rule — these are inputs, not copy):
- Do NOT output any parameter ID or its label anywhere — no "(P18)", "P21", "Step-Level Process Breakdown", "Conditional Reasoning", "Original Point of View", "(craft)". Satisfy those qualities invisibly through the writing itself. A heading like "Step-level process (P18)" is a failure; write "How to set it up, step by step".
- Do NOT output bracketed input keys as if they were citations — no "[Source Digest]", "[SOURCE_DIGEST]", "[EVIDENCE_PACK]", "[contrarianSource]". Cite a real source by name in prose instead. The only bracket tags allowed are the "[E#]" evidence tags and an honest "[NEEDS SOURCE: ...]" flag.`;

function groupRequirements(params: EeatParam[]): Record<string, string[]> {
  // Only the craft hint reaches the writer — never the parameter ID or name, so it
  // cannot echo "(P18)" or a label like "Step-Level Process Breakdown" into the
  // prose. The qualities are satisfied invisibly.
  const out: Record<string, string[]> = {};
  for (const p of params) (out[p.category] ||= []).push(p.hint);
  return out;
}

async function writeBody(plan: OutlinePlan, facts: any, target: number, applied: EeatParam[], pack: EvidencePack): Promise<string> {
  const evidence = evidenceIndex(pack);
  const user = JSON.stringify({
    targetWordCount: target,
    currentYear: facts.currentYear,
    title: plan.title,
    outline: plan.sections.map((s) => ({ heading: s.heading, keyPoints: s.keyPoints, words: s.words })),
    faq: plan.faq,
    brand: facts.brand,
    extraBrief: facts.extraBrief,
    structuredBrief: facts.structuredBrief,
    // How the current top-ranking pages structure this topic — mirror it.
    winnerStructure: facts.winnerStructure,
    // The ONLY factual material the writer may cite, each with a stable [E#] id.
    EVIDENCE_PACK: {
      items: evidence,
      contrarianSource: pack.contrarianSource,
      hasCaseStudy: pack.caseStudies.length > 0,
      status: pack.status,
    },
    // Real, source-grounded substance to SYNTHESIZE into original explanation
    // (definitions, methods, trade-offs, examples). Qualitative only — cite a
    // NUMBER only from EVIDENCE_PACK, never from a digest line. Capped to keep the
    // prompt within a tight per-minute token budget (e.g. Groq's free 8k TPM).
    SOURCE_DIGEST: (pack.digest || []).slice(0, 14).map((d) => `${d.point} (${d.domain})`),
    // 'number-light' = few/no hard stats were available; write a strong article
    // from SOURCE_DIGEST and real expertise WITHOUT inventing figures.
    writingMode: pack.mode || 'sourced',
    brandGuidelines: facts.brandGuidelines,
    eeatRequirements: groupRequirements(applied),
    parameterRules: PARAM_RULES,
  });
  // Plain markdown (not JSON) so a long body never truncates on JSON escaping.
  // Budget is configurable so the write call fits a small per-minute token cap.
  // reasoningEffort 'low' keeps a reasoning model's budget on the prose, not on
  // hidden reasoning (which would return an empty or truncated body).
  const md = await complete(DRAFT_SYSTEM, user, { temperature: 0.7, maxTokens: config.content.maxDraftTokens, reasoningEffort: 'low' });
  return md.trim().replace(/^```(?:markdown|md)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

/**
 * Deterministic house-style cleanup applied to EVERY draft, so even a bare
 * "write" (which does not run the LLM publish gate) never ships the two tells the
 * model produces despite being told not to: em/en dashes. The model ignores the
 * negative instruction often enough that a guaranteed post-pass is worth more than
 * another prompt line. Numeric ranges collapse to a tight hyphen ("40-60 words");
 * dashes used as prose punctuation become a comma, matching the house style.
 */
export function sanitizeProse(md: string): string {
  return md
    // numeric range: "40 – 60", "40—60"  ->  "40-60"
    .replace(/(\d)\s*[—–]\s*(?=\d)/g, '$1-')
    // prose em/en dash used as punctuation -> comma (drop any leading space)
    .replace(/\s*[—–]\s*/g, ', ')
    // clean up artefacts the replacement can create
    .replace(/,\s*([.,;:!?])/g, '$1')   // ", ." -> "."   ", ," -> ","
    .replace(/([([{])\s*,\s*/g, '$1')    // "( , " -> "("
    .replace(/[ \t]{2,}/g, ' ');
}

/** Strip the hidden [E#] evidence tags from the display markdown, returning the
 *  clean body and the list of ids the writer actually cited (for the gate). */
export function stripEvidenceTags(md: string): { markdown: string; idsUsed: string[] } {
  const idsUsed = [...new Set((md.match(/\[E\d+\]/g) || []).map((t) => t.slice(1, -1)))];
  const markdown = md
    .replace(/\s*\[E\d+\]/g, '')
    // Strip input-key placeholders the writer sometimes prints as if they were
    // citations ("[Source Digest]", "[contrarianSource]", "[EVIDENCE_PACK]"). A
    // real markdown link [text](url) is untouched (it is followed by "(").
    .replace(/\s*\[(?:contrarian ?source|contrarian|source ?digest|source|evidence[_ ]?pack)\](?!\()/gi, '')
    // Strip leaked E-E-A-T parameter tags: "[P23]", "(P18)", " P21" used as a tag.
    .replace(/\s*[\[(]P\d{1,3}[\])]/g, '')
    // Strip a parameter LABEL left in a heading, e.g. "... (Original Point of View)"
    // or "Step-level process (P18)".
    .replace(/\s*\((?:original point of view|point of view|conditional reasoning|step[- ]level process[^)]*|trade[- ]?offs?[^)]*|craft)\)/gi, '')
    .replace(/[ \t]{2,}/g, ' ');
  return { markdown, idsUsed };
}

/* ------------------------- fast: single-pass writer ------------------------- */

// A compact, single-call writer for fast mode: one LLM call produces the whole
// article (no separate plan pass), so a fast run is ~2 LLM calls total. The prompt
// is deliberately short to keep the request well under a small per-minute token
// cap. It carries the same non-negotiables as the deep writer: the reference
// method arc, the evidence contract, no em dashes, no scaffolding leaks.
const FAST_WRITE_SYSTEM = `You are a seasoned human content writer. Write a COMPLETE, publish-ready article in markdown on the given topic, synthesizing the REAL research provided. Return ONLY markdown (no preamble, no JSON, no code fences).

MIRROR THE WINNERS: "winnerStructure" holds the real outlines, length and format of the pages that already rank for this topic. Cover the same core sections in a similar order and match their scope and roughly their length; use their formats (FAQ, table, step list) when shown. Do not add sections they lack or balloon past their length.

STAY ON TOPIC: include a fact or paragraph only if it directly answers the reader's question. No tangents, no random stats.

METHOD (follow the arc, do not label it):
- Start with a single "# " H1 title. Then ANSWER THE TOPIC FIRST: the opening paragraph directly answers the core question in 2-4 plain sentences the reader can act on. Only after that add brief context (why it matters, what changed). No hook, no dictionary definition, no "In today's landscape" before the answer.
- Then a "## Key Takeaways" list of 4-6 specific, standalone lines summarising the real answers.
- Then H2 sections following the given outline (which mirrors the winners), each a real reader question: open with a 40-60 word standalone answer, then add the detail the reader needs (mechanism, steps, evidence) from SOURCE_DIGEST. As much depth as the topic needs, no padding or tangents.
- Include one honest "what is overrated / what does not work" point.
- Close briefly with where to start and, if the winners use one, a short FAQ.

EVIDENCE (hard rules):
- State a NUMBER, percentage, or statistic ONLY if it appears in STATS below; cite its source inline and put its id in brackets after the sentence, e.g. "... rose sharply [E2]." Never invent a statistic, quote, case study, or source.
- If writingMode is "number-light", write a strong QUALITATIVE expert article with no invented figures. Build substance from SOURCE_DIGEST (rephrase in your own words, never copy, never just list it).

VOICE:
- Plain, specific, confident. Vary sentence and paragraph length. Address the reader as "you".
- NO EM DASHES or en dashes (— or –). Use commas, periods, or parentheses.
- Ban AI-tell phrases ("in today's fast-paced world", "delve", "seamless", "robust", "leverage", "unlock", "elevate", "in conclusion", "it's important to note", "when it comes to").
- Never print a parameter ID (like P18) or a bracketed input key (like [Source Digest]); the only brackets allowed are [E#] citations.`;

async function writeArticleFast(facts: any, target: number, pack: EvidencePack): Promise<string> {
  const evidence = evidenceIndex(pack);
  const user = JSON.stringify({
    topic: facts.topic,
    currentYear: facts.currentYear,
    targetWordCount: Math.min(target, 1500),
    writingMode: pack.mode || 'sourced',
    winnerStructure: pack.structure || null,
    SOURCE_DIGEST: (pack.digest || []).slice(0, 12).map((d) => d.point),
    STATS: evidence.filter((e) => e.kind === 'stat').map((e) => `${e.id}: ${e.text}`),
    quotes: evidence.filter((e) => e.kind === 'quote').map((e) => e.text),
    contrarian: pack.contrarianSource,
    faq: (facts.peopleAlsoAsk || []).slice(0, 5),
    relatedSearches: (facts.relatedSearches || []).slice(0, 8),
    brandVoice: facts.brand?.voiceSummary || '',
    structuredBrief: facts.structuredBrief,
  });
  // reasoningEffort 'low': on a reasoning model (gpt-oss) the draft budget must go
  // to the ARTICLE, not hidden reasoning — otherwise the body comes back empty.
  const md = await complete(FAST_WRITE_SYSTEM, user, { temperature: 0.6, maxTokens: Math.min(config.content.maxDraftTokens, 2800), reasoningEffort: 'low' });
  return md.trim().replace(/^```(?:markdown|md)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

/* -------------------------------- orchestration -------------------------------- */

async function generateDraft(project: ContentProject, brand?: BrandProfile, synth?: CompetitorSynthesis | null, pack?: EvidencePack): Promise<ContentDraft | null> {
  const target = targetWordCount(project.research);
  const facts = groundingFacts(project, brand, synth);
  const evPack: EvidencePack = pack || (project.evidence as EvidencePack) || { keyword: project.keyword, status: 'NO_SEARCH', stats: [], quotes: [], caseStudies: [], contrarianSource: null, gaps: [], pagesRead: [], collectedAt: new Date().toISOString() };
  // Let the planner see the real researched substance so it builds sections around
  // what the sources actually cover, not around generic headings.
  (facts as any).sourceDigest = (evPack.digest || []).map((d) => d.point).slice(0, 16);
  (facts as any).writingMode = evPack.mode || 'sourced';
  // How the top-ranking pages actually structure this topic — the writer mirrors it.
  (facts as any).winnerStructure = evPack.structure || null;

  // FAST mode writes the whole article in ONE call (no separate plan pass) to keep
  // a run to ~2 LLM calls; DEEP mode uses the richer plan-then-draft two-pass.
  let raw: string;
  let planMeta = { metaDescription: '', slug: project.key, appliedParams: [] as string[], skippedParams: [] as { id: string; reason: string }[], sections: [] as { heading: string }[], title: '' };
  if (config.content.researchMode === 'fast') {
    raw = await writeArticleFast(facts, target, evPack).catch((e) => { console.error('[writeArticleFast] failed:', (e as any)?.message || e); return ''; });
  } else {
    const plan = await planOutline(facts, target);
    if (!plan) return null;
    const applied = paramsById(plan.appliedParams || []);
    raw = await writeBody(plan, facts, target, applied, evPack).catch((e) => { console.error('[writeBody] failed:', (e as any)?.message || e); return ''; });
    planMeta = { metaDescription: plan.metaDescription || '', slug: plan.slug || project.key, appliedParams: plan.appliedParams || [], skippedParams: plan.skippedParams || [], sections: plan.sections || [], title: plan.title || '' };
  }
  if (!raw) return null;
  const { markdown: tagged, idsUsed } = stripEvidenceTags(raw);
  const markdown = sanitizeProse(tagged);

  const wordCount = markdown.replace(/[#*_>`~\-|]/g, ' ').split(/\s+/).filter(Boolean).length;

  // Derive the title and outline from the ACTUAL generated markdown, not the plan
  // — the writer may rename or add sections, so reading the real H1/H2s keeps the
  // reported metadata perfectly in sync with the body (no template drift).
  const { h1, h2s } = extractHeadings(markdown);
  const title = h1 || planMeta.title || project.keyword;
  const outline = h2s.length ? h2s : planMeta.sections.map((s) => s.heading);

  return {
    title,
    metaDescription: (planMeta.metaDescription || '').slice(0, 160),
    slug: planMeta.slug || project.key,
    wordTarget: target,
    competitorMedian: project.research?.medianWordCount ?? project.research?.avgWordCount ?? null,
    outline,
    markdown,
    wordCount,
    appliedParams: (planMeta.appliedParams || []).filter((id) => paramsById([id]).length),
    skippedParams: planMeta.skippedParams || [],
    evidenceStatus: evPack.status,
    evidenceMode: evPack.mode || 'sourced',
    digestUsed: evPack.digest?.length || 0,
    evidenceIdsUsed: idsUsed,
    generatedAt: new Date().toISOString(),
    model: llmInfo().model,
  };
}

/** Pull the H1 (title) and H2 headings straight from the generated markdown. */
function extractHeadings(markdown: string): { h1: string | null; h2s: string[] } {
  let h1: string | null = null;
  const h2s: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const m1 = line.match(/^#\s+(.+?)\s*#*\s*$/);
    const m2 = line.match(/^##\s+(.+?)\s*#*\s*$/);
    if (m1 && !h1) h1 = m1[1].trim();
    else if (m2) h2s.push(m2[1].trim());
  }
  return { h1, h2s };
}

/* ---------------------------------- report ---------------------------------- */

export function draftReport(project: ContentProject, draft: ContentDraft): Report {
  const blocks = [];
  blocks.push(b.p(`Draft for "${draft.title}" — written in your brand voice and grounded in the real research. It has no fabricated stats or case studies; fact-check and run E-E-A-T before publishing.`));

  const kv = [
    { k: 'Title', v: draft.title },
    { k: 'Meta description', v: draft.metaDescription || '—' },
    { k: 'Slug', v: draft.slug },
    { k: 'Word count', v: `${draft.wordCount.toLocaleString()} (target ${draft.wordTarget.toLocaleString()})` },
    { k: 'Sections', v: String(draft.outline.length) },
    { k: 'Evidence', v: `${draft.evidenceStatus || 'n/a'}${draft.evidenceMode ? ` (${draft.evidenceMode})` : ''} · cited ${draft.evidenceIdsUsed?.length || 0} stat(s) · ${draft.digestUsed || 0} sourced insight(s)` },
  ];
  if (draft.competitorMedian && draft.competitorMedian > draft.wordTarget * 1.4) {
    kv.push({ k: 'Competitor median', v: `${draft.competitorMedian.toLocaleString()} words — some rank longer; expand top sections if you want to match` });
  }
  blocks.push(b.kv(kv));

  if (draft.evidenceMode === 'number-light') {
    blocks.push(b.note(`Written in number-light mode: fewer than ${3} hard statistics were found, so this reads as an expert explanation grounded in ${draft.digestUsed || 0} researched insight(s) rather than a stats-led piece. No figure was invented. To make it more quantitative, supply real data in the brief or add a case study file.`));
  }

  if (draft.wordCount < draft.wordTarget * 0.7) {
    blocks.push(b.note(`This draft came in under target (${draft.wordCount.toLocaleString()} vs ${draft.wordTarget.toLocaleString()}). Re-run to regenerate, or expand the thinnest sections — better short and specific than padded.`));
  }

  if (draft.outline.length) { blocks.push(b.p('Outline:')); blocks.push(b.list(draft.outline)); }

  // E-E-A-T parameter transparency — what was applied, and what was honestly skipped.
  if (draft.appliedParams?.length) {
    blocks.push(b.p(`E-E-A-T parameters applied (${draft.appliedParams.length}) — selected for this topic:`));
    blocks.push(b.chips(paramsById(draft.appliedParams).map((p) => `${p.id} ${p.name}`)));
  }
  if (draft.skippedParams?.length) {
    blocks.push(b.p('Skipped honestly (irrelevant, no real first-party data, or brand conflict):'));
    blocks.push(b.list(draft.skippedParams.slice(0, 8).map((s) => {
      const p = paramsById([s.id])[0];
      return `${s.id}${p ? ` ${p.name}` : ''} — ${s.reason}`;
    })));
  }

  blocks.push(b.note(draft.markdown));
  blocks.push(b.chips(['Run the publish gate', 'Fact-check this draft', 'Check E-E-A-T', 'Audit this draft']));

  return { tag: 'Draft', title: `Draft — ${draft.title}`, blocks, data: { key: project.key, keyword: project.keyword, hasDraft: true } };
}
