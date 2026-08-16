/**
 * Member (the customer) — api-contract.md § Member.
 *
 * This table holds the single most important constraint in the product:
 *
 *   CHECK (balance_fils >= 0)
 *
 * A wallet that can go negative is credit, and AVO does not extend credit. The
 * charge handler also checks the balance and returns a 402 with the exact
 * shortfall — but that check is a *user experience*, not the guarantee. The
 * guarantee is here, where a race between two scanners, a retried job, or a
 * future handler nobody has written yet still cannot produce a negative wallet.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { fils } from '@avo/types';
import { filsColumn, timestamptz } from './_shared';
import { salon, tierName } from './salon';

export const member = pgTable(
  'member',
  {
    id: text('id').primaryKey(),
    salonId: text('salon_id')
      .notNull()
      .references(() => salon.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    /** E.164. Also the login identity — api-contract.md § Profile edit, rule 1. */
    phone: text('phone').notNull(),
    email: text('email'),
    emailVerified: boolean('email_verified').notNull().default(false),

    /**
     * argon2id. Non-negotiable #6: never plaintext, never returned by an
     * endpoint, never rendered. Reset is link-only.
     */
    passwordHash: text('password_hash').notNull(),

    /** Non-negotiable #2: the server owns this number. Clients only ever read it. */
    balanceFils: filsColumn('balance_fils').notNull().default(fils(0)),

    visits: integer('visits').notNull().default(0),
    tier: tierName('tier'),
    /** null when the salon runs tiers. */
    stamps: integer('stamps'),

    /** Non-negotiable #10: the published legal version accepted at signup. */
    policyVersion: integer('policy_version').notNull(),

    joinedAt: timestamptz('joined_at').notNull().defaultNow(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    // Phone is the login identity, so it is unique per salon — the same person
    // can hold a wallet at two salons.
    uniqueIndex('member_salon_phone_uq').on(t.salonId, t.phone),
    index('member_salon_idx').on(t.salonId),

    // ---------------------------------------------------------------------
    // THE constraint. Nothing in the application is trusted to hold this.
    // ---------------------------------------------------------------------
    check('member_balance_non_negative', sql`${t.balanceFils} >= 0`),

    check('member_phone_is_e164', sql`${t.phone} ~ '^\\+[1-9][0-9]{6,14}$'`),
    check('member_visits_non_negative', sql`${t.visits} >= 0`),
    check('member_stamps_non_negative', sql`${t.stamps} IS NULL OR ${t.stamps} >= 0`),
    check('member_policy_version_positive', sql`${t.policyVersion} > 0`),
  ],
);
