/**
 * The app's only source of colour, type and spacing.
 *
 * Everything here re-exports `@avo/tokens/native`, which is generated from
 * design/tokens/avo-tokens.json. CLAUDE.md phase 0: "never re-type a hex".
 * If you find yourself wanting a colour that is not on `theme.color`, the token
 * file is the place to add it — not this app.
 */

import type { TextStyle } from 'react-native';
import { theme } from '@avo/tokens/native';
import { hexToRgb, tokens } from '@avo/tokens';
import { seal } from './sealed';

/**
 * From here on the palette is fixed for the life of the process.
 *
 * `onBrandFill` and `brandTextColor` below read `color.brandDeep` at module
 * scope, and every screen's `StyleSheet.create` reads the brand tokens the same
 * way, so this module is the first consumer of the palette by construction. A
 * salon's hex has to be applied before this line runs; after it, applying one
 * would theme only the modules not yet evaluated. `./sealed` carries the full
 * argument, and `./brand` refuses -- loudly -- once this has fired.
 */
seal();

export { theme };
export const color = theme.color;
export const radius = theme.radius;
export const space = theme.space;
export const tierStyles = theme.tier;

/** design/tokens/avo-tokens.json → $rules.minTapTarget */
export const MIN_TAP_TARGET = theme.control.minTapTarget;

// -------------------------------------------------------------------- type --

/**
 * The token text styles carry a family ("Fraunces" / "Inter") and a numeric
 * weight. React Native resolves a weight to a face only if that face is
 * registered, so the Google Fonts packages are loaded as one family name per
 * weight and mapped back here. The sizes and weights themselves are never
 * restated — they come straight off the token.
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
  /**
   * design/README.md § Typography: "IBM Plex Sans Arabic (400–700) — Arabic
   * (AR / RTL) mode in the customer app only." Also the third family in the
   * design's own font stack, AVO Wallet Home.dc.html:74.
   */
  IBMPlexSansArabic: {
    '400': 'IBMPlexSansArabic_400Regular',
    '500': 'IBMPlexSansArabic_500Medium',
    '600': 'IBMPlexSansArabic_600SemiBold',
    '700': 'IBMPlexSansArabic_700Bold',
  },
};

/** The italic display face, used for the "One wallet" note. */
export const FRAUNCES_ITALIC = 'Fraunces_400Regular_Italic';

/** The one Latin face that survives into Arabic mode. See `moneyFigureFace`. */
export const ARABIC_FAMILY = 'IBMPlexSansArabic';

function face(family: string, weight: string): string {
  return FACES[family]?.[weight] ?? FACES[family]?.['400'] ?? family;
}

export type TypeToken = keyof typeof theme.text;

/**
 * A token name in, a React Native text style out.
 * `text('money')` is the only correct way to size a money figure.
 *
 * ARABIC IS NOT A FONT FALLBACK HERE, AND THAT IS DELIBERATE.
 *
 * The design prototype gets away with the CSS stack `Inter, 'IBM Plex Sans
 * Arabic', system-ui` (AVO Wallet Home.dc.html:74): the browser takes Latin
 * glyphs from Inter and falls through to Plex Arabic for anything Inter has no
 * glyph for. React Native has no such mechanism — `fontFamily` is one family,
 * and an Arabic string set in Fraunces renders as tofu or as whatever the OS
 * substitutes. A silent system substitution is exactly the failure the lane
 * brief asked to check for, so the family is chosen explicitly and is therefore
 * verifiable in the computed style.
 *
 * The rule: in Arabic every *text* token becomes IBM Plex Sans Arabic. The one
 * exception is the money figure, which stays Fraunces — see `moneyFigureFace`.
 *
 * Two token properties are also dropped in Arabic, because they are Latin
 * typesetting instructions that damage Arabic:
 *
 *   letterSpacing  — Arabic is cursive. Tracking pulls the joins apart and the
 *                    word stops reading as a word. The `label` token carries
 *                    +0.88 and the display tokens carry negative tracking;
 *                    neither is meaningful for this script.
 *   textTransform  — `uppercase` has no effect on Arabic (there is no case), so
 *                    it is dropped rather than left as a no-op that a later
 *                    reader has to reason about.
 *
 * THE THIRD ARGUMENT EXISTS BECAUSE `fontWeight` ALONE IS INERT HERE.
 *
 * Because this function pins `fontFamily` to a single-weight face, a later
 * style object in the same array that raises `fontWeight` changes nothing that
 * can be rendered:
 *
 *     StyleSheet.flatten([text('bodyS', 'en'), { fontWeight: '600' }])
 *       // { fontSize: 12.5, fontWeight: '600', fontFamily: 'Inter_400Regular' }
 *
 * — a request for SemiBold pointed at the Regular face. `Inter_600SemiBold` is
 * loaded (App.tsx) and reachable (`text('label')` selects it), and this style
 * never asks for it. In Arabic it is worse and it is non-negotiable #12: the
 * family resolves to `IBMPlexSansArabic_400Regular` while
 * `IBMPlexSansArabic_600SemiBold` sits loaded and unused, so an emphasis the
 * design specifies disappears entirely in the language the design calls a
 * first-class layout rather than a translation pass.
 *
 * So a weight that differs from the token's own belongs HERE, where the face is
 * resolved, and not in a `StyleSheet.create` object — which additionally cannot
 * hold the right answer, because the right answer depends on `lang`.
 */
export function text(
  token: TypeToken,
  lang: 'en' | 'ar' = 'en',
  weight?: '400' | '500' | '600' | '700',
): TextStyle {
  const t = theme.text[token];
  const w = weight ?? t.fontWeight;
  const style: TextStyle = {
    ...t,
    // The generator emits the weight as a string ("500"); React Native's
    // TextStyle enumerates the legal values. The token file is the authority on
    // which weights exist, so this narrows rather than validates.
    fontWeight: w as TextStyle['fontWeight'],
    fontFamily: face(t.fontFamily, w),
  };
  if (lang !== 'ar') return style;
  // Omitted, not set to undefined: `exactOptionalPropertyTypes` treats an
  // explicit undefined as a different thing from an absent key.
  const { letterSpacing: _ls, textTransform: _tt, ...rest } = style;
  return { ...rest, fontFamily: face(ARABIC_FAMILY, w) };
}

/**
 * The face a money FIGURE is set in, in either language.
 *
 * Always Fraunces. Non-negotiable #12 keeps money in Western digits in both
 * languages, and the design system reserves the display face for exactly that:
 * "Fraunces — display numerals, headings, balances, prices". The design's own
 * Arabic stack agrees: `'Fraunces','IBM Plex Sans Arabic', serif`
 * (AVO Wallet Home.dc.html:86) puts Fraunces first, so `24.500` comes from
 * Fraunces and only the unit د.ك — which Fraunces has no glyphs for — falls
 * through to Plex Arabic.
 *
 * `src/components/Money.tsx` already splits the figure from the unit into two
 * Text nodes for sizing reasons. That split is the seam this rule needs: figure
 * in Fraunces, unit in whatever `text()` returns for the language.
 */
export function moneyFigureFace(weight: '400' | '500' | '600' = '600'): string {
  return face('Fraunces', weight);
}

/**
 * White — the one colour that is genuinely constant across every white-label
 * brand, so it is a token rather than twenty scattered `'#fff'` literals.
 *
 * GAP CLOSED: `color.white` landed on trunk and this now reads it. The
 * translucent white scale the wallet card documents as intentional exceptions
 * (0.14 / 0.18 / 0.22 / 0.4 / 0.78 / 0.85) is still not tokenised.
 */
export const WHITE = color.white;

/**
 * Non-negotiable #9 / interaction-spec.md §2.
 *
 * White text never sits on `brand`; it sits on `brandDeep`. Exported as a named
 * pair so a primary button cannot be written any other way, and so a review can
 * grep for the one place the rule is encoded.
 */
export const onBrandFill = {
  backgroundColor: color.brandDeep,
  color: WHITE,
} as const;

/**
 * A palette colour at an alpha, composited rather than typed.
 *
 * THE LITERALS THIS REPLACES WERE A LATENT REBRAND BUG. Five style entries
 * across the two apps carried `rgba(110,127,108,0.22)` (and one at 0.3) with a
 * comment saying it is "`brand` at 22%, because `hairline` is ink at 8% and
 * reads grey against the wash rather than green". That was true when written and
 * stopped being true twice over: once when a salon's hex is applied at boot, and
 * again when trunk revised the brand ramp, after which the literal was the OLD
 * brand sitting as a grey-green edge on the new green wash - the exact failure
 * the comment existed to prevent.
 *
 * Deriving it means the edge follows `brand` through both, and there is one
 * place to read instead of five hand-sampled alphas to keep in step.
 */
export function withAlpha(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * The 1px edge on a brand-washed panel - `brand` at 22%, design:591. Used on
 * every brand-washed panel in the bundle.
 */
export const BRAND_BORDER = withAlpha(color.brand, 0.22);

/** Brand-coloured text on a light surface is also `brandDeep`, never `brand`. */
export const brandTextColor = color.brandDeep;

/** The wallet card gradient. `brand` is a surface colour — this is its job. */
export const cardGradient = theme.card;

/**
 * Shadows, borders and motion are in the token source but the generator's React
 * Native emitter drops them (packages/tokens/src/generate.ts → emitNative only
 * fans out color, card, text, radius, space, control and tier). They are taken
 * off the typed root export instead, which carries the whole token tree.
 *
 * SHARED-PACKAGE GAP (reported, not fixed): emitNative should include `shadow`,
 * `border` and `motion` so a native surface has one import rather than two.
 */
export const shadow = tokens.shadow;
export const motion = tokens.motion;

/**
 * Uppercase micro-labels ("ACTIVITY", "EARNING BY BRANCH").
 *
 * interaction-spec.md §2 says these must be `rgba(28,27,25,0.6)` — 0.45 measures
 * ~3.3:1 at 11px/600 and fails.
 *
 * GAP CLOSED: `color.textMutedLabel` (0.6) landed on trunk, so this is now the
 * value the spec actually names rather than the `textMutedStrong` (0.7) stand-in
 * it used before.
 */
export const MICRO_LABEL_COLOR = color.textMutedLabel;

/**
 * The border on a secondary control — the outlined "Try again" button, the
 * segmented rows, the input outlines. The design uses `rgba(28,27,25,0.14)` for
 * this in over twenty places across AVO Wallet Home.dc.html and AVO
 * States.dc.html, so it is a system value and not a one-off.
 *
 * `hairline` (0.08) does not substitute: a hairline is a divider between rows and
 * is meant to disappear, while this is the edge of a tappable control and has to
 * read as one.
 *
 * GAP CLOSED: `color.borderControl` landed on trunk. This alias stays so the
 * existing call sites keep reading, but it is now a token and not a literal.
 */
export const CONTROL_BORDER = color.borderControl;
