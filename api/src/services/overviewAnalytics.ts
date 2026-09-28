/**
 * THE OVERVIEW'S ANALYTICS — `GET /v1/salons/{id}/overview/analytics?branch=&period=`.
 *
 * Aftab, 2026-09-29: "dashboard has only one graph widget and it looks so empty
 * otherwise. Fill it with various useful visuals and analytics (at least 10)".
 * Lane C draws the widgets; this file serves the data for the ones nothing else
 * already answers. `services/metrics.ts` is the precedent for everything here: a
 * metric's failure mode is not a crash, it is a merchant deciding on a number that
 * means something other than what she thinks, so every definition sits beside the
 * query that implements it.
 *
 * ==========================================================================
 * WHAT IS NOT HERE, BECAUSE IT ALREADY EXISTS
 * ==========================================================================
 *   Revenue by branch    `GET /salons/{id}/reports/earnings-by-branch`, gated
 *                        `dashboard` like this endpoint, same `?branch=&period=`.
 *                        Served there; a second copy here would be two answers.
 *   Four KPI tiles       `GET /salons/{id}/metrics`.
 *   Sales trend          `GET /salons/{id}/reports/sales`.
 *   Deposit detail       `GET /salons/{id}/deposits` (`appointments`) — the named
 *                        rows. The HELD TOTAL is below, with that file's predicate.
 *
 * ==========================================================================
 * ONE ENDPOINT, `dashboard`, AND FIVE BLOCKS THAT NEED MORE THAN THAT
 * ==========================================================================
 * `services/reports.ts § REPORT_PERMISSION` is the rule: a read inherits the
 * permission of the section whose data it serves, and a join resolves to the
 * STRICTEST. Counts and money totals are the Overview's own (`metrics` already
 * serves booking counts and top-up totals under `dashboard`). Five blocks are other
 * sections' data and are gated on that section AS WELL:
 *
 *   topServices   `appointments`   the `best-selling-services` report's gate
 *   artists       `team`           a named person's earnings — `artist-performance`
 *   upcoming.next `appointments`   customers' names on the appointment book
 *   shop          `shop`           `products-sold` and the orders board's gate
 *   campaigns     `marketing`      `GET /v1/salons/{id}/campaigns`' gate
 *
 * A block the caller may not see is `{ status: 'withheld', reason: 'permission',
 * permission }`, and ITS QUERY IS NOT RUN — the `loadedTodayFils` rule: skipping the
 * query rather than discarding its result means nobody can later "fix" a withheld
 * block by deleting a branch and shipping the number. The whole endpoint still
 * answers 403 without `dashboard` (non-negotiable #7).
 *
 * ==========================================================================
 * `?branch=`, AND THE FIVE BLOCKS THAT HAVE NO PER-BRANCH ANSWER
 * ==========================================================================
 * The metrics header's argument, applied block by block. A top-up has no branch; a
 * member has no branch; a balance has no branch; a campaign reaches customers, not
 * a branch's footfall. So `newMembers`, `loyalty`, `wallet`, `paymentMix` and
 * `campaigns` are `{ status: 'withheld', reason: 'not_per_branch' }` whenever a
 * branch is applied — not the salon-wide figure relabelled, and not a zero.
 *
 * The blocks that CAN be branch-scoped carry `branchAssumed: { assumed, total }` —
 * the SIZE of the doubt, the metrics shape: of the `total` rows behind the block,
 * `assumed` had their branch inferred. Null at `branch=all`, where a misattributed
 * row is still inside the salon and nothing is in doubt.
 *
 * ==========================================================================
 * INTEGERS ALL THE WAY DOWN
 * ==========================================================================
 * Every sum is `::bigint` in SQL and goes through `money()` (which refuses a
 * fraction, `depositHealth.ts § filsFrom`'s rule) or `int()` for counts. Shares are
 * BASIS POINTS (0–10000), computed by `basisPoints()` in BigInt and ROUNDED HALF UP.
 * There are no averages in this file.
 *
 * ==========================================================================
 * WHAT A VISIT IS HERE, AND WHERE THAT DIFFERS FROM `/metrics`
 * ==========================================================================
 * A visit is a settled `charge` (metrics' definition) that has NOT been voided
 * (reports' `NOT_VOIDED`). `metrics.repeatRatePercent` does not exclude voids, so a
 * voided `dupe` charge is two visits there and one here. That difference is
 * reported to trunk rather than resolved by editing the tile in this slice.
 */

import { sql, type SQL } from 'drizzle-orm';
import { add, fils, type Fils } from '@avo/types';
import type { Db } from '../db/client';
import type { PermissionName, StaffPerms } from '../auth/principal';
import type { BranchFilter } from './branchFilter';
import { at, int } from './metrics';
import { resolveWindow, serialiseWindow, type Period, type PeriodWindow } from './period';
import { NOT_VOIDED } from './reports';
import { revenueJoin, revenueLeftJoin } from '../money/revenue';
import {
  parseDate,
  salonWallClock,
  wallClockInstant,
  weekdayOf,
  type CalendarDate,
} from '../time/zone';

// ------------------------------------------------------------------ shapes --

export type WithheldReason = 'permission' | 'module_off' | 'not_per_branch';

export interface Withheld {
  status: 'withheld';
  reason: WithheldReason;
  /** The permission that would unlock it. Non-null exactly when `reason` is `permission`. */
  permission: PermissionName | null;
}

export type Block<T> = ({ status: 'ok' } & T) | Withheld;

/** Of the `total` rows behind a block, how many had their branch inferred. Null at all-branches. */
export type BranchAssumed = { assumed: number; total: number } | null;

export interface ServiceRow {
  serviceId: string;
  name: string;
  bookings: number;
  revenueFils: Fils;
}

export interface ArtistRow {
  artistId: string;
  name: string;
  bookings: number;
  noShows: number;
  revenueFils: Fils;
}

export interface BusiestCell {
  /** 0 = Sunday, in the SALON'S zone. The `salonWallClock` convention. */
  weekday: number;
  /** 0–23, in the salon's zone. */
  hour: number;
  visits: number;
}

export interface UpcomingRow {
  bookingId: string;
  startsAt: string;
  /** Member name (the tombstone if erased) or the walk-in's name. Never a phone. */
  customerName: string;
  memberId: string | null;
  serviceName: string;
  artistName: string;
  branchId: string;
  branchName: string;
  branchAssumed: boolean;
}

export interface WeekBucket {
  /** The salon-local Sunday that starts the week, YYYY-MM-DD. */
  weekStart: string;
  count: number;
  /** True when the window covers only part of this week, so the bar is not a whole week. */
  partial: boolean;
}

export interface MethodTotal {
  count: number;
  fils: Fils;
  /** Share of all top-up VALUE in the window, basis points, half up. Null when nothing loaded. */
  shareBp: number | null;
}

export type OrderStatusName = 'preparing' | 'ready' | 'closed';

export interface ProductRow {
  productId: string;
  name: string;
  units: number;
  revenueFils: Fils;
}

export interface CampaignRow {
  campaignId: string;
  title: string;
  audience: string;
  channel: string;
  sentAt: string;
  /** People actually sent to — the `campaign_send` rows, which is the "N reached" in `result`. */
  reached: number;
  /** `campaign.reach`: the audience size AVO approved it against, at submission. */
  reach: number;
  /** `campaign.result`, verbatim — the Decided list's own sentence. */
  result: string | null;
}

export interface OverviewAnalytics {
  asOf: string;
  /** `services/period.ts § serialiseWindow` — the Reports card's window, unchanged. */
  window: ReturnType<typeof serialiseWindow>;
  branchId: string | null;
  branchName: string | null;
  loyaltyMode: 'tiers' | 'stamps';
  modules: { booking: boolean; shop: boolean };

  topServices: Block<{
    byBookings: ServiceRow[];
    byRevenue: ServiceRow[];
    branchAssumed: BranchAssumed;
  }>;
  artists: Block<{ items: ArtistRow[]; branchAssumed: BranchAssumed }>;
  busiestTimes: Block<{ cells: BusiestCell[]; totalVisits: number; branchAssumed: BranchAssumed }>;
  upcoming: {
    status: 'ok';
    today: number;
    next7Days: number;
    branchAssumed: BranchAssumed;
    next: Block<{ items: UpcomingRow[] }>;
  };
  noShows: Block<{
    completed: number;
    noShows: number;
    /** noShows / (completed + noShows), basis points, half up. Null when neither happened. */
    rateBp: number | null;
    depositsHeld: { bookings: number; fils: Fils };
    branchAssumed: BranchAssumed;
  }>;
  newMembers: Block<{ total: number; weeks: WeekBucket[] }>;
  visitors: Block<{
    total: number;
    firstVisit: number;
    returning: number;
    branchAssumed: BranchAssumed;
  }>;
  loyalty: Block<
    | {
        mode: 'tiers';
        tiers: Array<{ tier: string; members: number }>;
        untiered: number;
      }
    | {
        mode: 'stamps';
        stampTarget: number;
        buckets: Array<{ stamps: number; members: number }>;
      }
  >;
  wallet: Block<{
    loadedFils: Fils;
    bonusFils: Fils;
    topups: number;
    spentFils: Fils;
    liabilityFils: Fils;
  }>;
  paymentMix: Block<{
    topups: { knet: MethodTotal; card: MethodTotal; applepay: MethodTotal };
    walletSpend: { count: number; fils: Fils };
  }>;
  shop: Block<{
    orders: number;
    ordersByStatus: Record<OrderStatusName, number>;
    topProducts: ProductRow[];
    revenueFils: Fils;
    branchAssumed: BranchAssumed;
  }>;
  campaigns: Block<{
    sent: number;
    reached: number;
    reach: number;
    items: CampaignRow[];
    truncated: boolean;
  }>;
}

export interface AnalyticsSalon {
  id: string;
  timezone: string;
  loyaltyMode: 'tiers' | 'stamps';
  stampTarget: number | null;
  /** The ladder's names, in order. Null at a stamps salon. */
  tierNames: string[] | null;
  moduleBooking: boolean;
  moduleShop: boolean;
}

export interface AnalyticsScope {
  salon: AnalyticsSalon;
  period: Period;
  /** Resolved and salon-scoped by `resolveBranchFilter`, never the raw query value. */
  branch: BranchFilter | null;
  perms: StaffPerms;
  now: Date;
}

// ----------------------------------------------------------------- helpers --

export const TOP_N = 5;
export const UPCOMING_N = 5;
export const CAMPAIGN_ITEMS_MAX = 20;
const ORDER_STATUSES: readonly OrderStatusName[] = ['preparing', 'ready', 'closed'];

/**
 * `part / whole` in basis points, ROUNDED HALF UP, or null when `whole` is 0.
 *
 * In BigInt, not `Math.round(a * 10000 / b)`: a fils sum times 20 000 passes
 * 2^53 at about 450 million dinars, and the float division is the thing
 * non-negotiable #1 keeps out of money. `(2·a·10⁴ + b) / 2b` floored is
 * round-half-up for non-negative integers.
 *
 * NULL, NOT 0, FOR AN EMPTY DENOMINATOR. "0% no-shows" over zero appointments is a
 * claim about appointments that did not happen; `metrics.ts § percent` returns 0
 * for its tiles, and this file does not copy that.
 */
export function basisPoints(part: number, whole: number): number | null {
  if (!Number.isSafeInteger(part) || !Number.isSafeInteger(whole)) {
    throw new TypeError(`basisPoints takes integers, got ${part} / ${whole}.`);
  }
  if (whole <= 0) return null;
  const a = BigInt(part);
  const b = BigInt(whole);
  return Number((2n * a * 10000n + b) / (2n * b));
}

/** A money aggregate. Refuses a fraction rather than truncating one. */
function money(value: unknown): Fils {
  if (value === null || value === undefined) return fils(0);
  return fils(Number(value));
}

function iso(value: unknown): string {
  return new Date(value as string | Date).toISOString();
}

const withheld = (reason: WithheldReason, permission: PermissionName | null = null): Withheld => ({
  status: 'withheld',
  reason,
  permission,
});

type Rows = Array<Record<string, unknown>>;

function ymd(d: CalendarDate): string {
  return `${String(d.year).padStart(4, '0')}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

function addDays(d: CalendarDate, n: number): CalendarDate {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + n));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

/**
 * The salon-local weeks a window touches, Sunday-first, each marked `partial` when
 * the window does not cover all seven of its days.
 *
 * SUNDAY, because the Gulf week starts on Sunday and `salonWallClock` already
 * numbers Sunday 0. A Monday-first bucket (Postgres' `date_trunc('week')`) would
 * split a Kuwaiti salon's working week across two bars.
 *
 * EXPORTED for the unit spec: the boundaries are the whole of the logic.
 */
export function weeksOf(win: PeriodWindow): Array<{ weekStart: string; partial: boolean }> {
  const tz = win.timezone;
  const first = parseDate(salonWallClock(win.fromInstant, tz).date);
  // The last instant INSIDE the half-open window.
  const last = parseDate(salonWallClock(new Date(win.toInstant.getTime() - 1), tz).date);
  let ws = addDays(first, -weekdayOf(first));
  const out: Array<{ weekStart: string; partial: boolean }> = [];
  while (ymd(ws) <= ymd(last)) {
    const start = wallClockInstant(ws, 0, tz);
    const end = wallClockInstant(addDays(ws, 7), 0, tz);
    out.push({
      weekStart: ymd(ws),
      partial: start.getTime() < win.fromInstant.getTime() || end.getTime() > win.toInstant.getTime(),
    });
    ws = addDays(ws, 7);
  }
  return out;
}

// ------------------------------------------------------------------ compute --

export async function computeOverviewAnalytics(
  db: Db,
  scope: AnalyticsScope,
): Promise<OverviewAnalytics> {
  const { salon, branch, perms, now } = scope;
  const win = resolveWindow(scope.period, salon.timezone, now);
  const from = win.fromInstant;
  const to = win.toInstant;
  const b = branch?.id ?? null;
  const tz = salon.timezone;

  const rows = async (q: SQL): Promise<Rows> => (await db.execute(q)) as unknown as Rows;
  /** `AND <alias>.branch_id = $b`, or nothing — the metrics shape, so all-branches SQL is unfiltered. */
  const onBranch = (alias: string) =>
    b === null ? sql`` : sql`AND ${sql.identifier(alias)}.branch_id = ${b}`;
  const assumed = (a: unknown, total: unknown): BranchAssumed =>
    b === null ? null : { assumed: int(a), total: int(total) };

  // The salon's own midnight, and the midnight seven days on.
  const today = parseDate(salonWallClock(now, tz).date);
  const dayEnd = wallClockInstant(today, 1440, tz);
  const weekEnd = wallClockInstant(today, 7 * 1440, tz);

  // ------------------------------------------------------ 2. top services --
  /**
   * `best-selling-services`' DEFINITIONS, rolled up over branches. Same rows (not
   * cancelled, `starts_at` in the window — "performed this month"), same revenue
   * (`earned_fils` through `settled_transaction_id`, LEFT so an unsettled booking
   * still counts as a booking). The report groups by (service, branch); this groups
   * by service, so a service's figure here is exactly the sum of its rows there.
   * `overviewAnalytics.int.test.ts` asserts that sum rather than trusting it.
   *
   * Grouped by id, not name: two services may share a name and are not one
   * service. Unbounded GROUP BY over a salon's service list, which is small; the
   * top five is cut in TypeScript so both orderings come from one scan.
   */
  let topServices: OverviewAnalytics['topServices'];
  if (!perms.appointments) {
    topServices = withheld('permission', 'appointments');
  } else {
    const r = await rows(sql`
      SELECT sv.id AS service_id, sv.name,
             count(*) AS bookings,
             coalesce(sum(rev.earned_fils), 0)::bigint AS revenue,
             count(*) FILTER (WHERE bk.branch_assumed) AS assumed
        FROM booking bk
        JOIN service sv ON sv.id = bk.service_id
        ${revenueLeftJoin(sql`bk.settled_transaction_id`)}
       WHERE bk.salon_id = ${salon.id}
         AND bk.status <> 'cancelled'
         AND bk.starts_at >= ${at(from)}
         AND bk.starts_at < ${at(to)}
         ${onBranch('bk')}
       GROUP BY sv.id, sv.name
    `);
    const all: ServiceRow[] = r.map((x) => ({
      serviceId: String(x.service_id),
      name: String(x.name),
      bookings: int(x.bookings),
      revenueFils: money(x.revenue),
    }));
    const byName = (p: ServiceRow, q: ServiceRow) => (p.name < q.name ? -1 : p.name > q.name ? 1 : 0);
    topServices = {
      status: 'ok',
      byBookings: [...all]
        .sort((p, q) => q.bookings - p.bookings || q.revenueFils - p.revenueFils || byName(p, q))
        .slice(0, TOP_N),
      byRevenue: [...all]
        .sort((p, q) => q.revenueFils - p.revenueFils || q.bookings - p.bookings || byName(p, q))
        .slice(0, TOP_N),
      branchAssumed: assumed(
        r.reduce((n, x) => n + int(x.assumed), 0),
        all.reduce((n, x) => n + x.bookings, 0),
      ),
    };
  }

  // ------------------------------------------------------------ 3. artists --
  /**
   * `team`: a named person's earnings. Three figures per artist, and they are
   * windowed on DIFFERENT COLUMNS on purpose:
   *
   *   bookings   not cancelled, `starts_at` in the window — `best-selling-services`
   *   noShows    `no_show_returned`, `starts_at` in the window
   *   revenue    `artist-performance`'s `Earned KD`, exactly: settled, not-voided
   *              CHARGES created in the window, attributed through
   *              `settled_transaction_id`. The int spec reconciles it per artist.
   *
   * So an appointment performed on the 30th and charged on the 1st counts as a
   * booking in one month and as revenue in the next. That is each figure's existing
   * definition, kept rather than re-invented; a merchant comparing this widget with
   * her Reports page gets the same numbers.
   *
   * Every artist of the salon is listed, zeros included — the report's rule, so a
   * quiet artist is visible as quiet rather than absent.
   */
  let artists: OverviewAnalytics['artists'];
  if (!perms.team) {
    artists = withheld('permission', 'team');
  } else {
    const r = await rows(sql`
      WITH booked AS (
        SELECT bk.artist_id,
               count(*) FILTER (WHERE bk.status <> 'cancelled') AS bookings,
               count(*) FILTER (WHERE bk.status = 'no_show_returned') AS no_shows,
               count(*) FILTER (WHERE bk.status <> 'cancelled' AND bk.branch_assumed) AS assumed
          FROM booking bk
         WHERE bk.salon_id = ${salon.id}
           AND bk.starts_at >= ${at(from)}
           AND bk.starts_at < ${at(to)}
           ${onBranch('bk')}
         GROUP BY bk.artist_id
      ), earned AS (
        SELECT bk.artist_id, coalesce(sum(rev.earned_fils), 0)::bigint AS earned
          FROM booking bk
          JOIN "transaction" t ON t.id = bk.settled_transaction_id
          ${revenueJoin('t')}
         WHERE bk.salon_id = ${salon.id}
           AND t.salon_id = ${salon.id}
           AND t.kind = 'charge'
           AND t.status = 'settled'
           AND t.created_at >= ${at(from)}
           AND t.created_at < ${at(to)}
           ${onBranch('t')}
           ${NOT_VOIDED}
         GROUP BY bk.artist_id
      )
      SELECT ar.id, ar.name,
             coalesce(bd.bookings, 0) AS bookings,
             coalesce(bd.no_shows, 0) AS no_shows,
             coalesce(bd.assumed, 0) AS assumed,
             coalesce(e.earned, 0)::bigint AS earned
        FROM artist ar
        LEFT JOIN booked bd ON bd.artist_id = ar.id
        LEFT JOIN earned e ON e.artist_id = ar.id
       WHERE ar.salon_id = ${salon.id}
       ORDER BY coalesce(e.earned, 0) DESC, coalesce(bd.bookings, 0) DESC, ar.name ASC, ar.id ASC
    `);
    const items: ArtistRow[] = r.map((x) => ({
      artistId: String(x.id),
      name: String(x.name),
      bookings: int(x.bookings),
      noShows: int(x.no_shows),
      revenueFils: money(x.earned),
    }));
    artists = {
      status: 'ok',
      items,
      branchAssumed: assumed(
        r.reduce((n, x) => n + int(x.assumed), 0),
        items.reduce((n, x) => n + x.bookings, 0),
      ),
    };
  }

  // ------------------------------------------------------ 4. busiest times --
  /**
   * Visits by weekday × hour IN THE SALON'S ZONE. `AT TIME ZONE ${tz}` turns the
   * instant into the salon's wall clock inside Postgres, so neither the process
   * zone (this machine runs PKT, two hours ahead of Kuwait) nor the database
   * session's `TimeZone` can move a 21:30 visit into the 23:00 column. The int
   * spec pins `TZ=Asia/Karachi` to prove it.
   *
   * SPARSE: only cells with a visit. A 7 × 24 grid of zeros is the client's to
   * draw, and sending it would be 168 numbers of which most say nothing.
   */
  const busy = await rows(sql`
    SELECT extract(dow FROM t.created_at AT TIME ZONE ${tz})::int AS weekday,
           extract(hour FROM t.created_at AT TIME ZONE ${tz})::int AS hour,
           count(*) AS visits,
           count(*) FILTER (WHERE t.branch_assumed) AS assumed
      FROM "transaction" t
     WHERE t.salon_id = ${salon.id}
       AND t.kind = 'charge'
       AND t.status = 'settled'
       AND t.created_at >= ${at(from)}
       AND t.created_at < ${at(to)}
       ${onBranch('t')}
       ${NOT_VOIDED}
     GROUP BY 1, 2
     ORDER BY 1, 2
  `);
  const cells: BusiestCell[] = busy.map((x) => ({
    weekday: int(x.weekday),
    hour: int(x.hour),
    visits: int(x.visits),
  }));
  const totalVisits = cells.reduce((n, c) => n + c.visits, 0);
  const busiestTimes: OverviewAnalytics['busiestTimes'] = {
    status: 'ok',
    cells,
    totalVisits,
    branchAssumed: assumed(busy.reduce((n, x) => n + int(x.assumed), 0), totalVisits),
  };

  // ----------------------------------------------------------- 5. upcoming --
  /**
   * NOT THE PERIOD. "Today" and "the next 7 days" are wall-clock facts, the
   * metrics rule for its two today tiles: a merchant reviewing March still sees
   * what is left of today.
   *
   * `today` IS `metrics.upcomingAppointments`, predicate for predicate —
   * `deposit_held`, still to start, before the salon's midnight. The int spec
   * asserts the two agree. `next7Days` is the same predicate to the salon's
   * midnight SEVEN days on, so it includes today's remainder and six whole days.
   *
   * THE NEXT FIVE are the appointment book's rows, customers named, so they need
   * `appointments`; the counts are the Overview's, as they already are on /metrics.
   * Unbounded in time — "the next five", however far out — and cheap, because
   * `booking_salon_starts_idx` walks from `now`.
   */
  const up = (
    await rows(sql`
      SELECT count(*) FILTER (WHERE starts_at < ${at(dayEnd)}) AS today,
             count(*) AS next7,
             count(*) FILTER (WHERE branch_assumed) AS assumed
        FROM booking
       WHERE salon_id = ${salon.id}
         AND status = 'deposit_held'
         AND starts_at >= ${at(now)}
         AND starts_at < ${at(weekEnd)}
         ${b === null ? sql`` : sql`AND branch_id = ${b}`}
    `)
  )[0];
  let next: OverviewAnalytics['upcoming']['next'];
  if (!perms.appointments) {
    next = withheld('permission', 'appointments');
  } else {
    const r = await rows(sql`
      SELECT bk.id, bk.starts_at, bk.member_id, bk.branch_id, bk.branch_assumed,
             coalesce(m.name, bk.guest_name) AS customer,
             sv.name AS service, ar.name AS artist, br.name AS branch
        FROM booking bk
        JOIN service sv ON sv.id = bk.service_id
        JOIN artist ar ON ar.id = bk.artist_id
        JOIN branch br ON br.id = bk.branch_id
        LEFT JOIN member m ON m.id = bk.member_id
       WHERE bk.salon_id = ${salon.id}
         AND bk.status = 'deposit_held'
         AND bk.starts_at >= ${at(now)}
         ${onBranch('bk')}
       ORDER BY bk.starts_at ASC, bk.id ASC
       LIMIT ${UPCOMING_N}
    `);
    next = {
      status: 'ok',
      items: r.map((x) => ({
        bookingId: String(x.id),
        startsAt: iso(x.starts_at),
        customerName: String(x.customer ?? ''),
        memberId: x.member_id === null || x.member_id === undefined ? null : String(x.member_id),
        serviceName: String(x.service),
        artistName: String(x.artist),
        branchId: String(x.branch_id),
        branchName: String(x.branch),
        branchAssumed: Boolean(x.branch_assumed),
      })),
    };
  }
  const upcoming: OverviewAnalytics['upcoming'] = {
    status: 'ok',
    today: int(up?.today),
    next7Days: int(up?.next7),
    branchAssumed: assumed(up?.assumed, up?.next7),
    next,
  };

  // ------------------------------------------------------------ 6. no-shows --
  /**
   * THE RATE'S DENOMINATOR IS RESOLVED APPOINTMENTS — `completed` plus
   * `no_show_returned` whose slot started in the window. Not cancelled (she told
   * the salon), not still held (not resolved yet, so neither outcome is known).
   *
   * DEPOSITS HELD is `services/depositHealth.ts § held`, predicate for predicate:
   * every `deposit_held` booking, no time bound, `sum(deposit_fils)`. The count
   * therefore includes zero-deposit merchant appointments exactly as that screen's
   * does, and the int spec asserts the two endpoints agree. It is a current
   * snapshot, not a period figure.
   */
  const ns = (
    await rows(sql`
      SELECT count(*) FILTER (WHERE status = 'completed') AS completed,
             count(*) FILTER (WHERE status = 'no_show_returned') AS no_shows,
             count(*) FILTER (WHERE branch_assumed) AS assumed
        FROM booking
       WHERE salon_id = ${salon.id}
         AND status IN ('completed', 'no_show_returned')
         AND starts_at >= ${at(from)}
         AND starts_at < ${at(to)}
         ${b === null ? sql`` : sql`AND branch_id = ${b}`}
    `)
  )[0];
  const held = (
    await rows(sql`
      SELECT count(*) AS held,
             coalesce(sum(deposit_fils), 0)::bigint AS held_fils
        FROM booking
       WHERE salon_id = ${salon.id}
         AND status = 'deposit_held'
         ${b === null ? sql`` : sql`AND branch_id = ${b}`}
    `)
  )[0];
  const completed = int(ns?.completed);
  const noShowCount = int(ns?.no_shows);
  const noShows: OverviewAnalytics['noShows'] = {
    status: 'ok',
    completed,
    noShows: noShowCount,
    rateBp: basisPoints(noShowCount, completed + noShowCount),
    depositsHeld: { bookings: int(held?.held), fils: money(held?.held_fils) },
    branchAssumed: assumed(ns?.assumed, completed + noShowCount),
  };

  // --------------------------------------------------------- 7. new members --
  /**
   * `member.joined_at` in the window, bucketed into salon-local Sunday weeks. Every
   * week the window touches is present, zeros included, so a chart has no holes;
   * the first and last are `partial` when the window clips them.
   *
   * ERASED MEMBERS ARE COUNTED. That she joined is a historical fact about the
   * salon's growth, and the count names nobody.
   */
  let newMembers: OverviewAnalytics['newMembers'];
  if (b !== null) {
    newMembers = withheld('not_per_branch');
  } else {
    const r = await rows(sql`
      SELECT to_char(
               (m.joined_at AT TIME ZONE ${tz})::date
                 - extract(dow FROM (m.joined_at AT TIME ZONE ${tz}))::int,
               'YYYY-MM-DD') AS week_start,
             count(*) AS n
        FROM member m
       WHERE m.salon_id = ${salon.id}
         AND m.joined_at >= ${at(from)}
         AND m.joined_at < ${at(to)}
       GROUP BY 1
    `);
    const byWeek = new Map(r.map((x) => [String(x.week_start), int(x.n)]));
    const weeks = weeksOf(win).map((w) => ({ ...w, count: byWeek.get(w.weekStart) ?? 0 }));
    newMembers = { status: 'ok', total: weeks.reduce((n, w) => n + w.count, 0), weeks };
  }

  // ----------------------------------------------- 7b. first vs returning --
  /**
   * Of the members who visited in the window, how many had never visited THIS
   * SALON before it (`firstVisit`) and how many had (`returning`). "Before" is any
   * branch: with `?branch=` the visitors are the branch's, and a customer who used
   * to go to Salmiya and tried Kuwait City is returning to the salon, not new to it.
   *
   * The `EXISTS` walks `transaction_member_created_idx` per visitor, bounded by the
   * window's start.
   *
   * `branchAssumed.assumed` counts visitors placed at the branch ONLY by inferred
   * rows — metrics' `activeMembers` rule: one recorded visit means she was here.
   */
  const vis = (
    await rows(sql`
      WITH v AS (
        SELECT t.member_id, bool_and(t.branch_assumed) AS all_assumed
          FROM "transaction" t
         WHERE t.salon_id = ${salon.id}
           AND t.kind = 'charge'
           AND t.status = 'settled'
           AND t.created_at >= ${at(from)}
           AND t.created_at < ${at(to)}
           ${onBranch('t')}
           ${NOT_VOIDED}
         GROUP BY t.member_id
      )
      SELECT count(*) AS visitors,
             count(*) FILTER (WHERE v.all_assumed) AS assumed,
             count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM "transaction" p
                WHERE p.member_id = v.member_id
                  AND p.salon_id = ${salon.id}
                  AND p.kind = 'charge'
                  AND p.status = 'settled'
                  AND p.created_at < ${at(from)}
                  AND NOT EXISTS (
                    SELECT 1 FROM "transaction" r
                     WHERE r.reverses_transaction_id = p.id AND r.status = 'settled'
                  )
             )) AS returning
        FROM v
    `)
  )[0];
  const visitorsTotal = int(vis?.visitors);
  const returning = int(vis?.returning);
  const visitors: OverviewAnalytics['visitors'] = {
    status: 'ok',
    total: visitorsTotal,
    firstVisit: visitorsTotal - returning,
    returning,
    branchAssumed: assumed(vis?.assumed, visitorsTotal),
  };

  // ------------------------------------------------------------ 8. loyalty --
  /**
   * THE MODE THE SALON IS IN, and only that one. A stamps salon has no tiers
   * (`db/schema/member.ts`) and printing a tier ladder it does not operate would be
   * a fabricated chart — `reports.ts § customers`' rule for the Tier column.
   *
   * TIERS: the salon's own ladder, in its order, zeros included. A member whose
   * tier is null or not on the ladder is `untiered` rather than folded into Bronze.
   * STAMPS: members per stamp count, 0 to `stampTarget`, zeros included; a null
   * `stamps` is 0. A count above the target (it should not exist) is kept as its
   * own bucket rather than clipped, so it is visible.
   *
   * A current snapshot, not a period figure. ERASED MEMBERS ARE EXCLUDED: they are
   * not members of anything any more.
   */
  let loyalty: OverviewAnalytics['loyalty'];
  if (b !== null) {
    loyalty = withheld('not_per_branch');
  } else if (salon.loyaltyMode === 'tiers') {
    const r = await rows(sql`
      SELECT tier::text AS tier, count(*) AS n
        FROM member
       WHERE salon_id = ${salon.id} AND erased_at IS NULL
       GROUP BY 1
    `);
    const ladder = salon.tierNames ?? [];
    const counts = new Map(r.map((x) => [x.tier === null ? null : String(x.tier), int(x.n)]));
    const tiers = ladder.map((t) => ({ tier: t, members: counts.get(t) ?? 0 }));
    const onLadder = tiers.reduce((n, t) => n + t.members, 0);
    const everyone = r.reduce((n, x) => n + int(x.n), 0);
    loyalty = { status: 'ok', mode: 'tiers', tiers, untiered: everyone - onLadder };
  } else {
    const target = salon.stampTarget ?? 0;
    const r = await rows(sql`
      SELECT coalesce(stamps, 0) AS stamps, count(*) AS n
        FROM member
       WHERE salon_id = ${salon.id} AND erased_at IS NULL
       GROUP BY 1
    `);
    const counts = new Map(r.map((x) => [int(x.stamps), int(x.n)]));
    const buckets: Array<{ stamps: number; members: number }> = [];
    for (let s = 0; s <= target; s += 1) buckets.push({ stamps: s, members: counts.get(s) ?? 0 });
    for (const [s, n] of [...counts].sort((p, q) => p[0] - q[0])) {
      if (s > target) buckets.push({ stamps: s, members: n });
    }
    loyalty = { status: 'ok', mode: 'stamps', stampTarget: target, buckets };
  }

  // ------------------------------------------------ 9 & 10. wallet, mix --
  /**
   * LOADED is the settled top-ups' `amount_fils` — the CREDIT, bonus included, the
   * `loadedTodayFils` definition over the window. `bonusFils` (tier bonus plus
   * promotion bonus) is served beside it, so "what customers paid" is
   * `loadedFils - bonusFils` and is a subtraction of two served integers rather
   * than a third figure that could disagree with them.
   *
   * SPENT is `earned_fils` over settled, not-voided charges and shop orders — the
   * `sales` report's `Gross KD` over the same window, which the int spec asserts.
   * The deposit half of a booked visit left her wallet earlier and is spend here.
   *
   * LIABILITY is `sum(member.balance_fils)` now — what the salon's customers can
   * still spend. The server owns the balance (non-negotiable #2); this is that fact
   * summed. Erased members are INCLUDED: a balance is money owed whoever it is owed
   * to, and dropping it would understate the liability.
   *
   * PAYMENT MIX IS TWO DIFFERENT FLOWS AND IS NOT ONE PIE. Every charge and every
   * shop order is paid from the wallet — `method = 'wallet'` by construction in
   * `services/charge.ts` and `services/order.ts`, including an order paid "by KNET",
   * which is a top-up sized to the order and then a wallet debit. KNET, card and
   * Apple Pay exist ONLY on top-ups. So the mix is how money ENTERED wallets, by
   * method and by value, and `walletSpend` is how it LEFT; a share computed across
   * both would add incoming money to outgoing money.
   */
  let wallet: OverviewAnalytics['wallet'];
  let paymentMix: OverviewAnalytics['paymentMix'];
  if (b !== null) {
    wallet = withheld('not_per_branch');
    paymentMix = withheld('not_per_branch');
  } else {
    const loaded = await rows(sql`
      SELECT method::text AS method,
             count(*) AS n,
             coalesce(sum(amount_fils), 0)::bigint AS credit,
             coalesce(sum(bonus_fils + promo_bonus_fils), 0)::bigint AS bonus
        FROM "transaction"
       WHERE salon_id = ${salon.id}
         AND kind = 'topup'
         AND status = 'settled'
         AND created_at >= ${at(from)}
         AND created_at < ${at(to)}
       GROUP BY 1
    `);
    const spent = (
      await rows(sql`
        SELECT count(*) AS n, coalesce(sum(rev.earned_fils), 0)::bigint AS earned
          FROM "transaction" t
          ${revenueJoin('t')}
         WHERE t.salon_id = ${salon.id}
           AND t.kind IN ('charge', 'shop')
           AND t.status = 'settled'
           AND t.created_at >= ${at(from)}
           AND t.created_at < ${at(to)}
           ${NOT_VOIDED}
      `)
    )[0];
    const liability = (
      await rows(sql`
        SELECT coalesce(sum(balance_fils), 0)::bigint AS total
          FROM member
         WHERE salon_id = ${salon.id}
      `)
    )[0];
    const loadedFils = add(...loaded.map((x) => money(x.credit)));
    const method = (m: 'knet' | 'card' | 'applepay'): MethodTotal => {
      const x = loaded.find((y) => y.method === m);
      const f = money(x?.credit);
      return { count: int(x?.n), fils: f, shareBp: basisPoints(f, loadedFils) };
    };
    wallet = {
      status: 'ok',
      loadedFils,
      bonusFils: add(...loaded.map((x) => money(x.bonus))),
      topups: loaded.reduce((n, x) => n + int(x.n), 0),
      spentFils: money(spent?.earned),
      liabilityFils: money(liability?.total),
    };
    paymentMix = {
      status: 'ok',
      topups: { knet: method('knet'), card: method('card'), applepay: method('applepay') },
      walletSpend: { count: int(spent?.n), fils: money(spent?.earned) },
    };
  }

  // --------------------------------------------------------------- 11. shop --
  /**
   * MODULE OFF IS AN ANSWER, NOT ZEROS. A salon that does not sell through AVO has
   * no shop to report on, and "0 orders" would read as a shop nobody buys from.
   * Checked before the permission: it is a fact about the salon, true whoever asks.
   *
   * `orders` / `ordersByStatus`: orders PLACED in the window, by where they stand
   * on the board NOW. Counted whatever later happened to the money — the board is
   * operational and shows them.
   * `topProducts`: `products-sold`' definition (settled, not voided, `line_total`),
   * rolled up over branches by product id, top five by units.
   * `revenueFils`: `earned_fils` over the same settled, not-voided shop rows — the
   * shop half of `sales`' `Gross KD`.
   *
   * Branch-scoped on the TRANSACTION's branch, which is `products-sold`' and
   * `sales`' attribution; it is not the pickup branch (migration 0060), which is
   * where she collects and is a different fact.
   */
  let shop: OverviewAnalytics['shop'];
  if (!salon.moduleShop) {
    shop = withheld('module_off');
  } else if (!perms.shop) {
    shop = withheld('permission', 'shop');
  } else {
    const byStatus = await rows(sql`
      SELECT o.status::text AS status, count(*) AS n
        FROM shop_order o
        JOIN "transaction" t ON t.id = o.transaction_id
       WHERE o.salon_id = ${salon.id}
         AND o.created_at >= ${at(from)}
         AND o.created_at < ${at(to)}
         ${onBranch('t')}
       GROUP BY 1
    `);
    const products = await rows(sql`
      SELECT l.product_id,
             (array_agg(l.name ORDER BY t.created_at DESC))[1] AS product,
             coalesce(sum(l.qty), 0)::bigint AS units,
             coalesce(sum(l.line_total_fils), 0)::bigint AS revenue
        FROM shop_order_line l
        JOIN "transaction" t ON t.id = l.transaction_id
       WHERE t.salon_id = ${salon.id}
         AND t.kind = 'shop'
         AND t.status = 'settled'
         AND t.created_at >= ${at(from)}
         AND t.created_at < ${at(to)}
         ${onBranch('t')}
         ${NOT_VOIDED}
       GROUP BY l.product_id
       ORDER BY units DESC, revenue DESC, product ASC
       LIMIT ${TOP_N}
    `);
    const rev = (
      await rows(sql`
        SELECT count(*) AS n,
               count(*) FILTER (WHERE t.branch_assumed) AS assumed,
               coalesce(sum(rev.earned_fils), 0)::bigint AS earned
          FROM "transaction" t
          ${revenueJoin('t')}
         WHERE t.salon_id = ${salon.id}
           AND t.kind = 'shop'
           AND t.status = 'settled'
           AND t.created_at >= ${at(from)}
           AND t.created_at < ${at(to)}
           ${onBranch('t')}
           ${NOT_VOIDED}
      `)
    )[0];
    const ordersByStatus = Object.fromEntries(
      ORDER_STATUSES.map((s) => [s, int(byStatus.find((x) => x.status === s)?.n)]),
    ) as Record<OrderStatusName, number>;
    shop = {
      status: 'ok',
      orders: ORDER_STATUSES.reduce((n, s) => n + ordersByStatus[s], 0),
      ordersByStatus,
      topProducts: products.map((x) => ({
        productId: String(x.product_id),
        name: String(x.product),
        units: int(x.units),
        revenueFils: money(x.revenue),
      })),
      revenueFils: money(rev?.earned),
      branchAssumed: assumed(rev?.assumed, rev?.n),
    };
  }

  // ---------------------------------------------------------- 12. campaigns --
  /**
   * SENT IN THE WINDOW = the campaign's first `campaign_send.sent_at` falls in it.
   * That is when it actually went out; `decided_at` is when AVO approved it, which
   * for a scheduled campaign is earlier.
   *
   * `reached` is the count of its `campaign_send` rows — the number in `result`'s
   * "N reached", read from the rows rather than parsed out of the sentence.
   * `reach` is the audience size at submission. `result` is served verbatim.
   *
   * NO OPEN RATE, NO BOOKINGS. Nothing records an open, and attributing a booking
   * to a campaign needs a campaign id on the booking that no table carries —
   * `services/campaign.ts § result` refuses to invent "148 booked" for the same
   * reason.
   *
   * LATERAL, so `campaign_send` is read through its primary key for this salon's
   * sent campaigns only, never scanned across every salon.
   */
  let campaigns: OverviewAnalytics['campaigns'];
  if (b !== null) {
    campaigns = withheld('not_per_branch');
  } else if (!perms.marketing) {
    campaigns = withheld('permission', 'marketing');
  } else {
    const r = await rows(sql`
      SELECT c.id, c.title, c.audience, c.channel, c.reach, c.result,
             s.sent_at, s.reached
        FROM campaign c
        CROSS JOIN LATERAL (
          SELECT min(cs.sent_at) AS sent_at, count(*) AS reached
            FROM campaign_send cs
           WHERE cs.campaign_id = c.id
        ) s
       WHERE c.salon_id = ${salon.id}
         AND c.status = 'sent'
         AND s.sent_at >= ${at(from)}
         AND s.sent_at < ${at(to)}
       ORDER BY s.sent_at DESC, c.id ASC
    `);
    campaigns = {
      status: 'ok',
      sent: r.length,
      reached: r.reduce((n, x) => n + int(x.reached), 0),
      reach: r.reduce((n, x) => n + int(x.reach), 0),
      items: r.slice(0, CAMPAIGN_ITEMS_MAX).map((x) => ({
        campaignId: String(x.id),
        title: String(x.title),
        audience: String(x.audience),
        channel: String(x.channel),
        sentAt: iso(x.sent_at),
        reached: int(x.reached),
        reach: int(x.reach),
        result: x.result === null || x.result === undefined ? null : String(x.result),
      })),
      truncated: r.length > CAMPAIGN_ITEMS_MAX,
    };
  }

  return {
    asOf: now.toISOString(),
    window: serialiseWindow(win),
    branchId: b,
    branchName: branch?.name ?? null,
    loyaltyMode: salon.loyaltyMode,
    modules: { booking: salon.moduleBooking, shop: salon.moduleShop },
    topServices,
    artists,
    busiestTimes,
    upcoming,
    noShows,
    newMembers,
    visitors,
    loyalty,
    wallet,
    paymentMix,
    shop,
    campaigns,
  };
}
