/**
 * A VOIDED CHARGE MUST NOT DELETE THE APPOINTMENT FROM THE ARTIST'S DAY.
 *
 * Lane B found this building the artist's done-state. The two halves:
 *
 *   routes/charges.ts   the void sets the booking to `cancelled`
 *   routes/bookings.ts  the artist's day selected `deposit_held` and `completed`
 *
 * So she charges at 11:00 and her card reads "Paid"; a manager voids at 11:05 and
 * the row is GONE from her screen — not wrong, absent. The appointment she
 * performed leaves no trace on the only surface she can open.
 *
 * WHY THE FIX IS NOT "ALSO SELECT `cancelled`", and why this file drives the
 * whole flow rather than asserting on a hand-built row:
 *
 * `cancelled` HAS TWO WRITERS AND THEY MEAN OPPOSITE THINGS.
 *
 *   services/booking.ts  the CUSTOMER cancelled, before the visit. The booking
 *                        was `deposit_held` and was never charged. Nothing
 *                        happened; the slot is free.
 *   routes/charges.ts    a STAFF MEMBER voided a charge, after the visit. The
 *                        booking had been `completed`. The work happened and the
 *                        money went back.
 *
 * Widening the filter alone makes the first kind appear on her day too — a
 * behaviour change nobody asked for — and labels the second "Cancelled", which is
 * true and flat: it does not tell her that she rang this up and it was reversed.
 *
 * THE DISCRIMINATOR EXISTS AND IS DATABASE-ENFORCED. It is not on the booking row
 * — `settledTransactionId`, `completedAt` and `cancelledAt` are all set or null
 * identically by both writers — but it is exactly one join away and it is TOTAL:
 *
 *   `booking_settlement_matches_status` makes `settled_transaction_id` NOT NULL
 *   for every `cancelled` booking, and `transaction.reverses_transaction_id` has
 *   exactly ONE writer in the entire API (charges.ts, the void) behind a unique
 *   index. So "this cancellation is a reversal" is a committed fact about rows,
 *   resolved on the server — non-negotiable #2 — and never a client deriving
 *   intent from a pair of timestamps.
 *
 * The five specs below are the fail-then-pass record. Specs 1-3 pass on the code
 * as it stood; spec 4 is the reported defect and FAILED before the fix; spec 5
 * chooses, rather than inherits, that a customer cancellation stays OFF her day.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const SALON = 'SAL-AMARA';
const BRANCH = 'BR-SAL';
/** Noura — every permission, so she can charge AND void. */
const MANAGER = 'ST-001';
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const SVC = `AV-SV-${RUN}`;

/**
 * THIS RUN'S ARTIST, AND THIS RUN'S ARTIST LOGIN. Created in `beforeAll`, never
 * deleted — see § THE FIXTURE OWNS ITS OWN SLOT below the `beforeAll`.
 *
 * They used to be the SEEDED pair, `AR-003` / `ST-002`. The link is one-to-one
 * (`artist_staff_user_uq` is unique where present), so owning the artist means
 * owning the login too; a per-run artist cannot borrow Hessa's.
 *
 * WHAT THE SEEDED PAIR WAS FOR, AND WHY IT SURVIVES THE MOVE. `ST-002` is
 * deliberately the RESTRICTED account — `perms.dashboard`, `perms.charges` and
 * `perms.void` all OFF (db/seed.ts § ST-002) — and that is not incidental to this
 * file, it is the argument in it. The audit log is
 * `requireDashboardPerm(req, 'dashboard')` and `GET /charges` is
 * `requireScannerPerm(req, 'charges')` — she can open NEITHER. Her day is the only
 * surface on which she can learn that her 11:00 was reversed, which is why losing
 * the row from it loses the fact entirely.
 *
 * So the insert below spells those three permissions out rather than leaning on
 * the column defaults, even though every `perm_*` column defaults to false. The
 * argument this file makes is about what she CANNOT open; a default is not a
 * statement, and a fixture that got its premise from one would go on passing if
 * the default ever flipped.
 */
const ARTIST_STAFF = `AV-ST-${RUN}`;
const ARTIST = `AV-AR-${RUN}`;

interface DayRow {
  id: string;
  status: string;
  chargeVoided?: boolean;
  /**
   * The code, never the words. `undefined` here would mean the API did not send
   * the key at all, which specs 6-7 distinguish from a sent `null` — the
   * "too old to say" case the handler's own comment insists on.
   */
  voidReason?: 'wrong' | 'dupe' | 'cust' | null;
  serviceName: string;
}

suite('a voided charge leaves the appointment on the artist day, and says it was reversed', () => {
  let app: FastifyInstance;
  let db: (typeof import('../db/client'))['db'];
  let sql: (typeof import('drizzle-orm'))['sql'];
  let issueSession: (typeof import('../auth/sessions'))['issueSession'];

  let managerBearer = '';
  let artistBearer = '';

  const exec = async (q: unknown) =>
    (await db.execute(q as never)) as unknown as Array<Record<string, unknown>>;

  /** A real device-scoped scanner session. The shim would invent the perms. */
  async function till(staffId: string): Promise<string> {
    const s = await issueSession(db, {
      principalKind: 'staff',
      staffId,
      salonId: SALON,
      scope: 'scanner',
      deviceId: `DEV-INT-AV-${randomUUID()}`,
    });
    return s.accessToken;
  }

  /** A customer of this file's own, so nothing else's assertions move with her. */
  async function customer(): Promise<string> {
    const id = `AV-M-${randomUUID().slice(0, 8)}`;
    await exec(sql`
      INSERT INTO member (id, salon_id, name, phone, password_hash, balance_fils, tier, visits, policy_version)
      VALUES (${id}, ${SALON}, 'AV Int Customer',
              ${`+9659${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`},
              '$argon2id$fake-not-a-credential', 150000, 'bronze', 0, 3)`);
    return id;
  }

  /**
   * A booking in `deposit_held` with the real hold transaction AND its ledger
   * pair, so the wallet reconciles and `db:verify`'s balance invariant stays true
   * of a database this file has touched.
   *
   * `minutesOffset` is measured from NOW and is NEGATIVE for the charge specs —
   * an appointment earlier today, which is the shape the defect is reported in.
   * Three windows have to hold at once, and getting this wrong is silent:
   *
   *   the artist day       `starts_at >= now - 24h`
   *   findApplicableHold   `starts_at <= now + salon.no_show_return_minutes` (60)
   *                        AND `no_show_return_due_at > now`
   *   the EXCLUDE          `booking_artist_slot_no_overlap` over the real range,
   *                        so these must not overlap EACH OTHER. They cannot
   *                        overlap anything else: `ARTIST` is this run's own, and
   *                        the constraint is keyed on `artist_id`.
   *
   * A first run used +200 and the charge quietly settled NO booking: the row
   * stayed `deposit_held` and spec 4 failed on its setup rather than on the
   * defect. Worth recording — an out-of-grace hold does not raise, it is simply
   * not found, so a fixture that misses the window reads as a passing charge.
   */
  async function heldBooking(memberId: string, minutesOffset: number): Promise<string> {
    const bkId = `AV-BK-${randomUUID().slice(0, 8)}`;
    const holdId = `TX-AVH${Math.floor(Math.random() * 900_000 + 100_000)}`;
    const off = `${minutesOffset} minutes`;

    await exec(sql`
      INSERT INTO "transaction"
        (id, member_id, salon_id, branch_id, kind, amount_fils, method, status, reference, created_at, settled_at)
      VALUES (${holdId}, ${memberId}, ${SALON}, ${BRANCH}, 'deposit_hold', -5000, 'wallet', 'settled',
              ${`AVO-DEP-${holdId.slice(3)}`}, now(), now())`);

    await exec(sql`
      UPDATE member SET balance_fils = balance_fils - 5000 WHERE id = ${memberId}`);

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
              30, 5000, 'deposit_held', ${holdId}, NULL, now() + interval '3 hours')`);

    return bkId;
  }

  async function day(): Promise<DayRow[]> {
    const res = await app.inject({
      method: 'GET',
      url: '/artists/me/bookings',
      headers: { authorization: `Bearer ${artistBearer}` },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { items: DayRow[] }).items;
  }

  const find = (rows: DayRow[], id: string) => rows.find((r) => r.id === id);

  /**
   * The single row a query must have returned, or a failure that names the query.
   *
   * `exec` is typed `Array<Record<string, unknown>>` and `noUncheckedIndexedAccess`
   * is on, so `const [row] = await exec(...)` is `| undefined` — which `tsc`
   * refuses and which SHOULD be refused: a `SELECT` that matched nothing would
   * otherwise make every assertion below it read `undefined` and pass vacuously.
   */
  function one(rows: Array<Record<string, unknown>>, what: string): Record<string, unknown> {
    const row = rows[0];
    if (!row) throw new Error(`${what}: expected exactly one row, got none`);
    return row;
  }

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    sql = (await import('drizzle-orm')).sql;
    issueSession = (await import('../auth/sessions')).issueSession;
    app = await (await import('../app')).buildApp();

    await exec(sql`
      INSERT INTO service (id, salon_id, name, price_fils)
      VALUES (${SVC}, ${SALON}, ${`AV Int Service ${RUN}`}, 8000)`);

    /**
     * HER LOGIN. Restricted exactly as `ST-002` is, and said out loud rather than
     * inherited from the column defaults — see the `ARTIST_STAFF` header.
     *
     * `perm_scanner` is ON because the session this file mints is a scanner
     * session; `GET /artists/me/bookings` itself takes NO permission
     * (`requireScannerScope` only), which is the endpoint's own decision — "it is
     * her own day, self-scoped by the URL". `perm_appointments` mirrors ST-002.
     *
     * No PIN: `till()` issues the session directly, so nothing here authenticates
     * by PIN, and `staff_user_pin_is_device_scoped` wants the hash and the device
     * to be null or non-null together. A fake pair would be two credentials-shaped
     * columns that no assertion reads.
     */
    await exec(sql`
      INSERT INTO staff_user
        (id, salon_id, name, handle, role, branch_access_all, branch_access_ids,
         perm_dashboard, perm_appointments, perm_scanner, perm_charges, perm_void)
      VALUES (${ARTIST_STAFF}, ${SALON}, 'AV Int Artist', ${`av-artist-${RUN}`}, 'frontdesk',
              false, ARRAY[${BRANCH}]::text[],
              false, true, true, false, false)`);

    /**
     * HER ARTIST ROW. `AR-003`'s shape — manual hours, 30-minute slots, no branch
     * — so nothing that reads an artist sees a row of a kind the seed does not
     * already contain. The NAME carries `RUN` because `reports/artist-performance`
     * lists every artist of the salon by name, and two runs' rows must be two rows.
     */
    await exec(sql`
      INSERT INTO artist (id, salon_id, staff_user_id, name, availability_source, slot_minutes)
      VALUES (${ARTIST}, ${SALON}, ${ARTIST_STAFF}, ${`AV Int Artist ${RUN}`}, 'manual', 30)`);

    managerBearer = await till(MANAGER);
    artistBearer = await till(ARTIST_STAFF);
  });

  /**
   * ===================== THE FIXTURE OWNS ITS OWN SLOT =====================
   *
   * THIS FILE USED TO DELETE ITS OWN BOOKINGS IN `afterAll`, and that delete was
   * a defect with a green suite in front of it.
   *
   * The reason it existed was real. `booking_artist_slot_no_overlap` is
   * `EXCLUDE USING gist (artist_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)
   * WHERE status IN ('deposit_held', 'completed')`, and every spec here puts ONE
   * artist in a slot a fixed number of minutes from `now()`. On the seeded AR-003
   * a second run landed inside the first run's 30-minute range and the INSERT was
   * refused — the constraint working correctly and the fixture being wrong.
   *
   * WHAT THE DELETE COST. `DELETE FROM booking WHERE id LIKE 'AV-BK-%'` removed
   * the bookings and left the charges that settled them, because the ledger is
   * append-only at the ROLE level (migration 0038) and those rows cannot be
   * deleted. Two of this file's charges survive a run un-voided (spec 2, and spec
   * 9 whose void is REFUSED), each carrying a 5.000 `deposit_held` leg. With their
   * bookings gone they matched `services/reports.ts`'s definition of a WALK-IN —
   * "a settled charge that is not any booking's settling transaction" — and a
   * walk-in carrying a deposit is the one thing two specs exist to refuse:
   *
   *   reportsArtist.int.test.ts        `bucket(rows, 'Walk-in charges').depositAppliedFils` → 0
   *   reportsReconciliation.int.test.ts `walkin?.depositAppliedFils` → 0
   *
   * Both read `expected 10000 to be +0` on the second run against one database —
   * 2 × 5.000, exactly the two surviving deposits. Nothing was wrong about the
   * product; this fixture manufactured a state the product cannot reach.
   *
   * THE FIX IS A PER-RUN SLOT, NOT A BETTER CLEANUP. The EXCLUDE is keyed on
   * `artist_id`, so a per-run ARTIST cannot collide with any other run by
   * construction and there is nothing left to clean up. That is the same move
   * `bookingsPaging`, `reportsArtist` and `reportsReconciliation` already make,
   * and the move `e2e/support/global-setup.ts` makes one level up with its per-run
   * database.
   *
   * IT IS ALSO THE MORE HONEST FIXTURE. These charges DID settle an appointment
   * with an artist behind it. Keeping the booking leaves them attributed to this
   * run's artist in `artist-performance`, which is what they are; the delete was
   * turning real appointments into walk-ins and then asking the reports to
   * reconcile over the result.
   *
   * WHAT IT DOES NOT DO: widen anything back to `cancelled` bookings, or reset a
   * status. Lane D's note on `tenancy.test.ts` is the reason that alternative was
   * not taken — an `ON CONFLICT` status reset would debit `deposit_held` a second
   * time against one credit.
   *
   * THE COST, STATED: one `artist`, one `staff_user` and one `service` row per
   * run, plus this run's bookings, members and their ledger, all left in place.
   * Every assertion downstream of them is additive (`toBeGreaterThanOrEqual`) or
   * scoped to this run's own ids, which is what makes leaving them safe — and the
   * rows themselves are what makes the suite re-runnable.
   */

  /**
   * NOTHING TO CLEAN UP — see § THE FIXTURE OWNS ITS OWN SLOT above. The rows this
   * file writes are anchored to `ARTIST`, `ARTIST_STAFF` and `SVC`, all of which
   * carry `RUN`, so a later run shares no slot with this one and has nothing to
   * take away from it.
   */
  afterAll(async () => {
    await app?.close();
  });

  // ------------------------------------------------------- the reported defect --

  it('1 · a held booking is on her day', async () => {
    const m = await customer();
    const bk = await heldBooking(m, -20);

    const row = find(await day(), bk);
    expect(row, 'a deposit_held booking must be on the artist day').toBeDefined();
    expect(row?.status).toBe('deposit_held');
    /**
     * THE CONTROL, and the reason spec 4's `true` is worth anything. A field that
     * is constantly true asserts nothing; this is the live appointment that must
     * read false, and its `settled_transaction_id` is NULL so it also proves the
     * LEFT join is left — an inner one would have dropped this row entirely.
     */
    expect(row?.chargeVoided, 'a live appointment is not a reversal').toBe(false);
  });

  it('2 · she charges, and the row stays — now "completed"', async () => {
    const m = await customer();
    const bk = await heldBooking(m, -60);

    const charged = await app.inject({
      method: 'POST',
      url: '/charges',
      headers: { authorization: `Bearer ${managerBearer}`, 'idempotency-key': `av-c-${randomUUID()}` },
      payload: { memberId: m, serviceIds: [SVC] },
    });
    expect(charged.statusCode, charged.body).toBe(200);
    expect((charged.json() as { bookingId: string | null }).bookingId).toBe(bk);

    const row = find(await day(), bk);
    expect(row, 'a completed booking must be on the artist day').toBeDefined();
    expect(row?.status).toBe('completed');
    /**
     * The second control, and the sharper one: this row DOES have a
     * `settled_transaction_id` — the charge that consumed the deposit — so the
     * join hits and still reports false. It is `reverses_transaction_id` that
     * decides, not the mere presence of a settlement.
     */
    expect(row?.chargeVoided, 'a settled charge is not a reversed one').toBe(false);
  });

  it('3 · the void really does set the booking to cancelled — the mechanism, stated', async () => {
    const m = await customer();
    const bk = await heldBooking(m, -100);

    const charged = await app.inject({
      method: 'POST',
      url: '/charges',
      headers: { authorization: `Bearer ${managerBearer}`, 'idempotency-key': `av-c-${randomUUID()}` },
      payload: { memberId: m, serviceIds: [SVC] },
    });
    expect(charged.statusCode, charged.body).toBe(200);
    const txId = (charged.json() as { transaction: { id: string } }).transaction.id;

    const voided = await app.inject({
      method: 'POST',
      url: '/voids',
      headers: { authorization: `Bearer ${managerBearer}`, 'idempotency-key': `av-v-${randomUUID()}` },
      payload: { transactionId: txId, reason: 'charged the wrong customer' },
    });
    expect(voided.statusCode, voided.body).toBe(200);

    const row = one(
      await exec(sql`
      SELECT status, completed_at, cancelled_at, settled_transaction_id
        FROM booking WHERE id = ${bk}`),
      'the voided booking',
    );
    expect(row.status).toBe('cancelled');
    // Both halves of "no discriminator on the row": the void nulls `completed_at`,
    // and it sets `settled_transaction_id` exactly as a customer cancellation does.
    expect(row.completed_at).toBeNull();
    expect(row.settled_transaction_id).not.toBeNull();
  });

  it('4 · THE DEFECT — after the void the appointment is still on her day, and says it was reversed', async () => {
    const m = await customer();
    const bk = await heldBooking(m, -140);

    const charged = await app.inject({
      method: 'POST',
      url: '/charges',
      headers: { authorization: `Bearer ${managerBearer}`, 'idempotency-key': `av-c-${randomUUID()}` },
      payload: { memberId: m, serviceIds: [SVC] },
    });
    expect(charged.statusCode, charged.body).toBe(200);
    const txId = (charged.json() as { transaction: { id: string } }).transaction.id;

    // She saw it say "Paid".
    expect(find(await day(), bk)?.status).toBe('completed');

    const voided = await app.inject({
      method: 'POST',
      url: '/voids',
      headers: { authorization: `Bearer ${managerBearer}`, 'idempotency-key': `av-v-${randomUUID()}` },
      payload: { transactionId: txId, reason: 'charged the wrong customer' },
    });
    expect(voided.statusCode, voided.body).toBe(200);

    const row = find(await day(), bk);
    expect(row, 'THE REPORTED DEFECT: the voided appointment vanished from the artist day').toBeDefined();
    expect(row?.status).toBe('cancelled');
    /**
     * The half that makes the row worth having. "Cancelled" alone would tell her
     * the customer called off an appointment she in fact performed and was paid
     * for ninety seconds earlier.
     */
    expect(row?.chargeVoided, 'a reversed charge must say so, not merely read "Cancelled"').toBe(true);
  });

  // --------------------------------------------- the choice, not the inheritance --

  it('5 · a CUSTOMER cancellation stays off her day — chosen, not inherited from the fix', async () => {
    const m = await customer();
    const bk = await heldBooking(m, 180);

    /**
     * HER OWN CANCELLATION, THROUGH THE REAL ENDPOINT — `DELETE /bookings/{id}`
     * on a member wallet session, which is the only door the customer has.
     *
     * The booking is in the FUTURE (+180) because this path is the one the charge
     * path cannot be: `assertChangeWindowOpen` refuses a cancellation inside the
     * last hour, so a past booking answers `change_window_closed` and never
     * reaches `cancelled` at all. The two halves of this file need opposite
     * fixtures for the same reason they mean opposite things.
     */
    const memberBearer = (
      await issueSession(db, {
        principalKind: 'member',
        memberId: m,
        salonId: SALON,
        scope: 'wallet',
      })
    ).accessToken;

    const cancelled = await app.inject({
      method: 'DELETE',
      url: `/bookings/${bk}`,
      headers: { authorization: `Bearer ${memberBearer}` },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);

    const after = one(
      await exec(sql`
      SELECT b.status, t.kind AS settled_kind, t.reverses_transaction_id
        FROM booking b JOIN "transaction" t ON t.id = b.settled_transaction_id
       WHERE b.id = ${bk}`),
      'the customer-cancelled booking and its settlement',
    );
    expect(after.status).toBe('cancelled');
    /**
     * THE DISCRIMINATOR, SHOWN RATHER THAN ASSERTED. This row is `cancelled` and
     * carries a settlement exactly as the voided one does — but its settlement is
     * a `deposit_return` that reverses nothing, where the void's is an
     * `adjustment` naming the charge it undid.
     */
    expect(after.settled_kind).toBe('deposit_return');
    expect(after.reverses_transaction_id).toBeNull();

    /**
     * ABSENT, DELIBERATELY. A freed slot is arguably information she wants, but it
     * is not what the reported defect is about and it is a behaviour change of its
     * own: her day would fill with appointments that are not happening. The filter
     * therefore admits a `cancelled` booking ONLY when its settlement reverses a
     * charge — which is why this row, settled by a `deposit_return`, is not here.
     */
    expect(
      find(await day(), bk),
      'a pre-visit customer cancellation must NOT appear on the artist day',
    ).toBeUndefined();
  });

  // ==========================================================================
  // WHY, not just THAT — specs 6-10.
  //
  // `chargeVoided` tells her the charge was reversed. It does not tell her which
  // of three things was said, and the three mean opposite things TO HER: "wrong
  // amount or service" is a correction, "duplicate charge" is housekeeping, and
  // "customer did not receive service" is an assertion that she did not do the
  // job. She has `permDashboard: false` (see ARTIST_STAFF above) so this endpoint
  // is the only place she could ever read it.
  //
  // The shape served is a CODE, and specs 8 and 10 are the reason. The stored
  // reason is free text from an authenticated but otherwise unconstrained client,
  // and the actor's name sits on the same joined row. Both must stay off this
  // wire, and a spec that only checked the happy path would not notice either
  // going out.
  // ==========================================================================

  /** Charge the deposit-held booking, and answer with the charge's transaction id. */
  async function chargeFor(memberId: string): Promise<string> {
    const charged = await app.inject({
      method: 'POST',
      url: '/charges',
      headers: {
        authorization: `Bearer ${managerBearer}`,
        'idempotency-key': `av-c-${randomUUID()}`,
      },
      payload: { memberId, serviceIds: [SVC] },
    });
    expect(charged.statusCode, charged.body).toBe(200);
    return (charged.json() as { transaction: { id: string } }).transaction.id;
  }

  const voidCall = (payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/voids',
      headers: {
        authorization: `Bearer ${managerBearer}`,
        'idempotency-key': `av-v-${randomUUID()}`,
      },
      payload,
    });

  it('6 · a void with NO code — the row still says reversed, and the reason is an explicit null', async () => {
    const m = await customer();
    const bk = await heldBooking(m, -180);
    const txId = await chargeFor(m);

    /**
     * EXACTLY WHAT TODAY'S SCANNER SENDS — `reason` and nothing else
     * (`apps/scanner/src/components/VoidSheet.tsx`). This spec is the
     * back-compatibility guarantee: the field was added without making any
     * existing client's void 400, and without changing what her screen shows for
     * one. If this ever goes red, a deploy has broken the till.
     */
    const voided = await voidCall({ transactionId: txId, reason: 'Duplicate charge' });
    expect(voided.statusCode, voided.body).toBe(200);

    const row = find(await day(), bk);
    expect(row, 'the voided appointment must still be on her day').toBeDefined();
    expect(row?.chargeVoided, 'the older fact is unchanged by the newer one').toBe(true);
    /**
     * NULL, AND PRESENT. Not `undefined`: `'voidReason' in row` is the whole
     * point of the field being always-emitted. A client has to be able to tell
     * "no reason was recorded" from "this API is too old to say", and only the
     * key's presence carries that.
     */
    expect(row && 'voidReason' in row, 'voidReason must be emitted, never omitted').toBe(true);
    expect(row?.voidReason, 'a void that recorded no code reads null, not a fourth reason').toBeNull();
  });

  it('7 · a void WITH a code — her day carries which of the three was said', async () => {
    const m = await customer();
    const bk = await heldBooking(m, -220);
    const txId = await chargeFor(m);

    /**
     * The one that matters. `cust` is "Customer did not receive service" — the
     * assertion that she did not do the job, and the reason this slice exists
     * rather than the two that are about the transaction.
     */
    const voided = await voidCall({
      transactionId: txId,
      reason: 'Customer did not receive service',
      reasonCode: 'cust',
    });
    expect(voided.statusCode, voided.body).toBe(200);

    const row = find(await day(), bk);
    expect(row?.chargeVoided).toBe(true);
    expect(row?.voidReason, 'the code the till recorded, served back verbatim').toBe('cust');

    /**
     * SERVER-DECIDED, PROVED AT THE ROW — non-negotiable #2, and LANES.md's rule
     * that a plausible API reply is not evidence about the database. The code is
     * on the REVERSAL, which is the row the endpoint joins through, and it is not
     * on the charge.
     */
    const stored = one(
      await exec(sql`
        SELECT r.void_reason_code AS reversal_code,
               c.void_reason_code AS charge_code,
               r.note              AS reversal_note
          FROM "transaction" c
          JOIN "transaction" r ON r.reverses_transaction_id = c.id
         WHERE c.id = ${txId}`),
      'the charge and its reversal',
    );
    expect(stored.reversal_code).toBe('cust');
    expect(stored.charge_code, 'the code belongs to the void, not to the charge').toBeNull();
    // The words are still recorded — for the audit log, which is a different reader.
    expect(stored.reversal_note).toBe('Customer did not receive service');
  });

  it('8 · THE DISCLOSURE BOUND — the stored words never reach her, whatever a client typed', async () => {
    const m = await customer();
    const bk = await heldBooking(m, -260);
    const txId = await chargeFor(m);

    /**
     * WHAT AN ARBITRARY CLIENT CAN PUT THERE, and the reason the served field is
     * a code rather than the column.
     *
     * `POST /voids` requires a non-empty string and nothing else — it does NOT
     * require one of the scanner's three labels, and no client is obliged to use
     * the scanner. So this is a legal void today: a sentence naming a third party,
     * chosen to be unmistakable if it ever appears on the wire.
     */
    /**
     * The marker is NOT `RUN`: `serviceName` on the day row is
     * `AV Int Service ${RUN}`, so a whole-row search for `RUN` would match the
     * fixture's own service and fail for a reason that has nothing to do with the
     * disclosure. A first draft did exactly that — recorded because a spec that
     * fails on its own fixture teaches the next reader to weaken the assertion.
     */
    const marker = `SMEAR-${randomUUID().slice(0, 8).toUpperCase()}`;
    const smear = `Hessa was drunk again, ask ${marker} in reception`;
    const voided = await voidCall({ transactionId: txId, reason: smear, reasonCode: 'cust' });
    expect(voided.statusCode, voided.body).toBe(200);

    // It really is stored — this spec is about the wire, not about the column.
    const stored = one(
      await exec(sql`
        SELECT note FROM "transaction" WHERE reverses_transaction_id = ${txId}`),
      'the reversal row',
    );
    expect(stored.note, 'the audit record keeps the words it was given').toBe(smear);

    const row = find(await day(), bk);
    expect(row?.voidReason, 'the code is served').toBe('cust');
    /**
     * THE ASSERTION, OVER THE WHOLE ROW rather than a named field. A future
     * widening that added `note` — or `serialiseTransactionForMerchant`'s shape,
     * or an audit `detail` — under any key at all fails here. Naming the field
     * would only protect the field that exists today.
     */
    expect(
      JSON.stringify(row),
      'no free text a client typed may render on a named artist screen',
    ).not.toContain(marker);
  });

  it('9 · a code outside the three is REFUSED, and nothing was voided', async () => {
    const m = await customer();
    const bk = await heldBooking(m, -300);
    const txId = await chargeFor(m);

    const refused = await voidCall({
      transactionId: txId,
      reason: 'Customer did not receive service',
      reasonCode: 'she_is_lazy',
    });
    expect(refused.statusCode, refused.body).toBe(400);
    expect((refused.json() as { error: string }).error).toBe('invalid_reason_code');

    /**
     * A REFUSAL MOVED NO MONEY — the assertion `vitest.int.config.ts` was written
     * for. Refusing the code after the debit would be worse than accepting it: the
     * customer refunded and the reason lost.
     */
    const after = one(
      await exec(sql`
        SELECT (SELECT count(*) FROM "transaction" WHERE reverses_transaction_id = ${txId})::int AS reversals,
               (SELECT status FROM booking WHERE id = ${bk}) AS booking_status`),
      'the charge after a refused void',
    );
    expect(after.reversals, 'a refused void must not have written a reversal').toBe(0);
    expect(after.booking_status, 'and must not have cancelled her appointment').toBe('completed');

    // Her day is unchanged: still the completed work, still not a reversal.
    const row = find(await day(), bk);
    expect(row?.status).toBe('completed');
    expect(row?.chargeVoided).toBe(false);
    expect(row?.voidReason).toBeNull();
  });

  it('10 · WHY is widened, WHOSE is not — the actor stays off her day', async () => {
    const m = await customer();
    const bk = await heldBooking(m, -340);
    const txId = await chargeFor(m);

    const voided = await voidCall({
      transactionId: txId,
      reason: 'Wrong amount or service',
      reasonCode: 'wrong',
    });
    expect(voided.statusCode, voided.body).toBe(200);

    /**
     * THE ACTOR IS ON THE JOINED ROW AND IS NOT SELECTED. `created_by_staff_id` is
     * a column of the same reversal this endpoint already reaches, so disclosing
     * it would cost one word — which is exactly why it needs a spec rather than a
     * comment. Lane B scoped its ask to the code deliberately: who voided a charge
     * is a different disclosure from why, and it belongs to a surface with an
     * appeal attached, not to a pill on a day view.
     */
    const stored = one(
      await exec(sql`
        SELECT created_by_staff_id FROM "transaction" WHERE reverses_transaction_id = ${txId}`),
      'the reversal row',
    );
    expect(stored.created_by_staff_id, 'the actor IS recorded — against the record').toBe(MANAGER);

    const row = find(await day(), bk);
    expect(row?.voidReason).toBe('wrong');
    expect(
      JSON.stringify(row),
      'the artist learns WHY, and must not learn WHO from this endpoint',
    ).not.toContain(MANAGER);
  });

  it('11 · the free-text reason is capped — it was bounded only by the 256 KiB body limit', async () => {
    const m = await customer();
    await heldBooking(m, -380);
    const txId = await chargeFor(m);

    /**
     * FOUND WHILE ARGUING ABOUT DISCLOSURE, and it is the reason the argument
     * came out where it did. `POST /voids` required a non-empty string and
     * nothing else — `requireString`'s 500-char default was never reached,
     * because the handler validated `body.reason` by hand. The only bound was
     * Fastify's `bodyLimit` (`app.ts`: 256 KiB).
     *
     * This string is not inert. It lands in `transaction.note`, in the audit
     * log's `detail`, and — through `services/activityFeed.ts §
     * describeTransaction` — in the sentence BOTH the merchant's Overview feed
     * and the platform console's live event feed render. So any client holding a
     * scanner token could write a quarter of a megabyte into three staff screens.
     */
    const tooLong = 'x'.repeat(301);
    const refused = await voidCall({ transactionId: txId, reason: tooLong });
    expect(refused.statusCode, refused.body).toBe(400);
    expect((refused.json() as { error: string }).error).toBe('invalid_request');

    // A refusal moved no money, same as spec 9.
    const after = one(
      await exec(sql`
        SELECT count(*)::int AS n FROM "transaction" WHERE reverses_transaction_id = ${txId}`),
      'reversals after a refused void',
    );
    expect(after.n).toBe(0);

    /**
     * THE BOUNDARY, BOTH SIDES. A cap nobody tests at the edge is a cap that gets
     * loosened by the next person who hits it; 300 is accepted, 301 is not.
     */
    const accepted = await voidCall({ transactionId: txId, reason: 'y'.repeat(300) });
    expect(accepted.statusCode, accepted.body).toBe(200);
  });
});
