#!/usr/bin/env python3
"""
Rebuild the day-5 build-status report: a self-contained HTML file and a 3-page PDF.

    python3 reports/build-report.py

Why a script rather than a committed artefact: the distributable HTML carries the
two typefaces inlined as base64 (~340 KB of font data), and a blob that large,
regenerated whenever the report changes, does not belong in git history. The source
HTML and this script do; everything else is derived.

Needs: network access on first run (Google Fonts), and Google Chrome for the PDF.
Outputs, both git-ignored:
    reports/out/AVO-Build-Status-Day5.html   self-contained, renders offline
    reports/out/AVO-Build-Status-Day5.pdf    3 pages, A4
"""
import base64
import io
import os
import re
import subprocess
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'AVO-Build-Status-Day5.source.html')
OUT_DIR = os.path.join(HERE, 'out')
OUT_HTML = os.path.join(OUT_DIR, 'AVO-Build-Status-Day5.html')
OUT_PDF = os.path.join(OUT_DIR, 'AVO-Build-Status-Day5.pdf')
CACHE = os.path.join(OUT_DIR, '.fonts-inline.css')

CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
UA = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                    'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'}


def inlined_fonts(css_url):
    """Fetch the Google Fonts CSS and return it with each woff2 inlined as a data URI.

    Latin subsets only. The report is English, and pulling every subset would
    quadruple the file for glyphs it never sets.
    """
    if os.path.exists(CACHE):
        return io.open(CACHE, encoding='utf-8').read()

    css = urllib.request.urlopen(
        urllib.request.Request(css_url, headers=UA), timeout=60).read().decode('utf-8')

    kept = []
    for block in re.findall(r'@font-face\s*\{[^}]+\}', css):
        rng = re.search(r'unicode-range:\s*([^;]+);', block)
        if not rng or 'U+0000' not in rng.group(1):
            continue  # not the latin subset
        url = re.search(r'url\((https://[^)]+\.woff2)\)', block)
        if not url:
            continue
        data = urllib.request.urlopen(
            urllib.request.Request(url.group(1), headers=UA), timeout=60).read()
        kept.append(block.replace(
            url.group(1), 'data:font/woff2;base64,' + base64.b64encode(data).decode()))

    if not kept:
        sys.exit('no latin @font-face blocks found — has the Google Fonts CSS changed shape?')

    out = ('/* Fonts inlined so the report renders identically with no network.\n'
           '   Latin subsets only. Regenerate with reports/build-report.py. */\n'
           + '\n'.join(kept) + '\n')
    io.open(CACHE, 'w', encoding='utf-8').write(out)
    return out


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    html = io.open(SRC, encoding='utf-8').read()

    link = re.search(r'<link rel="stylesheet" href="(https://fonts\.googleapis[^"]+)"[^>]*>', html)
    if not link:
        sys.exit('no Google Fonts <link> in the source — nothing to inline')

    html = html.replace(link.group(0), '<style>\n' + inlined_fonts(link.group(1)) + '</style>')
    assert 'fonts.googleapis' not in html, 'a network font reference survived the swap'
    io.open(OUT_HTML, 'w', encoding='utf-8').write(html)
    print('html : %5.0f KB  %s' % (len(html) / 1024, os.path.relpath(OUT_HTML, HERE)))

    if not os.path.exists(CHROME):
        print('pdf  : skipped — Chrome not found at %s' % CHROME)
        return

    if os.path.exists(OUT_PDF):
        os.remove(OUT_PDF)
    subprocess.run([
        CHROME, '--headless=new', '--disable-gpu', '--no-sandbox',
        '--virtual-time-budget=25000',
        # Without this Chrome stamps a date, the title, the source URL and "1/3"
        # onto every page, and the report reads as a browser printout.
        '--no-pdf-header-footer',
        '--print-to-pdf=' + OUT_PDF,
        'file://' + OUT_HTML,
        # not capture_output=: this repo's default python is 3.6, which predates it
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=240)

    if not os.path.exists(OUT_PDF):
        sys.exit('Chrome produced no PDF')

    pdf = io.open(OUT_PDF, 'rb').read()
    pages = len(re.findall(rb'/Type\s*/Page[^s]', pdf))
    print('pdf  : %5.0f KB  %s  (%d pages)'
          % (len(pdf) / 1024, os.path.relpath(OUT_PDF, HERE), pages))
    # Chrome names its merged font subset generically, so the PDF's font table is
    # NOT evidence about which typefaces rendered — it reported Times-Roman on a
    # file that was setting Fraunces correctly. Check page count here; check the
    # faces by looking at the thing.
    if pages > 3:
        print('WARNING: %d pages — the report is specified at three or fewer.' % pages)


if __name__ == '__main__':
    main()
