/**
 * The wallet card's palette, computed rather than eyeballed.
 *
 * `packages/tokens/src/tierCard.test.ts` pins the TOKENS: each tier's `cardText`
 * clears AA against both ends of its own gradient. That is necessary and not
 * sufficient, because the card does not only draw solid text on a bare
 * gradient — it lays translucent overlays under some of its words (the tier
 * pill, the offline panel) and softens others with opacity. Every one of those
 * is a pairing the token test never sees, so each is composited here, against
 * BOTH gradient ends, with the alpha the card actually uses.
 */

import { describe, expect, it } from 'vitest';
import { AA_NORMAL_TEXT, contrastRatio, hexToRgb, rgbToHex } from '@avo/tokens';
import type { TierName } from '@avo/types';
import { brandInk, cardInkFor, tierInk, type CardInk } from './cardInk';
import { cardGradient, tierStyles, WHITE } from './index';
import type { LoyaltyProgress } from '../domain/loyalty';

const TIERS: TierName[] = ['bronze', 'silver', 'gold', 'black'];
const METALS: TierName[] = ['bronze', 'silver', 'gold'];
/** WCAG 1.4.11 — a non-text component (the progress fill) against what is next to it. */
const NON_TEXT = 3;

/** `rgba(r,g,b,a)` or `#rrggbb` → rgb + alpha. */
function parse(c: string): { hex: string; a: number } {
  const m = /^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/.exec(c.replace(/\s/g, ''));
  if (m) {
    const [r, g, b] = [m[1], m[2], m[3]].map(Number) as [number, number, number];
    return { hex: rgbToHex({ r, g, b }), a: Number(m[4]) };
  }
  return { hex: c, a: 1 };
}

/** Paint `fg` at alpha `a` over the opaque `bg`. */
function over(fg: string, a: number, bg: string): string {
  const f = hexToRgb(fg);
  const b = hexToRgb(bg);
  const mix = (x: number, y: number) => Math.round(x * a + y * (1 - a));
  return rgbToHex({ r: mix(f.r, b.r), g: mix(f.g, b.g), b: mix(f.b, b.b) });
}

/** A translucent colour string, resolved against an opaque background. */
function flatten(c: string, bg: string): string {
  const { hex, a } = parse(c);
  return over(hex, a, bg);
}

const ends = (ink: CardInk) => [ink.from, ink.to] as const;

const tiersProgress = (current: TierName): LoyaltyProgress => ({
  mode: 'tiers',
  current,
  next: null,
  visitsToNext: 0,
  fraction: 1,
});

// ----------------------------------------------------------- which palette --

describe('cardInkFor — which palette the card is painted with', () => {
  it.each(TIERS)('tiers mode, %s → that tier', (t) => {
    const ink = cardInkFor(tiersProgress(t));
    expect(ink.source).toBe(t);
    // Read off the wallet theme, not re-typed: the tokens are trunk's.
    expect(ink.from).toBe(tierStyles[t].cardFrom);
    expect(ink.to).toBe(tierStyles[t].cardTo);
    expect(ink.text).toBe(tierStyles[t].cardText);
  });

  it('stamps mode keeps the brand card', () => {
    const ink = cardInkFor({ mode: 'stamps', have: 3, target: 8, reward: null, fraction: 3 / 8 });
    expect(ink.source).toBe('brand');
  });

  it('no tier yet (a null progress) keeps the brand card', () => {
    expect(cardInkFor(null).source).toBe('brand');
  });
});

// ------------------------------------------------- the brand card, unchanged --

describe('the brand card is byte-for-byte what it was', () => {
  /**
   * These literals are the ones `WalletCard.tsx` and `PaymentCode.tsx` carried
   * before the tier metals existed. They are restated here on purpose: the
   * claim is "nothing on the white-label path moved", and the only way to
   * hold that is against the old values themselves.
   */
  it('keeps the salon gradient, white ink and the §2 translucent whites', () => {
    const ink = brandInk();
    expect(ink.from).toBe(cardGradient.from);
    expect(ink.to).toBe(cardGradient.to);
    expect(ink.text).toBe(WHITE);
    expect(ink.inkOn).toBe('light');
    expect(ink).toMatchObject({
      labelOpacity: 0.85,
      unitOpacity: 0.82,
      legendOpacity: 0.88,
      stampText: 'rgba(255,255,255,0.78)',
      pillBg: 'rgba(255,255,255,0.18)',
      track: 'rgba(255,255,255,0.22)',
      fill: WHITE,
      stampDot: 'rgba(255,255,255,0.22)',
      stampDotFilled: WHITE,
      panelBg: 'rgba(255,255,255,0.14)',
      panelBorder: 'rgba(255,255,255,0.4)',
      panelTitle: WHITE,
      panelBody: 'rgba(255,255,255,0.85)',
    });
  });
});

// ----------------------------------------------------- the overlays follow --

describe('the overlays follow the text', () => {
  it.each(METALS)('%s: dark ink, so dark overlays and no white anywhere', (t) => {
    const ink = tierInk(t);
    expect(ink.inkOn).toBe('dark');
    const { hex } = parse(ink.text);
    for (const c of [ink.pillBg, ink.track, ink.fill, ink.stampDot, ink.panelBg, ink.panelBorder]) {
      expect(parse(c).hex.toLowerCase(), c).toBe(hex.toLowerCase());
    }
    for (const c of Object.values(ink)) {
      if (typeof c === 'string') expect(/255,255,255|#fff/i.test(c), c).toBe(false);
    }
  });

  it('black: white ink, so the brand card’s white overlays exactly', () => {
    const ink = tierInk('black');
    const brand = brandInk();
    expect(ink.inkOn).toBe('light');
    for (const k of ['pillBg', 'track', 'fill', 'stampText', 'panelBg', 'panelBorder', 'panelBody'] as const) {
      expect(ink[k], k).toBe(brand[k]);
    }
  });
});

// ------------------------------------------------------------ the contrast --

describe.each(TIERS)('%s: every word on the card clears AA on both ends', (t) => {
  const ink = tierInk(t);
  const { hex: text } = parse(ink.text);

  it.each([
    ['balance label', 'labelOpacity'],
    ['currency unit', 'unitOpacity'],
    ['hint and ladder', 'legendOpacity'],
  ] as const)('%s, at its opacity', (_label, key) => {
    for (const end of ends(ink)) {
      const seen = over(text, ink[key], end);
      expect(contrastRatio(seen, end), end).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    }
  });

  it('the balance figure and the offline stamp', () => {
    for (const end of ends(ink)) {
      expect(contrastRatio(text, end)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      expect(contrastRatio(flatten(ink.stampText, end), end)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    }
  });

  it('the tier pill text, on the pill overlay', () => {
    for (const end of ends(ink)) {
      const pill = flatten(ink.pillBg, end);
      expect(contrastRatio(text, pill), end).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    }
  });

  it('the offline / failed panel title and body, on the panel overlay', () => {
    for (const end of ends(ink)) {
      const panel = flatten(ink.panelBg, end);
      expect(contrastRatio(flatten(ink.panelTitle, panel), panel)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      expect(contrastRatio(flatten(ink.panelBody, panel), panel)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    }
  });

  it('the progress fill reads against its track (non-text, 3:1)', () => {
    for (const end of ends(ink)) {
      const track = flatten(ink.track, end);
      const fill = flatten(ink.fill, end);
      expect(contrastRatio(fill, track), end).toBeGreaterThanOrEqual(NON_TEXT);
    }
  });
});
