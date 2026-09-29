// @vitest-environment jsdom

/**
 * THE WALLET CARD TAKES HER TIER'S METAL — rendered, and read off the nodes.
 *
 * Aftab, 2026-09-29: "if the tier is silver the color of the wallet main widget
 * is silver, gold to gold". `theme/cardInk.test.ts` holds the palette's maths;
 * this file holds the claim that the card actually DRAWS it: every text node on
 * the card in the tier's `cardText`, the overlays dark on the metals, black and
 * the brand card still white, and a tier change re-colouring the card on the
 * next render rather than on some later remount.
 *
 * TWO STAND-INS, BOTH FOR THE TEST ENVIRONMENT, NEITHER FOR THE CARD.
 *
 *   `expo-linear-gradient` resolves its NATIVE build under vitest ("LinearGradient
 *   is not available on this platform") and drops its `colors`, so the gradient
 *   cannot be read off the DOM. It is replaced with a View that writes the two
 *   stops it was handed onto `data-from` / `data-to`. What is asserted is
 *   therefore exactly the prop the card passes — which is the thing that
 *   changed.
 *
 *   `react-native-qrcode-svg` cannot load here at all (vitest.config.ts § WHAT
 *   STILL CANNOT BE RENDERED). The panels asserted below are the offline and
 *   failed ones, which never draw a QR, so a null stand-in hides nothing.
 */

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { TierName } from '@avo/types';

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
      // `dataSet` is react-native-web's data-* attribute prop; RN's own
      // ViewProps does not declare it, hence the spread.
      <View style={style} {...({ dataSet: { from: colors[0], to: colors[1] } } as object)}>
        {children}
      </View>
    ),
  };
});
vi.mock('react-native-qrcode-svg', () => ({ default: () => null }));

import { WalletCard } from './WalletCard';
import { PaymentCode } from './PaymentCode';
import { LanguageProvider } from '../i18n/language';
import { cardGradient, tierStyles, WHITE } from '../theme';
import { en } from '../copy/en';
import { ar } from '../copy/ar';
import type { LoyaltyProgress } from '../domain/loyalty';
import type { PaymentCodeView } from '../domain/paymentCode';

afterEach(cleanup);

const TIERS: TierName[] = ['bronze', 'silver', 'gold', 'black'];
const METALS: TierName[] = ['bronze', 'silver', 'gold'];
const NEXT: Record<TierName, TierName | null> = {
  bronze: 'silver',
  silver: 'gold',
  gold: 'black',
  black: null,
};

const tiers = (current: TierName): LoyaltyProgress => ({
  mode: 'tiers',
  current,
  next: NEXT[current],
  visitsToNext: NEXT[current] ? 3 : 0,
  fraction: NEXT[current] ? 0.4 : 1,
});

const stamps: LoyaltyProgress = { mode: 'stamps', have: 3, target: 8, reward: 'Free blow-dry', fraction: 3 / 8 };

const offline = { kind: 'unavailable', reason: 'offline', canRetry: false } as unknown as PaymentCodeView;

/** `#RRGGBB` → the `rgb(r, g, b)` jsdom reports. */
function rgb(hex: string): string {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

/**
 * A computed colour's hue, alpha dropped. On light ink (black, brand) secondary
 * words are white AT AN ALPHA by design — the offline stamp is white at 0.78 —
 * so "every word is the ink" is a statement about the channels.
 */
const hue = (c: string) => {
  const { r, g, b } = channels(c);
  return `rgb(${r}, ${g}, ${b})`;
};

/** The channels of a computed colour, alpha included. */
function channels(c: string): { r: number; g: number; b: number; a: number } {
  const [r = 0, g = 0, b = 0, a = 1] = (c.match(/[\d.]+/g) ?? []).map(Number);
  return { r, g, b, a };
}

function draw(
  progress: LoyaltyProgress | null,
  { lang = 'en' as 'en' | 'ar', pill = 'Pill', panel = true } = {},
) {
  const ui = (p: LoyaltyProgress | null) => (
    <LanguageProvider initial={lang}>
      <WalletCard balanceFils={24500} pill={pill} progress={p} lastUpdated="Last updated 2m ago">
        {panel ? (
          <PaymentCode
            memberId="AVO-1204"
            view={offline}
            secondsRemaining={0}
            onEnlarge={() => undefined}
            onRetry={() => undefined}
          />
        ) : null}
      </WalletCard>
    </LanguageProvider>
  );
  const r = render(ui(progress));
  // The card IS the gradient: its root node, found by the stops it was handed.
  const card = () => r.container.querySelector('[data-from]') as HTMLElement;
  /** Every node on the card that draws a word. */
  const words = () =>
    (Array.from(card().querySelectorAll('*')) as HTMLElement[]).filter(
      (n) => n.children.length === 0 && (n.textContent ?? '').trim() !== '',
    );
  return { ...r, card, words, redraw: (p: LoyaltyProgress | null) => r.rerender(ui(p)) };
}

const pillOf = (words: HTMLElement[], pill: string) =>
  words.find((n) => n.textContent === pill)!.parentElement as HTMLElement;
const trackOf = (card: HTMLElement) => card.querySelector('[role="progressbar"]') as HTMLElement;
const panelOf = (card: HTMLElement) => card.querySelector('[data-testid="payment-code-offline"]') as HTMLElement;

// ------------------------------------------------------ each tier's metal --

describe.each(TIERS)('%s — the card is the tier’s metal', (t) => {
  it('draws the tier’s gradient, read off the theme', () => {
    const { card } = draw(tiers(t));
    expect(card().dataset.from).toBe(tierStyles[t].cardFrom);
    expect(card().dataset.to).toBe(tierStyles[t].cardTo);
  });

  it('draws EVERY word on the card in the tier’s cardText', () => {
    const { words } = draw(tiers(t), { pill: t });
    const all = words();
    // label, pill, figure, unit, stamp, hint, ladder, panel title, panel body
    expect(all.length).toBe(9);
    for (const n of all) {
      expect(hue(getComputedStyle(n).color), n.textContent ?? '').toBe(rgb(tierStyles[t].cardText));
    }
  });

  it('draws no word in white unless the tier’s ink IS white', () => {
    const { words } = draw(tiers(t), { pill: t });
    const white = tierStyles[t].cardText.toUpperCase() === '#FFFFFF';
    for (const n of words()) {
      expect(hue(getComputedStyle(n).color) === rgb(WHITE), n.textContent ?? '').toBe(white);
    }
  });
});

describe.each(METALS)('%s — the overlays go dark', (t) => {
  it('solid text: no softening opacity on any word', () => {
    const { words } = draw(tiers(t), { pill: t });
    for (const n of words()) expect(getComputedStyle(n).opacity, n.textContent ?? '').toBe('1');
  });

  it('the pill, the track and the offline panel are translucent cardText, not white', () => {
    const { card, words } = draw(tiers(t), { pill: t });
    const ink = channels(rgb(tierStyles[t].cardText));
    for (const [what, el, prop] of [
      ['pill', pillOf(words(), t), 'backgroundColor'],
      ['track', trackOf(card()), 'backgroundColor'],
      ['panel', panelOf(card()), 'backgroundColor'],
      ['panel border', panelOf(card()), 'borderTopColor'],
    ] as const) {
      const c = channels(getComputedStyle(el)[prop]);
      expect({ r: c.r, g: c.g, b: c.b }, what).toEqual({ r: ink.r, g: ink.g, b: ink.b });
      expect(c.a, what).toBeLessThan(1);
    }
  });

  it('the progress fill is solid cardText on its dark track', () => {
    const { card } = draw(tiers(t));
    const fill = trackOf(card()).firstElementChild as HTMLElement;
    expect(getComputedStyle(fill).backgroundColor).toBe(rgb(tierStyles[t].cardText));
  });
});

// ------------------------------------------------------------ white stays --

describe('black keeps white', () => {
  it('white words and the brand card’s white overlays', () => {
    const { card, words } = draw(tiers('black'), { pill: 'black' });
    for (const n of words()) expect(hue(getComputedStyle(n).color), n.textContent ?? '').toBe(rgb(WHITE));
    const stamp = words().find((n) => n.textContent === 'Last updated 2m ago')!;
    expect(getComputedStyle(stamp).color).toBe('rgba(255, 255, 255, 0.78)');
    expect(getComputedStyle(pillOf(words(), 'black')).backgroundColor).toBe('rgba(255, 255, 255, 0.18)');
    expect(getComputedStyle(trackOf(card())).backgroundColor).toBe('rgba(255, 255, 255, 0.22)');
    expect(getComputedStyle(panelOf(card())).backgroundColor).toBe('rgba(255, 255, 255, 0.14)');
  });
});

describe.each([
  ['stamps mode', stamps],
  ['no tier yet', null],
] as const)('%s keeps the salon brand card, exactly as it was', (_label, progress) => {
  it('the brand gradient', () => {
    const { card } = draw(progress);
    expect(card().dataset.from).toBe(cardGradient.from);
    expect(card().dataset.to).toBe(cardGradient.to);
  });

  it('white words at the brand card’s own opacities', () => {
    const { words } = draw(progress);
    const all = words();
    for (const n of all) {
      const c = channels(getComputedStyle(n).color);
      expect({ r: c.r, g: c.g, b: c.b }, n.textContent ?? '').toEqual({ r: 255, g: 255, b: 255 });
    }
    const label = all.find((n) => n.textContent === en.balanceLabel)!;
    expect(getComputedStyle(label).opacity).toBe('0.85');
    const stamp = all.find((n) => n.textContent === 'Last updated 2m ago')!;
    expect(getComputedStyle(stamp).color).toBe('rgba(255, 255, 255, 0.78)');
  });

  it('the translucent white pill and offline panel', () => {
    const { card, words } = draw(progress);
    expect(getComputedStyle(pillOf(words(), 'Pill')).backgroundColor).toBe('rgba(255, 255, 255, 0.18)');
    expect(getComputedStyle(panelOf(card())).backgroundColor).toBe('rgba(255, 255, 255, 0.14)');
  });
});

describe('stamps mode draws its dots in white, as before', () => {
  it('filled dots white, empty dots white at 0.22', () => {
    const { card } = draw(stamps, { panel: false });
    const dots = (Array.from(card().querySelectorAll('*')) as HTMLElement[]).filter(
      (n) => n.children.length === 0 && (n.textContent ?? '') === '',
    );
    expect(dots).toHaveLength(8);
    const bgs = dots.map((d) => getComputedStyle(d).backgroundColor);
    expect(bgs.filter((c) => c === rgb(WHITE))).toHaveLength(3);
    expect(bgs.filter((c) => c === 'rgba(255, 255, 255, 0.22)')).toHaveLength(5);
  });
});

// ------------------------------------------------------------------ Arabic --

describe('Arabic', () => {
  it('mirrors the layout and keeps the copy, on a metal card', () => {
    const { card, words } = draw(tiers('silver'), { lang: 'ar', pill: ar.tierName.silver });
    expect(document.documentElement.dir).toBe('rtl');
    expect(card().dataset.from).toBe(tierStyles.silver.cardFrom);
    const texts = words().map((n) => n.textContent);
    expect(texts).toContain(ar.balanceLabel);
    expect(texts).toContain(ar.tierLadder('silver', 'gold'));
    expect(texts).toContain('24.500'); // Western digits for money, both languages
    for (const n of words()) {
      expect(getComputedStyle(n).color, n.textContent ?? '').toBe(rgb(tierStyles.silver.cardText));
    }
  });

  it('and English renders the same card the other way round', () => {
    const { words } = draw(tiers('silver'), { lang: 'en', pill: en.tierName.silver });
    expect(document.documentElement.dir).toBe('ltr');
    expect(words().map((n) => n.textContent)).toContain(en.tierLadder('silver', 'gold'));
  });
});

// ------------------------------------------------------------- a tier move --

describe('a tier change re-colours the card on the next read', () => {
  it('silver → gold after a charge, on the same mounted card', () => {
    const { card, words, redraw } = draw(tiers('silver'));
    expect(card().dataset.from).toBe(tierStyles.silver.cardFrom);

    // What `useWalletRefresh` hands back after the server moves her up.
    redraw(tiers('gold'));
    expect(card().dataset.from).toBe(tierStyles.gold.cardFrom);
    expect(card().dataset.to).toBe(tierStyles.gold.cardTo);
    for (const n of words()) {
      expect(getComputedStyle(n).color, n.textContent ?? '').toBe(rgb(tierStyles.gold.cardText));
    }
  });

  it('gold → black flips the ink to white and the overlays with it', () => {
    const { card, words, redraw } = draw(tiers('gold'));
    redraw(tiers('black'));
    for (const n of words()) expect(hue(getComputedStyle(n).color)).toBe(rgb(WHITE));
    expect(getComputedStyle(trackOf(card())).backgroundColor).toBe('rgba(255, 255, 255, 0.22)');
  });
});
