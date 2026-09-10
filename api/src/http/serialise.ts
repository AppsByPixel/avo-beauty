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
 * The reversing transaction, when one exists.
 *
 * NOT a column on the row being serialised, and that is the whole reason this is
 * a separate parameter. There is no `voided_at` in the schema: void state lives
 * on the REVERSAL, whose `reverses_transaction_id` points back at the charge it
 * refunds. So both wire fields are derived from a self-join and neither can be
 * read off the row being serialised.
 *
 * REQUIRED, NOT OPTIONAL, and not defaulted to null. A default would let a caller
 * skip the join and silently report every charge as live — which is precisely the
 * bug `GET /charges` was fixed for: the scanner offered "Void this charge" on a
 * charge already voided, and a staff member tapped it in front of the customer.
 * A caller that has not done the join should fail to compile, not quietly lie.
 */
export interface ReversalRow {
  id: string;
  createdAt: Date;
}

/**
 * A transaction as the wallet sees it. `feeFils` is destructured out by name
 * rather than left off a spread, so deleting the line is a visible edit and
 * adding a column cannot silently widen what the customer receives.
 *
 * THE RETURN IS NOT CAST, AND THAT IS LOAD-BEARING.
 * ------------------------------------------------
 * This function used to end `} as Transaction`, and it was missing `voidedAt` and
 * `reversedByTransactionId` — both declared `.nullable()` on `TransactionSchema`,
 * so both required to be present and permitted to be null. `as` told tsc to stop
 * checking, so the typecheck stayed green while `GET /members/me/transactions`
 * served a body the wallet's own contract parse rejected. The wallet raised
 * "That response did not match the contract", Home rendered "We couldn't load
 * your wallet", and Account — only reachable from a loaded Home — became
 * unreachable. On a cold cache the customer app was unusable.
 *
 * The comment above about `feeFils` is sound and stays, but note what it protects
 * against: WIDENING. The mirror risk is a new REQUIRED field never being emitted,
 * and the cast removed the one guard that would have caught it. Without the
 * assertion, tsc names the missing fields immediately — and will name the next
 * one anybody adds to the schema.
 */
export function serialiseTransactionForCustomer(
  row: TransactionRow,
  reversal: ReversalRow | null,
): Transaction {
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
    /**
     * Both, and deliberately not one. `voidedAt` is what a list renders —
     * "Voided 14:32" is the sentence a human reads; `reversedByTransactionId`
     * names the refund row, so "where did the money go" is answerable from the
     * screen the question is asked on. Null is a positive statement here — not
     * voided — which is why they are always present rather than omitted.
     */
    voidedAt: reversal ? reversal.createdAt.toISOString() : null,
    reversedByTransactionId: reversal ? reversal.id : null,
  };
}

/**
 * The same row for a merchant surface, commission included.
 *
 * Not used by a route yet — Merchant → Settings is phase 4 — but it is written
 * here so the next lane that needs the fee reaches for a named merchant
 * serializer instead of adding `feeFils` to the customer one.
 */
export function serialiseTransactionForMerchant(
  row: TransactionRow,
  reversal: ReversalRow | null,
): Transaction & { feeFils: number } {
  return { ...serialiseTransactionForCustomer(row, reversal), feeFils: row.feeFils };
}

/**
 * ==========================================================================
 * THE ERASED MEMBER'S CONTACT — a tombstone is not a phone number.
 * ==========================================================================
 * (DECISIONS.md #100. `services/erasure.ts` § `tombstonePhone` mints the value
 * this exists to keep off the wire.)
 *
 * `member.phone` is `NOT NULL`, `CHECK`ed E.164 and unique per salon, so erasure
 * cannot clear it — it overwrites it with `+990` and twelve random digits, an
 * unassigned country code chosen precisely because it can never reach anybody.
 * That is the right thing to STORE and the wrong thing to SERVE: three merchant
 * reads joined `member` live and handed the tombstone out in a field the wire
 * calls `memberPhone`, so lane C's fulfilment board rendered
 * `href="tel:+990224285141169"` next to a row reading "Deleted account", and the
 * scanner's My Bookings turned the same digits into a `tel:` AND a
 * `https://wa.me/` button. That surface does not merely display the fake number,
 * it messages it.
 *
 * WHY NULL RATHER THAN THE DIGITS AS PLAIN TEXT. There is no dialable fallback
 * to degrade to — the number reaches nobody by construction — and un-linking it
 * is barely better than linking it, because a merchant can still copy twelve
 * digits into a handset. Nothing is lost that the erasure did not already take:
 * `erasure.ts` nulls the delivery snapshot on EVERY order regardless of status,
 * so a `preparing` order for an erased member is already unfulfillable and the
 * number was never going to complete it.
 *
 * WHY THE BOOLEAN IS NOT REDUNDANT. `memberPhone: null` alone is ambiguous the
 * moment a member without a number on file is possible — "erased" and "never
 * gave us one" would render identically, and a client cannot write honest copy
 * from a hole. Without the flag the only client-side detection left is
 * string-matching `+990` or the literal `'Deleted account'`, which is a client
 * reimplementing an erasure predicate off two constants it does not own; both
 * rot silently the day either changes. The server knows `erased_at`, so the
 * server says so.
 *
 * WHY `memberName` IS NOT IN HERE. It stays the tombstone, unchanged, and it is
 * deliberately NOT this function's business: `TOMBSTONE_NAME` is already a
 * display-safe string every consuming surface renders as-is, and both surfaces
 * are English-only by decision (design/README.md § Known gaps 1). Routing it
 * through here would invite a future "translate the tombstone" change into the
 * one place that must keep answering the same thing for all three endpoints.
 *
 * ONE FUNCTION, THREE CALLERS, FOR `serialiseTransactionForCustomer`'S REASON.
 * The rule at the top of this file — "customer-never is a place in the code
 * rather than a habit spread across handlers" — is exactly the rule here, and
 * this defect is what it looks like when the habit is spread: the same join,
 * written three times, leaked three times. A fourth merchant read that joins
 * `member` for a phone calls this or repeats the bug.
 */
export interface MemberContactRow {
  /** `member.phone` — never null in the database, tombstone or not. */
  phone: string;
  /** `member.erased_at`. Non-null is the erasure, and it is the only tell. */
  erasedAt: Date | null;
}

export interface MemberContactWire {
  memberErased: boolean;
  memberPhone: string | null;
}

/**
 * DERIVED FROM `erased_at`, NOT FROM THE SHAPE OF THE NUMBER. A `phone.startsWith('+990')`
 * test here would be the same string-match coupling this field exists to spare
 * clients, moved one process to the left.
 */
export function serialiseMemberContact(row: MemberContactRow): MemberContactWire {
  const memberErased = row.erasedAt !== null;
  return { memberErased, memberPhone: memberErased ? null : row.phone };
}
