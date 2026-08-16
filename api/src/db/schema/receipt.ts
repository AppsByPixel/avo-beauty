/**
 * Receipt outbox — step 6 of api-contract.md § Charging, "queues the WhatsApp
 * receipt".
 *
 * The word that matters is *queues*. The charge transaction inserts a row here
 * and commits; a worker picks it up afterwards and talks to WhatsApp. The
 * external call is never awaited inside the transaction, and that is not a
 * performance preference:
 *
 *   - an HTTP call inside an open transaction holds row locks on the member and
 *     the wallet token for the length of someone else's timeout;
 *   - if the provider is slow the charge transaction is what breaks, so a
 *     WhatsApp outage becomes a card-declined-at-the-counter outage;
 *   - and if the call succeeds but the transaction then rolls back, the customer
 *     has a receipt for a charge that never happened.
 *
 * Writing the intent to send in the SAME transaction as the debit is what makes
 * "the receipt is queued if and only if the money moved" true. This is the
 * transactional-outbox pattern, and it is the reason non-negotiable #3 can list
 * the receipt queue among the all-or-nothing steps without dragging a third
 * party into the money path.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from './_shared';
import { member } from './member';
import { transaction } from './transaction';

export const receiptChannel = pgEnum('receipt_channel', ['whatsapp', 'email']);

export const receiptStatus = pgEnum('receipt_status', ['queued', 'sending', 'sent', 'failed']);

export const receiptJob = pgTable(
  'receipt_job',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * One receipt per transaction. The unique index is what makes an idempotent
     * replay of a charge queue ONE receipt rather than a second one — Lane D's
     * "a double submit queues ONE WhatsApp receipt" case.
     */
    transactionId: text('transaction_id')
      .notNull()
      .unique()
      .references(() => transaction.id, { onDelete: 'restrict' }),
    memberId: text('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'restrict' }),

    channel: receiptChannel('channel').notNull(),
    status: receiptStatus('status').notNull().default('queued'),

    /** The rendered payload, frozen at charge time so a later price edit cannot rewrite history. */
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),

    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
    /** Backoff. The worker claims rows where `available_at <= now()`. */
    availableAt: timestamptz('available_at').notNull().defaultNow(),
    sentAt: timestamptz('sent_at'),
  },
  (t) => [
    // The worker's claim query.
    index('receipt_job_claim_idx')
      .on(t.availableAt)
      .where(sql`status IN ('queued', 'failed')`),
    check('receipt_job_attempts_non_negative', sql`${t.attempts} >= 0`),
    check('receipt_job_sent_at_matches_status', sql`(${t.status} = 'sent') = (${t.sentAt} IS NOT NULL)`),
  ],
);
