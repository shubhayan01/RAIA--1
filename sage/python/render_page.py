#!/usr/bin/env python
"""
JavaScript page renderer for S.A.G.E — returns the FULLY RENDERED HTML of a URL.

Drives a real Chromium browser via Playwright (same engine as google_serp.py) so
the crawlers (audit / autolink / schema) can read JS-only SPA pages and pages that
serve a near-empty shell to plain HTTP clients. Prints the rendered HTML to stdout;
all logs/errors go to stderr so Node can consume stdout cleanly.

Usage:  python render_page.py "<url>"
Env:    SERP_HEADLESS=1|0   SERP_PROXY=...   CRAWL_UA=<user-agent>

Setup:  pip install -r python/requirements.txt  &&  playwright install chromium
"""
import sys, os

# Make stdout UTF-8 so non-ASCII page content never crashes the write (Windows).
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def err(msg):
    sys.stderr.write(str(msg) + "\n")
    sys.stderr.flush()


def main():
    url = sys.argv[1] if len(sys.argv) > 1 else ""
    if not url:
        err("no url")
        return

    headless = os.environ.get("SERP_HEADLESS", "1") != "0"
    proxy = os.environ.get("SERP_PROXY", "").strip()
    ua = os.environ.get("CRAWL_UA", "").strip() or (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    )

    try:
        from playwright.sync_api import sync_playwright
    except Exception as e:
        err("playwright not installed: %s" % e)
        return

    with sync_playwright() as p:
        launch = {
            "headless": headless,
            "args": [
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--disable-dev-shm-usage",
            ],
        }
        if proxy:
            launch["proxy"] = {"server": proxy}
        try:
            browser = p.chromium.launch(**launch)
        except Exception as e:
            err("chromium launch failed (run: playwright install chromium): %s" % e)
            return

        ctx = browser.new_context(
            user_agent=ua, locale="en-US", viewport={"width": 1280, "height": 900}
        )
        # Hide the most obvious automation signal.
        try:
            ctx.add_init_script(
                "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});"
            )
        except Exception:
            pass

        page = ctx.new_page()
        html = ""
        try:
            page.goto(url, wait_until="networkidle", timeout=40000)
        except Exception:
            # networkidle can time out on chatty pages; fall back to DOM-ready.
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=40000)
            except Exception as e:
                err("goto failed: %s" % e)
                browser.close()
                return
        try:
            page.wait_for_timeout(1200)  # let late hydration settle
        except Exception:
            pass
        try:
            html = page.content()
        except Exception as e:
            err("content read failed: %s" % e)
        browser.close()

        if html:
            sys.stdout.write(html)
            sys.stdout.flush()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        err(e)
