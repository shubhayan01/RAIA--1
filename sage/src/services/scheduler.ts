import { config } from '../config';
import { runIntelligence } from './intelligence';
import { reportToEmailHtml } from '../lib/emailReport';
import { sendMail, mailerConfigured } from '../lib/mailer';

/**
 * Scheduled Intelligence Reports (Feature 2).
 *
 * On a cron schedule (default: 9am on the 1st of each month) SAGE runs the full
 * GSC + GA4 intelligence pipeline, renders it as an email-safe HTML report, and
 * emails it to the configured client addresses — no human trigger required.
 *
 * node-cron is imported LAZILY so the server boots even before `npm install`.
 */

interface SchedulerState {
  lastRun: string | null;
  lastStatus: 'success' | 'error' | null;
  lastError: string | null;
  lastRecipients: string[];
  lastPeriod: { startDate: string; endDate: string } | null;
  runs: number;
}

const state: SchedulerState = {
  lastRun: null,
  lastStatus: null,
  lastError: null,
  lastRecipients: [],
  lastPeriod: null,
  runs: 0,
};

let task: any = null;
let started = false;

/** Called once at server startup. No-op unless SCHEDULER_ENABLED=true. */
export async function initScheduler(): Promise<void> {
  if (started) return;
  started = true;
  if (!config.scheduler.enabled) return;
  if (!config.scheduler.cron) return;
  try {
    const pkg = 'node-cron';
    const mod: any = await import(pkg).catch(() => {
      throw new Error('node-cron is not installed — run `npm install`.');
    });
    const cron = mod.default || mod;
    if (!cron.validate(config.scheduler.cron)) {
      console.warn(`  ⚠ Scheduler: invalid SCHEDULER_CRON "${config.scheduler.cron}" — not scheduled.`);
      return;
    }
    task = cron.schedule(config.scheduler.cron, () => { void runScheduledReport(); });
    console.log(`  ▸ Scheduler: ON (${config.scheduler.cron}) → ${config.scheduler.emailTo.join(', ') || 'no recipients set'}`);
  } catch (e: any) {
    console.warn(`  ⚠ Scheduler could not start: ${e?.message || e}`);
  }
}

/** Run the intelligence pipeline and email it. Shared by cron + manual trigger. */
export async function runScheduledReport(): Promise<{ ok: boolean; recipients: string[]; period: any; error?: string }> {
  state.lastRun = new Date().toISOString();
  state.runs++;
  const recipients = config.scheduler.emailTo;

  try {
    if (!mailerConfigured()) throw new Error('SMTP not configured — set SMTP_HOST, SMTP_USER, SMTP_PASS.');
    if (!recipients.length) throw new Error('No recipients — set SCHEDULER_EMAIL_TO (comma-separated).');

    const report = await runIntelligence({});
    const period = (report.data as any)?.window?.current || null;
    const html = reportToEmailHtml(report, {
      brand: config.report.brand,
      footer: `${config.report.brand} — automated monthly report`,
    });

    await sendMail({
      to: recipients,
      from: config.scheduler.emailFrom,
      subject: `${report.title || 'SEO Intelligence Report'} — ${config.report.brand}`,
      html,
    });

    state.lastStatus = 'success';
    state.lastError = null;
    state.lastRecipients = recipients;
    state.lastPeriod = period;
    console.log(`  ▸ Scheduler: report sent to ${recipients.join(', ')} (${period ? `${period.startDate}→${period.endDate}` : 'n/a'})`);
    return { ok: true, recipients, period };
  } catch (e: any) {
    state.lastStatus = 'error';
    state.lastError = String(e?.message || e);
    console.warn(`  ⚠ Scheduler run failed: ${state.lastError}`);
    return { ok: false, recipients, period: null, error: state.lastError };
  }
}

export function schedulerStatus() {
  return {
    enabled: config.scheduler.enabled,
    cron: config.scheduler.cron,
    nextRun: config.scheduler.enabled ? nextCronRun(config.scheduler.cron) : null,
    lastRun: state.lastRun,
    lastStatus: state.lastStatus,
    lastError: state.lastError,
    recipients: config.scheduler.emailTo,
    smtpConfigured: mailerConfigured(),
    runs: state.runs,
  };
}

/* ---------------------- minimal cron "next run" ------------------------- */
/**
 * Best-effort next-run for a standard 5-field cron expression
 * (minute hour day-of-month month day-of-week). Supports *, lists, ranges and
 * steps. Brute-forces minute-by-minute up to ~400 days, then gives up (null).
 * Used only for display in the status endpoint.
 */
export function nextCronRun(expr: string, from: Date = new Date()): string | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hr, dom, mon, dow] = parts;

  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);

  const limit = 400 * 24 * 60; // minutes in ~400 days
  for (let i = 0; i < limit; i++) {
    if (
      match(min, d.getMinutes(), 0, 59) &&
      match(hr, d.getHours(), 0, 23) &&
      match(dom, d.getDate(), 1, 31) &&
      match(mon, d.getMonth() + 1, 1, 12) &&
      match(dow, d.getDay(), 0, 6)
    ) {
      return d.toISOString();
    }
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

function match(field: string, value: number, lo: number, hi: number): boolean {
  if (field === '*') return true;
  for (const part of field.split(',')) {
    let step = 1;
    let range = part;
    const slash = part.split('/');
    if (slash.length === 2) { range = slash[0]; step = parseInt(slash[1], 10) || 1; }
    let start = lo, end = hi;
    if (range !== '*') {
      const dash = range.split('-');
      if (dash.length === 2) { start = parseInt(dash[0], 10); end = parseInt(dash[1], 10); }
      else { start = end = parseInt(range, 10); }
    }
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    if (value < start || value > end) continue;
    if ((value - start) % step === 0) return true;
  }
  return false;
}
