/**
 * ARBITRARY DATE RANGES AND COMPARISON, DRIVEN.            (Aftab, item 9)
 *
 * `?period=` took three rolling presets and nothing else; `?compare=` did not
 * exist and — because Fastify drops unknown query parameters — was answered with
 * a confident 200 and a plain 30d report. Both halves are proved here against
 * real rows in real Postgres, through the real routes.
 *
 * =========================================================================
 * THE FIXTURE, AND WHY IT IS SHAPED THE WAY IT IS
 * =========================================================================
 * `ledger_entry` is append-only against the owner role as well as the app role
 * (migration 0001 + `ledger_entry_is_immutable`), and `ON DELETE restrict` makes
 * the transactions and members behind it permanent too. So this file's rows
 * survive the run, and a second run adds more of them to the same window.
 *
 * EVERY MONEY ASSERTION IS THEREFORE A DELTA. The baseline for each window is
 * measured through the API BEFORE anything is inserted, and every expectation
 * below is "this window grew by exactly X". That answers decision 75's multi-run
 * requirement by construction rather than by a fixture somebody has to remember
 * to reset — and it is the same discipline `reportsReconciliation.int.test.ts`
 * chose for the same reason.
 *
 * THE WINDOWS ARE IN 2024, which no seed row and no other suite touches, so the
 * deltas are this file's rows and nothing else's. `RR-` namespace, per-run suffix.
 *
 * =========================================================================
 * THE TWO ROWS THAT DECIDE WHETHER THE ZONE IS APPLIED
 * =========================================================================
 * Kuwait is UTC+3, so calendar March at a Kuwait salon is
 * `[2024-02-29T21:00Z, 2024-03-31T21:00Z)` and the same range resolved in UTC
 * would be `[2024-03-01T00:00Z, 2024-04-01T00:00Z)`. Those two windows differ at
 * BOTH ENDS, by three hours each, and the fixture puts one charge in each gap:
 *
 *   EARLY  2024-02-29T22:00Z = 01:00 on 1 March, Kuwait.  IN  under the salon's
 *          zone, OUT under UTC.
 *   LATE   2024-03-31T22:00Z = 01:00 on 1 April, Kuwait.  OUT under the salon's
 *          zone, IN  under UTC.
 *
 * So a UTC-resolved range does not merely shift the total — it reports the wrong
 * day's takings at both ends, which is the failure the brief named. March's gross
 * is 8 100 fils under the correct zone and would be 9 200 under UTC, and the
 * spec asserts the first and names the second, so an implementation that dropped
 * the zone fails with a number rather than passing with a plausible one.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const SALON = 'SAL-AMARA';
const SALMIYA = 'BR-SAL';
/** Seeded manager, every permission. */
const MANAGER = 'ST-001';

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const id = (kind: string, n: string) => `RR-${kind}-${RUN}-${n}`;
const phoneSeq = (n: number) => `+9657${String(Date.now() % 1_000_000).padStart(6, '0')}${n}`;

/** A manager who holds NOTHING — the #7 control. */
const NO_PERM_STAFF = id('ST', 'noperm');

const MARCH = '2024-03-01_2024-03-31';
const JANUARY = '2024-01-01_2024-01-31';
/** 2024 is a leap year, so February is 29 days — deliberately NOT comparable with 31. */
const FEBRUARY = '2024-02-01_2024-02-29';
/** March extended by one day, so the LATE row comes inside. */
const MARCH_PLUS = '2024-03-01_2024-04-01';

/** The five charges, as (id suffix, instant, amount_fils). Charges are <= 0. */
const CHARGES: Array<[string, string, number]> = [
  // 01:00 Kuwait, 1 March. Inside calendar March at this salon; outside it in UTC.
  ['early', '2024-02-29T22:00:00.000Z', -1_100],
  // The middle of the window, where no boundary argument applies.
  ['mid', '2024-03-15T09:00:00.000Z', -7_000],
  // 01:00 Kuwait, 1 April. OUTSIDE calendar March at this salon; inside it in UTC.
  ['late', '2024-03-31T22:00:00.000Z', -2_200],
  // January, the comparison window.
  ['jan1', '2024-01-10T09:00:00.000Z', -3_000],
  ['jan2', '2024-01-20T09:00:00.000Z', -1_000],
];

const MARCH_GROSS = 1_100 + 7_000;
/** What a range resolved in UTC instead of the salon's zone would have reported. */
const MARCH_GROSS_IF_UTC = 7_000 + 2_200;
const JANUARY_GROSS = 3_000 + 1_000;
const LATE_GROSS = 2_200;

interface Window {
  token: string;
  basis: string;
  from: string;
  to: string;
  days: number;
  fromDate: string | null;
  toDate: string | null;
  timezone: string;
}
interface Stat {
  key: string | null;
  label: string;
  value: number;
  type: string;
}
interface Card {
  kind: string;
  period: string;
  window: Window;
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  stat: Stat;
  comparison: null | {
    window: Window;
    rows: Array<Record<string, unknown>>;
    rowCount: number;
    stat: Stat;
    delta: Stat;
    comparable: boolean;
  };
}

suite('a report can be asked for arbitrary dates, and for a second window beside them', () => {
  let app: FastifyInstance;
  let db: (typeof import('../db/client'))['db'];
  let sql: (typeof import('drizzle-orm'))['sql'];
  let bearer: string;
  let noPermBearer: string;

  /** Gross before this run inserted anything, per window token. */
  const baseline = new Map<string, number>();

  const get = (url: string, token = bearer) =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

  const post = (url: string, token = bearer) =>
    app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}` } });

  async function card(kind: string, qs: string): Promise<Card> {
    const res = await get(`/salons/${SALON}/reports/${kind}?${qs}`);
    expect(res.statusCode, res.body).toBe(200);
    return JSON.parse(res.body) as Card;
  }

  const grossOf = async (token: string) => (await card('sales', `period=${token}`)).stat.value;

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    sql = (await import('drizzle-orm')).sql;
    const issue = (await import('../auth/sessions')).issueSession;
    app = await (await import('../app')).buildApp();

    bearer = (
      await issue(db, { principalKind: 'staff', staffId: MANAGER, salonId: SALON, scope: 'dashboard' })
    ).accessToken;

    /**
     * BASELINES FIRST, THROUGH THE API, BEFORE A SINGLE ROW IS WRITTEN. Every
     * money expectation below is a difference against these — see the header.
     */
    for (const w of [MARCH, JANUARY, FEBRUARY, MARCH_PLUS]) {
      baseline.set(w, await grossOf(w));
    }

    /**
     * THE #7 CONTROL: a REAL staff row at the RIGHT salon holding NO permissions.
     * A refusal from somebody at another salon, or from an expired token, would
     * prove tenancy or authentication rather than authorisation.
     */
    await db.execute(sql`
      INSERT INTO staff_user (id, salon_id, name, handle, role, branch_access_all,
                              perm_dashboard, perm_team, perm_appointments, perm_shop)
      VALUES (${NO_PERM_STAFF}, ${SALON}, 'RR NoPerm', ${`rr-np-${RUN}`}, 'manager', true,
              false, false, false, false)`);
    noPermBearer = (
      await issue(db, {
        principalKind: 'staff',
        staffId: NO_PERM_STAFF,
        salonId: SALON,
        scope: 'dashboard',
      })
    ).accessToken;

    for (const [n] of CHARGES) {
      await db.execute(sql`
        INSERT INTO member (id, salon_id, name, phone, password_hash, balance_fils, tier, visits, policy_version)
        VALUES (${id('M', n)}, ${SALON}, ${`RR ${n}`}, ${phoneSeq(CHARGES.findIndex((c) => c[0] === n))},
                'x', 90000, 'bronze', 0, 3)`);
    }

    for (const [n, instant, amount] of CHARGES) {
      await db.execute(sql`
        INSERT INTO "transaction"
          (id, member_id, salon_id, branch_id, branch_assumed, kind, amount_fils, method, status, reference, created_at, settled_at)
        VALUES (${id('TX', n)}, ${id('M', n)}, ${SALON}, ${SALMIYA}, false, 'charge',
                ${amount}, 'wallet', 'settled', '', ${instant}, ${instant})`);
      // The two legs `walletSpendPosting` writes. Not required by
      // `transaction_revenue` — a walk-in has no deposit leg — but written so the
      // fixture is what the real handler would have left behind.
      await db.execute(sql`
        INSERT INTO ledger_entry (transaction_id, salon_id, member_id, account, direction, amount_fils, balance_after_fils)
        VALUES
          (${id('TX', n)}, ${SALON}, ${id('M', n)}, 'member_wallet', 'debit',  ${-amount}, ${90000 + amount}),
          (${id('TX', n)}, ${SALON}, NULL,          'salon_revenue', 'credit', ${-amount}, NULL)`);
    }
  });

  afterAll(async () => {
    // Nothing is deleted: `ledger_entry` is immutable and `ON DELETE restrict`
    // holds the rest down. Every assertion above is a delta for that reason.
    await app?.close();
  });

  const grew = async (windowToken: string) =>
    (await grossOf(windowToken)) - (baseline.get(windowToken) as number);

  // ====================================================================
  describe('the range reaches the report, and it is the salon’s days', () => {
    it('answers a pair of dates where it used to answer invalid_period', async () => {
      const c = await card('sales', `period=${MARCH}`);
      expect(c.period).toBe(MARCH);
      expect(c.window.basis).toBe('calendar');
      expect(c.window.days).toBe(31);
      expect(c.window.fromDate).toBe('2024-03-01');
      expect(c.window.toDate).toBe('2024-03-31');
      expect(c.window.timezone).toBe('Asia/Kuwait');
    });

    /**
     * THE EXACT BOUNDS, SERVED. A client that has to guess what "1 March" meant
     * is a client that will eventually guess wrong.
     */
    it('and states the instants it actually queried', async () => {
      const c = await card('sales', `period=${MARCH}`);
      expect(c.window.from).toBe('2024-02-29T21:00:00.000Z');
      expect(c.window.to).toBe('2024-03-31T21:00:00.000Z');
    });

    /**
     * ================================================================
     * THE ASSERTION THE WHOLE RANGE HALF RESTS ON.
     * ================================================================
     * 1 March 01:00 Kuwait is in; 1 April 01:00 Kuwait is out. A range resolved
     * in UTC would have got both backwards and reported 9 200.
     */
    it('counts the 01:00 charge on its first day and not the one on the day after', async () => {
      const grown = await grew(MARCH);
      expect(grown).toBe(MARCH_GROSS);
      expect(grown).not.toBe(MARCH_GROSS_IF_UTC);
    });

    /**
     * THE NEGATIVE CONTROL FOR THE BLOCK ABOVE. Without it, "March grew by 8 100"
     * is equally consistent with the 1 April row never having been inserted.
     * Extending the window by one day must pick it up — so the row exists, and
     * the only thing keeping it out of March is the boundary.
     */
    it('and that excluded charge really exists — one more day of window finds it', async () => {
      expect(await grew(MARCH_PLUS)).toBe(MARCH_GROSS + LATE_GROSS);
    });

    it('the comparison window is measured the same way', async () => {
      expect(await grew(JANUARY)).toBe(JANUARY_GROSS);
    });
  });

  // ====================================================================
  describe('rolling and calendar stay tellable apart', () => {
    it('a preset says rolling and names no dates', async () => {
      const c = await card('sales', 'period=30d');
      expect(c.window.basis).toBe('rolling');
      expect(c.window.fromDate).toBeNull();
      expect(c.window.toDate).toBeNull();
      expect(c.window.days).toBe(30);
    });

    /**
     * A merchant comparing a rolling 30 days against calendar June is comparing
     * two different questions. `basis` is the only field that says so, and it is
     * on every window this API serves.
     */
    it('a range says calendar and names them', async () => {
      const c = await card('sales', `period=${MARCH}`);
      expect(c.window.basis).toBe('calendar');
      expect(c.window.fromDate).not.toBeNull();
    });

    it('the default is still 30d rolling, byte for byte', async () => {
      const bare = await card('sales', '');
      expect(bare.window.basis).toBe('rolling');
      expect(bare.window.token).toBe('30d');
      expect(bare.period).toBe('30d');
    });
  });

  // ====================================================================
  describe('the comparison', () => {
    it('serves both windows, and says they are the same question asked twice', async () => {
      const c = await card('sales', `period=${MARCH}&compare=${JANUARY}`);
      expect(c.comparison).not.toBeNull();
      expect(c.window.token).toBe(MARCH);
      expect(c.comparison?.window.token).toBe(JANUARY);
      expect(c.comparison?.comparable).toBe(true);
    });

    /**
     * ================================================================
     * THE DELTA IS DERIVABLE FROM ITS OWN OPERANDS.
     * ================================================================
     * DECISIONS.md #81 and #83 were both a figure computed independently of the
     * figures it claimed to summarise, and both looked right. This asserts the
     * property rather than the number: whatever the two windows come to, the
     * delta is their difference — so a third query could not be introduced here
     * without going red.
     */
    it('and the delta is exactly the difference of the two figures served', async () => {
      for (const kind of [
        'sales',
        'customers',
        'best-selling-services',
        'products-sold',
        'artist-performance',
        'earnings-by-branch',
      ]) {
        const c = await card(kind, `period=${MARCH}&compare=${JANUARY}`);
        expect(c.comparison, kind).not.toBeNull();
        expect(c.comparison?.delta.value, kind).toBe(
          c.stat.value - (c.comparison?.stat.value as number),
        );
        // Same label and type as the stat it is a difference of, so a money
        // delta cannot be rendered as a count.
        expect(c.comparison?.delta.label, kind).toBe(c.stat.label);
        expect(c.comparison?.delta.type, kind).toBe(c.stat.type);
      }
    });

    /**
     * THE COMPARISON IS THE SAME AGGREGATE, NOT A SECOND ONE. Each window's
     * figures must equal what that window returns when asked for on its own —
     * which is what makes "every reconciliation holds for both windows" a
     * property of one implementation rather than a coincidence of two.
     */
    it('each window equals what that window returns when asked for alone', async () => {
      const both = await card('sales', `period=${MARCH}&compare=${JANUARY}`);
      const march = await card('sales', `period=${MARCH}`);
      const january = await card('sales', `period=${JANUARY}`);
      expect(both.stat.value).toBe(march.stat.value);
      expect(both.comparison?.stat.value).toBe(january.stat.value);
      expect(both.comparison?.rowCount).toBe(january.rowCount);
    });

    /** 31 days against 29 is a 6% difference before anything about the salon changed. */
    it('says so when the two windows are NOT comparable', async () => {
      const c = await card('sales', `period=${MARCH}&compare=${FEBRUARY}`);
      expect(c.comparison?.comparable).toBe(false);
      expect(c.window.days).toBe(31);
      expect(c.comparison?.window.days).toBe(29);
    });

    it('previous is the adjacent window of the same length, and it abuts', async () => {
      const c = await card('sales', 'period=30d&compare=previous');
      expect(c.comparison?.window.token).toBe('previous:30d');
      expect(c.comparison?.window.to).toBe(c.window.from);
      expect(c.comparison?.comparable).toBe(true);
    });

    it('and previous is refused for a calendar period, rather than guessed at', async () => {
      const res = await get(`/salons/${SALON}/reports/sales?period=${MARCH}&compare=previous`);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('invalid_compare');
    });

    it('a preset is refused as a comparison, because the windows would overlap', async () => {
      const res = await get(`/salons/${SALON}/reports/sales?period=30d&compare=90d`);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('invalid_compare');
    });

    it('absent means no comparison, and the key is present either way', async () => {
      expect((await card('sales', `period=${MARCH}`)).comparison).toBeNull();
    });
  });

  // ====================================================================
  /**
   * THE RECONCILIATION THE `earnings-by-branch` SLICE ESTABLISHED, HELD FOR BOTH
   * WINDOWS INDEPENDENTLY. `sales` groups by (day, branch); `earnings-by-branch`
   * groups by branch; `artist-performance` groups by artist through bookings.
   * Three group keys, one pile of money.
   */
  describe('the reconciliation holds in each window on its own', () => {
    for (const w of [MARCH, JANUARY, MARCH_PLUS]) {
      it(`sales, earnings-by-branch and artist-performance agree over ${w}`, async () => {
        const sales = await card('sales', `period=${w}`);
        const branches = await card('earnings-by-branch', `period=${w}`);
        const artists = await card('artist-performance', `period=${w}`);
        expect(branches.stat.value).toBe(sales.stat.value);
        expect(artists.stat.value).toBe(sales.stat.value);
      });
    }

    /** And it still holds when both windows arrive in one response. */
    it('including when the two windows are served together', async () => {
      const sales = await card('sales', `period=${MARCH}&compare=${JANUARY}`);
      const branches = await card('earnings-by-branch', `period=${MARCH}&compare=${JANUARY}`);
      expect(branches.stat.value).toBe(sales.stat.value);
      expect(branches.comparison?.stat.value).toBe(sales.comparison?.stat.value);
      expect(branches.comparison?.delta.value).toBe(sales.comparison?.delta.value);
    });
  });

  // ====================================================================
  describe('the file, its name, and the audit line', () => {
    it('the CSV serves the range and names it in full', async () => {
      const res = await get(`/salons/${SALON}/reports/sales.csv?period=${MARCH}`);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers['content-disposition']).toBe(
        `attachment; filename="sales_all-branches_${MARCH}.csv"`,
      );
    });

    it('two different ranges produce two different filenames', async () => {
      const names = await Promise.all(
        [MARCH, JANUARY, FEBRUARY, '30d'].map(async (w) => {
          const r = await get(`/salons/${SALON}/reports/sales.csv?period=${w}`);
          return String(r.headers['content-disposition']);
        }),
      );
      expect(new Set(names).size).toBe(4);
    });

    /**
     * `customers` IS ONE OF THE TWO AUDITED KINDS, so this is the row a merchant
     * would later use to prove who exported what — and it has to name the window.
     */
    it('an audited export writes a row naming the range', async () => {
      const res = await get(`/salons/${SALON}/reports/customers.csv?period=${MARCH}`);
      expect(res.statusCode, res.body).toBe(200);

      const rows = (await db.execute(sql`
        SELECT detail, metadata FROM audit_log
         WHERE salon_id = ${SALON} AND subject_type = 'report' AND subject_id = 'customers'
         ORDER BY seq DESC LIMIT 1`)) as unknown as Array<Record<string, unknown>>;
      const row = rows[0] as { detail: string; metadata: Record<string, unknown> };
      expect(row.detail).toContain(MARCH);
      expect(row.metadata.period).toBe(MARCH);
      expect(row.metadata.periodBasis).toBe('calendar');
    });

    /**
     * THE MINT STORES A TOKEN AND THE REDEMPTION PARSES IT BACK. That round trip
     * is the mechanism, not a nicety: a token that lost a day would serve a
     * different file than the one she clicked for.
     */
    it('a one-time download link round-trips a range through its text column', async () => {
      const mint = await post(`/salons/${SALON}/reports/sales/download-url?period=${MARCH}`);
      expect(mint.statusCode, mint.body).toBe(200);
      const { url } = JSON.parse(mint.body) as { url: string };

      /**
       * THE ROW THIS MINT WROTE, ADDRESSED BY ITS OWN TOKEN HASH.
       *
       * The first draft took `ORDER BY id DESC LIMIT 1` and read `30d` back - and
       * the implementation was fine. `report_download.id` is `uuid().defaultRandom()`,
       * so ordering by it is ordering by a random number: the query returned some
       * other row minted by an earlier block in this file. A spec that reaches for
       * "the most recent row" needs a column that is actually monotonic, and the
       * exact one is better than either.
       */
      const raw = url.slice(url.lastIndexOf('/') + 1);
      const hash = (await import('../auth/tokens')).hashWalletToken(raw);
      const stored = (await db.execute(sql`
        SELECT period FROM report_download WHERE token_hash = ${hash}`)) as unknown as Array<{
        period: string;
      }>;
      expect(stored).toHaveLength(1);
      expect(stored[0]?.period).toBe(MARCH);

      const file = await app.inject({ method: 'GET', url });
      expect(file.statusCode, file.body).toBe(200);
      expect(file.headers['content-disposition']).toBe(
        `attachment; filename="sales_all-branches_${MARCH}.csv"`,
      );

      /** And the bytes are the same file the header path serves. */
      const direct = await get(`/salons/${SALON}/reports/sales.csv?period=${MARCH}`);
      expect(file.body).toBe(direct.body);
    });
  });

  // ====================================================================
  /**
   * AN EXPORT IS OF ONE WINDOW. Refused rather than accepted-and-dropped: before
   * this slice, `?compare=` on any of these routes returned 200 and a report with
   * no comparison in it, which is a confident answer to a question nobody asked.
   */
  describe('a comparison is not exportable, and says so', () => {
    it('the CSV refuses it', async () => {
      const res = await get(`/salons/${SALON}/reports/sales.csv?period=30d&compare=previous`);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('compare_not_exportable');
      expect(JSON.parse(res.body).message).toContain('Export each window on its own');
    });

    it('the download mint refuses it too, so the link cannot be the way round', async () => {
      const res = await post(`/salons/${SALON}/reports/sales/download-url?period=30d&compare=previous`);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('compare_not_exportable');
    });

    it('but a malformed compare still refuses as a malformed compare, on every route', async () => {
      for (const res of [
        await get(`/salons/${SALON}/reports/sales.csv?period=${MARCH}&compare=previous`),
        await post(`/salons/${SALON}/reports/sales/download-url?period=${MARCH}&compare=previous`),
      ]) {
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body).error).toBe('invalid_compare');
      }
    });
  });

  // ====================================================================
  /**
   * NON-NEGOTIABLE #7, CALLED DIRECTLY WITH THE PERMISSION OFF. A range must not
   * be a way around a gate, and neither must a comparison or a download link.
   */
  describe('the permission is enforced on every path the range reaches', () => {
    it('the card refuses a manager who holds no dashboard permission', async () => {
      const res = await get(`/salons/${SALON}/reports/sales?period=${MARCH}`, noPermBearer);
      expect(res.statusCode, res.body).toBe(403);
    });

    it('so does the CSV', async () => {
      const res = await get(`/salons/${SALON}/reports/sales.csv?period=${MARCH}`, noPermBearer);
      expect(res.statusCode, res.body).toBe(403);
      expect(res.body).not.toContain('Gross KD');
    });

    it('so does the download mint', async () => {
      const res = await post(
        `/salons/${SALON}/reports/sales/download-url?period=${MARCH}`,
        noPermBearer,
      );
      expect(res.statusCode, res.body).toBe(403);
    });

    it('and a comparison does not smuggle a second window past it', async () => {
      const res = await get(
        `/salons/${SALON}/reports/sales?period=${MARCH}&compare=${JANUARY}`,
        noPermBearer,
      );
      expect(res.statusCode, res.body).toBe(403);
    });

    /**
     * THE GATE LANDS BEFORE THE PARAMETER CRITIQUE. A caller who may not read
     * this report must not learn from a 400 that her range was malformed — that
     * is an oracle built out of an input validated too early, and this file's
     * header argues the same ordering for `?branch=`.
     */
    it('and an unauthorised caller is refused before the period is judged', async () => {
      const res = await get(`/salons/${SALON}/reports/sales?period=nonsense`, noPermBearer);
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error).not.toBe('invalid_period');
    });
  });

  // ====================================================================
  describe('what it refuses', () => {
    it('a payload dressed as a range never reaches a filename', async () => {
      for (const hostile of [
        '2024-03-01_2024-03-31"; rm -rf /',
        '2024-02-31_2024-03-31',
        '2024-03-31_2024-03-01',
        '2020-01-01_2026-01-01',
        'this-month',
      ]) {
        const res = await get(
          `/salons/${SALON}/reports/sales.csv?period=${encodeURIComponent(hostile)}`,
        );
        expect(res.statusCode, hostile).toBe(400);
        expect(JSON.parse(res.body).error, hostile).toBe('invalid_period');
        expect(res.headers['content-disposition'], hostile).toBeUndefined();
      }
    });
  });

  // ====================================================================
  /**
   * THE OVERVIEW TAKES THE SAME VOCABULARY — half of "compare with dates" is
   * about the dashboard, and the tiles read the same `?period=`.
   */
  describe('the Overview takes a range too', () => {
    it('answers where it used to answer invalid_period', async () => {
      const res = await get(`/salons/${SALON}/metrics?period=${MARCH}`);
      expect(res.statusCode, res.body).toBe(200);
    });

    /**
     * FIVE FIGURES MOVE, TWO DO NOT. "Loaded today" and "Upcoming today" are
     * labelled today and stay today — see services/metrics.ts § the day. A range
     * in 2024 must not blank them.
     */
    it('but "today" is still today — the two today tiles are unmoved by a 2024 range', async () => {
      const ranged = JSON.parse((await get(`/salons/${SALON}/metrics?period=${MARCH}`)).body);
      const rolling = JSON.parse((await get(`/salons/${SALON}/metrics?period=30d`)).body);
      expect(ranged.loadedTodayFils).toBe(rolling.loadedTodayFils);
      expect(ranged.upcomingAppointments).toBe(rolling.upcomingAppointments);
      expect(ranged.nextAppointmentAt).toBe(rolling.nextAppointmentAt);
    });

    it('and the window figures do move', async () => {
      const march = JSON.parse((await get(`/salons/${SALON}/metrics?period=${MARCH}`)).body);
      const january = JSON.parse((await get(`/salons/${SALON}/metrics?period=${JANUARY}`)).body);
      // Three members charged in March (two of them in-window), two in January.
      expect(march.activeMembers).toBeGreaterThanOrEqual(2);
      expect(january.activeMembers).toBeGreaterThanOrEqual(2);
      expect(march.activeMembers).not.toBe(0);
    });

    it('refuses a malformed range the same way the reports do', async () => {
      const res = await get(`/salons/${SALON}/metrics?period=2024-02-31_2024-03-01`);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('invalid_period');
    });

    it('and enforces #7 with the permission off', async () => {
      const res = await get(`/salons/${SALON}/metrics?period=${MARCH}`, noPermBearer);
      expect(res.statusCode, res.body).toBe(403);
    });
  });
});
