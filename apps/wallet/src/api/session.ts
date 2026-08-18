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
 * AND THE PART THAT IS NOT SECURE, STATED PLAINLY RATHER THAN IMPLIED.
 * `AsyncStorage` is `localStorage` on this app's web target and an unencrypted
 * file on native. It is NOT a secret store. `expo-secure-store` would be the
 * right home for the refresh token, and it is not used here for two reasons worth
 * writing down rather than discovering later: it is not a dependency of this app,
 * and it does not work on web, which is the target this wallet actually builds
 * for (`expo export --platform web`). So the refresh token is recoverable from an
 * unlocked handset.
 *
 * That is the threat model trunk named — an unlocked phone on a salon counter —
 * and the mitigation that IS available is server-side and is used: `signOut()`
 * calls `POST /auth/sign-out`, which revokes the session rather than only
 * forgetting it locally, so a token lifted from a handset stops working the
 * moment she signs out. REPORTED, not solved: a genuinely secret store on native
 * needs a dependency decision that belongs to trunk.
 *
 * REFRESH TOKENS ROTATE, which shapes everything below. `POST /auth/refresh`
 * calls `rotateSession` and returns a NEW refresh token; the old one is dead, and
 * the API cannot tell a replay from a theft so it simply fails. Two consequences
 * this module is built around:
 *   - the rotated token must be persisted, or the next refresh signs her out;
 *   - two concurrent refreshes would rotate twice and the loser would be holding
 *     a dead token, so there is exactly one in flight at a time (see client.ts).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

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
  await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(stored));
}

/** A refresh rotated the pair; the access token is new and so is the refresh. */
export async function rotated(next: {
  accessToken: string;
  refreshToken: string;
}): Promise<void> {
  accessToken = next.accessToken;
  refreshToken = next.refreshToken;
  const raw = await AsyncStorage.getItem(SESSION_KEY);
  if (raw === null) return;
  try {
    const prev = JSON.parse(raw) as StoredSession;
    const stored: StoredSession = { ...prev, refreshToken: next.refreshToken };
    await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(stored));
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
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (
      typeof parsed.refreshToken !== 'string' ||
      typeof parsed.salonId !== 'string' ||
      typeof parsed.memberId !== 'string' ||
      parsed.refreshToken === ''
    ) {
      await AsyncStorage.removeItem(SESSION_KEY);
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
    await AsyncStorage.removeItem(SESSION_KEY);
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
  try {
    await AsyncStorage.removeItem(SESSION_KEY);
  } catch {
    /* nothing useful to do; the in-memory tokens are already gone */
  }
  if (notify) onEnded?.();
}

/** Test seam. Never called by the app. */
export function __resetSessionForTest(): void {
  accessToken = null;
  refreshToken = null;
  onEnded = null;
}
