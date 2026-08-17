/**
 * TopUpIntent and the gateway event log — api-contract.md § TopUpIntent.
 *
 * THE INTENT IS A STATE MACHINE, NOT A STATUS FIELD
 * -------------------------------------------------
 * Four things move a top-up: the client starting it, the gateway's hosted page,
 * the PSP's webhook, and our own authoritative read. They arrive in any order
 * and more than once. If `status` were a column anyone could write, a `pending`
 * callback delivered after a `succeeded` one would walk a settled top-up back to
 * "in flight" and the reconciliation job would then try to settle it again.
 *
 * So the legal transitions are declared once (services/topup.ts), applied as a
 * conditional UPDATE whose row count decides the outcome — the same mechanism
 * services/walletToken.ts uses to make single-use consumption a property of the
 * statement rather than of timing — and backstopped by a BEFORE UPDATE trigger
 * in migration 0004 that raises on an illegal transition whoever attempts it.
 *
 * EXACTLY ONE CREDIT PER INTENT is not left to that discipline either. The
 * CHECK below ties `succeeded` to `transaction_id`, and `transaction_id` is
 * unique. Two credits for one intent would need two transaction rows on one
 * intent, and the index refuses. A duplicate callback cannot double-credit even
 * if every layer above this file is wrong.
 */

import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { fils } from '@avo/types';
import { filsColumn, timestamptz } from './_shared';
import { member } from './member';
import { happyHour } from './promotion';
import { branch, salon } from './salon';
import { paymentMethod, transaction } from './transaction';

/** api-contract.md § TopUpIntent, `status`. */
export const topUpStatus = pgEnum('topup_status', [
  'created',
  'redirected',
  'pending',
  'succeeded',
  'failed',
  'cancelled',
]);

/** api-contract.md § TopUpIntent, `failureReason`. */
export const topUpFailureReason = pgEnum('topup_failure_reason', [
  'declined',
  'expired',
  'cancelled_by_user',
  'gateway_error',
]);

export const topUpIntent = pgTable(
  'topup_intent',
  {
    id: text('id').primaryKey(),

    memberId: text('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'restrict' }),
    salonId: text('salon_id')
      .notNull()
      .references(() => salon.id, { onDelete: 'restrict' }),
    /**
     * Resolved at creation, not at settlement. The branch a top-up is
     * attributed to must not depend on which branch happened to be first in the
     * table on the day the callback landed.
     */
    branchId: text('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),

    /** What the customer pays. */
    amountFils: filsColumn('amount_fils').notNull(),
    /** Merchant-funded TIER bonus. Server-computed; 0 in stamps mode. */
    bonusFils: filsColumn('bonus_fils').notNull().default(fils(0)),
    /**
     * Merchant-funded PROMOTION bonus — a live `topup10`/`topup20` happy hour.
     * Separate from the tier bonus so a settled top-up can be reconciled: both
     * are merchant-funded, but one is owed to a customer's standing and the
     * other to a campaign the merchant chose to run, and one column could never
     * be split back apart. See db/schema/transaction.ts § promo_bonus_fils.
     *
     * LOCKED AT CREATION, like `bonusFils` and for the same reason. A top-up
     * settles minutes after it starts, possibly after the window has closed, and
     * the customer acted on the number she was shown when she tapped Pay. The
     * intent is the promise; settlement credits `creditFils` verbatim.
     */
    promoBonusFils: filsColumn('promo_bonus_fils').notNull().default(fils(0)),
    /** Which window funded `promoBonusFils`. Null when none was live. */
    promotionId: text('promotion_id').references(() => happyHour.id, { onDelete: 'restrict' }),
    /** amountFils + bonusFils + promoBonusFils — what lands in the wallet. */
    creditFils: filsColumn('credit_fils').notNull(),
    /**
     * AVO's commission. Merchant-visible, customer-never: it is recorded here
     * and on `transaction.fee_fils`, and the customer transaction serializer
     * (http/serialise.ts) does not emit it.
     */
    feeFils: filsColumn('fee_fils').notNull().default(fils(0)),

    method: paymentMethod('method').notNull(),

    status: topUpStatus('status').notNull().default('created'),
    failureReason: topUpFailureReason('failure_reason'),

    /** The PSP-hosted page. Absolute, because TopUpIntentSchema requires a URL. */
    redirectUrl: text('redirect_url').notNull().default(''),
    /** Our reference, shown to the customer on failure. */
    reference: text('reference').notNull(),

    /** Which adapter owns this intent — 'sandbox' today, a PSP name later. */
    provider: text('provider').notNull(),
    /**
     * The PSP's identifier for the payment. Null until the gateway has been
     * asked to create one. Unique because it is the key a webhook arrives on.
     */
    pspReference: text('psp_reference'),

    /** The credit this intent produced. Null until, and only until, it settles. */
    transactionId: text('transaction_id').references(() => transaction.id, {
      onDelete: 'restrict',
    }),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    settledAt: timestamptz('settled_at'),
  },
  (t) => [
    index('topup_intent_member_created_idx').on(t.memberId, t.createdAt.desc()),
    index('topup_intent_salon_created_idx').on(t.salonId, t.createdAt.desc()),
    uniqueIndex('topup_intent_psp_reference_uq')
      .on(t.pspReference)
      .where(sql`psp_reference IS NOT NULL`),
    // One credit per intent, as an index rather than as a promise.
    uniqueIndex('topup_intent_transaction_uq')
      .on(t.transactionId)
      .where(sql`transaction_id IS NOT NULL`),
    // The reconciliation job's query: anything not terminal, oldest first.
    index('topup_intent_open_idx')
      .on(t.createdAt)
      .where(sql`status IN ('created', 'redirected', 'pending')`),

    check('topup_intent_amount_positive', sql`${t.amountFils} > 0`),
    check('topup_intent_bonus_non_negative', sql`${t.bonusFils} >= 0`),
    check('topup_intent_promo_bonus_non_negative', sql`${t.promoBonusFils} >= 0`),
    check('topup_intent_fee_non_negative', sql`${t.feeFils} >= 0`),
    // The credit is the amount plus BOTH merchant-funded bonuses. The commission
    // is NOT deducted from it — Lane D asserts exactly this on the intent.
    check(
      'topup_intent_credit_is_amount_plus_bonus',
      sql`${t.creditFils} = ${t.amountFils} + ${t.bonusFils} + ${t.promoBonusFils}`,
    ),
    // 'wallet' is a charge method. A top-up is funded from outside the wallet.
    check('topup_intent_method_is_external', sql`${t.method} <> 'wallet'`),

    // ------------------------------------------------------------------
    // Settlement is all-or-nothing at the row level too: succeeded implies a
    // transaction and a settled_at, and neither can exist without it.
    // ------------------------------------------------------------------
    check(
      'topup_intent_succeeded_has_transaction',
      sql`(${t.status} = 'succeeded') = (${t.transactionId} IS NOT NULL)`,
    ),
    check(
      'topup_intent_succeeded_has_settled_at',
      sql`(${t.status} = 'succeeded') = (${t.settledAt} IS NOT NULL)`,
    ),
    // A failure the customer cannot be given a reason for is a support ticket.
    check(
      'topup_intent_failure_reason_matches_status',
      sql`(${t.status} = 'failed' AND ${t.failureReason} IS NOT NULL)
          OR (${t.status} = 'cancelled' AND ${t.failureReason} IS NOT NULL)
          OR (${t.status} NOT IN ('failed', 'cancelled') AND ${t.failureReason} IS NULL)`,
    ),
  ],
);

/**
 * Every callback the gateway ever delivers, applied or not.
 *
 * `UNIQUE (provider, event_id)` is the duplicate-callback guard, and it is the
 * PSP's event id it keys on — NOT our `Idempotency-Key` header. The PSP owns
 * the retry; our header is not in play on a request we did not make. Lane D's
 * concurrency spec says so in as many words.
 *
 * The row is inserted inside the settling transaction, so "the event was
 * recorded" and "the money moved" commit together or not at all. A duplicate
 * hits the unique index, the whole transaction rolls back, and the handler
 * answers 200 without crediting anything — 200 because a 4xx makes a PSP retry
 * forever.
 *
 * Ignored events are recorded too. An out-of-order `pending` arriving after a
 * `succeeded` is not an error, but it is evidence, and a reconciliation that
 * cannot see what the PSP said is guesswork.
 */
export const gatewayEventOutcome = pgEnum('gateway_event_outcome', [
  'applied',
  'ignored_illegal_transition',
  'ignored_unknown_intent',
  /** The PSP reported an amount we never asked for. Never credit that. */
  'ignored_amount_mismatch',
]);

export const gatewayEvent = pgTable(
  'gateway_event',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    provider: text('provider').notNull(),
    /** The PSP's id for this delivery. The dedupe key. */
    eventId: text('event_id').notNull(),
    pspReference: text('psp_reference').notNull(),

    intentId: text('intent_id').references(() => topUpIntent.id, { onDelete: 'restrict' }),

    /** What the PSP said, verbatim, before our mapping touched it. */
    reportedStatus: text('reported_status').notNull(),
    outcome: gatewayEventOutcome('outcome').notNull(),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),

    receivedAt: timestamptz('received_at').notNull().defaultNow(),
  },
  (t) => [
    // THE duplicate-callback guard.
    uniqueIndex('gateway_event_provider_event_uq').on(t.provider, t.eventId),
    index('gateway_event_psp_reference_idx').on(t.pspReference),
    index('gateway_event_intent_idx').on(t.intentId),
  ],
);
