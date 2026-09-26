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

import { and, eq, gte, ilike, inArray, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { auditLog } from '../db/schema/audit';
import { member } from '../db/schema/member';
import type { StaffPrincipal } from '../auth/principal';
import { badRequest, notFound, tooManyRequests } from '../http/errors';
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
 * ============================================================================
 * BOTH CEILINGS COME FROM A MEASUREMENT. THE FIRST PAIR CAME FROM AN ESTIMATE,
 * AND THE ESTIMATE WAS WRONG.
 * ============================================================================
 *
 * The original numbers (30 per 5 minutes, 60 per hour) rested on the claim that
 * `LookupScreen`'s debounce makes one customer cost "one or two requests". Lane D
 * objected that 60 an hour is one lookup a minute and that a queue of flat-phone
 * customers is the case this endpoint exists for. Lane D was right, for two
 * reasons the estimate missed.
 *
 * FIRST, AN ABORT DOES NOT UN-SEND. `LookupScreen` calls `inflight.abort()` on
 * each keystroke, and the estimate treated that as if it prevented a request. It
 * does not: it stops the CLIENT waiting for a reply that is already on its way,
 * and the server has already handled it and written its audit row. Every request
 * that leaves the tablet costs budget whether the client still wants the answer or
 * not.
 *
 * SECOND, THE RESOLVE DOUBLED THE COST PER CUSTOMER. `GET /members/{id}` now
 * counts against the same budget — correctly, see DIRECTORY_READ_ACTIONS — so a
 * receptionist who searches and then opens each customer spends one more request
 * per customer than the estimate assumed.
 *
 * MEASURED, by replaying LookupScreen's own debounce (300ms, reset per keystroke,
 * minimum 3 characters) at realistic typing speeds against the real endpoint and
 * counting the audit rows the SERVER wrote:
 *
 *     fluent typer, knows the name            1 search + 1 resolve =  2
 *     normal typing speed                     1 search + 1 resolve =  2
 *     hunt-and-peck, glances at the screen     2 searches + 1 resolve = 3
 *     typo then correction                    3 searches + 1 resolve = 4
 *     deliberate, pauses over each key        4 searches + 1 resolve = 5
 *
 * So a customer costs 2 requests at best and 5 at worst, not 1-2. Call a difficult
 * one — a name spelled differently than she says it, two or three search rounds —
 * 7 or 8.
 *
 * THE ARITHMETIC. The case to survive is the camera being broken with a queue: one
 * front desk can process perhaps 20 customers an hour that way, three minutes each
 * including the charge. At the worst measured profile that is 20 x 5 = 100 requests
 * an hour, and with a share of difficult customers about 140.
 *
 *   240 an hour is 1.7x that worst realistic hour, and 48 customers an hour at the
 *   worst profile — more than double what one counter can physically serve.
 *   The old 60 fired at TWELVE customers an hour. It would have fired at a counter
 *   with a customer standing there, which is the one thing it must not do.
 *
 *   60 per 5 minutes is 12 customers in five minutes at the worst profile, which is
 *   25 seconds a customer — impossible with real people. The old 30 fired at six
 *   customers in five minutes, and a queue of five plus one difficult lookup
 *   reaches 33.
 *
 * The hourly tier still binds and the burst tier still shapes: 60 per 5 minutes
 * would be 720 an hour if sustained, so 240 is the real constraint underneath it.
 * The window ROLLS, so a bad twenty minutes refills continuously.
 *
 * WHAT THIS DOES AND DOES NOT BUY, honestly. 240 an hour does not stop a
 * determined insider reading her OWN salon's book slowly — at 20 rows a response
 * it never could, and the tenant predicate already limits her to the customers she
 * legitimately works with. What it bounds is bulk extraction at machine speed, and
 * what it guarantees is attribution: every one of those 240 requests leaves an
 * audit row naming her, and the resolve rows name the customer. Generosity plus a
 * complete trail is worth more here than a tight limit that fires on real work and
 * teaches a salon that AVO breaks at the counter.
 *
 * RAISE THESE ON EVIDENCE, and the evidence exists by construction: a refusal is
 * preceded by 240 rows saying who searched for what.
 */
export const MEMBER_SEARCH_MAX_PER_WINDOW = 60;
export const MEMBER_SEARCH_ACTOR_WINDOW_MINUTES = 60;
export const MEMBER_SEARCH_ACTOR_MAX_PER_WINDOW = 240;

/** The audit `action`, used both to write the row and to count the window. */
export const MEMBER_LOOKUP_ACTION = 'Customer looked up';

/**
 * The audit `action` for resolving ONE member by id — `GET /members/{id}`, the
 * step between finding her in the list and charging her.
 *
 * A DIFFERENT ACTION, DELIBERATELY, because it is a different event and the log is
 * read by people asking different questions. "Searched customers for Fatima" says
 * what she typed; "Opened customer 8842" names who was actually looked at, which
 * the search row cannot — a search records the query and never the results, on
 * purpose, so that the audit trail does not become a second copy of the customer
 * book. The resolve is where a specific customer's name enters the log, and it
 * belongs there: it is the read that actually disclosed her.
 */
export const MEMBER_RESOLVE_ACTION = 'Customer opened';

/**
 * BOTH ACTIONS SHARE ONE CEILING, AND THAT IS THE POINT.
 *
 * The thing being protected is the customer DIRECTORY, not one endpoint. A resolve
 * discloses strictly more than a search row does — the full phone, the email, the
 * balance — so a resolve counted separately, or not at all, would reopen the
 * enumeration hole that was just closed, from a different door: exhaust the search
 * budget, then keep walking ids through the resolve.
 *
 * So the limiter counts directory READS, whichever endpoint performed them.
 */
export const DIRECTORY_READ_ACTIONS = [MEMBER_LOOKUP_ACTION, MEMBER_RESOLVE_ACTION] as const;

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
 *
 * EXPORTED, for `services/customerDirectory.ts` — the merchant's Accounts §
 * Customers list. That is a different surface with its own permission, its own
 * ceiling and no minimum length at all, but the same LIKE. A second copy of this
 * one-line escape is a second place for it to be wrong, and the failure it prevents
 * is silent: an unescaped `%` does not throw, it returns the book.
 */
export function likeLiteral(q: string): string {
  return q.replace(/([\\%_])/g, '\\$1');
}

/**
 * The two ceilings, enforced for any directory read.
 *
 * Called by BOTH `searchMembers` and `resolveMember` and counting the rows of
 * both, because the thing being protected is the customer directory rather than
 * one endpoint. Extracted when the resolve arrived: a second copy of this, or a
 * resolve that skipped it, would have reopened the enumeration path from a
 * different door.
 *
 * Counted BEFORE anything is read and before any row is written, so a throttled
 * caller neither reads anything nor inflates the count it is being judged on.
 */
export async function enforceDirectoryReadLimits(
  db: Db,
  principal: StaffPrincipal,
): Promise<void> {
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
        // Both actions, so a search and a resolve draw on one budget.
        inArray(auditLog.action, [...DIRECTORY_READ_ACTIONS]),
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

  await enforceDirectoryReadLimits(db, principal);

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

/**
 * Resolve ONE member for a staff caller — the step between finding her in the
 * lookup list and charging her.
 *
 * Without this the manual path was a dead end at its last step: the search returns
 * `{id, salonId, name, phoneLast4, tier}`, deliberately narrow, and nothing turned
 * that id into the envelope the counter needs. "Can't scan?" led to a row the
 * scanner could display and could not act on, in the exact situation the fallback
 * exists for — a customer standing at the counter with a flat phone.
 *
 * THE TENANT PREDICATE IS IN THE `WHERE`, and the refusal for another salon's
 * member is `404 unknown_member` — byte-identical to a member that does not exist.
 * A distinct 403 would confirm that the id is real, which turns this endpoint into
 * an oracle for "is 8842 a customer somewhere in AVO" even when it refuses to say
 * more. That is the same reasoning `POST /scans` records for its own two reads.
 *
 * IT COUNTS AGAINST THE DIRECTORY CEILING, and that is not belt-and-braces. This
 * discloses strictly more than a search row does — the full phone, the email, the
 * balance, the visit count — so an unmetered resolve would let someone exhaust the
 * search budget and then keep walking ids here, reopening the enumeration hole
 * from a different door. See DIRECTORY_READ_ACTIONS.
 *
 * THE AUDIT ROW NAMES HER, unlike the search row. A search records the query and
 * never the results, so the log does not become a second copy of the customer
 * book; this is the read that actually disclosed one specific customer, so this is
 * where her id belongs.
 */
export async function resolveMember(
  db: Db,
  principal: StaffPrincipal,
  rawId: unknown,
  ctx: { ipAddress?: string | null; userAgent?: string | null } = {},
): Promise<typeof member.$inferSelect> {
  const id = typeof rawId === 'string' ? rawId.trim() : '';
  if (id === '') throw badRequest('invalid_request', 'A member id is required.');

  await enforceDirectoryReadLimits(db, principal);

  const rows = await db
    .select()
    .from(member)
    .where(and(eq(member.id, id), eq(member.salonId, principal.salonId)))
    .limit(1);
  const m = rows[0];

  /**
   * Written whether or not she was found, and BEFORE the refusal is thrown. An
   * attempt on an id that is not in this salon is the single most interesting line
   * in this log — it is what a directory walk looks like from the inside — and a
   * log that recorded only successful reads would omit exactly the evidence.
   */
  await writeAudit(db, principal, {
    salonId: principal.salonId,
    kind: 'access',
    action: MEMBER_RESOLVE_ACTION,
    detail: m ? `Opened ${m.name}` : `Attempted an id not in this salon: ${id}`,
    source: 'scanner',
    subjectType: 'member',
    subjectId: m?.id ?? null,
    metadata: { requestedId: id, found: Boolean(m), sessionId: principal.sessionId },
    ipAddress: ctx.ipAddress ?? null,
    userAgent: ctx.userAgent ?? null,
  });

  if (!m) throw notFound('unknown_member', 'No such member.');
  return m;
}

/**
 * The audit `action` for a directory read that was REFUSED before it happened.
 *
 * A separate action from the two successful ones, because it answers a different
 * question: not "who did she look at" but "who tried to reach the directory without
 * the authority to". `kind: 'risk'` rather than `'access'` for the same reason —
 * nothing was accessed. See routes/members.ts § requireDirectoryScanner for where
 * the line between a logged refusal and unlogged noise is drawn.
 */
export const DIRECTORY_REFUSED_ACTION = 'Customer directory access refused';
