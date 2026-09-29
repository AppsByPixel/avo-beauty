/**
 * The native analogue of a CSS custom property: a brand colour that can change
 * while the app is running, and every place that drew it redraws.
 *
 * WHAT WAS WRONG BEFORE THIS FILE
 * ===============================
 * A React Native stylesheet is an object literal evaluated once, when its module
 * is first imported: `StyleSheet.create({ btn: { backgroundColor:
 * color.brandDeep } })` copies the string into `btn` and never looks at `color`
 * again (RN's own `create` is an identity function that freezes each entry in
 * dev; react-native-web compiles each entry to a class at that moment). So the
 * palette could only be set before the first screen was imported — which is
 * what `sealed.ts` enforced and `Boot.tsx` arranged, from a hex cached on a
 * PREVIOUS launch.
 *
 * The hex the app actually learns arrives later: `GET /salons/{id}` needs a
 * principal, so it is read after sign-in, by `useWalletHome`. That read could
 * only be cached "for the next launch". Measured live by trunk on 2026-09-29: a
 * Forest build signed in as Forest's member drew its card in the default
 * `#4EA744` and every accent in the default green, for the whole session.
 *
 * WHAT THIS DOES INSTEAD
 * ======================
 * Exactly what the dashboard gets from the browser for free. On the web,
 * `useBrandTheme` writes five custom properties onto the root and every rule
 * that reads `var(--avo-brand)` re-resolves, without re-mounting anything. Here:
 *
 *   1. `brandedStyles(() => ({ ... }))` is `StyleSheet.create` that REMEMBERS
 *      HOW IT WAS BUILT. The stylesheet body is unchanged — same keys, same
 *      token reads — it is just wrapped in an arrow so it can be evaluated again.
 *      The returned object is stable, so `styles.btn` keeps working everywhere.
 *   2. `repaint()` — called by `./brand` after it writes the five values — re-runs
 *      the few module-level derivations (`onBrandFill`, `BRAND_BORDER`, the web
 *      focus ring) and then every registered builder, refilling each stylesheet
 *      IN PLACE with entries built from the new palette.
 *   3. `useBrandRepaint()`, called once at `App`'s root, re-renders the tree.
 *      `App` creates every screen's element in its own render and nothing in
 *      this app is memoised (no `React.memo`, no `PureComponent` — grepped), so
 *      one state change at the root re-renders every component, and each reads
 *      its now-refilled `styles`.
 *
 * NOT A RE-MOUNT, AND THAT IS THE POINT. A re-mount (a `key` on the root, or an
 * `expo-updates` reload) would throw away what she is doing, and in this app
 * that can be a top-up sitting at the bank — `platform/appReload.native.ts`
 * already rules out a reload that fires on its own for exactly that reason, and
 * `reloadAsync()` does not work in dev at all. A repaint keeps every piece of
 * component state; `theme/brandLiveRender.test.tsx` asserts it.
 *
 * WHY NOT A CONTEXT
 * =================
 * A `useBrand()` hook in every component is the textbook shape. Measured, it
 * would mean moving 34 module-scope stylesheets (118 of their entries read a
 * brand token) into render bodies, plus a hook call in every component in those
 * 34 files that reads `styles` — every screen and most components. That is a
 * rewrite of the app's styling pattern to change five values, with the
 * regression risk that implies, for no behaviour a repaint does not already
 * give. The wrapper is one line per stylesheet, the stylesheet bodies are
 * byte-for-byte what they were, and no component body changed.
 *
 * WHY NOT A RELOAD. `expo-updates`' `reloadAsync()` would re-evaluate every
 * module from the cached hex, but it is unavailable in dev and Expo Go (so the
 * simulator trunk measured on could not show it), and firing it on its own
 * would throw away whatever she has open — `platform/appReload.native.ts`
 * already rules that out for the RTL switch.
 *
 * THE RULE THIS CREATES
 * =====================
 * A stylesheet that reads a white-labelled token (`color.brand`, `brandDeep`,
 * `brandTint`, `onBrandFill`, `BRAND_BORDER`, `brandTextColor`, `cardGradient`)
 * MUST be a `brandedStyles`, or it keeps the colour it was born with and the app
 * is half-rebranded. `./brandedSheets.test.ts` scans every stylesheet in the app
 * and fails on one that is not. Reads inside a render body (`stroke={color.brandDeep}`)
 * need nothing: `color` is the live palette object and the root re-render reaches
 * them.
 */

import { useSyncExternalStore } from 'react';
import { StyleSheet } from 'react-native';

type Sheet = { build: () => object; target: Record<string, unknown> };

const derivations: Array<() => void> = [];
const sheets: Sheet[] = [];
const listeners = new Set<() => void>();
let version = 0;

/**
 * `StyleSheet.create`, re-evaluable. Same type signature as RN's `create`, so a
 * typo in a style key is still caught.
 */
export function brandedStyles<T extends StyleSheet.NamedStyles<T> | StyleSheet.NamedStyles<any>>(
  build: () => T & StyleSheet.NamedStyles<any>,
): T {
  // Our own object, not the one `create` returned: RN freezes entries in dev
  // and react-native-web replaces them, so the stable handle has to be ours.
  const target = { ...StyleSheet.create(build()) } as T;
  sheets.push({ build, target: target as Record<string, unknown> });
  return target;
}

/**
 * A module-level value derived from the palette that is not a stylesheet —
 * `onBrandFill`, `BRAND_BORDER`, the focus ring. Run first on every repaint,
 * because stylesheet builders read them.
 */
export function onRepaint(derive: () => void): void {
  derivations.push(derive);
}

export interface RepaintReport {
  /** Stylesheets rebuilt. */
  sheets: number;
  /** Style entries across them. */
  entries: number;
}

/** Only `./brand` calls this, after it has written the palette. */
export function repaint(): RepaintReport {
  for (const derive of derivations) derive();
  let entries = 0;
  for (const sheet of sheets) {
    const fresh = StyleSheet.create(sheet.build() as StyleSheet.NamedStyles<any>) as Record<string, unknown>;
    Object.assign(sheet.target, fresh);
    entries += Object.keys(fresh).length;
  }
  version += 1;
  for (const listener of listeners) listener();
  return { sheets: sheets.length, entries };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = () => version;

/**
 * Called once, at the top of `App`. Re-renders the whole tree after a repaint.
 * Returns the repaint count, which nothing needs but a test can read.
 */
export function useBrandRepaint(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
