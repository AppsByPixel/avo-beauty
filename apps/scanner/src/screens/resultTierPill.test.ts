/**
 * THE RESULT SCREEN'S SUB-LINE AFTER A CLIMB — "Latifa A. · Gold", not Silver.
 *
 * The sub-line was the member card's pill from before the charge, so a charge
 * that crossed a rung rendered "Latifa A. · Silver" directly above "+1 visit ·
 * Reached Gold". Trunk ruled (2026-09-29) that after a climb it names the tier
 * she has now, `loyalty.tier`; every other case is unchanged. That is a
 * deliberate deviation from design:381 and `domain/loyalty.ts § resultPill`
 * records it.
 *
 * Cases are charge responses parsed through `ChargeResultSchema`, built on the
 * same wire body as resultLoyaltyLine.test.ts, so a shape the contract would
 * reject cannot pass here. The scanner has no renderer (see that file's header),
 * so the source scan at the bottom pins that `ResultScreen` draws the sub-line
 * through `resultPill` and no longer prints the pre-charge pill bare.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChargeResultSchema } from '../api/charges';
import { resultPill } from '../domain/loyalty';

const BASE = {
  transaction: {
    id: 'TX-9802919',
    memberId: '8842',
    branchId: 'BR-KWC',
    kind: 'charge',
    amountFils: -3000,
    bonusFils: 0,
    method: 'wallet',
    status: 'settled',
    reference: 'AVO-CHG-9802919',
    createdAt: '2026-08-18T10:20:31.000Z',
    customAmount: false,
    voidedAt: null,
    reversedByTransactionId: null,
  },
  balanceAfterFils: 16500,
  depositAppliedFils: 0,
  depositReturnedFils: 0,
  bookingId: null,
  voidableUntil: '2026-08-18T10:35:31.000Z',
  happyHour: null,
};

function loyaltyOf(loyalty: Record<string, unknown>) {
  return ChargeResultSchema.parse({ ...BASE, loyalty }).loyalty;
}

/** What MemberScreen computed from the scan, before the charge. */
const SILVER_BEFORE = 'Silver';

describe('after a charge that climbed a tier', () => {
  it('names the tier she has now, the same one "Reached Gold" names', () => {
    const loyalty = loyaltyOf({
      mode: 'tiers',
      visits: 10,
      tier: 'gold',
      nextTier: 'black',
      visitsToNext: 15,
      climbed: true,
      visitsEarned: 1,
    });
    expect(resultPill(SILVER_BEFORE, loyalty)).toBe('Gold');
  });

  it('to the top of the ladder too', () => {
    const loyalty = loyaltyOf({
      mode: 'tiers',
      visits: 25,
      tier: 'black',
      nextTier: null,
      visitsToNext: null,
      climbed: true,
    });
    expect(resultPill('Gold', loyalty)).toBe('Black');
  });
});

describe('every other charge keeps the pill as it was', () => {
  it('no climb', () => {
    const loyalty = loyaltyOf({
      mode: 'tiers',
      visits: 8,
      tier: 'silver',
      nextTier: 'gold',
      visitsToNext: 2,
      climbed: false,
    });
    expect(resultPill(SILVER_BEFORE, loyalty)).toBe('Silver');
  });

  it('an API too old to send `climbed` — nothing is inferred from the tier', () => {
    const loyalty = loyaltyOf({
      mode: 'tiers',
      visits: 10,
      tier: 'gold',
      nextTier: 'black',
      visitsToNext: 15,
    });
    expect(resultPill(SILVER_BEFORE, loyalty)).toBe('Silver');
  });

  it('a stamps salon', () => {
    const loyalty = loyaltyOf({ mode: 'stamps', stamps: 5, target: 8, rewardReady: false });
    expect(resultPill('4 / 8', loyalty)).toBe('4 / 8');
  });
});

describe('ResultScreen draws the sub-line through resultPill', () => {
  const src = readFileSync(join(__dirname, 'ResultScreen.tsx'), 'utf8');

  it('reads the charge response, not only the pre-charge pill', () => {
    expect(src).toContain('{memberName} · {resultPill(loyaltyPillText, result.loyalty)}');
    expect(src).not.toContain('{memberName} · {loyaltyPillText}');
  });
});
