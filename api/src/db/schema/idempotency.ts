/**
 * Idempotency keys — non-negotiable #4: every money-moving POST carries one.
 * Top-ups, charges, orders, voids.
 *
 * The whole design is one table with one unique index, and that is deliberate.
 * The key row is written by the SAME transaction as the effect it guards:
 *
 *   BEGIN;
 *     INSERT INTO idempotency_key (scope, key, endpoint, request_hash, status)
 *       VALUES (…, 'in_progress');            -- unique index resolves the race
 *     …consume token, debit wallet, write transaction + ledger + audit…
 *     UPDATE idempotency_key SET status = 'succeeded', response_status = 200,
 *            response_body = …, transaction_id = …  WHERE id = …;
 *   COMMIT;
 *
 * Because the key lives in the same database as the money, there is no window in
 * which the effect committed and the key did not, or the reverse. A key stored
 * in Redis, or written on its own connection, has exactly that window — and it
 * opens precisely during the gateway retry storm it was meant to survive.
 *
 * The concurrency contract:
 *   - a second request with the same (scope, key) hits the unique index and
 *     blocks until the first transaction commits or rolls back;
 *   - if it committed, the retry reads `status`/`response_body` and replays the
 *     stored response byte-for-byte, without touching money again;
 *   - if it rolled back, the row is gone and the retry proceeds normally.
 *
 * `request_hash` catches the other failure: the same key reused for a *different*
 * body. That is a client bug, and replaying the first response would hide a lost
 * charge — the handler returns 422 instead.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgEnum, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from './_shared';
import { transaction } from './transaction';

export const idempotencyStatus = pgEnum('idempotency_status', [
  'in_progress',
  'succeeded',
  'failed',
]);

export const idempotencyKey = pgTable(
  'idempotency_key',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * Who the key belongs to: 'member:8842', 'staff:ST-2'. Scoping stops one
     * client's key from colliding with another's — keys are client-chosen and
     * "1" is a popular choice.
     */
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    /** 'POST /charges'. A key is only valid for the endpoint that first used it. */
    endpoint: text('endpoint').notNull(),
    /** sha256 of the canonical request body. Same key + different body = 422. */
    requestHash: text('request_hash').notNull(),

    status: idempotencyStatus('status').notNull().default('in_progress'),
    /** The stored response, replayed verbatim on retry. */
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    /** The effect this key guarded, when there was one. */
    transactionId: text('transaction_id').references(() => transaction.id, {
      onDelete: 'restrict',
    }),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
    completedAt: timestamptz('completed_at'),
    /** Retention window. A key outlives every plausible gateway retry, then goes. */
    expiresAt: timestamptz('expires_at')
      .notNull()
      .default(sql`now() + interval '24 hours'`),
  },
  (t) => [
    // The race resolver. Everything above depends on this one index.
    uniqueIndex('idempotency_key_scope_key_uq').on(t.scope, t.key),
    index('idempotency_key_expires_idx').on(t.expiresAt),
    index('idempotency_key_transaction_idx').on(t.transactionId),

    // A finished key that cannot replay its response is not idempotent.
    check(
      'idempotency_key_completed_has_response',
      sql`${t.status} = 'in_progress'
          OR (${t.responseStatus} IS NOT NULL AND ${t.responseBody} IS NOT NULL
              AND ${t.completedAt} IS NOT NULL)`,
    ),
    check('idempotency_key_expires_after_creation', sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);
