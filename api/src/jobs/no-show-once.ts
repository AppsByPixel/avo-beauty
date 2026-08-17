/**
 * Run the no-show return job exactly once, and print what it did.
 *
 *   pnpm --filter @avo/api run job:no-show
 *
 * TWO REASONS THIS EXISTS, and neither is "for a test".
 *
 * OPERATIONAL. The worker inside the API process is the normal path, and it is
 * the one that stops when the API stops. After an outage, a deploy that was down
 * over an evening, or a database restore, somebody has to be able to drain the
 * backlog deliberately and see the number. `RECEIPT_WORKER_ENABLED` has the same
 * shape of need and no equivalent; that gap is worth not repeating.
 *
 * EVIDENTIAL. "Running the job twice returns the deposit once" is a claim about
 * a background loop, and a claim about a background loop that can only be
 * exercised by waiting for a timer is a claim nobody checks. This makes it two
 * commands and a diff.
 *
 * Safe to run while the API is up: the job's guarantee is a status transition
 * under a row lock, not a claim column, so a manual pass and the worker's pass
 * race harmlessly — one of them takes the row and the other reports it as
 * already settled.
 */

import { db } from '../db/client';
import { runNoShowReturnsOnce } from '../services/noShowWorker';

const result = await runNoShowReturnsOnce(db);

console.log(
  JSON.stringify(
    {
      candidates: result.candidates,
      returned: result.returned,
      alreadySettled: result.alreadySettled,
      failed: result.failed,
      returnedFils: result.returnedFils,
      returnedKd: (result.returnedFils / 1000).toFixed(3),
    },
    null,
    2,
  ),
);

process.exit(0);
