/**
 * Wire shapes. One module, so "customer-never" is a place in the code rather
 * than a habit spread across handlers.
 *
 * THE RULE THIS FILE EXISTS FOR
 * -----------------------------
 * build-plan.md phase 2: commission is "recorded per transaction,
 * merchant-visible, customer-never". `transaction.fee_fils` is a column on a
 * table the wallet reads, so the only thing standing between AVO's margin and
 * the customer's activity feed is the serializer. Written inline in each
 * handler, that becomes one `select *` away from a leak; written here, a new
 * customer-facing read has one obvious function to call.
 *
 * `TransactionSchema` in @avo/types has no `feeFils` field, which is the same
 * rule stated in the shared types. This is its enforcement on the way out.
 */

import type { Transaction } from '@avo/types';

/** The columns a customer transaction row actually has. */
export interface TransactionRow {
  id: string;
  memberId: string;
  branchId: string;
  kind: 'topup' | 'charge' | 'deposit_hold' | 'deposit_return' | 'shop' | 'adjustment';
  amountFils: number;
  bonusFils: number;
  feeFils: number;
  method: 'knet' | 'card' | 'applepay' | 'wallet' | null;
  status: 'pending' | 'settled' | 'failed' | 'cancelled';
  reference: string;
  createdAt: Date;
}

/**
 * A transaction as the wallet sees it. `feeFils` is destructured out by name
 * rather than left off a spread, so deleting the line is a visible edit and
 * adding a column cannot silently widen what the customer receives.
 */
export function serialiseTransactionForCustomer(row: TransactionRow): Transaction {
  return {
    id: row.id,
    memberId: row.memberId,
    branchId: row.branchId,
    kind: row.kind,
    amountFils: row.amountFils,
    bonusFils: row.bonusFils,
    // row.feeFils is deliberately NOT emitted — merchant-visible, customer-never.
    method: row.method,
    status: row.status,
    reference: row.reference,
    createdAt: row.createdAt.toISOString(),
  } as Transaction;
}

/**
 * The same row for a merchant surface, commission included.
 *
 * Not used by a route yet — Merchant → Settings is phase 4 — but it is written
 * here so the next lane that needs the fee reaches for a named merchant
 * serializer instead of adding `feeFils` to the customer one.
 */
export function serialiseTransactionForMerchant(row: TransactionRow): Transaction & {
  feeFils: number;
} {
  return { ...serialiseTransactionForCustomer(row), feeFils: row.feeFils };
}
