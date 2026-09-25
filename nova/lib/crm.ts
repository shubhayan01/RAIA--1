import { dataPath, readJson, writeJson, safeDomainKey } from './jsonStore';

/**
 * CRM data layer (Feature 3). All pipeline state lives in a single JSON document
 * at data/pipeline/index.json. Deliberately simple: read → mutate → write.
 * This is the source of truth the sidebar renders and every service updates.
 */

export type Stage =
  | 'RESEARCHED'
  | 'CONTACTED'
  | 'REPLIED'
  | 'MEETING_BOOKED'
  | 'PROPOSAL_SENT'
  | 'CLOSED_WON'
  | 'CLOSED_LOST'
  | 'DEAD';

export const STAGES: Stage[] = [
  'RESEARCHED', 'CONTACTED', 'REPLIED', 'MEETING_BOOKED',
  'PROPOSAL_SENT', 'CLOSED_WON', 'CLOSED_LOST', 'DEAD',
];

export interface StageChange {
  stage: Stage;
  changedAt: string;
  note?: string;
}

export interface PipelineEntry {
  domain: string;
  companyName: string;
  contactEmail: string;
  contactName: string;
  stage: Stage;
  addedAt: string;
  lastContactAt: string | null;
  nextActionAt: string | null;
  nextActionNote: string;
  emailsSent: number;
  notes: string[];
  stageHistory: StageChange[];
  daysSinceContact?: number; // computed on read
}

export interface PipelineDoc {
  prospects: Record<string, PipelineEntry>;
}

const FILE = dataPath('pipeline', 'index.json');

export async function loadPipeline(): Promise<PipelineDoc> {
  return readJson<PipelineDoc>(FILE, { prospects: {} });
}

export async function savePipeline(doc: PipelineDoc): Promise<void> {
  await writeJson(FILE, doc);
}

function daysBetween(iso: string | null, now = Date.now()): number {
  if (!iso) return Infinity;
  return Math.floor((now - new Date(iso).getTime()) / 86_400_000);
}

/** Attach the computed `daysSinceContact` field to an entry (non-destructive copy). */
export function withComputed(e: PipelineEntry): PipelineEntry {
  const anchor = e.lastContactAt || e.addedAt;
  const d = daysBetween(anchor);
  return { ...e, daysSinceContact: Number.isFinite(d) ? d : 0 };
}

/** Upsert a prospect into the pipeline. Creates it at RESEARCHED if new. */
export async function upsertProspect(input: {
  domain: string;
  companyName?: string;
  contactEmail?: string;
  contactName?: string;
  stage?: Stage;
}): Promise<PipelineEntry> {
  const key = safeDomainKey(input.domain);
  const doc = await loadPipeline();
  const now = new Date().toISOString();
  const existing = doc.prospects[key];

  if (existing) {
    if (input.companyName) existing.companyName = input.companyName;
    if (input.contactEmail) existing.contactEmail = input.contactEmail;
    if (input.contactName) existing.contactName = input.contactName;
    if (input.stage && input.stage !== existing.stage) {
      existing.stage = input.stage;
      existing.stageHistory.push({ stage: input.stage, changedAt: now });
    }
    await savePipeline(doc);
    return withComputed(existing);
  }

  const stage: Stage = input.stage || 'RESEARCHED';
  const entry: PipelineEntry = {
    domain: key,
    companyName: input.companyName || key,
    contactEmail: input.contactEmail || '',
    contactName: input.contactName || '',
    stage,
    addedAt: now,
    lastContactAt: null,
    nextActionAt: null,
    nextActionNote: '',
    emailsSent: 0,
    notes: [],
    stageHistory: [{ stage, changedAt: now, note: 'Added to pipeline' }],
  };
  doc.prospects[key] = entry;
  await savePipeline(doc);
  return withComputed(entry);
}

export async function getProspect(domain: string): Promise<PipelineEntry | null> {
  const key = safeDomainKey(domain);
  const doc = await loadPipeline();
  const e = doc.prospects[key];
  return e ? withComputed(e) : null;
}

export async function updateStage(domain: string, stage: Stage, note?: string): Promise<PipelineEntry | null> {
  const key = safeDomainKey(domain);
  const doc = await loadPipeline();
  const e = doc.prospects[key];
  if (!e) return null;
  e.stage = stage;
  e.stageHistory.push({ stage, changedAt: new Date().toISOString(), note });
  await savePipeline(doc);
  return withComputed(e);
}

export async function addNote(domain: string, note: string): Promise<PipelineEntry | null> {
  const key = safeDomainKey(domain);
  const doc = await loadPipeline();
  const e = doc.prospects[key];
  if (!e) return null;
  e.notes.push(`${new Date().toISOString()}: ${note}`);
  await savePipeline(doc);
  return withComputed(e);
}

export async function setNextAction(domain: string, dateIso: string, note: string): Promise<PipelineEntry | null> {
  const key = safeDomainKey(domain);
  const doc = await loadPipeline();
  const e = doc.prospects[key];
  if (!e) return null;
  e.nextActionAt = dateIso;
  e.nextActionNote = note;
  await savePipeline(doc);
  return withComputed(e);
}

/** Record an outreach/follow-up send: bump count, set lastContact, move to CONTACTED if fresh. */
export async function recordContact(domain: string, opts: { moveToContacted?: boolean } = {}): Promise<PipelineEntry | null> {
  const key = safeDomainKey(domain);
  const doc = await loadPipeline();
  const e = doc.prospects[key];
  if (!e) return null;
  e.emailsSent += 1;
  e.lastContactAt = new Date().toISOString();
  if (opts.moveToContacted && (e.stage === 'RESEARCHED')) {
    e.stage = 'CONTACTED';
    e.stageHistory.push({ stage: 'CONTACTED', changedAt: e.lastContactAt, note: 'Outreach sent' });
  }
  await savePipeline(doc);
  return withComputed(e);
}

export async function listProspects(): Promise<PipelineEntry[]> {
  const doc = await loadPipeline();
  return Object.values(doc.prospects).map(withComputed);
}

/** Prospects with no contact in `days` days (default 7), excluding closed/dead. */
export async function getStale(days = 7): Promise<PipelineEntry[]> {
  const all = await listProspects();
  const terminal = new Set<Stage>(['CLOSED_WON', 'CLOSED_LOST', 'DEAD']);
  return all
    .filter((e) => !terminal.has(e.stage))
    .filter((e) => (e.daysSinceContact ?? 0) >= days)
    .sort((a, b) => (b.daysSinceContact ?? 0) - (a.daysSinceContact ?? 0));
}

export async function getSummary(): Promise<Record<Stage, number>> {
  const all = await listProspects();
  const counts = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
  for (const e of all) counts[e.stage] = (counts[e.stage] || 0) + 1;
  return counts;
}
