/**
 * Branch boosts and happy-hour windows — api-contract.md § Promotion set.
 *
 * THERE IS NO `live` COLUMN, AND THAT IS THE DESIGN
 * ------------------------------------------------
 * "A window is live if and only if `days.includes(now.getDay()) && from <= now
 * < to` in salon-local time." Liveness is a function of the row and the clock,
 * evaluated fresh by every reader. Storing it would create a second source of
 * truth that a cron job would have to keep in step with the first — and the
 * moment those two disagree, the disagreement is a wrong earning multiplier on a
 * real charge. Both clients resolve the predicate every second and the server
 * runs the SAME one (packages/types/src/rules.ts `isHappyHourLive`) at charge
 * time, so a stale banner cannot cause a wrong charge.
 *
 * `from` / `to` ARE WALL CLOCK, RESOLVED AGAINST `salon.timezone`
 * --------------------------------------------------------------
 * "16:00" is a rule about the week, not a moment. It is resolved against the
 * salon's zone (migration 0010, api/src/time/zone.ts) at the instant of
 * evaluation, never against the process zone. This is the third of the three
 * wall-clock surfaces the artists.ts finding named, and the only one where
 * getting it wrong costs money rather than a mis-booked appointment.
 *
 * A WINDOW MAY NOT CROSS MIDNIGHT, AND THE REASON IS AGREEMENT
 * -----------------------------------------------------------
 * `to` must be strictly after `from`. Nothing in api-contract.md says what
 * `22:00 → 02:00` means, so it is decided here: it is refused, and a merchant
 * who wants it writes two windows — `22:00 → 24:00` on Friday and `00:00 →
 * 02:00` on Saturday.
 *
 * This is not a simplification, it is forced. `isHappyHourLive` is the SHARED
 * implementation — imported by both clients and by this server precisely so they
 * cannot disagree — and it evaluates `from <= now < to`, which is empty whenever
 * `to <= from`. A server that special-cased a wrapping window would apply a
 * multiplier that every client renders as "not live". That is exactly the
 * client/server disagreement the no-`live`-flag design exists to prevent, and it
 * would show up as a customer charged at 1x while her wallet showed 2x.
 *
 * Allowing a wrap is therefore a `packages/types` change plus a re-release of
 * every surface that imports it — a coordinated change, not a lane A one. The
 * `24:00` sentinel is what makes the two-window workaround lossless: it parses
 * to 1440 through the shared `hhmmToMinutes` with no change to anything, and
 * `minutes < 1440` is true for every real clock reading, so `22:00 → 24:00`
 * covers the day to its last second. `to: "23:59"` would leave a dead minute.
 */

import { sql } from 'drizzle-orm';
import {
  check,
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
} from 'drizzle-orm/pg-core';
import { timestamptz } from './_shared';
import { branch, salon } from './salon';

/** api-contract.md § Promotion set: the six reward keys, and only these. */
export const REWARD_KEYS = [
  'x2stamp',
  'x3stamp',
  'x2visit',
  'topup10',
  'topup20',
  'credit3',
] as const;

/**
 * Per-branch boosts. `{ [branchId]: { visit, topup, stamp } }` on the wire.
 *
 * A TABLE RATHER THAN A jsonb COLUMN ON `salon`, which is the opposite of the
 * call `salon.tiers` made — and for the reason that made that call: atomicity of
 * the thing that must publish as a unit. A tier ladder is one document because a
 * half-published ladder is a money bug. Boosts are per branch, each branch's row
 * is independently meaningful, and `PUT .../boosts` replaces them inside ONE
 * transaction anyway, so the jsonb buys nothing and costs the FK to `branch`
 * that stops a boost outliving the branch it applies to.
 *
 * `published_at` / `published_by` sit on every row and are written identically
 * across the set in one statement. The contract's single `boostsPublishedAt` is
 * the max over them.
 */
export const boost = pgTable(
  'boost',
  {
    salonId: text('salon_id')
      .notNull()
      .references(() => salon.id, { onDelete: 'restrict' }),
    branchId: text('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),

    /** 1..3. 1 is "no boost", which is why the floor is 1 and not 0. */
    visit: integer('visit').notNull().default(1),
    /** 0..30 percentage POINTS, added on top of the tier bonus. 0 is no boost. */
    topup: integer('topup').notNull().default(0),
    /** 1..3, same reasoning as `visit`. */
    stamp: integer('stamp').notNull().default(1),

    publishedAt: timestamptz('published_at').notNull().defaultNow(),
    publishedBy: text('published_by').notNull(),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.salonId, t.branchId] }),
    // The dashboard's steppers stop at these bounds. Non-negotiable #7: the UI
    // stopping is a courtesy, this is the control. A `visit: 50` reaching the
    // database would multiply a customer's loyalty standing by fifty.
    check('boost_visit_in_range', sql`${t.visit} BETWEEN 1 AND 3`),
    check('boost_topup_in_range', sql`${t.topup} BETWEEN 0 AND 30`),
    check('boost_stamp_in_range', sql`${t.stamp} BETWEEN 1 AND 3`),
  ],
);

export const happyHour = pgTable(
  'happy_hour',
  {
    /** "HH-01" — the customer-visible id, stable across edits. */
    id: text('id').primaryKey(),
    salonId: text('salon_id')
      .notNull()
      .references(() => salon.id, { onDelete: 'restrict' }),

    /**
     * NULL means "all branches", which the wire shape spells `"all"`.
     *
     * A nullable FK rather than a text column holding the literal string 'all':
     * the string would make `branch_id` unreferenceable, so a deleted branch
     * would leave a window pointing at nothing and the serialiser would emit a
     * branch id no client can resolve. NULL is a value the database understands
     * and `ON DELETE restrict` covers the rest. The translation is one line in
     * the serialiser.
     */
    branchId: text('branch_id').references(() => branch.id, { onDelete: 'restrict' }),

    /** JS getDay() order, 0 = Sunday. At least one day; a window on no day is not a window. */
    days: smallint('days').array().notNull(),

    /** Salon-local wall clock, "HH:MM". `to` may be "24:00" — see the file header. */
    from: text('from').notNull(),
    to: text('to').notNull(),

    reward: text('reward').notNull(),

    /**
     * `on: false` is a window the merchant has switched off, NOT one she
     * deleted. It keeps its days and times so switching it back on restores what
     * she configured. `isHappyHourLive` returns false for it inside its own
     * window — the shared predicate's first line — so this is not a second
     * liveness concept, it is an input to the only one.
     */
    on: boolean('on').notNull().default(true),
    notify: boolean('notify').notNull().default(false),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('happy_hour_salon_idx').on(t.salonId),

    // The wire format, enforced. `24:00` is accepted on `to` only — see below —
    // and nowhere else, because "24:00" as a START is a window of length zero
    // dressed up as a time.
    check('happy_hour_from_is_hhmm', sql`${t.from} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`),
    check('happy_hour_to_is_hhmm', sql`${t.to} ~ '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$'`),

    /**
     * THE MIDNIGHT DECISION, AS A DATABASE FACT.
     *
     * Lexicographic comparison is exactly right here and is not a shortcut:
     * zero-padded HH:MM sorts identically to the minute values it denotes, and
     * '24:00' sorts above every real time. A row with `to <= from` would be a
     * window the shared predicate reports as never live while a merchant sees it
     * listed as configured — silently dead rather than loudly refused.
     */
    check('happy_hour_to_after_from', sql`${t.to} > ${t.from}`),

    check(
      'happy_hour_days_valid',
      sql`array_length(${t.days}, 1) BETWEEN 1 AND 7 AND ${t.days} <@ ARRAY[0,1,2,3,4,5,6]::smallint[]`,
    ),
    check(
      'happy_hour_reward_known',
      sql`${t.reward} IN ('x2stamp', 'x3stamp', 'x2visit', 'topup10', 'topup20', 'credit3')`,
    ),
  ],
);
