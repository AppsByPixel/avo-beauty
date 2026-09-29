// @vitest-environment jsdom

/**
 * "EARNING BY BRANCH", RENDERED — what a boost may claim, and when.
 *
 * Two rulings meet here (DECISIONS.md, 2026-09-29):
 *
 *   · "Branch boosts lose the top-up bonus" — Aftab: "Remove it from boosts".
 *     A top-up has no branch, so `decideEarning` never paid a branch boost's
 *     `topup`. The "+10% top-ups" chip was a promise of money the server never
 *     kept. It is gone, whatever `topup` the wire carries — an old cached set,
 *     or a server that has not yet shipped its CHECK, can still say 30.
 *
 *   · "Boost windows" (lane A, 6d102c5; trunk 7646bb8). A boost applies from
 *     `startsAt` until `endsAt`, and can be stopped. The chip shows a boost only
 *     while `isBoostLive` says it runs, and only once it is not neutral. This is
 *     DISPLAY (#2): earning is still resolved on the server at charge time.
 *
 * Same props, different clocks, different chips — a stored `live` flag could
 * not pass the window tests, and neither could a component that read the clock
 * once at module load.
 */

import type { Boost, PromotionSet } from '@avo/types';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BranchEarning } from './BranchEarning';
import { LanguageProvider } from '../i18n/language';
import { en } from '../copy/en';
import { ar } from '../copy/ar';

const NOW = new Date('2026-09-29T12:00:00.000Z');
const HOUR = 3_600_000;
const iso = (offsetHours: number) => new Date(NOW.getTime() + offsetHours * HOUR).toISOString();

const RUNNING: Boost = {
  visit: 2,
  topup: 0,
  stamp: 2,
  startsAt: iso(-24),
  endsAt: iso(24),
  stoppedAt: null,
  stoppedBy: null,
};

function salon(loyaltyMode: 'tiers' | 'stamps' = 'tiers') {
  return {
    loyaltyMode,
    branches: [
      { id: 'BR-SAL', name: 'Salmiya', nameAr: 'السالمية' },
      { id: 'BR-KWC', name: 'Kuwait City', nameAr: 'مدينة الكويت' },
    ],
  } as never;
}

function promotions(boost: Boost): PromotionSet {
  return {
    boosts: { 'BR-SAL': boost },
    boostsPublishedAt: '2026-09-28T06:00:00.000Z',
    boostsPublishedBy: 'Noura',
    happy: [],
  };
}

function renderWith(boost: Boost, lang: 'en' | 'ar' = 'en', mode: 'tiers' | 'stamps' = 'tiers') {
  return render(
    <LanguageProvider initial={lang}>
      <BranchEarning salon={salon(mode)} promotions={promotions(boost)} />
    </LanguageProvider>,
  ).container.textContent ?? '';
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('no top-up chip — branch boosts lose the bonus the server never paid', () => {
  it('a boost whose wire still says topup 30 shows no "% top-ups", in English', () => {
    const shown = renderWith({ ...RUNNING, topup: 30 });
    expect(shown).not.toContain('top-ups');
    expect(shown).not.toContain('30%');
    // The visit chip beside it is untouched.
    expect(shown).toContain(en.visitsMultiplier(2));
  });

  it('nor in Arabic', () => {
    const shown = renderWith({ ...RUNNING, topup: 30 }, 'ar');
    expect(shown).not.toContain('على الشحن');
    expect(shown).toContain(ar.visitsMultiplier(2));
  });

  it('a top-up-only boost reads as standard earning, not as a chip', () => {
    const shown = renderWith({ ...RUNNING, visit: 1, stamp: 1, topup: 20 });
    expect(shown).not.toContain('top-ups');
    // Both branches now read standard — Salmiya's boost promises nothing she gets.
    expect(shown.split(en.standardEarning).length - 1).toBe(2);
  });
});

describe('the boost window, on display', () => {
  it('a running boost is shown', () => {
    const shown = renderWith(RUNNING);
    expect(shown).toContain(en.visitsMultiplier(2));
    expect(shown.split(en.standardEarning).length - 1).toBe(1);
  });

  it('a running boost with no bounds at all is shown', () => {
    expect(renderWith({ ...RUNNING, startsAt: null, endsAt: null })).toContain(en.visitsMultiplier(2));
  });

  it('an expired boost is hidden — endsAt is exclusive', () => {
    expect(renderWith({ ...RUNNING, endsAt: iso(-1) })).not.toContain(en.visitsMultiplier(2));
    expect(renderWith({ ...RUNNING, endsAt: NOW.toISOString() })).not.toContain(en.visitsMultiplier(2));
  });

  it('a boost that has not started is hidden — startsAt is inclusive', () => {
    expect(renderWith({ ...RUNNING, startsAt: iso(1) })).not.toContain(en.visitsMultiplier(2));
    expect(renderWith({ ...RUNNING, startsAt: NOW.toISOString() })).toContain(en.visitsMultiplier(2));
  });

  it('a stopped boost is hidden — as the server serves it, neutral with a stop record', () => {
    const stopped: Boost = {
      visit: 1,
      topup: 0,
      stamp: 1,
      startsAt: null,
      endsAt: null,
      stoppedAt: iso(-2),
      stoppedBy: 'Noura',
    };
    const shown = renderWith(stopped);
    expect(shown).not.toContain('×');
    expect(shown.split(en.standardEarning).length - 1).toBe(2);
  });

  it('a stop record hides the chip even beside values that are not neutral', () => {
    // The server writes 1/0/1 with the stop, so this body should not arrive.
    // If it does, the stop is the fact to believe, not the multiplier.
    expect(renderWith({ ...RUNNING, stoppedAt: iso(-2), stoppedBy: 'Noura' })).not.toContain(
      en.visitsMultiplier(2),
    );
  });

  it('same props, two clocks: the chip goes when the window closes', () => {
    const boost = { ...RUNNING, endsAt: iso(1) };
    expect(renderWith(boost)).toContain(en.visitsMultiplier(2));
    cleanup();
    vi.setSystemTime(new Date(NOW.getTime() + 2 * HOUR));
    expect(renderWith(boost)).not.toContain(en.visitsMultiplier(2));
  });

  it('an open screen drops the chip at the window edge, without another render from above', () => {
    const view = render(
      <LanguageProvider initial="en">
        <BranchEarning salon={salon()} promotions={promotions({ ...RUNNING, endsAt: iso(1 / 60) })} />
      </LanguageProvider>,
    );
    expect(view.container.textContent).toContain(en.visitsMultiplier(2));
    act(() => {
      vi.advanceTimersByTime(61_000);
    });
    expect(view.container.textContent).not.toContain(en.visitsMultiplier(2));
  });

  it('and shows it at the start edge of a scheduled one', () => {
    const view = render(
      <LanguageProvider initial="en">
        <BranchEarning salon={salon()} promotions={promotions({ ...RUNNING, startsAt: iso(1 / 60) })} />
      </LanguageProvider>,
    );
    expect(view.container.textContent).not.toContain(en.visitsMultiplier(2));
    act(() => {
      vi.advanceTimersByTime(61_000);
    });
    expect(view.container.textContent).toContain(en.visitsMultiplier(2));
  });

  it('stamps mode reads the stamp multiplier under the same window', () => {
    expect(renderWith(RUNNING, 'en', 'stamps')).toContain(en.stampsMultiplier(2));
    expect(renderWith({ ...RUNNING, endsAt: iso(-1) }, 'en', 'stamps')).not.toContain(en.stampsMultiplier(2));
  });
});
