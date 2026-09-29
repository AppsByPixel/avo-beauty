// @vitest-environment jsdom

/**
 * THE SALON'S BRAND, APPLIED THE WAY THE APP ACTUALLY LEARNS IT — rendered.
 *
 * Found live by trunk, 2026-09-29: a build for SAL-FOREST, signed in as Forest's
 * member Maha, drew the wallet card in the shipped default `#4EA744` — not
 * Forest's `#277144 → #153C24` — and so did every brand accent on the page. The
 * `#4EA744` is diagnostic: it is the token file's DEFAULT `card.from`, not the
 * derived Amara set (`#4FB045`), so nothing had been applied at all.
 *
 * `applyBrandColor` was being called — by `Boot.tsx`, with the hex cached from a
 * PREVIOUS launch. The salon read that actually carries the hex happens after
 * sign-in, inside `useWalletHome`, and all it did was write the cache "for the
 * NEXT launch", because the palette had been sealed the moment the first
 * stylesheet was evaluated. So the session in which a device first learns its
 * salon's colour — every new customer's first session, and every session after
 * a salon read had never succeeded (the `stampTarget: null` refusal guaranteed
 * that on trunk's simulator) — ran in the default palette end to end.
 *
 * `walletCardBrandRender.test.tsx` could not see this: it applies the brand
 * BEFORE importing anything, i.e. it tests the second launch. Every case here
 * goes through the path the running app takes instead: the components are
 * already imported and on screen, and the hex arrives from `useWalletHome`'s
 * salon read over a mocked `api/wallet`.
 */

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { Text } from 'react-native';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { brandPresets, color as defaults, deriveBrandSet, type BrandSet } from '@avo/tokens';
import { fils, type Member, type Salon } from '@avo/types';

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

vi.mock('expo-linear-gradient', async () => {
  const { View } = await import('react-native');
  return {
    LinearGradient: ({
      colors,
      children,
      style,
    }: {
      colors: readonly string[];
      children?: ReactNode;
      style?: object;
    }) => (
      <View style={style} {...({ dataSet: { from: colors[0], to: colors[1] } } as object)}>
        {children}
      </View>
    ),
  };
});
vi.mock('react-native-qrcode-svg', () => ({ default: () => null }));

// ------------------------------------------------------------------ fixtures --

const FOREST = brandPresets.forest.brand; // #1F5A36
const AMARA = brandPresets.amaraSage.brand; // #459A3C
const LILAC = brandPresets.lilaLilac.brand;
/** Refused by the shared package: 4.25:1 at the full darkening budget. */
const REFUSED = '#FFFF00';

function derived(hex: string): BrandSet {
  const r = deriveBrandSet(hex);
  if (!r.ok) throw new Error(`${hex} was refused: ${r.reason}`);
  return r.set;
}

/** The palette the token file ships, before any salon is applied. */
const DEFAULTS = {
  brand: defaults.brand,
  deep: defaults.brandDeep,
  tint: defaults.brandTint,
  cardFrom: brandPresets.amaraSage.cardFrom,
  cardTo: brandPresets.amaraSage.cardTo,
};

const MAHA = {
  id: 'MEM-MAHA',
  salonId: 'SAL-FOREST',
  name: 'Maha',
  balanceFils: 24500,
  tier: 'gold',
} as unknown as Member;

function salon(brandColor: string): Salon {
  return {
    id: 'SAL-FOREST',
    name: 'Forest',
    brandColor,
    walletCard: 'brand',
    loyaltyMode: 'tiers',
    timezone: 'Asia/Kuwait',
    tiers: [
      { name: 'bronze', bonusPercent: 0 },
      { name: 'gold', bonusPercent: 10 },
    ],
    branches: [],
    modules: { booking: true },
  } as unknown as Salon;
}

const gold = {
  mode: 'tiers',
  current: 'gold',
  next: 'black',
  visitsToNext: 3,
  fraction: 0.4,
} as const;

function serveSalon(brandColor: string) {
  getMember.mockResolvedValue(MAHA);
  getSalon.mockResolvedValue(salon(brandColor));
  getTransactions.mockResolvedValue([]);
  getPromotions.mockResolvedValue({ boosts: {}, boostsPublishedAt: null, boostsPublishedBy: null, happy: [] });
}

// ------------------------------------------------------------------- helpers --

function rgb(hex: string): string {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

type Mods = {
  useWalletHome: typeof import('../state/useWalletHome').useWalletHome;
  WalletCard: typeof import('../components/WalletCard').WalletCard;
  TopUpCard: typeof import('../components/TopUpCard').TopUpCard;
  PrimaryButton: typeof import('../components/Buttons').PrimaryButton;
  SecondaryButton: typeof import('../components/Buttons').SecondaryButton;
  SignInScreen: typeof import('../screens/SignInScreen').SignInScreen;
  LanguageProvider: typeof import('../i18n/language').LanguageProvider;
  en: typeof import('../copy/en').en;
  useBrandRepaint: typeof import('./live').useBrandRepaint;
};

/** Imported fresh per test: each case is its own launch. */
async function launch(): Promise<Mods> {
  const [home, card, topUp, buttons, signIn, language, copy, live] = await Promise.all([
    import('../state/useWalletHome'),
    import('../components/WalletCard'),
    import('../components/TopUpCard'),
    import('../components/Buttons'),
    import('../screens/SignInScreen'),
    import('../i18n/language'),
    import('../copy/en'),
    import('./live'),
  ]);
  return {
    useWalletHome: home.useWalletHome,
    WalletCard: card.WalletCard,
    TopUpCard: topUp.TopUpCard,
    PrimaryButton: buttons.PrimaryButton,
    SecondaryButton: buttons.SecondaryButton,
    SignInScreen: signIn.SignInScreen,
    LanguageProvider: language.LanguageProvider,
    en: copy.en,
    useBrandRepaint: live.useBrandRepaint,
  };
}

/**
 * Home's brand surfaces, fed by the real `useWalletHome`, under a root that
 * subscribes to repaints exactly as `App` does. The tap counter is local state
 * that a re-mount would lose — the repaint has to keep it.
 */
function homeHarness(m: Mods) {
  function Home() {
    m.useBrandRepaint();
    const home = m.useWalletHome();
    const [taps, setTaps] = useState(0);
    return (
      <m.LanguageProvider initial="en">
        <Text testID="status">{home.status}</Text>
        <Text testID="taps">{String(taps)}</Text>
        <m.WalletCard
          balanceFils={24500}
          pill="Gold"
          progress={gold}
          walletCard="brand"
          lastUpdated="Last updated just now"
        >
          {null}
        </m.WalletCard>
        <m.TopUpCard
          member={MAHA}
          salon={home.snapshot?.salon ?? salon(FOREST)}
          promotions={null}
          selected={fils(10000)}
          onSelect={() => {}}
          onContinue={() => {}}
        />
        <m.PrimaryButton label="Continue" testID="primary" onPress={() => setTaps((t) => t + 1)} />
        <m.SecondaryButton label="Back" testID="secondary" onPress={() => {}} />
      </m.LanguageProvider>
    );
  }
  return render(<Home />);
}

/** What Home actually drew, read off the rendered DOM. */
function drawn(r: ReturnType<typeof render>) {
  const card = r.container.querySelector('[data-from]') as HTMLElement;
  const tile = r.getByTestId('topup-amount-10000');
  const tileText = tile.firstElementChild as HTMLElement;
  const primary = r.getByTestId('primary');
  const secondaryText = r.getByTestId('secondary').firstElementChild as HTMLElement;
  return {
    cardFrom: card.dataset.from,
    cardTo: card.dataset.to,
    tileBorder: getComputedStyle(tile).borderTopColor,
    tileFill: getComputedStyle(tile).backgroundColor,
    tileText: getComputedStyle(tileText).color,
    primaryFill: getComputedStyle(primary).backgroundColor,
    secondaryText: getComputedStyle(secondaryText).color,
  };
}

function expected(set: { deep: string; tint: string; cardFrom: string; cardTo: string }) {
  return {
    cardFrom: set.cardFrom,
    cardTo: set.cardTo,
    tileBorder: rgb(set.deep),
    tileFill: rgb(set.tint),
    tileText: rgb(set.deep),
    primaryFill: rgb(set.deep),
    secondaryText: rgb(set.deep),
  };
}

async function ready(r: ReturnType<typeof render>) {
  await waitFor(() => expect(r.getByTestId('status').textContent).toBe('ready'));
}

beforeEach(() => {
  vi.resetModules();
  store.clear();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// --------------------------------------------------------------------- cases --

describe('a fresh install signs in to Forest — the salon read re-colours the running app', () => {
  it('starts in the shipped default, because nothing is cached and nothing has been read', async () => {
    serveSalon(FOREST);
    getMember.mockReturnValue(new Promise(() => {})); // the read never lands
    const r = homeHarness(await launch());
    expect(drawn(r)).toEqual(expected(DEFAULTS));
  });

  it("draws the card #277144 → #153C24 and every accent in forest's derived set", async () => {
    serveSalon(FOREST);
    const r = homeHarness(await launch());
    await ready(r);

    const now = drawn(r);
    expect(now).toEqual(expected(derived(FOREST)));
    // The literal figures trunk measured, so a derivation change cannot move
    // both sides of the assertion at once.
    expect(now.cardFrom).toBe('#277144');
    expect(now.cardTo).toBe('#153C24');
    expect(now.primaryFill).toBe(rgb('#1F5A36'));
    expect(now.cardFrom).not.toBe(DEFAULTS.cardFrom);
  });

  it('keeps what is on screen — a repaint, not a re-mount', async () => {
    serveSalon(FOREST);
    getMember.mockReturnValueOnce(new Promise(() => {})); // first load hangs
    const m = await launch();
    const r = homeHarness(m);
    act(() => r.getByTestId('primary').click());
    act(() => r.getByTestId('primary').click());
    expect(r.getByTestId('taps').textContent).toBe('2');

    const { applyBrandColor } = await import('./brand');
    act(() => {
      applyBrandColor(FOREST);
    });
    expect(drawn(r)).toEqual(expected(derived(FOREST)));
    expect(r.getByTestId('taps').textContent).toBe('2');
  });

  it('writes the hex for the next launch as well', async () => {
    serveSalon(FOREST);
    const r = homeHarness(await launch());
    await ready(r);
    await waitFor(() => expect(store.get('avo.wallet.brand.v1')).toBe(FOREST));
  });
});

describe("Amara's own hex", () => {
  /**
   * The same values the dashboard's `useBrandTheme` writes for Amara, and the
   * same values this app already drew on every launch after the first (Boot
   * applied the cached hex through the same `deriveBrandSet`). So for an Amara
   * member nothing moves from today's steady state.
   *
   * NOT the hand-tuned preset. `deriveBrandSet('#459A3C')` does not reproduce
   * `brandPresets.amaraSage` exactly (deep #35752E vs #34772C, card #4FB045 →
   * #387D31 vs #4EA744 → #35802D). That is the shared package's derivation
   * disagreeing with its own preset by a few units; it is the same on the web,
   * and it is trunk's to reconcile, not this app's to paper over.
   */
  it("draws deriveBrandSet(#459A3C), exactly as the dashboard and a cached launch do", async () => {
    serveSalon(AMARA);
    const r = homeHarness(await launch());
    await ready(r);
    expect(drawn(r)).toEqual(expected(derived(AMARA)));
  });
});

describe('a hex the shared package refuses', () => {
  it('keeps the defaults and warns with the package’s own sentence', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    serveSalon(REFUSED);
    const r = homeHarness(await launch());
    await ready(r);

    expect(drawn(r)).toEqual(expected(DEFAULTS));
    const refusal = deriveBrandSet(REFUSED);
    if (refusal.ok) throw new Error('expected a refusal');
    expect(warn).toHaveBeenCalledWith(`[avo] Ignoring salon brand colour ${REFUSED}: ${refusal.reason}`);
  });
});

describe('a cached brand — the second launch, and a signed-out phone', () => {
  it('is on the very first frame of sign-in, before any salon read', async () => {
    store.set('avo.wallet.brand.v1', FOREST);
    // Boot's own two steps, in Boot's order, before anything is imported.
    const [{ readCachedBrandColor }, { applyBrandColor }] = await Promise.all([
      import('../state/brandCache'),
      import('./brand'),
    ]);
    applyBrandColor(await readCachedBrandColor());

    const m = await launch();
    const r = render(
      <m.LanguageProvider initial="en">
        <m.SignInScreen onSignedIn={() => {}} onCreateAccount={() => {}} onForgotPassword={() => {}} />
      </m.LanguageProvider>,
    );
    // Synchronously after the first render: no default frame to correct.
    const forgot = r.getByText(m.en.signInForgot);
    expect(getComputedStyle(forgot).color).toBe(rgb(derived(FOREST).deep));
    expect(getMember).not.toHaveBeenCalled();
    expect(getSalon).not.toHaveBeenCalled();
  });

  it('and a later read of a different hex repaints over it', async () => {
    store.set('avo.wallet.brand.v1', FOREST);
    const [{ readCachedBrandColor }, { applyBrandColor }] = await Promise.all([
      import('../state/brandCache'),
      import('./brand'),
    ]);
    applyBrandColor(await readCachedBrandColor());

    serveSalon(LILAC);
    const r = homeHarness(await launch());
    await ready(r);
    expect(drawn(r)).toEqual(expected(derived(LILAC)));
  });

  it('is the default on a truly fresh install', async () => {
    const m = await launch();
    const r = render(
      <m.LanguageProvider initial="en">
        <m.SignInScreen onSignedIn={() => {}} onCreateAccount={() => {}} onForgotPassword={() => {}} />
      </m.LanguageProvider>,
    );
    expect(getComputedStyle(r.getByText(m.en.signInForgot)).color).toBe(rgb(DEFAULTS.deep));
  });
});

describe('non-negotiable #9 on the repainted app, for every brand a salon can be given', () => {
  /**
   * Structural #9 (no white inside a `color.brand` fill) is palette-free and
   * lives in `contrast.test.ts`. This is the measured half, on pixels the app
   * actually drew after a LIVE repaint: the primary button's white label on its
   * fill, and the selected tile's label on its wash, for forest and each light
   * preset in turn.
   */
  for (const [name, preset] of Object.entries(brandPresets)) {
    it(`${name}: white on the primary fill, and deep on the tile's tint, clear 4.5:1`, async () => {
      const { contrastRatio, AA_NORMAL_TEXT } = await import('@avo/tokens');
      serveSalon(preset.brand);
      const m = await launch();
      const r = homeHarness(m);
      await ready(r);

      const set = derived(preset.brand);
      const now = drawn(r);
      expect(now.primaryFill).toBe(rgb(set.deep));

      const primaryLabel = getComputedStyle(r.getByTestId('primary').firstElementChild as HTMLElement).color;
      const hex = (c: string) =>
        `#${(c.match(/\d+/g) ?? []).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
      expect(hex(primaryLabel).toUpperCase()).toBe('#FFFFFF');
      expect(contrastRatio('#FFFFFF', set.deep)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      expect(contrastRatio(hex(now.tileText), hex(now.tileFill))).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    });
  }
});
