/**
 * THE OWNER CONSOLE'S ANALYTICS — `GET /v1/platform/analytics`, its `.csv`, the
 * one-time link `POST /v1/platform/analytics/download-url` and its redemption
 * through `GET /report-downloads/:token` — against the real driver, the real
 * permission stack and the seed.
 *
 * WHAT IS PINNED
 *
 *   EVERY BLOCK, HAND-COMPUTED. A per-run fixture in March 2019 — a month no seed
 *       row and no other spec touches — so the platform-wide series for 2019 are
 *       exactly this file's rows and every expected figure is written out below.
 *       Snapshot figures (liability, deposits held, loyalty, open tickets) are
 *       asserted under `?salon=`, where they are this file's rows too.
 *   AGREEMENT WITH `/v1/platform/metrics` for the current month: salons, members,
 *       loaded, KNET share, revenue this and prior month, the eight bars and the
 *       top-five rows. Spent agrees with the merchant Overview's `wallet.spentFils`
 *       for the same salon and calendar month.
 *   `?salon=` SCOPES EVERY BLOCK; an unknown salon is 404 on all three routes.
 *   GATES. No `analytics` is 403 on all three routes (the support preset, called
 *       directly). A staff session and a member session are refused. Without
 *       `approvals` campaigns is withheld; without `policies` support is.
 *   THE EXPORT. Reconciles with the JSON byte for byte; withheld blocks and
 *       module-off blocks are rows; the link works once, re-reads the admin's
 *       sections at redemption, and every export is audited in the platform log.
 *       Migration 0071's CHECK refuses a row whose kind and principal disagree.
 *   BUSIEST TIMES ON EACH SALON'S OWN CLOCK — a 10:00 in Kuwait and a 10:00 in
 *       Dubai land in the same cell.
 *
 * FIXTURE (`PA-<run>`), all deleted in `afterAll` except the audit rows
 * (append-only, so every audit assertion is a delta):
 *
 *   SA  Asia/Kuwait, tiers, booking + shop ON, plan pro, created 2019-01-15
 *       branches: one open, one closed
 *       MA1 gold   12.000 KD   joined 2019-01-20
 *       MA2 silver  3.000 KD   joined 2019-03-05
 *       MA3 (erased) 0.500 KD  joined 2019-03-10
 *   SB  Asia/Dubai, stamps (target 6), both modules OFF, plan starter, created 2019-02-10
 *       MB1 4 stamps 7.000 KD  joined 2019-02-20
 *       MB2 0 stamps 0.000 KD  joined 2019-03-01
 *
 *   Top-ups (paid = amount - bonus - promo; settled_at decides the month):
 *       T1 SA MA1 knet    2019-03-05  amount 26.500 (bonus 1.000 + promo 0.500) fee 0.150
 *       T2 SA MA2 card    2019-03-12  10.000                                   fee 0.300
 *       T3 SB MB1 applepay 2019-03-20  8.000                                   fee 0.250
 *       T7 SA MA2 knet    settled 2019-03-01 00:30 Kuwait (Feb 28 UTC) 2.000   fee 0.150
 *       T4 SA MA1 knet    2019-02-10  5.000                                    fee 0.150
 *       T5 SA MA1 card    PENDING 2019-03-15  — never counted
 *       T6 SB MB2 knet    created 2019-03-31 23:50 Kuwait, settled 2019-04-01 00:05
 *                         — April money, but a March ACTIVE member
 *       T8 SA MA1 knet    now - 1h, 15.000, fee 0.150   (current month, for /metrics)
 *       T9 SB MB1 card    the 15th of the prior month, 20.000, fee 0.550
 *   Visits / spend:
 *       C1 SA MA1 charge 8.000  2019-03-06 10:00 Kuwait (Wed)
 *       C2 SB MB1 charge 6.000  2019-03-06 10:00 Dubai  (Wed; 09:00 on the platform clock)
 *       C3 SA MA2 charge 4.000  2019-03-13, VOIDED by V3 — no visit, no spend
 *       C4 SA MA1 charge 3.000  2019-02-14
 *       S1 SA MA2 shop   4.000  2019-03-20, order `ready`
 *       H1 SA MA1 deposit_hold 5.000 2019-03-24, held by B4
 *   Bookings: SA B1 completed 03-07, B2 no-show 03-08, B3 cancelled 03-09,
 *       B4 deposit_held 03-25 (5.000 held); SB B5 completed 03-10 (module off).
 *   Campaigns: SA K1 sent (decided +3600s; its send row only inside a rolled-back
 *       transaction, below), K2 rejected (+1800s),
 *       K3 approved and held (+86400s), K4 pending (submitted 03-28);
 *       SB K5 submitted 02-20, approved 2019-03-01 00:00 Kuwait (+741600s).
 *   Support: ST1 SA avo open (03-03); ST2 SA salon closed 03-10 (opened 03-04);
 *       ST3 SB salon closed 03-02 (opened 02-25).
 *
 * `PA-` namespace, per-run suffix.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const P = `PA-${RUN}`;
const SA = `${P}-SA`;
const SB = `${P}-SB`;
const BR = { a: `${P}-BRA`, aClosed: `${P}-BRX`, b: `${P}-BRB` };
const MEM = { a1: `${P}-MA1`, a2: `${P}-MA2`, a3: `${P}-MA3`, b1: `${P}-MB1`, b2: `${P}-MB2` };
const ADM = {
  support: `${P}-ADM-SUP`,
  approvals: `${P}-ADM-APR`,
  policies: `${P}-ADM-POL`,
  full: `${P}-ADM-FULL`,
};
const SEL = '2019-03';
const Q = `month=${SEL}&months=3`;

/** RFC 4180 as this API writes it: every field quoted, CRLF records, BOM. */
function parseCsv(body: string): string[][] {
  expect(body.charCodeAt(0), 'a UTF-8 BOM leads the file').toBe(0xfeff);
  return body
    .slice(1)
    .split('\r\n')
    .map((line) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]!.replace(/""/g, '"')));
}

/** `59.250` → 59250, by string arithmetic. */
function kdToFils(v: string): number {
  const m = /^(\d+)\.(\d{3})$/.exec(v);
  if (!m) throw new Error(`not a KD value: ${v}`);
  return Number(m[1]) * 1000 + Number(m[2]);
}

const kw = (local: string) => new Date(`${local}+03:00`);
const dxb = (local: string) => new Date(`${local}+04:00`);

suite('the owner console analytics', () => {
  let app: FastifyInstance;
  let db: (typeof import('../db/client'))['db'];
  let sql: (typeof import('drizzle-orm'))['sql'];
  let schema: (typeof import('../services/platformAnalytics.schema'))['PlatformAnalyticsSchema'];
  let render: typeof import('../services/platformAnalyticsExport');
  const bearer = {
    owner: '', analyst: '', support: '', approvals: '', policies: '', full: '', staff: '', member: '',
  };

  const exec = async (q: unknown) =>
    (await db.execute(q as never)) as unknown as Array<Record<string, unknown>>;

  const get = (url: string, who: keyof typeof bearer | null = 'owner') =>
    app.inject({
      method: 'GET',
      url,
      headers: who === null ? {} : { authorization: `Bearer ${bearer[who]}` },
    });
  const mint = (who: keyof typeof bearer, body: unknown) =>
    app.inject({
      method: 'POST',
      url: '/v1/platform/analytics/download-url',
      headers: { authorization: `Bearer ${bearer[who]}`, 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
  /** The JSON, parsed through the proposed contract every time. */
  const analytics = async (q: string, who: keyof typeof bearer = 'owner') => {
    const res = await get(`/v1/platform/analytics?${q}`, who);
    expect(res.statusCode, res.body).toBe(200);
    return schema.parse(JSON.parse(res.body));
  };
  type A = Awaited<ReturnType<typeof analytics>>;
  const ok = <T extends { status: string }>(b: T): Extract<T, { status: 'ok' }> => {
    expect(b.status, JSON.stringify(b)).toBe('ok');
    return b as Extract<T, { status: 'ok' }>;
  };
  const monthOf = <T extends { month: string }>(rows: T[], m = SEL): T => {
    const hit = rows.find((r) => r.month === m);
    expect(hit, `no ${m} row`).toBeDefined();
    return hit!;
  };

  const auditCount = async () =>
    Number(
      (
        await exec(sql`
          SELECT count(*) AS n FROM audit_log
           WHERE salon_id IS NULL AND subject_type = 'report' AND subject_id = 'platform-analytics'`)
      )[0]?.n ?? 0,
    );
  const lastAudit = async () =>
    (
      await exec(sql`
        SELECT action, detail, kind::text AS akind, source::text AS source, metadata, amount_fils,
               actor_id, actor_kind::text AS actor_kind, salon_id
          FROM audit_log
         WHERE subject_type = 'report' AND subject_id = 'platform-analytics'
         ORDER BY seq DESC LIMIT 1`)
    )[0]!;

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    sql = (await import('drizzle-orm')).sql;
    schema = (await import('../services/platformAnalytics.schema')).PlatformAnalyticsSchema;
    render = await import('../services/platformAnalyticsExport');
    const issue = (await import('../auth/sessions')).issueSession;
    app = await (await import('../app')).buildApp();

    // ---------------------------------------------------------------- salons --
    // Copied from the seed's SAL-AMARA so every NOT NULL and CHECK is satisfied,
    // with this file's overrides on top.
    const salonCopy = async (id: string, o: Record<string, unknown>) =>
      exec(sql`
        INSERT INTO salon
        SELECT * FROM jsonb_populate_record(NULL::salon,
          (SELECT to_jsonb(s) FROM salon s WHERE s.id = 'SAL-AMARA') || ${JSON.stringify({ id, ...o })}::jsonb)`);
    await salonCopy(SA, {
      name: `PA Alpha ${RUN}`, timezone: 'Asia/Kuwait', loyalty_mode: 'tiers', module_booking: true,
      module_shop: true, plan: 'pro', created_at: kw('2019-01-15T12:00:00').toISOString(),
    });
    await salonCopy(SB, {
      name: `PA Beta ${RUN}`, timezone: 'Asia/Dubai', loyalty_mode: 'stamps', stamp_target: 6, tiers: null,
      module_booking: false, module_shop: false, plan: 'starter', created_at: kw('2019-02-10T12:00:00').toISOString(),
    });
    const branchCopy = async (id: string, salonId: string, closed: boolean) =>
      exec(sql`
        INSERT INTO branch
        SELECT * FROM jsonb_populate_record(NULL::branch,
          (SELECT to_jsonb(b) FROM branch b WHERE b.id = 'BR-SAL')
            || ${JSON.stringify({ id, salon_id: salonId, name: `PA ${id}`, name_ar: null, closed_at: closed ? '2019-03-01T00:00:00Z' : null })}::jsonb)`);
    await branchCopy(BR.a, SA, false);
    await branchCopy(BR.aClosed, SA, true);
    await branchCopy(BR.b, SB, false);

    // --------------------------------------------------------------- members --
    const memberCopy = async (
      id: string,
      salonId: string,
      phone: string,
      o: { balance: number; tier: string | null; stamps: number | null; joined: Date; erased?: boolean },
    ) =>
      exec(sql`
        INSERT INTO member
        SELECT * FROM jsonb_populate_record(NULL::member,
          (SELECT to_jsonb(m) FROM member m ORDER BY m.id LIMIT 1) || ${JSON.stringify({
            id, salon_id: salonId, phone, name: `PA ${id}`, email: null, balance_fils: o.balance, tier: o.tier,
            stamps: o.stamps, visits: 0, created_at: o.joined.toISOString(), joined_at: o.joined.toISOString(),
            deletion_requested_at: o.erased ? '2019-03-11T00:00:00Z' : null,
            deletion_due_at: o.erased ? '2019-04-11T00:00:00Z' : null,
            erased_at: o.erased ? '2019-04-12T00:00:00Z' : null,
          })}::jsonb)`);
    const ph = (n: number) => `+9659${String(Date.now() % 1_000_000).padStart(6, '0')}${n}`;
    await memberCopy(MEM.a1, SA, ph(1), { balance: 12000, tier: 'gold', stamps: null, joined: kw('2019-01-20T10:00:00') });
    await memberCopy(MEM.a2, SA, ph(2), { balance: 3000, tier: 'silver', stamps: null, joined: kw('2019-03-05T10:00:00') });
    await memberCopy(MEM.a3, SA, ph(3), { balance: 500, tier: 'bronze', stamps: null, joined: kw('2019-03-10T10:00:00'), erased: true });
    await memberCopy(MEM.b1, SB, ph(4), { balance: 7000, tier: null, stamps: 4, joined: kw('2019-02-20T10:00:00') });
    await memberCopy(MEM.b2, SB, ph(5), { balance: 0, tier: null, stamps: null, joined: kw('2019-03-01T10:00:00') });

    // ---------------------------------------------------------- transactions --
    const tx = async (
      id: string,
      o: {
        member: string; salon: string; branch: string; kind: string; amount: number;
        created: Date; settled?: Date | null; status?: string; method?: string | null;
        fee?: number; bonus?: number; promo?: number; reverses?: string | null;
      },
    ) => {
      const status = o.status ?? 'settled';
      const settled = status === 'settled' ? (o.settled ?? o.created) : null;
      await exec(sql`
        INSERT INTO "transaction"
          (id, member_id, salon_id, branch_id, kind, amount_fils, status, method, fee_fils,
           bonus_fils, promo_bonus_fils, reverses_transaction_id, created_at, settled_at)
        VALUES (${`${P}-${id}`}, ${o.member}, ${o.salon}, ${o.branch}, ${o.kind}::transaction_kind,
                ${o.amount}, ${status}::transaction_status, ${o.method ?? null}::payment_method,
                ${o.fee ?? 0}, ${o.bonus ?? 0}, ${o.promo ?? 0},
                ${o.reverses ? `${P}-${o.reverses}` : null},
                ${o.created.toISOString()}::timestamptz,
                ${settled ? settled.toISOString() : null}::timestamptz)`);
    };
    const A1 = { member: MEM.a1, salon: SA, branch: BR.a };
    const A2 = { member: MEM.a2, salon: SA, branch: BR.a };
    const B1 = { member: MEM.b1, salon: SB, branch: BR.b };
    const B2 = { member: MEM.b2, salon: SB, branch: BR.b };
    await tx('T1', { ...A1, kind: 'topup', amount: 26500, bonus: 1000, promo: 500, method: 'knet', fee: 150, created: kw('2019-03-05T11:00:00') });
    await tx('T2', { ...A2, kind: 'topup', amount: 10000, method: 'card', fee: 300, created: kw('2019-03-12T11:00:00') });
    await tx('T3', { ...B1, kind: 'topup', amount: 8000, method: 'applepay', fee: 250, created: kw('2019-03-20T11:00:00') });
    await tx('T7', { ...A2, kind: 'topup', amount: 2000, method: 'knet', fee: 150, created: kw('2019-03-01T00:20:00'), settled: kw('2019-03-01T00:30:00') });
    await tx('T4', { ...A1, kind: 'topup', amount: 5000, method: 'knet', fee: 150, created: kw('2019-02-10T11:00:00') });
    await tx('T5', { ...A1, kind: 'topup', amount: 9999, method: 'card', fee: 300, status: 'pending', created: kw('2019-03-15T11:00:00') });
    await tx('T6', { ...B2, kind: 'topup', amount: 4000, method: 'knet', fee: 150, created: kw('2019-03-31T23:50:00'), settled: kw('2019-04-01T00:05:00') });
    await tx('C1', { ...A1, kind: 'charge', amount: -8000, created: kw('2019-03-06T10:00:00') });
    await tx('C2', { ...B1, kind: 'charge', amount: -6000, created: dxb('2019-03-06T10:00:00') });
    await tx('C3', { ...A2, kind: 'charge', amount: -4000, created: kw('2019-03-13T18:00:00') });
    await tx('V3', { ...A2, kind: 'adjustment', amount: 4000, created: kw('2019-03-13T18:05:00'), reverses: 'C3' });
    await tx('C4', { ...A1, kind: 'charge', amount: -3000, created: kw('2019-02-14T10:00:00') });
    await tx('S1', { ...A2, kind: 'shop', amount: -4000, created: kw('2019-03-20T15:00:00') });
    await tx('H1', { ...A1, kind: 'deposit_hold', amount: -5000, created: kw('2019-03-24T12:00:00') });
    // The current and prior month, for the /metrics agreement.
    const now = new Date();
    await tx('T8', { ...A1, kind: 'topup', amount: 15000, method: 'knet', fee: 150, created: new Date(now.getTime() - 3_600_000) });
    const curKw = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuwait', year: 'numeric', month: '2-digit' })
      .format(now)
      .slice(0, 7);
    const [cy, cm] = curKw.split('-').map(Number) as [number, number];
    const prior = cm === 1 ? `${cy - 1}-12` : `${cy}-${String(cm - 1).padStart(2, '0')}`;
    await tx('T9', { ...B1, kind: 'topup', amount: 20000, method: 'card', fee: 550, created: kw(`${prior}-15T12:00:00`) });

    await exec(sql`
      INSERT INTO shop_order (transaction_id, salon_id, member_id, fulfilment, status, ready_at, created_at)
      VALUES (${`${P}-S1`}, ${SA}, ${MEM.a2}, 'pickup', 'ready', ${kw('2019-03-20T16:00:00').toISOString()}::timestamptz,
              ${kw('2019-03-20T15:00:00').toISOString()}::timestamptz)`);

    // -------------------------------------------------------------- bookings --
    await exec(sql`INSERT INTO artist (id, salon_id, name) VALUES (${`${P}-AR`}, ${SA}, ${`PA Artist ${RUN}`}),
                                                          (${`${P}-ARB`}, ${SB}, ${`PA Artist B ${RUN}`})`);
    await exec(sql`
      INSERT INTO service
      SELECT * FROM jsonb_populate_record(NULL::service,
        (SELECT to_jsonb(s) FROM service s WHERE s.id = 'SV-01')
          || ${JSON.stringify({ id: `${P}-SV`, salon_id: SA, name: `PA Service ${RUN}`, name_ar: null })}::jsonb)`);
    await exec(sql`
      INSERT INTO service
      SELECT * FROM jsonb_populate_record(NULL::service,
        (SELECT to_jsonb(s) FROM service s WHERE s.id = 'SV-01')
          || ${JSON.stringify({ id: `${P}-SVB`, salon_id: SB, name: `PA Service B ${RUN}`, name_ar: null })}::jsonb)`);
    const booking = async (
      id: string,
      o: { salon: string; branch: string; member: string; artist: string; service: string; starts: Date; status: string; deposit?: number; hold?: string },
    ) => {
      const ends = new Date(o.starts.getTime() + 3_600_000);
      await exec(sql`
        INSERT INTO booking
          (id, salon_id, branch_id, member_id, artist_id, service_id, starts_at, ends_at, duration_min,
           deposit_fils, hold_transaction_id, status, source, no_show_return_due_at,
           completed_at, returned_at, cancelled_at)
        VALUES (${`${P}-${id}`}, ${o.salon}, ${o.branch}, ${o.member}, ${o.artist}, ${o.service},
                ${o.starts.toISOString()}::timestamptz, ${ends.toISOString()}::timestamptz, 60,
                ${o.deposit ?? 0}, ${o.hold ? `${P}-${o.hold}` : null}, ${o.status}::booking_status, 'app',
                ${ends.toISOString()}::timestamptz,
                ${o.status === 'completed' ? ends.toISOString() : null}::timestamptz,
                ${o.status === 'no_show_returned' ? ends.toISOString() : null}::timestamptz,
                ${o.status === 'cancelled' ? o.starts.toISOString() : null}::timestamptz)`);
    };
    const bA = { salon: SA, branch: BR.a, member: MEM.a1, artist: `${P}-AR`, service: `${P}-SV` };
    await booking('B1', { ...bA, starts: kw('2019-03-07T10:00:00'), status: 'completed' });
    await booking('B2', { ...bA, starts: kw('2019-03-08T10:00:00'), status: 'no_show_returned' });
    await booking('B3', { ...bA, starts: kw('2019-03-09T10:00:00'), status: 'cancelled' });
    await booking('B4', { ...bA, starts: kw('2019-03-25T10:00:00'), status: 'deposit_held', deposit: 5000, hold: 'H1' });
    await booking('B5', {
      salon: SB, branch: BR.b, member: MEM.b1, artist: `${P}-ARB`, service: `${P}-SVB`,
      starts: dxb('2019-03-10T10:00:00'), status: 'completed',
    });

    // ------------------------------------------------------------- campaigns --
    const campaign = async (
      id: string,
      salonId: string,
      o: { submitted: Date; status: string; decided?: Date; note?: string; held?: Date },
    ) =>
      exec(sql`
        INSERT INTO campaign
          (id, salon_id, title, body, channel, audience, reach, status, submitted_by, submitted_at,
           decided_by, decided_at, note, held_reason, held_at)
        VALUES (${`${P}-${id}`}, ${salonId}, ${`PA ${id}`}, 'Body', 'push', 'all', 10, ${o.status}, 'PA',
                ${o.submitted.toISOString()}::timestamptz,
                ${o.decided ? 'Yousef' : null}, ${o.decided ? o.decided.toISOString() : null}::timestamptz,
                ${o.note ?? null}, ${o.held ? 'Quiet hours' : null},
                ${o.held ? o.held.toISOString() : null}::timestamptz)`);
    await campaign('K1', SA, { submitted: kw('2019-03-02T10:00:00'), decided: kw('2019-03-02T11:00:00'), status: 'sent' });
    await campaign('K2', SA, { submitted: kw('2019-03-04T09:00:00'), decided: kw('2019-03-04T09:30:00'), status: 'rejected', note: 'No.' });
    await campaign('K3', SA, { submitted: kw('2019-03-05T10:00:00'), decided: kw('2019-03-06T10:00:00'), status: 'approved', held: kw('2019-03-06T10:00:00') });
    await campaign('K4', SA, { submitted: kw('2019-03-28T10:00:00'), status: 'pending' });
    await campaign('K5', SB, { submitted: new Date('2019-02-20T07:00:00Z'), decided: kw('2019-03-01T00:00:00'), status: 'approved' });
    // K1's `campaign_send` row is NOT written here: `avo_app` has no DELETE on that
    // table, so a committed send row could never be cleaned up and would pin K1, SA
    // and every row under it. Through the route K1 is a sent campaign with no send
    // row (every recipient capped out), which counts as NOT sent; the rolled-back
    // spec at the end writes the row and proves it then counts.

    // --------------------------------------------------------------- support --
    const [topic] = await exec(sql`SELECT id FROM support_topic ORDER BY position LIMIT 1`);
    const ticket = async (id: string, o: { salon: string; member: string; route: string; status: string; created: Date; updated: Date }) =>
      exec(sql`
        INSERT INTO support_ticket (id, member_id, salon_id, topic_id, route, message, via, status, created_at, updated_at)
        VALUES (${`${P}-${id}`}, ${o.member}, ${o.salon}, ${topic!.id as string}, ${o.route}, 'PA', 'wa', ${o.status},
                ${o.created.toISOString()}::timestamptz, ${o.updated.toISOString()}::timestamptz)`);
    await ticket('ST1', { salon: SA, member: MEM.a1, route: 'avo', status: 'open', created: kw('2019-03-03T10:00:00'), updated: kw('2019-03-03T10:00:00') });
    await ticket('ST2', { salon: SA, member: MEM.a2, route: 'salon', status: 'closed', created: kw('2019-03-04T10:00:00'), updated: kw('2019-03-10T10:00:00') });
    await ticket('ST3', { salon: SB, member: MEM.b1, route: 'salon', status: 'closed', created: kw('2019-02-25T10:00:00'), updated: kw('2019-03-02T10:00:00') });

    // ---------------------------------------------------------------- admins --
    const admin = async (id: string, role: string, perms: Partial<Record<string, boolean>>) => {
      const p = (k: string) => perms[k] ?? false;
      await exec(sql`
        INSERT INTO platform_admin
          (id, name, handle, password_hash, role, owner, perm_analytics, perm_activity, perm_salons,
           perm_accounts, perm_admins, perm_controls, perm_approvals, perm_policies, perm_audit)
        VALUES (${id}, ${`PA ${id}`}, ${id.toLowerCase()}, NULL, ${role}, false,
                ${p('analytics')}, ${p('activity')}, ${p('salons')}, ${p('accounts')}, ${p('admins')},
                ${p('controls')}, ${p('approvals')}, ${p('policies')}, ${p('audit')})`);
      return (await issue(db, { principalKind: 'platform_admin', platformAdminId: id, salonId: null, scope: 'platform' }))
        .accessToken;
    };
    // PLATFORM_ROLE_PRESETS.support, exactly.
    bearer.support = await admin(ADM.support, 'support', { activity: true, salons: true, accounts: true });
    bearer.approvals = await admin(ADM.approvals, 'admin', { analytics: true, approvals: true });
    bearer.policies = await admin(ADM.policies, 'admin', { analytics: true, policies: true });
    bearer.full = await admin(ADM.full, 'admin', { analytics: true, approvals: true, policies: true });
    const platformSession = async (id: string) =>
      (await issue(db, { principalKind: 'platform_admin', platformAdminId: id, salonId: null, scope: 'platform' })).accessToken;
    bearer.owner = await platformSession('PLT-001');
    bearer.analyst = await platformSession('PLT-002');
    bearer.staff = (await issue(db, { principalKind: 'staff', staffId: 'ST-001', salonId: 'SAL-AMARA', scope: 'dashboard' })).accessToken;
    bearer.member = (await issue(db, { principalKind: 'member', memberId: MEM.a1, salonId: SA, scope: 'wallet' })).accessToken;
  });

  afterAll(async () => {
    if (!db) return;
    const like = `${P}-%`;
    await exec(sql`
      DELETE FROM report_download
       WHERE salon_id IN (${SA}, ${SB}) OR platform_admin_id LIKE ${like}
          OR (platform_admin_id IS NOT NULL AND period LIKE '2019-03%')`);
    await exec(sql`DELETE FROM session WHERE platform_admin_id LIKE ${like} OR member_id LIKE ${like}`);
    await exec(sql`DELETE FROM platform_admin WHERE id LIKE ${like}`);
    await exec(sql`DELETE FROM campaign WHERE id LIKE ${like}`);
    await exec(sql`DELETE FROM support_ticket WHERE id LIKE ${like}`);
    await exec(sql`DELETE FROM shop_order WHERE transaction_id LIKE ${like}`);
    await exec(sql`DELETE FROM booking WHERE id LIKE ${like}`);
    await exec(sql`DELETE FROM "transaction" WHERE id LIKE ${like} AND reverses_transaction_id IS NOT NULL`);
    await exec(sql`DELETE FROM "transaction" WHERE id LIKE ${like}`);
    await exec(sql`DELETE FROM member WHERE id LIKE ${like}`);
    await exec(sql`DELETE FROM artist WHERE id LIKE ${like}`);
    await exec(sql`DELETE FROM service WHERE id LIKE ${like}`);
    await exec(sql`DELETE FROM branch WHERE id LIKE ${like}`);
    await exec(sql`DELETE FROM salon WHERE id LIKE ${like}`);
    await app?.close();
  });

  // ======================================================== every block ====
  describe('every block, hand-computed (March 2019, three months of history)', () => {
    let all: A;
    beforeAll(async () => {
      all = await analytics(Q);
    });

    it('frames the window: the selected month, the history oldest first, the platform zone', () => {
      expect(all).toMatchObject({
        timezone: 'Asia/Kuwait', month: SEL, partial: false, months: ['2019-01', '2019-02', '2019-03'],
        salonId: null, salonName: null,
      });
    });

    it('revenue: commission by month and method, this month against the prior one', () => {
      const r = ok(all.revenue);
      expect(r.months.map((m) => [m.month, m.feeFils, m.topups])).toEqual([
        ['2019-01', 0, 0],
        ['2019-02', 150, 1],
        // T1 + T7 (KNET, 150 each) + T2 (card 300) + T3 (Apple Pay 250). T5 pending, T6 settles in April.
        ['2019-03', 850, 4],
      ]);
      expect(monthOf(r.months).byMethod).toEqual({
        knet: { topups: 2, feeFils: 300 },
        card: { topups: 1, feeFils: 300 },
        applepay: { topups: 1, feeFils: 250 },
      });
      expect(r).toMatchObject({ thisMonthFils: 850, priorMonth: '2019-02', priorMonthFils: 150 });
    });

    it('money: loaded is what customers paid, bonus beside it, spent excludes the void', () => {
      const m = ok(all.money);
      expect(m.months).toEqual([
        { month: '2019-01', loadedFils: 0, bonusFils: 0, spentFils: 0 },
        { month: '2019-02', loadedFils: 5000, bonusFils: 0, spentFils: 3000 },
        // 25000 + 2000 + 10000 + 8000 paid; 1500 bonus on T1; C1 8000 + C2 6000 + S1 4000.
        { month: '2019-03', loadedFils: 45000, bonusFils: 1500, spentFils: 18000 },
      ]);
    });

    it('salons: new, active and dormant per month', () => {
      const s = ok(all.salons);
      expect(s.months).toEqual([
        { month: '2019-01', newSalons: 1, active: 0, dormant: 1 },
        { month: '2019-02', newSalons: 1, active: 1, dormant: 1 },
        { month: '2019-03', newSalons: 0, active: 2, dormant: 0 },
      ]);
    });

    it('members: new by created_at, active by any settled transaction (T6 counts in March)', () => {
      expect(ok(all.members).months).toEqual([
        { month: '2019-01', newMembers: 1, activeMembers: 0 },
        { month: '2019-02', newMembers: 1, activeMembers: 1 },
        { month: '2019-03', newMembers: 3, activeMembers: 4 },
      ]);
    });

    it('leaderboard: sorted by loaded, every column, null where a module is off', () => {
      const rows = ok(all.leaderboard).rows;
      expect(rows[0]).toEqual({
        salonId: SA, name: `PA Alpha ${RUN}`, modules: { booking: true, shop: true },
        members: 3, activeMembers: 2, loadedFils: 37000, spentFils: 12000, avoRevenueFils: 600,
        bookings: 3, noShowRateBp: 5000, shopRevenueFils: 4000, liabilityFils: 15500,
      });
      expect(rows[1]).toEqual({
        salonId: SB, name: `PA Beta ${RUN}`, modules: { booking: false, shop: false },
        members: 2, activeMembers: 2, loadedFils: 8000, spentFils: 6000, avoRevenueFils: 250,
        bookings: null, noShowRateBp: null, shopRevenueFils: null, liabilityFils: 7000,
      });
      // Every salon, zeros included: the seed's salons are here with nothing in 2019.
      const ids = rows.map((r) => r.salonId);
      expect(ids).toEqual(expect.arrayContaining(['SAL-AMARA', 'SAL-LUMIERE']));
      expect(rows.slice(2).every((r) => r.loadedFils === 0)).toBe(true);
    });

    it('paymentMix: count, paid fils and basis-point share per method', () => {
      expect(ok(all.paymentMix)).toEqual({
        status: 'ok',
        topups: 4,
        loadedFils: 45000,
        methods: {
          knet: { count: 2, fils: 27000, shareBp: 6000 },
          card: { count: 1, fils: 10000, shareBp: 2222 },
          applepay: { count: 1, fils: 8000, shareBp: 1778 },
        },
      });
    });

    it('bookings: module-on salons only — SB B5 is not counted', () => {
      const b = ok(all.bookings);
      expect(monthOf(b.months)).toEqual({ month: SEL, bookings: 3, completed: 1, noShows: 1, rateBp: 5000 });
      expect(monthOf(b.months, '2019-02')).toEqual({ month: '2019-02', bookings: 0, completed: 0, noShows: 0, rateBp: null });
    });

    it('campaigns: the lifecycle per month, and decision times as observed seconds', () => {
      const c = ok(all.campaigns);
      expect(monthOf(c.months)).toEqual({
        // `sent` is 0: K1 has no committed send row (see the fixture). The
        // rolled-back spec below gives it one.
        month: SEL, submitted: 4, approved: 3, rejected: 1, sent: 0, held: 1,
        // [1800, 3600, 86400, 741600]: the 50th is the 2nd, the 90th the 4th.
        medianDecisionSeconds: 3600, p90DecisionSeconds: 741600,
      });
      expect(monthOf(c.months, '2019-02')).toMatchObject({ submitted: 1, approved: 0, medianDecisionSeconds: null });
    });

    it('support: opened and resolved per month', () => {
      const s = ok(all.support);
      expect(s.months).toEqual([
        { month: '2019-01', opened: 0, resolved: 0 },
        { month: '2019-02', opened: 1, resolved: 0 },
        { month: SEL, opened: 2, resolved: 2 },
      ]);
    });

    it('shop: GMV and orders, module-on salons', () => {
      const s = ok(all.shop);
      expect(monthOf(s.months)).toEqual({ month: SEL, gmvFils: 4000, orders: 1 });
      expect(s.ordersByStatus).toEqual({ preparing: 0, ready: 1, closed: 0 });
    });

    it("busiest times: a 10:00 in Kuwait and a 10:00 in Dubai are both Wed 10:00", () => {
      expect(ok(all.busiestTimes)).toEqual({
        status: 'ok',
        clock: 'salon_local',
        // C1 (Kuwait 10:00) and C2 (Dubai 10:00, which is 09:00 on the platform clock). C3 is voided.
        cells: [{ weekday: 3, hour: 10, visits: 2 }],
        totalVisits: 2,
      });
    });

    it('carries no member identifier anywhere', () => {
      const body = JSON.stringify(all);
      for (const id of Object.values(MEM)) expect(body).not.toContain(id);
      expect(body).not.toMatch(/\+965\d/);
    });
  });

  // ============================================================== ?salon= ====
  describe('?salon= scopes every block', () => {
    it('to SA: every figure is SA alone, snapshots included', async () => {
      const a = await analytics(`${Q}&salon=${SA}`);
      expect(a).toMatchObject({ salonId: SA, salonName: `PA Alpha ${RUN}` });
      expect(ok(a.revenue)).toMatchObject({ thisMonthFils: 600, priorMonthFils: 150 });
      expect(monthOf(ok(a.money).months)).toEqual({ month: SEL, loadedFils: 37000, bonusFils: 1500, spentFils: 12000 });
      expect(ok(a.money)).toMatchObject({
        liabilityFils: 15500,
        liabilityBySalon: [{ salonId: SA, name: `PA Alpha ${RUN}`, liabilityFils: 15500 }],
      });
      expect(ok(a.salons)).toMatchObject({
        total: 1, byPlan: { starter: 0, growth: 0, pro: 1 }, branches: { open: 1, closed: 1 },
      });
      expect(ok(a.members)).toMatchObject({
        total: 3,
        tiers: { salons: 1, bronze: 0, silver: 1, gold: 1, black: 0, untiered: 0 },
        stamps: { salons: 0, buckets: [] },
      });
      expect(ok(a.leaderboard).rows.map((r) => r.salonId)).toEqual([SA]);
      expect(ok(a.paymentMix)).toMatchObject({ topups: 3, loadedFils: 37000 });
      expect(ok(a.bookings)).toMatchObject({ salons: 1, depositsHeld: { bookings: 1, fils: 5000 } });
      const c = ok(a.campaigns);
      expect(c.pendingNow).toBe(1);
      // K5 is SB's: two approvals, decisions [1800, 3600, 86400].
      expect(monthOf(c.months)).toMatchObject({ approved: 2, medianDecisionSeconds: 3600, p90DecisionSeconds: 86400 });
      expect(ok(a.support)).toMatchObject({ openNow: { total: 1, avo: 1, salon: 0 } });
      expect(monthOf(ok(a.support).months)).toEqual({ month: SEL, opened: 2, resolved: 1 });
      expect(ok(a.shop)).toMatchObject({ salons: 1 });
      expect(ok(a.busiestTimes).cells).toEqual([{ weekday: 3, hour: 10, visits: 1 }]);
    });

    it('to SB: stamps by target, and module_off for bookings and shop', async () => {
      const a = await analytics(`${Q}&salon=${SB}`);
      expect(ok(a.members)).toMatchObject({
        total: 2,
        tiers: { salons: 0, bronze: 0, silver: 0, gold: 0, black: 0, untiered: 0 },
        stamps: { salons: 1, buckets: [{ stampTarget: 6, stamps: 0, members: 1 }, { stampTarget: 6, stamps: 4, members: 1 }] },
      });
      expect(a.bookings).toEqual({ status: 'withheld', reason: 'module_off', permission: null });
      expect(a.shop).toEqual({ status: 'withheld', reason: 'module_off', permission: null });
      expect(ok(a.leaderboard).rows).toHaveLength(1);
      expect(ok(a.money)).toMatchObject({ liabilityFils: 7000 });
      expect(ok(a.busiestTimes).cells).toEqual([{ weekday: 3, hour: 10, visits: 1 }]);
    });

    it('an unknown salon is 404 on all three routes', async () => {
      const bogus = `${P}-NOPE`;
      for (const res of [
        await get(`/v1/platform/analytics?salon=${bogus}`),
        await get(`/v1/platform/analytics.csv?salon=${bogus}`),
        await mint('owner', { salon: bogus }),
      ]) {
        expect(res.statusCode, res.body).toBe(404);
        expect(JSON.parse(res.body).error).toBe('unknown_salon');
      }
    });

    it('bad parameters are 400 before anything is read', async () => {
      expect(JSON.parse((await get('/v1/platform/analytics?month=2019-13')).body).error).toBe('invalid_month');
      expect(JSON.parse((await get('/v1/platform/analytics?month=2999-01')).body).error).toBe('invalid_month');
      expect(JSON.parse((await get('/v1/platform/analytics?months=25')).body).error).toBe('invalid_months');
      expect(JSON.parse((await get('/v1/platform/analytics.csv?section=kpis')).body).error).toBe('invalid_section');
    });
  });

  // ================================================ agreement with /metrics ====
  describe('agreement with GET /v1/platform/metrics for the same month', () => {
    it('salons, members, loaded, KNET share, revenue, the eight bars and the top five', async () => {
      const metricsRes = await get('/v1/platform/metrics');
      expect(metricsRes.statusCode).toBe(200);
      const metrics = JSON.parse(metricsRes.body);
      const a = await analytics('months=8');
      const cur = a.month;

      expect(ok(a.salons).total).toBe(metrics.salons.total);
      expect(monthOf(ok(a.salons).months, cur).newSalons).toBe(metrics.salons.addedThisMonth);
      expect(ok(a.members).total).toBe(metrics.members.total);
      expect(monthOf(ok(a.members).months, cur).newMembers).toBe(metrics.members.addedThisMonth);

      const mix = ok(a.paymentMix);
      expect(mix.loadedFils).toBe(metrics.loaded.thisMonthFils);
      expect(monthOf(ok(a.money).months, cur).loadedFils).toBe(metrics.loaded.thisMonthFils);
      // /metrics' integer percent of value, from the same two integers.
      expect(mix.loadedFils > 0 ? Math.round((mix.methods.knet.fils * 100) / mix.loadedFils) : 0).toBe(
        metrics.loaded.knetSharePercent,
      );
      // T8 makes this month non-zero, T9 the prior one.
      expect(metrics.loaded.thisMonthFils).toBeGreaterThanOrEqual(15000);
      expect(metrics.revenue.priorMonthFils).toBeGreaterThanOrEqual(550);

      expect(ok(a.revenue).thisMonthFils).toBe(metrics.revenue.thisMonthFils);
      expect(ok(a.revenue).priorMonthFils).toBe(metrics.revenue.priorMonthFils);

      expect(ok(a.money).months.map((m) => ({ month: m.month, loadedFils: m.loadedFils }))).toEqual(metrics.loadedByMonth);

      const board = ok(a.leaderboard).rows;
      for (const top of metrics.topSalons as Array<{ salonId: string; members: number; loadedFils: number }>) {
        const row = board.find((r) => r.salonId === top.salonId);
        expect(row, top.salonId).toBeDefined();
        expect({ members: row!.members, loadedFils: row!.loadedFils }).toEqual({ members: top.members, loadedFils: top.loadedFils });
      }
      expect(board.slice(0, 5).map((r) => r.loadedFils)).toEqual(metrics.topSalons.map((t: { loadedFils: number }) => t.loadedFils));
    });

    it("spent agrees with the merchant Overview's wallet.spentFils for the same salon and calendar month", async () => {
      const a = await analytics('months=1&salon=SAL-AMARA');
      const [y, m] = a.month.split('-').map(Number) as [number, number];
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const period = `${a.month}-01_${a.month}-${String(last).padStart(2, '0')}`;
      const res = await get(`/v1/salons/SAL-AMARA/overview/analytics?period=${period}`, 'staff');
      expect(res.statusCode, res.body).toBe(200);
      const overview = JSON.parse(res.body);
      expect(overview.window.timezone).toBe('Asia/Kuwait');
      expect(ok(a.leaderboard).rows[0]!.spentFils).toBe(overview.wallet.spentFils);
      expect(monthOf(ok(a.money).months, a.month).spentFils).toBe(overview.wallet.spentFils);
    });
  });

  // ================================================================ gates ====
  describe('gates', () => {
    const routes = (who: keyof typeof bearer | null) => [
      get(`/v1/platform/analytics?${Q}`, who),
      get(`/v1/platform/analytics.csv?${Q}`, who),
      who === null
        ? app.inject({ method: 'POST', url: '/v1/platform/analytics/download-url', payload: {} })
        : mint(who, {}),
    ];

    it('no session is 401 on all three routes', async () => {
      for (const res of await Promise.all(routes(null))) expect(res.statusCode).toBe(401);
    });

    it('the support preset holds no analytics: 403 on all three routes, called directly', async () => {
      for (const res of await Promise.all(routes('support'))) {
        expect(res.statusCode, res.body).toBe(403);
        expect(JSON.parse(res.body).message).toContain('cannot open Analytics');
      }
    });

    it('a merchant staff session and a member session are refused', async () => {
      for (const who of ['staff', 'member'] as const) {
        for (const res of await Promise.all(routes(who))) {
          expect(res.statusCode, `${who}: ${res.body}`).toBe(403);
        }
      }
    });

    it('the analyst (analytics, no approvals, no policies) gets both blocks withheld', async () => {
      const a = await analytics(Q, 'analyst');
      expect(a.campaigns).toEqual({ status: 'withheld', reason: 'permission', permission: 'approvals' });
      expect(a.support).toEqual({ status: 'withheld', reason: 'permission', permission: 'policies' });
      expect(a.revenue.status).toBe('ok');
    });

    it('approvals without policies: campaigns served, support withheld', async () => {
      const a = await analytics(Q, 'approvals');
      expect(a.campaigns.status).toBe('ok');
      expect(a.support).toEqual({ status: 'withheld', reason: 'permission', permission: 'policies' });
    });

    it('policies without approvals: support served, campaigns withheld', async () => {
      const a = await analytics(Q, 'policies');
      expect(a.support.status).toBe('ok');
      expect(a.campaigns).toEqual({ status: 'withheld', reason: 'permission', permission: 'approvals' });
    });
  });

  // =============================================================== export ====
  describe('the export', () => {
    const csv = async (q: string, who: keyof typeof bearer = 'owner') => {
      const res = await get(`/v1/platform/analytics.csv?${q}`, who);
      expect(res.statusCode, res.body).toBe(200);
      return res;
    };

    it('reconciles with the JSON for the same query: byte for byte, and money to the fil', async () => {
      const json = await analytics(Q);
      const res = await csv(Q);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-disposition']).toBe('attachment; filename="platform-analytics_all-salons_2019-03_3m.csv"');
      expect(res.body).toBe(render.platformCsv(render.platformRows(json as never, null)));

      const rows = parseCsv(res.body);
      expect(rows[0]).toEqual(['section', 'item', 'metric', 'value', 'unit']);
      const cell = (section: string, item: string, metric: string) => {
        const hit = rows.filter((r) => r[0] === section && r[1] === item && r[2] === metric);
        expect(hit, `${section}/${item}/${metric}`).toHaveLength(1);
        return hit[0]![3]!;
      };
      expect(kdToFils(cell('AVO revenue', SEL, 'commission'))).toBe(850);
      expect(kdToFils(cell('Money', SEL, 'loaded (paid)'))).toBe(45000);
      expect(kdToFils(cell('Money', SEL, 'spent'))).toBe(18000);
      expect(kdToFils(cell('Salon leaderboard', `PA Alpha ${RUN}`, 'loaded (paid)'))).toBe(37000);
      expect(cell('Salon leaderboard', `PA Beta ${RUN}`, 'bookings')).toBe('module_off');
      expect(cell('Payment mix', 'Card', 'share of top-up value')).toBe('22.22');
      expect(cell('Busiest times', 'Wed 10:00', 'visits')).toBe('2');
      expect(cell('Scope', '', 'month')).toBe(SEL);
    });

    it('a section is the scope plus that section', async () => {
      const rows = parseCsv((await csv(`${Q}&section=paymentMix`)).body).slice(1);
      expect(new Set(rows.map((r) => r[0]))).toEqual(new Set(['Scope', 'Payment mix']));
    });

    it('withheld blocks are rows naming the reason — permission and module_off', async () => {
      const analyst = parseCsv((await csv(Q, 'analyst')).body);
      expect(analyst).toContainEqual(['Campaigns', '', 'withheld', 'permission: approvals', '']);
      expect(analyst).toContainEqual(['Support', '', 'withheld', 'permission: policies', '']);
      const sb = parseCsv((await csv(`${Q}&salon=${SB}`)).body);
      expect(sb).toContainEqual(['Bookings', '', 'withheld', 'module_off', '']);
      expect(sb).toContainEqual(['Shop', '', 'withheld', 'module_off', '']);
      expect(sb).toContainEqual(['Scope', '', 'salon', `PA Beta ${RUN} (${SB})`, '']);
    });

    it('every .csv export is audited in the platform log, the act and never the content', async () => {
      const before = await auditCount();
      await csv(`${Q}&salon=${SA}&section=leaderboard`);
      expect(await auditCount()).toBe(before + 1);
      const row = await lastAudit();
      expect(row).toMatchObject({
        action: 'Report exported', akind: 'access', source: 'owner_console', amount_fils: null,
        actor_id: 'PLT-001', actor_kind: 'platform_admin', salon_id: null,
      });
      expect(row.metadata).toMatchObject({
        kind: 'platform-analytics', section: 'leaderboard', salonId: SA, month: SEL, months: 3, via: 'csv',
      });
      expect(String(row.detail)).not.toMatch(/\d+\.\d{3}/);
    });

    it('the JSON is not audited', async () => {
      const before = await auditCount();
      await analytics(Q);
      expect(await auditCount()).toBe(before);
    });
  });

  // ================================================================= link ====
  describe('the one-time link', () => {
    const redeem = (url: string) => app.inject({ method: 'GET', url });
    const minted = async (who: keyof typeof bearer, body: Record<string, unknown>) => {
      const res = await mint(who, body);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const out = JSON.parse(res.body) as { url: string; expiresAt: string };
      expect(out.url).toMatch(/^\/report-downloads\/.+/);
      return out;
    };

    it('writes a console row, serves the file once, and audits the redemption', async () => {
      const { url } = await minted('owner', { month: SEL, months: 3, salon: SA, section: 'leaderboard' });
      const token = url.split('/').pop()!;
      const [row] = await exec(sql`
        SELECT staff_id, platform_admin_id, salon_id, branch_id, kind, period
          FROM report_download WHERE token_hash = encode(sha256(${token}::bytea), 'hex')`);
      expect(row).toEqual({
        staff_id: null, platform_admin_id: 'PLT-001', salon_id: SA, branch_id: null,
        kind: 'platform-analytics:leaderboard', period: '2019-03_3m',
      });

      const before = await auditCount();
      const first = await redeem(url);
      expect(first.statusCode, first.body).toBe(200);
      expect(first.headers['content-disposition']).toContain('platform-analytics_pa-alpha-');
      const direct = await get(`/v1/platform/analytics.csv?${Q}&salon=${SA}&section=leaderboard`);
      expect(first.body).toBe(direct.body);
      expect(await auditCount()).toBe(before + 2); // the redemption, then the direct .csv
      const second = await redeem(url);
      expect(second.statusCode).toBe(401);
      expect(JSON.parse(second.body).error).toBe('invalid_download');
    });

    it('the redemption audit names the admin and the link', async () => {
      const { url } = await minted('owner', { month: SEL, months: 3 });
      await redeem(url);
      const row = await lastAudit();
      expect(row).toMatchObject({ actor_id: 'PLT-001', actor_kind: 'platform_admin', salon_id: null });
      expect(row.metadata).toMatchObject({ section: null, salonId: null, month: SEL, months: 3, via: 'download-link' });
    });

    it('re-reads the admin at redemption: analytics revoked or deactivated refuses, approvals revoked withholds', async () => {
      const a = await minted('full', { month: SEL, months: 3 });
      await exec(sql`UPDATE platform_admin SET perm_analytics = false WHERE id = ${ADM.full}`);
      expect((await redeem(a.url)).statusCode).toBe(401);
      await exec(sql`UPDATE platform_admin SET perm_analytics = true WHERE id = ${ADM.full}`);

      const b = await minted('full', { month: SEL, months: 3, section: 'campaigns' });
      await exec(sql`UPDATE platform_admin SET perm_approvals = false WHERE id = ${ADM.full}`);
      const res = await redeem(b.url);
      expect(res.statusCode).toBe(200);
      expect(parseCsv(res.body)).toContainEqual(['Campaigns', '', 'withheld', 'permission: approvals', '']);
      await exec(sql`UPDATE platform_admin SET perm_approvals = true WHERE id = ${ADM.full}`);

      const c = await minted('full', { month: SEL, months: 3 });
      await exec(sql`UPDATE platform_admin SET active = false WHERE id = ${ADM.full}`);
      expect((await redeem(c.url)).statusCode).toBe(401);
      await exec(sql`UPDATE platform_admin SET active = true WHERE id = ${ADM.full}`);
    });

    it('the mint validates everything the file will need', async () => {
      expect((await mint('owner', { section: 'kpis' })).statusCode).toBe(400);
      expect((await mint('owner', { month: '2019-3' })).statusCode).toBe(400);
      expect((await mint('owner', { months: 0 })).statusCode).toBe(400);
    });

    it('a refused mint writes no row', async () => {
      const count = async () =>
        Number((await exec(sql`SELECT count(*) AS n FROM report_download WHERE kind LIKE 'platform-%'`))[0]?.n);
      const before = await count();
      expect((await mint('staff', {})).statusCode).toBe(403);
      expect((await mint('support', {})).statusCode).toBe(403);
      expect(await count()).toBe(before);
    });

    it("migration 0071's CHECK refuses a row whose kind and principal disagree", async () => {
      const insert = (staff: string | null, admin: string | null, salonId: string | null, kind: string) =>
        exec(sql`
          INSERT INTO report_download (staff_id, platform_admin_id, salon_id, kind, period, token_hash, expires_at)
          VALUES (${staff}, ${admin}, ${salonId}, ${kind}, '2019-03_3m', ${`${P}-${Math.random()}`},
                  now() + interval '1 minute')`);
      const refused = async (staff: string | null, admin: string | null, salonId: string | null, kind: string) => {
        const err = await insert(staff, admin, salonId, kind).then(
          () => null,
          (e: { message?: string; cause?: { message?: string } }) => `${e.message ?? ''} ${e.cause?.message ?? ''}`,
        );
        expect(err, `${kind} by ${staff ?? admin ?? 'nobody'} was written`).toContain('report_download_one_principal');
      };
      // A staff row carrying a console kind, a console row carrying a staff kind,
      // a row with both principals, and a row with neither.
      await refused('ST-001', null, 'SAL-AMARA', 'platform-analytics');
      await refused(null, 'PLT-001', null, 'sales');
      await refused('ST-001', 'PLT-001', 'SAL-AMARA', 'platform-analytics');
      await refused(null, null, null, 'platform-analytics');
    });
  });

  // ============================================ campaign_send, rolled back ====
  describe('a campaign counts as sent in the month of its first send row', () => {
    it('through a transaction that is rolled back, so the append-only row never commits', async () => {
      const { computePlatformAnalytics, parseMonth } = await import('../services/platformAnalytics');
      const { PLATFORM_SECTIONS } = await import('../auth/principal');
      const sections = Object.fromEntries(PLATFORM_SECTIONS.map((s) => [s, true])) as never;
      let seen: Awaited<ReturnType<typeof computePlatformAnalytics>> | null = null;
      try {
        await db.transaction(async (tx) => {
          await tx.execute(sql`
            INSERT INTO campaign_send (campaign_id, member_id, channel, sent_at)
            VALUES (${`${P}-K1`}, ${MEM.a1}, 'push', ${kw('2019-03-03T10:00:00').toISOString()}::timestamptz),
                   (${`${P}-K1`}, ${MEM.a2}, 'push', ${kw('2019-03-03T10:01:00').toISOString()}::timestamptz)`);
          seen = await computePlatformAnalytics(tx as unknown as typeof db, {
            month: parseMonth(SEL, new Date()), months: 3, salon: null, sections, now: new Date(),
          });
          tx.rollback();
        });
      } catch (error) {
        if (!(error as Error)?.constructor?.name?.includes('TransactionRollback')) throw error;
      }
      const c = ok(seen!.campaigns);
      // Two send rows, one campaign: counted once, in the month of the first.
      expect(monthOf(c.months).sent).toBe(1);
      const left = await exec(sql`SELECT count(*) AS n FROM campaign_send WHERE campaign_id = ${`${P}-K1`}`);
      expect(Number(left[0]?.n)).toBe(0);
    });
  });
});
