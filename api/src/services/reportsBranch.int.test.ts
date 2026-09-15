/**
 * EARNINGS BY BRANCH - the roll-up whose rows are branches, proved against real
 * rows, and RECONCILED AGAINST `sales` rather than believed.  (Aftab, item 7)
 *
 * =========================================================================
 * WHY THIS FILE IS MOSTLY ONE ASSERTION, WRITTEN SIX WAYS
 * =========================================================================
 * `sales` groups by (day, branch) over transactions. This kind groups by branch
 * over the same transactions with the same predicates. They are two aggregates
 * over one pile of money, so THEY MUST AGREE - on the salon total, on each
 * branch, on each period, and on the transaction counts.
 *
 * That is the whole reason a second report about money is allowed to exist at
 * all. `services/reportsReconciliation.int.test.ts` makes the identical argument
 * for `sales` against `artist-performance`, and it is the check that caught the
 * `-amount_fils` understatement: two aggregates that must be equal are a far
 * stronger instrument than either one checked alone. A branch roll-up that
 * disagreed with the Sales card would be worse than no branch roll-up.
 *
 * AND A RECONCILIATION SPEC THAT CANNOT FAIL IS WORTHLESS, so § "the spec has
 * teeth" computes the two figures this report deliberately does NOT return - the
 * established-only total, and the naive `sum(-amount_fils)` - and asserts that
 * the endpoint returns neither, and that each gap is exactly what it should be.
 * Change the assumed-row decision or revert the revenue expression and this file
 * goes red in two different places for two different reasons.
 *
 * =========================================================================
 * WHAT `branch_assumed` MEANS, PROVED BY DRIVING IT RATHER THAN BY READING IT
 * =========================================================================
 * § "what an assumed branch actually is" drives a REAL `POST /charges` on a real
 * scanner session with an UN-ENROLLED device, and reads the row back. The claim
 * under test is not "some rows are approximate". It is the specific and
 * directional one this report is built around:
 *
 *   `services/branch.ts` with nothing supplied runs `ORDER BY id LIMIT 2` and
 *   takes the first row. So an assumed charge is not attributed by inference -
 *   it is attributed by SORT ORDER, and EVERY assumed row in the salon lands on
 *   the SAME branch.
 *
 * At the seeded salon that branch is `BR-KWC`. The spec asserts the charge landed
 * there, that the row says `branch_assumed`, and - the part that matters for this
 * report - that Kuwait City's Gross moved by the whole charge while Salmiya's did
 * not move at all. The pile-on is visible in the report's own output, which is
 * why the `Assumed KD` column is beside the Gross rather than at the end of the
 * row.
 *
 * =========================================================================
 * THE FIXTURE IS APPEND-ONLY - the same constraint, for the same reason
 * =========================================================================
 * Proving the deposit path needs real `ledger_entry` rows, and `ledger_entry` is
 * append-only against the owner role as well as the app role (migration 0001 +
 * `ledger_entry_is_immutable`); `ON DELETE restrict` makes the transactions and
 * members behind it permanent too. So: SAL-AMARA and never SAL-LUMIERE, every id
 * carries a per-run suffix, and NO ASSERTION BELOW IS AN ABSOLUTE SALON-WIDE
 * FIGURE. Salon-wide claims are RELATIONSHIPS - "these two reports are equal",
 * "the gap is exactly the assumed money" - which hold however much traffic
 * earlier runs left behind. Absolute numbers are asserted only as DELTAS this run
 * owns: the report is read before and after each act.
 *
 * THE SEVEN ROWS, AND WHAT EACH ONE CATCHES
 * -----------------------------------------
 *   EB-1  SALMIYA, ESTABLISHED, booked: 6.000 charged + 2.000 deposit = 8.000.
 *         The deposit case - a report summing `-amount_fils` reports 6.000.
 *   EB-2  KUWAIT CITY, ASSUMED, walk-in 5.000. The money whose branch is a guess.
 *   EB-3  SALMIYA, ASSUMED, walk-in 3.000. A second assumed row at the OTHER
 *         branch, so "assumed" cannot be mistaken for "always Kuwait City" in a
 *         hand-written fixture even though the WRITE path makes it so.
 *   EB-4  KUWAIT CITY, ESTABLISHED, shop order 4.000. Revenue with no artist.
 *   EB-5  SALMIYA, ESTABLISHED, charge 9.000 then VOIDED. Must appear in neither
 *         report and in neither branch.
 *   EB-6  A top-up. Not revenue in any period, at any branch - and always
 *         `branch_assumed` by construction (services/topup.ts), which is exactly
 *         the row that would poison an `Assumed KD` column that counted by kind
 *         instead of by revenue.
 *   EB-7  SALMIYA, ESTABLISHED, 45 days back. Outside 30d, inside 90d.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const SALON = 'SAL-AMARA';
const OTHER_SALON = 'SAL-LUMIERE';
const SALMIYA = 'BR-SAL';
const KUWAIT_CITY = 'BR-KWC';
const SALMIYA_NAME = 'Salmiya';
const KWC_NAME = 'Kuwait City';
/** Seeded manager: `perm_dashboard` true, which is this kind's gate. */
const MANAGER = 'ST-001';
/** Seeded frontdesk: `perm_dashboard` FALSE. The #7 caller. */
const NO_DASHBOARD = 'ST-002';

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const id = (kind: string, n: number | string) => `EB-${kind}-${RUN}-${n}`;
const phoneSeq = (n: number) => `+9657${String(Date.now() % 1_000_000).padStart(6, '0')}${n}`;
const DAY = 86_400_000;

interface BranchRow {
  branch?: string;
  transactions?: number;
  grossFils?: number;
  assumedGrossFils?: number;
  assumedTransactions?: number;
}
interface SalesRow {
  date?: string;
  branch?: string;
  transactions?: number;
  grossFils?: number;
}
interface Report<T> {
  kind: string;
  title: string;
  columns: Array<{ header: string; key: string; type: string }>;
  rows: T[];
  stat: { key: string | null; label: string; value: number; type: string };
  rowCount: number;
}

suite('earnings-by-branch reconciles with sales and says how much of it is a guess', () => {
  let app: FastifyInstance;
  let db: (typeof import('../db/client'))['db'];
  let sql: (typeof import('drizzle-orm'))['sql'];
  let bearer: string;
  let noDashboardBearer: string;
  let foreignBearer: string;

  const FOREIGN_STAFF = id('ST', 'lum');
  const ARTIST = id('AR', 1);
  const BOOKED_SERVICE = id('SV', 'booked');
  const DRIVEN_SERVICE = id('SV', 'driven');
  const DRIVEN_PRICE = 7_000;
  const M = [1, 2, 3, 4, 5, 6, 7].map((n) => id('M', n));

  const exec = async (q: unknown) =>
    (await db.execute(q as never)) as unknown as Array<Record<string, unknown>>;

  const only = (rows: Array<Record<string, unknown>>, what: string): Record<string, unknown> => {
    const [row] = rows;
    if (row === undefined) throw new Error(`expected one row for ${what}, got none`);
    return row;
  };

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    sql = (await import('drizzle-orm')).sql;
    const issueSession = (await import('../auth/sessions')).issueSession;
    app = await (await import('../app')).buildApp();

    const t = (daysAgo: number, hour: number) =>
      new Date(Date.now() - daysAgo * DAY + hour * 3_600_000).toISOString();

    /**
     * The tenancy caller: a REAL manager HOLDING the real permission, at the
     * WRONG salon. `perm_dashboard` is deliberately TRUE - a 403 from somebody
     * who lacks the permission anyway would prove nothing about tenancy.
     */
    await db.execute(sql`
      INSERT INTO staff_user (id, salon_id, name, handle, role, branch_access_all, perm_dashboard, perm_team)
      VALUES (${FOREIGN_STAFF}, ${OTHER_SALON}, 'EB Lumiere', ${`eb-lum-${RUN}`}, 'manager', true, true, true)`);

    await db.execute(sql`
      INSERT INTO artist (id, salon_id, staff_user_id, name)
      VALUES (${ARTIST}, ${SALON}, NULL, ${`EB Rana ${RUN}`})`);

    await db.execute(sql`
      INSERT INTO service (id, salon_id, name, price_fils) VALUES
        (${BOOKED_SERVICE}, ${SALON}, ${`EB Booked ${RUN}`}, 8000),
        (${DRIVEN_SERVICE}, ${SALON}, ${`EB Driven ${RUN}`}, ${DRIVEN_PRICE})`);

    await db.execute(sql`
      INSERT INTO member (id, salon_id, name, phone, password_hash, balance_fils, tier, visits, policy_version)
      VALUES
        (${M[0]}, ${SALON}, 'EB One',   ${phoneSeq(1)}, 'x', 90000, 'bronze', 0, 3),
        (${M[1]}, ${SALON}, 'EB Two',   ${phoneSeq(2)}, 'x', 90000, 'bronze', 0, 3),
        (${M[2]}, ${SALON}, 'EB Three', ${phoneSeq(3)}, 'x', 90000, 'bronze', 0, 3),
        (${M[3]}, ${SALON}, 'EB Four',  ${phoneSeq(4)}, 'x', 90000, 'bronze', 0, 3),
        (${M[4]}, ${SALON}, 'EB Five',  ${phoneSeq(5)}, 'x', 90000, 'bronze', 0, 3),
        (${M[5]}, ${SALON}, 'EB Six',   ${phoneSeq(6)}, 'x', 90000, 'bronze', 0, 3),
        (${M[6]}, ${SALON}, 'EB Seven', ${phoneSeq(7)}, 'x', 90000, 'bronze', 0, 3)`);

    /** EB-1's deposit hold. `deposit_hold` is revenue on no card. */
    await db.execute(sql`
      INSERT INTO "transaction"
        (id, member_id, salon_id, branch_id, branch_assumed, kind, amount_fils, method, status, reference, created_at, settled_at)
      VALUES
        (${id('TX', 'h1')}, ${M[0]}, ${SALON}, ${SALMIYA}, false, 'deposit_hold', -2000, 'wallet', 'settled', '', ${t(4, 1)}, ${t(4, 1)})`);

    /**
     * Signs are the schema's: `transaction_amount_sign_matches_kind` makes a
     * `charge` <= 0, a `shop` and a `deposit_hold` < 0, a `topup` > 0.
     */
    await db.execute(sql`
      INSERT INTO "transaction"
        (id, member_id, salon_id, branch_id, branch_assumed, kind, amount_fils, method, status, reference, created_at, settled_at)
      VALUES
        (${id('TX', 'c1')}, ${M[0]}, ${SALON}, ${SALMIYA},     false, 'charge', -6000, 'wallet', 'settled', '', ${t(3, 1)}, ${t(3, 1)}),
        (${id('TX', 'c2')}, ${M[1]}, ${SALON}, ${KUWAIT_CITY}, true,  'charge', -5000, 'wallet', 'settled', '', ${t(3, 2)}, ${t(3, 2)}),
        (${id('TX', 'c3')}, ${M[2]}, ${SALON}, ${SALMIYA},     true,  'charge', -3000, 'wallet', 'settled', '', ${t(3, 3)}, ${t(3, 3)}),
        (${id('TX', 's4')}, ${M[3]}, ${SALON}, ${KUWAIT_CITY}, false, 'shop',   -4000, 'wallet', 'settled', '', ${t(3, 4)}, ${t(3, 4)}),
        (${id('TX', 'c5')}, ${M[4]}, ${SALON}, ${SALMIYA},     false, 'charge', -9000, 'wallet', 'settled', '', ${t(3, 5)}, ${t(3, 5)}),
        (${id('TX', 't6')}, ${M[5]}, ${SALON}, ${KUWAIT_CITY}, true,  'topup',  20000, 'knet',   'settled', '', ${t(3, 6)}, ${t(3, 6)}),
        (${id('TX', 'c7')}, ${M[6]}, ${SALON}, ${SALMIYA},     false, 'charge', -8000, 'wallet', 'settled', '', ${t(45, 1)}, ${t(45, 1)})`);

    /** The void of EB-5: a compensating `adjustment` naming the charge it reverses. */
    await db.execute(sql`
      INSERT INTO "transaction"
        (id, member_id, salon_id, branch_id, branch_assumed, kind, amount_fils, method, status, reference, reverses_transaction_id, created_at, settled_at)
      VALUES (${id('TX', 'v5')}, ${M[4]}, ${SALON}, ${SALMIYA}, false, 'adjustment', 9000, 'wallet', 'settled', '', ${id('TX', 'c5')}, ${t(2, 1)}, ${t(2, 1)})`);

    /**
     * The ledger, only the legs the real handlers write.
     * `walletSpendPosting` = member_wallet DEBIT + salon_revenue CREDIT.
     * `depositAppliedPosting` = deposit_held DEBIT + salon_revenue CREDIT.
     * `chargeReversedPosting` = member_wallet CREDIT + salon_revenue DEBIT.
     * `ledger_entry_balanced` checks per transaction at COMMIT, so each pair
     * lands or none of them do.
     */
    await db.execute(sql`
      INSERT INTO ledger_entry (transaction_id, salon_id, member_id, account, direction, amount_fils, balance_after_fils)
      VALUES
        (${id('TX', 'c1')}, ${SALON}, ${M[0]}, 'member_wallet', 'debit',  6000, 82000),
        (${id('TX', 'c1')}, ${SALON}, NULL,    'salon_revenue', 'credit', 6000, NULL),
        (${id('TX', 'c1')}, ${SALON}, NULL,    'deposit_held',  'debit',  2000, NULL),
        (${id('TX', 'c1')}, ${SALON}, NULL,    'salon_revenue', 'credit', 2000, NULL),
        (${id('TX', 'c2')}, ${SALON}, ${M[1]}, 'member_wallet', 'debit',  5000, 85000),
        (${id('TX', 'c2')}, ${SALON}, NULL,    'salon_revenue', 'credit', 5000, NULL),
        (${id('TX', 'c3')}, ${SALON}, ${M[2]}, 'member_wallet', 'debit',  3000, 87000),
        (${id('TX', 'c3')}, ${SALON}, NULL,    'salon_revenue', 'credit', 3000, NULL),
        (${id('TX', 's4')}, ${SALON}, ${M[3]}, 'member_wallet', 'debit',  4000, 86000),
        (${id('TX', 's4')}, ${SALON}, NULL,    'salon_revenue', 'credit', 4000, NULL),
        (${id('TX', 'c5')}, ${SALON}, ${M[4]}, 'member_wallet', 'debit',  9000, 81000),
        (${id('TX', 'c5')}, ${SALON}, NULL,    'salon_revenue', 'credit', 9000, NULL),
        (${id('TX', 'c7')}, ${SALON}, ${M[6]}, 'member_wallet', 'debit',  8000, 82000),
        (${id('TX', 'c7')}, ${SALON}, NULL,    'salon_revenue', 'credit', 8000, NULL),
        (${id('TX', 'v5')}, ${SALON}, ${M[4]}, 'member_wallet', 'credit', 9000, 90000),
        (${id('TX', 'v5')}, ${SALON}, NULL,    'salon_revenue', 'debit',  9000, NULL)`);

    /**
     * EB-1'S BOOKING, and it is not decoration.
     *
     * A charge carrying a `deposit_held` leg with NO booking behind it is not a
     * state the product can reach - `services/charge.ts` applies a deposit only
     * when a booking held one - and `artist-performance` classifies exactly that
     * shape as a WALK-IN, whose own spec asserts a walk-in can never carry an
     * applied deposit. A first draft of this fixture wrote the ledger legs without
     * the booking and turned TWO OTHER FILES red
     * (`reportsArtist.int.test.ts`, `reportsReconciliation.int.test.ts`) against
     * unchanged production code. That is the append-only fixture's sharpest edge:
     * a row this file invents is permanent and every other spec in the suite reads
     * the same salon. The booking makes EB-1 the booked appointment it claims to
     * be.
     *
     * `booking_settlement_matches_status` makes `deposit_held` the only status
     * that may have a NULL `settled_transaction_id`, so `completed` here must name
     * the charge - which is also what makes the deposit reachable.
     */
    await db.execute(sql`
      INSERT INTO booking
        (id, salon_id, branch_id, branch_assumed, member_id, artist_id, service_id,
         starts_at, ends_at, duration_min, deposit_fils, status, hold_transaction_id,
         settled_transaction_id, completed_at, cancelled_at, returned_at, no_show_return_due_at)
      VALUES
        (${id('BK', 1)}, ${SALON}, ${SALMIYA}, false, ${M[0]}, ${ARTIST}, ${BOOKED_SERVICE},
           ${t(3, 1)}, ${t(3, 2)}, 60, 2000, 'completed', ${id('TX', 'h1')}, ${id('TX', 'c1')},
           ${t(3, 1)}, NULL, NULL, ${t(2, 1)})`);

    const session = async (staffId: string, salonId: string) =>
      (
        await issueSession(db, {
          principalKind: 'staff',
          staffId,
          salonId,
          scope: 'dashboard',
        })
      ).accessToken;

    bearer = await session(MANAGER, SALON);
    noDashboardBearer = await session(NO_DASHBOARD, SALON);
    foreignBearer = await session(FOREIGN_STAFF, OTHER_SALON);
  });

  afterAll(async () => {
    await app?.close();
  });

  // ---------------------------------------------------------------- drivers --

  async function get(kind: string, qs = '', token = bearer) {
    return app.inject({
      method: 'GET',
      url: `/salons/${SALON}/reports/${kind}${qs}`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  async function report<T>(kind: string, qs = ''): Promise<Report<T>> {
    const res = await get(kind, qs);
    expect(res.statusCode, res.body).toBe(200);
    return JSON.parse(res.body) as Report<T>;
  }

  const branches = (qs = '') => report<BranchRow>('earnings-by-branch', qs);
  const sales = (qs = '') => report<SalesRow>('sales', qs);

  const byBranch = (rows: BranchRow[], name: string) => rows.find((r) => r.branch === name);
  const sum = <T,>(rows: T[], key: keyof T) =>
    rows.reduce((total, row) => total + Number(row[key] ?? 0), 0);
  const salesFor = (rows: SalesRow[], name: string) =>
    rows.filter((r) => r.branch === name).reduce((t, r) => t + Number(r.grossFils ?? 0), 0);

  /**
   * THE ORACLE, WRITTEN FROM FIRST PRINCIPLES AND DELIBERATELY NOT IMPORTED.
   *
   * A spec that computed its expectation with the production expression would be
   * asserting `x === x`. This is the arithmetic stated independently - the wallet
   * movement plus the applied deposit legs, over the revenue kinds, excluding
   * what was voided - split by branch and by whether the branch was established.
   * It is the third implementation of the quantity in play, after the view and
   * the report.
   */
  async function oracle(branch: string | null, days = 30) {
    const from = new Date(Date.now() - days * DAY).toISOString();
    const b = branch === null ? sql`` : sql`AND t.branch_id = ${branch}`;
    const r = only(
      await exec(sql`
      SELECT coalesce(sum(-t.amount_fils), 0)::bigint AS naive,
             coalesce(sum(dep.applied), 0)::bigint AS deposits,
             coalesce(sum(-t.amount_fils) FILTER (WHERE t.branch_assumed), 0)::bigint AS naive_assumed,
             coalesce(sum(dep.applied) FILTER (WHERE t.branch_assumed), 0)::bigint AS deposits_assumed,
             count(*) AS txns,
             count(*) FILTER (WHERE t.branch_assumed) AS assumed_txns
        FROM "transaction" t
        LEFT JOIN (
              SELECT transaction_id, sum(amount_fils)::bigint AS applied
                FROM ledger_entry
               WHERE account = 'deposit_held' AND direction = 'debit'
               GROUP BY transaction_id
             ) dep ON dep.transaction_id = t.id
       WHERE t.salon_id = ${SALON}
         AND t.kind IN ('charge', 'shop')
         AND t.status = 'settled'
         AND t.created_at >= ${from}::timestamptz
         ${b}
         AND NOT EXISTS (
           SELECT 1 FROM "transaction" r
            WHERE r.reverses_transaction_id = t.id AND r.status = 'settled'
         )`),
      'the branch oracle',
    );
    const naive = Number(r.naive);
    const deposits = Number(r.deposits);
    const assumed = Number(r.naive_assumed) + Number(r.deposits_assumed);
    return {
      naive,
      deposits,
      earned: naive + deposits,
      assumed,
      established: naive + deposits - assumed,
      txns: Number(r.txns),
      assumedTxns: Number(r.assumed_txns),
    };
  }

  // ==================================================================
  // THE SHAPE.
  // ==================================================================
  describe('the report is a roll-up whose rows are branches', () => {
    it('names itself with the title the request asked for', async () => {
      const r = await branches('?period=30d');
      expect(r.kind).toBe('earnings-by-branch');
      expect(r.title).toBe('Earnings by branch');
      expect(r.stat.label).toBe('KD gross');
    });

    it('carries five columns, with the doubt beside the money it qualifies', async () => {
      const r = await branches('?period=30d');
      expect(r.columns.map((c) => c.header)).toEqual([
        'Branch',
        'Transactions',
        'Gross KD',
        'Assumed KD',
        'Assumed transactions',
      ]);
      // Every money column is `money`, so it goes through `fils()` on the way to
      // a cell and a float cannot be rendered - non-negotiable #1.
      const money = r.columns.filter((c) => c.type === 'money').map((c) => c.key);
      expect(money).toEqual(['grossFils', 'assumedGrossFils']);
    });

    it('gives EVERY branch of the salon a row, and only this salon s branches', async () => {
      const r = await branches('?period=30d');
      expect(r.rows.map((x) => x.branch).sort()).toEqual([KWC_NAME, SALMIYA_NAME]);
      expect(r.rowCount).toBe(2);
      // `Hawally` and `Jabriya` belong to SAL-LUMIERE.
      expect(JSON.stringify(r.rows)).not.toContain('Hawally');
      expect(JSON.stringify(r.rows)).not.toContain('Jabriya');
    });

    it('ranks by gross, because the ranking is the product', async () => {
      const r = await branches('?period=90d');
      const gross = r.rows.map((x) => Number(x.grossFils));
      expect([...gross].sort((a, x) => x - a)).toEqual(gross);
    });

    it('under ?branch= it is one row, and it is that branch', async () => {
      const r = await branches(`?period=30d&branch=${SALMIYA}`);
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]?.branch).toBe(SALMIYA_NAME);
    });

    it('404s a branch belonging to another salon, like every other kind', async () => {
      const res = await get('earnings-by-branch', '?branch=BR-LUM-HAW');
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error).toBe('unknown_branch');
      expect(res.body).not.toContain('Hawally');
    });
  });

  // ==================================================================
  // THE RECONCILIATION - the reason this report is allowed to exist.
  // ==================================================================
  describe('it reconciles with sales, which is the whole point', () => {
    it('all branches, 30d: the branch grosses sum to the sales gross', async () => {
      const b = await branches('?period=30d');
      const s = await sales('?period=30d');
      expect(b.stat.label).toBe(s.stat.label);
      expect(sum(b.rows, 'grossFils')).toBe(s.stat.value);
      expect(b.stat.value).toBe(s.stat.value);
    });

    it('and equals an oracle written independently of both', async () => {
      const b = await branches('?period=30d');
      const { earned } = await oracle(null, 30);
      expect(b.stat.value).toBe(earned);
    });

    /**
     * PER BRANCH, WHICH IS THE AXIS A MERCHANT ACTUALLY READS. The total agreeing
     * while a branch disagreed is the specific failure a "branch not established"
     * row would have produced, and it is the one this case exists to exclude.
     */
    it.each([
      [SALMIYA, SALMIYA_NAME],
      [KUWAIT_CITY, KWC_NAME],
    ])('branch %s: the row equals the sales card for the same branch', async (branchId, name) => {
      const all = await branches('?period=30d');
      const s = await sales('?period=30d');
      const { earned, txns } = await oracle(branchId, 30);

      expect(byBranch(all.rows, name)?.grossFils).toBe(earned);
      expect(byBranch(all.rows, name)?.grossFils).toBe(salesFor(s.rows, name));
      expect(byBranch(all.rows, name)?.transactions).toBe(txns);

      // And filtered, which is a different code path through the same query.
      const one = await branches(`?period=30d&branch=${branchId}`);
      expect(one.stat.value).toBe(earned);
      expect(one.rows[0]?.grossFils).toBe(earned);
    });

    it.each(['7d', '30d', '90d'])('period %s: both reports agree', async (period) => {
      const b = await branches(`?period=${period}`);
      const s = await sales(`?period=${period}`);
      expect(b.stat.value).toBe(s.stat.value);
    });

    it('the transaction counts reconcile too, not just the money', async () => {
      const b = await branches('?period=30d');
      const s = await sales('?period=30d');
      expect(sum(b.rows, 'transactions')).toBe(sum(s.rows, 'transactions'));
    });

    it('a voided charge is in neither report, and in neither branch', async () => {
      // EB-5 is 9.000 at Salmiya, voided. The oracle excludes it too, so the
      // claim that bites is the counterfactual: what the window WOULD total if a
      // voided visit still counted.
      const from = new Date(Date.now() - 30 * DAY).toISOString();
      const withVoided = only(
        await exec(sql`
        SELECT coalesce(sum(rev.earned_fils), 0)::bigint AS worth
          FROM "transaction" t
          JOIN transaction_revenue rev ON rev.transaction_id = t.id
         WHERE t.salon_id = ${SALON}
           AND t.created_at >= ${from}::timestamptz
           AND EXISTS (
             SELECT 1 FROM "transaction" r
              WHERE r.reverses_transaction_id = t.id AND r.status = 'settled'
           )`),
        'earned on voided transactions in the window',
      );
      expect(Number(withVoided.worth)).toBeGreaterThanOrEqual(9000);

      const b = await branches('?period=30d');
      const { earned } = await oracle(null, 30);
      expect(b.stat.value).toBe(earned);
      // Salmiya's own figure is short of the voided charge, not merely the total.
      const sal = await oracle(SALMIYA, 30);
      expect(byBranch(b.rows, SALMIYA_NAME)?.grossFils).toBe(sal.earned);
    });

    it('a top-up is revenue at no branch - it is a liability, not a sale', async () => {
      // EB-6 is a 20.000 KNET top-up at Kuwait City, and always `branch_assumed`.
      // It must be in neither the Gross nor the Assumed KD column.
      const b = await branches('?period=30d');
      const { earned, assumed } = await oracle(null, 30);
      expect(b.stat.value).toBe(earned);
      expect(sum(b.rows, 'assumedGrossFils')).toBe(assumed);
      // The oracle restricts by kind, so if a top-up had leaked into either
      // column the two equalities above could not both hold.
    });

    it('an appointment 45 days back is outside 30d and inside 90d', async () => {
      const thirty = await oracle(null, 30);
      const ninety = await oracle(null, 90);
      expect(ninety.earned - thirty.earned).toBeGreaterThanOrEqual(8000);
      const b30 = await branches('?period=30d');
      const b90 = await branches('?period=90d');
      expect(b30.stat.value).toBe(thirty.earned);
      expect(b90.stat.value).toBe(ninety.earned);
    });
  });

  // ==================================================================
  // THE ASSUMED COLUMNS.
  // ==================================================================
  describe('the size of the doubt is on the face of the report', () => {
    it('reports assumed money and assumed rows per branch, matching the oracle', async () => {
      const b = await branches('?period=30d');
      for (const [branchId, name] of [
        [SALMIYA, SALMIYA_NAME],
        [KUWAIT_CITY, KWC_NAME],
      ] as const) {
        const o = await oracle(branchId, 30);
        const row = byBranch(b.rows, name);
        expect(row?.assumedGrossFils, `${name} assumed KD`).toBe(o.assumed);
        expect(row?.assumedTransactions, `${name} assumed txns`).toBe(o.assumedTxns);
      }
    });

    it('assumed money is a SUBSET of gross, never more than it, never negative', async () => {
      for (const period of ['7d', '30d', '90d']) {
        const b = await branches(`?period=${period}`);
        for (const row of b.rows) {
          expect(Number(row.assumedGrossFils), `${row.branch} ${period}`).toBeGreaterThanOrEqual(0);
          expect(Number(row.assumedGrossFils)).toBeLessThanOrEqual(Number(row.grossFils));
          expect(Number(row.assumedTransactions)).toBeLessThanOrEqual(Number(row.transactions));
        }
      }
    });

    it('this run put assumed money at BOTH branches, so the fixture exercises the column', async () => {
      // EB-2 (5.000, Kuwait City) and EB-3 (3.000, Salmiya) are both assumed, so
      // neither branch's assumed figure can be zero and the case above is not
      // vacuous. Asserted as a floor, because earlier runs may have added more.
      const b = await branches('?period=30d');
      expect(Number(byBranch(b.rows, KWC_NAME)?.assumedGrossFils)).toBeGreaterThanOrEqual(5000);
      expect(Number(byBranch(b.rows, SALMIYA_NAME)?.assumedGrossFils)).toBeGreaterThanOrEqual(3000);
    });
  });

  // ==================================================================
  // THE SPEC HAS TEETH.
  // ==================================================================
  describe('the spec has teeth - the two figures this report does NOT return', () => {
    /**
     * REFUSING TO ATTRIBUTE assumed rows was one of the three options, and it is
     * the one a future reader is most likely to reach for. It produces a
     * STRICTLY SMALLER total that no longer reconciles with `sales`, and this
     * case pins both halves of that.
     */
    it('the established-only total is smaller, and the report does not return it', async () => {
      const { earned, assumed, established } = await oracle(null, 30);
      expect(assumed).toBeGreaterThan(0);
      expect(established).toBeLessThan(earned);

      const b = await branches('?period=30d');
      expect(b.stat.value).not.toBe(established);
      expect(b.stat.value - established).toBe(assumed);

      // And the consequence that decided it: the established-only figure would
      // disagree with `sales` by exactly the assumed money.
      const s = await sales('?period=30d');
      expect(s.stat.value - established).toBe(assumed);
    });

    /**
     * THE NAIVE SUM - `sum(-amount_fils)`, the wallet movement - is the defect
     * DECISIONS.md #81 closed. If this report ever stopped reading
     * `transaction_revenue`, EB-1's 2.000 deposit would vanish from Salmiya.
     */
    it('the naive wallet sum is smaller, and the report does not return that either', async () => {
      const { naive, deposits, earned } = await oracle(null, 30);
      expect(deposits).toBeGreaterThan(0);
      expect(earned).toBeGreaterThan(naive);

      const b = await branches('?period=30d');
      expect(b.stat.value).not.toBe(naive);
      expect(b.stat.value - naive).toBe(deposits);
    });
  });

  // ==================================================================
  // WHAT AN ASSUMED BRANCH ACTUALLY IS - driven, not read.
  // ==================================================================
  describe('what an assumed branch actually is', () => {
    /**
     * `services/branch.ts` with nothing supplied by an enrolled device runs
     * `ORDER BY id LIMIT 2` and takes the FIRST row, marking the transaction
     * assumed when there is a second. So the attribution is not an inference
     * about where the customer was - it is SORT ORDER, and every assumed row in
     * the salon piles onto one branch. This drives a real charge on a real
     * scanner session with an UN-ENROLLED device and reads the row back.
     */
    it('a real charge on an un-enrolled till lands on the LOWEST branch id, marked assumed', async () => {
      const before = await branches('?period=30d');
      const salBefore = Number(byBranch(before.rows, SALMIYA_NAME)?.grossFils);
      const kwcBefore = Number(byBranch(before.rows, KWC_NAME)?.grossFils);

      const issueSession = (await import('../auth/sessions')).issueSession;
      const till = await issueSession(db, {
        principalKind: 'staff',
        staffId: MANAGER,
        salonId: SALON,
        scope: 'scanner',
        deviceId: `DEV-INT-EB-${randomUUID()}`,
      });

      const customerId = id('M', 'driven');
      await db.execute(sql`
        INSERT INTO member (id, salon_id, name, phone, password_hash, balance_fils, tier, visits, policy_version)
        VALUES (${customerId}, ${SALON}, 'EB Driven', ${phoneSeq(8)}, 'x', 90000, 'bronze', 0, 3)`);

      const res = await app.inject({
        method: 'POST',
        url: '/charges',
        headers: {
          authorization: `Bearer ${till.accessToken}`,
          'idempotency-key': `int-eb-${randomUUID()}`,
        },
        payload: { memberId: customerId, serviceIds: [DRIVEN_SERVICE] },
      });
      expect(res.statusCode, res.body).toBe(200);

      /**
       * THE ROW ITSELF, not the API's reply. A server that answers plausibly is
       * not evidence about what it wrote.
       */
      const row = only(
        await exec(sql`
        SELECT branch_id, branch_assumed, amount_fils
          FROM "transaction"
         WHERE member_id = ${customerId} AND kind = 'charge'`),
        'the driven charge',
      );
      expect(row.branch_assumed).toBe(true);
      expect(row.branch_id).toBe(KUWAIT_CITY);
      expect(Number(row.amount_fils)).toBe(-DRIVEN_PRICE);

      /**
       * `BR-KWC` is not where anything happened. It is `min(id)` among the
       * salon's open branches - the exact query `resolveBranch` runs - and this
       * proves the report is reading a sort order, which is why `Assumed KD` is
       * a column and not a footnote.
       */
      const lowest = only(
        await exec(sql`
        SELECT id FROM branch
         WHERE salon_id = ${SALON} AND closed_at IS NULL
         ORDER BY id LIMIT 1`),
        'the lowest open branch id',
      );
      expect(lowest.id).toBe(KUWAIT_CITY);

      /**
       * AND THE PILE-ON, VISIBLE IN THE REPORT'S OWN OUTPUT. Kuwait City moved by
       * the whole charge; Salmiya did not move at all. A merchant reading these
       * two rows without the assumed columns would conclude Kuwait City had a
       * good week.
       */
      const after = await branches('?period=30d');
      expect(Number(byBranch(after.rows, KWC_NAME)?.grossFils)).toBe(kwcBefore + DRIVEN_PRICE);
      expect(Number(byBranch(after.rows, SALMIYA_NAME)?.grossFils)).toBe(salBefore);
      expect(Number(byBranch(after.rows, KWC_NAME)?.assumedGrossFils)).toBeGreaterThanOrEqual(
        DRIVEN_PRICE,
      );

      // And `sales` moved by the same amount at the same branch, so the two
      // reports still agree after a real charge and not only over a fixture.
      const s = await sales('?period=30d');
      expect(salesFor(s.rows, KWC_NAME)).toBe(Number(byBranch(after.rows, KWC_NAME)?.grossFils));
    });
  });

  // ==================================================================
  // NON-NEGOTIABLE #7, called directly against the endpoint.
  // ==================================================================
  describe('the gate', () => {
    /**
     * ST-002 Hessa, the seeded frontdesk: `perm_dashboard` is FALSE on her row,
     * and `perm_scanner` is true. Her own salon, a real dashboard session -
     * nothing but the permission is missing.
     */
    it('refuses a staff member without `dashboard` - JSON, CSV and the mint', async () => {
      const json = await get('earnings-by-branch', '?period=30d', noDashboardBearer);
      expect(json.statusCode).toBe(403);
      expect(json.body).not.toContain(SALMIYA_NAME);
      expect(json.body).not.toContain(KWC_NAME);

      const file = await app.inject({
        method: 'GET',
        url: `/salons/${SALON}/reports/earnings-by-branch.csv?period=30d`,
        headers: { authorization: `Bearer ${noDashboardBearer}` },
      });
      expect(file.statusCode).toBe(403);
      expect(file.body).not.toContain(SALMIYA_NAME);

      // The download-url mint is a third door onto the same aggregate.
      const mint = await app.inject({
        method: 'POST',
        url: `/salons/${SALON}/reports/earnings-by-branch/download-url`,
        headers: { authorization: `Bearer ${noDashboardBearer}` },
      });
      expect(mint.statusCode).toBe(403);
    });

    /**
     * THE FOURTH DOOR, and the one a `Record<ReportKind, ...>` in another file
     * could have left open: `GET /report-downloads/:token` re-reads the
     * permission from the staff row at REDEMPTION. A link minted by a manager and
     * redeemed after her `dashboard` is revoked must not serve the file.
     */
    it('a minted link stops working the moment the permission is revoked', async () => {
      const mint = await app.inject({
        method: 'POST',
        url: `/salons/${SALON}/reports/earnings-by-branch/download-url?period=30d`,
        headers: { authorization: `Bearer ${bearer}` },
      });
      expect(mint.statusCode, mint.body).toBe(200);
      const { url } = JSON.parse(mint.body) as { url: string };

      await db.execute(sql`UPDATE staff_user SET perm_dashboard = false WHERE id = ${MANAGER}`);
      try {
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode).toBe(401);
        expect(JSON.parse(res.body).error).toBe('invalid_download');
        expect(res.body).not.toContain(SALMIYA_NAME);
      } finally {
        await db.execute(sql`UPDATE staff_user SET perm_dashboard = true WHERE id = ${MANAGER}`);
      }
    });

    it('refuses a manager of ANOTHER salon who does hold `dashboard`', async () => {
      const json = await get('earnings-by-branch', '?period=30d', foreignBearer);
      expect(json.statusCode).toBe(403);
      expect(json.body).not.toContain(SALMIYA_NAME);
    });

    it('refuses an anonymous caller before it will even name the kind', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/salons/${SALON}/reports/earnings-by-branch`,
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ==================================================================
  // THE FILE, AND THE AUDIT LINE THAT IS DELIBERATELY ABSENT.
  // ==================================================================
  describe('the CSV', () => {
    it('carries the five headers and the same numbers as the JSON', async () => {
      const json = await branches('?period=30d');
      const res = await app.inject({
        method: 'GET',
        url: `/salons/${SALON}/reports/earnings-by-branch.csv?period=30d`,
        headers: { authorization: `Bearer ${bearer}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-disposition']).toContain(
        'earnings-by-branch_all-branches_30d.csv',
      );

      const lines = res.body.replace(/^﻿/, '').split('\r\n');
      expect(lines[0]).toBe(
        '"Branch","Transactions","Gross KD","Assumed KD","Assumed transactions"',
      );
      expect(lines).toHaveLength(json.rows.length + 1);

      // Money is formatted once, here, with no thousands separator so the
      // merchant can sum the column in the spreadsheet this file exists for.
      const salmiya = lines.find((l) => l.startsWith(`"${SALMIYA_NAME}"`));
      const sal = byBranch(json.rows, SALMIYA_NAME);
      const kd = (fils: number) => (fils / 1000).toFixed(3);
      expect(salmiya).toContain(`"${kd(Number(sal?.grossFils))}"`);
      expect(salmiya).not.toMatch(/"\d+,\d/);
    });

    /**
     * NOT AUDITED, AND THE BRIEF EXPECTED OTHERWISE - so this is asserted rather
     * than assumed. `REPORT_AUDITED` audits the two kinds whose rows name
     * identifiable PEOPLE; a branch is a place, and the identical money is
     * already exportable unaudited through `sales`. The argument is in
     * `services/reports.ts` § REPORT_AUDITED.
     *
     * The control case is in the same test: `customers` IS audited, over the same
     * window through the same handler, so a green here cannot mean "the audit
     * write is broken".
     */
    it('writes NO audit row - and `customers` through the same handler does', async () => {
      const countRows = async () =>
        Number(
          only(
            await exec(sql`
            SELECT count(*) AS n FROM audit_log
             WHERE salon_id = ${SALON} AND subject_type = 'report'`),
            'report audit rows',
          ).n,
        );

      const before = await countRows();
      await app.inject({
        method: 'GET',
        url: `/salons/${SALON}/reports/earnings-by-branch.csv?period=30d`,
        headers: { authorization: `Bearer ${bearer}` },
      });
      expect(await countRows()).toBe(before);

      const customers = await app.inject({
        method: 'GET',
        url: `/salons/${SALON}/reports/customers.csv?period=30d`,
        headers: { authorization: `Bearer ${bearer}` },
      });
      expect(customers.statusCode).toBe(200);
      expect(await countRows()).toBe(before + 1);
    });
  });

  // ==================================================================
  // INTEGER FILS - non-negotiable #1, to the cell.
  // ==================================================================
  it('every money figure the endpoint returns is an integer', async () => {
    for (const period of ['7d', '30d', '90d']) {
      const b = await branches(`?period=${period}`);
      expect(Number.isInteger(b.stat.value)).toBe(true);
      for (const row of b.rows) {
        expect(Number.isInteger(row.grossFils), `${row.branch} gross`).toBe(true);
        expect(Number.isInteger(row.assumedGrossFils), `${row.branch} assumed`).toBe(true);
        expect(Number.isInteger(row.transactions)).toBe(true);
        expect(Number.isInteger(row.assumedTransactions)).toBe(true);
      }
    }
  });
});
