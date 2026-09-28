/**
 * DEPOSIT HEALTH — `GET /salons/{id}/deposits`, driven end to end.
 *
 * HOW TO RUN
 *
 *   pnpm --dir <worktree>/packages/types run build
 *   cd e2e && ../node_modules/.bin/vitest run deposit-health.test.ts
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS, GIVEN `api/src/routes/deposits.int.test.ts` ALREADY DOES
 * ---------------------------------------------------------------------------
 * Lane A's eight int specs drive the gate, the two tenancy doors, the held total,
 * the three states, the walk-in and the no-show count through `app.inject()` with
 * a session minted in-process. They are the right specs at that layer and this
 * file does not repeat them.
 *
 * What is NOT asserted anywhere is the set below, and every item on it is a thing
 * that rots quietly rather than loudly:
 *
 *   1  the PERMITTED cross-tenant call. A 403 on salon A's id says the path guard
 *      fires; it says nothing about whether salon B's own 200 carries salon B's
 *      money. An aggregate leak has no telltale string in it, so the generic
 *      `expectNoSalonALeak` sweep in tenancy.test.ts cannot see one either.
 *   2  that the three states PARTITION the overdue set — and specifically whether
 *      lane A's stated reason for that ("two CHECK constraints rather than an
 *      assumption about how the write path happens to behave today") is true. It
 *      is verified here rather than restated, and § THE PARTITION is what came of
 *      verifying it.
 *   3  the 200-row cap: that `overdue.bookings` and `rows.length` are ALLOWED to
 *      disagree, and that `rowsTruncated` is what says so.
 *   4  `starts_at ASC` — a queue and never a ranking of people.
 *   5  `noShowCount` being ABSENT from the customer LIST. That is a privacy
 *      decision somebody could undo in one line, with no test anywhere going red.
 *
 * ---------------------------------------------------------------------------
 * THE FIXTURES ARE INSERTS, AND SALON B'S ARE MONEYLESS
 * ---------------------------------------------------------------------------
 * Written with SQL rather than through `POST /bookings`, for the reason
 * `deposit.test.ts` records at length: the customer path validates `startsAt`
 * against `computeAvailability`, which would pin these specs to one artist's
 * published window on one weekday. The rows written here are the rows that path
 * writes — the `deposit_hold` transaction, the balanced ledger pair, the wallet
 * debit, and the booking pointing at the hold.
 *
 * EVERY MEMBER IS FUNDED THROUGH THE LEDGER. `db:verify`'s invariant 5 is
 * `member.balance_fils = sum(member_wallet entries)`, and the wallet census in
 * `support/global-setup.ts` measures it at the end of every run. A fixture that
 * sets a balance and walks away breaks it by exactly the opening amount.
 *
 * NOT ONE `transaction` ROW IS WRITTEN AT SAL-LUMIERE. `services/metrics.int.test.ts`
 * asserts, with a message naming the cause, that SAL-LUMIERE holds no `transaction`
 * and no `booking` outside its own `IT-*` prefix — and `ledger_entry` is append-only
 * at the ROLE level (migration 0038), so a transaction written there could not be
 * taken back. Salon B's fixtures are therefore walk-ins: zero deposit, no hold, no
 * ledger. `booking_merchant_is_zero_deposit` and `booking_deposit_matches_hold`
 * make those three the same fact, which is also what makes § THE WALK-IN's claim
 * checkable at all.
 *
 * ITS OWN BRANCH, TWICE. Every figure this endpoint serves is a salon-wide
 * aggregate, so an absolute assertion against the shared seed would be an
 * assertion about whatever else happens to be in the table that minute. Two
 * branches of this file's own make the expected numbers EXACT — 15.000 KD held on
 * one, 201 overdue rows on the other — which is what makes them fail when the
 * arithmetic is mutated. The tenancy specs deliberately do NOT use a branch: a
 * cross-tenant leak hidden behind a branch filter would be invisible.
 *
 * ITS OWN ARTISTS. `booking_artist_slot_no_overlap` is an EXCLUDE over
 * `(artist_id, tstzrange(starts_at, ends_at))` spanning every live status, so two
 * files sharing an artist share a slot space. Three artists minted per run — one
 * per branch at salon A, one at salon B — give this file a slot space nothing
 * else can be standing in.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  A_MEMBER_NAME,
  A_MEMBER_PHONE,
  B_BRANCH,
  B_SERVICE,
  B_STAFF_HANDLE,
  SALON_A,
  SALON_B,
  psql,
  reconcileWalletLedger,
  retireBranches,
  scalar,
  signInDashboard,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

/**
 * Noura — salon A's manager, every permission on. `api/src/db/seed.ts` § ST-001.
 *
 * NOT IMPORTED, because the harness exports the staff ID and not the handle, and
 * `signInDashboard` signs in by handle. `deposit.test.ts` keeps the same local
 * const for the same reason.
 *
 * THE MANAGER AND NOT HESSA, DELIBERATELY. The front desk (`ST-002`) holds
 * `appointments` and is the person this endpoint was built for — lane A's int
 * spec 2 is the one that proves she is let in. She also has
 * `branch_access_all = false`, so using her here would mix a branch-access
 * question into every figure assertion in this file. The gate is driven where the
 * gate lives; this file is about the answer.
 */
const A_MANAGER_HANDLE = 'noura';

/** Salon A, the exact-figures branch. Four held bookings and nothing else. */
const BRANCH = `DH-QA-BR-${RUN}`;
const ARTIST = `DH-QA-AR-${RUN}`;
const SERVICE = `DH-QA-SV-${RUN}`;

/** Salon A, the cap branch. `DEPOSIT_ROWS_MAX + 1` overdue walk-ins and nothing else. */
const CAP_BRANCH = `DH-QA-CAPBR-${RUN}`;
const CAP_ARTIST = `DH-QA-CAPAR-${RUN}`;

/** Salon B's artist. Salon B seeds none — see `seedSalonB()` — and needs one to join. */
const LUM_ARTIST = `DH-QA-LAR-${RUN}`;

/**
 * `DEPOSIT_ROWS_MAX` in `api/src/services/depositHealth.ts`, restated here rather
 * than imported.
 *
 * DELIBERATELY NOT IMPORTED, and this is the one constant in this file that is
 * better duplicated. The cap is a CONTRACT — "the row list is a page of evidence
 * and `overdue.bookings` is the authority" — and a spec that read the number out
 * of the implementation would keep passing if somebody changed it to 20, which is
 * precisely the payload regression the flag exists to make visible. A literal
 * fails, names the new number, and makes moving it a deliberate act.
 */
const ROWS_MAX = 200;

const BK_AWAIT = `DH-QA-BK-AWAIT-${RUN}`;
const BK_RETURN = `DH-QA-BK-RETURN-${RUN}`;
const BK_UNCLOSED = `DH-QA-BK-UNCLOSED-${RUN}`;
const BK_FUTURE = `DH-QA-BK-FUTURE-${RUN}`;

const AWAIT_FILS = 5_000;
const RETURN_FILS = 7_000;
const FUTURE_FILS = 3_000;
const HELD_FILS = AWAIT_FILS + RETURN_FILS + FUTURE_FILS;
const OVERDUE_FILS = AWAIT_FILS + RETURN_FILS;

/**
 * NAMES CHOSEN SO ALPHABETICAL ORDER AND TIME ORDER DISAGREE.
 *
 * `rows` is `starts_at ASC`. In time order the three overdue rows read Zahra,
 * Amal, Mariam; by name they would read Amal, Mariam, Zahra; by member id the
 * walk-in has none at all. A fixture whose three names happened to sort the same
 * way as its three slots would make § THE QUEUE green under `ORDER BY member.name`,
 * which is the exact ordering the endpoint's header forbids.
 */
const NAME_AWAIT = `Mariam QA ${RUN}`;
const NAME_RETURN = `Amal QA ${RUN}`;
const NAME_GUEST = `Zahra Walk-in ${RUN}`;

/** The member § THE COUNT reads a card for. Nothing else touches her. */
const HISTORY_MEMBER = `DH-QA-HIST-${RUN}`;
const NAME_HISTORY = `Noor QA ${RUN}`;

/** The scheduled booking's member. Never in the row list — her slot has not started. */
const NAME_FUTURE = `Sara QA ${RUN}`;

/** Salon B's two held walk-ins — one in each of the two states a guest can reach. */
const BK_LUM_UNCLOSED = `DH-QA-BK-LUM-UNCLOSED-${RUN}`;
const BK_LUM_AWAIT = `DH-QA-BK-LUM-AWAIT-${RUN}`;
const NAME_LUM_GUEST = `Lumiere Walk-in ${RUN}`;

/**
 * The row § THE PARTITION inserts to test lane A's stated reason, and then
 * deletes. Named so `afterAll` sweeps it even if the spec dies holding it.
 */
const BK_ADVERSARIAL = `DH-QA-BK-ADVERSARIAL-${RUN}`;

let manager = '';
let lumiereManager = '';

let awaitMember = '';
let returnMember = '';
let futureMember = '';

// ---------------------------------------------------------------- fixtures --

/** `minutes` from now as a Postgres expression. Negative is the past. */
const t = (minutes: number): string => `now() + interval '${minutes} minutes'`;

/**
 * A per-run counter behind every minted id.
 *
 * IT WAS `id.slice(-12)` AND THAT COLLIDED ON THE FIRST RUN. `RUN` is ten
 * characters, so every member id ends `<letter>-<RUN>` and the last twelve
 * characters of `DH-QA-AWAIT-<RUN>` and `DH-QA-HIST-<RUN>` are the same twelve —
 * `transaction_pkey`, on the fourth customer. A counter cannot do that, and it
 * keeps the ids short enough to read in a failure message.
 */
let mintSeq = 0;
const mint = (prefix: string): string => `${prefix}-${RUN}-${String(mintSeq++).padStart(3, '0')}`;

let phoneSeq = 0;
/** A phone nothing else in the suite can be holding. `member_phone_salon_uq`. */
const phone = (): string => `+9657${String(4_000_000 + Date.now() % 1_000_000 + phoneSeq++).slice(0, 7)}`;

/**
 * A customer funded THROUGH THE LEDGER, for the reason the header gives.
 *
 * The opening pair is `member_wallet` credit against `gateway_clearing` debit —
 * the shape `POST /topups` writes — so the row this file leaves behind reconciles
 * without `reconcileWalletLedger` having to paper over it afterwards.
 */
function customer(id: string, name: string, openingFils: number): string {
  const tx = mint('TX-DHQAOPEN');
  psql(`
    INSERT INTO member (id, salon_id, name, phone, email, email_verified, password_hash,
                        balance_fils, visits, tier, stamps, policy_version)
    VALUES ('${id}', '${SALON_A}', '${name}', '${phone()}', NULL, false,
            '$argon2id$fixture-not-a-credential', ${openingFils}, 0, 'bronze', NULL, 3);

    INSERT INTO "transaction"
      (id, member_id, salon_id, branch_id, kind, amount_fils, status, reference, note,
       created_at, settled_at)
    VALUES ('${tx}', '${id}', '${SALON_A}', 'BR-SAL', 'adjustment', ${openingFils}, 'settled',
            'AVO-OPEN-${id}', 'Deposit-health fixture opening balance', now(), now());

    INSERT INTO ledger_entry
      (transaction_id, salon_id, member_id, account, direction, amount_fils, balance_after_fils)
    VALUES
      ('${tx}', '${SALON_A}', '${id}', 'member_wallet', 'credit', ${openingFils}, ${openingFils}),
      ('${tx}', '${SALON_A}', NULL, 'gateway_clearing', 'debit', ${openingFils}, NULL);
  `);
  return id;
}

/**
 * A REAL `app` BOOKING with a hold behind it.
 *
 * `no_show_return_due_at` IS STAMPED `ends_at + 60`, which is salon A's seeded
 * `no_show_return_minutes`, exactly as `services/booking.ts` stamps it at all four
 * of its write sites. A fixture that invented a deadline would be testing this
 * file's arithmetic rather than the product's — and § THE PARTITION, which is
 * about precisely that stamping rule, would be asserting against itself.
 *
 * THE MONEY LANDS ON `BR-SAL`, NOT ON THIS FILE'S BRANCH. `transaction.branch_id`
 * is `ON DELETE restrict` and nothing in `avo_app` may delete a `ledger_entry`
 * (migration 0038), so a transaction against the fixture branch would pin that
 * branch in the table for ever and `afterAll` could not give it back. The endpoint
 * reads `booking.branch_id` and never the transaction's, so the split costs the
 * specs nothing.
 */
function heldWithDeposit(
  id: string,
  memberId: string,
  startsMin: number,
  durationMin: number,
  depositFils: number,
): void {
  const hold = mint('TX-DHQAHOLD');
  psql(`
    INSERT INTO "transaction"
      (id, member_id, salon_id, branch_id, kind, amount_fils, method, status, reference,
       created_at, settled_at)
    VALUES ('${hold}', '${memberId}', '${SALON_A}', 'BR-SAL', 'deposit_hold', ${-depositFils},
            'wallet', 'settled', 'AVO-DEP-${hold.slice(3)}', now(), now());

    UPDATE member SET balance_fils = balance_fils - ${depositFils} WHERE id = '${memberId}';

    INSERT INTO ledger_entry
      (transaction_id, salon_id, member_id, account, direction, amount_fils, balance_after_fils)
    VALUES
      ('${hold}', '${SALON_A}', '${memberId}', 'member_wallet', 'debit', ${depositFils},
       (SELECT balance_fils FROM member WHERE id = '${memberId}')),
      ('${hold}', '${SALON_A}', NULL, 'deposit_held', 'credit', ${depositFils}, NULL);

    INSERT INTO booking
      (id, salon_id, branch_id, branch_assumed, member_id, artist_id, service_id,
       starts_at, ends_at, duration_min, deposit_fils, status, source,
       hold_transaction_id, settled_transaction_id, no_show_return_due_at)
    VALUES ('${id}', '${SALON_A}', '${BRANCH}', false, '${memberId}', '${ARTIST}', '${SERVICE}',
            ${t(startsMin)}, ${t(startsMin + durationMin)}, ${durationMin},
            ${depositFils}, 'deposit_held', 'app', '${hold}', NULL,
            ${t(startsMin + durationMin + 60)});
  `);
}

/**
 * A WALK-IN the front desk wrote down. Zero deposit, no hold, no member.
 *
 * `booking_merchant_is_zero_deposit`, `booking_deposit_matches_hold` and
 * `booking_identity_exactly_one` together make "merchant-written", "no money" and
 * "no member" one fact — which is what § THE WALK-IN's claim rests on, and which
 * that describe proves by trying to write the row the constraints forbid.
 */
function heldGuest(
  id: string,
  startsMin: number,
  durationMin: number,
  opts: {
    salonId?: string;
    branchId?: string;
    artistId?: string;
    serviceId?: string;
    guestName?: string;
    dueMin?: number;
  } = {},
): void {
  const salonId = opts.salonId ?? SALON_A;
  const branchId = opts.branchId ?? BRANCH;
  const artistId = opts.artistId ?? ARTIST;
  const serviceId = opts.serviceId ?? SERVICE;
  const due = opts.dueMin ?? startsMin + durationMin + 60;
  psql(`
    INSERT INTO booking
      (id, salon_id, branch_id, branch_assumed, member_id, guest_name, guest_phone,
       artist_id, service_id, starts_at, ends_at, duration_min, deposit_fils,
       status, source, hold_transaction_id, settled_transaction_id, no_show_return_due_at)
    VALUES ('${id}', '${salonId}', '${branchId}', false, NULL,
            '${opts.guestName ?? NAME_GUEST}', '+96550009${String(phoneSeq++ % 1000).padStart(3, '0')}',
            '${artistId}', '${serviceId}',
            ${t(startsMin)}, ${t(startsMin + durationMin)}, ${durationMin},
            0, 'deposit_held', 'merchant', NULL, NULL, ${t(due)});
  `);
}

/**
 * A RESOLVED, MONEYLESS booking for a member — the shape § THE COUNT counts.
 *
 * Zero-deposit `merchant` rows, so no hold and no ledger: with
 * `hold_transaction_id IS NULL` the state machine's ELSE branch requires only that
 * `settled_transaction_id` be NULL too, which is what lets a terminal row exist
 * here without inventing a `deposit_return` nobody paid.
 */
function resolved(
  id: string,
  memberId: string,
  status: 'no_show_returned' | 'cancelled' | 'completed',
  startsMin: number,
): void {
  const stamp =
    status === 'no_show_returned'
      ? 'returned_at'
      : status === 'cancelled'
        ? 'cancelled_at'
        : 'completed_at';
  psql(`
    INSERT INTO booking
      (id, salon_id, branch_id, branch_assumed, member_id, artist_id, service_id,
       starts_at, ends_at, duration_min, deposit_fils, status, source,
       hold_transaction_id, settled_transaction_id, no_show_return_due_at, ${stamp})
    VALUES ('${id}', '${SALON_A}', '${BRANCH}', false, '${memberId}', '${ARTIST}', '${SERVICE}',
            ${t(startsMin)}, ${t(startsMin + 30)}, 30, 0, '${status}', 'merchant',
            NULL, NULL, ${t(startsMin + 90)}, now());
  `);
}

// ------------------------------------------------------------------- reads --

interface DepositRow {
  bookingId: string;
  state: 'awaiting_arrival' | 'return_overdue' | 'unclosed';
  memberId: string | null;
  memberName: string | null;
  memberErased: boolean;
  memberPhone: string | null;
  guestName: string | null;
  guestPhone: string | null;
  artistId: string;
  artistName: string;
  serviceName: string;
  branchId: string;
  branchName: string;
  branchAssumed: boolean;
  startsAt: string;
  endsAt: string;
  durationMin: number;
  depositFils: number;
  noShowReturnDueAt: string;
  source: string;
  overdueMinutes: number;
  returnOverdueMinutes: number | null;
}

interface DepositHealth {
  asOf: string;
  held: { bookings: number; fils: number; branchAssumed: number | null };
  scheduled: { bookings: number; fils: number };
  overdue: {
    bookings: number;
    fils: number;
    oldestStartedAt: string | null;
    branchAssumed: number | null;
    awaitingArrival: { bookings: number; fils: number };
    returnOverdue: { bookings: number; fils: number; dueSince: string | null };
    unclosed: { bookings: number; oldestStartedAt: string | null };
  };
  rows: DepositRow[];
  rowsTruncated: boolean;
  branchId: string | null;
  branchName: string | null;
}

/**
 * `GET /salons/{id}/deposits`, with the token that makes the answer a 200.
 *
 * `branch: null` asks SALON-WIDE, which is what the tenancy specs need and what
 * every other spec here must not use.
 */
async function deposits(
  opts: { token?: string; salonId?: string; branch?: string | null; extraQuery?: string } = {},
): Promise<{ status: number; body: DepositHealth; raw: string }> {
  const branch = opts.branch === undefined ? BRANCH : opts.branch;
  const qs = [
    branch === null ? '' : `branch=${encodeURIComponent(branch)}`,
    opts.extraQuery ?? '',
  ]
    .filter(Boolean)
    .join('&');
  const res = await treq<DepositHealth>(
    'GET',
    `/salons/${opts.salonId ?? SALON_A}/deposits${qs === '' ? '' : `?${qs}`}`,
    { token: opts.token ?? manager },
  );
  return { status: res.status, body: res.body, raw: res.raw };
}

/** The 200 body, or a failure that says what came back instead. */
async function health(
  opts: Parameters<typeof deposits>[0] = {},
): Promise<DepositHealth> {
  const res = await deposits(opts);
  if (res.status !== 200) {
    throw new Error(
      `GET /salons/.../deposits answered ${res.status}, so this spec never reached its ` +
        `question: ${res.raw.slice(0, 400)}`,
    );
  }
  return res.body;
}

const rowFor = (b: DepositHealth, id: string): DepositRow => {
  const row = b.rows.find((r) => r.bookingId === id);
  if (!row) {
    throw new Error(
      `${id} is not in the row list, so nothing below is asserting what it says it is. ` +
        `The list held: ${b.rows.map((r) => r.bookingId).join(', ') || '(nothing)'}`,
    );
  }
  return row;
};

/**
 * The answer with everything that is a function of `now` removed.
 *
 * FOR COMPARING TWO READS, AND THE LIST IS EXACTLY THREE FIELDS. `asOf`,
 * `overdueMinutes` and `returnOverdueMinutes` are computed against the instant the
 * request arrived, so two calls fifty milliseconds apart legitimately disagree
 * whenever they straddle a minute boundary — `floor((now - starts_at) / 60)` is 44
 * on one side of it and 45 on the other. A deep-equal over the whole body would
 * therefore be a spec that fails roughly one run in four hundred for a reason that
 * is not a defect, which is the kind of flake that gets a real failure waved
 * through as "that one again".
 *
 * NOTHING ELSE IS DROPPED, AND THAT IS THE POINT. Every count, every sum, every
 * stored instant, every booking id, the order, the branch and `rowsTruncated` all
 * stay in the comparison. The three that leave are compared separately and to the
 * minute, which is the strongest true statement available about two reads of a
 * moving clock.
 */
const settled = (b: DepositHealth) => {
  const { asOf: _asOf, rows, ...rest } = b;
  return {
    ...rest,
    rows: rows.map(({ overdueMinutes: _o, returnOverdueMinutes: _r, ...row }) => row),
  };
};

const num = (sql: string): number => Number(scalar(sql));

// -------------------------------------------------------------- lifecycle --

beforeAll(async () => {
  await startTenancyApi();

  /**
   * NO `branch_id` ON ANY ARTIST. `artist.branch_id` is nullable and every
   * multi-branch roster is left that way by migration 0044, so leaving it null
   * means the only rows referencing this file's branches are its own bookings —
   * which is what lets `afterAll` give the branches back. A fixture branch that
   * outlives its file changes `resolveBranch` from "established" to "assumed" for
   * every later charge in the salon.
   */
  psql(`
    INSERT INTO branch (id, salon_id, name) VALUES
      ('${BRANCH}',     '${SALON_A}', 'QA Deposit Health ${RUN}'),
      ('${CAP_BRANCH}', '${SALON_A}', 'QA Deposit Cap ${RUN}');

    INSERT INTO artist (id, salon_id, name) VALUES
      ('${ARTIST}',     '${SALON_A}', 'QA DH Artist ${RUN}'),
      ('${CAP_ARTIST}', '${SALON_A}', 'QA DH Cap Artist ${RUN}'),
      ('${LUM_ARTIST}', '${SALON_B}', 'QA DH Lumiere Artist ${RUN}');

    INSERT INTO service (id, salon_id, name, price_fils)
    VALUES ('${SERVICE}', '${SALON_A}', 'QA DH Service ${RUN}', 8000);

    -- SHE DOES IT (migration 0061). This artist and this service are both created
    -- after the seed and 0062 assigned everyone to everything, so they are linked to
    -- nothing — and the write-path spec's POST /salons/{id}/bookings is refused
    -- 409 artist_not_assigned, which is the new rule working rather than a deposit
    -- regression. Only the one pair the API books; the SQL-inserted rows below never
    -- pass the check and CAP_ARTIST is never booked through the API. The row goes with
    -- the artist in afterAll: artist_service cascades from both sides.
    INSERT INTO artist_service (artist_id, service_id, salon_id)
    VALUES ('${ARTIST}', '${SERVICE}', '${SALON_A}');
  `);

  awaitMember = customer(`DH-QA-AWAIT-${RUN}`, NAME_AWAIT, 150_000);
  returnMember = customer(`DH-QA-RETURN-${RUN}`, NAME_RETURN, 150_000);
  futureMember = customer(`DH-QA-FUTURE-${RUN}`, NAME_FUTURE, 150_000);
  customer(HISTORY_MEMBER, NAME_HISTORY, 150_000);

  /**
   * THE FOUR HELD ROWS ON THE EXACT-FIGURES BRANCH. Spaced so no two overlap on
   * the one artist — `booking_artist_slot_no_overlap` spans every kind of
   * appointment, completed ones included.
   *
   *   -45m   slot started, deadline 45 minutes away, 5.000 held  → awaiting_arrival
   *   -480m  deadline passed 6.5h ago, 7.000 still held          → return_overdue
   *   -600m  deadline passed, zero deposit, nothing owed         → unclosed
   *   +300m  not started, 3.000 held                             → scheduled
   */
  heldWithDeposit(BK_AWAIT, awaitMember, -45, 30, AWAIT_FILS);
  heldWithDeposit(BK_RETURN, returnMember, -480, 30, RETURN_FILS);
  heldGuest(BK_UNCLOSED, -600, 30);
  heldWithDeposit(BK_FUTURE, futureMember, 300, 30, FUTURE_FILS);

  /**
   * THE CAP BRANCH — `ROWS_MAX + 1` overdue walk-ins, so the count and the row
   * array are forced to disagree by exactly one.
   *
   * ONE MORE THAN THE CAP AND NOT A HUNDRED MORE. The interesting failure is the
   * off-by-one — a `>=` where the code wants `>` — and a fixture at 300 would pass
   * over it. Every row is `unclosed`: three minutes apart, two minutes long, and
   * far enough back that the newest deadline (`ends_at + 60`) has already passed,
   * so a slow run cannot let the youngest of them drift into `awaiting_arrival`
   * and change the state mix under the spec.
   */
  psql(`
    INSERT INTO booking
      (id, salon_id, branch_id, branch_assumed, member_id, guest_name, guest_phone,
       artist_id, service_id, starts_at, ends_at, duration_min, deposit_fils,
       status, source, hold_transaction_id, settled_transaction_id, no_show_return_due_at)
    SELECT 'DH-QA-BK-CAP-${RUN}-' || lpad(i::text, 4, '0'),
           '${SALON_A}', '${CAP_BRANCH}', false, NULL,
           'QA Cap Walk-in ' || lpad(i::text, 4, '0'), NULL,
           '${CAP_ARTIST}', '${SERVICE}',
           now() - ((200 + i * 3) || ' minutes')::interval,
           now() - ((198 + i * 3) || ' minutes')::interval,
           2, 0, 'deposit_held', 'merchant', NULL, NULL,
           now() - ((138 + i * 3) || ' minutes')::interval
      FROM generate_series(0, ${ROWS_MAX}) AS i;
  `);

  /**
   * SALON B'S OWN HELD ROWS. Moneyless, for the header's reason, and there are
   * TWO of them in TWO states so that her answer is a populated one.
   *
   * A TENANCY SPEC AGAINST A SALON WITH NOTHING IN IT PROVES NOTHING — it cannot
   * tell "the predicate scoped the read" from "there was nothing to read". These
   * two give salon B a non-zero count, a non-null `oldestStartedAt` of her own,
   * and a row list with her own ids in it, all of which are different from salon
   * A's and all of which change if the salon term is dropped.
   */
  heldGuest(BK_LUM_UNCLOSED, -120, 30, {
    salonId: SALON_B,
    branchId: B_BRANCH,
    artistId: LUM_ARTIST,
    serviceId: B_SERVICE,
    guestName: NAME_LUM_GUEST,
  });
  heldGuest(BK_LUM_AWAIT, -20, 30, {
    salonId: SALON_B,
    branchId: B_BRANCH,
    artistId: LUM_ARTIST,
    serviceId: B_SERVICE,
    guestName: NAME_LUM_GUEST,
  });

  /**
   * § THE COUNT's history. Two returned no-shows, one cancellation and one
   * completion — the cancellation is the one that matters, because counting it
   * would punish the considerate thing to do.
   */
  resolved(`DH-QA-BK-NS1-${RUN}`, HISTORY_MEMBER, 'no_show_returned', -3000);
  resolved(`DH-QA-BK-NS2-${RUN}`, HISTORY_MEMBER, 'no_show_returned', -3200);
  resolved(`DH-QA-BK-CAN-${RUN}`, HISTORY_MEMBER, 'cancelled', -3400);
  resolved(`DH-QA-BK-CMP-${RUN}`, HISTORY_MEMBER, 'completed', -3600);

  manager = await signInDashboard(SALON_A, A_MANAGER_HANDLE);
  lumiereManager = await signInDashboard(SALON_B, B_STAFF_HANDLE);
}, 180_000);

/**
 * THIS FILE TAKES ITS OWN ROWS BACK, and the order matters: bookings, then the
 * artists and the service nothing points at any more, then the branches.
 *
 * `ledger_entry` is append-only at the role level and every pair written above is
 * balanced, so what is left behind still satisfies `db:verify` invariant 5 — the
 * members keep their holds and their opening credits, and the wallet census at the
 * end of the run reconciles them without a repair transaction.
 */
afterAll(async () => {
  psql(`DELETE FROM booking WHERE id LIKE 'DH-QA-BK-%${RUN}%' OR id LIKE 'DH-QA-BK-CAP-${RUN}-%';`);
  /**
   * AND LEAVE EVERY MEMBER THIS FILE MINTED RECONCILING TO HER WALLET LEDGER.
   *
   * A NO-OP IN THE HEALTHY CASE, WHICH IS WHY IT IS HERE ANYWAY. `customer()` and
   * `heldWithDeposit()` write balanced pairs, so `reconcileWalletLedger` finds a
   * difference of zero and writes nothing. What it covers is the unhealthy case:
   * `beforeAll` dying between the member INSERT and the ledger INSERT leaves a
   * balance with no originating entry, and the wallet census then fails the WHOLE
   * RUN after teardown with a message about a member nobody can associate with the
   * spec that died. Measured on this file's first run, on a colliding transaction
   * id — the fixture fault cost one red suite and one red census, and only one of
   * the two was about the fault.
   *
   * AFTER the deletes and never before: the deletes do not touch money, but the
   * ordering is `deposit.test.ts`'s rule — the reconcile answers for every write
   * above it.
   */
  for (const [id, tag] of [
    [awaitMember, 'DHQAA'],
    [returnMember, 'DHQAR'],
    [futureMember, 'DHQAF'],
    [HISTORY_MEMBER, 'DHQAH'],
  ] as const) {
    if (id) reconcileWalletLedger(id, tag);
  }
  psql(`
    DELETE FROM artist  WHERE id IN ('${ARTIST}', '${CAP_ARTIST}', '${LUM_ARTIST}');
    DELETE FROM service WHERE id = '${SERVICE}';
  `);
  retireBranches(SALON_A, [BRANCH, CAP_BRANCH]);
  await stopTenancyApi();
});

// =========================================================================
describe('deposit health · the shape of the answer', () => {
  it('the exact-figures branch reports what this file put on it, and nothing else', async () => {
    const b = await health();

    expect(b.branchId).toBe(BRANCH);
    expect(b.branchName).toBe(`QA Deposit Health ${RUN}`);
    expect(b.held.bookings, 'the branch holds four bookings').toBe(4);
    expect(b.held.fils, 'held is 15.000 KD in integer fils').toBe(HELD_FILS);
    expect(b.scheduled).toEqual({ bookings: 1, fils: FUTURE_FILS });
    expect(b.overdue.bookings).toBe(3);
    expect(b.overdue.fils).toBe(OVERDUE_FILS);
    expect(b.rows).toHaveLength(3);
    expect(b.rowsTruncated).toBe(false);
  });

  it('`asOf` is the instant the figures were computed against, not a day boundary', async () => {
    const before = Date.now();
    const b = await health();
    const after = Date.now();
    const asOf = Date.parse(b.asOf);
    expect(Number.isFinite(asOf), `asOf did not parse: ${b.asOf}`).toBe(true);
    /**
     * WITHIN THE CALL, WHICH IS THE CLAIM. `/metrics` computes against the salon's
     * MIDNIGHT and this endpoint deliberately has no day bound at all — the route
     * header says so and says why the salon's timezone is never read. An `asOf`
     * that landed on a midnight would be the tell that a day bound had crept in.
     */
    expect(asOf).toBeGreaterThanOrEqual(before - 2_000);
    expect(asOf).toBeLessThanOrEqual(after + 2_000);
  });

  it('`?period=` changes nothing — this is a stock, not a flow', async () => {
    /**
     * THE ROUTE HEADER'S CLAIM, DRIVEN. `?period=` is not refused, it is INERT:
     * Fastify drops an unknown query parameter, so the honest assertion is that the
     * answer is the same answer. Every figure here is "what is held RIGHT NOW", so
     * a window has nothing to select — and the failure this guards is somebody
     * later WIRING `?period=` to filter `starts_at`, which would serve "deposits
     * held today for bookings whose slot was in March" under a label reading
     * "March's deposit health".
     *
     * `settled()` is what both sides go through, and its docblock is the accounting
     * for the three fields it drops. THIS PARAGRAPH USED TO SAY "`asOf` is dropped
     * from both sides and only `asOf`", which was true for about an hour and then
     * was not: `overdueMinutes` is `floor((now - starts_at) / 60)` and two calls
     * fifty milliseconds apart straddle a minute boundary often enough to matter.
     * Corrected rather than deleted, because the sentence it replaces is the one a
     * reader would otherwise trust over the helper four screens up.
     */
    const plain = await health();
    const windowed = await health({ extraQuery: 'period=2026-03-01_2026-03-31' });
    expect(
      settled(windowed),
      '`?period=` moved a figure. It is a stock, not a flow — see the route header.',
    ).toEqual(settled(plain));

    /**
     * AND THE THREE FIELDS `settled()` DROPPED ARE STILL COMPARED, LOOSELY.
     * Dropping a field to make a comparison stable is how a comparison stops
     * comparing; these are checked to the minute instead of to the millisecond,
     * which is all that can honestly be asserted of two reads of a moving clock.
     */
    expect(Math.abs(Date.parse(windowed.asOf) - Date.parse(plain.asOf))).toBeLessThan(60_000);
    for (const row of windowed.rows) {
      const twin = plain.rows.find((r) => r.bookingId === row.bookingId)!;
      expect(Math.abs(row.overdueMinutes - twin.overdueMinutes)).toBeLessThanOrEqual(1);
    }
  });

  it('`?branch=` naming another salon\'s branch is 404, indistinguishable from nonsense', async () => {
    const foreign = await deposits({ branch: B_BRANCH });
    const invented = await deposits({ branch: 'BR-NO-SUCH-THING-AT-ALL' });
    expect(foreign.status).toBe(404);
    expect(invented.status).toBe(404);
    expect(
      JSON.parse(foreign.raw),
      'salon B\'s branch id answers differently from an invented one, which makes this ' +
        'endpoint an oracle for "does that branch exist somewhere in AVO"',
    ).toEqual(JSON.parse(invented.raw));
  });
});

// =========================================================================
describe('deposit health · salon B\'s own answer carries none of salon A\'s money', () => {
  /**
   * THE PERMITTED CALL, AND THAT IS THE WHOLE POINT OF THIS DESCRIBE.
   *
   * `tenancy.test.ts`'s `SALON_ROUTES` row asserts that salon A's manager is
   * refused salon B's id with a 403 carrying nothing of salon B's. That is the
   * PATH guard, and it is necessary and not sufficient: a 403 says the door is
   * bolted, and says nothing whatever about what is served through the door that
   * is open. The predicate — `WHERE booking.salon_id = ${salonId}` — is a
   * different piece of code, and removing it leaves every 403 exactly where it was.
   *
   * SO THIS ASKS THE OTHER QUESTION. Salon B's own manager, holding every
   * permission, reads her own salon and gets a 200; that 200 must contain her two
   * bookings, her instants and her zero, and NONE of salon A's fifteen dinars,
   * none of salon A's 205 held rows, and no string belonging to salon A's people.
   *
   * SALON-WIDE, NEVER `?branch=`. A leak hidden behind a branch filter would be
   * invisible, which is the same reason lane A's int spec 4 reads unfiltered.
   */
  it('salon B reads her own two walk-ins, her own oldest instant, and zero fils', async () => {
    const bSql = num(
      `select count(*) from booking where salon_id = '${SALON_B}' and status = 'deposit_held'`,
    );
    const b = await health({ token: lumiereManager, salonId: SALON_B, branch: null });

    expect(
      b.held.bookings,
      'salon B\'s held count is not the number of held bookings salon B actually has',
    ).toBe(bSql);
    expect(
      b.held.fils,
      'SALON B HOLDS NO MONEY AT ALL — every row of hers is a zero-deposit walk-in. A ' +
        'non-zero here is salon A\'s escrow arriving through a dropped salon predicate.',
    ).toBe(0);
    expect(b.rows.map((r) => r.bookingId)).toEqual(
      expect.arrayContaining([BK_LUM_UNCLOSED, BK_LUM_AWAIT]),
    );
    expect(
      b.overdue.oldestStartedAt,
      'salon B\'s backlog now reaches further back than salon B\'s oldest booking',
    ).toBe(new Date(scalar(
      `select to_char(min(starts_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
         from booking where salon_id = '${SALON_B}' and status = 'deposit_held'
          and starts_at < now()`,
    )).toISOString());
  });

  it('and her answer names nobody and nothing of salon A\'s', async () => {
    const res = await deposits({ token: lumiereManager, salonId: SALON_B, branch: null });
    expect(res.status).toBe(200);

    const aIds = [BK_AWAIT, BK_RETURN, BK_UNCLOSED, BK_FUTURE];
    for (const id of aIds) {
      expect(
        res.body.rows.map((r) => r.bookingId),
        `salon A's booking ${id} is in salon B's row list`,
      ).not.toContain(id);
    }
    /**
     * THE RAW BODY, NOT THE PARSED ROWS, FOR THE STRINGS. A leak that arrived in a
     * field this file's interface does not model would survive a check that only
     * walked `rows` — and the interface above is hand-written from the service, so
     * it is exactly as complete as this lane's reading of lane A's code.
     */
    for (const telltale of [
      A_MEMBER_NAME,
      A_MEMBER_PHONE,
      NAME_AWAIT,
      NAME_RETURN,
      NAME_GUEST,
      BRANCH,
      CAP_BRANCH,
      ARTIST,
      SALON_A,
    ]) {
      expect(
        res.raw.includes(telltale),
        `salon B's deposit report contains "${telltale}", which belongs to salon A`,
      ).toBe(false);
    }
  });

  it('and salon A\'s own answer names nothing of salon B\'s', async () => {
    const res = await deposits({ branch: null });
    expect(res.status).toBe(200);
    for (const id of [BK_LUM_UNCLOSED, BK_LUM_AWAIT]) {
      expect(res.body.rows.map((r) => r.bookingId)).not.toContain(id);
    }
    expect(
      res.raw.includes(NAME_LUM_GUEST),
      'salon A\'s deposit report names salon B\'s walk-in',
    ).toBe(false);
    /**
     * AND THE COUNT, AGAINST SQL, BECAUSE THE TWO ASSERTIONS ABOVE ARE NOT ENOUGH
     * ON THEIR OWN — MEASURED.
     *
     * Salon B's fixtures are moneyless, so a leak INTO salon A cannot show up in
     * `held.fils`; it can only add ROWS. And this file's cap branch puts 201 rows
     * older than either of salon B's in front of them, so salon B's two are
     * TRUNCATED AWAY before they reach `rows` — which means `not.toContain` and the
     * telltale-string sweep both pass over a live leak. Driven: with the salon
     * predicate removed from `services/depositHealth.ts`, the two specs above went
     * red and this one stayed GREEN while it was a `>=` floor.
     *
     * An equality against SQL is what bites, and it is the same shape as salon B's
     * half. A floor cannot see a count that grew.
     */
    expect(
      res.body.held.bookings,
      'salon A\'s held count is not the number of held bookings salon A actually has — if it ' +
        'is LARGER, another salon\'s rows are in her aggregate, and the cap may well be ' +
        'hiding them from her row list',
    ).toBe(
      num(`select count(*) from booking where salon_id = '${SALON_A}' and status = 'deposit_held'`),
    );
  });
});

// =========================================================================
describe('deposit health · the three states, and whether they really partition', () => {
  it('one row in each state, and each row is classified exactly once', async () => {
    const b = await health();

    expect(rowFor(b, BK_AWAIT).state).toBe('awaiting_arrival');
    expect(rowFor(b, BK_RETURN).state).toBe('return_overdue');
    expect(rowFor(b, BK_UNCLOSED).state).toBe('unclosed');

    expect(b.overdue.awaitingArrival).toEqual({ bookings: 1, fils: AWAIT_FILS });
    expect(b.overdue.returnOverdue.bookings).toBe(1);
    expect(b.overdue.returnOverdue.fils).toBe(RETURN_FILS);
    expect(b.overdue.unclosed.bookings).toBe(1);

    /**
     * EXACTLY ONCE, ASSERTED AS A SET RATHER THAN AS THREE EQUALITIES. Three rows
     * carrying three distinct states is a stronger statement than three rows each
     * carrying the state this spec expected: it is the one that fails if a fourth
     * `WHEN` is added to the CASE, or if two of the three predicates are made to
     * overlap and the CASE's ordering starts doing the work the predicates should.
     */
    expect(new Set(b.rows.map((r) => r.state)).size, 'two overdue rows share a state').toBe(3);
  });

  it('the distinction is kept where it matters — only return_overdue is money AVO owes back', async () => {
    const b = await health();

    /**
     * `returnOverdueMinutes` IS THE FIELD THE DISTINCTION IS FOR. A zero on the
     * other two states would read as "due back this instant", which is a different
     * and false claim: an `awaiting_arrival` row has not reached its deadline, and
     * an `unclosed` row has no money behind the deadline it passed.
     */
    expect(rowFor(b, BK_AWAIT).returnOverdueMinutes).toBeNull();
    expect(rowFor(b, BK_UNCLOSED).returnOverdueMinutes).toBeNull();
    expect(rowFor(b, BK_RETURN).returnOverdueMinutes).toBeGreaterThanOrEqual(389);

    /** `unclosed` has NO money key at all, and that is stated as a decision. */
    expect(
      'fils' in (b.overdue.unclosed as Record<string, unknown>),
      'overdue.unclosed carries a `fils`. It can only ever be 0 — a money figure whose ' +
        'only possible use is to be rendered as "0.000 KD" beside a count of rows that ' +
        'owe nobody anything.',
    ).toBe(false);

    /** `dueSince` is the oldest UNMET deadline, and it comes out of the same aggregate. */
    expect(b.overdue.returnOverdue.dueSince).not.toBeNull();
    expect(Date.parse(b.overdue.returnOverdue.dueSince!)).toBeLessThan(Date.now());

    /** And the two `oldest` instants answer different questions. */
    expect(b.overdue.oldestStartedAt).toBe(rowFor(b, BK_UNCLOSED).startsAt);
    expect(b.overdue.unclosed.oldestStartedAt).toBe(rowFor(b, BK_UNCLOSED).startsAt);
  });

  it('the three sum to the overdue set — awaiting + return_overdue + unclosed = overdue', async () => {
    const b = await health();
    expect(
      b.overdue.awaitingArrival.bookings +
        b.overdue.returnOverdue.bookings +
        b.overdue.unclosed.bookings,
    ).toBe(b.overdue.bookings);
    expect(b.overdue.awaitingArrival.fils + b.overdue.returnOverdue.fils).toBe(b.overdue.fils);
  });

  /**
   * =======================================================================
   * § THE PARTITION — LANE A'S REASON, VERIFIED RATHER THAN RESTATED
   * =======================================================================
   * `services/depositHealth.ts` states why the sum above is a property and not a
   * coincidence, and the sentence is worth quoting because this spec is about its
   * last clause:
   *
   *   "`no_show_return_due_at` is stamped from `ends_at` plus
   *    `salon.no_show_return_minutes`, which `salon_no_show_return_in_range` pins
   *    BETWEEN 5 AND 1440, and `booking_ends_after_starts` gives `ends_at >
   *    starts_at`. So `due_at > starts_at` on every row … — two CHECK constraints
   *    rather than an assumption about how the write path happens to behave today."
   *
   * TWO OF THE THREE HALVES CHECK OUT AND THE THIRD DOES NOT.
   *
   * The partition of the overdue set is unconditional, and it does not need the
   * constraints at all: `due_at > now` and `due_at <= now` are complementary, and
   * `hold IS NULL` and `hold IS NOT NULL` are complementary, so every row with
   * `starts_at < now` is in exactly one of the three whatever the data says. That
   * is asserted by the spec above.
   *
   * What the constraints are load-bearing for is the OTHER direction — that
   * `return_overdue` and `unclosed` contain no row from OUTSIDE the overdue set.
   * Their FILTER clauses do not carry `starts_at < now`; only `due_at <= now`. So
   * the sum identity holds if and only if `due_at <= now` implies `starts_at < now`,
   * which needs `due_at > starts_at` on every row.
   *
   * AND `due_at > starts_at` IS NOT A CONSTRAINT. There is no CHECK anywhere on
   * `booking` that mentions `no_show_return_due_at` — the spec below asks
   * `pg_constraint` rather than taking anybody's word for it. The two CHECKs named
   * in the quote constrain `ends_at` and `salon.no_show_return_minutes`; the thing
   * that ties `due_at` to either of them is the STAMPING RULE at four call sites in
   * `services/booking.ts`, which is exactly the "assumption about how the write
   * path happens to behave today" the sentence says it is not relying on.
   *
   * SO THIS IS PINNED FROM BOTH ENDS. The first spec proves the gap is real by
   * writing the row the constraints permit and watching the identity break. The
   * second pins the invariant that ACTUALLY holds — that no row in the database has
   * a deadline at or before its own start — which is the guarantee the write path
   * provides and the one a future reader should be told about.
   *
   * REPORTED, NOT FIXED. A CHECK on `booking` is `api/`, which is not this lane's
   * column.
   */
  it('no CHECK constraint on `booking` mentions no_show_return_due_at', () => {
    /**
     * NON-VACUOUS FIRST, because an absence proved by a query that reads nothing is
     * not an absence. The same scan pointed at a column that IS constrained has to
     * come back with the constraints everything else in this file leans on — if a
     * regclass cast, a catalog rename or a typo ever made this read empty, the
     * assertion below would go green for ever and the gap it documents would look
     * closed.
     */
    const onDeposit = scalar(`
      select coalesce(string_agg(conname, ','), '')
        from pg_constraint
       where conrelid = 'booking'::regclass
         and contype = 'c'
         and pg_get_constraintdef(oid) like '%deposit_fils%'
    `).trim();
    expect(
      onDeposit,
      'the CHECK scan cannot see the constraints on deposit_fils either, so it is reading ' +
        'nothing and the absence asserted below is the scan\'s and not the schema\'s',
    ).toContain('booking_deposit_matches_hold');

    const found = scalar(`
      select coalesce(string_agg(conname || ' :: ' || pg_get_constraintdef(oid), E'\\n'), '')
        from pg_constraint
       where conrelid = 'booking'::regclass
         and contype = 'c'
         and pg_get_constraintdef(oid) like '%no_show_return_due_at%'
    `).trim();
    expect(
      found,
      'A CHECK now ties `no_show_return_due_at` to another column. That is GOOD NEWS and ' +
        'this spec is the thing that has to change: if the constraint says `due_at > ' +
        'starts_at` (or `>= ends_at`), then services/depositHealth.ts\'s claim that the ' +
        'partition is total BY CONSTRAINT has become true, the adversarial spec below can ' +
        'no longer write its row, and both should be rewritten to assert the constraint ' +
        'refuses it. Do not simply widen this to let the new constraint through.',
    ).toBe('');
  });

  it('so a row the two named CHECKs permit breaks the sum — the totality is a write-path rule', async () => {
    const before = await health();
    expect(
      before.overdue.awaitingArrival.bookings +
        before.overdue.returnOverdue.bookings +
        before.overdue.unclosed.bookings,
      'precondition: the identity does not hold before this spec touches anything',
    ).toBe(before.overdue.bookings);

    /**
     * THE ROW. `ends_at > starts_at` is satisfied, `deposit_fils = 0` with no hold
     * is satisfied, `source = 'merchant'` with a guest name is satisfied — every
     * CHECK on this table accepts it. Its deadline is five minutes in the PAST and
     * its slot is two hours in the FUTURE, which is the combination the stamping
     * rule makes unreachable and the schema does not.
     */
    /**
     * `try/finally`, AND THE FINALLY IS NOT TIDINESS.
     *
     * Measured while proving this spec bites: with the FILTER clauses mutated to
     * carry `starts_at < now`, the assertions below threw before the DELETE was
     * reached, the adversarial row survived, and the NEXT spec — the whole-table
     * invariant — went red naming it. Two failures, one cause, and the second one
     * reads as a defect in the product. A fixture that can only be cleaned up by
     * the happy path is a fixture that poisons its neighbours on the unhappy one.
     */
    heldGuest(BK_ADVERSARIAL, 120, 30, { dueMin: -5, guestName: `QA Adversarial ${RUN}` });
    try {
    expect(
      num(`select count(*) from booking where id = '${BK_ADVERSARIAL}'`),
      'Postgres refused the row, so a constraint DOES forbid it — see the spec above, ' +
        'which should have caught that first and is the one to fix.',
    ).toBe(1);

    const during = await health();
    /** It is SCHEDULED — its slot has not started — and it is also `unclosed`. */
    expect(during.scheduled.bookings, 'the adversarial row is not in the scheduled set').toBe(2);
    expect(during.overdue.bookings, 'the adversarial row leaked into the overdue count').toBe(3);
    expect(during.overdue.unclosed.bookings, 'the adversarial row is not counted unclosed').toBe(2);
    expect(
      during.overdue.awaitingArrival.bookings +
        during.overdue.returnOverdue.bookings +
        during.overdue.unclosed.bookings,
      'THE SUM IDENTITY SURVIVED A ROW THAT SHOULD HAVE BROKEN IT. Either the FILTER ' +
        'clauses now carry `starts_at < now` — in which case the identity is genuinely ' +
        'unconditional, this spec is obsolete and depositHealth.ts should say so — or the ' +
        'fixture above stopped reaching the state it names.',
    ).toBe(4);
    expect(
      during.rows.map((r) => r.bookingId),
      'the row list carries `AND starts_at < now`, so the adversarial row must NOT be in it — ' +
        'which is the asymmetry: the COUNT includes a row the EVIDENCE cannot show.',
    ).not.toContain(BK_ADVERSARIAL);

    } finally {
      psql(`DELETE FROM booking WHERE id = '${BK_ADVERSARIAL}';`);
    }
    const after = await health();
    expect(
      after.overdue.awaitingArrival.bookings +
        after.overdue.returnOverdue.bookings +
        after.overdue.unclosed.bookings,
      'the identity did not come back after the adversarial row was removed',
    ).toBe(after.overdue.bookings);
  });

  it('and the invariant the write path DOES provide — driven THROUGH the write path', async () => {
    /**
     * THE GUARANTEE THAT IS REAL, AND IT IS A CLAIM ABOUT FOUR LINES OF CODE
     * RATHER THAN ABOUT THE TABLE.
     *
     * `services/booking.ts` computes `new Date(endsAt.getTime() +
     * s.noShowReturnMinutes * 60_000)` at every one of its write sites, and
     * `salon_no_show_return_in_range` keeps that increment at least five minutes —
     * so every row the PRODUCT writes has `due_at = ends_at + n > starts_at`, which
     * is what makes the sum identity above hold in practice.
     *
     * ---------------------------------------------------------------------
     * THIS WAS A WHOLE-TABLE SWEEP AND IT WENT RED IN THE GATE. MEASURED, AND THE
     * REASON IS WORTH THE PARAGRAPH BECAUSE THE NEXT PERSON WILL WANT TO RE-ADD IT.
     * ---------------------------------------------------------------------
     * The first version asserted `SELECT count(*) FROM booking WHERE
     * no_show_return_due_at <= starts_at` was zero across the whole database — on
     * the argument that the claim is about the product and not about the fixture,
     * so a row named there is either a write path that has stopped stamping or a
     * fixture that invented a deadline, and both are worth knowing.
     *
     * It passes in isolation and FAILS in the full suite, naming
     * `BK-10000013 (app, no_show_returned)` — a row minted by the real API and then
     * edited. The cause is THIS SUITE'S OWN FIXTURES, and they are right to do it:
     * `deposit.test.ts § makeDue`, `no-show-worker.test.ts` and
     * `reports-applied-deposit.test.ts` all set `no_show_return_due_at = now() -
     * interval '1 minute'` WITHOUT moving `starts_at`, because the no-show worker's
     * scan is `due_at <= now` and that is the only way to make it fire without
     * waiting an hour. The rows are deliberate, they are the right fixtures, and
     * they are exactly the shape the sweep was looking for.
     *
     * So the sweep was measuring the suite and reporting it as the product. A spec
     * that is green alone and red in the gate, for a reason that is nobody's
     * defect, is the kind that gets a real failure waved through as "that one
     * again" — so it is replaced rather than exempted. An exemption list keyed on
     * fixture ids would need an entry every time another file needed a due
     * deadline, which is the mechanism this repo's censuses exist to avoid.
     *
     * WHAT REPLACES IT IS STRONGER ABOUT THE THING THAT MATTERS: the write path is
     * driven, and the stamp is checked to the second against the salon's own
     * window. A regression in `services/booking.ts` fails here; a fixture doing
     * fixture things does not.
     */
    const startsAt = new Date(Date.now() + 530 * 86_400_000).toISOString();
    const created = await treq<{ booking: { id: string } }>(
      'POST',
      `/salons/${SALON_A}/bookings`,
      {
        token: manager,
        idempotencyKey: `dh-qa-writepath-${RUN}`,
        body: {
          artistId: ARTIST,
          serviceId: SERVICE,
          startsAt,
          guestName: `QA Write-path ${RUN}`,
        },
      },
    );
    expect(
      created.status,
      `POST /salons/{id}/bookings answered ${created.status}: ${created.raw.slice(0, 300)}`,
    ).toBe(201);
    const id = created.body.booking.id;

    try {
      /**
       * READ BACK OUT OF POSTGRES, NOT OFF THE WIRE. The response is built by the
       * same function that computed the deadline, so comparing its three fields to
       * each other would be asserting that the serialiser agrees with itself. The
       * columns are what the rest of the product — and the endpoint under test —
       * actually reads.
       */
      const stamped = scalar(`
        select extract(epoch from (no_show_return_due_at - ends_at))::bigint
               || '|' || (no_show_return_due_at > starts_at)::text
          from booking where id = '${id}'
      `).trim();
      const [gapSeconds, afterStart] = stamped.split('|');

      expect(
        Number(gapSeconds),
        'the deadline is no longer `ends_at` plus the salon\'s no-show window. That stamp ' +
          'is the whole reason `due_at <= now` implies `starts_at < now`, which is what ' +
          'makes awaiting + return_overdue + unclosed = overdue — and the spec above ' +
          'proves the schema does NOT enforce it.',
      ).toBe(
        60 *
          num(`select no_show_return_minutes from salon where id = '${SALON_A}'`),
      );
      expect(
        afterStart,
        'a booking the product just wrote has a deadline at or before its own slot start',
      ).toBe('true');
    } finally {
      psql(`DELETE FROM booking WHERE id = '${id}';`);
    }
  });
});

// =========================================================================
describe('deposit health · the walk-in contributes zero', () => {
  it('she is in the rows and in the counts, with her own name and no member', async () => {
    const b = await health();
    const guest = rowFor(b, BK_UNCLOSED);

    expect(guest.guestName).toBe(NAME_GUEST);
    expect(guest.memberId, 'a walk-in has no member id — booking_identity_exactly_one').toBeNull();
    expect(guest.memberName).toBeNull();
    expect(guest.memberPhone).toBeNull();
    expect(
      guest.memberErased,
      'the LEFT JOIN\'s two nulls were read as an erasure rather than as a guest',
    ).toBe(false);
    expect(guest.source).toBe('merchant');
    /**
     * SHE IS COUNTED. "The front desk needs to see the chair is still open" is the
     * whole reason a moneyless row is in this report at all, so being counted is
     * half of the claim and adding nothing is the other half.
     */
    expect(b.held.bookings).toBe(4);
    expect(b.overdue.bookings).toBe(3);
  });

  it('and she moves no total by a single fils', async () => {
    const b = await health();
    expect(rowFor(b, BK_UNCLOSED).depositFils).toBe(0);
    /**
     * THE ARITHMETIC THAT WOULD MOVE IF SHE DID. Three overdue rows, two of them
     * carrying money: `overdue.fils` is the two deposits and not a third of
     * anything. `unclosed` has no `fils` to inflate, which is why the assertion has
     * to be made on the sums that DO exist.
     */
    expect(b.overdue.fils).toBe(OVERDUE_FILS);
    expect(b.overdue.awaitingArrival.fils + b.overdue.returnOverdue.fils).toBe(b.overdue.fils);
    expect(b.held.fils).toBe(HELD_FILS);
  });

  it('because a merchant-written booking cannot carry money at all — the constraint, driven', () => {
    /**
     * NON-NEGOTIABLE #2 AS A DATABASE FACT, AND THE REASON THE SPECS ABOVE ARE NOT
     * ASSERTING A FILTER. If the zero were a `WHERE source <> 'merchant'` somewhere
     * in the sum, a merchant-written row WITH money would be silently excluded from
     * the held total — money the salon is really holding, invisible in the report
     * whose entire subject is how much money the salon is holding.
     *
     * It is not a filter. The row cannot exist. Driven rather than quoted, because a
     * constraint named in a comment is a constraint nobody has run.
     *
     * TWO ATTEMPTS, AND THE SECOND IS THE ONE THAT PINS #2. The first draft of this
     * spec made ONE attempt — money and no hold — and it was refused by
     * `booking_deposit_matches_hold` rather than by
     * `booking_merchant_is_zero_deposit`, because Postgres evaluates CHECKs in no
     * promised order and that row breaks both. A spec asserting "#2 holds" while
     * standing on whichever constraint fired first would keep passing if #2 were
     * dropped tomorrow. So the second attempt satisfies `..._matches_hold` — a real
     * hold, the one behind BK_AWAIT — and leaves #2 as the only constraint it can
     * break.
     *
     * IT REUSES AN EXISTING HOLD RATHER THAN MINTING ONE. `ledger_entry` is
     * append-only at the role level, so a throwaway `deposit_hold` transaction
     * written to satisfy a constraint could not be taken back; pointing at a hold
     * this file already wrote costs nothing and leaves nothing.
     */
    const attempt = (label: string, depositFils: number, holdExpr: string): string => {
      try {
        psql(`
          INSERT INTO booking
            (id, salon_id, branch_id, branch_assumed, member_id, guest_name, artist_id,
             service_id, starts_at, ends_at, duration_min, deposit_fils, status, source,
             hold_transaction_id, settled_transaction_id, no_show_return_due_at)
          VALUES ('DH-QA-BK-ILLEGAL-${label}-${RUN}', '${SALON_A}', '${BRANCH}', false, NULL,
                  'QA Illegal ${label} ${RUN}', '${ARTIST}', '${SERVICE}',
                  ${t(-90)}, ${t(-60)}, 30, ${depositFils}, 'deposit_held', 'merchant',
                  ${holdExpr}, NULL, ${t(-1)});
        `);
      } catch (err) {
        return String((err as Error).message);
      }
      return '';
    };

    /** Money with no hold: "no hold" and "zero deposit" are the same fact. */
    expect(
      attempt('NOHOLD', 5000, 'NULL'),
      'the database accepted a booking claiming 5.000 KD with no hold behind it. ' +
        '`booking_deposit_matches_hold` is what makes "a walk-in contributes zero" a fact ' +
        'about the schema rather than a filter somebody could remove.',
    ).toContain('booking_deposit_matches_hold');

    /** And money WITH a hold, which leaves #2 as the only thing left to refuse it. */
    expect(
      attempt(
        'HELD',
        5000,
        `(SELECT hold_transaction_id FROM booking WHERE id = '${BK_AWAIT}')`,
      ),
      'THE DATABASE ACCEPTED A MERCHANT-WRITTEN BOOKING HOLDING A CUSTOMER\'S 5.000 KD. ' +
        'Non-negotiable #2: a merchant who can move a customer\'s money by filling in a ' +
        'form is a merchant who can move it without her. The handler refuses it too; this ' +
        'constraint is the layer that holds when somebody edits the handler.',
    ).toContain('booking_merchant_is_zero_deposit');

    expect(
      num(`select count(*) from booking where id like 'DH-QA-BK-ILLEGAL-%${RUN}'`),
      'one of the illegal rows is in the table, so a later figure in this file is counting it',
    ).toBe(0);
  });
});

// =========================================================================
describe('deposit health · the money is integer fils and adds up', () => {
  it('held = scheduled + overdue, and overdue = the deposits on the rows it lists', async () => {
    const b = await health();
    expect(
      b.scheduled.fils + b.overdue.fils,
      'held is not the sum of the two halves it is split into',
    ).toBe(b.held.fils);
    expect(b.scheduled.bookings + b.overdue.bookings).toBe(b.held.bookings);
    expect(
      b.rows.reduce((sum, r) => sum + r.depositFils, 0),
      'the overdue total disagrees with the rows it claims to cover',
    ).toBe(b.overdue.fils);
  });

  it('and it agrees with the column it was summed from', async () => {
    const b = await health();
    expect(b.held.fils).toBe(
      num(`select coalesce(sum(deposit_fils), 0)::bigint from booking
             where salon_id = '${SALON_A}' and branch_id = '${BRANCH}'
               and status = 'deposit_held'`),
    );
  });

  it('every fils on the wire is an integer — no float touches money (#1)', async () => {
    const b = await health({ branch: null });
    const money: Array<[string, number]> = [
      ['held.fils', b.held.fils],
      ['scheduled.fils', b.scheduled.fils],
      ['overdue.fils', b.overdue.fils],
      ['overdue.awaitingArrival.fils', b.overdue.awaitingArrival.fils],
      ['overdue.returnOverdue.fils', b.overdue.returnOverdue.fils],
      ...b.rows.map((r): [string, number] => [`rows[${r.bookingId}].depositFils`, r.depositFils]),
    ];
    for (const [where, value] of money) {
      expect(Number.isInteger(value), `${where} is ${value}, which is not integer fils`).toBe(true);
    }
    expect(money.length, 'the money sweep found nothing to sweep').toBeGreaterThan(5);
  });

  it('and a fraction cannot reach the sum — deposit_fils is bigint', () => {
    /**
     * WHERE `filsFrom`'s REFUSAL ACTUALLY SITS, said honestly.
     *
     * `services/depositHealth.ts § filsFrom` throws rather than truncating, and it
     * is right to: `metrics.ts § int` is `Math.trunc`, which is correct for a count
     * and wrong for money, because truncating swallows the one signal that a float
     * reached a money column. But that throw is a BACKSTOP and not the guard, and
     * this file cannot drive it — the guard is the column. `deposit_fils` is
     * `bigint`, `sum()` over it is cast `::bigint` in the query, and Postgres will
     * not store a fraction there, so there is no input this suite can construct
     * that reaches `filsFrom` as a non-integer.
     *
     * So the spec asserts the thing that is true and reachable: the column type.
     * The spec that would drive the throw is a unit test on the service, in `api/`,
     * which is not this lane's column — it is named in the lane report as owed
     * rather than implied by a comment here.
     */
    expect(
      scalar(`select data_type from information_schema.columns
               where table_name = 'booking' and column_name = 'deposit_fils'`).trim(),
      'deposit_fils is no longer bigint. Non-negotiable #1 says money is integer fils and ' +
        'that no float touches it — and every money assertion in this file is relying on ' +
        'the column to be the thing that enforces it.',
    ).toBe('bigint');

    /** And a literal fraction is refused outright rather than rounded into place. */
    let refused = '';
    try {
      psql(`SELECT '5000.5'::bigint;`);
    } catch (err) {
      refused = String((err as Error).message);
    }
    expect(refused, 'a fractional literal cast to bigint was accepted').toContain('invalid input syntax');
  });
});

// =========================================================================
describe('deposit health · the cap, and that the count is the authority', () => {
  it('the row list stops at 200 while the count keeps going, and the flag says so', async () => {
    const b = await health({ branch: CAP_BRANCH });

    expect(
      b.overdue.bookings,
      'the cap branch no longer holds one more overdue booking than the row cap, so this ' +
        'spec is not testing truncation',
    ).toBe(ROWS_MAX + 1);
    expect(
      b.rows.length,
      `the row list is not capped at ${ROWS_MAX}. If the cap moved, DEPOSIT_ROWS_MAX moved ` +
        'with it — this literal is deliberately not imported so that moving it is a ' +
        'deliberate act rather than a silent payload change.',
    ).toBe(ROWS_MAX);
    expect(
      b.rowsTruncated,
      'the row list is shorter than the count and rowsTruncated says it is not',
    ).toBe(true);
    /**
     * THE POINT OF THE FLAG, STATED AS AN ASSERTION. `overdue.bookings` and
     * `rows.length` are ALLOWED to disagree — the count is exact and unbounded, the
     * list is a page of evidence. A client that rendered `rows.length` as the figure
     * would under-report a backlog by exactly the amount that makes it a backlog.
     */
    expect(b.overdue.bookings).toBeGreaterThan(b.rows.length);
  });

  it('and it does not lie the other way — under the cap the two agree and the flag is false', async () => {
    const b = await health();
    expect(b.rows.length).toBe(b.overdue.bookings);
    expect(
      b.rowsTruncated,
      'rowsTruncated is true on a branch whose three overdue rows are all present',
    ).toBe(false);
  });
});

// =========================================================================
describe('deposit health · the row list is a queue, never a ranking', () => {
  it('rows are ordered by slot, oldest first', async () => {
    const b = await health({ branch: CAP_BRANCH });
    const times = b.rows.map((r) => Date.parse(r.startsAt));
    for (let i = 1; i < times.length; i++) {
      expect(
        times[i]! >= times[i - 1]!,
        `rows[${i}] starts before rows[${i - 1}] — the list is not starts_at ASC`,
      ).toBe(true);
    }
    expect(times.length).toBe(ROWS_MAX);
    /** And the cap takes the OLDEST 200, not an arbitrary 200: the newest row is cut. */
    expect(
      b.rows.map((r) => r.bookingId),
      'the cap dropped an OLD row and kept the newest, so the page of evidence is not the ' +
        'front of the queue',
    ).toContain(`DH-QA-BK-CAP-${RUN}-0200`);
    expect(b.rows.map((r) => r.bookingId)).not.toContain(`DH-QA-BK-CAP-${RUN}-0000`);
  });

  it('and not by person — the order survives names and ids that would sort differently', async () => {
    const b = await health();

    /**
     * THE FIXTURE IS THE ASSERTION HERE. In time order the three read Zahra, Amal,
     * Mariam; alphabetically they read Amal, Mariam, Zahra; by member id the walk-in
     * has none at all. So `ORDER BY member.name` and `ORDER BY member.id` both
     * produce an order this spec refuses, which is what stops it being green for
     * free the way a fixture with three names already in slot order would be.
     */
    expect(b.rows.map((r) => r.bookingId)).toEqual([BK_UNCLOSED, BK_RETURN, BK_AWAIT]);

    const displayed = b.rows.map((r) => r.memberName ?? r.guestName ?? '');
    expect(displayed).toEqual([NAME_GUEST, NAME_RETURN, NAME_AWAIT]);
    expect(
      [...displayed].sort(),
      'the fixture\'s three names now sort the same way their slots do, so this spec would ' +
        'be green under ORDER BY member.name. Rename one of them.',
    ).not.toEqual(displayed);
  });

  it('and how overdue each row is counts from its slot, floored', async () => {
    const b = await health();
    const awaiting = rowFor(b, BK_AWAIT);
    /**
     * FLOORED, NOT ROUNDED — "at least this long" is the true statement, and a
     * round-half-up would report a booking 29 seconds past its slot as a minute
     * late. The fixture sits 45 minutes back, so the honest answer is 44 or 45
     * depending on how long `beforeAll` took; anything at 46 or above is the clock
     * being read against something other than `starts_at`.
     */
    expect(awaiting.overdueMinutes).toBeGreaterThanOrEqual(44);
    expect(awaiting.overdueMinutes).toBeLessThan(60);
    expect(Number.isInteger(awaiting.overdueMinutes)).toBe(true);
    expect(
      rowFor(b, BK_UNCLOSED).overdueMinutes,
      'the oldest row is not reported as the most overdue',
    ).toBeGreaterThan(awaiting.overdueMinutes);
  });
});

// =========================================================================
describe('the no-show count is on the card and NOT on the book', () => {
  /**
   * =======================================================================
   * A DECISION SOMEBODY COULD UNDO IN ONE LINE, PINNED SO THAT UNDOING IT IS LOUD
   * =======================================================================
   * `services/customerDirectory.ts § countMemberNoShows` spends a page arguing
   * that `noShowCount` is an integer beside `visits` and nothing else — no score,
   * no flag, no threshold, no ordering — and that it belongs on the DETAIL and not
   * on the LIST. Its reason, verbatim: "a column of no-show counts down a page of
   * names is a ranking whether or not anything sorts by it, because the eye sorts
   * it."
   *
   * Adding the field to `serialiseCustomerListItem` is a one-line change that
   * breaks nothing, reads as a convenience, and makes the customer book a
   * leaderboard. Nothing in this suite would have noticed. This describe is what
   * notices, and its failure message is written to explain WHY rather than to read
   * as an oversight somebody should paper over.
   */
  const listUrl = (q: string) => `/salons/${SALON_A}/customers?q=${encodeURIComponent(q)}`;
  const cardUrl = (m: string) => `/salons/${SALON_A}/customers/${m}`;

  it('the card carries it, so this spec is about a field that exists', async () => {
    const res = await treq<{ noShowCount?: unknown; visits: number }>(
      'GET',
      cardUrl(HISTORY_MEMBER),
      { token: manager },
    );
    expect(res.status, `the card answered ${res.status}: ${res.raw.slice(0, 200)}`).toBe(200);
    expect(
      res.body.noShowCount,
      'the customer CARD no longer carries noShowCount, so the absence asserted below is ' +
        'not a privacy boundary — it is the field having been deleted, and this whole ' +
        'describe has stopped asking its question',
    ).toBe(2);
  });

  it('cancelling is not counted — the considerate thing is not punished', async () => {
    /**
     * HER FIXTURE IS FOUR RESOLVED BOOKINGS: two `no_show_returned`, one
     * `cancelled`, one `completed`. A predicate that counted terminal-and-not-
     * completed would answer 3 and look plausible; only the cancellation
     * distinguishes it, which is why she has one.
     */
    expect(
      num(`select count(*) from booking where member_id = '${HISTORY_MEMBER}'
             and status in ('no_show_returned','cancelled','completed')`),
      'precondition: the history fixture is not four resolved bookings',
    ).toBe(4);
    const res = await treq<{ noShowCount: number }>('GET', cardUrl(HISTORY_MEMBER), {
      token: manager,
    });
    expect(
      res.body.noShowCount,
      'her cancellation or her completed visit is being counted as a no-show. ' +
        '`no_show_returned` is the only honest status: it means the deposit went back.',
    ).toBe(2);
  });

  it('the LIST does not carry it, and that is deliberate rather than an oversight', async () => {
    const res = await treq<{ items: Array<Record<string, unknown>> }>(
      'GET',
      listUrl(HISTORY_MEMBER),
      { token: manager },
    );
    expect(res.status, `the list answered ${res.status}: ${res.raw.slice(0, 200)}`).toBe(200);
    const her = res.body.items.find((i) => i.id === HISTORY_MEMBER);
    expect(
      her,
      'the exact-id search did not return the member this spec is about, so the absence ' +
        'below would be the absence of a row rather than the absence of a field',
    ).toBeTruthy();
    expect(
      Object.keys(her!),
      'THE CUSTOMER BOOK NOW CARRIES A NO-SHOW COUNT PER ROW, AND THAT IS THE THING THE ' +
        'FIELD WAS KEPT OFF THE LIST TO PREVENT. services/customerDirectory.ts: "a column ' +
        'of no-show counts down a page of names is a ranking whether or not anything sorts ' +
        'by it, because the eye sorts it." It belongs on the card — one customer a merchant ' +
        'has already chosen to open, which is the moment the question is actually being ' +
        'asked. If this is a deliberate product change, it is a decision to write down in ' +
        'DECISIONS.md and argue for, not a test to widen.',
    ).not.toContain('noShowCount');
  });

  it('and it carries no score, no flag, no risk band and no threshold either', async () => {
    const res = await treq<{ items: Array<Record<string, unknown>> }>(
      'GET',
      listUrl(HISTORY_MEMBER),
      { token: manager },
    );
    /**
     * THE FIELD RENAMED IS THE SAME FIELD. A pin on the literal `noShowCount`
     * would be walked straight past by `riskScore`, `reliability` or `noShows`,
     * and the argument in customerDirectory.ts is about the CLAIM, not the
     * spelling: "no score, no flag, no threshold, no ordering".
     */
    const forbidden = /no.?show|risk|score|reliab|flag|rank|band|trust/i;
    for (const item of res.body.items) {
      const offending = Object.keys(item).filter((k) => forbidden.test(k));
      expect(
        offending,
        `the customer list row carries ${offending.join(', ')}. A server-made judgement ` +
          'about a named woman, on a page of names, that she cannot see, dispute or learn ' +
          'the existence of.',
      ).toEqual([]);
    }
  });

  it('and the book takes no sort — asking for one changes nothing', async () => {
    /**
     * `?sort=` IS NOT A PARAMETER THIS ROUTE HAS, and Fastify drops what it does
     * not model, so the honest assertion is that the answer does not move. The
     * failure this guards is somebody WIRING it: the list is `joined_at DESC, id
     * ASC`, and a `?sort=noShowCount` that worked would be the leaderboard by
     * another route than the one the spec above closes.
     */
    const plain = await treq<{ items: Array<{ id: string }> }>(
      'GET',
      `/salons/${SALON_A}/customers`,
      { token: manager },
    );
    const sorted = await treq<{ items: Array<{ id: string }> }>(
      'GET',
      `/salons/${SALON_A}/customers?sort=-noShowCount`,
      { token: manager },
    );
    expect(plain.status).toBe(200);
    expect(sorted.status).toBe(200);
    expect(
      sorted.body.items.map((i) => i.id),
      'the customer book reordered for `?sort=-noShowCount`. The directory is not sorted ' +
        'by this and takes no sort for it — a list ranked by no-shows is a leaderboard of ' +
        'women to distrust, and it would be read as one on the first day.',
    ).toEqual(plain.body.items.map((i) => i.id));
  });
});
