/**
 * Which language the app opens in.
 *
 * Three sources, in order:
 *
 *   1. `?lang=ar` on the URL — development only, and it exists for the same
 *      reason `?scenario=offline` does (see src/api/scenario.ts): a reviewer has
 *      to be able to load the Arabic build directly rather than opening the app
 *      and remembering to press a button. It is what the AR screenshots in this
 *      lane were taken with. First, so it can override a remembered choice.
 *   2. The choice she last made on this device, resolved by `Boot` before `App`
 *      is imported. NEW, and it is what makes the native restart control mean
 *      anything: without it the reload that finishes an RTL switch came back in
 *      English and threw the switch away. See `languagePreference.ts` for what
 *      this is NOT — it is device-local and remembers only an explicit tap.
 *   3. Otherwise English.
 *
 * DEVICE LOCALE IS DELIBERATELY NOT READ YET. `expo-localization` would give the
 * phone's language, but the real answer belongs on the member: the design puts
 * Language in Account → Settings, and non-negotiable #10 already establishes that
 * the customer's stored preferences follow the account rather than the handset.
 * Guessing from the device now would mean a member who chose English on her
 * phone at signup being flipped to Arabic on a borrowed device. THAT REASONING
 * STILL STANDS and source 2 does not weaken it: remembering an explicit tap on
 * this handset is not guessing from its locale. The MEMBER-SCOPED preference —
 * the one that follows the account rather than the device, per non-negotiable
 * #10 — is still Account's to land.
 */

import type { Language } from '@avo/types';
import { cachedLanguage } from './languagePreference';

export function initialLanguage(): Language {
  // 1. The dev override, first, so a reviewer can force a language past a
  //    remembered one.
  if (__DEV__ && typeof window !== 'undefined' && typeof window.location !== 'undefined') {
    if (new URLSearchParams(window.location.search).get('lang') === 'ar') return 'ar';
  }
  // 2. What she last chose on this device, parked by `Boot`.
  return cachedLanguage() ?? 'en';
}
