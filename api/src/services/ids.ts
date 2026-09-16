/**
 * EVERY HUMAN-FACING ID THE API MINTS, IN ONE PLACE, FROM A SEQUENCE.
 *
 * ===========================================================================
 * WHAT THIS REPLACED, AND WHY IT IS ONE FILE
 * ===========================================================================
 * Nine minters across five prefixes, each a private copy of
 * `Math.floor(Math.random() * N)` written straight into a PRIMARY KEY with no
 * uniqueness check and no retry:
 *
 *   CMP- campaigns         9,000 values   routes/campaigns.ts
 *   SUP- support tickets  90,000          routes/support.ts
 *   TX-  transactions  9,000,000          services/{charge,order,topup,booking}.ts
 *                                         AND routes/charges.ts, five copies of
 *                                         one identical function
 *   BK-  bookings      9,000,000          services/booking.ts
 *   NT-  notifications 9,000,000          services/notifications.ts
 *
 * A duplicate is a birthday collision, not a tail. P(no collision) over N draws
 * from a space of S is about exp(-N(N-1)/2S), so 50% arrives at ~112 campaigns,
 * ~353 tickets, and ~3,531 transactions — a busy salon inside a year, and the
 * space is shared across every salon on the platform.
 *
 * The campaigns case was found first, as an intermittent 500 in a full `e2e/`
 * run: `Key (id)=(CMP-6994) already exists`. Migration 0052 fixed `CMP-` and
 * `SUP-`; 0053 fixed the other three and this file is where they all live now,
 * because five private copies of one unsafe line is how three of them survived
 * the first fix.
 *
 * ===========================================================================
 * TX- IS THE ONE THAT MATTERS, AND IT DOES NOT FAIL AS A 500
 * ===========================================================================
 * `routes/orders.ts` and `routes/topups.ts`, `bookings.ts`, `adjustments.ts` and
 * `vouchers.ts` all catch 23505 with a bare `isUniqueViolation(err)` and read it
 * as an idempotency-key collision — `services/idempotency.ts` § `violatedConstraint`
 * records what that costs: the loser looks for a winner's stored response under a
 * key that never committed, finds nothing, and answers `409 request_in_progress`,
 * "still being processed". `routes/orders.ts` even states the precondition that
 * makes its bare catch safe — "nothing else here is unique" — and that sentence
 * was FALSE for as long as the transaction id was a dice roll, because
 * `transaction_pkey` is unique and was minted at random inside that very
 * transaction.
 *
 * So a colliding TX- told a staff member her charge was still in flight when it
 * had not happened, on a path where the remedy she reaches for is to charge
 * again. That is worse than the campaigns 500 this started from: a 500 is
 * unambiguous, and "still being processed" is a wrong answer about money.
 * There is no retry on 23505 anywhere in `api/src`.
 *
 * ===========================================================================
 * WHY A SEQUENCE AND NOT A UUID, ON A MONEY PATH
 * ===========================================================================
 * EXACT RATHER THAN MERELY UNLIKELY. A sequence cannot collide, so nothing here
 * needs a retry loop or an `ON CONFLICT` branch to be written, tested and then
 * trusted under concurrency. On the path where being wrong is a wrong answer
 * about money, "astronomically improbable" is a weaker claim than "impossible"
 * for no gain.
 *
 * READABILITY IS THE THING A UUID COSTS, and it is not decorative. Receipts carry
 * `AVO-CHG-${txId.slice(3)}` (services/charge.ts), `AVO-SH-`, `AVO-DEP-`,
 * `AVO-DPR-`, and a customer reads that reference to support down a phone.
 * `TX-10000042` gives `AVO-CHG-10000042`; a uuid slice gives
 * `AVO-CHG-a3f9c2b81e04`. The two `randomUUID().slice(0, 12)` minters that already
 * exist — `TX-VCH-` in routes/vouchers.ts and `TX-ADJ-` in routes/adjustments.ts —
 * are left alone here: they are already collision-safe, their references are
 * already in the wild, and changing a reference format is a customer-visible change
 * that is not this slice's to make. That they disagree with these is worth a
 * decision; it is not worth a silent rewrite.
 *
 * ENUMERABILITY IS ACCEPTED, AND IT IS NOT A NEW DISCLOSURE. A global sequence
 * means two of a salon's own receipts a month apart bound the platform's
 * transaction count in between. That signal already ships: `audit_log.seq` is a
 * global `bigserial` and `services/auditRead.ts` puts it on the wire behind an
 * ordinary merchant permission. Nor is any of these ids a credential — every
 * lookup by transaction id is scoped to the caller's own tenant
 * (`routes/charges.ts` requires `transaction.salon_id = principal.salonId`,
 * `routes/support.ts` requires `transaction.member_id = principal.id`), which is
 * the argument migration 0025 made for member numbers.
 *
 * A ROLLED-BACK TRANSACTION BURNS A NUMBER, because a sequence is not
 * transactional. 0025 accepted that trade for members and it is the same one
 * here: a gap in a receipt reference is invisible, a duplicate is a wrong answer.
 *
 * ===========================================================================
 * TWO SHAPES, AND THE RULE THAT PICKS BETWEEN THEM
 * ===========================================================================
 * MINT IN SQL, inside the INSERT, when nothing downstream needs the value — the
 * `SQL` constants below. There is no window between drawing an id and using it,
 * because there are not two statements.
 *
 * DRAW IT WITH `nextval` when JS needs the value — the async functions below.
 * A transaction id is used to build a receipt reference, to point ledger legs and
 * a receipt job at the row, and to answer the caller, all before and after the
 * insert; minting it inside the INSERT would mean reading it back and rebuilding
 * everything downstream around a value that arrives late. The draw is one round
 * trip on the executor already in hand.
 *
 * Either way the id is unique the moment it exists. `nextval` is atomic and is
 * never handed to two callers, in or out of a transaction.
 */

import { sql, type SQL } from 'drizzle-orm';
import type { Executor } from './audit';

/**
 * The shared draw.
 *
 * THE SEQUENCE NAME IS NEVER INTERPOLATED — each caller passes a complete `SQL`
 * literal rather than a string this function splices. There is no untrusted input
 * anywhere near here and there never will be, but a helper that takes a table or
 * sequence NAME as a string is the shape somebody later passes a variable to, and
 * `sql.raw` is how that becomes an injection. Two extra words at three call sites
 * closes it permanently.
 *
 * `nextval` returns bigint, which postgres.js hands back as a string or a number
 * depending on size — so this normalises through `String` rather than assuming
 * either, and never through `Number`, which would silently lose precision past
 * 2^53.
 */
async function draw(exec: Executor, query: SQL): Promise<string> {
  const rows = (await exec.execute(query)) as unknown as Array<{ n: string | number }>;
  const n = rows[0]?.n;
  if (n === undefined || n === null) throw new Error('a sequence draw returned no row');
  return String(n);
}

/**
 * 'TX-10000042'. The money row's id — a charge, an order, a top-up credit, a
 * deposit hold or return, a void.
 */
export async function nextTransactionId(exec: Executor): Promise<string> {
  return `TX-${await draw(exec, sql`SELECT nextval('transaction_number_seq') AS n`)}`;
}

/**
 * 'TI-10000042'. The top-up INTENT — one row per attempt, not per success, and
 * api/README.md calls those real payment records.
 *
 * THE SIXTH MINTER, AND A DIFFERENT SHAPE FROM THE OTHER FIVE. This was
 * `Math.random().toString(36).slice(2, 8).toUpperCase()`, six base-36 characters:
 * 36^6 = 2.18e9, so a 50% collision needs ~55,000 rows rather than ~3,531. That is
 * why it did not present the way `CMP-` did, and it is not why it was safe — a
 * top-up attempt is a frequent event and 55,000 is reachable. Migration 0054.
 *
 * Its five siblings in that family — `ST-`, `BR-`, `PR-`, `HH-`, `doc-` — are
 * deliberately left alone; `ids.test.ts` pins them so the narrowing stays a
 * decision.
 */
export async function nextTopUpIntentId(exec: Executor): Promise<string> {
  return `TI-${await draw(exec, sql`SELECT nextval('topup_intent_number_seq') AS n`)}`;
}

/** 'BK-10000042'. The appointment. */
export async function nextBookingId(exec: Executor): Promise<string> {
  return `BK-${await draw(exec, sql`SELECT nextval('booking_number_seq') AS n`)}`;
}

/**
 * 'NT-10000042'. The merchant notification. Nothing downstream reads it —
 * `raiseNotification` answers whether a row was written, not which one — so this
 * is the in-INSERT form.
 */
export const notificationId = sql`'NT-' || nextval('notification_number_seq')::text`;

/**
 * 'CMP-10000'. Quoted back to the merchant, so not a uuid —
 * `db/schema/campaign.ts` says so on the column.
 */
export const campaignId = sql`'CMP-' || nextval('campaign_number_seq')::text`;

/**
 * 'SUP-100000'. api-contract.md § SupportTicket rule 4 calls it "the only handle
 * the customer has", which is why it is a short quotable string and why a ticket
 * that fails to be created is worse than a slow one.
 */
export const ticketId = sql`'SUP-' || nextval('support_ticket_number_seq')::text`;
