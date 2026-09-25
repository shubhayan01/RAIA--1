# S.C.R.I.B.E — Content Automation Agent

SCRIBE is the **content-automation** sibling to **SAGE** (SEO) and **NOVA**
(business development). Same architecture, same chat-first UI,
its own violet identity — and the same firm rule:

> **The AI only chats, routes commands, and writes/structures content.** All
> research is real: live SERP data, competitor pages fetched and measured,
> fact-checks resolved against live search. SCRIBE never invents rankings, word
> counts or verdicts.

Runs on its own port (**8789**) so it sits alongside SAGE (8787) and NOVA (8788).

## What it does

Give SCRIBE a **keyword**, your **site URL**, and any **extra brief**, and it runs
the whole content workflow — or any single step on its own:

| Tool | What it does | Real data source |
|------|--------------|------------------|
| **Keyword Research** | Top-ranking blogs, **measured** average/median word count, related searches, People-Also-Ask | Live SERP + page fetches |
| **Competitor Analysis** | Deep scrape of the top pages: word count, heading outline, FAQ/table/list, byline | The live pages |
| **Content Gaps** | Openings competitors miss / your site is positioned to win | Competitor outlines vs your site |
| **Keyword Clusters** | Similar keywords grouped into blog topics, weighted to your site | Real related searches + PAA |
| **Brand Voice** | Extracts your voice, tone, vocabulary & audience | Your site's real copy |
| **Gather Evidence** | Collects + **verifies** real stats (number confirmed on the source page), named quotes, internal case studies & a contrarian source **before** writing. Halts on `LOW_EVIDENCE` | Live SERP + page fetches |
| **Write Draft** | Full article in your brand voice, constrained to cite **only** the EvidencePack | LLM over verified evidence |
| **Publish Gate** | Autonomous verify-and-fix loop: audits, scoped-fixes blocking violations, re-audits → **READY** or **NEEDS_HUMAN** with the exact unresolved items | Deterministic checks + evidence |
| **Fact-Check** | Extracts claims → verifies each against live search → optionally corrects | Live search per claim |
| **AI-Pattern Scan** | Burstiness, AI-tell phrases, vocabulary diversity, **genericness** + humanize tips | Deterministic text signals |
| **E-E-A-T Score** | Scores Experience/Expertise/Authoritativeness/Trust against **your** parameters | Detected signals + your rubric |
| **Self-Audit** | 2nd-pass checklist: unattributed stats, placeholders, em dashes, fabricated case study, genericness, POV | Measured + one LLM pass |
| **Full Workflow** | research → … → **evidence (hard gate)** → write → **gate** → READY / NEEDS_HUMAN | Everything |

### Zero-hallucination flow (evidence-first)

Nothing enters a draft that wasn't verified **before** writing, and nothing ships
that fails verification **after** writing without a bounded autonomous fix loop
resolving it first:

1. **`evidence`** gathers real material and verifies each statistic's number is
   literally present on its source page (not hallucinated from a search title).
   Fewer than 3 verified stats → `LOW_EVIDENCE`, and the pipeline **stops before
   the writer runs**. This is the *honest-failure* principle extended from
   research *availability* to research *quality*.
2. **`write`** may cite **only** the EvidencePack, tagging each cited fact `[E#]`
   (stripped before display, kept so the gate can verify sourcing).
3. **`gate`** audits the draft, hands each blocking violation to a **scoped** fix
   (only the flagged sentences), and re-audits, up to 3 iterations. Clean →
   **READY** (auto-publishable). Otherwise → **NEEDS_HUMAN** with the exact items.
   Verification is evidence-anchored (a number not in the pack is caught every
   time), so it is deterministic and near-instant.

**Internal case studies** are the one input a human provides — entered **once**
per engagement as a JSON file under `data/case-studies/`, then reused across every
matching draft. See `data/case-studies/_example.json`. The writer never invents a
case study; if none matches, that section is simply omitted.

Run the deterministic acceptance tests with `npm test`.

Every feature is available **standalone** (its own tool + `POST /api/<tool>`) and
as part of the orchestrated **workflow**. The review tools (fact-check, AI-scan,
E-E-A-T) work on a saved draft **or** on content you paste in.

## Quick start

```bash
cd scribe
npm install
cp .env.example .env      # Windows: copy .env.example .env
# set LLM_API_KEY and TAVILY_API_KEY in .env
npm run dev               # or: npm start
```

Open http://localhost:8789. Default login `admin` / `admin` (change in `.env`).

### The only things you need
- **`LLM_API_KEY`** — chat, routing, writing (Groq/OpenAI/Anthropic/Ollama/any OpenAI-compatible).
- **A SERP source** — `SERP_PROVIDER=tavily` + `TAVILY_API_KEY` is recommended
  (reliable, no CAPTCHA). `SERP_PROVIDER=google` uses the free Playwright browser
  SERP instead. Everything degrades **honestly** when a source is missing —
  research says exactly why it's empty rather than showing fake data.

## Architecture (shared with SAGE / NOVA)

```
config.ts            env-driven config (port, LLM, SERP, content knobs)
server.ts            Express bootstrap + auth gating
routes.ts            /api/ask chat dispatch + per-feature endpoints + library
auth.ts              dependency-free signed-cookie sessions
llm/                 provider abstraction (openai-compatible + anthropic)
lib/
  report.ts          normalized Block/Report schema the UI renders generically
  project.ts         content-library store (one JSON per keyword project)
  http.ts html.ts jsonStore.ts concurrency.ts
sources/
  serp.ts            SERP adapter (tavily/google/serpapi/dataforseo/scrape)
  content.ts         page fetch + structural content analysis
  psi.ts webscrape.ts
services/
  converse.ts        chat + deterministic command routing
  research.ts competitors.ts gap.ts keywords.ts brand.ts
  evidence.ts        pre-write evidence collection + verification (hard gate)
  write.ts factcheck.ts aicheck.ts eeat.ts selfaudit.ts
  gate.ts            autonomous verify-and-fix loop (READY / NEEDS_HUMAN)
  workflow.ts        evidence-first orchestration
lib/glossary.ts      locked canonical terms + deterministic drift check
public/              chat UI (index.html, styles.css, app.js, login.html)
python/google_serp.py   free browser SERP fallback (Playwright)
data/projects/       git-ignored JSON stores
data/case-studies/   agency-owned case studies (human-entered once, reused)
test/pipeline.test.ts  deterministic acceptance tests (npm test)
```

State lives in **content projects** keyed by keyword — the left sidebar is your
**Content Library**, and every tool reads/writes the same project so the workflow
and the standalone tools share results.

## The AI-role principle (why this is trustworthy)

- **Real, measured:** SERP rankings, word counts, competitor structure, and
  fact-check sources are fetched live — never generated.
- **Grounded writing:** the draft is written from the real research and is
  explicitly forbidden from inventing precise statistics; anything factual is
  written to be verifiable, then checked.
- **Honest failure:** if search is blocked or a key is missing, SCRIBE says so
  and stops — it does not paper over a gap with plausible-looking fake data.
