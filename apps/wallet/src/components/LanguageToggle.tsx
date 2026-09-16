/**
 * The EN ⇄ العربية control, and the honest notice that goes with it on native.
 *
 * design/AVO Wallet Home.dc.html:1232 and :1339 — the switch is labelled with
 * the language it goes TO, not the one you are in: an English wallet shows
 * "العربية", an Arabic wallet shows "EN". That is why `langSwitch` is a copy key
 * rather than a computed label.
 *
 * THE HEADER IS WHERE THE DESIGN PUTS IT. This comment used to read "Sits in
 * Account → Language in the finished product; it is surfaced in the home header
 * here because Account is not built yet … Moving it later is a one-line change."
 * Both halves were wrong by the time anyone could act on them, and acting on them
 * would have been a REGRESSION rather than tidying:
 *
 *   - `AVO Wallet Home.dc.html` renders `t.langSwitch` in the header on TWO
 *     screens, beside `goAccount` on Home and `openCart` on Shop. The header is
 *     the design, not a stopgap.
 *   - Account is built, and it has the Language row too (`AccountScreen.tsx`,
 *     `testID="row-language"`, `copy.rowLang`). The design carries both controls;
 *     they are not duplicates of each other by accident.
 *
 * So there is nothing to move. Recorded at length because the stale version
 * invited a specific wrong edit — deleting this component — and a reader who
 * trusted it would have removed a control the design draws.
 *
 * ON NATIVE THE BUTTON DOES NOT FINISH THE JOB, AND NOW THERE IS A SECOND
 * BUTTON THAT DOES. See i18n/language.tsx for why `I18nManager.forceRTL` needs a
 * reload before Yoga turns the layout around.
 *
 * This used to be a `Text` notice — honest, and inert. Driven on an iPhone 17
 * Pro simulator: switching to Arabic gave Arabic copy on an LTR layout, the dot
 * still left of the banner, the QR left of its label, the tab bar unmirrored,
 * and a line of text telling her to restart an app she has no way to restart.
 * It is now a `Pressable` that performs the reload.
 *
 * IT IS STILL HER TAP. Nothing reloads on a timer and nothing reloads on the
 * language change itself, because restarting under her loses whatever she was
 * doing and in this app that can be a live payment at the bank. The whole point
 * of the original notice was to be honest about a two-step operation; making it
 * tappable completes the second step without taking the choice away.
 *
 * The label is `restartNeeded`, unchanged — "Restart the app to switch
 * direction", which reads as an instruction and is now a control that carries
 * it out. No new copy string, so no new `AR_GAPS` entry: `restartNeeded` is
 * already listed there and stays English until the native-speaker review.
 *
 * Both only appear when the direction actually changed and only on native, so
 * the web build shows nothing extra.
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { color, CONTROL_BORDER, MIN_TAP_TARGET, radius, text } from '../theme';
import { useLanguage } from '../i18n/language';

export function LanguageToggle() {
  const { lang, copy, setLang, pendingRestart, applyDirection } = useLanguage();
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
        <Text style={[text('bodyS', next, '600'), styles.label]}>{copy.langSwitch}</Text>
      </Pressable>
      {pendingRestart ? (
        <Pressable
          onPress={applyDirection}
          accessibilityRole="button"
          accessibilityLabel={copy.restartNeeded}
          // Announced when it appears, because it is the half of the switch that
          // has not happened yet and a screen-reader user has no visual cue that
          // a second control just arrived.
          accessibilityLiveRegion="polite"
          testID="language-restart-notice"
          style={styles.restartButton}
        >
          <Text style={[text('bodyS', lang, '600'), styles.restart]}>{copy.restartNeeded}</Text>
        </Pressable>
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
  label: { color: color.brandDeep },
  // A control now, so it carries the tap-target floor and reads as one. The
  // warn palette is kept: this is still an unfinished state, not a suggestion.
  restartButton: {
    minHeight: MIN_TAP_TARGET,
    maxWidth: 150,
    paddingHorizontal: 10,
    paddingVertical: 6,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.chip,
    borderWidth: 1,
    borderColor: color.warnText,
    backgroundColor: color.warnBg,
  },
  restart: { color: color.warnText, textAlign: 'center' },
});
