/**
 * Acceptance tests for the zero-hallucination pipeline (PART 5).
 *
 * These cover the DETERMINISTIC guarantees — the parts that must hold without a
 * live LLM or SERP: the evidence halt boundary, the autonomous gate loop's
 * behaviour (auto-fix to READY vs. escalate to NEEDS_HUMAN), evidence-anchored
 * claim verification, locked-glossary term consistency, deterministic
 * genericness, and per-iteration token accounting. The gate loop is exercised
 * with INJECTED audit/fix functions so it is fully deterministic.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { isLowEvidence, MIN_STATS, EvidencePack } from '../services/evidence';
import { publishGate, runFullAudit, unverifiedAgainstPack, estimateTokens, AuditOutcome, Violation } from '../services/gate';
import { checkTermConsistency } from '../lib/glossary';
import { genericnessOf } from '../services/aicheck';

let passed = 0;
const tests: { name: string; fn: () => void | Promise<void> }[] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push({ name, fn });

const emptyPack = (over: Partial<EvidencePack> = {}): EvidencePack => ({
  keyword: 'x', status: 'OK', stats: [], quotes: [], caseStudies: [],
  contrarianSource: null, gaps: [], pagesRead: [], collectedAt: '', ...over,
});

/* 1. Zero real evidence → halt boundary; write is never reached, nothing fabricated. */
test('1. evidence halt: <MIN_STATS verified stats is LOW_EVIDENCE', () => {
  assert.equal(MIN_STATS, 3);
  assert.equal(isLowEvidence(0), true);
  assert.equal(isLowEvidence(2), true);
  assert.equal(isLowEvidence(3), false);
  // A draft number with an empty pack is always unverified — proof nothing slips.
  const flagged = unverifiedAgainstPack('Adoption rose 42% last year.', emptyPack());
  assert.equal(flagged.length, 1);
});

/* 2. Model invents a case study → gate catches it, fixes it, publishes clean. Zero humans. */
test('2. gate auto-fixes a fabricated case study to READY with no human', async () => {
  let call = 0;
  const audit = async (): Promise<AuditOutcome> => {
    call++;
    // First audit: one blocking fabricated case study. After the fix: clean.
    return call === 1
      ? { blockingViolations: [{ category: 'fabricated-case-study', detail: 'Invented client' }], unverifiedClaims: 0, warnings: [] }
      : { blockingViolations: [], unverifiedClaims: 0, warnings: [] };
  };
  const fix = async (draft: string) => ({ draft: draft + ' [fixed]', estTokens: 1200 });
  const res = await publishGate({ draft: 'A client Acme saw a 7% lift.', pack: emptyPack() }, { audit, fix }, 3);
  assert.equal(res.status, 'READY');
  assert.equal(res.iterations, 1);
  assert.equal(res.history.length, 1);
  assert.equal(res.remainingViolations.length, 0);
  assert.ok(res.estimatedTokens >= 1200);
});

/* 3. 5 unresolvable generic sentences after 3 iterations → NEEDS_HUMAN with the exact items. */
test('3. gate escalates to NEEDS_HUMAN with the exact unresolved violations', async () => {
  const five: Violation[] = Array.from({ length: 5 }, (_, i) => ({ category: 'genericness', detail: `generic sentence ${i + 1}`, evidence: `sentence ${i + 1}` }));
  const audit = async (): Promise<AuditOutcome> => ({ blockingViolations: five, unverifiedClaims: 0, warnings: [] });
  const fix = async (draft: string) => ({ draft, estTokens: 500 }); // fix fails to resolve
  const res = await publishGate({ draft: 'generic draft', pack: emptyPack() }, { audit, fix }, 3);
  assert.equal(res.status, 'NEEDS_HUMAN');
  assert.equal(res.iterations, 3);
  assert.equal(res.remainingViolations.length, 5);
  assert.ok(/exceeded fix iterations/i.test(res.reason || ''));
  assert.equal(res.history.length, 3);
});

/* 4. Term consistency is DETERMINISTIC across runs, not luck. */
test('4. glossary term consistency is deterministic and canonical-locked', () => {
  const good = 'GEO (Generative Engine Optimization) matters. Later, GEO still means Generative Engine Optimization.';
  const bad = 'GEO (Generative Engine Optimization) here, but GEO (Geographic Engine Optimization) there.';
  const wrong = 'We use AEO (Answer Enhancement Optimization) everywhere.';
  // Two runs on the same draft → identical result (deterministic).
  const r1 = checkTermConsistency(good), r2 = checkTermConsistency(good);
  assert.deepEqual(r1.drifts, r2.drifts);
  assert.equal(r1.drifts.length, 0);
  // Internal inconsistency and canonical mismatch both caught.
  assert.ok(checkTermConsistency(bad).drifts.some((d) => d.term === 'GEO'));
  assert.ok(checkTermConsistency(wrong).drifts.some((d) => d.term === 'AEO'));
});

/* 5. Token spend is logged per gate iteration (a sellable, transparent metric). */
test('5. gate logs estimated token spend per iteration', async () => {
  const audit = async (): Promise<AuditOutcome> => ({ blockingViolations: [{ category: 'em-dash', detail: 'x' }], unverifiedClaims: 0, warnings: [] });
  const fix = async (draft: string) => ({ draft, estTokens: 800 });
  const res = await publishGate({ draft: 'd', pack: emptyPack() }, { audit, fix }, 2);
  assert.equal(res.estimatedTokens, 1600);
  assert.ok(res.history.every((h) => h.estimatedTokens === 800));
  assert.ok(estimateTokens('four') >= 1);
});

/* Extra: evidence-anchored verification distinguishes backed vs. invented numbers. */
test('6. unverifiedAgainstPack: pack-backed numbers pass, invented ones flag', () => {
  const pack = emptyPack({ stats: [{ claim: 'Adoption reached 42% in 2026', source: 'x.com', org: 'X', year: 2026, url: 'https://x.com', verified: true } as any] });
  assert.equal(unverifiedAgainstPack('Adoption reached 42% in 2026.', pack).length, 0);
  assert.equal(unverifiedAgainstPack('Costs fell 63% overnight.', pack).length, 1);
});

/* Extra: deterministic genericness flags filler, spares specific sentences. */
test('7. genericnessOf flags interchangeable filler, not specific sentences', () => {
  const generic = 'Content marketing is very important for any business that wants to grow over time.';
  const specific = 'HubSpot reported 42% adoption among the 1,400 marketers it surveyed in 2026.';
  assert.ok(genericnessOf(generic).count >= 1);
  assert.equal(genericnessOf(specific).count, 0);
});

/* Extra: runFullAudit (real, no injection) catches an em dash deterministically. */
test('8. runFullAudit flags an em dash without any model call', async () => {
  const out = await runFullAudit('A short line — with an em dash.', emptyPack());
  assert.ok(out.blockingViolations.some((v) => v.category === 'em-dash'));
});

/* ------------------------------- runner ------------------------------- */
(async () => {
  for (const t of tests) {
    try { await t.fn(); passed++; console.log(`  ok  ${t.name}`); }
    catch (e: any) { console.error(`FAIL  ${t.name}\n      ${e?.message || e}`); }
  }
  const total = tests.length;
  console.log(`\n${passed}/${total} passed`);
  process.exit(passed === total ? 0 : 1);
})();
