/**
 * Where the refresh token lives — the WEB and default implementation.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THERE ARE TWO OF THESE FILES AND METRO PICKS ONE. READ BOTH BEFORE EDITING.
 *
 *   secureStore.ts          this file. Web, and any target without a platform
 *                           variant. Backed by `AsyncStorage`.
 *   secureStore.native.ts   iOS and Android. Backed by `expo-secure-store`, the
 *                           real secret store, with a one-time migration off
 *                           AsyncStorage.
 *
 * A platform-suffixed file rather than a `Platform.OS` branch, and the reason is
 * not style. `expo-secure-store` DOES NOT SUPPORT WEB
 * (docs.expo.dev/versions/v57.0.0/sdk/securestore — "Android, iOS, tvOS"), and a
 * runtime branch would still put its import in the web bundle. It is also what
 * keeps this module testable at all: the tests run in a node environment with no
 * React Native and no native modules, so a `Platform` import would have to be
 * mocked in every suite that touches a session.
 *
 * WEB IS DELIBERATELY NOT FIXED, and this is the honest half of the change.
 * `AsyncStorage` on web is `localStorage`. A refresh token in `localStorage` is
 * readable by any script that reaches the page. That is accepted here because the
 * web target is development and demo rather than a customer surface
 * (DECISIONS.md § "The wallet's refresh token is recoverable from an unlocked
 * handset"), and the customer surface is the native app this file is NOT used by.
 * If the web build ever becomes something a customer signs into, this is the file
 * that is wrong, and no amount of native hardening changes that.
 *
 * WHAT IS STILL TRUE ON BOTH TARGETS. A secret store is not a session policy:
 *   · the access token stays in memory on both, so a cold start must refresh;
 *   · `signOut()` revokes server-side BEFORE forgetting locally, which is what
 *     actually kills a lifted token;
 *   · an offline sign-out cannot revoke, so the session lives until it expires.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Read a stored secret, or null.
 *
 * Never throws. A storage backend that cannot be read is indistinguishable from
 * an empty one as far as the caller can act on it — both mean "there is no
 * session here, show sign-in" — and a throw at boot would be an unrecoverable
 * blank screen instead.
 */
export async function readSecret(key: string): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Store a secret.
 *
 * Throws are swallowed for the same reason `rotated()` tolerates a failed write:
 * the in-memory token is already live, so the session works for this run and
 * fails at the next cold start, which is strictly better than dropping her out of
 * a working session to report a storage problem she cannot act on.
 */
export async function writeSecret(key: string, value: string): Promise<void> {
  try {
    await AsyncStorage.setItem(key, value);
  } catch {
    /* see above */
  }
}

/**
 * Forget a secret.
 *
 * MUST NOT THROW, and this is the one of the three where that matters most:
 * `clearSession()` calls it on the sign-out path, and a customer who asked to be
 * signed out of a phone must not be kept signed in by a storage error.
 */
export async function deleteSecret(key: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(key);
  } catch {
    /* the in-memory tokens are already gone; nothing else to do */
  }
}
