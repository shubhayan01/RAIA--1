import { Router } from 'express';
import { runKeywords } from './services/keywords';
import { runAudit } from './services/audit';
import { runBrief } from './services/brief';
import { runIntelligence } from './services/intelligence';
import { runCompetitive } from './services/competitive';
import { runAioverview } from './services/aioverview';
import { runRanks } from './services/ranks';
import { runCannibal } from './services/cannibal';
import { classify, smalltalkReport, capabilitiesReport, looksConversational } from './services/converse';
import { buildProposal } from './services/proposal';
import { renderProposalHtml } from './report/proposalHtml';
import { htmlToPdf } from './report/pdf';
import { llmInfo } from './llm';
import { authInfo } from './auth';
import { config } from './config';
import { Report, b } from './lib/report';
import { pushBriefToWordPress, wordpressConfigured } from './services/cms';
import { schedulerStatus, runScheduledReport } from './services/scheduler';
import { runMetaPush } from './services/metapush';
import { trackAlerts, runCheck, alertsStatus, alertsHistory } from './services/alerts';
import { runOpportunityLoop, opportunityHistory, opportunityDomain } from './services/opportunityloop';
import { runAutoLink, autoLinkHistory } from './services/autolink';
import { runSchema, schemaHistory } from './services/schema';
import { gscConfigured } from './sources/google';
import { listJsonKeys } from './lib/jsonStore';
import { BriefData } from './services/brief';

export const api = Router();

/**
 * Full client report — a detailed, branded audit / growth proposal.
 * `GET /api/report?url=<domain>&format=html|pdf&brand=<name>&pages=<n>`
 * html (default) renders the page (with a Download-PDF button); pdf streams a file.
 */
api.get('/report', async (req, res) => {
  const url = String(req.query.url || '').trim();
  const format = String(req.query.format || 'html').toLowerCase();
  const brand = req.query.brand ? String(req.query.brand) : undefined;
  const pages = req.query.pages ? Math.min(Math.max(parseInt(String(req.query.pages), 10) || 0, 1), 500) : undefined;
  if (!url) {
    res.status(400).type('html').send('<p>Add ?url=example.com to generate a report.</p>');
    return;
  }
  try {
    const data = await buildProposal(url, { brand, maxPages: pages });
    if (format === 'pdf') {
      const forPdf = renderProposalHtml(data, { forPdf: true });
      const pdf = await htmlToPdf(forPdf);
      const safe = data.domain.replace(/[^a-z0-9.-]/gi, '_');
      res.type('pdf').set('Content-Disposition', `attachment; filename="${safe}-seo-proposal.pdf"`).send(pdf);
      return;
    }
    const pdfHref = `/api/report?url=${encodeURIComponent(url)}&format=pdf${brand ? `&brand=${encodeURIComponent(brand)}` : ''}${pages ? `&pages=${pages}` : ''}`;
    res.type('html').send(renderProposalHtml(data, { pdfHref }));
  } catch (e: any) {
    res.status(200).type('html').send(`<div style="font:15px system-ui;padding:40px;max-width:640px;margin:0 auto"><h2>Could not build the report</h2><p>${String(e?.message || e).replace(/[<>&]/g, '')}</p></div>`);
  }
});

/** System status for the UI header / diagnostics. */
api.get('/status', async (req, res) => {
  const sched = schedulerStatus();
  let trackedDomains: string[] = [];
  try { trackedDomains = await listJsonKeys('rankings'); } catch { /* none */ }
  res.json({
    auth: authInfo(req),
    llm: llmInfo(),
    serp: { provider: config.serp.provider, enabled: config.serp.provider !== 'none' },
    seoptimer: { enabled: !!config.seoptimer.apiKey },
    keywords: { provider: config.keywords.provider },
    google: {
      pagespeed: !!config.google.pagespeedKey,
      gsc: gscConfigured(),
      ga4: !!config.google.ga4PropertyId && (!!config.google.accessToken || !!config.google.refreshToken),
    },
    // ---- Execution layer (Part 3) ----
    wordpress: { connected: wordpressConfigured() },
    scheduler: { enabled: sched.enabled, nextRun: sched.nextRun, lastRun: sched.lastRun, lastStatus: sched.lastStatus },
    alerts: { enabled: config.alerts.enabled, domainsTracked: trackedDomains.length, domains: trackedDomains },
    opportunityLoop: { gscConnected: gscConfigured() },
    autoLink: { wpConnected: wordpressConfigured() },
    schema: { wpConnected: wordpressConfigured() },
    jsRender: { enabled: config.render.enabled },
  });
});

/* -------------------------------------------------------------------------- */
/* Execution-layer routes (WordPress push, scheduler, meta push, alerts, loop) */
/* -------------------------------------------------------------------------- */

/** Feature 1 — push an approved brief into WordPress as a draft. */
api.post('/cms/push-brief', async (req, res) => {
  const { briefData, wpUrl, wpUsername, wpAppPassword } = req.body || {};
  if (!briefData || !briefData.primaryKeyword) {
    res.status(400).json({ ok: false, error: 'briefData (a full brief object) is required.' });
    return;
  }
  const result = await pushBriefToWordPress(briefData as BriefData, { url: wpUrl, username: wpUsername, appPassword: wpAppPassword });
  res.json(result);
});

/** Feature 2 — scheduler status + manual trigger. */
api.get('/scheduler/status', (_req, res) => res.json(schedulerStatus()));
api.post('/scheduler/trigger', async (_req, res) => {
  const result = await runScheduledReport();
  res.json(result);
});

/** Feature 3 — generate + push optimized title/meta tags to WordPress. */
api.post('/metapush/run', async (req, res) => {
  const { auditData, wpUrl, wpUsername, wpAppPassword } = req.body || {};
  if (!auditData) {
    res.status(400).json({ ok: false, error: 'auditData (the audit report data object) is required.' });
    return;
  }
  const result = await runMetaPush({ auditData, creds: { url: wpUrl, username: wpUsername, appPassword: wpAppPassword } });
  res.json(result);
});

/** Feature 4 — ranking drop alerts. */
api.post('/alerts/track', async (req, res) => {
  const { domain, keywords, email } = req.body || {};
  if (!domain || !Array.isArray(keywords) || !keywords.length) {
    res.status(400).json({ ok: false, error: 'domain and a non-empty keywords[] are required.' });
    return;
  }
  const result = await trackAlerts({ domain, keywords, email });
  res.json(result);
});
api.get('/alerts/status', async (req, res) => {
  const domain = String(req.query.domain || '').trim();
  if (!domain) { res.status(400).json({ ok: false, error: 'Add ?domain=' }); return; }
  res.json(await alertsStatus(domain));
});
api.get('/alerts/history', async (req, res) => {
  const domain = String(req.query.domain || '').trim();
  const keyword = String(req.query.keyword || '').trim();
  if (!domain || !keyword) { res.status(400).json({ ok: false, error: 'Add ?domain=&keyword=' }); return; }
  res.json(await alertsHistory(domain, keyword));
});
/** Manual fire of a domain's alert check (testing without waiting for cron). */
api.post('/alerts/check', async (req, res) => {
  const domain = String((req.body || {}).domain || '').trim();
  if (!domain) { res.status(400).json({ ok: false, error: 'domain is required.' }); return; }
  res.json(await runCheck(domain));
});

/** Feature 5 — opportunity loop. */
api.post('/opportunity/run', async (req, res) => {
  const { days, autoPublish } = req.body || {};
  if (!gscConfigured()) {
    res.status(200).json({ ok: false, error: 'Connect Google Search Console first (GSC_SITE_URL + a Google token).' });
    return;
  }
  const report = await runOpportunityLoop({ days, autoPublish });
  res.json({ ok: true, report });
});
api.get('/opportunity/history', async (req, res) => {
  const domain = String(req.query.domain || '').trim() || opportunityDomain();
  res.json(await opportunityHistory(domain));
});

/** Feature 6 — automated internal linking (dry run, or apply to WordPress). */
api.post('/autolink/run', async (req, res) => {
  const { url, apply, maxPages, maxPerPage, wpUrl, wpUsername, wpAppPassword } = req.body || {};
  if (!url) { res.status(400).json({ ok: false, error: 'url is required.' }); return; }
  const report = await runAutoLink({
    startUrl: String(url),
    apply: !!apply,
    maxPages: maxPages ? Number(maxPages) : undefined,
    maxPerPage: maxPerPage ? Number(maxPerPage) : undefined,
    creds: { url: wpUrl, username: wpUsername, appPassword: wpAppPassword },
  });
  res.json({ ok: true, report });
});
api.get('/autolink/history', async (req, res) => {
  const domain = String(req.query.domain || '').trim();
  if (!domain) { res.status(400).json({ ok: false, error: 'Add ?domain=' }); return; }
  res.json(await autoLinkHistory(domain));
});

/** Feature 7 — automated schema / JSON-LD injection (dry run, or apply to WordPress). */
api.post('/schema/run', async (req, res) => {
  const { url, apply, maxPages, wpUrl, wpUsername, wpAppPassword } = req.body || {};
  if (!url) { res.status(400).json({ ok: false, error: 'url is required.' }); return; }
  const report = await runSchema({
    startUrl: String(url),
    apply: !!apply,
    maxPages: maxPages ? Number(maxPages) : undefined,
    creds: { url: wpUrl, username: wpUsername, appPassword: wpAppPassword },
  });
  res.json({ ok: true, report });
});
api.get('/schema/history', async (req, res) => {
  const domain = String(req.query.domain || '').trim();
  if (!domain) { res.status(400).json({ ok: false, error: 'Add ?domain=' }); return; }
  res.json(await schemaHistory(domain));
});

/**
 * Single entry point the chat UI calls. `mode` = pill, `text` = composer input,
 * plus optional structured fields. We parse the composer text into the right
 * argument for each capability so the UX stays "just type".
 */
api.post('/ask', async (req, res) => {
  const { mode, text, options } = req.body || {};
  const input = String(text || '').trim();
  try {
    const report = await dispatch(String(mode || 'chat'), input, options || {});
    res.json({ ok: true, report });
  } catch (e: any) {
    res.status(200).json({
      ok: false,
      report: errorReport(String(mode), e?.message || String(e)),
    });
  }
});

async function dispatch(mode: string, text: string, options: any): Promise<Report> {
  // Conversational entry point: the AI chats or figures out which real tool to run.
  if (mode === 'chat') {
    const intent = await classify(text);
    if (intent.kind === 'smalltalk') return smalltalkReport(text);
    if (intent.kind === 'capabilities') return capabilitiesReport();
    return runTool(intent.mode, intent.arg, options);
  }

  // Explicit tool pill selected — but still catch a greeting/help typed into it,
  // so "hi" never triggers a keyword crawl.
  if (text) {
    const conv = looksConversational(text);
    if (conv === 'capabilities') return capabilitiesReport();
    if (conv === 'smalltalk') return smalltalkReport(text);
  }
  return runTool(mode, text, options);
}

async function runTool(mode: string, text: string, options: any): Promise<Report> {
  switch (mode) {
    case 'keywords':
      return runKeywords({
        seed: text,
        competitorDomain: options.competitorDomain,
        existingPages: options.existingPages,
      });

    case 'audit': {
      if (!text) throw new Error('Enter a URL to audit, e.g. https://clientsite.com');
      return runAudit(text, { maxPages: options.maxPages, cwv: options.cwv !== false });
    }

    case 'briefs': {
      // FIX 4: a brief can optionally target an existing client page to REWRITE.
      // Accepts "rewrite <url> for <keyword>" and "<keyword> <url>".
      const parsed = parseBriefInput(text);
      return runBrief({ primaryKeyword: parsed.primaryKeyword, existingPageUrl: parsed.existingPageUrl });
    }

    case 'intel':
      return runIntelligence({ days: options.days });

    case 'competitors':
      return runCompetitive({
        clientDomain: text,
        seedKeywords: options.seedKeywords,
        competitors: options.competitors,
      });

    case 'aio':
      return runAioverview({ text, clientUrl: options.clientUrl, country: options.country });

    case 'ranks':
      return runRanks({ text, domain: options.domain, keywords: options.keywords });

    case 'cannibal':
      return runCannibal({ text, domain: options.domain });

    case 'opportunity': {
      // "run opportunity loop and publish" / "...as drafts" → autoPublish.
      const autoPublish = options.autoPublish ?? /\b(publish|draft|auto[- ]?publish|queue)\b/i.test(text || '');
      return runOpportunityLoop({ days: options.days, autoPublish });
    }

    case 'autolink': {
      // "internal links for <url>" (dry run) / "...and apply|insert|publish" (write to WP).
      const url = extractUrl(text);
      if (!url) throw new Error('Enter a site URL, e.g. "internal links for https://clientsite.com"');
      const apply = options.apply ?? /\b(apply|insert|publish|push|do it|for real)\b/i.test(text || '');
      return runAutoLink({ startUrl: url, apply, maxPages: options.maxPages, maxPerPage: options.maxPerPage });
    }

    case 'schema': {
      // "add schema to <url>" (dry run) / "...and apply|inject|publish" (write to WP).
      const url = extractUrl(text);
      if (!url) throw new Error('Enter a site URL, e.g. "add schema to https://clientsite.com"');
      const apply = options.apply ?? /\b(apply|inject|publish|push|do it|for real)\b/i.test(text || '');
      return runSchema({ startUrl: url, apply, maxPages: options.maxPages });
    }

    default:
      throw new Error(`Unknown mode: ${mode}`);
  }
}

/**
 * Split a brief command into a keyword and an optional existing-page URL to rewrite.
 * Handles "rewrite <url> for <keyword>", "<keyword> <url>", and plain "<keyword>".
 */
export function parseBriefInput(text: string): { primaryKeyword: string; existingPageUrl?: string } {
  let t = (text || '').trim();
  let existingPageUrl: string | undefined;

  const m = t.match(/\b((?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})(\/[^\s]*)?/i);
  if (m) {
    const host = m[1].toLowerCase();
    if (!/^(e\.g|i\.e|vs|etc|no|a\.m|p\.m)\.?$/.test(host)) {
      existingPageUrl = /^https?:\/\//i.test(m[0]) ? m[0] : 'https://' + m[0];
      t = (t.slice(0, m.index) + ' ' + t.slice((m.index ?? 0) + m[0].length)).trim();
    }
  }

  // Strip the leading command scaffolding around the URL so only the keyword remains.
  t = t.replace(/^\s*(please\s+)?rewrite(\s+brief)?\s+/i, '');
  t = t.replace(/^\s*(the\s+)?(existing\s+)?(page|url|content)\s+/i, '');
  t = t.replace(/^\s*for\s+/i, '');
  t = t.replace(/\s{2,}/g, ' ').trim();

  return { primaryKeyword: t, existingPageUrl };
}

/** Pull the first URL/domain out of free text, defaulting to https://. */
export function extractUrl(text: string): string | null {
  const t = (text || '').trim();
  const m = t.match(/\b((?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})(\/[^\s]*)?/i);
  if (!m) return null;
  const host = m[1].toLowerCase();
  if (/^(e\.g|i\.e|vs|etc|no|a\.m|p\.m)\.?$/.test(host)) return null;
  return /^https?:\/\//i.test(m[0]) ? m[0] : 'https://' + m[0];
}

/**
 * Turn a raw internal/provider error into something a user should see. Raw LLM
 * provider errors ("groq 400: Failed to validate JSON…"), timeouts and connection
 * failures are noise to the user and can leak provider/config detail — map them to
 * plain guidance, and keep the raw text in the server log for debugging.
 */
function friendlyError(raw: string): string {
  const m = String(raw || '');
  const low = m.toLowerCase();
  if (/\b(groq|openai|anthropic|llm)\b.*\b(4\d\d|5\d\d)\b/.test(low) || /failed to validate json|invalid_request_error|rate.?limit|context length|tokens? per/.test(low)) {
    return 'The AI step could not process that request. Try rephrasing, shortening the input, or trying again in a moment.';
  }
  if (/timeout|timed out|etimedout|econnreset|enotfound|socket hang up|network|fetch failed/.test(low)) {
    return 'A network step timed out or failed to connect. Check the URL is reachable and try again.';
  }
  if (/\b(401|403|unauthor|forbidden|api key|apikey)\b/.test(low)) {
    return 'An upstream service rejected the request (auth/config). Check the relevant API key in .env.';
  }
  // Our own thrown messages (e.g. "Enter a URL…", the SSRF guard) are already
  // user-safe and short — pass those through.
  if (m.length <= 160 && !/[{}\[\]]/.test(m)) return m;
  return 'Could not complete that. Please try again, or adjust the input.';
}

function errorReport(mode: string, message: string): Report {
  console.error(`[ask:${mode}]`, message); // full detail stays in the server log
  return {
    tag: 'Error',
    title: 'Could not complete that',
    blocks: [b.note(friendlyError(message))],
  };
}
