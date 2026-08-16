/**
 * Session lifecycle: issue, refresh, revoke.
 *
 * The one behaviour worth reading closely is `revokeOtherSessions`. Rule 4 of
 * api-contract.md § Profile edit says a password change "revokes every other
 * session while keeping the calling device signed in". Both halves matter:
 *
 *   - revoking the others is the security event — if the password changed
 *     because it leaked, every device the attacker holds must drop;
 *   - keeping the caller is the usability half. Signing the user out of the
 *     device she is holding, immediately after she did the responsible thing,
 *     teaches her not to do it again.
 *
 * That is why revocation is a per-row `revoked_at` and not a `tokens_valid_after`
 * watermark on the account: a watermark cannot express "all but this one".
 */

import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { session } from '../db/schema/session';
import { env } from '../env';
import {
  hashRefreshToken,
  mintRefreshToken,
  signAccessToken,
  type PrincipalKind,
  type SessionScope,
} from './tokens';

export interface IssueSessionInput {
  principalKind: PrincipalKind;
  memberId?: string | null;
  staffId?: string | null;
  salonId: string;
  scope: SessionScope;
  deviceId?: string | null;
  userAgent?: string | null;
  ipAddress?: string | null;
}

export interface IssuedSession {
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

export async function issueSession(db: Db, input: IssueSessionInput): Promise<IssuedSession> {
  const refreshToken = mintRefreshToken();
  const expiresAt = new Date(Date.now() + env.refreshTokenTtlDays * 86_400_000);

  const [row] = await db
    .insert(session)
    .values({
      principalKind: input.principalKind,
      memberId: input.memberId ?? null,
      staffId: input.staffId ?? null,
      salonId: input.salonId,
      scope: input.scope,
      refreshTokenHash: hashRefreshToken(refreshToken),
      deviceId: input.deviceId ?? null,
      userAgent: input.userAgent ?? null,
      ipAddress: input.ipAddress ?? null,
      expiresAt,
    })
    .returning({ id: session.id });

  if (!row) throw new Error('session insert returned no row');

  const accessToken = await signAccessToken({
    sub: input.principalKind === 'member' ? input.memberId! : input.staffId!,
    kind: input.principalKind,
    scope: input.scope,
    salonId: input.salonId,
    sid: row.id,
  });

  return { sessionId: row.id, accessToken, refreshToken, expiresAt };
}

/**
 * Exchange a refresh token for a new pair, rotating the stored hash.
 *
 * The UPDATE is conditional on the row still being live and still holding the
 * hash we matched, so two concurrent refreshes with the same token cannot both
 * succeed — the same conditional-update mechanism the wallet token uses. The
 * loser gets null and must sign in again, which is the correct outcome for what
 * is, from the server's side, indistinguishable from a replayed stolen token.
 */
export async function rotateSession(
  db: Db,
  rawRefreshToken: string,
): Promise<(IssuedSession & { scope: SessionScope; principalKind: PrincipalKind; principalId: string; salonId: string }) | null> {
  const presentedHash = hashRefreshToken(rawRefreshToken);
  const nextToken = mintRefreshToken();
  const expiresAt = new Date(Date.now() + env.refreshTokenTtlDays * 86_400_000);

  const rows = await db
    .update(session)
    .set({
      refreshTokenHash: hashRefreshToken(nextToken),
      lastUsedAt: new Date(),
      expiresAt,
    })
    .where(
      and(
        eq(session.refreshTokenHash, presentedHash),
        isNull(session.revokedAt),
        sql`${session.expiresAt} > now()`,
      ),
    )
    .returning({
      id: session.id,
      principalKind: session.principalKind,
      memberId: session.memberId,
      staffId: session.staffId,
      salonId: session.salonId,
      scope: session.scope,
    });

  const row = rows[0];
  if (!row) return null;

  const principalId = row.principalKind === 'member' ? row.memberId! : row.staffId!;
  const accessToken = await signAccessToken({
    sub: principalId,
    kind: row.principalKind,
    scope: row.scope,
    salonId: row.salonId,
    sid: row.id,
  });

  return {
    sessionId: row.id,
    accessToken,
    refreshToken: nextToken,
    expiresAt,
    scope: row.scope,
    principalKind: row.principalKind,
    principalId,
    salonId: row.salonId,
  };
}

/** Sign out one device. */
export async function revokeSession(db: Db, sessionId: string, reason: string): Promise<void> {
  await db
    .update(session)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(session.id, sessionId), isNull(session.revokedAt)));
}

/**
 * The password-change revoke: everything for this principal EXCEPT the caller.
 * Returns how many sessions dropped, which the audit row records.
 */
export async function revokeOtherSessions(
  db: Db,
  principal: { kind: PrincipalKind; id: string },
  keepSessionId: string,
  reason: string,
): Promise<number> {
  const owner =
    principal.kind === 'member'
      ? eq(session.memberId, principal.id)
      : eq(session.staffId, principal.id);

  const rows = await db
    .update(session)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(owner, ne(session.id, keepSessionId), isNull(session.revokedAt)))
    .returning({ id: session.id });

  return rows.length;
}

/** Every session for a principal — used when a PIN locks out. */
export async function revokeAllSessions(
  db: Db,
  principal: { kind: PrincipalKind; id: string },
  reason: string,
): Promise<number> {
  const owner =
    principal.kind === 'member'
      ? eq(session.memberId, principal.id)
      : eq(session.staffId, principal.id);

  const rows = await db
    .update(session)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(owner, isNull(session.revokedAt)))
    .returning({ id: session.id });

  return rows.length;
}

/** Is this session still usable? Checked on every authenticated request. */
export async function sessionIsLive(db: Db, sessionId: string): Promise<boolean> {
  const rows = await db
    .select({ id: session.id })
    .from(session)
    .where(and(eq(session.id, sessionId), isNull(session.revokedAt), sql`${session.expiresAt} > now()`))
    .limit(1);
  return rows.length > 0;
}
