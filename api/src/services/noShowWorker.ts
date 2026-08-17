/**
 * The no-show return job.
 *
 * "Auto-return of the deposit `noShowReturnMinutes` after a missed slot, as a
 * `deposit_return` transaction" — build-plan.md phase 6. "Money never leaves the
 * ecosystem; the deposit creates commitment, not punishment" —
 * AVO-Beauty-Product-Description-v2.md § 4.
 *
 * WHY THIS IS A JOB AND NOT A REQUEST
 * -----------------------------------
 * Every other money path in this API is triggered by somebody: a customer tops
 * up, a staff member charges, a customer cancels. This one is triggered by
 * ABSENCE. The customer is not there, which is the whole point — she is the one
 * who did not arrive — and the salon has no reason to touch anything either. If
 * the return waited for a request it would happen when someone next opened a
 * screen, which is to say at a time that has nothing to do with the promise made
 * to her.
 *
 * A read-time computation ("treat it as returned once the deadline passes") was
 * the other option and is worse in a way that matters: her wallet balance is a
 * stored number that the scanner, the dashboard and the ledger all read, so a
 * deposit that is returned only in the eye of one reader is a balance that
 * disagrees with itself. The money has to actually move.
 *
 * IDEMPOTENCE — IT WILL RUN OVER THESE ROWS AGAIN AND AGAIN
 * --------------------------------------------------------
 * The guarantee is the STATUS TRANSITION under a row lock, not a claim column
 * and not a lease. Each booking is processed in its own transaction which:
 *
 *   1. locks the member row       (the global lock order — see below)
 *   2. locks the booking row      FOR UPDATE
 *   3. re-reads status            and gives up unless it is still `deposit_held`
 *
 * A second pass — a second worker, a second API instance, or the same one run
 * twice by hand — blocks at step 2, wakes to `no_show_returned`, and returns
 * nothing. `booking_settlement_matches_status` in the schema is the backstop: a
 * second return would have to overwrite `settled_transaction_id`, and a booking
 * that is already terminal is never selected to begin with.
 *
 * That is deliberately weaker machinery than `services/receiptWorker.ts`, which
 * needs `FOR UPDATE SKIP LOCKED`, a lease and a retry budget. A receipt is an
 * external call that can half-happen; this is a local transaction that either
 * commits or does not. Borrowing the queue's apparatus would add a claim state
 * that can strand a booking in "being returned" when a worker dies, which is a
 * failure mode this shape simply does not have.
 *
 * THE LOCK ORDER IS MEMBER, THEN BOOKING, and it is not local to this file:
 * `performCharge` takes the member row `FOR UPDATE` as its first statement and
 * only then reaches for the held booking. A job that took them the other way
 * round would deadlock against a charge on the same customer — which is exactly
 * the case that happens most, since a customer who is late and then arrives is
 * being charged at about the moment this job wants her booking.
 */

import { and, asc, eq, lte } from 'drizzle-orm';
import type { Db } from '../db/client';
import { booking } from '../db/schema/booking';
import { member } from '../db/schema/member';
import { env } from '../env';
import { returnDeposit, type BookingRow } from './booking';
import { raiseMerchantNotification } from './notifications';

export interface NoShowTickResult {
  /** Rows that looked due when the pass started. */
  candidates: number;
  /** Deposits actually returned by THIS pass. */
  returned: number;
  /** Rows another pass had already taken. The proof that a re-run is a no-op. */
  alreadySettled: number;
  /** Rows that failed and will be retried next pass. */
  failed: number;
  returnedFils: number;
}

/**
 * One pass. Exported so a test — or a proof run — can drive the job without a
 * timer, and so that running it twice is a thing anyone can do and check.
 */
export async function runNoShowReturnsOnce(
  db: Db,
  limit = env.noShowBatchSize,
  nowOverride?: Date,
): Promise<NoShowTickResult> {
  const now = nowOverride ?? new Date();

  /**
   * Candidates, UNLOCKED. This read is a hint, not a decision — every row it
   * produces is re-checked under a lock below, which is what lets it be a cheap
   * index scan on `booking_no_show_due_idx` instead of a lock held across the
   * whole batch.
   */
  const candidates = await db
    .select({ id: booking.id, memberId: booking.memberId })
    .from(booking)
    .where(and(eq(booking.status, 'deposit_held'), lte(booking.noShowReturnDueAt, now)))
    .orderBy(asc(booking.noShowReturnDueAt))
    .limit(limit);

  const result: NoShowTickResult = {
    candidates: candidates.length,
    returned: 0,
    alreadySettled: 0,
    failed: 0,
    returnedFils: 0,
  };

  for (const candidate of candidates) {
    try {
      const outcome = await db.transaction(async (tx) => {
        // 1. the member, first. See the header on lock order.
        const [m] = await tx
          .select()
          .from(member)
          .where(eq(member.id, candidate.memberId))
          .for('update')
          .limit(1);
        if (!m) return 'skipped' as const;

        // 2. the booking, locked.
        const [row] = await tx
          .select()
          .from(booking)
          .where(eq(booking.id, candidate.id))
          .for('update')
          .limit(1);
        if (!row) return 'skipped' as const;

        /**
         * 3. THE RE-CHECK. This single line is what makes the job idempotent.
         *
         * Between the unlocked scan and this lock, the customer may have
         * cancelled, the artist may have charged her — completing the booking and
         * consuming the deposit — or another worker may have returned it. All
         * three leave a status that is no longer `deposit_held`, and all three
         * mean the same thing here: somebody else resolved this money, do not
         * resolve it again.
         *
         * The deadline is re-checked too, because a reschedule moves it: a
         * booking that was due when the scan ran and has since been moved to next
         * week must not be returned.
         */
        if (row.status !== 'deposit_held') return 'already' as const;
        if (row.noShowReturnDueAt > now) return 'already' as const;

        await returnDeposit(tx, {
          row: row as BookingRow,
          memberRow: m,
          reason: 'no_show',
          // NO PRINCIPAL. services/audit.ts writes "System · Automatic" for a
          // null actor, which is the truth: attributing an automatic refund to
          // whoever happened to be signed in is a lie in an append-only log.
          principal: null,
          now,
          note: 'No-show · deposit returned automatically',
        });

        /**
         * The merchant is told, once per booking. She lost a slot and the money
         * went back; that is a fact about her day, and the appointment list's
         * "No-show · returned" pill is the other half of it.
         *
         * Inside the same transaction as the return, so a notification about a
         * refund that rolled back cannot exist.
         */
        await raiseMerchantNotification(tx, {
          salonId: row.salonId,
          kind: 'booking_no_show',
          severity: 'info',
          title: 'A deposit was returned automatically',
          body:
            `${m.name} did not arrive for her appointment, and the ` +
            `${(row.depositFils / 1000).toFixed(3)} KD deposit has been returned to her wallet.`,
          subjectType: 'booking',
          subjectId: row.id,
          deepLink: `/merchant/appointments/${row.id}`,
          metadata: { bookingId: row.id, memberId: m.id, depositFils: row.depositFils },
        });

        return { returnedFils: row.depositFils } as const;
      });

      if (outcome === 'already' || outcome === 'skipped') result.alreadySettled += 1;
      else {
        result.returned += 1;
        result.returnedFils += outcome.returnedFils;
      }
    } catch {
      // One bad booking must not stop the batch — the same reasoning
      // `processJob` gives in the receipt worker. It stays `deposit_held` and
      // the next pass tries again, which is safe precisely because the
      // transition is the guarantee.
      result.failed += 1;
    }
  }

  return result;
}

export interface NoShowWorker {
  stop(): Promise<void>;
}

/**
 * Start the loop. Returns a handle so `server.ts` can stop it on shutdown.
 *
 * A self-rescheduling timeout rather than `setInterval`, for the reason the
 * receipt worker gives: an interval fires on a fixed schedule regardless of how
 * long the previous pass took, so a slow pass stacks overlapping passes that then
 * contend for the same rows.
 *
 * NOT STARTED BY `buildApp()`. A background loop attached to the app factory
 * would return deposits inside every test run, at a moment no test chose. Started
 * from server.ts, behind `NO_SHOW_WORKER_ENABLED`, which defaults ON — the same
 * split, and the same default, as the receipt worker.
 */
export function startNoShowWorker(
  db: Db,
  log: (o: Record<string, unknown>) => void = () => {},
): NoShowWorker {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<unknown> = Promise.resolve();

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const result = await runNoShowReturnsOnce(db);
      if (result.candidates > 0) log({ event: 'noshow.tick', ...result });
    } catch (err) {
      // A failure to SCAN — the database is down, not one booking. Nothing was
      // taken, so there is nothing to mark; the next tick retries.
      log({ event: 'noshow.tick.error', error: err instanceof Error ? err.message : String(err) });
    }
    if (!stopped) timer = setTimeout(() => void (inFlight = tick()), env.noShowPollMs);
  };

  inFlight = tick();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight.catch(() => undefined);
    },
  };
}
