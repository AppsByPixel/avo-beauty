/**
 * The customer's top-up budget, proved against a real database and the real
 * handler. `vitest.int.config.ts` carries why this suite is separate and why it is
 * not in `pnpm check`; `scannerLimit.int.test.ts` carries the shared reasoning
 * about asserting the CODE rather than the status.
 *
 * THIS SUITE DRIVES REAL REQUESTS RATHER THAN PRELOADING ROWS, which is the one
 * place it differs from its sibling, and the difference follows from the design:
 * `topup_intent` IS the counter (services/topupLimit.ts § NO ATTEMPT TABLE), so
 * "preloading" it would mean hand-forging payment intents with a dozen NOT NULL
 * columns and a gateway reference. Driving the real endpoint against the sandbox
 * gateway is cheaper AND proves more — it proves the rows the endpoint actually
 * writes are the rows the limiter actually counts, which a forged fixture cannot.
 *
 * WHAT THAT COSTS, stated: the burst tier has to be reachable in a test, and at
 * `TOPUP_MAX_PER_WINDOW` (100) this file opens a hundred intents to get there. It
 * runs in a few seconds today. If the tier is raised much further, this should
 * preload forged rows and give up the property above, and that trade should be
 * made deliberately rather than by watching the suite get slower.
 *
 * =========================================================================
 * NO CLEANUP OF `topup_intent`, AND THE SPECS MEASURE THE BUDGET THEY FIND
 * =========================================================================
 * Intents are only ever appended here. Nothing in this file deletes a payment
 * record to make itself green, and nothing should: `topup_intent` rows are what
 * reached a payment provider, a test that truncates them is a test that can hide
 * a real charge, and "the suite cleans up after itself" is how that gets argued
 * for. The rule stands.
 *
 * What DID have to change is what the specs assert. They used to assert absolute
 * counts — `expect(await intentCount()).toBe(0)` — which is a claim about the
 * whole database rather than about this run, and it made the file single-use:
 *
 *     run 1 (fresh db):  Tests  26 passed (26)
 *     run 2 (same db):   Tests  1 failed | 25 passed (26)   expected 100 to be +0
 *
 * Note the DIRECTION, because it is the instructive part. Leftover state usually
 * makes a stale test falsely PASS; here it made a correct implementation falsely
 * FAIL. Same disease — a spec that describes the database instead of its own
 * effect on it — and both halves are why a suite has to be idempotent. "Reset
 * first" is not a fix; it is a footnote nobody reads before a CI run.
 *
 * So every count here is a DELTA against what the run found, and the allowance
 * spec spends whatever budget is actually left rather than assuming a hundred.
 * On a freshly reset database that is identical to what this file did before —
 * a hundred top-ups, then a refusal. On a repeat run inside the window the
 * allowance is already spent, so the spec proves the refusal and its code but
 * not the full ceiling; the fresh-database run is the one that proves the
 * ceiling, and `scripts/lane-db.sh a` is still the right way to start.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const SALON = 'SAL-AMARA';
/** The seeded low-balance member — 2.500 KD, and nobody else's fixture. */
const MEMBER = '8843';

suite('the top-up budget — POST /topups', () => {
  let app: FastifyInstance;

  let db: typeof import('../db/client')['db'];
  let member: typeof import('../db/schema/member')['member'];
  let topUpIntent: typeof import('../db/schema/topup')['topUpIntent'];
  let limits: typeof import('./topupLimit');
  let orm: typeof import('drizzle-orm');
  let issueSession: typeof import('../auth/sessions')['issueSession'];

  let bearer = '';

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    member = (await import('../db/schema/member')).member;
    topUpIntent = (await import('../db/schema/topup')).topUpIntent;
    limits = await import('./topupLimit');
    orm = await import('drizzle-orm');
    issueSession = (await import('../auth/sessions')).issueSession;
    app = await (await import('../app')).buildApp();

    const s = await issueSession(db, {
      principalKind: 'member',
      memberId: MEMBER,
      salonId: SALON,
      scope: 'wallet',
    });
    bearer = s.accessToken;
  });

  afterAll(async () => {
    await app?.close();
  });

  /** A fresh key every time, so each call is a genuine new attempt and not a replay. */
  function topup(amountFils = 5000) {
    return app.inject({
      method: 'POST',
      url: '/topups',
      headers: {
        authorization: `Bearer ${bearer}`,
        'idempotency-key': `int-topup-${randomUUID()}`,
      },
      payload: { amountFils, method: 'knet' },
    });
  }

  /**
   * All three counts the limiter cares about, in one round trip and at one
   * instant — two queries a second apart could straddle a window edge and
   * disagree with each other.
   *
   * `all` is the delta base for "this request wrote nothing". `burst` and `hour`
   * are the numbers `enforceTopUpLimits` itself counts, so the remaining budget
   * can be derived rather than assumed; the intervals mirror
   * TOPUP_WINDOW_MINUTES and the hard-coded hour in that file.
   */
  async function intentCounts(): Promise<{ all: number; burst: number; hour: number }> {
    const [row] = await db
      .select({
        all: orm.sql<number>`count(*)::int`,
        burst: orm.sql<number>`count(*) filter (
          where ${topUpIntent.createdAt} >= now() - make_interval(mins => ${limits.TOPUP_WINDOW_MINUTES})
        )::int`,
        hour: orm.sql<number>`count(*) filter (
          where ${topUpIntent.createdAt} >= now() - interval '60 minutes'
        )::int`,
      })
      .from(topUpIntent)
      .where(orm.eq(topUpIntent.memberId, MEMBER));
    return { all: row?.all ?? 0, burst: row?.burst ?? 0, hour: row?.hour ?? 0 };
  }

  async function intentCount(): Promise<number> {
    return (await intentCounts()).all;
  }

  async function balanceOf(): Promise<number> {
    const [row] = await db
      .select({ balanceFils: member.balanceFils })
      .from(member)
      .where(orm.eq(member.id, MEMBER));
    return row?.balanceFils ?? -1;
  }

  it('lets a customer start whatever is left of the allowance, then refuses the next', async () => {
    const before = await intentCounts();

    /**
     * THE BUDGET THIS RUN ACTUALLY HAS, derived from the rows the limiter counts
     * rather than from an assumption that the table is empty. On a freshly reset
     * database this is TOPUP_MAX_PER_WINDOW and the loop below is the original
     * hundred; on a repeat run it is whatever the previous run left.
     *
     * BOTH TIERS, because they interact. `enforceTopUpLimits` checks the hourly
     * ceiling FIRST, so whichever budget runs out first decides both how many
     * top-ups succeed and WHICH code comes back. A spec that only tracked the
     * burst tier would pass on a fresh database and assert the wrong code on a
     * run started twenty minutes after the last one — burst window expired,
     * hourly window not.
     */
    const burstLeft = Math.max(0, limits.TOPUP_MAX_PER_WINDOW - before.burst);
    const hourLeft = Math.max(0, limits.TOPUP_MAX_PER_HOUR - before.hour);
    const allowance = Math.min(burstLeft, hourLeft);
    // Ties go to the hourly tier: it is the check that runs first.
    const expectedCode =
      hourLeft <= burstLeft ? limits.TOPUP_HOURLY_LIMIT : limits.TOPUP_RATE_LIMITED;

    // Every one of these must succeed. The thresholds are reasoned rather than
    // observed (services/topupLimit.ts § THRESHOLDS) and this is the assertion
    // that will fail first when they are revised — deliberately.
    for (let i = 0; i < allowance; i += 1) {
      const res = await topup();
      expect(res.statusCode, `top-up ${i + 1} of ${allowance}`).toBe(200);
    }
    // A DELTA, not a total: this run wrote exactly the intents it was allowed.
    expect(await intentCount()).toBe(before.all + allowance);

    const refused = await topup();
    expect(refused.statusCode).toBe(429);
    // THE CODE, not the status: a 429 with a generic body is a wallet screen that
    // cannot tell a customer whether to wait or to call the salon.
    expect(JSON.parse(refused.body).error).toBe(expectedCode);
  });

  it('a burst larger than the connection pool answers instead of hanging', async () => {
    /**
     * THE SIBLING SPEC'S LESSON, APPLIED HERE RATHER THAN ASSUMED AWAY.
     *
     * `scannerLimit.int.test.ts` § "where the limiter sits" records a limiter that
     * deadlocked `postgres(url, { max: 10 })` by asking the pool for a second
     * connection from inside a transaction that already held one. THIS limiter also
     * runs inside a transaction, so the same question has to be asked of it — and
     * the answer is different: it only READS, and it reads on `tx`, so it asks the
     * pool for nothing.
     *
     * That is a claim about code, and this is the measurement of it. Twelve
     * concurrent top-ups, against a pool of ten.
     */
    const one = () =>
      app.inject({
        method: 'POST',
        url: '/topups',
        headers: {
          authorization: `Bearer ${bearer}`,
          'idempotency-key': `int-pool-${randomUUID()}`,
        },
        payload: { amountFils: 5000, method: 'knet' },
      });

    const results = await Promise.all(Array.from({ length: 12 }, one));

    expect(results).toHaveLength(12);
    for (const r of results) {
      // 200 or 429 — whether the burst tier fires is a race and is not the point.
      // The point is that all twelve ANSWERED.
      expect([200, 429]).toContain(r.statusCode);
    }
  }, 25_000);

  it('the refused top-up created no intent and moved no money', async () => {
    // The window is still spent from the test above — these run in file order in
    // one process, which `vitest.int.config.ts` pins with `fileParallelism: false`.
    const beforeIntents = await intentCount();
    const beforeBalance = await balanceOf();

    const refused = await topup();
    expect(refused.statusCode).toBe(429);

    // NOTHING REACHED THE PAYMENT PROVIDER. The limiter runs inside the same
    // transaction as the intent insert, so a refusal rolls the intent back — see
    // services/topupLimit.ts on why this counter is `topup_intent` itself.
    expect(await intentCount()).toBe(beforeIntents);
    // And the balance is untouched, which is the weaker half of the claim but the
    // one somebody will ask about: integer fils, compared as integers.
    expect(await balanceOf()).toBe(beforeBalance);
  });
});
