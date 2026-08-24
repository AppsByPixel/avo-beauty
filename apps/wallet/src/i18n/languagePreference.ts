/**
 * The language she explicitly chose, remembered on this device.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THIS EXISTS BECAUSE THE RESTART CONTROL UNDID HER CHOICE WITHOUT IT.
 *
 * On native, switching direction needs an app reload (see `i18n/language.tsx`).
 * `initialLanguage()` returned the default on every launch, so — driven on an
 * iPhone 17 simulator — tapping العربية and then "Restart the app to switch
 * direction" brought the app back in ENGLISH. The control that exists to FINISH
 * the switch was throwing it away. Shipping it without this would have been a
 * button that reverses the thing it was pressed to complete.
 *
 * WHAT THIS IS NOT, AND WHAT IS STILL OWED.
 *
 * `initialLanguage.ts` defers language persistence to the Account slice and
 * declines to read the device locale, and BOTH of those still stand. Its
 * objection is to guessing: "a member who chose English on her phone at signup
 * being flipped to Arabic on a borrowed device". This guesses nothing — it
 * remembers one explicit tap, on one device, and has no such failure mode.
 *
 * It is DEVICE-LOCAL, not member-scoped. Non-negotiable #10's point that the
 * customer's stored preferences follow the account is unaddressed here, and the
 * member-scoped preference is still Account's to land. Two members sharing a
 * handset would share this value; that is a real limitation and it is a smaller
 * one than a restart that silently reverts her language.
 *
 * PLAIN `AsyncStorage`, NOT THE SECRET STORE. A language choice is not a
 * credential; `api/secureStore.ts` is for the refresh token and putting a
 * preference in the Keychain would be miscategorising it.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Language } from '@avo/types';

/** Namespaced like the app's other keys — `SNAPSHOT_KEY`, `SESSION_KEY`. */
export const LANGUAGE_KEY = 'avo.wallet.language.v1';

/** The languages the product ships. A stored value outside this is discarded. */
const SHIPPED: readonly string[] = ['en', 'ar'];

/**
 * Read the remembered choice, or null.
 *
 * Never throws. This runs at boot, before the first frame, and a rejection here
 * would be an unrecoverable blank screen — the same reasoning `secureStore.ts`
 * gives for `readSecret`.
 */
export async function readStoredLanguage(): Promise<Language | null> {
  try {
    const raw = await AsyncStorage.getItem(LANGUAGE_KEY);
    // A value we do not ship is discarded rather than coerced: `COPY[lang]`
    // would be undefined and every string on the screen would read "undefined".
    return raw !== null && SHIPPED.includes(raw) ? (raw as Language) : null;
  } catch {
    return null;
  }
}

/**
 * Remember a choice. Never throws: a failed write costs the memory of the
 * switch, not the switch — she still gets Arabic for this session.
 */
export async function storeLanguage(lang: Language): Promise<void> {
  try {
    await AsyncStorage.setItem(LANGUAGE_KEY, lang);
  } catch {
    /* see above */
  }
}

/**
 * The synchronous hand-off from `Boot` to `App`.
 *
 * `LanguageProvider` takes its initial language as a plain prop, so the value
 * has to be readable synchronously by the time `App` first renders — and reading
 * it in an effect instead would show a frame of English to an Arabic customer on
 * every launch. `Boot` already resolves an async value before importing `App`
 * for exactly this reason (the brand hex, see `state/brandCache.ts`), so this
 * follows that shape rather than inventing a second one.
 */
let cached: Language | null = null;

export function cacheLanguage(lang: Language | null): void {
  cached = lang;
}

export function cachedLanguage(): Language | null {
  return cached;
}
