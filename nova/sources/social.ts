import { requestOnce } from '../lib/http';
import * as cheerio from 'cheerio';

/**
 * Social signals (Feature 1, Step 3).
 *
 * LinkedIn and Instagram both aggressively gate public pages behind login walls
 * and bot detection. NOVA attempts a plain public fetch and parses what is
 * actually returned (og tags / visible follower counts). When the platform
 * blocks the fetch, NOVA returns an HONEST "could not retrieve — blocked"
 * status. It NEVER invents follower counts or post dates.
 */

export interface SocialSignal {
  platform: 'linkedin' | 'instagram';
  url: string;
  retrieved: boolean;
  followers: number | null;
  lastPostDate: string | null;
  frequency: 'active' | 'inactive' | 'dead' | 'unknown';
  status: string; // human summary, incl. "could not retrieve — blocked"
}

export async function socialSignals(input: { linkedin?: string | null; instagram?: string | null }): Promise<SocialSignal[]> {
  const out: SocialSignal[] = [];
  if (input.linkedin) out.push(await probe('linkedin', input.linkedin));
  if (input.instagram) out.push(await probe('instagram', input.instagram));
  return out;
}

async function probe(platform: 'linkedin' | 'instagram', url: string): Promise<SocialSignal> {
  const base: SocialSignal = {
    platform, url, retrieved: false, followers: null, lastPostDate: null,
    frequency: 'unknown', status: '',
  };
  let res;
  try {
    res = await requestOnce(url);
  } catch (e: any) {
    return { ...base, status: `could not retrieve — ${String(e?.message || 'error')}` };
  }

  // Login walls / bot blocks typically 999 (LinkedIn), 403, 429, or a redirect to /login.
  if (!res.ok || !res.body || /\/(login|authwall|accounts\/login)/i.test(res.finalUrl || '')) {
    return { ...base, status: `could not retrieve — blocked (${res.status || 'no body'})` };
  }

  const $ = cheerio.load(res.body);
  const meta = ($('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || '').trim();

  // Try to read a follower count from the meta text (e.g. "1,234 followers").
  const fm = meta.match(/([\d,.]+)\s*followers/i);
  if (fm) {
    const n = Number(fm[1].replace(/[,.]/g, ''));
    if (Number.isFinite(n)) base.followers = n;
  }

  if (base.followers != null) {
    base.retrieved = true;
    base.status = `retrieved · ${base.followers.toLocaleString('en-US')} followers`;
    // We cannot reliably read last-post date from the public shell without login,
    // so we are honest about frequency being unknown from a public fetch.
    base.frequency = 'unknown';
    base.status += ' · post frequency not readable from public page';
  } else {
    base.status = 'could not retrieve — blocked (login wall / no public follower data)';
  }
  return base;
}
