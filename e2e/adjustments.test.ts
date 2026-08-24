/**
 * `POST /members/{id}/adjustments` — the owner console's Wallet adjust, adversarially.
 *
 * The newest money path, and the one lane A's own race caught misbehaving: the loser
 * answered **500** instead of 409, because the constraint translator read only `23505`
 * (unique violation) while a CHECK violation is `23514`. That is fixed. This file exists
 * because a fixed race is exactly the thing that regresses silently — the 500 and the 409
 * are both "not 200", and only an assertion on the CODE tells them apart.
 *
 * WHOSE REFUSAL IS THE 409? Trunk asked me to satisfy myself it is the DATABASE's and not
 * a handler pre-screen. It is, and the argument is structural rather than a guess:
 *
 *   - the handler contains NO balance pre-check; its own comment says so ("NO PRE-CHECK
 *     on the resulting balance — deliberately")
 *   - `balanceAfter = m.balanceFils + amountFils` is passed through `fils()`, and
 *     `fils()` rejects only non-integers and unsafe integers — a NEGATIVE integer passes
 *     it cleanly (packages/types/src/money.ts). So nothing throws before the UPDATE.
 *   - therefore the only thing standing between a deduction and a negative stored balance
 *     is `member_balance_non_negative`, which is `CHECK (balance_fils >= 0)` in Postgres.
 *
 * So a 409 arriving AT ALL, with the balance unchanged, is the constraint firing — there
 * is no other refusal in the path that could produce it. HONESTLY STATED: for a single
 * request, "database CHECK" and "hypothetical pre-screen inside the same transaction" are
 * indistinguishable from outside, because both roll back identically. The discriminator is
 * the source reading above, and it is recorded here rather than dressed up as something
 * the wire proved.
 *
 * THE RACE IS PROVED OVERLAPPED, not assumed — the technique from the console-reset
 * slice, which trunk asked be applied to every conditional-write race here. If the second
 * deduction arrives after the first COMMITS, it reads the already-reduced balance, the
 * `FOR UPDATE` never contends, and the test passes without exercising the serialisation at
 * all. Each request is timestamped either side and the case refuses to draw a conclusion
 * unless every request was in flight at once.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { precondition } from './support/known-bug.js';
import { assertRaced, timed, valuesOf } from './support/race.js';
import {
  PLATFORM_OWNER_HANDLE,
  SALON_A,
  psql,
  scalar,
  signInPlatform,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

const MEMBER = 'QA-ADJ-0001';
const MEMBER_ERASED = 'QA-ADJ-0002';
const CLONE_SOURCE = 'QA-GW-0001';
const OPENING = 50_000;

let owner = '';
let n = 0;
const key = (label: string) => `adj-${label}-${Date.now()}-${n++}`;

const balanceOf = (id = MEMBER): number =>
  Number(scalar(`select balance_fils from member where id='${id}'`));

const adjRows = (): number =>
  Number(
    scalar(
      `select count(*) from "transaction" where member_id='${MEMBER}' and kind='adjustment'`,
    ),
  );

/** Every ledger row against her, summed by direction. The pair must balance. */
const ledgerNet = (): number =>
  Number(
    scalar(
      `select coalesce(sum(case when direction='credit' then amount_fils else -amount_fils end), 0)
         from ledger_entry where member_id='${MEMBER}'`,
    ),
  );

const fund = (amount: number, id = MEMBER): void => {
  psql(`UPDATE member SET balance_fils = ${amount} WHERE id = '${id}';`);
};

const adjust = (amountFils: number, idemKey: string, reason = 'QA adversarial pass', id = MEMBER) =>
  treq<any>('POST', `/members/${id}/adjustments`, {
    token: owner,
    idempotencyKey: idemKey,
    body: { amountFils, reason },
  });

beforeAll(async () => {
  await startTenancyApi();
  owner = await signInPlatform(PLATFORM_OWNER_HANDLE);

  /**
   * ERASURE IS NOT A COLUMN THIS FIXTURE CAN JUST SET, and the schema is why: three
   * CHECKs bind the trio — `erased_at` requires `deletion_requested_at`,
   * `deletion_requested_at` and `deletion_due_at` must both be set or both null, and the
   * due date must be LATER than the request. The first draft set `erased_at` alone and
   * Postgres refused it with `member_erased_only_after_request`, which is the tombstone
   * invariant doing exactly its job. So the fixture walks request -> due -> erase, the
   * order the real deletion path walks.
   */
  psql(`
    INSERT INTO member (id, salon_id, name, phone, email, email_verified, password_hash,
                        balance_fils, visits, tier, stamps, policy_version, notify_wa)
    SELECT '${MEMBER}', salon_id, 'Adjust QA', '+96555990101', NULL, false,
           password_hash, ${OPENING}, 0, tier, stamps, policy_version, false
      FROM member WHERE id = '${CLONE_SOURCE}'
    ON CONFLICT (id) DO UPDATE SET balance_fils = ${OPENING}, erased_at = NULL;
    INSERT INTO member (id, salon_id, name, phone, email, email_verified, password_hash,
                        balance_fils, visits, tier, stamps, policy_version, notify_wa)
    SELECT '${MEMBER_ERASED}', salon_id, 'Erased QA', '+96555990102', NULL, false,
           password_hash, 10000, 0, tier, stamps, policy_version, false
      FROM member WHERE id = '${CLONE_SOURCE}'
    ON CONFLICT (id) DO NOTHING;
    -- Erasure is not a column you can just set: three CHECKs bind the trio, so the
    -- fixture walks request -> due -> erase the way the real path does. See the note
    -- above this psql call.
    UPDATE member
       SET deletion_requested_at = now() - interval '31 days',
           deletion_due_at       = now() - interval '1 day',
           erased_at             = now()
     WHERE id = '${MEMBER_ERASED}';
  `);

  precondition(
    scalar(`select count(*) from member where id='${MEMBER}'`).trim() === '1',
    `the clone source ${CLONE_SOURCE} is missing, so this file has no member`,
  );
  precondition(
    scalar(
      `select count(*) from pg_constraint where conname='member_balance_non_negative'`,
    ).trim() === '1',
    'member_balance_non_negative does not exist, so the refusal under test has no enforcer',
  );
}, 120_000);

afterAll(async () => {
  await stopTenancyApi();
});

// ===========================================================================

describe('an adjustment moves the balance once, and the ledger explains it', () => {
  it('a credit adds exactly the signed amount, with a balanced ledger pair', async () => {
    fund(OPENING);
    const before = balanceOf();
    const rowsBefore = adjRows();
    const netBefore = ledgerNet();

    const res = await adjust(5_000, key('credit'), 'service complaint');
    expect(res.status, `a credit answered ${res.status}: ${res.raw}`).toBe(200);

    expect(res.body.balanceAfterFils, 'the reply disagrees with the arithmetic').toBe(before + 5_000);
    expect(balanceOf(), 'the stored balance is not the reply').toBe(before + 5_000);
    expect(adjRows()).toBe(rowsBefore + 1);
    /**
     * INTEGER FILS ON THE WIRE — non-negotiable #1. A string here means somebody
     * formatted money at an API boundary.
     */
    expect(typeof res.body.balanceAfterFils).toBe('number');
    expect(Number.isInteger(res.body.balanceAfterFils)).toBe(true);
    expect(res.body.transaction.amountFils).toBe(5_000);
    /** The wallet leg is a credit of 5000; the clearing leg is its debit. Net +5000. */
    expect(ledgerNet(), 'the ledger pair does not net to the balance movement').toBe(
      netBefore + 5_000,
    );
    /** The branch was GUESSED, and the row says so rather than pretending. */
    expect(
      scalar(
        `select branch_assumed from "transaction" where id='${res.body.transaction.id}'`,
      ).trim(),
      'a console adjustment claimed a real branch it was never given',
    ).toBe('t');
  }, 60_000);

  it('a deduction subtracts it, and writes the reason into the audit row', async () => {
    fund(OPENING);
    const before = balanceOf();

    const res = await adjust(-7_500, key('debit'), 'duplicate top-up returned');
    expect(res.status, res.raw).toBe(200);
    expect(balanceOf()).toBe(before - 7_500);
    expect(res.body.transaction.amountFils).toBe(-7_500);

    /**
     * The reason is required precisely so a balance change is explicable years later,
     * so it is asserted where a dispute would look: the audit row AND the note.
     */
    expect(
      Number(
        scalar(
          `select count(*) from audit_log
            where subject_id='${res.body.transaction.id}'
              and action='Wallet adjusted'
              and detail like '%duplicate top-up returned%'`,
        ),
      ),
      'the adjustment wrote no audit row naming its reason',
    ).toBe(1);
    expect(
      scalar(`select note from "transaction" where id='${res.body.transaction.id}'`).trim(),
    ).toBe('duplicate top-up returned');
  }, 60_000);

  it('zero is refused by name — an adjustment of nothing is a no-op with an audit row', async () => {
    fund(OPENING);
    const before = balanceOf();
    const res = await adjust(0, key('zero'));
    expect(res.status, res.raw).toBe(400);
    expect(res.body.error).toBe('invalid_amount');
    expect(balanceOf()).toBe(before);
  }, 60_000);

  it('and a float never reaches the money column', async () => {
    fund(OPENING);
    const before = balanceOf();
    const res = await adjust(5_000.5, key('float'));
    expect(res.status, `a float answered ${res.status}: ${res.raw}`).toBe(400);
    expect(res.body.error).toBe('invalid_amount');
    expect(balanceOf()).toBe(before);
  }, 60_000);

  it('an erased account cannot be adjusted — nobody holds a tombstone\'s balance', async () => {
    const before = balanceOf(MEMBER_ERASED);
    const res = await adjust(1_000, key('erased'), 'should not land', MEMBER_ERASED);
    expect(res.status, res.raw).toBe(409);
    expect(res.body.error).toBe('member_erased');
    expect(balanceOf(MEMBER_ERASED), 'an erased account was adjusted').toBe(before);
  }, 60_000);
});

// ===========================================================================

describe('the negative-balance refusal is the database, and it rolls everything back', () => {
  it('a deduction past zero answers 409 insufficient_balance — never 500', async () => {
    fund(3_000);
    const before = balanceOf();
    const rowsBefore = adjRows();
    const netBefore = ledgerNet();
    const k = key('overdraw');

    const res = await adjust(-4_000, k);

    /**
     * THE REGRESSION THIS FILE EXISTS FOR. Lane A's own race found a 500 here, because
     * the translator matched `23505` and a CHECK violation is `23514`. A 500 and a 409
     * are both "not 200"; only the code separates a refusal from a crash, and only the
     * refusal tells the console anything it can show a human.
     */
    expect(
      res.status,
      `an overdrawing deduction answered ${res.status}: ${res.raw}. 500 is the regression: ` +
        'the CHECK violation (23514) fell through the unique-violation (23505) branch.',
    ).toBe(409);
    expect(res.body.error).toBe('insufficient_balance');

    /** The refusal carries the SERVER's balance, never the client's belief about it. */
    expect(res.body.balanceFils, 'the 409 does not report the real balance').toBe(before);
    expect(res.body.attemptedFils).toBe(-4_000);

    /** ALL OR NOTHING, in SQL: no transaction row, no ledger row, no balance move. */
    expect(balanceOf(), 'a refused deduction moved money').toBe(before);
    expect(adjRows(), 'a refused deduction left a transaction row').toBe(rowsBefore);
    expect(ledgerNet(), 'a refused deduction left ledger rows').toBe(netBefore);
    expect(
      Number(scalar(`select count(*) from audit_log where detail like '%${k}%'`)),
      'a refused deduction wrote an audit row',
    ).toBe(0);
  }, 60_000);

  it('to exactly zero is allowed — the boundary is >= 0, not > 0', async () => {
    fund(4_000);
    const res = await adjust(-4_000, key('to-zero'));
    expect(res.status, `draining to exactly zero answered ${res.status}: ${res.raw}`).toBe(200);
    expect(balanceOf(), 'the wallet did not land on exactly zero').toBe(0);
  }, 60_000);

  it('and the refused attempt does not spend the idempotency key', async () => {
    fund(3_000);
    const k = key('key-survives');
    const refused = await adjust(-9_000, k);
    precondition(refused.status === 409, `the refusal did not happen: ${refused.raw}`);

    /**
     * The key is claimed INSIDE the transaction, so a rolled-back adjustment releases
     * it. If it were claimed outside, her one retry would be dead and the console would
     * have to invent a new key with no way to know the old one was spent.
     */
    expect(
      scalar(`select count(*) from idempotency_key where key='${k}'`).trim(),
      'the rolled-back adjustment left an idempotency_key row, so the key is spent',
    ).toBe('0');

    const corrected = await adjust(-1_000, k);
    expect(
      corrected.status,
      `the corrected retry under the same key answered ${corrected.status}: ${corrected.raw}`,
    ).toBe(200);
  }, 60_000);
});

// ===========================================================================

describe('two concurrent deductions move the balance exactly once', () => {
  /**
   * THE CASE TRUNK NAMED. Two deductions, each affordable alone, together more than the
   * wallet holds. The member row is taken `FOR UPDATE` as the transaction's first
   * statement, so one must serialise behind the other and then meet the CHECK.
   *
   * WHY OVERLAP IS ASSERTED RATHER THAN ASSUMED: if the second request arrives after the
   * first commits, it simply reads the reduced balance, and the 409 it gets proves
   * nothing about `FOR UPDATE` — the guard under test would be untouched and the test
   * still green. That is the same trap as the reset race, where the outer SELECT could
   * silently stand in for the conditional UPDATE.
   */
  it('one 200, one 409, and the balance moves by exactly one deduction', async () => {
    fund(10_000);
    const before = balanceOf();
    const rowsBefore = adjRows();

    const fire = async (label: string) => {
      const startedAt = Date.now();
      const res = await adjust(-6_000, key(label), `race ${label}`);
      return { label, res, startedAt, finishedAt: Date.now() };
    };
    const timed = await Promise.all([fire('race-a'), fire('race-b')]);

    precondition(
      Math.max(...timed.map((t) => t.startedAt)) <= Math.min(...timed.map((t) => t.finishedAt)),
      `the deductions did not overlap (last start ${Math.max(
        ...timed.map((t) => t.startedAt),
      )}, first finish ${Math.min(...timed.map((t) => t.finishedAt))}), so FOR UPDATE never ` +
        'contended and this run proves nothing about the race',
    );

    const won = timed.filter((t) => t.res.status === 200);
    const lost = timed.filter((t) => t.res.status !== 200);

    expect(
      won.length,
      `${won.length} of 2 concurrent deductions succeeded: ` +
        timed.map((t) => `${t.label}=${t.res.status}`).join(', ') +
        '. Two is a lost update on a wallet — 12.000 KD taken from a 10.000 KD balance.',
    ).toBe(1);
    expect(lost[0]!.res.status, `the loser answered ${lost[0]!.res.status}: ${lost[0]!.res.raw}`).toBe(
      409,
    );
    expect(
      lost[0]!.res.body.error,
      'the loser did not name the refusal — a 500 here is the 23514/23505 regression',
    ).toBe('insufficient_balance');

    /** THE MONEY, IN SQL. Exactly one deduction landed. */
    expect(balanceOf(), 'the balance did not move by exactly one deduction').toBe(before - 6_000);
    expect(adjRows(), 'the race wrote more than one adjustment row').toBe(rowsBefore + 1);
    expect(
      Number(scalar(`select balance_fils from member where id='${MEMBER}'`)),
      'the wallet went negative — the CHECK did not hold under contention',
    ).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it('and five at once still move it exactly once', async () => {
    fund(10_000);
    const before = balanceOf();
    const rowsBefore = adjRows();

    const timed = await Promise.all(
      Array.from({ length: 5 }, async (_, i) => {
        const startedAt = Date.now();
        const res = await adjust(-6_000, key(`five-${i}`), `race five ${i}`);
        return { i, res, startedAt, finishedAt: Date.now() };
      }),
    );

    precondition(
      Math.max(...timed.map((t) => t.startedAt)) <= Math.min(...timed.map((t) => t.finishedAt)),
      'the five deductions did not overlap, so this round measured nothing',
    );

    const won = timed.filter((t) => t.res.status === 200);
    expect(
      won.length,
      `${won.length} of 5 succeeded: ${timed.map((t) => t.res.status).join(',')}`,
    ).toBe(1);
    for (const l of timed.filter((t) => t.res.status !== 200)) {
      expect(l.res.status, `a loser answered ${l.res.status}: ${l.res.raw}`).toBe(409);
      expect(l.res.body.error).toBe('insufficient_balance');
    }
    expect(balanceOf()).toBe(before - 6_000);
    expect(adjRows()).toBe(rowsBefore + 1);
  }, 60_000);

  it('the SAME key twice concurrently debits once and replays one body', async () => {
    fund(20_000);
    const before = balanceOf();
    const rowsBefore = adjRows();
    const k = key('same-key');

    const fired = await Promise.all([
      timed(() => adjust(-5_000, k)),
      timed(() => adjust(-5_000, k)),
    ]);

    /**
     * MEASURED — and this is the ONE spec in this block that was not.
     *
     * The two `insufficient_balance` races above already bracket their requests and
     * refuse to proceed on a sequential pair; this one, which is the idempotency
     * case, did not. That is backwards: a sequential same-key pair is exactly the
     * ordinary replay path, already covered elsewhere, and it satisfies every
     * assertion below — one transaction id, one debit, a 409 or a 200. Concurrent
     * is the only version that tests what the title says, because it is the only
     * version where neither request can see the other's uncommitted key row.
     */
    assertRaced(fired, 'two adjustments under ONE idempotency key');
    const [a, b] = valuesOf(fired);

    /**
     * Non-negotiable #4. One of three shapes is acceptable: both 200 with the SAME
     * transaction id (the replay), or one 200 and one 409 `request_in_progress` (the
     * loser found the claim uncommitted). What is never acceptable is two DIFFERENT
     * transaction ids, or a balance that moved twice.
     */
    const settled = [a, b].filter((r) => r.status === 200);
    const ids = new Set(settled.map((r) => r.body.transaction.id));
    expect(
      ids.size,
      `the same key produced ${ids.size} distinct transactions: ${a.raw} | ${b.raw}`,
    ).toBeLessThanOrEqual(1);
    for (const r of [a, b].filter((r) => r.status !== 200)) {
      expect(r.status, `an unexpected status under one key: ${r.raw}`).toBe(409);
      expect(r.body.error).toBe('request_in_progress');
    }
    expect(balanceOf(), 'one idempotency key debited the wallet twice').toBe(before - 5_000);
    expect(adjRows()).toBe(rowsBefore + 1);
  }, 60_000);

  it('a different body under a spent key is refused, not answered with the first', async () => {
    fund(20_000);
    const k = key('mutated');
    const first = await adjust(-3_000, k);
    precondition(first.status === 200, `the first adjustment failed: ${first.raw}`);
    const after = balanceOf();

    const mutated = await adjust(-9_000, k);
    expect(
      mutated.status,
      `a mutated retry answered ${mutated.status}: ${mutated.raw}. Replaying the first ` +
        'result for a different amount hides a lost adjustment; applying the second ' +
        'double-debits.',
    ).toBe(422);
    expect(balanceOf(), 'the mutated retry moved money').toBe(after);
  }, 60_000);

  it('and a keyless adjustment is refused before anything moves — #4', async () => {
    fund(20_000);
    const before = balanceOf();
    const res = await treq<any>('POST', `/members/${MEMBER}/adjustments`, {
      token: owner,
      body: { amountFils: -1_000, reason: 'no key' },
    });
    expect(res.status, `a keyless adjustment answered ${res.status}: ${res.raw}`).toBe(400);
    expect(res.body.error).toBe('idempotency_key_required');
    expect(balanceOf()).toBe(before);
  }, 60_000);
});
