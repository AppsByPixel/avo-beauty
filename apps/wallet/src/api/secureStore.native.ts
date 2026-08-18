/**
 * Where the refresh token lives on iOS and Android — the real secret store.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * DECISIONS.md § "Five calls made without asking", call 5, and the completion of
 * § "The wallet's refresh token is recoverable from an unlocked handset".
 *
 * The refresh token used to live in `AsyncStorage`, which on native is an
 * unencrypted file. Lane B said so plainly at the time rather than implying
 * otherwise: "the refresh token is recoverable from an unlocked handset". It now
 * lives in `expo-secure-store` — Keychain on iOS, Keystore-backed
 * `EncryptedSharedPreferences` on Android.
 *
 * Metro resolves this file over `secureStore.ts` on native. See that file's header
 * for why the split is a platform-suffixed module rather than a `Platform.OS`
 * branch, and for the web target this deliberately does not fix.
 *
 * THE MIGRATION IS THE SECURITY-RELEVANT HALF, NOT A CONVENIENCE.
 * ---------------------------------------------------------------
 * Every install that already exists has a refresh token sitting in the
 * unencrypted file. Switching the WRITE path alone would leave that copy there
 * forever — the app would stop reading it, and it would keep existing, which is
 * the worst of both: she is signed out (the new store is empty, so she has to
 * re-authenticate) AND the old plaintext token is still on disk.
 *
 * So `readSecret` falls back to `AsyncStorage` exactly once per key, moves what it
 * finds into the secret store, and DELETES the legacy copy. That is a write inside
 * a read, which is surprising enough to be worth stating loudly — it lives here
 * because the only moment the legacy value is known to exist is the moment it is
 * found, and `restore()` at boot is the only reader.
 *
 * The delete is ordered AFTER the secure write and is conditional on it. Deleting
 * first, or unconditionally, would turn a Keychain failure into a signed-out
 * customer with no recoverable token anywhere.
 *
 * KEY NAMES. `avo.wallet.session.v1` is a legal SecureStore key: the docs allow
 * "alphanumeric characters, `.`, `-`, and `_`". The key is therefore unchanged
 * across the move, which is what lets the migration be keyed on the same string.
 *
 * VALUE SIZE. The stored blob is `{refreshToken, salonId, memberId}` — a few
 * hundred bytes. iOS has historically refused values above roughly 2048 bytes;
 * nothing here approaches that, and a `write` that failed anyway is tolerated the
 * same way the web path tolerates it (see below).
 * ═════════════════════════════════════════════════════════════════════════════
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

/**
 * Keys already checked for a legacy value in this run.
 *
 * The migration is a one-time event per install, but `readSecret` can be called
 * more than once per launch, and after the first successful move the legacy read
 * is pure waste. It is a cache of "already looked", NOT of the value — a null here
 * never suppresses a real read from the secret store below.
 */
const legacyChecked = new Set<string>();

/**
 * Read a secret, migrating a legacy `AsyncStorage` value if one is found.
 *
 * Never throws — a storage backend that cannot be read is indistinguishable, as
 * far as the caller can act on it, from an empty one: both mean "no session, show
 * sign-in". On native a throw is a real possibility rather than a formality, since
 * Keychain access can fail on a locked device.
 */
export async function readSecret(key: string): Promise<string | null> {
  let secure: string | null = null;
  try {
    secure = await SecureStore.getItemAsync(key);
  } catch {
    secure = null;
  }
  if (secure !== null) return secure;

  // ------------------------------------------------------- the migration --
  if (legacyChecked.has(key)) return null;
  legacyChecked.add(key);

  let legacy: string | null = null;
  try {
    legacy = await AsyncStorage.getItem(key);
  } catch {
    return null;
  }
  if (legacy === null) return null;

  /*
    Move it, then remove it — in that order, and the removal only if the move
    worked. A Keychain write that failed while the legacy copy was already gone
    would sign her out AND destroy the only token that could have restored her,
    which is strictly worse than leaving the plaintext copy for one more launch.
  */
  try {
    await SecureStore.setItemAsync(key, legacy);
  } catch {
    // Still return it: this run gets a working session off the value we read, and
    // the next launch tries the move again. The plaintext copy survives, which is
    // the status quo rather than a regression.
    return legacy;
  }

  try {
    await AsyncStorage.removeItem(key);
  } catch {
    /*
      The token is now in the secret store, so the session is safe. The stale
      plaintext copy remains and will be attempted again next launch — and it
      cannot be read as authoritative in the meantime, because the secure read
      above returns first from now on.
    */
  }
  return legacy;
}

/**
 * Store a secret in the Keychain / Keystore.
 *
 * A failed write is swallowed for the reason `rotated()` tolerates one: the
 * in-memory token is already live, so the session works for this run and fails at
 * the next cold start — better than dropping her out of a working session to
 * report a storage problem she cannot act on.
 */
export async function writeSecret(key: string, value: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(key, value);
  } catch {
    /* see above */
  }
}

/**
 * Forget a secret — from BOTH stores.
 *
 * The legacy delete is not redundant. A device whose migration never completed —
 * the Keychain write failed, or the app was killed between the two calls — still
 * has a plaintext token, and "sign me out of this phone" has to remove it. It is
 * cheap and it is the last place that copy can be caught.
 *
 * Neither call may throw: a customer who asked to be signed out must not be kept
 * signed in by a storage error.
 */
export async function deleteSecret(key: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(key);
  } catch {
    /* the in-memory tokens are already gone */
  }
  try {
    await AsyncStorage.removeItem(key);
  } catch {
    /* as above */
  }
}
