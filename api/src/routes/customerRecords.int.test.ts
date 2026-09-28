/**
 * THE CUSTOMER CARD'S TWO MISSING PANELS — her bookings and her purchases, for the
 * merchant. Aftab, 2026-09-29: "On the customer view screen, the bookings and
 * purchases should be displayed".
 *
 *   GET /salons/{id}/bookings?memberId=      perms.appointments  (the board's gate)
 *   GET /v1/salons/{id}/orders?memberId=     perms.shop          (the board's gate)
 *
 * `routes/salons.ts § ?memberId=` carries why these are filters on the boards and
 * why the gate is the board's rather than the card's `team`. This file is the
 * evidence:
 *
 *   #7   each gate called directly with its permission off → 403, and a
 *        `team`-only holder (who CAN open the card) is refused both
 *   tenancy  salon B's member named from salon A → 404 unknown_member, not []
 *   paging   one member's 205 + N rows walk two pages with no repeat and no gap,
 *            which exercises the orders board's NEW cursor end to end
 *   shape    every order row parses as the proposed `MerchantShopOrderSchema`,
 *            `lines` and `totalFils` included
 *
 * FIXTURE. A per-run salon with one branch and shop + booking on. The two
 * line-bearing orders go through the real `POST /orders`, so their ledger is the
 * checkout's own; `avo_app` cannot DELETE `shop_order_line`, so those two orders,
 * their member and the salon are left behind, uniquely named — the
 * `pickupBranch.int.test.ts` precedent. Everything bulk (205 bookings, 205 raw
 * orders without lines) is deleted in `afterAll`.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const P = `CRD${RUN}`;
const id = (s: string) => `${P}-${s}`;
const SALON = id('SA');
const OTHER = id('SB');
const BR = id('BR');
const OTHER_BR = id('BRB');
const BULK = 205;

type Res = { status: number; body: Record<string, any> };

suite('the customer card: her bookings and her purchases', () => {
  let app: FastifyInstance;
  let db: (typeof import('../db/client'))['db'];
  let sql: (typeof import('drizzle-orm'))['sql'];
  /** `@avo/types` — trunk's copy (8769f4c) is the only one; the API's was deleted. */
  let schema: typeof import('@avo/types');
  const token: Record<string, string> = {};

  const M1 = id('M1');
  const M2 = id('M2');
  const MB = id('MB');
  const ST = {
    mgr: id('ST-MGR'),
    teamOnly: id('ST-TEAM'),
    frontdesk: id('ST-FD'),
    other: id('ST-OTH'),
  };

  const exec = async (q: unknown) =>
    (await db.execute(q as never)) as unknown as Array<Record<string, unknown>>;

  const call = async (method: 'GET' | 'POST', url: string, bearer: string, payload?: unknown): Promise<Res> => {
    const res = await app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${bearer}`,
        ...(method === 'POST' ? { 'idempotency-key': `crd-${randomUUID()}` } : {}),
      },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    return { status: res.statusCode, body: JSON.parse(res.body || '{}') as Record<string, any> };
  };

  /** Every page of a cursor walk, asserting each is 200. */
  const walk = async (base: string, bearer: string) => {
    const pages: Array<Record<string, any>> = [];
    let cursor: string | null = null;
    do {
      const sep = base.includes('?') ? '&' : '?';
      const res = await call(
        'GET',
        cursor ? `${base}${sep}cursor=${encodeURIComponent(cursor)}` : base,
        bearer,
      );
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      pages.push(res.body);
      cursor = res.body.nextCursor;
    } while (cursor && pages.length < 10);
    return pages;
  };

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    sql = (await import('drizzle-orm')).sql;
    schema = await import('@avo/types');
    const issue = (await import('../auth/sessions')).issueSession;
    app = await (await import('../app')).buildApp();

    const hours = JSON.stringify({ morning: ['10:00', '13:00'], evening: ['16:00', '22:00'] });
    for (const s of [SALON, OTHER]) {
      await exec(sql`
        INSERT INTO salon (id, name, brand_color, loyalty_mode, stamp_target, stamp_reward, deposit_fils,
                           business_hours, module_booking, module_shop)
        VALUES (${s}, ${`CRD ${s}`}, '#7A5C8E', 'stamps', 6, 'free blow-dry', 2000, ${hours}::jsonb, true, true)`);
    }
    await exec(sql`INSERT INTO branch (id, salon_id, name) VALUES (${BR}, ${SALON}, 'CRD Salmiya'), (${OTHER_BR}, ${OTHER}, 'CRD Other')`);

    const staff = async (sid: string, salonId: string, p: { appointments: boolean; shop: boolean; team: boolean }) => {
      await exec(sql`
        INSERT INTO staff_user
          (id, salon_id, name, handle, role, branch_access_all, branch_access_ids, password_hash,
           perm_dashboard, perm_appointments, perm_shop, perm_loyalty, perm_team, perm_scanner,
           perm_charges, perm_void, perm_marketing)
        VALUES (${sid}, ${salonId}, ${`CRD ${sid}`}, ${sid.toLowerCase()}, 'manager', true, '{}', 'x',
                true, ${p.appointments}, ${p.shop}, false, ${p.team}, false, false, false, false)`);
      token[sid] = (await issue(db, { principalKind: 'staff', staffId: sid, salonId, scope: 'dashboard' })).accessToken;
    };
    await staff(ST.mgr, SALON, { appointments: true, shop: true, team: true });
    await staff(ST.teamOnly, SALON, { appointments: false, shop: false, team: true });
    await staff(ST.frontdesk, SALON, { appointments: true, shop: true, team: false });
    await staff(ST.other, OTHER, { appointments: true, shop: true, team: true });

    const member = async (mid: string, salonId: string) => {
      await exec(sql`
        INSERT INTO member (id, salon_id, name, phone, password_hash, balance_fils, tier, stamps, visits, policy_version)
        VALUES (${mid}, ${salonId}, ${`CRD ${mid}`},
                ${`+9657${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`},
                '$argon2id$fake-not-a-credential', 50000, null, 0, 0, 3)`);
      token[mid] = (await issue(db, { principalKind: 'member', memberId: mid, salonId, scope: 'wallet' })).accessToken;
    };
    await member(M1, SALON);
    await member(M2, SALON);
    await member(MB, OTHER);

    await exec(sql`INSERT INTO service (id, salon_id, name, price_fils) VALUES (${id('SV')}, ${SALON}, 'CRD Cut', 8000)`);
    await exec(sql`INSERT INTO artist (id, salon_id, name) VALUES (${id('AR')}, ${SALON}, 'CRD Rana')`);
    await exec(sql`INSERT INTO product (id, salon_id, name, price_fils) VALUES (${id('PA')}, ${SALON}, 'CRD Serum', 4500), (${id('PB')}, ${SALON}, 'CRD Oil', 1250)`);

    // Bookings: BULK for M1, three for M2 — merchant-written, zero deposit.
    await exec(sql`
      INSERT INTO booking (id, salon_id, branch_id, member_id, artist_id, service_id, starts_at, ends_at,
                           duration_min, deposit_fils, status, source, no_show_return_due_at)
      SELECT ${P} || '-BK1-' || g, ${SALON}, ${BR}, ${M1}, ${id('AR')}, ${id('SV')},
             timestamptz '2032-01-01 08:00Z' + g * interval '1 hour',
             timestamptz '2032-01-01 09:00Z' + g * interval '1 hour', 60, 0, 'deposit_held', 'merchant',
             timestamptz '2032-01-01 10:00Z' + g * interval '1 hour'
        FROM generate_series(1, ${BULK}) g`);
    await exec(sql`
      INSERT INTO booking (id, salon_id, branch_id, member_id, artist_id, service_id, starts_at, ends_at,
                           duration_min, deposit_fils, status, source, no_show_return_due_at)
      SELECT ${P} || '-BK2-' || g, ${SALON}, ${BR}, ${M2}, ${id('AR')}, ${id('SV')},
             timestamptz '2033-01-01 08:00Z' + g * interval '1 hour',
             timestamptz '2033-01-01 09:00Z' + g * interval '1 hour', 60, 0, 'deposit_held', 'merchant',
             timestamptz '2033-01-01 10:00Z' + g * interval '1 hour'
        FROM generate_series(1, 3) g`);

    // Orders: two real ones for M1 through the checkout, then BULK raw ones for M1
    // (no lines, so they can be deleted), dated before the real ones.
    const o1 = await call('POST', '/orders', token[M1] as string, { items: [{ productId: id('PA'), qty: 2 }, { productId: id('PB'), qty: 1 }] });
    expect(o1.status, JSON.stringify(o1.body)).toBe(201);
    const o2 = await call('POST', '/orders', token[M1] as string, { items: [{ productId: id('PB'), qty: 1 }] });
    expect(o2.status, JSON.stringify(o2.body)).toBe(201);
    const o3 = await call('POST', '/orders', token[M2] as string, { items: [{ productId: id('PB'), qty: 1 }] });
    expect(o3.status, JSON.stringify(o3.body)).toBe(201);

    await exec(sql`
      INSERT INTO "transaction" (id, member_id, salon_id, branch_id, kind, amount_fils, method, status, created_at, settled_at)
      SELECT ${P} || '-TXB-' || g, ${M1}, ${SALON}, ${BR}, 'shop', -1000, 'wallet', 'settled',
             timestamptz '2026-01-01 08:00Z' + g * interval '1 minute',
             timestamptz '2026-01-01 08:00Z' + g * interval '1 minute'
        FROM generate_series(1, ${BULK}) g`);
    await exec(sql`
      INSERT INTO shop_order (transaction_id, salon_id, member_id, fulfilment, status, created_at)
      SELECT ${P} || '-TXB-' || g, ${SALON}, ${M1}, 'pickup', 'preparing',
             timestamptz '2026-01-01 08:00Z' + g * interval '1 minute'
        FROM generate_series(1, ${BULK}) g`);
  });

  afterAll(async () => {
    if (db && sql) {
      await exec(sql`DELETE FROM booking WHERE id LIKE ${`${P}-BK%`}`);
      await exec(sql`DELETE FROM shop_order WHERE transaction_id LIKE ${`${P}-TXB-%`}`);
      await exec(sql`DELETE FROM "transaction" WHERE id LIKE ${`${P}-TXB-%`}`);
      await exec(sql`DELETE FROM session WHERE salon_id IN (${SALON}, ${OTHER})`);
    }
    await app?.close();
  });

  // ============================================================= bookings ==

  const bookings = (q: string) => `/salons/${SALON}/bookings?${q}`;

  it('her bookings only, newest first, walked across two pages with no repeat and no gap', async () => {
    const pages = await walk(bookings(`memberId=${M1}`), token[ST.mgr] as string);
    expect(pages.map((p) => p.items.length)).toEqual([200, BULK - 200]);
    const items = pages.flatMap((p) => p.items);
    expect(new Set(items.map((b: any) => b.id)).size).toBe(BULK);
    expect(items.every((b: any) => b.memberId === M1)).toBe(true);
    const starts = items.map((b: any) => b.startsAt);
    expect([...starts].sort().reverse()).toEqual(starts);
    expect(pages[pages.length - 1]?.nextCursor).toBeNull();
  });

  it('absent is unchanged: the board still carries every member', async () => {
    const res = await call('GET', `/salons/${SALON}/bookings`, token[ST.mgr] as string);
    expect(res.status).toBe(200);
    expect(res.body.items.some((b: any) => b.memberId === M2)).toBe(true);
  });

  it("another salon's member is 404 unknown_member, not an empty page — and so is an id nobody has", async () => {
    for (const who of [MB, id('NOBODY')]) {
      const res = await call('GET', bookings(`memberId=${who}`), token[ST.mgr] as string);
      expect(res.status, who).toBe(404);
      expect(res.body.error).toBe('unknown_member');
    }
    // And from her own salon's side, salon A's member is invisible the same way.
    const back = await call('GET', `/salons/${OTHER}/bookings?memberId=${M1}`, token[ST.other] as string);
    expect(back.status).toBe(404);
  });

  it('#7 — appointments off is 403 even for a team holder who can open her card', async () => {
    const res = await call('GET', bookings(`memberId=${M1}`), token[ST.teamOnly] as string);
    expect(res.status).toBe(403);
    expect(res.body.message).toContain('appointments');
  });

  it("the board's gate, not the card's: appointments without team reads it", async () => {
    const res = await call('GET', bookings(`memberId=${M2}`), token[ST.frontdesk] as string);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(3);
  });

  it('another salon calling this salon is 403 before the member is looked up', async () => {
    const res = await call('GET', bookings(`memberId=${M1}`), token[ST.other] as string);
    expect(res.status).toBe(403);
  });

  it('two memberIds is 400 invalid_member_id rather than one of them silently', async () => {
    const res = await call('GET', bookings(`memberId=${M1}&memberId=${M2}`), token[ST.mgr] as string);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_member_id');
  });

  // =============================================================== orders ==

  const orders = (q: string) => `/v1/salons/${SALON}/orders?${q}`;

  it('her orders only, with what she bought and what it cost, across the new cursor', async () => {
    const pages = await walk(orders(`memberId=${M1}`), token[ST.mgr] as string);
    expect(pages.map((p) => p.items.length)).toEqual([200, BULK + 2 - 200]);
    expect(pages.map((p) => p.truncated)).toEqual([true, false]);
    for (const p of pages) {
      const parsed = schema.OrderBoardSchema.safeParse(p);
      expect(parsed.success, JSON.stringify(parsed.error?.issues?.slice(0, 3))).toBe(true);
    }
    const items = pages.flatMap((p) => p.items);
    expect(new Set(items.map((o: any) => o.transactionId)).size).toBe(BULK + 2);
    expect(items.every((o: any) => o.memberName === `CRD ${M1}`)).toBe(true);

    // Newest first: the two real checkouts are today, the bulk rows are January.
    const [second, first] = items.slice(0, 2);
    expect(first.lines).toEqual([
      { productId: id('PB'), name: 'CRD Oil', qty: 1, unitPriceFils: 1250, lineTotalFils: 1250 },
      { productId: id('PA'), name: 'CRD Serum', qty: 2, unitPriceFils: 4500, lineTotalFils: 9000 },
    ]);
    expect(first.totalFils).toBe(10250);
    expect(second.lines).toHaveLength(1);
    expect(second.totalFils).toBe(1250);
  });

  it('the total is her wallet debit, read from the transaction, and agrees with its lines', async () => {
    const res = await call('GET', orders(`memberId=${M2}`), token[ST.mgr] as string);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    const o = res.body.items[0];
    const [row] = await exec(sql`SELECT -amount_fils AS debit FROM "transaction" WHERE id = ${o.transactionId}`);
    expect(o.totalFils).toBe(Number(row?.debit));
    expect(o.totalFils).toBe(o.lines.reduce((n: number, l: any) => n + l.lineTotalFils, 0));
    expect(res.body.nextCursor).toBeNull();
  });

  it("another salon's member is 404 unknown_member on the orders board too", async () => {
    const res = await call('GET', orders(`memberId=${MB}`), token[ST.mgr] as string);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('unknown_member');
  });

  it('#7 — shop off is 403 even for a team holder', async () => {
    const res = await call('GET', orders(`memberId=${M1}`), token[ST.teamOnly] as string);
    expect(res.status).toBe(403);
    expect(res.body.message).toContain('shop');
  });

  it('the unfiltered board pages too, and its first page is the 200 newest', async () => {
    const res = await call('GET', `/v1/salons/${SALON}/orders`, token[ST.mgr] as string);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(200);
    expect(res.body.truncated).toBe(true);
    expect(typeof res.body.nextCursor).toBe('string');
    expect(res.body.items[0].memberName).toBe(`CRD ${M2}`); // o3, the last checkout
  });
});
