# N.O.V.A — Business Development Agent

NOVA is the business-development counterpart to **SAGE**. It shares SAGE's design
language, LLM abstraction, auth pattern and Report/Block schema, but runs as its
own app on its own port (default **8788**) with its own data stores.

> **AI-role principle (inherited from SAGE):** the LLM only **chats**, **routes**
> commands, and **writes copy** (outreach / follow-ups / replies / care emails).
> Every *fact* — company details, SEO scores, social signals, reply contents,
> pipeline state — is **scraped or measured**, never invented.

## Run

```bash
cp .env.example .env      # Windows: copy .env.example .env
# set LLM_API_KEY (that alone activates the agent)
npm install
npm start                 # http://localhost:8788   (login: admin / change-me)
```

## What works with ZERO third-party accounts (just an LLM key)

These are demo-ready immediately:

| Feature | Needs |
|---|---|
| **Research Prospect** (scrape + brief + Lighthouse hook) | LLM key only (PageSpeed is free/keyless; a key just raises the rate limit) |
| **Run Audit** (Lighthouse + shallow crawl) | Nothing (free Google API) |
| **Generate Outreach** (3 variants) | LLM key |
| **Manage Pipeline** (sidebar, stages, stale, next actions) | Nothing |
| **Follow-up Sequences** (draft + queue, approval cards) | LLM key to draft; SMTP only to *send* |
| **Client Care** (draft birthday/anniversary/check-in) | LLM key to draft; SMTP only to *send* |
| **Full Prospect Report** (HTML) | Nothing (PDF needs Python+Playwright) |

## What needs extra setup

| Feature | Setup |
|---|---|
| **Sending any email** (outreach, follow-ups, confirmations, alerts) | `SMTP_*` |
| **Parse Replies** | `IMAP_*` (+ SMTP for HIGH-urgency team alerts) |
| **Meeting confirmations / invites** | `SMTP_*`; real calendar events optional via the Google OAuth refresh flow (`GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` + `GOOGLE_REFRESH_TOKEN`) |
| **Full Prospect Report → PDF** | Python 3 + `pip install -r python/requirements.txt` + `playwright install chromium` |
| **Campaigns → bulk send** | `SMTP_*` (import/templates/status management work without it) |

## Campaigns (bulk outreach)

A separate top-nav tab from the chat. Flow:

1. **Create a campaign** and **upload a contact file** — CSV with an `email,name,company`
   header, or a plain list of emails (one per line). NOVA validates and de-dupes.
2. **Configure the four emails** — *first*, *thank-you*, *follow-up*, *closing* —
   with `{{firstName}}`, `{{company}}`, `{{agency}}`, `{{sender}}` placeholders
   filled from each contact's real data on send (no LLM invention on the send
   path). Optional **Draft with AI** writes a starter template you then edit.
3. **Bulk send** a chosen stage to eligible contacts (those who haven't received
   it yet). Every send confirms first and reports sent/failed/skipped.

The **Contacts** tab manages every imported contact's status (New → First sent →
Thanked → Followed up → Replied → Closed / Failed), with search and per-row edits.
All state lives in `data/campaigns/index.json`.

## Technical risks to know before deploying

- **IMAP polling vs provider rate limits.** `IMAP_POLL_MINUTES=15` is safe for
  Gmail/Outlook. Going below ~5 min risks throttling or temporary lockouts on
  some providers. The poller is a `setInterval` — it does **not** survive a
  process restart mid-interval (it simply restarts the clock on boot).
- **Google Calendar OAuth.** Use the **refresh-token flow** (`GOOGLE_CLIENT_ID` +
  `GOOGLE_CLIENT_SECRET` + `GOOGLE_REFRESH_TOKEN`): NOVA mints a fresh access token
  before each Calendar call and caches it in-memory until just before expiry, so
  it never goes stale on a long-running deploy (`lib/googleAuth.ts`). A single
  static `GOOGLE_CALENDAR_TOKEN` still works as a legacy fallback but expires in
  ~1h. With neither set, slots come purely from the local booked-slot store.
- **node-cron persistence.** The follow-up and client-care crons run **in-process**.
  If NOVA is not running at 9am/8am, that day's check is missed (there's no
  catch-up). Due items are still surfaced on demand ("follow up …", "client care")
  and re-evaluated on the next run, so nothing is lost — it just isn't *pushed*.
- **Social scraping** (LinkedIn/Instagram) is best-effort. Both gate public data;
  NOVA reports `could not retrieve — blocked` honestly rather than faking numbers.

## Assumptions made

- **"Run Audit (calls SAGE audit internally)"** — because NOVA is a separate app
  on a separate port, it runs its **own lightweight audit** built from SAGE's
  shared building blocks (real Google Lighthouse + a shallow crawl for
  missing/duplicate title & meta), rather than reaching into SAGE's process. For
  the full SAGE crawl, point it at SAGE's own `/api/report`.
- **Bulk research** is capped at 10 domains per run.
- **Reply "send"** surfaces the drafted response for approval; wiring the actual
  send reuses the same SMTP transport (endpoint stub ready in `services/reply.ts`).
- **Timezone math** for meeting slots uses `Intl` (no date library); slots are
  stored as UTC ISO and displayed in `MEETING_TIMEZONE`.

See `.env.example` for every variable, grouped and commented.
