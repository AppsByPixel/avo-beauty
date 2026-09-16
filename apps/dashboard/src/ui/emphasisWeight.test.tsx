// @vitest-environment jsdom

/**
 * THE WEIGHT VOCABULARY, ASSERTED THROUGH THE CASCADE RATHER THAN THROUGH A CLASS NAME.
 *
 * Aftab, item 2: "check all text stuff that is bold and styled in the design".
 *
 * The design bundle's weights, re-counted across all six `design/*.dc.html`:
 * 556 × 600, 193 × 500, 11 × 700, 2 × 400. `design/tokens/avo-tokens.json`
 * agrees and goes further — `displayXL/L/M/S` 500, `money` 600, `label` 600,
 * `bodyL/body/bodyS` 400, and NO 700 anywhere in the type scale. Every one of
 * the eleven 700s is an inline badge or tag style, and the two on the merchant
 * surface plus the three on the console are all either unbuilt or rendered
 * through the shared 600 `Pill`. So the dashboard's correct 700 count is zero.
 *
 * WHY THIS FILE READS `getComputedStyle` AND NOT THE STYLESHEET TEXT.
 * The defect it was written for is invisible to a source scan and to a class
 * name: `<b>` with no author rule is not "unstyled", it is `font-weight: bolder`
 * from the UA sheet, which resolves against a 400 parent to 700. Nothing fails,
 * nothing looks empty — the phrase the design emphasises at 600 simply renders
 * heavier than every other weight in the product. A test that asserted
 * `container.querySelector('b')` exists, or that the class is `.avo-info__text`,
 * passes in both worlds. Only the cascade separates them, so the real
 * stylesheets are loaded and the computed value is read.
 *
 * `design/AVO Owner Console.dc.html:148` is the shape that names the rule:
 * `<b style="font-weight:600">{{ f.who }}</b> {{ f.what }}` — the design pins
 * `b` to 600 INLINE, on every instance, precisely because the default is not it.
 */

import { render, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { InfoBanner } from '@avo/ui';

/** The real stylesheets, read off disk and applied by jsdom's own cascade. */
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

afterEach(cleanup);

describe('inline emphasis carries the design weight, not the browser default', () => {
  /**
   * The Appointments banner from `AVO Merchant Dashboard.dc.html:169`, rendered
   * through the real `InfoBanner` the route uses. Only the computed weight is
   * under test here — the cascade, not the copy.
   *
   * THE DURATION IS A PARAMETER NOW, AND THE FIXTURE FOLLOWS THE ROUTE. The
   * design writes `1 hour` into the markup; the route renders the salon's
   * `noShowReturnMinutes` through `formatReturnWindow`, because Settings gained a
   * control that can set it and a salon on 4 hours was being told 1. A fixture
   * frozen at the literal would keep asserting a shape the screen no longer has,
   * so both a short and a long window are rendered: the emphasis is on whatever
   * the window is, not on two particular words.
   *
   * This file is NOT a line-number ratchet — the `:169` above is a pointer into
   * the design bundle, and nothing here pins a line in a source file. Checked
   * before the banner moved, so this change shifts nothing it guards.
   */
  it.each(['1 hour', '4 hours'])('renders <b> in product copy at 600 — %s', (window) => {
    const { container } = render(
      <InfoBanner>
        Deposits auto-return to the customer&rsquo;s wallet <b>{window}</b> after a missed slot —
        the money never leaves the ecosystem.
      </InfoBanner>,
    );

    const emphasis = container.querySelector('b');
    expect(emphasis?.textContent).toBe(window);
    expect(getComputedStyle(emphasis!).fontWeight).toBe('600');
  });

  /**
   * The console's Activity row — `<b>{who}</b> {what}` — and the Overview feed
   * row it mirrors. Both already carry a scoped rule; this pins them so that a
   * later tidy-up of the global rule cannot flatten them silently.
   */
  it.each([
    ['.overview__feed-text', 'Overview feed'],
    ['.activity__text', 'console Activity'],
  ])('keeps the actor bold at 600 in the %s row', (scope) => {
    const { container } = render(
      <p className={scope.slice(1)}>
        <b>Noura</b> topped up 20.000
      </p>,
    );
    expect(getComputedStyle(container.querySelector('b')!).fontWeight).toBe('600');
  });
});

describe('the brand mark is one weight and one colour on all four surfaces', () => {
  /**
   * The design draws all four of these marks on #5A6B58 at 600:
   * `AVO Login.dc.html:67` (merchant sign-in) and `:123` (console sign-in),
   * `AVO Owner Console.dc.html:48` (console sidebar), and the merchant sidebar
   * mark beside it. The two merchant marks are in this list as the CONTROL —
   * they already agree with the design, so if they ever stop, the failure is
   * about the rule and not about the two console marks it was written for.
   */
  it.each([
    ['signin__mark', 'merchant sign-in'],
    ['dash-sidebar__mark', 'merchant sidebar'],
    ['csignin__mark', 'console sign-in'],
    ['console-sidebar__mark', 'console sidebar'],
  ])('draws the %s mark at 600', (className) => {
    const { container } = render(<span className={className}>A</span>);
    expect(getComputedStyle(container.querySelector('span')!).fontWeight).toBe('600');
  });

  /**
   * NON-NEGOTIABLE #9, AND THE ONE ASSERTION HERE THAT IS NOT A COMPUTED VALUE.
   *
   * `--avo-brand` is #6E7F6C: 4.272:1 against white, which FAILS the 4.5:1 the
   * rule exists to protect. `--avo-brand-deep` is #5A6B58 at 5.708:1, and is
   * what the design specifies for every one of these marks.
   *
   * This reads the declaration rather than `getComputedStyle` because jsdom
   * does not substitute custom properties — it answers `rgba(0, 0, 0, 0)` for
   * `var(--avo-brand-deep)` and for `var(--avo-brand)` alike, so a computed
   * assertion here would pass on both the right colour and the wrong one. The
   * computed proof for this one lives in a real browser, where the console
   * sign-in mark measured `rgb(110, 127, 108)` before this was fixed and
   * `rgb(90, 107, 88)` after.
   */
  it.each(['signin__mark', 'dash-sidebar__mark', 'csignin__mark', 'console-sidebar__mark'])(
    'fills the %s mark from --avo-brand-deep, never white on --avo-brand',
    (className) => {
      const rule = DASHBOARD_CSS.match(new RegExp(`\\.${className}\\s*\\{([^}]*)\\}`));
      expect(rule, `no .${className} rule found in app.css`).not.toBeNull();
      expect(rule![1]).toMatch(/background:\s*var\(--avo-brand-deep\)/);
    },
  );
});
