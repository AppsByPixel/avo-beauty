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

import { describe, expect, it } from 'vitest';
import {
  memberNow,
  MEMBER_ID,
  SALON_ID,
  SERVICE,
  api,
  idempotencyKey,
  mintWalletToken,
} from './support/api.js';

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

// ---------------------------------------------------------- 1. double scan ---

describe('double scan of one wallet token', () => {
  it('the second charge on a consumed token is refused with 410', async () => {
    const token = await mintWalletToken();

    const first = await charge({ key: idempotencyKey('scan-1'), token });
    expect(first.status).toBe(200);
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
    expect(statuses).toEqual([200, 410]);

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
    expect(settled.status).toBe(200);
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

describe('duplicate gateway callback', () => {
  it('the mock exposes no gateway callback endpoint at all', async () => {
    // Stated as a running assertion so this gap is a fact in the report rather
    // than a claim. When lane A adds the webhook this fails, and the todos below
    // become the real specs.
    const res = await api('POST', '/webhooks/knet', {
      body: { intentId: 'TI-ANY', status: 'succeeded', reference: 'KNET-1' },
    });
    expect(res.status).toBe(404);
  });

  it.todo(
    'LANE A OWES: POST /webhooks/{psp} — a second delivery of the same PSP reference credits the wallet exactly once and answers 200 (a 4xx makes the PSP retry forever)',
  );
  it.todo(
    'LANE A OWES: the callback is idempotent on the PSP reference, not on our intent id — the PSP controls the retry, so our Idempotency-Key header is not in play',
  );
  it.todo(
    'LANE A OWES: a callback with an invalid signature is rejected and credits nothing',
  );
  it.todo(
    'LANE A OWES: a callback for an already-terminal intent (failed, cancelled) does not flip it to succeeded',
  );
  it.todo(
    'LANE A OWES: a duplicate callback writes one ledger entry and one audit row, not two',
  );
});

// -------------------------------- 4. callback before the client returns ------

describe('callback arriving before the client returns from the gateway', () => {
  it.todo(
    'LANE A OWES: the webhook settles the intent, then the client hits GET /topups/{id} and reads `succeeded` — the balance moved exactly once and the client-side return is a read, never a second credit',
  );
  it.todo(
    'LANE A OWES: the reverse order — client polls first and sees `pending`, webhook lands, next poll flips to `succeeded` with the same creditFils',
  );
  it.todo(
    'LANE A OWES: webhook and client return firing simultaneously credit once (Promise.all over the webhook and the status read)',
  );
  it.todo(
    'LANE A OWES: an intent stuck in `pending` past the settlement window is reconciled by the daily job, not by a client retry — go-live-checklist § Money',
  );

  it('until then: `pending` is a distinct terminal-looking state the client must not resolve itself', async () => {
    // The half of this case that is testable today. A client that treats
    // `pending` as failure offers a retry, and the retry is the double charge.
    const created = await api<{ id: string }>('POST', '/topups', {
      idempotencyKey: idempotencyKey('pending-state'),
      body: { amountFils: 10_000, method: 'knet' },
    });
    const pending = await api<{ status: string; failureReason: string | null }>(
      'GET',
      `/topups/${created.body.id}`,
      { scenario: 'pending' },
    );

    expect(pending.status).toBe(200);
    expect(pending.body.status).toBe('pending');
    expect(pending.body.failureReason).toBeNull();
  });
});

// ------------------------------------------- 5. happy-hour boundary ----------

describe('a charge crossing a happy-hour boundary', () => {
  it('the promotion set ships the inputs a server-side predicate needs, and no `live` flag', async () => {
    // Non-negotiable #2: the client never decides whether a happy hour is live
    // for the purpose of a charge. So the wire format must carry days/from/to
    // and NOT a precomputed boolean anyone could trust or spoof.
    const res = await api<{
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
    expect(res.body.happy.length).toBeGreaterThan(0);

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

  it('a charge response carries no happy-hour outcome yet — nothing tells the receipt what was granted', async () => {
    // Running evidence for the gap. When lane A adds the applied-reward field
    // this fails, and the todos below become the real boundary specs.
    const res = await charge({ key: idempotencyKey('hh-shape') });
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('happyHour');
    expect(res.body.loyalty).not.toHaveProperty('boostApplied');
    expect(res.body.loyalty).not.toHaveProperty('happyHourId');
  });

  it.todo(
    'LANE A OWES: liveness is evaluated at commit time on the server clock in salon-local time (UTC+3, packages/types/src/rules.ts SALON_UTC_OFFSET_MINUTES) — a device clock set to 17:00 must not earn an x2 visit at 19:00',
  );
  it.todo(
    'LANE A OWES: a charge submitted at 17:59:59 and committed at 18:00:01 resolves the reward ONCE against a single evaluation instant, not once per read — needs a clock injection hook or a fixture happy hour ending in the next few seconds',
  );
  it.todo(
    'LANE A OWES: the boundary is inclusive-start / exclusive-end and the two ends agree — a charge exactly at `from` earns, a charge exactly at `to` does not',
  );
  it.todo(
    'LANE A OWES: a happy hour with on:false never applies, even inside its window (HH-02 in the fixture is the case)',
  );
  it.todo(
    "LANE A OWES: a branch-scoped happy hour applies only at that branch; branchId 'all' applies everywhere",
  );
  it.todo(
    'LANE A OWES: an overlapping happy hour and a branch boost stack in one defined order and are applied once — two evaluations of the same charge must not double the visit',
  );
  it.todo(
    'LANE A OWES: an idempotent replay of a charge that earned an x2 visit returns the SAME reward, evaluated once — not re-evaluated against the replay clock, which is the boundary bug that pays twice',
  );
});
