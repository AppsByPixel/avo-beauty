/**
 * THE DEPOSIT QUEUE'S RULES AND ITS COPY, ASSERTED WITHOUT A RENDERER.
 *
 * `depositHealthRender.test.tsx` drives the screen. This file holds the two
 * guarantees that are properties of the DATA rather than of the paint, and that a
 * render test can only sample:
 *
 *   THE PARTITION IS NOT A RE-RANK. `rows[]` arrives `starts_at ASC` — a queue —
 *   and the three framings require it to be split three ways. A split is only
 *   safe if every part is a SUBSEQUENCE of the original, and that is a property
 *   over all inputs, not something three fixture rows can establish.
 *
 *   THE THREE FRAMINGS NEVER SHARE A SENTENCE. A screen that lumps
 *   `awaiting_arrival`, `return_overdue` and `unclosed` into one "problem
 *   appointments" list tells a merchant her customers are unreliable when in fact
 *   AVO's own job is stuck. The table is where that becomes unrepresentable, so
 *   the table is where distinctness is asserted.
 */

import { describe, expect, it } from 'vitest';
import type { DepositRow, DepositState } from '../api/deposits.js';
import { fils } from '@avo/types';
import {
  DEPOSIT_FRAMING,
  DEPOSIT_SECTION_ORDER,
  formatElapsed,
  groupByState,
  partyFor,
} from './depositHealthRules.js';

/* ---------------------------------------------------------------- fixtures */

/**
 * A well-formed row. Every field the endpoint documents is present, because a
 * partial fixture is how a parser or a rule comes to be exercised against a
 * record the wire never sends.
 */
function row(over: Partial<DepositRow> & { bookingId: string; state: DepositState }): DepositRow {
  return {
    memberId: 'MB-1a2b3c4d5e',
    memberName: 'Latifa A.',
    memberErased: false,
    memberPhone: '+96599124408',
    guestName: null,
    guestPhone: null,
    artistId: 'AR-01',
    artistName: 'Dana',
    serviceName: 'Balayage',
    branchId: 'BR-SAL',
    branchName: 'Salmiya',
    branchAssumed: false,
    startsAt: '2026-09-27T05:00:00.000Z',
    endsAt: '2026-09-27T06:30:00.000Z',
    durationMin: 90,
    depositFils: fils(18000),
    noShowReturnDueAt: '2026-09-27T07:30:00.000Z',
    source: 'customer',
    overdueMinutes: 40,
    returnOverdueMinutes: null,
    ...over,
  };
}

const COUNTS = (awaiting: number, overdueReturn: number, unclosed: number) => ({
  awaiting_arrival: awaiting,
  return_overdue: overdueReturn,
  unclosed,
});

/**
 * THREE ROWS IN WHICH EVERY ORDERING FIELD IS SCRAMBLED THE SAME WAY — the
 * served row is the MIDDLE value, then the LARGEST, then the SMALLEST — so that
 * no ascending or descending sort on any one of them reproduces the served
 * order. The test below proves that property rather than assuming it.
 *
 * `startsAt` IS OUT OF ORDER ON PURPOSE, although the server always sends
 * `starts_at ASC`. `groupByState` must not RE-IMPOSE an order, not even the
 * right one: a function that sorted by slot would pass every realistic fixture
 * and still be a function that decides the order, one edit away from deciding it
 * by something else.
 */
const SCRAMBLED: DepositRow[] = [
  row({
    bookingId: 'A',
    state: 'return_overdue',
    depositFils: fils(40_000),
    memberName: 'Mariam',
    overdueMinutes: 400,
    returnOverdueMinutes: 400,
    startsAt: '2026-09-26T10:00:00.000Z',
  }),
  row({
    bookingId: 'B',
    state: 'return_overdue',
    depositFils: fils(900_000),
    memberName: 'Zahra',
    overdueMinutes: 9000,
    returnOverdueMinutes: 9000,
    startsAt: '2026-09-26T11:00:00.000Z',
  }),
  row({
    bookingId: 'C',
    state: 'return_overdue',
    depositFils: fils(1_000),
    memberName: 'Aisha',
    overdueMinutes: 5,
    returnOverdueMinutes: 5,
    startsAt: '2026-09-26T09:00:00.000Z',
  }),
];

/* =========================================================== the partition = */

describe('grouping the queue is not re-ranking it', () => {
  /**
   * THE SUBSEQUENCE PROPERTY, OVER AN INTERLEAVED QUEUE.
   *
   * This is the assertion the whole grouping rests on: whatever order the server
   * sent, every group must come out in THAT relative order. Interleaved on
   * purpose — a queue that happened to arrive already grouped would satisfy a
   * naive `filter` and also satisfy a `sort` by anything, which is the failure
   * this pins against.
   */
  it('preserves the served order inside every group', () => {
    const served = [
      row({ bookingId: 'BK-1', state: 'unclosed' }),
      row({ bookingId: 'BK-2', state: 'return_overdue' }),
      row({ bookingId: 'BK-3', state: 'awaiting_arrival' }),
      row({ bookingId: 'BK-4', state: 'return_overdue' }),
      row({ bookingId: 'BK-5', state: 'unclosed' }),
      row({ bookingId: 'BK-6', state: 'awaiting_arrival' }),
    ];

    const groups = groupByState(served, COUNTS(2, 2, 2));
    const byState = Object.fromEntries(groups.map((g) => [g.state, g.rows.map((r) => r.bookingId)]));

    expect(byState.return_overdue).toEqual(['BK-2', 'BK-4']);
    expect(byState.awaiting_arrival).toEqual(['BK-3', 'BK-6']);
    expect(byState.unclosed).toEqual(['BK-1', 'BK-5']);

    // …and every group is a SUBSEQUENCE of the served list, stated as the
    // property rather than as three hand-checked lists.
    const servedIds = served.map((r) => r.bookingId);
    for (const group of groups) {
      const positions = group.rows.map((r) => servedIds.indexOf(r.bookingId));
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    }
  });

  /**
   * NOTHING IN THE GROUPING LOOKS AT THE PERSON OR AT HER MONEY.
   *
   * The constraint this feature is under is that no surface ranks women by how
   * much they owe or how often they miss. The way that gets broken is not a
   * `sort` call somebody writes on purpose — it is a "helpful" tie-break added to
   * a grouping that already existed.
   *
   * ===========================================================================
   * EVERY ORDERING FIELD IS SCRAMBLED INDEPENDENTLY, AND THIS SPEC EARNED THAT
   * ===========================================================================
   * It was written with the four fields varying but `overdueMinutes` left at the
   * fixture default on all three rows — so a `sort((a, b) => b.overdueMinutes -
   * a.overdueMinutes)` spliced into `groupByState` was a NO-OP here and the spec
   * passed with the ranking in place. Found by mutation, not by reading.
   *
   * So each of the five fields a tie-break could plausibly reach —
   * `depositFils`, `memberName`, `overdueMinutes`, `returnOverdueMinutes`,
   * `startsAt` — is in a DIFFERENT order from the served one, and from each
   * other. There is no permutation of these rows that any single-key sort
   * reproduces, ascending or descending, which is the only version of this
   * assertion that a sort cannot satisfy by accident.
   */
  it('does not reorder by deposit, by name, by how long a row has waited, or by slot', () => {
    const [first] = groupByState(SCRAMBLED, COUNTS(0, 3, 0));
    expect(first?.rows.map((r) => r.bookingId)).toEqual(['A', 'B', 'C']);
  });

  /**
   * THE SAME CLAIM, STATED AS A PROPERTY OF THE FIXTURE RATHER THAN TRUSTED.
   *
   * The assertion above is only as good as `SCRAMBLED`, and `SCRAMBLED` is
   * exactly what was wrong the first time. This checks every ordering field: for
   * each one, the served order must be NEITHER its ascending NOR its descending
   * order. Given that, "the output equals the served order" above cannot also be
   * satisfied by any single-key sort.
   *
   * IT HAS ALREADY EARNED ITS KEEP. Written to guard the mutation that survived,
   * it immediately failed on `memberName` — the three names were in descending
   * alphabetical order, so a re-rank by name would have been a no-op and the
   * spec above would have passed with the ranking in place. The second hollow
   * fixture in the same test, caught by the check rather than by reading it.
   */
  it('is sorted by none of the fields a tie-break could reach', () => {
    const keys: Array<[string, (r: DepositRow) => number | string]> = [
      ['depositFils', (r) => r.depositFils],
      ['memberName', (r) => r.memberName ?? ''],
      ['overdueMinutes', (r) => r.overdueMinutes],
      ['returnOverdueMinutes', (r) => r.returnOverdueMinutes ?? 0],
      ['startsAt', (r) => r.startsAt],
    ];

    const servedIds = SCRAMBLED.map((r) => r.bookingId);
    for (const [name, key] of keys) {
      const cmp = (a: DepositRow, b: DepositRow) =>
        key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
      const asc = [...SCRAMBLED].sort(cmp).map((r) => r.bookingId);
      const desc = [...SCRAMBLED].sort((a, b) => cmp(b, a)).map((r) => r.bookingId);
      expect(asc, `the fixture is already sorted ascending by ${name}`).not.toEqual(servedIds);
      expect(desc, `the fixture is already sorted descending by ${name}`).not.toEqual(servedIds);
    }
  });

  /**
   * THE COUNT IS THE SERVER'S AND `rows.length` IS NOT IT.
   *
   * The row list caps at 200 and the counts are exact, so a group can carry a
   * count it has no rows for. `DepositHealth.tsx` renders the difference rather
   * than hiding it, and that is only possible if the count survives the grouping.
   */
  it('carries the server’s count even where the cap left the group empty', () => {
    const groups = groupByState([row({ bookingId: 'BK-1', state: 'unclosed' })], COUNTS(30, 200, 1));
    const awaiting = groups.find((g) => g.state === 'awaiting_arrival');
    expect(awaiting?.bookings).toBe(30);
    expect(awaiting?.rows).toHaveLength(0);
  });

  it('always returns all three groups, in the section order', () => {
    expect(groupByState([], COUNTS(0, 0, 0)).map((g) => g.state)).toEqual([
      ...DEPOSIT_SECTION_ORDER,
    ]);
  });
});

/* ============================================================ the framings = */

describe('the three states never share a sentence', () => {
  it('gives each state its own title, body, caption and column head', () => {
    const framings = Object.values(DEPOSIT_FRAMING);
    for (const key of ['title', 'body', 'caption', 'elapsedHead'] as const) {
      const values = framings.map((f) => f[key]);
      expect(new Set(values).size, `two states share a ${key}`).toBe(framings.length);
    }
  });

  it('has a framing for every state the section order draws', () => {
    for (const state of DEPOSIT_SECTION_ORDER) {
      expect(DEPOSIT_FRAMING[state]).toBeTruthy();
      expect(DEPOSIT_FRAMING[state].body.length).toBeGreaterThan(40);
    }
  });

  /**
   * ===========================================================================
   * `return_overdue` SAYS NOTHING THE CUSTOMER DID. THIS IS THE FEATURE.
   * ===========================================================================
   * `services/noShowWorker.ts` selects on exactly this predicate, so a row here
   * is a row the job was supposed to have taken and has not — an operational
   * signal about AVO. She may well have no-showed; she also may have cancelled in
   * a way that failed, or the worker may be down for everybody. Counting her
   * beside the customers in `awaiting_arrival`, or describing her with the
   * vocabulary of a missed appointment, turns "our worker is stuck" into "these
   * women do not turn up" — a claim about named people made out of our own
   * outage.
   *
   * THE VOCABULARY SCAN IS THE GUARANTEE AND THE VERBATIM ASSERTION IS THE PIN.
   * Asserting only the exact string would pass on a rewrite that kept none of the
   * meaning; scanning only for words would pass on a copy that said nothing at
   * all. `depositHealthRender.test.tsx` then proves the same words reach the DOM
   * under the right rows, which is the half a rules test cannot see.
   */
  const BLAME = [
    'no-show',
    'no show',
    'did not come',
    "didn't come",
    'did not turn up',
    "didn't turn up",
    'missed',
    'failed to',
    'unreliable',
    'repeatedly',
    'her fault',
    'she did not',
  ];

  it('frames return_overdue as ours and never as hers', () => {
    const { title, body, caption, elapsedHead } = DEPOSIT_FRAMING.return_overdue;
    const all = `${title} ${body} ${caption} ${elapsedHead}`.toLowerCase();
    for (const word of BLAME) {
      expect(all, `return_overdue copy contains "${word}"`).not.toContain(word);
    }

    // It names AVO as the party that owes, and says there is nothing for the
    // merchant to do — a section describing our fault that offered her nothing
    // would read as a reprimand.
    expect(body).toContain('Settling it runs on our side, not hers');
    expect(body).toContain('nothing for you to do here');
    expect(title).toBe('Waiting on us to settle');
    // Since 0066 a missed slot can keep the deposit, so no direction is claimed.
    expect(all).not.toContain('owe this money');
    expect(all).not.toContain('already hers');
  });

  /**
   * `unclosed` MUST NOT READ AS A DEBT EITHER. Nothing is owed on these rows —
   * there is no money behind them at all — so copy that talked about returning,
   * owing or waiting would invent an obligation out of a salon's book-keeping.
   */
  it('frames unclosed as book-keeping, with nothing owed to anyone', () => {
    const { body } = DEPOSIT_FRAMING.unclosed;
    expect(body).toContain('No money is held and nobody is owed anything');
    expect(body.toLowerCase()).not.toContain('return');
    for (const word of BLAME) {
      expect(body.toLowerCase(), `unclosed copy contains "${word}"`).not.toContain(word);
    }
  });

  /**
   * `awaiting_arrival` IS THE ONE THAT IS ABOUT A CUSTOMER, and it still does not
   * conclude anything about her — the grace window the SALON chose has not run
   * out, so the only true statement is that nothing has settled yet.
   */
  it('frames awaiting_arrival as still waiting rather than as late', () => {
    const { title, body } = DEPOSIT_FRAMING.awaiting_arrival;
    expect(title).toBe('Still within the grace window');
    expect(body).toContain('nothing settles until');
    for (const word of BLAME) {
      expect(body.toLowerCase(), `awaiting_arrival copy contains "${word}"`).not.toContain(word);
    }
  });

  /**
   * AVO'S OWN BACKLOG IS READ FIRST. A merchant scanning this screen should meet
   * our failure before she meets anything that could be read as her customers' —
   * putting the customer-shaped section at the top would set the frame for
   * everything under it.
   */
  it('draws the section that is ours before the one that is about a customer', () => {
    expect(DEPOSIT_SECTION_ORDER.indexOf('return_overdue')).toBeLessThan(
      DEPOSIT_SECTION_ORDER.indexOf('awaiting_arrival'),
    );
  });
});

/* ============================================================= the elapsed = */

describe('the elapsed figure floors and never rounds up', () => {
  it.each([
    [0, 'under a minute'],
    [0.4, 'under a minute'],
    [1, '1m'],
    [59, '59m'],
    [60, '1h'],
    [61, '1h 1m'],
    [135, '2h 15m'],
    [1439, '23h 59m'],
    [1440, '1d'],
    [1500, '1d 1h'],
    [4380, '3d 1h'],
  ])('%i minutes reads as %s', (minutes, expected) => {
    expect(formatElapsed(minutes)).toBe(expected);
  });

  /**
   * 29 SECONDS PAST A SLOT IS NOT "1m", AND IT IS NOT "0m" EITHER. The server
   * floors to whole minutes and sends 0; printing `0m` beside a row reads as a
   * missing value, which is the one thing it is not.
   */
  it('never claims more time has passed than has', () => {
    expect(formatElapsed(0)).toBe('under a minute');
    expect(formatElapsed(119)).toBe('1h 59m');
    expect(formatElapsed(2879)).toBe('1d 23h');
  });
});

/* ================================================================= the party */

describe('who a row is about', () => {
  it('reads a member', () => {
    expect(partyFor(row({ bookingId: 'BK-1', state: 'awaiting_arrival' }))).toEqual({
      kind: 'member',
      name: 'Latifa A.',
      phone: '+96599124408',
    });
  });

  it('reads a walk-in off guestName, with her own number', () => {
    const guest = row({
      bookingId: 'BK-2',
      state: 'unclosed',
      memberId: null,
      memberName: null,
      memberPhone: null,
      guestName: 'Maha (walk-in)',
      guestPhone: '+96566001122',
      depositFils: fils(0),
    });
    expect(partyFor(guest)).toEqual({
      kind: 'guest',
      name: 'Maha (walk-in)',
      phone: '+96566001122',
    });
  });

  /**
   * ERASURE IS THE FLAG AND NEVER THE PREFIX. `serialiseMemberContact` keeps the
   * `+990` tombstone off the wire, so `memberPhone` is already null — and this
   * returns null regardless, so a server that ever stopped stripping it could not
   * put a tombstone on this screen. DECISIONS #100; this lane has shipped the
   * prefix failure twice.
   */
  it('holds no number for an erased member, whatever the wire carries', () => {
    const erased = row({
      bookingId: 'BK-3',
      state: 'return_overdue',
      memberName: 'Deleted account',
      memberErased: true,
      memberPhone: '+990123456789012',
    });
    expect(partyFor(erased)).toEqual({ kind: 'erased', name: 'Deleted account', phone: null });
  });

  /**
   * THE ROW `booking_identity_exactly_one` SAYS CANNOT ARRIVE still renders
   * something a merchant can act on — a booking reference — rather than a blank
   * cell or an invented name.
   */
  it('falls back to the booking reference rather than to a blank or a guess', () => {
    const orphan = row({
      bookingId: 'BK-9f8e7d',
      state: 'unclosed',
      memberId: null,
      memberName: null,
      memberPhone: null,
    });
    expect(partyFor(orphan)).toEqual({ kind: 'unknown', name: 'BK-9f8e7d', phone: null });
  });
});
