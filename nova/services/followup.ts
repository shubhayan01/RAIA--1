import { config } from '../config';
import { dataPath, readJson, writeJson, listJsonKeys, safeDomainKey } from '../lib/jsonStore';
import { loadProspectRecord } from './prospect';
import { getProspect, recordContact, setNextAction } from '../lib/crm';
import { sendMail, emailConfigured, assertColdSendAllowed, recordColdSend } from '../lib/email';
import { completeJSON, llmConfigured } from '../llm';
import { Report, b } from '../lib/report';

/**
 * Follow-up sequence manager (Feature 4).
 *
 * Auto-armed after outreach: day-3, day-7 (break-angle) and day-14 (break-up).
 * A daily node-cron check surfaces due items as APPROVAL cards — NOVA never
 * auto-sends a follow-up. A detected reply cancels the remaining sequence.
 */

type ItemStatus = 'pending' | 'sent' | 'skipped' | 'cancelled';
interface SequenceItem {
  n: 1 | 2 | 3;
  dueAt: string;
  status: ItemStatus;
  draft?: { subject: string; body: string };
  sentAt?: string;
}
interface Sequence {
  domain: string;
  createdAt: string;
  items: SequenceItem[];
}

function fileFor(domain: string): string {
  return dataPath('sequences', `${safeDomainKey(domain)}.json`);
}
async function load(domain: string): Promise<Sequence | null> {
  return readJson<Sequence | null>(fileFor(domain), null);
}
async function save(seq: Sequence): Promise<void> {
  await writeJson(fileFor(seq.domain), seq);
}

/** Arm the day-3 / 7 / 14 sequence after an outreach send. */
export async function scheduleSequence(domainRaw: string): Promise<Sequence> {
  const domain = safeDomainKey(domainRaw);
  const now = Date.now();
  const items: SequenceItem[] = config.followup.dayOffsets.slice(0, 3).map((days, i) => ({
    n: (i + 1) as 1 | 2 | 3,
    dueAt: new Date(now + days * 86_400_000).toISOString(),
    status: 'pending',
  }));
  const seq: Sequence = { domain, createdAt: new Date(now).toISOString(), items };
  await save(seq);
  // Reflect the next action on the pipeline card.
  await setNextAction(domain, items[0].dueAt, 'Follow-up #1 due (approve to send)');
  return seq;
}

/** Cancel remaining pending items (called when a reply is detected). */
export async function cancelSequence(domainRaw: string): Promise<void> {
  const seq = await load(domainRaw);
  if (!seq) return;
  for (const it of seq.items) if (it.status === 'pending') it.status = 'cancelled';
  await save(seq);
}

/** Reschedule pending items to resume after a given date (out-of-office). */
export async function rescheduleSequence(domainRaw: string, resumeIso: string): Promise<void> {
  const seq = await load(domainRaw);
  if (!seq) return;
  const base = new Date(resumeIso).getTime();
  let offset = 0;
  for (const it of seq.items) {
    if (it.status === 'pending') {
      it.dueAt = new Date(base + offset * 4 * 86_400_000).toISOString();
      offset++;
    }
  }
  await save(seq);
}

/* ------------------------- LLM follow-up copy ------------------------- */

function followupSystem(n: number): string {
  return `You are writing follow-up email #${n} to a prospect who did not reply to the previous email.

Follow-up 1 (day 3): Reference the first email briefly. Add one new piece of value — a relevant insight, a stat about their industry, or a question about their current challenge. Under 100 words.
Follow-up 2 (day 7): Different angle entirely. Do not mention the previous emails. Lead with a specific question about their business. Under 75 words.
Follow-up 3 (day 14): Break-up email. Acknowledge they are busy. Say you are closing their file but leave the door open. Ask one final yes/no question. Under 60 words. This email gets replies — make it human and direct.

Rules (these emails go to real prospects):
- Never mention "AI" or "automation" anywhere in the email.
- No generic openers (never "I hope this email finds you").
- Must reference the specific prospect (their name or company) — no lines that could apply to anyone.
- GROUNDING: only cite data actually present in the payload. Never invent a
  statistic, percentage, score, or specific issue (e.g. never "up to 35% more
  leads", never claim a missing meta description unless it is in the data). If
  there is no concrete metric to cite, use a real observation (their services,
  market, prior email topic) framed as a question instead of a made-up number.
- Never reference internal data-structure or field names.

Return ONLY minified JSON: {"subject":string,"body":string}`;
}

async function draftFollowup(domain: string, n: number): Promise<{ subject: string; body: string } | null> {
  if (!llmConfigured()) return null;
  const rec = await loadProspectRecord(domain);
  const entry = await getProspect(domain);
  const payload = {
    companyName: rec?.scrape.companyName || entry?.companyName || domain,
    domain,
    whatTheyDo: rec?.scrape.whatTheyDo,
    seoIssues: rec?.audit.topIssues,
    brief: rec?.brief,
    previousSubjects: (rec?.outreach || []).map((o: any) => o.subject),
    agencyName: config.agency.name,
    senderName: config.agency.senderName,
  };
  try {
    return await completeJSON<{ subject: string; body: string }>(followupSystem(n), JSON.stringify(payload), { temperature: 0.6, maxTokens: 700 });
  } catch (e: any) {
    console.warn(`  ⚠ draftFollowup(${domain}, #${n}) failed: ${e?.message || e}`);
    return null;
  }
}

/* ------------------------- due-item processing ------------------------- */

/** All items due today (or overdue) across every sequence, with drafts prepared. */
export async function getDueItems(): Promise<{ domain: string; n: number; draft: { subject: string; body: string } | null }[]> {
  const domains = await listJsonKeys('sequences');
  const now = Date.now();
  const due: { domain: string; n: number; draft: { subject: string; body: string } | null }[] = [];
  for (const domain of domains) {
    const seq = await load(domain);
    if (!seq) continue;
    for (const it of seq.items) {
      if (it.status !== 'pending') continue;
      if (new Date(it.dueAt).getTime() > now) continue;
      if (!it.draft) it.draft = (await draftFollowup(domain, it.n)) || undefined;
      due.push({ domain, n: it.n, draft: it.draft || null });
    }
    await save(seq); // persist any drafts we generated
  }
  return due;
}

/** Approve + send a specific due follow-up. Advances the sequence. */
export async function approveFollowup(domainRaw: string, n: number, override?: { subject: string; body: string }): Promise<{ ok: boolean; error?: string }> {
  const seq = await load(domainRaw);
  if (!seq) return { ok: false, error: 'No sequence for that prospect.' };
  const item = seq.items.find((i) => i.n === n && i.status === 'pending');
  if (!item) return { ok: false, error: 'No pending follow-up with that number.' };
  if (!emailConfigured()) return { ok: false, error: 'SMTP not configured.' };

  const rec = await loadProspectRecord(domainRaw);
  const to = rec?.emailHint || rec?.scrape.contacts.emails[0] || '';
  if (!to) return { ok: false, error: 'No recipient email on file.' };

  const draft = override || item.draft || (await draftFollowup(domainRaw, n));
  if (!draft) return { ok: false, error: 'Could not prepare the follow-up copy.' };

  try {
    await assertColdSendAllowed(); // kill-switch + daily cap
    await sendMail({ to, subject: draft.subject, text: draft.body });
    await recordColdSend();
    item.status = 'sent';
    item.sentAt = new Date().toISOString();
    await save(seq);
    await recordContact(domainRaw); // bump counters + lastContact
    // Point the next action at the following pending item, if any.
    const next = seq.items.find((i) => i.status === 'pending');
    if (next) await setNextAction(domainRaw, next.dueAt, `Follow-up #${next.n} due (approve to send)`);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/** Mark a due follow-up as skipped. */
export async function skipFollowup(domainRaw: string, n: number): Promise<{ ok: boolean }> {
  const seq = await load(domainRaw);
  if (!seq) return { ok: false };
  const item = seq.items.find((i) => i.n === n && i.status === 'pending');
  if (item) item.status = 'skipped';
  await save(seq);
  return { ok: true };
}

/* ------------------------- chat surface ------------------------- */

/** "follow up with [domain]" — draft the next due (or next pending) item as a card. */
export async function followupReport(domainRaw: string): Promise<Report> {
  const domain = safeDomainKey(domainRaw);
  let seq = await load(domain);
  if (!seq) {
    // No sequence yet — arm one starting today.
    seq = await scheduleSequence(domain);
  }
  const next = seq.items.find((i) => i.status === 'pending');
  if (!next) {
    return { tag: 'Follow-up', title: 'Sequence complete', blocks: [b.p(`No pending follow-ups for ${domain} — the sequence is finished or was cancelled by a reply.`)] };
  }
  const draft = next.draft || (await draftFollowup(domain, next.n));
  if (draft) { next.draft = draft; await save(seq); }

  const blocks = [
    b.p(`Follow-up #${next.n} for ${domain} (due ${new Date(next.dueAt).toLocaleDateString('en-US')}). Approve to send — NOVA never auto-sends.`),
  ];
  if (draft) { blocks.push(b.kv([{ k: 'Subject', v: draft.subject }])); blocks.push(b.note(draft.body)); }
  else blocks.push(b.note('Add an LLM key to draft the copy automatically.'));
  blocks.push(b.chips([`Approve follow-up #${next.n}`, `Skip follow-up #${next.n}`]));
  return { tag: 'Follow-up', title: `Follow-up — ${domain}`, blocks, data: { domain, n: next.n } };
}

/** "due follow-ups today" — the daily queue as approval cards. */
export async function dueReport(): Promise<Report> {
  const due = await getDueItems();
  if (!due.length) return { tag: 'Follow-up', title: 'Nothing due', blocks: [b.p('No follow-ups are due today. The queue is clear.')] };
  const blocks = [b.p(`${due.length} follow-up${due.length === 1 ? '' : 's'} due today. Approve each to send.`)];
  for (const d of due) {
    blocks.push(b.p(`${d.domain} — follow-up #${d.n}`));
    if (d.draft) { blocks.push(b.kv([{ k: 'Subject', v: d.draft.subject }])); blocks.push(b.note(d.draft.body)); }
    blocks.push(b.chips([`Approve follow-up #${d.n} for ${d.domain}`, `Skip follow-up #${d.n} for ${d.domain}`]));
  }
  return { tag: 'Follow-up', title: 'Follow-ups due today', blocks, data: { due } };
}

/* ------------------------- scheduler + status ------------------------- */

let task: any = null;
let started = false;

export async function initFollowupScheduler(): Promise<void> {
  if (started) return;
  started = true;
  if (!config.followup.enabled) return;
  try {
    const pkg = 'node-cron';
    const mod: any = await import(pkg).catch(() => { throw new Error('node-cron not installed'); });
    const cron = mod.default || mod;
    if (!cron.validate(config.followup.cron)) return;
    task = cron.schedule(config.followup.cron, () => { void getDueItems(); });
    console.log(`  ▸ Follow-up scheduler: ON (${config.followup.cron})`);
  } catch (e: any) {
    console.warn(`  ⚠ Follow-up scheduler could not start: ${e?.message || e}`);
  }
}

export async function followupStatus() {
  const domains = await listJsonKeys('sequences');
  let queueLength = 0;
  let nextDue: string | null = null;
  for (const domain of domains) {
    const seq = await load(domain);
    if (!seq) continue;
    for (const it of seq.items) {
      if (it.status !== 'pending') continue;
      queueLength++;
      if (!nextDue || new Date(it.dueAt) < new Date(nextDue)) nextDue = it.dueAt;
    }
  }
  return { enabled: config.followup.enabled, cron: config.followup.cron, queueLength, nextScheduledSend: nextDue };
}
