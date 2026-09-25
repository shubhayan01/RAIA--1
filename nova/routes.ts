import { Router } from 'express';
import { config } from './config';
import { authInfo } from './auth';
import { llmInfo, llmConfigured } from './llm';
import { Report, b } from './lib/report';
import { classify, smalltalkReport, capabilitiesReport, looksConversational, ToolMode } from './services/converse';

import { runProspectResearch } from './services/prospect';
import { generateOutreach, sendOutreach } from './services/outreach';
import { pipelineReport, prospectCardReport, updateStage, addNote, setNextAction, getStale, getSummary, listProspects, getProspect } from './services/pipeline';
import { followupReport, dueReport, approveFollowup, skipFollowup, followupStatus } from './services/followup';
import { replyReport, processInbound } from './services/reply';
import { bookSlotsReport, meetingsReport, bookMeeting, cancelMeeting, getMeetings, meetingsStatus } from './services/meeting';
import { availableSlots, calendarConfigured } from './lib/calendar';
import { clientCareReport, addClient, listClients, updateClient, approveCare, clientcareStatus } from './services/clientcare';
import { lightweightAudit, auditToReport } from './services/audit';
import {
  createCampaign, listCampaigns, getCampaign, deleteCampaign,
  importContacts, updateTemplates, bulkSend, setContactStatus, removeContact, draftTemplate,
  campaignsReport, campaignsStatus,
} from './services/campaign';
import { prospectReportChat, prospectReportHtml } from './services/prospectreport';
import { htmlToPdf } from './report/pdf';
import { emailConfigured } from './lib/email';
import { imapConfigured } from './sources/mailbox';
import { Stage } from './lib/crm';

export const api = Router();

/* -------------------------------------------------------------------------- */
/* Chat entry point                                                            */
/* -------------------------------------------------------------------------- */

api.post('/ask', async (req, res) => {
  const { mode, text } = req.body || {};
  const input = String(text || '').trim();
  try {
    const report = await dispatch(String(mode || 'chat'), input);
    res.json({ ok: true, report });
  } catch (e: any) {
    res.status(200).json({ ok: false, report: errorReport(e?.message || String(e)) });
  }
});

async function dispatch(mode: string, text: string): Promise<Report> {
  if (mode === 'chat') {
    const intent = await classify(text);
    if (intent.kind === 'smalltalk') return smalltalkReport(text);
    if (intent.kind === 'capabilities') return capabilitiesReport();
    return runTool(intent.mode, intent.arg);
  }
  // Explicit pill selected — still catch greetings/help typed into it.
  if (text) {
    const conv = looksConversational(text);
    if (conv === 'capabilities') return capabilitiesReport();
    if (conv === 'smalltalk') return smalltalkReport(text);
  }
  return runTool(mode as ToolMode, text);
}

async function runTool(mode: ToolMode | string, text: string): Promise<Report> {
  switch (mode) {
    case 'research':
      if (!text) throw new Error('Give me a domain to research, e.g. "research acmedigital.com".');
      return runProspectResearch(text);

    case 'outreach':
      if (!text) throw new Error('Which prospect? e.g. "outreach for acmedigital.com".');
      return generateOutreach(text);

    case 'pipeline':
      return pipelineReport();

    case 'followup':
      return text ? followupReport(text) : dueReport();

    case 'replies':
      return replyReport();

    case 'meeting': {
      const low = text.toLowerCase();
      if (/\b(book|schedule)\b/.test(low)) {
        const dom = extractDomain(text);
        if (dom) return bookSlotsReport(dom);
      }
      if (/\b(cancel)\b/.test(low)) {
        return { tag: 'Meetings', title: 'Cancel a meeting', blocks: [b.note('Use the Cancel button on the meeting, or POST /api/meetings/cancel with the meeting id.')] };
      }
      const dom = extractDomain(text);
      if (dom && !/\b(show|my|upcoming|list)\b/.test(low)) return bookSlotsReport(dom);
      return meetingsReport();
    }

    case 'clientcare':
      return clientCareReport();

    case 'campaigns':
      return campaignsReport();

    case 'audit': {
      if (!text) throw new Error('Give me a domain to audit, e.g. "audit acmedigital.com".');
      const a = await lightweightAudit(text);
      return auditToReport(a);
    }

    case 'report':
      if (!text) throw new Error('Which prospect? e.g. "full report for acmedigital.com".');
      return prospectReportChat(text);

    default:
      throw new Error(`Unknown mode: ${mode}`);
  }
}

function extractDomain(text: string): string {
  const m = (text || '').match(/((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})/i);
  return m ? m[1] : '';
}
function errorReport(message: string): Report {
  return { tag: 'Error', title: 'Could not complete that', blocks: [b.note(message)] };
}

/* -------------------------------------------------------------------------- */
/* Status                                                                      */
/* -------------------------------------------------------------------------- */

api.get('/status', async (req, res) => {
  const [summary, fu, mt, cc, cp] = await Promise.all([
    getSummary().catch(() => ({})),
    followupStatus().catch(() => ({})),
    meetingsStatus().catch(() => ({})),
    clientcareStatus().catch(() => ({})),
    campaignsStatus().catch(() => ({})),
  ]);
  res.json({
    auth: authInfo(req),
    llm: llmInfo(),
    email: { connected: emailConfigured() },
    imap: { connected: imapConfigured() },
    calendar: { connected: calendarConfigured() },
    pipeline: summary,
    scheduler: fu,
    meetings: mt,
    clientcare: cc,
    campaigns: cp,
    agency: { name: config.agency.name },
  });
});

/* -------------------------------------------------------------------------- */
/* Pipeline (Feature 3) — powers the sidebar                                   */
/* -------------------------------------------------------------------------- */

api.get('/pipeline', async (_req, res) => {
  const [prospects, summary] = await Promise.all([listProspects(), getSummary()]);
  res.json({ ok: true, summary, prospects: prospects.sort((a, b2) => (b2.daysSinceContact ?? 0) - (a.daysSinceContact ?? 0)) });
});

api.post('/pipeline/update', async (req, res) => {
  const { domain, stage, note, nextActionAt, nextActionNote } = req.body || {};
  if (!domain) { res.status(400).json({ ok: false, error: 'domain is required' }); return; }
  let entry = null;
  let attempted = false;
  if (stage) { attempted = true; entry = await updateStage(domain, stage as Stage, note); }
  else if (note) { attempted = true; entry = await addNote(domain, note); }
  if (nextActionAt) { attempted = true; entry = (await setNextAction(domain, nextActionAt, nextActionNote || '')) || entry; }
  // A null result after a real mutation means the prospect isn't in the pipeline yet.
  // Say so explicitly instead of returning a bare ok:false (which reads as a mystery
  // failure to anyone integrating against the API).
  if (attempted && !entry) {
    res.status(404).json({ ok: false, error: `No prospect "${domain}" in the pipeline yet — research it first (e.g. "research ${domain}"), then update its stage.` });
    return;
  }
  if (!attempted) { res.status(400).json({ ok: false, error: 'Provide a "stage", "note", or "nextActionAt" to update.' }); return; }
  res.json({ ok: !!entry, entry });
});

api.get('/pipeline/stale', async (req, res) => {
  const days = Number(req.query.days) || 7;
  res.json({ ok: true, stale: await getStale(days) });
});

api.get('/pipeline/:domain', async (req, res) => {
  const entry = await getProspect(req.params.domain);
  if (!entry) { res.status(404).json({ ok: false, error: 'not found' }); return; }
  res.json({ ok: true, entry, report: prospectCardReport(entry) });
});

/* -------------------------------------------------------------------------- */
/* Outreach (Feature 2)                                                        */
/* -------------------------------------------------------------------------- */

api.post('/outreach/generate', async (req, res) => {
  const domain = String((req.body || {}).domain || '').trim();
  if (!domain) { res.status(400).json({ ok: false, error: 'domain is required' }); return; }
  res.json({ ok: true, report: await generateOutreach(domain) });
});

api.post('/outreach/send', async (req, res) => {
  const { domain, variantIndex, variant, toEmail } = req.body || {};
  if (!domain) { res.status(400).json({ ok: false, error: 'domain is required' }); return; }
  res.json(await sendOutreach({ domain, variantIndex, variant, toEmail }));
});

/* -------------------------------------------------------------------------- */
/* Follow-ups (Feature 4)                                                      */
/* -------------------------------------------------------------------------- */

api.get('/followup/due', async (_req, res) => res.json({ ok: true, report: await dueReport() }));
api.post('/followup/approve', async (req, res) => {
  const { domain, n, override } = req.body || {};
  if (!domain || !n) { res.status(400).json({ ok: false, error: 'domain and n are required' }); return; }
  res.json(await approveFollowup(domain, Number(n), override));
});
api.post('/followup/skip', async (req, res) => {
  const { domain, n } = req.body || {};
  if (!domain || !n) { res.status(400).json({ ok: false, error: 'domain and n are required' }); return; }
  res.json(await skipFollowup(domain, Number(n)));
});

/* -------------------------------------------------------------------------- */
/* Replies (Feature 5)                                                         */
/* -------------------------------------------------------------------------- */

api.post('/replies/check', async (_req, res) => res.json({ ok: true, handled: await processInbound() }));

/* -------------------------------------------------------------------------- */
/* Meetings (Feature 6)                                                        */
/* -------------------------------------------------------------------------- */

api.get('/meetings', async (req, res) => {
  const upcoming = req.query.all !== '1';
  res.json({ ok: true, meetings: await getMeetings(upcoming) });
});
api.get('/meetings/available', async (_req, res) => res.json({ ok: true, slots: await availableSlots(6, 7) }));
api.post('/meetings/book', async (req, res) => {
  const { domain, slotIso, prospectEmail, title } = req.body || {};
  if (!domain || !slotIso) { res.status(400).json({ ok: false, error: 'domain and slotIso are required' }); return; }
  res.json(await bookMeeting({ domain, slotIso, prospectEmail, title }));
});
api.post('/meetings/cancel', async (req, res) => {
  const { meetingId, reason } = req.body || {};
  if (!meetingId) { res.status(400).json({ ok: false, error: 'meetingId is required' }); return; }
  res.json(await cancelMeeting(meetingId, reason));
});

/* -------------------------------------------------------------------------- */
/* Clients / Client care (Feature 7)                                           */
/* -------------------------------------------------------------------------- */

api.get('/clients', async (_req, res) => res.json({ ok: true, clients: await listClients() }));
api.post('/clients', async (req, res) => {
  const body = req.body || {};
  if (!body.domain) { res.status(400).json({ ok: false, error: 'domain is required' }); return; }
  res.json({ ok: true, client: await addClient(body) });
});
api.patch('/clients/:domain', async (req, res) => {
  const client = await updateClient(req.params.domain, req.body || {});
  if (!client) { res.status(404).json({ ok: false, error: 'not found' }); return; }
  res.json({ ok: true, client });
});
api.post('/clientcare/approve', async (req, res) => {
  const { domain, type, override } = req.body || {};
  if (!domain || !type) { res.status(400).json({ ok: false, error: 'domain and type are required' }); return; }
  res.json(await approveCare(domain, type, override));
});

/* -------------------------------------------------------------------------- */
/* Campaigns — bulk outreach (upload list, configure templates, bulk send)     */
/* -------------------------------------------------------------------------- */

api.get('/campaigns', async (_req, res) => res.json({ ok: true, campaigns: await listCampaigns() }));

api.post('/campaigns', async (req, res) => {
  const name = String((req.body || {}).name || '').trim() || 'Untitled campaign';
  res.json({ ok: true, campaign: await createCampaign(name) });
});

api.get('/campaigns/:id', async (req, res) => {
  const c = await getCampaign(req.params.id);
  if (!c) { res.status(404).json({ ok: false, error: 'not found' }); return; }
  res.json({ ok: true, campaign: c });
});

api.delete('/campaigns/:id', async (req, res) => {
  res.json({ ok: await deleteCampaign(req.params.id) });
});

api.post('/campaigns/:id/import', async (req, res) => {
  const { content } = req.body || {};
  if (typeof content !== 'string' || !content.trim()) { res.status(400).json({ ok: false, error: 'File content is required.' }); return; }
  res.json(await importContacts(req.params.id, content));
});

api.put('/campaigns/:id/templates', async (req, res) => {
  const { templates } = req.body || {};
  if (!templates || typeof templates !== 'object') { res.status(400).json({ ok: false, error: 'templates object is required.' }); return; }
  res.json(await updateTemplates(req.params.id, templates));
});

api.post('/campaigns/:id/send', async (req, res) => {
  const { stage, onlyEligible, emails } = req.body || {};
  if (!stage) { res.status(400).json({ ok: false, error: 'stage is required.' }); return; }
  res.json(await bulkSend(req.params.id, stage, { onlyEligible, emails }));
});

api.post('/campaigns/:id/contact', async (req, res) => {
  const { email, status } = req.body || {};
  if (!email || !status) { res.status(400).json({ ok: false, error: 'email and status are required.' }); return; }
  res.json(await setContactStatus(req.params.id, email, status));
});

api.delete('/campaigns/:id/contact', async (req, res) => {
  const email = String((req.body || {}).email || req.query.email || '');
  if (!email) { res.status(400).json({ ok: false, error: 'email is required.' }); return; }
  res.json(await removeContact(req.params.id, email));
});

api.post('/campaigns/:id/draft', async (req, res) => {
  const { stage, audience, tone } = req.body || {};
  if (!stage) { res.status(400).json({ ok: false, error: 'stage is required.' }); return; }
  res.json(await draftTemplate(stage, { audience, tone }));
});

/* -------------------------------------------------------------------------- */
/* Full Prospect Report (Feature 8)                                            */
/* -------------------------------------------------------------------------- */

api.get('/nova/report', async (req, res) => {
  const domain = String(req.query.domain || '').trim();
  const format = String(req.query.format || 'html').toLowerCase();
  if (!domain) { res.status(400).type('html').send('<p>Add ?domain=example.com to generate a report.</p>'); return; }
  try {
    if (format === 'pdf') {
      const html = await prospectReportHtml(domain, { forPdf: true });
      const pdf = await htmlToPdf(html);
      const safe = domain.replace(/[^a-z0-9.-]/gi, '_');
      res.type('pdf').set('Content-Disposition', `attachment; filename="${safe}-prospect-report.pdf"`).send(pdf);
      return;
    }
    const pdfHref = `/api/nova/report?domain=${encodeURIComponent(domain)}&format=pdf`;
    res.type('html').send(await prospectReportHtml(domain, { pdfHref }));
  } catch (e: any) {
    res.status(200).type('html').send(`<div style="font:15px system-ui;padding:40px;max-width:640px;margin:0 auto"><h2>Could not build the report</h2><p>${String(e?.message || e).replace(/[<>&]/g, '')}</p></div>`);
  }
});
