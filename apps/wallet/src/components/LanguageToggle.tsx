/**
 * The EN ⇄ العربية control, and the honest notice that goes with it on native.
 *
 * design/AVO Wallet Home.dc.html:1232 and :1339 — the switch is labelled with
 * the language it goes TO, not the one you are in: an English wallet shows
 * "العربية", an Arabic wallet shows "EN". That is why `langSwitch` is a copy key
 * rather than a computed label.
 *
 * Sits in Account → Language in the finished product; it is surfaced in the home
 * header here because Account is not built yet and a switch nobody can reach
 * cannot be reviewed. Moving it later is a one-line change.
 *
 * ON NATIVE THE BUTTON DOES NOT FINISH THE JOB, AND IT SAYS SO. See
 * i18n/language.tsx for why `I18nManager.forceRTL` needs a restart. The notice
 * only appears when the direction actually changed and only on native, so the
 * web build — the pilot target — shows nothing extra.
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { color, CONTROL_BORDER, MIN_TAP_TARGET, radius, text } from '../theme';
import { useLanguage } from '../i18n/language';

export function LanguageToggle() {
  const { lang, copy, setLang, pendingRestart } = useLanguage();
  const next = lang === 'en' ? 'ar' : 'en';

  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={() => setLang(next)}
        accessibilityRole="button"
        // The label is the target language's own name, so a screen reader in
        // either language announces something the user recognises.
        accessibilityLabel={copy.langSwitch}
        testID="language-toggle"
        style={styles.button}
      >
        {/*
          Always the Arabic face when the label is Arabic, regardless of the
          language currently in force — "العربية" inside an English build still
          needs glyphs Inter does not have.
        */}
        <Text style={[text('bodyS', next), styles.label]}>{copy.langSwitch}</Text>
      </Pressable>
      {pendingRestart ? (
        <Text
          style={[text('bodyS', lang), styles.restart]}
          accessibilityLiveRegion="polite"
          testID="language-restart-notice"
        >
          {copy.restartNeeded}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'flex-end', gap: 4 },
  button: {
    minHeight: MIN_TAP_TARGET,
    minWidth: MIN_TAP_TARGET,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: CONTROL_BORDER,
    backgroundColor: color.surface,
  },
  // Brand text on a light surface is brandDeep, never brand.
  label: { color: color.brandDeep, fontWeight: '600' },
  restart: { color: color.warnText, maxWidth: 150, textAlign: 'center' },
});
