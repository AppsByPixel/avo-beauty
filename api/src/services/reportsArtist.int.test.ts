/**
 * `GET /salons/{id}/reports/artist-performance` — against real rows, the real
 * driver and the real permission stack.
 *
 * =========================================================================
 * WHY THE FIXTURE IS APPEND-ONLY, AND WHY EVERY EXPECTATION IS DERIVED
 * =========================================================================
 * `metrics.int.test.ts` is the model for this file in every respect but one, and
 * the exception is forced rather than chosen: THIS SUITE CANNOT CLEAN UP AFTER
 * ITSELF, AND NEITHER CAN ANYBODY ELSE.
 *
 * The report reads the applied deposit out of `ledger_entry`, so proving that path
 * needs real ledger rows. `ledger_entry` is append-only by construction — migration
 * 0001 revokes UPDATE and DELETE from `avo_app` AND installs
 * `ledger_entry_is_immutable`, a BEFORE DELETE OR UPDATE trigger that refuses the
 * owner role too. A ledger row, once written, is permanent until the schema is
 * dropped. And `ledger_entry.transaction_id` is `ON DELETE restrict`, so the
 * transactions those rows point at are permanent with them, and so are the members
 * and artists those transactions point at.
 *
 * That has two consequences, and both are design decisions rather than apologies:
 *
 *   1. IT RUNS AT SAL-AMARA, NOT SAL-LUMIERE — the opposite of the choice
 *      `metrics.int.test.ts` made, and for a reason that file's header explains
 *      from the other side. SAL-LUMIERE is the salon it owns every row of, and it
 *      asserts `strays = 0` there before it measures anything. A ledger-bearing
 *      transaction left at SAL-LUMIERE would not only trip that assertion; it would
 *      make its `DELETE FROM "transaction" WHERE id LIKE 'IT-TX-%'` fail on a
 *      foreign key FOR EVER, breaking another suite permanently. So this file stays
 *      out of that salon entirely.
 *
 *   2. NOTHING BELOW IS AN ABSOLUTE NUMBER. Every id carries a per-run suffix, so
 *      each run's artists are new rows nothing else feeds, and the totals are read
 *      out of SQL at the same instant the report is taken rather than written down
 *      here. That is decision 75 answered by construction instead of by a fixture
 *      that has to be reset: a second and third run add more rows and every
 *      expectation still holds, because every expectation is a RELATIONSHIP —
 *      "the artist rows plus the two named unattributed rows account for the
 *      salon's charge and shop revenue, exactly" — and a relationship does not care
 *      how much other traffic shares the salon.
 *
 * The one cross-salon footprint is a SAL-LUMIERE staff row for the tenancy test,
 * which has no ledger behind it and IS deleted in `afterAll`.
 *
 * =========================================================================
 * THE FIXTURE, AND WHY EACH ROW IS THE SHAPE IT IS
 * =========================================================================
 * Every case below exists to fail a plausible wrong implementation.
 *
 *   AR-1  no staff link. TWO charged appointments, two different members, one of
 *         them DEPOSIT-COVERED (basket 5.000 against a 5.000 deposit, so the charge
 *         row is EXACTLY ZERO). This is the row that fails an implementation summing
 *         `-amount_fils`: it would print 5.000 where 10.000 was earned, and would
 *         have printed 0.000 for the covered visit on its own.
 *   AR-2  WITH a staff link, so `Staff account` has both spellings to render.
 *   AR-3  no appointments at all — the TRUE zero. A merchant must be able to tell
 *         this row from an unattributed one, which is what `Attribution` is for.
 *   AR-4  one appointment whose charge was VOIDED. Her row must be zero and the
 *         money must not surface in an unattributed row either.
 *   AR-5  a booking at SALMIYA settled by a charge recorded at KUWAIT CITY. The
 *         branch-disagreement case, and the only fixture that can tell the two
 *         candidate branch columns apart.
 *
 * Plus, unattributed or excluded: a walk-in charge (no booking), a shop sale, a
 * top-up (not revenue in any period), a booking still `deposit_held`, a cancelled
 * booking settled by a `deposit_return`, and one charged appointment 45 days back
 * so the period boundary has something to exclude.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const SALON = 'SAL-AMARA';
const OTHER_SALON = 'SAL-LUMIERE';
const SALMIYA = 'BR-SAL';
const KUWAIT_CITY = 'BR-KWC';

/** Seeded frontdesk. `perm_team` FALSE, `perm_appointments` TRUE — see db/seed.ts. */
const NO_TEAM_STAFF = 'ST-002';
/** Seeded manager. `perm_team` TRUE. */
const TEAM_STAFF = 'ST-001';

/**
 * The per-run suffix that makes this fixture append-only-safe. Base36 of the
 * clock, so two runs a second apart cannot collide and a run cannot collide with
 * a previous run's leftovers.
 */
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const id = (kind: string, n: number | string) => `AP-${kind}-${RUN}-${n}`;

/** Digits for an E.164 phone: `member_phone_is_e164` is `^\+[1-9][0-9]{6,14}$`. */
const phoneSeq = (n: number) => `+9659${String(Date.now() % 1_000_000).padStart(6, '0')}${n}`;

const DAY = 86_400_000;

interface Row {
  attributedTo: string;
  attribution: string;
  staffAccount: string;
  customers: number;
  appointments: number;
  chargedFils: number;
  depositAppliedFils: number;
  earnedFils: number;
}

suite('GET /salons/:id/reports/artist-performance', () => {
  let app: FastifyInstance;
  let db: (typeof import('../db/client'))['db'];
  let sql: (typeof import('drizzle-orm'))['sql'];
  let bearer: string;
  let noTeamBearer: string;
  let foreignBearer: string;

  /**
   * FIXED-LENGTH ON PURPOSE. `[1,2,3,4,5].map(...)` is a `string[]`, so under
   * `noUncheckedIndexedAccess` every destructured name and every `M[n]` below was
   * `string | undefined` - which is what made `mine(rows, AR1)` and the computed
   * keys in `mine` fail once specs were typechecked. The annotation is not a cast:
   * the compiler counts the elements of the literal against it, so a sixth artist
   * added here without widening the type is an error rather than a silent
   * `undefined` interpolated into a fixture name.
   */
  const AR: readonly [string, string, string, string, string] = [
    id('AR', 1),
    id('AR', 2),
    id('AR', 3),
    id('AR', 4),
    id('AR', 5),
  ];
  const [AR1, AR2, AR3, AR4, AR5] = AR;
  const AR2_STAFF = id('ST', 2);
  const FOREIGN_STAFF = id('ST', 'lum');
  const SVC = id('SV', 1);
  /** Six members, indexed by literal below - see `AR`'s note. */
  const M: readonly [string, string, string, string, string, string] = [
    id('M', 1),
    id('M', 2),
    id('M', 3),
    id('M', 4),
    id('M', 5),
    id('M', 6),
  ];

  const exec = async (q: unknown) =>
    (await db.execute(q as never)) as unknown as Array<Record<string, unknown>>;
  /**
   * The single row a `SELECT ... aggregate` or a keyed lookup is expected to
   * return. `const [r] = await exec(...)` types `r` as possibly undefined and it
   * genuinely can be - a query whose predicate matched nothing. Reading `r.foo`
   * off that fails with `Cannot read properties of undefined`, naming the property
   * and not the query; this names the query.
   */
  const only = (rows: Array<Record<string, unknown>>, what: string): Record<string, unknown> => {
    const [row] = rows;
    if (row === undefined) throw new Error(`expected one row for ${what}, got none`);
    return row;
  };
  const scalar = async (q: unknown) => Number((await exec(q))[0]?.n ?? 0);

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    sql = (await import('drizzle-orm')).sql;
    const issueSession = (await import('../auth/sessions')).issueSession;
    app = await (await import('../app')).buildApp();

    /** Inside the 30d window at both ends, and inside 7d, so both periods see it. */
    const t = (daysAgo: number, hour: number) =>
      new Date(Date.now() - daysAgo * DAY + hour * 3_600_000).toISOString();

    await db.execute(sql`
      INSERT INTO staff_user (id, salon_id, name, handle, role, branch_access_all, perm_team, perm_dashboard)
      VALUES (${AR2_STAFF}, ${SALON}, 'AP Linked', ${`ap-linked-${RUN}`}, 'artist', true, false, false)`);
    /**
     * The tenancy caller: a REAL manager, holding the REAL permission, at the WRONG
     * salon. `perm_team` is deliberately TRUE — a 403 from a caller who lacks the
     * permission anyway would prove nothing about the tenancy boundary.
     */
    await db.execute(sql`
      INSERT INTO staff_user (id, salon_id, name, handle, role, branch_access_all, perm_team, perm_dashboard)
      VALUES (${FOREIGN_STAFF}, ${OTHER_SALON}, 'AP Lumiere', ${`ap-lum-${RUN}`}, 'manager', true, true, true)`);

    await db.execute(sql`
      INSERT INTO artist (id, salon_id, staff_user_id, name) VALUES
        (${AR1}, ${SALON}, NULL,         ${`AP Rana ${RUN}`}),
        (${AR2}, ${SALON}, ${AR2_STAFF}, ${`AP Dana ${RUN}`}),
        (${AR3}, ${SALON}, NULL,         ${`AP Idle ${RUN}`}),
        (${AR4}, ${SALON}, NULL,         ${`AP Voided ${RUN}`}),
        (${AR5}, ${SALON}, NULL,         ${`AP Crossbranch ${RUN}`})`);

    await db.execute(sql`
      INSERT INTO service (id, salon_id, name, price_fils) VALUES (${SVC}, ${SALON}, ${`AP Service ${RUN}`}, 8000)`);

    await db.execute(sql`
      INSERT INTO member (id, salon_id, name, phone, password_hash, balance_fils, tier, visits, policy_version)
      VALUES
        (${M[0]}, ${SALON}, 'AP One',   ${phoneSeq(1)}, 'x', 50000, 'bronze', 0, 1),
        (${M[1]}, ${SALON}, 'AP Two',   ${phoneSeq(2)}, 'x', 50000, 'bronze', 0, 1),
        (${M[2]}, ${SALON}, 'AP Three', ${phoneSeq(3)}, 'x', 50000, 'bronze', 0, 1),
        (${M[3]}, ${SALON}, 'AP Four',  ${phoneSeq(4)}, 'x', 50000, 'bronze', 0, 1),
        (${M[4]}, ${SALON}, 'AP Five',  ${phoneSeq(5)}, 'x', 50000, 'bronze', 0, 1),
        (${M[5]}, ${SALON}, 'AP Six',   ${phoneSeq(6)}, 'x', 50000, 'bronze', 0, 1)`);

    /**
     * THE TRANSACTIONS. Signs are the schema's, not a convention:
     * `transaction_amount_sign_matches_kind` makes a charge `<= 0`, a `shop` and a
     * `deposit_hold` `< 0`, and a `topup`/`deposit_return` `> 0`.
     *
     * CH-1  AR-1, partial deposit:  basket 8.000 = 6.000 charged + 2.000 deposit
     * CH-2  AR-1, deposit COVERED:  basket 5.000 = 0.000 charged + 5.000 deposit
     * CH-3  AR-2, no deposit at all (a booking whose hold was 1.000 and applied)
     * CH-4  AR-4, charged then VOIDED
     * CH-5  AR-5, booked at Salmiya, CHARGED AT KUWAIT CITY
     * CH-6  AR-1, 45 days ago — outside every period this report offers
     * WI-1  a walk-in: a charge with no booking behind it
     * SH-1  a shop sale
     * TU-1  a top-up: not revenue in any period
     */
    await db.execute(sql`
      INSERT INTO "transaction"
        (id, member_id, salon_id, branch_id, branch_assumed, kind, amount_fils, method, status, reference, created_at, settled_at)
      VALUES
        (${id('TX', 'h1')}, ${M[0]}, ${SALON}, ${SALMIYA},     false, 'deposit_hold', -2000, 'wallet', 'settled', '', ${t(3, 0)}, ${t(3, 0)}),
        (${id('TX', 'h2')}, ${M[1]}, ${SALON}, ${SALMIYA},     false, 'deposit_hold', -5000, 'wallet', 'settled', '', ${t(3, 0)}, ${t(3, 0)}),
        (${id('TX', 'h3')}, ${M[2]}, ${SALON}, ${SALMIYA},     false, 'deposit_hold', -1000, 'wallet', 'settled', '', ${t(3, 0)}, ${t(3, 0)}),
        (${id('TX', 'h4')}, ${M[3]}, ${SALON}, ${SALMIYA},     false, 'deposit_hold', -1000, 'wallet', 'settled', '', ${t(3, 0)}, ${t(3, 0)}),
        (${id('TX', 'h5')}, ${M[4]}, ${SALON}, ${SALMIYA},     false, 'deposit_hold', -1000, 'wallet', 'settled', '', ${t(3, 0)}, ${t(3, 0)}),
        (${id('TX', 'h6')}, ${M[0]}, ${SALON}, ${SALMIYA},     false, 'deposit_hold', -1000, 'wallet', 'settled', '', ${t(45, 0)}, ${t(45, 0)}),
        (${id('TX', 'h7')}, ${M[5]}, ${SALON}, ${SALMIYA},     false, 'deposit_hold', -1000, 'wallet', 'settled', '', ${t(3, 0)}, ${t(3, 0)}),
        (${id('TX', 'h8')}, ${M[5]}, ${SALON}, ${SALMIYA},     false, 'deposit_hold', -1000, 'wallet', 'settled', '', ${t(3, 0)}, ${t(3, 0)}),
        (${id('TX', 'c1')}, ${M[0]}, ${SALON}, ${SALMIYA},     false, 'charge',       -6000, 'wallet', 'settled', '', ${t(2, 1)}, ${t(2, 1)}),
        (${id('TX', 'c2')}, ${M[1]}, ${SALON}, ${SALMIYA},     false, 'charge',           0, 'wallet', 'settled', '', ${t(2, 2)}, ${t(2, 2)}),
        (${id('TX', 'c3')}, ${M[2]}, ${SALON}, ${SALMIYA},     false, 'charge',       -7000, 'wallet', 'settled', '', ${t(2, 3)}, ${t(2, 3)}),
        (${id('TX', 'c4')}, ${M[3]}, ${SALON}, ${SALMIYA},     false, 'charge',       -4000, 'wallet', 'settled', '', ${t(2, 4)}, ${t(2, 4)}),
        (${id('TX', 'c5')}, ${M[4]}, ${SALON}, ${KUWAIT_CITY}, false, 'charge',       -9000, 'wallet', 'settled', '', ${t(2, 5)}, ${t(2, 5)}),
        (${id('TX', 'c6')}, ${M[0]}, ${SALON}, ${SALMIYA},     false, 'charge',       -3000, 'wallet', 'settled', '', ${t(45, 1)}, ${t(45, 1)}),
        (${id('TX', 'w1')}, ${M[5]}, ${SALON}, ${KUWAIT_CITY}, false, 'charge',      -12000, 'wallet', 'settled', '', ${t(2, 6)}, ${t(2, 6)}),
        (${id('TX', 's1')}, ${M[5]}, ${SALON}, ${SALMIYA},     false, 'shop',         -2500, 'wallet', 'settled', '', ${t(2, 7)}, ${t(2, 7)}),
        (${id('TX', 't1')}, ${M[0]}, ${SALON}, ${SALMIYA},     true,  'topup',        20000, 'knet',   'settled', '', ${t(2, 8)}, ${t(2, 8)}),
        (${id('TX', 'r1')}, ${M[5]}, ${SALON}, ${SALMIYA},     false, 'deposit_return', 1000, 'wallet','settled', '', ${t(2, 9)}, ${t(2, 9)})`);

    /** The void of CH-4. A compensating `adjustment` naming the charge it reverses. */
    await db.execute(sql`
      INSERT INTO "transaction"
        (id, member_id, salon_id, branch_id, branch_assumed, kind, amount_fils, method, status, reference, reverses_transaction_id, created_at, settled_at)
      VALUES (${id('TX', 'v1')}, ${M[3]}, ${SALON}, ${SALMIYA}, false, 'adjustment', 5000, 'wallet', 'settled', '', ${id('TX', 'c4')}, ${t(1, 0)}, ${t(1, 0)})`);

    /**
     * THE LEDGER, and only the legs `services/charge.ts` would actually have
     * written. `depositAppliedPosting` is `deposit_held` DEBIT + `salon_revenue`
     * CREDIT; `walletSpendPosting` is `member_wallet` DEBIT + `salon_revenue`
     * CREDIT, and charge.ts skips it entirely when `due` is 0 — which is exactly
     * the covered-deposit case, so CH-2 carries the deposit pair and nothing else.
     * `ledger_entry_balanced` is DEFERRABLE INITIALLY DEFERRED and checks
     * debits-minus-credits per `transaction_id` at COMMIT, so every insert below is
     * paired or it does not land.
     */
    await db.execute(sql`
      INSERT INTO ledger_entry (transaction_id, salon_id, member_id, account, direction, amount_fils, balance_after_fils)
      VALUES
        (${id('TX', 'c1')}, ${SALON}, ${M[0]}, 'member_wallet',  'debit',  6000, 44000),
        (${id('TX', 'c1')}, ${SALON}, NULL,    'salon_revenue',  'credit', 6000, NULL),
        (${id('TX', 'c1')}, ${SALON}, NULL,    'deposit_held',   'debit',  2000, NULL),
        (${id('TX', 'c1')}, ${SALON}, NULL,    'salon_revenue',  'credit', 2000, NULL),
        (${id('TX', 'c2')}, ${SALON}, NULL,    'deposit_held',   'debit',  5000, NULL),
        (${id('TX', 'c2')}, ${SALON}, NULL,    'salon_revenue',  'credit', 5000, NULL),
        (${id('TX', 'c3')}, ${SALON}, ${M[2]}, 'member_wallet',  'debit',  7000, 43000),
        (${id('TX', 'c3')}, ${SALON}, NULL,    'salon_revenue',  'credit', 7000, NULL),
        (${id('TX', 'c3')}, ${SALON}, NULL,    'deposit_held',   'debit',  1000, NULL),
        (${id('TX', 'c3')}, ${SALON}, NULL,    'salon_revenue',  'credit', 1000, NULL),
        (${id('TX', 'c4')}, ${SALON}, ${M[3]}, 'member_wallet',  'debit',  4000, 46000),
        (${id('TX', 'c4')}, ${SALON}, NULL,    'salon_revenue',  'credit', 4000, NULL),
        (${id('TX', 'c4')}, ${SALON}, NULL,    'deposit_held',   'debit',  1000, NULL),
        (${id('TX', 'c4')}, ${SALON}, NULL,    'salon_revenue',  'credit', 1000, NULL),
        (${id('TX', 'c5')}, ${SALON}, ${M[4]}, 'member_wallet',  'debit',  9000, 41000),
        (${id('TX', 'c5')}, ${SALON}, NULL,    'salon_revenue',  'credit', 9000, NULL),
        (${id('TX', 'c5')}, ${SALON}, NULL,    'deposit_held',   'debit',  1000, NULL),
        (${id('TX', 'c5')}, ${SALON}, NULL,    'salon_revenue',  'credit', 1000, NULL),
        (${id('TX', 'c6')}, ${SALON}, ${M[0]}, 'member_wallet',  'debit',  3000, 47000),
        (${id('TX', 'c6')}, ${SALON}, NULL,    'salon_revenue',  'credit', 3000, NULL),
        (${id('TX', 'c6')}, ${SALON}, NULL,    'deposit_held',   'debit',  1000, NULL),
        (${id('TX', 'c6')}, ${SALON}, NULL,    'salon_revenue',  'credit', 1000, NULL),
        (${id('TX', 'w1')}, ${SALON}, ${M[5]}, 'member_wallet',  'debit', 12000, 38000),
        (${id('TX', 'w1')}, ${SALON}, NULL,    'salon_revenue',  'credit',12000, NULL),
        (${id('TX', 's1')}, ${SALON}, ${M[5]}, 'member_wallet',  'debit',  2500, 35500),
        (${id('TX', 's1')}, ${SALON}, NULL,    'salon_revenue',  'credit', 2500, NULL)`);

    /**
     * THE BOOKINGS. `booking_settlement_matches_status` makes the status and the
     * settling transaction one fact, so each row below is the state machine's own
     * spelling of its case rather than a pair that could disagree.
     *
     * BK-4's settling transaction is the VOID, not the charge — that is what
     * `routes/charges.ts` rewrites it to, and the fixture spells it the same way so
     * the report is tested against the state the void actually leaves behind.
     */
    await db.execute(sql`
      INSERT INTO booking
        (id, salon_id, branch_id, branch_assumed, member_id, artist_id, service_id,
         starts_at, ends_at, duration_min, deposit_fils, status, hold_transaction_id,
         settled_transaction_id, completed_at, cancelled_at, no_show_return_due_at)
      VALUES
        (${id('BK', 1)}, ${SALON}, ${SALMIYA}, false, ${M[0]}, ${AR1}, ${SVC},
           ${t(2, 1)}, ${t(2, 2)}, 60, 2000, 'completed', ${id('TX', 'h1')}, ${id('TX', 'c1')}, ${t(2, 1)}, NULL, ${t(1, 1)}),
        (${id('BK', 2)}, ${SALON}, ${SALMIYA}, false, ${M[1]}, ${AR1}, ${SVC},
           ${t(2, 3)}, ${t(2, 4)}, 60, 5000, 'completed', ${id('TX', 'h2')}, ${id('TX', 'c2')}, ${t(2, 3)}, NULL, ${t(1, 3)}),
        (${id('BK', 3)}, ${SALON}, ${SALMIYA}, false, ${M[2]}, ${AR2}, ${SVC},
           ${t(2, 5)}, ${t(2, 6)}, 60, 1000, 'completed', ${id('TX', 'h3')}, ${id('TX', 'c3')}, ${t(2, 5)}, NULL, ${t(1, 5)}),
        (${id('BK', 4)}, ${SALON}, ${SALMIYA}, false, ${M[3]}, ${AR4}, ${SVC},
           ${t(2, 7)}, ${t(2, 8)}, 60, 1000, 'cancelled', ${id('TX', 'h4')}, ${id('TX', 'v1')}, NULL, ${t(1, 0)}, ${t(1, 7)}),
        (${id('BK', 5)}, ${SALON}, ${SALMIYA}, false, ${M[4]}, ${AR5}, ${SVC},
           ${t(2, 9)}, ${t(2, 10)}, 60, 1000, 'completed', ${id('TX', 'h5')}, ${id('TX', 'c5')}, ${t(2, 9)}, NULL, ${t(1, 9)}),
        (${id('BK', 6)}, ${SALON}, ${SALMIYA}, false, ${M[0]}, ${AR1}, ${SVC},
           ${t(45, 1)}, ${t(45, 2)}, 60, 1000, 'completed', ${id('TX', 'h6')}, ${id('TX', 'c6')}, ${t(45, 1)}, NULL, ${t(44, 1)}),
        (${id('BK', 7)}, ${SALON}, ${SALMIYA}, false, ${M[5]}, ${AR2}, ${SVC},
           ${t(-1, 1)}, ${t(-1, 2)}, 60, 1000, 'deposit_held', ${id('TX', 'h7')}, NULL, NULL, NULL, ${t(-2, 1)}),
        (${id('BK', 8)}, ${SALON}, ${SALMIYA}, false, ${M[5]}, ${AR2}, ${SVC},
           ${t(2, 11)}, ${t(2, 12)}, 60, 1000, 'cancelled', ${id('TX', 'h8')}, ${id('TX', 'r1')}, NULL, ${t(2, 10)}, ${t(1, 11)})`);

    bearer = (
      await issueSession(db, {
        principalKind: 'staff',
        staffId: TEAM_STAFF,
        salonId: SALON,
        scope: 'dashboard',
      })
    ).accessToken;
    noTeamBearer = (
      await issueSession(db, {
        principalKind: 'staff',
        staffId: NO_TEAM_STAFF,
        salonId: SALON,
        scope: 'dashboard',
      })
    ).accessToken;
    foreignBearer = (
      await issueSession(db, {
        principalKind: 'staff',
        staffId: FOREIGN_STAFF,
        salonId: OTHER_SALON,
        scope: 'dashboard',
      })
    ).accessToken;
  });

  afterAll(async () => {
    /**
     * ONLY THE CROSS-SALON FOOTPRINT. Everything at SAL-AMARA is anchored by a
     * ledger row nobody can delete — see the header — and is left in place
     * deliberately, which is safe precisely because nothing here asserts an
     * absolute figure.
     */
    if (db) {
      await db.execute(sql`DELETE FROM session WHERE staff_id = ${FOREIGN_STAFF}`);
      await db.execute(sql`DELETE FROM staff_user WHERE id = ${FOREIGN_STAFF}`);
    }
    await app?.close();
  });

  // ------------------------------------------------------------- the driver --

  const get = (salon: string, token: string, qs = '') =>
    app.inject({
      method: 'GET',
      url: `/salons/${salon}/reports/artist-performance${qs}`,
      headers: { authorization: `Bearer ${token}` },
    });

  const csv = (salon: string, token: string, qs = '') =>
    app.inject({
      method: 'GET',
      url: `/salons/${salon}/reports/artist-performance.csv${qs}`,
      headers: { authorization: `Bearer ${token}` },
    });

  async function report(qs = ''): Promise<{ rows: Row[]; stat: { value: number; label: string } }> {
    const res = await get(SALON, bearer, qs);
    expect(res.statusCode, res.body).toBe(200);
    return JSON.parse(res.body);
  }

  const mine = (rows: Row[], artistId: string): Row => {
    const name = `AP ${{ [AR1]: 'Rana', [AR2]: 'Dana', [AR3]: 'Idle', [AR4]: 'Voided', [AR5]: 'Crossbranch' }[artistId]} ${RUN}`;
    const row = rows.find((r) => r.attributedTo === name);
    expect(row, `no row for ${name}`).toBeDefined();
    return row as Row;
  };
  const bucket = (rows: Row[], name: string): Row => {
    const row = rows.find((r) => r.attributedTo === name);
    expect(row, `no ${name} row`).toBeDefined();
    return row as Row;
  };

  /**
   * The salon's own charge-and-shop revenue for the window, read independently of
   * the report. `sum(-amount_fils)` for the charged half and the ledger's
   * `deposit_held` debits for the deposit half — the same two quantities
   * `routes/charges.ts` adds when it decides what a void owes back.
   */
  async function salonWide(branch: string | null, days = 30) {
    const from = new Date(Date.now() - days * DAY).toISOString();
    const b = branch === null ? sql`` : sql`AND t.branch_id = ${branch}`;
    const r = only(
      await exec(sql`
      SELECT coalesce(sum(-t.amount_fils), 0)::bigint AS charged,
             coalesce(sum(dep.amount_fils), 0)::bigint AS deposit_applied
        FROM "transaction" t
        LEFT JOIN ledger_entry dep
               ON dep.transaction_id = t.id
              AND dep.account = 'deposit_held'
              AND dep.direction = 'debit'
       WHERE t.salon_id = ${SALON}
         AND t.kind IN ('charge', 'shop')
         AND t.status = 'settled'
         AND t.created_at >= ${from}::timestamptz
         ${b}
         AND NOT EXISTS (
           SELECT 1 FROM "transaction" r WHERE r.reverses_transaction_id = t.id AND r.status = 'settled'
         )`),
      'the oracle sum',
    );
    const charged = Number(r.charged);
    const depositApplied = Number(r.deposit_applied);
    return { charged, depositApplied, earned: charged + depositApplied };
  }

  const sum = (rows: Row[], key: keyof Row) =>
    rows.reduce((t, r) => t + (r[key] as number), 0);

  // ==================================================================
  // THE CLAIM THE REPORT MAKES ON ITS FACE: THE ROWS ACCOUNT FOR THE MONEY.
  // ==================================================================
  describe('the rows account for the salon’s revenue, exactly', () => {
    it('artist rows + the two named unattributed rows = charge and shop revenue', async () => {
      const { rows, stat } = await report();
      const expected = await salonWide(null);

      expect(sum(rows, 'chargedFils')).toBe(expected.charged);
      expect(sum(rows, 'depositAppliedFils')).toBe(expected.depositApplied);
      expect(sum(rows, 'earnedFils')).toBe(expected.earned);

      // The headline is the sum of the column under it, not a second query.
      expect(stat.value).toBe(expected.earned);
      expect(stat.label).toBe('KD earned');
    });

    it('names the unattributed remainder rather than leaving it to be inferred', async () => {
      const { rows } = await report();
      const artists = rows.filter((r) => r.attribution === 'artist');
      const unattributed = rows.filter((r) => r.attribution === 'no artist');

      // Exactly the two buckets, always present, in a fixed order at the end.
      expect(unattributed.map((r) => r.attributedTo)).toEqual(['Walk-in charges', 'Shop orders']);
      expect(rows.slice(-2)).toEqual(unattributed);

      /**
       * THE PROPERTY THE WHOLE SHAPE EXISTS FOR: the artist rows sum to LESS than
       * the headline, and the difference is not a mystery — it is the two rows
       * printed underneath them.
       */
      expect(sum(artists, 'earnedFils')).toBeLessThan(sum(rows, 'earnedFils'));
      expect(sum(artists, 'earnedFils') + sum(unattributed, 'earnedFils')).toBe(
        sum(rows, 'earnedFils'),
      );
    });

    it('puts a walk-in charge in the walk-in row and a shop sale in the shop row', async () => {
      const { rows } = await report();
      // Additive rather than absolute: other suites share this salon, and a walk-in
      // is what every one of their charges is.
      expect(bucket(rows, 'Walk-in charges').earnedFils).toBeGreaterThanOrEqual(12_000);
      expect(bucket(rows, 'Shop orders').earnedFils).toBeGreaterThanOrEqual(2_500);
      // A walk-in has no booking, so it can carry no applied deposit. Asserted
      // rather than assumed — the query sums it for real, so this would catch the
      // day a deposit reached a charge with no booking behind it.
      expect(bucket(rows, 'Walk-in charges').depositAppliedFils).toBe(0);
      expect(bucket(rows, 'Shop orders').depositAppliedFils).toBe(0);
    });

    it('leaves a top-up out of every row — it is not revenue in any period', async () => {
      /**
       * The fixture loaded 20.000 KD. If a top-up had leaked into the denominator,
       * the reconciliation above would still have passed — both sides would move —
       * so this asserts against the arithmetic instead: the report's total must
       * equal charge-and-shop revenue, which excludes it by kind.
       */
      const { rows } = await report();
      const withTopups = await scalar(sql`
        SELECT coalesce(sum(t.amount_fils), 0)::bigint AS n FROM "transaction" t
         WHERE t.salon_id = ${SALON} AND t.kind = 'topup' AND t.status = 'settled'
           AND t.created_at >= ${new Date(Date.now() - 30 * DAY).toISOString()}::timestamptz`);
      expect(withTopups, 'the fixture must have loaded something for this to mean anything')
        .toBeGreaterThanOrEqual(20_000);
      expect(sum(rows, 'earnedFils')).toBe((await salonWide(null)).earned);
    });
  });

  // ==================================================================
  // THE FALSE ZERO. The reason this report has three money columns.
  // ==================================================================
  describe('an appointment whose deposit covered the whole basket', () => {
    it('is not reported as zero earnings, and both halves are on the row', async () => {
      const { rows } = await report();
      const rana = mine(rows, AR1);

      // Two appointments, two different customers: 8.000 + 5.000 = 13.000 earned,
      // of which 6.000 + 0.000 came off the charge rows.
      expect(rana.appointments).toBe(2);
      expect(rana.customers).toBe(2);
      expect(rana.chargedFils).toBe(6_000);
      expect(rana.depositAppliedFils).toBe(7_000);
      expect(rana.earnedFils).toBe(13_000);

      /**
       * AND THE DISCRIMINATING ASSERTION. `services/charge.ts` writes the covered
       * visit as `amount_fils = 0`, so an implementation summing `-amount_fils` —
       * which is what `sales` and `best-selling-services` do — would have printed
       * 6.000 here and would have shown the covered appointment earning NOTHING.
       * The charge row for it really is zero; the appointment was not.
       */
      const coveredCharge = await scalar(sql`
        SELECT coalesce(sum(-amount_fils), 0)::bigint AS n
          FROM "transaction" WHERE id = ${id('TX', 'c2')}`);
      expect(coveredCharge).toBe(0);
      expect(rana.earnedFils).toBeGreaterThan(rana.chargedFils);
    });
  });

  // ==================================================================
  // THE ARTIST / STAFF DISTINCTION — the request said "staff", the data says artist.
  // ==================================================================
  describe('an artist who is not a staff member', () => {
    it('is in the report, and the row says she has no staff account', async () => {
      const { rows } = await report();
      // Not dropped, not blank: `artist.staff_user_id IS NULL` is a definite fact.
      expect(mine(rows, AR1).staffAccount).toBe('no staff account');
      expect(mine(rows, AR3).staffAccount).toBe('no staff account');
    });

    it('renders the handle for an artist who does have one', async () => {
      const { rows } = await report();
      expect(mine(rows, AR2).staffAccount).toBe(`ap-linked-${RUN}`);
    });
  });

  describe('an artist with nothing in the window', () => {
    it('is a row of true zeros, told apart from an unattributed row by Attribution', async () => {
      const { rows } = await report();
      const idle = mine(rows, AR3);
      expect(idle).toMatchObject({
        attribution: 'artist',
        appointments: 0,
        customers: 0,
        chargedFils: 0,
        depositAppliedFils: 0,
        earnedFils: 0,
      });
      // "She earned nothing" and "this money has no artist" are different rows.
      expect(idle.attribution).not.toBe(bucket(rows, 'Walk-in charges').attribution);
    });
  });

  // ==================================================================
  // WHAT MUST NOT BE COUNTED.
  // ==================================================================
  describe('money that went back, or never settled', () => {
    it('excludes a voided charge from the artist row AND from the walk-in row', async () => {
      const { rows } = await report();
      // AR-4's only appointment was voided: her row is zero, and the 5.000 the void
      // returned is nowhere in the table.
      expect(mine(rows, AR4)).toMatchObject({
        appointments: 0,
        chargedFils: 0,
        depositAppliedFils: 0,
        earnedFils: 0,
      });
      const voided = await scalar(sql`
        SELECT count(*)::int AS n FROM "transaction" WHERE id = ${id('TX', 'c4')}`);
      expect(voided, 'the voided charge must still exist for this to prove anything').toBe(1);
    });

    it('excludes a booking still holding a deposit, and one settled by a return', async () => {
      const { rows } = await report();
      // AR-2 has three bookings: one charged (BK-3), one still `deposit_held`
      // (BK-7), one cancelled and settled by a `deposit_return` (BK-8). Only the
      // charged one is an appointment, and only its money is earnings.
      const dana = mine(rows, AR2);
      expect(dana.appointments).toBe(1);
      expect(dana.chargedFils).toBe(7_000);
      expect(dana.depositAppliedFils).toBe(1_000);
      expect(dana.earnedFils).toBe(8_000);
    });

    it('honours the period boundary on the charge, not on the booking', async () => {
      // AR-1's third appointment is 45 days back. In 30d she has two; the 3.000
      // charge and its 1.000 deposit are outside and must not appear.
      const thirty = await report('?period=30d');
      const seven = await report('?period=7d');
      expect(mine(thirty.rows, AR1).appointments).toBe(2);
      expect(mine(seven.rows, AR1).appointments).toBe(2);
      expect(mine(thirty.rows, AR1).earnedFils).toBe(13_000);

      // And 90d does reach it, so the boundary is a boundary rather than a filter
      // that drops the row unconditionally.
      const ninety = await report('?period=90d');
      expect(mine(ninety.rows, AR1).appointments).toBe(3);
      expect(mine(ninety.rows, AR1).earnedFils).toBe(17_000);
    });
  });

  // ==================================================================
  // `?branch=` — and the case that tells the two candidate columns apart.
  // ==================================================================
  describe('the branch filter', () => {
    it('follows the branch the MONEY was recorded at, not the booking’s', async () => {
      /**
       * AR-5's appointment was booked at SALMIYA and charged at KUWAIT CITY. The
       * two columns disagree, and only one of them lets the table still add up —
       * see the aggregate's header. This is the fixture that fails the other choice.
       */
      const kwc = await report(`?branch=${KUWAIT_CITY}`);
      const sal = await report(`?branch=${SALMIYA}`);

      expect(mine(kwc.rows, AR5).earnedFils).toBe(10_000);
      expect(mine(kwc.rows, AR5).appointments).toBe(1);
      expect(mine(sal.rows, AR5).earnedFils).toBe(0);
      expect(mine(sal.rows, AR5).appointments).toBe(0);

      const bookingBranch = only(
        await exec(sql`
        SELECT branch_id FROM booking WHERE id = ${id('BK', 5)}`),
        'BK-5',
      );
      expect(String(bookingBranch.branch_id)).toBe(SALMIYA);
    });

    it('reconciles under a branch too, and the branches re-sum to the salon', async () => {
      const [all, sal, kwc] = await Promise.all([
        report(),
        report(`?branch=${SALMIYA}`),
        report(`?branch=${KUWAIT_CITY}`),
      ]);
      const [eAll, eSal, eKwc] = await Promise.all([
        salonWide(null),
        salonWide(SALMIYA),
        salonWide(KUWAIT_CITY),
      ]);

      expect(sum(sal.rows, 'earnedFils')).toBe(eSal.earned);
      expect(sum(kwc.rows, 'earnedFils')).toBe(eKwc.earned);

      /**
       * A transaction has exactly ONE branch, so money IS additive across branches
       * — unlike the distinct customer counts, which are not. Both salon branches
       * therefore have to account for every fils the unfiltered report shows.
       */
      expect(eSal.earned + eKwc.earned).toBe(eAll.earned);
      expect(sum(sal.rows, 'earnedFils') + sum(kwc.rows, 'earnedFils')).toBe(
        sum(all.rows, 'earnedFils'),
      );
    });

    it('404s a branch belonging to another salon, like every other report kind', async () => {
      const res = await get(SALON, bearer, '?branch=BR-LUM-HAW');
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error).toBe('unknown_branch');
      expect(res.body).not.toContain('Hawally');
    });
  });

  // ==================================================================
  // NON-NEGOTIABLE #7, called directly against the endpoint.
  // ==================================================================
  describe('the gate', () => {
    it('refuses a staff member without `team` — on the JSON, the CSV and the mint', async () => {
      /**
       * ST-002 Hessa, the seeded frontdesk. She HOLDS `appointments` and
       * `dashboard` is off, which is the whole point: a report built out of the
       * appointment book would have been readable by her if the permission had been
       * chosen for the data's source rather than for its sensitivity. It is her own
       * salon and a real dashboard session — nothing but the permission is missing.
       */
      const json = await get(SALON, noTeamBearer);
      expect(json.statusCode).toBe(403);
      expect(json.body).not.toContain('AP Rana');

      const file = await csv(SALON, noTeamBearer);
      expect(file.statusCode).toBe(403);

      // The download-url mint is a third door onto the same aggregate.
      const mint = await app.inject({
        method: 'POST',
        url: `/salons/${SALON}/reports/artist-performance/download-url`,
        headers: { authorization: `Bearer ${noTeamBearer}` },
      });
      expect(mint.statusCode).toBe(403);
    });

    it('refuses a manager of another salon who DOES hold `team`', async () => {
      // The tenancy half. Permission present, salon wrong.
      const json = await get(SALON, foreignBearer);
      expect(json.statusCode).toBe(403);
      expect(json.body).not.toContain('AP Rana');
      expect((await csv(SALON, foreignBearer)).statusCode).toBe(403);
    });

    it('refuses an anonymous caller before it will even name the kind', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/salons/${SALON}/reports/artist-performance`,
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ==================================================================
  // THE FILE.
  // ==================================================================
  describe('the CSV', () => {
    it('carries the same eight columns and the same numbers as the JSON', async () => {
      const { rows } = await report();
      const res = await csv(SALON, bearer);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-disposition']).toContain(
        'artist-performance_all-branches_30d.csv',
      );

      const body = res.body.replace(/^﻿/, '');
      const lines = body.split('\r\n');
      expect(lines[0]).toBe(
        '"Attributed to","Attribution","Staff account","Customers","Appointments",' +
          '"Charged KD","Deposit applied KD","Earned KD"',
      );
      expect(lines).toHaveLength(rows.length + 1);

      // The covered-deposit artist, formatted: 6.000 charged, 7.000 deposit,
      // 13.000 earned. No thousands separator, so the merchant can sum the column.
      const rana = lines.find((l) => l.includes(`AP Rana ${RUN}`));
      expect(rana).toContain('"artist"');
      expect(rana).toContain('"no staff account"');
      expect(rana).toContain('"6.000","7.000","13.000"');

      const walkin = lines.find((l) => l.startsWith('"Walk-in charges"'));
      expect(walkin).toContain('"no artist"');
    });
  });
});
