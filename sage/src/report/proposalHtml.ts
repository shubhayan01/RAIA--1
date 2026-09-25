import { ProposalData, Status } from '../services/proposal';

/**
 * Renders a ProposalData model into a self-contained, print-ready HTML document
 * (branded client audit / growth proposal). All CSS is inline; a small toolbar
 * (Download PDF / Print) is hidden when printing. The same route with
 * ?format=pdf renders this exact HTML to a PDF via headless Chromium.
 */
export function renderProposalHtml(d: ProposalData, opts: { pdfHref?: string; forPdf?: boolean } = {}): string {
  const title = `${d.brand} · SEO / GEO / AEO Growth Proposal`;
  const date = new Date(d.generatedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
${opts.forPdf ? '' : toolbar(opts.pdfHref)}
<main class="doc">

  <header class="cover">
    <div class="cover-brand">${esc(d.brand)}</div>
    <h1>SEO / GEO / AEO<br/>Growth Proposal</h1>
    <div class="cover-sub">Prepared for <strong>${esc(d.domain)}</strong> · ${esc(date)}</div>
    <p class="cover-note">Every figure in this report was measured live — a full crawl of the site, Google Lighthouse, and third-party authority &amp; ranking data. Nothing here is estimated by an AI.</p>
  </header>

  ${d.cards.length ? section('At a glance', `
    <div class="cards">
      ${d.cards.map(cardHtml).join('')}
    </div>
    <div class="summary">
      ${summaryPill(d.summary.passing, 'PASSING', 'ok')}
      ${summaryPill(d.summary.toImprove, 'TO IMPROVE', 'warn')}
      ${summaryPill(d.summary.toFix, 'TO FIX', 'bad')}
      ${summaryPill(d.summary.forReview, 'FOR REVIEW', 'review')}
    </div>
  `) : ''}

  ${section('The audit · critical issues', `
    <p class="lead">What’s holding your rankings back — every row below is something the audit measured, ranked worst-first, with what it’s costing you in plain English.</p>
    <table class="grid">
      <thead><tr><th>Issue</th><th>What we found</th><th>Extent</th><th>Impact on rankings</th><th>Severity</th></tr></thead>
      <tbody>
        ${d.criticalIssues.map((r) => `<tr>
          <td class="strong">${esc(r.issue)}</td>
          <td>${esc(r.found)}</td>
          <td class="nowrap">${esc(r.extent)}</td>
          <td class="muted">${esc(r.impact)}</td>
          <td>${sev(r.severity)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    ${d.quickWins.length ? `<h3 class="subhead">Quick wins we can start with</h3>
    <ul class="wins">${d.quickWins.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
  `)}

  ${section('The audit · on-page &amp; technical', `
    <p class="lead">Speed, mobile, and the on-page foundations search engines weigh directly.</p>
    <div class="metrics">
      ${bigMetric(d.tech.loadSeconds != null ? d.tech.loadSeconds + 's' : '—', 'Page load', 'Target: under 2s')}
      ${bigMetric(d.tech.mobileScore != null ? String(d.tech.mobileScore) : '—', 'Mobile speed', 'Google indexes mobile first')}
      ${bigMetric(d.tech.desktopScore != null ? String(d.tech.desktopScore) : '—', 'Desktop speed', 'out of 100')}
      ${bigMetric(d.tech.pageWeightBytes != null ? (d.tech.pageWeightBytes / 1048576).toFixed(1) + 'MB' : '—', 'Page weight', 'homepage payload')}
    </div>
    <h3 class="subhead">Core Web Vitals — Google’s page-experience signals ${d.tech.fieldData ? '<span class="tag">field data</span>' : '<span class="tag">lab</span>'}</h3>
    <div class="cwv">
      ${cwv('LCP', d.tech.lcpMs != null ? (d.tech.lcpMs / 1000).toFixed(1) + 's' : '—', d.tech.lcpMs != null && d.tech.lcpMs <= 2500, 'Largest Contentful Paint — good ≤ 2.5s')}
      ${cwv('CLS', d.tech.cls != null ? d.tech.cls.toFixed(2) : '—', d.tech.cls != null && d.tech.cls <= 0.1, 'Cumulative Layout Shift — good ≤ 0.1')}
      ${cwv('INP', d.tech.inpMs != null ? d.tech.inpMs + 'ms' : '—', d.tech.inpMs != null && d.tech.inpMs <= 200, 'Interaction to Next Paint — good ≤ 200ms')}
    </div>
    <h3 class="subhead">Whole-site issues — across ${d.organic.pagesCrawled} crawled pages</h3>
    <table class="grid">
      <thead><tr><th>Issue</th><th>Extent</th><th>What it means</th><th>Status</th></tr></thead>
      <tbody>${d.wholeSite.map((r) => `<tr>
        <td class="strong">${esc(r.issue)}</td>
        <td class="nowrap">${esc(r.extent)}</td>
        <td class="muted">${esc(r.meaning)}</td>
        <td>${status(r.status)}</td>
      </tr>`).join('')}</tbody>
    </table>
    ${d.homepage.length ? `<h3 class="subhead">Homepage on-page elements</h3>
    <table class="grid">
      <thead><tr><th>Element</th><th>What’s there now</th><th>Verdict</th><th>Status</th></tr></thead>
      <tbody>${d.homepage.map((r) => `<tr>
        <td class="strong">${esc(r.element)}</td>
        <td class="clip">${esc(r.value)}</td>
        <td class="muted">${esc(r.verdict)}</td>
        <td>${status(r.status)}</td>
      </tr>`).join('')}</tbody>
    </table>` : ''}
  `)}

  ${d.hasSeoptimer ? section('The audit · organic search', `
    <p class="lead">Domain-wide organic visibility for ${esc(d.domain)} — the traffic you earn today, the keywords behind it, and the authority holding it up.</p>
    <div class="metrics">
      ${bigMetric(fmt(d.organic.monthlyVisits), 'Monthly organic visits', 'current estimate')}
      ${bigMetric(fmt(d.organic.rankingKeywords), 'Ranking keywords', 'across all positions')}
      ${bigMetric(fmt(d.organic.referringDomains), 'Referring domains', 'off-page authority')}
      ${bigMetric(String(d.organic.pagesCrawled), 'Pages crawled', 'whole-domain audit')}
    </div>
    <h3 class="subhead">Where your keywords rank</h3>
    <div class="bars">
      ${(() => { const max = Math.max(1, ...d.organic.positions.map((p) => p.count)); return d.organic.positions.map((p) => `
        <div class="bar-row"><span class="bar-label">${esc(p.label)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${Math.round((p.count / max) * 100)}%"></span></span>
        <span class="bar-val">${p.count}</span></div>`).join(''); })()}
    </div>
    <p class="hint">The keywords in positions 11–100 are the fastest wins: already ranking, one page away from the traffic that converts.</p>
    <div class="two-col">
      <div class="panel">
        <h4>Backlink profile</h4>
        <div class="kv"><span>Total backlinks</span><b>${fmt(d.organic.backlinks.total)}</b></div>
        <div class="kv"><span>Referring domains</span><b>${fmt(d.organic.backlinks.referring)}</b></div>
        <div class="kv"><span>Dofollow links</span><b>${fmt(d.organic.backlinks.dofollow)}</b></div>
        <div class="kv"><span>.edu / .gov links</span><b>${esc(d.organic.backlinks.eduGov)}</b></div>
      </div>
      <div class="panel">
        <h4>On-site signals</h4>
        <div class="kv"><span>Internal links (homepage)</span><b>${fmt(d.organic.onsite.internalLinks)}</b></div>
        <div class="kv"><span>External links (homepage)</span><b>${fmt(d.organic.onsite.externalLinks)}</b></div>
        <div class="kv"><span>Homepage content depth</span><b>${fmt(d.organic.onsite.contentDepth)} words</b></div>
        <div class="kv"><span>Est. AI-search traffic</span><b>${fmt(d.organic.onsite.aiTraffic)}</b></div>
      </div>
    </div>
  `) : `<div class="section"><p class="muted">Add a <code>SEOPTIMER_API_KEY</code> to include organic visibility, keyword rankings, and the backlink profile in this report.</p></div>`}

  ${section('The audit · crawl health', `
    <p class="lead">A whole-site snapshot from the crawl of ${d.siteHealth.pagesCrawled} pages — the foundations everything else sits on.</p>
    <div class="metrics">
      ${bigMetric(String(d.siteHealth.indexable), 'Indexable pages', `of ${d.siteHealth.htmlPages} HTML pages crawled`)}
      ${bigMetric(pct(d.siteHealth.httpsPages, d.siteHealth.pagesCrawled), 'Served over HTTPS', `${d.siteHealth.httpsPages} of ${d.siteHealth.pagesCrawled} pages`)}
      ${bigMetric(pct(d.siteHealth.withSchema, d.siteHealth.htmlPages), 'With structured data', `${d.siteHealth.withSchema} of ${d.siteHealth.htmlPages} pages`)}
      ${bigMetric(d.siteHealth.avgResponseMs ? d.siteHealth.avgResponseMs + 'ms' : '—', 'Avg. response time', 'across all crawled pages')}
    </div>
    <div class="two-col">
      <div class="panel">
        <h4>Content &amp; crawlability</h4>
        <div class="kv"><span>Average words per page</span><b>${fmt(d.siteHealth.avgWords)}</b></div>
        <div class="kv"><span>robots.txt</span><b>${d.siteHealth.robotsFound ? 'Found' : 'Missing'}</b></div>
        <div class="kv"><span>XML sitemap</span><b>${d.siteHealth.sitemapFound ? 'Found' : 'Missing'}</b></div>
        <div class="kv"><span>URLs in sitemap</span><b>${fmt(d.siteHealth.sitemapUrlCount)}</b></div>
      </div>
      <div class="panel">
        <h4>What this tells us</h4>
        <p class="muted" style="margin:0;font-size:12.5px">Indexable pages are the ones eligible to appear in Google. HTTPS and structured-data coverage are trust and rich-result signals; a fast average response keeps crawl budget flowing. Anything short here is expanded, with the exact pages, in the issue log below.</p>
      </div>
    </div>
  `)}

  ${d.keywordRankings.length ? section('The audit · keyword rankings', `
    <p class="lead">The keywords ${esc(d.domain)} already ranks for — sorted best-first. These are the terms to defend and the near-misses to push onto page one.</p>
    <table class="grid">
      <thead><tr><th>Keyword</th><th class="nowrap">Position</th><th class="nowrap">Monthly searches</th><th class="nowrap">Est. traffic</th></tr></thead>
      <tbody>${d.keywordRankings.map((k) => `<tr>
        <td class="strong">${esc(k.keyword)}</td>
        <td>${posPill(k.position)}</td>
        <td class="nowrap">${esc(k.searches)}</td>
        <td class="nowrap">${esc(k.traffic)}</td>
      </tr>`).join('')}</tbody>
    </table>
  `) : ''}

  ${d.issueDetail.length ? section('The audit · issue log', `
    <p class="lead">Every issue the crawl detected, worst-first, with the exact pages it found them on — so the fixes are unambiguous.</p>
    <div class="issues">
      ${d.issueDetail.map(issueCard).join('')}
    </div>
  `) : ''}

  ${section('The plan · your first 90 days', `
    <p class="lead">A sequenced plan built from the findings above — worst-first, so effort lands where it moves rankings soonest.</p>
    <div class="roadmap">
      ${d.roadmap.map((ph, i) => `<div class="phase">
        <div class="phase-head"><span class="phase-no">${i + 1}</span><div><div class="phase-name">${esc(ph.phase)}</div><div class="phase-horizon">${esc(ph.horizon)}</div></div></div>
        <ul class="phase-list">${ph.items.map((it) => `<li>${esc(it)}</li>`).join('')}</ul>
      </div>`).join('')}
    </div>
  `)}

  <footer class="foot">${esc(d.brand)} · SEO / GEO / AEO Growth Proposal &nbsp;·&nbsp; ${esc(d.domain)}</footer>
</main>
</body></html>`;
}

/* ------------------------------- pieces --------------------------------- */

function toolbar(pdfHref?: string): string {
  return `<div class="toolbar" id="toolbar">
    <span class="tb-title">Audit report ready</span>
    <span class="tb-actions">
      ${pdfHref ? `<a class="tb-btn primary" href="${esc(pdfHref)}">⬇ Download PDF</a>` : ''}
      <button class="tb-btn" onclick="window.print()">🖨 Print</button>
    </span>
  </div>`;
}

function section(heading: string, inner: string): string {
  return `<section class="section"><div class="section-eyebrow">${heading}</div>${inner}</section>`;
}

function cardHtml(c: { key: string; label: string; grade: string; passing: number; issues: number }): string {
  return `<div class="card ${gradeClass(c.grade)}">
    <div class="card-grade">${esc(c.grade)}</div>
    <div class="card-label">${esc(c.label)}</div>
    <div class="card-meta">${c.passing} passing · ${c.issues} to fix</div>
  </div>`;
}

function summaryPill(n: number, label: string, kind: string): string {
  return `<div class="spill ${kind}"><b>${n}</b><span>${label}</span></div>`;
}

function bigMetric(value: string, label: string, sub: string): string {
  return `<div class="metric"><div class="metric-val">${esc(value)}</div><div class="metric-label">${esc(label)}</div><div class="metric-sub">${esc(sub)}</div></div>`;
}

function cwv(name: string, value: string, good: boolean, desc: string): string {
  return `<div class="cwv-item"><div class="cwv-top"><span class="cwv-name">${esc(name)}</span><span class="cwv-badge ${good ? 'ok' : 'bad'}">${good ? 'GOOD' : 'POOR'}</span></div>
    <div class="cwv-val">${esc(value)}</div><div class="cwv-desc">${esc(desc)}</div></div>`;
}

function sev(s: string): string {
  const k = s.toLowerCase();
  return `<span class="pill sev-${k}">${esc(s)}</span>`;
}

function pct(n: number, of: number): string {
  if (!of) return '—';
  return Math.round((n / of) * 100) + '%';
}

function posPill(p: number): string {
  const cls = p <= 3 ? 'st-pass' : p <= 10 ? 'st-warn' : 'st-fail';
  return `<span class="pill ${cls}">#${p}</span>`;
}

function issueCard(g: { label: string; category: string; severity: string; count: number; explanation: string; examples: string[]; more: number }): string {
  return `<div class="issue">
    <div class="issue-top">
      <span class="issue-label">${esc(g.label)}</span>
      <span class="issue-meta">${sev(g.severity)}<span class="issue-count">${g.count} affected</span></span>
    </div>
    <p class="issue-why">${esc(g.explanation)}</p>
    ${g.examples.length ? `<ul class="urls">${g.examples.map((u) => `<li>${esc(u)}</li>`).join('')}${g.more > 0 ? `<li class="more">+${g.more} more</li>` : ''}</ul>` : ''}
  </div>`;
}
function status(s: Status): string {
  return `<span class="pill st-${s.toLowerCase()}">${s}</span>`;
}
function gradeClass(g: string): string {
  const c = (g || '').trim().charAt(0).toUpperCase();
  return c === 'A' ? 'g-a' : c === 'B' ? 'g-b' : c === 'C' ? 'g-c' : c === 'D' ? 'g-d' : c === 'F' || c === 'E' ? 'g-f' : 'g-none';
}
function fmt(n: number | null | undefined): string {
  return n == null ? '—' : n.toLocaleString('en-US');
}
function esc(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

/* --------------------------------- CSS ---------------------------------- */

const CSS = `
:root{
  --ink:#141821; --muted:#5b6472; --line:#e6e9ef; --bg:#ffffff; --soft:#f6f8fb;
  --accent:#3b6ef6; --accent-ink:#1f47b8;
  --ok:#1a8f5a; --ok-bg:#e6f6ee; --warn:#b9791a; --warn-bg:#fdf1de; --bad:#c23b3b; --bad-bg:#fbe8e8; --review:#5b6472; --review-bg:#eef1f6;
  --g-a:#1a8f5a; --g-b:#3aa0a0; --g-c:#b9791a; --g-d:#d1712a; --g-f:#c23b3b;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#eceff4;color:var(--ink);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.doc{max-width:960px;margin:0 auto;background:var(--bg)}
.toolbar{position:sticky;top:0;z-index:10;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 18px;background:#0f1420;color:#fff}
.tb-title{font-weight:600;font-size:13px;letter-spacing:.02em}
.tb-actions{display:flex;gap:8px}
.tb-btn{display:inline-block;padding:7px 14px;border-radius:8px;border:1px solid rgba(255,255,255,.25);background:transparent;color:#fff;font:inherit;font-size:13px;font-weight:600;cursor:pointer;text-decoration:none}
.tb-btn.primary{background:var(--accent);border-color:var(--accent)}
.tb-btn:hover{opacity:.9}

.cover{padding:64px 56px 40px;border-bottom:1px solid var(--line);background:linear-gradient(180deg,#f7f9fe, #ffffff)}
.cover-brand{font-weight:700;letter-spacing:.14em;text-transform:uppercase;font-size:12px;color:var(--accent-ink)}
.cover h1{font-size:44px;line-height:1.05;margin:16px 0 12px;letter-spacing:-.02em}
.cover-sub{font-size:16px;color:var(--muted)}
.cover-note{margin-top:20px;max-width:640px;color:var(--muted);font-size:13.5px}

.section{padding:34px 56px;border-bottom:1px solid var(--line)}
.section-eyebrow{font-size:11px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--accent-ink);margin-bottom:14px}
.lead{font-size:15px;color:var(--ink);margin:0 0 18px}
.subhead{font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:26px 0 12px}
.hint{color:var(--muted);font-size:13px;font-style:italic;margin:12px 0 0}
.muted{color:var(--muted)} .strong{font-weight:600} .nowrap{white-space:nowrap}
.clip{max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tag{display:inline-block;margin-left:6px;padding:2px 8px;border-radius:99px;background:var(--soft);border:1px solid var(--line);font-size:10px;font-weight:700;letter-spacing:.06em;color:var(--muted);vertical-align:middle}

.cards{display:grid;grid-template-columns:repeat(5,1fr);gap:12px}
.card{border:1px solid var(--line);border-radius:14px;padding:16px 14px;text-align:center;background:var(--soft)}
.card-grade{font-size:34px;font-weight:800;line-height:1}
.card-label{margin-top:8px;font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--ink)}
.card-meta{margin-top:6px;font-size:11px;color:var(--muted)}
.card.g-a .card-grade{color:var(--g-a)} .card.g-b .card-grade{color:var(--g-b)} .card.g-c .card-grade{color:var(--g-c)} .card.g-d .card-grade{color:var(--g-d)} .card.g-f .card-grade{color:var(--g-f)} .card.g-none .card-grade{color:var(--muted)}

.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:14px}
.spill{border-radius:12px;padding:14px;text-align:center}
.spill b{display:block;font-size:26px;font-weight:800;line-height:1}
.spill span{font-size:11px;font-weight:700;letter-spacing:.06em}
.spill.ok{background:var(--ok-bg);color:var(--ok)} .spill.warn{background:var(--warn-bg);color:var(--warn)} .spill.bad{background:var(--bad-bg);color:var(--bad)} .spill.review{background:var(--review-bg);color:var(--review)}

table.grid{width:100%;border-collapse:collapse;font-size:12.5px}
table.grid th{text-align:left;font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);border-bottom:1.5px solid var(--line);padding:9px 10px;font-weight:700}
table.grid td{padding:10px;border-bottom:1px solid var(--line);vertical-align:top}
table.grid tbody tr:nth-child(even){background:var(--soft)}

.pill{display:inline-block;padding:3px 10px;border-radius:99px;font-size:11px;font-weight:700;letter-spacing:.02em;white-space:nowrap}
.sev-high{background:var(--bad-bg);color:var(--bad)} .sev-medium{background:var(--warn-bg);color:var(--warn)} .sev-low{background:var(--review-bg);color:var(--review)}
.st-pass{background:var(--ok-bg);color:var(--ok)} .st-warn{background:var(--warn-bg);color:var(--warn)} .st-fail{background:var(--bad-bg);color:var(--bad)}

.wins{margin:8px 0 0;padding:0;list-style:none}
.wins li{position:relative;padding:8px 8px 8px 30px;border-bottom:1px solid var(--line);font-size:13px}
.wins li:before{content:"✓";position:absolute;left:8px;top:8px;color:var(--ok);font-weight:800}

.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.metric{border:1px solid var(--line);border-radius:14px;padding:16px;background:var(--soft)}
.metric-val{font-size:30px;font-weight:800;line-height:1;letter-spacing:-.02em}
.metric-label{margin-top:8px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
.metric-sub{margin-top:4px;font-size:11px;color:var(--muted)}

.cwv{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.cwv-item{border:1px solid var(--line);border-radius:14px;padding:16px}
.cwv-top{display:flex;justify-content:space-between;align-items:center}
.cwv-name{font-weight:700;font-size:13px}
.cwv-badge{font-size:10px;font-weight:800;letter-spacing:.05em;padding:2px 8px;border-radius:99px}
.cwv-badge.ok{background:var(--ok-bg);color:var(--ok)} .cwv-badge.bad{background:var(--bad-bg);color:var(--bad)}
.cwv-val{font-size:26px;font-weight:800;margin:8px 0 4px} .cwv-desc{font-size:11px;color:var(--muted)}

.bars{display:flex;flex-direction:column;gap:8px}
.bar-row{display:grid;grid-template-columns:130px 1fr 44px;align-items:center;gap:10px;font-size:12.5px}
.bar-label{color:var(--muted)} .bar-val{text-align:right;font-weight:700}
.bar-track{height:12px;background:var(--soft);border-radius:99px;overflow:hidden;border:1px solid var(--line)}
.bar-fill{display:block;height:100%;background:linear-gradient(90deg,var(--accent),#7aa2ff)}

.two-col{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:16px}
.panel{border:1px solid var(--line);border-radius:14px;padding:16px 18px;background:var(--soft)}
.panel h4{margin:0 0 10px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.kv{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--line);font-size:13px}
.kv:last-child{border-bottom:0}
.kv b{font-weight:700}
code{background:var(--soft);padding:2px 6px;border-radius:6px;font-size:12px}

.issues{display:flex;flex-direction:column;gap:12px}
.issue{border:1px solid var(--line);border-radius:14px;padding:14px 16px;background:var(--soft);page-break-inside:avoid}
.issue-top{display:flex;justify-content:space-between;align-items:center;gap:12px}
.issue-label{font-weight:700;font-size:14px}
.issue-meta{display:flex;align-items:center;gap:8px;white-space:nowrap}
.issue-count{font-size:11px;font-weight:700;color:var(--muted)}
.issue-why{margin:8px 0 10px;color:var(--muted);font-size:12.5px}
.urls{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:3px}
.urls li{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:4px 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.urls li.more{background:transparent;border:0;color:var(--muted);font-style:italic;padding-left:2px}

.roadmap{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.phase{border:1px solid var(--line);border-radius:14px;padding:16px;background:var(--soft);page-break-inside:avoid}
.phase-head{display:flex;align-items:center;gap:10px;margin-bottom:12px}
.phase-no{display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:99px;background:var(--accent);color:#fff;font-weight:800;font-size:14px;flex:none}
.phase-name{font-weight:700;font-size:13px}
.phase-horizon{font-size:11px;color:var(--muted)}
.phase-list{margin:0;padding-left:18px}
.phase-list li{font-size:12.5px;margin-bottom:6px}

.foot{padding:22px 56px;color:var(--muted);font-size:11.5px;text-align:center}

@media print{
  html,body{background:#fff}
  .toolbar{display:none}
  .doc{max-width:none;margin:0}
  .section,.cover{padding-left:36px;padding-right:36px;page-break-inside:avoid}
  .card,.metric,.cwv-item,.panel,table.grid tr{page-break-inside:avoid}
  @page{margin:14mm}
}
@media (max-width:720px){
  .cards,.summary,.metrics,.cwv,.two-col,.roadmap{grid-template-columns:1fr 1fr}
  .roadmap{grid-template-columns:1fr}
  .cover,.section,.foot{padding-left:24px;padding-right:24px}
}
`;
