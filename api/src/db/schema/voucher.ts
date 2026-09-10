/**
 * AVO-ISSUED VOUCHERS — a code a customer redeems for wallet credit.
 *                                     (item 10, DECISIONS #87, migration 0046)
 *
 * Compensation already existed as `POST /members/{id}/adjustments`. What is new
 * is the OBJECT: AVO issues a code, the customer redeems it when she chooses,
 * and the credit lands in her wallet. Authority stays with the platform,
 * consistent with loyalty (#79) and campaign release (#8) — a merchant cannot
 * issue one and cannot compensate her own customer at all.
 *
 * REDEMPTION CREDITS THE WALLET; IT DOES NOT DISCOUNT A CHARGE. That ruling is
 * what keeps this feature off `POST /charges`.
 *
 * THERE IS NO `status` COLUMN, and that is the same argument decision 81 settled
 * for money. Redeemable is what the rows already determine:
 *
 *     redeemed_at IS NULL AND voided_at IS NULL
 *       AND (expires_at IS NULL OR expires_at > now())
 *
 * A stored status would be a second place for that to live and a second thing to
 * disagree with the timestamps beside it.
 *
 * OF LEAN'S THREE COUPON FIELDS ONLY THE CODE SURVIVES. `minimumAmountIsCart`
 * and the `optionType`/`optionList` product restriction both presuppose a BASKET,
 * and a wallet credit has none — so they are omitted rather than accepted and
 * ignored. A rule that can never fire is a dead guard.
 */

import { bigint, check, index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { timestamptz } from './_shared';
import { member } from './member';
import { platformAdmin } from './platformAdmin';
import { transaction } from './transaction';

export const voucher = pgTable(
  'voucher',
  {
    id: text('id').primaryKey(),
    /** What she types, and all she sends. Unique across the platform. */
    code: text('code').notNull(),

    /**
     * BOUND TO HER, NOT A BEARER CODE. The request was compensation of a named
     * customer, and binding makes a leaked code worthless to anyone else — which
     * is most of why the deliberately indistinguishable refusal costs so little.
     *
     * NOT NULL rather than nullable-for-a-future-bearer-variant: a nullable
     * column with no code path behind it is a dead field. A bearer voucher is a
     * different risk profile and gets its own migration and its own decision.
     */
    memberId: text('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'restrict' }),

    /**
     * Integer fils, non-negotiable #1, and strictly POSITIVE. A voucher only
     * adds — unlike `walletAdjustedPosting`, which handles a signed delta because
     * a console adjustment may claw back. An AVO apology that debited a customer
     * is not something this object should be able to express.
     */
    amountFils: bigint('amount_fils', { mode: 'number' }).notNull(),

    /** Required, exactly as an adjustment's is. See routes/adjustments.ts. */
    reason: text('reason').notNull(),

    /**
     * NULL means no expiry. Deliberately not defaulted: how long an apology stays
     * valid is a commercial decision, and writing one because the column looked
     * empty is the mistake decisions 80 and 82 are both about.
     */
    expiresAt: timestamptz('expires_at'),

    issuedByAdminId: text('issued_by_admin_id')
      .notNull()
      .references(() => platformAdmin.id, { onDelete: 'restrict' }),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),

    /** Terminal, and set together with the transaction that paid it. */
    redeemedAt: timestamptz('redeemed_at'),
    redeemedTransactionId: text('redeemed_transaction_id').references(() => transaction.id, {
      onDelete: 'restrict',
    }),

    /** Terminal, and mutually exclusive with redemption. */
    voidedAt: timestamptz('voided_at'),
    voidedByAdminId: text('voided_by_admin_id').references(() => platformAdmin.id, {
      onDelete: 'restrict',
    }),
  },
  (t) => [
    uniqueIndex('voucher_code_uq').on(t.code),
    index('voucher_member_idx').on(t.memberId, t.createdAt.desc()),

    check('voucher_amount_positive', sql`${t.amountFils} > 0`),
    check('voucher_code_not_blank', sql`length(btrim(${t.code})) > 0`),
    check('voucher_reason_not_blank', sql`length(btrim(${t.reason})) > 0`),
    check(
      'voucher_redemption_is_whole',
      sql`(${t.redeemedAt} IS NULL) = (${t.redeemedTransactionId} IS NULL)`,
    ),
    check('voucher_void_is_whole', sql`(${t.voidedAt} IS NULL) = (${t.voidedByAdminId} IS NULL)`),
    /**
     * A voucher voided AFTER redemption would be AVO taking back money already in
     * her wallet — a refund problem wearing a voucher's clothes. Not storable.
     */
    check(
      'voucher_is_not_both_redeemed_and_voided',
      sql`${t.redeemedAt} IS NULL OR ${t.voidedAt} IS NULL`,
    ),
  ],
);
