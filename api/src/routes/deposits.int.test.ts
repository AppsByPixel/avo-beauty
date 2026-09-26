/**
 * DEPOSIT HEALTH — `GET /salons/{id}/deposits`.
 *
 * The client's last item, verbatim: *"what if they dont have enough payment
 * (sometimes they dont have money but lock the booking and they dont come)
 * deposit health option for merchants"*.
 *
 * WHAT EACH SPEC IS EVIDENCE FOR:
 *
 *   1   the gate, called DIRECTLY with `perms.appointments` off (#7)
 *   2   the OTHER half of the gate: the front desk, who holds `appointments`
 *       and NOT `void`, is allowed — a read gated behind the write's permission
 *       would not exist for the person the client asked for
 *   3   tenancy on the PATH: Amara's manager cannot address Lumiere's id
 *   4   tenancy in the PREDICATE: Lumiere's own manager, holding every
 *       permission, sees none of Amara's deposits and none of Amara's money
 *   5   the held total is INTEGER FILS and is exactly the sum of the rows it
 *       claims to cover — held = scheduled + overdue, overdue = the row list
 *   6   `awaiting_arrival` vs `return_overdue` vs `unclosed`, one row in each,
 *       and the "how overdue" figures that qualify them
 *   7   a GUEST appointment appears with her own name and contributes ZERO
 *   8   the per-member no-show COUNT, and that it does not leak across salons
 *
 * SPECS 5-7 RUN THROUGH `?branch=`, ON A BRANCH THIS FILE CREATES. Every figure
 * the endpoint serves is a salon-wide aggregate, so an absolute assertion
 * against a shared seed would be an assertion about whatever else happens to be
 * in the table. A branch of this file's own makes the expected numbers exact
 * — 15.000 KD held, three overdue rows, one of each state — which is what makes
 * them fail when the arithmetic is mutated. Spec 4 deliberately does NOT use it:
 * a cross-tenant leak hidden behind a branch filter would be invisible, so that
 * one reads salon-wide.
 *
 * THE FIXTURES ARE INSERTS, NOT CALLS TO `POST /bookings`, for
 * `merchantBookings.int.test.ts`'s stated reason: the real customer path
 * validates `startsAt` against `computeAvailability`, which would pin these
 * specs to one artist's published window on one weekday and fail them for a
 * reason that has nothing to do with deposits. The rows written here are the
 * rows that path writes — the `deposit_hold` transaction, the balanced ledger
 * pair, the wallet debit, and the booking pointing at the hold.
 *
 * NO SLOT COLLISION WITH ANY OTHER INT FILE. `booking_artist_slot_no_overlap` is
 * an EXCLUDE over (artist, time range), so two files sharing an artist share a
 * slot space. This file creates its OWN artists with a per-run id, so its slot
 * space is its own and a re-run minutes later cannot land in the last run's.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const SALON = 'SAL-AMARA';
const OTHER_SALON = 'SAL-LUMIERE';
const OTHER_BRANCH = 'BR-LUM-HAW';
/**
 * WHERE THIS FILE'S `transaction` ROWS GO — a branch of the seed's, not the one
 * below.
 *
 * `transaction.branch_id` is `ON DELETE restrict`, and nothing in avo_app's role
 * may delete a `ledger_entry` (migration 0038), so a transaction written against
 * this file's own branch would pin that branch in the table for ever. The
 * bookings carry the fixture branch and the money carries a real one; the
 * endpoint reads `booking.branch_id` and never the transaction's, so the split
 * costs the specs nothing and is what makes the branch removable.
 */
const MONEY_BRANCH = 'BR-SAL';

/** Noura — manager, every permission. */
const MANAGER = 'ST-001';
/**
 * Hessa — frontdesk. `db/seed.ts § ST-002`: `perm_appointments = true` with
 * `perm_dashboard`, `perm_charges` and `perm_void` all FALSE.
 *
 * SHE IS THE WHOLE PERMISSION ARGUMENT. `POST .../no-show` takes `void` because
 * it returns a customer's money; this endpoint records nothing and moves
 * nothing, and the person who needs to know which of this morning's chairs
 * never resolved is the front desk. Spec 2 requires her to be allowed.
 */
const FRONTDESK = 'ST-002';

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

const BRANCH = `DH-BR-${RUN}`;
const ARTIST = `DH-AR-${RUN}`;
const SVC = `DH-SV-${RUN}`;

const LUM_STAFF = `DH-LST-${RUN}`;
const LUM_ARTIST = `DH-LAR-${RUN}`;
const LUM_SVC = `DH-LSV-${RUN}`;

/** The four held bookings this file's figures are computed from. */
const BK_AWAIT = `DH-BK-AWAIT-${RUN}`;
const BK_RETURN = `DH-BK-RETURN-${RUN}`;
const BK_UNCLOSED = `DH-BK-UNCLOSED-${RUN}`;
const BK_FUTURE = `DH-BK-FUTURE-${RUN}`;

const AWAIT_FILS = 5000;
const RETURN_FILS = 7000;
const FUTURE_FILS = 3000;

/**
 * LUMIERE GETS ONE ZERO-DEPOSIT WALK-IN AND NOT A SINGLE TRANSACTION.
 *
 * `services/metrics.int.test.ts` asserts, in its own `beforeAll` and with a
 * message naming the cause, that SAL-LUMIERE holds no `transaction` and no
 * `booking` outside its own `IT-*` prefix — "if another suite ever seeds
 * SAL-LUMIERE this fails HERE". Bookings this file can delete; transactions and
 * their ledger entries it cannot. So the cross-tenant fixture is moneyless, and
 * spec 4's evidence is that Lumiere's held total is ZERO while Amara's is
 * 15.000 KD: if the salon predicate stopped doing anything, the number she reads
 * changes by the whole of another salon's escrow.
 */
const BK_LUM = `DH-BK-LUM-${RUN}`;

interface DepositRowWire {
  bookingId: string;
  state: string;
  memberId: string | null;
  memberName: string | null;
  memberErased: boolean;
  memberPhone: string | null;
  guestName: string | null;
  guestPhone: string | null;
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

interface DepositHealthWire {
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
  rows: DepositRowWire[];
  rowsTruncated: boolean;
  branchId: string | null;
  branchName: string | null;
}

suite('deposit health — what she is holding, and what never resolved', () => {
  let app: FastifyInstance;
  let db: (typeof import('../db/client'))['db'];
  let sql: (typeof import('drizzle-orm'))['sql'];
  let issueSession: (typeof import('../auth/sessions'))['issueSession'];

  let managerBearer = '';
  let frontdeskBearer = '';
  let lumiereBearer = '';

  /** The member each money-bearing fixture belongs to. */
  let awaitMember = '';
  let returnMember = '';
  let futureMember = '';
  /** The member spec 8 counts no-shows for. */
  let historyMember = '';

  const exec = async (q: unknown) =>
    (await db.execute(q as never)) as unknown as Array<Record<string, unknown>>;

  async function web(staffId: string, salonId = SALON): Promise<string> {
    const s = await issueSession(db, {
      principalKind: 'staff',
      staffId,
      salonId,
      scope: 'dashboard',
    });
    return s.accessToken;
  }

  function get(
    opts: { bearer?: string; salonId?: string; branch?: string | null } = {},
  ) {
    const branch = opts.branch === undefined ? BRANCH : opts.branch;
    const qs = branch === null ? '' : `?branch=${encodeURIComponent(branch)}`;
    return app.inject({
      method: 'GET',
      url: `/salons/${opts.salonId ?? SALON}/deposits${qs}`,
      headers: { authorization: `Bearer ${opts.bearer ?? managerBearer}` },
    });
  }

  /**
   * A customer funded THROUGH THE LEDGER. `db:verify`'s invariant 5 is
   * `member.balance_fils = sum(member_wallet entries)`, and a fixture that sets
   * a balance and walks away breaks it by exactly the opening amount.
   */
  async function customer(): Promise<string> {
    const salonId = SALON;
    const branchId = MONEY_BRANCH;
    const id = `DH-M-${randomUUID().slice(0, 8)}`;
    const openingTx = `DH-TX-OPEN-${id.slice(5)}`;
    await exec(sql`
      INSERT INTO member (id, salon_id, name, phone, password_hash, balance_fils, tier, visits, policy_version)
      VALUES (${id}, ${salonId}, ${`DH Int Customer ${RUN}`},
              ${`+9658${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`},
              '$argon2id$fake-not-a-credential', 150000, 'bronze', 0, 3)`);
    await exec(sql`
      INSERT INTO "transaction"
        (id, member_id, salon_id, branch_id, kind, amount_fils, status, reference, note, created_at, settled_at)
      VALUES (${openingTx}, ${id}, ${salonId}, ${branchId}, 'adjustment', 150000, 'settled',
              ${`AVO-OPEN-${id}`}, 'Opening fixture balance', now(), now())`);
    await exec(sql`
      INSERT INTO ledger_entry (transaction_id, salon_id, member_id, account, direction, amount_fils, balance_after_fils)
      VALUES
        (${openingTx}, ${salonId}, ${id}, 'member_wallet', 'credit', 150000, 150000),
        (${openingTx}, ${salonId}, NULL, 'gateway_clearing', 'debit', 150000, NULL)`);
    return id;
  }

  /** An instant `minutes` from now. Negative is the past. */
  const t = (minutes: number): string => new Date(Date.now() + minutes * 60_000).toISOString();

  /**
   * A REAL `app` BOOKING with a hold behind it. `no_show_return_due_at` is
   * stamped from `ends_at` plus the salon's 60 minutes, exactly as
   * `services/booking.ts` stamps it — a fixture that invented a deadline would
   * be testing this file's arithmetic rather than the product's.
   */
  async function heldWithDeposit(
    id: string,
    memberId: string,
    startsMin: number,
    durationMin: number,
    depositFils: number,
  ): Promise<void> {
    const salonId = SALON;
    const branchId = BRANCH;
    const artistId = ARTIST;
    const serviceId = SVC;
    const holdId = `TX-DHH${Math.floor(Math.random() * 900_000 + 100_000)}`;
    await exec(sql`
      INSERT INTO "transaction"
        (id, member_id, salon_id, branch_id, kind, amount_fils, method, status, reference, created_at, settled_at)
      VALUES (${holdId}, ${memberId}, ${salonId}, ${MONEY_BRANCH}, 'deposit_hold', ${-depositFils},
              'wallet', 'settled', ${`AVO-DEP-${holdId.slice(3)}`}, now(), now())`);
    await exec(sql`
      UPDATE member SET balance_fils = balance_fils - ${depositFils} WHERE id = ${memberId}`);
    await exec(sql`
      INSERT INTO ledger_entry (transaction_id, salon_id, member_id, account, direction, amount_fils, balance_after_fils)
      VALUES
        (${holdId}, ${salonId}, ${memberId}, 'member_wallet', 'debit', ${depositFils},
         (SELECT balance_fils FROM member WHERE id = ${memberId})),
        (${holdId}, ${salonId}, NULL, 'deposit_held', 'credit', ${depositFils}, NULL)`);
    await exec(sql`
      INSERT INTO booking
        (id, salon_id, branch_id, branch_assumed, member_id, artist_id, service_id,
         starts_at, ends_at, duration_min, deposit_fils, status, source,
         hold_transaction_id, settled_transaction_id, no_show_return_due_at)
      VALUES (${id}, ${salonId}, ${branchId}, false, ${memberId}, ${artistId}, ${serviceId},
              ${t(startsMin)}::timestamptz,
              ${t(startsMin + durationMin)}::timestamptz,
              ${durationMin}, ${depositFils}, 'deposit_held', 'app',
              ${holdId}, NULL,
              ${t(startsMin + durationMin + 60)}::timestamptz)`);
  }

  /**
   * A WALK-IN the front desk wrote down. Zero deposit, no hold, no member —
   * `booking_merchant_is_zero_deposit` and `booking_deposit_matches_hold` make
   * all three the same fact, which is why she cannot move the held total.
   */
  async function heldGuest(
    id: string,
    startsMin: number,
    durationMin: number,
    salonId = SALON,
    branchId = BRANCH,
    artistId = ARTIST,
    serviceId = SVC,
  ): Promise<void> {
    await exec(sql`
      INSERT INTO booking
        (id, salon_id, branch_id, branch_assumed, member_id, guest_name, guest_phone,
         artist_id, service_id, starts_at, ends_at, duration_min, deposit_fils,
         status, source, hold_transaction_id, settled_transaction_id, no_show_return_due_at)
      VALUES (${id}, ${salonId}, ${branchId}, false, NULL, ${`DH Walk-in ${RUN}`}, '+96550001111',
              ${artistId}, ${serviceId},
              ${t(startsMin)}::timestamptz,
              ${t(startsMin + durationMin)}::timestamptz,
              ${durationMin}, 0, 'deposit_held', 'merchant', NULL, NULL,
              ${t(startsMin + durationMin + 60)}::timestamptz)`);
  }

  /**
   * A RESOLVED, MONEYLESS booking for a member — the shape spec 8 counts.
   *
   * Zero-deposit `merchant` rows, so no hold and no ledger: with
   * `hold_transaction_id IS NULL` the state machine's ELSE branch requires
   * `settled_transaction_id IS NULL`, which is what lets a terminal row exist
   * here without inventing a `deposit_return` nobody paid.
   */
  async function resolved(
    id: string,
    memberId: string,
    status: 'no_show_returned' | 'cancelled' | 'completed',
    startsMin: number,
    salonId = SALON,
    branchId = BRANCH,
    artistId = ARTIST,
    serviceId = SVC,
  ): Promise<void> {
    const stamp =
      status === 'no_show_returned'
        ? sql`returned_at`
        : status === 'cancelled'
          ? sql`cancelled_at`
          : sql`completed_at`;
    await exec(sql`
      INSERT INTO booking
        (id, salon_id, branch_id, branch_assumed, member_id, artist_id, service_id,
         starts_at, ends_at, duration_min, deposit_fils, status, source,
         hold_transaction_id, settled_transaction_id, no_show_return_due_at, ${stamp})
      VALUES (${id}, ${salonId}, ${branchId}, false, ${memberId}, ${artistId}, ${serviceId},
              ${t(startsMin)}::timestamptz,
              ${t(startsMin + 30)}::timestamptz,
              30, 0, ${status}, 'merchant', NULL, NULL,
              ${t(startsMin + 90)}::timestamptz, now())`);
  }

  const body = (res: { json: () => unknown }): DepositHealthWire =>
    res.json() as DepositHealthWire;

  const rowFor = (b: DepositHealthWire, id: string): DepositRowWire => {
    const row = b.rows.find((r) => r.bookingId === id);
    if (!row) throw new Error(`${id} is not in the row list: ${b.rows.map((r) => r.bookingId)}`);
    return row;
  };

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    sql = (await import('drizzle-orm')).sql;
    issueSession = (await import('../auth/sessions')).issueSession;
    app = await (await import('../app')).buildApp();

    await exec(sql`
      INSERT INTO branch (id, salon_id, name)
      VALUES (${BRANCH}, ${SALON}, ${`DH Int Branch ${RUN}`})`);
    /**
     * NO `branch_id` ON EITHER ARTIST. `artist.branch_id` is nullable — migration
     * 0044 leaves every multi-branch roster in exactly that state — and leaving
     * it null means the ONLY rows referencing this file's branch are its own
     * bookings, which `afterAll` deletes. That is what lets the branch itself be
     * deleted, which is what keeps `artistBranch.int.test.ts` and
     * `devices.int.test.ts` true: both assert SAL-AMARA has exactly two OPEN
     * branches, and a third one left behind fails them with a message about the
     * seed rather than about this file.
     */
    await exec(sql`
      INSERT INTO artist (id, salon_id, name) VALUES
        (${ARTIST}, ${SALON}, ${`DH Int Artist ${RUN}`}),
        (${LUM_ARTIST}, ${OTHER_SALON}, ${`DH Lum Artist ${RUN}`})`);
    await exec(sql`
      INSERT INTO service (id, salon_id, name, price_fils) VALUES
        (${SVC}, ${SALON}, ${`DH Int Service ${RUN}`}, 8000),
        (${LUM_SVC}, ${OTHER_SALON}, ${`DH Lum Service ${RUN}`}, 8000)`);

    /**
     * LUMIERE'S OWN MANAGER, WITH EVERY PERMISSION ON. Her refusal in spec 4 can
     * then only ever be tenancy, never a missing permission —
     * `customerDirectory.int.test.ts` mints a second manager for the same reason.
     */
    await exec(sql`
      INSERT INTO staff_user
        (id, salon_id, name, handle, role, branch_access_all, branch_access_ids,
         password_hash, perm_dashboard, perm_appointments, perm_shop, perm_loyalty,
         perm_team, perm_scanner, perm_charges, perm_void, perm_marketing)
      VALUES (${LUM_STAFF}, ${OTHER_SALON}, ${`DH Lum Mgr ${RUN}`}, ${`dh-lum-${RUN}`},
              'manager', true, '{}', 'x', true, true, true, true, true, true, true, true, true)`);

    awaitMember = await customer();
    returnMember = await customer();
    futureMember = await customer();
    historyMember = await customer();

    /**
     * THE FOUR HELD ROWS. Spaced so no two overlap on the one artist —
     * `booking_artist_slot_no_overlap` spans every kind of appointment.
     *
     *   -45m  slot started, deadline is 45 MINUTES AWAY   → awaiting_arrival
     *   -8h   deadline passed 6.5h ago, deposit still held → return_overdue
     *   -10h  deadline passed, zero deposit, nothing owed  → unclosed
     *   +5h   not started                                  → scheduled
     */
    await heldWithDeposit(BK_AWAIT, awaitMember, -45, 30, AWAIT_FILS);
    await heldWithDeposit(BK_RETURN, returnMember, -480, 30, RETURN_FILS);
    await heldGuest(BK_UNCLOSED, -600, 30);
    await heldWithDeposit(BK_FUTURE, futureMember, 300, 30, FUTURE_FILS);

    // Lumiere's own held row. Moneyless, for the reason `BK_LUM` carries.
    await heldGuest(BK_LUM, -120, 30, OTHER_SALON, OTHER_BRANCH, LUM_ARTIST, LUM_SVC);

    /**
     * SPEC 8's HISTORY. Two returned no-shows in this salon, one in ANOTHER
     * salon's id on the same member — nothing in the schema ties
     * `booking.salon_id` to `member.salon_id`, so that row is representable and
     * is exactly what the predicate's salon scoping is for — plus a cancel and a
     * completion, neither of which is a no-show.
     */
    await resolved(`DH-BK-NS1-${RUN}`, historyMember, 'no_show_returned', -3000);
    await resolved(`DH-BK-NS2-${RUN}`, historyMember, 'no_show_returned', -3200);
    await resolved(
      `DH-BK-NSX-${RUN}`,
      historyMember,
      'no_show_returned',
      -3400,
      OTHER_SALON,
      OTHER_BRANCH,
      LUM_ARTIST,
      LUM_SVC,
    );
    await resolved(`DH-BK-CAN-${RUN}`, historyMember, 'cancelled', -3600);
    await resolved(`DH-BK-CMP-${RUN}`, historyMember, 'completed', -3800);

    managerBearer = await web(MANAGER);
    frontdeskBearer = await web(FRONTDESK);
    lumiereBearer = await web(LUM_STAFF, OTHER_SALON);
  });

  /**
   * THIS FILE DELETES ITS OWN BOOKINGS, for the EXCLUDE constraint's reason.
   * Only the bookings and the scaffolding around them: `ledger_entry` is
   * append-only at the ROLE level (migration 0038) and every pair written here
   * is balanced, so `db:verify` holds over what is left behind.
   */
  afterAll(async () => {
    if (db && sql) {
      await exec(sql`DELETE FROM booking WHERE id LIKE ${`DH-BK-%${RUN}`}`);
      /**
       * AND THEN THE BRANCH, once nothing references it. See the artist insert:
       * two other int files assert SAL-AMARA has exactly two OPEN branches, and
       * they are right to — a fixture branch that outlives its file turns their
       * precondition into a false alarm about the seed.
       */
      await exec(sql`DELETE FROM branch WHERE id = ${BRANCH}`);
      await exec(sql`UPDATE staff_user SET perm_appointments = true WHERE id = ${MANAGER}`);
    }
    await app?.close();
  });

  // ================================================== #7, CALLED DIRECTLY ==
  it('1 · refused without perms.appointments, called directly', async () => {
    await exec(sql`UPDATE staff_user SET perm_appointments = false WHERE id = ${MANAGER}`);
    try {
      const bearer = await web(MANAGER);
      const res = await get({ bearer });
      expect(res.statusCode, res.body).toBe(403);
      /**
       * THE COPY IS THE DISCRIMINATOR. `requireSameSalon` answers 403 too, so a
       * status-code assertion alone would not prove WHICH gate fired.
       */
      expect((res.json() as { message: string }).message).toBe(
        "You don't have permission to see appointments. A manager can grant it.",
      );
    } finally {
      await exec(sql`UPDATE staff_user SET perm_appointments = true WHERE id = ${MANAGER}`);
    }
  });

  it('2 · the front desk, who has appointments and NOT void, is allowed', async () => {
    const res = await get({ bearer: frontdeskBearer });
    expect(res.statusCode, res.body).toBe(200);
    expect(body(res).held.bookings).toBe(4);
  });

  // ============================================================ tenancy ==
  it('3 · tenancy · Amara cannot address Lumiere in the path', async () => {
    const res = await get({ salonId: OTHER_SALON, branch: null });
    expect(res.statusCode, res.body).toBe(403);
    expect((res.json() as { message: string }).message).toBe('That salon is not yours.');
  });

  it('4 · tenancy · Lumiere reads her own salon and sees none of Amara', async () => {
    /**
     * SALON-WIDE, NOT `?branch=`. A cross-tenant leak hidden behind a branch
     * filter would be invisible: Amara's rows are on Amara's branch, so the
     * filter alone would exclude them whether or not the salon predicate is
     * doing anything. Without it, dropping `salon_id` from the WHERE puts all
     * four Amara rows and 15.000 KD into this payload.
     */
    const res = await get({ bearer: lumiereBearer, salonId: OTHER_SALON, branch: null });
    expect(res.statusCode, res.body).toBe(200);
    const b = body(res);

    // Her own row, and only her own.
    expect(b.held.bookings).toBe(1);
    expect(b.rows.map((r) => r.bookingId)).toEqual([BK_LUM]);
    /**
     * ZERO, AND IT IS A LOAD-BEARING ZERO. Lumiere holds no deposits at all, so
     * a salon predicate that stopped doing anything would put Amara's entire
     * 15.000 KD escrow in front of another salon's manager — which is the
     * failure this spec exists to make impossible, not merely unlikely.
     */
    expect(b.held.fils).toBe(0);
    expect(b.overdue.fils).toBe(0);
    for (const id of [BK_AWAIT, BK_RETURN, BK_UNCLOSED, BK_FUTURE]) {
      expect(b.rows.map((r) => r.bookingId)).not.toContain(id);
    }
  });

  // ============================================================== money ==
  it('5 · the held total is integer fils and is the sum of what it covers', async () => {
    const res = await get();
    expect(res.statusCode, res.body).toBe(200);
    const b = body(res);

    // Non-negotiable #1: a money field that is not an integer is the defect.
    expect(Number.isInteger(b.held.fils)).toBe(true);
    expect(Number.isInteger(b.scheduled.fils)).toBe(true);
    expect(Number.isInteger(b.overdue.fils)).toBe(true);

    expect(b.held.fils).toBe(AWAIT_FILS + RETURN_FILS + FUTURE_FILS);
    expect(b.held.bookings).toBe(4);

    // The whole is exactly its two parts — the split cannot lose or invent money.
    expect(b.scheduled.fils + b.overdue.fils).toBe(b.held.fils);
    expect(b.scheduled.bookings + b.overdue.bookings).toBe(b.held.bookings);
    expect(b.scheduled.fils).toBe(FUTURE_FILS);
    expect(b.overdue.fils).toBe(AWAIT_FILS + RETURN_FILS);

    /**
     * AND THE ROWS IT CLAIMS TO COVER. `rowsTruncated` false means the list is
     * the whole overdue set, so the sum over it must be the figure — this is
     * the assertion that catches an aggregate filtering a different set from
     * the one the merchant is reading.
     */
    expect(b.rowsTruncated).toBe(false);
    expect(b.rows).toHaveLength(b.overdue.bookings);
    expect(b.rows.reduce((sum, r) => sum + r.depositFils, 0)).toBe(b.overdue.fils);

    // And the three states partition the overdue set.
    expect(
      b.overdue.awaitingArrival.bookings +
        b.overdue.returnOverdue.bookings +
        b.overdue.unclosed.bookings,
    ).toBe(b.overdue.bookings);
    expect(b.overdue.awaitingArrival.fils + b.overdue.returnOverdue.fils).toBe(b.overdue.fils);
  });

  // ======================================== the distinction, in one call ==
  it('6 · overdue is not one state: awaiting_arrival, return_overdue, unclosed', async () => {
    const res = await get();
    const b = body(res);

    /**
     * SHE IS LATE AND THE GRACE WINDOW HAS NOT RUN OUT. The client's customer,
     * and the only one of the three that is about a customer at all.
     */
    const waiting = rowFor(b, BK_AWAIT);
    expect(waiting.state).toBe('awaiting_arrival');
    expect(waiting.depositFils).toBe(AWAIT_FILS);
    expect(waiting.overdueMinutes).toBeGreaterThanOrEqual(45);
    expect(waiting.overdueMinutes).toBeLessThan(60);
    // Nothing is due back yet, so there is no "due back this long ago".
    expect(waiting.returnOverdueMinutes).toBeNull();
    expect(new Date(waiting.noShowReturnDueAt).getTime()).toBeGreaterThan(Date.now());

    /**
     * THE NO-SHOW JOB HAS NOT DONE ITS WORK. `services/noShowWorker.ts` selects
     * on exactly this predicate, so the customer is owed her deposit back and
     * has not got it — an operational signal about AVO, not about her.
     */
    const owed = rowFor(b, BK_RETURN);
    expect(owed.state).toBe('return_overdue');
    expect(owed.depositFils).toBe(RETURN_FILS);
    expect(owed.returnOverdueMinutes).not.toBeNull();
    expect(owed.returnOverdueMinutes as number).toBeGreaterThanOrEqual(390);
    expect(owed.returnOverdueMinutes as number).toBeLessThan(405);
    expect(new Date(owed.noShowReturnDueAt).getTime()).toBeLessThan(Date.now());

    /**
     * PAST THE SAME DEADLINE WITH NO MONEY BEHIND IT. `noShowWorker` excludes
     * these rows on purpose, so this is NOT a stuck worker — it is a
     * hand-written appointment nobody closed, and counting it as `return_overdue`
     * would inflate an AVO fault count with the salon's own book-keeping.
     */
    const open = rowFor(b, BK_UNCLOSED);
    expect(open.state).toBe('unclosed');
    expect(open.depositFils).toBe(0);
    expect(open.returnOverdueMinutes).toBeNull();
    expect(new Date(open.noShowReturnDueAt).getTime()).toBeLessThan(Date.now());

    // One of each, and the money attributed to the two that have any.
    expect(b.overdue.awaitingArrival).toEqual({ bookings: 1, fils: AWAIT_FILS });
    expect(b.overdue.returnOverdue.bookings).toBe(1);
    expect(b.overdue.returnOverdue.fils).toBe(RETURN_FILS);
    expect(b.overdue.unclosed.bookings).toBe(1);

    /**
     * THE QUALIFIERS COME OUT OF THE SAME AGGREGATE AS THE COUNTS THEY QUALIFY,
     * so they must name rows inside the set those counts counted.
     */
    expect(b.overdue.oldestStartedAt).toBe(open.startsAt);
    expect(b.overdue.returnOverdue.dueSince).toBe(owed.noShowReturnDueAt);
    expect(b.overdue.unclosed.oldestStartedAt).toBe(open.startsAt);

    // Oldest slot first — a queue, never a ranking of customers.
    expect(b.rows.map((r) => r.bookingId)).toEqual([BK_UNCLOSED, BK_RETURN, BK_AWAIT]);

    // The future booking is held and is NOT overdue.
    expect(b.rows.map((r) => r.bookingId)).not.toContain(BK_FUTURE);
    expect(b.scheduled).toEqual({ bookings: 1, fils: FUTURE_FILS });
  });

  // ============================================================== guests ==
  it('7 · a walk-in appears with her own name and contributes zero', async () => {
    const res = await get();
    const b = body(res);
    const guest = rowFor(b, BK_UNCLOSED);

    expect(guest.memberId).toBeNull();
    expect(guest.guestName).toBe(`DH Walk-in ${RUN}`);
    expect(guest.guestPhone).toBe('+96550001111');
    expect(guest.memberName).toBeNull();
    // No member, so no erasure and no member phone — never the `+990` tombstone.
    expect(guest.memberErased).toBe(false);
    expect(guest.memberPhone).toBeNull();
    expect(guest.source).toBe('merchant');

    /**
     * SHE IS COUNTED AND SHE MOVES NO MONEY. Non-negotiable #2 is why:
     * merchant-created bookings never hold a deposit, so a figure about held
     * deposits that she inflated would be a claim about customers' money that
     * nobody ever took.
     */
    expect(guest.depositFils).toBe(0);
    expect(b.overdue.bookings).toBe(3);
    expect(b.overdue.fils).toBe(AWAIT_FILS + RETURN_FILS);
    expect(b.held.bookings).toBe(4);
    expect(b.held.fils).toBe(AWAIT_FILS + RETURN_FILS + FUTURE_FILS);
  });

  // ========================================== the count, and only a count ==
  it('8 · the no-show count is per member and does not cross a salon', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/salons/${SALON}/customers/${historyMember}`,
      headers: { authorization: `Bearer ${managerBearer}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    const m = res.json() as { noShowCount: number; visits: number; id: string };

    /**
     * TWO, NOT THREE AND NOT FIVE.
     *
     *   three  would mean the row written under Lumiere's salon id — a shape
     *          nothing in the schema forbids — is being counted here
     *   four   would mean `cancelled` counts, which would punish the customer
     *          who did the considerate thing
     *   five   would mean every terminal booking counts
     */
    expect(m.noShowCount).toBe(2);
    expect(m.id).toBe(historyMember);
    // Beside her visits, which this must not have disturbed.
    expect(m.visits).toBe(0);

    /**
     * AND THE SAME MEMBER READ FROM LUMIERE IS NOT READABLE AT ALL — the count
     * cannot leak the other way either, because the member lookup is
     * salon-scoped before the count is ever taken.
     */
    const cross = await app.inject({
      method: 'GET',
      url: `/salons/${OTHER_SALON}/customers/${historyMember}`,
      headers: { authorization: `Bearer ${lumiereBearer}` },
    });
    expect(cross.statusCode).toBe(404);
  });
});
