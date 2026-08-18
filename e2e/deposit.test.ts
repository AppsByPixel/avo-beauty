/**
 * THE HELD DEPOSIT — the money path that had no evidence.
 *
 * HOW TO RUN
 *
 *   pnpm install
 *   pnpm --dir ./api run db:up
 *   cd e2e && ../node_modules/.bin/vitest run deposit.test.ts
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `POST /bookings` debits the salon's deposit from the customer's wallet and holds
 * it; `POST /charges` consumes that hold and gives back the difference. Every
 * piece of it was built, and between them the whole path had two `it.todo`s — one
 * of which said it could not be tested at all.
 *
 * That entry was the interesting part, and it was WRONG in the direction that
 * stops people looking: it said `POST /scans` hardcodes `heldDepositFils: 0`, so
 * the credit line was "unreachable and untestable". Both halves had stopped being
 * true. The path was not unreachable, it was UNCOVERED — and `depositAppliedFils`
 * and `heldDepositFils` appeared in this suite only as interface fields, never
 * inside an `expect()`.
 *
 * THE TRAP THAT MADE IT LOOK COVERED
 * ----------------------------------
 * The only `POST /bookings` call anywhere in this suite is in contract.test.ts,
 * and it books NINE DAYS OUT because a future date is what a schema probe needs.
 * Nine days out is outside the no-show grace window, so `findApplicableHold`
 * correctly returns nothing and every deposit field is legitimately `0`. A spec
 * built on that booking would assert `heldDepositFils === 0`, pass for ever, and
 * prove nothing about a hold — which is the same failure as the availability probe
 * that ran on today's date, where every slot already carries a `reason`.
 *
 * The hold applies only when
 *
 *     startsAt <= now + noShowReturnMinutes    AND    noShowReturnDueAt > now
 *
 * so a booking is "inside the window" for roughly the hour before it starts until
 * the grace period after it ends.
 *
 * WHY THE CLOCK IS MOVED AND THE MONEY IS NOT
 * -------------------------------------------
 * Every booking here is created through `POST /bookings` with a real idempotency
 * key, so the deposit is really debited, the `deposit_held` ledger pair is really
 * written, and every invariant the endpoint enforces really runs. Then the
 * booking's three CLOCK columns are moved backwards with SQL so it sits inside the
 * window.
 *
 * The alternative is booking into the next hour, and `availability.ts` will offer
 * such a slot — it only refuses `startsAt <= now` — which means the spec would
 * pass or fail depending on the time of day the suite happened to run, and would
 * be unrunnable in the hour before the salon closes. Moving a clock is the only
 * honest way to test a time window. NO MONEY COLUMN IS EVER TOUCHED: the balance,
 * the deposit and the ledger are whatever the API made them.
 *
 * ITS OWN MEMBER AND ITS OWN ARTIST-DAY. The specs below charge, so they change a
 * balance; doing that to a member another file signs in as is the shared-fixture
 * failure this suite has been bitten by three times.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { precondition } from './support/known-bug.js';
import {
  A_STAFF_FULL,
  SALON_A,
  SALON_B,
  pgDb,
  psql,
  runApiDbScriptAsync,
  runApiDbScriptResult,
  scalar,
  signInMember,
  signInScanner,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

/** Salon A's seeded scanner device and staff — the only salon with artists. */
const A_SCANNER_DEVICE = 'DEV-SCANNER-01';
const A_STAFF_HANDLE = 'noura';
/** Rana. Her week is open six days, so a future date always has a grid. */
const ARTIST = 'AR-001';
/**
 * Dana, for the spec that needs TWO live bookings at once. Her own diary, following
 * the allocator's own advice when a single artist ran out of window: the exclusion
 * constraint is per artist, so a second artist is a second sixty minutes.
 */
const SECOND_ARTIST = 'AR-002';
/**
 * Hessa, for the no-show block. A third diary because the allocator counts
 * placements PER ARTIST and AR-001's hour is spent by the specs above — it said so
 * itself, twice, and the advice was to take another artist rather than shorten the
 * stride. Salon A seeds four.
 */
const THIRD_ARTIST = 'AR-003';

/** Salon A's seeded services. `api/src/db/seed.ts`. */
const MANICURE = 'SV-04';
const MANICURE_FILS = 6_000;
const BLOW_DRY = 'SV-01';
const BLOW_DRY_FILS = 8_000;

/** `salon.deposit_fils`, seeded. CHECKed between 1000 and 10000. */
const DEPOSIT_FILS = 5_000;
/** `salon.no_show_return_minutes`, seeded. */
const GRACE_MINUTES = 60;

/** This file's member. Nothing else reads or writes her. */
const MEMBER = 'QA-DEP-0001';
const MEMBER_PHONE = '+96599777601';
const MEMBER_OPENING_FILS = 200_000;
const PASSWORD = 'noura-dev-password';

let member = '';
let scanner = '';
let n = 0;
const key = (label: string) => `deposit-${label}-${Date.now()}-${n++}`;

/**
 * Her row, restored to the state `beforeAll` created.
 *
 * The opening balance is deliberately large: every spec here debits, and a
 * shortfall arriving because a previous spec spent the money would look exactly
 * like the 402 one of these specs is trying to prove on purpose.
 */
function reseedMember(): void {
  psql(`
    INSERT INTO member (id, salon_id, name, phone, email, email_verified, password_hash,
                        balance_fils, visits, tier, stamps, policy_version)
    SELECT '${MEMBER}', '${SALON_A}', 'Deposit Fixture', '${MEMBER_PHONE}', NULL, false,
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

const visitsOf = (id: string): number =>
  Number(scalar(`select visits from member where id='${id}'`));

/**
 * How much is currently HELD for one member, out of the ledger.
 *
 * THREE THINGS ABOUT THIS QUERY, AND THE FIRST DRAFT GOT ALL THREE WRONG.
 *
 * 1. `ledger_entry.amount_fils` is CHECKed POSITIVE and the sign lives in
 *    `direction`. Summing `amount_fils` gives the turnover, not the position, so a
 *    released deposit and a held one look identical.
 *
 * 2. THE `deposit_held` LEG CARRIES `member_id: NULL`. Only the `member_wallet`
 *    leg names her — `ledger_entry_wallet_requires_member` enforces exactly that
 *    and nothing requires it of the other side. So "how much is held for this
 *    customer" is not answerable from `ledger_entry` alone; it needs the join
 *    through `transaction`. A query filtering `member_id` on this account returns
 *    zero rows and reads as "nothing is held", which is the most convenient
 *    possible wrong answer for a spec about a deposit.
 *
 * 3. It is a position and not a balance, so it is credits MINUS debits and cannot
 *    be reconciled against `balance_after_fils` — that column is wallet-only, by
 *    its own CHECK.
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

/**
 * ISO date `daysAhead` from now, for the availability grid.
 *
 * THIS IS A UTC DATE AND THE GRID IS A SALON-LOCAL ONE, which is a wall-clock
 * dependency and a deliberately harmless one. Swept for after `promotions.test.ts`
 * turned out to fail for two hours a day: this runner is PKT and salon A is
 * Asia/Kuwait, so for part of the day the date computed here is the salon's
 * yesterday or tomorrow.
 *
 * It cannot bite, because no caller trusts the date — `bookFuture` walks d = 9..17
 * asking the real endpoint and takes the first day that offers a slot, so a one-day
 * skew costs one extra request. A fixed offset with no iteration is what would make
 * it a scheduled failure: AR-001's week is closed one day, and that day would move.
 *
 * Left as UTC rather than derived in the salon's zone on purpose. Computing a
 * salon-local date in JavaScript here would be the pattern `promotions.test.ts`
 * refuses — asserting that the implementation agrees with itself — and the
 * iteration already makes the question moot.
 */
function isoDate(daysAhead: number): string {
  return new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);
}

/**
 * A real booking, through the real endpoint, on a future date the artist works.
 *
 * Walks forward until the grid offers a slot: `AR-001`'s week is closed one day,
 * and a fixed offset lands on it once every seven runs and turns this file red for
 * a reason that has nothing to do with deposits.
 */
async function bookFuture(
  serviceId: string,
  artistId: string = ARTIST,
): Promise<{ id: string; depositFils: number }> {
  let slot: string | undefined;
  for (let d = 9; d < 17 && !slot; d++) {
    const day = await treq<any>('GET', `/artists/${artistId}/availability?date=${isoDate(d)}`, {
      token: member,
    });
    if (day.status !== 200) throw new Error(`availability: ${day.status} ${day.raw}`);
    slot = day.body?.slots?.find((s: any) => s.available === true)?.startsAt;
  }
  if (!slot) {
    throw new Error(
      `${artistId} has no bookable slot in the next fortnight, so this file cannot build a hold. ` +
        'That is a defect in availability, not in this suite.',
    );
  }

  const res = await treq<any>('POST', '/bookings', {
    token: member,
    idempotencyKey: key('book'),
    body: { artistId, serviceId, startsAt: slot },
  });
  if (res.status !== 201) throw new Error(`POST /bookings: ${res.status} ${res.raw}`);
  return { id: res.body.booking.id, depositFils: res.body.booking.depositFils };
}

/**
 * Move a booking's three CLOCK columns so it sits INSIDE the grace window.
 *
 * The only thing this changes is WHEN the appointment is. `deposit_fils`, the
 * member's balance and every ledger row are left exactly as the API wrote them —
 * see the file header for why a clock has to be moved at all.
 *
 * STAGGERED, BECAUSE THE ARTIST'S DIARY IS A DATABASE CONSTRAINT. `booking` carries
 * an exclusion constraint on `(artist_id, tstzrange(starts_at, ends_at))` over the
 * live statuses, so parking two of this file's bookings at the same minute is
 * refused by Postgres:
 *
 *     conflicting key value violates exclusion constraint
 *     "booking_artist_slot_no_overlap"
 *
 * which is the constraint doing its job — one artist cannot be in two places — and
 * a real thing to know about testing this path. COMPLETED bookings still occupy
 * their slot, so every placement in the run has to be distinct, not just the live
 * ones. Ten-minute appointments on a ten-minute stride keeps six of them inside the
 * sixty-minute window with no overlap.
 */
/**
 * Release every live hold of hers EXCEPT one, into the far future.
 *
 * Extracted because two different specs need it for the same reason and one of them
 * did not have it. `findApplicableHold` applies the EARLIEST live booking, so any
 * spec asserting something about a specific hold has to be able to say "this is her
 * only one" — otherwise it is asserting against whichever booking a previous spec
 * happened to leave behind.
 *
 * One at a time, because each release takes its own never-reused day: the artist's
 * diary is an exclusion constraint and two bookings parked "30 days out" in two
 * statements land a second apart on the same day, which overlaps.
 */
function parkOtherLiveHolds(exceptId: string): void {
  const others = scalar(
    `select coalesce(string_agg(id, ','), '') from booking
      where member_id='${MEMBER}' and status='deposit_held' and id <> '${exceptId}'`,
  );
  for (const other of others.split(',').filter(Boolean)) moveOutsideWindow(other);
}

/**
 * Placements PER ARTIST, because the exclusion constraint is per artist.
 *
 * A single counter ran the file out of window after six bookings and threw with the
 * advice "give the next spec its own artist" — which was the right advice, and this
 * is what taking it requires: one diary's worth of room does not borrow from
 * another's. Salon A seeds four artists.
 */
const placementsByArtist = new Map<string, number>();
function moveInsideWindow(bookingId: string, options: { parkOthers?: boolean } = {}): void {
  /**
   * FIRST, MAKE THIS HER ONLY LIVE HOLD — and this is API behaviour, not cleanup.
   *
   * `findApplicableHold` applies the EARLIEST live booking, which is right: a
   * customer with two deposits down should have the older one consumed first. But it
   * means a spec whose booking is not her earliest is asserting against a DIFFERENT
   * spec's deposit, and the failure says so in the least obvious possible way —
   * `expected 'BK-2144042' to be 'BK-5749713'`, and a charge that applied 8.000
   * where 10.000 was held.
   *
   * Each spec therefore releases every other live booking of hers into the far
   * future before placing its own. One at a time, because each release takes its own
   * never-reused day: the artist's diary is an exclusion constraint, and parking two
   * bookings "30 days out" in two statements puts them a second apart on one day,
   * which overlaps.
   */
  if (options.parkOthers !== false) parkOtherLiveHolds(bookingId);

  const artistId = scalar(`select artist_id from booking where id='${bookingId}'`);
  const placed = placementsByArtist.get(artistId) ?? 0;
  placementsByArtist.set(artistId, placed + 1);

  const startsIn = 4 + placed * 9;
  if (startsIn + 9 >= GRACE_MINUTES) {
    throw new Error(
      `this file has placed ${placed + 1} bookings inside the ${GRACE_MINUTES}-minute grace ` +
        `window for artist ${artistId} and has run out of room. Give the next spec ANOTHER ` +
        'artist rather than shortening the stride — salon A seeds four — because the appointments ' +
        'would start overlapping and the exclusion constraint would refuse them, which reads as a ' +
        'deposit failure and is not one.',
    );
  }
  psql(`
    UPDATE booking
       SET starts_at             = now() + interval '${startsIn} minutes',
           ends_at               = now() + interval '${startsIn + 8} minutes',
           no_show_return_due_at = now() + interval '${startsIn + 8 + GRACE_MINUTES} minutes'
     WHERE id = '${bookingId}';
  `);
}

/**
 * Release a booking into the far future, out of the window and out of the diary.
 *
 * A DAY NOBODY HAS USED, EVER, and that is the third time the artist's exclusion
 * constraint has shaped this file. `now()` differs between statements, so parking
 * two bookings "30 days out" in two different specs puts them a second apart on the
 * same day — which overlaps, because appointments have duration. The counter only
 * ever increases, so no slot is reused within a run.
 *
 * Used by the expired-grace spec to get its stale booking out of the way, for the
 * reason the last describe in this file records: it used to be the case that while
 * a stale booking was her earliest live one, it hid every other hold she had.
 */
let releasedDay = 20;
function moveOutsideWindow(bookingId: string): void {
  releasedDay += 1;
  psql(`
    UPDATE booking
       SET starts_at             = now() + interval '${releasedDay} days',
           ends_at               = now() + interval '${releasedDay} days' + interval '30 minutes',
           no_show_return_due_at = now() + interval '${releasedDay} days' + interval '90 minutes'
     WHERE id = '${bookingId}';
  `);
}

// ------------------------------------------------- driving the real job ------

interface NoShowTick {
  candidates: number;
  returned: number;
  alreadySettled: number;
  failed: number;
  returnedFils: number;
}

/**
 * ONE PASS OF THE NO-SHOW RETURN JOB, driven the way an operator drives it.
 *
 * `api/src/jobs/no-show-once.ts` exists, and its own docstring says why:
 *
 *   "EVIDENTIAL. 'Running the job twice returns the deposit once' is a claim about
 *    a background loop, and a claim about a background loop that can only be
 *    exercised by waiting for a timer is a claim nobody checks. This makes it two
 *    commands and a diff."
 *
 * Nothing had ever run it. `no_show_returned` — the terminal state it produces —
 * appeared in zero assertions in this suite, while STATUS.md listed the job under
 * What works. So a capability built to make something checkable went unchecked,
 * which is the same shape as `support/api.ts` having been able to target the real
 * API all along while three suites drove fixtures.
 *
 * Run as the SCRIPT rather than by importing the service: that is the path an
 * operator actually uses after an outage, it proves the wiring and the connection
 * env as well as the logic, and the JSON it prints is the diff the docstring
 * promises. Pointed at this run's own database.
 */
function runNoShowJob(): NoShowTick {
  const res = runApiDbScriptResult('src/jobs/no-show-once.ts', pgDb());
  if (!res.ok) {
    throw new Error(
      `the no-show job failed to run at all.\n--- stdout ---\n${res.stdout}\n` +
        `--- stderr ---\n${res.stderr}`,
    );
  }
  const start = res.stdout.indexOf('{');
  if (start < 0) throw new Error(`the job printed no JSON:\n${res.stdout}`);
  return JSON.parse(res.stdout.slice(start)) as NoShowTick;
}

/**
 * TWO PASSES AT ONCE. The only construction that can exercise the status re-check.
 *
 * The job's candidate scan is deliberately UNLOCKED — "this read is a hint, not a
 * decision" — and every row it produces is re-checked under a row lock. Two
 * SEQUENTIAL passes never test that re-check, because the second pass's scan
 * already excludes the settled row; the guard exists solely for the window between
 * one pass's scan and its lock, which is where a second worker can be.
 */
async function runNoShowJobTwiceAtOnce(): Promise<NoShowTick[]> {
  const [a, b] = await Promise.all([
    runApiDbScriptAsync('src/jobs/no-show-once.ts', pgDb()),
    runApiDbScriptAsync('src/jobs/no-show-once.ts', pgDb()),
  ]);
  return [a, b].map((res) => {
    if (!res.ok) {
      throw new Error(
        `a concurrent no-show pass failed to run.\n--- stdout ---\n${res.stdout}\n` +
          `--- stderr ---\n${res.stderr}`,
      );
    }
    const start = res.stdout.indexOf('{');
    if (start < 0) throw new Error(`a pass printed no JSON:\n${res.stdout}`);
    return JSON.parse(res.stdout.slice(start)) as NoShowTick;
  });
}

/** Put a booking's no-show deadline in the past, so the job sees it as due. */
function makeDue(bookingId: string, minutesAgo = 1): void {
  psql(`
    UPDATE booking
       SET no_show_return_due_at = now() - interval '${minutesAgo} minutes'
     WHERE id = '${bookingId}';
  `);
}

/** Her `deposit_return` transactions, which are what the job writes. */
const depositReturnsFor = (memberId: string): number =>
  Number(
    scalar(
      `select count(*) from transaction where member_id='${memberId}' and kind='deposit_return'`,
    ),
  );

async function mintWalletToken(): Promise<string> {
  const res = await treq<any>('GET', '/members/me/wallet-token', { token: member });
  precondition(res.status === 200 && Boolean(res.body.token), `wallet-token: ${res.raw}`);
  precondition(res.body.memberId === MEMBER, `token minted for ${res.body.memberId}`);
  return res.body.token;
}

async function chargeFor(serviceIds: string[]): Promise<any> {
  return treq<any>('POST', '/charges', {
    token: scanner,
    idempotencyKey: key('charge'),
    body: { memberId: MEMBER, token: await mintWalletToken(), serviceIds },
  });
}

beforeAll(async () => {
  await startTenancyApi();
  reseedMember();
  member = await signInMember(SALON_A, MEMBER_PHONE);
  scanner = await signInScanner(SALON_A, A_STAFF_HANDLE, A_SCANNER_DEVICE);
}, 180_000);

afterAll(async () => {
  reseedMember();
  await stopTenancyApi();
});

// ===========================================================================
// The window, from both sides. This is the half that was silently uncovered.
// ===========================================================================

describe('the deposit hold applies only INSIDE the no-show grace window', () => {
  it('a booking nine days out holds NOTHING — the shape that made this look covered', async () => {
    const booking = await bookFuture(MANICURE);
    expect(booking.depositFils, 'the booking did not take the salon deposit').toBe(DEPOSIT_FILS);

    /**
     * ZERO, AND CORRECTLY ZERO. This is the assertion a spec written on
     * contract.test.ts's nine-day booking would have made, and it would have
     * passed for ever while proving nothing — the hold is absent because the
     * appointment is a fortnight away, not because the feature works.
     *
     * It is worth a spec of its own precisely because it is the boundary's other
     * side: without it, the non-zero spec below could be satisfied by an
     * implementation that applied a hold to any booking at all, which would credit
     * a customer for a deposit on an appointment she has not been to yet.
     */
    const envelope = await treq<any>('GET', `/members/${MEMBER}`, { token: scanner });
    expect(envelope.status, envelope.raw).toBe(200);
    expect(
      envelope.body.heldDepositFils,
      'a booking nine days away is being treated as a live deposit hold, so the counter would ' +
        'credit her for an appointment she has not attended',
    ).toBe(0);
    expect(envelope.body.heldDepositBooking).toBeNull();
  });

  it('and the same booking, moved inside the window, holds the deposit on BOTH doors', async () => {
    const booking = await bookFuture(MANICURE);
    moveInsideWindow(booking.id);

    const opened = await treq<any>('GET', `/members/${MEMBER}`, { token: scanner });
    expect(opened.status, opened.raw).toBe(200);
    expect(
      opened.body.heldDepositFils,
      'the booking is inside the grace window and the counter reports no hold, so the customer ' +
        'is asked to pay for a visit she has already put a deposit down for',
    ).toBe(DEPOSIT_FILS);
    expect(opened.body.heldDepositBooking?.id).toBe(booking.id);
    expect(opened.body.heldDepositBooking?.serviceId).toBe(MANICURE);

    /**
     * AND THE SCAN DOOR AGREES, which is the assertion the envelope spec in
     * scanner.test.ts could not make: there, this member has no hold at all, so the
     * deep comparison was at its weakest on the very field whose divergence was the
     * original bug — `heldDepositFils` hardcoded `0` on the scan path while the
     * charge read it for real. Here the value is non-zero, so the comparison finally
     * has something to catch.
     */
    const scanned = await treq<any>('POST', '/scans', {
      token: scanner,
      body: { token: await mintWalletToken() },
    });
    expect(scanned.status, scanned.raw).toBe(200);
    expect(
      scanned.body,
      'the two doors onto the counter disagree while a deposit is actually held — which is the ' +
        'exact defect services/counter.ts was written to make impossible, now testable because ' +
        'the value is no longer 0 on both sides',
    ).toEqual(opened.body);
    expect(scanned.body.heldDepositFils).toBe(DEPOSIT_FILS);
  });

  it('a hold whose grace period has EXPIRED is not applied — the clock closes the window too', async () => {
    const booking = await bookFuture(MANICURE);

    /**
     * HER ONLY LIVE HOLD, AND THIS LINE IS THE WHOLE POINT OF THE SPEC.
     *
     * Without it the preceding spec's booking is still sitting inside the window,
     * and this spec passed anyway — because the product bug it now helps guard
     * against was doing the parking for it. `findApplicableHold` took the earliest
     * booking, which was this expired one, disqualified it and returned nothing, so
     * the assertion below saw `0` for the right number and entirely the wrong
     * reason. Fixing the masking bug removed the accident and exposed the pollution.
     *
     * That is the same failure as a refusal probe whose WHERE clause matches no
     * rows: an assertion satisfied by a coincidence rather than by the behaviour it
     * names. The answer is not to relax the assertion — it is to make the setup say
     * what the sentence claims, which is "an expired hold, and nothing else".
     */
    parkOtherLiveHolds(booking.id);

    // Started an hour ago and the grace ran out a minute ago: `startsAt` is still
    // inside `now + 60`, so only the `noShowReturnDueAt > now` half can refuse it.
    // That half is applied in TypeScript against the same `now` the charge uses,
    // not in SQL, which is why it deserves its own probe.
    psql(`
      UPDATE booking
         SET starts_at             = now() - interval '60 minutes',
             ends_at               = now() - interval '30 minutes',
             no_show_return_due_at = now() - interval '1 minute'
       WHERE id = '${booking.id}';
    `);

    const opened = await treq<any>('GET', `/members/${MEMBER}`, { token: scanner });
    expect(opened.status, opened.raw).toBe(200);
    expect(
      opened.body.heldDepositFils,
      'a deposit whose no-show grace period has already expired is still being offered as a ' +
        'credit. The no-show job is what returns that money to her; applying it here as well ' +
        'would spend it twice.',
    ).toBe(0);

    /**
     * AND THIS SPEC CLEANS UP AFTER ITSELF, which is not housekeeping — it is the
     * defect at the bottom of this file. While this stale booking is her earliest
     * live one, `findApplicableHold` picks it, disqualifies it and returns nothing,
     * hiding every valid hold she has. Leaving it here made four later specs fail
     * and pass again under `-t`, which is the worst way to find that out.
     */
    moveOutsideWindow(booking.id);
  });
});

// ===========================================================================
// The charge that consumes it
// ===========================================================================

describe('POST /charges consumes the hold, and the arithmetic is the whole feature', () => {
  it('a visit DEARER than the deposit debits only the difference, and completes the booking', async () => {
    reseedMember();
    const booking = await bookFuture(BLOW_DRY);
    moveInsideWindow(booking.id);

    const afterBooking = balanceOf(MEMBER);
    expect(
      afterBooking,
      'the booking did not debit the deposit from her wallet',
    ).toBe(MEMBER_OPENING_FILS - DEPOSIT_FILS);
    const heldBefore = depositHeldFor(MEMBER);
    precondition(heldBefore > 0, 'no deposit_held ledger position exists');

    const charged = await chargeFor([BLOW_DRY]);
    expect(charged.status, charged.raw).toBe(200);

    // gross 8000, held 5000 → applied 5000, due 3000, nothing returned.
    expect(charged.body.depositAppliedFils, 'the hold was not applied to the charge').toBe(
      DEPOSIT_FILS,
    );
    expect(charged.body.depositReturnedFils).toBe(0);
    expect(
      charged.body.transaction.amountFils,
      'the charge debited the whole visit price and ignored the deposit she had already paid, ' +
        'which is charging her twice for the same 5.000',
    ).toBe(-(BLOW_DRY_FILS - DEPOSIT_FILS));
    expect(charged.body.bookingId).toBe(booking.id);

    // Her wallet: opening − deposit − the remaining difference.
    expect(balanceOf(MEMBER)).toBe(MEMBER_OPENING_FILS - BLOW_DRY_FILS);
    expect(charged.body.balanceAfterFils).toBe(balanceOf(MEMBER));

    // The booking is settled, and THIS hold is released rather than left standing.
    expect(bookingStatus(booking.id)).toBe('completed');
    /**
     * A DELTA, NOT ZERO. `depositHeldFor` is member-wide — the `deposit_held` leg
     * carries no booking reference and no member id, so the position can only be
     * summed per customer — and earlier specs in this file leave her holding
     * deposits on appointments they never charged. Asserting zero here passed only
     * while this describe was run on its own, which is the shape of an
     * order-dependent spec.
     */
    expect(
      depositHeldFor(MEMBER),
      'completing the booking did not release its deposit from the held account, so the money is ' +
        'still held against an appointment that is over',
    ).toBe(heldBefore - DEPOSIT_FILS);
  });

  it('MIGRATION 0014: a visit CHEAPER than the deposit charges ZERO and returns the change', async () => {
    /**
     * THE CASE NOBODY HAD EVER DRIVEN, and the one where a naive implementation
     * either debits a negative amount or quietly keeps her change.
     *
     * 0014 exists because `amount_fils = 0` failed the original sign CHECK: a
     * charge fully covered by a deposit debits NOTHING further, and the constraint
     * demanded `amount_fils < 0` for a charge. It was relaxed to
     * `charge AND amount_fils <= 0` for exactly this shape — and until this spec,
     * that relaxation had never been exercised by anything in the repository.
     *
     * REACHED BY RAISING THE SALON DEPOSIT rather than by adding a cheap service.
     * `salon.deposit_fils` is CHECKed between 1000 and 10000 and every seeded
     * service costs more than the seeded 5000, so this situation is unreachable
     * with the fixtures as they stand. A merchant taking a 10.000 deposit for a
     * colour appointment and then doing a 6.000 manicure is the ordinary form of
     * it. Restored in a `finally`, because the deposit is salon-wide configuration
     * and every other file reads it.
     */
    const RAISED_DEPOSIT = 10_000;
    reseedMember();
    psql(`UPDATE salon SET deposit_fils = ${RAISED_DEPOSIT} WHERE id = '${SALON_A}';`);

    try {
      const booking = await bookFuture(MANICURE);
      expect(booking.depositFils, 'the booking did not take the raised deposit').toBe(
        RAISED_DEPOSIT,
      );
      moveInsideWindow(booking.id);

      const charged = await chargeFor([MANICURE]);
      expect(charged.status, charged.raw).toBe(200);

      // gross 6000, held 10000 → applied 6000, due 0, returned 4000.
      expect(
        charged.body.transaction.amountFils,
        'a visit fully covered by the deposit did not charge ZERO. A negative amount here debits ' +
          'her again for a visit she has already paid for; a positive one is a charge that pays ' +
          'her.',
      ).toBe(0);
      expect(charged.body.depositAppliedFils).toBe(MANICURE_FILS);
      expect(
        charged.body.depositReturnedFils,
        'the deposit was bigger than the visit and the difference was NOT returned, so the salon ' +
          'has quietly kept her change',
      ).toBe(RAISED_DEPOSIT - MANICURE_FILS);

      // Integer fils throughout — non-negotiable #1 at the one boundary where a
      // division would be tempting.
      for (const v of [
        charged.body.transaction.amountFils,
        charged.body.depositAppliedFils,
        charged.body.depositReturnedFils,
        charged.body.balanceAfterFils,
      ]) {
        expect(Number.isInteger(v), `${v} is not integer fils`).toBe(true);
      }

      /**
       * THE RETURN IS ITS OWN TRANSACTION, not a smaller charge. A customer looking
       * at her activity feed has to be able to see "5.000 held, 6.000 visit,
       * 4.000 back" as events; folding the return into the charge amount makes the
       * arithmetic invisible and the row unexplainable.
       */
      const returns = Number(
        scalar(
          `select count(*) from transaction
            where member_id='${MEMBER}' and kind='deposit_return'
              and amount_fils=${RAISED_DEPOSIT - MANICURE_FILS}`,
        ),
      );
      expect(
        returns,
        'no deposit_return transaction was written for the change, so the money moved with ' +
          'nothing in the ledger explaining why',
      ).toBeGreaterThan(0);

      // Her wallet ends down by exactly the visit, not by the deposit.
      expect(balanceOf(MEMBER)).toBe(MEMBER_OPENING_FILS - MANICURE_FILS);
      expect(bookingStatus(booking.id)).toBe('completed');
    } finally {
      psql(`UPDATE salon SET deposit_fils = ${DEPOSIT_FILS} WHERE id = '${SALON_A}';`);
    }
  });
});

// ===========================================================================
// The ledger these specs read as truth
// ===========================================================================

describe('and the ledger every assertion above trusts cannot be erased', () => {
  it('ledger_entry refuses UPDATE, DELETE and — the one that was missing — TRUNCATE', async () => {
    /**
     * WHY THIS BELONGS IN THIS FILE. Every deposit assertion above answers "is it
     * still held" from `ledger_entry`, because there is no column for it: the hold is
     * a double-entry pair and the position is credits minus debits. That makes this
     * table the evidence, and evidence is only as good as its immutability.
     *
     * TRUNCATE IS NEITHER AN UPDATE NOR A DELETE, and that is the whole point. A
     * `BEFORE … FOR EACH ROW` trigger never fires for it, because TRUNCATE produces
     * no row events — so this table refused every UPDATE and every DELETE and could
     * still be emptied by one statement, which returned "TRUNCATE TABLE" without
     * complaint and left every `member.balance_fils` a number with nothing behind
     * it. Exactly the derivation this file spends seven specs establishing.
     *
     * Named per verb rather than as "append-only like audit_log", because that
     * phrase is now wrong for two of the four immutable tables: consent events allow
     * DELETE through the member cascade on purpose, and `loyalty_event` allows all
     * three by 0008's written decision.
     */
    const asOwner = (statement: string): string => {
      try {
        psql(statement);
        return '';
      } catch (err) {
        return String((err as Error).message);
      }
    };
    const asApp = (statement: string): string => {
      try {
        psql(`SET ROLE avo_app; ${statement}`);
        return '';
      } catch (err) {
        return String((err as Error).message);
      }
    };

    const rowsBefore = Number(scalar('select count(*) from ledger_entry'));
    precondition(rowsBefore > 0, 'there are no ledger rows to protect');

    /**
     * AIMED AT A ROW THAT DEFINITELY EXISTS, and the first draft was not.
     *
     * It targeted `WHERE account = 'deposit_held'`, and run on its own — with the
     * booking specs filtered out — nothing had created such a row yet. A
     * `BEFORE … FOR EACH ROW` trigger never fires when no row matches, so the
     * statement succeeded trivially and the spec reported that the OWNER CAN REWRITE
     * THE LEDGER. A false alarm on the money record, from a WHERE clause that
     * matched nothing.
     *
     * That is the "no empty samples" rule for a third time in this suite, and it is
     * worth naming because the failure mode inverts here: elsewhere an empty sample
     * makes a spec pass while proving nothing, and here it made one FAIL while
     * proving nothing. Both come from asserting against a set nobody checked was
     * non-empty.
     */
    const victim = scalar('select id from ledger_entry order by seq limit 1');
    precondition(victim !== '', 'no ledger row id came back to aim at');

    expect(
      asApp(`UPDATE ledger_entry SET amount_fils = 1 WHERE id = '${victim}';`),
      'the application role can rewrite a ledger amount',
    ).toMatch(/permission denied|append-only/i);
    expect(
      asOwner(`UPDATE ledger_entry SET amount_fils = 1 WHERE id = '${victim}';`),
      'the OWNER can rewrite a ledger amount, so the money record is editable',
    ).toMatch(/append-only/i);
    expect(
      asOwner(`DELETE FROM ledger_entry WHERE id = '${victim}';`),
      'the OWNER can delete ledger rows',
    ).toMatch(/append-only/i);
    expect(
      asOwner('TRUNCATE ledger_entry;'),
      'LEDGER_ENTRY CAN BE TRUNCATED. One statement erases every derivation behind every ' +
        'balance in the system, and a row-level trigger cannot see it coming.',
    ).toMatch(/append-only/i);

    expect(
      Number(scalar('select count(*) from ledger_entry')),
      'ledger rows disappeared while this spec was asserting that they cannot',
    ).toBe(rowsBefore);
  });
});

// ===========================================================================
// Non-negotiable #3 — one transaction, all or nothing
// ===========================================================================

describe('the charge is ONE transaction: if the debit fails, the deposit is untouched', () => {
  it('a shortfall on the remainder leaves the hold, the booking and the visit count exactly as they were', async () => {
    reseedMember();
    const booking = await bookFuture(BLOW_DRY);
    moveInsideWindow(booking.id);

    /**
     * Her balance is set to LESS than the difference the charge still needs. The
     * deposit is already held, so the charge needs `8000 − 5000 = 3000` and she has
     * 1000. That is a 402, and non-negotiable #3 says nothing else happened.
     *
     * Set with SQL rather than by spending it, because spending it would itself
     * create transactions and stamps and make "nothing changed" impossible to
     * assert against a known baseline.
     */
    psql(`UPDATE member SET balance_fils = 1000 WHERE id = '${MEMBER}';`);

    const heldBefore = depositHeldFor(MEMBER);
    const visitsBefore = visitsOf(MEMBER);
    const balanceBefore = balanceOf(MEMBER);
    const statusBefore = bookingStatus(booking.id);
    // A DELTA, because earlier specs in this file charged her for real. Absolute
    // counts against a shared fixture are order-dependent specs wearing a disguise —
    // this is the third one this file has taught me.
    const chargeRowsBefore = Number(
      scalar(`select count(*) from transaction where member_id='${MEMBER}' and kind='charge'`),
    );
    precondition(statusBefore === 'deposit_held', `the booking is ${statusBefore}`);

    const charged = await chargeFor([BLOW_DRY]);
    expect(charged.status, `the charge was accepted on an insufficient balance: ${charged.raw}`).toBe(
      402,
    );
    expect(charged.body.error).toBe('insufficient_balance');
    // The shortfall is against the REMAINDER, not the gross: she has already paid
    // 5.000 of this visit, and a 402 that named 7.000 would be asking her to top up
    // money she does not owe.
    expect(
      charged.body.shortfallFils,
      'the shortfall is computed against the full price and ignores the deposit already held, so ' +
        'she is told to top up more than she owes',
    ).toBe(BLOW_DRY_FILS - DEPOSIT_FILS - balanceBefore);

    // ALL OR NOTHING, checked on every part the charge would have touched.
    expect(balanceOf(MEMBER), 'the failed charge moved money').toBe(balanceBefore);
    expect(
      depositHeldFor(MEMBER),
      'the failed charge CONSUMED THE DEPOSIT. Her 5.000 is gone and she was told the charge did ' +
        'not go through — the exact shape non-negotiable #3 exists to forbid.',
    ).toBe(heldBefore);
    expect(
      bookingStatus(booking.id),
      'the failed charge completed the booking, so the appointment is settled and unpaid',
    ).toBe('deposit_held');
    expect(visitsOf(MEMBER), 'the failed charge counted a visit').toBe(visitsBefore);
    expect(
      Number(scalar(`select count(*) from transaction where member_id='${MEMBER}' and kind='charge'`)),
      'a charge row was written for a charge that was refused',
    ).toBe(chargeRowsBefore);

    // And she can still be charged once she has the money — the hold survived
    // intact and is applied to the retry.
    psql(`UPDATE member SET balance_fils = ${MEMBER_OPENING_FILS} WHERE id = '${MEMBER}';`);
    const retry = await chargeFor([BLOW_DRY]);
    expect(retry.status, retry.raw).toBe(200);
    expect(
      retry.body.depositAppliedFils,
      'the deposit was not applied to the retry, so the refused charge lost it after all',
    ).toBe(DEPOSIT_FILS);
    expect(bookingStatus(booking.id)).toBe('completed');
  });
});

// ===========================================================================
// Tenancy — the todo in tenancy.test.ts said this was unimplemented
// ===========================================================================

describe('a deposit held at one salon cannot be applied to a charge at another', () => {
  it('salon B\'s scanner sees no hold for a salon A member, and cannot charge her at all', async () => {
    reseedMember();
    const booking = await bookFuture(MANICURE);
    moveInsideWindow(booking.id);

    // The control: her own salon does see it.
    const own = await treq<any>('GET', `/members/${MEMBER}`, { token: scanner });
    precondition(
      own.status === 200 && own.body.heldDepositFils === DEPOSIT_FILS,
      `salon A cannot see its own hold: ${own.status} ${own.raw}`,
    );

    /**
     * `findApplicableHold` predicates on `salonId` as well as `memberId`, so the
     * hold is invisible from salon B — but a salon B scanner cannot reach this
     * member at all, which is the stronger boundary and the one that has already
     * leaked once on this project. Both are asserted: the 404 is the outer wall and
     * the salon predicate on the hold is the inner one, and a spec that only proved
     * the outer would go quiet the day a route stopped enforcing it.
     */
    const foreign = await signInScanner(SALON_B, 'layla', 'DEV-SCANNER-B');
    const seen = await treq<any>('GET', `/members/${MEMBER}`, { token: foreign });
    expect(
      seen.status,
      `salon B opened a salon A member and read her deposit: ${seen.raw}`,
    ).toBe(404);
    expect(seen.raw, 'the refusal leaked her name').not.toContain('Deposit Fixture');

    // And the inner wall, read directly: no ledger position of hers is visible to
    // salon B's own hold query, whatever route might one day call it.
    expect(
      Number(
        scalar(
          `select count(*) from booking
            where member_id='${MEMBER}' and salon_id='${SALON_B}' and status='deposit_held'`,
        ),
      ),
      'a booking of hers is recorded against salon B',
    ).toBe(0);
  });
});

// ===========================================================================
// The rule for more than one live hold
// ===========================================================================

/**
 * PROMOTED FROM knownBug, AND THE FIX WENT IN AT THE CAUSE.
 *
 * `findApplicableHold` used to apply `LIMIT 1` BEFORE testing expiry:
 *
 *     .orderBy(asc(booking.startsAt)).limit(1)   ...then, in TypeScript:
 *     if (row.noShowReturnDueAt <= params.now) return null;
 *
 * so one stale hold sorted ahead of a live one returned "no hold at all". The
 * customer-facing version: she no-shows on Monday, the return job has not run yet,
 * she books Tuesday and attends — and her Tuesday deposit was invisible at the
 * counter. She was charged full price for a visit she had already put money down
 * on, with no credit line on screen to dispute. Lane A drove it end to end:
 * `heldDepositFils` 0 → 5000 and the charge −8000 → −3000.
 *
 * The expiry test still runs in application code, and still should — it compares
 * against the same `now` the charge uses everywhere else rather than the database's
 * clock a few milliseconds later. What changed is that the query no longer throws
 * away the rows that would have qualified before the test is applied.
 */
describe('with more than one live hold, the earliest applicable one is used — and only one', () => {
  it('a stale expired hold does not hide a live one behind it', async () => {
    reseedMember();

    // Tuesday: her live booking, through the normal allocator.
    const live = await bookFuture(MANICURE);
    moveInsideWindow(live.id);

    // Monday: she no-showed and the return job has not run. Straight into the past,
    // which needs no in-window slot — and NOT parked, because the coexistence of
    // these two rows is the entire point.
    const stale = await bookFuture(MANICURE);
    psql(`
      UPDATE booking
         SET starts_at             = now() - interval '50 minutes',
             ends_at               = now() - interval '20 minutes',
             no_show_return_due_at = now() - interval '1 minute'
       WHERE id = '${stale.id}';
    `);

    const opened = await treq<any>('GET', `/members/${MEMBER}`, { token: scanner });
    expect(opened.status, opened.raw).toBe(200);
    expect(
      opened.body.heldDepositFils,
      'her live deposit is hidden by an expired one, so the counter charges her full price for a ' +
        'visit she has already put money down for',
    ).toBe(DEPOSIT_FILS);
    expect(opened.body.heldDepositBooking?.id).toBe(live.id);

    // And the stale one is left alone: it is the no-show return job's to settle, and
    // a counter read must not quietly consume or cancel it.
    expect(
      bookingStatus(stale.id),
      'reading the counter changed the stale booking, so a screen refresh is deciding the fate of ' +
        'a deposit that belongs to the no-show job',
    ).toBe('deposit_held');
  }, 120_000);

  /**
   * THE RULE NOBODY HAD WRITTEN DOWN, and it is a money rule.
   *
   * Two live holds means two deposits she has actually paid. Applying both to one
   * basket would spend money held against an appointment SHE HAS NOT ATTENDED —
   * the salon would be crediting her for a visit that may still be a no-show, and
   * the second booking would then complete with nothing behind it. So exactly one
   * hold is consumed per charge, and it is the earliest applicable one, because an
   * older deposit is the one closer to its own no-show deadline.
   */
  it('a charge consumes exactly ONE hold, the earliest, and leaves the other standing', async () => {
    reseedMember();

    /**
     * A BASELINE, BECAUSE `depositHeldFor` IS MEMBER-WIDE. The `deposit_held` leg
     * carries neither a member id nor a booking reference, so the position can only
     * be summed per customer — and earlier specs in this file leave her holding
     * deposits on bookings they parked and never charged. This spec asserted
     * `heldBefore === DEPOSIT_FILS * 2` and passed alone and failed in the file,
     * which is the third time this file has taught me the same lesson in a new
     * costume: an absolute count against a shared fixture is an order-dependent spec
     * wearing a disguise.
     */
    const heldAtStart = depositHeldFor(MEMBER);

    // Two live bookings, both inside the window, the earlier one first. On her own
    // artist, because AR-001's hour is spent by the specs above.
    const earlier = await bookFuture(MANICURE, SECOND_ARTIST);
    moveInsideWindow(earlier.id);
    const later = await bookFuture(MANICURE, SECOND_ARTIST);
    moveInsideWindow(later.id, { parkOthers: false });

    const earlierStart = scalar(`select starts_at from booking where id='${earlier.id}'`);
    const laterStart = scalar(`select starts_at from booking where id='${later.id}'`);
    precondition(
      earlierStart < laterStart,
      `the allocator did not place ${earlier.id} before ${later.id}`,
    );

    const heldBefore = depositHeldFor(MEMBER);
    precondition(
      heldBefore === heldAtStart + DEPOSIT_FILS * 2,
      `the two bookings added ${heldBefore - heldAtStart} to the held account, not two deposits`,
    );

    const charged = await chargeFor([BLOW_DRY]);
    expect(charged.status, charged.raw).toBe(200);

    // ONE deposit applied, not two: gross 8000 − one 5000 hold = 3000 due.
    expect(
      charged.body.depositAppliedFils,
      'the charge applied more than one held deposit, so it spent money she has down against an ' +
        'appointment she has not attended yet',
    ).toBe(DEPOSIT_FILS);
    expect(charged.body.transaction.amountFils).toBe(-(BLOW_DRY_FILS - DEPOSIT_FILS));
    expect(charged.body.depositReturnedFils).toBe(0);

    // The EARLIEST one is the one that settled.
    expect(charged.body.bookingId).toBe(earlier.id);
    expect(bookingStatus(earlier.id)).toBe('completed');
    expect(
      bookingStatus(later.id),
      'the charge settled the later booking as well, so an appointment she has not been to is ' +
        'marked complete and its deposit is gone',
    ).toBe('deposit_held');

    // And exactly one deposit came out of the held account.
    expect(depositHeldFor(MEMBER)).toBe(heldBefore - DEPOSIT_FILS);
  }, 120_000);
});

// ===========================================================================
// THE NO-SHOW RETURN JOB — the money path nothing had ever run
// ===========================================================================

/**
 * She books, puts a deposit down, and does not come. The grace period passes and
 * the deposit is hers again — that is the promise, and `no_show_returned` is the
 * state that keeps it.
 *
 * WHY THIS BLOCK IS ABOUT MONEY AND NOT ABOUT A STATUS. A spec asserting only that
 * the booking reached `no_show_returned` would pass against a job that flipped a
 * column and returned nothing, which is the worst possible outcome here: the
 * customer's deposit is neither held nor returned, and the booking says it was
 * settled. So every assertion below is on the BALANCE and the LEDGER, read out of
 * Postgres, with the status as a corroborating detail rather than the claim.
 */
describe('the no-show return job gives the deposit back, exactly once', () => {
  it('returns a held deposit whose grace period has expired, in full, to her wallet', async () => {
    reseedMember();
    const booking = await bookFuture(MANICURE, THIRD_ARTIST);
    moveInsideWindow(booking.id);

    const balanceBefore = balanceOf(MEMBER);
    const heldBefore = depositHeldFor(MEMBER);
    const returnsBefore = depositReturnsFor(MEMBER);
    precondition(
      heldBefore >= DEPOSIT_FILS,
      `she holds ${heldBefore}, so there is no deposit for the job to return`,
    );

    // The grace period runs out. This is the ONLY thing that changes.
    makeDue(booking.id);

    const tick = runNoShowJob();
    expect(
      tick.returned,
      `the job saw ${tick.candidates} candidate(s) and returned ${tick.returned}: ${JSON.stringify(tick)}`,
    ).toBeGreaterThanOrEqual(1);

    // THE MONEY, from the database.
    expect(
      balanceOf(MEMBER),
      'the job settled the booking without giving the deposit back, so her 5.000 is neither held ' +
        'nor returned and the row says it was resolved',
    ).toBe(balanceBefore + DEPOSIT_FILS);

    // The held position is released, not merely forgotten.
    expect(
      depositHeldFor(MEMBER),
      'the deposit_held ledger account still carries this deposit after the job returned it',
    ).toBe(heldBefore - DEPOSIT_FILS);

    /**
     * ITS OWN `deposit_return` TRANSACTION. The same reasoning as the change on a
     * cheap visit: a customer looking at her activity feed has to see the money
     * come back as an event. A balance that moves with nothing behind it is the
     * shape of a reconciliation nobody can perform later.
     */
    expect(
      depositReturnsFor(MEMBER),
      'the balance moved with no deposit_return transaction explaining it',
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

    expect(bookingStatus(booking.id)).toBe('no_show_returned');
  }, 120_000);

  it('and running it AGAIN returns nothing further — the second pass succeeds and is a no-op', async () => {
    reseedMember();
    const booking = await bookFuture(MANICURE, THIRD_ARTIST);
    moveInsideWindow(booking.id);
    makeDue(booking.id);

    const balanceBefore = balanceOf(MEMBER);
    const returnsBefore = depositReturnsFor(MEMBER);

    // ---- pass one, which must DO something -----------------------------------
    const first = runNoShowJob();
    precondition(
      first.returned >= 1,
      `the first pass returned nothing, so this spec cannot tell idempotence from inaction: ` +
        JSON.stringify(first),
    );
    const balanceAfterFirst = balanceOf(MEMBER);
    const returnsAfterFirst = depositReturnsFor(MEMBER);

    /**
     * THE ASSERTION THAT STOPS THIS BEING VACUOUS, and it is the one this suite has
     * got wrong four times in other costumes. "Running it twice returns the deposit
     * once" is satisfied by a job that returns it ZERO times, so the first pass
     * having actually moved the money is asserted before the second pass runs — not
     * assumed from the fact that it exited 0.
     */
    expect(
      balanceAfterFirst,
      'the first pass did not return the deposit, so the idempotence check below would pass on a ' +
        'job that does nothing at all',
    ).toBe(balanceBefore + DEPOSIT_FILS);
    expect(returnsAfterFirst).toBe(returnsBefore + 1);
    expect(bookingStatus(booking.id)).toBe('no_show_returned');

    // ---- pass two, which must SUCCEED and change nothing ---------------------
    /**
     * AND IT MUST SUCCEED. This is the case where "assert the system refused" does
     * NOT apply: a second pass is a scheduled worker's next tick, not a caller
     * doing something wrong, so an error would be a job that breaks itself after an
     * outage. The correct behaviour is a clean run that finds the work already done
     * — which the job reports as `alreadySettled` rather than silently.
     */
    const second = runNoShowJob();
    expect(
      second.returned,
      `the second pass returned ${second.returned} deposit(s) — she has been paid twice for one ` +
        `no-show, and the salon is short: ${JSON.stringify(second)}`,
    ).toBe(0);

    expect(
      balanceOf(MEMBER),
      'the second pass moved money. One no-show, two refunds.',
    ).toBe(balanceAfterFirst);
    expect(
      depositReturnsFor(MEMBER),
      'the second pass wrote a second deposit_return for one deposit',
    ).toBe(returnsAfterFirst);
    expect(bookingStatus(booking.id)).toBe('no_show_returned');
  }, 120_000);

  it('never touches a COMPLETED booking, whose deposit the charge already spent', async () => {
    reseedMember();
    const booking = await bookFuture(BLOW_DRY, THIRD_ARTIST);
    moveInsideWindow(booking.id);

    // She came, and was charged. The deposit was applied to the visit.
    const charged = await chargeFor([BLOW_DRY]);
    precondition(charged.status === 200, `the charge answered ${charged.status} ${charged.raw}`);
    precondition(
      charged.body.depositAppliedFils === DEPOSIT_FILS,
      `the charge applied ${charged.body.depositAppliedFils}, so this booking's deposit was not spent`,
    );
    precondition(bookingStatus(booking.id) === 'completed', 'the charge did not complete it');

    /**
     * AND NOW THE DEADLINE PASSES ANYWAY, which is the case worth testing rather
     * than the obvious one. The no-show clock is stamped at booking time and keeps
     * running after the visit; nothing rewinds it when she turns up. So a completed
     * booking becomes DUE by the job's scan predicate, and the only thing standing
     * between that and a double payout is the status re-check under the lock.
     */
    makeDue(booking.id);

    const balanceBefore = balanceOf(MEMBER);
    const returnsBefore = depositReturnsFor(MEMBER);

    const tick = runNoShowJob();

    expect(
      balanceOf(MEMBER),
      'the job refunded a deposit that the charge had already applied to a visit she attended — ' +
        'she has the service and the money, and the salon has neither',
    ).toBe(balanceBefore);
    expect(depositReturnsFor(MEMBER)).toBe(returnsBefore);
    expect(
      bookingStatus(booking.id),
      'the job moved a completed booking to no_show_returned',
    ).toBe('completed');
    // The scan may legitimately have had other candidates; what matters is that it
    // did not count this one.
    expect(tick.failed, `the job reported failures: ${JSON.stringify(tick)}`).toBe(0);
  }, 120_000);

  it('and not before the grace period expires — a deposit still inside its window is left alone', async () => {
    reseedMember();
    const booking = await bookFuture(MANICURE, THIRD_ARTIST);
    moveInsideWindow(booking.id);

    /**
     * NO `makeDue` HERE. `moveInsideWindow` puts the appointment minutes from now
     * with its deadline an hour past that, so this booking is held and NOT due.
     *
     * THE TRAP THIS AVOIDS, which caught two lanes on this path already: a booking
     * far in the FUTURE is not due either, so a spec built on one passes against a
     * job with no deadline check whatsoever. This booking is inside the grace
     * window and genuinely holds a deposit — asserted below — so "the job left it
     * alone" is a statement about the deadline and not about an empty fixture.
     */
    const heldBefore = depositHeldFor(MEMBER);
    precondition(
      heldBefore >= DEPOSIT_FILS,
      'this booking holds no deposit, so leaving it alone proves nothing',
    );
    const dueAt = scalar(`select no_show_return_due_at from booking where id='${booking.id}'`);
    precondition(dueAt !== '', 'the booking has no deadline');

    const balanceBefore = balanceOf(MEMBER);
    const returnsBefore = depositReturnsFor(MEMBER);

    runNoShowJob();

    expect(
      balanceOf(MEMBER),
      `the job returned a deposit whose grace period has not expired (due ${dueAt}). She may still ` +
        'walk in, and the charge would then find no deposit to apply.',
    ).toBe(balanceBefore);
    expect(depositReturnsFor(MEMBER)).toBe(returnsBefore);
    expect(depositHeldFor(MEMBER), 'the held position moved').toBe(heldBefore);
    expect(bookingStatus(booking.id)).toBe('deposit_held');
  }, 120_000);
});

// ===========================================================================
// The guard that only a race can reach
// ===========================================================================

/**
 * TWO WORKERS AT ONCE, WHICH IS THE ONLY THING THAT TESTS THE RE-CHECK.
 *
 * The four specs above are real and they pass, but it is worth being precise about
 * WHAT they exercise, because it is not what the job's own comment says is
 * load-bearing. `noShowWorker.ts` calls the status re-check under the lock "the
 * single line that makes the job idempotent" — and none of those four can reach it.
 * The candidate scan filters `status = 'deposit_held'`, so by the time a second
 * SEQUENTIAL pass runs, the settled row is not a candidate at all.
 *
 * Measured rather than reasoned: removing the re-check alone left all four green,
 * and removing the scan predicate alone left all four green. Only removing BOTH
 * produced a double payout. They are two independent guards that cover each other,
 * which is good design and bad for evidence — each one hides the other's absence.
 *
 * So the re-check needs a race, and this is it: two passes launched together, both
 * scanning before either commits. Exactly the same shape as the wallet token, where
 * the row lock and the conditional consumption also had to be removed together
 * before a five-way charge race could see anything.
 */
describe('two no-show passes racing on one deposit still return it once', () => {
  it('both passes succeed, one returns it, and her balance moves once', async () => {
    reseedMember();
    const booking = await bookFuture(MANICURE, THIRD_ARTIST);
    moveInsideWindow(booking.id);
    makeDue(booking.id);

    const balanceBefore = balanceOf(MEMBER);
    const returnsBefore = depositReturnsFor(MEMBER);
    precondition(
      depositHeldFor(MEMBER) >= DEPOSIT_FILS,
      'there is no held deposit for the two passes to contend over',
    );

    const [a, b] = await runNoShowJobTwiceAtOnce();
    precondition(a !== undefined && b !== undefined, 'a racing pass produced no result');

    /**
     * BOTH MUST SUCCEED. A crash here would be a scheduled worker that breaks when
     * it overlaps its own previous tick — which is exactly what happens after an
     * outage, when a manual drain and the in-process worker run together. That is
     * the operational case the one-shot script was written for.
     */
    expect(
      [a, b].every((t) => t.failed === 0),
      `a racing pass reported failures: ${JSON.stringify([a, b])}`,
    ).toBe(true);

    /**
     * EXACTLY ONE RETURN BETWEEN THEM. Asserted on the money, because the counts
     * are per-process and either pass may legitimately be the one that wins.
     */
    expect(
      balanceOf(MEMBER),
      `two racing passes returned ${(balanceOf(MEMBER) - balanceBefore) / DEPOSIT_FILS} deposits. ` +
        'She has been refunded twice for one no-show and the salon is short the difference. ' +
        `Passes reported: ${JSON.stringify([a, b])}`,
    ).toBe(balanceBefore + DEPOSIT_FILS);

    expect(
      depositReturnsFor(MEMBER),
      'two deposit_return transactions exist for one deposit',
    ).toBe(returnsBefore + 1);

    // And the loser reported it as already settled rather than silently doing
    // nothing — which is what makes an operator able to tell a no-op from a miss.
    expect(
      a.returned + b.returned,
      `the two passes returned ${a.returned + b.returned} between them: ${JSON.stringify([a, b])}`,
    ).toBe(1);

    expect(bookingStatus(booking.id)).toBe('no_show_returned');
  }, 180_000);
});

// ===========================================================================
// DELETE /bookings/{id} — the deposit going back OUT, which nothing had ever
// called.
//
// WHY THIS BLOCK EXISTS
// ---------------------
// `cancelBooking` refunds a deposit into a wallet. It was reachable, registered
// and finished — and `grep` for `/bookings/` inside an `expect`, for
// `already_cancelled`, for `not_cancellable` or for `DELETE.*bookings` across
// every `*.test.ts` in this repository returned nothing at all. The no-show
// route into `returnDeposit` was covered from three angles; the customer-facing
// route into the same function was covered from none.
//
// THE MEASUREMENT THAT SAYS SO, rather than the impression
// -------------------------------------------------------
// `cancelBooking`'s only decision is one line:
//
//     if (row.status !== 'deposit_held') { throw conflict('already_cancelled' | …) }
//
// Replaced with `if (false)` — so a settled booking refunds again — the WHOLE
// suite stayed green: 14 files, 516 passed, 33 todo, exit 0. Not one spec moved.
// That is the difference between a layer that is redundant and a layer that is
// simply unwatched, and this one was unwatched.
//
// AND IT HAS NOTHING BEHIND IT, which is what makes the gap matter rather than
// merely being untidy. The comparable path on the money-IN side, `topup.ts`
// § creditWallet, ends its credit with a conditional UPDATE — `WHERE id = … AND
// status IN (predecessors)` — and throws when it matches zero rows. The return
// path's equivalent write is
//
//     await tx.update(booking).set({ status: 'cancelled', … })
//              .where(eq(booking.id, row.id));
//
// unconditional, with no row count consulted. `booking` also carries no
// status-transition trigger: migration 0013 says so deliberately ("booking is
// state that legitimately changes"), and its four CHECK constraints police a
// status against its own timestamp columns, not against the status before it. A
// second return therefore writes `cancelled` over `cancelled` with a fresh
// `settled_transaction_id`, and every constraint in the schema is satisfied.
//
// So on this path the re-check under the row lock is not the last line of
// defence, it is the ONLY one, and until this block nothing exercised it.
// ===========================================================================

/** The fourth diary. The three above are spent; salon A seeds four. */
const FOURTH_ARTIST = 'AR-004';

const cancel = (bookingId: string) =>
  treq<any>('DELETE', `/bookings/${bookingId}`, { token: member });

/** Her `deposit_return` rows for ONE booking, which is what a double refund doubles. */
const returnsForBooking = (bookingId: string): number =>
  Number(
    scalar(
      `select count(*) from transaction t
         join booking b on b.settled_transaction_id = t.id
        where b.id = '${bookingId}' and t.kind = 'deposit_return'`,
    ),
  );

/**
 * WHICH LAYER IS ACTUALLY HOLDING THIS, MEASURED BY ABLATION.
 *
 * Every spec below asserts `already_cancelled` / `not_cancellable`, which are the
 * HANDLER's refusals — `cancelBooking`'s `if (row.status !== 'deposit_held')`. Since
 * that check answers first, none of them can reach the second layer:
 * `returnDeposit`'s UPDATE now carries `status = 'deposit_held'` in its WHERE and
 * throws `deposit_already_returned` on a zero row count. So this block proves the
 * OUTER guard and says nothing about the inner one — and a reader could reasonably
 * assume the inner one is covered here. It is not, and it cannot be from this file.
 *
 * So it was ablated instead. `if (row.status !== 'deposit_held')` in
 * `api/src/services/booking.ts` was temporarily replaced with `if (false)` — one
 * line, restored by checksum immediately afterwards
 * (7affc7401ee10d673549d28f2d4c1d5704516281aec88d0d0a6a4f73cb76eaef), with
 * `git diff -- api/` confirmed empty. With the handler's check gone, a second
 * cancel of one booking:
 *
 *   second cancel -> 409 {"error":"deposit_already_returned", ...}
 *   balance settled=200000 after=200000   deposit_return rows for the booking: 1
 *   settled_transaction_id unchanged
 *
 * THE INNER GUARD HOLDS, AND IT HOLDS ON THE MONEY RATHER THAN ONLY ON THE STATUS.
 * `returnDeposit` credits the wallet a few lines ABOVE that UPDATE, so the throw is
 * what rolls the credit back — which is why the balance is the assertion that
 * matters, and why a check of the status alone would not have shown it.
 *
 * WHY THIS IS RECORDED RATHER THAN ASSERTED. A spec pinning
 * `deposit_already_returned` through this route would have to keep the ablation in
 * place to pass, so it would be a spec for code that does not ship. The four specs
 * below pin the behaviour a client actually meets; this note records that the layer
 * underneath them was tested too, by a method that can be repeated. The guard's own
 * comment says the earlier ablation left the suite green across 14 files and 516
 * passing specs because nothing had ever called `DELETE /bookings/{id}` — that hole
 * is closed by the specs below, and this note closes the one after it.
 *
 * `cancelled -> cancelled` is why both layers exist at all:
 * `booking_completed_at_matches_status` and its siblings refuse
 * `completed -> cancelled` and `no_show_returned -> cancelled`, but
 * `cancelled -> cancelled` is SELF-CONSISTENT, so every CHECK passes and a second
 * refund commits. The two transitions the schema does cover are exactly the two
 * that made this path look adequate.
 */
describe('DELETE /bookings/{id} returns the deposit, and only the first one does', () => {
  /**
   * THE CONTROL, AND IT IS LOAD-BEARING RATHER THAN POLITE.
   *
   * Every refusal below asserts a 409 and an unmoved balance. An endpoint that
   * was broken shut — 404 on every id, or a cancel that refunded nothing —
   * satisfies all of them and would leave this block green while proving the
   * opposite of what it claims. So the first spec establishes that a cancel
   * really does move the money, and the refusals are then about the SECOND one.
   *
   * NO CLOCK IS MOVED HERE. A cancel is legal until an hour before the
   * appointment, so a booking nine days out is cancellable exactly as created;
   * the grace-window mechanics the rest of this file needs are about applying a
   * hold to a charge, not about holding it. The deposit is debited by
   * `POST /bookings` whatever the date.
   */
  it('gives the whole deposit back, once, and closes the hold in the ledger', async () => {
    const balanceBefore = balanceOf(MEMBER);
    const heldBefore = depositHeldFor(MEMBER);
    const returnsBefore = depositReturnsFor(MEMBER);

    const { id, depositFils } = await bookFuture(MANICURE, FOURTH_ARTIST);

    // The deposit really left her wallet — otherwise "it came back" is vacuous.
    expect(depositFils, 'the booking held no deposit, so there is nothing to return').toBe(
      DEPOSIT_FILS,
    );
    expect(balanceOf(MEMBER), 'POST /bookings did not debit the deposit').toBe(
      balanceBefore - DEPOSIT_FILS,
    );
    expect(depositHeldFor(MEMBER), 'the deposit_held position did not move').toBe(
      heldBefore + DEPOSIT_FILS,
    );

    const res = await cancel(id);

    expect(res.status, `DELETE /bookings/${id} answered ${res.status}: ${res.raw}`).toBe(200);
    expect(res.body.refundedFils, 'the refund was not the deposit').toBe(DEPOSIT_FILS);
    // Integer fils on the wire, non-negotiable #1 — never 5 or "5.000".
    expect(Number.isInteger(res.body.refundedFils)).toBe(true);
    expect(res.body.balanceAfterFils).toBe(balanceBefore);
    expect(res.body.transactionId).toMatch(/^TX-/);
    expect(res.body.booking.status).toBe('cancelled');

    // The money, out of the database rather than out of the reply.
    expect(balanceOf(MEMBER), 'the deposit did not come back in full').toBe(balanceBefore);
    expect(bookingStatus(id)).toBe('cancelled');
    // The liability is discharged, not merely marked: the position is back where
    // it started, which a status column alone cannot tell you.
    expect(depositHeldFor(MEMBER), 'the deposit_held position was left open').toBe(heldBefore);
    expect(depositReturnsFor(MEMBER)).toBe(returnsBefore + 1);
    expect(returnsForBooking(id), 'one cancel wrote more than one deposit_return').toBe(1);
  }, 120_000);

  /**
   * THE SECOND CANCEL. The spec the removed guard would have failed.
   *
   * Phrased as "the system refused", not as "nothing changed". A cancel that
   * 404'd, or one that returned 200 having quietly done nothing, satisfies an
   * unmoved balance just as well as a correct refusal does — and one of those is
   * a bug. So the error CODE is asserted before the money is.
   */
  it('a second cancel is REFUSED by name, and the deposit does not come back twice', async () => {
    const { id } = await bookFuture(MANICURE, FOURTH_ARTIST);
    const first = await cancel(id);
    precondition(first.status === 200, `the first cancel did not succeed: ${first.raw}`);

    const settledBalance = balanceOf(MEMBER);
    const settledTx = scalar(`select settled_transaction_id from booking where id='${id}'`);

    const second = await cancel(id);

    expect(second.status, `a second cancel answered ${second.status}: ${second.raw}`).toBe(409);
    expect(
      second.body.error,
      'the refusal did not name the state it refused on',
    ).toBe('already_cancelled');

    expect(
      balanceOf(MEMBER),
      'a second cancel refunded the deposit again — she has been paid twice for one appointment',
    ).toBe(settledBalance);
    expect(returnsForBooking(id), 'a second deposit_return was written').toBe(1);
    // And the first refund was not re-stamped onto a new transaction underneath
    // her, which is what an unconditional write would do while the status stayed
    // `cancelled` and every CHECK stayed satisfied.
    expect(
      scalar(`select settled_transaction_id from booking where id='${id}'`),
      'the settled transaction was replaced by a second one',
    ).toBe(settledTx);
  }, 120_000);

  /**
   * TWO CANCELS AT ONCE — the construction that actually reaches the re-check.
   *
   * The same shape as the two no-show passes above, and for the same reason. The
   * sequential spec before this one is answered by the second request reading a
   * status that was already `cancelled` before it began; the guard exists for the
   * window between one request's unlocked probe and its lock, which only a
   * genuine overlap can occupy. `Promise.all` on two `DELETE`s gives two
   * concurrent transactions, and the loser blocks on the member row.
   *
   * A customer double-tapping Cancel on a slow connection is this exact race, so
   * it is not a synthetic one.
   */
  it('two cancels firing AT ONCE refund exactly once, and one of them says why', async () => {
    const { id } = await bookFuture(MANICURE, FOURTH_ARTIST);
    const balanceBefore = balanceOf(MEMBER);
    precondition(
      bookingStatus(id) === 'deposit_held',
      'the booking was not held before the race',
    );

    const [a, b] = await Promise.all([cancel(id), cancel(id)]);

    const codes = [a.status, b.status].sort();
    expect(
      codes,
      `two simultaneous cancels answered ${JSON.stringify(codes)}: ${a.raw} / ${b.raw}`,
    ).toEqual([200, 409]);

    const loser = a.status === 409 ? a : b;
    expect(loser.body.error, 'the loser did not say why it refused').toBe('already_cancelled');

    /**
     * EXACTLY ONE REFUND, asserted on the money. Either request may legitimately
     * be the winner, so the counts are not the thing to pin — the balance is.
     */
    expect(
      balanceOf(MEMBER),
      `two racing cancels moved her balance by ${balanceOf(MEMBER) - balanceBefore} fils, ` +
        `where one deposit is ${DEPOSIT_FILS}. One appointment was refunded twice.`,
    ).toBe(balanceBefore + DEPOSIT_FILS);

    expect(returnsForBooking(id), 'two deposit_return rows exist for one deposit').toBe(1);
    expect(bookingStatus(id)).toBe('cancelled');
  }, 120_000);

  /**
   * THE CROSS-PATH CASE, and the one with the clearest customer story: the
   * no-show job has already given the deposit back, and she then opens the app
   * and taps Cancel on an appointment that still looks live to her.
   *
   * Both routes call `returnDeposit`. Only the status re-check stands between
   * them, so this is the same guard as the two specs above reached from the other
   * side — a return the job performed being refused to the endpoint.
   */
  it('cannot cancel a booking the no-show job already returned — the same deposit, two routes', async () => {
    /**
     * AND HERE THE SCHEMA IS A REAL SECOND LAYER — measured, not assumed.
     *
     * With the status re-check removed, this spec and the completed-booking one
     * below both fail with a 500 rather than with a double refund. `returnDeposit`
     * writes `status='cancelled'` and stamps `cancelled_at` while `returned_at`
     * (or `completed_at`) is still set, and `booking_returned_at_matches_status` —
     * `(status='no_show_returned') = (returned_at IS NOT NULL)` — refuses the row.
     * The transaction rolls back and the money survives on a consistency
     * constraint that was written for a different purpose.
     *
     * `cancelled` → `cancelled` HAS NO SUCH PROTECTION. It is self-consistent, so
     * every CHECK on the table is satisfied and the second refund COMMITS: the two
     * specs above are the ones that show real money moving twice.
     *
     * That is the asymmetry, and it is the reason these four specs are not
     * interchangeable. The schema catches a double return that CHANGES the
     * terminal state and is blind to one that repeats it — so the two cases the
     * schema covers are exactly the two that would have made this block look
     * adequate while the uncovered case stayed uncovered.
     */
    const { id } = await bookFuture(MANICURE, FOURTH_ARTIST);
    parkOtherLiveHolds(id);
    makeDue(id);

    const tick = runNoShowJob();
    precondition(tick.returned >= 1, `the job returned nothing: ${JSON.stringify(tick)}`);
    precondition(
      bookingStatus(id) === 'no_show_returned',
      `the job did not settle this booking: it is ${bookingStatus(id)}`,
    );

    const afterJob = balanceOf(MEMBER);

    const res = await cancel(id);

    expect(res.status, `cancelling a returned booking answered ${res.status}: ${res.raw}`).toBe(
      409,
    );
    // `not_cancellable`, and the message is the one written for this state — she
    // is told the deposit is already back, not that the appointment is missing.
    expect(res.body.error).toBe('not_cancellable');
    expect(res.body.message).toMatch(/already been returned/i);

    expect(
      balanceOf(MEMBER),
      'the deposit was returned by the job AND by the cancel — refunded twice for one no-show',
    ).toBe(afterJob);
    expect(returnsForBooking(id), 'a second deposit_return was written').toBe(1);
    expect(bookingStatus(id)).toBe('no_show_returned');
  }, 180_000);

  /**
   * AND THE OTHER TERMINAL STATE: she attended, the charge consumed the deposit,
   * and a cancel afterwards would hand back money the salon has already earned.
   *
   * This one needs the grace window, because it needs a real charge to consume a
   * real hold — hence the fourth artist's diary.
   *
   * THEN IT MOVES THE CLOCK BACK OUT AGAIN, and that is the point of the spec
   * rather than housekeeping. A booking sitting four minutes from its start is
   * inside the one-hour change window, so `assertChangeWindowOpen` refuses a
   * cancel on its own — and it runs AFTER the status check, which means a spec
   * left in that state passes whether the status check exists or not. It would
   * have been an assertion satisfied by the guard next door.
   *
   * Pushing `starts_at` back out re-opens the change window, so the status check
   * is the only thing between a completed appointment and a refund of a deposit
   * the salon has already earned. No money column is touched — same rule as the
   * rest of this file.
   */
  it('cannot cancel a COMPLETED booking, whose deposit the charge already spent', async () => {
    const { id } = await bookFuture(BLOW_DRY, FOURTH_ARTIST);
    moveInsideWindow(id);

    const charge = await chargeFor([BLOW_DRY]);
    precondition(charge.status === 200, `the charge did not settle: ${charge.raw}`);
    precondition(
      bookingStatus(id) === 'completed',
      `the charge did not complete the booking: it is ${bookingStatus(id)}`,
    );
    // The hold really was applied — otherwise this is a spec about an unrelated
    // booking that happens to be `completed`.
    expect(
      charge.body.depositAppliedFils,
      'the charge consumed no deposit, so there is nothing for a cancel to claw back',
    ).toBe(DEPOSIT_FILS);

    // Re-open the change window, so the refusal below can only come from the
    // status. See this spec's header.
    psql(`
      UPDATE booking
         SET starts_at = now() + interval '9 days',
             ends_at   = now() + interval '9 days' + interval '60 minutes'
       WHERE id = '${id}';
    `);

    const afterCharge = balanceOf(MEMBER);
    const returnsAfterCharge = depositReturnsFor(MEMBER);

    const res = await cancel(id);

    expect(res.status, `cancelling a completed booking answered ${res.status}: ${res.raw}`).toBe(
      409,
    );
    expect(res.body.error).toBe('not_cancellable');
    expect(res.body.message).toMatch(/already happened/i);

    expect(
      balanceOf(MEMBER),
      'a completed appointment was refunded — the salon paid for a visit it delivered',
    ).toBe(afterCharge);
    expect(
      depositReturnsFor(MEMBER),
      'a deposit_return was written for a booking whose deposit the charge had already spent',
    ).toBe(returnsAfterCharge);
    expect(returnsForBooking(id), 'the completed booking acquired a deposit_return').toBe(0);
    expect(bookingStatus(id)).toBe('completed');
  }, 180_000);
});
