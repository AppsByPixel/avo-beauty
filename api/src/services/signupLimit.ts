/**
 * The signup limiter — bounding an unauthenticated argon2id endpoint.
 *
 * WHAT THIS DOES AND EXACTLY WHAT IT DOES NOT
 * -------------------------------------------
 * `POST /auth/member/signup` hashes a password with argon2id, deliberately
 * expensively, and had no rate limit at all. Its own header escalated two things
 * as one:
 *
 *   "UNAUTHENTICATED, AND THEREFORE AN ENUMERATION ORACLE … There is also NO RATE
 *    LIMIT on this route: argon2 is deliberately expensive, so an unauthenticated
 *    hashing endpoint is a cheap denial of service. Both are escalated, not fixed
 *    quietly."
 *
 * Only one of those was a product question. THE ORACLE STAYS ESCALATED and is not
 * touched here: `already_registered` confirms that a number holds a wallet at this
 * salon, closing it needs a verification step at signup — the shape the
 * phone-change challenge already uses — and that is a decision about what a
 * customer is asked to do. An unbounded expensive endpoint is not a product
 * question, and this is that half and no more of it.
 *
 * Saying so precisely matters, because a limiter looks like it addresses the
 * oracle and does not. At 20 attempts per five minutes an attacker walks roughly
 * 100 numbers an hour per address, and the answer for each is definitive. What is
 * bounded is the RATE, not the fact.
 *
 * THAT SENTENCE WAS FALSE UNTIL routes/auth.ts WAS REORDERED, and it was false in
 * the dangerous direction — which is worse than an absent claim, because a
 * security docstring that overstates its own protection is read as a reason not to
 * look.
 *
 * `recordSignupAttempt` used to be called BELOW the duplicate-phone refusal, with
 * a comment explaining that the row should mark an attempt "that really is about
 * to cost an argon2 hash". Sound about CPU; fatal to the oracle claim. Lane D
 * measured it: forty consecutive probes against registered numbers from one
 * address all answered `409 already_registered` and left `signup_attempt` EMPTY.
 * The oracle was not bounded at 100 an hour. It was not bounded at all. Both
 * examples the paragraph reached for — "a duplicate phone, a stale policy version"
 * — were refused above the recorder.
 *
 * FIXED BY MOVING THE CALL, not by softening the sentence. A refusal is an
 * attempt: it consumed the endpoint and it learned something. The counter now sits
 * above the duplicate check, so a probe costs a count; argon2 still runs only past
 * the check, so the CPU claim is untouched.
 *
 * A STALE POLICY VERSION IS STILL NOT COUNTED, and that is correct rather than a
 * remaining half of the bug. `requireCurrentPolicyVersion` refuses a client whose
 * screen was rendered before a publish landed; it reads the policy set and no
 * member table, so it discloses nothing about whether a phone number is
 * registered. It is a client-state refusal, not a probe.
 *
 * WHAT ONE COUNTER FOR TWO THINGS COSTS: twenty probes from an address exhaust
 * that address's signup budget for five minutes. Intended for an attacker, and a
 * real cost on a shared address — a salon's wifi where staff help customers sign
 * up. Accepted, and it is why `TRUST_PROXY` matters: behind an untrusted proxy
 * every caller already shares one bucket, which is strictly worse.
 *
 * REUSED, NOT REINVENTED. This is the shape of `enforceDirectoryReadLimits` in
 * services/memberSearch.ts, and the three properties worth copying are:
 *
 *   ONE QUERY, TWO COUNTS. The hourly window contains the five-minute one, so a
 *   single scan bounded by the wider window answers both with FILTER. Two round
 *   trips counting rows in the same table for the same caller would be a second
 *   chance for the two numbers to disagree about `now`.
 *
 *   THE CEILING IS CHECKED FIRST. When both are exceeded, the honest refusal is
 *   the one the caller cannot wait out in a moment. Telling somebody to "wait a
 *   moment" when they have an hour to wait sends them back every minute.
 *
 *   COUNTED BEFORE ANYTHING EXPENSIVE HAPPENS. A refused attempt must not pay for
 *   an argon2 hash, which is the entire point, and must not read the member table
 *   either.
 *
 * WHAT IT COULD NOT COPY. The directory limiter counts `audit_log` rows and keys
 * on a staff principal. There is no principal here — that is the problem — so the
 * key is the caller's address, and the rows live in their own table. Migration
 * 0026 has the reasoning for both, including why no phone number is stored.
 *
 * `req.ip` IS NOW A CONTROL RATHER THAN A LOG FIELD, which is why `TRUST_PROXY`
 * exists in env.ts. Behind an untrusted proxy every caller shares one bucket;
 * behind a blindly trusted one every caller can forge a fresh bucket per request.
 * Both are wrong until it names the real proxy, and off is the safer wrong.
 */

import { and, eq, gte, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { signupAttempt } from '../db/schema/session';
import { env } from '../env';
import { tooManyRequests } from '../http/errors';

/**
 * Refuse if this caller has already had its share of the hashing budget.
 *
 * Called BEFORE the password is hashed, before the salon is looked up and before
 * the phone is checked — so a throttled request costs one indexed count and
 * learns nothing about which numbers are registered.
 */
export async function enforceSignupLimits(db: Db, ipAddress: string | null): Promise<void> {
  /**
   * A caller Fastify cannot attribute is not exempted — it is counted in the
   * `ip_address IS NULL` bucket with every other such caller. Exempting it would
   * make "send a request Fastify cannot attribute" the way past the limiter, and
   * the whole class shares one budget rather than getting one each.
   */
  const hourSince = new Date(Date.now() - 60 * 60_000);
  const burstSince = new Date(Date.now() - env.signupWindowMinutes * 60_000);

  const [recent] = await db
    .select({
      // `toISOString()` and an explicit cast, not the Date. A bare Date
      // interpolated into a SELECT expression never meets the column's type
      // mapper the way it does inside `where`, and postgres-js is handed an
      // object where it expects a string. Found by the 500 it caused in
      // memberSearch.ts; repeated here because the mechanism is the same.
      burst: sql<number>`count(*) filter (
        where ${signupAttempt.createdAt} >= ${burstSince.toISOString()}::timestamptz
      )::int`,
      hour: sql<number>`count(*)::int`,
    })
    .from(signupAttempt)
    .where(
      and(
        ipAddress === null
          ? sql`${signupAttempt.ipAddress} is null`
          : eq(signupAttempt.ipAddress, ipAddress),
        gte(signupAttempt.createdAt, hourSince),
      ),
    );

  if ((recent?.hour ?? 0) >= env.signupAttemptsPerHour) {
    throw tooManyRequests(
      'signup_hourly_limit',
      'Too many accounts have been created from this connection. Try again later.',
    );
  }

  if ((recent?.burst ?? 0) >= env.signupAttemptsPerWindow) {
    throw tooManyRequests(
      'signup_rate_limited',
      'Too many attempts. Wait a moment and try again.',
    );
  }
}

/**
 * Record the attempt, on `db` and never on a caller's transaction.
 *
 * OUTSIDE THE SIGNUP TRANSACTION, DELIBERATELY. A row written inside it would be
 * rolled back by every FAILED signup — and a flood of failures is precisely the
 * traffic this exists to bound, so the counter would empty exactly when it is
 * needed. `pin_attempt` is written the same way for the same reason.
 *
 * BEFORE THE HASH, NOT AFTER, which is what decides the shape of the table.
 * Recording afterwards would let a burst of simultaneous requests all pass the
 * count and all pay for a hash before any of them was visible to the next one —
 * a thundering herd straight through the limiter. Writing first closes that, and
 * costs the honesty of an outcome column: the row cannot know yet whether the
 * signup worked, and migration 0026 revokes the UPDATE that would let it be
 * corrected later. So there is no outcome column; see that migration.
 *
 * The remaining imprecision is accepted rather than unnoticed: a request refused
 * after this line — a duplicate phone, a stale policy version — leaves an attempt
 * recorded that did cost a hash but produced no account. Over-counting in that
 * direction is correct, because the hash is the thing being rationed.
 */
export async function recordSignupAttempt(
  db: Db,
  params: { salonId: string; ipAddress: string | null },
): Promise<void> {
  await db.insert(signupAttempt).values({
    salonId: params.salonId,
    ipAddress: params.ipAddress,
  });
}
