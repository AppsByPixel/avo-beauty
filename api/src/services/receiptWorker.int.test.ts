/**
 * The receipt worker's WRITES, proved against a real database.
 *
 * `vitest.int.config.ts` carries why this suite is separate and why it is not in
 * `pnpm check`. `topupReaper.int.test.ts` carries the house rules this follows —
 * a real endpoint rather than a hand-forged fixture, no truncation of shared
 * tables, and the `AVO_INT_DATABASE_URL` skip.
 *
 * ======================================================================
 * WHAT THIS IS ABOUT: A CLAIM-THEN-WRITE WORKER WHOSE WRITE DID NOT CHECK
 * THE CLAIM
 * ======================================================================
 * `claimJobs` is careful. It is one statement, it takes `FOR UPDATE SKIP
 * LOCKED`, and it stamps a lease. Everything that happened afterwards was keyed
 * on `id` alone:
 *
 *     UPDATE receipt_job SET status='sent', sent_at=now(), available_at=now()
 *      WHERE id = $1
 *
 * so the write landed on whatever the row had become by the time it arrived. A
 * claim nobody re-asserts is not a claim; it is a hope.
 *
 * THIS IS REACHABLE WITH THE PRODUCTION DEFAULTS. `RECEIPT_WORKER_ENABLED`
 * defaults to `'1'`, so every API process drains the outbox, and the file's own
 * header says the claim exists because "two workers, or two API instances,
 * never take the same row". The lease is what lets a SECOND instance take a row
 * the first is still sending — that is its purpose, crash recovery — and from
 * that moment two writers hold the same job. Nothing about that needs a test
 * harness.
 *
 * ======================================================================
 * THREE WRITES, AND THE WORST OF THEM RAISES
 * ======================================================================
 * `receipt_job_sent_at_matches_status` is `(status = 'sent') = (sent_at IS NOT
 * NULL)`. So a late write that moves a row OUT of `sent` without clearing
 * `sent_at` does not lose quietly — Postgres refuses the statement:
 *
 *   markSent          'sent'   over anything. Legal by the CHECK, so it commits
 *                     and the other writer's state is gone. This is the one
 *                     Lane D hit: claim, park, land, and the park is missing.
 *
 *   markFailed        'failed' over a row already `sent`. VIOLATES the CHECK.
 *                     It is raised inside `processJob`'s catch, which does not
 *                     wrap it, so the exception leaves `processJob` — the
 *                     function whose own docblock says "Never throws — a bad job
 *                     must not stop the batch" — and `runOnce`'s loop does not
 *                     catch either. Every job the batch had not reached yet is
 *                     abandoned mid-flight in `sending`, waiting out a lease
 *                     nobody is holding.
 *
 *   the give-back     'queued' over a row already `sent`, when a driver that
 *                     cannot handle the channel re-claims it. VIOLATES the CHECK
 *                     too, and this one is not even inside the `try`.
 *
 * The two-driver deployment the give-back is written for — "Running a
 * WhatsApp-only driver should leave email rows queued for the driver that does"
 * — is precisely a deployment with two workers that disagree about a row.
 *
 * ======================================================================
 * HOW THE RACE IS STAGED, AND WHY IT IS NOT A SLEEP
 * ======================================================================
 * The concurrent writer lands from inside `send()`. That is the real window and
 * the only one: the provider call is the whole time the worker is holding a
 * claim it is not looking at. Staging it there means the interleaving is exact
 * rather than probable, and the spec drives the REAL `runOnce` — real claim,
 * real batch loop, real writes — with nothing mocked but the provider.
 *
 * `soleClaimable` is the other half. This lane's database accumulates rows from
 * every other suite, and a batch of one would otherwise claim somebody else's
 * oldest row instead of this spec's. It pushes every other claimable row an hour
 * out, which delays nothing that is running and truncates nothing.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReceiptDelivery } from '../receipts';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const SALON = 'SAL-AMARA';

/**
 * The provider, under this spec's control.
 *
 * `vi.hoisted` because `vi.mock`'s factory is lifted above the imports: a plain
 * `const` would be in its temporal dead zone at that point. Everything else in
 * `../receipts` is the real module — `ReceiptPermanentError` in particular, since
 * `processJob` decides permanent-versus-transient with `instanceof`.
 */
const driver = vi.hoisted(() => ({
  handles: (_channel: string): boolean => true,
  /**
   * `delivery` is TYPED, not `unknown`, because one spec below has to know WHICH
   * job it is being asked to send — see the tie in `soleClaimable`. `import
   * type` is erased, so naming `ReceiptDelivery` here is safe under the hoist
   * that lifts this above the imports.
   */
  send: async (_delivery: ReceiptDelivery): Promise<{ providerReference: string }> => ({
    providerReference: 'int-spec-ref',
  }),
}));

vi.mock('../receipts', async () => {
  const actual = await vi.importActual<typeof import('../receipts')>('../receipts');
  return {
    ...actual,
    receiptSender: {
      provider: 'int-spec',
      handles: (channel: string) => driver.handles(channel),
      send: (delivery: ReceiptDelivery) => driver.send(delivery),
    },
  };
});

suite('the receipt worker re-asserts its claim before it writes', () => {
  let app: FastifyInstance;

  let db: typeof import('../db/client')['db'];
  let member: typeof import('../db/schema/member')['member'];
  let receiptJob: typeof import('../db/schema/receipt')['receiptJob'];
  let worker: typeof import('./receiptWorker');
  let orm: typeof import('drizzle-orm');
  let issueSession: typeof import('../auth/sessions')['issueSession'];
  let hashSecret: typeof import('../auth/password')['hashSecret'];

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    member = (await import('../db/schema/member')).member;
    receiptJob = (await import('../db/schema/receipt')).receiptJob;
    worker = await import('./receiptWorker');
    orm = await import('drizzle-orm');
    issueSession = (await import('../auth/sessions')).issueSession;
    hashSecret = (await import('../auth/password')).hashSecret;

    app = await (await import('../app')).buildApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    driver.handles = () => true;
    driver.send = async () => ({ providerReference: 'int-spec-ref' });
  });

  // ------------------------------------------------------------- fixtures --

  /** A phone number that is valid E.164 and belongs to nobody. */
  function freePhone(): string {
    return `+9657${Math.floor(Math.random() * 10_000_000)
      .toString()
      .padStart(7, '0')}`;
  }

  /**
   * A REAL receipt row, queued by the REAL settle path.
   *
   * `POST /topups` then `GET /topups/{id}`: the sandbox gateway's default
   * outcome is `succeeded`, the wallet read is "the ONLY thing entitled to move
   * a balance", and `settleFromGatewayRead` calls `queueReceipts` inside the
   * money transaction. So the row this suite operates on is one the outbox
   * actually produces, with a real `transaction_id` behind it.
   *
   * Its own member each time, with NO email: `queueReceipts` adds the email
   * channel only for a verified address, so one member with no address means
   * exactly one row per settle and nothing to disambiguate. A fresh member also
   * keeps this suite out of every per-member budget the other int suites spend.
   */
  async function queuedReceipt(): Promise<{ jobId: string; txId: string }> {
    const id = `INT-RW-${randomUUID().slice(0, 8)}`;
    await db.insert(member).values({
      id,
      salonId: SALON,
      name: 'Int Receipt Member',
      phone: freePhone(),
      passwordHash: await hashSecret(`pw-${randomUUID()}`),
      policyVersion: 1,
    });

    const s = await issueSession(db, {
      principalKind: 'member',
      memberId: id,
      salonId: SALON,
      scope: 'wallet',
    });

    const created = await app.inject({
      method: 'POST',
      url: '/topups',
      headers: {
        authorization: `Bearer ${s.accessToken}`,
        'idempotency-key': `int-receipt-${randomUUID()}`,
      },
      payload: { amountFils: 1000, method: 'knet' },
    });
    expect(created.statusCode, created.body).toBe(200);
    const intentId = JSON.parse(created.body).id as string;

    const settled = await app.inject({
      method: 'GET',
      url: `/topups/${intentId}`,
      headers: { authorization: `Bearer ${s.accessToken}` },
    });
    expect(settled.statusCode, settled.body).toBe(200);
    expect(JSON.parse(settled.body).status, settled.body).toBe('succeeded');

    const [row] = await db
      .select({ id: receiptJob.id, transactionId: receiptJob.transactionId })
      .from(receiptJob)
      .where(orm.eq(receiptJob.memberId, id))
      .limit(2);
    if (!row) throw new Error(`the settle queued no receipt for ${id}`);
    return { jobId: row.id, txId: row.transactionId };
  }

  /**
   * Make `ids` the only rows the next claim can see.
   *
   * Delays, never deletes: every other claimable row in this lane's database
   * moves an hour out, which is inside no other suite's window and outside this
   * one's.
   *
   * IT MAKES THEM DUE AT THE SAME INSTANT, AND ANY SPEC PASSING MORE THAN ONE ID
   * HAS TO KNOW THAT. The second statement is ONE statement, so `now()` is
   * evaluated once and every row in `ids` gets a BYTE-IDENTICAL `available_at` —
   * measured, `count(distinct available_at)` over a pair updated this way is 1.
   *
   * BUT THE TIE IS NOT WHY BATCH ORDER IS UNDEFINED, AND THAT MATTERS MORE.
   * `claimJobs` is `UPDATE … WHERE id IN (SELECT … ORDER BY available_at LIMIT n
   * FOR UPDATE SKIP LOCKED) RETURNING …`. The inner `ORDER BY` decides WHICH
   * rows the `LIMIT` takes — that is its entire job. It does **not** order
   * `RETURNING`, which emits rows in the outer UPDATE's own scan order, and
   * `runOnce` iterates exactly that. Measured on this lane's Postgres with eight
   * rows whose `available_at` were all DISTINCT: the subquery selected ids
   * 8,7,6,5 by due order and `RETURNING` handed back 5,6,7,8 — the exact
   * reverse.
   *
   * So making the rows' timestamps distinct does NOT define the order a batch is
   * processed in. It only makes one order more likely. A multi-row spec here must
   * be INDIFFERENT to processing order — keyed on the row's identity, never on
   * which call to the driver comes first, and never on a tie-break in the claim.
   */
  async function soleClaimable(ids: string[]): Promise<void> {
    await db.execute(orm.sql`
      UPDATE receipt_job
         SET available_at = now() + interval '1 hour'
       WHERE status IN ('queued', 'failed', 'sending')
         AND id <> ALL (${orm.sql.raw(`ARRAY[${ids.map((i) => `'${i}'::uuid`).join(',')}]`)})
    `);
    await db.execute(orm.sql`
      UPDATE receipt_job SET available_at = now() - interval '1 second'
       WHERE id = ANY (${orm.sql.raw(`ARRAY[${ids.map((i) => `'${i}'::uuid`).join(',')}]`)})
    `);
  }

  async function jobRow(id: string) {
    const [row] = await db.select().from(receiptJob).where(orm.eq(receiptJob.id, id)).limit(1);
    if (!row) throw new Error(`no receipt_job ${id}`);
    return row;
  }

  /**
   * What Lane D's `parkOutbox` does, verbatim in effect: put the row back to
   * `queued`, clear the send, and push it an hour out of the claim's reach.
   * A helper in a QA spec, and a second writer as far as this worker is
   * concerned.
   */
  async function park(id: string): Promise<void> {
    await db
      .update(receiptJob)
      .set({
        status: 'queued',
        attempts: 0,
        lastError: null,
        sentAt: null,
        availableAt: new Date(Date.now() + 60 * 60_000),
      })
      .where(orm.eq(receiptJob.id, id));
  }

  /** What a SECOND worker instance does when it wins the row: it finishes first. */
  async function anotherWorkerSendsIt(id: string): Promise<void> {
    await db
      .update(receiptJob)
      .set({ status: 'sent', sentAt: new Date(), lastError: null, availableAt: new Date() })
      .where(orm.eq(receiptJob.id, id));
  }

  // --------------------------------------------------------------- specs --

  it('still sends the ordinary way, and reports it', async () => {
    const { jobId } = await queuedReceipt();
    await soleClaimable([jobId]);

    const result = await worker.runOnce(db, 1);

    expect(result).toMatchObject({ claimed: 1, sent: 1, retry: 0, gaveUp: 0, lost: 0 });

    const after = await jobRow(jobId);
    expect(after.status).toBe('sent');
    expect(after.sentAt).not.toBeNull();
  });

  it('does not resurrect a receipt another writer parked while the send was in flight', async () => {
    const { jobId } = await queuedReceipt();
    await soleClaimable([jobId]);

    // The park lands mid-send — the exact window Lane D's flake found.
    driver.send = async () => {
      await park(jobId);
      return { providerReference: 'landed-too-late' };
    };

    const result = await worker.runOnce(db, 1);

    /**
     * THE CLAIM. `markSent` believed it was moving a row it had claimed. By the
     * time it ran, the row was somebody else's, and the write must not land.
     */
    const after = await jobRow(jobId);
    expect(after.status).toBe('queued');
    expect(after.sentAt).toBeNull();
    expect(after.availableAt.getTime()).toBeGreaterThan(Date.now() + 30 * 60_000);

    // And the worker says so rather than counting a send it did not record.
    expect(result).toMatchObject({ claimed: 1, sent: 0, lost: 1 });
  });

  it('does not fail a receipt another worker had already sent, and does not take the rest of the batch down with it', async () => {
    const racer = await queuedReceipt();
    const bystander = await queuedReceipt();
    await soleClaimable([racer.jobId, bystander.jobId]);

    /**
     * The lease-steal, staged exactly: the second instance re-claims the row,
     * sends it, and marks it — all while this worker's provider call is still
     * open. Then this worker's call fails.
     *
     * Unguarded, `markFailed` writes `status='failed'` over a row whose
     * `sent_at` is set, `receipt_job_sent_at_matches_status` refuses the
     * statement, and the exception escapes `processJob` and `runOnce` — taking
     * `bystander` with it, still `sending`, for a whole lease.
     *
     * KEYED ON `jobId`, NOT ON CALL ORDER — decision 75, and this is the whole
     * of that fix. This driver used to switch on `let first = true`, which
     * asserts the batch reaches racer-then-bystander. Nothing promises that.
     * When the bystander came first the driver threw for the BYSTANDER, so the
     * bystander landed in `failed` and the assertion below read
     * `expected 'failed' to be 'sent'`. Measured on `avo_lane_a` before this
     * change: **6 of 10 runs failed**, always that same assertion.
     *
     * AND THE ORDER IS UNDEFINED FOR A STRONGER REASON THAN THE TIE.
     * `soleClaimable`'s note carries the measurement: the inner `ORDER BY
     * available_at` picks which rows the `LIMIT` takes, but `RETURNING` emits
     * them in the outer UPDATE's scan order, which SQL does not specify — with
     * eight DISTINCT timestamps the subquery chose 8,7,6,5 and `RETURNING` gave
     * back 5,6,7,8. So the other candidate fix for this flake — give the two
     * rows different `available_at` and rely on the resulting order — does not
     * work. It lowers the failure rate and looks like a fix. Verified here:
     * forcing the bystander five seconds earlier still produced racer-first, and
     * the old driver under that forced order still passed 1 of 3.
     *
     * Keying on the id makes the spec indifferent to processing order instead of
     * betting on a different guess about it, and it says out loud which row is
     * which. Both orders produce the same four assertions — the racer is always
     * the row the other worker steals and always the row this send throws for,
     * whether the batch reaches it first or second.
     *
     * WHAT WAS ACTUALLY MEASURED, since "indifferent to order" is the kind of
     * claim this file exists to distrust. The driver was temporarily instrumented
     * to print which job it was handed first and run 14 times: 13 racer-first, 1
     * bystander-first, 14 green. So both orders were observed passing, though the
     * bystander-first sample is one run — the coin is heavily weighted on this
     * machine, which is also why the old spec's failure rate swung between lanes.
     * Then 12 clean runs, 12 green. The order-dependence is gone by construction
     * rather than by rate: `delivery.jobId` is the only thing this driver branches
     * on, and it is fixed before `runOnce` is called.
     */
    driver.send = async (delivery) => {
      if (delivery.jobId !== racer.jobId) return { providerReference: 'bystander-ok' };
      await anotherWorkerSendsIt(racer.jobId);
      throw new Error('provider timed out');
    };

    const result = await worker.runOnce(db, 2);

    // The row the other worker sent is still sent, and carries no failure.
    const racerAfter = await jobRow(racer.jobId);
    expect(racerAfter.status).toBe('sent');
    expect(racerAfter.sentAt).not.toBeNull();
    expect(racerAfter.lastError).toBeNull();

    // THE DAMAGE CLAIM: the batch kept going.
    const bystanderAfter = await jobRow(bystander.jobId);
    expect(bystanderAfter.status).toBe('sent');

    expect(result).toMatchObject({ claimed: 2, sent: 1, lost: 1 });
  });

  it('does not queue back a receipt another worker had already sent, when it cannot handle the channel', async () => {
    const { jobId } = await queuedReceipt();
    await soleClaimable([jobId]);

    /**
     * The give-back runs BEFORE `send`, so the race cannot be staged from
     * inside the driver. It is staged where it actually happens instead:
     * between the claim and the decision, which is what `processJob` being
     * exported separately from `claimJobs` lets a spec express.
     */
    const [claimed] = await worker.claimJobs(db, 1);
    /**
     * `expect` does not narrow, and `processJob` below takes a `ClaimedJob` and
     * not an optional one. Throwing on the empty claim keeps the assertion above
     * (the claim is THIS job) while giving the compiler the same fact.
     */
    if (claimed === undefined) throw new Error('claimJobs returned nothing to claim');
    expect(claimed.id).toBe(jobId);

    await anotherWorkerSendsIt(jobId);

    driver.handles = () => false;
    const outcome = await worker.processJob(db, claimed);

    expect(outcome).toBe('lost');
    const after = await jobRow(jobId);
    expect(after.status).toBe('sent');
    expect(after.sentAt).not.toBeNull();
  });
});
