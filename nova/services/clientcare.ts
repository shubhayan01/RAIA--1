import { config } from '../config';
import { dataPath, readJson, writeJson, safeDomainKey } from '../lib/jsonStore';
import { sendMail, emailConfigured } from '../lib/email';
import { complete, llmConfigured } from '../llm';
import { Report, b } from '../lib/report';

/**
 * Client care system (Feature 7). Relationship layer for EXISTING clients:
 * birthday / retainer-anniversary / check-in reminders, each drafted and surfaced
 * as an approval card. NOVA never auto-sends a care email.
 */

export interface Client {
  domain: string;
  companyName: string;
  contactName: string;
  contactEmail: string;
  retainerStartDate: string;       // ISO
  birthdayMonth?: number;          // 1-12
  birthdayDay?: number;
  anniversaryDate?: string;        // ISO (defaults to retainerStartDate)
  timezone?: string;
  notes: string;
  lastCheckInAt?: string;          // ISO
  checkInFrequencyDays: number;
}
interface ClientsDoc { clients: Record<string, Client>; }

const FILE = dataPath('clients', 'index.json');
async function load(): Promise<ClientsDoc> { return readJson<ClientsDoc>(FILE, { clients: {} }); }
async function save(doc: ClientsDoc): Promise<void> { await writeJson(FILE, doc); }

export async function addClient(input: Partial<Client> & { domain: string }): Promise<Client> {
  const key = safeDomainKey(input.domain);
  const doc = await load();
  const client: Client = {
    domain: key,
    companyName: input.companyName || key,
    contactName: input.contactName || '',
    contactEmail: input.contactEmail || '',
    retainerStartDate: input.retainerStartDate || new Date().toISOString(),
    birthdayMonth: input.birthdayMonth,
    birthdayDay: input.birthdayDay,
    anniversaryDate: input.anniversaryDate || input.retainerStartDate,
    timezone: input.timezone || config.meeting.timezone,
    notes: input.notes || '',
    lastCheckInAt: input.lastCheckInAt,
    checkInFrequencyDays: input.checkInFrequencyDays || config.clientcare.defaultCheckInDays,
  };
  doc.clients[key] = { ...doc.clients[key], ...client };
  await save(doc);
  return doc.clients[key];
}

export async function listClients(): Promise<Client[]> {
  return Object.values((await load()).clients);
}

export async function updateClient(domain: string, patch: Partial<Client>): Promise<Client | null> {
  const key = safeDomainKey(domain);
  const doc = await load();
  if (!doc.clients[key]) return null;
  doc.clients[key] = { ...doc.clients[key], ...patch, domain: key };
  await save(doc);
  return doc.clients[key];
}

/* ------------------------- daily occasion checks ------------------------- */

export type CareType = 'birthday' | 'anniversary' | 'checkin';
export interface CareAction {
  type: CareType;
  domain: string;
  client: string;
  reason: string;
  draft?: string;
}

function isSameMonthDay(d: Date, month: number, day: number): boolean {
  return d.getMonth() + 1 === month && d.getDate() === day;
}

/** Today's due care actions across all clients (drafts generated on demand). */
export async function getCareActions(now = new Date()): Promise<CareAction[]> {
  const clients = await listClients();
  const actions: CareAction[] = [];

  for (const c of clients) {
    // Birthday
    if (c.birthdayMonth && c.birthdayDay && isSameMonthDay(now, c.birthdayMonth, c.birthdayDay)) {
      actions.push({ type: 'birthday', domain: c.domain, client: c.contactName || c.companyName, reason: `Today is ${c.contactName || c.companyName}'s birthday` });
    }
    // Retainer anniversary — only a real one (1+ full years since the start).
    const anniv = c.anniversaryDate || c.retainerStartDate;
    if (anniv) {
      const a = new Date(anniv);
      const years = now.getFullYear() - a.getFullYear();
      if (isSameMonthDay(now, a.getMonth() + 1, a.getDate()) && years >= 1) {
        actions.push({ type: 'anniversary', domain: c.domain, client: c.companyName, reason: `${years} year${years === 1 ? '' : 's'} retainer anniversary` });
      }
    }
    // Check-in overdue
    const last = c.lastCheckInAt ? new Date(c.lastCheckInAt).getTime() : new Date(c.retainerStartDate).getTime();
    const daysSince = Math.floor((now.getTime() - last) / 86_400_000);
    if (daysSince >= c.checkInFrequencyDays) {
      actions.push({ type: 'checkin', domain: c.domain, client: c.companyName, reason: `No check-in for ${daysSince} days` });
    }
  }

  // Draft copy for each (best-effort).
  for (const a of actions) a.draft = (await draftCare(a)) || undefined;
  return actions;
}

async function draftCare(a: CareAction): Promise<string | null> {
  if (!llmConfigured()) return null;
  const doc = await load();
  const c = doc.clients[a.domain];
  if (!c) return null;

  let system = '';
  if (a.type === 'birthday') {
    system = `Write a warm, personal birthday email (3 sentences max) to a client contact. Reference their business or something specific from the notes. No marketing, no pitch. Sign off as ${config.agency.senderName}.`;
  } else if (a.type === 'anniversary') {
    system = `Write a warm retainer-anniversary message. Thank them for their partnership, mention one specific positive outcome if it's in the notes, keep it brief and human. Sign off as ${config.agency.senderName}.`;
  } else {
    system = `Write a brief check-in email to a client. Ask how things are going, reference their current work/goals if in the notes, and offer to review recent SEO performance. Warm and human, under 90 words. Sign off as ${config.agency.senderName}.`;
  }
  const payload = { contactName: c.contactName, companyName: c.companyName, notes: c.notes, reason: a.reason };
  try {
    return (await complete(system, JSON.stringify(payload), { temperature: 0.6, maxTokens: 400 })).trim();
  } catch {
    return null;
  }
}

/** Approve + send a care email; records the check-in for check-in type. */
export async function approveCare(domain: string, type: CareType, override?: string): Promise<{ ok: boolean; error?: string }> {
  const doc = await load();
  const c = doc.clients[safeDomainKey(domain)];
  if (!c) return { ok: false, error: 'Unknown client.' };
  if (!emailConfigured()) return { ok: false, error: 'SMTP not configured.' };
  if (!c.contactEmail) return { ok: false, error: 'No contact email on file for this client.' };

  const actions = await getCareActions();
  const action = actions.find((a) => a.domain === c.domain && a.type === type);
  const body = override || action?.draft;
  if (!body) return { ok: false, error: 'No draft available — add an LLM key or provide copy.' };

  const subjects: Record<CareType, string> = {
    birthday: `Happy birthday, ${c.contactName || c.companyName}!`,
    anniversary: `Thank you — our partnership with ${c.companyName}`,
    checkin: `Checking in — ${c.companyName}`,
  };
  try {
    await sendMail({ to: c.contactEmail, subject: subjects[type], text: body });
    if (type === 'checkin') { c.lastCheckInAt = new Date().toISOString(); await save(doc); }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/* ------------------------- chat surface ------------------------- */

export async function clientCareReport(): Promise<Report> {
  const actions = await getCareActions();
  if (!actions.length) {
    const total = (await listClients()).length;
    return { tag: 'Client Care', title: 'Nothing due today', blocks: [b.p(total ? `All ${total} clients are up to date — no birthdays, anniversaries or overdue check-ins today.` : 'No clients added yet. POST /api/clients to add one.')] };
  }
  const blocks = [b.tasks(actions.map((a) => ({
    title: `${a.client} — ${a.type}`,
    priority: (a.type === 'checkin' ? 'medium' : 'high') as 'medium' | 'high',
    detail: a.reason,
  })))];
  for (const a of actions) {
    if (a.draft) { blocks.push(b.p(`${a.client} — ${a.type}:`)); blocks.push(b.note(a.draft)); }
    blocks.push(b.chips([`Approve ${a.type} for ${a.domain}`, `Skip ${a.type} for ${a.domain}`]));
  }
  return { tag: 'Client Care', title: "Today's client care", blocks, data: { actions } };
}

/* ------------------------- scheduler + status ------------------------- */

let task: any = null;
let started = false;
export async function initClientCareScheduler(): Promise<void> {
  if (started) return;
  started = true;
  if (!config.clientcare.enabled) return;
  try {
    const pkg = 'node-cron';
    const mod: any = await import(pkg).catch(() => { throw new Error('node-cron not installed'); });
    const cron = mod.default || mod;
    if (!cron.validate(config.clientcare.cron)) return;
    task = cron.schedule(config.clientcare.cron, () => { void getCareActions(); });
    console.log(`  ▸ Client-care scheduler: ON (${config.clientcare.cron})`);
  } catch (e: any) {
    console.warn(`  ⚠ Client-care scheduler could not start: ${e?.message || e}`);
  }
}

export async function clientcareStatus() {
  const actions = await getCareActions().catch(() => []);
  return { enabled: config.clientcare.enabled, clients: (await listClients()).length, actionsDueToday: actions.length };
}
