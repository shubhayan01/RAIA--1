import {
  gscQuery, ga4Report, gscConfigured, ga4Configured, comparativeWindows, GscRow, Ga4Metric,
} from '../sources/google';
import { completeJSON, llmConfigured } from '../llm';
import { config } from '../config';
import { seoptimerEnabled, seoptimerReport, profileOf } from '../sources/seoptimer';
import { Report, b } from '../lib/report';

/**
 * SEO Intelligence & Reporting — ONE agent over GSC + GA4 (+ GSC position as
 * rank source). Performance -> detection -> opportunity detection -> analysis -> report.
 */
export async function runIntelligence(input: { days?: number } = {}): Promise<Report> {
  const days = input.days || 28;

  if (!gscConfigured() && !ga4Configured()) {
    const blocks = [
      b.p('SEO Intelligence merges Google Search Console + GA4 into one signal. Neither is connected yet.'),
    ];

    // Fallback: a clearly-labeled THIRD-PARTY estimate from SEOptimer, if we can
    // derive the site domain from GSC_SITE_URL. This is NOT first-party Google data.
    const domain = domainFromGscSiteUrl(config.google.gscSiteUrl);
    if (seoptimerEnabled() && domain) {
      const so = await seoptimerReport(domain);
      if (so.ok) {
        const p = profileOf(so);
        blocks.push(b.p(`External estimate for ${domain} (SEOptimer — third-party data, not your own Search Console):`));
        blocks.push(b.kv([
          { k: 'Overall / SEO / GEO grade', v: `${p.overallGrade} / ${p.seoGrade} / ${p.geoGrade}` },
          { k: 'Domain strength', v: p.domainStrength != null ? `${p.domainStrength}/100` : '—' },
          { k: 'Referring domains', v: fmt2(p.referringDomains) },
          { k: 'Backlinks', v: fmt2(p.backlinks) },
          { k: 'Est. search traffic / mo', v: fmt2(p.searchTraffic) },
          { k: 'Est. AI/LLM traffic / mo', v: fmt2(p.aiTraffic) },
        ]));
        if (so.keywordRankings.length) {
          blocks.push(b.p('Top keyword rankings (SEOptimer estimate):'));
          blocks.push(b.table(
            ['Keyword', 'Position', 'Searches', 'Est. traffic'],
            so.keywordRankings.slice(0, 8).map((r) => [r.keyword, r.position || '—', r.totalSearches ?? '—', r.estimatedTraffic ?? '—']),
          ));
        }
        blocks.push(b.note('Connect Search Console + GA4 for your OWN first-party numbers and month-over-month deltas — the figures above are SEOptimer estimates.'));
      }
    }

    blocks.push(b.list([
      'Set GSC_SITE_URL and a Google token (GOOGLE_ACCESS_TOKEN or refresh-token trio) in .env',
      'Optionally set GA4_PROPERTY_ID for sessions / conversions / revenue',
      'Both APIs are free — see README “Google data setup”.',
    ]));
    blocks.push(b.note('Once connected, this returns performance deltas, ranking/traffic movers, striking-distance keywords, and a monthly report.'));
    return { tag: 'SEO Intelligence', title: 'Connect Google data to activate', blocks };
  }

  const win = comparativeWindows(days);
  const warnings: string[] = [];

  // ---- GSC: current vs previous window, by query and by page ----
  let curQ: GscRow[] = [], prevQ: GscRow[] = [], curP: GscRow[] = [];
  if (gscConfigured()) {
    try {
      [curQ, prevQ, curP] = await Promise.all([
        gscQuery({ ...win.current, dimensions: ['query'], rowLimit: 1000 }),
        gscQuery({ ...win.previous, dimensions: ['query'], rowLimit: 1000 }),
        gscQuery({ ...win.current, dimensions: ['page'], rowLimit: 500 }),
      ]);
    } catch (e: any) { warnings.push(`GSC: ${e.message}`); }
  }

  // ---- GA4 ----
  let curGa: Ga4Metric[] = [], prevGa: Ga4Metric[] = [];
  if (ga4Configured()) {
    try {
      [curGa, prevGa] = await Promise.all([
        ga4Report(win.current),
        ga4Report(win.previous),
      ]);
    } catch (e: any) { warnings.push(`GA4: ${e.message}`); }
  }

  // ---- performance totals + deltas ----
  const cur = totals(curQ);
  const prev = totals(prevQ);
  const gaCur = gaTotals(curGa);
  const gaPrev = gaTotals(prevGa);

  // ---- detection ----
  const prevMap = new Map(prevQ.map((r) => [r.keys[0], r]));
  const curMap = new Map(curQ.map((r) => [r.keys[0], r]));

  const rankingDrops: any[] = [], rankingGains: any[] = [], lostKeywords: string[] = [], newKeywords: string[] = [];
  for (const r of curQ) {
    const p = prevMap.get(r.keys[0]);
    if (!p) { if (r.impressions > 20) newKeywords.push(r.keys[0]); continue; }
    const delta = p.position - r.position; // positive = improved
    if (delta <= -3 && r.impressions > 30) rankingDrops.push({ kw: r.keys[0], from: p.position, to: r.position });
    if (delta >= 3 && r.impressions > 30) rankingGains.push({ kw: r.keys[0], from: p.position, to: r.position });
  }
  for (const p of prevQ) if (!curMap.has(p.keys[0]) && p.clicks > 2) lostKeywords.push(p.keys[0]);

  // ---- opportunity detection ----
  const strikingDistance = curQ
    .filter((r) => r.position >= 4 && r.position <= 20 && r.impressions > 50)
    .sort((a, c) => c.impressions - a.impressions).slice(0, 15);
  const highImpLowCtr = curQ
    .filter((r) => r.impressions > 200 && r.ctr < 0.02 && r.position <= 15)
    .sort((a, c) => c.impressions - a.impressions).slice(0, 15);

  rankingDrops.sort((a, c) => (a.to - c.to));
  rankingGains.sort((a, c) => (a.from - a.to) - (c.from - c.to));

  const data = {
    window: win,
    performance: {
      // FIX 3: every metric now carries BOTH the current and prior-period absolute
      // value alongside the delta, so the model can quote the raw numbers
      // (e.g. "1,840 vs 1,642") without inferring either from the percentage.
      clicks: cur.clicks, clicksCurrent: cur.clicks, clicksPrior: prev.clicks, clicksDelta: pct(cur.clicks, prev.clicks),
      impressions: cur.impressions, impressionsCurrent: cur.impressions, impressionsPrior: prev.impressions, impressionsDelta: pct(cur.impressions, prev.impressions),
      ctr: cur.ctr, ctrCurrent: cur.ctr, ctrPrior: prev.ctr, ctrDelta: cur.ctr - prev.ctr,
      position: cur.position, positionCurrent: cur.position, positionPrior: prev.position, positionDelta: prev.position - cur.position, // + = improved
      sessions: gaCur.sessions, sessionsCurrent: gaCur.sessions, sessionsPrior: gaPrev.sessions, sessionsDelta: pct(gaCur.sessions, gaPrev.sessions),
      conversions: gaCur.conversions, conversionsCurrent: gaCur.conversions, conversionsPrior: gaPrev.conversions, conversionsDelta: pct(gaCur.conversions, gaPrev.conversions),
      revenue: gaCur.revenue, revenueCurrent: gaCur.revenue, revenuePrior: gaPrev.revenue, revenueDelta: pct(gaCur.revenue, gaPrev.revenue),
    },
    detection: {
      rankingDrops: rankingDrops.slice(0, 10), rankingGains: rankingGains.slice(0, 10),
      lostKeywords: lostKeywords.slice(0, 15), newKeywords: newKeywords.slice(0, 15),
    },
    opportunities: { strikingDistance, highImpLowCtr },
  };

  // ---- analysis + monthly report via LLM ----
  let analysis: any = {};
  if (llmConfigured()) {
    try {
      const system = `You are a senior SEO analyst writing the monthly performance report for a digital marketing agency's client. This is the report the client reads every month to decide whether to renew their retainer. Make it worth renewing.

You will receive GSC data (clicks, impressions, CTR, avg position), GA4 organic data (sessions, conversions, revenue), and delta comparisons against the prior period. Each metric provides BOTH the current and the prior-period absolute value (e.g. clicksCurrent and clicksPrior) as well as the delta — quote the actual raw numbers for both periods where useful; never infer a raw number from a percentage. Produce this structure:

MONTHLY PERFORMANCE SUMMARY
A confident 4-5 sentence executive paragraph. Lead with the headline number — the metric that changed most significantly. State whether this is a good or bad month honestly. Give the most likely explanation based on the data. End with what this means for next month.

TRAFFIC & VISIBILITY
Clicks: [value] ([delta]% vs prior period) — interpret this movement
Impressions: [value] ([delta]%) — what this signals about visibility
Average Position: [value] ([delta] points) — improving or declining
CTR: [value]% ([delta]%) — is this healthy for the position range?
For each metric, give a one-sentence interpretation of what the number actually means — not just the number itself.

TOP MOVERS
Ranking gains (pages/keywords that improved 3+ positions):
- State the keyword or page, old position, new position, and what likely drove the gain
Ranking drops (pages/keywords that fell 3+ positions):
- State the keyword or page, old position, new position, and the most likely cause based on available data
New keywords entering the top 30:
- List them with current position — these are emerging opportunities
Lost keywords that dropped out of top 30:
- List them — these need immediate attention

OPPORTUNITIES IDENTIFIED
Striking distance keywords (positions 4-20 with high impressions):
For each one: keyword, current position, impressions, and the specific on-page action that could push it into top 3
High impressions, low CTR pages:
For each one: page URL, impressions, CTR, current title/meta, and a rewritten title tag suggestion that would improve CTR

GA4 ORGANIC PERFORMANCE
Sessions: [value] ([delta]%)
Conversions: [value] ([delta]%)
Revenue (if available): [value] ([delta]%)
Interpret the relationship between traffic and conversion — is traffic quality improving or declining?

ANALYST RECOMMENDATION
3 specific actions for next month, in priority order.
Each action: what to do, which pages/keywords to target, expected outcome, and who executes it.
No vague recommendations. If you say "improve content", name the page and state what to add or change.

Rules you must never break:
- Never invent a number, delta, or keyword not in the data passed to you
- If GSC or GA4 data is missing, state it clearly at the top and work with what is available — never fabricate to fill the template
- Use plain English for the client sections — the client is a business owner, not an SEO specialist
- Be honest about bad months — clients respect honesty more than spin. If traffic dropped, say why and what is being done about it
- Never use hedging language — every sentence must be confident and direct

OUTPUT FORMAT — the performance table, ranking-mover lists, striking-distance table and GA4 figures are already rendered from measured data directly beneath your narrative, so do not restate raw numbers you were not given. Return ONLY minified JSON with exactly these keys:
{"executiveSummary": string (the MONTHLY PERFORMANCE SUMMARY, 4-5 sentences),
 "trafficInterpretation": string[] (one plain-English sentence per metric present: clicks, impressions, average position, CTR — and sessions/conversions/revenue if GA4 data is present),
 "movers": string[] (one line per significant gain, drop, new or lost keyword, naming it and the likely cause/driver),
 "opportunityActions": string[] (for each striking-distance keyword and high-impression/low-CTR query, the specific on-page action — include a rewritten title-tag suggestion where relevant),
 "recommendedActions": [{"title": string, "detail": string}] (exactly 3, priority order; each names the page/keyword to target, the expected outcome, and who executes it — Developer / Content Writer / SEO Manager)}
Note: the high-impression/low-CTR items provided are QUERIES, not page URLs — refer to them as queries and never fabricate a URL for them.`;
      const user = JSON.stringify({
        periodDays: daysBetween(data.window.current),
        gscConnected: gscConfigured(),
        ga4Connected: ga4Configured(),
        performance: data.performance,
        rankingGains: data.detection.rankingGains.slice(0, 50),
        rankingDrops: data.detection.rankingDrops.slice(0, 50),
        newKeywords: data.detection.newKeywords.slice(0, 50),
        lostKeywords: data.detection.lostKeywords.slice(0, 50),
        strikingDistanceKeywords: strikingDistance.slice(0, 50).map((r) => ({ keyword: r.keys[0], position: round(r.position, 1), impressions: r.impressions, ctrPct: round(r.ctr * 100, 2) })),
        highImpressionsLowCtrQueries: highImpLowCtr.slice(0, 50).map((r) => ({ query: r.keys[0], impressions: r.impressions, ctrPct: round(r.ctr * 100, 2), position: round(r.position, 1) })),
      });
      analysis = await completeJSON<any>(system, user, { temperature: 0.3, maxTokens: 4000 });
    } catch (e: any) { warnings.push(`Analysis: ${e.message}`); }
  }

  return toReport(data, analysis, warnings);
}

function toReport(d: any, a: any, warnings: string[]): Report {
  const p = d.performance;
  const blocks = [];
  blocks.push(b.p(`Last ${daysBetween(d.window.current)} days vs the prior period. Merged Search Console${p.sessions ? ' + GA4' : ''}.`));

  const rows: (string | number)[][] = [
    ['Clicks', fmt(p.clicks), signed(p.clicksDelta, '%')],
    ['Impressions', fmt(p.impressions), signed(p.impressionsDelta, '%')],
    ['Avg CTR', round(p.ctr * 100, 2) + '%', signed(round(p.ctrDelta * 100, 2), 'pt')],
    ['Avg position', round(p.position, 1), signed(round(p.positionDelta, 1), '', true)],
  ];
  if (p.sessions) rows.push(['Organic sessions', fmt(p.sessions), signed(p.sessionsDelta, '%')]);
  if (p.conversions) rows.push(['Conversions', fmt(p.conversions), signed(p.conversionsDelta, '%')]);
  if (p.revenue) rows.push(['Revenue', fmt(Math.round(p.revenue)), signed(p.revenueDelta, '%')]);
  blocks.push(b.table(['Metric', 'Value', 'Δ'], rows));

  if (a.executiveSummary) blocks.push(b.p(a.executiveSummary));
  if (Array.isArray(a.trafficInterpretation) && a.trafficInterpretation.length) {
    blocks.push(b.list(a.trafficInterpretation.slice(0, 10)));
  }

  const dropList = d.detection.rankingDrops.map((r: any) => `${r.kw}: pos ${round(r.from, 1)} → ${round(r.to, 1)}`);
  const gainList = d.detection.rankingGains.map((r: any) => `${r.kw}: pos ${round(r.from, 1)} → ${round(r.to, 1)}`);
  if (dropList.length) { blocks.push(b.p('Ranking drops:')); blocks.push(b.list(dropList.slice(0, 6))); }
  if (gainList.length) { blocks.push(b.p('Ranking gains:')); blocks.push(b.list(gainList.slice(0, 6))); }

  if (d.opportunities.strikingDistance.length) {
    blocks.push(b.p('Striking distance (position 4–20, high impressions):'));
    blocks.push(b.table(['Keyword', 'Pos', 'Impr'],
      d.opportunities.strikingDistance.slice(0, 8).map((r: any) => [r.keys[0], round(r.position, 1), fmt(r.impressions)])));
  }
  if (d.opportunities.highImpLowCtr.length) {
    blocks.push(b.p('High impressions + low CTR (title/meta rewrite candidates):'));
    blocks.push(b.chips(d.opportunities.highImpLowCtr.slice(0, 8).map((r: any) => r.keys[0])));
  }

  if (Array.isArray(a.movers) && a.movers.length) {
    blocks.push(b.p('What moved, and why:'));
    blocks.push(b.list(a.movers.slice(0, 12)));
  }
  if (Array.isArray(a.opportunityActions) && a.opportunityActions.length) {
    blocks.push(b.p('Opportunity plays (specific on-page actions):'));
    blocks.push(b.list(a.opportunityActions.slice(0, 12)));
  }

  if (Array.isArray(a.recommendedActions) && a.recommendedActions.length) {
    blocks.push(b.tasks(a.recommendedActions.slice(0, 6).map((t: any, i: number) => ({
      title: typeof t === 'string' ? t : String(t.title || t.action || 'Action'),
      priority: (i === 0 ? 'high' : 'medium') as any,
      detail: typeof t === 'object' ? String(t.detail || '') : undefined,
    }))));
  }

  if (warnings.length) blocks.push(b.note(warnings.join('  •  ')));

  return { tag: 'SEO Intelligence', title: 'Monthly SEO intelligence report', blocks, data: d };
}

/* helpers */
/** Derive a bare domain from a GSC site URL ("sc-domain:site.com" or "https://www.site.com/"). */
function domainFromGscSiteUrl(siteUrl: string): string {
  if (!siteUrl) return '';
  let s = siteUrl.trim();
  if (s.startsWith('sc-domain:')) return s.slice('sc-domain:'.length).replace(/^www\./, '').replace(/\/.*$/, '');
  return s.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
}
const fmt2 = (n: number | null) => (n == null ? '—' : n.toLocaleString('en-US'));

function totals(rows: GscRow[]) {
  const clicks = sum(rows, 'clicks');
  const impressions = sum(rows, 'impressions');
  const ctr = impressions ? clicks / impressions : 0;
  const position = rows.length ? rows.reduce((s, r) => s + r.position * r.impressions, 0) / (impressions || 1) : 0;
  return { clicks, impressions, ctr, position };
}
function gaTotals(rows: Ga4Metric[]) {
  return { sessions: sum(rows, 'sessions'), conversions: sum(rows, 'conversions'), revenue: sum(rows, 'totalRevenue') };
}
const sum = (rows: any[], k: string) => rows.reduce((s, r) => s + (r[k] || 0), 0);
const pct = (cur: number, prev: number) => (prev ? Math.round(((cur - prev) / prev) * 100) : cur ? 100 : 0);
const round = (n: number, d = 0) => Number(n.toFixed(d));
const fmt = (n: number) => n.toLocaleString('en-US');
function signed(n: number, unit = '', invertColorNote = false) {
  const s = n > 0 ? `+${n}` : `${n}`;
  return `${s}${unit}`;
}
function daysBetween(w: { startDate: string; endDate: string }) {
  return Math.round((Date.parse(w.endDate) - Date.parse(w.startDate)) / 86400000) + 1;
}
