/**
 * The controls, shared.
 *
 * They exist so three rules are satisfied structurally rather than remembered
 * at each call site:
 *
 * 1. Non-negotiable #9 — a filled button takes `onBrandFill` (= `brandDeep`).
 *    There is no prop that puts white on `brand`.
 * 2. interaction-spec.md §3 — every control clears the 44pt minimum tap target
 *    from the token file, including the small ones.
 * 3. interaction-spec.md §2 — the focus ring is 2px offset 2px, and on a DARK
 *    surface it takes `dark.focusRing` rather than the light ring. §2 writes the
 *    pair as `#A9BBA6` and `#6E7F6C`; the second of those is a superseded `brand`
 *    value, so the rule is stated here by token and `onDark` switches it.
 */

import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { color, dark, MIN_TAP_TARGET, onBrandFill, radius, ui } from '../theme';

/**
 * interaction-spec.md §2 — the focus ring, and WEB ONLY.
 *
 * The spec's ring is `:focus-visible`, i.e. a keyboard-navigation affordance.
 * On react-native-web these four properties map to the CSS outline and behave
 * that way. On native they do NOT: React Native 0.86 renders `outlineWidth` as
 * an unconditional border-like outline, so applying it here painted a
 * permanent green box around every control on the phone — visible in the first
 * simulator run of this screen, and obviously wrong against the design.
 *
 * A phone has no keyboard focus to indicate, so there is nothing to replace it
 * with on native. The PIN pad's physical-keyboard support is a separate thing
 * and lives in PinScreen's key handling, not here.
 */
const RING_SUPPORTED = Platform.OS === 'web';

function focusRing(onDark: boolean): ViewStyle | null {
  if (!RING_SUPPORTED) return null;
  return {
    outlineColor: onDark ? dark.focus : color.brand,
    outlineWidth: 2,
    outlineStyle: 'solid',
    outlineOffset: 2,
  } as unknown as ViewStyle;
}

interface ButtonProps {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  onDark?: boolean;
}

function pressableProps(p: ButtonProps) {
  return {
    onPress: p.onPress,
    disabled: p.disabled,
    accessibilityRole: 'button' as const,
    accessibilityState: { disabled: Boolean(p.disabled) },
    accessibilityLabel: p.accessibilityLabel ?? p.label,
    ...(p.accessibilityHint === undefined ? {} : { accessibilityHint: p.accessibilityHint }),
    testID: p.testID,
  };
}

/** The filled brand button. `brandDeep`, always. */
export function PrimaryButton(props: ButtonProps) {
  const { label, disabled, style, textStyle, onDark } = props;
  return (
    <Pressable
      {...pressableProps(props)}
      style={[styles.base, styles.primary, focusRing(onDark ?? false), disabled && styles.disabled, style]}
    >
      <Text
        style={[ui(15, '600'), styles.primaryText, disabled && styles.disabledText, textStyle]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** Outlined, on a light surface. */
export function SecondaryButton(props: ButtonProps) {
  const { label, disabled, style, textStyle, onDark } = props;
  return (
    <Pressable
      {...pressableProps(props)}
      style={[styles.base, styles.secondary, focusRing(onDark ?? false), disabled && styles.disabled, style]}
    >
      <Text style={[ui(14, '600'), styles.secondaryText, textStyle]}>{label}</Text>
    </Pressable>
  );
}

/**
 * The void control. design:263,390 — a light button with the danger outline,
 * never a filled red one. Reversing money is deliberate, not alarming.
 */
export function DangerButton(props: ButtonProps) {
  const { label, disabled, style, textStyle } = props;
  return (
    <Pressable
      {...pressableProps(props)}
      style={[styles.base, styles.danger, focusRing(false), disabled && styles.disabled, style]}
    >
      <Text style={[ui(14, '600'), styles.dangerText, textStyle]}>{label}</Text>
    </Pressable>
  );
}

/** Filled, for the confirm half of the void sheet. design:318. */
export function DangerFilledButton(props: ButtonProps) {
  const { label, disabled, style, textStyle } = props;
  return (
    <Pressable
      {...pressableProps(props)}
      style={[styles.base, styles.dangerFilled, focusRing(false), disabled && styles.disabled, style]}
    >
      <Text style={[ui(14.5, '600'), styles.primaryText, textStyle]}>{label}</Text>
    </Pressable>
  );
}

/** The translucent control on the dark scan screen. design:196. */
export function DarkButton(props: ButtonProps) {
  const { label, disabled, style, textStyle } = props;
  return (
    <Pressable
      {...pressableProps(props)}
      style={[styles.base, styles.darkFill, focusRing(true), disabled && styles.disabled, style]}
    >
      <Text style={[ui(14, '600'), styles.darkText, textStyle]}>{label}</Text>
    </Pressable>
  );
}

/** A text link — "‹ Home", "‹ Rescan", "Sign out". Padded to 44pt. */
export function LinkButton({
  label,
  onPress,
  onDark,
  muted,
  testID,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  onDark?: boolean;
  muted?: boolean;
  testID?: string;
  accessibilityLabel?: string;
}) {
  const tint = onDark
    ? muted
      ? dark.textMuted
      : dark.accent
    : muted
      ? color.textMuted
      : color.brandDeep;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      testID={testID}
      // Negative margin keeps the 44pt target without pushing the design's
      // layout around it — the touchable grows, the ink stays where it was.
      style={[styles.link, focusRing(onDark ?? false)]}
      hitSlop={12}
    >
      <Text style={[ui(13, '600'), { color: tint }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: MIN_TAP_TARGET,
    borderRadius: radius.button,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 15,
  },
  primary: { backgroundColor: onBrandFill },
  primaryText: { color: color.white },
  secondary: {
    backgroundColor: color.white,
    borderWidth: 1,
    borderColor: color.borderControl,
  },
  secondaryText: { color: color.brandDeep },
  danger: {
    backgroundColor: color.white,
    borderWidth: 1,
    borderColor: 'rgba(176,115,111,0.45)',
  },
  dangerText: { color: color.dangerText },
  dangerFilled: { backgroundColor: color.dangerText },
  darkFill: {
    backgroundColor: dark.fillStrong,
    borderWidth: 1,
    borderColor: dark.border,
  },
  darkText: { color: dark.text },
  disabled: { backgroundColor: color.disabledBg, borderColor: 'transparent' },
  disabledText: { color: color.textMutedSoft },
  link: {
    minHeight: MIN_TAP_TARGET,
    justifyContent: 'center',
    marginVertical: -10,
  },
});
