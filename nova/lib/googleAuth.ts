import { config } from '../config';
import { timedFetch } from './http';

/**
 * Google Calendar OAuth — access-token provider.
 *
 * Preferred path: the offline OAuth refresh-token flow. Given GOOGLE_CLIENT_ID +
 * GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN, NOVA mints a fresh access token
 * from Google's token endpoint on demand and caches it in-memory until just
 * before it expires — so every Calendar API call gets a valid token without a
 * manual refresh.
 *
 * Legacy fallback: a single static GOOGLE_CALENDAR_TOKEN (expires in ~1h).
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const EXPIRY_SKEW_MS = 60_000; // refresh a minute early to avoid edge expiry

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}
let cache: CachedToken | null = null;
let inFlight: Promise<string> | null = null;

/** True when NOVA can obtain a Calendar access token by either method. */
export function calendarAuthConfigured(): boolean {
  const m = config.meeting;
  const hasRefresh = !!(m.googleClientId && m.googleClientSecret && m.googleRefreshToken);
  return hasRefresh || !!m.googleCalendarToken;
}

/** True when the preferred refresh-token flow is fully configured. */
export function refreshFlowConfigured(): boolean {
  const m = config.meeting;
  return !!(m.googleClientId && m.googleClientSecret && m.googleRefreshToken);
}

/**
 * Return a valid access token, minting one via the refresh flow if needed.
 * Returns '' when no calendar auth is configured (callers treat that as "off").
 */
export async function getCalendarAccessToken(): Promise<string> {
  if (refreshFlowConfigured()) {
    // Serve the cached token while it's still fresh.
    if (cache && Date.now() < cache.expiresAt - EXPIRY_SKEW_MS) return cache.accessToken;
    // Coalesce concurrent refreshes into a single request.
    if (inFlight) return inFlight;
    inFlight = mintAccessToken().finally(() => { inFlight = null; });
    return inFlight;
  }
  // Legacy static token (may already be expired — that's on the operator).
  return config.meeting.googleCalendarToken || '';
}

async function mintAccessToken(): Promise<string> {
  const m = config.meeting;
  const body = new URLSearchParams({
    client_id: m.googleClientId,
    client_secret: m.googleClientSecret,
    refresh_token: m.googleRefreshToken,
    grant_type: 'refresh_token',
  });

  const res = await timedFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  }, 20000);

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    // Fall back to a static token if one was also provided.
    if (m.googleCalendarToken) return m.googleCalendarToken;
    throw new Error(`Google token refresh failed (${res.status}): ${detail.slice(0, 200)}`);
  }

  const json: any = await res.json();
  const accessToken = json?.access_token;
  if (typeof accessToken !== 'string' || !accessToken) {
    if (m.googleCalendarToken) return m.googleCalendarToken;
    throw new Error('Google token refresh returned no access_token');
  }
  const expiresInSec = Number(json?.expires_in) || 3600;
  cache = { accessToken, expiresAt: Date.now() + expiresInSec * 1000 };
  return accessToken;
}

/** Drop the cached token (used by diagnostics / after an auth error). */
export function clearCalendarTokenCache(): void {
  cache = null;
}
