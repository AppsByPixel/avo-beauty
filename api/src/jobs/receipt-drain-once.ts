/**
 * Drain the receipt outbox once, and print what happened.
 *
 *   pnpm --dir=/abs/path/to/api run job:receipt-drain
 *
 * ============================================================================
 * WHY THIS EXISTS AT ALL, GIVEN THE WORKER ALREADY RUNS
 * ============================================================================
 * `server.ts` starts the worker and `RECEIPT_WORKER_ENABLED` defaults to `1`, so
 * a process deployment drains its own outbox and needs nothing from this file.
 *
 * `serverless.ts` starts NO LOOPS — api/README.md § "Two entry points" has the
 * table, and the receipt worker's row says "never". While `RECEIPT_DRIVER` was
 * `logging` that cost a growing table and nothing else, because nothing was going
 * to be sent under any circumstances.
 *
 * SELECTING A REAL DRIVER CHANGES WHAT THE ABSENCE MEANS, AND THAT IS THE WHOLE
 * ARGUMENT FOR THIS FILE. An undrained row is not a failed send. It is `queued`
 * for ever: no attempt, no `last_error`, no `risk` audit — `markFailed` is the
 * only thing that writes one and it is only reached by a job somebody claimed.
 * So a serverless deployment with `RECEIPT_DRIVER=email` promises every customer
 * a receipt and breaks the promise SILENTLY, with a merchant who now believes
 * receipts send and a table whose rows all read "queued, waiting". That is
 * strictly worse than having no email driver at all, and the only thing standing
 * between the two is a scheduled drain.
 *
 * ============================================================================
 * AND IT IS NOT ENOUGH ON ITS OWN. READ THIS BEFORE DEPLOYING ANYTHING.
 * ============================================================================
 * A cron platform calls URLs. This is a script. So this file is drainable from
 * anything that can run the repository against the database — an operator's
 * machine, a scheduled container, a CI cron — and it is NOT drainable by the
 * serverless platform that is serving the API.
 *
 * NO HTTP ENDPOINT WAS ADDED, deliberately and on instruction: a route is a
 * product change (CLAUDE.md § "Do not add features") and it is a route that
 * drains a customer-facing queue, which needs an authorisation story of its own
 * before it needs an implementation. The two configurations that are safe today:
 *
 *   a process deployment  `render.yaml` runs `server.ts`. The worker is on, the
 *                         outbox drains, and this script is only ever a manual
 *                         catch-up.
 *
 *   serverless + a cron   something outside the function has to run this on a
 *                         schedule. Nothing in this repository sets that up.
 *
 * A serverless deployment with `RECEIPT_DRIVER=email` and neither of those is a
 * defect, not a limitation, and go-live-checklist.md is where it belongs.
 *
 * ============================================================================
 * IT DRAINS, RATHER THAN RUNNING ONE PASS
 * ============================================================================
 * `runOnce` claims at most `RECEIPT_BATCH_SIZE` (20). A cron every five minutes
 * calling it once clears 240 receipts an hour, which is fine until the hour
 * somebody was down, and then it never catches up. So this repeats until a pass
 * claims nothing, or until `MAX_PASSES` — a bound, because an invocation with no
 * ceiling is one that runs until a platform kills it mid-send and leaves a row in
 * `sending` for a whole lease.
 *
 * The other four one-shots' three reasons apply unchanged — operational,
 * evidential, accountable (`jobs/topup-reap-once.ts` states them) — and the
 * evidential one earns its keep here: "a transient failure comes back and a
 * permanent one does not" is a claim about `available_at`, and this makes it two
 * commands and a query instead of a fifteen-minute wait.
 *
 * SAFE TO RUN WHILE THE API IS UP. `claimJobs` is one statement taking `FOR
 * UPDATE SKIP LOCKED`, and every write after it re-asserts the claim — so a
 * manual drain running beside a live worker takes different rows, and the one
 * case where they collide is counted as `lost` rather than mis-reported as a
 * send.
 */

import { db } from '../db/client';
import { env } from '../env';
import { runOnce, type TickResult } from '../services/receiptWorker';

/**
 * At `RECEIPT_BATCH_SIZE` 20 this is 1000 receipts per invocation. Reached only
 * by a real backlog, and a run that reaches it says so in `hitCeiling` so the
 * next one is scheduled rather than assumed unnecessary.
 */
const MAX_PASSES = 50;

const totals: TickResult & { passes: number; hitCeiling: boolean } = {
  claimed: 0,
  sent: 0,
  retry: 0,
  gaveUp: 0,
  lost: 0,
  passes: 0,
  hitCeiling: false,
};

for (let pass = 0; pass < MAX_PASSES; pass += 1) {
  const result = await runOnce(db);
  totals.passes += 1;
  totals.claimed += result.claimed;
  totals.sent += result.sent;
  totals.retry += result.retry;
  totals.gaveUp += result.gaveUp;
  totals.lost += result.lost;
  if (result.claimed === 0) break;
  if (pass === MAX_PASSES - 1) totals.hitCeiling = true;
}

console.log(JSON.stringify({ driver: env.receiptDriver, ...totals }, null, 2));

/**
 * `gaveUp` is the number that is not housekeeping, and it is `topup-reap`'s
 * `awaitingCredit` wearing different clothes: each one is a customer who paid and
 * was not told. The audit row is already written — this is the second place,
 * because a cron's output is read and an audit log is not.
 *
 * STILL EXIT 0, like every other one-shot. A cron that goes red because two
 * receipts bounced teaches an operator to ignore the cron, and the run did
 * succeed: it drained the queue and recorded what could not be delivered.
 */
if (totals.gaveUp > 0) {
  console.error(
    `\n${totals.gaveUp} receipt(s) were given up on. Each is a customer who paid and ` +
      'has no record of it. They are in audit_log as kind=risk, "Receipt could not be ' +
      'sent", and in receipt_job as failed rows parked past the claim horizon:\n' +
      "  SELECT id, channel, transaction_id, attempts, last_error FROM receipt_job\n" +
      "   WHERE status = 'failed' AND available_at > now() + interval '1 year';\n",
  );
}

if (totals.hitCeiling) {
  console.error(
    `\nThe ${MAX_PASSES}-pass ceiling was reached, so the queue is NOT empty. ` +
      'Run this again, and find out why it got this far behind before assuming the ' +
      'next run clears it.\n',
  );
}

process.exit(0);
