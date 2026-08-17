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
import { focusable } from '../theme/focus';

/*
 * THE FOCUS RING IS NOT A STYLE OBJECT. It used to be, and that was a bug: a
 * `{ outlineStyle: 'solid' }` in a React Native style paints an outline
 * unconditionally, because there is no pseudo-class in a style object to hang
 * `:focus-visible` off. Every control on every screen was permanently ringed.
 * It is now real CSS, injected once — see src/theme/focus.ts for the measurement
 * and the fix. Controls opt in with `dataSet={focusable}`.
 */

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
      dataSet={focusable}
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
      dataSet={focusable}
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
    // `dataSet` first so a caller that genuinely needs its own can override it.
    <Pressable dataSet={focusable} {...props} style={props.style as StyleProp<ViewStyle>}>
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
