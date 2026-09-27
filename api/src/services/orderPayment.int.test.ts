/**
 * A SHOP ORDER PAID BY CARD — the money paths, driven. Client ask 2.
 * `services/orderPayment.ts` carries the design; `services/topup.ts §
 * placeAttachedOrder` carries the race. CLAUDE.md § How to work: "Test the money
 * paths… the concurrency cases (double scan, double submit, gateway retry) need
 * automated tests before launch." These are those tests for this path.
 *
 * Every spec runs the REAL router and the REAL sandbox gateway: `POST
 * /orders/payments` opens the intent through `openIntent`, and the settlement is
 * reached the three ways production reaches it — her return (`GET
 * /orders/payments/{id}`, a gateway read), the PSP's webhook
 * (`settleFromWebhook`, called as `routes/webhooks.ts` calls it after the
 * signature check), and both at once.
 *
 * Every money assertion is anchored in SQL on this lane's database, not in the
 * API's own reply — LANES.md's rule, and the only honest way to say "no loss".
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const SALON = 'SAL-AMARA';
const OTHER_SALON = 'SAL-LUMIERE';

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const id = (tag: string) => `OP-${tag}-${RUN}`;

const SERUM = id('PR-SERUM'); // 4.500 KD
const SCRUNCHIE = id('PR-SCRUN'); // 2.250 KD
const LUMIERE_PRODUCT = id('PR-LUM'); // another salon's

interface View {
  intent: {
    id: string;
    amountFils: number;
    bonusFils: number;
    creditFils: number;
    status: string;
    redirectUrl: string;
    method: string;
    [k: string]: unknown;
  };
  order: {
    status: 'awaiting_payment' | 'not_paid' | 'placed' | 'refused';
    transactionId: string | null;
    refusal: { code: string; message: string } | null;
    result: Record<string, unknown> | null;
  };
}

suite('a shop order paid by card', () => {
  let app: FastifyInstance;
  let db: (typeof import('../db/client'))['db'];
  let sql: (typeof import('drizzle-orm'))['sql'];
  let issueSession: (typeof import('../auth/sessions'))['issueSession'];
  let topup: typeof import('./topup');
  let sandbox: NonNullable<ReturnType<(typeof import('../gateway'))['sandboxGateway']>>;
  const token: Record<string, string> = {};

  const exec = async (q: unknown) =>
    (await db.execute(q as never)) as unknown as Array<Record<string, unknown>>;
  const one = async (q: unknown) => (await exec(q))[0] ?? {};

  /** A silver customer (10% top-up bonus) with a zero balance and a session. */
  async function customer(tag: string, salonId = SALON): Promise<string> {
    const mid = id(`M-${tag}`);
    await exec(sql`
      INSERT INTO member (id, salon_id, name, phone, password_hash, balance_fils, tier, visits, policy_version)
      VALUES (${mid}, ${salonId}, ${`OP Int ${tag}`},
              ${`+9655${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`},
              '$argon2id$fake-not-a-credential', 0, 'silver', 5, 3)`);
    token[mid] = (
      await issueSession(db, { principalKind: 'member', memberId: mid, salonId, scope: 'wallet' })
    ).accessToken;
    return mid;
  }

  const start = async (
    who: string,
    payload: Record<string, unknown>,
    opts: { key?: string; scenario?: string } = {},
  ) => {
    const res = await app.inject({
      method: 'POST',
      url: '/orders/payments',
      headers: {
        authorization: `Bearer ${token[who]}`,
        'idempotency-key': opts.key ?? `op-${randomUUID()}`,
        ...(opts.scenario ? { 'x-avo-scenario': opts.scenario } : {}),
      },
      payload,
    });
    return { status: res.statusCode, body: JSON.parse(res.body) as View & Record<string, unknown> };
  };

  const read = async (who: string, intentId: string, scenario?: string) => {
    const res = await app.inject({
      method: 'GET',
      url: `/orders/payments/${intentId}`,
      headers: {
        authorization: `Bearer ${token[who]}`,
        ...(scenario ? { 'x-avo-scenario': scenario } : {}),
      },
    });
    return { status: res.statusCode, body: JSON.parse(res.body) as View & Record<string, unknown> };
  };

  /** Her money, read at one instant, from the tables — never from the API. */
  async function money(mid: string) {
    const r = await one(sql`
      SELECT
        (SELECT balance_fils FROM member WHERE id = ${mid})::bigint                         AS balance,
        (SELECT count(*) FROM "transaction" WHERE member_id = ${mid} AND kind = 'topup')::int AS topups,
        (SELECT count(*) FROM "transaction" WHERE member_id = ${mid} AND kind = 'shop')::int  AS shops,
        (SELECT count(*) FROM shop_order WHERE member_id = ${mid})::int                       AS orders,
        (SELECT count(*) FROM ledger_entry WHERE member_id = ${mid})::int                      AS ledger,
        (SELECT coalesce(sum(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)
           FROM ledger_entry WHERE member_id = ${mid} AND account = 'member_wallet')::bigint  AS wallet_ledger`);
    return {
      balance: Number(r.balance),
      topups: Number(r.topups),
      shops: Number(r.shops),
      orders: Number(r.orders),
      ledger: Number(r.ledger),
      walletLedger: Number(r.wallet_ledger),
    };
  }

  const intentRow = (intentId: string) =>
    one(sql`SELECT * FROM topup_intent WHERE id = ${intentId}`);

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    sql = (await import('drizzle-orm')).sql;
    issueSession = (await import('../auth/sessions')).issueSession;
    topup = await import('./topup');
    const gw = (await import('../gateway')).sandboxGateway();
    if (!gw) throw new Error('this suite requires GATEWAY_DRIVER=sandbox');
    sandbox = gw;
    app = await (await import('../app')).buildApp();

    await exec(sql`
      INSERT INTO product (id, salon_id, name, price_fils, active) VALUES
        (${SERUM}, ${SALON}, ${`OP Serum ${RUN}`}, 4500, true),
        (${SCRUNCHIE}, ${SALON}, ${`OP Scrunchie ${RUN}`}, 2250, true),
        (${LUMIERE_PRODUCT}, ${OTHER_SALON}, ${`OP Lumiere ${RUN}`}, 9000, true)`);
  });

  afterAll(async () => {
    // The shop module is the one piece of shared state a spec below flips.
    await exec(sql`UPDATE salon SET module_shop = true WHERE id = ${SALON}`);
    await app?.close();
  });

  // --------------------------------------------------- 1. the happy path --

  it('1. card-paid order: charged the order total, credited, debited, ONE order — balance and ledger by SQL', async () => {
    const who = await customer('HAPPY');
    const before = await money(who);

    const opened = await start(who, {
      items: [
        { productId: SERUM, qty: 2 },
        { productId: SCRUNCHIE, qty: 1 },
      ],
      method: 'knet',
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    // Sized to the order, from the catalogue: 2 × 4500 + 2250.
    expect(opened.body.intent.amountFils).toBe(11250);
    expect(opened.body.intent.status).toBe('redirected');
    expect(opened.body.order).toEqual({
      status: 'awaiting_payment',
      transactionId: null,
      refusal: null,
      result: null,
    });
    // Customer shape: the commission is not on the wire.
    expect(opened.body.intent).not.toHaveProperty('feeFils');

    // Nothing has moved yet.
    expect(await money(who)).toEqual(before);

    const settled = await read(who, opened.body.intent.id);
    expect(settled.body.order.status, JSON.stringify(settled.body)).toBe('placed');
    expect(settled.body.intent.status).toBe('succeeded');

    const row = await intentRow(opened.body.intent.id);
    expect(Number(row.amount_fils)).toBe(11250);
    // Silver: 10% tier bonus, locked at creation, exactly as a top-up.
    expect(Number(row.bonus_fils)).toBe(1125);
    expect(Number(row.credit_fils)).toBe(12375);
    // KNET flat 150 — the merchant's cost, recorded, not deducted from her credit.
    expect(Number(row.fee_fils)).toBe(150);
    expect(row.order_transaction_id).toBe(settled.body.order.transactionId);

    const after = await money(who);
    expect(after).toEqual({
      // 0 + 12375 credited − 11250 debited: the bonus stays in her wallet.
      balance: 1125,
      topups: 1,
      shops: 1,
      orders: 1,
      // Two balanced pairs at least — the top-up posting and the shop posting.
      ledger: after.ledger,
      walletLedger: 1125,
    });
    // One `member_wallet` leg per money movement: the credit, and the debit.
    expect(after.ledger).toBe(2);
    // And every posting over her two transactions balances — both pairs, all legs.
    const legs = await exec(sql`
      SELECT l.transaction_id,
             sum(CASE WHEN l.direction = 'credit' THEN l.amount_fils ELSE 0 END)::bigint AS cr,
             sum(CASE WHEN l.direction = 'debit'  THEN l.amount_fils ELSE 0 END)::bigint AS dr
        FROM ledger_entry l JOIN "transaction" t ON t.id = l.transaction_id
       WHERE t.member_id = ${who}
       GROUP BY l.transaction_id`);
    expect(legs).toHaveLength(2);
    for (const l of legs) expect(Number(l.cr), String(l.transaction_id)).toBe(Number(l.dr));
    // The wallet ledger agrees with the balance column — db:verify's invariant 5.
    expect(after.walletLedger).toBe(after.balance);

    // The shop transaction is a WALLET debit — the money passed through the wallet (#5).
    const shop = await one(sql`
      SELECT amount_fils, method, fee_fils FROM "transaction" WHERE id = ${row.order_transaction_id}`);
    expect(Number(shop.amount_fils)).toBe(-11250);
    expect(shop.method).toBe('wallet');
    expect(Number(shop.fee_fils)).toBe(0);

    // The frozen receipt is what `POST /orders` would have answered.
    expect(settled.body.order.result).toMatchObject({ totalFils: 11250, balanceAfterFils: 1125 });
  });

  it('1b. her existing balance is not touched: the card pays the whole order', async () => {
    const who = await customer('FUNDED');
    // Fund 3.000 by an ordinary top-up first → 3.300 with the silver bonus.
    const t = await app.inject({
      method: 'POST',
      url: '/topups',
      headers: { authorization: `Bearer ${token[who]}`, 'idempotency-key': `op-${randomUUID()}` },
      payload: { amountFils: 3000, method: 'card' },
    });
    await app.inject({
      method: 'GET',
      url: `/topups/${JSON.parse(t.body).id}`,
      headers: { authorization: `Bearer ${token[who]}` },
    });
    expect((await money(who)).balance).toBe(3300);

    const opened = await start(who, { items: [{ productId: SERUM, qty: 1 }], method: 'card' });
    const settled = await read(who, opened.body.intent.id);
    expect(settled.body.order.status).toBe('placed');
    // 3300 + (4500 + 450) − 4500.
    expect((await money(who)).balance).toBe(3750);
    // Card: 2.5% of 4500 + 50 = 162.5 → the commission helper's integer answer.
    const row = await intentRow(opened.body.intent.id);
    expect(Number.isSafeInteger(Number(row.fee_fils))).toBe(true);
  });

  // ------------------------------------- 2. double submit / gateway retry --

  it('2. DOUBLE SUBMIT: one key twice is one intent; one gateway confirmation delivered five ways is ONE credit and ONE order', async () => {
    const who = await customer('DOUBLE');
    const key = `op-double-${randomUUID()}`;
    const payload = { items: [{ productId: SERUM, qty: 1 }], method: 'knet' };

    const [a, b] = await Promise.all([start(who, payload, { key }), start(who, payload, { key })]);
    expect([a.status, b.status].sort()).toEqual([201, 201]);
    expect(a.body.intent.id).toBe(b.body.intent.id);
    const [intents] = await exec(
      sql`SELECT count(*)::int AS n FROM topup_intent WHERE member_id = ${who}`,
    );
    expect(intents?.n).toBe(1);

    const intentId = a.body.intent.id;
    const psp = String((await intentRow(intentId)).psp_reference);

    /**
     * Her return twice, the PSP's webhook twice under DIFFERENT event ids (a
     * re-delivery the event index alone would not catch), and once more under a
     * REPEATED event id — all at once.
     */
    const hook = (eventId: string) =>
      topup.settleFromWebhook(db, {
        provider: 'sandbox',
        eventId,
        pspReference: psp,
        outcome: 'succeeded',
        reportedStatus: 'PAID',
        amountFils: 4500 as never,
        payload: { eventId },
      });
    const repeated = `evt-${randomUUID()}`;
    const results = await Promise.allSettled([
      read(who, intentId),
      read(who, intentId),
      hook(`evt-${randomUUID()}`),
      hook(`evt-${randomUUID()}`),
      hook(repeated),
      hook(repeated),
    ]);
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);

    const after = await money(who);
    expect(after.topups).toBe(1);
    expect(after.shops).toBe(1);
    expect(after.orders).toBe(1);
    expect(after.balance).toBe(450);
    expect(after.walletLedger).toBe(after.balance);

    const final = await read(who, intentId);
    expect(final.body.order.status).toBe('placed');
  });

  // ---------------------------------------------------------- 3. the race --

  it('3. THE RACE — product retired while she paid: the money is wallet credit, no order, nothing lost', async () => {
    const who = await customer('RACE-RETIRED');
    const doomed = id('PR-DOOMED');
    await exec(sql`
      INSERT INTO product (id, salon_id, name, price_fils, active)
      VALUES (${doomed}, ${SALON}, ${`OP Doomed ${RUN}`}, 6000, true)`);

    const opened = await start(who, { items: [{ productId: doomed, qty: 1 }], method: 'knet' });
    expect(opened.status).toBe(201);

    // While she is on the hosted page, the salon retires it.
    await exec(sql`UPDATE product SET active = false WHERE id = ${doomed}`);

    const settled = await read(who, opened.body.intent.id);
    expect(settled.status).toBe(200);
    expect(settled.body.intent.status).toBe('succeeded');
    expect(settled.body.order.status).toBe('refused');
    expect(settled.body.order.refusal?.code).toBe('invalid_products');
    expect(settled.body.order.transactionId).toBeNull();

    const after = await money(who);
    // 6000 + 10% silver bonus, all of it in her wallet.
    expect(after).toMatchObject({ balance: 6600, topups: 1, shops: 0, orders: 0 });
    expect(after.walletLedger).toBe(6600);

    const audit = await one(sql`
      SELECT action, metadata->>'refusalCode' AS code FROM audit_log
       WHERE subject_type = 'topup_intent' AND subject_id = ${opened.body.intent.id}
         AND action = 'Card-paid order refused'`);
    expect(audit.code).toBe('invalid_products');

    // And the rows the savepoint rolled back are really gone: no lines, no shop receipt.
    const [lines] = await exec(sql`
      SELECT count(*)::int AS n FROM shop_order_line l JOIN "transaction" t ON t.id = l.transaction_id
       WHERE t.member_id = ${who}`);
    expect(lines?.n).toBe(0);
    const kinds = await exec(sql`SELECT DISTINCT payload->>'kind' AS k FROM receipt_job WHERE member_id = ${who}`);
    expect(kinds.map((k) => k.k)).toEqual(['topup']);
  });

  it('3b. THE RACE — the price moved while she paid: refused BEFORE any debit, not debited at a figure she did not pay', async () => {
    const who = await customer('RACE-PRICE');
    const moving = id('PR-MOVING');
    await exec(sql`
      INSERT INTO product (id, salon_id, name, price_fils, active)
      VALUES (${moving}, ${SALON}, ${`OP Moving ${RUN}`}, 5000, true)`);

    const opened = await start(who, { items: [{ productId: moving, qty: 1 }], method: 'knet' });
    await exec(sql`UPDATE product SET price_fils = 4000 WHERE id = ${moving}`);

    const settled = await read(who, opened.body.intent.id);
    expect(settled.body.order.status).toBe('refused');
    expect(settled.body.order.refusal?.code).toBe('price_changed');
    expect(await money(who)).toMatchObject({ balance: 5500, shops: 0, orders: 0 });
  });

  it('3c. THE RACE — the salon switched the shop off while she paid: credit stands, order refused', async () => {
    const who = await customer('RACE-MODULE');
    const opened = await start(who, { items: [{ productId: SCRUNCHIE, qty: 2 }], method: 'applepay' });
    expect(opened.status).toBe(201);

    await exec(sql`UPDATE salon SET module_shop = false WHERE id = ${SALON}`);
    try {
      const settled = await read(who, opened.body.intent.id);
      expect(settled.body.order.status).toBe('refused');
      expect(settled.body.order.refusal?.code).toBe('shop_not_enabled');
    } finally {
      await exec(sql`UPDATE salon SET module_shop = true WHERE id = ${SALON}`);
    }
    expect(await money(who)).toMatchObject({ balance: 4950, shops: 0, orders: 0 });
  });

  it('3d. THE RACE THE SAVEPOINT IS FOR — the delivery address was deleted while she paid: the order refuses AFTER its debit ran, and the debit is rolled back with it', async () => {
    /**
     * The three races above all refuse BEFORE `placeOrder` writes anything, so
     * they would pass with or without the savepoint. This one does not:
     * `placeOrder` debits the wallet in step 5a and resolves the address in step
     * 5b, so a deleted address throws with the debit already applied. Only the
     * savepoint's rollback stands between that and a wallet debited for an order
     * that does not exist.
     */
    const who = await customer('RACE-ADDRESS');
    const made = await app.inject({
      method: 'POST',
      url: '/members/me/addresses',
      headers: { authorization: `Bearer ${token[who]}` },
      payload: { label: 'Home', block: '4', street: 'Salem Al Mubarak St', building: '12', area: 'Salmiya' },
    });
    expect(made.statusCode, made.body).toBe(201);
    const addressId = JSON.parse(made.body).address.id as string;

    const opened = await start(who, {
      items: [{ productId: SERUM, qty: 1 }],
      fulfilment: 'delivery',
      addressId,
      method: 'knet',
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);

    const gone = await app.inject({
      method: 'DELETE',
      url: `/members/me/addresses/${addressId}`,
      headers: { authorization: `Bearer ${token[who]}` },
    });
    expect(gone.statusCode).toBeLessThan(300);

    const settled = await read(who, opened.body.intent.id);
    expect(settled.body.order.status).toBe('refused');
    expect(settled.body.order.refusal?.code).toBe('unknown_address');
    // 4500 + 450, all of it — the debit that ran inside the savepoint did not survive it.
    expect(await money(who)).toMatchObject({ balance: 4950, topups: 1, shops: 0, orders: 0 });
    expect((await money(who)).walletLedger).toBe(4950);
  });

  // ----------------------------------------------- 4. the failed payment leg --

  it('4. a gateway that cannot be reached does NOT burn the key, and places no order', async () => {
    const who = await customer('GWFAIL');
    const key = `op-gwfail-${randomUUID()}`;
    const payload = { items: [{ productId: SERUM, qty: 1 }], method: 'knet' };

    const failed = await start(who, payload, { key, scenario: 'gateway_create_error' });
    expect(failed.status).toBe(502);
    const [none] = await exec(
      sql`SELECT count(*)::int AS n FROM topup_intent WHERE member_id = ${who}`,
    );
    expect(none?.n).toBe(0);
    const [keys] = await exec(sql`SELECT count(*)::int AS n FROM idempotency_key WHERE key = ${key}`);
    expect(keys?.n, 'the failed leg left its key behind').toBe(0);

    // The same key, retried, is a real retry — not a cached 502.
    const retried = await start(who, payload, { key });
    expect(retried.status).toBe(201);
    expect(retried.body.order.status).toBe('awaiting_payment');
    expect(await money(who)).toMatchObject({ balance: 0, topups: 0, shops: 0, orders: 0 });
  });

  it('4b. a DECLINED payment places no order and moves no money', async () => {
    const who = await customer('DECLINED');
    const opened = await start(who, { items: [{ productId: SERUM, qty: 1 }], method: 'card' });
    const declined = await read(who, opened.body.intent.id, 'declined');
    expect(declined.body.intent.status).toBe('failed');
    expect(declined.body.order.status).toBe('not_paid');
    expect(await money(who)).toMatchObject({ balance: 0, topups: 0, shops: 0, orders: 0 });

    // A late "succeeded" after the decline is an illegal transition, not a credit.
    await sandbox.setOutcome(String((await intentRow(opened.body.intent.id)).psp_reference), 'succeeded');
    const again = await read(who, opened.body.intent.id);
    expect(again.body.order.status).toBe('not_paid');
    expect(await money(who)).toMatchObject({ balance: 0, shops: 0, orders: 0 });
  });

  it('4c. the pre-flight refuses BEFORE the card is charged: a retired or foreign product never reaches the gateway', async () => {
    const who = await customer('PREFLIGHT');
    const retired = id('PR-RETIRED');
    await exec(sql`
      INSERT INTO product (id, salon_id, name, price_fils, active)
      VALUES (${retired}, ${SALON}, ${`OP Retired ${RUN}`}, 1000, false)`);
    for (const productId of [retired, LUMIERE_PRODUCT]) {
      const res = await start(who, { items: [{ productId, qty: 1 }], method: 'knet' });
      expect(res.status, productId).toBe(400);
      expect(res.body.error ?? res.body.code).toBe('invalid_products');
    }
    const [n] = await exec(sql`SELECT count(*)::int AS n FROM topup_intent WHERE member_id = ${who}`);
    expect(n?.n).toBe(0);
  });

  // --------------------------------------------------------- 5. integer fils --

  it('5. INTEGER FILS: every money figure on the wire and in the rows is a safe integer; a client price is refused', async () => {
    const who = await customer('FILS');
    const refused = await start(who, {
      items: [{ productId: SERUM, qty: 1 }],
      method: 'knet',
      amountFils: 1,
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error ?? refused.body.code).toBe('price_not_client_supplied');

    // #4: money moves here, so no key is no request.
    const keyless = await app.inject({
      method: 'POST',
      url: '/orders/payments',
      headers: { authorization: `Bearer ${token[who]}` },
      payload: { items: [{ productId: SERUM, qty: 1 }], method: 'knet' },
    });
    expect(keyless.statusCode).toBe(400);
    const [none] = await exec(sql`SELECT count(*)::int AS n FROM topup_intent WHERE member_id = ${who}`);
    expect(none?.n).toBe(0);

    const opened = await start(who, { items: [{ productId: SCRUNCHIE, qty: 3 }], method: 'knet' });
    const settled = await read(who, opened.body.intent.id);
    const figures = [
      settled.body.intent.amountFils,
      settled.body.intent.bonusFils,
      settled.body.intent.creditFils,
      settled.body.order.result?.totalFils,
      settled.body.order.result?.balanceAfterFils,
    ];
    for (const f of figures) expect(Number.isSafeInteger(f), String(f)).toBe(true);
    expect(settled.body.intent.amountFils).toBe(6750);

    const types = await exec(sql`
      SELECT DISTINCT pg_typeof(amount_fils)::text AS t FROM ledger_entry WHERE member_id = ${who}
      UNION SELECT pg_typeof(amount_fils)::text FROM topup_intent WHERE member_id = ${who}`);
    expect(types.map((t) => t.t)).toEqual(['bigint']);
  });

  // --------------------------------------------------------------- tenancy --

  it("TENANCY: another customer's order payment, and an ordinary top-up, are both 404", async () => {
    const owner = await customer('OWNER');
    const other = await customer('OTHER');
    const opened = await start(owner, { items: [{ productId: SERUM, qty: 1 }], method: 'knet' });
    const probe = await read(other, opened.body.intent.id);
    expect(probe.status).toBe(404);
    // Refused by THIS endpoint's own scope, before `readTopUp` is ever reached.
    expect(probe.body.error ?? probe.body.code).toBe('unknown_order_payment');
    // And nothing about her payment moved because somebody else asked.
    expect((await intentRow(opened.body.intent.id)).status).toBe('redirected');

    const t = await app.inject({
      method: 'POST',
      url: '/topups',
      headers: { authorization: `Bearer ${token[owner]}`, 'idempotency-key': `op-${randomUUID()}` },
      payload: { amountFils: 1000, method: 'knet' },
    });
    expect((await read(owner, JSON.parse(t.body).id)).status).toBe(404);
  });
});
