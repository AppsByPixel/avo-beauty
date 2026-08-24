/**
 * Remembering the language she chose.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WITHOUT THIS, THE RESTART CONTROL UNDOES HER CHOICE.
 *
 * Driven on an iPhone 17 simulator: tap العربية, tap "Restart the app to switch
 * direction", and the app comes back in ENGLISH. `initialLanguage()` returned
 * the default on every launch, so the restart that exists to finish the switch
 * threw the switch away. A button that reverses the thing it was pressed to
 * complete is worse than the inert notice it replaced.
 *
 * WHAT THIS IS NOT. It is not the member-scoped language preference that
 * `initialLanguage.ts` defers to the Account slice, and it does not read the
 * device locale. That note's objection was to GUESSING — "a member who chose
 * English on her phone at signup being flipped to Arabic on a borrowed device" —
 * and it stands. This only remembers an explicit tap, on this device, which has
 * no such failure mode. Account still owes the preference that follows the
 * account rather than the handset.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => void store.set(k, v),
    removeItem: async (k: string) => void store.delete(k),
  },
}));

const { LANGUAGE_KEY, cacheLanguage, cachedLanguage, readStoredLanguage, storeLanguage } =
  await import('./languagePreference');

beforeEach(() => {
  store.clear();
  cacheLanguage(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('what is remembered', () => {
  it('round-trips an explicit choice', async () => {
    await storeLanguage('ar');
    expect(await readStoredLanguage()).toBe('ar');
    await storeLanguage('en');
    expect(await readStoredLanguage()).toBe('en');
  });

  it('is null when she has never chosen', async () => {
    expect(await readStoredLanguage()).toBeNull();
  });

  /**
   * A stored value that is not a language the product ships is discarded rather
   * than handed to the copy modules, where `COPY[lang]` would be undefined and
   * every string on the screen would read "undefined".
   */
  it('discards a value that is not a language we ship', async () => {
    store.set(LANGUAGE_KEY, 'fr');
    expect(await readStoredLanguage()).toBeNull();
    store.set(LANGUAGE_KEY, '');
    expect(await readStoredLanguage()).toBeNull();
  });
});

describe('storage that misbehaves', () => {
  it('reads as "never chosen" rather than throwing at boot', async () => {
    const mod = (await import('@react-native-async-storage/async-storage')).default;
    vi.spyOn(mod, 'getItem').mockRejectedValueOnce(new Error('disk'));
    // A throw here would be an unrecoverable blank screen before the first frame.
    await expect(readStoredLanguage()).resolves.toBeNull();
  });

  it('does not fail the switch when the write fails', async () => {
    const mod = (await import('@react-native-async-storage/async-storage')).default;
    vi.spyOn(mod, 'setItem').mockRejectedValueOnce(new Error('full'));
    // She still gets Arabic THIS session; only the memory of it is lost.
    await expect(storeLanguage('ar')).resolves.toBeUndefined();
  });
});

describe('the synchronous cache Boot fills', () => {
  /**
   * `LanguageProvider` takes its initial language as a plain prop, so the value
   * has to be readable synchronously by the time `App` renders. `Boot` resolves
   * it before importing `App` — the same shape it already uses for the brand
   * hex — and parks it here.
   */
  it('is null until Boot fills it', () => {
    expect(cachedLanguage()).toBeNull();
  });

  it('hands back exactly what Boot resolved', async () => {
    await storeLanguage('ar');
    cacheLanguage(await readStoredLanguage());
    expect(cachedLanguage()).toBe('ar');
  });

  it('can be cleared back to null', () => {
    cacheLanguage('ar');
    cacheLanguage(null);
    expect(cachedLanguage()).toBeNull();
  });
});
