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
/**
 * Hessa — the seeded artist who has her own login (`artist.staff_user_id`), and
 * deliberately the RESTRICTED account: `perms.dashboard`, `perms.charges` and
 * `perms.void` are all OFF (db/seed.ts § ST-002).
 *
 * That is not incidental to this file, it is the argument in it. The audit log is
 * `requireDashboardPerm(req, 'dashboard')` and `GET /charges` is
 * `requireScannerPerm(req, 'charges')` — she can open NEITHER. Her day is the only
 * surface on which she can learn that her 11:00 was reversed, which is why losing
 * the row from it loses the fact entirely.
 */
const ARTIST_STAFF = 'ST-002';
const ARTIST = 'AR-003';

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const SVC = `AV-SV-${RUN}`;

interface DayRow {
  id: string;
  status: string;
  chargeVoided?: boolean;
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
   *                        so these must not overlap each other or AR-003's seed
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

    managerBearer = await till(MANAGER);
    artistBearer = await till(ARTIST_STAFF);
  });

  /**
   * THIS FILE DELETES ITS OWN BOOKINGS, AND HAS TO.
   *
   * `booking_artist_slot_no_overlap` is an EXCLUDE over (artist_id, time range),
   * and every spec here puts AR-003 in a slot a fixed number of minutes from
   * `now()`. A second run minutes later lands inside the first run's 30-minute
   * range and the INSERT is refused — which is the constraint working correctly
   * and the fixture being wrong. Without this the suite passes exactly once per
   * database reset, which is a suite that will be "flaky" to whoever runs it next.
   *
   * ONLY the bookings. The `transaction` and `ledger_entry` rows stay: the ledger
   * is append-only at the ROLE level (migration 0038 — a DELETE raises
   * "ledger_entry is append-only", proved by trying it), and the rows are balanced
   * anyway, so `db:verify`'s reconciliation invariants hold over them.
   */
  afterAll(async () => {
    if (db && sql) {
      await exec(sql`DELETE FROM booking WHERE id LIKE 'AV-BK-%'`);
    }
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
});
