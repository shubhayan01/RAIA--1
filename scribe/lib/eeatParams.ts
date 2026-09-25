/**
 * Canonical E-E-A-T parameter catalog — shared by the WRITER (which selects and
 * applies the parameters that fit a topic) and the E-E-A-T SCORER (which grades
 * against them). One rubric, so writing and scoring never drift.
 *
 * The `needs` tag is the anti-hallucination gate — the single most important
 * field here:
 *   'craft'      — satisfiable by good writing alone (structure, terminology,
 *                  reasoning). Always eligible when the topic calls for it.
 *   'firstparty' — REQUIRES real, brand-provided data (business volume, years in
 *                  operation, a real case story, credentials, a real client
 *                  quote). MUST be skipped unless that data is actually supplied —
 *                  never invented. Faking these is the classic E-E-A-T lie.
 *   'external'   — REQUIRES a real, verifiable external fact/source/benchmark.
 *                  Include only if genuinely known and checkable; otherwise state
 *                  the point without a fabricated citation and let fact-check run.
 *   'guard'      — a guardrail parameter (always on): it forbids fabrication or
 *                  demands accuracy.
 */

export type ParamNeed = 'craft' | 'firstparty' | 'external' | 'guard';
export type ParamCategory = 'Experience' | 'Expertise' | 'Authority' | 'Trust' | 'AEO/SEO';

export interface EeatParam {
  id: string;
  name: string;
  category: ParamCategory;
  needs: ParamNeed;
  hint: string;
}

export const EEAT_PARAMS: EeatParam[] = [
  // 🧪 Experience
  { id: 'P1', name: 'First-Person Narrative', category: 'Experience', needs: 'firstparty', hint: 'Write from real first-hand experience only if the brand actually has it; otherwise stay third-person.' },
  { id: 'P2', name: 'Quantified Business Volume', category: 'Experience', needs: 'firstparty', hint: 'State volumes (e.g. "5,000 orders/month") ONLY if the real figure is provided.' },
  { id: 'P3', name: 'Quantified Time in Operation', category: 'Experience', needs: 'firstparty', hint: 'State years in operation ONLY if the real figure is provided.' },
  { id: 'P4', name: 'Specific Customer or Case Story', category: 'Experience', needs: 'firstparty', hint: 'Tell a real, provided customer story. Never invent a client or a case.' },
  { id: 'P5', name: 'Outcome Data from Own Work', category: 'Experience', needs: 'firstparty', hint: 'Cite outcomes from the brand’s own work ONLY with real numbers provided. No invented results.' },
  { id: 'P6', name: 'Location or Regional Specificity', category: 'Experience', needs: 'firstparty', hint: 'Name the brand’s real service area/region if known; do not guess a location.' },
  { id: 'P8', name: 'Seasonal or Cyclical Pattern', category: 'Experience', needs: 'craft', hint: 'Note genuine, widely-known seasonal/cyclical patterns for the topic.' },
  { id: 'P10', name: 'Real Client Concern Quoted', category: 'Experience', needs: 'firstparty', hint: 'Quote a real client concern only if provided; otherwise describe common concerns generally.' },
  { id: 'P11', name: 'Age / Demographic / Cohort Specificity', category: 'Experience', needs: 'firstparty', hint: 'Reference the brand’s real audience cohort only if known; else discuss demographics generally.' },
  { id: 'P14', name: 'Avoids Fabricated Experience Language', category: 'Experience', needs: 'guard', hint: 'Never imply first-hand experience, testing or results the brand has not actually reported.' },
  { id: 'P15', name: 'Public Profile Information Mined Correctly', category: 'Experience', needs: 'firstparty', hint: 'Use only accurate details from the brand’s real public profile.' },

  // 🎓 Expertise
  { id: 'P16', name: 'Correct Technical Terminology', category: 'Expertise', needs: 'craft', hint: 'Use the field’s precise, correct terminology.' },
  { id: 'P17', name: 'Mechanism Explanation — The Why & How', category: 'Expertise', needs: 'craft', hint: 'Explain why/how things work, not just what to do.' },
  { id: 'P18', name: 'Step-Level Process Breakdown', category: 'Expertise', needs: 'craft', hint: 'Break key processes into concrete, ordered steps.' },
  { id: 'P19', name: 'Corrects a Common Misconception', category: 'Expertise', needs: 'craft', hint: 'Name and correct a genuine common misconception about the topic.' },
  { id: 'P20', name: 'Specific Measurements & Thresholds', category: 'Expertise', needs: 'external', hint: 'Give real, standard measurements/thresholds only if accurate; never invent numbers.' },
  { id: 'P21', name: 'Trade-offs and Limitations Stated', category: 'Expertise', needs: 'craft', hint: 'State honest trade-offs and where the approach falls short.' },
  { id: 'P23', name: 'Conditional Reasoning — When X Then Y', category: 'Expertise', needs: 'craft', hint: 'Give conditional guidance ("if X, then Y; otherwise Z").' },
  { id: 'P24', name: 'Industry Benchmarks Cited Correctly', category: 'Expertise', needs: 'external', hint: 'Cite a real, verifiable benchmark or none — never a fabricated percentage.' },
  { id: 'P25', name: 'Evidence-Based Claims Framed Accurately', category: 'Expertise', needs: 'guard', hint: 'Frame claims to match their real strength; hedge when evidence is limited.' },

  // 🏛️ Authority
  { id: 'P30', name: 'Cites External Authoritative Source', category: 'Authority', needs: 'external', hint: 'Reference a real, well-known authoritative source; do not invent one.' },
  { id: 'P31', name: 'Third-Party Quote from Authoritative Figure', category: 'Authority', needs: 'external', hint: 'Include a real, verifiable quote only if genuinely known; never fabricate a quote.' },
  { id: 'P32', name: 'Professional Association Referenced', category: 'Authority', needs: 'external', hint: 'Reference the correct real professional body for the field, if relevant.' },
  { id: 'P33', name: 'Certification or Credential Mentioned', category: 'Authority', needs: 'firstparty', hint: 'Mention the brand’s real certifications only if provided.' },
  { id: 'P34', name: 'Topic Cluster — Internal Links', category: 'Authority', needs: 'craft', hint: 'Suggest internal links to related topics using descriptive anchors (mark as [internal link: …] if URLs unknown).' },
  { id: 'P35', name: 'Publish or Last-Updated Date Visible', category: 'Authority', needs: 'craft', hint: 'Include a visible publish/updated date line.' },
  { id: 'P36', name: 'Content Freshness — Current Data Cited', category: 'Authority', needs: 'external', hint: 'Reference current, real developments only if accurate; do not fabricate recency.' },

  // 🛡️ Trust
  { id: 'P37', name: 'No Misleading Title or Clickbait', category: 'Trust', needs: 'guard', hint: 'Title must honestly reflect the content.' },
  { id: 'P38', name: 'Informative Tone — Not a Covert Sales Pitch', category: 'Trust', needs: 'craft', hint: 'Inform first; keep any promotion light and honest.' },
  { id: 'P39', name: 'Internal Links Use Descriptive Anchor Text', category: 'Trust', needs: 'craft', hint: 'Any link uses descriptive anchor text, never "click here".' },
  { id: 'P40', name: 'Disclaimer Present for Sensitive Topics', category: 'Trust', needs: 'craft', hint: 'Add an appropriate disclaimer for YMYL/medical/financial/legal topics.' },
  { id: 'P41', name: 'No Factual Errors or Outdated Information', category: 'Trust', needs: 'guard', hint: 'State only accurate, current facts; when unsure, omit or hedge.' },
  { id: 'P42', name: 'Formatting Serves Reader, Not SEO', category: 'Trust', needs: 'craft', hint: 'Format for readability, not keyword stuffing.' },

  // 🔍 AEO / SEO — gate checks
  { id: 'P43', name: 'Covers the Topic Completely', category: 'AEO/SEO', needs: 'craft', hint: 'Cover the topic’s core subtopics thoroughly.' },
  { id: 'P44', name: 'Contains an Original Point of View', category: 'AEO/SEO', needs: 'craft', hint: 'Offer a clear, original angle, not a rehash.' },
  { id: 'P45', name: 'Table of Contents for Long-Form Content', category: 'AEO/SEO', needs: 'craft', hint: 'Add a table of contents when the article is long-form (>1,500 words).' },
  { id: 'P46', name: 'FAQ Section with Substantive Answers', category: 'AEO/SEO', needs: 'craft', hint: 'Include an FAQ with real, substantive answers to genuine questions.' },
  { id: 'P47', name: 'Answer or Definition Appears Early', category: 'AEO/SEO', needs: 'craft', hint: 'Answer the core question / define the term in the first ~100 words.' },
  { id: 'P48', name: 'No Padding in Opening Paragraphs', category: 'AEO/SEO', needs: 'craft', hint: 'Open with substance; no filler preamble.' },
  { id: 'P49', name: 'Conclusion Adds Value and Ends Logically', category: 'AEO/SEO', needs: 'craft', hint: 'End with a conclusion that adds a takeaway, not a summary restatement.' },
];

const BY_ID = new Map(EEAT_PARAMS.map((p) => [p.id, p]));
export function paramsById(ids: string[]): EeatParam[] {
  return ids.map((id) => BY_ID.get(id)).filter((p): p is EeatParam => !!p);
}

/** Compact catalog for the selection prompt: "P16 · Correct Technical Terminology · craft". */
export function compactCatalog(): string {
  return EEAT_PARAMS.map((p) => `${p.id} · ${p.name} · ${p.category} · needs:${p.needs}`).join('\n');
}

/** The shared honesty rules governing how parameters may be applied. */
export const PARAM_RULES = `E-E-A-T PARAMETER RULES (honesty gate — obey exactly):
- Apply only the parameters that genuinely fit THIS topic and theme. Not every parameter applies to every blog — skipping an irrelevant one is correct, not a failure.
- needs:craft parameters — apply freely when the topic calls for them (they need only good writing).
- needs:firstparty parameters — apply ONLY if the real data is present in the brief/brand data provided. If it is NOT provided, SKIP the parameter. NEVER invent a number, case story, client quote, location, credential or first-hand claim to satisfy one.
- needs:external parameters — apply ONLY by citing a real, well-known, verifiable fact/source/benchmark. If you cannot cite a real one, SKIP it and make the point qualitatively. Never fabricate a statistic, study, quote or citation.
- needs:guard parameters — always in force; they forbid fabrication and demand accuracy.
- BRAND GUIDELINES OVERRIDE: if a brand guideline contradicts a parameter, follow the guideline and DROP that parameter.`;

/** Default rubric text for the E-E-A-T scorer (used when the user gives no custom params). */
export function rubricText(): string {
  const groups: ParamCategory[] = ['Experience', 'Expertise', 'Authority', 'Trust', 'AEO/SEO'];
  const lines = groups.map((g) => {
    const items = EEAT_PARAMS.filter((p) => p.category === g).map((p) => `  ${p.id} ${p.name} (${p.needs})`).join('\n');
    return `${g}:\n${items}`;
  });
  return `SCRIBE E-E-A-T rubric (score only parameters relevant to the topic; do NOT penalise the honest absence of first-party parameters the author could not truthfully provide):\n\n${lines.join('\n\n')}`;
}
