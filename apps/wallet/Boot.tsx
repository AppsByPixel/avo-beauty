/**
 * The root component: the cached brand, applied before the first frame.
 *
 * WHAT IT IS FOR
 * ==============
 * A salon's hex reaches the palette two ways. Live, from the salon read after
 * sign-in (`useWalletHome` → `src/theme/brand.ts` → `src/theme/live.ts`, which
 * rebuilds every brand stylesheet in place). And here, from the hex that read
 * cached on a previous launch — which is the only way the screens BEFORE a
 * session (sign-in, create account, forgot password) can be in the salon's
 * colour at all, and the way a returning phone's first frame is right instead
 * of default-then-corrected.
 *
 * So the entry point is this, and `App` is reached through a DYNAMIC import that
 * is not started until the cached hex has been applied. That keeps every
 * stylesheet built once, from the right palette, rather than built in the
 * default and immediately rebuilt. Nothing else belongs in this file.
 *
 * It used to be load-bearing for white-labelling itself: the palette was sealed
 * once the first stylesheet was evaluated, so a static import here that reached
 * the theme would have silently disabled every salon's brand. It is not any
 * more — a late hex repaints — but the ordering still decides whether the first
 * frame is right, so `src/theme/brandBootOrder.test.ts` still holds it.
 *
 * WHAT RENDERS IN BETWEEN, AND WHY IT IS NOT A SPINNER
 * ===================================================
 * A canvas-coloured blank, the same one `App` shows while fonts load and while
 * the session is being restored. The wait is one AsyncStorage read — a couple of
 * milliseconds — and interaction-spec.md §4's loading rules are about waits a
 * customer can perceive. A spinner here would flash.
 *
 * It is emphatically NOT the wallet in the default green followed by a
 * correction. A wrong-brand flash is worse than a neutral moment: it reads as a
 * bug at the very first frame a customer ever sees.
 *
 * ON A TRULY FRESH INSTALL there is nothing cached, so sign-in and sign-up are
 * drawn in the token file's default palette. That is the one state with no
 * honest alternative: `GET /salons/{id}` needs a principal, and the build carries
 * the salon's id, not its colour. The moment she signs in, Home's salon read
 * applies the salon's hex live and the whole app repaints.
 */

import { useEffect, useState } from 'react';
import type { ComponentType } from 'react';
import { StyleSheet, View } from 'react-native';
import { theme } from '@avo/tokens/native';
import { applyBrandColor } from './src/theme/brand';
import { readCachedBrandColor } from './src/state/brandCache';
import { readLastWorkspace } from './src/state/lastWorkspace';
import { cacheLanguage, readStoredLanguage } from './src/i18n/languagePreference';

export default function Boot() {
  const [App, setApp] = useState<ComponentType | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      /*
        The hex comes from the device, not the network. `GET /salons/{id}` needs a
        principal, so on a first-ever launch there is nothing cached and the
        default palette stands UNTIL SIGN-IN — the first salon read applies the
        hex live (`useWalletHome`) and caches it, so from the second launch on it
        is here before the first frame.

        REPORTED, NOT WORKED AROUND: putting the salon's colour on a fresh
        install's sign-in screen needs an
        unauthenticated salon-identity read (name, brand hex, logo). There is
        precedent for exactly that shape — `/v1/platform/policies` is
        "unauthenticated by necessity (a signup screen renders it before there is
        a session)" — and the staff scanner's PIN screen needs the same endpoint
        for the same reason. One endpoint, two surfaces. Lane A's call.
      */
      /*
        THE LAST WORKSPACE FIRST. One app serves every workspace now, so the
        sign-in screen is painted and titled for the salon she was last in
        (`state/lastWorkspace.ts`), which also holds it in memory for that
        screen's first render. A device from before that record existed has
        only the bare hex, which is the same salon's.
      */
      const last = await readLastWorkspace();
      const hex = last?.brandColor ?? (await readCachedBrandColor());
      applyBrandColor(hex);

      /*
        The remembered language, resolved here for the same reason the hex is:
        `LanguageProvider` takes it as a plain prop, so it has to be readable
        synchronously by the time `App` renders. Reading it in an effect instead
        would show a frame of English to an Arabic customer on every launch —
        and on native the reload that finishes an RTL switch IS a launch, so that
        frame would land on exactly the customer who just asked for Arabic.

        `languagePreference` imports AsyncStorage and nothing else, so it does
        not reach `src/theme` and the first-frame order above is unaffected —
        `theme/brandBootOrder.test.ts` asserts that and would fail if it did.
      */
      cacheLanguage(await readStoredLanguage());

      // Only now. This import is what evaluates every stylesheet in the app.
      const mod = await import('./App');
      if (alive) setApp(() => mod.default);
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (!App) return <View style={styles.blank} />;
  return <App />;
}

const styles = StyleSheet.create({
  // `canvas`, not a brand token: the blank is drawn before the brand is known.
  blank: { flex: 1, backgroundColor: theme.color.canvas },
});
