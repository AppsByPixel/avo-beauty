/**
 * THE MERCHANT'S CUSTOMER DIRECTORY — Accounts § Customers, and its controls.
 *
 * Aftab, item 2 of six: *"Customer accounts list and they can check their history
 * and stuff."* The screen is `design/AVO Merchant Dashboard.dc.html` § Accounts,
 * whose own hint reads "Open a customer to see their profile, activity and
 * purchases". There was no API behind it at all: `apps/dashboard/src/routes/
 * Accounts.tsx` is the TEAM tab — `perms.team`, `GET /staff` — and the only
 * customer directory in this codebase is the SCANNER'S, which a merchant session
 * provably cannot reach (`routes/members.ts § requireDirectoryScanner` accepts
 * `p.scope === 'scanner' && p.perms.scanner` and audits everything else as `risk`).
 *
 * =========================================================================
 * THE PERMISSION IS `team`, AND THE CODEBASE HAD ALREADY DECIDED IT
 * =========================================================================
 * `services/reports.ts § REPORT_PERMISSION` maps the `customers` report — "Profiles,
 * tier and wallet balance", one row per active member with NAME, PHONE, TIER and
 * WALLET BALANCE — to `team`, and spends a paragraph on why. Three things make that
 * the answer here rather than merely a precedent worth matching.
 *
 * FIRST, IT IS THE SAME DATA AT THE SAME GRAIN. Not analogous data: the CSV's four
 * columns are four of the six this list serves. A directory gated LOOSER than the
 * export of itself is a hole with a decision already written against it. A
 * directory gated STRICTER is theatre of the exact kind `earnings-by-branch`
 * refused — "a gate somebody can walk around one card to the left is worse than no
 * gate, because it reads as a control" — because the merchant simply pulls the CSV.
 * The two must be equal, and `team` is where the CSV already is.
 *
 * SECOND, THE POSITIVE ARGUMENT, WHICH DOES NOT RELY ON THE CSV AT ALL.
 * reports.ts: "`dashboard` is the wider grant: it is the permission that opens the
 * Overview, so it is the one a salon hands out to anybody who needs to see how the
 * business is doing, while `team` is the authority over its people. A customer's
 * name, phone and wallet balance is the second kind of data." That sentence was
 * written about this file's contents.
 *
 * THIRD, THE OBJECTION, TAKEN SERIOUSLY. `team` nominally means "staff and roster",
 * so inheriting it for CUSTOMERS looks like borrowing a gate because it is nearby.
 * It is not, and the chip settles it: the design labels it **"Team & accounts"**,
 * and the section it opens has TWO tabs — Team and Customers. The permission is
 * named after the section, the section contains the customer book, and reports.ts
 * already relied on exactly that reading when it wrote "Accounts § Customers IS the
 * customer book this exports". Nobody gains a capability here who could not already
 * open Accounts and read the same rows.
 *
 * WHAT IS STILL WRONG, AND IS NOT THIS LANE'S TO FIX. `team` now gates the roster,
 * the customer book, artist earnings and this directory, which is three things too
 * many for one name — the same complaint `auth/principal.ts § StaffPerms.loyalty`
 * records against itself and escalates as "the honest name for this gate is
 * `perms.settings`". A tenth permission is a `packages/types` change, which is
 * trunk-owned and a four-way break. Reported, not taken.
 *
 * =========================================================================
 * THE SCANNER'S FOUR CONTROLS, ONE AT A TIME
 * =========================================================================
 * `services/memberSearch.ts` opens with "A STAFF-FACING SEARCH BOX IS A CUSTOMER-LIST
 * EXPORT UNLESS YOU STOP IT" and names four controls. A merchant directory is a
 * BROADER surface than a till — it LISTS where the scanner LOOKS UP — so each is
 * decided here rather than inherited, and one of the four is deliberately dropped.
 *
 * ---- 1. SALON SCOPING — CARRIED, AND DOUBLED --------------------------------
 * Every read here is `eq(member.salonId, principal.salonId)` in the WHERE, so a row
 * from another salon is never read and cannot be leaked by a later mistake in a
 * mapping. The routes ALSO call `requireSameSalon` on the path segment, which is
 * the doubling `routes/activity.ts` and `routes/audit.ts` already practise: if the
 * guard were ever loosened, the predicate would still be right.
 *
 * ---- 2. MINIMUM QUERY LENGTH — DROPPED, AND THIS IS THE REAL DECISION --------
 * The scanner refuses a query under two characters because "`%a%` returning the
 * customer book is exactly the failure the limit prevents". THAT FAILURE IS THIS
 * ENDPOINT'S FEATURE. A directory's resting state, with no query at all, IS the
 * customer book — paginated, but the whole of it. A two-character minimum in front
 * of a list that already renders unfiltered would refuse a one-letter filter while
 * the thing it is protecting sits open behind it: a control that costs a merchant
 * a keystroke and an attacker nothing.
 *
 * So it is dropped rather than weakened, because the honest reason is that the
 * property it defends is not available to defend. What actually bounds disclosure
 * here is the page size, the ceiling below, and the fact that every page leaves a
 * row naming who asked.
 *
 * ---- 3. RATE LIMIT — CARRIED, RE-KEYED, RE-SIZED, AND NOT SHARED ------------
 * `enforceCustomerDirectoryLimit` below. Three departures from the scanner's, each
 * for its own reason; the technique — count rows in the append-only audit log the
 * application role cannot delete, keyed on an identity the caller cannot choose —
 * is copied exactly, because it is the part that is right.
 *
 *   ONE TIER, NOT TWO. The scanner carries a per-SESSION burst tier to "shape a
 *   frantic minute at one counter", and says of it that it "was, on its own, not a
 *   limit" because re-authenticating mints a fresh budget. A dashboard session is
 *   one person at a laptop: there is no burst shape to protect, so the tier that
 *   survives is the reset-proof one, and the one that does not is the one
 *   memberSearch already describes as not being a limit.
 *
 *   ITS OWN BUDGET, NOT THE SCANNER'S. `DIRECTORY_READ_ACTIONS` welds the scanner's
 *   search and resolve into one ceiling on the sound argument that "the thing being
 *   protected is the customer DIRECTORY, not one endpoint". That argument does not
 *   reach across this boundary, and joining the budgets would be actively harmful:
 *   the scanner's 240/hour was MEASURED against a queue of flat-phone customers, and
 *   memberSearch's own warning is that a limit "would have fired at a counter with a
 *   customer standing there, which is the one thing it must not do". A manager
 *   browsing the back office must not be able to starve the till. The doors are also
 *   genuinely different — a device-bound PIN session holding `perms.scanner` versus
 *   a web session holding `perms.team` — so exhausting one does not open the other.
 *   Where one person holds both, she has two budgets, which is honest: she has two
 *   jobs.
 *
 *   AND WHAT THE CEILING IS HONESTLY FOR. Not bulk extraction of the LIST: the same
 *   permission exports every active customer's name, phone, tier and balance in ONE
 *   audited request, so a limit here that claimed to prevent that would be the
 *   theatre described above. What it genuinely bounds is machine-speed walking of
 *   the DETAIL and HISTORY reads, which disclose a named customer's wallet and her
 *   money movements — and which the CSV does not contain at any page count. That is
 *   new disclosure, it is per-customer, and it is what the number is sized against.
 *
 * ---- 4. AUDIT ROW — CARRIED WHOLE, INCLUDING THE TWO SUBTLE PARTS -----------
 * Both of the scanner's non-obvious rules survive unchanged, because both answer
 * questions that do not depend on which surface asked:
 *
 *   THE QUERY IS RECORDED, THE RESULTS ARE NOT. `CUSTOMER_LIST_ACTION` stores what
 *   was typed and HOW MANY rows came back, never which customers matched —
 *   "copying the matched customers into an append-only seven-year log would build a
 *   second customer list inside the audit trail". The one read that names a
 *   customer is the one that actually disclosed her, and that is the detail.
 *
 *   A READ THAT FOUND NOBODY IS STILL WRITTEN, AND WRITTEN BEFORE THE REFUSAL. An
 *   attempt on a member id that is not in this salon is "the single most interesting
 *   line in this log — it is what a directory walk looks like from the inside", so
 *   the row goes down before `notFound` is thrown.
 *
 * The REFUSAL row reuses the scanner's own `DIRECTORY_REFUSED_ACTION` rather than
 * minting a second name, because "who tried to reach the customer directory without
 * the authority to" is ONE question and should answer to one filter. The metadata
 * already carries `permission` and `scope`, which is what tells the two surfaces
 * apart.
 */

import { and, eq, gte, ilike, inArray, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { auditLog } from '../db/schema/audit';
import { member } from '../db/schema/member';
import type { StaffPrincipal } from '../auth/principal';
import { tooManyRequests } from '../http/errors';
import { serialiseMemberContact } from '../http/serialise';
import { likeLiteral } from './memberSearch';

/**
 * ONE FIXED PAGE, AND NO `?limit=`.
 *
 * The scanner's twenty is "a picker, not a report — more than a human
 * disambiguates by eye". This is a browsable list rather than a picker, so it is
 * larger; it is FIXED rather than client-chosen because a cursor already gives a
 * client everything a limit would, and a knob that only ever widens disclosure is a
 * knob worth not having. `?limit=1000` is then not a request anybody can make.
 */
export const CUSTOMER_PAGE_SIZE = 25;

/**
 * The shortest digit run that is plausibly a phone fragment rather than noise.
 * The scanner's `MEMBER_SEARCH_MIN_QUERY` is the same number for the same reason;
 * it is named separately because it means something different here — see
 * `customerSearchPredicate`, where the length is the smaller half of the rule.
 */
export const CUSTOMER_PHONE_MIN_DIGITS = 2;

/**
 * ============================================================================
 * THE CEILING, AND THE ARITHMETIC UNDER IT.
 * ============================================================================
 * memberSearch's first pair of numbers rested on an estimate and the estimate was
 * wrong, so this one is built from the screen's actual request shape instead.
 *
 * WHAT ONE PIECE OF REAL WORK COSTS. Opening the Accounts § Customers tab is one
 * LIST request. Typing in the search box is one more per settled query. Opening a
 * customer draws the profile card AND the activity list beside it, which is two
 * requests — the detail and the history — and paging her history is one more each.
 * So:
 *
 *     open the tab, scroll two pages                        3
 *     search, then open one customer                        1 + 2 =  3
 *     open a customer and read a year of her history        2 + 3 =  5
 *
 * A HEAVY HOUR. A manager reconciling her book — search, open, read the history,
 * move on — spends about 4 requests a customer and can get through perhaps 20
 * customers an hour at that depth. Call it 80, and 120 with a share of paging.
 *
 *   300 an hour is 2.5x that, and it is the only tier, so nothing shorter can fire
 *   on a merchant mid-task. The window ROLLS, so a heavy twenty minutes refills
 *   continuously rather than locking the hour.
 *
 * WHAT IT BUYS, HONESTLY. Not protection of the list — see § 3 above, the CSV hands
 * that over in one request at this same permission. It bounds walking the DETAIL at
 * machine speed: 300 requests is at most 150 customers' wallets and histories in an
 * hour, and every one of those 300 leaves an append-only row naming who read it. A
 * refusal is therefore preceded by 300 lines of evidence, which is the condition
 * memberSearch names for raising a limit on evidence rather than on feel.
 */
export const CUSTOMER_DIRECTORY_WINDOW_MINUTES = 60;
export const CUSTOMER_DIRECTORY_MAX_PER_WINDOW = 300;

/** Listed the book, or filtered it. The QUERY is stored; the matches are not. */
export const CUSTOMER_LIST_ACTION = 'Customer directory listed';
/** Opened ONE customer's card. This is the row that names her. */
export const CUSTOMER_OPEN_ACTION = 'Customer profile opened';
/** Read ONE customer's money. Separate, because it is a different disclosure. */
export const CUSTOMER_HISTORY_ACTION = 'Customer history read';

/**
 * ALL THREE SHARE ONE CEILING, for `DIRECTORY_READ_ACTIONS`' reason applied inside
 * this surface: the thing protected is the merchant's view of the customer
 * directory, not one of its three endpoints. A detail read metered separately from
 * the list — or not at all — would let someone exhaust the list and keep walking
 * ids through the profile, which is the enumeration hole reopened from the next
 * door along.
 */
export const CUSTOMER_DIRECTORY_ACTIONS = [
  CUSTOMER_LIST_ACTION,
  CUSTOMER_OPEN_ACTION,
  CUSTOMER_HISTORY_ACTION,
] as const;

/**
 * The ceiling, enforced for any merchant directory read.
 *
 * Counted BEFORE anything is read and before any row is written, so a throttled
 * caller neither reads anything nor inflates the count she is being judged on —
 * `enforceDirectoryReadLimits`' ordering, and it matters for the same reason.
 *
 * KEYED ON `actor_id` AND NOTHING ELSE. No session, no device: that absence IS the
 * control. Signing in again changes the session id and changes nothing here, so the
 * only way to get a fresh budget is to be a different person.
 */
export async function enforceCustomerDirectoryLimit(
  db: Db,
  principal: StaffPrincipal,
): Promise<void> {
  const since = new Date(Date.now() - CUSTOMER_DIRECTORY_WINDOW_MINUTES * 60_000);

  const [recent] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.actorId, principal.id),
        inArray(auditLog.action, [...CUSTOMER_DIRECTORY_ACTIONS]),
        gte(auditLog.createdAt, since),
      ),
    );

  if ((recent?.n ?? 0) >= CUSTOMER_DIRECTORY_MAX_PER_WINDOW) {
    throw tooManyRequests(
      'customer_directory_limit',
      'This account has opened too many customer records in the last hour. It will free up shortly.',
    );
  }
}

/**
 * THE SEARCH PREDICATE, or `undefined` for "the whole book".
 *
 * `undefined` rather than a tautology so an absent `q` adds nothing to the WHERE at
 * all — the same property `parseCalendarRange` gives an absent range, and it is
 * what makes "no filter issues the query it issued before the filter existed" a
 * fact about the code rather than a hope.
 *
 * THE THREE CLAUSES ARE THE SCANNER'S, and they are matched deliberately: a
 * merchant and a receptionist typing the same thing into two search boxes must not
 * get different answers about whether a customer exists. Name substring;
 * digits-only against the phone so "5512" finds "+9655512…" without the staff
 * member knowing how it was stored; and the member id EXACT, not a substring,
 * because ids are short and dense and `%88%` over an id column is a directory walk
 * rather than a search. `likeLiteral` is imported rather than rewritten — a LIKE
 * escape that exists twice is a LIKE escape that is wrong in one place.
 *
 * ==========================================================================
 * THE PHONE CLAUSE ONLY FIRES FOR SOMETHING THAT LOOKS LIKE A PHONE NUMBER,
 * AND THAT IS A DEPARTURE FROM THE SCANNER THAT A TEST FOUND.
 * ==========================================================================
 * The first version of this function copied the scanner's rule — extract the
 * digits from the query, and if any survive, match them against the phone. It went
 * red on a spec that searched for a MEMBER ID and got back two strangers.
 *
 * WHY. A member id is not all digits. `AC-L-muhu7p8omx` has two digits buried in
 * it, so `replace(/\D/g, '')` yields `78`, and `phone LIKE '%78%'` matches a large
 * share of any salon's book. A merchant reading a number off a customer's card and
 * typing it in would get that customer AND everyone whose phone happens to contain
 * whatever digits her id contained — the one query that should be exact, answered
 * with a crowd.
 *
 * THE RULE: NO LETTERS IN THE QUERY. A phone number is digits, spaces, `+`, `-`
 * and brackets; a name and an alphanumeric id are not. So a query containing any
 * letter is a name-or-id query and the phone clause is skipped, while `5512`,
 * `+965 5512` and `965-5512` all still reach it. That is more precise than a
 * length threshold, which only moves the boundary rather than removing the
 * confusion.
 *
 * THE FLOOR SURVIVES AT TWO DIGITS, which is the scanner's number and is kept for
 * its reason: `%` over a one-digit fragment is not a search. It is not a disclosure
 * control here — the no-query state is already the whole list — it is a guard
 * against an answer nobody can use.
 *
 * THE SCANNER HAS THE SAME LATENT BEHAVIOUR AND IS DELIBERATELY NOT CHANGED.
 * `searchMembers` will extract `9001` from the fixture id `B-9001` and run the same
 * phone match beside the exact-id one, so a receptionist typing a card number sees
 * the same crowd. It is a live surface with its own specs and its own 20-row cap,
 * and altering how a till's search box behaves is not something to do in passing
 * from another endpoint's slice. REPORTED, not taken.
 */
export function customerSearchPredicate(rawQuery: unknown) {
  const q = typeof rawQuery === 'string' ? rawQuery.trim() : '';
  if (q === '') return undefined;

  const digits = q.replace(/\D/g, '');
  const looksLikeAPhone = !/\p{L}/u.test(q) && digits.length >= CUSTOMER_PHONE_MIN_DIGITS;

  return or(
    ilike(member.name, `%${likeLiteral(q)}%`),
    looksLikeAPhone ? sql`${member.phone} LIKE ${`%${digits}%`}` : sql`false`,
    /**
     * EXACT, NOT A SUBSTRING — the scanner's disclosure decision, and it holds here
     * too. Ids are short, dense and sequential, so `%88%` over an id column is a
     * directory walk rather than a search. A merchant reading a number off a card
     * has the whole number, so exactness costs her nothing.
     */
    sql`lower(${member.id}) = lower(${q})`,
  );
}

/** What the trimmed query actually was, for the audit row and nothing else. */
export function normaliseCustomerQuery(rawQuery: unknown): string {
  return typeof rawQuery === 'string' ? rawQuery.trim() : '';
}

/**
 * ==========================================================================
 * ONE CUSTOMER, ON THE WIRE — AND THE ERASED ONE IS A REAL STATE.
 * ==========================================================================
 * `services/erasure.ts` cannot clear `member.phone`: it is NOT NULL, E.164-CHECKed
 * and unique per salon, so erasure overwrites it with `+990` and twelve random
 * digits. DECISIONS.md #100 is what happened when three merchant reads served that:
 * lane C's fulfilment board rendered `href="tel:+990224285141169"` beside a row
 * reading "Deleted account", and the scanner's My Bookings turned the same digits
 * into a `tel:` AND a `https://wa.me/` button — a surface that does not merely
 * display the fake number, it messages it. Lane C then hit it a second time on
 * bookings. This is a fourth merchant read that joins `member` for a phone, and
 * `http/serialise.ts` says in as many words what that means: it calls
 * `serialiseMemberContact` or it repeats the bug.
 *
 * SO THE FIELD NAMES ARE `memberErased` AND `memberPhone`, MATCHING
 * `MemberContactWire` EXACTLY rather than being shortened to `erased`/`phone` for a
 * shape that is about a member already. Lane C has already written the render for
 * that pair twice; naming it anything else would ask for a third implementation of
 * the same decision, which is the duplication this whole mechanism exists to stop.
 *
 * THE TYPE MAKES THE CALLER DECIDE. `memberPhone: string | null` cannot be rendered
 * into a `tel:` without the client confronting the null, and `memberErased` is what
 * lets the copy beside it be honest — `null` alone cannot tell "erased" from "never
 * gave us one", and a client cannot write true copy from a hole. Deriving it from
 * `erased_at` rather than from the shape of the number is the other half: a
 * `startsWith('+990')` test anywhere is a client-side erasure predicate built on a
 * constant it does not own.
 *
 * `email` IS SERVED RAW AND THAT IS NOT AN OVERSIGHT. Erasure sets `email: null` at
 * rest — it is nullable, so unlike the phone it can simply be cleared — so there is
 * no tombstone to keep off the wire and a second gate here would imply a leak that
 * the schema forecloses. The phone is the one column erasure could not clear, which
 * is exactly why it is the one with a serialiser.
 *
 * `name` STAYS THE TOMBSTONE, unchanged, for `serialiseMemberContact`'s own stated
 * reason: `TOMBSTONE_NAME` is already a display-safe string every consuming surface
 * renders as-is.
 *
 * THE ERASED MEMBER IS NOT HIDDEN FROM THE DIRECTORY, and that is a decision rather
 * than a default. Her transactions are financial records the retention schedule
 * keeps for seven years, so a merchant reconciling a charge has to be able to reach
 * the row it belongs to; a directory that dropped her would make a settled charge
 * trace to a customer who cannot be opened. She appears, flagged, with nothing
 * erasure took.
 */
export interface CustomerListItem {
  id: string;
  name: string;
  /** Non-null `erased_at`. The only tell, and the caller's to act on. */
  memberErased: boolean;
  /** Null for an erased member — never the `+990` tombstone. */
  memberPhone: string | null;
  tier: string | null;
  /** Integer fils. Formatted to three decimals at the display boundary, not here. */
  balanceFils: number;
  visits: number;
  joinedAt: string;
}

export interface CustomerDetail extends CustomerListItem {
  salonId: string;
  /** Erasure nulls this at rest; see the header for why it needs no serialiser. */
  email: string | null;
  emailVerified: boolean;
  /** Null at a tiers salon, a count at a stamps salon. Never defaulted. */
  stamps: number | null;
}

/** The columns both shapes read. One select list, so the two cannot drift apart. */
export type CustomerRow = typeof member.$inferSelect;

export function serialiseCustomerListItem(m: CustomerRow): CustomerListItem {
  /**
   * ONE derivation of the erasure, destructured — not `m.erasedAt !== null` here
   * and `serialiseMemberContact` there. Two tests of the same fact in one function
   * is how they start disagreeing.
   */
  const { memberErased, memberPhone } = serialiseMemberContact(m);
  return {
    id: m.id,
    name: m.name,
    memberErased,
    memberPhone,
    tier: m.tier,
    balanceFils: m.balanceFils,
    visits: m.visits,
    joinedAt: m.joinedAt.toISOString(),
  };
}

export function serialiseCustomerDetail(m: CustomerRow): CustomerDetail {
  return {
    ...serialiseCustomerListItem(m),
    salonId: m.salonId,
    email: m.email,
    emailVerified: m.emailVerified,
    stamps: m.stamps,
  };
}
