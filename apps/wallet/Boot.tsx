/**
 * The root component, and the only thing that runs before the palette is fixed.
 *
 * WHAT IT IS FOR
 * ==============
 * `src/theme/brand.ts` can only apply a salon's hex before the first module that
 * reads a brand token is evaluated (`src/theme/sealed.ts` says why). `App.tsx`
 * statically imports seven screens, every one of which builds its stylesheets at
 * module scope, so by the time `App()` is first called the palette is already
 * baked. A hook inside App — the shape `useBrandTheme` takes on the web — is
 * therefore structurally unable to work here.
 *
 * So the entry point is this, and `App` is reached through a DYNAMIC import that
 * is not started until the hex has been resolved and applied. That is the whole
 * job. Nothing else belongs in this file.
 *
 * WHAT RENDERS IN BETWEEN, AND WHY IT IS NOT A SPINNER
 * ===================================================
 * A canvas-coloured blank, the same one `App` shows while fonts load and while
 * the session is being restored. The wait is one AsyncStorage read — a couple of
 * milliseconds — and interaction-spec.md §4's loading rules are about waits a
 * customer can perceive. A spinner here would flash.
 *
 * It is emphatically NOT the wallet in default sage followed by a correction. A
 * wrong-brand flash is worse than a neutral moment: it reads as a bug at the very
 * first frame a customer ever sees, and on the sealing rule above the correction
 * could only ever be partial anyway.
 *
 * THE IMPORT LIST BELOW IS LOAD-BEARING
 * =====================================
 * Every static import here is evaluated before `resolve()` runs. Adding one that
 * transitively reaches `src/theme/index.ts` — any screen, any component, the
 * theme itself — silently disables white-labelling for the whole app. That is why
 * the blank's colour is read straight off `@avo/tokens/native` rather than from
 * `src/theme`, and why `src/theme/brandBootOrder.test.ts` asserts the entry's
 * static import graph cannot reach the theme.
 */

import { useEffect, useState } from 'react';
import type { ComponentType } from 'react';
import { StyleSheet, View } from 'react-native';
import { theme } from '@avo/tokens/native';
import { applyBrandColor } from './src/theme/brand';
import { readCachedBrandColor } from './src/state/brandCache';
import { cacheLanguage, readStoredLanguage } from './src/i18n/languagePreference';

export default function Boot() {
  const [App, setApp] = useState<ComponentType | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      /*
        The hex comes from the device, not the network. `GET /salons/{id}` needs a
        principal, so on a first-ever launch there is nothing cached and the
        default palette stands for that one session — the same fail-safe as a
        refused hex. `useWalletHome` writes the hex on the first successful salon
        read and every one after, so it is in place from the second launch on.

        REPORTED, NOT WORKED AROUND: closing that first launch needs an
        unauthenticated salon-identity read (name, brand hex, logo). There is
        precedent for exactly that shape — `/v1/platform/policies` is
        "unauthenticated by necessity (a signup screen renders it before there is
        a session)" — and the staff scanner's PIN screen needs the same endpoint
        for the same reason. One endpoint, two surfaces. Lane A's call.
      */
      const hex = await readCachedBrandColor();
      applyBrandColor(hex);

      /*
        The remembered language, resolved here for the same reason the hex is:
        `LanguageProvider` takes it as a plain prop, so it has to be readable
        synchronously by the time `App` renders. Reading it in an effect instead
        would show a frame of English to an Arabic customer on every launch —
        and on native the reload that finishes an RTL switch IS a launch, so that
        frame would land on exactly the customer who just asked for Arabic.

        `languagePreference` imports AsyncStorage and nothing else, so it does
        not reach `src/theme` and the sealing order above is unaffected —
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
  // `canvas`, not a brand token: reading a brand token here would seal the
  // palette in the one file that must not.
  blank: { flex: 1, backgroundColor: theme.color.canvas },
});
