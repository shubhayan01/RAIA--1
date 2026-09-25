import 'dotenv/config';

/**
 * NOVA configuration — same pattern as SAGE's config.ts, but with NOVA's own
 * env vars (business-development agent). Every third-party integration is
 * OPTIONAL and stays dormant until its variables are set; the only thing needed
 * to bring NOVA to life is an LLM key.
 */

const num = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d);
const bool = (v: string | undefined, d: boolean) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const list = (v: string | undefined) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

export const config = {
  // NOVA runs on its own port so it can sit alongside SAGE.
  port: num(process.env.NOVA_PORT || process.env.PORT, 8788),

  auth: {
    enabled: bool(process.env.AUTH_ENABLED, true),
    username: process.env.AUTH_USERNAME || 'admin',
    password: process.env.AUTH_PASSWORD || 'admin',
    secret: process.env.AUTH_SECRET || 'nova-dev-secret-change-me',
    ttlHours: num(process.env.AUTH_TTL_HOURS, 168), // 7 days
  },

  // Same LLM abstraction as SAGE. Chat + routing + writing copy only.
  llm: {
    provider: (process.env.LLM_PROVIDER || 'groq').toLowerCase(),
    model: process.env.LLM_MODEL || 'openai/gpt-oss-120b',
    apiKey:
      process.env.LLM_API_KEY ||
      process.env.GROQ_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.ANTHROPIC_API_KEY ||
      '',
    baseUrl: process.env.LLM_BASE_URL || '',
    temperature: num(process.env.LLM_TEMPERATURE, 0.4),
  },

  // Agency identity — injected into outreach / reply / care copy the LLM writes.
  agency: {
    name: process.env.NOVA_AGENCY_NAME || '',
    senderName: process.env.NOVA_SENDER_NAME || '',
    senderRole: process.env.NOVA_SENDER_ROLE || 'Business Development',
    notifyEmail: process.env.NOVA_NOTIFY_EMAIL || process.env.SMTP_FROM_EMAIL || '',
  },

  // Report branding (Full Prospect Report — Feature 8).
  report: {
    brand: process.env.NOVA_REPORT_BRAND || 'NOVA',
  },

  // Outbound email (nodemailer) — outreach, follow-ups, confirmations, alerts.
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: num(process.env.SMTP_PORT, 587),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    fromName: process.env.SMTP_FROM_NAME || process.env.NOVA_SENDER_NAME || 'NOVA',
    fromEmail: process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER || '',
  },

  // Outbound safety guardrails. Sends ALWAYS require explicit human approval; this
  // is an extra operator-level layer on top of that. `enabled=false` is a hard
  // kill-switch (pause a new/warming domain or a paused account in one place), and
  // `dailyCap` bounds real sends per calendar day to protect domain reputation.
  sending: {
    enabled: bool(process.env.NOVA_SENDING_ENABLED, true),
    dailyCap: num(process.env.NOVA_DAILY_SEND_CAP, 50),
  },

  // Inbound email (IMAP) — reply parsing (Feature 5).
  imap: {
    host: process.env.IMAP_HOST || '',
    port: num(process.env.IMAP_PORT, 993),
    user: process.env.IMAP_USER || process.env.SMTP_USER || '',
    pass: process.env.IMAP_PASS || process.env.SMTP_PASS || '',
    tls: bool(process.env.IMAP_TLS, true),
    // How often the poller checks INBOX (minutes). See risk notes in README.
    pollMinutes: num(process.env.IMAP_POLL_MINUTES, 15),
  },

  // Meeting scheduler (Feature 6).
  meeting: {
    availableDays: list(process.env.MEETING_AVAILABLE_DAYS) .length
      ? list(process.env.MEETING_AVAILABLE_DAYS)
      : ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
    startHour: num(process.env.MEETING_START_HOUR, 10),
    endHour: num(process.env.MEETING_END_HOUR, 17),
    durationMins: num(process.env.MEETING_DURATION_MINS, 30),
    timezone: process.env.MEETING_TIMEZONE || 'Asia/Kolkata',
    bufferMins: num(process.env.MEETING_BUFFER_MINS, 15),
    gmeetLink: process.env.MEETING_GMEET_LINK || '',
    // Google Calendar auth. Two options (refresh-token flow is preferred — a
    // static access token expires in ~1h):
    //   1. OAuth refresh flow: GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET +
    //      GOOGLE_REFRESH_TOKEN — NOVA mints a fresh access token on demand.
    //   2. A single static access token via GOOGLE_CALENDAR_TOKEN (legacy).
    googleCalendarToken: process.env.GOOGLE_CALENDAR_TOKEN || '',
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN || '',
  },

  // Follow-up sequence scheduler (Feature 4) — daily cron check.
  followup: {
    // node-cron expression — daily at 9am by default.
    cron: process.env.FOLLOWUP_CRON || '0 9 * * *',
    enabled: bool(process.env.FOLLOWUP_ENABLED, true),
    dayOffsets: [3, 7, 14], // day-3 / day-7 / day-14 sequence
  },

  // Client care scheduler (Feature 7) — daily cron check.
  clientcare: {
    cron: process.env.CLIENTCARE_CRON || '0 8 * * *',
    enabled: bool(process.env.CLIENTCARE_ENABLED, true),
    defaultCheckInDays: num(process.env.CLIENTCARE_CHECKIN_DAYS, 30),
  },

  // Optional PageSpeed key — raises the rate limit on the lightweight audit hook.
  google: {
    pagespeedKey: process.env.PAGESPEED_API_KEY || '',
  },

  // Web-scrape / crawl settings (shared by http.ts + prospect research).
  crawl: {
    maxPages: num(process.env.CRAWL_MAX_PAGES, 40),
    concurrency: num(process.env.CRAWL_CONCURRENCY, 5),
    timeoutMs: num(process.env.CRAWL_TIMEOUT_MS, 15000),
    userAgent: process.env.CRAWL_UA || 'NOVAbot/1.0 (+https://example.com/nova)',
  },

  // Python binary for the PDF renderer (Playwright), same as SAGE.
  python: {
    bin: process.env.NOVA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
  },
};

export type Config = typeof config;
