/**
 * The activity feed's vocabulary — the parts the merchant's read and the
 * platform's read must not do differently.
 *
 * There are two activity screens. `GET /salons/{id}/activity` is the merchant's
 * Overview panel, scoped to her salon; `GET /v1/platform/activity` is the console's
 * "Live event feed for the whole platform". This file is `services/auditRead.ts` for
 * the feed, and it exists for the same stated reason: "a `kind` chip that means
 * something slightly different on the console than on the dashboard… turns 'these
 * two screens disagree' into a question about the record itself."
 *
 * It is more acute here than for the audit log, because a feed SENTENCE is the
 * thing being compared. `describeTransaction` already carries a defect that was
 * found and fixed once — a top-up's `amount_fils` is "what actually landed, bonus
 * included", so printing the column reads "topped up 30.000 · +5.000 bonus" and
 * tells a merchant her customer paid five dinars she did not. A second copy of that
 * function is a second chance to get that wrong, in the one place where the reader
 * is AVO rather than the salon and cannot check it against a receipt.
 *
 * MOVED, NOT REWRITTEN. Everything below came out of `routes/activity.ts`
 * unchanged; that file now imports it, and `GET /v1/platform/activity` in
 * `routes/platformConsole.ts` imports the same. The two handlers still differ, and
 * they differ where they should: which streams they read and which predicate they
 * apply. That is the whole of the difference, which is the property this file
 * exists to make true.
 */

import { loyaltyEvent } from '../db/schema/loyaltyEvent';
import { transaction } from '../db/schema/transaction';
import { badRequest } from '../http/errors';

export const FEED_MAX_LIMIT = 100;
export const FEED_DEFAULT_LIMIT = 20;

/**
 * The kinds that belong in a feed.
 *
 * `deposit_hold` is excluded deliberately. It is the money moving from the
 * customer's spendable balance into escrow at the moment she books — the merchant
 * already sees the booking in Appointments, and the feed would report the same
 * event twice, once as an appointment and once as a debit that is not a sale. Its
 * counterpart `deposit_return` IS included, because that one is the salon giving
 * money back and the design shows it by name.
 *
 * THE CONSOLE INHERITS THAT EXCLUSION, and it is worth saying why rather than
 * treating it as a consequence of sharing a constant. The argument above is about a
 * merchant's Appointments screen, which the console does not have — so the console
 * genuinely loses a line the merchant can find elsewhere. It is inherited anyway,
 * because the alternative is two answers to "what belongs in a feed", and the
 * console has the complete record next door: `GET /v1/platform/audit` serves every
 * `Deposit held` row, unfiltered, with `?salon=` to narrow it. A feed is a summary
 * and the audit log is the record; the design's own Activity banner points at the
 * second when it says "the full audit trail for the platform".
 */
export const FEED_KINDS = ['topup', 'charge', 'deposit_return', 'shop', 'adjustment'] as const;

export const TIER_LABEL: Record<string, string> = {
  bronze: 'Bronze',
  silver: 'Silver',
  gold: 'Gold',
  black: 'Black',
};

export const METHOD_LABEL: Record<string, string> = {
  knet: 'KNET',
  card: 'card',
  applepay: 'Apple Pay',
  wallet: 'wallet',
};

/**
 * One feed line, on the wire.
 *
 * `salonId` is `string | null` and the merchant's read fills it with her own salon
 * every time — the same call `services/auditRead.ts` makes for the same field, and
 * for the same reason: the console's feed draws a salon pill on every row and the
 * merchant's does not need one, but two shapes that differ by one key are two
 * shapes that drift. `null` is only ever a PLATFORM audit row, which belongs to no
 * salon.
 */
export interface FeedItem {
  id: string;
  /** Which stream this line came from. `audit` is console-only — see the route. */
  stream: 'transaction' | 'loyalty' | 'audit';
  at: string;
  who: string;
  memberId: string | null;
  salonId: string | null;
  /** The predicate the design renders after the bolded name. */
  what: string;
  /**
   * The transaction kind, the loyalty kind, or the audit kind — whichever stream
   * this is. Deliberately one field: a client colours a row by it, and three
   * mutually exclusive optional fields would be three states to handle for one
   * question.
   */
  kind: string;
  /** Signed fils, as stored. Null on a line that moved no money. */
  amountFils: number | null;
}

export function parseFeedLimit(value: unknown): number {
  if (value === undefined) return FEED_DEFAULT_LIMIT;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > FEED_MAX_LIMIT) {
    throw badRequest(
      'invalid_limit',
      `limit must be a whole number between 1 and ${FEED_MAX_LIMIT}.`,
    );
  }
  return n;
}

/** "12.000". The display boundary is the client's, but the feed's copy is prose. */
export function kd(amountFils: number): string {
  return (Math.abs(amountFils) / 1000).toFixed(3);
}

/**
 * The design's own phrasing, per kind:
 *   "topped up 25.000 via KNET" · "paid 12.000 · Cut & style"
 *   "returned 5.000 deposit · Aisha M. no-show" · "bought Repair serum · 9.500"
 *
 * Composed server-side so both languages resolve from one place later, and so
 * `note` — the void reason, the adjustment reason — reaches the reader without a
 * client having to know which kinds carry one.
 */
export function describeTransaction(row: typeof transaction.$inferSelect): string {
  const amount = kd(row.amountFils);
  switch (row.kind) {
    case 'topup': {
      /**
       * "topped up 25.000 via KNET" — the amount she PAID, which is not what
       * `amount_fils` holds. That column is "what actually landed, bonus
       * included" (services/topup.ts), so a 25.000 KNET top-up at Gold stores
       * 30000 with 5000 in `bonus_fils`. Printing the column would read
       * "topped up 30.000 · +5.000 bonus", which counts the bonus twice and
       * tells a merchant her customer paid five dinars she did not.
       */
      const paid = row.amountFils - row.bonusFils;
      const via = row.method ? ` via ${METHOD_LABEL[row.method] ?? row.method}` : '';
      const bonus = row.bonusFils > 0 ? ` · +${kd(row.bonusFils)} bonus` : '';
      return `topped up ${kd(paid)}${via}${bonus}`;
    }
    case 'charge':
      return `paid ${amount}`;
    case 'deposit_return':
      return `deposit returned ${amount}${row.note ? ` · ${row.note}` : ''}`;
    case 'shop':
      return `bought from the shop · ${amount}`;
    case 'adjustment':
      /**
       * A void arrives here as a compensating `adjustment` pointing back at the
       * charge it reverses — routes/charges.ts § POST /voids. Named as the
       * reversal it is, because "adjusted 12.000" in a feed is the one line a
       * merchant will stop and ask about.
       */
      return row.reversesTransactionId
        ? `charge voided · ${amount} returned${row.note ? ` · ${row.note}` : ''}`
        : `wallet adjusted ${row.amountFils > 0 ? '+' : '−'}${amount}${row.note ? ` · ${row.note}` : ''}`;
    default:
      return `${row.kind} ${amount}`;
  }
}

export function describeLoyalty(row: typeof loyaltyEvent.$inferSelect): string {
  if (row.kind === 'tier_climb') {
    const to = TIER_LABEL[row.toTier ?? ''] ?? row.toTier ?? '';
    /**
     * A republished ladder can move a member DOWN — see services/charge.ts. The
     * row carries both ends so the feed can say which happened rather than
     * announcing "reached Bronze" to someone who was demoted.
     */
    const from = row.fromTier ? TIER_LABEL[row.fromTier] ?? row.fromTier : null;
    const order = ['bronze', 'silver', 'gold', 'black'];
    const descended =
      row.fromTier !== null &&
      row.toTier !== null &&
      order.indexOf(row.toTier) < order.indexOf(row.fromTier);
    if (descended) return `moved to ${to} tier${from ? ` from ${from}` : ''}`;
    return `reached ${to} tier`;
  }
  return `filled the stamp card · ${row.stampsAfter ?? 0} of ${row.stampTarget ?? 0}`;
}
