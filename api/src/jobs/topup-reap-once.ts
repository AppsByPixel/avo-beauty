/**
 * Run the abandoned top-up reaper exactly once, and print what it did.
 *
 *   pnpm --dir=/abs/path/to/api run job:topup-reap
 *
 * The two reasons `no-show-once.ts` gives, the third `erasure-once.ts` gives, and
 * a fourth that belongs to this job alone.
 *
 * OPERATIONAL. The in-process loop is OFF by default here — services/topupReaper.ts
 * says at length why, and the short version is that its window is not an approved
 * number yet. So for now THIS IS THE ONLY WAY THE REAPER RUNS, and an operator
 * draining a week of abandoned intents should see the count rather than infer it
 * from a table that got smaller.
 *
 * EVIDENTIAL. "Running it twice reaps the same intent once" is a claim about a
 * conditional UPDATE, and a claim that can only be exercised by waiting out a
 * timer is a claim nobody checks. This makes it two commands and a diff.
 *
 * ACCOUNTABLE. `awaitingCredit` is the number that matters and it is not a
 * housekeeping statistic. Each id in that list is an intent the PROCESSOR SAYS
 * WAS PAID and that this system has not credited — a customer who is out real
 * money. The reaper deliberately does not credit her (services/topupReaper.ts
 * § IT NEVER CREDITS); printing the ids is the accountable half of that
 * decision, and a count that does not fall to zero across runs is a support
 * ticket waiting to be filed by the customer instead of by us.
 *
 * `expiredStillOpenAtGateway` is the other number worth reading. It counts reaps
 * the gateway did not endorse — the ones that rest on `TOPUP_REAP_AFTER_HOURS`
 * being longer than any hosted invoice's life. If it is consistently large, that
 * assumption is wrong for the configured processor and the window needs raising
 * before anything else is done.
 *
 * Safe to run while the API is up. Every write is a conditional UPDATE whose
 * WHERE re-states the precondition, so a manual pass, a webhook and a customer's
 * own `GET /topups/{id}` race harmlessly: one of them moves the row and the
 * others report it as already resolved.
 */

import { db } from '../db/client';
import { TOPUP_REAP_AFTER_HOURS, runTopUpReapOnce } from '../services/topupReaper';

const result = await runTopUpReapOnce(db);

console.log(JSON.stringify({ windowHours: TOPUP_REAP_AFTER_HOURS, ...result }, null, 2));

if (result.awaitingCredit > 0) {
  console.error(
    `\n${result.awaitingCredit} intent(s) the processor calls PAID have not been credited. ` +
      `These are customers owed money, not housekeeping:\n  ` +
      result.awaitingCreditIds.join('\n  ') +
      '\n',
  );
}

process.exit(0);
