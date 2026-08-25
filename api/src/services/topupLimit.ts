/**
 * Per-member budget for `POST /topups`.
 *
 * `POST /topups` had no rate limit and there is no global one — `app.ts` registers
 * no rate-limit plugin. Authorised by Aftab as DECISIONS.md #16, together with the
 * scanner budget in `scannerLimit.ts`; the two are separate files because they
 * ration different things for different reasons and the shapes genuinely differ.
 *
 * KEYED ON `memberId`, not on the connection. The caller is an authenticated
 * member (`requireMember`) and she cannot forge her identity, so there is nothing
 * an address adds — and `req.ip` would be actively wrong here: a customer on
 * Zain's carrier NAT shares an address with a city, so an IP-keyed budget on a
 * customer-facing endpoint refuses strangers for each other's behaviour. That is
 * before `app.ts § trustProxy` being off by default, which makes `req.ip` behind a
 * load balancer the balancer.
 *
 * NOT SCOPED TO THE SALON. `member.id` is unique across the product and one member
 * row belongs to exactly one salon, so a salon predicate would restate a fact the
 * id already carries — and a customer who holds wallets at two salons holds two
 * DIFFERENT member rows (`member_salon_phone_uq` is on `(salon_id, phone)`), so she
 * legitimately gets a budget at each. `supportLimit.ts` takes exactly this position
 * and for exactly this reason.
 *
 * =========================================================================
 * NO ATTEMPT TABLE. `topup_intent` IS ITS OWN COUNTER.
 * =========================================================================
 * `supportLimit.ts`'s argument, and it is the same argument: the thing being
 * rationed IS the row. A top-up creates a `topup_intent`, that intent is what
 * reaches the payment provider, and `topup_intent_member_created_idx` — on
 * `(member_id, created_at DESC)` — already exists for her own top-up history. So
 * the queue is its own counter, and a fourth attempt table would be a second place
 * the same fact is written.
 *
 * WHAT THAT MEANS FOR REFUSED REQUESTS, stated rather than left to be discovered.
 * `createTopUp` runs in one transaction, so a request refused anywhere inside it
 * rolls the intent back and spends no budget. That is the RIGHT reading here, and
 * it is the opposite of the call `scannerLimit.ts` makes for the till — the two
 * files disagree on purpose:
 *
 *   - What a scanner refusal leaks is a fact about a customer (does this QR
 *     resolve, does this balance cover this basket), so refusals must cost.
 *   - What this endpoint rations is INTENTS REACHING A PAYMENT PROVIDER. A request
 *     that rolled back sent nothing to MyFatoorah and told the caller nothing she
 *     did not already know — she is authenticated as herself and the amount is her
 *     own. There is no oracle to bound.
 *
 * A malformed body is therefore free, indefinitely, from an authenticated and
 * attributable caller. That is one parse and no writes, which is a much smaller
 * problem than the one this file addresses; if it ever needs bounding it needs an
 * attempt table, and then `signup_attempt`'s shape is the right one.
 *
 * =========================================================================
 * A REPLAY IS NOT AN ATTEMPT, AND THE ORDERING IS WHAT MAKES THAT TRUE
 * =========================================================================
 * This runs inside `createTopUp`'s transaction, immediately AFTER `claimKey`.
 *
 * AND IT IS SAFE THERE ONLY BECAUSE IT READS. `services/scannerLimit.ts` had the
 * same placement, for the same good reason, and had to be moved OUT: its counter is
 * a table it must WRITE outside the transaction, so inside one it asked
 * `postgres(url, { max: 10 })` for a second connection while holding one — ten
 * concurrent charges then hold all ten and wait forever for an eleventh. Measured:
 * twelve concurrent charges did not return in 25 seconds.
 *
 * This limiter asks the pool for nothing. The count runs on `tx`, on the
 * transaction's own connection, and there is no separate counter row to write —
 * `topup_intent` is the counter and the transaction is about to insert into it. The
 * two files land in different places because their counters differ, not because one
 * of them forgot.
 *
 * A retry under the same Idempotency-Key is a client that lost the response to a
 * top-up that already exists — possibly one the customer has already paid. `claimKey`
 * raises a unique violation for that case and `routes/topups.ts` replays the
 * winner's stored intent. Running this limiter in front of the claim would answer
 * 429 to a wallet asking "did my top-up start?", stranding a customer who is
 * mid-payment at the gateway. So: claim first, limiter second, and a replay never
 * reaches this code. `supportLimit.ts` sits after the dedupe for the same shape of
 * reason — an endpoint must not charge a caller for a gesture it was built to
 * absorb.
 *
 * The happy consequence is that the numbers below count DISTINCT top-ups. A wallet
 * on a bad connection retrying one intent ten times spends one.
 *
 * CONSTANTS, NOT ENV — `passwordResetLimit.ts`'s argument. A customer's legitimate
 * top-up rate is not the kind of unknown launch traffic is.
 */

import { and, eq, gte, sql } from 'drizzle-orm';
import { isFabricatedPrincipal, type MemberPrincipal } from '../auth/principal';
import { topUpIntent } from '../db/schema/topup';
import { tooManyRequests } from '../http/errors';
import type { Executor } from './audit';

/**
 * =========================================================================
 * THRESHOLDS — UN-MEASURED STARTING VALUES, AND WHAT THEY ASSUME
 * =========================================================================
 * Like the scanner's, these are reasoned rather than observed, and deliberately
 * generous. The false-positive cost is a customer who cannot put money in her
 * wallet — at a counter, with a service already done, which is the same bad
 * afternoon a refused charge causes one step earlier.
 *
 * WHAT A REAL CUSTOMER DOES. She tops up a few times a month. Inside one sitting
 * she may plausibly:
 *
 *     tap Top up, change her mind about the amount, tap again        2
 *     card declined, try the same card again                        +1
 *     try a different card                                          +1
 *     give up on cards and use KNET                                 +1
 *                                                                   = 5
 *
 * Five is a bad day that really happens. Ten in a quarter of an hour is somebody
 * whose bank is refusing her, and the right answer for her is a support ticket
 * rather than a sixth card.
 *
 * WHAT IS BEING BOUNDED. Two things, and neither is a customer:
 *
 *   CARD TESTING through a compromised wallet session — minting intents to probe
 *   stolen card numbers at the hosted page. 20 an hour makes this a poor tool;
 *   it does not make it impossible, and the real controls for it are the PSP's own
 *   velocity rules and the fact that a credit lands in a wallet that cannot pay
 *   out (non-negotiable #5: refunds are wallet credit, never cash).
 *
 *   INTENT CHURN against MyFatoorah. Every intent is a live payment object at the
 *   provider; an unbounded loop is our bill and their rate limit.
 *
 * =========================================================================
 * THE FIRST DRAFT WAS 10 / 20 AND IT REFUSED A LEGITIMATE CLIENT IMMEDIATELY
 * =========================================================================
 * Those numbers came from the sitting above — "10 per 15 minutes is twice the
 * bad-day sitting; 20 an hour is four of those sittings, which no customer has" —
 * and both sentences are still true about a PERSON. They were the wrong shape of
 * argument for this control, and the first thing that ran against it said so.
 *
 * Enforced for the first time, `e2e/gateway.test.ts` went red in 24 places: the
 * round trip, the duplicate callback, the state machine, the trigger backstop —
 * none of them about rate limiting, every one of them driving `POST /topups` on a
 * REAL member session. Not the `AVO_TEST_PRINCIPALS` shim, which is exempt and
 * separately argued below: a real credential, refused.
 *
 * MEASURED, by lifting both ceilings to a hundred thousand, running the whole e2e
 * suite, and polling the run's own `topup_intent` rows every six seconds:
 *
 *     busiest 15 minutes for one member    59
 *     busiest 60 minutes for one member    59
 *
 * WHAT THAT IS AND IS NOT. It is not evidence about a customer; a suite is not a
 * shopper. It is a real automated consumer holding a real credential, it is the
 * only volume data that exists, and it is worth exactly one thing: a floor. Any
 * ceiling below ~59 demonstrably refuses somebody doing nothing wrong.
 *
 * AND IT FORCED A BETTER QUESTION, which is why this correction is a rewrite rather
 * than a bigger number. "What would a customer plausibly do?" is the wrong question
 * for a control whose false positive is a customer who cannot pay at a counter. The
 * right one is: WHAT IS THE SMALLEST CEILING THAT STOPS THE ACTUAL HARM?
 *
 * The harm is a runaway loop and unbounded churn at the provider. A loop makes
 * hundreds of requests a second, so it trips 200 an hour in the same second it
 * trips 20 — the ceiling's value decides nothing about whether a loop is caught,
 * only about who else gets caught with it. And a ceiling tuned to out-guess a
 * determined human never worked anyway: § WHAT IS BEING BOUNDED already conceded
 * that 20 an hour "makes card testing a poor tool; it does not make it impossible,
 * and the real controls for it are the PSP's own velocity rules".
 *
 * So the tiers are set as a LOOP CATCHER rather than as a behaviour model.
 *
 * THE ARITHMETIC. 100 per 15 minutes is 1.7x the measured legitimate client and 20x
 * a human's worst sitting. 200 an hour is 3.4x that client. The burst tier would be
 * 400 an hour if sustained, so — as in every sibling — the hourly tier is the real
 * constraint and the burst tier shapes the frantic minute. Both windows roll.
 *
 * WHAT THIS GIVES UP, said plainly rather than left to be discovered: a compromised
 * wallet session can now probe 200 cards an hour at the hosted page instead of 20.
 * That is a real loss and it is accepted, because 20 was not a defence either — it
 * was a number that felt protective and whose only measurable effect was refusing a
 * legitimate client. The defences that do work here are the PSP's velocity rules and
 * non-negotiable #5: a credit lands in a wallet that cannot pay out, so a tested
 * card buys the attacker salon services under a named member, not cash.
 *
 * HOW TO REVISE THESE. The evidence exists by construction, because the intents
 * are the counter:
 *
 *     SELECT member_id, date_trunc('hour', created_at) AS hour, count(*) AS n
 *       FROM topup_intent
 *      GROUP BY 1, 2
 *      ORDER BY n DESC
 *      LIMIT 50;
 *
 * Set the hourly ceiling at roughly twice the busiest observed member-hour that is
 * NOT fraud, and record the observed numbers in the diff that changes these — as the
 * correction above does. A `topup_rate_limited` in production is a bug report about
 * the constant until proven otherwise; that has already been true once.
 */
export const TOPUP_WINDOW_MINUTES = 15;
export const TOPUP_MAX_PER_WINDOW = 100;
export const TOPUP_MAX_PER_HOUR = 200;

/**
 * The refusal codes. Distinct, and deliberately not a 403 or a generic 400: the
 * wallet renders a sentence about waiting, and a customer who is told she lacks
 * permission to top up her own wallet will phone the salon.
 */
export const TOPUP_RATE_LIMITED = 'topup_rate_limited';
export const TOPUP_HOURLY_LIMIT = 'topup_hourly_limit';

/**
 * Refuse if this member has already started more top-ups than a customer plausibly
 * does. Called after `claimKey` and before anything is priced or sent to the
 * gateway — see the header for why that exact position.
 *
 * IT TAKES THE PRINCIPAL AND NOT A BARE `memberId`, which is the one place this
 * signature is wider than it needs to be, and the reason is the exemption below:
 * "which customer is this" and "is there a customer at all" are different
 * questions, and only the principal can answer the second.
 */
export async function enforceTopUpLimits(
  db: Executor,
  principal: MemberPrincipal,
): Promise<void> {
  /**
   * =======================================================================
   * THE ONE EXEMPTION, AND WHY IT IS NOT A HOLE
   * =======================================================================
   * `isFabricatedPrincipal` — auth/principal.ts, which carries the full argument —
   * is true only for the `AVO_TEST_PRINCIPALS` shim, which `env.ts` refuses in
   * production and which resolves EVERY anonymous request to the same seeded
   * customer. Her id is a real id, so unlike the scanner's device it looks like a
   * perfectly good key; it simply stops naming a person. One customer's plausible
   * behaviour is the entire premise of the numbers above, and under the shim the
   * "customer" is a test suite.
   *
   * Measured rather than predicted: with this enforced under the shim,
   * `e2e/gateway.test.ts` went red in twenty places — the round trip, the duplicate
   * callback, the state machine, the trigger backstop — none of which is about rate
   * limiting, all of which drive `POST /topups` as member 8842.
   *
   * NOT EXEMPTED: a real member session in a test build. It carries a uuid session
   * id and is limited normally, which is what `topupLimit.int.test.ts` exercises
   * with `AVO_TEST_PRINCIPALS` off.
   */
  if (isFabricatedPrincipal(principal)) return;

  const memberId = principal.id;
  const hourSince = new Date(Date.now() - 60 * 60_000);
  const burstSince = new Date(Date.now() - TOPUP_WINDOW_MINUTES * 60_000);

  const [recent] = await db
    .select({
      // toISOString + an explicit cast — a bare Date in a SELECT expression never
      // meets the column's type mapper. The same 500 `signupLimit.ts` documents.
      burst: sql<number>`count(*) filter (
        where ${topUpIntent.createdAt} >= ${burstSince.toISOString()}::timestamptz
      )::int`,
      hour: sql<number>`count(*)::int`,
    })
    .from(topUpIntent)
    .where(and(eq(topUpIntent.memberId, memberId), gte(topUpIntent.createdAt, hourSince)));

  // The ceiling first. Telling somebody to "wait a moment" when she has an hour to
  // wait sends her back to the button every minute — `memberSearch.ts`'s rule.
  if ((recent?.hour ?? 0) >= TOPUP_MAX_PER_HOUR) {
    throw tooManyRequests(
      TOPUP_HOURLY_LIMIT,
      'You have started several top-ups in the last hour. Finish one of those, or try again shortly.',
    );
  }
  if ((recent?.burst ?? 0) >= TOPUP_MAX_PER_WINDOW) {
    throw tooManyRequests(
      TOPUP_RATE_LIMITED,
      'That is a lot of top-ups at once. Wait a few minutes and try again.',
    );
  }
}
