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
import { tokens } from '@avo/tokens';

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
};

/** The italic display face, used for the "One wallet" note. */
export const FRAUNCES_ITALIC = 'Fraunces_400Regular_Italic';

function face(family: string, weight: string): string {
  return FACES[family]?.[weight] ?? FACES[family]?.['400'] ?? family;
}

export type TypeToken = keyof typeof theme.text;

/**
 * A token name in, a React Native text style out.
 * `text('money')` is the only correct way to size a money figure.
 */
export function text(token: TypeToken): TextStyle {
  const t = theme.text[token];
  return {
    ...t,
    // The generator emits the weight as a string ("500"); React Native's
    // TextStyle enumerates the legal values. The token file is the authority on
    // which weights exist, so this narrows rather than validates.
    fontWeight: t.fontWeight as TextStyle['fontWeight'],
    fontFamily: face(t.fontFamily, t.fontWeight),
  };
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
