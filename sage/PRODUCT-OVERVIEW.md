# S.A.G.E — Product Overview

**S.A.G.E** — an autonomous SEO agent for digital marketing agencies.
One chat interface. Nine real capabilities. Every number backed by live data, never invented by an LLM.

> **Version:** 0.1.0 · **Stack:** Node 18.17+ / TypeScript (ESM, run via `tsx`) / Express 4 + Python 3 (Playwright/Chromium) · **Runtime deps:** `cheerio`, `dotenv`, `express`, `tsx` · **License model:** self-hosted, white-labelable, bring-your-own-keys · **No build step** (TypeScript runs directly through `tsx`).

---

## 1. The one-line pitch

> *"Give an agency an SEO analyst that never sleeps, never guesses, and runs on free data — a single chat box that audits sites, researches keywords, tracks rankings, writes content briefs, and reports on Search Console + GA4, with every figure sourced from a live crawl or a real search result."*

---

## 2. The core principle (why this is different)

Most "AI SEO tools" ask a language model to *make up* metrics — search volumes, difficulty scores, rankings — and present the hallucination as fact. S.A.G.E refuses to.

**The LLM is used for exactly three things:**
1. Holding the conversation (small talk, "who are you", greetings).
2. Routing a request to the correct tool (deciding *which* capability to run) — and only as a fallback, after deterministic regex rules fail.
3. **Structuring and explaining** what the tools already measured (clustering keyword lists, writing the narrative of a brief or monthly report, naming content gaps from measured signals).

**Everything else runs live on real data sources** — the built-in crawler, Google Autocomplete, live search SERPs (Tavily / browser Google / DuckDuckGo / SerpApi / DataForSEO), Google Lighthouse/PageSpeed, the SEOptimer graded-audit API, Google Search Console, and GA4. Every LLM system prompt explicitly forbids inventing SEO data. When a data source is blocked (e.g. a CAPTCHA on live Google), S.A.G.E **says so and fails honestly** — it returns a plain-language note instead of fabricated numbers, and often falls back to a different real source.

**Why this sells:** trust. An agency puts these reports in front of paying clients. One fabricated "you rank #3" that turns out false burns the relationship. S.A.G.E's honesty is the product.

---

## 3. System at a glance — the file map

```
src/
  config.ts              One typed config object built from env (dotenv). The single source of truth.
  auth.ts                Dependency-free signed-cookie (HMAC-SHA256) sessions — no DB.
  server.ts              Express bootstrap: static UI, auth gates, /api mount, boot banner.
  routes.ts              /api/ask dispatcher (chat-first), /api/status, /api/report (proposal HTML/PDF).

  llm/
    index.ts             Provider registry + complete()/completeJSON() + loose-JSON parser.
    types.ts             ChatMessage / ChatOptions / LLMProvider interfaces.
    providers/
      openaiCompatible.ts  Groq, OpenAI, Ollama, and any OpenAI-compatible endpoint.
      anthropic.ts         Claude (Messages API).

  lib/
    http.ts              Redirect-aware fetch (timedFetch, requestOnce, followChain), getJSON.
    html.ts              cheerio parsing: parseHtml (full), extractOutline (cheap), contentFingerprint.
    concurrency.ts       pool() — bounded-concurrency worker pool, order-preserving.
    report.ts            The normalized Report/Block schema + `b.*` block builders.

  sources/               Real data adapters (the LLM never sees these directly):
    autocomplete.ts      FREE Google Autocomplete keyword + question expansion.
    serp.ts              SERP adapter: tavily | google(browser) | scrape(DDG) | serpapi | dataforseo | none.
    psi.ts               Google PageSpeed Insights (Lighthouse + Core Web Vitals / CrUX).
    google.ts            Search Console + GA4 (OAuth access-token or refresh-token mint).
    seoptimer.ts         SEOptimer graded-audit API (create+poll, cached 15 min).

  services/              One file per capability (the pipelines):
    keywords.ts          Keyword research & clustering.
    audit.ts             Full-site crawl + issue detection + Lighthouse + SEOptimer.
    brief.ts             SERP-driven content brief.
    aioverview.ts        AI Overview content-gap (GEO/AEO).
    ranks.ts             Rank tracker.
    cannibal.ts          Keyword cannibalization detector (pure algorithm, no LLM).
    intelligence.ts      GSC + GA4 monthly intelligence report.
    competitive.ts       Competitor discovery + gap analysis.
    proposal.ts          Aggregates everything into the full client-report model.
    converse.ts          Chat replies + command routing — the only place the LLM "talks".

  report/
    proposalHtml.ts      Renders the proposal model into branded, print-ready HTML.
    pdf.ts               Streams that HTML to PDF via the bundled Playwright/Chromium.

public/                  The S.A.G.E chat UI — index.html, styles.css, app.js, login.html.
python/
    google_serp.py       Free live Google via headless Chromium (Playwright) with stealth.
    html_to_pdf.py       HTML→PDF renderer used by report/pdf.ts.
    requirements.txt     playwright>=1.40
Dockerfile · render.yaml · .env.example · tsconfig.json
```

**Two cross-cutting contracts hold the whole thing together:**

- **The `Report` schema (`lib/report.ts`).** Every capability returns `{ tag, title, blocks[], data? }`. A `Block` is one of `p | kv | list | table | chips | tasks | note`. The frontend renders blocks generically, so a service can add output without ever touching the UI. `data` carries the raw structured payload for export / API consumers.
- **The `config` object (`config.ts`).** Env is read exactly once, coerced (`num`/`bool` helpers), and frozen into one typed object every module imports. Change behaviour by changing env — never by editing code.

---

## 4. The request lifecycle — end to end

What actually happens when a user types into the box:

1. **Frontend (`public/app.js`)** — the user picks a tool from the dropdown (default **Auto/`chat`**) and types. On Enter/Send, it `POST`s `/api/ask` with `{ mode, text }`, shows a typing indicator, and disables the composer.
   - Exception: **Full Report** mode opens `/api/report?url=…` in a new browser tab (a deep crawl can take a minute) and shows an "Open report / Download PDF" chip pair instead of chat blocks.
2. **Auth gate (`server.ts` → `auth.requireAuth`)** — `/api/*` requires a valid signed session cookie or it returns `401 { ok:false, error:'auth required' }`. Page routes redirect to `/login` instead.
3. **Dispatch (`routes.ts` → `dispatch()`)**:
   - If `mode === 'chat'` → `classify(text)` decides: small talk, a capabilities card, or a specific tool + argument.
   - If an explicit tool pill is set → a quick `looksConversational()` regex still intercepts a stray "hi" or "what can you do", so a greeting never triggers a crawl. Otherwise it runs the chosen tool.
4. **Tool run (`routes.ts` → `runTool()`)** — calls the matching `services/*` function with the parsed argument and options.
5. **The service pipeline** — fetches real data (sources), optionally asks the LLM to *structure/explain* it, and builds a `Report`.
6. **Response** — `{ ok:true, report }`. Errors are caught and returned as `{ ok:false, report: <error note> }` with HTTP 200, so the UI always renders a clean bubble rather than a raw failure.
7. **Render (`app.js → renderReport`)** — maps each block type to HTML. Severity words (`critical/high/medium/low`) and task chips get colour-coded; tables wrap in a horizontal scroller.

`GET /api/status` runs alongside on page load and drives the header: it reports live availability of auth, LLM, SERP provider, SEOptimer, keywords provider, and Google (PageSpeed/GSC/GA4). A missing LLM key surfaces a visible warning banner.

---

## 5. Routing & conversation (`services/converse.ts`)

Routing is **deterministic-first, LLM-last** — cheap, instant, and predictable:

1. **Regex signals** run first (free, no API call):
   - `HELP` pattern → capabilities card.
   - `GREETING`/`THANKS`/`BYE` (≤6 words) → small talk.
   - Topic patterns, checked in priority order: `aio` (AI Overview) → `cannibal` → `ranks` → `intel` → `competitors` → `audit` → `briefs` → `keywords`.
   - A bare URL/domain in ≤3 words → treated as "audit this".
2. **Argument extraction** — `extractUrlOrDomain()` pulls the first real domain (ignoring `e.g.`, `vs.`, etc.); `stripCommandWords()` peels off verbs so *"research keywords for running shoes"* → *"running shoes"*.
3. **LLM fallback** — only if the regexes are inconclusive *and* an LLM key is set. A `temperature:0` classifier returns strict JSON `{ intent, arg }`. If it fails or the LLM is off, the message degrades to small talk.

**Conversation replies** (`smalltalkReport`) use the LLM when configured (warm, 1–3 sentences, forbidden from inventing SEO data) and fall back to hand-written templates otherwise. The **capabilities card** (`capabilitiesReport`) is fully deterministic and reflects *live* connection status for each data source.

---

## 6. The nine capabilities — the working process of each

Each is a real pipeline over real data. Sellable outcome first, then the exact mechanism.

### 6.1 Keyword Research & Clustering (`keywords.ts`)
*Sell: "A prioritized keyword map tied to real search demand and your existing content."*

1. **Collect (free):** `expandKeywords()` fires Google Autocomplete for the seed plus ~15 modifiers (`how to`, `best`, `near me`, `cost`…) both prefixed and suffixed, **plus alphabet-soup** (`seed a`, `seed b`…), all at concurrency 6. `questionKeywords()` pulls question-stem suggestions (`how/what/why/when…`) for the FAQ/PAA set.
2. **Dedupe & filter:** drop <3-char and duplicate stems.
3. **Cap for the LLM:** first 220 keywords (cost/latency bound) — kept broad.
4. **Cluster (LLM):** the model removes irrelevant terms, assigns one intent (`informational|commercial|transactional|navigational`), forms 6–12 tight clusters of 5–15 keywords each, scores **priority 1–100** (volume × commercial value × achievability), suggests a page type, and writes a one-line opportunity note. Output validated & clamped.
5. **Map to pages (LLM, optional):** if the client's existing page URLs are supplied, each cluster is matched to the best page or flagged `✗ none — NEW` (net-new content opportunity).
6. **Competitor gaps (optional):** if a competitor domain is given — **SEOptimer** returns that competitor's *real* ranking keywords with search volume (preferred); otherwise a free SERP-overlap check flags clusters where the competitor already ranks.

Requires an LLM key (returns a "needs LLM" note otherwise). Every keyword is a real Google suggestion — none are invented.

### 6.2 SEO Audit & Issue Detection (`audit.ts`)
*Sell: "A grounded, no-fluff fix list — every task traces to a detected issue, not a guess."*

1. **Resolve the seed:** `followChain()` walks the homepage's redirects (apex→www, http→https, trailing-slash canonical) so the crawl origin matches where the site actually lives.
2. **robots.txt:** fetched (redirect-aware), parsed for `Disallow: /` (whole-site block) and `Sitemap:` directives.
3. **BFS crawl (same-origin):** concurrency 6, budget counts **terminal pages** (real 200/404/… responses, default 120, cap 500) — redirect hops are followed but don't spend the budget, with a hard fetch cap (`maxPages×6`) and enqueue cap (`×8`) to bound total work and any loop. Each HTML page is parsed by `parseHtml()` (title, meta, H1/H2/H3, canonical, robots meta, viewport, schema, images/alt, internal/external links, word count) and given a 4-word-shingle `contentFingerprint` for near-duplicate detection.
4. **Sitemap:** fetched from robots or `/sitemap.xml`, sitemap-index-aware (up to 15 fetches), URLs collected for orphan detection.
5. **Detect → group → prioritize (deterministic, no LLM):** issue groups include 404 / 5xx / unreachable, redirect chains & loops, canonical-elsewhere, noindex, duplicate URL variants, orphan pages, duplicate content (fingerprint), missing/duplicate titles & metas, missing/multiple H1, broken heading order, missing alt, thin content, and missing mobile viewport. Groups are sorted by severity then count.
6. **Trusted third-party data (parallel):** Google **Lighthouse/PageSpeed** (mobile — Performance/SEO/Accessibility/Best-Practices + Core Web Vitals) and, if a key is set, the **SEOptimer** graded audit (grades, ~90 checks, backlinks, real keyword rankings, technologies).
7. **Report:** site summary, Lighthouse table, SEOptimer grades/backlinks/rankings/recommendations, the crawler's own issue table, and a **prioritized fix list built directly from detected issue counts** — nothing inferred. Accurate whole-site counts (`AuditCounts`) are computed separately from the display-capped examples.

### 6.3 Content Brief (`brief.ts`)
*Sell: "A ready-to-write brief built from what's actually ranking today."*

1. **SERP → competitors:** `serp(kw, 8)` → top 6 result URLs. If the SERP source is blocked, it **refuses to guess** and returns the honest error note.
2. **Extract outlines:** fetch each URL (pool 4) and `extractOutline()` (title, H2/H3, word count).
3. **Questions:** `questionKeywords()` for the FAQ set.
4. **Synthesize (LLM):** using the keyword, SERP intent, and *real* competitor headings, the model produces intent, secondary keywords, must-have topics, differentiation gaps, suggested title/H1, full H2/H3 structure, internal-link ideas, CTA, target word count, schema types, entities, and audience.
5. **Handoff:** the brief ends with *"Awaiting human approval → hand to writer."* (writer handoff is a wired roadmap hook).

Requires both an LLM key and a working SERP source.

### 6.4 AI Overview Content Gap — GEO/AEO (`aioverview.ts`)
*Sell: "Get your content into Google's AI answers — here's exactly what the cited pages have that yours doesn't."*

1. **Parse input:** split the request into a keyword and (optional) client URL.
2. **Find AI-Overview sources:**
   - **SerpApi** → reads the real `ai_overview.sources` block.
   - **Serper.dev** (`SERPER_API_KEY`) → reads `answerBox.references`.
   - **Otherwise** → the configured SERP provider. With **Tavily**, the synthesized answer's top cited pages stand in as the source set; the browser scraper best-effort-extracts the on-page AI Overview links; both fall back to the top organic results as a proxy.
3. **Scrape structural signals** from up to 6 cited pages *and* the client article (pool 4): word count, H1/H2/H3, and presence of FAQ / table / numbered & bullet lists / calculator / comparison.
4. **Compare (deterministic):** builds the matrix — client vs. average cited-page word count, how many cited pages have FAQ/table/lists, and the client's organic position.
5. **Synthesize gaps (LLM, over measured signals only):** executive summary, specific content gaps, and 3–5 concrete recommendations — never invented metrics.
6. **Real GEO audit (optional):** if SEOptimer is configured and a client URL is given, adds a page-level GEO/AI-readiness grade, its checks, and any keywords already appearing in AI Overviews. If the SERP is unavailable but the GEO audit succeeded, it returns the GEO audit alone rather than nothing.

### 6.5 Rank Tracker (`ranks.ts`)
*Sell: "Honest position tracking — and the near-miss keywords worth one more push."*

1. **Parse** `domain: kw1, kw2, …` (colon-separated or first domain token), capped at 25 keywords.
2. **Preferred — SEOptimer:** returns **real** Google positions with search volume and estimated traffic (no CAPTCHA). With no keywords given, it shows what the domain already ranks for (position distribution + top set). With keywords, it cross-matches, collapsing per-country rows to the best position.
3. **Fallback — live SERP:** any keyword SEOptimer doesn't track (or when no key is set) is checked against the live SERP per keyword (pool 2, depth 30) — throttled to avoid bans.
4. **Report:** buckets (Top 3 / Top 10 / Top 30 / Not found), a per-keyword table, and a **striking-distance** highlight (positions 4–15 = quick wins). Source failures are labelled "could not check" — never silently reported as "not ranking". No LLM: positions come straight from the source.

### 6.6 Keyword Cannibalization (`cannibal.ts`)
*Sell: "Stop your own pages from fighting each other in search." — fully deterministic, no LLM.*

1. **Crawl** up to 60 same-origin HTML pages (BFS), reading each page's title + H1 (skipping noindex pages).
2. **Tokenize** title+H1 into keyword tokens (stopwords removed).
3. **Drop brand tokens** — words appearing on ≥60% of pages (site name, nav) are excluded from matching.
4. **Cluster** with union-find: any two pages whose token sets have **Jaccard overlap ≥ 0.6** are unioned.
5. **Report** clusters of ≥2 pages competing for the same query, severity by cluster size (2=medium, 3=high, ≥4=critical), with a consolidate/canonical/differentiate fix for each.

### 6.7 SEO Intelligence & Reporting (`intelligence.ts`)
*Sell: "The monthly client report, generated — real GSC + GA4 numbers, no manual spreadsheet."*

1. **Two windows:** `comparativeWindows(days)` builds the current period (default 28 days, ending yesterday) and the equal-length prior period.
2. **Pull (parallel):** GSC search analytics by query and by page (current vs. previous), and GA4 organic-search sessions/conversions/revenue by landing page.
3. **Totals & deltas:** clicks, impressions, CTR, avg position (impression-weighted), sessions, conversions, revenue — each with a % or point delta.
4. **Detection:** ranking drops/gains (≥3 positions, impression-thresholded), lost keywords, new keywords.
5. **Opportunity detection:** striking-distance (position 4–20, high impressions) and high-impressions-low-CTR (title/meta rewrite candidates).
6. **Narrative (LLM):** a senior-analyst monthly write-up — what changed, likely why, what to investigate, recommended actions — grounded strictly in the measured movements.
7. **Fallback:** if neither GSC nor GA4 is connected but SEOptimer is (and a domain can be derived from `GSC_SITE_URL`), it returns a clearly-labelled **third-party estimate** and instructions to connect first-party Google data.

### 6.8 Competitive Intelligence (`competitive.ts`)
*Sell: "Know what your competitors rank for that you don't — and where to attack."*

1. **Discover** competitors from SERP overlap across up to 5 seed keywords (pool 2), counting domain appearances. User-supplied competitors take priority. Honest failure if the SERP returns nothing and no manual competitors were given (falls back to the client's own SEOptimer profile if available).
2. **Analyze content:** fetch the client's and top competitors' pages, extract heading outlines.
3. **Gap analysis (LLM):** topics the client covers, topics competitors cover that the client doesn't, likely keyword gaps, and a prioritized opportunity list.
4. **Real head-to-head (SEOptimer, optional):** audit client + each competitor (cached, parallel) → a grades/authority/traffic table and **real keyword gaps** — keywords a competitor ranks for (with volume) that the client's tracked set doesn't include.

### 6.9 Full Client Report / Proposal (`proposal.ts` → `report/proposalHtml.ts` → `report/pdf.ts`)
*Sell: "A branded, board-ready audit + 90-day growth proposal — as a shareable page and a downloadable PDF."*

Endpoint: `GET /api/report?url=<domain>&format=html|pdf&brand=<name>&pages=<n>`.

1. **Aggregate everything measured for one site:** a full crawl audit (which itself pulls mobile Lighthouse + SEOptimer), plus a **desktop** PageSpeed run, all in parallel and cache-shared.
2. **Build the client model:** category cards (On-Page SEO / AI Search / Performance / Backlinks / Usability), a pass/improve/fix/review summary, critical issues (speed, titles, thin content, canonicals, backlinks, broken links, metas, H1s, alt text) each with real extents ("N of M pages"), quick wins, tech vitals, whole-site checks, a homepage element-by-element verdict, an organic/backlink/position-distribution snapshot, whole-crawl health, per-issue affected-URL detail, real keyword rankings, and a **deterministic 90-day roadmap** sequenced from the actual findings (Phase 1 stop-the-bleeding → Phase 2 foundations → Phase 3 authority & depth).
3. **Render:** branded print-ready HTML (`proposalHtml.ts`); `format=pdf` streams it through the bundled Playwright/Chromium renderer (`html_to_pdf.py`) as a downloadable file. Brand string is configurable (`REPORT_BRAND` or `?brand=`).

Every figure in the proposal is measured — the LLM is not involved in the report model.

---

## 7. The data-sources layer

Adapters that produce **real, measured** data. The LLM never calls these directly; services do, then hand the LLM measured facts.

| Source | File | Cost / auth | What it returns | Failure behaviour |
|---|---|---|---|---|
| **Google Autocomplete** | `autocomplete.ts` | Free, no key | Real long-tail queries + question stems | Returns `[]` on any error |
| **SERP adapter** | `serp.ts` | Varies by provider | `{ results[], relatedSearches, paa?, aiOverviewSources?, error?, captcha? }` | `serpErrorNote()` gives a plain-language reason; never fakes results |
| **PageSpeed / Lighthouse** | `psi.ts` | Free (`PAGESPEED_API_KEY` only raises rate limit) | Category scores + Core Web Vitals (CrUX field data, else lab), speed opportunities, failing SEO/a11y/best-practice audits | Returns `{ error }`, audit continues without it |
| **Search Console + GA4** | `google.ts` | Free; OAuth token or refresh-token trio (token cached & auto-minted) | Query/page performance rows; organic sessions/conversions/revenue | Throws → captured as a warning in the report |
| **SEOptimer** | `seoptimer.ts` | Paid credits (1/report), 15-min cache | Grades (SEO/GEO/Links/Perf/Social/UI/Security), ~90 checks, prioritized recs, real keyword rankings + volume + est. traffic, backlink profile, AI-Overview rankings, technologies | Never throws; returns `{ ok:false, error }` so callers fall back |

### SERP providers (`SERP_PROVIDER`)

| Value | Mechanism | Notes |
|---|---|---|
| **`tavily`** *(recommended)* | `POST api.tavily.com/search` (Bearer key, `search_depth:advanced`, `include_answer`) | Key-based, reliable, **no CAPTCHA**, no browser. Maps results → organic; `follow_up_questions` → related; the answer's top sources → AI-Overview proxy. Reads `TAVILY_API_KEY` (falls back to `SERP_API_KEY`). |
| `google` / `browser` | `python/google_serp.py` drives real Chromium (Playwright) | Free. Human-typing flow, EU-consent cookie bypass, persistent profile, light stealth. Returns organic + PAA + related + best-effort AI-Overview links, and an honest `captcha` flag. Memory-hungry; datacenter IPs are usually challenged. |
| `serpapi` | `serpapi.com` JSON API | Paid, Google-accurate; reads the real AI-Overview sources block. |
| `dataforseo` | DataForSEO Google Live (Basic auth) | Paid; roadmap successor behind the same adapter. |
| `serper` | (AI-Overview path only) `google.serper.dev` | Reads `answerBox.references` as an AI-Overview proxy. |
| `scrape` | DuckDuckGo HTML (`cheerio`) | Free legacy fallback; detects DDG's anomaly challenge. |
| `none` | — | Disables all SERP-dependent features (they return a clear "SERP disabled" note). |

---

## 8. The LLM abstraction (`llm/`)

- **Provider registry (`index.ts`):** one `switch` maps `LLM_PROVIDER` to a provider. `groq`/`openai`/`ollama` and any unknown value use the **OpenAI-compatible** client (point `LLM_BASE_URL` at OpenRouter, Together, vLLM, LM Studio, etc.); `anthropic` uses the Claude Messages API. The provider is a lazy singleton.
- **Helpers:** `complete(system, user, opts)` for prose; `completeJSON()` appends a "JSON only" instruction and runs `parseLooseJSON()` — which strips code fences and, on failure, extracts the outermost `{…}`/`[…]` — so a chatty model can't break a pipeline.
- **`llmConfigured()`** is true when a key is set, *or* the provider is `ollama` (local, keyless). Services that need the LLM degrade to a clear "add a key" note when it isn't.

| Provider | `LLM_PROVIDER` | Example `LLM_MODEL` |
|---|---|---|
| Groq (default) | `groq` | `openai/gpt-oss-120b` |
| OpenAI | `openai` | `gpt-4o-mini` |
| Anthropic | `anthropic` | `claude-sonnet-4-5` |
| Ollama (local, keyless) | `ollama` | `llama3.1` |
| Any OpenAI-compatible | *(any name)* + `LLM_BASE_URL` | provider-specific |

---

## 9. The UI & rendering (`public/`)

- **Single-page chat shell** (`index.html` + `styles.css` + `app.js`), light/dark theme (persisted in `localStorage`).
- **Tool dropdown** with 10 entries: **Auto** (`chat`, S.A.G.E routes), then Keywords, Audit, Content Brief, AI Overview, Rank Tracker, Cannibalization, Intelligence, Competitors, and **Full Report**. Each has a mode-specific placeholder to teach the input format.
- **Generic block renderer** — `renderReport()` walks `report.blocks` and maps each type to HTML; severity words and task chips are colour-coded, tables wrap for horizontal scroll. Because the frontend renders the schema, not the capability, new backend output appears with **zero UI changes**.
- **Full Report** opens `/api/report` in a new tab and offers the PDF link (deep crawls take time).
- **Status header** — `/api/status` drives an LLM-not-configured warning, the logged-in user chip, and the log-out button.

---

## 10. Configuration (env)

The **only** required value is an LLM key. Everything else has a free default or degrades gracefully with a clear in-UI message. Read once by `config.ts`.

- **Server:** `PORT` (default 8787).
- **Login:** `AUTH_ENABLED` (default true), `AUTH_USERNAME` (default `admin`), `AUTH_PASSWORD` (default `admin`), `AUTH_SECRET` (default `sage-dev-secret-change-me` — **change before deploying**), `AUTH_TTL_HOURS` (default 168h / 7 days). The boot banner warns when defaults are still in use.
- **LLM:** `LLM_PROVIDER`, `LLM_MODEL`, `LLM_API_KEY` (or per-provider `GROQ_API_KEY`/`OPENAI_API_KEY`/`ANTHROPIC_API_KEY`), optional `LLM_BASE_URL`, `LLM_TEMPERATURE` (0.3).
- **SERP:** `SERP_PROVIDER` (`tavily` recommended | `google` | `scrape` | `serpapi` | `dataforseo` | `none`), **`TAVILY_API_KEY`** (for Tavily), `SERP_API_KEY` (serpapi/dataforseo), `SERPER_API_KEY` (enables real AI-Overview citations), plus browser-SERP options `SERP_HEADLESS`, `SERP_PROXY`, `SERP_GL`/`SERP_HL`, `SERP_PYTHON`/`SERP_PROFILE_DIR`.
- **Keywords:** `KEYWORDS_PROVIDER` (`free` default | `dataforseo`), `KEYWORDS_API_KEY`.
- **SEOptimer:** `SEOPTIMER_API_KEY`, optional `SEOPTIMER_BASE_URL`.
- **Google data:** `PAGESPEED_API_KEY`, `GOOGLE_ACCESS_TOKEN` **or** `GOOGLE_CLIENT_ID`/`SECRET`/`REFRESH_TOKEN`, `GSC_SITE_URL`, `GA4_PROPERTY_ID`.
- **Report branding:** `REPORT_BRAND`.
- **Crawler:** `CRAWL_MAX_PAGES` (120), `CRAWL_CONCURRENCY` (6), `CRAWL_TIMEOUT_MS` (15000), `CRAWL_UA`.

### API surface

```
POST /api/ask     { mode, text, options? }  → { ok, report }
GET  /api/status                            → live availability of every subsystem
GET  /api/report  ?url=&format=html|pdf&brand=&pages=   → branded proposal (HTML or PDF)
POST /api/login · GET|POST /api/logout · GET /login     → auth
```
`mode` ∈ `chat | keywords | audit | briefs | aio | ranks | cannibal | intel | competitors` (+ `report` handled by the UI as a link). `chat` (default) routes automatically; other modes force a tool.

---

## 11. Security & auth (`auth.ts`, `server.ts`)

- **Dependency-free signed-cookie session** — an HMAC-SHA256-signed payload (`{ user, exp }`, base64url) carried in the `sage_session` cookie. No database, no server-side store. Verified with a constant-time compare.
- **Gating:** `requireAuth` protects the app shell (`/`, `/index.html`, and the catch-all) and all `/api/*` (401 JSON for API, redirect to `/login` for pages). Static assets and `/login` stay public; static serving has `index:false` so `/` can't bypass the gate.
- **Cookie hardening:** `HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age` from `AUTH_TTL_HOURS`.
- **Self-hosted, no phone-home:** no telemetry; client data stays on the agency's own infrastructure.

---

## 12. Deployment

- **Docker (`Dockerfile`):** `node:20-bookworm-slim` + Python 3 + Playwright/Chromium (with OS libs). Installs prod Node deps (`tsx` is a runtime dep — no build step) and runs `npm start`. `SERP_PYTHON=python3`, `NODE_ENV=production`, exposes 8787 (host `PORT` is honoured).
  ```bash
  docker build -t sage . && docker run -p 8787:8787 --env-file .env sage
  ```
- **Render (`render.yaml`):** Docker web service, health check `/login`, `AUTH_SECRET` auto-generated, `AUTH_USERNAME`/`AUTH_PASSWORD`/`LLM_API_KEY` set in the dashboard.
- **Server note on SERP:** the browser (`google`) provider is memory-hungry and datacenter IPs are usually CAPTCHA'd by Google. For reliable Briefs / Competitors / Ranks / AI Overview on a server, prefer **`SERP_PROVIDER=tavily`** (key-based, no browser) — or `serpapi`, or a residential `SERP_PROXY`.

### Quick start (local)

```bash
npm install
cp .env.example .env      # then add your LLM key (Windows: copy .env.example .env)
# for browser SERP only: pip install playwright && python -m playwright install chromium
npm run dev               # http://localhost:8787   (tsx watch — no build step)
```

---

## 13. Commercial model

**Positioning:** a white-label SEO analyst you host and rebrand — between "expensive SaaS seat per client" (Ahrefs/SEMrush) and "hire another analyst."

- **Runs on free data by default.** The only hard requirement for real intelligence is one LLM key (Groq's free tier works). Everything paid is an optional upgrade.
- **Trustworthy by design.** Never invents metrics; fails honestly on blocked sources. Report-grade output you can hand to clients.
- **White-label ready.** Branding lives in `public/` (logo, palette tokens in `styles.css`) and the `REPORT_BRAND` string. Rebrand in minutes.
- **One chat box, no training.** Staff type plain English; a tool dropdown is there for power users.
- **Deploy anywhere Node 18.17+ runs.** Dockerfile + Render blueprint included.
- **Cost control.** Swap LLM providers in one line; run a local model (Ollama) for near-zero marginal cost per report.

| Tier | What you pay | What you get |
|---|---|---|
| **Free** | 1 LLM key (Groq free tier) | Chat, keyword research, audit (crawler + free Lighthouse), cannibalization |
| **+ Tavily** | `TAVILY_API_KEY` | Reliable Briefs / Competitors / Ranks / AI-Overview with no CAPTCHA and no browser |
| **+ Google** | Free Google API key + OAuth | Core Web Vitals (field data), Search Console + GA4 Intelligence reports |
| **+ SEOptimer** | `SEOPTIMER_API_KEY` (credits) | Real graded audits, backlink profiles, keyword rankings with volume/traffic; powers the head-to-head and full proposal |
| **+ Keyed SERP** | SerpApi / DataForSEO | Guaranteed, geo-targeted Google SERPs incl. the real AI-Overview sources block |

---

## 14. Design guarantees (the invariants)

- **The LLM never produces a metric.** It chats, routes, clusters, and narrates measured facts — nothing more. Every prompt says so explicitly.
- **Deterministic where it matters.** Audit prioritization, whole-site counts, the cannibalization clustering, the AI-Overview comparison matrix, and the proposal's 90-day roadmap are pure algorithms.
- **Honest failure over fake data.** Blocked SERP, timed-out crawl, or missing key → a plain-language note (often with a real fallback), never invented numbers.
- **One schema, generic UI.** Add a capability by adding a service that returns `Report` blocks — the frontend already knows how to draw them.
- **Config-driven.** All behaviour flexes through env and the single `config` object; swapping a provider never touches business logic.

---

## 15. Roadmap hooks already wired

- `SERP_PROVIDER=tavily` — now the recommended default source for all SERP-backed tools.
- `KEYWORDS_PROVIDER=dataforseo` — real search volume / difficulty / CPC.
- `SERP_PROVIDER=serpapi|dataforseo` — Google-accurate, geo-targeted SERPs incl. the real AI-Overview block.
- Approval queue + writer handoff for briefs (briefs currently end at "awaiting human approval").
- SEOptimer → DataForSEO swap behind the same adapter shape.
- Candidate ports: E-E-A-T scoring, content research, an SEO dashboard, a content editor / draft comparator.

---

*S.A.G.E — real SEO work on real data. The AI talks and routes; the tools measure.*
