/**
 * What the wallet card is painted with: the salon's brand gradient, or the
 * member's tier metal.
 *
 * Aftab, 2026-09-29: "if the tier is silver the color of the wallet main widget
 * is silver, gold to gold" — the metallic option he was shown on 2026-09-28.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHICH ONE, AND WHO DECIDES
 * ─────────────────────────────────────────────────────────────────────────────
 * The metal is chosen from `progress.current`, which `loyaltyProgress` copies
 * off `member.tier` — the server's field. Nothing here counts visits or compares
 * thresholds, so a climb after a charge re-colours the card on the next read of
 * the member and not a moment before. A client that painted the card gold ahead
 * of the server would be telling her she is Gold when the till says otherwise.
 *
 *   tiers mode, tier known   → that tier's `cardFrom → cardTo`, `cardText`
 *   stamps mode              → the brand card, exactly as it was
 *   tiers mode, no tier yet  → the brand card, exactly as it was
 *
 * The brand path is the white-label one and is kept byte-for-byte: the same
 * `theme.card` gradient, white text at the same opacities, and the translucent
 * white overlays interaction-spec.md §2 documents as intentional ~3:1
 * exceptions. Non-negotiable #9 is untouched by construction — the brand path
 * returns what the card drew before this module existed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE OVERLAYS FOLLOW THE TEXT, AND THE SPLIT IS BY THE INK, NOT BY A TIER LIST
 * ─────────────────────────────────────────────────────────────────────────────
 * `inkOn` is read off the luminance of the ink itself. White ink (brand, black)
 * keeps today's white overlays and today's softened secondary text. Dark ink
 * (bronze, silver, gold) gets DARK overlays and solid text, because the metals
 * are light and cannot afford what white-on-brand could:
 *
 *   - Secondary text at the brand card's 0.78–0.88 opacity measures 3.9:1 on
 *     gold's `cardTo`. Solid `cardText` is what the token test pins at AA on
 *     both ends, so on the metals every word is solid `cardText`.
 *   - The pill is `cardText` at 0.08. At 0.10 bronze's `cardTo` falls to 4.52,
 *     one rounding step from failing; 0.08 holds 4.65 there and more elsewhere.
 *   - The track is `cardText` at 0.18 under a SOLID `cardText` fill, so the
 *     fill-against-track pair is ≥3.9:1 on every metal — above the 3:1 a
 *     non-text component needs — and the track still reads as a band.
 *
 * Every one of those is computed in `cardInk.test.ts` against both gradient
 * ends; none is asserted from this comment.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { createContext, useContext } from 'react';
import type { TierName } from '@avo/types';
import { relativeLuminance } from '@avo/tokens';
import type { LoyaltyProgress } from '../domain/loyalty';
import { cardGradient, tierStyles, WHITE, withAlpha } from './index';

export interface CardInk {
  /** Which palette this is — `'brand'` or the tier it came from. */
  source: 'brand' | TierName;
  from: string;
  to: string;
  /** Whether the ink is light (white) or dark. Overlays follow it. */
  inkOn: 'light' | 'dark';
  /** Every text node and glyph drawn directly on the gradient. */
  text: string;
  /**
   * Secondary text softening. The brand card's opacities on light ink; 1 on dark
   * ink, where a softened word on a metal falls below AA.
   */
  labelOpacity: number;
  unitOpacity: number;
  legendOpacity: number;
  /** The offline "last updated" stamp. */
  stampText: string;
  pillBg: string;
  track: string;
  fill: string;
  stampDot: string;
  stampDotFilled: string;
  /** The dashed offline / failed panel that stands in for the payment code. */
  panelBg: string;
  panelBorder: string;
  panelTitle: string;
  panelBody: string;
}

function lightInk(source: CardInk['source'], from: string, to: string, ink: string): CardInk {
  // Today's values, unchanged. WalletCard.tsx and PaymentCode.tsx carried them
  // as literals; they are the documented §2 exceptions, not a new choice.
  return {
    source,
    from,
    to,
    inkOn: 'light',
    text: ink,
    labelOpacity: 0.85,
    unitOpacity: 0.82,
    legendOpacity: 0.88,
    stampText: withAlpha(ink, 0.78),
    pillBg: withAlpha(ink, 0.18),
    track: withAlpha(ink, 0.22),
    fill: ink,
    stampDot: withAlpha(ink, 0.22),
    stampDotFilled: ink,
    panelBg: withAlpha(ink, 0.14),
    panelBorder: withAlpha(ink, 0.4),
    panelTitle: ink,
    panelBody: withAlpha(ink, 0.85),
  };
}

function darkInk(source: TierName, from: string, to: string, ink: string): CardInk {
  return {
    source,
    from,
    to,
    inkOn: 'dark',
    text: ink,
    labelOpacity: 1,
    unitOpacity: 1,
    legendOpacity: 1,
    stampText: ink,
    pillBg: withAlpha(ink, 0.08),
    track: withAlpha(ink, 0.18),
    fill: ink,
    stampDot: withAlpha(ink, 0.18),
    stampDotFilled: ink,
    panelBg: withAlpha(ink, 0.06),
    panelBorder: withAlpha(ink, 0.4),
    panelTitle: ink,
    panelBody: ink,
  };
}

/**
 * The brand card. Read at call time, not captured at import: `theme.card` is the
 * object `./brand` writes a salon's gradient into at boot, and a module-scope
 * copy would freeze whichever palette happened to be loaded first.
 */
export function brandInk(): CardInk {
  return lightInk('brand', cardGradient.from, cardGradient.to, WHITE);
}

export function tierInk(tier: TierName): CardInk {
  const t = tierStyles[tier];
  return relativeLuminance(t.cardText) > 0.5
    ? lightInk(tier, t.cardFrom, t.cardTo, t.cardText)
    : darkInk(tier, t.cardFrom, t.cardTo, t.cardText);
}

/**
 * The card's palette for this member. Only a tiers-mode progress carries a tier;
 * stamps and a null progress (no ladder, or no tier yet) keep the brand.
 */
export function cardInkFor(progress: LoyaltyProgress | null): CardInk {
  return progress?.mode === 'tiers' ? tierInk(progress.current) : brandInk();
}

/**
 * The card's children — the payment code panel — draw on the same gradient and
 * have to take the same ink. A context rather than a prop because `HomeScreen`
 * composes the child and the card independently; threading the palette through
 * it would give the screen a second place to get it wrong.
 *
 * The default is the brand ink, so a panel rendered outside a card (none is
 * today) draws exactly as it did.
 */
const CardInkContext = createContext<CardInk | null>(null);
export const CardInkProvider = CardInkContext.Provider;

export function useCardInk(): CardInk {
  return useContext(CardInkContext) ?? brandInk();
}
