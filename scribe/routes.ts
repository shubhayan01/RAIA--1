import { Router } from 'express';
import { config } from './config';
import { authInfo } from './auth';
import { llmInfo } from './llm';
import { serpEnabled } from './sources/serp';
import { Report, b } from './lib/report';
import { classify, smalltalkReport, capabilitiesReport, looksConversational, ToolMode } from './services/converse';

import { runResearch } from './services/research';
import { runCompetitorAnalysis } from './services/competitors';
import { runGapAnalysis } from './services/gap';
import { runKeywordExpansion } from './services/keywords';
import { runBrandAnalysis } from './services/brand';
import { runWrite } from './services/write';
import { runFactCheck } from './services/factcheck';
import { runAiCheck } from './services/aicheck';
import { runEeatCheck } from './services/eeat';
import { runSelfAudit } from './services/selfaudit';
import { runEvidence } from './services/evidence';
import { runGate } from './services/gate';
import { runWorkflow } from './services/workflow';
import { listProjects, loadProject, deleteProject } from './lib/project';
import { ContentDraft } from './services/write';

export const api = Router();

/* -------------------------------------------------------------------------- */
/* Chat entry point                                                            */
/* -------------------------------------------------------------------------- */

api.post('/ask', async (req, res) => {
  const { mode, text, siteUrl, extraInfo, params, content, correct } = req.body || {};
  const input = String(text || '').trim();
  const opts = { siteUrl: str(siteUrl), extraInfo: str(extraInfo), params: str(params), content: str(content), correct: !!correct };
  try {
    const report = await dispatch(String(mode || 'chat'), input, opts);
    res.json({ ok: true, report });
  } catch (e: any) {
    res.status(200).json({ ok: false, report: errorReport(e?.message || String(e)) });
  }
});

interface AskOpts { siteUrl: string; extraInfo: string; params: string; content: string; correct: boolean }

async function dispatch(mode: string, text: string, o: AskOpts): Promise<Report> {
  if (mode === 'chat') {
    const intent = await classify(text);
    if (intent.kind === 'smalltalk') return smalltalkReport(text);
    if (intent.kind === 'capabilities') return capabilitiesReport();
    return runTool(intent.mode, intent.arg || text, o);
  }
  if (text) {
    const conv = looksConversational(text);
    if (conv === 'capabilities') return capabilitiesReport();
    if (conv === 'smalltalk') return smalltalkReport(text);
  }
  return runTool(mode as ToolMode, text, o);
}

async function runTool(mode: ToolMode | string, text: string, o: AskOpts): Promise<Report> {
  const kwOpts = { siteUrl: o.siteUrl, extraInfo: o.extraInfo };
  switch (mode) {
    case 'research':
      if (!text) throw new Error('Give me a keyword to research, e.g. "research best running shoes".');
      return runResearch(text, kwOpts);
    case 'competitors':
      if (!text) throw new Error('Which keyword? e.g. "analyze competitors for best running shoes".');
      return runCompetitorAnalysis(text, kwOpts);
    case 'gap':
      if (!text) throw new Error('Which keyword? e.g. "content gaps for best running shoes".');
      return runGapAnalysis(text, kwOpts);
    case 'keywords':
      if (!text) throw new Error('Give me a seed keyword, e.g. "expand keywords for running shoes".');
      return runKeywordExpansion(text, kwOpts);
    case 'brand': {
      const site = o.siteUrl || text;
      if (!site) throw new Error('Give me your website URL, e.g. "brand voice yourbrand.com".');
      return runBrandAnalysis(site, o.extraInfo || undefined);
    }
    case 'evidence':
      if (!text) throw new Error('Which keyword? e.g. "gather evidence for best running shoes".');
      return runEvidence(text, kwOpts);
    case 'write':
      if (!text) throw new Error('Which keyword? e.g. "write about best running shoes".');
      return runWrite(text, kwOpts);
    // For the review tools, the composer text may be EITHER a keyword (whose
    // stored draft we check) or pasted content. Pass both; the service prefers
    // long pasted content and otherwise resolves the keyword's draft.
    case 'factcheck':
      return runFactCheck({ keyword: text, content: o.content || text, correct: o.correct });
    case 'aicheck':
      return runAiCheck({ keyword: text, content: o.content || text });
    case 'eeat':
      return runEeatCheck({ keyword: text, content: o.content || text, params: o.params });
    case 'audit':
      return runSelfAudit({ keyword: text, content: o.content || text });
    case 'gate':
      if (!text) throw new Error('Which keyword? Run the gate on a written draft, e.g. "run the gate on best running shoes".');
      return runGate(text);
    case 'workflow':
      if (!text) throw new Error('Give me a keyword (and ideally your site URL) to run the full workflow.');
      return runWorkflow({ keyword: text, siteUrl: o.siteUrl, extraInfo: o.extraInfo, eeatParams: o.params });
    default:
      throw new Error(`Unknown mode: ${mode}`);
  }
}

const str = (v: unknown) => String(v ?? '').trim();
function errorReport(message: string): Report {
  return { tag: 'Error', title: 'Could not complete that', blocks: [b.note(message)] };
}

/* -------------------------------------------------------------------------- */
/* Direct per-feature endpoints (each feature is also independently callable)  */
/* -------------------------------------------------------------------------- */

api.post('/research', h((b2) => runResearch(b2.keyword, opt(b2))));
api.post('/competitors', h((b2) => runCompetitorAnalysis(b2.keyword, opt(b2))));
api.post('/gap', h((b2) => runGapAnalysis(b2.keyword, opt(b2))));
api.post('/keywords', h((b2) => runKeywordExpansion(b2.keyword, opt(b2))));
api.post('/brand', h((b2) => runBrandAnalysis(b2.siteUrl || b2.keyword, b2.keyword)));
api.post('/evidence', h((b2) => runEvidence(b2.keyword, opt(b2))));
api.post('/write', h((b2) => runWrite(b2.keyword, opt(b2))));
api.post('/gate', h((b2) => runGate(str(b2.keyword))));
api.post('/factcheck', h((b2) => runFactCheck({ keyword: str(b2.keyword), content: str(b2.content), correct: !!b2.correct })));
api.post('/aicheck', h((b2) => runAiCheck({ keyword: str(b2.keyword), content: str(b2.content) })));
api.post('/eeat', h((b2) => runEeatCheck({ keyword: str(b2.keyword), content: str(b2.content), params: str(b2.params) })));
api.post('/audit', h((b2) => runSelfAudit({ keyword: str(b2.keyword), content: str(b2.content) })));
api.post('/workflow', h((b2) => runWorkflow({ keyword: str(b2.keyword), siteUrl: str(b2.siteUrl), extraInfo: str(b2.extraInfo), eeatParams: str(b2.params) })));

function opt(b2: any) { return { siteUrl: str(b2.siteUrl), extraInfo: str(b2.extraInfo) }; }
function h(fn: (body: any) => Promise<Report>) {
  return async (req: any, res: any) => {
    try { res.json({ ok: true, report: await fn(req.body || {}) }); }
    catch (e: any) { res.status(200).json({ ok: false, report: errorReport(e?.message || String(e)) }); }
  };
}

/* -------------------------------------------------------------------------- */
/* Content library (projects) — powers the sidebar                             */
/* -------------------------------------------------------------------------- */

api.get('/projects', async (_req, res) => {
  res.json({ ok: true, projects: await listProjects() });
});

api.get('/projects/:key', async (req, res) => {
  const p = await loadProject(req.params.key);
  if (!p) { res.status(404).json({ ok: false, error: 'not found' }); return; }
  res.json({ ok: true, project: p, report: projectReport(p) });
});

api.delete('/projects/:key', async (req, res) => {
  res.json({ ok: await deleteProject(req.params.key) });
});

/** A compact overview report for an existing project (opened from the sidebar). */
function projectReport(p: any): Report {
  const blocks = [];
  blocks.push(b.p(`Project: "${p.keyword}"${p.siteUrl ? ` · ${p.siteUrl}` : ''} — status: ${p.status}.`));
  blocks.push(b.kv([
    { k: 'Ranking pages', v: String(p.research?.topBlogs?.length || 0) },
    { k: 'Avg competitor length', v: p.research?.avgWordCount != null ? `${p.research.avgWordCount.toLocaleString()} words` : '—' },
    { k: 'Competitors analysed', v: String((p.competitors || []).filter((c: any) => c.reachable).length) },
    { k: 'Draft', v: p.draft ? `${(p.draft as ContentDraft).wordCount.toLocaleString()} words` : 'not yet' },
    { k: 'E-E-A-T', v: p.eeat ? `${(p.eeat as any).overall}/100` : '—' },
    { k: 'Last updated', v: new Date(p.updatedAt).toLocaleString('en-US') },
  ]));
  const draft = p.draft as ContentDraft | undefined;
  if (draft?.markdown) { blocks.push(b.p(`Latest draft — ${draft.title}:`)); blocks.push(b.note(draft.markdown)); }
  blocks.push(b.chips(['Analyze competitors', 'Find content gaps', 'Write draft', 'Fact-check this draft', 'Check E-E-A-T']));
  return { tag: 'Project', title: p.keyword, blocks, data: { key: p.key, keyword: p.keyword, hasDraft: !!draft } };
}

/* -------------------------------------------------------------------------- */
/* Status                                                                      */
/* -------------------------------------------------------------------------- */

api.get('/status', async (req, res) => {
  const projects = await listProjects().catch(() => []);
  res.json({
    auth: authInfo(req),
    llm: llmInfo(),
    serp: { enabled: serpEnabled(), provider: config.serp.provider },
    projects: { count: projects.length },
    brand: { name: config.brand.name },
  });
});
