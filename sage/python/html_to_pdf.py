#!/usr/bin/env python
"""
HTML -> PDF for S.A.G.E client reports, using the same Playwright/Chromium the
SERP fetcher already relies on (no extra dependency).

Usage:  python html_to_pdf.py <input.html> <output.pdf>
Reads the HTML file, renders it in headless Chromium, and writes an A4 PDF with
backgrounds printed. All logs go to stderr; on success prints "OK" to stdout.
"""
import sys, os

def err(msg):
    sys.stderr.write(str(msg) + "\n"); sys.stderr.flush()

if len(sys.argv) < 3:
    err("usage: html_to_pdf.py <input.html> <output.pdf>"); sys.exit(2)

IN_PATH, OUT_PATH = sys.argv[1], sys.argv[2]

try:
    from playwright.sync_api import sync_playwright
except Exception as e:  # pragma: no cover
    err("Playwright not installed: %s" % e); sys.exit(3)

try:
    with open(IN_PATH, "r", encoding="utf-8") as f:
        html = f.read()
except Exception as e:
    err("cannot read input: %s" % e); sys.exit(4)

try:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        # emulate screen so gradients/backgrounds render as designed
        page.emulate_media(media="print")
        page.set_content(html, wait_until="networkidle")
        page.pdf(
            path=OUT_PATH,
            format="A4",
            print_background=True,
            margin={"top": "14mm", "bottom": "14mm", "left": "0mm", "right": "0mm"},
            prefer_css_page_size=True,
        )
        browser.close()
    sys.stdout.write("OK"); sys.stdout.flush()
except Exception as e:
    err("pdf render failed: %s" % e); sys.exit(5)
