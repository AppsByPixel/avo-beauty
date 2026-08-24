/**
 * The root component, and the only thing that runs before the palette is fixed.
 *
 * WHAT IT IS FOR
 * ==============
 * `src/theme/brand.ts` can only apply a salon's hex before the first module that
 * reads a brand token is evaluated (`src/theme/sealed.ts` says why). `App.tsx`
 * statically imports the three shells and `src/theme` itself, and every screen
 * builds its stylesheets at module scope — so by the time `App()` is first called
 * the palette is already baked. A hook inside App, the shape `useBrandTheme`
 * takes on the web, is structurally unable to work here.
 *
 * So the entry point is this, and `App` is reached through a DYNAMIC import that
 * is not started until the hex has been resolved and applied.
 *
 * The salon NAME is adopted here too, but for convenience rather than necessity:
 * `config/brand.ts` reads it at render time, so it could be adopted at any point.
 * Doing it here means the PIN screen's first frame already carries the real name
 * instead of the build fallback.
 *
 * WHAT RENDERS IN BETWEEN
 * =======================
 * A canvas-coloured blank — the same one `App` shows while fonts load and while
 * the device binding is read, and for the same stated reason: "Reading one key out
 * of AsyncStorage. A spinner here would flash."
 *
 * THE IMPORT LIST BELOW IS LOAD-BEARING
 * =====================================
 * Every static import here is evaluated before `resolve()` runs. Adding one that
 * transitively reaches `src/theme/index.ts` silently disables white-labelling for
 * the whole app, which is why the blank's colour is read straight off
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
        so the build fallback name and the default palette stand for that session.
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
  // `canvas`, not a brand token: reading a brand token here would seal the
  // palette in the one file that must not.
  blank: { flex: 1, backgroundColor: theme.color.canvas },
});
