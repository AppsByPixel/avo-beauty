import { StaffUserSchema, type StaffUser } from '@avo/types';
import { ApiError, request } from '../api/client.js';
import { deviceId } from '../config.js';
import { authedRequest } from './authedRequest.js';
import type { AuthScope } from './scopes.js';
import {
  clearSession,
  readSession,
  type MerchantSession,
  type OwnerSession,
} from './session.js';
import { parsePlatformAdmin } from './platformAdmin.js';

export interface Credentials {
  /**
   * The salon the credential belongs to. `staff_user_salon_handle_uq` is on
   * (salon_id, handle), so "noura" does not identify a person — the API needs
   * the triple. See config.ts for why this is a credential component and not an
   * authorisation, and SignIn.tsx for where the value comes from.
   */
  salonId: string;
  username: string;
  password: string;
}

/** `POST /auth/web/session`, verbatim. `expiresAt` is the REFRESH expiry. */
interface WebSessionResponse {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  staff: StaffUser;
}

/**
 * Web sign-in.
 *
 * This calls the real endpoint. The development stand-in that used to live here
 * — a 404 fallback that read a hardcoded salon and minted a `dev_` token —
 * authenticated nobody and is gone.
 *
 * The password reaches this function and goes no further: it is never stored,
 * never logged, and never put on the Session. Non-negotiable #6.
 *
 * THE SALON ON THE RETURNED SESSION IS `staff.salonId`, NOT `credentials.salonId`.
 * They will usually be equal, because the API looks the staff row up by the
 * salon that was typed. Reading it back off the response anyway is the habit
 * that matters: the server owns which salon a session is for, and the client
 * records what it was told rather than what it asked for.
 */
export async function signIn(scope: 'merchant', credentials: Credentials): Promise<MerchantSession> {
  const device = deviceId();
  const result = await request<WebSessionResponse>('/auth/web/session', {
    method: 'POST',
    body: {
      salonId: credentials.salonId,
      username: credentials.username,
      password: credentials.password,
      ...(device ? { deviceId: device } : {}),
    },
  });

  // `StaffUserSchema` is the trunk contract in packages/types and matches the
  // API's `serialiseStaff` field for field. Parsing rather than trusting means a
  // response that drops `salonId` or `perms` fails HERE, at sign-in, instead of
  // rendering a shell with no salon in it and 404ing one route later.
  const parsed = StaffUserSchema.safeParse(result.staff);
  if (!parsed.success || !parsed.data.salonId) {
    throw new ApiError('That sign-in did not come back with a workspace. Try again.', {
      status: 401,
      code: 'session_without_salon',
    });
  }
  const staff = parsed.data;

  return {
    scope,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    refreshExpiresAt: result.expiresAt,
    staffId: staff.id,
    username: staff.handle,
    displayName: staff.name,
    salonId: staff.salonId,
    perms: staff.perms,
  };
}

/**
 * Sign out.
 *
 * `POST /auth/sign-out` revokes the session row server-side, which is the half
 * that matters: clearing `localStorage` only removes the copy on this machine
 * and leaves a refresh token valid for thirty more days for anyone who captured
 * it. `revokeSession` sets `revoked_at`, and `resolvePrincipal` re-checks the
 * row on every request, so the access token stops working immediately too
 * rather than living out its fifteen minutes.
 *
 * Through `authedRequest`, so an access token that expired while the merchant
 * was reading rotates and the revoke still lands instead of 401ing into a
 * local-only sign-out.
 *
 * The local session is cleared whatever happens. A merchant who clicks Sign out
 * on a shared front-desk machine and walks away must not be left signed in
 * because the network was down — the server-side revoke is best effort, the
 * local clear is not.
 */
export async function signOut(scope: AuthScope): Promise<{ revoked: boolean }> {
  if (!readSession(scope)) return { revoked: false };
  try {
    await authedRequest<void>(scope, '/auth/sign-out', { method: 'POST' });
    return { revoked: true };
  } catch (error) {
    // A 401 means the session was already dead server-side, which is the same
    // end state. Anything else — offline, a 500 — leaves a live row behind, so
    // say so rather than reporting a clean sign-out.
    const alreadyGone = error instanceof ApiError && error.isUnauthenticated;
    if (!alreadyGone) console.warn('[avo] Sign-out did not reach the server; clearing locally.');
    return { revoked: alreadyGone };
  } finally {
    clearSession(scope);
  }
}

/** "amara.k" → "Amara". Matches the greeting in AVO Login.dc.html. */
export function displayNameFor(username: string): string {
  const trimmed = username.trim();
  if (!trimmed) return '';
  const first = trimmed.replace(/[@._-]+/g, ' ').split(' ')[0] ?? '';
  return first.charAt(0).toUpperCase() + first.slice(1);
}

// ------------------------------------------------------------ owner console --

export interface ConsoleCredentials {
  /**
   * NO SALON, AND THAT IS THE POINT. `platform_admin.handle` is globally unique,
   * unlike `staff_user`'s (salon_id, handle), so the console's credential is a
   * pair rather than a triple. `@yousef` and `yousef` are the same person: the
   * API lowercases and strips the '@' at the boundary, and the console sends
   * whatever was typed.
   */
  username: string;
  password: string;
}

/** `POST /auth/platform/session`, verbatim. `expiresAt` is the REFRESH expiry. */
interface PlatformSessionResponse {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  admin: unknown;
}

/**
 * Console sign-in.
 *
 * The mirror of `signIn` above, and separate rather than parameterised: the two
 * endpoints take different credentials, return different bodies, and mint
 * sessions with different shapes. A single function with `if (scope === 'owner')`
 * branches inside it would be one function pretending to be one thing.
 *
 * THE PASSWORD REACHES HERE AND GOES NO FURTHER — #6. Nothing on `OwnerSession`
 * can hold it.
 *
 * `admin` is PARSED, not trusted. A response that drops `sections` fails here,
 * at sign-in, instead of rendering a console whose sidebar is empty because
 * every gate read `undefined`. `parsePlatformAdmin` returns null rather than
 * throwing so this becomes a sentence in the form.
 */
export async function signInToConsole(credentials: ConsoleCredentials): Promise<OwnerSession> {
  const result = await request<PlatformSessionResponse>('/auth/platform/session', {
    method: 'POST',
    body: { username: credentials.username, password: credentials.password },
  });

  const admin = parsePlatformAdmin(result.admin);
  if (!admin) {
    throw new ApiError(
      "Signed in, but the console couldn't read your account. Tell AVO — this is a server problem, not your password.",
      { status: 500, code: 'unreadable_admin' },
    );
  }

  return {
    scope: 'owner',
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    refreshExpiresAt: result.expiresAt,
    adminId: admin.id,
    username: admin.handle,
    displayName: admin.name,
    role: admin.role,
    owner: admin.owner,
    sections: admin.sections,
  };
}
