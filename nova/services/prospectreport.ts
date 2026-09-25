import { config } from '../config';
import { loadProspectRecord } from './prospect';
import { getProspect } from '../lib/crm';
import { loadMeetings, formatSlot } from '../lib/calendar';
import { renderProspectReportHtml, ProspectReportModel } from '../report/prospectReportHtml';
import { safeDomainKey } from '../lib/jsonStore';
import { Report, b } from '../lib/report';

/**
 * Full Prospect Report (Feature 8). Aggregates everything NOVA knows about a
 * prospect into one branded HTML/PDF report. Pure aggregation of stored, real
 * data — the only generated text is the pitch/next-action already in the record.
 */

export async function buildProspectReportModel(domainRaw: string): Promise<ProspectReportModel> {
  const domain = safeDomainKey(domainRaw);
  const rec = await loadProspectRecord(domain);
  const entry = await getProspect(domain);
  if (!rec && !entry) throw new Error(`No data on ${domain} yet — research it first.`);

  const meetingsDoc = await loadMeetings();
  const meetings = meetingsDoc.meetings
    .filter((m) => m.domain === domain)
    .map((m) => ({ when: formatSlot(m.startIso), title: m.title, status: m.status }));

  const outreach = (rec?.outreach || []).map((o: any) => ({
    when: new Date(o.sentAt || o.receivedAt || Date.now()).toLocaleString('en-US'),
    kind: o.type === 'reply' ? `Reply (${o.analysis?.classification || '—'})` : 'Outreach',
    subject: o.subject || '—',
    detail: o.hook || o.analysis?.suggestedNextAction || '',
  }));

  const nextAction = entry?.nextActionAt
    ? `${new Date(entry.nextActionAt).toLocaleDateString('en-US')} — ${entry.nextActionNote || 'follow up'}`
    : rec?.brief?.pitchAngle
      ? `Open with: ${rec.brief.pitchAngle}`
      : 'Generate and send the outreach email.';

  const audit = rec?.audit;
  return {
    brand: config.report.brand,
    generatedAt: new Date().toISOString(),
    domain,
    companyName: rec?.scrape.companyName || entry?.companyName || domain,
    snapshot: rec?.brief?.companySnapshot || rec?.scrape.whatTheyDo || 'No synthesised snapshot available (add an LLM key and re-research).',
    painPoints: rec?.brief?.painPoints || [],
    pitchAngle: rec?.brief?.pitchAngle || '',
    audit: {
      performance: audit?.lighthouse.performance ?? null,
      seo: audit?.lighthouse.seo ?? null,
      accessibility: audit?.lighthouse.accessibility ?? null,
      bestPractices: audit?.lighthouse.bestPractices ?? null,
      cwv: audit?.coreWebVitals.pass == null ? 'no data' : audit.coreWebVitals.pass ? 'PASS' : 'FAIL',
      topIssues: audit?.topIssues || [],
      pagesCrawled: audit?.pagesCrawled || 0,
      missingTitle: audit?.missingTitle || 0,
      missingMeta: audit?.missingMeta || 0,
    },
    social: (rec?.social || []).map((s) => ({ platform: s.platform, status: s.status })),
    outreach,
    pipeline: { stage: entry?.stage || 'RESEARCHED', history: entry?.stageHistory || [] },
    meetings,
    nextAction,
    riskFlags: rec?.brief?.riskFlags || '',
  };
}

export async function prospectReportHtml(domain: string, opts: { pdfHref?: string; forPdf?: boolean } = {}): Promise<string> {
  const model = await buildProspectReportModel(domain);
  return renderProspectReportHtml(model, opts);
}

/** "full report for [domain]" — chat surface that links to the report page/PDF. */
export async function prospectReportChat(domainRaw: string): Promise<Report> {
  const domain = safeDomainKey(domainRaw);
  const rec = await loadProspectRecord(domain);
  const entry = await getProspect(domain);
  if (!rec && !entry) {
    return { tag: 'Full Report', title: 'Nothing to report yet', blocks: [b.note(`I have no data on ${domain}. Research it first, then I can compile the full report.`)] };
  }
  const htmlUrl = `/api/nova/report?domain=${encodeURIComponent(domain)}&format=html`;
  const pdfUrl = `/api/nova/report?domain=${encodeURIComponent(domain)}&format=pdf`;
  return {
    tag: 'Full Report',
    title: `Full prospect report — ${entry?.companyName || domain}`,
    blocks: [
      b.p('Everything NOVA knows about this prospect — snapshot, audit, socials, outreach history, pipeline, meetings and the recommended next action — compiled into one branded report.'),
      b.chips([`Open report`, `Download PDF`]),
    ],
    data: { domain, htmlUrl, pdfUrl },
  };
}
