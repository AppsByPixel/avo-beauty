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

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { env } from '../env';

export type PrincipalKind = 'member' | 'staff';
export type SessionScope = 'wallet' | 'scanner' | 'dashboard';

export interface AccessClaims {
  /** Principal id — a member id or a staff id. */
  sub: string;
  kind: PrincipalKind;
  scope: SessionScope;
  salonId: string;
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
    const salonId = payload.salonId as string | undefined;
    const sid = payload.sid as string | undefined;

    if (!sub || !kind || !scope || !salonId || !sid) return null;
    if (kind !== 'member' && kind !== 'staff') return null;
    if (scope !== 'wallet' && scope !== 'scanner' && scope !== 'dashboard') return null;

    return { sub, kind, scope, salonId, sid };
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
