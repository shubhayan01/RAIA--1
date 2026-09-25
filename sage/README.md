# S.A.G.E — Autonomous SEO Agent

An SEO agent for digital marketing agencies. One chat interface, eight real capabilities:

1. **Keyword Research & Clustering** — live Google Autocomplete + People-Also-Ask → dedupe → intent-classify → cluster → prioritize → map to pages → competitor gaps
2. **SEO Audit & Issue Detection** — full site crawl + Google Lighthouse/PageSpeed (Performance, SEO, Accessibility, Best-Practices + Core Web Vitals) → detect → group → prioritize → tasks
3. **Content Brief** — keyword → SERP → competitors → common/missing topics → structure → brief → (human approval) → writer
4. **AI Overview Content Gap** — find the pages Google's AI Overview cites → scrape structural signals → compare to your article → gap report (GEO/AEO)
5. **Rank Tracker** — track a domain's real Google position for a list of keywords, with striking-distance flags
6. **Keyword Cannibalization** — crawl the site → find pages competing for the same query (title/H1 overlap) → consolidate/canonical/differentiate
7. **SEO Intelligence & Reporting** — one agent over GSC + GA4 → performance, detection, opportunities, monthly report
8. **Competitive Intelligence** — competitor discovery, page/topic analysis, content + keyword gaps, opportunity list

Built to lean on **free data sources** and keep paid dependencies (Ahrefs/SEMrush) optional.

### Login

S.A.G.E ships with a simple built-in login (a signed session cookie, no database). Set your credentials in `.env`:

```
AUTH_ENABLED=true          # set false to run open (e.g. behind your own SSO)
AUTH_USERNAME=admin
AUTH_PASSWORD=change-me
AUTH_SECRET=some-long-random-string   # signs the session cookie — change it
AUTH_TTL_HOURS=168         # session lifetime (default 7 days)
```

Unset, it defaults to `admin` / `admin` and logs a warning — fine for local dev, change it before deploying. The sign-in page is at `/login`; the header shows the logged-in user and a **Log out** button.

### How you talk to it

Just chat. Say "hi", ask **"What can you do?"** (there's a button on the start screen), or give a command in plain English — S.A.G.E figures out which tool to run:

- "audit example.com" · "research keywords for running shoes" · "content brief for best crm software"
- "ai overview gap for best crm software vs https://yoursite.com/crm" · "pull the SEO report" · "competitors for site.com"

**The AI is only used to (a) hold the conversation and (b) route your request to the right tool.** All the actual SEO work runs live on real data (crawler, Google Autocomplete, SERP, AI Overview sources, Search Console, GA4). The LLM never invents metrics — it only structures and explains what the tools measured. Prefer a specific tool? Pick it from the **tool dropdown** in the composer (Auto = let S.A.G.E decide).

---

## Deploy to Render

This repo ships a **Dockerfile** (Node + Python + Playwright/Chromium) and a **`render.yaml`** blueprint.

1. Push to GitHub, then in [Render](https://render.com) → **New → Blueprint** → pick this repo (it reads `render.yaml`).
2. Set the secret env vars in the dashboard: `LLM_API_KEY`, `AUTH_USERNAME`, `AUTH_PASSWORD` (Render auto-generates `AUTH_SECRET`).
3. Deploy. The app listens on Render's `$PORT`; health check is `/login`.

Notes:
- **Free plan** runs chat / keywords / audit fine. Chromium (the browser SERP) is memory-hungry and Render's datacenter IP is usually CAPTCHA'd by Google — for reliable **Briefs / Competitors / Ranks / AI Overview** on a server, set `SERP_PROVIDER=serpapi` + `SERP_API_KEY`, or upgrade the plan and add a residential `SERP_PROXY`.
- Prefer plain Docker anywhere else: `docker build -t sage . && docker run -p 8787:8787 --env-file .env sage`.

## Quick start

```bash
npm install
cp .env.example .env      # then add your LLM key (Windows: copy .env.example .env)
npm run dev               # http://localhost:8787
```

The **only** thing required to activate real intelligence is an LLM key. Everything
else has a free default or degrades gracefully with a clear message in the UI.

---

## The one setting that matters: the LLM

Swap providers by changing `LLM_PROVIDER` in `.env`. Nothing else in the code changes.

| Provider    | `LLM_PROVIDER` | Example `LLM_MODEL`            | Key |
|-------------|----------------|-------------------------------|-----|
| Groq (default) | `groq`      | `openai/gpt-oss-120b`         | https://console.groq.com/keys |
| OpenAI      | `openai`       | `gpt-4o-mini`                 | https://platform.openai.com |
| Anthropic   | `anthropic`    | `claude-sonnet-4-5`           | https://console.anthropic.com |
| Ollama (local) | `ollama`    | `llama3.1`                    | none — run `ollama serve` |

Any other OpenAI-compatible endpoint (OpenRouter, Together, vLLM, LM Studio) works too:
set `LLM_PROVIDER` to any name and point `LLM_BASE_URL` at it.

---

## What runs with zero paid APIs

| Capability | Free data source | Optional upgrade |
|---|---|---|
| **Audit** | Built-in crawler (cheerio) | `PAGESPEED_API_KEY` (free) for Core Web Vitals · `SEOPTIMER_API_KEY` for graded scores, backlinks & rankings |
| **Keywords** | Google Autocomplete + LLM | `KEYWORDS_PROVIDER=dataforseo` for volume/KD/CPC |
| **Briefs** | Live Google via headless Chromium (Playwright) | `SERP_PROVIDER=serpapi` for a keyed, guaranteed SERP |
| **AI Overview Gap** | Live Google (browser) + page scraping | `SERP_PROVIDER=serpapi` **or** `SERPER_API_KEY` for keyed AI Overview |
| **Rank Tracker** | Live Google positions (browser) | `SEOPTIMER_API_KEY` for real positions + volume/traffic (no CAPTCHA) · `SERP_PROVIDER=serpapi/dataforseo` for keyed ranks |
| **Cannibalization** | Built-in crawler (title/H1 overlap) | Search Console for query-level confirmation |
| **Competitive** | Live Google via browser + LLM | same as briefs |

### SEOptimer (real data across the toolset)

Set `SEOPTIMER_API_KEY` (from the SEOptimer dashboard → API panel) and S.A.G.E uses it wherever it has real, relevant data. One call returns category grades (SEO/GEO/Links/Performance/Social/Usability/Security), ~90 checks, a prioritized recommendation list, the domain's actual keyword rankings **with search volume and estimated traffic**, AI-Overview rankings, its backlink profile, GEO/AI-readiness signals, and detected technologies — with no CAPTCHA risk. Reports are cached per-URL (15 min) and shared across capabilities, so hitting the same domain from several tools costs one credit. The LLM never touches this data; it's surfaced as-is.

| Capability | What SEOptimer adds |
|---|---|
| **Audit** | Graded scorecard, backlink profile, top rankings, prioritized recommendations, tech stack |
| **Rank Tracker** | Real positions + search volume + estimated traffic (no CAPTCHA); discovery of what a domain ranks for |
| **Competitive** | Head-to-head grades / authority / traffic and real keyword gaps (competitor keywords with volume) |
| **Keywords** | A competitor's real ranking keywords with search volume (replaces the SERP-overlap guess) |
| **AI Overview** | Real GEO / AI-readiness page audit + the domain's AI-Overview rankings and AI-traffic estimate |
| **Intelligence** | A clearly-labeled third-party snapshot before Search Console / GA4 are connected |

**Not wired (by design):** **Briefs** and **Cannibalization** need query-level SERP results and per-page ranking URLs respectively — data SEOptimer's URL-audit doesn't return — so they stay on their existing real sources rather than show a forced fit. Roadmap: swap SEOptimer for DataForSEO later behind the same adapter without changing the services.

> **SERP source.** By default S.A.G.E fetches **live Google** with a real Chromium browser (free, no API — see `python/README.md` for the one-time `pip install`/`playwright install`). Google may challenge automated traffic: run headful (`SERP_HEADLESS=0`) and/or a residential `SERP_PROXY`, or switch to a keyed provider (`SERP_PROVIDER=serpapi`) for guaranteed **SERP reports**. When a SERP call is blocked, S.A.G.E **says so** and never invents results.
| **Intelligence** | Google Search Console + GA4 (both free) | — |

## Google data setup (for Intelligence — all free)

1. **PageSpeed key** (Core Web Vitals): create an API key in Google Cloud, put it in `PAGESPEED_API_KEY`.
2. **Search Console + GA4**: use an OAuth access token.
   - Fastest: [OAuth Playground](https://developers.google.com/oauthplayground) → authorize
     `https://www.googleapis.com/auth/webmasters.readonly` and
     `https://www.googleapis.com/auth/analytics.readonly` → paste the token into `GOOGLE_ACCESS_TOKEN`.
   - For long-running use, set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN`
     and S.A.G.E mints access tokens automatically.
   - Set `GSC_SITE_URL` (e.g. `sc-domain:clientsite.com`) and `GA4_PROPERTY_ID`.

---

## Architecture

```
src/
  config.ts            env + settings
  llm/                 provider abstraction (groq/openai/anthropic/ollama) — swap in one line
  lib/                 http (redirect-aware fetch), html parsing, concurrency pool, report schema
  sources/             autocomplete, serp (adapter), psi (core web vitals), google (gsc/ga4)
  services/            keywords, audit, brief, aioverview, intelligence, competitive (the 6 capabilities)
                       + converse (chat replies + command routing — the only place the LLM "talks")
  routes.ts            /api/ask dispatch (chat-first) + /api/status
  server.ts            express + static UI
public/                the S.A.G.E chat UI (index.html, styles.css, app.js)
```

Every capability returns a normalized `Report` (typed blocks). The frontend renders
blocks generically, so adding output never touches the UI.

### API

```
POST /api/ask   { "mode": "audit", "text": "https://example.com" }
GET  /api/status
```

`mode` ∈ `chat | keywords | audit | briefs | aio | ranks | cannibal | intel | competitors`.
`chat` (the default) routes to conversation or the right tool automatically. The other modes force a specific tool.

---

## Selling / white-labeling

- All branding lives in `public/` (logo SVG in `index.html`, name string, palette tokens in `styles.css`).
- No telemetry, no phone-home. Self-hosted. Bring your own keys.
- `npm run typecheck` for CI. Deploy anywhere Node 18+ runs.

## Roadmap hooks already wired

- `KEYWORDS_PROVIDER=dataforseo` — real search volume / difficulty / CPC
- `SERP_PROVIDER=serpapi|dataforseo` — Google-accurate SERPs
- Approval queue + writer handoff for briefs (currently returns brief for human approval)
