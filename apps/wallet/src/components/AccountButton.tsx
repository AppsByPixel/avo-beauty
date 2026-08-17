/**
 * The header avatar — design:197. The only way into Account.
 *
 * A 34pt circle in the design, which is under the 44pt minimum in
 * design/tokens/avo-tokens.json → $rules.minTapTarget. The CIRCLE stays 34pt so
 * the header matches the design; the TARGET is 44pt, taken by padding around it.
 * That is the standard resolution of a visual-size-versus-hit-size conflict and
 * it is invisible in a screenshot, which is why it is worth a comment.
 *
 * `accessibilityLabel` is the screen's name ("Account" / "حسابي") rather than
 * "profile picture": the control navigates, and the design's own `title`
 * attribute says the same thing.
 */

import { Pressable, StyleSheet, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { color, CONTROL_BORDER, MIN_TAP_TARGET, radius } from '../theme';
import { useCopy } from '../i18n/language';

export function AccountButton({ onPress }: { onPress: () => void }) {
  const copy = useCopy();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={copy.accountTitle}
      testID="account-open"
      style={styles.target}
    >
      <View style={styles.circle}>
        <Svg width={17} height={17} viewBox="0 0 24 24" fill="none">
          {/* brandDeep on white — the stroke colour the design names. */}
          <Circle cx={12} cy={8.5} r={3.6} stroke={color.brandDeep} strokeWidth={1.7} />
          <Path
            d="M4.8 20c.9-3.4 3.7-5.2 7.2-5.2s6.3 1.8 7.2 5.2"
            stroke={color.brandDeep}
            strokeWidth={1.7}
            strokeLinecap="round"
          />
        </Svg>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  target: {
    minWidth: MIN_TAP_TARGET,
    minHeight: MIN_TAP_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  circle: {
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: CONTROL_BORDER,
    backgroundColor: color.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
