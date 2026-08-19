/**
 * Reports — the four CSV exports the merchant dashboard draws, and the aggregates
 * behind them.
 *
 * api-contract.md § Operations names one row and nothing implemented it:
 *
 *     | Merchant | Reports | GET /salons/{id}/reports/{kind}.csv?branch=&period= |
 *
 * `design/AVO Merchant Dashboard.dc.html` § REPORTS is the rest of the
 * specification: four cards, each with a title, a description, a column list, a
 * headline stat and an "Export CSV" button, above a branch segment and a
 * week/month/quarter segment. The card copy is the contract for what each export
 * MEANS, and — exactly as services/metrics.ts argues at length for the Overview
 * tiles — a label is not a definition. Each aggregate below states what it counts
 * and what it deliberately does not, because the failure mode of a report is not a
 * crash: it is a merchant making a decision on a number that means something other
 * than what she thinks.
 *
 * THE PERIOD VOCABULARY IS REUSED, NOT REINVENTED
 * -----------------------------------------------
 * The design's segment reads Week / Month / Quarter. `services/metrics.ts` already
 * settled that vocabulary as `7d` / `30d` / `90d` with `parsePeriod`, and this file
 * imports `PERIOD_DAYS` from it rather than restating the mapping. A report whose
 * "30d" differed from the Overview tile's "30d" would be two answers to one
 * question.
 *
 * MONEY IS INTEGER FILS UNTIL THE CELL
 * ------------------------------------
 * Non-negotiable #1, and a CSV is the one place in this file that is a display
 * boundary. Every aggregate below is summed `::bigint` in SQL and read through
 * `int()` — the same funnel metrics.ts uses — so no money value is ever a float in
 * transit. The JSON endpoint returns **integer fils**, because a JSON API is not a
 * display boundary and formatting there would force a client to parse a string
 * back into money. Formatting happens once, in `moneyCell`, and it goes through
 * `fils()` first — so if a float ever did reach a money sum, the branded
 * constructor throws instead of quietly rendering it.
 *
 * WHAT THE DESIGN ASKS FOR AND THE SCHEMA CANNOT PROVIDE
 * -----------------------------------------------------
 * Two columns on the "Customer information" card do not exist as data, and both
 * are reported to trunk rather than invented here:
 *
 *   `Username` (`@latifa.a`) — `member` HAS NO USERNAME. DECISIONS.md already
 *       ruled that a customer's sign-in identity is her PHONE, because the design
 *       contradicts its own copy and no such column exists. The export carries
 *       `Phone`, which the design's own Accounts § Customers tab displays for the
 *       same customer, so nothing is shown to the merchant that the UI withholds.
 *
 *   `Branch` — a MEMBER HAS NO BRANCH, deliberately: db/schema/salon.ts says "one
 *       wallet, one loyalty status, valid at every branch", which is why `member`
 *       carries `salon_id` and no `branch_id` while `transaction` carries both. A
 *       per-customer branch column would have to invent a rule ("the branch she
 *       last visited"), and inventing a definition silently is the one thing
 *       metrics.ts's header forbids. The column is dropped; `?branch=` still
 *       applies to this kind, as "customers who transacted at that branch".
 *
 * THE GATE, AND WHY IT IS FOUR DIFFERENT PERMISSIONS
 * -------------------------------------------------
 * The design draws NINE authority chips and Reports is not one of them — it is a
 * sidebar section with no permission of its own, the same gap the owner console had
 * when it drew ten sections and six chips. There, db/schema/platformAdmin.ts closed
 * it by adding sections, because "#7 does not permit an ungated endpoint". Here the
 * equivalent move is blocked: `StaffPermsSchema` lives in `packages/types`, which is
 * trunk-owned and consumed by four surfaces, so a tenth permission is a four-way
 * break and a trunk operation. It is reported, not taken.
 *
 * So the interim rule is stricter than a blanket gate would be: A REPORT INHERITS
 * THE PERMISSION OF THE SECTION WHOSE DATA IT EXPORTS. Nobody can export a figure
 * they could not already read in the UI, which is the property that actually
 * matters, and no new permission is minted to get it:
 *
 *   customers               → `team`          the chip is labelled "Team & accounts",
 *                                             and Accounts § Customers IS the
 *                                             customer book this exports
 *   sales                   → `dashboard`     Overview's revenue figures
 *   best-selling-services   → `appointments`  bookings are the Appointments section
 *   products-sold           → `shop`          the Shop section
 *
 * A blanket `dashboard` would have been the obvious choice and is the wrong one: the
 * `frontdesk` role preset holds `dashboard` and not `team`, so it would have handed
 * every front-desk tablet an export of every customer's name, phone and wallet
 * balance. services/memberSearch.ts spends four controls stopping a staff search box
 * from becoming exactly that file; it would be strange to then serve the file.
 */

import { sql } from 'drizzle-orm';
import { fils, formatFils } from '@avo/types';
import type { Db } from '../db/client';
import { badRequest } from '../http/errors';
import { at, int, PERIOD_DAYS, type Period } from './metrics';
import type { PermissionName } from '../auth/principal';

/**
 * The `{kind}` vocabulary, taken from the design's own export filenames
 * (`customers_…csv`, `sales_…csv`, `best-selling-services_…csv`,
 * `products-sold_…csv`) rather than invented. api-contract.md writes `{kind}` and
 * never enumerates it, so this is the contract addition that is reported.
 */
export const REPORT_KINDS = [
  'customers',
  'sales',
  'best-selling-services',
  'products-sold',
] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export function parseReportKind(value: unknown): ReportKind {
  if (!(REPORT_KINDS as readonly string[]).includes(String(value))) {
    throw badRequest('invalid_report_kind', `kind must be one of ${REPORT_KINDS.join(', ')}.`);
  }
  return value as ReportKind;
}

/** See the header: a report inherits the permission of the section it exports. */
export const REPORT_PERMISSION: Record<ReportKind, PermissionName> = {
  customers: 'team',
  sales: 'dashboard',
  'best-selling-services': 'appointments',
  'products-sold': 'shop',
};

/** The design's card titles, verbatim, so the JSON can name what it returned. */
export const REPORT_TITLE: Record<ReportKind, string> = {
  customers: 'Customer information',
  sales: 'Sales summary',
  'best-selling-services': 'Best-selling services',
  'products-sold': 'Products sold',
};

/**
 * A column is either text or money. The distinction is the whole reason this is a
 * table of descriptors rather than four hand-written CSV writers: `money` columns
 * carry integer fils in the JSON and are formatted once on the way into a cell, and
 * nothing else in this file is allowed to format money.
 */
type ColumnType = 'text' | 'int' | 'money';
interface Column {
  /** The header, verbatim from the design's `*Cols` arrays. */
  header: string;
  key: string;
  type: ColumnType;
}

export interface ReportShape {
  kind: ReportKind;
  title: string;
  columns: Column[];
  rows: Array<Record<string, string | number | null>>;
  /** The big number in the corner of the design's card. See `STAT`. */
  stat: ReportStat;
}

/** What each aggregate below returns; the stat is attached once, by `computeReport`. */
type ReportBody = Omit<ReportShape, 'stat'>;

/**
 * The headline figure each card prints, with its label VERBATIM from the design's
 * `statLabel` fields.
 *
 * Computed here rather than left to the dashboard for the same reason the aggregate
 * is: the design derives it with `sumCol(rows, i)` over the rows it is showing, so a
 * client computing it independently is a second implementation of one sum — and the
 * first time the two disagree, the card contradicts its own table.
 *
 * `key: null` means "count the rows", which is what Customer information does: its
 * stat is a number of customers, not a sum of anything.
 */
export interface ReportStat {
  key: string | null;
  label: string;
  /** Integer fils when the underlying column is money; a plain count otherwise. */
  value: number;
  type: 'count' | 'int' | 'money';
}

const STAT: Record<ReportKind, Omit<ReportStat, 'value'>> = {
  customers: { key: null, label: 'customers', type: 'count' },
  sales: { key: 'grossFils', label: 'KD gross', type: 'money' },
  'best-selling-services': { key: 'bookings', label: 'bookings', type: 'int' },
  'products-sold': { key: 'units', label: 'units', type: 'int' },
};

/**
 * Summed with `int()` on every term, so a money total cannot become a float on the
 * way to the card — the same rule the `::bigint` casts enforce one layer down.
 * Non-negotiable #1 does not stop at the edge of a total.
 */
function statFor(kind: ReportKind, rows: ReportBody['rows']): ReportStat {
  const def = STAT[kind];
  const value =
    def.key === null ? rows.length : rows.reduce((t, row) => t + int(row[def.key as string]), 0);
  return { ...def, value };
}

// ------------------------------------------------------------------- CSV ----

/**
 * RFC 4180, plus the one thing the design's own `exportCSV` does not do.
 *
 * The shape is taken from `design/AVO Merchant Dashboard.dc.html:1219` because it is
 * the reference implementation and it is already correct on three counts: every
 * field is quoted, an embedded `"` is doubled, rows are joined with CRLF, and the
 * payload is prefixed with a UTF-8 BOM so Excel renders an Arabic service or branch
 * name instead of mojibake.
 *
 * WHAT IT DOES NOT DO IS NEUTRALISE A FORMULA, and that is a real vulnerability
 * rather than a nicety. A salon can name a branch or a product whatever it likes. A
 * cell whose text begins `=`, `+`, `-`, `@`, or a tab or carriage return is
 * interpreted by Excel, Google Sheets and LibreOffice as a FORMULA when the file is
 * opened — `=HYPERLINK(...)`, `=cmd|...`, or a `WEBSERVICE()` call that posts the
 * rest of the sheet to a server. The merchant opening her own export is the victim,
 * and the attacker only needs to have typed a product name once.
 *
 * QUOTING IS NOT PROTECTION: `"=1+1"` still evaluates, because the quotes are CSV
 * syntax that the parser strips before the cell is interpreted. So the value itself
 * is changed — a single apostrophe is prefixed, which every spreadsheet reads as
 * "treat the rest as literal text" and which survives a round trip. The apostrophe
 * is visible in the cell, and that is the correct trade: a visible apostrophe on a
 * product called `-50% off` is a cosmetic surprise, and the alternative is code
 * execution on the merchant's laptop.
 *
 * Money and integer cells are produced by this file and never contain a leading
 * `-`... except a negative money value, which `formatFils` renders as `-1.500`. That
 * is a genuine minus rather than a formula, so `neutralise` is applied to TEXT cells
 * only, and the money path is closed by construction instead.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

export function neutralise(value: string): string {
  return FORMULA_LEAD.test(value) ? `'${value}` : value;
}

function quote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** The one place money becomes text. `fils()` throws if a float got this far. */
function moneyCell(value: number): string {
  return formatFils(fils(value));
}

/**
 * NO THOUSANDS SEPARATOR IN A CSV, which is a deliberate departure from the
 * design's `kd()` helper and is reported.
 *
 * `formatFils` renders 1,820.000 — correct for a card, where the design shows
 * exactly that. In a CSV the comma forces the cell to be quoted, and a quoted
 * `"1,820.000"` is read by Excel as TEXT: the merchant cannot sum the column, in a
 * file whose entire purpose is the sentence "open it in Excel or Google Sheets".
 * The design's promise that "the export matches exactly what you see" is about the
 * branch and period FILTER — that is what the sentence it sits in is about — not
 * about digit grouping, so this keeps the promise that was made and drops the one
 * that was not.
 */
function csvMoneyCell(value: number): string {
  return moneyCell(value).replace(/,/g, '');
}

export function toCsv(shape: ReportShape): string {
  const header = shape.columns.map((c) => quote(neutralise(c.header))).join(',');
  const body = shape.rows.map((row) =>
    shape.columns
      .map((c) => {
        const raw = row[c.key];
        if (raw === null || raw === undefined) return quote('');
        if (c.type === 'money') return quote(csvMoneyCell(Number(raw)));
        if (c.type === 'int') return quote(String(int(raw)));
        return quote(neutralise(String(raw)));
      })
      .join(','),
  );
  // BOM + CRLF, as the design's own exporter does. A trailing CRLF is RFC 4180's
  // optional final line break and Excel is happy either way; it is omitted so the
  // file has no phantom empty row.
  return `﻿${[header, ...body].join('\r\n')}`;
}

/**
 * `customers_all-branches_30d.csv` — the design's own filename shape
 * (`<kind>_<branchTag>_<period>`), with the period token being the API's `7d`/`30d`/
 * `90d` rather than the segment's word, so the filename says what was actually
 * requested.
 */
export function reportFilename(kind: ReportKind, branchName: string | null, period: Period): string {
  const tag = branchName ? branchName.toLowerCase().replace(/\s+/g, '-') : 'all-branches';
  // A branch is named by a salon, so it reaches a filename. Anything that is not a
  // safe filename character goes, which also closes the header-injection path into
  // Content-Disposition.
  const safe = tag.replace(/[^a-z0-9-]/g, '');
  return `${kind}_${safe || 'branch'}_${period}.csv`;
}

// -------------------------------------------------------------- aggregates --

export interface ReportScope {
  kind: ReportKind;
  salonId: string;
  /** NULL means every branch — the design's "All branches" segment. */
  branchId: string | null;
  period: Period;
  /** The salon's own zone. See `sales` below; this is not decoration. */
  timezone: string;
}

/**
 * A void is a compensating `adjustment` row pointing back at the charge it reverses
 * (db/schema/transaction.ts § reversesTransactionId), so a voided charge is STILL a
 * settled `charge` row and would otherwise be counted as revenue that no longer
 * exists.
 *
 * EXCLUDED REGARDLESS OF WHEN THE VOID HAPPENED, including a void that lands in a
 * later period than the charge itself. "Gross" answers "what stands now", which is
 * the number a merchant reconciles against her till; a figure that still counted
 * money the salon has already handed back would be wrong in the direction that
 * costs her something.
 */
/**
 * THE SIGN CONVENTION, AND IT IS A TRAP THIS FILE FELL INTO ONCE.
 *
 * `transaction.amount_fils` is a movement of the MEMBER'S WALLET, not the salon's
 * takings, and `transaction_amount_sign_matches_kind` enforces it: a `charge` is
 * `<= 0` and a `shop` row is `< 0`, because both take money out of her balance. A
 * `topup` is positive for the same reason.
 *
 * So a naive `sum(amount_fils)` over charges reports revenue as a NEGATIVE number,
 * and "Gross KD" renders `-512.000`. The first version of this file did exactly that
 * and the CHECK constraint is what exposed it — the aggregate was only ever run
 * against real rows afterwards, which is why it did not ship.
 *
 * Every revenue sum below is therefore `sum(-x)`, written with the negation VISIBLE
 * at the call site rather than hidden in an `abs()`. `abs()` would also mask a row
 * whose sign was wrong for some other reason, and a wrong sign is exactly the kind
 * of thing a report should surface rather than launder.
 *
 * `shop_order_line.line_total_fils` is the exception: it is a PRICE, not a wallet
 * movement, and `shop_order_line_unit_price_positive` keeps it positive. It is summed
 * as-is, and the difference is stated here so the inconsistency reads as deliberate.
 */
const NOT_VOIDED = sql`AND NOT EXISTS (
      SELECT 1 FROM "transaction" r
       WHERE r.reverses_transaction_id = t.id AND r.status = 'settled'
    )`;

export async function computeReport(db: Db, scope: ReportScope): Promise<ReportShape> {
  const body = await computeReportBody(db, scope);
  return { ...body, stat: statFor(scope.kind, body.rows) };
}

async function computeReportBody(db: Db, scope: ReportScope): Promise<ReportBody> {
  const now = new Date();
  const from = new Date(now.getTime() - PERIOD_DAYS[scope.period] * 86_400_000);
  const b = scope.branchId;

  if (scope.kind === 'customers') {
    /**
     * CUSTOMER INFORMATION — "Profiles, tier and wallet balance".
     *
     * One row per member who was ACTIVE in the window: at least one settled
     * transaction, which is the identical definition `computeMetrics` uses for the
     * Overview's "Active members" tile. Deliberately the same, so the Reports card's
     * row count and that tile cannot disagree about how many customers a salon has.
     * Two screens answering that differently is the defect this reuse prevents.
     *
     * NOT `count(*) FROM member`, for the reason metrics.ts gives: registrations
     * only ever go up, so a salon that signed 1,284 wallets and sees 40 of them
     * would export 1,284 rows for ever.
     *
     * TIER IS NULLABLE and is left empty when null rather than defaulted to
     * "Bronze". A stamps salon has no tiers at all (db/schema/member.ts), and
     * printing a tier a salon does not operate would be a fabricated column.
     *
     * BALANCE IS A CURRENT SNAPSHOT, not a period quantity — there is no such thing
     * as "her balance over 30 days". The period selects WHICH customers appear; the
     * money column is as-of-now, which is what the design's card says it is.
     */
    const rows = (await db.execute(sql`
      SELECT m.name, m.phone, m.tier, m.balance_fils
        FROM member m
       WHERE m.salon_id = ${scope.salonId}
         AND EXISTS (
           SELECT 1 FROM "transaction" t
            WHERE t.member_id = m.id
              AND t.salon_id = ${scope.salonId}
              AND t.status = 'settled'
              AND t.created_at >= ${at(from)}
              AND t.created_at < ${at(now)}
              ${b === null ? sql`` : sql`AND t.branch_id = ${b}`}
         )
       ORDER BY m.balance_fils DESC, m.name ASC
    `)) as unknown as Array<Record<string, unknown>>;

    return {
      kind: scope.kind,
      title: REPORT_TITLE[scope.kind],
      // `Username` and `Branch` are absent by necessity — see the file header.
      columns: [
        { header: 'Name', key: 'name', type: 'text' },
        { header: 'Phone', key: 'phone', type: 'text' },
        { header: 'Tier', key: 'tier', type: 'text' },
        { header: 'Wallet KD', key: 'balanceFils', type: 'money' },
      ],
      rows: rows.map((r) => ({
        name: String(r.name ?? ''),
        phone: String(r.phone ?? ''),
        tier: r.tier === null || r.tier === undefined ? '' : String(r.tier),
        balanceFils: int(r.balance_fils),
      })),
    };
  }

  if (scope.kind === 'sales') {
    /**
     * SALES SUMMARY — "Transactions and gross by day", one row per (day, branch).
     *
     * THE DAY IS THE SALON'S DAY, and this is the fourth place `salon.timezone`
     * earns its keep. `(created_at AT TIME ZONE <tz>)::date` groups by the salon's
     * own calendar date. Grouped by a UTC date instead, a salon closing at 21:00
     * Kuwait (18:00Z) would be fine, but one closing at 01:00 would have its last
     * hour of takings land on the next day's row — and the merchant would see a
     * daily figure she could not reconcile against her till, with no way to tell it
     * was a boundary rather than a loss. metrics.ts makes the same argument for
     * "loaded today".
     *
     * GROSS IS `charge` + `shop`: money the salon earned, whether at the chair or
     * over the counter. NOT `topup` — a top-up is the customer loading her own
     * wallet, which is a liability the salon now owes her, not a sale; counting it
     * would make gross rise when nothing had been sold. NOT `deposit_hold`, which is
     * money moved into escrow and settles later as part of the charge, so counting
     * it too would bill the same service twice. NOT `adjustment`, which is the void
     * mechanism itself.
     *
     * VOIDS ARE NETTED OUT by excluding the reversed row entirely — see NOT_VOIDED.
     * Excluding rather than subtracting is what keeps `Transactions` honest too: a
     * charge that was voided did not happen, so it is not a transaction on the day's
     * count either.
     *
     * ISO DATES, not the design's `06 Jul`. A 90-day export crosses a year boundary
     * and `06 Jul` cannot say which year; ISO also sorts correctly in the
     * spreadsheet this file exists to be opened in. Reported as a departure.
     */
    const rows = (await db.execute(sql`
      SELECT to_char((t.created_at AT TIME ZONE ${scope.timezone})::date, 'YYYY-MM-DD') AS day,
             br.name AS branch,
             count(*) AS txns,
             coalesce(sum(-t.amount_fils), 0)::bigint AS gross
        FROM "transaction" t
        JOIN branch br ON br.id = t.branch_id
       WHERE t.salon_id = ${scope.salonId}
         AND t.kind IN ('charge', 'shop')
         AND t.status = 'settled'
         AND t.created_at >= ${at(from)}
         AND t.created_at < ${at(now)}
         ${b === null ? sql`` : sql`AND t.branch_id = ${b}`}
         ${NOT_VOIDED}
       GROUP BY 1, 2
       ORDER BY 1 DESC, 2 ASC
    `)) as unknown as Array<Record<string, unknown>>;

    return {
      kind: scope.kind,
      title: REPORT_TITLE[scope.kind],
      columns: [
        { header: 'Date', key: 'date', type: 'text' },
        { header: 'Transactions', key: 'transactions', type: 'int' },
        { header: 'Gross KD', key: 'grossFils', type: 'money' },
        { header: 'Branch', key: 'branch', type: 'text' },
      ],
      rows: rows.map((r) => ({
        date: String(r.day ?? ''),
        transactions: int(r.txns),
        grossFils: int(r.gross),
        branch: String(r.branch ?? ''),
      })),
    };
  }

  if (scope.kind === 'best-selling-services') {
    /**
     * BEST-SELLING SERVICES — "Ranked by bookings", one row per (service, branch).
     *
     * BOOKINGS, AND THE CARD SAYS SO. Its stat label is literally "bookings", which
     * matters because a per-service count is the ONLY per-service figure this schema
     * can produce: `POST /charges` records its basket as `transaction.basket_hash`,
     * a sha256 of the sorted service ids (db/schema/transaction.ts § basketHash),
     * and a hash cannot be un-hashed into services. Migration 0027 refused to store
     * the ids a second time on purpose — "two answers to what was this for" — so a
     * WALK-IN service sale is not attributable to a service, by design.
     *
     * That is a real limit on this card and it is reported rather than hidden: the
     * ranking covers BOOKED services, not every service performed. It is consistent
     * with the label the design chose, and the alternative — silently ranking only
     * the bookable subset while calling it "best-selling" — is the kind of number
     * this file's header exists to prevent.
     *
     * CANCELLED BOOKINGS ARE EXCLUDED. A cancellation is not a sale, and counting it
     * would rank a service highly for being abandoned. `no_show_returned` is KEPT: a
     * no-show whose deposit went back is still a booking the salon held a slot for,
     * and its revenue contribution falls out naturally as zero because nothing
     * settled.
     *
     * REVENUE IS THE SETTLED TRANSACTION, joined through `settled_transaction_id`.
     * A booking still in `deposit_held` has settled nothing, so it contributes 0 —
     * a LEFT JOIN plus a FILTER rather than an inner join, because dropping those
     * rows would also drop them from the booking COUNT, which is the ranking.
     *
     * THE WINDOW IS ON `starts_at`, not `created_at`: "best-selling this month"
     * means services performed this month, not services booked this month for
     * September.
     */
    const rows = (await db.execute(sql`
      SELECT sv.name AS service,
             br.name AS branch,
             count(*) AS bookings,
             coalesce(sum(-st.amount_fils) FILTER (WHERE st.status = 'settled'), 0)::bigint AS revenue
        FROM booking bk
        JOIN service sv ON sv.id = bk.service_id
        JOIN branch br ON br.id = bk.branch_id
        LEFT JOIN "transaction" st ON st.id = bk.settled_transaction_id
       WHERE bk.salon_id = ${scope.salonId}
         AND bk.status <> 'cancelled'
         AND bk.starts_at >= ${at(from)}
         AND bk.starts_at < ${at(now)}
         ${b === null ? sql`` : sql`AND bk.branch_id = ${b}`}
       GROUP BY 1, 2
       ORDER BY bookings DESC, revenue DESC, service ASC
    `)) as unknown as Array<Record<string, unknown>>;

    return {
      kind: scope.kind,
      title: REPORT_TITLE[scope.kind],
      columns: [
        { header: 'Service', key: 'service', type: 'text' },
        { header: 'Bookings', key: 'bookings', type: 'int' },
        { header: 'Revenue KD', key: 'revenueFils', type: 'money' },
        { header: 'Branch', key: 'branch', type: 'text' },
      ],
      rows: rows.map((r) => ({
        service: String(r.service ?? ''),
        bookings: int(r.bookings),
        revenueFils: int(r.revenue),
        branch: String(r.branch ?? ''),
      })),
    };
  }

  /**
   * PRODUCTS SOLD — "Units and revenue by product", one row per (product, branch).
   *
   * `shop_order_line` is the only place a per-product quantity exists, and it is
   * exact: `line_total_fils = qty × unit_price_fils` is a CHECK on the table
   * (db/schema/shopOrder.ts), so summing the stored column cannot disagree with
   * summing the multiplication. Non-negotiable #1 is held by the database here, not
   * by this query's arithmetic — which is why the query does no arithmetic.
   *
   * PRICE COMES FROM THE LINE, NOT FROM `product.price_fils`. The product's current
   * price is what it costs today; the line holds what the customer actually paid.
   * Joining to the catalogue for money would silently reprice history every time a
   * salon edited a product, and the export would change under a merchant who
   * changed nothing.
   *
   * AND THE NAME COMES FROM THE LINE TOO, for exactly the same reason — which the
   * first version of this query got wrong while getting the price right. `name` on
   * `shop_order_line` is "a snapshot of `product.name` at the moment of sale", and
   * db/schema/shopOrder.ts records that names are editable in the Shop editor. So a
   * salon that renamed a bottle would have seen last month's export silently
   * relabelled — the same defect as repricing history, one column over. The
   * catalogue is no longer joined at all.
   *
   * GROUPED BY `product_id`, NOT BY THE NAME. The id is the stable key; grouping by
   * the snapshot would split one product into two rows the moment it was renamed
   * mid-window. The name shown is the one from the MOST RECENT sale in the window,
   * which is what a merchant reading the row would expect it to be called.
   *
   * The branch and the period come from the ORDER's transaction, because a line has
   * neither — the same reason the join exists at all. Voided orders are excluded on
   * the same terms as sales.
   */
  const rows = (await db.execute(sql`
    SELECT (array_agg(l.name ORDER BY t.created_at DESC))[1] AS product,
           br.name AS branch,
           coalesce(sum(l.qty), 0)::bigint AS units,
           coalesce(sum(l.line_total_fils), 0)::bigint AS revenue
      FROM shop_order_line l
      JOIN "transaction" t ON t.id = l.transaction_id
      JOIN branch br ON br.id = t.branch_id
     WHERE t.salon_id = ${scope.salonId}
       AND t.kind = 'shop'
       AND t.status = 'settled'
       AND t.created_at >= ${at(from)}
       AND t.created_at < ${at(now)}
       ${b === null ? sql`` : sql`AND t.branch_id = ${b}`}
       ${NOT_VOIDED}
     GROUP BY l.product_id, br.name
     ORDER BY units DESC, revenue DESC, product ASC
  `)) as unknown as Array<Record<string, unknown>>;

  return {
    kind: scope.kind,
    title: REPORT_TITLE[scope.kind],
    columns: [
      { header: 'Product', key: 'product', type: 'text' },
      { header: 'Units', key: 'units', type: 'int' },
      { header: 'Revenue KD', key: 'revenueFils', type: 'money' },
      { header: 'Branch', key: 'branch', type: 'text' },
    ],
    rows: rows.map((r) => ({
      product: String(r.product ?? ''),
      units: int(r.units),
      revenueFils: int(r.revenue),
      branch: String(r.branch ?? ''),
    })),
  };
}
