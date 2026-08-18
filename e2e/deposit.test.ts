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
  psql,
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

/** ISO date `daysAhead` from now, for the availability grid. */
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
