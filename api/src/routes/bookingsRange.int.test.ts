/**
 * `GET /salons/{id}/bookings?from=&to=` — A WEEK, ASKED FOR AS A WEEK.
 *
 * WHAT THIS REPLACES. Lane C's week grid could not name a window, so it walked
 * the cursor BACKWARDS THROUGH EVERY BOOKING NEWER THAN THE WEEK IT WANTED and
 * proved it held the week whole before it would draw. The proof was sound — the
 * stream is `starts_at DESC`, so a fetched row starting strictly before the
 * window's first day means nothing in the window is still out there — but it
 * cost a page walk per week and carried a 12-page budget, after which the grid
 * refused to draw and told the merchant it had stopped short.
 *
 * WHY THESE ARE INTEGRATION SPECS AND NOT UNIT ONES. `services/period.test.ts`
 * already pins the grammar, the refusals and the resolved instants; what it
 * cannot pin is whether a ROW lands on the right side of those instants. That is
 * a claim about a `timestamptz` comparison in Postgres against a `Date` handed
 * to drizzle, and the only way to be wrong about it is to be wrong by a
 * microsecond or by three hours — neither of which a pure spec can see.
 *
 * THE FIXTURE IS A REAL MERCHANT WEEK: Sunday 9 May 2027 to Saturday 15 May
 * 2027, which in Asia/Kuwait (UTC+3, no DST) is
 * `[2027-05-08T21:00:00Z, 2027-05-15T21:00:00Z)`. Every row below is placed
 * against one of those two instants on purpose, and 2027 is far enough out that
 * nothing seeded or minted by another suite shares the neighbourhood.
 *
 *   EDGE_IN    the window's FIRST instant, to the microsecond          in
 *   EDGE_OUT   one microsecond earlier                                 out
 *   LAST_IN    23:59 salon-local on `to`                               in
 *   NEXT_OUT   00:00 salon-local on the day after `to`                 out
 *   ZONE       21:30Z on TUESDAY, which is WEDNESDAY at the salon      in
 *   DONE       `completed`, for the composition with `?status=`        in
 *
 * ONE ARTIST PER BOOKING. `booking_artist_slot_no_overlap` is an EXCLUDE over
 * (`artist_id`, time range) for `deposit_held` and `completed`, and the whole
 * point of EDGE_IN and EDGE_OUT is that they are one microsecond apart — they
 * would collide on a shared artist. The house pattern is a per-run artist
 * (`bookingsPaging`, `reportsArtist`, `artistDayVoid`); this file mints six.
 *
 * BOTH CLAIMS WERE ANCHORED BY BREAKING THEM, not assumed from a green run:
 *
 *   `gte` → `gt` on the lower bound     4 of 12 go red, EDGE_IN first.
 *   `s.timezone` → `'UTC'`              6 of 12 go red, including the Wednesday
 *                                       spec, which flips to finding ZONE on the
 *                                       TUESDAY — the exact wrong answer, not an
 *                                       empty one.
 *
 * The six that survive both inversions are the refusals and the no-window spec,
 * which is correct: neither inversion touches the parser and neither can reach a
 * request that builds no predicate.
 *
 * `EG-` namespace, per-run suffix. `EN-` is `bookingsPaging`, `IT-` is `metrics`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const SALON = 'SAL-AMARA';
const BRANCH = 'BR-SAL';
const MANAGER = 'ST-001';

/** Sunday to Saturday, as a merchant says it. The salon is Asia/Kuwait. */
const WEEK_FROM = '2027-05-09';
const WEEK_TO = '2027-05-15';

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const id = (tag: string) => `EG-${tag}-${RUN}`;

const SVC = id('SV');
const MEMBER = id('M');
const HOLD = id('TXH');
const SETTLED = id('TXS');

/**
 * `[key, startsAt, status]`. The instants are written as UTC because that is what
 * the database stores and what makes the salon-local claim FALSIFIABLE: if the
 * zone stopped being applied, `2027-05-08T21:00:00Z` would fall on 8 May rather
 * than 9 May and EDGE_IN would leave the week.
 */
const ROWS = [
  ['EDGE_IN', '2027-05-08T21:00:00.000000Z', 'deposit_held'],
  ['EDGE_OUT', '2027-05-08T20:59:59.999999Z', 'deposit_held'],
  ['LAST_IN', '2027-05-15T20:59:00.000000Z', 'deposit_held'],
  ['NEXT_OUT', '2027-05-15T21:00:00.000000Z', 'deposit_held'],
  ['ZONE', '2027-05-11T21:30:00.000000Z', 'deposit_held'],
  ['DONE', '2027-05-13T08:00:00.000000Z', 'completed'],
] as const;

const BK: Record<string, string> = Object.fromEntries(ROWS.map(([k]) => [k, id(`BK-${k}`)]));
const IN_WEEK = ['EDGE_IN', 'LAST_IN', 'ZONE', 'DONE'].map((k) => BK[k] as string).sort();

suite('GET /salons/:id/bookings honours ?from= and ?to=', () => {
  let app: FastifyInstance;
  let db: (typeof import('../db/client'))['db'];
  let sql: (typeof import('drizzle-orm'))['sql'];
  let token: string;

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    sql = (await import('drizzle-orm')).sql;
    const issue = (await import('../auth/sessions')).issueSession;
    app = await (await import('../app')).buildApp();

    const artists = ROWS.map(([k]) => sql`(${id(`AR-${k}`)}, ${SALON}, ${`EG ${k} ${RUN}`})`);
    await db.execute(
      sql`INSERT INTO artist (id, salon_id, name) VALUES ${sql.join(artists, sql`, `)}`,
    );
    await db.execute(sql`
      INSERT INTO service (id, salon_id, name, price_fils)
      VALUES (${SVC}, ${SALON}, ${`EG Svc ${RUN}`}, 5000)`);
    await db.execute(sql`
      INSERT INTO member (id, salon_id, name, phone, password_hash, balance_fils, tier, visits, policy_version)
      VALUES (${MEMBER}, ${SALON}, 'EG Range Member',
              ${`+9656${String(Date.now() % 1_000_000).padStart(6, '0')}`}, 'x', 500000, 'bronze', 0, 1)`);

    /**
     * One hold for every row and one charge for the completed one.
     * `hold_transaction_id` is NOT NULL even on a settled booking — a completed
     * appointment still names the hold that preceded it — so DONE carries both.
     */
    await db.execute(sql`
      INSERT INTO "transaction"
        (id, member_id, salon_id, branch_id, kind, amount_fils, method, status, reference, created_at, settled_at)
      VALUES (${HOLD}, ${MEMBER}, ${SALON}, ${BRANCH}, 'deposit_hold', -5000, 'wallet', 'settled', '', now(), now()),
             (${SETTLED}, ${MEMBER}, ${SALON}, ${BRANCH}, 'charge', -5000, 'wallet', 'settled', '', now(), now())`);

    const values = ROWS.map(([k, at, status]) => {
      const held = status === 'deposit_held';
      return sql`(${BK[k]}, ${SALON}, ${BRANCH}, false, ${MEMBER}, ${id(`AR-${k}`)}, ${SVC},
        ${at}::timestamptz, ${at}::timestamptz + interval '30 minutes', 30, 5000, ${status},
        ${HOLD}, ${held ? null : SETTLED}, ${held ? null : sql`${at}::timestamptz`},
        ${at}::timestamptz + interval '30 minutes')`;
    });
    await db.execute(sql`
      INSERT INTO booking
        (id, salon_id, branch_id, branch_assumed, member_id, artist_id, service_id,
         starts_at, ends_at, duration_min, deposit_fils, status,
         hold_transaction_id, settled_transaction_id, completed_at, no_show_return_due_at)
      VALUES ${sql.join(values, sql`, `)}`);

    token = (
      await issue(db, { principalKind: 'staff', staffId: MANAGER, salonId: SALON, scope: 'dashboard' })
    ).accessToken;
  });

  afterAll(async () => {
    if (db) {
      await db.execute(sql`DELETE FROM booking WHERE id LIKE ${`EG-BK-%${RUN}`}`);
      await db.execute(sql`DELETE FROM "transaction" WHERE id IN (${HOLD}, ${SETTLED})`);
      await db.execute(sql`DELETE FROM artist WHERE id LIKE ${`EG-AR-%${RUN}`}`);
      await db.execute(sql`DELETE FROM service WHERE id = ${SVC}`);
      await db.execute(sql`DELETE FROM member WHERE id = ${MEMBER}`);
    }
    await app?.close();
  });

  interface Page {
    items: Array<{ id: string; startsAt: string }>;
    nextCursor: string | null;
  }

  async function get(query: Record<string, string>): Promise<{ status: number; body: Page & { error?: string; message?: string } }> {
    const res = await app.inject({
      method: 'GET',
      url: `/salons/${SALON}/bookings?${new URLSearchParams(query).toString()}`,
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  }

  /**
   * THIS RUN'S ROWS ONLY, and every page of them. The salon has seeded bookings
   * and every other int file's leftovers; a set equality against the whole table
   * would be a different, flakier assertion than the one being made.
   */
  async function ids(query: Record<string, string>): Promise<string[]> {
    const found: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 20; i++) {
      const page: Page & { error?: string } = (await get(cursor ? { ...query, cursor } : query)).body;
      found.push(...page.items.map((b) => b.id).filter((x) => x.includes(RUN)));
      cursor = page.nextCursor;
      if (!cursor) return found.sort();
    }
    throw new Error('the walk did not terminate in 20 pages');
  }

  const week = { from: WEEK_FROM, to: WEEK_TO };

  /**
   * THE LOWER BOUND, TO THE MICROSECOND. `timestamptz` stores microseconds; a
   * bound applied with `>` instead of `>=`, or one built from a millisecond
   * `Date` that rounded, moves EDGE_IN out of the week and the merchant loses
   * the first appointment of her Sunday.
   */
  it('a booking AT the window’s first instant is in; one microsecond earlier is out', async () => {
    const found = await ids(week);
    expect(found).toContain(BK.EDGE_IN);
    expect(found).not.toContain(BK.EDGE_OUT);
  });

  /**
   * THE UPPER BOUND, AND WHAT "INCLUSIVE" MEANS TO A MERCHANT. `to` names a day,
   * not an instant: `[from 00:00, to+1 00:00)`. So the last minute of Saturday is
   * Saturday's, and Sunday's first minute is not.
   */
  it('23:59 salon-local on `to` is in; 00:00 the next day is out', async () => {
    const found = await ids(week);
    expect(found).toContain(BK.LAST_IN);
    expect(found).not.toContain(BK.NEXT_OUT);
  });

  /**
   * THE ZONE IS THE SALON'S, AND THIS IS THE SPEC THAT SAYS SO.
   *
   * ZONE starts at 21:30Z on TUESDAY 11 May. In Kuwait that is 00:30 on
   * WEDNESDAY 12 May. Asking for Wednesday finds it and asking for Tuesday does
   * not — which is the exact inversion of what a UTC-resolved window would
   * answer. `time/zone.test.ts` pins the same shape one level down.
   */
  it('the SALON’s calendar day decides, not UTC’s', async () => {
    const wednesday = await ids({ from: '2027-05-12', to: '2027-05-12' });
    expect(wednesday).toEqual([BK.ZONE]);

    const tuesday = await ids({ from: '2027-05-11', to: '2027-05-11' });
    expect(tuesday).toEqual([]);

    // Anchored: the row really is stored on the 11th in UTC, so the assertion
    // above cannot be passing because the fixture drifted onto Wednesday.
    const [row] = (await get(week)).body.items.filter((b) => b.id === BK.ZONE);
    expect(row?.startsAt.slice(0, 10)).toBe('2027-05-11');
  });

  it('the range composes with ?status=, it does not replace it', async () => {
    expect(await ids({ ...week, status: 'completed' })).toEqual([BK.DONE]);
    expect(await ids({ ...week, status: 'deposit_held' })).toEqual(
      IN_WEEK.filter((x) => x !== BK.DONE),
    );
    // And the status filter still bounds a window it is given outside: DONE is
    // the only completed row of this run, and it is not in the day before.
    expect(await ids({ from: '2027-05-12', to: '2027-05-12', status: 'completed' })).toEqual([]);
  });

  it('the whole week is exactly the four rows that belong to it', async () => {
    expect(await ids(week)).toEqual(IN_WEEK);
  });

  /**
   * ABSENT PARAMETERS ARE NOT AN EMPTY WINDOW — they are NO WINDOW.
   *
   * The half of "additive" that a boundary spec cannot show: with neither
   * parameter the endpoint returns the rows a week-shaped window excludes, which
   * it could not do if the filter had acquired a default. The route's own
   * `parseCalendarRange` returns `null` here and no predicate is built; this is
   * that fact observed from outside.
   */
  it('no ?from=/?to= returns the rows the window excludes — the filter is absent, not empty', async () => {
    const unfiltered = await ids({ status: 'deposit_held,completed' });
    for (const k of Object.keys(BK)) expect(unfiltered).toContain(BK[k]);
  });

  /**
   * AND THE WINDOWS PARTITION IT. Three adjacent, disjoint windows reassemble
   * exactly the unfiltered set — no row is in two of them and none is in none.
   * A bound that was inclusive at both ends would double-count EDGE_OUT/EDGE_IN
   * at the seam, and this is the spec that would say so.
   */
  it('adjacent windows partition the timeline — nothing double-counted, nothing dropped', async () => {
    const before = await ids({ from: '2027-05-08', to: '2027-05-08' });
    const inside = await ids(week);
    const after = await ids({ from: '2027-05-16', to: '2027-05-16' });

    expect(before).toEqual([BK.EDGE_OUT]);
    expect(after).toEqual([BK.NEXT_OUT]);

    const union = [...before, ...inside, ...after].sort();
    expect(new Set(union).size).toBe(union.length);
    expect(union).toEqual(Object.values(BK).sort());
  });

  describe('what it refuses, at the wire', () => {
    const refusal = async (query: Record<string, string>) => {
      const res = await get(query);
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      return res.body as { error: string; message: string };
    };

    it('from without to, and to without from — by name', async () => {
      expect((await refusal({ from: WEEK_FROM })).message).toContain('from was given without to');
      expect((await refusal({ to: WEEK_TO })).message).toContain('to was given without from');
    });

    it('an unparseable date says WHICH field', async () => {
      const r = await refusal({ from: 'last-sunday', to: WEEK_TO });
      expect(r.error).toBe('invalid_range');
      expect(r.message).toContain('from is not a calendar date');
    });

    it('from after to', async () => {
      const r = await refusal({ from: WEEK_TO, to: WEEK_FROM });
      expect(r.error).toBe('invalid_range');
      expect(r.message).toContain('from is after to');
    });

    /**
     * THE CEILING. `from=2000-01-01` behind a permission check is a full scan of
     * `booking`; the refusal states the limit rather than saying "invalid",
     * because a client cannot act on "invalid".
     */
    it('a span past the ceiling names the limit', async () => {
      const r = await refusal({ from: '2000-01-01', to: WEEK_TO });
      expect(r.error).toBe('invalid_range');
      expect(r.message).toContain('366');
      expect(r.message).toMatch(/spans \d+ days/);
    });

    /**
     * THE GATE STILL COMES FIRST. A parameter refusal must not be reachable by a
     * caller who has no business on this endpoint — otherwise `?from=` is an
     * oracle for whether a salon takes appointments. `perms.appointments` is
     * unchanged by this slice and `permission-census.test.ts` owns the positive
     * half; this is the ordering half.
     */
    it('an unauthenticated caller gets 401, not a critique of its dates', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/salons/${SALON}/bookings?from=nonsense&to=nonsense`,
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
