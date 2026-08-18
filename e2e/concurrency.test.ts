/**
 * The concurrency cases from design/go-live-checklist.md § Money:
 *
 *   "Concurrency suite green: double scan, double submit, duplicate callback,
 *    callback before client return, charge during a happy-hour boundary"
 *
 * Two kinds of spec live here.
 *
 * Running specs assert behaviour the API already has to get right. Where the
 * mock passes one of them for a reason that will NOT hold in lane A's API — a
 * single Node process serialises what a multi-process API cannot — the comment
 * says so and names the mechanism the real implementation owes.
 *
 * `it.todo` specs are the cases the mock cannot express at all. Each one names
 * the endpoint or fixture lane A must provide, so the case is a promotion of a
 * todo rather than a rediscovery six weeks from now.
 */

/**
 * READ THIS FIRST: THIS FILE RUNS AGAINST `packages/mock`, NOT AGAINST THE API.
 *
 * Which matters more here than anywhere else, because a mock CANNOT EXHIBIT A RACE.
 * `packages/mock` is one Node process holding `Map`s: a check-then-act inside one
 * handler cannot interleave with another request, so every concurrency spec below
 * passes by construction. The double-scan spec says so itself — "the mock wins this
 * by accident... Passing here is not evidence that the real one is safe."
 *
 * It was right, and the real versions now exist:
 *
 *   two charges on ONE wallet token, concurrently
 *       → scanner.test.ts "racing — two charges on ONE wallet token"
 *   FIVE at once on one token
 *       → scanner.test.ts "and five at once on one token still settle exactly one"
 *   two charges under ONE idempotency key, concurrently
 *       → scanner.test.ts "racing — two charges under ONE idempotency key"
 *   the webhook and the customer's return firing simultaneously
 *       → gateway.test.ts "the webhook and her return firing AT ONCE credit exactly
 *         once"
 *
 * Those were written by removing the wallet's row lock AND the token's conditional
 * consumption, and confirming that every SEQUENTIAL spec in this repository stayed
 * green while the new races went red. That is what this file could never do.
 *
 * What remains below is what the mock can honestly say about itself, for the lanes
 * building against it.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  ensureBalanceAtLeast,
  memberNow,
  MEMBER_ID,
  SALON_ID,
  SERVICE,
  api,
  idempotencyKey,
  mintWalletToken,
} from './support/api.js';
import { knownBug, precondition } from './support/known-bug.js';

interface ChargeResult {
  transaction: { id: string; amountFils: number };
  balanceAfterFils: number;
  loyalty: Record<string, unknown>;
}

const charge = (options: { key: string; token?: string; serviceIds?: string[] }) =>
  api<ChargeResult & { error?: string }>('POST', '/charges', {
    idempotencyKey: options.key,
    body: {
      memberId: MEMBER_ID,
      serviceIds: options.serviceIds ?? [SERVICE.blowDry.id],
      ...(options.token ? { token: options.token } : {}),
    },
  });

/**
 * This file settles eight charges of 8.000 KD — the floor below carries two
 * spare. Lane A seeds the shared member at 24.500 KD, which pays for three.
 *
 * That arithmetic did not matter while nothing ever reset her — she had drifted
 * past 300 KD and everything cleared. Re-running `db:seed` put her back and the
 * fourth charge onwards answered a perfectly correct 402, which read as three
 * broken idempotency specs. So the floor is stated once, here, and funded
 * through the real top-up path before any spec runs. See `ensureBalanceAtLeast`.
 *
 * Deliberately generous: a spec that fails because a PREVIOUS spec in this file
 * spent the money is the same class of bug one level down.
 */
const CHARGES_IN_THIS_FILE = 10;
const FLOOR_FILS = SERVICE.blowDry.priceFils * CHARGES_IN_THIS_FILE;

beforeAll(async () => {
  await ensureBalanceAtLeast(FLOOR_FILS, 'concurrency');
}, 60_000);

// ---------------------------------------------------------- 1. double scan ---

describe('double scan of one wallet token', () => {
  it('the second charge on a consumed token is refused with 410', async () => {
    const token = await mintWalletToken();

    const first = await charge({ key: idempotencyKey('scan-1'), token });
    // The body is in the message on purpose. A bare `expected 500 to be 200` is
    // not diagnosable after the fact, and this suite has seen a burst of 500s on
    // one re-run that never reproduced — see the lane report. Next time the
    // failure carries the server's own answer.
    expect(first.status, `the first charge answered: ${JSON.stringify(first.body)}`).toBe(200);
    expect(first.body.transaction.amountFils).toBe(-SERVICE.blowDry.priceFils);

    // A different idempotency key, so this is a genuinely new charge attempt —
    // it must be stopped by the token, not by the replay cache.
    const second = await charge({ key: idempotencyKey('scan-2'), token });
    expect(second.status).toBe(410);
    expect(second.body.error).toBe('token_consumed_or_unknown');
    expect(second.body).not.toHaveProperty('transaction');
    expect(second.body).not.toHaveProperty('balanceAfterFils');
  });

  it('two charges racing on the same token: exactly one settles, the other 410s', async () => {
    // Read the balance first and assert the delta. The absolute this used to
    // expect was `packages/mock`'s fixture; against a real database it decayed
    // into an assertion about how many earlier runs had charged her. See
    // `memberNow()` in support/api.ts.
    const before = (await memberNow()).balanceFils;
    const token = await mintWalletToken();

    const [a, b] = await Promise.all([
      charge({ key: idempotencyKey('race-a'), token }),
      charge({ key: idempotencyKey('race-b'), token }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(
      statuses,
      `the racing charges answered: ${JSON.stringify([a.body, b.body])}`,
    ).toEqual([200, 410]);

    const settled = [a, b].filter((r) => r.status === 200);
    expect(settled).toHaveLength(1);
    // ONE debit, not two: the loser must not have moved anything.
    expect(settled[0]?.body.balanceAfterFils).toBe(before - SERVICE.blowDry.priceFils);

    // NOTE FOR LANE A: the mock wins this by accident. Its check-and-delete on
    // the token map is synchronous inside one handler in one Node process, so
    // the two requests cannot interleave. A Postgres-backed API has no such
    // luck: consumption must be a conditional UPDATE that returns a row count
    // (`UPDATE wallet_token SET consumed_at = now() WHERE token = $1 AND
    // consumed_at IS NULL`), inside the same transaction as the debit. Passing
    // here is not evidence that the real one is safe.
  });

  it('an unknown token is refused before anything else happens', async () => {
    const res = await charge({ key: idempotencyKey('unknown-token'), token: 'tok_never_minted' });
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('token_consumed_or_unknown');
  });

  it('resolving a QR twice is allowed — consumption happens at the charge, not the scan', async () => {
    // api-contract.md § Charging step 1: POST /charges "validates and consumes"
    // the token. POST /scans only resolves it to a member card, so a scanner
    // that re-reads the code before the artist confirms must not burn it.
    const token = await mintWalletToken();

    const first = await api('POST', '/scans', { body: { token } });
    const second = await api('POST', '/scans', { body: { token } });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    // …and the token is still chargeable after both reads.
    const settled = await charge({ key: idempotencyKey('scan-after-peek'), token });
    expect(settled.status, `the charge answered: ${JSON.stringify(settled.body)}`).toBe(200);
  });

  it.todo(
    'an EXPIRED token (older than 45s) is refused with 410 token_expired — needs a way to mint a short-lived or back-dated token; sleeping 45s in a suite is not a test',
  );
  it.todo(
    "one member's token cannot be charged against another member — needs a second member fixture; POST /charges currently trusts body.memberId and never checks it against the token's owner",
  );
});

// -------------------------------------------------------- 2. double submit ---

describe('double submit of one charge', () => {
  it('a sequential resubmit under the same key returns the first result', async () => {
    const key = idempotencyKey('double-submit-seq');
    const before = (await memberNow()).balanceFils;
    const first = await charge({ key });
    const second = await charge({ key });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.transaction.id).toBe(first.body.transaction.id);
    expect(second.body).toEqual(first.body);
    expect(second.body.balanceAfterFils).toBe(before - SERVICE.blowDry.priceFils);
  });

  it('a double-tap — two in flight at once under one key — settles exactly one transaction', async () => {
    const key = idempotencyKey('double-submit-parallel');
    const before = (await memberNow()).balanceFils;

    const [a, b] = await Promise.all([charge({ key }), charge({ key })]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.transaction.id).toBe(b.body.transaction.id);
    expect(a.body.balanceAfterFils).toBe(b.body.balanceAfterFils);
    expect(a.body.balanceAfterFils).toBe(before - SERVICE.blowDry.priceFils);

    // NOTE FOR LANE A: same caveat as the token race. The mock's has()/set() on
    // its idempotency Map cannot interleave in one process, so this spec is
    // green for free. The real requirement is a UNIQUE constraint on
    // (principal, idempotency_key) with the row inserted inside the charge
    // transaction, so the loser hits a unique violation and replays the winner's
    // stored response instead of computing a second one.
  });

  it('two different keys are two different charges — idempotency is per key, not per basket', async () => {
    // The other direction: a genuine second haircut must not be swallowed as a
    // duplicate just because the basket matches.
    const first = await charge({ key: idempotencyKey('distinct-a') });
    const second = await charge({ key: idempotencyKey('distinct-b') });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.transaction.id).not.toBe(first.body.transaction.id);
  });

  it.todo(
    'a double submit debits the member once: GET /members/me balance moves by one basket, not two — needs a mutable balance from lane A',
  );
  it.todo(
    'a double submit increments visits once and evaluates the tier once — the mock returns a hardcoded loyalty block',
  );
  it.todo(
    'a double submit queues ONE WhatsApp receipt — needs the receipt queue endpoint or a test hook',
  );
  it.todo(
    'a replay that arrives while the first charge is still open blocks rather than racing — needs lane A to hold the idempotency row lock, not just check-then-insert',
  );
});

// ------------------------------------------------- 3. duplicate callback -----

/**
 * THE NINE CALLBACK TODOS THAT USED TO LIVE HERE ARE COVERED — AGAINST THE REAL API.
 *
 * They read "LANE A OWES: ..." because `packages/mock` has no webhook endpoint at
 * all, so none of them could be written here. Lane A built it, and
 * `gateway.test.ts` drives every one of them against Postgres. Mapped rather than
 * deleted, because a todo that vanishes leaves the next reader unable to tell a
 * covered case from a forgotten one:
 *
 *   a second delivery of one PSP reference credits once, answers 200
 *       → gateway.test.ts "the second delivery of one event id changes nothing"
 *         and "records the duplicate rather than swallowing it — one event row"
 *   idempotent on the PSP reference, not on our intent id
 *       → gateway.test.ts "the event index demonstrably did NOT catch it —
 *         two rows, one reference"
 *   an invalid signature credits nothing
 *       → gateway.test.ts's five signature cases, "→ 401, and the wallet does
 *         not move", plus "the SAME body, correctly signed, settles"
 *   an already-terminal intent does not flip to succeeded
 *       → gateway.test.ts "a terminal `failed` is just as closed as a terminal
 *         `succeeded`" and the raw-UPDATE trigger specs beside it
 *   a duplicate writes one ledger entry and one audit row
 *       → gateway.test.ts "settles exactly one transaction, with one ledger pair
 *         behind it"
 *   webhook first, then her GET reads succeeded
 *       → gateway.test.ts "a callback that lands BEFORE her GET still yields the
 *         right final state"
 *   her GET first, then the webhook lands
 *       → gateway.test.ts "a callback that lands AFTER her GET is ignored, and
 *         the state is identical"
 *   webhook and client return firing SIMULTANEOUSLY credit once
 *       → gateway.test.ts "the webhook and her return firing AT ONCE credit
 *         exactly once" — the one that was genuinely missing, and the reason this
 *         mapping was worth doing rather than assuming
 *   an intent stuck in `pending` past the settlement window is reconciled by a job
 *       → still open, and already tracked where it belongs: gateway.test.ts's own
 *         todo for the sweep of OPEN_STATUSES. Not duplicated back here.
 *
 * The one thing this file could still say for itself is below.
 */
describe('the mock has no gateway callback — the one live divergence, written to expire', () => {
  /**
   * WRITTEN AS A knownBug, NOT AS AN it(), AND THAT IS THE WHOLE POINT.
   *
   * This is the last divergence between `packages/mock` and the API that this suite
   * still records. Six others used to be recorded here and in money.test.ts as
   * plain `it()`s whose TITLES named the defect and whose ASSERTIONS demanded the
   * fix — and every one of them was silently fixed in the mock while the spec kept
   * passing and the title kept lying. Five stale sentences in the place a reader
   * looks first.
   *
   * `knownBug()` is the mechanism that cannot rot: the assertion below is the one
   * the CONTRACT calls for — the webhook exists and settles a top-up — and it fails
   * today, so this reports green while naming the gap. The hour somebody gives the
   * mock a webhook, the assertion starts passing and THIS SPEC GOES RED demanding
   * to be rewritten. A divergence recorded this way expires by itself.
   *
   * WHY THE MOCK NOT HAVING ONE MATTERS, since it is not a product defect: three
   * lanes build against this thing. A wallet that waits for a webhook to settle a
   * top-up waits for ever here, and will conclude its own polling is broken. That
   * is the shape of the week the wallet lost to a missing auth endpoint.
   *
   * The real webhook is proved end to end in gateway.test.ts — signatures,
   * duplicates, out-of-order delivery, terminal transitions, and both paths firing
   * at once.
   */
  knownBug(
    'packages/mock exposes no POST /webhooks/{psp}, so no top-up on the mock can be settled by a ' +
      'callback and every gateway-ordering case is untestable against it. A client built here ' +
      'cannot exercise its own settle path at all',
    async () => {
      const opened = await api<{ id: string; status: string }>('POST', '/topups', {
        idempotencyKey: idempotencyKey('mock-webhook-settle'),
        body: { amountFils: 10_000, method: 'knet' },
      });
      precondition(opened.status === 200, `POST /topups answered ${opened.status}`);
      precondition(
        opened.body.status !== 'succeeded',
        `the intent was born ${opened.body.status}, so this spec cannot tell a webhook from a ` +
          'mock that settles on creation',
      );

      // The assertion the contract calls for: a signed callback settles the intent.
      const hook = await api<Record<string, unknown>>('POST', '/webhooks/knet', {
        body: { intentId: opened.body.id, status: 'succeeded', reference: 'KNET-1' },
      });
      expect(
        hook.status,
        'the mock still has no webhook endpoint, so a client cannot drive a settlement here',
      ).toBe(200);

      const read = await api<{ status: string }>('GET', `/topups/${opened.body.id}`);
      expect(read.body.status, 'the callback did not settle the intent').toBe('succeeded');
    },
  );
});

describe('a charge crossing a happy-hour boundary', () => {
  /**
   * `happy.length > 0` used to be asserted here. That held against
   * `packages/mock`, whose fixture publishes two happy hours, and it cannot hold
   * against lane A's API: `GET /v1/salons/{id}/promotions` returns a hardcoded
   * `happy: []` because promotions are not persisted yet (build-plan.md phase 3
   * — there is no promotion table in the schema at all). The spec was pinned to
   * the mock's fixture rather than to the rule.
   *
   * The RULE is the absence of a precomputed liveness flag, and it is checkable
   * on an empty set for the envelope and on every element that is there. The
   * emptiness itself is a gap, and it is reported as one below rather than
   * smuggled into this assertion.
   */
  it('the promotion set ships the inputs a server-side predicate needs, and no `live` flag', async () => {
    // Non-negotiable #2: the client never decides whether a happy hour is live
    // for the purpose of a charge. So the wire format must carry days/from/to
    // and NOT a precomputed boolean anyone could trust or spoof.
    const res = await api<{
      boosts: Record<string, unknown>;
      happy: Array<{
        id: string;
        branchId: string;
        days: number[];
        from: string;
        to: string;
        reward: string;
        on: boolean;
      }>;
    }>('GET', `/v1/salons/${SALON_ID}/promotions`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.happy)).toBe(true);
    expect(res.body).toHaveProperty('boosts');

    // The envelope-level version of the same rule: no liveness anywhere in the
    // document, whatever shape the set inside it happens to have today.
    expect(JSON.stringify(res.body)).not.toMatch(/"(live|isLive|minutesRemaining)"/);

    for (const hh of res.body.happy) {
      expect(hh).not.toHaveProperty('live');
      expect(hh).not.toHaveProperty('isLive');
      expect(hh).not.toHaveProperty('minutesRemaining');
      expect(hh.from).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
      expect(hh.to).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
      expect(hh.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)).toBe(true);
      expect(typeof hh.on).toBe('boolean');
    }
  });

  /**
   * PROMOTED, AND THE TWO-WAY REGISTRATION COLLAPSED WITH IT.
   *
   * This was a spec registered BY TARGET, which is a shape worth explaining
   * before it is deleted. `packages/mock` had always published two happy hours
   * from its fixture; lane A's API returned a hardcoded `happy: []`, because
   * there was no promotion table in the schema at all. Neither `knownBug()` nor
   * `it()` was a true statement about both servers — a `knownBug` would have
   * reported "this appears to be FIXED" on every single run against the mock —
   * so the file asked `targetKind()` which server it was driving and registered
   * the true one.
   *
   * Lane A has since landed the promotion tables and a real read, and the two
   * answers converged. It is one plain `it()` again, asserted against both, and
   * the loop above finally loops on the real API as well.
   *
   * The `targetKind()` probe goes with it. It was introduced for this one spec
   * and nothing else in this file consulted it, so leaving it behind would leave
   * a mechanism with no remaining reason — and the next person to need it would
   * find it already imported and assume it was load-bearing. `support/api.ts`
   * still exports it, with the reasoning intact, for the next divergence.
   */
  it('the fixture salon publishes at least one happy hour to evaluate', async () => {
    const res = await api<{ happy: unknown[] }>('GET', `/v1/salons/${SALON_ID}/promotions`);
    precondition(res.status === 200, `GET promotions answered ${res.status}`);
    expect(
      res.body.happy.length,
      'the fixture salon publishes no happy hour, so every happy-hour boundary spec in this ' +
        'file is untestable — there is no window to cross.',
    ).toBeGreaterThan(0);
  });

  /**
   * THE SEVEN "LANE A OWES" TODOS THAT LIVED HERE HAVE MOVED TO
   * `e2e/promotions.test.ts`, AND THE SPEC ABOVE THEM IS DELETED. Both facts are
   * worth recording, because this is the tidiest ending a gap ledger can have.
   *
   * There was a spec here asserting a charge response carried NO happy-hour
   * outcome — `not.toHaveProperty('happyHour')` — with the comment "when lane A
   * adds the applied-reward field this fails, and the todos below become the real
   * boundary specs". Lane A added it. The spec failed, exactly as designed, and
   * that was its whole job. It is deleted rather than inverted, because the
   * positive statements belong where they can actually be made.
   *
   * WHY NOT HERE. Every one of those questions needs a happy hour positioned to
   * the minute against the salon's own clock, and therefore a database. This file
   * drives `packages/mock` by default and owns no fixture it can move. So they are
   * answered in `promotions.test.ts` against lane A's API and lane D's Postgres:
   * liveness on the server clock, the inclusive-start / exclusive-end boundary,
   * `on: false`, a window on the wrong day, overlapping windows resolving to one
   * outcome, and an idempotent replay returning the STORED decision rather than
   * re-evaluating it against the replay clock.
   *
   * Two remain open and are recorded there rather than here: pinning the
   * evaluation INSTANT needs a clock-injection hook the API does not have, and
   * branch scoping cannot apply at all until a charge knows which branch it
   * happened at — a `knownBug()` in that file, with the sort-order near-miss that
   * nearly became the fix written out beside it.
   */
});
