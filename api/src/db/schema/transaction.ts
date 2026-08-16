/**
 * Transaction — api-contract.md § Transaction.
 *
 * The customer-facing money record: one row per thing that appears in the
 * activity feed. `ledger_entry` is the double-entry backing for the same event;
 * this table is what the wallet and the scanner render.
 *
 * `amount_fils` is signed — credit positive, debit negative — and the sign is
 * constrained per `kind`, so a "charge" that credits the customer cannot be
 * written by a handler with a misplaced minus sign.
 */

import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { fils } from '@avo/types';
import { filsColumn, timestamptz } from './_shared';
import { member } from './member';
import { branch, salon } from './salon';
import { staffUser } from './staff';

export const transactionKind = pgEnum('transaction_kind', [
  'topup',
  'charge',
  'deposit_hold',
  'deposit_return',
  'shop',
  'adjustment',
]);

export const transactionStatus = pgEnum('transaction_status', [
  'pending',
  'settled',
  'failed',
  'cancelled',
]);

export const paymentMethod = pgEnum('payment_method', ['knet', 'card', 'applepay', 'wallet']);

export const transaction = pgTable(
  'transaction',
  {
    id: text('id').primaryKey(),
    memberId: text('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'restrict' }),
    /**
     * Denormalised from the member so salon-scoped reporting and the permission
     * checks on `GET /charges` are one index lookup, not a join through member.
     */
    salonId: text('salon_id')
      .notNull()
      .references(() => salon.id, { onDelete: 'restrict' }),
    /**
     * Not null, to match `TransactionSchema.branchId`. A wallet-originated
     * top-up is attributed to the member's home branch by the handler; the
     * contract has no nullable branch and the clients render it unconditionally.
     */
    branchId: text('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),

    kind: transactionKind('kind').notNull(),
    /** Signed: credit positive, debit negative. */
    amountFils: filsColumn('amount_fils').notNull(),
    /** Tier bonus portion of a top-up. Always 0 in stamps mode. */
    bonusFils: filsColumn('bonus_fils').notNull().default(fils(0)),
    /**
     * AVO's commission on this transaction. build-plan.md phase 2: "commission
     * recorded per transaction, merchant-visible, customer-never". Not part of
     * `TransactionSchema` — the customer serializer must not emit it.
     */
    feeFils: filsColumn('fee_fils').notNull().default(fils(0)),

    method: paymentMethod('method'),
    status: transactionStatus('status').notNull().default('pending'),
    /** Gateway ref, shown to the customer on failure. */
    reference: text('reference').notNull().default(''),
    /** Void reason, adjustment reason. Shown in the audit log detail column. */
    note: text('note'),

    /**
     * A void is a compensating `adjustment` row pointing back at the charge it
     * reverses. The unique index below is what makes "void once" a database
     * fact: a second void of the same charge violates it, whatever two
     * concurrent scanner taps believe.
     */
    reversesTransactionId: text('reverses_transaction_id').references(
      (): AnyPgColumn => transaction.id,
      { onDelete: 'restrict' },
    ),

    createdByStaffId: text('created_by_staff_id').references(() => staffUser.id, {
      onDelete: 'restrict',
    }),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
    settledAt: timestamptz('settled_at'),
  },
  (t) => [
    index('transaction_member_created_idx').on(t.memberId, t.createdAt.desc()),
    index('transaction_salon_created_idx').on(t.salonId, t.createdAt.desc()),
    index('transaction_branch_created_idx').on(t.branchId, t.createdAt.desc()),
    uniqueIndex('transaction_reverses_uq')
      .on(t.reversesTransactionId)
      .where(sql`reverses_transaction_id IS NOT NULL`),

    // Sign follows kind. A credit kind cannot debit and a debit kind cannot credit.
    check(
      'transaction_amount_sign_matches_kind',
      sql`(${t.kind} IN ('topup', 'deposit_return') AND ${t.amountFils} > 0)
          OR (${t.kind} IN ('charge', 'deposit_hold', 'shop') AND ${t.amountFils} < 0)
          OR (${t.kind} = 'adjustment' AND ${t.amountFils} <> 0)`,
    ),
    // A bonus is a top-up concept. Nothing else has one, and it is never negative.
    check('transaction_bonus_non_negative', sql`${t.bonusFils} >= 0`),
    check(
      'transaction_bonus_is_topup_only',
      sql`${t.bonusFils} = 0 OR ${t.kind} = 'topup'`,
    ),
    check('transaction_fee_non_negative', sql`${t.feeFils} >= 0`),
    check(
      'transaction_reversal_is_not_self',
      sql`${t.reversesTransactionId} IS NULL OR ${t.reversesTransactionId} <> ${t.id}`,
    ),
    check(
      'transaction_settled_at_matches_status',
      sql`(${t.status} = 'settled') = (${t.settledAt} IS NOT NULL)`,
    ),
  ],
);
