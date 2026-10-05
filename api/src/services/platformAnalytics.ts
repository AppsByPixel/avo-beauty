/**
 * THE OWNER CONSOLE'S ANALYTICS — `GET /v1/platform/analytics?month=&months=&salon=`.
 *
 * Aftab, 2026-10-05: "The way we added so much graphs and valuable analytics for
 * the merchant dashboard, we need to do similar for the admin console."
 * `services/overviewAnalytics.ts` is the model: one endpoint, blocks that are
 * `ok` or `withheld`, integers all the way down, every definition beside its
 * query. `services/platformMetrics.ts` is the other half of the inheritance:
 * where a figure here overlaps `GET /v1/platform/metrics` it is computed THE SAME
 * WAY, and `platformAnalytics.int.test.ts` asserts the two agree.
 *
 * ==========================================================================
 * CALENDAR MONTHS IN THE PLATFORM ZONE — `platformMetrics.ts`' decision, kept
 * ==========================================================================
 * Every series is per calendar month in `PLATFORM_TIMEZONE` (Asia/Kuwait), and
 * the reasoning is that file's: a platform month bucketed by each salon's own
 * midnight would overlap at the edges and the bars would not sum to the platform
 * total. `?month=YYYY-MM` picks the month the single-month blocks describe
 * (leaderboard, payment mix, busiest times, orders by status) and that ENDS the
 * history; `?months=N` (1–24, default 12) is how many months the history holds,
 * the selected one included. The current month is `partial: true`.
 *
 * ONE EXCEPTION, AND IT IS THE POINT OF THE WIDGET: busiest times. A visit is in
 * the selected platform month by the platform clock, but its weekday and hour are
 * read on ITS OWN SALON'S clock — `AT TIME ZONE salon.timezone`, per row — so a
 * 10:00 visit in Kuwait and a 10:00 visit in Dubai are both 10:00. On the
 * platform clock the Dubai one would be 09:00, and a heat map of "when salons are
 * busy" would be smeared by an hour for every salon outside +03. The block says
 * so on the wire: `clock: 'salon_local'`.
 *
 * ==========================================================================
 * THE DEFINITIONS
 * ==========================================================================
 *   LOADED      what customers PAID on settled top-ups — `amount_fils - bonus_fils
 *               - promo_bonus_fils` (`platformMetrics.ts § PAID_FILS`, imported,
 *               not retyped), bucketed on `settled_at`. NOT the merchant Overview's
 *               `wallet.loadedFils`, which is the CREDIT (bonus included) bucketed
 *               on `created_at` in the salon's zone; the console has always meant
 *               the paid amount, because commission is charged on it. The credited
 *               bonus is served beside it as `bonusFils`, so credit is a sum of two
 *               served integers.
 *   REVENUE     AVO's commission: `sum(fee_fils)` on the same rows. The fee was
 *               decided per top-up at intent time (`commissionFor` against that
 *               moment's `platform_settings`), so it is summed, never recomputed
 *               from today's rate. Split by method: KNET is the flat fee, card and
 *               Apple Pay are both on the card percentage (`commissionFor` prices
 *               every non-KNET method on `cardPercent` + `cardFlatFils`).
 *   SPENT       the merchant Overview's definition: `earned_fils` over settled,
 *               not-voided charges and shop orders, plus every deposit a salon KEPT
 *               (`keptDepositJoin`), bucketed on `created_at` — in the platform
 *               zone here.
 *   LIABILITY   `sum(member.balance_fils)` now, erased members included — a balance
 *               is owed whoever it is owed to.
 *   ACTIVE MEMBER   at least one settled transaction of any kind created in the
 *               month — `metrics.ts § activeMembers`, over a calendar month.
 *   ACTIVE SALON    at least one settled transaction of any kind created in the
 *               month — the same rule, so a salon is active exactly when it has an
 *               active member. DORMANT is a salon that existed by the month's end
 *               (`created_at` before it) and was not active.
 *   VISIT       a settled, not-voided `charge` (overviewAnalytics' definition).
 *   MEMBERS     `count(*) FROM member`, tombstones included — `/v1/platform/metrics`
 *               and `/v1/platform/salons` both count wallets on the books, so this
 *               does too. NEW MEMBERS are bucketed on `created_at`, which is what
 *               `/metrics`' `addedThisMonth` reads. The loyalty snapshot EXCLUDES
 *               the erased (Overview's rule: they are members of nothing any more).
 *
 * ==========================================================================
 * GATES — `requirePlatform('analytics')` on the endpoint, and two more blocks
 * ==========================================================================
 * The Overview's rule, translated: a block that is another console SECTION'S
 * data is gated on that section as well, and a withheld block's QUERY IS NOT RUN.
 *
 *   campaigns   `approvals`   `GET /v1/platform/campaigns`' gate
 *   support     `policies`    the queue's console gate — `routes/support.ts §
 *                             requireQueueReader` takes `requirePlatform('policies')`
 *                             for a platform admin. NOT `accounts`: that is the
 *                             section the support PRESET holds, and the preset does
 *                             not hold `analytics`, so it cannot reach this endpoint
 *                             at all (see the route header).
 *
 * `module_off` (scoped to one salon only): `bookings` without the booking module,
 * `shop` without the shop module — the Overview's shop rule. Across every salon,
 * both blocks cover the salons with the module ON, and say how many. In the
 * leaderboard a module that is off is `null` in its columns, never 0.
 *
 * ==========================================================================
 * NO MEMBER PII, ANYWHERE
 * ==========================================================================
 * Every figure is a count or a sum. The only names on this object are SALON
 * names. No member id, name, phone or email is selected by any query below.
 *
 * ==========================================================================
 * ONE SCAN PER SOURCE, FOLDED IN TYPESCRIPT
 * ==========================================================================
 * Each source is read ONCE, grouped by (month, salon[, method | kind | status]),
 * and every block that needs it folds the same rows. So the leaderboard's loaded
 * column and the money series' loaded bar for that month are the same integers
 * summed two ways — they cannot disagree, because there is one answer. The row
 * count is bounded by months × salons × a few methods.
 */

import { sql, type SQL } from 'drizzle-orm';
import { add, fils, type Fils } from '@avo/types';
import type { Db } from '../db/client';
import type { PlatformSection } from '../auth/principal';
import { badRequest } from '../http/errors';
import { keptDepositJoin, revenueJoin } from '../money/revenue';
import { PLATFORM_TIMEZONE, wallClockInstant } from '../time/zone';
import { at, int } from './metrics';
import { basisPoints } from './overviewAnalytics';
import { PAID_FILS } from './platformMetrics';
import { NOT_VOIDED } from './reports';

// ------------------------------------------------------------------ shapes --

export type PlatformWithheldReason = 'permission' | 'module_off';

export interface PlatformWithheld {
  status: 'withheld';
  reason: PlatformWithheldReason;
  /** The section that would unlock it. Non-null exactly when `reason` is `permission`. */
  permission: PlatformSection | null;
}

export type PlatformBlock<T> = ({ status: 'ok' } & T) | PlatformWithheld;

export type Method = 'knet' | 'card' | 'applepay';
export const METHODS: readonly Method[] = ['knet', 'card', 'applepay'];
export const PLANS = ['starter', 'growth', 'pro'] as const;
export const TIERS = ['bronze', 'silver', 'gold', 'black'] as const;
export const ORDER_STATUSES = ['preparing', 'ready', 'closed'] as const;

export interface MethodTotal {
  count: number;
  fils: Fils;
  shareBp: number | null;
}

export interface LeaderboardRow {
  salonId: string;
  name: string;
  modules: { booking: boolean; shop: boolean };
  members: number;
  activeMembers: number;
  loadedFils: Fils;
  spentFils: Fils;
  avoRevenueFils: Fils;
  bookings: number | null;
  noShowRateBp: number | null;
  shopRevenueFils: Fils | null;
  liabilityFils: Fils;
}

export interface PlatformAnalytics {
  asOf: string;
  timezone: string;
  month: string;
  partial: boolean;
  months: string[];
  salonId: string | null;
  salonName: string | null;

  revenue: PlatformBlock<{
    months: Array<{
      month: string;
      feeFils: Fils;
      topups: number;
      byMethod: Record<Method, { topups: number; feeFils: Fils }>;
    }>;
    thisMonthFils: Fils;
    priorMonth: string;
    priorMonthFils: Fils;
  }>;
  money: PlatformBlock<{
    months: Array<{ month: string; loadedFils: Fils; bonusFils: Fils; spentFils: Fils }>;
    liabilityFils: Fils;
    liabilityBySalon: Array<{ salonId: string; name: string; liabilityFils: Fils }>;
  }>;
  salons: PlatformBlock<{
    total: number;
    byPlan: Record<(typeof PLANS)[number], number>;
    branches: { open: number; closed: number };
    months: Array<{ month: string; newSalons: number; active: number; dormant: number }>;
  }>;
  members: PlatformBlock<{
    total: number;
    months: Array<{ month: string; newMembers: number; activeMembers: number }>;
    tiers: { salons: number; untiered: number } & Record<(typeof TIERS)[number], number>;
    stamps: { salons: number; buckets: Array<{ stampTarget: number; stamps: number; members: number }> };
  }>;
  leaderboard: PlatformBlock<{ rows: LeaderboardRow[] }>;
  paymentMix: PlatformBlock<{
    topups: number;
    loadedFils: Fils;
    methods: Record<Method, MethodTotal>;
  }>;
  bookings: PlatformBlock<{
    salons: number;
    months: Array<{
      month: string;
      bookings: number;
      completed: number;
      noShows: number;
      rateBp: number | null;
    }>;
    depositsHeld: { bookings: number; fils: Fils };
  }>;
  campaigns: PlatformBlock<{
    pendingNow: number;
    months: Array<{
      month: string;
      submitted: number;
      approved: number;
      rejected: number;
      sent: number;
      held: number;
      medianDecisionSeconds: number | null;
      p90DecisionSeconds: number | null;
    }>;
  }>;
  support: PlatformBlock<{
    openNow: { total: number; avo: number; salon: number };
    months: Array<{ month: string; opened: number; resolved: number }>;
  }>;
  shop: PlatformBlock<{
    salons: number;
    months: Array<{ month: string; gmvFils: Fils; orders: number }>;
    ordersByStatus: Record<(typeof ORDER_STATUSES)[number], number>;
  }>;
  busiestTimes: PlatformBlock<{
    clock: 'salon_local';
    cells: Array<{ weekday: number; hour: number; visits: number }>;
    totalVisits: number;
  }>;
}

// ---------------------------------------------------------- the parameters --

/** A calendar month, `month` 1–12. */
export interface CalendarMonth {
  year: number;
  month: number;
}

export const DEFAULT_HISTORY_MONTHS = 12;
export const MAX_HISTORY_MONTHS = 24;
/** No AVO data predates this; a month before it is a typo, not a question. */
const EARLIEST_YEAR = 2000;

export function monthKey(m: CalendarMonth): string {
  return `${String(m.year).padStart(4, '0')}-${String(m.month).padStart(2, '0')}`;
}

/** `m` shifted by `n` months (negative is earlier). Pure integer arithmetic. */
export function shiftMonth(m: CalendarMonth, n: number): CalendarMonth {
  const i = m.year * 12 + (m.month - 1) + n;
  return { year: Math.floor(i / 12), month: (i % 12) + 1 };
}

/** The platform-zone month containing `now`. */
export function currentMonth(now: Date): CalendarMonth {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: PLATFORM_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { year: get('year'), month: get('month') };
}

/** The first instant of `m` in the platform zone. */
export function monthStartInstant(m: CalendarMonth): Date {
  return wallClockInstant({ year: m.year, month: m.month, day: 1 }, 0, PLATFORM_TIMEZONE);
}

const compare = (a: CalendarMonth, b: CalendarMonth) => a.year * 12 + a.month - (b.year * 12 + b.month);

/**
 * `?month=`. Absent or empty is the current platform month. `YYYY-MM` only; a
 * month after the current one is refused rather than answered with zeros — a
 * future month has no figures, and a page of zeros would read as a quiet one.
 */
export function parseMonth(value: unknown, now: Date): CalendarMonth {
  const current = currentMonth(now);
  if (value === undefined || value === null || value === '') return current;
  const m = typeof value === 'string' ? /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value) : null;
  if (!m) throw badRequest('invalid_month', 'month must be a calendar month, YYYY-MM.');
  const parsed = { year: Number(m[1]), month: Number(m[2]) };
  if (parsed.year < EARLIEST_YEAR) {
    throw badRequest('invalid_month', `month must be ${EARLIEST_YEAR}-01 or later.`);
  }
  if (compare(parsed, current) > 0) {
    throw badRequest('invalid_month', `month cannot be after the current month, ${monthKey(current)}.`);
  }
  return parsed;
}

/** `?months=`. Absent is 12; otherwise a whole number 1–24, as text or a number. */
export function parseHistoryMonths(value: unknown): number {
  if (value === undefined || value === null || value === '') return DEFAULT_HISTORY_MONTHS;
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,3}$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > MAX_HISTORY_MONTHS) {
    throw badRequest('invalid_months', `months must be a whole number from 1 to ${MAX_HISTORY_MONTHS}.`);
  }
  return n;
}

/** The history: `count` months ending at `selected`, oldest first. */
export function historyOf(selected: CalendarMonth, count: number): CalendarMonth[] {
  return Array.from({ length: count }, (_, i) => shiftMonth(selected, i - (count - 1)));
}

// ------------------------------------------------------------------ compute --

export interface PlatformAnalyticsSalon {
  id: string;
  name: string;
  moduleBooking: boolean;
  moduleShop: boolean;
}

export interface PlatformAnalyticsScope {
  month: CalendarMonth;
  months: number;
  /** Resolved by the route; an unknown id is a 404 there. Null is every salon. */
  salon: PlatformAnalyticsSalon | null;
  /** The caller's sections AS THEY ARE NOW — the principal's, or the live row's for a link. */
  sections: Record<PlatformSection, boolean>;
  now: Date;
}

type Rows = Array<Record<string, unknown>>;

/** A money aggregate. Refuses a fraction rather than truncating one. */
function money(value: unknown): Fils {
  if (value === null || value === undefined) return fils(0);
  return fils(Number(value));
}

const withheld = (
  reason: PlatformWithheldReason,
  permission: PlatformSection | null = null,
): PlatformWithheld => ({ status: 'withheld', reason, permission });

/** `to_char(date_trunc('month', col AT TIME ZONE platform), 'YYYY-MM')` — the one bucketing. */
function monthOf(col: SQL): SQL {
  return sql`to_char(date_trunc('month', ${col} AT TIME ZONE ${PLATFORM_TIMEZONE}), 'YYYY-MM')`;
}

/** Sum a keyed map's money. */
function sumFils(values: Iterable<Fils>): Fils {
  let total = fils(0);
  for (const v of values) total = add(total, v);
  return total;
}

/** `${month}|${salon}` — the fold key. */
const k = (month: unknown, salon: unknown) => `${String(month)}|${String(salon)}`;

export async function computePlatformAnalytics(
  db: Db,
  scope: PlatformAnalyticsScope,
): Promise<PlatformAnalytics> {
  const { sections, now } = scope;
  const sel = scope.month;
  const history = historyOf(sel, scope.months);
  const keys = history.map(monthKey);
  const selKey = monthKey(sel);
  const prior = shiftMonth(sel, -1);
  const priorKey = monthKey(prior);

  const histFrom = monthStartInstant(history[0]!);
  const selFrom = monthStartInstant(sel);
  const selTo = monthStartInstant(shiftMonth(sel, 1));
  // The top-up scan also covers the prior month, which `revenue` compares against
  // even when the history is a single month.
  const topupFrom = scope.months >= 2 ? histFrom : monthStartInstant(prior);

  const salonId = scope.salon?.id ?? null;
  const rows = async (q: SQL): Promise<Rows> => (await db.execute(q)) as unknown as Rows;
  /** `AND <alias>.salon_id = $s`, or nothing — so every-salon SQL is unfiltered. */
  const onSalon = (alias: string) =>
    salonId === null ? sql`` : sql`AND ${sql.identifier(alias)}.salon_id = ${salonId}`;

  // --------------------------------------------------------------- salons --
  /**
   * EVERY SALON IN SCOPE, read once: the leaderboard's rows, the module flags,
   * the plan and creation date for the salons block. Bounded by the number of
   * tenants, which is the smallest table here.
   */
  const salonRows = await rows(sql`
    SELECT s.id, s.name, s.plan::text AS plan, s.created_at,
           s.module_booking, s.module_shop
      FROM salon s
     WHERE true ${salonId === null ? sql`` : sql`AND s.id = ${salonId}`}
     ORDER BY s.id
  `);
  const salons = salonRows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    plan: String(r.plan),
    createdAt: new Date(r.created_at as string | Date),
    booking: Boolean(r.module_booking),
    shop: Boolean(r.module_shop),
  }));
  const bookingOn = new Set(salons.filter((s) => s.booking).map((s) => s.id));
  const shopOn = new Set(salons.filter((s) => s.shop).map((s) => s.id));

  // -------------------------------------------------------------- top-ups --
  /**
   * ONE SCAN FOR `revenue`, `money.loaded`, `paymentMix` AND THE LEADERBOARD'S
   * loaded and revenue columns. `platformMetrics.ts`' predicate exactly: settled
   * top-ups, on `settled_at`, `PAID_FILS` for loaded and `fee_fils` for revenue.
   */
  const topups = await rows(sql`
    SELECT ${monthOf(sql`t.settled_at`)} AS month, t.salon_id, t.method::text AS method,
           count(*) AS n,
           coalesce(sum(${PAID_FILS}), 0)::bigint AS paid,
           coalesce(sum(t.bonus_fils + t.promo_bonus_fils), 0)::bigint AS bonus,
           coalesce(sum(t.fee_fils), 0)::bigint AS fee
      FROM "transaction" t
     WHERE t.kind = 'topup' AND t.status = 'settled' AND t.settled_at IS NOT NULL
       AND t.settled_at >= ${at(topupFrom)} AND t.settled_at < ${at(selTo)}
       ${onSalon('t')}
     GROUP BY 1, 2, 3
  `);

  // ---------------------------------------------------------------- spent --
  /**
   * The Overview's SPENT, grouped: `earned_fils` over settled, not-voided charges
   * and shop orders, by kind (so the shop half is also the shop GMV and the
   * leaderboard's shop column), plus kept deposits below.
   */
  const sold = await rows(sql`
    SELECT ${monthOf(sql`t.created_at`)} AS month, t.salon_id, t.kind::text AS kind,
           count(*) AS n,
           coalesce(sum(rev.earned_fils), 0)::bigint AS earned
      FROM "transaction" t
      ${revenueJoin('t')}
     WHERE t.kind IN ('charge', 'shop') AND t.status = 'settled'
       AND t.created_at >= ${at(histFrom)} AND t.created_at < ${at(selTo)}
       ${onSalon('t')}
       ${NOT_VOIDED}
     GROUP BY 1, 2, 3
  `);
  /** `sales`' kept-deposits predicate, verbatim, as the Overview's wallet block has it. */
  const kept = await rows(sql`
    SELECT ${monthOf(sql`t.created_at`)} AS month, t.salon_id,
           coalesce(sum(kept.amount_fils), 0)::bigint AS kept
      FROM "transaction" t
      ${keptDepositJoin('t')}
     WHERE t.kind = 'deposit_forfeit' AND t.status = 'settled'
       AND t.created_at >= ${at(histFrom)} AND t.created_at < ${at(selTo)}
       ${onSalon('t')}
       ${NOT_VOIDED}
     GROUP BY 1, 2
  `);

  // ------------------------------------------------------- active members --
  /**
   * `metrics.ts § activeMembers` over a calendar month, per salon. A member is
   * one salon's wallet (`member.salon_id`), so distinct members per salon SUM to
   * distinct members across the platform — no member is counted at two salons.
   */
  const active = await rows(sql`
    SELECT ${monthOf(sql`t.created_at`)} AS month, t.salon_id,
           count(DISTINCT t.member_id) AS members
      FROM "transaction" t
     WHERE t.status = 'settled'
       AND t.created_at >= ${at(histFrom)} AND t.created_at < ${at(selTo)}
       ${onSalon('t')}
     GROUP BY 1, 2
  `);

  // ------------------------------------------------------ members, balances --
  const memberNow = await rows(sql`
    SELECT m.salon_id, count(*) AS n, coalesce(sum(m.balance_fils), 0)::bigint AS balance
      FROM member m
     WHERE true ${onSalon('m')}
     GROUP BY 1
  `);
  const newMembers = await rows(sql`
    SELECT ${monthOf(sql`m.created_at`)} AS month, count(*) AS n
      FROM member m
     WHERE m.created_at >= ${at(histFrom)} AND m.created_at < ${at(selTo)}
       ${onSalon('m')}
     GROUP BY 1
  `);

  // ------------------------------------------------------------- bookings --
  /**
   * `overviewAnalytics.ts`' booking figures, per month and salon: `bookings` is
   * not cancelled with `starts_at` in the month; the no-show rate's denominator is
   * the resolved ones (completed + no-show). Folded only over module-on salons.
   */
  const booked = await rows(sql`
    SELECT ${monthOf(sql`b.starts_at`)} AS month, b.salon_id,
           count(*) FILTER (WHERE b.status <> 'cancelled') AS bookings,
           count(*) FILTER (WHERE b.status = 'completed') AS completed,
           count(*) FILTER (WHERE b.status = 'no_show_returned') AS no_shows
      FROM booking b
     WHERE b.starts_at >= ${at(histFrom)} AND b.starts_at < ${at(selTo)}
       ${onSalon('b')}
     GROUP BY 1, 2
  `);

  // ---------------------------------------------------------------- folds --
  const paidBy = new Map<string, Fils>(); // month|salon
  const feeBy = new Map<string, Fils>(); // month|salon
  const bonusByMonth = new Map<string, Fils>();
  const revByMonth = new Map<string, { fee: Fils; n: number; m: Record<Method, { topups: number; feeFils: Fils }> }>();
  const mixSel: Record<Method, { count: number; fils: Fils }> = {
    knet: { count: 0, fils: fils(0) },
    card: { count: 0, fils: fils(0) },
    applepay: { count: 0, fils: fils(0) },
  };
  let mixTopups = 0;
  let mixLoaded = fils(0);
  const emptyByMethod = (): Record<Method, { topups: number; feeFils: Fils }> => ({
    knet: { topups: 0, feeFils: fils(0) },
    card: { topups: 0, feeFils: fils(0) },
    applepay: { topups: 0, feeFils: fils(0) },
  });
  for (const r of topups) {
    const month = String(r.month);
    const key = k(month, r.salon_id);
    const paid = money(r.paid);
    const fee = money(r.fee);
    const n = int(r.n);
    paidBy.set(key, add(paidBy.get(key) ?? fils(0), paid));
    feeBy.set(key, add(feeBy.get(key) ?? fils(0), fee));
    bonusByMonth.set(month, add(bonusByMonth.get(month) ?? fils(0), money(r.bonus)));
    const rev = revByMonth.get(month) ?? { fee: fils(0), n: 0, m: emptyByMethod() };
    rev.fee = add(rev.fee, fee);
    rev.n += n;
    const method = r.method as Method;
    if (METHODS.includes(method)) {
      rev.m[method].topups += n;
      rev.m[method].feeFils = add(rev.m[method].feeFils, fee);
    }
    revByMonth.set(month, rev);
    if (month === selKey) {
      mixTopups += n;
      mixLoaded = add(mixLoaded, paid);
      if (METHODS.includes(method)) {
        mixSel[method].count += n;
        mixSel[method].fils = add(mixSel[method].fils, paid);
      }
    }
  }

  const spentBy = new Map<string, Fils>(); // month|salon
  const shopBy = new Map<string, Fils>(); // month|salon
  for (const r of sold) {
    const key = k(r.month, r.salon_id);
    const earned = money(r.earned);
    spentBy.set(key, add(spentBy.get(key) ?? fils(0), earned));
    if (r.kind === 'shop') shopBy.set(key, add(shopBy.get(key) ?? fils(0), earned));
  }
  for (const r of kept) {
    const key = k(r.month, r.salon_id);
    spentBy.set(key, add(spentBy.get(key) ?? fils(0), money(r.kept)));
  }

  const activeBy = new Map<string, number>(); // month|salon
  for (const r of active) activeBy.set(k(r.month, r.salon_id), int(r.members));

  const membersOf = new Map<string, { n: number; balance: Fils }>();
  for (const r of memberNow) membersOf.set(String(r.salon_id), { n: int(r.n), balance: money(r.balance) });

  const bookedBy = new Map<string, { bookings: number; completed: number; noShows: number }>();
  for (const r of booked) {
    bookedBy.set(k(r.month, r.salon_id), {
      bookings: int(r.bookings),
      completed: int(r.completed),
      noShows: int(r.no_shows),
    });
  }

  /** Sum a month|salon map over the salons of a set (or all) for one month. */
  const monthSum = (map: Map<string, Fils>, month: string, only?: Set<string>): Fils =>
    sumFils(salons.filter((s) => !only || only.has(s.id)).map((s) => map.get(k(month, s.id)) ?? fils(0)));

  // ------------------------------------------------------------- 1. revenue --
  const revenue: PlatformAnalytics['revenue'] = {
    status: 'ok',
    months: keys.map((month) => {
      const r = revByMonth.get(month);
      return {
        month,
        feeFils: r?.fee ?? fils(0),
        topups: r?.n ?? 0,
        byMethod: r?.m ?? emptyByMethod(),
      };
    }),
    thisMonthFils: revByMonth.get(selKey)?.fee ?? fils(0),
    priorMonth: priorKey,
    priorMonthFils: revByMonth.get(priorKey)?.fee ?? fils(0),
  };

  // --------------------------------------------------------------- 2. money --
  const liabilityBySalon = salons
    .map((s) => ({ salonId: s.id, name: s.name, liabilityFils: membersOf.get(s.id)?.balance ?? fils(0) }))
    .sort((a, b) => b.liabilityFils - a.liabilityFils || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const moneyBlock: PlatformAnalytics['money'] = {
    status: 'ok',
    months: keys.map((month) => ({
      month,
      loadedFils: monthSum(paidBy, month),
      bonusFils: bonusByMonth.get(month) ?? fils(0),
      spentFils: monthSum(spentBy, month),
    })),
    liabilityFils: sumFils(liabilityBySalon.map((x) => x.liabilityFils)),
    liabilityBySalon,
  };

  // -------------------------------------------------------------- 3. salons --
  const branchRow = (
    await rows(sql`
      SELECT count(*) FILTER (WHERE br.closed_at IS NULL) AS open,
             count(*) FILTER (WHERE br.closed_at IS NOT NULL) AS closed
        FROM branch br
       WHERE true ${onSalon('br')}
    `)
  )[0];
  const salonsBlock: PlatformAnalytics['salons'] = {
    status: 'ok',
    total: salons.length,
    byPlan: {
      starter: salons.filter((s) => s.plan === 'starter').length,
      growth: salons.filter((s) => s.plan === 'growth').length,
      pro: salons.filter((s) => s.plan === 'pro').length,
    },
    branches: { open: int(branchRow?.open), closed: int(branchRow?.closed) },
    months: history.map((m) => {
      const month = monthKey(m);
      const from = monthStartInstant(m).getTime();
      const to = monthStartInstant(shiftMonth(m, 1)).getTime();
      const existing = salons.filter((s) => s.createdAt.getTime() < to);
      const activeCount = existing.filter((s) => (activeBy.get(k(month, s.id)) ?? 0) > 0).length;
      return {
        month,
        newSalons: salons.filter((s) => s.createdAt.getTime() >= from && s.createdAt.getTime() < to).length,
        active: activeCount,
        dormant: existing.length - activeCount,
      };
    }),
  };

  // ------------------------------------------------------------- 4. members --
  /**
   * THE LOYALTY SNAPSHOT, by the mode each salon is in. Tiers are the four-rung
   * enum the column holds (`tier_name`), so they add across salons; a tiers-salon
   * member with no tier is `untiered`. Stamps do NOT add across salons with
   * different targets — 4 of 6 and 4 of 10 are different progress — so each bucket
   * names its target: (stampTarget, stamps, members). Erased members excluded.
   */
  const tierRows = await rows(sql`
    SELECT m.tier::text AS tier, count(*) AS n
      FROM member m
      JOIN salon s ON s.id = m.salon_id
     WHERE s.loyalty_mode = 'tiers' AND m.erased_at IS NULL ${onSalon('m')}
     GROUP BY 1
  `);
  const stampRows = await rows(sql`
    SELECT coalesce(s.stamp_target, 0) AS target, coalesce(m.stamps, 0) AS stamps, count(*) AS n
      FROM member m
      JOIN salon s ON s.id = m.salon_id
     WHERE s.loyalty_mode = 'stamps' AND m.erased_at IS NULL ${onSalon('m')}
     GROUP BY 1, 2
     ORDER BY 1, 2
  `);
  const modeRow = (
    await rows(sql`
      SELECT count(*) FILTER (WHERE s.loyalty_mode = 'tiers') AS tiers,
             count(*) FILTER (WHERE s.loyalty_mode = 'stamps') AS stamps
        FROM salon s
       WHERE true ${salonId === null ? sql`` : sql`AND s.id = ${salonId}`}
    `)
  )[0];
  const tierCount = (t: string) => int(tierRows.find((x) => x.tier === t)?.n);
  const tiered = TIERS.reduce((n, t) => n + tierCount(t), 0);
  const newByMonth = new Map(newMembers.map((r) => [String(r.month), int(r.n)]));
  const membersBlock: PlatformAnalytics['members'] = {
    status: 'ok',
    total: [...membersOf.values()].reduce((n, x) => n + x.n, 0),
    months: keys.map((month) => ({
      month,
      newMembers: newByMonth.get(month) ?? 0,
      activeMembers: salons.reduce((n, s) => n + (activeBy.get(k(month, s.id)) ?? 0), 0),
    })),
    tiers: {
      salons: int(modeRow?.tiers),
      bronze: tierCount('bronze'),
      silver: tierCount('silver'),
      gold: tierCount('gold'),
      black: tierCount('black'),
      untiered: tierRows.reduce((n, x) => n + int(x.n), 0) - tiered,
    },
    stamps: {
      salons: int(modeRow?.stamps),
      buckets: stampRows.map((r) => ({ stampTarget: int(r.target), stamps: int(r.stamps), members: int(r.n) })),
    },
  };

  // --------------------------------------------------------- 5. leaderboard --
  /**
   * One row per salon in scope, the selected month, every column from the folds
   * above. Sorted by loaded, then name, then id — every salon, zeros included, so
   * a quiet salon is visible as quiet. `bookings`, `noShowRateBp` and
   * `shopRevenueFils` are NULL when that module is off: "0 bookings" would claim a
   * booking book that nobody uses.
   */
  const rowsOut: LeaderboardRow[] = salons.map((s) => {
    const key = k(selKey, s.id);
    const b = bookedBy.get(key);
    return {
      salonId: s.id,
      name: s.name,
      modules: { booking: s.booking, shop: s.shop },
      members: membersOf.get(s.id)?.n ?? 0,
      activeMembers: activeBy.get(key) ?? 0,
      loadedFils: paidBy.get(key) ?? fils(0),
      spentFils: spentBy.get(key) ?? fils(0),
      avoRevenueFils: feeBy.get(key) ?? fils(0),
      bookings: s.booking ? (b?.bookings ?? 0) : null,
      noShowRateBp: s.booking ? basisPoints(b?.noShows ?? 0, (b?.completed ?? 0) + (b?.noShows ?? 0)) : null,
      shopRevenueFils: s.shop ? (shopBy.get(key) ?? fils(0)) : null,
      liabilityFils: membersOf.get(s.id)?.balance ?? fils(0),
    };
  });
  rowsOut.sort(
    (a, b) =>
      b.loadedFils - a.loadedFils ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
      (a.salonId < b.salonId ? -1 : 1),
  );
  const leaderboard: PlatformAnalytics['leaderboard'] = { status: 'ok', rows: rowsOut };

  // ---------------------------------------------------------- 6. paymentMix --
  const paymentMix: PlatformAnalytics['paymentMix'] = {
    status: 'ok',
    topups: mixTopups,
    loadedFils: mixLoaded,
    methods: {
      knet: { ...mixSel.knet, shareBp: basisPoints(mixSel.knet.fils, mixLoaded) },
      card: { ...mixSel.card, shareBp: basisPoints(mixSel.card.fils, mixLoaded) },
      applepay: { ...mixSel.applepay, shareBp: basisPoints(mixSel.applepay.fils, mixLoaded) },
    },
  };

  // ------------------------------------------------------------ 7. bookings --
  /**
   * DEPOSITS HELD is `depositHealth.ts § held`, predicate for predicate, summed
   * across the module-on salons: every `deposit_held` booking, no time bound. A
   * current snapshot, not a month figure.
   */
  let bookings: PlatformAnalytics['bookings'];
  if (scope.salon !== null && !scope.salon.moduleBooking) {
    bookings = withheld('module_off');
  } else {
    const heldRows = await rows(sql`
      SELECT b.salon_id, count(*) AS n, coalesce(sum(b.deposit_fils), 0)::bigint AS held
        FROM booking b
       WHERE b.status = 'deposit_held' ${onSalon('b')}
       GROUP BY 1
    `);
    const on = heldRows.filter((r) => bookingOn.has(String(r.salon_id)));
    bookings = {
      status: 'ok',
      salons: bookingOn.size,
      months: keys.map((month) => {
        let n = 0;
        let completed = 0;
        let noShows = 0;
        for (const id of bookingOn) {
          const b = bookedBy.get(k(month, id));
          n += b?.bookings ?? 0;
          completed += b?.completed ?? 0;
          noShows += b?.noShows ?? 0;
        }
        return { month, bookings: n, completed, noShows, rateBp: basisPoints(noShows, completed + noShows) };
      }),
      depositsHeld: {
        bookings: on.reduce((n, r) => n + int(r.n), 0),
        fils: sumFils(on.map((r) => money(r.held))),
      },
    };
  }

  // ----------------------------------------------------------- 8. campaigns --
  /**
   * `approvals`, and the query is not run without it.
   *
   *   submitted   `submitted_at` in the month. A pending campaign the merchant
   *               WITHDREW is deleted (`DELETE …/campaigns/{cid}`), so it is not
   *               here — this counts submissions that still exist.
   *   approved    `decided_at` in the month, decided `approved` (now `approved` or
   *               `sent` — a sent campaign was approved first).
   *   rejected    `decided_at` in the month, `rejected`.
   *   sent        its FIRST `campaign_send.sent_at` in the month — the Overview's
   *               definition. A campaign every recipient of which was capped out has
   *               no send row and is not counted as sent.
   *   held        approved and currently held (`held_reason` set), on `held_at`.
   *               A hold is the state `approved + held_reason`, not a status, so a
   *               campaign released later is no longer counted here.
   *   decision    `decided_at - submitted_at` over the month's decisions, whole
   *               seconds, `percentile_disc` — an observed duration, never an
   *               interpolated one, so it stays an integer. Null with no decisions.
   */
  let campaigns: PlatformAnalytics['campaigns'];
  if (!sections.approvals) {
    campaigns = withheld('permission', 'approvals');
  } else {
    const submitted = await rows(sql`
      SELECT ${monthOf(sql`c.submitted_at`)} AS month, count(*) AS n
        FROM campaign c
       WHERE c.submitted_at >= ${at(histFrom)} AND c.submitted_at < ${at(selTo)} ${onSalon('c')}
       GROUP BY 1
    `);
    const decided = await rows(sql`
      SELECT ${monthOf(sql`c.decided_at`)} AS month,
             count(*) FILTER (WHERE c.status IN ('approved', 'sent')) AS approved,
             count(*) FILTER (WHERE c.status = 'rejected') AS rejected,
             percentile_disc(0.5) WITHIN GROUP (
               ORDER BY floor(extract(epoch FROM c.decided_at - c.submitted_at))::bigint) AS p50,
             percentile_disc(0.9) WITHIN GROUP (
               ORDER BY floor(extract(epoch FROM c.decided_at - c.submitted_at))::bigint) AS p90
        FROM campaign c
       WHERE c.decided_at IS NOT NULL
         AND c.decided_at >= ${at(histFrom)} AND c.decided_at < ${at(selTo)} ${onSalon('c')}
       GROUP BY 1
    `);
    const sent = await rows(sql`
      SELECT ${monthOf(sql`s.sent_at`)} AS month, count(*) AS n
        FROM campaign c
        CROSS JOIN LATERAL (
          SELECT min(cs.sent_at) AS sent_at FROM campaign_send cs WHERE cs.campaign_id = c.id
        ) s
       WHERE c.status = 'sent' AND c.decided_at < ${at(selTo)} ${onSalon('c')}
         AND s.sent_at >= ${at(histFrom)} AND s.sent_at < ${at(selTo)}
       GROUP BY 1
    `);
    const held = await rows(sql`
      SELECT ${monthOf(sql`c.held_at`)} AS month, count(*) AS n
        FROM campaign c
       WHERE c.status = 'approved' AND c.held_reason IS NOT NULL
         AND c.held_at >= ${at(histFrom)} AND c.held_at < ${at(selTo)} ${onSalon('c')}
       GROUP BY 1
    `);
    const pending = (
      await rows(sql`SELECT count(*) AS n FROM campaign c WHERE c.status = 'pending' ${onSalon('c')}`)
    )[0];
    const by = (r: Rows, col = 'n') => new Map(r.map((x) => [String(x.month), int(x[col])]));
    const sub = by(submitted);
    const snt = by(sent);
    const hld = by(held);
    const dec = new Map(decided.map((x) => [String(x.month), x]));
    const seconds = (v: unknown) => (v === null || v === undefined ? null : int(v));
    campaigns = {
      status: 'ok',
      pendingNow: int(pending?.n),
      months: keys.map((month) => {
        const d = dec.get(month);
        return {
          month,
          submitted: sub.get(month) ?? 0,
          approved: int(d?.approved),
          rejected: int(d?.rejected),
          sent: snt.get(month) ?? 0,
          held: hld.get(month) ?? 0,
          medianDecisionSeconds: seconds(d?.p50),
          p90DecisionSeconds: seconds(d?.p90),
        };
      }),
    };
  }

  // ------------------------------------------------------------- 9. support --
  /**
   * `policies` — the support queue's own console gate — and not run without it.
   *
   *   opened     `created_at` in the month. Both queues (AVO-routed and
   *              salon-routed), which is what the console's queue reader sees.
   *   resolved   `status = 'closed'` with `updated_at` in the month. `status` is
   *              the ONLY field `PATCH /v1/support/tickets/{id}` can change and it
   *              stamps `updated_at` only when the status moves, so for a closed
   *              ticket `updated_at` IS when it was closed. A ticket closed, then
   *              reopened and still open, is not counted as resolved anywhere —
   *              there is no history table to say it once was.
   *   openNow    `status = 'open'`, by route.
   *
   * FIRST-RESPONSE TIME IS NOT SERVED: nothing records a reply. A ticket has a
   * status and a timestamp, and the reply goes out over WhatsApp or email outside
   * the API. Reported rather than approximated from `updated_at`, which would be
   * time-to-close labelled as time-to-reply.
   */
  let support: PlatformAnalytics['support'];
  if (!sections.policies) {
    support = withheld('permission', 'policies');
  } else {
    const opened = await rows(sql`
      SELECT ${monthOf(sql`st.created_at`)} AS month, count(*) AS n
        FROM support_ticket st
       WHERE st.created_at >= ${at(histFrom)} AND st.created_at < ${at(selTo)} ${onSalon('st')}
       GROUP BY 1
    `);
    const resolved = await rows(sql`
      SELECT ${monthOf(sql`st.updated_at`)} AS month, count(*) AS n
        FROM support_ticket st
       WHERE st.status = 'closed'
         AND st.updated_at >= ${at(histFrom)} AND st.updated_at < ${at(selTo)} ${onSalon('st')}
       GROUP BY 1
    `);
    const open = await rows(sql`
      SELECT st.route, count(*) AS n
        FROM support_ticket st
       WHERE st.status = 'open' ${onSalon('st')}
       GROUP BY 1
    `);
    const o = new Map(opened.map((x) => [String(x.month), int(x.n)]));
    const r = new Map(resolved.map((x) => [String(x.month), int(x.n)]));
    const avo = int(open.find((x) => x.route === 'avo')?.n);
    const salonQ = int(open.find((x) => x.route === 'salon')?.n);
    support = {
      status: 'ok',
      openNow: { total: avo + salonQ, avo, salon: salonQ },
      months: keys.map((month) => ({ month, opened: o.get(month) ?? 0, resolved: r.get(month) ?? 0 })),
    };
  }

  // ---------------------------------------------------------------- 10. shop --
  /**
   * GMV is the Overview's shop `revenueFils` — `earned_fils` over settled,
   * not-voided shop rows — from the same scan as SPENT, so GMV is exactly the shop
   * half of it. ORDERS are `shop_order` rows placed in the month, whatever later
   * happened to the money (the Overview's board rule); ORDERS BY STATUS is the
   * selected month's orders by where they stand now. Module-on salons only.
   */
  let shop: PlatformAnalytics['shop'];
  if (scope.salon !== null && !scope.salon.moduleShop) {
    shop = withheld('module_off');
  } else {
    const orderRows = await rows(sql`
      SELECT ${monthOf(sql`o.created_at`)} AS month, o.salon_id, o.status::text AS status, count(*) AS n
        FROM shop_order o
       WHERE o.created_at >= ${at(histFrom)} AND o.created_at < ${at(selTo)} ${onSalon('o')}
       GROUP BY 1, 2, 3
    `);
    const on = orderRows.filter((r) => shopOn.has(String(r.salon_id)));
    shop = {
      status: 'ok',
      salons: shopOn.size,
      months: keys.map((month) => ({
        month,
        gmvFils: monthSum(shopBy, month, shopOn),
        orders: on.filter((r) => r.month === month).reduce((n, r) => n + int(r.n), 0),
      })),
      ordersByStatus: {
        preparing: on.filter((r) => r.month === selKey && r.status === 'preparing').reduce((n, r) => n + int(r.n), 0),
        ready: on.filter((r) => r.month === selKey && r.status === 'ready').reduce((n, r) => n + int(r.n), 0),
        closed: on.filter((r) => r.month === selKey && r.status === 'closed').reduce((n, r) => n + int(r.n), 0),
      },
    };
  }

  // ------------------------------------------------------- 11. busiest times --
  /**
   * In the selected PLATFORM month; on EACH VISIT'S OWN SALON'S clock. The zone is
   * joined per row — `AT TIME ZONE s.timezone` — so neither the process zone nor
   * the session's `TimeZone` nor the platform zone can move a visit's hour. Sparse,
   * as the Overview's: only cells with a visit.
   */
  const busy = await rows(sql`
    SELECT extract(dow FROM t.created_at AT TIME ZONE s.timezone)::int AS weekday,
           extract(hour FROM t.created_at AT TIME ZONE s.timezone)::int AS hour,
           count(*) AS visits
      FROM "transaction" t
      JOIN salon s ON s.id = t.salon_id
     WHERE t.kind = 'charge' AND t.status = 'settled'
       AND t.created_at >= ${at(selFrom)} AND t.created_at < ${at(selTo)}
       ${onSalon('t')}
       ${NOT_VOIDED}
     GROUP BY 1, 2
     ORDER BY 1, 2
  `);
  const cells = busy.map((x) => ({ weekday: int(x.weekday), hour: int(x.hour), visits: int(x.visits) }));
  const busiestTimes: PlatformAnalytics['busiestTimes'] = {
    status: 'ok',
    clock: 'salon_local',
    cells,
    totalVisits: cells.reduce((n, c) => n + c.visits, 0),
  };

  return {
    asOf: now.toISOString(),
    timezone: PLATFORM_TIMEZONE,
    month: selKey,
    partial: compare(sel, currentMonth(now)) === 0,
    months: keys,
    salonId,
    salonName: scope.salon?.name ?? null,
    revenue,
    money: moneyBlock,
    salons: salonsBlock,
    members: membersBlock,
    leaderboard,
    paymentMix,
    bookings,
    campaigns,
    support,
    shop,
    busiestTimes,
  };
}
