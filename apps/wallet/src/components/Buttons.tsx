/**
 * The three controls the sheets share.
 *
 * They exist so that non-negotiable #9 is satisfied structurally rather than
 * repeatedly: a filled button in this app takes its background from
 * `onBrandFill`, which is `brandDeep`, and there is no prop that lets a caller
 * put white on `brand`.
 *
 * Every one of them clears the 44pt minimum tap target from
 * design/tokens/avo-tokens.json → $rules.minTapTarget, and takes a focus-visible
 * ring on web from the shared style below (interaction-spec.md §2).
 */

import { Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';
import { color, MIN_TAP_TARGET, onBrandFill, radius, text } from '../theme';

/**
 * interaction-spec.md §2 focus ring: 2px solid #6E7F6C, offset 2px, and
 * `:focus-visible` rather than `:focus` so a mouse press does not ring.
 * react-native-web maps these through to CSS.
 */
const focusRing = {
  outlineColor: color.brand,
  outlineWidth: 2,
  outlineStyle: 'solid',
  outlineOffset: 2,
} as unknown as ViewStyle;

interface ButtonProps {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}

export function PrimaryButton({
  label,
  onPress,
  disabled,
  testID,
  accessibilityLabel,
  style,
}: ButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      accessibilityLabel={accessibilityLabel ?? label}
      testID={testID}
      style={[styles.base, styles.primary, disabled && styles.disabled, style]}
    >
      <Text style={[text('bodyL'), styles.primaryText, disabled && styles.disabledText]}>
        {label}
      </Text>
    </Pressable>
  );
}

export function SecondaryButton({
  label,
  onPress,
  disabled,
  testID,
  accessibilityLabel,
  style,
}: ButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      accessibilityLabel={accessibilityLabel ?? label}
      testID={testID}
      style={[styles.base, styles.secondary, style]}
    >
      {/* Brand text on a light surface is brandDeep, never brand. */}
      <Text style={[text('bodyL'), styles.secondaryText]}>{label}</Text>
    </Pressable>
  );
}

/** A whole row that is one control — a method tile, an activity row. */
export function TappableRow({
  children,
  ...props
}: React.ComponentProps<typeof Pressable> & { children: React.ReactNode }) {
  return (
    <Pressable {...props} style={[focusRing, props.style as StyleProp<ViewStyle>]}>
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    width: '100%',
    minHeight: MIN_TAP_TARGET,
    paddingVertical: 16,
    borderRadius: radius.button,
    alignItems: 'center',
    justifyContent: 'center',
    ...focusRing,
  },
  primary: { backgroundColor: onBrandFill.backgroundColor },
  primaryText: { color: onBrandFill.color, fontWeight: '600' },
  secondary: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: color.borderControl,
    paddingVertical: 15,
  },
  secondaryText: { color: color.brandDeep, fontWeight: '600' },
  disabled: { backgroundColor: color.disabledBg },
  disabledText: { color: color.textMutedSoft },
});
