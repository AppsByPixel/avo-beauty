/**
 * REPORTS, ADVERSARIALLY — the numbers and the bytes.
 *
 * `GET /salons/{id}/reports/{kind}` (JSON) and `{kind}.csv` merged with only their
 * author's unit tests. This file rebuilds the claims from the outside, on fixtures
 * deliberately UNLIKE lane A's: its fixture held one of each excluded shape, so the
 * shapes it did not hold are where the bugs would be. Everything below runs on a
 * dedicated branch (`BR-QA-RPT`) so every expected figure is hand-computable from this
 * file's own ledger, and the load-bearing sums are cross-checked in SQL against the run
 * database rather than believed from the endpoint's reply.
 *
 * WHAT WAS CHECKED AND COULD NOT BE BROKEN — the summary a reader wants first:
 *   exclusions (7 shapes), the sign convention, Kuwait-day grouping (vs UTC AND vs the
 *   host zone — this machine runs PKT, which UTC-only reasoning would miss), the CSV
 *   bytes down to the BOM and the doubled quotes, 404-vs-empty with byte-identical
 *   refusals, the rename-mid-window snapshot, and the customers↔metrics agreement.
 *
 * TWO DEFINITIONAL FINDINGS FOR TRUNK, driven below and reported rather than "fixed":
 *
 *   1. THE PERIOD IS A ROLLING INSTANT, NOT A CALENDAR WINDOW. `from = now − N days`
 *      is an instant, so "inside 30d in Kuwait but outside in UTC" is UNCONSTRUCTIBLE —
 *      an instant boundary has no zone. The salon's zone affects only the day LABELS.
 *      Consequence a merchant will eventually notice: the "7d" export taken at 09:00
 *      and at 17:00 cover different windows, and neither aligns to her calendar week.
 *      Consistent with metrics.ts; recorded so the choice is a decision, not a drift.
 *
 *   2. A STANDALONE WALLET CREDIT IS INVISIBLE TO EVERY REPORT. A void — adjustment
 *      REVERSING a charge — correctly removes the charge from gross. But a positive
 *      `adjustment` with `reverses_transaction_id NULL` (a goodwill credit, the #5
 *      "refund is wallet credit" shape when it is not a void of one specific charge)
 *      reduces NO figure anywhere: it is not gross (right — nothing was un-sold), not
 *      "loaded" (metrics counts topups). Money left the salon's liability ledger and no
 *      report shows it. Probably correct for "gross"; a gap if anyone reconciles
 *      wallet-liability from these exports. Trunk's call.
 *
 * WHAT THIS FILE IS BLIND TO, AND IT COST 34.6% OF A MERCHANT'S TAKINGS
 * --------------------------------------------------------------------
 * Recorded here, at the top, because the header above is where a reader looks to
 * decide whether the reports are covered — and for two defects the answer was no
 * while every line of it stayed true.
 *
 * DECISIONS.md #81 and #83: `sales` and `best-selling-services` summed
 * `-amount_fils` under a column labelled `gross`, and `charge.ts` § 4 writes
 * `-(gross − applied deposit)`, so every BOOKED appointment was understated by the
 * deposit it had already earned — 34.6% of a driven window — and a
 * `no_show_returned` booking scored NEGATIVE. Both shipped. This file was green
 * throughout, and MEASURED SO: with both defects reintroduced in a working tree,
 * all 22 specs below still pass, to the fils.
 *
 * The reason is one line of the fixture, not one missing assertion. The ledger
 * above holds a `deposit_hold` and a `deposit_return` but has NEVER held an
 * APPLIED deposit — a charge whose `deposit_held`/`debit` leg makes
 * `-amount_fils` and "what the salon earned" two DIFFERENT numbers. Without such
 * a row the broken aggregate and the correct one return the same figure, so
 * `GROSS_7D` and `GROSS_30D` agreed with the wrong implementation and would have
 * agreed with the right one. No oracle style rescues that: a hand constant, a
 * first-principles recomputation and a derived cross-check are all equally green
 * over rows the two definitions agree about.
 *
 * The paragraph above — "its fixture held one of each excluded shape, so the
 * shapes it did not hold are where the bugs would be" — was therefore exactly
 * right, and this was the shape it did not hold.
 *
 * IT IS NOT FIXED HERE, DELIBERATELY. This file's method is EXPLICIT CLOCKS: it
 * needs a charge at exactly `D5 21:30Z` to separate Kuwait-day grouping from UTC
 * and from the host zone, and a real `POST /charges` cannot be made to happen at
 * a chosen instant. Hand-written rows are the only way to ask its questions, and
 * hand-writing an applied deposit means hand-writing the arithmetic under test.
 * The shape lives in `e2e/reports-applied-deposit.test.ts` instead, where the
 * whole fixture is DRIVEN through `POST /bookings`, `POST /charges` and the
 * no-show job, and where the first spec asserts the fixture DISCRIMINATES before
 * any spec asserts a figure. Do not "unify" the two files.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { precondition } from './support/known-bug.js';
import {
  A_STAFF_FULL,
  SALON_A,
  SALON_B,
  psql,
  reconcileWalletLedger,
  scalar,
  signInDashboard,
  signInMember,
  startTenancyApi,
  stopTenancyApi,
  tenancyBaseUrl,
  treq,
} from './support/tenancy-harness.js';

const A_STAFF_HANDLE = 'noura';
const MEMBER = 'QA-RPT-0001';
const MEMBER_PHONE = '+96555990077';
const MEMBER_RETURN_ONLY = 'QA-RPT-0002';
const MEMBER_PENDING_ONLY = 'QA-RPT-0003';
const CLONE_SOURCE = 'QA-GW-0001';

/** This file's own branches, so every figure below is closed over this file's rows. */
const BR_RPT = 'BR-QA-RPT';
const BR_EVIL = 'BR-QA-EVIL';
const BR_EMPTY = 'BR-QA-EMPTY';
/** A salon can name a branch anything. This one is a CSV formula plus a quoting trap. */
const EVIL_BRANCH_NAME = '-Salmiya, "North"';

let web = '';
let member = '';
let n = 0;
const key = (label: string) => `rpt-${label}-${Date.now()}-${n++}`;

// ------------------------------------------------------------------- clocks --

const DAY = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const NOW = Date.now();
/** The UTC calendar date of (now − 5 days) — the stage for the zone-boundary pair. */
const D5 = iso(NOW - 5 * DAY).slice(0, 10);
const D5_PLUS_1 = iso(Date.parse(`${D5}T00:00:00Z`) + DAY).slice(0, 10);

/**
 * THE ZONE-BOUNDARY PAIR, and why there are two of them. Kuwait is UTC+3, fixed, no
 * DST. This machine runs PKT, UTC+5 — LANES.md says that offset has bitten before, and
 * it is exactly what makes a second probe necessary: a single 21:30Z charge
 * distinguishes Kuwait-grouping from UTC-grouping, but NOT from host-zone grouping,
 * because PKT also rolls 21:30Z into the next day. The 19:30Z charge is the one that
 * separates Kuwait from the host — 22:30 in Kuwait (same day), 00:30 in PKT (next day).
 *
 *   Z1 = D5 21:30Z → Kuwait D5+1 | UTC D5   | PKT D5+1   (refutes UTC grouping)
 *   Z2 = D5 19:30Z → Kuwait D5   | UTC D5   | PKT D5+1   (refutes host grouping)
 */
const Z1_AT = `${D5}T21:30:00.000Z`;
const Z2_AT = `${D5}T19:30:00.000Z`;

// ---------------------------------------------------------------- the ledger --
/**
 * Every transaction this file inserts at BR-QA-RPT, with what the sales report must do
 * with it. THE EXPECTED FIGURES BELOW ARE HAND SUMS OVER THIS TABLE — nothing is read
 * back from the endpoint to compute what the endpoint should say.
 *
 *   id            kind            fils      when          7d gross   30d gross
 *   TX-QARPT-C1   charge         −10000     2d ago         +10000     +10000
 *   TX-QARPT-S1   shop            −5000     2d ago          +5000      +5000
 *   TX-QARPT-Z1   charge           −731     D5 21:30Z        +731       +731
 *   TX-QARPT-Z2   charge           −733     D5 19:30Z        +733       +733
 *   TX-QARPT-IN   charge           −111     7d − 10min       +111       +111
 *   TX-QARPT-OUT  charge           −222     7d + 10min       —          +222
 *   TX-QARPT-VC7  charge           −700     6d ago, VOIDED 1d ago (different day) — excluded
 *   TX-QARPT-VC30 charge          −7777    20d ago, VOIDED 1d ago (different PERIOD:
 *                                           the charge predates the 7d window its void
 *                                           lands in) — excluded from 30d
 *   TX-QARPT-AJ7/AJ30 adjustment  +700/+7777  the voids themselves — not sales rows
 *   TX-QARPT-PEND charge           −900     2d ago, status PENDING — excluded
 *   TX-QARPT-HOLD deposit_hold    −3000     2d ago — escrow, not a sale
 *   TX-QARPT-TOP  topup          +20000     2d ago — her money loaded, not revenue
 *   TX-QARPT-RET  deposit_return  +3000     2d ago, member M2's ONLY activity
 *   TX-QARPT-GOOD adjustment      +2000     2d ago, reverses NOTHING — finding 2
 */
const GROSS_7D = 10000 + 5000 + 731 + 733 + 111; // = 16575
const GROSS_30D = GROSS_7D + 222; // OUT enters; VC30 must NOT (its void stands)
const COUNTED_7D = ['TX-QARPT-C1', 'TX-QARPT-S1', 'TX-QARPT-Z1', 'TX-QARPT-Z2', 'TX-QARPT-IN'];

const report = (kind: string, q = '') =>
  treq<any>('GET', `/salons/${SALON_A}/reports/${kind}${q}`, { token: web });

beforeAll(async () => {
  await startTenancyApi();

  precondition(
    scalar(
      `select perm_team::text || perm_dashboard::text || perm_appointments::text || perm_shop::text
         from staff_user where id='${A_STAFF_FULL}'`,
    ).trim() === 'truetruetruetrue',
    `${A_STAFF_FULL} does not hold the four report permissions, so nothing below measures the data`,
  );

  web = await signInDashboard(SALON_A, A_STAFF_HANDLE);

  psql(`
    INSERT INTO branch (id, salon_id, name)
    VALUES ('${BR_RPT}',   '${SALON_A}', 'QA Reports'),
           ('${BR_EVIL}',  '${SALON_A}', '${EVIL_BRANCH_NAME}'),
           ('${BR_EMPTY}', '${SALON_A}', 'QA Empty')
    ON CONFLICT (id) DO UPDATE SET name = excluded.name, closed_at = NULL;
  `);
  // A double quote needs NO escaping inside a Postgres string literal — the first draft
  // doubled it and stored `-Salmiya, ""North""`, which the precondition below caught.
  // Asserted byte-exact, or the whole CSV section tests a different string.
  precondition(
    scalar(`select name from branch where id='${BR_EVIL}'`).trim() === EVIL_BRANCH_NAME,
    'the hostile branch name did not store byte-exact, so the CSV assertions are off-target',
  );

  psql(`
    INSERT INTO member (id, salon_id, name, phone, email, email_verified, password_hash,
                        balance_fils, visits, tier, stamps, policy_version, notify_wa)
    SELECT '${MEMBER}', salon_id, 'Reports QA', '${MEMBER_PHONE}', NULL, false,
           password_hash, 200000, 0, tier, stamps, policy_version, false
      FROM member WHERE id = '${CLONE_SOURCE}'
    ON CONFLICT (id) DO UPDATE SET balance_fils = 200000;
    INSERT INTO member (id, salon_id, name, phone, email, email_verified, password_hash,
                        balance_fils, visits, tier, stamps, policy_version, notify_wa)
    SELECT '${MEMBER_RETURN_ONLY}', salon_id, 'QA Deposit Return Only', '+96555990078', NULL,
           false, password_hash, 3000, 0, tier, stamps, policy_version, false
      FROM member WHERE id = '${CLONE_SOURCE}'
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO member (id, salon_id, name, phone, email, email_verified, password_hash,
                        balance_fils, visits, tier, stamps, policy_version, notify_wa)
    SELECT '${MEMBER_PENDING_ONLY}', salon_id, 'QA Pending Only', '+96555990079', NULL,
           false, password_hash, 0, 0, tier, stamps, policy_version, false
      FROM member WHERE id = '${CLONE_SOURCE}'
    ON CONFLICT (id) DO NOTHING;
  `);

  member = await signInMember(SALON_A, MEMBER_PHONE);

  /**
   * The ledger, inserted with explicit clocks. `settled_at` mirrors `created_at`
   * because `transaction_settled_at_matches_status` demands one exactly when settled.
   * The VOIDS are settled adjustments REVERSING their charge — the shape
   * `db/schema/transaction.ts` documents and `NOT_VOIDED` looks for — dated a
   * different day (VC7) and a different PERIOD (VC30, charge outside 7d, void inside)
   * than the charge they reverse, which is the case lane A's fixture did not hold.
   */
  const rows: Array<[string, string, string, number, string, string | null]> = [
    // id, member, kind, fils, at, reverses
    ['TX-QARPT-C1', MEMBER, 'charge', -10000, iso(NOW - 2 * DAY), null],
    ['TX-QARPT-S1', MEMBER, 'shop', -5000, iso(NOW - 2 * DAY + 1_800_000), null],
    ['TX-QARPT-Z1', MEMBER, 'charge', -731, Z1_AT, null],
    ['TX-QARPT-Z2', MEMBER, 'charge', -733, Z2_AT, null],
    ['TX-QARPT-IN', MEMBER, 'charge', -111, iso(NOW - 7 * DAY + 600_000), null],
    ['TX-QARPT-OUT', MEMBER, 'charge', -222, iso(NOW - 7 * DAY - 600_000), null],
    ['TX-QARPT-VC7', MEMBER, 'charge', -700, iso(NOW - 6 * DAY), null],
    ['TX-QARPT-AJ7', MEMBER, 'adjustment', 700, iso(NOW - 1 * DAY), 'TX-QARPT-VC7'],
    ['TX-QARPT-VC30', MEMBER, 'charge', -7777, iso(NOW - 20 * DAY), null],
    ['TX-QARPT-AJ30', MEMBER, 'adjustment', 7777, iso(NOW - 1 * DAY + 60_000), 'TX-QARPT-VC30'],
    ['TX-QARPT-HOLD', MEMBER, 'deposit_hold', -3000, iso(NOW - 2 * DAY + 60_000), null],
    ['TX-QARPT-TOP', MEMBER, 'topup', 20000, iso(NOW - 2 * DAY + 120_000), null],
    ['TX-QARPT-RET', MEMBER_RETURN_ONLY, 'deposit_return', 3000, iso(NOW - 2 * DAY + 180_000), null],
    ['TX-QARPT-GOOD', MEMBER, 'adjustment', 2000, iso(NOW - 2 * DAY + 240_000), null],
  ];
  const values = rows
    .map(
      ([id, m, kind, fils, at, rev]) =>
        `('${id}', '${m}', '${SALON_A}', '${BR_RPT}', '${kind}', ${fils}, 'settled',
          '${at}'::timestamptz, '${at}'::timestamptz, ${rev ? `'${rev}'` : 'NULL'})`,
    )
    .join(',\n');
  psql(`
    INSERT INTO "transaction"
      (id, member_id, salon_id, branch_id, kind, amount_fils, status,
       created_at, settled_at, reverses_transaction_id)
    VALUES ${values}
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO "transaction"
      (id, member_id, salon_id, branch_id, kind, amount_fils, status, created_at)
    VALUES ('TX-QARPT-PEND', '${MEMBER_PENDING_ONLY}', '${SALON_A}', '${BR_RPT}', 'charge',
            -900, 'pending', '${iso(NOW - 2 * DAY)}'::timestamptz)
    ON CONFLICT (id) DO NOTHING;
  `);

  /** The CSV stage: a settled shop order at the hostile branch, lines carrying the trap. */
  psql(`
    INSERT INTO product (id, salon_id, name, price_fils, active)
    VALUES ('PR-QA-EVIL', '${SALON_A}', 'QA formula product', 5000, false),
           ('PR-QA-BULK', '${SALON_A}', 'Bulk argan litre', 20000, false),
           ('PR-QA-RS',   '${SALON_A}', 'Vitamin mask', 6000, true)
    ON CONFLICT (id) DO UPDATE SET name = excluded.name, active = excluded.active;
    INSERT INTO "transaction"
      (id, member_id, salon_id, branch_id, kind, amount_fils, status, created_at, settled_at)
    VALUES ('TX-QAEVIL-1', '${MEMBER}', '${SALON_A}', '${BR_EVIL}', 'shop', -1805000,
            'settled', '${iso(NOW - 1 * DAY)}'::timestamptz, '${iso(NOW - 1 * DAY)}'::timestamptz)
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO shop_order_line (transaction_id, product_id, name, qty, unit_price_fils, line_total_fils)
    VALUES ('TX-QAEVIL-1', 'PR-QA-EVIL', '=HYPERLINK("http://evil.example","Open")', 1, 5000, 5000),
           ('TX-QAEVIL-1', 'PR-QA-BULK', 'Bulk argan litre', 90, 20000, 1800000)
    ON CONFLICT DO NOTHING;
  `);
}, 180_000);

afterAll(async () => {
  psql(`
    UPDATE staff_user SET perm_team = true, perm_dashboard = true,
                          perm_appointments = true, perm_shop = true
     WHERE id = '${A_STAFF_FULL}';
  `);

  /*
   * AND PAY THE LEDGER WHAT THIS FILE'S FIXTURE OWES IT.
   *
   * The header above says this file writes no `ledger_entry` rows, and that is
   * still true of everything it asserts: the transaction rows below exist to be
   * COUNTED by the reports, and a report reads `transaction`, never the ledger.
   * But the two members are cloned with a `balance_fils` — 200.000 and 3.000 —
   * that nothing accounts for, so both drift in the wallet census
   * (`support/global-setup.ts`) by exactly their opening balance.
   *
   * Posted in `afterAll` so it cannot reach a single figure this file asserts:
   * every spec has run by now — and an adjustment reversing nothing is counted
   * by no tile and no report anyway, which is the same reasoning
   * `reports-applied-deposit.test.ts` records for its opening pair, and which
   * finding 2 below documents as a gap in its own right.
   *
   * THE BRANCH IS NO LONGER THIS FILE'S `BR_RPT` AND THAT IS THE IMPROVEMENT.
   * These two calls used to pass it, and the note here used to justify the choice
   * by saying `BR_RPT` is the branch every figure above is closed over. That was
   * true and it was still the wrong thing to assert: it made the helper's branch
   * look like a decision each caller had to get right, when the rows are posted
   * after every `?branch=` query has already run and no figure can see them. The
   * helper now derives the salon's first open branch and marks the row
   * `branch_assumed`, so the branch says of itself that it was never established.
   */
  reconcileWalletLedger(MEMBER, 'QARPT');
  reconcileWalletLedger(MEMBER_RETURN_ONLY, 'QARPTR');

  await stopTenancyApi();
});

// ===========================================================================

describe('sales counts what stands and nothing else — seven exclusion shapes at once', () => {
  it('the 7d gross is the hand sum over the counted rows, to the fils', async () => {
    const res = await report('sales', `?branch=${BR_RPT}&period=7d`);
    precondition(res.status === 200, `sales answered ${res.status}: ${res.raw}`);

    expect(res.body.stat.type).toBe('money');
    expect(
      res.body.stat.value,
      `gross is ${res.body.stat.value}, expected ${GROSS_7D}. The difference names the ` +
        'shape that leaked: +700 the day-crossing void, +900 pending, +3000 the deposit ' +
        'hold, +20000 the top-up, +3000 the deposit return, +2000 the goodwill credit, ' +
        `+222 the out-of-window charge.\n${res.raw}`,
    ).toBe(GROSS_7D);

    // The stat and its own table cannot disagree.
    const sum = res.body.rows.reduce((t: number, r: any) => t + r.grossFils, 0);
    expect(sum, 'the headline stat is not the sum of the rows under it').toBe(GROSS_7D);
    const txns = res.body.rows.reduce((t: number, r: any) => t + r.transactions, 0);
    expect(txns, 'a excluded row was still counted as a transaction').toBe(COUNTED_7D.length);
  }, 60_000);

  it('the sign convention, in SQL against this database: revenue is −(a sum that is negative)', () => {
    /**
     * Charges and shop rows move the MEMBER'S wallet, so their raw sum is negative by
     * CHECK (`transaction_amount_sign_matches_kind`). The report's positive gross must
     * be exactly its negation — asserted over the named fixture ids so this is a claim
     * about the database, not a re-run of the endpoint's own query.
     */
    const raw = Number(
      scalar(
        `select sum(amount_fils) from "transaction"
          where id in (${COUNTED_7D.map((i) => `'${i}'`).join(',')})`,
      ),
    );
    expect(raw, 'the raw wallet movements should be negative — a positive charge exists').toBe(
      -GROSS_7D,
    );
    expect(raw).toBeLessThan(0);
  });

  it('30d admits the older charge and still refuses the charge whose void came later', async () => {
    const res = await report('sales', `?branch=${BR_RPT}&period=30d`);
    precondition(res.status === 200, res.raw);

    expect(
      res.body.stat.value,
      `30d gross is ${res.body.stat.value}. ${GROSS_30D + 7777} would mean the void was ` +
        'ignored because it landed in a different period than its charge — the exact ' +
        'shape this fixture exists to hold.',
    ).toBe(GROSS_30D);
    expect(res.body.rows.some((r: any) => r.grossFils === 7777)).toBe(false);
  }, 60_000);

  /**
   * FINDING 1 DRIVEN: the window edge is an instant. TX-QARPT-IN sits 10 minutes inside
   * `now − 7d`, TX-QARPT-OUT 10 minutes outside, and the 7d gross above counted exactly
   * one of them — in EVERY zone, because an instant has no zone. What was asked for —
   * "inside 30d in Kuwait but outside in UTC" — cannot be built against this
   * implementation, and that impossibility is itself the answer: the period is not a
   * calendar construct. Reported in the file header.
   */
  it('the boundary is an instant: ±10 minutes decide membership, timezone cannot', async () => {
    const res = await report('sales', `?branch=${BR_RPT}&period=7d`);
    precondition(res.status === 200, res.raw);
    const grosses = res.body.rows.map((r: any) => r.grossFils);
    expect(grosses, 'the charge 10min inside the window is missing').toContain(111);
    expect(grosses, 'the charge 10min OUTSIDE the window was counted').not.toContain(222);
  }, 60_000);
});

// ===========================================================================

describe("the day is the salon's day — refuting UTC and the host zone separately", () => {
  /**
   * This machine runs PKT (UTC+5); Kuwait is UTC+3, fixed. A single late-evening probe
   * cannot tell Kuwait-grouping from host-grouping — both roll 21:30Z forward — which
   * is why there are two probes with disjoint counterfactuals (see Z1/Z2 above).
   */
  it('21:30Z belongs to the NEXT Kuwait day — a UTC grouping would keep it', async () => {
    const res = await report('sales', `?branch=${BR_RPT}&period=7d`);
    precondition(res.status === 200, res.raw);
    const z1 = res.body.rows.find((r: any) => r.grossFils === 731);
    precondition(z1 !== undefined, `the Z1 row is missing: ${res.raw}`);

    expect(
      z1.date,
      `the 21:30Z charge is dated ${z1.date}. ${D5} is the UTC date — a report grouping ` +
        'by UTC gives the merchant a day figure she cannot reconcile against her till.',
    ).toBe(D5_PLUS_1);
  }, 60_000);

  it("19:30Z stays on the SAME Kuwait day — the host's zone (PKT) would move it", async () => {
    const res = await report('sales', `?branch=${BR_RPT}&period=7d`);
    precondition(res.status === 200, res.raw);
    const z2 = res.body.rows.find((r: any) => r.grossFils === 733);
    precondition(z2 !== undefined, `the Z2 row is missing: ${res.raw}`);

    expect(
      z2.date,
      `the 19:30Z charge (22:30 Kuwait, 00:30 PKT) is dated ${z2.date}. ${D5_PLUS_1} ` +
        "would mean the grouping uses the SERVER's clock — the bug that only shows on a " +
        'machine east of Kuwait, which this one is.',
    ).toBe(D5);
  }, 60_000);
});

// ===========================================================================

describe('customers is "active in the period", and it agrees with the Overview tile', () => {
  it('a member whose only activity is a deposit return IS active; a pending-only member is not', async () => {
    const res = await report('customers', `?branch=${BR_RPT}&period=7d`);
    precondition(res.status === 200, `customers answered ${res.status}: ${res.raw}`);

    const names = res.body.rows.map((r: any) => r.name);
    expect(names, 'the charging member is missing from her own branch').toContain('Reports QA');
    /**
     * DELIBERATE, AND WORTH A SENTENCE: a deposit return is a settled transaction, so
     * M2 counts as "active" having only ever received money back. That matches the
     * definition (≥1 settled transaction) and the metrics tile, so it is consistent —
     * whether "was refunded" should read as "active customer" is a product question,
     * recorded here rather than silently either way.
     */
    expect(names, 'a settled deposit_return did not count as activity').toContain(
      'QA Deposit Return Only',
    );
    expect(names, 'a member with only a PENDING charge was counted as active').not.toContain(
      'QA Pending Only',
    );
    expect(res.body.rowCount).toBe(2);

    // Balance is a live snapshot in integer fils, not a period figure.
    const m = res.body.rows.find((r: any) => r.name === 'Reports QA');
    expect(m.balanceFils, 'balanceFils is not the integer-fils snapshot').toBe(
      Number(scalar(`select balance_fils from member where id='${MEMBER}'`)),
    );
  }, 60_000);

  it('the report and GET /metrics answer "how many customers" identically', async () => {
    /**
     * The shared definition is the REASON the reuse exists — two screens disagreeing
     * about how many customers a salon has is the defect it prevents. Same period, all
     * branches, back-to-back with no writes between, so the only thing that can differ
     * is the definition itself.
     */
    const customers = await report('customers', '?period=30d');
    const metrics = await treq<any>('GET', `/salons/${SALON_A}/metrics?period=30d`, {
      token: web,
    });
    precondition(customers.status === 200 && metrics.status === 200, 'one of the pair failed');

    expect(
      customers.body.rowCount,
      `Reports says ${customers.body.rowCount} customers, Overview says ` +
        `${metrics.body.activeMembers}. The definitions have drifted apart.`,
    ).toBe(metrics.body.activeMembers);
  }, 60_000);
});

// ===========================================================================

describe('the CSV bytes — parsed, not substringed', () => {
  /** RFC 4180, strict: quoted fields, doubled quotes, CRLF records. Throws on malformed. */
  function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = '';
    let inQuotes = false;
    let i = 0;
    while (i < text.length) {
      const c = text[i]!;
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            cell += '"';
            i += 2;
            continue;
          }
          inQuotes = false;
          i++;
          continue;
        }
        cell += c;
        i++;
        continue;
      }
      if (c === '"') {
        inQuotes = true;
        i++;
        continue;
      }
      if (c === ',') {
        row.push(cell);
        cell = '';
        i++;
        continue;
      }
      if (c === '\r' && text[i + 1] === '\n') {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
        i += 2;
        continue;
      }
      if (c === '\n' || c === '\r') {
        throw new Error(`bare ${c === '\n' ? 'LF' : 'CR'} at offset ${i} — records must be CRLF`);
      }
      cell += c;
      i++;
    }
    row.push(cell);
    rows.push(row);
    if (inQuotes) throw new Error('unterminated quote');
    return rows;
  }

  let status = 0;
  let headers: Headers;
  let bytes: Uint8Array;
  let text = '';

  beforeAll(async () => {
    const res = await fetch(
      `${tenancyBaseUrl()}/salons/${SALON_A}/reports/products-sold.csv?branch=${BR_EVIL}&period=7d`,
      { headers: { authorization: `Bearer ${web}` } },
    );
    status = res.status;
    headers = res.headers;
    bytes = new Uint8Array(await res.arrayBuffer());
    text = new TextDecoder('utf-8').decode(bytes.slice(3));
  });

  it('starts with the UTF-8 BOM, byte for byte', () => {
    precondition(status === 200, `the CSV answered ${status}`);
    expect(
      [bytes[0], bytes[1], bytes[2]],
      'no BOM: Excel will render an Arabic product or branch name as mojibake',
    ).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('parses to uniform-width rows with no trailing newline', () => {
    expect(bytes[bytes.length - 1], 'the file ends with a phantom empty row').not.toBe(0x0a);

    const rows = parseCsv(text);
    expect(rows[0], 'the header row moved').toEqual(['Product', 'Units', 'Revenue KD', 'Branch']);
    for (const [k, r] of rows.entries()) {
      expect(r.length, `row ${k} has ${r.length} cells — the file does not parse rectangular`).toBe(
        4,
      );
    }
    expect(rows.length, 'expected header + 2 product rows').toBe(3);
  });

  it('neutralises the formula and survives the quoting trap, in the same file', () => {
    const rows = parseCsv(text);
    const evil = rows.find((r) => r[0]!.includes('HYPERLINK'));
    precondition(evil !== undefined, `no HYPERLINK row in:\n${text}`);

    /**
     * The apostrophe is IN THE VALUE — quoting alone is not protection, because CSV
     * quotes are syntax the spreadsheet strips before deciding whether the cell is a
     * formula. And the rest of the name survives byte-exact behind it.
     */
    expect(
      evil[0],
      'the product name still begins "=", so opening this export executes it',
    ).toBe(`'=HYPERLINK("http://evil.example","Open")`);

    // The branch name: leading "-" is ALSO a formula lead, and it carries a comma and
    // quotes that must round-trip through RFC 4180 quoting.
    expect(evil[3], 'the hostile branch name did not survive parsing').toBe(`'${EVIL_BRANCH_NAME}`);
    // And the doubled-quote encoding is really in the bytes, not an artefact of the parser.
    expect(text, 'the embedded quotes are not RFC 4180 doubled').toContain('""North""');
  });

  it('money cells carry no thousands separator, so Excel sums them as numbers', () => {
    const rows = parseCsv(text);
    const bulk = rows.find((r) => r[0] === 'Bulk argan litre');
    precondition(bulk !== undefined, text);
    expect(bulk[1]).toBe('90');
    expect(
      bulk[2],
      'a comma in a money cell turns the column into text in the very spreadsheet this file exists for',
    ).toBe('1800.000');
  });

  it('the headers name the file safely and refuse caching', () => {
    expect(headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(headers.get('cache-control')).toBe('no-store');
    /**
     * The branch name reaches Content-Disposition, so the quote, comma, space and
     * capital letters must all be gone: `-Salmiya, "North"` → `-salmiya-north`.
     * Asserted exactly — a regexp here could not catch a stray quote that happened to
     * also match.
     */
    expect(headers.get('content-disposition')).toBe(
      'attachment; filename="products-sold_-salmiya-north_7d.csv"',
    );
  });
});

// ===========================================================================

describe('a branch that is not hers does not exist, and empty is only for one that is', () => {
  it("another salon's REAL branch and a nonexistent one are byte-identical refusals", async () => {
    const foreign = await report('sales', `?branch=BR-LUM-HAW&period=7d`);
    const ghost = await report('sales', `?branch=ZZ-NO-SUCH-BRANCH&period=7d`);

    /**
     * The code, not just the status — DECISIONS.md: a status is a class of answer, not
     * an identification of the answerer. A 404 from a missing route would carry
     * fastify's shape, not `unknown_branch`.
     */
    expect(foreign.status, `a foreign branch answered ${foreign.status}: ${foreign.raw}`).toBe(404);
    expect(foreign.body.error).toBe('unknown_branch');
    expect(ghost.status).toBe(404);
    expect(ghost.body.error).toBe('unknown_branch');
    expect(
      foreign.raw,
      'the two refusals differ, so the endpoint is an oracle for whether a branch id exists',
    ).toBe(ghost.raw);
  }, 60_000);

  it('an empty report is 200 with zero rows — for a branch that is really hers', async () => {
    const res = await report('sales', `?branch=${BR_EMPTY}&period=7d`);
    expect(res.status, res.raw).toBe(200);
    expect(res.body.rowCount).toBe(0);
    expect(res.body.rows).toEqual([]);
    expect(res.body.stat.value).toBe(0);
  }, 60_000);

  it('and an unknown KIND is a 400 by name — the route exists and said so', async () => {
    const res = await report('bogus', '?period=7d');
    expect(res.status, res.raw).toBe(400);
    expect(res.body.error).toBe('invalid_report_kind');
  }, 60_000);
});

// ===========================================================================

describe('a mid-window rename neither relabels the past nor splits the product', () => {
  /**
   * `shop_order_line.name` is a sale-time snapshot; the grouping key is `product_id`.
   * Both sales go through the REAL `POST /orders`, so the snapshot under test is the
   * one the production write path takes — not one this file typed into a line row.
   */
  it('drives the rename between two real sales', async () => {
    const first = await treq<any>('POST', '/orders', {
      token: member,
      idempotencyKey: key('rename-1'),
      body: { items: [{ productId: 'PR-QA-RS', qty: 1 }] },
    });
    precondition(first.status === 201, `the first order failed: ${first.raw}`);

    const before = await report('products-sold', '?period=7d');
    precondition(before.status === 200, before.raw);
    const r1 = before.body.rows.filter((r: any) =>
      ['Vitamin mask', 'Renewal mask'].includes(r.product),
    );
    expect(r1.length, `expected exactly one row for the product: ${before.raw}`).toBe(1);
    expect(r1[0].product).toBe('Vitamin mask');
    expect(r1[0].units).toBe(1);

    psql(`UPDATE product SET name = 'Renewal mask' WHERE id = 'PR-QA-RS';`);

    /** Property 1: the rename does not relabel the past. The only sale predates it. */
    const mid = await report('products-sold', '?period=7d');
    const r2 = mid.body.rows.filter((r: any) =>
      ['Vitamin mask', 'Renewal mask'].includes(r.product),
    );
    expect(r2.length).toBe(1);
    expect(
      r2[0].product,
      'the rename relabelled a sale that happened under the old name — history repriced, one column over',
    ).toBe('Vitamin mask');

    const second = await treq<any>('POST', '/orders', {
      token: member,
      idempotencyKey: key('rename-2'),
      body: { items: [{ productId: 'PR-QA-RS', qty: 2 }] },
    });
    precondition(second.status === 201, `the second order failed: ${second.raw}`);

    /** The two lines really carry two names — the snapshot, proved in SQL. */
    expect(
      scalar(
        `select string_agg(distinct name, '|' order by name)
           from shop_order_line where product_id = 'PR-QA-RS'`,
      ).trim(),
    ).toBe('Renewal mask|Vitamin mask');

    /** Property 2: one product, one row — grouped by id, labelled by the latest sale. */
    const after = await report('products-sold', '?period=7d');
    const r3 = after.body.rows.filter((r: any) =>
      ['Vitamin mask', 'Renewal mask'].includes(r.product),
    );
    expect(
      r3.length,
      `the rename split one product into ${r3.length} rows: ${JSON.stringify(r3)}`,
    ).toBe(1);
    expect(r3[0].product, 'the row is not labelled by the most recent sale').toBe('Renewal mask');
    expect(r3[0].units).toBe(3);
    expect(r3[0].revenueFils).toBe(3 * 6000);
  }, 60_000);
});

// ===========================================================================

describe('the gate is per kind, and the CSV twin is gated with it', () => {
  /**
   * WHAT THIS ADDS NOW THAT THE CENSUS COVERS THE BASE CASE — and the history is worth
   * keeping, because this describe changed meaning under it.
   *
   * When it was written, `permission-census.test.ts` could not probe the reports routes
   * at all: the permission is `REPORT_PERMISSION[kind]`, not a literal, and a hand-kept
   * DYNAMIC_PERMISSION ledger pointed here instead. That ledger broke within a day — lane
   * A added a third reports route and a two-entry list could not know about it — so the
   * census now READS `REPORT_PERMISSION` out of `api/src` and expands each route into one
   * generated probe per kind. The permission-off probe and its granted mirror are covered
   * there, for every kind, with no list to maintain.
   *
   * So these cases are no longer the only coverage; they are the part a generated probe
   * cannot express:
   *   - the `.csv` TWIN is refused by the same revoke. The census probes the JSON route
   *     and the CSV route separately, but nothing there asserts they move TOGETHER, and
   *     they are two handlers sharing one `build()`.
   *   - the CROSS-KIND case: revoking `team` kills `customers` and leaves `sales`
   *     standing. That is the FRONTDESK property — `frontdesk` holds `dashboard` and not
   *     `team`, so a blanket `dashboard` gate would hand every front-desk tablet the
   *     customer book with phones and balances — and it is a statement about two kinds at
   *     once, which a per-route probe cannot make.
   *
   * The table below is a SECOND copy of the mapping, deliberately: the census asserts the
   * parsed map equals these same four pairs, so the two disagree loudly rather than
   * drifting quietly.
   */
  const KIND_PERMISSION: Record<string, { column: string; copy: string }> = {
    customers: {
      column: 'perm_team',
      copy: "You don't have permission to manage the team. A manager can grant it.",
    },
    sales: {
      column: 'perm_dashboard',
      copy: "You don't have permission to see the dashboard. A manager can grant it.",
    },
    'best-selling-services': {
      column: 'perm_appointments',
      copy: "You don't have permission to see appointments. A manager can grant it.",
    },
    'products-sold': {
      column: 'perm_shop',
      copy: "You don't have permission to see the shop. A manager can grant it.",
    },
  };

  const restore = (): void => {
    psql(`
      UPDATE staff_user SET perm_team = true, perm_dashboard = true,
                            perm_appointments = true, perm_shop = true
       WHERE id = '${A_STAFF_FULL}';
    `);
  };

  for (const [kind, gate] of Object.entries(KIND_PERMISSION)) {
    it(`${kind} refuses without ${gate.column}, names it, and opens with it back`, async () => {
      try {
        psql(`UPDATE staff_user SET ${gate.column} = false WHERE id = '${A_STAFF_FULL}';`);
        precondition(
          scalar(`select ${gate.column} from staff_user where id='${A_STAFF_FULL}'`).trim() === 'f',
          'the revoke did not take',
        );

        const refused = await report(kind, '?period=7d');
        expect(refused.status, `${kind} with ${gate.column} off: ${refused.raw}`).toBe(403);
        expect(refused.body.error).toBe('forbidden');
        expect(refused.body.message, `${kind} refused for the wrong permission`).toBe(gate.copy);

        // The same gate guards the bytes.
        const csv = await fetch(
          `${tenancyBaseUrl()}/salons/${SALON_A}/reports/${kind}.csv?period=7d`,
          { headers: { authorization: `Bearer ${web}` } },
        );
        expect(csv.status, `the CSV twin of ${kind} leaked past the revoke`).toBe(403);

        restore();
        const allowed = await report(kind, '?period=7d');
        expect(allowed.status, `${kind} still refuses with the permission back`).toBe(200);
      } finally {
        restore();
      }
    }, 60_000);
  }

  it('revoking team alone kills customers and leaves sales standing — per kind, not blanket', async () => {
    try {
      psql(`UPDATE staff_user SET perm_team = false WHERE id = '${A_STAFF_FULL}';`);

      const customers = await report('customers', '?period=7d');
      const sales = await report('sales', '?period=7d');

      expect(customers.status, 'the frontdesk property failed open').toBe(403);
      expect(
        sales.status,
        'revoking team also killed sales, so the gate is blanket rather than per kind',
      ).toBe(200);
    } finally {
      restore();
    }
  }, 60_000);
});
