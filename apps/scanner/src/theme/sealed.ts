/**
 * The moment the palette stops being changeable. Same rule as the wallet's
 * `src/theme/sealed.ts`, same reason, different theme object.
 *
 * React Native has no `document.documentElement`. A
 * `StyleSheet.create({ x: { backgroundColor: color.brandDeep } })` reads the
 * string ONCE, when its module is first evaluated, and keeps the copy forever —
 * and this file's neighbour `./index` reads `color.brandDeep` and `color.brand`
 * at module scope for `onBrandFill` and `FOCUS_RING_LIGHT`. So `./index` is the
 * first consumer of the palette by construction, and a brand hex applied after
 * it would theme only the modules not yet evaluated: two brands on screen at
 * once.
 *
 * Half-themed is worse than not themed, so `./brand` refuses after the seal and
 * says so loudly rather than doing it anyway. `brandBootOrder.test.ts` asserts
 * the entry point's static import graph cannot reach `./index`, so the way this
 * actually breaks — somebody adding an innocent eager import to `index.ts` or
 * `Boot.tsx` — fails a named test instead of quietly un-branding the app.
 */

let sealed = false;

/** Called by `src/theme/index.ts` at module scope. Not for anyone else. */
export function seal(): void {
  sealed = true;
}

export function paletteIsSealed(): boolean {
  return sealed;
}
