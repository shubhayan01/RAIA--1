import { completeJSON, llmConfigured } from '../llm';
import { Report, b } from '../lib/report';
import { loadProject, saveProject } from '../lib/project';
import { ContentDraft } from './write';

/**
 * AI-content detection (SCRIBE Feature — "check what AI writes", available standalone).
 *
 * The DETERMINISTIC signals below are measured directly from the text (sentence-
 * length variance / burstiness, AI-tell phrase hits, vocabulary diversity) — no
 * model involved, so they can't be gamed by the model grading itself. An optional
 * LLM pass adds a qualitative read. Detectors are heuristics, reported honestly as
 * such — not a guarantee.
 */

const AI_PHRASES = [
  "in today's fast-paced world", 'in the ever-evolving', 'in the realm of', 'navigating the world of',
  "it's important to note", "it's worth noting", 'when it comes to', 'at the end of the day',
  'let\'s dive in', 'let\'s delve into', 'delve into', 'dive deep', 'a testament to', 'plays a crucial role',
  'plays a vital role', 'in conclusion', 'in summary', 'unlock the', 'unleash the', 'harness the power',
  'the world of', 'gone are the days', 'more than just', 'not only', 'elevate your', 'take your',
  'to the next level', 'game-changer', 'game changer', 'seamless', 'robust', 'leverage', 'tapestry',
  'ever-changing', 'fast-paced', 'realm', 'landscape of', 'embark on', 'a myriad of', 'foster',
  'cutting-edge', 'in the digital age', 'stand out from the crowd',
];

export interface AiCheckResult {
  wordCount: number;
  sentenceCount: number;
  avgSentenceLength: number;
  sentenceLengthStdDev: number;   // low = uniform = AI-like ("low burstiness")
  burstiness: 'low' | 'medium' | 'high';
  vocabularyDiversity: number;    // unique/total (type-token ratio)
  aiPhraseHits: { phrase: string; count: number }[];
  aiPhraseTotal: number;
  genericSentences: string[];     // sentences with no entity, number, or example (templated filler)
  genericRatio: number;           // generic / substantive sentences (0-1)
  heuristicScore: number;         // 0-100, higher = more AI-like
  llmVerdict?: { likelihood: string; reasons: string[]; humanizeTips: string[] };
  checkedAt: string;
}

export async function runAiCheck(input: { keyword?: string; content?: string }): Promise<Report> {
  const { text, label, projectKey } = await resolveContent(input);
  if (!text) {
    return { tag: 'AI Check', title: 'Nothing to check', blocks: [b.note('Paste content to scan, or give me a keyword whose draft to scan, e.g. "ai-check running-shoes".')] };
  }

  const result = measure(text);
  if (llmConfigured()) result.llmVerdict = await llmPass(text).catch(() => undefined);

  if (projectKey) {
    const project = await loadProject(projectKey);
    if (project) { project.aicheck = result; await saveProject(project); }
  }
  return aiCheckReport(label, result, projectKey);
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

function measure(raw: string): AiCheckResult {
  const text = raw.replace(/```[\s\S]*?```/g, ' ').replace(/[#*_>`]/g, ' ');
  const words = text.split(/\s+/).filter(Boolean);
  const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.split(/\s+/).length >= 2);
  const lengths = sentences.map((s) => s.split(/\s+/).length);
  const avg = lengths.length ? lengths.reduce((a, c) => a + c, 0) / lengths.length : 0;
  const variance = lengths.length ? lengths.reduce((a, c) => a + (c - avg) ** 2, 0) / lengths.length : 0;
  const std = Math.sqrt(variance);

  const lower = text.toLowerCase();
  const hits: { phrase: string; count: number }[] = [];
  for (const p of AI_PHRASES) {
    const count = (lower.match(new RegExp(escapeRe(p), 'g')) || []).length;
    if (count) hits.push({ phrase: p, count });
  }
  const aiPhraseTotal = hits.reduce((a, h) => a + h.count, 0);

  const unique = new Set(words.map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, ''))).size;
  const diversity = words.length ? +(unique / words.length).toFixed(3) : 0;

  const generic = genericnessOf(raw);

  const burstiness: AiCheckResult['burstiness'] = std < 4 ? 'low' : std < 7 ? 'medium' : 'high';

  // Heuristic AI-likeness score: uniform sentences + phrase clichés + low diversity push it up.
  let score = 0;
  if (burstiness === 'low') score += 40; else if (burstiness === 'medium') score += 18;
  score += Math.min(35, aiPhraseTotal * 7);
  if (diversity < 0.35) score += 20; else if (diversity < 0.45) score += 10;
  score = Math.min(100, Math.round(score));

  return {
    wordCount: words.length,
    sentenceCount: sentences.length,
    avgSentenceLength: Math.round(avg),
    sentenceLengthStdDev: +std.toFixed(1),
    burstiness,
    vocabularyDiversity: diversity,
    aiPhraseHits: hits.sort((a, c) => c.count - a.count),
    aiPhraseTotal,
    genericSentences: generic.sentences,
    genericRatio: generic.ratio,
    heuristicScore: score,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Deterministic genericness signal (cheap, no model): a sentence is "templated
 * filler" if it carries NO specificity — no proper noun (a mid-sentence
 * capitalized word), no digit, no quotation, and no obvious example marker. Such
 * sentences are interchangeable with any competitor's guide on the topic. The gate
 * uses the ratio as a blocking signal; the list tells the fixer what to rewrite.
 */
export function genericnessOf(raw: string): { sentences: string[]; ratio: number; count: number } {
  const text = raw.replace(/```[\s\S]*?```/g, ' ').replace(/^#{1,6}\s+.*$/gm, ' ').replace(/[#*_>`|]/g, ' ');
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.split(/\s+/).length >= 6);
  const generic: string[] = [];
  for (const s of sentences) {
    const hasNumber = /\d/.test(s);
    const hasQuote = /["“”]/.test(s);
    const hasExample = /\b(for example|for instance|e\.g\.|such as|say you|imagine|consider)\b/i.test(s);
    // A proper noun = a capitalized word that is NOT the first word of the sentence.
    const hasProperNoun = /\s([A-Z][a-zA-Z]{2,})/.test(s.replace(/^[^A-Za-z]*/, ''));
    if (!hasNumber && !hasQuote && !hasExample && !hasProperNoun) generic.push(s.slice(0, 160));
  }
  const ratio = sentences.length ? +(generic.length / sentences.length).toFixed(2) : 0;
  return { sentences: generic.slice(0, 12), ratio, count: generic.length };
}

const LLM_SYSTEM = `You assess whether a passage reads like unedited AI output. Judge tone, rhythm, and cliché density — not facts.

Return ONLY minified JSON:
{"likelihood": "low|medium|high",
 "reasons": string[],        // concrete tells you observe (or signs of human authorship)
 "humanizeTips": string[]}   // 3-5 specific edits to make it read more human

Be concrete and reference the actual writing.`;

async function llmPass(text: string) {
  return completeJSON<{ likelihood: string; reasons: string[]; humanizeTips: string[] }>(
    LLM_SYSTEM, text.slice(0, 12000), { temperature: 0.3, maxTokens: 900 },
  );
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ------------------------------ report ------------------------------ */

export function aiCheckReport(label: string, r: AiCheckResult, projectKey?: string): Report {
  const blocks = [];
  const band = r.heuristicScore >= 60 ? 'high' : r.heuristicScore >= 35 ? 'medium' : 'low';
  blocks.push(b.p(`AI-pattern scan of ${label}. Heuristic AI-likeness: ${r.heuristicScore}/100 (${band}). These are signals, not proof — treat them as edit prompts.`));

  blocks.push(b.kv([
    { k: 'Sentence variance (burstiness)', v: `${r.sentenceLengthStdDev} → ${r.burstiness}${r.burstiness === 'low' ? ' — too uniform, vary sentence length' : ''}` },
    { k: 'Avg sentence length', v: `${r.avgSentenceLength} words` },
    { k: 'Vocabulary diversity', v: `${r.vocabularyDiversity}${r.vocabularyDiversity < 0.4 ? ' — repetitive' : ''}` },
    { k: 'AI-tell phrases', v: String(r.aiPhraseTotal) },
    { k: 'Generic/filler sentences', v: `${r.genericSentences.length} (${Math.round(r.genericRatio * 100)}% of sentences)` },
  ]));

  if (r.aiPhraseHits.length) {
    blocks.push(b.p('Flagged phrases to rewrite:'));
    blocks.push(b.chips(r.aiPhraseHits.slice(0, 16).map((h) => `${h.phrase}${h.count > 1 ? ` ×${h.count}` : ''}`)));
  }

  if (r.llmVerdict) {
    blocks.push(b.note(`Qualitative read: ${r.llmVerdict.likelihood} likelihood AI-written.`));
    if (r.llmVerdict.reasons?.length) blocks.push(b.list(r.llmVerdict.reasons));
    if (r.llmVerdict.humanizeTips?.length) { blocks.push(b.p('To humanize:')); blocks.push(b.list(r.llmVerdict.humanizeTips)); }
  }

  return { tag: 'AI Check', title: `AI-pattern scan — ${label}`, blocks, data: { key: projectKey } };
}
