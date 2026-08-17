/**
 * Idempotency — non-negotiable #4, and one of the two real concurrency
 * mechanisms Lane D said the mock could not demonstrate.
 *
 * WHAT THE MOCK DID, AND WHY IT DOES NOT TRANSFER
 * ----------------------------------------------
 * `if (map.has(key)) return map.get(key); … map.set(key, result)` is a
 * check-then-act. It survives Lane D's parallel spec only because a single Node
 * process cannot interleave the two synchronous halves. Two API instances behind
 * a load balancer — or one instance with an `await` between the check and the
 * set, which the real handler necessarily has — race it, and a double-tapped
 * scanner debits twice.
 *
 * WHAT THIS DOES INSTEAD
 * ----------------------
 * The key is a ROW, inserted INSIDE the same transaction as the effect, guarded
 * by `UNIQUE (scope, endpoint, key)`. The database resolves the race:
 *
 *   - the second inserter blocks on the unique index until the first commits;
 *   - if the first committed, the second gets a unique violation, the whole
 *     transaction rolls back, and the stored response is replayed;
 *   - if the first rolled back, its key row vanished with it and the second
 *     proceeds normally.
 *
 * That last property is what makes a failed charge NOT burn its key. The 402
 * path rolls the transaction back, so the scanner can retry the same attempt
 * after the customer tops up. Caching the 402 against the key would answer that
 * retry with a stale refusal forever — Lane D's "a failed charge does not burn
 * its idempotency key".
 *
 * SCOPING — the second Lane D finding. The unique index covers `endpoint`, so a
 * key minted on POST /topups is invisible to POST /charges. `scope` is the
 * principal ('member:8842', 'staff:ST-002'), because keys are client-chosen and
 * "1" is a popular choice.
 */

import { and, eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { idempotencyKey } from '../db/schema/idempotency';
import type { Principal } from '../auth/principal';
import { hashRequestBody } from '../auth/tokens';
import { idempotencyKeyRequired, unprocessable } from '../http/errors';
import type { Db } from '../db/client';
import type { Executor } from './audit';

/** Postgres unique_violation. The signal that another request got there first. */
const UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === UNIQUE_VIOLATION;
}

/**
 * WHICH unique index was violated.
 *
 * `isUniqueViolation` alone is not enough on any path where more than one unique
 * index can fire, and treating them alike produced a real defect: a second void
 * of the same charge violates `transaction_reverses_uq`, but the caller assumed
 * every 23505 was an idempotency-key collision, went looking for the winner's
 * stored response under a key that had never existed, found nothing, and
 * answered `409 request_in_progress` — "still being processed, try again",
 * which is wrong, invites a third attempt, and hides that the charge was already
 * refunded.
 *
 * Postgres puts the index name in `constraint`, so the two cases are
 * distinguishable and the caller has to say which one it means.
 */
export function violatedConstraint(err: unknown): string | null {
  if (!isUniqueViolation(err)) return null;
  return (err as { constraint_name?: string; constraint?: string }).constraint_name
    ?? (err as { constraint?: string }).constraint
    ?? null;
}

/** 'member:8842' / 'staff:ST-002'. One client's key cannot collide with another's. */
export function principalScope(principal: Principal): string {
  return `${principal.kind}:${principal.id}`;
}

export function readIdempotencyKey(req: FastifyRequest): string {
  const raw = req.headers['idempotency-key'];
  const key = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!key) throw idempotencyKeyRequired();
  if (key.length > 255) {
    throw unprocessable('idempotency_key_too_long', 'That Idempotency-Key is too long.');
  }
  return key;
}

export interface StoredResponse {
  status: number;
  body: unknown;
}

/**
 * Claim the key inside `exec` (a transaction). Throws the unique violation
 * upward on a duplicate so the caller can roll back and replay.
 */
export async function claimKey(
  exec: Executor,
  params: { scope: string; endpoint: string; key: string; requestHash: string },
): Promise<string> {
  const [row] = await exec
    .insert(idempotencyKey)
    .values({
      scope: params.scope,
      key: params.key,
      endpoint: params.endpoint,
      requestHash: params.requestHash,
      status: 'in_progress',
    })
    .returning({ id: idempotencyKey.id });

  if (!row) throw new Error('idempotency claim returned no row');
  return row.id;
}

/** Store the response against a claimed key, in the same transaction. */
export async function completeKey(
  exec: Executor,
  id: string,
  response: StoredResponse,
  transactionId?: string | null,
): Promise<void> {
  await exec
    .update(idempotencyKey)
    .set({
      status: 'succeeded',
      responseStatus: response.status,
      responseBody: response.body,
      completedAt: new Date(),
      transactionId: transactionId ?? null,
    })
    .where(eq(idempotencyKey.id, id));
}

/**
 * Read a committed key for replay.
 *
 * A key found with a DIFFERENT request hash is a client bug — the same key
 * reused for a different body. Replaying the first response would hide a lost
 * charge, so that is a 422, per the header comment in db/schema/idempotency.ts.
 *
 * `null` means the row exists but has not committed a response yet, which for a
 * caller that just lost the unique-violation race means the winner is still open.
 */
export async function readCommittedKey(
  db: Db,
  params: { scope: string; endpoint: string; key: string; requestHash: string },
): Promise<StoredResponse | null> {
  const rows = await db
    .select()
    .from(idempotencyKey)
    .where(
      and(
        eq(idempotencyKey.scope, params.scope),
        eq(idempotencyKey.endpoint, params.endpoint),
        eq(idempotencyKey.key, params.key),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  if (row.requestHash !== params.requestHash) {
    throw unprocessable(
      'idempotency_key_reused',
      'That Idempotency-Key was already used for a different request. Use a new key.',
    );
  }

  if (row.status !== 'succeeded' || row.responseStatus === null) return null;
  return { status: row.responseStatus, body: row.responseBody };
}

/**
 * Replay a committed response, waiting briefly for a winner that is still open.
 *
 * The wait exists because the loser of the unique-violation race can reach this
 * point microseconds before the winner commits its response. Rather than answer
 * 409 and make a double-tapped scanner look broken, poll the row for a short
 * window — the winning transaction is a single local commit, so this resolves
 * in milliseconds or not at all.
 */
export async function awaitCommittedKey(
  db: Db,
  params: { scope: string; endpoint: string; key: string; requestHash: string },
  timeoutMs = 5_000,
): Promise<StoredResponse | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const stored = await readCommittedKey(db, params);
    if (stored) return stored;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 25));
  }
}

export { hashRequestBody };
