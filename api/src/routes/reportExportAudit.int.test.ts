/**
 * EXPORTING A REPORT LEAVES A TRACE — and only the two that name people do.
 *                                              (the report-export ruling)
 *
 * `routes/reports.ts` wrote no `audit_log` row at all, so a manager could
 * download every artist's earnings, or every customer's name, phone and wallet
 * balance, and leave nothing behind.
 *
 * WHAT THIS FILE PINS, and the second one is the part that would be easy to get
 * wrong in the reassuring direction:
 *
 *   THE ACT IS RECORDED. A `.csv` export and a one-time download link both write
 *       exactly one row, naming who, which kind, how wide the filter was and how
 *       many rows left.
 *
 *   THE CONTENT IS NOT. `GET /salons/{id}/audit` is `perms.dashboard` while both
 *       audited reports are `perms.team`, so any figure copied into the row is
 *       readable at a WEAKER permission than the report it came from. The spec
 *       therefore exports rows whose values would be unmistakable if they leaked
 *       — a distinctive artist name and a distinctive earned figure — and asserts
 *       neither reaches the audit row.
 *
 *   THE CARD RENDER IS NOT AN EXPORT. `GET …/{kind}` is what lane C's own client
 *       comment calls "JSON, the cards". Auditing it would write a row per screen
 *       view and bury the signal it exists to carry.
 *
 *   THE THREE AGGREGATE KINDS ARE NOT AUDITED. Days, services and products name
 *       no individual.
 *
 * `EN-` namespace, per-run suffix — `metrics.int.test.ts` owns `IT-`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const SALON = 'SAL-AMARA';
const BRANCH = 'BR-SAL';
/** Every permission, so `team` is held and both audited kinds are reachable. */
const MANAGER = 'ST-001';

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
/** Distinctive enough that a leak into the audit row is unmistakable. */
const ARTIST_NAME = `Zzyzx Leakcanary ${RUN}`;
const ARTIST = `EN-RA-AR-${RUN}`;

suite('exporting a report writes an audit row, and only the act', () => {
  let app: FastifyInstance;
  let db: (typeof import('../db/client'))['db'];
  let sql: (typeof import('drizzle-orm'))['sql'];
  let token: string;

  const exec = async (q: unknown) =>
    (await db.execute(q as never)) as unknown as Array<Record<string, unknown>>;

  /** Every export row this run wrote, newest last. */
  const rowsFor = async (kind?: string) =>
    exec(sql`
      SELECT action, detail, kind::text AS akind, subject_type, subject_id,
             metadata, amount_fils, actor_id, actor_name
        FROM audit_log
       WHERE salon_id = ${SALON} AND subject_type = 'report'
         AND seq > ${'0'}::bigint
         ${kind === undefined ? sql`` : sql`AND subject_id = ${kind}`}
       ORDER BY seq`);

  const countRows = async (kind: string) =>
    Number(
      (
        await exec(sql`
          SELECT count(*) AS n FROM audit_log
           WHERE salon_id = ${SALON} AND subject_type = 'report' AND subject_id = ${kind}`)
      )[0]?.n ?? 0,
    );

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    sql = (await import('drizzle-orm')).sql;
    const issue = (await import('../auth/sessions')).issueSession;
    app = await (await import('../app')).buildApp();

    /**
     * An artist with a distinctive NAME, so `artist-performance` has a row whose
     * value is unmistakable. She needs no bookings: `artist-performance` lists
     * every artist of the salon, zeros included (`FROM artist LEFT JOIN`), which
     * is exactly what makes her name land in the export without touching money.
     */
    await db.execute(sql`
      INSERT INTO artist (id, salon_id, name) VALUES (${ARTIST}, ${SALON}, ${ARTIST_NAME})`);

    token = (
      await issue(db, {
        principalKind: 'staff',
        staffId: MANAGER,
        salonId: SALON,
        scope: 'dashboard',
      })
    ).accessToken;
  });

  afterAll(async () => {
    if (db) {
      await db.execute(sql`DELETE FROM artist WHERE id = ${ARTIST}`);
      // audit_log is append-only by design (migration 0001 + a trigger that
      // refuses the owner role too), so this run's rows stay. Per-run artist
      // name, and every assertion below is a delta or a shape.
    }
    await app?.close();
  });

  const get = (url: string) =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

  // ==================================================================
  describe('the CSV path', () => {
    it('an artist-performance export writes exactly one row', async () => {
      const before = await countRows('artist-performance');
      const res = await get(`/salons/${SALON}/reports/artist-performance.csv?period=30d`);
      expect(res.statusCode, res.body).toBe(200);
      // The export really did contain her.
      expect(res.body).toContain(ARTIST_NAME);
      expect(await countRows('artist-performance')).toBe(before + 1);
    });

    /**
     * THE ASSERTION THE WHOLE RULING RESTS ON. The CSV carried her name; the
     * audit row must not.
     */
    it('and the row carries the ACT, not her name or any figure', async () => {
      const rows = await rowsFor('artist-performance');
      const last = rows[rows.length - 1]!;

      expect(last.action).toBe('Report exported');
      expect(last.akind).toBe('access');
      expect(last.subject_type).toBe('report');
      expect(last.subject_id).toBe('artist-performance');
      // Named actor — the "who" half.
      expect(last.actor_id).toBe(MANAGER);

      const whole = JSON.stringify(last);
      expect(whole, 'the exported artist name reached the audit row').not.toContain(ARTIST_NAME);
      expect(whole).not.toContain('Zzyzx');
      // `amount_fils` is for money that MOVED. A report moves none.
      expect(last.amount_fils).toBeNull();
    });

    it('the row names the scope and the size', async () => {
      await get(`/salons/${SALON}/reports/artist-performance.csv?period=90d&branch=${BRANCH}`);
      const rows = await rowsFor('artist-performance');
      const last = rows[rows.length - 1]!;
      const meta = last.metadata as Record<string, unknown>;
      expect(meta.period).toBe('90d');
      expect(meta.branchId).toBe(BRANCH);
      expect(meta.via).toBe('csv');
      expect(typeof meta.rowCount).toBe('number');
      expect(String(last.detail)).toContain('90d');
    });

    it('a customers export is audited too — the same argument', async () => {
      const before = await countRows('customers');
      const res = await get(`/salons/${SALON}/reports/customers.csv?period=30d`);
      expect(res.statusCode, res.body).toBe(200);
      expect(await countRows('customers')).toBe(before + 1);

      const rows = await rowsFor('customers');
      const last = rows[rows.length - 1]!;
      // No customer's phone or balance in the row.
      expect(JSON.stringify(last)).not.toMatch(/\+965\d/);
    });

    it.each(['sales', 'best-selling-services', 'products-sold'])(
      '%s is NOT audited — it names no individual',
      async (kind) => {
        const before = await countRows(kind);
        const res = await get(`/salons/${SALON}/reports/${kind}.csv?period=30d`);
        expect(res.statusCode, res.body).toBe(200);
        expect(await countRows(kind)).toBe(before);
      },
    );
  });

  // ==================================================================
  describe('the card render is not an export', () => {
    it.each(['artist-performance', 'customers'])(
      'GET %s as JSON writes nothing',
      async (kind) => {
        const before = await countRows(kind);
        const res = await get(`/salons/${SALON}/reports/${kind}?period=30d`);
        expect(res.statusCode, res.body).toBe(200);
        // Lane C calls this "JSON, the cards" — a row per screen view would
        // bury the signal this ruling exists to carry.
        expect(await countRows(kind)).toBe(before);
      },
    );
  });

  // ==================================================================
  describe('the one-time download link', () => {
    it('minting writes nothing — no file has left yet', async () => {
      const before = await countRows('artist-performance');
      const res = await app.inject({
        method: 'POST',
        url: `/salons/${SALON}/reports/artist-performance/download-url?period=30d`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(await countRows('artist-performance')).toBe(before);
      return JSON.parse(res.body).url as string;
    });

    it('redeeming it writes one row, named from the STORED staff row', async () => {
      const minted = await app.inject({
        method: 'POST',
        url: `/salons/${SALON}/reports/artist-performance/download-url?period=7d&branch=${BRANCH}`,
        headers: { authorization: `Bearer ${token}` },
      });
      const url = JSON.parse(minted.body).url as string;

      const before = await countRows('artist-performance');
      // NO authorization header — the whole point of the link.
      const served = await app.inject({ method: 'GET', url });
      expect(served.statusCode, served.body).toBe(200);
      expect(served.body).toContain(ARTIST_NAME);
      expect(await countRows('artist-performance')).toBe(before + 1);

      const rows = await rowsFor('artist-performance');
      const last = rows[rows.length - 1]!;
      const meta = last.metadata as Record<string, unknown>;
      expect(meta.via).toBe('download-link');
      expect(meta.period).toBe('7d');
      expect(meta.branchId).toBe(BRANCH);
      /**
       * The actor came from `report_download.staff_id`, because this route
       * carries no principal at all. That it is named is the point: an
       * unauthenticated route that still says who took the file.
       */
      expect(last.actor_id).toBe(MANAGER);
      expect(JSON.stringify(last)).not.toContain(ARTIST_NAME);
    });

    it('a spent link writes nothing the second time', async () => {
      const minted = await app.inject({
        method: 'POST',
        url: `/salons/${SALON}/reports/customers/download-url?period=30d`,
        headers: { authorization: `Bearer ${token}` },
      });
      const url = JSON.parse(minted.body).url as string;

      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
      const after = await countRows('customers');
      // Single-use: the second presentation is refused, so nothing is recorded.
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
      expect(await countRows('customers')).toBe(after);
    });

    it('an aggregate kind through the link is still not audited', async () => {
      const minted = await app.inject({
        method: 'POST',
        url: `/salons/${SALON}/reports/sales/download-url?period=30d`,
        headers: { authorization: `Bearer ${token}` },
      });
      const url = JSON.parse(minted.body).url as string;
      const before = await countRows('sales');
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
      expect(await countRows('sales')).toBe(before);
    });
  });

  // ==================================================================
  describe('a refused export records nothing', () => {
    /**
     * A 403 is not an extraction, and the permission census already covers
     * refusals. Auditing them would put a row in the log for every misconfigured
     * client poll.
     */
    it('a caller without perms.team gets 403 and writes no row', async () => {
      const issue = (await import('../auth/sessions')).issueSession;
      const frontdesk = (
        await issue(db, {
          principalKind: 'staff',
          staffId: 'ST-002',
          salonId: SALON,
          scope: 'dashboard',
        })
      ).accessToken;

      const before = await countRows('artist-performance');
      const res = await app.inject({
        method: 'GET',
        url: `/salons/${SALON}/reports/artist-performance.csv?period=30d`,
        headers: { authorization: `Bearer ${frontdesk}` },
      });
      expect(res.statusCode).toBe(403);
      expect(await countRows('artist-performance')).toBe(before);

      await db.execute(sql`DELETE FROM session WHERE staff_id = 'ST-002'`);
    });
  });
});
