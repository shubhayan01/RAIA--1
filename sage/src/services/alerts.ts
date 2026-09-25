import { config } from '../config';
import { runRanks } from './ranks';
import { completeJSON, complete, llmConfigured } from '../llm';
import { sendMail, mailerConfigured } from '../lib/mailer';
import { dataPath, safeDomainKey, readJson, writeJson, listJsonKeys } from '../lib/jsonStore';

/**
 * Ranking Drop Alert System (Feature 4).
 *
 * Tracks keyword positions in a per-domain JSON snapshot, re-checks every 24h via
 * node-cron, and emails the account manager the moment a tracked keyword moves 5+
 * positions — a written diagnosis for drops, a short note for wins.
 */

const DROP_THRESHOLD = 5;
const HISTORY_LEN = 10;
const DAILY_CRON = '0 9 * * *'; // once a day (approx. every 24h)

interface KeywordSnap {
  position: number;
  checkedAt: string;
  history: { position: number; checkedAt: string }[];
}
interface DomainSnapshot {
  domain: string;
  email: string;
  lastChecked: string;
  keywords: Record<string, KeywordSnap>;
}

const tasks = new Map<string, any>(); // domain -> node-cron task

function snapPath(domain: string): string {
  return dataPath('rankings', `${safeDomainKey(domain)}.json`);
}

async function loadSnapshot(domain: string): Promise<DomainSnapshot | null> {
  const s = await readJson<DomainSnapshot | null>(snapPath(domain), null);
  return s && s.keywords ? s : null;
}

/* ------------------------------- Tracking ------------------------------- */

export async function trackAlerts(input: { domain: string; keywords: string[]; email: string }): Promise<{
  ok: boolean;
  domain: string;
  tracked: number;
  positions: { keyword: string; position: number | null }[];
  error?: string;
}> {
  const domain = safeDomainKey(input.domain);
  const keywords = (input.keywords || []).map((k) => k.trim()).filter(Boolean);
  const email = (input.email || '').trim();
  if (!domain) return { ok: false, domain, tracked: 0, positions: [], error: 'A domain is required.' };
  if (!keywords.length) return { ok: false, domain, tracked: 0, positions: [], error: 'At least one keyword is required.' };

  // Immediate rank check via the existing ranks service.
  const rows = await rankCheck(domain, keywords);

  // Build/seed the snapshot.
  const now = new Date().toISOString();
  const existing = await loadSnapshot(domain);
  const snap: DomainSnapshot = existing || { domain, email, lastChecked: now, keywords: {} };
  snap.email = email || snap.email;
  snap.lastChecked = now;
  for (const r of rows) {
    if (r.position == null) continue;
    const prev = snap.keywords[r.keyword];
    const history = prev ? [...prev.history] : [];
    history.push({ position: r.position, checkedAt: now });
    snap.keywords[r.keyword] = { position: r.position, checkedAt: now, history: history.slice(-HISTORY_LEN) };
  }
  await writeJson(snapPath(domain), snap);

  // Schedule recurring 24h checks (replace any existing task for this domain).
  await scheduleDomain(domain);

  return {
    ok: true,
    domain,
    tracked: Object.keys(snap.keywords).length,
    positions: rows.map((r) => ({ keyword: r.keyword, position: r.position })),
  };
}

/** Re-arm cron jobs for every already-tracked domain (called at startup). */
export async function initAlerts(): Promise<void> {
  if (!config.alerts.enabled) return;
  const domains = await listJsonKeys('rankings');
  for (const d of domains) await scheduleDomain(d);
  if (domains.length) console.log(`  ▸ Alerts: ON — monitoring ${domains.length} domain(s)`);
}

async function scheduleDomain(domain: string): Promise<void> {
  if (!config.alerts.enabled) return;
  try {
    const pkg = 'node-cron';
    const mod: any = await import(pkg).catch(() => { throw new Error('node-cron not installed'); });
    const cron = mod.default || mod;
    const prev = tasks.get(domain);
    if (prev && prev.stop) prev.stop();
    const task = cron.schedule(DAILY_CRON, () => { void runCheck(domain); });
    tasks.set(domain, task);
  } catch (e: any) {
    console.warn(`  ⚠ Alerts: could not schedule ${domain}: ${e?.message || e}`);
  }
}

/* ------------------------------- The check ------------------------------ */

export async function runCheck(domain: string): Promise<{ ok: boolean; drops: number; gains: number; error?: string }> {
  const snap = await loadSnapshot(domain);
  if (!snap) return { ok: false, drops: 0, gains: 0, error: 'No snapshot for this domain — track it first.' };

  const keywords = Object.keys(snap.keywords);
  if (!keywords.length) return { ok: true, drops: 0, gains: 0 };

  const rows = await rankCheck(domain, keywords);
  const now = new Date().toISOString();
  let drops = 0, gains = 0;

  for (const r of rows) {
    if (r.position == null) continue;
    const prev = snap.keywords[r.keyword];
    const oldPos = prev?.position;

    if (typeof oldPos === 'number') {
      const move = r.position - oldPos; // + = dropped (worse), - = gained (better)
      if (move >= DROP_THRESHOLD) { drops++; await notifyDrop(snap, r.keyword, oldPos, r.position); }
      else if (move <= -DROP_THRESHOLD) { gains++; await notifyGain(snap, r.keyword, oldPos, r.position); }
    }

    const history = prev ? [...prev.history] : [];
    history.push({ position: r.position, checkedAt: now });
    snap.keywords[r.keyword] = { position: r.position, checkedAt: now, history: history.slice(-HISTORY_LEN) };
  }

  snap.lastChecked = now;
  await writeJson(snapPath(domain), snap);
  return { ok: true, drops, gains };
}

/* ------------------------------ Notifications --------------------------- */

async function notifyDrop(snap: DomainSnapshot, keyword: string, oldPos: number, newPos: number): Promise<void> {
  const diagnosis = await dropDiagnosis(snap.domain, keyword, oldPos, newPos);
  const auditLink = `/api/report?url=${encodeURIComponent(snap.domain)}`;
  const html = wrapEmail(
    `${keyword} dropped from #${oldPos} to #${newPos}`,
    `<p style="white-space:pre-line">${escapeHtml(diagnosis)}</p>` +
    `<p><a href="${escapeHtml(auditLink)}">Run a fresh audit in SAGE →</a></p>`,
  );
  await safeSend(snap.email, `SAGE Alert: ${keyword} dropped from #${oldPos} to #${newPos} — ${snap.domain}`, html);
}

async function notifyGain(snap: DomainSnapshot, keyword: string, oldPos: number, newPos: number): Promise<void> {
  const note = await winNote(snap.domain, keyword, oldPos, newPos);
  const html = wrapEmail(`${keyword} moved from #${oldPos} to #${newPos}`, `<p>${escapeHtml(note)}</p>`);
  await safeSend(snap.email, `SAGE Win: ${keyword} moved from #${oldPos} to #${newPos} — ${snap.domain}`, html);
}

async function safeSend(to: string, subject: string, html: string): Promise<void> {
  if (!to || !mailerConfigured()) return; // no recipient / SMTP → silently skip (status still records the move)
  try { await sendMail({ to, from: config.alerts.emailFrom, subject, html }); }
  catch (e: any) { console.warn(`  ⚠ Alert email failed: ${e?.message || e}`); }
}

const DROP_SYSTEM = `You are an SEO account manager. A tracked keyword has dropped significantly. Write a 3-paragraph alert for the account manager: what dropped and by how much, the 3 most likely causes based on the domain and keyword context, and the immediate action to investigate. Be specific and direct. No hedging. Under 200 words total.`;

async function dropDiagnosis(domain: string, keyword: string, oldPos: number, newPos: number): Promise<string> {
  if (!llmConfigured()) {
    return `"${keyword}" dropped from position ${oldPos} to ${newPos} on ${domain}. Investigate: recent on-page changes to the ranking page, lost or broken backlinks, and new/strengthened competitors for this query. Start by re-auditing the page and checking Search Console for impression/CTR changes on this keyword.`;
  }
  try {
    const r = await completeJSON<{ alert?: string }>(
      DROP_SYSTEM + ' Return JSON: {"alert": string}',
      JSON.stringify({ domain, keyword, oldPosition: oldPos, newPosition: newPos, drop: newPos - oldPos }),
      { temperature: 0.4, maxTokens: 500 },
    );
    return String(r.alert || '').trim() || `"${keyword}" dropped from #${oldPos} to #${newPos} on ${domain}. Re-audit the ranking page and check for lost backlinks and new competitors.`;
  } catch {
    return `"${keyword}" dropped from #${oldPos} to #${newPos} on ${domain}. Re-audit the ranking page and check for lost backlinks and new competitors.`;
  }
}

async function winNote(domain: string, keyword: string, oldPos: number, newPos: number): Promise<string> {
  const fallback = `"${keyword}" climbed from #${oldPos} to #${newPos} on ${domain}. This likely reflects recent content or link improvements taking effect — keep the momentum on this page.`;
  if (!llmConfigured()) return fallback;
  try {
    const reply = await complete(
      'You are an SEO account manager. In exactly 2 sentences, say what moved and what most likely drove it. No hedging.',
      `Keyword "${keyword}" on ${domain} moved from position ${oldPos} to ${newPos}.`,
      { temperature: 0.5, maxTokens: 160 },
    );
    return reply.trim() || fallback;
  } catch {
    return fallback;
  }
}

/* --------------------------------- Status ------------------------------- */

export async function alertsStatus(domain: string): Promise<any> {
  const snap = await loadSnapshot(domain);
  if (!snap) return { ok: false, domain: safeDomainKey(domain), error: 'Domain not tracked.' };
  const keywords = Object.entries(snap.keywords).map(([keyword, k]) => {
    const prev = k.history.length >= 2 ? k.history[k.history.length - 2].position : null;
    return {
      keyword,
      position: k.position,
      checkedAt: k.checkedAt,
      movement: prev != null ? prev - k.position : null, // + = improved since previous check
    };
  });
  return { ok: true, domain: snap.domain, lastChecked: snap.lastChecked, enabled: config.alerts.enabled, keywords };
}

export async function alertsHistory(domain: string, keyword: string): Promise<any> {
  const snap = await loadSnapshot(domain);
  if (!snap) return { ok: false, domain: safeDomainKey(domain), error: 'Domain not tracked.' };
  const k = snap.keywords[keyword];
  if (!k) return { ok: false, domain: snap.domain, keyword, error: 'Keyword not tracked.' };
  return { ok: true, domain: snap.domain, keyword, current: k.position, history: k.history };
}

/* -------------------------------- Helpers ------------------------------- */

/** Run a rank check through the existing ranks service; return [{keyword, position}]. */
async function rankCheck(domain: string, keywords: string[]): Promise<{ keyword: string; position: number | null }[]> {
  const report = await runRanks({ text: `${domain}: ${keywords.join(', ')}`, domain, keywords });
  const rows = ((report.data as any)?.rows || []) as { keyword: string; position: number | null; error?: boolean }[];
  // Map back onto the requested keywords so ordering/coverage is stable.
  const byKw = new Map(rows.map((r) => [r.keyword.trim().toLowerCase(), r]));
  return keywords.map((kw) => {
    const r = byKw.get(kw.trim().toLowerCase());
    return { keyword: kw, position: r && !r.error ? r.position : null };
  });
}

function wrapEmail(heading: string, bodyHtml: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f9fafb;font-family:system-ui,Segoe UI,Arial,sans-serif">` +
    `<div style="max-width:600px;margin:0 auto;padding:24px 16px">` +
    `<div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:24px">` +
    `<h2 style="margin:0 0 14px;color:#111827;font-size:18px">${escapeHtml(heading)}</h2>` +
    `<div style="color:#374151;font-size:14px;line-height:1.6">${bodyHtml}</div>` +
    `</div><div style="text-align:center;color:#6b7280;font-size:12px;padding:12px">${escapeHtml(config.report.brand)} — ranking alerts</div>` +
    `</div></body></html>`;
}

function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
