// @vitest-environment jsdom

/**
 * Merchant → Overview → Gross by day.
 *
 * NEW WORK, AND THE FIRST CHART ON ANY AVO SURFACE. `design/AVO Merchant
 * Dashboard.dc.html` draws none — its only matches for "graph" are inside the
 * word "Typography" — so there is no artboard to check this against and every
 * rule it keeps is one `routes/salesTrendRules.ts` argues in prose. These are
 * the assertions that make the prose binding.
 *
 * WHY IT RENDERS RATHER THAN READS THE SOURCE: `earningsByBranchRender.test.tsx`
 * § WHY THIS FILE RENDERS, verbatim in its application here. The two rules most
 * worth breaking on this card — which DAYS end up as bars, and what the card
 * CLAIMS about scope — are both invisible in source text. A `seriesFrom` that
 * drops a quiet Monday and a `seriesFrom` that keeps it are four characters
 * apart and read identically; only the tree says how many bars there are.
 *
 * Cleanup is manual — no `globals: true` in this project, so
 * `@testing-library/react` registers no `afterEach(cleanup)` of its own.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { fils, formatFils } from '@avo/types';
import {
  LoadedTrend,
  TrendCard,
  TrendChart,
  TrendFoot,
  TrendSkeleton,
  TrendUnavailable,
  UnusableZone,
  WindowUnknown,
  dayLabel,
  pointLabel,
} from './SalesTrend.js';
import {
  TREND_DAYS,
  barPermille,
  enumerateDays,
  localDate,
  peakFils,
  seriesFrom,
  shiftDate,
  totalTransactions,
  trendScope,
  trendWindow,
  type DayPoint,
} from './salesTrendRules.js';
import { ApiError } from '../api/client.js';
import type { Report, ReportWindow } from '../api/reports.js';

afterEach(cleanup);

/* ------------------------------------------------------------- fixtures -- */

/**
 * The window this card asks for, as the server resolves it: fourteen whole
 * salon-local days, both ends inclusive, ending YESTERDAY. The instants are
 * Kuwait midnights (UTC+3), which is what makes `from`/`to` three hours before
 * the dates they bracket.
 */
const FORTNIGHT: ReportWindow = {
  token: '2026-09-13_2026-09-26',
  basis: 'calendar',
  from: '2026-09-12T21:00:00.000Z',
  to: '2026-09-26T21:00:00.000Z',
  days: 14,
  fromDate: '2026-09-13',
  toDate: '2026-09-26',
  timezone: 'Asia/Kuwait',
};

/** `7d` as `services/period.ts` resolves it — rolling, and therefore dateless. */
const ROLLING_7: ReportWindow = {
  token: '7d',
  basis: 'rolling',
  from: '2026-09-19T09:00:00.000Z',
  to: '2026-09-26T09:00:00.000Z',
  days: 7,
  fromDate: null,
  toDate: null,
  timezone: 'Asia/Kuwait',
};

/** The four columns `services/reports.ts § sales` sends, verbatim. */
const COLUMNS: Report['columns'] = [
  { header: 'Date', key: 'date', type: 'text' },
  { header: 'Transactions', key: 'transactions', type: 'int' },
  { header: 'Gross KD', key: 'grossFils', type: 'money' },
  { header: 'Branch', key: 'branch', type: 'text' },
];

function row(
  date: string,
  transactions: number,
  grossFils: number,
  branch = 'Salmiya',
): Record<string, string | number | null> {
  return { date, transactions, grossFils, branch };
}

function report(
  rows: Report['rows'],
  over: Partial<Report> = {},
): Report {
  return {
    kind: 'sales',
    title: 'Sales summary',
    period: FORTNIGHT.token,
    window: FORTNIGHT,
    comparison: null,
    branchId: 'all',
    columns: COLUMNS,
    rows,
    stat: { key: 'grossFils', label: 'KD gross', value: 0, type: 'money' },
    rowCount: rows.length,
    ...over,
  };
}

/**
 * THE SHAPE THE WIRE ACTUALLY HAS, and every hazard in it at once.
 *
 *   NEWEST FIRST      `ORDER BY 1 DESC` — drawn as it arrives, time runs
 *                     backwards.
 *   TWO ROWS PER DAY  `GROUP BY (day, branch)` — 15 Sep is two rows, and a bar
 *                     per row makes one Tuesday into two days.
 *   DAYS MISSING      a `GROUP BY` over transactions is not a calendar. Only
 *                     four of the fortnight's fourteen days settled anything.
 */
const WIRE: Report['rows'] = [
  row('2026-09-26', 4, 40_000, 'Salmiya'),
  row('2026-09-20', 9, 90_000, 'Salmiya'),
  row('2026-09-15', 3, 30_000, 'Salmiya'),
  row('2026-09-15', 7, 70_000, 'Kuwait City'),
  row('2026-09-13', 1, 10_000, 'Salmiya'),
];

/** Every bar, in document order. */
function bars(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('.trend__bar')];
}

/** Every day's accessible sentence, in document order. */
function labels(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.trend__day .avo-sr-only')].map(
    (n) => n.textContent ?? '',
  );
}

/* ================================================================ the rules */

describe('the window is fourteen COMPLETE days, in the salon’s own zone', () => {
  /**
   * THE ZONE IS LOAD-BEARING AND THIS INSTANT PROVES IT. 21:30Z on 26 September
   * is already 00:30 on the 27th in Kuwait, so a browser-zone or UTC
   * implementation answers "today is the 26th" and picks a window one day
   * short. Every assertion about which days are asked for rests on this.
   */
  const LATE = new Date('2026-09-26T21:30:00.000Z');

  it('ends yesterday in Kuwait, not yesterday in UTC', () => {
    expect(localDate(LATE, 'Asia/Kuwait')).toBe('2026-09-27');
    expect(localDate(LATE, 'UTC')).toBe('2026-09-26');

    const w = trendWindow('Asia/Kuwait', LATE);
    /* Fourteen days ending on the 26th INCLUSIVE begins on the 13th, not the
       14th — the off-by-one this line was written with the first time. */
    expect(w).toEqual({ from: '2026-09-13', to: '2026-09-26' });
  });

  it('spans exactly TREND_DAYS days, both ends inclusive', () => {
    const w = trendWindow('Asia/Kuwait', LATE)!;
    expect(enumerateDays(w.from, w.to)).toHaveLength(TREND_DAYS);
  });

  /**
   * TODAY IS NOT IN IT, AND THAT IS THE WHOLE POINT OF "COMPLETE". A window
   * ending today puts a part-day on the right-hand end, and at ten in the
   * morning that part-day is a slump the salon did not have.
   */
  it('excludes today', () => {
    const w = trendWindow('Asia/Kuwait', LATE)!;
    expect(enumerateDays(w.from, w.to)).not.toContain('2026-09-27');
  });

  it('returns null rather than falling back to the browser on a zone Intl refuses', () => {
    expect(localDate(LATE, 'Mars/Olympus_Mons')).toBeNull();
    expect(trendWindow('Mars/Olympus_Mons', LATE)).toBeNull();
  });

  it('steps across month and year boundaries without a zone conversion', () => {
    expect(shiftDate('2026-10-01', -1)).toBe('2026-09-30');
    expect(shiftDate('2027-01-01', -1)).toBe('2026-12-31');
    /* 2028 is a leap year; the 29th exists and must not be skipped. */
    expect(shiftDate('2028-03-01', -1)).toBe('2028-02-29');
  });

  it('enumerates nothing for a reversed range rather than looping', () => {
    expect(enumerateDays('2026-09-26', '2026-09-13')).toEqual([]);
  });
});

describe('the series is one point per DAY, not one per wire row', () => {
  it('folds a day’s branch rows into one point and keeps time running forwards', () => {
    const series = seriesFrom(report(WIRE));
    expect(series.ok).toBe(true);
    if (!series.ok) return;

    expect(series.days).toHaveLength(TREND_DAYS);
    expect(series.days.map((d) => d.date)).toEqual(enumerateDays('2026-09-13', '2026-09-26'));

    /* 15 Sep arrived as two branch rows; it is ONE bar carrying both. */
    const fifteenth = series.days.find((d) => d.date === '2026-09-15')!;
    expect(fifteenth.grossFils).toBe(100_000);
    expect(fifteenth.transactions).toBe(10);
  });

  /**
   * THE QUIET DAY. Ten of the fourteen never appear in `rows` at all, and a
   * chart of only the days that ARE there shows a fortnight in four bars while
   * the caption names fourteen days.
   */
  it('fills every day the window names that the rows never mention', () => {
    const series = seriesFrom(report(WIRE));
    if (!series.ok) return;
    const quiet = series.days.filter((d) => d.grossFils === 0);
    expect(quiet).toHaveLength(TREND_DAYS - 4);
    expect(quiet.every((d) => d.transactions === 0)).toBe(true);
  });

  /**
   * A row the window does not name is KEPT. It should not happen — the server
   * queried the window it echoes — but a silent `continue` takes real money off
   * a revenue chart to preserve a tidy axis.
   */
  it('keeps a row from outside the echoed window rather than dropping its money', () => {
    const series = seriesFrom(report([...WIRE, row('2026-09-12', 2, 20_000)]));
    if (!series.ok) return;
    expect(series.days).toHaveLength(TREND_DAYS + 1);
    expect(series.days[0]).toMatchObject({ date: '2026-09-12', grossFils: 20_000 });
  });

  it('refuses a rolling window rather than inventing days for it', () => {
    expect(seriesFrom(report(WIRE, { window: ROLLING_7 }))).toEqual({
      ok: false,
      reason: 'rolling-window',
    });
  });

  /**
   * MONEY STAYS INTEGER FILS (#1). `parseReport` validates `stat.value` and
   * CASTS `rows`, so this is the first place a row's money is checked at all —
   * and `fils()` throws on a fraction, which mid-render is a blank card.
   */
  it('refuses a fractional gross instead of letting fils() throw mid-paint', () => {
    expect(seriesFrom(report([row('2026-09-15', 1, 10_000.5)]))).toEqual({
      ok: false,
      reason: 'fractional-fils',
    });
  });

  /**
   * A REVERSED WINDOW IS A SENTENCE, NOT A TYPEERROR. `enumerateDays` refuses
   * to loop on it and correctly returns nothing, which used to leave the empty
   * state dereferencing `days[0].date` on a blank card. The window's own dates
   * ride the result so the copy has something to name.
   */
  it('survives a window whose end precedes its start, and still names it', () => {
    const reversed = report([], {
      window: { ...FORTNIGHT, fromDate: '2026-09-26', toDate: '2026-09-13' },
    });
    const series = seriesFrom(reversed);
    expect(series.ok).toBe(true);
    if (series.ok) expect(series.days).toEqual([]);

    render(<LoadedTrend report={reversed} selected="all" />);
    expect(screen.getByText(/Nothing settled between 26 Sep 2026 and 13 Sep 2026/)).toBeTruthy();
  });

  it('refuses a gross outside the safe integer range', () => {
    expect(seriesFrom(report([row('2026-09-15', 1, Number.MAX_SAFE_INTEGER + 2)]))).toEqual({
      ok: false,
      reason: 'fractional-fils',
    });
  });
});

describe('the bar height is an integer ratio, and no float touches the money', () => {
  it('is a permille of the tallest day', () => {
    expect(barPermille(100_000, 100_000)).toBe(1000);
    expect(barPermille(40_000, 100_000)).toBe(400);
    expect(barPermille(0, 100_000)).toBe(0);
  });

  it('is an integer for every day of a real series', () => {
    const series = seriesFrom(report(WIRE));
    if (!series.ok) return;
    const peak = peakFils(series.days);
    for (const day of series.days) {
      expect(Number.isInteger(barPermille(day.grossFils, peak))).toBe(true);
    }
  });

  /** A fortnight in which nothing settled is a real fortnight, not a crash. */
  it('returns zero rather than dividing by a zero peak', () => {
    expect(barPermille(0, 0)).toBe(0);
    expect(peakFils([])).toBe(0);
  });

  it('carries the peak as Fils, so the axis formats through the one formatter', () => {
    const series = seriesFrom(report(WIRE));
    if (!series.ok) return;
    const peak = peakFils(series.days);
    expect(peak).toBe(100_000);
    expect(formatFils(peak)).toBe('100.000');
  });

  it('counts transactions as a count and never as money', () => {
    const series = seriesFrom(report(WIRE));
    if (!series.ok) return;
    expect(totalTransactions(series.days)).toBe(24);
  });
});

/* ================================================================ the scope */

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE RULE WHOSE FAILURE IS SILENT — a merchant on Salmiya reading a salon-wide
 * chart as Salmiya's, with nothing on screen to say otherwise.
 * ═══════════════════════════════════════════════════════════════════════════
 * The chart is salon-wide always (`salesTrendRules.ts § trendScope` argues it:
 * `sales` carries no `assumedGrossFils`, so a per-branch shape cannot be
 * qualified), so the ONLY thing standing between that decision and a false
 * claim is the qualifier appearing when the tiles above are narrower.
 */
describe('§ the scope rule', () => {
  it('says nothing when the whole screen is salon-wide', () => {
    expect(trendScope('all', report(WIRE))).toEqual({ kind: 'salon-wide' });
  });

  it('says "wider than the tiles" when a branch is applied above', () => {
    expect(trendScope('BR-SAL', report(WIRE))).toEqual({ kind: 'wider-than-tiles' });
  });

  /**
   * READ OFF THE SERVER'S ECHO, NOT THE REQUEST. This card asks for `all`; a
   * workspace that answers with one branch anyway has given us that branch's
   * bars, and a card headed "All branches" over them would be a lie this lane
   * wrote rather than one it inherited. `Overview.tsx § WHAT THE FIGURES
   * ACTUALLY COVER` makes the same argument for the tiles.
   */
  it('reports a narrowing the card never asked for, from the echo', () => {
    expect(trendScope('all', report(WIRE, { branchId: 'BR-KWC' }))).toEqual({
      kind: 'narrowed',
      branchId: 'BR-KWC',
    });
    /* And it outranks the qualifier — the bars are not every branch's. */
    expect(trendScope('BR-KWC', report(WIRE, { branchId: 'BR-KWC' }))).toEqual({
      kind: 'narrowed',
      branchId: 'BR-KWC',
    });
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════
   * THE MUTATION, RUN AND RECORDED
   * ═══════════════════════════════════════════════════════════════════════
   * Deleting the middle line of `trendScope` —
   *
   *     if (selected !== ALL_BRANCHES) return { kind: 'wider-than-tiles' };
   *
   * — leaves a function that still typechecks, still returns a `TrendScope`,
   * still reports a narrowing, and still passes every OTHER case in this file.
   * What it does is remove the "All branches" qualifier from a screen with a
   * branch applied: correct bars under a heading that now silently means
   * Salmiya. Run against that mutant, the two assertions below fail and nothing
   * else in this suite does — which is what makes them the pin rather than
   * decoration.
   */
  it('MUTATION PIN: the qualifier is rendered exactly when the tiles are narrower', () => {
    const { container, unmount } = render(<LoadedTrend report={report(WIRE)} selected="BR-SAL" />);
    expect(screen.getByText('All branches')).toBeTruthy();
    expect(container.querySelector('.overview__card-scope')).toBeTruthy();
    unmount();

    const wide = render(<LoadedTrend report={report(WIRE)} selected="all" />);
    expect(wide.container.querySelector('.overview__card-scope')).toBeNull();
    expect(screen.queryByText('All branches')).toBeNull();
  });

  it('a narrowed answer says so in words, and does not also claim all branches', () => {
    const { container } = render(
      <LoadedTrend report={report(WIRE, { branchId: 'BR-KWC' })} selected="all" />,
    );
    expect(container.querySelector('.overview__card-scope')).toBeNull();
    expect(
      screen.getByText(/narrowed the chart to one branch rather than the whole salon/),
    ).toBeTruthy();
  });

  it('says nothing about narrowing when the answer was salon-wide', () => {
    render(<TrendFoot scope={{ kind: 'salon-wide' }} />);
    expect(screen.queryByText(/narrowed the chart/)).toBeNull();
    /* The complete-days note is standing prose and is always there. */
    expect(screen.getByText(/Complete days only/)).toBeTruthy();
  });
});

/* ============================================================== the drawing */

describe('the chart draws the series it was given', () => {
  it('draws one bar per day, in the order the days run', () => {
    const { container } = render(<LoadedTrend report={report(WIRE)} selected="all" />);
    expect(bars(container)).toHaveLength(TREND_DAYS);
    expect(labels(container)[0]).toContain('13 Sep');
    expect(labels(container)[TREND_DAYS - 1]).toContain('26 Sep');
  });

  /**
   * THE HEIGHTS ARE THE FIGURES. 15 Sep is the tallest at 100.000 (its two
   * branch rows folded), 20 Sep is 90% of it, 26 Sep 40%, 13 Sep 10%, and the
   * ten quiet days are flat.
   */
  it('scales every bar against the tallest day', () => {
    const { container } = render(<LoadedTrend report={report(WIRE)} selected="all" />);
    const heights = bars(container).map((b) => b.style.height);
    expect(heights[2]).toBe('100%'); // 15 Sep — the peak
    expect(heights[7]).toBe('90%'); // 20 Sep
    expect(heights[13]).toBe('40%'); // 26 Sep
    expect(heights[0]).toBe('10%'); // 13 Sep
    expect(heights[1]).toBe('0%'); // 14 Sep — nothing settled
  });

  /**
   * A DAY THAT TOOK NOTHING IS TOLD APART FROM A DAY THAT TOOK ALMOST NOTHING.
   * Every bar floors at 2px so a tiny day stays visible, which makes a zero and
   * a one-fils day the same HEIGHT — so the zero is marked instead.
   */
  it('marks a zero day rather than letting it read as a very small one', () => {
    const { container } = render(<LoadedTrend report={report(WIRE)} selected="all" />);
    const marked = bars(container).filter((b) => b.dataset.zero === 'true');
    expect(marked).toHaveLength(TREND_DAYS - 4);
    expect(bars(container)[2]!.dataset.zero).toBeUndefined();
  });

  /**
   * EVERY LABEL NAMES A VALUE THE CHART REACHES. The bars encode gross and
   * nothing else, so the label carries the gross the bar is drawn from AND the
   * transaction count the bars deliberately do not encode — the second series,
   * as text rather than as a hover a keyboard never reaches.
   */
  it('names every day’s own gross and transaction count', () => {
    const { container } = render(<LoadedTrend report={report(WIRE)} selected="all" />);
    const seen = labels(container);
    expect(seen).toHaveLength(TREND_DAYS);

    expect(seen[2]).toBe('Tue 15 Sep: 100.000 KD, 10 transactions');
    expect(seen[13]).toBe('Sat 26 Sep: 40.000 KD, 4 transactions');
    expect(seen[1]).toBe('Mon 14 Sep: 0.000 KD, 0 transactions');

    /* No label may name a figure no day holds. */
    const series = seriesFrom(report(WIRE));
    if (!series.ok) return;
    const truthful = new Set(series.days.map(pointLabel));
    for (const label of seen) expect(truthful.has(label)).toBe(true);
  });

  it('says transaction in the singular at exactly one', () => {
    const one: DayPoint = { date: '2026-09-13', grossFils: fils(1_000), transactions: 1 };
    expect(pointLabel(one)).toBe('Sun 13 Sep: 1.000 KD, 1 transaction');
  });

  /**
   * THE THOUSAND. `formatFils` groups the whole part, so 1 234 567 fils renders
   * "1,234.567" while a hand-rolled `(v / 1000).toFixed(3)` renders
   * "1234.567" — below a thousand the two agree and a mutation that replaced
   * the one formatter would go unnoticed. `earningsByBranchRender.test.tsx`
   * makes the same argument for the same reason.
   */
  it('formats money through the one formatter, grouped above a thousand', () => {
    const big = report([row('2026-09-15', 400, 1_000_000), row('2026-09-15', 2, 234_567)]);
    const { container } = render(<LoadedTrend report={big} selected="all" />);
    expect(labels(container)[2]).toBe('Tue 15 Sep: 1,234.567 KD, 402 transactions');
    expect(screen.getByText('1,234.567')).toBeTruthy(); // the axis tick
  });

  it('states the scale in words for a reader who cannot see the axis', () => {
    render(<LoadedTrend report={report(WIRE)} selected="all" />);
    expect(screen.getByText(/The tallest day is 100.000 KD/)).toBeTruthy();
  });

  /** The caption is the SERVER'S measured window, not the request. */
  it('names the window it was answered for', () => {
    render(<LoadedTrend report={report(WIRE)} selected="all" />);
    expect(screen.getByText('13 Sep 2026 – 26 Sep 2026')).toBeTruthy();
  });

  it('labels a day with its weekday without re-converting it into a zone', () => {
    expect(dayLabel('2026-09-13')).toBe('Sun 13 Sep');
    expect(dayLabel('2026-09-26')).toBe('Sat 26 Sep');
  });
});

/* =============================================================== the states */

describe('§4 the four states', () => {
  /**
   * LOADING. The skeleton's shape is the chart's shape — `TREND_DAYS` tracks,
   * one axis, one row of day numbers — because "a skeleton whose shape does not
   * match what replaces it is a worse loading state than none", which is why
   * `REPORT_SKELETON` exists at all.
   */
  it('loading: the skeleton has as many tracks as the chart will have bars', () => {
    const { container } = render(<TrendSkeleton />);
    expect(container.querySelectorAll('.trend__track')).toHaveLength(TREND_DAYS);
    expect(container.querySelectorAll('.trend__day')).toHaveLength(TREND_DAYS);
  });

  /** NO BAR IS DRAWN AT A HEIGHT — a skeleton bar at 40% is a figure. */
  it('loading: promises no value, only a place for one', () => {
    const { container } = render(<TrendSkeleton />);
    expect(container.querySelectorAll('.trend__bar')).toHaveLength(0);
    expect(container.textContent).not.toMatch(/\d/);
  });

  /**
   * EMPTY, KEYED ON THE PEAK AND NOT ON `rows.length`, because those are two
   * different empties and only one of them is "nothing happened".
   */
  it('empty: names the window when nothing settled at all', () => {
    const { container } = render(<LoadedTrend report={report([])} selected="all" />);
    expect(bars(container)).toHaveLength(0);
    expect(screen.getByText('No gross in these days')).toBeTruthy();
    expect(screen.getByText(/Nothing settled between 13 Sep 2026 and 26 Sep 2026/)).toBeTruthy();
  });

  /**
   * THE SECOND EMPTY. A day can carry settled visits and no gross —
   * `Reports.tsx § GROSS IS THE VISIT` records that a visit a held deposit
   * covered outright settles at exactly 0.000. Both empties draw no bar, so
   * both need a sentence, and the transaction count tells them apart.
   */
  it('empty: distinguishes "nothing happened" from "nothing carried gross"', () => {
    const zeroGross = report([row('2026-09-15', 3, 0), row('2026-09-20', 2, 0)]);
    render(<LoadedTrend report={zeroGross} selected="all" />);
    expect(screen.getByText(/5 visits settled between/)).toBeTruthy();
    expect(screen.getByText(/none of them carried gross/)).toBeTruthy();
    expect(screen.queryByText(/Nothing settled between/)).toBeNull();
  });

  it('empty: says visit in the singular at exactly one', () => {
    render(<LoadedTrend report={report([row('2026-09-15', 1, 0)])} selected="all" />);
    expect(screen.getByText(/1 visit settled between/)).toBeTruthy();
  });

  /* ERROR — the report read. */
  it('error: the workspace did not answer, and the tiles above are unaffected', () => {
    render(<TrendUnavailable error={new Error('boom')} onRetry={() => {}} retrying={false} />);
    expect(screen.getByText("Couldn't load the chart")).toBeTruthy();
    expect(screen.getByText(/Your figures above are unaffected/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  /**
   * A REFUSAL EXPLAINS AND OFFERS NOTHING TO RETRY (§4), and it renders the
   * SERVER'S own sentence rather than a paraphrase — the rule `MetricsError`
   * and the activity feed both already keep on this screen.
   */
  it('error: a refusal explains, quotes the server, and has no button', () => {
    const refusal = new ApiError('That salon is not yours.', { status: 403, code: 'forbidden' });
    render(<TrendUnavailable error={refusal} onRetry={() => {}} retrying={false} />);
    expect(screen.getByText('That salon is not yours.')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  /* OFFLINE — its own state, not "something went wrong". */
  it('offline: is told apart from a server failure, and says the figures survive', () => {
    const offline = new ApiError('connection lost', { status: 0, code: 'network', offline: true });
    render(<TrendUnavailable error={offline} onRetry={() => {}} retrying={false} />);
    expect(screen.getByText('No connection')).toBeTruthy();
    expect(screen.getByText(/the last we loaded/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('offline: the retry says it is trying while it tries', () => {
    const offline = new ApiError('connection lost', { status: 0, code: 'network', offline: true });
    render(<TrendUnavailable error={offline} onRetry={() => {}} retrying />);
    expect(screen.getByRole('button', { name: 'Trying…' })).toBeTruthy();
  });

  /**
   * THE SALON READ IS A SEPARATE FAILURE FROM THE REPORT READ, which is the
   * whole reason this card is its own census entry: without a zone there is no
   * window, so nothing has been asked of the reports endpoint at all.
   */
  it('the salon read owns its own three answers', () => {
    const { unmount } = render(
      <WindowUnknown error={new Error('boom')} onRetry={() => {}} retrying={false} />,
    );
    expect(screen.getByText("Couldn't load the salon")).toBeTruthy();
    expect(screen.getByText(/we don't know which days to chart/)).toBeTruthy();
    unmount();

    const off = render(
      <WindowUnknown
        error={new ApiError('connection lost', { status: 0, code: 'network', offline: true })}
        onRetry={() => {}}
        retrying={false}
      />,
    );
    expect(screen.getByText('No connection')).toBeTruthy();
    off.unmount();

    render(
      <WindowUnknown
        error={new ApiError('That salon is not yours.', { status: 403, code: 'forbidden' })}
        onRetry={() => {}}
        retrying={false}
      />,
    );
    expect(screen.getByText('That salon is not yours.')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

/**
 * TWO REFUSALS OF A PAYLOAD, which are not one of the four states and are not
 * merchant situations. Neither has a retry that would change anything, and each
 * sends a reader somewhere completely different, so neither is folded into
 * "something went wrong".
 */
describe('a payload this card cannot draw honestly is refused by name', () => {
  it('a rolling window is named as such, and nothing is drawn', () => {
    const { container } = render(
      <LoadedTrend report={report(WIRE, { window: ROLLING_7 })} selected="all" />,
    );
    expect(bars(container)).toHaveLength(0);
    expect(screen.getByText(/rolling window rather than whole days/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('a fractional fils is named as such, and nothing is drawn', () => {
    const { container } = render(
      <LoadedTrend report={report([row('2026-09-15', 1, 10_000.5)])} selected="all" />,
    );
    expect(bars(container)).toHaveLength(0);
    expect(screen.getByText(/fraction of a fils/)).toBeTruthy();
    expect(screen.getByText(/drawn rather than drawn wrongly/)).toBeTruthy();
  });

  /** The zone is quoted back, because she has one field to go and look in. */
  it('an unusable time zone is quoted back and pointed at Settings', () => {
    render(<UnusableZone zone="Mars/Olympus_Mons" />);
    expect(screen.getByText(/Mars\/Olympus_Mons/)).toBeTruthy();
    expect(screen.getByText(/Set it in Settings/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('the card head is the same in every state', () => {
  /**
   * The head does not move between a skeleton and a chart — that is the whole
   * reason `TrendCard` is one component every state renders inside rather than
   * a heading each state repeats.
   */
  it('names the card the same way loading as loaded', () => {
    const { unmount } = render(
      <TrendCard scope={null} caption={null}>
        <TrendSkeleton />
      </TrendCard>,
    );
    expect(screen.getByRole('heading', { name: /Gross by day/ })).toBeTruthy();
    unmount();

    render(<LoadedTrend report={report(WIRE)} selected="all" />);
    expect(screen.getByRole('heading', { name: /Gross by day/ })).toBeTruthy();
  });

  /**
   * THE QUALIFIER IS A CLAIM ABOUT FIGURES, so it cannot appear before there
   * are any. `scope` is null in every pre-data state for exactly that reason.
   */
  it('claims no scope while there are no figures to claim one about', () => {
    const { container } = render(
      <TrendCard scope={null} caption={null}>
        <TrendSkeleton />
      </TrendCard>,
    );
    expect(container.querySelector('.overview__card-scope')).toBeNull();
  });
});

describe('the chart is a list, so a screen reader walks the series', () => {
  it('renders the days as list items rather than as undifferentiated boxes', () => {
    render(
      <TrendChart
        days={[
          { date: '2026-09-13', grossFils: fils(10_000), transactions: 1 },
          { date: '2026-09-14', grossFils: fils(20_000), transactions: 2 },
        ]}
        peak={fils(20_000)}
        caption="13 Sep 2026 – 14 Sep 2026"
      />,
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });
});
