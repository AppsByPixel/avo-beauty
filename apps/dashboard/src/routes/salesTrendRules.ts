import { add, fils, type Fils } from '@avo/types';
import { ALL_BRANCHES } from '../shell/BranchScope.js';
import type { Report } from '../api/reports.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE OVERVIEW'S SALES TREND — THE ARITHMETIC. NEW WORK; THERE IS NO CHART IN
 * THE DESIGN BUNDLE.
 * ═══════════════════════════════════════════════════════════════════════════
 * SAID PLAINLY SO A LATER READER DOES NOT GO LOOKING. `design/AVO Merchant
 * Dashboard.dc.html` contains no chart: its only matches for "graph" are inside
 * the word "Typography" and all nineteen of its `<svg>` are icons. Charts are
 * also absent from `design/README.md` § Known gaps, so there is no prior
 * decision being overridden — this is Aftab extending his own design ("There
 * must be Graphs on merchant dashboard"), which is the case CLAUDE.md § "Do not
 * add features" defers to. Same disclosure as `Overview.tsx § FEED_VISIBLE` and
 * `Reports.tsx § THE FOURTH SEGMENT` make about their own invented controls.
 *
 * The RENDERING lives in `SalesTrend.tsx`. Everything here is a pure function
 * over a `Report`, so every rule below can be asserted without a query client,
 * a session or a branch scope — the hole `earningsByBranchRender.test.tsx`
 * records a defect coming through.
 */

/**
 * FOURTEEN COMPLETE DAYS, AND BOTH HALVES OF THAT ARE DECISIONS.
 *
 * FOURTEEN rather than seven, because the thing a merchant reads off a
 * dashboard chart is a RHYTHM — Thursdays are big, Mondays are dead — and seven
 * bars cannot show a repeat of anything. Two of each weekday can. Thirty was
 * the other candidate and loses: thirty bars beside a five-row activity feed in
 * a half-width column are two pixels each, which is a texture rather than a
 * chart. A merchant who wants thirty or ninety has Reports, with a real period
 * control; this card is deliberately not a second one (§ WHY THERE IS NO PERIOD
 * CONTROL below).
 *
 * COMPLETE, i.e. ending YESTERDAY, because every bar must be a whole trading
 * day. A window ending today puts a part-day bar on the right-hand end, and at
 * ten in the morning that bar is a slump the salon did not have — on the most
 * confident-looking element on the page. Today is not thereby hidden: "Loaded
 * today" and the activity feed beside this card are both today, and the card's
 * own foot says which days it covers.
 */
export const TREND_DAYS = 14;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * § WHY THERE IS NO PERIOD CONTROL, AND WHY THE WINDOW IS A CALENDAR RANGE
 * ═══════════════════════════════════════════════════════════════════════════
 * NO CONTROL: the Overview has never had one, and adding one is a bigger change
 * than adding a chart — it would need to be shared with the KPI tiles above (a
 * chart on a different window from the tiles beside it is two answers to one
 * question) and the tiles' figures are point-in-time, so there is nothing for a
 * period to mean on three of the four. A fixed window, NAMED ON THE CARD from
 * the server's own echo, is the smaller and honest first slice.
 *
 * CALENDAR AND NOT `7d`/`30d`/`90d`, AND THIS IS THE LOAD-BEARING PART.
 * `api/src/services/period.ts` is emphatic that the presets are ROLLING:
 * `7d` is `[now − 7 × 86 400 000, now)`, so it "starts at this time of day seven
 * days ago and ends right now". Grouped by salon-local date — which is exactly
 * what `services/reports.ts § sales` does — a rolling seven-day window touches
 * EIGHT calendar days and the first and last of them are PART-DAYS. Drawn as
 * bars that is a chart whose leftmost column is half a Tuesday, indistinguishable
 * from a bad Tuesday, with nothing on the card able to say which.
 *
 * "Gross by day" is a calendar question, and `period.ts` shipped calendar ranges
 * precisely because rolling windows cannot answer one. So this card sends
 * `?period=YYYY-MM-DD_YYYY-MM-DD` and every bar is a whole salon-local day. Not
 * a workaround for a missing feature — the feature built for this.
 */

/**
 * The salon-local calendar date of an instant, `YYYY-MM-DD`.
 *
 * THE ZONE IS THE SALON'S OWN, READ OFF `GET /salons/{id}`, NOT PINNED.
 * `Overview.tsx § nextAtLabel` pins `Asia/Kuwait` and argues for it, and that
 * argument does not reach this far: a pin there decides how an instant the
 * server already chose is DISPLAYED, and a pin here would decide WHICH DAYS ARE
 * ASKED FOR. A wrong zone there renders a time an hour out; a wrong zone here
 * silently shifts the whole window by a day and the card still names the dates
 * confidently. `SalonSchema.timezone` exists, `useSalon()` already caches it for
 * the branch selector in the header, so the real value costs nothing.
 *
 * `formatToParts` rather than trusting `en-CA` to emit `YYYY-MM-DD`: the pattern
 * is a locale's presentation choice and the parts are the data.
 *
 * NULL ON AN UNUSABLE ZONE rather than a fallback. `Intl.DateTimeFormat` throws
 * `RangeError` on a zone id it does not know, and the tempting rescue — drop the
 * `timeZone` and use the browser's — is the silent wrong answer this whole
 * docblock exists to refuse. The caller renders a state that names the zone.
 */
export function localDate(at: Date, timezone: string): string | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(at);
  } catch {
    return null;
  }
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  const [year, month, day] = [get('year'), get('month'), get('day')];
  if (year === '' || month === '' || day === '') return null;
  return `${year.padStart(4, '0')}-${month}-${day}`;
}

/** `YYYY-MM-DD` → UTC midnight ms, or NaN. The dates are TEXT, never instants. */
function dateMs(ymd: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return Number.NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** UTC midnight ms → `YYYY-MM-DD`. */
function msDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const DAY_MS = 86_400_000;

/**
 * `2026-09-26` + (−13) → `2026-09-13`.
 *
 * ARITHMETIC ON UTC MIDNIGHT, WHICH IS EXACT AND IS NOT A ZONE CONVERSION.
 * These strings are salon-local calendar dates that have already been decided;
 * `formatWindowDay` in `api/reports.ts` makes the same argument for the same
 * reason ("text to be reformatted, not instants to be converted"). Anchoring
 * them at UTC midnight means no zone this function does not know about can move
 * a day, and every step is exactly 86 400 000 ms because UTC has no DST.
 */
export function shiftDate(ymd: string, days: number): string {
  const base = dateMs(ymd);
  if (Number.isNaN(base)) return ymd;
  return msDate(base + days * DAY_MS);
}

/** Every date from `from` to `to`, inclusive, ascending. Empty if reversed. */
export function enumerateDays(from: string, to: string): string[] {
  const start = dateMs(from);
  const end = dateMs(to);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return [];
  const out: string[] = [];
  for (let ms = start; ms <= end; ms += DAY_MS) out.push(msDate(ms));
  return out;
}

/**
 * The window this card asks for: the last `TREND_DAYS` COMPLETE salon-local
 * days, ending yesterday. `null` when the zone is unusable — see `localDate`.
 */
export function trendWindow(timezone: string, now: Date): { from: string; to: string } | null {
  const today = localDate(now, timezone);
  if (today === null) return null;
  const to = shiftDate(today, -1);
  return { from: shiftDate(to, -(TREND_DAYS - 1)), to };
}

/* ------------------------------------------------------------- the series -- */

export interface DayPoint {
  /** `YYYY-MM-DD`, salon-local. */
  date: string;
  /** Integer fils. Summed with `add`, never with `+` on a float. */
  grossFils: Fils;
  transactions: number;
}

export type SeriesResult =
  /**
   * `from`/`to` RIDE THE RESULT rather than being re-read off the window by the
   * caller, and that is a crash this shape removes rather than a convenience.
   * The empty state names the window it found nothing in, and its first draft
   * read `days[0].date` — which is `undefined` for the one payload that
   * produces an empty `days`: a window whose end precedes its start, where
   * `enumerateDays` correctly refuses to loop and correctly returns nothing.
   * A reversed window is a server fault that should render a sentence, not a
   * blank card with a TypeError behind it. Carrying the dates here means the
   * caller has no nullable date to assert away.
   */
  | { ok: true; days: DayPoint[]; from: string; to: string }
  /**
   * The window that came back is not one whose days can be named. Both reasons
   * are payload faults rather than merchant situations, and each gets its own
   * sentence rather than one "something went wrong": a reader who is told WHICH
   * can act on it, and this project has already shipped a screen that could not
   * tell a rolling window from a calendar one.
   */
  | { ok: false; reason: 'rolling-window' | 'fractional-fils' };

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE BAR PER DAY — AND THE ROWS ARE NOT ONE PER DAY
 * ═══════════════════════════════════════════════════════════════════════════
 * `services/reports.ts § sales` is `GROUP BY 1, 2` over `(salon-local date,
 * branch)` and `ORDER BY 1 DESC, 2 ASC`. Three facts follow, and drawing the
 * rows as they arrive gets all three wrong:
 *
 *   TWO BRANCHES MEANS TWO ROWS FOR ONE DAY. A bar per row draws Salmiya's
 *       Tuesday next to Kuwait City's Tuesday as if they were two days, and the
 *       x-axis silently stops being time.
 *
 *   A DAY WITH NO SETTLED CHARGE HAS NO ROW AT ALL. It is a `GROUP BY` over
 *       transactions, not a calendar. A chart of only the days that ARE there
 *       compresses a dead Monday out of existence and shows a fortnight in
 *       twelve bars — the reader counts bars and gets a different number of days
 *       from the one the caption names.
 *
 *   NEWEST FIRST. Drawn in wire order, time runs right to left.
 *
 * So the days come from the WINDOW and the rows are folded onto them. This is
 * the one place on either reporting surface that computes anything from rows,
 * and `Reports.tsx § NOTHING ON THIS SCREEN IS COMPUTED FROM ROWS` is worth
 * answering directly: that rule is about not producing a SECOND ANSWER to a
 * question the aggregate already answered — a total in the browser that can
 * disagree with the total in the file. Nothing here is such an answer. The
 * server does not publish "salon-wide gross on this day" in any field; per-day
 * salon-wide is the sum of that day's branch rows by construction, and summing
 * them is how the rows are READ, not a rival aggregate. No total is displayed.
 *
 * INTEGER FILS ALL THE WAY (#1). The fold is `add()` from `@avo/types` over
 * `Fils`, so a float cannot enter the money at any step; `fils()` throws on a
 * non-integer, which is why a fractional cell is caught HERE and reported as a
 * refusal instead of being allowed to throw mid-paint. `parseReport` validates
 * `stat.value` but casts `rows` (`rows: r.rows as Report['rows']`), so this is
 * the first place a row's money is actually checked.
 *
 * A ROW OUTSIDE THE WINDOW IS KEPT, NOT DROPPED. It should not happen — the
 * server queried the window it echoes — but a silent `continue` would take real
 * money off a revenue chart to preserve a tidy axis. The union is drawn and the
 * extra day is visible.
 */
export function seriesFrom(report: Report): SeriesResult {
  const w = report.window;
  if (w.basis !== 'calendar' || w.fromDate === null || w.toDate === null) {
    return { ok: false, reason: 'rolling-window' };
  }

  const gross = new Map<string, Fils>();
  const txns = new Map<string, number>();

  for (const row of report.rows) {
    const date = typeof row['date'] === 'string' ? row['date'] : '';
    if (date === '') continue;
    const rawGross = row['grossFils'];
    const rawTxns = row['transactions'];
    /*
     * `isSafeInteger` AND NOT `isInteger`, because `fils()` refuses both and
     * this guard exists precisely so it never has to: it throws `TypeError` on a
     * fraction and `RangeError` above 2^53, and either one reaching a render is
     * a blank screen where a sentence belongs.
     */
    if (typeof rawGross !== 'number' || !Number.isSafeInteger(rawGross)) {
      return { ok: false, reason: 'fractional-fils' };
    }
    gross.set(date, add(gross.get(date) ?? fils(0), fils(rawGross)));
    txns.set(date, (txns.get(date) ?? 0) + (typeof rawTxns === 'number' ? rawTxns : 0));
  }

  const spine = enumerateDays(w.fromDate, w.toDate);
  const all = [...new Set([...spine, ...gross.keys()])].sort();

  return {
    ok: true,
    from: w.fromDate,
    to: w.toDate,
    days: all.map((date) => ({
      date,
      grossFils: gross.get(date) ?? fils(0),
      transactions: txns.get(date) ?? 0,
    })),
  };
}

/**
 * THE BAR'S HEIGHT AS AN INTEGER PERMILLE OF THE TALLEST DAY — the display
 * boundary for #1, and it is crossed with integers on both sides.
 *
 * `value` and `max` are integer fils; `value * 1000` is an integer (a salon
 * would need a day over 9 × 10^12 fils — nine billion dinar — to leave the safe
 * range) and the rounding produces an integer 0…1000 which is a RATIO, not
 * money. No fils value is ever divided by 1000 to "get dinars" and then scaled;
 * that is the float-in-the-money path #1 forbids, and it is the obvious way to
 * write this function.
 *
 * `max <= 0` IS NOT AN ERROR. A fortnight in which nothing settled is a real
 * fortnight; it returns 0 for every bar and the card says why rather than
 * dividing by zero.
 */
export function barPermille(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.round((value * 1000) / max);
}

/** The tallest day, as `Fils`. Zero for an empty or all-zero series. */
export function peakFils(days: readonly DayPoint[]): Fils {
  return fils(days.reduce((top, d) => (d.grossFils > top ? d.grossFils : top), 0));
}

/** Total settled transactions across the drawn days — a count, never money. */
export function totalTransactions(days: readonly DayPoint[]): number {
  return days.reduce((n, d) => n + d.transactions, 0);
}

/* -------------------------------------------------------------- the scope -- */

export type TrendScope =
  /** No branch anywhere. The chart is salon-wide and so are the tiles. */
  | { kind: 'salon-wide' }
  /** A branch is applied to the tiles above; this chart is still salon-wide. */
  | { kind: 'wider-than-tiles' }
  /** The server narrowed a chart that asked to be salon-wide. */
  | { kind: 'narrowed'; branchId: string };

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * § WHAT THIS CHART DRAWS UNDER A BRANCH FILTER — SALON-WIDE, ALWAYS, AND IT
 * SAYS SO
 * ═══════════════════════════════════════════════════════════════════════════
 * THE `sales` AGGREGATE *CAN* BE SCOPED. It takes `?branch=` and the SQL applies
 * `AND t.branch_id = b`. Not scoping it is therefore a decision and needs a
 * better reason than consistency with the feed beside it, which genuinely
 * cannot be scoped.
 *
 * THE REASON IS THAT THE SCOPED ANSWER IS ONE THIS PAYLOAD CANNOT QUALIFY.
 * `api/src/services/branch.ts` is the only writer of `branch_assumed`, and with
 * no enrolled till it runs `ORDER BY id LIMIT 2` and takes the first row — so
 * every un-attributed charge in the salon lands on ONE branch, the lowest id.
 * `Reports.tsx § THE CAVEAT DECISION` drove it: 1 234.567 KD of Kuwait City's
 * 1 240.567 was an attribution while Salmiya, which actually took 6.000 of its
 * own, sat underneath. That is directional bias, not noise.
 *
 * At `branch=all` the bias is harmless — the words `BranchAssumedCaveat` already
 * uses: "every one of those dinars is inside it, just possibly under the wrong
 * branch". Under a branch it is not harmless at all, and it does not merely
 * move the LEVEL of the bars: it moves their SHAPE, which is the entire content
 * of a chart. And `sales` carries no field to size it with — `columns` is
 * `date · transactions · grossFils · branch`, and the `assumedGrossFils` /
 * `assumedTransactions` pair that makes a per-branch figure honest exists only
 * on `earnings-by-branch`.
 *
 * So the choice is between an EXACT salon-wide shape and an unquantifiably
 * wrong per-branch one, on the most confident-looking element on the page. It
 * is not close. The qualifier is the one the activity feed beside it already
 * prints, in the same place and the same words, so a merchant learns one rule
 * for the whole lower half of the screen: the tiles are branch-scoped, the
 * panels under them are salon-wide and say so when that differs.
 *
 * WHAT WOULD CHANGE IT: a per-branch chart becomes honest the day `sales`
 * carries its own assumed columns, or the day branch-bound scanner sessions
 * retire `branch_assumed` altogether. Reported, not taken here — it is an `api/`
 * change and this is lane C.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE THIRD CASE IS THE ONE THAT MAKES THIS A FUNCTION AND NOT A `&&` IN JSX
 * ═══════════════════════════════════════════════════════════════════════════
 * `narrowed` is read off `report.branchId` — the SERVER'S ECHO — for the reason
 * `Overview.tsx § WHAT THE FIGURES ACTUALLY COVER` gives about the tiles: what
 * we asked for is a hope and what came back is a fact, and a screen that
 * believes its own request is the exact defect the branch selector was built to
 * remove. This card asks for `all`; if a workspace answers with a branch anyway,
 * the bars are that branch's and a card captioned "All branches" over them would
 * be a lie this lane wrote rather than one it inherited.
 */
export function trendScope(selected: string, report: Report): TrendScope {
  if (report.branchId !== ALL_BRANCHES) return { kind: 'narrowed', branchId: report.branchId };
  if (selected !== ALL_BRANCHES) return { kind: 'wider-than-tiles' };
  return { kind: 'salon-wide' };
}
