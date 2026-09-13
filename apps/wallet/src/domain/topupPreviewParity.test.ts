/**
 * THE PREVIEW EQUALS THE SERVER'S LOCK.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE REACHES OUTSIDE apps/wallet, WHICH IS NOT SOMETHING TO COPY.
 *
 * `topupPreview.test.ts` proves the preview obeys a set of rules written in this
 * repo. That is not the claim that matters. The claim that matters is that the
 * figure on Home is the figure `POST /topups` will lock — and a test asserting
 * the preview against expectations I typed myself cannot establish it, because I
 * would be checking my transcription of `services/topup.ts` against my
 * implementation of the same transcription. Both could be wrong together, which
 * is exactly how the number a customer was shown stops matching the number she
 * is charged.
 *
 * So this imports the SERVER'S OWN `decideEarning` and drives it with the same
 * inputs. Read-only, test-only, and nothing under `api/` is modified. It is a
 * cross-column reference and it is a real cost: if lane A moves that module this
 * file breaks. That is the trade taken deliberately — a test that breaks when
 * the server's rule moves is the entire point of a parity test, and a silently
 * diverging money figure is the failure it is paid for.
 *
 * WHAT IS AND IS NOT PROVED HERE, STATED PLAINLY:
 *
 *   PROVED, against the server's own code: the promotion half. `decideEarning`
 *   is the function `services/topup.ts` calls, invoked here with the `branchId:
 *   null` that the top-up path passes, and the preview's `promoPercent` must
 *   equal its `topupBonusPercent` across a matrix of windows and instants.
 *
 *   PROVED, against the server's own code: the money arithmetic. `percentOf` and
 *   `add` are the shared `@avo/types` functions `services/topup.ts` uses, so the
 *   oracle below composes them in the server's order and the preview must match
 *   fils for fils.
 *
 *   NOT PROVED here, and worth naming: that `createTopUp` itself calls these in
 *   this order. That function needs a database and a gateway, so it is not
 *   callable from the wallet's suite; the ORDER is transcribed from reading it,
 *   and `serverOracle` below is where that transcription lives — one place, next
 *   to the citation, rather than smeared across expectations. An api-side test
 *   driving `createTopUp` against a real intent row is the check that would
 *   close the gap, and it belongs to lane A.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { describe, expect, it } from 'vitest';
import {
  add,
  fils,
  percentOf,
  type Fils,
  type HappyHour,
  type Member,
  type PromotionSet,
  type Salon,
} from '@avo/types';
// The server's decision function, not a copy of it. See the header.
import { decideEarning, type PromotionInputs } from '../../../../api/src/services/promotions';
import { topUpPreview } from './topupPreview';

const kuwait = (iso: string) => new Date(`${iso}+03:00`);

const SALON_ROW = { id: 'SAL-AMARA', timezone: 'Asia/Kuwait' };

const TIERS_SALON = {
  loyaltyMode: 'tiers',
  timezone: 'Asia/Kuwait',
  tiers: [
    { name: 'bronze', bonusPercent: 0 },
    { name: 'silver', bonusPercent: 10 },
    { name: 'gold', bonusPercent: 20 },
    { name: 'black', bonusPercent: 30 },
  ],
} as Salon;

const BOOSTS = [{ branchId: 'BR-SAL', visit: 2, topup: 30, stamp: 2 }];

const WINDOWS: HappyHour[] = [
  // all-branch, pays 10% on a top-up, Sun/Mon/Tue 16:00-18:00
  { id: 'HH-10', branchId: 'all', days: [0, 1, 2], from: '16:00', to: '18:00', reward: 'topup10', on: true, notify: true },
  // all-branch, pays 20%, a narrower window inside the first
  { id: 'HH-20', branchId: 'all', days: [0], from: '17:00', to: '17:30', reward: 'topup20', on: true, notify: true },
  // branch-scoped: must never apply on a top-up
  { id: 'HH-BR', branchId: 'BR-SAL', days: [0, 1, 2], from: '10:00', to: '23:00', reward: 'topup20', on: true, notify: true },
  // live but irrelevant to a top-up
  { id: 'HH-VIS', branchId: 'all', days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '24:00', reward: 'x2visit', on: true, notify: true },
  // switched off
  { id: 'HH-OFF', branchId: 'all', days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '24:00', reward: 'topup20', on: false, notify: true },
];

const PROMOTIONS: PromotionSet = {
  boosts: { 'BR-SAL': BOOSTS[0]! },
  boostsPublishedAt: '2026-08-10T06:00:00.000Z',
  boostsPublishedBy: 'Noura',
  happy: WINDOWS,
};

/**
 * `services/topup.ts` § createTopUp, in its own order, with its own helpers.
 *
 * `branchId: null` and the `loyaltyMode !== 'stamps'` guard are the server's,
 * transcribed from the source with the lines quoted in `topupPreview.ts`. The
 * two `percentOf` calls are separate and summed because the server's are.
 */
function serverOracle(
  amount: Fils,
  member: Member,
  salon: Salon,
  promotions: PromotionSet,
  now: Date,
): { bonus: Fils; promoBonus: Fils; credit: Fils; promoPercent: number } {
  const stamps = salon.loyaltyMode === 'stamps';

  const bonusPercent = stamps
    ? 0
    : (salon.tiers?.find((t) => t.name === member.tier)?.bonusPercent ?? 0);
  const bonus = percentOf(amount, bonusPercent);

  const inputs: PromotionInputs = {
    salon: SALON_ROW,
    branchId: null, // a top-up happens on a phone — services/topup.ts
    boosts: BOOSTS,
    windows: promotions.happy,
  };
  const decision = !stamps ? decideEarning(inputs, now) : null;
  const promoPercent = decision ? decision.topupBonusPercent : 0;
  const promoBonus = percentOf(amount, promoPercent);

  return { bonus, promoBonus, credit: add(add(amount, bonus), promoBonus), promoPercent };
}

/** Every half hour across the Sunday, so window edges are actually crossed. */
const INSTANTS: Date[] = Array.from({ length: 48 }, (_, i) => {
  const h = String(Math.floor(i / 2)).padStart(2, '0');
  const m = i % 2 === 0 ? '00' : '30';
  return kuwait(`2026-08-30T${h}:${m}:00`);
});

const TIERS: Member['tier'][] = ['bronze', 'silver', 'gold', 'black'];
const AMOUNTS = [5000, 10000, 25000, 50000].map(fils);

describe('the Home preview equals what services/topup.ts would lock', () => {
  it('matches the server across every tier, amount and half-hour of the day', () => {
    let compared = 0;
    let nonZeroPromo = 0;

    for (const tier of TIERS) {
      const member = { tier } as Member;
      for (const amount of AMOUNTS) {
        for (const now of INSTANTS) {
          const expected = serverOracle(amount, member, TIERS_SALON, PROMOTIONS, now);
          const preview = topUpPreview(amount, member, TIERS_SALON, PROMOTIONS, now);

          if (expected.promoPercent > 0) nonZeroPromo += 1;

          if (preview === null) {
            // The ONLY licensed reason to show nothing is that there is nothing
            // to show. If the server would have paid a bonus here, a null
            // preview is a defect, not a decision.
            expect({ tier, amount, now: now.toISOString(), credit: expected.credit })
              .toMatchObject({ credit: amount });
            continue;
          }

          expect(preview.bonusFils).toBe(expected.bonus);
          expect(preview.promoBonusFils).toBe(expected.promoBonus);
          expect(preview.creditFils).toBe(expected.credit);
          expect(preview.promoPercent).toBe(expected.promoPercent);
          compared += 1;
        }
      }
    }

    // A parity test that compared nothing would pass. These pin that the matrix
    // actually exercised both the promoted and unpromoted branches.
    expect(compared).toBeGreaterThan(100);
    expect(nonZeroPromo).toBeGreaterThan(0);
  });

  it('agrees that a branch-scoped window pays nothing, at an instant where it is live', () => {
    // 12:00 Sunday: HH-BR (10:00-23:00, BR-SAL) is live, every `all` top-up
    // window is not. The server sees `branchId: null` and pays 0; so must we.
    const now = kuwait('2026-08-30T12:00:00');
    const member = { tier: 'silver' } as Member;
    const expected = serverOracle(fils(10000), member, TIERS_SALON, PROMOTIONS, now);
    const preview = topUpPreview(fils(10000), member, TIERS_SALON, PROMOTIONS, now);

    expect(expected.promoPercent).toBe(0);
    expect(preview?.promoPercent).toBe(0);
    expect(preview?.creditFils).toBe(expected.credit);
  });

  it('agrees on the overlap, where the better of two live windows wins', () => {
    // 17:00-17:30 Sunday: HH-10 and HH-20 are both live.
    const now = kuwait('2026-08-30T17:15:00');
    const member = { tier: 'silver' } as Member;
    const expected = serverOracle(fils(10000), member, TIERS_SALON, PROMOTIONS, now);
    const preview = topUpPreview(fils(10000), member, TIERS_SALON, PROMOTIONS, now);

    expect(expected.promoPercent).toBe(20);
    expect(preview?.promoPercent).toBe(20);
    // 10% tier + 20% window on 10.000 KD.
    expect(preview?.creditFils).toBe(13000);
    expect(preview?.creditFils).toBe(expected.credit);
  });

  it('is deciding, not defaulting — the control', () => {
    /**
     * The guard the census note in DECISIONS calls for: a parity assertion that
     * can only pass because both sides computed the same thing, not because both
     * returned the same zero. These two instants differ ONLY in the clock, and
     * the server's own answer changes between them.
     */
    const member = { tier: 'silver' } as Member;
    const inside = serverOracle(fils(10000), member, TIERS_SALON, PROMOTIONS, kuwait('2026-08-30T16:30:00'));
    const outside = serverOracle(fils(10000), member, TIERS_SALON, PROMOTIONS, kuwait('2026-08-30T12:00:00'));
    expect(inside.credit).not.toBe(outside.credit);

    expect(topUpPreview(fils(10000), member, TIERS_SALON, PROMOTIONS, kuwait('2026-08-30T16:30:00'))?.creditFils)
      .toBe(inside.credit);
    expect(topUpPreview(fils(10000), member, TIERS_SALON, PROMOTIONS, kuwait('2026-08-30T12:00:00'))?.creditFils)
      .toBe(outside.credit);
  });
});
