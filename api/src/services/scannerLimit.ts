/**
 * Per-till budget for `POST /scans`, `POST /charges` and `POST /voids`.
 *
 * These three had no rate limit and there was no global one to fall back on:
 * `app.ts` registers no rate-limit plugin and `api/package.json` carries no such
 * package. Auth is limited (`signupLimit.ts`, `passwordResetLimit.ts`), the
 * support queue is limited (`supportLimit.ts`), the customer directory is limited
 * (`memberSearch.ts`). The money was not. Authorised by Aftab as DECISIONS.md #16.
 *
 * =========================================================================
 * THE NUMBERS BELOW ARE UN-MEASURED STARTING VALUES. READ § THRESHOLDS.
 * =========================================================================
 * NO SALON HAS BEEN MEASURED. Nobody has watched a real counter for an hour and
 * counted requests, so both tiers are reasoned from what one till can physically
 * do, deliberately generous, and meant to be revised against pilot data. The
 * revision procedure is at the bottom of this file so that it is a task and not an
 * intention.
 *
 * ONE THING HAS BEEN MEASURED, and it is not a salon: a real automated client
 * holding a real credential, whose peak the first draft of the burst tier refused
 * outright. That correction is recorded in § THRESHOLDS rather than folded away,
 * because it is the only volume data that exists and because the file had already
 * written down the rule it then got to apply — a refusal is a bug report about the
 * constant until proven otherwise.
 *
 * FOUR SHAPE DECISIONS, EACH ONE COPIED FROM A SIBLING THAT ARGUED IT FIRST
 * ------------------------------------------------------------------------
 *
 * ONE QUERY, TWO COUNTS. The hourly window contains the five-minute one, so a
 * single scan bounded by the wider window answers both with FILTER. Two round
 * trips counting rows in the same table for the same till would be a second
 * chance for the two numbers to disagree about `now`. (`signupLimit.ts`.)
 *
 * THE CEILING IS CHECKED FIRST. When both are exceeded, the honest refusal is the
 * one the caller cannot wait out in a moment — telling somebody to "wait a moment"
 * when they have an hour to wait sends them back every minute. (`memberSearch.ts`.)
 *
 * `toISOString()` AND AN EXPLICIT `::timestamptz` CAST, not a bare `Date`. A Date
 * interpolated into a SELECT expression never meets the column's type mapper the
 * way it does inside `where`, and postgres-js is handed an object where it expects
 * a string. Found by the 500 it caused in `memberSearch.ts`.
 *
 * CONSTANTS, NOT ENV, which is the argument `passwordResetLimit.ts` and
 * `supportLimit.ts` both make in their headers: the signup limiter is env-tuned
 * because launch traffic is a genuine unknown for an unauthenticated endpoint
 * facing the open internet, and a salon counter's rate is not that kind of
 * unknown — it is bounded by how fast a human can serve a queue. Being un-measured
 * is a reason to revise a constant in a diff that says why, with the pilot data
 * attached; it is not a reason to make the ceiling a per-deployment string that
 * nobody can find later.
 *
 * =========================================================================
 * ONE BUDGET FOR ALL THREE ENDPOINTS, AND THAT IS THE POINT
 * =========================================================================
 * `memberSearch.ts` § DIRECTORY_READ_ACTIONS makes this argument for the search
 * and the resolve, and it transfers exactly: "the thing being protected is the
 * customer DIRECTORY, not one endpoint". The thing being protected here is the
 * TILL — the position that can read a customer's card and move her money — so
 * three separate budgets would just be three doors into it. Exhaust the scan
 * budget and keep charging; exhaust the charge budget and keep voiding.
 *
 * A void being drawn from the same budget as a scan is the one part of this worth
 * a second look, because a void is the undo of something that just happened in
 * front of a customer and refusing one is embarrassing. It is included anyway: a
 * void moves money back into a wallet, so leaving it unmetered would be exactly
 * the different-door defect above, and at these thresholds the volume of voids
 * (a fraction of a percent of charges) cannot be what exhausts a budget sized for
 * scans. If a void is ever refused, the till was already refusing charges.
 *
 * =========================================================================
 * WHAT IS RATIONED IS ATTEMPTS, INCLUDING REFUSED ONES
 * =========================================================================
 * `supportLimit.ts` counts only rows that were actually created, because "what
 * rule 5 protects is a STAFFED QUEUE from being filled by one member, and a
 * request that creates no ticket does not fill it". That reasoning does NOT
 * transfer here, and the difference is worth stating because the two files
 * otherwise look alike.
 *
 * A refused request on this surface has learned something. A 410 on `POST /scans`
 * says whether that QR resolves in this salon; a 402 on `POST /charges` says
 * whether a balance covers a basket. `signupLimit.ts` had to be REORDERED to make
 * the same sentence true of itself — Lane D measured forty consecutive probes
 * that all answered `409 already_registered` and left `signup_attempt` empty, so
 * the oracle "was not bounded at 100 an hour, it was not bounded at all". This
 * file starts on the correct side of that: the attempt is recorded before the
 * work, so a refusal costs budget.
 *
 * =========================================================================
 * WHERE THE CHECK SITS: BEFORE THE TRANSACTION, NOT INSIDE IT
 * =========================================================================
 * All three endpoints call `chargeScannerBudget` in the ROUTE HANDLER, before any
 * transaction is opened. That is the second answer to this question, and the first
 * one is worth keeping because it was well argued and it would have taken the
 * product down.
 *
 * THE ARGUMENT FOR PUTTING IT INSIDE, which is still true as far as it goes. A
 * retry under the same Idempotency-Key is not a second attempt — it is a client
 * that lost the response to an attempt that already happened, and on `POST /charges`
 * that means the money has already moved. `claimKey` raises a unique violation for
 * that case and `withIdempotency` replays the winner's stored response. Put the
 * limiter after the claim and a replay never reaches it; put it in front and an
 * exhausted till can be answered 429 when it asks "did my charge go through?".
 * `supportLimit.ts` § 3 makes the same shape of argument for sitting after the
 * dedupe.
 *
 * WHY IT IS WRONG ANYWAY. `db/client.ts` opens `postgres(url, { max: 10 })`. A
 * `db.transaction()` RESERVES one of those ten for its whole life. The limiter's
 * counter row must be written on `db` and not on `tx` — see `recordScannerAttempt`,
 * it is the whole point of the table — so a limiter inside the transaction asks the
 * pool for a SECOND connection while holding one. Ten concurrent charges hold all
 * ten and each wait for an eleventh that cannot exist.
 *
 * That is not a slowdown. It is a permanent hang on `POST /charges`, at every till
 * in the salon at once, on the busiest day. MEASURED, not reasoned: twelve
 * concurrent charges against the real API did not return in 25 seconds with the
 * limiter inside the transaction, and answered in 571ms with it moved out.
 * `scannerLimit.int.test.ts` § "where the limiter sits" keeps that probe, because
 * every other spec in this repository drives charges one at a time and so none of
 * them can see it.
 *
 * WHAT MOVING IT COSTS, stated rather than discovered later. A replay under an
 * already-exhausted budget is refused with 429 instead of being answered with the
 * stored response, and it spends a counter row of its own. Accepted, for three
 * reasons:
 *
 *   THE MONEY IS STILL SAFE. The idempotency key is untouched by this ordering; a
 *   refused replay is a message problem, not a double charge. The scanner shows
 *   "too many attempts, wait a moment", and the retry after the window rolls
 *   forward gets the replayed success.
 *
 *   IT REQUIRES THE TILL TO BE OVER BUDGET ALREADY, which at 300 requests in five
 *   minutes means a client in a loop rather than a receptionist.
 *
 *   AND A HANGING ENDPOINT IS WORSE THAN A WRONG SENTENCE. The first ordering
 *   optimised the message shown in a rare state and broke the endpoint in a common
 *   one.
 *
 * SO THE ORDER IS: authority, budget, then the work. `POST /scans` has no key and
 * no transaction, so it was always simply first.
 *
 * THE TOP-UP LIMITER IS THE EXCEPTION AND IT IS NOT AN INCONSISTENCY.
 * `services/topupLimit.ts` runs INSIDE `createTopUp`'s transaction, on `tx`, and is
 * safe there for the reason this one is not: it only READS, and it reads on the
 * transaction's own connection. It asks the pool for nothing. That difference is
 * forced by the counters — this one owns a table it must write outside the
 * transaction, and that one counts `topup_intent` rows the transaction is about to
 * add.
 */

import { and, eq, gte, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { scannerAttempt } from '../db/schema/session';
import { isFabricatedPrincipal, type StaffPrincipal } from '../auth/principal';
import { tooManyRequests } from '../http/errors';

/**
 * =========================================================================
 * THE ONE EXEMPTION, AND WHY IT IS NOT A HOLE
 * =========================================================================
 * `isFabricatedPrincipal` — auth/principal.ts, which carries the full argument —
 * is true only for the `AVO_TEST_PRINCIPALS` shim's invented principal: a build
 * `env.ts` refuses in production, resolving an ANONYMOUS request to a seeded staff
 * member. There is no credential behind it, so there is no till to key a budget
 * on; every request under the shim would land in one bucket and a suite driving a
 * thousand specs in nine minutes would exhaust a budget sized for a salon counter.
 * Measured: enforcing this under the shim turned `pnpm check` green-to-79-failures
 * across five e2e files, every one a 429 where a 200 was expected.
 *
 * The fix is NOT to raise the numbers. Tuning a production control until a test
 * suite fits under it is how a limiter ends up at a value nobody can justify, and
 * § THRESHOLDS would then be arguing for a number chosen by CI.
 *
 * WHAT IS NOT EXEMPTED: a REAL bearer token in a test build. It carries a uuid
 * session id, so it is limited normally — which matters, because
 * `e2e/support/tenancy-harness.ts` mints real device-bound PIN sessions and drives
 * money through them, and `scannerLimit.int.test.ts` mints its own with
 * `AVO_TEST_PRINCIPALS` off. Both are real coverage of this file.
 */

/** The three endpoints that draw on the till's budget. */
export type ScannerAction = 'scan' | 'charge' | 'void';

/**
 * =========================================================================
 * THRESHOLDS — UN-MEASURED STARTING VALUES, AND WHAT THEY ASSUME
 * =========================================================================
 * This was queued as a decision rather than built because nobody has measured a
 * real salon's charge rate, and the false-positive cost is the worst one this API
 * has: a refused sale with a paying customer standing at the counter, discovered
 * by AVO when the salon phones in. So the numbers below err GENEROUS on purpose.
 * A limiter that never fires in year one is a bug you tighten from data; one that
 * refuses a real customer is a bug the merchant finds first.
 *
 * WHAT ONE CUSTOMER COSTS
 * -----------------------
 * Reasoned, not measured. A customer at the counter is:
 *
 *     1 scan  + 1 charge                                        = 2   typical
 *     2 scans + 1 charge   (QR re-read before the artist confirms) = 3
 *     2 scans + 2 charges  (402, she tops up, the artist rescans)   = 4
 *     3 scans + 2 charges + 1 void  (the difficult one)             = 6
 *
 * `POST /scans` deliberately does NOT consume the token (services/charge.ts
 * § TWO ORDERING DECISIONS), which is what makes re-reading cheap and common, so
 * the scan count per customer is the number that moves.
 *
 * WHAT ONE TILL CAN PHYSICALLY SERVE
 * ----------------------------------
 * `memberSearch.ts` already took a position on this for the same building, and it
 * is reused here rather than re-invented: "one front desk can process perhaps 20
 * customers an hour, three minutes each including the charge." At the worst
 * profile above that is 20 x 6 = 120 requests an hour, call it 160 with a bad
 * share of difficult customers.
 *
 * THE ARITHMETIC
 * --------------
 *   400 AN HOUR is 2.5x that worst realistic hour, and 66 customers an hour at the
 *   worst profile — three times what one counter can physically serve, and about
 *   one request every nine seconds sustained for a full hour from a single tablet.
 *
 *   300 PER 5 MINUTES is 50 customers in five minutes at the worst profile: six
 *   seconds a customer, including the greeting, the service selection and the card.
 *   Impossible with real people, and far above any rush.
 *
 * The burst tier would be 3,600 an hour if sustained, so the hourly tier is the real
 * constraint underneath it and the burst tier only shapes a frantic minute. Both
 * windows ROLL, so a bad twenty minutes refills continuously rather than at the top
 * of the hour. That structure — burst shapes, ceiling binds — is `memberSearch.ts`'s.
 *
 * =========================================================================
 * THE BURST TIER WAS 60 AND IT REFUSED A LEGITIMATE CLIENT ON THE FIRST RUN
 * =========================================================================
 * This paragraph is the correction, kept rather than folded away, because the file
 * gave itself the rule and then immediately got to apply it: "treat a single
 * production `scanner_rate_limited` as a bug report about the constant rather than
 * as the limiter working."
 *
 * 60 was borrowed from `memberSearch.ts` on the argument that it is the same
 * physical counter. Enforced for the first time against `e2e/`, it turned
 * `pnpm check` red in three files — `scanner`, `promotions`, `integration` — none of
 * them about rate limiting, all of them driving REAL device-bound PIN sessions
 * through real charges. Not the `AVO_TEST_PRINCIPALS` shim, which is exempt and
 * separately argued: a real credential, refused.
 *
 * MEASURED, by lifting both ceilings to a million, running the whole suite, and
 * polling the run's own `scanner_attempt` rows every six seconds:
 *
 *     busiest 5 minutes on one (salon, device)     105
 *     busiest 60 minutes on one (salon, device)    105
 *
 * So the burst tier was set at 57% of what one legitimate client already needed,
 * while the hourly ceiling had 3.8x headroom over the same client. The tiers were
 * not wrong by the same amount; the BURST one was wrong.
 *
 * WHAT THAT MEASUREMENT IS AND IS NOT. It is not evidence about a salon — a suite
 * running a thousand specs in nine minutes is not a receptionist. It is the only
 * volume data that exists, it is a real automated consumer holding a real
 * credential, and it is worth exactly one thing: a floor. Any burst tier below
 * ~105 demonstrably refuses somebody who was doing nothing wrong.
 *
 * 300 is 2.9x that floor and still cannot be reached by human hands. The cost of
 * loosening it is close to zero, because the burst tier never was the binding
 * constraint: a runaway client doing hundreds of requests a second trips 300 in
 * under two seconds, exactly as it trips 60, and the hourly ceiling of 400 is what
 * actually holds the line after that.
 *
 * THE HOURLY CEILING IS UNCHANGED AT 400, deliberately. It had 2.5x headroom over
 * the reasoned salon worst case and 3.8x over the measured client, so nothing about
 * this correction touches it. Moving both numbers because one of them was wrong is
 * how a limiter drifts to a value nobody can justify.
 *
 * WHAT THIS REFUSES, AND WHAT IT HONESTLY DOES NOT
 * -----------------------------------------------
 * It refuses a client stuck in a loop, a tablet left face-down replaying a request,
 * and machine-speed enumeration of wallet tokens through `POST /scans` — 400 an
 * hour against a token space this size is not a search. It does NOT stop a
 * dishonest staff member charging customers slowly all day; nothing keyed on rate
 * ever could, and `perms.charges` plus the audit row are the controls for that.
 *
 * HOW TO REVISE THESE, AND WITH WHAT
 * ----------------------------------
 * The evidence exists by construction, because every attempt leaves a row:
 *
 *     SELECT salon_id, device_id, date_trunc('hour', created_at) AS hour,
 *            count(*) AS n
 *       FROM scanner_attempt
 *      GROUP BY 1, 2, 3
 *      ORDER BY n DESC
 *      LIMIT 50;
 *
 * After a pilot with real salons: set the hourly ceiling at roughly twice the
 * busiest observed till-hour, and the burst at twice the busiest observed
 * five-minute window, and record the observed numbers in the diff that changes
 * these constants — as the correction above does. Until then, treat a single
 * production `scanner_rate_limited` as a bug report about the constant rather than
 * as the limiter working. That has already been true once.
 */
export const SCANNER_WINDOW_MINUTES = 5;
export const SCANNER_MAX_PER_WINDOW = 300;
export const SCANNER_HOUR_WINDOW_MINUTES = 60;
export const SCANNER_MAX_PER_HOUR = 400;

/**
 * The refusal codes, exported so nothing has to re-spell them.
 *
 * DISTINCT CODES, AND NOT A 403, which is the whole reason this was specified
 * rather than left to a generic guard. A staff member standing in front of a
 * customer must not be shown an authority error for a condition that has nothing
 * to do with her authority — "you do not have permission" sends her to a manager
 * to fix something that will fix itself in ninety seconds. The scanner switches on
 * `error`, so these two names are the contract; the `message` is display copy.
 *
 * Named after the SURFACE and not after the endpoint, because one budget covers
 * all three: a code called `charge_rate_limited` arriving from `POST /scans` would
 * be the kind of small lie that costs somebody an afternoon.
 */
export const SCANNER_RATE_LIMITED = 'scanner_rate_limited';
export const SCANNER_HOURLY_LIMIT = 'scanner_hourly_limit';

/**
 * Refuse if this till has already spent its budget.
 *
 * Counted BEFORE anything is read and before any row is written, so a throttled
 * caller neither resolves a token, nor reads a member, nor moves money.
 *
 * KEYED ON `(salonId, deviceId)`. Not on the staff member — three people share one
 * tablet across a shift and any of them may legitimately be holding it — and never
 * on `req.ip`, which is one address for the whole salon and, with `trustProxy` off
 * by default, may not even be the caller. Migration 0038 carries the full argument.
 */
export async function enforceScannerLimits(db: Db, principal: StaffPrincipal): Promise<void> {
  if (isFabricatedPrincipal(principal)) return;

  const hourSince = new Date(Date.now() - SCANNER_HOUR_WINDOW_MINUTES * 60_000);
  const burstSince = new Date(Date.now() - SCANNER_WINDOW_MINUTES * 60_000);

  const [recent] = await db
    .select({
      burst: sql<number>`count(*) filter (
        where ${scannerAttempt.createdAt} >= ${burstSince.toISOString()}::timestamptz
      )::int`,
      hour: sql<number>`count(*)::int`,
    })
    .from(scannerAttempt)
    .where(
      and(
        eq(scannerAttempt.salonId, principal.salonId),
        /**
         * A principal the server cannot attribute to a device is COUNTED, in the
         * `device_id IS NULL` bucket, alongside every other such principal.
         * Exempting it would make "arrive without a device" the way past the
         * limiter — `signupLimit.ts` takes the same position on an unattributable
         * address.
         *
         * REACHING THIS LINE WITH A NULL DEVICE SHOULD BE IMPOSSIBLE, and the
         * branch is kept anyway. These three endpoints are all `requireScannerPerm`,
         * so the scope is `scanner`, and `session_scanner_is_device_scoped` refuses
         * a scanner session without a device; the one producer of a device-less
         * staff principal is the `AVO_TEST_PRINCIPALS` shim, which returned above.
         * So this is the belt to that database constraint's braces: if the CHECK is
         * ever relaxed, an unattributable caller gets the shared bucket rather than
         * a free pass.
         */
        principal.deviceId === null
          ? sql`${scannerAttempt.deviceId} is null`
          : eq(scannerAttempt.deviceId, principal.deviceId),
        gte(scannerAttempt.createdAt, hourSince),
      ),
    );

  if ((recent?.hour ?? 0) >= SCANNER_MAX_PER_HOUR) {
    throw tooManyRequests(
      SCANNER_HOURLY_LIMIT,
      'This device has been very busy. It will free up shortly — or use another till.',
    );
  }
  if ((recent?.burst ?? 0) >= SCANNER_MAX_PER_WINDOW) {
    throw tooManyRequests(
      SCANNER_RATE_LIMITED,
      'Too many attempts. Wait a moment and try again.',
    );
  }
}

/**
 * Record the attempt, on `db` and NEVER on a caller's transaction.
 *
 * OUTSIDE THE CHARGE TRANSACTION, DELIBERATELY, and this is the line most likely
 * to be "tidied" into `tx` by somebody who has not read this paragraph. A row
 * written inside that transaction is rolled back by every REFUSED charge — the 402,
 * the dead token, the near-duplicate — and a flood of refusals is precisely the
 * traffic this exists to bound. The counter would empty exactly when it is needed.
 * `signupLimit.ts § recordSignupAttempt` and `pin_attempt` are both written this
 * way for this reason.
 *
 * AND THAT REQUIREMENT IS WHY THE WHOLE LIMITER RUNS BEFORE THE TRANSACTION rather
 * than inside it. A write on `db` while a `db.transaction()` is open asks the
 * ten-connection pool for a second connection from a caller already holding one,
 * which deadlocks under concurrency — measured, and recorded in § WHERE THE CHECK
 * SITS. So "the counter must survive a rollback" and "the check must sit after
 * `claimKey`" turned out to be incompatible, and the counter won.
 *
 * BEFORE THE WORK, NOT AFTER. Recording afterwards would let a burst of
 * simultaneous requests all pass the count and all do the work before any of them
 * was visible to the next — a thundering herd straight through the limiter. Writing
 * first closes that, and costs the honesty of an outcome column: the row cannot know
 * yet whether the charge succeeded, and migration 0038 revokes the UPDATE that would
 * let it be corrected later. So this is a COUNTER, not a record; `audit_log` and
 * `transaction` are where the outcomes live.
 *
 * The imprecision that leaves is accepted rather than unnoticed: a request refused
 * after this line has still spent budget. Over-counting in that direction is
 * correct — see the header on what a refusal learns.
 */
export async function recordScannerAttempt(
  db: Db,
  principal: StaffPrincipal,
  action: ScannerAction,
): Promise<void> {
  /**
   * Not recorded either, and that is deliberate rather than symmetry for its own
   * sake: a row written under the shim is a row in a real table naming a till that
   * does not exist, and `avo_app` cannot DELETE it (migration 0038). A test build
   * would slowly fill the counter with fiction that the operator's retention job is
   * the only thing able to remove.
   */
  if (isFabricatedPrincipal(principal)) return;

  await db.insert(scannerAttempt).values({
    salonId: principal.salonId,
    deviceId: principal.deviceId,
    action,
  });
}

/**
 * Check, then record. The pair, in the only order that is safe, so no caller has
 * to remember it.
 *
 * Every one of the three endpoints calls exactly this. The two halves are exported
 * separately as well because a future caller may need them apart, but nothing today
 * does, and a call site that checked without recording would be a budget that never
 * fills.
 */
export async function chargeScannerBudget(
  db: Db,
  principal: StaffPrincipal,
  action: ScannerAction,
): Promise<void> {
  await enforceScannerLimits(db, principal);
  await recordScannerAttempt(db, principal, action);
}
