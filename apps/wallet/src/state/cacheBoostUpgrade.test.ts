/**
 * A PROMOTION SET CACHED BEFORE MIGRATION 0067, read by this build.
 *
 * 0067 put `startsAt`, `endsAt`, `stoppedAt` and `stoppedBy` on `BoostSchema`,
 * required on the wire and nullable (trunk 7646bb8). Every device holds a Home
 * snapshot whose boosts are `{ visit, topup, stamp }` and nothing else. Read
 * strictly, that body fails and is discarded — a cold start for everyone who
 * updates, and the failure screen for anyone who opens the new build offline.
 * `state/cache.ts § LegacyCachedSchema` upgrades it instead, as it already does
 * a pre-0063 salon and a pre-0065 transaction:
 *
 *   · each missing key becomes `null` — exactly what the server serves for a
 *     pre-0067 boost: no window (unbounded both ways) and never stopped;
 *   · a boost that already carries them is kept as it is;
 *   · one pass upgrades a snapshot from before 0063, 0065 AND 0067;
 *   · presence is all that is relaxed — a malformed window, or a broken
 *     balance, is still discarded.
 */

import { describe, expect, it, vi } from 'vitest';
import { isBoostLive } from '@avo/types';

const store = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => void store.set(k, v),
    removeItem: async (k: string) => void store.delete(k),
  },
}));

/* eslint-disable import/first */
import { parseSnapshot, readSnapshot, SNAPSHOT_KEY } from './cache';

const HOURS = { morning: ['10:00', '13:00'], evening: ['16:00', '21:00'] };

const SALON = {
  id: 'SAL-AMARA',
  name: 'Amara',
  nameAr: 'أمارا',
  city: 'Kuwait City',
  plan: 'growth',
  brandColor: '#6E7F6C',
  modules: { booking: true, shop: true },
  loyaltyMode: 'tiers',
  tiers: [
    { name: 'bronze', minVisits: 0, bonusPercent: 0 },
    { name: 'silver', minVisits: 4, bonusPercent: 10 },
  ],
  stampTarget: 8,
  stampReward: 'Free blow-dry',
  stampRewardAr: 'تصفيف شعر مجاني',
  depositFils: 5000,
  noShowReturnMinutes: 60,
  timezone: 'Asia/Kuwait',
  businessHours: HOURS,
  branches: [
    { id: 'BR-KWC', salonId: 'SAL-AMARA', name: 'Kuwait City', nameAr: 'مدينة الكويت', businessHours: HOURS, businessHoursSource: 'salon' },
  ],
  social: [{ id: 'instagram', label: 'Instagram', handle: '@amara.kw', on: true }],
  whatsappEnabled: true,
  emailEnabled: true,
};

const PRE_0063_SALON = {
  ...SALON,
  branches: [{ id: 'BR-KWC', salonId: 'SAL-AMARA', name: 'Kuwait City', nameAr: 'مدينة الكويت' }],
};

const MEMBER = {
  id: '8842',
  salonId: 'SAL-AMARA',
  name: 'Dana Al-Sabah',
  phone: '+96599124408',
  email: 'dana@example.com',
  emailVerified: true,
  balanceFils: 24500,
  visits: 5,
  tier: 'silver',
  stamps: null,
  policyVersion: 3,
  joinedAt: '2026-02-11T18:20:00+03:00',
};

const CHARGE = {
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
};
/** As the build before 0065 cached it: no `loyalty` key. */
const PRE_0065_CHARGE = CHARGE;
const CURRENT_CHARGE = { ...CHARGE, loyalty: null };

/** A boost as the PREVIOUS build cached it: three keys, no window, no stop. */
const PRE_0067_BOOST = { visit: 2, topup: 10, stamp: 1 };
const WINDOW = {
  startsAt: '2026-09-01T00:00:00.000Z',
  endsAt: '2026-10-01T00:00:00.000Z',
  stoppedAt: null,
  stoppedBy: null,
};

function promotions(boosts: Record<string, unknown>) {
  return {
    boosts,
    boostsPublishedAt: '2026-08-10T06:00:00.000Z',
    boostsPublishedBy: 'Noura',
    happy: [],
  };
}

const CACHED_AT = 1_790_000_000_000;

function body(
  promo: unknown,
  { salon = SALON as unknown, member = MEMBER as unknown, transactions = [CURRENT_CHARGE] as unknown[] } = {},
) {
  return { snapshot: { member, salon, transactions, promotions: promo }, fetchedAt: CACHED_AT };
}

describe('a pre-0067 promotion set is upgraded, not discarded', () => {
  it('every boost without the four keys reads them as null — no window, never stopped', () => {
    const upgraded = parseSnapshot(body(promotions({ 'BR-KWC': PRE_0067_BOOST, 'BR-SAL': PRE_0067_BOOST })));
    expect(upgraded).not.toBeNull();
    const boosts = upgraded!.snapshot.promotions!.boosts;
    expect(Object.keys(boosts)).toEqual(['BR-KWC', 'BR-SAL']);
    for (const b of Object.values(boosts)) {
      expect(b).toEqual({ ...PRE_0067_BOOST, startsAt: null, endsAt: null, stoppedAt: null, stoppedBy: null });
    }
  });

  it('the upgraded boost is what the server would have said: running, unbounded', () => {
    const b = parseSnapshot(body(promotions({ 'BR-KWC': PRE_0067_BOOST })))!.snapshot.promotions!.boosts['BR-KWC']!;
    expect(isBoostLive(b, new Date('2020-01-01T00:00:00Z'))).toBe(true);
    expect(isBoostLive(b, new Date('2030-01-01T00:00:00Z'))).toBe(true);
  });

  it('touches nothing else — the values, the balance, the publish stamp are as cached', () => {
    const upgraded = parseSnapshot(body(promotions({ 'BR-KWC': PRE_0067_BOOST })))!;
    expect(upgraded.snapshot.member.balanceFils).toBe(24500);
    expect(upgraded.fetchedAt).toBe(CACHED_AT);
    expect(upgraded.snapshot.promotions!.boostsPublishedBy).toBe('Noura');
    const { startsAt: _s, endsAt: _e, stoppedAt: _t, stoppedBy: _b, ...rest } =
      upgraded.snapshot.promotions!.boosts['BR-KWC']!;
    expect(rest).toEqual(PRE_0067_BOOST);
  });

  it('a boost that was cached with its window is kept, beside one that needed the upgrade', () => {
    const upgraded = parseSnapshot(
      body(promotions({ 'BR-KWC': { ...PRE_0067_BOOST, ...WINDOW }, 'BR-SAL': PRE_0067_BOOST })),
    )!;
    expect(upgraded.snapshot.promotions!.boosts['BR-KWC']).toEqual({ ...PRE_0067_BOOST, ...WINDOW });
    expect(upgraded.snapshot.promotions!.boosts['BR-SAL']!.endsAt).toBeNull();
  });

  it('a current snapshot is read as it is, and a null set stays null', () => {
    const current = parseSnapshot(body(promotions({ 'BR-KWC': { ...PRE_0067_BOOST, ...WINDOW } })))!;
    expect(current.snapshot.promotions!.boosts['BR-KWC']).toEqual({ ...PRE_0067_BOOST, ...WINDOW });
    expect(parseSnapshot(body(null))!.snapshot.promotions).toBeNull();
  });

  it('a snapshot from before 0063, 0065 AND 0067 upgrades all three in one pass', () => {
    const upgraded = parseSnapshot(
      body(promotions({ 'BR-KWC': PRE_0067_BOOST }), { salon: PRE_0063_SALON, transactions: [PRE_0065_CHARGE] }),
    );
    expect(upgraded).not.toBeNull();
    expect(upgraded!.snapshot.salon.branches[0]!.businessHoursSource).toBe('salon');
    expect(upgraded!.snapshot.transactions[0]!.loyalty).toBeNull();
    expect(upgraded!.snapshot.promotions!.boosts['BR-KWC']!.stoppedAt).toBeNull();
  });

  it('relaxes presence only — a malformed window, or a broken balance, is still discarded', () => {
    expect(parseSnapshot(body(promotions({ 'BR-KWC': { ...PRE_0067_BOOST, endsAt: 'next week' } })))).toBeNull();
    expect(parseSnapshot(body(promotions({ 'BR-KWC': { ...PRE_0067_BOOST, visit: 1.5 } })))).toBeNull();
    expect(
      parseSnapshot(body(promotions({ 'BR-KWC': PRE_0067_BOOST }), { member: { ...MEMBER, balanceFils: 24.5 } })),
    ).toBeNull();
  });

  it('readSnapshot does the same from storage', async () => {
    store.set(SNAPSHOT_KEY, JSON.stringify(body(promotions({ 'BR-KWC': PRE_0067_BOOST }))));
    const read = await readSnapshot();
    expect(read?.snapshot.promotions?.boosts['BR-KWC']?.startsAt).toBeNull();
  });
});
