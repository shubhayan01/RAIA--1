import { config } from '../config';
import { runAudit, AuditData, AuditCounts } from './audit';
import { pageSpeed, PsiResult } from '../sources/psi';
import { seoptimerReport, SeoptimerReport, checksBySection } from '../sources/seoptimer';

/**
 * Proposal builder — aggregates EVERYTHING S.A.G.E measures for one site into a
 * single client-ready model: the crawler audit, Google Lighthouse (mobile +
 * desktop), and the SEOptimer graded audit / backlinks / rankings / GEO.
 *
 * Every number here is measured. The renderer (report/proposalHtml.ts) turns
 * this into a branded, print-ready HTML document with a PDF download.
 */

export type Status = 'PASS' | 'WARN' | 'FAIL';

export interface ProposalCard {
  key: string;
  label: string;
  grade: string;
  passing: number;
  issues: number;
}

export interface ProposalData {
  brand: string;
  domain: string;
  url: string;
  generatedAt: string;
  hasSeoptimer: boolean;

  cards: ProposalCard[];
  summary: { passing: number; toImprove: number; toFix: number; forReview: number };

  criticalIssues: { issue: string; found: string; extent: string; impact: string; severity: string }[];
  quickWins: string[];

  tech: {
    loadSeconds: number | null;
    mobileScore: number | null;
    desktopScore: number | null;
    lcpMs: number | null;
    cls: number | null;
    inpMs: number | null;
    fieldData: boolean;
    pageWeightBytes: number | null;
  };

  wholeSite: { issue: string; extent: string; meaning: string; status: Status }[];
  homepage: { element: string; value: string; verdict: string; status: Status }[];

  organic: {
    monthlyVisits: number | null;
    rankingKeywords: number | null;
    referringDomains: number | null;
    pagesCrawled: number;
    positions: { label: string; count: number }[];
    backlinks: { total: number | null; referring: number | null; dofollow: number | null; eduGov: string };
    onsite: { internalLinks: number; externalLinks: number; contentDepth: number; aiTraffic: number | null };
  };

  // Whole-crawl health snapshot — all measured, no LLM.
  siteHealth: {
    pagesCrawled: number;
    htmlPages: number;
    indexable: number;
    httpsPages: number;
    avgWords: number;
    withSchema: number;
    avgResponseMs: number;
    robotsFound: boolean;
    sitemapFound: boolean;
    sitemapUrlCount: number;
  };

  // Every detected issue with the exact affected URLs the crawler saw.
  issueDetail: {
    id: string; label: string; category: string; severity: string;
    count: number; explanation: string; examples: string[]; more: number;
  }[];

  // Actual ranking keywords from third-party data (empty when no key configured).
  keywordRankings: { keyword: string; position: number; searches: string; traffic: string }[];

  // Deterministic 90-day plan built by sequencing the real findings above.
  roadmap: { phase: string; horizon: string; items: string[] }[];
}

export async function buildProposal(rawUrl: string, opts: { brand?: string; maxPages?: number } = {}): Promise<ProposalData> {
  let url = rawUrl.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const domain = url.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');

  // 1) full crawl audit (also fetches mobile PageSpeed + SEOptimer, both cached)
  const auditReport = await runAudit(url, { maxPages: opts.maxPages, cwv: true });
  const a = auditReport.data as AuditData;

  // 2) desktop PageSpeed (mobile already inside the audit) + SEOptimer (cached)
  const [desktop, so] = await Promise.all([
    pageSpeed(a.startUrl, 'desktop').catch(() => null),
    a.seoptimer?.ok ? Promise.resolve(a.seoptimer) : seoptimerReport(url).catch(() => null),
  ]);

  const counts = a.counts!;
  const home = a.homepage;
  const psi = a.pagespeed;

  return {
    brand: opts.brand || config.report?.brand || 'S.A.G.E',
    domain,
    url: a.startUrl,
    generatedAt: new Date().toISOString(),
    hasSeoptimer: !!(so && so.ok),

    cards: buildCards(so),
    summary: buildSummary(so, a),
    criticalIssues: buildCriticalIssues(a, counts, psi, so),
    quickWins: buildQuickWins(so, a, counts),
    tech: {
      loadSeconds: psi?.loadMs != null ? +(psi.loadMs / 1000).toFixed(1) : null,
      mobileScore: psi?.performanceScore ?? null,
      desktopScore: desktop?.performanceScore ?? null,
      lcpMs: psi?.lcpMs ?? null,
      cls: psi?.cls ?? null,
      inpMs: psi?.inpMs ?? null,
      fieldData: !!psi?.fieldData,
      pageWeightBytes: psi?.pageWeightBytes ?? null,
    },
    wholeSite: buildWholeSite(counts),
    homepage: buildHomepage(home, psi),
    organic: buildOrganic(a, so, counts),
    siteHealth: buildSiteHealth(a),
    issueDetail: buildIssueDetail(a),
    keywordRankings: buildKeywordRankings(so),
    roadmap: buildRoadmap(a, psi, so),
  };
}

/* ------------------------------ Sections -------------------------------- */

const CARD_MAP: [string, string][] = [
  ['seo', 'On-Page SEO'],
  ['geo', 'AI Search'],
  ['performance', 'Performance'],
  ['links', 'Backlinks'],
  ['ui', 'Usability'],
];

function buildCards(so: SeoptimerReport | null | undefined): ProposalCard[] {
  if (!so || !so.ok) return [];
  return CARD_MAP.map(([key, label]) => {
    const checks = checksBySection(so, key);
    const passing = checks.filter((c) => c.passed === true).length;
    const issues = checks.filter((c) => c.passed === false).length;
    return { key, label, grade: so.scores[key]?.grade || '—', passing, issues };
  });
}

function buildSummary(so: SeoptimerReport | null | undefined, a: AuditData) {
  const warnings = a.issues.filter((g) => g.severity === 'medium' || g.severity === 'low').length;
  if (!so || !so.ok) {
    const toFix = a.issues.filter((g) => g.severity === 'critical' || g.severity === 'high').length;
    return { passing: 0, toImprove: 0, toFix, forReview: warnings };
  }
  const passing = so.checks.filter((c) => c.passed === true).length;
  const toFix = so.recommendations.filter((r) => String(r.priority).toLowerCase() === 'high').length;
  const toImprove = so.recommendations.filter((r) => String(r.priority).toLowerCase() === 'medium').length;
  const forReview = so.recommendations.filter((r) => String(r.priority).toLowerCase() === 'low').length + warnings;
  return { passing, toImprove, toFix, forReview };
}

function buildCriticalIssues(a: AuditData, c: AuditCounts, psi: PsiResult | undefined, so: SeoptimerReport | null | undefined) {
  const rows: ProposalData['criticalIssues'] = [];
  const N = c.totalPages;

  // Speed (from Lighthouse) — leads if slow.
  if (psi && (psi.ttfbMs != null || psi.loadMs != null)) {
    const ttfb = psi.ttfbMs, load = psi.loadMs;
    const slow = (ttfb != null && ttfb > 600) || (load != null && load > 2500);
    if (slow) {
      rows.push({
        issue: 'Time to first byte / load',
        found: `${ttfb != null ? `TTFB ${ttfb} ms` : ''}${ttfb != null && load != null ? '; ' : ''}${load != null ? `full load ${(load / 1000).toFixed(1)}s` : ''}.`,
        extent: load != null ? `${(load / 1000).toFixed(1)}s load` : 'homepage',
        impact: 'A slow server response delays every other metric Google measures.',
        severity: 'High',
      });
    }
  }

  const push = (n: number, issue: string, foundFn: () => string, impact: string, severity: string) => {
    if (n > 0) rows.push({ issue, found: foundFn(), extent: `${n} of ${N} pages`, impact, severity });
  };

  push(c.dupTitle + c.missingTitle, 'Title tags across all pages',
    () => `${c.missingTitle} missing a title and ${c.dupTitle} duplicate titles across ${N} pages.`,
    'Titles are the strongest on-page signal; missing or duplicated ones cap rankings on every affected page.', 'High');
  push(c.thin, 'Pages with thin content',
    () => `${c.thin} of ${N} pages have under 300 words of content.`,
    'Thin pages struggle to rank and can drag down the whole domain’s quality signal.', 'High');
  push(c.canonicalIssues, 'Canonical & indexability',
    () => `${c.canonicalIssues} pages canonicalised elsewhere, across ${N} pages.`,
    'Missing or cross-pointing canonicals split ranking signals between duplicate URLs.', 'High');

  // Backlinks (SEOptimer) — off-page.
  if (so && so.ok && so.backlinks) {
    const linksGrade = so.scores.links?.grade || '';
    if (/^[CDEF]/.test(linksGrade)) {
      rows.push({
        issue: 'Backlinks & referring domains',
        found: 'Your links could be stronger.',
        extent: `${(so.backlinks.referringDomains ?? 0).toLocaleString('en-US')} referring domains`,
        impact: 'Authority from other sites is the strongest off-page ranking factor.',
        severity: 'High',
      });
    }
  }

  push(c.brokenInternalLinks, 'Broken links across the site',
    () => `${c.brokenInternalLinks} broken internal link(s) found across ${N} pages.`,
    'Poor user experience, and link equity leaks out of dead ends.', 'Medium');
  push(c.missingMeta + c.dupMeta, 'Meta descriptions across all pages',
    () => `${c.missingMeta} pages missing a meta description and ${c.dupMeta} duplicates across ${N} pages.`,
    'Missing and duplicate meta descriptions cost click-through from search on those pages.', 'Medium');
  push(c.missingH1 + c.multiH1, 'H1 coverage across all pages',
    () => `${c.missingH1} pages with no H1 and ${c.multiH1} with multiple H1s across ${N} pages.`,
    'Pages with no H1 (or several) leave search engines unsure what each page is about.', 'Medium');
  if (c.imagesMissingAlt > 0) {
    rows.push({
      issue: 'Image alt coverage across all pages',
      found: `${c.imagesMissingAlt.toLocaleString('en-US')} of ${c.imagesTotal.toLocaleString('en-US')} images across the site are missing alt text.`,
      extent: `${c.imagesMissingAlt.toLocaleString('en-US')} of ${c.imagesTotal.toLocaleString('en-US')} images`,
      impact: 'Images without alt text lose accessibility and image-search traffic site-wide.',
      severity: 'Medium',
    });
  }

  const sevRank: Record<string, number> = { High: 3, Medium: 2, Low: 1 };
  return rows.sort((x, y) => (sevRank[y.severity] || 0) - (sevRank[x.severity] || 0));
}

function buildQuickWins(so: SeoptimerReport | null | undefined, a: AuditData, c: AuditCounts): string[] {
  const wins: string[] = [];
  if (c.brokenInternalLinks > 0) wins.push(`Fix the ${c.brokenInternalLinks} broken internal link(s) so users and crawlers stop hitting dead ends.`);
  if (c.missingMeta > 0) wins.push('Add unique, descriptive meta descriptions to the pages missing them to lift click-through from search.');
  if (so && so.ok) {
    for (const r of so.recommendations.slice(0, 6)) if (r.recommendation) wins.push(r.recommendation);
  }
  if (c.imagesMissingAlt > 0) wins.push('Add descriptive alt text to images missing it to improve accessibility and image-search traffic.');
  // Dedupe, keep 6.
  return [...new Set(wins)].slice(0, 6);
}

function buildWholeSite(c: AuditCounts): ProposalData['wholeSite'] {
  const N = c.totalPages;
  const warn = (n: number): Status => (n > 0 ? 'WARN' : 'PASS');
  return [
    { issue: 'Missing page titles', extent: `${c.missingTitle} of ${N} pages`, meaning: c.missingTitle ? 'Pages with no title tag give Google nothing to rank.' : 'Every page has a title.', status: warn(c.missingTitle) },
    { issue: 'Duplicate titles', extent: `${c.dupTitle} of ${N} pages`, meaning: 'Duplicate titles make pages compete against each other for the same terms.', status: warn(c.dupTitle) },
    { issue: 'Missing meta descriptions', extent: `${c.missingMeta} of ${N} pages`, meaning: 'Google writes its own snippet for these pages, hurting click-through.', status: warn(c.missingMeta) },
    { issue: 'Missing H1 heading', extent: `${c.missingH1} of ${N} pages`, meaning: 'No H1 leaves search engines unsure what these pages are about.', status: warn(c.missingH1) },
    { issue: 'Thin content (<300 words)', extent: `${c.thin} of ${N} pages`, meaning: 'Thin pages rarely rank and can drag down the whole domain’s quality signal.', status: warn(c.thin) },
    { issue: 'Images missing alt text', extent: `${c.imagesMissingAlt.toLocaleString('en-US')} of ${c.imagesTotal.toLocaleString('en-US')} images`, meaning: 'Undescribed images lose accessibility and image-search traffic.', status: warn(c.imagesMissingAlt) },
    { issue: 'Canonical issues', extent: `${c.canonicalIssues} of ${N} pages`, meaning: 'Missing or cross-pointing canonicals split ranking signals between URLs.', status: warn(c.canonicalIssues) },
    { issue: 'Broken links', extent: `${c.brokenInternalLinks} across the site`, meaning: 'Broken links waste crawl budget and leak link equity into dead ends.', status: warn(c.brokenInternalLinks) },
  ];
}

function buildHomepage(home: AuditData['homepage'], psi: PsiResult | undefined): ProposalData['homepage'] {
  if (!home) return [];
  const rows: ProposalData['homepage'] = [];
  const titleLen = home.titleLength;
  rows.push({
    element: 'Title tag', value: home.title || '—',
    verdict: home.title ? `Title is ${titleLen} chars — ${titleLen >= 30 && titleLen <= 60 ? 'good length' : titleLen < 30 ? 'a bit short' : 'a bit long'}.` : 'No title tag.',
    status: home.title ? (titleLen >= 30 && titleLen <= 60 ? 'PASS' : 'WARN') : 'FAIL',
  });
  rows.push({
    element: 'Meta description', value: home.metaDescription || '—',
    verdict: home.metaDescription ? `Meta description is ${home.metaDescriptionLength} chars — ${home.metaDescriptionLength >= 120 && home.metaDescriptionLength <= 165 ? 'good length' : 'review length'}.` : 'No meta description.',
    status: home.metaDescription ? (home.metaDescriptionLength >= 120 && home.metaDescriptionLength <= 165 ? 'PASS' : 'WARN') : 'WARN',
  });
  rows.push({
    element: 'H1 / heading structure', value: String(home.h1.length),
    verdict: home.h1.length === 1 ? 'Exactly one H1; heading structure present.' : home.h1.length === 0 ? 'No H1 on the homepage.' : `${home.h1.length} H1s — should be one.`,
    status: home.h1.length === 1 ? 'PASS' : home.h1.length === 0 ? 'FAIL' : 'WARN',
  });
  rows.push({
    element: 'Structured data', value: home.hasSchema ? 'Present' : '—',
    verdict: home.hasSchema ? 'Structured data (schema.org) present.' : 'No structured data detected.',
    status: home.hasSchema ? 'PASS' : 'WARN',
  });
  rows.push({
    element: 'Canonical tag', value: home.canonical || '—',
    verdict: home.canonical ? `Canonical points to: ${home.canonical}` : 'No canonical tag.',
    status: home.canonical ? 'PASS' : 'WARN',
  });
  if (psi?.loadMs != null) {
    const s = psi.loadMs / 1000;
    rows.push({ element: 'Page load speed', value: `${s.toFixed(1)}s`, verdict: s <= 2 ? 'At or under the 2-second target.' : 'Above the 2-second target — losing visitors before the page paints.', status: s <= 2 ? 'PASS' : 'FAIL' });
  }
  if (psi?.performanceScore != null) {
    rows.push({ element: 'Mobile PageSpeed score', value: `${psi.performanceScore}/100`, verdict: psi.performanceScore >= 90 ? 'Strong on the version Google indexes first.' : `Below Google’s threshold on the version it indexes first.`, status: psi.performanceScore >= 90 ? 'PASS' : psi.performanceScore >= 50 ? 'WARN' : 'FAIL' });
  }
  rows.push({
    element: 'Content depth', value: `${home.wordCount.toLocaleString('en-US')} words`,
    verdict: home.wordCount >= 600 ? 'Substantial enough to rank.' : 'On the thin side for a competitive query.',
    status: home.wordCount >= 600 ? 'PASS' : 'WARN',
  });
  if (home.imagesTotal > 0) {
    const described = home.imagesTotal - home.imagesMissingAlt;
    rows.push({
      element: 'Image alt text', value: `${described} of ${home.imagesTotal} images described`,
      verdict: home.imagesMissingAlt === 0 ? 'All images have alt text.' : `${home.imagesMissingAlt} images missing alt text — lost accessibility and image-search traffic.`,
      status: home.imagesMissingAlt === 0 ? 'PASS' : 'WARN',
    });
  }
  return rows;
}

function buildOrganic(a: AuditData, so: SeoptimerReport | null | undefined, c: AuditCounts): ProposalData['organic'] {
  const positions = so && so.ok ? bucketPositions(so.keywordPositions) : [];
  const rankingKeywords = so && so.ok
    ? (Object.values(so.keywordPositions).reduce((s, n) => s + n, 0) || so.keywordRankings.length || null)
    : null;
  return {
    monthlyVisits: so && so.ok ? (so.trafficFromSearch?.total ?? null) : null,
    rankingKeywords,
    referringDomains: so && so.ok ? (so.backlinks?.referringDomains ?? null) : null,
    pagesCrawled: a.pagesCrawled,
    positions,
    backlinks: {
      total: so && so.ok ? (so.backlinks?.backlinks ?? null) : null,
      referring: so && so.ok ? (so.backlinks?.referringDomains ?? null) : null,
      dofollow: so && so.ok ? (so.backlinks?.dofollow ?? null) : null,
      eduGov: so && so.ok && so.backlinks ? `${(so.backlinks.eduBacklinks ?? 0).toLocaleString('en-US')} / ${(so.backlinks.govBacklinks ?? 0).toLocaleString('en-US')}` : '—',
    },
    onsite: {
      internalLinks: a.homepage?.internalLinks.length ?? 0,
      externalLinks: a.homepage?.externalLinks.length ?? 0,
      contentDepth: a.homepage?.wordCount ?? 0,
      aiTraffic: so && so.ok ? (so.trafficFromSearch?.ai ?? null) : null,
    },
  };
}

const SEV_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
const EXAMPLE_CAP = 12; // affected URLs shown per issue before "+N more"

function buildSiteHealth(a: AuditData): ProposalData['siteHealth'] {
  const s = a.stats;
  return {
    pagesCrawled: a.pagesCrawled,
    htmlPages: s?.htmlPages ?? 0,
    indexable: s?.indexable ?? 0,
    httpsPages: s?.httpsPages ?? 0,
    avgWords: s?.avgWords ?? 0,
    withSchema: s?.withSchema ?? 0,
    avgResponseMs: s?.avgResponseMs ?? 0,
    robotsFound: !!a.robotsTxt?.found,
    sitemapFound: !!a.sitemap?.found,
    sitemapUrlCount: a.sitemap?.urlCount ?? 0,
  };
}

function buildIssueDetail(a: AuditData): ProposalData['issueDetail'] {
  return (a.issues || [])
    .slice()
    .sort((x, y) => (SEV_RANK[y.severity] || 0) - (SEV_RANK[x.severity] || 0) || y.count - x.count)
    .map((g) => ({
      id: g.id,
      label: g.label,
      category: g.category,
      severity: g.severity.charAt(0).toUpperCase() + g.severity.slice(1),
      count: g.count,
      explanation: g.explanation,
      examples: g.examples.slice(0, EXAMPLE_CAP),
      more: Math.max(0, g.count - EXAMPLE_CAP),
    }));
}

function buildKeywordRankings(so: SeoptimerReport | null | undefined): ProposalData['keywordRankings'] {
  if (!so || !so.ok || !so.keywordRankings?.length) return [];
  return so.keywordRankings
    .slice()
    .sort((x, y) => x.position - y.position)
    .slice(0, 25)
    .map((k) => ({
      keyword: k.keyword,
      position: k.position,
      searches: k.totalSearches ?? '—',
      traffic: k.estimatedTraffic ?? '—',
    }));
}

function buildRoadmap(a: AuditData, psi: PsiResult | undefined, so: SeoptimerReport | null | undefined): ProposalData['roadmap'] {
  const bySev = (min: number, max: number) =>
    (a.issues || [])
      .filter((g) => (SEV_RANK[g.severity] || 0) >= min && (SEV_RANK[g.severity] || 0) <= max)
      .sort((x, y) => (SEV_RANK[y.severity] || 0) - (SEV_RANK[x.severity] || 0) || y.count - x.count)
      .map((g) => `${g.label} — ${g.count} page${g.count === 1 ? '' : 's'}`);

  const p1 = bySev(3, 4); // critical + high
  const slow = psi && ((psi.ttfbMs != null && psi.ttfbMs > 600) || (psi.loadMs != null && psi.loadMs > 2500));
  if (slow) p1.unshift('Cut server response / page-load time toward the 2s target (caching + CDN)');

  const p2 = bySev(2, 2); // medium
  const p3 = bySev(1, 1); // low
  const linksGrade = so && so.ok ? so.scores.links?.grade || '' : '';
  if (/^[CDEF]/.test(linksGrade)) p3.push('Launch a link-building programme to grow referring domains and authority');
  p3.push('Publish/expand content on thin and priority pages to deepen topical coverage');

  return [
    { phase: 'Phase 1', horizon: 'Weeks 1–2 · stop the bleeding', items: p1.length ? p1 : ['No critical or high-severity issues found — hold this line.'] },
    { phase: 'Phase 2', horizon: 'Weeks 3–6 · tighten the foundations', items: p2.length ? p2 : ['No medium-severity issues outstanding.'] },
    { phase: 'Phase 3', horizon: 'Weeks 7–12 · grow authority & depth', items: [...new Set(p3)] },
  ];
}

function bucketPositions(dist: Record<string, number>): { label: string; count: number }[] {
  // SEOptimer buckets: "Position 1", "Position 2-3", "Position 4-10", "Position 11-20", "Position 21-30", "Position 31-100"
  const get = (k: string) => dist[k] || 0;
  const p1 = get('Position 1');
  const p23 = get('Position 2-3');
  return [
    { label: 'Positions 1-3', count: p1 + p23 },
    { label: 'Page 1 (4-10)', count: get('Position 4-10') },
    { label: 'Page 2 (11-20)', count: get('Position 11-20') },
    { label: 'Positions 21-50', count: get('Position 21-30') },
    { label: 'Positions 51-100', count: get('Position 31-100') },
  ];
}
