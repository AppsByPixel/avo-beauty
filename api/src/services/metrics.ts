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
 *
 * ==========================================================================
 * `?branch=` — AND WHY THREE OF THESE SEVEN FIGURES ANSWER IT DIFFERENTLY
 * ==========================================================================
 * The dashboard shell grew a branch selector, so this endpoint takes the same
 * `?branch=` Reports does, parsed by the same `services/branchFilter.ts`. Absent,
 * empty or `all` is every branch and is byte-for-byte what this file returned
 * before the parameter existed.
 *
 * The tempting implementation is one `AND branch_id = $b` pasted into all four
 * queries. It is wrong in two different ways, and they are worth separating
 * because only one of them is fixable.
 *
 * ---- 1. A TOP-UP HAS NO BRANCH. NOT "AN UNKNOWN BRANCH" — NO BRANCH. --------
 *
 * `loadedTodayFils` and `knetSharePercent` are computed over `kind = 'topup'`,
 * and `services/topup.ts` writes EVERY one of those rows `branch_assumed = true`
 * unconditionally, saying so in as many words: "A TOP-UP HAS NO BRANCH TO
 * ESTABLISH — it happens on a phone." The branch on the row exists because
 * `transaction.branch_id` is NOT NULL, and it is whichever branch sorts first.
 *
 * So this is not a gap that device enrolment will close. It is a category error:
 * money loaded in a customer's living room is not footfall at a branch, and it
 * never will be. Filtering it would hand a two-branch salon its ENTIRE day's
 * takings under whichever branch sorts first alphabetically and `0.000 KD` under
 * the other — a confident false statement about her own till, made in the one
 * place this file's header exists to prevent it.
 *
 * `loadedTodayFils` and `knetSharePercent` are therefore **null whenever a branch
 * is applied**, and non-null whenever it is not. Not zero, not the salon-wide
 * figure quietly relabelled: null, so the tile has to render "not available per
 * branch" and cannot render a number the merchant would read as Salmiya's.
 * Required-but-nullable, the same discipline `nextAppointmentAt` uses — a client
 * that forgets it fails loudly at the schema rather than drawing a wrong figure.
 *
 * ---- 2. THE OTHER THREE CAN BE BRANCH-SCOPED, BUT NOT EXACTLY (YET) ---------
 *
 * `activeMembers`, `repeatRatePercent` and `upcomingAppointments` come from rows
 * that DO have a real branch in principle — a charge and a booking happen
 * somewhere. Whether the row RECORDS that is what `branch_assumed` says, and
 * today, at a multi-branch salon, `services/branch.ts` marks every one of them
 * assumed: the server cannot tell where a staff member is standing until a
 * branch-bound scanner session ships. `db/schema/transaction.ts` § branch_assumed
 * is the long version.
 *
 * Which leaves the honest choice the column was created for. Exclude the assumed
 * rows, include them, or report them separately:
 *
 *   EXCLUDE — every per-branch tile at every multi-branch salon reads 0 today.
 *     That is the worst of the three: it discards revenue that certainly happened
 *     somewhere in this salon, and it renders as "nothing happened at Salmiya",
 *     which is a stronger and more wrong claim than any of the alternatives.
 *
 *   INCLUDE SILENTLY — the number looks exact and is not, and the merchant has no
 *     way to tell. This is the state `branch_assumed` was added to end: "the only
 *     honest answer to 'is this branch total right' is 'we cannot tell'. With it,
 *     the answer is a WHERE clause."
 *
 *   REPORT SEPARATELY — include them in the figure, and say how many of the rows
 *     behind that figure were inferred. Chosen.
 *
 * The deciding argument is not that it is the middle option, it is that it is the
 * only one that DEGRADES CORRECTLY. `branchAssumed` is a count, not a boolean: it
 * is the SIZE of the doubt. Equal to the figure's own row count means the whole
 * thing is a guess; `0` means it is exact. When branch-bound sessions land, those
 * counts fall to zero on their own and the caveat disappears from the UI without
 * a line of API or client code changing. Excluding or including silently both
 * need a code change on the day the world improves, and a rule that has to be
 * revisited to stay true is a rule that will be found stale — this file has
 * already shipped one of those (see `upcomingAppointments` below).
 *
 * `branchAssumed` is null when no branch is applied. There is nothing to doubt
 * about a salon-wide total: a row attributed to the wrong branch is still inside
 * the salon, so every figure here is exact at `branch=all` no matter how many
 * rows are assumed. THAT is why the caveat is per-branch and not permanent.
 *
 * ---- WHAT IS DELIBERATELY NOT DONE -----------------------------------------
 *
 * NO METRIC IS REDEFINED BY THE FILTER. `activeMembers` still counts distinct
 * members with any settled transaction — top-ups and console adjustments
 * included, both of which are always `branch_assumed` — rather than quietly
 * narrowing to charges when a branch is selected. Two definitions of one label,
 * switched by a query parameter, is precisely the "two answers to one question"
 * this file's header forbids. The contamination is real and it is reported, in
 * `branchAssumed.activeMembers`, instead of being hidden by a second definition.
 *
 * PER-BRANCH `activeMembers` DOES NOT SUM TO THE ALL-BRANCHES FIGURE, and that is
 * arithmetic rather than a defect: it is a DISTINCT count, so a customer who
 * visited both branches is 1 at each and 1 in the total, not 2. The sums that do
 * add up are the additive ones — `loadedTodayFils` would, which is the one figure
 * not offered per branch. Anything reconciling branches against a salon total
 * needs to know this, so it is written here rather than discovered.
 */

import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import type { BranchFilter } from './branchFilter';
import { salonWallClock, parseDate, wallClockInstant } from '../time/zone';
import { resolveWindow, type Period } from './period';

/**
 * The SIZE of the doubt behind a per-branch figure — how many of the rows that
 * produced it had their branch INFERRED rather than recorded. Null at
 * `branch=all`, where there is nothing to doubt. See the header.
 *
 * A count and not a flag, deliberately: `0` is "exact", and a value equal to the
 * figure's own row count is "entirely a guess". A boolean collapses those into
 * "some", which is the least actionable of the three.
 */
export interface BranchAssumedCounts {
  /**
   * Of the `activeMembers` counted at this branch, how many were counted ONLY on
   * inferred rows. A member with even one recorded transaction here really was
   * here, so she is not in this number however many assumed rows she also has.
   */
  activeMembers: number;
  /** Charges behind `repeatRatePercent` whose branch was inferred. */
  visits: number;
  /** Charges behind `repeatRatePercent` in total — the denominator for `visits`. */
  visitsTotal: number;
  /** Bookings in `upcomingAppointments` whose branch was inferred. */
  upcomingAppointments: number;
}

export interface SalonMetrics {
  activeMembers: number;
  activeMembersDelta: number;
  /**
   * NULL WHENEVER A BRANCH IS APPLIED, and never null otherwise. A top-up has no
   * branch — see the header — so there is no per-branch answer to give and a
   * zero would be read as one. The invariant is exact:
   * `loadedTodayFils === null` ⟺ `branchId !== null`.
   */
  loadedTodayFils: number | null;
  /** Null under exactly the same condition, and over exactly the same set. */
  knetSharePercent: number | null;
  repeatRatePercent: number;
  upcomingAppointments: number;
  /**
   * ISO instant (with offset) of the next still-to-start booking, or null when
   * the count is 0. SAME QUERY as the count — see the Upcoming block below.
   * `SalonMetricsSchema` declared this before it was served (widen-then-serve);
   * once this ships, the schema's `.optional()` comes off.
   */
  nextAppointmentAt: string | null;
  /** The branch actually applied. `null` means every branch — today's behaviour. */
  branchId: string | null;
  /**
   * Its name, echoed so the client does not have to hold a second lookup to
   * label a tile it already has the figures for. Null with `branchId`.
   */
  branchName: string | null;
  /** Null ⟺ `branchId` is null. */
  branchAssumed: BranchAssumedCounts | null;
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
  /**
   * Already resolved and already proved to belong to this salon —
   * `services/branchFilter.ts`, called by the route. This function takes the
   * RESOLVED branch and not the raw query value on purpose: the tenancy check is
   * the load-bearing half of `?branch=`, and a service that accepted a string
   * would be a second place it could be forgotten.
   */
  branch: BranchFilter | null = null,
): Promise<SalonMetrics> {
  /**
   * THE WINDOW, WHICH IS NOW EITHER ROLLING OR CALENDAR - `services/period.ts`.
   *
   * `?period=30d` resolves to exactly what this function computed before ranges
   * existed: `[now - 30 days, now)`. `?period=2026-03-01_2026-03-31` resolves to
   * the salon's own 1 March to 31 March. The three WINDOW figures below read the
   * resolved bounds; the two TODAY figures do not, and that split is the next
   * paragraph.
   */
  const win = resolveWindow(period, salon.timezone, now);
  const branchId = branch?.id ?? null;

  /**
   * The filter fragment, or NOTHING AT ALL. Empty `sql``` rather than `AND TRUE`,
   * so an unfiltered call emits SQL byte-identical to what this file ran before
   * `?branch=` existed — backwards compatibility as a property of the query
   * rather than a hope about the planner. `services/reports.ts` § computeReport
   * uses the same shape for the same reason.
   *
   * Both tables it is spliced into name the column `branch_id` and neither query
   * aliases it, so one fragment serves all four.
   */
  const atBranch = branchId === null ? sql`` : sql`AND branch_id = ${branchId}`;

  // ---------------------------------------------------------- the day ------
  /**
   * TODAY IS STILL TODAY, AND A SELECTED RANGE DOES NOT MOVE IT. Both tiles that
   * use these bounds are labelled "today" in the design - "Loaded today" and
   * "Upcoming today" - and today is a fact about the wall clock, not about the
   * window the merchant is looking at. Anchored to `now`, therefore, not to
   * `win`: a merchant reviewing March 2026 still sees what has been loaded today
   * and who is still to arrive today, which is what those two labels promise.
   *
   * Stated here because it is the one place a range REACHES THIS FILE AND STOPS,
   * and a reader who assumed `?period=` moved all seven figures would be wrong
   * about two of them. Lane C has the other half of it: the two "today" tiles
   * must not be drawn inside a date-range selection without saying so.
   */
  // The salon's own midnight, both ends, as real instants.
  const today = parseDate(salonWallClock(now, salon.timezone).date);
  const dayStart = wallClockInstant(today, 0, salon.timezone);
  // 1440 minutes past midnight rather than "tomorrow at 00:00" — one call, and
  // `wallClockInstant` normalises the overflow, so a month boundary needs no
  // special case.
  const dayEnd = wallClockInstant(today, 1440, salon.timezone);

  const windowStart = win.fromInstant;
  const windowEnd = win.toInstant;
  /**
   * THE SAME WINDOW, ENDED A WEEK EARLIER - the `+48 this week` comparison, and
   * it is now measured against THE WINDOW'S OWN END rather than against `now`.
   *
   * For every rolling preset `windowEnd === now`, so this is byte-identical to
   * what it was: `30d` still compares `[now-30d, now)` against `[now-37d,
   * now-7d)`. For a calendar range it is the only definition that stays true to
   * the field's own documentation - "the same measurement taken a week ago".
   * Anchored to `now` instead, a merchant selecting March 2026 in September would
   * have had her delta computed against a window six months AFTER the one she was
   * looking at, and the tile would have read as a change in her March figures.
   *
   * THE SPAN IS TAKEN FROM THE INSTANTS, not from `win.days`, so a calendar range
   * and its prior window have identical duration to the millisecond.
   *
   * AND THIS IS NOT `?compare=`. `services/period.ts` § Compare argues it at
   * length: the two windows here OVERLAP by design (23 days of them, at `30d`),
   * because this tile answers "how many more members are active now than a week
   * ago". A report's `?compare=` answers "this window against that one" and its
   * windows do not overlap. Two different statistics, deliberately not unified -
   * which is why `?compare=` is not accepted by this endpoint at all.
   */
  const span = windowEnd.getTime() - windowStart.getTime();
  const priorEnd = new Date(windowEnd.getTime() - 7 * 86_400_000);
  const priorStart = new Date(priorEnd.getTime() - span);

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
  /**
   * `current_recorded` IS THE SUBSET WE CAN ACTUALLY PLACE HERE: members with at
   * least one transaction at this branch whose branch was recorded rather than
   * inferred. `current - current_recorded` is then the assumed count, and that
   * subtraction is the right way round — a member with one recorded row and nine
   * assumed ones genuinely was here, so she must not be reported as doubtful.
   * `count(DISTINCT ...) FILTER (WHERE branch_assumed)` would have counted her in
   * both buckets, which is why the negative is taken rather than the positive.
   *
   * It costs nothing at `branch=all`, where it is computed and discarded — one
   * aggregate rather than a second query that could drift from the first, the
   * argument `upcomingAppointments` already makes below.
   *
   * (Prose lives out here, not inside the template. A backtick inside a tagged
   * template CLOSES it, and a comment containing one turns the rest of the query
   * into TypeScript. Found by running it: eleven parse errors, none of them near
   * the real line.)
   */
  const activeRows = await db.execute(sql`
    SELECT
      count(DISTINCT member_id) FILTER (
        WHERE created_at >= ${at(windowStart)} AND created_at < ${at(windowEnd)}
      ) AS current,
      count(DISTINCT member_id) FILTER (
        WHERE created_at >= ${at(windowStart)} AND created_at < ${at(windowEnd)}
          AND NOT branch_assumed
      ) AS current_recorded,
      count(DISTINCT member_id) FILTER (
        WHERE created_at >= ${at(priorStart)} AND created_at < ${at(priorEnd)}
      ) AS prior
    FROM "transaction"
    WHERE salon_id = ${salon.id}
      AND status = 'settled'
      AND created_at >= ${at(priorStart)}
      ${atBranch}
  `);
  const active = (
    activeRows as unknown as Array<{ current: unknown; current_recorded: unknown; prior: unknown }>
  )[0];
  const activeMembers = int(active?.current);
  const activeMembersDelta = activeMembers - int(active?.prior);
  const activeMembersAssumed = activeMembers - int(active?.current_recorded);

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
  /**
   * NOT RUN AT ALL WHEN A BRANCH IS APPLIED, and the query is skipped rather than
   * filtered-and-discarded so that nobody can later "fix" this by deleting a
   * `null` and shipping the number. There is no correct per-branch value for it
   * to compute: see the header — a top-up happens on a phone, and every one of
   * these rows is `branch_assumed` by construction rather than by a gap.
   */
  const loadedRows =
    branchId === null
      ? await db.execute(sql`
    SELECT
      coalesce(sum(amount_fils), 0)::bigint AS total,
      coalesce(sum(amount_fils) FILTER (WHERE method = 'knet'), 0)::bigint AS knet
    FROM "transaction"
    WHERE salon_id = ${salon.id}
      AND kind = 'topup'
      AND status = 'settled'
      AND created_at >= ${at(dayStart)}
      AND created_at < ${at(dayEnd)}
  `)
      : null;
  const loaded =
    loadedRows === null
      ? null
      : (loadedRows as unknown as Array<{ total: unknown; knet: unknown }>)[0];
  const loadedTodayFils = loaded === null ? null : int(loaded?.total);
  const knetSharePercent =
    loadedTodayFils === null ? null : percent(int(loaded?.knet), loadedTodayFils);

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
  /**
   * `visits_total` / `visits_assumed` are the VISITS behind the rate and how many
   * of them were inferred — charges, not members, because the rate is a ratio and
   * a caveat on a ratio needs a scale. "62%, and 30 of the 30 visits it rests on
   * were guesses" is actionable; "62%, approximately" is not.
   */
  /**
   * THE UPPER BOUND ON THIS WINDOW IS NEW, AND IT WAS A LATENT DEFECT RATHER THAN
   * A CHANGE. This query had `created_at >= windowStart` and no end at all, which
   * was harmless for as long as every window ended at `now`: nothing is settled in
   * the future, so the open end selected nothing extra. A CALENDAR RANGE ENDS IN
   * THE PAST, and without the bound a merchant asking for March would have had her
   * repeat rate computed over March-to-today. Found by the range, not by the tile.
   */
  const repeatRows = await db.execute(sql`
    SELECT
      count(*) AS visitors,
      count(*) FILTER (WHERE visits > 1) AS repeaters,
      coalesce(sum(visits), 0) AS visits_total,
      coalesce(sum(assumed), 0) AS visits_assumed
    FROM (
      SELECT
        member_id,
        count(*) AS visits,
        count(*) FILTER (WHERE branch_assumed) AS assumed
      FROM "transaction"
      WHERE salon_id = ${salon.id}
        AND kind = 'charge'
        AND status = 'settled'
        AND created_at >= ${at(windowStart)}
        AND created_at < ${at(windowEnd)}
        ${atBranch}
      GROUP BY member_id
    ) AS per_member
  `);
  const repeat = (
    repeatRows as unknown as Array<{
      visitors: unknown;
      repeaters: unknown;
      visits_total: unknown;
      visits_assumed: unknown;
    }>
  )[0];
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
  /**
   * THE INSTANT COMES OUT OF THE SAME QUERY AS THE COUNT — `min(starts_at)` over
   * the identical predicate, not a second query that can drift from the first. A
   * count of 3 beside a null "next", or a "next" outside the count's window, is a
   * contract violation rather than a rendering choice, and one SELECT makes the
   * disagreement unrepresentable: `min` over the rows `count` counted is null
   * exactly when the count is 0, by construction rather than by discipline.
   */
  /**
   * `upcoming_assumed` RIDES IN THE SAME QUERY, for the reason `next_at` does: a
   * caveat fetched separately from the figure it qualifies can disagree with it.
   * It is also the aggregate `services/branchClosure.ts` already reports beside
   * `depositHeldBookings`, and the marker `Appointments.tsx` already renders per
   * row — one fact, three surfaces, one meaning.
   */
  const upcomingRows = await db.execute(sql`
    SELECT count(*) AS upcoming,
           min(starts_at) AS next_at,
           count(*) FILTER (WHERE branch_assumed) AS upcoming_assumed
      FROM booking
     WHERE salon_id = ${salon.id}
       AND status = 'deposit_held'
       AND starts_at >= ${at(now)}
       AND starts_at < ${at(dayEnd)}
       ${atBranch}
  `);
  const upcomingRow = (
    upcomingRows as unknown as Array<{
      upcoming: unknown;
      next_at: unknown;
      upcoming_assumed: unknown;
    }>
  )[0];
  const upcomingAppointments = int(upcomingRow?.upcoming);
  /**
   * AN INSTANT, NOT A RENDERED TIME. `DateTimeSchema` is an ISO string with
   * offset; the dashboard localises it into "next at 4:30 PM" itself, in the
   * salon's zone and the viewer's language. Pre-formatting here would bake one
   * zone and one language into a field two languages read.
   *
   * The driver hands a raw-`sql` timestamptz back without a Drizzle column to
   * map through, so it is normalised through `Date` rather than trusted to
   * already be ISO — and `toISOString()`'s trailing `Z` is a valid offset for
   * `z.string().datetime({ offset: true })`.
   */
  const rawNext = upcomingRow?.next_at;
  const nextAppointmentAt =
    rawNext === null || rawNext === undefined
      ? null
      : new Date(rawNext as string | Date).toISOString();

  return {
    activeMembers,
    activeMembersDelta,
    loadedTodayFils,
    knetSharePercent,
    repeatRatePercent,
    /**
     * A REAL COUNT NOW, and since `nextAppointmentAt` landed in
     * `SalonMetricsSchema` (widen-then-serve), the tile's sub-label rides along —
     * both out of the one query above.
     */
    upcomingAppointments,
    nextAppointmentAt,
    branchId,
    branchName: branch?.name ?? null,
    /**
     * NULL AT `branch=all`, and the reason is not an omission. A row attributed
     * to the wrong branch is still inside the salon, so a salon-wide figure is
     * exact however many of its rows are assumed. The doubt this object measures
     * is created by the filter and does not exist without it.
     *
     * Built here rather than at each metric so the null-ness of all four counts
     * is one decision. `branchAssumed !== null` ⟺ `branchId !== null`, which is
     * what makes the pair safe to destructure in a client.
     */
    branchAssumed:
      branchId === null
        ? null
        : {
            activeMembers: activeMembersAssumed,
            visits: int(repeat?.visits_assumed),
            visitsTotal: int(repeat?.visits_total),
            upcomingAppointments: int(upcomingRow?.upcoming_assumed),
          },
  };
}
