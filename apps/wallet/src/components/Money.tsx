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

import { StyleSheet, Text, View } from 'react-native';
import { formatFils, formatMoney, moneyAriaLabel, type Fils, type Language } from '@avo/types';
import { text } from '../theme';

interface Props {
  amount: Fils;
  lang?: Language;
  /** Colour applied to both the figure and the unit. */
  color: string;
  /** Type token for the figure. The unit is sized relative to it by the caller. */
  figureStyle: object;
  unitStyle: object;
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
 * A figure and its unit, with one accessibility label covering both so the
 * reader says "twenty-four point five zero zero Kuwaiti dinars" once, rather
 * than reading the number and the letters K D separately.
 */
export function Money({ amount, lang = 'en', color, figureStyle, unitStyle }: Props) {
  const { figure, unit } = split(amount, lang);
  return (
    <View
      style={styles.row}
      accessible
      accessibilityRole="text"
      accessibilityLabel={moneyAriaLabel(amount, lang)}
    >
      <Text style={[figureStyle, { color }]} accessibilityElementsHidden importantForAccessibility="no">
        {figure}
      </Text>
      <Text style={[unitStyle, { color }]} accessibilityElementsHidden importantForAccessibility="no">
        {unit}
      </Text>
    </View>
  );
}

/** The activity row amount: already signed and formatted by toActivityRow. */
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
