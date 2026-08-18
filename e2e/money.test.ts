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

/**
 * READ THIS FIRST: THIS FILE RUNS AGAINST `packages/mock`, NOT AGAINST THE API.
 *
 * `support/global-setup.ts` points `E2E_BASE_URL` at `packages/mock`, which holds its
 * state in `Map`s and has no database. So the money GUARANTEES are not proved here —
 * they are proved against Postgres elsewhere, and several of the specs below exist to
 * document where the mock DIVERGES from the API, which is a different and smaller job:
 *
 *   non-negotiable #4, replay and the Idempotency-Key
 *       → scanner.test.ts "a replay with the same key debits once and returns the
 *         first result verbatim", and tenancy.test.ts "the same key with a DIFFERENT
 *         body is a 422, not a replay of the first result"
 *   non-negotiable #4 under a real RACE, two requests at once under one key
 *       → scanner.test.ts "racing — two charges under ONE idempotency key"
 *   non-negotiable #3, the shortfall and nothing else happening
 *       → deposit.test.ts "a shortfall on the remainder leaves the hold, the booking
 *         and the visit count exactly as they were"
 *   the tier bonus and the commission on a real top-up
 *       → gateway.test.ts, which settles through the real gateway path
 *
 * The specs here that assert the mock answering 500 on a fractional amount, or
 * accepting a negative one, or charging an unknown service as 0 fils, are NOT
 * assertions about the product. They are a written record of what the mock lies about,
 * for the lanes building against it — which is how the wallet's auth gap stayed hidden
 * for a week, and worth keeping for exactly that reason.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  ensureBalanceAtLeast,
  LOWBAL_BALANCE_FILS,
  MEMBER_ID,
  SERVICE,
  TIER_BONUS_PERCENT,
  api,
  idempotencyKey,
  memberNow,
  mintWalletToken,
} from './support/api.js';
import { precondition } from './support/known-bug.js';

/**
 * NO `targetKind()` HERE ANY MORE, AND THAT IS THE GOOD OUTCOME.
 *
 * This file briefly resolved which server it was driving so that the mutated-retry
 * spec could be registered as a passing `it()` against lane A's API and a
 * `knownBug()` against `packages/mock`, which replayed instead of refusing. Trunk
 * has since taught the mock to fingerprint request bodies, the two servers agree,
 * and every spec in this file is one plain statement true of both again.
 *
 * If a future divergence needs it back, `targetKind()` is still in support/api.ts
 * and `permissions.test.ts` still uses it.
 */

/**
 * The same floor `concurrency.test.ts` documents, for the same reason and with
 * the same mechanism. This file settles charges of 8.000, 15.000 and 25.000 KD
 * across a dozen specs; lane A seeds the shared member at 24.500, and each of
 * these suites spends what the one before it left. On a freshly seeded database
 * the first run cleared and the SECOND run went red on
 * "a failed charge does not burn its idempotency key" — a spec about idempotency
 * failing because the retry it makes could not be afforded.
 *
 * Deliberately several times what the file spends. Running out halfway is the
 * failure mode being fixed, and a tight floor reproduces it.
 */
const FLOOR_FILS = 250_000;

beforeAll(async () => {
  await ensureBalanceAtLeast(FLOOR_FILS, 'money');
}, 60_000);

interface TopUpIntent {
  id: string;
  memberId: string;
  amountFils: number;
  bonusFils: number;
  creditFils: number;
  method: string;
  /**
   * OPTIONAL, AND THE `?` IS THE POINT.
   *
   * `POST /topups` still answers with the full shape today and lane A is applying
   * `TopUpIntentPublicSchema` to it — see the commission block below. Typed as
   * required, this file would stop compiling the day that lands, which would make
   * a correct fix look like a lane D breakage. Nothing here reads it.
   */
  feeFils?: number;
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
   * 422 and does not execute.
   *
   * PROMOTED, UNCONDITIONALLY — and the history is worth keeping because it is
   * the shape of a spec doing its job.
   *
   * This was a `knownBug()`, then briefly a spec registered BY TARGET: lane A's
   * API answered 422 and `packages/mock` replayed, because the mock keyed one Map
   * on the header alone and never fingerprinted the body. Two servers disagreeing
   * about a money rule is not a thing a suite should paper over, so the
   * conditional named the mock as the owner and kept the gap on the books.
   *
   * Trunk has since fixed it — `packages/mock/src/server.ts` now fingerprints the
   * request body the way `api/src/services/idempotency.ts` does. Both servers
   * answer 422, so the conditional is dead weight and the spec is one plain
   * statement about both again.
   */
  it('same key + a DIFFERENT body is a 422, not a replay of the first result', async () => {
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
    // Read first, assert the delta. The absolute 24.500 this used to expect was
    // the mock's fixture, and against a real database it became an assertion
    // about how many earlier runs had charged her. See `memberNow()`.
    const before = (await memberNow()).balanceFils;

    const first = await api<ChargeResult>('POST', '/charges', { idempotencyKey: key, body });
    const second = await api<ChargeResult>('POST', '/charges', { idempotencyKey: key, body });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.transaction.id).toBe(first.body.transaction.id);
    expect(second.body).toEqual(first.body);

    // Down by the price ONCE — explicitly not twice, which is the whole spec.
    expect(first.body.balanceAfterFils).toBe(before - SERVICE.blowDry.priceFils);
    expect(second.body.balanceAfterFils).toBe(before - SERVICE.blowDry.priceFils);
    expect(second.body.balanceAfterFils).not.toBe(before - SERVICE.blowDry.priceFils * 2);
    // NOT asserted here: that GET /members/me now agrees with balanceAfterFils.
    // `packages/mock` has no mutable balance and answers 24.500 forever, so that
    // check would be red against the mock and green against the real API for
    // reasons that have nothing to do with idempotency. It is the `it.todo`
    // immediately below, and it is answered against lane A's API in
    // gateway.test.ts, where the balance is read out of Postgres.
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

/**
 * THE COMMISSION ARITHMETIC HAS MOVED — `e2e/integration.test.ts`, "the
 * commission is computed and persisted".
 *
 * WHY, BECAUSE A SUITE THAT LOSES FIVE SPECS OWES AN EXPLANATION
 * --------------------------------------------------------------
 * Five specs here read `feeFils` off the `POST /topups` RESPONSE and asserted the
 * rate table against it. They were correct about the arithmetic and wrong about
 * where to look, and the two suites in this directory had ended up contradicting
 * each other on it:
 *
 *   money.test.ts        POST /topups MUST carry feeFils   (five specs)
 *   integration.test.ts  no customer response may carry a fee (the sweep)
 *
 * `POST /topups` is a customer endpoint — the wallet calls it to start a top-up —
 * so the customer-never rule of api-contract.md § Commission applies to it exactly
 * as it applies to `GET /topups/{id}`. Lane A had already resolved the read side
 * with `TopUpIntentPublicSchema` and `serialiseIntentForCustomer`, and left
 * `POST /topups` on the full shape with a comment naming these five specs as the
 * reason it could not move. This block was the blocker.
 *
 * So the assertions moved rather than died, and they moved onto
 * `topup_intent.fee_fils` — the pattern this suite already uses for `receipt_job`:
 * prove the behaviour against the TABLE, not through a response a customer reads.
 * The commission is still asserted to the fil, at every rate, including the
 * rounding cases. It is asserted where the number actually lives.
 *
 * IT COULD NOT STAY IN THIS FILE. These specs run against `packages/mock` by
 * default, with no Postgres and no docker (see `memberNow()`), so this file has
 * no way to read a column. `integration.test.ts` boots lane A's real API against
 * lane A's real database and already reads `fee_fils` there.
 *
 * WHAT STAYS HERE is the half that needs no fee field at all, and it is the half
 * that protects the customer's money.
 */
describe('commission — api-contract.md § Commission', () => {
  it('the commission never inflates OR reduces what lands in the wallet', async () => {
    // "Merchant-visible, customer-never." Whatever AVO takes, the credit is
    // amount + bonus and nothing else — this holds without the response ever
    // naming a fee, which is exactly why it is the spec that survives here.
    const res = await api<TopUpIntent>('POST', '/topups', {
      idempotencyKey: idempotencyKey('fee-does-not-touch-credit'),
      body: { amountFils: 10_000, method: 'knet' },
    });
    expect(res.status).toBe(200);
    const intent = res.body;

    expectIntegerFils(intent.amountFils, 'amountFils');
    expectIntegerFils(intent.bonusFils, 'bonusFils');
    expectIntegerFils(intent.creditFils, 'creditFils');
    expect(intent.creditFils).toBe(intent.amountFils + intent.bonusFils);

    // KNET is 150 flat, so a credit netted of the commission would be 150 short.
    // Stated as a literal rather than read from the response: the point is that
    // the customer's credit is unaffected by a number she is not shown.
    expect(intent.creditFils).not.toBe(intent.amountFils + intent.bonusFils - 150);
  });

  it('the same holds on a card, where the commission is a percentage', async () => {
    // 2.5% + 50 on 10.000 is 300 — big enough that netting it out would be
    // obvious, which is the point of checking a second method.
    const res = await api<TopUpIntent>('POST', '/topups', {
      idempotencyKey: idempotencyKey('fee-does-not-touch-credit-card'),
      body: { amountFils: 10_000, method: 'card' },
    });
    expect(res.status).toBe(200);
    expect(res.body.creditFils).toBe(res.body.amountFils + res.body.bonusFils);
    expect(res.body.creditFils).not.toBe(res.body.amountFils + res.body.bonusFils - 300);
  });
});

// -------------------------------------------------------------- tier bonus ---

/**
 * THE TIER BONUS, WITHOUT PINNING WHICH TIER SHE IS IN.
 *
 * These four specs used to write Silver's 10% into every expectation —
 * `bonusFils` is 1.000 on 10.000, full stop. That is correct against
 * `packages/mock`, whose member is rebuilt Silver on every boot, and it decays
 * against a real database: `applyVisits` walks the seeded member up the ladder
 * as the other suites charge her, and by the time this ran against lane A's API
 * she was Black on 30%. Four red specs, no defect.
 *
 * THE RATE IS STILL A LITERAL. `TIER_BONUS_PERCENT` is the ladder copied out of
 * design/api-contract.md § Commission — bronze 0, silver 10, gold 20, black 30 —
 * and the arithmetic below is written out here rather than borrowed from
 * `percentOf()`. What is read at runtime is only WHICH RUNG she is on, which is
 * the part that legitimately moves. The server and this file can still disagree
 * about the bonus, which is the whole point of the specs.
 */
describe('#2 — the tier bonus is computed by the server', () => {
  /** The contract's rate for the tier she is actually in, right now. */
  async function rate(): Promise<{ tier: string; percent: number }> {
    const { tier } = await memberNow();
    const percent = TIER_BONUS_PERCENT[tier];
    expect(percent, `the tier ladder in api-contract.md has no rung called "${tier}"`).toBeDefined();
    return { tier, percent: percent as number };
  }

  /** Half-up to whole fils. Non-negotiable #1 — no half fil survives anywhere. */
  const bonusFor = (amountFils: number, percent: number) =>
    Math.round((amountFils * percent) / 100);

  it('a top-up credits the amount plus her tier\'s percentage of it', async () => {
    const { tier, percent } = await rate();
    const res = await api<TopUpIntent>('POST', '/topups', {
      idempotencyKey: idempotencyKey('bonus-tier'),
      body: { amountFils: 10_000, method: 'knet' },
    });

    expect(res.status).toBe(200);
    expect(res.body.amountFils).toBe(10_000);
    expect(res.body.bonusFils, `${tier} is ${percent}% on 10.000`).toBe(bonusFor(10_000, percent));
    expect(res.body.creditFils).toBe(10_000 + bonusFor(10_000, percent));
    expectIntegerFils(res.body.amountFils, 'amountFils');
    expectIntegerFils(res.body.bonusFils, 'bonusFils');
    expectIntegerFils(res.body.creditFils, 'creditFils');
  });

  it('the bonus tracks the amount, so it is a rate and not a constant', async () => {
    // The assertion that survives the tier moving under it, and the one that
    // actually catches a bonus implemented as a flat number: 2.5x the amount
    // must be 2.5x the bonus.
    const { percent } = await rate();
    const small = await api<TopUpIntent>('POST', '/topups', {
      idempotencyKey: idempotencyKey('bonus-rate-10'),
      body: { amountFils: 10_000, method: 'knet' },
    });
    const large = await api<TopUpIntent>('POST', '/topups', {
      idempotencyKey: idempotencyKey('bonus-rate-25'),
      body: { amountFils: 25_000, method: 'knet' },
    });

    expect(small.body.bonusFils).toBe(bonusFor(10_000, percent));
    expect(large.body.bonusFils).toBe(bonusFor(25_000, percent));
    expect(large.body.creditFils).toBe(25_000 + bonusFor(25_000, percent));
    if (percent > 0) {
      expect(large.body.bonusFils, 'the bonus is a constant, not a rate').toBe(
        small.body.bonusFils * 2.5,
      );
    }
  });

  it('a client-supplied bonus is ignored — the wallet cannot mint its own credit', async () => {
    // Non-negotiable #2. If this ever passes through, a patched client tops up
    // 1.000 KD and credits itself 1000.000.
    const { percent } = await rate();
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
    expect(res.body.bonusFils).toBe(bonusFor(10_000, percent));
    expect(res.body.creditFils).toBe(10_000 + bonusFor(10_000, percent));
    // The forged values are nowhere near the answer, whatever her tier is.
    expect(res.body.bonusFils).not.toBe(999_999);
    expect(res.body.creditFils).not.toBe(999_999);
    // The forged `feeFils: 0` is checked in integration.test.ts against
    // `topup_intent.fee_fils`, for the reason the commission block above gives:
    // a customer response is the wrong place to read a commission from, so it is
    // also the wrong place to prove one was not forged.
  });

  it('bonus rounds to whole fils on an awkward amount', async () => {
    // The case where a float implementation shows itself. At Silver, 10% of 1005
    // is 100.5 → 101 half-up, credit 1106; at Gold, 201 → 1206. Whichever rung
    // she is on, what must never come back is 100.5.
    const { percent } = await rate();
    const res = await api<TopUpIntent>('POST', '/topups', {
      idempotencyKey: idempotencyKey('bonus-rounding'),
      body: { amountFils: 1_005, method: 'knet' },
    });
    expectIntegerFils(res.body.bonusFils, 'bonusFils on 1005');
    expectIntegerFils(res.body.creditFils, 'creditFils on 1005');
    expect(res.body.bonusFils).toBe(bonusFor(1_005, percent));
    expect(res.body.creditFils).toBe(1_005 + bonusFor(1_005, percent));
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
    const before = await memberNow();

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

    // Unchanged from what it was a moment ago, not equal to a fixture literal:
    // "nothing happened" is a statement about a delta.
    const after = await memberNow();
    expect(after.balanceFils, 'a refused charge moved the balance').toBe(before.balanceFils);
    expect(after.visits, 'a refused charge ticked a visit').toBe(before.visits);
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
    const before = (await memberNow()).balanceFils;

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
    expect(retried.status, `the retry under a key a 402 had used answered: ${retried.status}`).toBe(
      200,
    );
    expect(retried.body.balanceAfterFils).toBe(before - SERVICE.blowDry.priceFils);
  });

  it(
    'a 402 insufficient_balance leaves the wallet token unconsumed',
    async () => {
      // packages/mock/src/server.ts POST /charges deletes the token BEFORE the
      // balance check, so a customer whose balance is short loses her QR: the
      // scanner cannot retry after she tops up, she has to re-open the app.
      // SCENARIO ON THE MINT TOO, and this is not tidiness. Against the mock the
      // header changes nothing. Against the real API `lowbal` selects a
      // DIFFERENT SEEDED MEMBER — a real API cannot fabricate a balance, so the
      // scenario changes whose wallet is in play. Minting without it produced a
      // token for Dana and then charged Reem, and lane A's token/member check
      // correctly answered 409 `token_member_mismatch`. The spec was stale, not
      // the API: it was written when `lowbal` only substituted a number.
      const token = await mintWalletToken('lowbal');
      const resolvedFirst = await api('POST', '/scans', {
        scenario: 'lowbal',
        body: { token },
      });
      precondition(resolvedFirst.status === 200, `the token did not resolve: ${resolvedFirst.status}`);

      const charge = await api<ShortfallError>('POST', '/charges', {
        scenario: 'lowbal',
        idempotencyKey: idempotencyKey('lowbal-token'),
        body: { memberId: MEMBER_ID, serviceIds: [SERVICE.colourRoots.id], token },
      });
      precondition(
        charge.status === 402,
        `expected a 402, got ${charge.status} ${JSON.stringify(charge.body)}`,
      );

      // The debit failed, so the token must still be live.
      const resolvedAfter = await api<{ error?: string }>('POST', '/scans', {
        scenario: 'lowbal',
        body: { token },
      });
      expect(resolvedAfter.status).toBe(200);
    },
  );
});

// ------------------------------------------------------- float / bad amounts --

/**
 * #1 — NO FLOAT AND NO NEGATIVE AMOUNT REACHES MONEY.
 *
 * SIX SPECS IN THIS FILE USED TO BE TITLED AS DEFECTS AND ASSERTED THE FIX.
 *
 * "a fractional amount answers 500, not a 400 the client can act on".
 * "a negative amountFils creates a top-up intent for negative credit".
 * "an unknown serviceId is charged as 0 fils instead of being rejected".
 * "GET /topups/{id} ignores the id and returns whichever intent is first in memory".
 * "GET /topups/{unknown-id} answers 200 succeeded instead of 404".
 *
 * Every one of those titles described a real defect when it was written. Every one
 * has since been fixed in `packages/mock`, and every one of those specs kept
 * passing — because the ASSERTIONS were written against the contract while the
 * TITLES described the bug. Probed directly to be sure rather than inferred from a
 * green run:
 *
 *   POST /topups  amountFils: 10.5    → 400 invalid_amount
 *                                       "must be a whole number of fils"
 *   POST /topups  amountFils: -10000  → 400 invalid_amount
 *                                       "must be greater than zero"
 *   POST /charges unknown serviceId   → 400 invalid_services, naming the id
 *   GET  /topups/TI-NOPE              → 404 unknown_topup
 *   two intents read by their own ids  → each returns its own amount
 *
 * So the file was carrying five confident sentences that were false, in the place a
 * reader looks first. That is the failure mode this build keeps producing, and the
 * mechanism that prevents it is the one already in this repository: a spec that
 * documents a defect must be a `knownBug()`, which asserts the CONTRACT and goes
 * RED the day the defect is fixed. Written as a plain `it()` it does the opposite —
 * it preserves the claim for ever and reports green while doing it.
 *
 * THE RULE FOR THIS FILE, THEREFORE: a divergence between `packages/mock` and the
 * API is written as `knownBug()`, never as an `it()` whose title says what is
 * broken. There is one such divergence left and it is at the bottom of
 * concurrency.test.ts.
 *
 * The assertions below are also strengthened. `expect(status).toBeGreaterThanOrEqual(400)`
 * passes on a 500 — which is how "answers 500, not a 400" could sit beside an
 * assertion demanding 400 without either being noticed. Each now names the status
 * AND the error code, so a regression to a 500 fails instead of qualifying.
 */
describe('#1 — no float and no negative amount reaches money', () => {
  it('a fractional amountFils is refused with an actionable 400, and creates nothing', async () => {
    const res = await api<Record<string, unknown>>('POST', '/topups', {
      idempotencyKey: idempotencyKey('float-amount'),
      body: { amountFils: 10.5, method: 'knet' },
    });

    // 400 and not merely ">= 400": a 500 here is the money helper's TypeError
    // escaping, which tells the client nothing it can act on and leaks the shape
    // of the money layer. That distinction was the whole point of the old title.
    expect(res.status, `a fractional amount answered ${res.status}: ${JSON.stringify(res.body)}`).toBe(400);
    expect(res.body.error).toBe('invalid_amount');
    expect(res.body).not.toHaveProperty('creditFils');
    expect(res.body).not.toHaveProperty('redirectUrl');
    // And the internal helper's own words never reach a caller.
    expect(JSON.stringify(res.body)).not.toMatch(/Money must be an integer number of fils/);
  });

  it('a KWD amount sent where fils are expected is refused the same way', async () => {
    // The classic: the client sends 18.5 meaning 18.500 KD.
    const res = await api<Record<string, unknown>>('POST', '/topups', {
      idempotencyKey: idempotencyKey('kwd-amount'),
      body: { amountFils: 18.5, method: 'knet' },
    });
    expect(res.status, `18.5 answered ${res.status}`).toBe(400);
    expect(res.body.error).toBe('invalid_amount');
    expect(res.body).not.toHaveProperty('creditFils');
    // The refusal has to teach the unit, because this is the mistake a client makes
    // once and then makes again.
    expect(String(res.body.message)).toMatch(/whole number of fils/i);
  });

  it('a negative amountFils is refused — a top-up cannot be a drain', async () => {
    const res = await api<Record<string, unknown>>('POST', '/topups', {
      idempotencyKey: idempotencyKey('negative-amount'),
      body: { amountFils: -10_000, method: 'knet' },
    });
    expect(res.status, `-10000 answered ${res.status}: ${JSON.stringify(res.body)}`).toBe(400);
    expect(res.body.error).toBe('invalid_amount');
    // Nothing that looks like an intent came back. The defect this replaces
    // returned 200 with creditFils −11000 and a 150 fil fee.
    expect(res.body).not.toHaveProperty('creditFils');
    expect(res.body).not.toHaveProperty('redirectUrl');
  });

  it('an unknown serviceId is refused, and the refusal names it', async () => {
    const res = await api<Record<string, unknown>>('POST', '/charges', {
      idempotencyKey: idempotencyKey('unknown-service'),
      body: { memberId: MEMBER_ID, serviceIds: ['SV-DOES-NOT-EXIST'] },
    });
    expect(res.status, `an unknown service answered ${res.status}`).toBe(400);
    expect(res.body.error).toBe('invalid_services');
    /**
     * NAMING THE UNKNOWN ID IS THE POINT. The defect this replaces settled a
     * 0.000 charge with a real reference and a voidable window, so a typo in a
     * scanner payload produced a receipt for nothing. A refusal that does not say
     * WHICH id was wrong sends the staff member back to guess.
     */
    expect(String(JSON.stringify(res.body))).toContain('SV-DOES-NOT-EXIST');
    expect(res.body).not.toHaveProperty('transaction');
  });
});

// --------------------------------------------------- authoritative status read --

describe('the top-up status read is authoritative — api-contract.md § TopUpIntent', () => {
  /**
   * SPEC REPAIRED — this was lane D's own bug, not the API's.
   *
   * It used to create ONE intent and read it four times, once per scenario,
   * expecting succeeded, failed, cancelled and pending back. Against the mock
   * that passed, because the mock computes a status per request out of the
   * `x-avo-scenario` header and stores nothing.
   *
   * It was still wrong, and wrong in the direction that matters. An intent is a
   * state machine with one ending: `created → redirected → pending →` exactly one
   * of `succeeded | failed | cancelled`, and no arrow out of a terminal state.
   * The old spec asserted that one intent can be all four things, which is the
   * precise property lane A's machine exists to make impossible — so as written
   * it would have to be deleted or weakened the day the real API answered it.
   * A spec that a correct implementation must break is not a guard.
   *
   * Four outcomes therefore need four intents. That reads the same way against
   * the mock (a per-id lookup and a per-request scenario) and against lane A's
   * API (a per-intent sandbox payment driven to its own outcome), which is what
   * makes it worth writing this way rather than pointing it at one of them.
   *
   * What survives verbatim is the assertion that actually protects money:
   * `pending` is its own state and is never collapsed into success or failure.
   */
  it('reports succeeded, failed, cancelled and pending — one intent each, because an intent has one ending', async () => {
    const cases: Array<{ scenario?: string; expected: string; why: string }> = [
      { expected: 'succeeded', why: 'the money landed' },
      { scenario: 'declined', expected: 'failed', why: 'the card was refused' },
      { scenario: 'cancelled', expected: 'cancelled', why: 'she closed the page' },
      { scenario: 'pending', expected: 'pending', why: 'the processor has not decided' },
    ];

    const seen: Array<{ id: string; status: string }> = [];

    for (const c of cases) {
      const created = await api<TopUpIntent>('POST', '/topups', {
        idempotencyKey: idempotencyKey(`outcome-${c.expected}`),
        body: { amountFils: 10_000, method: 'knet' },
      });
      expect(created.status, `could not create the ${c.expected} intent: ${created.status}`).toBe(
        200,
      );

      const read = await api<TopUpIntent>('GET', `/topups/${created.body.id}`, {
        ...(c.scenario === undefined ? {} : { scenario: c.scenario }),
      });

      expect(read.status).toBe(200);
      // The read is of THIS intent. Without this the four assertions below could
      // all be satisfied by one shared row.
      expect(read.body.id, `GET /topups/${created.body.id} answered about a different intent`).toBe(
        created.body.id,
      );
      expect(read.body.status, `${c.why} → ${c.expected}`).toBe(c.expected);

      seen.push({ id: read.body.id, status: read.body.status });
    }

    // Four intents, not one read four times.
    expect(new Set(seen.map((s) => s.id)).size, 'the four outcomes shared an intent').toBe(4);
    expect(seen.map((s) => s.status)).toEqual(['succeeded', 'failed', 'cancelled', 'pending']);

    // `pending` is its own screen and must never be collapsed into success or
    // failure — that is how double charges happen. (api-contract.md
    // § TopUpIntent, client rule 2: no retry is offered from pending.)
    const pending = seen[3];
    expect(['succeeded', 'failed', 'cancelled']).not.toContain(pending?.status);
  });

  it('GET /topups/{id} answers about THAT intent — two customers do not see each other\'s', async () => {
    /**
     * The defect this replaces: `packages/mock` searched its idempotency map for
     * anything carrying a redirectUrl and returned that, so two customers topping
     * up at once each got the other's amount and the wallet rendered the wrong
     * figure. Fixed; the assertion below is the contract and always was.
     *
     * TWO INTENTS WITH DIFFERENT AMOUNTS is what makes this readable: if the read
     * were still id-blind, the amounts are what would give it away, and a spec
     * using one amount twice could not tell.
     */
    const first = await api<TopUpIntent>('POST', '/topups', {
      idempotencyKey: idempotencyKey('status-a'),
      body: { amountFils: 10_000, method: 'knet' },
    });
    const second = await api<TopUpIntent>('POST', '/topups', {
      idempotencyKey: idempotencyKey('status-b'),
      body: { amountFils: 25_000, method: 'knet' },
    });
    precondition(first.status === 200 && second.status === 200, 'could not create two intents');
    precondition(first.body.id !== second.body.id, 'the two top-ups share an id');

    const readFirst = await api<TopUpIntent>('GET', `/topups/${first.body.id}`);
    expect(readFirst.status, JSON.stringify(readFirst.body)).toBe(200);
    expect(
      readFirst.body.id,
      'the read answered about a different intent, so a client polling its own top-up is shown ' +
        "somebody else's",
    ).toBe(first.body.id);
    expect(readFirst.body.amountFils).toBe(10_000);

    // And the other one still reads as itself, which is what rules out a read that
    // simply returns the OLDEST rather than the requested one.
    const readSecond = await api<TopUpIntent>('GET', `/topups/${second.body.id}`);
    expect(readSecond.body.id).toBe(second.body.id);
    expect(readSecond.body.amountFils).toBe(25_000);
  });

  it('GET /topups/{unknown-id} is a 404, not a cheerful success', async () => {
    // The defect this replaces answered 200 `succeeded`, so a client polling a
    // fabricated or stale intent id was told the money had landed.
    const read = await api<Record<string, unknown>>('GET', '/topups/TI-DOES-NOT-EXIST');
    expect(read.status, `an unknown intent id answered ${read.status}`).toBe(404);
    expect(read.body.error).toBe('unknown_topup');
    expect(read.body).not.toHaveProperty('creditFils');
    expect(read.body.status).not.toBe('succeeded');
  });
});
