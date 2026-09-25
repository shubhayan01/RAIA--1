import { pageSpeed, PsiResult } from '../sources/psi';
import { requestOnce, followChain } from '../lib/http';
import { parseHtml, safeOrigin } from '../lib/html';
import { pool } from '../lib/concurrency';
import { normalizeDomain } from '../sources/webscrape';
import { Report, b } from '../lib/report';

/**
 * Lightweight audit (the "Run Audit" tool + the SEO hook inside prospect
 * research, Feature 1 Step 2).
 *
 * NOVA is a separate app from SAGE, so rather than reaching into SAGE's process
 * it runs its OWN lightweight audit from the shared building blocks copied out of
 * SAGE: Google Lighthouse (PageSpeed Insights — real data) plus a shallow crawl
 * (homepage + a few internal links) for missing/duplicate title & meta counts.
 * Everything here is measured — the LLM never sees or invents these numbers.
 *
 * (If you want the FULL SAGE crawl instead, point outreach at SAGE's own
 *  /api/report endpoint — see README "Run Audit" notes.)
 */

export interface LightAuditResult {
  domain: string;
  url: string;
  reachable: boolean;
  lighthouse: {
    performance: number | null;
    seo: number | null;
    accessibility: number | null;
    bestPractices: number | null;
  };
  coreWebVitals: { lcpMs: number | null; cls: number | null; inpMs: number | null; pass: boolean | null };
  topIssues: string[];      // top 3 SEO issues (from Lighthouse + crawl)
  pagesCrawled: number;
  missingTitle: number;
  missingMeta: number;
  psiError?: string;
  error?: string;
}

export async function lightweightAudit(domainRaw: string, opts: { maxPages?: number } = {}): Promise<LightAuditResult> {
  const domain = normalizeDomain(domainRaw);
  const res: LightAuditResult = {
    domain,
    url: `https://${domain}`,
    reachable: false,
    lighthouse: { performance: null, seo: null, accessibility: null, bestPractices: null },
    coreWebVitals: { lcpMs: null, cls: null, inpMs: null, pass: null },
    topIssues: [],
    pagesCrawled: 0,
    missingTitle: 0,
    missingMeta: 0,
  };

  // Resolve homepage
  let home = `https://${domain}`;
  try {
    const chain = await followChain(home);
    if (chain.final?.finalUrl && chain.final.status < 400) home = chain.final.finalUrl;
  } catch { /* keep default */ }
  res.url = home;
  const origin = safeOrigin(home) || home;

  // Shallow crawl (homepage + up to maxPages internal links) — real on-page checks.
  const maxPages = Math.min(opts.maxPages || 8, 20);
  const homeRes = await requestOnce(home);
  if (!homeRes.ok || !homeRes.body) {
    res.error = homeRes.error || `homepage returned ${homeRes.status}`;
  } else {
    res.reachable = true;
    const home$ = parseHtml(homeRes.body, home);
    const links = home$.internalLinks
      .filter((u) => safeOrigin(u) === origin && !/\.(jpg|jpeg|png|gif|svg|css|js|pdf|zip|xml)(\?|$)/i.test(u))
      .slice(0, maxPages - 1);

    const parsed = [home$, ...(await pool(links, 4, async (u) => {
      const r = await requestOnce(u).catch(() => null);
      return r && r.ok && r.body ? parseHtml(r.body, u) : null;
    })).filter(Boolean)] as ReturnType<typeof parseHtml>[];

    res.pagesCrawled = parsed.length;
    res.missingTitle = parsed.filter((p) => !p.title).length;
    res.missingMeta = parsed.filter((p) => !p.metaDescription).length;
  }

  // Google Lighthouse (mobile) — trusted, free data.
  const psi: PsiResult = await pageSpeed(home, 'mobile').catch((e) => ({ error: String(e) } as any));
  if (psi && !psi.error) {
    res.lighthouse = {
      performance: psi.performanceScore,
      seo: psi.seoScore,
      accessibility: psi.accessibilityScore,
      bestPractices: psi.bestPracticesScore,
    };
    const cwvPass = psi.lcpMs != null && psi.cls != null
      ? psi.lcpMs <= 2500 && psi.cls <= 0.1 && (psi.inpMs == null || psi.inpMs <= 200)
      : null;
    res.coreWebVitals = { lcpMs: psi.lcpMs, cls: psi.cls, inpMs: psi.inpMs, pass: cwvPass };
    res.topIssues = buildTopIssues(psi, res);
  } else {
    res.psiError = psi?.error || 'PageSpeed unavailable';
    res.topIssues = buildTopIssues(null, res);
  }

  return res;
}

function buildTopIssues(psi: PsiResult | null, res: LightAuditResult): string[] {
  const issues: string[] = [];
  if (res.missingTitle > 0) issues.push(`${res.missingTitle} of ${res.pagesCrawled} crawled pages missing a <title> tag`);
  if (res.missingMeta > 0) issues.push(`${res.missingMeta} of ${res.pagesCrawled} crawled pages missing a meta description`);
  if (psi) {
    if (psi.performanceScore != null && psi.performanceScore < 50) issues.push(`Poor mobile performance (Lighthouse ${psi.performanceScore}/100)`);
    if (res.coreWebVitals.pass === false) issues.push('Failing Core Web Vitals (LCP/CLS/INP thresholds)');
    for (const s of psi.seoIssues.slice(0, 3)) issues.push(`SEO: ${s}`);
  }
  return issues.slice(0, 3);
}

/** Render a lightweight audit as Report blocks (the "Run Audit" mode). */
export function auditToReport(a: LightAuditResult): Report {
  const blocks = [];
  const fmt = (n: number | null) => (n == null ? '—' : `${n}/100`);

  if (!a.reachable) {
    return {
      tag: 'Audit', title: `Could not reach ${a.domain}`,
      blocks: [b.note(a.error || 'The homepage did not respond.')],
      data: a,
    };
  }

  blocks.push(b.p(`Lightweight SEO snapshot for ${a.domain} — Google Lighthouse (mobile) plus a shallow crawl of ${a.pagesCrawled} page${a.pagesCrawled === 1 ? '' : 's'}. Every number is measured, not inferred.`));

  blocks.push(b.table(
    ['Performance', 'SEO', 'Accessibility', 'Best practices'],
    [[fmt(a.lighthouse.performance), fmt(a.lighthouse.seo), fmt(a.lighthouse.accessibility), fmt(a.lighthouse.bestPractices)]],
  ));

  const cwv = a.coreWebVitals;
  blocks.push(b.kv([
    { k: 'Core Web Vitals', v: cwv.pass == null ? 'No field/lab data' : cwv.pass ? 'PASS' : 'FAIL' },
    { k: 'LCP', v: cwv.lcpMs != null ? `${(cwv.lcpMs / 1000).toFixed(1)}s` : '—' },
    { k: 'CLS', v: cwv.cls != null ? cwv.cls.toFixed(2) : '—' },
    { k: 'INP', v: cwv.inpMs != null ? `${cwv.inpMs}ms` : '—' },
    { k: 'Missing titles', v: `${a.missingTitle} / ${a.pagesCrawled} pages` },
    { k: 'Missing meta', v: `${a.missingMeta} / ${a.pagesCrawled} pages` },
  ]));

  if (a.topIssues.length) {
    blocks.push(b.p('Top issues (the outreach hook):'));
    blocks.push(b.list(a.topIssues));
  }
  if (a.psiError) blocks.push(b.note(`Lighthouse unavailable (${a.psiError}) — crawl-based on-page checks above are unaffected. Add PAGESPEED_API_KEY to raise the rate limit.`));

  return { tag: 'Audit', title: `Audit — ${a.domain}`, blocks, data: a };
}
