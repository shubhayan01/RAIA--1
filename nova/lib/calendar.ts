import { config } from '../config';
import { dataPath, readJson, writeJson } from './jsonStore';
import { getJSON } from './http';
import { getCalendarAccessToken, calendarAuthConfigured } from './googleAuth';

/**
 * Slot management for the meeting scheduler (Feature 6).
 *
 * Availability comes from env config (days / hours / duration / buffer / tz).
 * Booked slots come from data/meetings/index.json. If GOOGLE_CALENDAR_TOKEN is
 * set we also exclude busy times from a Google Calendar freebusy query.
 *
 * Timezone math is done with Intl (no external date library) so a slot's wall
 * clock is correct in MEETING_TIMEZONE while the stored value stays ISO/UTC.
 */

export interface MeetingRecord {
  id: string;
  domain: string;
  companyName: string;
  prospectEmail: string;
  title: string;
  startIso: string;       // UTC ISO
  durationMins: number;
  status: 'booked' | 'cancelled';
  createdAt: string;
  gmeetLink?: string;
  cancelledReason?: string;
}

export interface MeetingsDoc { meetings: MeetingRecord[]; }

const FILE = dataPath('meetings', 'index.json');

export async function loadMeetings(): Promise<MeetingsDoc> {
  return readJson<MeetingsDoc>(FILE, { meetings: [] });
}
export async function saveMeetings(doc: MeetingsDoc): Promise<void> {
  await writeJson(FILE, doc);
}

export interface Slot {
  iso: string;            // UTC ISO start time
  display: string;        // human string in MEETING_TIMEZONE
}

/* ---------------- timezone helpers (Intl-based) ---------------- */

function tzOffsetMs(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) map[p.type] = p.value;
  const asUTC = Date.UTC(+map.year, +map.month - 1, +map.day, +map.hour, +map.minute, +map.second);
  return asUTC - date.getTime();
}

/** Build a UTC Date for a wall-clock time in the given timezone. */
function zonedToUtc(y: number, m: number, d: number, hh: number, mm: number, timeZone: string): Date {
  const naive = Date.UTC(y, m, d, hh, mm);
  const offset = tzOffsetMs(new Date(naive), timeZone);
  return new Date(naive - offset);
}

/** Parts (y/m/d/weekday) of `date` as seen in the given timezone. */
function zonedParts(date: Date, timeZone: string) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) map[p.type] = p.value;
  return { year: +map.year, month: +map.month, day: +map.day, weekday: map.weekday };
}

function displayInTz(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short',
  }).format(date);
}

/* ---------------- Google Calendar freebusy (optional) ---------------- */

async function googleBusy(fromIso: string, toIso: string): Promise<{ start: string; end: string }[]> {
  if (!calendarAuthConfigured()) return [];
  const token = await getCalendarAccessToken().catch(() => '');
  if (!token) return [];
  try {
    const res = await getJSON<any>('https://www.googleapis.com/calendar/v3/freeBusy', {
      method: 'POST' as any,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ timeMin: fromIso, timeMax: toIso, items: [{ id: 'primary' }] }),
    } as any, 20000);
    const busy = res?.calendars?.primary?.busy || [];
    return busy.map((b: any) => ({ start: b.start, end: b.end }));
  } catch {
    return []; // freebusy failed — fall back to local booked slots only
  }
}

/* ---------------- slot generation ---------------- */

/**
 * Generate up to `count` available slots across the next `daysAhead` days,
 * excluding already-booked slots (and Google busy times, if configured).
 */
export async function availableSlots(count = 6, daysAhead = 7): Promise<Slot[]> {
  const { availableDays, startHour, endHour, durationMins, timezone, bufferMins } = config.meeting;
  const step = durationMins + bufferMins;
  const now = new Date();

  const doc = await loadMeetings();
  const booked = new Set(
    doc.meetings.filter((m) => m.status === 'booked').map((m) => m.startIso),
  );

  const horizonEnd = new Date(now.getTime() + daysAhead * 86_400_000);
  const busy = await googleBusy(now.toISOString(), horizonEnd.toISOString());
  const overlapsBusy = (start: Date) => {
    const end = new Date(start.getTime() + durationMins * 60_000);
    return busy.some((b) => start < new Date(b.end) && end > new Date(b.start));
  };

  const slots: Slot[] = [];
  for (let dayOffset = 0; dayOffset < daysAhead && slots.length < count; dayOffset++) {
    const probe = new Date(now.getTime() + dayOffset * 86_400_000);
    const parts = zonedParts(probe, timezone);
    if (!availableDays.includes(parts.weekday)) continue;

    for (let hh = startHour; hh + durationMins / 60 <= endHour && slots.length < count; hh += step / 60) {
      const wholeHour = Math.floor(hh);
      const minute = Math.round((hh - wholeHour) * 60);
      const start = zonedToUtc(parts.year, parts.month - 1, parts.day, wholeHour, minute, timezone);
      if (start.getTime() <= now.getTime() + 3_600_000) continue; // at least 1h out
      if (booked.has(start.toISOString())) continue;
      if (overlapsBusy(start)) continue;
      slots.push({ iso: start.toISOString(), display: displayInTz(start, timezone) });
    }
  }
  return slots;
}

/** Human display for a stored ISO slot (used in confirmations / lists). */
export function formatSlot(iso: string): string {
  return displayInTz(new Date(iso), config.meeting.timezone);
}

export function calendarConfigured(): boolean {
  return calendarAuthConfigured();
}
