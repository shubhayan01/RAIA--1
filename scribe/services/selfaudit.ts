import { completeJSON, llmConfigured } from '../llm';
import { Report, b } from '../lib/report';
import { loadProject, saveProject } from '../lib/project';
import { ContentDraft } from './write';

/**
 * Draft self-audit (SCRIBE Feature — the SECOND PASS).
 *
 * The writer (services/write.ts) is one LLM call; this is a SEPARATE call whose
 * only job is to grade a finished draft against the hard anti-hallucination and
 * house-style checklist. Splitting draft-and-audit into two calls is deliberate:
 * SCRIBE runs on a small/fast model (Groq gpt-oss free tier) that is far more
 * prone to inventing statistics and quotes than a frontier model, and asking one
 * model to both write AND police itself in a single shot is unreliable. Two
 * focused calls catch far more than one combined one.
 *
 * The backbone is DETERMINISTIC (measured from the text, so the model cannot
 * grade its own homework away): em dashes, leftover placeholders, word-count
 * tolerance, and statistics that appear with no named source nearby. An optional
 * LLM pass then judges the harder items no regex can settle: fabricated-looking
 * stats/quotes/case studies (weighed against the REAL first-party data that was
 * actually supplied), and whether a genuine trade-off is stated.
 *
 * Treat everything here as a flag, not proof: a violation is a "fix before you
 * publish" prompt. The honest [NEEDS SOURCE: …] markers the writer is told to
 * leave are surfaced separately — they are the RIGHT behaviour, not a failure.
 */

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export interface AuditViolation {
  rule: string;
  severity: Severity;
  detail: string;
  evidence?: string;   // a short quote/snippet from the draft
}

export interface ChecklistItem {
  item: string;
  pass: boolean;
  by: 'measured' | 'model';
  note?: string;
}

export interface SelfAuditResult {
  passed: boolean;               // no critical/high violations
  score: number;                 // 0-100, house-style + honesty compliance
  checklist: ChecklistItem[];
  violations: AuditViolation[];
  needsSourceFlags: string[];    // honest [NEEDS SOURCE: …] markers the writer left
  genericSentences: string[];    // sentences interchangeable with any competitor guide
  measured: {
    emDashes: number;
    placeholders: string[];
    unattributedStats: string[];
    wordCount: number;
    wordTarget: number | null;
    withinTolerance: boolean;    // within +/-10% of target (true when no target)
  };
  checkedAt: string;
}

/* ------------------------------ entry points ------------------------------ */

/** Standalone: audit a project's stored draft, or pasted content. */
export async function runSelfAudit(input: { keyword?: string; content?: string }): Promise<Report> {
  const { text, label, projectKey, wordTarget, firstParty } = await resolveContent(input);
  if (!text) {
    return { tag: 'Self-Audit', title: 'Nothing to audit', blocks: [b.note('Paste a draft to audit, or give me a keyword whose draft to audit, e.g. "audit running-shoes".')] };
  }

  const result = await auditDraftContent({ markdown: text, wordTarget, availableFirstPartyData: firstParty });

  if (projectKey) {
    const project = await loadProject(projectKey);
    if (project) { project.selfaudit = result; await saveProject(project); }
  }
  return selfAuditReport(label, result, projectKey);
}

/**
 * The core auditor, reused by runWrite for the automatic second pass.
 * Deterministic checks always run; the LLM pass runs only when a key is set.
 */
export async function auditDraftContent(input: {
  markdown: string;
  wordTarget?: number | null;
  availableFirstPartyData?: string;
}): Promise<SelfAuditResult> {
  const text = input.markdown || '';
  const target = input.wordTarget ?? null;
  const measured = measure(text, target);

  const violations: AuditViolation[] = [];
  const checklist: ChecklistItem[] = [];

  // ---- deterministic checklist items (measured, ungameable) ----
  const emOk = measured.emDashes === 0;
  checklist.push({ item: 'No em dashes used', pass: emOk, by: 'measured', note: emOk ? undefined : `${measured.emDashes} em dash(es)` });
  if (!emOk) violations.push({ rule: 'No em dashes', severity: 'medium', detail: `Found ${measured.emDashes} em dash(es). Replace each with a period, comma, or "and".`, evidence: firstEmDashContext(text) });

  const placeholderOk = measured.placeholders.length === 0;
  checklist.push({ item: 'No placeholder brackets or unfilled variables remain', pass: placeholderOk, by: 'measured', note: placeholderOk ? undefined : measured.placeholders.slice(0, 3).join(' · ') });
  if (!placeholderOk) violations.push({ rule: 'No leftover placeholders', severity: 'high', detail: `Unfilled placeholder(s) left in the draft: ${measured.placeholders.slice(0, 5).join(' · ')}. Fill them or remove them.` });

  checklist.push({ item: 'Word count within 10% of target', pass: measured.withinTolerance, by: 'measured', note: target ? `${measured.wordCount} vs target ${target}` : 'no target set' });
  if (target && !measured.withinTolerance) {
    const dir = measured.wordCount < target ? 'under' : 'over';
    violations.push({ rule: 'Word-count tolerance', severity: 'low', detail: `Draft is ${measured.wordCount} words, ${dir} the ${target}-word target by more than 10%.` });
  }

  const statsOk = measured.unattributedStats.length === 0;
  checklist.push({ item: 'Every number has a real, named source attached', pass: statsOk, by: 'measured', note: statsOk ? undefined : `${measured.unattributedStats.length} stat(s) with no nearby source` });
  if (!statsOk) violations.push({ rule: 'Unattributed statistics', severity: 'high', detail: 'A statistic appears with no named source nearby. Attribute it (organization + year) or rephrase it without a number.', evidence: measured.unattributedStats[0] });

  const needsSourceFlags = extractNeedsSource(text);
  let genericSentences: string[] = [];

  // ---- LLM pass: the items no regex can settle ----
  let llm: LlmAudit | null = null;
  if (llmConfigured() && text.trim().split(/\s+/).length > 25) {
    llm = await llmAudit(text, input.availableFirstPartyData || '(none provided)').catch(() => null);
  }
  if (llm) {
    for (const v of llm.violations || []) {
      const sev = normalizeSeverity(v.severity);
      violations.push({ rule: v.rule || 'Content honesty', severity: sev, detail: v.detail || '', evidence: v.evidence });
    }
    checklist.push({ item: 'Every quote is from a real, named person', pass: !!llm.quotesReal, by: 'model', note: llm.quotesNote });
    checklist.push({ item: 'No case study unless real data was provided', pass: !!llm.caseStudyOk, by: 'model', note: llm.caseStudyNote });
    checklist.push({ item: 'At least one limitation or trade-off is stated', pass: !!llm.tradeOffStated, by: 'model', note: llm.tradeOffNote });

    // Point of view: a neutral explainer with no argument gets outranked by
    // opinionated, primary-source content. Treat its absence as a hard fail.
    checklist.push({ item: 'Takes a genuine position (not a neutral explainer)', pass: !!llm.hasPointOfView, by: 'model', note: llm.povNote });
    if (!llm.hasPointOfView) violations.push({ rule: 'No point of view', severity: 'high', detail: 'The draft only describes the topic and never argues a position. Add a paragraph that disagrees with common practice or makes an underrated case.', evidence: llm.povNote });

    // Genericness (the interchangeability test).
    genericSentences = (llm.genericSentences || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 5);
    const genericOk = genericSentences.length <= 2;
    checklist.push({ item: 'Not generic (few interchangeable sentences)', pass: genericOk, by: 'model', note: `${genericSentences.length} interchangeable sentence(s)` });
    if (!genericOk) violations.push({ rule: 'Generic / interchangeable content', severity: 'medium', detail: `${genericSentences.length} sentences could appear verbatim in any competitor guide. Replace them with a specific stance, an anchored example, or a primary-source insight.`, evidence: genericSentences[0] });
  } else {
    checklist.push({ item: 'Every quote is from a real, named person', pass: true, by: 'model', note: 'LLM pass unavailable — verify manually' });
    checklist.push({ item: 'No case study unless real data was provided', pass: true, by: 'model', note: 'LLM pass unavailable — verify manually' });
    checklist.push({ item: 'At least one limitation or trade-off is stated', pass: true, by: 'model', note: 'LLM pass unavailable — verify manually' });
    checklist.push({ item: 'Takes a genuine position (not a neutral explainer)', pass: true, by: 'model', note: 'LLM pass unavailable — verify manually' });
    checklist.push({ item: 'Not generic (few interchangeable sentences)', pass: true, by: 'model', note: 'LLM pass unavailable — verify manually' });
  }

  const hardFails = violations.filter((v) => v.severity === 'critical' || v.severity === 'high').length;
  const passed = hardFails === 0;
  const score = scoreFrom(checklist, violations);

  return {
    passed, score, checklist, violations,
    needsSourceFlags,
    genericSentences,
    measured,
    checkedAt: new Date().toISOString(),
  };
}

/* ------------------------------ deterministic ------------------------------ */

function measure(text: string, target: number | null): SelfAuditResult['measured'] {
  const emDashes = (text.match(/—/g) || []).length;
  const placeholders = findPlaceholders(text);
  const unattributedStats = findUnattributedStats(text);
  const wordCount = text.replace(/[#*_>`~\-|]/g, ' ').split(/\s+/).filter(Boolean).length;
  const withinTolerance = target ? Math.abs(wordCount - target) <= target * 0.1 : true;
  return { emDashes, placeholders, unattributedStats, wordCount, wordTarget: target, withinTolerance };
}

// Bracketed spans that are NOT markdown links and NOT the honest markers we ask
// the writer to leave ([NEEDS SOURCE: …], [internal link: …]).
function findPlaceholders(text: string): string[] {
  const out: string[] = [];
  const re = /\[([^\]\n]{1,80})\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const inner = m[1].trim();
    const after = text[m.index + m[0].length];
    if (after === '(') continue;                                  // markdown link [text](url)
    if (/^(needs source|internal link|image|chart|source)\b/i.test(inner)) continue; // intentional markers
    const looksPlaceholder =
      /\b(insert|company name|brand name|your name|client name|topic here|todo|tbd|xxx+|placeholder|lorem ipsum|add \w+)\b/i.test(inner) ||
      /^[A-Z][A-Za-z]*(\s+[A-Z][A-Za-z]*){0,3}$/.test(inner);      // Title Case template token e.g. "Company Name"
    if (looksPlaceholder && !out.includes(m[0])) out.push(m[0]);
  }
  // Curly-brace variables and the spec's "a AI" tell.
  for (const cm of text.match(/\{\{[^}]{1,60}\}\}|\{[a-z_][a-z0-9_]{1,40}\}/gi) || []) if (!out.includes(cm)) out.push(cm);
  if (/\ba ai\b/i.test(text)) out.push('a AI');
  return out.slice(0, 12);
}

const STAT = /(\$\s?\d[\d,]*(?:\.\d+)?|\b\d{1,3}(?:\.\d+)?\s?%|\b\d{1,3}(?:,\d{3})+\b)/;
const ATTRIBUTION = /\b(according to|source:|study|studies|survey|research|report|analysis|data (from|by)|per\s+[A-Z]|\bfrom\s+[A-Z][a-z]+|\b(19|20)\d{2}\b)/;

// Sentences that carry a real statistic but no attribution cue in the same
// sentence. Heuristic and conservative (only %, currency, or thousands-separated
// numbers count — bare small integers and lone years do not).
function findUnattributedStats(text: string): string[] {
  const clean = text.replace(/```[\s\S]*?```/g, ' ').replace(/\|[^\n]*\|/g, ' '); // skip code + tables
  const sentences = clean.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  for (const s of sentences) {
    if (STAT.test(s) && !ATTRIBUTION.test(s)) out.push(s.slice(0, 160));
    if (out.length >= 6) break;
  }
  return out;
}

function extractNeedsSource(text: string): string[] {
  const out: string[] = [];
  const re = /\[needs source:?\s*([^\]\n]{1,120})\]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1].trim());
  return out.slice(0, 12);
}

function firstEmDashContext(text: string): string | undefined {
  const i = text.indexOf('—');
  if (i < 0) return undefined;
  return text.slice(Math.max(0, i - 40), i + 40).replace(/\s+/g, ' ').trim();
}

/* --------------------------------- LLM pass --------------------------------- */

interface LlmAudit {
  quotesReal: boolean; quotesNote?: string;
  caseStudyOk: boolean; caseStudyNote?: string;
  tradeOffStated: boolean; tradeOffNote?: string;
  hasPointOfView: boolean; povNote?: string;
  genericSentences: string[];
  violations: { rule: string; severity: string; detail: string; evidence?: string }[];
}

const AUDIT_SYSTEM = `You are a strict editorial auditor. You are given a finished blog DRAFT and the REAL first-party data that was actually available to its writer. Your job is to catch honesty violations AND genericness. You do NOT rewrite the draft.

Judge these against the draft and the supplied first-party data:
1. QUOTES: is every quotation attributed to a real, named person with a title or affiliation? Flag any invented, anonymous, or "an expert said" quote.
2. CASE STUDY: does any case study, client story, or named outcome appear that is NOT supported by the supplied first-party data? A fabricated client or invented result is a critical violation.
3. STATISTICS: does any number, percentage, or benchmark appear as fact without a named source (organization plus year)? Flag it unless it is clearly attributed.
4. TRADE-OFF: does the draft state at least one honest limitation, trade-off, or common misconception (not just upside)?
5. POINT OF VIEW: does the draft argue a position somewhere (disagree with common practice, challenge hype, make an underrated case), or is it a neutral explainer that only describes? A draft with no argument anywhere fails this.
6. GENERICNESS (the interchangeability test): list up to 5 sentences that a competitor's guide on the SAME topic could publish word-for-word. These are sentences with no specific stance, no anchored example, no primary-source insight, the kind of filler any generalist article contains. Quote each one.

Rules:
- The writer was told to leave honest "[NEEDS SOURCE: ...]" markers instead of inventing. Those markers are CORRECT. Do not flag them.
- Ground every violation and every generic sentence in an ACTUAL quote from the draft. Never invent one.
- Severity: fabricated quote or case study or outcome number = "critical"; unattributed statistic = "high"; missing point of view = "high"; missing trade-off = "medium"; heavy genericness = "medium".

Return ONLY minified JSON:
{"quotesReal": boolean, "quotesNote": string,
 "caseStudyOk": boolean, "caseStudyNote": string,
 "tradeOffStated": boolean, "tradeOffNote": string,
 "hasPointOfView": boolean, "povNote": string,
 "genericSentences": string[],
 "violations": [{"rule": string, "severity": "critical|high|medium|low", "detail": string, "evidence": string}]}`;

async function llmAudit(text: string, firstParty: string): Promise<LlmAudit> {
  return completeJSON<LlmAudit>(
    AUDIT_SYSTEM,
    JSON.stringify({ availableFirstPartyData: firstParty, draft: text.slice(0, 14000) }),
    { temperature: 0.1, maxTokens: 1400 },
  );
}

function normalizeSeverity(s: string): Severity {
  const v = String(s || '').toLowerCase();
  return v === 'critical' || v === 'high' || v === 'medium' || v === 'low' ? v : 'medium';
}

function scoreFrom(checklist: ChecklistItem[], violations: AuditViolation[]): number {
  let score = 100;
  for (const v of violations) score -= v.severity === 'critical' ? 30 : v.severity === 'high' ? 18 : v.severity === 'medium' ? 8 : 3;
  const failed = checklist.filter((c) => !c.pass).length;
  score -= failed * 2;
  return Math.max(0, Math.min(100, Math.round(score)));
}

/* --------------------------------- resolve --------------------------------- */

async function resolveContent(input: { keyword?: string; content?: string }): Promise<{
  text: string; label: string; projectKey?: string; wordTarget: number | null; firstParty: string;
}> {
  if (input.content && input.content.trim().split(/\s+/).length > 25) {
    return { text: input.content.trim(), label: 'pasted content', wordTarget: null, firstParty: '(none provided)' };
  }
  const kw = (input.keyword || input.content || '').trim();
  if (kw) {
    const project = await loadProject(kw);
    const draft = project?.draft as ContentDraft | undefined;
    if (draft?.markdown) {
      return {
        text: draft.markdown,
        label: draft.title || kw,
        projectKey: project!.key,
        wordTarget: draft.wordTarget ?? null,
        firstParty: (project?.extraInfo || '') || '(none provided)',
      };
    }
  }
  return { text: '', label: '', wordTarget: null, firstParty: '(none provided)' };
}

/* ------------------------------ report blocks ------------------------------ */

/** Reusable audit blocks so runWrite can append them to the draft report. */
export function auditBlocks(r: SelfAuditResult) {
  const blocks = [];
  const verdict = r.passed ? 'PASS' : 'FIX BEFORE PUBLISH';
  blocks.push(b.p(`Self-audit (second pass): ${verdict} · compliance ${r.score}/100. Deterministic checks are measured from the text; content-honesty checks are a flag to verify, not proof.`));

  blocks.push(b.tasks(r.checklist.map((c) => ({
    title: `${c.pass ? '✓' : '✗'} ${c.item}`,
    priority: (c.pass ? 'low' : 'high') as 'low' | 'high',
    detail: `${c.by === 'measured' ? 'measured' : 'model'}${c.note ? ` — ${c.note}` : ''}`,
  }))));

  if (r.violations.length) {
    blocks.push(b.p('Violations to fix:'));
    blocks.push(b.tasks(r.violations.map((v) => ({
      title: v.rule,
      priority: v.severity,
      detail: v.evidence ? `${v.detail}  ↳ "${v.evidence.slice(0, 120)}"` : v.detail,
    }))));
  }

  if (r.genericSentences.length) {
    blocks.push(b.p('Generic sentences a competitor could publish verbatim (rewrite with a stance, an anchored example, or a primary-source insight):'));
    blocks.push(b.list(r.genericSentences.map((s) => `"${s.slice(0, 160)}"`)));
  }

  if (r.needsSourceFlags.length) {
    blocks.push(b.p('Honest [NEEDS SOURCE] markers the writer left (fill with a real source, or cut the claim):'));
    blocks.push(b.list(r.needsSourceFlags));
  }

  return blocks;
}

export function selfAuditReport(label: string, r: SelfAuditResult, projectKey?: string): Report {
  return {
    tag: 'Self-Audit',
    title: `Self-audit — ${label} (${r.passed ? 'pass' : 'fix'}, ${r.score}/100)`,
    blocks: auditBlocks(r),
    data: { key: projectKey },
  };
}
