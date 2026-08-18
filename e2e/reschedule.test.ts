/**
 * `POST /bookings/{id}/reschedule` — the slot moves, the deposit does not.
 *
 * HOW TO RUN
 *
 *   pnpm --dir ./api run db:up
 *   cd e2e && ../node_modules/.bin/vitest run reschedule.test.ts
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The endpoint had NO coverage of any kind — not one spec, in fourteen files. It
 * is a money-adjacent transition with four independent rules (the one-hour window,
 * the slot re-validation, the status guard, the recomputed no-show deadline), and
 * the only thing that had ever been asserted about it was that it exists.
 *
 * That is worse than it sounds, because the guard in the UPDATE's `WHERE` says so
 * in its own comment: "Lane D removed the handler's status check and the suite
 * stayed green, so a completed or cancelled appointment could be moved into a live
 * slot and occupy an artist's diary." The ablation that found it could only report
 * it; nothing could hold it afterwards. This file is what holds it.
 *
 * NO MONEY MOVES HERE, AND THAT IS THE ASSERTION RATHER THAN THE PREAMBLE
 * ----------------------------------------------------------------------
 * README § Upcoming appointment: "Reschedule (carries the deposit to a new slot)."
 * The deposit is still held, by the same hold, against the same booking — so the
 * path writes no transaction and no ledger entry, and `depositCarriedFils` is a
 * report of an unchanged fact rather than a movement. Every spec that moves a slot
 * therefore also asserts the balance, the `deposit_held` position AND the hold
 * transaction id, because "the deposit carried" is three separate claims and a
 * path that refunded and re-debited would satisfy the first one alone.
 *
 * THE WINDOW IS MEASURED AGAINST THE SLOT AS IT STANDS NOW
 * -------------------------------------------------------
 * `assertChangeWindowOpen` reads `row.startsAt`, which is what makes a reschedule
 * chain terminate: moving a 16:45 to 19:00 buys a new deadline for the 19:00, not
 * a fresh hour before a 16:45 that no longer exists. A spec at the bottom moves a
 * booking twice to pin that, because "the chain terminates" is exactly the kind of
 * property that is true by accident until someone changes which row the window
 * reads.
 *
 * THE CLOCK IS MOVED IN POSTGRES, NEVER IN JAVASCRIPT
 * --------------------------------------------------
 * Same rule as `promotions.test.ts` and for the same reason: the API resolves a
 * salon's wall clock through its own `salon.timezone`, so a fixture that computed
 * one here would be asserting that the implementation agrees with itself. Every
 * `starts_at` this file moves is written as `now() + interval`, evaluated by
 * Postgres. This file needs no midday anchor — it positions instants, not
 * times-of-day, so nothing it writes can straddle midnight.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { precondition } from './support/known-bug.js';
import {
  SALON_A,
  psql,
  scalar,
  signInMember,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

/**
 * This file's own member, cloned from the seeded QA member so the password hash
 * `signInMember` sends is the one on the row. Her own member id and phone, so no
 * other file's balance assertions can be disturbed by a booking made here.
 */
const MEMBER = 'QA-RES-0001';
const MEMBER_PHONE = '+96555880001';
const MEMBER_OPENING_FILS = 200_000;
const CLONE_SOURCE = 'QA-GW-0001';

/**
 * A SECOND member, so the cross-customer spec can build its own subject.
 *
 * The first draft read "any booking belonging to somebody else" out of the
 * database, which passed in the full suite and failed when this file ran alone:
 * `deposit.test.ts`'s bookings do not exist in a run that does not include it. A
 * spec whose subject is another file's leftover state passes or fails by run
 * order, which is the property this suite spent four incidents removing.
 */
const OTHER_MEMBER = 'QA-RES-0002';
const OTHER_PHONE = '+96555880002';

/**
 * `AR-004` is the artist `deposit.test.ts` uses for its cancel block, and using
 * the same one here is deliberate rather than lazy: this file only ever moves its
 * OWN bookings, and an artist whose diary already has a suite pointed at it is one
 * whose windows are known to be open nine days out.
 */
const ARTIST = 'AR-004';
const MANICURE = 'SV-04';
const DEPOSIT_FILS = 5_000;

let member = '';
/** The second customer, whose appointment the first one must not be able to touch. */
let other = '';
let n = 0;
const key = (label: string) => `res-${label}-${Date.now()}-${n++}`;

const balanceOf = (): number =>
  Number(scalar(`select balance_fils from member where id='${MEMBER}'`));

/**
 * The booking's state, with both instants as EPOCH SECONDS.
 *
 * Numbers rather than `::text`, on purpose. A `timestamptz` renders as
 * `2026-08-28 10:00:00+03`, which is neither ISO 8601 nor reliably parseable by
 * `new Date()` — the space and the two-digit offset are both non-standard. Every
 * comparison this file makes on an instant is an ordering, so the epoch is the
 * honest representation and it removes the parse entirely. Postgres does the
 * conversion, which is the same rule the header states about the clock.
 */
const bookingRow = (
  id: string,
): { status: string; startsAtEpoch: number; count: number; dueAtEpoch: number } => {
  const row = scalar(
    `select status::text
            || '|' || extract(epoch from starts_at)::bigint::text
            || '|' || rescheduled_count::text
            || '|' || extract(epoch from no_show_return_due_at)::bigint::text
       from booking where id='${id}'`,
  ).trim();
  const [status, startsAt, count, dueAt] = row.split('|');
  return {
    status: status!,
    startsAtEpoch: Number(startsAt),
    count: Number(count),
    dueAtEpoch: Number(dueAt),
  };
};

/**
 * Her open `deposit_hold` position, in fils.
 *
 * The claim "the deposit carried" is not visible in the balance — a refund plus a
 * re-debit leaves the balance identical. It is visible here and in the hold
 * transaction id, which is why both are asserted beside it.
 */
const depositHeld = (): number =>
  Number(
    scalar(
      `select coalesce(sum(case when kind = 'deposit_hold' then amount_fils
                                when kind = 'deposit_return' then -amount_fils
                                else 0 end), 0)
         from transaction where member_id = '${MEMBER}'`,
    ),
  );

/** Every transaction she has, so a path that claims to move no money can be held to it. */
const transactionCount = (): number =>
  Number(scalar(`select count(*) from transaction where member_id='${MEMBER}'`));

/**
 * The hold that is against this booking. It must be the SAME row after a move.
 *
 * Read from `booking.hold_transaction_id`, which is NOT NULL — "a booking cannot
 * exist without the hold that paid for it". There is no `transaction.booking_id`
 * to join on: the reference points from the booking to the transaction, not the
 * other way, which is what makes the hold unambiguous for a booking that has been
 * moved several times.
 */
const holdTxFor = (bookingId: string): string =>
  scalar(
    `select coalesce(hold_transaction_id, '<none>') from booking where id = '${bookingId}'`,
  ).trim();

const reschedule = (bookingId: string, startsAtIso: string) =>
  treq<any>('POST', `/bookings/${bookingId}/reschedule`, {
    token: member,
    body: { startsAt: startsAtIso },
  });

/**
 * Book a real appointment, walking forward until the artist's week is open.
 *
 * The same shape `deposit.test.ts` and `contract.test.ts` use, and for the reason
 * documented there: `AR-001`'s week is closed one day, so a fixed offset lands on
 * it once every seven runs. The assertion is always on the grid, never on the
 * calendar.
 */
async function bookFutureAs(token: string): Promise<{ id: string; startsAt: string }> {
  for (let d = 9; d < 18; d++) {
    const date = new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
    const day = await treq<any>('GET', `/artists/${ARTIST}/availability?date=${date}`, {
      token,
    });
    if (day.status !== 200) continue;
    const free = (day.body?.slots ?? []).filter((s: any) => s.available === true);
    if (free.length < 3) continue;

    const booked = await treq<any>('POST', '/bookings', {
      token,
      idempotencyKey: key('book'),
      body: { artistId: ARTIST, serviceId: MANICURE, startsAt: free[0].startsAt },
    });
    if (booked.status !== 201) {
      throw new Error(`POST /bookings: ${booked.status} ${booked.raw}`);
    }
    return { id: booked.body.booking.id, startsAt: free[0].startsAt };
  }
  throw new Error(
    `${ARTIST} has no day with three free slots in the next fortnight, so this file cannot build ` +
      'a move. That is a defect in availability, not in this suite.',
  );
}

/** The common case: an appointment for the member this file is about. */
const bookFuture = (): Promise<{ id: string; startsAt: string }> => bookFutureAs(member);

/**
 * Two free slots on the same open day: the one to book, and one to move to.
 *
 * Returned together because a move needs a target that is genuinely available at
 * the moment of the move — picking one from a different request risks it having
 * been taken by this file's own earlier booking.
 */
async function freeSlotsOn(dayOffset: number): Promise<string[]> {
  const date = new Date(Date.now() + dayOffset * 86_400_000).toISOString().slice(0, 10);
  const day = await treq<any>('GET', `/artists/${ARTIST}/availability?date=${date}`, {
    token: member,
  });
  if (day.status !== 200) return [];
  return (day.body?.slots ?? [])
    .filter((s: any) => s.available === true)
    .map((s: any) => s.startsAt as string);
}

/** A slot on an open day that is NOT the one this booking is at. */
async function anotherSlot(exclude: string): Promise<string> {
  for (let d = 9; d < 18; d++) {
    const free = (await freeSlotsOn(d)).filter((s) => s !== exclude);
    if (free.length) return free[0]!;
  }
  throw new Error('no alternative slot in the next fortnight');
}

/** A free slot strictly later than `after`, for the deadline spec's direction. */
async function slotAfter(after: string): Promise<string> {
  const floor = new Date(after).getTime();
  for (let d = 9; d < 18; d++) {
    const free = (await freeSlotsOn(d)).filter((s) => new Date(s).getTime() > floor);
    if (free.length) return free[0]!;
  }
  throw new Error(`no free slot later than ${after} in the next fortnight`);
}

beforeAll(async () => {
  await startTenancyApi();

  /**
   * Cloned rather than written field by field. `member` has columns this file has
   * no opinion about — and a hand-written row that satisfies today's NOT NULLs is
   * a row that breaks the day one is added. `SELECT` from the seeded member takes
   * whatever those columns are, including the password hash `signInMember` needs.
   */
  psql(`
    INSERT INTO member (id, salon_id, name, phone, email, email_verified, password_hash,
                        balance_fils, visits, tier, stamps, policy_version, notify_wa)
    SELECT '${MEMBER}', salon_id, 'Reschedule QA', '${MEMBER_PHONE}', NULL, false,
           password_hash, ${MEMBER_OPENING_FILS}, 0, tier, stamps, policy_version, false
      FROM member WHERE id = '${CLONE_SOURCE}'
    ON CONFLICT (id) DO UPDATE SET balance_fils = ${MEMBER_OPENING_FILS};
  `);
  psql(`
    INSERT INTO member (id, salon_id, name, phone, email, email_verified, password_hash,
                        balance_fils, visits, tier, stamps, policy_version, notify_wa)
    SELECT '${OTHER_MEMBER}', salon_id, 'Reschedule QA Other', '${OTHER_PHONE}', NULL, false,
           password_hash, ${MEMBER_OPENING_FILS}, 0, tier, stamps, policy_version, false
      FROM member WHERE id = '${CLONE_SOURCE}'
    ON CONFLICT (id) DO UPDATE SET balance_fils = ${MEMBER_OPENING_FILS};
  `);
  precondition(
    scalar(`select count(*) from member where id in ('${MEMBER}','${OTHER_MEMBER}')`).trim() === '2',
    `the clone source ${CLONE_SOURCE} is missing, so this file has no members`,
  );

  member = await signInMember(SALON_A, MEMBER_PHONE);
  other = await signInMember(SALON_A, OTHER_PHONE);
}, 120_000);

afterAll(async () => {
  /**
   * HER BOOKINGS AND TRANSACTIONS ARE LEFT BEHIND, AND THE MEMBER WITH THEM.
   *
   * `transaction.member_id` and `booking.member_id` are both `onDelete: 'restrict'`,
   * and `ledger_entry` refuses deletion outright — 0024 exists to make the ledger
   * unerasable, which is the property the money core depends on. So a member who
   * has held a deposit cannot be removed, by anyone, and this teardown does not
   * pretend otherwise.
   *
   * It is harmless: the run database is minted per run and dropped by
   * `global-setup.ts`, this member's id and phone are unique to this file, and
   * every balance assertion in the suite is scoped to a member id. The alternative
   * — deleting what can be deleted and leaving the rest — is the cleanup that
   * looks complete and is not.
   */
  await stopTenancyApi();
});

// ===========================================================================

describe('a reschedule moves the slot and carries the deposit', () => {
  /**
   * THE CONTROL, AND EVERY REFUSAL BELOW DEPENDS ON IT.
   *
   * The rest of this file asserts 400s and 409s with an unmoved booking. An
   * endpoint that was broken shut — 404 on every id, or a move that silently did
   * nothing — satisfies all of them. So first: a move really moves.
   */
  it('moves the appointment, writes no money, and keeps the same hold', async () => {
    const { id, startsAt } = await bookFuture();
    const target = await anotherSlot(startsAt);

    const balanceBefore = balanceOf();
    const heldBefore = depositHeld();
    const txBefore = transactionCount();
    const holdBefore = holdTxFor(id);
    precondition(holdBefore !== '<none>', 'the booking has no deposit hold to carry');
    precondition(
      balanceBefore === MEMBER_OPENING_FILS - DEPOSIT_FILS,
      `the deposit was not debited on create: balance ${balanceBefore}`,
    );

    const res = await reschedule(id, target);

    expect(res.status, `reschedule answered ${res.status}: ${res.raw}`).toBe(200);
    expect(res.body.booking.startsAt, 'the reply reports the old slot').toBe(target);
    // Integer fils on the wire, non-negotiable #1 — never 5 or "5.000".
    expect(res.body.depositCarriedFils).toBe(DEPOSIT_FILS);
    expect(Number.isInteger(res.body.depositCarriedFils)).toBe(true);
    expect(res.body.holdTransactionId, 'the reply named a different hold').toBe(holdBefore);

    // The row really moved, out of the database rather than out of the reply.
    const row = bookingRow(id);
    expect(row.status, 'a reschedule changed the status').toBe('deposit_held');
    expect(row.startsAtEpoch, 'the booking has no start instant').toBeGreaterThan(0);
    expect(
      row.startsAtEpoch,
      'the row did not move to the requested slot',
    ).toBe(Math.floor(new Date(target).getTime() / 1000));
    expect(row.count, 'the reschedule count did not increment').toBe(1);

    /**
     * NO MONEY MOVED — three claims, because the balance alone cannot tell a
     * carried deposit from a refund followed by a re-debit.
     */
    expect(balanceOf(), 'a reschedule moved her balance').toBe(balanceBefore);
    expect(depositHeld(), 'the held position changed on a path that moves no money').toBe(heldBefore);
    expect(
      transactionCount(),
      'a reschedule wrote a transaction. The deposit is still held by the same hold against the ' +
        'same booking, so there is nothing to write.',
    ).toBe(txBefore);
    expect(holdTxFor(id), 'the hold was replaced by a new one').toBe(holdBefore);
  }, 180_000);

  /**
   * THE NO-SHOW DEADLINE IS RECOMPUTED, NOT CARRIED. "What changes is when it is
   * due back" — the promise is about the NEW slot, so a booking moved a week later
   * must not have its deposit returned on the old slot's deadline by a job that
   * knows nothing about the move.
   *
   * This is the spec that would catch `no_show_return_due_at` being left alone: the
   * status, the slot and the money would all look right, and the deposit would come
   * back while the appointment was still in the future.
   */
  it('recomputes the no-show deadline against the new slot', async () => {
    const { id, startsAt } = await bookFuture();
    const before = bookingRow(id);

    /**
     * A target strictly LATER than the slot she is at, so the deadline has to move
     * FORWARD and the direction of the assertion is unambiguous. An earlier target
     * is an equally legal move, but "the deadline moved with it" would then be
     * satisfied by a deadline that had not moved at all in the wrong direction.
     */
    const later = await slotAfter(startsAt);
    precondition(Boolean(later), 'no free slot later than the current one');

    const res = await reschedule(id, later);
    precondition(res.status === 200, `reschedule failed: ${res.raw}`);

    const after = bookingRow(id);
    expect(after.startsAtEpoch, 'the booking did not move later').toBeGreaterThan(
      before.startsAtEpoch,
    );
    expect(
      after.dueAtEpoch,
      'the no-show deadline stayed on the OLD slot, so a job would return the deposit while the ' +
        'appointment is still in the future — the status, the slot and the money would all look ' +
        'right and the salon would have lost its commitment',
    ).toBeGreaterThan(before.dueAtEpoch);
  }, 180_000);
});

// -------------------------------------------------------------- the refusals --

describe('the refusals, and each one leaves the appointment where it was', () => {
  it('same_slot — moving an appointment to the time it is already at', async () => {
    const { id, startsAt } = await bookFuture();

    const res = await reschedule(id, startsAt);

    expect(res.status, `same_slot answered ${res.status}: ${res.raw}`).toBe(400);
    expect(res.body.error).toBe('same_slot');
    expect(bookingRow(id).count, 'a refused move still counted as one').toBe(0);
  }, 180_000);

  it('invalid_starts_at — a startsAt that is not an instant', async () => {
    const { id } = await bookFuture();

    const res = await reschedule(id, 'next Tuesday');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_starts_at');
    expect(bookingRow(id).count).toBe(0);
  }, 180_000);

  it('not_a_slot — a well-formed instant the artist does not offer', async () => {
    const { id, startsAt } = await bookFuture();
    // 03:17 on the same day: a real instant, inside no window.
    const odd = `${startsAt.slice(0, 10)}T03:17:00.000Z`;

    const res = await reschedule(id, odd);

    expect(res.status, `not_a_slot answered ${res.status}: ${res.raw}`).toBe(400);
    expect(res.body.error).toBe('not_a_slot');
    expect(bookingRow(id).count).toBe(0);
  }, 180_000);

  /**
   * `change_window_closed`, AND IT IS MEASURED AGAINST THE CURRENT SLOT.
   *
   * The booking is pulled to thirty minutes from now IN POSTGRES, inside the
   * one-hour window. "An appointment an hour away cannot be moved out of trouble;
   * that is what 'after that the deposit stays with the salon' means."
   *
   * The refusal carries the three fields a client needs to say WHY rather than
   * "something went wrong": until when it was changeable, when it starts, and the
   * window it is being measured against.
   */
  it('change_window_closed — inside the last hour, and the refusal says until when', async () => {
    const { id } = await bookFuture();
    const target = await anotherSlot('');

    psql(`
      UPDATE booking
         SET starts_at = now() + interval '30 minutes',
             ends_at   = now() + interval '60 minutes'
       WHERE id = '${id}';
    `);

    const res = await reschedule(id, target);

    expect(res.status, `a move inside the window answered ${res.status}: ${res.raw}`).toBe(409);
    expect(res.body.error).toBe('change_window_closed');
    expect(res.body.changeableUntil, 'the refusal does not say until when').toBeTruthy();
    expect(res.body.startsAt, 'the refusal does not say when it starts').toBeTruthy();
    expect(res.body.windowMinutes, 'the refusal does not name the window').toBe(60);
    expect(bookingRow(id).count, 'a refused move still counted as one').toBe(0);
  }, 180_000);

  /**
   * `not_reschedulable` ON A CANCELLED BOOKING — and this is the one the ablation
   * was about.
   *
   * The UPDATE's own comment: "Lane D removed the handler's status check and the
   * suite stayed green, so a completed or cancelled appointment could be moved into
   * a live slot and occupy an artist's diary." Nothing held that. This does.
   *
   * The deposit has already gone back on a cancel, so a move here would put a live
   * slot in an artist's diary against a booking with no money behind it — asserted
   * on the balance as well as the status, because that is the consequence.
   */
  it('not_reschedulable — a cancelled appointment cannot be moved into a live slot', async () => {
    const { id, startsAt } = await bookFuture();
    const target = await anotherSlot(startsAt);

    const cancelled = await treq<any>('DELETE', `/bookings/${id}`, { token: member });
    precondition(cancelled.status === 200, `the cancel failed: ${cancelled.raw}`);
    const balanceAfterCancel = balanceOf();
    const slotBefore = bookingRow(id).startsAtEpoch;

    const res = await reschedule(id, target);

    expect(res.status, `moving a cancelled booking answered ${res.status}: ${res.raw}`).toBe(409);
    expect(res.body.error).toBe('not_reschedulable');
    expect(
      bookingRow(id).startsAtEpoch,
      'a cancelled appointment was moved into a live slot — the artist now has a diary entry ' +
        'whose deposit is already back in the customer\'s wallet',
    ).toBe(slotBefore);
    expect(bookingRow(id).status).toBe('cancelled');
    expect(balanceOf(), 'the refused move moved money').toBe(balanceAfterCancel);
  }, 180_000);

  /**
   * ANOTHER CUSTOMER'S APPOINTMENT IS A 404, NOT A 403.
   *
   * The handler scopes the SELECT to `principal.id`, so someone else's booking is
   * not something a customer gets to probe: a 403 would confirm the id exists.
   * `deposit.test.ts` owns `QA-DEP-0001`'s bookings, so one of hers is a real id
   * that is genuinely not this member's — a fabricated id would only prove that an
   * unknown id 404s, which is a weaker statement.
   */
  it('another customer\'s appointment is unknown_booking, which does not confirm it exists', async () => {
    // Her own real appointment, booked by her own credential. A fabricated id would
    // only prove that an unknown id 404s, which is the weaker statement: the point
    // is that a booking which genuinely EXISTS is still unknown to another customer.
    const hers = await bookFutureAs(other);
    const target = await anotherSlot(hers.startsAt);

    const res = await reschedule(hers.id, target);

    expect(
      res.status,
      `probing another customer's booking answered ${res.status}: ${res.raw}. A 403 would confirm ` +
        'the id exists, which is what scoping the query prevents.',
    ).toBe(404);
    expect(res.body.error).toBe('unknown_booking');
    expect(
      bookingRow(hers.id).startsAtEpoch,
      'another customer moved her appointment',
    ).toBe(Math.floor(new Date(hers.startsAt).getTime() / 1000));
  }, 180_000);
});

// ------------------------------------------------------------ the chain rule --

describe('the window is measured against the slot as it stands now', () => {
  /**
   * WHY THE CHAIN TERMINATES, PINNED.
   *
   * `assertChangeWindowOpen` reads `row.startsAt` — the CURRENT slot — so moving a
   * booking buys a new deadline for its new time, not a fresh hour before a time
   * that no longer exists. Two moves in a row, then a third from inside the new
   * slot's window: the third must be refused, which is only true if the window
   * followed the booking.
   *
   * The property is easy to hold by accident and easy to lose by reading
   * `rescheduledAt`, or the original slot, instead. This spec is what notices.
   */
  it('a second move is allowed, and the window then follows the NEW slot', async () => {
    const { id, startsAt } = await bookFuture();

    const firstTarget = await anotherSlot(startsAt);
    const first = await reschedule(id, firstTarget);
    precondition(first.status === 200, `the first move failed: ${first.raw}`);
    expect(bookingRow(id).count).toBe(1);

    const secondTarget = await anotherSlot(firstTarget);
    const second = await reschedule(id, secondTarget);
    expect(
      second.status,
      `a second move answered ${second.status}: ${second.raw}. There is no cap on the number of ` +
        'moves — the window is what terminates the chain.',
    ).toBe(200);
    expect(bookingRow(id).count, 'the count does not accumulate across moves').toBe(2);

    // Now pull the CURRENT slot inside the window and try again. If the window were
    // measured against anything but the current slot, this would succeed.
    /**
     * Pulled to [now+5, now+25] rather than [now+20, now+50].
     *
     * `booking_artist_slot_no_overlap` is a real exclusion constraint on
     * (artist_id, tstzrange(starts_at, ends_at)), and the `change_window_closed`
     * spec above parks ITS booking at [now+30, now+60] on the same artist. The
     * obvious [now+20, now+50] overlaps it and the fixture UPDATE fails — which is
     * the constraint doing its job against the suite rather than against a
     * customer. Any range inside the one-hour window works; this one is disjoint
     * from the other spec's by construction.
     */
    psql(`
      UPDATE booking
         SET starts_at = now() + interval '5 minutes',
             ends_at   = now() + interval '25 minutes'
       WHERE id = '${id}';
    `);

    const third = await reschedule(id, await anotherSlot(secondTarget));
    expect(
      third.status,
      'a move was allowed from inside the current slot\'s window, so the window is not being ' +
        'measured against the slot the booking is actually at and the chain never terminates',
    ).toBe(409);
    expect(third.body.error).toBe('change_window_closed');
    expect(bookingRow(id).count, 'the refused third move still counted').toBe(2);
  }, 240_000);
});
