import { serp, serpEnabled, serpErrorNote } from '../sources/serp';
import { requestOnce } from '../lib/http';
import { extractOutline, safeOrigin } from '../lib/html';
import { pool } from '../lib/concurrency';
import { completeJSON, llmConfigured } from '../llm';
import { seoptimerEnabled, seoptimerReport, profileOf, SeoptimerProfile } from '../sources/seoptimer';
import { Report, b } from '../lib/report';

interface SeoptimerCompetitive {
  profiles: SeoptimerProfile[];               // client first, then competitors
  realKeywordGaps: { keyword: string; volume: string | null; competitor: string }[];
}

export interface CompetitiveData {
  client: string;
  seeds: string[];
  competitors: { domain: string; appearances: number; topPage?: string }[];
  landscape: string;
  winning: string[];
  losing: { topic: string; advantage: string; opportunity: string; play: string }[];
  contentGaps: { topic: string; competitor: string; demand: string; format: string; effort: string }[];
  keywordAttackList: { keyword: string; competitor: string; clientPosition: string; page: string }[];
  strategy: string[];
  opportunities: { title: string; priority: 'critical' | 'high' | 'medium' | 'low'; detail?: string }[];
  seoptimer?: SeoptimerCompetitive;
}

/**
 * SEO Competitive Intelligence (Competitor + Content Gap combined):
 *  identify competitors -> analyze their pages/topics -> compare to client
 *  -> keyword gaps + content gaps -> opportunity list.
 * Free: SERP discovery + page fetch + LLM. No Ahrefs required.
 */
export async function runCompetitive(input: {
  clientDomain: string;
  seedKeywords?: string[];
  competitors?: string[];
}): Promise<Report> {
  const client = normDomain(input.clientDomain);
  if (!client) throw new Error('Provide the client domain (e.g. clientsite.com).');
  if (!llmConfigured()) return { tag: 'Competitive Intelligence', title: 'LLM not configured', blocks: [b.note('Add an LLM key to .env.')] };
  if (!serpEnabled()) return { tag: 'Competitive Intelligence', title: 'SERP disabled', blocks: [b.note('Enable SERP_PROVIDER to discover competitors.')] };

  const seeds = (input.seedKeywords?.length ? input.seedKeywords : [client.split('.')[0]]).slice(0, 5);

  // 1) discover competitors from SERP overlap across seed keywords
  const domainCount = new Map<string, { count: number; page: string }>();
  let serpOk = 0, serpFail = 0, lastErr = '';
  await pool(seeds, 2, async (kw) => {
    try {
      const r = await serp(kw, 10);
      const note = serpErrorNote(r);
      if (note) { serpFail++; lastErr = note; return; }
      serpOk++;
      for (const res of r.results) {
        const d = normDomain(res.domain);
        if (!d || d === client) continue;
        const cur = domainCount.get(d) || { count: 0, page: res.url };
        cur.count++;
        domainCount.set(d, cur);
      }
    } catch { serpFail++; }
  });

  // Honest failure: if SERP never returned and the user gave no manual competitors.
  if (serpOk === 0 && !input.competitors?.length) {
    const blocks = [
      b.p(`I couldn't discover competitors for ${client} — the live SERP source returned no results.`),
    ];
    // Still give something real: the client's own SEOptimer profile (no SERP needed).
    if (seoptimerEnabled()) {
      const so = await seoptimerReport(client);
      if (so.ok) {
        const p = profileOf(so);
        blocks.push(b.p(`Here's ${client}'s real SEOptimer profile — add competitor domains to compare head-to-head:`));
        blocks.push(b.kv([
          { k: 'Overall / SEO / GEO', v: `${p.overallGrade} / ${p.seoGrade} / ${p.geoGrade}` },
          { k: 'Domain strength', v: p.domainStrength != null ? `${p.domainStrength}/100` : '—' },
          { k: 'Referring domains', v: fmtNum(p.referringDomains) },
          { k: 'Est. search traffic', v: fmtNum(p.searchTraffic) },
        ]));
      }
    }
    blocks.push(b.note(lastErr || 'SERP source unavailable. Try SERP_HEADLESS=0, a residential SERP_PROXY, or SERP_PROVIDER=serpapi. You can also pass competitors manually.'));
    return { tag: 'Competitive Intelligence', title: `Gap analysis for ${client}`, blocks };
  }

  let competitors: CompetitiveData['competitors'] = [...domainCount.entries()]
    .map(([domain, v]) => ({ domain, appearances: v.count, topPage: v.page }))
    .sort((a, c) => c.appearances - a.appearances)
    .slice(0, 6);

  // allow user-supplied competitors to take priority
  if (input.competitors?.length) {
    const manual = input.competitors.map((c) => ({ domain: normDomain(c), appearances: 99, topPage: `https://${normDomain(c)}` }));
    const merged = new Map<string, CompetitiveData['competitors'][number]>();
    for (const c of [...manual, ...competitors]) if (c.domain) merged.set(c.domain, c);
    competitors = [...merged.values()].slice(0, 6);
  }

  // 2) analyze client + top competitor content (topics via headings)
  const clientOutline = await fetchOutline(`https://${client}`);
  const compOutlines = await pool(competitors.slice(0, 4), 3, async (c) => ({
    domain: c.domain,
    outline: await fetchOutline(c.topPage || `https://${c.domain}`),
  }));

  // Real head-to-head via SEOptimer (grades, backlinks, traffic, keyword gaps).
  // Fetched BEFORE the LLM call so its measured data enriches the analysis.
  const seoptimer = seoptimerEnabled()
    ? await buildSeoptimerCompetitive(client, competitors.map((c) => c.domain).slice(0, 4))
    : undefined;

  const system = `You are a senior SEO strategist writing a competitive intelligence report for a digital marketing agency. The client wants to know exactly where they are losing to competitors and what to do about it.

You will receive content outlines and keyword data for the client and their top competitors. Produce this structure:

COMPETITIVE LANDSCAPE
One paragraph: who the real competitors are in search (not just the ones the client thinks they compete with), and the honest assessment of where the client stands relative to them.

WHERE THE CLIENT IS WINNING
Topics and keywords where the client outranks or matches competitors. Be specific — name the topics and approximate positions. This builds client confidence before delivering the hard news.

WHERE THE CLIENT IS LOSING
For each significant gap:
- The topic or keyword cluster the competitor owns
- The competitor's advantage (content depth, backlinks, page authority)
- The traffic opportunity this represents
- The specific content or optimization play to close the gap

CONTENT GAPS (HIGH PRIORITY)
Topics competitors cover that the client does not address at all.
For each gap:
- The missing topic
- Which competitor owns it
- Search demand signal (if available from the data)
- Recommended content format: new page / expanded section / FAQ addition / dedicated article
- Estimated effort: LOW / MEDIUM / HIGH

KEYWORD ATTACK LIST
The 10 most actionable keywords to target in the next 90 days.
For each: keyword, competitor currently ranking, client's current position (or not ranking), and the specific page to create or optimize.

STRATEGIC RECOMMENDATION
A 3-paragraph competitive strategy. Paragraph 1: where to attack (the gaps with highest ROI). Paragraph 2: where to defend (the client's strong positions that competitors are targeting). Paragraph 3: the one content investment that would shift the competitive balance most significantly.

Rules you must never break:
- Never invent keyword volumes or competitor rankings not in the data
- If SERP data is limited, work with heading outline comparisons and be explicit about what the data does and does not show
- Every recommendation must name a specific page or keyword, not a generic content category
- Prioritize opportunities by business value, not SEO vanity metrics

OUTPUT FORMAT — the competitor overlap table and the SEOptimer head-to-head/keyword-gap table are already rendered from measured data beneath your narrative. Return ONLY minified JSON with exactly these keys:
{"landscape": string,
 "winning": string[] (topics/keywords where the client is strong, each naming the topic and approximate standing),
 "losing": [{"topic": string, "advantage": string, "opportunity": string, "play": string}],
 "contentGaps": [{"topic": string, "competitor": string, "demand": string, "format": string, "effort": "LOW|MEDIUM|HIGH"}],
 "keywordAttackList": [{"keyword": string, "competitor": string, "clientPosition": string, "page": string}] (up to 10),
 "strategy": string[] (exactly 3 paragraphs, in order: attack, defend, the one big investment),
 "opportunities": [{"title": string, "priority": "critical|high|medium|low", "detail": string}]}
Use the realKeywordGaps data (competitor keywords with real search volume that the client does not rank for) as the backbone of contentGaps and keywordAttackList — those volumes are measured, so cite them; never invent your own.`;
  const user = JSON.stringify({
    client,
    seeds,
    clientHeadings: (clientOutline?.headings || []).slice(0, 60),
    competitors: compOutlines.map((c) => ({
      domain: c.domain,
      serpAppearances: competitors.find((x) => x.domain === c.domain)?.appearances ?? null,
      headings: (c.outline?.headings || []).slice(0, 40),
    })),
    seoptimerHeadToHead: seoptimer?.profiles ?? [],
    realKeywordGaps: seoptimer?.realKeywordGaps ?? [],
  });

  const p = await completeJSON<any>(system, user, { temperature: 0.3, maxTokens: 5000 });

  const data: CompetitiveData = {
    client,
    seeds,
    competitors,
    landscape: String(p.landscape || ''),
    winning: arr(p.winning),
    losing: Array.isArray(p.losing)
      ? p.losing.map((x: any) => ({ topic: String(x.topic || ''), advantage: String(x.advantage || ''), opportunity: String(x.opportunity || ''), play: String(x.play || '') })).filter((x: any) => x.topic)
      : [],
    contentGaps: Array.isArray(p.contentGaps)
      ? p.contentGaps.map((x: any) => ({ topic: String(x.topic || ''), competitor: String(x.competitor || ''), demand: String(x.demand || ''), format: String(x.format || ''), effort: String(x.effort || '') })).filter((x: any) => x.topic)
      : [],
    keywordAttackList: Array.isArray(p.keywordAttackList)
      ? p.keywordAttackList.map((x: any) => ({ keyword: String(x.keyword || ''), competitor: String(x.competitor || ''), clientPosition: String(x.clientPosition || ''), page: String(x.page || '') })).filter((x: any) => x.keyword).slice(0, 10)
      : [],
    strategy: arr(p.strategy),
    opportunities: Array.isArray(p.opportunities)
      ? p.opportunities.map((o: any) => ({
          title: String(o.title || ''),
          priority: (['critical', 'high', 'medium', 'low'].includes(o.priority) ? o.priority : 'medium'),
          detail: o.detail ? String(o.detail) : undefined,
        })).filter((o: any) => o.title)
      : [],
    seoptimer,
  };

  return toReport(data);
}

/**
 * Real competitive data from SEOptimer: audit the client + each competitor
 * (cached, parallel), then derive keyword gaps = keywords a competitor ranks
 * for (with real volume) that the client's tracked set does not include.
 */
async function buildSeoptimerCompetitive(client: string, competitorDomains: string[]): Promise<SeoptimerCompetitive | undefined> {
  const domains = [client, ...competitorDomains.filter((d) => d && d !== client)];
  const reports = await pool(domains, 3, (d) => seoptimerReport(d));
  const ok = reports.filter((r) => r.ok);
  if (!ok.length) return undefined;

  const profiles = ok.map(profileOf);

  const clientReport = reports[0];
  const clientKw = new Set(
    (clientReport.ok ? clientReport.keywordRankings : []).map((k) => k.keyword.trim().toLowerCase()),
  );

  const gapMap = new Map<string, { keyword: string; volume: string | null; competitor: string; vol: number }>();
  for (let i = 1; i < reports.length; i++) {
    const r = reports[i];
    if (!r.ok) continue;
    const comp = r.url.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    for (const kw of r.keywordRankings) {
      const key = kw.keyword.trim().toLowerCase();
      if (!key || clientKw.has(key)) continue;
      const vol = Number((kw.totalSearches || '').replace(/[^0-9]/g, '')) || 0;
      const cur = gapMap.get(key);
      if (!cur || vol > cur.vol) gapMap.set(key, { keyword: kw.keyword, volume: kw.totalSearches, competitor: comp, vol });
    }
  }
  const realKeywordGaps = [...gapMap.values()].sort((a, c) => c.vol - a.vol).slice(0, 15)
    .map(({ keyword, volume, competitor }) => ({ keyword, volume, competitor }));

  return { profiles, realKeywordGaps };
}

async function fetchOutline(url: string) {
  try {
    const res = await requestOnce(url);
    if (!res.body) return null;
    const o = extractOutline(res.body);
    return { title: o.title, headings: [...o.h1, ...o.h2, ...o.h3] };
  } catch {
    return null;
  }
}

function toReport(d: CompetitiveData): Report {
  const blocks = [];
  blocks.push(b.p(`Identified ${d.competitors.length} competitors via SERP overlap for ${d.client}.`));
  blocks.push(b.table(
    ['Competitor', 'SERP appearances'],
    d.competitors.map((c) => [c.domain, c.appearances === 99 ? 'manual' : c.appearances]),
  ));

  // Real head-to-head from SEOptimer (measured, not inferred).
  const so = d.seoptimer;
  if (so && so.profiles.length) {
    blocks.push(b.p('Head-to-head (SEOptimer — real grades, authority & traffic):'));
    blocks.push(b.table(
      ['Site', 'Overall', 'SEO', 'GEO', 'Domain str.', 'Ref. domains', 'Est. search traffic'],
      so.profiles.map((p, i) => [
        i === 0 ? `${p.domain} (client)` : p.domain,
        p.overallGrade, p.seoGrade, p.geoGrade,
        p.domainStrength != null ? `${p.domainStrength}/100` : '—',
        fmtNum(p.referringDomains), fmtNum(p.searchTraffic),
      ]),
    ));
    if (so.realKeywordGaps.length) {
      blocks.push(b.p('Real keyword gaps — competitors rank for these (with search volume); the client does not:'));
      blocks.push(b.table(
        ['Keyword', 'Search volume', 'Ranks'],
        so.realKeywordGaps.map((g) => [g.keyword, g.volume ?? '—', g.competitor]),
      ));
    }
  }

  if (d.landscape) {
    blocks.push(b.p('Competitive landscape:'));
    blocks.push(b.p(d.landscape));
  }
  if (d.winning.length) {
    blocks.push(b.p('Where you’re winning:'));
    blocks.push(b.list(d.winning.slice(0, 10)));
  }
  if (d.losing.length) {
    blocks.push(b.p('Where you’re losing:'));
    blocks.push(b.list(d.losing.slice(0, 10).map((x) =>
      `${x.topic} — competitor edge: ${x.advantage || 'n/a'}. Opportunity: ${x.opportunity || 'n/a'}. Play: ${x.play || 'n/a'}`)));
  }
  if (d.contentGaps.length) {
    blocks.push(b.p('Content gaps (topics competitors own that you don’t):'));
    blocks.push(b.table(
      ['Missing topic', 'Owned by', 'Demand', 'Format', 'Effort'],
      d.contentGaps.slice(0, 12).map((g) => [g.topic, g.competitor || '—', g.demand || '—', g.format || '—', g.effort || '—']),
    ));
  }
  if (d.keywordAttackList.length) {
    blocks.push(b.p('Keyword attack list — the 90-day target set:'));
    blocks.push(b.table(
      ['Keyword', 'Competitor ranking', 'Your position', 'Page to build / optimize'],
      d.keywordAttackList.map((k) => [k.keyword, k.competitor || '—', k.clientPosition || 'not ranking', k.page || '—']),
    ));
  }
  if (d.opportunities.length) blocks.push(b.tasks(d.opportunities.slice(0, 8)));
  if (d.strategy.length) {
    blocks.push(b.p('Strategic recommendation:'));
    for (const para of d.strategy.slice(0, 3)) if (para) blocks.push(b.p(para));
  }

  return { tag: 'Competitive Intelligence', title: `Gap analysis for ${d.client}`, blocks, data: d };
}

function normDomain(x: string): string {
  return (x || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
}
const arr = (x: any): string[] => (Array.isArray(x) ? x.map((s) => String(s)).filter(Boolean) : []);
const fmtNum = (n: number | null) => (n == null ? '—' : n.toLocaleString('en-US'));
