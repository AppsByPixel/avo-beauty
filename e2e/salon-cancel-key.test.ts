/**
 * THE SALON'S CANCEL TAKES AN IDEMPOTENCY-KEY — a retry is told what came back, and
 * the deposit comes back once.   (lane A `f8e1252`, merged in `6132f14`)
 *
 * HOW TO RUN
 *
 *   cd e2e && AVO_QA_DB=avo_lane_d ../node_modules/.bin/vitest run salon-cancel-key.test.ts
 *
 * WHAT IS UNDER TEST
 * ------------------
 * `POST /salons/{id}/bookings/{bookingId}/cancel`, `perms.void`. On an app booking it
 * returns her whole deposit to her wallet, so non-negotiable #4 applies. Before
 * `f8e1252` the row lock alone stopped a double refund; what it could not do was give a
 * retry the ORIGINAL answer. The route now runs the no-show's machinery: the gate, then
 * the key, claimed inside the money transaction.
 *
 *   no key                         400 idempotency_key_required, nothing moves
 *   the same key again             the committed response, byte for byte; money once
 *   a new key after completion     409 already_cancelled (the row lock), money once
 *   the same key, another booking  422 idempotency_key_reused, that booking untouched
 *   perms.void off                 403 with a key or without — the gate is first
 *
 * Every claim about money is read back from Postgres — her balance, the booking row and
 * the `deposit_return` transactions — never from the API's own reply.
 *
 * ITS OWN SALON, MINTED PER RUN, with no booking policy: a salon's cancel returns the
 * whole deposit whatever the policy says, so a policy would add nothing but a stamp.
 * Bookings are made through `POST /bookings` nine or more days out, so each deposit is
 * really held.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`.toUpperCase();
const SALON = `SAL-QA-SCK-${RUN}`;
const BRANCH = `BR-QA-SCK-${RUN}`;
const SERVICE = `SV-QA-SCK-${RUN}`;
const ARTIST = `AR-QA-SCK-${RUN}`;
/** Every permission. Cancels. */
const STAFF = `ST-QA-SCK-${RUN}`;
const STAFF_HANDLE = `sck-${RUN.toLowerCase()}`;
/** Appointments on, `void` off. */
const STAFF_NOVOID = `ST-QA-SCK-${RUN}-N`;
const STAFF_NOVOID_HANDLE = `sck-n-${RUN.toLowerCase()}`;
const HER = `QA-SCK-${RUN}-H`;
const HER_PHONE = '+96599664001';

const OPENING_FILS = 200_000;
const DEPOSIT = 4_321;
const VOID_COPY = "You don't have permission to void a charge. A manager can grant it.";

function seed(): void {
  const open = { open: true, from: '09:00', to: '21:00' };
  const windows = JSON.stringify(Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), open])));
  const staffRow = (id: string, handle: string, voidPerm: boolean) => `
    INSERT INTO staff_user (id, salon_id, name, handle, role, branch_access_all, branch_access_ids, password_hash,
                            perm_dashboard, perm_appointments, perm_shop, perm_loyalty, perm_team,
                            perm_scanner, perm_charges, perm_void, perm_marketing)
    SELECT '${id}', '${SALON}', 'Cancel ${voidPerm ? 'Manager' : 'Reception'}', '${handle}', 'manager', true, '{}',
           s.password_hash, true, true, true, true, true, true, true, ${voidPerm}, true
      FROM staff_user s WHERE s.id = '${A_STAFF_FULL}';`;
  psql(`
BEGIN;
INSERT INTO salon (id, name, plan, brand_color, module_booking, module_shop, loyalty_mode,
                   tiers, stamp_target, stamp_reward, deposit_fils, no_show_return_minutes,
                   business_hours, social, whatsapp_enabled, timezone)
VALUES ('${SALON}', 'QA Salon Cancel ${RUN}', 'starter', '#7A5C8E', true, false, 'tiers',
        '[{"name":"bronze","minVisits":0,"bonusPercent":0}]'::jsonb,
        NULL, NULL, ${DEPOSIT}, 90,
        '{"morning":["09:00","13:00"],"evening":["14:00","21:00"]}'::jsonb, '[]'::jsonb, false, 'Asia/Kuwait');
INSERT INTO branch (id, salon_id, name) VALUES ('${BRANCH}', '${SALON}', 'QA cancel branch');
INSERT INTO service (id, salon_id, name, price_fils) VALUES ('${SERVICE}', '${SALON}', 'QA cancel blow-dry', 9000);
INSERT INTO artist (id, salon_id, name, availability_source, google_connected, slot_minutes, windows)
VALUES ('${ARTIST}', '${SALON}', 'Cancel Artist', 'manual', false, 30, '${windows}'::jsonb);
INSERT INTO artist_service (artist_id, service_id, salon_id) VALUES ('${ARTIST}', '${SERVICE}', '${SALON}');
${staffRow(STAFF, STAFF_HANDLE, true)}
${staffRow(STAFF_NOVOID, STAFF_NOVOID_HANDLE, false)}
INSERT INTO member (id, salon_id, name, phone, email, email_verified, password_hash,
                    balance_fils, visits, tier, stamps, policy_version)
SELECT '${HER}', '${SALON}', 'Cancel Fixture', '${HER_PHONE}', NULL, false,
       s.password_hash, ${OPENING_FILS}, 0, 'bronze', NULL,
       (SELECT policy_version FROM member WHERE id = '${B_MEMBER}')
  FROM staff_user s WHERE s.id = '${A_STAFF_FULL}';
COMMIT;
`);
  reconcileWalletLedger(HER, 'QASCK');
}

let her = '';
let manager = '';
let reception = '';
let n = 0;
const key = (label: string) => `sck-${label}-${RUN}-${Date.now()}-${n++}`;

beforeAll(async () => {
  await startTenancyApi();
  seed();
  her = await signInMember(SALON, HER_PHONE);
  manager = await signInDashboard(SALON, STAFF_HANDLE);
  reception = await signInDashboard(SALON, STAFF_NOVOID_HANDLE);
}, 180_000);

afterAll(async () => {
  // Every hold still standing is parked a year out, so no other file's sweep settles it.
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

const balance = (): number => Number(scalar(`select balance_fils from member where id='${HER}'`));
const statusOf = (bookingId: string): string => scalar(`select status from booking where id='${bookingId}'`);
/**
 * The deposit_returns that name this booking: the one its row settled with, and any that
 * reverse its hold. A second refund would be one of the two. `herReturns` deltas around
 * each call are the other half — they would see a refund that named neither.
 */
const returnsFor = (bookingId: string): number =>
  Number(
    scalar(
      `select count(distinct t.id) from "transaction" t join booking b on b.id = '${bookingId}'
        where t.member_id = '${HER}' and t.kind::text = 'deposit_return'
          and (t.id = b.settled_transaction_id or t.reverses_transaction_id = b.hold_transaction_id)`,
    ),
  );
const herReturns = (): number =>
  Number(scalar(`select count(*) from "transaction" where member_id='${HER}' and kind::text='deposit_return'`));

// ------------------------------------------------------------------ writes --

const isoDate = (daysAhead: number) => new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);

async function book(): Promise<string> {
  let slot: string | undefined;
  for (let d = 9; d < 40 && !slot; d++) {
    const day = await treq<any>('GET', `/artists/${ARTIST}/availability?date=${isoDate(d)}`, { token: her });
    if (day.status !== 200) throw new Error(`availability: ${day.status} ${day.raw}`);
    slot = day.body?.slots?.find((s: any) => s.available === true)?.startsAt;
  }
  if (!slot) throw new Error(`${ARTIST} offered no slot — a fixture defect`);
  const res = await treq<any>('POST', '/bookings', {
    token: her,
    idempotencyKey: key('book'),
    body: { artistId: ARTIST, serviceId: SERVICE, startsAt: slot },
  });
  if (res.status !== 201) throw new Error(`POST /bookings: ${res.status} ${res.raw}`);
  precondition(res.body.booking.depositFils === DEPOSIT, `the booking holds ${res.body.booking.depositFils}, not ${DEPOSIT}`);
  precondition(statusOf(res.body.booking.id) === 'deposit_held', 'the booking holds no deposit');
  return res.body.booking.id as string;
}

const salonCancel = (bookingId: string, opts: { token?: string; idempotencyKey?: string | undefined } = {}) =>
  treq<any>('POST', `/salons/${SALON}/bookings/${bookingId}/cancel`, {
    token: opts.token ?? manager,
    ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
  });

// ===========================================================================

describe("the salon's cancel requires a key, and a retry is the original answer", () => {
  let first = '';
  let firstKey = '';
  let firstRaw = '';

  it('no key: 400 idempotency_key_required, and her deposit stays held', async () => {
    first = await book();
    const before = balance();
    const res = await salonCancel(first);
    expect(res.status, res.raw).toBe(400);
    expect(res.body.error).toBe('idempotency_key_required');
    expect(statusOf(first), 'a keyless cancel changed the booking').toBe('deposit_held');
    expect(balance(), 'a keyless cancel moved money').toBe(before);
  });

  it('with a key: 200, the whole deposit back, one deposit_return', async () => {
    const before = balance();
    const returnsBefore = herReturns();
    firstKey = key('cancel');
    const res = await salonCancel(first, { idempotencyKey: firstKey });
    expect(res.status, res.raw).toBe(200);
    expect(res.body.refundedFils).toBe(DEPOSIT);
    expect(res.body.booking.status).toBe('cancelled');
    firstRaw = res.raw;

    expect(balance() - before).toBe(DEPOSIT);
    expect(res.body.balanceAfterFils).toBe(balance());
    expect(herReturns() - returnsBefore).toBe(1);
    expect(statusOf(first)).toBe('cancelled');
    expect(returnsFor(first)).toBe(1);
  });

  it('the same key again: the committed response, byte for byte, and the money moved once', async () => {
    precondition(firstRaw !== '', 'the keyed cancel above did not complete');
    const before = balance();
    const returnsBefore = herReturns();

    const replay = await salonCancel(first, { idempotencyKey: firstKey });
    expect(replay.status, replay.raw).toBe(200);
    expect(replay.raw, 'the retry was not the original answer').toBe(firstRaw);

    expect(balance(), 'the replay refunded again').toBe(before);
    expect(herReturns(), 'the replay wrote a second deposit_return').toBe(returnsBefore);
    expect(returnsFor(first)).toBe(1);
  });

  it('a NEW key after completion: 409 already_cancelled, and still one refund', async () => {
    const before = balance();
    const res = await salonCancel(first, { idempotencyKey: key('second') });
    expect(res.status, res.raw).toBe(409);
    expect(res.body.error).toBe('already_cancelled');
    expect(balance()).toBe(before);
    expect(returnsFor(first)).toBe(1);
  });

  it('the same key on a DIFFERENT booking: 422 idempotency_key_reused, and that booking is untouched', async () => {
    const other = await book();
    const before = balance();
    const res = await salonCancel(other, { idempotencyKey: firstKey });
    expect(res.status, res.raw).toBe(422);
    expect(res.body.error).toBe('idempotency_key_reused');
    expect(statusOf(other), 'a reused key cancelled a second booking').toBe('deposit_held');
    expect(balance()).toBe(before);
    expect(returnsFor(other)).toBe(0);

    // And the booking is still cancellable with a key of its own — the refusal was the key.
    const own = await salonCancel(other, { idempotencyKey: key('own') });
    expect(own.status, own.raw).toBe(200);
    expect(balance() - before).toBe(DEPOSIT);
  });
});

describe('perms.void off: 403 whether or not a key is sent — the gate comes before the key', () => {
  it('without a key and with one, the refusal is the permission, and the deposit stays held', async () => {
    const b = await book();
    const before = balance();
    for (const idempotencyKey of [undefined, key('novoid')]) {
      const res = await salonCancel(b, { token: reception, idempotencyKey });
      expect(res.status, `${idempotencyKey ? 'with' : 'without'} a key: ${res.raw}`).toBe(403);
      expect(res.body.message).toBe(VOID_COPY);
    }
    expect(statusOf(b)).toBe('deposit_held');
    expect(balance()).toBe(before);
  });
});
