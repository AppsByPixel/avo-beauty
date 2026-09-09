/**
 * The Membership model, and specifically the two things about it that a screen
 * cannot be trusted to reveal: how many rungs it renders, and which language the
 * stamp reward comes back in.
 *
 * Neither is hypothetical. A four-row table is what Lane C shipped on the
 * merchant side for a salon with two rungs, and an English reward on an Arabic
 * card is what this wallet shipped for as long as `stampRewardAr` has been on
 * the wire. `loyaltyProgress` had no test file at all before this one.
 */

import { describe, expect, it } from 'vitest';
import type { Member, Salon } from '@avo/types';
import { ILLUSTRATION_BASE, membershipView } from './membership';

/**
 * Amara's ladder, exactly as `api/src/db/seed.ts:429-432` and
 * `packages/mock/src/fixtures.ts:42-45` both seed it.
 */
const AMARA_TIERS = [
  { name: 'bronze', minVisits: 0, bonusPercent: 0 },
  { name: 'silver', minVisits: 4, bonusPercent: 10 },
  { name: 'gold', minVisits: 10, bonusPercent: 20 },
  { name: 'black', minVisits: 20, bonusPercent: 30 },
] as const;

function salon(over: Partial<Salon> = {}): Salon {
  return {
    name: 'Amara',
    nameAr: 'أمارا',
    loyaltyMode: 'tiers',
    tiers: [...AMARA_TIERS],
    modules: { booking: false, shop: false },
    ...over,
  } as unknown as Salon;
}

function member(over: Partial<Member> = {}): Member {
  return { tier: 'silver', visits: 6, stamps: null, ...over } as unknown as Member;
}

describe('the tier ladder renders the rungs that exist', () => {
  it('renders four for Amara, in ascending order, with her own rung marked', () => {
    const view = membershipView(member(), salon(), 'en');
    expect(view?.mode).toBe('tiers');
    if (view?.mode !== 'tiers') return;

    expect(view.rungs.map((r) => r.name)).toEqual(['bronze', 'silver', 'gold', 'black']);
    expect(view.rungs.filter((r) => r.current).map((r) => r.name)).toEqual(['silver']);
  });

  /**
   * THE ONE THIS FILE EXISTS FOR. SAL-LUMIERE is seeded with two rungs and
   * `stampTarget: null` (`seed.ts:529-534`) and is a live tenant.
   */
  it('renders TWO for a two-rung salon, and invents no third', () => {
    const lumiere = salon({
      name: 'Lumiere',
      nameAr: null,
      tiers: [
        { name: 'bronze', minVisits: 0, bonusPercent: 0 },
        { name: 'silver', minVisits: 4, bonusPercent: 10 },
      ],
    });
    const view = membershipView(member(), lumiere, 'en');
    if (view?.mode !== 'tiers') throw new Error('expected the tier variant');

    expect(view.rungs).toHaveLength(2);
    expect(view.rungs.map((r) => r.name)).toEqual(['bronze', 'silver']);
  });

  it('sorts by minVisits rather than trusting the array order', () => {
    const shuffled = salon({ tiers: [AMARA_TIERS[2], AMARA_TIERS[0], AMARA_TIERS[3], AMARA_TIERS[1]] });
    const view = membershipView(member(), shuffled, 'en');
    if (view?.mode !== 'tiers') throw new Error('expected the tier variant');
    expect(view.rungs.map((r) => r.minVisits)).toEqual([0, 4, 10, 20]);
  });

  it('marks nothing when the member is on no rung the salon still has', () => {
    const view = membershipView(member({ tier: 'black' }), salon({ tiers: [AMARA_TIERS[0]] }), 'en');
    if (view?.mode !== 'tiers') throw new Error('expected the tier variant');
    expect(view.rungs.some((r) => r.current)).toBe(false);
  });

  it('renders nothing at all for a salon with an empty ladder', () => {
    expect(membershipView(member(), salon({ tiers: [] }), 'en')).toBeNull();
    expect(membershipView(member(), salon({ tiers: undefined }), 'en')).toBeNull();
  });
});

describe('the bonus illustration is integer money, drawn against 10 KD', () => {
  it('is 10 KD, per design:1716-1719', () => {
    expect(ILLUSTRATION_BASE).toBe(10_000);
  });

  it('matches the four figures the design prints', () => {
    const view = membershipView(member(), salon(), 'en');
    if (view?.mode !== 'tiers') throw new Error('expected the tier variant');
    expect(view.rungs.map((r) => `${r.base} -> ${r.credited}`)).toEqual([
      '10 -> 10', // design:1716
      '10 -> 11', // design:1717
      '10 -> 12', // design:1718
      '10 -> 13', // design:1719
    ]);
  });

  /**
   * A rate that does not land on a whole dinar must not be tidied into one. 25%
   * of 10.000 is 2.500, so the credited figure is 12.500 and it says so.
   */
  it('falls back to the real money format when the rate does not divide evenly', () => {
    const view = membershipView(
      member(),
      salon({ tiers: [{ name: 'silver', minVisits: 4, bonusPercent: 25 }] }),
      'en',
    );
    if (view?.mode !== 'tiers') throw new Error('expected the tier variant');
    expect(view.rungs[0]!.credited).toBe('12.500');
  });
});

describe('the stamp card', () => {
  const stamps = (over: Partial<Salon> = {}) =>
    salon({
      loyaltyMode: 'stamps',
      tiers: undefined,
      stampTarget: 8,
      stampReward: 'Free blow-dry',
      stampRewardAr: 'تصفيف شعر مجاني',
      ...over,
    });

  it('counts what is left, and never below zero on a full card', () => {
    const four = membershipView(member({ stamps: 4 }), stamps(), 'en');
    if (four?.mode !== 'stamps') throw new Error('expected the stamps variant');
    expect([four.have, four.target, four.remaining]).toEqual([4, 8, 4]);

    const over = membershipView(member({ stamps: 9 }), stamps(), 'en');
    if (over?.mode !== 'stamps') throw new Error('expected the stamps variant');
    expect(over.remaining).toBe(0);
  });

  /**
   * The Arabic bug. `loyaltyProgress` read `salon.stampReward` unconditionally
   * while `stampRewardAr` sat on the wire, so an Arabic card said "Free
   * blow-dry". Two languages, one salon, two different strings.
   */
  it('returns the reward in the reading language', () => {
    const en = membershipView(member({ stamps: 4 }), stamps(), 'en');
    const ar = membershipView(member({ stamps: 4 }), stamps(), 'ar');
    expect(en?.mode === 'stamps' && en.reward).toBe('Free blow-dry');
    expect(ar?.mode === 'stamps' && ar.reward).toBe('تصفيف شعر مجاني');
  });

  /** SAL-LUMIERE's `stampRewardAr` is NULL on purpose, so the fallback is live. */
  it('falls back to the base reward when the salon has no Arabic one', () => {
    const view = membershipView(member({ stamps: 1 }), stamps({ stampRewardAr: null }), 'ar');
    expect(view?.mode === 'stamps' && view.reward).toBe('Free blow-dry');
  });

  /**
   * Null, not "". Two of the three stamp strings NAME the reward, so the
   * component has to be able to tell "no reward configured" from an empty one.
   */
  it('reports a missing reward as null in both languages', () => {
    for (const lang of ['en', 'ar'] as const) {
      const view = membershipView(
        member({ stamps: 1 }),
        stamps({ stampReward: undefined, stampRewardAr: null }),
        lang,
      );
      expect(view?.mode === 'stamps' && view.reward).toBeNull();
    }
  });

  it('carries the shop module through, because one rule depends on it', () => {
    const off = membershipView(member({ stamps: 1 }), stamps(), 'en');
    expect(off?.mode === 'stamps' && off.shopCounts).toBe(false);

    const on = membershipView(
      member({ stamps: 1 }),
      stamps({ modules: { booking: false, shop: true } }),
      'en',
    );
    expect(on?.mode === 'stamps' && on.shopCounts).toBe(true);
  });

  it('renders nothing when the salon runs stamps with no target', () => {
    expect(membershipView(member({ stamps: 3 }), stamps({ stampTarget: undefined }), 'en')).toBeNull();
    expect(membershipView(member({ stamps: 3 }), stamps({ stampTarget: 0 }), 'en')).toBeNull();
  });

  it('treats a null stamp counter as nothing collected', () => {
    const view = membershipView(member({ stamps: null }), stamps(), 'en');
    expect(view?.mode === 'stamps' && view.have).toBe(0);
  });
});
