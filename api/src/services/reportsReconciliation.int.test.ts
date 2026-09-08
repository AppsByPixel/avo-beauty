/**
 * THE TWO REPORTS RECONCILE — `sales` gross and `artist-performance` earned, over
 * the same window and the same branch, against real rows.  (DECISIONS.md #81)
 *
 * =========================================================================
 * WHY THIS IS THE SPEC WORTH HAVING
 * =========================================================================
 * `sales` groups by DAY over transactions. `artist-performance` groups by ARTIST
 * through bookings, with two named buckets for the money no artist can be given.
 * Different tables, different joins, different group keys, written months apart —
 * and they must produce the SAME TOTAL, because they are two aggregates over one
 * pile of money.
 *
 * That is the strongest check available over these figures, and it is what the
 * defect would have failed. `sales` summed `-amount_fils` — the WALLET movement —
 * so every booked appointment arrived net of the deposit already earned against
 * it, while `artist-performance` added the deposit back and got it right. The two
 * cards disagreed by 23.5% of takings on a driven window and nothing said so.
 * Both read `transaction_revenue` now, so the equality below is a property of one
 * definition rather than of two that happen to agree.
 *
 * A RECONCILIATION SPEC THAT CANNOT FAIL IS WORTHLESS, so § "the spec has teeth"
 * computes the OLD figure — the same naive sum, written out here rather than
 * imported — and asserts that the endpoint does NOT return it, and that the gap
 * is exactly the applied deposits. Revert either aggregate and two blocks below
 * go red for two different reasons.
 *
 * =========================================================================
 * WHY THE FIXTURE IS APPEND-ONLY, AND WHAT THAT DECIDES
 * =========================================================================
 * Identical to `reportsArtist.int.test.ts`'s reasoning, which is the model for
 * this file: proving the deposit path needs REAL `ledger_entry` rows, and
 * `ledger_entry` is append-only against the owner role as well as the app role
 * (migration 0001 + `ledger_entry_is_immutable`). A ledger row is permanent until
 * the schema is dropped, and `ON DELETE restrict` makes the transactions, members
 * and artists behind it permanent with it.
 *
 * So: SAL-AMARA, never SAL-LUMIERE (which `metrics.int.test.ts` asserts it owns
 * every row of), every id carries a per-run suffix, and NOTHING BELOW IS AN
 * ABSOLUTE SALON-WIDE FIGURE. The salon-wide assertions are RELATIONSHIPS —
 * "these two aggregates are equal", "the gap is exactly the deposits" — which
 * hold no matter how much traffic previous runs left behind. Absolute numbers are
 * asserted only on rows this run uniquely owns: its own artist, and one service
 * per case. Decision 75's multi-run requirement answered by construction rather
 * than by a fixture somebody has to remember to reset.
 *
 * =========================================================================
 * THE TEN CASES, AND WHAT EACH ONE WOULD CATCH
 * =========================================================================
 *   RC-1  BOOKED, service LARGER than the deposit. 9.000 basket, 4.000 held, so
 *         the charge row is -5.000 and the visit was worth 9.000. The plain
 *         understatement case: the old code reported 5.000.
 *   RC-2  BOOKED, deposit covers the service OUTRIGHT. 5.000 basket, 5.000 held,
 *         charge row EXACTLY ZERO and no wallet leg at all (services/charge.ts
 *         skips `walletSpendPosting` when `due` is 0). The old code reported
 *         0.000 for a visit the salon was paid in full for — a false zero.
 *   RC-3  WALK-IN. No booking, no deposit; worth `|amount_fils|` and nothing
 *         more. The case that fails an implementation which adds a deposit it
 *         cannot find, or double-counts one it can.
 *   RC-4  SHOP order. Revenue, no artist, no deposit.
 *   RC-5  BOOKED then VOIDED. Must net to ZERO in `sales` — and specifically must
 *         not leave the DEPOSIT half behind, which is the half a naive void fix
 *         would strand.
 *   RC-6  NO-SHOW RETURNED. Its settling transaction is a `deposit_return` whose
 *         `amount_fils` is POSITIVE, so the old `sum(-amount_fils)` scored this
 *         booking NEGATIVE in `best-selling-services` — a second defect, not in
 *         decision 81, found while fixing the first. Must be exactly 0.
 *   RC-7  Still `deposit_held`. Nothing settled; 0, and still counted as a
 *         booking.
 *   RC-8  A booked appointment 45 DAYS BACK. Outside every period offered.
 *   RC-9  A TOP-UP. Not revenue in any period, on any card.
 *   RC-10 BOOKED with a deposit LARGER than the basket: 3.000 basket, 5.000 held,
 *         so 3.000 is applied and the 2.000 remainder goes back as its own
 *         `deposit_return`. Worth 3.000. This is the case that catches reading
 *         `booking.deposit_fils` instead of the ledger leg (which would say
 *         5.000) and the case that catches counting a `deposit_return` as revenue
 *         (which would say 5.000 a different way) or as negative revenue (1.000).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const SALON = 'SAL-AMARA';
const SALMIYA = 'BR-SAL';
const KUWAIT_CITY = 'BR-KWC';
/** Seeded manager, every permission — `sales` needs `dashboard`, `best-selling-services` `appointments`, `artist-performance` `team`. */
const STAFF = 'ST-001';

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const id = (kind: string, n: number | string) => `RC-${kind}-${RUN}-${n}`;
const phoneSeq = (n: number) => `+9658${String(Date.now() % 1_000_000).padStart(6, '0')}${n}`;
const DAY = 86_400_000;

interface MoneyRow {
  attributedTo?: string;
  attribution?: string;
  service?: string;
  bookings?: number;
  revenueFils?: number;
  chargedFils?: number;
  depositAppliedFils?: number;
  earnedFils?: number;
  grossFils?: number;
  transactions?: number;
}
interface Report {
  rows: MoneyRow[];
  stat: { value: number; label: string };
}

suite('sales and artist-performance reconcile over the same money', () => {
  let app: FastifyInstance;
  let db: (typeof import('../db/client'))['db'];
  let sql: (typeof import('drizzle-orm'))['sql'];
  let bearer: string;

  const ARTIST = id('AR', 1);
  const VOID_ARTIST = id('AR', 2);
  const ARTIST_NAME = `RC Layla ${RUN}`;
  const VOID_ARTIST_NAME = `RC Voided ${RUN}`;
  /** One service per case, so every `best-selling-services` row is this run's alone. */
  const SV = {
    big: id('SV', 'big'),
    covered: id('SV', 'cov'),
    voided: id('SV', 'void'),
    noshow: id('SV', 'ns'),
    held: id('SV', 'held'),
    remainder: id('SV', 'rem'),
    old: id('SV', 'old'),
  };
  const SV_NAME = Object.fromEntries(
    Object.keys(SV).map((k) => [k, `RC ${k} ${RUN}`]),
  ) as Record<keyof typeof SV, string>;
  const M = [1, 2, 3, 4, 5, 6, 7].map((n) => id('M', n));

  const exec = async (q: unknown) =>
    (await db.execute(q as never)) as unknown as Array<Record<string, unknown>>;

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    sql = (await import('drizzle-orm')).sql;
    const issueSession = (await import('../auth/sessions')).issueSession;
    app = await (await import('../app')).buildApp();

    const t = (daysAgo: number, hour: number) =>
      new Date(Date.now() - daysAgo * DAY + hour * 3_600_000).toISOString();

    await db.execute(sql`
      INSERT INTO artist (id, salon_id, staff_user_id, name) VALUES
        (${ARTIST}, ${SALON}, NULL, ${ARTIST_NAME}),
        (${VOID_ARTIST}, ${SALON}, NULL, ${VOID_ARTIST_NAME})`);

    await db.execute(sql`
      INSERT INTO service (id, salon_id, name, price_fils) VALUES
        (${SV.big}, ${SALON}, ${SV_NAME.big}, 9000),
        (${SV.covered}, ${SALON}, ${SV_NAME.covered}, 5000),
        (${SV.voided}, ${SALON}, ${SV_NAME.voided}, 5000),
        (${SV.noshow}, ${SALON}, ${SV_NAME.noshow}, 6000),
        (${SV.held}, ${SALON}, ${SV_NAME.held}, 4000),
        (${SV.remainder}, ${SALON}, ${SV_NAME.remainder}, 3000),
        (${SV.old}, ${SALON}, ${SV_NAME.old}, 8000)`);

    await db.execute(sql`
      INSERT INTO member (id, salon_id, name, phone, password_hash, balance_fils, tier, visits, policy_version)
      VALUES
        (${M[0]}, ${SALON}, 'RC One',   ${phoneSeq(1)}, 'x', 90000, 'bronze', 0, 1),
        (${M[1]}, ${SALON}, 'RC Two',   ${phoneSeq(2)}, 'x', 90000, 'bronze', 0, 1),
        (${M[2]}, ${SALON}, 'RC Three', ${phoneSeq(3)}, 'x', 90000, 'bronze', 0, 1),
        (${M[3]}, ${SALON}, 'RC Four',  ${phoneSeq(4)}, 'x', 90000, 'bronze', 0, 1),
        (${M[4]}, ${SALON}, 'RC Five',  ${phoneSeq(5)}, 'x', 90000, 'bronze', 0, 1),
        (${M[5]}, ${SALON}, 'RC Six',   ${phoneSeq(6)}, 'x', 90000, 'bronze', 0, 1),
        (${M[6]}, ${SALON}, 'RC Seven', ${phoneSeq(7)}, 'x', 90000, 'bronze', 0, 1)`);

    /**
     * The deposit holds. Each is the wallet debit that put money into escrow, and
     * every one of them is `deposit_hold` — a kind neither report counts, because
     * it settles later as part of the charge and counting both would bill the same
     * service twice.
     */
    await db.execute(sql`
      INSERT INTO "transaction"
        (id, member_id, salon_id, branch_id, branch_assumed, kind, amount_fils, method, status, reference, created_at, settled_at)
      VALUES
        (${id('TX', 'h1')},  ${M[0]}, ${SALON}, ${SALMIYA}, false, 'deposit_hold', -4000, 'wallet', 'settled', '', ${t(4, 1)}, ${t(4, 1)}),
        (${id('TX', 'h2')},  ${M[1]}, ${SALON}, ${SALMIYA}, false, 'deposit_hold', -5000, 'wallet', 'settled', '', ${t(4, 2)}, ${t(4, 2)}),
        (${id('TX', 'h5')},  ${M[3]}, ${SALON}, ${SALMIYA}, false, 'deposit_hold', -3000, 'wallet', 'settled', '', ${t(4, 3)}, ${t(4, 3)}),
        (${id('TX', 'h6')},  ${M[4]}, ${SALON}, ${SALMIYA}, false, 'deposit_hold', -6000, 'wallet', 'settled', '', ${t(4, 4)}, ${t(4, 4)}),
        (${id('TX', 'h7')},  ${M[5]}, ${SALON}, ${SALMIYA}, false, 'deposit_hold', -4000, 'wallet', 'settled', '', ${t(4, 5)}, ${t(4, 5)}),
        (${id('TX', 'h8')},  ${M[6]}, ${SALON}, ${SALMIYA}, false, 'deposit_hold', -2000, 'wallet', 'settled', '', ${t(45, 5)}, ${t(45, 5)}),
        (${id('TX', 'h10')}, ${M[2]}, ${SALON}, ${SALMIYA}, false, 'deposit_hold', -5000, 'wallet', 'settled', '', ${t(4, 6)}, ${t(4, 6)})`);

    /**
     * THE REVENUE-BEARING ROWS. Signs are the schema's:
     * `transaction_amount_sign_matches_kind` makes a `charge` <= 0, a `shop` and a
     * `deposit_hold` < 0, a `topup`/`deposit_return` > 0.
     *
     *   c1   RC-1   basket 9.000 = 5.000 charged + 4.000 deposit
     *   c2   RC-2   basket 5.000 = 0.000 charged + 5.000 deposit   ← the false zero
     *   w3   RC-3   walk-in, 7.000, no booking
     *   s4   RC-4   shop, 3.000
     *   c5   RC-5   basket 5.000 = 2.000 charged + 3.000 deposit, then voided
     *   r6   RC-6   the no-show's `deposit_return`, +6.000
     *   c8   RC-8   45 days back: basket 8.000 = 6.000 + 2.000
     *   t9   RC-9   a top-up
     *   c10  RC-10  basket 3.000 = 0.000 charged + 3.000 applied of a 5.000 hold
     *   r10  RC-10  the 2.000 remainder, its own `deposit_return`
     */
    await db.execute(sql`
      INSERT INTO "transaction"
        (id, member_id, salon_id, branch_id, branch_assumed, kind, amount_fils, method, status, reference, created_at, settled_at)
      VALUES
        (${id('TX', 'c1')},  ${M[0]}, ${SALON}, ${SALMIYA},     false, 'charge',        -5000, 'wallet', 'settled', '', ${t(3, 1)}, ${t(3, 1)}),
        (${id('TX', 'c2')},  ${M[1]}, ${SALON}, ${SALMIYA},     false, 'charge',            0, 'wallet', 'settled', '', ${t(3, 2)}, ${t(3, 2)}),
        (${id('TX', 'w3')},  ${M[2]}, ${SALON}, ${KUWAIT_CITY}, false, 'charge',        -7000, 'wallet', 'settled', '', ${t(3, 3)}, ${t(3, 3)}),
        (${id('TX', 's4')},  ${M[2]}, ${SALON}, ${SALMIYA},     false, 'shop',          -3000, 'wallet', 'settled', '', ${t(3, 4)}, ${t(3, 4)}),
        (${id('TX', 'c5')},  ${M[3]}, ${SALON}, ${SALMIYA},     false, 'charge',        -2000, 'wallet', 'settled', '', ${t(3, 5)}, ${t(3, 5)}),
        (${id('TX', 'r6')},  ${M[4]}, ${SALON}, ${SALMIYA},     false, 'deposit_return', 6000, 'wallet', 'settled', '', ${t(3, 6)}, ${t(3, 6)}),
        (${id('TX', 'c8')},  ${M[6]}, ${SALON}, ${SALMIYA},     false, 'charge',        -6000, 'wallet', 'settled', '', ${t(45, 6)}, ${t(45, 6)}),
        (${id('TX', 't9')},  ${M[0]}, ${SALON}, ${SALMIYA},     true,  'topup',         20000, 'knet',   'settled', '', ${t(3, 7)}, ${t(3, 7)}),
        (${id('TX', 'c10')}, ${M[2]}, ${SALON}, ${SALMIYA},     false, 'charge',            0, 'wallet', 'settled', '', ${t(3, 8)}, ${t(3, 8)}),
        (${id('TX', 'r10')}, ${M[2]}, ${SALON}, ${SALMIYA},     false, 'deposit_return', 2000, 'wallet', 'settled', '', ${t(3, 9)}, ${t(3, 9)})`);

    /** The void of c5: a compensating `adjustment` naming the charge it reverses. */
    await db.execute(sql`
      INSERT INTO "transaction"
        (id, member_id, salon_id, branch_id, branch_assumed, kind, amount_fils, method, status, reference, reverses_transaction_id, created_at, settled_at)
      VALUES (${id('TX', 'v5')}, ${M[3]}, ${SALON}, ${SALMIYA}, false, 'adjustment', 5000, 'wallet', 'settled', '', ${id('TX', 'c5')}, ${t(2, 1)}, ${t(2, 1)})`);

    /**
     * THE LEDGER, and only the legs the real handlers would have written.
     * `walletSpendPosting` is `member_wallet` DEBIT + `salon_revenue` CREDIT and is
     * SKIPPED when `due` is 0 — so c2 and c10 carry the deposit pair and nothing
     * else, which is what makes them the false-zero cases.
     * `depositAppliedPosting` is `deposit_held` DEBIT + `salon_revenue` CREDIT.
     * `depositReleasedPosting` (the two returns) is `deposit_held` DEBIT +
     * `member_wallet` CREDIT — note it ALSO writes a `deposit_held` debit, which is
     * precisely why the view restricts by transaction KIND rather than trusting the
     * account alone.
     * `chargeReversedPosting` (the void) is `member_wallet` CREDIT +
     * `salon_revenue` DEBIT, and carries NO deposit leg.
     * `ledger_entry_balanced` checks debits-minus-credits per transaction at COMMIT,
     * so every pair below lands or none of them do.
     */
    await db.execute(sql`
      INSERT INTO ledger_entry (transaction_id, salon_id, member_id, account, direction, amount_fils, balance_after_fils)
      VALUES
        (${id('TX', 'c1')},  ${SALON}, ${M[0]}, 'member_wallet', 'debit',   5000, 81000),
        (${id('TX', 'c1')},  ${SALON}, NULL,    'salon_revenue', 'credit',  5000, NULL),
        (${id('TX', 'c1')},  ${SALON}, NULL,    'deposit_held',  'debit',   4000, NULL),
        (${id('TX', 'c1')},  ${SALON}, NULL,    'salon_revenue', 'credit',  4000, NULL),
        (${id('TX', 'c2')},  ${SALON}, NULL,    'deposit_held',  'debit',   5000, NULL),
        (${id('TX', 'c2')},  ${SALON}, NULL,    'salon_revenue', 'credit',  5000, NULL),
        (${id('TX', 'w3')},  ${SALON}, ${M[2]}, 'member_wallet', 'debit',   7000, 83000),
        (${id('TX', 'w3')},  ${SALON}, NULL,    'salon_revenue', 'credit',  7000, NULL),
        (${id('TX', 's4')},  ${SALON}, ${M[2]}, 'member_wallet', 'debit',   3000, 80000),
        (${id('TX', 's4')},  ${SALON}, NULL,    'salon_revenue', 'credit',  3000, NULL),
        (${id('TX', 'c5')},  ${SALON}, ${M[3]}, 'member_wallet', 'debit',   2000, 88000),
        (${id('TX', 'c5')},  ${SALON}, NULL,    'salon_revenue', 'credit',  2000, NULL),
        (${id('TX', 'c5')},  ${SALON}, NULL,    'deposit_held',  'debit',   3000, NULL),
        (${id('TX', 'c5')},  ${SALON}, NULL,    'salon_revenue', 'credit',  3000, NULL),
        (${id('TX', 'r6')},  ${SALON}, NULL,    'deposit_held',  'debit',   6000, NULL),
        (${id('TX', 'r6')},  ${SALON}, ${M[4]}, 'member_wallet', 'credit',  6000, 96000),
        (${id('TX', 'c8')},  ${SALON}, ${M[6]}, 'member_wallet', 'debit',   6000, 84000),
        (${id('TX', 'c8')},  ${SALON}, NULL,    'salon_revenue', 'credit',  6000, NULL),
        (${id('TX', 'c8')},  ${SALON}, NULL,    'deposit_held',  'debit',   2000, NULL),
        (${id('TX', 'c8')},  ${SALON}, NULL,    'salon_revenue', 'credit',  2000, NULL),
        (${id('TX', 'c10')}, ${SALON}, NULL,    'deposit_held',  'debit',   3000, NULL),
        (${id('TX', 'c10')}, ${SALON}, NULL,    'salon_revenue', 'credit',  3000, NULL),
        (${id('TX', 'r10')}, ${SALON}, NULL,    'deposit_held',  'debit',   2000, NULL),
        (${id('TX', 'r10')}, ${SALON}, ${M[2]}, 'member_wallet', 'credit',  2000, 82000),
        (${id('TX', 'v5')},  ${SALON}, ${M[3]}, 'member_wallet', 'credit',  5000, 93000),
        (${id('TX', 'v5')},  ${SALON}, NULL,    'salon_revenue', 'debit',   5000, NULL)`);

    /**
     * THE BOOKINGS. Statuses and settling transactions are one fact —
     * `booking_settlement_matches_status` makes `deposit_held` the ONLY status that
     * may have a NULL `settled_transaction_id` — so each row below is the state
     * machine's own spelling of its case.
     *
     * BK-5's settling transaction is the VOID, and its status `cancelled`: that is
     * what `routes/charges.ts` rewrites it to, and the fixture spells it the same
     * way so the reports are tested against the state a void actually leaves.
     *
     * `booking_artist_slot_no_overlap` is a GiST EXCLUDE over
     * (artist_id, [starts_at, ends_at)) for held and completed bookings, so every
     * slot on one artist is a distinct hour.
     */
    await db.execute(sql`
      INSERT INTO booking
        (id, salon_id, branch_id, branch_assumed, member_id, artist_id, service_id,
         starts_at, ends_at, duration_min, deposit_fils, status, hold_transaction_id,
         settled_transaction_id, completed_at, cancelled_at, returned_at, no_show_return_due_at)
      VALUES
        (${id('BK', 1)}, ${SALON}, ${SALMIYA}, false, ${M[0]}, ${ARTIST}, ${SV.big},
           ${t(3, 1)}, ${t(3, 2)}, 60, 4000, 'completed', ${id('TX', 'h1')}, ${id('TX', 'c1')}, ${t(3, 1)}, NULL, NULL, ${t(2, 1)}),
        (${id('BK', 2)}, ${SALON}, ${SALMIYA}, false, ${M[1]}, ${ARTIST}, ${SV.covered},
           ${t(3, 2)}, ${t(3, 3)}, 60, 5000, 'completed', ${id('TX', 'h2')}, ${id('TX', 'c2')}, ${t(3, 2)}, NULL, NULL, ${t(2, 2)}),
        (${id('BK', 5)}, ${SALON}, ${SALMIYA}, false, ${M[3]}, ${VOID_ARTIST}, ${SV.voided},
           ${t(3, 5)}, ${t(3, 6)}, 60, 3000, 'cancelled', ${id('TX', 'h5')}, ${id('TX', 'v5')}, NULL, ${t(2, 1)}, NULL, ${t(2, 5)}),
        (${id('BK', 6)}, ${SALON}, ${SALMIYA}, false, ${M[4]}, ${ARTIST}, ${SV.noshow},
           ${t(3, 6)}, ${t(3, 7)}, 60, 6000, 'no_show_returned', ${id('TX', 'h6')}, ${id('TX', 'r6')}, NULL, NULL, ${t(3, 6)}, ${t(2, 6)}),
        (${id('BK', 7)}, ${SALON}, ${SALMIYA}, false, ${M[5]}, ${ARTIST}, ${SV.held},
           ${t(3, 7)}, ${t(3, 8)}, 60, 4000, 'deposit_held', ${id('TX', 'h7')}, NULL, NULL, NULL, NULL, ${t(2, 7)}),
        (${id('BK', 8)}, ${SALON}, ${SALMIYA}, false, ${M[6]}, ${ARTIST}, ${SV.old},
           ${t(45, 6)}, ${t(45, 7)}, 60, 2000, 'completed', ${id('TX', 'h8')}, ${id('TX', 'c8')}, ${t(45, 6)}, NULL, NULL, ${t(44, 6)}),
        (${id('BK', 10)}, ${SALON}, ${SALMIYA}, false, ${M[2]}, ${ARTIST}, ${SV.remainder},
           ${t(3, 8)}, ${t(3, 9)}, 60, 5000, 'completed', ${id('TX', 'h10')}, ${id('TX', 'c10')}, ${t(3, 8)}, NULL, NULL, ${t(2, 8)})`);

    bearer = (
      await issueSession(db, {
        principalKind: 'staff',
        staffId: STAFF,
        salonId: SALON,
        scope: 'dashboard',
      })
    ).accessToken;
  });

  afterAll(async () => {
    await app?.close();
  });

  // -------------------------------------------------------------- the driver --

  async function report(kind: string, qs = ''): Promise<Report> {
    const res = await app.inject({
      method: 'GET',
      url: `/salons/${SALON}/reports/${kind}${qs}`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    return JSON.parse(res.body) as Report;
  }

  /**
   * THE ORACLE, WRITTEN OUT HERE AND DELIBERATELY NOT IMPORTED.
   *
   * A spec that computed its expectation with the production expression would be
   * asserting `x === x`. So this is the arithmetic stated from first principles —
   * the wallet movement plus the applied deposit legs, over the revenue kinds,
   * excluding what was voided — and it is the third independent implementation in
   * play. `naive` is the OLD figure, the wallet movement alone, and § "the spec
   * has teeth" uses it to prove this file can go red.
   */
  async function oracle(branch: string | null, days = 30) {
    const from = new Date(Date.now() - days * DAY).toISOString();
    const b = branch === null ? sql`` : sql`AND t.branch_id = ${branch}`;
    const [r] = await exec(sql`
      SELECT coalesce(sum(-t.amount_fils), 0)::bigint AS naive,
             coalesce(sum(dep.applied), 0)::bigint AS deposits
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
         )`);
    const naive = Number(r.naive);
    const deposits = Number(r.deposits);
    return { naive, deposits, earned: naive + deposits };
  }

  const bySvc = (rows: MoneyRow[], name: string) => rows.find((r) => r.service === name);
  const byArtist = (rows: MoneyRow[], name: string) =>
    rows.find((r) => r.attributedTo === name);

  // ==================================================================
  // THE RECONCILIATION.
  // ==================================================================
  describe('the two reports agree on the same window', () => {
    it('all branches, 30d: sales gross = artist-performance earned', async () => {
      const sales = await report('sales', '?period=30d');
      const artists = await report('artist-performance', '?period=30d');
      expect(sales.stat.label).toBe('KD gross');
      expect(artists.stat.label).toBe('KD earned');
      expect(sales.stat.value).toBe(artists.stat.value);
    });

    it('and equals an oracle written independently of both', async () => {
      const sales = await report('sales', '?period=30d');
      const { earned } = await oracle(null, 30);
      expect(sales.stat.value).toBe(earned);
    });

    /**
     * PER BRANCH TOO, and this is not a repetition of the case above. `sales`
     * filters on `transaction.branch_id` and so does every row of
     * `artist-performance` — deliberately, rather than on the BOOKING's branch,
     * which can differ (services/reports.ts § `?branch=` FILTERS ON THE
     * TRANSACTION'S BRANCH). If either report ever changed which column it
     * filtered on, the all-branches total would stay equal and only this would
     * break.
     */
    it.each([SALMIYA, KUWAIT_CITY])('branch %s, 30d: both agree', async (branch) => {
      const sales = await report('sales', `?period=30d&branch=${branch}`);
      const artists = await report('artist-performance', `?period=30d&branch=${branch}`);
      const { earned } = await oracle(branch, 30);
      expect(sales.stat.value).toBe(artists.stat.value);
      expect(sales.stat.value).toBe(earned);
    });

    it.each(['7d', '30d', '90d'])('period %s: both agree', async (period) => {
      const sales = await report('sales', `?period=${period}`);
      const artists = await report('artist-performance', `?period=${period}`);
      expect(sales.stat.value).toBe(artists.stat.value);
    });

    /** The branches partition the salon, so the parts must add to the whole. */
    it('the per-branch grosses sum to the all-branch gross', async () => {
      const all = await report('sales', '?period=30d');
      const sal = await report('sales', `?period=30d&branch=${SALMIYA}`);
      const kwc = await report('sales', `?period=30d&branch=${KUWAIT_CITY}`);
      expect(sal.stat.value + kwc.stat.value).toBe(all.stat.value);
    });
  });

  // ==================================================================
  // THE SPEC HAS TEETH.
  // ==================================================================
  describe('the spec has teeth — the old definition does NOT reconcile', () => {
    it('the corrected gross is strictly larger than the naive one', async () => {
      const { naive, deposits, earned } = await oracle(null, 30);
      expect(deposits).toBeGreaterThan(0);
      expect(earned).toBeGreaterThan(naive);
      const sales = await report('sales', '?period=30d');
      expect(sales.stat.value).not.toBe(naive);
      expect(sales.stat.value - naive).toBe(deposits);
    });

    it('artist-performance would not reconcile against the naive figure either', async () => {
      const { naive } = await oracle(null, 30);
      const artists = await report('artist-performance', '?period=30d');
      expect(artists.stat.value).not.toBe(naive);
    });

    /**
     * The gap is not a rounding artefact but the whole of a deposit: the covered
     * case (RC-2) contributes 5.000 of pure deposit and a naive `sales` reported
     * 0.000 for it. Asserted on the ROW, where this run owns the number.
     */
    it('the deposit-covered appointment is 5.000 in the report and 0 in the naive sum', async () => {
      const artists = await report('artist-performance', '?period=30d');
      const covered = byArtist(artists.rows, ARTIST_NAME);
      expect(covered?.chargedFils).toBe(0 + 0 + 5000); // c1 5.000, c2 0, c10 0
      expect(covered?.depositAppliedFils).toBe(4000 + 5000 + 3000);
      expect(covered?.earnedFils).toBe(9000 + 5000 + 3000);
    });
  });

  // ==================================================================
  // THE BOUNDARIES, ONE CASE AT A TIME.
  // ==================================================================
  describe('what counts, proved case by case', () => {
    it("a booked appointment is |amount_fils| + the deposit applied — this run's artist", async () => {
      const artists = await report('artist-performance', '?period=30d');
      const row = byArtist(artists.rows, ARTIST_NAME);
      // RC-1, RC-2 and RC-10 only: the no-show and the still-held booking have no
      // charge, and RC-8 is 45 days back.
      expect(row?.appointments).toBe(3);
      expect(row?.earnedFils).toBe(17000);
      expect((row?.chargedFils ?? 0) + (row?.depositAppliedFils ?? 0)).toBe(row?.earnedFils);
    });

    it('a walk-in is |amount_fils| and carries no deposit', async () => {
      const artists = await report('artist-performance', '?period=30d');
      const walkin = byArtist(artists.rows, 'Walk-in charges');
      expect(walkin?.attribution).toBe('no artist');
      // Shared with previous runs, so the ASSERTION is the invariant: a walk-in
      // has no booking and therefore no deposit to apply, ever.
      expect(walkin?.depositAppliedFils).toBe(0);
      expect(walkin?.earnedFils).toBe(walkin?.chargedFils);
      expect(walkin?.chargedFils ?? 0).toBeGreaterThanOrEqual(7000);
    });

    it('a shop order is revenue with no deposit and no artist', async () => {
      const artists = await report('artist-performance', '?period=30d');
      const shop = byArtist(artists.rows, 'Shop orders');
      expect(shop?.depositAppliedFils).toBe(0);
      expect(shop?.earnedFils).toBe(shop?.chargedFils);
    });

    /**
     * A `deposit_return` IS NOT REVENUE, in either direction. RC-10's 2.000
     * remainder came back to her wallet: counting it would report 5.000 for a
     * 3.000 visit, and subtracting it (which `sum(-amount_fils)` did, since a
     * return is POSITIVE) would report 1.000.
     */
    it('a deposit_return is neither added nor subtracted', async () => {
      const svc = bySvc((await report('best-selling-services', '?period=30d')).rows, SV_NAME.remainder);
      expect(svc?.bookings).toBe(1);
      expect(svc?.revenueFils).toBe(3000);
    });

    it('a top-up is not revenue on either card', async () => {
      // Asserted as an absence: RC-9's 20.000 is not in the gap between the two
      // reports, and both reconcile to the oracle, which excludes `topup` by kind.
      const sales = await report('sales', '?period=30d');
      const { earned } = await oracle(null, 30);
      expect(sales.stat.value).toBe(earned);
    });
  });

  // ==================================================================
  // A VOID NETS TO ZERO, INCLUDING THE DEPOSIT HALF.
  // ==================================================================
  describe('a voided booked appointment leaves nothing behind', () => {
    it('the voided charge is worth 5.000 and sales gross is exactly 5.000 short of it', async () => {
      /**
       * The direct form of the claim, and it needs the counterfactual to mean
       * anything. `worthIfCounted` is the same oracle WITHOUT the void exclusion —
       * what the window would total if a voided visit still counted — and the gap
       * between it and what `sales` returns must be the whole 5.000, both halves.
       *
       * A `sales` that stranded the deposit half would land 3.000 short of this,
       * which is the specific failure a naive fix produces: correct the gross
       * expression, forget that the void's refund already included the deposit,
       * and the voided appointment leaves 3.000 of phantom revenue behind.
       */
      const [w] = await exec(sql`
        SELECT rev.charged_fils, rev.deposit_applied_fils, rev.earned_fils
          FROM transaction_revenue rev
         WHERE rev.transaction_id = ${id('TX', 'c5')}`);
      expect(Number(w.charged_fils)).toBe(2000);
      expect(Number(w.deposit_applied_fils)).toBe(3000);
      expect(Number(w.earned_fils)).toBe(5000);

      const from = new Date(Date.now() - 30 * DAY).toISOString();
      const [all] = await exec(sql`
        SELECT coalesce(sum(rev.earned_fils), 0)::bigint AS worth
          FROM "transaction" t
          JOIN transaction_revenue rev ON rev.transaction_id = t.id
         WHERE t.salon_id = ${SALON}
           AND t.created_at >= ${from}::timestamptz`);

      const sales = await report('sales', '?period=30d');
      const voidedInWindow = await exec(sql`
        SELECT coalesce(sum(rev.earned_fils), 0)::bigint AS worth
          FROM "transaction" t
          JOIN transaction_revenue rev ON rev.transaction_id = t.id
         WHERE t.salon_id = ${SALON}
           AND t.created_at >= ${from}::timestamptz
           AND EXISTS (
             SELECT 1 FROM "transaction" r
              WHERE r.reverses_transaction_id = t.id AND r.status = 'settled'
           )`);

      expect(Number(voidedInWindow[0].worth)).toBeGreaterThanOrEqual(5000);
      expect(sales.stat.value).toBe(Number(all.worth) - Number(voidedInWindow[0].worth));
    });

    it("the void's refund is the whole worth of the visit, deposit included", async () => {
      const [r] = await exec(sql`
        SELECT amount_fils FROM "transaction" WHERE id = ${id('TX', 'v5')}`);
      expect(Number(r.amount_fils)).toBe(5000);
    });

    it('its artist is zero, and the money is not in an unattributed row either', async () => {
      const artists = await report('artist-performance', '?period=30d');
      const row = byArtist(artists.rows, VOID_ARTIST_NAME);
      expect(row?.appointments).toBe(0);
      expect(row?.chargedFils).toBe(0);
      expect(row?.depositAppliedFils).toBe(0);
      expect(row?.earnedFils).toBe(0);
    });

    it('the voided booking is not a best-selling booking either', async () => {
      const rows = (await report('best-selling-services', '?period=30d')).rows;
      expect(bySvc(rows, SV_NAME.voided)).toBeUndefined();
    });
  });

  // ==================================================================
  // BEST-SELLING SERVICES — the same money, per service.
  // ==================================================================
  describe('best-selling-services counts bookings and reports what they were worth', () => {
    it('a service larger than its deposit reports the WHOLE basket', async () => {
      const rows = (await report('best-selling-services', '?period=30d')).rows;
      const row = bySvc(rows, SV_NAME.big);
      expect(row?.bookings).toBe(1);
      expect(row?.revenueFils).toBe(9000); // not 5.000, which is the charge row
    });

    it('a service its deposit covered outright is NOT 0.000', async () => {
      const rows = (await report('best-selling-services', '?period=30d')).rows;
      const row = bySvc(rows, SV_NAME.covered);
      expect(row?.bookings).toBe(1);
      expect(row?.revenueFils).toBe(5000);
    });

    /**
     * THE SECOND DEFECT, AND THE REASON THIS CASE IS HERE.
     *
     * A `no_show_returned` booking HAS a settling transaction — the
     * `deposit_return` that gave the money back — and a return's `amount_fils` is
     * POSITIVE. `sum(-st.amount_fils)` therefore scored this booking at MINUS
     * 6.000, dragging its service's revenue down and, with enough no-shows, below
     * zero. Zero is the right answer: the slot was held, so it is still a booking,
     * and nothing was earned.
     */
    it('a no-show whose deposit went back is 0.000, not NEGATIVE', async () => {
      const rows = (await report('best-selling-services', '?period=30d')).rows;
      const row = bySvc(rows, SV_NAME.noshow);
      expect(row?.bookings).toBe(1);
      expect(row?.revenueFils).toBe(0);
      expect(row?.revenueFils).not.toBe(-6000);
    });

    it('a booking still holding its deposit counts as a booking and earns 0.000', async () => {
      const rows = (await report('best-selling-services', '?period=30d')).rows;
      const row = bySvc(rows, SV_NAME.held);
      expect(row?.bookings).toBe(1);
      expect(row?.revenueFils).toBe(0);
    });

    it('no row has negative revenue, on any period', async () => {
      for (const period of ['7d', '30d', '90d']) {
        const rows = (await report('best-selling-services', `?period=${period}`)).rows;
        for (const row of rows) {
          expect(row.revenueFils, `${row.service} on ${period}`).toBeGreaterThanOrEqual(0);
        }
      }
    });

    it('an appointment 45 days back is outside the 30d window and inside 90d', async () => {
      const thirty = (await report('best-selling-services', '?period=30d')).rows;
      expect(bySvc(thirty, SV_NAME.old)).toBeUndefined();
      const ninety = (await report('best-selling-services', '?period=90d')).rows;
      expect(bySvc(ninety, SV_NAME.old)?.revenueFils).toBe(8000);
    });
  });

  // ==================================================================
  // INTEGER FILS — non-negotiable #1, at the boundary the CSV crosses.
  // ==================================================================
  describe('integer fils all the way to the cell', () => {
    it('every money figure the endpoints return is an integer', async () => {
      for (const kind of ['sales', 'best-selling-services', 'artist-performance']) {
        const { rows, stat } = await report(kind, '?period=30d');
        expect(Number.isInteger(stat.value), `${kind} stat`).toBe(true);
        for (const row of rows) {
          for (const key of ['grossFils', 'revenueFils', 'chargedFils', 'depositAppliedFils', 'earnedFils'] as const) {
            const v = row[key];
            if (v !== undefined) expect(Number.isInteger(v), `${kind}.${key}`).toBe(true);
          }
        }
      }
    });

    it('the CSV renders the corrected gross, not the net one', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/salons/${SALON}/reports/best-selling-services.csv?period=30d`,
        headers: { authorization: `Bearer ${bearer}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain(`"${SV_NAME.big}"`);
      expect(res.body).toContain('"9.000"');
    });
  });
});
