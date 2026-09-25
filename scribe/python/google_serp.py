#!/usr/bin/env python
"""
Free, real-time Google SERP fetcher for S.A.G.E — no paid API.

Drives a real Chromium browser via Playwright with light anti-detection so a
normal amount of agency use doesn't trip Google's bot defenses. Prints ONE JSON
object to stdout; all logs/errors go to stderr so Node can parse cleanly.

Usage:  python google_serp.py "<query>" [count]
Env:    SERP_HEADLESS=1|0  SERP_GL=us  SERP_HL=en  SERP_PROFILE_DIR=...  SERP_PROXY=...

Output JSON:
  { "query", "results":[{position,title,url,snippet}], "paa":[...],
    "related":[...], "aiOverview":[urls], "provider":"google-browser",
    "captcha": false, "error": null }
"""
import sys, os, json, time, random, tempfile

def out(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False))
    sys.stdout.flush()

def err(msg):
    sys.stderr.write(str(msg) + "\n")
    sys.stderr.flush()

def fail(message, captcha=False):
    out({"query": QUERY, "results": [], "paa": [], "related": [],
         "aiOverview": [], "provider": "google-browser", "captcha": captcha, "error": message})
    sys.exit(0)

QUERY = sys.argv[1] if len(sys.argv) > 1 else ""
COUNT = min(int(sys.argv[2]) if len(sys.argv) > 2 else 10, 30)
GL = os.environ.get("SERP_GL", "us")
HL = os.environ.get("SERP_HL", "en")
HEADLESS = os.environ.get("SERP_HEADLESS", "1") not in ("0", "false", "False")
PROXY = os.environ.get("SERP_PROXY", "").strip()
PROFILE_DIR = os.environ.get("SERP_PROFILE_DIR") or os.path.join(tempfile.gettempdir(), "sage-serp-profile")

if not QUERY:
    fail("no query provided")

try:
    from playwright.sync_api import sync_playwright
except Exception as e:
    fail("playwright not installed — run: pip install playwright && python -m playwright install chromium")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")

STEALTH = """
Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
Object.defineProperty(navigator, 'languages', {get: () => ['en-US','en']});
Object.defineProperty(navigator, 'plugins', {get: () => [1,2,3,4,5]});
window.chrome = { runtime: {} };
"""

def human_pause(a=0.4, b=1.1):
    time.sleep(random.uniform(a, b))

def extract(page):
    # Organic results — resilient: every h3 that sits inside a real result link.
    results = []
    seen = set()
    anchors = page.query_selector_all("#search a:has(h3), #rso a:has(h3)")
    for a in anchors:
        try:
            href = a.get_attribute("href") or ""
            if not href.startswith("http"):
                continue
            if any(x in href for x in ("google.com/", "/search?", "webcache.", "accounts.google")):
                continue
            if href in seen:
                continue
            h3 = a.query_selector("h3")
            title = (h3.inner_text() if h3 else "").strip()
            if not title:
                continue
            # snippet: nearest result container's snippet node
            snippet = ""
            try:
                container = a.evaluate_handle(
                    "el => el.closest('div.g, div.tF2Cxc, div[data-hveid]') || el.parentElement")
                sn = container.as_element().query_selector(".VwiC3b, div[data-sncf], .lyLwlc, .lEBKkf")
                if sn:
                    snippet = sn.inner_text().strip().replace("\n", " ")
            except Exception:
                pass
            seen.add(href)
            results.append({"position": len(results) + 1, "title": title,
                            "url": href, "snippet": snippet[:400]})
            if len(results) >= COUNT:
                break
        except Exception:
            continue

    # People Also Ask
    paa = []
    try:
        for q in page.query_selector_all("div.related-question-pair, div[jsname] [role='button'] span"):
            t = (q.inner_text() or "").strip()
            if t.endswith("?") and t not in paa:
                paa.append(t)
    except Exception:
        pass

    # Related searches
    related = []
    try:
        for r in page.query_selector_all("a[data-xbtq], #bres a, div[data-abe] a"):
            t = (r.inner_text() or "").strip()
            if t and len(t) < 80 and t not in related:
                related.append(t)
    except Exception:
        pass

    # AI Overview source links (best-effort; only present when Google shows it)
    ai = []
    try:
        blocks = page.query_selector_all(
            "div[data-attrid*='overview'], div[aria-label*='AI Overview'], div[jsname][data-mcpr]")
        for blk in blocks:
            for a in blk.query_selector_all("a[href^='http']"):
                href = a.get_attribute("href") or ""
                if href.startswith("http") and "google.com" not in href and href not in ai:
                    ai.append(href)
    except Exception:
        pass

    return results, paa[:12], related[:12], ai[:10]

def run():
    with sync_playwright() as p:
        launch = {"headless": HEADLESS, "args": [
            "--disable-blink-features=AutomationControlled",
            "--no-sandbox", "--disable-dev-shm-usage",
        ]}
        if PROXY:
            launch["proxy"] = {"server": PROXY}
        ctx = p.chromium.launch_persistent_context(
            PROFILE_DIR, user_agent=UA, locale="en-US",
            timezone_id="America/New_York", viewport={"width": 1280, "height": 800}, **launch)
        try:
            # bypass EU consent interstitial
            ctx.add_cookies([
                {"name": "CONSENT", "value": "YES+", "domain": ".google.com", "path": "/"},
                {"name": "SOCS", "value": "CAI", "domain": ".google.com", "path": "/"},
            ])
            page = ctx.new_page()
            page.add_init_script(STEALTH)

            # Human flow: land on the homepage, accept consent, type the query.
            page.goto(f"https://www.google.com/?hl={HL}&gl={GL}", wait_until="domcontentloaded", timeout=30000)
            human_pause(0.5, 1.2)
            try:
                for sel in ("button:has-text('Accept all')", "button:has-text('I agree')",
                            "#L2AGLb", "button[aria-label*='Accept']"):
                    btn = page.query_selector(sel)
                    if btn:
                        btn.click(); human_pause(0.3, 0.8); break
            except Exception:
                pass
            try:
                box = page.wait_for_selector("textarea[name='q'], input[name='q']", timeout=8000)
                box.click()
                for ch in QUERY:
                    page.keyboard.type(ch)
                    time.sleep(random.uniform(0.02, 0.12))
                human_pause(0.2, 0.6)
                page.keyboard.press("Enter")
                page.wait_for_load_state("domcontentloaded", timeout=20000)
            except Exception:
                # fallback to direct search URL
                page.goto(f"https://www.google.com/search?q={QUERY}&hl={HL}&gl={GL}",
                          wait_until="domcontentloaded", timeout=30000)
            human_pause()

            cur = page.url.lower()
            body = ""
            try:
                body = page.inner_text("body")[:2000].lower()
            except Exception:
                pass
            if "sorry/index" in cur or "unusual traffic" in body or "not a robot" in body or "captcha" in body:
                return fail("google served a CAPTCHA / bot challenge", captcha=True)

            try:
                page.wait_for_selector("#search, #rso, #main", timeout=8000)
            except Exception:
                pass
            human_pause(0.2, 0.6)

            results, paa, related, ai = extract(page)
            out({"query": QUERY, "results": results, "paa": paa, "related": related,
                 "aiOverview": ai, "provider": "google-browser", "captcha": False, "error": None})
        finally:
            ctx.close()

try:
    run()
except Exception as e:
    err(e)
    fail("browser error: " + str(e)[:200])
