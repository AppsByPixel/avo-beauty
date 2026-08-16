/**
 * Which language the app opens in.
 *
 * Two sources, in order:
 *
 *   1. `?lang=ar` on the URL — development only, and it exists for the same
 *      reason `?scenario=offline` does (see src/api/scenario.ts): a reviewer has
 *      to be able to load the Arabic build directly rather than opening the app
 *      and remembering to press a button. It is what the AR screenshots in this
 *      lane were taken with.
 *   2. Otherwise English.
 *
 * DEVICE LOCALE IS DELIBERATELY NOT READ YET. `expo-localization` would give the
 * phone's language, but the real answer belongs on the member: the design puts
 * Language in Account → Settings, and non-negotiable #10 already establishes that
 * the customer's stored preferences follow the account rather than the handset.
 * Guessing from the device now would mean a member who chose English on her
 * phone at signup being flipped to Arabic on a borrowed device. The persistence
 * slice lands with Account; this returns the default until it does.
 */

import type { Language } from '@avo/types';

export function initialLanguage(): Language {
  if (!__DEV__) return 'en';
  if (typeof window === 'undefined' || typeof window.location === 'undefined') return 'en';
  return new URLSearchParams(window.location.search).get('lang') === 'ar' ? 'ar' : 'en';
}
