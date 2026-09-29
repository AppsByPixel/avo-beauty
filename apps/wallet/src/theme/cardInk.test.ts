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
import { AA_NORMAL_TEXT, brandPresets, contrastRatio, deriveBrandSet, hexToRgb, rgbToHex } from '@avo/tokens';
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
    const ink = cardInkFor(tiersProgress(t), 'tier');
    expect(ink.source).toBe(t);
    // Read off the wallet theme, not re-typed: the tokens are trunk's.
    expect(ink.from).toBe(tierStyles[t].cardFrom);
    expect(ink.to).toBe(tierStyles[t].cardTo);
    expect(ink.text).toBe(tierStyles[t].cardText);
  });

  it('stamps mode keeps the brand card', () => {
    const ink = cardInkFor({ mode: 'stamps', have: 3, target: 8, reward: null, fraction: 3 / 8 }, 'tier');
    expect(ink.source).toBe('brand');
  });

  it('no tier yet (a null progress) keeps the brand card', () => {
    expect(cardInkFor(null, 'tier').source).toBe('brand');
  });
});

describe("cardInkFor — a salon that keeps its own colour (walletCard: 'brand')", () => {
  /**
   * Aftab, 2026-09-29: a workspace that chose its theme overrides the tier
   * colouring. Every tier, not just the metals: black is a tier colour too.
   */
  it.each(TIERS)('%s member → the brand card, not the tier', (t) => {
    const ink = cardInkFor(tiersProgress(t), 'brand');
    expect(ink).toEqual(brandInk());
    expect(ink.source).toBe('brand');
    expect(ink.from).toBe(cardGradient.from);
    expect(ink.to).toBe(cardGradient.to);
    expect(ink.text).toBe(WHITE);
  });

  it('stamps mode and no tier yet are the brand card either way', () => {
    const stamps: LoyaltyProgress = { mode: 'stamps', have: 3, target: 8, reward: null, fraction: 3 / 8 };
    expect(cardInkFor(stamps, 'brand')).toEqual(brandInk());
    expect(cardInkFor(null, 'brand')).toEqual(brandInk());
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

// ------------------------------------ the brand card on a dark salon brand --

/**
 * THE BRAND CARD IS DERIVED, SO ITS CONTRAST IS A PROPERTY OF THE HEX.
 *
 * With `walletCard: 'brand'` a Gold member at a forest salon is drawn on
 * forest's card, not on gold's — so the words that were checked against the
 * metal now sit on `deriveBrandSet(#1F5A36)`'s stops, #277144 → #153C24.
 * `brandInk()` reads `theme.card`, which `./brand` writes the derived stops
 * into at boot; this file imports `./index` and so cannot rebrand (the palette
 * is sealed), so the ink is built as exactly that: the brand ink with the
 * derived stops. The rendered version is `walletCardBrandRender.test.tsx`.
 *
 * MEASURED, NOT ASSUMED — AND NOT EVERY PAIRING CLEARS AA ON THE LIGHT STOP.
 * Solid white is 5.95:1 on #277144 and 12.33:1 on #153C24, and every word
 * clears AA on the dark stop. On the light stop the words the card draws in
 * white or near-white (figure, label 0.85, unit 0.82, hint and ladder 0.88)
 * clear it too. Four do not, and all four are the brand card's translucent
 * whites, kept byte-for-byte (`cardInk.ts` § the brand path):
 *
 *   offline stamp, white 0.78           4.33:1
 *   tier pill text, on the 0.18 pill    4.03:1
 *   panel title, on the 0.14 panel      4.40:1
 *   panel body 0.85, on the 0.14 panel  3.68:1
 *
 * They are the interaction-spec.md §2 exceptions (~3:1), and forest is the
 * BEST brand card this product has for them: on the shipped light presets the
 * same card is below AA even for solid white (Amara's light stop is 2.75:1).
 * This pins the four as the only sub-AA pairings, each above 3:1, so a fifth
 * goes red. Whether a dark brand card should drop the softening the way the
 * metals do is a design call, reported rather than made here — the brief is
 * "do not restyle".
 *
 * Scoped to the DARK presets by name, as `packages/tokens/src/derive.test.ts`
 * scopes them.
 */
const DARK_PRESETS = new Set(['forest']);
/** The §2 translucent pairings that fall under AA on a dark brand's light stop. */
const BRAND_CARD_EXCEPTIONS = ['offline stamp', 'pill text', 'panel title', 'panel body'];

function brandCardPairs(ink: CardInk, end: string): Array<[string, number]> {
  const panel = flatten(ink.panelBg, end);
  return [
    ['balance figure', contrastRatio(WHITE, end)],
    ['balance label', contrastRatio(over(WHITE, ink.labelOpacity, end), end)],
    ['currency unit', contrastRatio(over(WHITE, ink.unitOpacity, end), end)],
    ['hint and ladder', contrastRatio(over(WHITE, ink.legendOpacity, end), end)],
    ['offline stamp', contrastRatio(flatten(ink.stampText, end), end)],
    ['pill text', contrastRatio(WHITE, flatten(ink.pillBg, end))],
    ['panel title', contrastRatio(flatten(ink.panelTitle, panel), panel)],
    ['panel body', contrastRatio(flatten(ink.panelBody, panel), panel)],
  ];
}

describe.each(
  Object.entries(brandPresets).filter(([name]) => DARK_PRESETS.has(name)),
)('%s: the brand card', (_name, p) => {
  const derived = deriveBrandSet(p.brand);
  if (!derived.ok) throw new Error(`${p.brand} was refused: ${derived.reason}`);
  const ink: CardInk = { ...brandInk(), from: derived.set.cardFrom, to: derived.set.cardTo };

  it('is the derived card, which is the one the token file declares', () => {
    expect(ink.from).toBe(p.cardFrom);
    expect(ink.to).toBe(p.cardTo);
    expect(ink.text).toBe(WHITE);
  });

  it('clears AA for every word on the dark stop', () => {
    const under = brandCardPairs(ink, ink.to).filter(([, r]) => r < AA_NORMAL_TEXT);
    expect(under).toEqual([]);
  });

  it('clears AA on the light stop for the figure, label, unit, hint and ladder', () => {
    const under = brandCardPairs(ink, ink.from)
      .filter(([what]) => !BRAND_CARD_EXCEPTIONS.includes(what))
      .filter(([, r]) => r < AA_NORMAL_TEXT);
    expect(under).toEqual([]);
  });

  it('and only the §2 translucent whites fall under it there, each above 3:1', () => {
    const under = brandCardPairs(ink, ink.from).filter(([, r]) => r < AA_NORMAL_TEXT);
    for (const [what, r] of under) {
      expect(BRAND_CARD_EXCEPTIONS, what).toContain(what);
      expect(r, what).toBeGreaterThanOrEqual(NON_TEXT);
    }
  });

  it('the progress fill reads against its track (non-text, 3:1)', () => {
    for (const end of ends(ink)) {
      expect(contrastRatio(flatten(ink.fill, end), flatten(ink.track, end)), end).toBeGreaterThanOrEqual(NON_TEXT);
    }
  });
});
