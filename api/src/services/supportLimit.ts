/**
 * Per-member budget for `POST /v1/support/tickets`.
 *
 * api-contract.md § SupportTicket rule 5 is TWO rules and only one of them was
 * built: "Rate-limit per member. Deduplicate an identical message inside 5 minutes
 * rather than opening a second ticket." The dedupe has been there since the
 * endpoint was written; the limiter had no implementation and no 429 anywhere in
 * the file. Reported by trunk out of Lane D's reading, and this is that half.
 *
 * `signupLimit.ts` and `passwordResetLimit.ts` are the precedents and their headers
 * carry the shared reasoning — one query for two counts, the wider ceiling checked
 * first, `count(*) filter` with an explicit `::timestamptz` cast because a bare
 * `Date` in a SELECT expression never meets the column's type mapper. Three things
 * are DIFFERENT here, and each is the reason this is not a copy of either.
 *
 * ================= 1. THERE IS NO ATTEMPT TABLE, AND NONE IS NEEDED =================
 *
 * Both siblings key on `req.ip` and count rows in a table that exists only to be
 * counted, because their endpoints are UNAUTHENTICATED and have no identity to key
 * on. This endpoint is `requireMember`: the contract says "per member", the caller
 * is a verified member, and `support_ticket` already carries `(member_id,
 * created_at DESC)` as an index — `support_ticket_member_created_idx`, added for
 * her own ticket history. So the queue is its own counter. A fourth attempt table
 * would be a second place the same fact is written, which is the defect
 * `routes/salons.ts` records against the tier ladder.
 *
 * ================= 2. WHAT IS RATIONED IS ROWS, NOT WORK =================
 *
 * Signup rations an argon2 hash and therefore counts REFUSALS: "a refusal is an
 * attempt: it consumed the endpoint and it learned something." Neither clause is
 * true here. A refused ticket does one indexed `SELECT` on `support_topic` and
 * learns nothing — the topic list is served to every authenticated principal by
 * `GET /v1/platform/support` — and the caller cannot forge her identity, so there
 * is no enumeration to bound. What rule 5 protects is a STAFFED QUEUE from being
 * filled by one member, and a request that creates no ticket does not fill it.
 *
 * The consequence, stated rather than left to be discovered: a member can send
 * malformed bodies indefinitely without spending budget. That is one indexed read
 * per request from an authenticated, attributable caller, which is a different and
 * much smaller problem than the one this file addresses. If it ever needs bounding
 * it needs an attempt table, and then the siblings' shape is the right one.
 *
 * ================= 3. IT RUNS AFTER THE DEDUPE, NOT FIRST =================
 *
 * `passwordResetLimit.ts` enforces "before anything — before the phone is even
 * parsed", because for an unauthenticated endpoint the posture settles before any
 * statement about content. That ordering is WRONG here and the reason is rule 5's
 * own other half: the dedupe answers a double-tapped Send by returning the ticket
 * that already exists, creating nothing. A limiter in front of it would charge her
 * for the second tap, and a customer who pressed one button twice would be told to
 * wait — the endpoint refusing a gesture it was specifically built to absorb.
 *
 * So the order in the handler is: identity, body, topic, dedupe, THEN this, then
 * the insert. The check sits immediately before the only statement that can add a
 * row, which is exactly the statement being rationed.
 *
 * CONSTANTS, NOT ENV, on `passwordResetLimit.ts`'s argument: launch traffic is a
 * genuine unknown for signup and is not for this. A person writes to support a
 * handful of times a year, and the numbers below are generous against that while
 * still bounding a flood — five distinct messages in a quarter of an hour is
 * already somebody with several separate problems.
 */

import { and, eq, gte, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { supportTicket } from '../db/schema/legal';
import { tooManyRequests } from '../http/errors';

export const TICKET_WINDOW_MINUTES = 15;
export const TICKET_MAX_PER_WINDOW = 5;
export const TICKET_MAX_PER_HOUR = 12;

/**
 * Refuse if this member has already filled her share of the queue.
 *
 * NOT SCOPED TO THE SALON, deliberately. `member.id` is unique across the product
 * and one member row belongs to exactly one salon, so a salon predicate would be a
 * second statement of a fact the id already carries — and a member who holds
 * wallets at two salons holds two DIFFERENT member rows (`member_salon_phone_uq`
 * is on `(salon_id, phone)`), so she legitimately gets a budget at each. That is
 * the same reading of identity `POST /auth/member/session` takes.
 */
export async function enforceTicketLimits(db: Db, memberId: string): Promise<void> {
  const hourSince = new Date(Date.now() - 60 * 60_000);
  const burstSince = new Date(Date.now() - TICKET_WINDOW_MINUTES * 60_000);

  const [recent] = await db
    .select({
      // toISOString + explicit cast — a bare Date in a SELECT expression never
      // meets a column type mapper. The same 500 `signupLimit.ts` documents.
      burst: sql<number>`count(*) filter (
        where ${supportTicket.createdAt} >= ${burstSince.toISOString()}::timestamptz
      )::int`,
      hour: sql<number>`count(*)::int`,
    })
    .from(supportTicket)
    .where(and(eq(supportTicket.memberId, memberId), gte(supportTicket.createdAt, hourSince)));

  /**
   * THE CEILING FIRST. When both are exceeded the honest refusal is the one the
   * caller cannot wait out in a moment — telling somebody to "wait a moment" when
   * they have an hour to wait sends them back every minute.
   *
   * The copy points at the channel that is still open, which is the difference
   * between this refusal and the siblings'. She may have a real problem and a
   * WhatsApp number and an email address are on the same screen she just submitted
   * from; a support endpoint that says only "try again later" to somebody disputing
   * a charge is the wrong shape of refusal.
   */
  if ((recent?.hour ?? 0) >= TICKET_MAX_PER_HOUR) {
    throw tooManyRequests(
      'ticket_hourly_limit',
      'You have opened several messages already. We will reply to those first — or reach us on WhatsApp if it is urgent.',
    );
  }
  if ((recent?.burst ?? 0) >= TICKET_MAX_PER_WINDOW) {
    throw tooManyRequests(
      'ticket_rate_limited',
      'That is a lot of messages at once. Wait a few minutes, or reach us on WhatsApp if it is urgent.',
    );
  }
}
