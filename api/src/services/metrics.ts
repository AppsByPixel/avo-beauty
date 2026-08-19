/**
 * Overview's stat tiles — `GET /salons/{id}/metrics?period=`.
 *
 * design/AVO Merchant Dashboard.dc.html § kpis is the whole specification and it
 * is four labels with four numbers next to them:
 *
 *   Active members   1,284      +48 this week
 *   Loaded today     312.500 KD 78% via KNET
 *   Repeat rate      62%        +4 pts vs last month
 *   Upcoming today   18         next at 4:30 PM
 *
 * A label is not a definition. "Active" could mean signed up, or transacted, or
 * transacted recently; "repeat rate" could be measured over any window against
 * any denominator. Nobody wrote those down, so they are written down HERE, in
 * one place, next to the query that computes them — because the failure mode of
 * a metric is not a crash, it is a merchant making a decision on a number that
 * means something other than what she thinks. Each one below says what it counts
 * and what it deliberately does not.
 *
 * "TODAY" IS A QUESTION ABOUT A ZONE
 * ----------------------------------
 * `loadedTodayFils` is the third place `salon.timezone` earns its keep. A salon
 * closes at 21:00 Kuwait, which is 18:00Z; a "today" computed from the process
 * zone under docker-compose's TZ=UTC would roll over at 03:00 Kuwait, so the
 * last three hours of every evening's takings would land on the previous day's
 * tile. The merchant would see a number she could not reconcile against her own
 * till and would have no way to tell it was a boundary rather than a loss.
 *
 * So the day boundary is `wallClockInstant(salonToday, 00:00, salon.timezone)`
 * and the window is half-open, [today, tomorrow).
 *
 * MONEY IS INTEGER FILS, INCLUDING IN AN AGGREGATE
 * -----------------------------------------------
 * `sum()` over an integer column in Postgres returns numeric, which arrives as a
 * string through postgres.js and becomes a float the moment anything does
 * arithmetic on it. Every sum below is cast to ::bigint in SQL and put through
 * `Number()` here, and the percentages are computed from integers and rounded to
 * integers. Non-negotiable #1 does not stop at the edge of a report.
 */

import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { salonWallClock, parseDate, wallClockInstant } from '../time/zone';
import { badRequest } from '../http/errors';

/** api-contract.md § Operations: `?period=`. The membership window. */
export const PERIODS = ['7d', '30d', '90d'] as const;
export type Period = (typeof PERIODS)[number];

export function parsePeriod(value: unknown): Period {
  if (value === undefined || value === null || value === '') return '30d';
  if (!(PERIODS as readonly string[]).includes(String(value))) {
    throw badRequest('invalid_period', `period must be one of ${PERIODS.join(', ')}.`);
  }
  return value as Period;
}

/**
 * EXPORTED so services/reports.ts measures the same window this does. A report
 * whose "30d" differed from the Overview tile's "30d" would be two answers to one
 * question, which is the failure this file's header is entirely about.
 */
export const PERIOD_DAYS: Record<Period, number> = { '7d': 7, '30d': 30, '90d': 90 };

export interface SalonMetrics {
  activeMembers: number;
  activeMembersDelta: number;
  loadedTodayFils: number;
  knetSharePercent: number;
  repeatRatePercent: number;
  upcomingAppointments: number;
}

/**
 * An instant, as a parameter these raw queries can actually bind.
 *
 * FOUND BY RUNNING IT: a `Date` interpolated into a `sql` template reaches
 * postgres.js with no column type to infer from — there is no Drizzle column on
 * either side of the comparison in a raw aggregate — and it fails with
 *
 *     TypeError [ERR_INVALID_ARG_TYPE]: The "string" argument must be of type
 *     string ... Received an instance of Date
 *
 * which surfaces as a 500 on a read-only endpoint. ISO text plus an explicit
 * `::timestamptz` gives the driver a string and the planner an unambiguous type,
 * and keeps the comparison on the indexed side of `created_at`.
 */
export function at(instant: Date) {
  return sql`${instant.toISOString()}::timestamptz`;
}

/**
 * A whole number from a Postgres aggregate, which arrives as a string or null.
 *
 * EXPORTED for services/reports.ts, which faces the same problem on every sum it
 * takes. A second copy of this would be a second place for a float to sneak into
 * money — non-negotiable #1 is easier to hold with one funnel than with two.
 */
export function int(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** Integer percent of a of b. 0 when b is 0 — never NaN, never Infinity. */
function percent(a: number, b: number): number {
  if (b <= 0) return 0;
  return Math.round((a * 100) / b);
}

export async function computeMetrics(
  db: Db,
  salon: { id: string; timezone: string },
  period: Period,
  now = new Date(),
): Promise<SalonMetrics> {
  const days = PERIOD_DAYS[period];

  // ---------------------------------------------------------- the day ------
  // The salon's own midnight, both ends, as real instants.
  const today = parseDate(salonWallClock(now, salon.timezone).date);
  const dayStart = wallClockInstant(today, 0, salon.timezone);
  // 1440 minutes past midnight rather than "tomorrow at 00:00" — one call, and
  // `wallClockInstant` normalises the overflow, so a month boundary needs no
  // special case.
  const dayEnd = wallClockInstant(today, 1440, salon.timezone);

  const windowStart = new Date(now.getTime() - days * 86_400_000);
  /** The same window, ended a week earlier. The `+48 this week` comparison. */
  const priorEnd = new Date(now.getTime() - 7 * 86_400_000);
  const priorStart = new Date(priorEnd.getTime() - days * 86_400_000);

  /**
   * ACTIVE MEMBERS — distinct members with at least one SETTLED transaction in
   * the window.
   *
   * Not `count(*) FROM member`, which is registrations and only ever goes up: a
   * salon that signed 1,284 wallets in its first month and saw 40 of them again
   * would read 1,284 for ever, and the tile would be a vanity number rather
   * than a decision. Not `member.updated_at` either — that moves when a customer
   * edits her email.
   *
   * `settled` only. A pending or failed top-up is an attempt, not activity.
   *
   * THE DELTA is the same measurement taken a week ago — the identical window
   * length, ending seven days earlier — so `+48 this week` means "48 more
   * members are active now than were active this time last week", which is what
   * the copy claims. It is signed: a salon losing customers sees a negative
   * number rather than a zero.
   */
  const activeRows = await db.execute(sql`
    SELECT
      count(DISTINCT member_id) FILTER (
        WHERE created_at >= ${at(windowStart)} AND created_at < ${at(now)}
      ) AS current,
      count(DISTINCT member_id) FILTER (
        WHERE created_at >= ${at(priorStart)} AND created_at < ${at(priorEnd)}
      ) AS prior
    FROM "transaction"
    WHERE salon_id = ${salon.id}
      AND status = 'settled'
      AND created_at >= ${at(priorStart)}
  `);
  const active = (activeRows as unknown as Array<{ current: unknown; prior: unknown }>)[0];
  const activeMembers = int(active?.current);
  const activeMembersDelta = activeMembers - int(active?.prior);

  /**
   * LOADED TODAY — what actually landed in wallets today, and the KNET share of
   * it.
   *
   * `amount_fils` on a settled `topup` row is the CREDIT, bonus included (see
   * services/topup.ts § creditWallet), and that is the right number for a tile
   * labelled "loaded": it is what the customer can now spend and what the
   * merchant is on the hook for. The commission is not deducted from it and the
   * bonus is not stripped out of it.
   *
   * KNET SHARE is computed over the same set, by value rather than by count —
   * "78% via KNET" next to a dinar figure is a share of that figure. Both halves
   * come out of ONE query so they cannot be computed over two different sets by
   * a later edit.
   */
  const loadedRows = await db.execute(sql`
    SELECT
      coalesce(sum(amount_fils), 0)::bigint AS total,
      coalesce(sum(amount_fils) FILTER (WHERE method = 'knet'), 0)::bigint AS knet
    FROM "transaction"
    WHERE salon_id = ${salon.id}
      AND kind = 'topup'
      AND status = 'settled'
      AND created_at >= ${at(dayStart)}
      AND created_at < ${at(dayEnd)}
  `);
  const loaded = (loadedRows as unknown as Array<{ total: unknown; knet: unknown }>)[0];
  const loadedTodayFils = int(loaded?.total);
  const knetSharePercent = percent(int(loaded?.knet), loadedTodayFils);

  /**
   * REPEAT RATE — of the members who visited in the window, the share who
   * visited more than once.
   *
   * A VISIT IS A CHARGE, not a transaction. A customer who topped up twice and
   * never came in is not a repeat visitor, and counting her would make the tile
   * rise when the salon is emptier and the wallets are fuller — exactly
   * backwards from what a merchant would act on.
   *
   * The denominator is members who visited AT ALL in the window, not the whole
   * member list, so a salon with a long tail of dormant wallets is not
   * permanently reported at 4%.
   */
  const repeatRows = await db.execute(sql`
    SELECT
      count(*) AS visitors,
      count(*) FILTER (WHERE visits > 1) AS repeaters
    FROM (
      SELECT member_id, count(*) AS visits
      FROM "transaction"
      WHERE salon_id = ${salon.id}
        AND kind = 'charge'
        AND status = 'settled'
        AND created_at >= ${at(windowStart)}
      GROUP BY member_id
    ) AS per_member
  `);
  const repeat = (repeatRows as unknown as Array<{ visitors: unknown; repeaters: unknown }>)[0];
  const repeatRatePercent = percent(int(repeat?.repeaters), int(repeat?.visitors));

  /**
   * UPCOMING TODAY — bookings still to start, before the salon's own midnight.
   *
   * THIS WAS HARDCODED `0` AND THE COMMENT EXPLAINING WHY WENT STALE. It read
   * "there is no `booking` table … the moment bookings land this becomes a count
   * and nothing else moves". Bookings landed: `db/schema/booking.ts` defines the
   * table, `routes/bookings.ts` writes it, `GET /salons/{id}/bookings` reads it.
   * So an honest zero had quietly become a live tile permanently reporting none —
   * the third stale "not built" comment found in `api/src` on this build. The
   * comment was right when written, which is exactly what makes the shape
   * dangerous: nothing fails when the world catches up with it.
   *
   * `deposit_held` ONLY, and each exclusion is a decision rather than a filter
   * inherited from somewhere else:
   *
   *   `completed`         — already happened. Not upcoming.
   *   `no_show_returned`  — she did not arrive and the deposit went back. Resolved,
   *                         not pending; counting it would tell a merchant to keep
   *                         a chair free for somebody who is not coming.
   *   `cancelled`         — not a booking any more.
   *
   * `booking_settlement_matches_status` makes this precise rather than a guess:
   * held ⟺ nothing settled it, so `deposit_held` IS the set of bookings that have
   * not yet resolved into anything.
   *
   * STILL TO START, not "booked today", and the design's own sub-label is the
   * argument: "Upcoming today · 18 · next at 4:30 PM". A count that included the
   * morning's finished appointments could read 18 with no "next" at all, and a
   * merchant reads this tile to know what is LEFT in her day. So the lower bound is
   * `now`, not midnight. A 10:00 booking still sitting in `deposit_held` at 16:00 is
   * therefore excluded — it is overdue, not upcoming, and both filters are doing
   * real work rather than one covering for the other.
   *
   * THE UPPER BOUND IS THE SALON'S MIDNIGHT, reusing the `dayEnd` that
   * `loadedTodayFils` already computes from `salon.timezone`. It has to be: this
   * machine runs PKT, two hours ahead of Kuwait, so between 21:00 and 23:59 Kuwait
   * a host-clock "today" is already tomorrow and the tile would drop the evening's
   * remaining appointments — the same boundary that put a 21:30Z charge on the wrong
   * day in services/reports.ts § sales.
   */
  const upcomingRows = await db.execute(sql`
    SELECT count(*) AS upcoming
      FROM booking
     WHERE salon_id = ${salon.id}
       AND status = 'deposit_held'
       AND starts_at >= ${at(now)}
       AND starts_at < ${at(dayEnd)}
  `);
  const upcomingAppointments = int(
    (upcomingRows as unknown as Array<{ upcoming: unknown }>)[0]?.upcoming,
  );

  return {
    activeMembers,
    activeMembersDelta,
    loadedTodayFils,
    knetSharePercent,
    repeatRatePercent,
    /**
     * A REAL COUNT NOW. See the query above for what it includes and what it
     * deliberately does not.
     *
     * The tile's SUB-LABEL is still not served: "next at 4:30 PM" needs the next
     * booking's start instant, and there is no field for it. Adding one means
     * editing `SalonMetricsSchema` in `packages/types`, which is trunk-owned and
     * consumed by four surfaces — so it is reported, not taken. Returning the field
     * without declaring it there would be worse than useless: zod STRIPS undeclared
     * keys rather than failing, so the dashboard would parse the response and
     * silently drop it, which is the contract drift this build has already found
     * five times.
     */
    upcomingAppointments,
  };
}
