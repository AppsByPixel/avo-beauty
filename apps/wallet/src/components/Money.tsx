/**
 * The display boundary for money, and the only one.
 *
 * Nothing in this app formats an amount by hand. `formatFils` and
 * `moneyAriaLabel` come from @avo/types so the wallet, the scanner, the
 * dashboard and the API cannot disagree about what 24500 looks like — 3
 * decimals, Western digits, in both languages (non-negotiable #1 and #12).
 *
 * The accessibility label is not optional decoration: without it a screen reader
 * reads "24.500" as "twenty-four point five", and interaction-spec.md §2 is
 * explicit that it must read as Kuwaiti dinars.
 */

import { StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';
import { formatFils, formatMoney, moneyAriaLabel, type Fils, type Language } from '@avo/types';
import { frauncesLineHeight, moneyFigureFace, text } from '../theme';
import { useLanguage } from '../i18n/language';

interface Props {
  amount: Fils;
  /** Colour applied to both the figure and the unit. */
  color: string;
  /** Type token for the figure. The unit is sized relative to it by the caller. */
  figureStyle: object;
  /**
   * SIZE AND OPACITY FOR THE UNIT — NOT ITS FACE.
   *
   * This layers OVER `text('bodyS', lang, unitWeight)`, so a caller that passes
   * `{ fontSize: 11.5 }` gets the language's face for free. A caller that wants
   * a different WEIGHT passes `unitWeight`; a `fontWeight` in here would sit
   * over a single-weight face and do nothing, which is the defect
   * `theme/typeFidelity.test.ts` exists to catch.
   */
  unitStyle: object;
  /**
   * The unit's weight, resolved to a real face by `text()`. Optional because
   * three of the four call sites want the token's own 400.
   */
  unitWeight?: '400' | '500' | '600' | '700';
}

/**
 * The design sets the figure and its unit at different sizes, so they cannot be
 * a single Text node — but the string on screen is still `formatMoney`'s output
 * and only its output. The unit is whatever `formatMoney` appended, never a
 * literal held in this app: a hard-coded "KD" here is precisely how an Arabic
 * build ends up rendering "24.500 KD" instead of "24.500 د.ك"
 * (non-negotiable #12).
 */
function split(amount: Fils, lang: Language): { figure: string; unit: string } {
  const figure = formatFils(amount);
  return { figure, unit: formatMoney(amount, lang).slice(figure.length).trim() };
}

/**
 * A LINE BOX THAT CAN ACTUALLY HOLD THE FACE THIS COMPONENT IMPOSES.
 *
 * `Money` pins the figure to Fraunces (`moneyFigureFace()`) regardless of what
 * the caller's `figureStyle` says. A caller therefore hands over a SIZE without
 * being able to know the vertical metrics the glyphs will need — so the
 * component that chooses the face is the component that has to make the box
 * fit it. Anywhere else and the two facts sit in different files.
 *
 * THE BUG THIS CLOSES. `WalletCard` passed `text('displayXL')`, whose token is
 * `fontSize 52 / lineHeight 47` — a ratio of 0.900. Fraunces' natural box is
 * 1.233 em, so 52pt needs 65px and was given 47px, 17px short. In CSS a
 * `line-height` below the content height does not clip, it lets the glyphs
 * overflow, which is what the designer saw in the browser mock and why 0.9 is
 * a legitimate reading of the design. React Native CLIPS instead, and took the
 * top off the balance — a real platform difference, handled the way CLAUDE.md
 * § "Do not restyle" directs: follow the platform and note it.
 *
 * The token is deliberately NOT changed. `packages/tokens` is trunk-owned, and
 * 0.9 remains correct for the CSS surfaces that read the same token.
 *
 * IT ONLY EVER RAISES, AND ONLY WHEN A BOX WAS DECLARED. `displayXL` is the
 * one token in the scale that declares a `lineHeight` at all; the other three
 * `Money` call sites (`TopUpCard` ×2, `DeleteAccountSheet`) pass a token with
 * none, so their box is already `normal` — which IS the natural Fraunces box,
 * and is already correct. Returning `null` for them keeps this a clamp rather
 * than a setter, so no layout moves anywhere except where it was broken.
 */
function fittedFigureBox(figureStyle: object): TextStyle | null {
  const flat = StyleSheet.flatten(figureStyle as StyleProp<TextStyle>) ?? {};
  const { fontSize, lineHeight } = flat;
  if (typeof fontSize !== 'number' || typeof lineHeight !== 'number') return null;
  const fitted = frauncesLineHeight(fontSize);
  return lineHeight < fitted ? { lineHeight: fitted } : null;
}

/**
 * A figure and its unit, with one accessibility label covering both so the
 * reader says "twenty-four point five zero zero Kuwaiti dinars" once, rather
 * than reading the number and the letters K D separately.
 */
export function Money({ amount, color, figureStyle, unitStyle, unitWeight }: Props) {
  const { lang } = useLanguage();
  const { figure, unit } = split(amount, lang);
  return (
    <View
      style={styles.row}
      accessible
      accessibilityRole="text"
      accessibilityLabel={moneyAriaLabel(amount, lang)}
    >
      {/*
        THE FIGURE IS ALWAYS FRAUNCES, IN BOTH LANGUAGES.

        The digits are Western in Arabic (non-negotiable #12) and the design
        system reserves the display face for exactly that. Set on the node
        rather than relying on a font fallback stack, which React Native does
        not have. See theme/index.ts § moneyFigureFace.
      */}
      <Text
        style={[
          figureStyle,
          // Raises a declared box that Fraunces cannot fit; a no-op otherwise.
          // See `fittedFigureBox`.
          fittedFigureBox(figureStyle),
          { color, fontFamily: moneyFigureFace() },
        ]}
        accessibilityElementsHidden
        importantForAccessibility="no"
      >
        {figure}
      </Text>
      {/*
        THE UNIT IS THE HALF THAT CHANGES SCRIPT — "KD" or "د.ك" — SO THE FACE
        IS RESOLVED HERE AND IS NOT THE CALLER'S TO SUPPLY.

        This line used to read `[unitStyle, { color }]`, and the comment above
        it said the unit "takes whatever face the language's type scale
        supplies". That was a statement about the CALL SITES, and it was true of
        exactly one of the four: `WalletCard` composed `text('bodyL', lang,
        '500')` into `unitStyle`, and `TopUpCard`'s two and
        `DeleteAccountSheet`'s passed a bare `{ fontSize }`. Those three
        resolved no family at all, so react-native-web emitted the node with no
        `font-family` and the browser drew both scripts in the OS UI stack
        (`-apple-system,BlinkMacSystemFont,…` — RNW's own Text base style is
        `font: '14px System'`).

        Measured: at 11.5px "KD" is 16.00px in that stack against 16.21px in
        Inter_500Medium — the wrong typeface by a fifth of a pixel, which is why
        nobody saw it. "د.ك" is 14.24px against 17.78px in
        IBMPlexSansArabic_500Medium, a 20% narrower face on a 14px line box
        instead of 17.5px, in a row laid out on the baseline. Non-negotiable #12
        is the Arabic half; the Latin half is real and very nearly invisible.

        A comment cannot hold that line, because it records what four callers
        happen to do and the fifth caller has not been written yet. So the base
        moved here. `unitStyle` now layers over a face the language already
        chose, and a caller CANNOT reintroduce the defect by passing a bare
        size. `theme/typeFidelity.test.ts` § "every Text that draws copy
        resolves a face" is the guard for the same class everywhere else.
      */}
      <Text
        style={[text('bodyS', lang, unitWeight), unitStyle, { color }]}
        accessibilityElementsHidden
        importantForAccessibility="no"
      >
        {unit}
      </Text>
    </View>
  );
}

/**
 * The activity row amount: already signed and formatted by toActivityRow.
 *
 * Western digits and the display face in both languages, for the same reason as
 * above — this is money. Bidi keeps `+27.500` together as one left-to-right run
 * inside an Arabic row, so no isolation mark is needed.
 */
export function SignedAmount({
  display,
  label,
  color,
}: {
  display: string;
  label: string;
  color: string;
}) {
  // The design sets activity amounts in the display face at body size. There is
  // no single token for that pairing, so it is composed from two rather than
  // typed: the `money` token supplies the face and weight, `bodyL` the size.
  const { fontFamily, fontWeight } = text('money');
  const { fontSize } = text('bodyL');
  return (
    <Text style={[{ fontFamily, fontWeight, fontSize, color }]} accessibilityLabel={label}>
      {display}
    </Text>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
});
