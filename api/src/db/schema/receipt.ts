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
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { timestamptz } from './_shared';
import { member } from './member';
import { transaction } from './transaction';

export const receiptChannel = pgEnum('receipt_channel', ['whatsapp', 'email']);

export const receiptStatus = pgEnum('receipt_status', ['queued', 'sending', 'sent', 'failed']);

export const receiptJob = pgTable(
  'receipt_job',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    transactionId: text('transaction_id')
      .notNull()
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
    /**
     * WHY A ROW EXISTS THAT THE MERCHANT DID NOT ASK FOR (migration 0047).
     *
     * NULL means the channel was her choice. `'email_unavailable'` means she
     * chose email-only and the customer has no verified address, so the floor
     * queued WhatsApp instead — see `services/receipts.ts §
     * decideReceiptChannels`.
     *
     * STORED RATHER THAN DERIVED, which is the opposite of the call made for
     * `voucher.status` and the same reasoning read backwards: "WhatsApp queued at
     * a salon with the flag off" is derivable today and stops being derivable
     * the moment she turns WhatsApp back on, at which point every historical
     * fallback becomes indistinguishable from a chosen send. A fact that decays
     * is a fact to store.
     */
    fallbackReason: text('fallback_reason'),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
    /** Backoff. The worker claims rows where `available_at <= now()`. */
    availableAt: timestamptz('available_at').notNull().defaultNow(),
    sentAt: timestamptz('sent_at'),
  },
  (t) => [
    /**
     * ONE ROW PER TRANSACTION *PER CHANNEL*, and the second half of that is the
     * whole point.
     *
     * It was `UNIQUE (transaction_id)`, which reads as "one receipt per
     * transaction" and is the natural thing to write. It is also a rule that
     * makes build-plan.md phase 2 unsatisfiable: "a receipt email AND a
     * WhatsApp receipt arrive for every settled payment" needs two rows, and
     * the constraint permitted one. The charge path queued WhatsApp and email
     * silently had nowhere to go.
     *
     * With the channel in the key the two are separate jobs. They queue
     * independently, the worker retries them independently, and a WhatsApp
     * provider outage cannot stop the email — the same isolation
     * whatsapp-templates.md already demands between a failed send and the
     * transaction that triggered it, applied one level out, between channels.
     *
     * It still does the job it was doing before. An idempotent replay of a
     * charge re-runs this insert with the same `transaction_id` and the same
     * `channel`, and the constraint refuses it, so Lane D's "a double submit
     * queues ONE WhatsApp receipt" holds exactly as it did — one per channel is
     * still one WhatsApp receipt.
     */
    uniqueIndex('receipt_job_transaction_channel_uq').on(t.transactionId, t.channel),
    /**
     * The worker's claim query.
     *
     * `sending` is in the predicate, and that is the crash-recovery half of the
     * claim. `available_at` doubles as a LEASE: taking a job pushes it forward,
     * so a worker that dies mid-send leaves a row in `sending` whose lease
     * eventually expires and which this index then finds again. Without
     * `sending` here the claim would either strand those rows for ever or fall
     * back to a sequential scan to rescue them — and a stranded `sending` row is
     * the failure mode that makes people distrust outbox tables.
     * See services/receiptWorker.ts.
     */
    index('receipt_job_claim_idx')
      .on(t.availableAt)
      .where(sql`status IN ('queued', 'failed', 'sending')`),
    check('receipt_job_attempts_non_negative', sql`${t.attempts} >= 0`),
    check('receipt_job_sent_at_matches_status', sql`(${t.status} = 'sent') = (${t.sentAt} IS NOT NULL)`),
  ],
);
