/**
 * Run the detached-image reaper exactly once, and print what it did.
 *
 *   pnpm --dir=/abs/path/to/api run job:image-reap
 *
 * NO IN-PROCESS LOOP, unlike the receipt worker and unlike the no-show job, and
 * that is a decision rather than an omission. Both of those exist to keep a
 * PROMISE TO A CUSTOMER on a clock — a receipt she is waiting for, a deposit she
 * is owed back. This one deletes bytes nobody is looking at. Nothing degrades if
 * it runs weekly instead of every fifteen minutes, and a loop would be a second
 * thing to configure, a second thing to leak (LANES.md § Ports and processes),
 * and a second thing that can delete the wrong object at three in the morning.
 * An operator's cron, or the store's own lifecycle rule, is the right owner —
 * services/imageReaper.ts § WHAT THIS DOES NOT COLLECT says why the bucket wins
 * in the end.
 *
 * Safe to run while the API is up, and safe to run twice. The delete's WHERE
 * re-states both preconditions — still detached, still unreferenced — so a pass
 * racing a merchant re-uploading the same file reports `reattached` and removes
 * nothing.
 */

import { db } from '../db/client';
import { env } from '../env';
import { runImageReapOnce } from '../services/imageReaper';

const result = await runImageReapOnce(db);

console.log(
  JSON.stringify({ graceHours: env.imageDetachedGraceHours, ...result }, null, 2),
);

if (result.storeFailures > 0) {
  console.error(
    `\n${result.storeFailures} image(s) whose bytes the store refused to remove. ` +
      'Their rows were left whole and marked, so the next pass retries them. ' +
      'A count that does not fall is a store problem, not a data problem.\n',
  );
}

process.exit(0);
