# Free Google SERP (browser)

`google_serp.py` fetches **live Google search results** with a real Chromium
browser (Playwright) — no paid API. Used by S.A.G.E when `SERP_PROVIDER=google`
(the default) for Briefs, Competitors, Rank Tracker and AI Overview.

## Setup (one time)

```bash
pip install -r python/requirements.txt
python -m playwright install chromium
```

## Avoiding bot challenges (important)

Google challenges traffic it thinks is automated. To keep results flowing:

- **Run headful:** set `SERP_HEADLESS=0` in `.env`. A visible browser is far less
  likely to be CAPTCHA'd than a headless one. (Default is headless.)
- **Use a residential IP.** Datacenter / VPN / cloud IPs get challenged fast. Set
  `SERP_PROXY=http://user:pass@host:port` to route through a residential proxy.
- **Don't hammer it.** S.A.G.E already throttles (low concurrency + human-like typing
  and delays) and reuses a browser profile so cookies build up like a real user.
- If Google still challenges you, S.A.G.E says so honestly and suggests
  `SERP_PROVIDER=serpapi` (a keyed provider) for guaranteed **SERP reports**.

## Test it directly

```bash
python python/google_serp.py "email marketing software" 8
```

Prints one JSON object: `results[]`, `paa[]`, `related[]`, `aiOverview[]`, plus
`captcha`/`error` when Google blocks the request.
