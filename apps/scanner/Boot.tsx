/**
 * The root component: the cached salon identity, applied before the first frame.
 *
 * WHAT IT IS FOR
 * ==============
 * A salon's hex reaches the palette two ways. Live, from the salon read after
 * each staff sign-in (`ScannerFlow` → `config/brand.ts#adoptSalonIdentity` →
 * `src/theme/live.ts`, which rebuilds every brand stylesheet in place). And
 * here, from the identity cached by a previous sign-in — the only way the PIN
 * screen, which is BEFORE any principal, can be in the salon's colour at all.
 *
 * So the entry point is this, and `App` is reached through a DYNAMIC import that
 * is not started until the cached hex has been applied: every stylesheet is
 * built once, from the right palette, and the first frame is right.
 *
 * This used to be load-bearing for white-labelling itself — the palette was
 * sealed by the first stylesheet, so a static import here that reached the theme
 * would have un-branded the app for good. Since `src/theme/live.ts` a late hex
 * repaints, so what the ordering protects now is the first frame, and
 * `src/theme/brandBootOrder.test.ts` still holds it.
 *
 * The salon NAME is adopted here too, for the same first-frame reason:
 * `config/brand.ts` reads it at render time, so it could be adopted at any point.
 *
 * A DEVICE THAT HAS NEVER SIGNED IN has nothing cached, so its PIN screen shows
 * the build fallback name and the token file's default palette; the first
 * sign-in's salon read repaints it.
 *
 * WHAT RENDERS IN BETWEEN
 * =======================
 * A canvas-coloured blank — the same one `App` shows while fonts load and while
 * the device binding is read, and for the same stated reason: "Reading one key out
 * of AsyncStorage. A spinner here would flash."
 *
 * THE IMPORT LIST BELOW DECIDES THE FIRST FRAME
 * ==============================================
 * Every static import here is evaluated before the cached hex is applied. One
 * that transitively reaches `src/theme/index.ts` builds stylesheets in the
 * default palette first, which is why the blank's colour is read straight off
 * `@avo/tokens/native` and why `src/theme/brandBootOrder.test.ts` asserts the
 * entry's static import graph cannot reach the theme.
 */

import { useEffect, useState } from 'react';
import type { ComponentType } from 'react';
import { StyleSheet, View } from 'react-native';
import { theme } from '@avo/tokens/native';
import { applyBrandColor } from './src/theme/brand';
import { adoptSalonName } from './src/config/brand';
import { readDeviceBinding } from './src/state/device';
import { readSalonIdentity } from './src/state/salonIdentity';

export default function Boot() {
  const [App, setApp] = useState<ComponentType | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      /*
        The binding is what makes this pre-auth read legitimate: the device knows
        its salon id from enrolment, so the cached identity can be checked against
        it and a record belonging to a different salon is discarded rather than
        shown. A device that has never signed in successfully has nothing cached,
        so the build fallback name and the default palette stand until its first
        sign-in reads the salon (ScannerFlow), which applies both live.
      */
      const binding = await readDeviceBinding();
      const identity = await readSalonIdentity(binding?.salonId);
      adoptSalonName(identity?.name);
      applyBrandColor(identity?.brandColor);

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
