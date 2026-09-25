import { config } from '../config';
import { gscQuery, gscConfigured, comparativeWindows } from '../sources/google';
import { runBrief, BriefData } from './brief';
import { pushBriefToWordPress, wordpressConfigured } from './cms';
import { dataPath, safeDomainKey, readJson, writeJson } from '../lib/jsonStore';
import { Report, b } from '../lib/report';

/**
 * Automated GSC Opportunity Loop (Feature 5).
 *
 * Detects striking-distance keywords in Search Console (position 4-20, high
 * impressions), generates a REWRITE brief for the page already ranking for each
 * (reusing FIX 4's existingPageUrl path), and — when enabled — queues each brief
 * as a WordPress draft. A passive data insight becomes an actionable content task
 * with zero manual steps.
 */

const MAX_KEYWORDS = 10;    // cap per run to control SERP + LLM + WP cost
const TARGET_POSITION = 3;  // "what if this ranked #3" — the opportunity ceiling

interface OppCandidate {
  keyword: string;
  landingPage: string;
  position: number;
  impressions: number;
  ctr: number;
  estimatedTrafficOpportunity: number;
  briefTitle?: string;
  briefGenerated: boolean;
  wpDraftUrl?: string;
  wpEditUrl?: string;
  error?: string;
}

interface OppRun {
  ranAt: string;
  domain: string;
  days: number;
  autoPublish: boolean;
  keywordsAnalyzed: number;
  briefsGenerated: number;
  wpDraftsCreated: number;
  totalTrafficOpportunity: number;
  candidates: OppCandidate[];
}

export function opportunityDomain(): string {
  return safeDomainKey(gscDomain());
}

function gscDomain(): string {
  const s = config.google.gscSiteUrl || '';
  if (s.startsWith('sc-domain:')) return s.slice('sc-domain:'.length);
  return s.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

/** Standard organic CTR-by-position curve (approx., desktop+mobile blended). */
function ctrForPosition(pos: number): number {
  const curve: Record<number, number> = {
    1: 0.28, 2: 0.155, 3: 0.10, 4: 0.07, 5: 0.05,
    6: 0.04, 7: 0.032, 8: 0.026, 9: 0.022, 10: 0.019,
  };
  if (pos <= 1) return curve[1];
  if (pos >= 20) return 0.008;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  const a = curve[lo] ?? 0.012, c = curve[hi] ?? 0.012;
  return lo === hi ? a : a + (c - a) * (pos - lo);
}

export async function runOpportunityLoop(input: { days?: number; autoPublish?: boolean } = {}): Promise<Report> {
  const days = input.days || 28;
  const autoPublish = !!input.autoPublish;

  if (!gscConfigured()) {
    return {
      tag: 'Opportunity Loop',
      title: 'Connect Google Search Console first',
      blocks: [
        b.p('The opportunity loop reads striking-distance keywords straight from your Search Console — it is not connected yet.'),
        b.note('Set GSC_SITE_URL and a Google token (GOOGLE_ACCESS_TOKEN or the refresh-token trio) in .env, then run “find quick wins” again.'),
      ],
    };
  }

  const domain = opportunityDomain();
  const win = comparativeWindows(days).current;

  // One GSC pull gives us query + landing page + position + impressions together.
  let rows: { keys: string[]; impressions: number; ctr: number; position: number }[] = [];
  try {
    rows = await gscQuery({ ...win, dimensions: ['query', 'page'], rowLimit: 1000 });
  } catch (e: any) {
    return { tag: 'Opportunity Loop', title: 'Search Console query failed', blocks: [b.note(String(e?.message || e))] };
  }

  // Striking distance: position 4-20, impressions over the configured threshold.
  const minImp = config.opportunity.minImpressions;
  const byKeyword = new Map<string, { keyword: string; landingPage: string; position: number; impressions: number; ctr: number }>();
  for (const r of rows) {
    if (r.position < 4 || r.position > 20 || r.impressions <= minImp) continue;
    const keyword = r.keys[0];
    const landingPage = r.keys[1];
    const prev = byKeyword.get(keyword);
    if (!prev || r.impressions > prev.impressions) {
      byKeyword.set(keyword, { keyword, landingPage, position: r.position, impressions: r.impressions, ctr: r.ctr });
    }
  }

  const shortlist = [...byKeyword.values()].sort((a, c) => c.impressions - a.impressions).slice(0, MAX_KEYWORDS);

  if (!shortlist.length) {
    return {
      tag: 'Opportunity Loop',
      title: `No striking-distance opportunities — ${domain}`,
      blocks: [b.p(`No keywords sit in positions 4-20 with more than ${minImp} impressions in the last ${days} days. Lower OPPORTUNITY_MIN_IMPRESSIONS to widen the net.`)],
    };
  }

  const wpReady = wordpressConfigured();
  const candidates: OppCandidate[] = [];

  for (const s of shortlist) {
    const opportunity = Math.max(0, ctrForPosition(TARGET_POSITION) - ctrForPosition(s.position)) * s.impressions;
    const cand: OppCandidate = {
      keyword: s.keyword,
      landingPage: s.landingPage,
      position: Number(s.position.toFixed(1)),
      impressions: s.impressions,
      ctr: s.ctr,
      estimatedTrafficOpportunity: Math.round(opportunity),
      briefGenerated: false,
    };

    try {
      // Rewrite brief for the page already ranking (FIX 4 path).
      const briefReport = await runBrief({ primaryKeyword: s.keyword, existingPageUrl: s.landingPage });
      const brief = briefReport.data as BriefData | undefined;
      if (brief && Array.isArray(brief.structure) && brief.structure.length) {
        cand.briefGenerated = true;
        cand.briefTitle = brief.titleRecommended || brief.primaryKeyword;

        if (autoPublish && wpReady) {
          const push = await pushBriefToWordPress(brief, undefined, ['SAGE Opportunity', 'striking-distance']);
          if (push.ok) { cand.wpDraftUrl = push.link; cand.wpEditUrl = push.editLink; }
          else cand.error = `WP push: ${push.error}`;
        }
      } else {
        cand.error = 'brief could not be generated (SERP/LLM unavailable)';
      }
    } catch (e: any) {
      cand.error = String(e?.message || e);
    }
    candidates.push(cand);
  }

  const run: OppRun = {
    ranAt: new Date().toISOString(),
    domain,
    days,
    autoPublish,
    keywordsAnalyzed: candidates.length,
    briefsGenerated: candidates.filter((c) => c.briefGenerated).length,
    wpDraftsCreated: candidates.filter((c) => c.wpDraftUrl).length,
    totalTrafficOpportunity: candidates.reduce((s, c) => s + c.estimatedTrafficOpportunity, 0),
    candidates,
  };

  await storeRun(domain, run);
  return toReport(run, { wpReady, autoPublish });
}

/* -------------------------------- Storage ------------------------------- */

function historyPath(domain: string): string {
  return dataPath('opportunities', `${safeDomainKey(domain)}.json`);
}

async function storeRun(domain: string, run: OppRun): Promise<void> {
  const file = historyPath(domain);
  const existing = await readJson<{ domain: string; runs: OppRun[] }>(file, { domain, runs: [] });
  existing.domain = domain;
  existing.runs.unshift(run);
  existing.runs = existing.runs.slice(0, 50); // keep the last 50 runs
  await writeJson(file, existing);
}

export async function opportunityHistory(domain: string): Promise<any> {
  const file = historyPath(domain || opportunityDomain());
  return readJson<{ domain: string; runs: OppRun[] }>(file, { domain: safeDomainKey(domain), runs: [] });
}

/* -------------------------------- Report -------------------------------- */

function toReport(run: OppRun, ctx: { wpReady: boolean; autoPublish: boolean }): Report {
  const blocks = [
    b.p(`Scanned Search Console for ${run.domain} over the last ${run.days} days and found ${run.keywordsAnalyzed} striking-distance keyword${run.keywordsAnalyzed === 1 ? '' : 's'} (position 4-20, >${config.opportunity.minImpressions} impressions).`),
    b.kv([
      { k: 'Keywords analyzed', v: String(run.keywordsAnalyzed) },
      { k: 'Rewrite briefs generated', v: String(run.briefsGenerated) },
      { k: 'WordPress drafts created', v: run.autoPublish ? String(run.wpDraftsCreated) : 'off (autoPublish=false)' },
      { k: 'Est. monthly traffic opportunity', v: `~${run.totalTrafficOpportunity.toLocaleString('en-US')} clicks` },
    ]),
  ];

  blocks.push(b.table(
    ['Keyword', 'Pos', 'Impr', 'Est. opp.', 'Brief', 'WP draft'],
    run.candidates.map((c) => [
      c.keyword,
      c.position,
      c.impressions.toLocaleString('en-US'),
      `~${c.estimatedTrafficOpportunity.toLocaleString('en-US')}`,
      c.briefGenerated ? '✓' : (c.error ? '✗' : '—'),
      c.wpDraftUrl ? 'draft' : (c.error && /WP push/.test(c.error) ? 'failed' : '—'),
    ]),
  ));

  const wpLinks = run.candidates.filter((c) => c.wpEditUrl).map((c) => `${c.keyword}: ${c.wpEditUrl}`);
  if (wpLinks.length) { blocks.push(b.p('WordPress drafts (open in the editor):')); blocks.push(b.list(wpLinks)); }

  const errs = run.candidates.filter((c) => c.error).map((c) => `${c.keyword}: ${c.error}`);
  if (errs.length) { blocks.push(b.p('Skipped / partial:')); blocks.push(b.list(errs.slice(0, 10))); }

  if (!ctx.autoPublish && ctx.wpReady) {
    blocks.push(b.note('Briefs were generated but not published. Re-run with autoPublish=true (or “run opportunity loop and publish”) to queue them as WordPress drafts.'));
  } else if (!ctx.wpReady) {
    blocks.push(b.note('Connect WordPress (WP_URL / WP_USERNAME / WP_APP_PASSWORD) to auto-queue these briefs as drafts.'));
  }
  blocks.push(b.note('Traffic opportunity = impressions × (CTR at position 3 − CTR at current position), using a standard organic CTR curve. Directional, not a guarantee.'));

  return { tag: 'Opportunity Loop', title: `Quick wins — ${run.domain}`, blocks, data: run };
}
