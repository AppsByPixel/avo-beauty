// @vitest-environment jsdom

/**
 * Merchant → Reports → Earnings by branch, rendered.
 *
 * =========================================================================
 * WHY THIS FILE RENDERS INSTEAD OF READING THE SOURCE
 * =========================================================================
 * Same reason `artistPerformanceRender.test.tsx` gives (DECISIONS.md #38: a
 * source-text guard asserts what the code SAYS and survives any refactor that
 * keeps the words and loses the behaviour), and one more that is specific to this
 * card: the defect it exists to stop is a defect of PLACEMENT and ROUTING, and
 * neither is visible in source text.
 *
 * Adding `earnings-by-branch` to `REPORT_FULL_TABLE` — which was the whole of the
 * handoff's instruction — routed it through `AttributedRows`, because that set was
 * doubling as "is this the artist card". Measured before the fix: the branch table
 * rendered under the heading "Artists, ranked by what they earned", declared "No
 * artists on the roster yet. Add one in Team…", put BOTH branches in the group
 * headed "Revenue with no artist behind it — not part of the ranking", and set
 * `data-unattributed` on both so the stylesheet greyed them. Every word of that is
 * in the source either way; only the tree shows which rows landed where.
 *
 * Cleanup is manual — no `globals: true` in this project, so
 * `@testing-library/react` registers no `afterEach(cleanup)` of its own.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { fils, formatFils } from '@avo/types';
import {
  BranchAssumedCaveat,
  BranchEarningsNote,
  BranchRows,
  cellText,
  fallbackTitle,
  ReportCardRefusal,
  ReportLoadedBody,
} from './Reports.js';
import { ApiError } from '../api/client.js';
import {
  REPORT_DESC,
  REPORT_FULL_TABLE,
  REPORT_KINDS,
  REPORT_SKELETON,
  type Report,
} from '../api/reports.js';

afterEach(cleanup);

/** The five columns the server sends, verbatim — `api/src/services/reports.ts`. */
const COLUMNS: Report['columns'] = [
  { header: 'Branch', key: 'branch', type: 'text' },
  { header: 'Transactions', key: 'transactions', type: 'int' },
  { header: 'Gross KD', key: 'grossFils', type: 'money' },
  { header: 'Assumed KD', key: 'assumedGrossFils', type: 'money' },
  { header: 'Assumed transactions', key: 'assumedTransactions', type: 'int' },
];

function row(
  branch: string,
  transactions: number,
  grossFils: number,
  assumedTransactions: number,
  assumedGrossFils: number,
): Record<string, string | number | null> {
  return { branch, transactions, grossFils, assumedGrossFils, assumedTransactions };
}

function report(
  rows: Report['rows'],
  statValue: number,
  branchId = 'all',
): Report {
  return {
    kind: 'earnings-by-branch',
    title: 'Earnings by branch',
    period: '30d',
    /* A rolling window has no calendar days to name — `parseWindow`'s invariant. */
    window: {
      token: '30d',
      basis: 'rolling',
      from: '2026-08-17T09:00:00.000Z',
      to: '2026-09-16T09:00:00.000Z',
      days: 30,
      fromDate: null,
      toDate: null,
      timezone: 'Asia/Kuwait',
    },
    comparison: null,
    branchId,
    columns: COLUMNS,
    rows,
    stat: { key: 'grossFils', label: 'KD gross', value: statValue, type: 'money' },
    rowCount: rows.length,
  };
}

/**
 * The bias lane A drove, at the scale it actually bites. Kuwait City is the
 * lowest branch id at the seeded salon, so every un-enrolled till's charge lands
 * on it: 1,234.567 KD of the 1,240.567 on this card is an attribution, and
 * Salmiya — which took 6.000 of its own — sits below it.
 *
 * THE FIGURES ARE ABOVE 1,000 KD ON PURPOSE. `formatFils` groups the whole part
 * (`toLocaleString('en-US')`), so 1_234_567 fils renders "1,234.567" while a
 * hand-rolled `(v / 1000).toFixed(3)` renders "1234.567". Below a thousand the
 * two agree and a mutation that replaced the helper would go unnoticed.
 */
const BIASED = report(
  [
    row('Kuwait City', 402, 1_234_567, 400, 1_228_567),
    row('Salmiya', 3, 6_000, 0, 0),
    row('Hawalli', 0, 0, 0, 0),
  ],
  1_240_567,
);

/** Every rendered row, in document order. */
function renderedRows(container: HTMLElement) {
  return [...container.querySelectorAll('.reports__row')].map((el) => ({
    unattributed: el.getAttribute('data-unattributed') !== null,
    cells: [...el.querySelectorAll('.reports__cell')].map((c) => ({
      text: c.textContent ?? '',
      numeric: c.getAttribute('data-numeric') !== null,
    })),
  }));
}

describe('the sixth kind is wired the way the other five are', () => {
  it('is a report kind, a full table, and has a skeleton and a description', () => {
    expect(REPORT_KINDS).toContain('earnings-by-branch');
    expect(REPORT_FULL_TABLE.has('earnings-by-branch')).toBe(true);
    expect(REPORT_SKELETON['earnings-by-branch']).toEqual({ columns: 5, rows: 2 });
  });

  it('describes itself in ONE string — the dashboard is English-only', () => {
    /*
     * The handoff asked for "REPORT_DESC copy in both languages". There is no
     * second language: `REPORT_DESC` is `Record<ReportKind, string>` because the
     * merchant dashboard is English-only by decision (design/README.md Known
     * gaps 1); #12's Arabic is the CUSTOMER surface. Asserted so a later edit
     * cannot quietly widen it to a pair and leave the card rendering an object.
     */
    const desc = REPORT_DESC['earnings-by-branch'];
    expect(typeof desc).toBe('string');
    expect(desc).toBe('Gross and transactions by branch, including branches that took nothing');
  });

  it('does not imply the export is recorded — REPORT_AUDITED is false for this kind', () => {
    /*
     * `REPORT_AUDITED['earnings-by-branch'] === false` on the server, deliberately
     * and consistently with `sales`. So no copy on this card may say the download
     * is logged, audited or recorded — a merchant who believed it was would be
     * relying on a row that is never written.
     */
    const { container } = render(<BranchEarningsNote report={BIASED} />);
    const caveat = render(<BranchAssumedCaveat report={BIASED} />);
    const text = `${REPORT_DESC['earnings-by-branch']} ${container.textContent ?? ''} ${caveat.container.textContent ?? ''}`;
    expect(text).not.toMatch(/audit|recorded in|logged|we keep a record/i);
  });
});

describe('every branch gets a row, and the rows are the server’s', () => {
  it('renders every row — no three-row preview', () => {
    const { container } = render(<BranchRows report={BIASED} />);
    expect(renderedRows(container)).toHaveLength(BIASED.rowCount);
  });

  it('does not re-sort what the server ranked', () => {
    const { container } = render(<BranchRows report={BIASED} />);
    expect(renderedRows(container).map((r) => r.cells[0]?.text)).toEqual(
      BIASED.rows.map((r) => String(r['branch'])),
    );
  });

  it('renders a branch that took nothing, as zeros rather than as an absence', () => {
    /*
     * `FROM branch LEFT JOIN` — "Hawalli earned 0.000" is an answer and a
     * silently absent branch is not. A filter that dropped zero rows would leave
     * a merchant counting three branches in Settings and two on this card.
     */
    const { container } = render(<BranchRows report={BIASED} />);
    const hawalli = renderedRows(container).find((r) => r.cells[0]?.text === 'Hawalli');
    expect(hawalli).toBeDefined();
    expect(hawalli?.cells.map((c) => c.text)).toEqual(['Hawalli', '0', '0.000', '0.000', '0']);
  });

  it('groups nothing and greys nothing — these rows are not artist buckets', () => {
    /*
     * THE REGRESSION THIS FILE EXISTS FOR. Routing this kind by
     * `REPORT_FULL_TABLE.has(kind)` sends it to `AttributedRows`, which finds no
     * `attribution === 'artist'` row, prints "No artists on the roster yet" and
     * files every BRANCH under "Revenue with no artist behind it".
     */
    const { container } = render(<BranchRows report={BIASED} />);
    expect(container.querySelectorAll('.reports__group')).toHaveLength(0);
    expect(container.textContent).not.toMatch(/artist/i);
    expect(renderedRows(container).some((r) => r.unattributed)).toBe(false);
  });

  it('right-aligns the four figure columns and only them', () => {
    /*
     * From the column TYPE, not from a position — an added or reordered column
     * must not leave a left-aligned header over a right-aligned column of money.
     */
    const { container } = render(<BranchRows report={BIASED} />);
    for (const r of renderedRows(container)) {
      expect(r.cells.map((c) => c.numeric)).toEqual([false, true, true, true, true]);
    }
  });

  it('formats money through formatFils, not by dividing by a thousand', () => {
    /*
     * THE MUTATION THIS CATCHES. `(1_234_567 / 1000).toFixed(3)` is "1234.567";
     * `formatFils(fils(1_234_567))` is "1,234.567". Both are three decimals and
     * both look like money; only one is the product's money format (#1). The
     * expectation is computed from `@avo/types` rather than typed as a literal,
     * so it cannot drift away from the helper it is asserting about.
     */
    const { container } = render(<BranchRows report={BIASED} />);
    const kwc = renderedRows(container)[0];
    expect(kwc?.cells[2]?.text).toBe(formatFils(fils(1_234_567)));
    expect(kwc?.cells[3]?.text).toBe(formatFils(fils(1_228_567)));
    expect(kwc?.cells[2]?.text).not.toBe((1_234_567 / 1000).toFixed(3));
    // And the helper really is the one that groups — the guard's own premise.
    expect(formatFils(fils(1_234_567))).toBe('1,234.567');
  });

  it('renders a null money cell as an em dash, never as 0.000', () => {
    expect(cellText(null, 'money', 'assumedGrossFils')).toBe('—');
    expect(cellText(0, 'money', 'assumedGrossFils')).toBe('0.000');
  });
});

describe('the caveat appears exactly when a figure is an attribution', () => {
  it('says nothing when every dinar was recorded where it says', () => {
    /*
     * THE PROPERTY THAT MATTERS MOST: it disappears on its own. `assumedGrossFils`
     * is a NUMBER, so when the tills are enrolled every row reads 0 and this
     * component returns null with no code changed and nobody remembering to
     * remove it.
     */
    const clean = report(
      [row('Kuwait City', 12, 40_000, 0, 0), row('Salmiya', 9, 33_000, 0, 0)],
      73_000,
    );
    const { container } = render(<BranchAssumedCaveat report={clean} />);
    expect(container.innerHTML).toBe('');
  });

  it('appears when ANY row carries assumed money, however small', () => {
    /*
     * NO THRESHOLD, AND THAT IS THE DECISION. One fil of assumed money on a
     * 40.000 branch is 0.0025% and can still be the whole gap to the branch
     * below it — the order's safety is a property of the gaps between rows, not
     * of any row's share of its own gross. See `Reports.tsx` § THE CAVEAT
     * DECISION for why a proportional cut-off is wrong in both directions.
     */
    const barely = report(
      [row('Kuwait City', 12, 40_000, 1, 1), row('Salmiya', 9, 39_999, 0, 0)],
      79_999,
    );
    const { container } = render(<BranchAssumedCaveat report={barely} />);
    expect(container.innerHTML).not.toBe('');
    expect(container.textContent).toMatch(/Branch assumed on Kuwait City/);
  });

  it('reuses the Overview’s sentence verbatim rather than inventing a fourth', () => {
    render(<BranchAssumedCaveat report={BIASED} />);
    /* `.textContent`, not a jest-dom matcher — this project registers none. */
    expect(screen.getByText(/treat these branch figures as approximate/).textContent).toBe(
      'Branch assumed on Kuwait City — treat these branch figures as approximate.',
    );
  });

  it('names every doubted branch, joined without an Oxford comma', () => {
    const two = report(
      [row('Kuwait City', 40, 90_000, 30, 70_000), row('Salmiya', 8, 20_000, 2, 5_000)],
      110_000,
    );
    render(<BranchAssumedCaveat report={two} />);
    expect(screen.getByText(/Branch assumed on/).textContent).toBe(
      'Branch assumed on Kuwait City and Salmiya — treat these branch figures as approximate.',
    );
  });

  it('names only the doubted branches, not every branch on the card', () => {
    render(<BranchAssumedCaveat report={BIASED} />);
    const line = screen.getByText(/Branch assumed on/).textContent ?? '';
    expect(line).toContain('Kuwait City');
    expect(line).not.toContain('Salmiya');
    expect(line).not.toContain('Hawalli');
  });

  it('says the ORDER is not a ranking — the thing tiles never had to say', () => {
    /*
     * `Overview.tsx § AssumedNote` qualifies FIGURES, and four tiles side by side
     * have no order to qualify. Here the lowest branch id can sit at the top of
     * the table for want of an enrolled scanner, and the reused sentence does not
     * cover that. If this assertion is ever deleted, the card is back to
     * qualifying the cells and leaving the league table unqualified.
     */
    const { container } = render(<BranchAssumedCaveat report={BIASED} />);
    expect(container.textContent).toMatch(/that order is not a ranking/);
    expect(container.textContent).toMatch(/not enrolled/);
  });

  it('is announced, so a caveat that appears after a refetch is not silent', () => {
    const { container } = render(<BranchAssumedCaveat report={BIASED} />);
    expect(container.querySelector('.reports__assumed')?.getAttribute('role')).toBe('status');
  });
});

describe('the headline is exact salon-wide and assumed under a branch filter', () => {
  it('says the salon total is unaffected at branch=all', () => {
    /*
     * A row attributed to the wrong branch is still inside the salon, so the sum
     * over every branch is exact however many rows are assumed — the same
     * distinction `AssumedNote` draws when it says nothing at `branch=all`.
     */
    const { container } = render(<BranchAssumedCaveat report={BIASED} />);
    expect(container.textContent).toMatch(/The total above is unaffected/);
  });

  it('says the opposite under a branch filter, where the headline IS the attribution', () => {
    const filtered = report([row('Kuwait City', 402, 1_234_567, 400, 1_228_567)], 1_234_567, 'BR-KWC');
    const { container } = render(<BranchAssumedCaveat report={filtered} />);
    expect(container.textContent).toMatch(/carries the same assumption/);
    expect(container.textContent).not.toMatch(/The total above is unaffected/);
  });
});

describe('one branch entirely assumed, and every branch zero', () => {
  /**
   * The two states the brief singled out. Neither is the `rows.length === 0`
   * empty the other four cards use: a salon has branches, so this card always has
   * rows and that branch is unreachable here.
   */
  const ENTIRELY_ASSUMED = report(
    [row('Kuwait City', 3, 7_000, 3, 7_000), row('Salmiya', 0, 0, 0, 0)],
    7_000,
  );
  const ALL_ZERO = report(
    [row('Kuwait City', 0, 0, 0, 0), row('Salmiya', 0, 0, 0, 0)],
    0,
  );

  it('shows Gross and Assumed as the same figure rather than hiding the row', () => {
    /*
     * Lane A's drive: a real charge on an un-enrolled scanner moved Kuwait City
     * by the whole 7.000 and Salmiya by nothing. The table must show that as two
     * equal cells — the ratio IS the magnitude, which is why no percentage and no
     * threshold is offered.
     */
    const { container } = render(<BranchRows report={ENTIRELY_ASSUMED} />);
    const kwc = renderedRows(container)[0];
    expect(kwc?.cells[2]?.text).toBe('7.000');
    expect(kwc?.cells[3]?.text).toBe('7.000');
    expect(kwc?.cells[1]?.text).toBe('3');
    expect(kwc?.cells[4]?.text).toBe('3');
  });

  it('renders the whole table of zeros and names the window that produced it', () => {
    /*
     * A true zero the API answered is information; the table is not blanked. The
     * sentence exists because a full table of 0.000 is at a glance
     * indistinguishable from a filter mistake.
     */
    const rows = render(<BranchRows report={ALL_ZERO} />);
    expect(renderedRows(rows.container)).toHaveLength(2);
    expect(rows.container.textContent).toContain('0.000');

    const note = render(<BranchEarningsNote report={ALL_ZERO} />);
    expect(note.container.querySelector('.reports__note-empty')?.textContent).toBe(
      'Nothing was charged this month, so every row is zero.',
    );
  });

  it('carries no caveat when every branch is zero — there is nothing to doubt', () => {
    const { container } = render(<BranchAssumedCaveat report={ALL_ZERO} />);
    expect(container.innerHTML).toBe('');
  });

  it('names the branch under a filter in the all-zero sentence', () => {
    const filteredZero = report([row('Salmiya', 0, 0, 0, 0)], 0, 'BR-SAL');
    const { container } = render(<BranchEarningsNote report={filteredZero} />);
    expect(container.querySelector('.reports__note-empty')?.textContent).toBe(
      'Nothing was charged this month at this branch, so every row is zero.',
    );
  });

  it('drops the all-zero sentence as soon as the period took money', () => {
    const { container } = render(<BranchEarningsNote report={BIASED} />);
    expect(container.querySelector('.reports__note-empty')).toBeNull();
  });
});

describe('the note says what the columns cannot', () => {
  it('states that gross is the visit and not the charge row', () => {
    /*
     * The dashboard half of DECISIONS.md 81/83 — `sales` under-reported by 34.6%
     * by treating the charge as the value of the visit. This card sums the same
     * `earned_fils`, so the definition has to travel with it.
     */
    const { container } = render(<BranchEarningsNote report={BIASED} />);
    expect(container.textContent).toMatch(/wallet charge plus any deposit applied/);
  });

  it('states that a top-up has no row here', () => {
    const { container } = render(<BranchEarningsNote report={BIASED} />);
    expect(container.textContent).toMatch(/Top-ups never appear here/);
  });

  it('states that a closed branch still has a row — at branch=all only', () => {
    const { container } = render(<BranchEarningsNote report={BIASED} />);
    expect(container.textContent).toMatch(/has since closed/);
  });

  it('drops the every-branch sentence under a branch filter', () => {
    /*
     * Under a filter the row set is one branch the merchant chose, so "every
     * branch has a row" over a single-row table invites her to count her
     * branches against it and conclude the card has lost two.
     */
    const filtered = report([row('Salmiya', 3, 6_000, 0, 0)], 6_000, 'BR-SAL');
    const { container } = render(<BranchEarningsNote report={filtered} />);
    expect(container.textContent).not.toMatch(/Every branch has a row/);
    expect(container.textContent).toMatch(/Top-ups never appear here/);
  });

  it('prints no subtotal it computed itself', () => {
    const rows = render(<BranchRows report={BIASED} />);
    const note = render(<BranchEarningsNote report={BIASED} />);
    expect(`${rows.container.textContent}${note.container.textContent}`).not.toMatch(
      /subtotal|total of|adds up to/i,
    );
  });
});

describe('the gate is the server’s, and a refusal is a state (#7)', () => {
  /**
   * `earnings-by-branch` is `dashboard`, the same gate as `sales`
   * (`api/src/services/reports.ts` § REPORT_PERMISSION). Nothing on this client
   * checks it — a courtesy gate here would be a second check that drifts from
   * the real one. What the client owes is that the refusal RENDERS, titled,
   * without a retry, and without taking the five cards beside it down.
   */
  const FORBIDDEN = new ApiError(
    'You need the Overview permission for this. An owner can grant it in Accounts → Team.',
    { status: 403, code: 'forbidden' },
  );

  it('names the refused report even though the wire sent no title', () => {
    expect(fallbackTitle('earnings-by-branch')).toBe('Earnings by branch');
  });

  it('renders the server’s own sentence and offers no retry', () => {
    const { container } = render(
      <ReportCardRefusal error={FORBIDDEN} onRetry={() => {}} retrying={false} />,
    );
    expect(container.textContent).toContain('You don’t have access to this report'.replace('’', "'"));
    expect(container.textContent).toContain('Accounts → Team');
    /* An identical request produces an identical refusal. */
    expect(container.querySelector('button')).toBeNull();
  });
});

describe('the card routes this kind to the branch table, and puts the caveat first', () => {
  /**
   * =========================================================================
   * THE ASSERTIONS THAT COULD NOT BE MADE BEFORE THIS SLICE
   * =========================================================================
   * The row renderer and the caveat's placement were inline in `ReportCard`,
   * which needs a query client, a session and a branch scope — so "which
   * renderer does this kind get" and "is the caveat above the table" were
   * readable in the source and unprovable in a tree. `ReportLoadedBody` takes a
   * kind and a report and nothing else, for exactly this.
   */
  function positionsIn(container: HTMLElement) {
    const nodes = [...container.querySelectorAll('.reports__assumed, .reports__table, .reports__note')];
    return nodes.map((n) => n.className);
  }

  it('renders the branch table, not the artist grouping', () => {
    const { container } = render(<ReportLoadedBody kind="earnings-by-branch" report={BIASED} />);
    expect(container.querySelectorAll('.reports__group')).toHaveLength(0);
    expect(container.textContent).not.toMatch(/No artists on the roster/);
    expect(container.querySelectorAll('.reports__row')).toHaveLength(3);
  });

  it('puts the caveat ABOVE the table and the footnote below it', () => {
    /*
     * THE PLACEMENT ARGUMENT, ASSERTED. A caveat printed under a ranking arrives
     * after the reader has formed the conclusion it was meant to qualify. If
     * this ever reads table-then-caveat, the card is telling her how to read
     * something she has already read.
     */
    const { container } = render(<ReportLoadedBody kind="earnings-by-branch" report={BIASED} />);
    expect(positionsIn(container)).toEqual(['reports__assumed', 'reports__table', 'reports__note']);
  });

  it('draws the five headers the server sent, in its order, aligned by type', () => {
    const { container } = render(<ReportLoadedBody kind="earnings-by-branch" report={BIASED} />);
    const cols = [...container.querySelectorAll('.reports__col')];
    expect(cols.map((c) => c.textContent)).toEqual([
      'Branch',
      'Transactions',
      'Gross KD',
      'Assumed KD',
      'Assumed transactions',
    ]);
    expect(cols.map((c) => c.getAttribute('data-numeric') !== null)).toEqual([
      false,
      true,
      true,
      true,
      true,
    ]);
  });

  it('does not slice this kind to a three-row preview', () => {
    /*
     * The other four cards preview a file; this one IS the answer, and a
     * four-branch salon sliced to three is three branches chosen by a sort the
     * reader cannot see.
     */
    const four = report(
      [
        row('Kuwait City', 402, 1_234_567, 400, 1_228_567),
        row('Salmiya', 3, 6_000, 0, 0),
        row('Hawalli', 0, 0, 0, 0),
        row('Fahaheel', 1, 2_000, 0, 0),
      ],
      1_242_567,
    );
    const { container } = render(<ReportLoadedBody kind="earnings-by-branch" report={four} />);
    expect(container.querySelectorAll('.reports__row')).toHaveLength(4);
  });

  it('leaves the other four kinds on their three-row preview', () => {
    /*
     * The control. Everything above is about the two full tables; this asserts
     * the extraction did not quietly widen them to every kind.
     */
    const sales = {
      ...BIASED,
      kind: 'sales' as const,
      columns: [
        { header: 'Date', key: 'date', type: 'text' as const },
        { header: 'Transactions', key: 'transactions', type: 'int' as const },
        { header: 'Gross KD', key: 'grossFils', type: 'money' as const },
        { header: 'Branch', key: 'branch', type: 'text' as const },
      ],
      rows: [1, 2, 3, 4, 5].map((n) => ({
        date: `2026-09-0${n}`,
        transactions: n,
        grossFils: n * 1_000,
        branch: 'Kuwait City',
      })),
      rowCount: 5,
    };
    const { container } = render(<ReportLoadedBody kind="sales" report={sales} />);
    expect(container.querySelectorAll('.reports__row')).toHaveLength(3);
    expect(container.querySelector('.reports__assumed')).toBeNull();
    expect(container.querySelector('.reports__note')).toBeNull();
  });

  it('carries no caveat and no branch note on a kind that has neither column', () => {
    const sales = { ...BIASED, kind: 'sales' as const };
    const { container } = render(<ReportLoadedBody kind="sales" report={sales} />);
    expect(container.textContent).not.toMatch(/Branch assumed on/);
  });
});
