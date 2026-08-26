/**
 * Per-identity budget for the three PASSWORD sign-ins.
 *
 *   POST /auth/member/session     the customer wallet    (salonId + phone)
 *   POST /auth/web/session        the merchant dashboard (salonId + username)
 *   POST /auth/platform/session   the owner console      (handle)
 *
 * =========================================================================
 * WHAT WAS MISSING, AND WHY IT WAS EASY TO MISS
 * =========================================================================
 * All three verified a password, answered `invalid_credentials`, and COUNTED
 * NOTHING. No rate limit, no lockout, no attempt row — and no global limiter to
 * fall back on: `app.ts` registers no rate-limit plugin and `package.json`
 * carries no such package. Somebody holding a phone number and a salon id, or a
 * console handle, could guess without bound and without leaving a trace.
 *
 * It was an ASYMMETRY rather than a general absence, which is what made it
 * invisible. Signup is limited (`signupLimit.ts`), the member reset request is
 * limited (`passwordResetLimit.ts`), the support queue is limited
 * (`supportLimit.ts`), top-ups are limited (`topupLimit.ts`), the customer
 * directory is limited (`memberSearch.ts`), and the three scanner endpoints are
 * limited (`scannerLimit.ts`). The staff PIN is limited TWICE — per device via
 * `pin_attempt` and per account via `staff_user.pin_locked_until` — in a
 * documented order that `routes/auth.ts § staffPinSession` spells out. Only the
 * passwords were open.
 *
 * The likely reason is worth writing down, because it is the shape of the next
 * omission. Non-negotiable #6 reads: "Passwords are never stored in plaintext,
 * never returned by an endpoint, never shown in a UI. Staff PINs are hashed, rate
 * limited, device-scoped, locked after N failures." The four controls are attached
 * to the PIN, and the PIN got all four. Four digits needs them more than a
 * password does. It does not need them INSTEAD of a password.
 *
 * =========================================================================
 * THE TRAP: A LOCKOUT THAT ONLY ENGAGES FOR REAL ACCOUNTS IS AN ORACLE
 * =========================================================================
 * `routes/auth.ts`'s header states the property the whole file is built around:
 * "Every failure path answers with the same body and burns the same argon2 time,
 * whether the account exists or not. 'Wrong password' and 'no such phone number'
 * being distinguishable turns a login form into a customer-list oracle."
 *
 * The obvious lockout — count failures against the account row, refuse when the
 * count is high — hands that straight back, louder. `429 account locked` for
 * numbers that are registered and `401 bad credentials` for numbers that are not
 * is a customer-list oracle with a far bigger signal than the timing channel the
 * `burnVerifyTime` calls were added to remove: no measurement, no statistics, one
 * request per number, a definitive answer.
 *
 * SO THE KEY IS WHAT THE REQUEST CLAIMS, NOT WHAT THE DATABASE HOLDS. The bucket
 * is derived from the fields on the request, before any table is read, and this
 * module never learns whether an account exists. A spent bucket for a real
 * customer and a spent bucket for a number nobody has ever registered are THE SAME
 * CODE PATH — same status, same `error` code, same body, and the same absence of
 * an argon2 hash — so they are indistinguishable by construction rather than by
 * anybody remembering to keep them so. `signInLimit.int.test.ts` pins it.
 *
 * =========================================================================
 * THE SECOND TRAP: A LATCH IS A WEAPON POINTED AT A CUSTOMER
 * =========================================================================
 * `staff_user.pin_locked_until` is a latch, and it is right where it is. The
 * account is a staff member, the device is in the salon, and "a manager can unlock
 * it, or try again later" is a true sentence about a person standing nearby.
 *
 * Nobody is standing next to Dana's phone. A latch on a customer wallet would mean
 * that anyone who knows her number can bar her from her own money at will, for the
 * cost of five wrong guesses, indefinitely. `routes/auth.ts` has already reasoned
 * about exactly this shape once — the deletion grace window is deliberately not a
 * bar on the reset flow, because a customer who forgot her password during it
 * "would otherwise be locked out of the one door that cancels the erasure".
 *
 * So: A ROLLING WINDOW, and NOTHING WRITTEN TO THE ACCOUNT ROW. There is no state
 * for an attacker to set, no unlock for anyone to perform, and no support call.
 * The window decays continuously — both tiers roll, so a bad five minutes refills
 * from the front rather than at the top of the hour — and the legitimate user is
 * back in as soon as it has.
 *
 * THIS DOES NOT ELIMINATE THE DENIAL OF SERVICE, and saying so precisely matters,
 * because a rolling window looks as though it does. An attacker willing to spend
 * the ceiling every hour, forever, can keep a known account's bucket full. What
 * changes is the shape: no persistent state, no human in the loop, no "your account
 * is locked" screen, and every gap in the attack is a gap the customer signs in
 * through. That is the best available trade against an unbounded guessing endpoint,
 * and the alternative — no limit at all — leaves her password guessable instead,
 * which is the failure she cannot recover from.
 *
 * AND A REFUSED REQUEST DOES NOT EXTEND THE WINDOW, which is the part of the trade
 * that is easy to lose. `chargeSignInBudget` checks and THEN records, so a caller
 * who is already over budget adds no row: the window drains from the last COUNTED
 * attempt rather than from the last attempt. Reverse the two calls — record first,
 * then check — and an attacker hammering in a loop pushes the window forward with
 * every request and the customer never gets back in at all. That ordering is
 * `scannerLimit.ts § chargeScannerBudget`'s, kept here for a reason that file did
 * not have.
 *
 * =========================================================================
 * KEYING, IN FULL — AND WHY `req.ip` IS NOT A TIER HERE
 * =========================================================================
 * `signupLimit.ts` keys on `req.ip`, so an address-keyed tier would look like the
 * house pattern. It is deliberately absent, and this is the argument `scannerLimit`
 * and migration 0038 make for the till, one step stronger:
 *
 *   A SALON IS ONE NAT. Every customer who signs in on the salon's wifi leaves
 *   through one address. An address-keyed sign-in budget refuses the fourth
 *   customer of the afternoon, in front of the receptionist.
 *
 *   `req.ip` IS NOT RELIABLY THE CALLER. `app.ts` sets `trustProxy: env.trustProxy`,
 *   which is OFF until `TRUST_PROXY` names the real proxy (`env.ts` says why off is
 *   the safer of the two wrongs). Behind a load balancer that makes `req.ip` the
 *   balancer, so every caller on the platform shares ONE bucket. On signup that is
 *   a bad afternoon. On sign-in it is every surface locked out at once — strictly
 *   worse than the guessing it would bound.
 *
 *   AND IT IS EVADABLE IN THE DIRECTION THAT MATTERS. An attacker rotates
 *   addresses; a customer cannot. The claimed identity is the attacker-independent
 *   key: no amount of rotation moves an attack on Dana's wallet out of Dana's
 *   bucket.
 *
 * WHAT THAT LEAVES UNBOUNDED, stated rather than denied — `signupLimit.ts` had to
 * learn the cost of a limiter header that overstates its own protection:
 *
 *   PASSWORD SPRAYING. One common password tried against ten thousand different
 *   phone numbers touches ten thousand buckets and fills none of them. A per-
 *   identity limiter cannot see it, by definition.
 *
 *   THE ARGON2 COST OF ROTATING CLAIMED IDENTITIES. A miss still calls
 *   `burnVerifyTime`, which is a real argon2id verify, so a caller inventing a
 *   fresh identity per request pays for a hash per request and is bounded by
 *   nothing here.
 *
 * BOTH NEED A CALLER KEY, AND THERE ISN'T ONE TODAY. That is the same sentence as
 * the two bullets above about `req.ip`, and it is why this is escalated rather than
 * guessed at: a per-address sign-in tier becomes available the moment `TRUST_PROXY`
 * names the real proxy, and is a platform-wide outage before then. Neither of these
 * is a regression — both are unbounded today in every direction, and this file
 * bounds the one direction that can be bounded without a caller key.
 *
 * =========================================================================
 * WHERE THE CHECK SITS
 * =========================================================================
 * In the route handler, as the first statement after the identity fields are
 * parsed, and BEFORE the account lookup and before any hashing. Three properties
 * come out of that placement and all three are load-bearing:
 *
 *   A THROTTLED CALLER READS NO TABLE, so it learns nothing about which numbers or
 *   handles are registered — the property § THE TRAP is about.
 *
 *   A THROTTLED CALLER PAYS FOR NO ARGON2, which is what makes the limiter cheaper
 *   than the thing it is rationing. `signupLimit.ts`'s ordering rule.
 *
 *   THE PARSE ABOVE IT DISCLOSES NOTHING. `requireString` is a field-shape check
 *   that reads no table and hashes nothing, so a 400 above the limiter is a
 *   client-state refusal and not a probe — the distinction `signupLimit.ts` draws
 *   for `requireCurrentPolicyVersion`. The key is derived FROM those fields, so it
 *   cannot be computed before them; `passwordResetLimit.ts` runs strictly first
 *   only because its key is the address.
 *
 * NO TRANSACTION IS INVOLVED. All three handlers are lookup-then-verify with no
 * `db.transaction()` open, so the pool deadlock `scannerLimit.ts § WHERE THE CHECK
 * SITS` measured cannot arise. The counter is still written on `db` and the check
 * still sits before the work, because both remain correct for their own reasons.
 *
 * =========================================================================
 * COUNTED BEFORE THE VERIFY, WHICH MEANS SUCCESSES COUNT TOO
 * =========================================================================
 * `signupLimit.ts` carries the scar: `recordSignupAttempt` used to sit below the
 * duplicate-phone refusal, and Lane D measured forty consecutive probes that all
 * answered `409 already_registered` and left `signup_attempt` EMPTY. "The oracle
 * was not bounded at 100 an hour. It was not bounded at all." A refusal is an
 * attempt — it consumed the endpoint and it learned something — and writing first
 * is also what stops a burst of simultaneous requests all reading a count of zero
 * and all paying for a hash.
 *
 * The cost is that a SUCCESSFUL sign-in spends budget as well, because the row is
 * written before the outcome exists (migration 0039 revokes the UPDATE that would
 * let it be corrected later, for the reason 0026 gives). Accepted, and it is
 * cheaper than it looks: at ten per fifteen minutes per identity, a person would
 * have to sign in on an eleventh device inside a quarter of an hour to feel it.
 * Counting only failures would not have bought anything on the denial-of-service
 * side either — an attacker fills the bucket with failures either way.
 *
 * =========================================================================
 * REUSED, NOT REINVENTED
 * =========================================================================
 * The query is `signupLimit.ts`'s, which is `memberSearch.ts`'s: ONE QUERY, TWO
 * COUNTS (the hourly window contains the burst one, so one scan answers both with
 * FILTER, and the two numbers cannot disagree about `now`); THE CEILING IS CHECKED
 * FIRST (when both are spent, the honest refusal is the one the caller cannot wait
 * out in a moment); `toISOString()` AND AN EXPLICIT `::timestamptz` CAST, never a
 * bare `Date` in a SELECT expression, which is the 500 `memberSearch.ts` found.
 */

import { createHmac } from 'node:crypto';
import { and, eq, gte, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { signInAttempt } from '../db/schema/session';
import { env } from '../env';
import { tooManyRequests } from '../http/errors';

/** The three password front doors. Matches `sign_in_attempt_surface_known`. */
export type SignInSurface = 'member' | 'web' | 'platform';

/**
 * =========================================================================
 * THERE IS NO EXEMPTION, AND THIS BLOCK RECORDS THE ONE THERE USED TO BE
 * =========================================================================
 * This limiter shipped exempt under `AVO_TEST_PRINCIPALS` — the harness shim
 * `env.ts` refuses in production — because enforcing it turned `e2e/` red:
 *
 *     baseline (no limiter)    29 files, 1066 passed,   0 skipped,  0 failed
 *     enforced under the shim   6 FILES FAILED,  978 passed, 84 skipped, 4 failed
 *
 * None of those failures was about rate limiting. They were files whose `beforeAll`
 * could no longer get a token, because the harness minted a fresh session at every
 * call site: `signInDashboard(SALON_B, 'layla')` had 15 static ones, and
 * `console-reset.test.ts` signed one console handle in twenty times to prove that a
 * redeemed reset link is spent.
 *
 * RAISING THE THRESHOLD TO FIT CI WAS REFUSED, on `scannerLimit.ts`'s own rule, and
 * that was right: a manager signing in fifteen times in fourteen minutes is not a
 * human pattern a production control should be tuned around. But the exemption cost
 * something exact, and it was disclosed rather than discovered — `pnpm check` proved
 * NOTHING about the wiring of this limiter into the three handlers. Trunk measured
 * it: with the `chargeSignInBudget` call deleted from the member handler, the gate
 * stayed 235 green. DECISIONS.md #40.
 *
 * LANE D REMOVED THE REASON. `e2e/support/tenancy-harness.ts` now holds ONE session
 * per identity per run, and `console-reset.test.ts` invites a fresh admin per test
 * because its twenty sign-ins were about twenty passwords and one link, never about
 * one identity's budget. With this limiter fully enforced under the shim:
 *
 *     30 files, 1092 passed, 0 failed, twice in a row
 *
 * The most any single identity now spends in a run is five, against a burst budget
 * of ten. So the exemption had no remaining consumer — `vitest.int.config.ts` sets
 * `AVO_TEST_PRINCIPALS: '0'` and the e2e harness was the only build that set it on —
 * and it is deleted rather than narrowed.
 *
 * AND THE GATE NOW COVERS THE WIRING, which is the whole point of having removed it.
 * `e2e/sign-in-limit.test.ts` drives all three endpoints from outside and is in
 * `pnpm check`. Deleting any one of the three `chargeSignInBudget` calls turns it
 * red — verified one call site at a time: member 8 specs, web 1, platform 1.
 *
 * THE ROWS A TEST BUILD NOW WRITES, stated because the deleted block was right that
 * this is a cost. `recordSignInAttempt` no longer skips under the shim, so a test
 * build inserts into a real counter and `avo_app` cannot DELETE what it inserts
 * (migration 0039). For `e2e/` that is free: `global-setup.ts` mints a database per
 * run and drops it in teardown. For a long-lived development database it means
 * `sign_in_attempt` accumulates rows naming buckets only a harness ever touched,
 * which the operator's retention job removes. That is the price of the limiter being
 * in the gate at all, and it is the cheaper side of the trade.
 */

/**
 * =========================================================================
 * THRESHOLDS — A DEFENSIBLE DEFAULT, NOT A MEASUREMENT, AND NOT A POLICY
 * =========================================================================
 * NOBODY HAS DECIDED AVO'S SIGN-IN POLICY. These are engineering defaults chosen
 * to be defensible in both directions, and they should become a DECISIONS.md entry
 * rather than stay a constant nobody agreed to. `scannerLimit.ts § THRESHOLDS`
 * says the same about its numbers and gives the revision procedure; the same
 * procedure applies here, against `sign_in_attempt` rows.
 *
 * WHAT A REAL PERSON DOES. She types a password, gets it wrong, tries the
 * capitalisation, tries her other password, and then uses the reset link — which
 * exists on all three surfaces and is itself limited. Three to five attempts is a
 * bad day; ten inside a quarter of an hour is somebody who should be resetting.
 *
 * WHAT AN ATTACKER GETS. 20 an hour against one account is 480 a day and about
 * 175,000 a year. Against the six-character minimum `isAcceptablePassword`
 * enforces that is not a search — it is a handful of guesses at a dictionary, which
 * is the level an online limiter can honestly claim. Offline resistance is argon2's
 * job and is unaffected by any number here.
 *
 * WHY NOT TIGHTER. Every attempt removed from the ceiling is an attempt an attacker
 * can spend to keep a real customer out (§ THE SECOND TRAP). Five an hour would
 * bound guessing slightly better and would make a stranger's denial of service
 * four times cheaper, on the surface where the victim has no manager to call.
 *
 * WHY NOT LOOSER. Past a few hundred an hour the limiter stops being a control on
 * guessing and becomes only a CPU budget, which is `signupLimit.ts`'s job and not
 * this one's.
 *
 * ONE SET OF NUMBERS FOR ALL THREE SURFACES, deliberately. The console is the most
 * valuable credential and the wallet the most numerous, so an argument for
 * splitting them exists — but it is an argument about POLICY, and inventing three
 * policies is worse than implementing one and saying who should own it.
 *
 * CONSTANTS, NOT ENV, which is `passwordResetLimit.ts`'s and `supportLimit.ts`'s
 * call and for their reason: a human's legitimate sign-in rate is not the kind of
 * per-deployment unknown that launch traffic on an open signup endpoint is.
 */
export const SIGN_IN_WINDOW_MINUTES = 15;
export const SIGN_IN_MAX_PER_WINDOW = 10;
export const SIGN_IN_HOUR_WINDOW_MINUTES = 60;
export const SIGN_IN_MAX_PER_HOUR = 20;

/**
 * The refusal codes. `http/errors.ts`: "The `error` string is the contract —
 * packages/mock and the clients switch on it."
 *
 * DISTINCT FROM `invalid_credentials`, and that is not a leak. It says the CALLER
 * has been asking too often; it says nothing about whether the identity being asked
 * about exists, because this module never looked. Folding it into
 * `invalid_credentials` would tell a customer who mistyped twice that her password
 * is wrong when it is not, and would send her to the reset flow she does not need.
 *
 * NAMED AFTER THE ACT, NOT THE SURFACE, because one shape covers three endpoints —
 * `scannerLimit.ts` makes the same call for the opposite reason ("a code called
 * `charge_rate_limited` arriving from `POST /scans` would be the kind of small lie
 * that costs somebody an afternoon").
 */
export const SIGN_IN_RATE_LIMITED = 'sign_in_rate_limited';
export const SIGN_IN_HOURLY_LIMIT = 'sign_in_hourly_limit';

/**
 * The bucket, derived from what the request CLAIMS.
 *
 * WHY AN HMAC AND NOT THE IDENTIFIER ITSELF. This column is a list of identities
 * somebody TRIED, which by construction includes people who hold no account here.
 * Migration 0026 refused to store the phone number in `signup_attempt` for exactly
 * that reason — "a table of phone numbers that tried to register, retained
 * indefinitely, would be a list of people who do not have accounts here. That is a
 * worse privacy artefact than the oracle this does not close." The limit needs a
 * stable key, not the identity, so it keeps a key.
 *
 * WHY AN HMAC AND NOT A PLAIN DIGEST. A Kuwaiti mobile is eight digits behind a
 * fixed prefix. A bare sha256 of one is a hundred million preimages away from the
 * number, which is a laptop-minute — so an unkeyed digest would store the phone
 * book with extra steps. `env.jwtSecret` is required in production (`env.ts`
 * refuses to boot without it) and shared across replicas, which is exactly the
 * property a rate-limit key needs.
 *
 * DOMAIN-SEPARATED with a versioned label, so this can never collide with anything
 * else the same secret authenticates and so the construction can be changed later
 * without silently merging old and new buckets.
 *
 * ROTATING `JWT_SECRET` RE-KEYS EVERY BUCKET and empties the limiter for one
 * window. Named rather than hidden: a secret rotation is a rare, deliberate,
 * operator-run event, and the alternative is a second secret with its own
 * lifecycle that nothing else in this API has.
 *
 * NORMALISATION IS THE CALLER'S, and it must match the lookup the handler then
 * performs. `POST /auth/web/session` lower-cases the username and
 * `POST /auth/platform/session` lower-cases the handle and strips a leading '@',
 * so the key is built from the same string the WHERE clause uses. That equality is
 * what makes the bucket the one an attacker actually has to spend: a variant that
 * lands in a different bucket also fails to match any row, so it cannot
 * authenticate. `POST /auth/member/session` matches the phone byte-for-byte
 * against `member.phone` and the key follows it.
 */
export function signInIdentityKey(
  surface: SignInSurface,
  salonId: string | null,
  identifier: string,
): string {
  return createHmac('sha256', env.jwtSecret)
    .update(`avo.sign-in-limit.v1|${surface}|${salonId ?? ''}|${identifier}`)
    .digest('hex');
}

/**
 * Refuse if this claimed identity has already spent its budget.
 *
 * Called BEFORE the account is looked up and before anything is hashed, so a
 * throttled caller costs one indexed count and learns nothing — not whether the
 * identity exists, not whether the password was close.
 */
export async function enforceSignInLimits(db: Db, identityKey: string): Promise<void> {
  const hourSince = new Date(Date.now() - SIGN_IN_HOUR_WINDOW_MINUTES * 60_000);
  const burstSince = new Date(Date.now() - SIGN_IN_WINDOW_MINUTES * 60_000);

  const [recent] = await db
    .select({
      // `toISOString()` and an explicit cast, not the Date. A bare Date
      // interpolated into a SELECT expression never meets the column's type mapper
      // the way it does inside `where`, and postgres-js is handed an object where
      // it expects a string. The 500 `memberSearch.ts` found.
      burst: sql<number>`count(*) filter (
        where ${signInAttempt.createdAt} >= ${burstSince.toISOString()}::timestamptz
      )::int`,
      hour: sql<number>`count(*)::int`,
    })
    .from(signInAttempt)
    .where(and(eq(signInAttempt.identityKey, identityKey), gte(signInAttempt.createdAt, hourSince)));

  if ((recent?.hour ?? 0) >= SIGN_IN_MAX_PER_HOUR) {
    throw tooManyRequests(
      SIGN_IN_HOURLY_LIMIT,
      'Too many sign-in attempts. Try again later, or use the reset link.',
    );
  }
  if ((recent?.burst ?? 0) >= SIGN_IN_MAX_PER_WINDOW) {
    throw tooManyRequests(
      SIGN_IN_RATE_LIMITED,
      'Too many attempts. Wait a moment and try again.',
    );
  }
}

/**
 * Record the attempt, on `db` and never on a caller's transaction.
 *
 * BEFORE THE LOOKUP AND BEFORE THE HASH — `signupLimit.ts § recordSignupAttempt`
 * has both halves of why: recording afterwards lets a burst of simultaneous
 * requests all pass the count and all pay for an argon2 hash before any of them is
 * visible to the next, and a counter written inside a transaction empties on every
 * rollback, which is exactly the traffic being bounded.
 *
 * NEVER THE PASSWORD, in any column, in any form. Non-negotiable #6. Nothing in
 * this module is handed the password at all, which is the cheapest way to keep
 * that true.
 */
export async function recordSignInAttempt(
  db: Db,
  params: { surface: SignInSurface; identityKey: string; salonId: string | null },
): Promise<void> {
  await db.insert(signInAttempt).values({
    surface: params.surface,
    identityKey: params.identityKey,
    salonId: params.salonId,
  });
}

/**
 * Check, then record. The pair, in the only order that is safe, so no call site has
 * to remember it — `scannerLimit.ts § chargeScannerBudget` is the precedent.
 *
 * Takes the RAW claimed identity rather than a key, so that no handler can key a
 * bucket one way and look the account up another. All three call exactly this.
 */
export async function chargeSignInBudget(
  db: Db,
  surface: SignInSurface,
  salonId: string | null,
  identifier: string,
): Promise<void> {
  const identityKey = signInIdentityKey(surface, salonId, identifier);
  await enforceSignInLimits(db, identityKey);
  await recordSignInAttempt(db, { surface, identityKey, salonId });
}
