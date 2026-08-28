/**
 * The wallet token: mint, peek, consume.
 *
 * The split between `peekToken` and `consumeToken` is the whole point of this
 * module, and it is Lane D's first finding written as code.
 *
 * THE BUG BEING DESIGNED OUT
 * --------------------------
 * The mock consumed the token before checking the balance. So a 402 burned the
 * customer's QR: she tops up at the counter, the artist rescans, and the same
 * code is dead — after a failure that was never her fault. Non-negotiable #3
 * says if the debit fails, NOTHING else happened. A consumed token is something
 * that happened.
 *
 * So the charge handler calls `peekToken` early (to refuse an unknown or expired
 * code before doing any work) and `consumeToken` late — after the debit has
 * succeeded, inside the same transaction.
 *
 * WHY CONSUMPTION IS A CONDITIONAL UPDATE
 * ---------------------------------------
 * `consumeToken` is one statement:
 *
 *   UPDATE wallet_token SET consumed_at = now(), …
 *    WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
 *   RETURNING member_id
 *
 * and it is the row count that decides the outcome. Zero rows is the 410.
 *
 * A read-then-write cannot do this. Two scanners racing the same code both read
 * `consumed_at IS NULL`, both decide they may proceed, and both debit. With the
 * conditional UPDATE the second statement blocks on the row lock the first
 * holds; when the first commits, the second re-evaluates its WHERE against the
 * committed row, matches nothing, and returns zero rows. Exactly one charge
 * settles. That is a property of the statement, not of how fast the two requests
 * happen to arrive — which is what Lane D meant by "the mock wins this by
 * accident".
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { member } from '../db/schema/member';
import { walletToken } from '../db/schema/walletToken';
import { hashWalletToken, mintWalletTokenValue } from '../auth/tokens';
import { ApiError, tokenConsumedOrUnknown, tokenExpired } from '../http/errors';
import type { Executor } from './audit';

/**
 * WHO IS ALLOWED TO RESOLVE A TOKEN — the salon it was minted in, and no other.
 *
 * A wallet token is a bearer credential: whoever holds the string can turn it
 * into a member. Resolving it by hash alone made `POST /scans` a cross-tenant
 * read — a scanner at salon B, on a legitimate device-bound PIN session, could
 * submit a QR minted for salon A's customer and receive her name, phone, email,
 * balance, tier and visit count. The route scoped the SERVICES it returned to
 * the caller's salon two lines below, which is what made the hole so easy to
 * miss: the response looked salon-scoped.
 *
 * The scope is therefore a REQUIRED argument here rather than a check each
 * caller remembers. A future handler that resolves a token cannot forget it:
 * there is no overload that omits it.
 */
export interface TokenScope {
  salonId: string;
}

/**
 * A live token that belongs to another salon.
 *
 * It IS an ApiError carrying `404 unknown_member`, so a caller that does not
 * catch it still refuses correctly and still says the same thing a member that
 * never existed says. That is the safe default, and it is the right answer for
 * `POST /scans`, where the token is the only identifier the caller has.
 *
 * It is a distinct type so that a caller which knows MORE can say something
 * truer. `POST /charges` already named a member of its own salon; telling that
 * scanner "no such member" about the customer standing at the counter is both
 * confusing and false. It catches this and answers `409 token_member_mismatch`
 * — "that code belongs to a different customer" — which is accurate, is the
 * copy the scanner is designed to render, and discloses nothing about the other
 * salon that the holder of the code did not already have.
 */
export class TokenOutsideSalonError extends ApiError {
  constructor() {
    super(404, 'unknown_member', 'No such member.');
    this.name = 'TokenOutsideSalonError';
  }
}

/** 45 seconds, per api-contract.md § WalletToken. The CHECK caps it at 2 minutes. */
export const TOKEN_TTL_SECONDS = 45;

export interface MintedToken {
  memberId: string;
  token: string;
  expiresAt: Date;
}

export async function mintToken(db: Db, memberId: string): Promise<MintedToken> {
  const token = mintWalletTokenValue();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_SECONDS * 1000);

  await db.insert(walletToken).values({
    memberId,
    tokenHash: hashWalletToken(token),
    expiresAt,
  });

  return { memberId, token, expiresAt };
}

export interface PeekedToken {
  id: string;
  memberId: string;
  /** The salon the token's member belongs to. Always the caller's own. */
  salonId: string;
  expiresAt: Date;
}

/**
 * Resolve a token WITHOUT consuming it, INSIDE one salon.
 *
 * `POST /scans` uses this, which is why re-reading a QR before the artist
 * confirms does not burn it — api-contract.md § Charging puts consumption at the
 * charge, not the scan. The charge handler also uses it, to fail fast on a code
 * that was never going to work.
 *
 * The join to `member` is the tenant boundary (see TokenScope above): a token
 * whose member belongs to another salon does not resolve here at all, so no
 * caller can leak the record it points at.
 *
 * WHICH REFUSAL, AND WHY THIS ONE
 * -------------------------------
 * A token from another salon is refused with `404 unknown_member` — the exact
 * error a member that does not exist produces, byte for byte. That is the
 * property the rest of the API already holds and the one Lane D tests for: a
 * foreign record and an absent record must be indistinguishable, or the 404
 * itself becomes a directory of other salons' customers.
 *
 * The alternative — folding it into the 410 alongside "unknown or consumed" —
 * hides one more bit (whether the token string is real anywhere) at the cost of
 * that property. The trade is recorded rather than assumed: 45-second,
 * 128-bit-random tokens are not enumerable, so an attacker learning that a
 * token they ALREADY HOLD belongs elsewhere learns nothing they did not have,
 * whereas a caller learning that a member id exists in another salon does.
 *
 * The unknown / consumed / expired 410s are unchanged: "already used" and
 * "expired" send the customer to different actions in the scanner copy.
 */
/**
 * `Executor`, not `Db`, so this can be called on a transaction handle. `POST
 * /charges` MUST call it on its own `tx`: on the base handle it asks the pool for
 * a second connection while the charge transaction holds one, which deadlocks the
 * API process under a burst. See `charge.ts` § "ON `tx`, NOT ON `db`".
 */
export async function peekToken(
  db: Executor,
  rawToken: string,
  scope: TokenScope,
): Promise<PeekedToken> {
  const rows = await db
    .select({
      id: walletToken.id,
      memberId: walletToken.memberId,
      salonId: member.salonId,
      expiresAt: walletToken.expiresAt,
      consumedAt: walletToken.consumedAt,
    })
    .from(walletToken)
    .innerJoin(member, eq(member.id, walletToken.memberId))
    .where(eq(walletToken.tokenHash, hashWalletToken(rawToken)))
    .orderBy(desc(walletToken.issuedAt))
    .limit(1);

  const row = rows[0];
  // An unknown hash and a consumed one are the same answer on purpose: telling a
  // caller "that token existed once" is a probe into another customer's wallet.
  if (!row || row.consumedAt !== null) throw tokenConsumedOrUnknown();

  // THE tenant boundary. Checked here, in the resolver, so that a handler cannot
  // reach a member record by presenting a token — which is exactly how
  // POST /scans leaked one salon's customer to another salon's scanner.
  if (row.salonId !== scope.salonId) throw new TokenOutsideSalonError();

  if (row.expiresAt.getTime() <= Date.now()) throw tokenExpired();

  return { id: row.id, memberId: row.memberId, salonId: row.salonId, expiresAt: row.expiresAt };
}

/**
 * Consume the token. Call this INSIDE the charge transaction, AFTER the debit.
 *
 * Returns the member id on success. Zero rows updated throws the 410 — and
 * because the caller is inside a transaction, that throw rolls the debit back
 * with it, so the loser of a race leaves nothing behind.
 *
 * The salon predicate is part of the WHERE rather than a check around it, for
 * the same reason the consumed/expired predicates are: it has to be evaluated
 * against the committed row at the moment of the update, not against something
 * a caller read a few statements earlier.
 */
export async function consumeToken(
  exec: Executor,
  rawToken: string,
  consumedBy: { staffId: string | null; transactionId: string },
  scope: TokenScope,
): Promise<string> {
  const rows = await exec
    .update(walletToken)
    .set({
      consumedAt: new Date(),
      consumedByStaffId: consumedBy.staffId,
      consumedByTransactionId: consumedBy.transactionId,
    })
    .where(
      and(
        eq(walletToken.tokenHash, hashWalletToken(rawToken)),
        isNull(walletToken.consumedAt),
        sql`${walletToken.expiresAt} > now()`,
        // The tenant boundary again. A token cannot be spent outside the salon
        // that minted it even if something above this line went wrong.
        sql`EXISTS (SELECT 1 FROM ${member} WHERE ${member.id} = ${walletToken.memberId}
                    AND ${member.salonId} = ${scope.salonId})`,
      ),
    )
    .returning({ memberId: walletToken.memberId });

  const row = rows[0];
  if (!row) throw tokenConsumedOrUnknown();
  return row.memberId;
}
