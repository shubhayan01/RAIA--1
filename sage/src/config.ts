import 'dotenv/config';

const num = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d);

const bool = (v: string | undefined, d: boolean) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

export const config = {
  port: num(process.env.PORT, 8787),

  auth: {
    // Enabled by default; set AUTH_ENABLED=false to run open (e.g. behind your own SSO).
    enabled: bool(process.env.AUTH_ENABLED, true),
    username: process.env.AUTH_USERNAME || 'admin',
    password: process.env.AUTH_PASSWORD || 'admin',
    // Signing secret for the session cookie. CHANGE THIS in production via .env.
    secret: process.env.AUTH_SECRET || 'sage-dev-secret-change-me',
    ttlHours: num(process.env.AUTH_TTL_HOURS, 168), // 7 days
  },

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
    temperature: num(process.env.LLM_TEMPERATURE, 0.3),
  },

  serp: {
    // 'tavily' = key-based LLM search API (reliable, no CAPTCHA) — recommended.
    // 'google' = free real Chromium (Playwright) hitting live Google.
    // 'serpapi' | 'dataforseo' = key-based, guaranteed SERP reports.
    // 'scrape' = legacy DuckDuckGo fallback. 'none' = off.
    provider: (process.env.SERP_PROVIDER || 'google').toLowerCase(),
    apiKey: process.env.SERP_API_KEY || '',
    tavilyKey: process.env.TAVILY_API_KEY || '',
    pythonBin: process.env.SERP_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    headless: bool(process.env.SERP_HEADLESS, true),
    proxy: process.env.SERP_PROXY || '',
    gl: process.env.SERP_GL || 'us',
    hl: process.env.SERP_HL || 'en',
  },

  keywords: {
    provider: (process.env.KEYWORDS_PROVIDER || 'free').toLowerCase(),
    apiKey: process.env.KEYWORDS_API_KEY || '',
  },

  // SEOptimer — real graded audit + backlinks + keyword rankings for a URL/domain.
  // When a key is present, Audit and Ranks prefer this (real data, no CAPTCHA).
  // Roadmap: swap to DataForSEO later without touching the services.
  seoptimer: {
    apiKey: process.env.SEOPTIMER_API_KEY || '',
    baseUrl: process.env.SEOPTIMER_BASE_URL || 'https://api.seoptimer.com',
  },

  google: {
    pagespeedKey: process.env.PAGESPEED_API_KEY || '',
    accessToken: process.env.GOOGLE_ACCESS_TOKEN || '',
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN || '',
    gscSiteUrl: process.env.GSC_SITE_URL || '',
    ga4PropertyId: process.env.GA4_PROPERTY_ID || '',
  },

  // Branding for the downloadable client proposal / audit report.
  report: {
    brand: process.env.REPORT_BRAND || 'S.A.G.E',
  },

  // ---- Execution layer (WordPress push, scheduling, alerts, opportunity loop) ----

  // WordPress CMS connector — push approved briefs / meta fixes straight into WP.
  // Auth uses an Application Password (WP Admin -> Users -> Profile -> Application
  // Passwords), sent as HTTP Basic auth. Never a real login password.
  wordpress: {
    url: (process.env.WP_URL || '').replace(/\/+$/, ''),
    username: process.env.WP_USERNAME || '',
    appPassword: process.env.WP_APP_PASSWORD || '',
  },

  // Shared SMTP transport for scheduled reports + ranking alerts (nodemailer).
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: num(process.env.SMTP_PORT, 587),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
  },

  // Scheduled Intelligence Reports — auto-email the monthly GSC+GA4 report.
  scheduler: {
    enabled: bool(process.env.SCHEDULER_ENABLED, false),
    cron: process.env.SCHEDULER_CRON || '0 9 1 * *', // 9am on the 1st of each month
    emailTo: (process.env.SCHEDULER_EMAIL_TO || '').split(',').map((s) => s.trim()).filter(Boolean),
    emailFrom: process.env.SCHEDULER_EMAIL_FROM || process.env.SMTP_USER || '',
  },

  // Ranking Drop Alert System — monitor tracked keywords, email on 5+ position moves.
  alerts: {
    enabled: bool(process.env.ALERTS_ENABLED, false),
    emailFrom: process.env.ALERTS_EMAIL_FROM || process.env.SCHEDULER_EMAIL_FROM || process.env.SMTP_USER || '',
  },

  // Automated GSC Opportunity Loop — striking-distance detection -> rewrite brief -> WP draft.
  opportunity: {
    minImpressions: num(process.env.OPPORTUNITY_MIN_IMPRESSIONS, 100),
  },

  crawl: {
    maxPages: num(process.env.CRAWL_MAX_PAGES, 120),
    concurrency: num(process.env.CRAWL_CONCURRENCY, 6),
    timeoutMs: num(process.env.CRAWL_TIMEOUT_MS, 15000),
    userAgent: process.env.CRAWL_UA || 'SAGEbot/1.0 (+https://your-agency.com/sage)',
  },

  // JavaScript rendering for the crawlers (audit / autolink / schema).
  // OFF by default: the plain fetcher reads server-rendered HTML, which is what
  // real client WordPress sites serve. Turn RENDER_JS=1 to fall back to a real
  // Chromium render (Python Playwright, same engine as the 'google' SERP provider)
  // whenever a page comes back thin — i.e. a JS-only SPA or a bot-wall shell. This
  // needs Python + Playwright installed: `pip install -r python/requirements.txt`
  // then `playwright install chromium`.
  render: {
    enabled: bool(process.env.RENDER_JS, false),
    pythonBin: process.env.SERP_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    timeoutMs: num(process.env.RENDER_TIMEOUT_MS, 45000),
    // A page whose plain-fetch body has fewer than this many words is treated as a
    // JS shell and re-fetched with a real browser (only when RENDER_JS=1).
    minWords: num(process.env.RENDER_MIN_WORDS, 120),
  },
};

export type Config = typeof config;
