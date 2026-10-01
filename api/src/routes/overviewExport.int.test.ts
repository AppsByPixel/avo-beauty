/**
 * THE OVERVIEW EXPORT — `GET /v1/salons/{id}/overview/analytics.csv`, the one-time
 * link `POST …/overview/analytics/download-url`, and its redemption through
 * `GET /report-downloads/:token` — against the real driver, the real permission
 * stack and the seed.
 *
 * WHAT IS PINNED
 *
 *   ONE ANSWER. The CSV reconciles with the JSON for the same query — money to the
 *       fil, shares to the basis point — and is byte-for-byte the renderer applied
 *       to that JSON. The three widget sections reconcile with THEIR endpoints:
 *       kpis with `/metrics`, salesTrend with `reports/sales` over the chart's own
 *       fourteen days at all branches, revenueByBranch with
 *       `reports/earnings-by-branch` for the same branch and period.
 *   FIFTEEN SECTIONS IN OVERVIEW ORDER: kpis, salesTrend, revenueByBranch, then the
 *       twelve analytics blocks.
 *   THE GATES ARE THE JSON'S. `dashboard` off is 403 on all three routes (#7,
 *       called directly); `appointments` off removes the customer names; another
 *       salon is 403; a scanner PIN session is refused.
 *   NOTHING IS SILENTLY DROPPED. A withheld block is one row naming its reason —
 *       permission, not_per_branch and module_off all driven.
 *   THE LINK IS A LINK. Works once, then `invalid_download`; re-checks `dashboard`
 *       at redemption; serves the section it was minted for.
 *   EVERY EXPORT IS AUDITED — both paths, with section, branch and period.
 *
 * FIXTURE. SAL-AMARA and Noura (ST-001, every permission) from the seed; three
 * per-run staff in SAL-AMARA with one permission each switched off; one per-run
 * staff in SAL-LUMIERE (shop module off, a different tenant); one per-run artist
 * and a guest booking two days out, so `upcoming.next` carries a name this file
 * can look for. One per-run member with three settled charges inside the Gross by
 * day window (two on one day at two branches, one branch-assumed) and one KNET
 * top-up today, so the widget reconciliation runs over money that is not zero.
 * The charges and the top-up carry no ledger legs, which keeps them deletable.
 * Nothing the reconciled endpoints read depends on a leg.
 * Staff, booking, artist, transactions and member are deleted in `afterAll`. The
 * audit rows stay (audit_log is append-only), so every audit assertion is a delta.
 *
 * `OX-` namespace, per-run suffix.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const SALON = 'SAL-AMARA';
const OTHER_SALON = 'SAL-LUMIERE';
const BRANCH = 'BR-SAL';
const NOURA = 'ST-001';
const SCANNER_DEVICE = 'DEV-SCANNER-01';

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const P = `OX-${RUN}`;
const ST = {
  noDash: `${P}-ST-ND`,
  noAppt: `${P}-ST-NA`,
  limited: `${P}-ST-LI`,
  lumiere: `${P}-ST-LU`,
};
const ARTIST = `${P}-AR`;
const BOOKING = `${P}-BK`;
const MEMBER = `${P}-M`;
const TX = { a: `${P}-TXA`, b: `${P}-TXB`, c: `${P}-TXC`, topup: `${P}-TXT` };
const OTHER_BRANCH = 'BR-KWC';
const GUEST = `Zzyzx Guestname ${RUN}`;

const ALL = {
  dashboard: true, appointments: true, shop: true, loyalty: true, team: true,
  scanner: true, charges: true, void: true, marketing: true,
};
type Perms = typeof ALL;

/** RFC 4180 as this API writes it: every field quoted, CRLF records, BOM. */
function parseCsv(body: string): string[][] {
  expect(body.charCodeAt(0), 'a UTF-8 BOM leads the file').toBe(0xfeff);
  return body
    .slice(1)
    .split('\r\n')
    .map((line) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]!.replace(/""/g, '"')));
}

/** `59.250` → 59250, by string arithmetic — the reconciliation must not use a float either. */
function kdToFils(v: string): number {
  const m = /^(\d+)\.(\d{3})$/.exec(v);
  if (!m) throw new Error(`not a KD value: ${v}`);
  return Number(m[1]) * 1000 + Number(m[2]);
}
/** `72.97` → 7297. */
function pctToBp(v: string): number | null {
  if (v === '') return null;
  const m = /^(\d+)\.(\d{2})$/.exec(v);
  if (!m) throw new Error(`not a percent: ${v}`);
  return Number(m[1]) * 100 + Number(m[2]);
}

suite('the Overview export', () => {
  let app: FastifyInstance;
  let db: (typeof import('../db/client'))['db'];
  let sql: (typeof import('drizzle-orm'))['sql'];
  let render: (typeof import('../services/overviewExport'));
  let zone: (typeof import('../time/zone'));
  let tz = 'Asia/Kuwait';
  const bearer: Record<'noura' | 'pin' | keyof typeof ST, string> = {
    noura: '', pin: '', noDash: '', noAppt: '', limited: '', lumiere: '',
  };

  const exec = async (q: unknown) =>
    (await db.execute(q as never)) as unknown as Array<Record<string, unknown>>;

  const auditCount = async () =>
    Number(
      (
        await exec(sql`
          SELECT count(*) AS n FROM audit_log
           WHERE salon_id = ${SALON} AND subject_type = 'report' AND subject_id = 'overview'`)
      )[0]?.n ?? 0,
    );
  const lastAudit = async () =>
    (
      await exec(sql`
        SELECT action, detail, kind::text AS akind, metadata, amount_fils, actor_id
          FROM audit_log
         WHERE salon_id = ${SALON} AND subject_type = 'report' AND subject_id = 'overview'
         ORDER BY seq DESC LIMIT 1`)
    )[0]!;

  const get = (url: string, who: keyof typeof bearer) =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${bearer[who]}` } });
  const mint = (salonId: string, who: keyof typeof bearer, body: unknown) =>
    app.inject({
      method: 'POST',
      url: `/v1/salons/${salonId}/overview/analytics/download-url`,
      headers: { authorization: `Bearer ${bearer[who]}`, 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });

  const csvUrl = (q: string, salonId = SALON) => `/v1/salons/${salonId}/overview/analytics.csv?${q}`;
  const jsonUrl = (q: string, salonId = SALON) => `/v1/salons/${salonId}/overview/analytics?${q}`;
  const ok = async (url: string, who: keyof typeof bearer = 'noura') => {
    const res = await get(url, who);
    expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
    return JSON.parse(res.body);
  };
  /** The Gross by day card's own request: all branches, its fourteen-day range. */
  const trendUrl = () =>
    `/salons/${SALON}/reports/sales?branch=all&period=${
      (() => {
        const p = render.salesTrendPeriod(tz, new Date());
        const ymd = (d: { year: number; month: number; day: number }) =>
          `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
        return `${ymd(p.from)}_${ymd(p.to)}`;
      })()
    }`;
  /**
   * The four JSON endpoints the Overview reads, asked what the cards ask, as an
   * `OverviewExportInput`. `q` carries period and branch, as the file's query does.
   */
  const jsonParts = async (q: string, branch: string | null) => {
    const analytics = await ok(jsonUrl(q));
    const metrics = await ok(`/salons/${SALON}/metrics?${q}`);
    const sales = await ok(trendUrl());
    const earnings = await ok(`/salons/${SALON}/reports/earnings-by-branch?${q}`);
    return {
      analytics,
      kpis: {
        metrics,
        today: zone.salonWallClock(new Date(), tz).date,
        // The analytics' window is the period's window: same parser, same zone.
        window: analytics.window,
        timezone: tz,
      },
      salesTrend: { block: { status: 'ok', report: sales }, branchApplied: branch !== null, chartDefault: true },
      revenueByBranch: { status: 'ok', report: earnings },
    } as never;
  };

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    sql = (await import('drizzle-orm')).sql;
    render = await import('../services/overviewExport');
    zone = await import('../time/zone');
    const issue = (await import('../auth/sessions')).issueSession;
    app = await (await import('../app')).buildApp();

    const staff = async (sid: string, salonId: string, perms: Perms) => {
      await exec(sql`
        INSERT INTO staff_user
          (id, salon_id, name, handle, role, branch_access_all, branch_access_ids, password_hash,
           perm_dashboard, perm_appointments, perm_shop, perm_loyalty, perm_team, perm_scanner,
           perm_charges, perm_void, perm_marketing)
        VALUES (${sid}, ${salonId}, ${`OX ${sid}`}, ${sid.toLowerCase()}, 'manager', true, '{}', 'x',
                ${perms.dashboard}, ${perms.appointments}, ${perms.shop}, ${perms.loyalty},
                ${perms.team}, ${perms.scanner}, ${perms.charges}, ${perms.void}, ${perms.marketing})`);
      return (await issue(db, { principalKind: 'staff', staffId: sid, salonId, scope: 'dashboard' })).accessToken;
    };
    bearer.noDash = await staff(ST.noDash, SALON, { ...ALL, dashboard: false });
    bearer.noAppt = await staff(ST.noAppt, SALON, { ...ALL, appointments: false });
    bearer.limited = await staff(
      ST.limited,
      SALON,
      Object.fromEntries(Object.keys(ALL).map((k) => [k, k === 'dashboard'])) as Perms,
    );
    bearer.lumiere = await staff(ST.lumiere, OTHER_SALON, ALL);

    bearer.noura = (
      await issue(db, { principalKind: 'staff', staffId: NOURA, salonId: SALON, scope: 'dashboard' })
    ).accessToken;
    /** Noura's own PIN session on the till: `dashboard` held, the surface wrong. */
    bearer.pin = (
      await issue(db, {
        principalKind: 'staff', staffId: NOURA, salonId: SALON, scope: 'scanner', deviceId: SCANNER_DEVICE,
      })
    ).accessToken;

    // A guest two days out with her own artist, so no seeded booking can collide.
    const [svc] = await exec(sql`SELECT id FROM service WHERE salon_id = ${SALON} ORDER BY id LIMIT 1`);
    await exec(sql`INSERT INTO artist (id, salon_id, name) VALUES (${ARTIST}, ${SALON}, ${`OX Artist ${RUN}`})`);
    const starts = new Date(Date.now() + 2 * 86_400_000);
    starts.setUTCMinutes(0, 0, 0);
    const ends = new Date(starts.getTime() + 3_600_000);
    await exec(sql`
      INSERT INTO booking
        (id, salon_id, branch_id, branch_assumed, member_id, guest_name, artist_id, service_id,
         starts_at, ends_at, duration_min, deposit_fils, status, source, no_show_return_due_at)
      VALUES (${BOOKING}, ${SALON}, ${BRANCH}, false, NULL, ${GUEST}, ${ARTIST}, ${svc!.id as string},
              ${starts.toISOString()}::timestamptz, ${ends.toISOString()}::timestamptz, 60, 0,
              'deposit_held', 'merchant', ${ends.toISOString()}::timestamptz)`);

    // Money for the widgets: inside the Gross by day window, and today.
    tz = ((await exec(sql`SELECT timezone FROM salon WHERE id = ${SALON}`))[0]?.timezone ?? tz) as string;
    const trend = render.salesTrendPeriod(tz, new Date());
    const noonOf = (d: { year: number; month: number; day: number }) => zone.wallClockInstant(d, 12 * 60, tz);
    const yesterdayNoon = noonOf(trend.to);
    const fiveBack = zone.wallClockInstant(trend.from, 13 * 60 + 5 * 24 * 60, tz);
    await exec(sql`
      INSERT INTO member (id, salon_id, name, phone, password_hash, balance_fils, tier, visits, policy_version)
      VALUES (${MEMBER}, ${SALON}, ${`OX Member ${RUN}`}, ${`+9656${String(Date.now() % 10_000_000).padStart(7, '0')}`},
              'x', 90000, 'bronze', 0, 3)`);
    const charge = async (txId: string, branchId: string, assumed: boolean, amount: number, at: Date) =>
      exec(sql`
        INSERT INTO "transaction"
          (id, member_id, salon_id, branch_id, branch_assumed, kind, amount_fils, method, status, reference, created_at, settled_at)
        VALUES (${txId}, ${MEMBER}, ${SALON}, ${branchId}, ${assumed}, 'charge', ${amount}, 'wallet', 'settled', '',
                ${at.toISOString()}::timestamptz, ${at.toISOString()}::timestamptz)`);
    await charge(TX.a, BRANCH, false, -12_345, yesterdayNoon);
    await charge(TX.b, OTHER_BRANCH, true, -678, new Date(yesterdayNoon.getTime() + 3_600_000));
    await charge(TX.c, BRANCH, false, -1_001, fiveBack);
    const loadedAt = new Date(Date.now() - 60_000);
    await exec(sql`
      INSERT INTO "transaction"
        (id, member_id, salon_id, branch_id, branch_assumed, kind, amount_fils, method, status, reference, created_at, settled_at)
      VALUES (${TX.topup}, ${MEMBER}, ${SALON}, ${BRANCH}, true, 'topup', ${25_005}, 'knet', 'settled', '',
              ${loadedAt.toISOString()}::timestamptz, ${loadedAt.toISOString()}::timestamptz)`);
  });

  afterAll(async () => {
    if (db) {
      await db.execute(sql`DELETE FROM booking WHERE id = ${BOOKING}`);
      for (const t of Object.values(TX)) await db.execute(sql`DELETE FROM "transaction" WHERE id = ${t}`);
      await db.execute(sql`DELETE FROM member WHERE id = ${MEMBER}`);
      await db.execute(sql`DELETE FROM artist WHERE id = ${ARTIST}`);
      for (const sid of Object.values(ST)) await db.execute(sql`DELETE FROM staff_user WHERE id = ${sid}`);
    }
    await app?.close();
  });

  // ====================================================== one answer ==
  describe('the CSV is the JSON', () => {
    it('byte-for-byte the renderer over the four JSON answers, for the same query', async () => {
      const q = 'period=90d';
      const parts = await jsonParts(q, null);
      const csv = await get(csvUrl(q), 'noura');
      expect(csv.statusCode, csv.body).toBe(200);
      expect(csv.body).toBe(render.overviewCsv(render.overviewRows(parts, null)));
    });

    it('byte-for-byte with a branch applied, too', async () => {
      const q = `period=90d&branch=${BRANCH}`;
      const parts = await jsonParts(q, BRANCH);
      const csv = await get(csvUrl(q), 'noura');
      expect(csv.statusCode, csv.body).toBe(200);
      expect(csv.body).toBe(render.overviewCsv(render.overviewRows(parts, null)));
    });

    it('money reconciles to the fil and shares to the basis point', async () => {
      const q = 'period=90d';
      const a = JSON.parse((await get(jsonUrl(q), 'noura')).body);
      const rows = parseCsv((await get(csvUrl(q), 'noura')).body);
      expect(rows[0]).toEqual(['section', 'item', 'metric', 'value', 'unit']);
      const cell = (section: string, item: string, metric: string) => {
        const r = rows.find((x) => x[0] === section && x[1] === item && x[2] === metric);
        expect(r, `${section} / ${item} / ${metric}`).toBeDefined();
        return r!;
      };

      let moneyChecked = 0;
      let nonZeroMoney = 0;
      const fil = (section: string, item: string, metric: string, want: number) => {
        const r = cell(section, item, metric);
        expect(r[4]).toBe('KD');
        expect(kdToFils(r[3]!), `${section} / ${item} / ${metric}`).toBe(want);
        moneyChecked += 1;
        if (want !== 0) nonZeroMoney += 1;
      };

      expect(a.wallet.status).toBe('ok');
      fil('Wallet loaded vs spent', '', 'loaded', a.wallet.loadedFils);
      fil('Wallet loaded vs spent', '', 'bonus', a.wallet.bonusFils);
      fil('Wallet loaded vs spent', '', 'spent', a.wallet.spentFils);
      fil('Wallet loaded vs spent', '', 'outstanding balance', a.wallet.liabilityFils);

      for (const m of ['knet', 'card', 'applepay'] as const) {
        const label = { knet: 'KNET', card: 'Card', applepay: 'Apple Pay' }[m];
        fil('Payment mix', label, 'top-up value', a.paymentMix.topups[m].fils);
        expect(pctToBp(cell('Payment mix', label, 'share of top-up value')[3]!)).toBe(a.paymentMix.topups[m].shareBp);
      }
      fil('Payment mix', 'Wallet', 'spent', a.paymentMix.walletSpend.fils);

      for (const s of a.topServices.byBookings) fil('Top services', s.name, 'revenue', s.revenueFils);
      for (const r of a.artists.items) fil('Artist performance', r.name, 'revenue', r.revenueFils);
      fil('No-shows and deposits', '', 'deposits held now', a.noShows.depositsHeld.fils);
      expect(pctToBp(cell('No-shows and deposits', '', 'no-show rate')[3]!)).toBe(a.noShows.rateBp);
      if (a.shop.status === 'ok') {
        fil('Shop orders', '', 'revenue', a.shop.revenueFils);
        for (const p of a.shop.topProducts) fil('Shop orders', p.name, 'revenue', p.revenueFils);
      }
      for (const c of a.busiestTimes.cells) {
        const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][c.weekday];
        expect(cell('Busiest times', `${day} ${String(c.hour).padStart(2, '0')}:00`, 'visits')[3]).toBe(String(c.visits));
      }

      // Not a vacuous pass: the seed has real money in the window.
      expect(moneyChecked).toBeGreaterThan(8);
      expect(nonZeroMoney).toBeGreaterThan(0);
    });

    it('headers: text/csv UTF-8, attachment with the Reports-shaped name, no-store', async () => {
      const all = await get(csvUrl('period=30d'), 'noura');
      expect(all.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(all.headers['content-disposition']).toBe('attachment; filename="overview_all-branches_30d.csv"');
      expect(all.headers['cache-control']).toBe('no-store');

      const one = await get(csvUrl(`period=2026-09-01_2026-09-14&branch=${BRANCH}&section=topServices`), 'noura');
      expect(one.statusCode, one.body).toBe(200);
      const name = ((await exec(sql`SELECT name FROM branch WHERE id = ${BRANCH}`))[0]?.name ?? '') as string;
      const tag = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') || 'branch';
      expect(one.headers['content-disposition']).toBe(
        `attachment; filename="overview_${tag}_2026-09-01_2026-09-14_topServices.csv"`,
      );
    });
  });

  // ================================================ the three widgets ==
  describe('each widget section is its own endpoint’s answer', () => {
    const cellsOf = (rows: string[][], title: string) => {
      const mine = rows.filter((r) => r[0] === title);
      return (item: string, metric: string) => {
        const r = mine.find((x) => x[1] === item && x[2] === metric);
        expect(r, `${title} / ${item} / ${metric}`).toBeDefined();
        return r!;
      };
    };

    it('kpis reconcile with GET /salons/{id}/metrics for the same query — money to the fil', async () => {
      for (const q of ['period=90d', 'period=7d', 'period=2026-09-01_2026-09-14']) {
        const m = await ok(`/salons/${SALON}/metrics?${q}`);
        const cell = cellsOf(parseCsv((await get(csvUrl(`${q}&section=kpis`), 'noura')).body), 'KPIs');
        expect(cell('Active members', 'active in period')[3]).toBe(String(m.activeMembers));
        expect(cell('Active members', 'change vs same period a week earlier')[3]).toBe(String(m.activeMembersDelta));
        expect(m.loadedTodayFils, q).not.toBeNull();
        const loaded = cell('Loaded today', 'loaded today');
        expect(loaded[4]).toBe('KD');
        expect(kdToFils(loaded[3]!), q).toBe(m.loadedTodayFils);
        expect(cell('Loaded today', 'KNET share of loaded today')[3]).toBe(String(m.knetSharePercent));
        expect(cell('Repeat rate', 'repeat rate in period')[3]).toBe(String(m.repeatRatePercent));
        expect(cell('Upcoming today', 'still to start today')[3]).toBe(String(m.upcomingAppointments));
        // The today tiles name the salon-local date, not the period.
        expect(cell('', 'today (salon clock)')[3]).toBe(zone.salonWallClock(new Date(), tz).date);
      }
      // Not vacuous: today's top-up from the fixture is in the figure.
      const m = await ok(`/salons/${SALON}/metrics?period=30d`);
      expect(m.loadedTodayFils).toBeGreaterThanOrEqual(25_005);
    });

    it('with a branch applied, Loaded today is one withheld row (not_per_branch) and the caveat is counted', async () => {
      const q = `period=90d&branch=${BRANCH}`;
      const m = await ok(`/salons/${SALON}/metrics?${q}`);
      expect(m.loadedTodayFils).toBeNull();
      const rows = parseCsv((await get(csvUrl(`${q}&section=kpis`), 'noura')).body).slice(1);
      expect(rows.filter((r) => r[1] === 'Loaded today')).toEqual([['KPIs', 'Loaded today', 'withheld', 'not_per_branch', '']]);
      const cell = cellsOf(rows, 'KPIs');
      expect(cell('Active members', 'active in period')[3]).toBe(String(m.activeMembers));
      expect(cell('Repeat rate', 'visits considered')[3]).toBe(String(m.branchAssumed.visitsTotal));
      expect(cell('Repeat rate', 'visits with branch inferred')[3]).toBe(String(m.branchAssumed.visits));
      expect(cell('Upcoming today', 'appointments with branch inferred')[3]).toBe(String(m.branchAssumed.upcomingAppointments));
    });

    it('salesTrend reconciles with reports/sales over the chart’s fourteen days at all branches — to the fil', async () => {
      const sales = await ok(trendUrl());
      expect(sales.window.basis).toBe('calendar');
      expect(sales.window.days).toBe(14);
      // The branch the rest of the file is narrowed to does not narrow this chart.
      for (const q of ['period=90d', `period=7d&branch=${BRANCH}`]) {
        const rows = parseCsv((await get(csvUrl(`${q}&section=salesTrend`), 'noura')).body).slice(1);
        const cell = cellsOf(rows, 'Gross by day');
        expect(cell('', 'window')[3]).toBe(`${sales.window.fromDate} to ${sales.window.toDate} (14 complete days, salon clock)`);
        expect(cell('', 'branches')[3]).toBe('All branches');
        expect(rows.some((r) => r[2] === 'note')).toBe(q.includes('branch='));

        const want = new Map<string, { gross: number; txns: number }>();
        for (const r of sales.rows as Array<{ date: string; grossFils: number; transactions: number }>) {
          const w = want.get(r.date) ?? { gross: 0, txns: 0 };
          want.set(r.date, { gross: w.gross + r.grossFils, txns: w.txns + r.transactions });
        }
        const days = rows.filter((r) => r[2] === 'gross');
        expect(days).toHaveLength(14);
        expect(days.map((r) => r[1])).toEqual([...days.map((r) => r[1]!)].sort());
        let total = 0;
        for (const d of days) {
          const w = want.get(d[1]!) ?? { gross: 0, txns: 0 };
          expect(kdToFils(d[3]!), d[1]).toBe(w.gross);
          expect(cell(d[1]!, 'transactions')[3]).toBe(String(w.txns));
          total += kdToFils(d[3]!);
        }
        // Every fil of the report is in the file, and the report's own headline agrees.
        expect(total).toBe(sales.stat.value);
      }
      // Not vacuous: yesterday carries both fixture charges, across two branches.
      const y = parseCsv((await get(csvUrl('section=salesTrend'), 'noura')).body).slice(1);
      expect(kdToFils(y.find((r) => r[1] === sales.window.toDate && r[2] === 'gross')![3]!)).toBeGreaterThanOrEqual(13_023);
    });

    it('salesTrend with a RANGE period exports exactly that range, as the chart’s own Export mints it', async () => {
      // The chart's window as Lane C sends it, a longer range, and a range that
      // includes today. Each is valid, so none is a 400.
      const chart = trendUrl().split('period=')[1]!;
      const today = zone.salonWallClock(new Date(), tz).date;
      for (const range of [chart, '2026-09-01_2026-09-30', `${chart.split('_')[0]}_${today}`]) {
        const res = await get(csvUrl(`section=salesTrend&period=${range}`), 'noura');
        expect(res.statusCode, `${range}: ${res.body}`).toBe(200);
        expect(res.headers['content-disposition']).toBe(`attachment; filename="overview_all-branches_${range}_salesTrend.csv"`);
        const sales = await ok(`/salons/${SALON}/reports/sales?branch=all&period=${range}`);
        const rows = parseCsv(res.body).slice(1);
        const [from, to] = range.split('_');
        expect(rows.find((r) => r[2] === 'window')![3]).toBe(`${from} to ${to} (${sales.window.days} days, salon clock)`);
        const days = rows.filter((r) => r[2] === 'gross');
        expect(days).toHaveLength(sales.window.days);
        expect(days[0]![1]).toBe(from);
        expect(days[days.length - 1]![1]).toBe(to);
        const total = days.reduce((t, d) => t + kdToFils(d[3]!), 0);
        expect(total, range).toBe(sales.stat.value);

        // The link path: the mint takes the range in the body and serves the same bytes.
        const m = await mint(SALON, 'noura', { section: 'salesTrend', period: range });
        expect(m.statusCode, m.body).toBe(200);
        const link = await app.inject({ method: 'GET', url: JSON.parse(m.body).url });
        expect(link.statusCode).toBe(200);
        expect(link.body).toBe(res.body);
      }
    });

    it('salesTrend with no period, or a rolling one (the Overview’s own 30d), falls back to the chart’s fourteen days', async () => {
      const chart = trendUrl().split('period=')[1]!;
      const [from, to] = chart.split('_');
      for (const q of ['section=salesTrend', 'section=salesTrend&period=30d', 'section=salesTrend&period=7d']) {
        const res = await get(csvUrl(q), 'noura');
        expect(res.statusCode, res.body).toBe(200);
        const rows = parseCsv(res.body).slice(1);
        expect(rows.find((r) => r[2] === 'window')![3]).toBe(`${from} to ${to} (14 complete days, salon clock)`);
        expect(rows.filter((r) => r[2] === 'gross')).toHaveLength(14);
      }
    });

    it('revenueByBranch reconciles with reports/earnings-by-branch for the same branch and period — to the fil', async () => {
      for (const q of ['period=90d', 'period=90d&branch=all', `period=90d&branch=${BRANCH}`, `period=90d&branch=${OTHER_BRANCH}`, 'period=2026-09-01_2026-09-14']) {
        const e = await ok(`/salons/${SALON}/reports/earnings-by-branch?${q}`);
        const rows = parseCsv((await get(csvUrl(`${q}&section=revenueByBranch`), 'noura')).body).slice(1);
        const cell = cellsOf(rows, 'Revenue by branch');
        expect(cell('', 'branches')[3]).toBe(String(e.rows.length));
        type R = { branch: string; transactions: number; grossFils: number; assumedGrossFils: number; assumedTransactions: number };
        // The card's order: the report's order.
        expect(rows.filter((r) => r[2] === 'gross').map((r) => r[1])).toEqual((e.rows as R[]).map((r) => r.branch));
        let total = 0;
        for (const r of e.rows as R[]) {
          expect(kdToFils(cell(r.branch, 'gross')[3]!), `${q} ${r.branch}`).toBe(r.grossFils);
          expect(kdToFils(cell(r.branch, 'gross with branch assumed')[3]!)).toBe(r.assumedGrossFils);
          expect(cell(r.branch, 'transactions')[3]).toBe(String(r.transactions));
          expect(cell(r.branch, 'transactions with branch assumed')[3]).toBe(String(r.assumedTransactions));
          total += kdToFils(cell(r.branch, 'gross')[3]!);
        }
        expect(total).toBe(e.stat.value);
        const assumed = (e.rows as R[]).filter((r) => r.assumedGrossFils > 0).map((r) => r.branch);
        expect(rows.some((r) => r[2] === 'note')).toBe(assumed.length > 0);
      }
      // Not vacuous: the fixture's branch-assumed charge puts assumed money on Kuwait City.
      const e = await ok(`/salons/${SALON}/reports/earnings-by-branch?period=90d`);
      expect((e.rows as Array<{ branch: string; assumedGrossFils: number }>).some((r) => r.assumedGrossFils >= 678)).toBe(true);
    });

    it('a caller without dashboard is refused the widget sections as she is refused their endpoints', async () => {
      for (const key of ['kpis', 'salesTrend', 'revenueByBranch']) {
        expect((await get(csvUrl(`section=${key}`), 'noDash')).statusCode).toBe(403);
        expect((await mint(SALON, 'noDash', { section: key })).statusCode).toBe(403);
      }
      expect((await get(`/salons/${SALON}/metrics`, 'noDash')).statusCode).toBe(403);
      expect((await get(`/salons/${SALON}/reports/earnings-by-branch`, 'noDash')).statusCode).toBe(403);
      expect((await get(trendUrl(), 'noDash')).statusCode).toBe(403);
      // And another salon's staff cannot read this salon's widgets through the file.
      expect((await get(csvUrl('section=revenueByBranch'), 'lumiere')).statusCode).toBe(403);
      expect((await get(csvUrl('section=kpis'), 'pin')).statusCode).toBe(403);
    });

    it('dashboard alone is enough for all three — the cards need nothing more', async () => {
      const rows = parseCsv((await get(csvUrl('period=90d'), 'limited')).body).slice(1);
      for (const title of ['KPIs', 'Gross by day', 'Revenue by branch']) {
        const mine = rows.filter((r) => r[0] === title);
        expect(mine.length, title).toBeGreaterThan(0);
        expect(mine.some((r) => r[2] === 'withheld' && r[3]!.startsWith('permission')), title).toBe(false);
      }
    });
  });

  // ========================================================= sections ==
  describe('section=', () => {
    it('one key exports one block', async () => {
      const res = await get(csvUrl('period=90d&section=busiestTimes'), 'noura');
      expect(res.statusCode).toBe(200);
      const rows = parseCsv(res.body).slice(1);
      expect(rows.length).toBeGreaterThan(0);
      expect(new Set(rows.map((r) => r[0]))).toEqual(new Set(['Busiest times']));
    });

    it('absent exports all fifteen, in the Overview order: kpis, salesTrend, revenueByBranch, then the twelve', async () => {
      const rows = parseCsv((await get(csvUrl('period=90d'), 'noura')).body).slice(1);
      const order: string[] = [];
      for (const r of rows) if (order[order.length - 1] !== r[0]) order.push(r[0]!);
      // Contiguous: each section appears once, as one block.
      expect(order).toEqual([...new Set(order)]);
      expect(order).toEqual([
        'KPIs', 'Gross by day', 'Revenue by branch',
        'Top services', 'Artist performance', 'Busiest times', 'Upcoming', 'No-shows and deposits',
        'New members', 'First visit vs returning', expect.stringMatching(/^(Members by tier|Stamp progress)$/),
        'Wallet loaded vs spent', 'Payment mix', 'Shop orders', 'Campaigns',
      ]);
    });

    it('section=kpis|salesTrend|revenueByBranch each export that one widget, and mint a link that serves it', async () => {
      const titles = { kpis: 'KPIs', salesTrend: 'Gross by day', revenueByBranch: 'Revenue by branch' } as const;
      for (const [key, title] of Object.entries(titles)) {
        const res = await get(csvUrl(`period=90d&section=${key}`), 'noura');
        expect(res.statusCode, res.body).toBe(200);
        expect(res.headers['content-disposition']).toBe(`attachment; filename="overview_all-branches_90d_${key}.csv"`);
        const rows = parseCsv(res.body).slice(1);
        expect(rows.length, key).toBeGreaterThan(0);
        expect(new Set(rows.map((r) => r[0]))).toEqual(new Set([title]));

        const m = await mint(SALON, 'noura', { period: '90d', section: key });
        expect(m.statusCode, m.body).toBe(200);
        const [row] = await exec(sql`
          SELECT kind FROM report_download WHERE staff_id = ${NOURA} ORDER BY created_at DESC LIMIT 1`);
        expect(row!.kind).toBe(`overview:${key}`);
        const link = await app.inject({ method: 'GET', url: JSON.parse(m.body).url });
        expect(link.statusCode, link.body).toBe(200);
        expect(link.body).toBe(res.body);
      }
    });

    it('an unknown key is 400 invalid_section, on the file and on the mint', async () => {
      const res = await get(csvUrl('period=90d&section=revenue'), 'noura');
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('invalid_section');
      const m = await mint(SALON, 'noura', { period: '30d', section: 'revenue' });
      expect(m.statusCode).toBe(400);
      expect(JSON.parse(m.body).error).toBe('invalid_section');
    });
  });

  // ======================================================= withheld ==
  describe('a withheld block is a row with its reason', () => {
    it('permission — dashboard alone names each missing permission', async () => {
      const rows = parseCsv((await get(csvUrl('period=90d'), 'limited')).body).slice(1);
      const withheld = rows.filter((r) => r[2] === 'withheld').map((r) => [r[0], r[1], r[3]]);
      expect(withheld).toEqual([
        ['Top services', '', 'permission: appointments'],
        ['Artist performance', '', 'permission: team'],
        ['Upcoming', 'Next appointments', 'permission: appointments'],
        ['Shop orders', '', 'permission: shop'],
        ['Campaigns', '', 'permission: marketing'],
      ]);
      // And the rest is served.
      expect(rows.some((r) => r[0] === 'Wallet loaded vs spent' && r[2] === 'loaded')).toBe(true);
    });

    it('not_per_branch — a branch withholds the five salon-wide blocks', async () => {
      const rows = parseCsv((await get(csvUrl(`period=90d&branch=${BRANCH}`), 'noura')).body).slice(1);
      const nb = rows.filter((r) => r[2] === 'withheld' && r[3] === 'not_per_branch').map((r) => r[0]);
      expect(nb).toEqual(['KPIs', 'New members', expect.any(String), 'Wallet loaded vs spent', 'Payment mix', 'Campaigns']);
      expect(nb[2]).toMatch(/^(Members by tier|Stamp progress)$/);
    });

    it('module_off — emitted, not omitted', async () => {
      const res = await get(csvUrl('period=90d', OTHER_SALON), 'lumiere');
      expect(res.statusCode, res.body).toBe(200);
      const rows = parseCsv(res.body).slice(1);
      expect(rows.filter((r) => r[0] === 'Shop orders')).toEqual([['Shop orders', '', 'withheld', 'module_off', '']]);
    });
  });

  // ========================================================== gates ==
  describe('the gates are the JSON endpoint’s', () => {
    it('#7 — dashboard off is 403 on the file and on the mint, called directly', async () => {
      const csv = await get(csvUrl('period=30d'), 'noDash');
      expect(csv.statusCode).toBe(403);
      expect(JSON.parse(csv.body).message).toContain("You don't have permission to see the dashboard");
      const m = await mint(SALON, 'noDash', { period: '30d' });
      expect(m.statusCode).toBe(403);
      expect(JSON.parse(m.body).message).toContain("You don't have permission to see the dashboard");
      // No side effect: the refused mint wrote no link.
      const [n] = await exec(sql`SELECT count(*)::int AS n FROM report_download WHERE staff_id = ${ST.noDash}`);
      expect(n!.n).toBe(0);
    });

    it('appointments off: the customer names are absent, and the counts stay', async () => {
      const full = await get(csvUrl('period=30d&section=upcoming'), 'noura');
      expect(full.body).toContain(GUEST);
      const res = await get(csvUrl('period=30d&section=upcoming'), 'noAppt');
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(GUEST);
      const rows = parseCsv(res.body).slice(1);
      expect(rows.map((r) => r[2])).toEqual(['today', 'next 7 days', 'withheld']);
      // The whole file, too — not only the section.
      expect((await get(csvUrl('period=30d'), 'noAppt')).body).not.toContain(GUEST);
    });

    it("salon B cannot export salon A's file or mint its link", async () => {
      expect((await get(csvUrl('period=30d'), 'lumiere')).statusCode).toBe(403);
      expect((await mint(SALON, 'lumiere', { period: '30d' })).statusCode).toBe(403);
      // And A cannot name B's branch.
      const [lb] = await exec(sql`SELECT id FROM branch WHERE salon_id = ${OTHER_SALON} LIMIT 1`);
      if (lb) {
        const res = await get(csvUrl(`period=30d&branch=${lb.id as string}`), 'noura');
        expect(res.statusCode).toBe(404);
        expect(JSON.parse(res.body).error).toBe('unknown_branch');
      }
    });

    it('a PIN (scanner) session is refused on the file and the mint', async () => {
      const csv = await get(csvUrl('period=30d'), 'pin');
      expect(csv.statusCode).toBe(403);
      expect(JSON.parse(csv.body).message).toContain('A scanner PIN cannot reach the dashboard');
      const m = await mint(SALON, 'pin', { period: '30d' });
      expect(m.statusCode).toBe(403);
    });

    it('no credential is 401', async () => {
      expect((await app.inject({ method: 'GET', url: csvUrl('period=30d') })).statusCode).toBe(401);
      expect(
        (await app.inject({ method: 'POST', url: `/v1/salons/${SALON}/overview/analytics/download-url` })).statusCode,
      ).toBe(401);
    });
  });

  // =========================================================== link ==
  describe('the one-time link', () => {
    const spend = (url: string) => app.inject({ method: 'GET', url });

    it('works once, serves the section and filter it was minted for, then is refused', async () => {
      const m = await mint(SALON, 'noura', { period: '2026-09-01_2026-09-14', section: 'wallet' });
      expect(m.statusCode, m.body).toBe(200);
      const body = JSON.parse(m.body) as { url: string; expiresAt: string };
      expect(body.url).toMatch(/^\/report-downloads\/[A-Za-z0-9_-]+$/);
      expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());

      const first = await spend(body.url);
      expect(first.statusCode, first.body).toBe(200);
      expect(first.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(first.headers['content-disposition']).toBe(
        'attachment; filename="overview_all-branches_2026-09-01_2026-09-14_wallet.csv"',
      );
      // Same bytes as the header-authenticated file for the same query.
      const direct = await get(csvUrl('period=2026-09-01_2026-09-14&section=wallet'), 'noura');
      expect(first.body).toBe(direct.body);

      const again = await spend(body.url);
      expect(again.statusCode).toBe(401);
      expect(JSON.parse(again.body).error).toBe('invalid_download');
    });

    it('accepts the Reports-style query string when no body is sent', async () => {
      const m = await app.inject({
        method: 'POST',
        url: `/v1/salons/${SALON}/overview/analytics/download-url?period=7d&section=visitors`,
        headers: { authorization: `Bearer ${bearer.noura}` },
      });
      expect(m.statusCode, m.body).toBe(200);
      const res = await spend(JSON.parse(m.body).url);
      expect(res.headers['content-disposition']).toBe('attachment; filename="overview_all-branches_7d_visitors.csv"');
    });

    it('re-checks dashboard at redemption: revoked after the mint, refused', async () => {
      const m = await mint(SALON, 'noAppt', { period: '30d' });
      expect(m.statusCode).toBe(200);
      await exec(sql`UPDATE staff_user SET perm_dashboard = false WHERE id = ${ST.noAppt}`);
      try {
        const res = await spend(JSON.parse(m.body).url);
        expect(res.statusCode).toBe(401);
        expect(JSON.parse(res.body).error).toBe('invalid_download');
      } finally {
        await exec(sql`UPDATE staff_user SET perm_dashboard = true WHERE id = ${ST.noAppt}`);
      }
    });

    it('applies the section gates from the staff row at redemption, too', async () => {
      const m = await mint(SALON, 'noAppt', { period: '30d', section: 'upcoming' });
      const res = await spend(JSON.parse(m.body).url);
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(GUEST);
      expect(res.body).toContain('permission: appointments');
    });

    it('stores the section in report_download.kind', async () => {
      await mint(SALON, 'noura', { period: '30d', section: 'shop' });
      const [row] = await exec(sql`
        SELECT kind, period, branch_id FROM report_download
         WHERE staff_id = ${NOURA} ORDER BY created_at DESC LIMIT 1`);
      expect(row).toMatchObject({ kind: 'overview:shop', period: '30d', branch_id: null });
    });
  });

  // ========================================================== audit ==
  describe('every export is audited', () => {
    it('the .csv path writes one row with section, branch and period — and no figure', async () => {
      const before = await auditCount();
      const res = await get(csvUrl(`period=30d&branch=${BRANCH}&section=noShows`), 'noura');
      expect(res.statusCode).toBe(200);
      expect(await auditCount()).toBe(before + 1);
      const row = await lastAudit();
      expect(row).toMatchObject({ action: 'Report exported', akind: 'access', actor_id: NOURA, amount_fils: null });
      expect(row.metadata).toMatchObject({
        kind: 'overview', section: 'noShows', branchId: BRANCH, period: '30d', periodBasis: 'rolling', via: 'csv',
      });
      expect((row.metadata as { rowCount: number }).rowCount).toBe(parseCsv(res.body).length - 1);
    });

    it('a whole-file export records section null', async () => {
      await get(csvUrl('period=7d'), 'noura');
      expect((await lastAudit()).metadata).toMatchObject({ section: null, branchId: null, period: '7d' });
    });

    it('the link path writes one row, via download-link, naming the redeemer', async () => {
      const m = await mint(SALON, 'noura', { period: '90d', section: 'upcoming' });
      const before = await auditCount();
      const res = await app.inject({ method: 'GET', url: JSON.parse(m.body).url });
      expect(res.statusCode).toBe(200);
      expect(await auditCount()).toBe(before + 1);
      const row = await lastAudit();
      expect(row.actor_id).toBe(NOURA);
      expect(row.metadata).toMatchObject({ section: 'upcoming', period: '90d', via: 'download-link' });
      // The names left in the file, not in the audit row.
      expect(res.body).toContain(GUEST);
      expect(JSON.stringify(row)).not.toContain(GUEST);
    });

    it('a refused export writes nothing', async () => {
      const before = await auditCount();
      await get(csvUrl('period=30d'), 'noDash');
      await get(csvUrl('period=30d&section=bogus'), 'noura');
      expect(await auditCount()).toBe(before);
    });

    it('the JSON card render is not an export and writes nothing', async () => {
      const before = await auditCount();
      await get(jsonUrl('period=30d'), 'noura');
      expect(await auditCount()).toBe(before);
    });
  });
});
