/**
 * `member_notification_read` — which bell items SHE has seen. Migration 0057.
 *
 * The customer bell has no notification table: its items ARE the outbound
 * records this API already writes per member (`receipt_job`, `campaign_send`).
 * The one fact neither can hold is whether she has read it, so that is the only
 * new state. `services/memberNotifications.ts` carries the argument.
 *
 * PER MEMBER, which is per reader: a `member` row is one customer's wallet at
 * one salon, and nobody else reads her bell. The merchant bell's `read_at` is
 * salon-wide because that bell is a shared worklist; this one is not shared with
 * anybody, so the question it answered there does not arise.
 */

import { sql } from 'drizzle-orm';
import { check, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { timestamptz } from './_shared';
import { campaign } from './campaign';
import { member } from './member';
import { transaction } from './transaction';

export const memberNotificationRead = pgTable(
  'member_notification_read',
  {
    memberId: text('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'restrict' }),
    /** A receipt-stream item: the money movement the receipt was queued for. */
    transactionId: text('transaction_id').references(() => transaction.id, {
      onDelete: 'restrict',
    }),
    /** A campaign-stream item. */
    campaignId: text('campaign_id').references(() => campaign.id, { onDelete: 'restrict' }),
    /** The FIRST time she marked it. A second mark is `ON CONFLICT DO NOTHING`. */
    readAt: timestamptz('read_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('member_notification_read_tx_uq')
      .on(t.memberId, t.transactionId)
      .where(sql`transaction_id IS NOT NULL`),
    uniqueIndex('member_notification_read_campaign_uq')
      .on(t.memberId, t.campaignId)
      .where(sql`campaign_id IS NOT NULL`),
    check(
      'member_notification_read_exactly_one_source',
      sql`(${t.transactionId} IS NULL) <> (${t.campaignId} IS NULL)`,
    ),
  ],
);
