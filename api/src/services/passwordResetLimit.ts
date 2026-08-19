/**
 * Per-connection budget for the UNAUTHENTICATED member reset-request endpoint.
 *
 * `signupLimit.ts` is the precedent and its header carries the reasoning; the
 * differences here are the numbers and what is being rationed. Signup rations the
 * argon2 hash. This endpoint does no hashing — what it rations is two other
 * things:
 *
 *   - ENUMERATION. The endpoint answers 202 whether or not the phone holds a
 *     wallet, so a single probe learns nothing. What is left is a residual timing
 *     channel (a matched phone does two more writes than a miss), and the budget
 *     is what makes sampling it impractical: six requests an hour per connection
 *     is not a measurement platform.
 *   - LINK CHURN. Issuing spends the outstanding link, so an attacker who knows
 *     a victim's phone could otherwise invalidate her real link the moment it is
 *     sent, forever, for free. The budget turns that from a standing denial of
 *     service into a nuisance that costs an hour per six attempts.
 *
 * ENFORCED BEFORE ANYTHING — before the phone is even parsed. The posture of an
 * unauthenticated endpoint (who may ask, how often) settles before any statement
 * about the request's content; Reports learnt that ordering the hard way when an
 * anonymous caller could distinguish valid kinds from bogus ones by the error
 * code.
 *
 * CONSTANTS, NOT ENV. The signup limiter is env-tuned because launch traffic is a
 * genuine unknown; a reset endpoint's legitimate per-IP rate is not — a human
 * resets a password a handful of times a year. memberSearch.ts made the same call
 * for the same reason.
 */

import { and, eq, gte, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { memberPasswordResetAttempt } from '../db/schema/member';
import { tooManyRequests } from '../http/errors';

export const RESET_REQUEST_WINDOW_MINUTES = 15;
export const RESET_REQUEST_MAX_PER_WINDOW = 3;
export const RESET_REQUEST_MAX_PER_HOUR = 6;

export async function enforceResetRequestLimits(db: Db, ipAddress: string | null): Promise<void> {
  const hourSince = new Date(Date.now() - 60 * 60_000);
  const burstSince = new Date(Date.now() - RESET_REQUEST_WINDOW_MINUTES * 60_000);

  const [recent] = await db
    .select({
      // toISOString + explicit cast — a bare Date in a SELECT expression never
      // meets a column type mapper. Same 500 signupLimit.ts documents.
      burst: sql<number>`count(*) filter (
        where ${memberPasswordResetAttempt.createdAt} >= ${burstSince.toISOString()}::timestamptz
      )::int`,
      hour: sql<number>`count(*)::int`,
    })
    .from(memberPasswordResetAttempt)
    .where(
      and(
        ipAddress === null
          ? sql`${memberPasswordResetAttempt.ipAddress} is null`
          : eq(memberPasswordResetAttempt.ipAddress, ipAddress),
        gte(memberPasswordResetAttempt.createdAt, hourSince),
      ),
    );

  if ((recent?.hour ?? 0) >= RESET_REQUEST_MAX_PER_HOUR) {
    throw tooManyRequests(
      'reset_hourly_limit',
      'Too many reset requests from this connection. Try again later.',
    );
  }
  if ((recent?.burst ?? 0) >= RESET_REQUEST_MAX_PER_WINDOW) {
    throw tooManyRequests('reset_rate_limited', 'Too many attempts. Wait a moment and try again.');
  }
}

/**
 * Written BEFORE any lookup, on `db` and never on a caller's transaction —
 * signupLimit.ts § recordSignupAttempt explains both halves (a rolled-back
 * counter empties exactly when it is needed; recording after the work lets a
 * burst race through the limiter).
 */
export async function recordResetRequestAttempt(db: Db, ipAddress: string | null): Promise<void> {
  await db.insert(memberPasswordResetAttempt).values({ ipAddress });
}
