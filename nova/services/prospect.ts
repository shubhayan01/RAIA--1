import { scrapeProspect, ScrapeResult, parseProspectInput, normalizeDomain } from '../sources/webscrape';
import { socialSignals, SocialSignal } from '../sources/social';
import { lightweightAudit, LightAuditResult } from './audit';
import { completeJSON, llmConfigured } from '../llm';
import { dataPath, readJson, writeJson, safeDomainKey } from '../lib/jsonStore';
import { upsertProspect } from '../lib/crm';
import { pool } from '../lib/concurrency';
import { config } from '../config';
import { Report, b } from '../lib/report';

/**
 * Prospect research pipeline (Feature 1).
 *
 * Pipeline: scrape website (real) → lightweight audit (real Lighthouse + crawl)
 * → social signals (real, honest when blocked) → LLM synthesis (brief ONLY, over
 * the real research) → store → pipeline at RESEARCHED.
 *
 * The AI-role principle: the LLM only synthesises a brief from data it is handed.
 * Every fact — company details, SEO issues, scores, socials — is scraped/measured.
 */

export interface ProspectBrief {
  companySnapshot: string;
  painPoints: { problem: string; evidence: string; consequence: string; solution: string }[];
  pitchAngle: string;
  contactIntelligence: { bestContact: string; bestChannel: string; timingNote: string };
  riskFlags: string;
}

export interface ProspectRecord {
  domain: string;
  emailHint?: string;
  researchedAt: string;
  scrape: ScrapeResult;
  audit: LightAuditResult;
  social: SocialSignal[];
  brief: ProspectBrief | null;
  // Outreach + activity history (appended by other services).
  outreach?: any[];
  meta?: Record<string, unknown>;
}

/* ------------------------- storage ------------------------- */
function fileFor(domain: string): string {
  return dataPath('prospects', `${safeDomainKey(domain)}.json`);
}
export async function loadProspectRecord(domain: string): Promise<ProspectRecord | null> {
  return readJson<ProspectRecord | null>(fileFor(domain), null);
}
export async function saveProspectRecord(rec: ProspectRecord): Promise<void> {
  await writeJson(fileFor(rec.domain), rec);
}

/* ------------------------- entry point ------------------------- */

/** Research one or more prospects from free-text (single, bulk, or with emails). */
export async function runProspectResearch(text: string): Promise<Report> {
  const { domains, emailByDomain } = parseProspectInput(text);
  if (!domains.length) {
    return {
      tag: 'Prospect Research', title: 'No domain found',
      blocks: [b.note('Give me a domain to research, e.g. "research acmedigital.com" — or paste a comma/newline-separated list for bulk.')],
    };
  }

  if (domains.length === 1) {
    const rec = await researchOne(domains[0], emailByDomain[domains[0]]);
    return singleReport(rec);
  }

  // Bulk — research up to a sane cap concurrently, return a summary.
  const capped = domains.slice(0, 10);
  const records = await pool(capped, 3, (d) => researchOne(d, emailByDomain[d]));
  return bulkReport(records, domains.length - capped.length);
}

/** Full research on one domain; persists the record and seeds the pipeline. */
export async function researchOne(domainRaw: string, emailHint?: string): Promise<ProspectRecord> {
  const domain = normalizeDomain(domainRaw);

  // Steps 1–3 run in parallel where independent (scrape first for socials).
  const scrape = await scrapeProspect(domain);
  const [audit, social] = await Promise.all([
    lightweightAudit(domain).catch((e) => ({ domain, url: `https://${domain}`, reachable: false, error: String(e?.message || e) } as LightAuditResult)),
    socialSignals({ linkedin: scrape.contacts.linkedin, instagram: scrape.contacts.instagram }),
  ]);

  // Step 4 — LLM synthesis over the REAL research only.
  const brief = await synthesizeBrief({ domain, scrape, audit, social });

  const rec: ProspectRecord = {
    domain,
    emailHint: emailHint || scrape.contacts.emails[0],
    researchedAt: new Date().toISOString(),
    scrape, audit, social, brief,
  };
  await saveProspectRecord(rec);

  // Step 5 — seed / update the pipeline at RESEARCHED.
  await upsertProspect({
    domain,
    companyName: scrape.companyName || domain,
    contactEmail: rec.emailHint || '',
    stage: 'RESEARCHED',
  });

  return rec;
}

/* ------------------------- LLM synthesis ------------------------- */

const SYNTH_SYSTEM = `You are a senior business development strategist at a digital marketing agency. You will receive research data about a prospect company — their website, services, tech stack, SEO issues, and social signals.

Produce a prospect intelligence brief with exactly this structure:

COMPANY SNAPSHOT
One paragraph: who they are, what they sell, who their customers appear to be, and what market they operate in. Be specific — no generic descriptions.

IDENTIFIED PAIN POINTS
For each pain point (3-5 maximum):
  The problem (specific, based on the data)
  The evidence (what on their site/socials shows this)
  The business consequence (what it is costing them)
  How the agency solves it specifically

PITCH ANGLE
The single strongest angle for the outreach email. Not a generic "we do SEO" pitch — a specific hook tied to a real problem found in the research.

CONTACT INTELLIGENCE
Best contact to reach (role + name if found, else "marketing decision maker")
Best channel: email / LinkedIn DM / contact form
Timing note: if their social is inactive, note that email is safer than social outreach

RISK FLAGS
Anything that suggests this prospect is a bad fit: too small, already using a competitor, industry we don't serve well, etc. If none, say "No red flags identified."

Rules:
- Never invent data not in the research passed to you
- Every pain point must cite specific evidence
- Be direct — this is an internal brief, not client-facing

Return ONLY minified JSON with exactly these keys:
{"companySnapshot": string,
 "painPoints": [{"problem": string, "evidence": string, "consequence": string, "solution": string}],
 "pitchAngle": string,
 "contactIntelligence": {"bestContact": string, "bestChannel": string, "timingNote": string},
 "riskFlags": string}`;

async function synthesizeBrief(input: { domain: string; scrape: ScrapeResult; audit: LightAuditResult; social: SocialSignal[] }): Promise<ProspectBrief | null> {
  if (!llmConfigured()) return null;
  const { scrape, audit, social } = input;
  const payload = {
    domain: input.domain,
    companyName: scrape.companyName,
    whatTheyDo: scrape.whatTheyDo,
    services: scrape.services,
    location: scrape.location,
    techStack: scrape.techStack,
    sizeSignal: scrape.sizeSignal,
    contacts: scrape.contacts,
    seoIssues: audit.topIssues,
    lighthouseScore: audit.lighthouse,
    coreWebVitals: audit.coreWebVitals,
    socialSignals: social.map((s) => ({ platform: s.platform, followers: s.followers, status: s.status, frequency: s.frequency })),
    agency: config.agency.name,
  };
  try {
    return await completeJSON<ProspectBrief>(SYNTH_SYSTEM, JSON.stringify(payload), { temperature: 0.4, maxTokens: 2500 });
  } catch {
    return null;
  }
}

/* ------------------------- report rendering ------------------------- */

function singleReport(rec: ProspectRecord): Report {
  const { scrape, audit, social, brief } = rec;
  const blocks = [];

  if (!scrape.reachable) {
    blocks.push(b.note(`Could not reach ${rec.domain}'s website (${scrape.error || 'no response'}). Research is limited to what was retrievable.`));
  }

  // Company snapshot (p)
  blocks.push(b.p(brief?.companySnapshot
    || scrape.whatTheyDo
    || `Scraped ${scrape.companyName || rec.domain}. Add an LLM key to generate the full intelligence brief.`));

  // Pain points (list with evidence)
  if (brief?.painPoints?.length) {
    blocks.push(b.p('Identified pain points:'));
    blocks.push(b.list(brief.painPoints.map((p) =>
      `${p.problem} — Evidence: ${p.evidence}. Consequence: ${p.consequence}. Fix: ${p.solution}`)));
  }

  // Pitch angle (note — highlighted)
  if (brief?.pitchAngle) blocks.push(b.note(`Pitch angle: ${brief.pitchAngle}`));

  // Contact intelligence (kv)
  const ci = brief?.contactIntelligence;
  blocks.push(b.kv([
    { k: 'Best contact', v: ci?.bestContact || 'Marketing decision maker' },
    { k: 'Best channel', v: ci?.bestChannel || (scrape.contacts.emails[0] ? 'Email' : 'Contact form') },
    { k: 'Contact email', v: rec.emailHint || scrape.contacts.emails[0] || 'not found on site' },
    { k: 'LinkedIn', v: scrape.contacts.linkedin || '—' },
    { k: 'Timing', v: ci?.timingNote || '—' },
  ]));

  // SEO hook data (kv)
  blocks.push(b.kv([
    { k: 'Lighthouse (mobile perf)', v: audit.lighthouse.performance != null ? `${audit.lighthouse.performance}/100` : (audit.psiError ? 'unavailable' : '—') },
    { k: 'Lighthouse SEO', v: audit.lighthouse.seo != null ? `${audit.lighthouse.seo}/100` : '—' },
    { k: 'Core Web Vitals', v: audit.coreWebVitals.pass == null ? 'no data' : audit.coreWebVitals.pass ? 'PASS' : 'FAIL' },
    { k: 'Top issue', v: audit.topIssues[0] || 'none detected' },
    { k: 'Issue count (hook)', v: String(audit.topIssues.length) },
  ]));

  // Tech + socials (chips)
  if (scrape.techStack.length) { blocks.push(b.p('Detected tech stack:')); blocks.push(b.chips(scrape.techStack)); }
  if (social.length) {
    blocks.push(b.p('Social signals (honest — blocked where the platform gates public data):'));
    blocks.push(b.list(social.map((s) => `${s.platform}: ${s.status}`)));
  }

  // Risk flags (note)
  blocks.push(b.note(`Risk flags: ${brief?.riskFlags || 'No red flags identified.'}`));

  // Action chips
  blocks.push(b.chips(['Generate Outreach Email', 'Run Full Audit', 'Add to Pipeline']));

  return {
    tag: 'Prospect Research',
    title: `Research — ${scrape.companyName || rec.domain}`,
    blocks,
    data: { domain: rec.domain },
  };
}

function bulkReport(records: ProspectRecord[], overflow: number): Report {
  const blocks = [];
  blocks.push(b.p(`Researched ${records.length} prospect${records.length === 1 ? '' : 's'}. Each is stored and added to the pipeline at RESEARCHED. Open one from the sidebar for the full brief.`));
  blocks.push(b.table(
    ['Company', 'Domain', 'Lighthouse', 'Top issue', 'Pitch angle'],
    records.map((r) => [
      r.scrape.companyName || r.domain,
      r.domain,
      r.audit.lighthouse.performance != null ? `${r.audit.lighthouse.performance}/100` : '—',
      (r.audit.topIssues[0] || 'none').slice(0, 40),
      (r.brief?.pitchAngle || '—').slice(0, 60),
    ]),
  ));
  if (overflow > 0) blocks.push(b.note(`${overflow} more domain(s) were skipped — bulk research is capped at 10 per run.`));
  blocks.push(b.chips(['Send to all — Generate Outreach', 'Show Pipeline']));
  return { tag: 'Prospect Research', title: `Bulk research — ${records.length} prospects`, blocks, data: { domains: records.map((r) => r.domain) } };
}
