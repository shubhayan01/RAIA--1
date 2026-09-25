import { config } from '../config';
import { availableSlots, loadMeetings, saveMeetings, formatSlot, MeetingRecord, calendarConfigured } from '../lib/calendar';
import { getCalendarAccessToken } from '../lib/googleAuth';
import { getJSON } from '../lib/http';
import { sendMail, emailConfigured, buildIcs } from '../lib/email';
import { getProspect, updateStage } from '../lib/crm';
import { safeDomainKey } from '../lib/jsonStore';
import { Report, b } from '../lib/report';
import crypto from 'node:crypto';

/**
 * Meeting scheduler (Feature 6). Generates slots (lib/calendar), books them,
 * optionally creates a Google Calendar event, emails a confirmation + ICS to the
 * prospect, notifies the team, and moves the pipeline to MEETING_BOOKED.
 */

export async function bookMeeting(input: { domain: string; slotIso: string; prospectEmail: string; title?: string }): Promise<{ ok: boolean; error?: string; meeting?: MeetingRecord }> {
  const domain = safeDomainKey(input.domain);
  const entry = await getProspect(domain);
  const companyName = entry?.companyName || domain;
  const title = input.title || `${config.agency.name} × ${companyName} — Discovery Call`;

  const doc = await loadMeetings();
  if (doc.meetings.some((m) => m.status === 'booked' && m.startIso === input.slotIso)) {
    return { ok: false, error: 'That slot was just taken — pick another.' };
  }

  const meeting: MeetingRecord = {
    id: crypto.randomBytes(6).toString('hex'),
    domain,
    companyName,
    prospectEmail: input.prospectEmail,
    title,
    startIso: input.slotIso,
    durationMins: config.meeting.durationMins,
    status: 'booked',
    createdAt: new Date().toISOString(),
    gmeetLink: config.meeting.gmeetLink || undefined,
  };
  doc.meetings.push(meeting);
  await saveMeetings(doc);

  // Optional: create a real Google Calendar event (best-effort).
  if (calendarConfigured()) await createGoogleEvent(meeting).catch(() => { /* non-fatal */ });

  // Confirmation email to the prospect (with ICS invite).
  if (emailConfigured() && input.prospectEmail) {
    const when = formatSlot(meeting.startIso);
    const meetLine = meeting.gmeetLink ? `\nJoin: ${meeting.gmeetLink}` : '';
    const ics = buildIcs({
      uid: `${meeting.id}@nova`, start: new Date(meeting.startIso), durationMins: meeting.durationMins,
      title, description: `Discovery call with ${config.agency.name}.${meetLine}`,
      location: meeting.gmeetLink || 'Online', organizerEmail: config.smtp.fromEmail, attendeeEmail: input.prospectEmail,
    });
    await sendMail({
      to: input.prospectEmail,
      subject: `Confirmed: ${title} — ${when}`,
      text: `You're confirmed for ${when} (${config.meeting.timezone}).${meetLine}\n\nLooking forward to it,\n${config.agency.senderName}`,
      icsAttachment: { filename: 'invite.ics', content: ics },
    }).catch(() => { /* confirmation is best-effort */ });
  }

  // Team notification.
  if (emailConfigured() && config.agency.notifyEmail) {
    await sendMail({
      to: config.agency.notifyEmail,
      subject: `Meeting booked: ${companyName} — ${formatSlot(meeting.startIso)}`,
      text: `${companyName} (${domain}) booked a call for ${formatSlot(meeting.startIso)}.\nProspect: ${input.prospectEmail}`,
    }).catch(() => {});
  }

  await updateStage(domain, 'MEETING_BOOKED', `Meeting booked for ${formatSlot(meeting.startIso)}`);
  return { ok: true, meeting };
}

export async function cancelMeeting(meetingId: string, reason?: string): Promise<{ ok: boolean; error?: string }> {
  const doc = await loadMeetings();
  const m = doc.meetings.find((x) => x.id === meetingId && x.status === 'booked');
  if (!m) return { ok: false, error: 'Meeting not found.' };
  m.status = 'cancelled';
  m.cancelledReason = reason;
  await saveMeetings(doc);

  if (emailConfigured() && m.prospectEmail) {
    await sendMail({
      to: m.prospectEmail,
      subject: `Cancelled: ${m.title}`,
      text: `Apologies — we've had to cancel the call scheduled for ${formatSlot(m.startIso)}.${reason ? `\nReason: ${reason}` : ''}\nHappy to find a new time whenever suits.`,
    }).catch(() => {});
  }
  await updateStage(m.domain, 'REPLIED', 'Meeting cancelled');
  return { ok: true };
}

export async function getMeetings(upcoming: boolean): Promise<MeetingRecord[]> {
  const doc = await loadMeetings();
  const now = Date.now();
  return doc.meetings
    .filter((m) => m.status === 'booked')
    .filter((m) => (upcoming ? new Date(m.startIso).getTime() >= now : true))
    .sort((a, b2) => new Date(a.startIso).getTime() - new Date(b2.startIso).getTime());
}

async function createGoogleEvent(m: MeetingRecord): Promise<void> {
  const token = await getCalendarAccessToken().catch(() => '');
  if (!token) return;
  const end = new Date(new Date(m.startIso).getTime() + m.durationMins * 60_000).toISOString();
  await getJSON('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST' as any,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      summary: m.title,
      description: `Discovery call booked via NOVA.${m.gmeetLink ? ` Join: ${m.gmeetLink}` : ''}`,
      start: { dateTime: m.startIso, timeZone: config.meeting.timezone },
      end: { dateTime: end, timeZone: config.meeting.timezone },
      attendees: m.prospectEmail ? [{ email: m.prospectEmail }] : [],
    }),
  } as any, 20000);
}

/* ------------------------- chat surfaces ------------------------- */

export async function meetingsReport(): Promise<Report> {
  const meetings = await getMeetings(true);
  if (!meetings.length) return { tag: 'Meetings', title: 'No upcoming meetings', blocks: [b.p('Nothing on the calendar yet. Say "book meeting with <domain>" to offer a prospect some slots.')] };
  const blocks = [b.p(`${meetings.length} upcoming meeting${meetings.length === 1 ? '' : 's'}:`)];
  for (const m of meetings) {
    blocks.push(b.kv([
      { k: 'Company', v: m.companyName },
      { k: 'When', v: formatSlot(m.startIso) },
      { k: 'Duration', v: `${m.durationMins} min` },
      { k: 'Prospect', v: m.prospectEmail || '—' },
      { k: 'Link', v: m.gmeetLink || '—' },
    ]));
  }
  return { tag: 'Meetings', title: 'Upcoming meetings', blocks, data: { meetings } };
}

/** "book meeting with [domain]" — show available slots as selectable chips. */
export async function bookSlotsReport(domainRaw: string): Promise<Report> {
  const domain = safeDomainKey(domainRaw);
  const entry = await getProspect(domain);
  const slots = await availableSlots(6, 7);
  if (!slots.length) {
    return { tag: 'Meetings', title: 'No slots available', blocks: [b.note('No open slots in the next 7 days with the current availability config (MEETING_* env vars).')] };
  }
  const blocks = [
    b.p(`Available slots for ${entry?.companyName || domain} (${config.meeting.timezone}). Pick one — NOVA sends the confirmation and adds it to the pipeline.`),
    b.chips(slots.map((s) => s.display)),
  ];
  return { tag: 'Meetings', title: `Book a meeting — ${entry?.companyName || domain}`, blocks, data: { domain, slots, prospectEmail: entry?.contactEmail || '' } };
}

export async function meetingsStatus() {
  const upcoming = await getMeetings(true);
  return { upcoming: upcoming.length, googleCalendar: calendarConfigured() };
}
