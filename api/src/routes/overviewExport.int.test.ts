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
 *       to that JSON.
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
 * can look for. Staff, booking and artist are deleted in `afterAll`; the audit rows
 * stay (audit_log is append-only), so every audit assertion is a delta.
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

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    sql = (await import('drizzle-orm')).sql;
    render = await import('../services/overviewExport');
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
  });

  afterAll(async () => {
    if (db) {
      await db.execute(sql`DELETE FROM booking WHERE id = ${BOOKING}`);
      await db.execute(sql`DELETE FROM artist WHERE id = ${ARTIST}`);
      for (const sid of Object.values(ST)) await db.execute(sql`DELETE FROM staff_user WHERE id = ${sid}`);
    }
    await app?.close();
  });

  // ====================================================== one answer ==
  describe('the CSV is the JSON', () => {
    it('byte-for-byte the renderer over the JSON answer, for the same query', async () => {
      const q = 'period=90d';
      const json = await get(jsonUrl(q), 'noura');
      const csv = await get(csvUrl(q), 'noura');
      expect(json.statusCode, json.body).toBe(200);
      expect(csv.statusCode, csv.body).toBe(200);
      const expected = render.overviewCsv(render.overviewRows(JSON.parse(json.body), null));
      expect(csv.body).toBe(expected);
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

  // ========================================================= sections ==
  describe('section=', () => {
    it('one key exports one block', async () => {
      const res = await get(csvUrl('period=90d&section=busiestTimes'), 'noura');
      expect(res.statusCode).toBe(200);
      const rows = parseCsv(res.body).slice(1);
      expect(rows.length).toBeGreaterThan(0);
      expect(new Set(rows.map((r) => r[0]))).toEqual(new Set(['Busiest times']));
    });

    it('absent exports all twelve', async () => {
      const rows = parseCsv((await get(csvUrl('period=90d'), 'noura')).body).slice(1);
      expect(new Set(rows.map((r) => r[0])).size).toBe(12);
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
      expect(nb).toEqual(['New members', expect.any(String), 'Wallet loaded vs spent', 'Payment mix', 'Campaigns']);
      expect(nb[1]).toMatch(/^(Members by tier|Stamp progress)$/);
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
