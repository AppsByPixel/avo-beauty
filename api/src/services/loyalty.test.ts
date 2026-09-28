/**
 * The pure halves of the loyalty rules — what a charge adds, and what a void
 * takes back. `routes/charges.ts § performVoid` and `services/charge.ts § 9`
 * call these; the int suite (`chargeLoyaltyRecord.int.test.ts`) proves the rows.
 */

import { describe, expect, it } from 'vitest';
import type { Tier } from '@avo/types';
import { applyStamps, applyVisits, reverseStamps, reverseVisits } from './loyalty';

/** The seeded Amara ladder: 0 / 4 / 10 / 20. */
const LADDER: Tier[] = [
  { name: 'bronze', minVisits: 0, bonusPercent: 0 },
  { name: 'silver', minVisits: 4, bonusPercent: 10 },
  { name: 'gold', minVisits: 10, bonusPercent: 20 },
  { name: 'black', minVisits: 20, bonusPercent: 30 },
];

describe('applyVisits / applyStamps say what they added', () => {
  it('visitsEarned is the increment applied, multiplier included', () => {
    expect(applyVisits(LADDER, 3, 'bronze', 1).visitsEarned).toBe(1);
    const doubled = applyVisits(LADDER, 3, 'bronze', 2);
    expect(doubled.visitsEarned).toBe(2);
    expect(doubled.visits).toBe(5);
    expect(doubled.tier).toBe('silver');
    expect(doubled.climbed).toBe(true);
  });

  it('stampsEarned is the increment applied', () => {
    const r = applyStamps(8, 6, 2);
    expect(r).toEqual({ mode: 'stamps', stamps: 8, target: 8, rewardReady: true, stampsEarned: 2 });
  });
});

describe('reverseVisits takes back exactly what was earned', () => {
  it('a doubled visit loses both', () => {
    expect(reverseVisits(LADDER, 7, 'silver', 2)).toEqual({
      visits: 5,
      tier: 'silver',
      visitsRemoved: 2,
      changed: false,
    });
  });

  it('re-evaluates the rung on the ladder: the charge that climbed her is undone, so is the climb', () => {
    // 3 + 2 (boosted) = 5 put her on Silver. Voiding it puts her back on Bronze.
    const r = reverseVisits(LADDER, 5, 'silver', 2);
    expect(r).toEqual({ visits: 3, tier: 'bronze', visitsRemoved: 2, changed: true });
  });

  it('subtracts from the count NOW, so a second till’s visit in between survives', () => {
    // Charge A +1 (4 → 5), charge B at another till +1 (5 → 6); void A.
    expect(reverseVisits(LADDER, 6, 'silver', 1).visits).toBe(5);
  });

  it('never goes below zero, and says how much it actually removed', () => {
    expect(reverseVisits(LADDER, 1, 'bronze', 2)).toEqual({
      visits: 0,
      tier: 'bronze',
      visitsRemoved: 1,
      changed: false,
    });
  });

  it('a negative earned is treated as nothing, not as a credit', () => {
    expect(reverseVisits(LADDER, 3, 'bronze', -2).visits).toBe(3);
  });
});

describe('reverseStamps', () => {
  it('takes back the stamps and nothing else', () => {
    expect(reverseStamps(8, 2)).toEqual({ stamps: 6, stampsRemoved: 2 });
  });

  it('clamps at zero — a card reset in between is not driven negative', () => {
    expect(reverseStamps(0, 1)).toEqual({ stamps: 0, stampsRemoved: 0 });
    expect(reverseStamps(1, 3)).toEqual({ stamps: 0, stampsRemoved: 1 });
  });
});
