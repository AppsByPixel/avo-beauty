/**
 * Manual customer lookup — the path for the customer whose phone is flat.
 *
 * The scanner has a "find her by name or number" box and it rendered "No such
 * endpoint", so lane B worked around it and lane D wrote the gap down. This is
 * that endpoint.
 *
 * A STAFF-FACING SEARCH BOX IS A CUSTOMER-LIST EXPORT UNLESS YOU STOP IT
 * ---------------------------------------------------------------------
 * Four controls, and none of them is decoration. Three exist so the box cannot
 * be walked, and the fourth is a promise the product made to the customer:
 *
 *   SALON SCOPING      Without it a staff member at one salon searches every
 *                      customer AVO has. This is the same tenancy boundary
 *                      lane D already found leaking once through
 *                      `GET /members/me/transactions`.
 *   MINIMUM LENGTH     A one-character query returns the salon. Two characters
 *                      is the shortest query that is plausibly a search rather
 *                      than an enumeration, and `%a%` returning the customer
 *                      book is exactly the failure the limit prevents.
 *   RATE LIMIT         Otherwise the box walks the name space at whatever speed
 *                      the tablet manages. TWO TIERS — a burst limit per SESSION
 *                      and a ceiling per PERSON. See below; one of them alone was
 *                      not a limit at all.
 *   AUDIT ROW          design/AVO Staff Scanner.dc.html promises the CUSTOMER
 *                      that lookups are logged against the staff member. That
 *                      makes the row part of the feature and not telemetry, and
 *                      only the server can keep the promise — a client that
 *                      writes its own audit row is a client that can decline to.
 *
 * WHY THE AUDIT LOG IS ALSO THE RATE-LIMIT COUNTER
 * ------------------------------------------------
 * It is not thrift. The rate limit has to count the thing the promise is about,
 * and the audit row IS that thing. A separate counter table can drift from the
 * log — a lookup that was throttled but not logged, or logged but not counted —
 * and then "how many times did she search today" has two answers. One row per
 * lookup, written before the results are returned, counted the same way.
 *
 * `audit_log` is append-only and the application role cannot UPDATE or DELETE
 * it (migration 0001), so the counter cannot be trimmed by the process that is
 * being limited. That property is worth more here than an index would be.
 *
 * WHY THERE ARE TWO CEILINGS AND NOT ONE
 * --------------------------------------
 * The per-session limit below was, on its own, not a limit. A session is not a
 * scarce thing: a staff member holds her PIN, and signing in again mints a new
 * one with a fresh budget of thirty. The PIN limiter does not stop that either —
 * it counts only FAILED attempts (`succeeded = false` in routes/auth.ts), so
 * successful re-authentication is unlimited by design, and correctly so. The two
 * facts compose into an enumeration path with no ceiling at all: thirty lookups,
 * sign in again, thirty more, for as long as the shift lasts.
 *
 * That was reported rather than changed, because the per-session reasoning is
 * sound and worth keeping — a stolen token should get its own budget rather than
 * inheriting the staff member's leftovers. So the fix ADDS a tier instead of
 * replacing one:
 *
 *   PER SESSION, 5 MINUTES   the burst. Shapes a frantic minute at one counter.
 *                            Resettable by re-authenticating, and that is fine
 *                            once it is no longer the only control.
 *   PER ACTOR, 60 MINUTES    the ceiling. Keyed on `audit_log.actor_id` and
 *                            NOTHING else — no session, no device — so it cannot
 *                            be reset by acquiring a new session, a new tablet,
 *                            or a new token. The only way to get a fresh budget
 *                            is to be a different person, which is the property
 *                            that was missing.
 *
 * The per-actor tier is reset-proof for a structural reason rather than a careful
 * one: it counts rows in an append-only table that the application role cannot
 * delete, keyed on an identity the caller cannot choose.
 */

import { and, eq, gte, ilike, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { auditLog } from '../db/schema/audit';
import { member } from '../db/schema/member';
import type { StaffPrincipal } from '../auth/principal';
import { badRequest, tooManyRequests } from '../http/errors';
import { writeAudit } from './audit';

/**
 * Two characters. One returns the salon; see the header. Lane D's todo asks for
 * this as a named constant so the spec asserts the rule rather than a literal.
 */
export const MEMBER_SEARCH_MIN_QUERY = 2;
/** A picker, not a report. Twenty is more than a human disambiguates by eye. */
export const MEMBER_SEARCH_LIMIT = 20;
export const MEMBER_SEARCH_WINDOW_MINUTES = 5;
/**
 * Generous for the counter, useless for enumeration. A busy front desk does not
 * make thirty distinct lookups in five minutes; a script trying to walk the name
 * space needs thousands.
 */
export const MEMBER_SEARCH_MAX_PER_WINDOW = 30;

/**
 * THE PER-PERSON CEILING. Sixty lookups in a rolling hour, and the number comes
 * from what a real front desk does rather than from a round figure.
 *
 * WHAT LEGITIMATE USE COSTS. Manual lookup is the FALLBACK for a customer whose
 * phone is flat or whose QR will not read — most customers scan, so most visits
 * spend nothing here. `LookupScreen` debounces and aborts the in-flight request
 * on each keystroke, so finding one customer costs one or two requests, not one
 * per character. A busy salon serving sixty visits across a ten-hour day is six
 * visits an hour; even a pathological hour — the camera is broken and EVERY
 * customer goes through the box — is perhaps ten to twenty lookups, so twenty to
 * forty requests.
 *
 * Sixty an hour is therefore above the broken-camera case and roughly fifteen
 * times ordinary use. It is one lookup a minute sustained for a full hour, which
 * no front desk does with real customers standing in front of it. The window
 * ROLLS, so a receptionist who spends her budget in a bad twenty minutes gets it
 * back continuously rather than at a fixed reset.
 *
 * WHY THE HOURLY TIER IS THE REAL BOUND. The burst tier permits 30 per 5 minutes,
 * which is 360 an hour if sustained — so this is the constraint that actually
 * binds, and the burst tier only shapes the shape of the traffic underneath it.
 * That division is deliberate: the hourly cap does not need headroom for bursts,
 * because it only has to sit above sustained legitimate use.
 *
 * IF THIS EVER FIRES ON REAL WORK it is evidence, not noise — every refusal is
 * preceded by sixty audit rows naming who made them and what they searched for,
 * which is enough to tell a broken scanner from a directory walk. Raise it on
 * that evidence, not on a complaint.
 */
export const MEMBER_SEARCH_ACTOR_WINDOW_MINUTES = 60;
export const MEMBER_SEARCH_ACTOR_MAX_PER_WINDOW = 60;

/** The audit `action`, used both to write the row and to count the window. */
export const MEMBER_LOOKUP_ACTION = 'Customer looked up';

/**
 * What the scanner needs to pick the right person and nothing else.
 *
 * NO BALANCE, NO EMAIL. The screen this feeds is a disambiguation list — the
 * staff member is choosing between two customers called Fatima, then charging
 * the one she picked through the ordinary path, which does its own
 * authorisation. A balance in a list is a balance readable over a shoulder for
 * every customer whose name shares a prefix, and it answers no question the list
 * is asking.
 *
 * The phone is the LAST FOUR DIGITS. It is what distinguishes two identical
 * names, and it is the part a customer will read out to confirm. The whole
 * number is a contact detail the list does not need to hand over.
 */
export interface MemberSearchItem {
  id: string;
  salonId: string;
  name: string;
  phoneLast4: string;
  tier: string | null;
}

function last4(phone: string): string {
  return phone.slice(-4);
}

/**
 * Escape the LIKE metacharacters so a query of `%` is a search for a percent
 * sign rather than a request for the entire customer book. The minimum-length
 * rule above would not have caught `%_` on its own.
 */
function likeLiteral(q: string): string {
  return q.replace(/([\\%_])/g, '\\$1');
}

export async function searchMembers(
  db: Db,
  principal: StaffPrincipal,
  rawQuery: unknown,
  ctx: { ipAddress?: string | null; userAgent?: string | null } = {},
): Promise<MemberSearchItem[]> {
  const q = typeof rawQuery === 'string' ? rawQuery.trim() : '';

  if (q.length < MEMBER_SEARCH_MIN_QUERY) {
    throw badRequest(
      'query_too_short',
      `Type at least ${MEMBER_SEARCH_MIN_QUERY} characters to search.`,
    );
  }

  // ------------------------------------------------------- the rate limits --
  // Counted BEFORE the search runs and before the row is written, so a throttled
  // caller neither reads anything nor inflates the count it is being judged on.
  //
  // ONE QUERY, TWO COUNTS. The hourly window contains the five-minute one, so a
  // single scan bounded by the wider window can answer both with FILTER — two
  // round trips to count rows in the same table for the same actor would be a
  // second chance for the two numbers to disagree about `now`.
  const actorSince = new Date(Date.now() - MEMBER_SEARCH_ACTOR_WINDOW_MINUTES * 60_000);
  const sessionSince = new Date(Date.now() - MEMBER_SEARCH_WINDOW_MINUTES * 60_000);

  const [recent] = await db
    .select({
      // Per SESSION, the burst tier. Two shifts on one account are two sessions
      // and two budgets; a stolen token gets its own, not the staff member's
      // leftovers.
      // `toISOString()` and an explicit cast, not the Date: a bare Date
      // interpolated into a SELECT expression never meets the column's type
      // mapper the way it does inside `where`, and postgres-js is handed an
      // object where it expects a string. Found by the 500 it caused.
      session: sql<number>`count(*) filter (
        where ${auditLog.metadata} ->> 'sessionId' = ${principal.sessionId}
          and ${auditLog.createdAt} >= ${sessionSince.toISOString()}::timestamptz
      )::int`,
      // Per ACTOR, the ceiling. No session and no device in this predicate — that
      // absence IS the control. Re-authenticating changes the session id and the
      // device, and changes nothing here.
      actor: sql<number>`count(*)::int`,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.actorId, principal.id),
        eq(auditLog.action, MEMBER_LOOKUP_ACTION),
        gte(auditLog.createdAt, actorSince),
      ),
    );

  // The ceiling is checked FIRST. When both are exceeded the honest refusal is
  // the one the caller cannot wait out in a moment, and telling her to "wait a
  // moment" when she has an hour to wait sends her back to the box every minute.
  if ((recent?.actor ?? 0) >= MEMBER_SEARCH_ACTOR_MAX_PER_WINDOW) {
    throw tooManyRequests(
      'lookup_hourly_limit',
      'This account has looked up too many customers in the last hour. It will free up shortly.',
    );
  }

  if ((recent?.session ?? 0) >= MEMBER_SEARCH_MAX_PER_WINDOW) {
    throw tooManyRequests(
      'lookup_rate_limited',
      'Too many customer lookups. Wait a moment and try again.',
    );
  }

  // ------------------------------------------------------------ the search --
  // Salon-scoped in the WHERE, not filtered afterwards: a row from another salon
  // is never read, so it cannot be leaked by a later mistake in the mapping.
  const pattern = `%${likeLiteral(q)}%`;
  const digits = q.replace(/\D/g, '');

  const rows = await db
    .select({
      id: member.id,
      salonId: member.salonId,
      name: member.name,
      phone: member.phone,
      tier: member.tier,
    })
    .from(member)
    .where(
      and(
        eq(member.salonId, principal.salonId),
        or(
          ilike(member.name, pattern),
          // Digits only, so "5512" matches "+9655512..." and a staff member does
          // not have to know how the number was stored. Skipped entirely when the
          // query has no digits, or `%%` would match every member in the salon.
          digits.length >= MEMBER_SEARCH_MIN_QUERY
            ? sql`${member.phone} LIKE ${`%${digits}%`}`
            : sql`false`,
          /**
           * THE MEMBER ID, AND IT WAS MISSING.
           *
           * The design's lookup screen offers "name, phone number or member ID"
           * and this clause is the third of those. Without it, typing the number
           * off the customer's card returned nothing: `8842` has digits, so it
           * fell through to the phone branch, and `+96599124408` does not
           * contain `8842`. The staff member's most precise identifier was the
           * one query that failed, which reads as "she isn't a member here".
           *
           * EXACT, NOT A SUBSTRING, and that is the disclosure decision. `%88%`
           * over an id column enumerates the salon's membership in a way a name
           * fragment does not — ids are short, dense and sequential, so a
           * substring match turns a two-character minimum into a directory walk.
           * A staff member reading a number off a card has the whole number, so
           * exactness costs her nothing and removes the vector.
           *
           * Case-insensitive because ids are not all numeric: the fixtures carry
           * `B-9001`, and a front desk types `b-9001`.
           */
          sql`lower(${member.id}) = lower(${q})`,
        ),
      ),
    )
    .limit(MEMBER_SEARCH_LIMIT);

  // ------------------------------------------------------------- the audit --
  // Written whether or not anything matched. A search that found nothing still
  // happened, and "who did she look for" is the question the log is kept for.
  //
  // The QUERY is recorded, the RESULTS are not. The query is what the staff
  // member did; copying the matched customers into an append-only seven-year log
  // would build a second customer list inside the audit trail.
  await writeAudit(db, principal, {
    salonId: principal.salonId,
    kind: 'access',
    action: MEMBER_LOOKUP_ACTION,
    detail: `Searched customers for "${q}"`,
    source: 'scanner',
    subjectType: 'member_search',
    subjectId: null,
    metadata: { query: q, results: rows.length, sessionId: principal.sessionId },
    ipAddress: ctx.ipAddress ?? null,
    userAgent: ctx.userAgent ?? null,
  });

  return rows.map((r) => ({
    id: r.id,
    salonId: r.salonId,
    name: r.name,
    phoneLast4: last4(r.phone),
    tier: r.tier,
  }));
}
