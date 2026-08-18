/**
 * The NATIVE secret store, and specifically its migration.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS SEPARATELY FROM session.test.ts.
 *
 * `secureStore.ts` and `secureStore.native.ts` are a Metro platform pair, and the
 * node environment these tests run in resolves the FORMER. So every existing
 * session spec exercises the web/AsyncStorage path — correctly, and unchanged —
 * and the native path would otherwise ship with nothing having executed it.
 *
 * This imports `./secureStore.native` by its explicit filename, which is the one
 * way to reach it from a test, and mocks both backends.
 *
 * WHAT IS WORTH TESTING HERE IS THE MIGRATION, NOT THE WRAPPER. `setItemAsync`
 * being called is a tautology. The migration is three ordered operations with a
 * failure mode at each step, and getting the ORDER wrong is a signed-out customer
 * whose token no longer exists anywhere:
 *
 *   read secure → miss → read legacy → write secure → delete legacy
 *
 * The delete must come last and must be conditional on the write. That is the
 * assertion this file is really for.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The Keychain, as a map, plus a switch to make it fail like a locked device. */
const secure = new Map<string, string>();
let secureWriteFails = false;
let secureReadFails = false;

/** The legacy unencrypted store the migration has to empty. */
const legacy = new Map<string, string>();
let legacyDeleteFails = false;

/** Every backend call, in order — the order IS the thing under test. */
const order: string[] = [];

vi.mock('expo-secure-store', () => ({
  getItemAsync: async (k: string) => {
    order.push(`secure.get:${k}`);
    if (secureReadFails) throw new Error('keychain locked');
    return secure.get(k) ?? null;
  },
  setItemAsync: async (k: string, v: string) => {
    order.push(`secure.set:${k}`);
    if (secureWriteFails) throw new Error('keychain refused');
    secure.set(k, v);
  },
  deleteItemAsync: async (k: string) => {
    order.push(`secure.delete:${k}`);
    secure.delete(k);
  },
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => {
      order.push(`legacy.get:${k}`);
      return legacy.get(k) ?? null;
    },
    setItem: async (k: string, v: string) => {
      order.push(`legacy.set:${k}`);
      legacy.set(k, v);
    },
    removeItem: async (k: string) => {
      order.push(`legacy.remove:${k}`);
      if (legacyDeleteFails) throw new Error('cannot remove');
      legacy.delete(k);
    },
  },
}));

const KEY = 'avo.wallet.session.v1';
const TOKEN = '{"refreshToken":"RT-legacy","salonId":"SAL-AMARA","memberId":"8842"}';

/**
 * Re-imported per test with the module registry reset, because the module keeps a
 * `legacyChecked` set across calls — which is behaviour under test in one spec and
 * cross-test contamination in every other.
 */
async function load() {
  vi.resetModules();
  return import('./secureStore.native');
}

beforeEach(() => {
  secure.clear();
  legacy.clear();
  order.length = 0;
  secureWriteFails = false;
  secureReadFails = false;
  legacyDeleteFails = false;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the ordinary path', () => {
  it('reads from the secret store and never touches the legacy one', async () => {
    secure.set(KEY, TOKEN);
    const { readSecret } = await load();

    expect(await readSecret(KEY)).toBe(TOKEN);
    // The assertion that matters: no legacy read at all. A migration that ran on
    // every launch would be a pointless file read on the boot path forever.
    expect(order).toEqual([`secure.get:${KEY}`]);
  });

  it('writes to the secret store', async () => {
    const { writeSecret } = await load();
    await writeSecret(KEY, TOKEN);
    expect(secure.get(KEY)).toBe(TOKEN);
  });

  it('returns null when neither store has anything', async () => {
    const { readSecret } = await load();
    expect(await readSecret(KEY)).toBeNull();
  });
});

describe('the migration off the unencrypted store', () => {
  /**
   * THE POINT OF THE WHOLE CHANGE. Every existing install has a refresh token in
   * an unencrypted file. A switch that only changed the WRITE path would sign her
   * out AND leave the plaintext copy on disk forever — the worst of both.
   */
  it('moves a legacy token in and DELETES the plaintext copy', async () => {
    legacy.set(KEY, TOKEN);
    const { readSecret } = await load();

    expect(await readSecret(KEY)).toBe(TOKEN);
    expect(secure.get(KEY)).toBe(TOKEN);
    expect(legacy.has(KEY)).toBe(false);
  });

  it('deletes the plaintext copy only AFTER the secure write succeeded', async () => {
    legacy.set(KEY, TOKEN);
    const { readSecret } = await load();
    await readSecret(KEY);

    expect(order).toEqual([
      `secure.get:${KEY}`,
      `legacy.get:${KEY}`,
      `secure.set:${KEY}`,
      `legacy.remove:${KEY}`,
    ]);
    // Spelled out as well as pinned in the sequence above, because this is the
    // ordering claim: the delete is last.
    expect(order.indexOf(`secure.set:${KEY}`)).toBeLessThan(
      order.indexOf(`legacy.remove:${KEY}`),
    );
  });

  /**
   * The failure that would destroy a session. If the Keychain refuses and the
   * legacy copy has already gone, the token exists nowhere and she is signed out
   * with no recovery. Keeping the plaintext copy for one more launch is the status
   * quo, which is strictly better.
   */
  it('keeps the plaintext copy when the secure write fails, and still returns the token', async () => {
    legacy.set(KEY, TOKEN);
    secureWriteFails = true;
    const { readSecret } = await load();

    expect(await readSecret(KEY)).toBe(TOKEN);
    expect(legacy.get(KEY)).toBe(TOKEN);
    expect(order).not.toContain(`legacy.remove:${KEY}`);
  });

  it('keeps the session working when the plaintext copy cannot be removed', async () => {
    legacy.set(KEY, TOKEN);
    legacyDeleteFails = true;
    const { readSecret } = await load();

    expect(await readSecret(KEY)).toBe(TOKEN);
    // The token is in the secret store, so the next read is authoritative and the
    // stale copy can never be preferred over it.
    expect(secure.get(KEY)).toBe(TOKEN);
    expect(await readSecret(KEY)).toBe(TOKEN);
  });

  it('looks for a legacy value once per key, not once per read', async () => {
    const { readSecret } = await load();
    await readSecret(KEY);
    await readSecret(KEY);
    await readSecret(KEY);

    expect(order.filter((c) => c === `legacy.get:${KEY}`)).toHaveLength(1);
  });

  /**
   * A locked device can fail a Keychain READ. That must fall through to the legacy
   * path rather than reporting "no session" — otherwise an upgrade on a phone that
   * happened to be locked at launch loses her session AND skips the migration,
   * leaving the plaintext token behind.
   */
  it('falls back to the legacy store when the secure read itself throws', async () => {
    legacy.set(KEY, TOKEN);
    secureReadFails = true;
    const { readSecret } = await load();

    expect(await readSecret(KEY)).toBe(TOKEN);
  });
});

describe('signing out removes the token from both stores', () => {
  /**
   * Not redundant. A device whose migration never completed — the Keychain write
   * failed, or the app was killed between the two calls — still holds a plaintext
   * token, and "sign me out of this phone" has to remove it. This is the last place
   * that copy can be caught.
   */
  it('deletes the legacy copy as well as the secure one', async () => {
    secure.set(KEY, TOKEN);
    legacy.set(KEY, TOKEN);
    const { deleteSecret } = await load();

    await deleteSecret(KEY);
    expect(secure.has(KEY)).toBe(false);
    expect(legacy.has(KEY)).toBe(false);
  });

  it('still clears the legacy copy when the secure delete throws', async () => {
    legacy.set(KEY, TOKEN);
    const mod = await load();
    const store = await import('expo-secure-store');
    vi.spyOn(store, 'deleteItemAsync').mockRejectedValue(new Error('keychain locked'));

    await mod.deleteSecret(KEY);
    expect(legacy.has(KEY)).toBe(false);
  });
});

describe('the key is a legal SecureStore key', () => {
  /**
   * The docs allow "alphanumeric characters, `.`, `-`, and `_`", and the migration
   * depends on the key being UNCHANGED across the move — a renamed key would find
   * nothing in the legacy store and silently sign out every existing install
   * while leaving its plaintext token in place.
   */
  it('contains only characters expo-secure-store accepts', () => {
    expect(KEY).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it('is the same key session.ts persists under', async () => {
    const { SESSION_KEY } = await import('./session');
    expect(SESSION_KEY).toBe(KEY);
  });
});
