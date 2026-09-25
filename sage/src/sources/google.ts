import { config } from '../config';
import { timedFetch } from '../lib/http';

/**
 * Search Console + GA4 access. Both are FREE Google APIs.
 * Auth: a short-lived OAuth access token (GOOGLE_ACCESS_TOKEN), or we mint one
 * from a refresh token (GOOGLE_REFRESH_TOKEN + client id/secret).
 */

let cachedToken: { value: string; exp: number } | null = null;

export async function googleAccessToken(): Promise<string | null> {
  const { accessToken, refreshToken, clientId, clientSecret } = config.google;
  if (accessToken) return accessToken;
  if (!refreshToken || !clientId || !clientSecret) return null;

  if (cachedToken && cachedToken.exp > Date.now() + 30000) return cachedToken.value;

  const res = await timedFetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  }, 15000);
  if (!res.ok) return null;
  const j: any = await res.json();
  if (!j.access_token) return null;
  cachedToken = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return cachedToken.value;
}

export function gscConfigured(): boolean {
  return !!config.google.gscSiteUrl && (!!config.google.accessToken || !!config.google.refreshToken);
}
export function ga4Configured(): boolean {
  return !!config.google.ga4PropertyId && (!!config.google.accessToken || !!config.google.refreshToken);
}

export interface GscRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/** Query GSC Search Analytics. dimensions e.g. ['query'] or ['page']. */
export async function gscQuery(opts: {
  startDate: string;
  endDate: string;
  dimensions: string[];
  rowLimit?: number;
}): Promise<GscRow[]> {
  const token = await googleAccessToken();
  const site = config.google.gscSiteUrl;
  if (!token || !site) throw new Error('GSC not configured');

  const endpoint = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`;
  const res = await timedFetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      startDate: opts.startDate,
      endDate: opts.endDate,
      dimensions: opts.dimensions,
      rowLimit: opts.rowLimit ?? 1000,
    }),
  }, 30000);
  if (!res.ok) throw new Error(`GSC ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j: any = await res.json();
  return (j.rows || []).map((r: any) => ({
    keys: r.keys || [],
    clicks: r.clicks || 0,
    impressions: r.impressions || 0,
    ctr: r.ctr || 0,
    position: r.position || 0,
  }));
}

export interface Ga4Metric {
  dimension: string;
  sessions: number;
  conversions: number;
  totalRevenue: number;
}

/** GA4 organic-search sessions/conversions/revenue by landing page. */
export async function ga4Report(opts: { startDate: string; endDate: string }): Promise<Ga4Metric[]> {
  const token = await googleAccessToken();
  const prop = config.google.ga4PropertyId;
  if (!token || !prop) throw new Error('GA4 not configured');

  const endpoint = `https://analyticsdata.googleapis.com/v1beta/properties/${prop}:runReport`;
  const res = await timedFetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      dateRanges: [{ startDate: opts.startDate, endDate: opts.endDate }],
      dimensions: [{ name: 'landingPagePlusQueryString' }],
      metrics: [{ name: 'sessions' }, { name: 'conversions' }, { name: 'totalRevenue' }],
      dimensionFilter: {
        filter: {
          fieldName: 'sessionDefaultChannelGroup',
          stringFilter: { matchType: 'EXACT', value: 'Organic Search' },
        },
      },
      limit: 250,
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    }),
  }, 30000);
  if (!res.ok) throw new Error(`GA4 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j: any = await res.json();
  return (j.rows || []).map((r: any) => ({
    dimension: r.dimensionValues?.[0]?.value || '',
    sessions: Number(r.metricValues?.[0]?.value || 0),
    conversions: Number(r.metricValues?.[1]?.value || 0),
    totalRevenue: Number(r.metricValues?.[2]?.value || 0),
  }));
}

/** Two consecutive equal-length windows ending yesterday. */
export function comparativeWindows(days = 28) {
  const day = 86400000;
  const end = new Date(Date.now() - day); // yesterday
  const curStart = new Date(end.getTime() - (days - 1) * day);
  const prevEnd = new Date(curStart.getTime() - day);
  const prevStart = new Date(prevEnd.getTime() - (days - 1) * day);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return {
    current: { startDate: fmt(curStart), endDate: fmt(end) },
    previous: { startDate: fmt(prevStart), endDate: fmt(prevEnd) },
  };
}
