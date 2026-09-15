import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { authedRequest } from '../auth/authedRequest.js';
import { useSalonId } from '../auth/AuthProvider.js';
import { readSession } from '../auth/session.js';
import { API_BASE_URL } from '../config.js';
import { ApiError } from './client.js';

/**
 * `GET /salons/{id}/reports/{kind}` (JSON, the cards) and `{kind}.csv` (the
 * export) — api-contract.md § "Addendum — Reports". One aggregate rendered two
 * ways on the server, so the card and the file cannot disagree; this client
 * therefore computes NOTHING from rows — the stat, the row count and the money
 * formatting all arrive decided, and money arrives as INTEGER FILS in the JSON
 * (the CSV is where the server formats it, once).
 *
 * EACH KIND IS ITS OWN QUERY, not one query for five cards, because each kind is
 * gated on the permission of the section it EXPORTS:
 *
 *   customers → team          sales → dashboard
 *   best-selling-services → appointments        products-sold → shop
 *   artist-performance → team
 *
 * A front-desk manager may hold `dashboard` and not `team`, so Sales loads while
 * Customers answers 403 ON THE SAME SCREEN. That is not an error state — it is
 * the permission ledger rendering — and it is why a single combined query would
 * be wrong twice: one 403 would take down four cards someone is allowed to see.
 *
 * `artist-performance` IS `team` AND NOT `dashboard`, and the difference is not
 * cosmetic. Its rows name individuals and what each of them earned, which is
 * personnel data; the seeded `frontdesk` account holds `appointments` and NOT
 * `team`, so a `dashboard` gate — or an `appointments` one, which the appointment
 * counts would have suggested — would put every artist's takings on the front-desk
 * tablet. The client asserts nothing about this: the gate is the server's
 * (`api/src/services/reports.ts` § REPORT_PERMISSION), and this comment exists so
 * that a future edit here does not "tidy" the mapping toward the obvious answer.
 *
 * Reports deliberately has NO permission chip of its own; "who may export
 * customer PII" is queued for the client (DECISIONS.md #9). If the mapping
 * changes, the change arrives through `packages/types`/api — nothing here
 * anticipates it.
 */

export const REPORT_KINDS = [
  'customers',
  'sales',
  'best-selling-services',
  'products-sold',
  'artist-performance',
] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

/**
 * The kinds whose rows are not a three-row preview of a file but a TABLE the
 * merchant reads on the card. See `Reports.tsx` for why artist-performance is the
 * only one, and why a preview slice would be wrong there specifically.
 */
export const REPORT_FULL_TABLE: ReadonlySet<ReportKind> = new Set<ReportKind>([
  'artist-performance',
]);

/**
 * The shape of the SKELETON, per kind — how many column and row bars to draw
 * before the wire has answered.
 *
 * A HINT, NOT A CONTRACT, and it is here rather than inferred because at skeleton
 * time there is nothing to infer FROM: `columns` arrives with the data. The four
 * original kinds all have four columns and show three rows, which is why the
 * numbers were literals in the renderer; artist-performance has eight columns and
 * shows every row, so those literals drew a four-column, three-row placeholder
 * that then jumped to an eight-column, six-row table. A skeleton whose shape does
 * not match what replaces it is a worse loading state than none: it promises a
 * layout and then reflows the screen out from under the reader.
 *
 * If the server's column count changes, the placeholder is one bar out for one
 * frame. Nothing reads these numbers as truth about the data.
 */
export const REPORT_SKELETON: Record<ReportKind, { columns: number; rows: number }> = {
  customers: { columns: 4, rows: 3 },
  sales: { columns: 4, rows: 3 },
  'best-selling-services': { columns: 4, rows: 3 },
  'products-sold': { columns: 4, rows: 3 },
  'artist-performance': { columns: 8, rows: 6 },
};

/** The design's card descriptions, verbatim. Titles arrive on the wire. */
export const REPORT_DESC: Record<ReportKind, string> = {
  customers: 'Profiles, tier and wallet balance',
  sales: 'Transactions and gross by day',
  'best-selling-services': 'Ranked by bookings',
  'products-sold': 'Units and revenue by product',
  /**
   * "SERVICE AND SHOP REVENUE" IS THE DENOMINATOR, AND IT IS THE POINT OF THE
   * SENTENCE - owed to this lane by lane A deliberately, rather than left to be
   * inferred from the rows.
   *
   * A TOP-UP GETS NO ROW HERE AT ALL. That is not an omission: money loaded into a
   * wallet is not revenue in any period, and it becomes revenue on the CHARGE this
   * report already attributes to an artist. A card that said "revenue" plainly
   * would invite a merchant to reconcile this headline against her top-up total and
   * conclude the report has lost money, when what it has avoided is a double count.
   * Naming the two things that DO produce a row is the only way the denominator
   * reads correctly from the card alone.
   *
   * "Attributed to the artist who performed it" is the second half, and it is the
   * answer Aftab gave when asked WHOSE earnings: the person who did the service,
   * not whoever rang the charge up at the desk. A front-desk manager who takes
   * payment for four artists' clients all afternoon tops a report built on the
   * wrong end of that question.
   */
  'artist-performance': 'Service and shop revenue, attributed to the artist who performed it',
};

/** `GET /salons/{id}/metrics`' vocabulary, reused by the addendum on purpose. */
export const REPORT_PERIODS = ['7d', '30d', '90d'] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];

/** The design's segment labels and its "N rows · {label}" caption, verbatim. */
export const PERIOD_SEGMENT_LABEL: Record<ReportPeriod, string> = {
  '7d': 'Week',
  '30d': 'Month',
  '90d': 'Quarter',
};
export const PERIOD_CAPTION: Record<ReportPeriod, string> = {
  '7d': 'This week',
  '30d': 'This month',
  '90d': 'This quarter',
};

/**
 * ===========================================================================
 * `?period=` IS NO LONGER ONE OF THREE WORDS, AND `ReportPeriod` NO LONGER
 * DESCRIBES IT
 * ===========================================================================
 * `api/src/services/period.ts` widened it to `7d|30d|90d` OR
 * `YYYY-MM-DD_YYYY-MM-DD`, both days inclusive, in the salon's own zone, 366
 * days at the outside. `ReportPeriod` above still names the three the DESIGN
 * draws as segments, because that is what it is used for — the segment labels
 * and the three captions. What travels on the wire is a `PeriodToken`, which is
 * a superset of it.
 *
 * THE TYPES ARE KEPT APART DELIBERATELY. Widening `ReportPeriod` to `string`
 * would have made `PERIOD_SEGMENT_LABEL` and `PERIOD_CAPTION` indexable by a
 * range, which is exactly the defect being fixed here: those two records were
 * keyed by the period and read as `PERIOD_CAPTION[r.period]` at three call
 * sites, so a range rendered `undefined` into the sentence "Nothing here for
 * undefined." Keeping the preset type narrow means the compiler refuses that
 * indexing rather than the screen printing it.
 */
export type PeriodToken = string;

/**
 * THE ONE PLACE A RANGE BECOMES A TOKEN. `YYYY-MM-DD_YYYY-MM-DD`, which is what
 * `parsePeriod` on the server reads back — `services/period.ts` § periodToken
 * round-trips it, and the export filename and the download row both depend on
 * that property.
 *
 * NO VALIDATION HERE, AND THAT IS THE POINT. Whether the range is the right way
 * round, and whether it is inside 366 days, is the server's to decide and it
 * decides it with a sentence written for a merchant ("period starts after it
 * ends: 2026-03-31 is later than 2026-03-01"). A second opinion in the browser
 * would be a second grammar to drift — the argument `Reports.tsx` § the refused
 * window makes at length. The only thing the screen withholds is a request it
 * has not finished composing: see `periodTokenOf` in `routes/Reports.tsx`.
 */
export function rangeToken(from: string, to: string): PeriodToken {
  return `${from}_${to}`;
}

/* ------------------------------------------------------------- the window -- */

/**
 * `window` — WHICH INSTANTS THE AGGREGATE ACTUALLY RAN OVER. Always present on
 * the wire since lane A's range slice; additive beside the bare `period` token.
 *
 * ===========================================================================
 * `fromDate`/`toDate` ARE NULL FOR A ROLLING WINDOW, AND THAT IS THE CONTRACT
 * ===========================================================================
 * `30d` means the last 30 × 24 hours ending at the instant the request was
 * served. Its ends are in the middle of somebody's afternoon. Printing
 * "1 Mar – 31 Mar" over a figure that means that is not a formatting slip, it is
 * a false label on a revenue number, and the server made it impossible to write
 * by hand rather than asking clients not to: there are no dates to print.
 *
 * So this client reads `basis` and NEVER the nullness of the dates — see
 * `windowPhrase` — and `parseWindow` REFUSES a rolling window that carries
 * dates. Belt and braces on the same invariant: the renderer cannot be tricked
 * by a payload, and a payload that breaks the promise fails loudly at the parse
 * with a sentence naming it, rather than reaching a card.
 */
export interface ReportWindow {
  /** `30d`, `2026-03-01_2026-03-31`, or `previous:30d` for a comparison. */
  token: string;
  basis: 'rolling' | 'calendar';
  /** ISO instants. The half-open pair `[from, to)` the server queried. */
  from: string;
  to: string;
  days: number;
  /** Salon-local calendar days, inclusive. NULL for a rolling window. */
  fromDate: string | null;
  toDate: string | null;
  timezone: string;
}

/**
 * `comparison` — THE SECOND WINDOW, null unless `?compare=` was sent. Always
 * present as a key, so this client reads one shape rather than branching on
 * whether a field exists.
 */
export interface ReportComparison {
  window: ReportWindow;
  columns: ReportColumn[];
  rows: Array<Record<string, string | number | null>>;
  rowCount: number;
  stat: ReportStat;
  /**
   * ALREADY `stat.value - comparison.stat.value`, ALREADY CARRYING `stat`'s OWN
   * `label` AND `type`. Nothing on this screen recomputes it, for the reason
   * nothing on this screen computes anything from rows: a second subtraction in
   * the browser is a second answer, and the day the two disagree the card
   * contradicts the file exported from the same aggregate.
   */
  delta: ReportStat;
  /**
   * SAME BASIS AND SAME LENGTH? The server's own `windowsComparable`. It is NOT
   * a refusal — the figures are correct for both windows either way — so the
   * card renders both and carries the caveat. Calendar June against calendar
   * May is `false`: 30 days against 31, a 3% difference in every total before
   * anything about the salon has changed.
   */
  comparable: boolean;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * `2026-03-01` → `1 Mar 2026`. Western digits, English only (Known gaps 1).
 *
 * SPLIT, NOT `new Date(...)`. `new Date('2026-03-01')` is parsed as UTC midnight
 * and then rendered in the BROWSER's zone, so a merchant in Kuwait reading a
 * report whose dates the server resolved in Asia/Kuwait would see every date one
 * day early west of UTC. These are salon-local calendar dates that have already
 * been decided; they are text to be reformatted, not instants to be converted.
 */
export function formatWindowDay(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  const month = MONTHS[Number(m[2]) - 1];
  if (month === undefined) return ymd;
  return `${Number(m[3])} ${month} ${m[1]}`;
}

/**
 * The window as it reads MID-SENTENCE — "Nothing here for *this month*",
 * "240.000 more than *1 Mar 2026 – 31 Mar 2026*".
 *
 * KEYED ON `basis`, NEVER ON WHETHER THE DATES ARE NULL. A renderer that said
 * "print the dates if they are there" produces a true label today and a false
 * one the moment a payload carries dates on a rolling window — which is the one
 * mistake on this screen that turns a correct figure into a wrong statement.
 * `parseWindow` refuses that payload as well; this function would still be
 * right if it did not.
 *
 * THE LOWERCASE FORM IS THE SOURCE and `windowLabel` capitalises it, rather than
 * the other way round. `PERIOD_CAPTION[...].toLowerCase()` was the existing call
 * shape and it is safe on "This month"; applied to a calendar window it would
 * produce "1 mar 2026 – 31 mar 2026", lowercasing a month name. Capitalising up
 * is safe on both; lowercasing down is not.
 */
export function windowPhrase(w: ReportWindow): string {
  if (w.basis === 'calendar') {
    const from = w.fromDate === null ? null : formatWindowDay(w.fromDate);
    const to = w.toDate === null ? null : formatWindowDay(w.toDate);
    if (from === null || to === null) return `${w.days} days`;
    return from === to ? from : `${from} – ${to}`;
  }
  const preset = (REPORT_PERIODS as readonly string[]).includes(w.token)
    ? PERIOD_CAPTION[w.token as ReportPeriod]
    : undefined;
  if (preset !== undefined) return preset.toLowerCase();
  /*
   * `previous:30d` — the comparison window of a rolling period. Its ends roll
   * too, so it gets a length and not dates, for this file's whole reason.
   */
  if (w.token.startsWith('previous:')) return `the previous ${w.days} days`;
  return `the last ${w.days} days`;
}

/** The same phrase where it starts a line — the foot's "N rows · This month". */
export function windowLabel(w: ReportWindow): string {
  const phrase = windowPhrase(w);
  return /^[a-z]/.test(phrase) ? phrase.charAt(0).toUpperCase() + phrase.slice(1) : phrase;
}

/* ----------------------------------------------------------------- the wire -- */

export interface ReportColumn {
  /** The header, verbatim from the design's `*Cols` arrays — the server owns it. */
  header: string;
  key: string;
  /** `money` columns carry integer fils in every row. */
  type: 'text' | 'int' | 'money';
}

export interface ReportStat {
  key: string | null;
  /** "customers" / "KD gross" / "bookings" / "units" — the design's statLabel. */
  label: string;
  /** Integer fils when `type` is 'money'; a plain count otherwise. */
  value: number;
  type: 'count' | 'int' | 'money';
}

export interface Report {
  kind: ReportKind;
  title: string;
  /**
   * STILL A BARE TOKEN AND STILL A STRING, now also a range — the server kept
   * the field and widened what it can hold (`routes/reports.ts` § period). It is
   * the REQUEST echoed back; `window` below is what was MEASURED, and the screen
   * renders the second. Nothing indexes `PERIOD_CAPTION` with this any more.
   */
  period: PeriodToken;
  window: ReportWindow;
  /** Null unless `?compare=` was sent. Always present as a key. */
  comparison: ReportComparison | null;
  /** A branch id, or the wire sentinel 'all'. */
  branchId: string;
  columns: ReportColumn[];
  rows: Array<Record<string, string | number | null>>;
  stat: ReportStat;
  rowCount: number;
}

function fail(where: string): never {
  throw new Error(`${where}: the report shape did not match the addendum.`);
}

/**
 * The window, parsed rather than cast — and the ROLLING/CALENDAR invariant
 * enforced here rather than trusted.
 *
 * A rolling window carrying dates, or a calendar window missing them, is the one
 * malformation on this payload that a renderer cannot tell from correct data:
 * both shapes render, and one of them renders a date range over a figure that is
 * not one. So the parse refuses both, with a sentence that names which.
 */
function parseWindow(raw: unknown, where: string): ReportWindow {
  if (typeof raw !== 'object' || raw === null) fail(where);
  const w = raw as Record<string, unknown>;
  if (typeof w.token !== 'string') fail(where);
  if (w.basis !== 'rolling' && w.basis !== 'calendar') fail(`${where}.basis`);
  if (typeof w.from !== 'string' || typeof w.to !== 'string') fail(`${where}.from/to`);
  if (typeof w.days !== 'number' || !Number.isInteger(w.days)) fail(`${where}.days`);
  if (typeof w.timezone !== 'string') fail(`${where}.timezone`);

  const fromDate = w.fromDate ?? null;
  const toDate = w.toDate ?? null;
  if (fromDate !== null && typeof fromDate !== 'string') fail(`${where}.fromDate`);
  if (toDate !== null && typeof toDate !== 'string') fail(`${where}.toDate`);

  if (w.basis === 'rolling' && (fromDate !== null || toDate !== null)) {
    throw new Error(
      `${where}: a rolling window carried calendar dates (${String(fromDate)} – ${String(toDate)}). ` +
        'A rolling window ends at the instant it was served; dates over it would be a false label.',
    );
  }
  if (w.basis === 'calendar' && (fromDate === null || toDate === null)) {
    throw new Error(`${where}: a calendar window arrived without the days it names.`);
  }

  return {
    token: w.token,
    basis: w.basis,
    from: w.from,
    to: w.to,
    days: w.days,
    fromDate: fromDate as string | null,
    toDate: toDate as string | null,
    timezone: w.timezone,
  };
}

/** A headline figure. Money rides it, so an int column's float is refused. */
function parseStat(raw: unknown, where: string): ReportStat {
  const s = raw as Record<string, unknown>;
  if (
    typeof s !== 'object' ||
    s === null ||
    typeof s.label !== 'string' ||
    typeof s.value !== 'number' ||
    (s.type !== 'count' && s.type !== 'int' && s.type !== 'money')
  ) {
    fail(where);
  }
  /*
   * A DELTA IS SIGNED AND A STAT IS NOT, so the integer check is the only one
   * both can share — and it is the one that matters. `fils()` throws on a float
   * mid-paint; this refuses the payload instead, naming the field.
   */
  if (s.type !== 'count' && !Number.isInteger(s.value)) {
    fail(`${where}.value (non-integer in a ${String(s.type)} stat)`);
  }
  return {
    key: (s.key as string | null) ?? null,
    label: s.label,
    value: s.value,
    type: s.type,
  };
}

/**
 * Parsed, not cast. Money rides these rows, and the rows are RENDERED — a null
 * where a fils integer was promised becomes "NaN KD" on a card a merchant reads
 * for revenue.
 */
export function parseReport(raw: unknown, kind: ReportKind): Report {
  if (typeof raw !== 'object' || raw === null) fail(kind);
  const r = raw as Record<string, unknown>;
  if (r.kind !== kind || typeof r.title !== 'string') fail(kind);
  /*
   * ===========================================================================
   * THIS LINE USED TO BE `REPORT_PERIODS.includes(String(r.period))` AND IT
   * THREW ON EVERY RANGE
   * ===========================================================================
   * The three presets were the whole vocabulary when it was written, so an
   * enum check WAS the shape check. `?period=2026-03-01_2026-03-31` now comes
   * back with `period: '2026-03-01_2026-03-31'` and that check failed it — the
   * card would have rendered "Couldn't load this report" against a 200 the
   * server composed correctly.
   *
   * WHAT REPLACES IT IS A TYPE CHECK, NOT A GRAMMAR CHECK. Re-validating the
   * token's shape here would be `services/period.ts`'s regular expression
   * written a second time in a second language, and the first divergence would
   * refuse a window the server had already measured. The token is an echo of
   * what this client asked for; `window` beside it is the part that is
   * load-bearing, and THAT is parsed field by field.
   */
  if (typeof r.period !== 'string') fail(`${kind}.period`);
  if (typeof r.branchId !== 'string') fail(kind);
  if (!Array.isArray(r.columns) || !Array.isArray(r.rows)) fail(kind);
  if (typeof r.rowCount !== 'number') fail(kind);

  const columns = r.columns.map((c) => {
    const col = c as Record<string, unknown>;
    if (
      typeof col.header !== 'string' ||
      typeof col.key !== 'string' ||
      (col.type !== 'text' && col.type !== 'int' && col.type !== 'money')
    ) {
      fail(`${kind}.columns`);
    }
    return { header: col.header, key: col.key, type: col.type as ReportColumn['type'] };
  });

  const stat = parseStat(r.stat, `${kind}.stat`);
  const window = parseWindow(r.window, `${kind}.window`);

  /*
   * NULL IS THE ANSWER "no comparison was asked for", and it is a different
   * thing from a missing key. The server always sends the key, so a payload
   * without it is a shape this client does not recognise rather than a card
   * with nothing to compare — and `?? null` would quietly turn one into the
   * other.
   */
  let comparison: ReportComparison | null = null;
  if (r.comparison !== null) {
    if (typeof r.comparison !== 'object' || r.comparison === undefined) {
      fail(`${kind}.comparison`);
    }
    const c = r.comparison as Record<string, unknown>;
    if (!Array.isArray(c.rows) || typeof c.rowCount !== 'number') fail(`${kind}.comparison`);
    if (typeof c.comparable !== 'boolean') fail(`${kind}.comparison.comparable`);
    comparison = {
      window: parseWindow(c.window, `${kind}.comparison.window`),
      columns,
      rows: c.rows as Report['rows'],
      rowCount: c.rowCount,
      stat: parseStat(c.stat, `${kind}.comparison.stat`),
      delta: parseStat(c.delta, `${kind}.comparison.delta`),
      comparable: c.comparable,
    };
  }

  /*
   * Every cell in a money column must be an integer — checked here so a float
   * cannot reach `fils()` at render, which would throw mid-paint instead of
   * failing the parse with a sentence naming the column.
   */
  for (const col of columns) {
    if (col.type !== 'money' && col.type !== 'int') continue;
    for (const row of r.rows) {
      const v = (row as Record<string, unknown>)[col.key];
      if (v !== null && (typeof v !== 'number' || !Number.isInteger(v))) {
        fail(`${kind}.rows[].${col.key} (non-integer in a ${col.type} column)`);
      }
    }
  }

  return {
    kind,
    title: r.title,
    period: r.period,
    window,
    comparison,
    branchId: r.branchId,
    columns,
    rows: r.rows as Report['rows'],
    stat,
    rowCount: r.rowCount,
  };
}

/* --------------------------------------------------------------- the hooks -- */

export interface ReportFilters {
  /** A branch id, or 'all'. The segment renders the NAME; the wire takes the ID. */
  branch: string;
  /** A preset or a range — `PeriodToken`. Never indexes a label record. */
  period: PeriodToken;
  /**
   * `previous`, a `YYYY-MM-DD_YYYY-MM-DD` range, or null for no comparison.
   *
   * IT IS PART OF THE QUERY KEY AND NOT PART OF THE EXPORT, and those two facts
   * are the whole of `?compare=` on this client. See `exportQuery`.
   */
  compare: string | null;
}

export const reportKeys = {
  one: (salonId: string, kind: ReportKind, f: ReportFilters) =>
    ['reports', salonId, kind, f] as const,
};

/** The CARD's query: branch, window, and the second window if there is one. */
function reportQuery(f: ReportFilters): string {
  const params = new URLSearchParams();
  if (f.branch !== 'all') params.set('branch', f.branch);
  params.set('period', f.period);
  if (f.compare !== null) params.set('compare', f.compare);
  return params.toString();
}

/**
 * ===========================================================================
 * THE FILE'S QUERY, AND IT DROPS `compare` — THE DESIGN'S PROMISE, KEPT ON
 * BOTH SIDES
 * ===========================================================================
 * The banner at the top of this screen is the contract: "the export matches
 * exactly what you see". The server keeps its half by REFUSING a comparison on
 * `.csv` and on the download mint — `400 compare_not_exportable`, refused
 * rather than silently dropped, because a file that quietly contained one of two
 * windows is discovered in Excel against a number the merchant was about to act
 * on.
 *
 * This client keeps the other half by asking for the file the merchant can
 * actually be shown: ONE window, named. Passing the card's whole query string
 * through would hit that refusal on every export while a comparison is up,
 * which is a correct server and a useless button.
 *
 * DROPPING IT IN THE URL IS NOT ENOUGH ON ITS OWN, and that is the part a
 * query-string change cannot carry: a merchant looking at two windows who
 * presses Export must be told the file is one of them. `Reports.tsx` §
 * ExportNote is the other half of this function, and neither is complete
 * without the other.
 */
function exportQuery(f: ReportFilters): string {
  const params = new URLSearchParams();
  if (f.branch !== 'all') params.set('branch', f.branch);
  params.set('period', f.period);
  return params.toString();
}

/**
 * The name the file gets when the server's own cannot be read.
 *
 * `{kind}_{branchTag}_{token}.csv` — `api/src/services/reports.ts` §
 * reportFilename, mirrored here rather than guessed. It was
 * `${kind}_${filters.period}.csv`: the BRANCH SEGMENT WAS MISSING ALTOGETHER,
 * which was already wrong for every export before ranges existed — two branches'
 * customer lists landed in a downloads folder as one name — and the period half
 * would have gone on being right by luck and then wrong for a range.
 *
 * A SECOND IMPLEMENTATION, AND A SANCTIONED ONE. The server's header is the
 * primary; this runs only when `content-disposition` is unreadable, which since
 * lane A added `exposedHeaders: ['content-disposition']` to the CORS
 * registration is a narrow case rather than the everyday one it used to be. It
 * tracks `reportFilename`, including the sanitiser: a branch name is free text a
 * salon typed, and everything outside `[a-z0-9-]` goes.
 */
export function reportFilenameFallback(
  kind: ReportKind,
  branchName: string | null,
  period: PeriodToken,
): string {
  const tag = branchName ? branchName.toLowerCase().replace(/\s+/g, '-') : 'all-branches';
  const safe = tag.replace(/[^a-z0-9-]/g, '');
  return `${kind}_${safe || 'branch'}_${period}.csv`;
}

export function useReport(kind: ReportKind, filters: ReportFilters): UseQueryResult<Report> {
  const salonId = useSalonId();
  return useQuery({
    queryKey: reportKeys.one(salonId, kind, filters),
    queryFn: async ({ signal }) =>
      parseReport(
        await authedRequest<unknown>(
          'merchant',
          `/salons/${salonId}/reports/${kind}?${reportQuery(filters)}`,
          { signal },
        ),
        kind,
      ),
    /*
     * A 403 here is a STANDING ANSWER, not a transient one — the permission
     * ledger. The global retry policy already short-circuits 401/403, so the
     * refused card settles in one round trip. No override needed; noted because
     * this screen is where four different permissions land side by side.
     */
  });
}

/* -------------------------------------------------------------- the export -- */

/**
 * THE DOWNLOAD IS AN AUTHENTICATED FETCH, AND THE BRIEF ASKED FOR A PLAIN
 * NAVIGATION. The conflict is real and was found by driving, not reading:
 *
 *   GET /salons/{id}/reports/sales.csv  (no Authorization)  → 401 unauthorized
 *
 * `resolvePrincipal` reads `req.headers.authorization` and nothing else — no
 * cookie, no query token (principal.ts:407). A bare `<a href>` sends no bearer,
 * so "let the browser do the download" cannot authenticate against the API as
 * merged, and would ship a button that saves a JSON error body named sales.csv.
 * Reported to trunk: the endpoint needs a one-time signed download URL (or a
 * cookie the CSV route accepts) — an `api/` change this lane must not make.
 *
 * Until then, the fetch preserves what the brief was protecting:
 *   - THE SERVER STILL NAMES THE FILE. The filename comes from
 *     `content-disposition` when the browser can read it. Cross-origin that
 *     header is not CORS-safelisted and `{ origin: true }` exposes nothing, so
 *     dev reads null — the fallback rebuilds `{kind}_{period}.csv` and says so.
 *     (`expose: content-disposition` is one line in api/app.ts — also reported.)
 *   - A REFUSED EXPORT REFUSES VISIBLY. A 403 surfaces the server's sentence on
 *     the card instead of downloading an error file — something the plain anchor
 *     could never do.
 *
 * The blob is held only long enough to hand to the browser's download manager,
 * and the object URL is revoked immediately after the click.
 */
export async function downloadReportCsv(
  salonId: string,
  kind: ReportKind,
  filters: ReportFilters,
  /**
   * The SELECTED branch's name, or null for all branches — needed only by the
   * fallback filename, which has to reproduce the server's `{branchTag}`
   * segment. The screen has it already (the segment renders names and sends
   * ids); deriving it here would mean this module fetching the salon.
   */
  branchName: string | null,
): Promise<void> {
  const session = readSession('merchant');
  if (!session) throw new ApiError('Sign in to continue.', { status: 401, code: 'unauthorized' });

  /* `exportQuery`, NOT `reportQuery` — the file is one window. See above. */
  const url = `${API_BASE_URL}/salons/${salonId}/reports/${kind}.csv?${exportQuery(filters)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
  } catch {
    throw new ApiError("We can't reach the workspace.", {
      status: 0,
      code: 'offline',
      offline: true,
    });
  }

  if (!response.ok) {
    let code = 'export_failed';
    let message = "Couldn't export the file. Try again.";
    try {
      const body = (await response.json()) as { error?: string; message?: string };
      if (typeof body.error === 'string') code = body.error;
      if (typeof body.message === 'string') message = body.message;
    } catch {
      // A non-JSON error body keeps the generic sentence.
    }
    throw new ApiError(message, { status: response.status, code });
  }

  const disposition = response.headers.get('content-disposition');
  const fromServer = disposition ? /filename="([^"]+)"/.exec(disposition)?.[1] : undefined;
  const filename = fromServer ?? reportFilenameFallback(kind, branchName, filters.period);

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
