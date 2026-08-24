/**
 * Reloading the app so a new layout direction takes effect — the WEB and default
 * implementation, which never runs.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THERE ARE TWO OF THESE FILES AND METRO PICKS ONE. READ BOTH BEFORE EDITING.
 *
 *   appReload.ts          this file. Web, and any target without a variant.
 *   appReload.native.ts   iOS and Android. Backed by `expo-updates`.
 *
 * Web never needs it: `document.dir` re-lays the page out on the next frame, so
 * there is no pending direction to apply and `directionOutcome` returns 'live'
 * before anything can reach this. It throws rather than no-ops, because a caller
 * that got here on web has a bug in the guard, not a missing capability — and a
 * silent no-op would hide it. `LanguageToggle` only renders the control when
 * `pendingRestart` is true, which web never sets.
 *
 * `expo-updates`, NOT `react-native-restart`. `react-native-restart` is a bare
 * native module absent from the Expo Go binary, so adding it would break the
 * Expo Go workflow this app is developed and driven under. `expo-updates` is
 * Expo-managed and works in Expo Go and EAS builds alike. This is the reason the
 * dependency is named rather than left to preference.
 * ═════════════════════════════════════════════════════════════════════════════
 */

export async function reloadApp(): Promise<void> {
  throw new Error(
    'reloadApp() is native-only; web changes direction live. See platform/appReload.ts.',
  );
}
