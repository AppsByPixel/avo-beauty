/**
 * WHAT A VISIT WAS WORTH — one definition, named once.  (DECISIONS.md #81)
 *
 * =========================================================================
 * THE DEFECT THIS FILE EXISTS TO CLOSE
 * =========================================================================
 * `transaction.amount_fils` is a movement of the CUSTOMER'S WALLET, not the
 * salon's takings, and for a BOOKED appointment it is only part of the visit.
 * `services/charge.ts` § 4 caps the held deposit at the basket and writes
 *
 *     amount_fils = -(gross - applied)
 *
 * The applied half left her wallet earlier, when the booking took its deposit,
 * and became salon revenue at charge time through `depositAppliedPosting` — a
 * `deposit_held` DEBIT on the charge's own ledger entries.
 *
 * Three call sites needed that arithmetic. One had it:
 *
 *     routes/charges.ts   a void's refund    |amount_fils| + the deposit leg
 *     reports `sales`     "Gross KD"         sum(-amount_fils)        ← NET
 *     reports `best-…`    "Revenue KD"       sum(-amount_fils)        ← NET
 *
 * So a 6.000 service against a 5.000 deposit was exported as 1.000, and an
 * appointment a deposit covered outright as 0.000, under a column a merchant
 * reads as gross. The correct definition was already in the codebase and nobody
 * had connected it: "what the salon must give back if this is voided" and "what
 * the salon earned" are ONE quantity, so this build now has one expression for
 * it rather than three that happen to agree.
 *
 * =========================================================================
 * IT LIVES IN THE DATABASE, AND THAT IS THE POINT
 * =========================================================================
 * The expression is the `transaction_revenue` view (migration 0042). Not a
 * TypeScript helper each caller composes, because two of the four callers are
 * raw-SQL aggregates and one is a single-row read inside a money transaction —
 * a shared string would have been one definition in this repository and four in
 * the database. A view is one in both, and a reconciliation job or an operator
 * in `psql` gets the same answer without having to know any of the above.
 *
 * The view carries the three predicates that used to be a caller's to remember:
 * revenue-bearing `kind`, `status = 'settled'`, and the `deposit_held`/`debit`
 * leg. It deliberately does NOT carry the void exclusion — a report must not
 * count money already handed back, but the void handler has to read the charge
 * it is about to reverse. That predicate stays at the call sites. The migration
 * carries the full argument, including why this is a view and not a stored
 * `transaction.deposit_applied_fils` column.
 *
 * =========================================================================
 * THE THREE COLUMNS, AND WHY THERE ARE THREE
 * =========================================================================
 *     charged_fils          what came out of her SPENDABLE balance
 *     deposit_applied_fils  what the booking's deposit covered
 *     earned_fils           their sum — what the visit was worth
 *
 * `earned_fils` is the honest figure and `charged_fils` is the one that ties to
 * the wallet ledger, so both are on the face of the artist-performance report.
 * Folding them would hide a disagreement between two reports inside a single
 * number, which is how this defect survived as long as it did.
 */

import { sql, type SQL } from 'drizzle-orm';
import { fils, type Fils } from '@avo/types';
import type { Db } from '../db/client';

/**
 * The relation. Named here rather than typed out at four call sites, so a rename
 * is one edit and a typo is a compile-time identifier rather than a runtime
 * `relation "transaction_revneue" does not exist` in a merchant's export.
 */
export const TRANSACTION_REVENUE = sql.identifier('transaction_revenue');

/**
 * `INNER JOIN` onto a `transaction` alias — the join the aggregates that start
 * from `transaction` make.
 *
 * Inner, not left: the caller has already filtered to settled revenue kinds, so
 * every row matches, and a row that somehow did not is one whose `count(*)`
 * would move too. Nothing is coalesced away.
 */
export function revenueJoin(txAlias: string, as = 'rev'): SQL {
  const a = sql.identifier(as);
  return sql`JOIN ${TRANSACTION_REVENUE} ${a} ON ${a}.transaction_id = ${sql.identifier(txAlias)}.id`;
}

/**
 * `LEFT JOIN` onto an arbitrary transaction-id expression — for a caller whose
 * rows are not transactions.
 *
 * `best-selling-services` counts BOOKINGS and joins each to whatever settled it.
 * A booking still in `deposit_held` has settled nothing; a cancelled or
 * no-showed one was settled by a `deposit_return`, which is not revenue and is
 * therefore not in the view. Both arrive as NULL and are coalesced to zero by
 * the caller's `coalesce(sum(...), 0)` — so "contributes nothing" is a property
 * of the definition rather than a filter that aggregate has to get right. It did
 * not get it right: joined straight to `transaction`, a `deposit_return`'s
 * POSITIVE `amount_fils` made `sum(-amount_fils)` print NEGATIVE revenue for a
 * no-show.
 */
export function revenueLeftJoin(transactionIdExpr: SQL, as = 'rev'): SQL {
  const a = sql.identifier(as);
  return sql`LEFT JOIN ${TRANSACTION_REVENUE} ${a} ON ${a}.transaction_id = ${transactionIdExpr}`;
}

/** What one transaction was worth. Integer fils; `fils()` throws on a float. */
export interface TransactionRevenue {
  chargedFils: Fils;
  depositAppliedFils: Fils;
  earnedFils: Fils;
}

/**
 * One transaction's worth, for a caller holding an id rather than building an
 * aggregate — which today is the void.
 *
 * Returns `null` for a transaction the view does not cover: an unsettled row, a
 * `topup`, a `deposit_hold`, a `deposit_return`, an `adjustment`. A caller that
 * needs a number from one of those needs a different question, and the null says
 * so rather than answering zero.
 *
 * `bigint` columns arrive from `postgres` as strings, so every one goes through
 * `Number()` and then `fils()` — non-negotiable #1, and `fils()` is what refuses
 * a value that has stopped being an integer somewhere upstream.
 */
export async function readTransactionRevenue(
  executor: Pick<Db, 'execute'>,
  transactionId: string,
): Promise<TransactionRevenue | null> {
  const rows = (await executor.execute(sql`
    SELECT rev.charged_fils, rev.deposit_applied_fils, rev.earned_fils
      FROM ${TRANSACTION_REVENUE} rev
     WHERE rev.transaction_id = ${transactionId}
     LIMIT 1
  `)) as unknown as Array<Record<string, unknown>>;

  const r = rows[0];
  if (!r) return null;

  const chargedFils = fils(Number(r.charged_fils));
  const depositAppliedFils = fils(Number(r.deposit_applied_fils));
  const earnedFils = fils(Number(r.earned_fils));

  /**
   * The view's own arithmetic, checked once on the way out. It cannot fail while
   * migration 0042 is what defines the view — which is exactly why it is worth a
   * line: it is the assertion that catches a hand-edited view in a database
   * somebody patched, and a refund is the wrong place to find that out quietly.
   */
  if (chargedFils + depositAppliedFils !== earnedFils) {
    throw new Error(
      `transaction_revenue disagrees with itself for ${transactionId}: ` +
        `${chargedFils} + ${depositAppliedFils} != ${earnedFils}`,
    );
  }

  return { chargedFils, depositAppliedFils, earnedFils };
}
