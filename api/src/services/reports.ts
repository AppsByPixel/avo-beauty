/**
 * Reports — the SIX CSV exports the merchant dashboard draws, and the aggregates
 * behind them.
 *
 * "Four" stood in this line through two additions - `artist-performance` and now
 * `earnings-by-branch` - and the design's four cards below really are four, which
 * is how the stale number survived: the sentence was true of the design and had
 * stopped being true of the file. The two counts are stated separately now. Only
 * FOUR of the six are the design's; `artist-performance` and `earnings-by-branch`
 * are requests, marked as such at REPORT_KINDS.
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
 * THE GATE, AND WHY IT IS FOUR DIFFERENT PERMISSIONS ACROSS SIX KINDS
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
 *   earnings-by-branch      → `dashboard`     the same money `sales` exports,
 *                                             regrouped - a branch is a PLACE, and
 *                                             a stricter gate than `sales` would
 *                                             be theatre; see the map
 *   artist-performance      → `team`          an artist's earnings is personnel
 *                                             data, and `team` is the STRICTEST of
 *                                             the three sections this one joins —
 *                                             see the map for why a join must
 *                                             resolve to the strictest and not the
 *                                             most obvious
 *
 * A blanket `dashboard` would have been the obvious choice and is the wrong one —
 * but NOT for the reason this paragraph used to give. It said "the `frontdesk` role
 * preset holds `dashboard` and not `team`", and that is inverted: the seeded
 * frontdesk (`ST-002`) holds NEITHER — `perm_dashboard` and `perm_team` are both
 * false, `perm_appointments` and `perm_scanner` are the two it has. So the seed was
 * never the evidence, and citing it made a correct conclusion rest on a false fact.
 *
 * THE ARGUMENT IS THE RULE, NOT THE FIXTURE. `dashboard` is the wider grant: it is
 * the permission that opens the Overview, so it is the one a salon hands out to
 * anybody who needs to see how the business is doing, while `team` is the authority
 * over its people. A customer's name, phone and wallet balance is the second kind of
 * data. services/memberSearch.ts spends four controls stopping a staff search box
 * from becoming exactly that file; it would be strange to then serve the file to a
 * wider audience than the roster itself.
 *
 * And "preset" was wrong twice over — see § REPORT_PERMISSION below.
 */

import { sql } from 'drizzle-orm';
import { fils, formatFils } from '@avo/types';
import type { Db } from '../db/client';
import { badRequest } from '../http/errors';
import { at, int } from './metrics';
import {
  periodToken,
  resolveCompareWindow,
  resolveWindow,
  windowsComparable,
  type Compare,
  type Period,
  type PeriodWindow,
} from './period';
import { revenueJoin, revenueLeftJoin } from '../money/revenue';
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
  'artist-performance',
  /**
   * NEW WORK, NOT A DESIGN FIDELITY FIX - said here rather than smuggled, the way
   * Lane C marked the vouchers panel.
   *
   * The design's Reports page states its own model in as many words: "Pull any
   * list as a CSV - open it in Excel or Google Sheets. FILTER BY BRANCH and period
   * first; the export matches exactly what you see." Filtering, not breaking down.
   * There is no fifth card in `design/AVO Merchant Dashboard.dc.html` and no
   * designer drew one. Aftab asked for "earning by branch" (item 7) and this is
   * that request, built in the existing pattern rather than as a sixth one.
   *
   * WHAT DID NOT ALREADY EXIST. Every kind takes `?branch=` and FILTERS by it, and
   * two of them carry a branch COLUMN: `sales` groups by (day, branch) and
   * `products-sold` by (product, branch). So a merchant could already read one
   * branch's number by filtering, or read a day-by-branch grid and add it up
   * herself. What did not exist is a report whose ROWS ARE BRANCHES - the period
   * roll-up that answers "Salmiya earned X, Kuwait City earned Y" at a glance.
   */
  'earnings-by-branch',
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
  /**
   * `team`, AND IT IS THE MOST RESTRICTIVE OF THE THREE SECTIONS THIS ROW JOINS —
   * which is the rule, not a coincidence.
   *
   * This report is a join of three sections' data: the appointment book
   * (`appointments`), money (`dashboard`), and a named person's earnings, which is
   * personnel data (`team`). The header's rule — a report inherits the permission of
   * the section whose data it exports — has to resolve to ONE permission, and for a
   * join the only safe resolution is the STRICTEST of them. The seeded frontdesk
   * (`ST-002`) holds `appointments` and NOT `team` — checked against the row, not
   * assumed — so gating on `appointments` would put every artist's earnings on the
   * front-desk tablet: the same mistake a blanket `dashboard` would have made with
   * the customer book, one section over.
   *
   * NOT A "PRESET", AND THE WORD WAS WORSE THAN LOOSE. Three comments in this file
   * and its spec called `frontdesk` a "role preset that db/seed.ts writes". There is
   * no preset for salon staff: `db/seed.ts` writes ST-002's nine permission booleans
   * out one at a time, and a salon's roster is edited per staff row. `PLATFORM_ROLE_
   * PRESETS` (db/schema/platformAdmin.ts) DOES exist and is a different thing
   * entirely — the owner console's admin roles — so the word sent a reader to a real
   * table to look up a role that is not in it. `seed.ts` itself says it spells
   * permissions out "rather than derived from PLATFORM_ROLE_PRESETS".
   *
   * It is also the answer the request itself points at. Aftab asked for "staff
   * statistics"; a per-person earnings figure is what a bonus is decided on, and the
   * chip labelled "Team & accounts" is where a salon already decides who may see
   * what about its people. Nobody can export an artist's takings who could not
   * already open Accounts and read her row.
   */
  'artist-performance': 'team',
  /**
   * `dashboard`, the SAME permission as `sales`, and the rule forces it rather
   * than merely permitting it.
   *
   * This kind exports the Overview's revenue figures, rolled up by branch. So
   * does `sales`. They are two groupings of one pile of money - which is exactly
   * what `services/reportsBranch.int.test.ts` asserts - and the header's rule is
   * that a report inherits the permission of the SECTION whose data it exports.
   * One section, one permission.
   *
   * THE TEMPTING ANSWER WAS `team`, and it is wrong for a reason worth writing
   * down. Per-branch earnings is what a BRANCH MANAGER'S BONUS is decided on, and
   * `artist-performance` reasons its way to `team` from very nearly that sentence.
   * The difference is that an artist row NAMES A PERSON and a branch row names a
   * PLACE - `branch` has no manager column, so nothing here identifies anybody.
   *
   * And the stronger argument is that a stricter gate here would be THEATRE. The
   * identical money, per branch, is already exportable at `dashboard` through
   * `sales`: filter to one branch, or pull the day-by-branch grid and add the
   * column up. A gate somebody can walk around one card to the left is worse than
   * no gate, because it reads as a control. If branch-level money should be
   * harder to reach than `dashboard`, that is a decision about `sales` and about
   * `GET /salons/{id}/metrics?branch=`, not about this kind, and it is above this
   * lane's line - reported to trunk rather than taken here.
   */
  'earnings-by-branch': 'dashboard',
};

/**
 * =========================================================================
 * WHICH EXPORTS ARE AUDITED, AND WHERE THE LINE FALLS   (the report-export ruling)
 * =========================================================================
 * `routes/reports.ts` wrote no `audit_log` row at all, so a manager could
 * download every artist's earnings or every customer's phone number and wallet
 * balance and leave no trace of it. "All five kinds" and "only
 * artist-performance" were both defensible from a standing start. Two lines get
 * drawn here rather than one, because they answer different questions.
 *
 * -------------------------------------------------------------------------
 * LINE 1 — WHICH KINDS: THE EXPORTS WHOSE ROWS NAME IDENTIFIABLE PEOPLE
 * -------------------------------------------------------------------------
 * `customers` and `artist-performance`. NOT only `artist-performance`, and that
 * was the tempting answer: it is the one whose rows are named individuals and
 * what they earned. But `customers` is every active customer's NAME, PHONE and
 * WALLET BALANCE, and `services/memberSearch.ts` already spends four controls
 * stopping a staff search box from becoming exactly that file. It would be
 * strange to audit the personnel file and not the one the codebase already
 * treats as its most sensitive read. Same argument, so same answer.
 *
 * `sales`, `best-selling-services` and `products-sold` name DAYS, SERVICES and
 * PRODUCTS. No individual appears in a row, and an aggregate of a salon's own
 * takings is the thing the merchant is entitled to look at all day.
 *
 * THE CODEBASE HAD ALREADY DRAWN THIS LINE, which is the strongest evidence it
 * is not arbitrary: `customers` and `artist-performance` are the only two kinds
 * gated `team`, and this file's own § REPORT_PERMISSION rule is that a report
 * inherits the permission of the section whose data it exports. The two `team`
 * reports are exactly the two that are about identifiable people.
 *
 * IT IS STILL AN EXPLICIT MAP RATHER THAN `REPORT_PERMISSION[kind] === 'team'`,
 * deliberately. Deriving it would mean a future re-gate silently changed what is
 * audited — two decisions welded together. So the map is written out, and
 * `reports.test.ts` asserts the invariant that actually matters instead: every
 * AUDITED kind is gated on `team`. Re-gate one to something weaker and the spec
 * fails rather than the audit quietly following it.
 */
export const REPORT_AUDITED: Record<ReportKind, boolean> = {
  /** Name, phone and wallet balance, for every active customer. */
  customers: true,
  /** Named artists and what each one earned — what a bonus is decided on. */
  'artist-performance': true,
  /** Days. */
  sales: false,
  /** Services. */
  'best-selling-services': false,
  /** Products. */
  'products-sold': false,
  /**
   * BRANCHES. A place, not a person - the line above is "the exports whose rows
   * name identifiable people", and `branch` carries a name, an address and no
   * human at all.
   *
   * AND THE SECOND HALF, WHICH IS THE ONE THAT DECIDES IT: this is the same money
   * `sales` already exports unaudited, regrouped. Auditing the roll-up while the
   * detail export beside it writes no row would be a control with a hole in it -
   * anybody avoiding the trace downloads `sales` and pivots - and a control with a
   * known hole is worse than none, because the audit log then reads as coverage it
   * does not have. So: not audited, consistently with `sales`, and if branch-level
   * money is to be audited then BOTH must be. Reported to trunk; not decided here.
   */
  'earnings-by-branch': false,
};

/** How the file actually left. Both are audited; the card render is not. */
export type ReportExportVia = 'csv' | 'download-link';

/**
 * THE AUDIT ROW FOR AN EXPORT, and its whole design constraint is that it must
 * not become a second copy of the thing being protected.
 *
 * THE CONSTRAINT IS NOT A PRINCIPLE, IT IS A PRIVILEGE DOWNGRADE.
 * `GET /salons/{id}/audit` is `requireDashboardPerm(req, 'dashboard')`, while
 * both audited reports are gated `team`. So ANY figure copied into this row —
 * an artist's earnings, a customer's balance, even the headline total — becomes
 * readable at a WEAKER permission than the report it came from. Auditing the
 * personnel export by putting the personnel figures in the audit log would hand
 * them to everyone the export was gated away from.
 *
 * So the row records the ACT and its SHAPE, never its content:
 *
 *   who        the actor, from `writeAudit`
 *   when       the row's own timestamp
 *   which      the report kind
 *   how much   `rowCount` — a count is not the data, and "1,284 rows" is the
 *              difference between a spot check and a full extraction
 *   how wide   branch filter and period; "all branches, 90d" and "one branch,
 *              7d" are materially different acts
 *   how        `via`, because a CSV and a one-time link are different exposures
 *
 * AND `amountFils` IS DELIBERATELY NULL. That column exists for money that
 * MOVED; a report moves none, and putting the headline total there is precisely
 * the copy this paragraph exists to prevent. No names, no per-row figures, no
 * totals.
 *
 * ONE BUILDER, TWO CALL SITES — the `.csv` handler and the download redemption.
 * A second hand-written row is how the two drift into recording different things
 * about the same act.
 */
export function reportExportAudit(input: {
  salonId: string;
  kind: ReportKind;
  branchId: string | null;
  /**
   * THE RESOLVED WINDOW, NOT THE `Period` IT CAME FROM. The row has to say which
   * instants were queried, and a `Period` cannot: `30d` only becomes a window
   * once a `now` is chosen. Taking the resolved one also removes the possibility
   * that the audit row describes a window other than the one the export actually
   * ran against - there is no second resolution to disagree with the first.
   */
  window: PeriodWindow;
  rowCount: number;
  via: ReportExportVia;
}): {
  salonId: string;
  kind: 'access';
  action: string;
  detail: string;
  source: 'merchant';
  subjectType: string;
  subjectId: string;
  metadata: Record<string, unknown>;
} {
  const window = input.window;
  return {
    salonId: input.salonId,
    /**
     * `access`, not `money` and not `rules`. Nothing moved and nothing changed;
     * somebody read personnel or customer data and took a copy of it away.
     */
    kind: 'access',
    action: 'Report exported',
    detail:
      `${REPORT_TITLE[input.kind]} · ${input.branchId ?? 'all branches'} · ` +
      `${window.token} · ${input.rowCount} row${input.rowCount === 1 ? '' : 's'} · ${input.via}`,
    source: 'merchant',
    subjectType: 'report',
    subjectId: input.kind,
    metadata: {
      kind: input.kind,
      branchId: input.branchId,
      period: window.token,
      /**
       * `rolling` OR `calendar`, AND NOT THE TWO INSTANTS THEMSELVES.
       *
       * The instants were in this object for one draft, because `30d` only
       * describes a window in combination with the row's own timestamp while
       * `2026-03-01_2026-03-31` describes one on its own, and evening out that
       * asymmetry looked like a kindness to whoever reads `audit_log` in eighteen
       * months. `reports.test.ts` § "the whole serialised row contains no figure
       * but the row count" went red, and it was right to: that spec pins the shape
       * of this object by asserting NO NUMBER appears in it other than the count,
       * which is the cheapest possible guard against a figure from the export ever
       * being added here. Two ISO instants are twelve numbers, and defending them
       * would have meant loosening the one assertion standing between this builder
       * and the privilege downgrade its header is about.
       *
       * Nothing is actually lost. `audit_log` rows carry their own timestamp, so a
       * rolling window is recoverable from the row exactly as it always was, and a
       * calendar one is already complete in the token. The basis is the part that
       * was genuinely not recoverable - a reader had to know this module's grammar
       * to tell which kind of window `30d` was - and it is a word, not a number.
       */
      periodBasis: window.basis,
      rowCount: input.rowCount,
      via: input.via,
    },
  };
}

/** The design's card titles, verbatim, so the JSON can name what it returned. */
export const REPORT_TITLE: Record<ReportKind, string> = {
  customers: 'Customer information',
  sales: 'Sales summary',
  'best-selling-services': 'Best-selling services',
  'products-sold': 'Products sold',
  /**
   * "Artist performance", NOT "Staff performance", and the difference is the whole
   * argument of this kind — see the aggregate below. The request said "staff
   * statistics"; the attribution the request ALSO chose is by artist, and those are
   * overlapping sets rather than the same set (db/schema/artist.ts). A card titled
   * "Staff" whose rows are artists would be the label-is-not-a-definition failure
   * this file's header exists to prevent, on the title line.
   */
  'artist-performance': 'Artist performance',
  /**
   * NOT verbatim from the design, because the design has no card for it - see
   * REPORT_KINDS. It is Aftab's own words for the request ("earning by branch"),
   * pluralised to match the column it heads. `Branch performance` would have
   * mirrored `Artist performance` more neatly and says less: what the merchant
   * asked for is the earnings, and a title should name the number.
   */
  'earnings-by-branch': 'Earnings by branch',
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
  /**
   * Summed over EVERY row, artist rows and unattributed rows alike, so the headline
   * is the salon's whole service-and-shop take for the period and the table under it
   * accounts for all of it. A stat over the artist rows only would print a smaller
   * number than the file sums to, which is the one arithmetic a merchant WILL check.
   */
  'artist-performance': { key: 'earnedFils', label: 'KD earned', type: 'money' },
  /**
   * THE SAME KEY AND THE SAME LABEL AS `sales`, deliberately. It is the same
   * quantity over the same window and the same filter; a different label would
   * suggest a different definition, and two labels over one number is how a
   * merchant ends up believing she has two figures to compare.
   *
   * Because `statFor` sums this column over the rows, and the rows PARTITION the
   * salon's transactions by branch, this headline is `sales`' headline by
   * construction rather than by coincidence. `reportsBranch.int.test.ts` asserts
   * it anyway, per branch and per period, because "by construction" is what the
   * `-amount_fils` defect was also believed to be.
   */
  'earnings-by-branch': { key: 'grossFils', label: 'KD gross', type: 'money' },
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
 * `customers_all-branches_30d.csv`, and now also
 * `customers_all-branches_2026-03-01_2026-03-31.csv` — the design's own filename
 * shape (`<kind>_<branchTag>_<period>`), with the period token being the API's own
 * rather than the segment's word, so the filename says what was actually requested.
 *
 * ==========================================================================
 * A FREE RANGE HAS NO TOKEN - SO THE TOKEN WAS MADE TO CARRY THE RANGE
 * ==========================================================================
 * This was the hardest constraint in the range work, and the shape of `Period`
 * was chosen to satisfy it rather than the other way round. The alternative on
 * the table was `?from=&to=` as two parameters, which would have left this
 * function with two values and no name for them - and the natural repairs are
 * both bad. A filename that drops the range (`customers_all-branches.csv`) makes
 * two exports of two different questions indistinguishable in a downloads folder.
 * A hash (`customers_all-branches_a3f1.csv`) distinguishes them and tells the
 * merchant nothing about either.
 *
 * So the range IS the token, and the round-trip property in `services/period.ts`
 * is what makes that safe: `parsePeriod(periodToken(p))` is `p`, so two distinct
 * windows cannot produce one filename. `reports.test.ts` drives that property
 * rather than trusting it.
 *
 * THE PERIOD HALF NEEDS NO SANITISING AND IS NOT SANITISED. `periodToken` builds
 * its output from parsed integers via `padStart`, so it is `[0-9d_-]` by
 * construction - a caller cannot get a quote or a semicolon into it to break out
 * of the quoted Content-Disposition parameter. The BRANCH half still is stripped,
 * because a branch name really is free text a salon typed.
 *
 * (The range token contains `_`, which is also the field separator here, so a
 * calendar filename has four underscore-separated parts rather than three. Nothing
 * in this codebase parses a report filename - the dashboard reads the
 * Content-Disposition header and falls back to rebuilding the string - so this is
 * a cosmetic irregularity rather than an ambiguity, and it is preferred to
 * inventing a second separator that would then need escaping of its own.)
 */
export function reportFilename(
  kind: ReportKind,
  branchName: string | null,
  period: Period,
): string {
  const tag = branchName ? branchName.toLowerCase().replace(/\s+/g, '-') : 'all-branches';
  // A branch is named by a salon, so it reaches a filename. Anything that is not a
  // safe filename character goes, which also closes the header-injection path into
  // Content-Disposition.
  const safe = tag.replace(/[^a-z0-9-]/g, '');
  return `${kind}_${safe || 'branch'}_${periodToken(period)}.csv`;
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
  /**
   * The second window, or nothing. `services/period.ts` § Compare carries the
   * argument for why this is an EXPLICIT range rather than an implicit
   * predecessor, and why `previous` is refused for a calendar period.
   */
  compare?: Compare | null;
  /**
   * ONE `now` FOR BOTH WINDOWS, threaded rather than taken twice.
   *
   * This used to be a bare `new Date()` inside `computeReportBody`. With a
   * comparison the body runs TWICE, and two `new Date()` calls milliseconds apart
   * would resolve the period window and its `previous` against two different
   * instants - so the two windows would fail to abut by exactly that gap, and a
   * transaction landing in it would be counted by neither. Passing it also makes
   * every window in the tests deterministic.
   */
  now?: Date;
}

/**
 * ==========================================================================
 * WHAT A COMPARED REPORT IS, AND WHERE ITS DELTA COMES FROM
 * ==========================================================================
 * TWO FULL RUNS OF ONE AGGREGATE, NEVER A THIRD QUERY. `computeReportBody` is
 * called once per window with nothing changed but the bounds, so whatever holds
 * for a window on its own holds for both - `reportsReconciliation.int.test.ts`'s
 * equality between `sales` and `artist-performance`, the `NOT_VOIDED` exclusion,
 * the `transaction_revenue` expression, all of it. There is no comparison-only
 * SQL for a definition to drift into.
 *
 * AND THE DELTA IS DERIVED FROM THE TWO FIGURES THAT ARE SERVED, in the one
 * expression below and nowhere else:
 *
 *     delta.value === shape.stat.value - comparison.stat.value
 *
 * That is a property, not a convention, and `reports.test.ts` asserts it for
 * every kind. It matters because this file has already shipped the other shape
 * twice - DECISIONS.md #81 and #83 were both a number computed independently of
 * the numbers it claimed to summarise, and both survived review by looking right.
 * A third figure that can disagree with its own operands is the defect; a
 * subtraction of two served values cannot.
 *
 * THE ROWS OF BOTH WINDOWS ARE SERVED, AND THEY ARE NOT JOINED. A per-row
 * `previous` column was considered and rejected: `sales` is keyed by DAY, and two
 * arbitrary windows share no days at all, so five of the six kinds would gain a
 * column that the sixth could only fill with nulls. A report whose column list
 * changes shape depending on a query parameter is two reports under one filename.
 * The card compares the headline; the table shows each window's own rows.
 */
export interface ReportComparison {
  /**
   * THE RESOLVED WINDOW, NOT ITS WIRE FORM. `serialiseWindow` is applied once, by
   * the route, on the way out. Returning the wire form from here would force any
   * caller that needs the actual instants - the audit builder does - to parse the
   * ISO text back into a `Date`, or to resolve the window a second time; and a
   * second resolution is a second answer that can disagree with the first.
   */
  window: PeriodWindow;
  rows: ReportBody['rows'];
  rowCount: number;
  stat: ReportStat;
  /**
   * `stat.value` minus `comparison.stat.value`, signed. Same `label` and `type`
   * as the stat it is a difference of, so a client cannot render a money delta
   * as a count.
   */
  delta: ReportStat;
  /** Same basis and same length? `services/period.ts` § windowsComparable. */
  comparable: boolean;
}

export interface ReportResult extends ReportShape {
  /** Resolved, not serialised — see `ReportComparison`. */
  window: PeriodWindow;
  comparison: ReportComparison | null;
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
 * THE NEGATION IS NO LONGER WRITTEN HERE, AND NOR IS THE REST OF THE SUM. Every
 * revenue figure below reads `transaction_revenue` (migration 0042, money/revenue.ts)
 * — one relation, one expression, shared with the void handler that has to hand the
 * same number back. Three call sites used to write the arithmetic out and one of
 * them was right; see § THE FIX and DECISIONS.md #81. The negation is still VISIBLE
 * rather than an `abs()`, one layer down in the view, for the reason it always was:
 * `abs()` would mask a row whose sign was wrong for some other reason, and a wrong
 * sign is exactly the kind of thing a report should surface rather than launder.
 *
 * `shop_order_line.line_total_fils` is the exception: it is a PRICE, not a wallet
 * movement, and `shop_order_line_unit_price_positive` keeps it positive. It is summed
 * as-is, and the difference is stated here so the inconsistency reads as deliberate.
 *
 * THE FIX
 * -------
 * `transaction.amount_fils` on a BOOKED appointment is `-(gross - applied deposit)`:
 * the part that came out of her spendable balance at the counter. The deposit half
 * left her wallet earlier and became salon revenue at charge time, as a
 * `deposit_held` debit on the charge's own ledger entries. `sales` and
 * `best-selling-services` summed the wallet movement alone and therefore understated
 * every booked appointment by its deposit — a 6.000 service against a 5.000 deposit
 * exported as 1.000, an appointment a deposit covered outright as 0.000, under a
 * column headed `Gross KD`. Measured on a driven window: 23.5% of takings missing.
 * `earned_fils` on the view is the whole visit, and it is the same expression the
 * void's refund is computed from.
 */
const NOT_VOIDED = sql`AND NOT EXISTS (
      SELECT 1 FROM "transaction" r
       WHERE r.reverses_transaction_id = t.id AND r.status = 'settled'
    )`;

export async function computeReport(db: Db, scope: ReportScope): Promise<ReportResult> {
  const now = scope.now ?? new Date();
  const window = resolveWindow(scope.period, scope.timezone, now);

  const body = await computeReportBody(db, scope, window);
  const stat = statFor(scope.kind, body.rows);
  const shape: ReportShape = { ...body, stat };

  if (!scope.compare) return { ...shape, window, comparison: null };

  const cmpWindow = resolveCompareWindow(scope.compare, window, scope.timezone, now);
  /**
   * THE SAME FUNCTION, THE SAME SCOPE, ONLY THE BOUNDS DIFFER. Every predicate
   * the period window was measured under applies unchanged to the comparison
   * window - the branch filter, the void exclusion, the revenue expression.
   */
  const cmpBody = await computeReportBody(db, scope, cmpWindow);
  const cmpStat = statFor(scope.kind, cmpBody.rows);

  return {
    ...shape,
    window,
    comparison: {
      window: cmpWindow,
      rows: cmpBody.rows,
      rowCount: cmpBody.rows.length,
      stat: cmpStat,
      /** The one place a delta is computed. See § ReportComparison. */
      delta: { ...stat, value: stat.value - cmpStat.value },
      comparable: windowsComparable(window, cmpWindow),
    },
  };
}

async function computeReportBody(
  db: Db,
  scope: ReportScope,
  window: PeriodWindow,
): Promise<ReportBody> {
  /**
   * THE BOUNDS ARE THE WINDOW'S, NOT `now - N days` COMPUTED HERE.
   *
   * `now` used to be `new Date()` taken inside this function and `from` derived
   * from it; both are parameters of the window now, which is what lets the same
   * body serve a calendar range, and the same body serve a comparison window that
   * ended months ago. `now` is kept as a local name only because eleven query
   * templates below read `at(now)` as their upper bound - it is the window's END,
   * which for a rolling window is the current instant and for a calendar one is
   * salon midnight after the last day.
   */
  const from = window.fromInstant;
  const now = window.toInstant;
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
     * it too would bill the same service twice. NOT `deposit_return`, which is money
     * going back to her. NOT `adjustment`, which is the void mechanism itself.
     *
     * AND GROSS IS THE WHOLE VISIT, WHICH IT WAS NOT UNTIL DECISIONS.md #81. This
     * query summed `-t.amount_fils` — the WALLET movement — so a booked appointment
     * arrived net of the deposit that had already been earned against it. It reads
     * `rev.earned_fils` now: the same `transaction_revenue` expression the void
     * refunds from and `artist-performance` reports as `Earned KD`, which is what
     * makes those two figures reconcile for a period rather than merely look
     * similar. `count(*)` is unchanged — a visit is still one transaction, however
     * it was paid for.
     *
     * `revenueJoin` is INNER, and safely so: this WHERE clause already restricts to
     * settled `charge`/`shop` rows, which is exactly the view's own restriction. A
     * row that failed to match would take its `Transactions` count with it rather
     * than quietly contributing zero money.
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
             coalesce(sum(rev.earned_fils), 0)::bigint AS gross
        FROM "transaction" t
        ${revenueJoin('t')}
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

  if (scope.kind === 'earnings-by-branch') {
    /**
     * =====================================================================
     * EARNINGS BY BRANCH - the roll-up whose ROWS ARE BRANCHES.  (Aftab, item 7)
     * =====================================================================
     * One row per branch of the salon, over the whole period. `sales` answers
     * "what did each DAY take, and where"; this answers "what did each BRANCH
     * take". Same money, same predicates, same `transaction_revenue` expression -
     * regrouped. That is the whole design, and it is the reason the reconciliation
     * below is available at all.
     *
     * THE COLUMNS ARE ALL ADDITIVE, WHICH IS A CHOICE AND NOT AN ACCIDENT.
     * `artist-performance` carries `Customers`, a DISTINCT count that does not add
     * down its own column, and spends a comment warning about it. A branch roll-up
     * is a table a merchant WILL add up - the total is the point of it - so no
     * non-additive column is offered here at all. Distinct customers per branch is
     * already `GET /salons/{id}/metrics?branch=`'s `activeMembers`, which carries
     * the same warning in the place it belongs.
     *
     * EVERY BRANCH GETS A ROW, INCLUDING A CLOSED ONE AND ONE THAT TOOK NOTHING.
     * `FROM branch LEFT JOIN`, the shape `artist-performance` uses for artists and
     * for the same two reasons. "Salmiya earned 0.000" is a real answer to the
     * question asked; a silently absent branch is not. And a branch that shut in
     * March still earned last quarter's money - `services/branchFilter.ts` already
     * settled that reporting on a closed branch is the point, not an oversight, so
     * `closed_at` is not consulted here either.
     *
     * NO `Commission KD` COLUMN, and the reason is data rather than policy.
     * `transaction.fee_fils` is merchant-visible and customer-never, so it MAY
     * appear on a merchant report - but it is a TOP-UP concept. `services/order.ts`
     * says so in as many words ("`commissionFor` is a top-up concept"), and
     * `charge.ts`, `order.ts` and `booking.ts` each write `feeFils: 0`. This report
     * counts `charge` and `shop` rows only, so a commission column here would be
     * structurally zero in every cell forever: a fabricated column, which is the
     * one thing this file's header forbids. If AVO ever charges commission on a
     * charge, this is where it goes.
     *
     * =====================================================================
     * `branch_assumed` IS THE SUBJECT OF THIS REPORT, NOT A FOOTNOTE ON IT
     * =====================================================================
     * WHAT THE COLUMN ACTUALLY MEANS, read from the code that sets it rather than
     * from its name. `services/branch.ts` is the only writer. With no branch
     * supplied by an enrolled device it runs
     *
     *     SELECT id FROM branch WHERE salon_id = $1 AND closed_at IS NULL
     *      ORDER BY id LIMIT 2
     *
     * and returns the FIRST row with `established = rows.length === 1`. So
     * `branch_assumed = true` does NOT mean "inferred, and probably right". There
     * is no inference. It means: the salon has two or more open branches, no
     * enrolled till said where the money moved, `transaction.branch_id` is NOT
     * NULL, and SORT ORDER PICKED A VALUE so the column could have one.
     *
     * That is worse than "approximate" in a specific and directional way: every
     * assumed row in a salon lands on the SAME branch - the lowest branch id. At
     * the seeded salon that is `BR-KWC`. So the failure mode is not noise around a
     * true figure, it is one branch's column inheriting another branch's takings
     * wholesale while the other reads zero. The Overview's existing caveat -
     * "treat these branch figures as approximate" - is true and understates it,
     * and this file says so rather than repeating it.
     *
     * It is also NOT permanent and NOT universal. A single-branch salon is
     * `established` (nowhere else it could have happened), and an enrolled,
     * branch-bound till is `established` (migration 0043, DECISIONS.md #82). What
     * is assumed today is a multi-branch salon's un-enrolled tills.
     *
     * WHAT THIS REPORT DOES ABOUT IT: INCLUDES THE ROW UNDER THE BRANCH IT WAS
     * ATTRIBUTED TO, AND CARRIES THE SIZE OF THE DOUBT IN MONEY BESIDE IT.
     *
     * The three options were laid out and two were rejected:
     *
     *   REFUSE TO ATTRIBUTE - assumed money in no branch's row. Every per-branch
     *     figure at every multi-branch salon reads 0.000 today, which is a
     *     STRONGER and more wrong claim than any alternative: "nothing happened at
     *     Salmiya" is false, where "this figure is an attribution" is true.
     *
     *   A SEPARATE `Branch not established` ROW - the total still reconciles with
     *     `sales`, which is the letter of the requirement, and it fails the spirit
     *     of it. `sales` puts an assumed row under its attributed branch; this
     *     report would not; so the two would disagree BRANCH BY BRANCH while
     *     agreeing on the total, and per-branch is the axis a merchant reads. A
     *     second report that disagrees with the first is worse than no second
     *     report, and disagreeing only in the column nobody totals is the worst
     *     shape of that.
     *
     *   INCLUDE, AND REPORT THE SIZE OF THE DOUBT - chosen. It is also not a fresh
     *     decision: `services/metrics.ts` § 2 put these same three options for the
     *     same column and chose this one, for the Overview's per-branch tiles. A
     *     third file inventing a third answer to one question is precisely what
     *     these headers exist to prevent.
     *
     * THE DECIDING PROPERTY IS THAT IT DEGRADES CORRECTLY, which is metrics.ts's
     * argument and holds harder here. The doubt is a NUMBER, not a flag: equal to
     * the row's gross means the whole figure is an attribution, 0 means it is
     * exact, and anything between is the proportion. When device enrolment reaches
     * the tills those columns fall to zero on their own and the caveat disappears
     * from the card with no code changed anywhere.
     *
     * THE DOUBT IS CARRIED IN MONEY AS WELL AS IN A COUNT, and that is this
     * report's one departure from metrics.ts, which carries counts alone. Its
     * tiles ARE counts; this card's subject is money, and forty assumed
     * transactions out of fifty says nothing about whether they are 5% or 95% of
     * the branch's takings. `Assumed KD` is the figure a bonus decision actually
     * turns on, so it is the one on the face of the report.
     *
     * NOT OFFERED: a percentage. It is `Assumed KD / Gross KD`, derivable in the
     * spreadsheet this file exists to be opened in, and a percentage of a partly
     * attributed number reads as a precision that is not there.
     *
     * WHAT LANE C MUST RENDER (its column, reported not written): the card cannot
     * print a ranking without the caveat when any row has `assumedGrossFils > 0`.
     * The wording already exists in `apps/dashboard/src/routes/Overview.tsx` -
     * "Branch assumed on {...} - treat these branch figures as approximate" - and
     * should be reused rather than reinvented.
     */
    const rows = (await db.execute(sql`
      WITH earned AS (
        SELECT t.branch_id,
               count(*) AS txns,
               count(*) FILTER (WHERE t.branch_assumed) AS assumed_txns,
               coalesce(sum(rev.earned_fils), 0)::bigint AS gross,
               coalesce(sum(rev.earned_fils) FILTER (WHERE t.branch_assumed), 0)::bigint
                 AS assumed_gross
          FROM "transaction" t
          ${revenueJoin('t')}
         WHERE t.salon_id = ${scope.salonId}
           AND t.kind IN ('charge', 'shop')
           AND t.status = 'settled'
           AND t.created_at >= ${at(from)}
           AND t.created_at < ${at(now)}
           ${b === null ? sql`` : sql`AND t.branch_id = ${b}`}
           ${NOT_VOIDED}
         GROUP BY t.branch_id
      )
      SELECT br.name AS branch,
             coalesce(e.txns, 0) AS txns,
             coalesce(e.assumed_txns, 0) AS assumed_txns,
             coalesce(e.gross, 0)::bigint AS gross,
             coalesce(e.assumed_gross, 0)::bigint AS assumed_gross
        FROM branch br
        LEFT JOIN earned e ON e.branch_id = br.id
       WHERE br.salon_id = ${scope.salonId}
         ${b === null ? sql`` : sql`AND br.id = ${b}`}
       ORDER BY coalesce(e.gross, 0) DESC, br.name ASC
    `)) as unknown as Array<Record<string, unknown>>;

    return {
      kind: scope.kind,
      title: REPORT_TITLE[scope.kind],
      columns: [
        { header: 'Branch', key: 'branch', type: 'text' },
        /**
         * The same `count(*)` `sales` takes, over the same rows - so a branch's
         * count here equals the sum of that branch's rows on the Sales card.
         * Asserted, not assumed.
         */
        { header: 'Transactions', key: 'transactions', type: 'int' },
        /** `rev.earned_fils`: the whole visit, deposit included. See § THE FIX. */
        { header: 'Gross KD', key: 'grossFils', type: 'money' },
        /**
         * BESIDE the gross it qualifies rather than at the end of the row, because
         * at the end of the row it is a footnote and here it is a caveat on the
         * cell to its left. A merchant who reads two columns reads these two.
         */
        { header: 'Assumed KD', key: 'assumedGrossFils', type: 'money' },
        { header: 'Assumed transactions', key: 'assumedTransactions', type: 'int' },
      ],
      rows: rows.map((r) => ({
        branch: String(r.branch ?? ''),
        transactions: int(r.txns),
        grossFils: int(r.gross),
        assumedGrossFils: int(r.assumed_gross),
        assumedTransactions: int(r.assumed_txns),
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
     * and its revenue contribution is zero.
     *
     * REVENUE IS WHAT THE VISIT WAS WORTH, read from `transaction_revenue` through
     * `settled_transaction_id`. A LEFT JOIN rather than an inner one, because
     * dropping the unsettled rows would also drop them from the booking COUNT, which
     * is the ranking.
     *
     * TWO DEFECTS FIXED HERE, AND THE SECOND WAS NOT IN DECISIONS.md #81.
     *
     * (a) THE UNDERSTATEMENT. This column summed `-st.amount_fils` — the wallet
     *     movement — so a booked appointment arrived net of the deposit already
     *     earned against it, which on this card is EVERY row: every row here is a
     *     booking, and a booking is the only thing that takes a deposit. The
     *     understatement was therefore total rather than partial, and larger in
     *     proportion than on `sales`, which at least mixes in walk-ins and shop
     *     orders that have no deposit to lose. It reads `rev.earned_fils` now.
     *
     * (b) THE NEGATIVE ROW. The comment above used to claim a no-show's revenue
     *     "falls out naturally as zero because nothing settled". It does not: a
     *     `no_show_returned` booking HAS a `settled_transaction_id`, pointing at the
     *     `deposit_return` that gave the money back, and `booking_settlement_matches_
     *     status` guarantees it — only `deposit_held` may have a NULL there. A
     *     `deposit_return`'s `amount_fils` is POSITIVE (it credits her), so
     *     `sum(-amount_fils)` scored that booking NEGATIVE: a 5.000 no-show subtracted
     *     5.000 from its service's revenue, and could drive a popular service's
     *     Revenue KD below zero. It is zero now, and zero because the view has no
     *     row for a `deposit_return` at all — the boundary is a property of the
     *     definition rather than a filter this aggregate has to remember, which is
     *     what the old FILTER on `st.status` was doing and why it looked sufficient.
     *
     * The `status = 'settled'` FILTER is gone with the `transaction` join, because
     * both live in the view.
     *
     * THE WINDOW IS ON `starts_at`, not `created_at`: "best-selling this month"
     * means services performed this month, not services booked this month for
     * September.
     */
    const rows = (await db.execute(sql`
      SELECT sv.name AS service,
             br.name AS branch,
             count(*) AS bookings,
             coalesce(sum(rev.earned_fils), 0)::bigint AS revenue
        FROM booking bk
        JOIN service sv ON sv.id = bk.service_id
        JOIN branch br ON br.id = bk.branch_id
        ${revenueLeftJoin(sql`bk.settled_transaction_id`)}
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

  if (scope.kind === 'artist-performance') {
    /**
     * ==================================================================
     * ARTIST PERFORMANCE — "how many customers dealt, most earning, etc"
     * ==================================================================
     *
     * The request was for "staff statistics"; the reading chosen when it was put
     * back to the client is EARNINGS BY THE PERSON WHO PERFORMED THE SERVICE — the
     * artist — not by whoever rang the charge up. So the attribution runs through
     * the appointment, and `transaction.created_by_staff_id` is deliberately NOT
     * consulted. It would be easier and it would cover more rows, and it answers a
     * different question: "who was standing at the till". A receptionist who takes
     * payment for four artists' clients all afternoon would top a report built on
     * it, which is the exact figure a merchant must not hand a bonus on.
     *
     * THE JOIN
     * --------
     * `services/charge.ts` § 7a sets `booking.settled_transaction_id` to the CHARGE
     * that consumed a held deposit, and `booking.artist_id` is NOT NULL. So
     *
     *     booking JOIN transaction ON booking.settled_transaction_id = transaction.id
     *
     * with `kind = 'charge'` reaches the real service charge for a booked
     * appointment — not merely the deposit, and not a `deposit_return`. The kind
     * filter is what excludes the other two ends of the state machine: a cancelled
     * or no-showed booking is settled by a `deposit_return`, and a VOIDED charge's
     * booking is rewritten by `routes/charges.ts` to `cancelled` settled by the
     * void's `adjustment`. `NOT_VOIDED` is kept on top of that as a belt on a brace:
     * it is redundant today only because of that rewrite, and a report should not
     * depend on a rewrite in another file to avoid counting money that went back.
     *
     * =========================================================================
     * WHAT AN ARTIST EARNED IS NOT `-transaction.amount_fils`, AND THIS IS THE
     * FINDING OF THIS SLICE
     * =========================================================================
     * `charge.ts` § 4 caps the held deposit at the basket and writes the charge as
     * `amount_fils = -(gross - applied)`. The charge row therefore carries only the
     * part of the visit that came out of her SPENDABLE balance at the counter; the
     * deposit portion was debited earlier, as a `deposit_hold`, and became revenue
     * at charge time via `depositAppliedPosting`.
     *
     * So a 5.000 service against a 5.000 deposit produces a charge of EXACTLY ZERO.
     * A report summing `-amount_fils` would print `0.000 KD` next to an artist who
     * performed the appointment and a salon that was paid in full for it — a false
     * zero of precisely the kind `loadedTodayFils` returns null rather than emit.
     * That is not acceptable, and it cannot be fixed by a caveat: the column is the
     * number the bonus is decided on.
     *
     * THE APPLIED DEPOSIT IS A RECORDED FACT, NOT A DERIVATION. It is the
     * `deposit_held`/`debit` leg of the charge's own ledger entries.
     *
     * WHEN THIS KIND LANDED, IT READ THAT LEG WITH ITS OWN COPY OF THE THREE
     * PREDICATES, and said in this comment that it was "one definition rather than a
     * second that happens to agree" because `routes/charges.ts` already computed a
     * void's refund the same way. That was two implementations of one expression
     * being described as one. It is now genuinely one: `transaction_revenue`
     * (migration 0042, money/revenue.ts), read here as `rev.charged_fils` and
     * `rev.deposit_applied_fils`, and read by the void handler as `earned_fils` to
     * decide what to hand back —
     *
     *     refund = earned_fils = charged_fils + deposit_applied_fils
     *
     * "what the salon must give back if this is voided" and "what the salon earned"
     * are one quantity, and now one relation.
     *
     * BOTH HALVES ARE ON THE FACE OF THE REPORT, as `Charged KD` and
     * `Deposit applied KD`, with `Earned KD` their sum. Three columns rather than
     * one, because they answer three different questions a merchant actually asks,
     * and because `Charged KD` is the column that ties to the Sales card while
     * `Earned KD` is the one that is true. Folding them would have hidden a
     * disagreement between two reports inside a single number.
     *
     * FIXED, AND THE RECONCILIATION IS NOW ASSERTED. `sales` and
     * `best-selling-services` both summed `-amount_fils` and therefore both
     * understated a booked appointment by its deposit — reported when this kind
     * landed, decided as DECISIONS.md #81, corrected in the same commit as this
     * paragraph. Both read the view now.
     *
     * The consequence worth keeping in front of the next reader: `sales`' gross for
     * a window and branch and this report's `KD earned` headline for the same window
     * and branch are now TWO INDEPENDENT AGGREGATES OVER THE SAME MONEY — one
     * grouped by day over transactions, one grouped by artist through bookings with
     * two named unattributed buckets — and they must be EQUAL. That is the strongest
     * check available over these figures, and `services/reportsReconciliation.int.
     * test.ts` asserts it rather than leaving it as a property somebody once
     * observed. It is also why the walk-in and shop buckets exist at all: without
     * them there would be nothing for `sales` to reconcile against.
     *
     * =========================================================================
     * THE COVERAGE GAP, NAMED IN THE TABLE RATHER THAN IN THIS COMMENT
     * =========================================================================
     * Artist attribution reaches booked appointments that were charged. It cannot
     * reach:
     *
     *   A WALK-IN CHARGE. `charge.ts` touches a booking only when one is held, so a
     *       walk-in has no booking and therefore no artist. `basket_hash` is a
     *       sha256 and cannot be un-hashed, so there is no second route to one
     *       either — the same wall `best-selling-services` hits one column over.
     *
     *   A SHOP ORDER. Nobody performed a service; a bottle was sold.
     *
     * Both get a ROW, named, in the same table with the same money columns. That is
     * the whole reason the rows are shaped the way they are: the artist rows sum to
     * LESS than the headline, and the reader can see the two rows that make up the
     * difference without being told to. A merchant deciding a bonus can tell "this
     * artist earned nothing" — an artist row of zeros, which is a true statement —
     * from "this money has no artist", which is a named row of its own.
     *
     * A TOP-UP GETS NO ROW, and that is the one gap answered by exclusion rather
     * than by a row. A top-up is not revenue in any period — `sales` argues this at
     * length: it is the customer loading her own wallet, a liability the salon now
     * owes her, and it becomes revenue when she spends it, on the charge that this
     * report has already attributed. A zero row for it would claim the report had
     * accounted for money it deliberately leaves out, and a non-zero one would
     * count the same dinar twice. The report's denominator is SERVICE AND SHOP
     * REVENUE, and the card copy has to say so — Lane C's column, reported.
     *
     * EVERY ARTIST OF THE SALON GETS A ROW — `FROM artist LEFT JOIN`, not
     * `FROM booking`. An artist with no charged appointment in the window is a row
     * of zeros, which is the answer to a question a merchant is really asking, and
     * she cannot be silently absent. Retired artists (`active = false`) are included
     * for the same reason: one who worked in the window MUST appear, and dropping
     * her would move her takings into an unattributed row where they do not belong.
     *
     * `artist.staff_user_id` IS NULLABLE, so the `Staff account` column is either a
     * handle or the words `no staff account`. Not blank: blank reads as "unknown",
     * and this is a definite fact about her — the contract's own default is that
     * "artists do not need an AVO login". The staff join is scoped to THIS SALON, so
     * an artist row mislinked across tenants renders as no handle rather than
     * leaking another salon's staff handle into an export.
     *
     * =========================================================================
     * `?branch=` FILTERS ON THE TRANSACTION'S BRANCH, NOT THE BOOKING'S
     * =========================================================================
     * A booking has its own `branch_id`, and `best-selling-services` filters on it —
     * correctly, because its unit is a BOOKING COUNT. This report's unit is MONEY,
     * and the two columns can disagree: nothing constrains the branch a charge is
     * recorded at to equal the branch the appointment was booked at, and both are
     * frequently `branch_assumed` at a multi-branch salon (services/branch.ts).
     *
     * If the artist rows filtered on the booking's branch while the unattributed
     * rows filtered on the transaction's — they have no booking to filter on — then
     * the reconciliation this table's whole shape promises would only be
     * ACCIDENTALLY true, and would break on the first appointment paid for at the
     * other branch. So every row here filters on `transaction.branch_id`: the branch
     * the money was recorded at, which is also the branch the Sales card uses. Under
     * a branch, `Appointments` therefore means "appointments whose charge was taken
     * at this branch". Stated, because it is a real difference from the card next to
     * it.
     *
     * A LIVE DEMONSTRATION THAT THE TWO COLUMNS DO DISAGREE, not a hypothetical:
     * driving a real `POST /bookings` and a real `POST /charges` against seeded data
     * produced a booking and a charge that agreed on `BR-KWC` — and BOTH carried
     * `branch_assumed`, because `services/branch.ts` cannot tell where a staff
     * member is standing until device enrolment lands. So at a multi-branch salon
     * most of these rows are attributed to a branch the server GUESSED, exactly as
     * `sales`, `best-selling-services` and `products-sold` already are. This kind
     * inherits that limitation rather than inventing an exception to it, and
     * `services/metrics.ts` § 2 carries the argument for why it is filterable
     * anyway; it is called out here because a per-artist, per-branch earnings figure
     * is more tempting to act on than a per-branch transaction count.
     *
     * =========================================================================
     * NO `Branch` COLUMN, AND THE OTHER FOUR KINDS ALL HAVE ONE
     * =========================================================================
     * `sales`, `best-selling-services` and `products-sold` each carry `Branch` and
     * group by it, so an "All branches" export still breaks down per branch. This
     * one deliberately does not, and there are two reasons rather than one.
     *
     * The question is "who earned the most". An artist who works Salmiya on Tuesdays
     * and Kuwait City on Thursdays would arrive as TWO rows that the merchant has to
     * add up by eye before she can rank anybody — the ranking is the product, and
     * splitting it defeats it. `?branch=` is how the per-branch question gets asked.
     *
     * And `Customers` is a DISTINCT count, which does not add up. A customer seen at
     * both branches is 1 in each row and 1 in the salon, so per-branch rows would
     * present a column that looks summable and is not — the trap
     * `services/metrics.ts` pins for `activeMembers`. The money columns ARE additive
     * and would have been fine; one non-additive column is enough to make the split
     * table misleading, and there is no reading of these two rows that is both
     * per-branch and honest about the customer count.
     */
    const branchOnTx = b === null ? sql`` : sql`AND t.branch_id = ${b}`;

    /**
     * The (booking, charge) pairs this window attributes, and the applied deposit
     * on each. A CTE rather than a chain of LEFT JOINs off `artist`, because the
     * `Appointments` count has to be a count of QUALIFYING pairs: with the window
     * and the kind pushed into a LEFT JOIN condition, `count(booking.id)` would
     * happily count an appointment whose charge fell outside the period.
     */
    const attributed = sql`
      SELECT bk.artist_id,
             bk.member_id,
             bk.id AS booking_id,
             rev.charged_fils AS charged,
             rev.deposit_applied_fils AS deposit_applied
        FROM booking bk
        JOIN "transaction" t ON t.id = bk.settled_transaction_id
        ${revenueJoin('t')}
       WHERE bk.salon_id = ${scope.salonId}
         AND t.salon_id = ${scope.salonId}
         AND t.kind = 'charge'
         AND t.status = 'settled'
         AND t.created_at >= ${at(from)}
         AND t.created_at < ${at(now)}
         ${branchOnTx}
         ${NOT_VOIDED}`;

    /**
     * Every artist of the salon, with whatever the CTE attributed to her.
     *
     * THE `staff_user` JOIN CARRIES `su.salon_id = <this salon>` AS WELL AS THE ID.
     * `artist.staff_user_id` is a plain FK to `staff_user` with no same-salon
     * constraint behind it, so without that second equality a row mislinked across
     * tenants would print another salon's staff handle into this salon's export. A
     * null handle therefore means "no staff account" OR "a link pointing outside
     * this salon", and both render as the former — which is the safe direction, and
     * is reported rather than left as a property of a missing constraint.
     */
    const artistRows = (await db.execute(sql`
      WITH attributed AS (${attributed})
      SELECT ar.name,
             su.handle,
             count(a.booking_id) AS appointments,
             count(DISTINCT a.member_id) AS customers,
             coalesce(sum(a.charged), 0)::bigint AS charged,
             coalesce(sum(a.deposit_applied), 0)::bigint AS deposit_applied
        FROM artist ar
        LEFT JOIN attributed a ON a.artist_id = ar.id
        LEFT JOIN staff_user su
               ON su.id = ar.staff_user_id
              AND su.salon_id = ${scope.salonId}
       WHERE ar.salon_id = ${scope.salonId}
       GROUP BY ar.id, ar.name, su.handle
       ORDER BY (coalesce(sum(a.charged), 0) + coalesce(sum(a.deposit_applied), 0)) DESC,
                count(a.booking_id) DESC,
                ar.name ASC
    `)) as unknown as Array<Record<string, unknown>>;

    /**
     * The two unattributed buckets, in one pass.
     *
     * A walk-in is "a settled charge that is not any booking's settling
     * transaction" — the definition is the ABSENCE of the join above, so it cannot
     * drift from it. `deposit_applied` is read here too rather than written as a
     * literal zero: a walk-in should have no applied deposit by construction, and a
     * report that hardcodes what it believes cannot tell anybody when the belief
     * stops being true. The specs assert it is zero; this query would say so if it
     * were not — and because it reads the same view column the artist rows do, a
     * walk-in that somehow carried a deposit leg would appear in the total rather
     * than vanish from it.
     */
    const bucketRows = (await db.execute(sql`
      SELECT CASE WHEN t.kind = 'shop' THEN 'shop' ELSE 'walkin' END AS bucket,
             count(DISTINCT t.member_id) AS customers,
             coalesce(sum(rev.charged_fils), 0)::bigint AS charged,
             coalesce(sum(rev.deposit_applied_fils), 0)::bigint AS deposit_applied
        FROM "transaction" t
        ${revenueJoin('t')}
       WHERE t.salon_id = ${scope.salonId}
         AND t.kind IN ('charge', 'shop')
         AND t.status = 'settled'
         AND t.created_at >= ${at(from)}
         AND t.created_at < ${at(now)}
         ${branchOnTx}
         ${NOT_VOIDED}
         AND (
           t.kind = 'shop'
           OR NOT EXISTS (
             SELECT 1 FROM booking bk WHERE bk.settled_transaction_id = t.id
           )
         )
       GROUP BY 1
    `)) as unknown as Array<Record<string, unknown>>;

    const row = (
      attributedTo: string,
      attribution: string,
      staffAccount: string,
      source: Record<string, unknown> | undefined,
    ): Record<string, string | number | null> => {
      const charged = int(source?.charged);
      const depositApplied = int(source?.deposit_applied);
      return {
        attributedTo,
        attribution,
        staffAccount,
        customers: int(source?.customers),
        appointments: int(source?.appointments),
        chargedFils: charged,
        depositAppliedFils: depositApplied,
        /**
         * Added from two integers, both already through `int()`. Not computed in
         * SQL, so `statFor`'s sum of this column and the arithmetic of the row it
         * sits in are the same addition — non-negotiable #1 does not stop at the
         * edge of a derived column.
         */
        earnedFils: charged + depositApplied,
      };
    };

    const byBucket = new Map(bucketRows.map((r) => [String(r.bucket), r]));

    return {
      kind: scope.kind,
      title: REPORT_TITLE[scope.kind],
      columns: [
        /**
         * `Attributed to`, not `Artist`. Two of these rows are not an artist, and a
         * cell reading "Walk-in charges" under a column headed "Artist" would be a
         * category error printed in the merchant's own spreadsheet. The `Attribution`
         * column next to it is the machine-readable half, so the card can style or
         * the merchant can filter the artist rows without parsing a name.
         */
        { header: 'Attributed to', key: 'attributedTo', type: 'text' },
        { header: 'Attribution', key: 'attribution', type: 'text' },
        { header: 'Staff account', key: 'staffAccount', type: 'text' },
        /**
         * DISTINCT MEMBERS, AND THE COLUMN DOES NOT ADD DOWN. A customer seen by
         * two artists is 1 in each row, and a customer who also bought a bottle is
         * 1 in the shop row as well — the same arithmetic `services/metrics.ts`
         * pins for `activeMembers`. The three MONEY columns are additive and the
         * headline is a sum of one of them; this one is a per-row figure only.
         */
        { header: 'Customers', key: 'customers', type: 'int' },
        { header: 'Appointments', key: 'appointments', type: 'int' },
        { header: 'Charged KD', key: 'chargedFils', type: 'money' },
        { header: 'Deposit applied KD', key: 'depositAppliedFils', type: 'money' },
        { header: 'Earned KD', key: 'earnedFils', type: 'money' },
      ],
      rows: [
        ...artistRows.map((r) =>
          row(
            String(r.name ?? ''),
            'artist',
            r.handle ? String(r.handle) : 'no staff account',
            r,
          ),
        ),
        /**
         * ALWAYS BOTH, even at zero. An absent bucket cannot be told apart from a
         * bucket that was never computed, and "no walk-in revenue this month" is a
         * real and useful statement — it says every dinar had an artist behind it.
         */
        row('Walk-in charges', 'no artist', '', byBucket.get('walkin')),
        row('Shop orders', 'no artist', '', byBucket.get('shop')),
      ],
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
