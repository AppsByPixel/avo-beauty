/**
 * The session the HTTP boundary reads, and the only place tokens live.
 *
 * WHY A MODULE HOLDER AND NOT A PROP THREADED THROUGH EVERY CALL
 * -------------------------------------------------------------
 * apps/scanner passes `accessToken` into every request function. That works
 * there because the scanner was built with auth from the start. The wallet was
 * not — it has never spoken to an authenticated API, so every module and every
 * hook calls `getJson(path, schema)` with no token argument at all. Threading one
 * through would touch every call site in the app to add a parameter that is the
 * same value everywhere, and would still leave the 401 refresh impossible to do
 * in one place, because each caller would have to handle its own retry.
 *
 * So the token lives here and `client.ts` reads it. One place attaches it, one
 * place refreshes it, and no screen can forget to.
 *
 * WHERE THE TWO TOKENS LIVE, AND WHY THEY LIVE DIFFERENTLY
 * -------------------------------------------------------
 * Non-negotiable #6 is about passwords and it is absolute: the password is never
 * stored, never logged, never cached. It is a function argument to `signIn()` and
 * nothing else — it is not held in state, and the sign-in screen clears it on
 * success exactly as the design does (`AVO Wallet Home.dc.html:1731` sets
 * `fPass: ''`).
 *
 * The tokens are not passwords, but they are bearer credentials, so:
 *
 *   accessToken   IN MEMORY ONLY. It is short-lived (15 minutes) and a reload
 *                 costs one refresh call, which is cheaper than persisting it.
 *   refreshToken  PERSISTED, because the alternative is asking a customer for her
 *                 password every time she reopens the app, and a password typed
 *                 five times a day on a counter is worse for her than a stored
 *                 token.
 *
 * WHERE THE REFRESH TOKEN IS PERSISTED — AND IT IS NO LONGER `AsyncStorage`.
 *
 * This module used to call `AsyncStorage` directly, and said so plainly: "it is
 * NOT a secret store … the refresh token is recoverable from an unlocked
 * handset." It now goes through `./secureStore`, which Metro resolves per target:
 *
 *   native   `secureStore.native.ts` — `expo-secure-store`, i.e. Keychain on iOS
 *            and Keystore-backed storage on Android, WITH a one-time migration
 *            that moves a legacy plaintext token in and deletes the old copy.
 *   web      `secureStore.ts` — still `AsyncStorage`, i.e. `localStorage`.
 *
 * SO THE HANDSET IS FIXED AND THE BROWSER IS NOT, deliberately.
 * `expo-secure-store` has no web implementation, and the web target is development
 * and demo rather than a customer surface (DECISIONS.md § "Five calls made without
 * asking", call 5). That is stated here as well as there, because this is the file
 * somebody reads when they want to know where the token is.
 *
 * A SECRET STORE IS NOT A SESSION POLICY, and the rest of the mitigation is
 * unchanged and still load-bearing: the access token is memory-only so a cold
 * start must refresh, and `signOut()` calls `POST /auth/sign-out` to revoke
 * server-side BEFORE forgetting anything locally — which is what actually kills a
 * token somebody has already lifted. An offline sign-out cannot revoke, so that
 * session stays alive until it expires. This change does not close that gap.
 *
 * REFRESH TOKENS ROTATE, which shapes everything below. `POST /auth/refresh`
 * calls `rotateSession` and returns a NEW refresh token; the old one is dead, and
 * the API cannot tell a replay from a theft so it simply fails. Two consequences
 * this module is built around:
 *   - the rotated token must be persisted, or the next refresh signs her out;
 *   - two concurrent refreshes would rotate twice and the loser would be holding
 *     a dead token, so there is exactly one in flight at a time (see client.ts).
 */

import { deleteSecret, readSecret, writeSecret } from './secureStore';

/**
 * Versioned, and namespaced like the app's other two keys (`SNAPSHOT_KEY`,
 * `PREFERENCES_KEY`). The version is not decoration: if the stored shape ever
 * changes, an old value must be ignored rather than half-parsed into a session
 * that looks valid.
 */
export const SESSION_KEY = 'avo.wallet.session.v1';

export interface StoredSession {
  refreshToken: string;
  /** Which salon's wallet this session belongs to. */
  salonId: string;
  memberId: string;
}

/**
 * In memory, deliberately. See the header — this is the short-lived half.
 */
let accessToken: string | null = null;
let refreshToken: string | null = null;

/**
 * Called when the session ends in a way the customer has to see: a refresh that
 * failed, or an explicit sign-out. The app subscribes and shows the sign-in
 * screen. A callback rather than an event emitter because there is exactly one
 * subscriber and a second one would be a second source of truth about whether
 * she is signed in.
 */
let onEnded: (() => void) | null = null;

export function onSessionEnded(handler: (() => void) | null): void {
  onEnded = handler;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function getRefreshToken(): string | null {
  return refreshToken;
}

export function isSignedIn(): boolean {
  return refreshToken !== null;
}

/**
 * Hold a freshly issued or rotated session.
 *
 * `persist` is false for the access token alone — a rotation that produced no new
 * refresh token would be a contract change, so it is required here rather than
 * optional, and forgetting to store it is the bug this signature prevents.
 */
export async function setSession(next: {
  accessToken: string;
  refreshToken: string;
  salonId: string;
  memberId: string;
}): Promise<void> {
  accessToken = next.accessToken;
  refreshToken = next.refreshToken;
  const stored: StoredSession = {
    refreshToken: next.refreshToken,
    salonId: next.salonId,
    memberId: next.memberId,
  };
  await writeSecret(SESSION_KEY, JSON.stringify(stored));
}

/** A refresh rotated the pair; the access token is new and so is the refresh. */
export async function rotated(next: {
  accessToken: string;
  refreshToken: string;
}): Promise<void> {
  accessToken = next.accessToken;
  refreshToken = next.refreshToken;
  const raw = await readSecret(SESSION_KEY);
  if (raw === null) return;
  try {
    const prev = JSON.parse(raw) as StoredSession;
    const stored: StoredSession = { ...prev, refreshToken: next.refreshToken };
    await writeSecret(SESSION_KEY, JSON.stringify(stored));
  } catch {
    /* a corrupt stored value is cleared by `restore`, not patched here */
  }
}

/**
 * Read the persisted session at boot. Returns null when there is nothing usable.
 *
 * A corrupt or old-shaped value is REMOVED rather than left in place. Leaving it
 * means every launch tries and fails to parse the same bytes, and the customer
 * sees a sign-in screen with no explanation for why her session vanished.
 */
export async function restore(): Promise<StoredSession | null> {
  /*
    `readSecret` never throws and, on native, is also where a legacy plaintext
    token gets moved into the Keychain and deleted — see secureStore.native.ts.
    The try/catch that used to wrap this is gone because the storage module owns
    it now; keeping both would suggest the boundary throws when it does not.
  */
  const raw = await readSecret(SESSION_KEY);
  if (raw === null) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (
      typeof parsed.refreshToken !== 'string' ||
      typeof parsed.salonId !== 'string' ||
      typeof parsed.memberId !== 'string' ||
      parsed.refreshToken === ''
    ) {
      await deleteSecret(SESSION_KEY);
      return null;
    }
    refreshToken = parsed.refreshToken;
    // Note: no access token yet. The first authenticated call will 401 and the
    // client will exchange this refresh token for one — which is the same path a
    // mid-session expiry takes, so boot is not a special case with its own bugs.
    accessToken = null;
    return {
      refreshToken: parsed.refreshToken,
      salonId: parsed.salonId,
      memberId: parsed.memberId,
    };
  } catch {
    await deleteSecret(SESSION_KEY);
    return null;
  }
}

/**
 * Forget everything locally. Does NOT call the API — `signOut()` in api/auth.ts
 * does that first, because a local clear that skipped the revoke would leave a
 * working token on a device the customer believes she has signed out of.
 *
 * `notify` is false when the caller is already rendering the sign-in screen, so
 * the app is not told twice about one ending.
 */
export async function clearSession(notify = true): Promise<void> {
  accessToken = null;
  refreshToken = null;
  /*
    On native this clears BOTH stores. A device whose migration never completed
    still holds a plaintext token, and "sign me out of this phone" has to remove
    it — see secureStore.native.ts § deleteSecret.
  */
  await deleteSecret(SESSION_KEY);
  if (notify) onEnded?.();
}

/** Test seam. Never called by the app. */
export function __resetSessionForTest(): void {
  accessToken = null;
  refreshToken = null;
  onEnded = null;
}
