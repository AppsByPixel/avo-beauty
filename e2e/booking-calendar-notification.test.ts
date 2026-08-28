/**
 * THE MERCHANT'S CALENDAR BELL, ON THE BOOKING PATH.
 *
 * HOW TO RUN
 *
 *   pnpm install
 *   pnpm --dir ./api run db:up
 *   cd e2e && ../node_modules/.bin/vitest run booking-calendar-notification.test.ts
 *
 * =========================================================================
 * WHY THIS FILE EXISTS, AND IT IS A CONSEQUENCE OF A FIX RATHER THAN OF A FEATURE
 * =========================================================================
 * `bed3fbb` moved three queries off the base `db` handle and onto `tx`, because a
 * query on `db` inside `db.transaction()` asks a ten-connection pool for an
 * eleventh — `connection-pool.test.ts` is that story and holds the burst specs.
 * Two of the three were `computeAvailability` in `services/booking.ts`.
 *
 * `computeAvailability` IS NOT A PURE READ, which is the part nobody saw until
 * lane A reviewed the diff. On the google-sourced path `resolveWorkingWindow`
 * either RAISES a `calendar_disconnected` merchant notification (no live
 * connection — she is being offered on the salon's hours instead of her own) or
 * RESOLVES one (the connection recovered). Moving the call onto `tx` moved those
 * writes into the booking transaction. That is the one genuine semantic change in
 * an otherwise mechanical fix, and it was covered by nothing:
 *
 *   `artist-availability-source.test.ts` drives the bell hard, and only ever
 *   through `GET /artists/{id}/availability`. It is the READ path, all of it.
 *
 *   `connection-pool.test.ts`'s booking burst uses AR-004, who is
 *   `availabilitySource: 'manual'` and returns from `resolveWorkingWindow` before
 *   either write. Twelve concurrent bookings never reach the branch.
 *
 * So the endpoint that now carries those writes had no spec that could see them.
 *
 * =========================================================================
 * THE REGRESSION THIS IS REALLY GUARDING, STATED PLAINLY
 * =========================================================================
 * Not "someone deletes a notification". The realistic one, and it is realistic
 * BECAUSE of `bed3fbb`: an engineer reads that these writes are now rolled back by
 * an unrelated booking failure, decides that is wrong, and fixes it by making
 * `resolveWorkingWindow` skip its writes when it is handed a transaction. Every
 * existing spec stays green — they all drive the read path, which still writes —
 * and the merchant silently stops being told her artist's calendar is down when a
 * customer books her. A good-faith change, invisible to the suite. That is what
 * the first spec below is for.
 *
 * =========================================================================
 * WHAT THIS FILE DELIBERATELY DOES NOT ASSERT
 * =========================================================================
 * Whether a FAILED booking should roll back a bell it was the first to raise.
 *
 * Measured on 2026-08-28 against `dev` at `b3ecef3`, on a google artist with no
 * connection row:
 *
 *   GET availability                     → 200, `calendar_not_connected`, 1 open row
 *   POST /bookings, 201                  → 1 open row     (the write commits with it)
 *   POST /bookings, 400 `not_a_slot`,
 *     nothing having read her first      → 0 open rows    (rolled back with it)
 *   the same 400, AFTER a GET            → 1 open row     (the committed row stands)
 *
 * The third line is a real behaviour change — before `bed3fbb` that write was its
 * own transaction and committed regardless — and the fourth is why it has no
 * product consequence: `onConflictDoNothing` means a booking that follows a read
 * inserts nothing, so the rollback has nothing of the merchant's to take. Every
 * surface renders a slot picker, which is a read, before it can post a time.
 *
 * The exposure is therefore exactly one case: a caller that posts a booking for a
 * google-sourced disconnected artist WITHOUT ever reading her availability, and
 * whose booking then fails. Reachable through the API, reachable by no product
 * flow. Whether an operational alert ought to be rolled back by an unrelated
 * booking failure is a product decision, lane A took it knowingly, and a spec
 * asserting either answer would be this suite legislating one. It is written down
 * here and raised with trunk instead.
 *
 * Both specs below are true under EITHER resolution of that question, which is the
 * property that makes them safe to write now.
 *
 * =========================================================================
 * WHY SALON A, AND WHY NOT IN `artist-availability-source.test.ts`
 * =========================================================================
 * That file owns the google fixtures and would be the obvious home, and it cannot
 * be: every artist in it belongs to salon B, and salon B has `module_booking =
 * false`. `POST /bookings` there answers `409 booking_not_enabled` from inside the
 * transaction, before `computeAvailability` is ever reached. The booking path needs
 * salon A, a member session rather than a dashboard one, and a teardown of its own —
 * that file's is scoped `WHERE salon_id = SALON_B AND id LIKE 'AR-QA-SRC-%'`. What
 * would be shared is the idea, not the fixtures.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { precondition } from './support/known-bug.js';
import {
  QA_MEMBER_PHONE,
  SALON_A,
  psql,
  scalar,
  signInMember,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

/**
 * A google-sourced artist with NO connection row, which is the
 * `calendar_not_connected` half of `resolveWorkingWindow`'s ternary.
 *
 * `google_connected = true` is not a contradiction and
 * `artist-availability-source.test.ts` explains it: the CHECK
 * `artist_google_source_requires_connection` refuses `availability_source =
 * 'google'` with `google_connected = false`. The flag says the merchant asked for
 * google; the CONNECTION ROW says whether AVO can actually read the calendar, and
 * this artist deliberately has none.
 */
const ARTIST = 'AR-QA-BOOKCAL-GOOGLE';
/** Salon A's manicure, the service `reschedule.test.ts` books. */
const SERVICE = 'SV-04';
/** Open every day, so a spec never lands on a closed one. */
const WEEK = Object.fromEntries(
  ['0', '1', '2', '3', '4', '5', '6'].map((d) => [d, { open: true, from: '10:00', to: '19:00' }]),
);

let member = '';

function resetArtist(): void {
  psql(`
    INSERT INTO artist (id, salon_id, name, availability_source, google_connected,
                        slot_minutes, windows, active)
    VALUES ('${ARTIST}', '${SALON_A}', 'QA booking calendar', 'google', true, 30,
            '${JSON.stringify(WEEK)}'::jsonb, true)
    ON CONFLICT (id) DO UPDATE SET
      availability_source = 'google', google_connected = true,
      slot_minutes = 30, windows = EXCLUDED.windows, active = true;

    -- No connection row, ever, for this artist. Deleted rather than assumed
    -- absent: artist_calendar_connection.artist_id is UNIQUE, and one left
    -- behind would turn every calendar_not_connected assertion below into a
    -- calendar_unavailable one without changing a single line of this file.
    DELETE FROM artist_calendar_connection WHERE artist_id = '${ARTIST}';
  `);
}

/** Open `calendar_disconnected` rows standing against this artist right now. */
const bells = (): number =>
  Number(
    scalar(
      `select count(*) from merchant_notification
        where salon_id='${SALON_A}' and kind='calendar_disconnected'
          and subject_type='artist' and subject_id='${ARTIST}' and resolved_at is null`,
    ),
  );

function clearBells(): void {
  psql(`
    DELETE FROM merchant_notification
     WHERE salon_id = '${SALON_A}' AND kind = 'calendar_disconnected'
       AND subject_type = 'artist' AND subject_id = '${ARTIST}';
  `);
}

const availability = (date: string) =>
  treq<any>('GET', `/artists/${ARTIST}/availability?date=${date}`, { token: member });

const book = (startsAt: string, label: string) =>
  treq<any>('POST', '/bookings', {
    token: member,
    idempotencyKey: `bookcal-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    body: { artistId: ARTIST, serviceId: SERVICE, startsAt },
  });

/**
 * A slot this artist genuinely has free, walked forward rather than computed from
 * a fixed offset — `reschedule.test.ts` documents why, and it applies harder here:
 * she has fallen back to the SALON's hours, so which times exist is a property of
 * salon A's week and not of the fixture above.
 *
 * Reads availability, which RAISES the bell as a side effect. Every caller below
 * therefore clears afterwards and says so; that side effect is the subject of this
 * file and cannot be allowed to leak into the arrangement of a spec about it.
 */
async function findSlot(): Promise<string> {
  for (let d = 9; d < 25; d++) {
    const date = new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
    const day = await availability(date);
    if (day.status !== 200) continue;
    const free = (day.body?.slots ?? []).filter((s: any) => s.available === true);
    if (free.length > 0) return free[0].startsAt as string;
  }
  return '';
}

beforeAll(async () => {
  await startTenancyApi();
  member = await signInMember(SALON_A, QA_MEMBER_PHONE);
  resetArtist();
}, 180_000);

beforeEach(() => {
  resetArtist();
  clearBells();
});

afterAll(async () => {
  clearBells();
  psql(`
    DELETE FROM booking WHERE artist_id = '${ARTIST}';
    DELETE FROM artist_calendar_connection WHERE artist_id = '${ARTIST}';
    DELETE FROM artist WHERE salon_id = '${SALON_A}' AND id = '${ARTIST}';
  `);
  await stopTenancyApi();
});

describe('booking a google-sourced artist whose calendar is not connected', () => {
  /**
   * THE SPEC THE FIX NEEDED AND DID NOT HAVE.
   *
   * The bell is cleared first and NOTHING reads her availability between that and
   * the booking — `findSlot` runs before the clear on purpose. So the only thing
   * that can put a row there is the booking transaction itself, which is exactly
   * the write `bed3fbb` relocated.
   */
  it('the booking succeeds, and the write inside its transaction rings the bell', async () => {
    const slot = await findSlot();
    precondition(
      slot !== '',
      'salon A has no free slot for this artist in the next fortnight, so this file cannot ' +
        'book. That is a defect in availability or in the seed, not in the notification.',
    );

    // AFTER the search, because the search is a read and a read raises it.
    clearBells();
    precondition(bells() === 0, 'the bell was not cleared, so this spec cannot attribute one');

    const booked = await book(slot, 'ok');
    expect(booked.status, `POST /bookings answered: ${booked.raw}`).toBe(201);

    expect(
      bells(),
      'a booking against a google-sourced artist with no connected calendar left the ' +
        'merchant with no notification. `resolveWorkingWindow` raises it, ' +
        '`services/booking.ts` reaches it through `computeAvailability(tx, …)`, and nothing ' +
        'else in this suite drives that write — `artist-availability-source.test.ts` is the ' +
        'READ path. If this is red because the write was deliberately skipped on the ' +
        'transactional path, that decision needs to keep the merchant informed some other ' +
        'way before this spec is changed.',
    ).toBe(1);
  }, 120_000);

  /**
   * THE ROLLBACK BOUNDARY, ASSERTED WHERE IT IS NOT IN QUESTION.
   *
   * A booking that fails rolls its transaction back, and since `bed3fbb` the
   * notification write is inside that transaction. The header says what that costs
   * and why trunk has not been asked to rule on it: a bell the booking was FIRST to
   * raise goes with it. A bell that was ALREADY STANDING must survive, under any
   * resolution of that question, and every product surface reads before it posts —
   * so this is the case that actually happens.
   *
   * WHAT THIS SPEC CAN AND CANNOT FAIL ON, BECAUSE THE HONEST ANSWER IS NARROW AND
   * IT IS STILL WORTH HAVING. Nothing the booking transaction does to that row can
   * break this. Postgres guarantees it: a rollback undoes a DELETE as readily as an
   * INSERT. Both mutations tried against it confirmed as much — skipping the raise
   * left the arrangement with no bell and the precondition refused to pretend
   * otherwise, and replacing `onConflictDoNothing` with a resolve-then-reinsert
   * PASSED, because the destructive half rolled back with everything else.
   *
   * It fails on exactly one shape: a DESTRUCTIVE WRITE ON THE BASE `db` HANDLE
   * during a booking, which survives the rollback because it was never in the
   * transaction. Proven — `resolveMerchantNotification(db, …)` added to the
   * fallback path takes the standing row down and this goes red with the message
   * below.
   *
   * That shape is not hypothetical, and it is why this spec is here rather than in
   * a comment. It is the natural "fix" for the rollback complaint the header
   * records: move the write back off `tx` and onto `db` so a failed booking cannot
   * reach it. That change would reintroduce, on this exact call path, the
   * eleventh-connection deadlock `bed3fbb` removed — and `connection-pool.test.ts`
   * would go red beside this one. Between them the two files say: the write belongs
   * inside the transaction, and if the rollback is wrong the answer is not to move
   * it back out.
   */
  it('a FAILED booking leaves a bell that was already standing', async () => {
    const slot = await findSlot();
    precondition(slot !== '', 'no free slot; see the spec above');

    clearBells();
    // The read raises it and COMMITS it, which is the state under test.
    const date = slot.slice(0, 10);
    expect((await availability(date)).status).toBe(200);
    precondition(
      bells() === 1,
      `the read path did not raise the bell (${bells()} open rows), so a rollback spec ` +
        'about it has nothing to stand on',
    );

    /**
     * Seven minutes past the hour on a thirty-minute grid. `not_a_slot` is thrown
     * AFTER `computeAvailability` has run and written, which is what makes this a
     * rollback and not merely a refusal — an earlier validation error would never
     * reach the branch and the spec would pass without testing anything.
     */
    const offGrid = slot.replace(/T(\d\d):\d\d/, 'T$1:07');
    const failed = await book(offGrid, 'offgrid');
    expect(failed.status, `expected the booking to be refused, got: ${failed.raw}`).toBe(400);
    expect(failed.body.error).toBe('not_a_slot');

    expect(
      bells(),
      'a booking that FAILED took the merchant\'s standing `calendar_disconnected` ' +
        'notification down with it. The row was committed by an availability read before ' +
        'the booking began, so no booking rollback should be able to reach it — see this ' +
        "file's header for the case that IS rolled back, deliberately, and the open question " +
        'attached to it.',
    ).toBe(1);
  }, 120_000);
});
