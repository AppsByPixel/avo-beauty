/**
 * The display boundary for money, and the only one.
 *
 * Nothing in this app formats an amount by hand — `formatFils`, `formatMoney`
 * and `moneyAriaLabel` come from @avo/types so the scanner, the wallet, the
 * dashboard and the API cannot disagree about what 24500 looks like
 * (non-negotiable #1).
 *
 * The accessibility label is not decoration. Without it a screen reader says
 * "three point zero zero zero" or, worse, "three thousand"; interaction-spec.md
 * §2 requires it to read as Kuwaiti dinars.
 *
 * THE SCANNER IS ENGLISH-ONLY (design/README.md § Known gaps 1), so `lang` is
 * fixed at 'en' here rather than threaded through a provider. It is still
 * passed to the helpers rather than assumed, so the unit string is whatever
 * @avo/types appends and never a literal in this app.
 */

import { StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';
import { formatFils, formatMoney, moneyAriaLabel, type Fils } from '@avo/types';

const LANG = 'en' as const;

/** "24.500" — the figure alone, for a layout that sizes the unit separately. */
export function figureOf(amount: Fils): string {
  return formatFils(amount);
}

/** "24.500 KD" — figure and unit, as one string. */
export function moneyOf(amount: Fils): string {
  return formatMoney(amount, LANG);
}

/** The unit @avo/types appended, never a literal held here. */
function unitOf(amount: Fils): string {
  const figure = formatFils(amount);
  return formatMoney(amount, LANG).slice(figure.length).trim();
}

interface Props {
  amount: Fils;
  figureStyle?: StyleProp<TextStyle>;
  unitStyle?: StyleProp<TextStyle>;
  /** When the design shows the figure alone, with no unit beside it. */
  hideUnit?: boolean;
}

/**
 * A figure and its unit at different sizes — which the design does in several
 * places — with ONE accessibility label covering both, so the reader says the
 * amount once rather than reading the number and then the letters K D.
 */
export function Money({ amount, figureStyle, unitStyle, hideUnit }: Props) {
  return (
    <View
      style={styles.row}
      accessible
      accessibilityRole="text"
      accessibilityLabel={moneyAriaLabel(amount, LANG)}
    >
      <Text style={figureStyle}>{figureOf(amount)}</Text>
      {!hideUnit && <Text style={[styles.unit, unitStyle]}>{unitOf(amount)}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'baseline' },
  unit: { marginLeft: 4 },
});
