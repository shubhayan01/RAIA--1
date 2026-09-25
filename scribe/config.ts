import 'dotenv/config';

/**
 * SCRIBE configuration — sibling to SAGE (SEO) and NOVA (business development).
 * SCRIBE is the CONTENT-AUTOMATION agent: keyword research, competitor content
 * analysis, content-gap discovery, keyword clustering, brand-voice extraction,
 * grounded content generation, fact-checking, AI-content detection and E-E-A-T
 * scoring.
 *
 * Same pattern as NOVA's config.ts. Every third-party integration is OPTIONAL and
 * stays dormant until its variables are set; the only thing needed to bring
 * SCRIBE to life is an LLM key (and, for real SERP data, a Tavily key or the free
 * browser SERP).
 */

const num = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d);
const bool = (v: string | undefined, d: boolean) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

export const config = {
  // SCRIBE runs on its own port so it can sit alongside SAGE (8787) and NOVA (8788).
  port: num(process.env.SCRIBE_PORT || process.env.PORT, 8789),

  auth: {
    enabled: bool(process.env.AUTH_ENABLED, true),
    username: process.env.AUTH_USERNAME || 'admin',
    password: process.env.AUTH_PASSWORD || 'admin',
    secret: process.env.AUTH_SECRET || 'scribe-dev-secret-change-me',
    ttlHours: num(process.env.AUTH_TTL_HOURS, 168), // 7 days
  },

  // Same LLM abstraction as SAGE/NOVA. The AI-role principle holds: the LLM only
  // (1) chats + routes commands and (2) WRITES/STRUCTURES content over real data
  // it is handed. It never invents rankings, word counts, competitor facts or
  // fact-check verdicts — those come from the real sources (SERP, page scrapes).
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

  // Brand identity — injected into the content the LLM writes when no per-project
  // brand profile has been extracted from the user's own site yet.
  brand: {
    name: process.env.SCRIBE_BRAND_NAME || 'Your Brand',
    defaultVoice: process.env.SCRIBE_DEFAULT_VOICE || 'Clear, credible, helpful and human — expert without jargon.',
    // Fallback byline used by the publish gate when a draft has no author. This is
    // a CONFIG gap to fix once (set a real author), not a per-article human task.
    defaultAuthor: process.env.SCRIBE_DEFAULT_AUTHOR || '',
  },

  // SERP — real search data (top-ranking blogs, related searches, People-Also-Ask).
  // 'tavily'  = key-based LLM search API (reliable, no CAPTCHA) — RECOMMENDED for SCRIBE.
  // 'google'  = free real Chromium (Playwright) hitting live Google.
  // 'serpapi' | 'dataforseo' = key-based, guaranteed SERP reports.
  // 'scrape'  = legacy DuckDuckGo fallback. 'none' = off.
  serp: {
    provider: (process.env.SERP_PROVIDER || 'tavily').toLowerCase(),
    apiKey: process.env.SERP_API_KEY || '',
    tavilyKey: process.env.TAVILY_API_KEY || '',
    pythonBin: process.env.SERP_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    headless: bool(process.env.SERP_HEADLESS, true),
    proxy: process.env.SERP_PROXY || '',
    gl: process.env.SERP_GL || 'us',
    hl: process.env.SERP_HL || 'en',
  },

  // Content-generation knobs.
  content: {
    // Default word-count target when neither the brief nor the SERP average sets one.
    defaultWordTarget: num(process.env.SCRIBE_WORD_TARGET, 1200),
    // How many top-ranking competitor pages to deep-analyse per keyword.
    competitorDepth: num(process.env.SCRIBE_COMPETITOR_DEPTH, 6),
    // Max claims fact-checked per run (each claim costs a SERP call).
    factcheckMaxClaims: num(process.env.SCRIBE_FACTCHECK_MAX, 8),
    // Auto-research: with an empty brief, SCRIBE researches the web on its own —
    // it escalates searches to gather real evidence + a source digest, and (rather
    // than halting on thin evidence) writes a full, human-sounding article grounded
    // in what it actually read. Fabrication is still impossible: the publish gate
    // strips any number not present in the collected evidence. Turn OFF to restore
    // the strict halt-on-low-evidence behaviour.
    autoResearch: bool(process.env.SCRIBE_AUTO_RESEARCH, true),
    // 'fast' (default) reads the SEARCH SNIPPETS and distills them in ONE LLM call
    // — no per-page fetch+extract — so a run makes ~3 LLM calls total and finishes
    // in a minute or two even on a rate-limited free tier. 'deep' fetches and
    // extracts each source page (verified page-level stats, higher quality, but
    // ~10 LLM calls and much slower on a free tier). Set SCRIBE_RESEARCH_MODE=deep
    // on a paid/local LLM for reference-grade sourcing.
    // 'deep' (default) does REAL research — it fetches the top-ranking pages and
    // mines their actual text — but in a single combined "consume" LLM call, not
    // one per page, so it stays lean. 'fast' reads only search snippets (no page
    // fetch) for the quickest possible run. The LLM is used only to consume the
    // gathered info and write; it never invents research.
    researchMode: (process.env.SCRIBE_RESEARCH_MODE || 'deep').toLowerCase(),
    // ---- Research + token knobs ----
    // Top-N ranking pages fetched and mined for evidence (real content analysis).
    maxResearchPages: num(process.env.SCRIBE_MAX_RESEARCH_PAGES, 5),
    // The evidence count research aims for.
    targetStats: num(process.env.SCRIBE_TARGET_STATS, 5),
    // Characters of each source page fed to the single combined extractor.
    pageTextChars: num(process.env.SCRIBE_PAGE_TEXT_CHARS, 3000),
    // Max output tokens for the draft body, and the draft length ceiling — sized
    // for a genuinely in-depth article, not a thin one.
    maxDraftTokens: num(process.env.SCRIBE_MAX_DRAFT_TOKENS, 4200),
    wordTargetCeil: num(process.env.SCRIBE_WORD_CEIL, 2400),
    // Publish-gate auto-fix iterations on a bare write (each iteration is 1-2 LLM calls).
    gateIterations: num(process.env.SCRIBE_GATE_ITERATIONS, 1),
  },

  // Optional PageSpeed key — raises the rate limit on the page-fetch/technical hook.
  google: {
    pagespeedKey: process.env.PAGESPEED_API_KEY || '',
  },

  // Web-scrape / crawl settings (shared by http.ts + page fetching).
  crawl: {
    maxPages: num(process.env.CRAWL_MAX_PAGES, 40),
    concurrency: num(process.env.CRAWL_CONCURRENCY, 5),
    timeoutMs: num(process.env.CRAWL_TIMEOUT_MS, 15000),
    userAgent: process.env.CRAWL_UA || 'SCRIBEbot/1.0 (+https://example.com/scribe)',
  },
};

export type Config = typeof config;
