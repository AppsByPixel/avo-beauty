/**
 * THE WINDOW VOCABULARY — `services/period.ts`.
 *
 * Three claims are load-bearing enough that the rest of the slice rests on them,
 * and each has a block below:
 *
 *   THE TOKEN ROUND-TRIPS. `parsePeriod(periodToken(p))` is `p`. The filename,
 *       the audit line and the `report_download.period` column are all one string
 *       apiece, so a token that lost information would produce two exports under
 *       one name, two audit rows for two different questions, and a download link
 *       that served a window nobody asked for.
 *
 *   A CALENDAR RANGE IS THE SALON'S DAYS, NOT UTC'S. Asserted as exact instants
 *       against Asia/Kuwait AND against UTC, so the assertion fails if the zone
 *       stops being applied — a spec that only checked "some instant came back"
 *       would pass with the zone dropped entirely.
 *
 *   ROLLING AND CALENDAR STAY TELLABLE APART. `fromDate`/`toDate` are null for a
 *       rolling window, so a client cannot print "1 Mar – 31 Mar" over a figure
 *       that means "the last 30 × 24 hours".
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_RANGE_DAYS,
  parseCalendarRange,
  parseCompare,
  parsePeriod,
  periodToken,
  resolveCompareWindow,
  resolveWindow,
  serialiseWindow,
  windowsComparable,
  type Period,
} from './period';

const KUWAIT = 'Asia/Kuwait';
/** A fixed instant, so every rolling assertion below is arithmetic and not a race. */
const NOW = new Date('2026-09-16T09:00:00.000Z');
const DAY = 86_400_000;

/** The refusal an invalid period raises, as the route would send it. */
function refusal(fn: () => unknown): { error: string; message: string } {
  try {
    fn();
  } catch (e) {
    const err = e as { code?: string; message?: string; body?: { error?: string } };
    return {
      error: (err as { code?: string }).code ?? String((err as { body?: { error?: string } }).body?.error),
      message: String(err.message),
    };
  }
  throw new Error('expected a refusal, got none');
}

describe('the grammar', () => {
  it('absent is 30d, exactly as it was before ranges existed', () => {
    for (const absent of [undefined, null, '']) {
      expect(parsePeriod(absent)).toEqual({ basis: 'rolling', preset: '30d' });
    }
  });

  it('the three presets are rolling', () => {
    expect(parsePeriod('7d')).toEqual({ basis: 'rolling', preset: '7d' });
    expect(parsePeriod('30d')).toEqual({ basis: 'rolling', preset: '30d' });
    expect(parsePeriod('90d')).toEqual({ basis: 'rolling', preset: '90d' });
  });

  it('a pair of dates is a calendar window, and `to` is included', () => {
    expect(parsePeriod('2026-03-01_2026-03-31')).toEqual({
      basis: 'calendar',
      from: { year: 2026, month: 3, day: 1 },
      to: { year: 2026, month: 3, day: 31 },
    });
  });

  it('a single day is a legal window', () => {
    const p = parsePeriod('2026-03-01_2026-03-01');
    expect(resolveWindow(p, KUWAIT, NOW).days).toBe(1);
  });
});

describe('what it refuses, and whether the message names the fix', () => {
  it('a word that is not a window', () => {
    const r = refusal(() => parsePeriod('this-month'));
    expect(r.error).toBe('invalid_period');
    expect(r.message).toContain('2026-03-01_2026-03-31');
  });

  /**
   * THE REGEX IS HAPPY WITH THIS AND THE CALENDAR IS NOT. `parseDate`'s round
   * trip is what catches it, and its `invalid_date` code is re-wrapped so one
   * parameter answers with one error code.
   */
  it('a date that does not exist', () => {
    const r = refusal(() => parsePeriod('2026-02-31_2026-03-31'));
    expect(r.error).toBe('invalid_period');
    expect(r.message).toContain('2026-02-31');
  });

  it('a range that runs backwards', () => {
    const r = refusal(() => parsePeriod('2026-03-31_2026-03-01'));
    expect(r.error).toBe('invalid_period');
    expect(r.message).toContain('later than');
  });

  it('a range longer than a year', () => {
    const r = refusal(() => parsePeriod('2020-01-01_2026-01-01'));
    expect(r.error).toBe('invalid_period');
    expect(r.message).toContain(String(MAX_RANGE_DAYS));
  });

  it('366 days is allowed and 367 is not — the boundary, not near it', () => {
    // 2028 is a leap year: 1 Jan to 31 Dec inclusive is 366 days.
    expect(resolveWindow(parsePeriod('2028-01-01_2028-12-31'), KUWAIT, NOW).days).toBe(366);
    expect(refusal(() => parsePeriod('2028-01-01_2029-01-01')).message).toContain('367 days');
  });

  /**
   * THE FILENAME AND THE CONTENT-DISPOSITION HEADER, DEFENDED AT THE PARSER.
   *
   * `reportFilename` strips the branch tag and does NOT strip the period token,
   * because the token is built from parsed integers. This is the other half of
   * that argument: nothing that is not two dates can become a token at all.
   */
  it('a payload dressed as a range never becomes a token', () => {
    for (const hostile of [
      '2026-03-01_2026-03-31"; rm -rf /',
      '2026-03-01_2026-03-31\r\nX-Evil: 1',
      '../../etc/passwd',
      '2026-03-01_2026-03-31; DROP TABLE salon',
    ]) {
      expect(refusal(() => parsePeriod(hostile)).error).toBe('invalid_period');
    }
  });
});

describe('the token round-trips, which is what makes it safe to store and to name a file', () => {
  const shapes = ['7d', '30d', '90d', '2026-03-01_2026-03-31', '2025-06-01_2025-06-30', '2026-01-01_2026-01-01'];

  it('parsePeriod(periodToken(p)) === p, for every shape the column can hold', () => {
    for (const token of shapes) {
      const p = parsePeriod(token);
      expect(periodToken(p)).toBe(token);
      expect(parsePeriod(periodToken(p))).toEqual(p);
    }
  });

  /**
   * THE PROPERTY THE FILENAME ACTUALLY NEEDS, stated as itself rather than
   * inferred from the round trip: distinct windows have distinct tokens, so two
   * exports of two different questions cannot land in a downloads folder under
   * one name.
   */
  it('distinct windows have distinct tokens', () => {
    const tokens = shapes.map((t) => periodToken(parsePeriod(t)));
    expect(new Set(tokens).size).toBe(shapes.length);
  });

  it('the token is filename-safe by construction, not by sanitising', () => {
    for (const token of shapes) {
      expect(periodToken(parsePeriod(token))).toMatch(/^[0-9d_-]+$/);
    }
  });
});

describe('a rolling window', () => {
  const win = resolveWindow(parsePeriod('30d'), KUWAIT, NOW);

  it('is [now - N days, now), which is what it always was', () => {
    expect(win.fromInstant.toISOString()).toBe(new Date(NOW.getTime() - 30 * DAY).toISOString());
    expect(win.toInstant.toISOString()).toBe(NOW.toISOString());
    expect(win.days).toBe(30);
  });

  /**
   * THE HALF OF THE TYPE THAT DOES THE WORK. A rolling window's ends are instants
   * in the middle of somebody's afternoon. Naming dates for them would let a card
   * print a date range over a figure that is not one.
   */
  it('names no calendar dates, so none can be rendered', () => {
    expect(win.fromDate).toBeNull();
    expect(win.toDate).toBeNull();
    expect(win.basis).toBe('rolling');
  });

  it('does not depend on the zone — the same instants in Kuwait and in UTC', () => {
    const utc = resolveWindow(parsePeriod('30d'), 'UTC', NOW);
    expect(utc.fromInstant.toISOString()).toBe(win.fromInstant.toISOString());
    expect(utc.toInstant.toISOString()).toBe(win.toInstant.toISOString());
  });
});

describe("a calendar window is the SALON's days", () => {
  const march = resolveWindow(parsePeriod('2026-03-01_2026-03-31'), KUWAIT, NOW);

  /**
   * THE EXACT INSTANTS, BOTH ENDS. Kuwait is UTC+3 and has no DST, so 1 March
   * begins at 21:00Z on 29 February — except 2026 is not a leap year, so on 28
   * February. The upper bound is 1 April's midnight, exclusive.
   */
  it('begins and ends at the salon’s midnight, not UTC’s', () => {
    expect(march.fromInstant.toISOString()).toBe('2026-02-28T21:00:00.000Z');
    expect(march.toInstant.toISOString()).toBe('2026-03-31T21:00:00.000Z');
  });

  /**
   * THE NEGATIVE CONTROL. Without it the block above would pass just as happily
   * against an implementation that ignored the zone and used UTC midnights — the
   * instants would be wrong by three hours and nothing here would say so.
   */
  it('and the same range in UTC is three hours away, so the zone is doing the work', () => {
    const utc = resolveWindow(parsePeriod('2026-03-01_2026-03-31'), 'UTC', NOW);
    expect(utc.fromInstant.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(utc.toInstant.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(utc.fromInstant.getTime() - march.fromInstant.getTime()).toBe(3 * 3_600_000);
  });

  it('is half-open, so 31 March 23:59 is in and 1 April 00:00 is not', () => {
    const lastMoment = new Date('2026-03-31T20:59:59.999Z'); // 23:59:59.999 Kuwait
    const firstOfApril = new Date('2026-03-31T21:00:00.000Z'); // 00:00 Kuwait, 1 April
    expect(lastMoment.getTime() < march.toInstant.getTime()).toBe(true);
    expect(firstOfApril.getTime() < march.toInstant.getTime()).toBe(false);
  });

  it('counts whole calendar days, and names them', () => {
    expect(march.days).toBe(31);
    expect(march.fromDate).toBe('2026-03-01');
    expect(march.toDate).toBe('2026-03-31');
    expect(march.basis).toBe('calendar');
  });

  /**
   * THE DAY COUNT COMES FROM THE DATES, NOT FROM THE INSTANT SPAN. In a DST zone
   * a calendar month is not a whole number of 24-hour days, so a span-derived
   * count would be 30.958333 for this window. Kuwait would never have shown it.
   */
  it('counts days correctly in a zone that actually has daylight saving', () => {
    // 29 March 2026 is the European spring-forward: this month is 23 hours short.
    const w = resolveWindow(parsePeriod('2026-03-01_2026-03-31'), 'Europe/London', NOW);
    expect(w.days).toBe(31);
    expect(w.toInstant.getTime() - w.fromInstant.getTime()).toBe(31 * DAY - 3_600_000);
  });
});

describe('the wire form', () => {
  it('serialises instants as ISO and changes nothing else', () => {
    const w = resolveWindow(parsePeriod('2026-03-01_2026-03-31'), KUWAIT, NOW);
    expect(serialiseWindow(w)).toEqual({
      token: '2026-03-01_2026-03-31',
      basis: 'calendar',
      from: '2026-02-28T21:00:00.000Z',
      to: '2026-03-31T21:00:00.000Z',
      days: 31,
      fromDate: '2026-03-01',
      toDate: '2026-03-31',
      timezone: 'Asia/Kuwait',
    });
  });
});

describe('?compare= — explicit, and refused where it would have to guess', () => {
  const rolling: Period = parsePeriod('30d');
  const calendar: Period = parsePeriod('2026-03-01_2026-03-31');

  it('absent is no comparison', () => {
    for (const absent of [undefined, null, '']) {
      expect(parseCompare(absent, rolling)).toBeNull();
    }
  });

  it('a calendar range compares against anything — "this June against last June"', () => {
    expect(parseCompare('2025-06-01_2025-06-30', calendar)).toEqual({
      kind: 'range',
      from: { year: 2025, month: 6, day: 1 },
      to: { year: 2025, month: 6, day: 30 },
    });
  });

  it('previous is sugar for a rolling period', () => {
    expect(parseCompare('previous', rolling)).toEqual({ kind: 'previous' });
  });

  /**
   * THE DECISION WORTH THE MOST ARGUMENT. "Previous" to 1–31 March is February by
   * name, 29 Jan – 28 Feb by length, or March last year by season. Three
   * defensible answers means a server that picks one silently hands a merchant a
   * window nobody named.
   */
  it('and is refused for a calendar period, naming the fix', () => {
    const r = refusal(() => parseCompare('previous', calendar));
    expect(r.error).toBe('invalid_compare');
    expect(r.message).toContain('compare=2025-06-01_2025-06-30');
  });

  /**
   * Every preset ends at `now`, so a preset compared against a preset compares
   * two windows sharing an endpoint and most of their length.
   */
  it('a preset is refused as a comparison value, because the windows would overlap', () => {
    for (const preset of ['7d', '30d', '90d']) {
      const r = refusal(() => parseCompare(preset, rolling));
      expect(r.error).toBe('invalid_compare');
      expect(r.message).toContain('overlap');
    }
  });

  it('a malformed compare refuses like a malformed period', () => {
    expect(refusal(() => parseCompare('last-month', rolling)).error).toBe('invalid_period');
  });
});

describe('the comparison window', () => {
  const period = resolveWindow(parsePeriod('30d'), KUWAIT, NOW);
  const prev = resolveCompareWindow({ kind: 'previous' }, period, KUWAIT, NOW);

  it('abuts the period window exactly, and does not overlap it', () => {
    expect(prev.toInstant.getTime()).toBe(period.fromInstant.getTime());
    expect(prev.toInstant.getTime() - prev.fromInstant.getTime()).toBe(
      period.toInstant.getTime() - period.fromInstant.getTime(),
    );
  });

  /**
   * NOT `activeMembersDelta`. The Overview tile compares against the same window
   * ended SEVEN DAYS earlier, which at `30d` overlaps itself by 23 days on
   * purpose. This one does not overlap at all, and the two must not be confused
   * for one another — see services/period.ts § Compare.
   */
  it('is a different statistic from the Overview’s +48 this week', () => {
    const overviewPrior = new Date(period.toInstant.getTime() - 7 * DAY);
    expect(overviewPrior.getTime()).toBeGreaterThan(prev.toInstant.getTime());
  });

  it('names no calendar dates, because a previous rolling window has none', () => {
    expect(prev.fromDate).toBeNull();
    expect(prev.token).toBe('previous:30d');
  });

  it('a compared calendar range resolves in the salon’s zone too', () => {
    const june = resolveWindow(parsePeriod('2026-06-01_2026-06-30'), KUWAIT, NOW);
    const lastJune = resolveCompareWindow(
      { kind: 'range', from: { year: 2025, month: 6, day: 1 }, to: { year: 2025, month: 6, day: 30 } },
      june,
      KUWAIT,
      NOW,
    );
    expect(lastJune.fromInstant.toISOString()).toBe('2025-05-31T21:00:00.000Z');
    expect(lastJune.token).toBe('2025-06-01_2025-06-30');
  });
});

describe('comparable — the server says whether the two windows are one question asked twice', () => {
  const june2026 = resolveWindow(parsePeriod('2026-06-01_2026-06-30'), KUWAIT, NOW);
  const june2025 = resolveWindow(parsePeriod('2025-06-01_2025-06-30'), KUWAIT, NOW);
  const may2026 = resolveWindow(parsePeriod('2026-05-01_2026-05-31'), KUWAIT, NOW);
  const rolling30 = resolveWindow(parsePeriod('30d'), KUWAIT, NOW);

  it('June against June is comparable', () => {
    expect(windowsComparable(june2026, june2025)).toBe(true);
  });

  /** 30 days against 31 is a 3% difference before anything about the salon changed. */
  it('June against May is not — different lengths', () => {
    expect(windowsComparable(june2026, may2026)).toBe(false);
  });

  /**
   * THE CASE THE BRIEF NAMED. A rolling 30 days and calendar June are both 30
   * days long and are not the same question, and nothing but `basis` separates
   * them.
   */
  it('a rolling 30 days against calendar June is not, despite both being 30 days', () => {
    expect(rolling30.days).toBe(june2026.days);
    expect(windowsComparable(rolling30, june2026)).toBe(false);
  });

  it('and a previous window is comparable with its own period', () => {
    expect(windowsComparable(rolling30, resolveCompareWindow({ kind: 'previous' }, rolling30, KUWAIT, NOW))).toBe(true);
  });
});


/**
 * ==========================================================================
 * `?from=` / `?to=` — THE SECOND GRAMMAR, AND WHAT IT HAS TO GUARANTEE
 * ==========================================================================
 * `GET /salons/{id}/bookings` takes this pair so lane C's week grid can ask for
 * a week instead of walking the cursor back through every booking newer than
 * one. Four claims are load-bearing:
 *
 *   NEITHER GIVEN IS `null`, NOT A DEFAULT WINDOW. This is what makes the
 *       parameter additive: `null` is the caller's signal to add no predicate at
 *       all, and a parser that quietly returned "this month" would change every
 *       existing request on the endpoint.
 *
 *   IT PRODUCES THE SAME `Period` `?period=` PRODUCES, so `resolveWindow` is the
 *       only place calendar dates become instants. Asserted by resolving a
 *       `?from=`/`?to=` range and a `?period=` token to the SAME window — if the
 *       two grammars ever stop meaning the same thing, that is where it shows.
 *
 *   EVERY REFUSAL NAMES ITS FIELD. Two parameters, one concept: a client must be
 *       able to put the 400 under the right input, which `invalid_range` alone
 *       does not tell it.
 *
 *   THE CEILING IS STATED, NOT IMPLIED. A refusal that says "invalid" leaves the
 *       caller to binary-search the limit.
 */
/** The range, as a `Period`. Narrows away the `null` that "neither given" returns. */
function range(from: string, to: string): Period {
  const r = parseCalendarRange(from, to);
  if (!r) throw new Error('expected a range, got null');
  return r;
}

describe('?from= / ?to= — a calendar range as two parameters', () => {
  it('neither given is null — the signal that adds no filter at all', () => {
    for (const absent of [undefined, null, '', '   ']) {
      expect(parseCalendarRange(absent, absent)).toBeNull();
    }
  });

  it('both given is a calendar period, inclusive at both ends', () => {
    expect(parseCalendarRange('2026-03-08', '2026-03-14')).toEqual({
      basis: 'calendar',
      from: { year: 2026, month: 3, day: 8 },
      to: { year: 2026, month: 3, day: 14 },
    });
  });

  it('one day is a legal window — a grid may ask for a single column', () => {
    expect(resolveWindow(range('2026-03-08', '2026-03-08'), KUWAIT, NOW).days).toBe(1);
  });

  /**
   * THE REUSE, ASSERTED RATHER THAN ASSUMED. The route derives no instants of its
   * own; it hands this `Period` to the same `resolveWindow` the reports use. If
   * somebody later gives the list its own date maths, these two windows stop
   * being equal and this spec says so.
   */
  it('is the SAME window the one-token grammar resolves, instant for instant', () => {
    const viaPair = resolveWindow(range('2026-03-01', '2026-03-31'), KUWAIT, NOW);
    const viaToken = resolveWindow(parsePeriod('2026-03-01_2026-03-31'), KUWAIT, NOW);
    expect(viaPair).toEqual(viaToken);
  });

  /**
   * THE OPENNESS, STATED AS INSTANTS. Half-open `[from 00:00, to+1 00:00)` in the
   * salon's zone — `resolveWindow`'s own convention — which is what makes "Sun to
   * Sat inclusive" true for a merchant: the last day's 23:59 is in.
   */
  it('is half-open in the SALON’s zone, so `to` 23:59 is in and the next 00:00 is not', () => {
    const week = resolveWindow(range('2026-03-08', '2026-03-14'), KUWAIT, NOW);
    // Kuwait is UTC+3: 8 March begins at 21:00Z on 7 March.
    expect(week.fromInstant.toISOString()).toBe('2026-03-07T21:00:00.000Z');
    expect(week.toInstant.toISOString()).toBe('2026-03-14T21:00:00.000Z');

    const lastMoment = new Date('2026-03-14T20:59:59.999Z'); // 23:59:59.999 Kuwait, 14 March
    const nextMidnight = new Date('2026-03-14T21:00:00.000Z'); // 00:00 Kuwait, 15 March
    expect(lastMoment.getTime() < week.toInstant.getTime()).toBe(true);
    expect(nextMidnight.getTime() < week.toInstant.getTime()).toBe(false);
  });

  /**
   * THE NEGATIVE CONTROL, for the same reason the `?period=` block has one: every
   * assertion above would pass against an implementation that ignored the zone.
   */
  it('and the same pair in UTC is three hours away, so the zone is doing the work', () => {
    const utc = resolveWindow(range('2026-03-08', '2026-03-14'), 'UTC', NOW);
    expect(utc.fromInstant.toISOString()).toBe('2026-03-08T00:00:00.000Z');
    expect(utc.toInstant.toISOString()).toBe('2026-03-15T00:00:00.000Z');
  });
});

describe('what ?from= / ?to= refuses, and whether the message names the field', () => {
  it('from without to, and to without from — both, by name', () => {
    const noTo = refusal(() => parseCalendarRange('2026-03-08', undefined));
    expect(noTo.error).toBe('invalid_range');
    expect(noTo.message).toContain('from was given without to');

    const noFrom = refusal(() => parseCalendarRange('', '2026-03-14'));
    expect(noFrom.error).toBe('invalid_range');
    expect(noFrom.message).toContain('to was given without from');
  });

  it('an unparseable date names WHICH of the two it is', () => {
    const badFrom = refusal(() => parseCalendarRange('8 March', '2026-03-14'));
    expect(badFrom.error).toBe('invalid_range');
    expect(badFrom.message).toContain('from is not a calendar date');
    expect(badFrom.message).toContain('8 March');

    const badTo = refusal(() => parseCalendarRange('2026-03-08', '2026-03-14T00:00:00Z'));
    expect(badTo.error).toBe('invalid_range');
    expect(badTo.message).toContain('to is not a calendar date');
  });

  /** The round trip in `parseDate`, reached through the new wrapper. */
  it('a date the regex likes and the calendar does not', () => {
    const r = refusal(() => parseCalendarRange('2026-02-31', '2026-03-14'));
    expect(r.error).toBe('invalid_range');
    expect(r.message).toContain('2026-02-31');
  });

  it('from after to', () => {
    const r = refusal(() => parseCalendarRange('2026-03-14', '2026-03-08'));
    expect(r.error).toBe('invalid_range');
    expect(r.message).toContain('from is after to');
    expect(r.message).toContain('2026-03-14');
  });

  /**
   * THE CEILING, AND THE REFUSAL SAYS WHAT IT IS. `from=2000-01-01` behind a
   * permission check is a full scan of `booking`; "invalid" would leave the
   * client to discover the limit by bisection.
   */
  it('a range longer than a year states the span AND the limit', () => {
    const r = refusal(() => parseCalendarRange('2000-01-01', '2026-03-14'));
    expect(r.error).toBe('invalid_range');
    expect(r.message).toContain(String(MAX_RANGE_DAYS));
    expect(r.message).toMatch(/spans \d+ days/);
  });

  it('366 days is allowed and 367 is not — the boundary, not near it', () => {
    expect(resolveWindow(range('2028-01-01', '2028-12-31'), KUWAIT, NOW).days).toBe(366);
    expect(refusal(() => parseCalendarRange('2028-01-01', '2029-01-01')).message).toContain('367 days');
  });

  it('nothing that is not a calendar date gets through either end', () => {
    for (const hostile of ['2026-03-08"; DROP TABLE booking', '../../etc/passwd', '2026-03-08\r\nX-Evil: 1']) {
      expect(refusal(() => parseCalendarRange(hostile, '2026-03-14')).error).toBe('invalid_range');
      expect(refusal(() => parseCalendarRange('2026-03-08', hostile)).error).toBe('invalid_range');
    }
  });
});
