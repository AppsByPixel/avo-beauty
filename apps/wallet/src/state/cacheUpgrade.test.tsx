// @vitest-environment jsdom

/**
 * THE UPGRADE-DAY HAZARD — a wallet snapshot cached by the PREVIOUS app
 * version, loaded by this one.
 *
 * Migration 0063 made `BranchSchema` require `businessHours` and
 * `businessHoursSource`. Every existing customer's device holds a snapshot
 * whose branches have neither, written the last time she opened the app. The
 * day she updates, this build reads that body. It must not crash Home, blank
 * the salon, or put her on an error screen.
 *
 * Pinned through the real `useWalletHome` and the real `cache.ts`, with only
 * AsyncStorage (an in-memory map) and the four wallet reads doubled:
 *
 *   1. the pre-0063 body is UPGRADED, not discarded — each branch takes the
 *      salon's hours, `businessHoursSource: 'salon'`, which is exactly what the
 *      server resolved for a branch with no override (there were none before
 *      0063). Member, balance and transactions are untouched;
 *   2. online, Home seeds from it and then lands on the live read — `ready`,
 *      never `error`;
 *   3. OFFLINE on upgrade day, Home keeps her last-known wallet (`offline`)
 *      rather than the cold failure screen;
 *   4. a body this build cannot read at all is "refetch" — skeletons, then the
 *      live read — never an error screen and never a throw.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Member, Salon } from '@avo/types';

const store = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => void store.set(k, v),
    removeItem: async (k: string) => void store.delete(k),
    multiRemove: async (ks: string[]) => void ks.forEach((k) => store.delete(k)),
  },
}));

const { getMember, getSalon, getTransactions, getPromotions } = vi.hoisted(() => ({
  getMember: vi.fn(),
  getSalon: vi.fn(),
  getTransactions: vi.fn(),
  getPromotions: vi.fn(),
}));
vi.mock('../api/wallet', () => ({ getMember, getSalon, getTransactions, getPromotions }));

/* eslint-disable import/first */
import { parseSnapshot, readSnapshot, SNAPSHOT_KEY } from './cache';
import { useWalletHome, type HomeStatus } from './useWalletHome';
import { ApiError } from '../api/client';

// ------------------------------------------------------------------ fixtures --

const HOURS = { morning: ['10:00', '13:00'], evening: ['16:00', '21:00'] };

/** `GET /salons/SAL-AMARA` as THIS build's API serves it — branches with hours. */
const LIVE_SALON = {
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
    { id: 'BR-SAL', salonId: 'SAL-AMARA', name: 'Salmiya', nameAr: 'السالمية', businessHours: { morning: ['09:00', '21:00'], evening: ['21:00', '21:00'] }, businessHoursSource: 'branch' },
    { id: 'BR-KWC', salonId: 'SAL-AMARA', name: 'Kuwait City', nameAr: 'مدينة الكويت', businessHours: HOURS, businessHoursSource: 'salon' },
  ],
  social: [{ id: 'instagram', label: 'Instagram', handle: '@amara.kw', on: true }],
  whatsappEnabled: true,
  emailEnabled: true,
};

/** The same salon as the PREVIOUS build cached it: branches carry no hours. */
const PRE_0063_SALON = {
  ...LIVE_SALON,
  branches: [
    { id: 'BR-SAL', salonId: 'SAL-AMARA', name: 'Salmiya', nameAr: 'السالمية' },
    { id: 'BR-KWC', salonId: 'SAL-AMARA', name: 'Kuwait City', nameAr: 'مدينة الكويت' },
  ],
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

const CACHED_AT = 1_790_000_000_000;

function cacheBody(salon: unknown, member: unknown = MEMBER) {
  return { snapshot: { member, salon, transactions: [], promotions: null }, fetchedAt: CACHED_AT };
}

/** Records every status Home committed, so "never error" is a statement about all of them. */
function mountHome() {
  const seen: HomeStatus[] = [];
  const hook = renderHook(() => {
    const home = useWalletHome();
    if (seen[seen.length - 1] !== home.status) seen.push(home.status);
    return home;
  });
  return { ...hook, seen };
}

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  getMember.mockResolvedValue({ ...MEMBER, balanceFils: 30000 } as Member);
  getSalon.mockResolvedValue(LIVE_SALON as unknown as Salon);
  getTransactions.mockResolvedValue([]);
  getPromotions.mockResolvedValue({ boosts: {}, boostsPublishedAt: null, boostsPublishedBy: null, happy: [] });
});

// ═══════════════════════════════════════════════════════ 1 · the upgrade ══

describe('1. a pre-0063 snapshot is upgraded, not discarded', () => {
  it('each branch takes the SALON’s hours, source "salon" — what the server resolved then', () => {
    const upgraded = parseSnapshot(cacheBody(PRE_0063_SALON));
    expect(upgraded).not.toBeNull();
    for (const branch of upgraded!.snapshot.salon.branches) {
      expect(branch.businessHours).toEqual(HOURS);
      expect(branch.businessHoursSource).toBe('salon');
    }
    expect(upgraded!.snapshot.salon.branches.map((b) => b.id)).toEqual(['BR-SAL', 'BR-KWC']);
  });

  it('touches nothing else — her balance and the stamp are exactly what was cached', () => {
    const upgraded = parseSnapshot(cacheBody(PRE_0063_SALON))!;
    expect(upgraded.snapshot.member.balanceFils).toBe(24500);
    expect(upgraded.fetchedAt).toBe(CACHED_AT);
    expect(upgraded.snapshot.salon.businessHours).toEqual(HOURS);
  });

  it('a current snapshot is read as it is — a branch override is not overwritten', () => {
    const current = parseSnapshot(cacheBody(LIVE_SALON))!;
    expect(current.snapshot.salon.branches[0]!.businessHoursSource).toBe('branch');
    expect(current.snapshot.salon.branches[0]!.businessHours.morning).toEqual(['09:00', '21:00']);
  });

  it('the relaxation is the two 0063 fields ONLY — a broken member is still discarded', () => {
    expect(parseSnapshot(cacheBody(PRE_0063_SALON, { ...MEMBER, balanceFils: 24.5 }))).toBeNull();
    expect(parseSnapshot(cacheBody({ ...PRE_0063_SALON, businessHours: undefined }))).toBeNull();
  });

  it('readSnapshot does the same from storage', async () => {
    store.set(SNAPSHOT_KEY, JSON.stringify(cacheBody(PRE_0063_SALON)));
    const read = await readSnapshot();
    expect(read?.snapshot.salon.branches[1]!.businessHours).toEqual(HOURS);
  });
});

// ═════════════════════════════════════════════════ 2 · online, on the day ══

describe('2. online on upgrade day — Home seeds from the old cache, then goes live', () => {
  it('never an error; lands on the live salon, with its real hours', async () => {
    store.set(SNAPSHOT_KEY, JSON.stringify(cacheBody(PRE_0063_SALON)));
    const { result, seen } = mountHome();
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(seen).not.toContain('error');
    expect(result.current.snapshot!.member.balanceFils).toBe(30000);
    expect(result.current.snapshot!.salon.branches[0]!.businessHoursSource).toBe('branch');
    // And the cache is rewritten in the new shape for next time.
    await waitFor(() => {
      const raw = JSON.parse(store.get(SNAPSHOT_KEY)!);
      expect(raw.snapshot.salon.branches[0].businessHours).toBeDefined();
    });
  });
});

// ════════════════════════════════════════════════ 3 · offline, on the day ══

describe('3. OFFLINE on upgrade day — her last-known wallet, not the failure screen', () => {
  it('status offline, the cached balance, the salon with hours on every branch', async () => {
    store.set(SNAPSHOT_KEY, JSON.stringify(cacheBody(PRE_0063_SALON)));
    getMember.mockRejectedValue(new ApiError('offline', 'No connection.', 'WLT-0000-0001', null));
    const { result, seen } = mountHome();
    await waitFor(() => expect(result.current.status).toBe('offline'));
    expect(seen).not.toContain('error');
    expect(result.current.snapshot!.member.balanceFils).toBe(24500);
    expect(result.current.fetchedAt).toBe(CACHED_AT);
    expect(result.current.snapshot!.salon.branches.every((b) => b.businessHours !== undefined)).toBe(true);
  });
});

// ════════════════════════════════════════ 4 · a body nothing can read ══

describe('4. an unreadable cache is "refetch" — never an error screen, never a throw', () => {
  it.each([
    ['not JSON', '{"snapshot":'],
    ['a shape from nowhere', JSON.stringify({ snapshot: { member: 7 }, fetchedAt: 'yesterday' })],
  ])('%s → skeletons, then the live read', async (_label, raw) => {
    store.set(SNAPSHOT_KEY, raw);
    await expect(readSnapshot()).resolves.toBeNull();
    const { result, seen } = mountHome();
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(seen).toEqual(['loading', 'ready']);
    expect(result.current.snapshot!.salon.branches).toHaveLength(2);
  });
});
