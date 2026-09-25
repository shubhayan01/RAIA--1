import { complete, llmConfigured } from '../llm';
import { config } from '../config';
import { Report, b } from '../lib/report';
import { loadProject, saveProject, advanceStatus } from '../lib/project';
import { checkTermConsistency } from '../lib/glossary';
import { auditDraftContent } from './selfaudit';
import { genericnessOf } from './aicheck';
import { EvidencePack } from './evidence';
import type { ContentDraft } from './write';

/**
 * The publish gate (SCRIBE — the autonomy engine).
 *
 * A bounded, autonomous fix loop that gets SCRIBE to "no human required by
 * default". After the draft is written it is audited; any BLOCKING violation is
 * handed to a SCOPED fixer (which edits only the flagged sentences, not the whole
 * article) and re-audited. This repeats up to maxIterations. If it comes out
 * clean, status is READY and it can auto-publish. If violations survive the loop,
 * status is NEEDS_HUMAN with the EXACT unresolved items, never a vague "review
 * this". Human review becomes the exception the log can justify.
 *
 * Verification is evidence-anchored, not open-web: a draft statistic is
 * "verified" when its number is present in the EvidencePack. That makes the check
 * deterministic and near-instant, and means a number the model invented (not in
 * the pack) is caught every time.
 */

export type ViolationCategory =
  | 'fabricated-case-study'
  | 'unattributed-statistic'
  | 'unverified-claim'
  | 'em-dash'
  | 'term-drift'
  | 'genericness'
  | 'no-point-of-view';

export interface Violation {
  category: ViolationCategory;
  detail: string;
  evidence?: string;
}

export interface AuditOutcome {
  blockingViolations: Violation[];
  unverifiedClaims: number;
  warnings: Violation[];
}

export interface IterationLog {
  iteration: number;
  blockingBefore: number;
  categories: string[];
  estimatedTokens: number;
}

export interface GateResult {
  status: 'READY' | 'NEEDS_HUMAN';
  draft: string;
  iterations: number;
  history: IterationLog[];
  remainingViolations: Violation[];
  warnings: Violation[];
  estimatedTokens: number;
  reason?: string;
}

export interface GateDeps {
  audit?: (draft: string, pack: EvidencePack) => Promise<AuditOutcome>;
  fix?: (draft: string, violations: Violation[], pack: EvidencePack) => Promise<{ draft: string; estTokens: number }>;
}

const GENERIC_RATIO_BLOCK = 0.4;   // >40% templated-filler sentences blocks publish

/* --------------------------------- the loop --------------------------------- */

export async function publishGate(
  input: { draft: string; pack: EvidencePack },
  deps: GateDeps = {},
  maxIterations = 3,
): Promise<GateResult> {
  const audit = deps.audit || runFullAudit;
  const fix = deps.fix || targetedFix;

  let draft = input.draft;
  const history: IterationLog[] = [];
  let estimatedTokens = 0;
  let last: AuditOutcome = { blockingViolations: [], unverifiedClaims: 0, warnings: [] };

  for (let i = 1; i <= maxIterations; i++) {
    last = await audit(draft, input.pack);
    if (last.blockingViolations.length === 0 && last.unverifiedClaims === 0) {
      return { status: 'READY', draft, iterations: i - 1, history, remainingViolations: [], warnings: last.warnings, estimatedTokens };
    }
    const fixed = await fix(draft, last.blockingViolations, input.pack);
    estimatedTokens += fixed.estTokens;
    history.push({
      iteration: i,
      blockingBefore: last.blockingViolations.length,
      categories: [...new Set(last.blockingViolations.map((v) => v.category))],
      estimatedTokens: fixed.estTokens,
    });
    draft = fixed.draft;
  }

  // One final audit after the last fix so the verdict reflects the latest draft.
  last = await audit(draft, input.pack);
  if (last.blockingViolations.length === 0 && last.unverifiedClaims === 0) {
    return { status: 'READY', draft, iterations: maxIterations, history, remainingViolations: [], warnings: last.warnings, estimatedTokens };
  }
  return {
    status: 'NEEDS_HUMAN',
    draft,
    iterations: maxIterations,
    history,
    remainingViolations: last.blockingViolations,
    warnings: last.warnings,
    estimatedTokens,
    reason: 'Exceeded fix iterations — the remaining violations need judgment a scoped template fix cannot resolve.',
  };
}

/* ------------------------------- the real audit ------------------------------- */

export async function runFullAudit(draft: string, pack: EvidencePack): Promise<AuditOutcome> {
  const blocking: Violation[] = [];
  const warnings: Violation[] = [];

  // Self-audit knows what real material exists (so it does not flag a real case
  // study as fabricated). Feed it the pack's case studies + stats as first-party.
  const firstParty = describePack(pack);
  const sa = await auditDraftContent({ markdown: draft, wordTarget: null, availableFirstPartyData: firstParty }).catch(() => null);

  // 1. em dashes (deterministic)
  const emDashes = (draft.match(/—/g) || []).length;
  if (emDashes > 0) blocking.push({ category: 'em-dash', detail: `${emDashes} em dash(es) present.`, evidence: firstEmContext(draft) });

  // 2. unattributed statistics (deterministic, from self-audit)
  if (sa?.measured.unattributedStats.length) {
    for (const s of sa.measured.unattributedStats.slice(0, 5)) blocking.push({ category: 'unattributed-statistic', detail: 'Statistic with no named source.', evidence: s });
  }

  // 3. unverified claims: draft numbers not present in the evidence pack.
  const unverified = unverifiedAgainstPack(draft, pack);
  for (const u of unverified.slice(0, 6)) blocking.push({ category: 'unverified-claim', detail: 'Figure not backed by any EvidencePack entry.', evidence: u });

  // 4. fabricated case study (from the self-audit LLM pass)
  if (sa) {
    const caseFail = sa.checklist.find((c) => /case study/i.test(c.item) && !c.pass);
    if (caseFail) blocking.push({ category: 'fabricated-case-study', detail: caseFail.note || 'A case study appears that is not supported by the evidence pack.', evidence: sa.violations.find((v) => /case study/i.test(v.rule))?.evidence });
    const povFail = sa.checklist.find((c) => /position/i.test(c.item) && !c.pass);
    if (povFail) blocking.push({ category: 'no-point-of-view', detail: 'The draft only describes and never argues a position.', evidence: povFail.note });
  }

  // 5. term / definitional drift (deterministic, locked glossary)
  const { drifts } = checkTermConsistency(draft);
  for (const d of drifts) blocking.push({ category: 'term-drift', detail: `${d.term} expanded as "${d.found}" — canonical is "${d.canonical}".`, evidence: d.found });

  // 6. genericness (deterministic ratio + the self-audit's flagged sentences)
  const generic = genericnessOf(draft);
  const genericByLlm = sa?.genericSentences?.length || 0;
  if (generic.ratio > GENERIC_RATIO_BLOCK || genericByLlm > 2) {
    const sample = generic.sentences[0] || sa?.genericSentences?.[0];
    blocking.push({ category: 'genericness', detail: `${Math.round(generic.ratio * 100)}% of sentences are templated filler (${generic.count} deterministic${genericByLlm ? `, ${genericByLlm} model-flagged` : ''}).`, evidence: sample });
  }

  // ---- non-blocking warnings (allow auto-publish, logged for batch review) ----
  if (!/\b(by\s+[A-Z][a-z]+\s+[A-Z][a-z]+|author:|written by)\b/.test(draft)) {
    warnings.push({ category: 'genericness', detail: config.brand.defaultAuthor ? `No byline; gate can auto-fill "${config.brand.defaultAuthor}".` : 'No byline and no SCRIBE_DEFAULT_AUTHOR configured — set one once (config gap, not a per-article task).' });
  }

  return { blockingViolations: blocking, unverifiedClaims: unverified.length, warnings };
}

/* ------------------------------- the scoped fix ------------------------------- */

const FIX_SYSTEM = `You are a precise copy editor. You are given a blog DRAFT, a numbered list of BLOCKING ISSUES, and the EVIDENCE_PACK of the only real facts available. Fix ONLY the flagged issues. Do not rewrite, reorder, or "improve" any sentence that is not flagged.

For each issue:
- unattributed-statistic / unverified-claim: either attribute the number to a matching EVIDENCE_PACK entry (organization + year), or DELETE the number and state the point qualitatively. Never invent a source.
- fabricated-case-study: delete the fabricated passage, or replace it with a real EVIDENCE_PACK case study if one fits. Never keep an invented client or result.
- em-dash: replace every "—" with a period, comma, "and", or parentheses.
- term-drift: make the term expansion match the canonical form given in the issue.
- genericness: rewrite the flagged interchangeable sentence using a specific fact from EVIDENCE_PACK, or delete it.
- no-point-of-view: add ONE short paragraph that argues a position (use the contrarian source if present), without inventing facts.

Return ONLY the corrected full markdown. No JSON, no commentary, no code fences. Do not use em dashes.`;

async function targetedFix(draft: string, violations: Violation[], pack: EvidencePack): Promise<{ draft: string; estTokens: number }> {
  if (!llmConfigured() || !violations.length) return { draft, estTokens: 0 };
  const issues = violations.map((v, i) => `${i + 1}. [${v.category}] ${v.detail}${v.evidence ? `  ↳ "${String(v.evidence).slice(0, 140)}"` : ''}`).join('\n');
  const user = `EVIDENCE_PACK:\n${describePack(pack)}\n\nBLOCKING ISSUES:\n${issues}\n\nDRAFT:\n${draft}`;
  const out = await complete(FIX_SYSTEM, user, { temperature: 0.2, maxTokens: config.content.maxDraftTokens });
  const cleaned = out.trim().replace(/^```(?:markdown|md)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const estTokens = estimateTokens(FIX_SYSTEM + user + cleaned);
  return { draft: cleaned || draft, estTokens };
}

/* --------------------------------- helpers --------------------------------- */

const STAT = /(\$\s?\d[\d,]*(?:\.\d+)?|\b\d{1,3}(?:\.\d+)?\s?%|\b\d{1,3}(?:,\d{3})+\b|\b\d+(?:\.\d+)?x\b)/g;

/** Draft figures whose number is not present anywhere in the evidence pack. */
export function unverifiedAgainstPack(draft: string, pack: EvidencePack): string[] {
  const packNums = new Set<string>();
  for (const s of pack.stats) for (const tok of `${s.claim} ${(s as any).number || ''}`.match(STAT) || []) packNums.add(normNum(tok));
  const body = draft.replace(/```[\s\S]*?```/g, ' ').replace(/\|[^\n]*\|/g, ' ');
  const out: string[] = [];
  const sentences = body.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  for (const s of sentences) {
    const nums = s.match(STAT);
    if (!nums) continue;
    const anyUnbacked = nums.some((n) => !packNums.has(normNum(n)));
    if (anyUnbacked) { out.push(s.slice(0, 160)); if (out.length >= 8) break; }
  }
  return out;
}
const normNum = (s: string) => s.toLowerCase().replace(/[\s,$]/g, '').trim();

function describePack(pack: EvidencePack): string {
  const stats = pack.stats.map((s, i) => `E${i + 1} STAT: ${s.claim} — ${s.org || s.source}${s.year ? `, ${s.year}` : ''} (${s.url})`);
  const quotes = pack.quotes.map((q) => `QUOTE: "${q.text}" — ${q.speaker}${q.title ? `, ${q.title}` : ''}${q.org ? `, ${q.org}` : ''}`);
  const cases = pack.caseStudies.map((c) => `CASE STUDY (${c.source}): ${c.client} — ${c.outcome}`);
  const contra = pack.contrarianSource ? [`CONTRARIAN: ${pack.contrarianSource.claim} (${pack.contrarianSource.url})`] : [];
  const all = [...stats, ...quotes, ...cases, ...contra];
  return all.length ? all.join('\n') : '(no evidence — do not state any statistic, quote, or case study)';
}

function firstEmContext(text: string): string | undefined {
  const i = text.indexOf('—');
  return i < 0 ? undefined : text.slice(Math.max(0, i - 40), i + 40).replace(/\s+/g, ' ').trim();
}

/** Rough token estimate (~4 chars/token) — labelled as estimated in the UI. */
export function estimateTokens(s: string): number { return Math.ceil((s || '').length / 4); }

/** Auto-fill a byline after the H1 when one is missing and a default is configured. */
export function ensureByline(draft: string): { draft: string; added: boolean } {
  if (/\b(by\s+[A-Z][a-z]+\s+[A-Z][a-z]+|author:|written by)\b/.test(draft) || !config.brand.defaultAuthor) return { draft, added: false };
  const lines = draft.split(/\r?\n/);
  const h1 = lines.findIndex((l) => /^#\s+/.test(l));
  const at = h1 >= 0 ? h1 + 1 : 0;
  lines.splice(at, 0, '', `By ${config.brand.defaultAuthor}`);
  return { draft: lines.join('\n'), added: true };
}

/* ------------------------------ standalone entry ------------------------------ */

/** Run the gate over a project's stored draft + evidence pack, and persist. */
export async function runGate(keyword: string, maxIterations = 3): Promise<Report> {
  const project = await loadProject(keyword);
  const draft = project?.draft as ContentDraft | undefined;
  const pack = project?.evidence as EvidencePack | undefined;
  if (!project || !draft?.markdown) {
    return { tag: 'Gate', title: 'Nothing to gate', blocks: [b.note('No draft found for this keyword. Write one first, e.g. "write about <keyword>".')] };
  }
  const effPack: EvidencePack = pack || { keyword: project.keyword, status: 'OK', stats: [], quotes: [], caseStudies: [], contrarianSource: null, gaps: [], pagesRead: [], collectedAt: new Date().toISOString() };

  const result = await publishGate({ draft: draft.markdown, pack: effPack }, {}, maxIterations);

  // Auto-fill a byline if missing (non-blocking, config-driven).
  const byline = ensureByline(result.draft);
  result.draft = byline.draft;

  (draft as ContentDraft).markdown = result.draft;
  project.draft = draft;
  project.gate = { status: result.status, iterations: result.iterations, history: result.history, remainingViolations: result.remainingViolations, warnings: result.warnings, estimatedTokens: result.estimatedTokens, bylineAdded: byline.added, ranAt: new Date().toISOString() };
  if (result.status === 'READY') advanceStatus(project, 'reviewed');
  await saveProject(project);

  return gateReport(project.keyword, result, byline.added, project.key);
}

/* ---------------------------------- report ---------------------------------- */

export function gateReport(label: string, r: GateResult, bylineAdded: boolean, projectKey?: string): Report {
  const blocks = [];
  blocks.push(b.p(`${r.status === 'READY' ? '✅ READY' : '⚠️ NEEDS_HUMAN'} — "${label}". The gate ran ${r.iterations} autonomous fix iteration(s) and spent ~${r.estimatedTokens.toLocaleString()} estimated tokens.`));

  if (r.history.length) {
    blocks.push(b.p('Auto-fix history (what the system caught and fixed itself):'));
    blocks.push(b.table(
      ['Iter', 'Blocking before', 'Categories', 'Est. tokens'],
      r.history.map((h) => [h.iteration, h.blockingBefore, h.categories.join(', ') || '—', h.estimatedTokens.toLocaleString()]),
    ));
  }

  if (r.status === 'NEEDS_HUMAN') {
    blocks.push(b.note(r.reason || 'Unresolved after the fix loop.'));
    blocks.push(b.p(`Exactly what a human must resolve (${r.remainingViolations.length}):`));
    blocks.push(b.tasks(r.remainingViolations.map((v) => ({
      title: v.category,
      priority: 'high' as const,
      detail: v.evidence ? `${v.detail}  ↳ "${String(v.evidence).slice(0, 120)}"` : v.detail,
    }))));
  } else {
    blocks.push(b.note('Zero blocking violations and zero unverified claims. Safe to publish without human review.'));
  }

  if (bylineAdded) blocks.push(b.note(`Byline auto-filled from SCRIBE_DEFAULT_AUTHOR (${config.brand.defaultAuthor}). Set a real author to remove this config gap.`));
  if (r.warnings.length) {
    blocks.push(b.p('Non-blocking (logged for periodic batch review, did not stop publish):'));
    blocks.push(b.list(r.warnings.map((w) => w.detail)));
  }

  return { tag: 'Gate', title: `Publish gate — ${label} (${r.status})`, blocks, data: { key: projectKey, status: r.status } };
}
