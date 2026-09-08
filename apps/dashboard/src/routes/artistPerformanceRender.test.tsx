// @vitest-environment jsdom

/**
 * Merchant → Reports → Artist performance, rendered.
 *
 * =========================================================================
 * WHY THIS FILE RENDERS INSTEAD OF READING THE SOURCE
 * =========================================================================
 * The four guarantees below are all statements about the DOM this card produces,
 * and every one of them survives a source-text scan of the kind
 * `stateCensus.test.ts` uses. `moneyRender.test.tsx` opened the door (DECISIONS.md
 * #38: a guard that reads the source asserts what the code SAYS and stays green
 * through any refactor that keeps the words and loses the behaviour), and this is
 * the second subject that genuinely needs it:
 *
 *   1. THE TWO UNATTRIBUTED ROWS ARE OUT OF THE RANKING. "Walk-in charges" and
 *      "Shop orders" are not people. They are appended after the artist rows by
 *      the server, so a naive render puts 8.000 KD below two artists at 0.000 and
 *      the column reads as a broken sort — or worse, as a walk-in competing for
 *      "top earner". Only the rendered tree can show which group each row landed
 *      in.
 *   2. NOTHING IS DROPPED FOR BEING ZERO. A merchant deciding a bonus has to be
 *      able to tell "this artist earned nothing" from "this money has no artist",
 *      which needs BOTH a true-zero artist row and a zero bucket row on screen.
 *      A filter that hid either would still leave the words in the source.
 *   3. EVERY ROW IS RENDERED, so the table accounts for the headline. The other
 *      four report cards slice to three rows; this one cannot, and the assertion
 *      that catches a reintroduced `.slice(0, 3)` is a count of rendered rows.
 *   4. THE MONEY COLUMNS ADD UP TO THE STAT — read off the SCREEN, not out of the
 *      fixture. This is the test that would have caught the `sales` defect of
 *      DECISIONS.md 81/83 in its dashboard half: a card showing only `Charged KD`
 *      under a heading a merchant reads as earnings.
 *
 * Cleanup is manual for the reason `moneyRender.test.tsx` spells out — no
 * `globals: true` in this project, so `@testing-library/react` registers no
 * `afterEach(cleanup)` of its own and the second render in a file starts failing
 * with "Found multiple elements", which points at the component instead of at the
 * leftovers.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AttributedRows, AttributionNote, cellText } from './Reports.js';
import type { Report } from '../api/reports.js';

afterEach(cleanup);

/** The eight columns the server sends, verbatim — `api/src/services/reports.ts`. */
const COLUMNS: Report['columns'] = [
  { header: 'Attributed to', key: 'attributedTo', type: 'text' },
  { header: 'Attribution', key: 'attribution', type: 'text' },
  { header: 'Staff account', key: 'staffAccount', type: 'text' },
  { header: 'Customers', key: 'customers', type: 'int' },
  { header: 'Appointments', key: 'appointments', type: 'int' },
  { header: 'Charged KD', key: 'chargedFils', type: 'money' },
  { header: 'Deposit applied KD', key: 'depositAppliedFils', type: 'money' },
  { header: 'Earned KD', key: 'earnedFils', type: 'money' },
];

function row(
  attributedTo: string,
  attribution: string,
  staffAccount: string,
  customers: number,
  appointments: number,
  chargedFils: number,
  depositAppliedFils: number,
): Record<string, string | number | null> {
  return {
    attributedTo,
    attribution,
    staffAccount,
    customers,
    appointments,
    chargedFils,
    depositAppliedFils,
    /* The server adds the two integers; so does this fixture, for the same reason. */
    earnedFils: chargedFils + depositAppliedFils,
  };
}

/**
 * The shape the real API answered for the seeded salon, read off the wire during
 * verification rather than invented — four artists, two of them at true zeros, one
 * with a staff login and two without, plus the two always-emitted buckets.
 *
 * `stat.value` is the SERVER's sum over every row (29.000 KD), written here as the
 * number the server sent. The tests below re-derive it from the rendered cells; if
 * this constant and those cells ever disagree, that is the finding.
 */
function report(rows: Report['rows'], statValue: number): Report {
  return {
    kind: 'artist-performance',
    title: 'Artist performance',
    period: '30d',
    branchId: 'all',
    columns: COLUMNS,
    rows,
    stat: { key: 'earnedFils', label: 'KD earned', value: statValue, type: 'money' },
    rowCount: rows.length,
  };
}

const SEEDED = report(
  [
    row('Rana Al-Sabah', 'artist', 'no staff account', 1, 1, 10_000, 5_000),
    row('Hessa M.', 'artist', 'hessa', 1, 1, 1_000, 5_000),
    row('Dana Yousef', 'artist', 'no staff account', 0, 0, 0, 0),
    row('Shaikha B.', 'artist', 'no staff account', 0, 0, 0, 0),
    row('Walk-in charges', 'no artist', '', 1, 0, 8_000, 0),
    row('Shop orders', 'no artist', '', 0, 0, 0, 0),
  ],
  29_000,
);

/** Every rendered row, in document order, with the group it landed in. */
function renderedRows(container: HTMLElement) {
  return [...container.querySelectorAll('.reports__row')].map((el) => ({
    unattributed: el.getAttribute('data-unattributed') !== null,
    cells: [...el.querySelectorAll('.reports__cell')].map((c) => c.textContent ?? ''),
  }));
}

describe('the two unattributed rows are never part of the ranking', () => {
  it('renders the artist rows and the buckets in two labelled groups', () => {
    const { container } = render(<AttributedRows report={SEEDED} />);

    const groups = [...container.querySelectorAll('.reports__group')].map((e) => e.textContent);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatch(/ranked/i);
    /*
     * The second heading has to say the buckets are OUT. "Unattributed" alone
     * would name the category and leave the ranking question open, which is the
     * reading fact #1 forbids.
     */
    expect(groups[1]).toMatch(/not part of the ranking/i);
  });

  it('marks exactly the two bucket rows as unattributed, and only them', () => {
    const { container } = render(<AttributedRows report={SEEDED} />);
    const rows = renderedRows(container);

    const unattributed = rows.filter((r) => r.unattributed).map((r) => r.cells[0]);
    expect(unattributed).toEqual(['Walk-in charges', 'Shop orders']);

    /*
     * AND THE ARTIST WHO EARNED NOTHING IS NOT ONE OF THEM. This is the assertion
     * that fails an implementation grouping by "did this row earn anything"
     * instead of by the server's `attribution` column — which would land two real
     * artists in the unattributed group and quietly relabel them as money with
     * nobody behind it.
     */
    expect(rows.filter((r) => !r.unattributed).map((r) => r.cells[0])).toEqual([
      'Rana Al-Sabah',
      'Hessa M.',
      'Dana Yousef',
      'Shaikha B.',
    ]);
  });

  it('puts the buckets after every artist row, whatever they earned', () => {
    const { container } = render(<AttributedRows report={SEEDED} />);
    const rows = renderedRows(container);
    const firstBucket = rows.findIndex((r) => r.unattributed);

    // A walk-in row earning 8.000 must still sit below an artist row of zeros.
    expect(firstBucket).toBe(4);
    expect(rows.slice(firstBucket).every((r) => r.unattributed)).toBe(true);
  });

  it('does not re-sort what the server ranked', () => {
    /*
     * The server orders by earnings DESC, then appointments, then name. A client
     * that sorted again would be a second implementation of the ranking, and the
     * first disagreement makes the card contradict the CSV built from the same
     * aggregate. Asserted by handing it rows in the server's order and requiring
     * them back unchanged — including the two zero rows, whose relative order
     * only the server's tiebreak explains.
     */
    const { container } = render(<AttributedRows report={SEEDED} />);
    expect(renderedRows(container).map((r) => r.cells[0])).toEqual(
      SEEDED.rows.map((r) => String(r['attributedTo'])),
    );
  });
});

describe('nothing is hidden for being zero', () => {
  it('renders an artist at true zeros', () => {
    const { container } = render(<AttributedRows report={SEEDED} />);
    const shaikha = renderedRows(container).find((r) => r.cells[0] === 'Shaikha B.');

    expect(shaikha).toBeDefined();
    // Zeros, drawn as money — not blanks, not em dashes, not an absent row.
    expect(shaikha?.cells.slice(5)).toEqual(['0.000', '0.000', '0.000']);
  });

  it('renders a zero Shop orders bucket', () => {
    /*
     * "No shop revenue this month" is a statement, and a useful one: it says
     * every dinar had an artist or a walk-in behind it. An absent row cannot be
     * told apart from a bucket that was never computed.
     */
    const { container } = render(<AttributedRows report={SEEDED} />);
    const shop = renderedRows(container).find((r) => r.cells[0] === 'Shop orders');

    expect(shop).toBeDefined();
    expect(shop?.unattributed).toBe(true);
    expect(shop?.cells.slice(5)).toEqual(['0.000', '0.000', '0.000']);
  });

  it('renders every row the server sent — no three-row preview', () => {
    /*
     * The guard against a reintroduced `.slice(0, 3)`, which is what the other
     * four cards do and what this one cannot: three rows here would cut both
     * buckets off, and the headline would stop being accounted for.
     */
    const { container } = render(<AttributedRows report={SEEDED} />);
    expect(renderedRows(container)).toHaveLength(SEEDED.rowCount);
  });
});

describe('the table on screen accounts for the headline', () => {
  it('sums the rendered Earned column to the stat the server sent', () => {
    const { container } = render(<AttributedRows report={SEEDED} />);

    /*
     * READ OFF THE RENDERED CELLS, in the display format, and compared against
     * the server's stat. Nothing in the card computes this — that is the rule
     * this screen keeps — so the test does the addition the merchant would do by
     * eye, which is the only place it is allowed to happen.
     */
    const earned = renderedRows(container).map((r) => Number(r.cells[7]?.replace('.', '')));
    expect(earned.reduce((a, b) => a + b, 0)).toBe(SEEDED.stat.value);
  });

  it('shows Earned as Charged plus Deposit applied on every row', () => {
    /*
     * The dashboard half of DECISIONS.md 81/83. `sales` under-reported by 34.6%
     * by treating the charge row as the value of the visit; an appointment a
     * deposit covered outright settles with a charge of exactly 0.000 and is not
     * a zero-earning appointment. A card that showed only `Charged KD` would
     * reintroduce it, so the relationship is asserted per row rather than trusted.
     */
    const { container } = render(<AttributedRows report={SEEDED} />);
    for (const r of renderedRows(container)) {
      const fils = (s: string) => Number(s.replace('.', ''));
      expect(fils(r.cells[7] ?? '')).toBe(fils(r.cells[5] ?? '') + fils(r.cells[6] ?? ''));
    }
  });

  it('does not print a subtotal it computed itself', () => {
    /*
     * A tempting addition and a forbidden one: a client-side "artists subtotal"
     * would sit beside the server's sum, and the day they diverge the card argues
     * with itself. Every row is present instead, which is what makes the
     * arithmetic checkable without a second implementation of it.
     */
    const { container } = render(<AttributedRows report={SEEDED} />);
    expect(container.textContent).not.toMatch(/subtotal/i);
  });
});

describe('a salon with no artists at all', () => {
  /**
   * The state the brief singled out, and it is neither an empty card nor the
   * `rows.length === 0` empty the other four kinds use — this kind always emits
   * the two buckets, so its row count has a floor of two and that branch is
   * unreachable here.
   */
  const NO_ARTISTS = report(
    [
      row('Walk-in charges', 'no artist', '', 2, 0, 20_000, 0),
      row('Shop orders', 'no artist', '', 1, 0, 2_500, 0),
    ],
    22_500,
  );

  it('names the absence instead of blanking the card', () => {
    const { container } = render(<AttributedRows report={NO_ARTISTS} />);

    const none = container.querySelector('.reports__none');
    expect(none?.textContent).toMatch(/No artists on the roster/i);
    // And it says where the fix is, per interaction-spec.md §4 on empty states.
    expect(none?.textContent).toMatch(/Team/);
  });

  it('still renders the revenue that has no artist behind it', () => {
    /*
     * THE MONEY IS REAL. A salon can take walk-in charges and shop orders with
     * nobody on the roster, so an empty card here would hide revenue in order to
     * report an absence.
     */
    const { container } = render(<AttributedRows report={NO_ARTISTS} />);
    const rows = renderedRows(container);

    expect(rows.map((r) => r.cells[0])).toEqual(['Walk-in charges', 'Shop orders']);
    expect(rows.every((r) => r.unattributed)).toBe(true);
    const earned = rows.map((r) => Number(r.cells[7]?.replace('.', '')));
    expect(earned.reduce((a, b) => a + b, 0)).toBe(NO_ARTISTS.stat.value);
  });
});

describe('the note that says what the numbers mean', () => {
  it('names the denominator, including the rows that do not exist', () => {
    render(<AttributionNote report={SEEDED} />);
    /*
     * Owed to this lane by lane A, deliberately: a top-up gets no row, and a
     * merchant reconciling this headline against her wallet takings will notice.
     * Stated on the card rather than left to be discovered as missing money.
     */
    expect(screen.getByText(/Top-ups never appear here/i)).toBeDefined();
    expect(screen.getByText(/not revenue in a period/i)).toBeDefined();
  });

  it('says Earned is the charge plus the deposit', () => {
    const { container } = render(<AttributionNote report={SEEDED} />);
    expect(container.textContent).toMatch(/wallet charge plus any deposit applied/i);
  });

  it('says nothing about an empty period when the period is not empty', () => {
    const { container } = render(<AttributionNote report={SEEDED} />);
    expect(container.querySelector('.reports__note-empty')).toBeNull();
  });

  it('names a period with no revenue, from the server stat and not from the rows', () => {
    /*
     * A period where nothing was charged renders as a full table of true zeros,
     * which is correct and also indistinguishable at a glance from a filter
     * mistake. The sentence is ADDED, not substituted — the roster is still worth
     * seeing, and this card is where a merchant learns every artist earned nothing.
     */
    const empty = report(
      [
        row('Rana Al-Sabah', 'artist', 'no staff account', 0, 0, 0, 0),
        row('Walk-in charges', 'no artist', '', 0, 0, 0, 0),
        row('Shop orders', 'no artist', '', 0, 0, 0, 0),
      ],
      0,
    );
    const { container } = render(<AttributionNote report={{ ...empty, branchId: 'BR-KWC' }} />);

    const line = container.querySelector('.reports__note-empty');
    expect(line?.textContent).toMatch(/Nothing was charged this month at this branch/i);
    // The two explanatory sentences stay; the zero line is one more, not a swap.
    expect(container.textContent).toMatch(/Top-ups never appear here/i);
  });
});

describe('cellText re-cases the tier and nothing else', () => {
  /**
   * The regression this fifth report exposed. The rule used to be "any
   * single-word lowercase text cell is a domain value", written when the tier was
   * the only one in the product; artist performance ships a LOGIN HANDLE and a
   * two-value enum through the same renderer.
   */
  it('capitalises the customer tier, which the wire sends lowercase', () => {
    expect(cellText('silver', 'text', 'tier')).toBe('Silver');
  });

  it('leaves a staff account handle exactly as the server sent it', () => {
    /*
     * `Hessa` is not the handle. The column exists so a row can be matched to an
     * account in Accounts → Team, and a re-cased handle is not a thing to match —
     * it reads as a person's name, in a column headed "Staff account", beside the
     * column that already holds her name.
     */
    expect(cellText('hessa', 'text', 'staffAccount')).toBe('hessa');
  });

  it('renders both values of the attribution enum the same way', () => {
    /*
     * `artist` matched the old pattern and `no artist` did not, so one value of a
     * two-value enum was capitalised and the other was not — an inconsistency
     * that looks like a data defect in the column whose whole job is to be the
     * reliable machine-readable half of "is this row a person".
     */
    expect(cellText('artist', 'text', 'attribution')).toBe('artist');
    expect(cellText('no artist', 'text', 'attribution')).toBe('no artist');
  });

  it('leaves an artist with no login reading as a value, not an error', () => {
    // `artist.staff_user_id` is nullable; `no staff account` is a real answer.
    expect(cellText('no staff account', 'text', 'staffAccount')).toBe('no staff account');
  });

  it('renders a blank staff account as blank, not as an em dash', () => {
    /*
     * The buckets carry `staffAccount: ''`. "Walk-in charges" is not a person, so
     * "which staff account" does not apply to it; an em dash would claim it does
     * and that the answer is unknown.
     */
    expect(cellText('', 'text', 'staffAccount')).toBe('');
  });

  it('still renders a genuinely null cell as an em dash', () => {
    expect(cellText(null, 'text', 'staffAccount')).toBe('—');
    expect(cellText(null, 'money', 'chargedFils')).toBe('—');
  });

  it('formats money to three decimals and never coerces a non-number', () => {
    expect(cellText(5_000, 'money', 'earnedFils')).toBe('5.000');
    // The parse should have caught it; the honest answer here is no figure.
    expect(cellText('5000' as unknown as number, 'money', 'earnedFils')).toBe('—');
  });
});
