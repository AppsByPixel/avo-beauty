// @vitest-environment jsdom

/**
 * A WORKSPACE THAT KEEPS ITS OWN COLOUR OVERRIDES THE TIER CARD — rendered.
 *
 * Aftab, 2026-09-29: "if … that workspace has a dark green theme chosen then it
 * should override this tier coloring for that workspace." `Salon.walletCard` is
 * the salon's setting: `'brand'` paints the salon's card for every member,
 * `'tier'` (the schema default) paints her tier's metal. `theme/cardInk.test.ts`
 * holds the palette's maths; this file holds the claim that the card DRAWS it,
 * on a salon rebranded the way a real one is.
 *
 * THE SALON IS FOREST, APPLIED THE WAY BOOT APPLIES IT: before any app module
 * is imported, the shape of a launch with the hex cached. Every app module below
 * is reached through a dynamic import AFTER the rebrand. (The live path — a hex
 * that arrives from the salon read with the app already on screen — is
 * `theme/brandLiveRender.test.tsx`.) The card this renders is therefore the derived one,
 * `deriveBrandSet(#1F5A36)`'s #277144 → #153C24, and not the build's default
 * gradient: a brand path that had hard-coded Amara would fail the first test.
 *
 * The two stand-ins are `walletCardTierRender.test.tsx`'s, for its reasons.
 */

import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import {
  AA_NORMAL_TEXT,
  brandPresets,
  contrastRatio,
  deriveBrandSet,
  hexToRgb,
  rgbToHex,
} from '@avo/tokens';
import { SalonSchema, type Salon, type TierName } from '@avo/types';
// Applied before `../theme` is imported: the cached-launch order (see above).
import { applyBrandColor } from '../theme/brand';
import type { PaymentCodeView } from '../domain/paymentCode';

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

const FOREST = brandPresets.forest.brand;
const DERIVED = (() => {
  const r = deriveBrandSet(FOREST);
  if (!r.ok) throw new Error(`${FOREST} was refused: ${r.reason}`);
  return r.set;
})();

type App = {
  WalletCard: typeof import('./WalletCard').WalletCard;
  PaymentCode: typeof import('./PaymentCode').PaymentCode;
  LanguageProvider: typeof import('../i18n/language').LanguageProvider;
  getSalon: typeof import('../api/wallet').getSalon;
  tierStyles: typeof import('../theme').tierStyles;
  WHITE: string;
  en: typeof import('../copy/en').en;
  ar: typeof import('../copy/ar').ar;
};
let app: App;

beforeAll(async () => {
  const out = applyBrandColor(FOREST);
  expect(out.applied).toBe(true);
  const [{ WalletCard }, { PaymentCode }, { LanguageProvider }, { getSalon }, theme, { en }, { ar }] =
    await Promise.all([
      import('./WalletCard'),
      import('./PaymentCode'),
      import('../i18n/language'),
      import('../api/wallet'),
      import('../theme'),
      import('../copy/en'),
      import('../copy/ar'),
    ]);
  app = { WalletCard, PaymentCode, LanguageProvider, getSalon, tierStyles: theme.tierStyles, WHITE: theme.WHITE, en, ar };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ------------------------------------------------------------------ helpers --

const gold = {
  mode: 'tiers',
  current: 'gold' as TierName,
  next: 'black' as TierName,
  visitsToNext: 3,
  fraction: 0.4,
} as const;

const offline: PaymentCodeView = { kind: 'unavailable', reason: 'offline', canEnlarge: false, canRetry: false };
const STAMP = 'Last updated 2m ago';
const PILL = 'Gold';

function rgb(hex: string): string {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

function channels(c: string): { r: number; g: number; b: number; a: number } {
  const [r = 0, g = 0, b = 0, a = 1] = (c.match(/[\d.]+/g) ?? []).map(Number);
  return { r, g, b, a };
}

const hue = (c: string) => {
  const { r, g, b } = channels(c);
  return `rgb(${r}, ${g}, ${b})`;
};

/** Paint `fg` at alpha `a` over the opaque `bg`. */
function over(fg: { r: number; g: number; b: number }, a: number, bg: string): string {
  const b = hexToRgb(bg);
  const mix = (x: number, y: number) => Math.round(x * a + y * (1 - a));
  return rgbToHex({ r: mix(fg.r, b.r), g: mix(fg.g, b.g), b: mix(fg.b, b.b) });
}

function draw(walletCard: Salon['walletCard'], lang: 'en' | 'ar' = 'en') {
  const { WalletCard, PaymentCode, LanguageProvider } = app;
  const r = render(
    <LanguageProvider initial={lang}>
      <WalletCard
        balanceFils={24500}
        pill={PILL}
        progress={gold}
        walletCard={walletCard}
        lastUpdated={STAMP}
      >
        <PaymentCode
          memberId="AVO-1204"
          view={offline}
          secondsRemaining={0}
          onEnlarge={() => undefined}
          onRetry={() => undefined}
        />
      </WalletCard>
    </LanguageProvider>,
  );
  const card = r.container.querySelector('[data-from]') as HTMLElement;
  const words = (Array.from(card.querySelectorAll('*')) as HTMLElement[]).filter(
    (n) => n.children.length === 0 && (n.textContent ?? '').trim() !== '',
  );
  return { card, words };
}

/**
 * What a word actually looks like against one gradient stop: its colour at its
 * own alpha and opacity, over every translucent background between it and the
 * card, over the stop. Read off the rendered nodes, so it measures what the
 * card drew rather than what `cardInk.ts` says it will draw.
 */
function seenContrast(word: HTMLElement, card: HTMLElement, stop: string): number {
  const layers: Array<{ r: number; g: number; b: number; a: number }> = [];
  for (let n = word.parentElement; n && n !== card; n = n.parentElement) {
    const bg = channels(getComputedStyle(n).backgroundColor || 'rgba(0,0,0,0)');
    if (getComputedStyle(n).backgroundColor && bg.a > 0) layers.unshift(bg);
  }
  let bg = stop;
  for (const l of layers) bg = over(l, l.a, bg);
  const fg = channels(getComputedStyle(word).color);
  const alpha = fg.a * Number(getComputedStyle(word).opacity || '1');
  return contrastRatio(over(fg, alpha, bg), bg);
}

// ---------------------------------------------------------------- the rule --

describe("a Gold member at a walletCard: 'brand' salon", () => {
  it('gets the salon’s DERIVED brand gradient, not gold', () => {
    const { card } = draw('brand');
    expect(card.dataset.from).toBe(DERIVED.cardFrom);
    expect(card.dataset.to).toBe(DERIVED.cardTo);
    // The derived card for forest is the one trunk's token file declares.
    expect(card.dataset.from).toBe('#277144');
    expect(card.dataset.to).toBe('#153C24');
    expect(card.dataset.from).not.toBe(app.tierStyles.gold.cardFrom);
  });

  it('and every word on it is white, not gold’s cardText', () => {
    const { words } = draw('brand');
    // label, pill, figure, unit, stamp, hint, ladder, panel title, panel body
    expect(words.length).toBe(9);
    for (const n of words) {
      expect(hue(getComputedStyle(n).color), n.textContent ?? '').toBe(rgb(app.WHITE));
    }
    expect(app.tierStyles.gold.cardText.toUpperCase()).not.toBe('#FFFFFF');
  });

  it('with today’s white overlays, not the metal’s dark ones', () => {
    const { card, words } = draw('brand');
    const pill = words.find((n) => n.textContent === PILL)!.parentElement as HTMLElement;
    expect(getComputedStyle(pill).backgroundColor).toBe('rgba(255, 255, 255, 0.18)');
    const track = card.querySelector('[role="progressbar"]') as HTMLElement;
    expect(getComputedStyle(track).backgroundColor).toBe('rgba(255, 255, 255, 0.22)');
    const panel = card.querySelector('[data-testid="payment-code-offline"]') as HTMLElement;
    expect(getComputedStyle(panel).backgroundColor).toBe('rgba(255, 255, 255, 0.14)');
  });
});

describe("the same member at a walletCard: 'tier' salon", () => {
  it('gets gold', () => {
    const { card, words } = draw('tier');
    expect(card.dataset.from).toBe(app.tierStyles.gold.cardFrom);
    expect(card.dataset.to).toBe(app.tierStyles.gold.cardTo);
    for (const n of words) {
      expect(getComputedStyle(n).color, n.textContent ?? '').toBe(rgb(app.tierStyles.gold.cardText));
    }
  });
});

// ------------------------------------------------------------ the contrast --

describe('forest’s brand card clears AA', () => {
  /**
   * The §2 translucent whites — kept byte-for-byte on the brand path — are the
   * only words that fall under AA on forest's LIGHT stop (#277144): the stamp at
   * 4.33, the pill text 4.03, the panel title 4.40 and body 3.68. Named here so a
   * fifth goes red, and floored at 3:1. `theme/cardInk.test.ts` carries the
   * account and the comparison with the light presets.
   */
  const exceptionsOnLightStop = (en: App['en']) =>
    new Set([STAMP, PILL, en.qrOfflineTitle, en.qrOfflineBody]);

  it('every word, on the dark stop', () => {
    const { card, words } = draw('brand');
    for (const n of words) {
      expect(seenContrast(n, card, DERIVED.cardTo), n.textContent ?? '').toBeGreaterThanOrEqual(
        AA_NORMAL_TEXT,
      );
    }
  });

  it('the figure, label, unit, hint and ladder, on the light stop', () => {
    const { card, words } = draw('brand');
    const skip = exceptionsOnLightStop(app.en);
    const held = words.filter((n) => !skip.has(n.textContent ?? ''));
    expect(held.length).toBe(5);
    for (const n of held) {
      expect(seenContrast(n, card, DERIVED.cardFrom), n.textContent ?? '').toBeGreaterThanOrEqual(
        AA_NORMAL_TEXT,
      );
    }
  });

  it('and the §2 overlays stay above 3:1 there', () => {
    const { card, words } = draw('brand');
    const skip = exceptionsOnLightStop(app.en);
    const excepted = words.filter((n) => skip.has(n.textContent ?? ''));
    expect(excepted.length).toBe(4);
    for (const n of excepted) {
      expect(seenContrast(n, card, DERIVED.cardFrom), n.textContent ?? '').toBeGreaterThanOrEqual(3);
    }
  });
});

// ------------------------------------------------ a salon from before the key --

describe('a salon read with no walletCard key', () => {
  /** `GET /salons/:id` as an API that predates the field serves it. */
  const PRE_WALLET_CARD_SALON = {
    id: 'SAL-FOREST',
    name: 'Forest',
    nameAr: null,
    city: 'Kuwait City',
    plan: 'growth',
    brandColor: FOREST,
    modules: { booking: false, shop: false },
    loyaltyMode: 'tiers',
    tiers: [
      { name: 'bronze', minVisits: 0, bonusPercent: 0 },
      { name: 'gold', minVisits: 8, bonusPercent: 15 },
    ],
    depositFils: 5000,
    noShowReturnMinutes: 60,
    timezone: 'Asia/Kuwait',
    businessHours: { morning: ['10:00', '13:00'], evening: ['16:00', '21:00'] },
    branches: [],
    social: [],
    whatsappEnabled: true,
    emailEnabled: true,
  };

  it('parses to tier through the wallet’s own read, and the card is gold', async () => {
    expect('walletCard' in PRE_WALLET_CARD_SALON).toBe(false);
    // The fixture must satisfy the rest of the contract, or this proves nothing.
    expect(SalonSchema.safeParse(PRE_WALLET_CARD_SALON).success).toBe(true);
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response(JSON.stringify(PRE_WALLET_CARD_SALON), { status: 200 })),
    );
    const salon = await app.getSalon('SAL-FOREST');
    expect(salon.walletCard).toBe('tier');

    const { card } = draw(salon.walletCard);
    expect(card.dataset.from).toBe(app.tierStyles.gold.cardFrom);
  });
});

// ------------------------------------------------------------------ Arabic --

describe('Arabic', () => {
  it('mirrors the layout and keeps the copy on the brand card', () => {
    const { card, words } = draw('brand', 'ar');
    expect(document.documentElement.dir).toBe('rtl');
    expect(card.dataset.from).toBe(DERIVED.cardFrom);
    const texts = words.map((n) => n.textContent);
    expect(texts).toContain(app.ar.balanceLabel);
    expect(texts).toContain(app.ar.tierLadder('gold', 'black'));
    expect(texts).toContain('24.500'); // Western digits for money, both languages
    for (const n of words) {
      expect(hue(getComputedStyle(n).color), n.textContent ?? '').toBe(rgb(app.WHITE));
    }
  });
});
