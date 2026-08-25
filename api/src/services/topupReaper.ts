/**
 * The abandoned top-up intent reaper. DECISIONS.md #27.
 *
 * `topup_intent` rows created at `created` / `redirected` stay there for ever.
 * The `expired` failure reason has been declared in db/schema/topup.ts since the
 * table was written and NOTHING HAS EVER WRITTEN IT. Every abandoned payment,
 * every crashed app, every "actually, let me use a different card" leaves a row
 * that no code path can ever resolve, because the only two things that resolve
 * an intent are a webhook the customer will never trigger and a
 * `GET /topups/{id}` from a wallet screen she has closed.
 *
 * Lane B found it by driving the flow: five intents in one session, two
 * permanently stranded at `redirected`. This lane's own database, before this
 * file existed, held a hundred:
 *
 *     select status, failure_reason, (psp_reference is null) as no_psp, count(*)
 *       from topup_intent group by 1,2,3;
 *
 *      status   | failure_reason | no_psp | count
 *     ----------+----------------+--------+-------
 *     redirected|                | f      |   100
 *
 * ======================================================================
 * THIS IS NOT A MONEY DEFECT, AND THE REAPER MUST NOT MAKE IT ONE
 * ======================================================================
 * A stranded intent credits nothing. `member.balance_fils` is untouched, there
 * is no `transaction` row, there is no ledger pair. That is the state and it is
 * a safe one. Everything below is arranged so that the CURE cannot be worse than
 * the disease, because the one way to turn this into a money defect is to write
 * a terminal state on an intent the customer is still paying for. `failed` has
 * no arrow out of it — the state machine in services/topup.ts says so and the
 * BEFORE UPDATE trigger in migration 0004 enforces it against any writer at all
 * — so an intent reaped too early is an intent that can NEVER be credited, even
 * when the processor later confirms she paid. Her money would sit at the PSP
 * against a row this system had already given up on.
 *
 * That asymmetry decides every choice in this file. A row that lingers costs a
 * few hundred bytes. A row reaped early costs a customer her top-up.
 *
 * WHAT IT ACTUALLY COSTS TO LEAVE THEM, since "unbounded table" undersells it:
 *
 *   1. RECONCILIATION. go-live-checklist.md wants "a daily job matches gateway
 *      settlements to `Transaction` rows". That job has to tell an abandoned
 *      intent apart from a settlement that never arrived, and today every
 *      abandoned intent looks exactly like the second thing.
 *   2. ERASURE IS BLOCKED FOR EVER. services/erasure.ts defers a member whose
 *      `topup_intent` has any status in `LIVE_INTENT_STATUSES` —
 *      `deferred_pending_topup`. One abandoned payment page means her 30-day
 *      deletion promise is never kept, and the deferral count in
 *      `jobs/erasure-once.ts` climbs with no way to clear it. That is a
 *      published legal deadline broken by a row nobody can resolve, and it is
 *      the reason the window below is set well inside thirty days.
 *
 * ======================================================================
 * WHAT "SAFE TO REAP" MEANS — THE GATEWAY IS CONSULTED, AND IT CAN VETO
 * ======================================================================
 * An intent at `redirected` with a payment behind it at the processor is NOT
 * obviously abandoned. She may be on the hosted page right now. So this job
 * never decides from our own row alone when there is a `psp_reference` to ask
 * about: it calls `gateway.fetchPayment` — the same authoritative read
 * `GET /topups/{id}` makes, described by gateway/types.ts as "the ONLY thing
 * entitled to move a balance" — and lets the answer decide.
 *
 * Five answers, three of them a veto:
 *
 *   succeeded      NEVER REAPED, and this is the loudest outcome in the result.
 *                  The processor says she paid and this system has not credited
 *                  her. That is money owed to a customer and it is exactly the
 *                  row the daily reconciliation exists to surface. Counted as
 *                  `awaitingCredit`, with the ids, and left OPEN so the next
 *                  `GET /topups/{id}` or re-delivered webhook settles it through
 *                  the path that was built for it.
 *
 *                  THE REAPER DOES NOT CREDIT IT. See the section below; that is
 *                  the one deliberate omission here and it is not an oversight.
 *
 *   pending        THE ONLY REAP THE GATEWAY DOES NOT ENDORSE, and the one case
 *                  where the WINDOW rather than the processor's answer carries
 *                  the safety. myfatoorah.ts § outcomeFor: an open invoice
 *                  reports `PENDING`, "and the customer can still pay the SAME
 *                  PaymentURL until it expires" — so `pending` on its own is
 *                  never grounds to reap, and inside the window it is an
 *                  absolute veto. What makes it reapable at 168 hours is that no
 *                  hosted invoice is still payable a week later; the processor
 *                  is reporting the shape of a row it has stopped caring about
 *                  rather than an offer the customer can still take up. Counted
 *                  separately as `expiredStillOpenAtGateway` so that assumption
 *                  is measurable rather than assumed — if that number is large,
 *                  the window is wrong. Left alone, and left OPEN, at any age
 *                  below the window.
 *
 *                  This arm is why the reaper is not inert. Under MyFatoorah an
 *                  abandoned invoice reports `PENDING` for ever and nothing else
 *                  in this system will ever say otherwise, so a reaper that
 *                  treated `pending` as a permanent veto would resolve nothing
 *                  and DECISIONS.md #27 would still be open.
 *
 *   declined       Applied through `settleFromGatewayRead`, unchanged, exactly
 *   cancelled      as a wallet read would apply it. The intent becomes
 *   gateway_error  `failed`/`cancelled` carrying the PROCESSOR'S OWN reason
 *                  rather than a guessed one — `declined` is a truer word than
 *                  `expired` and it is the word the customer's failure screen
 *                  should show. NO MONEY MOVES: `applyOutcome` credits on
 *                  `succeeded` and on nothing else, and `succeeded` is the one
 *                  outcome this job never forwards.
 *
 *   unreachable    VETO. A processor that does not answer has told us nothing.
 *                  Writing a terminal state on a failure to reach a third party
 *                  is how an outage becomes a hundred stranded top-ups. Counted
 *                  as `gatewayUnreachable`; the next pass asks again.
 *
 * A NOTE ON WHY "the processor has never heard of this reference" IS NOT ITS OWN
 * ARM. It would be the safest possible reap, and the seam cannot express it:
 * `SandboxGateway.fetchPayment` raises `GatewayUnavailableError` for an unknown
 * reference on purpose ("A real processor 404s a reference it never issued.
 * Treating that as 'not succeeded yet' would be a guess; it is an operational
 * fault"), so a 404 and a dead processor arrive here as the same exception. They
 * are therefore treated as the same thing, in the conservative direction. Giving
 * `PaymentGateway` a fifth method to separate them is a real improvement and a
 * bigger change than this slice; it is worth doing when the daily reconciliation
 * job is built, which is the other caller that wants it.
 *
 * ======================================================================
 * SO WHEN IS `expired` ACTUALLY WRITTEN?
 * ======================================================================
 * Two cases, and both mean "nothing can ever settle this row":
 *
 *   1. `psp_reference IS NULL`. The intent never reached a processor, so there
 *      is no payment anywhere, no page she can be on, and no read that could
 *      ever resolve it — `readTopUp` returns early on exactly this condition and
 *      `applyOutcome` keys on the reference. Provable from our own row.
 *
 *   2. The gateway still reports `pending` after the whole window has passed.
 *      This is the case the window exists for, and the only one where the NUMBER
 *      carries the safety rather than the gateway's answer. See below.
 *
 * `failed` + `expired`, not `cancelled` + `expired`: `cancelled_by_user` is what
 * a cancellation means in this vocabulary, and she did not cancel — she walked
 * away, which is a different fact and deserves the different word the schema
 * already provides. `open → failed` is a legal arrow at both the state machine
 * and the trigger.
 *
 * ======================================================================
 * WHAT THIS JOB DELIBERATELY DOES NOT DO: IT NEVER CREDITS
 * ======================================================================
 * It would be one line. `settleFromGatewayRead(db, intent, 'succeeded', …)` is
 * right there, it is the proven path, and it would rescue the customer whose
 * webhook was lost and who never reopened the app. It is not done, for three
 * reasons worth stating rather than leaving to be re-litigated:
 *
 *   - A credit is a customer-visible money event. Doing it because she opened
 *     her wallet and asked "did my top-up work?" is a different act from doing
 *     it on a timer nobody is watching, against a row she walked away from.
 *   - The blast radius is asymmetric in the opposite direction to everything
 *     else in this file. A reaper that refuses to expire leaves a row. A reaper
 *     that credits from a mis-mapped processor status, or from the sandbox's
 *     `succeeded` default, is an unattended credit machine — and the sandbox
 *     default is not hypothetical: all hundred rows quoted at the top of this
 *     file have `outcome = 'succeeded'` sitting behind them in
 *     `sandbox_gateway_payment`.
 *   - It is a different slice. "Should a background job credit a wallet from a
 *     gateway read the customer did not request" is the reconciliation job's
 *     question and it is Aftab's to answer. Queued, not smuggled in here.
 *
 *   So the answer is a NUMBER AND A LIST OF IDS, printed by
 *   `jobs/topup-reap-once.ts`, which is the accountable version of the same
 *   information — `jobs/erasure-once.ts` § ACCOUNTABLE makes this argument for
 *   its own deferred counts and it is the same argument.
 *
 * ======================================================================
 * THE WINDOW — 168 HOURS, AND IT IS NOT MINE TO PICK
 * ======================================================================
 * "How long may a customer leave a payment page open and still come back to it?"
 * is a product question, queued for Aftab exactly as the rate-limit thresholds
 * were. A CONSTANT AND NOT AN ENV VAR, on `passwordResetLimit.ts`'s argument:
 * signup is env-tuned because launch traffic is a genuine unknown, and this is
 * not one. A hosted payment page's life is a property of processors, not of our
 * traffic, and a per-deployment knob invites someone to tighten it under
 * disk-space pressure — which is the one direction that touches money.
 *
 * WHAT 168 ASSUMES: that no processor this system is ever configured against
 * keeps a hosted invoice payable for longer than a week.
 * `gateway/myfatoorah.ts` sets no `ExpiryDate` on `ExecutePayment`, so
 * MyFatoorah's own default governs, and it is days rather than weeks. KNET
 * hosted sessions are minutes. Seven days clears both by a wide margin, and if
 * that assumption is ever false for a chosen PSP, this number is wrong and the
 * first query below is how it is caught.
 *
 * WHAT IT WOULD REAP: an intent nobody has touched for a week that the processor
 * still calls open, or one that never got a reference at all.
 *
 * WHAT IT WOULD NOT: anything younger than a week — a customer distracted for an
 * afternoon, a KNET leg settling overnight, a phone that died at the payment
 * page and came back the next morning. Anything the processor calls paid, ever,
 * at any age. Anything at all while the processor is unreachable.
 *
 * WHY NOT LONGER: thirty days is the erasure deadline this row can block, and a
 * reaper that ran slower than the promise it unblocks would be pointless. Seven
 * days leaves twenty-three days of margin.
 *
 * REVISE IT WITH REAL DATA, NOT WITH AN OPINION. The question the number answers
 * is "how long does a top-up that eventually settles actually take?", and the
 * window must stay far above the slowest one ever observed:
 *
 *     select
 *       count(*)                                                        as settled,
 *       percentile_disc(0.50) within group (order by settled_at - created_at) as p50,
 *       percentile_disc(0.95) within group (order by settled_at - created_at) as p95,
 *       percentile_disc(0.99) within group (order by settled_at - created_at) as p99,
 *       max(settled_at - created_at)                                    as slowest
 *     from topup_intent
 *     where status = 'succeeded' and settled_at is not null;
 *
 * If `slowest` ever comes within a factor of two of the window, RAISE THE WINDOW
 * — do not lower it because p99 is small. And to see what the current number
 * would touch before changing anything:
 *
 *     select status, (psp_reference is null) as never_reached_gateway, count(*)
 *     from topup_intent
 *     where status in ('created','redirected','pending')
 *       and created_at < now() - interval '168 hours'
 *     group by 1, 2 order by 3 desc;
 *
 * ======================================================================
 * WHY `created_at` AND NOT `updated_at`
 * ======================================================================
 * `updated_at` is the more obviously correct clock — "nothing has happened to
 * this row for a week" — but for an abandoned intent the two are seconds apart:
 * `created → redirected` is written inside `createTopUp`'s own transaction and
 * nothing ever writes the row again. What `created_at` buys is
 * `topup_intent_open_idx`, the partial index db/schema/topup.ts already declares
 * for this exact query ("The reconciliation job's query: anything not terminal,
 * oldest first"). A scan on `updated_at` would need a second index to say the
 * same thing a week later.
 */

import { and, asc, eq, inArray, lt } from 'drizzle-orm';
import type { Db } from '../db/client';
import { topUpIntent } from '../db/schema/topup';
import { gateway, withGatewayTimeout } from '../gateway';
import {
  OPEN_STATUSES,
  settleFromGatewayRead,
  type TopUpIntentRow,
} from './topup';

/**
 * How long an unsettled intent is left alone. A CONSTANT AND NOT AN ENV VAR —
 * see the header. 168 hours = 7 days.
 */
export const TOPUP_REAP_AFTER_HOURS = 168;

/**
 * Intents examined per pass. Each one may cost a gateway round trip, so this is
 * the throughput control rather than a lock-contention one. Deliberately small:
 * a backlog drains over several passes rather than holding a processor's rate
 * limit open for a minute.
 */
export const TOPUP_REAP_BATCH_SIZE = 25;

export interface TopUpReapResult {
  /** Rows that looked stale and open when the pass started. */
  candidates: number;
  /** `failed` + `expired` written by THIS pass. The sum of the two below. */
  expired: number;
  /**
   * Of those: intents that never got a `psp_reference`. Provably unresolvable
   * from our own row, so the window barely matters for these.
   */
  expiredNeverReachedGateway: number;
  /**
   * Of those: intents the processor STILL called open after the whole window.
   * The only reap the gateway did not endorse, and therefore the number to watch
   * when the window is revised — if this is large, the window is too short or a
   * processor keeps invoices alive longer than 168 hours assumes.
   */
  expiredStillOpenAtGateway: number;
  /** Resolved to the processor's own terminal answer. No money moved. */
  settledFromGateway: number;
  /**
   * THE ALARM. The processor says she paid and this system has not credited her.
   * Never reaped, never credited here — reported. A number that does not fall to
   * zero across passes is a customer owed money.
   */
  awaitingCredit: number;
  /** Ids behind `awaitingCredit`, so the count is actionable and not just alarming. */
  awaitingCreditIds: string[];
  /** Could not ask. Left alone; the next pass asks again. */
  gatewayUnreachable: number;
  /** Resolved between the scan and the re-read. The proof a re-run is a no-op. */
  alreadyResolved: number;
  /** Blew up on one row. It stays open and the next pass retries. */
  failed: number;
}

export interface ReapOptions {
  limit?: number;
  /**
   * Clock override, the same seam `runNoShowReturnsOnce` carries. Never set in
   * production — the window is a constant on purpose.
   *
   * `topupReaper.int.test.ts` deliberately does NOT use it and says why: moving
   * the clock a week forward makes every open intent in the database a
   * candidate, which is a spec about the whole table rather than about its own
   * effect on it. It backdates the one row it created instead. Kept for a
   * one-off operator run that needs to reason about a different instant.
   */
  nowOverride?: Date;
}

/**
 * One pass. Exported so a test — or a proof run — can drive the reaper without a
 * timer, and so that running it twice is a thing anyone can do and check.
 *
 * IDEMPOTENCE is the STATUS TRANSITION, not a claim column and not a lease, for
 * the reason `services/noShowWorker.ts` gives at length: this is a local
 * transaction that either commits or does not, so a claim state could only add a
 * way to strand a row in "being reaped" when a worker dies. Every write below is
 * a conditional UPDATE whose `WHERE` re-states the precondition, so a second
 * pass, a second instance, or a webhook landing mid-pass takes the row instead
 * and this one reports `alreadyResolved`.
 *
 * NO ROW LOCK IS HELD ACROSS THE GATEWAY CALL. `readTopUp` reads the processor
 * outside any transaction and then applies the answer through
 * `settleFromGatewayRead`, which opens its own and takes `FOR UPDATE` there;
 * this does the same. Holding an intent lock for the length of a third party's
 * timeout is what `services/charge.ts` defers the receipt to avoid, and a batch
 * of twenty-five would hold twenty-five of them.
 */
export async function runTopUpReapOnce(
  db: Db,
  options: ReapOptions = {},
): Promise<TopUpReapResult> {
  const now = options.nowOverride ?? new Date();
  const limit = options.limit ?? TOPUP_REAP_BATCH_SIZE;
  const cutoff = new Date(now.getTime() - TOPUP_REAP_AFTER_HOURS * 60 * 60_000);

  const result: TopUpReapResult = {
    candidates: 0,
    expired: 0,
    expiredNeverReachedGateway: 0,
    expiredStillOpenAtGateway: 0,
    settledFromGateway: 0,
    awaitingCredit: 0,
    awaitingCreditIds: [],
    gatewayUnreachable: 0,
    alreadyResolved: 0,
    failed: 0,
  };

  /**
   * Candidates, UNLOCKED. A hint, not a decision — every row is re-read and
   * re-checked before anything is written, which is what lets this be a cheap
   * scan of `topup_intent_open_idx` rather than a lock held across the batch.
   */
  const candidates = await db
    .select({ id: topUpIntent.id })
    .from(topUpIntent)
    .where(and(inArray(topUpIntent.status, OPEN_STATUSES), lt(topUpIntent.createdAt, cutoff)))
    .orderBy(asc(topUpIntent.createdAt))
    .limit(limit);

  result.candidates = candidates.length;

  for (const candidate of candidates) {
    try {
      const [fresh] = await db
        .select()
        .from(topUpIntent)
        .where(eq(topUpIntent.id, candidate.id))
        .limit(1);
      /**
       * `TopUpIntentRow` deliberately does not carry `created_at` — it is the
       * shape the serialisers project from, and the customer's view has no use
       * for it. The column exists; this is the one caller that reads it, so the
       * timestamp is intersected in here rather than widening a shape four other
       * files build responses from.
       */
      const intent = fresh as (TopUpIntentRow & { createdAt: Date }) | undefined;

      /**
       * THE RE-CHECK. Between the scan and here a webhook may have settled this
       * intent, the customer may have returned to her wallet and settled it
       * herself, or another pass may have reaped it. All of them leave a status
       * that is no longer open, and all of them mean the same thing: somebody
       * else resolved this row, do not resolve it again.
       */
      if (!intent || !OPEN_STATUSES.includes(intent.status)) {
        result.alreadyResolved += 1;
        continue;
      }
      if (intent.createdAt >= cutoff) {
        result.alreadyResolved += 1;
        continue;
      }

      // ---- 1. never reached a processor. Nothing can ever settle it. --------
      if (!intent.pspReference) {
        if (await expireIntent(db, intent.id)) {
          result.expired += 1;
          result.expiredNeverReachedGateway += 1;
        } else {
          result.alreadyResolved += 1;
        }
        continue;
      }

      // ---- 2. ask the processor. Its answer decides, and it can veto. -------
      let state;
      try {
        state = await withGatewayTimeout(`${gateway.provider}.fetchPayment`, () =>
          gateway.fetchPayment(intent.pspReference as string),
        );
      } catch {
        // Unreachable, or a reference it does not recognise — the seam cannot
        // tell those apart (see the header) so both are the conservative answer.
        result.gatewayUnreachable += 1;
        continue;
      }

      if (state.outcome === 'succeeded') {
        // Money owed to a customer. Reported, never reaped, never credited here.
        result.awaitingCredit += 1;
        result.awaitingCreditIds.push(intent.id);
        continue;
      }

      if (state.outcome === 'pending') {
        /**
         * The processor still calls this payable, and the window has passed. This
         * is the ONE case where the number rather than the gateway carries the
         * safety, and the number is set to clear any hosted invoice's life by a
         * wide margin. See the header.
         */
        if (await expireIntent(db, intent.id)) {
          result.expired += 1;
          result.expiredStillOpenAtGateway += 1;
        } else {
          result.alreadyResolved += 1;
        }
        continue;
      }

      /**
       * `declined`, `cancelled`, `gateway_error` — a terminal answer with a truer
       * reason than `expired`. Applied through the ordinary settle path, which
       * moves no money for any of these three.
       */
      const applied = await settleFromGatewayRead(db, intent, state.outcome, state.amountFils);
      if (applied.kind === 'applied') result.settledFromGateway += 1;
      else result.alreadyResolved += 1;
    } catch {
      /**
       * One bad row must not stop the batch — `processJob` in the receipt worker
       * and `runNoShowReturnsOnce` both reason this way. It stays open and the
       * next pass tries again, which is safe precisely because every write is
       * conditional on the state it read.
       */
      result.failed += 1;
    }
  }

  return result;
}

/**
 * `open → failed / expired`, as a conditional UPDATE whose row count is the
 * answer. Returns false when somebody else moved the row first.
 *
 * The `WHERE` re-states both preconditions rather than trusting the read above
 * it: `status IN (open)` is what makes a concurrent webhook win the race cleanly
 * instead of both writers believing they reaped it. Migration 0004's trigger is
 * the backstop — a terminal row raises rather than being walked backwards — and
 * `topup_intent_failure_reason_matches_status` is why the reason is written in
 * the same statement as the status.
 */
async function expireIntent(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .update(topUpIntent)
    .set({ status: 'failed', failureReason: 'expired', updatedAt: new Date() })
    .where(and(eq(topUpIntent.id, id), inArray(topUpIntent.status, OPEN_STATUSES)))
    .returning({ id: topUpIntent.id });
  return rows.length === 1;
}

export interface TopUpReaper {
  stop(): Promise<void>;
}

/**
 * Start the loop. Returns a handle so `server.ts` can stop it on shutdown.
 *
 * ======================================================================
 * OFF BY DEFAULT, AND THIS IS THE ONE THING NOT TO COPY FROM THE SIBLINGS
 * ======================================================================
 * `NO_SHOW_WORKER_ENABLED` and `RECEIPT_WORKER_ENABLED` both default to `'1'`.
 * That default is the direct cause of `deposit.test.ts` being flaky for weeks:
 * `env.ts:209` defaults the flag on, the e2e harness boots `src/server.ts`, and
 * so a production loop ran inside every test run settling deposits at a moment
 * no spec chose. Lane D had to pin it off in the harness — in Lane D's column,
 * which Lane A cannot write to. **`TOPUP_REAPER_ENABLED` therefore defaults to
 * `'0'`, because default-off is the only guarantee this lane is able to make on
 * its own.** A default-on loop would be asking another lane to remember.
 *
 * It is not only a test argument, and the other two reasons are why this is not
 * a temporary compromise:
 *
 *   - Leaving the siblings off is a PRODUCT failure: receipts nobody sends,
 *     deposits never returned to a customer who is owed them. Leaving this off
 *     costs nobody anything. The table grows, which is exactly where this
 *     project already is, and `pnpm --dir=… run job:topup-reap` drains it
 *     deliberately with the numbers printed.
 *   - `TOPUP_REAP_AFTER_HOURS` is not approved yet. A loop enforcing an
 *     unapproved product number every fifteen minutes is the loop answering the
 *     question by running. Once Aftab picks the window, flip this default to
 *     `'1'` and delete this paragraph.
 *
 * HOW A TEST PINS IT — the explicit answer, because "off by default" is only
 * half of it:
 *
 *   - A test that constructs handlers gets nothing. `buildApp()` does not start
 *     this loop and must not; only `server.ts` does, which is the same split the
 *     two siblings use.
 *   - A test that BOOTS `src/server.ts` — which is what the e2e harness does —
 *     also gets nothing, because the flag is off unless someone sets
 *     `TOPUP_REAPER_ENABLED=1`. No harness change is required to be safe, and no
 *     harness change should be made to keep it safe.
 *   - A test that wants the behaviour calls `runTopUpReapOnce(db, …)` directly
 *     with a `nowOverride`. That is the only supported way to exercise it, and
 *     `services/topupReaper.int.test.ts` does exactly that.
 *   - If this default is ever flipped to `'1'`, the e2e harness must pin
 *     `TOPUP_REAPER_ENABLED=0` in the same commit, or a background job starts
 *     writing terminal states on other lanes' fixtures. That is the whole
 *     `deposit.test.ts` story, and it is written down here so the next person
 *     flipping the flag reads it first.
 *
 * A self-rescheduling timeout rather than `setInterval`, for the reason both
 * siblings give: an interval fires regardless of how long the previous pass
 * took, so a slow pass — and every pass here makes gateway round trips —
 * stacks overlapping passes that then contend for the same rows.
 */
export function startTopUpReaper(
  db: Db,
  pollMs: number,
  log: (o: Record<string, unknown>) => void = () => {},
): TopUpReaper {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<unknown> = Promise.resolve();

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const result = await runTopUpReapOnce(db);
      if (result.candidates > 0) log({ event: 'topup.reap.tick', ...result });
    } catch (err) {
      // A failure to SCAN — the database, not one intent. Nothing was written,
      // so there is nothing to unwind; the next tick retries.
      log({
        event: 'topup.reap.tick.error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (!stopped) timer = setTimeout(() => void (inFlight = tick()), pollMs);
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
