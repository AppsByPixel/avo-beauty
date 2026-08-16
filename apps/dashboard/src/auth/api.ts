import type { Salon } from '@avo/types';
import { ApiError, request } from '../api/client.js';
import { FALLBACK_SALON_ID } from '../config.js';
import type { Session } from './session.js';
import type { AuthScope } from './scopes.js';

export interface Credentials {
  username: string;
  password: string;
}

interface AuthResponse {
  token: string;
  user: { username: string; name: string; salonId: string | null; perms: Session['perms'] };
}

/**
 * Web sign-in.
 *
 * `POST /auth/session` is what LANES.md gives lane A ("web username+password,
 * refresh with revocation"). It does not exist in `packages/mock` yet, so a 404
 * falls back to a development stand-in that at least proves the workspace is
 * reachable before letting anyone through. The moment the route lands, this
 * function starts using it with no change here — which is the point of writing
 * the real call first and the stand-in second.
 *
 * The password reaches this function and goes no further: it is never stored,
 * never logged, and never put on the Session. Non-negotiable #6.
 */
export async function signIn(scope: AuthScope, credentials: Credentials): Promise<Session> {
  try {
    const result = await request<AuthResponse>('/auth/session', {
      method: 'POST',
      body: { scope, username: credentials.username, password: credentials.password },
    });
    return {
      scope,
      token: result.token,
      username: result.user.username,
      displayName: result.user.name,
      salonId: result.user.salonId,
      perms: result.user.perms,
    };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return developmentSignIn(scope, credentials.username);
    }
    throw error;
  }
}

/**
 * Development stand-in for the missing endpoint. Reads the salon so a wrong API
 * base URL, a stopped mock or an `error`/`offline` scenario surfaces on the
 * sign-in screen instead of one route later — but it authenticates nobody, and
 * it must be deleted with the 404 branch above.
 */
async function developmentSignIn(scope: AuthScope, username: string): Promise<Session> {
  const salon = await request<Salon>(`/salons/${FALLBACK_SALON_ID}`);
  return {
    scope,
    token: `dev_${scope}_${salon.id}`,
    username,
    displayName: displayNameFor(username),
    salonId: salon.id,
    perms: null,
  };
}

/** "amara.k" → "Amara". Matches the greeting in AVO Login.dc.html. */
export function displayNameFor(username: string): string {
  const trimmed = username.trim();
  if (!trimmed) return '';
  const first = trimmed.replace(/[@._-]+/g, ' ').split(' ')[0] ?? '';
  return first.charAt(0).toUpperCase() + first.slice(1);
}
