/**
 * What a top-up is worth, PREVIEWED — the four rules the figures rest on.
 *
 * Each test below fails against the state of this app before the preview
 * existed, because before it there was no `topUpPreview` to call at all: the
 * tiles carried amounts and nothing else, on the argument recorded at the top of
 * `components/TopUpCard.tsx`. The figures were then ruled in. These are the
 * rules they have to satisfy to be allowed on screen.
 *
 * THE ONE THING THIS FILE DOES NOT PROVE is that the preview agrees with the
 * server. It cannot: everything here is asserted against expectations written in
 * this repo. `topupPreviewParity.test.ts` is where that claim is tested, against
 * the server's own `decideEarning`, imported rather than re-typed.
 *
 * Instants are UTC written with an explicit +03:00 so nothing depends on the
 * machine's zone — the care `happyHour.test.ts` takes, for the reason it gives.
 */

import { describe, expect, it } from 'vitest';
import { fils, type HappyHour, type Member, type PromotionSet, type Salon } from '@avo/types';
import { bonusPercents, topUpPreview } from './topupPreview';

/** A UTC instant written as the Kuwait wall time it denotes. */
const kuwait = (iso: string) => new Date(`${iso}+03:00`);

/** Sunday 2026-08-30, 17:00 Kuwait — inside HH_TOPUP below. */
const INSIDE = kuwait('2026-08-30T17:00:00');
/** Same day, 12:00 Kuwait — outside it. */
const OUTSIDE = kuwait('2026-08-30T12:00:00');

/** A `topup10` window, every branch. */
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

/** The same window, scoped to ONE branch. The server never matches this here. */
const HH_BRANCH_SCOPED: HappyHour = { ...HH_TOPUP, id: 'HH-BR', branchId: 'BR-SAL' };

/** A window that is live but pays nothing on a top-up. */
const HH_VISITS: HappyHour = { ...HH_TOPUP, id: 'HH-VIS', reward: 'x2visit' };

function promotionSet(happy: HappyHour[]): PromotionSet {
  return {
    // A fat branch boost, which must be ignored on this path in every test.
    boosts: { 'BR-SAL': { visit: 2, topup: 30, stamp: 2 } },
    boostsPublishedAt: '2026-08-10T06:00:00.000Z',
    boostsPublishedBy: 'Noura',
    happy,
  };
}

const SILVER = { tier: 'silver' } as Member;

const TIERS_SALON = {
  loyaltyMode: 'tiers',
  timezone: 'Asia/Kuwait',
  tiers: [
    { name: 'bronze', bonusPercent: 0 },
    { name: 'silver', bonusPercent: 10 },
    { name: 'gold', bonusPercent: 20 },
  ],
} as Salon;

const STAMPS_SALON = {
  loyaltyMode: 'stamps',
  timezone: 'Asia/Kuwait',
  stampTarget: 8,
  tiers: null,
} as unknown as Salon;

const NO_WINDOWS = promotionSet([]);

describe('the per-tile figure — the tier bonus alone', () => {
  /**
   * Aftab's screenshot: `5 / +0.500`, `10 / +1.000`, `25 / +2.500`, `50 / +5.000`
   * for a Silver member at +10%. This is that table.
   */
  it.each([
    [5000, 500, 5500],
    [10000, 1000, 11000],
    [25000, 2500, 27500],
    [50000, 5000, 55000],
  ])('%i fils earns %i and lands %i', (amount, bonus, credit) => {
    const p = topUpPreview(fils(amount), SILVER, TIERS_SALON, NO_WINDOWS, OUTSIDE);
    expect(p).not.toBeNull();
    expect(p?.totalBonusFils).toBe(bonus);
    expect(p?.creditFils).toBe(credit);
  });

  it('splits the bonus into its two locked halves, tier-only here', () => {
    const p = topUpPreview(fils(10000), SILVER, TIERS_SALON, NO_WINDOWS, OUTSIDE);
    // The server writes these to two COLUMNS and this keeps them apart for the
    // same reason: one is owed to her standing, the other to a campaign.
    expect(p?.bonusFils).toBe(1000);
    expect(p?.promoBonusFils).toBe(0);
    expect(p?.tierPercent).toBe(10);
    expect(p?.promoPercent).toBe(0);
  });
});

describe('the pay→get line — "Pay 10.000 KD → Get 11.000 KD"', () => {
  it('gets 11.000 for a 10.000 top-up at Silver', () => {
    const p = topUpPreview(fils(10000), SILVER, TIERS_SALON, NO_WINDOWS, OUTSIDE);
    expect(p?.creditFils).toBe(11000);
  });

  it('is amount + both bonuses, never the bonus alone', () => {
    const p = topUpPreview(fils(25000), SILVER, TIERS_SALON, promotionSet([HH_TOPUP]), INSIDE);
    expect(p?.creditFils).toBe(25000 + p!.bonusFils + p!.promoBonusFils);
  });
});

describe('stamps mode shows nothing', () => {
  it('returns no preview, so no tile figure and no pay→get card', () => {
    expect(topUpPreview(fils(10000), SILVER, STAMPS_SALON, NO_WINDOWS, OUTSIDE)).toBeNull();
    expect(bonusPercents(SILVER, STAMPS_SALON, NO_WINDOWS, OUTSIDE)).toBeNull();
  });

  it('stays silent even while a topup10 window is LIVE', () => {
    /**
     * The server guards its promotion read with the same `loyaltyMode !==
     * 'stamps'`, so a stamps salon running a top-up window pays nothing extra.
     * A preview that showed +10% here would be promising money the merchant
     * never agreed to fund — and it is the one stamps case that is not obvious,
     * because the window genuinely IS live.
     */
    const live = promotionSet([HH_TOPUP]);
    expect(topUpPreview(fils(10000), SILVER, STAMPS_SALON, live, INSIDE)).toBeNull();
  });
});

describe('a live top-up window changes the number', () => {
  it('adds its points ON TOP of the tier bonus', () => {
    const live = promotionSet([HH_TOPUP]);
    const inside = topUpPreview(fils(10000), SILVER, TIERS_SALON, live, INSIDE);
    const outside = topUpPreview(fils(10000), SILVER, TIERS_SALON, live, OUTSIDE);

    // 10% tier + 10% window = 2.000 on a 10.000 top-up, against 1.000 outside.
    expect(inside?.promoPercent).toBe(10);
    expect(inside?.totalBonusFils).toBe(2000);
    expect(inside?.creditFils).toBe(12000);

    // SAME DATA, TWO CLOCKS, TWO ANSWERS. A stored `live` flag could not do this.
    expect(outside?.promoPercent).toBe(0);
    expect(outside?.creditFils).toBe(11000);
  });

  it('takes the BEST live window, not the one closest to ending', () => {
    /**
     * `activeHappyHour` would pick whichever window ends soonest, because it
     * answers "which countdown does the banner show". The earning rate is a
     * `Math.max`, which is what `decideEarning` takes and what this must too.
     * HH-20 ends LATER and pays MORE; picking by end time would under-pay.
     */
    const bigger: HappyHour = { ...HH_TOPUP, id: 'HH-20', to: '19:00', reward: 'topup20' };
    const p = topUpPreview(
      fils(10000),
      SILVER,
      TIERS_SALON,
      promotionSet([HH_TOPUP, bigger]),
      INSIDE,
    );
    expect(p?.promoPercent).toBe(20);
    expect(p?.creditFils).toBe(13000);
  });

  it('ignores a live window whose reward is not a top-up bonus', () => {
    const p = topUpPreview(fils(10000), SILVER, TIERS_SALON, promotionSet([HH_VISITS]), INSIDE);
    expect(p?.promoPercent).toBe(0);
    expect(p?.creditFils).toBe(11000);
  });

  it('lifts a Bronze member off nothing to something', () => {
    // tierPercent 0 alone yields NO preview; a live window alone is enough.
    const bronze = { tier: 'bronze' } as Member;
    expect(topUpPreview(fils(10000), bronze, TIERS_SALON, NO_WINDOWS, INSIDE)).toBeNull();
    const p = topUpPreview(fils(10000), bronze, TIERS_SALON, promotionSet([HH_TOPUP]), INSIDE);
    expect(p?.tierPercent).toBe(0);
    expect(p?.promoPercent).toBe(10);
    expect(p?.creditFils).toBe(11000);
  });
});

describe('the branch is never consulted — the server passes null', () => {
  it('ignores a branch-scoped window even while it is live', () => {
    const p = topUpPreview(
      fils(10000),
      SILVER,
      TIERS_SALON,
      promotionSet([HH_BRANCH_SCOPED]),
      INSIDE,
    );
    expect(p?.promoPercent).toBe(0);
    expect(p?.creditFils).toBe(11000);
  });

  it('ignores the branch top-up boost, which is 30% in every fixture here', () => {
    // If a boost ever leaked in, every number in this file would be 3x larger.
    const p = topUpPreview(fils(10000), SILVER, TIERS_SALON, NO_WINDOWS, OUTSIDE);
    expect(p?.creditFils).toBe(11000);
  });
});

describe('a failed promotions read withholds the figures rather than guessing', () => {
  it('returns null when the promotion set is null', () => {
    /**
     * Under-promising is NOT the safe default. With the set absent we cannot
     * know whether a `topup10` window is live; printing the tier figure alone
     * would have her choose a tile against 11.000 and meet 12.000 in the sheet,
     * which teaches her the card is unreliable in the direction that matters.
     * `BranchEarning` drops its whole section on the same reasoning.
     */
    expect(topUpPreview(fils(10000), SILVER, TIERS_SALON, null, INSIDE)).toBeNull();
  });
});

describe('nothing to say is said as nothing', () => {
  it('returns null for a tier with no bonus and no window', () => {
    const bronze = { tier: 'bronze' } as Member;
    expect(topUpPreview(fils(10000), bronze, TIERS_SALON, NO_WINDOWS, OUTSIDE)).toBeNull();
  });

  it('returns null for a tier the salon does not publish', () => {
    const ghost = { tier: 'black' } as Member;
    expect(topUpPreview(fils(10000), ghost, TIERS_SALON, NO_WINDOWS, OUTSIDE)).toBeNull();
  });
});
