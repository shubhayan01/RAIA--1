import {
  listProspects, getProspect, getStale, getSummary, updateStage, addNote, setNextAction,
  STAGES, Stage, PipelineEntry,
} from '../lib/crm';
import { Report, b } from '../lib/report';

/**
 * Pipeline state manager (Feature 3). Thin service layer over lib/crm plus the
 * chat-facing report renderers. Routes power the live sidebar from the same data.
 */

export { updateStage, addNote, setNextAction, getStale, getSummary, listProspects, getProspect };

const STAGE_LABEL: Record<Stage, string> = {
  RESEARCHED: 'Researched', CONTACTED: 'Contacted', REPLIED: 'Replied',
  MEETING_BOOKED: 'Meeting booked', PROPOSAL_SENT: 'Proposal sent',
  CLOSED_WON: 'Closed won', CLOSED_LOST: 'Closed lost', DEAD: 'Dead',
};

/** "show pipeline" / "pipeline status" — summary as Report blocks. */
export async function pipelineReport(): Promise<Report> {
  const [summary, stale, all] = await Promise.all([getSummary(), getStale(7), listProspects()]);
  const blocks = [];

  const total = all.length;
  blocks.push(b.p(total
    ? `You have ${total} prospect${total === 1 ? '' : 's'} in the pipeline.`
    : 'Your pipeline is empty. Research a prospect to get started, e.g. "research acmedigital.com".'));

  // Stage counts (kv) — only non-zero, in stage order.
  const counts = STAGES.filter((s) => summary[s] > 0).map((s) => ({ k: STAGE_LABEL[s], v: String(summary[s]) }));
  if (counts.length) blocks.push(b.kv(counts));

  // Stale prospects going cold (list)
  if (stale.length) {
    blocks.push(b.p(`Going cold — no contact in 7+ days (${stale.length}):`));
    blocks.push(b.list(stale.slice(0, 10).map((e) =>
      `${e.companyName} (${e.domain}) — ${STAGE_LABEL[e.stage]}, ${e.daysSinceContact}d since contact`)));
  }

  // This week's next actions (list)
  const weekEnd = Date.now() + 7 * 86_400_000;
  const upcoming = all
    .filter((e) => e.nextActionAt && new Date(e.nextActionAt).getTime() <= weekEnd)
    .sort((a, c) => new Date(a.nextActionAt!).getTime() - new Date(c.nextActionAt!).getTime());
  if (upcoming.length) {
    blocks.push(b.p("This week's next actions:"));
    blocks.push(b.list(upcoming.slice(0, 10).map((e) =>
      `${new Date(e.nextActionAt!).toLocaleDateString('en-US')} — ${e.companyName}: ${e.nextActionNote || 'follow up'}`)));
  }

  return { tag: 'Pipeline', title: 'Pipeline status', blocks, data: { summary } };
}

/** A single prospect loaded as a summary card (clicked from the sidebar). */
export function prospectCardReport(e: PipelineEntry): Report {
  const blocks = [
    b.kv([
      { k: 'Company', v: e.companyName },
      { k: 'Domain', v: e.domain },
      { k: 'Stage', v: STAGE_LABEL[e.stage] },
      { k: 'Contact', v: [e.contactName, e.contactEmail].filter(Boolean).join(' · ') || '—' },
      { k: 'Emails sent', v: String(e.emailsSent) },
      { k: 'Last contact', v: e.lastContactAt ? new Date(e.lastContactAt).toLocaleDateString('en-US') : 'never' },
      { k: 'Days since contact', v: String(e.daysSinceContact ?? 0) },
      { k: 'Next action', v: e.nextActionAt ? `${new Date(e.nextActionAt).toLocaleDateString('en-US')} — ${e.nextActionNote}` : '—' },
    ]),
  ];
  if (e.notes.length) {
    blocks.push(b.p('Notes:'));
    blocks.push(b.list(e.notes.slice(-6)));
  }
  blocks.push(b.chips(['Generate Outreach Email', 'Full Prospect Report', 'Follow up']));
  return { tag: 'Prospect', title: e.companyName, blocks, data: { domain: e.domain } };
}
