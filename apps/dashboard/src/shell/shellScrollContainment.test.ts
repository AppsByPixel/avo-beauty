// @vitest-environment jsdom

/**
 * A SHELL THAT SCROLLS AN INNER BOX MUST BE THE CONTAINING BLOCK FOR WHAT IT SCROLLS.
 *
 * Aftab, from production: "When you keep scrolling down on the dashboard page it
 * keeps on going down even when everything is gone."
 *
 * The merchant shell scrolls inside `main.dash__content`; `html` and `body` do
 * not clip. `main` had no `position`, so every absolutely positioned descendant
 * without a nearer positioned ancestor (146 `.avo-sr-only` chart alternatives
 * on the Overview) took the INITIAL containing block, escaped `main`'s overflow
 * clip, and stretched the document to where it would have sat in `main`'s full
 * scroll height: 2564px of document against a 900px viewport. When `main`
 * reached its end the wheel chained to the window and scrolled the whole shell
 * up into a blank page.
 *
 * jsdom has no layout, so the heights cannot be measured here. The contract
 * that produces them can: the real stylesheets are loaded into jsdom's cascade
 * and the computed style of the real shell classes is read.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

function cssFrom(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

const DASHBOARD_CSS = cssFrom('../app.css');

beforeAll(() => {
  for (const relative of [
    '../../../../packages/tokens/dist/avo-tokens.css',
    '../../../../packages/ui/src/ui.css',
    '../app.css',
  ]) {
    const style = document.createElement('style');
    style.textContent = cssFrom(relative);
    document.head.appendChild(style);
  }
});

afterEach(() => {
  document.body.innerHTML = '';
});

const SCROLLS = /^(auto|scroll)$/;

function scrolls(style: CSSStyleDeclaration): boolean {
  return SCROLLS.test(style.overflowY) || SCROLLS.test(style.overflowX) || SCROLLS.test(style.overflow);
}

/**
 * The declaration block of one selector, read off the stylesheet text. jsdom's
 * CSSOM drops properties it does not know, and `overscroll-behavior` is one of
 * them, so its computed style cannot tell a present declaration from a missing
 * one. `position` goes through the cascade below; `overscroll-behavior` is read
 * here instead.
 */
function declarationsOf(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(DASHBOARD_CSS);
  if (!match) throw new Error(`no rule for ${selector} in app.css`);
  return (match[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('the merchant shell scrolls inside main, and main contains what it scrolls', () => {
  function mountMerchantShell(): HTMLElement {
    document.body.innerHTML = `
      <div class="dash" data-bp="wide">
        <aside class="dash__rail"></aside>
        <div class="dash__main">
          <main class="dash__content">
            <div class="dash__column"><span class="avo-sr-only">Chart alternative</span></div>
          </main>
        </div>
      </div>`;
    return document.querySelector('main.dash__content') as HTMLElement;
  }

  it('main.dash__content is the scroller', () => {
    const main = mountMerchantShell();
    expect(scrolls(getComputedStyle(main))).toBe(true);
  });

  it('main.dash__content is position: relative, so an sr-only span cannot escape its clip', () => {
    const main = mountMerchantShell();
    expect(getComputedStyle(main).position).toBe('relative');
  });

  it('main.dash__content carries overscroll-behavior: contain, so its end never chains to the window', () => {
    expect(declarationsOf('.dash__content')).toMatch(/(?:^|;|\s)overscroll-behavior\s*:\s*contain\s*;/);
  });

  it('the page itself does not scroll: html, body and #root size to the viewport and do not clip', () => {
    document.body.innerHTML = '<div id="root"></div>';
    for (const el of [document.documentElement, document.body, document.getElementById('root')!]) {
      const style = getComputedStyle(el);
      expect(style.height).toBe('100%');
      expect(scrolls(style)).toBe(false);
    }
  });
});

describe('the owner console scrolls the document, so the initial containing block is its scroller', () => {
  /*
   * `ConsoleShell` is a SIBLING of the merchant shell with a different frame: a
   * grid, a `position: sticky` sidebar, and the DOCUMENT as the scroller. Measured
   * live on all ten console sections at 1440x900 and 1024x768: the document's
   * scrollHeight equals the console's own height on every one. There is no inner
   * box to escape, so the fix does not apply to this frame, and this block pins
   * the reason: if the console is ever changed to scroll an inner box, that box
   * must carry the same contract as `main.dash__content` above.
   */
  function mountConsoleShell(): HTMLElement[] {
    document.body.innerHTML = `
      <div class="console avo-dark" data-bp="wide">
        <aside class="console-sidebar"></aside>
        <div class="console-main">
          <header class="console-header"></header>
          <main class="console-content"><span class="avo-sr-only">x</span></main>
        </div>
      </div>`;
    return ['.console', '.console-main', '.console-content'].map(
      (s) => document.querySelector(s) as HTMLElement,
    );
  }

  it('none of the console frame scrolls an inner box, or the one that does contains what it scrolls', () => {
    for (const el of mountConsoleShell()) {
      const style = getComputedStyle(el);
      if (!scrolls(style)) continue;
      expect(style.position, `.${el.className.split(' ')[0]} scrolls`).toBe('relative');
      expect(declarationsOf(`.${el.className.split(' ')[0]}`)).toMatch(/overscroll-behavior\s*:\s*contain/);
    }
    expect(mountConsoleShell().filter((el) => scrolls(getComputedStyle(el)))).toEqual([]);
  });

  it('the sticky console sidebar is its own containing block', () => {
    mountConsoleShell();
    expect(getComputedStyle(document.querySelector('.console-sidebar')!).position).toBe('sticky');
  });
});

describe('every scroller in the dashboard stylesheet is the containing block for what it scrolls', () => {
  /*
   * The same escape at a smaller scale: an sr-only span in row 40 of a table
   * capped at 620px sits at its static position far below the cap, outside the
   * table's clip, and stretches whatever does contain it. Every rule that makes a
   * box scroll therefore also positions it. A new scroller without `position`
   * fails here, by selector.
   */
  it('no rule sets a scrolling overflow without also setting position', () => {
    const sheet = [...document.styleSheets].find((s) =>
      [...s.cssRules].some((r) => r instanceof CSSStyleRule && r.selectorText === '.dash__content'),
    )!;
    const offenders: string[] = [];
    let scrollers = 0;
    for (const rule of [...sheet.cssRules]) {
      if (!(rule instanceof CSSStyleRule)) continue;
      if (!scrolls(rule.style)) continue;
      scrollers += 1;
      if (!rule.style.position) offenders.push(rule.selectorText);
    }
    expect(scrollers).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });
});

describe('.avo-sr-only is the standard visually-hidden pattern', () => {
  it('is absolute, 1px, clipped and unwrapped', () => {
    document.body.innerHTML = '<span class="avo-sr-only">Resolved.</span>';
    const style = getComputedStyle(document.querySelector('.avo-sr-only')!);
    expect(style.position).toBe('absolute');
    expect(style.width).toBe('1px');
    expect(style.height).toBe('1px');
    expect(style.margin).toBe('-1px');
    expect(style.overflow).toBe('hidden');
    expect(style.whiteSpace).toBe('nowrap');
    expect(cssFrom('../../../../packages/ui/src/ui.css')).toMatch(
      /\.avo-sr-only\s*\{[^}]*clip-path:\s*inset\(50%\)/,
    );
  });
});
