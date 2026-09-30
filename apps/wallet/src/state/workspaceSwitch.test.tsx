// @vitest-environment jsdom

/**
 * ONE WALLET APP — the switching half. Sign in at Forest on a phone that last
 * held an Amara wallet, then sign out and back in at Amara.
 *
 * The auth calls go through the real client over a stubbed wire; the wallet's
 * reads are spies routed by whatever session is live, so "every read goes to
 * SAL-FOREST" is a statement about every call the wallet made. The claims:
 *
 *   A. a Forest session never paints Amara: every salon-scoped read names
 *      SAL-FOREST, no snapshot Home ever commits is Amara's, the palette is
 *      Forest's before the wallet mounts, and the card is forest green
 *      because Forest keeps its own colour (`walletCard: 'brand'`);
 *   B. a cached Amara wallet is REFUSED even on a path that forgot to clear
 *      it — `cache.ts § ownedBy`;
 *   C. sign-out then an Amara sign-in brings the tier colours back.
 *
 * THE CACHE DECISION, pinned: one snapshot key, dropped on a workspace change
 * and refused when it is not the session's. Not a key per salon.
 */

import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { brandPresets, deriveBrandSet } from '@avo/tokens';
import { theme } from '@avo/tokens/native';
import { MemberSchema, SalonSchema, type Member, type Salon, type TierName } from '@avo/types';

const store = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => void store.set(k, v),
    removeItem: async (k: string) => void store.delete(k),
    multiRemove: async (ks: string[]) => void ks.forEach((k) => store.delete(k)),
  },
}));
vi.mock('expo-linear-gradient', async () => {
  const { View } = await import('react-native');
  return {
    LinearGradient: ({ colors, children, style }: { colors: readonly string[]; children?: ReactNode; style?: object }) => (
      <View style={style} {...({ dataSet: { from: colors[0], to: colors[1] } } as object)}>
        {children}
      </View>
    ),
  };
});

const AMARA_HEX = brandPresets.amaraSage.brand;
const FOREST_HEX = brandPresets.forest.brand;

const HOURS = { morning: ['10:00', '13:00'], evening: ['16:00', '21:00'] };
const salonFixture = (id: string, name: string, brandColor: string, walletCard: 'tier' | 'brand'): Salon =>
  SalonSchema.parse({
    id,
    name,
    nameAr: null,
    city: 'Kuwait City',
    plan: 'growth',
    brandColor,
    walletCard,
    modules: { booking: true, shop: true },
    loyaltyMode: 'tiers',
    tiers: [
      { name: 'bronze', minVisits: 0, bonusPercent: 0 },
      { name: 'gold', minVisits: 4, bonusPercent: 10 },
    ],
    stampTarget: 8,
    stampReward: 'Free blow-dry',
    stampRewardAr: null,
    depositFils: 5000,
    noShowReturnMinutes: 60,
    timezone: 'Asia/Kuwait',
    businessHours: HOURS,
    branches: [
      { id: `BR-${id}`, salonId: id, name: 'Salmiya', nameAr: null, businessHours: HOURS, businessHoursSource: 'salon' },
    ],
    social: [],
    whatsappEnabled: true,
    emailEnabled: true,
  });

const SALONS: Record<string, Salon> = {
  'SAL-AMARA': salonFixture('SAL-AMARA', 'Amara', AMARA_HEX, 'tier'),
  'SAL-FOREST': salonFixture('SAL-FOREST', 'Forest', FOREST_HEX, 'brand'),
};

const memberAt = (salonId: string, id: string, balanceFils: number): Member =>
  MemberSchema.parse({
    id,
    salonId,
    name: 'Dana Al-Sabah',
    phone: '+96599124408',
    email: 'dana@example.com',
    emailVerified: true,
    balanceFils,
    visits: 5,
    tier: 'gold',
    stamps: null,
    policyVersion: 3,
    joinedAt: '2026-02-11T18:20:00+03:00',
  });

const AMARA_MEMBER = memberAt('SAL-AMARA', '8842', 99000);
const FOREST_MEMBER = memberAt('SAL-FOREST', 'F-77', 12000);
const MEMBERS: Record<string, Member> = { 'SAL-AMARA': AMARA_MEMBER, 'SAL-FOREST': FOREST_MEMBER };

// The wallet's reads, routed by whichever session is live — as the server would.
const { getMember, getSalon, getTransactions, getPromotions, getProducts } = vi.hoisted(() => ({
  getMember: vi.fn(),
  getSalon: vi.fn(),
  getTransactions: vi.fn(),
  getPromotions: vi.fn(),
  getProducts: vi.fn(),
}));
vi.mock('../api/wallet', () => ({ getMember, getSalon, getTransactions, getPromotions }));
vi.mock('../api/shop', () => ({ getProducts, placeOrder: vi.fn() }));

/* eslint-disable import/first */
import { signIn, signOut } from '../api/auth';
import { __resetSessionForTest, sessionOwner } from '../api/session';
import { SNAPSHOT_KEY, type WalletSnapshot } from './cache';
import { PREFERENCES_KEY } from './notifications';
import { useWalletHome } from './useWalletHome';
import { useShop } from './useShop';
import { enterWorkspace } from './workspace';
import { __resetLastWorkspaceForTest, lastWorkspace, rememberWorkspace } from './lastWorkspace';
import { applyBrandColor } from '../theme/brand';
import { cardInkFor } from '../theme/cardInk';
import { WalletCard } from '../components/WalletCard';
import { LanguageProvider } from '../i18n/language';

const derived = (hex: string) => {
  const r = deriveBrandSet(hex);
  if (!r.ok) throw new Error(`${hex} refused: ${r.reason}`);
  return r.set;
};

const gold = { mode: 'tiers', current: 'gold' as TierName, next: 'black' as TierName, visitsToNext: 3, fraction: 0.4 } as const;

/** Every POST to /auth, recorded; each answered by the next scripted reply. */
function stubAuth(replies: Array<{ status: number; body: unknown }>) {
  let i = 0;
  vi.stubGlobal('fetch', () => {
    const r = replies[Math.min(i++, replies.length - 1)]!;
    return Promise.resolve(
      r.status === 204 ? new Response(null, { status: 204 }) : new Response(JSON.stringify(r.body), { status: r.status }),
    );
  });
}

const sessionBody = (m: Member) => ({ accessToken: 'at', refreshToken: 'rt', expiresAt: '2026-10-01T00:00:00Z', member: m });

/** What an Amara session left behind: her wallet, cached, and Amara remembered. */
async function amaraLeftOnThePhone() {
  const snapshot: WalletSnapshot = {
    member: AMARA_MEMBER,
    salon: SALONS['SAL-AMARA']!,
    transactions: [],
    promotions: null,
  };
  store.set(SNAPSHOT_KEY, JSON.stringify({ snapshot, fetchedAt: 1_790_000_000_000 }));
  await rememberWorkspace({ salonId: 'SAL-AMARA', name: 'Amara', nameAr: 'أمارا', brandColor: AMARA_HEX });
  applyBrandColor(AMARA_HEX); // what Boot does with it
}

/** The shell's two hooks, with every snapshot Home ever committed. */
function mountWallet() {
  const seen: WalletSnapshot[] = [];
  const salonId = sessionOwner()!.salonId;
  const hook = renderHook(() => {
    const home = useWalletHome();
    if (home.snapshot && seen[seen.length - 1] !== home.snapshot) seen.push(home.snapshot);
    const shop = useShop(salonId, home.snapshot?.member.balanceFils ?? 0, home.retry, []);
    return { home, shop };
  });
  return { ...hook, seen };
}

function drawCard(snapshot: WalletSnapshot) {
  const r = render(
    <LanguageProvider initial="en">
      <WalletCard
        balanceFils={snapshot.member.balanceFils}
        pill="Gold"
        progress={gold}
        walletCard={snapshot.salon.walletCard}
        lastUpdated={null}
      />
    </LanguageProvider>,
  );
  return (r.container.querySelector('[data-from]') as HTMLElement).dataset;
}

/** Every salon id any salon-scoped read was asked for. */
const salonReads = () => [
  ...getSalon.mock.calls.map(([id]) => id as string),
  ...getPromotions.mock.calls.map(([id]) => id as string),
  ...getProducts.mock.calls.map(([id]) => id as string),
];

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
  __resetSessionForTest();
  __resetLastWorkspaceForTest();
  getMember.mockImplementation(async () => MEMBERS[sessionOwner()!.salonId]!);
  getSalon.mockImplementation(async (id: string) => SALONS[id]!);
  getTransactions.mockResolvedValue([]);
  getPromotions.mockResolvedValue({ boosts: {}, boostsPublishedAt: null, boostsPublishedBy: null, happy: [] });
  getProducts.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ═════════════════════════════════════════ A · a Forest sign-in over Amara ══

describe('A. after a Forest sign-in, it is Forest everywhere and Amara nowhere', () => {
  it('every read is SAL-FOREST, no committed snapshot is Amara’s, and the card is forest green', async () => {
    await amaraLeftOnThePhone();
    stubAuth([{ status: 200, body: sessionBody(FOREST_MEMBER) }]);

    const m = await signIn({ phone: '+96599124408', password: 'hunter22' });
    await enterWorkspace({ salonId: m.salonId, memberId: m.id });

    // Before the wallet mounts: her Amara wallet is gone, and the palette is Forest's.
    expect(store.has(SNAPSHOT_KEY)).toBe(false);
    expect(theme.color.brand).toBe(derived(FOREST_HEX).brand);
    expect(theme.card.from).toBe(derived(FOREST_HEX).cardFrom);

    const { result, seen } = mountWallet();
    await waitFor(() => expect(result.current.home.status).toBe('ready'));
    await waitFor(() => expect(getProducts).toHaveBeenCalled());

    expect(salonReads().length).toBeGreaterThanOrEqual(4);
    expect(new Set(salonReads())).toEqual(new Set(['SAL-FOREST']));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.salon.id === 'SAL-FOREST' && s.member.id === 'F-77')).toBe(true);
    expect(seen.some((s) => s.member.balanceFils === 99000)).toBe(false);

    const snap = result.current.home.snapshot!;
    expect(snap.salon.walletCard).toBe('brand');
    expect(cardInkFor(gold, snap.salon.walletCard).source).toBe('brand');
    const card = drawCard(snap);
    expect(card['from']).toBe(derived(FOREST_HEX).cardFrom);
    expect(card['to']).toBe(derived(FOREST_HEX).cardTo);
    expect(lastWorkspace()?.salonId).toBe('SAL-FOREST');
  });
});

// ═════════════════════════════════════════ B · the guard on the read ══

describe('B. a cached wallet that is not the session’s is refused, even un-cleared', () => {
  it('a Forest session with Amara still in storage never seeds Home with Amara', async () => {
    await amaraLeftOnThePhone();
    stubAuth([{ status: 200, body: sessionBody(FOREST_MEMBER) }]);
    await signIn({ phone: '+96599124408', password: 'hunter22' });
    // Deliberately NO enterWorkspace — the path that forgot.
    getMember.mockImplementation(() => new Promise(() => undefined)); // the live read never lands

    const { result } = mountWallet();
    // Give the seed every chance to happen.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(result.current.home.snapshot).toBeNull();
    expect(result.current.home.status).toBe('loading');
  });

  it('her OWN cached wallet at the same workspace still seeds (the offline Home is kept)', async () => {
    await amaraLeftOnThePhone();
    stubAuth([{ status: 200, body: sessionBody(AMARA_MEMBER) }]);
    const m = await signIn({ phone: '+96599124408', password: 'hunter22' });
    await enterWorkspace({ salonId: m.salonId, memberId: m.id });
    expect(store.has(SNAPSHOT_KEY)).toBe(true);
    getMember.mockImplementation(() => new Promise(() => undefined));

    const { result } = mountWallet();
    await waitFor(() => expect(result.current.home.snapshot?.member.balanceFils).toBe(99000));
  });
});

// ═════════════════════════════════════════ C · back to Amara ══

describe('C. sign-out, then an Amara sign-in, brings the tier colours back', () => {
  it('Forest → sign out → Amara: Amara reads, Amara palette, a gold card', async () => {
    await amaraLeftOnThePhone();
    stubAuth([
      { status: 200, body: sessionBody(FOREST_MEMBER) },
      { status: 204, body: null },
      { status: 200, body: sessionBody(AMARA_MEMBER) },
    ]);

    // Forest.
    let m = await signIn({ phone: '+96599124408', password: 'hunter22' });
    await enterWorkspace({ salonId: m.salonId, memberId: m.id });
    const forest = mountWallet();
    await waitFor(() => expect(forest.result.current.home.status).toBe('ready'));
    expect(drawCard(forest.result.current.home.snapshot!)['from']).toBe(derived(FOREST_HEX).cardFrom);

    // Sign out, exactly as the shell does it: revoke, forget, drop the local copies.
    await signOut();
    store.delete(SNAPSHOT_KEY);
    store.delete(PREFERENCES_KEY);
    forest.unmount();
    cleanup();
    expect(sessionOwner()).toBeNull();
    // The sign-in screen after it is Forest's — the last workspace survives sign-out.
    expect(lastWorkspace()?.salonId).toBe('SAL-FOREST');
    vi.clearAllMocks();

    // Amara.
    m = await signIn({ phone: '+96599124408', password: 'hunter22' });
    await enterWorkspace({ salonId: m.salonId, memberId: m.id });
    expect(theme.color.brand).toBe(derived(AMARA_HEX).brand);

    const amara = mountWallet();
    await waitFor(() => expect(amara.result.current.home.status).toBe('ready'));
    await waitFor(() => expect(getProducts).toHaveBeenCalled());
    expect(new Set(salonReads())).toEqual(new Set(['SAL-AMARA']));
    expect(amara.seen.every((s) => s.salon.id === 'SAL-AMARA')).toBe(true);

    const snap = amara.result.current.home.snapshot!;
    expect(snap.salon.walletCard).toBe('tier');
    const ink = cardInkFor(gold, snap.salon.walletCard);
    expect(ink.source).toBe('gold');
    const card = drawCard(snap);
    expect(card['from']).toBe(ink.from);
    expect(card['from']).not.toBe(derived(FOREST_HEX).cardFrom);
    expect(card['from']).not.toBe(derived(AMARA_HEX).cardFrom);
    expect(lastWorkspace()?.salonId).toBe('SAL-AMARA');
  });
});
