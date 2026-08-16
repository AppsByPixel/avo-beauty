import { ApiError, request } from '../api/client.js';
import type { AuthScope } from './scopes.js';
import { clearSession, readSession, updateSession, type Session } from './session.js';

/** `POST /auth/refresh` — `expiresAt` is the new REFRESH token's expiry. */
interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

/**
 * Rotate the token pair.
 *
 * THE PROBLEM THIS FILE EXISTS FOR
 * --------------------------------
 * Refresh tokens are opaque and single-use. `rotateSession` in the API updates
 * the row conditionally on the hash we presented still being the stored one, so
 * two concurrent refreshes with the same token cannot both succeed — the loser
 * gets `null` and a 401 "That session has ended." From the server's side a
 * replayed refresh token is indistinguishable from a stolen one, and refusing it
 * is correct.
 *
 * On the client that same property is a hazard, because "two concurrent
 * refreshes with the same token" is not an attack, it is a front-desk machine
 * with the Overview open in one tab and the roster in another. Both tabs' access
 * tokens expire at the same moment, both 401, both read the same refresh token
 * out of the same `localStorage`, and one of them signs the merchant out mid-day.
 *
 * THE FIX HAS THREE PARTS, AND ALL THREE ARE NEEDED
 * -------------------------------------------------
 * 1. Per-tab single flight (`inflight`). Six queries failing at once produce one
 *    rotation, not six. This alone fixes the common case and none of the racy one.
 *
 * 2. A cross-tab lock (`navigator.locks`), so only one TAB is inside the
 *    rotation at a time. Locks are same-origin and shared across tabs, which is
 *    exactly the scope of the shared storage that causes the race.
 *
 * 3. A re-read INSIDE the lock. This is the part that actually resolves the
 *    race: the tab that waited re-reads storage, sees an access token that is no
 *    longer the one it choked on, and returns the winner's session instead of
 *    burning the freshly rotated refresh token on a second rotation. Without it,
 *    the lock only serialises the collision rather than preventing it.
 *
 * A browser without `navigator.locks` degrades to (1) and (3) alone: two tabs can
 * still collide, and the loser signs out. That is the pre-existing behaviour, not
 * a regression, and every browser the dashboard's breakpoints target has locks.
 */
const inflight = new Map<AuthScope, Promise<Session | null>>();

async function withLock<T>(name: string, run: () => Promise<T>): Promise<T> {
  const locks = navigator.locks;
  if (!locks) return run();
  return locks.request(name, run) as Promise<T>;
}

/**
 * @param staleAccessToken the access token that just produced a 401. It is the
 * evidence of what this caller already knew; if storage no longer holds it,
 * somebody else has already rotated and there is nothing to do.
 */
export function refreshSession(
  scope: AuthScope,
  staleAccessToken: string,
): Promise<Session | null> {
  const existing = inflight.get(scope);
  if (existing) return existing;

  const run = withLock(`avo.session.refresh.${scope}`, async () => {
    const current = readSession(scope);
    if (!current) return null;

    // Another tab (or another query in this one) already rotated while we were
    // queued. Reuse its result — presenting our stale refresh token now would
    // be a replay, and the API would correctly refuse it and end the session.
    if (current.accessToken !== staleAccessToken) return current;

    let rotated: RefreshResponse;
    try {
      rotated = await request<RefreshResponse>('/auth/refresh', {
        method: 'POST',
        body: { refreshToken: current.refreshToken },
      });
    } catch (error) {
      // A refusal ends the session. A dead network does NOT — going offline
      // must not sign a merchant out, so the failure propagates as-is and the
      // screen renders the offline state with its figures still on it.
      if (error instanceof ApiError && error.isUnauthenticated) {
        clearSession(scope);
        return null;
      }
      throw error;
    }

    const next: Session = {
      ...current,
      accessToken: rotated.accessToken,
      refreshToken: rotated.refreshToken,
      refreshExpiresAt: rotated.expiresAt,
    };
    updateSession(next);

    // `updateSession` is a no-op if the session was signed out while the
    // rotation was in the air. Re-reading is how we notice, instead of handing
    // back a live token for a session the merchant just ended.
    return readSession(scope);
  }).finally(() => {
    inflight.delete(scope);
  });

  inflight.set(scope, run);
  return run;
}
