/**
 * THE NO-SHOW WORKER'S TIMER — the plumbing the one-shot script cannot reach.
 *
 * HOW TO RUN
 *
 *   pnpm install
 *   pnpm --dir ./api run db:up
 *   cd e2e && ../node_modules/.bin/vitest run no-show-worker.test.ts
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `support/tenancy-harness.ts` now pins `NO_SHOW_WORKER_ENABLED='0'` for every API
 * this suite boots. The long note beside that constant says why: `api/src/env.ts`
 * defaults it ON, the harness boots `src/server.ts` rather than `buildApp()`, and
 * the variable had never been set — so a 30-second timer no spec controlled was
 * returning deposits in the middle of every run. It is what made
 * `deposit.test.ts` § "two no-show passes racing on one deposit still return it
 * once" fail in one gate run and pass in the next on an identical tree.
 *
 * THE PIN IS RIGHT AND IT LEAVES A HOLE. Every `no_show_returned` assertion in
 * this directory now follows an explicit run of `api/src/jobs/no-show-once.ts`,
 * which calls `runNoShowReturnsOnce`. That is the LOGIC — the scan, the lock, the
 * status re-check, the money — and it is well covered. `startNoShowWorker` is the
 * PLUMBING around it, and nothing anywhere touches it:
 *
 *   - the self-rescheduling `setTimeout` that makes it a loop at all
 *   - that it reschedules AFTER a pass rather than on a fixed interval
 *   - `stop()`, which clears the timer and awaits the in-flight pass so the
 *     server does not close the pool underneath a running transaction
 *
 * None of that was tested before the pin either. The loop ran in every file and no
 * file ever asserted a thing about it, which is precisely how it was able to break
 * another spec unnoticed for as long as it did. The pin did not create the gap; it
 * made the gap visible and worth closing.
 *
 * SO THIS FILE TURNS THE WORKER BACK ON, ON PURPOSE, AND NEVER RUNS THE JOB BY
 * HAND. `bootWithNoShowWorker()` is called before `startTenancyApi()`, with a poll
 * of half a second so the wait is a second rather than thirty. There is deliberately NO import of `runApiDbScriptResult`
 * anywhere below: if a deposit comes back in this file, a timer brought it back,
 * because nothing else in the process is capable of it.
 *
 * WHY IT CANNOT DISTURB ANYTHING ELSE
 * -----------------------------------
 * The worker's scan is `status = 'deposit_held' AND no_show_return_due_at <= now()`
 * across the WHOLE database, so while it is alive it can take anybody's due
 * deposit. Two things keep that contained, and both are load-bearing:
 *
 *   1. `vitest.config.ts` sets `fileParallelism: false`. One file's API is alive at
 *      a time, and `stopTenancyApi()` kills its process group in `afterAll`. The
 *      worker started here is dead before the next file boots its own.
 *   2. The override lives in the harness and is read at BOOT. Setting
 *      `process.env` here would not do — the exported `NO_SHOW_WORKER_ENABLED`
 *      const is evaluated when the worker process loads the harness, long before
 *      any `beforeAll`, so the racing spec's precondition would read `false` while
 *      the server it describes ran the loop. That is the same class of mismatch
 *      this whole exercise is about.
 *
 * ITS OWN MEMBER AND ITS OWN ARTIST. `QA-NSW-0001` and `AR-004` are touched by
 * nothing else in the suite, and every assertion below is scoped to her id rather
 * than to a global count — because a global count in this file would be a count of
 * whatever the worker also happened to sweep up.
 *
 * AND ITS OWN CORNER OF THE DIARY. `booking` carries an exclusion constraint on
 * `(artist_id, tstzrange(starts_at, ends_at))` over the live statuses, so every
 * booking this file parks needs a slot no other booking holds. `deposit.test.ts`
 * places its holds a few minutes into the FUTURE and releases them 21+ days out;
 * this file parks its bookings whole HOURS INTO THE PAST, one hour each, which is
 * a region nothing else uses and is also the honest fixture — a no-show is an
 * appointment that has already been missed.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { precondition } from './support/known-bug.js';
import {
  A_STAFF_FULL,
  SALON_A,
  apiLogTail,
  bootWithNoShowWorker,
  noShowWorkerIsRunning,
  psql,
  scalar,
  signInMember,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

/**
 * Half a second. `api/src/env.ts` defaults `NO_SHOW_POLL_MS` to 30_000, and a spec
 * that waits half a minute for a timer is a spec somebody deletes or marks skipped.
 *
 * Not shorter than this on purpose: each tick is a real query against the run's
 * database through the same pool the requests use, and a 50ms loop would spend the
 * file's whole runtime scanning `booking` while the specs are trying to book.
 */
const POLL_MS = 500;

/** Shaikha B. Manual windows, four days a week — and nothing else books her. */
const ARTIST = 'AR-004';
/** Salon A's seeded manicure. `api/src/db/seed.ts`. */
const MANICURE = 'SV-04';
/** `salon.deposit_fils`, seeded. CHECKed between 1000 and 10000. */
const DEPOSIT_FILS = 5_000;

/** This file's member. Nothing else reads or writes her. */
const MEMBER = 'QA-NSW-0001';
const MEMBER_PHONE = '+96599777701';
const MEMBER_OPENING_FILS = 200_000;

let member = '';
let n = 0;
const key = (label: string) => `noshow-${label}-${Date.now()}-${n++}`;

/**
 * Her row, restored to the state `beforeAll` created.
 *
 * The password hash is borrowed from a seeded staff row, exactly as
 * `deposit.test.ts` does it, so `signInMember()`'s shared password works without
 * this file knowing how lane A hashes anything.
 */
function reseedMember(): void {
  psql(`
    INSERT INTO member (id, salon_id, name, phone, email, email_verified, password_hash,
                        balance_fils, visits, tier, stamps, policy_version)
    SELECT '${MEMBER}', '${SALON_A}', 'No-show Worker Fixture', '${MEMBER_PHONE}', NULL, false,
           s.password_hash, ${MEMBER_OPENING_FILS}, 0, 'bronze', NULL, 3
    FROM staff_user s WHERE s.id = '${A_STAFF_FULL}'
    ON CONFLICT (id) DO UPDATE SET
      password_hash = EXCLUDED.password_hash,
      balance_fils  = ${MEMBER_OPENING_FILS},
      visits        = 0,
      tier          = 'bronze',
      stamps        = NULL;
  `);
}

const balanceOf = (id: string): number =>
  Number(scalar(`select balance_fils from member where id='${id}'`));

const bookingStatus = (id: string): string =>
  scalar(`select status from booking where id='${id}'`);

/** Her `deposit_return` transactions, which are what the worker's pass writes. */
const depositReturnsFor = (memberId: string): number =>
  Number(
    scalar(
      `select count(*) from transaction where member_id='${memberId}' and kind='deposit_return'`,
    ),
  );

/**
 * How much is currently HELD for one member, out of the ledger.
 *
 * The join through `transaction` is not optional: the `deposit_held` leg carries
 * `member_id: NULL` — only the `member_wallet` leg names her, which is what
 * `ledger_entry_wallet_requires_member` enforces — so a query filtering `member_id`
 * on this account returns no rows and reads as "nothing is held". Lifted from
 * `deposit.test.ts`, whose first draft got exactly that wrong.
 *
 * A position, so credits minus debits, because `amount_fils` is CHECKed positive
 * and the sign lives in `direction`.
 */
const depositHeldFor = (memberId: string): number =>
  Number(
    scalar(
      `select coalesce(sum(case when le.direction = 'credit' then le.amount_fils
                                else -le.amount_fils end), 0)
         from ledger_entry le
         join transaction t on t.id = le.transaction_id
        where le.account = 'deposit_held' and t.member_id = '${memberId}'`,
    ),
  );

/** ISO date `daysAhead` from now. UTC, and no caller trusts it — see `bookFuture`. */
function isoDate(daysAhead: number): string {
  return new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);
}

/**
 * A real booking, through the real endpoint, on a future date the artist works.
 *
 * REAL, because the point of this file is that a REAL deposit comes back. The
 * money is debited by `POST /bookings` under an idempotency key, the `deposit_held`
 * ledger pair is written by lane A, and every invariant the endpoint enforces runs.
 * Only the CLOCK is moved afterwards, by `parkInThePast()`, and no money column is
 * ever touched.
 *
 * Walks forward until the grid offers a slot: AR-004 works four days a week, so a
 * fixed offset would land on a closed day and turn this file red for a reason that
 * has nothing to do with the worker.
 */
async function bookFuture(): Promise<{ id: string; depositFils: number }> {
  let slot: string | undefined;
  for (let d = 9; d < 17 && !slot; d++) {
    const day = await treq<any>('GET', `/artists/${ARTIST}/availability?date=${isoDate(d)}`, {
      token: member,
    });
    if (day.status !== 200) throw new Error(`availability: ${day.status} ${day.raw}`);
    slot = day.body?.slots?.find((s: any) => s.available === true)?.startsAt;
  }
  if (!slot) {
    throw new Error(
      `${ARTIST} has no bookable slot in the next fortnight, so this file cannot build a hold. ` +
        'That is a defect in availability, not in this suite.',
    );
  }

  const res = await treq<any>('POST', '/bookings', {
    token: member,
    idempotencyKey: key('book'),
    body: { artistId: ARTIST, serviceId: MANICURE, startsAt: slot },
  });
  if (res.status !== 201) throw new Error(`POST /bookings: ${res.status} ${res.raw}`);
  return { id: res.body.booking.id, depositFils: res.body.booking.depositFils };
}

/**
 * Park a booking in a past hour of its own, with its deadline STILL IN THE FUTURE.
 *
 * Two separate reasons for the two halves.
 *
 * THE HOUR. One never-reused hour per booking, because the artist's diary is an
 * exclusion constraint over `(artist_id, tstzrange(starts_at, ends_at))` and
 * COMPLETED and settled bookings still occupy their slot. Two of this file's
 * bookings parked "an hour ago" in two statements land seconds apart on the same
 * hour, which overlaps, and Postgres refuses it with
 * `booking_artist_slot_no_overlap` — which reads as a no-show failure and is not
 * one.
 *
 * THE DEADLINE. Deliberately NOT due yet, so that every spec below can watch the
 * live worker leave the booking alone first and only then make it due. Without
 * that half, a deposit that came back would only prove the worker returns deposits
 * — not that it returned THIS one because its deadline passed while the loop was
 * running.
 */
let parkedHour = 2;
function parkInThePast(bookingId: string): void {
  parkedHour += 1;
  psql(`
    UPDATE booking
       SET starts_at             = now() - interval '${parkedHour} hours',
           ends_at               = now() - interval '${parkedHour} hours' + interval '30 minutes',
           no_show_return_due_at = now() + interval '1 hour'
     WHERE id = '${bookingId}';
  `);
}

/** The deadline passes. In every spec below this is the ONLY thing that changes. */
function makeDue(bookingId: string): void {
  psql(`
    UPDATE booking
       SET no_show_return_due_at = now() - interval '1 minute'
     WHERE id = '${bookingId}';
  `);
}

/**
 * Park a booking back out of reach, without touching a money column.
 *
 * Cleanup, and it matters beyond tidiness: a booking left `deposit_held` with a
 * deadline in the past is a candidate for whatever no-show pass runs next, in this
 * file or in `deposit.test.ts`'s explicit ones later in the run, and a stray
 * candidate is how one file's leftovers become another file's mystery.
 */
function parkOutOfReach(bookingId: string): void {
  psql(`
    UPDATE booking
       SET no_show_return_due_at = now() + interval '30 days'
     WHERE id = '${bookingId}' AND status = 'deposit_held';
  `);
}

/**
 * Poll the DATABASE until it says what we are waiting for, or give up loudly.
 *
 * Reading Postgres rather than the API, for the reason the whole no-show block in
 * `deposit.test.ts` gives: the claim is about money and a ledger, and a screen that
 * agrees with itself is not evidence. The API's log is attached to the failure as
 * context — never as the assertion.
 */
async function waitUntil(
  what: string,
  ready: () => boolean,
  timeoutMs = 15_000,
): Promise<{ waitedMs: number }> {
  const startedAt = Date.now();
  for (;;) {
    if (ready()) return { waitedMs: Date.now() - startedAt };
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(
        `waited ${timeoutMs}ms for ${what} and it never happened. The worker was asked to poll ` +
          `every ${POLL_MS}ms, so this is ${Math.floor(timeoutMs / POLL_MS)} missed ticks, not a ` +
          'slow one.\n--- the API\'s own account ---\n' +
          apiLogTail(60),
      );
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Long enough that the loop has certainly ticked, and short enough to sit through. */
const settle = (ticks = 3): Promise<void> =>
  new Promise((r) => setTimeout(r, POLL_MS * ticks + 300));

beforeAll(async () => {
  /**
   * BEFORE `startTenancyApi()`, and the harness throws if it is not — the boot env
   * is read once, when the API process is spawned.
   */
  bootWithNoShowWorker(POLL_MS);
  await startTenancyApi();
  reseedMember();
  member = await signInMember(SALON_A, MEMBER_PHONE);
}, 180_000);

afterAll(async () => {
  reseedMember();
  await stopTenancyApi();
});

// ===========================================================================
// The loop itself. Nothing in this file runs the job by hand.
// ===========================================================================

describe('the no-show worker returns a due deposit on its own timer', () => {
  it('leaves a held deposit alone until the deadline passes, then returns it with nobody driving it', async () => {
    precondition(
      noShowWorkerIsRunning(),
      'the API under test is NOT running its no-show worker, so this file is watching a timer ' +
        'that does not exist and every assertion below would be about nothing. Check that ' +
        'bootWithNoShowWorker() still runs before startTenancyApi() in beforeAll.',
    );

    const booking = await bookFuture();
    expect(booking.depositFils, 'the booking did not take the salon deposit').toBe(DEPOSIT_FILS);
    parkInThePast(booking.id);

    const balanceBefore = balanceOf(MEMBER);
    const returnsBefore = depositReturnsFor(MEMBER);
    const heldBefore = depositHeldFor(MEMBER);
    precondition(
      heldBefore >= DEPOSIT_FILS,
      `she holds ${heldBefore}, so there is no deposit for the worker to return`,
    );

    /**
     * FIRST, THE CONTROL. The loop has been running since `beforeAll` and this
     * booking has been sitting in front of it, not yet due, for the whole of
     * `bookFuture()`. Several ticks later it is untouched — so what happens next
     * is caused by the DEADLINE and not by the worker returning whatever it finds.
     */
    await settle();
    expect(
      bookingStatus(booking.id),
      'the worker settled a booking whose grace period has not expired. She may still walk in, ' +
        'and a charge would then find no deposit to apply.',
    ).toBe('deposit_held');
    expect(balanceOf(MEMBER), 'her balance moved before the deadline did').toBe(balanceBefore);

    // The deadline passes. Nothing else changes, and nothing runs the job.
    makeDue(booking.id);

    const { waitedMs } = await waitUntil(
      `the worker to return ${MEMBER}'s deposit on booking ${booking.id}`,
      () => bookingStatus(booking.id) === 'no_show_returned',
    );

    /**
     * REPORTED, NOT ASSERTED. How long the timer took is the kind of number that
     * lets somebody reading a gate run see the loop is still a loop; asserting an
     * upper bound on it would be asserting against the machine's load.
     */
    // eslint-disable-next-line no-console
    console.log(`[lane D] no-show worker drained a due deposit ${waitedMs}ms after it fell due.`);

    /**
     * THE MONEY, FROM POSTGRES, and this is the assertion — not the status above
     * and not the `noshow.tick` line in the API's log. A worker that flipped the
     * column and returned nothing would leave the customer's 5.000 neither held nor
     * returned while the row claimed it was resolved, which is the worst outcome
     * available here and the one a status-only spec would wave through.
     */
    expect(
      balanceOf(MEMBER),
      'the worker settled the booking without giving the deposit back',
    ).toBe(balanceBefore + DEPOSIT_FILS);

    // Released in the ledger, not merely forgotten.
    expect(
      depositHeldFor(MEMBER),
      'the deposit_held account still carries this deposit after the worker returned it',
    ).toBe(heldBefore - DEPOSIT_FILS);

    // EXACTLY ONE, and its own transaction: a balance that moves with nothing
    // behind it is the shape of a reconciliation nobody can perform later.
    expect(
      depositReturnsFor(MEMBER),
      'the balance moved with no deposit_return transaction explaining it — or with more than one',
    ).toBe(returnsBefore + 1);
    expect(
      Number(
        scalar(
          `select amount_fils from transaction where member_id='${MEMBER}'
             and kind='deposit_return' order by created_at desc, id desc limit 1`,
        ),
      ),
      'the returned amount is not the deposit that was held',
    ).toBe(DEPOSIT_FILS);
  }, 120_000);

  it('and it is a LOOP: a second deposit falling due later in the same run is drained too', async () => {
    /**
     * WHAT THIS ADDS OVER THE SPEC ABOVE. `startNoShowWorker` runs its first pass
     * immediately — `inFlight = tick()` — so a worker that ticked once and never
     * rescheduled would pass everything above. Only a deposit that becomes due
     * AFTER that first pass has already been and gone can tell the difference, and
     * the spec above has already spent one.
     *
     * WHAT IT DOES NOT PROVE, said plainly so nobody reads more into it: it shows
     * the loop reschedules, not that it reschedules from the END of a pass rather
     * than on a fixed interval. Telling those two apart from outside the process
     * needs a pass slow enough to overrun its own interval, and there is no honest
     * way to make this job slow from a test. The distinction is argued in
     * `noShowWorker.ts`'s own header and is a design claim, not an observable one.
     */
    const booking = await bookFuture();
    parkInThePast(booking.id);

    const balanceBefore = balanceOf(MEMBER);
    const returnsBefore = depositReturnsFor(MEMBER);
    const heldBefore = depositHeldFor(MEMBER);
    precondition(
      heldBefore >= DEPOSIT_FILS,
      `she holds ${heldBefore}, so there is no second deposit to drain`,
    );

    await settle();
    precondition(
      bookingStatus(booking.id) === 'deposit_held',
      'the second booking was settled before its deadline, so this spec cannot tell a rescheduled ' +
        'tick from the first one',
    );

    makeDue(booking.id);

    await waitUntil(
      `a LATER tick to return ${MEMBER}'s second deposit on booking ${booking.id}`,
      () => bookingStatus(booking.id) === 'no_show_returned',
    );

    expect(balanceOf(MEMBER), 'the second deposit did not come back').toBe(
      balanceBefore + DEPOSIT_FILS,
    );
    expect(depositHeldFor(MEMBER)).toBe(heldBefore - DEPOSIT_FILS);
    expect(
      depositReturnsFor(MEMBER),
      'the second return is missing, or the tick wrote more than one',
    ).toBe(returnsBefore + 1);
  }, 120_000);

  /**
   * LAST IN THE FILE, BECAUSE IT KILLS THE SERVER. `stopTenancyApi()` is
   * idempotent — `afterAll` calling it again is a no-op — but nothing after this
   * spec can make a request.
   */
  it('and the loop dies with the server: a deposit falling due after shutdown is left alone', async () => {
    /**
     * THE OTHER HALF OF THE PLUMBING. `stop()` sets `stopped`, clears the pending
     * timeout and awaits the in-flight pass; `server.ts` awaits it inside its
     * SIGTERM handler before closing. A worker that ignored `stop()` would keep
     * polling a pool that is being torn down — and, more to the point here, would
     * be exactly the loose timer this suite's harness pin exists to prevent
     * escaping into the next file.
     *
     * Proved as a negative, which is the only shape available: make a deposit due
     * AFTER the server is down and show that several poll intervals later nothing
     * has touched it. The booking is created while the API is still up, because
     * creating it is the part that needs the API.
     */
    const booking = await bookFuture();
    parkInThePast(booking.id);

    const balanceBefore = balanceOf(MEMBER);
    const returnsBefore = depositReturnsFor(MEMBER);
    const heldBefore = depositHeldFor(MEMBER);
    precondition(
      heldBefore >= DEPOSIT_FILS,
      `she holds ${heldBefore}, so there is no deposit to leave alone`,
    );

    await stopTenancyApi();

    // Only now does it fall due. A live loop would take it within one tick.
    makeDue(booking.id);
    await settle(6);

    expect(
      bookingStatus(booking.id),
      'a deposit was returned after the server was shut down, so the worker\'s timer outlived ' +
        'stop() — which is a loop this suite cannot account for and the next file would inherit',
    ).toBe('deposit_held');
    expect(balanceOf(MEMBER), 'her balance moved after the server stopped').toBe(balanceBefore);
    expect(depositReturnsFor(MEMBER)).toBe(returnsBefore);
    expect(depositHeldFor(MEMBER)).toBe(heldBefore);

    // Do not leave a due candidate behind for the rest of the run.
    parkOutOfReach(booking.id);
  }, 120_000);
});
