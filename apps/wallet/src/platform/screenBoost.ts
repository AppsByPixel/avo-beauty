/**
 * Raising the screen for the enlarged payment code — the WEB and default
 * implementation, which does nothing.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THERE ARE TWO OF THESE FILES AND METRO PICKS ONE. READ BOTH BEFORE EDITING.
 *
 *   screenBoost.ts          this file. Web, and any target without a platform
 *                           variant. No driver, so every call is a no-op.
 *   screenBoost.native.ts   iOS and Android. Backed by `expo-brightness`.
 *
 * A platform-suffixed file rather than a `Platform.OS` branch, for the reasons
 * `api/secureStore.ts` sets out for the same split: a runtime branch would still
 * put `expo-brightness` in the web bundle, which is exactly the objection
 * `i18n/language.tsx` raises about pulling a native-only module in for a surface
 * that cannot use it. It also keeps the core testable — `brightness.ts` imports
 * nothing at all, and the node test suite never loads either of these files.
 *
 * WEB IS NOT A GAP HERE, IT IS THE PLATFORM. A page cannot set the screen
 * brightness of the device it is displayed on, by design; there is no API to
 * call and no permission to ask for. So `qrBigSub` — "Screen brightened for
 * scanning" — is a sentence the web build cannot honour, and it is shown anyway
 * because the copy is frozen and identical on both targets. Reported rather than
 * papered over: it is a product call whether the web build should say something
 * different, not an engineering one.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { useScreenBoostWith } from './useScreenBoostWith';

/** Raise the screen while `active`. On web there is nothing to raise. */
export function useScreenBoost(active: boolean): void {
  useScreenBoostWith(active, null);
}
