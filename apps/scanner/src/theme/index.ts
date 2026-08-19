/**
 * The scanner's only source of colour, type and spacing.
 *
 * Everything re-exports `@avo/tokens/native`, generated from
 * design/tokens/avo-tokens.json. CLAUDE.md: "never re-type a hex".
 *
 * THE DARK GROUP IS A TOKEN NOW, NOT A LOCAL CONSTANT.
 * ----------------------------------------------------
 * The scanner is the only surface in this app with a dark screen
 * (design/AVO Staff Scanner.dc.html § SCAN, `darkFrame` at :767). Its three
 * colours had no names in the token file when this app was first built, so they
 * were held here with citations and reported to trunk. Trunk added them —
 * `theme.dark.surface`, `.accent`, `.focusRing` — and this file reads them
 * rather than restating them. Nothing under `apps/scanner/src` types a hex.
 *
 * `focusRing` is deliberately a different value from `accent`
 * (interaction-spec.md §2: "On the dark owner-console sidebar and the dark
 * scanner frame, use #A9BBA6 instead — #6E7F6C does not carry enough contrast
 * against #1C1B19"), which is exactly why they are two tokens and not one.
 *
 * The white-on-dark overlays below stay local: they are compositing alphas that
 * only mean anything over `dark.surface`, not palette entries.
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

/** The dark scan surface. Three tokens, plus the alphas that sit on them. */
export const dark = {
  /** theme.dark.surface — AVO Staff Scanner.dc.html:183. */
  surface: theme.dark.surface,
  /** theme.dark.accent — brackets and the back link, :185, :190-193. */
  accent: theme.dark.accent,
  /** theme.dark.focusRing — interaction-spec.md §2. Not the accent. */
  focus: theme.dark.focusRing,
  /** Compositing alphas over `surface`, not brand colours. */
  fill: 'rgba(255,255,255,0.08)',
  fillStrong: 'rgba(255,255,255,0.10)',
  frame: 'rgba(255,255,255,0.03)',
  border: 'rgba(255,255,255,0.18)',
  text: color.white,
  textMuted: 'rgba(255,255,255,0.55)',
  /*
    `textFaint: 'rgba(255,255,255,0.4)'` WAS HERE AND IS GONE. It had zero uses,
    and composited over `surface` it is 3.84:1 — under the 4.5 floor. A token that
    nothing reads and that cannot legally carry text is a trap rather than a
    spare: the next person to want a de-emphasised label would have found it,
    used it, and shipped a sub-AA foreground with a token's authority behind it.
    `contrast.test.ts` now asserts every text token in this object clears AA, so
    re-adding it fails rather than passing quietly.
  */
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

/**
 * The shape every text token shares, with the three that only some carry
 * declared optional.
 *
 * WHY THIS WIDENING EXISTS — REPORTED TO TRUNK.
 * `packages/tokens`' generated `native.d.ts` types each text token as its own
 * literal object, so `theme.text[token]` is a UNION of nine distinct shapes and
 * `lineHeight`, `letterSpacing` and `textTransform` do not exist on all of
 * them. A helper that takes a token name — which both mobile apps have — then
 * cannot read them at all.
 *
 * This is an assignment, not a cast: every token really does have the three
 * required fields, and the optional three are simply absent on some. If the
 * generator ever emits a token missing `fontSize`, this line fails to compile,
 * which is the behaviour we want.
 *
 * apps/wallet has not hit this yet only because it still carries its own
 * hand-copied `types/avo-tokens-native.d.ts`, whose ambient `declare module`
 * shadows the package's new types. It will hit it the moment that file is
 * deleted, so the fix belongs in the generator rather than in both apps.
 */
interface NativeTextStyle {
  fontSize: number;
  fontWeight: string;
  fontFamily: string;
  lineHeight?: number;
  letterSpacing?: number;
  /**
   * `string`, not `'uppercase'` — the generator widens the JSON's literal, so
   * matching it here is what keeps this an assignment rather than a cast. It is
   * narrowed at the point of use below, where React Native needs a literal.
   */
  textTransform?: string;
}

const TEXT: Record<TypeToken, NativeTextStyle> = theme.text;

/** A token name in, a React Native text style out. */
export function text(token: TypeToken): TextStyle {
  const t = TEXT[token];
  const style: TextStyle = {
    fontSize: t.fontSize,
    fontFamily: face(t.fontFamily, t.fontWeight),
  };
  if (t.lineHeight !== undefined) style.lineHeight = t.lineHeight;
  if (t.letterSpacing !== undefined) style.letterSpacing = t.letterSpacing;
  // The only transform the token file uses. Checked rather than asserted, so a
  // new value added to the JSON is ignored here instead of reaching React
  // Native as an invalid style.
  if (t.textTransform === 'uppercase') style.textTransform = 'uppercase';
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
