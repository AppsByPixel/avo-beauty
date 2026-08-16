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
import { walletToken } from '../db/schema/walletToken';
import { hashWalletToken, mintWalletTokenValue } from '../auth/tokens';
import { tokenConsumedOrUnknown, tokenExpired } from '../http/errors';
import type { Executor } from './audit';

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
  expiresAt: Date;
}

/**
 * Resolve a token WITHOUT consuming it.
 *
 * `POST /scans` uses this, which is why re-reading a QR before the artist
 * confirms does not burn it — api-contract.md § Charging puts consumption at the
 * charge, not the scan. The charge handler also uses it, to fail fast on a code
 * that was never going to work.
 *
 * The two 410s are distinguished on purpose: "already used" and "expired" send
 * the customer to different actions in the scanner copy.
 */
export async function peekToken(db: Db, rawToken: string): Promise<PeekedToken> {
  const rows = await db
    .select({
      id: walletToken.id,
      memberId: walletToken.memberId,
      expiresAt: walletToken.expiresAt,
      consumedAt: walletToken.consumedAt,
    })
    .from(walletToken)
    .where(eq(walletToken.tokenHash, hashWalletToken(rawToken)))
    .orderBy(desc(walletToken.issuedAt))
    .limit(1);

  const row = rows[0];
  // An unknown hash and a consumed one are the same answer on purpose: telling a
  // caller "that token existed once" is a probe into another customer's wallet.
  if (!row || row.consumedAt !== null) throw tokenConsumedOrUnknown();
  if (row.expiresAt.getTime() <= Date.now()) throw tokenExpired();

  return { id: row.id, memberId: row.memberId, expiresAt: row.expiresAt };
}

/**
 * Consume the token. Call this INSIDE the charge transaction, AFTER the debit.
 *
 * Returns the member id on success. Zero rows updated throws the 410 — and
 * because the caller is inside a transaction, that throw rolls the debit back
 * with it, so the loser of a race leaves nothing behind.
 */
export async function consumeToken(
  exec: Executor,
  rawToken: string,
  consumedBy: { staffId: string | null; transactionId: string },
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
      ),
    )
    .returning({ memberId: walletToken.memberId });

  const row = rows[0];
  if (!row) throw tokenConsumedOrUnknown();
  return row.memberId;
}
