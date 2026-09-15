// @vitest-environment jsdom

/**
 * Merchant → Reports, the window half of Aftab's item 9: "compare with dates".
 *
 * =========================================================================
 * THE FOUR THINGS THIS FILE IS ACTUALLY FOR
 * =========================================================================
 * 1. THE PARSE USED TO THROW ON EVERY RANGE. `api/reports.ts:173` was
 *    `if (!REPORT_PERIODS.includes(String(r.period))) fail(kind)` — an enum
 *    check written when the three presets were the whole vocabulary. A 200 the
 *    server had composed correctly for `?period=2026-03-01_2026-03-31` was
 *    turned into "Couldn't load this report" in the browser. § the blocker
 *    drives the exact payload and would fail with that line restored.
 *
 * 2. A ROLLING WINDOW MUST NEVER PRINT AS DATES. `30d` is the last 30 × 24
 *    hours ending at the instant it was served; a date range over that figure is
 *    a false label on revenue. The server makes it impossible to write by hand —
 *    `fromDate`/`toDate` are null — and this file proves the CLIENT would still
 *    be right if it did not, by handing `windowPhrase` a rolling window that
 *    illegally carries dates and asserting no date comes out. That is the
 *    mutation, not a paraphrase of the invariant.
 *
 * 3. THE EXPORT MUST DROP `compare`. The banner on this screen promises "the
 *    export matches exactly what you see", and the server keeps its half by
 *    refusing a comparison on `.csv`. § the export reads the URL the client
 *    actually fetched.
 *
 * 4. A REFUSED WINDOW MUST SAY WHY. `400 invalid_period` carries a sentence
 *    naming the fix and used to be replaced by "Something went wrong on our
 *    side."
 *
 * Cleanup is manual, for the reason `moneyRender.test.tsx` spells out: no
 * `globals: true` in this project, so `@testing-library/react` registers no
 * `afterEach(cleanup)` of its own.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  downloadReportCsv,
  formatWindowDay,
  parseReport,
  reportFilenameFallback,
  windowLabel,
  windowPhrase,
  type Report,
  type ReportWindow,
} from '../api/reports.js';
import {
  comparabilityCaveat,
  ComparisonStrip,
  compareTokenOf,
  DEFAULT_WINDOW_SELECTION,
  ExportNote,
  periodTokenOf,
  ReportCardRefusal,
  reportFootCaption,
  selectPeriodSegment,
  WindowControls,
  type WindowSelection,
} from './Reports.js';
import { ApiError } from '../api/client.js';

/**
 * The export is an AUTHENTICATED FETCH — `api/reports.ts` § the export explains
 * why a plain `<a href>` cannot be — so it needs a session to get past its own
 * guard. Mocked rather than written into storage: this jsdom run has no working
 * `localStorage.clear`, and the session's real shape is not what any assertion
 * here is about. `importOriginal` keeps every other export intact, because
 * `authedRequest` reaches for several of them.
 */
vi.mock('../auth/session.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../auth/session.js')>()),
  readSession: () => ({ accessToken: 'tok_test_export' }) as never,
}));

afterEach(cleanup);

/* ------------------------------------------------------------- fixtures -- */

/** `30d` as the server resolves it — no calendar days, because it has none. */
const ROLLING_30: ReportWindow = {
  token: '30d',
  basis: 'rolling',
  from: '2026-08-17T09:00:00.000Z',
  to: '2026-09-16T09:00:00.000Z',
  days: 30,
  fromDate: null,
  toDate: null,
  timezone: 'Asia/Kuwait',
};

/** The salon's own March, both ends inclusive. */
const MARCH: ReportWindow = {
  token: '2026-03-01_2026-03-31',
  basis: 'calendar',
  from: '2026-02-28T21:00:00.000Z',
  to: '2026-03-31T21:00:00.000Z',
  days: 31,
  fromDate: '2026-03-01',
  toDate: '2026-03-31',
  timezone: 'Asia/Kuwait',
};

const FEBRUARY: ReportWindow = {
  ...MARCH,
  token: '2026-02-01_2026-02-28',
  days: 28,
  fromDate: '2026-02-01',
  toDate: '2026-02-28',
};

/** The comparison window of a rolling period — rolling ends, so no dates. */
const PREVIOUS_30: ReportWindow = { ...ROLLING_30, token: 'previous:30d', days: 30 };

function wire(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'sales',
    title: 'Sales summary',
    period: '30d',
    window: ROLLING_30,
    comparison: null,
    branchId: 'all',
    columns: [
      { header: 'Day', key: 'day', type: 'text' },
      { header: 'Gross KD', key: 'grossFils', type: 'money' },
    ],
    rows: [{ day: '2026-03-01', grossFils: 1_820_000 }],
    stat: { key: 'grossFils', label: 'KD gross', value: 1_820_000, type: 'money' },
    rowCount: 1,
    ...over,
  };
}

/* ------------------------------------------------------------ the blocker -- */

describe('the blocker: a calendar range through parseReport', () => {
  /**
   * The exact payload the server sends for `?period=2026-03-01_2026-03-31`.
   * With the old enum check restored this throws
   * "sales: the report shape did not match the addendum."
   */
  it('parses a range period that the preset check used to refuse', () => {
    const r = parseReport(
      wire({ period: '2026-03-01_2026-03-31', window: MARCH }),
      'sales',
    );
    expect(r.period).toBe('2026-03-01_2026-03-31');
    expect(r.window.basis).toBe('calendar');
    expect(r.window.days).toBe(31);
  });

  it('still parses the three presets unchanged', () => {
    for (const token of ['7d', '30d', '90d']) {
      const r = parseReport(wire({ period: token, window: { ...ROLLING_30, token } }), 'sales');
      expect(r.period).toBe(token);
      expect(r.window.basis).toBe('rolling');
    }
  });

  it('still refuses a period that is not a string at all', () => {
    expect(() => parseReport(wire({ period: 30 }), 'sales')).toThrow(/sales\.period/);
  });
});

/* -------------------------------------------------------------- the window -- */

describe('the window, parsed rather than trusted', () => {
  it('refuses a rolling window that carries calendar dates', () => {
    expect(() =>
      parseReport(
        wire({ window: { ...ROLLING_30, fromDate: '2026-08-17', toDate: '2026-09-16' } }),
        'sales',
      ),
    ).toThrow(/a rolling window carried calendar dates/);
  });

  it('refuses a calendar window that arrived without the days it names', () => {
    expect(() =>
      parseReport(wire({ window: { ...MARCH, fromDate: null, toDate: null } }), 'sales'),
    ).toThrow(/without the days it names/);
  });

  it('refuses an unknown basis', () => {
    expect(() => parseReport(wire({ window: { ...MARCH, basis: 'fiscal' } }), 'sales')).toThrow(
      /sales\.window\.basis/,
    );
  });

  it('refuses a missing window outright rather than defaulting to one', () => {
    const payload = wire();
    delete payload['window'];
    expect(() => parseReport(payload, 'sales')).toThrow(/sales\.window/);
  });
});

/* -------------------------------------------------------------- the phrase -- */

describe('what a merchant can tell about rolling versus calendar', () => {
  it('names a rolling preset by the design’s own caption and no dates', () => {
    expect(windowPhrase(ROLLING_30)).toBe('this month');
    expect(windowLabel(ROLLING_30)).toBe('This month');
    expect(windowLabel({ ...ROLLING_30, token: '7d', days: 7 })).toBe('This week');
    expect(windowLabel({ ...ROLLING_30, token: '90d', days: 90 })).toBe('This quarter');
  });

  it('names a calendar window by its days, month names intact', () => {
    expect(windowPhrase(MARCH)).toBe('1 Mar 2026 – 31 Mar 2026');
    /*
     * THE REASON `windowPhrase` IS THE LOWERCASE SOURCE AND `windowLabel`
     * CAPITALISES UP. The three call sites used to read
     * `PERIOD_CAPTION[r.period].toLowerCase()`, which is safe on "This month"
     * and would have printed "1 mar 2026" over a range.
     */
    expect(windowLabel(MARCH)).toBe('1 Mar 2026 – 31 Mar 2026');
  });

  it('does not print a range for a single-day window', () => {
    expect(windowPhrase({ ...MARCH, toDate: '2026-03-01', days: 1 })).toBe('1 Mar 2026');
  });

  it('names a previous rolling window by its length, never by dates', () => {
    expect(windowPhrase(PREVIOUS_30)).toBe('the previous 30 days');
  });

  /**
   * THE MUTATION. `fromDate`/`toDate` are null on every rolling window the
   * server sends, so a renderer written as "print the dates if they are there"
   * passes every other test in this file. This hands it a rolling window that
   * illegally carries them — bypassing `parseWindow`, which refuses it — and
   * asserts no date comes out. A renderer keyed on nullness fails here; one
   * keyed on `basis` does not.
   */
  it('prints no dates for a rolling window even when a payload supplies them', () => {
    const lying: ReportWindow = { ...ROLLING_30, fromDate: '2026-08-17', toDate: '2026-09-16' };
    const phrase = windowPhrase(lying);
    expect(phrase).toBe('this month');
    expect(phrase).not.toMatch(/2026/);
    expect(phrase).not.toMatch(/Aug|Sep/);
  });

  /**
   * `new Date('2026-03-01')` is UTC midnight rendered in the BROWSER's zone, so
   * a date-based formatter is one day early anywhere west of UTC. These are
   * salon-local days that have already been decided; the control is that the
   * string maps the same whatever `Date` would have said.
   */
  it('formats a calendar day from its text, not through Date', () => {
    expect(formatWindowDay('2026-03-01')).toBe('1 Mar 2026');
    expect(formatWindowDay('2026-12-31')).toBe('31 Dec 2026');
    expect(formatWindowDay('2026-01-09')).toBe('9 Jan 2026');
  });

  it('puts the window on the card foot where the caption used to read undefined', () => {
    const rolling = parseReport(wire(), 'sales');
    expect(reportFootCaption(rolling)).toBe('1 row · This month');

    const ranged = parseReport(wire({ period: MARCH.token, window: MARCH }), 'sales');
    expect(reportFootCaption(ranged)).toBe('1 row · 1 Mar 2026 – 31 Mar 2026');
    expect(reportFootCaption(ranged)).not.toMatch(/undefined/);
  });
});

/* ---------------------------------------------------------- the comparison -- */

const COMPARISON = {
  window: FEBRUARY,
  rows: [{ day: '2026-02-01', grossFils: 1_580_000 }],
  rowCount: 1,
  stat: { key: 'grossFils', label: 'KD gross', value: 1_580_000, type: 'money' },
  delta: { key: 'grossFils', label: 'KD gross', value: 240_000, type: 'money' },
  comparable: false,
};

function comparedReport(over: Record<string, unknown> = {}): Report {
  return parseReport(
    wire({
      period: MARCH.token,
      window: MARCH,
      comparison: { ...COMPARISON, ...over },
    }),
    'sales',
  );
}

describe('the comparison on a card', () => {
  it('renders the delta with the window it is a difference from', () => {
    const r = comparedReport();
    const { container } = render(
      <ComparisonStrip period={r.window} comparison={r.comparison!} />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('240.000');
    expect(text).toContain('more');
    /* THE REFERENT. A delta without its window is a number with nothing to be a
       difference from — the trap this rendering exists to avoid. */
    expect(text).toContain('1 Feb 2026 – 28 Feb 2026');
    /* And the figure it is a difference FROM, so both numbers are on screen. */
    expect(text).toContain('1,580.000');
  });

  /**
   * THE `aria-label` STANDARD. A hand-prepended "+" would put the sign outside
   * the element that owns the label: "+240.000" on screen, "240.000 Kuwaiti
   * dinars" announced. The direction is a WORD instead, so both renderings carry
   * it, and the magnitude goes through `formatFils` (#1) inside `<Money>`.
   */
  it('announces the money exactly as it paints it, with the direction in words', () => {
    const r = comparedReport();
    const { container } = render(
      <ComparisonStrip period={r.window} comparison={r.comparison!} />,
    );
    const labelled = [...container.querySelectorAll('[aria-label]')].map((e) =>
      e.getAttribute('aria-label'),
    );
    expect(labelled).toContain('240.000 Kuwaiti dinars');
    expect(labelled).toContain('1,580.000 Kuwaiti dinars');
    /* No sign is painted that is not announced. */
    expect(container.textContent).not.toContain('+240.000');
    expect(container.textContent).not.toContain('-240.000');
  });

  it('says less, not more, for a fall — and still announces the magnitude', () => {
    const r = comparedReport({
      delta: { key: 'grossFils', label: 'KD gross', value: -240_000, type: 'money' },
    });
    const { container } = render(
      <ComparisonStrip period={r.window} comparison={r.comparison!} />,
    );
    expect(container.textContent).toContain('less');
    expect(container.textContent).not.toContain('more');
    expect(
      [...container.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label')),
    ).toContain('240.000 Kuwaiti dinars');
    expect(container.querySelector('.reports__compare')?.getAttribute('data-direction')).toBe(
      'down',
    );
  });

  it('says no change rather than 0.000 more', () => {
    const r = comparedReport({
      delta: { key: 'grossFils', label: 'KD gross', value: 0, type: 'money' },
      stat: { key: 'grossFils', label: 'KD gross', value: 1_820_000, type: 'money' },
    });
    const { container } = render(
      <ComparisonStrip period={r.window} comparison={r.comparison!} />,
    );
    expect(container.textContent).toContain('No change');
    expect(container.textContent).not.toContain('more');
    expect(container.textContent).not.toContain('less');
  });

  it('renders the caveat when the server says the two windows are not comparable', () => {
    const r = comparedReport({ comparable: false });
    const { container } = render(
      <ComparisonStrip period={r.window} comparison={r.comparison!} />,
    );
    expect(container.textContent).toContain('Not like for like: 31 days against 28.');
  });

  /**
   * THE CONTROL. Same two windows, same delta, `comparable: true` — and the
   * caveat must be gone. Without this the previous assertion passes on a
   * component that renders the caveat unconditionally.
   */
  it('renders no caveat when the server says they are comparable', () => {
    const r = comparedReport({ comparable: true });
    const { container } = render(
      <ComparisonStrip period={r.window} comparison={r.comparison!} />,
    );
    expect(container.textContent).not.toContain('Not like for like');
    expect(container.querySelector('.reports__compare-caveat')).toBeNull();
  });

  it('names the different basis rather than a day count when the bases differ', () => {
    expect(comparabilityCaveat(ROLLING_30, MARCH)).toBe(
      'Not like for like: a rolling window against a calendar range.',
    );
    expect(comparabilityCaveat(MARCH, ROLLING_30)).toBe(
      'Not like for like: a calendar range against a rolling window.',
    );
  });

  it('refuses a non-integer delta rather than letting it reach fils()', () => {
    expect(() =>
      parseReport(
        wire({
          window: MARCH,
          comparison: {
            ...COMPARISON,
            delta: { key: 'grossFils', label: 'KD gross', value: 240_000.5, type: 'money' },
          },
        }),
        'sales',
      ),
    ).toThrow(/comparison\.delta\.value \(non-integer in a money stat\)/);
  });

  /**
   * `comparison: null` IS AN ANSWER — "no second window was asked for". A
   * MISSING KEY is a shape this client does not recognise, and `?? null` would
   * have quietly turned the second into the first.
   */
  it('tells a null comparison apart from a missing one', () => {
    expect(parseReport(wire({ comparison: null }), 'sales').comparison).toBeNull();

    const payload = wire();
    delete payload['comparison'];
    expect(() => parseReport(payload, 'sales')).toThrow(/sales\.comparison/);
  });

  it('refuses a comparison whose comparable flag is missing', () => {
    const c: Record<string, unknown> = { ...COMPARISON };
    delete c['comparable'];
    expect(() => parseReport(wire({ window: MARCH, comparison: c }), 'sales')).toThrow(
      /comparison\.comparable/,
    );
  });
});

/* -------------------------------------------------------------- the export -- */

describe('the export is of one window', () => {
  /**
   * jsdom implements neither `URL.createObjectURL` nor a real anchor
   * navigation, and an un-stubbed `anchor.click()` logs "Not implemented:
   * navigation to another Document" from inside a passing test — noise that
   * reads as a failure. These stubs stand in for the browser's download manager
   * and record the filename it was handed, which is the assertion.
   *
   * `RealURL` is captured BEFORE the stub replaces the global, because the
   * stubbed object is a plain literal and `new URL(...)` against it throws.
   */
  const RealURL = URL;

  function stubDownload(): { names: string[]; restore: () => void } {
    const names: string[] = [];
    vi.stubGlobal('URL', { ...RealURL, createObjectURL: () => 'blob:x', revokeObjectURL: () => {} });
    const realCreate = document.createElement.bind(document);
    const spy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreate(tag);
      if (tag === 'a') {
        Object.defineProperty(el, 'download', {
          set: (v: string) => names.push(v),
          get: () => names[names.length - 1] ?? '',
          configurable: true,
        });
        el.click = () => {};
      }
      return el;
    });
    return {
      names,
      restore: () => {
        spy.mockRestore();
        vi.unstubAllGlobals();
      },
    };
  }

  it('names the file with the branch segment the fallback used to drop', () => {
    /*
     * The server's shape is `{kind}_{branchTag}_{token}.csv`. The old fallback
     * was `${kind}_${period}.csv` — the branch segment was missing altogether,
     * which was already wrong before ranges existed: two branches' customer
     * lists landed in a downloads folder under one name.
     */
    expect(reportFilenameFallback('sales', 'Salmiya', '30d')).toBe('sales_salmiya_30d.csv');
    expect(reportFilenameFallback('sales', null, '30d')).toBe('sales_all-branches_30d.csv');
    expect(reportFilenameFallback('customers', 'Kuwait City', '2026-03-01_2026-03-31')).toBe(
      'customers_kuwait-city_2026-03-01_2026-03-31.csv',
    );
  });

  it('strips what a salon typed, exactly as the server does', () => {
    expect(reportFilenameFallback('sales', 'x"; rm -rf', '30d')).toBe('sales_x-rm--rf_30d.csv');
    /* A name with nothing safe left still produces a filename, not an empty segment. */
    expect(reportFilenameFallback('sales', '\u0642\u0627\u0639\u0629', '30d')).toBe(
      'sales_branch_30d.csv',
    );
  });

  /**
   * ===========================================================================
   * THE URL THE CLIENT ACTUALLY FETCHED, READ OFF THE MOCK
   * ===========================================================================
   * The card asks for two windows; the file is one. The server refuses a
   * comparison on `.csv` (`400 compare_not_exportable`) rather than dropping one
   * silently, so a client that passed the card's whole query string through
   * would ship an Export button that fails whenever a comparison is on screen.
   *
   * Asserted on the REQUEST rather than on `exportQuery`, which is module
   * -private: a test of the private function would pass even if
   * `downloadReportCsv` called the wrong one.
   */
  it('drops compare from the export URL and keeps branch and period', async () => {
    const csv = 'Day,Gross KD\r\n2026-03-01,1820.000';
    /* Typed arguments, so `mock.calls[0][0]` is the URL and not an empty tuple. */
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(csv, {
          status: 200,
          headers: { 'content-type': 'text/csv; charset=utf-8' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { names, restore } = stubDownload();

    await downloadReportCsv(
      'SAL-AMARA',
      'sales',
      { branch: 'BR-SALMIYA', period: MARCH.token, compare: '2026-02-01_2026-02-28' },
      'Salmiya',
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new RealURL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/salons/SAL-AMARA/reports/sales.csv');
    expect(url.searchParams.get('period')).toBe('2026-03-01_2026-03-31');
    expect(url.searchParams.get('branch')).toBe('BR-SALMIYA');
    /* The whole point: the parameter the server refuses never leaves. Read as a
       GET rather than a `has`, so a failure names the value that escaped. */
    expect(url.searchParams.get('compare')).toBeNull();
    /* And the file the merchant is handed is named for the ONE window. */
    expect(names[0]).toBe('sales_salmiya_2026-03-01_2026-03-31.csv');

    restore();
  });

  it('falls back to the branch-segmented name when the server\u2019s is unreadable', async () => {
    /*
     * `content-disposition` is readable now that lane A added
     * `exposedHeaders: ['content-disposition']`, so this path is narrow — but it
     * is the path that was wrong, and it is the one a same-origin misconfig or
     * an older API puts a merchant back on.
     */
    vi.stubGlobal('fetch', vi.fn(async () => new Response('a,b', { status: 200 })));
    const { names, restore } = stubDownload();

    await downloadReportCsv(
      'SAL-AMARA',
      'customers',
      { branch: 'BR-SALMIYA', period: MARCH.token, compare: null },
      'Kuwait City',
    );
    expect(names[0]).toBe('customers_kuwait-city_2026-03-01_2026-03-31.csv');

    restore();
  });

  it('prefers the name the server put on the response', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('a,b', {
          status: 200,
          headers: { 'content-disposition': 'attachment; filename="sales_salmiya_30d.csv"' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { names, restore } = stubDownload();

    await downloadReportCsv(
      'SAL-AMARA',
      'sales',
      { branch: 'all', period: '30d', compare: null },
      null,
    );
    /* Not `sales_all-branches_30d.csv`, which is what the fallback would build —
       the header wins, so the server stays the one that names the file. */
    expect(names[0]).toBe('sales_salmiya_30d.csv');

    restore();
  });

  /**
   * A REFUSED EXPORT REFUSES VISIBLY — the property the fetch-and-objectURL
   * shape exists to keep. `compare_not_exportable` should be unreachable from
   * this client now, and if it ever is reached the merchant reads the server's
   * sentence rather than saving a JSON error body named `sales.csv`.
   */
  it('surfaces the server\u2019s refusal instead of downloading it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: 'compare_not_exportable',
              message: 'A comparison is a card figure, not a file.',
            }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    await expect(
      downloadReportCsv(
        'SAL-AMARA',
        'sales',
        { branch: 'all', period: '30d', compare: null },
        null,
      ),
    ).rejects.toThrow('A comparison is a card figure, not a file.');
    vi.unstubAllGlobals();
  });
});

/* ------------------------------------------------------- the refused window -- */

describe('a refused window says why', () => {
  const REFUSAL = new ApiError(
    'period starts after it ends: 2026-03-31 is later than 2026-03-01.',
    { status: 400, code: 'invalid_period' },
  );

  it('renders the server’s own sentence, not "something went wrong"', () => {
    const { container } = render(
      <ReportCardRefusal error={REFUSAL} onRetry={() => {}} retrying={false} />,
    );
    expect(container.textContent).toContain('2026-03-31 is later than 2026-03-01');
    expect(container.textContent).not.toContain('Something went wrong');
  });

  it('offers no retry, because the same request produces the same refusal', () => {
    render(<ReportCardRefusal error={REFUSAL} onRetry={() => {}} retrying={false} />);
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
  });

  it('renders an invalid_compare the same way', () => {
    const { container } = render(
      <ReportCardRefusal
        error={
          new ApiError(
            'compare=previous is only defined for 7d, 30d and 90d.',
            { status: 400, code: 'invalid_compare' },
          )
        }
        onRetry={() => {}}
        retrying={false}
      />,
    );
    expect(container.textContent).toContain('compare=previous is only defined');
  });

  /** THE CONTROL: a real failure still offers the retry it always did. */
  it('still offers a retry for a 500', () => {
    render(
      <ReportCardRefusal
        error={new ApiError('boom', { status: 500, code: 'http_error' })}
        onRetry={() => {}}
        retrying={false}
      />,
    );
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeNull();
  });

  /** And a 403 is still the permission ledger, still without a retry. */
  it('still renders a 403 as the ledger', () => {
    const { container } = render(
      <ReportCardRefusal
        error={new ApiError('Ask an owner for the Team permission.', { status: 403, code: 'forbidden' })}
        onRetry={() => {}}
        retrying={false}
      />,
    );
    expect(container.textContent).toContain("don't have access to this report");
    expect(container.textContent).toContain('Ask an owner for the Team permission.');
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
  });
});

/* ------------------------------------------------------------ the controls -- */

describe('the range control', () => {
  it('sends a preset token unchanged, exactly as before ranges existed', () => {
    expect(periodTokenOf(DEFAULT_WINDOW_SELECTION)).toBe('30d');
    expect(periodTokenOf({ ...DEFAULT_WINDOW_SELECTION, periodSeg: '7d' })).toBe('7d');
  });

  it('withholds a half-named range rather than asking a question she has not finished', () => {
    const half: WindowSelection = {
      ...DEFAULT_WINDOW_SELECTION,
      periodSeg: 'custom',
      periodFrom: '2026-03-01',
      periodTo: '',
    };
    expect(periodTokenOf(half)).toBeNull();
    expect(periodTokenOf({ ...half, periodTo: '2026-03-31' })).toBe('2026-03-01_2026-03-31');
  });

  /**
   * THE GRAMMAR IS NOT RE-IMPLEMENTED HERE. A range the wrong way round, and one
   * over 366 days, are composed and sent — the server refuses them with a
   * sentence that names the fix, and § a refused window proves that sentence
   * reaches the card. A client-side check would be a second grammar to drift.
   */
  it('sends a backwards range rather than second-guessing the server', () => {
    expect(
      periodTokenOf({
        ...DEFAULT_WINDOW_SELECTION,
        periodSeg: 'custom',
        periodFrom: '2026-03-31',
        periodTo: '2026-03-01',
      }),
    ).toBe('2026-03-31_2026-03-01');
  });

  it('will not send compare=previous against a calendar range', () => {
    const rolling: WindowSelection = { ...DEFAULT_WINDOW_SELECTION, compareSeg: 'previous' };
    expect(compareTokenOf(rolling)).toBe('previous');
    expect(compareTokenOf({ ...rolling, periodSeg: 'custom' })).toBeNull();
  });

  it('drops previous when the period becomes a range, rather than ignoring it silently', () => {
    const next = selectPeriodSegment(
      { ...DEFAULT_WINDOW_SELECTION, compareSeg: 'previous' },
      'custom',
    );
    expect(next.compareSeg).toBe('none');
    /* And leaves it alone when moving between presets. */
    expect(
      selectPeriodSegment({ ...DEFAULT_WINDOW_SELECTION, compareSeg: 'previous' }, '7d').compareSeg,
    ).toBe('previous');
  });

  it('withholds a half-named comparison range too', () => {
    const half: WindowSelection = {
      ...DEFAULT_WINDOW_SELECTION,
      compareSeg: 'dates',
      compareFrom: '2026-02-01',
      compareTo: '',
    };
    expect(compareTokenOf(half)).toBeNull();
    expect(compareTokenOf({ ...half, compareTo: '2026-02-28' })).toBe('2026-02-01_2026-02-28');
  });

  it('shows the two date fields only once Dates is picked, and says what a preset means', () => {
    const preset = render(
      <WindowControls value={DEFAULT_WINDOW_SELECTION} onChange={() => {}} />,
    );
    expect(preset.container.textContent).toContain('is a rolling window');
    expect(preset.container.textContent).toContain('not a calendar month');
    expect(preset.container.querySelectorAll('input[type="date"]')).toHaveLength(0);
    cleanup();

    const ranged = render(
      <WindowControls
        value={{ ...DEFAULT_WINDOW_SELECTION, periodSeg: 'custom' }}
        onChange={() => {}}
      />,
    );
    expect(ranged.container.querySelectorAll('input[type="date"]')).toHaveLength(2);
    expect(ranged.container.textContent).toContain('Both days are included');
  });

  it('hands back the day the merchant typed, without interpreting it', () => {
    const seen: WindowSelection[] = [];
    const { container } = render(
      <WindowControls
        value={{ ...DEFAULT_WINDOW_SELECTION, periodSeg: 'custom' }}
        onChange={(next) => seen.push(next)}
      />,
    );
    const [from] = [...container.querySelectorAll<HTMLInputElement>('input[type="date"]')];
    fireEvent.change(from!, { target: { value: '2026-03-01' } });
    expect(seen[0]?.periodFrom).toBe('2026-03-01');
  });

  it('disables Previous period under a range, and says why where it can be read', () => {
    const { container } = render(
      <WindowControls
        value={{ ...DEFAULT_WINDOW_SELECTION, periodSeg: 'custom' }}
        onChange={() => {}}
      />,
    );
    const previous = screen.getByRole('radio', { name: 'Previous period' });
    expect((previous as HTMLButtonElement).disabled).toBe(true);
    /* Disabled, NOT removed — `Segmented` keeps it focusable so the reason below
       is reachable rather than the control vanishing from under her. */
    expect(previous.getAttribute('tabindex')).toBe('-1');
    expect(container.textContent).toContain('There is no single previous to a calendar range');
  });

  it('leaves Previous period available under a preset', () => {
    render(<WindowControls value={DEFAULT_WINDOW_SELECTION} onChange={() => {}} />);
    expect(
      (screen.getByRole('radio', { name: 'Previous period' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('asks for the second comparison date rather than comparing with nothing', () => {
    const { container } = render(
      <WindowControls
        value={{ ...DEFAULT_WINDOW_SELECTION, compareSeg: 'dates', compareFrom: '2026-02-01' }}
        onChange={() => {}}
      />,
    );
    expect(container.textContent).toContain('Pick both dates to compare');
  });
});

/* ----------------------------------------------------------- the export note -- */

describe('the export note keeps the design’s promise', () => {
  it('names which of the two windows the file will be', () => {
    const { container } = render(<ExportNote window={MARCH} />);
    expect(container.textContent).toContain('1 Mar 2026 – 31 Mar 2026');
    expect(container.textContent).toContain('only');
  });

  it('names a rolling window without dates there either', () => {
    const { container } = render(<ExportNote window={ROLLING_30} />);
    expect(container.textContent).toContain('this month');
    expect(container.textContent).not.toMatch(/2026-/);
  });
});
