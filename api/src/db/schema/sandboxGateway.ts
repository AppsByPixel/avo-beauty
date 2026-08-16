/**
 * The sandbox PSP's own database. NOT part of the product.
 *
 * CBK/PSP selection is a client decision (CLAUDE.md § Escalate, don't guess), so
 * the gateway sits behind `PaymentGateway` with a sandbox driver underneath.
 * This table is that driver's storage: it stands in for the processor's records,
 * the ones a real adapter would reach over HTTPS.
 *
 * It is a table rather than a Map for the same reason the idempotency key is a
 * row: an in-memory gateway is only single-instance-correct, and "the balance
 * moved once across two API instances" is precisely what this work has to prove.
 * A `Map` would make every concurrency demonstration below a property of running
 * one process.
 *
 * Nothing in `api/src` reads this table except `gateway/sandbox.ts`. When a real
 * processor is chosen, that adapter is replaced, `GATEWAY_DRIVER` changes, and
 * this table stops being written — no other file moves. env.ts refuses the
 * sandbox driver in production.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text } from 'drizzle-orm/pg-core';
import { filsColumn, timestamptz } from './_shared';

export const sandboxGatewayPayment = pgTable(
  'sandbox_gateway_payment',
  {
    /** What the driver hands back as `pspReference`. */
    pspReference: text('psp_reference').primaryKey(),
    /** Soft reference — a real PSP holds our id as opaque metadata, not an FK. */
    intentId: text('intent_id').notNull(),

    amountFils: filsColumn('amount_fils').notNull(),
    method: text('method').notNull(),

    /**
     * What this payment will report when read, and what it will call back with.
     *
     * Defaults to `succeeded`: the sandbox assumes the customer completed the
     * hosted page. Driven to anything else by the sandbox hosted page
     * (`POST /_gateway/:ref`) or by an `x-avo-scenario` hint, so all five
     * outcomes are reachable on demand.
     */
    outcome: text('outcome').notNull().default('succeeded'),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('sandbox_gateway_payment_intent_idx').on(t.intentId),
    check(
      'sandbox_gateway_payment_outcome_known',
      sql`${t.outcome} IN ('succeeded', 'declined', 'cancelled', 'pending', 'gateway_error')`,
    ),
  ],
);
