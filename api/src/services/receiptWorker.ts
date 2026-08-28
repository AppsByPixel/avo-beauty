/**
 * The receipt worker — the other half of the transactional outbox.
 *
 * `services/receipts.ts` writes rows inside the money transaction and commits.
 * This picks them up afterwards and talks to a provider. db/schema/receipt.ts
 * explains why the two halves are separate; this file is what makes the second
 * half exist, because until now rows queued correctly and nothing ever sent.
 *
 * THE CLAIM IS THE WHOLE DESIGN
 * -----------------------------
 *     UPDATE receipt_job SET status='sending', attempts=attempts+1,
 *                            available_at = now() + lease
 *      WHERE id IN (SELECT id FROM receipt_job
 *                    WHERE <claimable> ORDER BY available_at
 *                    LIMIT n FOR UPDATE SKIP LOCKED)
 *  RETURNING *
 *
 * Three properties, none of which are optional:
 *
 *   FOR UPDATE SKIP LOCKED — two workers, or two API instances, never take the
 *     same row. The alternative every queue starts with is "SELECT, then UPDATE
 *     the ids you got", which is a check-then-act and races exactly the way
 *     services/idempotency.ts describes the mock's `map.has(key)` racing. A
 *     customer receiving her receipt twice is a smaller harm than a double
 *     charge and it is the same bug.
 *
 *   ONE STATEMENT — the select and the claim commit together, so a worker that
 *     dies between them cannot exist.
 *
 *   available_at DOUBLES AS A LEASE. Claiming pushes it forward. A worker that
 *     crashes mid-send leaves a row in `sending` with an expired lease, and the
 *     claim below picks `sending` rows back up once that lease has passed.
 *     Without this a crash strands the row in `sending` for ever, which is the
 *     failure mode that makes people distrust outbox tables. `attempts` was
 *     already incremented, so a crash-looping send still exhausts its budget
 *     rather than retrying without limit.
 *
 * AND THE CLAIM IS RE-ASSERTED BY EVERY WRITE THAT FOLLOWS IT
 * ----------------------------------------------------------
 * The three properties above make the claim exclusive at the moment it is taken.
 * They say nothing about the moment the provider answers, which is where every
 * subsequent write happens. So each of those writes carries the claim in its
 * `WHERE` — `status = 'sending' AND attempts = <the claim's>` — and reports
 * whether it landed. `stillOurs` below is that predicate and carries the
 * reasoning; `processJob` returns `'lost'` when it is refused.
 *
 * Without it the worker was exactly the check-then-act it was built to avoid,
 * one level down: a careful claim followed by a write keyed on `id` alone, which
 * lands on whatever the row has become. That is a lost update, and on two of the
 * three paths it is a CHECK violation that abandons the rest of the batch.
 *
 * WHAT COUNTS AS DONE, AND WHAT COUNTS AS GIVING UP
 * -------------------------------------------------
 * A permanent failure (`ReceiptPermanentError`) stops immediately — the row is
 * marked `failed` and parked beyond the claim horizon. A transient one backs
 * off exponentially with jitter and retries until `RECEIPT_MAX_ATTEMPTS`, then
 * parks the same way. Parked rows are not deleted and not hidden: `failed` with
 * `attempts >= max` is the queue's dead letter, and it is queryable.
 *
 * A GIVEN-UP RECEIPT IS AN AUDIT EVENT
 * ------------------------------------
 * When a receipt is abandoned the customer has been charged and has no record of
 * it. That is a thing a salon may be asked about at a counter, so it writes an
 * audit row — `kind: 'risk'`, `source: 'system'` — rather than only a log line
 * on a server nobody is reading. Non-negotiable-adjacent: the money moved and
 * the customer was not told.
 *
 * NOT STARTED BY app.ts
 * ---------------------
 * `buildApp()` is what the tests construct, and a background loop attached to it
 * would send receipts inside every test run. The worker is started from
 * server.ts, behind `RECEIPT_WORKER_ENABLED`, which defaults ON — so a process
 * that serves requests drains its own outbox, and one that merely exercises
 * handlers leaves it still. See env.ts for the history of that default.
 */

import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { receiptJob } from '../db/schema/receipt';
import { transaction } from '../db/schema/transaction';
import { env } from '../env';
import { receiptSender, ReceiptPermanentError, type ReceiptChannel } from '../receipts';
import { writeAudit } from './audit';

/**
 * Where a parked row's `available_at` is pushed to.
 *
 * Far enough that the claim never sees it again, near enough that it is an
 * obvious sentinel in a query result rather than a mysterious year 9999.
 */
const PARK_MS = 100 * 365 * 24 * 60 * 60 * 1000;

/**
 * Exponential backoff with full jitter.
 *
 * `base * 2^(attempt-1)`, capped, then multiplied by a uniform random in
 * [0.5, 1]. The jitter is not decoration: an outage fails every queued receipt
 * at once, and an un-jittered schedule retries them all at the same instant
 * forever, which is a thundering herd aimed at a provider that is already
 * struggling. Half-jitter keeps the ordering roughly intact while spreading the
 * load.
 */
export function backoffMs(attempt: number): number {
  const raw = env.receiptBackoffBaseMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(raw, env.receiptBackoffMaxMs);
  return Math.round(capped * (0.5 + Math.random() * 0.5));
}

export interface ClaimedJob {
  id: string;
  transactionId: string;
  memberId: string;
  channel: ReceiptChannel;
  payload: Record<string, unknown>;
  attempts: number;
}

/**
 * Take up to `limit` jobs. One statement.
 *
 * Claimable is:
 *   - `queued` or `failed`, with attempts left, whose backoff has elapsed; or
 *   - `sending` whose lease has expired — a worker that died mid-send.
 *
 * THE `ORDER BY` PICKS WHICH ROWS. IT DOES NOT ORDER THE BATCH, AND NOTHING HERE
 * SHOULD PRETEND OTHERWISE.
 *
 * `ORDER BY available_at` exists so the `LIMIT` takes the oldest-due rows rather
 * than an arbitrary `limit` of them. That is all it does. `RETURNING` emits rows
 * in the outer UPDATE's own scan order, which SQL does not specify and which is
 * not the subquery's order — measured on this project's Postgres with eight rows
 * of DISTINCT `available_at`: the subquery selected ids 8,7,6,5 by due order and
 * `RETURNING` handed back 5,6,7,8, the exact reverse. `runOnce` iterates
 * `RETURNING` order, so the order jobs are PROCESSED in is undefined regardless
 * of what this clause says.
 *
 * There is deliberately NO TIE-BREAK (`, id`, `, created_at`), and the reason is
 * not that ties are rare. `queueReceipts` inserts a transaction's channels as ONE
 * multi-row INSERT, so both rows take the same `now()` default and tie by
 * construction — checked against this lane's seeded data, every transaction with
 * two receipt rows has one distinct `created_at`. The reason is that a tie-break
 * would buy nothing anybody can use:
 *
 *   - It cannot make processing order deterministic, because `RETURNING` is what
 *     decides that and the subquery's ordering does not reach it. A test that
 *     depends on batch order is not fixed by adding one — see
 *     receiptWorker.int.test.ts, where exactly that route was tried and measured
 *     failing.
 *   - It cannot make claiming FAIR under concurrency either. `SKIP LOCKED` means
 *     two workers take different sets whatever this clause says, which is the
 *     deployment `RECEIPT_WORKER_ENABLED` defaulting to `'1'` actually produces.
 *   - `id` is `uuid defaultRandom()`, so ordering by it is not FIFO — it is a
 *     second arbitrary order wearing the costume of a guarantee. If fairness
 *     among equally-due rows were ever wanted, `created_at` is the column that
 *     means it, and it is not in `receipt_job_claim_idx`.
 *
 * Among equally-due jobs the order is genuinely indifferent to this worker: each
 * is claimed exclusively, each is processed independently, and no outcome depends
 * on a neighbour. Leave it indifferent rather than adding a promise production
 * cannot rely on to settle a question that belongs in a spec.
 */
export async function claimJobs(db: Db, limit: number): Promise<ClaimedJob[]> {
  const rows = await db.execute(sql`
    UPDATE receipt_job
       SET status = 'sending',
           attempts = attempts + 1,
           -- The lease is computed by the DATABASE, not by this process. The
           -- claim predicate below compares against the database clock, so a
           -- lease stamped from an app server whose clock drifts would be
           -- measured against a different clock than it was set by, which either
           -- releases a live job early or strands a dead one. Several API
           -- processes share one Postgres here and they do not agree on the
           -- time; the database is the only clock all of them share.
           available_at = now() + make_interval(secs => ${env.receiptLeaseMs} / 1000.0)
     WHERE id IN (
       SELECT id FROM receipt_job
        WHERE status IN ('queued', 'failed', 'sending')
          AND attempts < ${env.receiptMaxAttempts}
          AND available_at <= now()
        ORDER BY available_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
     )
    RETURNING id, transaction_id, member_id, channel, payload, attempts
  `);

  return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    transactionId: String(r.transaction_id),
    memberId: String(r.member_id),
    channel: r.channel as ReceiptChannel,
    payload: (r.payload ?? {}) as Record<string, unknown>,
    attempts: Number(r.attempts),
  }));
}

/**
 * THE CLAIM, RESTATED AS A WHERE CLAUSE.
 *
 * Every write below happens after an `await` on a third party, which is to say
 * long after the claim was taken. `WHERE id = $1` alone asserts nothing about
 * that gap: it says "this row", where the worker means "the row I claimed, in
 * the state I left it". Those are the same row only when nobody else has moved
 * it, and the whole point of the claim is that somebody else might.
 *
 * TWO TERMS, AND THE SECOND IS THE ONE THAT DOES THE WORK.
 *
 *   status = 'sending'   what the claim wrote. Catches every writer that moved
 *                        the row somewhere else — a QA helper parking the
 *                        outbox, a future admin retry, an operator's UPDATE.
 *
 *   attempts = $n        what the claim RETURNED, and the only thing that
 *                        distinguishes one claim from the next. `attempts` is
 *                        incremented in exactly one place — `claimJobs` — so it
 *                        is the claim's generation counter whether or not it was
 *                        designed as one. Without it a lease expiry is invisible
 *                        here: instance A's lease runs out, instance B re-claims
 *                        and leaves the row in `sending` again, and A's write
 *                        still sees `sending` and still lands on a row that is
 *                        no longer its own.
 *
 * WHY THIS IS NOT DEFENCE IN DEPTH AGAINST A THING THAT CANNOT HAPPEN.
 * `RECEIPT_WORKER_ENABLED` defaults to `'1'`, so every API process runs this
 * loop, and `available_at` is a LEASE precisely so a second process can take
 * over a row the first is still sending. Two writers on one job is the design,
 * not the accident. What was accidental was writing as if it were not.
 *
 * AND THE FAILURE IS NOT QUIET. `receipt_job_sent_at_matches_status` is
 * `(status = 'sent') = (sent_at IS NOT NULL)`, so a late `markFailed` or a late
 * give-back over a row another worker has already sent does not lose a race —
 * it RAISES, out of `processJob`, out of `runOnce`, abandoning every job the
 * batch had not reached yet in `sending` for a whole lease. See
 * receiptWorker.int.test.ts, which stages it.
 */
function stillOurs(job: ClaimedJob) {
  return and(
    eq(receiptJob.id, job.id),
    eq(receiptJob.status, 'sending'),
    eq(receiptJob.attempts, job.attempts),
  );
}

/**
 * True when the write landed. False means somebody else owns this row now.
 *
 * `providerReference` IS NOT PERSISTED. There is no column for it on
 * `receipt_job`, and this function does not write one — decision 74. The
 * parameter stays because the driver seam returns it and whether support needs to
 * follow a receipt into the provider's logs is an open product question; adding a
 * column on this file's judgement would answer it by accident. Until it is
 * answered, the only honest thing is that the value is received and dropped, and
 * `receipts/types.ts` now says so at the field rather than claiming it is stored.
 */
async function markSent(db: Db, job: ClaimedJob, providerReference: string): Promise<boolean> {
  const now = new Date();
  const rows = await db
    .update(receiptJob)
    .set({
      status: 'sent',
      // The CHECK `receipt_job_sent_at_matches_status` requires these two to
      // move together, which is the schema refusing a half-recorded send.
      sentAt: now,
      lastError: null,
      availableAt: now,
    })
    .where(stillOurs(job))
    .returning({ id: receiptJob.id });
  return rows.length === 1;
}

/**
 * Give up on a job, and say so where someone will find it.
 *
 * `park` pushes `available_at` past the claim horizon rather than adding a
 * `dead` status the schema does not have. The row stays `failed` with its
 * attempt count and its last error, which is what a dead letter is.
 */
async function markFailed(
  db: Db,
  job: ClaimedJob,
  message: string,
  park: boolean,
): Promise<boolean> {
  const rows = await db
    .update(receiptJob)
    .set({
      status: 'failed',
      lastError: message.slice(0, 1000),
      availableAt: new Date(Date.now() + (park ? PARK_MS : backoffMs(job.attempts))),
    })
    .where(stillOurs(job))
    .returning({ id: receiptJob.id });
  if (rows.length !== 1) return false;

  if (!park) return true;

  /**
   * The customer paid and will not be told. That belongs in the salon's audit
   * log, not only in a server log: it is `risk`, it is attributable to nobody
   * (`source: 'system'`, principal null → actor "System · Automatic"), and it is
   * the row someone reads when a customer says she never got a receipt.
   *
   * The salon comes from the transaction, because `receipt_job` has no
   * `salon_id` — the receipt belongs to a transaction and the transaction knows
   * whose it is.
   */
  const [tx] = await db
    .select({ salonId: transaction.salonId })
    .from(transaction)
    .where(eq(transaction.id, job.transactionId))
    .limit(1);
  if (!tx) return true;

  await writeAudit(db, null, {
    salonId: tx.salonId,
    kind: 'risk',
    action: 'Receipt could not be sent',
    detail: `${job.channel} receipt for ${job.transactionId} gave up after ${job.attempts} attempts · ${message}`.slice(
      0,
      500,
    ),
    source: 'system',
    subjectType: 'receipt_job',
    subjectId: job.id,
    metadata: { channel: job.channel, transactionId: job.transactionId, attempts: job.attempts },
  });
  return true;
}

/**
 * Send one claimed job. Never throws — a bad job must not stop the batch.
 *
 * `'lost'` is the fourth outcome and it is not a failure: it means the write was
 * REFUSED because the row is no longer the one this worker claimed, so whatever
 * took it owns the outcome now. Reporting it as `sent` or `retry` would be the
 * same lie the unguarded write told — a count of sends that did not happen — and
 * the reason it took a phantom flake in another lane to find this at all.
 */
export async function processJob(
  db: Db,
  job: ClaimedJob,
): Promise<'sent' | 'retry' | 'gave_up' | 'lost'> {
  /**
   * A driver that does not handle this channel is NOT a failure. Running a
   * WhatsApp-only driver should leave email rows queued for the driver that
   * does, not burn their attempts. The attempt increment from the claim is given
   * back, because nothing was attempted.
   *
   * GUARDED LIKE THE OTHER TWO, and this is the one path where the two-worker
   * case is not hypothetical at all: a deployment that runs a WhatsApp-only
   * driver beside an email-capable one is the deployment this branch exists for,
   * and it is exactly a deployment where one instance may give back a row the
   * other has already sent. Unguarded that write is `queued` over a row with
   * `sent_at` set, which the CHECK refuses — and this branch is not inside the
   * `try`, so the raise would leave `processJob` unconditionally.
   */
  if (!receiptSender.handles(job.channel)) {
    const rows = await db
      .update(receiptJob)
      .set({
        status: 'queued',
        attempts: Math.max(0, job.attempts - 1),
        availableAt: new Date(Date.now() + env.receiptPollMs),
      })
      .where(stillOurs(job))
      .returning({ id: receiptJob.id });
    return rows.length === 1 ? 'retry' : 'lost';
  }

  try {
    const result = await receiptSender.send({
      jobId: job.id,
      channel: job.channel,
      transactionId: job.transactionId,
      memberId: job.memberId,
      payload: job.payload,
      attempt: job.attempts,
    });
    return (await markSent(db, job, result.providerReference)) ? 'sent' : 'lost';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const permanent = err instanceof ReceiptPermanentError;
    const exhausted = job.attempts >= env.receiptMaxAttempts;
    const park = permanent || exhausted;

    const landed = await markFailed(
      db,
      job,
      permanent ? `permanent: ${message}` : message,
      park,
    );
    if (!landed) return 'lost';
    return park ? 'gave_up' : 'retry';
  }
}

export interface TickResult {
  claimed: number;
  sent: number;
  retry: number;
  gaveUp: number;
  /**
   * Jobs whose write was refused because the row had moved on. Not an error and
   * not a send: another writer owns the outcome, and this pass says so instead
   * of counting it as its own. A number that is persistently non-zero means two
   * workers are contending for the same rows faster than the lease intends, and
   * `RECEIPT_LEASE_MS` is the thing to look at.
   */
  lost: number;
}

/** One pass. Exported so a test can drive the worker without a timer. */
export async function runOnce(db: Db, limit = env.receiptBatchSize): Promise<TickResult> {
  const jobs = await claimJobs(db, limit);
  const out: TickResult = { claimed: jobs.length, sent: 0, retry: 0, gaveUp: 0, lost: 0 };

  // Sequential, not Promise.all. The batch size is the concurrency control, and
  // a provider's rate limit is the reason to keep it that way.
  for (const job of jobs) {
    const outcome = await processJob(db, job);
    if (outcome === 'sent') out.sent += 1;
    else if (outcome === 'gave_up') out.gaveUp += 1;
    else if (outcome === 'lost') out.lost += 1;
    else out.retry += 1;
  }
  return out;
}

export interface ReceiptWorker {
  stop(): Promise<void>;
}

/**
 * Start the loop. Returns a handle so `server.ts` can stop it on shutdown.
 *
 * A self-rescheduling timeout rather than `setInterval`: an interval fires on a
 * fixed schedule regardless of how long the previous pass took, so a slow
 * provider stacks overlapping passes that then fight over the same rows. This
 * waits `pollMs` AFTER the previous pass finished.
 */
export function startReceiptWorker(
  db: Db,
  log: (o: Record<string, unknown>) => void = () => {},
): ReceiptWorker {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<unknown> = Promise.resolve();

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const result = await runOnce(db);
      if (result.claimed > 0) log({ event: 'receipt.tick', ...result });
    } catch (err) {
      // A failure to CLAIM — the database is down, not the provider. Logged and
      // retried on the next tick; there is no row to mark, because none was
      // taken.
      log({ event: 'receipt.tick.error', error: err instanceof Error ? err.message : String(err) });
    }
    if (!stopped) timer = setTimeout(() => void (inFlight = tick()), env.receiptPollMs);
  };

  inFlight = tick();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      // Let the pass in flight finish, so shutdown does not strand a row in
      // `sending` that then has to wait out its whole lease.
      await inFlight.catch(() => undefined);
    },
  };
}
