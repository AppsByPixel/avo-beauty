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

import { eq, sql } from 'drizzle-orm';
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

async function markSent(db: Db, job: ClaimedJob, providerReference: string): Promise<void> {
  const now = new Date();
  await db
    .update(receiptJob)
    .set({
      status: 'sent',
      // The CHECK `receipt_job_sent_at_matches_status` requires these two to
      // move together, which is the schema refusing a half-recorded send.
      sentAt: now,
      lastError: null,
      availableAt: now,
    })
    .where(eq(receiptJob.id, job.id));
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
): Promise<void> {
  await db
    .update(receiptJob)
    .set({
      status: 'failed',
      lastError: message.slice(0, 1000),
      availableAt: new Date(Date.now() + (park ? PARK_MS : backoffMs(job.attempts))),
    })
    .where(eq(receiptJob.id, job.id));

  if (!park) return;

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
  if (!tx) return;

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
}

/** Send one claimed job. Never throws — a bad job must not stop the batch. */
export async function processJob(db: Db, job: ClaimedJob): Promise<'sent' | 'retry' | 'gave_up'> {
  /**
   * A driver that does not handle this channel is NOT a failure. Running a
   * WhatsApp-only driver should leave email rows queued for the driver that
   * does, not burn their attempts. The attempt increment from the claim is given
   * back, because nothing was attempted.
   */
  if (!receiptSender.handles(job.channel)) {
    await db
      .update(receiptJob)
      .set({
        status: 'queued',
        attempts: Math.max(0, job.attempts - 1),
        availableAt: new Date(Date.now() + env.receiptPollMs),
      })
      .where(eq(receiptJob.id, job.id));
    return 'retry';
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
    await markSent(db, job, result.providerReference);
    return 'sent';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const permanent = err instanceof ReceiptPermanentError;
    const exhausted = job.attempts >= env.receiptMaxAttempts;
    const park = permanent || exhausted;

    await markFailed(
      db,
      job,
      permanent ? `permanent: ${message}` : message,
      park,
    );
    return park ? 'gave_up' : 'retry';
  }
}

export interface TickResult {
  claimed: number;
  sent: number;
  retry: number;
  gaveUp: number;
}

/** One pass. Exported so a test can drive the worker without a timer. */
export async function runOnce(db: Db, limit = env.receiptBatchSize): Promise<TickResult> {
  const jobs = await claimJobs(db, limit);
  const out: TickResult = { claimed: jobs.length, sent: 0, retry: 0, gaveUp: 0 };

  // Sequential, not Promise.all. The batch size is the concurrency control, and
  // a provider's rate limit is the reason to keep it that way.
  for (const job of jobs) {
    const outcome = await processJob(db, job);
    if (outcome === 'sent') out.sent += 1;
    else if (outcome === 'gave_up') out.gaveUp += 1;
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
