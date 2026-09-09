/**
 * DELIVERY — the address book, the pickup/delivery fork, and three statuses.
 *                                     (item 7, PRIOR-ART.md § Lean's shop)
 *
 * THE ASSERTION THAT MATTERS MOST IS A NEGATIVE ONE: choosing delivery changes
 * NO amount. Lean has no delivery fee anywhere, and following that is what keeps
 * this whole feature off the money path — so the spec pins that the same cart
 * costs the same whether it is collected or delivered, and that her balance moves
 * by exactly the goods.
 *
 * And the thing not copied: Lean collects two inputs and sends one of them as
 * four address fields, with `'string'` in two more. So there are specs for a
 * field left empty staying NULL, and for the order refusing raw address fields
 * in favour of an id from her own book.
 *
 * `EN-` namespace, per-run suffix — `metrics.int.test.ts` owns `IT-`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const SALON = 'SAL-AMARA';
const MANAGER = 'ST-001';
/** `shop` FALSE on the seeded frontdesk — db/seed.ts. */
const FRONTDESK = 'ST-002';

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const MEMBER = `EN-DL-M-${RUN}`;
const OTHER_MEMBER = `EN-DL-M2-${RUN}`;
const PRODUCT = `EN-DL-P-${RUN}`;

suite('the shop delivers, and it costs nothing extra', () => {
  let app: FastifyInstance;
  let db: (typeof import('../db/client'))['db'];
  let sql: (typeof import('drizzle-orm'))['sql'];
  let issue: (typeof import('../auth/sessions'))['issueSession'];
  let hers: string;
  let others: string;
  let manager: string;
  let frontdesk: string;

  const exec = async (q: unknown) =>
    (await db.execute(q as never)) as unknown as Array<Record<string, unknown>>;
  const balance = async (id = MEMBER) =>
    Number((await exec(sql`SELECT balance_fils AS n FROM member WHERE id = ${id}`))[0]?.n ?? 0);

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    sql = (await import('drizzle-orm')).sql;
    issue = (await import('../auth/sessions')).issueSession;
    app = await (await import('../app')).buildApp();

    await db.execute(sql`
      INSERT INTO member (id, salon_id, name, phone, password_hash, balance_fils, tier, visits, policy_version)
      VALUES
        (${MEMBER}, ${SALON}, 'EN DL Her',
         ${`+9654${String(Date.now() % 1_000_000).padStart(6, '0')}`}, 'x', 400000, 'bronze', 0, 1),
        (${OTHER_MEMBER}, ${SALON}, 'EN DL Other',
         ${`+9653${String(Date.now() % 1_000_000).padStart(6, '0')}`}, 'x', 400000, 'bronze', 0, 1)`);
    await db.execute(sql`
      INSERT INTO product (id, salon_id, name, price_fils, active)
      VALUES (${PRODUCT}, ${SALON}, ${`EN DL Serum ${RUN}`}, 7500, true)`);

    hers = (
      await issue(db, { principalKind: 'member', memberId: MEMBER, salonId: SALON, scope: 'wallet' })
    ).accessToken;
    others = (
      await issue(db, {
        principalKind: 'member',
        memberId: OTHER_MEMBER,
        salonId: SALON,
        scope: 'wallet',
      })
    ).accessToken;
    manager = (
      await issue(db, { principalKind: 'staff', staffId: MANAGER, salonId: SALON, scope: 'dashboard' })
    ).accessToken;
    frontdesk = (
      await issue(db, { principalKind: 'staff', staffId: FRONTDESK, salonId: SALON, scope: 'dashboard' })
    ).accessToken;
  });

  afterAll(async () => {
    if (db) {
      await db.execute(sql`DELETE FROM session WHERE member_id IN (${MEMBER}, ${OTHER_MEMBER})`);
      // shop_order, its lines, the transactions and the addresses are anchored by
      // ledger rows that cannot be deleted. Per-run ids; nothing else reads them.
    }
    await app?.close();
  });

  const req = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, token: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(method === 'POST' || method === 'PUT' || method === 'PATCH'
          ? { 'idempotency-key': `en-dl-${RUN}-${Math.random().toString(36).slice(2)}` }
          : {}),
      },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  const FULL = {
    label: 'Home',
    block: '4',
    street: 'Al Bahar',
    building: '12',
    floor: '3',
    apartment: '7',
    area: 'Salmiya',
    governorate: 'Hawalli',
    instructions: 'green door, call on arrival',
    latitude: 29.336,
    longitude: 48.077,
  };

  let addressId = '';

  // ==================================================================
  // THE ADDRESS BOOK — and the thing not copied from Lean.
  // ==================================================================
  describe('her address book', () => {
    it('stores exactly the fields given, with coordinates', async () => {
      const res = await req('POST', '/members/me/addresses', hers, FULL);
      expect(res.statusCode, res.body).toBe(201);
      const a = JSON.parse(res.body).address;
      addressId = a.id;
      expect(a.block).toBe('4');
      expect(a.street).toBe('Al Bahar');
      expect(a.building).toBe('12');
      expect(a.instructions).toBe('green door, call on arrival');
      // `numeric` round-trips as an exact string, not a float.
      expect(a.latitude).toBe('29.336000');
      expect(a.longitude).toBe('48.077000');
    });

    /**
     * THE LEAN DEFECT, INVERTED INTO AN ASSERTION. Lean writes the house number
     * into `block`, `buildingNumber`, `floor` AND `apartment`, and ships
     * `'string'` where it has nothing. An omitted field here is NULL — not a
     * copy of another field, not a placeholder.
     */
    it('an omitted optional field is NULL, not a placeholder or a copy', async () => {
      const res = await req('POST', '/members/me/addresses', hers, {
        label: 'Bare',
        block: '9',
        street: 'Gulf Road',
        building: '3',
      });
      expect(res.statusCode, res.body).toBe(201);
      const a = JSON.parse(res.body).address;
      for (const f of ['floor', 'apartment', 'area', 'governorate', 'instructions'] as const) {
        expect(a[f], `${f} should be null`).toBeNull();
      }
      expect(a.latitude).toBeNull();
      expect(a.longitude).toBeNull();
      // And specifically NOT the building number wearing four hats.
      expect(a.floor).not.toBe('3');
      expect(a.apartment).not.toBe('3');
      // Nor the literal text Lean ships.
      expect(a.instructions).not.toBe('string');
    });

    it('a blank required field is refused', async () => {
      for (const bad of [
        { label: 'x', block: '   ', street: 's', building: 'b' },
        { label: '   ', block: '1', street: 's', building: 'b' },
      ]) {
        const res = await req('POST', '/members/me/addresses', hers, bad);
        expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      }
    });

    it('a half-pair of coordinates is refused, not stored as half a location', async () => {
      const res = await req('POST', '/members/me/addresses', hers, {
        ...FULL,
        longitude: undefined,
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('coordinates_incomplete');
    });

    it('a memberId in the body is refused rather than obeyed', async () => {
      const res = await req('POST', '/members/me/addresses', hers, {
        ...FULL,
        memberId: OTHER_MEMBER,
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('member_not_client_supplied');
    });

    it("another customer cannot read, edit or delete hers", async () => {
      const list = await req('GET', '/members/me/addresses', others);
      expect(list.statusCode).toBe(200);
      expect((JSON.parse(list.body).items as Array<{ id: string }>).map((a) => a.id)).not.toContain(
        addressId,
      );

      expect((await req('PUT', `/members/me/addresses/${addressId}`, others, FULL)).statusCode).toBe(404);
      expect((await req('DELETE', `/members/me/addresses/${addressId}`, others)).statusCode).toBe(404);
    });

    it('a PUT clears an omitted optional rather than keeping the old value', async () => {
      const res = await req('PUT', `/members/me/addresses/${addressId}`, hers, {
        label: 'Home',
        block: '4',
        street: 'Al Bahar',
        building: '12',
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(JSON.parse(res.body).address.instructions).toBeNull();

      // Put it back for the order specs below.
      await req('PUT', `/members/me/addresses/${addressId}`, hers, FULL);
    });
  });

  // ==================================================================
  // THE FORK — and the money that does not move.
  // ==================================================================
  describe('pickup and delivery cost the same', () => {
    const cart = () => ({ items: [{ productId: PRODUCT, qty: 2 }] });
    const PRICE = 7500 * 2;

    it('a pickup order debits exactly the goods', async () => {
      const before = await balance();
      const res = await req('POST', '/orders', hers, { ...cart(), fulfilment: 'pickup' });
      expect(res.statusCode, res.body).toBe(201);
      expect(before - (await balance())).toBe(PRICE);
    });

    /** THE POINT OF THE WHOLE SLICE: the same cart, delivered, costs the same. */
    it('a DELIVERY order debits exactly the goods too — no fee', async () => {
      const before = await balance();
      const res = await req('POST', '/orders', hers, {
        ...cart(),
        fulfilment: 'delivery',
        addressId,
      });
      expect(res.statusCode, res.body).toBe(201);
      expect(before - (await balance())).toBe(PRICE);
    });

    it('and no ledger row anywhere names a delivery charge', async () => {
      const rows = await exec(sql`
        SELECT DISTINCT le.account::text AS account
          FROM ledger_entry le
          JOIN "transaction" t ON t.id = le.transaction_id
         WHERE t.member_id = ${MEMBER}`);
      // Only the two a wallet spend writes. A fee would have to invent a third.
      expect(new Set(rows.map((r) => String(r.account)))).toEqual(
        new Set(['member_wallet', 'salon_revenue']),
      );
    });

    it('omitting fulfilment is a PICKUP — the behaviour that shipped before', async () => {
      const res = await req('POST', '/orders', hers, cart());
      expect(res.statusCode, res.body).toBe(201);
      const txId = JSON.parse(res.body).transaction.id as string;
      const [row] = await exec(
        sql`SELECT fulfilment::text AS f, block FROM shop_order WHERE transaction_id = ${txId}`,
      );
      expect(row?.f).toBe('pickup');
      // A pickup is not a delivery with empty fields.
      expect(row?.block).toBeNull();
    });

    it('an unknown fulfilment is refused, not silently collected', async () => {
      const res = await req('POST', '/orders', hers, { ...cart(), fulfilment: 'DELIVERY' });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('invalid_fulfilment');
    });

    it('delivery with no address is refused', async () => {
      const res = await req('POST', '/orders', hers, { ...cart(), fulfilment: 'delivery' });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('address_required');
    });

    it("another customer's address is a 404, and no money moved", async () => {
      const created = await req('POST', '/members/me/addresses', others, {
        label: 'Theirs',
        block: '1',
        street: 'Elsewhere',
        building: '1',
      });
      const theirs = JSON.parse(created.body).address.id as string;

      const before = await balance();
      const res = await req('POST', '/orders', hers, {
        ...cart(),
        fulfilment: 'delivery',
        addressId: theirs,
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error).toBe('unknown_address');
      expect(await balance()).toBe(before);
    });

    it('raw address fields on the order are refused in favour of an id', async () => {
      for (const field of ['block', 'street', 'building', 'address'] as const) {
        const res = await req('POST', '/orders', hers, {
          ...cart(),
          fulfilment: 'delivery',
          addressId,
          [field]: 'x',
        });
        expect(res.statusCode, field).toBe(400);
        expect(JSON.parse(res.body).error).toBe('address_not_client_supplied');
      }
    });

    it('the address is SNAPSHOTTED, so editing her book later does not move the order', async () => {
      const res = await req('POST', '/orders', hers, {
        ...cart(),
        fulfilment: 'delivery',
        addressId,
      });
      const txId = JSON.parse(res.body).transaction.id as string;

      await req('PUT', `/members/me/addresses/${addressId}`, hers, {
        ...FULL,
        street: 'Somewhere Else Entirely',
      });

      const [row] = await exec(
        sql`SELECT street FROM shop_order WHERE transaction_id = ${txId}`,
      );
      expect(row?.street).toBe('Al Bahar');

      await req('PUT', `/members/me/addresses/${addressId}`, hers, FULL);
    });

    it('a soft-deleted address keeps its old order intact', async () => {
      const created = await req('POST', '/members/me/addresses', hers, {
        label: 'Temporary',
        block: '8',
        street: 'Short Lived',
        building: '2',
      });
      const temp = JSON.parse(created.body).address.id as string;
      const ordered = await req('POST', '/orders', hers, {
        ...cart(),
        fulfilment: 'delivery',
        addressId: temp,
      });
      const txId = JSON.parse(ordered.body).transaction.id as string;

      expect((await req('DELETE', `/members/me/addresses/${temp}`, hers)).statusCode).toBe(204);
      // Second delete: the row count decides, so it is a 404 not a silent success.
      expect((await req('DELETE', `/members/me/addresses/${temp}`, hers)).statusCode).toBe(404);

      const [row] = await exec(
        sql`SELECT street FROM shop_order WHERE transaction_id = ${txId}`,
      );
      expect(row?.street).toBe('Short Lived');
    });
  });

  // ==================================================================
  // THREE STATUSES, FORWARD ONLY.
  // ==================================================================
  describe('preparing → ready → closed', () => {
    let txId = '';

    beforeAll(async () => {
      const res = await req('POST', '/orders', hers, {
        items: [{ productId: PRODUCT, qty: 1 }],
        fulfilment: 'delivery',
        addressId,
      });
      txId = JSON.parse(res.body).transaction.id as string;
    });

    const patch = (status: string, token = manager) =>
      req('PATCH', `/v1/salons/${SALON}/orders/${txId}`, token, { status });

    it('a new order starts at preparing, and she can see it', async () => {
      const mine = await req('GET', '/members/me/orders', hers);
      expect(mine.statusCode).toBe(200);
      const row = (JSON.parse(mine.body).items as Array<{ transactionId: string; status: string }>)
        .find((o) => o.transactionId === txId);
      expect(row?.status).toBe('preparing');
    });

    it('perms.shop is enforced — a frontdesk holder cannot move it', async () => {
      expect((await patch('ready', frontdesk)).statusCode).toBe(403);
      expect(
        (await req('GET', `/v1/salons/${SALON}/orders`, frontdesk)).statusCode,
      ).toBe(403);
    });

    it('preparing → ready, then ready → closed', async () => {
      const ready = await patch('ready');
      expect(ready.statusCode, ready.body).toBe(200);
      expect(JSON.parse(ready.body).order.status).toBe('ready');
      expect(JSON.parse(ready.body).order.readyAt).not.toBeNull();

      const closed = await patch('closed');
      expect(closed.statusCode, closed.body).toBe(200);
      expect(JSON.parse(closed.body).order.status).toBe('closed');
      // `ready_at` is KEPT, so a closed order still records when it was ready.
      expect(JSON.parse(closed.body).order.readyAt).not.toBeNull();
    });

    it('it never goes backwards, and a repeat is a 409 rather than a silent success', async () => {
      const back = await patch('ready');
      expect(back.statusCode).toBe(409);
      expect(JSON.parse(back.body).error).toBe('order_status_not_reachable');
      expect(JSON.parse(back.body).status).toBe('closed');
    });

    it('skipping a step is refused', async () => {
      const res = await req('POST', '/orders', hers, {
        items: [{ productId: PRODUCT, qty: 1 }],
        fulfilment: 'pickup',
      });
      const fresh = JSON.parse(res.body).transaction.id as string;
      const skip = await req('PATCH', `/v1/salons/${SALON}/orders/${fresh}`, manager, {
        status: 'closed',
      });
      expect(skip.statusCode).toBe(409);
    });

    it('there is no fourth status to move to', async () => {
      for (const bad of ['preparing', 'delivered', 'cancelled', '']) {
        const res = await req('PATCH', `/v1/salons/${SALON}/orders/${txId}`, manager, {
          status: bad,
        });
        expect(res.statusCode, bad).toBe(400);
      }
    });

    it('an order at another salon is a 404, not a 403', async () => {
      const res = await req('PATCH', `/v1/salons/${SALON}/orders/TX-does-not-exist`, manager, {
        status: 'ready',
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error).toBe('unknown_order');
    });

    it('the board carries the delivery address and says whether it is truncated', async () => {
      const res = await req('GET', `/v1/salons/${SALON}/orders?status=closed`, manager);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.truncated).toBe(false);
      const row = (body.items as Array<{ transactionId: string; address: { street: string } | null }>)
        .find((o) => o.transactionId === txId);
      expect(row?.address?.street).toBe('Al Bahar');
    });

    it('an unknown status filter on the board is refused', async () => {
      const res = await req('GET', `/v1/salons/${SALON}/orders?status=delivered`, manager);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('invalid_order_status');
    });
  });
});
