/**
 * Tokens. Two kinds, with deliberately different properties.
 *
 * ACCESS TOKEN — a short-lived signed JWT. Stateless, so verifying it costs no
 * database round trip. It carries WHO and WHICH SCOPE, and pointedly NOT what
 * they may do: permissions are read from `staff_user` on every request (see
 * principal.ts). Putting perms in the token would mean a revoked `charges`
 * stays live until the token expires, and non-negotiable #7 does not have an
 * "within fifteen minutes" clause.
 *
 * REFRESH TOKEN — opaque random bytes, stored as a sha256 in `session`. Not a
 * JWT, because the whole point is revocability and a JWT is only revocable by
 * keeping a list, at which point the JWT is doing nothing. Rotated on every use:
 * a refresh token is single-use, so a stolen one either stops working (the
 * victim refreshed first) or is detectable (the victim's next refresh fails).
 *
 * The session id rides in the access token as `sid`. That is what lets
 * `POST /members/me/password` revoke every OTHER session and keep the caller
 * signed in — api-contract.md § Profile edit rule 4.
 */

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { env } from '../env';

export type PrincipalKind = 'member' | 'staff' | 'platform_admin';
export type SessionScope = 'wallet' | 'scanner' | 'dashboard' | 'platform';

export interface AccessClaims {
  /** Principal id — a member id, a staff id, or a platform admin id. */
  sub: string;
  kind: PrincipalKind;
  scope: SessionScope;
  /**
   * NULL FOR A PLATFORM ADMIN, AND FOR NOBODY ELSE.
   *
   * The owner console is the one credential that reads across salons by design,
   * so it is scoped to none of them — `session_salon_matches_principal` says the
   * same thing in the database, as an equivalence. A platform token carrying a
   * salon id would be a merchant token with extra authority, which is precisely
   * the confusion the console must not be; and a merchant token with a NULL salon
   * would slip past `requireSameSalon` by having nothing to compare, which is why
   * `verifyAccessToken` refuses that combination rather than defaulting it.
   */
  salonId: string | null;
  /** Session id, so a specific device can be spared a global revoke. */
  sid: string;
}

const secretKey = new TextEncoder().encode(env.jwtSecret);
const ISSUER = 'avo.api';
const AUDIENCE = 'avo.clients';

export async function signAccessToken(claims: AccessClaims): Promise<string> {
  return new SignJWT({
    kind: claims.kind,
    scope: claims.scope,
    // `null`, explicitly, for a platform admin. Omitting the key would be
    // indistinguishable at verification time from a token minted before the
    // claim existed, and this is the claim the tenancy boundary reads.
    salonId: claims.salonId,
    sid: claims.sid,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${env.accessTokenTtlMinutes}m`)
    .sign(secretKey);
}

/** Null on anything wrong: bad signature, wrong issuer, expired, malformed. */
export async function verifyAccessToken(token: string): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    });

    const { sub } = payload;
    const kind = payload.kind as PrincipalKind | undefined;
    const scope = payload.scope as SessionScope | undefined;
    const rawSalonId = payload.salonId;
    const sid = payload.sid as string | undefined;

    if (!sub || !kind || !scope || !sid) return null;
    if (kind !== 'member' && kind !== 'staff' && kind !== 'platform_admin') return null;
    if (scope !== 'wallet' && scope !== 'scanner' && scope !== 'dashboard' && scope !== 'platform') {
      return null;
    }

    /**
     * THE SCOPE MUST MATCH THE KIND, IN THE TOKEN AS WELL AS IN THE ROW.
     *
     * `session_scope_matches_principal` enforces this on the row, and the row is
     * checked on every request through `sessionIsLive` — but only for LIVENESS,
     * not for shape. A token is a separate assertion, and if this function
     * accepted `{ kind: 'staff', scope: 'platform' }` then anything gating on the
     * scope alone would be reachable by a merchant credential. The two statements
     * have to agree, so both are made.
     */
    if (kind === 'platform_admin' ? scope !== 'platform' : scope === 'platform') return null;

    /**
     * A platform token has NO salon and every other token has one — refused in
     * both directions rather than defaulted. See `AccessClaims.salonId`.
     */
    if (kind === 'platform_admin') {
      if (rawSalonId !== null && rawSalonId !== undefined) return null;
      return { sub, kind, scope, salonId: null, sid };
    }
    if (typeof rawSalonId !== 'string' || rawSalonId === '') return null;

    return { sub, kind, scope, salonId: rawSalonId, sid };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ refresh side --

/** 32 bytes of CSPRNG, base64url. Never derived from anything guessable. */
export function mintRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * sha256, not argon2. A refresh token is 256 bits of random already, so there
 * is no low-entropy space to slow an attacker down through — the only job is to
 * stop a database reader from replaying the raw value, and a fast digest does
 * that. Using argon2 here would add real latency to every refresh for nothing.
 */
export function hashRefreshToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Constant-time compare for two hex digests of equal length. */
export function digestsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

/** sha256 of a wallet token. Same reasoning as the refresh token. */
export function hashWalletToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** The QR payload itself. 45s of life, so 128 bits of randomness is ample. */
export function mintWalletTokenValue(): string {
  return `tok_${randomBytes(16).toString('base64url')}`;
}

/**
 * A staff password-reset token. 32 bytes, like the refresh token, because it is
 * the same kind of secret: an opaque bearer value that grants a credential
 * change to whoever holds it.
 *
 * Non-negotiable #6 — "Owner console only ever sends a reset link" — is why this
 * is minted rather than a password being chosen for somebody. It is returned by
 * NO endpoint; it exists in the row as a sha256 and in the message the staff
 * member receives.
 */
export function mintPasswordResetToken(): string {
  return `rst_${randomBytes(32).toString('base64url')}`;
}

/** sha256 of a reset token. Same reasoning as the refresh token. */
export function hashPasswordResetToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** sha256 of a canonical request body — the "same key, different body" check. */
export function hashRequestBody(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
}

// ------------------------------------------------------------ staff pairing --
// Aftab, 2026-11-10 (DECISIONS.md § Staff phone pairing); migration 0073.

/**
 * The QR's token. 32 bytes of CSPRNG, like the refresh token and the reset
 * token, because it is the same kind of secret: an opaque single-use bearer
 * value that grants a credential to whoever holds it first.
 *
 * base64url, so it sits in `${STAFF_PAIRING_URL}?t=${token}` with no escaping.
 * The `pair_` prefix is for a human reading a log line, as `rst_` is; it makes
 * the value 48 characters, comfortably over the contract's 32.
 *
 * Returned ONCE, by `POST /staff/{id}/pairing-code`, to the manager who must
 * show it as a QR — the one place a credential in transit is the point. Stored
 * as a sha256 and nowhere else.
 */
export function mintPairingToken(): string {
  return `pair_${randomBytes(32).toString('base64url')}`;
}

/** sha256 of a pairing token. Same reasoning as the refresh token. */
export function hashPairingToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * The six digits typed with a mobile number when the camera will not cooperate.
 * `randomInt` is the CSPRNG and is uniform over the range — no modulo bias.
 * Leading zeros are kept: "004213" is a valid code, and the contract is six
 * digits, not a number. Hashed with argon2id by the caller, never sha256.
 */
export function mintPairingDigits(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** The prefix `mintPairedDeviceId` puts on every id it issues. */
export const PAIRED_DEVICE_ID_PREFIX = 'PH-';

/**
 * The device id a paired phone is bound to. SERVER-ISSUED, which is the change
 * pairing makes to the PIN's device scope: until now the device id was a string
 * the client typed into "Set up this device", so two phones could claim one.
 *
 * Not a secret — the phone sends it in the clear on every PIN sign-in, and the
 * PIN plus the per-device limiter and the lockout are what protect it — but 128
 * bits all the same, so one salon's id cannot be guessed into another's
 * `pin_attempt` bucket.
 */
export function mintPairedDeviceId(): string {
  return `${PAIRED_DEVICE_ID_PREFIX}${randomBytes(16).toString('base64url')}`;
}

/**
 * True for a device id THIS SERVER minted for a paired phone.
 *
 * Read against `staff_user.pin_device_id` only, where it is a fact rather than a
 * guess: that column is written by `POST /staff/pair` (this mint) and by
 * `db/seed.ts` (`DEV-SCANNER-01`), and by nothing a client can reach. So a `PH-`
 * there is a phone one person was paired onto; anything else is a till somebody
 * typed, which may be the counter's shared tablet. NOT a test to apply to a
 * `device_enrolment.device_id` or a request body — `POST /salons/:id/devices`
 * takes whatever string a manager types, `PH-` included.
 */
export function isServerIssuedDeviceId(deviceId: string | null | undefined): deviceId is string {
  return typeof deviceId === 'string' && deviceId.startsWith(PAIRED_DEVICE_ID_PREFIX);
}
