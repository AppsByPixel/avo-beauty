/**
 * SHE CHOOSES WHERE TO COLLECT — migration 0060.
 *
 * The client, verbatim: "on the cart page, Collect it is good, but from which
 * branch if they have multiple". These specs drive the answer through the REAL
 * router, on both doors an order comes through — `POST /orders` (her balance)
 * and `POST /orders/payments` (a card, settled by the gateway read) — and anchor
 * every claim about a row in SQL rather than in the API's own reply.
 *
 * The distinction every spec below respects: the PICKUP branch is hers to choose
 * and the server's to validate; the ATTRIBUTION branch (`transaction.branch_id`)
 * is still the server's, and for a pickup order it is taken from the pickup
 * branch ONLY because a shop order earns nothing per branch. Spec 5 pins that
 * reason, not just the outcome.
 *
 * Fixtures: SAL-AMARA has two open branches, BR-KWC (a seeded 2x visit and +10
 * point top-up BOOST) and BR-SAL (no boost). SAL-LUMIERE supplies foreign ids.
 * A per-run single-branch salon is minted for spec 3.
 *
 * EVERY SPEC THAT CLOSES A BRANCH DOES IT IN A PER-RUN SALON (`MULTI`), NEVER IN
 * SAL-AMARA. A branch cannot be deleted once money names it, so a branch minted in
 * a seeded salon is there for the life of the database — the first draft of this
 * file did exactly that and three report specs (`reportsBranch`, `reportsArtist`,
 * `reportsReconciliation`) then counted eight extra SAL-AMARA branches and 6.000 KD
 * booked to them. `PB-` namespace.
 *
 * AND NOTHING IS WRITTEN AT SAL-LUMIERE. It is named only as a FOREIGN branch
 * id to be refused, which writes no row: `metrics.int.test.ts` asserts that
 * salon holds only its own `IT-*` transactions, and the first draft's tenancy
 * spec placed an order there and turned it red. The second tenant for spec 6 is
 * `MULTI`, which is this run's own.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const SALON = 'SAL-AMARA';
const KWC = 'BR-KWC';
const SAL = 'BR-SAL';
const MANAGER = 'ST-001';
const LUM_HAW = 'BR-LUM-HAW';
const LUM_JAB = 'BR-LUM-JAB';

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const id = (tag: string) => `PB-${tag}-${RUN}`;

const PRODUCT = id('PR'); // 3.000 KD at SAL-AMARA
const SOLO = id('SALON'); // one branch
const SOLO_BRANCH = id('BR-SOLO');
const SOLO_PRODUCT = id('PR-SOLO');
/** Two open branches to start, and every closure spec's own extra branches. */
const MULTI = id('SALON-MULTI');
const MULTI_A = id('BR-MA');
const MULTI_B = id('BR-MB');
const MULTI_PRODUCT = id('PR-MULTI'); // 3.000 KD
const MULTI_STAFF = id('ST-MULTI');

interface PickupBranch {
  id: string;
  name: string;
  nameAr: string | null;
  closed: boolean;
}
interface BoardItem {
  transactionId: string;
  fulfilment: string;
  pickupBranch: PickupBranch | null;
  [k: string]: unknown;
}

suite('she chooses which branch to collect from', () => {
  let app: FastifyInstance;
  let db: (typeof import('../db/client'))['db'];
  let sql: (typeof import('drizzle-orm'))['sql'];
  let issue: (typeof import('../auth/sessions'))['issueSession'];
  const token: Record<string, string> = {};
  let manager = '';
  let multiManager = '';

  const exec = async (q: unknown) =>
    (await db.execute(q as never)) as unknown as Array<Record<string, unknown>>;
  const one = async (q: unknown) => (await exec(q))[0] ?? {};

  async function customer(tag: string, salonId = SALON): Promise<string> {
    const mid = id(`M-${tag}`);
    await exec(sql`
      INSERT INTO member (id, salon_id, name, phone, password_hash, balance_fils, tier, visits, policy_version)
      VALUES (${mid}, ${salonId}, ${`PB Int ${tag}`},
              ${`+9656${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`},
              '$argon2id$fake-not-a-credential', 50000, 'silver', 5, 3)`);
    token[mid] = (
      await issue(db, { principalKind: 'member', memberId: mid, salonId, scope: 'wallet' })
    ).accessToken;
    return mid;
  }

  const call = async (
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    bearer: string,
    payload?: unknown,
  ) => {
    const res = await app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${bearer}`,
        ...(method === 'POST' ? { 'idempotency-key': `pb-${randomUUID()}` } : {}),
      },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    return { status: res.statusCode, body: JSON.parse(res.body || '{}') as Record<string, any> };
  };

  const order = (who: string, extra: Record<string, unknown> = {}, product = PRODUCT) =>
    call('POST', '/orders', token[who] as string, { items: [{ productId: product, qty: 1 }], ...extra });

  const board = async (bearer = manager, salonId = SALON) => {
    const res = await call('GET', `/v1/salons/${salonId}/orders`, bearer);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.items as BoardItem[];
  };
  const hers = async (who: string) => {
    const res = await call('GET', '/members/me/orders', token[who] as string);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.items as BoardItem[];
  };

  /** Her money and her rows, at one instant, from the tables. */
  async function money(mid: string) {
    const r = await one(sql`
      SELECT
        (SELECT balance_fils FROM member WHERE id = ${mid})::bigint                          AS balance,
        (SELECT visits FROM member WHERE id = ${mid})::int                                    AS visits,
        (SELECT count(*) FROM "transaction" WHERE member_id = ${mid} AND kind = 'topup')::int AS topups,
        (SELECT count(*) FROM "transaction" WHERE member_id = ${mid} AND kind = 'shop')::int  AS shops,
        (SELECT count(*) FROM shop_order WHERE member_id = ${mid})::int                       AS orders,
        (SELECT coalesce(sum(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)
           FROM ledger_entry WHERE member_id = ${mid} AND account = 'member_wallet')::bigint  AS wallet_ledger`);
    return {
      balance: Number(r.balance),
      visits: Number(r.visits),
      topups: Number(r.topups),
      shops: Number(r.shops),
      orders: Number(r.orders),
      walletLedger: Number(r.wallet_ledger),
    };
  }

  const orderRow = (txId: string) =>
    one(sql`
      SELECT o.pickup_branch_id, o.fulfilment, t.branch_id, t.branch_assumed
        FROM shop_order o JOIN "transaction" t ON t.id = o.transaction_id
       WHERE o.transaction_id = ${txId}`);

  /** A fresh open branch of the per-run MULTI salon — never of a seeded one. */
  async function extraBranch(tag: string): Promise<string> {
    const bid = id(`BR-${tag}`);
    await exec(sql`INSERT INTO branch (id, salon_id, name) VALUES (${bid}, ${MULTI}, ${`PB ${tag} ${RUN}`})`);
    return bid;
  }

  async function staff(sid: string, salonId: string): Promise<string> {
    await exec(sql`
      INSERT INTO staff_user
        (id, salon_id, name, handle, role, branch_access_all, branch_access_ids,
         password_hash, perm_dashboard, perm_appointments, perm_shop, perm_loyalty,
         perm_team, perm_scanner, perm_charges, perm_void, perm_marketing)
      VALUES (${sid}, ${salonId}, ${`PB Mgr ${sid}`}, ${sid.toLowerCase()},
              'manager', true, '{}', 'x', true, true, true, true, true, true, true, true, true)`);
    return (await issue(db, { principalKind: 'staff', staffId: sid, salonId, scope: 'dashboard' }))
      .accessToken;
  }

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    sql = (await import('drizzle-orm')).sql;
    issue = (await import('../auth/sessions')).issueSession;
    app = await (await import('../app')).buildApp();

    await exec(sql`
      INSERT INTO product (id, salon_id, name, price_fils, active)
      VALUES (${PRODUCT}, ${SALON}, ${`PB Serum ${RUN}`}, 3000, true)`);

    // A salon with exactly one branch — the common case.
    await exec(sql`
      INSERT INTO salon (id, name, brand_color, loyalty_mode, stamp_target, stamp_reward,
                         deposit_fils, business_hours, module_shop)
      VALUES (${SOLO}, ${`PB Solo ${RUN}`}, '#7A5C8E', 'stamps', 6, 'free blow-dry', 5000,
              '{}'::jsonb, true)`);
    await exec(sql`INSERT INTO branch (id, salon_id, name) VALUES (${SOLO_BRANCH}, ${SOLO}, 'Only')`);
    await exec(sql`
      INSERT INTO product (id, salon_id, name, price_fils, active)
      VALUES (${SOLO_PRODUCT}, ${SOLO}, ${`PB Solo Serum ${RUN}`}, 1500, true)`);

    // A multi-branch salon of this run's own, for everything that closes a branch.
    await exec(sql`
      INSERT INTO salon (id, name, brand_color, loyalty_mode, stamp_target, stamp_reward,
                         deposit_fils, business_hours, module_shop)
      VALUES (${MULTI}, ${`PB Multi ${RUN}`}, '#7A5C8E', 'stamps', 6, 'free blow-dry', 5000,
              '{}'::jsonb, true)`);
    await exec(sql`
      INSERT INTO branch (id, salon_id, name) VALUES
        (${MULTI_A}, ${MULTI}, 'Multi A'), (${MULTI_B}, ${MULTI}, 'Multi B')`);
    await exec(sql`
      INSERT INTO product (id, salon_id, name, price_fils, active)
      VALUES (${MULTI_PRODUCT}, ${MULTI}, ${`PB Multi Serum ${RUN}`}, 3000, true)`);
    multiManager = await staff(MULTI_STAFF, MULTI);

    manager = (
      await issue(db, { principalKind: 'staff', staffId: MANAGER, salonId: SALON, scope: 'dashboard' })
    ).accessToken;
  });

  afterAll(async () => {
    await app?.close();
  });

  // ================================================================ 1 ==
  it('1. a pickup at the branch she chose is stored on the fulfilment row and served on the merchant board AND her own read', async () => {
    const who = await customer('STORE');
    const placed = await order(who, { fulfilment: 'pickup', pickupBranchId: SAL });
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    const txId = placed.body.transaction.id as string;

    // The row, in SQL.
    expect((await orderRow(txId)).pickup_branch_id).toBe(SAL);

    // The answer she is given at checkout names it.
    // Exact, so a field added to the pickup shape has to be named here. Since
    // migration 0063 that includes WHEN she can collect and in which zone —
    // SAL-AMARA's Salmiya has no override, so it is the salon's hours.
    expect(placed.body.pickupBranch).toEqual({
      id: SAL,
      name: 'Salmiya',
      nameAr: expect.any(String),
      closed: false,
      businessHours: {
        morning: [expect.any(String), expect.any(String)],
        evening: [expect.any(String), expect.any(String)],
      },
      businessHoursSource: 'salon',
      timezone: 'Asia/Kuwait',
    });

    // The board — where the salon has to act on it.
    const onBoard = (await board()).find((o) => o.transactionId === txId);
    expect(onBoard?.pickupBranch).toMatchObject({ id: SAL, name: 'Salmiya', closed: false });

    // Her own read.
    const mine = (await hers(who)).find((o) => o.transactionId === txId);
    expect(mine?.pickupBranch).toMatchObject({ id: SAL, name: 'Salmiya', closed: false });

    // And the salon's audit log says which counter, not just "to collect".
    const audit = await one(sql`
      SELECT detail FROM audit_log WHERE subject_id = ${txId} AND action = 'Shop order paid'`);
    expect(String(audit.detail)).toContain('to collect at Salmiya');
  });

  // ================================================================ 2 ==
  describe('2. refused with a reason she can read, and nothing moves', () => {
    it("2a. another salon's branch is refused — and is indistinguishable from a branch that does not exist", async () => {
      const who = await customer('FOREIGN');
      const before = await money(who);
      const foreign = await order(who, { pickupBranchId: LUM_HAW });
      const nonsense = await order(who, { pickupBranchId: id('BR-NOPE') });
      expect(foreign.status, JSON.stringify(foreign.body)).toBe(404);
      expect(foreign.body.error).toBe('unknown_pickup_branch');
      // Same status, same code, same sentence: no enumeration oracle.
      expect({ s: nonsense.status, b: nonsense.body }).toEqual({ s: foreign.status, b: foreign.body });
      expect(await money(who)).toEqual(before);
    });

    it('2b. a closed branch of her own salon is refused as closed', async () => {
      const who = await customer('CLOSED', MULTI);
      const shut = await extraBranch('SHUT');
      await exec(sql`UPDATE branch SET closed_at = now() WHERE id = ${shut}`);
      const before = await money(who);
      const res = await order(who, { pickupBranchId: shut }, MULTI_PRODUCT);
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(JSON.stringify(res.body)).toContain('pickup_branch_closed');
      expect(JSON.stringify(res.body)).toContain('no longer taking pickups');
      expect(await money(who)).toEqual(before);
    });

    it('2c. a pickup branch on a delivery order is refused, not ignored — on both doors', async () => {
      const who = await customer('DELIV');
      const made = await call('POST', '/members/me/addresses', token[who] as string, {
        label: 'Home', block: '4', street: 'Al Bahar', building: '12',
      });
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      const addressId = made.body.address.id as string;
      const before = await money(who);

      const wallet = await order(who, { fulfilment: 'delivery', addressId, pickupBranchId: SAL });
      expect(wallet.status, JSON.stringify(wallet.body)).toBe(400);
      expect(JSON.stringify(wallet.body)).toContain('pickup_branch_not_for_delivery');

      const card = await call('POST', '/orders/payments', token[who] as string, {
        items: [{ productId: PRODUCT, qty: 1 }], fulfilment: 'delivery', addressId, pickupBranchId: SAL, method: 'knet',
      });
      expect(card.status, JSON.stringify(card.body)).toBe(400);
      expect(JSON.stringify(card.body)).toContain('pickup_branch_not_for_delivery');
      expect(await money(who)).toEqual(before);

      // Without it, the same delivery is fine and carries no pickup branch.
      const ok = await order(who, { fulfilment: 'delivery', addressId });
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
      expect(ok.body.pickupBranch).toBeNull();
      expect((await orderRow(ok.body.transaction.id)).pickup_branch_id).toBeNull();
    });

    it('2d. at a multi-branch salon, a pickup that names no branch is refused — the server does not pick one for her', async () => {
      const who = await customer('NOCHOICE');
      const before = await money(who);
      const res = await order(who, { fulfilment: 'pickup' });
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(JSON.stringify(res.body)).toContain('pickup_branch_required');
      expect(await money(who)).toEqual(before);
    });

    it("2e. `branchId` is still the attribution field, and is still refused by name", async () => {
      const who = await customer('ATTRIB');
      const res = await order(who, { branchId: SAL });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('branch_not_client_supplied');
    });

    it('2f. the schema refuses what the code refuses: a foreign branch (composite FK) and a pickup branch on a delivery (CHECK)', async () => {
      const who = await customer('SCHEMA');
      const pickup = await order(who, { pickupBranchId: SAL });
      expect(pickup.status).toBe(201);
      await expect(
        exec(sql`UPDATE shop_order SET pickup_branch_id = ${LUM_HAW} WHERE transaction_id = ${pickup.body.transaction.id}`),
      ).rejects.toThrow(/shop_order_pickup_branch_same_salon_fk/);
      await expect(
        exec(sql`UPDATE shop_order SET fulfilment = 'delivery', block = '1', street = 's', building = 'b'
                  WHERE transaction_id = ${pickup.body.transaction.id}`),
      ).rejects.toThrow(/shop_order_pickup_branch_only_on_pickup/);
    });
  });

  // ================================================================ 3 ==
  it('3. a single-branch salon needs nothing from the client: no branch sent, the only branch is used and served', async () => {
    const who = await customer('SOLO', SOLO);
    const placed = await order(who, { fulfilment: 'pickup' }, SOLO_PRODUCT);
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    const txId = placed.body.transaction.id as string;
    expect(placed.body.pickupBranch).toMatchObject({ id: SOLO_BRANCH, name: 'Only', closed: false });
    const row = await orderRow(txId);
    expect(row.pickup_branch_id).toBe(SOLO_BRANCH);
    // And omitting `fulfilment` altogether — an old client — is the same pickup.
    const legacy = await call('POST', '/orders', token[who] as string, { items: [{ productId: SOLO_PRODUCT, qty: 1 }] });
    expect(legacy.status, JSON.stringify(legacy.body)).toBe(201);
    expect((await orderRow(legacy.body.transaction.id)).pickup_branch_id).toBe(SOLO_BRANCH);
    expect((await hers(who)).every((o) => o.pickupBranch?.id === SOLO_BRANCH)).toBe(true);
  });

  // ================================================================ 4 ==
  describe('4. the card-paid path carries the pickup branch through settlement', () => {
    it('4a. paid by card at the branch she chose: placed there, and her own read and the board say so', async () => {
      const who = await customer('CARD');
      const opened = await call('POST', '/orders/payments', token[who] as string, {
        items: [{ productId: PRODUCT, qty: 1 }], fulfilment: 'pickup', pickupBranchId: SAL, method: 'knet',
      });
      expect(opened.status, JSON.stringify(opened.body)).toBe(201);
      const intentId = opened.body.intent.id as string;
      const stored = await one(sql`SELECT order_request FROM topup_intent WHERE id = ${intentId}`);
      expect((stored.order_request as Record<string, unknown>).pickupBranchId).toBe(SAL);

      const settled = await call('GET', `/orders/payments/${intentId}`, token[who] as string);
      expect(settled.body.order?.status, JSON.stringify(settled.body)).toBe('placed');
      const txId = settled.body.order.transactionId as string;
      expect((await orderRow(txId)).pickup_branch_id).toBe(SAL);
      expect(settled.body.order.result.pickupBranch).toMatchObject({ id: SAL });
      expect((await board()).find((o) => o.transactionId === txId)?.pickupBranch?.id).toBe(SAL);
      expect((await hers(who)).find((o) => o.transactionId === txId)?.pickupBranch?.id).toBe(SAL);
    });

    it('4b. the pre-flight refuses a foreign or closed branch BEFORE the card is charged', async () => {
      const who = await customer('CARD-PRE', MULTI);
      const shut = await extraBranch('PRE');
      await exec(sql`UPDATE branch SET closed_at = now() WHERE id = ${shut}`);
      for (const [pickupBranchId, code] of [
        [LUM_JAB, 'unknown_pickup_branch'],
        [shut, 'pickup_branch_closed'],
      ] as const) {
        const res = await call('POST', '/orders/payments', token[who] as string, {
          items: [{ productId: MULTI_PRODUCT, qty: 1 }], pickupBranchId, method: 'knet',
        });
        expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
        expect(JSON.stringify(res.body)).toContain(code);
      }
      const intents = await one(sql`SELECT count(*)::int AS n FROM topup_intent WHERE member_id = ${who}`);
      expect(Number(intents.n)).toBe(0);
    });

    it('4c. THE RACE — her branch closed while she was on the hosted page: no order, no orphan fulfilment row, the credit kept', async () => {
      /**
       * `resolvePickupBranch` runs in step 5b, AFTER the debit in 5a, so this
       * refusal fires with the wallet already debited inside the settlement.
       * Only the savepoint in `placeAttachedOrder` stands between that and a
       * debit with no order — the 3d case in orderPayment.int.test.ts, reached
       * through the pickup branch instead of the address.
       */
      const who = await customer('CARD-RACE', MULTI);
      const soon = await extraBranch('RACE');
      const before = await money(who);
      const opened = await call('POST', '/orders/payments', token[who] as string, {
        items: [{ productId: MULTI_PRODUCT, qty: 1 }], fulfilment: 'pickup', pickupBranchId: soon, method: 'knet',
      });
      expect(opened.status, JSON.stringify(opened.body)).toBe(201);
      const intentId = opened.body.intent.id as string;

      const closed = await call('DELETE', `/salons/${MULTI}/branches/${soon}`, multiManager);
      expect(closed.status, JSON.stringify(closed.body)).toBe(200);

      const settled = await call('GET', `/orders/payments/${intentId}`, token[who] as string);
      expect(settled.body.order?.status, JSON.stringify(settled.body)).toBe('refused');
      expect(settled.body.order.refusal.code).toBe('pickup_branch_closed');

      const credit = Number((await one(sql`SELECT credit_fils FROM topup_intent WHERE id = ${intentId}`)).credit_fils);
      expect(credit).toBeGreaterThan(0);
      const after = await money(who);
      expect(after).toMatchObject({
        balance: before.balance + credit,
        topups: 1,
        shops: 0,
        orders: 0, // no orphan fulfilment row
        visits: before.visits,
      });
      expect(after.walletLedger - before.walletLedger).toBe(credit);
      const orphans = await one(sql`
        SELECT count(*)::int AS n FROM shop_order WHERE pickup_branch_id = ${soon}`);
      expect(Number(orphans.n)).toBe(0);
    });
  });

  // ================================================================ 5 ==
  describe('5. attribution', () => {
    it('5a. a pickup order is ATTRIBUTED to the branch she collects from, established — safe only because a shop order earns no per-branch boost', async () => {
      const who = await customer('ATTR-SAL');
      // BR-SAL, not BR-KWC: BR-KWC sorts first, so the old alphabetical
      // resolution would have produced it too and this spec could not tell.
      const placed = await order(who, { pickupBranchId: SAL });
      expect(placed.status, JSON.stringify(placed.body)).toBe(201);
      const row = await orderRow(placed.body.transaction.id);
      expect(row).toMatchObject({ branch_id: SAL, branch_assumed: false, pickup_branch_id: SAL });
      expect(placed.body.transaction.branchId).toBe(SAL);
    });

    it("5b. …and choosing the BOOSTED branch buys her nothing: BR-KWC's seeded 2x visit boost pays one visit on a wallet order, and its +10 point top-up boost adds nothing to a card order's bonus", async () => {
      const boosted = await one(sql`SELECT visit, topup FROM boost WHERE salon_id = ${SALON} AND branch_id = ${KWC}`);
      // Precondition, or the rest proves nothing.
      expect(Number(boosted.visit)).toBeGreaterThan(1);
      expect(Number(boosted.topup)).toBeGreaterThan(0);

      const who = await customer('ATTR-KWC');
      const before = await money(who);
      const placed = await order(who, { pickupBranchId: KWC });
      expect(placed.status, JSON.stringify(placed.body)).toBe(201);
      expect((await orderRow(placed.body.transaction.id)).branch_id).toBe(KWC);
      expect((await money(who)).visits).toBe(before.visits + 1);

      const card = await call('POST', '/orders/payments', token[who] as string, {
        items: [{ productId: PRODUCT, qty: 1 }], pickupBranchId: KWC, method: 'knet',
      });
      expect(card.status, JSON.stringify(card.body)).toBe(201);
      // Silver is 10%: 3000 → 300 bonus, and nothing for the branch she named.
      expect(card.body.intent.bonusFils).toBe(300);
    });

    it('5c. a delivery keeps the server-resolved attribution, marked assumed at a multi-branch salon', async () => {
      const who = await customer('ATTR-DEL');
      const made = await call('POST', '/members/me/addresses', token[who] as string, {
        label: 'Home', block: '4', street: 'Al Bahar', building: '12',
      });
      const placed = await order(who, { fulfilment: 'delivery', addressId: made.body.address.id });
      expect(placed.status, JSON.stringify(placed.body)).toBe(201);
      expect(await orderRow(placed.body.transaction.id)).toMatchObject({
        branch_id: KWC,
        branch_assumed: true,
        pickup_branch_id: null,
      });
    });
  });

  // ================================================================ 6 ==
  it("6. TENANCY: salon B's board never shows salon A's pickup branch, and salon A's never shows B's", async () => {
    const amara = await customer('TEN-A');
    const other = await customer('TEN-B', MULTI);
    const a = await order(amara, { pickupBranchId: SAL });
    const b = await order(other, { pickupBranchId: MULTI_A }, MULTI_PRODUCT);
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(b.status, JSON.stringify(b.body)).toBe(201);

    // She cannot name the other salon's branch in either direction.
    const crossA = await order(amara, { pickupBranchId: MULTI_A });
    const crossB = await order(other, { pickupBranchId: SAL }, MULTI_PRODUCT);
    expect([crossA.body.error, crossB.body.error]).toEqual(['unknown_pickup_branch', 'unknown_pickup_branch']);

    const amaraBranches = new Set([KWC, SAL]);
    const bBoard = await board(multiManager, MULTI);
    expect(bBoard.find((o) => o.transactionId === b.body.transaction.id)?.pickupBranch?.id).toBe(MULTI_A);
    expect(bBoard.some((o) => o.transactionId === a.body.transaction.id)).toBe(false);
    expect(bBoard.some((o) => o.pickupBranch && amaraBranches.has(o.pickupBranch.id))).toBe(false);

    const aBoard = await board();
    expect(aBoard.some((o) => o.transactionId === b.body.transaction.id)).toBe(false);
    expect(aBoard.some((o) => o.pickupBranch && !amaraBranches.has(o.pickupBranch.id))).toBe(false);

    // And B's manager cannot read A's board by naming it.
    const cross = await call('GET', `/v1/salons/${SALON}/orders`, multiManager);
    expect(cross.status).toBeGreaterThanOrEqual(403);
  });

  // ================================================================ Q2 ==
  it('Q2. a branch that closes with an order still waiting: the order stays on the board marked closed, and the close warned her first', async () => {
    const who = await customer('CLOSE-WAIT', MULTI);
    const doomed = await extraBranch('DOOMED');
    const placed = await order(who, { pickupBranchId: doomed }, MULTI_PRODUCT);
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    const txId = placed.body.transaction.id as string;

    const preview = await call('GET', `/salons/${MULTI}/branches/${doomed}/closure-preview`, multiManager);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.pickupOrdersWaiting).toBe(1);

    const closed = await call('DELETE', `/salons/${MULTI}/branches/${doomed}`, multiManager);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.pickupOrdersWaiting).toBe(1);

    const onBoard = (await board(multiManager, MULTI)).find((o) => o.transactionId === txId);
    expect(onBoard?.pickupBranch).toMatchObject({ id: doomed, closed: true });
    expect((await hers(who)).find((o) => o.transactionId === txId)?.pickupBranch).toMatchObject({
      id: doomed,
      closed: true,
    });

    // Still movable along its lifecycle — the close did not strand it.
    const ready = await app.inject({
      method: 'PATCH',
      url: `/v1/salons/${MULTI}/orders/${txId}`,
      headers: { authorization: `Bearer ${multiManager}` },
      payload: { status: 'ready' },
    });
    expect(ready.statusCode, ready.body).toBe(200);
    expect(JSON.parse(ready.body).order.pickupBranch).toMatchObject({ id: doomed, closed: true });
  });
});
