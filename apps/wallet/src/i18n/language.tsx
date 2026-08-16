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
 * This module deliberately does NOT depend on `react-native-restart`: the wallet
 * ships web first, and pulling a native-only restart module into the tree for a
 * surface that does not need it would break the web build for a feature that
 * cannot be exercised there yet. When the native build lands, `pendingRestart`
 * is the flag the restart prompt reads.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { I18nManager, Platform } from 'react-native';
import type { Language } from '@avo/types';
import type { Copy } from '../copy/types';
import { en } from '../copy/en';
import { ar } from '../copy/ar';

const COPY: Record<Language, Copy> = { en, ar };

/** Arabic is the only RTL language the product ships. */
export function isRtl(lang: Language): boolean {
  return lang === 'ar';
}

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

  const setLang = useCallback((next: Language) => {
    setLangState(next);

    if (Platform.OS === 'web') {
      // Live. `applyWebDirection` runs in the effect above on the same commit.
      setPendingRestart(false);
      return;
    }

    // Native. allowRTL must be on before forceRTL means anything.
    const wantRtl = isRtl(next);
    I18nManager.allowRTL(true);
    if (I18nManager.isRTL !== wantRtl) {
      I18nManager.forceRTL(wantRtl);
      // The flag is written; Yoga will not read it until the next launch.
      setPendingRestart(true);
    } else {
      setPendingRestart(false);
    }
  }, []);

  const value = useMemo<LanguageState>(
    () => ({ lang, copy: COPY[lang], rtl: isRtl(lang), setLang, pendingRestart }),
    [lang, setLang, pendingRestart],
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
