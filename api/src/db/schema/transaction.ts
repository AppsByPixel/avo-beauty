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
  boolean,
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
import { happyHour } from './promotion';
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
    /**
     * TRUE when `branch_id` above is an attribution rather than a fact.
     *
     * That column is NOT NULL because the contract has no nullable branch and
     * both clients render it unconditionally, so every money path must produce a
     * value. When the branch was not established — a multi-branch salon, and a
     * charge that cannot yet say where it happened — the value comes from
     * `ORDER BY id LIMIT 1`, which is alphabetical order, not knowledge.
     *
     * The fallback used to be silent, and the silence is what made it dangerous:
     * a salon with `BR-KWC` and `BR-SAL` paid every unattributed customer Kuwait
     * City's 2x visit boost because 'BR-KWC' sorts first. The EARNING side is
     * fixed at the source — an unknown branch matches no boost and no
     * branch-scoped window, see services/branch.ts and services/promotions.ts
     * § PromotionInputs. This column fixes the REPORTING side, which that does
     * not touch.
     *
     * WHY A COLUMN AND NOT A LOG LINE. Per-branch revenue is a figure a merchant
     * acts on. Without this, a defaulted row is indistinguishable from a real
     * one forever, and the only honest answer to "is this branch total right" is
     * "we cannot tell". With it, the answer is a WHERE clause.
     *
     * It goes all-false naturally once a branch-bound scanner session lands and
     * charges know where they happened.
     */
    branchAssumed: boolean('branch_assumed').notNull().default(false),

    kind: transactionKind('kind').notNull(),
    /** Signed: credit positive, debit negative. */
    amountFils: filsColumn('amount_fils').notNull(),
    /**
     * The TIER bonus portion of a top-up, and nothing else. Always 0 in stamps
     * mode. Its meaning is unchanged by promotions landing — see
     * `promo_bonus_fils` immediately below for why that is the whole point.
     */
    bonusFils: filsColumn('bonus_fils').notNull().default(fils(0)),
    /**
     * THE SECOND BONUS SOURCE, IN ITS OWN COLUMN.
     *
     * A `topup10` / `topup20` happy hour, or a branch boost's `topup` points,
     * add credit on top of the tier bonus — packages/types/src/rules.ts is
     * explicit: "Extra top-up bonus percentage points ON TOP OF the tier bonus".
     * Adding them into `bonus_fils` would have made a settled top-up
     * irreconcilable: nothing stored would say how much of one number the
     * merchant funded because of a customer's standing and how much because of a
     * promotion she was running. Two different budget lines, one column, no way
     * back. Hence two columns.
     *
     * Still top-up-only, and the CHECK below says so. A promotion that pays out
     * on a CHARGE (`credit3`) is not a top-up bonus and does not live here — it
     * is written as its own `adjustment` transaction, which is what lets the
     * activity feed show the customer the credit as a line of its own instead of
     * hiding it inside the charge that triggered it. See services/promotions.ts.
     */
    promoBonusFils: filsColumn('promo_bonus_fils').notNull().default(fils(0)),
    /**
     * The happy hour that produced `promo_bonus_fils`, or that multiplied this
     * charge's loyalty increment, or that this `adjustment` is the payout of.
     *
     * Nullable and unconstrained by `kind` on purpose: a promotion can attach to
     * a top-up (bonus points), a charge (a visit/stamp multiplier, which moves no
     * money at all) or an adjustment (`credit3`). What it must never be is
     * absent — an x2 visit granted with nothing recording WHY is a loyalty
     * standing nobody can explain to a customer who asks.
     *
     * `ON DELETE restrict`, and `DELETE .../happy-hours/{hid}` therefore
     * soft-deletes rather than removing the row once it has been applied. A
     * promotion deleted out from under the transactions it paid for is a
     * reconciliation report with a dangling id in it.
     */
    promotionId: text('promotion_id').references(() => happyHour.id, { onDelete: 'restrict' }),
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

    /**
     * WHAT THIS CHARGE WAS FOR, canonically, so a near-duplicate is answerable.
     *
     * sha256 of the SORTED service ids. Order-independent, because `[SV-01, SV-02]`
     * and `[SV-02, SV-01]` are the same basket to a human at a counter and must be
     * the same to the guard. Sorting is the whole canonicalisation: duplicates
     * cannot occur, since `POST /charges` refuses a repeated service id by name.
     *
     * CHARGES ONLY, by CHECK. A top-up or an adjustment has no basket, and a `shop`
     * row's contents live in `shop_order_line` — two answers to "what was this for"
     * is the redundancy migration 0027 refused to create.
     *
     * NULL ON EVERY CHARGE WRITTEN BEFORE MIGRATION 0031, which is why the guard
     * matches on a NON-NULL hash rather than treating null as a wildcard. An old
     * charge cannot be compared to a new basket, and pretending it can would refuse
     * legitimate charges against history nobody recorded.
     */
    basketHash: text('basket_hash'),

    /**
     * TRUE when a staff member TYPED this charge's price instead of selecting it
     * from the service menu.  (migration 0049)
     *
     * WHY A COLUMN AND NOT A DERIVATION, which is the question migration 0027 and
     * migration 0042 both answered the other way. Those refused to store a second
     * copy of something the schema already determined — the basket's service ids,
     * the applied deposit. This is the opposite case: NOTHING ELSE IN THE SCHEMA
     * RECORDS WHO DECIDED THE PRICE. `basket_hash` says what the charge was for,
     * `amount_fils` says what moved, `created_by_staff_id` says who rang it up —
     * and a 25.000 KD charge looks identical whether it came off the menu or out
     * of a manager's head. It is not derivable, so it is stored.
     *
     * `branch_assumed` immediately above is the precedent, and the reasoning is
     * the same one: per-artist and per-period revenue is a figure a merchant PAYS
     * A BONUS ON, and a typed figure inside it must be visible as a typed figure.
     * Without this column an audit two years later cannot separate the menu from
     * the judgement, and the only honest answer to "how much of this month's
     * takings did somebody type" is "we cannot tell". With it, the answer is a
     * WHERE clause.
     *
     * DEFAULT FALSE, so every charge written before 0049 reads as what it was: a
     * menu price. Unlike `basket_hash`, there is no ambiguous history here — a
     * custom amount could not be taken at all before this column existed, so
     * `false` on an old row is a fact and not an absence of information.
     */
    customAmount: boolean('custom_amount').notNull().default(false),

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

    /**
     * Sign follows kind. A credit kind cannot debit and a debit kind cannot
     * credit.
     *
     * `charge` IS `<= 0` WHERE THE OTHER DEBIT KINDS ARE `< 0`, which is
     * migration 0014 and is not an inconsistency. A charge records what was
     * debited AFTER a held deposit was applied — the design's "8.000 service −
     * 5.000 deposit = 3.000 charged" — so a 6.000 manicure against a 10.000
     * deposit, which is the contract's maximum, debits nothing further and the
     * row is legitimately zero. That is still a real visit: loyalty increments,
     * the booking completes, a receipt goes out. What stays forbidden is a
     * POSITIVE charge, a charge that pays the customer.
     *
     * `deposit_hold` cannot be zero because `salon_deposit_in_range` puts the
     * deposit between 1000 and 10000, and `shop` cannot because
     * `service_price_positive` refuses a free line. Widening either would buy
     * only the ability to write a meaningless row.
     */
    check(
      'transaction_amount_sign_matches_kind',
      sql`(${t.kind} IN ('topup', 'deposit_return') AND ${t.amountFils} > 0)
          OR (${t.kind} = 'charge' AND ${t.amountFils} <= 0)
          OR (${t.kind} IN ('deposit_hold', 'shop') AND ${t.amountFils} < 0)
          OR (${t.kind} = 'adjustment' AND ${t.amountFils} <> 0)`,
    ),
    // A bonus is a top-up concept. Nothing else has one, and it is never negative.
    check('transaction_bonus_non_negative', sql`${t.bonusFils} >= 0`),
    /**
     * NOT RELAXED, and that is the finding.
     *
     * This constraint was flagged as an obstacle to promotions: a happy-hour
     * reward on a CHARGE (`credit3`, `x2visit`) had nowhere to record itself.
     * Looking at it while building the feature, the constraint is right and the
     * modelling was wrong. Neither case is a top-up bonus:
     *
     *   x2visit / x2stamp / x3stamp   moves no money whatsoever. It multiplies a
     *                                 loyalty increment. `promotion_id` on the
     *                                 charge row plus a `loyalty_event` records
     *                                 it; a fils column would have to hold 0.
     *   credit3                       is a 3.000 KD wallet CREDIT. Recording it
     *                                 inside the charge row that triggered it
     *                                 would net a debit against a credit and
     *                                 leave the activity feed unable to show the
     *                                 customer either number. It is written as
     *                                 its own `adjustment` transaction, which
     *                                 the sign CHECK above already permits and
     *                                 which the ledger already balances.
     *
     * So the constraint stays, and both promotion payouts are modelled as what
     * they actually are. Relaxing it would have bought the ability to write a
     * meaningless row.
     */
    check(
      'transaction_bonus_is_topup_only',
      sql`${t.bonusFils} = 0 OR ${t.kind} = 'topup'`,
    ),
    check('transaction_promo_bonus_non_negative', sql`${t.promoBonusFils} >= 0`),
    check(
      'transaction_promo_bonus_is_topup_only',
      sql`${t.promoBonusFils} = 0 OR ${t.kind} = 'topup'`,
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
    check(
      'transaction_basket_hash_is_charge_only',
      sql`${t.basketHash} IS NULL OR ${t.kind} = 'charge'`,
    ),

    /**
     * A TYPED PRICE IS A CHARGE, and can be nothing else.
     *
     * The same shape as `transaction_basket_hash_is_charge_only` and for the same
     * reason: a top-up, a deposit movement, a shop order and a void's
     * `adjustment` all get their amount from somewhere the staff member is not.
     * A `shop` row in particular is priced from `product.price_fils` exactly as a
     * charge is priced from `service.price_fils`, so "a custom shop order" is a
     * separate authority nobody has asked for — and an endpoint that quietly
     * acquired one would be caught here rather than in a report.
     */
    check(
      'transaction_custom_amount_is_charge_only',
      sql`${t.customAmount} = false OR ${t.kind} = 'charge'`,
    ),
    /**
     * A CUSTOM CHARGE CARRIES ITS BASKET HASH, and this is what keeps the
     * near-duplicate guard reachable on the riskiest path in the product.
     *
     * `services/charge.ts § basketHashFor` hashes the sorted service ids for a
     * menu charge and the AMOUNT for a typed one, so `basket_hash` keeps its
     * meaning — "what this charge was for, canonically" — in both cases. Without
     * this CHECK a custom charge could commit with a NULL hash, which the guard
     * treats as un-comparable history (see `basket_hash` above), and a
     * double-tapped 40.000 KD would go through twice with nothing to compare it
     * against.
     *
     * One-directional, deliberately: a MENU charge may still have a NULL hash,
     * because every charge written before migration 0031 does.
     */
    check(
      'transaction_custom_amount_has_basket_hash',
      sql`${t.customAmount} = false OR ${t.basketHash} IS NOT NULL`,
    ),
    /**
     * A TYPED PRICE SAYS WHAT IT WAS FOR.
     *
     * A menu charge is self-describing: `basket_hash` names services that are
     * rows in a table with names and prices. A custom charge has no such row
     * anywhere — `best-selling-services` cannot attribute it, and the hash is a
     * sha256 of a number. The `note` is therefore the ONLY thing that will ever
     * answer "what was this 25.000 KD" — which is the question the whole feature
     * has to survive in a dispute.
     *
     * `POST /voids` already requires a reason for the same reason and carries it
     * into this same column. Enforced here as well as in the handler because a
     * second writer of this table is how the `perms` columns came to need
     * `PERM_COLUMN`: a constraint is the copy that cannot be forgotten.
     */
    check(
      'transaction_custom_amount_has_note',
      sql`${t.customAmount} = false OR (${t.note} IS NOT NULL AND length(btrim(${t.note})) > 0)`,
    ),
    /**
     * The near-duplicate guard's only query: "has this member been charged for this
     * basket recently". Partial, because only charges carry a hash.
     */
    index('transaction_member_basket_recent_idx')
      .on(t.memberId, t.basketHash, t.createdAt.desc())
      .where(sql`kind = 'charge' AND basket_hash IS NOT NULL`),

    /**
     * "Show me every typed price this salon took." Partial, on the true rows
     * only, because they are the rare case — the index is a few pages rather
     * than a copy of the table, and it is the query a merchant reviewing the
     * month actually runs.
     */
    index('transaction_custom_amount_idx')
      .on(t.salonId, t.createdAt.desc())
      .where(sql`custom_amount`),
  ],
);
