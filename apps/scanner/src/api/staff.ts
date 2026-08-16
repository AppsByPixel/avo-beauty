/**
 * Staff identity: PIN sign-in and "what may I do".
 *
 * `GET /staff/me` is re-read rather than cached from sign-in, because
 * api-contract.md § StaffUser says so plainly: perms are "set in the merchant
 * dashboard (Accounts → Team) and read by the staff scanner … the client must
 * re-read it on change". A manager granting `charges` mid-shift should not need
 * the stylist to sign out.
 */

import { z } from 'zod';
import { StaffUserSchema } from '@avo/types';
import { getJson, postJson } from './client';

/**
 * Sign-in accepts BOTH server shapes.
 *
 * The real API (api/src/routes/auth.ts § staffPinSession) returns a full
 * session — `accessToken`, `refreshToken`, `expiresAt`. The mock
 * (packages/mock/src/server.ts:371) returns `{ token, staff }`. The scanner has
 * to run against either, so the union is decoded here and normalised below
 * rather than leaking two shapes into the session state.
 */
const RealSessionSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.string(),
  staff: StaffUserSchema,
});

const MockSessionSchema = z.object({
  token: z.string().min(1),
  staff: StaffUserSchema,
});

const SessionSchema = z.union([RealSessionSchema, MockSessionSchema]);

export type StaffUser = z.infer<typeof StaffUserSchema>;
export type StaffPerms = StaffUser['perms'];

export interface StaffSession {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  staff: StaffUser;
}

export interface PinCredentials {
  salonId: string;
  deviceId: string;
  handle: string;
  pin: string;
}

/**
 * `POST /staff/session`.
 *
 * The PIN never touches storage, never gets logged and never leaves this
 * function — non-negotiable #6. Only the minted token is persisted, and it is
 * scoped to `scanner`, so it cannot reach a dashboard endpoint even if it
 * leaked.
 */
export async function signIn(
  credentials: PinCredentials,
  signal?: AbortSignal,
): Promise<StaffSession> {
  const body = await postJson('/staff/session', credentials, SessionSchema, undefined, signal);

  if ('accessToken' in body) {
    return {
      accessToken: body.accessToken,
      refreshToken: body.refreshToken,
      expiresAt: body.expiresAt,
      staff: body.staff,
    };
  }
  return { accessToken: body.token, refreshToken: null, expiresAt: null, staff: body.staff };
}

/** `GET /staff/me` — authority, re-read rather than remembered. */
export function fetchMe(accessToken: string, signal?: AbortSignal): Promise<StaffUser> {
  return getJson('/staff/me', StaffUserSchema, accessToken, signal);
}

/**
 * `GET /staff` — the roster, used only to name who can grant `charges` on the
 * locked screen (design/AVO Staff Scanner.dc.html:290 "Who can see charges
 * here").
 *
 * PERMISSION NOTE, AND WHY THE LOCKED SCREEN DEGRADES INSTEAD OF FAILING.
 * The real API gates this on `perms.team` (api/src/routes/staff.ts:108) — a
 * dashboard permission that the very staff member seeing the locked screen
 * does not have. So for the person who most needs this list, the call 403s.
 * That is the server being right and the design being under-specified, not a
 * bug to route around: the screen renders without the names rather than
 * inventing them, and the gap is reported.
 */
const RosterSchema = z.object({
  items: z.array(StaffUserSchema),
  nextCursor: z.string().nullable(),
});

export async function fetchRoster(
  accessToken: string,
  signal?: AbortSignal,
): Promise<StaffUser[]> {
  const body = await getJson('/staff', RosterSchema, accessToken, signal);
  return body.items;
}
