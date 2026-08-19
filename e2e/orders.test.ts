/**
 * `POST /orders` — the shop, and the race that only the reconciliation saw.
 *
 * HOW TO RUN
 *
 *   pnpm --dir ./api run db:up
 *   cd e2e && ../node_modules/.bin/vitest run orders.test.ts
 *
 * WHY THIS FILE EXISTS, AND IT IS NOT "THE SHOP IS NEW"
 * ----------------------------------------------------
 * Lane A ran the ablation method on its own endpoint and removed the single
 * `FOR UPDATE` in `performOrder`. The result:
 *
 *     five concurrent orders of 9.000, all settled
 *     all five reported balanceAfterFils: 6250
 *     ledger off by 36000 fils
 *     every CHECK satisfied throughout
 *
 * `db:verify` invariant 5 was the only thing that saw it. **No spec did.** This file
 * is the spec that does.
 *
 * WHY EVERY `CHECK` STAYED SATISFIED, WHICH IS THE PART WORTH UNDERSTANDING
 * -----------------------------------------------------------------------
 * `member_balance_non_negative` is real and this suite drives it
 * (`scanner.test.ts` § "the money floor is in the schema"). It cannot catch a lost
 * update, and the reason is structural rather than bad luck: the debit is an
 * ABSOLUTE write, `SET balance_fils = <balanceAfter>`, computed in the handler from
 * the balance it read. Five writers that each read 15250 each write 6250 — a
 * perfectly legal, positive, plausible balance. There is no moment at which any row
 * is negative, so no CHECK has anything to object to. Four debits simply vanish.
 *
 * A conditional decrement — `SET balance_fils = balance_fils - <due>
 * WHERE id = $1 AND balance_fils >= <due>`, with the row count read — would make the
 * database do the arithmetic and refuse the fourth and fifth outright, the same shape
 * `returnDeposit` now uses for `deposit_already_returned`. **That is a lane A
 * decision and it is put to them in the lane report, not made here.** See the block
 * comment on the race spec for why the asymmetry with `POST /charges` is the argument
 * for it: money-in has two independent layers and money-out through orders has one.
 *
 * THE RACE IS SET UP SO THAT LOSING IT IS UNAMBIGUOUS
 * --------------------------------------------------
 * Firing five concurrent orders at a wallet that can afford five proves nothing: the
 * correct answer and the broken answer are both "five settled". So this file funds
 * her for EXACTLY TWO and fires five. Correct behaviour is two settled and three
 * refused with `insufficient_balance`; the ablated behaviour is five settled. The two
 * outcomes cannot be confused, and the assertion is on the money rather than on the
 * count alone.
 *
 * ITS OWN MEMBER, cloned from the seeded QA member so the password hash
 * `signInMember` sends is the one on the row. This file moves a balance to a
 * deliberately tiny number, which is not something to do to a member another file
 * asserts against.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { precondition } from './support/known-bug.js';
import {
  SALON_A,
  SALON_B,
  apiLogTail,
  psql,
  scalar,
  signInMember,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

const MEMBER = 'QA-ORD-0001';
const MEMBER_PHONE = '+96555990001';
const CLONE_SOURCE = 'QA-GW-0001';

/** `api/src/db/seed.ts`: PR-01 Argan hair oil, salon A, 8.500 KD. */
const PRODUCT = 'PR-01';
const PRODUCT_FILS = 8_500;

let member = '';
let n = 0;
const key = (label: string) => `order-${label}-${Date.now()}-${n++}`;

const balanceOf = (): number =>
  Number(scalar(`select balance_fils from member where id='${MEMBER}'`));

/** Her `shop` transactions. One per settled order. */
const shopRows = (): number =>
  Number(
    scalar(`select count(*) from transaction where member_id='${MEMBER}' and kind='shop'`),
  );

/**
 * THE RECONCILIATION, and it is the invariant that caught the ablation.
 *
 * The sum of every transaction against her must equal the movement in her balance.
 * This is `db:verify` invariant 5 expressed against one member, and it is the only
 * assertion in this file that would have failed on the ablated code while every
 * per-request assertion still passed — a lost update leaves the balance too HIGH for
 * the transactions written, which no single response can reveal.
 */
const ledgerSum = (): number =>
  Number(
    scalar(
      `select coalesce(sum(amount_fils), 0) from transaction where member_id = '${MEMBER}'`,
    ),
  );

const order = (idemKey: string, qty = 1) =>
  treq<any>('POST', '/orders', {
    token: member,
    idempotencyKey: idemKey,
    body: { items: [{ productId: PRODUCT, qty }] },
  });

/** Set her balance to an exact figure. The only way to make the race decisive. */
function fund(fils: number): void {
  psql(`UPDATE member SET balance_fils = ${fils} WHERE id = '${MEMBER}';`);
}

beforeAll(async () => {
  await startTenancyApi();

  /**
   * Cloned rather than written field by field: `member` has columns this file has no
   * opinion about, and a hand-written row that satisfies today's NOT NULLs breaks the
   * day one is added. The `SELECT` takes whatever they are, including the password
   * hash `signInMember` needs.
   */
  psql(`
    INSERT INTO member (id, salon_id, name, phone, email, email_verified, password_hash,
                        balance_fils, visits, tier, stamps, policy_version, notify_wa)
    SELECT '${MEMBER}', salon_id, 'Orders QA', '${MEMBER_PHONE}', NULL, false,
           password_hash, 0, 0, tier, stamps, policy_version, false
      FROM member WHERE id = '${CLONE_SOURCE}'
    ON CONFLICT (id) DO UPDATE SET balance_fils = 0;
  `);
  precondition(
    scalar(`select count(*) from member where id='${MEMBER}'`).trim() === '1',
    `the clone source ${CLONE_SOURCE} is missing, so this file has no member`,
  );

  member = await signInMember(SALON_A, MEMBER_PHONE);

  // The fixture this file prices everything against, asserted rather than assumed.
  precondition(
    scalar(
      `select price_fils::text from product where id='${PRODUCT}' and salon_id='${SALON_A}'`,
    ).trim() === String(PRODUCT_FILS),
    `${PRODUCT} is not ${PRODUCT_FILS} fils at ${SALON_A}, so every figure below is wrong`,
  );
  /**
   * `::text` IS DELIBERATELY ABSENT, and the difference bit once already. A bare
   * boolean column comes back from `psql -tA` as `t`; the SAME column written
   * `module_shop::text` comes back as `true`. Casting and then comparing to `'t'`
   * fails against a salon whose shop is switched ON, which is how this precondition
   * first reported the opposite of the truth.
   */
  precondition(
    scalar(`select module_shop from salon where id='${SALON_A}'`).trim() === 't',
    `${SALON_A} has the shop module off, so every order here would be shop_not_enabled`,
  );
}, 120_000);

afterAll(async () => {
  /**
   * Her transactions and the member are LEFT BEHIND, and the teardown says so rather
   * than attempting a delete that cannot work. `transaction.member_id` is
   * `onDelete: 'restrict'` and 0024 makes the ledger unerasable by anyone — which is
   * the property the money core depends on, so a suite that could clean up after
   * itself here would be a suite proving that property false. The run database is
   * minted per run and dropped by `global-setup.ts`; this member's id and phone are
   * unique to this file.
   */
  await stopTenancyApi();
});

// ===========================================================================

describe('an order debits the wallet, and the ledger reconciles to it', () => {
  /**
   * THE CONTROL. Every refusal and every race below asserts that money did NOT move
   * in some way, and an endpoint broken shut satisfies all of them. So first: an
   * order really does take the money and really does write the row.
   */
  it('takes the price from the wallet and writes exactly one shop transaction', async () => {
    fund(50_000);
    const rowsBefore = shopRows();
    const ledgerBefore = ledgerSum();

    const res = await order(key('control'));

    expect(
      res.status,
      `${res.raw}${res.status >= 500 ? `\n--- API log ---\n${apiLogTail()}` : ''}`,
    ).toBe(201);
    expect(res.body.totalFils, 'the total was not the catalog price').toBe(PRODUCT_FILS);
    expect(Number.isInteger(res.body.totalFils)).toBe(true);
    expect(res.body.balanceAfterFils).toBe(50_000 - PRODUCT_FILS);
    // A debit is NEGATIVE on the transaction. A shop order stored positive
    // reconciles the wrong way, which is the whole subject of this file.
    expect(res.body.transaction.amountFils).toBe(-PRODUCT_FILS);

    expect(balanceOf(), 'the database disagrees with the reply').toBe(50_000 - PRODUCT_FILS);
    expect(shopRows()).toBe(rowsBefore + 1);
    expect(
      ledgerSum(),
      'the transaction written does not account for the money that left',
    ).toBe(ledgerBefore - PRODUCT_FILS);
  }, 60_000);

  it('refuses an order it cannot pay for, and names the shortfall', async () => {
    fund(PRODUCT_FILS - 1);
    const rowsBefore = shopRows();

    const res = await order(key('poor'));

    expect(res.status, `${res.raw}`).toBe(402);
    expect(res.body.error).toBe('insufficient_balance');
    expect(res.body.shortfallFils, 'the refusal does not say how short she is').toBe(1);
    expect(balanceOf(), 'a refused order moved money').toBe(PRODUCT_FILS - 1);
    expect(shopRows(), 'a refused order wrote a shop transaction').toBe(rowsBefore);
  }, 60_000);
});

// -------------------------------------------------------------------- the race --

describe('concurrent orders on one wallet cannot spend the same fils twice', () => {
  /**
   * THE SPEC THE ABLATION ASKED FOR.
   *
   * Lane A removed `performOrder`'s single `FOR UPDATE` and five concurrent orders of
   * 9.000 all settled, all reporting the same `balanceAfterFils`, leaving the ledger
   * 36000 fils out. Only `db:verify` invariant 5 noticed. Nothing in this suite did,
   * because nothing in this suite fired two orders at once.
   *
   * FUNDED FOR EXACTLY TWO, FIRED FIVE. That asymmetry is the whole design: a wallet
   * that can afford all five makes the correct and the broken outcome identical
   * ("five settled"), so the spec would pass under ablation and prove nothing. Funded
   * for two, the correct answer is two settled and three `insufficient_balance`, and
   * the ablated answer is five settled. They cannot be confused.
   *
   * FOUR ASSERTIONS, AND THE LAST IS THE ONE THAT CANNOT BE FOOLED:
   *   1. exactly two settled, three refused — the count;
   *   2. the balance is opening - 2 x price, and never negative;
   *   3. exactly two `shop` rows exist — so a settled response corresponds to a row;
   *   4. the LEDGER RECONCILES — sum(amount_fils) equals the balance movement.
   *
   * (4) is `db:verify` invariant 5 scoped to one member, and it is the assertion that
   * fails under a lost update while every per-response assertion still passes: a lost
   * update leaves the balance too HIGH for the rows written, which no single reply can
   * reveal. It is here because the ablation proved a suite can be green while the
   * reconciliation is the only honest witness.
   *
   * WHY THE ASYMMETRY WITH `POST /charges` WAS WORTH LANE A'S ATTENTION. A charge
   * survived the equivalent ablation because it has TWO independent layers: the
   * wallet-token consumption is a conditional write with a row-count read
   * (`consumed_at IS NULL AND expires_at > now()`), so two concurrent charges on one
   * token cannot both proceed even with no lock. An order has no token — it is
   * member-authenticated directly — so `FOR UPDATE` was its only serialising guard, and
   * `member_balance_non_negative` cannot be the second one because an absolute write
   * of a positive balance never violates it. Money-in had two layers; money-out through
   * the shop had one. Put to lane A as a decision, not fixed here.
   *
   * =========================================================================
   * LANE A ANSWERED IT, AND THE SECOND GUARD WAS THEN MEASURED ALONE
   * 2026-08-19, 10:42 Kuwait
   * =========================================================================
   * `performOrder` step 5a is now a CONDITIONAL, RELATIVE UPDATE whose row count decides:
   * `WHERE balance_fils >= total` refuses the loser and `SET balance_fils - total` puts
   * the arithmetic in the database. Both halves are load-bearing and lane A says so.
   *
   * IT IS THE `no-show` PROBLEM IN A NEW COSTUME, WHICH IS WHY IT WAS CHECKED. Lane A's
   * own comment on that statement reads: "Unreachable while step 2 holds the row — which
   * is the point: this is the layer that speaks when the other one is gone." A guard that
   * is unreachable while the guard in front of it works is a guard NO SPEC CAN DRIVE — the
   * exact shape of the no-show job's status re-check, which no sequential spec could
   * reach. So it was measured by ablation instead, the only instrument that can:
   *
   *   lock removed, second guard intact
   *     → § "whatever the five racers are told…" PASSES. The ledger, the rows and the
   *       balance all agree. THE SECOND GUARD HOLDS THE MONEY TOGETHER ON ITS OWN.
   *     → § "five orders at once…" FAILS: four of the five racers answer **500
   *       server_error**, and only ONE order settles against a balance for two.
   *
   *   lock removed AND the relative SET made absolute (`SET balance_fils = <precomputed>`,
   *   conditional WHERE kept)
   *     → § "whatever the five racers are told…" FAILS. So that spec really does detect a
   *       lost update, and the RELATIVE half of the SET is the half that prevents one —
   *       lane A's "a conditional WHERE with a precomputed value would still write the
   *       stale number", confirmed rather than taken on trust.
   *
   * SO: REACHABLE, LOAD-BEARING, AND UNABLE TO ANSWER. This is the finding, and it is
   * lane A's call. The second layer protects the ledger exactly as intended, but when it
   * is the layer doing the work the customer does not get the `402` the code intends —
   * she gets a 500. The cause is the consistency check immediately after the debit:
   *
   *     if (landed.balanceFils !== balanceAfter) throw new Error(…)
   *
   * With the lock gone that comparison is false for every racer that legitimately
   * debited behind another, so it throws a bare `Error` and Fastify serialises a
   * `server_error`. The zero-row path below it is careful to be "a 402, NOT a 500" — but
   * in the one scenario the second layer exists for, most callers never reach it.
   *
   * That assertion is still worth keeping: its message ("the FOR UPDATE in step 2 is not
   * holding") is exactly right, and it is what turned a silent lost update into a loud
   * refusal. The observation is only that it makes the second layer a NET rather than a
   * CONTROL — which is the same distinction lane A drew about `db:verify` when arguing
   * that this guard was needed at all. A shop that answers 500 to four of five shoppers
   * is not serving them; it is merely not robbing them.
   *
   * Nothing here is fixed by lane D, and no spec can pin it: with the lock in place the
   * whole path is unreachable, so there is no assertion to write. It is reported.
   */
  it('five orders at once against a balance for two: two settle, three are refused', async () => {
    const opening = PRODUCT_FILS * 2;
    fund(opening);
    const rowsBefore = shopRows();
    const ledgerBefore = ledgerSum();

    // Five DIFFERENT keys — this is five genuine orders racing, not one retried.
    // Under one key the idempotency machinery would be the thing under test instead.
    const results = await Promise.all([
      order(key('race-a')),
      order(key('race-b')),
      order(key('race-c')),
      order(key('race-d')),
      order(key('race-e')),
    ]);

    const settled = results.filter((r) => r.status === 201);
    const refused = results.filter((r) => r.status === 402);
    const other = results.filter((r) => r.status !== 201 && r.status !== 402);

    expect(
      other.map((r) => `${r.status} ${r.raw}`),
      'a concurrent order answered something other than 201 or 402',
    ).toEqual([]);

    expect(
      settled.length,
      `${settled.length} of five concurrent orders settled against a balance that covers two. ` +
        'More than two means the debits raced: each read the same balance and wrote its own ' +
        'absolute result, so the losers vanished. That is the exact state removing ' +
        "performOrder's FOR UPDATE produced, and no CHECK can see it because every writer " +
        'writes a plausible POSITIVE balance.',
    ).toBe(2);
    expect(refused.length, 'the three unaffordable orders were not refused').toBe(3);
    for (const r of refused) expect(r.body.error).toBe('insufficient_balance');

    // The money, out of the database rather than out of any reply.
    expect(
      balanceOf(),
      'the balance is not opening minus exactly two orders, so a debit was lost or doubled',
    ).toBe(opening - PRODUCT_FILS * 2);
    expect(balanceOf(), 'the wallet went negative').toBeGreaterThanOrEqual(0);
    expect(shopRows(), 'a settled order did not write a row, or a refused one did').toBe(
      rowsBefore + 2,
    );

    /**
     * AND THE RECONCILIATION. The one that caught this when nothing else could.
     */
    expect(
      ledgerSum(),
      'the ledger does not account for the balance movement. Under the lost update that ' +
        'removing FOR UPDATE produced, this is the assertion that fails while every response ' +
        'above still looks correct — the balance is too HIGH for the rows written.',
    ).toBe(ledgerBefore - PRODUCT_FILS * 2);
  }, 120_000);

  /**
   * THE MONEY, SEPARATED FROM THE ANSWER — and the separation is the point.
   *
   * WHY THIS IS NOT A DUPLICATE OF THE SPEC ABOVE. That spec asserts the STATUSES first
   * ("nothing other than 201 or 402") and the reconciliation last, so the moment a racer
   * answers anything unexpected it stops and never reaches the money. That ordering is
   * right for the spec it is in — a shopper is owed a correct answer — but it means the
   * suite cannot distinguish two very different failures:
   *
   *   A. the ledger is wrong          — fils were spent twice, the salon is short
   *   B. the ledger is right and the ANSWER is wrong — nobody lost money, but a customer
   *      who could afford the item was told "something went wrong on our side"
   *
   * A is a money defect. B is a bad day for a shopper. Collapsing them means a later
   * change that turns A into B reads as "still failing" instead of "much better", and a
   * change that turns B into A reads the same as before.
   *
   * SO THIS SPEC ASSERTS ONLY THE INVARIANT, and asserts it about WHATEVER HAPPENED: the
   * number of `shop` rows, the balance movement and the ledger sum must agree with each
   * other, whichever statuses came back. It is `db:verify` invariant 5 scoped to one
   * member and freed from the status assertion.
   *
   * IT IS THE SPEC THAT ANSWERS TRUNK'S QUESTION ABOUT THE SECOND GUARD. Measured
   * 2026-08-19, 10:42 Kuwait, by removing `performOrder`'s step-2 `FOR UPDATE` and
   * running this file: this spec PASSES — the conditional relative UPDATE holds the
   * ledger together on its own — while the spec above fails with four `500`s. The second
   * guard is genuinely reachable and genuinely load-bearing, and it protects the money
   * without being able to produce the right answer. Details in the § note below.
   */
  it('whatever the five racers are told, the ledger and the rows agree with the balance', async () => {
    const opening = PRODUCT_FILS * 2;
    fund(opening);
    const rowsBefore = shopRows();
    const ledgerBefore = ledgerSum();
    const balanceBefore = balanceOf();

    const results = await Promise.all([
      order(key('inv-a')),
      order(key('inv-b')),
      order(key('inv-c')),
      order(key('inv-d')),
      order(key('inv-e')),
    ]);

    const settled = results.filter((r) => r.status === 201).length;
    const rowsAdded = shopRows() - rowsBefore;

    /**
     * Not asserted as a number, because this spec deliberately has no opinion about how
     * many should have gone through — that is the spec above's job. Asserted as
     * AGREEMENT: a settled reply corresponds to a row, a row corresponds to a debit, and
     * the debits account for the balance exactly.
     */
    expect(
      rowsAdded,
      `${settled} orders were answered 201 but ${rowsAdded} shop rows exist. A settled reply ` +
        'with no row means the customer was told she bought something that was never recorded.',
    ).toBe(settled);

    expect(
      balanceOf(),
      `${rowsAdded} order(s) were recorded but the balance moved by ` +
        `${balanceBefore - balanceOf()} fils rather than ${rowsAdded * PRODUCT_FILS}. Under a ` +
        'lost update the balance is too HIGH for the rows written, which no single response ' +
        'can reveal.',
    ).toBe(balanceBefore - rowsAdded * PRODUCT_FILS);

    expect(
      ledgerSum(),
      'the ledger does not account for the balance movement — this is invariant 5, and it is ' +
        'the assertion that fails on a lost update while every reply still looks plausible',
    ).toBe(ledgerBefore - rowsAdded * PRODUCT_FILS);

    expect(balanceOf(), 'the wallet went negative').toBeGreaterThanOrEqual(0);
  }, 120_000);

  /**
   * AND A SINGLE WALLET CANNOT BE DRAINED BELOW ZERO BY A CROWD, which is the
   * customer-visible version of the same question and worth its own assertion because
   * it is the one a merchant would notice.
   */
  it('and an exactly-affordable balance ends at zero, never below it', async () => {
    fund(PRODUCT_FILS);
    const ledgerBefore = ledgerSum();

    const results = await Promise.all([
      order(key('drain-a')),
      order(key('drain-b')),
      order(key('drain-c')),
    ]);

    expect(results.filter((r) => r.status === 201).length, 'more than one order was paid for').toBe(
      1,
    );
    expect(balanceOf(), 'the wallet did not land exactly on zero').toBe(0);
    expect(ledgerSum()).toBe(ledgerBefore - PRODUCT_FILS);
  }, 120_000);
});

// ------------------------------------------------------- non-negotiable #4 --

describe('POST /orders is idempotent, which closes the fourth of #4\'s four verbs', () => {
  /**
   * Non-negotiable #4 lists four money-moving POSTs — "top-ups, charges, orders,
   * voids" — and `orders` was the one with no endpoint to test, so the go-live row
   * for it could not be ticked however green the other three were. It exists now.
   */
  it('requires a key, and refuses without one before anything moves', async () => {
    fund(50_000);
    const before = balanceOf();

    const res = await treq<any>('POST', '/orders', {
      token: member,
      body: { items: [{ productId: PRODUCT, qty: 1 }] },
    });

    expect(res.status, `an order with no Idempotency-Key answered ${res.status}: ${res.raw}`).toBe(
      400,
    );
    expect(res.body.error).toBe('idempotency_key_required');
    expect(balanceOf(), 'a keyless order moved money').toBe(before);
  }, 60_000);

  it('a replay under the same key debits once and returns the first result', async () => {
    fund(50_000);
    const k = key('replay');
    const rowsBefore = shopRows();

    const first = await order(k);
    precondition(first.status === 201, `the first order failed: ${first.raw}`);
    const afterFirst = balanceOf();

    const replay = await order(k);

    expect(replay.status, `the replay answered ${replay.status}: ${replay.raw}`).toBe(201);
    expect(
      replay.body.transaction.id,
      'the replay created a SECOND transaction, so a retried order is a second charge',
    ).toBe(first.body.transaction.id);
    expect(balanceOf(), 'the replay debited again').toBe(afterFirst);
    expect(shopRows(), 'the replay wrote a second shop row').toBe(rowsBefore + 1);
  }, 60_000);

  it('a DIFFERENT cart under the same key is refused, not answered with the first', async () => {
    fund(50_000);
    const k = key('mutated');

    const first = await order(k, 1);
    precondition(first.status === 201, `the first order failed: ${first.raw}`);
    const afterFirst = balanceOf();

    const mutated = await order(k, 2);

    expect(
      mutated.status,
      `a mutated retry answered ${mutated.status}: ${mutated.raw}. Replaying the first result ` +
        'for a different cart hides a lost order; charging for the second under a spent key ' +
        'double-debits.',
    ).toBe(422);
    expect(balanceOf(), 'the mutated retry moved money').toBe(afterFirst);
  }, 60_000);

  /**
   * AND THE PRICE IS NOT THE CLIENT'S TO SEND. Refused by name rather than ignored:
   * a client that sent `unitPriceFils` believed it was setting the price, and
   * silently ignoring it charges the customer an amount her app never showed her.
   */
  for (const field of ['priceFils', 'unitPriceFils', 'totalFils', 'amountFils'] as const) {
    it(`refuses a client-supplied ${field} by name`, async () => {
      fund(50_000);
      const before = balanceOf();

      const res = await treq<any>('POST', '/orders', {
        token: member,
        idempotencyKey: key(`price-${field}`),
        body: { items: [{ productId: PRODUCT, qty: 1 }], [field]: 1 },
      });

      expect(res.status, `${field} answered ${res.status}: ${res.raw}`).toBe(400);
      expect(res.body.error).toBe('price_not_client_supplied');
      expect(balanceOf()).toBe(before);
    }, 60_000);
  }

  it('and refuses a client-supplied branchId — the server resolves the branch', async () => {
    fund(50_000);

    const res = await treq<any>('POST', '/orders', {
      token: member,
      idempotencyKey: key('branch'),
      body: { items: [{ productId: PRODUCT, qty: 1 }], branchId: 'BR-SAL' },
    });

    expect(res.status, `${res.raw}`).toBe(400);
    expect(res.body.error).toBe('branch_not_client_supplied');
  }, 60_000);
});

// ===========================================================================

/**
 * `invalid_products` — THE GUARD THAT PRICES NOTHING IT CANNOT NAME.
 *
 * `services/order.ts` raises this code in TWO places, and the brief that routed this
 * slice asked for the second one to be proved reachable on its own, the way the charge
 * path's `FOR UPDATE` and its conditional token consumption each cover the other.
 *
 * IT IS NOT THE SAME SHAPE, AND THE DIFFERENCE IS THE FINDING. On the charge path the
 * two guards are independent: they serialise different rows, so removing either leaves
 * the other genuinely load-bearing, which is why breaking that race took two attempts.
 * Here the second raise is STRICTLY DOMINATED by the first — not merely "usually
 * covered", but unreachable by construction:
 *
 *   guard 1 (:231)  ids     = input.items.map(i => i.productId)
 *                   unknown = ids.filter(id => !priced.has(id))     -> throws
 *   guard 2 (:252)  input.items.map(i => { const p = priced.get(i.productId)
 *                                          if (!p) throw ... })
 *
 * Same domain (`input.items` → `productId`), same map, same predicate: `priced.get`
 * is falsy exactly when `priced.has` is false, because the values are row objects and
 * a row object is never falsy. Guard 1 has already thrown for every id guard 2 could
 * object to — including duplicates, which appear in `ids` as many times as they appear
 * in `items` and so cannot diverge. Order is identical because both walk `input.items`.
 *
 * So there is no input that reaches guard 2 while guard 1 stays silent, and no spec
 * can be written that reaches only it. The code's own comment says so — "Unreachable —
 * the `unknown` check above threw" — and it is right; it is a type-narrowing fallback
 * standing in for a `!` assertion, not a second control. Measured by ablation and
 * reported to trunk rather than tested: a spec claiming to cover it would be a spec
 * that passes because guard 1 fired.
 *
 * WHAT IS COVERED HERE IS GUARD 1, WHICH IS THE ONE THAT REFUSES, and it had NO
 * `invalid_products` assertion anywhere in `e2e/` before this describe — the endpoint
 * that takes money out of a wallet for goods, with its "does this product exist"
 * refusal untested. Three inputs reach it, and they are three different rules wearing
 * one error code: an id that never existed, an id belonging to ANOTHER SALON (the
 * tenant boundary `services/order.ts` names as "the case lane D has written down as
 * owed for the shop"), and an id that has been RETIRED. Each is asserted on the code
 * and on the database, never on the message.
 */
describe('POST /orders refuses a basket it cannot price, by name and without moving money', () => {
  /** Salon B's product. Priceable at salon B, invisible to a salon A member. */
  const FOREIGN_PRODUCT = 'PR-QA-B01';
  /** Salon A's product, `active = false`. Retired, not deleted. */
  const RETIRED_PRODUCT = 'PR-QA-A99';
  /** Never existed. */
  const GHOST_PRODUCT = 'PR-NO-SUCH-THING';

  beforeAll(() => {
    /**
     * Written here rather than in `api/src/db/seed.ts` because neither row is a
     * fixture of something the product ships — lane A's seed gives salon A three
     * live products and salon B none, which is the honest state of the shop module.
     * These two exist to make two refusals reachable, so they belong to the spec
     * that reaches them. Lane D writes only tests; a seed row is lane A's column.
     */
    psql(`
      INSERT INTO product (id, salon_id, name, price_fils, active)
      VALUES ('${FOREIGN_PRODUCT}', '${SALON_B}', 'Lumiere serum (salon B)', 5000, true),
             ('${RETIRED_PRODUCT}', '${SALON_A}', 'Discontinued balm', 3000, false)
      ON CONFLICT (id) DO UPDATE
        SET salon_id = excluded.salon_id, price_fils = excluded.price_fils,
            active = excluded.active;
    `);

    // Asserted, not assumed. A fixture that silently landed active would turn the
    // retired case into a successful order and the spec would report the opposite.
    precondition(
      scalar(`select active from product where id='${RETIRED_PRODUCT}'`).trim() === 'f',
      `${RETIRED_PRODUCT} is active, so the retired case would settle instead of refusing`,
    );
    precondition(
      scalar(`select salon_id from product where id='${FOREIGN_PRODUCT}'`).trim() === SALON_B,
      `${FOREIGN_PRODUCT} is not at ${SALON_B}, so the cross-tenant case proves nothing`,
    );
  });

  /**
   * THE MONEY ASSERTION IS THE POINT, in all four cases below.
   *
   * The defect this guard exists against is not a bad error message: it is an
   * unknown id pricing at 0 and settling a real `shop` transaction for goods that do
   * not exist — which is what the mock's charge path did, and what lane D found there.
   * So every case reads the balance and the `shop` row count out of Postgres before
   * and after, and the refusal is only believed if BOTH are unchanged. "The system
   * refused" is the status and the code; "nothing moved" is the SQL.
   */
  const refusal = async (label: string, ids: string[]) => {
    fund(50_000);
    const before = balanceOf();
    const rowsBefore = shopRows();
    const ledgerBefore = ledgerSum();
    const k = key(label);

    const res = await treq<any>('POST', '/orders', {
      token: member,
      idempotencyKey: k,
      body: { items: ids.map((productId) => ({ productId, qty: 1 })) },
    });

    return { res, before, rowsBefore, ledgerBefore, k };
  };

  it('an id that never existed is refused, and names itself', async () => {
    const { res, before, rowsBefore } = await refusal('ghost', [GHOST_PRODUCT]);

    expect(res.status, `an unknown product answered ${res.status}: ${res.raw}`).toBe(400);
    expect(res.body.error).toBe('invalid_products');
    /**
     * NAMED, NOT COUNTED — `services/order.ts` puts `{ unknown }` in the error
     * details for the stated reason that "a client cannot fix 'one of your items is
     * unavailable'". `ApiError.toBody` spreads details, so it arrives top-level. This
     * asserts the contract, not the prose.
     */
    expect(res.body.unknown, `the refusal did not name the id: ${res.raw}`).toEqual([
      GHOST_PRODUCT,
    ]);
    expect(balanceOf(), 'an unpriceable order moved money').toBe(before);
    expect(shopRows(), 'an unpriceable order wrote a shop transaction').toBe(rowsBefore);
  }, 60_000);

  it("another salon's product is not priceable here — the shop's tenant boundary", async () => {
    const { res, before, rowsBefore } = await refusal('foreign', [FOREIGN_PRODUCT]);

    expect(
      res.status,
      `a salon A member ordering salon B's product answered ${res.status}: ${res.raw}. ` +
        'A cross-tenant price is a wallet debited for another salon\'s goods.',
    ).toBe(400);
    expect(res.body.error).toBe('invalid_products');
    expect(res.body.unknown).toEqual([FOREIGN_PRODUCT]);
    expect(balanceOf(), "salon B's product debited a salon A wallet").toBe(before);
    expect(shopRows()).toBe(rowsBefore);

    /**
     * AND IT IS STILL THERE. The refusal is a visibility rule, not a deletion — the
     * row must survive so salon B can sell it. A guard that passed by destroying the
     * fixture would pass once.
     */
    expect(scalar(`select count(*) from product where id='${FOREIGN_PRODUCT}'`).trim()).toBe('1');
  }, 60_000);

  it('a retired product is refused rather than sold at its old price', async () => {
    const { res, before, rowsBefore } = await refusal('retired', [RETIRED_PRODUCT]);

    expect(res.status, `a retired product answered ${res.status}: ${res.raw}`).toBe(400);
    expect(res.body.error).toBe('invalid_products');
    expect(res.body.unknown).toEqual([RETIRED_PRODUCT]);
    expect(balanceOf(), 'a retired product was sold').toBe(before);
    expect(shopRows()).toBe(rowsBefore);
  }, 60_000);

  /**
   * THE CASE THAT WOULD HAVE CAUGHT A PARTIAL SETTLE, and the reason a
   * single-bad-item basket is not enough on its own. One good line and one bad line:
   * a handler that priced what it recognised and skipped what it did not would answer
   * 201 here, debit 8.500 for the oil, and leave the customer's receipt one item short
   * of her cart. The whole order has to fail.
   */
  it('one bad line refuses the WHOLE basket, including the line that was priceable', async () => {
    const { res, before, rowsBefore, ledgerBefore } = await refusal('mixed', [
      PRODUCT,
      GHOST_PRODUCT,
    ]);

    expect(
      res.status,
      `a mixed basket answered ${res.status}: ${res.raw}. A partial settle debits for a ` +
        'cart the customer never confirmed.',
    ).toBe(400);
    expect(res.body.error).toBe('invalid_products');
    /** Only the bad one is named. `PRODUCT` priced fine; it just does not get to settle. */
    expect(res.body.unknown).toEqual([GHOST_PRODUCT]);
    expect(
      balanceOf(),
      `the priceable line settled on its own: balance moved by ${before - balanceOf()} fils`,
    ).toBe(before);
    expect(shopRows(), 'a refused mixed basket still wrote a shop transaction').toBe(rowsBefore);
    /**
     * And the reconciliation the ablation was caught by. `ledgerBefore` is captured in
     * `refusal()` BEFORE the request — comparing `ledgerSum()` to itself after would be
     * a tautology that passes against any behaviour at all.
     */
    expect(ledgerSum(), 'the ledger moved for a basket that was refused').toBe(ledgerBefore);
  }, 60_000);

  /**
   * AND THE KEY SURVIVES, which is the difference between a refusal and a spent
   * attempt. `services/order.ts` says of the 402 one section later that "this throw
   * rolls the transaction back, so the idempotency key is untouched and she can retry
   * after topping up" — the same rollback covers this 400, and the customer's fix here
   * is to remove the item rather than top up. If the key were consumed she would have
   * to be issued a new one by a client that has no idea the old one is dead.
   */
  it('and the refused attempt does not spend the idempotency key', async () => {
    const { res, k } = await refusal('key-survives', [GHOST_PRODUCT]);
    precondition(res.status === 400, `the refusal did not happen: ${res.raw}`);

    expect(
      scalar(`select count(*) from idempotency_key where key='${k}'`).trim(),
      'the rolled-back order left an idempotency_key row, so the key is spent',
    ).toBe('0');

    // And the behaviour that matters: the same key now works for a corrected cart.
    const corrected = await treq<any>('POST', '/orders', {
      token: member,
      idempotencyKey: k,
      body: { items: [{ productId: PRODUCT, qty: 1 }] },
    });
    expect(
      corrected.status,
      `the corrected retry under the same key answered ${corrected.status}: ${corrected.raw}`,
    ).toBe(201);
  }, 60_000);
});
