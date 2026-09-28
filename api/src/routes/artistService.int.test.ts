/**
 * THE SERVICES TAB — "add the services, price it, then assign them".
 *                                               (migrations 0061, 0062)
 *
 * =========================================================================
 * WHAT THIS PROVES, AND THE ORDER IT PROVES IT IN
 * =========================================================================
 *   1. THE BACKFILL (0062, run VERBATIM off disk, 0059's approach). Rows that
 *      exist before it runs are assigned, every same-salon pair, retired rows
 *      included, no cross-salon pair — and an existing artist + existing
 *      service still BOOKS through the real endpoint afterwards. A service
 *      inserted after it, backdated to 2020, is still unassigned: rows, not a
 *      timestamp.
 *   2. CRUD + retire, integer fils, and what a reprice does NOT move.
 *   3. ENFORCEMENT on all five paths: a new service with nobody assigned is
 *      refused on both creates; unassigning refuses both reschedules and
 *      leaves the booking standing; a reassign to an artist who does not do the
 *      service is refused.
 *   4. CHARGING IS NOT RESTRICTED: an unassigned service charges at the counter.
 *   5. THE PERMISSIONS: catalogue writes on `loyalty`, assignment on `team`,
 *      each refused with its permission OFF and served with it ON — and the two
 *      are distinct, so neither permission reaches the other's route.
 *   6. TENANCY: salon A cannot edit, retire or assign salon B's services, nor
 *      assign salon B's artists; and the schema refuses a cross-salon link on
 *      its own.
 *
 * =========================================================================
 * THE `SA-` NAMESPACE, PER RUN
 * =========================================================================
 * Every fixture id is `SA-…-<run>`. Nothing here is cleaned up that anchors a
 * ledger row — bookings, charges and audit rows are append-only or restricted —
 * and nothing needs to be: per-run ids mean no other suite and no later run
 * reads them. The ONE shared row this touches is ST-002's `perm_team` /
 * `perm_loyalty`, restored in a `finally`.
 */

import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const SALON = 'SAL-AMARA';
const OTHER_SALON = 'SAL-LUMIERE';
/** Every permission. */
const MANAGER = 'ST-001';
/** `appointments` + `scanner` ON; `loyalty`, `team`, `dashboard` OFF — db/seed.ts. */
const FRONTDESK = 'ST-002';

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const id = (tag: string) => `SA-${tag}-${RUN}`;

// Existing BEFORE the backfill runs — the production situation.
const OLD_ARTIST = id('A-OLD');
const OLD_ARTIST_RETIRED = id('A-OLDRET');
const OLD_SERVICE = id('S-OLD');
const OLD_SERVICE_RETIRED = id('S-OLDRET');
const FOREIGN_ARTIST = id('A-LUM');
const FOREIGN_SERVICE = id('S-LUM');
// Created AFTER it.
const NEW_ARTIST = id('A-NEW');
const LATE_SERVICE = id('S-LATE');

const MIGRATION = (() => {
  const dir = new URL('../../drizzle/', import.meta.url);
  const file = readdirSync(dir).find((f) => f.startsWith('0062_'));
  if (!file) throw new Error('no 0062 migration in api/drizzle');
  return readFileSync(new URL(file, dir), 'utf8');
})();

const WEEK = JSON.stringify(
  Object.fromEntries(
    ['0', '1', '2', '3', '4', '5', '6'].map((d) => [d, { open: true, from: '10:00', to: '20:00' }]),
  ),
);

suite('the Services tab — who does which service', () => {
  let app: FastifyInstance;
  let db: (typeof import('../db/client'))['db'];
  let sql: (typeof import('drizzle-orm'))['sql'];
  let issue: (typeof import('../auth/sessions'))['issueSession'];
  let manager: string;
  let frontdesk: string;
  let till: string;

  const exec = async (q: unknown) =>
    (await db.execute(q as never)) as unknown as Array<Record<string, unknown>>;

  /** Runs 0062 as the migrator does: every statement, one transaction. */
  async function backfill(): Promise<number> {
    const statements = MIGRATION.split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => s.replace(/--.*$/gm, '').trim() !== '');
    let inserted = 0;
    await db.transaction(async (tx) => {
      for (const s of statements) {
        const res = (await tx.execute(sql.raw(s))) as unknown as { count?: number };
        inserted += res.count ?? 0;
      }
    });
    return inserted;
  }

  async function member(balanceFils = 500_000): Promise<{ id: string; token: string }> {
    const mid = id(`M-${randomUUID().slice(0, 6)}`);
    await db.execute(sql`
      INSERT INTO member (id, salon_id, name, phone, password_hash, balance_fils, tier, visits, policy_version)
      VALUES (${mid}, ${SALON}, 'SA Member',
              ${`+9656${String(Math.floor(Math.random() * 900_000) + 100_000)}`},
              'x', ${balanceFils}, 'bronze', 0, 1)`);
    const token = (
      await issue(db, { principalKind: 'member', memberId: mid, salonId: SALON, scope: 'wallet' })
    ).accessToken;
    return { id: mid, token };
  }

  const call = (method: string, url: string, token: string, payload?: unknown, key?: string) =>
    app.inject({
      method: method as 'GET',
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(key ? { 'idempotency-key': key } : {}),
      },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  const body = (res: { body: string }) => JSON.parse(res.body) as Record<string, any>;

  /** The first slots the REAL grid offers for this artist, a week or more out. */
  async function slots(artistId: string, token: string, n = 1, fromDay = 7): Promise<string[]> {
    const out: string[] = [];
    for (let d = fromDay; d < fromDay + 21 && out.length < n; d++) {
      const day = new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
      const res = await call('GET', `/artists/${artistId}/availability?date=${day}`, token);
      expect(res.statusCode, res.body).toBe(200);
      for (const s of body(res).slots as Array<{ available: boolean; startsAt: string }>) {
        if (s.available && out.length < n) out.push(s.startsAt);
      }
    }
    expect(out.length, `${artistId} offered no bookable slot`).toBe(n);
    return out;
  }

  async function book(m: { token: string }, artistId: string, serviceId: string, at?: string) {
    const startsAt = at ?? (await slots(artistId, m.token))[0];
    return call('POST', '/bookings', m.token, { artistId, serviceId, startsAt }, `sa-${randomUUID()}`);
  }

  const assign = (serviceId: string, artistIds: string[], token = manager) =>
    call('PUT', `/salons/${SALON}/services/${serviceId}/artists`, token, { artistIds });

  const linksOf = async (serviceId: string) =>
    (
      await exec(sql`SELECT artist_id FROM artist_service WHERE service_id = ${serviceId} ORDER BY 1`)
    ).map((r) => String(r.artist_id));

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    sql = (await import('drizzle-orm')).sql;
    issue = (await import('../auth/sessions')).issueSession;
    app = await (await import('../app')).buildApp();

    // The pre-existing roster and menu, inserted as rows with NO assignment —
    // the state 0061 leaves a live database in.
    await db.execute(sql`
      INSERT INTO artist (id, salon_id, name, slot_minutes, windows, active) VALUES
        (${OLD_ARTIST},         ${SALON},       ${`SA Old ${RUN}`},     60, ${WEEK}::jsonb, true),
        (${OLD_ARTIST_RETIRED}, ${SALON},       ${`SA Retired ${RUN}`}, 60, ${WEEK}::jsonb, false),
        (${FOREIGN_ARTIST},     ${OTHER_SALON}, ${`SA Lumiere ${RUN}`}, 60, ${WEEK}::jsonb, true)`);
    await db.execute(sql`
      INSERT INTO service (id, salon_id, name, price_fils, active) VALUES
        (${OLD_SERVICE},         ${SALON},       ${`SA Old service ${RUN}`}, 9000, true),
        (${OLD_SERVICE_RETIRED}, ${SALON},       ${`SA Retired svc ${RUN}`}, 7000, false),
        (${FOREIGN_SERVICE},     ${OTHER_SALON}, ${`SA Lumiere svc ${RUN}`}, 5000, true)`);

    manager = (
      await issue(db, { principalKind: 'staff', staffId: MANAGER, salonId: SALON, scope: 'dashboard' })
    ).accessToken;
    frontdesk = (
      await issue(db, { principalKind: 'staff', staffId: FRONTDESK, salonId: SALON, scope: 'dashboard' })
    ).accessToken;
    till = (
      await issue(db, {
        principalKind: 'staff',
        staffId: FRONTDESK,
        salonId: SALON,
        scope: 'scanner',
        deviceId: `DEV-SA-${RUN}`,
      })
    ).accessToken;
  });

  afterAll(async () => {
    await app?.close();
  });

  // ======================================================================
  // 1. THE BACKFILL
  // ======================================================================
  describe('0062 — everyone still does everything', () => {
    it('before it runs, an existing pair has no row, and booking it is REFUSED', async () => {
      expect(await linksOf(OLD_SERVICE)).toEqual([]);
      const m = await member();
      const res = await book(m, OLD_ARTIST, OLD_SERVICE);
      expect(res.statusCode, res.body).toBe(409);
      expect(body(res).error).toBe('artist_not_assigned');
    });

    it('assigns every same-salon pair that EXISTS — retired rows included — and no cross-salon one', async () => {
      await backfill();

      // EVERY artist of the salon — the seeded AR-00x and other suites' fixtures
      // included, because they existed too — and the two of ours among them.
      const amara = (
        await exec(sql`SELECT id FROM artist WHERE salon_id = ${SALON} ORDER BY 1`)
      ).map((r) => String(r.id));
      expect(amara).toEqual(expect.arrayContaining([OLD_ARTIST, OLD_ARTIST_RETIRED]));
      expect(await linksOf(OLD_SERVICE)).toEqual(amara);
      expect(await linksOf(OLD_SERVICE_RETIRED)).toEqual(amara);
      expect(await linksOf(FOREIGN_SERVICE)).toContain(FOREIGN_ARTIST);
      expect(await linksOf(FOREIGN_SERVICE)).not.toContain(OLD_ARTIST);

      // Over the whole database: no same-salon pair is missing, no pair crosses.
      const [gap] = await exec(sql`
        SELECT count(*)::int AS n FROM artist a JOIN service s ON s.salon_id = a.salon_id
         WHERE NOT EXISTS (SELECT 1 FROM artist_service x WHERE x.artist_id = a.id AND x.service_id = s.id)
           AND a.id IN (${OLD_ARTIST}, ${OLD_ARTIST_RETIRED}, ${FOREIGN_ARTIST})`);
      expect(gap?.n).toBe(0);
      const [cross] = await exec(sql`
        SELECT count(*)::int AS n FROM artist_service x
          JOIN artist a ON a.id = x.artist_id JOIN service s ON s.id = x.service_id
         WHERE a.salon_id <> s.salon_id`);
      expect(cross?.n).toBe(0);
    });

    it('AN EXISTING ARTIST + AN EXISTING SERVICE STILL BOOKS after it — today’s behaviour, kept', async () => {
      const m = await member();
      const res = await book(m, OLD_ARTIST, OLD_SERVICE);
      expect(res.statusCode, res.body).toBe(201);
    });

    it('the seeded demo roster still books: AR-003 × SV-01 (the seed writes its own pairs)', async () => {
      const m = await member();
      const res = await book(m, 'AR-003', 'SV-01');
      expect(res.statusCode, res.body).toBe(201);
    });

    it('is idempotent: a second run inserts nothing', async () => {
      const before = await linksOf(OLD_SERVICE);
      expect(await backfill()).toBe(0);
      expect(await linksOf(OLD_SERVICE)).toEqual(before);
    });

    it('ROWS, NOT A TIMESTAMP: a service inserted AFTER it, backdated to 2020, is unassigned', async () => {
      await db.execute(sql`
        INSERT INTO service (id, salon_id, name, price_fils, active, created_at, updated_at)
        VALUES (${LATE_SERVICE}, ${SALON}, ${`SA Late ${RUN}`}, 4000, true,
                '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')`);
      expect(await linksOf(LATE_SERVICE)).toEqual([]);
      const m = await member();
      const res = await book(m, OLD_ARTIST, LATE_SERVICE);
      expect(res.statusCode, res.body).toBe(409);
      expect(body(res).error).toBe('artist_not_assigned');
    });
  });

  // ======================================================================
  // 2. CRUD + RETIRE, AND MONEY
  // ======================================================================
  describe('add, price, edit, retire', () => {
    it('POST creates it with nobody assigned, price in integer fils, and GET serves artistIds: []', async () => {
      const res = await call('POST', `/salons/${SALON}/services`, manager, {
        name: `SA Brows ${RUN}`,
        nameAr: 'حواجب',
        priceFils: 4500,
      });
      expect(res.statusCode, res.body).toBe(201);
      const s = body(res);
      expect(s).toMatchObject({ salonId: SALON, priceFils: 4500, nameAr: 'حواجب', active: true, artistIds: [], image: null });
      // From `service_number_seq` (0061), clear of the seeded two-digit ids.
      expect(s.id).toMatch(/^SV-\d{8,}$/);
      expect(Number(String(s.id).slice(3))).toBeGreaterThanOrEqual(10_000_000);

      const list = body(await call('GET', `/salons/${SALON}/services`, manager)).items as any[];
      expect(list.find((x) => x.id === s.id)).toMatchObject({ artistIds: [], priceFils: 4500 });
      // Every row on the list carries the field.
      expect(list.every((x) => Array.isArray(x.artistIds))).toBe(true);
      // And the member's wallet reads the same field off the same route.
      const m = await member();
      const wallet = body(await call('GET', `/salons/${SALON}/services`, m.token)).items as any[];
      expect(wallet.find((x) => x.id === s.id)?.artistIds).toEqual([]);
      expect(wallet.find((x) => x.id === OLD_SERVICE)?.artistIds).toContain(OLD_ARTIST);
    });

    it('refuses a float, a zero, a negative and a KWD string price — non-negotiable #1', async () => {
      for (const priceFils of [8.5, 0, -1000, '8.500']) {
        const res = await call('POST', `/salons/${SALON}/services`, manager, { name: 'SA bad', priceFils });
        expect(res.statusCode, `${priceFils}: ${res.body}`).toBe(400);
        expect(body(res).error).toBe('invalid_amount');
      }
    });

    it('refuses artistIds and active on the catalogue routes, naming the right door', async () => {
      const res = await call('POST', `/salons/${SALON}/services`, manager, {
        name: 'SA x',
        priceFils: 1000,
        artistIds: [OLD_ARTIST],
      });
      expect(res.statusCode).toBe(400);
      expect(body(res).error).toBe('not_editable');
      const patch = await call('PATCH', `/salons/${SALON}/services/${OLD_SERVICE}`, manager, { active: false });
      expect(patch.statusCode).toBe(400);
      expect(body(patch).error).toBe('not_editable');
    });

    it('PATCH reprices and renames; the audit row carries before and after', async () => {
      const made = body(
        await call('POST', `/salons/${SALON}/services`, manager, { name: `SA Reprice ${RUN}`, priceFils: 6000 }),
      );
      const res = await call('PATCH', `/salons/${SALON}/services/${made.id}`, manager, {
        priceFils: 7250,
        nameAr: '   ',
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(body(res)).toMatchObject({ priceFils: 7250, nameAr: null });
      const [audit] = await exec(sql`
        SELECT action, detail, metadata FROM audit_log
         WHERE subject_type = 'service' AND subject_id = ${made.id} AND action = 'Service edited'`);
      expect(audit?.detail).toContain('7.250 KD (was 6.000 KD)');
      expect((audit?.metadata as any).before.priceFils).toBe(6000);
      expect((audit?.metadata as any).after.priceFils).toBe(7250);
    });

    it('A REPRICE MOVES NO AGREED MONEY: the held deposit is the salon’s, the past charge keeps its amount', async () => {
      const made = body(
        await call('POST', `/salons/${SALON}/services`, manager, { name: `SA Money ${RUN}`, priceFils: 8000 }),
      );
      expect((await assign(made.id, [OLD_ARTIST])).statusCode).toBe(200);

      const m = await member();
      const booked = await book(m, OLD_ARTIST, made.id);
      expect(booked.statusCode, booked.body).toBe(201);
      const bookingId = body(booked).booking.id as string;

      const walkIn = await member();
      const charged = await call('POST', '/charges', till, { memberId: walkIn.id, serviceIds: [made.id] }, `sa-${randomUUID()}`);
      expect(charged.statusCode, charged.body).toBe(200);

      const [salonRow] = await exec(sql`SELECT deposit_fils FROM salon WHERE id = ${SALON}`);
      const before = await exec(sql`
        SELECT (SELECT deposit_fils FROM booking WHERE id = ${bookingId}) AS deposit,
               (SELECT amount_fils FROM "transaction" WHERE member_id = ${walkIn.id} AND kind = 'charge') AS charged`);

      expect((await call('PATCH', `/salons/${SALON}/services/${made.id}`, manager, { priceFils: 19000 })).statusCode).toBe(200);

      const after = await exec(sql`
        SELECT (SELECT deposit_fils FROM booking WHERE id = ${bookingId}) AS deposit,
               (SELECT amount_fils FROM "transaction" WHERE member_id = ${walkIn.id} AND kind = 'charge') AS charged`);
      expect(Number(before[0]?.deposit)).toBe(Number(salonRow?.deposit_fils));
      expect(Number(after[0]?.deposit)).toBe(Number(before[0]?.deposit));
      expect(Number(before[0]?.charged)).toBe(-8000);
      expect(Number(after[0]?.charged)).toBe(-8000);

      // …and the NEXT charge of it is priced at the new price: the basket is ids.
      const next = await member();
      const again = await call('POST', '/charges', till, { memberId: next.id, serviceIds: [made.id] }, `sa-${randomUUID()}`);
      expect(again.statusCode, again.body).toBe(200);
      const [n] = await exec(sql`SELECT amount_fils FROM "transaction" WHERE member_id = ${next.id} AND kind = 'charge'`);
      expect(Number(n?.amount_fils)).toBe(-19000);
    });

    it('DELETE retires: 204, gone from the list, not chargeable, a second DELETE is 404, the row stays', async () => {
      const made = body(
        await call('POST', `/salons/${SALON}/services`, manager, { name: `SA Retire ${RUN}`, priceFils: 3000 }),
      );
      const res = await call('DELETE', `/salons/${SALON}/services/${made.id}`, manager);
      expect(res.statusCode, res.body).toBe(204);

      const list = body(await call('GET', `/salons/${SALON}/services`, manager)).items as any[];
      expect(list.some((x) => x.id === made.id)).toBe(false);
      const [row] = await exec(sql`SELECT active FROM service WHERE id = ${made.id}`);
      expect(row?.active).toBe(false);

      const again = await call('DELETE', `/salons/${SALON}/services/${made.id}`, manager);
      expect(again.statusCode).toBe(404);
      const patch = await call('PATCH', `/salons/${SALON}/services/${made.id}`, manager, { priceFils: 9000 });
      expect(patch.statusCode).toBe(404);

      const walkIn = await member();
      const charge = await call('POST', '/charges', till, { memberId: walkIn.id, serviceIds: [made.id] }, `sa-${randomUUID()}`);
      expect(charge.statusCode).toBe(400);
      expect(body(charge).error).toBe('invalid_services');
    });

    it('a LIVE booking whose service is retired stands, keeps its deposit, and can still be moved', async () => {
      const made = body(
        await call('POST', `/salons/${SALON}/services`, manager, { name: `SA Live retire ${RUN}`, priceFils: 5000 }),
      );
      await assign(made.id, [OLD_ARTIST]);
      const m = await member();
      const [first, second] = await slots(OLD_ARTIST, m.token, 2, 10);
      const booked = await book(m, OLD_ARTIST, made.id, first);
      expect(booked.statusCode, booked.body).toBe(201);
      const bookingId = body(booked).booking.id as string;

      expect((await call('DELETE', `/salons/${SALON}/services/${made.id}`, manager)).statusCode).toBe(204);

      const [row] = await exec(sql`SELECT status, deposit_fils FROM booking WHERE id = ${bookingId}`);
      expect(row?.status).toBe('deposit_held');
      const moved = await call('POST', `/bookings/${bookingId}/reschedule`, m.token, { startsAt: second });
      expect(moved.statusCode, moved.body).toBe(200);
    });
  });

  // ======================================================================
  // 3. ENFORCEMENT, ON ALL FIVE PATHS
  // ======================================================================
  describe('booking refuses an artist who does not do the service', () => {
    let svc: string;
    beforeAll(async () => {
      await db.execute(sql`
        INSERT INTO artist (id, salon_id, name, slot_minutes, windows, active)
        VALUES (${NEW_ARTIST}, ${SALON}, ${`SA New ${RUN}`}, 60, ${WEEK}::jsonb, true)`);
      svc = body(
        await call('POST', `/salons/${SALON}/services`, manager, { name: `SA Enforce ${RUN}`, priceFils: 5000 }),
      ).id;
    });

    it('a NEW service with nobody assigned: POST /bookings is 409 artist_not_assigned and moves no money', async () => {
      const m = await member(200_000);
      const res = await book(m, OLD_ARTIST, svc);
      expect(res.statusCode, res.body).toBe(409);
      expect(body(res)).toMatchObject({
        error: 'artist_not_assigned',
        artistId: OLD_ARTIST,
        serviceId: svc,
      });
      const [bal] = await exec(sql`SELECT balance_fils FROM member WHERE id = ${m.id}`);
      expect(Number(bal?.balance_fils)).toBe(200_000);
      const [n] = await exec(sql`SELECT count(*)::int AS n FROM booking WHERE member_id = ${m.id}`);
      expect(n?.n).toBe(0);
    });

    it('…and the merchant’s POST /salons/{id}/bookings is refused the same way', async () => {
      const m = await member();
      const [at] = await slots(OLD_ARTIST, m.token);
      const res = await call(
        'POST',
        `/salons/${SALON}/bookings`,
        manager,
        { artistId: OLD_ARTIST, serviceId: svc, startsAt: at, guestName: 'SA Walk-in' },
        `sa-${randomUUID()}`,
      );
      expect(res.statusCode, res.body).toBe(409);
      expect(body(res).error).toBe('artist_not_assigned');
    });

    it('once assigned, both creates succeed', async () => {
      expect(body(await assign(svc, [OLD_ARTIST])).artistIds).toEqual([OLD_ARTIST]);
      const m = await member();
      expect((await book(m, OLD_ARTIST, svc)).statusCode).toBe(201);
      const [at] = await slots(OLD_ARTIST, m.token, 1, 12);
      const merchant = await call(
        'POST',
        `/salons/${SALON}/bookings`,
        manager,
        { artistId: OLD_ARTIST, serviceId: svc, startsAt: at, guestName: 'SA Walk-in' },
        `sa-${randomUUID()}`,
      );
      expect(merchant.statusCode, merchant.body).toBe(201);
    });

    it('UNASSIGNING refuses both reschedules — and the booking stays where it was', async () => {
      const own = body(
        await call('POST', `/salons/${SALON}/services`, manager, { name: `SA Unassign ${RUN}`, priceFils: 5000 }),
      ).id as string;
      await assign(own, [OLD_ARTIST]);
      const m = await member();
      const [first, second] = await slots(OLD_ARTIST, m.token, 2, 14);
      const booked = await book(m, OLD_ARTIST, own, first);
      expect(booked.statusCode, booked.body).toBe(201);
      const bookingId = body(booked).booking.id as string;

      expect(body(await assign(own, [])).artistIds).toEqual([]);

      const mine = await call('POST', `/bookings/${bookingId}/reschedule`, m.token, { startsAt: second });
      expect(mine.statusCode, mine.body).toBe(409);
      expect(body(mine).error).toBe('artist_not_assigned');

      const theirs = await call('POST', `/salons/${SALON}/bookings/${bookingId}/reschedule`, manager, {
        startsAt: second,
      });
      expect(theirs.statusCode, theirs.body).toBe(409);
      expect(body(theirs).error).toBe('artist_not_assigned');

      const [row] = await exec(sql`SELECT status, starts_at FROM booking WHERE id = ${bookingId}`);
      expect(row?.status).toBe('deposit_held');
      expect(new Date(String(row?.starts_at)).toISOString()).toBe(new Date(first!).toISOString());

      // Put her back, and the same move goes through — the refusal was the assignment.
      await assign(own, [OLD_ARTIST]);
      const ok = await call('POST', `/bookings/${bookingId}/reschedule`, m.token, { startsAt: second });
      expect(ok.statusCode, ok.body).toBe(200);
    });

    it('REASSIGNING to an artist who does not do the service is refused; to one who does, it goes', async () => {
      const own = body(
        await call('POST', `/salons/${SALON}/services`, manager, { name: `SA Reassign ${RUN}`, priceFils: 5000 }),
      ).id as string;
      await assign(own, [OLD_ARTIST]);
      const m = await member();
      const booked = await book(m, OLD_ARTIST, own, (await slots(OLD_ARTIST, m.token, 1, 16))[0]);
      expect(booked.statusCode, booked.body).toBe(201);
      const bookingId = body(booked).booking.id as string;

      const refused = await call('POST', `/salons/${SALON}/bookings/${bookingId}/reassign`, manager, {
        artistId: NEW_ARTIST,
      });
      expect(refused.statusCode, refused.body).toBe(409);
      expect(body(refused).error).toBe('artist_not_assigned');
      const [still] = await exec(sql`SELECT artist_id FROM booking WHERE id = ${bookingId}`);
      expect(still?.artist_id).toBe(OLD_ARTIST);

      await assign(own, [OLD_ARTIST, NEW_ARTIST]);
      const ok = await call('POST', `/salons/${SALON}/bookings/${bookingId}/reassign`, manager, {
        artistId: NEW_ARTIST,
      });
      expect(ok.statusCode, ok.body).toBe(200);
    });

    it('another salon’s artist is still unknown_artist, not a 409 that confirms it exists', async () => {
      const m = await member();
      const res = await call(
        'POST',
        '/bookings',
        m.token,
        { artistId: FOREIGN_ARTIST, serviceId: svc, startsAt: new Date(Date.now() + 9 * 86_400_000).toISOString() },
        `sa-${randomUUID()}`,
      );
      expect(res.statusCode).toBe(404);
      expect(body(res).error).toBe('unknown_artist');
    });
  });

  // ======================================================================
  // 4. CHARGING IS NOT RESTRICTED
  // ======================================================================
  describe('charging is not restricted by assignment', () => {
    it('a service NOBODY is assigned to charges at the counter', async () => {
      const made = body(
        await call('POST', `/salons/${SALON}/services`, manager, { name: `SA Unassigned charge ${RUN}`, priceFils: 2500 }),
      );
      expect(made.artistIds).toEqual([]);
      const walkIn = await member();
      const res = await call('POST', '/charges', till, { memberId: walkIn.id, serviceIds: [made.id] }, `sa-${randomUUID()}`);
      expect(res.statusCode, res.body).toBe(200);
      const [t] = await exec(sql`SELECT amount_fils FROM "transaction" WHERE member_id = ${walkIn.id} AND kind = 'charge'`);
      expect(Number(t?.amount_fils)).toBe(-2500);
    });
  });

  // ======================================================================
  // 5. THE PERMISSIONS — two gates, and they are distinct
  // ======================================================================
  describe('permissions, server-side', () => {
    const withPerms = async (perms: { team?: boolean; loyalty?: boolean }, work: () => Promise<void>) => {
      const set = (team: boolean, loyalty: boolean) =>
        exec(sql`UPDATE staff_user SET perm_team = ${team}, perm_loyalty = ${loyalty} WHERE id = ${FRONTDESK}`);
      await set(perms.team ?? false, perms.loyalty ?? false);
      try {
        await work();
      } finally {
        await set(false, false);
      }
    };

    /** The permission's own copy — the only thing that says WHICH gate answered. */
    const LOYALTY_COPY = "You don't have permission to change loyalty settings. A manager can grant it.";
    const TEAM_COPY = "You don't have permission to manage the team. A manager can grant it.";

    it('loyalty OFF: POST, PATCH and DELETE are 403 and change nothing', async () => {
      const nope = `SA nope ${RUN}`;
      const post = await call('POST', `/salons/${SALON}/services`, frontdesk, { name: nope, priceFils: 1000 });
      const patch = await call('PATCH', `/salons/${SALON}/services/${OLD_SERVICE}`, frontdesk, { priceFils: 1 });
      const del = await call('DELETE', `/salons/${SALON}/services/${OLD_SERVICE}`, frontdesk);
      for (const r of [post, patch, del]) {
        expect(r.statusCode, r.body).toBe(403);
        expect(body(r).error).toBe('forbidden');
        expect(body(r).message).toBe(LOYALTY_COPY);
      }
      const [row] = await exec(sql`SELECT price_fils, active FROM service WHERE id = ${OLD_SERVICE}`);
      expect(Number(row?.price_fils)).toBe(9000);
      expect(row?.active).toBe(true);
      // Nothing was created, and no audit row claims anything happened.
      const [made] = await exec(sql`SELECT count(*)::int AS n FROM service WHERE name = ${nope}`);
      expect(made?.n).toBe(0);
      const [audited] = await exec(sql`
        SELECT count(*)::int AS n FROM audit_log
         WHERE actor_id = ${FRONTDESK} AND subject_type = 'service'
           AND (subject_id = ${OLD_SERVICE} OR detail LIKE ${`${nope}%`})`);
      expect(audited?.n).toBe(0);
    });

    it('team OFF: PUT …/artists is 403 and the set is unchanged', async () => {
      const before = await linksOf(OLD_SERVICE);
      const res = await assign(OLD_SERVICE, [], frontdesk);
      expect(res.statusCode, res.body).toBe(403);
      expect(body(res).error).toBe('forbidden');
      expect(body(res).message).toBe(TEAM_COPY);
      expect(await linksOf(OLD_SERVICE)).toEqual(before);
      const [audited] = await exec(sql`
        SELECT count(*)::int AS n FROM audit_log
         WHERE actor_id = ${FRONTDESK} AND subject_id = ${OLD_SERVICE} AND action = 'Service staff changed'`);
      expect(audited?.n).toBe(0);
    });

    it('THE MIRROR: team ON reaches the assignment and NOT the catalogue', async () => {
      await withPerms({ team: true }, async () => {
        const ok = await assign(OLD_SERVICE, [OLD_ARTIST, OLD_ARTIST_RETIRED], frontdesk);
        expect(ok.statusCode, ok.body).toBe(200);
        const price = await call('PATCH', `/salons/${SALON}/services/${OLD_SERVICE}`, frontdesk, { priceFils: 1 });
        expect(price.statusCode).toBe(403);
        expect(body(price).message).toBe(LOYALTY_COPY);
      });
    });

    it('THE MIRROR: loyalty ON reaches the catalogue and NOT the assignment', async () => {
      await withPerms({ loyalty: true }, async () => {
        const made = await call('POST', `/salons/${SALON}/services`, frontdesk, { name: `SA FD ${RUN}`, priceFils: 1200 });
        expect(made.statusCode, made.body).toBe(201);
        const put = await assign(body(made).id, [OLD_ARTIST], frontdesk);
        expect(put.statusCode).toBe(403);
        expect(body(put).message).toBe(TEAM_COPY);
      });
    });

    it('a scanner PIN session reaches none of the writes, whatever it holds', async () => {
      const post = await call('POST', `/salons/${SALON}/services`, till, { name: 'SA till', priceFils: 1000 });
      expect(post.statusCode).toBe(403);
      const put = await assign(OLD_SERVICE, [], till);
      expect(put.statusCode).toBe(403);
    });
  });

  // ======================================================================
  // 6. TENANCY
  // ======================================================================
  describe('tenancy', () => {
    it('salon B’s path is refused outright', async () => {
      for (const r of [
        await call('POST', `/salons/${OTHER_SALON}/services`, manager, { name: 'SA x', priceFils: 1000 }),
        await call('PATCH', `/salons/${OTHER_SALON}/services/${FOREIGN_SERVICE}`, manager, { priceFils: 1 }),
        await call('DELETE', `/salons/${OTHER_SALON}/services/${FOREIGN_SERVICE}`, manager),
        await call('PUT', `/salons/${OTHER_SALON}/services/${FOREIGN_SERVICE}/artists`, manager, { artistIds: [] }),
      ]) {
        expect(r.statusCode, r.body).toBe(403);
      }
    });

    it('salon B’s service id under salon A’s own path is 404 on every write, and untouched', async () => {
      for (const r of [
        await call('PATCH', `/salons/${SALON}/services/${FOREIGN_SERVICE}`, manager, { priceFils: 1 }),
        await call('DELETE', `/salons/${SALON}/services/${FOREIGN_SERVICE}`, manager),
        await assign(FOREIGN_SERVICE, [OLD_ARTIST]),
      ]) {
        expect(r.statusCode, r.body).toBe(404);
        expect(body(r).error).toBe('unknown_service');
      }
      const [row] = await exec(sql`SELECT price_fils, active FROM service WHERE id = ${FOREIGN_SERVICE}`);
      expect(Number(row?.price_fils)).toBe(5000);
      expect(row?.active).toBe(true);
      expect(await linksOf(FOREIGN_SERVICE)).not.toContain(OLD_ARTIST);
    });

    it('salon B’s artist cannot be assigned to salon A’s service, and is not named', async () => {
      const res = await assign(OLD_SERVICE, [OLD_ARTIST, FOREIGN_ARTIST]);
      expect(res.statusCode, res.body).toBe(404);
      expect(body(res).error).toBe('unknown_artist');
      expect(res.body).not.toContain(FOREIGN_ARTIST);
      expect(await linksOf(OLD_SERVICE)).not.toContain(FOREIGN_ARTIST);
    });

    it('THE SCHEMA refuses a cross-salon link even when no code path checks', async () => {
      await expect(
        db.execute(sql`
          INSERT INTO artist_service (artist_id, service_id, salon_id)
          VALUES (${FOREIGN_ARTIST}, ${OLD_SERVICE}, ${SALON})`),
      ).rejects.toThrow(/artist_service_artist_same_salon_fk/);
      await expect(
        db.execute(sql`
          INSERT INTO artist_service (artist_id, service_id, salon_id)
          VALUES (${FOREIGN_ARTIST}, ${OLD_SERVICE}, ${OTHER_SALON})`),
      ).rejects.toThrow(/artist_service_service_same_salon_fk/);
    });
  });

  describe('the assignment write itself', () => {
    it('replaces the set, refuses duplicates, and is quiet when nothing changes', async () => {
      const made = body(
        await call('POST', `/salons/${SALON}/services`, manager, { name: `SA Set ${RUN}`, priceFils: 1000 }),
      ).id as string;
      expect(body(await assign(made, [NEW_ARTIST, OLD_ARTIST])).artistIds).toEqual([NEW_ARTIST, OLD_ARTIST].sort());
      expect(body(await assign(made, [OLD_ARTIST])).artistIds).toEqual([OLD_ARTIST]);

      const dup = await assign(made, [OLD_ARTIST, OLD_ARTIST]);
      expect(dup.statusCode).toBe(400);
      expect(body(dup).error).toBe('duplicate_artist');
      const notArray = await call('PUT', `/salons/${SALON}/services/${made}/artists`, manager, { artistIds: OLD_ARTIST });
      expect(notArray.statusCode).toBe(400);

      const count = async () =>
        Number(
          (await exec(sql`SELECT count(*)::int AS n FROM audit_log WHERE subject_id = ${made} AND action = 'Service staff changed'`))[0]?.n,
        );
      const before = await count();
      expect((await assign(made, [OLD_ARTIST])).statusCode).toBe(200);
      expect(await count()).toBe(before);
    });

    it('a retired artist may be kept in the set, so a GET can be saved back unchanged', async () => {
      const list = body(await call('GET', `/salons/${SALON}/services`, manager)).items as any[];
      const row = list.find((x) => x.id === OLD_SERVICE);
      expect(row.artistIds).toContain(OLD_ARTIST_RETIRED);
      const res = await assign(OLD_SERVICE, row.artistIds);
      expect(res.statusCode, res.body).toBe(200);
      expect(body(res).artistIds).toEqual(row.artistIds);
    });
  });
});
