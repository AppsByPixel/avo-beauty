/**
 * Ledger entry — double-entry backing for every money movement.
 *
 * Not in api-contract.md: no client renders it. It exists because
 * `member.balance_fils` is a cached aggregate, and a cached aggregate with no
 * derivation is a number nobody can defend in a dispute. Every change to a
 * balance writes balanced entries here in the same transaction, so the wallet
 * can always be recomputed from first principles:
 *
 *   SELECT sum(CASE direction WHEN 'credit' THEN amount_fils ELSE -amount_fils END)
 *   FROM ledger_entry WHERE account = 'member_wallet' AND member_id = $1;
 *
 * Entries are immutable. Migration 0001 revokes UPDATE and DELETE on this table
 * from the application role for the same reason it does on `audit_log`.
 *
 * Sign convention: `amount_fils` is always positive and `direction` carries the
 * sign. That is what makes the balanced-entry trigger in 0001 a sum of two
 * positive columns rather than a sign-juggling exercise.
 */

import { sql } from 'drizzle-orm';
import { bigserial, check, index, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { filsColumn, timestamptz } from './_shared';
import { member } from './member';
import { salon } from './salon';
import { transaction } from './transaction';

export const ledgerAccount = pgEnum('ledger_account', [
  /** What the customer can spend. Mirrors member.balance_fils. */
  'member_wallet',
  /** Value delivered by the salon: services rendered, products sold. */
  'salon_revenue',
  /** AVO's commission on a top-up. Merchant-visible, customer-never. */
  'avo_commission',
  /** Money in flight at the PSP between redirect and settlement. */
  'gateway_clearing',
  /** A booking deposit held out of the wallet, awaiting apply or return. */
  'deposit_held',
  /** The merchant-funded portion of a tier bonus. */
  'merchant_bonus_funding',
  /**
   * AVO's own money, funding a voucher it issued (item 10, migration 0046).
   *
   * ITS OWN ACCOUNT RATHER THAN `gateway_clearing`, and that is the whole
   * provenance mechanism: a voucher credit would otherwise be indistinguishable
   * from any console adjustment, and "which credit in this salon's wallet came
   * from an AVO voucher" would have to be reconstructed from audit rows. With
   * this it is `sum(amount_fils) WHERE account = 'avo_voucher_funding' AND
   * salon_id = $1`, off the index this table already has.
   *
   * NOT `merchant_bonus_funding`: that is the SALON's money funding a bonus the
   * salon advertised. This is AVO's money funding an apology AVO made, and
   * folding them would make a merchant's bonus budget include compensation she
   * did not offer.
   */
  'avo_voucher_funding',
]);

export const ledgerDirection = pgEnum('ledger_direction', ['debit', 'credit']);

export const ledgerEntry = pgTable(
  'ledger_entry',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Monotonic write order — the audit read order, independent of clock skew. */
    seq: bigserial('seq', { mode: 'number' }).notNull(),

    transactionId: text('transaction_id')
      .notNull()
      .references(() => transaction.id, { onDelete: 'restrict' }),
    salonId: text('salon_id')
      .notNull()
      .references(() => salon.id, { onDelete: 'restrict' }),
    /** Null on entries that do not touch a customer wallet (commission, clearing). */
    memberId: text('member_id').references(() => member.id, { onDelete: 'restrict' }),

    account: ledgerAccount('account').notNull(),
    direction: ledgerDirection('direction').notNull(),
    /** Always positive. The sign lives in `direction`. */
    amountFils: filsColumn('amount_fils').notNull(),

    /**
     * The wallet balance immediately after this entry, for `member_wallet` only.
     * A second place the "no negative wallet" rule is enforced: a ledger that
     * records the wallet passing through a negative value is rejected even if
     * the final `member.balance_fils` happens to land back above zero.
     */
    balanceAfterFils: filsColumn('balance_after_fils'),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('ledger_entry_transaction_idx').on(t.transactionId),
    index('ledger_entry_member_seq_idx').on(t.memberId, t.seq),
    index('ledger_entry_salon_account_idx').on(t.salonId, t.account, t.createdAt.desc()),

    check('ledger_entry_amount_positive', sql`${t.amountFils} > 0`),
    check(
      'ledger_entry_balance_after_non_negative',
      sql`${t.balanceAfterFils} IS NULL OR ${t.balanceAfterFils} >= 0`,
    ),
    check(
      'ledger_entry_balance_after_is_wallet_only',
      sql`${t.balanceAfterFils} IS NULL OR ${t.account} = 'member_wallet'`,
    ),
    check(
      'ledger_entry_wallet_requires_member',
      sql`${t.account} <> 'member_wallet' OR ${t.memberId} IS NOT NULL`,
    ),
  ],
);
