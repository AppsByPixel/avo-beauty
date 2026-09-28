/**
 * The line beside "Loyalty" on the result screen: what this visit earned.
 * "+1 visit · 2 more to Gold" — DECISIONS.md § "The fourth list".
 *
 * Its own component, and a hookless one, so that it can be rendered by a test
 * in a workspace that has no renderer: `screens/resultLoyaltyLine.test.ts`
 * invokes it and reads the element tree it returns. Every word comes from
 * `domain/loyalty.ts § loyaltyGain`, and every number in those words from the
 * charge response — nothing here is counted on the client (non-negotiable #2).
 */

import { StyleSheet, Text } from 'react-native';
import type { ChargeResult } from '../api/charges';
import { loyaltyGain } from '../domain/loyalty';
import { color, ui } from '../theme';

export function LoyaltyLine({ result }: { result: Pick<ChargeResult, 'loyalty' | 'happyHour'> }) {
  return (
    <Text style={[ui(13.5, '500'), styles.loyalty]} testID="result-loyalty">
      {loyaltyGain(result.loyalty, result.happyHour)}
    </Text>
  );
}

const styles = StyleSheet.create({
  loyalty: { flex: 1, textAlign: 'right', color: color.ink },
});
