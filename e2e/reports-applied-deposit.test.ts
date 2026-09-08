/**
 * THE SHAPE THE REPORTS SUITE DID NOT HOLD — a charge that consumed a deposit.
 *
 * HOW TO RUN
 *
 *   pnpm install
 *   pnpm --dir ./api run db:up
 *   cd e2e && ../node_modules/.bin/vitest run reports-applied-deposit.test.ts
 *
 * =========================================================================
 * WHY THIS FILE EXISTS, AND WHY IT IS NOT "A TEST FOR TWO BUGS"
 * =========================================================================
 * DECISIONS.md #81 and #83 were two defects in merchant-facing money reports
 * that lived their whole lives with a green suite over them:
 *
 *   #81  `sales` and `best-selling-services` summed `-amount_fils` under a
 *        column labelled `gross`. `services/charge.ts` § 4 writes
 *        `amount_fils = -(gross - applied)`, so every booked appointment was
 *        understated by its applied deposit. A 6.000 service against a 5.000
 *        deposit reported 1.000; one the deposit covered outright reported
 *        0.000. Measured on a driven window: 34.6% of takings missing.
 *   #83  `best-selling-services` scored a `no_show_returned` booking NEGATIVE,
 *        because such a booking DOES carry a `settled_transaction_id` — pointing
 *        at the deposit RETURN, whose `amount_fils` is positive.
 *
 * Both are fixed, and `api/src/services/reportsReconciliation.int.test.ts` is
 * lane A's spec for the fix. This file is not a third copy of that. It exists
 * because of WHY neither defect was caught, which is a lane D problem:
 *
 *   1. `api/src/db/seed.ts` contains NO booked appointment at all. The #81 fix
 *      changes nothing on it — 8.000 before, 8.000 after — so a correct
 *      implementation and a broken one produce identical output on the standard
 *      fixture.
 *   2. `e2e/reports.test.ts` writes no `ledger_entry` rows. Its fixture holds a
 *      `deposit_hold` and a `deposit_return` but has never held an APPLIED
 *      deposit on a charge, so its hand-summed `GROSS_7D`/`GROSS_30D` were
 *      unaffected by either defect. They agreed with the wrong implementation
 *      and would have agreed with the right one.
 *
 * The missing thing was never an assertion. It was a FIXTURE THAT CONTAINS THE
 * SHAPE — a charge where the two candidate definitions of revenue give different
 * answers. Without such a row, no assertion over that report can distinguish the
 * two, and no oracle can either, however it is derived. That is the whole lesson
 * and it is why the first spec below asserts the fixture DISCRIMINATES before
 * any spec asserts a figure.
 *
 * =========================================================================
 * THE FIXTURE IS DRIVEN, NOT WRITTEN
 * =========================================================================
 * Every row this file measures is produced by the real endpoints:
 * `POST /bookings` takes the real deposit and writes the real `deposit_held`
 * ledger pair, `POST /charges` applies it and writes the real
 * `depositAppliedPosting` legs, and the no-show is produced by running
 * `api/src/jobs/no-show-once.ts` the way an operator runs it.
 *
 * THAT IS A DELIBERATE DEPARTURE FROM `reports.test.ts`, WHICH HAND-WRITES ITS
 * TRANSACTIONS, and the reason is worth stating because the two files now look
 * inconsistent. That file's whole method is explicit clocks: it needs a charge
 * at exactly `D5 21:30Z` to separate Kuwait-day grouping from UTC and from the
 * host zone, and a real `POST /charges` cannot be made to happen at a chosen
 * instant. Hand-written rows are the only way to ask its questions.
 *
 * They are the wrong way to ask THIS one. An applied deposit is not one row, it
 * is a `transaction` whose `amount_fils` is net, a `booking` in `completed`
 * naming it, and a balanced pair of `ledger_entry` legs on the `deposit_held`
 * account — the third of which is what `transaction_revenue` actually reads.
 * Hand-writing that means hand-writing the very arithmetic under test, and the
 * fixture would then be a second implementation of the thing it is checking.
 * Driving it means the shape is correct because the product produced it.
 *
 * It also closes a fixture-honesty problem that is live in this repository right
 * now: lane A reported that `db:verify` invariant 5
 * (`member.balance_fils = sum(member_wallet legs)`) fails after any lane A int
 * run, because those fixtures hand-write wallet legs with no funding chain
 * behind them. § THE INVARIANT at the bottom asserts that invariant in full on
 * this file's member — and it took two attempts, which is recorded there rather
 * than tidied away, because the first attempt wrote the opening balance INTO the
 * assertion and thereby re-stated the fixture's own arithmetic back at itself.
 * That is this slice's own lesson arriving on its author.
 *
 * WHAT IS STILL SQL HERE, AND IT IS ONLY EVER A CLOCK, A CATALOGUE, OR AN
 * OPENING BALANCE WITH ITS OWN LEDGER ENTRY:
 *   - three `service` rows, so every `best-selling-services` row below belongs
 *     to this file and no other. Nothing about a service's price is under test.
 *   - the member row, cloned the way `deposit.test.ts` clones hers, and — unlike
 *     every other fixture member in this directory — with her opening balance
 *     posted as a real `adjustment` plus a balanced `member_wallet`/
 *     `gateway_clearing` pair. `api/src/db/seed.ts` § "the opening balances"
 *     settled that this is what an opening balance is; the convention here had
 *     not caught up. It is the ONLY `ledger_entry` row this file writes.
 *   - the three CLOCK columns on a booking, moved so the appointment sits inside
 *     the no-show grace window AND in the past. NO MONEY COLUMN IS EVER TOUCHED
 *     after the API has written it.
 *
 * =========================================================================
 * WHY THE APPOINTMENT IS IN THE PAST, WHICH `deposit.test.ts` DOES NOT NEED
 * =========================================================================
 * `deposit.test.ts` parks its bookings a few minutes in the FUTURE — inside the
 * grace window is all it needs. `best-selling-services` windows on
 * `bk.starts_at >= from AND bk.starts_at < now`, so a booking starting four
 * minutes from now is not in any report. The hold applies while
 *
 *     starts_at <= now + noShowReturnMinutes    AND    no_show_return_due_at > now
 *
 * and the first term is satisfied by any past instant, so a slot that has
 * already started and is still inside its grace period is BOTH holdable and
 * reportable. That intersection is the only clock this file can use, and getting
 * it wrong reads as "the report lost my appointment" rather than as a clock.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { precondition } from './support/known-bug.js';
import {
  A_BRANCH,
  A_STAFF_FULL,
  SALON_A,
  pgDb,
  psql,
  runApiDbScriptResult,
  scalar,
  signInDashboard,
  signInMember,
  signInScanner,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

const A_STAFF_HANDLE = 'noura';
const A_SCANNER_DEVICE = 'DEV-SCANNER-01';

/** `salon.deposit_fils`, seeded, CHECKed between 1000 and 10000. */
const DEPOSIT_FILS = 5_000;
/** `salon.no_show_return_minutes`, seeded. */
const GRACE_MINUTES = 60;

/**
 * THREE SERVICES OF THIS FILE'S OWN, and the prices are chosen to straddle the
 * deposit rather than picked for variety.
 *
 * `services/charge.ts` § 4 is `applied = min(gross, held)`, so the deposit's
 * relation to the basket decides which of #81's two cases a row is:
 *
 *   PART  6.000 > 5.000 deposit → applied 5.000, charged 1.000. The headline
 *         case: `-amount_fils` is 1.000 against 6.000 earned. #81's own example.
 *   WHOLE 4.000 < 5.000 deposit → applied 4.000, charged ZERO, and 1.000 handed
 *         straight back as its own `deposit_return`. `-amount_fils` is 0, so the
 *         broken query reported a completed appointment as no revenue at all —
 *         the worse half of #81, and the one a merchant cannot even see is
 *         missing because there is no small number to be suspicious of.
 *   MISS  9.000, never charged. Its booking is no-showed, its deposit returned,
 *         and its `settled_transaction_id` points at that RETURN. #83.
 *
 * The prices are also mutually distinct and distinct from every seeded service,
 * so a row found by name and a row found by figure agree.
 */
const SV_PART = 'SV-QAAD-PART';
const SV_PART_NAME = 'QA deposit part-covers';
const SV_PART_FILS = 6_000;

const SV_WHOLE = 'SV-QAAD-WHOLE';
const SV_WHOLE_NAME = 'QA deposit covers whole';
const SV_WHOLE_FILS = 4_000;

const SV_MISS = 'SV-QAAD-MISS';
const SV_MISS_NAME = 'QA no-show returned';
const SV_MISS_FILS = 9_000;

/** What each charge must apply and charge. Derived from the two prices above. */
const PART_APPLIED = DEPOSIT_FILS; // 5.000, the whole hold; the basket is bigger
const PART_CHARGED = SV_PART_FILS - DEPOSIT_FILS; // 1.000 out of her spendable balance
const WHOLE_APPLIED = SV_WHOLE_FILS; // 4.000, capped at the basket
const WHOLE_CHARGED = 0; // nothing left to debit
const WHOLE_RETURNED = DEPOSIT_FILS - SV_WHOLE_FILS; // 1.000 straight back

/**
 * WHAT THE WINDOW GAINS, AND THIS IS THE ONLY MONEY CONSTANT IN THE FILE THAT IS
 * A SUM RATHER THAN AN INPUT.
 *
 * `sales` gross and `artist-performance` earned must both rise by exactly the two
 * BASKETS — what the salon sold — and not by what came out of her spendable
 * balance. Under the #81 implementation this window is worth
 * `PART_CHARGED + WHOLE_CHARGED` = 1.000, i.e. 90% of it missing.
 *
 * The no-show contributes NOTHING to either: no charge happened. Under #83 it
 * contributed −5.000 to `best-selling-services`, which is asserted separately
 * because that report's revenue column is per service and this one is not.
 */
const EARNED_IN_WINDOW = SV_PART_FILS + SV_WHOLE_FILS; // 10.000
const CHARGED_IN_WINDOW = PART_CHARGED + WHOLE_CHARGED; // 1.000 — the broken figure
const APPLIED_IN_WINDOW = PART_APPLIED + WHOLE_APPLIED; // 9.000 — the missing half

/** One artist per booking: `booking_artist_slot_no_overlap` is per artist. */
const ARTIST_PART = 'AR-001';
const ARTIST_WHOLE = 'AR-002';
const ARTIST_MISS = 'AR-003';

/** This file's member. Nothing else reads or writes her. */
const MEMBER = 'QA-AD-0001';
const MEMBER_PHONE = '+96599777801';
const MEMBER_OPENING_FILS = 200_000;

let web = '';
let member = '';
let scanner = '';
let n = 0;
const key = (label: string) => `rptdep-${label}-${Date.now()}-${n++}`;

interface Driven {
  bookingId: string;
  transactionId: string;
  appliedFils: number;
  chargedFils: number;
  returnedFils: number;
}

let part: Driven;
let whole: Driven;
/** The no-show: no charge, so only a booking and the `deposit_return` that settled it. */
let miss: { bookingId: string; returnTransactionId: string; returnedFils: number };

/** The three reports, before this file drove anything into the window. */
const before = { sales: -1, earned: -1 };

// ------------------------------------------------------------------ helpers --

const report = (kind: string, q = '?period=7d') =>
  treq<any>('GET', `/salons/${SALON_A}/reports/${kind}${q}`, { token: web });

const balanceOf = (id: string): number =>
  Number(scalar(`select balance_fils from member where id='${id}'`));

const bookingStatus = (id: string): string =>
  scalar(`select status from booking where id='${id}'`).trim();

/**
 * WHAT THE SALON EARNED ON ONE TRANSACTION, OUT OF THE OTHER SIDE OF THE LEDGER.
 *
 * THIS IS THE ORACLE, AND ITS INDEPENDENCE IS THE ENTIRE POINT — so what makes it
 * independent is worth spelling out rather than asserting.
 *
 * `transaction_revenue` (migration 0042) computes earned revenue as
 * `-transaction.amount_fils` plus the `deposit_held` DEBIT legs. This function
 * computes it from the `salon_revenue` legs instead: credits minus debits. Those
 * are DIFFERENT ROWS reached by a DIFFERENT PATH, and they agree only because
 * `depositAppliedPosting` and `walletSpendPosting` each credit `salon_revenue`
 * for their own half and `ledger_entry_balanced` refuses a commit where the two
 * sides of a transaction do not match. So this is double entry read from the
 * credit side, checked against a view that reads the debit side.
 *
 * It is credits MINUS debits and not a sum of `amount_fils`: that column is
 * CHECKed positive and the sign lives in `direction`, so summing it gives
 * turnover rather than position — the mistake `deposit.test.ts`'s
 * `depositHeldFor` records making. On a charge the debit side of this account is
 * empty; on a VOID it is not (`chargeReversedPosting` DEBITS `salon_revenue`),
 * and getting that direction right is what makes this function usable for a
 * period rather than only for a single un-voided charge.
 *
 * WHAT IT IS NOT: a re-run of the endpoint's own query. Nothing here reads
 * `transaction.amount_fils`, `transaction_revenue`, or the `deposit_held`
 * account. A wrong oracle is worse than a wrong constant, so this one is
 * cross-checked against hand constants that are this file's own INPUTS — the
 * prices it set and the deposit the salon seeds — and not against sums over rows
 * it read back. See § THE RULING, at the foot of this file.
 */
function salonRevenueFor(transactionIds: string[]): number {
  const list = transactionIds.map((i) => `'${i}'`).join(',');
  return Number(
    scalar(
      `select coalesce(sum(case when direction = 'credit' then amount_fils
                                else -amount_fils end), 0)
         from ledger_entry
        where account = 'salon_revenue' and transaction_id in (${list})`,
    ),
  );
}

/** ISO date `daysAhead` from now — only ever fed to the availability grid. */
const isoDate = (daysAhead: number): string =>
  new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);

/**
 * A real booking through the real endpoint, on a future date the artist works.
 *
 * Walks the grid forward rather than taking a fixed offset: every artist's week
 * is closed one day, and a fixed offset lands on it once every seven runs and
 * turns this file red for a reason that has nothing to do with reports. The same
 * reasoning as `deposit.test.ts` § bookFuture, and the same fortnight of room.
 */
async function bookFuture(serviceId: string, artistId: string): Promise<string> {
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
  if (res.body.booking.depositFils !== DEPOSIT_FILS) {
    throw new Error(
      `the booking took ${res.body.booking.depositFils} rather than the seeded ${DEPOSIT_FILS}. ` +
        'Every figure in this file is derived from that deposit, so it stops here rather than ' +
        'measuring an arithmetic nobody chose.',
    );
  }
  return res.body.booking.id;
}

/**
 * Move a booking's three CLOCK columns into the PAST and still inside the grace
 * window — the intersection the file header explains.
 *
 * `minutesAgo` is a distinct, never-reused offset per booking because the diary
 * is a database constraint: `booking_artist_slot_no_overlap` is a GiST EXCLUDE
 * over `(artist_id, [starts_at, ends_at))` covering held AND completed rows, so
 * even a settled appointment keeps its slot. Distinct artists make the offsets
 * independent anyway; they are staggered as well so that a future spec adding a
 * fourth booking on an artist already used does not have to rediscover this.
 *
 * NO MONEY COLUMN IS TOUCHED. `deposit_fils`, the member's balance and every
 * ledger row are exactly what the API wrote.
 */
function placeInPastInsideWindow(bookingId: string, minutesAgo: number): void {
  psql(`
    UPDATE booking
       SET starts_at             = now() - interval '${minutesAgo} minutes',
           ends_at               = now() - interval '${minutesAgo - 8} minutes',
           no_show_return_due_at = now() + interval '${GRACE_MINUTES - minutesAgo} minutes'
     WHERE id = '${bookingId}';
  `);
  precondition(
    scalar(`select (starts_at < now())::text from booking where id='${bookingId}'`).trim() ===
      'true',
    `${bookingId} was not moved into the past, so best-selling-services will not see it and ` +
      'every revenue assertion in this file would pass on an empty row set',
  );
  precondition(
    scalar(
      `select (no_show_return_due_at > now())::text from booking where id='${bookingId}'`,
    ).trim() === 'true',
    `${bookingId} is past its grace window, so findApplicableHold will not apply its deposit ` +
      'and the charge below would be a walk-in — which is exactly the shape this file exists ' +
      'to stop being the only shape tested',
  );
}

/** A live wallet token of hers, minted the way the scanner suite mints one. */
async function mintToken(): Promise<string> {
  const res = await treq<any>('GET', '/members/me/wallet-token', { token: member });
  precondition(res.status === 200 && Boolean(res.body.token), `wallet-token: ${res.raw}`);
  precondition(res.body.memberId === MEMBER, `token minted for ${res.body.memberId}, not ${MEMBER}`);
  return res.body.token;
}

/**
 * A real charge for one service, and the deposit it consumed.
 *
 * `confirmDuplicate: true` for the reason `deposit.test.ts` records: lane A's
 * near-duplicate guard runs INSIDE the charge transaction and BEFORE the balance
 * check, so a second charge to one member inside two minutes is refused as a
 * duplicate before any deposit arithmetic happens. The two charges here are two
 * different baskets, so the guard would not fire on `basket_hash` — the flag is
 * belt and braces, and it keeps a `409` from ever being mistaken for a report
 * failure three specs later.
 */
async function chargeOne(serviceId: string, bookingId: string): Promise<Driven> {
  const res = await treq<any>('POST', '/charges', {
    token: scanner,
    idempotencyKey: key('charge'),
    body: { memberId: MEMBER, token: await mintToken(), serviceIds: [serviceId], confirmDuplicate: true },
  });
  if (res.status !== 200) throw new Error(`POST /charges for ${serviceId}: ${res.status} ${res.raw}`);
  if (res.body.bookingId !== bookingId) {
    throw new Error(
      `the charge applied booking ${res.body.bookingId}, not ${bookingId}. findApplicableHold ` +
        'takes her EARLIEST live hold, so this file has left one behind and is measuring the ' +
        "wrong appointment's deposit.",
    );
  }
  return {
    bookingId,
    transactionId: res.body.transaction.id,
    appliedFils: res.body.depositAppliedFils,
    /**
     * `+ 0` IS NOT NOISE AND IT IS NOT SUPERSTITION. `WHOLE`'s charge row carries
     * `amount_fils = 0` — the deposit covered the basket outright — and negating
     * zero in JavaScript gives `-0`, which `expect(...).toBe(0)` REFUSES, because
     * `toBe` is `Object.is` and `Object.is(-0, 0)` is false. Adding zero
     * normalises the sign without touching any other value.
     *
     * Worth the four lines because it is a trap specific to exactly the case #81
     * was worst on: the only charge whose sign flip produces `-0` is one that
     * debited nothing, so the assertion that fails is the assertion about the
     * zero-charge appointment, and it fails reading `expected -0 to be +0` —
     * which looks like a floating-point problem in a codebase where non-negotiable
     * #1 says there are none.
     */
    chargedFils: -res.body.transaction.amountFils + 0,
    returnedFils: res.body.depositReturnedFils,
  };
}

/**
 * ONE PASS OF THE NO-SHOW RETURN JOB, driven the way an operator drives it —
 * `deposit.test.ts` § runNoShowJob, and for the same reason: the terminal state
 * `no_show_returned` is reachable no other way without waiting on a timer, and a
 * hand-written `UPDATE booking SET status='no_show_returned'` would be this file
 * asserting against its own idea of what the job does.
 */
function runNoShowJob(): { returned: number; returnedFils: number } {
  const res = runApiDbScriptResult('src/jobs/no-show-once.ts', pgDb());
  if (!res.ok) {
    throw new Error(
      `the no-show job failed to run at all.\n--- stdout ---\n${res.stdout}\n` +
        `--- stderr ---\n${res.stderr}`,
    );
  }
  const start = res.stdout.indexOf('{');
  if (start < 0) throw new Error(`the job printed no JSON:\n${res.stdout}`);
  return JSON.parse(res.stdout.slice(start));
}

// -------------------------------------------------------------------- setup --

beforeAll(async () => {
  await startTenancyApi();

  precondition(
    scalar(
      `select perm_dashboard::text || perm_appointments::text || perm_team::text
         from staff_user where id='${A_STAFF_FULL}'`,
    ).trim() === 'truetruetrue',
    `${A_STAFF_FULL} does not hold dashboard, appointments and team, so the three reports this ` +
      'file measures would answer 403 and nothing below would measure the data',
  );

  psql(`
    INSERT INTO service (id, salon_id, name, price_fils, active)
    VALUES ('${SV_PART}',  '${SALON_A}', '${SV_PART_NAME}',  ${SV_PART_FILS},  true),
           ('${SV_WHOLE}', '${SALON_A}', '${SV_WHOLE_NAME}', ${SV_WHOLE_FILS}, true),
           ('${SV_MISS}',  '${SALON_A}', '${SV_MISS_NAME}',  ${SV_MISS_FILS},  true)
    ON CONFLICT (id) DO UPDATE SET name = excluded.name,
                                   price_fils = excluded.price_fils,
                                   active = true;
    INSERT INTO member (id, salon_id, name, phone, email, email_verified, password_hash,
                        balance_fils, visits, tier, stamps, policy_version)
    SELECT '${MEMBER}', '${SALON_A}', 'Applied Deposit QA', '${MEMBER_PHONE}', NULL, false,
           s.password_hash, ${MEMBER_OPENING_FILS}, 0, 'bronze', NULL, 3
      FROM staff_user s WHERE s.id = '${A_STAFF_FULL}'
    ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash,
                                   balance_fils  = ${MEMBER_OPENING_FILS},
                                   visits        = 0,
                                   tier          = 'bronze',
                                   stamps        = NULL;
  `);

  /**
   * HER OPENING BALANCE GETS AN ENTRY OF ITS OWN, and this is the one place this
   * file writes a `ledger_entry` row by hand.
   *
   * IT IS NOT AN EXCEPTION TO THE FILE HEADER, IT IS THE REASON FOR IT. An
   * INSERTed `balance_fils` with nothing saying where it came from breaks
   * `db:verify` invariant 5 — `member.balance_fils = sum(member_wallet legs)` —
   * by exactly the opening balance, before anybody touches anything. That is the
   * defect lane A reported in the `api` int fixtures, and it is the standing
   * convention in this directory too: every file here that clones a member with a
   * balance owes the ledger that balance. A fixture that owes the ledger money is
   * a fixture whose money answers cannot be reconciled, which is the family of
   * problem DECISIONS.md #81 came out of.
   *
   * SO IT FOLLOWS THE SEED'S OWN PRECEDENT RATHER THAN INVENTING ONE.
   * `api/src/db/seed.ts` § "the opening balances" hit this first and settled it:
   * an opening fixture balance is a REAL CREDIT and gets a real pair —
   * `walletAdjustedPosting`, `member_wallet` CREDIT against `gateway_clearing`
   * DEBIT, on an `adjustment` transaction.
   *
   *   `adjustment` AND NOT `topup`, for the seed's reason: `transaction.kind` is
   *   what the merchant reports filter on, and a seeded `topup` would inflate a
   *   salon's top-up volume — and its commission — with money that was never
   *   collected from anyone. An `adjustment` reversing nothing is counted by no
   *   tile and no report (which `reports.test.ts` finding 2 records as a gap in
   *   its own right), so it cannot disturb a single figure this file asserts.
   *
   *   `gateway_clearing` AS THE COUNTERPART because double entry needs a source
   *   and the story is that she loaded her wallet before this dataset begins —
   *   the same pair a settled top-up posts.
   *
   * GUARDED ON PRESENCE, because `ledger_entry` is append-only by trigger: a
   * second copy could never be cleaned up, and the table has no natural key to
   * conflict on. A run mints its own database so this cannot normally fire twice,
   * but `POSTGRES_DB` is a documented opt-out onto a long-lived one.
   */
  const OPENING_TX = 'TX-QAAD-OPEN';
  if (scalar(`select count(*) from "transaction" where id='${OPENING_TX}'`).trim() === '0') {
    psql(`
      INSERT INTO "transaction"
        (id, member_id, salon_id, branch_id, kind, amount_fils, status, reference, note,
         created_at, settled_at)
      VALUES ('${OPENING_TX}', '${MEMBER}', '${SALON_A}', '${A_BRANCH}', 'adjustment',
              ${MEMBER_OPENING_FILS}, 'settled', 'AVO-OPEN-${MEMBER}', 'Opening fixture balance',
              now(), now());
      INSERT INTO ledger_entry
        (transaction_id, salon_id, member_id, account, direction, amount_fils, balance_after_fils)
      VALUES ('${OPENING_TX}', '${SALON_A}', '${MEMBER}', 'member_wallet', 'credit',
              ${MEMBER_OPENING_FILS}, ${MEMBER_OPENING_FILS}),
             ('${OPENING_TX}', '${SALON_A}', NULL, 'gateway_clearing', 'debit',
              ${MEMBER_OPENING_FILS}, NULL);
    `);
  }

  web = await signInDashboard(SALON_A, A_STAFF_HANDLE);
  member = await signInMember(SALON_A, MEMBER_PHONE);
  scanner = await signInScanner(SALON_A, A_STAFF_HANDLE, A_SCANNER_DEVICE);

  /**
   * THE BASELINE, TAKEN BEFORE ANYTHING IS DRIVEN.
   *
   * `sales` and `artist-performance` are salon-wide figures and this suite runs
   * its files in one database (`fileParallelism: false`, one minted database per
   * RUN — support/global-setup.ts), so whatever ran before this file is in them.
   * A delta is therefore the only honest way to state what THIS file's rows are
   * worth, and it is a stronger statement than an absolute figure anyway: it is
   * closed over exactly the transactions driven below and says nothing about the
   * seed, which is the thing that changes underneath a report suite.
   *
   * `best-selling-services` needs no baseline: its rows are per service and this
   * file's three services are its own, so those rows are absolute.
   */
  const salesBefore = await report('sales');
  precondition(salesBefore.status === 200, `sales answered ${salesBefore.status}: ${salesBefore.raw}`);
  before.sales = salesBefore.body.stat.value;

  const earnedBefore = await report('artist-performance');
  precondition(
    earnedBefore.status === 200,
    `artist-performance answered ${earnedBefore.status}: ${earnedBefore.raw}`,
  );
  before.earned = earnedBefore.body.stat.value;

  /**
   * ONE BOOKING AT A TIME, START TO FINISH, and that sequencing is API behaviour
   * rather than tidiness. `findApplicableHold` applies her EARLIEST LIVE hold, so
   * two open holds at once means the second charge spends the first's deposit and
   * the failure reads as an arithmetic error four specs away. Each booking here is
   * driven to a terminal state (`completed`, or `no_show_returned`) before the
   * next one is created, so there is never more than one live hold in existence
   * and `chargeOne`'s bookingId check is a real check rather than a hope.
   */
  const partBooking = await bookFuture(SV_PART, ARTIST_PART);
  placeInPastInsideWindow(partBooking, 30);
  part = await chargeOne(SV_PART, partBooking);

  const wholeBooking = await bookFuture(SV_WHOLE, ARTIST_WHOLE);
  placeInPastInsideWindow(wholeBooking, 24);
  whole = await chargeOne(SV_WHOLE, wholeBooking);

  /**
   * THE NO-SHOW. Placed in the past like the other two so the report window sees
   * it, then its deadline is put behind us so the job treats it as due. She never
   * arrived, so nothing is charged and the deposit goes back.
   */
  const missBooking = await bookFuture(SV_MISS, ARTIST_MISS);
  placeInPastInsideWindow(missBooking, 18);
  psql(`UPDATE booking SET no_show_return_due_at = now() - interval '1 minute'
         WHERE id = '${missBooking}';`);

  const tick = runNoShowJob();
  precondition(
    tick.returned >= 1,
    `the no-show job returned nothing, so there is no no_show_returned booking and every #83 ` +
      `assertion below would pass vacuously: ${JSON.stringify(tick)}`,
  );
  const returnTx = scalar(
    `select settled_transaction_id from booking where id='${missBooking}'`,
  ).trim();
  miss = {
    bookingId: missBooking,
    returnTransactionId: returnTx,
    returnedFils: Number(scalar(`select amount_fils from transaction where id='${returnTx}'`)),
  };
}, 300_000);

afterAll(async () => {
  await stopTenancyApi();
});

// ===========================================================================

describe('THE FIXTURE DISCRIMINATES — asserted before any figure is asserted', () => {
  /**
   * THE SPEC THAT WOULD HAVE FAILED ON THE OLD FIXTURE, AND THE REASON THIS FILE
   * IS NOT JUST TWO MORE ASSERTIONS.
   *
   * `sales` and `best-selling-services` were 34.6% wrong for their whole lives
   * with a green suite over them. Neither the `db:seed` fixture nor
   * `e2e/reports.test.ts`'s hand-written ledger contained a single charge where
   * `-amount_fils` and "what the salon earned" differ, so on both fixtures the
   * broken query and the correct one return the same number, to the fils. Every
   * expected figure in that file was satisfiable by either implementation.
   *
   * That is not a missing assertion, it is a fixture that cannot ask the
   * question — and no oracle style fixes it. A hand constant, a first-principles
   * recomputation and a derived cross-check are all equally green over rows where
   * the two definitions agree.
   *
   * So this spec asserts the PROPERTY THAT MAKES THE REST OF THE FILE MEANINGFUL:
   * this window contains revenue that the two definitions disagree about, and by
   * how much. If a future change removes the applied-deposit fixture — deletes a
   * booking, moves a clock, lets the deposit fall to zero — this goes red FIRST,
   * naming the reason, instead of the file quietly becoming decoration that
   * passes.
   */
  it('this window holds revenue the two definitions disagree about, by 9.000 KD', () => {
    expect(
      part.appliedFils,
      'the part-covered charge applied no deposit, so it is a walk-in and #81 cannot be expressed on it',
    ).toBe(PART_APPLIED);
    expect(
      whole.appliedFils,
      'the deposit did not cover the whole basket, so #81\'s zero-charge case is not in this fixture',
    ).toBe(WHOLE_APPLIED);

    /**
     * The disagreement, stated as the two figures rather than as a boolean: the
     * message a future reader needs is HOW MUCH the definitions differ by, because
     * a fixture that discriminates by 1 fils is technically discriminating and
     * practically decoration.
     */
    expect(
      part.chargedFils + whole.chargedFils,
      'the wallet movements are not the net figure #81 reported, so this fixture is not the shape',
    ).toBe(CHARGED_IN_WINDOW);
    expect(
      part.appliedFils + whole.appliedFils,
      'nothing in this window was paid for out of a held deposit',
    ).toBe(APPLIED_IN_WINDOW);
    /**
     * AND THE DISAGREEMENT IS IN THE DATABASE, not only in the two charge replies
     * above. Read out of `transaction_revenue` itself: `charged_fils` is the
     * definition that shipped and `earned_fils` is the one that is right, and the
     * spec is that they DIFFER on these rows. Asserting
     * `APPLIED_IN_WINDOW > 0` here instead would be a constant compared against
     * zero — a sentence about this file's own arithmetic that no change to the
     * product could ever falsify, which is the definition of decoration.
     */
    const fromView = (column: 'charged_fils' | 'earned_fils'): number =>
      Number(
        scalar(
          `select sum(${column}) from transaction_revenue
            where transaction_id in ('${part.transactionId}', '${whole.transactionId}')`,
        ),
      );
    const charged = fromView('charged_fils');
    const earned = fromView('earned_fils');
    expect(charged, 'the view disagrees with the charge replies about what was debited').toBe(
      CHARGED_IN_WINDOW,
    );
    expect(
      earned - charged,
      'the two definitions of revenue agree on every row here, so no assertion in this file can ' +
        'tell a correct aggregate from the one that shipped. The fixture has stopped holding the ' +
        'shape and every spec below is now decoration.',
    ).toBe(APPLIED_IN_WINDOW);
  });

  it('and it holds a no-show whose settling transaction is a positive deposit RETURN', () => {
    /**
     * #83's whole mechanism in three assertions. The claim the old comment made —
     * a no-show "falls out naturally as zero because nothing settled" — is false,
     * and this is where the fixture proves it is false: the booking DOES name a
     * settling transaction, `booking_settlement_matches_status` guarantees it, and
     * that transaction's `amount_fils` is POSITIVE, which is what turned
     * `sum(-amount_fils)` negative.
     */
    expect(bookingStatus(miss.bookingId)).toBe('no_show_returned');
    expect(
      miss.returnTransactionId,
      'the no-showed booking has no settling transaction, so #83 cannot be expressed on it',
    ).not.toBe('');
    expect(scalar(`select kind from transaction where id='${miss.returnTransactionId}'`).trim()).toBe(
      'deposit_return',
    );
    expect(
      miss.returnedFils,
      'the settling transaction is not a POSITIVE credit — a positive amount_fils under a ' +
        'sum(-amount_fils) is the whole of #83',
    ).toBe(DEPOSIT_FILS);
  });
});

// ===========================================================================

describe('sales gross is the whole visit — DECISIONS.md #81', () => {
  it('the window rose by the two BASKETS, not by what left her spendable balance', async () => {
    const res = await report('sales');
    precondition(res.status === 200, `sales answered ${res.status}: ${res.raw}`);

    const delta = res.body.stat.value - before.sales;
    expect(
      delta,
      `sales gross rose by ${delta} over two appointments worth ${EARNED_IN_WINDOW}. ` +
        `${CHARGED_IN_WINDOW} is the figure the shipped implementation produced — ` +
        `sum(-amount_fils), the WALLET movement — which understates this window by ` +
        `${APPLIED_IN_WINDOW} fils, ${Math.round((APPLIED_IN_WINDOW / EARNED_IN_WINDOW) * 100)}% ` +
        'of it. See DECISIONS.md #81.',
    ).toBe(EARNED_IN_WINDOW);
  }, 60_000);

  it('and the ledger agrees, read from the OTHER side of the double entry', () => {
    /**
     * THE DERIVED ORACLE. `salonRevenueFor` sums the `salon_revenue` legs; the
     * report reads `-amount_fils` plus the `deposit_held` DEBIT legs. Two
     * different sets of rows, two different accounts, one answer — and they can
     * only agree because `ledger_entry_balanced` refuses a transaction whose sides
     * do not match.
     *
     * WHY THIS IS HERE AND NOT INSTEAD OF THE SPEC ABOVE: an oracle answers "does
     * the report agree with the ledger", which is the question a reconciliation
     * asks. It does NOT answer "is either of them the number the merchant is owed"
     * — if `depositAppliedPosting` credited the wrong account, or credited nothing,
     * this oracle and the report would agree at the wrong figure. The hand
     * constants above are this file's own INPUTS (the prices it set, the deposit
     * the salon seeds), so they can disagree with both. Neither spec subsumes the
     * other; see § THE RULING, at the foot of this file.
     */
    const fromLedger = salonRevenueFor([part.transactionId, whole.transactionId]);
    expect(
      fromLedger,
      'the salon_revenue credits on these two charges do not add up to what was sold, so the ' +
        'defect is in the LEDGER and not in the report',
    ).toBe(EARNED_IN_WINDOW);
  });

  it('the charge rows really do carry the net amount — the report is not reading them', () => {
    /**
     * The other half of the same claim, and the one that makes the delta above a
     * statement about the REPORT rather than about the fixture. If
     * `transaction.amount_fils` happened to hold the gross, a broken aggregate
     * would print the right answer and this file would be green for the wrong
     * reason. Asserted in SQL against the run database, not from the charge reply.
     */
    const netInRows = Number(
      scalar(
        `select -sum(amount_fils) from "transaction"
          where id in ('${part.transactionId}', '${whole.transactionId}')`,
      ),
    );
    expect(
      netInRows,
      'the charge rows hold the GROSS, so a sum over -amount_fils would have been correct and ' +
        `this file proves nothing about the aggregate. ${EARNED_IN_WINDOW} would mean the rows ` +
        'hold the gross.',
    ).toBe(CHARGED_IN_WINDOW);
  });
});

// ===========================================================================

describe('best-selling-services — the understatement and the negative row', () => {
  const rowFor = (body: any, service: string): any => {
    const rows = body.rows.filter((r: any) => r.service === service);
    precondition(rows.length === 1, `expected exactly one row for ${service}: ${JSON.stringify(rows)}`);
    return rows[0];
  };

  it('a part-covered booking is worth its whole basket — #81', async () => {
    const res = await report('best-selling-services');
    precondition(res.status === 200, `best-selling-services answered ${res.status}: ${res.raw}`);

    const row = rowFor(res.body, SV_PART_NAME);
    expect(row.bookings).toBe(1);
    expect(
      row.revenueFils,
      `${SV_PART_NAME} is worth ${row.revenueFils}. ${PART_CHARGED} is what the shipped ` +
        'implementation printed — the wallet movement — and on THIS card the understatement was ' +
        'total rather than partial, because every row here is a booking and a booking is the only ' +
        'thing that takes a deposit.',
    ).toBe(SV_PART_FILS);
  }, 60_000);

  it('a booking the deposit covered outright is not worth zero — #81, the worse half', async () => {
    const res = await report('best-selling-services');
    precondition(res.status === 200, res.raw);

    const row = rowFor(res.body, SV_WHOLE_NAME);
    expect(row.bookings).toBe(1);
    expect(
      row.revenueFils,
      `${SV_WHOLE_NAME} is worth ${row.revenueFils}. 0 is what the shipped implementation ` +
        'printed for an appointment that was delivered and paid for in full, and a zero is the ' +
        'one wrong figure a merchant cannot be suspicious of, because there is no small number ' +
        'to notice.',
    ).toBe(SV_WHOLE_FILS);
  }, 60_000);

  it('a no-show scores ZERO, not minus the deposit it handed back — #83', async () => {
    const res = await report('best-selling-services');
    precondition(res.status === 200, res.raw);

    const row = rowFor(res.body, SV_MISS_NAME);
    expect(
      row.bookings,
      'the no-showed booking is not counted as a booking. The salon held a slot for it, and ' +
        "best-selling-services ranks by bookings — dropping it changes the card's ranking",
    ).toBe(1);
    expect(
      row.revenueFils,
      `${SV_MISS_NAME} is worth ${row.revenueFils}. ${-DEPOSIT_FILS} is what the shipped ` +
        'implementation printed: a no_show_returned booking DOES carry a settled_transaction_id, ' +
        'pointing at the deposit RETURN, whose amount_fils is positive — so sum(-amount_fils) ' +
        'subtracted the deposit from the service. A popular service could be driven below zero ' +
        'by no-shows. See DECISIONS.md #83.',
    ).toBe(0);
  }, 60_000);

  it('no row on this card is negative, on the whole 30-day window', async () => {
    /**
     * THE GENERALISATION OF #83, and the assertion that does not need this file's
     * fixture to keep existing. A service's revenue is a sum of things the salon
     * SOLD; there is no sequence of legitimate events that makes it negative. A
     * void does not — a voided charge is excluded rather than subtracted. So this
     * is a property of the report and not of a fixture, and it holds over every
     * row the run database happens to contain, including rows other files drove.
     */
    const res = await report('best-selling-services', '?period=30d');
    precondition(res.status === 200, res.raw);
    const negative = res.body.rows.filter((r: any) => r.revenueFils < 0);
    expect(
      negative,
      `these rows report negative revenue: ${JSON.stringify(negative)}. A service cannot un-sell ` +
        'itself; something positive is being subtracted.',
    ).toEqual([]);
  }, 60_000);
});

// ===========================================================================

describe('the two reports reconcile — one definition, or they disagree loudly', () => {
  /**
   * THE STRUCTURAL GUARD, AND THE PART OF THIS FILE THAT OUTLIVES ITS FIXTURE.
   *
   * `services/reports.ts` claims, in prose, that `sales` reading `earned_fils` is
   * "what makes those two figures reconcile for a period rather than merely look
   * similar". That is a checkable claim and nothing checked it.
   *
   * It is checkable because `artist-performance` partitions the same population by
   * a completely different route: its `attributed` CTE takes charges that ARE some
   * booking's settling transaction, its walk-in bucket takes charges that are NOT
   * (`NOT EXISTS`, so the definition is the absence of the join and cannot drift
   * from it), and its shop bucket takes the rest. Disjoint, covering, same window,
   * same `NOT_VOIDED`. Its stat sums `earnedFils` over EVERY row.
   *
   * So `sales.stat` and `artist-performance.stat` are two independently written
   * aggregates over one population, and any drift between the two definitions of
   * revenue shows up here as a difference — including the drift that WAS #81,
   * which touched `sales` and not `artist-performance`. That is the property worth
   * having: it does not depend on this file's three bookings, or on any figure
   * being written down, and it goes red for a class of change rather than for a
   * case.
   *
   * Back to back with no writes between, so the only thing that can differ is the
   * definition.
   */
  it('sales gross and artist-performance earned are the same number, over 7 days', async () => {
    const sales = await report('sales');
    const artists = await report('artist-performance');
    precondition(
      sales.status === 200 && artists.status === 200,
      `sales ${sales.status}, artist-performance ${artists.status}`,
    );

    expect(
      sales.body.stat.value,
      `Sales says the salon grossed ${sales.body.stat.value} and Artist performance says it ` +
        `earned ${artists.body.stat.value}. Two merchant-facing exports of one week disagree, ` +
        'so one of them has stopped reading transaction_revenue. This is the shape DECISIONS.md ' +
        '#81 had: sales summed the wallet movement and artist-performance did not.',
    ).toBe(artists.body.stat.value);
  }, 60_000);

  it('and over 30 days, where the older rows other files drove also have to agree', async () => {
    const sales = await report('sales', '?period=30d');
    const artists = await report('artist-performance', '?period=30d');
    precondition(sales.status === 200 && artists.status === 200, 'one of the pair failed');
    expect(sales.body.stat.value).toBe(artists.body.stat.value);
  }, 60_000);

  it('the artist row carries charged, applied and earned, and they add up', async () => {
    /**
     * `earnedFils` is `charged + deposit_applied` added in TypeScript from two
     * integers, deliberately, so the row's own arithmetic and the stat's sum are
     * the same addition. Checked on the row this file drove, where all three are
     * non-zero and distinct — the only configuration in which "they add up" is a
     * real statement rather than `0 + 0 = 0`.
     */
    const res = await report('artist-performance');
    precondition(res.status === 200, res.raw);

    const artistName = scalar(`select name from artist where id='${ARTIST_PART}'`).trim();
    const row = res.body.rows.find((r: any) => r.attributedTo === artistName);
    precondition(row !== undefined, `no row for ${artistName}: ${res.raw}`);

    expect(row.chargedFils + row.depositAppliedFils).toBe(row.earnedFils);
    expect(
      row.depositAppliedFils,
      `${artistName}'s applied-deposit column is ${row.depositAppliedFils}. This file drove one ` +
        `${PART_APPLIED}-fils apply onto her, so a zero here means the column is not reading the ` +
        'view — and the two money columns are on the face of this report precisely so that a ' +
        'disagreement between them cannot hide inside one number.',
    ).toBeGreaterThanOrEqual(PART_APPLIED);
    expect(row.earnedFils).toBeGreaterThan(row.chargedFils);
  }, 60_000);
});

// ===========================================================================

describe('THE INVARIANT — this fixture does not owe the ledger anything', () => {
  /**
   * `db:verify` INVARIANT 5, IN FULL, ON THIS FILE'S OWN MEMBER —
   * `member.balance_fils = sum(member_wallet credits − debits)`.
   *
   * WHY A DRIVEN FIXTURE IS WORTH THE EXTRA MINUTE, ASSERTED RATHER THAN CLAIMED.
   * Lane A reported that this invariant fails after any lane A int run, because
   * those fixtures hand-write wallet legs with no funding chain behind them. It is
   * pre-existing, it is not this lane's to fix, and it is the same family of
   * problem as the one this file exists for: a fixture in a state the product
   * could not have reached.
   *
   * NOT `opening + legs`, WHICH IS WHAT THIS SPEC SAID IN ITS FIRST DRAFT AND WAS
   * THE BUG. Writing the opening balance into the assertion makes it hold no
   * matter how much money the fixture invented — it merely re-states the fixture's
   * own arithmetic back at itself, and the run-teardown probe in
   * `support/global-setup.ts` caught it doing exactly that: 200.000 fils of drift
   * on a file whose header claims it writes no ledger rows. That is this whole
   * slice's lesson arriving on its own author. The opening balance now has an
   * entry of its own (see `beforeAll`, and `api/src/db/seed.ts` § "the opening
   * balances", which settled the same question first), so the invariant can be
   * asserted in the form `db:verify` asserts it, with nothing added.
   *
   * It holds through six wallet movements of five kinds: the opening credit, a
   * deposit hold, a wallet spend, a deposit remainder returned, a no-show deposit
   * returned, and any happy-hour credit the seeded window granted.
   *
   * SCOPED TO HER, DELIBERATELY. A salon-wide version belongs in the run teardown
   * and is there; as a spec it could only ever see the files that happened to run
   * before this one, since vitest does not order files alphabetically.
   */
  it('her balance equals the sum of her wallet legs, with nothing added', () => {
    const legs = Number(
      scalar(
        `select coalesce(sum(case when le.direction = 'credit' then le.amount_fils
                                  else -le.amount_fils end), 0)
           from ledger_entry le
          where le.account = 'member_wallet' and le.member_id = '${MEMBER}'`,
      ),
    );
    expect(
      balanceOf(MEMBER),
      `her balance is ${balanceOf(MEMBER)} and her wallet legs sum to ${legs}. A gap of exactly ` +
        `${MEMBER_OPENING_FILS} means her opening balance lost its originating entry; any other ` +
        'gap means this file has written money by hand somewhere. See db:verify invariant 5.',
    ).toBe(legs);
  });

  it('and every transaction it drove balances, debits against credits', () => {
    /**
     * `ledger_entry_balanced` is DEFERRABLE INITIALLY DEFERRED, so it fires at
     * COMMIT and a suite that never commits an unbalanced pair never learns
     * whether it is on. Asserted over this file's own transactions so the answer
     * is about rows it created.
     */
    const ids = [part.transactionId, whole.transactionId, miss.returnTransactionId];
    const unbalanced = psql(
      `select transaction_id, sum(case when direction='credit' then amount_fils
                                       else -amount_fils end) as net
         from ledger_entry
        where transaction_id in (${ids.map((i) => `'${i}'`).join(',')})
        group by 1 having sum(case when direction='credit' then amount_fils
                                   else -amount_fils end) <> 0;`,
    );
    expect(unbalanced, `an unbalanced transaction committed:\n${unbalanced}`).toContain('(0 rows)');
  });

  it('the remainder came back as its OWN transaction, not netted into the charge', () => {
    /**
     * Non-negotiable #5 and `charge.ts` § 7a: she held 5.000, the visit was
     * 4.000, and 1.000 is hers. Netting it inside the charge row would leave the
     * activity feed unable to show her either figure — and would ALSO have made
     * the `whole` case indistinguishable from a 5.000 basket in every report,
     * which is why it belongs in this file rather than only in deposit.test.ts.
     */
    expect(whole.returnedFils, 'the remainder was not handed back').toBe(WHOLE_RETURNED);
    expect(whole.chargedFils, 'something was debited for a visit the deposit covered').toBe(
      WHOLE_CHARGED,
    );
    expect(
      Number(
        scalar(
          `select count(*) from "transaction"
            where member_id='${MEMBER}' and kind='deposit_return' and amount_fils=${WHOLE_RETURNED}`,
        ),
      ),
      'the remainder is not a deposit_return row of its own, so she cannot see it',
    ).toBe(1);
  });
});

// ===========================================================================
// § THE RULING — HAND-WRITTEN CONSTANTS VERSUS A DERIVED ORACLE
// ===========================================================================
/**
 * `e2e/reports.test.ts` states its expected figures as hand sums — `GROSS_7D`,
 * `GROSS_30D` — written down over a table of fixture rows. Those constants are
 * cited as the reason DECISIONS.md #81 was invisible: they agreed with the wrong
 * implementation. The obvious conclusion is "replace constants with a derived
 * oracle", and it is the wrong conclusion, so this file does something else and
 * the argument is recorded here rather than left to be inferred from the code.
 *
 * THE CONSTANTS WERE NOT WHY THE DEFECT WAS INVISIBLE. The fixture was. On rows
 * where `-amount_fils` and "what the salon earned" are the same number, EVERY
 * expectation is green: a hand constant, a first-principles recomputation, and a
 * cross-check derived from any route you like. A derived oracle over the old
 * fixture would have been just as green, and would have looked more rigorous
 * while proving exactly as little. That is the whole finding, and it is why the
 * first describe in this file asserts the fixture DISCRIMINATES before any
 * figure is asserted.
 *
 * A DERIVED ORACLE ALSO FAILS IN A WAY A CONSTANT CANNOT. It answers "do these
 * two computations agree", which is a weaker question than "is this the number
 * the merchant is owed". Derive revenue from `transaction.amount_fils` and you
 * reproduce #81 exactly, in the oracle, and the report and the oracle agree at
 * the wrong figure — the failure mode is silent and it is worse than a wrong
 * constant, because a wrong constant is one number a reviewer can check against
 * the fixture while a wrong oracle is a query nobody re-derives.
 *
 * SO THE RULE THIS FILE FOLLOWS IS ABOUT PROVENANCE, NOT STYLE:
 *
 *   A CONSTANT IS RIGHT WHEN IT IS AN INPUT. `SV_PART_FILS`, `SV_WHOLE_FILS`,
 *   `DEPOSIT_FILS` — this file chose those prices and the salon seeds that
 *   deposit. `EARNED_IN_WINDOW` is their sum and nothing read back computes it.
 *   A constant that is an input cannot agree with a broken implementation by
 *   construction, because the implementation had no say in it. `GROSS_7D` was
 *   NOT this: it was a sum over rows chosen to exercise EXCLUSIONS, and the
 *   applied-deposit shape was simply not among them.
 *
 *   AN ORACLE IS RIGHT WHEN IT IS A DIFFERENT ROUTE TO THE SAME FACT. This
 *   file's oracle is `salonRevenueFor` — the `salon_revenue` CREDIT legs — while
 *   the report reads `-amount_fils` plus the `deposit_held` DEBIT legs. Different
 *   rows, different accounts, and they can only agree because
 *   `ledger_entry_balanced` refuses a commit where the two sides of a
 *   transaction do not match. An oracle that shares a column with the thing it
 *   checks is not an oracle, it is a copy.
 *
 * BOTH, THEREFORE, AND NEITHER SUBSUMES THE OTHER. The constants say what the
 * merchant is owed; the oracle says the report and the ledger tell one story. A
 * defect that moves both is a defect in the LEDGER, and the messages say so.
 *
 * AND THE STRONGEST GUARD HERE IS NEITHER. It is the reconciliation above:
 * `sales` and `artist-performance` are two independently written aggregates over
 * one population, so any drift between two definitions of revenue shows up as a
 * difference between two merchant-facing exports. That assertion needs no figure
 * written down and does not depend on this file's three bookings — which is why
 * it, and not the constants, is the part of this file that will still be earning
 * its place in six months.
 */
