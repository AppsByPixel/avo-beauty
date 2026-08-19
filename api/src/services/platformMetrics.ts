/**
 * The owner console's ANALYTICS screen — "How AVO is performing across every
 * salon".
 *
 * `AVO Owner Console.dc.html` § ANALYTICS draws four KPI tiles, an eight-month
 * bar chart of wallet loaded across the platform, and a top-five salon list. This
 * computes all three from the real tables; the design's own numbers are fixtures.
 *
 * THE WINDOW IS THE CALENDAR MONTH, NOT A ROLLING `?period=`
 * ---------------------------------------------------------
 * `services/metrics.ts` (the merchant's Overview) takes `?period=7d|30d|90d`
 * because api-contract.md gives that screen one. This screen does not have one,
 * and the design is consistent about why: the tiles say "Loaded (Jul)",
 * "+3 this month", "+1,204 this month", "Top salons this month", and the chart is
 * "Last 8 months". Every figure on it is a calendar month, so inventing a rolling
 * parameter would make the tile and the chart disagree about what "this month"
 * means — the bar for Jul would cover a different set of top-ups than the KPI
 * above it, and both would be labelled Jul.
 *
 * ONE TIMEZONE, AND IT IS THE PLATFORM'S
 * --------------------------------------
 * Every other date boundary in this API resolves against `salon.timezone`,
 * because a salon's business day is a salon-local fact. A PLATFORM month is not:
 * bucketing each salon's top-ups by its own midnight would give months that
 * overlap at the edges, so a top-up could land in July for one salon and August
 * for another and the eight bars would not sum to the platform total. AVO is a
 * Kuwait company and `salon.timezone` defaults to Asia/Kuwait, so the platform
 * zone is Asia/Kuwait — stated here as a decision rather than inherited by
 * accident from `TZ=UTC`, which would move every month boundary three hours and
 * put late-evening top-ups in the wrong month.
 *
 * WHAT THE DESIGN ASKS FOR AND THE SCHEMA CANNOT ANSWER — reported, not invented:
 *
 *   `salons.live`  The design's KPI is "Salons live" and its salon list draws an
 *                  active/suspended toggle ("System suspended Glow Bar · billing
 *                  hold"). `salon` has NO active or suspended column. So this
 *                  returns `total`, named `total`, rather than labelling a count
 *                  of every salon "live" — a tile that says four salons are live
 *                  when one is suspended is worse than a tile that says there are
 *                  four salons.
 *   `topSalons[].city`  There is no city column either. Omitted rather than
 *                  guessed from the name.
 *
 * Both are schema gaps for trunk. Neither blocks the endpoint, and neither is
 * papered over with a plausible-looking value.
 */

import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';

/**
 * The zone every boundary on this screen resolves against. See the header — this
 * is a decision, and `Asia/Kuwait` has no DST so the offset is a constant +03.
 */
export const PLATFORM_TIMEZONE = 'Asia/Kuwait';

/** The design's chart is "Last 8 months · KD", including the current one. */
export const CHART_MONTHS = 8;

/** The design's list is "Top salons this month", five rows. */
export const TOP_SALON_COUNT = 5;

export interface PlatformMetrics {
  /** `total`, not `live`. See the header. */
  salons: { total: number; addedThisMonth: number };
  members: { total: number; addedThisMonth: number };
  /**
   * Wallet loaded across the platform this calendar month, and KNET's share of
   * it. `knetSharePercent` is an integer percent of VALUE, not of transaction
   * count — the design's "74% via KNET" sits under a KD figure.
   */
  loaded: { thisMonthFils: number; knetSharePercent: number };
  /**
   * AVO's own revenue: the commission actually recorded on settled top-ups.
   *
   * `sum(fee_fils)` and never a rate applied to a volume. The fee was decided per
   * transaction at intent creation, against whatever `platform_settings` held at
   * that moment, so recomputing it from today's rate would restate history every
   * time the owner moves a stepper. `priorMonthFils` is the same measurement one
   * calendar month earlier, which is what the design's "+9% MoM" compares.
   */
  revenue: { thisMonthFils: number; priorMonthFils: number };
  /** Oldest first, so the client renders bars left to right without sorting. */
  loadedByMonth: Array<{ month: string; loadedFils: number }>;
  topSalons: Array<{
    salonId: string;
    name: string;
    members: number;
    loadedFils: number;
  }>;
}

/**
 * An instant as a parameter these raw aggregates can actually bind.
 *
 * `services/metrics.ts` found this by running it: a `Date` interpolated into a
 * `sql` template reaches postgres.js with no Drizzle column on either side to
 * infer a type from, and throws `ERR_INVALID_ARG_TYPE` — which surfaces as a 500
 * on a read-only endpoint. ISO text plus an explicit `::timestamptz` gives the
 * driver a string and the planner an unambiguous type.
 */
function at(instant: Date) {
  return sql`${instant.toISOString()}::timestamptz`;
}

/** A whole number from a Postgres aggregate, which arrives as a string or null. */
function int(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** Integer percent of a of b. 0 when b is 0 — never NaN, never Infinity. */
function percent(a: number, b: number): number {
  if (b <= 0) return 0;
  return Math.round((a * 100) / b);
}

/**
 * WHAT THE CUSTOMER ACTUALLY PAID — and it is NOT `amount_fils`.
 *
 * FOUND BY RUNNING IT, which is the only reason this is right. A 25.000 KD card
 * top-up by a Silver member produced `transaction.amount_fils = 27500`, because
 * `services/topup.ts` writes `amountFils: intent.creditFils` — "what actually
 * landed, both bonuses included". The tier bonus and the promotion bonus are
 * merchant-funded credit, carried alongside in their own two columns precisely so
 * a settled top-up stays reconcilable.
 *
 * So `sum(amount_fils)` is the credit that landed in wallets, not the money that
 * entered the platform, and using it would have been wrong in two ways at once:
 *
 *   - the "Loaded" tile and the eight bars would be inflated by every promotion
 *     the salons happened to be running;
 *   - `knetSharePercent` would be a share of CREDIT while its numerator is a share
 *     of PAYMENTS — bonuses have no payment method — so the percentage would drift
 *     down as bonuses grew, with nothing on the screen to suggest why.
 *
 * THE DESIGN SETTLES IT rather than my judgement. Its own billing maths is
 * `commission = loaded × rate` (`AVO Owner Console.dc.html`, `commTotal`), and
 * commission is charged on what the customer paid — so the quantity the design
 * calls "loaded" is the paid amount. The footnote agrees: "Commission is charged
 * on wallet top-ups only, never on the salon's own service prices."
 *
 * Subtracting both bonus columns is exact: all three are integer fils.
 */
const PAID_FILS = sql`(amount_fils - bonus_fils - promo_bonus_fils)`;

/**
 * The first instant of a calendar month in the platform zone, `monthsAgo` months
 * back from the month containing `now`.
 *
 * Computed in SQL rather than in JS on purpose: `date_trunc('month', ... AT TIME
 * ZONE ...)` is the same arithmetic the bucketing query below uses, so the tile's
 * month boundary and the chart's cannot drift apart. Doing it twice in two
 * languages is how they would.
 */
async function monthStart(db: Db, now: Date, monthsAgo: number): Promise<Date> {
  const rows = await db.execute(sql`
    SELECT (date_trunc('month', ${at(now)} AT TIME ZONE ${PLATFORM_TIMEZONE})
              - make_interval(months => ${monthsAgo}))
             AT TIME ZONE ${PLATFORM_TIMEZONE} AS start
  `);
  const value = (rows as unknown as Array<{ start: Date | string }>)[0]?.start;
  return value instanceof Date ? value : new Date(String(value));
}

export async function computePlatformMetrics(
  db: Db,
  now = new Date(),
): Promise<PlatformMetrics> {
  const thisMonthStart = await monthStart(db, now, 0);
  const priorMonthStart = await monthStart(db, now, 1);
  const chartStart = await monthStart(db, now, CHART_MONTHS - 1);

  /**
   * SALONS AND MEMBERS — counts, and the month's additions.
   *
   * `created_at >= thisMonthStart` is the "+3 this month" / "+1,204 this month"
   * delta. Signed subtraction is not needed here the way it is on the merchant's
   * active-members tile: a registration cannot be undone, so the number of things
   * added this month is never negative.
   */
  const countRows = await db.execute(sql`
    SELECT
      (SELECT count(*) FROM salon)                                          AS salons,
      (SELECT count(*) FROM salon  WHERE created_at >= ${at(thisMonthStart)}) AS salons_new,
      (SELECT count(*) FROM member)                                         AS members,
      (SELECT count(*) FROM member WHERE created_at >= ${at(thisMonthStart)}) AS members_new
  `);
  const counts = (countRows as unknown as Array<Record<string, unknown>>)[0] ?? {};

  /**
   * LOADED AND REVENUE, this month and last.
   *
   * `kind = 'topup' AND status = 'settled'` — a pending or failed top-up is an
   * attempt and has loaded nothing. Bucketed on `settled_at` rather than
   * `created_at`, because the money arrived when it settled; a top-up created at
   * 23:58 on the 31st and settled two minutes later belongs to the new month, and
   * the ledger agrees.
   *
   * The money figures use `PAID_FILS`, not `amount_fils` — see its definition. A
   * top-up row's `amount_fils` is the CREDIT that landed, bonuses included, so
   * summing it would inflate every figure on this screen by whatever promotions the
   * salons were running.
   */
  const moneyRows = await db.execute(sql`
    SELECT
      coalesce(sum(${PAID_FILS}) FILTER (
        WHERE settled_at >= ${at(thisMonthStart)}), 0)                   AS loaded_this,
      coalesce(sum(${PAID_FILS}) FILTER (
        WHERE settled_at >= ${at(thisMonthStart)} AND method = 'knet'), 0) AS knet_this,
      coalesce(sum(fee_fils) FILTER (
        WHERE settled_at >= ${at(thisMonthStart)}), 0)                   AS fee_this,
      coalesce(sum(fee_fils) FILTER (
        WHERE settled_at >= ${at(priorMonthStart)}
          AND settled_at <  ${at(thisMonthStart)}), 0)                   AS fee_prior
    FROM transaction
    WHERE kind = 'topup' AND status = 'settled' AND settled_at IS NOT NULL
      AND settled_at >= ${at(priorMonthStart)}
  `);
  const money = (moneyRows as unknown as Array<Record<string, unknown>>)[0] ?? {};
  const loadedThis = int(money.loaded_this);

  /**
   * THE EIGHT BARS.
   *
   * `generate_series` LEFT JOINed to the totals, so a month with no top-ups is a
   * zero bar rather than a missing one. Without it the chart would silently
   * compress — eight labels over six bars — and a quiet month would look like it
   * never happened. Same reason an empty state names what is missing.
   */
  const barRows = await db.execute(sql`
    WITH months AS (
      SELECT generate_series(
        date_trunc('month', ${at(chartStart)}    AT TIME ZONE ${PLATFORM_TIMEZONE}),
        date_trunc('month', ${at(now)}           AT TIME ZONE ${PLATFORM_TIMEZONE}),
        interval '1 month'
      ) AS m
    )
    SELECT to_char(months.m, 'YYYY-MM') AS month,
           coalesce(sum(t.amount_fils - t.bonus_fils - t.promo_bonus_fils), 0) AS loaded_fils
      FROM months
      LEFT JOIN transaction t
        ON t.kind = 'topup' AND t.status = 'settled' AND t.settled_at IS NOT NULL
       AND date_trunc('month', t.settled_at AT TIME ZONE ${PLATFORM_TIMEZONE}) = months.m
     GROUP BY months.m
     ORDER BY months.m
  `);

  /**
   * TOP FIVE SALONS BY WHAT THEY LOADED THIS MONTH.
   *
   * The member count is a correlated subquery rather than a second join: joining
   * `member` alongside the transaction aggregate would multiply the rows and
   * inflate `loaded_fils` by the salon's member count — a wrong money figure
   * produced by a join, which is the class of bug invariant 5 exists for.
   *
   * Salons with nothing loaded are included at zero and sort last. A platform with
   * three salons should show three rows, not an empty list because two of them had
   * a quiet month.
   */
  const topRows = await db.execute(sql`
    SELECT s.id   AS salon_id,
           s.name AS name,
           (SELECT count(*) FROM member m WHERE m.salon_id = s.id) AS members,
           coalesce(sum(t.amount_fils - t.bonus_fils - t.promo_bonus_fils), 0) AS loaded_fils
      FROM salon s
      LEFT JOIN transaction t
        ON t.salon_id = s.id AND t.kind = 'topup' AND t.status = 'settled'
       AND t.settled_at IS NOT NULL AND t.settled_at >= ${at(thisMonthStart)}
     GROUP BY s.id, s.name
     ORDER BY loaded_fils DESC, s.name ASC
     LIMIT ${TOP_SALON_COUNT}
  `);

  return {
    salons: { total: int(counts.salons), addedThisMonth: int(counts.salons_new) },
    members: { total: int(counts.members), addedThisMonth: int(counts.members_new) },
    loaded: {
      thisMonthFils: loadedThis,
      knetSharePercent: percent(int(money.knet_this), loadedThis),
    },
    revenue: {
      thisMonthFils: int(money.fee_this),
      priorMonthFils: int(money.fee_prior),
    },
    loadedByMonth: (barRows as unknown as Array<Record<string, unknown>>).map((r) => ({
      month: String(r.month),
      loadedFils: int(r.loaded_fils),
    })),
    topSalons: (topRows as unknown as Array<Record<string, unknown>>).map((r) => ({
      salonId: String(r.salon_id),
      name: String(r.name),
      members: int(r.members),
      loadedFils: int(r.loaded_fils),
    })),
  };
}
