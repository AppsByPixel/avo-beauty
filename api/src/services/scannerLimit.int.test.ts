/**
 * The till's budget, proved against a real database and the real handlers.
 *
 * WHY THIS IS NOT A PURE SPEC. The claim worth having about a limiter on a money
 * endpoint is not "it returns 429". It is A REFUSED REQUEST MOVED NO MONEY — the
 * balance is untouched and no `transaction` row exists — because a limiter that
 * fires after the debit is strictly worse than no limiter: it refuses the customer
 * AND charges her. That assertion is about rows, so it needs rows.
 * `vitest.int.config.ts` carries the rest, including why this suite is not in
 * `pnpm check` and whose column its permanent home is.
 *
 * WHAT IS ASSERTED, AND WHAT DELIBERATELY IS NOT
 *
 *   THE CODE, NOT THE STATUS. `error: 'scanner_rate_limited'` is the contract —
 *   `http/errors.ts` says so: "The `error` string is the contract — packages/mock
 *   and the clients switch on it." A spec asserting 429 alone would pass against a
 *   limiter that told a staff member she lacked authority, which is the exact
 *   outcome this was specified to avoid.
 *
 *   THAT IT DOES NOT FIRE BELOW THE THRESHOLD. Half the value of a generous
 *   ceiling is lost if nothing pins the last request that must succeed. The
 *   thresholds are un-measured starting values (services/scannerLimit.ts
 *   § THRESHOLDS), so this is the assertion that fails first when they are
 *   revised — deliberately, because a threshold change should have to touch a spec.
 *
 *   THAT THE KEY IS THE TILL. A second device at the same salon keeps working
 *   after the first is exhausted. Without this the suite would pass against a
 *   salon-wide limiter — the shape `req.ip` would have given us, and the one that
 *   turns a busy counter into an outage for the quiet one.
 *
 * NO CLEANUP, BY CONSTRUCTION. Every test mints its own device id, so each starts
 * with an empty bucket and nothing has to be deleted afterwards. That is not only
 * tidiness: `avo_app` — the role `db/client.ts` connects as, and the role
 * production serves with — CANNOT DELETE `scanner_attempt` (migration 0038, so a
 * compromised application cannot clear its own counter). A suite that needed to
 * truncate would have had to connect as the owner, and would then have been
 * proving the limiter under privileges production does not have.
 *
 * NOT ASSERTED HERE: concurrency. Two simultaneous requests can both read a count
 * one below the ceiling and both proceed, by construction — the counter is a
 * SELECT, not a lock. That is an accepted overshoot of at most the number of
 * in-flight requests, it is the property every sibling limiter in this API has,
 * and pinning it needs `e2e/support/race.ts`, which is Lane D's column.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const INT_URL = process.env.AVO_INT_DATABASE_URL;

/**
 * SKIP RATHER THAN CONNECT. With the variable unset this file imports nothing —
 * not the app, not `db/client.ts` — so it cannot reach a database it was not
 * pointed at. `LANES.md` § "Every lane isolates its own resources": a suite that
 * falls back to whatever `DATABASE_URL` happens to be exported is how one
 * worktree's process came to be talking to another worktree's database.
 */
const suite = INT_URL ? describe : describe.skip;

const SALON = 'SAL-AMARA';
const STAFF = 'ST-001';
const MEMBER = '8842';
/** 8.000 KD — the design's blow-dry, and what a refused charge must NOT move. */
const SERVICE = 'SV-01';

suite('the till budget — POST /scans, POST /charges', () => {
  let app: FastifyInstance;

  // Bound in beforeAll. Imported there rather than at the top of the file so an
  // unset AVO_INT_DATABASE_URL skips without `env.ts` throwing at module load.
  let db: typeof import('../db/client')['db'];
  let scannerAttempt: typeof import('../db/schema/session')['scannerAttempt'];
  let member: typeof import('../db/schema/member')['member'];
  let transaction: typeof import('../db/schema/transaction')['transaction'];
  let idempotencyKey: typeof import('../db/schema/idempotency')['idempotencyKey'];
  let limits: typeof import('./scannerLimit');
  let orm: typeof import('drizzle-orm');
  let issueSession: typeof import('../auth/sessions')['issueSession'];

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    scannerAttempt = (await import('../db/schema/session')).scannerAttempt;
    member = (await import('../db/schema/member')).member;
    transaction = (await import('../db/schema/transaction')).transaction;
    idempotencyKey = (await import('../db/schema/idempotency')).idempotencyKey;
    limits = await import('./scannerLimit');
    orm = await import('drizzle-orm');
    issueSession = (await import('../auth/sessions')).issueSession;
    app = await (await import('../app')).buildApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  /**
   * A fresh till: a new device id and a REAL scanner session bound to it.
   *
   * A real session and not an `AVO_TEST_PRINCIPALS` shim, because the device is
   * the rate-limit key and the shim has no session row to carry one. A suite run
   * under the shim would be exercising the `device_id IS NULL` bucket and calling
   * it the till.
   */
  async function till(): Promise<{ deviceId: string; bearer: string }> {
    const deviceId = `DEV-INT-${randomUUID()}`;
    const s = await issueSession(db, {
      principalKind: 'staff',
      staffId: STAFF,
      salonId: SALON,
      scope: 'scanner',
      deviceId,
    });
    return { deviceId, bearer: s.accessToken };
  }

  /** Fill this till's window to exactly `n`, without going through a handler. */
  async function preload(deviceId: string, n: number): Promise<void> {
    await db
      .insert(scannerAttempt)
      .values(Array.from({ length: n }, () => ({ salonId: SALON, deviceId, action: 'scan' })));
  }

  function scan(bearer: string) {
    return app.inject({
      method: 'POST',
      url: '/scans',
      headers: { authorization: `Bearer ${bearer}` },
      // Deliberately not a real token: what is being pinned is whether the
      // limiter let the request reach the handler, not what the handler said.
      payload: { token: 'not-a-real-wallet-token' },
    });
  }

  async function countAttempts(deviceId: string): Promise<number> {
    const [row] = await db
      .select({ n: orm.sql<number>`count(*)::int` })
      .from(scannerAttempt)
      .where(orm.eq(scannerAttempt.deviceId, deviceId));
    return row?.n ?? 0;
  }

  it('does not fire one request below the burst threshold', async () => {
    const t = await till();
    await preload(t.deviceId, limits.SCANNER_MAX_PER_WINDOW - 1);

    const res = await scan(t.bearer);

    // A 410 or a 404 — the token is nonsense — but NOT a 429.
    expect(res.statusCode).not.toBe(429);
    expect(JSON.parse(res.body).error).not.toBe(limits.SCANNER_RATE_LIMITED);
  });

  it('refuses with scanner_rate_limited at the burst threshold', async () => {
    const t = await till();
    await preload(t.deviceId, limits.SCANNER_MAX_PER_WINDOW);

    const res = await scan(t.bearer);

    expect(res.statusCode).toBe(429);
    // THE CODE. See the header: the status alone would pass against a 403.
    expect(JSON.parse(res.body).error).toBe(limits.SCANNER_RATE_LIMITED);
  });

  it('reports the hourly ceiling ahead of the burst one when both are spent', async () => {
    const t = await till();
    await preload(t.deviceId, limits.SCANNER_MAX_PER_HOUR);

    const res = await scan(t.bearer);

    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.body).error).toBe(limits.SCANNER_HOURLY_LIMIT);
  });

  it('is keyed on the till: a second device at the same salon is unaffected', async () => {
    const spent = await till();
    const fresh = await till();
    await preload(spent.deviceId, limits.SCANNER_MAX_PER_WINDOW);

    expect(JSON.parse((await scan(spent.bearer)).body).error).toBe(limits.SCANNER_RATE_LIMITED);

    const other = await scan(fresh.bearer);
    expect(other.statusCode).not.toBe(429);
    expect(JSON.parse(other.body).error).not.toBe(limits.SCANNER_RATE_LIMITED);
  });

  it('records an attempt for a request the handler then refuses', async () => {
    /**
     * `signupLimit.ts`'s property, and the one that had to be FIXED there rather
     * than merely documented: a refusal is an attempt. Forty probes that all
     * answered `409 already_registered` left `signup_attempt` empty, so the oracle
     * "was not bounded at 100 an hour. It was not bounded at all."
     */
    const t = await till();
    expect(await countAttempts(t.deviceId)).toBe(0);

    const res = await scan(t.bearer);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);

    expect(await countAttempts(t.deviceId)).toBe(1);
  });

  describe('where the limiter sits — the connection pool', () => {
    /**
     * THIS SPEC EXISTS BECAUSE THE FIRST VERSION OF THE LIMITER DEADLOCKED
     * PRODUCTION, and nothing else in the suite could see it.
     *
     * `chargeScannerBudget` was originally called INSIDE `performCharge`'s
     * transaction, immediately after `claimKey`, on the non-transactional `db`
     * handle. The argument for that placement was real and is recorded in
     * services/scannerLimit.ts: a retry under the same Idempotency-Key has already
     * moved money, `claimKey` raises for it, and a limiter in front of the claim
     * could answer 429 to a scanner asking "did my charge go through?".
     *
     * The argument was sound and the implementation was fatal. `db/client.ts` opens
     * `postgres(url, { max: 10 })`. A `db.transaction()` RESERVES one of those ten
     * for its whole life; a `db.insert()` on the base handle asks the same pool for
     * another. Ten concurrent charges therefore hold all ten connections and then
     * each wait for an eleventh that cannot exist. Not a slowdown — a permanent
     * hang, on `POST /charges`, at every till in the salon at once.
     *
     * MEASURED, not reasoned: twelve concurrent charges against the real API with
     * the limiter inside the transaction did not return in 25 seconds. With it
     * moved out, the same twelve answered in 571ms.
     *
     * Twelve is deliberately just over the pool's ten. Any number at or below ten
     * passes against the broken code, which is precisely why nothing else caught
     * it: the whole existing suite drives charges one at a time.
     */
    it('a burst larger than the connection pool answers instead of hanging', async () => {
      const t = await till();
      const one = () =>
        app.inject({
          method: 'POST',
          url: '/charges',
          headers: {
            authorization: `Bearer ${t.bearer}`,
            'idempotency-key': `int-pool-${randomUUID()}`,
          },
          // `confirmDuplicate`, because these are twelve identical baskets inside
          // the near-duplicate window and the guard is not what is under test here.
          payload: { memberId: MEMBER, serviceIds: [SERVICE], confirmDuplicate: true },
        });

      const results = await Promise.all(Array.from({ length: 12 }, one));

      /**
       * WHAT IS ASSERTED IS THAT THEY ANSWERED. Some succeed and some 402 — the
       * seeded balance does not cover twelve blow-dries, and which lands first is a
       * race. Pinning the mix would make this a test about `FOR UPDATE`; it is a
       * test about whether the process is alive.
       */
      expect(results).toHaveLength(12);
      for (const r of results) {
        expect([200, 402]).toContain(r.statusCode);
      }
    }, 25_000);
  });

  describe('a refused charge moves no money', () => {
    async function walletOf(id: string) {
      const [row] = await db
        .select({ balanceFils: member.balanceFils, visits: member.visits })
        .from(member)
        .where(orm.eq(member.id, id));
      return row;
    }

    async function transactionCount(id: string): Promise<number> {
      const [row] = await db
        .select({ n: orm.sql<number>`count(*)::int` })
        .from(transaction)
        .where(orm.eq(transaction.memberId, id));
      return row?.n ?? 0;
    }

    it('leaves the balance, the visit count and the transaction table untouched', async () => {
      const t = await till();
      const before = await walletOf(MEMBER);
      const beforeRows = await transactionCount(MEMBER);

      await preload(t.deviceId, limits.SCANNER_MAX_PER_WINDOW);

      const res = await app.inject({
        method: 'POST',
        url: '/charges',
        headers: {
          authorization: `Bearer ${t.bearer}`,
          'idempotency-key': `int-charge-${randomUUID()}`,
        },
        payload: { memberId: MEMBER, serviceIds: [SERVICE] },
      });

      expect(res.statusCode).toBe(429);
      expect(JSON.parse(res.body).error).toBe(limits.SCANNER_RATE_LIMITED);

      const after = await walletOf(MEMBER);
      // Integer fils, compared as integers. Non-negotiable #1.
      expect(after?.balanceFils).toBe(before?.balanceFils);
      expect(after?.visits).toBe(before?.visits);
      expect(await transactionCount(MEMBER)).toBe(beforeRows);
    });

    it('leaves the idempotency key unclaimed, so the retry is a charge and not a cached refusal', async () => {
      /**
       * The limiter refuses BEFORE the transaction opens, so the key is never
       * claimed at all — and when it sat inside the transaction instead, the
       * rollback unclaimed it. Either placement satisfies this; the spec is here
       * because the PROPERTY has to survive both, and it survived the move.
       *
       * `services/charge.ts` states it for the other refusals: "the key vanishing is
       * what lets the scanner retry the same attempt after a top-up, instead of
       * being answered with a cached 402 forever". A limiter that broke it would
       * strand a till on one key until the client minted a new one — precisely the
       * state where a lost response causes a double charge.
       */
      const t = await till();
      await preload(t.deviceId, limits.SCANNER_MAX_PER_WINDOW);
      const key = `int-key-${randomUUID()}`;

      const res = await app.inject({
        method: 'POST',
        url: '/charges',
        headers: { authorization: `Bearer ${t.bearer}`, 'idempotency-key': key },
        payload: { memberId: MEMBER, serviceIds: [SERVICE] },
      });
      expect(res.statusCode).toBe(429);

      const [row] = await db
        .select({ n: orm.sql<number>`count(*)::int` })
        .from(idempotencyKey)
        .where(orm.eq(idempotencyKey.key, key));
      expect(row?.n).toBe(0);
    });
  });
});
