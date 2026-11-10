/**
 * The budget in front of `POST /staff/pair` — the one unauthenticated door that
 * hands out a scanner credential. Aftab, 2026-11-10 (DECISIONS.md § Staff phone
 * pairing): "a per-IP and per-phone budget sits in front, on the existing
 * sign-in-limit pattern."
 *
 * THE PATTERN IS `signInLimit.ts`'s, AND SO IS THE TABLE. Same `sign_in_attempt`
 * rows (surface `'pair'`, admitted by migration 0073), same HMAC-keyed buckets
 * so the counter never holds a phone number in the clear, same rolling window
 * with nothing written to any account row, and the same CHECK-THEN-RECORD order
 * so a caller already over budget adds no row and the window drains from the
 * last COUNTED attempt. Read that file's header for the argument; this one only
 * records where pairing differs.
 *
 * =========================================================================
 * WHAT IS BEING GUESSED, AND WHAT ELSE ALREADY BOUNDS IT
 * =========================================================================
 * Two ways in, and they need different things from a limiter:
 *
 *   THE TOKEN (the QR). 256 bits of CSPRNG. Nobody guesses one; the limiter's job
 *   on this path is only to bound the CPU an anonymous caller can spend, since
 *   every request pays one argon2 hash of the chosen PIN.
 *
 *   THE PHONE + SIX DIGITS. A million codes, and a code that lives ten minutes.
 *   Bounded THREE ways: per code (five wrong guesses void it —
 *   `staff_pairing_code.failed_attempts`, counted under a row lock so a burst
 *   cannot overshoot), per phone here, and per address here.
 *
 * =========================================================================
 * WHY AN ADDRESS TIER IS ACCEPTABLE HERE WHEN 0039 REFUSED IT FOR PASSWORDS
 * =========================================================================
 * `signInLimit.ts § KEYING` refuses `req.ip` for the three password doors, for
 * three reasons. Each is weaker here, and the one that survives is stated:
 *
 *   "A SALON IS ONE NAT." True, and a salon pairs a phone ONCE per staff member,
 *   at onboarding, with a manager standing there. Thirty attempts in a quarter of
 *   an hour from one address is a whole team being set up twice over; the fourth
 *   customer of the afternoon is not a pairing.
 *
 *   "AN ATTACKER ROTATES ADDRESSES." True, which is why the address tier is not
 *   the only one: the per-phone tier and the per-code burn are attacker-
 *   independent, and the address tier exists for the thing they cannot see —
 *   one caller spraying six-digit guesses across MANY phones' live codes.
 *
 *   "`req.ip` IS NOT RELIABLY THE CALLER." STILL TRUE, and this is the cost,
 *   named rather than hidden: until `TRUST_PROXY` names the real proxy, every
 *   caller behind a load balancer shares one address bucket, so a determined
 *   stranger can hold pairing shut platform-wide for the length of the window.
 *   On a password door that is every customer locked out of her money; here it is
 *   "pair the new artist's phone in fifteen minutes", which is why the spec's
 *   per-IP tier is implemented rather than escalated. The thresholds below are
 *   generous on that account.
 *
 * =========================================================================
 * THE REFUSAL
 * =========================================================================
 * `429 too_many_attempts` — the code `staffPinSession`'s per-device limit already
 * answers on the scanner, which is the client that calls this. Distinct from
 * `pairing_refused` and that is not a leak: it says the CALLER has been asking
 * too often, and it is decided before any table holding staff or codes is read,
 * so a spent bucket for a real number and for an invented one are the same code
 * path — `signInLimit.ts § THE TRAP`, kept.
 */

import { createHmac } from 'node:crypto';
import { and, eq, gte, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { signInAttempt } from '../db/schema/session';
import { env } from '../env';
import { tooManyRequests } from '../http/errors';

/**
 * THRESHOLDS — engineering defaults, not a policy anybody has decided, for the
 * reason `signInLimit.ts § THRESHOLDS` gives. The per-phone pair matches the
 * password doors (10 per 15 minutes, 20 an hour): one person's number. The
 * per-address pair is three times wider because one address is a whole salon.
 */
export const PAIR_WINDOW_MINUTES = 15;
export const PAIR_HOUR_WINDOW_MINUTES = 60;
export const PAIR_PHONE_MAX_PER_WINDOW = 10;
export const PAIR_PHONE_MAX_PER_HOUR = 20;
export const PAIR_ADDRESS_MAX_PER_WINDOW = 30;
export const PAIR_ADDRESS_MAX_PER_HOUR = 60;

/** `http/errors.ts`: the `error` string is the contract. */
export const PAIR_RATE_LIMITED = 'too_many_attempts';
const PAIR_RATE_LIMITED_MESSAGE = 'Too many attempts. Wait a few minutes and try again.';

type PairTier = 'ip' | 'phone';

/**
 * The bucket. HMAC under `JWT_SECRET` with its own versioned label, so it can
 * never collide with a `signInIdentityKey` bucket and a phone never sits in the
 * clear — a Kuwaiti mobile is eight digits behind a fixed prefix, and a bare
 * digest of one is a laptop-minute from the number.
 *
 * NORMALISATION IS THE CALLER'S and must match the lookup: the phone tier is fed
 * the E.164 the handler then looks up, so `99124408` and `+96599124408` are one
 * bucket because they are one number.
 */
export function pairIdentityKey(tier: PairTier, identifier: string): string {
  return createHmac('sha256', env.jwtSecret)
    .update(`avo.pair-limit.v1|${tier}|${identifier}`)
    .digest('hex');
}

async function spent(
  db: Db,
  identityKey: string,
  maxPerWindow: number,
  maxPerHour: number,
): Promise<boolean> {
  const hourSince = new Date(Date.now() - PAIR_HOUR_WINDOW_MINUTES * 60_000);
  const burstSince = new Date(Date.now() - PAIR_WINDOW_MINUTES * 60_000);
  const [recent] = await db
    .select({
      // `toISOString()` and an explicit cast — the 500 `memberSearch.ts` found
      // with a bare Date in a SELECT expression. `signInLimit.ts`'s query.
      burst: sql<number>`count(*) filter (
        where ${signInAttempt.createdAt} >= ${burstSince.toISOString()}::timestamptz
      )::int`,
      hour: sql<number>`count(*)::int`,
    })
    .from(signInAttempt)
    .where(and(eq(signInAttempt.identityKey, identityKey), gte(signInAttempt.createdAt, hourSince)));
  return (recent?.hour ?? 0) >= maxPerHour || (recent?.burst ?? 0) >= maxPerWindow;
}

/**
 * Check every tier, then record every tier. On `db`, never on a transaction —
 * a counter written inside one empties on every rollback, which is exactly the
 * traffic being rationed (`signupLimit.ts`).
 *
 * BOTH CHECKS BEFORE EITHER RECORD, so a request refused by one tier spends
 * nothing in the other: an over-budget caller does not extend any window.
 *
 * `ip` may be null (no address on the request); then only the phone tier, if
 * any, applies. A null address is not exempted into a shared bucket, which would
 * make every address-less caller one caller.
 */
export async function chargePairBudget(
  db: Db,
  claims: { ip: string | null; phone: string | null },
): Promise<void> {
  const tiers: Array<{ key: string; perWindow: number; perHour: number }> = [];
  if (claims.ip) {
    tiers.push({
      key: pairIdentityKey('ip', claims.ip),
      perWindow: PAIR_ADDRESS_MAX_PER_WINDOW,
      perHour: PAIR_ADDRESS_MAX_PER_HOUR,
    });
  }
  if (claims.phone) {
    tiers.push({
      key: pairIdentityKey('phone', claims.phone),
      perWindow: PAIR_PHONE_MAX_PER_WINDOW,
      perHour: PAIR_PHONE_MAX_PER_HOUR,
    });
  }

  for (const t of tiers) {
    if (await spent(db, t.key, t.perWindow, t.perHour)) {
      throw tooManyRequests(PAIR_RATE_LIMITED, PAIR_RATE_LIMITED_MESSAGE);
    }
  }
  for (const t of tiers) {
    await db.insert(signInAttempt).values({ surface: 'pair', identityKey: t.key, salonId: null });
  }
}
