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

import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import { add, fils, subtract, type Fils } from '@avo/types';
import type { Db } from '../db/client';
import { artist } from '../db/schema/artist';
import { booking } from '../db/schema/booking';
import { ledgerEntry } from '../db/schema/ledger';
import { member } from '../db/schema/member';
import { salon } from '../db/schema/salon';
import { service } from '../db/schema/service';
import { transaction } from '../db/schema/transaction';
import type { MemberPrincipal, Principal } from '../auth/principal';
import { env } from '../env';
import { badRequest, conflict, insufficientBalance, notFound } from '../http/errors';
import { parseDate, salonWallClock } from '../time/zone';
import { computeAvailability, findSlot } from './availability';
import { writeAudit, type Executor } from './audit';
import { resolveBranch } from './branch';
import { claimKey, completeKey } from './idempotency';
import { queueReceipts } from './receipts';

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

function bookingId(): string {
  return `BK-${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;
}

function transactionId(): string {
  return `TX-${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;
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
  memberId: string;
  artistId: string;
  branchId: string;
  serviceId: string;
  startsAt: Date;
  endsAt: Date;
  durationMin: number;
  depositFils: number;
  status: 'deposit_held' | 'completed' | 'no_show_returned' | 'cancelled';
  source: 'app' | 'google_calendar';
  noShowReturnDueAt: Date;
  rescheduledCount: number;
  calendarSyncState: 'not_applicable' | 'pending' | 'synced' | 'failed';
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
  };
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
 * Earliest first, so a customer with two appointments in one afternoon settles
 * them in order.
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
      ),
    )
    .orderBy(asc(booking.startsAt))
    .limit(1)
    .$dynamic();

  if (options.forUpdate) query = query.for('update');

  const rows = await query;
  const row = rows[0];
  if (!row) return null;
  // Applied here rather than in SQL so the comparison is against the same
  // `now` the charge is using for everything else, not against the database's
  // clock a few milliseconds later.
  if (row.noShowReturnDueAt <= params.now) return null;
  return row as BookingRow;
}

// -------------------------------------------------------------- POST /bookings --

export interface CreateBookingInput {
  artistId: string;
  serviceId: string;
  /** ISO instant. Validated against the server's own availability grid. */
  startsAt: string;
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
    const startsAt = new Date(input.startsAt);
    if (Number.isNaN(startsAt.getTime())) {
      throw badRequest('invalid_starts_at', 'startsAt must be an ISO instant.');
    }
    const now = new Date();
    // The salon's calendar date for that instant — never the server's. A booking
    // at 22:00 Kuwait time on the 19th is the 19th, whatever UTC calls it.
    const localDate = salonWallClock(startsAt, s.timezone).date;

    const availability = await computeAvailability(
      db,
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
    const branch = await resolveBranch(tx, m.salonId, undefined);

    const txId = transactionId();
    const bkId = bookingId();

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
    await tx.insert(ledgerEntry).values([
      {
        transactionId: txId,
        salonId: m.salonId,
        memberId: m.id,
        account: 'member_wallet',
        direction: 'debit',
        amountFils: deposit,
        balanceAfterFils: balanceAfter,
      },
      {
        transactionId: txId,
        salonId: m.salonId,
        memberId: null,
        account: 'deposit_held',
        direction: 'credit',
        amountFils: deposit,
      },
    ]);

    /**
     * The no-show deadline, STAMPED. `salon.no_show_return_minutes` is editable
     * and this is a promise made to this customer about this appointment; see
     * db/schema/booking.ts for why it is measured from `ends_at`.
     */
    const noShowReturnDueAt = new Date(
      endsAt.getTime() + s.noShowReturnMinutes * 60_000,
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
      },
      ipAddress: ctx.ipAddress ?? null,
      userAgent: ctx.userAgent ?? null,
    });

    const result = {
      booking: serialiseBooking(row as BookingRow),
      balanceAfterFils: balanceAfter,
      transaction: {
        id: txId,
        memberId: m.id,
        branchId: branch.branchId,
        kind: 'deposit_hold' as const,
        amountFils: -deposit,
        bonusFils: 0,
        method: 'wallet' as const,
        status: 'settled' as const,
        reference: `AVO-DEP-${txId.slice(3)}`,
        createdAt: now.toISOString(),
      },
    };

    await completeKey(tx, keyId, { status: 201, body: result }, txId);
    return result;
  });
}

// ------------------------------------------------------------- the return --

/**
 * Give the deposit back. Shared by cancel and by the no-show job.
 *
 * Called with the booking row ALREADY LOCKED and its status already checked by
 * the caller — this writes, it does not decide.
 *
 * THE LOCK ORDER IS MEMBER, THEN BOOKING, EVERYWHERE. It is written down here
 * because it is not local: `performCharge` takes the member row `FOR UPDATE` as
 * its first statement and only then reaches for the held booking, and a cancel
 * or a no-show return that took them the other way round would deadlock against
 * a charge on the same customer — two transactions each holding what the other
 * wants, resolved by Postgres killing one of them at random. Both callers here
 * therefore read the booking UNLOCKED to learn whose it is, lock the member, and
 * only then lock the booking and re-check its status. The re-check is what makes
 * the unlocked first read safe.
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
  },
): Promise<{ transactionId: string; balanceAfterFils: Fils }> {
  const { row, memberRow, now } = params;
  const amount = fils(row.depositFils);
  const balanceAfter = add(fils(memberRow.balanceFils), amount);
  const txId = transactionId();

  await tx
    .update(member)
    .set({ balanceFils: balanceAfter, updatedAt: now })
    .where(eq(member.id, memberRow.id));

  const [held] = await tx
    .select({ branchId: transaction.branchId, branchAssumed: transaction.branchAssumed })
    .from(transaction)
    .where(eq(transaction.id, (row as unknown as { holdTransactionId: string }).holdTransactionId))
    .limit(1);

  await tx.insert(transaction).values({
    id: txId,
    memberId: memberRow.id,
    salonId: memberRow.salonId,
    branchId: held?.branchId ?? row.branchId,
    /**
     * Inherited from the hold, not re-derived — the same reasoning a void
     * inherits it from the charge it reverses. Claiming `false` here would
     * launder a guessed branch into an established one on the way back.
     */
    branchAssumed: held?.branchAssumed ?? false,
    kind: 'deposit_return',
    // Positive: the sign CHECK says a deposit_return credits.
    amountFils: amount,
    method: 'wallet',
    status: 'settled',
    reference: `AVO-DPR-${txId.slice(3)}`,
    note: params.note,
    createdAt: now,
    settledAt: now,
  });

  // The mirror of the hold: the liability is discharged back into the wallet.
  await tx.insert(ledgerEntry).values([
    {
      transactionId: txId,
      salonId: memberRow.salonId,
      memberId: null,
      account: 'deposit_held',
      direction: 'debit',
      amountFils: amount,
    },
    {
      transactionId: txId,
      salonId: memberRow.salonId,
      memberId: memberRow.id,
      account: 'member_wallet',
      direction: 'credit',
      amountFils: amount,
      balanceAfterFils: balanceAfter,
    },
  ]);

  await tx
    .update(booking)
    .set(
      params.reason === 'cancelled'
        ? {
            status: 'cancelled',
            settledTransactionId: txId,
            cancelledAt: now,
            updatedAt: now,
          }
        : {
            status: 'no_show_returned',
            settledTransactionId: txId,
            returnedAt: now,
            updatedAt: now,
          },
    )
    .where(eq(booking.id, row.id));

  await queueReceipts(tx, memberRow, txId, {
    kind: 'deposit_return',
    transactionId: txId,
    bookingId: row.id,
    amountFils: amount,
    reason: params.reason,
    balanceAfterFils: balanceAfter,
  });

  await writeAudit(tx, params.principal, {
    salonId: memberRow.salonId,
    kind: 'money',
    action: params.reason === 'cancelled' ? 'Deposit returned · cancelled' : 'Deposit returned · no-show',
    detail: `${kd(amount)} KD returned to ${memberRow.name} · ${params.note}`,
    // A no-show return has no actor. `system` is what makes the audit row read
    // "System · Automatic" rather than attributing an automatic refund to
    // whoever happened to be signed in.
    source: params.reason === 'cancelled' ? 'wallet' : 'system',
    subjectType: 'booking',
    subjectId: row.id,
    amountFils: amount,
    metadata: { bookingId: row.id, transactionId: txId, reason: params.reason },
  });

  return { transactionId: txId, balanceAfterFils: balanceAfter };
}

// ------------------------------------------------------ DELETE /bookings/{id} --

/**
 * Cancel, and return the deposit.
 *
 * NO IDEMPOTENCY KEY, and that is a decision rather than an omission.
 * Non-negotiable #4 asks for a key on every money-moving POST because a POST
 * creates a new thing each time it succeeds — two charges, two top-ups. A cancel
 * names a resource that has exactly one live state, and the transition out of
 * `deposit_held` happens under `FOR UPDATE` inside this transaction. A second
 * cancel of the same booking cannot double-refund: it blocks on the row lock,
 * re-reads a status that is no longer `deposit_held`, and is answered
 * `already_cancelled`. That is the same shape as `already_voided` in
 * routes/charges.ts, and it is stronger than a key because it holds for two
 * DIFFERENT keys as well as for one repeated.
 */
export async function cancelBooking(
  db: Db,
  bookingIdParam: string,
  ctx: { principal: MemberPrincipal; ipAddress?: string | null; userAgent?: string | null },
): Promise<{
  booking: ReturnType<typeof serialiseBooking>;
  refundedFils: number;
  balanceAfterFils: number;
  transactionId: string;
}> {
  return db.transaction(async (tx) => {
    /**
     * UNLOCKED, to learn whose booking this is. See `returnDeposit`'s header for
     * why the member row has to be locked first: the global order is member, then
     * booking, and a cancel that locked the booking first would deadlock against
     * a charge on the same customer.
     */
    const [probe] = await tx
      .select({ memberId: booking.memberId })
      .from(booking)
      .where(and(eq(booking.id, bookingIdParam), eq(booking.memberId, ctx.principal.id)))
      .limit(1);
    // Scoped to the caller's own bookings. Someone else's appointment is not
    // something a customer gets to probe, so this is a 404 rather than a 403.
    if (!probe) throw notFound('unknown_booking', 'No such appointment.');

    const [m] = await tx
      .select()
      .from(member)
      .where(eq(member.id, probe.memberId))
      .for('update')
      .limit(1);
    if (!m) throw notFound('unknown_member', 'No such member.');

    // NOW the booking, locked, and its status re-read under that lock. This is
    // what makes the unlocked probe above harmless.
    const [row] = await tx
      .select()
      .from(booking)
      .where(eq(booking.id, bookingIdParam))
      .for('update')
      .limit(1);
    if (!row) throw notFound('unknown_booking', 'No such appointment.');

    if (row.status !== 'deposit_held') {
      throw conflict(
        row.status === 'cancelled' ? 'already_cancelled' : 'not_cancellable',
        row.status === 'cancelled'
          ? 'That appointment was already cancelled and the deposit is back in your wallet.'
          : row.status === 'completed'
            ? 'That appointment has already happened.'
            : 'That appointment was missed and the deposit has already been returned.',
        { status: row.status },
      );
    }

    const now = new Date();
    assertChangeWindowOpen(row, now, 'cancelled');

    const returned = await returnDeposit(tx, {
      row: row as BookingRow,
      memberRow: m,
      reason: 'cancelled',
      principal: ctx.principal,
      now,
      note: 'Cancelled by the customer',
    });

    return {
      booking: { ...serialiseBooking(row as BookingRow), status: 'cancelled' as const },
      refundedFils: row.depositFils,
      balanceAfterFils: returned.balanceAfterFils,
      transactionId: returned.transactionId,
    };
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

    const startsAt = new Date(startsAtIso);
    if (Number.isNaN(startsAt.getTime())) {
      throw badRequest('invalid_starts_at', 'startsAt must be an ISO instant.');
    }
    if (startsAt.getTime() === row.startsAt.getTime()) {
      throw badRequest('same_slot', 'That is the time the appointment is already at.');
    }

    const [s] = await tx.select().from(salon).where(eq(salon.id, row.salonId)).limit(1);
    if (!s) throw notFound('unknown_salon', 'No such salon.');

    const localDate = salonWallClock(startsAt, s.timezone).date;
    const availability = await computeAvailability(
      db,
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
    const noShowReturnDueAt = new Date(endsAt.getTime() + s.noShowReturnMinutes * 60_000);

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
      .where(eq(booking.id, row.id))
      .returning();
    if (!updated) throw notFound('unknown_booking', 'No such appointment.');

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
      /** The hold is unchanged, and saying so is the point of the endpoint. */
      holdTransactionId: row.holdTransactionId,
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
