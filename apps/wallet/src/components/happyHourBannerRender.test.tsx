// @vitest-environment jsdom

/**
 * THE HAPPY-HOUR BANNER, RENDERED — the wiring half of a rule the domain tests
 * already prove.
 *
 * `domain/happyHour.test.ts` proves `happyBanner` thoroughly, and proves it as a
 * pure function of an instant. What no pure test can reach is whether the
 * COMPONENT asks it about the right instant, or whether someone one day replaces
 * the derivation with a stored `live` flag and every domain test stays green.
 *
 * That is not a hypothetical failure mode in this project — it is the one
 * CLAUDE.md names: "the happy-hour predicate, never a `live` flag". And it is
 * exactly the class of gap found in the wallet's Pay tab, where the rule was
 * tested and the call to it was not (DECISIONS.md #38).
 *
 * SO THE ASSERTION IS: SAME DATA, TWO CLOCKS, TWO BANNERS. Identical props, a
 * system clock moved from inside the window to outside it, and the rendered
 * output has to change. A `live` flag on the promotion could not pass this, and
 * neither could a component that read the clock once at module load.
 *
 * HH-01 runs Sun/Mon/Tue 16:00–18:00 in Asia/Kuwait. 2026-08-30 is a Sunday.
 * Times are written as Kuwait wall time with an explicit +03:00 so the test does
 * not depend on the machine's zone — the same care `happyHour.test.ts` takes.
 */

import type { HappyHour, PromotionSet } from '@avo/types';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HappyHourBanner } from './HappyHourBanner';
import { LanguageProvider } from '../i18n/language';

const HH_01: HappyHour = {
  id: 'HH-01',
  branchId: 'all',
  days: [0, 1, 2],
  from: '16:00',
  to: '18:00',
  reward: 'x2visit',
  on: true,
  notify: true,
};

const PROMOTIONS: PromotionSet = {
  boosts: { 'BR-SAL': { visit: 1, topup: 0, stamp: 1 } },
  boostsPublishedAt: '2026-08-10T06:00:00.000Z',
  boostsPublishedBy: 'Noura',
  happy: [HH_01],
};

const SALON = {
  branches: [{ id: 'BR-SAL', name: 'Salmiya', nameAr: 'السالمية' }],
  timezone: 'Asia/Kuwait',
} as never;

/** A UTC instant written as the Kuwait wall time it denotes. */
const kuwait = (iso: string) => new Date(`${iso}+03:00`);

function renderAt(instant: Date, lang: 'en' | 'ar' = 'en') {
  vi.setSystemTime(instant);
  return render(
    <LanguageProvider initial={lang}>
      <HappyHourBanner promotions={PROMOTIONS} salon={SALON} />
    </LanguageProvider>,
  );
}

beforeEach(() => {
  // `shouldAdvanceTime` keeps the component's own 1s interval from starving the
  // renderer while the clock is frozen.
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('the banner is computed from the clock, not read off a flag', () => {
  it('renders the live banner inside the window', () => {
    const { container } = renderAt(kuwait('2026-08-30T17:00:00'));
    expect(container.textContent).toBeTruthy();
    expect(container.textContent).toContain('Happy hour');
  });

  it('renders something DIFFERENT outside the window, from identical props', () => {
    const inside = renderAt(kuwait('2026-08-30T17:00:00')).container.textContent;
    cleanup();
    const outside = renderAt(kuwait('2026-08-30T12:00:00')).container.textContent;

    // The precise copy is the domain layer's business. What this owns is that
    // the component's output is a FUNCTION OF THE CLOCK: one set of props,
    // two instants, two different renderings.
    expect(outside).not.toBe(inside);
  });

  it('looks AHEAD on a day the happy hour does not run', () => {
    // Thursday, 17:00 — the same wall-clock time that is live on a Sunday.
    // HH-01 runs Sun/Mon/Tue, so the hour matching proves nothing by itself;
    // only the day does. The component announces the next occurrence rather
    // than going blank, which is the `bannerNext` branch.
    //
    // I expected '' here and was wrong. Recorded rather than quietly amended,
    // because "renders nothing" was MY assumption about a component whose own
    // code plainly has two branches, and a test written to a guess about
    // behaviour is how a wrong expectation becomes a frozen requirement.
    const { container } = renderAt(kuwait('2026-09-03T17:00:00'));
    expect(container.textContent).toContain('Next happy hour');
    expect(container.textContent).not.toContain('Happy hour ·');
  });
});
