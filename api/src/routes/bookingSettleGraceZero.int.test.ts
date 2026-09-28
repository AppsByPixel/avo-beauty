/**
 * `BOOKING_SETTLE_GRACE_MINUTES=0`, IN A PROCESS OF ITS OWN — the one spec that
 * proves the setting is read rather than the default hard-wired.
 *
 * The default is 60 (trunk's ruling, 2026-09-29) and `bookingPolicy.int.test.ts`
 * runs under it. This file sets the variable BEFORE anything imports `env.ts`,
 * which parses once at module load; vitest's forks pool gives each file its own
 * process, so the value cannot leak into another file. It is still deleted in
 * `afterAll`, because a spec that relies on isolation it did not check is a spec
 * that leaks the day the pool changes.
 *
 * WHAT IS ASSERTED: the deadline the SERVICE stamps. Through the real
 * `POST /bookings` and the real `POST /bookings/{id}/reschedule` at a salon with
 * a published policy, `noShowReturnDueAt` is exactly `endsAt` — the slot's end
 * plus zero. No sweep is run: the slots are days out, and a sweep at a future
 * instant would settle every other held booking in the lane database due before
 * it.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

process.env.BOOKING_SETTLE_GRACE_MINUTES = '0';

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const SALON = `BG-S-${RUN}`;
const BRANCH = `${SALON}-BR`;
const MANAGER = `${SALON}-MGR`;
const ARTIST = `${SALON}-AR`;
const SVC = `${SALON}-SV`;
const DEPOSIT = 2_000;

type Json = Record<string, any>;

suite('BOOKING_SETTLE_GRACE_MINUTES=0 stamps the deadline at slot end', () => {
  let app: FastifyInstance;
  let db: (typeof import('../db/client'))['db'];
  let sql: (typeof import('drizzle-orm'))['sql'];
  let env: (typeof import('../env'))['env'];
  let managerBearer = '';
  let memberBearer = '';
  let memberId = '';

  const exec = async (q: unknown) =>
    (await db.execute(q as never)) as unknown as Array<Record<string, unknown>>;

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    sql = (await import('drizzle-orm')).sql;
    env = (await import('../env')).env;
    const issue = (await import('../auth/sessions')).issueSession;
    app = await (await import('../app')).buildApp();

    const hours = JSON.stringify({ morning: ['09:00', '13:00'], evening: ['13:00', '22:00'] });
    await exec(sql`
      INSERT INTO salon (id, name, brand_color, loyalty_mode, tiers, deposit_fils, business_hours,
                         module_booking, module_shop, timezone)
      VALUES (${SALON}, ${`BG ${SALON}`}, '#7A5C8E', 'tiers',
              (SELECT tiers FROM salon WHERE id = 'SAL-AMARA'), ${DEPOSIT}, ${hours}::jsonb,
              true, false, 'Asia/Kuwait')`);
    await exec(sql`INSERT INTO branch (id, salon_id, name) VALUES (${BRANCH}, ${SALON}, 'BG Branch')`);
    await exec(sql`
      INSERT INTO staff_user
        (id, salon_id, name, handle, role, branch_access_all, branch_access_ids, password_hash,
         perm_dashboard, perm_appointments, perm_shop, perm_loyalty, perm_team, perm_scanner,
         perm_charges, perm_void, perm_marketing)
      VALUES (${MANAGER}, ${SALON}, 'BG Manager', ${`bg-${RUN}-mgr`},
              'manager', true, '{}', 'x', true, true, true, true, true, true, true, true, true)`);
    const week = JSON.stringify(
      Object.fromEntries(['0', '1', '2', '3', '4', '5', '6'].map((d) => [d, { open: true, from: '10:00', to: '20:00' }])),
    );
    await exec(sql`
      INSERT INTO artist (id, salon_id, branch_id, name, slot_minutes, windows, active)
      VALUES (${ARTIST}, ${SALON}, ${BRANCH}, 'BG Artist', 60, ${week}::jsonb, true)`);
    await exec(sql`
      INSERT INTO service (id, salon_id, name, price_fils, active)
      VALUES (${SVC}, ${SALON}, ${`BG Service ${RUN}`}, 9000, true)`);
    await exec(sql`
      INSERT INTO artist_service (artist_id, service_id, salon_id) VALUES (${ARTIST}, ${SVC}, ${SALON})`);

    // A customer whose opening balance is a balanced ledger pair.
    memberId = `BG-M-${randomUUID().slice(0, 12)}`;
    const open = `BG-TX-OPEN-${memberId.slice(5)}`;
    await exec(sql`
      INSERT INTO member (id, salon_id, name, phone, password_hash, balance_fils, tier, visits, policy_version)
      VALUES (${memberId}, ${SALON}, 'BG Customer',
              ${`+9657${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`},
              'x', 50000, 'bronze', 0, 1)`);
    await exec(sql`
      INSERT INTO "transaction"
        (id, member_id, salon_id, branch_id, kind, amount_fils, status, reference, note, created_at, settled_at)
      VALUES (${open}, ${memberId}, ${SALON}, ${BRANCH}, 'adjustment', 50000, 'settled',
              ${`AVO-OPEN-${memberId}`}, 'Opening fixture balance', now(), now())`);
    await exec(sql`
      INSERT INTO ledger_entry (transaction_id, salon_id, member_id, account, direction, amount_fils, balance_after_fils)
      VALUES (${open}, ${SALON}, ${memberId}, 'member_wallet', 'credit', 50000, 50000),
             (${open}, ${SALON}, NULL, 'gateway_clearing', 'debit', 50000, NULL)`);

    managerBearer = (
      await issue(db, { principalKind: 'staff', staffId: MANAGER, salonId: SALON, scope: 'dashboard' })
    ).accessToken;
    memberBearer = (
      await issue(db, { principalKind: 'member', memberId, salonId: SALON, scope: 'wallet' })
    ).accessToken;
  });

  afterAll(async () => {
    delete process.env.BOOKING_SETTLE_GRACE_MINUTES;
    if (db && sql) await exec(sql`DELETE FROM session WHERE salon_id = ${SALON}`);
    await app?.close();
  });

  /** The first two open slots the artist offers, five or more days out. */
  async function twoSlots(): Promise<[string, string]> {
    const found: string[] = [];
    for (let d = 5; d < 25 && found.length < 2; d++) {
      const day = new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
      const res = await app.inject({
        method: 'GET',
        url: `/artists/${ARTIST}/availability?date=${day}`,
        headers: { authorization: `Bearer ${memberBearer}` },
      });
      expect(res.statusCode, res.body).toBe(200);
      const slot = ((res.json() as Json).slots as Json[]).find((s) => s.available)?.startsAt;
      if (slot) found.push(String(slot));
    }
    expect(found, 'the artist offered fewer than two slots').toHaveLength(2);
    return [found[0]!, found[1]!];
  }

  it('the parsed setting is 0 in this process', () => {
    expect(env.bookingSettleGraceMinutes).toBe(0);
  });

  it('POST /bookings and a reschedule both stamp noShowReturnDueAt = endsAt', async () => {
    const pub = await app.inject({
      method: 'PUT',
      url: `/salons/${SALON}/booking-policy`,
      headers: { authorization: `Bearer ${managerBearer}` },
      payload: { noShow: 'keep', cancellation: [{ hoursBefore: 24, returnPercent: 100 }], text: { en: 'Keep.', ar: '' } },
    });
    expect(pub.statusCode, pub.body).toBe(200);

    const [first, second] = await twoSlots();
    const res = await app.inject({
      method: 'POST',
      url: '/bookings',
      headers: { authorization: `Bearer ${memberBearer}`, 'idempotency-key': `bg-b-${randomUUID()}` },
      payload: { artistId: ARTIST, serviceId: SVC, startsAt: first, policyVersion: 1 },
    });
    expect(res.statusCode, res.body).toBe(201);
    const booked = (res.json() as Json).booking as Json;
    expect(booked.policy).toMatchObject({ version: 1, noShow: 'keep' });
    expect(booked.noShowReturnDueAt).toBe(booked.endsAt);

    const moved = await app.inject({
      method: 'POST',
      url: `/bookings/${booked.id}/reschedule`,
      headers: { authorization: `Bearer ${memberBearer}` },
      payload: { startsAt: second },
    });
    expect(moved.statusCode, moved.body).toBe(200);
    const after = (moved.json() as Json).booking as Json;
    expect(after.startsAt).toBe(second);
    expect(after.noShowReturnDueAt).toBe(after.endsAt);
  });
});
