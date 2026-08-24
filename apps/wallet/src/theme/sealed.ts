/**
 * The moment the palette stops being changeable.
 *
 * React Native has no `document.documentElement`, and that is the whole reason
 * this file exists. On the web a salon's hex can be written onto the root at any
 * time and every rule that reads `var(--avo-brand)` re-resolves; here a
 * `StyleSheet.create({ btn: { backgroundColor: color.brandDeep } })` reads the
 * string ONCE, when its module is first evaluated, and keeps the copy forever.
 *
 * So a native rebrand is not "apply the five properties", it is "apply the five
 * properties BEFORE the first module that reads them". `src/theme/index.ts`
 * derives `onBrandFill` and `brandTextColor` at module scope, so it is the first
 * consumer by construction — it calls `seal()` and from that instant a rebrand
 * would be half-applied: the modules already evaluated keep the default sage,
 * the ones evaluated later get the salon's colour, and the app renders two
 * brands at once.
 *
 * Half-themed is worse than not themed, so `applyBrandColor` refuses after the
 * seal rather than doing it anyway. And it must be LOUD, not silent: the way
 * this breaks is somebody adding an innocent-looking eager import to the entry
 * point, which would otherwise show up as "the rebrand quietly stopped working"
 * months later. `brandBootOrder.test.ts` asserts the entry's static import graph
 * cannot reach this module's caller, so the regression fails a named test rather
 * than waiting to be noticed on a customer's phone.
 */

let sealed = false;

/** Called by `src/theme/index.ts` at module scope. Not for anyone else. */
export function seal(): void {
  sealed = true;
}

export function paletteIsSealed(): boolean {
  return sealed;
}
