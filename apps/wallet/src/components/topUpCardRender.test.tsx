// @vitest-environment jsdom

/**
 * THE TOP-UP CARD, RENDERED — the wiring half of a rule the domain tests prove.
 *
 * `domain/topupPreview.test.ts` proves the derivation and
 * `domain/topupPreviewParity.test.ts` proves it agrees with the server. Neither
 * can reach the question this file owns: whether the COMPONENT asks, and asks
 * about the right instant. That is not hypothetical — it is the gap
 * `happyHourBannerRender.test.tsx` was written for and the one DECISIONS #38
 * records in the Pay tab, where the rule was tested and the call to it was not.
 *
 * EVERY TEST HERE FAILS BEFORE THIS SLICE. The card rendered four bare amounts
 * and no pay→get panel, on the argument its own header used to carry; there was
 * no "+0.500" and no "Get" in the output to assert on.
 */

import type { HappyHour, Member, PromotionSet, Salon } from '@avo/types';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TopUpCard } from './TopUpCard';
import { LanguageProvider } from '../i18n/language';
import { fils } from '@avo/types';

const kuwait = (iso: string) => new Date(`${iso}+03:00`);

const HH_TOPUP: HappyHour = {
  id: 'HH-TOPUP',
  branchId: 'all',
  days: [0, 1, 2],
  from: '16:00',
  to: '18:00',
  reward: 'topup10',
  on: true,
  notify: true,
};

const promotionSet = (happy: HappyHour[]): PromotionSet => ({
  boosts: { 'BR-SAL': { visit: 2, topup: 30, stamp: 2 } },
  boostsPublishedAt: '2026-08-10T06:00:00.000Z',
  boostsPublishedBy: 'Noura',
  happy,
});

const SILVER = { tier: 'silver' } as Member;

const TIERS_SALON = {
  loyaltyMode: 'tiers',
  timezone: 'Asia/Kuwait',
  tiers: [
    { name: 'bronze', bonusPercent: 0 },
    { name: 'silver', bonusPercent: 10 },
  ],
} as Salon;

const STAMPS_SALON = {
  loyaltyMode: 'stamps',
  timezone: 'Asia/Kuwait',
  stampTarget: 8,
  tiers: null,
} as unknown as Salon;

function renderAt(
  instant: Date,
  opts: { salon?: Salon; promotions?: PromotionSet | null; lang?: 'en' | 'ar' } = {},
) {
  vi.setSystemTime(instant);
  return render(
    <LanguageProvider initial={opts.lang ?? 'en'}>
      <TopUpCard
        member={SILVER}
        salon={opts.salon ?? TIERS_SALON}
        promotions={opts.promotions === undefined ? promotionSet([]) : opts.promotions}
        selected={fils(10000)}
        onSelect={() => {}}
        onContinue={() => {}}
      />
    </LanguageProvider>,
  );
}

beforeEach(() => {
  // The card runs its own 30s interval; `shouldAdvanceTime` keeps it from
  // starving the renderer while the clock is frozen.
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('the bonus figure under each amount', () => {
  it('prints the four figures from Aftab’s screenshot', () => {
    const { container } = renderAt(kuwait('2026-08-30T12:00:00'));
    const text = container.textContent ?? '';
    // 5 / +0.500, 10 / +1.000, 25 / +2.500, 50 / +5.000 at Silver +10%.
    expect(text).toContain('+0.500');
    expect(text).toContain('+1.000');
    expect(text).toContain('+2.500');
    expect(text).toContain('+5.000');
  });

  it('puts each figure on its OWN tile, not just somewhere on the card', () => {
    const { getByTestId } = renderAt(kuwait('2026-08-30T12:00:00'));
    expect(getByTestId('topup-bonus-5000').textContent).toBe('+0.500');
    expect(getByTestId('topup-bonus-50000').textContent).toBe('+5.000');
  });
});

describe('the pay→get card', () => {
  it('renders "Pay 10.000 KD → Get 11.000 KD"', () => {
    const { getByTestId } = renderAt(kuwait('2026-08-30T12:00:00'));
    const card = getByTestId('topup-pay-get').textContent ?? '';
    expect(card).toContain('Pay');
    expect(card).toContain('10.000');
    expect(card).toContain('Get');
    expect(card).toContain('11.000');
    expect(card).toContain('KD');
  });

  it('mirrors the arrow and keeps money Western in Arabic', () => {
    const { getByTestId } = renderAt(kuwait('2026-08-30T12:00:00'), { lang: 'ar' });
    const card = getByTestId('topup-pay-get').textContent ?? '';
    expect(card).toContain('←'); // ← , not →
    expect(card).not.toContain('→');
    expect(card).toContain('تحصلين على'); // "Get", feminine
    // Non-negotiable #12: money is Western digits and the unit is د.ك.
    expect(card).toContain('11.000');
    expect(card).toContain('د.ك');
    expect(card).not.toContain('KD');
  });
});

describe('stamps mode shows no figures at all', () => {
  /**
   * STATED AS A CONTRAST, NOT AS AN ABSENCE, AND THAT IS DELIBERATE.
   *
   * The first draft of this test only asserted that nothing rendered — and it
   * PASSED against the pre-slice component, which rendered nothing anywhere.
   * An assertion that cannot go red is not evidence, and this project has been
   * bitten by exactly that shape before. So the same instant and the same live
   * `topup10` window are rendered twice, once per loyalty mode, and the test
   * owns the DIFFERENCE: figures for tiers, silence for stamps. Nothing that
   * renders four bare amounts can satisfy both halves.
   */
  it('renders figures for a tiers salon and none for a stamps salon, same window', () => {
    const promotions = promotionSet([HH_TOPUP]); // live, and pays nothing in stamps
    const at = kuwait('2026-08-30T17:00:00');

    const tiers = renderAt(at, { salon: TIERS_SALON, promotions });
    expect(tiers.queryByTestId('topup-pay-get')).not.toBeNull();
    expect(tiers.getByTestId('topup-bonus-10000').textContent).toBe('+2.000');
    cleanup();

    const stamps = renderAt(at, { salon: STAMPS_SALON, promotions });
    expect(stamps.queryByTestId('topup-pay-get')).toBeNull();
    expect(stamps.queryByTestId('topup-bonus-10000')).toBeNull();
    expect(stamps.container.textContent ?? '').not.toContain('+2.000');
    // The card itself is still there — this is a top-up screen either way.
    expect(stamps.queryByTestId('topup-card')).not.toBeNull();
    expect(stamps.queryByTestId('topup-continue')).not.toBeNull();
  });
});

describe('the figures are a function of the clock, not of a flag', () => {
  it('shows a LARGER number inside a live topup10 window, same props', () => {
    const promotions = promotionSet([HH_TOPUP]);

    const outside = renderAt(kuwait('2026-08-30T12:00:00'), { promotions });
    const outsideGet = outside.getByTestId('topup-pay-get').textContent ?? '';
    const outsideTile = outside.getByTestId('topup-bonus-10000').textContent;
    cleanup();

    const inside = renderAt(kuwait('2026-08-30T17:00:00'), { promotions });
    const insideGet = inside.getByTestId('topup-pay-get').textContent ?? '';
    const insideTile = inside.getByTestId('topup-bonus-10000').textContent;

    // 10% tier alone vs 10% tier + 10% window, on a 10.000 KD top-up.
    expect(outsideTile).toBe('+1.000');
    expect(insideTile).toBe('+2.000');
    expect(outsideGet).toContain('11.000');
    expect(insideGet).toContain('12.000');
    expect(insideGet).not.toBe(outsideGet);
  });
});

describe('a failed promotions read withholds the figures', () => {
  /** Same contrast discipline as the stamps test above, and for the same reason. */
  it('shows figures with a set and none without one, at the same instant', () => {
    const at = kuwait('2026-08-30T17:00:00');

    const withSet = renderAt(at, { promotions: promotionSet([HH_TOPUP]) });
    expect(withSet.queryByTestId('topup-pay-get')).not.toBeNull();
    expect(withSet.getByTestId('topup-bonus-10000').textContent).toBe('+2.000');
    cleanup();

    const withoutSet = renderAt(at, { promotions: null });
    expect(withoutSet.queryByTestId('topup-pay-get')).toBeNull();
    expect(withoutSet.queryByTestId('topup-bonus-10000')).toBeNull();
    // The tier BADGE survives: it states a rate, not a computed sum.
    expect(withoutSet.container.textContent ?? '').toContain('Silver');
  });
});
