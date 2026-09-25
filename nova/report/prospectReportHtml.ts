/**
 * Branded Full Prospect Report (Feature 8). Self-contained print-ready HTML with
 * inline CSS (amber/gold accent — NOVA's colour). Same pattern as SAGE's
 * proposalHtml.ts; ?format=pdf renders this exact HTML via headless Chromium.
 */

export interface ProspectReportModel {
  brand: string;
  generatedAt: string;
  domain: string;
  companyName: string;
  snapshot: string;
  painPoints: { problem: string; evidence: string; consequence: string; solution: string }[];
  pitchAngle: string;
  audit: {
    performance: number | null; seo: number | null; accessibility: number | null; bestPractices: number | null;
    cwv: string; topIssues: string[]; pagesCrawled: number; missingTitle: number; missingMeta: number;
  };
  social: { platform: string; status: string }[];
  outreach: { when: string; kind: string; subject: string; detail: string }[];
  pipeline: { stage: string; history: { stage: string; changedAt: string; note?: string }[] };
  meetings: { when: string; title: string; status: string }[];
  nextAction: string;
  riskFlags: string;
}

export function renderProspectReportHtml(d: ProspectReportModel, opts: { pdfHref?: string; forPdf?: boolean } = {}): string {
  const date = new Date(d.generatedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const score = (n: number | null) => (n == null ? '—' : String(n));

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(d.brand)} · Prospect Report · ${esc(d.companyName)}</title>
<style>${CSS}</style>
</head>
<body>
${opts.forPdf ? '' : toolbar(opts.pdfHref)}
<main class="doc">
  <header class="cover">
    <div class="cover-brand">${esc(d.brand)}</div>
    <h1>Prospect Intelligence Report</h1>
    <div class="cover-sub">${esc(d.companyName)} · ${esc(d.domain)} · ${esc(date)}</div>
    <p class="cover-note">Everything below was measured or scraped live — website research, Google Lighthouse, social signals and the CRM record. The pitch narrative is written from that data; nothing is invented.</p>
  </header>

  ${section('1 · Company snapshot & pain points', `
    <p class="lead">${esc(d.snapshot)}</p>
    ${d.pitchAngle ? `<div class="hook"><b>Pitch angle:</b> ${esc(d.pitchAngle)}</div>` : ''}
    ${d.painPoints.length ? `<table class="grid"><thead><tr><th>Problem</th><th>Evidence</th><th>Consequence</th><th>How we fix it</th></tr></thead>
    <tbody>${d.painPoints.map((p) => `<tr><td class="strong">${esc(p.problem)}</td><td>${esc(p.evidence)}</td><td class="muted">${esc(p.consequence)}</td><td>${esc(p.solution)}</td></tr>`).join('')}</tbody></table>` : ''}
  `)}

  ${section('2 · SEO audit', `
    <div class="metrics">
      ${metric(score(d.audit.performance), 'Performance', 'Lighthouse mobile')}
      ${metric(score(d.audit.seo), 'SEO', 'Lighthouse')}
      ${metric(score(d.audit.accessibility), 'Accessibility', 'Lighthouse')}
      ${metric(d.audit.cwv, 'Core Web Vitals', 'pass / fail')}
    </div>
    <div class="panel">
      <div class="kv"><span>Pages crawled</span><b>${d.audit.pagesCrawled}</b></div>
      <div class="kv"><span>Missing titles</span><b>${d.audit.missingTitle}</b></div>
      <div class="kv"><span>Missing meta descriptions</span><b>${d.audit.missingMeta}</b></div>
    </div>
    ${d.audit.topIssues.length ? `<h3 class="subhead">Top issues (the hook)</h3><ul class="wins">${d.audit.topIssues.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}
  `)}

  ${section('3 · Social signals', d.social.length
    ? `<table class="grid"><thead><tr><th>Platform</th><th>Signal</th></tr></thead><tbody>${d.social.map((s) => `<tr><td class="strong">${esc(s.platform)}</td><td class="muted">${esc(s.status)}</td></tr>`).join('')}</tbody></table>`
    : `<p class="muted">No social profiles were found on the site, or public data was blocked.</p>`)}

  ${section('4 · Outreach history', d.outreach.length
    ? `<table class="grid"><thead><tr><th>When</th><th>Type</th><th>Subject</th><th>Detail</th></tr></thead><tbody>${d.outreach.map((o) => `<tr><td class="nowrap">${esc(o.when)}</td><td>${esc(o.kind)}</td><td class="strong">${esc(o.subject)}</td><td class="muted">${esc(o.detail)}</td></tr>`).join('')}</tbody></table>`
    : `<p class="muted">No outreach sent yet.</p>`)}

  ${section('5 · Pipeline', `
    <div class="hook"><b>Current stage:</b> ${esc(d.pipeline.stage)}</div>
    ${d.pipeline.history.length ? `<table class="grid"><thead><tr><th>Stage</th><th>Changed</th><th>Note</th></tr></thead><tbody>${d.pipeline.history.map((h) => `<tr><td class="strong">${esc(h.stage)}</td><td class="nowrap">${esc(new Date(h.changedAt).toLocaleDateString('en-US'))}</td><td class="muted">${esc(h.note || '')}</td></tr>`).join('')}</tbody></table>` : ''}
  `)}

  ${section('6 · Meetings', d.meetings.length
    ? `<table class="grid"><thead><tr><th>When</th><th>Title</th><th>Status</th></tr></thead><tbody>${d.meetings.map((m) => `<tr><td class="nowrap">${esc(m.when)}</td><td class="strong">${esc(m.title)}</td><td>${esc(m.status)}</td></tr>`).join('')}</tbody></table>`
    : `<p class="muted">No meetings scheduled.</p>`)}

  ${section('7 · Recommended next action', `
    <div class="hook big">${esc(d.nextAction)}</div>
    ${d.riskFlags ? `<p class="muted"><b>Risk flags:</b> ${esc(d.riskFlags)}</p>` : ''}
  `)}

  <footer class="foot">${esc(d.brand)} · Prospect Intelligence Report · ${esc(d.domain)}</footer>
</main>
</body></html>`;
}

function toolbar(pdfHref?: string): string {
  return `<div class="toolbar"><span class="tb-title">Prospect report ready</span><span class="tb-actions">${pdfHref ? `<a class="tb-btn primary" href="${esc(pdfHref)}">⬇ Download PDF</a>` : ''}<button class="tb-btn" onclick="window.print()">🖨 Print</button></span></div>`;
}
function section(heading: string, inner: string): string {
  return `<section class="section"><div class="section-eyebrow">${heading}</div>${inner}</section>`;
}
function metric(value: string, label: string, sub: string): string {
  return `<div class="metric"><div class="metric-val">${esc(value)}</div><div class="metric-label">${esc(label)}</div><div class="metric-sub">${esc(sub)}</div></div>`;
}
function esc(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

const CSS = `
:root{--ink:#141821;--muted:#5b6472;--line:#e6e9ef;--bg:#fff;--soft:#fbf7ef;--accent:#F59E0B;--accent-ink:#b45309}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#eceff4;color:var(--ink);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.doc{max-width:960px;margin:0 auto;background:var(--bg)}
.toolbar{position:sticky;top:0;z-index:10;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 18px;background:#1a1206;color:#fff}
.tb-title{font-weight:600;font-size:13px}
.tb-actions{display:flex;gap:8px}
.tb-btn{display:inline-block;padding:7px 14px;border-radius:8px;border:1px solid rgba(255,255,255,.25);background:transparent;color:#fff;font:inherit;font-size:13px;font-weight:600;cursor:pointer;text-decoration:none}
.tb-btn.primary{background:var(--accent);border-color:var(--accent);color:#1a1206}
.cover{padding:64px 56px 40px;border-bottom:1px solid var(--line);background:linear-gradient(180deg,#fdf6e9,#fff)}
.cover-brand{font-weight:700;letter-spacing:.14em;text-transform:uppercase;font-size:12px;color:var(--accent-ink)}
.cover h1{font-size:42px;line-height:1.05;margin:16px 0 12px;letter-spacing:-.02em}
.cover-sub{font-size:16px;color:var(--muted)}
.cover-note{margin-top:20px;max-width:640px;color:var(--muted);font-size:13.5px}
.section{padding:34px 56px;border-bottom:1px solid var(--line)}
.section-eyebrow{font-size:11px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--accent-ink);margin-bottom:14px}
.lead{font-size:15px;margin:0 0 16px}
.subhead{font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:22px 0 10px}
.muted{color:var(--muted)}.strong{font-weight:600}.nowrap{white-space:nowrap}
.hook{background:var(--soft);border-left:3px solid var(--accent);border-radius:8px;padding:12px 14px;margin:8px 0;font-size:14px}
.hook.big{font-size:16px;font-weight:600}
table.grid{width:100%;border-collapse:collapse;font-size:12.5px;margin-top:8px}
table.grid th{text-align:left;font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);border-bottom:1.5px solid var(--line);padding:9px 10px;font-weight:700}
table.grid td{padding:10px;border-bottom:1px solid var(--line);vertical-align:top}
table.grid tbody tr:nth-child(even){background:var(--soft)}
.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:14px}
.metric{border:1px solid var(--line);border-radius:14px;padding:16px;background:var(--soft)}
.metric-val{font-size:28px;font-weight:800;line-height:1}
.metric-label{margin-top:8px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
.metric-sub{margin-top:4px;font-size:11px;color:var(--muted)}
.panel{border:1px solid var(--line);border-radius:14px;padding:8px 16px;background:var(--soft)}
.kv{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--line);font-size:13px}
.kv:last-child{border-bottom:0}
.wins{margin:8px 0 0;padding:0;list-style:none}
.wins li{position:relative;padding:8px 8px 8px 30px;border-bottom:1px solid var(--line);font-size:13px}
.wins li:before{content:"→";position:absolute;left:8px;top:8px;color:var(--accent-ink);font-weight:800}
.foot{padding:22px 56px;color:var(--muted);font-size:11.5px;text-align:center}
@media print{html,body{background:#fff}.toolbar{display:none}.doc{max-width:none}.section,.cover{page-break-inside:avoid}@page{margin:14mm}}
@media (max-width:720px){.metrics{grid-template-columns:1fr 1fr}.cover,.section,.foot{padding-left:24px;padding-right:24px}}
`;
