/**
 * The scanner's only source of colour, type and spacing.
 *
 * Everything re-exports `@avo/tokens/native`, generated from
 * design/tokens/avo-tokens.json. CLAUDE.md: "never re-type a hex".
 *
 * TOKEN GAP — REPORTED, NOT INVENTED
 * ----------------------------------
 * The scanner is the only surface in the bundle with a **dark** screen
 * (design/AVO Staff Scanner.dc.html § SCAN, `darkFrame` at line 767), and the
 * token file has no names for any of its colours. Three values in `dark` below
 * are read straight off the design and the interaction spec, and every one is
 * cited. They are gathered here, in one object, rather than spread inline, so
 * that when `packages/tokens` grows the names this file is the only edit.
 *
 * Reported to trunk — `packages/tokens` is trunk-owned (CLAUDE.md § Lanes), so
 * this lane cannot add them:
 *
 *   dark.surface  #131511  scanner screen background
 *                 AVO Staff Scanner.dc.html:183
 *   dark.accent   #A7BBA0  viewfinder corner brackets, "‹ Home" on dark
 *                 AVO Staff Scanner.dc.html:185, 190-193
 *   dark.focus    #A9BBA6  focus ring on a dark surface. NOT the same value as
 *                 the accent, and deliberately so — interaction-spec.md §2:
 *                 "On the dark owner-console sidebar and the dark scanner
 *                 frame, use #A9BBA6 instead — #6E7F6C does not carry enough
 *                 contrast against #1C1B19."
 *
 * The white-on-dark overlays (`rgba(255,255,255,…)`) are compositing alphas
 * rather than brand colours, so they are local by nature and stay here.
 */

import type { TextStyle } from 'react-native';
import { theme } from '@avo/tokens/native';

export { theme };
export const color = theme.color;
export const radius = theme.radius;
export const space = theme.space;
export const card = theme.card;
export const tierStyles = theme.tier;

/** design/tokens/avo-tokens.json → $rules.minTapTarget. interaction-spec §3. */
export const MIN_TAP_TARGET = theme.control.minTapTarget;

/**
 * NON-NEGOTIABLE #9, MADE STRUCTURAL.
 *
 * The only background this app puts white text on. It is `brandDeep`, never
 * `brand` — even the default sage fails at 4.27:1 white-on-brand
 * (interaction-spec.md §2). Because every filled control reads this constant
 * instead of naming a colour, there is no prop anywhere in the app that can put
 * white on `brand`. `color.brand` stays available for surfaces: gradients,
 * tints, dots, progress fills, the selected-toggle track.
 */
export const onBrandFill = color.brandDeep;

/** See the TOKEN GAP note above. Every value is cited; none is invented. */
export const dark = {
  /** AVO Staff Scanner.dc.html:183 — the scan screen background. */
  surface: '#131511',
  /** AVO Staff Scanner.dc.html:185,190-193 — brackets and the back link. */
  accent: '#A7BBA0',
  /** interaction-spec.md §2 — the focus ring on a dark surface. */
  focus: '#A9BBA6',
  /** Compositing alphas over `surface`, not brand colours. */
  fill: 'rgba(255,255,255,0.08)',
  fillStrong: 'rgba(255,255,255,0.10)',
  frame: 'rgba(255,255,255,0.03)',
  border: 'rgba(255,255,255,0.18)',
  /** The token, not a re-typed hex — white is named in the token file. */
  text: color.white,
  textMuted: 'rgba(255,255,255,0.55)',
  textFaint: 'rgba(255,255,255,0.4)',
} as const;

/** interaction-spec.md §2 — the focus ring on a light surface. */
export const FOCUS_RING_LIGHT = color.brand;

// -------------------------------------------------------------------- type --

/**
 * React Native resolves a numeric weight to a face only if that face is
 * registered, so the Google Fonts packages register one family name per weight
 * and this maps the token's family+weight back onto them. Sizes and weights are
 * never restated — they come off the token.
 *
 * The scanner is English-only (design/README.md § Known gaps 1: Arabic is
 * customer-app only), so unlike the wallet there is no Plex Arabic face here
 * and no digit rule to apply.
 */
const FACES: Record<string, Record<string, string>> = {
  Fraunces: {
    '400': 'Fraunces_400Regular',
    '500': 'Fraunces_500Medium',
    '600': 'Fraunces_600SemiBold',
  },
  Inter: {
    '400': 'Inter_400Regular',
    '500': 'Inter_500Medium',
    '600': 'Inter_600SemiBold',
    '700': 'Inter_700Bold',
  },
};

function face(family: string, weight: string): string {
  return FACES[family]?.[weight] ?? FACES[family]?.['400'] ?? family;
}

export type TypeToken = keyof typeof theme.text;

/** A token name in, a React Native text style out. */
export function text(token: TypeToken): TextStyle {
  const t = theme.text[token];
  const style: TextStyle = {
    fontSize: t.fontSize,
    fontFamily: face(t.fontFamily, t.fontWeight),
  };
  if (t.lineHeight !== undefined) style.lineHeight = t.lineHeight;
  if (t.letterSpacing !== undefined) style.letterSpacing = t.letterSpacing;
  if (t.textTransform !== undefined) style.textTransform = t.textTransform;
  return style;
}

/**
 * The display face at an arbitrary size.
 *
 * The design uses Fraunces at sizes the token scale does not name (21, 24, 26)
 * for screen titles. Rather than re-typing a font family at each call site,
 * this keeps the family resolution in one place; the size still comes from the
 * caller, which is reading it off the design.
 */
export function display(fontSize: number, weight: '400' | '500' | '600' = '500'): TextStyle {
  return { fontSize, fontFamily: face('Fraunces', weight) };
}

/** The UI face at an arbitrary size. Same reasoning as `display`. */
export function ui(fontSize: number, weight: '400' | '500' | '600' | '700' = '400'): TextStyle {
  return { fontSize, fontFamily: face('Inter', weight) };
}
