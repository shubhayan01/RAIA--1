import { dataPath, readJson, writeJson, listJsonKeys } from './jsonStore';

/**
 * Content-project store — SCRIBE's "content library". One JSON file per
 * keyword project under data/projects/. Every capability reads/writes the same
 * project object, so the full workflow and the standalone tools share state.
 *
 * Deliberately simple (read → mutate → write), same pattern as NOVA's stores.
 */

export type ProjectStatus = 'new' | 'researched' | 'analyzed' | 'drafted' | 'reviewed';

/* ---- sub-shapes (kept loose; each service owns its own detailed types) ---- */
export interface ResearchData {
  keyword: string;
  provider: string;
  fetchedAt: string;
  topBlogs: { position: number; title: string; url: string; domain: string; snippet: string; wordCount?: number | null }[];
  avgWordCount: number | null;
  medianWordCount: number | null;
  relatedSearches: string[];
  peopleAlsoAsk: string[];
  aiOverviewSources: string[];
  serpError?: string | null;
}

export interface CompetitorAnalysis {
  url: string;
  domain: string;
  title: string | null;
  wordCount: number;
  h2Count: number;
  h3Count: number;
  headings: { level: number; text: string }[];
  hasFAQ: boolean;
  hasTable: boolean;
  hasList: boolean;
  imageCount: number;
  authorHint: string | null;
  reachable: boolean;
  error?: string;
}

export interface ContentProject {
  key: string;
  keyword: string;
  siteUrl: string;
  extraInfo?: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;

  research?: ResearchData;
  competitors?: CompetitorAnalysis[];
  gap?: unknown;
  keywords?: unknown;
  brand?: unknown;
  evidence?: unknown;
  draft?: unknown;
  factcheck?: unknown;
  aicheck?: unknown;
  eeat?: unknown;
  selfaudit?: unknown;
  gate?: unknown;
  meta?: Record<string, unknown>;
}

/** Filesystem-safe key derived from a keyword (+ optional site to disambiguate). */
export function keywordKey(keyword: string): string {
  return (keyword || '')
    .trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'untitled';
}

function fileFor(key: string): string {
  return dataPath('projects', `${key}.json`);
}

export async function loadProject(keyOrKeyword: string): Promise<ContentProject | null> {
  const key = /[^a-z0-9-]/i.test(keyOrKeyword) ? keywordKey(keyOrKeyword) : keyOrKeyword;
  return readJson<ContentProject | null>(fileFor(key), null);
}

export async function saveProject(p: ContentProject): Promise<ContentProject> {
  p.updatedAt = new Date().toISOString();
  await writeJson(fileFor(p.key), p);
  return p;
}

/** Get an existing project for a keyword, or create a fresh one. */
export async function ensureProject(keyword: string, siteUrl = '', extraInfo = ''): Promise<ContentProject> {
  const key = keywordKey(keyword);
  const existing = await loadProject(key);
  if (existing) {
    if (siteUrl) existing.siteUrl = siteUrl;
    if (extraInfo) existing.extraInfo = extraInfo;
    return existing;
  }
  const now = new Date().toISOString();
  const fresh: ContentProject = {
    key, keyword: keyword.trim(), siteUrl, extraInfo,
    status: 'new', createdAt: now, updatedAt: now,
  };
  await saveProject(fresh);
  return fresh;
}

/** Bump status only forward (never regress a further-along project). */
export function advanceStatus(p: ContentProject, to: ProjectStatus): void {
  const order: ProjectStatus[] = ['new', 'researched', 'analyzed', 'drafted', 'reviewed'];
  if (order.indexOf(to) > order.indexOf(p.status)) p.status = to;
}

export interface ProjectSummary {
  key: string;
  keyword: string;
  siteUrl: string;
  status: ProjectStatus;
  updatedAt: string;
  topBlogs: number;
  avgWordCount: number | null;
  hasDraft: boolean;
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const keys = await listJsonKeys('projects');
  const out: ProjectSummary[] = [];
  for (const key of keys) {
    const p = await loadProject(key);
    if (!p) continue;
    out.push({
      key: p.key,
      keyword: p.keyword,
      siteUrl: p.siteUrl,
      status: p.status,
      updatedAt: p.updatedAt,
      topBlogs: p.research?.topBlogs?.length || 0,
      avgWordCount: p.research?.avgWordCount ?? null,
      hasDraft: !!p.draft,
    });
  }
  return out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export async function deleteProject(key: string): Promise<boolean> {
  const { promises: fs } = await import('node:fs');
  try { await fs.unlink(fileFor(key)); return true; } catch { return false; }
}
