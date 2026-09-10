/**
 * EVERYTHING THAT READS A MEMBER AFTER SHE IS GONE — DECISIONS.md #100.
 *
 * WHAT THE BUG WAS, IN ONE SENTENCE. `services/erasure.ts` keeps the `member`
 * row as a TOMBSTONE — `name = 'Deleted account'`, `phone = '+990' + twelve
 * random digits on an unassigned country code — because seven years of books
 * reference it (§ SCRUB, NOT ROW-DELETE). Three merchant-facing endpoints join
 * `member` LIVE and serve that tombstone in a field the wire calls a phone
 * number, so the dashboard rendered a working `tel:` and the scanner a `tel:`
 * AND a `wa.me` beside a row reading "Deleted account". A merchant chasing a
 * delivery taps it, hears nothing, and learns nothing about why.
 *
 * WHAT THIS FILE IS FOR, AND IT IS NOT THE THREE ENDPOINTS
 * -------------------------------------------------------
 * DECISIONS.md #100 says the pattern is worth more than the bug, and quotes the
 * reason: "nobody had an inventory of everything that READS a member after she
 * is gone." It is the THIRD consequence of erasure found downstream of the
 * erasure fix rather than in it — after the false "Collecting at the salon"
 * sentence and two of this directory's own specs going stale. The scrub was
 * correct every time. What was missing was the list.
 *
 * So this file is the list, driven, in three sections that answer three
 * different questions:
 *
 *   § 1  the contract trunk decided, on the three endpoints being fixed today.
 *   § 2  the durable half — EVERY merchant- and scanner-facing read that can
 *        carry her, driven, with the WHOLE RESPONSE BODY asserted to contain no
 *        `+990`, through any key.
 *   § 3  the inventory itself, DERIVED off disk: every place in `api/src` that
 *        projects a member's phone into a response must be accounted for. § 2
 *        closes today's class; § 3 is what notices door number five.
 *
 * WHY THE WHOLE BODY AND NOT THE FIELDS
 * -------------------------------------
 * Because a field list is a list of the doors somebody already thought of, and
 * the doors nobody thought of are the entire subject of #100. Three were found
 * by walking into them. `api/src/services/erasureAddress.int.test.ts` § "the
 * board response carries no component of her address" makes exactly this
 * argument for the address scrub — "here to survive a column this suite does not
 * know about" — and this is the same technique aimed at the tombstone instead of
 * the street: serialise the response, scan it for the sentinel, fail with a
 * message that says what to do.
 *
 * `+990` IS THE SENTINEL AND IT IS A SERVER CONSTANT, WHICH IS THE POINT TWICE
 * OVER. #100 rejected client-side `+990` matching as the FIX, because a client
 * string-matching a server constant is the shape that rots — the prefix moves
 * and the UI silently starts offering the link again. A TEST matching it is the
 * opposite: this file wants to be the thing that goes red when the prefix moves,
 * and `tombstonePhone()` in `services/erasure.ts` is the one definition either
 * way. Both the exact minted number and the bare prefix are asserted, so a
 * response that reached for a DIFFERENT erased member's tombstone still fails.
 *
 * ---------------------------------------------------------------------------
 * THE CONTRACT, DECIDED AT TRUNK AND BINDING ON ALL THREE
 * ---------------------------------------------------------------------------
 *
 *     memberErased: boolean        member.erased_at IS NOT NULL
 *     memberPhone:  string | null  null when memberErased is true
 *     memberName:   string         still the 'Deleted account' tombstone
 *
 * `memberName` STAYS THE TOMBSTONE deliberately. The row still has to say whose
 * order it was; "Deleted account" is the de-identified answer and it is not a
 * leak. What is a leak is a DIALABLE tombstone, and only the phone is dialable.
 *
 * THE PAIR IS THE CONTRACT, not either half. A client branching on
 * `memberPhone == null` alone cannot tell "erased, deliberately no number" from
 * "the join forgot to send it", which is the ambiguity `countedPage`'s history
 * in `contract.test.ts` is about. So both are asserted on every endpoint, and
 * the flag is asserted TRUE rather than merely present.
 *
 * ---------------------------------------------------------------------------
 * SEQUENCING: THIS FILE IS WRITTEN AHEAD OF THE FIX AND SAYS SO
 * ---------------------------------------------------------------------------
 * Lanes A, B and C are landing #100 in parallel and lane D merges last. § 1 is
 * red until lane A serves `memberErased`; that is the assertions describing
 * finished behaviour, not a defect in the fixture. Every § 1 spec's failure
 * message names which side it is waiting on, so a reader of a red run can tell
 * "not merged yet" from "actually wrong" without reading this header.
 *
 * DELIBERATELY NOT `knownBug()`. That helper reports "still broken" as a PASS,
 * which is right for a drift somebody else owns and wrong here: these are the
 * acceptance criteria for work in flight, and a green run must mean the work
 * landed. DECISIONS.md #93 records the same choice for the same reason — a
 * pinned ledger over `knownBug`, because `knownBug` would swallow a third
 * instance.
 *
 * ---------------------------------------------------------------------------
 * THE FIXTURE — ONE MEMBER, THREE KINDS OF ROW, ONE ERASURE
 * ---------------------------------------------------------------------------
 * She needs to be readable on all three surfaces at once, which is three
 * different tables:
 *
 *   a shop order            `shop_order` + its settled `shop` transaction, so
 *                           she is on `GET /v1/salons/{id}/orders`.
 *   a salon booking         CANCELLED, on AR-001, so she is on
 *                           `GET /salons/{id}/bookings` and NOT on the artist's
 *                           day — which is what makes the two endpoints two
 *                           doors rather than one asserted twice.
 *   an artist booking       COMPLETED, on AR-003 (the only artist wired to a
 *                           `staff_user`, so the only one whose own day is
 *                           reachable), twenty hours ago — inside the route's
 *                           `starts_at >= now() - 24h` window and clear of the
 *                           −60/−20-minute slots `deposit.test.ts` moves ITS
 *                           AR-003 bookings into. The exclusion constraint
 *                           `booking_artist_slot_no_overlap` is real and shared.
 *
 * SQL FIXTURES, NOT DRIVEN WRITES, and `delivery-address-privacy.test.ts` states
 * the precedent: creating them through the routes the erasure is about would
 * make the fixture depend on the thing under test, and a booking cannot be
 * placed twenty hours in the past through `POST /bookings` at all. The write
 * paths are lane A's specs.
 *
 * SHE MUST BE ERASABLE, which is three money preconditions the job REFUSES to
 * decide (`services/erasure.ts` § WHAT THE JOB REFUSES): a non-zero balance, a
 * `deposit_held` booking, a live top-up intent. Her balance is zeroed with the
 * due date and both her bookings are terminal, so the job erases rather than
 * defers. If it ever defers, the precondition below says so by name instead of
 * letting every spec fail as though the endpoints were wrong.
 *
 * `dropFixtures()` RUNS FIRST AND LAST, in FK order. She is erased inside this
 * run — irreversible — so nothing outside this file may share her.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { precondition } from './support/known-bug.js';
import {
  A_BRANCH,
  A_STAFF_FULL,
  SALON_A,
  attemptScannerSignIn,
  pgDb,
  psql,
  repoRoot,
  resetPinState,
  runApiDbScriptResult,
  scalar,
  signInDashboard,
  signInScanner,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

// ---------------------------------------------------------------------------
// The people and the rows.
// ---------------------------------------------------------------------------

/** Hers alone. Erased inside this run; no other file may reference her. */
const HER = 'QA-ERS-0001';
const HER_PHONE = '+96599779101';
const HER_NAME = 'Erasure Surfaces Fixture';

const HER_ORDER = 'TX-QAERS-ORDER';
const HER_ADDRESS = 'ADR-QAERS';

/** The cancelled one — merchant board only. AR-001 is not wired to a staff login. */
const SALON_BOOKING = 'BK-QAERS-SALON';
const SALON_BOOKING_HOLD = 'TX-QAERS-SALON-HOLD';
const SALON_BOOKING_RETURN = 'TX-QAERS-SALON-RETURN';
const SALON_ARTIST = 'AR-001';

/**
 * THE CONTROL, AND SHE IS A FIXTURE RATHER THAN "whoever else is on the page".
 *
 * The first run of this file asserted the live half against the seed's own
 * bookings and failed a precondition saying every row on the Appointments page
 * was a tombstone. It was right: the seed books nobody at salon A, so the page
 * held this file's two rows and nothing else. Reading the control off ambient
 * data would also have made it depend on which suites ran first, in a directory
 * whose file order vitest does not guarantee.
 *
 * She is LIVE — never erased, never even given a deletion date — and she exists
 * for one assertion: `memberErased: false` with a real phone. Without her,
 * `memberErased: true` hardcoded on every row would satisfy every other spec in
 * this file and delete the phone number off a working Appointments screen.
 */
const CONTROL = 'QA-ERS-0002';
const CONTROL_PHONE = '+96599779102';
const CONTROL_NAME = 'Erasure Surfaces Control';
const CONTROL_BOOKING = 'BK-QAERS-CONTROL';
const CONTROL_BOOKING_HOLD = 'TX-QAERS-CONTROL-HOLD';
const CONTROL_BOOKING_RETURN = 'TX-QAERS-CONTROL-RETURN';
/** A third artist, so no fixture here can collide with another on the slot. */
const CONTROL_ARTIST = 'AR-002';

/** The completed one — the artist's own day AND the merchant board. */
const ARTIST_BOOKING = 'BK-QAERS-ARTIST';
const ARTIST_BOOKING_HOLD = 'TX-QAERS-ARTIST-HOLD';
const ARTIST_BOOKING_CHARGE = 'TX-QAERS-ARTIST-CHARGE';

/**
 * AR-003 is Hessa, and she is the ONLY artist with a `staff_user_id` in the seed
 * (`api/src/db/seed.ts` § artists). `GET /artists/me/bookings` resolves the
 * artist row from the signed-in staff id, so she is the only artist whose own
 * day can be read at all.
 */
const ARTIST_STAFF_ARTIST = 'AR-003';
const ARTIST_STAFF = 'ST-002';
const ARTIST_STAFF_HANDLE = 'hessa';
/**
 * HESSA'S PIN IS NOT NOURA'S, which is why `signInScanner()` cannot be used
 * here: that helper hardcodes `STAFF_PIN` (2468) and Hessa's row carries
 * `hashSecret(HESSA_PIN)` — 1357, `api/src/db/seed.ts:82`. Signing her in with
 * the wrong PIN does not just fail, it BURNS an attempt against a device three
 * other files share and a lockout after five would read as this file's bug in
 * theirs.
 */
const ARTIST_STAFF_PIN = '1357';
const SCANNER_DEVICE = 'DEV-SCANNER-01';
const A_STAFF_HANDLE = 'noura';

const A_SERVICE_ID = 'SV-01';

const TOMBSTONE_NAME = 'Deleted account';
/**
 * THE PREFIX, FROM `services/erasure.ts` § `tombstonePhone()`. +990 is an
 * unassigned country code: well-formed enough for `member_phone_is_e164` and the
 * per-salon unique index, and impossible to reach. If this constant ever stops
 * matching that function, this file going red IS the intended outcome — see the
 * header.
 */
const TOMBSTONE_PREFIX = '+990';

const ORDER_PRICE_FILS = 4_500;
const DEPOSIT_FILS = 5_000;
const SERVICE_CHARGE_FILS = 3_000;
const OPENING_BALANCE_FILS = 50_000;

// ---------------------------------------------------------------------------

let dashboard = '';
let artistScanner = '';
let staffScanner = '';
/** Read out of the database after the job runs — the exact number it minted. */
let mintedTombstone = '';

const count = (sql: string): number => Number(scalar(sql).trim());

function seedMember(id: string, name: string, phone: string): void {
  psql(`
    INSERT INTO member (id, salon_id, name, phone, email, email_verified, password_hash,
                        balance_fils, visits, tier, stamps, policy_version)
    SELECT '${id}', '${SALON_A}', '${name}', '${phone}', NULL, false,
           s.password_hash, ${OPENING_BALANCE_FILS}, 3, 'bronze', NULL, 3
    FROM staff_user s WHERE s.id = '${A_STAFF_FULL}'
    ON CONFLICT (id) DO UPDATE SET
      name                  = EXCLUDED.name,
      phone                 = EXCLUDED.phone,
      balance_fils          = ${OPENING_BALANCE_FILS},
      erased_at             = NULL,
      deletion_requested_at = NULL,
      deletion_due_at       = NULL;
  `);
}

/**
 * The control's booking. Cancelled, on a third artist, six days back — the same
 * shape as the erased member's salon booking so the two rows differ in exactly
 * one thing: whether their member was erased.
 */
function seedControlBooking(): void {
  psql(`
    INSERT INTO transaction (id, member_id, salon_id, branch_id, kind, amount_fils,
                             method, status, settled_at, created_at)
    VALUES
      ('${CONTROL_BOOKING_HOLD}', '${CONTROL}', '${SALON_A}', '${A_BRANCH}', 'deposit_hold',
       ${-DEPOSIT_FILS}, 'wallet', 'settled', now() - interval '7 days', now() - interval '7 days'),
      ('${CONTROL_BOOKING_RETURN}', '${CONTROL}', '${SALON_A}', '${A_BRANCH}', 'deposit_return',
       ${DEPOSIT_FILS}, 'wallet', 'settled', now() - interval '6 days', now() - interval '6 days')
    ON CONFLICT (id) DO UPDATE SET amount_fils = EXCLUDED.amount_fils;

    INSERT INTO booking (id, salon_id, branch_id, member_id, artist_id, service_id,
                         starts_at, ends_at, duration_min, deposit_fils, status,
                         hold_transaction_id, settled_transaction_id,
                         no_show_return_due_at, cancelled_at)
    VALUES ('${CONTROL_BOOKING}', '${SALON_A}', '${A_BRANCH}', '${CONTROL}', '${CONTROL_ARTIST}',
            '${A_SERVICE_ID}', now() - interval '6 days' + interval '2 hours',
            now() - interval '6 days' + interval '2 hours 30 minutes', 30, ${DEPOSIT_FILS},
            'cancelled', '${CONTROL_BOOKING_HOLD}', '${CONTROL_BOOKING_RETURN}',
            now() - interval '6 days' + interval '3 hours 30 minutes',
            now() - interval '6 days' + interval '2 hours')
    ON CONFLICT (id) DO NOTHING;
  `);
}

/**
 * A delivery order with a real address snapshot.
 *
 * The ADDRESS half of this row is lane A's `erasureAddress.int.test.ts` subject
 * and is deliberately not re-asserted here — two files asserting one fact means
 * one of them rots. It is seeded because the order must be a DELIVERY to be the
 * row the design puts a Call button on, and because the board's own sweep in § 2
 * should be scanning a full-fat row rather than a pickup with eleven nulls.
 */
function seedOrder(): void {
  psql(`
    INSERT INTO member_address (id, member_id, label, block, street, building,
                                floor, apartment, area, governorate, instructions,
                                latitude, longitude)
    VALUES ('${HER_ADDRESS}', '${HER}', 'QAERS label', 'QAERS-BLOCK', 'QAERS-STREET',
            'QAERS building', '2', '7', 'Salmiya', 'Hawalli', 'QAERS-GATECODE',
            '29.336670', '48.077500')
    ON CONFLICT (id) DO UPDATE SET member_id = EXCLUDED.member_id;

    INSERT INTO transaction (id, member_id, salon_id, branch_id, kind, amount_fils,
                             method, status, settled_at)
    VALUES ('${HER_ORDER}', '${HER}', '${SALON_A}', '${A_BRANCH}', 'shop',
            ${-ORDER_PRICE_FILS}, 'wallet', 'settled', now())
    ON CONFLICT (id) DO UPDATE SET amount_fils = EXCLUDED.amount_fils;

    INSERT INTO shop_order (transaction_id, salon_id, member_id, fulfilment, status,
                            address_id, address_label, block, street, building,
                            floor, apartment, area, governorate, instructions,
                            latitude, longitude)
    VALUES ('${HER_ORDER}', '${SALON_A}', '${HER}', 'delivery', 'preparing',
            '${HER_ADDRESS}', 'QAERS label', 'QAERS-BLOCK', 'QAERS-STREET',
            'QAERS building', '2', '7', 'Salmiya', 'Hawalli', 'QAERS-GATECODE',
            '29.336670', '48.077500')
    ON CONFLICT (transaction_id) DO UPDATE SET
      status = 'preparing', address_erased_at = NULL;

    INSERT INTO shop_order_line (transaction_id, product_id, name, qty,
                                 unit_price_fils, line_total_fils)
    SELECT '${HER_ORDER}', p.id, p.name, 1, ${ORDER_PRICE_FILS}, ${ORDER_PRICE_FILS}
      FROM product p WHERE p.salon_id = '${SALON_A}' ORDER BY p.id LIMIT 1
    ON CONFLICT (transaction_id, product_id) DO NOTHING;
  `);
}

/**
 * Both bookings, each with the transactions its status is CHECKed to name.
 *
 * `booking_settlement_matches_status` makes the state machine a database fact:
 * held ⟺ nothing settled it, and every terminal status names the transaction
 * that resolved the money. So a cancelled booking needs its `deposit_return`
 * (positive, per `transaction_amount_sign_matches_kind`) and a completed one
 * needs its `charge` (non-positive). A fixture that skipped them would not
 * commit, which is the constraint doing its job.
 *
 * NO `ledger_entry` ROWS. `ledger_entry` is append-only by TRIGGER, not by
 * grant, and `ledger_entry.transaction_id` is `ON DELETE restrict` — one seeded
 * ledger row would make this file's teardown fail for ever, and the teardown is
 * what keeps her out of every other file's counts. The money side of erasure is
 * lane A's `erasureAddress.int.test.ts`, to the fils, through the real paths.
 */
function seedBookings(): void {
  psql(`
    INSERT INTO transaction (id, member_id, salon_id, branch_id, kind, amount_fils,
                             method, status, settled_at, created_at)
    VALUES
      ('${SALON_BOOKING_HOLD}', '${HER}', '${SALON_A}', '${A_BRANCH}', 'deposit_hold',
       ${-DEPOSIT_FILS}, 'wallet', 'settled', now() - interval '7 days', now() - interval '7 days'),
      ('${SALON_BOOKING_RETURN}', '${HER}', '${SALON_A}', '${A_BRANCH}', 'deposit_return',
       ${DEPOSIT_FILS}, 'wallet', 'settled', now() - interval '6 days', now() - interval '6 days'),
      ('${ARTIST_BOOKING_HOLD}', '${HER}', '${SALON_A}', '${A_BRANCH}', 'deposit_hold',
       ${-DEPOSIT_FILS}, 'wallet', 'settled', now() - interval '25 hours', now() - interval '25 hours'),
      ('${ARTIST_BOOKING_CHARGE}', '${HER}', '${SALON_A}', '${A_BRANCH}', 'charge',
       ${-SERVICE_CHARGE_FILS}, 'wallet', 'settled', now() - interval '19 hours', now() - interval '19 hours')
    ON CONFLICT (id) DO UPDATE SET amount_fils = EXCLUDED.amount_fils;

    INSERT INTO booking (id, salon_id, branch_id, member_id, artist_id, service_id,
                         starts_at, ends_at, duration_min, deposit_fils, status,
                         hold_transaction_id, settled_transaction_id,
                         no_show_return_due_at, cancelled_at)
    VALUES ('${SALON_BOOKING}', '${SALON_A}', '${A_BRANCH}', '${HER}', '${SALON_ARTIST}',
            '${A_SERVICE_ID}', now() - interval '6 days',
            now() - interval '6 days' + interval '30 minutes', 30, ${DEPOSIT_FILS},
            'cancelled', '${SALON_BOOKING_HOLD}', '${SALON_BOOKING_RETURN}',
            now() - interval '6 days' + interval '90 minutes', now() - interval '6 days')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO booking (id, salon_id, branch_id, member_id, artist_id, service_id,
                         starts_at, ends_at, duration_min, deposit_fils, status,
                         hold_transaction_id, settled_transaction_id,
                         no_show_return_due_at, completed_at)
    VALUES ('${ARTIST_BOOKING}', '${SALON_A}', '${A_BRANCH}', '${HER}', '${ARTIST_STAFF_ARTIST}',
            '${A_SERVICE_ID}', now() - interval '20 hours',
            now() - interval '20 hours' + interval '30 minutes', 30, ${DEPOSIT_FILS},
            'completed', '${ARTIST_BOOKING_HOLD}', '${ARTIST_BOOKING_CHARGE}',
            now() - interval '20 hours' + interval '90 minutes', now() - interval '19 hours')
    ON CONFLICT (id) DO NOTHING;
  `);
}

/**
 * FK ORDER, and every line is load-bearing — `delivery-address-privacy.test.ts`
 * § `dropFixtures` writes the same walk out for the order half.
 *
 *   `shop_order_line` → `transaction`, restrict. Deletable here because 0027
 *                       revokes UPDATE/DELETE from `avo_app` by GRANT, and
 *                       `psql()` is not `avo_app`.
 *   `booking`         → `transaction` TWICE, restrict both ways. Bookings before
 *                       the transactions they name, or neither goes.
 *   `shop_order`      → `transaction`, and → `member_address`, restrict. Orders
 *                       before addresses.
 *   `transaction`     → `member`, restrict. This is WHY erasure is a scrub.
 *
 * `audit_log` is left alone: `audit_log_no_delete` refuses outright, and the
 * erasure job's own row names nobody by design.
 */
function dropFixtures(): void {
  const ids = `'${HER}', '${CONTROL}'`;
  psql(`
    DELETE FROM shop_order_line WHERE transaction_id = '${HER_ORDER}';
    DELETE FROM booking     WHERE member_id IN (${ids});
    DELETE FROM shop_order  WHERE member_id IN (${ids});
    DELETE FROM transaction WHERE member_id IN (${ids});
    DELETE FROM member_address WHERE member_id IN (${ids});
    DELETE FROM session     WHERE member_id IN (${ids});
    DELETE FROM wallet_token WHERE member_id IN (${ids});
    DELETE FROM member      WHERE id IN (${ids});
  `);
}

interface ErasureResult {
  candidates: number;
  erased: number;
  deferredBalance: number;
  deferredEscrow: number;
  deferredPendingTopup: number;
  skipped: number;
  failed: number;
}

/**
 * `delivery-address-privacy.test.ts` and `support-routing.test.ts` each carry an
 * identical copy of this, and the duplication is the established call here:
 * importing one file's fixture helper into another couples two unrelated suites
 * through it. Six lines is cheaper than the coupling.
 */
function runErasureJob(): ErasureResult {
  const res = runApiDbScriptResult('src/jobs/erasure-once.ts', pgDb());
  if (!res.ok) {
    throw new Error(
      `the erasure job failed to run at all.\n--- stdout ---\n${res.stdout}\n` +
        `--- stderr ---\n${res.stderr}`,
    );
  }
  const start = res.stdout.indexOf('{');
  if (start < 0) throw new Error(`the erasure job printed no JSON:\n${res.stdout}`);
  return JSON.parse(res.stdout.slice(start)) as ErasureResult;
}

let erasure: ErasureResult | undefined;

beforeAll(async () => {
  await startTenancyApi();
  dropFixtures();
  seedMember(HER, HER_NAME, HER_PHONE);
  seedMember(CONTROL, CONTROL_NAME, CONTROL_PHONE);
  seedOrder();
  seedBookings();
  seedControlBooking();

  dashboard = await signInDashboard(SALON_A, A_STAFF_HANDLE);

  /**
   * PIN STATE RESET BEFORE EITHER SIGN-IN, because `pin_attempt` is scoped to the
   * DEVICE and `DEV-SCANNER-01` is shared with `deposit.test.ts`,
   * `integration.test.ts` and `contract.test.ts`. A device that has spent its
   * window elsewhere refuses a correct PIN here, and the refusal reads as a
   * credential problem.
   */
  resetPinState(ARTIST_STAFF, SCANNER_DEVICE);
  const artistSession = await attemptScannerSignIn({
    salonId: SALON_A,
    handle: ARTIST_STAFF_HANDLE,
    deviceId: SCANNER_DEVICE,
    pin: ARTIST_STAFF_PIN,
  });
  const artistToken = artistSession.body.accessToken;
  precondition(
    artistSession.status === 200 && typeof artistToken === 'string' && artistToken !== '',
    `Hessa (${ARTIST_STAFF}) could not sign in to the scanner: ${artistSession.status} ` +
      `${artistSession.raw}. Her PIN is HESSA_PIN in api/src/db/seed.ts and it is NOT ` +
      `STAFF_PIN — if the seed moved, ARTIST_STAFF_PIN in this file moved with it. ` +
      `Without her session the artist's-day half of #100 is untested, not green.`,
  );
  artistScanner = artistToken;

  /**
   * Noura's own scanner session, for the two directory reads in § 2. Through
   * `signInScanner` rather than `attemptScannerSignIn` because it is cached per
   * run — one more `POST /staff/session` on a shared device is one more entry in
   * a rate-limit window three other files are also spending.
   */
  staffScanner = await signInScanner(SALON_A, A_STAFF_HANDLE, SCANNER_DEVICE);

  // ------------------------------------------------- the fixture is real ----
  precondition(
    count(`select count(*) from shop_order where member_id='${HER}'`) === 1,
    'she has no shop order, so the fulfilment board proves nothing about her',
  );
  precondition(
    count(`select count(*) from booking where member_id='${HER}'`) === 2,
    'she does not have both bookings, so the two booking reads are not two doors',
  );
  precondition(
    count(
      `select count(*) from booking where member_id='${HER}' and status='deposit_held'`,
    ) === 0,
    'she has a deposit_held booking, so the erasure job will DEFER her rather than ' +
      'erase her — her money is in escrow and the job refuses to decide it',
  );

  // ------------------------------------------------------ erase her ---------
  // Due yesterday, balance zero. `runErasureOnce` selects on
  // `deletion_due_at <= now() AND erased_at IS NULL` and re-checks both inside
  // the member row's FOR UPDATE.
  psql(`
    UPDATE member
       SET deletion_requested_at = now() - interval '31 days',
           deletion_due_at       = now() - interval '1 day',
           balance_fils          = 0
     WHERE id = '${HER}';
  `);
  erasure = runErasureJob();

  precondition(
    scalar(`select erased_at is not null from member where id='${HER}'`).trim() === 't',
    `the job did not erase her, so NOTHING below is about what it says it is about. ` +
      `The job reported ${JSON.stringify(erasure)} — a nonzero deferredBalance or ` +
      `deferredEscrow is the job WORKING and this fixture broken; a nonzero failed is ` +
      `most likely the ordered pair of address writes.`,
  );

  mintedTombstone = scalar(`select phone from member where id='${HER}'`).trim();
  precondition(
    mintedTombstone.startsWith(TOMBSTONE_PREFIX),
    `the erased member's phone is "${mintedTombstone}", which does not start with ` +
      `${TOMBSTONE_PREFIX}. Either \`tombstonePhone()\` in api/src/services/erasure.ts ` +
      `changed its prefix — in which case TOMBSTONE_PREFIX here must follow it, and every ` +
      `client that was string-matching the old one is silently offering the link again — ` +
      `or the scrub no longer writes a tombstone at all.`,
  );
}, 180_000);

afterAll(async () => {
  dropFixtures();
  await stopTenancyApi();
});

// ===========================================================================
// 1. THE CONTRACT, ON THE THREE ENDPOINTS #100 NAMED
// ===========================================================================
/**
 * Each spec reads one endpoint, finds HER row by id, and asserts the triple.
 * They are three specs and not one loop so a red run says WHICH surface, which
 * is the whole reporting value while three lanes are landing three fixes.
 */
describe('the three merchant reads serve the erased contract', () => {
  /**
   * The shared shape of a failure message. Written once because all three say
   * the same thing and a reader of a red run should not have to work out which
   * lane owns it: the FIELD is lane A's, on all three endpoints.
   */
  const notYet = (endpoint: string, field: string) =>
    `${endpoint} does not serve \`${field}\` for an erased member.\n\n` +
    'IF LANE A HAS NOT MERGED, THIS IS EXPECTED AND NOT A DEFECT — this file is written ' +
    'ahead of the fix and lane D merges last (DECISIONS.md #100). If it HAS merged, the ' +
    'endpoint was missed: all three join `member` live and all three need the same ' +
    'three fields.\n';

  it('GET /v1/salons/:id/orders — the fulfilment board', async () => {
    const res = await treq<any>('GET', `/v1/salons/${SALON_A}/orders`, { token: dashboard });
    precondition(res.status === 200, `the board answered ${res.status}: ${res.raw}`);

    const row = (res.body.items as any[]).find((o) => o.transactionId === HER_ORDER);
    precondition(
      row !== undefined,
      `her order ${HER_ORDER} is not on the board at all, so this spec asserts nothing. ` +
        `The board serves the most recent ORDERS_PAGE orders by created_at DESC; if the ` +
        `run database has filled up with newer orders, this fixture needs its own filter ` +
        `rather than a bigger page.`,
    );

    expect(row.memberName, 'the tombstone NAME is the de-identified answer and should stay')
      .toBe(TOMBSTONE_NAME);
    expect(row.memberErased, notYet('GET /v1/salons/:id/orders', 'memberErased')).toBe(true);
    expect(
      row.memberPhone,
      'THE BOARD IS STILL SERVING A DIALABLE TOMBSTONE. This is the response DECISIONS.md ' +
        `#100 is about: "${TOMBSTONE_NAME}" beside ${TOMBSTONE_PREFIX}… rendered as a ` +
        '`tel:` link that reaches nobody and explains nothing.',
    ).toBeNull();
  });

  it('GET /salons/:id/bookings — the merchant Appointments list', async () => {
    const res = await treq<any>('GET', `/salons/${SALON_A}/bookings`, { token: dashboard });
    precondition(res.status === 200, `the appointments list answered ${res.status}: ${res.raw}`);

    const rows = (res.body.items as any[]).filter((b) => b.memberName === TOMBSTONE_NAME);
    const row = (res.body.items as any[]).find((b) => b.id === SALON_BOOKING);
    precondition(
      row !== undefined,
      `her cancelled booking ${SALON_BOOKING} is not on the list, so this spec asserts ` +
        `nothing. ${rows.length} tombstone row(s) were on the page. The list pages 200 at ` +
        `a time by starts_at DESC and hers is six days back.`,
    );

    expect(row.memberName).toBe(TOMBSTONE_NAME);
    expect(row.memberErased, notYet('GET /salons/:id/bookings', 'memberErased')).toBe(true);
    expect(
      row.memberPhone,
      'THE APPOINTMENTS LIST IS STILL SERVING A DIALABLE TOMBSTONE. Same defect, second ' +
        'door — and this row is one a merchant is MORE likely to tap, because a customer ' +
        'who did not turn up is exactly who you phone.',
    ).toBeNull();
  });

  it("GET /artists/me/bookings — the artist's own day, Call AND WhatsApp", async () => {
    const res = await treq<any>('GET', '/artists/me/bookings', { token: artistScanner });
    precondition(res.status === 200, `the artist's day answered ${res.status}: ${res.raw}`);

    const row = (res.body.items as any[]).find((b) => b.id === ARTIST_BOOKING);
    precondition(
      row !== undefined,
      `her completed booking ${ARTIST_BOOKING} is not on ${ARTIST_STAFF}'s day. The route ` +
        `filters \`starts_at >= now() - 24h\` and \`status IN (deposit_held, completed)\`; ` +
        `the fixture places it twenty hours back and completed, so if this fires the ` +
        `window moved or the booking is on the wrong artist.`,
    );

    expect(row.memberName).toBe(TOMBSTONE_NAME);
    expect(row.memberErased, notYet('GET /artists/me/bookings', 'memberErased')).toBe(true);
    expect(
      row.memberPhone,
      'THE ARTIST\'S DAY IS STILL SERVING A DIALABLE TOMBSTONE, and this is the worst of ' +
        'the three: the design gives this row "one-tap Call and WhatsApp" (README § My ' +
        'bookings), so ONE tombstone becomes TWO dialable affordances — and a `wa.me` on ' +
        'an unassigned country code is a message sent nowhere, with no error.',
    ).toBeNull();
  });

  /**
   * THE FLAG MUST BE A FLAG, not a coincidence. `memberErased: true` on every row
   * of a response would satisfy the three specs above and be catastrophically
   * wrong — every live customer's phone would vanish from the board. So a live
   * member is read on the same responses and asserted the other way.
   */
  it('a member who is NOT erased still gets her phone and a false flag', async () => {
    const res = await treq<any>('GET', `/salons/${SALON_A}/bookings`, { token: dashboard });
    precondition(res.status === 200, `the appointments list answered ${res.status}: ${res.raw}`);

    const row = (res.body.items as any[]).find((b) => b.id === CONTROL_BOOKING);
    precondition(
      row !== undefined,
      `the control booking ${CONTROL_BOOKING} is not on the list, so "a live member is ` +
        `unaffected" cannot be asked and the three specs above would be satisfied by a ` +
        `hardcoded \`memberErased: true\`.`,
    );

    expect(
      row.memberName,
      'the control is reading as a tombstone, so she was erased too and proves nothing',
    ).toBe(CONTROL_NAME);
    expect(
      row.memberErased,
      `${CONTROL_BOOKING} belongs to a LIVE member and reports memberErased: ` +
        `${row.memberErased}. A flag that is true for everyone is not a fix — it deletes ` +
        'the phone number off a working Appointments screen.',
    ).toBe(false);
    expect(
      row.memberPhone,
      `${CONTROL_BOOKING} belongs to a LIVE member and carries no phone. The null state ` +
        'belongs to erasure and nothing else; a blanket null is a broken screen, not a ' +
        'safer one.',
    ).toBe(CONTROL_PHONE);
  });
});

// ===========================================================================
// 2. THE CLASS — no merchant surface ANYWHERE carries a dialable tombstone
// ===========================================================================
/**
 * THE DURABLE HALF, and the reason this file exists rather than three assertions
 * bolted onto three lane suites.
 *
 * The three specs above close the three doors somebody walked into. This closes
 * the class: every merchant- and scanner-facing read that can carry her is
 * driven and its WHOLE BODY is scanned. A `+990` reaching a merchant through a
 * key nobody listed is the same defect arriving through a different door, and
 * the list of keys nobody listed is, definitionally, not something a field
 * assertion can cover.
 *
 * THE INVENTORY IS DERIVED, NOT GUESSED. It is every route that reads
 * `member.phone` or `member.name` and answers a merchant or scanner principal —
 * `routes/orders.ts:245`, `routes/salons.ts:1879`, `routes/bookings.ts:279`,
 * `services/memberSearch.ts` (both its search and its resolve) and
 * `routes/activity.ts:137`. Two of those five are NOT among #100's three, which
 * is the point of doing it this way:
 *
 *   GET /members?q=…    serves `phoneLast4`, not `phone` — four digits of a
 *                       tombstone are four digits, not a number. It passes, and
 *                       it is swept anyway: a future widening of that row to the
 *                       full phone would be caught here on the day it lands
 *                       rather than by the next person to walk into it.
 *   GET /members/{id}   serves `serialiseMember()`, which carries the FULL
 *                       phone. This is a FOURTH door and it is not in #100's
 *                       three. See the spec's own message.
 *
 * EVERY PROBE MUST CONTAIN HER, or it asserts nothing — `contract.test.ts`
 * rule 2, "no empty samples". A response she is absent from cannot fail this
 * scan and would report green for the wrong reason, so each entry declares the
 * string that proves she is in it and the sweep fails if she is not.
 */
describe('no merchant-facing response anywhere carries a dialable tombstone', () => {
  interface Surface {
    label: string;
    fetch: () => Promise<{ status: number; raw: string }>;
    /** Proof she is IN this response. Without it the scan is vacuous. */
    proof: () => string;
    /** Why this surface can carry her, for the reader of a red run. */
    why: string;
    /**
     * Set on a surface whose leak is a KNOWN, RECORDED, ESCALATED defect that is
     * deliberately not being fixed yet. Its spec is registered with `it.fails()`
     * instead of `it()`: green while the leak is there, RED the hour it closes.
     * The paragraph on the entry that sets it is the whole explanation.
     */
    knownOpenDefect?: true;
  }

  const surfaces = (): Surface[] => [
    {
      label: 'GET /v1/salons/:id/orders',
      fetch: () => treq('GET', `/v1/salons/${SALON_A}/orders`, { token: dashboard }),
      proof: () => HER_ORDER,
      why: 'the fulfilment board joins `member` live for memberName/memberPhone',
    },
    {
      label: 'GET /salons/:id/bookings',
      fetch: () => treq('GET', `/salons/${SALON_A}/bookings`, { token: dashboard }),
      proof: () => SALON_BOOKING,
      why: 'the merchant Appointments list joins `member` live for four columns',
    },
    {
      label: 'GET /artists/me/bookings',
      fetch: () => treq('GET', '/artists/me/bookings', { token: artistScanner }),
      proof: () => ARTIST_BOOKING,
      why: "the artist's own day joins `member` live, and renders Call AND WhatsApp",
    },
    /**
     * THE FOURTH DOOR IS OPEN, ON PURPOSE, AND THIS ENTRY IS THE ONE THAT SAYS SO
     * — DECISIONS.md #102.
     *
     * WHAT IS BROKEN. `GET /members/:id` is the scanner's manual-lookup RESOLVE,
     * and it serves `serialiseMember()`, which carries the member's FULL phone.
     * `resolveMember()` (`api/src/services/memberSearch.ts:436`) has no
     * `erasedAt` predicate at all, so an erased member resolves like any other
     * and her tombstone arrives at the till as a dialable number. It is worse
     * than a rendering problem: `charge.ts`, `charges.ts` and `counter.ts` carry
     * no erased check either, so the manual-lookup path can carry an erased
     * account all the way onto the charge screen — while `vouchers.ts:211`,
     * `adjustments.ts:165` and `accountResets.ts:137` each refuse an erased
     * member BY NAME. The three siblings agree with each other and this path
     * disagrees with all three.
     *
     * IT IS DELIBERATELY UNFIXED, PENDING A PRODUCT DECISION. Both candidate
     * fixes are decisions above this lane's pay grade, and neither is a QA call:
     *
     *   null the phone   `serialiseMember()` returns `MemberView`, and
     *                    `MemberSchema.phone` is a NON-NULLABLE `PhoneSchema` in
     *                    trunk-owned `packages/types`. Widening it to nullable is
     *                    a trunk operation and a four-way break — every surface
     *                    that reads a member has to handle the null.
     *   refuse the       Matching `vouchers`/`adjustments`/`accountResets` and
     *   resolve          404-ing an erased member changes MERCHANT BEHAVIOUR: a
     *                    lookup that used to answer now does not, and what the
     *                    till shows instead is a product question.
     *
     * Escalated to Aftab; trunk is recording it as DECISIONS.md #102.
     *
     * SO THE SPEC IS INVERTED, NOT DELETED AND NOT SOFTENED. `it.fails()` reports
     * a spec as PASSING when its body throws and FAILING when its body passes —
     * so this probe is green exactly while the leak it describes is real, and the
     * hour somebody closes the door it goes RED and drags a reader here. `dev`
     * goes green on a defect that is known, recorded and escalated rather than
     * silently red, and the fix cannot land quietly.
     *
     * WHEN THE FIX LANDS: delete `knownOpenDefect` from this entry. That is the
     * whole cleanup — the spec re-registers as a plain `it()` and the assertions
     * below, which are already written the way the contract should read, start
     * enforcing it. Do not weaken them; they are correct today.
     *
     * WHY AN INVERTED PROBE AND NOT A NOTE, WHICH IS THE POINT OF THE WHOLE
     * CONSTRUCT. Lane B wrote what it believed was the same guard — a scanner
     * test asserting the pre-fix behaviour under a comment promising "the day the
     * API changes, the line below fails and somebody reads this paragraph". It
     * cannot: it renders a HARDCODED CLIENT FIXTURE, so nothing the API does can
     * ever change its result, and it sailed green straight through lane A's
     * merge. A tripwire has to be wired to the thing it is watching. This one
     * drives the real endpoint against a really-erased member, which is what
     * makes the inversion mean anything.
     *
     * (Not `knownBug()` — that helper owns its own `it()` and cannot be applied
     * to one entry of a driven table without lifting this surface out of the
     * sweep, and being IN the sweep is the property that catches door number
     * five. Its stricter contract — only an AssertionError counts — is preserved
     * below by `requires()`, which is why the preconditions still bite here.)
     */
    {
      label: 'GET /members/:id',
      fetch: () => treq('GET', `/members/${HER}`, { token: staffScanner }),
      proof: () => HER,
      why:
        'the scanner RESOLVE serves serialiseMember(), full phone and all — A FOURTH ' +
        'DOOR, not one of the three DECISIONS.md #100 names',
      knownOpenDefect: true,
    },
    {
      label: 'GET /members?q=…',
      fetch: () =>
        treq('GET', `/members?q=${encodeURIComponent(TOMBSTONE_NAME)}`, { token: staffScanner }),
      proof: () => HER,
      why: 'the scanner member search matches her tombstone NAME and serves phoneLast4',
    },
    {
      label: 'GET /salons/:id/activity',
      fetch: () => treq('GET', `/salons/${SALON_A}/activity`, { token: dashboard }),
      proof: () => HER,
      why: 'the activity feed resolves a name for every member id in its two streams',
    },
  ];

  for (const surface of surfaces()) {
    /**
     * `it.fails` ONLY for the surface whose entry above explains why. Everything
     * else about the spec — title, fixture, both assertions — is identical, so
     * the inverted one is the same probe read the other way up rather than a
     * different, weaker probe.
     */
    const register = surface.knownOpenDefect ? it.fails : it;

    register(`${surface.label} — ${surface.why}`, async () => {
      /**
       * A PRECONDITION MUST NOT BE ABLE TO SATISFY `it.fails()`, which is the one
       * sharp edge of the construct and the reason `known-bug.ts` exists in the
       * form it does. `.fails` accepts ANY throw as the expected failure, so on
       * the inverted spec a 404, a dead server or a member who is simply absent
       * from the body would all be reported GREEN — the exact vacuity this
       * describe block refuses to tolerate everywhere else.
       *
       * So on the inverted spec a violated precondition RETURNS instead of
       * throwing. A body that completes normally is what `it.fails()` calls a
       * failure, so "nothing was scanned" goes red, which is what it deserves;
       * the reason is printed because vitest's own `.fails` message cannot carry
       * it. On the other five specs `requires()` throws exactly as before.
       */
      const requires = (ok: boolean, message: string): boolean => {
        if (ok) return true;
        if (!surface.knownOpenDefect) precondition(ok, message);
        console.error(
          `\n${surface.label} — THIS INVERTED SPEC SCANNED NOTHING, so its red is not the ` +
            `fourth door closing (DECISIONS.md #102). precondition failed: ${message}\n`,
        );
        return false;
      };

      const res = await surface.fetch();
      if (
        !requires(
          res.status === 200,
          `${surface.label} answered ${res.status} rather than 200, so nothing was scanned:\n` +
            res.raw,
        )
      ) {
        return;
      }

      /**
       * NON-VACUITY FIRST. A body she is not in cannot fail the scan below, and a
       * probe that cannot fail is worse than no probe — it is a green line in a
       * report about a leak.
       */
      const proof = surface.proof();
      if (
        !requires(
          res.raw.includes(proof),
          `${surface.label} does not mention "${proof}", so the erased member is not in this ` +
            `response and scanning it proves nothing. Fix the fixture or the probe — do not ` +
            `read this as a pass.`,
        )
      ) {
        return;
      }

      /**
       * THE EXACT NUMBER THE JOB MINTED. Asserted before the prefix, because it
       * is the assertion whose message names the member, and vitest stops at the
       * first failure — the order of two overlapping assertions decides which
       * diagnosis a reader gets. (`delivery-address-privacy.test.ts` makes the
       * same argument about its two address assertions.)
       */
      expect(
        res.raw.includes(mintedTombstone),
        `${surface.label} SERVES THE ERASED MEMBER'S TOMBSTONE NUMBER (${mintedTombstone}).\n\n` +
          'That number is not a leak of her real phone — it is a well-formed impossible one, ' +
          'minted by `tombstonePhone()` so the NOT NULL, E.164-CHECKed, per-salon-unique ' +
          'column can hold something after the scrub. The defect is that it is being ' +
          'PRESENTED AS A CONTACT: a merchant taps it, hears nothing, and learns nothing ' +
          'about why (DECISIONS.md #100).\n\n' +
          'The fix is an API signal, not a client guess: serve `memberErased: true` and ' +
          '`memberPhone: null`. If this endpoint is not one of the three #100 names, then ' +
          'THIS TEST HAS FOUND A FOURTH DOOR and it belongs to lane A — report it, do not ' +
          'patch the client.\n',
      ).toBe(false);

      /**
       * AND THE BARE PREFIX, which catches what the exact match cannot: a
       * DIFFERENT erased member reaching this surface — a second tombstone the
       * fixture never minted, from a previous run or another suite — and any
       * response that reconstructs the number rather than echoing it.
       */
      expect(
        res.raw.includes(TOMBSTONE_PREFIX),
        `${surface.label} carries a "${TOMBSTONE_PREFIX}" number that is NOT this fixture's ` +
          `(${mintedTombstone}). That is a second erased member reaching a merchant through ` +
          'this response — the same defect, a different customer. +990 is an unassigned ' +
          'country code and nothing legitimate in this product produces one.\n',
      ).toBe(false);
    });
  }

  /**
   * THE SWEEP IS ONLY WORTH ITS RUNTIME IF IT CAN FAIL, and "it scanned six
   * bodies and found nothing" is indistinguishable from "it scanned six empty
   * bodies". So the technique is proved against the row the scan is looking for:
   * the tombstone IS on disk, and a naive read of `member` does return it.
   *
   * This is the control. Without it, a `+990` that stopped being minted at all —
   * a scrub that started nulling the column, say, under a schema change — would
   * turn every spec above green while the erasure did something entirely
   * different from what this file believes.
   */
  it('the control: the tombstone number really is on disk to be leaked', () => {
    expect(
      mintedTombstone,
      'the erased member has no tombstone phone, so the six scans above were looking for ' +
        'something that does not exist and could not have failed',
    ).toMatch(/^\+990\d{12}$/);
    expect(
      scalar(`select name from member where id='${HER}'`).trim(),
      'she is not a tombstone at all — the scrub did not run on her',
    ).toBe(TOMBSTONE_NAME);
    expect(
      erasure?.erased,
      `the erasure job erased nobody: ${JSON.stringify(erasure)}`,
    ).toBeGreaterThanOrEqual(1);
    expect(erasure?.failed, `the job reported failures: ${JSON.stringify(erasure)}`).toBe(0);
  });
});

// ===========================================================================
// 3. THE INVENTORY — a NEW read of a member's phone must land somewhere
// ===========================================================================
/**
 * DECISIONS.md #100's actual sentence: "what nobody had was an inventory of
 * everything that READS a member after she is gone."
 *
 * § 2 drives the reads this file knows about. That closes today's class and not
 * tomorrow's: a sixth surface added next month is a surface § 2 does not call,
 * and a scan that is never run cannot fail. Three of the four consequences of
 * erasure so far were found by somebody WALKING INTO one, which is what a list
 * that only ever grows by hand looks like from the outside.
 *
 * So the list is DERIVED, off disk, the way `discoverGetRoutes` in
 * `support/contract-drift.ts` reads the route table and the way
 * `permission-census.test.ts` reads its gates: every place in `api/src` that
 * projects a member's phone into a response — `<key>: member.phone`, or
 * `<key>: m.phone` inside a serialiser — must appear below with an account of
 * where it surfaces. A new one lands in neither list and this spec goes red
 * NAMING THE FILE AND LINE, which is the whole difference between a list and a
 * habit.
 *
 * PROJECTIONS ONLY, and that is the discriminator that makes this cheap enough
 * to be exact. `eq(member.phone, phone)` in `routes/auth.ts` and
 * `routes/members.ts` is a LOOKUP — the number arrives from the caller and is
 * compared, never disclosed — and it is excluded by shape rather than by an
 * exemption somebody has to maintain. A hand-kept ledger of exceptions is what
 * rotted `DYNAMIC_PERMISSION` in `permission-census.test.ts` within a day.
 *
 * WHY PHONE AND NOT NAME. The tombstone NAME is the de-identified answer and is
 * meant to travel — "Deleted account" is what a merchant should read. Only the
 * phone is dialable, so only the phone is the leak, and a census over `name`
 * would be a list of every screen in the product.
 */
describe('the inventory — every projection of a member phone in api/src is accounted for', () => {
  /**
   * `file:line` → what reads it, and what bounds it.
   *
   * Each entry answers one question: when this response carries an ERASED
   * member, is the number she gets a dialable one? Anything answering "yes"
   * belongs in § 2's sweep and is named there too.
   */
  const ACCOUNTED: Record<string, string> = {
    'api/src/routes/orders.ts':
      "GET /v1/salons/{id}/orders — the fulfilment board's `memberPhone`. One of " +
      'DECISIONS.md #100\'s three. Swept in § 2, and its shape is pinned in ' +
      "contract.test.ts's `wireOnly`.",
    'api/src/routes/salons.ts':
      'GET /salons/{id}/bookings — the merchant Appointments row. One of #100\'s three. ' +
      'Swept in § 2; UNMODELLED in contract.test.ts, so this file is its only guard.',
    'api/src/routes/bookings.ts':
      "GET /artists/me/bookings — the artist's own day, Call AND WhatsApp. One of #100's " +
      'three, and the sharpest. Swept in § 2.',
    'api/src/routes/auth.ts':
      '`serialiseMember()`, which is the WHOLE member row — used by the wallet\'s own ' +
      'reads (hers, so not a disclosure) AND by `GET /members/{id}`, the scanner RESOLVE. ' +
      'That second caller is a FOURTH merchant-facing door and it is NOT in #100\'s three. ' +
      'Swept in § 2, where it currently fails.',
    'api/src/services/memberSearch.ts':
      'the scanner member search. It selects the full phone and then narrows it to ' +
      '`phoneLast4(r.phone)` before it leaves the service, so what reaches a merchant is ' +
      'four digits — not a number, not dialable. Swept in § 2 anyway, so the day that ' +
      'narrowing is widened this file notices rather than the next person to walk into it.',
  };

  it('no file projects a member phone without an entry above', () => {
    const roots = [join(repoRoot, 'api', 'src', 'routes'), join(repoRoot, 'api', 'src', 'services')];
    /**
     * `<key>: member.phone` or `<key>: m.phone`. A projection has a key; a
     * predicate does not.
     */
    const projection = /[A-Za-z0-9_]+\s*:\s*(?:member|m|r|row)\.phone\b/;

    const sites: string[] = [];
    for (const dir of roots) {
      for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.includes('.test.'))) {
        const rel = `${dir.slice(repoRoot.length + 1)}/${file}`.replace(/\\/g, '/');
        const source = readFileSync(join(dir, file), 'utf8');
        source.split('\n').forEach((line, i) => {
          if (projection.test(line)) sites.push(`${rel}:${i + 1}`);
        });
      }
    }

    /**
     * THE SCAN MUST FIND SOMETHING. A regex that silently stopped matching would
     * report an empty inventory as a clean one — `contract.test.ts`'s census
     * carries the same guard against its own route regex for the same reason.
     */
    expect(
      sites.length,
      'the projection scan found NOTHING, which cannot be true — the fulfilment board ' +
        'demonstrably serves a phone. The regex has stopped matching, and an empty ' +
        'inventory reads exactly like a clean one.',
    ).toBeGreaterThanOrEqual(4);

    const unaccounted = [...new Set(sites.map((s) => s.split(':')[0]!))].filter(
      (f) => !(f in ACCOUNTED),
    );
    expect(
      unaccounted,
      `${unaccounted.join(', ')} projects a member's phone into a response and is in ` +
        'neither this inventory nor § 2\'s sweep.\n\n' +
        'A NEW READ OF A MEMBER IS A NEW PLACE THE TOMBSTONE CAN SURFACE. That is the ' +
        'whole finding of DECISIONS.md #100 — the scrub was correct three times running ' +
        'and what was missing was the list. Add the site here with an account of where it ' +
        'surfaces, and if the answer is "a merchant sees it", add it to § 2 as well: an ' +
        'entry here without a driven scan is a note, not a guard.\n\n' +
        `Found: ${sites.join(', ')}\n`,
    ).toEqual([]);

    /**
     * AND THE OTHER DIRECTION, so the inventory cannot become the place a
     * deleted read goes to be remembered for ever. `wireOnly`'s staleness check
     * in `contract.test.ts` makes exactly this argument.
     */
    const files = new Set(sites.map((s) => s.split(':')[0]!));
    const stale = Object.keys(ACCOUNTED).filter((f) => !files.has(f));
    expect(
      stale,
      `${stale.join(', ')} no longer projects a member's phone, so its entry above is ` +
        'stale. Remove it — and check § 2, which is probably still driving a surface ' +
        'that cannot carry her any more.',
    ).toEqual([]);
  });
});
