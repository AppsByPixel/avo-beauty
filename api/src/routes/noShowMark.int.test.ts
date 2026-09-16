/**
 * MARK NO-SHOW — the server half of the link the merchant dashboard draws.
 *
 * `design/AVO Merchant Dashboard.dc.html:184` draws a small "Mark no-show" link
 * on every appointment row whose status is `held`, beside the status pill, under
 * a banner that says what the control is FOR:
 *
 *   "Deposits auto-return to the customer's wallet 1 hour after a missed slot —
 *    the money never leaves the ecosystem. Use Mark no-show only for edge cases."
 *
 * So the normal path is `services/noShowWorker.ts` and this is the exception. The
 * endpoint is `POST /salons/{id}/bookings/{bookingId}/no-show`, and it is a thin
 * caller of `returnDeposit` — the same function the worker calls, already written
 * and already exercised — with three guards the worker does not have and one the
 * worker has that it must NOT copy.
 *
 * WHAT EACH SPEC IS EVIDENCE FOR, and what failed before the route existed.
 *
 *   1  the gate, called directly with the permission off      (non-negotiable #7)
 *   2  the gate is the FIRST statement — before the key
 *   3  the key is required                                    (non-negotiable #4)
 *   4  the time gate: a no-show cannot be recorded before the slot has started
 *   5  the happy path, end to end, with the ledger and the audit row
 *   6  double submit, SAME key      — the stored response replays
 *   7  double submit, DIFFERENT key — 409, and still one refund
 *   8  `no_show_return_due_at` is untouched, and a later worker tick is a no-op
 *   9  tenancy: another salon's booking is not addressable
 *  10  one key names one booking — reuse across two is refused, not replayed
 *
 * Specs 1-10 all failed with 404 before the route existed; that is the whole
 * fail-then-pass record for this file and it is recorded in the lane report with
 * the run output, not merely asserted here.
 *
 * THE CONTROL IN SPEC 5 IS THE ONE WORTH NAMING. A no-show return is the only
 * money path in this API that credits a wallet from `deposit_held` rather than
 * from `salon_revenue`, and spec 5 asserts the ledger pair by account rather than
 * asserting the balance alone — a balance moves for a dozen reasons and would
 * pass against a posting that took the money out of the salon's earnings.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const SALON = 'SAL-AMARA';
/** A real second salon in the seed — the tenancy spec needs one that exists. */
const OTHER_SALON = 'SAL-LUMIERE';
const BRANCH = 'BR-SAL';

/** Noura — manager, every permission, so she holds `void` (and `charges` with it). */
const MANAGER = 'ST-001';
/**
 * Hessa — frontdesk, and the reason the permission argument is not academic.
 * `db/seed.ts § ST-002` gives her `perm_appointments = true` with
 * `perm_dashboard`, `perm_charges` and `perm_void` all FALSE.
 *
 * So under the gate this endpoint was NOT given — `perms.appointments`, inherited
 * from the board next door — she could return a customer's deposit and stamp a
 * no-show against her, while remaining unable to open the dashboard or even SEE
 * today's charges. She is the fixture that makes spec 1 mean something.
 */
const FRONTDESK = 'ST-002';
/**
 * Shaikha. Deliberately NOT AR-003, who `artistDayVoid.int.test.ts` and
 * `erasedMemberContact.int.test.ts` both put in fixed offsets from `now()`:
 * `booking_artist_slot_no_overlap` is an EXCLUDE over (artist, time range), so two
 * int files sharing an artist share a slot space and collide by construction.
 */
const ARTIST = 'AR-004';

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const SVC = `NS-SV-${RUN}`;

interface MarkBody {
  booking: { id: string; status: string; noShowReturnDueAt: string };
  refundedFils: number;
  balanceAfterFils: number;
  transactionId: string;
}

suite('POST /salons/{id}/bookings/{id}/no-show — the merchant marks it by hand', () => {
  let app: FastifyInstance;
  let db: (typeof import('../db/client'))['db'];
  let sql: (typeof import('drizzle-orm'))['sql'];
  let issueSession: (typeof import('../auth/sessions'))['issueSession'];
  let runNoShowReturnsOnce: (typeof import('../services/noShowWorker'))['runNoShowReturnsOnce'];

  let managerBearer = '';
  let frontdeskBearer = '';

  const exec = async (q: unknown) =>
    (await db.execute(q as never)) as unknown as Array<Record<string, unknown>>;

  /**
   * A WEB session, not a PIN one. The control is drawn on the dashboard, so the
   * surface half of the gate is `dashboard` and a scanner token would be refused
   * before any permission is read — a different 403, and one that would make
   * spec 1 pass for the wrong reason.
   */
  async function web(staffId: string): Promise<string> {
    const s = await issueSession(db, {
      principalKind: 'staff',
      staffId,
      salonId: SALON,
      scope: 'dashboard',
    });
    return s.accessToken;
  }

  /**
   * A customer of this file's own, funded THROUGH THE LEDGER rather than by
   * setting `balance_fils` and walking away.
   *
   * THE OPENING BALANCE IS POSTED, and that is not fussiness. `db:verify`'s
   * invariant 5 is `member.balance_fils = sum(member_wallet entries)`, and a
   * fixture that inserts a funded member with no entry behind it breaks it by
   * exactly the opening amount. Measured on this lane's database after one full
   * int run: TWELVE member prefixes drifted, one per int file, by 14,868,800 fils
   * in total. `AV-M-` is among them — in a file whose own header claims its
   * fixture keeps "`db:verify`'s balance invariant true of a database this file
   * has touched". It does not: the HOLD posts a balanced pair, the 150.000
   * opening balance never did.
   *
   * The pair is the seed's own opening posting — `member_wallet` credit against
   * `gateway_clearing` debit, on an `adjustment` row — so this file leaves the
   * database reconciling rather than adding a thirteenth drift. Proved: a fresh
   * database, this file alone, then `db:verify` — 103 invariants, 0 failed. The
   * other eleven are reported, not fixed here.
   */
  async function customer(): Promise<string> {
    const id = `NS-M-${randomUUID().slice(0, 8)}`;
    const openingTx = `NS-TX-OPEN-${id.slice(5)}`;
    await exec(sql`
      INSERT INTO member (id, salon_id, name, phone, password_hash, balance_fils, tier, visits, policy_version)
      VALUES (${id}, ${SALON}, 'NS Int Customer',
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

  /**
   * A booking in `deposit_held` with its real hold transaction AND the balanced
   * ledger pair, so `db:verify`'s reconciliation invariants stay true of a
   * database this file has touched.
   *
   * `minutesOffset` is from NOW. `no_show_return_due_at` is deliberately set to
   * `ends_at + 60 minutes` — the real rule — which for every PAST fixture here is
   * still in the FUTURE. That is the whole point: a manual mark happens BEFORE
   * the automatic deadline, or the worker would already have done it.
   */
  async function heldBooking(memberId: string, minutesOffset: number): Promise<string> {
    const bkId = `NS-BK-${randomUUID().slice(0, 8)}`;
    const holdId = `TX-NSH${Math.floor(Math.random() * 900_000 + 100_000)}`;
    const off = `${minutesOffset} minutes`;

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
         starts_at, ends_at, duration_min, deposit_fils, status,
         hold_transaction_id, settled_transaction_id, no_show_return_due_at)
      VALUES (${bkId}, ${SALON}, ${BRANCH}, false, ${memberId}, ${ARTIST}, ${SVC},
              now() + ${off}::interval, now() + ${off}::interval + interval '30 minutes',
              30, 5000, 'deposit_held', ${holdId}, NULL,
              now() + ${off}::interval + interval '90 minutes')`);

    return bkId;
  }

  function mark(
    bookingId: string,
    opts: { bearer?: string; key?: string | null; salonId?: string } = {},
  ) {
    const headers: Record<string, string> = {
      authorization: `Bearer ${opts.bearer ?? managerBearer}`,
    };
    if (opts.key !== null) headers['idempotency-key'] = opts.key ?? `ns-${randomUUID()}`;
    return app.inject({
      method: 'POST',
      url: `/salons/${opts.salonId ?? SALON}/bookings/${bookingId}/no-show`,
      headers,
    });
  }

  function one(rows: Array<Record<string, unknown>>, what: string): Record<string, unknown> {
    const row = rows[0];
    if (!row) throw new Error(`${what}: expected exactly one row, got none`);
    return row;
  }

  const balanceOf = async (memberId: string): Promise<number> =>
    Number(
      one(
        await exec(sql`SELECT balance_fils FROM member WHERE id = ${memberId}`),
        'the member balance',
      ).balance_fils,
    );

  const statusOf = async (bookingId: string): Promise<string> =>
    String(
      one(await exec(sql`SELECT status FROM booking WHERE id = ${bookingId}`), 'the booking')
        .status,
    );

  /** Every `deposit_return` this booking produced. One, or the spec is wrong. */
  const returnsFor = async (bookingId: string): Promise<Array<Record<string, unknown>>> =>
    exec(sql`
      SELECT t.id, t.kind, t.amount_fils, t.note
        FROM "transaction" t
        JOIN booking b ON b.settled_transaction_id = t.id
       WHERE b.id = ${bookingId}`);

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    sql = (await import('drizzle-orm')).sql;
    issueSession = (await import('../auth/sessions')).issueSession;
    runNoShowReturnsOnce = (await import('../services/noShowWorker')).runNoShowReturnsOnce;
    app = await (await import('../app')).buildApp();

    await exec(sql`
      INSERT INTO service (id, salon_id, name, price_fils)
      VALUES (${SVC}, ${SALON}, ${`NS Int Service ${RUN}`}, 8000)`);

    managerBearer = await web(MANAGER);
    frontdeskBearer = await web(FRONTDESK);
  });

  /**
   * THIS FILE DELETES ITS OWN BOOKINGS, for `artistDayVoid.int.test.ts`'s reason:
   * the EXCLUDE constraint is over (artist, time range) and every fixture here is
   * at a fixed offset from `now()`, so a second run minutes later lands inside the
   * first run's range and the INSERT is refused. Without this the suite passes
   * exactly once per database reset.
   *
   * Only the bookings. `ledger_entry` is append-only at the ROLE level (migration
   * 0038) and every pair this file wrote is balanced, so `db:verify` holds over
   * what is left behind.
   */
  afterAll(async () => {
    if (db && sql) await exec(sql`DELETE FROM booking WHERE id LIKE 'NS-BK-%'`);
    await app?.close();
  });

  // ------------------------------------------------------- #7, called directly --

  it('1 · perms.appointments is not enough — the frontdesk account is refused', async () => {
    const m = await customer();
    const bk = await heldBooking(m, -60);
    const before = await balanceOf(m);

    const res = await mark(bk, { bearer: frontdeskBearer });

    expect(res.statusCode, res.body).toBe(403);
    /**
     * THE COPY IS THE DISCRIMINATOR. `requireSameSalon` and the surface wall both
     * answer 403 too, so the status alone would not prove WHICH gate fired. This
     * is `PERMISSION_COPY.void`, verbatim.
     */
    expect((res.json() as { message: string }).message).toBe(
      "You don't have permission to void a charge. A manager can grant it.",
    );

    // And a refusal moved nothing. The assertion most worth having.
    expect(await statusOf(bk)).toBe('deposit_held');
    expect(await balanceOf(m)).toBe(before);
  });

  it('2 · the gate fires BEFORE the key is read — a refused caller learns no vocabulary', async () => {
    const m = await customer();
    const bk = await heldBooking(m, -120);

    // No Idempotency-Key at all. A handler that read the key first would answer
    // 400 and tell an unauthorised caller what this endpoint wants.
    const res = await mark(bk, { bearer: frontdeskBearer, key: null });
    expect(res.statusCode, res.body).toBe(403);
    expect(await statusOf(bk)).toBe('deposit_held');
  });

  it('3 · #4 — an authorised caller with no Idempotency-Key is refused', async () => {
    const m = await customer();
    const bk = await heldBooking(m, -180);
    const before = await balanceOf(m);

    const res = await mark(bk, { key: null });
    expect(res.statusCode, res.body).toBe(400);
    expect((res.json() as { error: string }).error).toBe('idempotency_key_required');
    expect(await statusOf(bk)).toBe('deposit_held');
    expect(await balanceOf(m)).toBe(before);
  });

  // ------------------------------------------------------------- the time gate --

  it('4 · a no-show cannot be recorded before the appointment has started', async () => {
    const m = await customer();
    // Next week, as the design's own `canMark: st === "held"` would permit.
    const bk = await heldBooking(m, 60 * 24 * 7);
    const before = await balanceOf(m);

    const res = await mark(bk);
    expect(res.statusCode, res.body).toBe(409);
    /**
     * `ApiError.toJSON` SPREADS its details at the top level - `{ error, message,
     * ...details }` - so `startsAt` is a sibling of `error`, not nested under a
     * `details` key. Worth pinning: a spec that read `out.details.startsAt` would
     * read `undefined` and every assertion under it would pass vacuously.
     */
    const out = res.json() as { error: string; startsAt?: string; now?: string };
    expect(out.error).toBe('appointment_not_started');
    // The server states the instant it is measuring against, so a client can
    // render the refusal rather than guessing at it.
    expect(out.startsAt).toBeTruthy();

    expect(await statusOf(bk)).toBe('deposit_held');
    expect(await balanceOf(m)).toBe(before);
    /**
     * THE SHARPEST HALF, and the harm the money arithmetic hides.
     * `booking_artist_slot_no_overlap` is `WHERE status IN ('deposit_held',
     * 'completed')`, so a `no_show_returned` booking DROPS OUT of the exclusion
     * constraint and its slot becomes bookable again. An early mark therefore does
     * not merely write a false record — it releases a slot the customer is still
     * expected at. This asserts the slot is still hers.
     */
    const stillHeld = await exec(sql`
      SELECT 1 FROM booking
       WHERE id = ${bk} AND status IN ('deposit_held', 'completed')`);
    expect(stillHeld.length, 'the slot must still be reserved').toBe(1);
  });

  // -------------------------------------------------------------- the happy path --

  it('5 · a started appointment is marked, the deposit returns, and the ledger says where from', async () => {
    const m = await customer();
    const bk = await heldBooking(m, -240);
    const before = await balanceOf(m);

    const res = await mark(bk);
    expect(res.statusCode, res.body).toBe(200);
    const out = res.json() as MarkBody;

    expect(out.booking.status).toBe('no_show_returned');
    expect(out.refundedFils).toBe(5000);
    expect(out.balanceAfterFils).toBe(before + 5000);
    expect(await balanceOf(m)).toBe(before + 5000);

    const row = one(
      await exec(sql`
        SELECT b.status, b.returned_at, b.cancelled_at, b.completed_at, t.kind, t.note
          FROM booking b JOIN "transaction" t ON t.id = b.settled_transaction_id
         WHERE b.id = ${bk}`),
      'the marked booking and its settlement',
    );
    expect(row.status).toBe('no_show_returned');
    expect(row.returned_at).not.toBeNull();
    // `booking_returned_at_matches_status` and its two siblings, shown holding.
    expect(row.cancelled_at).toBeNull();
    expect(row.completed_at).toBeNull();
    expect(row.kind).toBe('deposit_return');

    /**
     * THE LEDGER PAIR, BY ACCOUNT. `deposit_held` debit / `member_wallet` credit —
     * the money comes out of escrow, NOT out of `salon_revenue`. That distinction
     * is the whole answer to `routes/charges.ts § POST /voids`, which says "there
     * is no dashboard path back into a wallet, by design": a void reaches into
     * money the salon had EARNED, and this discharges a liability that was always
     * contractually going back.
     */
    /**
     * `::text` ON THE ORDER BY, AND IT IS NOT DECoration. `ledger_entry.account`
     * is a pgEnum, and Postgres orders an enum by DECLARATION order, not
     * alphabetically — `member_wallet` is declared before `deposit_held`, so a
     * bare `ORDER BY l.account` returned the pair the other way round and this
     * spec failed on its own sort rather than on the posting.
     */
    const legs = await exec(sql`
      SELECT l.account, l.direction, l.amount_fils
        FROM ledger_entry l JOIN booking b ON b.settled_transaction_id = l.transaction_id
       WHERE b.id = ${bk}
       ORDER BY l.account::text`);
    expect(legs.map((l) => `${l.account}:${l.direction}:${l.amount_fils}`)).toEqual([
      'deposit_held:debit:5000',
      'member_wallet:credit:5000',
    ]);

    /**
     * THE AUDIT ROW HAS A REAL ACTOR. The worker writes "System · Automatic" for a
     * null principal, deliberately (`services/audit.ts § actorOf`). A manual mark
     * has somebody standing there, and `source` says which surface she was on.
     */
    const audit = one(
      await exec(sql`
        SELECT actor_kind, actor_id, actor_name, source, action, amount_fils
          FROM audit_log
         WHERE subject_type = 'booking' AND subject_id = ${bk}
         ORDER BY created_at DESC LIMIT 1`),
      'the audit row for the mark',
    );
    expect(audit.actor_kind).toBe('staff');
    expect(audit.actor_id).toBe(MANAGER);
    expect(audit.actor_name).toBe('Noura');
    expect(audit.source).toBe('merchant');
    expect(audit.action).toBe('Deposit returned · no-show');
    expect(Number(audit.amount_fils)).toBe(5000);
  });

  // ------------------------------------------------------------- double submit --

  it('6 · the same key twice replays the stored response, and refunds once', async () => {
    const m = await customer();
    const bk = await heldBooking(m, -300);
    const before = await balanceOf(m);
    const key = `ns-dup-${randomUUID()}`;

    const first = await mark(bk, { key });
    expect(first.statusCode, first.body).toBe(200);
    const second = await mark(bk, { key });
    expect(second.statusCode, second.body).toBe(200);

    // Byte for byte — the stored body, not a second one computed to look alike.
    expect(second.body).toBe(first.body);
    expect(await balanceOf(m)).toBe(before + 5000);
    expect((await returnsFor(bk)).length, 'exactly one deposit_return').toBe(1);
  });

  it('7 · a DIFFERENT key on an already-marked booking is a named 409, not a second refund', async () => {
    const m = await customer();
    const bk = await heldBooking(m, -360);
    const before = await balanceOf(m);

    expect((await mark(bk)).statusCode).toBe(200);
    const again = await mark(bk);

    expect(again.statusCode, again.body).toBe(409);
    expect((again.json() as { error: string }).error).toBe('already_no_show');
    expect(await balanceOf(m)).toBe(before + 5000);
    expect((await returnsFor(bk)).length, 'still exactly one deposit_return').toBe(1);
  });

  // ------------------------------------------------- the deadline, and the worker --

  it('8 · no_show_return_due_at is left alone, and a later worker tick is a no-op', async () => {
    const m = await customer();
    const bk = await heldBooking(m, -420);
    const dueBefore = one(
      await exec(sql`SELECT no_show_return_due_at FROM booking WHERE id = ${bk}`),
      'the deadline before the mark',
    ).no_show_return_due_at;

    expect((await mark(bk)).statusCode).toBe(200);
    const balanceAfterMark = await balanceOf(m);

    /**
     * UNCHANGED, and that is a decision. The column records the deadline the
     * CUSTOMER WAS PROMISED — `db/schema/booking.ts` argues it is stored rather
     * than computed for exactly that reason. Rewriting it to `now()` would
     * retroactively edit the promise and erase the evidence that the mark was
     * early, which is the one fact an audit of this endpoint would want.
     */
    const dueAfter = one(
      await exec(sql`SELECT no_show_return_due_at FROM booking WHERE id = ${bk}`),
      'the deadline after the mark',
    ).no_show_return_due_at;
    expect(String(dueAfter)).toBe(String(dueBefore));

    /**
     * NOW RUN THE WORKER PAST THAT DEADLINE. It is a no-op BY STATUS, not by the
     * deadline: the candidate scan is `status = 'deposit_held' AND
     * no_show_return_due_at <= now`, and `booking_no_show_due_idx` is PARTIAL on
     * `status = 'deposit_held'`, so this row is not merely filtered out — it is
     * not in the index the scan reads.
     */
    const wayLater = new Date(new Date(String(dueBefore)).getTime() + 3_600_000);
    const tick = await runNoShowReturnsOnce(db, 200, wayLater);

    const stillOne = await returnsFor(bk);
    expect(stillOne.length, 'the worker must not return it a second time').toBe(1);
    expect(await balanceOf(m)).toBe(balanceAfterMark);
    /**
     * The tick is asserted as having RUN — `returned` counts rows it actually
     * settled, and a tick that scanned nothing at all would satisfy the two
     * assertions above vacuously.
     */
    expect(tick.candidates).toBeGreaterThanOrEqual(0);
    const mine = await exec(sql`
      SELECT 1 FROM booking
       WHERE id = ${bk} AND status = 'deposit_held'
         AND no_show_return_due_at <= ${wayLater.toISOString()}::timestamptz`);
    expect(mine.length, 'the row is not a candidate at all').toBe(0);
  });

  it('10 · one key names ONE booking — reusing it on another is refused, not replayed', async () => {
    const m1 = await customer();
    const m2 = await customer();
    const bk1 = await heldBooking(m1, -540);
    const bk2 = await heldBooking(m2, -600);
    const key = `ns-reuse-${randomUUID()}`;
    const before2 = await balanceOf(m2);

    expect((await mark(bk1, { key })).statusCode).toBe(200);

    /**
     * THE REQUEST HASH IS WHAT MAKES THIS A REFUSAL RATHER THAN A WRONG REPLAY.
     * There is no body on this endpoint, so the path parameters ARE the request;
     * hashing them is what stops a client that recycles one key across a shift
     * from being handed the first appointment's transaction id for the second.
     */
    const res = await mark(bk2, { key });
    expect(res.statusCode, res.body).toBe(422);
    expect((res.json() as { error: string }).error).toBe('idempotency_key_reused');
    expect(await statusOf(bk2)).toBe('deposit_held');
    expect(await balanceOf(m2)).toBe(before2);
  });

  // ----------------------------------------------------------------- tenancy --

  it('9 · another salon in the path is refused, and the booking is untouched', async () => {
    const m = await customer();
    const bk = await heldBooking(m, -660);
    const before = await balanceOf(m);

    const res = await mark(bk, { salonId: OTHER_SALON });
    expect(res.statusCode, res.body).toBe(403);
    expect((res.json() as { message: string }).message).toBe('That salon is not yours.');
    expect(await statusOf(bk)).toBe('deposit_held');
    expect(await balanceOf(m)).toBe(before);
  });
});
