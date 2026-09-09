/**
 * `GET /salons/{id}/bookings` PAGES, and used to claim it did not need to.
 *
 * It was `LIMIT 200` with `nextCursor: null` hardcoded. Lane C found the
 * consequence by loading 211 further-out bookings: the list truncated, and
 * because the order is `starts_at DESC` the rows dropped first were the ones
 * STARTING SOONEST — so its client-side closure impact read 0 deposit-held
 * appointments where `closure-preview` correctly reported 3.
 *
 * WHAT IS ASSERTED HERE, and why each one exists:
 *
 *   the cap is exceeded          205 bookings, so page 1 is capped and there IS
 *                               a second page. Without this the old code passes.
 *   nextCursor is not null       the exact field that lied.
 *   the walk is complete         every id appears EXACTLY once across the pages.
 *                               A drifting cursor does not throw — streamCursor.ts
 *                               says it "silently skips rows, and the reader sees
 *                               a shorter list rather than an error" — so a
 *                               set-equality check is the only thing that catches it.
 *   the soonest row is reachable the specific row lane C lost. It is not on page
 *                               1 by construction, and must be on a later one.
 *   a tie does not repeat or lose
 *                               two bookings sharing `starts_at` to the
 *                               microsecond, on different artists, straddling a
 *                               page boundary — the case the `(at, id)` tiebreak
 *                               exists for.
 *
 * ONE HOLD TRANSACTION IS SHARED by all 205 bookings, which is not a shape the
 * product produces and is deliberate: `hold_transaction_id` carries no unique
 * constraint, nothing in this file reads it, and minting 205 real deposit holds
 * would write 205 ledger pairs into an append-only table to test an ORDER BY.
 *
 * `EN-` namespace, per-run suffix — `metrics.int.test.ts` owns `IT-`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const SALON = 'SAL-AMARA';
const BRANCH = 'BR-SAL';
const MANAGER = 'ST-001';
const PAGE = 200;
const TOTAL = 205;

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const AR_A = `EN-BP-A-${RUN}`;
const AR_B = `EN-BP-B-${RUN}`;
/** A third artist, because the tie rows must both sit on artists free at that instant. */
const AR_C = `EN-BP-C-${RUN}`;
const SVC = `EN-BP-SV-${RUN}`;
const MEMBER = `EN-BP-M-${RUN}`;
const HOLD = `EN-BP-TX-${RUN}`;
const bk = (n: number) => `EN-BP-BK-${RUN}-${String(n).padStart(4, '0')}`;
/** The two that share an instant, on different artists so the EXCLUDE allows it. */
const TIE_A = `EN-BP-TIE-A-${RUN}`;
const TIE_B = `EN-BP-TIE-B-${RUN}`;

suite('GET /salons/:id/bookings pages honestly', () => {
  let app: FastifyInstance;
  let db: (typeof import('../db/client'))['db'];
  let sql: (typeof import('drizzle-orm'))['sql'];
  let token: string;

  const exec = async (q: unknown) =>
    (await db.execute(q as never)) as unknown as Array<Record<string, unknown>>;

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    sql = (await import('drizzle-orm')).sql;
    const issue = (await import('../auth/sessions')).issueSession;
    app = await (await import('../app')).buildApp();

    await db.execute(sql`
      INSERT INTO artist (id, salon_id, name) VALUES
        (${AR_A}, ${SALON}, ${`EN BP A ${RUN}`}),
        (${AR_B}, ${SALON}, ${`EN BP B ${RUN}`}),
        (${AR_C}, ${SALON}, ${`EN BP C ${RUN}`})`);
    await db.execute(sql`
      INSERT INTO service (id, salon_id, name, price_fils)
      VALUES (${SVC}, ${SALON}, ${`EN BP Svc ${RUN}`}, 5000)`);
    await db.execute(sql`
      INSERT INTO member (id, salon_id, name, phone, password_hash, balance_fils, tier, visits, policy_version)
      VALUES (${MEMBER}, ${SALON}, 'EN BP Member',
              ${`+9655${String(Date.now() % 1_000_000).padStart(6, '0')}`}, 'x', 500000, 'bronze', 0, 1)`);
    await db.execute(sql`
      INSERT INTO "transaction"
        (id, member_id, salon_id, branch_id, kind, amount_fils, method, status, reference, created_at, settled_at)
      VALUES (${HOLD}, ${MEMBER}, ${SALON}, ${BRANCH}, 'deposit_hold', -5000, 'wallet', 'settled', '',
              now(), now())`);

    /**
     * 205 bookings, one hour apart, all in the FUTURE and all `deposit_held` — so
     * `booking_settlement_matches_status` is satisfied with a NULL settlement and
     * every row is the status a closure impact counts.
     *
     * n = 1 is the SOONEST and n = 205 the furthest out. Under `starts_at DESC`
     * that makes n = 1 the row the old cap dropped, and it is asserted by name.
     */
    const values = Array.from({ length: TOTAL }, (_, i) => {
      const n = i + 1;
      return sql`(${bk(n)}, ${SALON}, ${BRANCH}, false, ${MEMBER}, ${AR_A}, ${SVC},
        now() + ${`${n} hours`}::interval, now() + ${`${n} hours 30 minutes`}::interval,
        30, 5000, 'deposit_held', ${HOLD}, NULL, now() + ${`${n} hours`}::interval)`;
    });
    await db.execute(sql`
      INSERT INTO booking
        (id, salon_id, branch_id, branch_assumed, member_id, artist_id, service_id,
         starts_at, ends_at, duration_min, deposit_fils, status, hold_transaction_id,
         settled_transaction_id, no_show_return_due_at)
      VALUES ${sql.join(values, sql`, `)}`);

    /**
     * THE TIE. Both at the same instant to the microsecond, and on AR_B and AR_C
     * rather than AR_A — `booking_artist_slot_no_overlap` is an EXCLUDE over
     * (artist_id, range), and AR_A already holds the n=6 slot this instant is
     * derived from, so putting either tie row there is refused. Found by driving
     * it, which is the constraint doing its job.
     *
     * Positioned to land on the page-1/page-2 boundary: `starts_at DESC` puts
     * n=205 first, so with 207 rows the boundary falls right about here.
     */
    await db.execute(sql`
      INSERT INTO booking
        (id, salon_id, branch_id, branch_assumed, member_id, artist_id, service_id,
         starts_at, ends_at, duration_min, deposit_fils, status, hold_transaction_id,
         settled_transaction_id, no_show_return_due_at)
      SELECT id, ${SALON}, ${BRANCH}, false, ${MEMBER}, artist, ${SVC},
             (SELECT starts_at FROM booking WHERE id = ${bk(6)}) + interval '1 microsecond',
             (SELECT ends_at FROM booking WHERE id = ${bk(6)}) + interval '1 microsecond',
             30, 5000, 'deposit_held', ${HOLD}, NULL,
             (SELECT no_show_return_due_at FROM booking WHERE id = ${bk(6)})
        FROM (VALUES (${TIE_A}, ${AR_B}), (${TIE_B}, ${AR_C})) AS v(id, artist)`);

    token = (
      await issue(db, { principalKind: 'staff', staffId: MANAGER, salonId: SALON, scope: 'dashboard' })
    ).accessToken;
  });

  afterAll(async () => {
    if (db) {
      await db.execute(sql`DELETE FROM booking WHERE id LIKE ${`EN-BP-%${RUN}%`}`);
      await db.execute(sql`DELETE FROM booking WHERE hold_transaction_id = ${HOLD}`);
      await db.execute(sql`DELETE FROM "transaction" WHERE id = ${HOLD}`);
      await db.execute(sql`DELETE FROM artist WHERE id IN (${AR_A}, ${AR_B}, ${AR_C})`);
      await db.execute(sql`DELETE FROM service WHERE id = ${SVC}`);
      await db.execute(sql`DELETE FROM member WHERE id = ${MEMBER}`);
    }
    await app?.close();
  });

  interface Page {
    items: Array<{ id: string; startsAt: string }>;
    nextCursor: string | null;
  }
  async function fetchPage(cursor?: string | null): Promise<Page> {
    const qs = new URLSearchParams({ status: 'deposit_held' });
    if (cursor) qs.set('cursor', cursor);
    const res = await app.inject({
      method: 'GET',
      url: `/salons/${SALON}/bookings?${qs.toString()}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    return JSON.parse(res.body) as Page;
  }

  /** Every page, to exhaustion, with a hard stop so a broken cursor cannot hang. */
  async function walk(): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 20; i++) {
      const page: Page = await fetchPage(cursor);
      ids.push(...page.items.map((b) => b.id));
      cursor = page.nextCursor;
      if (!cursor) return ids;
    }
    throw new Error('the walk did not terminate in 20 pages');
  }

  it('page one is capped and does NOT claim to be the last', async () => {
    const first = await fetchPage();
    expect(first.items.length).toBe(PAGE);
    // The exact field that used to be hardcoded null.
    expect(first.nextCursor).not.toBeNull();
  });

  it('the soonest appointment — the one the cap dropped — is reachable', async () => {
    const first = await fetchPage();
    const onPageOne = first.items.map((b) => b.id);
    // Not on page 1, by construction: `starts_at DESC` puts it last of 207.
    expect(onPageOne).not.toContain(bk(1));

    const all = await walk();
    expect(all).toContain(bk(1));
  });

  it('the walk visits every one of this run’s bookings exactly once', async () => {
    const all = (await walk()).filter((id) => id.includes(RUN));
    expect(all.length).toBe(TOTAL + 2);
    expect(new Set(all).size).toBe(all.length);

    const rows = await exec(sql`
      SELECT id FROM booking
       WHERE salon_id = ${SALON} AND status = 'deposit_held' AND id LIKE ${`%${RUN}%`}`);
    expect(new Set(all)).toEqual(new Set(rows.map((r) => String(r.id))));
  });

  it('two bookings sharing an instant across a page boundary are neither repeated nor lost', async () => {
    const all = (await walk()).filter((id) => id === TIE_A || id === TIE_B);
    expect(all.sort()).toEqual([TIE_A, TIE_B].sort());
  });

  it('the last page reports nextCursor null, and it is true', async () => {
    let cursor: string | null = null;
    let page: Page = await fetchPage();
    let guard = 0;
    while (page.nextCursor && guard++ < 20) {
      cursor = page.nextCursor;
      page = await fetchPage(cursor);
    }
    expect(page.nextCursor).toBeNull();
    expect(page.items.length).toBeLessThan(PAGE);
  });

  it('a malformed cursor is refused by name, not walked', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/salons/${SALON}/bookings?cursor=not-a-cursor`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_cursor');
  });

  it('the status filter survives paging', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/salons/${SALON}/bookings?status=cancelled`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Page;
    expect(body.items.every((b) => !b.id.includes(RUN))).toBe(true);
  });
});
