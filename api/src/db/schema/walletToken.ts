/**
 * WalletToken — the rotating QR payload. api-contract.md § WalletToken.
 *
 * "The client never mints the token. Rotation and single-use consumption are
 * server-enforced; the countdown in the UI is cosmetic." Non-negotiable #2.
 *
 * Two properties this table has to hold on its own:
 *
 * 1. SINGLE USE. Consumption is one conditional update, not a read-then-write:
 *
 *      UPDATE wallet_token
 *         SET consumed_at = now(), consumed_by_staff_id = $2,
 *             consumed_by_transaction_id = $3
 *       WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
 *      RETURNING member_id;
 *
 *    Zero rows back means already used or expired — that is the 410 the scanner
 *    shows as "That code has already been used." Two scanners racing the same
 *    token both run this statement; the row lock means exactly one gets a row.
 *
 * 2. SHORT EXPIRY. The design rotates every 45 seconds. The CHECK below caps any
 *    token at two minutes of life whatever the caller passes, so a config typo
 *    or a future handler cannot mint a long-lived bearer credential for a wallet.
 *
 * The raw token is never stored — only its sha256. It is returned once, at mint.
 * A token is a bearer credential that authorises a debit; a database backup
 * should not be a stack of live ones.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from './_shared';
import { member } from './member';
import { staffUser } from './staff';
import { transaction } from './transaction';

export const walletToken = pgTable(
  'wallet_token',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    memberId: text('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),

    /** sha256(token). The raw value goes to the client once and is never persisted. */
    tokenHash: text('token_hash').notNull(),

    issuedAt: timestamptz('issued_at').notNull().defaultNow(),
    /** 45 seconds by design; the CHECK caps it at 2 minutes whatever is passed. */
    expiresAt: timestamptz('expires_at')
      .notNull()
      .default(sql`now() + interval '45 seconds'`),

    consumedAt: timestamptz('consumed_at'),
    consumedByStaffId: text('consumed_by_staff_id').references(() => staffUser.id, {
      onDelete: 'restrict',
    }),
    consumedByTransactionId: text('consumed_by_transaction_id').references(() => transaction.id, {
      onDelete: 'restrict',
    }),
  },
  (t) => [
    uniqueIndex('wallet_token_hash_uq').on(t.tokenHash),
    // The only lookup on the hot path: this member's live tokens.
    index('wallet_token_member_live_idx')
      .on(t.memberId, t.expiresAt.desc())
      .where(sql`consumed_at IS NULL`),
    index('wallet_token_expires_idx').on(t.expiresAt),

    check(
      'wallet_token_expiry_is_short',
      sql`${t.expiresAt} > ${t.issuedAt} AND ${t.expiresAt} <= ${t.issuedAt} + interval '2 minutes'`,
    ),
    check('wallet_token_consumed_after_issue', sql`${t.consumedAt} IS NULL OR ${t.consumedAt} >= ${t.issuedAt}`),
    // Consumption details cannot exist without a consumption.
    check(
      'wallet_token_consumer_requires_consumption',
      sql`${t.consumedAt} IS NOT NULL
          OR (${t.consumedByStaffId} IS NULL AND ${t.consumedByTransactionId} IS NULL)`,
    ),
  ],
);
