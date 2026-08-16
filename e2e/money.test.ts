/**
 * The money invariants, end to end over HTTP.
 *
 *   #1  money is integer fils, no float anywhere
 *   #2  the server owns the balance and the bonus
 *   #3  POST /charges is one transaction — if the debit fails, nothing else happened
 *   #4  idempotency keys on every money-moving POST
 *
 * Expected figures are literals taken from design/api-contract.md § Commission
 * and § Charging, never recomputed with the helpers the server itself uses. A
 * test that calls `commissionFor()` to work out what `commissionFor()` should
 * have returned is decoration.
 */

import { describe, expect, it } from 'vitest';
import {
  BALANCE_FILS,
  LOWBAL_BALANCE_FILS,
  MEMBER_ID,
  SERVICE,
  api,
  idempotencyKey,
  mintWalletToken,
} from './support/api.js';
import { knownBug, precondition } from './support/known-bug.js';

interface TopUpIntent {
  id: string;
  memberId: string;
  amountFils: number;
  bonusFils: number;
  creditFils: number;
  method: string;
  feeFils: number;
  status: string;
  reference: string;
}

interface ChargeResult {
  transaction: { id: string; amountFils: number; kind: string; status: string };
  balanceAfterFils: number;
  depositAppliedFils: number;
  loyalty: Record<string, unknown>;
  voidableUntil: string;
}

interface ShortfallError {
  error: string;
  shortfallFils: number;
  balanceFils: number;
  dueFils: number;
  message: string;
}

/** #1 — nothing that represents money may be fractional, a string, or null. */
function expectIntegerFils(value: unknown, label: string): void {
  expect(typeof value, `${label} must be a number, got ${typeof value}`).toBe('number');
  expect(Number.isInteger(value as number), `${label} must be an integer fils value`).toBe(true);
}

// -------------------------------------------------------------- idempotency ---

describe('#4 — every money-moving POST requires an Idempotency-Key', () => {
  it('POST /topups without one is refused, and creates nothing', async () => {
    const res = await api<{ error: string; message: string }>('POST', '/topups', {
      body: { amountFils: 10_000, method: 'knet' },
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('idempotency_key_required');
    // No intent came back, so there is nothing for a client to redirect to.
    expect(res.body).not.toHaveProperty('id');
    expect(res.body).not.toHaveProperty('redirectUrl');
    expect(res.body).not.toHaveProperty('creditFils');
  });

  it('POST /charges without one is refused, and debits nothing', async () => {
    const res = await api<{ error: string }>('POST', '/charges', {
      body: { memberId: MEMBER_ID, serviceIds: [SERVICE.blowDry.id] },
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('idempotency_key_required');
    expect(res.body).not.toHaveProperty('transaction');
    expect(res.body).not.toHaveProperty('balanceAfterFils');
  });

  it(
    'POST /voids accepts a money-moving request with no Idempotency-Key — a retried void refunds twice',
    async () => {
      // Non-negotiable #4 lists voids explicitly: "Top-ups, charges, orders, voids."
      // A void puts credit back into a wallet, so a retried request is a double refund.
      const res = await api<{ error: string }>('POST', '/voids', {
        body: { transactionId: 'TX-9021', reason: 'retry safety' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('idempotency_key_required');
    },
  );
});

describe('#4 — replaying a key returns the identical result, never a second one', () => {
  it('POST /topups replay returns byte-identical JSON', async () => {
    const key = idempotencyKey('topup-replay');
    const first = await api<TopUpIntent>('POST', '/topups', {
      idempotencyKey: key,
      body: { amountFils: 10_000, method: 'knet' },
    });
    const second = await api<TopUpIntent>('POST', '/topups', {
      idempotencyKey: key,
      body: { amountFils: 10_000, method: 'knet' },
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    // The identity that matters: one intent id, so the gateway sees one attempt.
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.reference).toBe(first.body.reference);
    expect(second.body.creditFils).toBe(first.body.creditFils);
  });

  /**
   * SPEC CHANGED — design/api-contract.md § Addendum.
   *
   * This spec used to assert that a key reused with a DIFFERENT body replayed the
   * first result. Lane A implemented a 422, the contract was silent, and the
   * disagreement was settled against this spec:
   *
   *   "Replaying the first result is wrong because the client asked for something
   *    different and would be told it succeeded — a customer who retries a 5 KD
   *    top-up as 50 KD would be shown a 5 KD success and never learn the 50 never
   *    happened. That is a silent money bug, which is worse than an error."
   *
   * The rule now: same key + same body replays; same key + different body is a
   * 422 and does not execute. Lane A's API already answers 422 — proved against
   * the real API in tenancy.test.ts, "the same key with a DIFFERENT body is a
   * 422, not a replay of the first result". The MOCK still replays, because
   * packages/mock keys one Map on the header alone and never fingerprints the
   * body, so against the mock this is a knownBug rather than a passing spec.
   */
  knownBug('same key + a DIFFERENT body is a 422, not a replay of the first result', async () => {
    const key = idempotencyKey('topup-replay-mutated');
    const first = await api<TopUpIntent>('POST', '/topups', {
      idempotencyKey: key,
      body: { amountFils: 10_000, method: 'knet' },
    });
    precondition(first.status === 200, `the first top-up failed: ${first.status}`);

    const second = await api<{ error: string; id?: string }>('POST', '/topups', {
      idempotencyKey: key,
      body: { amountFils: 250_000, method: 'card' },
    });

    expect(second.status).toBe(422);
    expect(second.body.error).toBe('idempotency_key_reused');
  });

  it('the mutated retry never produces a second, larger intent — whichever way it is refused', async () => {
    // The half of the old spec that survives the ruling untouched, and the part
    // that actually protects money. Replay or 422, what must never happen is a
    // 250.000 KD intent created off a key that bought 10.000.
    const key = idempotencyKey('topup-replay-mutated-no-second');
    const first = await api<TopUpIntent>('POST', '/topups', {
      idempotencyKey: key,
      body: { amountFils: 10_000, method: 'knet' },
    });
    const second = await api<TopUpIntent>('POST', '/topups', {
      idempotencyKey: key,
      body: { amountFils: 250_000, method: 'card' },
    });

    expect(first.status).toBe(200);
    // Either no intent came back at all (422), or it is the first one verbatim.
    expect(second.body.id === undefined || second.body.id === first.body.id).toBe(true);
    expect(second.body.amountFils).not.toBe(250_000);
    expect(second.body.creditFils).not.toBe(250_000);
    expect(second.body.method).not.toBe('card');
  });

  it('POST /charges replay debits once — the balance after is the same, not twice down', async () => {
    const key = idempotencyKey('charge-replay');
    const body = { memberId: MEMBER_ID, serviceIds: [SERVICE.blowDry.id] };

    const first = await api<ChargeResult>('POST', '/charges', { idempotencyKey: key, body });
    const second = await api<ChargeResult>('POST', '/charges', { idempotencyKey: key, body });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.transaction.id).toBe(first.body.transaction.id);
    expect(second.body).toEqual(first.body);

    // Explicitly: 24.500 − 8.000 = 16.500, and NOT 8.500.
    expect(first.body.balanceAfterFils).toBe(BALANCE_FILS - SERVICE.blowDry.priceFils);
    expect(second.body.balanceAfterFils).toBe(BALANCE_FILS - SERVICE.blowDry.priceFils);
    expect(second.body.balanceAfterFils).not.toBe(BALANCE_FILS - SERVICE.blowDry.priceFils * 2);
  });

  it.todo(
    'after a replayed top-up, GET /members/me shows the balance moved by creditFils exactly once — the mock has no mutable balance, so this needs lane A',
  );
  /**
   * CLOSED — this was `it.todo('an idempotency key is scoped to one principal —
   * replaying a salon A key from salon B must not return salon A's result')`.
   *
   * It cannot be answered against packages/mock, which has one salon and one
   * global key Map. It is answered against lane A's real API in tenancy.test.ts,
   * § "idempotency keys do not collide across salons": the same key from a salon
   * A principal and a salon B principal produces two independent results, stored
   * under `member:8842` and `member:9001`, and the unique index is on
   * (scope, endpoint, key) rather than on the key alone.
   */

  it(
    'idempotency keys are not scoped to an endpoint — a key used on POST /topups is honoured by POST /charges',
    async () => {
      // packages/mock/src/server.ts holds one global Map keyed by the header alone.
      // A staff device that reuses a key across flows gets a TopUpIntent back from
      // POST /charges with a 200, and no debit ever happens.
      const key = idempotencyKey('cross-endpoint');
      const topup = await api<TopUpIntent>('POST', '/topups', {
        idempotencyKey: key,
        body: { amountFils: 10_000, method: 'knet' },
      });
      precondition(topup.status === 200, `the top-up leg failed: ${topup.status}`);

      const charge = await api<ChargeResult & TopUpIntent>('POST', '/charges', {
        idempotencyKey: key,
        body: { memberId: MEMBER_ID, serviceIds: [SERVICE.blowDry.id] },
      });

      // A charge must never answer with a top-up intent.
      expect(charge.body).not.toHaveProperty('creditFils');
      expect(charge.body).not.toHaveProperty('redirectUrl');
    },
  );
});

// --------------------------------------------------------------- commission ---

describe('commission — api-contract.md § Commission', () => {
  async function feeFor(amountFils: number, method: string): Promise<TopUpIntent> {
    const res = await api<TopUpIntent>('POST', '/topups', {
      idempotencyKey: idempotencyKey(`fee-${method}-${amountFils}`),
      body: { amountFils, method },
    });
    expect(res.status).toBe(200);
    return res.body;
  }

  it('KNET is 150 fils flat, at every amount', async () => {
    for (const amount of [1_000, 10_000, 25_000, 250_000]) {
      const intent = await feeFor(amount, 'knet');
      expectIntegerFils(intent.feeFils, `knet fee on ${amount}`);
      expect(intent.feeFils, `KNET fee on ${amount} fils must be flat 150`).toBe(150);
    }
  });

  it('card is 2.5% + 50 fils', async () => {
    const cases: Array<[amount: number, fee: number]> = [
      [10_000, 300], // 250 + 50
      [5_000, 175], //  125 + 50
      [25_000, 675], //  625 + 50
      [100_000, 2_550], // 2500 + 50
    ];
    for (const [amount, expected] of cases) {
      const intent = await feeFor(amount, 'card');
      expectIntegerFils(intent.feeFils, `card fee on ${amount}`);
      expect(intent.feeFils, `card fee on ${amount} fils`).toBe(expected);
    }
  });

  it('a card percentage that lands on a half fil rounds to an integer, never a float', async () => {
    // 2.5% of 3333 = 83.325 → 83, + 50 = 133. This is the case where a float
    // implementation shows itself.
    const intent = await feeFor(3_333, 'card');
    expect(intent.feeFils).toBe(133);
    expectIntegerFils(intent.feeFils, 'card fee on 3333');
    // 2.5% of 1010 = 25.25 → 25, + 50 = 75.
    expect((await feeFor(1_010, 'card')).feeFils).toBe(75);
  });

  it('Apple Pay is priced as a card', async () => {
    const intent = await feeFor(10_000, 'applepay');
    expect(intent.feeFils).toBe(300);
  });

  it('the commission is merchant-visible on the intent and never inflates the credit', async () => {
    // "Merchant-visible, customer-never." The fee is reported so the dashboard
    // can show it, but it must not touch what lands in the wallet.
    const intent = await feeFor(10_000, 'knet');
    expect(intent.creditFils).toBe(intent.amountFils + intent.bonusFils);
    expect(intent.creditFils).not.toBe(intent.amountFils + intent.bonusFils - intent.feeFils);
  });
});

// -------------------------------------------------------------- tier bonus ---

describe('#2 — the tier bonus is computed by the server', () => {
  it('Silver 10%: a 10.000 top-up credits 11.000', async () => {
    const res = await api<TopUpIntent>('POST', '/topups', {
      idempotencyKey: idempotencyKey('bonus-silver'),
      body: { amountFils: 10_000, method: 'knet' },
    });

    expect(res.status).toBe(200);
    expect(res.body.amountFils).toBe(10_000);
    expect(res.body.bonusFils).toBe(1_000);
    expect(res.body.creditFils).toBe(11_000);
    expectIntegerFils(res.body.amountFils, 'amountFils');
    expectIntegerFils(res.body.bonusFils, 'bonusFils');
    expectIntegerFils(res.body.creditFils, 'creditFils');
  });

  it('the bonus tracks the amount, so it is a rate and not a constant', async () => {
    const res = await api<TopUpIntent>('POST', '/topups', {
      idempotencyKey: idempotencyKey('bonus-silver-25'),
      body: { amountFils: 25_000, method: 'knet' },
    });
    expect(res.body.bonusFils).toBe(2_500);
    expect(res.body.creditFils).toBe(27_500);
  });

  it('a client-supplied bonus is ignored — the wallet cannot mint its own credit', async () => {
    // Non-negotiable #2. If this ever passes through, a patched client tops up
    // 1.000 KD and credits itself 1000.000.
    const res = await api<TopUpIntent>('POST', '/topups', {
      idempotencyKey: idempotencyKey('bonus-forged'),
      body: {
        amountFils: 10_000,
        method: 'knet',
        bonusFils: 999_999,
        creditFils: 999_999,
        feeFils: 0,
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.bonusFils).toBe(1_000);
    expect(res.body.creditFils).toBe(11_000);
    expect(res.body.feeFils).toBe(150);
  });

  it('bonus rounds to whole fils on an awkward amount', async () => {
    // 10% of 1005 = 100.5 → 101 (half-up), credit 1106. No half fil survives.
    const res = await api<TopUpIntent>('POST', '/topups', {
      idempotencyKey: idempotencyKey('bonus-rounding'),
      body: { amountFils: 1_005, method: 'knet' },
    });
    expectIntegerFils(res.body.bonusFils, 'bonusFils on 1005');
    expect(res.body.bonusFils).toBe(101);
    expect(res.body.creditFils).toBe(1_106);
  });

  it.todo(
    'a Bronze member gets 0% and a Gold member 20% on the same amount — needs a per-member scenario the mock does not expose (bonus is read off the single fixture member)',
  );
  it.todo(
    'in stamps mode the bonus is 0 regardless of tier — needs POST /topups to honour `x-avo-scenario: stamps` (it reads salon.loyaltyMode from the fixture, which the stamps scenario does not change)',
  );
});

// ------------------------------------------------------ insufficient balance --

describe('#3 — insufficient balance returns the exact shortfall and applies nothing', () => {
  it('402 carries shortfall, balance and due, and they reconcile', async () => {
    const res = await api<ShortfallError>('POST', '/charges', {
      scenario: 'lowbal',
      idempotencyKey: idempotencyKey('lowbal-exact'),
      body: { memberId: MEMBER_ID, serviceIds: [SERVICE.blowDry.id] },
    });

    expect(res.status).toBe(402);
    expect(res.body.error).toBe('insufficient_balance');
    expect(res.body.dueFils).toBe(SERVICE.blowDry.priceFils); // 8.000
    expect(res.body.balanceFils).toBe(LOWBAL_BALANCE_FILS); // 2.500
    expect(res.body.shortfallFils).toBe(5_500); // "Balance too low by 5.500"
    // The arithmetic must close, not merely look plausible.
    expect(res.body.shortfallFils).toBe(res.body.dueFils - res.body.balanceFils);
    expectIntegerFils(res.body.shortfallFils, 'shortfallFils');
    expectIntegerFils(res.body.balanceFils, 'balanceFils');
    expectIntegerFils(res.body.dueFils, 'dueFils');
  });

  it('the shortfall is exact on a larger service too', async () => {
    const res = await api<ShortfallError>('POST', '/charges', {
      scenario: 'lowbal',
      idempotencyKey: idempotencyKey('lowbal-exact-25'),
      body: { memberId: MEMBER_ID, serviceIds: [SERVICE.colourRoots.id] },
    });
    expect(res.body.dueFils).toBe(25_000);
    expect(res.body.shortfallFils).toBe(22_500);
  });

  it('nothing else happened: no transaction, no balance move, no loyalty tick', async () => {
    const res = await api<Record<string, unknown>>('POST', '/charges', {
      scenario: 'lowbal',
      idempotencyKey: idempotencyKey('lowbal-atomic'),
      body: { memberId: MEMBER_ID, serviceIds: [SERVICE.cutAndStyle.id] },
    });

    expect(res.status).toBe(402);
    expect(res.body).not.toHaveProperty('transaction');
    expect(res.body).not.toHaveProperty('balanceAfterFils');
    expect(res.body).not.toHaveProperty('loyalty'); // no visit, no stamp
    expect(res.body).not.toHaveProperty('voidableUntil');

    const member = await api<{ balanceFils: number; visits: number }>('GET', '/members/me');
    expect(member.body.balanceFils).toBe(BALANCE_FILS);
    expect(member.body.visits).toBe(5);
  });

  it('a partial charge is never attempted — the whole basket fails or none of it', async () => {
    // 8.000 + 15.000 = 23.000 due against 2.500. The affordable line is not
    // charged on its own; the shortfall covers the full basket.
    const res = await api<ShortfallError>('POST', '/charges', {
      scenario: 'lowbal',
      idempotencyKey: idempotencyKey('lowbal-basket'),
      body: {
        memberId: MEMBER_ID,
        serviceIds: [SERVICE.blowDry.id, SERVICE.cutAndStyle.id],
      },
    });
    expect(res.status).toBe(402);
    expect(res.body.dueFils).toBe(23_000);
    expect(res.body.shortfallFils).toBe(20_500);
  });

  it('a failed charge does not burn its idempotency key — the retry after a top-up goes through', async () => {
    // The scanner retries the same attempt once the customer has topped up. If
    // the failed attempt had cached a 402 against the key, that retry would be
    // answered with a stale refusal forever.
    const key = idempotencyKey('lowbal-then-retry');
    const failed = await api<ShortfallError>('POST', '/charges', {
      scenario: 'lowbal',
      idempotencyKey: key,
      body: { memberId: MEMBER_ID, serviceIds: [SERVICE.blowDry.id] },
    });
    expect(failed.status).toBe(402);

    const retried = await api<ChargeResult>('POST', '/charges', {
      idempotencyKey: key,
      body: { memberId: MEMBER_ID, serviceIds: [SERVICE.blowDry.id] },
    });
    expect(retried.status).toBe(200);
    expect(retried.body.balanceAfterFils).toBe(BALANCE_FILS - SERVICE.blowDry.priceFils);
  });

  it(
    'a 402 insufficient_balance leaves the wallet token unconsumed',
    async () => {
      // packages/mock/src/server.ts POST /charges deletes the token BEFORE the
      // balance check, so a customer whose balance is short loses her QR: the
      // scanner cannot retry after she tops up, she has to re-open the app.
      const token = await mintWalletToken();
      const resolvedFirst = await api('POST', '/scans', { body: { token } });
      precondition(resolvedFirst.status === 200, `the token did not resolve: ${resolvedFirst.status}`);

      const charge = await api<ShortfallError>('POST', '/charges', {
        scenario: 'lowbal',
        idempotencyKey: idempotencyKey('lowbal-token'),
        body: { memberId: MEMBER_ID, serviceIds: [SERVICE.colourRoots.id], token },
      });
      precondition(charge.status === 402, `expected a 402, got ${charge.status}`);

      // The debit failed, so the token must still be live.
      const resolvedAfter = await api<{ error?: string }>('POST', '/scans', { body: { token } });
      expect(resolvedAfter.status).toBe(200);
    },
  );
});

// ------------------------------------------------------- float / bad amounts --

describe('#1 — no float and no negative amount reaches money', () => {
  it('a fractional amountFils is rejected and creates nothing', async () => {
    const res = await api<Record<string, unknown>>('POST', '/topups', {
      idempotencyKey: idempotencyKey('float-amount'),
      body: { amountFils: 10.5, method: 'knet' },
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body).not.toHaveProperty('creditFils');
    expect(res.body).not.toHaveProperty('redirectUrl');
  });

  it('a KWD amount sent where fils are expected is rejected', async () => {
    // The classic: the client sends 18.5 meaning 18.500 KD.
    const res = await api<Record<string, unknown>>('POST', '/topups', {
      idempotencyKey: idempotencyKey('kwd-amount'),
      body: { amountFils: 18.5, method: 'knet' },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body).not.toHaveProperty('creditFils');
  });

  it('a fractional amount answers 500, not a 400 the client can act on', async () => {
    const res = await api<{ error?: string; message?: string }>('POST', '/topups', {
      idempotencyKey: idempotencyKey('float-amount-400'),
      body: { amountFils: 10.5, method: 'knet' },
    });
    expect(res.status).toBe(400);
    // And the internal money helper's message must not be handed to a caller.
    expect(JSON.stringify(res.body)).not.toMatch(/Money must be an integer number of fils/);
  });

  it('a negative amountFils creates a top-up intent for negative credit', async () => {
    // Currently returns 200 with amountFils −10000, bonusFils −1000,
    // creditFils −11000 and a 150 fil fee. A drain path dressed as a top-up.
    const res = await api<TopUpIntent>('POST', '/topups', {
      idempotencyKey: idempotencyKey('negative-amount'),
      body: { amountFils: -10_000, method: 'knet' },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('an unknown serviceId is charged as 0 fils instead of being rejected', async () => {
    // A settled 0.000 transaction with a real reference and a voidable window,
    // for services that do not exist. Any typo in a scanner payload lands here.
    const res = await api<ChargeResult>('POST', '/charges', {
      idempotencyKey: idempotencyKey('unknown-service'),
      body: { memberId: MEMBER_ID, serviceIds: ['SV-DOES-NOT-EXIST'] },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

// --------------------------------------------------- authoritative status read --

describe('the top-up status read is authoritative — api-contract.md § TopUpIntent', () => {
  it('reports the four terminal outcomes distinctly', async () => {
    const created = await api<TopUpIntent>('POST', '/topups', {
      idempotencyKey: idempotencyKey('outcomes'),
      body: { amountFils: 10_000, method: 'knet' },
    });
    const id = created.body.id;

    const succeeded = await api<TopUpIntent>('GET', `/topups/${id}`);
    const declined = await api<TopUpIntent>('GET', `/topups/${id}`, { scenario: 'declined' });
    const cancelled = await api<TopUpIntent>('GET', `/topups/${id}`, { scenario: 'cancelled' });
    const pending = await api<TopUpIntent>('GET', `/topups/${id}`, { scenario: 'pending' });

    expect(succeeded.body.status).toBe('succeeded');
    expect(declined.body.status).toBe('failed');
    expect(cancelled.body.status).toBe('cancelled');
    // `pending` is its own screen and must never be collapsed into success or
    // failure — that is how double charges happen.
    expect(pending.body.status).toBe('pending');
    expect(['succeeded', 'failed', 'cancelled']).not.toContain(pending.body.status);
  });

  it('GET /topups/{id} ignores the id and returns whichever intent is first in memory', async () => {
    // packages/mock/src/server.ts:228 searches the idempotency map for anything
    // with a redirectUrl and returns that. Two customers topping up at once get
    // each other's amounts back, and the wallet renders the wrong figure.
    const first = await api<TopUpIntent>('POST', '/topups', {
      idempotencyKey: idempotencyKey('status-a'),
      body: { amountFils: 10_000, method: 'knet' },
    });
    const second = await api<TopUpIntent>('POST', '/topups', {
      idempotencyKey: idempotencyKey('status-b'),
      body: { amountFils: 25_000, method: 'card' },
    });
    precondition(first.status === 200 && second.status === 200, 'could not create two intents');
    precondition(first.body.id !== second.body.id, 'the two intents share an id');

    const read = await api<TopUpIntent>('GET', `/topups/${second.body.id}`);
    expect(read.body.id).toBe(second.body.id);
    expect(read.body.amountFils).toBe(25_000);
  });

  it('GET /topups/{unknown-id} answers 200 succeeded instead of 404', async () => {
    // A client polling a fabricated or stale intent id is told the money landed.
    const read = await api<TopUpIntent>('GET', '/topups/TI-NOT-A-REAL-INTENT');
    expect(read.status).toBe(404);
  });
});
