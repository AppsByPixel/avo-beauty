/**
 * The language switch, and the two genuinely different things it has to do.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WEB (the pilot target) — direction changes live, no reload.
 *
 *   `document.documentElement.dir = 'rtl'` re-lays the whole page out on the
 *   next frame. CSS flexbox follows the inline direction, so every
 *   `flexDirection: 'row'` react-native-web emits flips for free, and logical
 *   properties (marginStart/paddingStart) resolve the other way round. This is
 *   what the design prototype does — AVO Wallet Home.dc.html:1078-1080 sets
 *   `el.style.direction` and `el.dir` on a language toggle and nothing else.
 *
 * NATIVE (iOS / Android) — direction changes only after an app restart.
 *
 *   `I18nManager.forceRTL()` writes a native flag that Yoga reads when the
 *   bridge starts. Calling it does not re-lay out the running app: the next
 *   render still measures left-to-right and the screen looks unchanged. This is
 *   not a React Native bug, it is the documented behaviour, and it is why AVO's
 *   own live RTL app in this market (AvoMobileApps-Lean) carries
 *   `react-native-restart` as a dependency purely to follow `forceRTL`.
 *
 * SO THE SWITCH BEHAVES DIFFERENTLY ON THE TWO TARGETS, AND SAYING SO IS THE
 * DESIGN DECISION HERE.
 *
 *   web     → tap, the layout mirrors immediately, done.
 *   native  → tap, the copy changes immediately, and a line appears telling her
 *             the app has to restart to finish turning around.
 *
 * The alternative — restarting the app under her without warning — loses
 * whatever she was doing, and in this app "whatever she was doing" can be a live
 * payment at the bank. The alternative to *that* — saying nothing — is a button
 * that appears to do nothing, which is the failure mode the lane brief called
 * out. A visible, honest notice is the only option that is not a defect.
 *
 * THE NATIVE BUILD HAS LANDED, SO THE RESTART IS WIRED — AND THE TRIGGER THIS
 * PARAGRAPH NAMED IS WHAT FIRED IT. It used to read: "This module deliberately
 * does NOT depend on `react-native-restart`: the wallet ships web first … When
 * the native build lands, `pendingRestart` is the flag the restart prompt
 * reads." That is exactly what happened, and `pendingRestart` is exactly the
 * flag it reads.
 *
 * The dependency is `expo-updates`, NOT `react-native-restart`, and the
 * difference is not preference: `react-native-restart` is a bare native module
 * absent from the Expo Go binary, so adding it would break the Expo Go workflow
 * the app is developed and driven under. `expo-updates` is Expo-managed and
 * works in Expo Go and EAS builds alike. It is reached through
 * `platform/appReload.native.ts`, so the web bundle never sees it — the concern
 * the old paragraph raised was right and the platform split is what answers it.
 *
 * WHAT DID NOT CHANGE: she taps it. The reload is a control, never a timer and
 * never automatic. Restarting under her loses whatever she was doing, and in
 * this app that can be a live payment at the bank.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { I18nManager, Platform } from 'react-native';
import type { Language } from '@avo/types';
import type { Copy } from '../copy/types';
import { en } from '../copy/en';
import { ar } from '../copy/ar';
import { directionOutcome, isRtl } from './direction';
import { storeLanguage } from './languagePreference';
import { reloadApp } from '../platform/appReload';

const COPY: Record<Language, Copy> = { en, ar };

/**
 * Re-exported so the many call sites that already read it from here keep
 * working. It is DEFINED in `./direction`, beside the rest of the direction
 * rule — see that module for why the dependency points that way.
 */
export { isRtl };

export interface LanguageState {
  lang: Language;
  copy: Copy;
  rtl: boolean;
  setLang: (lang: Language) => void;
  /**
   * Native only, and only after a switch that changed the direction: the copy is
   * already Arabic but the layout is still mirrored the old way until the app
   * restarts. Always false on web, where the swap is immediate.
   */
  pendingRestart: boolean;
  /**
   * Finish the turn-around by reloading the app. Only meaningful while
   * `pendingRestart` is true, and only ever called from a control the customer
   * taps — see `LanguageToggle` and `platform/appReload.native.ts`.
   */
  applyDirection: () => void;
}

const LanguageContext = createContext<LanguageState | null>(null);

/**
 * Applies the direction to the document. Web only — on native this is a no-op
 * and `forceRTL` below does the work instead.
 */
function applyWebDirection(lang: Language): void {
  if (Platform.OS !== 'web') return;
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dir = isRtl(lang) ? 'rtl' : 'ltr';
  root.lang = lang;
  // react-native-web writes styles onto <body>; setting `direction` there too
  // means a style that reads `direction: inherit` resolves the same way the
  // document does, rather than falling back to the UA default.
  if (document.body) document.body.style.direction = isRtl(lang) ? 'rtl' : 'ltr';
}

export function LanguageProvider({
  initial = 'en',
  children,
}: {
  initial?: Language;
  children: React.ReactNode;
}) {
  const [lang, setLangState] = useState<Language>(initial);
  const [pendingRestart, setPendingRestart] = useState(false);

  // Runs on mount as well as on change, so the very first paint already carries
  // the right direction rather than flipping one frame later.
  useEffect(() => {
    applyWebDirection(lang);
  }, [lang]);

  /**
   * RECONCILE THE REMEMBERED LANGUAGE WITH THE DIRECTION ACTUALLY IN FORCE.
   *
   * `initialLanguage()` can now open the app in Arabic (see
   * `languagePreference.ts`) without `setLang` ever being called — so nothing
   * had compared the stored choice against `I18nManager.isRTL`, and a launch
   * whose flag disagreed rendered Arabic copy on an LTR layout with NOTHING
   * saying so. Driven: exactly that, on a fresh launch under Expo Go, which
   * clears the flag every time.
   *
   * In a standalone build the flag persists and this is a no-op on almost every
   * launch. It matters when the two can disagree at all — a fresh install whose
   * preference survived a reinstall, a reload that did not complete, or a host
   * that resets the flag — and in every one of those the honest thing is the
   * same notice the switch itself raises, not silence.
   */
  useEffect(() => {
    const outcome = directionOutcome({
      platform: Platform.OS,
      currentIsRtl: I18nManager.isRTL,
      next: lang,
    });
    if (outcome === 'restart-required') {
      I18nManager.allowRTL(true);
      I18nManager.forceRTL(isRtl(lang));
      setPendingRestart(true);
    }
    // Deliberately not an `else`: a switch made during this session already set
    // the flag, and clearing `pendingRestart` here would erase its notice on the
    // very next render.
  }, [lang]);

  const setLang = useCallback((next: Language) => {
    setLangState(next);
    /*
      Remembered before anything else, because on native the very next thing she
      may do is reload the app — and a reload that came back in English would
      throw the switch away. Driven: it did, until this line existed.
      Fire-and-forget: `storeLanguage` never throws, and a failed write costs the
      memory of the choice, not the choice.
    */
    void storeLanguage(next);

    // The three-way decision lives in `./direction` so the web guard is testable
    // — this workspace has no renderer, and "web never asks for a restart" is a
    // guard rather than a preference.
    const outcome = directionOutcome({
      platform: Platform.OS,
      currentIsRtl: I18nManager.isRTL,
      next,
    });

    if (outcome === 'restart-required') {
      // allowRTL must be on before forceRTL means anything.
      I18nManager.allowRTL(true);
      I18nManager.forceRTL(isRtl(next));
      // The flag is written; Yoga will not read it until the next launch.
      setPendingRestart(true);
      return;
    }
    // 'live' (web, already re-laid out by the effect above) and 'unchanged'
    // (native, already facing the right way) both leave nothing pending.
    setPendingRestart(false);
  }, []);

  /**
   * Reload, so Yoga re-reads the flag `forceRTL` wrote.
   *
   * Guarded on `pendingRestart` rather than on the platform: web never sets it,
   * so web can never get here, and `platform/appReload.ts` THROWS rather than
   * no-ops if it somehow does — a caller that reaches it on web has a broken
   * guard, and a silent no-op would hide that.
   */
  const applyDirection = useCallback(() => {
    if (!pendingRestart) return;
    void reloadApp();
  }, [pendingRestart]);

  const value = useMemo<LanguageState>(
    () => ({ lang, copy: COPY[lang], rtl: isRtl(lang), setLang, pendingRestart, applyDirection }),
    [lang, setLang, pendingRestart, applyDirection],
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): LanguageState {
  const value = useContext(LanguageContext);
  if (!value) throw new Error('useLanguage must be used inside <LanguageProvider>.');
  return value;
}

/** The common case: a component that only needs the strings. */
export function useCopy(): Copy {
  return useLanguage().copy;
}
