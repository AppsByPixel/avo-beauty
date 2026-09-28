/**
 * `POST /orders/payments` — A NEW WAY FOR MONEY TO MOVE, driven from outside.
 *
 * HOW TO RUN
 *
 *   pnpm --dir /absolute/worktree/api run db:up
 *   cd e2e && ../node_modules/.bin/vitest run order-payment.test.ts
 *
 * WHAT THE ROUTE IS
 * -----------------
 * A shop basket paid by KNET, card or Apple Pay in one step. Lane A built it as a
 * TOP-UP INTENT SIZED TO THE ORDER, with the order attached: `openIntent` is the one
 * door to the gateway, the card money is credited to her wallet exactly as a top-up
 * is, and in the same transaction the order is placed from that credit inside a
 * SAVEPOINT (`services/topup.ts § placeAttachedOrder`). `services/orderPayment.ts`
 * carries the design.
 *
 * WHY THIS FILE EXISTS WHEN `orderPayment.int.test.ts` ALREADY DOES
 * -----------------------------------------------------------------
 * Lane A's int file drives the router in-process with `app.inject` and settles the
 * webhook leg by calling `settleFromWebhook()` directly — the signature check is
 * skipped by construction. That is the right test for lane A and it is a claim about
 * lane A's code by lane A. This file is the independent restatement, the way
 * `gateway.test.ts` restates the top-up round trip:
 *
 *   - a REAL API process on a real port, against this run's own Postgres;
 *   - the money confirmed the three ways production confirms it — the sandbox's
 *     hosted page firing its signed callback over HTTP, a callback this file signs
 *     itself from the documented HMAC construction, and her return
 *     (`GET /orders/payments/{id}`) — and in the double-submit spec all three AT
 *     ONCE, with the overlap measured rather than assumed;
 *   - every money claim anchored in SQL — `member.balance_fils`, the
 *     `member_wallet` ledger, `transaction`, `shop_order` — never in the API's reply.
 *     LANES.md: a server that answers plausibly is not evidence.
 *
 * Nothing is imported from `api/src`.
 *
 * WHAT "NOTHING LOST" MEANS HERE, EXACTLY
 * ---------------------------------------
 * The card is charged `amountFils`, the order total, priced by the server from the
 * catalogue. Her wallet is credited `creditFils` = amount + her tier bonus (the
 * top-up's own economics, argued in `orderPayment.ts § BONUS`). Then:
 *
 *   PLACED    the wallet is debited exactly `amountFils` by exactly one `shop`
 *             transaction, and exactly one order exists. Net: + bonus.
 *   REFUSED   no debit, no order, no order lines. Net: + creditFils — ALL of it,
 *             as wallet credit (#5: nothing goes back to the card).
 *
 * In both cases the `member_wallet` ledger moves by exactly what the balance moved,
 * which is `db:verify` invariant 5 measured across one operation, and every
 * transaction she holds balances across its legs.
 *
 * THE MEMBERS ARE THIS FILE'S OWN, AND NONE OF THEIR BALANCES IS WRITTEN IN SQL
 * -----------------------------------------------------------------------------
 * Cloned from the QA gateway member for the password hash `signInMember` sends.
 * They start at zero with no ledger, and every fil they ever hold arrives through
 * the gateway. So they reconcile by construction, and the wallet census in
 * `global-setup.ts` teardown is an INDEPENDENT second check on this path rather than
 * something this file has to pay off with `reconcileWalletLedger` — calling that
 * here would silently repair exactly the drift a broken card-paid order would leave.
 * The last describe asserts it for every member this file touched.
 *
 * ON A PERSISTENT DATABASE (`POSTGRES_DB`) the clone is `ON CONFLICT … tier` only:
 * the balance is never reset, because a reset is a balance written in SQL. Every
 * figure below is a DELTA measured from a snapshot, for that reason.
 *
 * THE PRODUCTS ARE THIS FILE'S OWN TOO. The race specs retire a product and move a
 * price, and `PR-01` is priced by literal in `orders.test.ts`, `contract.test.ts` and
 * the reports. They are retired in `afterAll` (a product with order lines cannot be
 * deleted, and must not be).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { precondition } from './support/known-bug.js';
import { assertRaced, timed } from './support/race.js';
import {
  GATEWAY_WEBHOOK_SECRET,
  SALON_A,
  SIGNATURE_HEADER,
  apiLogTail,
  nowSeconds,
  psql,
  scalar,
  signCallback,
  signInMember,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

const CLONE_SOURCE = 'QA-GW-0001';

/** One member per concern, so no spec's delta can be moved by another spec's write. */
const M = {
  happy: { id: 'QA-OP-0001', phone: '+96555980001' },
  double: { id: 'QA-OP-0002', phone: '+96555980002' },
  twoKeys: { id: 'QA-OP-0003', phone: '+96555980003' },
  raceAddress: { id: 'QA-OP-0004', phone: '+96555980004' },
  raceRetired: { id: 'QA-OP-0005', phone: '+96555980005' },
  racePrice: { id: 'QA-OP-0006', phone: '+96555980006' },
  /** The tenancy pair: `owner` holds the payment, `stranger` asks about it. */
  owner: { id: 'QA-OP-0007', phone: '+96555980007' },
  stranger: { id: 'QA-OP-0008', phone: '+96555980008' },
} as const;
type Who = keyof typeof M;

/** 4.000 KD. The happy path buys two. */
const PRODUCT = 'PR-QAOP-01';
const PRODUCT_FILS = 4_000;
/** Retired while she is on the hosted page. */
const DOOMED = 'PR-QAOP-DOOMED';
const DOOMED_FILS = 6_000;
/** Repriced while she is on the hosted page — 5.000 → 4.000. */
const MOVING = 'PR-QAOP-MOVING';
const MOVING_FILS = 5_000;
const MOVING_NEW_FILS = 4_000;

/** Silver. Asserted on every intent this file opens rather than assumed. */
const BONUS_PERCENT = 10;

const token: Partial<Record<Who, string>> = {};

let n = 0;
const key = (label: string) => `qaop-${label}-${Date.now()}-${n++}`;
const eventId = (label: string) => `EVT-QAOP-${label}-${Date.now()}-${n++}`;

// ------------------------------------------------------------------- reads --

/**
 * Her money at one instant, from the tables. `walletLedger` is the signed sum of
 * her `member_wallet` legs — the quantity invariant 5 compares to the balance.
 */
interface Money {
  balance: number;
  walletLedger: number;
  topups: number;
  shops: number;
  orders: number;
  lines: number;
  intents: number;
}

function money(who: Who): Money {
  const id = M[who].id;
  const row = scalar(`
    SELECT concat_ws('|',
      (SELECT balance_fils FROM member WHERE id = '${id}'),
      (SELECT coalesce(sum(CASE direction WHEN 'credit' THEN amount_fils ELSE -amount_fils END), 0)
         FROM ledger_entry WHERE member_id = '${id}' AND account = 'member_wallet'),
      (SELECT count(*) FROM "transaction" WHERE member_id = '${id}' AND kind = 'topup'),
      (SELECT count(*) FROM "transaction" WHERE member_id = '${id}' AND kind = 'shop'),
      (SELECT count(*) FROM shop_order WHERE member_id = '${id}'),
      (SELECT count(*) FROM shop_order_line l JOIN "transaction" t ON t.id = l.transaction_id
        WHERE t.member_id = '${id}'),
      (SELECT count(*) FROM topup_intent WHERE member_id = '${id}'))`).trim();
  const [balance, walletLedger, topups, shops, orders, lines, intents] = row.split('|').map(Number);
  return { balance, walletLedger, topups, shops, orders, lines, intents } as Money;
}

function delta(before: Money, after: Money): Money {
  const out = {} as Money;
  for (const k of Object.keys(before) as Array<keyof Money>) out[k] = after[k] - before[k];
  return out;
}

/** What the intent row locked at creation. The card is charged `amount`. */
function intentRow(intentId: string): {
  status: string;
  amount: number;
  bonus: number;
  credit: number;
  orderTx: string;
  refusal: string;
  psp: string;
  settledTx: string;
} {
  const row = scalar(`
    SELECT concat_ws('|', status, amount_fils, bonus_fils, credit_fils,
                     coalesce(order_transaction_id, ''), coalesce(order_refusal_code, ''),
                     coalesce(psp_reference, ''), coalesce(transaction_id, ''))
      FROM topup_intent WHERE id = '${intentId}'`).trim();
  const f = row.split('|');
  precondition(f.length === 8, `no topup_intent row for ${intentId}: "${row}"`);
  const [status, amount, bonus, credit, orderTx, refusal, psp, settledTx] = f as [
    string, string, string, string, string, string, string, string,
  ];
  return {
    status,
    amount: Number(amount),
    bonus: Number(bonus),
    credit: Number(credit),
    orderTx,
    refusal,
    psp,
    settledTx,
  };
}

/**
 * Every transaction she holds balances across its legs — credits equal debits over
 * ALL accounts, not only her wallet. A savepoint that rolled back half a posting
 * would leave a transaction with one leg, and her wallet sum alone cannot see it.
 */
function unbalancedTransactions(who: Who): string[] {
  const out = scalar(`
    SELECT coalesce(string_agg(t.id, ','), '')
      FROM "transaction" t
     WHERE t.member_id = '${M[who].id}'
       AND (SELECT coalesce(sum(CASE direction WHEN 'credit' THEN amount_fils ELSE -amount_fils END), 0)
              FROM ledger_entry WHERE transaction_id = t.id) <> 0`).trim();
  return out === '' ? [] : out.split(',');
}

// ------------------------------------------------------------------ writes --

interface View {
  intent: {
    id: string;
    amountFils: number;
    bonusFils: number;
    creditFils: number;
    status: string;
    redirectUrl: string;
    [k: string]: unknown;
  };
  order: {
    status: 'awaiting_payment' | 'not_paid' | 'placed' | 'refused';
    transactionId: string | null;
    refusal: { code: string; message: string } | null;
    result: Record<string, any> | null;
  };
}

type Basket = { items: Array<{ productId: string; qty: number }>; fulfilment?: string; addressId?: string };

const open = (who: Who, basket: Basket, idemKey = key(`${who}-open`), method = 'knet') =>
  treq<View & { error?: string; message?: string }>('POST', '/orders/payments', {
    token: token[who]!,
    idempotencyKey: idemKey,
    body: { ...basket, method },
  });

const read = (who: Who, intentId: string) =>
  treq<View & { error?: string; message?: string }>('GET', `/orders/payments/${intentId}`, {
    token: token[who]!,
  });

/** The sandbox's hosted page, "she pressed pay" — it fires its own signed callback. */
function hostedPageRef(view: View): string {
  const ref = /\/_gateway\/([^/?#]+)/.exec(view.intent.redirectUrl ?? '')?.[1];
  precondition(!!ref, `no sandbox gateway ref in ${view.intent.redirectUrl}`);
  return ref;
}

const payOnHostedPage = (view: View) =>
  treq<any>('POST', `/_gateway/${hostedPageRef(view)}`, {
    token: null,
    body: { outcome: 'succeeded', notify: true },
  });

/**
 * A callback signed HERE, from the documented construction — not by the API's own
 * helper, so a change to what goes into the MAC is a red and not a quiet agreement.
 */
function deliverSigned(pspReference: string, amountFils: number, id = eventId('cb')) {
  const rawBody = JSON.stringify({ eventId: id, pspReference, status: 'succeeded', amountFils });
  return treq<any>('POST', '/webhooks/sandbox', {
    token: null,
    rawBody,
    headers: { [SIGNATURE_HEADER]: signCallback(rawBody, nowSeconds(), GATEWAY_WEBHOOK_SECRET) },
  });
}

/** Open, assert the money the intent locked is the literal this file prices against. */
async function opened(who: Who, basket: Basket, expectedTotal: number, idemKey?: string) {
  const res = await open(who, basket, idemKey);
  precondition(res.status === 201, `POST /orders/payments for ${who}: ${res.status} ${res.raw}`);
  const bonus = (expectedTotal * BONUS_PERCENT) / 100;
  precondition(
    res.body.intent.amountFils === expectedTotal &&
      res.body.intent.bonusFils === bonus &&
      res.body.intent.creditFils === expectedTotal + bonus,
    `the intent is not the pinned fixture: server said ${res.body.intent.amountFils}+` +
      `${res.body.intent.bonusFils}=${res.body.intent.creditFils}, this file expects ` +
      `${expectedTotal}+${bonus}=${expectedTotal + bonus}. Is ${M[who].id} still silver?`,
  );
  return res.body;
}

async function fundByTopUp(who: Who, amountFils: number): Promise<void> {
  const t = await treq<any>('POST', '/topups', {
    token: token[who]!,
    idempotencyKey: key(`${who}-fund`),
    body: { amountFils, method: 'knet' },
  });
  precondition(t.status === 200, `funding top-up for ${who}: ${t.status} ${t.raw}`);
  const ref = /\/_gateway\/([^/?#]+)/.exec(t.body.redirectUrl ?? '')?.[1];
  precondition(!!ref, `no gateway ref on the funding top-up: ${t.body.redirectUrl}`);
  const paid = await treq<any>('POST', `/_gateway/${ref}`, {
    token: null,
    body: { outcome: 'succeeded', notify: true },
  });
  precondition(paid.status === 200, `funding settle for ${who}: ${paid.status} ${paid.raw}`);
  precondition(
    scalar(`select status from topup_intent where id='${t.body.id}'`).trim() === 'succeeded',
    `the funding top-up for ${who} did not settle`,
  );
}

// ---------------------------------------------------------------- fixtures --

beforeAll(async () => {
  await startTenancyApi();

  for (const who of Object.keys(M) as Who[]) {
    const { id, phone } = M[who];
    psql(`
      INSERT INTO member (id, salon_id, name, phone, email, email_verified, password_hash,
                          balance_fils, visits, tier, stamps, policy_version, notify_wa)
      SELECT '${id}', salon_id, 'Order payment QA ${who}', '${phone}', NULL, false,
             password_hash, 0, 0, 'silver', NULL, policy_version, false
        FROM member WHERE id = '${CLONE_SOURCE}'
      ON CONFLICT (id) DO UPDATE SET tier = 'silver';
    `);
    precondition(
      scalar(`select count(*) from member where id='${id}'`).trim() === '1',
      `the clone source ${CLONE_SOURCE} is missing, so ${who} has no member row`,
    );
  }

  psql(`
    INSERT INTO product (id, salon_id, name, price_fils, active) VALUES
      ('${PRODUCT}', '${SALON_A}', 'QA order-payment serum', ${PRODUCT_FILS}, true),
      ('${DOOMED}',  '${SALON_A}', 'QA order-payment doomed', ${DOOMED_FILS}, true),
      ('${MOVING}',  '${SALON_A}', 'QA order-payment moving', ${MOVING_FILS}, true)
    ON CONFLICT (id) DO UPDATE SET active = true, price_fils = EXCLUDED.price_fils;
  `);
  precondition(
    scalar(`select module_shop from salon where id='${SALON_A}'`).trim() === 't',
    `${SALON_A} has the shop module off, so every payment here would be refused up front`,
  );

  for (const who of Object.keys(M) as Who[]) {
    token[who] = await signInMember(SALON_A, M[who].phone);
  }

  // A balance that is NOT zero, so "the card pays the whole order and her balance is
  // untouched" is a claim about a number rather than about 0. Through the gateway,
  // never in SQL — see the header.
  await fundByTopUp('happy', 5_000);
}, 180_000);

afterAll(async () => {
  // Retired, not deleted — order lines reference them, and the ledger is append-only.
  psql(`UPDATE product SET active = false WHERE id IN ('${PRODUCT}', '${DOOMED}', '${MOVING}');`);
  await stopTenancyApi();
});

// -------------------------------------------------------------- tripwires --

describe('tripwires — the sessions are the members this file thinks they are', () => {
  it('every token resolves to its own member, not the shim principal', async () => {
    for (const who of Object.keys(M) as Who[]) {
      const me = await treq<{ id: string }>('GET', '/members/me', { token: token[who]! });
      expect(me.status, me.raw).toBe(200);
      expect(me.body.id, `${who}'s token resolved to somebody else`).toBe(M[who].id);
    }
  });
});

// ------------------------------------------------------------ happy path --

describe('the happy path — exactly the order total, exactly one order', () => {
  const basket: Basket = { items: [{ productId: PRODUCT, qty: 2 }] };
  const TOTAL = 2 * PRODUCT_FILS;
  let view: View;
  let before: Money;

  it('opening the payment is sized by the catalogue and moves nothing', async () => {
    before = money('happy');
    precondition(before.balance > 0, 'the happy member was not pre-funded');
    view = await opened('happy', basket, TOTAL);

    expect(view.intent.status).toBe('redirected');
    expect(view.order).toEqual({
      status: 'awaiting_payment',
      transactionId: null,
      refusal: null,
      result: null,
    });
    // Commission is merchant-visible, customer-never.
    expect(view.intent).not.toHaveProperty('feeFils');

    expect(delta(before, money('happy')), 'opening a payment moved money').toEqual({
      balance: 0,
      walletLedger: 0,
      topups: 0,
      shops: 0,
      orders: 0,
      lines: 0,
      intents: 1,
    });
  });

  it('the hosted page pays it: the wallet nets +bonus, one shop debit of the total, one order', async () => {
    const paid = await payOnHostedPage(view);
    expect(paid.status, paid.raw).toBe(200);

    const back = await read('happy', view.intent.id);
    expect(back.status, back.raw).toBe(200);
    expect(back.body.intent.status).toBe('succeeded');
    expect(back.body.order.status, back.raw).toBe('placed');

    const row = intentRow(view.intent.id);
    expect(row.status).toBe('succeeded');
    expect(row.amount, 'the card was charged something other than the order total').toBe(TOTAL);
    expect(row.orderTx).toBe(back.body.order.transactionId);

    const moved = delta(before, money('happy'));
    expect(moved, 'a card-paid order moved the wrong amount of money').toEqual({
      // credit (amount + bonus) − the order total: the bonus stays hers.
      balance: row.bonus,
      walletLedger: row.bonus,
      topups: 1,
      shops: 1,
      orders: 1,
      lines: 1,
      intents: 1,
    });

    // The ONE shop debit is exactly the total, from the wallet (#5: the money
    // passed through the wallet, so a later refund is wallet credit).
    const shop = scalar(
      `select concat_ws('|', amount_fils, method, status) from "transaction" where id='${row.orderTx}'`,
    ).trim();
    expect(shop).toBe(`${-TOTAL}|wallet|settled`);
    // Its wallet leg debits the total; the top-up's credits the whole credit.
    expect(
      Number(
        scalar(`select coalesce(sum(CASE direction WHEN 'credit' THEN amount_fils ELSE -amount_fils END),0)
                  from ledger_entry where transaction_id='${row.orderTx}' and account='member_wallet'`),
      ),
    ).toBe(-TOTAL);
    expect(
      Number(
        scalar(`select coalesce(sum(CASE direction WHEN 'credit' THEN amount_fils ELSE -amount_fils END),0)
                  from ledger_entry where transaction_id='${row.settledTx}' and account='member_wallet'`),
      ),
    ).toBe(row.credit);
    expect(unbalancedTransactions('happy')).toEqual([]);
  });

  it("the frozen receipt is the order's own — the total, and the shop transaction it points at", async () => {
    const back = await read('happy', view.intent.id);
    const result = back.body.order.result!;
    expect(result, back.raw).not.toBeNull();
    expect(result.totalFils).toBe(TOTAL);
    expect(result.transaction?.id).toBe(back.body.order.transactionId);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ productId: PRODUCT, qty: 2 });
    for (const f of [result.totalFils, result.balanceAfterFils, back.body.intent.creditFils]) {
      expect(Number.isSafeInteger(f), `a money figure is not integer fils: ${f}`).toBe(true);
    }
  });
});

// ------------------------------------------------------------ double submit --

describe('a double submit under ONE key is one charge and one order', () => {
  const basket: Basket = { items: [{ productId: PRODUCT, qty: 1 }] };
  const idemKey = key('double-shared');
  let before: Money;
  let intentId = '';
  let view: View;

  it('five POSTs with one key, in flight at once, open ONE intent', async () => {
    before = money('double');
    const shots = await Promise.all(
      Array.from({ length: 5 }, () => timed(() => open('double', basket, idemKey))),
    );
    assertRaced(shots, 'five POST /orders/payments under one key');

    const statuses = shots.map((s) => s.value.status);
    // 201 for the winner and every replay that found its committed key; 409
    // `request_in_progress` for one that arrived while the winner was still open.
    // Never a 500, never a second 201 carrying a different intent.
    for (const s of shots) {
      expect([201, 409], `${s.value.status} ${s.value.raw}`).toContain(s.value.status);
    }
    const ok = shots.filter((s) => s.value.status === 201).map((s) => s.value.body);
    expect(ok.length, `no request won: ${statuses.join(',')}`).toBeGreaterThan(0);
    const ids = new Set(ok.map((b) => b.intent.id));
    expect([...ids], 'one key produced two intents').toHaveLength(1);
    view = ok[0]!;
    intentId = view.intent.id;

    expect(delta(before, money('double')).intents, 'one key opened more than one intent').toBe(1);
  });

  it('and that one payment confirmed five ways AT ONCE is one credit, one debit, one order', async () => {
    precondition(intentId !== '', 'the previous spec opened nothing');
    const row = intentRow(intentId);
    precondition(row.psp !== '', `${intentId} has no psp_reference`);

    // Her return twice, the hosted page's own signed callback, and two callbacks
    // signed here under DIFFERENT event ids — the re-delivery the event index alone
    // cannot catch. Only the intent's state machine stands behind all five.
    const shots = await Promise.all([
      timed(() => read('double', intentId)),
      timed(() => read('double', intentId)),
      timed(() => payOnHostedPage(view)),
      timed(() => deliverSigned(row.psp, row.amount)),
      timed(() => deliverSigned(row.psp, row.amount)),
    ]);
    assertRaced(shots, 'five confirmations of one order payment');
    for (const s of shots) {
      expect(s.value.status, `a confirmation errored: ${s.value.raw}\n${apiLogTail(30)}`).toBeLessThan(500);
    }

    const settled = intentRow(intentId);
    expect(settled.status).toBe('succeeded');
    expect(delta(before, money('double')), 'a confirmation arriving five ways moved money twice').toEqual({
      balance: settled.bonus,
      walletLedger: settled.bonus,
      topups: 1,
      shops: 1,
      orders: 1,
      lines: 1,
      intents: 1,
    });
    expect(unbalancedTransactions('double')).toEqual([]);
  });

  it('the same key AFTER settlement replays the stored answer and moves nothing', async () => {
    precondition(intentId !== '', 'the first spec opened nothing');
    const mid = money('double');
    const again = await open('double', basket, idemKey);
    expect(again.status, again.raw).toBe(201);
    expect(again.body.intent.id).toBe(intentId);
    expect(delta(mid, money('double')), 'a replayed key moved money or opened an intent').toEqual({
      balance: 0,
      walletLedger: 0,
      topups: 0,
      shops: 0,
      orders: 0,
      lines: 0,
      intents: 0,
    });
  });

  it('the same key with a DIFFERENT basket is refused, not replayed and not charged', async () => {
    precondition(intentId !== '', 'the first spec opened nothing');
    const mid = money('double');
    const other = await open('double', { items: [{ productId: PRODUCT, qty: 3 }] }, idemKey);
    expect(other.status, other.raw).toBeGreaterThanOrEqual(400);
    expect(other.status).toBeLessThan(500);
    expect(delta(mid, money('double')).intents).toBe(0);
    expect(delta(mid, money('double')).balance).toBe(0);
  });
});

/**
 * TWO KEYS ARE TWO PAYMENTS — PINNED AS THE CONTRACT, NOT REPORTED AS A BUG.
 *
 * Lane A says so in as many words: the server cannot tell a second basket from a
 * second tap, so the WALLET must derive the key from the cart. This spec is the
 * reason that sentence matters. If it ever goes red in the direction of "one order",
 * the server has started deduplicating by basket and the wallet's derived key is no
 * longer the only guard; if it goes red any other way, the money is wrong.
 */
describe('two DIFFERENT keys for the same basket are two charges and two orders', () => {
  it('each key is its own card payment, its own credit and its own order', async () => {
    const basket: Basket = { items: [{ productId: PRODUCT, qty: 1 }] };
    const before = money('twoKeys');
    const a = await opened('twoKeys', basket, PRODUCT_FILS, key('two-a'));
    const b = await opened('twoKeys', basket, PRODUCT_FILS, key('two-b'));
    expect(a.intent.id).not.toBe(b.intent.id);

    expect((await payOnHostedPage(a)).status).toBe(200);
    expect((await payOnHostedPage(b)).status).toBe(200);
    expect((await read('twoKeys', a.intent.id)).body.order.status).toBe('placed');
    expect((await read('twoKeys', b.intent.id)).body.order.status).toBe('placed');

    const bonus = intentRow(a.intent.id).bonus + intentRow(b.intent.id).bonus;
    expect(delta(before, money('twoKeys'))).toEqual({
      balance: bonus,
      walletLedger: bonus,
      topups: 2,
      shops: 2,
      orders: 2,
      lines: 2,
      intents: 2,
    });
  });
});

// ---------------------------------------------------------------- the race --

/**
 * THE RACE — the money arrives and the order can no longer be placed.
 *
 * The card has ALREADY been charged; the confirmation is the event being handled.
 * The naive implementation refuses the settlement and leaves her paid and
 * uncredited. Lane A's answer: the order runs in a SAVEPOINT, a refusal rolls back
 * to it, and the credit above it stands.
 *
 * THE ADDRESS CASE IS FIRST ON PURPOSE. The other two refuse before `placeOrder`
 * writes anything, so they would pass with or without the savepoint. A deleted
 * address throws AFTER the debit has run — so only the savepoint's rollback stands
 * between her and a wallet debited for an order that does not exist. It is the one
 * the mutation below the report was run against.
 *
 * Each spec asserts the same four things, because "nothing lost" is all four:
 *   1. the WHOLE credit is in her wallet — balance and ledger both, by SQL;
 *   2. no `shop` transaction, no `shop_order`, no order line survived;
 *   3. the intent is `succeeded` with the refusal recorded, and the view says so;
 *   4. every transaction she holds still balances across its legs.
 */
describe('the race — the payment confirms, the order cannot be placed, the money stays hers', () => {
  function assertRefusedAndWhole(who: Who, before: Money, intentId: string, code: string, body: View) {
    const row = intentRow(intentId);
    expect(row.status, 'the settlement itself was refused — she is paid and uncredited').toBe(
      'succeeded',
    );
    expect(row.orderTx, 'an order transaction was recorded for a refused order').toBe('');
    expect(row.refusal).toBe(code);

    expect(body.intent.status).toBe('succeeded');
    expect(body.order.status).toBe('refused');
    expect(body.order.transactionId).toBeNull();
    expect(body.order.result).toBeNull();
    expect(body.order.refusal?.code).toBe(code);
    expect(body.order.refusal?.message, 'a refusal she cannot read').toMatch(/\S/);
    // Exactly the two keys — a refusal carrying `paidFils`/`totalFils` from the
    // ApiError it was built from would be a second, unpinned shape on one screen.
    expect(Object.keys(body.order.refusal ?? {}).sort()).toEqual(['code', 'message']);

    expect(delta(before, money(who)), 'money was lost or an order leaked through the refusal').toEqual({
      balance: row.credit,
      walletLedger: row.credit,
      topups: 1,
      shops: 0,
      orders: 0,
      lines: 0,
      intents: 1,
    });
    expect(unbalancedTransactions(who)).toEqual([]);

    // Recorded where support will look, with the figure that stayed in her wallet.
    expect(
      scalar(
        `select coalesce(string_agg(metadata->>'refusalCode', ','), '') from audit_log
          where subject_type='topup_intent' and subject_id='${intentId}'
            and action='Card-paid order refused'`,
      ).trim(),
    ).toBe(code);
  }

  it('the delivery address is deleted while she pays — the debit that ran is rolled back with the order', async () => {
    const before = money('raceAddress');
    const made = await treq<any>('POST', '/members/me/addresses', {
      token: token.raceAddress!,
      body: { label: 'Home', block: '4', street: 'Salem Al Mubarak St', building: '12', area: 'Salmiya' },
    });
    precondition(made.status === 201, `could not make an address: ${made.status} ${made.raw}`);
    const addressId = made.body.address.id as string;

    const view = await opened(
      'raceAddress',
      { items: [{ productId: PRODUCT, qty: 1 }], fulfilment: 'delivery', addressId },
      PRODUCT_FILS,
    );

    const gone = await treq<any>('DELETE', `/members/me/addresses/${addressId}`, {
      token: token.raceAddress!,
    });
    precondition(gone.status < 300, `could not delete the address: ${gone.status} ${gone.raw}`);

    expect((await payOnHostedPage(view)).status).toBe(200);
    const back = await read('raceAddress', view.intent.id);
    expect(back.status, back.raw).toBe(200);
    assertRefusedAndWhole('raceAddress', before, view.intent.id, 'unknown_address', back.body);
  });

  it('and the credit it left is SPENDABLE — the same basket paid from the wallet goes through', async () => {
    // #5 says a refund is wallet credit. Credit she cannot spend would be a refund
    // in name only; this is the proof it is money.
    const mid = money('raceAddress');
    precondition(mid.balance >= PRODUCT_FILS, `she holds ${mid.balance}, less than the basket`);
    const res = await treq<any>('POST', '/orders', {
      token: token.raceAddress!,
      idempotencyKey: key('race-address-spend'),
      body: { items: [{ productId: PRODUCT, qty: 1 }] },
    });
    expect(res.status, res.raw).toBeLessThan(300);
    const after = delta(mid, money('raceAddress'));
    expect(after.balance).toBe(-PRODUCT_FILS);
    expect(after.walletLedger).toBe(-PRODUCT_FILS);
    expect(after.orders).toBe(1);
  });

  it('the product is retired while she pays — the whole credit is wallet credit, no order', async () => {
    const before = money('raceRetired');
    const view = await opened('raceRetired', { items: [{ productId: DOOMED, qty: 1 }] }, DOOMED_FILS);
    psql(`UPDATE product SET active = false WHERE id = '${DOOMED}';`);

    const back = await read('raceRetired', view.intent.id);
    expect(back.status, back.raw).toBe(200);
    assertRefusedAndWhole('raceRetired', before, view.intent.id, 'invalid_products', back.body);
  });

  it('the price moves while she pays — refused, never debited at a figure she did not pay', async () => {
    const before = money('racePrice');
    const view = await opened('racePrice', { items: [{ productId: MOVING, qty: 1 }] }, MOVING_FILS);
    psql(`UPDATE product SET price_fils = ${MOVING_NEW_FILS} WHERE id = '${MOVING}';`);

    // Settled by a callback signed here, so the race is exercised on the webhook
    // leg as well as on her return.
    const row = intentRow(view.intent.id);
    const cb = await deliverSigned(row.psp, row.amount);
    expect(cb.status, cb.raw).toBe(200);

    const back = await read('racePrice', view.intent.id);
    assertRefusedAndWhole('racePrice', before, view.intent.id, 'price_changed', back.body);
  });

  it('the database itself refuses a settled order payment with no outcome', () => {
    // `topup_intent_settled_order_is_answered`. The equivalence is what makes
    // "paid, and nobody decided the order" unrepresentable rather than merely
    // unwritten by today's code. Driven against the refused intent from the
    // retired-product spec; the UPDATE runs inside a transaction that is rolled
    // back whatever happens, so the row is not touched.
    const intentId = scalar(
      `select id from topup_intent where member_id='${M.raceRetired.id}' and order_request is not null
        order by created_at desc limit 1`,
    ).trim();
    precondition(intentId !== '', 'the retired-product spec left no intent');
    let error = '';
    try {
      psql(`
        BEGIN;
        UPDATE topup_intent SET order_refusal_code = NULL, order_refusal_message = NULL
         WHERE id = '${intentId}';
        ROLLBACK;
      `);
    } catch (err) {
      error = String((err as Error).message);
    }
    expect(error, 'a settled order payment was allowed to lose its outcome').toMatch(
      /topup_intent_settled_order_is_answered/,
    );
    expect(intentRow(intentId).refusal).toBe('invalid_products');
  });
});

// ---------------------------------------------------------------- tenancy --

/**
 * SCOPED BY THE CREDENTIAL — there is no member id in either URL.
 *
 * `readOrderPayment` refuses an id that is not hers with 404 `unknown_order_payment`,
 * and `readTopUp` behind it refuses with 404 `unknown_topup`. Two layers, and the
 * spec is written so that losing EITHER is visible:
 *
 *   - lose the first and a stranger's probe answers `unknown_topup` where a
 *     made-up id answers `unknown_order_payment` — an ORACLE for "this id is a real
 *     order payment". So the probe is compared byte for byte with a made-up id.
 *   - lose both and the sandbox (which answers `succeeded` by default) SETTLES THE
 *     OWNER'S PAYMENT ON THE STRANGER'S READ and places her order. So the owner's
 *     row is read back out of Postgres and shown untouched, and only then does the
 *     owner's own read settle it — the control proving the id was live all along.
 */
describe("tenancy — one customer's order payment is not addressable by another", () => {
  it("the stranger's read is byte-identical to a made-up id, and the owner's payment is untouched", async () => {
    const view = await opened('owner', { items: [{ productId: PRODUCT, qty: 1 }] }, PRODUCT_FILS);
    const ownerBefore = money('owner');
    const strangerBefore = money('stranger');

    const probe = await read('stranger', view.intent.id);
    const madeUp = await read('stranger', `TUI-QAOP-NO-SUCH-${Date.now()}`);
    expect(probe.status, probe.raw).toBe(404);
    expect(
      probe.raw,
      "another customer's order payment answers differently from an id that does not exist — " +
        'the difference tells her the id is real',
    ).toBe(madeUp.raw);

    const row = intentRow(view.intent.id);
    expect(row.status, "the stranger's read moved the owner's payment").toBe('redirected');
    expect(row.orderTx).toBe('');
    expect(delta(ownerBefore, money('owner'))).toEqual({
      balance: 0,
      walletLedger: 0,
      topups: 0,
      shops: 0,
      orders: 0,
      lines: 0,
      intents: 0,
    });
    expect(delta(strangerBefore, money('stranger')).balance).toBe(0);

    // THE CONTROL: the id was real and settle-able the whole time.
    const own = await read('owner', view.intent.id);
    expect(own.status, own.raw).toBe(200);
    expect(own.body.order.status).toBe('placed');
  });

  it("paying with another customer's address is refused before the gateway, exactly like a made-up one", async () => {
    const made = await treq<any>('POST', '/members/me/addresses', {
      token: token.owner!,
      body: { label: 'Owner', block: '2', street: 'Gulf Rd', building: '9', area: 'Sharq' },
    });
    precondition(made.status === 201, `owner address: ${made.status} ${made.raw}`);
    const ownersAddress = made.body.address.id as string;
    const before = money('stranger');

    const withHers = await open('stranger', {
      items: [{ productId: PRODUCT, qty: 1 }],
      fulfilment: 'delivery',
      addressId: ownersAddress,
    });
    const withNone = await open('stranger', {
      items: [{ productId: PRODUCT, qty: 1 }],
      fulfilment: 'delivery',
      addressId: `ADR-QAOP-NO-SUCH-${Date.now()}`,
    });
    expect(withHers.status, withHers.raw).toBe(withNone.status);
    expect(withHers.status).toBeGreaterThanOrEqual(400);
    expect(withHers.raw, "another customer's address is distinguishable from a made-up one").toBe(
      withNone.raw,
    );
    expect(delta(before, money('stranger')).intents, 'an intent was opened on her address').toBe(0);
    // Her address is still hers and still there.
    expect(
      scalar(`select member_id from member_address where id='${ownersAddress}'`).trim(),
    ).toBe(M.owner.id);
  });
});

// ------------------------------------------------------ the wallet census --

describe('every member this file touched reconciles — invariant 5, before teardown measures it', () => {
  it('balance equals the member_wallet ledger for all eight, with no reconciliation posted', () => {
    const drifting = (Object.keys(M) as Who[])
      .map((who) => ({ who, ...money(who) }))
      .filter((m) => m.balance !== m.walletLedger)
      .map((m) => `${M[m.who].id} (${m.who}): balance ${m.balance}, ledger ${m.walletLedger}`);
    expect(drifting, 'a card-paid order left a balance the ledger cannot explain').toEqual([]);
    // And none of that was bought with a fixture reconciliation row.
    expect(
      Number(
        scalar(`select count(*) from "transaction" where reference like 'AVO-RECONCILE-QA-OP-%'`),
      ),
    ).toBe(0);
  });
});
