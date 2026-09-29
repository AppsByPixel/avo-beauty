/**
 * A brand colour that can change while the till is running — the scanner's copy
 * of `apps/wallet/src/theme/live.ts`, same mechanism, same reasons. Read that
 * header for the whole argument; the short version:
 *
 * A React Native stylesheet copies its colours once, when its module is
 * evaluated, so the palette used to be sealed from the first import on. The
 * scanner learns its salon's hex from `GET /salons/{id}` after a staff sign-in
 * (`ScannerFlow` → `api/salon.ts`), which is long after every screen was
 * imported — so the hex could only be cached for the NEXT launch, and a till's
 * whole first session after enrolment ran in the default green.
 *
 * Now, as on the web: `./brand` writes the five values, then `repaint()` re-runs
 * the module-level derivations (`onRepaint`: `onBrandFill`, `BRAND_BORDER`,
 * `FOCUS_RING_LIGHT`, the Bookings source pill), then rebuilds every
 * `brandedStyles` sheet in place (`onRepaintSheet`, from `./branded`), then
 * re-renders from `App`'s root (`useBrandRepaint`). No re-mount, so a charge in
 * progress keeps its state.
 *
 * WHY THIS FILE DOES NOT IMPORT `react-native` AND `./branded` DOES. The
 * scanner's tests run in plain node with no react-native-web alias, and
 * `./index` imports this file — so a `StyleSheet` import here would make every
 * test that reads the theme try to parse React Native's Flow source. The sheet
 * half lives next door, where only screens reach it.
 */

import { useSyncExternalStore } from 'react';

const derivations: Array<() => void> = [];
const sheets: Array<() => void> = [];
const listeners = new Set<() => void>();
let version = 0;

/**
 * A module-level value derived from the palette that is not a stylesheet. Run
 * first on every repaint, because stylesheet builders read them.
 */
export function onRepaint(derive: () => void): void {
  derivations.push(derive);
}

/** For `./branded` only: rebuild one stylesheet. Run after every derivation. */
export function onRepaintSheet(rebuild: () => void): void {
  sheets.push(rebuild);
}

/** Only `./brand` calls this, after it has written the palette. */
export function repaint(): { sheets: number } {
  for (const derive of derivations) derive();
  for (const rebuild of sheets) rebuild();
  version += 1;
  for (const listener of listeners) listener();
  return { sheets: sheets.length };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = () => version;

/** Called once, at the top of `App`. Re-renders the whole tree after a repaint. */
export function useBrandRepaint(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
