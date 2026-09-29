/**
 * WHAT THE SALON KEPT — the Sales report's fifth column against the ledger, and the
 * late reschedule that cannot buy back a return she had already lost.
 *   (migration 0067, lane A `edc4238`: `afe63ce`, `364c5a8`)
 *
 * HOW TO RUN
 *
 *   cd e2e && AVO_QA_DB=avo_lane_d ../node_modules/.bin/vitest run kept-deposits.test.ts
 *
 * WHAT IS UNDER TEST
 * ------------------
 * 1. `Kept deposits KD` — `services/reports.ts § sales`, appended AFTER the four existing
 *    columns. A deposit the salon keeps under its booking policy is a `deposit_forfeit`
 *    whose `amount_fils` is 0 by CHECK; the money is on its `salon_revenue` credit. So
 *    the column is compared with THAT leg, read in SQL, and with the booking's own
 *    `settled_kept_fils` — three sources, one number, to the fil.
 *
 * 2. `booking.returnCapPercent` — her own reschedule locks in the percent a cancel would
 *    have returned at that instant against the slot she left, and a later cancel returns
 *    `min(cap, what the stamped rules give against the current slot)`. Both arms of the
 *    `min` are driven, plus the control where the move was early and the cap is 100.
 *
 * THE POLICY AND THE DEPOSIT
 * --------------------------
 * `keep` on a no-show; 100% from 48h, 50% from 24h, nothing later — `booking-policy.test.ts`'s
 * v1. The deposit is 5.005 KD so half of it is not a whole fil: she gets 2.502 back and
 * the salon keeps 2.503, rounded DOWN in her direction (`splitDeposit`). A round deposit
 * could not tell the right rounding from the wrong one.
 *
 * NEVER THE WALL CLOCK
 * --------------------
 * Every booking is made through `POST /bookings` nine or more days out, so the deposit is
 * really held; then its three clock columns are moved TOGETHER by one delta with SQL
 * (`booking-policy.test.ts § startIn`), so "30 hours out" is 30 hours out whenever the
 * suite runs. Each cut-off is at least six hours from where a booking is placed. No money
 * column is written here.
 *
 * NOT HERE: the salon's own cancel's Idempotency-Key (lane A, in flight — trunk sends it
 * after the merge) and the slot-end sweep, which `booking-policy.test.ts` owns. The
 * no-show below is a staff MARK, which settles the moment it is made, so the new 60-minute
 * `BOOKING_SETTLE_GRACE_MINUTES` never enters this file's arithmetic.
 *
 * ITS OWN SALON, MINTED PER RUN, for `booking-policy.test.ts`'s reason: a policy is a
 * property of a salon and `booking_policy` is append-only.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BookingCancelResultSchema, BookingSchema } from '../packages/types/dist/index.js';
import { precondition } from './support/known-bug.js';
import {
  A_STAFF_FULL,
  B_MEMBER,
  psql,
  reconcileWalletLedger,
  scalar,
  signInDashboard,
  signInMember,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

// ------------------------------------------------------------------ the salon --

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`.toUpperCase();
const SALON = `SAL-QA-KD-${RUN}`;
const BRANCH = `BR-QA-KD-${RUN}`;
const SERVICE = `SV-QA-KD-${RUN}`;
const ARTISTS = [1, 2, 3].map((i) => `AR-QA-KD-${RUN}-${i}`);
const STAFF = `ST-QA-KD-${RUN}`;
const STAFF_HANDLE = `kd-${RUN.toLowerCase()}`;
const HER = `QA-KD-${RUN}-H`;
const HER_PHONE = '+96599663001';

const OPENING_FILS = 300_000;
const DEPOSIT = 5_005;
const HALF_BACK = 2_502;
const HALF_KEPT = 2_503;

const POLICY = {
  noShow: 'keep' as const,
  cancellation: [
    { hoursBefore: 48, returnPercent: 100 },
    { hoursBefore: 24, returnPercent: 50 },
  ],
  text: { en: 'Cancel 48 hours ahead for a full refund, 24 hours ahead for half.', ar: '' },
};

const KEPT_COLUMN = { header: 'Kept deposits KD', key: 'keptDepositsFils', type: 'money' };
/** The four columns that were there before, in their order. None may move. */
const SALES_COLUMNS_BEFORE = [
  { header: 'Date', key: 'date', type: 'text' },
  { header: 'Transactions', key: 'transactions', type: 'int' },
  { header: 'Gross KD', key: 'grossFils', type: 'money' },
  { header: 'Branch', key: 'branch', type: 'text' },
];

function seed(): void {
  const open = { open: true, from: '09:00', to: '21:00' };
  const windows = JSON.stringify(Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), open])));
  psql(`
BEGIN;
INSERT INTO salon (id, name, plan, brand_color, module_booking, module_shop, loyalty_mode,
                   tiers, stamp_target, stamp_reward, deposit_fils, no_show_return_minutes,
                   business_hours, social, whatsapp_enabled, timezone)
VALUES ('${SALON}', 'QA Kept Deposits ${RUN}', 'starter', '#7A5C8E', true, false, 'tiers',
        '[{"name":"bronze","minVisits":0,"bonusPercent":0}]'::jsonb,
        NULL, NULL, ${DEPOSIT}, 90,
        '{"morning":["09:00","13:00"],"evening":["14:00","21:00"]}'::jsonb, '[]'::jsonb, false, 'Asia/Kuwait');
INSERT INTO branch (id, salon_id, name) VALUES ('${BRANCH}', '${SALON}', 'QA kept branch');
INSERT INTO service (id, salon_id, name, price_fils) VALUES ('${SERVICE}', '${SALON}', 'QA kept blow-dry', 9000);
${ARTISTS.map(
  (a, i) => `
INSERT INTO artist (id, salon_id, name, availability_source, google_connected, slot_minutes, windows)
VALUES ('${a}', '${SALON}', 'Kept Artist ${i + 1}', 'manual', false, 30, '${windows}'::jsonb);
INSERT INTO artist_service (artist_id, service_id, salon_id) VALUES ('${a}', '${SERVICE}', '${SALON}');`,
).join('\n')}
INSERT INTO staff_user (id, salon_id, name, handle, role, branch_access_all, branch_access_ids, password_hash,
                        perm_dashboard, perm_appointments, perm_shop, perm_loyalty, perm_team,
                        perm_scanner, perm_charges, perm_void, perm_marketing)
SELECT '${STAFF}', '${SALON}', 'Kept Manager', '${STAFF_HANDLE}', 'manager', true, '{}', s.password_hash,
       true, true, true, true, true, true, true, true, true
  FROM staff_user s WHERE s.id = '${A_STAFF_FULL}';
INSERT INTO member (id, salon_id, name, phone, email, email_verified, password_hash,
                    balance_fils, visits, tier, stamps, policy_version)
SELECT '${HER}', '${SALON}', 'Kept Fixture', '${HER_PHONE}', NULL, false,
       s.password_hash, ${OPENING_FILS}, 0, 'bronze', NULL,
       (SELECT policy_version FROM member WHERE id = '${B_MEMBER}')
  FROM staff_user s WHERE s.id = '${A_STAFF_FULL}';
COMMIT;
`);
  reconcileWalletLedger(HER, 'QAKD');
}

// ------------------------------------------------------------------ state --

let her = '';
let staff = '';
let policyVersion = 0;
let n = 0;
const key = (label: string) => `kd-${label}-${RUN}-${Date.now()}-${n++}`;

beforeAll(async () => {
  await startTenancyApi();
  seed();
  her = await signInMember(SALON, HER_PHONE);
  staff = await signInDashboard(SALON, STAFF_HANDLE);
  const res = await treq<any>('PUT', `/salons/${SALON}/booking-policy`, { token: staff, body: POLICY });
  precondition(res.status === 200, `could not publish the policy: ${res.status} ${res.raw}`);
  policyVersion = res.body.policy.version;
}, 180_000);

afterAll(async () => {
  // Nothing of this file's is left due for another file's sweep: every hold still
  // standing is parked a year out, a day apart for the artists' exclusion constraint.
  psql(`
    UPDATE booking b SET
      starts_at             = now() + (interval '365 days' + x.i * interval '1 day'),
      ends_at               = now() + (interval '365 days' + x.i * interval '1 day') + (b.ends_at - b.starts_at),
      no_show_return_due_at = now() + (interval '365 days' + x.i * interval '1 day') + (b.no_show_return_due_at - b.starts_at)
      FROM (SELECT id, row_number() OVER (ORDER BY id) AS i
              FROM booking WHERE salon_id = '${SALON}' AND status = 'deposit_held') x
     WHERE b.id = x.id;`);
  await stopTenancyApi();
});

// ------------------------------------------------------------------ reads --

const num = (sql: string): number => Number(scalar(sql));
const balance = (): number => num(`select balance_fils from member where id='${HER}'`);

/** The salon_revenue credit of every settled forfeit at this salon — the ledger's answer. */
const ledgerKept = (): number =>
  num(`select coalesce(sum(l.amount_fils), 0) from ledger_entry l
         join "transaction" t on t.id = l.transaction_id
        where t.salon_id = '${SALON}' and t.kind::text = 'deposit_forfeit' and t.status = 'settled'
          and l.account = 'salon_revenue' and l.direction = 'credit'`);

/** The bookings' own answer. */
const bookingsKept = (): number =>
  num(`select coalesce(sum(settled_kept_fils), 0) from booking where salon_id = '${SALON}'`);

const capOf = (bookingId: string): string =>
  scalar(`select coalesce(policy_return_cap_percent::text, 'null') from booking where id='${bookingId}'`);

// ------------------------------------------------------------------ writes --

const isoDate = (daysAhead: number) => new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);

/** The first open slot for `artistId` from `fromDay` days out, skipping `except`. */
async function freeSlot(artistId: string, fromDay: number, except?: string): Promise<string> {
  for (let d = fromDay; d < fromDay + 21; d++) {
    const day = await treq<any>('GET', `/artists/${artistId}/availability?date=${isoDate(d)}`, { token: her });
    if (day.status !== 200) throw new Error(`availability: ${day.status} ${day.raw}`);
    const slot = day.body?.slots?.find(
      (s: any) => s.available === true && (except === undefined || Date.parse(s.startsAt) !== Date.parse(except)),
    )?.startsAt;
    if (slot) return slot;
  }
  throw new Error(`${artistId} offered no slot in three weeks — a fixture defect`);
}

async function book(artistId: string): Promise<any> {
  const res = await treq<any>('POST', '/bookings', {
    token: her,
    idempotencyKey: key('book'),
    body: { artistId, serviceId: SERVICE, startsAt: await freeSlot(artistId, 9), policyVersion },
  });
  if (res.status !== 201) throw new Error(`POST /bookings: ${res.status} ${res.raw}`);
  const b = res.body.booking;
  expect(b.policy?.version, 'the booking was not stamped with the policy').toBe(policyVersion);
  expect(b.depositFils).toBe(DEPOSIT);
  expect(b.returnCapPercent, 'a booking she has never moved carries a cap').toBeNull();
  return b;
}

/** Move a booking so it STARTS `minutes` from now, keeping its stamped intervals. */
function startIn(bookingId: string, minutes: number): void {
  psql(`
    UPDATE booking SET
      ends_at               = now() + interval '${minutes} minutes' + (ends_at - starts_at),
      no_show_return_due_at = now() + interval '${minutes} minutes' + (no_show_return_due_at - starts_at),
      starts_at             = now() + interval '${minutes} minutes'
    WHERE id = '${bookingId}';`);
}

async function reschedule(b: any): Promise<any> {
  const current = scalar(
    `select to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') from booking where id='${b.id}'`,
  );
  const to = await freeSlot(b.artistId, 9, current);
  const res = await treq<any>('POST', `/bookings/${b.id}/reschedule`, { token: her, body: { startsAt: to } });
  expect(res.status, `reschedule: ${res.raw}`).toBe(200);
  const moved = res.body.booking ?? res.body;
  const parsed = BookingSchema.safeParse(moved);
  expect(parsed.success, `the rescheduled booking does not parse: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
  return parsed.data;
}

async function cancel(bookingId: string): Promise<any> {
  const res = await treq<any>('DELETE', `/bookings/${bookingId}`, { token: her, idempotencyKey: key('cancel') });
  expect(res.status, `cancel: ${res.raw}`).toBe(200);
  const parsed = BookingCancelResultSchema.safeParse(res.body);
  expect(parsed.success, `the cancel result does not parse: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
  return parsed.data;
}

async function sales(): Promise<any> {
  const res = await treq<any>('GET', `/salons/${SALON}/reports/sales?period=7d`, { token: staff });
  expect(res.status, res.raw).toBe(200);
  return res.body;
}

const reportKept = (r: any): number => r.rows.reduce((t: number, row: any) => t + row.keptDepositsFils, 0);

// ================================================================ the late move --

describe('a late reschedule locks in the return she had — a cancel returns min(cap, rule), to the fil', () => {
  it('CONTROL — moved with more than 48h to spare, the cap is 100 and the cancel returns everything', async () => {
    const b = await book(ARTISTS[0]!);
    // Still nine-plus days out when she moves it: a cancel then would have returned 100%.
    const moved = await reschedule(b);
    expect(moved.returnCapPercent, 'an early move locked in something other than the 100% she held').toBe(100);
    expect(capOf(b.id)).toBe('100');

    const before = balance();
    const c = await cancel(b.id);
    expect(c).toMatchObject({ returnPercent: 100, refundedFils: DEPOSIT, keptFils: 0, forfeitTransactionId: null });
    expect(balance() - before).toBe(DEPOSIT);
  });

  it('THE CAP BINDS — moved 30h out (50%) to a slot 9+ days away (100% by the rules): the cancel returns 50%', async () => {
    const b = await book(ARTISTS[0]!);
    startIn(b.id, 30 * 60);

    const moved = await reschedule(b);
    expect(moved.returnCapPercent, 'the move did not lock in the 50% a cancel would have returned').toBe(50);
    expect(capOf(b.id)).toBe('50');
    // The new slot really is far enough out that the rules alone would return everything.
    expect(Date.parse(moved.startsAt) - Date.now()).toBeGreaterThan(48 * 3_600_000);

    const before = balance();
    const keptBefore = ledgerKept();
    const c = await cancel(b.id);

    expect(c.returnPercent, 'the move bought back the half she had lost').toBe(50);
    expect(c.refundedFils, 'half of 5.005, rounded down in her direction').toBe(HALF_BACK);
    expect(c.keptFils).toBe(HALF_KEPT);
    expect(c.rule, 'the rule reported is not the one the cap equals').toEqual({ hoursBefore: 24, returnPercent: 50 });
    expect(c.forfeitTransactionId).not.toBeNull();

    // The money, not the reply: her wallet, the ledger, the booking.
    expect(balance() - before).toBe(HALF_BACK);
    expect(ledgerKept() - keptBefore).toBe(HALF_KEPT);
    expect(
      scalar(`select concat_ws('|', status, settled_returned_fils, settled_kept_fils) from booking where id='${b.id}'`),
    ).toBe(`cancelled|${HALF_BACK}|${HALF_KEPT}`);
  });

  it('THE RULE BINDS — the same 50% cap, then cancelled 10h before the new slot: the rules give 0, so 0', async () => {
    const b = await book(ARTISTS[1]!);
    startIn(b.id, 31 * 60);
    const moved = await reschedule(b);
    expect(moved.returnCapPercent).toBe(50);

    // The NEW slot is now ten hours away — later than every cut-off.
    startIn(b.id, 10 * 60);
    const before = balance();
    const keptBefore = ledgerKept();
    const c = await cancel(b.id);

    expect(c.returnPercent, 'the cap was treated as a floor rather than a ceiling').toBe(0);
    expect(c.refundedFils).toBe(0);
    expect(c.keptFils).toBe(DEPOSIT);
    expect(c.transactionId, 'a 0% cancel wrote a return').toBeNull();
    expect(balance() - before).toBe(0);
    expect(ledgerKept() - keptBefore).toBe(DEPOSIT);
  });
});

// ================================================================ kept deposits --

describe("the Sales report's kept-deposits column is the ledger's salon_revenue, to the fil", () => {
  it('a no-show under `keep` forfeits the whole deposit, and Sales carries it in its fifth column', async () => {
    const b = await book(ARTISTS[2]!);
    // Started ten minutes ago: markable, and nowhere near its slot-end sweep.
    startIn(b.id, -10);

    const keptBefore = ledgerKept();
    const res = await treq<any>('POST', `/salons/${SALON}/bookings/${b.id}/no-show`, {
      token: staff,
      idempotencyKey: key('mark'),
    });
    expect(res.status, res.raw).toBe(200);
    expect(ledgerKept() - keptBefore, 'the no-show did not credit salon_revenue with the deposit').toBe(DEPOSIT);
    // A forfeit's own amount is her wallet delta: zero, by CHECK. The column must not read it.
    expect(
      scalar(`select amount_fils from "transaction" where id = (select forfeit_transaction_id from booking where id='${b.id}')`),
    ).toBe('0');

    const report = await sales();
    expect(report.columns, 'the four existing Sales columns moved, or the fifth is not last').toEqual([
      ...SALES_COLUMNS_BEFORE,
      KEPT_COLUMN,
    ]);

    // Three sources, one number: the column, the ledger leg, the bookings' own record.
    // Every forfeit here — this no-show and both late cancels above — is inside 7d.
    const kept = ledgerKept();
    expect(kept, 'nothing this file kept reached the ledger').toBe(DEPOSIT + HALF_KEPT + DEPOSIT);
    expect(reportKept(report), 'Sales Kept deposits KD disagrees with the salon_revenue ledger').toBe(kept);
    expect(bookingsKept(), 'booking.settled_kept_fils disagrees with the ledger').toBe(kept);

    // No charge was rung up here, so Transactions and Gross stay at nothing: a forfeit is
    // not a sale, and the column beside them is where it went.
    for (const row of report.rows) {
      expect(row.transactions, JSON.stringify(row)).toBe(0);
      expect(row.grossFils, JSON.stringify(row)).toBe(0);
      expect(row.branch).toBe('QA kept branch');
    }
    expect(report.stat?.value, 'the KD gross stat counted a kept deposit').toBe(0);
  });
});
