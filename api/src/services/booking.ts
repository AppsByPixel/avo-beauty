/**
 * Booking — the deposit lifecycle. build-plan.md phase 6.
 *
 * `AVO-Beauty-Product-Description-v2.md` § 3 is why this exists at all: deposits
 * drive top-up volume. A booking is therefore not a scheduling feature with a
 * payment attached, it is a money flow with a calendar attached, and every
 * function here is written the way `services/charge.ts` is written.
 *
 * A DEPOSIT HOLD IS MONEY LEAVING A WALLET, and gets a charge's whole treatment:
 * one database transaction, an idempotency key claimed inside it, balanced
 * ledger entries, an audit row, and a rollback that takes all of them with it.
 * The only thing it does NOT do is consume a wallet token — nobody is standing at
 * a counter.
 *
 * THE FOUR EXITS, AND WHERE THE MONEY GOES
 * ----------------------------------------
 *   completed         the held deposit becomes a credit line against the charge.
 *                     `services/charge.ts` § 4. The design's worked example:
 *                     8.000 service − 5.000 deposit = 3.000 debited.
 *   no_show_returned  `noShowReturnMinutes` after the missed slot, automatically.
 *                     Nobody is there to press anything, so it is a JOB —
 *                     services/noShowWorker.ts.
 *   cancelled         returned immediately.
 *   rescheduled       carried. No money moves at all; the row's slot changes.
 *
 * Non-negotiable #5: all of them are wallet credit. There is no path out of this
 * file that reaches cash or a card.
 *
 * THE ONE-HOUR RULE IS ENFORCED HERE, NOT IN THE CLIENT
 * ----------------------------------------------------
 * "Free until an hour before. After that the deposit stays with the salon" —
 * AVO Wallet Home.dc.html `reschedNote`, in both languages. A client deciding
 * whether it is still early enough is a client deciding whether it keeps its
 * money: the device clock is settable, and the window closes while the screen is
 * open. `assertChangeWindowOpen` is called by both cancel and reschedule, before
 * anything is read for update.
 *
 * A CONTRADICTION IN THE DESIGN, RESOLVED AND REPORTED. The same file carries
 * `cancelPolicy: 'Free to cancel up to 24h before'` at line 1245 alongside the
 * one-hour `reschedNote` at line 1180. build-plan.md § phase 6 says "the 1-hour
 * rule enforced server-side" and the product brief's no-show rule is an hour, so
 * one hour is implemented. The 24h string is reported, not silently overridden —
 * it is a copy decision, and copy is settled by the design, not by this lane.
 */

import { and, asc, eq, gt, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import {
  add,
  fils,
  subtract,
  type BookingCancelResult,
  type BookingSettlement,
  type Fils,
} from '@avo/types';
import type { Db } from '../db/client';
import { artist } from '../db/schema/artist';
import { booking } from '../db/schema/booking';
import { ledgerEntry } from '../db/schema/ledger';
import {
  depositForfeitedPosting,
  depositHeldPosting,
  depositReleasedPosting,
} from '../money/ledger';
import { member } from '../db/schema/member';
import { salon } from '../db/schema/salon';
import { service } from '../db/schema/service';
import { transaction } from '../db/schema/transaction';
import type { MemberPrincipal, Principal, StaffPrincipal } from '../auth/principal';
import { NO_LOYALTY_RECORD, serialiseTransactionForCustomer } from '../http/serialise';
import { env } from '../env';
import {
  badRequest,
  conflict,
  idempotencyKeyRequired,
  insufficientBalance,
  notFound,
} from '../http/errors';
import { parseDate, parseInstant, salonWallClock } from '../time/zone';
import { computeAvailability, findSlot } from './availability';
import { writeAudit, type Executor } from './audit';
import { assertArtistPerformsService, assertBookedPairAssigned } from './artistService';
import { resolveBranch } from './branch';
import {
  cancellationOutcome,
  noShowOutcome,
  readPublishedPolicy,
  type CancellationRule,
  type NoShowRule,
  type BookingPolicyStamp,
} from './bookingPolicy';
import { claimKey, completeKey } from './idempotency';
import { queueReceipts } from './receipts';
import { nextBookingId, nextTransactionId } from './ids';

export interface BookingIdempotency {
  scope: string;
  endpoint: string;
  key: string;
  requestHash: string;
}

export interface BookingContext {
  principal: MemberPrincipal;
  idempotency: BookingIdempotency;
  ipAddress?: string | null;
  userAgent?: string | null;
}

const kd = (f: number) => (f / 1000).toFixed(3);

/** Postgres exclusion_violation. Two customers, one slot, one winner. */
const EXCLUSION_VIOLATION = '23P01';

export function isExclusionViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === EXCLUSION_VIOLATION
  );
}

// ---------------------------------------------------------------- serialise --

export interface BookingRow {
  id: string;
  /** NULL on a guest appointment, and on nothing else. Migration 0056. */
  memberId: string | null;
  guestName: string | null;
  guestPhone: string | null;
  artistId: string;
  branchId: string;
  serviceId: string;
  startsAt: Date;
  endsAt: Date;
  durationMin: number;
  depositFils: number;
  status: 'deposit_held' | 'completed' | 'no_show_returned' | 'cancelled';
  source: 'app' | 'google_calendar' | 'merchant';
  noShowReturnDueAt: Date;
  rescheduledCount: number;
  calendarSyncState: 'not_applicable' | 'pending' | 'synced' | 'failed';
  /** The stamped policy (migration 0066). All six null on a LEGACY booking. */
  policyId: string | null;
  policyVersion: number | null;
  policyNoShow: NoShowRule | null;
  policyCancellationRules: CancellationRule[] | null;
  policyTextEn: string | null;
  policyTextAr: string | null;
  /** Where the deposit went when it left escrow other than by a charge. */
  settledReturnedFils: number | null;
  settledKeptFils: number | null;
  forfeitTransactionId: string | null;
  holdTransactionId: string | null;
}

/**
 * The stamp, or null for a LEGACY booking. `booking_policy_stamp_is_whole` makes
 * "some of the six" unrepresentable, so testing one column is testing all six.
 */
export function stampedPolicyOf(row: BookingRow): BookingPolicyStamp | null {
  if (
    row.policyId === null ||
    row.policyVersion === null ||
    row.policyNoShow === null ||
    row.policyCancellationRules === null ||
    row.policyTextEn === null ||
    row.policyTextAr === null
  ) {
    return null;
  }
  return {
    id: row.policyId,
    version: row.policyVersion,
    noShow: row.policyNoShow,
    cancellation: row.policyCancellationRules.map((r) => ({
      hoursBefore: r.hoursBefore,
      returnPercent: r.returnPercent,
    })),
    text: { en: row.policyTextEn, ar: row.policyTextAr },
  };
}

/**
 * Where the deposit went, when it left escrow other than by a charge. Null while
 * it is held, on a completed booking (the charge consumed it — that is on the
 * charge), and on a zero-deposit row (there was nothing to go anywhere).
 *
 * A NULL SPLIT ON A SETTLED ROW IS A FULL RETURN, and saying so is exact rather
 * than a guess: the split columns arrived in 0066, and every row settled without
 * them — before 0066, or by the pre-0066 API still serving while it applies —
 * went through a `returnDeposit` that could only ever return the whole deposit.
 */
export function settlementOf(row: BookingRow): BookingSettlement | null {
  if (row.holdTransactionId === null) return null;
  if (row.status !== 'cancelled' && row.status !== 'no_show_returned') return null;
  if (row.settledReturnedFils === null || row.settledKeptFils === null) {
    return { returnedFils: fils(row.depositFils), keptFils: fils(0) };
  }
  return { returnedFils: fils(row.settledReturnedFils), keptFils: fils(row.settledKeptFils) };
}

/**
 * The wire shape: `BookingSchema` from @avo/types, plus four fields that are not
 * in it and that the screens cannot be drawn without.
 *
 * `endsAt` — the wallet's Upcoming card shows a time range, and a client
 * deriving it from `durationMin` re-does a computation the server already made.
 * `noShowReturnDueAt` and `changeableUntil` — the two deadlines the design states
 * inline ("the 1-hour rule stated inline", README § Upcoming appointment). A
 * client computing `startsAt − 1h` for itself is a client deciding when its own
 * deposit is at risk, which is the same class of mistake as computing a balance.
 * `calendarSyncState` — the merchant's appointment list needs to know an event
 * did not reach the artist's calendar.
 */
export function serialiseBooking(row: BookingRow) {
  return {
    id: row.id,
    memberId: row.memberId,
    /**
     * PRESENT ON EVERY BOOKING, NOT ONLY ON A GUEST'S.
     *
     * `BookingSchema` declares both `.nullable()`, which is REQUIRED-BUT-MAY-BE-NULL
     * and not optional. A serialiser that omitted them on an `app` row would fail
     * the client's own contract parse - which is the exact defect `changeableUntil`
     * records a few lines below, found by lane B when Zod silently stripped a field
     * the server was sending.
     */
    guestName: row.guestName,
    guestPhone: row.guestPhone,
    artistId: row.artistId,
    branchId: row.branchId,
    serviceId: row.serviceId,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    durationMin: row.durationMin,
    depositFils: row.depositFils,
    status: row.status,
    source: row.source,
    noShowReturnDueAt: row.noShowReturnDueAt.toISOString(),
    changeableUntil: new Date(
      row.startsAt.getTime() - env.bookingChangeWindowMinutes * 60_000,
    ).toISOString(),
    rescheduledCount: row.rescheduledCount,
    calendarSyncState: row.calendarSyncState,
    /**
     * THE POLICY THIS BOOKING WAS MADE UNDER — migration 0066. `null` on a
     * LEGACY booking, and PRESENT (never omitted) on every row, because a client
     * has to tell "made under no policy" from "an API too old to say". The text
     * is the one she was shown before she confirmed; `ar` may be '' and falls
     * back to `en` at the display boundary.
     */
    policy: stampedPolicyOf(row),
    /** `{ returnedFils, keptFils }` once the deposit has left escrow, else null. */
    settlement: settlementOf(row),
  };
}

// ------------------------------------------------------- the automatic settle --

/**
 * When the no-show job may settle this booking, for a slot ending at `endsAt`.
 * Stamped on `no_show_return_due_at` at booking time and recomputed on a move.
 *
 *   LEGACY   `endsAt` + the salon's `no_show_return_minutes` — unchanged, and
 *            the column is frozen now that the merchant cannot write it.
 *   POLICY   `endsAt` + `BOOKING_SETTLE_GRACE_MINUTES` (60): the slot's end plus
 *            the time a till needs to ring up the visit. See env.ts.
 */
function automaticSettleAt(
  row: Pick<BookingRow, 'policyId'>,
  endsAt: Date,
  salonNoShowReturnMinutes: number,
): Date {
  const minutes = row.policyId !== null ? env.bookingSettleGraceMinutes : salonNoShowReturnMinutes;
  return new Date(endsAt.getTime() + minutes * 60_000);
}

// --------------------------------------------------------------- the window --

/**
 * The one-hour rule. Refuses once the window has closed.
 *
 * Measured against `startsAt` of the booking as it stands NOW, which is what
 * makes a reschedule chain terminate: moving a 16:45 to 19:00 buys a new
 * deadline for the 19:00, not a fresh hour before the 16:45 that no longer
 * exists.
 */
function assertChangeWindowOpen(row: { startsAt: Date }, now: Date, verb: string): void {
  const closesAt = row.startsAt.getTime() - env.bookingChangeWindowMinutes * 60_000;
  if (now.getTime() >= closesAt) {
    throw conflict(
      'change_window_closed',
      `An appointment can be ${verb} free until an hour before it starts. ` +
        'After that the deposit stays with the salon.',
      {
        changeableUntil: new Date(closesAt).toISOString(),
        startsAt: row.startsAt.toISOString(),
        windowMinutes: env.bookingChangeWindowMinutes,
      },
    );
  }
}

// --------------------------------------------------------- the held deposit --

/**
 * The booking whose deposit this charge should consume, if there is one.
 *
 * WHICH BOOKING, and why it is not simply "her earliest held one". A customer
 * with an appointment next Tuesday who walks in today for a blow-dry must not
 * have Tuesday's deposit spent on it: she would arrive on Tuesday with nothing
 * held, and the salon's commitment would have evaporated into an unrelated
 * charge. So the booking has to be the one that is IN PLAY right now:
 *
 *   starts_at <= now + noShowReturnMinutes   she has arrived, or is arriving.
 *                                            The salon's own no-show tolerance
 *                                            is reused as the early-arrival
 *                                            grace, because it is the number the
 *                                            merchant has already chosen to
 *                                            express how much slack a slot has.
 *   no_show_return_due_at > now              the deposit has not been returned
 *                                            yet. Past this the money is already
 *                                            back in her wallet and there is
 *                                            nothing to apply.
 *
 * BOTH PREDICATES ARE IN THE `WHERE`, AND THAT ORDERING IS THE FIX FOR A BUG A
 * CUSTOMER COULD FEEL.
 *
 * `no_show_return_due_at > now` used to be applied in TypeScript AFTER `LIMIT 1`,
 * so ONE STALE HOLD HID EVERY GOOD ONE. Lane D reproduced it: she no-shows on
 * Monday and the return job has not run, so Monday's hold is still on the row. She
 * books Tuesday and pays a second deposit. She attends on Tuesday — and this
 * function picked Monday (earliest `starts_at`), found it expired, and returned
 * null. Her Tuesday deposit was invisible, she was charged full price for a visit
 * she had already part-paid, and the staff member had no credit line to point at
 * while the customer watched.
 *
 * No money was permanently lost — Monday's hold still returns when the job runs —
 * but it was wrong AT THE TILL, which is the same family as `heldDepositFils: 0`:
 * right in the database, wrong in front of the customer. Narrowing to one row and
 * then testing applicability tests the wrong row; filtering first cannot.
 *
 * The original reason for the TypeScript check is preserved rather than discarded:
 * the comparison is still against the CALLER'S `now`, bound as a parameter, not
 * `now()` evaluated by the database a few milliseconds later. It moved from an `if`
 * to a `WHERE`; it did not change what it compares.
 *
 * WHICH ONE, WHEN TWO ARE LIVE — a rule now, not an accident. `LIMIT 1` implied
 * there could only ever be one candidate, and this bug proves otherwise: two
 * appointments inside one grace window are ordinary, and after this fix both can be
 * applicable at once.
 *
 *   EARLIEST `starts_at` WINS. It is the appointment she is most plausibly
 *   settling: a hold from twenty minutes ago is a visit she has just had, and one
 *   starting in an hour is a visit she has not. That is also what a staff member
 *   would pick by eye.
 *
 *   AND ONLY ONE IS CONSUMED. A visit settles one appointment, so a second live
 *   hold must survive this charge untouched — applying two deposits to one basket
 *   would spend money held against an appointment she has not attended yet, which
 *   is the Tuesday-deposit failure in the other direction.
 *
 * `forUpdate` when called from inside the charge transaction: the row is about
 * to be marked `completed`, and the no-show job may be looking at exactly this
 * row at exactly this moment.
 */
export async function findApplicableHold(
  exec: Db | Executor,
  params: { memberId: string; salonId: string; now: Date; noShowReturnMinutes: number },
  options: { forUpdate?: boolean } = {},
): Promise<BookingRow | null> {
  const graceEnd = new Date(params.now.getTime() + params.noShowReturnMinutes * 60_000);

  let query = (exec as Db)
    .select()
    .from(booking)
    .where(
      and(
        eq(booking.memberId, params.memberId),
        eq(booking.salonId, params.salonId),
        eq(booking.status, 'deposit_held'),
        lte(booking.startsAt, graceEnd),
        /**
         * IN THE `WHERE`, not in an `if` after `LIMIT 1`. This is the whole fix —
         * see the header. `params.now` is the caller's clock bound as a parameter,
         * so the comparison is against the same instant the charge uses for
         * everything else; the POSITION changed, not the operand.
         */
        gt(booking.noShowReturnDueAt, params.now),
        /**
         * AND THERE HAS TO BE A HOLD TO APPLY.
         *
         * A merchant-created appointment is `deposit_held` with `deposit_fils = 0`
         * and no hold transaction (migration 0056) - it means "Booked", not "money
         * is sitting in escrow". Without this line a walk-in written down by the
         * front desk would be picked as the applicable hold ahead of the customer's
         * real one (earliest `starts_at` wins), and the till would offer a 0.000
         * credit line against a deposit she actually paid. `hold_transaction_id`
         * rather than `deposit_fils > 0` because `booking_deposit_matches_hold`
         * makes them the same fact and the hold is the thing being consumed.
         */
        isNotNull(booking.holdTransactionId),
      ),
    )
    // Earliest APPLICABLE appointment: the one she is most plausibly settling.
    .orderBy(asc(booking.startsAt))
    // One visit settles one appointment. A second live hold survives this charge.
    .limit(1)
    .$dynamic();

  if (options.forUpdate) query = query.for('update');

  const rows = await query;
  return (rows[0] as BookingRow | undefined) ?? null;
}

// -------------------------------------------------------------- POST /bookings --

export interface CreateBookingInput {
  artistId: string;
  serviceId: string;
  /** ISO instant. Validated against the server's own availability grid. */
  startsAt: string;
  /**
   * The booking-policy version the wallet showed her, `null` for "no policy", or
   * absent when the client does not say. `createBooking` § THE POLICY SHE IS BOOKING UNDER.
   */
  policyVersion?: number | null;
}

export async function createBooking(
  db: Db,
  input: CreateBookingInput,
  ctx: BookingContext,
) {
  return db.transaction(async (tx) => {
    // ---------------------------------------------------------------- 0. key --
    // Claimed FIRST, inside the transaction, exactly as `performCharge` does. A
    // duplicate raises a unique violation before money moves.
    const keyId = await claimKey(tx, ctx.idempotency);

    // ------------------------------------------------------------- 1. member --
    // FOR UPDATE serialises this against a concurrent charge or top-up on the
    // same wallet, so the balance read is the balance debited.
    const [m] = await tx
      .select()
      .from(member)
      .where(eq(member.id, ctx.principal.id))
      .for('update')
      .limit(1);
    if (!m) throw notFound('unknown_member', 'No such member.');

    const [s] = await tx.select().from(salon).where(eq(salon.id, m.salonId)).limit(1);
    if (!s) throw notFound('unknown_salon', 'No such salon.');

    /**
     * THE MODULE GATE, server-side.
     *
     * `modules.booking` defaults OFF — AVO-Beauty-Product-Description-v2.md
     * § Settings. A wallet that hides the Book tab for a salon with the module
     * off is a courtesy; non-negotiable #7 says a courtesy is not a control, and
     * this endpoint takes a deposit out of a wallet.
     */
    if (!s.moduleBooking) {
      throw conflict(
        'booking_not_enabled',
        'This salon does not take appointments through AVO.',
      );
    }

    // ------------------------------------------------------- 2. what and who --
    const [a] = await tx
      .select()
      .from(artist)
      .where(and(eq(artist.id, input.artistId), eq(artist.salonId, m.salonId)))
      .limit(1);
    // Same 404 for "no such artist" and "not in your salon": another salon's
    // roster is not something a customer gets to probe.
    if (!a) throw notFound('unknown_artist', 'No such artist.');
    if (!a.active) throw conflict('artist_not_bookable', 'That artist is not taking bookings.');

    const [svc] = await tx
      .select()
      .from(service)
      .where(
        and(
          eq(service.id, input.serviceId),
          eq(service.salonId, m.salonId),
          eq(service.active, true),
        ),
      )
      .limit(1);
    if (!svc) throw notFound('unknown_service', 'No such service.');

    /**
     * SHE MUST DO THIS SERVICE (migration 0061). After both ids have resolved
     * against her salon — so another salon's artist is still `unknown_artist`,
     * never a 409 that confirms it exists — and before the slot and the money,
     * so a refusal here has held nothing. See services/artistService.ts.
     */
    await assertArtistPerformsService(tx, a, svc);

    // ---------------------------------------------------------- 3. the slot --
    /**
     * VALIDATED AGAINST THE SERVER'S OWN GRID, never taken on trust.
     *
     * A client that can name its own `startsAt` can book at 03:00, book a
     * fifteen-minute sliver inside a forty-five-minute grid, or aim at a slot
     * that is already taken and leave the exclusion constraint to catch it —
     * and that last one turns a validation error into a database error wearing
     * the wrong message.
     *
     * `computeAvailability` is the same function `GET /artists/{id}/availability`
     * calls, which is the whole reason it was lifted out of that route: the grid
     * the customer chose from and the grid this checks against cannot drift.
     */
    // With its offset — `time/zone.ts` § parseInstant. A zoneless "10:00" read in
    // the process zone is 13:00 Kuwait on a UTC host, and 13:00 is a real slot.
    const startsAt = parseStartsAt(input.startsAt);
    const now = new Date();
    // The salon's calendar date for that instant — never the server's. A booking
    // at 22:00 Kuwait time on the 19th is the 19th, whatever UTC calls it.
    const localDate = salonWallClock(startsAt, s.timezone).date;

    /**
     * ON `tx`. See `charge.ts` § "ON `tx`, NOT ON `db`" for the mechanism — a
     * query on the base handle inside a transaction asks the ten-connection pool
     * for a second connection while holding one, and twelve concurrent bookings
     * wedge the API process with no Postgres deadlock ever being raised.
     *
     * SAFE HERE FOR A REASON WORTH STATING, because `computeAvailability` is not
     * purely a read. On the google-sourced path it writes: `resolveWorkingWindow`
     * raises or resolves a `calendar_disconnected` merchant notification. Folding
     * those into this transaction means a booking that then fails rolls the
     * notification back. Accepted — the raise is `onConflictDoNothing` against a
     * partial index, and the SAME call on the READ path
     * (`GET /artists/{id}/availability`, routes/artists.ts, no transaction) has
     * already raised it before any customer can pick a slot from that grid.
     */
    const availability = await computeAvailability(
      tx,
      a.id,
      m.salonId,
      parseDate(localDate, 'startsAt'),
      localDate,
      { now },
    );
    const slot = findSlot(availability, startsAt.toISOString());

    if (!slot) {
      throw badRequest(
        'not_a_slot',
        `${a.name} has no appointment starting then. Pick a time from her availability.`,
        { date: localDate, slotMinutes: availability.slotMinutes },
      );
    }
    if (!slot.available) {
      throw conflict(
        slot.reason === 'closed' ? 'slot_past' : 'slot_taken',
        slot.reason === 'closed'
          ? 'That time has already passed. Pick a later one.'
          : 'That time has just been taken. Pick another one.',
        { reason: slot.reason ?? 'booked', local: slot.local },
      );
    }

    const endsAt = new Date(slot.endsAt);
    const durationMin = Math.round((endsAt.getTime() - startsAt.getTime()) / 60_000);

    /**
     * THE POLICY SHE IS BOOKING UNDER (migration 0066), read before any money
     * moves.
     *
     * The salon's CURRENT published version, copied onto the row below — rules and
     * text both — so nothing the salon publishes later can change what this
     * booking returns. A salon that has never published one stamps nothing, and
     * the booking is LEGACY (services/bookingPolicy.ts § LEGACY).
     *
     * `policyVersion` IS WHAT SHE WAS SHOWN. The ruling is that she sees the policy
     * before she confirms, and a publish landing between the confirm sheet and
     * this request would otherwise stamp a version she never read. When the
     * client says which version it showed and it is not the current one, the
     * booking is refused with the current version in the details, and nothing is
     * held. Optional, so the wallet that does not send it yet keeps working;
     * lane B should send it (the report says so).
     */
    const policy = await readPublishedPolicy(tx, m.salonId);
    if (input.policyVersion !== undefined && input.policyVersion !== (policy?.version ?? null)) {
      throw conflict(
        'policy_changed',
        'The salon has just updated its booking policy. Read the new one before you book.',
        { policyVersion: policy?.version ?? null },
      );
    }

    // ------------------------------------------------------ 4. hold the deposit --
    const deposit = fils(s.depositFils);
    const balance = fils(m.balanceFils);
    if (deposit > balance) {
      /**
       * THE SAME SHAPE AS A CHARGE'S 402, and that is the requirement rather
       * than a convenience: the wallet's booking summary offers a one-tap KNET
       * top-up from this error, and it can only fill in "top up X" if the server
       * says exactly how short she is. Throwing rolls the transaction back, so
       * the idempotency key vanishes with it and the same attempt can be retried
       * after the top-up rather than being answered with a cached 402 for ever.
       */
      throw insufficientBalance(deposit, balance);
    }
    const balanceAfter = subtract(balance, deposit);

    /**
     * The branch, resolved by the SERVER. A booking has a branch and the same
     * rule applies as for a charge: a client naming its own branch is a client
     * choosing its own reporting bucket, and — once branch-scoped promotions
     * touch bookings — its own multiplier. services/branch.ts.
     */
    /**
     * THE BOOKING'S BRANCH COMES FROM THE ARTIST.  (migration 0044)
     *
     * `a` is the artist row loaded above, already checked to be this salon's. One
     * artist belongs to one branch, so where the appointment is is a fact about
     * who is performing it — not a client assertion and not `ORDER BY id LIMIT 1`.
     *
     * `a.branchId` is NULL for an artist nobody has assigned yet, which passes no
     * `supplied` at all and leaves this exactly as it was before the column
     * existed. See db/schema/artist.ts for why NULL is not "unbookable".
     *
     * DELIBERATELY NOT THE TILL'S BRANCH. A charge takes its branch from the
     * enrolled device (DECISIONS.md #82); this takes it from the artist. The two
     * answer different questions and may differ for one visit — she books at
     * Salmiya and pays at Kuwait City — and neither is reconciled into the other.
     */
    const branch = await resolveBranch(tx, m.salonId, a.branchId);

    const txId = await nextTransactionId(tx);
    const bkId = await nextBookingId(tx);

    await tx
      .update(member)
      .set({ balanceFils: balanceAfter, updatedAt: now })
      .where(eq(member.id, m.id));

    await tx.insert(transaction).values({
      id: txId,
      memberId: m.id,
      salonId: m.salonId,
      branchId: branch.branchId,
      branchAssumed: !branch.established,
      kind: 'deposit_hold',
      // Negative: the sign CHECK on `transaction` says a deposit_hold debits.
      amountFils: fils(-deposit),
      method: 'wallet',
      status: 'settled',
      reference: `AVO-DEP-${txId.slice(3)}`,
      createdAt: now,
      settledAt: now,
    });

    /**
     * Double entry. The wallet is debited and the `deposit_held` account is
     * credited — the money has left her spendable balance and is sitting in a
     * liability the salon has not earned yet. `services/charge.ts` unwinds
     * exactly this pair into `salon_revenue` when the visit completes, and the
     * return path unwinds it back into the wallet. The DEFERRABLE trigger from
     * migration 0001 checks the pair at COMMIT.
     */
    await tx.insert(ledgerEntry).values(
      depositHeldPosting({
        transactionId: txId,
        salonId: m.salonId,
        memberId: m.id,
        amountFils: deposit,
        balanceAfterFils: balanceAfter,
      }),
    );


    /**
     * The automatic deadline, STAMPED — a promise made to this customer about this
     * appointment; see db/schema/booking.ts for why it is measured from `ends_at`.
     *
     *   LEGACY   `ends_at` + `salon.no_show_return_minutes`, exactly as before.
     *   POLICY   `ends_at` + `BOOKING_SETTLE_GRACE_MINUTES` (60): the stamped
     *            no-show rule applies once the slot has ended and the till has
     *            had its hour. It is the same column, so the worker, the partial index,
     *            `findApplicableHold` and deposit health all keep working on it.
     */
    const noShowReturnDueAt = new Date(
      endsAt.getTime() +
        (policy ? env.bookingSettleGraceMinutes : s.noShowReturnMinutes) * 60_000,
    );

    const [row] = await tx
      .insert(booking)
      .values({
        id: bkId,
        salonId: m.salonId,
        branchId: branch.branchId,
        branchAssumed: !branch.established,
        memberId: m.id,
        artistId: a.id,
        serviceId: svc.id,
        startsAt,
        endsAt,
        durationMin,
        depositFils: deposit,
        status: 'deposit_held',
        source: 'app',
        holdTransactionId: txId,
        noShowReturnDueAt,
        ...(policy
          ? {
              policyId: policy.id,
              policyVersion: policy.version,
              policyNoShow: policy.noShowRule,
              policyCancellationRules: policy.cancellationRules,
              policyTextEn: policy.textEn,
              policyTextAr: policy.textAr,
            }
          : {}),
        /**
         * `pending` when there is a calendar to write to, `not_applicable` when
         * there is not. Set here rather than after the write-back so a crash
         * between commit and provider call leaves a row that says "this was
         * never confirmed" instead of one that silently claims nothing was owed.
         */
        calendarSyncState: 'not_applicable',
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row) throw new Error('booking insert returned no row');

    // A deposit is money out of the wallet, so it is receipted like one. The
    // rows are queued here and sent after commit — never a network call inside
    // an open money transaction. services/receipts.ts.
    await queueReceipts(tx, m, txId, {
      kind: 'deposit_hold',
      transactionId: txId,
      bookingId: bkId,
      amountFils: deposit,
      artistName: a.name,
      serviceName: svc.name,
      startsAt: startsAt.toISOString(),
      balanceAfterFils: balanceAfter,
    });

    await writeAudit(tx, ctx.principal, {
      salonId: m.salonId,
      kind: 'money',
      action: 'Deposit held',
      detail: `${kd(deposit)} KD held for ${m.name} · ${svc.name} with ${a.name}`,
      source: 'wallet',
      subjectType: 'booking',
      subjectId: bkId,
      amountFils: -deposit,
      metadata: {
        bookingId: bkId,
        transactionId: txId,
        artistId: a.id,
        serviceId: svc.id,
        startsAt: startsAt.toISOString(),
        noShowReturnDueAt: noShowReturnDueAt.toISOString(),
        branchAssumed: !branch.established,
        policyId: policy?.id ?? null,
        policyVersion: policy?.version ?? null,
      },
      ipAddress: ctx.ipAddress ?? null,
      userAgent: ctx.userAgent ?? null,
    });

    const result = {
      booking: serialiseBooking(row as BookingRow),
      balanceAfterFils: balanceAfter,
      /**
       * THROUGH THE SHARED SERIALISER, for the reason the eleven inline fields here
       * were wrong: `voidedAt` and `reversedByTransactionId` are declared
       * `.nullable()` on `TransactionSchema` — required on the wire, permitted to be
       * null — and an explicit field list silently omits whatever is added to the
       * schema after it is written. The Book flow's own reply failed the client's
       * contract parse.
       */
      transaction: serialiseTransactionForCustomer(
        {
          id: txId,
          memberId: m.id,
          branchId: branch.branchId,
          kind: 'deposit_hold',
          amountFils: -deposit,
          bonusFils: 0,
          // Merchant-visible, customer-never, and 0 on the row: a deposit hold moves
          // her own money into a hold, so there is no commission on it.
          feeFils: 0,
          method: 'wallet',
          status: 'settled',
          reference: `AVO-DEP-${txId.slice(3)}`,
          createdAt: now,
          // A deposit is the salon's published figure, not one anybody typed —
          // and `transaction_custom_amount_is_charge_only` (0049) makes that a
          // database fact for every kind but `charge`. Said, because tsc naming
          // this literal is the only reason the Book flow's reply is not once
          // again narrower than the schema.
          customAmount: false,
          note: null,
          // A hold earns nothing; the visit is earned by the charge that settles
          // it. `transaction_loyalty_is_charge_only` (0065) makes that a fact.
          ...NO_LOYALTY_RECORD,
        },
        // Created inside this transaction, so nothing can have reversed it yet. Said
        // rather than defaulted — the same argument as services/charge.ts.
        null,
      ),
    };

    await completeKey(tx, keyId, { status: 201, body: result }, txId);
    return result;
  });
}

// ------------------------------------------------------------- the return --

/**
 * Settle a held deposit: some of it back to her wallet, the rest to the salon.
 * Shared by every exit that is not a charge — her cancel, the salon's cancel, a
 * manual no-show and the no-show job. `returnDeposit` below is the full-return
 * case and is what every LEGACY path and the salon's cancel call.
 *
 * Called with the booking row ALREADY LOCKED and its status already checked by
 * the caller — this writes, it does not decide. The SPLIT is decided by the
 * caller from the booking's stamped policy (services/bookingPolicy.ts) and is
 * checked here only for arithmetic: `returned + kept = deposit`, both
 * non-negative integers, or nothing is written.
 *
 * THE LOCK ORDER IS MEMBER, THEN BOOKING, EVERYWHERE. It is written down here
 * because it is not local: `performCharge` takes the member row `FOR UPDATE` as
 * its first statement and only then reaches for the held booking, and a cancel
 * or a no-show return that took them the other way round would deadlock against
 * a charge on the same customer — two transactions each holding what the other
 * wants, resolved by Postgres killing one of them at random. Every caller here
 * therefore reads the booking UNLOCKED to learn whose it is, locks the member, and
 * only then locks the booking and re-checks its status. The re-check is what makes
 * the unlocked first read safe.
 *
 * WHAT IT WRITES (migration 0066 § 3):
 *
 *   returned > 0   a `deposit_return` for `returned`: `deposit_held` DEBIT +
 *                  `member_wallet` CREDIT, her balance up by `returned`, and a
 *                  receipt. Wallet credit, never cash or a card (#5).
 *   kept > 0       a `deposit_forfeit` for `kept`: `deposit_held` DEBIT +
 *                  `salon_revenue` CREDIT, `amount_fils = 0` because her wallet
 *                  does not move, and NO receipt — there is no template for it
 *                  (whatsapp-templates.md), which is reported, not improvised.
 *   the booking    `settled_transaction_id` = the return if there is one, else
 *                  the forfeit; `forfeit_transaction_id`; the split. In ONE
 *                  conditional UPDATE, so a booking settles exactly once.
 *
 * `deposit_held` is debited by exactly the deposit across the two, so escrow
 * nets to zero for the booking whatever the split.
 */
export async function settleDeposit(
  tx: Executor,
  params: {
    row: BookingRow;
    memberRow: typeof member.$inferSelect;
    reason: 'cancelled' | 'no_show';
    returnedFils: Fils;
    keptFils: Fils;
    principal: Principal | null;
    now: Date;
    note: string;
    /**
     * OPTIONAL, and null on the two callers that shipped first. The worker has no
     * request to take them from, and the customer's cancel never passed them.
     * `markNoShow` does: a staff member moving money out of a salon's hold is the
     * same class of row as a console adjustment, which records both — and "from
     * which browser, at which address" is a question a disputed no-show invites.
     */
    ipAddress?: string | null;
    userAgent?: string | null;
  },
): Promise<{
  /** The `deposit_return`, or null when nothing came back. */
  transactionId: string | null;
  /** The `deposit_forfeit`, or null when nothing was kept. */
  forfeitTransactionId: string | null;
  /** The one the booking's `settled_transaction_id` now names. */
  settledTransactionId: string;
  balanceAfterFils: Fils;
  returnedFils: Fils;
  keptFils: Fils;
}> {
  const { row, memberRow, now } = params;
  const deposit = fils(row.depositFils);
  const returned = fils(params.returnedFils);
  const kept = fils(params.keptFils);
  if (returned < 0 || kept < 0 || add(returned, kept) !== deposit) {
    throw new Error(
      `deposit split ${returned} + ${kept} does not equal the ${deposit} held on ${row.id}`,
    );
  }
  if (row.holdTransactionId === null) {
    throw new Error(`settleDeposit called on ${row.id}, which holds no deposit`);
  }

  const [held] = await tx
    .select({ branchId: transaction.branchId, branchAssumed: transaction.branchAssumed })
    .from(transaction)
    .where(eq(transaction.id, row.holdTransactionId))
    .limit(1);
  /**
   * Inherited from the hold, not re-derived — the same reasoning a void inherits
   * it from the charge it reverses. Claiming `false` here would launder a guessed
   * branch into an established one on the way back.
   */
  const branchId = held?.branchId ?? row.branchId;
  const branchAssumed = held?.branchAssumed ?? false;

    /**
     * WHO AT THE SALON DID THIS, and null when the answer is "nobody".
     *
     * This field was ABSENT, which meant every deposit return ever written said
     * NULL. That was harmless while the only way a deposit came back was the
     * worker, and became a defect the moment `markNoShow` gave the path a human:
     * `routes/activity.ts` and `routes/platformConsole.ts` both branch on
     * `kind === 'deposit_return' && createdByStaffId === null` to pick BOTH the
     * actor and the sentence, so a return Noura marked by hand rendered on the
     * merchant's own Overview as "System returned 5.000 deposit · Dana Al-Sabah"
     * — on the one screen whose job is to say who did what. The audit row beside
     * it was right the whole time; the feed was reading a column nobody wrote.
     *
     * THE EXPRESSION IS THE AUDIT'S `source` EXPRESSION, narrowed to the one kind
     * of principal this column can hold. `created_by_staff_id` is an FK to
     * `staff_user.id` (migration 0000, ON DELETE RESTRICT), so:
     *
     *   - `null`              the worker. No human. NULL → "System", the design's
     *                         own third feed line and what `writeAudit` records
     *                         for a principal-less write.
     *   - `MemberPrincipal`   the customer cancelling her own booking. Her id is
     *                         a `member.id`; writing it here does not merely
     *                         misattribute, it violates the FK and rolls the
     *                         refund back. NULL — nobody at the salon did this,
     *                         and the audit row carries her as the actor with
     *                         `source: 'wallet'`.
     *   - `StaffPrincipal`    `markNoShow`. HER ID. The fix.
     *   - `PlatformPrincipal` AVO acting on a salon. Also not a `staff_user.id`,
     *                         so also NULL — and no caller passes one today; the
     *                         case exists because the parameter is `Principal`.
     *                         If one is ever added, the merchant's feed will call
     *                         it "System" and that will need a row-level fact
     *                         about WHO rather than a second reading of this one.
     *
     * Written as a `kind === 'staff'` test rather than `principal?.id` for
     * exactly that reason: the narrowing is the argument, and TypeScript refuses
     * the bare id, so a future caller cannot quietly launder a non-staff id into
     * a staff column.
     */
  const createdByStaffId = params.principal?.kind === 'staff' ? params.principal.id : null;

  let balanceAfter = fils(memberRow.balanceFils);
  let returnTxId: string | null = null;
  let forfeitTxId: string | null = null;

  // ------------------------------------------------------- back to her wallet --
  if (returned > 0) {
    returnTxId = await nextTransactionId(tx);
    balanceAfter = add(balanceAfter, returned);

    await tx
      .update(member)
      .set({ balanceFils: balanceAfter, updatedAt: now })
      .where(eq(member.id, memberRow.id));

    await tx.insert(transaction).values({
      id: returnTxId,
      memberId: memberRow.id,
      salonId: memberRow.salonId,
      branchId,
      branchAssumed,
      kind: 'deposit_return',
      // Positive: the sign CHECK says a deposit_return credits.
      amountFils: returned,
      method: 'wallet',
      status: 'settled',
      reference: `AVO-DPR-${returnTxId.slice(3)}`,
      note: params.note,
      createdByStaffId,
      createdAt: now,
      settledAt: now,
    });

    // The mirror of the hold: the liability is discharged back into the wallet.
    await tx.insert(ledgerEntry).values(
      depositReleasedPosting({
        transactionId: returnTxId,
        salonId: memberRow.salonId,
        memberId: memberRow.id,
        amountFils: returned,
        balanceAfterFils: balanceAfter,
      }),
    );
  }

  // ----------------------------------------------------------- to the salon --
  if (kept > 0) {
    forfeitTxId = await nextTransactionId(tx);

    await tx.insert(transaction).values({
      id: forfeitTxId,
      memberId: memberRow.id,
      salonId: memberRow.salonId,
      branchId,
      branchAssumed,
      kind: 'deposit_forfeit',
      /**
       * ZERO, and `transaction_amount_sign_matches_kind` requires exactly zero.
       * `amount_fils` is her WALLET delta and her wallet does not move: the money
       * left it when the deposit was held. The magnitude is the ledger's
       * `deposit_held` debit below and the booking's `settled_kept_fils`.
       */
      amountFils: fils(0),
      method: 'wallet',
      status: 'settled',
      reference: `AVO-DPF-${forfeitTxId.slice(3)}`,
      note: params.note,
      createdByStaffId,
      createdAt: now,
      settledAt: now,
    });

    await tx.insert(ledgerEntry).values(
      depositForfeitedPosting({
        transactionId: forfeitTxId,
        salonId: memberRow.salonId,
        amountFils: kept,
      }),
    );
  }

  // `deposit > 0` on every row with a hold (`booking_deposit_matches_hold`), so
  // at least one of the two was written.
  const settledTxId = returnTxId ?? forfeitTxId;
  if (settledTxId === null) throw new Error(`nothing settled the deposit on ${row.id}`);

  /**
   * THE TRANSITION IS THE WHERE CLAUSE, and the row count decides.
   *
   * This was `.where(eq(booking.id, row.id))` with the count unread, which made
   * the caller's status check THE ONLY layer standing between one deposit and two
   * refunds. Lane D replaced that check with `if (false)` and the entire suite
   * stayed green — 14 files, 516 passed, exit 0 — because nothing had ever called
   * `DELETE /bookings/{id}`.
   *
   * And the schema could not catch what the handler missed, in the worst possible
   * pattern: `booking_completed_at_matches_status` and its siblings do refuse
   * `completed → cancelled` and `no_show_returned → cancelled`, but
   * `cancelled → cancelled` is SELF-CONSISTENT — every CHECK passes and a second
   * refund commits. Lane D drove it: 205000 then 210000 for one 5.000 deposit. The
   * two transitions the schema does cover are exactly the two that made this path
   * look adequate.
   *
   * `deposit_held` is the only status a deposit can come back from, and it is now
   * asserted by the statement rather than by the caller having remembered. Nothing
   * downstream of this — including the money written a few lines above — survives
   * a zero row count, because the throw rolls the whole transaction back. That is
   * the same mechanism services/topup.ts uses for a settlement, and the reason a
   * top-up needed all three of its guards removed before money moved twice while
   * this needed none.
   *
   * NOT A REPLACEMENT for the caller's check. `cancelBooking` still answers
   * `already_cancelled` / `not_cancellable` with copy a client can render; this is
   * the layer that holds when someone deletes that.
   */
  const [settled] = await tx
    .update(booking)
    .set({
      ...(params.reason === 'cancelled'
        ? { status: 'cancelled' as const, cancelledAt: now }
        : { status: 'no_show_returned' as const, returnedAt: now }),
      settledTransactionId: settledTxId,
      forfeitTransactionId: forfeitTxId,
      settledReturnedFils: returned,
      settledKeptFils: kept,
      updatedAt: now,
    })
    .where(and(eq(booking.id, row.id), eq(booking.status, 'deposit_held')))
    .returning({ id: booking.id });

  if (!settled) {
    throw conflict(
      'deposit_already_returned',
      'That deposit has already been returned.',
      { bookingId: row.id, reason: params.reason },
    );
  }

  if (returnTxId !== null) {
    await queueReceipts(tx, memberRow, returnTxId, {
      kind: 'deposit_return',
      transactionId: returnTxId,
      bookingId: row.id,
      amountFils: returned,
      reason: params.reason,
      balanceAfterFils: balanceAfter,
    });
  }

  /**
   * THE ACTION NAMES THE OUTCOME. A full return keeps the two strings it has
   * always had, so every reader of the log (and every spec) that knows them is
   * unchanged; the two new outcomes get their own.
   */
  const verb = params.reason === 'cancelled' ? 'cancelled' : 'no-show';
  const action =
    kept === 0
      ? `Deposit returned · ${verb}`
      : returned === 0
        ? `Deposit kept · ${verb}`
        : `Deposit partly returned · ${verb}`;
  const detail =
    kept === 0
      ? `${kd(returned)} KD returned to ${memberRow.name} · ${params.note}`
      : returned === 0
        ? `${kd(kept)} KD kept by the salon · ${memberRow.name} · ${params.note}`
        : `${kd(returned)} KD returned to ${memberRow.name}, ${kd(kept)} KD kept by the salon · ${params.note}`;

  await writeAudit(tx, params.principal, {
    salonId: memberRow.salonId,
    kind: 'money',
    action,
    detail,
    /**
     * DERIVED FROM THE ACTOR, NOT FROM THE REASON — and the two agreed only until
     * a `no_show` could have an actor.
     *
     * This read `params.reason === 'cancelled' ? 'wallet' : 'system'`, and it was
     * correct for exactly two callers: the customer's cancel (wallet) and the
     * no-show worker, which passes no principal at all so the audit row reads
     * "System · Automatic" rather than attributing an automatic refund to whoever
     * happened to be signed in. `markNoShow` is a THIRD — reason `no_show`, with a
     * real staff member standing at a dashboard — and under the old expression its
     * row would have claimed `system` while `actor_kind` and `actor_name` on that
     * same row named her. One row, two answers to "who did this".
     *
     * Behaviour-identical for both callers that shipped: a `MemberPrincipal` is
     * the cancel and `null` is the worker. What changes is that the answer now
     * comes from the field that decides `actor_kind`, so the two cannot disagree.
     */
    source:
      params.principal === null
        ? 'system'
        : params.principal.kind === 'member'
          ? 'wallet'
          : params.principal.kind === 'platform_admin'
            ? 'owner_console'
            : 'merchant',
    subjectType: 'booking',
    subjectId: row.id,
    /** Her WALLET movement, the same convention as the hold's `-deposit`. */
    amountFils: returned,
    metadata: {
      bookingId: row.id,
      transactionId: returnTxId,
      forfeitTransactionId: forfeitTxId,
      reason: params.reason,
      returnedFils: returned,
      keptFils: kept,
      policyVersion: row.policyVersion,
    },
    ipAddress: params.ipAddress ?? null,
    userAgent: params.userAgent ?? null,
  });

  return {
    transactionId: returnTxId,
    forfeitTransactionId: forfeitTxId,
    settledTransactionId: settledTxId,
    balanceAfterFils: balanceAfter,
    returnedFils: returned,
    keptFils: kept,
  };
}

/**
 * Give the WHOLE deposit back — the only exit there was before 0066, and still
 * the one every LEGACY booking, a `return` policy's no-show and every salon
 * cancel takes. A thin caller of `settleDeposit`, so there is one money path and
 * not two.
 */
export async function returnDeposit(
  tx: Executor,
  params: {
    row: BookingRow;
    memberRow: typeof member.$inferSelect;
    reason: 'cancelled' | 'no_show';
    principal: Principal | null;
    now: Date;
    note: string;
    ipAddress?: string | null;
    userAgent?: string | null;
  },
): Promise<{ transactionId: string; balanceAfterFils: Fils }> {
  const settled = await settleDeposit(tx, {
    ...params,
    returnedFils: fils(params.row.depositFils),
    keptFils: fils(0),
  });
  // Non-null: a full return of a positive deposit always writes the return.
  return { transactionId: settled.settledTransactionId, balanceAfterFils: settled.balanceAfterFils };
}

// ------------------------------------------------------ DELETE /bookings/{id} --

/** The row as it stands now, for a response that must show where the money went. */
async function reloadBooking(tx: Executor, id: string): Promise<BookingRow> {
  const [row] = await (tx as Db).select().from(booking).where(eq(booking.id, id)).limit(1);
  if (!row) throw new Error(`booking ${id} vanished inside its own transaction`);
  return row as BookingRow;
}

/**
 * What a cancel did: trunk's `BookingCancelResultSchema` (`@avo/types`, b23e78c),
 * the same shape for a legacy booking and a policy one. `refundedFils` is what
 * came back (kept under that name for the pre-0066 client), `keptFils` what the
 * salon kept (0 on a legacy booking), `returnPercent` 100 on a legacy booking,
 * `rule` null on a legacy booking or later than every rule.
 *
 * `booking` is the serialiser's own type rather than the schema's because the
 * serialiser sends a strict SUPERSET of `BookingSchema` (`endsAt`,
 * `noShowReturnDueAt`, `changeableUntil`, ... — see `serialiseBooking`).
 */
export type CancelResult = Omit<BookingCancelResult, 'booking'> & {
  booking: ReturnType<typeof serialiseBooking>;
};

/**
 * She cancels her own appointment. What comes back is decided by the policy the
 * booking was STAMPED with — never the salon's current one.
 *
 * ===========================================================================
 * TWO BOOKINGS, TWO RULES — services/bookingPolicy.ts § LEGACY
 * ===========================================================================
 *   LEGACY   the full deposit back, refused inside the last hour
 *            (`change_window_closed`), exactly as before 0066.
 *   POLICY   the stamped cut-off rules decide the split, rounded DOWN to the fil;
 *            the salon keeps the rest, the remainder fil included.
 *            No one-hour refusal: "later than every threshold returns 0%" is the
 *            ruling, so a late cancel is ALLOWED and returns what the rules say.
 *            Refused once the appointment has started (`appointment_started`):
 *            from then on it is attendance, and the no-show rule decides.
 *
 * ONE TRANSACTION — #3's shape. The key claim, the return, the forfeit, both
 * ledger pairs, the status transition, the receipt and the audit row commit
 * together or not at all.
 *
 * ===========================================================================
 * THE IDEMPOTENCY KEY — REQUIRED ON A POLICY BOOKING, HONOURED ON A LEGACY ONE
 * ===========================================================================
 * This function used to argue, correctly, that no key was needed: the transition
 * out of `deposit_held` under `FOR UPDATE` cannot refund twice, for one key or two.
 * That still holds and is still the guarantee that money moves once. What changed
 * is what a retry needs to be TOLD. Before 0066 every cancel returned the whole
 * deposit, so a retry answered `already_cancelled` lost nothing. Now a cancel can
 * return 50% or nothing, and a client that lost the response must learn how much
 * came back and how much the salon kept — which `already_cancelled` cannot say
 * and a replayed response can. So non-negotiable #4 applies on a policy booking:
 * without a key it is refused with 400 `idempotency_key_required` before anything
 * is read for update.
 *
 * A LEGACY booking keeps the keyless contract the wallet shipped against, and
 * uses a key if one is sent. Requiring it there would break every cancel the
 * current wallet makes, for no change in what the answer carries.
 */
export async function cancelBooking(
  db: Db,
  bookingIdParam: string,
  ctx: {
    principal: MemberPrincipal;
    /** Present when the request carried an Idempotency-Key. */
    idempotency?: BookingIdempotency | null;
    ipAddress?: string | null;
    userAgent?: string | null;
  },
): Promise<CancelResult> {
  return db.transaction(async (tx) => {
    // The key FIRST, inside the transaction that carries the effect, when there is
    // one — `markNoShow`'s ordering. A replay blocks on the unique index here.
    const keyId = ctx.idempotency ? await claimKey(tx, ctx.idempotency) : null;

    /**
     * UNLOCKED, to learn whose booking this is. See `settleDeposit`'s header for
     * why the member row has to be locked first: the global order is member, then
     * booking, and a cancel that locked the booking first would deadlock against
     * a charge on the same customer.
     */
    const [probe] = await tx
      .select({ memberId: booking.memberId, policyId: booking.policyId })
      .from(booking)
      .where(and(eq(booking.id, bookingIdParam), eq(booking.memberId, ctx.principal.id)))
      .limit(1);
    // Scoped to the caller's own bookings. Someone else's appointment is not
    // something a customer gets to probe, so this is a 404 rather than a 403.
    // `member_id` became nullable in 0056, and the `where` above is what makes it
    // non-null here: a row matched on `member_id = <her id>` has a member by
    // construction. Narrowed rather than asserted, so the compiler carries it.
    if (!probe?.memberId) throw notFound('unknown_booking', 'No such appointment.');
    const probeMemberId = probe.memberId;

    // #4 on a policy booking. The stamp cannot appear or vanish later (nothing
    // writes `policy_id` after the insert), so the unlocked read decides it.
    if (probe.policyId !== null && keyId === null) throw idempotencyKeyRequired();

    const [m] = await tx
      .select()
      .from(member)
      .where(eq(member.id, probeMemberId))
      .for('update')
      .limit(1);
    if (!m) throw notFound('unknown_member', 'No such member.');

    // NOW the booking, locked, and its status re-read under that lock. This is
    // what makes the unlocked probe above harmless.
    const [locked] = await tx
      .select()
      .from(booking)
      .where(eq(booking.id, bookingIdParam))
      .for('update')
      .limit(1);
    if (!locked) throw notFound('unknown_booking', 'No such appointment.');
    const row = locked as BookingRow;

    if (row.status !== 'deposit_held') {
      const kept = settlementOf(row)?.keptFils ?? 0;
      throw conflict(
        row.status === 'cancelled' ? 'already_cancelled' : 'not_cancellable',
        row.status === 'cancelled'
          ? kept > 0
            ? 'That appointment was already cancelled.'
            : 'That appointment was already cancelled and the deposit is back in your wallet.'
          : row.status === 'completed'
            ? 'That appointment has already happened.'
            : kept > 0
              ? 'That appointment was missed.'
              : 'That appointment was missed and the deposit has already been returned.',
        { status: row.status },
      );
    }

    const now = new Date();
    const deposit = fils(row.depositFils);
    const stamped = stampedPolicyOf(row);

    let split: { returnedFils: Fils; keptFils: Fils; returnPercent: number; rule: CancellationRule | null };
    if (stamped === null) {
      assertChangeWindowOpen(row, now, 'cancelled');
      split = { returnedFils: deposit, keptFils: fils(0), returnPercent: 100, rule: null };
    } else {
      if (now.getTime() >= row.startsAt.getTime()) {
        throw conflict(
          'appointment_started',
          'That appointment has already started, so it can no longer be cancelled.',
          { startsAt: row.startsAt.toISOString() },
        );
      }
      split = cancellationOutcome(stamped.cancellation, row.startsAt, now, deposit);
    }

    const settled = await settleDeposit(tx, {
      row,
      memberRow: m,
      reason: 'cancelled',
      returnedFils: split.returnedFils,
      keptFils: split.keptFils,
      principal: ctx.principal,
      now,
      note:
        stamped === null
          ? 'Cancelled by the customer'
          : `Cancelled by the customer · ${split.returnPercent}% returned under booking policy v${stamped.version}`,
      ipAddress: ctx.ipAddress ?? null,
      userAgent: ctx.userAgent ?? null,
    });

    const result: CancelResult = {
      booking: serialiseBooking(await reloadBooking(tx, row.id)),
      refundedFils: settled.returnedFils,
      keptFils: settled.keptFils,
      returnPercent: split.returnPercent,
      rule: split.rule,
      balanceAfterFils: settled.balanceAfterFils,
      transactionId: settled.transactionId,
      forfeitTransactionId: settled.forfeitTransactionId,
    };

    if (keyId !== null) {
      await completeKey(tx, keyId, { status: 200, body: result }, settled.settledTransactionId);
    }
    return result;
  });
}

// ------------------------------- POST /salons/{id}/bookings/{id}/no-show --

/**
 * MARK NO-SHOW, by hand, from the merchant dashboard.
 *
 * `design/AVO Merchant Dashboard.dc.html:184` draws it as a small, understated
 * link beside the status pill, under a banner that says exactly what it is for:
 * "Deposits auto-return to the customer's wallet 1 hour after a missed slot — the
 * money never leaves the ecosystem. **Use Mark no-show only for edge cases.**"
 *
 * So `services/noShowWorker.ts` is the normal path and this is the exception, and
 * this function is written as a THIN CALLER of `returnDeposit` — the same
 * function the worker calls, already written and already exercised. No new money
 * mechanics arrive here. What arrives is a set of guards, and which of the
 * worker's it keeps is the whole of the design.
 *
 * ===========================================================================
 * THE WORKER'S GUARDS: WHICH ONES A MANUAL MARK NEEDS
 * ===========================================================================
 *
 *   LOCK THE MEMBER FIRST, THEN THE BOOKING.  KEPT, and it matters MORE here.
 *     The global order is member-then-booking because `performCharge` takes the
 *     member row `FOR UPDATE` as its first statement; a path that took them the
 *     other way round deadlocks against a charge on the same customer. The
 *     worker's header calls that case "a customer who is late and then arrives",
 *     which is not an edge case for THIS function — it is its entire subject
 *     matter. The manual mark and the charge race by construction.
 *
 *   RE-READ THE STATUS UNDER THE LOCK.  KEPT, with a different consequence.
 *     The worker answers `already` and moves on; it is a batch over rows nobody
 *     asked about. A manual mark has a caller who must be told BY NAME which of
 *     the three terminal states it hit, the way `cancelBooking` answers
 *     `already_cancelled` / `not_cancellable` with copy a client can render.
 *
 *   THE DEPOSIT IS A BRANCH, NOT A PRECONDITION.  A hand-written appointment is
 *     `deposit_held` with `deposit_fils = 0` and no hold, and it can be marked
 *     like any other: a no-show is a fact about ATTENDANCE, and the walk-in who
 *     did not turn up is a no-show in the sense the salon means. The money path
 *     below is entered only when there is money. See the branch in the body.
 *
 *   `no_show_return_due_at <= now`.  DELIBERATELY NOT KEPT, and keeping it would
 *     make this endpoint unreachable. That is the AUTOMATIC rule's own threshold:
 *     the moment it is satisfied, the worker's next tick takes the row. A manual
 *     mark exists precisely to act BEFORE it. The worker needs the re-check
 *     because its candidate scan is unlocked and a reschedule can move the
 *     deadline between the scan and the lock; this function names one booking by
 *     id and has no stale scan to defend against.
 *
 * ===========================================================================
 * WHAT REPLACES IT: THE TIME GATE, WHICH THE DESIGN DOES NOT STATE
 * ===========================================================================
 * The design gates the link on STATUS ALONE — `canMark: st === 'held'` — so as
 * drawn a merchant can mark a no-show on next Tuesday's appointment. The server
 * refuses that, and the reason is not primarily the money:
 *
 *   THE MONEY IS CLOSE TO NEUTRAL. The deposit returns to her wallet, and a later
 *   charge simply takes the full price instead of `price − deposit`.
 *
 *   THE RECORD IS NOT. `no_show_returned` is a statement that she did not arrive
 *   for a slot. Before the slot starts there is no slot she can have failed to
 *   arrive for, so the statement is not yet CAPABLE of being true, and an
 *   append-only log should not be able to hold one that is not.
 *
 *   AND THE SLOT IS NOT, WHICH IS THE HARM THE ARITHMETIC HIDES.
 *   `booking_artist_slot_no_overlap` is `EXCLUDE … WHERE status IN
 *   ('deposit_held', 'completed')` (migration 0013). A booking marked
 *   `no_show_returned` DROPS OUT of that constraint and its slot becomes bookable
 *   again. An early mark therefore releases a slot the customer is still expected
 *   at — she arrives on Tuesday to find her time taken and her artist busy. That
 *   is a real loss to a customer who did nothing wrong, and no refund answers it.
 *
 * THE THRESHOLD IS `starts_at`, NOT `ends_at` AND NOT THE DEADLINE.
 *   `ends_at` would make the merchant sit out the whole service before recording
 *   something the front desk knows at the start — three hours for a balayage —
 *   which pushes the manual control past the point of being useful. The automatic
 *   rule measures from `ends_at` for a good reason (`db/schema/booking.ts`: so it
 *   cannot fire while the customer is in the chair), but that rule is blind and
 *   this one has a human who can see the empty chair. The gate exists to refuse
 *   the statement that cannot be true, not to second-guess the person standing
 *   there. No grace period is added on top for the same reason: `noShowReturnMinutes`
 *   is the merchant's chosen slack for the AUTOMATIC path, and imposing it here
 *   would again mean the worker always got there first.
 *
 * ===========================================================================
 * `no_show_return_due_at` IS NOT TOUCHED
 * ===========================================================================
 * It keeps its original, still-future value. `db/schema/booking.ts` argues the
 * column is stored rather than computed because "the deadline a customer was
 * promised is a fact about her booking at the moment she made it" — rewriting it
 * to `now()` would retroactively edit that promise and erase the one fact an
 * audit of this endpoint would want, which is that the mark was EARLY. The board
 * can therefore render "returned 17:10 by Noura · would have returned 18:20",
 * which a rewritten column could not say.
 *
 * A LATER WORKER TICK IS A NO-OP BY STATUS, not by the deadline. The candidate
 * scan is `status = 'deposit_held' AND no_show_return_due_at <= now`, and
 * `booking_no_show_due_idx` is PARTIAL on `status = 'deposit_held'` — so the row
 * is not merely filtered out, it is not in the index the scan reads. Two further
 * layers stand behind that and neither is reached: the worker's own re-check
 * under the lock, and `returnDeposit`'s `WHERE status = 'deposit_held'`.
 *
 * ===========================================================================
 * NO MERCHANT NOTIFICATION, AND THAT IS THE DIFFERENCE FROM THE WORKER
 * ===========================================================================
 * The worker raises a `booking_no_show` notification because the merchant lost a
 * slot and money moved while nobody was looking. Here the merchant IS the actor.
 * Telling her "a deposit was returned automatically" one second after she clicked
 * the link is false in the notification and noise in her feed. The audit row —
 * with her name on it, `source: 'merchant'` — is the record.
 *
 * NO REASON FIELD. The void requires one and the console adjustment requires one;
 * this does not, because the design draws a bare link with no dialog behind it,
 * and a required reason would make the drawn control unbuildable as drawn. The
 * note is composed by the server so that `transaction.note` distinguishes a
 * marked return from an automatic one on the merchant's own feed.
 *
 * ===========================================================================
 * AN IDEMPOTENCY KEY IS REQUIRED — #4 — AND `cancelBooking` ARGUES THE OPPOSITE
 * ===========================================================================
 * That argument is right and does not transfer. `cancelBooking` reasons that a
 * transition out of `deposit_held` under `FOR UPDATE` is STRONGER than a key,
 * because it holds for two different keys as well as for one repeated — and that
 * is equally true here, which is why spec 7 of the int file gets a clean 409 and
 * one refund with no key involved. The key buys the OTHER guarantee: that a
 * caller who lost the response learns WHAT IT DID.
 *
 * For a customer cancelling her own appointment those two answers carry the same
 * information — "your deposit is back" — so the second attempt's
 * `already_cancelled` loses nothing. A merchant marking a no-show is recording an
 * act against somebody else's account and is handed a transaction id and a
 * balance; `already_no_show` does not tell her whether it was her own click, a
 * colleague's, or the worker's. So the key, and the claim lives inside the same
 * transaction as the effect so a rolled-back mark releases it.
 */
export async function markNoShow(
  db: Db,
  params: { salonId: string; bookingId: string; idempotency: BookingIdempotency },
  ctx: { principal: StaffPrincipal; ipAddress?: string | null; userAgent?: string | null },
): Promise<{
  booking: ReturnType<typeof serialiseBooking>;
  refundedFils: number;
  /**
   * NULLABLE SINCE THE ZERO-DEPOSIT MARK, and PRESENT rather than omitted on
   * both branches. A hand-written appointment has no wallet behind it, so there
   * is no balance to report and no transaction to name; `cancelByMerchant`
   * returns the same shape for the same reason, and the two endpoints answering
   * differently about the same kind of row would be the worse outcome. A client
   * must be able to tell "no money moved" from "this API is too old to say",
   * which is the argument `chargeVoided` and `depositReturnedFils` make on their
   * own responses.
   */
  balanceAfterFils: number | null;
  /** The `deposit_return`, or null when nothing came back (`keep`, or no deposit). */
  transactionId: string | null;
  /** What the salon kept under a `keep` policy. 0 otherwise. Migration 0066. */
  keptFils: number;
  /** The `deposit_forfeit`, or null when nothing was kept. */
  forfeitTransactionId: string | null;
}> {
  return db.transaction(async (tx) => {
    /**
     * THE CLAIM FIRST, inside the transaction that carries the effect. A second
     * request holding the same key blocks on `idempotency_key`'s unique index,
     * and the route replays the stored response rather than computing a new one.
     */
    const keyId = await claimKey(tx, params.idempotency);

    /**
     * UNLOCKED, to learn whose booking this is — `cancelBooking`'s shape, and
     * `returnDeposit`'s header says why the member has to be locked first.
     *
     * SCOPED TO THE SALON IN THE PATH, which `requireSameSalon` has already
     * checked against the caller's own. Another salon's booking is a 404 rather
     * than a 403: a 403 would confirm the id names a real appointment somewhere.
     */
    const [probe] = await tx
      .select({ memberId: booking.memberId, holdTransactionId: booking.holdTransactionId })
      .from(booking)
      .where(and(eq(booking.id, params.bookingId), eq(booking.salonId, params.salonId)))
      .limit(1);
    if (!probe) throw notFound('unknown_booking', 'No such appointment.');

    /**
     * ==================================================================
     * A NO-SHOW IS A FACT ABOUT ATTENDANCE, NOT ABOUT MONEY.
     * ==================================================================
     * A walk-in the front desk wrote in who does not turn up is a no-show in
     * exactly the sense the salon cares about. The only thing that ever argued
     * otherwise is that the status value is spelled `no_show_returned` — and that
     * naming problem is already contained at the display boundary rather than
     * fixed with a four-way enum break: `packages/types § BookingSchema` says a
     * client renders the pill from `depositFils`, and the scanner and wallet both
     * say "No-show" rather than "No-show · returned" at 0.
     *
     * So the deposit is a BRANCH here, not a precondition. Two paths out of one
     * transition:
     *
     *   hold_transaction_id IS NOT NULL   `returnDeposit` — the money path this
     *                                     endpoint has always had, untouched.
     *   hold_transaction_id IS NULL       the status transition ALONE. No
     *                                     transaction, no ledger entry, no touch
     *                                     of any balance, and no member row
     *                                     required — which is what lets a GUEST
     *                                     booking be marked at all.
     *
     * The conditional `booking_settlement_matches_status` from migration 0056
     * already permits exactly this shape: a row with no hold keeps
     * `settled_transaction_id` NULL through every status, so `no_show_returned`
     * needs nothing to point at. That the constraint permitted it without being
     * touched is the sign it was written around the right question.
     *
     * THE MEMBER LOCK IS TAKEN ONLY ON THE MONEY PATH. `returnDeposit`'s header
     * fixes the global order as member-then-booking because `performCharge` takes
     * the member row `FOR UPDATE` first and a path that took them the other way
     * round deadlocks against a charge on the same customer. The moneyless branch
     * reads no balance and writes none, so it has nothing for a lock to
     * serialise — and a guest has no member row to lock in the first place.
     */
    let m: typeof member.$inferSelect | null = null;
    if (probe.holdTransactionId !== null) {
      if (probe.memberId === null) {
        /**
         * UNREACHABLE, AND SAID RATHER THAN ASSUMED — this is the one case the
         * old blanket refusal was right about, kept and narrowed to it.
         * `booking_deposit_matches_hold` + `booking_merchant_is_zero_deposit` +
         * `booking_guest_requires_merchant_source` together mean a row with a hold
         * is an `app` row and therefore names a member. A row that has both a hold
         * and no member was written by something no writer in this API can be, so
         * it is refused rather than marked without the lock the money path needs.
         */
        throw conflict(
          'not_markable',
          'That appointment cannot be marked as a no-show.',
          { bookingId: params.bookingId },
        );
      }
      const probeMemberId = probe.memberId;
      const [locked] = await tx
        .select()
        .from(member)
        .where(eq(member.id, probeMemberId))
        .for('update')
        .limit(1);
      if (!locked) throw notFound('unknown_member', 'No such member.');
      m = locked;
    }

    // NOW the booking, locked, and re-read under that lock.
    const [row] = await tx
      .select()
      .from(booking)
      .where(eq(booking.id, params.bookingId))
      .for('update')
      .limit(1);
    if (!row) throw notFound('unknown_booking', 'No such appointment.');

    /**
     * THE THREE TERMINAL STATES, NAMED. `already_no_show` is the one a double
     * submit with two different keys lands on, and it is separated from the other
     * two because it means "you already did this" rather than "this is not a
     * thing you can do".
     */
    if (row.status !== 'deposit_held') {
      /**
       * AND THE COPY NO LONGER PROMISES A REFUND THAT NEVER HAPPENED. Two of
       * these three sentences named a deposit coming back, which on a
       * hand-written appointment is the salon telling a customer she got money
       * she never paid — the exact failure `BookingSchema`'s status comment
       * describes for the pills. The deposit half of each sentence is now
       * conditional on there having been one.
       */
      /**
       * AND SINCE 0066, NOT A RETURN THAT WAS A FORFEIT. "The deposit has been
       * returned" over a `keep` no-show, or "back in her wallet" over a late
       * cancellation that returned nothing, is the same false statement one layer
       * up: the sentence names a return only when the settlement was one.
       */
      const returnedAll =
        row.holdTransactionId !== null && (settlementOf(row as BookingRow)?.keptFils ?? 0) === 0;
      throw conflict(
        row.status === 'no_show_returned' ? 'already_no_show' : 'not_markable',
        row.status === 'no_show_returned'
          ? returnedAll
            ? 'That appointment is already marked as a no-show and the deposit has been returned.'
            : 'That appointment is already marked as a no-show.'
          : row.status === 'completed'
            ? 'That appointment was charged, so it cannot be marked as a no-show.'
            : returnedAll
              ? 'That appointment was cancelled, and the deposit is already back in her wallet.'
              : 'That appointment was cancelled.',
        { status: row.status },
      );
    }

    const now = new Date();
    // The time gate. See the header: the record, and the slot.
    if (now.getTime() < row.startsAt.getTime()) {
      throw conflict(
        'appointment_not_started',
        'That appointment has not started yet, so it cannot be marked as a no-show.',
        { startsAt: row.startsAt.toISOString(), now: now.toISOString() },
      );
    }

    // -------------------------------------------- the deposit-bearing one --
    if (m) {
      /**
       * THE STAMPED NO-SHOW RULE DECIDES (migration 0066). `keep` forfeits the
       * whole deposit to the salon, `return` gives it all back; a LEGACY booking
       * returns it all, as it always did. The worker applies the same function to
       * the same stamp, so a mark and a slot-end settle cannot disagree about the
       * outcome — only about who got there first, and the status transition
       * under the lock means exactly one of them does.
       */
      const stamped = stampedPolicyOf(row as BookingRow);
      const split = stamped
        ? noShowOutcome(stamped.noShow, fils(row.depositFils))
        : { returnedFils: fils(row.depositFils), keptFils: fils(0) };

      const settled = await settleDeposit(tx, {
        row: row as BookingRow,
        memberRow: m,
        reason: 'no_show',
        ...split,
        // A REAL ACTOR, which is the whole difference from the worker's call.
        principal: ctx.principal,
        now,
        note:
          split.keptFils > 0
            ? `No-show · marked on the dashboard · deposit kept under booking policy v${stamped?.version}`
            : 'No-show · marked on the dashboard',
        ipAddress: ctx.ipAddress ?? null,
        userAgent: ctx.userAgent ?? null,
      });

      const result = {
        booking: serialiseBooking(await reloadBooking(tx, row.id)),
        refundedFils: settled.returnedFils as number,
        keptFils: settled.keptFils as number,
        balanceAfterFils: settled.balanceAfterFils as number,
        transactionId: settled.transactionId,
        forfeitTransactionId: settled.forfeitTransactionId,
      };

      await completeKey(tx, keyId, { status: 200, body: result }, settled.settledTransactionId);
      return result;
    }

    // ------------------------------------------------ the moneyless one --
    /**
     * THE STATUS TRANSITION ALONE. Nothing else happens here, and the emptiness
     * is the specification: no `nextTransactionId`, no `transaction` insert, no
     * `ledgerEntry`, no `member` update and no `queueReceipts` — a receipt for a
     * refund that did not happen is the same lie as the pill that says one did.
     */
    const [marked] = await tx
      .update(booking)
      .set({ status: 'no_show_returned', returnedAt: now, updatedAt: now })
      /**
       * `status = 'deposit_held'` AND `hold_transaction_id IS NULL` BOTH IN THE
       * WHERE. The first is `returnDeposit`'s own lesson — lane D replaced the
       * caller's status check with `if (false)` and the suite stayed green, so the
       * transition belongs in the statement. The second is the branch's own
       * invariant: a hold that appeared between the probe and here would leave a
       * `no_show_returned` row with a live deposit still sitting in the
       * `deposit_held` ledger account and nothing pointing at it.
       */
      .where(
        and(
          eq(booking.id, row.id),
          eq(booking.status, 'deposit_held'),
          sql`${booking.holdTransactionId} IS NULL`,
        ),
      )
      .returning();
    if (!marked) {
      throw conflict('not_markable', 'That appointment cannot be marked as a no-show.', {
        bookingId: row.id,
      });
    }

    /**
     * `rules`, NOT `money`, and this is the whole difference from the branch
     * above. `returnDeposit` writes a `money` audit row because money moved.
     * Nothing moved here, and a `money` row with a zero amount would be a line in
     * the Money filter that a merchant reading a reconciliation has to skip past
     * — the question `rescheduleBooking` and `createMerchantBooking` both settled
     * the same way.
     *
     * THE ACTOR IS STILL RECORDED. `no_show_returned` is an assertion about a
     * named person's conduct whether or not a deposit was attached to it, so who
     * made it, from which address and on which booking is exactly as much of a
     * fact as it is on the money path.
     */
    await writeAudit(tx, ctx.principal, {
      salonId: row.salonId,
      kind: 'rules',
      action: 'No-show · no deposit',
      detail: `${row.guestName ?? row.memberId} · ${row.startsAt.toISOString()} · nothing to return`,
      source: 'merchant',
      subjectType: 'booking',
      subjectId: row.id,
      metadata: {
        bookingId: row.id,
        startsAt: row.startsAt.toISOString(),
        /** The NAME, never the number. A guest's phone is not audit-log material. */
        guest: row.guestName !== null,
      },
      ipAddress: ctx.ipAddress ?? null,
      userAgent: ctx.userAgent ?? null,
    });

    const result = {
      booking: serialiseBooking(marked as BookingRow),
      refundedFils: 0,
      keptFils: 0,
      balanceAfterFils: null,
      transactionId: null,
      forfeitTransactionId: null,
    };

    /** No transaction to bind the key to, because there is no transaction. */
    await completeKey(tx, keyId, { status: 200, body: result }, null);
    return result;
  });
}

// --------------------------------------------- POST /bookings/{id}/reschedule --

/**
 * Move the slot. The deposit CARRIES — README § Upcoming appointment,
 * "Reschedule (carries the deposit to a new slot)".
 *
 * NO MONEY MOVES, which is why this writes no transaction and no ledger entry,
 * and why the contract's status enum has no `rescheduled` value to move to: the
 * deposit is still held, by the same hold, against the same booking. What changes
 * is when it is due back.
 *
 * The exclusion constraint does the same work it does on a create: the row is
 * UPDATEd into the new range and Postgres refuses if that range overlaps another
 * live booking of the same artist. A check-then-update would race.
 */
export async function rescheduleBooking(
  db: Db,
  bookingIdParam: string,
  startsAtIso: string,
  ctx: { principal: MemberPrincipal; ipAddress?: string | null; userAgent?: string | null },
): Promise<{
  booking: ReturnType<typeof serialiseBooking>;
  depositCarriedFils: number;
  holdTransactionId: string;
}> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(booking)
      .where(and(eq(booking.id, bookingIdParam), eq(booking.memberId, ctx.principal.id)))
      .for('update')
      .limit(1);
    if (!row) throw notFound('unknown_booking', 'No such appointment.');

    if (row.status !== 'deposit_held') {
      throw conflict('not_reschedulable', 'That appointment can no longer be changed.', {
        status: row.status,
      });
    }

    const now = new Date();
    // Against the CURRENT slot. An appointment an hour away cannot be moved out
    // of trouble; that is what "after that the deposit stays with the salon"
    // means.
    assertChangeWindowOpen(row, now, 'moved');

    const startsAt = parseStartsAt(startsAtIso);
    if (startsAt.getTime() === row.startsAt.getTime()) {
      throw badRequest('same_slot', 'That is the time the appointment is already at.');
    }

    const [s] = await tx.select().from(salon).where(eq(salon.id, row.salonId)).limit(1);
    if (!s) throw notFound('unknown_salon', 'No such salon.');

    /**
     * A NEW SLOT RE-COMMITS HER TO THIS SERVICE (migration 0061). If the salon
     * has since taken it off her, the move is refused and the booking stays
     * where it is — at its original time it still happens, and she can still
     * cancel it for free up to an hour before.
     */
    await assertBookedPairAssigned(tx, row.artistId, row.serviceId);

    const localDate = salonWallClock(startsAt, s.timezone).date;
    // On `tx`, for the reason `createBooking` above gives. Nothing has been
    // written in this transaction yet — the booking row is still locked, not
    // updated — so the grid this reads is the same one `db` would have returned.
    const availability = await computeAvailability(
      tx,
      row.artistId,
      row.salonId,
      parseDate(localDate, 'startsAt'),
      localDate,
      { now },
    );
    const slot = findSlot(availability, startsAt.toISOString());
    if (!slot) {
      throw badRequest('not_a_slot', 'There is no appointment starting then.', {
        date: localDate,
      });
    }
    if (!slot.available) {
      throw conflict(
        slot.reason === 'closed' ? 'slot_past' : 'slot_taken',
        slot.reason === 'closed'
          ? 'That time has already passed. Pick a later one.'
          : 'That time has just been taken. Pick another one.',
        { reason: slot.reason ?? 'booked' },
      );
    }

    const endsAt = new Date(slot.endsAt);
    const noShowReturnDueAt = automaticSettleAt(row as BookingRow, endsAt, s.noShowReturnMinutes);

    const [updated] = await tx
      .update(booking)
      .set({
        startsAt,
        endsAt,
        durationMin: Math.round((endsAt.getTime() - startsAt.getTime()) / 60_000),
        // Recomputed, not carried: the promise is about the new slot.
        noShowReturnDueAt,
        rescheduledCount: row.rescheduledCount + 1,
        rescheduledAt: now,
        updatedAt: now,
      })
      /**
       * `status = 'deposit_held'` IN THE WHERE, for the reason `returnDeposit`
       * above now carries it. Lane D removed the handler's status check and the
       * suite stayed green, so a completed or cancelled appointment could be moved
       * into a live slot and occupy an artist's diary. No money moves on this path
       * — which is why lane D reported it rather than building the fix — but the
       * guard belongs in the write either way, and a booking whose deposit has
       * already been settled has no slot left to move.
       */
      .where(and(eq(booking.id, row.id), eq(booking.status, 'deposit_held')))
      .returning();
    if (!updated) {
      // Not `unknown_booking`: the row was found and locked twenty lines up. A
      // zero row count here can only mean the status moved, which is the same
      // fact the handler's check reports and deserves the same code.
      throw conflict('not_changeable', 'That appointment can no longer be changed.', {
        bookingId: row.id,
      });
    }

    /**
     * `rules`, not `money`. Nothing moved — the same hold still holds the same
     * deposit — and a `money` row with a zero amount would be a line in the
     * Money filter that a merchant reading a reconciliation has to skip past.
     * What changed is when the deposit comes back, which is a rule about this
     * booking, so the new deadline is in the detail where it can be read.
     */
    await writeAudit(tx, ctx.principal, {
      salonId: row.salonId,
      kind: 'rules',
      action: 'Appointment rescheduled',
      detail:
        `${row.startsAt.toISOString()} → ${startsAt.toISOString()} · ` +
        `${kd(row.depositFils)} KD deposit carried`,
      source: 'wallet',
      subjectType: 'booking',
      subjectId: row.id,
      metadata: {
        bookingId: row.id,
        from: row.startsAt.toISOString(),
        to: startsAt.toISOString(),
        depositCarriedFils: row.depositFils,
        holdTransactionId: row.holdTransactionId,
        noShowReturnDueAt: noShowReturnDueAt.toISOString(),
      },
      ipAddress: ctx.ipAddress ?? null,
      userAgent: ctx.userAgent ?? null,
    });

    return {
      booking: serialiseBooking(updated as BookingRow),
      depositCarriedFils: row.depositFils,
      /**
       * The hold is unchanged, and saying so is the point of the endpoint.
       *
       * `?? ''` IS UNREACHABLE AND IS NOT A DEFAULT. `hold_transaction_id` became
       * nullable in 0056, but this is the CUSTOMER's reschedule: the row was
       * matched on `member_id = <her id>` and `status = 'deposit_held'`, and
       * `booking_deposit_matches_hold` plus `booking_guest_requires_merchant_source`
       * make a member-owned `app` row one that has a hold. Written rather than
       * asserted so the compiler carries the narrowing instead of a reader.
       */
      holdTransactionId: row.holdTransactionId ?? '',
    };
  });
}

// -------------------------------------------------------------------- reads --

export async function listMemberBookings(
  db: Db,
  memberId: string,
  statuses?: Array<BookingRow['status']>,
) {
  const rows = await db
    .select()
    .from(booking)
    .where(
      statuses && statuses.length > 0
        ? and(eq(booking.memberId, memberId), inArray(booking.status, statuses))
        : eq(booking.memberId, memberId),
    )
    .orderBy(asc(booking.startsAt))
    .limit(100);
  return rows.map((r) => serialiseBooking(r as BookingRow));
}

// =========================================================================
// THE MERCHANT'S OWN APPOINTMENTS — client asks 5 and 6
// =========================================================================
/**
 * "Admin can create appointments manually, for existing or non-existing
 * customers", and "mark / cancel / change date / reassign employee".
 *
 * Five functions, all of them on the same table and the same exclusion
 * constraint as `POST /bookings`. That is the design: db/schema/booking.ts
 * carries the argument for one table rather than two, and it comes down to a
 * single line — an `EXCLUDE USING gist` cannot span two tables, so a walk-in in
 * a `manual_appointment` table and a customer who paid a deposit could be sold
 * the same chair with nothing in the database saying so.
 *
 * ---------------------------------------------------------------------
 * A MERCHANT BOOKING MOVES NO MONEY. NOT EVEN FOR AN EXISTING MEMBER.
 * ---------------------------------------------------------------------
 * No transaction row, no ledger entry, no touch of `member.balance_fils`. A
 * merchant-created booking for an EXISTING member could technically debit her
 * wallet for the salon's deposit, and must not: non-negotiable #2 gives the
 * server the balance, and a merchant who can move a customer's money by filling
 * in a form is a merchant who can move it without her. The same reasoning that
 * stops a merchant sending a customer a message (#8).
 *
 * `booking_merchant_is_zero_deposit` and `booking_deposit_matches_hold` make
 * that a database fact rather than this file's good intention.
 *
 * ---------------------------------------------------------------------
 * THE CHANGE WINDOW DOES NOT APPLY TO THE SALON
 * ---------------------------------------------------------------------
 * `assertChangeWindowOpen` refuses a CUSTOMER inside the last hour because
 * "after that the deposit stays with the salon". That window protects the
 * SALON'S claim against the CUSTOMER. The salon does not need protecting from
 * itself: a front desk moving a 16:45 at 16:30 because the artist is running
 * late is the normal case, and refusing it makes the feature useless at exactly
 * the moment it is needed. So none of the functions below call it, and a reader
 * looking for the call will find this paragraph where it would have been.
 *
 * ---------------------------------------------------------------------
 * AND NEITHER DOES THE AVAILABILITY GRID
 * ---------------------------------------------------------------------
 * `createBooking` validates `startsAt` against `computeAvailability` because a
 * CUSTOMER naming her own slot could book at 03:00 or inside a sliver of the
 * grid. The grid is the salon's PUBLICATION of when it will see customers, and
 * three of the four things it encodes are not a rule about the salon's own
 * diary: the working window (the artist staying late for a regular), the slot
 * alignment (a 16:50 squeeze-in), and closed days. The fourth — "that time is
 * taken" — is the one that matters, and it is not enforced by the grid here but
 * by `booking_artist_slot_no_overlap`, which is strictly stronger: the grid is a
 * read that can go stale between the check and the insert, and the constraint
 * cannot. A front desk refused a walk-in because the published grid says 16:45
 * and the customer is standing there at 16:50 would go back to the paper diary,
 * which is the outcome this feature exists to prevent.
 *
 * SO THE DOUBLE-BOOK GUARANTEE IS THE CONSTRAINT AND NOTHING ELSE, on every path
 * below. `isExclusionViolation` is what each route turns into `slot_taken`.
 *
 * ---------------------------------------------------------------------
 * NOT MODULE-GATED, and that is `assertBookingReadable`'s own rule rather than
 * an omission: it returns early for every staff principal because "staff set a
 * roster and its hours before the salon opens for appointments", and
 * `GET /salons/{id}/bookings` — the board these controls are drawn on — is
 * ungated for the same reason. A gate here and not there would be a control on
 * the write with no screen behind it.
 */

export interface MerchantBookingContext {
  principal: StaffPrincipal;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** The duration of a hand-written appointment: the artist's own slot length. */
async function artistForSalon(
  tx: Executor,
  artistId: string,
  salonId: string,
): Promise<typeof artist.$inferSelect> {
  const [a] = await (tx as Db)
    .select()
    .from(artist)
    .where(and(eq(artist.id, artistId), eq(artist.salonId, salonId)))
    .limit(1);
  // Same 404 for "no such artist" and "not in your salon" — another salon's
  // roster is not something a caller gets to probe by status code.
  if (!a) throw notFound('unknown_artist', 'No such artist.');
  if (!a.active) throw conflict('artist_not_bookable', 'That artist is not taking bookings.');
  return a;
}

/**
 * Every `startsAt` a caller sends — customer booking, customer reschedule,
 * merchant booking, merchant reschedule — goes through here, and it must carry
 * its offset. The slot check alone would NOT catch a zoneless one: on a UTC host
 * "2026-09-30T10:00" is 13:00 Kuwait, which is usually a real, free slot, and the
 * customer would be booked three hours after the time she picked.
 */
function parseStartsAt(raw: string): Date {
  return parseInstant(raw, { field: 'startsAt', code: 'invalid_starts_at' });
}

export interface CreateMerchantBookingInput {
  salonId: string;
  artistId: string;
  serviceId: string;
  startsAt: string;
  /** Exactly one of these two halves. The route has already refused both/neither. */
  memberId: string | null;
  guestName: string | null;
  guestPhone: string | null;
  idempotency: BookingIdempotency;
}

/** POST /salons/{id}/bookings — the front desk writes one down. */
export async function createMerchantBooking(
  db: Db,
  input: CreateMerchantBookingInput,
  ctx: MerchantBookingContext,
) {
  return db.transaction(async (tx) => {
    // The key first, inside the transaction that carries the effect — the same
    // ordering `createBooking` and `markNoShow` use.
    const keyId = await claimKey(tx, input.idempotency);

    const [s] = await tx.select().from(salon).where(eq(salon.id, input.salonId)).limit(1);
    if (!s) throw notFound('unknown_salon', 'No such salon.');

    const a = await artistForSalon(tx, input.artistId, input.salonId);

    const [svc] = await tx
      .select()
      .from(service)
      .where(
        and(
          eq(service.id, input.serviceId),
          eq(service.salonId, input.salonId),
          eq(service.active, true),
        ),
      )
      .limit(1);
    if (!svc) throw notFound('unknown_service', 'No such service.');

    // The front desk is held to the same rule as the customer — migration 0061.
    await assertArtistPerformsService(tx, a, svc);

    /**
     * THE MEMBER, WHEN THERE IS ONE — and she must be one of this salon's.
     *
     * NOT LOCKED. `returnDeposit`'s header fixes the global lock order as member
     * then booking precisely because money paths take both; this path takes no
     * money, reads no balance and writes none, so there is nothing for a lock to
     * serialise. The row is read only to establish that she exists and is this
     * salon's customer.
     */
    let memberRow: typeof member.$inferSelect | null = null;
    if (input.memberId) {
      const [m] = await tx
        .select()
        .from(member)
        .where(and(eq(member.id, input.memberId), eq(member.salonId, input.salonId)))
        .limit(1);
      if (!m) throw notFound('unknown_member', 'No such customer.');
      /**
       * AN ERASED MEMBER IS NOT BOOKABLE. `services/erasure.ts` scrubbed her name
       * to a tombstone and her phone to a `+990` placeholder at her own request;
       * hanging a future appointment off that row would be the salon re-acquiring
       * a customer who asked to be forgotten. The front desk can write her down as
       * a guest if she is standing there, which is a new fact she just gave them.
       */
      if (m.erasedAt !== null) {
        throw conflict('member_erased', 'That customer account has been deleted.');
      }
      memberRow = m;
    }

    const startsAt = parseStartsAt(input.startsAt);
    const now = new Date();

    /**
     * THE LENGTH IS THE ARTIST'S SLOT, not a number the client sends.
     *
     * `computeAvailability` builds the customer's grid out of `artist.slotMinutes`
     * and `createBooking` takes its `endsAt` from that grid, so this is the same
     * number arrived at without the grid. A client-supplied duration would be a
     * client sizing its own exclusion range — a five-minute appointment that
     * overlaps nothing, written over the top of a real one.
     */
    const durationMin = a.slotMinutes;
    const endsAt = new Date(startsAt.getTime() + durationMin * 60_000);

    // From the artist, exactly as `createBooking` resolves it. One artist belongs
    // to one branch, so where the appointment is is a fact about who performs it.
    const branch = await resolveBranch(tx, input.salonId, a.branchId);

    /**
     * STAMPED EVEN THOUGH NOTHING WILL EVER READ IT ON THIS ROW. The column is NOT
     * NULL and means "when the deposit is due back"; on a zero-deposit row there
     * is no deposit, and `services/noShowWorker.ts` now filters on
     * `hold_transaction_id IS NOT NULL` so the job never sees it. Stamped with the
     * same arithmetic anyway rather than with a sentinel, so the column means one
     * thing on every row.
     */
    const noShowReturnDueAt = new Date(endsAt.getTime() + s.noShowReturnMinutes * 60_000);

    const bkId = await nextBookingId(tx);

    const [row] = await tx
      .insert(booking)
      .values({
        id: bkId,
        salonId: input.salonId,
        branchId: branch.branchId,
        branchAssumed: !branch.established,
        memberId: input.memberId,
        guestName: input.guestName,
        guestPhone: input.guestPhone,
        artistId: a.id,
        serviceId: svc.id,
        startsAt,
        endsAt,
        durationMin,
        /**
         * ZERO, AND THERE IS NO HOLD BEHIND IT. Not a default being relied on —
         * written, because this literal is non-negotiable #2 at the only place a
         * merchant could have taken a customer's money by filling in a form.
         */
        depositFils: fils(0),
        holdTransactionId: null,
        status: 'deposit_held',
        source: 'merchant',
        noShowReturnDueAt,
        calendarSyncState: 'not_applicable',
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row) throw new Error('booking insert returned no row');

    /**
     * `rules`, NOT `money`. Nothing moved, and a `money` row with a zero amount
     * would be a line in the Money filter that a merchant reading a
     * reconciliation has to skip past — `rescheduleBooking` settled the same
     * question the same way.
     */
    await writeAudit(tx, ctx.principal, {
      salonId: input.salonId,
      kind: 'rules',
      action: 'Appointment created',
      detail:
        `${memberRow ? memberRow.name : input.guestName} · ${svc.name} with ${a.name} · ` +
        `${startsAt.toISOString()}`,
      source: 'merchant',
      subjectType: 'booking',
      subjectId: bkId,
      metadata: {
        bookingId: bkId,
        memberId: input.memberId,
        /** The NAME, never the number. A guest's phone is not audit-log material. */
        guest: input.guestName !== null,
        artistId: a.id,
        serviceId: svc.id,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        branchAssumed: !branch.established,
      },
      ipAddress: ctx.ipAddress ?? null,
      userAgent: ctx.userAgent ?? null,
    });

    const result = { booking: serialiseBooking(row as BookingRow) };
    await completeKey(tx, keyId, { status: 201, body: result });
    return result;
  });
}

/**
 * The row this endpoint is about, locked, with its status re-read under the
 * lock. Shared by reschedule, reassign and complete — the three that move no
 * money and therefore need no member lock, so the whole lock-order question
 * (`returnDeposit` § THE LOCK ORDER IS MEMBER, THEN BOOKING) does not arise.
 *
 * SCOPED TO THE SALON IN THE PATH, which `requireSameSalon` has already checked
 * against the caller's own. Another salon's booking is a 404 rather than a 403:
 * a 403 would confirm the id names a real appointment somewhere.
 */
async function lockLiveBooking(
  tx: Executor,
  salonId: string,
  bookingId: string,
  /**
   * THE REFUSAL IS A FUNCTION OF THE STATUS IT HIT, not one sentence for three
   * different facts. `markNoShow` established the shape: a caller must be told BY
   * NAME which terminal state it landed on, because "you already did this" and
   * "this is not a thing you can do" are different answers and a client renders
   * them differently.
   */
  refusal: (status: BookingRow['status']) => { code: string; message: string },
): Promise<typeof booking.$inferSelect> {
  const [row] = await (tx as Db)
    .select()
    .from(booking)
    .where(and(eq(booking.id, bookingId), eq(booking.salonId, salonId)))
    .for('update')
    .limit(1);
  if (!row) throw notFound('unknown_booking', 'No such appointment.');
  if (row.status !== 'deposit_held') {
    const { code, message } = refusal(row.status);
    throw conflict(code, message, { status: row.status });
  }
  return row;
}

/** The three sentences the four merchant transitions share, keyed on `verb`. */
function terminalRefusal(
  verb: 'changed' | 'cancelled' | 'marked as completed',
): (status: BookingRow['status']) => { code: string; message: string } {
  const code =
    verb === 'cancelled' ? 'not_cancellable' : verb === 'changed' ? 'not_changeable' : 'not_completable';
  return (status) => {
    if (status === 'cancelled') {
      return verb === 'cancelled'
        ? { code: 'already_cancelled', message: 'That appointment was already cancelled.' }
        : { code, message: `That appointment was cancelled, so it cannot be ${verb}.` };
    }
    if (status === 'completed') {
      return verb === 'marked as completed'
        ? { code: 'already_completed', message: 'That appointment is already marked as completed.' }
        : { code, message: `That appointment has already happened, so it cannot be ${verb}.` };
    }
    return {
      code,
      message: `That appointment was marked as a no-show, so it cannot be ${verb}.`,
    };
  };
}

/** POST /salons/{id}/bookings/{id}/reschedule — move the date and time. */
export async function rescheduleByMerchant(
  db: Db,
  params: { salonId: string; bookingId: string; startsAt: string },
  ctx: MerchantBookingContext,
): Promise<{
  booking: ReturnType<typeof serialiseBooking>;
  /**
   * `number`, NOT `Fils`, EXACTLY AS `rescheduleBooking` DECLARES IT. The brand
   * lives in `@avo/types`'s dist and cannot be named from an inferred return
   * type here; more to the point, this is a wire value on its way out through
   * `reply.send`, and the branded type's job is to stop arithmetic, which ended
   * the moment the number was read off the row.
   */
  depositCarriedFils: number;
}> {
  return db.transaction(async (tx) => {
    const row = await lockLiveBooking(tx, params.salonId, params.bookingId, terminalRefusal('changed'));

    const startsAt = parseStartsAt(params.startsAt);
    if (startsAt.getTime() === row.startsAt.getTime()) {
      throw badRequest('same_slot', 'That is the time the appointment is already at.');
    }

    const [s] = await tx.select().from(salon).where(eq(salon.id, row.salonId)).limit(1);
    if (!s) throw notFound('unknown_salon', 'No such salon.');

    // The customer's reschedule's rule, for the same reason — migration 0061.
    await assertBookedPairAssigned(tx, row.artistId, row.serviceId);

    /**
     * THE LENGTH IS CARRIED, NOT RECOMPUTED. This endpoint moves an appointment;
     * it does not resize one. Recomputing from `artist.slotMinutes` would silently
     * change the length of every existing booking the moment a merchant edited
     * that setting, which is a different edit than the one she asked for.
     */
    const endsAt = new Date(startsAt.getTime() + row.durationMin * 60_000);
    const noShowReturnDueAt = automaticSettleAt(row as BookingRow, endsAt, s.noShowReturnMinutes);
    const now = new Date();

    const [updated] = await tx
      .update(booking)
      .set({
        startsAt,
        endsAt,
        // Recomputed, not carried: on a deposit-bearing booking the promise is
        // about the NEW slot. `rescheduleBooking` settles this the same way.
        noShowReturnDueAt,
        rescheduledCount: row.rescheduledCount + 1,
        rescheduledAt: now,
        updatedAt: now,
      })
      /**
       * `status = 'deposit_held'` IN THE WHERE, for `rescheduleBooking`'s reason:
       * lane D removed that handler's status check and the suite stayed green, so
       * the guard belongs in the write and not only above it.
       */
      .where(and(eq(booking.id, row.id), eq(booking.status, 'deposit_held')))
      .returning();
    if (!updated) {
      throw conflict('not_reschedulable', 'That appointment can no longer be changed.', {
        bookingId: row.id,
      });
    }

    await writeAudit(tx, ctx.principal, {
      salonId: row.salonId,
      kind: 'rules',
      action: 'Appointment rescheduled',
      detail: `${row.startsAt.toISOString()} → ${startsAt.toISOString()}`,
      source: 'merchant',
      subjectType: 'booking',
      subjectId: row.id,
      metadata: {
        bookingId: row.id,
        from: row.startsAt.toISOString(),
        to: startsAt.toISOString(),
        /**
         * ON A DEPOSIT-BEARING BOOKING THE DEPOSIT CARRIES, exactly as it does on
         * the customer's own reschedule: no transaction, no ledger entry, the same
         * hold against the same row. 0 when there was nothing to carry.
         */
        depositCarriedFils: row.depositFils,
        noShowReturnDueAt: noShowReturnDueAt.toISOString(),
      },
      ipAddress: ctx.ipAddress ?? null,
      userAgent: ctx.userAgent ?? null,
    });

    return {
      booking: serialiseBooking(updated as BookingRow),
      depositCarriedFils: row.depositFils,
    };
  });
}

/** POST /salons/{id}/bookings/{id}/reassign — a different artist takes it. */
export async function reassignArtist(
  db: Db,
  params: { salonId: string; bookingId: string; artistId: string },
  ctx: MerchantBookingContext,
) {
  return db.transaction(async (tx) => {
    const row = await lockLiveBooking(tx, params.salonId, params.bookingId, terminalRefusal('changed'));

    if (row.artistId === params.artistId) {
      throw badRequest('same_artist', 'That is the artist the appointment is already with.');
    }

    const a = await artistForSalon(tx, params.artistId, params.salonId);

    /**
     * THE NEW ARTIST MUST DO THIS SERVICE (migration 0061). This is the path the
     * rule most needs: "reassign to whoever is free" is exactly how a manicure
     * ends up in a colourist's diary. Checked after `artistForSalon`, so another
     * salon's artist is still `unknown_artist` and not a 409 confirming it.
     */
    await assertBookedPairAssigned(tx, a.id, row.serviceId);

    /**
     * THE BRANCH MOVES WITH THE ARTIST, because `createBooking` established that a
     * booking's branch is a fact about who performs it rather than a client
     * assertion. Reassigning to an artist at Salmiya makes the appointment a
     * Salmiya appointment, and leaving `branch_id` pointing at Kuwait City would
     * put it in a reporting bucket where nobody is performing it.
     *
     * A DEPOSIT-BEARING BOOKING KEEPS ITS HOLD'S BRANCH ON THE LEDGER, which is
     * the honest split rather than an inconsistency: `returnDeposit` inherits the
     * branch from the hold transaction ("claiming `false` here would launder a
     * guessed branch into an established one"), so the money stays attributed
     * where it was taken and the appointment moves where it will happen. The same
     * shape as a customer who books at Salmiya and pays at Kuwait City.
     */
    const branch = await resolveBranch(tx, params.salonId, a.branchId);
    const now = new Date();

    const [updated] = await tx
      .update(booking)
      .set({
        artistId: a.id,
        branchId: branch.branchId,
        branchAssumed: !branch.established,
        updatedAt: now,
      })
      .where(and(eq(booking.id, row.id), eq(booking.status, 'deposit_held')))
      .returning();
    if (!updated) {
      throw conflict('not_changeable', 'That appointment can no longer be changed.', {
        bookingId: row.id,
      });
    }

    await writeAudit(tx, ctx.principal, {
      salonId: row.salonId,
      kind: 'rules',
      action: 'Appointment reassigned',
      detail: `${row.artistId} → ${a.name}`,
      source: 'merchant',
      subjectType: 'booking',
      subjectId: row.id,
      metadata: {
        bookingId: row.id,
        fromArtistId: row.artistId,
        toArtistId: a.id,
        branchId: branch.branchId,
        branchAssumed: !branch.established,
      },
      ipAddress: ctx.ipAddress ?? null,
      userAgent: ctx.userAgent ?? null,
    });

    return { booking: serialiseBooking(updated as BookingRow) };
  });
}

/**
 * POST /salons/{id}/bookings/{id}/complete — mark it done.
 *
 * ONLY ON A ZERO-DEPOSIT BOOKING, and the refusal is the design rather than a
 * limitation. Completing a deposit-bearing booking has to name the charge that
 * CONSUMED the hold — `booking_settlement_matches_status` requires
 * `settled_transaction_id` on a `completed` row that has a hold, and there is
 * exactly one place that transaction is written: `POST /charges`, at the
 * scanner, where `findApplicableHold` turns the deposit into a credit line
 * against the real price. A second path to `completed` would either invent a
 * transaction for money it did not move, or strand a held deposit in a
 * `deposit_held` ledger account with no booking left pointing at it.
 *
 * So a merchant booking is completed here and an app booking is completed at the
 * counter, and this function says which by refusing rather than by guessing.
 */
export async function completeBooking(
  db: Db,
  params: { salonId: string; bookingId: string },
  ctx: MerchantBookingContext,
) {
  return db.transaction(async (tx) => {
    const row = await lockLiveBooking(
      tx,
      params.salonId,
      params.bookingId,
      terminalRefusal('marked as completed'),
    );

    if (row.holdTransactionId !== null) {
      throw conflict(
        'deposit_completed_at_the_counter',
        'That appointment has a deposit held against it. Ringing up the charge at ' +
          'the counter completes it and applies the deposit to the bill.',
        { bookingId: row.id, depositFils: row.depositFils },
      );
    }

    const now = new Date();
    const [updated] = await tx
      .update(booking)
      .set({ status: 'completed', completedAt: now, updatedAt: now })
      /**
       * `hold_transaction_id IS NULL` IS IN THE WHERE AS WELL AS ABOVE, because
       * the check above is the one a reader deletes and this is the one that holds
       * when they do. Without it a completed app booking would carry
       * `settled_transaction_id IS NULL` and be refused by
       * `booking_settlement_matches_status` — a 500 where a 409 belongs.
       */
      .where(
        and(
          eq(booking.id, row.id),
          eq(booking.status, 'deposit_held'),
          sql`${booking.holdTransactionId} IS NULL`,
        ),
      )
      .returning();
    if (!updated) {
      throw conflict('not_completable', 'That appointment can no longer be marked as completed.', {
        bookingId: row.id,
      });
    }

    await writeAudit(tx, ctx.principal, {
      salonId: row.salonId,
      kind: 'rules',
      action: 'Appointment completed',
      detail: `${row.startsAt.toISOString()} · no deposit`,
      source: 'merchant',
      subjectType: 'booking',
      subjectId: row.id,
      metadata: { bookingId: row.id, startsAt: row.startsAt.toISOString() },
      ipAddress: ctx.ipAddress ?? null,
      userAgent: ctx.userAgent ?? null,
    });

    return { booking: serialiseBooking(updated as BookingRow) };
  });
}

/**
 * POST /salons/{id}/bookings/{id}/cancel — call it off.
 *
 * TWO PATHS, ONE ENDPOINT, AND THE ROW DECIDES WHICH. On an app booking a real
 * deposit goes back to a real wallet through `returnDeposit` — the same function
 * the worker, the customer's own cancel and `markNoShow` all call. On a merchant
 * booking nothing was taken, so nothing is returned and the row simply becomes
 * `cancelled`.
 *
 * THE PERMISSION IS `void` FOR BOTH, AND THAT IS ARGUED. A gate that varied by
 * `deposit_fils` would be horrible to reason about and would break
 * `e2e/permission-census.test.ts`'s granted mirror, which grants exactly one
 * permission and requires the refusal to stop — a conjunctive or conditional gate
 * has no single permission to grant. So it is `void` for every cancel, which is
 * where `markNoShow` already sits and for the same two reasons: cancelling an app
 * booking returns money to a customer, and a cancellation is a record about a
 * slot the salon had committed to.
 *
 * NO IDEMPOTENCY KEY, for `cancelBooking`'s reason: this names one resource with
 * one live state, and the transition out of `deposit_held` happens under
 * `FOR UPDATE` inside this transaction. A second cancel blocks on the row lock,
 * re-reads a status that is no longer `deposit_held`, and is answered
 * `already_cancelled`. That holds for two DIFFERENT keys as well as for one
 * repeated, which a key does not.
 */
export async function cancelByMerchant(
  db: Db,
  params: { salonId: string; bookingId: string },
  ctx: MerchantBookingContext,
): Promise<{
  booking: ReturnType<typeof serialiseBooking>;
  refundedFils: number;
  balanceAfterFils: number | null;
  transactionId: string | null;
}> {
  return db.transaction(async (tx) => {
    /**
     * UNLOCKED, to learn whether there is money and whose it is. `returnDeposit`'s
     * header says why the member row has to be locked FIRST when there is one: the
     * global order is member then booking, and a cancel that locked the booking
     * first would deadlock against a charge on the same customer. The re-check
     * under the lock below is what makes this probe safe.
     */
    const [probe] = await tx
      .select({ memberId: booking.memberId, holdTransactionId: booking.holdTransactionId })
      .from(booking)
      .where(and(eq(booking.id, params.bookingId), eq(booking.salonId, params.salonId)))
      .limit(1);
    if (!probe) throw notFound('unknown_booking', 'No such appointment.');

    let memberRow: typeof member.$inferSelect | null = null;
    if (probe.holdTransactionId !== null && probe.memberId !== null) {
      const [m] = await tx
        .select()
        .from(member)
        .where(eq(member.id, probe.memberId))
        .for('update')
        .limit(1);
      if (!m) throw notFound('unknown_member', 'No such member.');
      memberRow = m;
    }

    const row = await lockLiveBooking(
      tx,
      params.salonId,
      params.bookingId,
      terminalRefusal('cancelled'),
    );

    const now = new Date();

    // ------------------------------------------------ the deposit-bearing one --
    if (row.holdTransactionId !== null) {
      if (!memberRow) {
        /**
         * UNREACHABLE, and said rather than assumed. `booking_deposit_matches_hold`
         * plus `booking_merchant_is_zero_deposit` plus
         * `booking_guest_requires_merchant_source` together mean a row with a hold
         * is an `app` row and therefore names a member. If the probe saw no hold
         * and the locked row has one, something changed the row under us in a way
         * no writer in this API can — refuse rather than proceed without the lock
         * the money path requires.
         */
        throw conflict('not_cancellable', 'That appointment can no longer be cancelled.', {
          bookingId: row.id,
        });
      }
      /**
       * THE WHOLE DEPOSIT, WHATEVER THE POLICY SAYS. Trunk's ruling: when the salon
       * cancels, she did nothing wrong. So the stamped cancellation rules are not
       * read here at all — they describe HER cancelling — and this is the same
       * full return the path made before 0066.
       */
      const returned = await returnDeposit(tx, {
        row: row as BookingRow,
        memberRow,
        reason: 'cancelled',
        principal: ctx.principal,
        now,
        note: 'Cancelled at the salon',
        ipAddress: ctx.ipAddress ?? null,
        userAgent: ctx.userAgent ?? null,
      });
      return {
        // Reloaded, so `settlement` says the whole deposit came back.
        booking: serialiseBooking(await reloadBooking(tx, row.id)),
        refundedFils: row.depositFils,
        balanceAfterFils: returned.balanceAfterFils,
        transactionId: returned.transactionId,
      };
    }

    // ---------------------------------------------------- the moneyless one --
    const [updated] = await tx
      .update(booking)
      .set({ status: 'cancelled', cancelledAt: now, updatedAt: now })
      /**
       * `hold_transaction_id IS NULL` in the WHERE for `completeBooking`'s reason:
       * a hold that appeared between the branch above and this statement would
       * otherwise leave a cancelled booking with no `settled_transaction_id` and a
       * deposit still sitting in the `deposit_held` account.
       */
      .where(
        and(
          eq(booking.id, row.id),
          eq(booking.status, 'deposit_held'),
          sql`${booking.holdTransactionId} IS NULL`,
        ),
      )
      .returning();
    if (!updated) {
      throw conflict('not_cancellable', 'That appointment can no longer be cancelled.', {
        bookingId: row.id,
      });
    }

    await writeAudit(tx, ctx.principal, {
      salonId: row.salonId,
      kind: 'rules',
      action: 'Appointment cancelled',
      detail: `${row.startsAt.toISOString()} · no deposit to return`,
      source: 'merchant',
      subjectType: 'booking',
      subjectId: row.id,
      metadata: { bookingId: row.id, startsAt: row.startsAt.toISOString() },
      ipAddress: ctx.ipAddress ?? null,
      userAgent: ctx.userAgent ?? null,
    });

    /**
     * `refundedFils: 0` AND `transactionId: null`, PRESENT RATHER THAN OMITTED.
     * The two shapes this endpoint returns have to be distinguishable by a client
     * without it guessing from which keys are missing — the same argument
     * `chargeVoided` and `depositReturnedFils` make on their own responses.
     */
    return {
      booking: serialiseBooking(updated as BookingRow),
      refundedFils: 0,
      balanceAfterFils: null,
      transactionId: null,
    };
  });
}
