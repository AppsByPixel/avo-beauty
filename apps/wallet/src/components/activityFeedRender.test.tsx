// @vitest-environment jsdom

/**
 * THE ACTIVITY FEED, RENDERED — the disclosure half of a rule
 * `domain/activityDisclosure.test.ts` proves on its own.
 *
 * That file proves what `discloseActivity` returns. It cannot reach the thing
 * that breaks in front of a customer: whether the COMPONENT asks, whether the
 * control it draws actually reveals the rest, and whether a three-row account
 * is shown a button with nothing under it. That gap — a rule tested and its
 * call site not — is the one DECISIONS #38 records in the Pay tab and the one
 * `topUpCardRender.test.tsx` was written for.
 *
 * EVERY TEST HERE FAILS BEFORE THIS SLICE: `ActivityFeed` rendered `rows.map`,
 * so twelve rows produced twelve rows and there was no control in the output to
 * assert on, in either direction.
 *
 * BOTH LANGUAGES. The label used to be an AR GAP and render English in the
 * Arabic build; since 2026-09-28 both halves of the control are written in both
 * languages, and the specs below pin each string by value from the copy modules.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * AND IT FOLDS BACK (2026-09-28) — Aftab: "when I want to shorten the list
 * again I can't." The control used to withdraw once pressed; the spec that
 * pinned that ("…and then withdraws it") is replaced, not deleted, by the one
 * that pins the opposite. What is pinned now:
 *
 *   · expanded → the same control reads "Show less" → pressing it returns to
 *     FOUR rows, not merely to fewer;
 *   · a fresh mount opens collapsed even after the previous mount was expanded;
 *   · the control exposes expanded/collapsed as STATE (`aria-expanded`), not
 *     only as a changed label, in both languages;
 *   · it is one element across both states, so focus is not lost when it flips;
 *   · folding reports the section's top to Home, which owns the scroll view.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import fs from 'node:fs';
import path from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Language } from '@avo/types';

import { ActivityFeed } from './ActivityFeed';
import { LanguageProvider } from '../i18n/language';
import type { ActivityRow } from '../domain/activity';
import { en } from '../copy/en';
import { ar } from '../copy/ar';

afterEach(cleanup);

const row = (i: number): ActivityRow => ({
  id: `TX-${i}`,
  title: `Row ${i}`,
  when: 'Sat 12 July',
  amount: '+27.500',
  amountLabel: '27.500 dinars',
  positive: true,
  pending: false,
  failed: false,
});

const rows = (n: number) => Array.from({ length: n }, (_, i) => row(i));

const draw = (n: number, lang: Language = 'en', onCollapse?: (section: unknown) => void) =>
  render(
    <LanguageProvider initial={lang}>
      <ActivityFeed
        rows={rows(n)}
        onTopUp={vi.fn()}
        onOpen={vi.fn()}
        {...(onCollapse ? { onCollapse } : {})}
      />
    </LanguageProvider>,
  );

const visibleRows = () => screen.queryAllByTestId(/^activity-row-/);
const control = () => screen.queryByTestId('activity-disclosure');

describe('ActivityFeed — four, then the rest', () => {
  it('renders four of twelve and a control beneath', () => {
    draw(12);
    expect(visibleRows()).toHaveLength(4);
    expect(control()).not.toBeNull();
  });

  it('reveals the rest when the control is pressed, and the control stays', () => {
    draw(12);
    fireEvent.click(control()!);
    expect(visibleRows()).toHaveLength(12);
    expect(control()).not.toBeNull();
  });

  it('draws the control in Arabic too', () => {
    draw(12, 'ar');
    expect(visibleRows()).toHaveLength(4);
    expect(control()).not.toBeNull();
  });
});

describe('ActivityFeed — and back to four (item: "I want to shorten the list again")', () => {
  it('folds an expanded list back to exactly four rows', () => {
    draw(12);
    fireEvent.click(control()!);
    expect(visibleRows()).toHaveLength(12);
    fireEvent.click(control()!);
    expect(visibleRows()).toHaveLength(4);
    // Back to where she started, including the way out again.
    expect(control()!.textContent).toBe(en.activityShowMore);
  });

  it('opens collapsed on a fresh mount, even after the last mount was left expanded', () => {
    const first = draw(12);
    fireEvent.click(control()!);
    expect(visibleRows()).toHaveLength(12);
    first.unmount(); // leaving Home
    draw(12); // coming back to it
    expect(visibleRows()).toHaveLength(4);
    expect(control()!.getAttribute('aria-expanded')).toBe('false');
  });

  it('is one element in both states, so focus does not fall off it when it flips', () => {
    draw(12);
    const before = control();
    fireEvent.click(before!);
    expect(control()).toBe(before);
  });

  it('hands Home its own section when it folds — and nothing when it opens', () => {
    const onCollapse = vi.fn();
    draw(12, 'en', onCollapse);
    fireEvent.click(control()!); // open
    expect(onCollapse).not.toHaveBeenCalled();
    fireEvent.click(control()!); // fold
    expect(onCollapse).toHaveBeenCalledTimes(1);
    // The section itself — the view Home measures — i.e. the one holding the
    // control and the rows, not some other node.
    const section = onCollapse.mock.calls[0]![0] as HTMLElement;
    expect(section).toBeInstanceOf(HTMLElement);
    expect(section.contains(control())).toBe(true);
    expect(section.textContent).toContain(en.activityLabel);
  });
});

describe('ActivityFeed — the control says what it does, in both languages', () => {
  const cases: Array<[Language, typeof en]> = [
    ['en', en],
    ['ar', ar],
  ];

  it.each(cases)('%s: "show more" collapsed, "show less" expanded — by label and by state', (lang, copy) => {
    draw(12, lang);
    const c = control()!;
    expect(c.textContent).toBe(copy.activityShowMore);
    expect(c.getAttribute('aria-label')).toBe(copy.activityShowMore);
    expect(c.getAttribute('role')).toBe('button');
    expect(c.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(c);
    expect(c.textContent).toBe(copy.activityShowLess);
    expect(c.getAttribute('aria-label')).toBe(copy.activityShowLess);
    expect(c.getAttribute('aria-expanded')).toBe('true');
  });

  it('the Arabic is Arabic — neither half falls back to the English string', () => {
    expect(ar.activityShowMore).not.toBe(en.activityShowMore);
    expect(ar.activityShowLess).not.toBe(en.activityShowLess);
    expect(ar.activityShowMore).toMatch(/[\u0600-\u06FF]/);
    expect(ar.activityShowLess).toMatch(/[\u0600-\u06FF]/);
    // The two labels must differ, or the flip is invisible to a sighted reader.
    expect(en.activityShowLess).not.toBe(en.activityShowMore);
    expect(ar.activityShowLess).not.toBe(ar.activityShowMore);
  });
});

describe('ActivityFeed — the near-empty cases', () => {
  it('shows three rows and no control: there is nothing beneath to disclose', () => {
    draw(3);
    expect(visibleRows()).toHaveLength(3);
    expect(control()).toBeNull();
  });

  it('shows exactly four and no control', () => {
    draw(4);
    expect(visibleRows()).toHaveLength(4);
    expect(control()).toBeNull();
  });

  it('shows five rows as four and a control — the first row that can be hidden', () => {
    draw(5);
    expect(visibleRows()).toHaveLength(4);
    expect(control()).not.toBeNull();
  });

  it('leaves the empty state exactly as it was — no control over nothing', () => {
    render(
      <LanguageProvider initial="en">
        <ActivityFeed rows={[]} onTopUp={vi.fn()} onOpen={vi.fn()} />
      </LanguageProvider>,
    );
    expect(visibleRows()).toHaveLength(0);
    expect(control()).toBeNull();
    expect(screen.queryByText('Nothing here yet')).not.toBeNull();
  });
});

/**
 * SOURCE ASSERTIONS, LABELLED AS SUCH. `HomeScreen` cannot be mounted in this
 * suite (it reaches `react-native-qrcode-svg` through `PaymentCode`; see
 * vitest.config.ts). The rule is proved in `activityDisclosure.test.ts` and the
 * feed's report of its own top is proved above; what is left is that Home joins
 * the two to the scroll view it owns. Driven in the web build as well — see the
 * slice's report.
 */
describe('Home scrolls back to the feed when it folds', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'screens', 'HomeScreen.tsx'), 'utf8');

  it('hands the feed a collapse handler', () => {
    expect(src).toMatch(/<ActivityFeed[\s\S]*?onCollapse=\{onFeedCollapse\}/);
  });

  it('the handler measures at the press, asks the rule, then scrolls the view the feed lives in', () => {
    const start = src.indexOf('const onFeedCollapse');
    const handler = src.slice(start, src.indexOf('}, []);', start));
    // Measured against the scroll content at the press, not read from onLayout.
    expect(handler).toContain('section.measureLayout(');
    expect(handler).toContain('innerContent(scroll)');
    expect(src).toContain('getInnerViewRef?.()');
    expect(handler).toContain('collapseScrollTarget(from, sectionTop)');
    expect(handler).toContain('scroll.scrollTo(');
    expect(src).toMatch(/<ScrollView\s+ref=\{scrollRef\}\s+onScroll=\{onScroll\}/);
  });
});
