/**
 * A CLIENT-SUPPLIED INSTANT MUST SAY WHICH CLOCK IT IS IN.   (lane C's finding)
 *
 * `POST /v1/salons/{id}/campaigns` used to do `new Date(raw)` on `scheduledAt`,
 * and `new Date("2026-09-30T10:00")` reads a zoneless string in the API
 * PROCESS's zone: 05:00Z on a laptop in Karachi, 10:00Z on Vercel. The Vercel
 * answer is a Kuwait merchant's 10:00 campaign sent at 13:00 her time. Every
 * write that takes an instant from a caller now goes through
 * `time/zone.ts § parseInstant`, which refuses a string with no `Z` or `±hh:mm`.
 *
 * WHAT EACH SPEC IS EVIDENCE FOR
 *
 *   campaigns     a zoneless `scheduledAt`, and a bare date, are 400
 *                 `invalid_scheduled_at` and write no row; a `Z` time and the same
 *                 moment written `+03:00` store ONE instant, and it is the right one
 *   vouchers      a zoneless `expiresAt` is 400 `invalid_expiry` and mints nothing
 *   bookings      a zoneless `startsAt` is 400 `invalid_starts_at` on all four
 *                 doors — customer create, customer reschedule, merchant create,
 *                 merchant reschedule — and nothing is booked, moved or debited;
 *                 a `+03:00` merchant create lands on the same instant as its `Z`
 *
 * THE BOOKING SLOT CHECK WOULD NOT HAVE CAUGHT IT, which is why the booking doors
 * are here at all: on a UTC host "10:00" is 13:00 Kuwait, which is usually a real
 * slot, and the customer would be booked three hours after the one she picked.
 *
 * Its own salon for the campaigns (so no `pending` row lands in SAL-AMARA's
 * queue), and a far-future, per-run day range for the bookings — the EXCLUDE
 * constraint shares one slot space across int files; see
 * merchantBookings.int.test.ts § "THIS FILE LIVES FAR IN THE FUTURE".
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const CAMPAIGN_SALON = `IO-SALON-${RUN}`;
const SEED_SALON = 'SAL-AMARA';
const BRANCH = 'BR-SAL';
const MANAGER = 'ST-001';
const PLATFORM_OWNER = 'PLT-001';
const ARTIST = 'AR-001';
const SVC = `IO-SV-${RUN}`;
const DAY_BASE = 1400 + Math.floor(Math.random() * 900);

/** The wall clock a `datetime-local` input hands over: no zone at all. */
const ZONELESS = '2031-09-30T10:00';

/** The same instant, written with a `+03:00` offset instead of `Z`. */
function asKuwaitOffset(iso: string): string {
  const shifted = new Date(new Date(iso).getTime() + 3 * 3_600_000).toISOString();
  return `${shifted.slice(0, 19)}+03:00`;
}

type Res = { status: number; body: Record<string, any> };

suite('a client-supplied instant must say which clock it is in', () => {
  let app: FastifyInstance;
  let db: (typeof import('../db/client'))['db'];
  let sql: (typeof import('drizzle-orm'))['sql'];
  let issue: (typeof import('../auth/sessions'))['issueSession'];
  let campaignManager = '';
  let seedManager = '';
  let platform = '';
  let memberId = '';
  let memberBearer = '';

  const exec = async (q: unknown) =>
    (await db.execute(q as never)) as unknown as Array<Record<string, unknown>>;

  const call = async (
    url: string,
    bearer: string,
    payload: unknown,
    key: string | null = `io-${randomUUID()}`,
  ): Promise<Res> => {
    const res = await app.inject({
      method: 'POST',
      url,
      headers: {
        authorization: `Bearer ${bearer}`,
        ...(key === null ? {} : { 'idempotency-key': key }),
      },
      payload: payload as object,
    });
    return { status: res.statusCode, body: JSON.parse(res.body || '{}') as Record<string, any> };
  };

  /** An instant `dayOffset` days from now, on a whole hour. */
  const at = (dayOffset: number, hourUtc = 7): string => {
    const d = new Date(Date.now() + (DAY_BASE + dayOffset) * 86_400_000);
    d.setUTCHours(hourUtc, 0, 0, 0);
    return d.toISOString();
  };

  const count = async (q: unknown): Promise<number> => Number((await exec(q))[0]?.n ?? 0);

  function refusedZoneless(res: Res, code: string, field: string) {
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error).toBe(code);
    expect(res.body.message).toContain(field);
    expect(res.body.message).toContain('time zone');
  }

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    sql = (await import('drizzle-orm')).sql;
    issue = (await import('../auth/sessions')).issueSession;
    app = await (await import('../app')).buildApp();

    // ---- the campaign salon, and a manager with perms.marketing
    await exec(sql`
      INSERT INTO salon (id, name, brand_color, loyalty_mode, stamp_target, stamp_reward,
                         deposit_fils, business_hours)
      VALUES (${CAMPAIGN_SALON}, ${`IO Salon ${RUN}`}, '#7A5C8E', 'stamps', 6, 'free blow-dry', 5000,
              ${JSON.stringify({ morning: ['10:00', '13:00'], evening: ['16:00', '22:00'] })}::jsonb)`);
    const staffId = `IO-ST-${RUN}`;
    await exec(sql`
      INSERT INTO staff_user
        (id, salon_id, name, handle, role, branch_access_all, branch_access_ids,
         password_hash, perm_dashboard, perm_appointments, perm_shop, perm_loyalty,
         perm_team, perm_scanner, perm_charges, perm_void, perm_marketing)
      VALUES (${staffId}, ${CAMPAIGN_SALON}, ${`IO ${staffId}`}, ${staffId.toLowerCase()},
              'manager', true, '{}', 'x', true, true, true, true, true, true, true, true, true)`);
    campaignManager = (
      await issue(db, { principalKind: 'staff', staffId, salonId: CAMPAIGN_SALON, scope: 'dashboard' })
    ).accessToken;

    // ---- bookings: a service the seeded artist performs, and a funded customer
    await exec(sql`
      INSERT INTO service (id, salon_id, name, price_fils)
      VALUES (${SVC}, ${SEED_SALON}, ${`IO Int Service ${RUN}`}, 8000)`);
    await exec(sql`
      INSERT INTO artist_service (artist_id, service_id, salon_id)
      VALUES (${ARTIST}, ${SVC}, ${SEED_SALON}) ON CONFLICT DO NOTHING`);

    // Funded THROUGH THE LEDGER — `db:verify` invariant 5; see merchantBookings.
    memberId = `IO-M-${randomUUID().slice(0, 8)}`;
    const openingTx = `IO-TX-OPEN-${memberId.slice(5)}`;
    await exec(sql`
      INSERT INTO member (id, salon_id, name, phone, password_hash, balance_fils, tier, visits, policy_version)
      VALUES (${memberId}, ${SEED_SALON}, 'IO Int Customer',
              ${`+9657${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`},
              '$argon2id$fake-not-a-credential', 150000, 'bronze', 0, 3)`);
    await exec(sql`
      INSERT INTO "transaction"
        (id, member_id, salon_id, branch_id, kind, amount_fils, status, reference, note, created_at, settled_at)
      VALUES (${openingTx}, ${memberId}, ${SEED_SALON}, ${BRANCH}, 'adjustment', 150000, 'settled',
              ${`AVO-OPEN-${memberId}`}, 'Opening fixture balance', now(), now())`);
    await exec(sql`
      INSERT INTO ledger_entry (transaction_id, salon_id, member_id, account, direction, amount_fils, balance_after_fils)
      VALUES
        (${openingTx}, ${SEED_SALON}, ${memberId}, 'member_wallet', 'credit', 150000, 150000),
        (${openingTx}, ${SEED_SALON}, NULL, 'gateway_clearing', 'debit', 150000, NULL)`);

    memberBearer = (
      await issue(db, { principalKind: 'member', memberId, salonId: SEED_SALON, scope: 'wallet' })
    ).accessToken;
    seedManager = (
      await issue(db, { principalKind: 'staff', staffId: MANAGER, salonId: SEED_SALON, scope: 'dashboard' })
    ).accessToken;
    platform = (
      await issue(db, {
        principalKind: 'platform_admin',
        platformAdminId: PLATFORM_OWNER,
        salonId: null,
        scope: 'platform',
      })
    ).accessToken;
  });

  afterAll(async () => {
    if (db && sql) {
      await exec(sql`DELETE FROM booking WHERE service_id = ${SVC}`);
      await exec(sql`DELETE FROM session WHERE member_id = ${memberId}`);
    }
    await app?.close();
  });

  // ================================================================ campaigns ==

  describe('POST /v1/salons/{id}/campaigns · scheduledAt', () => {
    const url = `/v1/salons/${CAMPAIGN_SALON}/campaigns`;
    const submit = (scheduledAt: unknown) =>
      call(
        url,
        campaignManager,
        {
          title: `IO campaign ${randomUUID().slice(0, 6)}`,
          body: 'Come in this week.',
          channel: 'push',
          audience: 'all',
          when: 'later',
          scheduledAt,
        },
        null,
      );
    const campaigns = () =>
      count(sql`SELECT count(*)::int AS n FROM campaign WHERE salon_id = ${CAMPAIGN_SALON}`);

    it('a zoneless wall clock is 400 invalid_scheduled_at, and no campaign is written', async () => {
      const before = await campaigns();
      refusedZoneless(await submit(ZONELESS), 'invalid_scheduled_at', 'scheduledAt');
      expect(await campaigns()).toBe(before);
    });

    it('so are a zoneless time with seconds and a bare date', async () => {
      const before = await campaigns();
      refusedZoneless(await submit('2031-09-30T10:00:00'), 'invalid_scheduled_at', 'scheduledAt');
      refusedZoneless(await submit('2031-09-30'), 'invalid_scheduled_at', 'scheduledAt');
      expect(await campaigns()).toBe(before);
    });

    it('a date the calendar does not have is refused, not rolled into March', async () => {
      const res = await submit('2031-02-31T07:00:00Z');
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body.error).toBe('invalid_scheduled_at');
    });

    it('a Z time and the same moment written +03:00 store one instant, and it is the right one', async () => {
      const instant = '2031-09-30T07:00:00.000Z'; // 10:00 in Kuwait
      const withOffset = '2031-09-30T10:00:00+03:00';
      expect(asKuwaitOffset(instant)).toBe(withOffset);

      const z = await submit(instant);
      const plus3 = await submit(withOffset);
      expect(z.status, JSON.stringify(z.body)).toBe(201);
      expect(plus3.status, JSON.stringify(plus3.body)).toBe(201);

      // On the wire…
      expect(z.body.scheduledAt).toBe(instant);
      expect(plus3.body.scheduledAt).toBe(instant);

      // …and in the column, read back as epoch so no driver or zone formats it.
      const rows = await exec(sql`
        SELECT id, extract(epoch FROM scheduled_at)::bigint AS epoch
          FROM campaign WHERE id IN (${z.body.id}, ${plus3.body.id})`);
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        expect(Number(r.epoch), `campaign ${String(r.id)}`).toBe(Date.parse(instant) / 1000);
      }
    });
  });

  // ================================================================= vouchers ==

  describe('POST /v1/vouchers · expiresAt', () => {
    it('a zoneless expiry is 400 invalid_expiry, and no voucher is minted', async () => {
      const vouchers = () =>
        count(sql`SELECT count(*)::int AS n FROM voucher WHERE member_id = ${memberId}`);
      const before = await vouchers();
      const res = await call('/v1/vouchers', platform, {
        memberId,
        amountFils: 1000,
        reason: 'IO zoneless expiry',
        expiresAt: '2031-10-01T23:59:59',
      });
      refusedZoneless(res, 'invalid_expiry', 'expiresAt');
      expect(await vouchers()).toBe(before);
    });
  });

  // ================================================================= bookings ==

  describe('startsAt, on every door that books or moves an appointment', () => {
    const balance = async () =>
      Number((await exec(sql`SELECT balance_fils FROM member WHERE id = ${memberId}`))[0]?.balance_fils);
    const bookingsForService = () =>
      count(sql`SELECT count(*)::int AS n FROM booking WHERE service_id = ${SVC}`);

    /** A real `app` booking for the reschedule door — the row `createBooking` writes. */
    async function appBooking(startsAtIso: string): Promise<string> {
      const bkId = `IO-BK-${randomUUID().slice(0, 8)}`;
      const holdId = `TX-IOH${Math.floor(Math.random() * 900_000 + 100_000)}`;
      await exec(sql`
        INSERT INTO "transaction"
          (id, member_id, salon_id, branch_id, kind, amount_fils, method, status, reference, created_at, settled_at)
        VALUES (${holdId}, ${memberId}, ${SEED_SALON}, ${BRANCH}, 'deposit_hold', -5000, 'wallet', 'settled',
                ${`AVO-DEP-${holdId.slice(3)}`}, now(), now())`);
      await exec(sql`UPDATE member SET balance_fils = balance_fils - 5000 WHERE id = ${memberId}`);
      await exec(sql`
        INSERT INTO ledger_entry (transaction_id, salon_id, member_id, account, direction, amount_fils, balance_after_fils)
        VALUES
          (${holdId}, ${SEED_SALON}, ${memberId}, 'member_wallet', 'debit', 5000,
           (SELECT balance_fils FROM member WHERE id = ${memberId})),
          (${holdId}, ${SEED_SALON}, NULL, 'deposit_held', 'credit', 5000, NULL)`);
      await exec(sql`
        INSERT INTO booking
          (id, salon_id, branch_id, branch_assumed, member_id, artist_id, service_id,
           starts_at, ends_at, duration_min, deposit_fils, status, source,
           hold_transaction_id, settled_transaction_id, no_show_return_due_at)
        VALUES (${bkId}, ${SEED_SALON}, ${BRANCH}, false, ${memberId}, ${ARTIST}, ${SVC},
                ${startsAtIso}::timestamptz, ${startsAtIso}::timestamptz + interval '30 minutes',
                30, 5000, 'deposit_held', 'app', ${holdId}, NULL,
                ${startsAtIso}::timestamptz + interval '90 minutes')`);
      return bkId;
    }

    const startsEpoch = async (bkId: string) =>
      Number(
        (await exec(sql`SELECT extract(epoch FROM starts_at)::bigint AS e FROM booking WHERE id = ${bkId}`))[0]?.e,
      );

    it('POST /bookings — the customer — refuses it, and nothing is held', async () => {
      const [beforeBal, beforeRows] = [await balance(), await bookingsForService()];
      const res = await call('/bookings', memberBearer, {
        artistId: ARTIST,
        serviceId: SVC,
        startsAt: ZONELESS,
      });
      refusedZoneless(res, 'invalid_starts_at', 'startsAt');
      expect(await balance()).toBe(beforeBal);
      expect(await bookingsForService()).toBe(beforeRows);
    });

    it('POST /bookings/{id}/reschedule — the customer — refuses it, and the slot does not move', async () => {
      const original = at(0);
      const bkId = await appBooking(original);
      const res = await call(`/bookings/${bkId}/reschedule`, memberBearer, { startsAt: ZONELESS }, null);
      refusedZoneless(res, 'invalid_starts_at', 'startsAt');
      expect(await startsEpoch(bkId)).toBe(Date.parse(original) / 1000);
    });

    it('POST /salons/{id}/bookings — the front desk — refuses it, and writes nothing', async () => {
      const before = await bookingsForService();
      const res = await call(`/salons/${SEED_SALON}/bookings`, seedManager, {
        artistId: ARTIST,
        serviceId: SVC,
        startsAt: ZONELESS,
        guestName: 'IO walk-in',
      });
      refusedZoneless(res, 'invalid_starts_at', 'startsAt');
      expect(await bookingsForService()).toBe(before);
    });

    it('POST /salons/{id}/bookings/{id}/reschedule — the front desk — refuses it, and the slot does not move', async () => {
      const original = at(2);
      const bkId = await appBooking(original);
      const res = await call(
        `/salons/${SEED_SALON}/bookings/${bkId}/reschedule`,
        seedManager,
        { startsAt: ZONELESS },
        null,
      );
      refusedZoneless(res, 'invalid_starts_at', 'startsAt');
      expect(await startsEpoch(bkId)).toBe(Date.parse(original) / 1000);
    });

    it('a +03:00 startsAt books the same instant its Z form names', async () => {
      const instant = at(4);
      const res = await call(`/salons/${SEED_SALON}/bookings`, seedManager, {
        artistId: ARTIST,
        serviceId: SVC,
        startsAt: asKuwaitOffset(instant),
        guestName: 'IO offset walk-in',
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.booking.startsAt).toBe(instant);
      expect(await startsEpoch(res.body.booking.id)).toBe(Date.parse(instant) / 1000);
    });
  });
});
