/**
 * `GET /v1/salons/{id}/overview/analytics` — against real rows, the real driver
 * and the real permission stack.
 *
 * =========================================================================
 * THE PROCESS CLOCK IS PINNED TO KARACHI, ON PURPOSE
 * =========================================================================
 * `TZ=Asia/Karachi` is set before anything is imported, and asserted. Karachi is
 * UTC+5 and the fixture salon is Kuwait, UTC+3, so a busiest-times grid bucketed
 * in the PROCESS zone would put a 21:30 Kuwait visit in the 23:00 column, and a
 * 23:30 Saturday visit on SUNDAY. The grid below has to show the salon's own
 * hours and days whatever this machine thinks the time is.
 *
 * =========================================================================
 * THE NUMBERS FIXTURE IS ROLLED BACK, NOT CLEANED UP
 * =========================================================================
 * `avo_app` has no DELETE on `campaign_send` or `shop_order_line` (both are
 * records of something that happened), so a fixture that wrote them could never
 * remove them, and the members and transactions they reference would stay too.
 * So every row the figures are computed over is written INSIDE ONE TRANSACTION,
 * every figure is computed through that transaction, and the transaction is
 * rolled back — `campaignAudience.int.test.ts`' pattern. Nothing it wrote is
 * ever visible to another suite, and there is nothing to delete.
 *
 * The ROUTE specs need committed rows, because `app.inject` reads through the
 * pool: two per-run salons, their branches and four staff. Those are deleted in
 * `afterAll` (sessions cascade off the staff rows).
 *
 * `now` IS PINNED for the figures (the metrics spec's reason: "today" moves).
 * The route specs, which cannot inject a clock, assert gates and shapes.
 *
 * =========================================================================
 * THE FIXTURE — salon A, Kuwait, tiers; window 1–14 September 2026 (Kuwait)
 * =========================================================================
 * Window [2026-08-31T21:00Z, 2026-09-14T21:00Z). NOW = 2026-09-16T09:00Z (Wed
 * 12:00 Kuwait). Branches B1 and B2.
 *
 *   members  M1 gold 10.000   joined 20 Aug (before)       — a prior visit 25 Aug
 *            M2 silver 5.000  joined Wed 2 Sep
 *            M3 bronze 0      joined Tue 8 Sep
 *            M4 no tier 2.500 joined 22:30Z Sat 12 Sep = 01:30 SUN 13 Sep Kuwait
 *
 *   charges  TX1 M1 B1 8.000   Wed 2 Sep 18:30 Kuwait   (BK1, AR1, SV1)
 *            TX2 M1 B1 20.000  Wed 9 Sep 21:30 Kuwait   (BK2, AR1, SV2)  ← 23:30 PKT
 *            TX3 M2 B2 5.000   Sat 12 Sep 23:30 Kuwait  walk-in, ASSUMED ← SUN in PKT
 *            TX4 M3 B2 20.000  Thu 10 Sep 10:15 Kuwait  (BK4, AR2, SV2)
 *            TX5 M3 B1 8.000   Thu 10 Sep 10:45 Kuwait  walk-in, VOIDED
 *            TX0 M1 B1 8.000   25 Aug — before the window, makes M1 "returning"
 *
 *   bookings BK1 BK2 BK4 completed · BK5 (AR2 SV1 B2 M2) no-show · BK6 cancelled
 *            BK7 guest, today 18:00 · BK8 Sat 19 Sep · BK9 2031 · BK10 overdue held
 *
 *   top-ups  knet 11.000 (1.000 bonus) · card 5.000 · knet 2.500 · applepay PENDING
 *   shop     TS1 M2 B1 6.000 ready  (Serum ×2 @2.000, Oil ×1 @2.000)
 *            TS2 M1 B2 3.000 preparing (Oil ×1, Comb ×1 @1.000) · TS3 20 Aug, outside
 *   campaigns C1 sent 5 Sep to M1, M2 (reach 10) · C2 sent 10 Aug · C3 pending
 *
 * Salon B: stamps, target 6, shop module OFF; three members at 0, 2 and 6 stamps.
 */

process.env.TZ = 'Asia/Karachi';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const P = `OV${RUN}`;
const A = `${P}-SA`;
const B = `${P}-SB`;
const A1 = `${P}-A1`;
const A2 = `${P}-A2`;
const B1 = `${P}-B1`;
const ST = {
  mgrA: `${P}-ST-MA`,
  limitedA: `${P}-ST-LA`,
  noDashA: `${P}-ST-NA`,
  mgrB: `${P}-ST-MB`,
};
const id = (s: string) => `${P}-${s}`;

const NOW = new Date('2026-09-16T09:00:00.000Z');
const WINDOW = '2026-09-01_2026-09-14';

const ALL_PERMS = {
  dashboard: true,
  appointments: true,
  shop: true,
  loyalty: true,
  team: true,
  scanner: true,
  charges: true,
  void: true,
  marketing: true,
};
const DASHBOARD_ONLY = Object.fromEntries(
  Object.keys(ALL_PERMS).map((k) => [k, k === 'dashboard']),
) as typeof ALL_PERMS;

type Res = { status: number; body: Record<string, any> };

suite('GET /v1/salons/:id/overview/analytics', () => {
  let app: FastifyInstance;
  let db: (typeof import('../db/client'))['db'];
  let sql: (typeof import('drizzle-orm'))['sql'];
  /**
   * FROM `@avo/types`, where trunk landed these shapes (8769f4c). The API's own
   * copy was deleted, so the analytics this serves and the contract the dashboard
   * parses are one declaration and cannot drift.
   */
  let Schema: (typeof import('@avo/types'))['OverviewAnalyticsSchema'];
  const bearer: Record<keyof typeof ST, string> = { mgrA: '', limitedA: '', noDashA: '', mgrB: '' };

  // Everything computed inside the rolled-back fixture transaction.
  const got: Record<string, any> = {};

  const exec = async (q: unknown) =>
    (await db.execute(q as never)) as unknown as Array<Record<string, unknown>>;

  const call = async (url: string, who: keyof typeof ST): Promise<Res> => {
    const res = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${bearer[who]}` },
    });
    return { status: res.statusCode, body: JSON.parse(res.body || '{}') as Record<string, any> };
  };

  beforeAll(async () => {
    expect(
      new Date('2026-09-09T18:30:00.000Z').getHours(),
      'the process zone must be Karachi for the busiest-times spec to mean anything',
    ).toBe(23);

    db = (await import('../db/client')).db;
    sql = (await import('drizzle-orm')).sql;
    Schema = (await import('@avo/types')).OverviewAnalyticsSchema;
    const issue = (await import('../auth/sessions')).issueSession;
    const { computeOverviewAnalytics } = await import('./overviewAnalytics');
    const { computeReport } = await import('./reports');
    const { computeMetrics } = await import('./metrics');
    const { computeDepositHealth } = await import('./depositHealth');
    const { parsePeriod } = await import('./period');
    app = await (await import('../app')).buildApp();

    // ---------------------------------------------- committed: salons, staff --
    const hours = JSON.stringify({ morning: ['10:00', '13:00'], evening: ['16:00', '22:00'] });
    await exec(sql`
      INSERT INTO salon (id, name, brand_color, loyalty_mode, tiers, deposit_fils, business_hours,
                         module_booking, module_shop, timezone)
      VALUES (${A}, ${`OV Salon A ${RUN}`}, '#7A5C8E', 'tiers',
              (SELECT tiers FROM salon WHERE id = 'SAL-LUMIERE'), 2000, ${hours}::jsonb,
              true, true, 'Asia/Kuwait')`);
    await exec(sql`
      INSERT INTO salon (id, name, brand_color, loyalty_mode, stamp_target, stamp_reward, deposit_fils,
                         business_hours, module_booking, module_shop, timezone)
      VALUES (${B}, ${`OV Salon B ${RUN}`}, '#7A5C8E', 'stamps', 6, 'free blow-dry', 2000,
              ${hours}::jsonb, true, false, 'Asia/Kuwait')`);
    await exec(sql`
      INSERT INTO branch (id, salon_id, name) VALUES
        (${A1}, ${A}, 'OV Salmiya'), (${A2}, ${A}, 'OV Hawally'), (${B1}, ${B}, 'OV Jabriya')`);

    const staff = async (sid: string, salonId: string, perms: typeof ALL_PERMS) => {
      await exec(sql`
        INSERT INTO staff_user
          (id, salon_id, name, handle, role, branch_access_all, branch_access_ids, password_hash,
           perm_dashboard, perm_appointments, perm_shop, perm_loyalty, perm_team, perm_scanner,
           perm_charges, perm_void, perm_marketing)
        VALUES (${sid}, ${salonId}, ${`OV ${sid}`}, ${sid.toLowerCase()}, 'manager', true, '{}', 'x',
                ${perms.dashboard}, ${perms.appointments}, ${perms.shop}, ${perms.loyalty},
                ${perms.team}, ${perms.scanner}, ${perms.charges}, ${perms.void}, ${perms.marketing})`);
      return (await issue(db, { principalKind: 'staff', staffId: sid, salonId, scope: 'dashboard' }))
        .accessToken;
    };
    bearer.mgrA = await staff(ST.mgrA, A, ALL_PERMS);
    bearer.limitedA = await staff(ST.limitedA, A, DASHBOARD_ONLY);
    bearer.noDashA = await staff(ST.noDashA, A, { ...ALL_PERMS, dashboard: false });
    bearer.mgrB = await staff(ST.mgrB, B, ALL_PERMS);

    // ------------------------------------- rolled back: the numbers fixture --
    try {
      await db.transaction(async (tx) => {
        const t = async (q: unknown) => tx.execute(q as never);
        const M = { m1: id('M1'), m2: id('M2'), m3: id('M3'), m4: id('M4') };
        const phone = () => `+9655${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
        const member = (mid: string, salonId: string, tier: string | null, stamps: number | null,
                        balance: number, joined: string) => t(sql`
          INSERT INTO member (id, salon_id, name, phone, password_hash, balance_fils, tier, stamps,
                              visits, policy_version, joined_at)
          VALUES (${mid}, ${salonId}, ${`OV ${mid}`}, ${phone()}, '$argon2id$fake-not-a-credential',
                  ${balance}, ${tier}, ${stamps}, 0, 3, ${joined}::timestamptz)`);
        await member(M.m1, A, 'gold', null, 10000, '2026-08-20T10:00:00Z');
        await member(M.m2, A, 'silver', null, 5000, '2026-09-02T10:00:00Z');
        await member(M.m3, A, 'bronze', null, 0, '2026-09-08T10:00:00Z');
        await member(M.m4, A, null, null, 2500, '2026-09-12T22:30:00Z');
        await member(id('MB1'), B, null, 2, 0, '2026-09-02T10:00:00Z');
        await member(id('MB2'), B, null, 6, 0, '2026-09-02T10:00:00Z');
        await member(id('MB3'), B, null, null, 0, '2026-09-02T10:00:00Z');

        await t(sql`
          INSERT INTO service (id, salon_id, name, price_fils) VALUES
            (${id('SV1')}, ${A}, 'OV Cut', 8000), (${id('SV2')}, ${A}, 'OV Colour', 20000),
            (${id('SV3')}, ${A}, 'OV Nails', 5000)`);
        await t(sql`
          INSERT INTO artist (id, salon_id, name) VALUES
            (${id('AR1')}, ${A}, 'OV Rana'), (${id('AR2')}, ${A}, 'OV Dana'), (${id('AR3')}, ${A}, 'OV Idle')`);

        const tx1 = async (
          tid: string, mid: string, br: string, assumed: boolean, kind: string, amount: number,
          at: string, opts: { method?: string; bonus?: number; status?: string; reverses?: string } = {},
        ) => {
          const status = opts.status ?? 'settled';
          await t(sql`
            INSERT INTO "transaction"
              (id, member_id, salon_id, branch_id, branch_assumed, kind, amount_fils, bonus_fils,
               method, status, reverses_transaction_id, created_at, settled_at)
            VALUES (${tid}, ${mid}, ${A}, ${br}, ${assumed}, ${kind}, ${amount}, ${opts.bonus ?? 0},
                    ${opts.method ?? null}, ${status}, ${opts.reverses ?? null}, ${at}::timestamptz,
                    ${status === 'settled' ? at : null}::timestamptz)`);
        };
        // charges
        await tx1(id('TX0'), M.m1, A1, false, 'charge', -8000, '2026-08-25T12:00:00Z', { method: 'wallet' });
        await tx1(id('TX1'), M.m1, A1, false, 'charge', -8000, '2026-09-02T15:30:00Z', { method: 'wallet' });
        await tx1(id('TX2'), M.m1, A1, false, 'charge', -20000, '2026-09-09T18:30:00Z', { method: 'wallet' });
        await tx1(id('TX3'), M.m2, A2, true, 'charge', -5000, '2026-09-12T20:30:00Z', { method: 'wallet' });
        await tx1(id('TX4'), M.m3, A2, false, 'charge', -20000, '2026-09-10T07:15:00Z', { method: 'wallet' });
        await tx1(id('TX5'), M.m3, A1, false, 'charge', -8000, '2026-09-10T07:45:00Z', { method: 'wallet' });
        await tx1(id('TXV'), M.m3, A1, false, 'adjustment', 8000, '2026-09-10T08:00:00Z', { reverses: id('TX5') });
        // top-ups — every one branch_assumed, as services/topup.ts writes them
        await tx1(id('TU1'), M.m1, A1, true, 'topup', 11000, '2026-09-03T10:00:00Z', { method: 'knet', bonus: 1000 });
        await tx1(id('TU2'), M.m2, A1, true, 'topup', 5000, '2026-09-04T10:00:00Z', { method: 'card' });
        await tx1(id('TU3'), M.m4, A1, true, 'topup', 2500, '2026-09-05T10:00:00Z', { method: 'knet' });
        await tx1(id('TU4'), M.m3, A1, true, 'topup', 3000, '2026-09-06T10:00:00Z', { method: 'applepay', status: 'pending' });
        // deposit holds and returns — not revenue, not spend
        for (const h of ['H1', 'H2', 'H4', 'H5', 'H6', 'H8', 'H9', 'H10']) {
          await tx1(id(h), M.m1, A1, false, 'deposit_hold', -2000, '2026-08-30T10:00:00Z');
        }
        await tx1(id('R5'), M.m2, A2, false, 'deposit_return', 2000, '2026-09-11T09:00:00Z');
        await tx1(id('R6'), M.m4, A1, false, 'deposit_return', 2000, '2026-09-11T09:00:00Z');
        // kept deposits (migration 0066) — revenue, and spend. `amount_fils` is 0 by
        // CHECK; the magnitude is the `salon_revenue` leg, which is what is read.
        // m1 is already active in the window, so no member count moves.
        const forfeit = async (tid: string, br: string, kept: number, at: string) => {
          await tx1(tid, M.m1, br, false, 'deposit_forfeit', 0, at, { method: 'wallet' });
          await t(sql`
            INSERT INTO ledger_entry (transaction_id, salon_id, member_id, account, direction, amount_fils, balance_after_fils)
            VALUES (${tid}, ${A}, NULL, 'deposit_held', 'debit', ${kept}, NULL),
                   (${tid}, ${A}, NULL, 'salon_revenue', 'credit', ${kept}, NULL)`);
        };
        await forfeit(id('F0'), A1, 700, '2026-08-28T10:00:00Z'); // outside the window
        await forfeit(id('F1'), A1, 2000, '2026-09-09T19:00:00Z'); // the same day and branch as TX2
        await forfeit(id('F2'), A2, 1500, '2026-09-13T10:00:00Z'); // a day with no sale at A2

        const bk = async (
          bid: string, o: { member: string | null; guest?: string; artist: string; service: string;
            branch: string; assumed?: boolean; starts: string; deposit: number; hold: string | null;
            status: string; settled?: string | null; source?: string },
        ) => {
          const starts = new Date(o.starts);
          const ends = new Date(starts.getTime() + 3_600_000);
          const due = new Date(ends.getTime() + 3_600_000);
          await t(sql`
            INSERT INTO booking
              (id, salon_id, branch_id, branch_assumed, member_id, guest_name, artist_id, service_id,
               starts_at, ends_at, duration_min, deposit_fils, status, source, hold_transaction_id,
               settled_transaction_id, no_show_return_due_at, completed_at, cancelled_at, returned_at)
            VALUES (${bid}, ${A}, ${o.branch}, ${o.assumed ?? false}, ${o.member}, ${o.guest ?? null},
                    ${o.artist}, ${o.service}, ${starts.toISOString()}::timestamptz,
                    ${ends.toISOString()}::timestamptz, 60, ${o.deposit}, ${o.status},
                    ${o.source ?? 'app'}, ${o.hold}, ${o.settled ?? null}, ${due.toISOString()}::timestamptz,
                    ${o.status === 'completed' ? ends.toISOString() : null}::timestamptz,
                    ${o.status === 'cancelled' ? starts.toISOString() : null}::timestamptz,
                    ${o.status === 'no_show_returned' ? due.toISOString() : null}::timestamptz)`);
        };
        const [AR1, AR2] = [id('AR1'), id('AR2')];
        const [SV1, SV2, SV3] = [id('SV1'), id('SV2'), id('SV3')];
        await bk(id('BK1'), { member: M.m1, artist: AR1, service: SV1, branch: A1, starts: '2026-09-02T15:00:00Z', deposit: 2000, hold: id('H1'), status: 'completed', settled: id('TX1') });
        await bk(id('BK2'), { member: M.m1, artist: AR1, service: SV2, branch: A1, starts: '2026-09-09T18:00:00Z', deposit: 2000, hold: id('H2'), status: 'completed', settled: id('TX2') });
        await bk(id('BK4'), { member: M.m3, artist: AR2, service: SV2, branch: A2, assumed: true, starts: '2026-09-10T07:00:00Z', deposit: 2000, hold: id('H4'), status: 'completed', settled: id('TX4') });
        await bk(id('BK5'), { member: M.m2, artist: AR2, service: SV1, branch: A2, starts: '2026-09-11T07:00:00Z', deposit: 2000, hold: id('H5'), status: 'no_show_returned', settled: id('R5') });
        await bk(id('BK6'), { member: M.m4, artist: AR1, service: SV3, branch: A1, starts: '2026-09-12T07:00:00Z', deposit: 2000, hold: id('H6'), status: 'cancelled', settled: id('R6') });
        await bk(id('BK7'), { member: null, guest: 'Walk-in Wafa', artist: AR2, service: SV3, branch: A1, starts: '2026-09-16T15:00:00Z', deposit: 0, hold: null, status: 'deposit_held', source: 'merchant' });
        await bk(id('BK8'), { member: M.m2, artist: AR1, service: SV1, branch: A2, starts: '2026-09-19T08:00:00Z', deposit: 2000, hold: id('H8'), status: 'deposit_held' });
        await bk(id('BK9'), { member: M.m1, artist: AR1, service: SV2, branch: A1, starts: '2031-10-05T08:00:00Z', deposit: 3000, hold: id('H9'), status: 'deposit_held' });
        await bk(id('BK10'), { member: M.m3, artist: AR2, service: SV1, branch: A1, starts: '2026-09-15T08:00:00Z', deposit: 2000, hold: id('H10'), status: 'deposit_held' });

        // shop
        await t(sql`
          INSERT INTO product (id, salon_id, name, price_fils) VALUES
            (${id('P1')}, ${A}, 'OV Serum', 2000), (${id('P2')}, ${A}, 'OV Oil', 2000),
            (${id('P3')}, ${A}, 'OV Comb', 1000)`);
        await tx1(id('TS1'), M.m2, A1, true, 'shop', -6000, '2026-09-06T12:00:00Z', { method: 'wallet' });
        await tx1(id('TS2'), M.m1, A2, false, 'shop', -3000, '2026-09-11T12:00:00Z', { method: 'wallet' });
        await tx1(id('TS3'), M.m1, A1, false, 'shop', -2000, '2026-08-20T12:00:00Z', { method: 'wallet' });
        const order = (tid: string, mid: string, status: string, at: string) => t(sql`
          INSERT INTO shop_order (transaction_id, salon_id, member_id, fulfilment, status, created_at,
                                  ready_at, closed_at)
          VALUES (${tid}, ${A}, ${mid}, 'pickup', ${status}, ${at}::timestamptz,
                  ${status === 'preparing' ? null : at}::timestamptz,
                  ${status === 'closed' ? at : null}::timestamptz)`);
        await order(id('TS1'), M.m2, 'ready', '2026-09-06T12:00:00Z');
        await order(id('TS2'), M.m1, 'preparing', '2026-09-11T12:00:00Z');
        await order(id('TS3'), M.m1, 'closed', '2026-08-20T12:00:00Z');
        await t(sql`
          INSERT INTO shop_order_line (transaction_id, product_id, name, qty, unit_price_fils, line_total_fils) VALUES
            (${id('TS1')}, ${id('P1')}, 'OV Serum', 2, 2000, 4000),
            (${id('TS1')}, ${id('P2')}, 'OV Oil', 1, 2000, 2000),
            (${id('TS2')}, ${id('P2')}, 'OV Oil', 1, 2000, 2000),
            (${id('TS2')}, ${id('P3')}, 'OV Comb', 1, 1000, 1000),
            (${id('TS3')}, ${id('P3')}, 'OV Comb', 2, 1000, 2000)`);

        // campaigns
        const campaign = (cid: string, status: string, reach: number, result: string | null) => t(sql`
          INSERT INTO campaign (id, salon_id, title, body, channel, audience, status, reach, result,
                                submitted_by, submitted_at, decided_by, decided_at)
          VALUES (${cid}, ${A}, ${`OV ${cid}`}, 'Come in this week.', 'push', 'all', ${status}, ${reach},
                  ${result}, 'OV spec', '2026-08-01T00:00:00Z',
                  ${status === 'pending' ? null : 'OV reviewer'},
                  ${status === 'pending' ? null : '2026-08-01T00:00:00Z'}::timestamptz)`);
        await campaign(id('C1'), 'sent', 10, '2 reached');
        await campaign(id('C2'), 'sent', 5, '1 reached');
        await campaign(id('C3'), 'pending', 7, null);
        await t(sql`
          INSERT INTO campaign_send (campaign_id, member_id, sent_at, channel) VALUES
            (${id('C1')}, ${M.m1}, '2026-09-05T08:00:00Z', 'push'),
            (${id('C1')}, ${M.m2}, '2026-09-05T08:00:00Z', 'push'),
            (${id('C2')}, ${M.m3}, '2026-08-10T08:00:00Z', 'push')`);

        // ---------------------------------------------------- compute all --
        const Tx = tx as unknown as typeof db;
        const period = parsePeriod(WINDOW);
        const salonA = {
          id: A, timezone: 'Asia/Kuwait', loyaltyMode: 'tiers' as const, stampTarget: null,
          tierNames: ['bronze', 'silver', 'gold', 'black'], moduleBooking: true, moduleShop: true,
        };
        const run = (over: Partial<Parameters<typeof computeOverviewAnalytics>[1]>) =>
          computeOverviewAnalytics(Tx, { salon: salonA, period, branch: null, perms: ALL_PERMS, now: NOW, ...over });
        got.all = await run({});
        got.b1 = await run({ branch: { id: A1, name: 'OV Salmiya' } });
        got.b2 = await run({ branch: { id: A2, name: 'OV Hawally' } });
        got.limited = await run({ perms: DASHBOARD_ONLY });
        got.stamps = await computeOverviewAnalytics(Tx, {
          salon: { id: B, timezone: 'Asia/Kuwait', loyaltyMode: 'stamps', stampTarget: 6,
                   tierNames: null, moduleBooking: true, moduleShop: false },
          period, branch: null, perms: ALL_PERMS, now: NOW,
        });
        const report = (kind: 'best-selling-services' | 'artist-performance' | 'sales') =>
          computeReport(Tx, { kind, salonId: A, branchId: null, period, timezone: 'Asia/Kuwait', now: NOW });
        got.bestSelling = await report('best-selling-services');
        got.artistPerf = await report('artist-performance');
        got.sales = await report('sales');
        got.metrics = await computeMetrics(Tx, { id: A, timezone: 'Asia/Kuwait' }, parsePeriod('30d'), NOW, null);
        got.depositHealth = await computeDepositHealth(Tx, A, NOW, null);
        got.depositHealthB1 = await computeDepositHealth(Tx, A, NOW, { id: A1, name: 'OV Salmiya' });

        tx.rollback();
      });
    } catch (error) {
      if (!(error as Error)?.constructor?.name?.includes('TransactionRollback')) throw error;
    }
  });

  afterAll(async () => {
    if (db && sql) {
      await exec(sql`DELETE FROM staff_user WHERE id IN (${ST.mgrA}, ${ST.limitedA}, ${ST.noDashA}, ${ST.mgrB})`);
      await exec(sql`DELETE FROM branch WHERE id IN (${A1}, ${A2}, ${B1})`);
      await exec(sql`DELETE FROM salon WHERE id IN (${A}, ${B})`);
    }
    await app?.close();
  });

  // ============================================================ the numbers ==

  it('the fixture rolled back: none of its rows is visible outside the transaction', async () => {
    const [r] = await exec(sql`
      SELECT (SELECT count(*) FROM member WHERE salon_id IN (${A}, ${B}))::int AS members,
             (SELECT count(*) FROM "transaction" WHERE salon_id = ${A})::int AS txns,
             (SELECT count(*) FROM campaign WHERE salon_id = ${A})::int AS campaigns`);
    expect(r).toEqual({ members: 0, txns: 0, campaigns: 0 });
  });

  it('every computed answer parses as the proposed wire schema', () => {
    for (const k of ['all', 'b1', 'b2', 'limited', 'stamps']) {
      const parsed = Schema.safeParse(got[k]);
      expect(parsed.success, `${k}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  });

  it('2 · top services — by bookings and by revenue, and they are the report rolled up', () => {
    const ts = got.all.topServices;
    expect(ts.status).toBe('ok');
    // SV1: BK1 (8.000) + BK5 no-show (0). SV2: BK2 + BK4 (40.000). BK6 cancelled. SV3 unbooked.
    expect(ts.byBookings.map((r: any) => [r.name, r.bookings, r.revenueFils])).toEqual([
      ['OV Colour', 2, 40000],
      ['OV Cut', 2, 8000],
    ]);
    expect(ts.byRevenue.map((r: any) => r.name)).toEqual(['OV Colour', 'OV Cut']);
    expect(ts.branchAssumed).toBeNull();

    // best-selling-services is per (service, branch); summed per service it is this.
    const rolled = new Map<string, { bookings: number; revenue: number }>();
    for (const r of got.bestSelling.rows) {
      const x = rolled.get(r.service) ?? { bookings: 0, revenue: 0 };
      rolled.set(r.service, { bookings: x.bookings + r.bookings, revenue: x.revenue + r.revenueFils });
    }
    for (const r of ts.byBookings) {
      expect(rolled.get(r.name)).toEqual({ bookings: r.bookings, revenue: r.revenueFils });
    }
  });

  it('3 · artists — bookings, no-shows and revenue per artist, revenue reconciling with artist-performance', () => {
    const a = got.all.artists;
    expect(a.items.map((r: any) => [r.name, r.bookings, r.noShows, r.revenueFils])).toEqual([
      ['OV Rana', 2, 0, 28000],
      ['OV Dana', 2, 1, 20000],
      ['OV Idle', 0, 0, 0],
    ]);
    const earned = new Map(got.artistPerf.rows.map((r: any) => [r.attributedTo, r.earnedFils]));
    for (const r of a.items) expect(earned.get(r.name)).toBe(r.revenueFils);
  });

  it("4 · busiest times — the SALON'S weekday and hour, under a Karachi process clock", () => {
    const b = got.all.busiestTimes;
    // TX1 Wed 18h · TX2 Wed 21h (23h in PKT) · TX4 Thu 10h · TX3 Sat 23h (SUN 01h in PKT).
    // TX5 is voided and absent; TX0 is before the window.
    expect(b.cells).toEqual([
      { weekday: 3, hour: 18, visits: 1 },
      { weekday: 3, hour: 21, visits: 1 },
      { weekday: 4, hour: 10, visits: 1 },
      { weekday: 6, hour: 23, visits: 1 },
    ]);
    expect(b.totalVisits).toBe(4);
    // Hawally: TX3 (assumed) and TX4.
    expect(got.b2.busiestTimes.cells).toEqual([
      { weekday: 4, hour: 10, visits: 1 },
      { weekday: 6, hour: 23, visits: 1 },
    ]);
    expect(got.b2.busiestTimes.branchAssumed).toEqual({ assumed: 1, total: 2 });
  });

  it('5 · upcoming — today agrees with /metrics, the next 7 days, and the next five in order', () => {
    const u = got.all.upcoming;
    expect(u.today).toBe(1); // BK7, 18:00 today
    expect(u.today).toBe(got.metrics.upcomingAppointments);
    expect(u.next7Days).toBe(2); // + BK8 on Saturday; BK9 is 2031, BK10 already started
    expect(u.next.status).toBe('ok');
    expect(u.next.items.map((r: any) => [r.bookingId, r.customerName, r.serviceName, r.artistName, r.branchName])).toEqual([
      [id('BK7'), 'Walk-in Wafa', 'OV Nails', 'OV Dana', 'OV Salmiya'],
      [id('BK8'), `OV ${id('M2')}`, 'OV Cut', 'OV Rana', 'OV Hawally'],
      [id('BK9'), `OV ${id('M1')}`, 'OV Colour', 'OV Rana', 'OV Salmiya'],
    ]);
    expect(u.next.items[0].memberId).toBeNull();
    expect(got.b1.upcoming).toMatchObject({ today: 1, next7Days: 1, branchAssumed: { assumed: 0, total: 1 } });
  });

  it('6 · no-shows — 1 of 4 resolved is 2500 bp, and deposits held agree with /deposits', () => {
    const n = got.all.noShows;
    expect(n).toMatchObject({ completed: 3, noShows: 1, rateBp: 2500 });
    // BK7 (0), BK8 (2.000), BK9 (3.000), BK10 (2.000)
    expect(n.depositsHeld).toEqual({ bookings: 4, fils: 7000 });
    expect(n.depositsHeld).toEqual({
      bookings: got.depositHealth.held.bookings,
      fils: got.depositHealth.held.fils,
    });
    expect(got.b1.noShows.depositsHeld).toEqual({
      bookings: got.depositHealthB1.held.bookings,
      fils: got.depositHealthB1.held.fils,
    });
    expect(got.b1.noShows.depositsHeld).toEqual({ bookings: 3, fils: 5000 });
    // Hawally: BK4 (completed, assumed) and BK5 (no-show).
    expect(got.b2.noShows).toMatchObject({ completed: 1, noShows: 1, rateBp: 5000, branchAssumed: { assumed: 1, total: 2 } });
  });

  it("7 · new members per salon-local week, and M4 lands in Kuwait's Sunday week, not UTC's Saturday one", () => {
    const m = got.all.newMembers;
    expect(m.total).toBe(3);
    expect(m.weeks).toEqual([
      { weekStart: '2026-08-30', count: 1, partial: true }, // M2 — window starts Tue 1 Sep
      { weekStart: '2026-09-06', count: 1, partial: false }, // M3
      { weekStart: '2026-09-13', count: 1, partial: true }, // M4 — 22:30Z Sat is Sun in Kuwait
    ]);
  });

  it('7 · first-visit versus returning — the voided charge is not a visit', () => {
    expect(got.all.visitors).toMatchObject({ total: 3, firstVisit: 2, returning: 1, branchAssumed: null });
    expect(got.b1.visitors).toMatchObject({ total: 1, returning: 1, branchAssumed: { assumed: 0, total: 1 } });
    expect(got.b2.visitors).toMatchObject({ total: 2, firstVisit: 2, branchAssumed: { assumed: 1, total: 2 } });
  });

  it('8 · loyalty in the mode the salon is in — tiers at A, stamps at B', () => {
    expect(got.all.loyalty).toEqual({
      status: 'ok',
      mode: 'tiers',
      tiers: [
        { tier: 'bronze', members: 1 },
        { tier: 'silver', members: 1 },
        { tier: 'gold', members: 1 },
        { tier: 'black', members: 0 },
      ],
      untiered: 1,
    });
    expect(got.stamps.loyalty).toEqual({
      status: 'ok',
      mode: 'stamps',
      stampTarget: 6,
      buckets: [0, 1, 2, 3, 4, 5, 6].map((s) => ({ stamps: s, members: s === 0 || s === 2 || s === 6 ? 1 : 0 })),
    });
  });

  it('9 · wallet — loaded, bonus, spent (= the sales report, kept deposits included) and the balance liability', () => {
    expect(got.all.wallet).toEqual({
      status: 'ok',
      loadedFils: 18500, // 11.000 + 5.000 + 2.500; the pending Apple Pay is not loaded
      bonusFils: 1000,
      topups: 3,
      // 8+20+5+20 charges + 6+3 shop = 62.000; TX5 voided, TX0 and TS3 outside.
      // Plus 2.000 + 1.500 kept deposits; F0 outside.
      spentFils: 65500,
      liabilityFils: 17500,
    });
    // RECONCILED IN FILS against the served report: `Gross KD` (the stat, which
    // is unchanged) plus the `Kept deposits KD` column, summed over its rows.
    const kept = (got.sales.rows as Array<Record<string, number>>).reduce(
      (n, r) => n + (r.keptDepositsFils ?? NaN),
      0,
    );
    expect(got.sales.stat.value).toBe(62000);
    expect(kept).toBe(3500);
    expect(got.all.wallet.spentFils).toBe(got.sales.stat.value + kept);
  });

  it('9b · sales — kept deposits are their own column, on the day and branch they were kept', () => {
    expect((got.sales.columns as Array<{ header: string }>).map((c) => c.header)).toEqual([
      'Date',
      'Transactions',
      'Gross KD',
      'Branch',
      'Kept deposits KD',
    ]);
    const row = (date: string, branch: string) =>
      (got.sales.rows as Array<Record<string, unknown>>).find((r) => r.date === date && r.branch === branch);
    // Beside TX2's 20.000 at Salmiya on 9 Sept: the charge count and gross are untouched.
    expect(row('2026-09-09', 'OV Salmiya')).toEqual({
      date: '2026-09-09',
      transactions: 1,
      grossFils: 20000,
      branch: 'OV Salmiya',
      keptDepositsFils: 2000,
    });
    // A day with a kept deposit and no sale at that branch is a row of its own.
    expect(row('2026-09-13', 'OV Hawally')).toEqual({
      date: '2026-09-13',
      transactions: 0,
      grossFils: 0,
      branch: 'OV Hawally',
      keptDepositsFils: 1500,
    });
    // Every other row keeps no deposit.
    const others = (got.sales.rows as Array<Record<string, unknown>>).filter(
      (r) => !(r.date === '2026-09-09' && r.branch === 'OV Salmiya') && !(r.date === '2026-09-13' && r.branch === 'OV Hawally'),
    );
    expect(others.length).toBeGreaterThan(0);
    for (const r of others) expect(r.keptDepositsFils).toBe(0);
  });

  it('10 · payment mix — top-ups by method in basis points; spend is the wallet', () => {
    expect(got.all.paymentMix.topups).toEqual({
      knet: { count: 2, fils: 13500, shareBp: 7297 }, // 72.97…%
      card: { count: 1, fils: 5000, shareBp: 2703 }, // 27.027…% rounds up
      applepay: { count: 0, fils: 0, shareBp: 0 },
    });
    // Six charges and shop orders, and the two kept deposits: the wallet block's
    // `spentFils`, from the same rows.
    expect(got.all.paymentMix.walletSpend).toEqual({ count: 8, fils: 65500 });
    expect(got.all.paymentMix.walletSpend.fils).toBe(got.all.wallet.spentFils);
  });

  it('11 · shop — orders by status, top products, revenue; module off at B is an answer, not zeros', () => {
    expect(got.all.shop).toMatchObject({
      status: 'ok',
      orders: 2,
      ordersByStatus: { preparing: 1, ready: 1, closed: 0 },
      revenueFils: 9000,
      branchAssumed: null,
    });
    expect(got.all.shop.topProducts.map((p: any) => [p.name, p.units, p.revenueFils])).toEqual([
      ['OV Oil', 2, 4000],
      ['OV Serum', 2, 4000],
      ['OV Comb', 1, 1000],
    ]);
    expect(got.b1.shop).toMatchObject({ orders: 1, revenueFils: 6000, branchAssumed: { assumed: 1, total: 1 } });
    expect(got.stamps.shop).toEqual({ status: 'withheld', reason: 'module_off', permission: null });
  });

  it('12 · campaigns — sent in the window and people reached, from the send rows', () => {
    expect(got.all.campaigns).toMatchObject({ status: 'ok', sent: 1, reached: 2, reach: 10, truncated: false });
    expect(got.all.campaigns.items).toEqual([
      expect.objectContaining({ campaignId: id('C1'), reached: 2, reach: 10, result: '2 reached', sentAt: '2026-09-05T08:00:00.000Z' }),
    ]);
  });

  it('a branch withholds the five blocks that have no per-branch answer, and says why', () => {
    for (const k of ['newMembers', 'loyalty', 'wallet', 'paymentMix', 'campaigns']) {
      expect(got.b1[k], k).toEqual({ status: 'withheld', reason: 'not_per_branch', permission: null });
    }
    expect(got.b1.branchId).toBe(A1);
    expect(got.b1.branchName).toBe('OV Salmiya');
  });

  it('dashboard alone: the five section-gated blocks are withheld by name, and the rest are served', () => {
    const l = got.limited;
    expect(l.topServices).toEqual({ status: 'withheld', reason: 'permission', permission: 'appointments' });
    expect(l.artists).toEqual({ status: 'withheld', reason: 'permission', permission: 'team' });
    expect(l.upcoming.next).toEqual({ status: 'withheld', reason: 'permission', permission: 'appointments' });
    expect(l.upcoming.today).toBe(1);
    expect(l.shop).toEqual({ status: 'withheld', reason: 'permission', permission: 'shop' });
    expect(l.campaigns).toEqual({ status: 'withheld', reason: 'permission', permission: 'marketing' });
    expect(l.wallet.status).toBe('ok');
    expect(l.busiestTimes.status).toBe('ok');
  });

  // ============================================================= the route ==

  const url = (salon: string, q = `period=${WINDOW}`) => `/v1/salons/${salon}/overview/analytics?${q}`;

  it('#7 — perms.dashboard off is 403 with the canonical copy, called directly', async () => {
    const res = await call(url(A), 'noDashA');
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.message).toContain("You don't have permission");
  });

  it('another salon is 403, and another salon’s branch is 404 unknown_branch', async () => {
    const other = await call(url(A), 'mgrB');
    expect(other.status).toBe(403);
    const branch = await call(url(A, `period=${WINDOW}&branch=${B1}`), 'mgrA');
    expect(branch.status).toBe(404);
    expect(branch.body.error).toBe('unknown_branch');
  });

  it('no credential is 401', async () => {
    const res = await app.inject({ method: 'GET', url: url(A) });
    expect(res.statusCode).toBe(401);
  });

  it('a malformed period is refused', async () => {
    const res = await call(url(A, 'period=last-tuesday'), 'mgrA');
    expect(res.status).toBe(400);
  });

  it('the route serves the schema, and the module-off salon says so', async () => {
    const a = await call(url(A), 'mgrA');
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(Schema.safeParse(a.body).success, JSON.stringify(Schema.safeParse(a.body).error?.issues)).toBe(true);
    expect(a.body.window).toMatchObject({ basis: 'calendar', fromDate: '2026-09-01', toDate: '2026-09-14' });

    const b = await call(url(B), 'mgrB');
    expect(b.status).toBe(200);
    expect(b.body.shop).toEqual({ status: 'withheld', reason: 'module_off', permission: null });
    expect(b.body.loyalty).toMatchObject({ status: 'ok', mode: 'stamps', stampTarget: 6 });
  });

  it('the route decides withheld blocks from the principal, not from the query', async () => {
    const res = await call(url(A, `period=${WINDOW}&perms=all&team=true`), 'limitedA');
    expect(res.status).toBe(200);
    // All five section gates, called directly through the route with each permission off.
    const w = (permission: string) => ({ status: 'withheld', reason: 'permission', permission });
    expect(res.body.artists).toEqual(w('team'));
    expect(res.body.topServices).toEqual(w('appointments'));
    expect(res.body.upcoming.next).toEqual(w('appointments'));
    expect(res.body.shop).toEqual(w('shop'));
    expect(res.body.campaigns).toEqual(w('marketing'));
    // And a holder of all of them is served every one.
    const full = await call(url(A), 'mgrA');
    for (const k of ['artists', 'topServices', 'shop', 'campaigns']) expect(full.body[k].status, k).toBe('ok');
    expect(full.body.upcoming.next.status).toBe('ok');
  });
});
