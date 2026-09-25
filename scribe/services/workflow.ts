import { Report, b } from '../lib/report';
import { config } from '../config';
import { ContentProject, ensureProject, loadProject, saveProject } from '../lib/project';
import { runResearch } from './research';
import { runBrandAnalysis } from './brand';
import { runWrite, ContentDraft } from './write';
import { runFactCheck } from './factcheck';
import { runEeatCheck, EeatResult } from './eeat';
import { collectEvidence, evidenceReport, EvidencePack } from './evidence';
import { runGate } from './gate';
import { domainOf } from '../sources/content';

/**
 * Full content-automation workflow (SCRIBE's flagship) — evidence-first.
 *
 * New pipeline order:
 *   research → brand → competitors → gaps → keywords
 *   → EVIDENCE (hard gate: LOW_EVIDENCE halts here, nothing gets written)
 *   → write (evidence-constrained generation)
 *   → GATE (bounded autonomous fix loop; verifies + repairs, replaces the flat
 *     fact-check / ai-check / self-audit sequence)
 *   → READY (auto-publishable) OR NEEDS_HUMAN (with the exact unresolved items).
 *
 * Analysis stages are best-effort; the evidence stage is a HARD gate by design.
 * The honest-failure principle is preserved and extended to research quality.
 */

export interface WorkflowInput {
  keyword: string;
  siteUrl?: string;
  extraInfo?: string;
  eeatParams?: string;
}

interface StepRec { name: string; ok: boolean; warn?: string; note?: string }

export async function runWorkflow(input: WorkflowInput): Promise<Report> {
  const kw = (input.keyword || '').trim();
  if (!kw) return { tag: 'Workflow', title: 'No keyword', blocks: [b.note('Give me a keyword and your site URL to run the full content workflow.')] };

  await ensureProject(kw, input.siteUrl, input.extraInfo);
  const opts = { siteUrl: input.siteUrl, extraInfo: input.extraInfo };
  const steps: StepRec[] = [];

  const step = async (name: string, fn: () => Promise<unknown>) => {
    try { await fn(); steps.push({ name, ok: true }); }
    catch (e: any) { steps.push({ name, ok: false, note: String(e?.message || e).slice(0, 120) }); }
  };

  // 1. Real research: search the keyword, fetch the top-ranking blogs, measure them.
  await step('Keyword research (top blogs)', () => runResearch(kw, opts));
  // 2. Brand: fetch the user's own site and extract its voice / vision / positioning.
  if (input.siteUrl) await step('Brand voice & vision', () => runBrandAnalysis(input.siteUrl!, kw));

  // ---- 3. EVIDENCE: mine the real fetched pages (one combined "consume" call) ----
  let project = await loadProject(kw);
  if (!project) return { tag: 'Workflow', title: 'Workflow failed', blocks: [b.note('The project could not be created.')] };
  const pack = await collectEvidence(project);
  project.evidence = pack;
  await saveProject(project);
  steps.push({
    name: 'Evidence',
    ok: pack.status !== 'LOW_EVIDENCE',
    warn: pack.status === 'NO_SEARCH' ? 'search unavailable — wrote number-free'
      : pack.mode === 'number-light' ? `thin stats — auto-researched ${pack.digest?.length || 0} insight(s), wrote number-light` : undefined,
    note: pack.status === 'LOW_EVIDENCE' ? pack.note : undefined,
  });

  if (pack.status === 'LOW_EVIDENCE') {
    const rep = evidenceReport(pack, project.key);
    rep.blocks.unshift(b.note(`Workflow halted at the evidence gate for "${kw}". Nothing was written, so nothing was fabricated. This is the honest-failure principle applied to research QUALITY, not just availability.`));
    rep.blocks.unshift(...stepBlocks(steps));
    return { ...rep, tag: 'Workflow', title: `Content workflow — ${kw} (HALTED: LOW_EVIDENCE)`, data: { key: project.key, keyword: kw, halted: true } };
  }

  // ---- 4. WRITE the blog (deep, consuming brand + real evidence) ----
  // The LLM's job: write and structure over the gathered info. runWrite gates
  // internally by default; we pass gate:false and run the fuller gate step next.
  await step('Write blog (deep)', () => runWrite(kw, { ...opts, gate: false }));
  // ---- 5. FIX: the autonomous publish gate repairs fabrication + house-style ----
  await step('Publish gate (auto-fix)', () => runGate(kw, config.content.gateIterations + 1));
  // ---- 6. FACT-CHECK the finished draft against live sources ----
  await step('Fact-check', () => runFactCheck({ keyword: kw }));
  // ---- 7. E-E-A-T score ----
  await step('E-E-A-T', () => runEeatCheck({ keyword: kw, params: input.eeatParams }));

  project = await loadProject(kw);
  return workflowReport(project, steps);
}

/* ---------------------------------- report ---------------------------------- */

function stepBlocks(steps: StepRec[]) {
  return [b.tasks(steps.map((s) => ({
    title: s.name,
    priority: (!s.ok ? 'high' : s.warn ? 'medium' : 'low') as 'high' | 'medium' | 'low',
    detail: !s.ok ? `stopped — ${s.note || 'error'}` : s.warn ? `done, but ${s.warn}` : 'done',
  })))];
}

function workflowReport(project: ContentProject | null, steps: StepRec[]): Report {
  if (!project) return { tag: 'Workflow', title: 'Workflow failed', blocks: [b.note('The project could not be loaded after the run.')] };

  const draft = project.draft as ContentDraft | undefined;
  const pack = project.evidence as EvidencePack | undefined;
  const eeat = project.eeat as EeatResult | undefined;
  const gate = project.gate as GateSummary | undefined;

  const blocks = [];
  const badge = gate?.status === 'READY' ? '✅ READY' : gate?.status === 'NEEDS_HUMAN' ? '⚠️ NEEDS_HUMAN' : '—';
  blocks.push(b.p(`Full content workflow for "${project.keyword}"${project.siteUrl ? ` · ${domainOf(project.siteUrl)}` : ''}. Final status: ${badge}.`));

  blocks.push(...stepBlocks(steps));

  blocks.push(b.note(gate?.status === 'READY'
    ? 'READY — zero blocking violations and zero unverified claims after the gate. Safe to publish without human review.'
    : gate?.status === 'NEEDS_HUMAN'
      ? 'NEEDS_HUMAN — the gate could not clear every blocking violation autonomously. The exact unresolved items are listed below. Nothing here says "done" unless it means verified-and-safe.'
      : 'Gate did not run.'));

  // Evidence sourcing, so a reviewer can spot-check in seconds.
  if (pack) {
    blocks.push(b.kv([
      { k: 'Evidence status', v: pack.status },
      { k: 'Verified stats used', v: `${pack.stats.length} available · draft cited ${draft?.evidenceIdsUsed?.length || 0}` },
      { k: 'Named quotes', v: String(pack.quotes.length) },
      { k: 'Case studies (internal)', v: String(pack.caseStudies.length) },
      { k: 'Contrarian anchor', v: pack.contrarianSource ? 'yes' : 'open-question framing' },
    ]));
    if (pack.stats.length) {
      blocks.push(b.p('Evidence the draft was allowed to cite (spot-check sourcing here):'));
      blocks.push(b.table(['Claim', 'Org', 'Year', 'Source'], pack.stats.slice(0, 8).map((s) => [s.claim.slice(0, 60), s.org || '—', s.year || '—', domainOf(s.url)])));
    }
  }

  // Gate loop history — the trust log of the system catching its own mistakes.
  blocks.push(b.kv([
    { k: 'Gate result', v: gate ? gate.status : '—' },
    { k: 'Auto-fix iterations', v: gate ? String(gate.iterations) : '—' },
    { k: 'Est. tokens (gate)', v: gate ? `~${gate.estimatedTokens.toLocaleString()}` : '—' },
    { k: 'E-E-A-T (non-blocking)', v: eeat ? `${eeat.overall}/100` : '—' },
    { k: 'Draft length', v: draft ? `${draft.wordCount.toLocaleString()} words` : 'not generated' },
  ]));
  if (gate?.history?.length) {
    blocks.push(b.p('Gate auto-fix log (what the system fixed itself):'));
    blocks.push(b.table(['Iter', 'Blocking before', 'Categories', 'Est. tokens'],
      gate.history.map((h) => [h.iteration, h.blockingBefore, h.categories.join(', ') || '—', h.estimatedTokens.toLocaleString()])));
  }

  if (draft) {
    blocks.push(b.kv([{ k: 'Title', v: draft.title }, { k: 'Meta description', v: draft.metaDescription || '—' }, { k: 'Slug', v: draft.slug }]));
    blocks.push(b.note(draft.markdown));
  }

  if (gate?.status === 'NEEDS_HUMAN' && gate.remainingViolations?.length) {
    blocks.push(b.p(`Exactly what a human must resolve (${gate.remainingViolations.length}) — not a vague "review this":`));
    blocks.push(b.tasks(gate.remainingViolations.map((v) => ({ title: v.category, priority: 'high' as const, detail: v.evidence ? `${v.detail}  ↳ "${String(v.evidence).slice(0, 120)}"` : v.detail }))));
  }
  if (gate?.warnings?.length) {
    blocks.push(b.p('Non-blocking (logged for periodic batch review):'));
    blocks.push(b.list(gate.warnings.map((w) => w.detail)));
  }

  return { tag: 'Workflow', title: `Content workflow — ${project.keyword} (${gate?.status || 'done'})`, blocks, data: { key: project.key, keyword: project.keyword, hasDraft: !!draft, status: gate?.status } };
}

interface GateSummary {
  status: 'READY' | 'NEEDS_HUMAN';
  iterations: number;
  estimatedTokens: number;
  history: { iteration: number; blockingBefore: number; categories: string[]; estimatedTokens: number }[];
  remainingViolations: { category: string; detail: string; evidence?: string }[];
  warnings: { category: string; detail: string }[];
}
