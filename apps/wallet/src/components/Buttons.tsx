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
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE LANGUAGE COMES FROM `useLanguage()`, NOT FROM A PROP. GAP CLOSED.
 *
 * This docblock used to carry the gap rather than the fix. The two labels read
 * `text('bodyL', 'en', '600')`, and the `'en'` was a statement of what was
 * already happening, not a choice: the calls had been `text('bodyL')`, this
 * component took no `lang` and never read `useLanguage()`, so every Arabic
 * button label in the app asked for an Inter face for Arabic text. Every label
 * here is product copy, in both languages. That is non-negotiable #12 on the
 * most-tapped text in the app.
 *
 * WHAT THE MISSING FACE ACTUALLY DID, MEASURED RATHER THAN ASSUMED. Not tofu.
 * `Inter_600SemiBold.ttf` carries 2849 codepoints and exactly one of them is in
 * an Arabic block (U+FEFF, a zero-width mark), so it can draw none of
 * "العودة للرئيسية". react-native-web emits the family as a bare
 * `font-family: Inter_600SemiBold` with NO fallback list — verified by rendering
 * this component and reading the inline style — so the browser's own
 * per-character fallback is the only thing standing between the customer and a
 * blank button. It does step in: driven in Chrome against the real ttf, the
 * Arabic label rendered at exactly the same width (58.94px) as the same string
 * asking for a family that does not exist at all, and at a different width from
 * IBM Plex Sans Arabic (54.90px). Identical-to-nonexistent is the signature of a
 * silent system substitution.
 *
 * SO THE SYMPTOM IS "LEGIBLE, AND NOT THE DESIGN'S TYPE" RATHER THAN "BROKEN",
 * AND THAT IS WHY IT SURVIVED THIS LONG. What the customer got was the OS's
 * default Arabic face at a browser-synthesised bold, in place of the
 * `IBMPlexSansArabic_600SemiBold` the app loads at startup and never asked for.
 * Two things stop that being merely cosmetic. The substitution is the platform's
 * choice and not ours, so it differs per device and can be absent — an Android
 * build with no system Arabic face has nothing to fall back TO. And it is not
 * always benign: `QrOverlay` hit the same bug on a salon initial and the
 * substituted glyph for أ read as a "1".
 *
 * `document.fonts.check('600 17px Inter_600SemiBold', 'العودة للرئيسية')`
 * returns TRUE, which is worth knowing before anyone reaches for it as a guard.
 * It reports that a matching font is loaded, not that it covers the string.
 *
 * THE HOOK, NOT A PROP. A `lang` prop would be explicit, and there are twenty
 * call sites in fourteen files that would every one of them pass the same value
 * — the one they already hold, because they take their label from `copy.*`. A
 * prop whose only correct argument is the reading language is a prop that adds a
 * way to be wrong and no way to be right differently. A button label is by
 * definition in the language being read. `useLanguage()` is what the rest of the
 * app does, and reading it here means a new call site cannot forget.
 *
 * IT IS SAFE TO HOOK BECAUSE THE PROVIDER IS THE ROOT. `App.tsx` wraps `<Gate />`
 * — everything the app renders after the fonts load — in `<LanguageProvider>`,
 * and all twenty call sites live under it. `useLanguage()` throws outside a
 * provider rather than defaulting, which is the behaviour we want: a Button
 * mounted outside one is a bug and now says so at the point it happens instead
 * of quietly drawing English type. Every render test that reaches a Button
 * already wraps in `LanguageProvider`, for the same reason — the components
 * around it need `copy`.
 *
 * `theme/typeFidelity.test.ts` § the language-less-`text()` sweep now holds this
 * line for the whole app, so it cannot come back here or anywhere else.
 */

import { Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';
import { color, MIN_TAP_TARGET, onBrandFill, radius, text } from '../theme';
import { focusable } from '../theme/focus';
import { useLanguage } from '../i18n/language';

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
  const { lang } = useLanguage();
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
      <Text style={[text('bodyL', lang, '600'), styles.primaryText, disabled && styles.disabledText]}>
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
  const { lang } = useLanguage();
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
      <Text style={[text('bodyL', lang, '600'), styles.secondaryText]}>{label}</Text>
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
  primaryText: { color: onBrandFill.color },
  secondary: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: color.borderControl,
    paddingVertical: 15,
  },
  secondaryText: { color: color.brandDeep },
  disabled: { backgroundColor: color.disabledBg },
  disabledText: { color: color.textMutedSoft },
});
