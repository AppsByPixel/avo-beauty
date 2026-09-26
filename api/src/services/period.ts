/**
 * THE WINDOW A REPORT OR A TILE IS MEASURED OVER — and whether it is a ROLLING
 * one or a CALENDAR one, which is the distinction this whole module exists to
 * keep visible.                                          (Aftab, item 9, half 1)
 *
 * IT IS ALSO THE WINDOW A LIST IS FILTERED BY, since `?from=`/`?to=` arrived on
 * `GET /salons/{id}/bookings`. Two grammars, one vocabulary: see
 * `parseCalendarRange` below for why a list filter spells its range as two
 * parameters and a report spells the same range as one token, and why both end
 * up in the same `Period` so that `resolveWindow` is the only place instants are
 * derived from calendar dates.
 *
 * This vocabulary used to be four lines at the top of `services/metrics.ts`:
 * three presets, a day count, and a parser. It has moved here because it is no
 * longer a metrics detail — `services/reports.ts`, `routes/reports.ts` and
 * `routes/salons.ts` all resolve a window now, and a shared concept living
 * inside one of its consumers is how the consumer's header ends up describing
 * something it does not own. Nothing is re-exported from `metrics.ts`: one
 * home, and every import points at it.
 *
 * ==========================================================================
 * ROLLING AND CALENDAR ARE TWO DIFFERENT QUESTIONS
 * ==========================================================================
 * `7d` / `30d` / `90d` are **rolling**. `30d` is `[now - 30×86 400 000, now)` —
 * it starts at this time of day thirty days ago and it ends *right now*. It is
 * not "the last thirty calendar days", and it is emphatically not a month.
 *
 * `2026-03-01_2026-03-31` is **calendar**. It is `[salon midnight on 1 March,
 * salon midnight on 1 April)` — whole salon-local days, both endpoints
 * inclusive as the merchant would say them out loud.
 *
 * A merchant comparing a rolling 30 days against calendar June is comparing two
 * different questions, and before this module there was no way for a client to
 * tell which it had been given: `period` was a three-value enum and every value
 * in it was rolling, so the distinction could not arise. It can now, so every
 * window this module resolves carries its own `basis`, and `fromDate`/`toDate`
 * are **null for a rolling window** — deliberately, so a client physically
 * cannot render "1 Mar – 31 Mar" over a figure that actually means "the last 30
 * × 24 hours". The type makes the honest rendering the only reachable one.
 *
 * ==========================================================================
 * THE ZONE IS THE SALON'S, AND A RANGE IS WHERE THAT STOPS BEING OPTIONAL
 * ==========================================================================
 * A rolling window is zone-free: `now - 30 days` is the same instant in every
 * zone. A calendar one is not. "1 March" at a Kuwait salon begins at 21:00Z on
 * 29 February, and a range resolved in UTC instead would move both ends three
 * hours — dropping the last three hours of 31 March's takings and picking up the
 * last three hours of 28 February's in their place. The merchant would see a
 * figure she could not reconcile against her till at either end, with nothing on
 * the page to say it was a boundary rather than a loss.
 *
 * So `resolveWindow` takes the zone and both ends go through
 * `wallClockInstant`, which is the same call `services/metrics.ts` already makes
 * for "today" and the same salon-local day `services/reports.ts` § sales already
 * groups by. Three places, one definition of when a salon's day begins.
 *
 * ==========================================================================
 * THE TOKEN IS THE SERIALISED FORM, AND IT ROUND-TRIPS
 * ==========================================================================
 * `periodToken(p)` renders a `Period` as one string, and `parsePeriod` of that
 * string returns the same `Period`. That property is not decoration; three
 * things rest on it:
 *
 *   THE FILENAME. `reportFilename` is `{kind}_{branch}_{token}.csv`. Two
 *       exports of two different windows must not produce one filename, and the
 *       round trip is what proves they cannot: equal tokens parse to equal
 *       periods, so distinct periods have distinct tokens.
 *
 *   THE AUDIT LINE. `REPORT_AUDITED` rows read `… · 2026-03-01_2026-03-31 · …`.
 *       The same argument: two audit rows that read identically for different
 *       questions would make `audit_log` read as coverage it does not have.
 *
 *   THE DOWNLOAD MINT. `report_download.period` is one `text` column, and the
 *       redemption parses it back to rebuild the report. Round-tripping is
 *       literally the mechanism there — a token that lost a day would serve a
 *       different file than the one the merchant clicked for.
 *
 * THE TOKEN IS BUILT FROM THE PARSED NUMBERS, never from the caller's string.
 * `ymd()` formats `CalendarDate` fields with `padStart`, so a token can only
 * ever be `[0-9-_]`. That is what closes the Content-Disposition injection path
 * for the period half of the filename — not a sanitiser afterwards, which is a
 * filter somebody can later forget to apply, but a value that cannot carry a
 * quote or a semicolon in the first place. `reportFilename` still strips the
 * BRANCH tag, because a branch name really is free text a salon chose.
 */

import { badRequest } from '../http/errors';
import { MINUTES_PER_DAY, parseDate, wallClockInstant, type CalendarDate } from '../time/zone';

/** api-contract.md § Operations: `?period=`. The three rolling windows. */
export const PERIOD_PRESETS = ['7d', '30d', '90d'] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

/**
 * EXPORTED so `services/reports.ts` measures the same window `services/metrics.ts`
 * does. A report whose "30d" differed from the Overview tile's "30d" would be two
 * answers to one question.
 */
export const PERIOD_DAYS: Record<PeriodPreset, number> = { '7d': 7, '30d': 30, '90d': 90 };

export type PeriodBasis = 'rolling' | 'calendar';

/**
 * A DISCRIMINATED UNION, not a string with two shapes in it.
 *
 * Every consumer that has to behave differently for a range than for a preset —
 * and there are four — switches on `basis` and gets exhaustiveness from the
 * compiler. The alternative considered and rejected was keeping `Period` a
 * string and pattern-matching it at each site, which is the same regular
 * expression written four times and three places for it to drift.
 *
 * `to` IS INCLUSIVE. `{ from: 1 March, to: 31 March }` is the whole of March,
 * because that is what a merchant means by "1 to 31 March". The half-open
 * instant pair is derived in `resolveWindow`, once, where the zone is known.
 */
export type Period =
  | { readonly basis: 'rolling'; readonly preset: PeriodPreset }
  | { readonly basis: 'calendar'; readonly from: CalendarDate; readonly to: CalendarDate };

/**
 * THE LONGEST RANGE, and it is a cap on the QUESTION rather than on the answer.
 *
 * Two reasons, and the second is the one that decides it. An unbounded range is
 * an unbounded scan of `transaction` behind a single GET, and an unbounded CSV
 * at the end of it. But the reason it is 366 and not, say, 3 650 is that a
 * report over a decade is not a report anybody reconciles — the longest window a
 * merchant checks against her own books is a year, and a range longer than that
 * is far more likely to be a typo in a year digit than a question. Refusing it
 * names the fix; serving eleven years of rows silently does not.
 *
 * 366, not 365, so a leap year expressed as two calendar dates is not refused
 * for being one day too long.
 */
export const MAX_RANGE_DAYS = 366;

const RANGE = /^(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/;

function ymd(d: CalendarDate): string {
  return `${String(d.year).padStart(4, '0')}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

/** UTC midnight of a calendar date — zone-free arithmetic for counting DAYS. */
function utcMidnight(d: CalendarDate): number {
  return Date.UTC(d.year, d.month - 1, d.day);
}

const GRAMMAR =
  `period must be one of ${PERIOD_PRESETS.join(', ')}, ` +
  `or a calendar range like "2026-03-01_2026-03-31" (both days included, in the salon's timezone).`;

/**
 * A calendar date out of a range token, refused as an `invalid_period`.
 *
 * `parseDate` already does the work, including the round trip that catches
 * "2026-02-31" — which the regex above is perfectly happy with. Its refusal is
 * re-wrapped rather than allowed through because its code is `invalid_date`, and
 * ONE PARAMETER SHOULD HAVE ONE ERROR CODE: a client handling `?period=` should
 * not have to know that two of its failure modes answer differently. Nothing is
 * lost in the swallow — `parseDate`'s only failure mode is "that is not a real
 * date", and the message below says so with the offending token in it.
 */
function rangeDate(token: string, field: string): CalendarDate {
  try {
    return parseDate(token, field);
  } catch {
    throw badRequest('invalid_period', `${field} is not a real calendar date: ${token}. ${GRAMMAR}`);
  }
}

function parseRange(raw: string, label: string): { from: CalendarDate; to: CalendarDate } {
  const m = RANGE.exec(raw);
  if (!m) throw badRequest('invalid_period', `${label} "${raw}" is not a window. ${GRAMMAR}`);
  const from = rangeDate(m[1] as string, `${label} start`);
  const to = rangeDate(m[2] as string, `${label} end`);

  if (utcMidnight(to) < utcMidnight(from)) {
    throw badRequest(
      'invalid_period',
      `${label} starts after it ends: ${ymd(from)} is later than ${ymd(to)}.`,
    );
  }
  const days = calendarDays(from, to);
  if (days > MAX_RANGE_DAYS) {
    throw badRequest(
      'invalid_period',
      `${label} spans ${days} days; the longest window is ${MAX_RANGE_DAYS}. Export in shorter windows.`,
    );
  }
  return { from, to };
}

/**
 * How many whole calendar days a range covers, both ends included.
 *
 * COUNTED FROM THE DATES, NOT FROM THE RESOLVED INSTANTS, and that is the
 * difference between an integer and a number that is occasionally 30.958333. In
 * a DST zone the instant span of a calendar month is not a whole number of
 * 24-hour days; Kuwait has no DST, so this would have been invisible here and
 * wrong the first time AVO signed a salon somewhere that does. UTC midnights are
 * DST-free by construction, so this subtraction is exact everywhere.
 */
function calendarDays(from: CalendarDate, to: CalendarDate): number {
  return Math.round((utcMidnight(to) - utcMidnight(from)) / 86_400_000) + 1;
}

/**
 * `?period=` — a preset, a calendar range, or absent (which is `30d`, exactly as
 * it was before ranges existed).
 *
 * THE TIMEZONE IS NOT A PARAMETER HERE, on purpose. Parsing answers "what did
 * she ask for"; resolving answers "which instants is that". Only the second needs
 * the zone, and only the second can be done after the salon row has been read —
 * which in `routes/reports.ts` is AFTER the permission and tenancy checks. Fusing
 * them would force the salon lookup before the gate, which is the ordering that
 * file's header spends a paragraph refusing.
 */
export function parsePeriod(value: unknown): Period {
  if (value === undefined || value === null || value === '') {
    return { basis: 'rolling', preset: '30d' };
  }
  const raw = String(value);
  if ((PERIOD_PRESETS as readonly string[]).includes(raw)) {
    return { basis: 'rolling', preset: raw as PeriodPreset };
  }
  return { basis: 'calendar', ...parseRange(raw, 'period') };
}

/**
 * ==========================================================================
 * THE SAME CALENDAR RANGE, SPELLED AS TWO PARAMETERS: `?from=` AND `?to=`.
 * ==========================================================================
 * `?period=2026-03-01_2026-03-31` is one token because a report's window is one
 * thing that has to round-trip through a filename, an audit line and a `text`
 * column — see the header. A LIST FILTER has none of those obligations and is
 * asked by a client that already holds two dates: the merchant dashboard's week
 * grid knows its Sunday and its Saturday, and joining them into a token for the
 * server to split again is ceremony with a parser on each end of it.
 *
 * SO IT IS A SECOND GRAMMAR FOR THE SAME VOCABULARY, and it lives here rather
 * than in the route for the reason this module exists at all: "a shared concept
 * living inside one of its consumers is how the consumer's header ends up
 * describing something it does not own". The two grammars share `parseDate`, the
 * ordering refusal, `calendarDays` and `MAX_RANGE_DAYS`, and what they produce is
 * the SAME `Period` — so `resolveWindow` resolves a `?from=`/`?to=` range with no
 * new date arithmetic anywhere. That reuse is the point. A list endpoint that
 * derived its own instants from its own offset maths would be the second
 * definition of when a salon's day begins, and the first one to drift.
 *
 * WHAT IT DOES NOT SHARE IS THE ERROR CODE. `parsePeriod` refuses with
 * `invalid_period` because one parameter should have one error code; there are
 * two parameters here and one concept, so the code is `invalid_range` and every
 * message NAMES THE FIELD it is about. A client handling a 400 must be able to
 * put the refusal under the right input.
 *
 * BOTH ENDS OR NEITHER, and this is the decision worth arguing. A `from` with no
 * `to` has two readings — "to the end of the records" and "to today" — and they
 * are different windows. It is also the unbounded half of an unbounded scan: the
 * span ceiling below can only be applied to a range that has two ends. This is
 * the same refusal `parseCompare` makes for `compare=previous` on a calendar
 * period, for the same reason: a client that demonstrably knows one date knows
 * the other, and refusing beats guessing.
 *
 * THE CEILING IS `MAX_RANGE_DAYS`, REUSED RATHER THAN RE-CHOSEN. Its own comment
 * carries the argument verbatim for this caller — an unbounded range is an
 * unbounded scan behind one GET, and a window longer than a year is far more
 * likely to be a typo in a year digit than a question. The refusal states the
 * limit and the span, because "invalid" tells a client nothing it can act on.
 */
export type CalendarPeriod = Extract<Period, { basis: 'calendar' }>;

/** Absent, null or blank — the three ways a query parameter is not given. */
function unset(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === '';
}

/**
 * One end of a `?from=`/`?to=` range. `parseDate` already does the work including
 * the round trip that catches "2026-02-31"; its `invalid_date` is re-wrapped for
 * the one-code reason above, and nothing is lost in the swallow — its only
 * failure mode is "that is not a real date", which the message below says with
 * the offending token and the field name in it.
 */
function rangeEnd(token: string, field: 'from' | 'to'): CalendarDate {
  try {
    return parseDate(token, field);
  } catch {
    throw badRequest(
      'invalid_range',
      `${field} is not a calendar date: ${token}. Use a date like "2026-03-01" — the salon's own day, not an instant.`,
    );
  }
}

/**
 * `?from=`/`?to=` → a calendar `Period`, or `null` when NEITHER was given.
 *
 * `null` is the load-bearing return: it is what lets a caller add this filter
 * without changing a single thing about the request that does not use it.
 */
export function parseCalendarRange(fromValue: unknown, toValue: unknown): CalendarPeriod | null {
  const noFrom = unset(fromValue);
  const noTo = unset(toValue);
  if (noFrom && noTo) return null;

  if (noFrom || noTo) {
    const given = noFrom ? 'to' : 'from';
    const missing = noFrom ? 'from' : 'to';
    throw badRequest(
      'invalid_range',
      `${given} was given without ${missing}. Name both ends of the window: "${missing}" has no single obvious default, and a range with one open end has no bound to check against the ${MAX_RANGE_DAYS}-day limit.`,
    );
  }

  const from = rangeEnd(String(fromValue).trim(), 'from');
  const to = rangeEnd(String(toValue).trim(), 'to');

  if (utcMidnight(to) < utcMidnight(from)) {
    throw badRequest(
      'invalid_range',
      `from is after to: ${ymd(from)} is later than ${ymd(to)}. Both are inclusive salon-local days, so from must not be later than to.`,
    );
  }

  const days = calendarDays(from, to);
  if (days > MAX_RANGE_DAYS) {
    throw badRequest(
      'invalid_range',
      `from ${ymd(from)} to ${ymd(to)} spans ${days} days; the longest window is ${MAX_RANGE_DAYS} days. Ask for a shorter range.`,
    );
  }

  return { basis: 'calendar', from, to };
}

/** The serialised form. See the header: this round-trips through `parsePeriod`. */
export function periodToken(period: Period): string {
  return period.basis === 'rolling' ? period.preset : `${ymd(period.from)}_${ymd(period.to)}`;
}

/**
 * A window, resolved against a zone and an instant.
 *
 * `[fromInstant, toInstant)` IS HALF-OPEN, like every other window in this API.
 * `toInstant` for a calendar range is the salon's midnight at the START of the
 * day AFTER `toDate` — so 31 March's last transaction is inside the window and 1
 * April's first is not.
 */
export interface PeriodWindow {
  token: string;
  basis: PeriodBasis;
  fromInstant: Date;
  /** EXCLUSIVE. */
  toInstant: Date;
  /** Whole days. Exact for both bases — see `calendarDays`. */
  days: number;
  /**
   * The salon-local calendar days the merchant named, inclusive — and NULL FOR A
   * ROLLING WINDOW, which is the load-bearing half of this pair. A rolling
   * window's ends are instants in the middle of somebody's afternoon; naming
   * dates for them would let a client print a date range over a figure that is
   * not a date range. See the header.
   */
  fromDate: string | null;
  toDate: string | null;
  timezone: string;
}

export function resolveWindow(period: Period, timezone: string, now: Date): PeriodWindow {
  if (period.basis === 'rolling') {
    const days = PERIOD_DAYS[period.preset];
    return {
      token: period.preset,
      basis: 'rolling',
      fromInstant: new Date(now.getTime() - days * 86_400_000),
      toInstant: now,
      days,
      fromDate: null,
      toDate: null,
      timezone,
    };
  }
  return {
    token: periodToken(period),
    basis: 'calendar',
    fromInstant: wallClockInstant(period.from, 0, timezone),
    // Midnight at the end of the last day. `wallClockInstant` normalises the
    // 1440-minute overflow into the next day, so a month or year boundary needs
    // no special case — the same call `services/metrics.ts` makes for `dayEnd`.
    toInstant: wallClockInstant(period.to, MINUTES_PER_DAY, timezone),
    days: calendarDays(period.from, period.to),
    fromDate: ymd(period.from),
    toDate: ymd(period.to),
    timezone,
  };
}

/** The wire form of a window. Instants as ISO text; nothing else changes shape. */
export function serialiseWindow(w: PeriodWindow): {
  token: string;
  basis: PeriodBasis;
  from: string;
  to: string;
  days: number;
  fromDate: string | null;
  toDate: string | null;
  timezone: string;
} {
  return {
    token: w.token,
    basis: w.basis,
    from: w.fromInstant.toISOString(),
    to: w.toInstant.toISOString(),
    days: w.days,
    fromDate: w.fromDate,
    toDate: w.toDate,
    timezone: w.timezone,
  };
}

// ------------------------------------------------------------- comparison ---

/**
 * ==========================================================================
 * `?compare=` — THIS WINDOW AGAINST ANOTHER.               (Aftab, item 9, half 2)
 * ==========================================================================
 * EXPLICIT, NOT IMPLICIT, AND THE VOCABULARY IS `?period=`'s OWN.
 *
 * An implicit comparison — always the window immediately before — is simpler and
 * cannot express the question the merchant actually asked for. "Compare with
 * dates" is what Aftab wrote, and "this June against last June" is the shape of
 * every seasonal question a salon has: Ramadan against the month after, this Eid
 * against the last one. An implicit predecessor can express none of them.
 *
 * So `?compare=` takes a calendar range, spelled exactly the way `?period=`
 * spells one. One grammar, one parser, one set of refusals.
 *
 * `previous` IS THE SUGAR, AND IT IS ONLY OFFERED WHERE IT IS UNAMBIGUOUS.
 * For a rolling period it means the adjacent window of identical length:
 * `30d` compares against `[now-60d, now-30d)`. There is exactly one sensible
 * reading of that and no dates for the client to compute.
 *
 * FOR A CALENDAR PERIOD IT IS REFUSED, and this is the decision in the module
 * worth arguing hardest. What is "previous" to 1–31 March? February, by the
 * name? 29 January – 28 February, by the length? March of last year, by the
 * season? All three are defensible and they are three different answers, and a
 * server that picks one silently is the exact failure this file's header is
 * about — a merchant reading "previous" and getting a window nobody would have
 * named. She already demonstrated she can name dates by naming these; she is
 * asked to name the other two as well. Refusing beats guessing.
 *
 * A PRESET IS REFUSED AS A COMPARISON VALUE. `?period=30d&compare=90d` looks
 * reasonable and is not: every preset window ENDS AT `now`, so comparing one
 * against another compares two windows that share their most recent 30 days and
 * one of their endpoints. The delta is not a period-over-period change, it is an
 * artefact of the overlap. `?compare=7d` against `?period=7d` is worse still —
 * it is the same window, and the delta is zero by construction.
 *
 * NOT GENERALISED FROM `activeMembersDelta`, and this is a correction to the
 * brief this work came in on. `services/metrics.ts`'s `+48 this week` compares
 * the window against THE SAME WINDOW LENGTH ENDED SEVEN DAYS EARLIER — which for
 * `30d` overlaps itself by 23 days, deliberately, because the tile means "48 more
 * members are active now than were a week ago". That is a week-over-week delta of
 * a rolling count, not a period-over-period comparison, and generalising it here
 * would have produced overlapping comparison windows for every report. The two
 * are different statistics and they stay different; see `computeMetrics`.
 */
export type Compare =
  | { readonly kind: 'previous' }
  | { readonly kind: 'range'; readonly from: CalendarDate; readonly to: CalendarDate };

export function parseCompare(value: unknown, period: Period): Compare | null {
  if (value === undefined || value === null || value === '') return null;
  const raw = String(value);

  if (raw === 'previous') {
    if (period.basis !== 'rolling') {
      throw badRequest(
        'invalid_compare',
        'compare=previous is only defined for 7d, 30d and 90d. There is no single "previous" for a calendar range — name the second window as dates, like compare=2025-06-01_2025-06-30.',
      );
    }
    return { kind: 'previous' };
  }

  if ((PERIOD_PRESETS as readonly string[]).includes(raw)) {
    throw badRequest(
      'invalid_compare',
      `compare must not be ${raw}: every rolling window ends now, so comparing against one compares two windows that overlap. Use compare=previous, or name a calendar range like compare=2025-06-01_2025-06-30.`,
    );
  }

  return { kind: 'range', ...parseRange(raw, 'compare') };
}

/**
 * The comparison window, resolved against the SAME `now` as the period window.
 *
 * One `now` for both, threaded from the caller rather than taken twice, because
 * `previous` is defined by subtraction from the period window's own start: two
 * `new Date()` calls milliseconds apart would make the two windows fail to abut.
 *
 * THE TOKEN IS `previous:30d`, NOT A DATE RANGE. A previous rolling window has
 * rolling ends, and rendering them as calendar dates would be the exact
 * mislabelling `fromDate`/`toDate` are null to prevent. It never reaches a
 * filename or an audit line — a comparison is a card figure and is not
 * exportable (see `routes/reports.ts`) — so the token is for display only.
 */
export function resolveCompareWindow(
  compare: Compare,
  period: PeriodWindow,
  timezone: string,
  now: Date,
): PeriodWindow {
  if (compare.kind === 'previous') {
    const span = period.toInstant.getTime() - period.fromInstant.getTime();
    return {
      token: `previous:${period.token}`,
      basis: period.basis,
      fromInstant: new Date(period.fromInstant.getTime() - span),
      toInstant: period.fromInstant,
      days: period.days,
      fromDate: null,
      toDate: null,
      timezone,
    };
  }
  return resolveWindow({ basis: 'calendar', from: compare.from, to: compare.to }, timezone, now);
}

/**
 * ARE THESE TWO WINDOWS THE SAME QUESTION ASKED TWICE?
 *
 * Computed once, on the server, and served — rather than left for each client to
 * derive, which is how two surfaces come to disagree about whether a comparison
 * was fair. A rolling 30 days against calendar June is `false`: same length,
 * different question. Calendar June against calendar May is `false` too — 30 days
 * against 31 — and that is not pedantry, it is a 3% difference in every total
 * before anything about the salon has changed.
 *
 * It is NOT a refusal. A merchant may legitimately want an uneven comparison and
 * the figures are correct for both windows either way; what she may not have is a
 * page that presents one as comparable when it is not. So the server states it
 * and the card carries the caveat.
 */
export function windowsComparable(a: PeriodWindow, b: PeriodWindow): boolean {
  return a.basis === b.basis && a.days === b.days;
}
