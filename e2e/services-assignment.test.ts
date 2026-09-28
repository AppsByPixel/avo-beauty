/**
 * WHO DOES WHICH SERVICE, WHAT A SERVICE COSTS, AND WHEN A BRANCH IS OPEN —
 * migrations 0061, 0062 and 0063, driven from outside.
 *
 * HOW TO RUN
 *
 *   cd e2e && ../node_modules/.bin/vitest run services-assignment.test.ts
 *
 * WHAT CHANGED
 * ------------
 * Lane A (9d7a3cd, ffff86f) gave the merchant a Services tab — "add the services,
 * price it, then assign them" — and gave a branch its own hours:
 *
 *   POST   /salons/{id}/services               perms.loyalty  add
 *   PATCH  /salons/{id}/services/{sid}         perms.loyalty  rename / reprice
 *   DELETE /salons/{id}/services/{sid}         perms.loyalty  retire
 *   PUT    /salons/{id}/services/{sid}/artists perms.team     who does it
 *   PATCH  /salons/{id}/branches/{bid}         perms.loyalty  now also `businessHours`
 *
 * And a RULE: every path that commits an artist to performing a service at a time
 * — both creates, both reschedules, the reassign — refuses `409 artist_not_assigned`
 * unless `artist_service` holds the pair. Charging is deliberately NOT restricted.
 *
 * `api/src/routes/artistService.int.test.ts` and `branchHours.int.test.ts` are lane
 * A's claims about lane A's code, in-process. This file is the independent
 * restatement: a real API on a real port, this run's own Postgres, and every claim
 * about a row read back in SQL rather than off the API's own reply.
 *
 * FIXTURES
 * --------
 * Two artists of this file's own, `AR-QA-SA-X` and `AR-QA-SA-Y`, created AFTER the
 * seed — so, like every artist a salon adds tomorrow, they are assigned nothing.
 * Services are created THROUGH `POST …/services`, so they start as every new
 * service does: `artistIds: []`. Nothing here edits a seeded pair's assignment.
 *
 * Two members, `QA-SA-0001` (books) and `QA-SA-0002` (is charged), kept apart
 * because `findApplicableHold` spends a held deposit on the same member's next
 * charge in the grace window, and a charge spec must not be able to meet a
 * booking spec's hold. Both start at zero and are funded ONLY through the gateway,
 * and every deposit goes back through the member's own cancel — so both reconcile
 * to their ledger by construction and the wallet census needs no repair.
 *
 * Two staff, `ST-QA-SA-LOY` (perms.loyalty only) and `ST-QA-SA-TEAM` (perms.team
 * only), for the split. Deleted in `afterAll`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { precondition } from './support/known-bug.js';
import {
  A_STAFF_FULL,
  B_STAFF_HANDLE,
  QA_MEMBER,
  SALON_A,
  SALON_B,
  apiLogTail,
  mintWalletTokenFor,
  psql,
  repoRoot,
  scalar,
  signInDashboard,
  signInDashboardFresh,
  signInMember,
  signInScanner,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

const A_SCANNER_DEVICE = 'DEV-SCANNER-01';
const A_STAFF_HANDLE = 'noura';

/** This file's artists. Open every day, 10:00–19:00, thirty-minute grid. */
const X = 'AR-QA-SA-X';
const Y = 'AR-QA-SA-Y';
const WEEK = Object.fromEntries(
  ['0', '1', '2', '3', '4', '5', '6'].map((d) => [d, { open: true, from: '10:00', to: '19:00' }]),
);

/** The seed's roster and menu at salon A — `api/src/db/seed.ts`. */
const SEED_ARTISTS = ['AR-001', 'AR-002', 'AR-003', 'AR-004'];
const SEED_SERVICES = ['SV-01', 'SV-02', 'SV-03', 'SV-04', 'SV-05'];

/** `salon.deposit_fils`, seeded. */
const DEPOSIT_FILS = 5_000;

/** A branch that follows the salon's hours in the seed, and is not the pickup default. */
const KWC = 'BR-KWC';

const M = {
  // +965 5593xxxx: a range no other file uses. The first draft took 5597xxxx and
  // collided with member-bell.test.ts on `member_salon_phone_uq` — whichever file ran
  // second lost its beforeAll. Checked with a grep across e2e/ and the seed.
  book: { id: 'QA-SA-0001', phone: '+96555930001' },
  charge: { id: 'QA-SA-0002', phone: '+96555930002' },
} as const;
type Who = keyof typeof M;

const STAFF = {
  loyalty: { id: 'ST-QA-SA-LOY', handle: 'qasaloyalty', column: 'perm_loyalty' },
  team: { id: 'ST-QA-SA-TEAM', handle: 'qasateam', column: 'perm_team' },
} as const;

const member: Partial<Record<Who, string>> = {};
let loyaltyWeb = '';
let teamWeb = '';
let fullWeb = '';
let lumiereWeb = '';
let scanner = '';

/** Every booking this file made, so `afterAll` can give the deposits back. */
const bookings: string[] = [];
/** Every service this file created. */
const services: string[] = [];

let n = 0;
const key = (label: string) => `qasa-${label}-${Date.now()}-${n++}`;

// ------------------------------------------------------------------- reads --

const balanceOf = (who: Who): number =>
  Number(scalar(`select balance_fils from member where id='${M[who].id}'`));

/** `artist_service` for one service, as the table holds it — sorted, comma-joined. */
const assignedInSql = (serviceId: string): string =>
  scalar(
    `select coalesce(string_agg(artist_id, ',' order by artist_id), '')
       from artist_service where service_id = '${serviceId}'`,
  ).trim();

function bookingRow(id: string): { artist: string; startsAt: number; status: string; deposit: number } {
  const [artist, startsAt, status, deposit] = scalar(
    `select concat_ws('|', artist_id, extract(epoch from starts_at)::bigint, status, deposit_fils)
       from booking where id='${id}'`,
  )
    .trim()
    .split('|');
  precondition(!!artist, `no booking row ${id}`);
  return { artist: artist!, startsAt: Number(startsAt), status: status!, deposit: Number(deposit) };
}

function serviceRow(id: string): { price: number; active: boolean } {
  const [price, active] = scalar(
    `select concat_ws('|', price_fils, active::text) from service where id='${id}'`,
  )
    .trim()
    .split('|');
  return { price: Number(price), active: active === 'true' };
}

/**
 * Free slots on the first open day at or after `fromDay`, for one artist. Walked,
 * not computed — `reschedule.test.ts` says why. Far enough out (200+ days) that no
 * other file's booking can be in the way.
 */
async function freeSlots(artist: string, fromDay: number, need = 2): Promise<string[]> {
  for (let d = fromDay; d < fromDay + 30; d++) {
    const date = new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
    const day = await treq<any>('GET', `/artists/${artist}/availability?date=${date}`, {
      token: member.book!,
    });
    if (day.status !== 200) continue;
    const free = (day.body?.slots ?? [])
      .filter((s: any) => s.available === true)
      .map((s: any) => s.startsAt as string);
    if (free.length >= need) return free;
  }
  throw new Error(`${artist} has no day with ${need} free slots from day ${fromDay}`);
}

// ------------------------------------------------------------------ writes --

const book = (artistId: string, serviceId: string, startsAt: string) =>
  treq<any>('POST', '/bookings', {
    token: member.book!,
    idempotencyKey: key('book'),
    body: { artistId, serviceId, startsAt },
  });

function remember(res: { status: number; body: any }): string {
  const id = res.body?.booking?.id as string | undefined;
  if (res.status === 201 && id) bookings.push(id);
  return id ?? '';
}

const assign = (serviceId: string, artistIds: string[], token = teamWeb) =>
  treq<any>('PUT', `/salons/${SALON_A}/services/${serviceId}/artists`, {
    token,
    body: { artistIds },
  });

async function addService(name: string, priceFils: number): Promise<string> {
  const res = await treq<any>('POST', `/salons/${SALON_A}/services`, {
    token: loyaltyWeb,
    body: { name, priceFils },
  });
  precondition(res.status === 201, `POST …/services for "${name}": ${res.status} ${res.raw}`);
  services.push(res.body.id);
  return res.body.id as string;
}

async function charge(serviceIds: string[]) {
  const token = await mintWalletTokenFor(member.charge!, M.charge.id);
  return treq<any>('POST', '/charges', {
    token: scanner,
    idempotencyKey: key('charge'),
    body: { memberId: M.charge.id, token, serviceIds, confirmDuplicate: true },
  });
}

async function fundByTopUp(who: Who, amountFils: number): Promise<void> {
  const t = await treq<any>('POST', '/topups', {
    token: member[who]!,
    idempotencyKey: key(`${who}-fund`),
    body: { amountFils, method: 'knet' },
  });
  precondition(t.status === 200, `funding top-up for ${who}: ${t.status} ${t.raw}`);
  const ref = /\/_gateway\/([^/?#]+)/.exec(t.body.redirectUrl ?? '')?.[1];
  precondition(!!ref, `no sandbox gateway ref in ${t.body.redirectUrl}`);
  const paid = await treq<any>('POST', `/_gateway/${ref}`, {
    token: null,
    body: { outcome: 'succeeded', notify: true },
  });
  precondition(paid.status === 200, `the hosted page did not pay: ${paid.status} ${paid.raw}`);
  precondition(
    scalar(`select status from topup_intent where id='${t.body.id}'`).trim() === 'succeeded',
    `the funding top-up for ${who} did not settle`,
  );
}

// ---------------------------------------------------------------- fixtures --

beforeAll(async () => {
  await startTenancyApi();

  psql(`
    INSERT INTO artist (id, salon_id, name, slot_minutes, windows, active) VALUES
      ('${X}', '${SALON_A}', 'QA Services X', 30, '${JSON.stringify(WEEK)}'::jsonb, true),
      ('${Y}', '${SALON_A}', 'QA Services Y', 30, '${JSON.stringify(WEEK)}'::jsonb, true)
    ON CONFLICT (id) DO UPDATE SET active = true, windows = EXCLUDED.windows;
    -- Assigned nothing, which is what an artist added after 0062 is. Re-asserted so a
    -- rerun against one database starts where a fresh one does.
    DELETE FROM artist_service WHERE artist_id IN ('${X}', '${Y}');
  `);

  for (const who of Object.keys(M) as Who[]) {
    psql(`
      INSERT INTO member (id, salon_id, name, phone, email, email_verified, password_hash,
                          balance_fils, visits, tier, stamps, policy_version, notify_wa)
      SELECT '${M[who].id}', salon_id, 'Services QA ${who}', '${M[who].phone}', NULL, false,
             password_hash, 0, 0, 'silver', NULL, policy_version, false
        FROM member WHERE id = '${QA_MEMBER}'
      ON CONFLICT (id) DO NOTHING;
    `);
    precondition(
      scalar(`select count(*) from member where id='${M[who].id}'`).trim() === '1',
      `the clone source ${QA_MEMBER} is missing, so ${who} has no member row`,
    );
  }

  for (const s of Object.values(STAFF)) {
    psql(`
      INSERT INTO staff_user (id, salon_id, name, handle, role, branch_access_all,
                              branch_access_ids, password_hash, ${s.column})
      SELECT '${s.id}', salon_id, 'Services QA ${s.handle}', '${s.handle}', 'manager', true,
             '{}', password_hash, true
        FROM staff_user WHERE id = '${A_STAFF_FULL}'
      ON CONFLICT (id) DO UPDATE SET deactivated_at = NULL;
    `);
  }
  // Exactly one permission each, asserted rather than assumed: the split below is
  // only a split if neither holds the other's.
  const perms = (id: string) =>
    scalar(
      `select concat_ws('|', perm_dashboard, perm_appointments, perm_shop, perm_loyalty, perm_team,
                        perm_scanner, perm_charges, perm_void, perm_marketing)
         from staff_user where id='${id}'`,
    ).trim();
  precondition(perms(STAFF.loyalty.id) === 'f|f|f|t|f|f|f|f|f', `loyalty fixture perms: ${perms(STAFF.loyalty.id)}`);
  precondition(perms(STAFF.team.id) === 'f|f|f|f|t|f|f|f|f', `team fixture perms: ${perms(STAFF.team.id)}`);

  precondition(
    scalar(`select module_booking from salon where id='${SALON_A}'`).trim() === 't',
    `${SALON_A} has booking off, so nothing here can reach the assignment check`,
  );
  precondition(
    Number(scalar(`select deposit_fils from salon where id='${SALON_A}'`)) === DEPOSIT_FILS,
    `${SALON_A}'s deposit is not the seeded ${DEPOSIT_FILS}`,
  );
  precondition(
    scalar(`select coalesce(business_hours::text, 'NULL') from branch where id='${KWC}'`).trim() === 'NULL',
    `${KWC} already carries its own hours, so the fallback spec would start from the wrong place`,
  );

  for (const who of Object.keys(M) as Who[]) member[who] = await signInMember(SALON_A, M[who].phone);
  loyaltyWeb = await signInDashboardFresh(SALON_A, STAFF.loyalty.handle);
  teamWeb = await signInDashboardFresh(SALON_A, STAFF.team.handle);
  fullWeb = await signInDashboard(SALON_A, A_STAFF_HANDLE);
  lumiereWeb = await signInDashboard(SALON_B, B_STAFF_HANDLE);
  scanner = await signInScanner(SALON_A, A_STAFF_HANDLE, A_SCANNER_DEVICE);

  // Every deposit and charge below, through the gateway — never in SQL.
  await fundByTopUp('book', 40_000);
  await fundByTopUp('charge', 40_000);
}, 180_000);

afterAll(async () => {
  /**
   * THE DEPOSITS GO BACK THROUGH HER OWN CANCEL, which is the ledger-writing path —
   * so she reconciles with no repair. Only the ones still held: a booking moved or
   * reassigned is still one booking, and a cancelled one answers 409.
   */
  for (const id of bookings) {
    const status = scalar(`select status from booking where id='${id}'`).trim();
    if (status !== 'deposit_held') continue;
    const res = await treq<any>('DELETE', `/bookings/${id}`, { token: member.book! });
    if (res.status !== 200) {
      // eslint-disable-next-line no-console
      console.log(`[services-assignment] could not cancel ${id}: ${res.status} ${res.raw}`);
    }
  }
  /**
   * Then the rows. Bookings first (they reference artist and service, `restrict`),
   * then the artists and the services (`artist_service` cascades from both). Nothing
   * else references a service: a charge freezes its lines into `receipt_job.payload`,
   * and `best-selling-services` reads through `booking`. `deposit-health.test.ts` is
   * the precedent for deleting cancelled fixture bookings — the ledger pairs are
   * balanced and stay, so the census still reconciles.
   */
  if (bookings.length > 0) {
    psql(`DELETE FROM booking WHERE id IN (${bookings.map((b) => `'${b}'`).join(', ')});`);
  }
  psql(`
    DELETE FROM booking WHERE artist_id IN ('${X}', '${Y}');
    DELETE FROM artist WHERE id IN ('${X}', '${Y}') AND salon_id = '${SALON_A}';
    UPDATE branch SET business_hours = NULL WHERE id = '${KWC}';
    DELETE FROM staff_user WHERE id IN ('${STAFF.loyalty.id}', '${STAFF.team.id}');
  `);
  if (services.length > 0) {
    psql(`DELETE FROM service WHERE salon_id = '${SALON_A}'
            AND id IN (${services.map((s) => `'${s}'`).join(', ')});`);
  }
  await stopTenancyApi();
});

// ===========================================================================
// 1. Enforcement
// ===========================================================================

describe('an artist not assigned to a service cannot be committed to it — on every door', () => {
  let svc = '';
  let bookingId = '';
  let slotsX: string[] = [];

  beforeAll(async () => {
    svc = await addService('QA enforcement service', 6_000);
    slotsX = await freeSlots(X, 200, 3);
  });

  it("the customer's POST /bookings → 409 artist_not_assigned, and nothing is held", async () => {
    precondition(assignedInSql(svc) === '', `${svc} is not new and unassigned`);
    const before = balanceOf('book');

    const refused = await book(X, svc, slotsX[0]!);
    // Remembered even though it should not exist: if the rule ever breaks, the hold it
    // took is given back by afterAll instead of staying on her wallet.
    remember(refused);
    expect(refused.status, refused.raw).toBe(409);
    expect(refused.body.error).toBe('artist_not_assigned');
    expect(refused.body.artistId).toBe(X);
    expect(refused.body.serviceId).toBe(svc);
    expect(Number(scalar(`select count(*) from booking where artist_id='${X}' and service_id='${svc}'`))).toBe(0);
    expect(balanceOf('book'), 'a refused booking held a deposit').toBe(before);

    // THE CONTROL — the same request, once the pair exists, books. So the 409 above
    // was the assignment and nothing else: not the slot, not the money, not the artist.
    const put = await assign(svc, [X]);
    expect(put.status, put.raw).toBe(200);
    expect(put.body.artistIds).toEqual([X]);
    const booked = await book(X, svc, slotsX[0]!);
    expect(booked.status, `${booked.raw}\n${booked.status >= 500 ? apiLogTail() : ''}`).toBe(201);
    bookingId = remember(booked);
    expect(bookingRow(bookingId).deposit).toBe(DEPOSIT_FILS);
    expect(balanceOf('book')).toBe(before - DEPOSIT_FILS);
  });

  it('the front desk is held to the same rule — POST /salons/{id}/bookings → 409', async () => {
    precondition(assignedInSql(svc) === X, `${svc} should be assigned to ${X} only`);
    const res = await treq<any>('POST', `/salons/${SALON_A}/bookings`, {
      token: fullWeb,
      idempotencyKey: key('desk'),
      body: { artistId: Y, serviceId: svc, startsAt: slotsX[1]!, guestName: 'QA services desk' },
    });
    expect(res.status, res.raw).toBe(409);
    expect(res.body.error).toBe('artist_not_assigned');
    expect(Number(scalar(`select count(*) from booking where artist_id='${Y}'`))).toBe(0);
  });

  it('REASSIGNING a booking to an artist who does not do the service → 409, and the booking stays put', async () => {
    precondition(bookingId !== '', 'the first spec did not book');
    const refused = await treq<any>('POST', `/salons/${SALON_A}/bookings/${bookingId}/reassign`, {
      token: fullWeb,
      body: { artistId: Y },
    });
    expect(refused.status, refused.raw).toBe(409);
    expect(refused.body.error).toBe('artist_not_assigned');
    expect(bookingRow(bookingId).artist, 'the refused reassign moved the booking anyway').toBe(X);

    // Control: Y assigned, the same reassign goes through.
    expect((await assign(svc, [X, Y])).status).toBe(200);
    const moved = await treq<any>('POST', `/salons/${SALON_A}/bookings/${bookingId}/reassign`, {
      token: fullWeb,
      body: { artistId: Y },
    });
    expect(moved.status, moved.raw).toBe(200);
    expect(bookingRow(bookingId).artist).toBe(Y);
  });

  it('RESCHEDULING keeps enforcing — on both doors — and unassigning cancels nothing', async () => {
    precondition(bookingRow(bookingId).artist === Y, `${bookingId} is not with ${Y}`);
    // Take the service off Y, who holds the booking.
    const put = await assign(svc, [X]);
    expect(put.status, put.raw).toBe(200);
    expect(assignedInSql(svc)).toBe(X);

    const before = bookingRow(bookingId);
    // The booking at its original time still stands, deposit held.
    expect(before.status, 'unassigning her cancelled a live booking').toBe('deposit_held');
    expect(before.deposit).toBe(DEPOSIT_FILS);

    const target = (await freeSlots(Y, 200, 3)).find((s) => Date.parse(s) / 1000 !== before.startsAt)!;

    const customer = await treq<any>('POST', `/bookings/${bookingId}/reschedule`, {
      token: member.book!,
      body: { startsAt: target },
    });
    expect(customer.status, customer.raw).toBe(409);
    expect(customer.body.error).toBe('artist_not_assigned');

    const desk = await treq<any>('POST', `/salons/${SALON_A}/bookings/${bookingId}/reschedule`, {
      token: fullWeb,
      body: { startsAt: target },
    });
    expect(desk.status, desk.raw).toBe(409);
    expect(desk.body.error).toBe('artist_not_assigned');

    expect(bookingRow(bookingId), 'a refused reschedule moved or touched the booking').toEqual(before);

    // Control: give it back to her, and the same move goes through.
    expect((await assign(svc, [X, Y])).status).toBe(200);
    const ok = await treq<any>('POST', `/bookings/${bookingId}/reschedule`, {
      token: member.book!,
      body: { startsAt: target },
    });
    expect(ok.status, ok.raw).toBe(200);
    expect(bookingRow(bookingId).startsAt).toBe(Date.parse(target) / 1000);
  });
});

// ===========================================================================
// 2. The backfill preserved everything
// ===========================================================================

describe('the backfill — every salon that existed before 0061 still books on day one', () => {
  it('every seeded artist is assigned every seeded service, in SQL and on the wire', async () => {
    const pairs = Number(
      scalar(`select count(*) from artist_service
               where salon_id='${SALON_A}'
                 and artist_id in (${SEED_ARTISTS.map((a) => `'${a}'`).join(',')})
                 and service_id in (${SEED_SERVICES.map((s) => `'${s}'`).join(',')})`),
    );
    expect(pairs, 'a seeded artist lost a seeded service').toBe(SEED_ARTISTS.length * SEED_SERVICES.length);

    const menu = await treq<any>('GET', `/salons/${SALON_A}/services`, { token: fullWeb });
    expect(menu.status, menu.raw).toBe(200);
    for (const id of SEED_SERVICES) {
      const row = (menu.body.items as any[]).find((s) => s.id === id);
      expect(row, `${id} is not on the menu`).toBeDefined();
      for (const a of SEED_ARTISTS) expect(row.artistIds, `${id} does not list ${a}`).toContain(a);
    }
  });

  it('an existing artist and an existing service book — AR-002 for SV-01, 201', async () => {
    const slot = (await freeSlots('AR-002', 230, 1))[0]!;
    const res = await book('AR-002', 'SV-01', slot);
    expect(res.status, `${res.raw}\n${res.status >= 500 ? apiLogTail() : ''}`).toBe(201);
    remember(res);
  });

  /**
   * MIGRATION 0062 ITSELF, NOT THE SEED'S COPY OF IT.
   *
   * On a fresh database the order is migrate THEN seed, so 0062 runs over an empty
   * `artist` table and the rows the specs above read were written by `seed.ts`.
   * That proves the demo, not the production backfill — the claim that, if false,
   * answers `artist_not_assigned` to every booking at every salon on day one.
   *
   * So the migration FILE is run here, inside a transaction that is rolled back,
   * over an artist and a service that exist without a link — the production state
   * the day 0061 lands. Read from `api/drizzle`, so what runs is what ships.
   */
  it('0062, run over an unlinked artist and service, links each to everything at its own salon and nothing else', () => {
    const migration = readFileSync(
      join(repoRoot, 'api', 'drizzle', '0062_everyone_still_does_everything.sql'),
      'utf8',
    );
    precondition(/INSERT INTO "artist_service"/.test(migration), '0062 no longer inserts into artist_service');

    const out = psql(`
BEGIN;
INSERT INTO artist (id, salon_id, name) VALUES ('AR-QA-SA-BACKFILL', '${SALON_A}', 'QA backfill');
INSERT INTO service (id, salon_id, name, price_fils) VALUES ('SV-QA-SA-BACKFILL', '${SALON_A}', 'QA backfill', 1000);
${migration}
-- Twice: a migration re-run (or a half-applied one retried) must not fail on the rows it made.
${migration}
SELECT 'ARTIST_LINKS=' || count(*) FROM artist_service WHERE artist_id = 'AR-QA-SA-BACKFILL';
SELECT 'SALON_SERVICES=' || count(*) FROM service WHERE salon_id = '${SALON_A}';
SELECT 'SERVICE_LINKS=' || count(*) FROM artist_service WHERE service_id = 'SV-QA-SA-BACKFILL';
SELECT 'SALON_ARTISTS=' || count(*) FROM artist WHERE salon_id = '${SALON_A}';
SELECT 'FOREIGN=' || count(*) FROM artist_service l
  JOIN service s ON s.id = l.service_id
 WHERE l.artist_id = 'AR-QA-SA-BACKFILL' AND s.salon_id <> '${SALON_A}';
ROLLBACK;
`);
    const read = (k: string) => {
      const m = new RegExp(`${k}=(\\d+)`).exec(out);
      precondition(!!m, `no ${k} in:\n${out}`);
      return Number(m![1]);
    };
    expect(read('ARTIST_LINKS'), 'the backfill left an existing artist without a service').toBe(read('SALON_SERVICES'));
    expect(read('SERVICE_LINKS'), 'the backfill left an existing service without an artist').toBe(read('SALON_ARTISTS'));
    expect(read('FOREIGN'), 'the backfill linked an artist to another salon’s service').toBe(0);
    expect(Number(scalar(`select count(*) from artist where id='AR-QA-SA-BACKFILL'`)), 'the rollback did not').toBe(0);
  });
});

// ===========================================================================
// 3. Charging is not restricted
// ===========================================================================

describe('charging is NOT restricted — the counter can ring up a service nobody is assigned to', () => {
  it('POST /charges for an unassigned service → 200 at its menu price', async () => {
    const svc = await addService('QA unassigned charge', 3_000);
    precondition(assignedInSql(svc) === '', `${svc} has somebody assigned`);

    const res = await charge([svc]);
    expect(res.status, `${res.raw}\n${res.status >= 500 ? apiLogTail() : ''}`).toBe(200);
    expect(res.body.transaction.amountFils).toBe(-3_000);
    expect(res.body.customAmount).toBe(false);
    expect(
      Number(scalar(`select amount_fils from "transaction" where id='${res.body.transaction.id}'`)),
    ).toBe(-3_000);
  });
});

// ===========================================================================
// 4. The permission split
// ===========================================================================

describe('the permission split — the menu is perms.loyalty, who does it is perms.team', () => {
  const LOYALTY_COPY = "You don't have permission to change loyalty settings. A manager can grant it.";
  const TEAM_COPY = "You don't have permission to manage the team. A manager can grant it.";
  let svc = '';

  it('loyalty ONLY: adds and reprices, and cannot assign', async () => {
    const made = await treq<any>('POST', `/salons/${SALON_A}/services`, {
      token: loyaltyWeb,
      body: { name: 'QA split service', priceFils: 2_000 },
    });
    expect(made.status, made.raw).toBe(201);
    svc = made.body.id;
    services.push(svc);
    expect(made.body.artistIds).toEqual([]);

    const repriced = await treq<any>('PATCH', `/salons/${SALON_A}/services/${svc}`, {
      token: loyaltyWeb,
      body: { priceFils: 2_500 },
    });
    expect(repriced.status, repriced.raw).toBe(200);
    expect(serviceRow(svc).price).toBe(2_500);

    const put = await assign(svc, [X], loyaltyWeb);
    expect(put.status, put.raw).toBe(403);
    expect(put.body.error).toBe('forbidden');
    expect(put.body.message).toBe(TEAM_COPY);
    expect(assignedInSql(svc), 'a loyalty-only reader assigned staff').toBe('');
  });

  it('team ONLY: assigns, and cannot add, reprice or retire', async () => {
    precondition(svc !== '', 'the loyalty spec did not create a service');
    const put = await assign(svc, [X, Y], teamWeb);
    expect(put.status, put.raw).toBe(200);
    expect(assignedInSql(svc)).toBe([X, Y].sort().join(','));

    const count = () => Number(scalar(`select count(*) from service where salon_id='${SALON_A}' and name='QA split by team'`));
    const made = await treq<any>('POST', `/salons/${SALON_A}/services`, {
      token: teamWeb,
      body: { name: 'QA split by team', priceFils: 2_000 },
    });
    expect(made.status, made.raw).toBe(403);
    expect(made.body.message).toBe(LOYALTY_COPY);
    expect(count(), 'a team-only reader added a service').toBe(0);

    const patched = await treq<any>('PATCH', `/salons/${SALON_A}/services/${svc}`, {
      token: teamWeb,
      body: { priceFils: 100 },
    });
    expect(patched.status, patched.raw).toBe(403);
    expect(patched.body.message).toBe(LOYALTY_COPY);
    expect(serviceRow(svc).price, 'a team-only reader repriced the menu').toBe(2_500);

    const retired = await treq<any>('DELETE', `/salons/${SALON_A}/services/${svc}`, { token: teamWeb });
    expect(retired.status, retired.raw).toBe(403);
    expect(serviceRow(svc).active, 'a team-only reader retired a service').toBe(true);

    // Branch hours are Settings, which is loyalty — not the team's either.
    const hours = await treq<any>('PATCH', `/salons/${SALON_A}/branches/${KWC}`, {
      token: teamWeb,
      body: { businessHours: { morning: ['08:00', '12:00'], evening: ['14:00', '20:00'] } },
    });
    expect(hours.status, hours.raw).toBe(403);
    expect(hours.body.message).toBe(LOYALTY_COPY);
    expect(scalar(`select coalesce(business_hours::text, 'NULL') from branch where id='${KWC}'`).trim()).toBe('NULL');
  });

  it('loyalty retires — 204, the row stays, the menu drops it, the assignment is kept', async () => {
    const res = await treq<any>('DELETE', `/salons/${SALON_A}/services/${svc}`, { token: loyaltyWeb });
    expect(res.status, res.raw).toBe(204);
    expect(serviceRow(svc).active).toBe(false);
    expect(assignedInSql(svc), 'retiring threw the assignment away').toBe([X, Y].sort().join(','));
    const menu = await treq<any>('GET', `/salons/${SALON_A}/services`, { token: fullWeb });
    expect((menu.body.items as any[]).map((s) => s.id)).not.toContain(svc);
  });
});

// ===========================================================================
// 5. A price change moves no agreed money
// ===========================================================================

describe('a price change moves no money already agreed — and an unpaid basket takes the new price', () => {
  const OLD = 4_000;
  const NEW = 9_000;
  let svc = '';
  let pastTx = '';
  let liveBooking = '';
  let holdTx = '';

  beforeAll(async () => {
    svc = await addService('QA reprice service', OLD);
    expect((await assign(svc, [X])).status).toBe(200);

    const charged = await charge([svc]);
    precondition(charged.status === 200, `the past charge: ${charged.status} ${charged.raw}`);
    pastTx = charged.body.transaction.id;
    precondition(charged.body.transaction.amountFils === -OLD, `the past charge was not ${OLD}: ${charged.raw}`);

    const slot = (await freeSlots(X, 260, 1))[0]!;
    const booked = await book(X, svc, slot);
    precondition(booked.status === 201, `the live booking: ${booked.status} ${booked.raw}`);
    liveBooking = remember(booked);
    holdTx = scalar(`select hold_transaction_id from booking where id='${liveBooking}'`).trim();
    precondition(holdTx !== '', `${liveBooking} has no hold transaction`);
  });

  it('reprice → 200 at the new price, and the past charge, its ledger and the live deposit do not move', async () => {
    const snapshot = () => ({
      pastAmount: Number(scalar(`select amount_fils from "transaction" where id='${pastTx}'`)),
      pastLedger: Number(
        scalar(`select coalesce(sum(case direction when 'credit' then amount_fils else -amount_fils end), 0)
                  from ledger_entry where transaction_id='${pastTx}' and account='member_wallet'`),
      ),
      deposit: bookingRow(liveBooking).deposit,
      holdAmount: Number(scalar(`select amount_fils from "transaction" where id='${holdTx}'`)),
      /** The receipt's frozen line price, where one was queued. */
      receipt: scalar(
        `select coalesce(string_agg(payload->'services'->0->>'priceFils', ','), '')
           from receipt_job where transaction_id='${pastTx}'`,
      ).trim(),
      bookBalance: balanceOf('book'),
      chargeBalance: balanceOf('charge'),
    });
    const before = snapshot();
    precondition(before.pastAmount === -OLD, `past charge reads ${before.pastAmount}`);
    precondition(before.deposit === DEPOSIT_FILS, `live deposit reads ${before.deposit}`);

    const res = await treq<any>('PATCH', `/salons/${SALON_A}/services/${svc}`, {
      token: loyaltyWeb,
      body: { priceFils: NEW },
    });
    expect(res.status, res.raw).toBe(200);
    expect(res.body.priceFils).toBe(NEW);
    expect(serviceRow(svc).price).toBe(NEW);

    expect(snapshot(), 'a price edit moved money that had already been agreed').toEqual(before);
  });

  /**
   * LANE A'S FINDING, PINNED AS THE BEHAVIOUR THE MERCHANT IS TOLD ABOUT.
   *
   * A basket is a list of service ids and `POST /charges` carries no expected total,
   * so a charge posted after the edit commits is priced from the row as it is NOW —
   * whatever an open scanner screen was showing. `routes/services.ts` § A PRICE CHANGE
   * NEVER MOVES MONEY ALREADY AGREED says so in those words. If an expected-total
   * guard is ever added, this spec is where that decision becomes visible.
   */
  it('an UNPAID basket posted after the edit is charged the NEW price', async () => {
    precondition(serviceRow(svc).price === NEW, 'the reprice did not land');
    const res = await charge([svc]);
    expect(res.status, res.raw).toBe(200);
    expect(res.body.transaction.amountFils, 'the basket was charged the old price').toBe(-NEW);
  });
});

// ===========================================================================
// 6. Branch hours
// ===========================================================================

describe("a branch's own hours — served as 'branch', cleared back to 'salon', refused when invalid", () => {
  const OWN = { morning: ['08:30', '12:00'], evening: ['14:30', '20:30'] };
  const column = () => scalar(`select coalesce(business_hours::text, 'NULL') from branch where id='${KWC}'`).trim();
  const salonHours = () => JSON.parse(scalar(`select business_hours::text from salon where id='${SALON_A}'`));

  it("an override is served with businessHoursSource: 'branch' — on the PATCH and on GET /salons/{id}", async () => {
    precondition(JSON.stringify(salonHours()) !== JSON.stringify(OWN), "the override equals the salon's hours");
    const res = await treq<any>('PATCH', `/salons/${SALON_A}/branches/${KWC}`, {
      token: loyaltyWeb,
      body: { businessHours: OWN },
    });
    expect(res.status, res.raw).toBe(200);
    expect(res.body.businessHoursSource).toBe('branch');
    expect(res.body.businessHours).toEqual(OWN);
    expect(JSON.parse(column())).toEqual(OWN);

    const salon = await treq<any>('GET', `/salons/${SALON_A}`, { token: fullWeb });
    const kwc = (salon.body.branches as any[]).find((b) => b.id === KWC);
    expect(kwc.businessHoursSource).toBe('branch');
    expect(kwc.businessHours).toEqual(OWN);
  });

  it("clearing it (null) falls back to the salon's, with businessHoursSource: 'salon'", async () => {
    precondition(column() !== 'NULL', 'there is no override to clear');
    const res = await treq<any>('PATCH', `/salons/${SALON_A}/branches/${KWC}`, {
      token: loyaltyWeb,
      body: { businessHours: null },
    });
    expect(res.status, res.raw).toBe(200);
    expect(res.body.businessHoursSource).toBe('salon');
    expect(res.body.businessHours).toEqual(salonHours());
    expect(column()).toBe('NULL');
  });

  it('invalid hours → 400 invalid_business_hours, and the column is untouched', async () => {
    for (const bad of [
      { morning: ['25:00', '13:00'], evening: ['16:00', '21:00'] },
      { morning: '10:00-13:00', evening: ['16:00', '21:00'] },
      { morning: ['10:00'], evening: ['16:00', '21:00'] },
    ]) {
      const res = await treq<any>('PATCH', `/salons/${SALON_A}/branches/${KWC}`, {
        token: loyaltyWeb,
        body: { businessHours: bad },
      });
      expect(res.status, `${JSON.stringify(bad)} → ${res.raw}`).toBe(400);
      expect(res.body.error).toBe('invalid_business_hours');
    }
    expect(column()).toBe('NULL');
  });
});

// ===========================================================================
// 7. Tenancy
// ===========================================================================

describe("tenancy — salon B cannot touch salon A's services or branch hours, and nothing moves", () => {
  let svc = '';
  beforeAll(async () => {
    svc = await addService('QA tenancy service', 5_500);
    expect((await assign(svc, [X])).status).toBe(200);
  });

  const state = () => ({
    service: serviceRow(svc),
    assigned: assignedInSql(svc),
    hours: scalar(`select coalesce(business_hours::text, 'NULL') from branch where id='${KWC}'`).trim(),
    added: Number(scalar(`select count(*) from service where name='QA from salon B'`)),
  });

  it("salon B's manager: create, edit, retire, assign and set hours on salon A → 403 each, nothing changed", async () => {
    const before = state();
    const attempts: Array<[string, string, unknown]> = [
      ['POST', `/salons/${SALON_A}/services`, { name: 'QA from salon B', priceFils: 1_000 }],
      ['PATCH', `/salons/${SALON_A}/services/${svc}`, { priceFils: 1 }],
      ['DELETE', `/salons/${SALON_A}/services/${svc}`, undefined],
      ['PUT', `/salons/${SALON_A}/services/${svc}/artists`, { artistIds: [] }],
      ['PATCH', `/salons/${SALON_A}/branches/${KWC}`, { businessHours: { morning: ['01:00', '02:00'], evening: ['03:00', '04:00'] } }],
    ];
    for (const [method, path, body] of attempts) {
      const res = await treq<any>(method as any, path, {
        token: lumiereWeb,
        ...(body === undefined ? {} : { body }),
      });
      expect(res.status, `${method} ${path} → ${res.raw}`).toBe(403);
      expect(res.body.message).toBe('That salon is not yours.');
    }
    expect(state(), "a refused cross-salon write changed salon A's rows").toEqual(before);
  });

  it("through her OWN salon's path, salon A's ids are unknown — never edited", async () => {
    const before = state();
    const patched = await treq<any>('PATCH', `/salons/${SALON_B}/services/${svc}`, {
      token: lumiereWeb,
      body: { priceFils: 1 },
    });
    expect(patched.status, patched.raw).toBe(404);
    expect(patched.body.error).toBe('unknown_service');

    const put = await treq<any>('PUT', `/salons/${SALON_B}/services/${svc}/artists`, {
      token: lumiereWeb,
      body: { artistIds: [] },
    });
    expect(put.status, put.raw).toBe(404);
    expect(put.body.error).toBe('unknown_service');

    // Her own service, but salon A's artist: the same 404 an unknown id gets.
    const bService = scalar(`select id from service where salon_id='${SALON_B}' and active order by id limit 1`).trim();
    precondition(bService !== '', `${SALON_B} has no active service`);
    const bBefore = assignedInSql(bService);
    const foreign = await treq<any>('PUT', `/salons/${SALON_B}/services/${bService}/artists`, {
      token: lumiereWeb,
      body: { artistIds: [X] },
    });
    expect(foreign.status, foreign.raw).toBe(404);
    expect(foreign.body.error).toBe('unknown_artist');
    expect(assignedInSql(bService)).toBe(bBefore);

    const hours = await treq<any>('PATCH', `/salons/${SALON_B}/branches/${KWC}`, {
      token: lumiereWeb,
      body: { businessHours: null },
    });
    expect(hours.status, hours.raw).toBe(404);

    expect(state()).toEqual(before);
  });
});
