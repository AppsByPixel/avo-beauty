/**
 * Retry every HELD campaign exactly once, and print what it did.
 *
 *   pnpm --dir=/abs/path/to/api run job:campaign-release
 *
 * A HOLD IS A REASON, NOT A REJECTION, WHICH IS WHY THIS HAS TO EXIST. Quiet
 * hours end. A month rolls over. A customer's weekly window expires. Non-negotiable
 * #8 says a breaching campaign is "held and reported, never silently dropped" —
 * and a hold nothing ever retries IS a silent drop with a paper trail: the salon
 * was told her campaign was approved, and it would never go out.
 *
 * WHY A ONE-SHOT RUNNER AND NOT A TIMER, and this is the deliberate part.
 *
 * `services/noShowWorker.ts` has both a timer and `jobs/no-show-once.ts`, and that
 * file's own reasoning is the precedent: "a claim about a background loop that can
 * only be exercised by waiting for a timer is a claim nobody checks. This makes it
 * two commands and a diff."
 *
 * STATUS.md then records what happened to it: "The no-show return job has never
 * been executed by a spec … `no_show_returned` appears in ZERO assertions." A
 * runner built for evidence, unused. So this ships as the runner FIRST, and it has
 * been run — the output is in the commit message that added it, against a real
 * held campaign, twice, with the second pass reporting nothing left to do. The
 * timer is a separate decision with a separate test, and adding one before the
 * behaviour had been observed even once would repeat exactly the mistake above.
 *
 * SAFE TO RUN WHILE THE API IS UP. `releaseHeldCampaigns` takes one transaction
 * per campaign and `campaign_send`'s primary key is `(campaign_id, member_id)`, so
 * two simultaneous passes cannot double-message anybody: the loser of the race
 * violates the key and rolls back that one campaign, leaving the others alone.
 * That is the property a scheduler firing twice needs, and it is a database fact
 * rather than this runner's good manners.
 *
 * THE ACTOR IS `null`, AND THAT IS CORRECT. A release that happens because the
 * clock passed 09:00 was not decided by a person — `decidedBy` still names the
 * admin who approved it, which is the decision that mattered, and the audit row
 * for the send reads `System / Automatic` because the system is what sent it. The
 * same distinction `auth.ts` makes for a PIN lockout.
 */

import { db } from '../db/client';
import { releaseHeldCampaigns } from '../services/campaign';

const now = new Date();
const outcomes = await releaseHeldCampaigns(db, now);

console.log(
  JSON.stringify(
    {
      at: now.toISOString(),
      considered: outcomes.length,
      sent: outcomes.filter((o) => o.status === 'sent').length,
      stillHeld: outcomes.filter((o) => o.status === 'held').length,
      recipients: outcomes.reduce((n, o) => n + o.sent, 0),
      cappedOut: outcomes.reduce((n, o) => n + o.cappedOut, 0),
      /**
       * The reasons, verbatim. A run that held everything is the normal outcome at
       * 03:00 and must not read as a failure — the reason is what tells the two
       * apart, and printing a count alone is what would make an operator guess.
       */
      reasons: outcomes.filter((o) => o.status === 'held').map((o) => o.heldReason),
      results: outcomes.filter((o) => o.status === 'sent').map((o) => o.result),
    },
    null,
    2,
  ),
);

process.exit(0);
