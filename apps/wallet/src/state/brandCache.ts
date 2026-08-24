/**
 * The salon's brand hex, remembered across launches.
 *
 * WHY A CACHE IS NECESSARY AND NOT A SHORTCUT
 * ===========================================
 * `GET /salons/{id}` serves `brandColor`, and the wallet already reads it on
 * every home load (`useWalletHome` → `getSalon`). But that endpoint needs an
 * authenticated principal of the salon (api/src/routes/salons.ts — "readable by
 * any authenticated principal of that salon"), so the hex simply does not exist
 * on the device until someone has signed in at least once.
 *
 * Meanwhile the screens that render BEFORE a session — sign-in, create account,
 * forgot password — are brand-coloured: the "Log in" fill, the footer links, the
 * reset circle. And the palette can only be set once per process
 * (`src/theme/sealed.ts`). So the hex has to be on the device at boot, which
 * means it has to have been written on a previous run.
 *
 * WHY NOT THE HOME SNAPSHOT, WHICH ALREADY HOLDS THE WHOLE SALON
 * =============================================================
 * Two reasons, both of which would show up as the app silently reverting to
 * sage:
 *
 *   1. `readSnapshot()` DISCARDS the whole cache when a `@avo/types` schema
 *      changes — deliberately, because showing a balance we cannot vouch for is
 *      worse than showing none. A contract bump would therefore un-brand the app
 *      until the next successful load, i.e. exactly at the moment everything else
 *      is also in flux. A single hex has no schema to bump.
 *   2. Signing out drops the snapshot (`SNAPSHOT_KEY`), and sign-in is the screen
 *      that most needs the brand. A signed-out phone is still that salon's phone.
 *
 * Which is also why this key is NOT cleared on sign-out. It is the build's
 * identity, not the member's, and it holds no personal data — a six-character
 * colour that the salon publishes on its own storefront.
 *
 * NON-NEGOTIABLE #2 IS NOT IN PLAY. Nothing here is money and nothing computes
 * anything; the server remains the only source of the hex, and a value that fails
 * the contract's own pattern is dropped rather than coerced.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'avo.wallet.brand.v1';

/**
 * design/api-contract.md § Salon — "brandColor  string  // hex; drives the
 * white-label token", and `packages/types/src/entities.ts:87` is the same
 * pattern. Re-checked on read because storage is not a trusted channel: a
 * half-written value must fail into "no hex" (defaults stand) rather than reach
 * `deriveBrandSet` as garbage.
 */
const HEX = /^#[0-9A-Fa-f]{6}$/;

export async function readCachedBrandColor(): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw && HEX.test(raw) ? raw : null;
  } catch {
    // Unreadable storage is the same situation as a first launch, and the app
    // already handles that: the default palette stands. Not worth failing to
    // launch over.
    return null;
  }
}

/**
 * Called on every successful salon read, not just the first. A salon that
 * changes its hex in the dashboard is picked up here and applied at the next
 * launch — see `src/theme/brand.ts` on why not mid-session.
 */
export async function cacheBrandColor(hex: string): Promise<void> {
  if (!HEX.test(hex)) return;
  try {
    await AsyncStorage.setItem(KEY, hex);
  } catch {
    // A cache write failing must never break a screen that already has its data.
  }
}
