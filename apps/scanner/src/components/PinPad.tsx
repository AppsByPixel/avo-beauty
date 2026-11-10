/**
 * Four dots and the keypad, for CHOOSING a PIN on the pairing screen.
 *
 * The brief for the pairing slice (DECISIONS.md § "Staff phone pairing, phone
 * sign-in, and a truthful receipt line — Aftab, 2026-11-10") asks for "the
 * existing PIN keypad style", and in the same breath says "the PIN screen itself
 * does not change". So this is PinScreen's keypad restated with the same values
 * and the same citations — design/AVO Staff Scanner.dc.html:83, :587, :589 —
 * rather than extracted out of PinScreen, which would have been a change to the
 * one screen the ruling froze. The duplication is deliberate and small; if
 * PinScreen is ever refactored onto this component, the two sets of values
 * below must be identical, and they are today.
 *
 * Same physical-keyboard rule as PinScreen (interaction-spec.md §2: "The 4-digit
 * PIN pad must accept physical keyboard digits and Backspace"), by the same
 * mechanism: a focused, zero-sized TextInput with `showSoftInputOnFocus={false}`.
 */

import { useCallback } from 'react';
import {
  Pressable,
  Text,
  TextInput,
  View,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
} from 'react-native';
import { PIN_LENGTH } from '../domain/pairing';
import { color, display, MIN_TAP_TARGET, ui } from '../theme';
import { brandedStyles } from '../theme/branded';

/** design:589 — the keypad key fill. The same value PinScreen carries. */
const KEYPAD_FILL = 'rgba(28,27,25,0.04)';
/** design:587 — the empty PIN dot's border. The same value PinScreen carries. */
const DOT_EMPTY_BORDER = 'rgba(28,27,25,0.25)';

export function PinDots({ filled }: { filled: number }) {
  return (
    <View
      style={styles.dots}
      accessible
      accessibilityRole="text"
      accessibilityLabel={`PIN, ${filled} of ${PIN_LENGTH} digits entered`}
    >
      {Array.from({ length: PIN_LENGTH }, (_, i) => (
        <View key={i} style={[styles.dot, i < filled ? styles.dotOn : styles.dotOff]} />
      ))}
    </View>
  );
}

export function PinPad({
  value,
  disabled,
  onDigit,
  onDelete,
  onHardwareText,
  testIDPrefix,
}: {
  value: string;
  disabled: boolean;
  onDigit: (digit: string) => void;
  onDelete: () => void;
  /** The hardware-keyboard field's whole value, as PinScreen's `onHardwareText` takes it. */
  onHardwareText: (value: string) => void;
  testIDPrefix: string;
}) {
  const onHardwareKey = useCallback(
    (e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      if (e.nativeEvent.key === 'Backspace') onDelete();
    },
    [onDelete],
  );

  return (
    <>
      <TextInput
        value={value}
        onChangeText={onHardwareText}
        onKeyPress={onHardwareKey}
        keyboardType="number-pad"
        showSoftInputOnFocus={false}
        caretHidden
        autoFocus
        maxLength={PIN_LENGTH}
        editable={!disabled}
        style={styles.hiddenInput}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        testID={`${testIDPrefix}-hardware-input`}
      />
      <View style={styles.keypad}>
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'].map((key, i) => {
          if (key === '') return <View key={`gap-${i}`} style={styles.key} />;
          const isDel = key === 'del';
          return (
            <Pressable
              key={key}
              onPress={isDel ? onDelete : () => onDigit(key)}
              disabled={disabled}
              accessibilityRole="button"
              accessibilityLabel={isDel ? 'Delete' : key}
              testID={isDel ? `${testIDPrefix}-del` : `${testIDPrefix}-${key}`}
              style={({ pressed }) => [
                styles.key,
                !isDel && styles.keyFilled,
                pressed && styles.keyPressed,
                disabled && styles.keyDisabled,
              ]}
            >
              <Text style={isDel ? [ui(22), styles.keyGlyph] : [display(25), styles.keyGlyph]}>
                {isDel ? '⌫' : key}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </>
  );
}

const styles = brandedStyles(() => ({
  hiddenInput: { position: 'absolute', width: 1, height: 1, opacity: 0, top: 0, left: 0 },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 16, marginTop: 18 },
  dot: { width: 13, height: 13, borderRadius: 7 },
  dotOn: { backgroundColor: color.brand },
  dotOff: { borderWidth: 1.5, borderColor: DOT_EMPTY_BORDER },
  // design:83 — 3 columns, gap 10, max 280 wide, pinned to the bottom.
  keypad: {
    marginTop: 'auto',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    maxWidth: 280,
    width: '100%',
    alignSelf: 'center',
  },
  key: {
    // (280 - 2 gaps of 10) / 3
    width: 86.66,
    height: 58,
    minHeight: MIN_TAP_TARGET,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyFilled: { backgroundColor: KEYPAD_FILL },
  keyPressed: { opacity: 0.55 },
  keyDisabled: { opacity: 0.4 },
  keyGlyph: { color: color.ink },
}));
