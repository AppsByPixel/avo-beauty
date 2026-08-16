import { ApiError, request, type RequestOptions } from '../api/client.js';
import { refreshSession } from './refresh.js';
import type { AuthScope } from './scopes.js';
import { clearSession, readSession } from './session.js';

/**
 * Every authenticated call goes through here.
 *
 * The session is read from the store rather than passed in, for the same reason
 * the salon id is: one place to be wrong. A caller cannot forget the bearer, and
 * cannot hold a token across a rotation and send a stale one.
 *
 * TOKEN EXPIRY MID-SESSION. Access tokens live fifteen minutes; the API's
 * `expiresAt` is the refresh token's expiry (thirty days), so there is nothing
 * in the response that says when the access token dies and no honest way to
 * refresh ahead of it. So the 401 IS the signal: rotate once, retry once. A
 * merchant who leaves the Overview open over lunch sees the next poll blink and
 * nothing else.
 *
 * Retrying is safe for the money endpoints too. A 401 means the request was
 * refused before it reached a handler, so nothing moved, and the retry carries
 * the same `Idempotency-Key` (non-negotiable #4) — the retry is exactly what
 * that header is for.
 *
 * The retry happens ONCE. If a freshly minted access token is also refused, the
 * session is genuinely finished and looping would only turn a sign-out into a
 * hang.
 */
export async function authedRequest<T>(
  scope: AuthScope,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const session = readSession(scope);
  if (!session) {
    // Same shape as the server's own 401, so callers have one thing to handle.
    throw new ApiError('Sign in to continue.', { status: 401, code: 'no_session' });
  }

  try {
    return await request<T>(path, { ...options, token: session.accessToken });
  } catch (error) {
    if (!(error instanceof ApiError) || !error.isUnauthenticated) throw error;

    const refreshed = await refreshSession(scope, session.accessToken);
    if (!refreshed) {
      clearSession(scope);
      throw error;
    }

    try {
      return await request<T>(path, { ...options, token: refreshed.accessToken });
    } catch (retryError) {
      if (retryError instanceof ApiError && retryError.isUnauthenticated) clearSession(scope);
      throw retryError;
    }
  }
}
