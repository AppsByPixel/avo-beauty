/**
 * A phone-number change, in flight.
 *
 * The phone is the login identity (api-contract.md § Member), so moving it is
 * the most security-sensitive edit the wallet offers and cannot be a PATCH.
 * Rule 1: a 4–6 digit code to the NEW number, short-lived, attempt-limited,
 * rate-limited per member per hour, and the OLD number is told it happened.
 *
 * A challenge is an ATTEMPT, not a property of the customer — two can be live
 * after a mistyped number, and the rate limit is a count over attempts, which a
 * column on `member` could not express.
 *
 * The code is argon2id-hashed for the reason the staff PIN is: four digits is
 * 10,000 possibilities, so a fast digest over a stolen dump is a list of live
 * codes. `attempts` and the lockout stop the online attack; the hash is what
 * makes the dump worthless.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from './_shared';
import { member } from './member';
import { salon } from './salon';

export const phoneChangeChallenge = pgTable(
  'phone_change_challenge',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    memberId: text('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    salonId: text('salon_id')
      .notNull()
      .references(() => salon.id, { onDelete: 'restrict' }),

    /**
     * Stored in clear, deliberately: it is the value being moved to, and the
     * verify step compares it against the salon's uniqueness index before it
     * writes. Hashing it would need a second plaintext copy somewhere to do
     * that check at all.
     */
    newPhone: text('new_phone').notNull(),
    /**
     * The number the notice is owed to, copied in at creation rather than read
     * from `member` at verify time — it must be the number as it was when the
     * change was started, not whatever the row says afterwards.
     */
    oldPhone: text('old_phone').notNull(),

    /** argon2id. Never the code. */
    codeHash: text('code_hash').notNull(),

    attempts: integer('attempts').notNull().default(0),
    expiresAt: timestamptz('expires_at').notNull(),
    verifiedAt: timestamptz('verified_at'),
    /** Set when the attempt limit is hit. A locked challenge is dead. */
    lockedAt: timestamptz('locked_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('phone_change_member_created_idx').on(t.memberId, t.createdAt.desc()),
    check('phone_change_attempts_non_negative', sql`${t.attempts} >= 0`),
    check('phone_change_new_phone_is_e164', sql`${t.newPhone} ~ '^\\+[1-9][0-9]{6,14}$'`),
    check('phone_change_expires_after_creation', sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);
