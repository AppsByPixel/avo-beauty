/**
 * The form furniture the three account sheets share: a micro-label, an input and
 * the inline error banner.
 *
 * ON PASSWORDS — non-negotiable #6, "never shown in a UI", and its two halves:
 *
 *   never RENDERED   `secure` drives `secureTextEntry`, and the show/hide
 *                    control on the password sheet is the only thing that turns
 *                    it off. There is no default-visible password field.
 *   never LOGGED     `onChangeText` receives the raw value and hands it to the
 *                    caller's setter. Nothing in this file, and nothing in the
 *                    sheets, passes a field value to `console.*`. That is worth
 *                    stating because the obvious debugging move — logging the
 *                    form state object — logs three passwords at once.
 *
 * `autoComplete` is set so the platform's own password manager fills these
 * rather than the customer retyping a password into a field with autofill off,
 * which is how people end up choosing weaker ones.
 */

import { StyleSheet, Text, TextInput, View } from 'react-native';
import { color, MICRO_LABEL_COLOR, MIN_TAP_TARGET, radius, text } from '../../theme';
import { useLanguage } from '../../i18n/language';

export function FieldLabel({ children, hint }: { children: string; hint?: string }) {
  const { lang } = useLanguage();
  return (
    <Text style={[text('label', lang), styles.label]}>
      {children}
      {hint ? (
        // design:786, :829 — "(optional)" sits inside the label but drops the
        // uppercase and the tracking, so it is a nested Text and not a suffix.
        <Text style={[text('bodyS', lang), styles.labelHint]}> {hint}</Text>
      ) : null}
    </Text>
  );
}

interface FieldProps {
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  /** Renders as dots and disables autocorrect/suggestions. */
  secure?: boolean;
  keyboardType?: 'default' | 'email-address' | 'phone-pad' | 'number-pad';
  autoComplete?: 'name' | 'email' | 'tel' | 'current-password' | 'new-password' | 'one-time-code';
  /** Forced LTR — a phone number, an email or a code inside an Arabic layout. */
  ltr?: boolean;
  multiline?: boolean;
  maxLength?: number;
  accessibilityLabel: string;
  testID?: string;
}

export function Field({
  value,
  onChangeText,
  placeholder,
  secure,
  keyboardType = 'default',
  autoComplete,
  ltr,
  multiline,
  maxLength,
  accessibilityLabel,
  testID,
}: FieldProps) {
  const { lang } = useLanguage();
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder ?? ''}
      placeholderTextColor={color.textMutedSoft}
      secureTextEntry={Boolean(secure)}
      keyboardType={keyboardType}
      autoCapitalize={keyboardType === 'email-address' || secure ? 'none' : 'sentences'}
      autoCorrect={!secure}
      {...(autoComplete ? { autoComplete } : {})}
      multiline={Boolean(multiline)}
      {...(maxLength === undefined ? {} : { maxLength })}
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      style={[
        text('bodyL', lang),
        styles.input,
        multiline && styles.inputMultiline,
        ltr && styles.ltr,
      ]}
    />
  );
}

/**
 * The 4-digit phone-change code.
 *
 * Its own component because the design gives it a different treatment entirely
 * (design:843): the display face, 26px, wide tracking, centred — it reads as a
 * code rather than as text. Digits only, capped at four, and always LTR.
 */
export function CodeField({
  value,
  onChangeText,
  accessibilityLabel,
  testID,
}: {
  value: string;
  onChangeText: (value: string) => void;
  accessibilityLabel: string;
  testID?: string;
}) {
  return (
    <TextInput
      value={value}
      // design:1804 — non-digits are stripped as they are typed rather than
      // rejected on submit, so a pasted "1 2 3 4" becomes a valid code.
      onChangeText={(next) => onChangeText(next.replace(/\D/g, '').slice(0, 4))}
      placeholder="0000"
      placeholderTextColor={color.textMutedSoft}
      keyboardType="number-pad"
      autoComplete="one-time-code"
      maxLength={4}
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      style={[styles.input, styles.code]}
    />
  );
}

/**
 * The error banner. design:833 / :881 / :797 — one shape, used by all three
 * sheets, with the dot carrying no meaning on its own: the message is the error.
 *
 * `accessibilityLiveRegion` so a validation failure is announced rather than
 * silently appearing below the fold.
 */
export function InlineError({ message, testID }: { message: string; testID?: string }) {
  const { lang } = useLanguage();
  return (
    <View style={styles.error} accessibilityLiveRegion="polite" accessibilityRole="alert" testID={testID}>
      <View style={styles.errorDot} />
      <Text style={[text('bodyS', lang), styles.errorText]}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  label: { color: MICRO_LABEL_COLOR, marginTop: 16, marginBottom: 8, marginHorizontal: 2 },
  labelHint: { color: color.textMutedSoft, textTransform: 'none', letterSpacing: 0 },
  input: {
    width: '100%',
    minHeight: MIN_TAP_TARGET,
    borderWidth: 1.5,
    borderColor: color.borderControl,
    backgroundColor: color.surface,
    borderRadius: radius.button,
    paddingHorizontal: 15,
    paddingVertical: 13,
    color: color.ink,
  },
  inputMultiline: { minHeight: 96, textAlignVertical: 'top' },
  ltr: { writingDirection: 'ltr', textAlign: 'left' },
  code: {
    fontFamily: 'Fraunces_600SemiBold',
    fontWeight: '600',
    fontSize: 26,
    letterSpacing: 10,
    textAlign: 'center',
    paddingVertical: 16,
    writingDirection: 'ltr',
  },
  error: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    backgroundColor: color.dangerBg,
    borderRadius: radius.chip,
    paddingVertical: 11,
    paddingHorizontal: 14,
    marginTop: 16,
  },
  errorDot: { width: 8, height: 8, borderRadius: radius.pill, backgroundColor: color.dangerDot },
  errorText: { color: color.dangerText, flex: 1, lineHeight: 18 },
});
