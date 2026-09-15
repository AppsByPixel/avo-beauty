/**
 * The pooling knob's CONSEQUENCE, against a real database.
 *
 * ======================================================================
 * WHY THIS FILE EXISTS, WHEN `poolOptions.test.ts` ALREADY PASSES
 * ======================================================================
 * That spec asserts the OPTIONS: `serverless` really is `{ max: 1, prepare:
 * false }`, and the real client really is built from them. Every assertion in
 * it was green on the day `POST /topups` could not answer at all on the
 * deployed demo — three requests for three, a flat `502 gateway_unavailable`
 * after ~10.8s each. It was green because the options were never wrong. What
 * was wrong was what `max: 1` MEANS for code that asks the pool for a second
 * connection while holding the first, and no spec in this repository had ever
 * opened a transaction under `max: 1` and then done anything inside it.
 *
 * Reproduced locally against a real database, same code, same request, the only
 * variable being the pool mode:
 *
 *     DB_POOL_MODE=serverless   ->  8.052s  502 {"error":"gateway_unavailable"}
 *     DB_POOL_MODE unset        ->  0.045s  200 {"id":"TI-C0JUWE", ...}
 *
 * 8.052s is `GATEWAY_TIMEOUT_MS`. It was a timeout, not a refusal — and the
 * gateway was never the thing that was slow. `gateway/sandbox.ts` imported the
 * APPLICATION pool and wrote its payment row on it, from inside the transaction
 * `services/topup.ts` § createTopUp holds open across the gateway call. One
 * connection, already reserved, and a nested query queued behind a transaction
 * that could not commit until that query returned.
 *
 * ======================================================================
 * WHAT THIS SPEC PINS, AND WHY IT IS THE NESTING AND NOT THE ROUTE
 * ======================================================================
 * The hazard is structural and it is a CLASS: any module-level `db` touched
 * while a transaction is open on the same pool. `POST /topups` was the first
 * instance to reach a deployment, but a spec written against that route would
 * pin the instance and miss the next one. So the assertion here is the general
 * property, in the configuration that makes a regression instant:
 *
 *   UNDER `max: 1`, WITH A TRANSACTION OPEN, A NESTED CALL STILL COMPLETES.
 *
 * `db/poolOptions.ts` § `max: 1` already argues that this is the property the
 * serverless shape depends on — "a single request that nested a `db` call
 * inside a `tx` would hang for ever, by itself, on the first try… `max: 1` is
 * what makes a regression of that bug instant and obvious instead of a
 * load-dependent mystery." That paragraph was true, and nothing tested it.
 *
 * ======================================================================
 * A HANG MUST FAIL, NOT HANG
 * ======================================================================
 * The failure mode under test is an await that never settles. Left alone it
 * would burn this suite's 30s `testTimeout` and report as a timeout, which
 * names the spec rather than the defect. So every nested call below is raced
 * against a timer an order of magnitude under that budget, and the rejection it
 * produces says what actually happened.
 *
 * AND THE CONTROL IS NOT OPTIONAL. If the re-imported client were `max: 10` —
 * a stale `process.env`, a module registry that did not reset — every assertion
 * here would pass while proving nothing at all, because ten connections make
 * nesting harmless. `max` is therefore asserted from `sql.options` before any
 * nesting is attempted, on the same module instance that is then exercised.
 *
 * ======================================================================
 * IT REBUILDS THE MODULE GRAPH, SO IT IS SLOW, SO IT IS BOUNDED EXPLICITLY
 * ======================================================================
 * `vi.resetModules()` plus a dynamic import re-runs `env.ts` and `db/client.ts`,
 * which is the point: this must exercise the REAL client under the REAL switch,
 * not a handle a helper constructed. `poolOptions.test.ts` records what happens
 * when that cost meets vitest's 5s default — 14678ms under parallel load, red on
 * a tree with nothing wrong with it — and records that the first attempt to fix
 * it put the timeout on the two synchronous specs instead. Every spec here
 * carries its own explicit budget for that reason.
 */

import { sql as raw } from 'drizzle-orm';
import { fils } from '@avo/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

/** Far under the suite's 30s testTimeout, far over any honest local query. */
const NEST_BUDGET_MS = 3_000;

/**
 * Reject rather than hang. The message is the finding, so a regression reads as
 * a starved pool rather than as "test timed out".
 */
async function within<T>(what: string, work: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `${what} did not complete in ${NEST_BUDGET_MS}ms. Under max:1 that is a ` +
                  `starved pool, not a slow query: something asked the application pool ` +
                  `for a second connection while a transaction still held the first.`,
              ),
            ),
          NEST_BUDGET_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The real `db/client.ts`, rebuilt under a chosen DB_POOL_MODE. */
async function clientUnder(mode: string) {
  const previous = process.env.DB_POOL_MODE;
  process.env.DB_POOL_MODE = mode;
  try {
    vi.resetModules();
    return {
      client: await import('./client'),
      sandbox: await import('../gateway/sandbox'),
    };
  } finally {
    if (previous === undefined) delete process.env.DB_POOL_MODE;
    else process.env.DB_POOL_MODE = previous;
  }
}

suite('a transaction under max:1 does not starve the thing inside it', () => {
  const opened: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const close of opened.splice(0)) await close();
  });

  it('the control: the client under test really is max:1, or nothing below means anything', async () => {
    const { client } = await clientUnder('serverless');
    opened.push(async () => {
      await client.sql.end({ timeout: 5 });
    });
    expect(client.sql.options.max).toBe(1);
    expect(client.sql.options.prepare).toBe(false);
  }, 30_000);

  /**
   * THE REGRESSION, at the seam that actually shipped one.
   *
   * `gateway.createPayment` is called from inside `createTopUp`'s transaction by
   * design — `services/topup.ts` § createTopUp argues it at length, and the
   * property it buys is that a failed gateway leg rolls the idempotency key back
   * instead of burning it. So the transaction is not the defect and must not be
   * what a fix removes. What must hold is that the driver's own write does not
   * come out of the connection the caller is sitting on.
   *
   * Before `gateway/sandbox.ts` was given its own pool this rejects at
   * NEST_BUDGET_MS. After, it completes in single-digit milliseconds.
   */
  it('a sandbox payment is written while the caller holds the only connection', async () => {
    const { client, sandbox } = await clientUnder('serverless');
    opened.push(async () => {
      await sandbox.closeSandboxStore();
      await client.sql.end({ timeout: 5 });
    });
    expect(client.sql.options.max).toBe(1);

    const driver = new sandbox.SandboxGateway();
    const intentId = `TI-INT${Date.now().toString(36).toUpperCase().slice(-6)}`;

    const created = await within('createPayment inside an open transaction', () =>
      client.db.transaction(async (tx) => {
        // A real statement first, so the transaction genuinely holds the
        // connection. A transaction that has issued nothing has not yet taken
        // one, and the nesting would be untested.
        await tx.execute(raw`select 1`);

        return driver.createPayment({
          intentId,
          memberId: '8842',
          amountFils: fils(5_000),
          method: 'knet',
          returnUrl: 'avo://topup/return',
        });
      }),
    );

    expect(created.pspReference).toMatch(/^SBX-/);
    expect(created.redirectUrl).toContain(created.pspReference);

    // And it is a real row, readable after the caller's transaction closed.
    const stored = await within('readPayment', () => driver.readPayment(created.pspReference));
    expect(stored?.intentId).toBe(intentId);
  }, 30_000);

  /**
   * The same property stated without the gateway in it, so the next nested call
   * this codebase grows is covered by a spec that never mentions payments.
   * `services/audit.ts` § Executor is the shape most likely to reintroduce it:
   * a helper that takes `Db | tx` and is handed the pool from inside a
   * transaction is type-legal and deadlocks here.
   */
  it('any second query on the app pool inside a transaction starves — the shape, not the instance', async () => {
    const { client } = await clientUnder('serverless');
    opened.push(async () => {
      await client.sql.end({ timeout: 5 });
    });
    expect(client.sql.options.max).toBe(1);

    await expect(
      within('a module-level db query nested inside a transaction', () =>
        client.db.transaction(async (tx) => {
          await tx.execute(raw`select 1`);
          // Deliberately the POOL, not `tx`. This is the mistake, written out.
          return client.db.execute(raw`select 1`);
        }),
      ),
    ).rejects.toThrow(/starved pool/);
  }, 30_000);
});
