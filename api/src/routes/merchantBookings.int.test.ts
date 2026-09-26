/**
 * THE APPOINTMENT THE FRONT DESK WROTE — client asks 5 and 6.
 *
 *   POST /salons/{id}/bookings                   create by hand, member OR walk-in
 *   POST /salons/{id}/bookings/{id}/reschedule   change the date and time
 *   POST /salons/{id}/bookings/{id}/reassign     change the artist
 *   POST /salons/{id}/bookings/{id}/cancel       cancel
 *   POST /salons/{id}/bookings/{id}/complete     mark completed
 *
 * WHAT EACH SPEC IS EVIDENCE FOR:
 *
 *   1-5   the gate, called DIRECTLY with the permission off, one per endpoint
 *         (non-negotiable #7, in its own words)
 *   6     a merchant create and an app booking cannot overlap on one artist —
 *         APP FIRST, then the merchant create
 *   7     the same, THE OTHER WAY ROUND — merchant first, then the app booking
 *   8     zero deposit: a merchant create for an EXISTING member leaves her
 *         balance untouched and writes no transaction row at all (#2)
 *   9     a guest appointment comes back from the merchant's own board with her
 *         name on it — the `leftJoin` fix
 *  10     `complete` refuses a deposit-bearing booking and names the counter
 *  11     `complete` on a zero-deposit booking works
 *  12     reassign respects the exclusion constraint
 *  13     reassign onto a free artist works, and the branch moves with her
 *  14     tenancy: salon A cannot create under salon B's id
 *  15     tenancy: salon A cannot mutate a booking under salon B's id
 *  16     reschedule carries an app booking's deposit and moves no money
 *  17     cancel of a MERCHANT booking returns nothing and writes no transaction
 *  18     cancel of an APP booking returns the real deposit
 *  19     the change window does NOT apply to the merchant
 *  20     exactly one of memberId / guestName
 *  21     a double-submitted create replays rather than answering `slot_taken`
 *  22     the guest's day is the artist's day too — GET /artists/me/bookings
 *  23-25  THE RELAXED CHECKS STILL BIND AN `app` ROW: the state machine, the
 *         positive deposit, the member, and a merchant row that can never carry
 *         money. Driven at the database, because that is where the claim lives.
 *  26-28  the ZERO-DEPOSIT NO-SHOW: a hand-written appointment can be marked,
 *         for a member and for a guest, and marking it moves no money at all
 *  29     `?source=` on the board, and its refusal
 *
 * THE APP BOOKING IN SPECS 6, 7, 10, 16 AND 18 IS A FIXTURE INSERT, not a call
 * to `POST /bookings`, and that is deliberate rather than a shortcut. The real
 * customer path validates `startsAt` against `computeAvailability`, so driving it
 * would pin these specs to one artist's published window on one weekday and make
 * them fail for a reason that has nothing to do with what they test. The fixture
 * writes the SAME ROW the real path writes — the `deposit_hold` transaction, the
 * balanced ledger pair, the wallet debit and the booking pointing at the hold —
 * so what specs 6 and 7 exercise is the database constraint itself, which is the
 * claim: `booking_artist_slot_no_overlap` spans both kinds of appointment because
 * there is one table.
 *
 * THIS FILE LIVES FAR IN THE FUTURE. `booking_artist_slot_no_overlap` is an
 * EXCLUDE over (artist, time range), so two int files sharing an artist share a
 * slot space — `noShowMark.int.test.ts` records the collision. Every fixture here
 * is offset by a per-run number of DAYS, not minutes, so it cannot land in
 * another file's window or in a previous run's.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const SALON = 'SAL-AMARA';
/** A real second salon in the seed — the tenancy specs need one that exists. */
const OTHER_SALON = 'SAL-LUMIERE';
const BRANCH = 'BR-SAL';

/** Noura — manager, every permission. Holds `appointments` AND `void`. */
const MANAGER = 'ST-001';
/**
 * Hessa — frontdesk. `db/seed.ts § ST-002`: `perm_appointments = true` with
 * `perm_dashboard`, `perm_charges` and `perm_void` all FALSE.
 *
 * SHE IS THE FIXTURE THAT MAKES THE PERMISSION ARGUMENT REAL IN BOTH DIRECTIONS.
 * Specs 1-3 and 5 require her to be ALLOWED — booking appointments is the front
 * desk's job, and a gate that refused her would mean the feature does not exist
 * for the person it was asked for. Spec 4 requires her to be REFUSED on cancel,
 * because cancelling an app booking returns a customer's money.
 */
const FRONTDESK = 'ST-002';

/** 30-minute slots. */
const ARTIST_A = 'AR-001';
/** 45-minute slots, and the one a reassign moves onto. */
const ARTIST_B = 'AR-002';

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const SVC = `MB-SV-${RUN}`;
/**
 * DAYS, NOT MINUTES, and a fresh number every run. See the header: two int files
 * sharing an artist share a slot space, and a re-run minutes after the last one
 * lands inside its own previous ranges.
 */
const DAY_BASE = 400 + Math.floor(Math.random() * 900);

interface Created {
  booking: {
    id: string;
    memberId: string | null;
    guestName: string | null;
    guestPhone: string | null;
    artistId: string;
    branchId: string;
    status: string;
    source: string;
    depositFils: number;
    startsAt: string;
    endsAt: string;
    durationMin: number;
  };
}

suite('the merchant writes an appointment down, and then changes it', () => {
  let app: FastifyInstance;
  let db: (typeof import('../db/client'))['db'];
  let sql: (typeof import('drizzle-orm'))['sql'];
  let issueSession: (typeof import('../auth/sessions'))['issueSession'];

  let managerBearer = '';
  let frontdeskBearer = '';

  const exec = async (q: unknown) =>
    (await db.execute(q as never)) as unknown as Array<Record<string, unknown>>;

  /** A WEB session — these controls are drawn on the dashboard. */
  async function web(staffId: string, salonId = SALON): Promise<string> {
    const s = await issueSession(db, {
      principalKind: 'staff',
      staffId,
      salonId,
      scope: 'dashboard',
    });
    return s.accessToken;
  }

  /**
   * A customer of this file's own, funded THROUGH THE LEDGER. `db:verify`'s
   * invariant 5 is `member.balance_fils = sum(member_wallet entries)`, and a
   * fixture that sets a balance and walks away breaks it by exactly the opening
   * amount — `noShowMark.int.test.ts` measured twelve int prefixes doing that.
   */
  async function customer(): Promise<string> {
    const id = `MB-M-${randomUUID().slice(0, 8)}`;
    const openingTx = `MB-TX-OPEN-${id.slice(5)}`;
    await exec(sql`
      INSERT INTO member (id, salon_id, name, phone, password_hash, balance_fils, tier, visits, policy_version)
      VALUES (${id}, ${SALON}, 'MB Int Customer',
              ${`+9658${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`},
              '$argon2id$fake-not-a-credential', 150000, 'bronze', 0, 3)`);
    await exec(sql`
      INSERT INTO "transaction"
        (id, member_id, salon_id, branch_id, kind, amount_fils, status, reference, note, created_at, settled_at)
      VALUES (${openingTx}, ${id}, ${SALON}, ${BRANCH}, 'adjustment', 150000, 'settled',
              ${`AVO-OPEN-${id}`}, 'Opening fixture balance', now(), now())`);
    await exec(sql`
      INSERT INTO ledger_entry (transaction_id, salon_id, member_id, account, direction, amount_fils, balance_after_fils)
      VALUES
        (${openingTx}, ${SALON}, ${id}, 'member_wallet', 'credit', 150000, 150000),
        (${openingTx}, ${SALON}, NULL, 'gateway_clearing', 'debit', 150000, NULL)`);
    return id;
  }

  /** An instant `dayOffset` days and `minuteOffset` minutes from now. */
  const at = (dayOffset: number, minuteOffset = 0): string =>
    new Date(
      Date.now() + (DAY_BASE + dayOffset) * 86_400_000 + minuteOffset * 60_000,
    ).toISOString();

  /**
   * The same, in the PAST. The no-show specs need it: `markNoShow`'s time gate
   * refuses a mark before the slot has started, and that gate is kept for a
   * zero-deposit booking because it was never about the money — before the slot
   * starts there is no slot she can have failed to attend.
   */
  const ago = (dayOffset: number, minuteOffset = 0): string =>
    new Date(
      Date.now() - (DAY_BASE + dayOffset) * 86_400_000 - minuteOffset * 60_000,
    ).toISOString();

  /**
   * A REAL `app` BOOKING: the `deposit_hold` transaction, the balanced ledger
   * pair, the wallet debit and the row pointing at the hold. The same row
   * `services/booking.ts § createBooking` writes. See the file header for why it
   * is inserted rather than driven.
   */
  async function appBooking(
    memberId: string,
    artistId: string,
    startsAtIso: string,
    durationMin = 30,
  ): Promise<string> {
    const bkId = `MB-BK-${randomUUID().slice(0, 8)}`;
    const holdId = `TX-MBH${Math.floor(Math.random() * 900_000 + 100_000)}`;

    await exec(sql`
      INSERT INTO "transaction"
        (id, member_id, salon_id, branch_id, kind, amount_fils, method, status, reference, created_at, settled_at)
      VALUES (${holdId}, ${memberId}, ${SALON}, ${BRANCH}, 'deposit_hold', -5000, 'wallet', 'settled',
              ${`AVO-DEP-${holdId.slice(3)}`}, now(), now())`);
    await exec(sql`UPDATE member SET balance_fils = balance_fils - 5000 WHERE id = ${memberId}`);
    await exec(sql`
      INSERT INTO ledger_entry (transaction_id, salon_id, member_id, account, direction, amount_fils, balance_after_fils)
      VALUES
        (${holdId}, ${SALON}, ${memberId}, 'member_wallet', 'debit', 5000,
         (SELECT balance_fils FROM member WHERE id = ${memberId})),
        (${holdId}, ${SALON}, NULL, 'deposit_held', 'credit', 5000, NULL)`);

    await exec(sql`
      INSERT INTO booking
        (id, salon_id, branch_id, branch_assumed, member_id, artist_id, service_id,
         starts_at, ends_at, duration_min, deposit_fils, status, source,
         hold_transaction_id, settled_transaction_id, no_show_return_due_at)
      VALUES (${bkId}, ${SALON}, ${BRANCH}, false, ${memberId}, ${artistId}, ${SVC},
              ${startsAtIso}::timestamptz,
              ${startsAtIso}::timestamptz + ${`${durationMin} minutes`}::interval,
              ${durationMin}, 5000, 'deposit_held', 'app', ${holdId}, NULL,
              ${startsAtIso}::timestamptz + ${`${durationMin + 60} minutes`}::interval)`);
    return bkId;
  }

  // ------------------------------------------------------------ the callers --

  function create(
    body: Record<string, unknown>,
    opts: { bearer?: string; key?: string | null; salonId?: string } = {},
  ) {
    const headers: Record<string, string> = {
      authorization: `Bearer ${opts.bearer ?? managerBearer}`,
    };
    if (opts.key !== null) headers['idempotency-key'] = opts.key ?? `mb-${randomUUID()}`;
    return app.inject({
      method: 'POST',
      url: `/salons/${opts.salonId ?? SALON}/bookings`,
      headers,
      payload: body,
    });
  }

  function act(
    verb: 'reschedule' | 'reassign' | 'cancel' | 'complete',
    bookingId: string,
    body: Record<string, unknown> | undefined = undefined,
    opts: { bearer?: string; salonId?: string } = {},
  ) {
    return app.inject({
      method: 'POST',
      url: `/salons/${opts.salonId ?? SALON}/bookings/${bookingId}/${verb}`,
      headers: { authorization: `Bearer ${opts.bearer ?? managerBearer}` },
      ...(body ? { payload: body } : {}),
    });
  }

  /**
   * `POST .../no-show`. Separate from `act` because it is the one merchant
   * transition that takes an idempotency key — it can move money.
   */
  function noShow(bookingId: string, opts: { bearer?: string; salonId?: string } = {}) {
    return app.inject({
      method: 'POST',
      url: `/salons/${opts.salonId ?? SALON}/bookings/${bookingId}/no-show`,
      headers: {
        authorization: `Bearer ${opts.bearer ?? managerBearer}`,
        'idempotency-key': `mb-ns-${randomUUID()}`,
      },
    });
  }

  /** A merchant booking, made the real way, for a walk-in. */
  async function guestBooking(startsAtIso: string, artistId = ARTIST_A): Promise<Created> {
    const res = await create({
      artistId,
      serviceId: SVC,
      startsAt: startsAtIso,
      guestName: `Walk-in ${randomUUID().slice(0, 6)}`,
    });
    if (res.statusCode !== 201) throw new Error(`guest create failed: ${res.body}`);
    return res.json() as Created;
  }

  function one(rows: Array<Record<string, unknown>>, what: string): Record<string, unknown> {
    const row = rows[0];
    if (!row) throw new Error(`${what}: expected exactly one row, got none`);
    return row;
  }

  const balanceOf = async (memberId: string): Promise<number> =>
    Number(
      one(await exec(sql`SELECT balance_fils FROM member WHERE id = ${memberId}`), 'the member')
        .balance_fils,
    );

  const txCountFor = async (memberId: string): Promise<number> =>
    Number(
      one(
        await exec(sql`SELECT count(*)::int AS n FROM "transaction" WHERE member_id = ${memberId}`),
        'the transaction count',
      ).n,
    );

  const rowOf = async (bookingId: string): Promise<Record<string, unknown>> =>
    one(await exec(sql`SELECT * FROM booking WHERE id = ${bookingId}`), 'the booking');

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    sql = (await import('drizzle-orm')).sql;
    issueSession = (await import('../auth/sessions')).issueSession;
    app = await (await import('../app')).buildApp();

    await exec(sql`
      INSERT INTO service (id, salon_id, name, price_fils)
      VALUES (${SVC}, ${SALON}, ${`MB Int Service ${RUN}`}, 8000)`);

    managerBearer = await web(MANAGER);
    frontdeskBearer = await web(FRONTDESK);
  });

  /**
   * THIS FILE DELETES ITS OWN BOOKINGS, for the EXCLUDE constraint's reason. Only
   * the bookings: `ledger_entry` is append-only at the ROLE level (migration 0038)
   * and every pair written here is balanced, so `db:verify` holds over what is
   * left behind.
   */
  afterAll(async () => {
    if (db && sql) await exec(sql`DELETE FROM booking WHERE id LIKE 'MB-BK-%' OR service_id = ${SVC}`);
    await app?.close();
  });

  // ================================================== #7, CALLED DIRECTLY ==
  /**
   * FIVE SPECS, ONE PER GATED ENDPOINT, each calling it with the permission OFF.
   * Non-negotiable #7 in its own words: "Every gated endpoint needs a test that
   * calls it directly with the permission off."
   *
   * THE COPY IS THE DISCRIMINATOR IN EVERY ONE OF THEM. `requireSameSalon` and the
   * surface wall both answer 403 too, so a status-code assertion alone would not
   * prove WHICH gate fired — and on specs 1-3 and 5 that is the whole question,
   * because the permission being tested is one the OTHER account holds.
   */

  it('1 · create · a staff account without perms.appointments is refused', async () => {
    // Noura the manager holds everything, so the "off" account here is one with
    // the permission revoked for the length of this spec and put back after.
    await exec(sql`UPDATE staff_user SET perm_appointments = false WHERE id = ${MANAGER}`);
    try {
      const bearer = await web(MANAGER);
      const res = await create(
        { artistId: ARTIST_A, serviceId: SVC, startsAt: at(0), guestName: 'Refused' },
        { bearer },
      );
      expect(res.statusCode, res.body).toBe(403);
      expect((res.json() as { message: string }).message).toBe(
        "You don't have permission to see appointments. A manager can grant it.",
      );
      // And a refusal wrote nothing.
      expect(
        Number(
          one(
            await exec(sql`SELECT count(*)::int AS n FROM booking WHERE service_id = ${SVC}`),
            'the booking count',
          ).n,
        ),
      ).toBe(0);
    } finally {
      await exec(sql`UPDATE staff_user SET perm_appointments = true WHERE id = ${MANAGER}`);
    }
  });

  it('2 · reschedule · refused without perms.appointments', async () => {
    const bk = await guestBooking(at(1));
    const startsAtBefore = String((await rowOf(bk.booking.id)).starts_at);
    await exec(sql`UPDATE staff_user SET perm_appointments = false WHERE id = ${MANAGER}`);
    try {
      const bearer = await web(MANAGER);
      const res = await act('reschedule', bk.booking.id, { startsAt: at(1, 120) }, { bearer });
      expect(res.statusCode, res.body).toBe(403);
      expect((res.json() as { message: string }).message).toBe(
        "You don't have permission to see appointments. A manager can grant it.",
      );
      // Against the instant read BEFORE the call. Comparing the row to itself
      // afterwards would be green whatever the endpoint did.
      const after = await rowOf(bk.booking.id);
      expect(String(after.starts_at)).toBe(startsAtBefore);
      expect(Number(after.rescheduled_count)).toBe(0);
    } finally {
      await exec(sql`UPDATE staff_user SET perm_appointments = true WHERE id = ${MANAGER}`);
    }
  });

  it('3 · reassign · refused without perms.appointments', async () => {
    const bk = await guestBooking(at(2));
    await exec(sql`UPDATE staff_user SET perm_appointments = false WHERE id = ${MANAGER}`);
    try {
      const bearer = await web(MANAGER);
      const res = await act('reassign', bk.booking.id, { artistId: ARTIST_B }, { bearer });
      expect(res.statusCode, res.body).toBe(403);
      expect(String((await rowOf(bk.booking.id)).artist_id)).toBe(ARTIST_A);
    } finally {
      await exec(sql`UPDATE staff_user SET perm_appointments = true WHERE id = ${MANAGER}`);
    }
  });

  it('4 · cancel · perms.appointments is NOT enough — the frontdesk is refused', async () => {
    const bk = await guestBooking(at(3));
    const res = await act('cancel', bk.booking.id, undefined, { bearer: frontdeskBearer });
    expect(res.statusCode, res.body).toBe(403);
    /**
     * `PERMISSION_COPY.void`, VERBATIM — and this is the spec that proves the
     * cancel gate is not the one next door. Hessa holds `appointments` and is
     * allowed to create, move and reassign; she must not be able to end an
     * appointment, because on an app booking that is a customer's money coming
     * back.
     */
    expect((res.json() as { message: string }).message).toBe(
      "You don't have permission to void a charge. A manager can grant it.",
    );
    expect(String((await rowOf(bk.booking.id)).status)).toBe('deposit_held');
  });

  it('5 · complete · refused without perms.appointments', async () => {
    const bk = await guestBooking(at(4));
    await exec(sql`UPDATE staff_user SET perm_appointments = false WHERE id = ${MANAGER}`);
    try {
      const bearer = await web(MANAGER);
      const res = await act('complete', bk.booking.id, undefined, { bearer });
      expect(res.statusCode, res.body).toBe(403);
      expect(String((await rowOf(bk.booking.id)).status)).toBe('deposit_held');
    } finally {
      await exec(sql`UPDATE staff_user SET perm_appointments = true WHERE id = ${MANAGER}`);
    }
  });

  // ========================================== THE DOUBLE-BOOK, BOTH ORDERS ==
  /**
   * THE CLAIM MOST WORTH PROVING, and the reason there is one table rather than
   * two. A `manual_appointment` table would have left `booking` pristine and let
   * these two rows coexist, because an `EXCLUDE USING gist` cannot span two
   * tables. Both orders, because a constraint that only held one way would be a
   * race the front desk could win by being slower.
   */

  it('6 · an APP booking blocks a merchant create on the same artist and instant', async () => {
    const m = await customer();
    const t = at(10);
    await appBooking(m, ARTIST_A, t, 30);

    // Overlapping, not identical: 15 minutes in, which a UNIQUE index on
    // (artist_id, starts_at) would have let straight through.
    const res = await create({
      artistId: ARTIST_A,
      serviceId: SVC,
      startsAt: at(10, 15),
      guestName: 'Would-be double book',
    });

    expect(res.statusCode, res.body).toBe(409);
    expect((res.json() as { error: string }).error).toBe('slot_taken');
  });

  it('7 · a MERCHANT booking blocks an app booking on the same artist and instant', async () => {
    const t = at(11);
    await guestBooking(t);

    const m = await customer();
    // The app row, written exactly as `createBooking` writes it. The constraint
    // is what must refuse it — nothing in this file checks for an overlap.
    await expect(appBooking(m, ARTIST_A, at(11, 15), 30)).rejects.toMatchObject({
      code: '23P01',
    });
  });

  // ============================================== #2 — NO MONEY MOVES, EVER ==

  it('8 · a merchant create for an EXISTING member touches no money at all', async () => {
    const m = await customer();
    const balanceBefore = await balanceOf(m);
    const txBefore = await txCountFor(m);

    const res = await create({
      artistId: ARTIST_A,
      serviceId: SVC,
      startsAt: at(12),
      memberId: m,
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as Created;

    expect(body.booking.memberId).toBe(m);
    expect(body.booking.guestName).toBeNull();
    expect(body.booking.source).toBe('merchant');
    /** ZERO, AND NO HOLD BEHIND IT. Non-negotiable #2 at the row. */
    expect(body.booking.depositFils).toBe(0);
    expect((await rowOf(body.booking.id)).hold_transaction_id).toBeNull();

    // The two assertions the spec exists for.
    expect(await balanceOf(m)).toBe(balanceBefore);
    expect(await txCountFor(m)).toBe(txBefore);

    /**
     * AND NO LEDGER ENTRY EITHER. The balance and the transaction count would both
     * survive a posting that debited `member_wallet` and credited `deposit_held`
     * without updating the row — which is the failure this endpoint is shaped to
     * make impossible, so it is asserted rather than assumed.
     */
    expect(
      Number(
        one(
          await exec(sql`
            SELECT count(*)::int AS n FROM ledger_entry
             WHERE member_id = ${m} AND account = 'deposit_held'`),
          'the deposit_held postings',
        ).n,
      ),
    ).toBe(0);
  });

  // =============================== THE BOARD — the `leftJoin` fix, proved ==

  it('9 · a GUEST appointment comes back from the merchant board with her name', async () => {
    const name = `Walk-in ${randomUUID().slice(0, 6)}`;
    const res = await create({
      artistId: ARTIST_A,
      serviceId: SVC,
      startsAt: at(13),
      guestName: name,
      guestPhone: '+96599887766',
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = (res.json() as Created).booking.id;

    const board = await app.inject({
      method: 'GET',
      url: `/salons/${SALON}/bookings`,
      headers: { authorization: `Bearer ${managerBearer}` },
    });
    expect(board.statusCode, board.body).toBe(200);

    const items = (board.json() as { items: Array<Record<string, unknown>> }).items;
    const row = items.find((i) => i.id === id);
    /**
     * THE ASSERTION THE WHOLE FIX IS FOR. With the `innerJoin` this row is simply
     * NOT IN `items` — the appointment the front desk just made is missing from
     * the one screen the feature exists for.
     */
    expect(row, 'the guest appointment must be on the board').toBeTruthy();
    expect(row?.memberName).toBe(name);
    expect(row?.guestName).toBe(name);
    expect(row?.memberId).toBeNull();
    /** A guest has no account, so there is no erased account. */
    expect(row?.memberErased).toBe(false);
    expect(row?.memberPhone).toBe('+96599887766');
    /** And the member rows beside her are unchanged — the join is still total. */
    expect(items.length).toBeGreaterThan(0);
  });

  it('22 · and the guest is on the ARTIST’s day too', async () => {
    const name = `Walk-in ${randomUUID().slice(0, 6)}`;
    /**
     * AR-003 is Hessa's own artist row (`staff_user_id = 'ST-002'`), which is what
     * makes `GET /artists/me/bookings` resolve to a real artist for her PIN
     * session. The instant is inside the rolling 24 hours that endpoint serves, so
     * this one fixture deliberately sits near `now()` rather than out at DAY_BASE
     * — and on an artist no other spec in this file touches.
     */
    const soon = new Date(Date.now() + 90 * 60_000).toISOString();
    const res = await create({
      artistId: 'AR-003',
      serviceId: SVC,
      startsAt: soon,
      guestName: name,
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = (res.json() as Created).booking.id;

    const s = await issueSession(db, {
      principalKind: 'staff',
      staffId: FRONTDESK,
      salonId: SALON,
      scope: 'scanner',
      deviceId: 'DEV-SCANNER-01',
    });
    const day = await app.inject({
      method: 'GET',
      url: '/artists/me/bookings',
      headers: { authorization: `Bearer ${s.accessToken}` },
    });
    expect(day.statusCode, day.body).toBe(200);
    const row = (day.json() as { items: Array<Record<string, unknown>> }).items.find(
      (i) => i.id === id,
    );
    expect(row, 'the guest must be on the artist day').toBeTruthy();
    expect(row?.memberName).toBe(name);
  });

  // ================================================ COMPLETE — the refusal ==

  it('10 · complete REFUSES a deposit-bearing booking and names the counter', async () => {
    const m = await customer();
    const bk = await appBooking(m, ARTIST_A, at(14), 30);

    const res = await act('complete', bk);
    expect(res.statusCode, res.body).toBe(409);
    expect((res.json() as { error: string }).error).toBe('deposit_completed_at_the_counter');
    /** And it did not half-happen. */
    const row = await rowOf(bk);
    expect(String(row.status)).toBe('deposit_held');
    expect(row.completed_at).toBeNull();
  });

  it('11 · complete works on a zero-deposit booking, and settles nothing', async () => {
    const bk = await guestBooking(at(15));
    const res = await act('complete', bk.booking.id);
    expect(res.statusCode, res.body).toBe(200);

    const row = await rowOf(bk.booking.id);
    expect(String(row.status)).toBe('completed');
    expect(row.completed_at).not.toBeNull();
    /**
     * `settled_transaction_id` STAYS NULL, which is the whole point of the
     * conditional CHECK: a row with no hold names no settlement, because there is
     * no money for one to point at.
     */
    expect(row.settled_transaction_id).toBeNull();
  });

  // ==================================================== REASSIGN — the EXCLUDE ==

  it('12 · reassigning onto a BUSY artist is refused by the constraint', async () => {
    const t = at(16);
    // ARTIST_B is already booked at that instant, by hand.
    await guestBooking(t, ARTIST_B);
    // And this one is with ARTIST_A at the same instant.
    const moving = await guestBooking(t, ARTIST_A);

    const res = await act('reassign', moving.booking.id, { artistId: ARTIST_B });

    expect(res.statusCode, res.body).toBe(409);
    expect((res.json() as { error: string }).error).toBe('slot_taken');
    /**
     * NOTHING ABOUT THE MOVING BOOKING CHANGED — no status check and no
     * availability read would have caught this, because nothing about the row
     * being moved is different. Only the index knows.
     */
    expect(String((await rowOf(moving.booking.id)).artist_id)).toBe(ARTIST_A);
  });

  it('13 · reassigning onto a FREE artist works, and the branch moves with her', async () => {
    const bk = await guestBooking(at(17));
    const res = await act('reassign', bk.booking.id, { artistId: ARTIST_B });
    expect(res.statusCode, res.body).toBe(200);

    const row = await rowOf(bk.booking.id);
    expect(String(row.artist_id)).toBe(ARTIST_B);
    const artistBranch = one(
      await exec(sql`SELECT branch_id FROM artist WHERE id = ${ARTIST_B}`),
      'the artist branch',
    ).branch_id;
    if (artistBranch !== null) expect(row.branch_id).toBe(artistBranch);
  });

  // ======================================================== TENANCY ==

  it('14 · salon A cannot CREATE a booking under salon B’s id', async () => {
    const res = await create(
      { artistId: ARTIST_A, serviceId: SVC, startsAt: at(18), guestName: 'Not yours' },
      { salonId: OTHER_SALON },
    );
    expect(res.statusCode, res.body).toBe(403);
    expect((res.json() as { message: string }).message).toBe('That salon is not yours.');
    expect(
      Number(
        one(
          await exec(
            sql`SELECT count(*)::int AS n FROM booking WHERE salon_id = ${OTHER_SALON} AND service_id = ${SVC}`,
          ),
          'the other salon booking count',
        ).n,
      ),
    ).toBe(0);
  });

  it('15 · salon A cannot MUTATE one of its own bookings under salon B’s id', async () => {
    const bk = await guestBooking(at(19));
    for (const verb of ['reschedule', 'reassign', 'cancel', 'complete'] as const) {
      const body =
        verb === 'reschedule'
          ? { startsAt: at(19, 120) }
          : verb === 'reassign'
            ? { artistId: ARTIST_B }
            : undefined;
      const res = await act(verb, bk.booking.id, body, { salonId: OTHER_SALON });
      expect(res.statusCode, `${verb}: ${res.body}`).toBe(403);
      expect((res.json() as { message: string }).message).toBe('That salon is not yours.');
    }
    const row = await rowOf(bk.booking.id);
    expect(String(row.status)).toBe('deposit_held');
    expect(String(row.artist_id)).toBe(ARTIST_A);
    expect(Number(row.rescheduled_count)).toBe(0);
  });

  // ============================================ RESCHEDULE AND CANCEL ==

  it('16 · reschedule carries an app booking’s deposit and moves no money', async () => {
    const m = await customer();
    const bk = await appBooking(m, ARTIST_A, at(20), 30);
    const balanceBefore = await balanceOf(m);
    const txBefore = await txCountFor(m);

    const res = await act('reschedule', bk, { startsAt: at(20, 180) });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { depositCarriedFils: number }).depositCarriedFils).toBe(5000);

    const row = await rowOf(bk);
    expect(Number(row.rescheduled_count)).toBe(1);
    expect(Number(row.deposit_fils)).toBe(5000);
    expect(row.hold_transaction_id).not.toBeNull();
    /** The length is carried, not recomputed from the artist's slot. */
    expect(Number(row.duration_min)).toBe(30);
    expect(await balanceOf(m)).toBe(balanceBefore);
    expect(await txCountFor(m)).toBe(txBefore);
  });

  it('17 · cancelling a MERCHANT booking returns nothing and writes no transaction', async () => {
    const m = await customer();
    const res0 = await create({
      artistId: ARTIST_A,
      serviceId: SVC,
      startsAt: at(21),
      memberId: m,
    });
    expect(res0.statusCode, res0.body).toBe(201);
    const id = (res0.json() as Created).booking.id;

    const balanceBefore = await balanceOf(m);
    const txBefore = await txCountFor(m);

    const res = await act('cancel', id);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { refundedFils: number; transactionId: string | null };
    expect(body.refundedFils).toBe(0);
    /** PRESENT AND NULL, not omitted — a client must be able to tell the shapes apart. */
    expect(body.transactionId).toBeNull();

    const row = await rowOf(id);
    expect(String(row.status)).toBe('cancelled');
    expect(row.cancelled_at).not.toBeNull();
    expect(row.settled_transaction_id).toBeNull();
    expect(await balanceOf(m)).toBe(balanceBefore);
    expect(await txCountFor(m)).toBe(txBefore);

    // And a second cancel is refused rather than doing it again.
    const again = await act('cancel', id);
    expect(again.statusCode, again.body).toBe(409);
    expect((again.json() as { error: string }).error).toBe('already_cancelled');
  });

  it('18 · cancelling an APP booking returns the real deposit', async () => {
    const m = await customer();
    const bk = await appBooking(m, ARTIST_A, at(22), 30);
    const balanceBefore = await balanceOf(m);

    const res = await act('cancel', bk);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { refundedFils: number; transactionId: string | null };
    expect(body.refundedFils).toBe(5000);
    expect(body.transactionId).not.toBeNull();
    expect(await balanceOf(m)).toBe(balanceBefore + 5000);

    const row = await rowOf(bk);
    expect(String(row.status)).toBe('cancelled');
    /** The deposit-bearing branch DOES name the transaction that returned it. */
    expect(row.settled_transaction_id).toBe(body.transactionId);

    /**
     * BY ACCOUNT, not by balance. A balance moves for a dozen reasons and would
     * pass against a posting that took the money out of the salon's earnings.
     */
    const posting = one(
      await exec(sql`
        SELECT account, direction FROM ledger_entry
         WHERE transaction_id = ${body.transactionId} AND account = 'deposit_held'`),
      'the deposit_held release',
    );
    expect(posting.direction).toBe('debit');
  });

  it('19 · the change window does NOT apply to the merchant', async () => {
    /**
     * TEN MINUTES FROM NOW — inside the one-hour window that refuses a CUSTOMER
     * with `change_window_closed`. A front desk moving a 16:45 at 16:30 because
     * the artist is running late is the normal case, and this is the spec that
     * pins the decision. On an artist nobody else in this file uses, because it is
     * the one fixture that cannot sit at DAY_BASE.
     */
    const m = await customer();
    const soon = new Date(Date.now() + 10 * 60_000).toISOString();
    const bk = await appBooking(m, 'AR-004', soon, 60);

    const moved = await act('reschedule', bk, {
      startsAt: new Date(Date.now() + 200 * 60_000).toISOString(),
    });
    expect(moved.statusCode, moved.body).toBe(200);

    const cancelled = await act('cancel', bk);
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect((cancelled.json() as { refundedFils: number }).refundedFils).toBe(5000);
  });

  // ============================================================ THE FORM ==

  it('20 · exactly one of memberId and guestName', async () => {
    const m = await customer();
    /**
     * PINNED, because `at()` is relative to `Date.now()` and a second call
     * returns a DIFFERENT instant. A `starts_at = at(23)` in the count below
     * would match nothing whatever the endpoint did, and the spec would go green
     * against an endpoint that wrote both rows.
     */
    const t = at(23);
    const both = await create({
      artistId: ARTIST_A,
      serviceId: SVC,
      startsAt: t,
      memberId: m,
      guestName: 'Both',
    });
    expect(both.statusCode, both.body).toBe(400);
    expect((both.json() as { error: string }).error).toBe('identity_required');

    const neither = await create({ artistId: ARTIST_A, serviceId: SVC, startsAt: t });
    expect(neither.statusCode, neither.body).toBe(400);
    expect((neither.json() as { error: string }).error).toBe('identity_required');

    // And nothing was written by either refusal. Proved against a row that CAN
    // exist at this instant: one is written here, and the count must be exactly
    // that one rather than three.
    const ok = await create({ artistId: ARTIST_A, serviceId: SVC, startsAt: t, memberId: m });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(
      Number(
        one(
          await exec(sql`
            SELECT count(*)::int AS n FROM booking
             WHERE service_id = ${SVC} AND starts_at = ${t}::timestamptz`),
          'the booking count',
        ).n,
      ),
    ).toBe(1);
  });


  // ====================================== THE RELAXED CHECKS STILL BIND ==
  /**
   * THREE SPECS DRIVEN AT THE DATABASE, because the claim is about the database.
   *
   * Migration 0056 relaxed four constraints so that a moneyless row could exist.
   * The claim made in its header is that AN `app` ROW IS NO WEAKER THAN IT WAS,
   * and the only honest way to test that is to try to write the rows the old
   * constraints refused and require the new ones to refuse them too. A handler
   * test cannot do it: no handler in this API would attempt any of these, which
   * is exactly why a relaxation that quietly permitted them would ship green.
   */

  it('23 \u00b7 an `app` booking still cannot be completed without naming the charge', async () => {
    const m = await customer();
    const bk = await appBooking(m, ARTIST_A, at(25), 30);

    /**
     * `booking_settlement_matches_status`, THE `THEN` BRANCH. The row has a hold,
     * so the biconditional applies exactly as it did before 0056: a `completed`
     * status with a null `settled_transaction_id` does not commit.
     */
    await expect(
      exec(sql`
        UPDATE booking SET status = 'completed', completed_at = now()
         WHERE id = ${bk}`),
    ).rejects.toMatchObject({ constraint_name: 'booking_settlement_matches_status' });

    // And a cancel without naming the refund is refused by the same branch.
    await expect(
      exec(sql`
        UPDATE booking SET status = 'cancelled', cancelled_at = now()
         WHERE id = ${bk}`),
    ).rejects.toMatchObject({ constraint_name: 'booking_settlement_matches_status' });

    expect(String((await rowOf(bk)).status)).toBe('deposit_held');
  });

  it('24 \u00b7 a hold still forces a positive deposit, and a guest still forces `merchant`', async () => {
    const m = await customer();
    const bk = await appBooking(m, ARTIST_A, at(26), 30);

    /**
     * WHAT `booking_deposit_positive` USED TO SAY, still true of every row with a
     * hold. `booking_deposit_matches_hold` is the constraint that says it now.
     */
    await expect(
      exec(sql`UPDATE booking SET deposit_fils = 0 WHERE id = ${bk}`),
    ).rejects.toMatchObject({ constraint_name: 'booking_deposit_matches_hold' });

    /** And the floor the biconditional alone would have lost. */
    await expect(
      exec(sql`UPDATE booking SET deposit_fils = -5000, hold_transaction_id = NULL WHERE id = ${bk}`),
    ).rejects.toMatchObject({ constraint_name: 'booking_deposit_non_negative' });

    /** WHAT `member_id NOT NULL` USED TO SAY: an `app` booking names a member. */
    await expect(
      exec(sql`UPDATE booking SET member_id = NULL, guest_name = 'Smuggled' WHERE id = ${bk}`),
    ).rejects.toMatchObject({ constraint_name: 'booking_guest_requires_merchant_source' });

    /**
     * NEVER BOTH, NEVER NEITHER — driven on a MERCHANT row, because on an `app`
     * row `booking_guest_requires_merchant_source` fires first and the assertion
     * would pass while saying nothing about the constraint it names.
     */
    const merchantRow = await guestBooking(at(26, 180));
    await expect(
      exec(sql`UPDATE booking SET member_id = ${m} WHERE id = ${merchantRow.booking.id}`),
    ).rejects.toMatchObject({ constraint_name: 'booking_identity_exactly_one' });
    await expect(
      exec(sql`UPDATE booking SET guest_name = NULL WHERE id = ${merchantRow.booking.id}`),
    ).rejects.toMatchObject({ constraint_name: 'booking_identity_exactly_one' });

    expect(Number((await rowOf(bk)).deposit_fils)).toBe(5000);
  });

  it('25 \u00b7 a `merchant` row can never carry a deposit \u2014 #2, at the database', async () => {
    const bk = await guestBooking(at(27));
    const m = await customer();
    // A real hold transaction exists to point at, so the only thing refusing this
    // is the constraint rather than a missing foreign key.
    const holdId = `TX-MBX${Math.floor(Math.random() * 900_000 + 100_000)}`;
    await exec(sql`
      INSERT INTO "transaction"
        (id, member_id, salon_id, branch_id, kind, amount_fils, method, status, reference, created_at, settled_at)
      VALUES (${holdId}, ${m}, ${SALON}, ${BRANCH}, 'deposit_hold', -5000, 'wallet', 'settled',
              ${`AVO-DEP-${holdId.slice(3)}`}, now(), now())`);

    await expect(
      exec(sql`
        UPDATE booking SET deposit_fils = 5000, hold_transaction_id = ${holdId}
         WHERE id = ${bk.booking.id}`),
    ).rejects.toMatchObject({ constraint_name: 'booking_merchant_is_zero_deposit' });

    expect(Number((await rowOf(bk.booking.id)).deposit_fils)).toBe(0);
    expect((await rowOf(bk.booking.id)).hold_transaction_id).toBeNull();
  });


  // ============================== THE ZERO-DEPOSIT NO-SHOW — attendance, not money ==
  /**
   * A NO-SHOW IS A FACT ABOUT ATTENDANCE. A walk-in the front desk wrote in who
   * does not turn up is a no-show in exactly the sense the salon means, and the
   * only thing that argued otherwise was that the status value is spelled
   * `no_show_returned` — a naming problem already contained at the display
   * boundary rather than fixed with a four-way enum break.
   *
   * These three specs are the server half of that containment. What they are
   * really pinning is an ABSENCE: the transition happens and NOTHING ELSE DOES.
   */

  it('26 · a zero-deposit booking for a MEMBER can be marked, and no money moves', async () => {
    const m = await customer();
    // In the past, because the time gate is kept: before the slot starts there is
    // no slot she can have failed to attend, deposit or no deposit.
    const made = await create({
      artistId: ARTIST_A,
      serviceId: SVC,
      startsAt: ago(1),
      memberId: m,
    });
    expect(made.statusCode, made.body).toBe(201);
    const id = (made.json() as Created).booking.id;

    const balanceBefore = await balanceOf(m);
    const txBefore = await txCountFor(m);

    const res = await noShow(id);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as {
      refundedFils: number;
      balanceAfterFils: number | null;
      transactionId: string | null;
      booking: { status: string };
    };

    expect(body.booking.status).toBe('no_show_returned');
    expect(body.refundedFils).toBe(0);
    /** PRESENT AND NULL on both, never omitted — `cancelByMerchant`'s shape. */
    expect(body.transactionId).toBeNull();
    expect(body.balanceAfterFils).toBeNull();

    /** THE TWO ASSERTIONS THE SPEC EXISTS FOR, the way spec 8 makes them. */
    expect(await balanceOf(m)).toBe(balanceBefore);
    expect(await txCountFor(m)).toBe(txBefore);

    const row = await rowOf(id);
    expect(String(row.status)).toBe('no_show_returned');
    expect(row.returned_at).not.toBeNull();
    /** Nothing settled it, because there was nothing to settle. */
    expect(row.settled_transaction_id).toBeNull();
    expect(row.hold_transaction_id).toBeNull();

    /**
     * AND NO LEDGER ENTRY. The balance and the count would both survive a
     * balanced pair that credited her wallet 0 and debited `deposit_held` 0 —
     * which is precisely what `returnDeposit` would have written on this row, so
     * it is asserted rather than inferred from the two numbers above.
     */
    expect(
      Number(
        one(
          await exec(sql`
            SELECT count(*)::int AS n FROM ledger_entry
             WHERE member_id = ${m} AND account = 'deposit_held'`),
          'the deposit_held postings',
        ).n,
      ),
    ).toBe(0);

    /** A second mark says so, WITHOUT promising a refund that never happened. */
    const again = await noShow(id);
    expect(again.statusCode, again.body).toBe(409);
    expect((again.json() as { error: string }).error).toBe('already_no_show');
    expect((again.json() as { message: string }).message).toBe(
      'That appointment is already marked as a no-show.',
    );
  });

  it('27 · a GUEST booking can be marked — the handler must not assume a member', async () => {
    /**
     * THE SPEC THAT NEEDED THE BRANCH. A guest row has `member_id IS NULL`, so
     * the old path did not merely write a bad transaction — it had no member to
     * lock at all, and `eq(member.id, null)` matches nothing. Nothing here can be
     * asserted about a balance, which is the point: there is no wallet.
     */
    const name = `Walk-in ${randomUUID().slice(0, 6)}`;
    const made = await create({
      artistId: ARTIST_A,
      serviceId: SVC,
      startsAt: ago(2),
      guestName: name,
    });
    expect(made.statusCode, made.body).toBe(201);
    const id = (made.json() as Created).booking.id;

    const txBefore = Number(
      one(
        await exec(sql`SELECT count(*)::int AS n FROM "transaction" WHERE salon_id = ${SALON}`),
        'the salon transaction count',
      ).n,
    );

    const res = await noShow(id);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { refundedFils: number; transactionId: string | null };
    expect(body.refundedFils).toBe(0);
    expect(body.transactionId).toBeNull();

    const row = await rowOf(id);
    expect(String(row.status)).toBe('no_show_returned');
    expect(row.member_id).toBeNull();
    expect(row.guest_name).toBe(name);
    expect(row.settled_transaction_id).toBeNull();

    /** NOT ONE TRANSACTION ROW ANYWHERE IN THE SALON. There is no member_id to
     * scope the count by, so it is scoped by salon — which is the stronger
     * assertion anyway: a `deposit_return` written against the wrong member would
     * be caught by this and not by a per-member count. */
    expect(
      Number(
        one(
          await exec(sql`SELECT count(*)::int AS n FROM "transaction" WHERE salon_id = ${SALON}`),
          'the salon transaction count',
        ).n,
      ),
    ).toBe(txBefore);
  });

  it('28 · the time gate is kept — a walk-in cannot be a no-show before her slot', async () => {
    /**
     * THE GUARD THAT SURVIVED THE RELAXATION, and it is worth pinning separately
     * so that "the deposit is no longer a precondition" is not read as "there are
     * no preconditions". `no_show_returned` is an assertion about a named
     * person's conduct whether or not money was attached to it.
     */
    const bk = await guestBooking(at(28));
    const res = await noShow(bk.booking.id);
    expect(res.statusCode, res.body).toBe(409);
    expect((res.json() as { error: string }).error).toBe('appointment_not_started');
    expect(String((await rowOf(bk.booking.id)).status)).toBe('deposit_held');
  });

  // ====================================================== ?source= ON THE BOARD ==

  it('29 · the board filters by source, and refuses an unknown one in the house grammar', async () => {
    const m = await customer();
    const merchantId = (await guestBooking(at(29))).booking.id;
    const appId = await appBooking(m, ARTIST_A, at(30), 30);

    const board = async (qs: string) => {
      const res = await app.inject({
        method: 'GET',
        url: `/salons/${SALON}/bookings${qs}`,
        headers: { authorization: `Bearer ${managerBearer}` },
      });
      return res;
    };
    const ids = (res: Awaited<ReturnType<typeof board>>) =>
      (res.json() as { items: Array<{ id: string }> }).items.map((i) => i.id);

    const onlyMerchant = await board('?source=merchant');
    expect(onlyMerchant.statusCode, onlyMerchant.body).toBe(200);
    expect(ids(onlyMerchant)).toContain(merchantId);
    expect(ids(onlyMerchant)).not.toContain(appId);

    const onlyApp = await board('?source=app');
    expect(ids(onlyApp)).toContain(appId);
    expect(ids(onlyApp)).not.toContain(merchantId);

    /** A comma list, the same grammar `?status=` takes. */
    const both = await board('?source=app,merchant');
    expect(ids(both)).toContain(appId);
    expect(ids(both)).toContain(merchantId);

    /**
     * ABSENT IS UNCHANGED — the assertion that keeps this parameter from being a
     * behaviour change for every client that does not send it.
     */
    const none = await board('');
    expect(ids(none)).toContain(appId);
    expect(ids(none)).toContain(merchantId);

    /** THE REFUSAL, in `?status=`'s vocabulary rather than a second one. */
    const bad = await board('?source=walk_in');
    expect(bad.statusCode, bad.body).toBe(400);
    expect((bad.json() as { error: string }).error).toBe('invalid_source');
    expect((bad.json() as { message: string }).message).toBe(
      'Unknown booking source: walk_in. One of app, google_calendar, merchant.',
    );

    /** And the two filters compose rather than replacing one another. */
    const composed = await board('?source=merchant&status=deposit_held');
    expect(ids(composed)).toContain(merchantId);
    expect(ids(composed)).not.toContain(appId);
  });

  it('21 · a double-submitted create REPLAYS rather than answering slot_taken', async () => {
    /**
     * THE REASON THE KEY IS HERE AT ALL. No money moves on this endpoint, so #4
     * does not demand one. What a key buys is the right ANSWER: without it the
     * second submit hits the exclusion constraint and the front desk is told "that
     * time has just been taken" about an appointment it just made itself.
     */
    const key = `mb-replay-${randomUUID()}`;
    // PINNED — `at()` is relative to `Date.now()`, so a second call is a second
    // instant and the count below would match nothing however many rows existed.
    const t = at(24);
    const payload = {
      artistId: ARTIST_A,
      serviceId: SVC,
      startsAt: t,
      guestName: 'Double submit',
    };
    const first = await create(payload, { key });
    expect(first.statusCode, first.body).toBe(201);
    const second = await create(payload, { key });
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json()).toEqual(first.json());

    expect(
      Number(
        one(
          await exec(sql`
            SELECT count(*)::int AS n FROM booking
             WHERE service_id = ${SVC} AND starts_at = ${t}::timestamptz`),
          'the booking count',
        ).n,
      ),
    ).toBe(1);
  });
});
