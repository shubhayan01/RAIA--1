import { serp } from '../sources/serp';
import { complete, completeJSON, llmConfigured } from '../llm';
import { pool } from '../lib/concurrency';
import { config } from '../config';
import { Report, b } from '../lib/report';
import { loadProject, saveProject } from '../lib/project';
import { ContentDraft } from './write';

/**
 * Fact-check (SCRIBE Feature 6 — also available standalone).
 *
 * 1. The LLM EXTRACTS the checkable factual claims from the content (numbers,
 *    dates, named facts) — it structures the text, it does not judge truth yet.
 * 2. Each claim is searched on the REAL web (SERP). The verdict is formed by the
 *    LLM reading the REAL search snippets — so "supported / contradicted /
 *    unverified" is grounded in live sources, never in the model's memory.
 * 3. Optionally, the content is corrected to match what the sources actually say.
 */

export interface ClaimCheck {
  claim: string;
  verdict: 'supported' | 'contradicted' | 'unverified' | string;
  confidence: number;
  correction: string;      // '' when no change needed
  sources: string[];
}

export interface FactCheckResult {
  claimsChecked: number;
  supported: number;
  contradicted: number;
  unverified: number;
  checks: ClaimCheck[];
  correctedMarkdown?: string;   // present when corrections were applied
  checkedAt: string;
}

/** Resolve the text to check: a project draft, or pasted content. */
export async function runFactCheck(input: { keyword?: string; content?: string; correct?: boolean }): Promise<Report> {
  const { text, label, projectKey } = await resolveContent(input);
  if (!text) {
    return { tag: 'Fact Check', title: 'Nothing to check', blocks: [b.note('Paste the content to fact-check, or give me a keyword whose draft I should check, e.g. "fact-check running-shoes".')] };
  }
  if (!llmConfigured()) {
    return { tag: 'Fact Check', title: 'LLM required', blocks: [b.note('Add an LLM key — fact-checking extracts claims and reads live search results to verify them.')] };
  }

  const claims = await extractClaims(text);
  if (!claims.length) {
    return { tag: 'Fact Check', title: `Fact check — ${label}`, blocks: [b.p('No hard factual claims (numbers, dates, named facts) were found to verify. Opinion and general guidance need no source check.')] };
  }

  const capped = claims.slice(0, config.content.factcheckMaxClaims);
  const checks = await pool(capped, 3, (c) => verifyClaim(c));

  const result: FactCheckResult = {
    claimsChecked: checks.length,
    supported: checks.filter((c) => c.verdict === 'supported').length,
    contradicted: checks.filter((c) => c.verdict === 'contradicted').length,
    unverified: checks.filter((c) => c.verdict === 'unverified').length,
    checks,
    checkedAt: new Date().toISOString(),
  };

  // Optionally correct the content to match the sources.
  if (input.correct && (result.contradicted > 0)) {
    result.correctedMarkdown = await applyCorrections(text, checks).catch(() => undefined);
  }

  // Persist onto the project when we checked a stored draft.
  if (projectKey) {
    const project = await loadProject(projectKey);
    if (project) {
      project.factcheck = result;
      if (result.correctedMarkdown && project.draft) {
        (project.draft as ContentDraft).markdown = result.correctedMarkdown;
      }
      await saveProject(project);
    }
  }

  return factCheckReport(label, result, projectKey);
}

async function resolveContent(input: { keyword?: string; content?: string }): Promise<{ text: string; label: string; projectKey?: string }> {
  if (input.content && input.content.trim().length > 40 && !looksLikeKeyword(input.content)) {
    return { text: input.content.trim(), label: 'pasted content' };
  }
  const kw = (input.keyword || input.content || '').trim();
  if (kw) {
    const project = await loadProject(kw);
    const draft = project?.draft as ContentDraft | undefined;
    if (draft?.markdown) return { text: draft.markdown, label: draft.title || kw, projectKey: project!.key };
  }
  return { text: '', label: '' };
}

function looksLikeKeyword(s: string): boolean {
  return s.trim().split(/\s+/).length <= 8 && !/[.!?]\s/.test(s);
}

const EXTRACT_SYSTEM = `Extract the checkable factual claims from the text — statements that could be verified against a source: statistics, percentages, dates, quantities, named studies, historical facts, product specs, superlatives ("the largest", "the first").

Ignore opinions, general advice, and hedged statements.

Return ONLY minified JSON: {"claims": string[]}  // each a single self-contained factual assertion, max 12.`;

async function extractClaims(text: string): Promise<string[]> {
  try {
    const r = await completeJSON<{ claims: string[] }>(EXTRACT_SYSTEM, text.slice(0, 14000), { temperature: 0, maxTokens: 1000 });
    return (r.claims || []).map((c) => c.trim()).filter(Boolean);
  } catch { return []; }
}

const VERIFY_SYSTEM = `You verify one factual claim using ONLY the real search results provided (titles + snippets from live web search). Do not use prior knowledge — judge solely from the snippets.

Return ONLY minified JSON:
{"verdict": "supported|contradicted|unverified",
 "confidence": number,      // 0-1
 "correction": string}      // if contradicted, the corrected statement per the sources; else ""

Rules:
- "supported" only if a snippet clearly backs the claim.
- "contradicted" if a snippet clearly conflicts — put the accurate version in "correction".
- "unverified" if the snippets don't settle it. Never guess.`;

async function verifyClaim(claim: string): Promise<ClaimCheck> {
  const resp = await serp(claim, 5).catch(() => null);
  const results = resp?.results || [];
  const sources = results.slice(0, 3).map((r) => r.url);
  if (!results.length) {
    return { claim, verdict: 'unverified', confidence: 0, correction: '', sources };
  }
  try {
    const evidence = results.slice(0, 5).map((r, i) => `[${i + 1}] ${r.title} — ${r.snippet} (${r.domain})`).join('\n');
    const v = await completeJSON<Omit<ClaimCheck, 'claim' | 'sources'>>(
      VERIFY_SYSTEM, `CLAIM: ${claim}\n\nSEARCH RESULTS:\n${evidence}`, { temperature: 0, maxTokens: 500 },
    );
    return { claim, verdict: v.verdict || 'unverified', confidence: clamp01(v.confidence), correction: v.correction || '', sources };
  } catch {
    return { claim, verdict: 'unverified', confidence: 0, correction: '', sources };
  }
}

const CORRECT_SYSTEM = `You are a copy editor. You are given an article in markdown and a list of factual corrections (each: the original claim and the corrected statement per live sources). Apply ONLY these corrections, changing as little else as possible. Preserve all formatting, headings and voice.

Return ONLY the corrected markdown (no JSON, no commentary).`;

async function applyCorrections(markdown: string, checks: ClaimCheck[]): Promise<string | undefined> {
  const fixes = checks.filter((c) => c.verdict === 'contradicted' && c.correction);
  if (!fixes.length) return undefined;
  const list = fixes.map((f, i) => `${i + 1}. WRONG: ${f.claim}\n   RIGHT: ${f.correction}`).join('\n');
  const out = await complete(CORRECT_SYSTEM, `ARTICLE:\n${markdown}\n\nCORRECTIONS:\n${list}`, { temperature: 0.2, maxTokens: 6000 });
  return out.trim();
}

const clamp01 = (n: any) => { const x = Number(n); return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0; };

/* ------------------------------ report ------------------------------ */

export function factCheckReport(label: string, r: FactCheckResult, projectKey?: string): Report {
  const blocks = [];
  blocks.push(b.p(`Fact-checked ${r.claimsChecked} claim${r.claimsChecked === 1 ? '' : 's'} in ${label} against live search results.`));
  blocks.push(b.kv([
    { k: 'Supported', v: String(r.supported) },
    { k: 'Contradicted', v: String(r.contradicted) },
    { k: 'Unverified', v: String(r.unverified) },
  ]));

  blocks.push(b.tasks(r.checks.map((c) => ({
    title: c.claim,
    priority: (c.verdict === 'contradicted' ? 'critical' : c.verdict === 'unverified' ? 'medium' : 'low') as 'critical' | 'medium' | 'low',
    detail: c.verdict === 'contradicted'
      ? `Contradicted — fix: ${c.correction}${c.sources[0] ? ` · ${c.sources[0]}` : ''}`
      : c.verdict === 'unverified'
        ? 'No source clearly confirmed this — add a citation or soften the claim.'
        : `Supported (${Math.round(c.confidence * 100)}%)${c.sources[0] ? ` · ${c.sources[0]}` : ''}`,
  }))));

  if (r.correctedMarkdown) {
    blocks.push(b.note('A corrected version was applied to the draft (contradicted claims fixed to match the sources).'));
  } else if (r.contradicted > 0) {
    blocks.push(b.note('Run with correction enabled to auto-apply the fixes to the draft, or edit manually using the corrections above.'));
  }

  return { tag: 'Fact Check', title: `Fact check — ${label}`, blocks, data: { key: projectKey, corrected: !!r.correctedMarkdown } };
}
