/**
 * A WALLET SNAPSHOT CACHED BEFORE MIGRATION 0065, read by this build.
 *
 * 0065 made `TransactionSchema.loyalty` required on the wire (nullable). Every
 * device holds a snapshot whose transactions have no `loyalty` key, written by
 * the previous build. Read strictly, that body fails and is discarded — one cold
 * start for everyone, and the failure screen for anyone who opens the new build
 * offline. `state/cache.ts § LegacyCachedSchema` upgrades it instead, the way it
 * already upgrades a pre-0063 salon:
 *
 *   · a transaction with no `loyalty` key becomes `loyalty: null` — exactly what
 *     the server serves for a pre-0065 row, and never a guessed "+1 visit";
 *   · a record that IS there is kept as it is;
 *   · a snapshot from before BOTH migrations upgrades in one pass;
 *   · presence is all that is relaxed — a malformed `loyalty`, or a broken
 *     balance, is still discarded.
 */

import { describe, expect, it, vi } from 'vitest';

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

/** Two transactions as the PREVIOUS build cached them: thirteen keys, no `loyalty`. */
const PRE_0065_CHARGE = {
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
const PRE_0065_TOPUP = {
  ...PRE_0065_CHARGE,
  id: 'TX-2665307',
  kind: 'topup',
  amountFils: 11000,
  bonusFils: 1000,
  method: 'knet',
  reference: 'AVO-TOP-FAR19T',
};

const RECORD = { mode: 'tiers', visitsEarned: 2, tierAfter: 'silver', climbed: false, rewardReady: false };

const CACHED_AT = 1_790_000_000_000;

function body(transactions: unknown[], salon: unknown = SALON, member: unknown = MEMBER) {
  return { snapshot: { member, salon, transactions, promotions: null }, fetchedAt: CACHED_AT };
}

describe('a pre-0065 snapshot is upgraded, not discarded', () => {
  it('every transaction without the key reads loyalty: null — nothing recorded, nothing guessed', () => {
    const upgraded = parseSnapshot(body([PRE_0065_CHARGE, PRE_0065_TOPUP]));
    expect(upgraded).not.toBeNull();
    const txs = upgraded!.snapshot.transactions;
    expect(txs.map((t) => t.id)).toEqual(['TX-9802919', 'TX-2665307']);
    for (const t of txs) {
      expect(t).toHaveProperty('loyalty');
      expect(t.loyalty).toBeNull();
    }
  });

  it('touches nothing else — the balance, the amounts and the stamp are as cached', () => {
    const upgraded = parseSnapshot(body([PRE_0065_CHARGE]))!;
    expect(upgraded.snapshot.member.balanceFils).toBe(24500);
    expect(upgraded.fetchedAt).toBe(CACHED_AT);
    const { loyalty: _added, ...rest } = upgraded.snapshot.transactions[0]!;
    expect(rest).toEqual(PRE_0065_CHARGE);
  });

  it('a record that was cached is kept, beside a row that needed the upgrade', () => {
    const upgraded = parseSnapshot(body([{ ...PRE_0065_CHARGE, loyalty: RECORD }, PRE_0065_TOPUP]))!;
    expect(upgraded.snapshot.transactions[0]!.loyalty).toEqual(RECORD);
    expect(upgraded.snapshot.transactions[1]!.loyalty).toBeNull();
  });

  it('a current snapshot is read as it is', () => {
    const current = parseSnapshot(body([{ ...PRE_0065_CHARGE, loyalty: RECORD }]))!;
    expect(current.snapshot.transactions[0]!.loyalty).toEqual(RECORD);
  });

  it('a snapshot from before 0063 AND 0065 upgrades both in one pass', () => {
    const upgraded = parseSnapshot(body([PRE_0065_CHARGE], PRE_0063_SALON));
    expect(upgraded).not.toBeNull();
    expect(upgraded!.snapshot.salon.branches[0]!.businessHoursSource).toBe('salon');
    expect(upgraded!.snapshot.transactions[0]!.loyalty).toBeNull();
  });

  it('relaxes presence only — a malformed loyalty, or a broken balance, is still discarded', () => {
    expect(parseSnapshot(body([{ ...PRE_0065_CHARGE, loyalty: { mode: 'tiers' } }]))).toBeNull();
    expect(parseSnapshot(body([PRE_0065_CHARGE], SALON, { ...MEMBER, balanceFils: 24.5 }))).toBeNull();
    expect(parseSnapshot(body([{ ...PRE_0065_CHARGE, amountFils: -3000.5 }]))).toBeNull();
  });

  it('readSnapshot does the same from storage', async () => {
    store.set(SNAPSHOT_KEY, JSON.stringify(body([PRE_0065_CHARGE])));
    const read = await readSnapshot();
    expect(read?.snapshot.transactions[0]!.loyalty).toBeNull();
  });
});
