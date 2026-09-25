import { completeJSON, llmConfigured } from '../llm';
import { Report, b } from '../lib/report';
import { loadProject, saveProject } from '../lib/project';
import { ContentDraft } from './write';
import { rubricText } from '../lib/eeatParams';

/**
 * E-E-A-T scoring (SCRIBE Feature 7 — available standalone).
 *
 * Google's quality lens: Experience, Expertise, Authoritativeness, Trust. The
 * user can supply their OWN parameters (custom criteria / weightings / a rubric)
 * and SCRIBE applies them to the content. Objective signals (citations, byline,
 * first-hand-experience markers, dates, outbound links) are DETECTED from the
 * text; the LLM then scores each dimension against those real signals and the
 * user's parameters — it does not award authority the text hasn't earned.
 */

export interface EeatSignals {
  outboundLinks: number;
  citationsOrSources: number;
  hasAuthorByline: boolean;
  firstPersonExperience: number;   // count of experience markers ("I tested", "we found", "in our experience")
  statistics: number;
  dates: number;
  wordCount: number;
}

export interface EeatDimension {
  score: number;         // 0-100
  strengths: string[];
  gaps: string[];
}

export interface EeatResult {
  parametersUsed: string;
  signals: EeatSignals;
  experience: EeatDimension;
  expertise: EeatDimension;
  authoritativeness: EeatDimension;
  trust: EeatDimension;
  overall: number;
  priorityFixes: { title: string; priority: 'critical' | 'high' | 'medium' | 'low'; detail: string }[];
  checkedAt: string;
}

export async function runEeatCheck(input: { keyword?: string; content?: string; params?: string }): Promise<Report> {
  const { text, label, projectKey } = await resolveContent(input);
  if (!text) {
    return { tag: 'E-E-A-T', title: 'Nothing to check', blocks: [b.note('Paste content to score, or give a keyword whose draft to score. You can also pass your own E-E-A-T parameters.')] };
  }
  if (!llmConfigured()) {
    return { tag: 'E-E-A-T', title: 'LLM required', blocks: [b.note('Add an LLM key — E-E-A-T scoring reasons over the detected signals against your parameters.')] };
  }

  const signals = detectSignals(text);
  const params = (input.params || '').trim() || DEFAULT_PARAMS;
  const scored = await score(text, signals, params);
  if (!scored) return { tag: 'E-E-A-T', title: `E-E-A-T — ${label}`, blocks: [b.note('Could not compute the E-E-A-T score. Retry.')] };

  if (projectKey) {
    const project = await loadProject(projectKey);
    if (project) { project.eeat = scored; await saveProject(project); }
  }
  return eeatReport(label, scored, projectKey);
}

async function resolveContent(input: { keyword?: string; content?: string }): Promise<{ text: string; label: string; projectKey?: string }> {
  if (input.content && input.content.trim().split(/\s+/).length > 25) {
    return { text: input.content.trim(), label: 'pasted content' };
  }
  const kw = (input.keyword || input.content || '').trim();
  if (kw) {
    const project = await loadProject(kw);
    const draft = project?.draft as ContentDraft | undefined;
    if (draft?.markdown) return { text: draft.markdown, label: draft.title || kw, projectKey: project!.key };
  }
  return { text: '', label: '' };
}

function detectSignals(text: string): EeatSignals {
  const outbound = (text.match(/\]\(https?:\/\/[^)]+\)/g) || []).length + (text.match(/https?:\/\/\S+/g) || []).length;
  const citations = (text.match(/\b(according to|source:|study|research|report|survey|data from|per\s+[A-Z])/gi) || []).length;
  const byline = /\b(by\s+[A-Z][a-z]+\s+[A-Z][a-z]+|author:|written by)\b/.test(text);
  const firstPerson = (text.match(/\b(I tested|I tried|we tested|we found|in our experience|I've|we've used|our team|when I|after testing|hands-on)\b/gi) || []).length;
  const stats = (text.match(/\b\d+(\.\d+)?\s?%|\b\d{2,}\b/g) || []).length;
  const dates = (text.match(/\b(19|20)\d{2}\b|\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/g) || []).length;
  const words = text.replace(/[#*_>`]/g, ' ').split(/\s+/).filter(Boolean).length;
  return {
    outboundLinks: outbound, citationsOrSources: citations, hasAuthorByline: byline,
    firstPersonExperience: firstPerson, statistics: stats, dates, wordCount: words,
  };
}

// The default rubric is SCRIBE's shared E-E-A-T parameter catalog — the same one
// the writer selects from — so scoring and writing never use different yardsticks.
const DEFAULT_PARAMS = rubricText();

const SCORE_SYSTEM = `You are a Google-quality-rater-style evaluator scoring content on E-E-A-T. You are given: the article, the DETECTED objective signals (measured from the text), and the PARAMETERS to apply (which may be the user's own rubric).

Score each dimension 0-100 based ONLY on what the article actually demonstrates and the detected signals — do not credit authority the text has not earned. Apply the user's parameters where given.

Return ONLY minified JSON:
{"experience": {"score": number, "strengths": string[], "gaps": string[]},
 "expertise": {"score": number, "strengths": string[], "gaps": string[]},
 "authoritativeness": {"score": number, "strengths": string[], "gaps": string[]},
 "trust": {"score": number, "strengths": string[], "gaps": string[]},
 "overall": number,
 "priorityFixes": [{"title": string, "priority": "critical|high|medium|low", "detail": string}]}

Rules:
- Ground strengths/gaps in the real content and signals.
- If the article has no byline or no sources, Authoritativeness/Trust must reflect that.
- 3-6 priority fixes, most impactful first.`;

async function score(text: string, signals: EeatSignals, params: string): Promise<EeatResult | null> {
  try {
    const r = await completeJSON<Omit<EeatResult, 'parametersUsed' | 'signals' | 'checkedAt'>>(
      SCORE_SYSTEM,
      JSON.stringify({ parameters: params, detectedSignals: signals, article: text.slice(0, 14000) }),
      { temperature: 0.2, maxTokens: 1800 },
    );
    return {
      parametersUsed: params,
      signals,
      experience: r.experience, expertise: r.expertise,
      authoritativeness: r.authoritativeness, trust: r.trust,
      overall: r.overall, priorityFixes: r.priorityFixes || [],
      checkedAt: new Date().toISOString(),
    };
  } catch { return null; }
}

/* ------------------------------ report ------------------------------ */

export function eeatReport(label: string, r: EeatResult, projectKey?: string): Report {
  const blocks = [];
  blocks.push(b.p(`E-E-A-T score for ${label}: ${r.overall}/100. Scored against ${r.parametersUsed === DEFAULT_PARAMS ? "Google's standard E-E-A-T" : 'your parameters'}, grounded in the signals detected in the text.`));

  blocks.push(b.table(
    ['Dimension', 'Score', 'Top strength', 'Top gap'],
    [
      ['Experience', r.experience.score, (r.experience.strengths[0] || '—').slice(0, 44), (r.experience.gaps[0] || '—').slice(0, 44)],
      ['Expertise', r.expertise.score, (r.expertise.strengths[0] || '—').slice(0, 44), (r.expertise.gaps[0] || '—').slice(0, 44)],
      ['Authoritativeness', r.authoritativeness.score, (r.authoritativeness.strengths[0] || '—').slice(0, 44), (r.authoritativeness.gaps[0] || '—').slice(0, 44)],
      ['Trust', r.trust.score, (r.trust.strengths[0] || '—').slice(0, 44), (r.trust.gaps[0] || '—').slice(0, 44)],
    ],
  ));

  blocks.push(b.kv([
    { k: 'Author byline', v: r.signals.hasAuthorByline ? 'present' : 'missing — add an author with credentials' },
    { k: 'Outbound links / sources', v: `${r.signals.outboundLinks} links · ${r.signals.citationsOrSources} source cues` },
    { k: 'First-hand experience markers', v: String(r.signals.firstPersonExperience) },
    { k: 'Stats / dates', v: `${r.signals.statistics} stats · ${r.signals.dates} dates` },
  ]));

  if (r.priorityFixes?.length) {
    blocks.push(b.p('Priority fixes:'));
    blocks.push(b.tasks(r.priorityFixes.map((f) => ({ title: f.title, priority: f.priority, detail: f.detail }))));
  }

  return { tag: 'E-E-A-T', title: `E-E-A-T — ${label} (${r.overall}/100)`, blocks, data: { key: projectKey } };
}
