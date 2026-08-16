/**
 * Loyalty events — the moments a member's standing changed.
 *
 * WHY THIS TABLE HAD TO EXIST BEFORE THE OVERVIEW FEED COULD BE HONEST
 * -------------------------------------------------------------------
 * design/AVO Merchant Dashboard.dc.html § Overview shows a Recent activity feed
 * that mixes four kinds of thing:
 *
 *     Latifa A.  topped up 25.000 via KNET
 *     Mona K.    paid 12.000 · Cut & style
 *     System     returned 5.000 deposit · Aisha M. no-show
 *     Reem S.    reached Gold tier            <- this one
 *     Noura F.   bought Repair serum · 9.500
 *
 * Three of the five are rows in `transaction`. The fourth is not, and it was not
 * recoverable from anything that was stored. `member.tier` holds the CURRENT
 * rung and nothing held the moment it moved: a tier climb is a function of a
 * visit count crossing a threshold, and neither the visit count before the
 * charge nor the ladder as it stood at that instant survives anywhere the feed
 * can read.
 *
 * The alternative was to leave the climb out and serve a feed that quietly
 * differs from the design, or to infer one, which would mean guessing. A
 * milestone the product announces to the merchant is a fact worth recording.
 *
 * WHY NOT `audit_log`
 * -------------------
 * It is the obvious append-only table and it is the wrong one. Its `kind` is the
 * dashboard's four filter chips — Money / Rules / Access / Risk — and a customer
 * reaching Gold is none of them. Filing it under `rules` would put "Reem S.
 * reached Gold tier" in the same filter as "Tier rules published", which is the
 * filter a merchant opens to find out who changed the rules. The audit log
 * records what STAFF did; this records what a MEMBER became.
 *
 * WRITTEN INSIDE THE CHARGE TRANSACTION
 * -------------------------------------
 * `services/charge.ts` already computes `climbed` in step 9 and throws it away.
 * The row is inserted there, in the same transaction as the debit and the visit
 * increment, for the reason every other write in that flow is: a climb that is
 * recorded but rolled back, or applied but unrecorded, is a feed that disagrees
 * with the wallet. Non-negotiable #3.
 *
 * Append-only by intent but NOT by revoke. Migration 0001 asks a later migration
 * to state that decision out loud rather than leave it to a reader, so: this is
 * a derived record of something that already happened, it feeds a dashboard
 * panel rather than a ledger, and nothing reconciles against it. `audit_log` and
 * `ledger_entry` earn their REVOKEs because money and authority are argued about
 * seven years later. A tier climb is not.
 */

import { sql } from 'drizzle-orm';
import { bigserial, check, index, integer, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from './_shared';
import { member } from './member';
import { salon } from './salon';
import { tierName } from './salon';
import { transaction } from './transaction';

export const loyaltyEventKind = pgEnum('loyalty_event_kind', [
  /** Crossed a threshold and moved up the ladder. */
  'tier_climb',
  /** Filled the stamp card — `stamps >= target`. */
  'stamp_reward_ready',
]);

export const loyaltyEvent = pgTable(
  'loyalty_event',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Write order, so the feed reads newest-first without depending on the clock. */
    seq: bigserial('seq', { mode: 'number' }).notNull(),

    salonId: text('salon_id')
      .notNull()
      .references(() => salon.id, { onDelete: 'restrict' }),
    memberId: text('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'restrict' }),
    /**
     * The charge that caused it. Nullable because a future path — an operator
     * adjusting a visit count from the owner console, a stamp granted by hand —
     * can move a member's standing without a transaction behind it.
     */
    transactionId: text('transaction_id').references(() => transaction.id, {
      onDelete: 'restrict',
    }),

    kind: loyaltyEventKind('kind').notNull(),

    /** Tier climbs only. `from` is null for a member who was on no tier yet. */
    fromTier: tierName('from_tier'),
    toTier: tierName('to_tier'),

    /** Stamp events only: where the card stood when it filled. */
    stampsAfter: integer('stamps_after'),
    stampTarget: integer('stamp_target'),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('loyalty_event_salon_seq_idx').on(t.salonId, t.seq.desc()),
    index('loyalty_event_member_seq_idx').on(t.memberId, t.seq.desc()),

    /**
     * A climb that names no destination is not a climb. `from_tier` stays
     * nullable — a member's first rung has nothing below it — but `to_tier` is
     * the whole content of the event.
     */
    check(
      'loyalty_event_climb_has_destination',
      sql`${t.kind} <> 'tier_climb' OR ${t.toTier} IS NOT NULL`,
    ),
    check(
      'loyalty_event_stamp_has_card',
      sql`${t.kind} <> 'stamp_reward_ready'
          OR (${t.stampsAfter} IS NOT NULL AND ${t.stampTarget} IS NOT NULL)`,
    ),
    // The two modes are exclusive, exactly as `salon.loyalty_mode` is.
    check(
      'loyalty_event_kind_matches_fields',
      sql`(${t.kind} = 'tier_climb' AND ${t.stampsAfter} IS NULL)
          OR (${t.kind} = 'stamp_reward_ready' AND ${t.toTier} IS NULL)`,
    ),
  ],
);
