/**
 * THE SALON'S OWN BOOKING POLICY, END TO END against a real database
 * (migration 0066, DECISIONS.md § the fourth list).
 *
 * A SALON OF ITS OWN, PER RUN. A published policy stamps every later booking at
 * its salon, and `booking_policy` is append-only for `avo_app` — the role this
 * suite runs as — so a policy published on SAL-AMARA could never be taken back
 * and would change how every other int file's and e2e's bookings cancel. So
 * `BP-S-<run>` (the salon under test) and `BP-T-<run>` (the tenancy neighbour)
 * are created here and left inert afterwards, like `chargeLoyaltyRecord`'s.
 *
 * THE DEPOSIT IS 5.005 KD, on purpose: at 50% the exact share is 2502.5, so a
 * half-up or float rounding returns 2503 and the ruling's floor returns 2502. The
 * one-fil difference is what the rounding specs can see.
 *
 * MONEY IS POSTED THROUGH THE LEDGER. Every member's opening balance is a
 * balanced `adjustment` pair and every fixture hold is a balanced `deposit_hold`
 * pair, so § ledger reconciliation can assert `balance = Σ member_wallet` for
 * every member of the salon rather than for the rows it happens to remember.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const SALON = `BP-S-${RUN}`;
const OTHER = `BP-T-${RUN}`;
const BRANCH = `${SALON}-BR`;
const OTHER_BRANCH = `${OTHER}-BR`;
const MANAGER = `${SALON}-MGR`;
/** Dashboard, appointments, charges and void — but NOT loyalty. */
const NO_LOYALTY = `${SALON}-NOL`;
const OTHER_MANAGER = `${OTHER}-MGR`;
const ARTIST = `${SALON}-AR`;
const SVC = `${SALON}-SV`;
const DEPOSIT = 5_005;

type Json = Record<string, any>;

const RULES = [
  { hoursBefore: 48, returnPercent: 100 },
  { hoursBefore: 24, returnPercent: 50 },
];
const TEXT = { en: 'Free until 48 hours before. Half back until 24 hours before.', ar: '' };

suite('the salon writes its own booking policy (0066)', () => {
  let app: FastifyInstance;
  let db: (typeof import('../db/client'))['db'];
  let sql: (typeof import('drizzle-orm'))['sql'];
  let issue: (typeof import('../auth/sessions'))['issueSession'];
  let runNoShowReturnsOnce: (typeof import('../services/noShowWorker'))['runNoShowReturnsOnce'];

  const bearer: Record<string, string> = {};
  const memberBearer: Record<string, string> = {};

  const exec = async (q: unknown) =>
    (await db.execute(q as never)) as unknown as Array<Record<string, unknown>>;
  const num = async (q: unknown): Promise<number> => Number((await exec(q))[0]?.n ?? NaN);

  // ------------------------------------------------------------ fixtures --

  async function salonRow(id: string, branchId: string, managerId: string) {
    const hours = JSON.stringify({ morning: ['09:00', '13:00'], evening: ['13:00', '22:00'] });
    await exec(sql`
      INSERT INTO salon (id, name, brand_color, loyalty_mode, tiers, deposit_fils, business_hours,
                         module_booking, module_shop, timezone)
      VALUES (${id}, ${`BP ${id}`}, '#7A5C8E', 'tiers',
              (SELECT tiers FROM salon WHERE id = 'SAL-AMARA'), ${DEPOSIT}, ${hours}::jsonb,
              true, false, 'Asia/Kuwait')`);
    await exec(sql`INSERT INTO branch (id, salon_id, name) VALUES (${branchId}, ${id}, 'BP Branch')`);
    await exec(sql`
      INSERT INTO staff_user
        (id, salon_id, name, handle, role, branch_access_all, branch_access_ids, password_hash,
         perm_dashboard, perm_appointments, perm_shop, perm_loyalty, perm_team, perm_scanner,
         perm_charges, perm_void, perm_marketing)
      VALUES (${managerId}, ${id}, 'BP Manager', ${`bp-${RUN}-${id.slice(3, 4).toLowerCase()}-mgr`},
              'manager', true, '{}', 'x', true, true, true, true, true, true, true, true, true)`);
  }

  /** A customer whose opening balance is a balanced ledger pair. */
  async function customer(salonId = SALON, balance = 100_000): Promise<string> {
    const id = `BP-M-${randomUUID().slice(0, 12)}`;
    const open = `BP-TX-OPEN-${id.slice(5)}`;
    await exec(sql`
      INSERT INTO member (id, salon_id, name, phone, password_hash, balance_fils, tier, visits, policy_version)
      VALUES (${id}, ${salonId}, 'BP Customer',
              ${`+9657${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`},
              'x', ${balance}, 'bronze', 0, 1)`);
    await exec(sql`
      INSERT INTO "transaction"
        (id, member_id, salon_id, branch_id, kind, amount_fils, status, reference, note, created_at, settled_at)
      VALUES (${open}, ${id}, ${salonId}, ${salonId === SALON ? BRANCH : OTHER_BRANCH}, 'adjustment',
              ${balance}, 'settled', ${`AVO-OPEN-${id}`}, 'Opening fixture balance', now(), now())`);
    await exec(sql`
      INSERT INTO ledger_entry (transaction_id, salon_id, member_id, account, direction, amount_fils, balance_after_fils)
      VALUES (${open}, ${salonId}, ${id}, 'member_wallet', 'credit', ${balance}, ${balance}),
             (${open}, ${salonId}, NULL, 'gateway_clearing', 'debit', ${balance}, NULL)`);
    memberBearer[id] = (
      await issue(db, { principalKind: 'member', memberId: id, salonId, scope: 'wallet' })
    ).accessToken;
    return id;
  }

  /**
   * A held booking, written directly, so a spec can place `starts_at` exactly
   * where a threshold is. Its own artist, so the per-artist EXCLUDE constraint
   * never ties two fixtures together. `policyId` null writes a LEGACY booking —
   * exactly the row the pre-0066 API wrote, stamp and split columns all NULL.
   */
  async function heldBooking(
    memberId: string,
    opts: { startsInMinutes: number; durationMin?: number; policyId: string | null },
  ): Promise<string> {
    const bk = `BP-BK-${randomUUID().slice(0, 12)}`;
    const hold = `BP-TX-H-${randomUUID().slice(0, 12)}`;
    const artist = `BP-AR-${randomUUID().slice(0, 12)}`;
    const dur = opts.durationMin ?? 60;
    const start = `${opts.startsInMinutes} minutes`;
    await exec(sql`
      INSERT INTO artist (id, salon_id, branch_id, name, slot_minutes, windows, active)
      VALUES (${artist}, ${SALON}, ${BRANCH}, 'BP Fixture Artist', 60, '{}'::jsonb, true)`);
    await exec(sql`
      INSERT INTO "transaction"
        (id, member_id, salon_id, branch_id, kind, amount_fils, method, status, reference, created_at, settled_at)
      VALUES (${hold}, ${memberId}, ${SALON}, ${BRANCH}, 'deposit_hold', ${-DEPOSIT}, 'wallet', 'settled',
              ${`AVO-DEP-${hold}`}, now(), now())`);
    await exec(sql`UPDATE member SET balance_fils = balance_fils - ${DEPOSIT} WHERE id = ${memberId}`);
    await exec(sql`
      INSERT INTO ledger_entry (transaction_id, salon_id, member_id, account, direction, amount_fils, balance_after_fils)
      VALUES (${hold}, ${SALON}, ${memberId}, 'member_wallet', 'debit', ${DEPOSIT},
              (SELECT balance_fils FROM member WHERE id = ${memberId})),
             (${hold}, ${SALON}, NULL, 'deposit_held', 'credit', ${DEPOSIT}, NULL)`);

    if (opts.policyId === null) {
      await exec(sql`
        INSERT INTO booking
          (id, salon_id, branch_id, member_id, artist_id, service_id, starts_at, ends_at, duration_min,
           deposit_fils, status, hold_transaction_id, no_show_return_due_at)
        VALUES (${bk}, ${SALON}, ${BRANCH}, ${memberId}, ${artist}, ${SVC},
                now() + ${start}::interval, now() + ${start}::interval + ${`${dur} minutes`}::interval, ${dur},
                ${DEPOSIT}, 'deposit_held', ${hold},
                now() + ${start}::interval + ${`${dur} minutes`}::interval + interval '60 minutes')`);
    } else {
      await exec(sql`
        INSERT INTO booking
          (id, salon_id, branch_id, member_id, artist_id, service_id, starts_at, ends_at, duration_min,
           deposit_fils, status, hold_transaction_id, no_show_return_due_at,
           policy_id, policy_version, policy_no_show, policy_cancellation_rules, policy_text_en, policy_text_ar)
        SELECT ${bk}, ${SALON}, ${BRANCH}, ${memberId}, ${artist}, ${SVC},
               now() + ${start}::interval, now() + ${start}::interval + ${`${dur} minutes`}::interval, ${dur},
               ${DEPOSIT}, 'deposit_held', ${hold},
               now() + ${start}::interval + ${`${dur} minutes`}::interval,
               p.id, p.version, p.no_show_rule, p.cancellation_rules, p.text_en, p.text_ar
          FROM booking_policy p WHERE p.id = ${opts.policyId}`);
    }
    return bk;
  }

  const put = (body: unknown, as = bearer[MANAGER]!, salonId = SALON) =>
    app.inject({
      method: 'PUT',
      url: `/salons/${salonId}/booking-policy`,
      headers: { authorization: `Bearer ${as}` },
      payload: body as never,
    });
  const get = (url: string, as: string) =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${as}` } });

  /** Publish and return the new version's row id. */
  async function publish(body: Json): Promise<Json> {
    const res = await put(body);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as Json;
  }

  const cancel = (bk: string, memberId: string, key: string | null = `bp-c-${randomUUID()}`) =>
    app.inject({
      method: 'DELETE',
      url: `/bookings/${bk}`,
      headers: {
        authorization: `Bearer ${memberBearer[memberId]}`,
        ...(key === null ? {} : { 'idempotency-key': key }),
      },
    });

  const mark = (bk: string, key = `bp-ns-${randomUUID()}`) =>
    app.inject({
      method: 'POST',
      url: `/salons/${SALON}/bookings/${bk}/no-show`,
      headers: { authorization: `Bearer ${bearer[MANAGER]}`, 'idempotency-key': key },
    });

  const balanceOf = (m: string) => num(sql`SELECT balance_fils AS n FROM member WHERE id = ${m}`);

  /** Every transaction this booking produced, by kind. */
  const settlementTxs = (bk: string) =>
    exec(sql`
      SELECT t.id, t.kind::text AS kind, t.amount_fils::int AS amount
        FROM "transaction" t
        JOIN booking b ON t.id IN (b.settled_transaction_id, b.forfeit_transaction_id)
       WHERE b.id = ${bk}
       ORDER BY t.kind::text`);

  /** `account:direction:amount` for every leg of every settlement transaction. */
  const settlementLegs = async (bk: string) =>
    (
      await exec(sql`
        SELECT l.account::text AS account, l.direction::text AS direction, l.amount_fils::int AS amount
          FROM ledger_entry l
          JOIN booking b ON l.transaction_id IN (b.settled_transaction_id, b.forfeit_transaction_id)
         WHERE b.id = ${bk}
         ORDER BY l.account::text, l.direction::text`)
    ).map((l) => `${l.account}:${l.direction}:${l.amount}`);

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    sql = (await import('drizzle-orm')).sql;
    issue = (await import('../auth/sessions')).issueSession;
    runNoShowReturnsOnce = (await import('../services/noShowWorker')).runNoShowReturnsOnce;
    app = await (await import('../app')).buildApp();

    await salonRow(SALON, BRANCH, MANAGER);
    await salonRow(OTHER, OTHER_BRANCH, OTHER_MANAGER);
    await exec(sql`
      INSERT INTO staff_user
        (id, salon_id, name, handle, role, branch_access_all, branch_access_ids, password_hash,
         perm_dashboard, perm_appointments, perm_shop, perm_loyalty, perm_team, perm_scanner,
         perm_charges, perm_void, perm_marketing)
      VALUES (${NO_LOYALTY}, ${SALON}, 'BP No Loyalty', ${`bp-${RUN}-nol`},
              'manager', true, '{}', 'x', true, true, true, false, true, true, true, true, true)`);

    const week = JSON.stringify(
      Object.fromEntries(['0', '1', '2', '3', '4', '5', '6'].map((d) => [d, { open: true, from: '10:00', to: '20:00' }])),
    );
    await exec(sql`
      INSERT INTO artist (id, salon_id, branch_id, name, slot_minutes, windows, active)
      VALUES (${ARTIST}, ${SALON}, ${BRANCH}, 'BP Artist', 60, ${week}::jsonb, true)`);
    await exec(sql`
      INSERT INTO service (id, salon_id, name, price_fils, active)
      VALUES (${SVC}, ${SALON}, ${`BP Service ${RUN}`}, 9000, true)`);
    await exec(sql`
      INSERT INTO artist_service (artist_id, service_id, salon_id) VALUES (${ARTIST}, ${SVC}, ${SALON})`);

    for (const [id, salonId] of [
      [MANAGER, SALON],
      [NO_LOYALTY, SALON],
      [OTHER_MANAGER, OTHER],
    ] as const) {
      bearer[id] = (
        await issue(db, { principalKind: 'staff', staffId: id, salonId, scope: 'dashboard' })
      ).accessToken;
    }
  });

  afterAll(async () => {
    if (db && sql) {
      // Sessions go; salons, bookings, members and their money stay (append-only
      // ledger, append-only policy versions, restrict FKs). Inert and per-run.
      await exec(sql`DELETE FROM session WHERE salon_id IN (${SALON}, ${OTHER})`);
    }
    await app?.close();
  });

  // ================================================================ #7 ==

  describe('permissions and tenancy, called directly', () => {
    it('PUT with perms.loyalty OFF is 403, and no version is written', async () => {
      const res = await put({ noShow: 'keep', cancellation: RULES, text: TEXT }, bearer[NO_LOYALTY]);
      expect(res.statusCode, res.body).toBe(403);
      expect(await num(sql`SELECT count(*)::int AS n FROM booking_policy WHERE salon_id = ${SALON}`)).toBe(0);
    });

    it('the gate fires before the body is read — a refused caller sending junk still gets 403', async () => {
      const res = await put({ noShow: 'nonsense' }, bearer[NO_LOYALTY]);
      expect(res.statusCode, res.body).toBe(403);
    });

    it('GET is readable without loyalty — it is shown to every customer — and says null before any publish', async () => {
      const res = await get(`/salons/${SALON}/booking-policy`, bearer[NO_LOYALTY]!);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ policy: null });
    });

    it("salon B cannot read or write salon A's policy", async () => {
      const r = await get(`/salons/${SALON}/booking-policy`, bearer[OTHER_MANAGER]!);
      expect(r.statusCode, r.body).toBe(403);
      const w = await put({ noShow: 'keep', cancellation: RULES, text: TEXT }, bearer[OTHER_MANAGER], SALON);
      expect(w.statusCode, w.body).toBe(403);
      expect(await num(sql`SELECT count(*)::int AS n FROM booking_policy WHERE salon_id = ${SALON}`)).toBe(0);

      // And a customer of B cannot read A's either.
      const b = await customer(OTHER);
      const m = await get(`/salons/${SALON}/booking-policy`, memberBearer[b]!);
      expect(m.statusCode, m.body).toBe(403);
    });
  });

  // ======================================================== validation ==

  describe('validation refusals — 400 with a code each, and nothing written', () => {
    const cases: Array<[string, Json, string]> = [
      ['four rules', { cancellation: [4, 3, 2, 1].map((h) => ({ hoursBefore: h, returnPercent: 0 })) }, 'too_many_cancellation_rules'],
      ['hours ascending', { cancellation: [{ hoursBefore: 24, returnPercent: 50 }, { hoursBefore: 48, returnPercent: 50 }] }, 'hours_before_not_descending'],
      ['hours zero', { cancellation: [{ hoursBefore: 0, returnPercent: 50 }] }, 'invalid_hours_before'],
      ['hours fractional', { cancellation: [{ hoursBefore: 1.5, returnPercent: 50 }] }, 'invalid_hours_before'],
      ['percent 101', { cancellation: [{ hoursBefore: 24, returnPercent: 101 }] }, 'invalid_return_percent'],
      ['percent fractional', { cancellation: [{ hoursBefore: 24, returnPercent: 33.3 }] }, 'invalid_return_percent'],
      ['percent increasing', { cancellation: [{ hoursBefore: 48, returnPercent: 50 }, { hoursBefore: 24, returnPercent: 75 }] }, 'return_percent_increasing'],
      ['text too long', { text: { en: 'a'.repeat(1001), ar: '' } }, 'policy_text_too_long'],
      ['english missing', { text: { en: '', ar: 'x' } }, 'invalid_policy_text'],
      ['no-show rule unknown', { noShow: 'refund' }, 'invalid_no_show_rule'],
      ['an unknown field', { noShowWindowMinutes: 60 }, 'invalid_policy'],
    ];
    for (const [name, patch, want] of cases) {
      it(`${name} → ${want}`, async () => {
        const res = await put({ noShow: 'keep', cancellation: RULES, text: TEXT, ...patch });
        expect(res.statusCode, res.body).toBe(400);
        expect((res.json() as Json).error).toBe(want);
      });
    }
    it('and none of them wrote a version', async () => {
      expect(await num(sql`SELECT count(*)::int AS n FROM booking_policy WHERE salon_id = ${SALON}`)).toBe(0);
    });
  });

  // ============================================================ publish ==

  describe('publishing bumps the version and writes the bell once a day', () => {
    let members: string[] = [];

    it('v1: one notice per member of the salon, none to another salon', async () => {
      members = [await customer(), await customer(), await customer()];
      const erased = await customer();
      await exec(sql`
        UPDATE member SET deletion_requested_at = now() - interval '31 days',
                          deletion_due_at = now() - interval '1 day', erased_at = now()
         WHERE id = ${erased}`);
      const bystander = await customer(OTHER);

      const out = await publish({ noShow: 'keep', cancellation: RULES, text: TEXT });
      expect(out.published).toBe(true);
      expect(out.policy.version).toBe(1);

      const live = await num(sql`
        SELECT count(*)::int AS n FROM member WHERE salon_id = ${SALON} AND erased_at IS NULL`);
      expect(out.noticesWritten).toBe(live);
      expect(
        await num(sql`SELECT count(*)::int AS n FROM member_policy_notice WHERE policy_id = ${out.policy.id}`),
      ).toBe(live);
      // Exactly one per member, and none for the erased one or the other salon's.
      const perMember = await exec(sql`
        SELECT member_id, count(*)::int AS n FROM member_policy_notice
         WHERE salon_id = ${SALON} GROUP BY member_id`);
      expect(perMember.every((r) => r.n === 1)).toBe(true);
      expect(await num(sql`SELECT count(*)::int AS n FROM member_policy_notice WHERE member_id = ${erased}`)).toBe(0);
      expect(await num(sql`SELECT count(*)::int AS n FROM member_policy_notice WHERE member_id = ${bystander}`)).toBe(0);

      // It is in her bell, unread, and reads back as its own kind.
      const feed = await get('/members/me/notifications/feed', memberBearer[members[0]!]!);
      expect(feed.statusCode, feed.body).toBe(200);
      const items = (feed.json() as Json).items as Json[];
      const policyItems = items.filter((i) => i.kind === 'booking_policy');
      expect(policyItems).toHaveLength(1);
      expect(policyItems[0]).toMatchObject({ salonId: SALON, policyVersion: 1, readAt: null });
      expect((feed.json() as Json).unreadCount).toBeGreaterThanOrEqual(1);
      expect((feed.json() as Json).visibleKinds).toContain('booking_policy');
    });

    it('a second publish the same salon-day is v2 and writes NO notice', async () => {
      const out = await publish({ noShow: 'keep', cancellation: RULES, text: { en: TEXT.en, ar: 'نص' } });
      expect(out.published).toBe(true);
      expect(out.policy.version).toBe(2);
      expect(out.noticesWritten).toBe(0);
      for (const m of members) {
        expect(await num(sql`SELECT count(*)::int AS n FROM member_policy_notice WHERE member_id = ${m}`)).toBe(1);
      }
    });

    it('an identical body publishes nothing — no v3, no notice', async () => {
      const out = await publish({ noShow: 'keep', cancellation: RULES, text: { en: TEXT.en, ar: 'نص' } });
      expect(out.published).toBe(false);
      expect(out.policy.version).toBe(2);
      expect(await num(sql`SELECT max(version)::int AS n FROM booking_policy WHERE salon_id = ${SALON}`)).toBe(2);
    });

    it('marking it read works like any bell item, and only for her', async () => {
      const [a, b] = members;
      const noticeId = String(
        (await exec(sql`SELECT id FROM member_policy_notice WHERE member_id = ${a}`))[0]?.id,
      );
      // B cannot mark A's notice.
      const theirs = await app.inject({
        method: 'POST',
        url: '/members/me/notifications/read',
        headers: { authorization: `Bearer ${memberBearer[b!]}` },
        payload: { ids: [noticeId] },
      });
      expect(theirs.statusCode, theirs.body).toBe(200);
      expect(await num(sql`SELECT count(*)::int AS n FROM member_policy_notice WHERE id = ${noticeId} AND read_at IS NOT NULL`)).toBe(0);

      const mine = await app.inject({
        method: 'POST',
        url: '/members/me/notifications/read',
        headers: { authorization: `Bearer ${memberBearer[a!]}` },
        payload: { ids: [noticeId] },
      });
      expect(mine.statusCode, mine.body).toBe(200);
      expect(await num(sql`SELECT count(*)::int AS n FROM member_policy_notice WHERE id = ${noticeId} AND read_at IS NOT NULL`)).toBe(1);
    });

    it('GET serves the current version to her and to staff', async () => {
      const res = await get(`/salons/${SALON}/booking-policy`, memberBearer[members[0]!]!);
      expect(res.statusCode, res.body).toBe(200);
      expect((res.json() as Json).policy).toMatchObject({
        salonId: SALON,
        version: 2,
        noShow: 'keep',
        cancellation: RULES,
        text: { en: TEXT.en, ar: 'نص' },
      });
    });
  });

  // =========================================================== stamping ==

  describe('a booking stamps the version it was made under', () => {
    it('through the real POST /bookings, and a later publish does not change its outcome', async () => {
      const m = await customer();
      // A real slot from the real grid, far enough out that 100% applies under v2.
      let slot: string | undefined;
      for (let d = 5; d < 20 && !slot; d++) {
        const day = new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
        const res = await get(`/artists/${ARTIST}/availability?date=${day}`, memberBearer[m]!);
        expect(res.statusCode, res.body).toBe(200);
        slot = ((res.json() as Json).slots as Json[]).find((s) => s.available)?.startsAt;
      }
      expect(slot, 'the artist offered no slot').toBeDefined();

      // She was shown v1 — stale. Refused, and nothing is held.
      const before = await balanceOf(m);
      const stale = await app.inject({
        method: 'POST',
        url: '/bookings',
        headers: { authorization: `Bearer ${memberBearer[m]}`, 'idempotency-key': `bp-b-${randomUUID()}` },
        payload: { artistId: ARTIST, serviceId: SVC, startsAt: slot, policyVersion: 1 },
      });
      expect(stale.statusCode, stale.body).toBe(409);
      expect((stale.json() as Json).error).toBe('policy_changed');
      expect((stale.json() as Json).policyVersion).toBe(2);
      expect(await balanceOf(m)).toBe(before);

      const res = await app.inject({
        method: 'POST',
        url: '/bookings',
        headers: { authorization: `Bearer ${memberBearer[m]}`, 'idempotency-key': `bp-b-${randomUUID()}` },
        payload: { artistId: ARTIST, serviceId: SVC, startsAt: slot, policyVersion: 2 },
      });
      expect(res.statusCode, res.body).toBe(201);
      const booked = (res.json() as Json).booking as Json;
      expect(booked.policy).toMatchObject({ version: 2, noShow: 'keep', cancellation: RULES });
      expect(booked.policy.text).toEqual({ en: TEXT.en, ar: 'نص' });
      expect(booked.settlement).toBeNull();
      // Automatic settle at slot end: `no_show_return_due_at` = `ends_at` (+0).
      expect(booked.noShowReturnDueAt).toBe(booked.endsAt);

      // The salon changes its mind: everything kept, from any distance.
      await publish({ noShow: 'return', cancellation: [], text: { en: 'Nothing back on cancel.', ar: '' } });

      // Her read still carries v2, and her cancel is decided by v2: 100% back.
      const view = await get(`/bookings/${booked.id}`, memberBearer[m]!);
      expect((view.json() as Json).policy.version).toBe(2);
      const out = await cancel(String(booked.id), m);
      expect(out.statusCode, out.body).toBe(200);
      expect(out.json()).toMatchObject({ refundedFils: DEPOSIT, keptFils: 0, returnPercent: 100 });
      expect(await balanceOf(m)).toBe(before);
    });
  });

  // ======================================================== cancellation ==

  describe('her cancellation, at each threshold, in exact fils', () => {
    let policyId = '';

    beforeAll(async () => {
      const out = await publish({ noShow: 'keep', cancellation: RULES, text: TEXT });
      policyId = String(out.policy.id);
    });

    it('72h out: 100% — 5005 back, nothing kept, one deposit_return, no forfeit', async () => {
      const m = await customer();
      const bk = await heldBooking(m, { startsInMinutes: 72 * 60, policyId });
      const before = await balanceOf(m);

      const res = await cancel(bk, m);
      expect(res.statusCode, res.body).toBe(200);
      const out = res.json() as Json;
      expect(out).toMatchObject({
        refundedFils: 5_005,
        keptFils: 0,
        returnPercent: 100,
        rule: { hoursBefore: 48, returnPercent: 100 },
        balanceAfterFils: before + 5_005,
        forfeitTransactionId: null,
      });
      expect(out.booking.settlement).toEqual({ returnedFils: 5_005, keptFils: 0 });
      expect(await balanceOf(m)).toBe(before + 5_005);
      expect((await settlementTxs(bk)).map((t) => `${t.kind}:${t.amount}`)).toEqual(['deposit_return:5005']);
      expect(await settlementLegs(bk)).toEqual(['deposit_held:debit:5005', 'member_wallet:credit:5005']);
    });

    it('30h out: 50% of 5.005 is 2502 back and 2503 kept — rounded DOWN, the salon keeps the fil', async () => {
      const m = await customer();
      const bk = await heldBooking(m, { startsInMinutes: 30 * 60, policyId });
      const before = await balanceOf(m);

      const res = await cancel(bk, m);
      expect(res.statusCode, res.body).toBe(200);
      const out = res.json() as Json;
      expect(out).toMatchObject({
        refundedFils: 2_502,
        keptFils: 2_503,
        returnPercent: 50,
        rule: { hoursBefore: 24, returnPercent: 50 },
        balanceAfterFils: before + 2_502,
      });
      expect(out.transactionId).toBeTruthy();
      expect(out.forfeitTransactionId).toBeTruthy();
      expect(out.booking.status).toBe('cancelled');
      expect(out.booking.settlement).toEqual({ returnedFils: 2_502, keptFils: 2_503 });
      expect(await balanceOf(m)).toBe(before + 2_502);

      // Two transactions: the return credits her; the forfeit moves nothing in her wallet.
      expect((await settlementTxs(bk)).map((t) => `${t.kind}:${t.amount}`)).toEqual([
        'deposit_forfeit:0',
        'deposit_return:2502',
      ]);
      expect(await settlementLegs(bk)).toEqual([
        'deposit_held:debit:2502',
        'deposit_held:debit:2503',
        'member_wallet:credit:2502',
        'salon_revenue:credit:2503',
      ]);
      const [row] = await exec(sql`
        SELECT settled_returned_fils::int AS r, settled_kept_fils::int AS k,
               settled_transaction_id <> forfeit_transaction_id AS distinct_txs
          FROM booking WHERE id = ${bk}`);
      expect(row).toMatchObject({ r: 2_502, k: 2_503, distinct_txs: true });
    });

    it('12h out: later than every threshold — 0% back, all 5005 kept, only a forfeit', async () => {
      const m = await customer();
      const bk = await heldBooking(m, { startsInMinutes: 12 * 60, policyId });
      const before = await balanceOf(m);

      const res = await cancel(bk, m);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({
        refundedFils: 0,
        keptFils: 5_005,
        returnPercent: 0,
        rule: null,
        transactionId: null,
        balanceAfterFils: before,
      });
      expect(await balanceOf(m)).toBe(before);
      expect((await settlementTxs(bk)).map((t) => `${t.kind}:${t.amount}`)).toEqual(['deposit_forfeit:0']);
      expect(await settlementLegs(bk)).toEqual(['deposit_held:debit:5005', 'salon_revenue:credit:5005']);
      // No receipt: nothing came back, and there is no template for a forfeit.
      expect(
        await num(sql`
          SELECT count(*)::int AS n FROM receipt_job r JOIN booking b ON r.transaction_id = b.forfeit_transaction_id
           WHERE b.id = ${bk}`),
      ).toBe(0);
    });

    it('once it has started she can no longer cancel it — the no-show rule decides', async () => {
      const m = await customer();
      const bk = await heldBooking(m, { startsInMinutes: -5, policyId });
      const res = await cancel(bk, m);
      expect(res.statusCode, res.body).toBe(409);
      expect((res.json() as Json).error).toBe('appointment_started');
    });

    it('#4 — a policy booking cancelled with no Idempotency-Key is refused and nothing moves', async () => {
      const m = await customer();
      const bk = await heldBooking(m, { startsInMinutes: 72 * 60, policyId });
      const before = await balanceOf(m);
      const res = await cancel(bk, m, null);
      expect(res.statusCode, res.body).toBe(400);
      expect((res.json() as Json).error).toBe('idempotency_key_required');
      expect(await balanceOf(m)).toBe(before);
      expect(await num(sql`SELECT count(*)::int AS n FROM booking WHERE id = ${bk} AND status = 'deposit_held'`)).toBe(1);
    });

    it('an idempotent retry returns the same result and moves money once — sequential and concurrent', async () => {
      const m = await customer();
      const bk = await heldBooking(m, { startsInMinutes: 30 * 60, policyId });
      const before = await balanceOf(m);
      const key = `bp-retry-${randomUUID()}`;

      // Two at once with one key, then a third after both.
      const [a, b] = await Promise.all([cancel(bk, m, key), cancel(bk, m, key)]);
      const c = await cancel(bk, m, key);
      for (const r of [a, b, c]) expect(r.statusCode, r.body).toBe(200);
      expect(b.json()).toEqual(a.json());
      expect(c.json()).toEqual(a.json());

      expect(await balanceOf(m)).toBe(before + 2_502);
      expect((await settlementTxs(bk)).map((t) => t.kind)).toEqual(['deposit_forfeit', 'deposit_return']);
      expect(
        await num(sql`
          SELECT count(*)::int AS n FROM "transaction" t
           WHERE t.member_id = ${m} AND t.kind::text IN ('deposit_return', 'deposit_forfeit')`),
      ).toBe(2);

      // A DIFFERENT key is not a replay: it is told the booking is already cancelled.
      const d = await cancel(bk, m, `bp-other-${randomUUID()}`);
      expect(d.statusCode, d.body).toBe(409);
      expect((d.json() as Json).error).toBe('already_cancelled');
      expect(await balanceOf(m)).toBe(before + 2_502);
    });

    it('the salon cancelling returns the WHOLE deposit, whatever her rules would have said', async () => {
      const m = await customer();
      // 1h out: under her rules this would return 0%.
      const bk = await heldBooking(m, { startsInMinutes: 60, policyId });
      const before = await balanceOf(m);
      const res = await app.inject({
        method: 'POST',
        url: `/salons/${SALON}/bookings/${bk}/cancel`,
        headers: { authorization: `Bearer ${bearer[MANAGER]}` },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect((res.json() as Json).refundedFils).toBe(5_005);
      expect((res.json() as Json).booking.settlement).toEqual({ returnedFils: 5_005, keptFils: 0 });
      expect(await balanceOf(m)).toBe(before + 5_005);
      expect(await settlementLegs(bk)).toEqual(['deposit_held:debit:5005', 'member_wallet:credit:5005']);
    });
  });

  // ============================================================ no-show ==

  describe('the no-show rule: keep versus return, by hand and at slot end', () => {
    let keepId = '';
    let returnId = '';

    beforeAll(async () => {
      keepId = String((await publish({ noShow: 'keep', cancellation: RULES, text: { en: 'Keep.', ar: '' } })).policy.id);
      returnId = String(
        (await publish({ noShow: 'return', cancellation: RULES, text: { en: 'Return.', ar: '' } })).policy.id,
      );
    });

    it('keep: a manual mark forfeits the whole deposit to the salon', async () => {
      const m = await customer();
      const bk = await heldBooking(m, { startsInMinutes: -10, policyId: keepId });
      const before = await balanceOf(m);

      const res = await mark(bk);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ refundedFils: 0, keptFils: 5_005, transactionId: null, balanceAfterFils: before });
      expect((res.json() as Json).forfeitTransactionId).toBeTruthy();
      expect((res.json() as Json).booking).toMatchObject({
        status: 'no_show_returned',
        settlement: { returnedFils: 0, keptFils: 5_005 },
      });
      expect(await balanceOf(m)).toBe(before);
      expect(await settlementLegs(bk)).toEqual(['deposit_held:debit:5005', 'salon_revenue:credit:5005']);
    });

    it('return: a manual mark gives it all back', async () => {
      const m = await customer();
      const bk = await heldBooking(m, { startsInMinutes: -10, policyId: returnId });
      const before = await balanceOf(m);
      const res = await mark(bk);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ refundedFils: 5_005, keptFils: 0, forfeitTransactionId: null });
      expect(await balanceOf(m)).toBe(before + 5_005);
      expect(await settlementLegs(bk)).toEqual(['deposit_held:debit:5005', 'member_wallet:credit:5005']);
    });

    it('the sweep settles AT slot end, not a second before, and applies the stamp', async () => {
      const mk = await customer();
      const mr = await customer();
      // Started 30 minutes ago, 60 minutes long: the slot ends in 30 minutes.
      const keep = await heldBooking(mk, { startsInMinutes: -30, durationMin: 60, policyId: keepId });
      const ret = await heldBooking(mr, { startsInMinutes: -30, durationMin: 60, policyId: returnId });
      // Epoch milliseconds from the database, not a Date's string form (which drops them).
      const endsAt = new Date(
        await num(sql`SELECT (extract(epoch FROM ends_at) * 1000)::bigint AS n FROM booking WHERE id = ${keep}`),
      );
      const [bk0, br0] = [await balanceOf(mk), await balanceOf(mr)];

      await runNoShowReturnsOnce(db, 500, new Date(endsAt.getTime() - 1_000));
      expect(await num(sql`SELECT count(*)::int AS n FROM booking WHERE id IN (${keep}, ${ret}) AND status = 'deposit_held'`)).toBe(2);

      // The second booking's slot ends within a few ms of the first's (two INSERTs).
      const tick = await runNoShowReturnsOnce(db, 500, new Date(endsAt.getTime() + 60_000));
      expect(tick.kept).toBeGreaterThanOrEqual(1);
      expect(tick.returned).toBeGreaterThanOrEqual(1);

      const rows = await exec(sql`
        SELECT id, status::text AS status, settled_returned_fils::int AS r, settled_kept_fils::int AS k
          FROM booking WHERE id IN (${keep}, ${ret})`);
      const byId = Object.fromEntries(rows.map((r) => [String(r.id), r]));
      expect(byId[keep]).toMatchObject({ status: 'no_show_returned', r: 0, k: 5_005 });
      expect(byId[ret]).toMatchObject({ status: 'no_show_returned', r: 5_005, k: 0 });
      expect(await balanceOf(mk)).toBe(bk0);
      expect(await balanceOf(mr)).toBe(br0 + 5_005);

      // The merchant is told which it was.
      const [n] = await exec(sql`
        SELECT title FROM merchant_notification WHERE subject_id = ${keep} AND kind = 'booking_no_show'`);
      expect(n?.title).toBe('A deposit was kept under your booking policy');
    });

    it('sweep and manual mark racing: each booking settles EXACTLY once', async () => {
      const pairs: Array<{ m: string; bk: string; before: number }> = [];
      for (let i = 0; i < 6; i++) {
        const m = await customer();
        // Ended already (started 90 min ago, 60 min long), so both paths want it.
        const bk = await heldBooking(m, {
          startsInMinutes: -90,
          durationMin: 60,
          policyId: i % 2 === 0 ? keepId : returnId,
        });
        pairs.push({ m, bk, before: await balanceOf(m) });
      }

      const results = await Promise.all([
        ...pairs.map((p) => mark(p.bk)),
        runNoShowReturnsOnce(db, 500),
        runNoShowReturnsOnce(db, 500),
      ]);

      for (const [i, p] of pairs.entries()) {
        const txs = await settlementTxs(p.bk);
        expect(txs, `booking ${i} settled more than once`).toHaveLength(1);
        const all = await num(sql`
          SELECT count(*)::int AS n FROM "transaction"
           WHERE member_id = ${p.m} AND kind::text IN ('deposit_return', 'deposit_forfeit')`);
        expect(all, `booking ${i}: one settlement transaction in total`).toBe(1);
        const expected = i % 2 === 0 ? p.before : p.before + 5_005;
        expect(await balanceOf(p.m)).toBe(expected);
        // A mark that lost the race is told so by name, not with a 500.
        const res = results[i] as { statusCode: number; body: string };
        expect([200, 409], res.body).toContain(res.statusCode);
        if (res.statusCode === 409) expect(JSON.parse(res.body).error).toBe('already_no_show');
      }
    });
  });

  // ============================================================ legacy ==

  describe('a pre-0066 booking keeps legacy behaviour, even at a salon with a keep policy', () => {
    it('her cancel: refused inside the last hour, exactly as before', async () => {
      const m = await customer();
      const bk = await heldBooking(m, { startsInMinutes: 30, policyId: null });
      const res = await cancel(bk, m, null);
      expect(res.statusCode, res.body).toBe(409);
      expect((res.json() as Json).error).toBe('change_window_closed');
    });

    it('her cancel earlier: the full deposit, with no key required', async () => {
      const m = await customer();
      const bk = await heldBooking(m, { startsInMinutes: 12 * 60, policyId: null });
      const before = await balanceOf(m);
      const res = await cancel(bk, m, null);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ refundedFils: 5_005, keptFils: 0, returnPercent: 100, rule: null });
      expect((res.json() as Json).booking.policy).toBeNull();
      expect(await balanceOf(m)).toBe(before + 5_005);
    });

    it('a no-show: returned in full, and only at its old stamped deadline (ends_at + 60)', async () => {
      const m = await customer();
      const bk = await heldBooking(m, { startsInMinutes: -90, durationMin: 60, policyId: null });
      const before = await balanceOf(m);
      const due = new Date(
        await num(sql`
          SELECT (extract(epoch FROM no_show_return_due_at) * 1000)::bigint AS n FROM booking WHERE id = ${bk}`),
      );
      // Its slot ended 30 minutes ago; a policy booking would already be settled.
      await runNoShowReturnsOnce(db, 500, new Date(due.getTime() - 1_000));
      expect(await num(sql`SELECT count(*)::int AS n FROM booking WHERE id = ${bk} AND status = 'deposit_held'`)).toBe(1);
      // +1 ms: the epoch above is rounded to the millisecond, the column holds microseconds.
      await runNoShowReturnsOnce(db, 500, new Date(due.getTime() + 1));
      expect(await balanceOf(m)).toBe(before + 5_005);
      expect(await settlementLegs(bk)).toEqual(['deposit_held:debit:5005', 'member_wallet:credit:5005']);
    });

    it('a legacy row settled with NULL split reads as a full return', async () => {
      // What the pre-0066 API leaves: cancelled, settled, split columns NULL.
      const m = await customer();
      const bk = await heldBooking(m, { startsInMinutes: 12 * 60, policyId: null });
      await cancel(bk, m, null);
      await exec(sql`UPDATE booking SET settled_returned_fils = NULL, settled_kept_fils = NULL WHERE id = ${bk}`);
      const res = await get(`/bookings/${bk}`, memberBearer[m]!);
      expect((res.json() as Json).settlement).toEqual({ returnedFils: 5_005, keptFils: 0 });
    });
  });

  // =================================================== the ledger, whole ==

  describe('ledger reconciliation over every booking and member this suite touched', () => {
    it('every transaction of every booking balances, and escrow is empty for every settled one', async () => {
      const unbalanced = await exec(sql`
        WITH txs AS (
          SELECT b.id AS booking_id, x.tx
            FROM booking b
            CROSS JOIN LATERAL (VALUES (b.hold_transaction_id), (b.settled_transaction_id), (b.forfeit_transaction_id)) x(tx)
           WHERE b.salon_id = ${SALON} AND x.tx IS NOT NULL
        )
        SELECT txs.booking_id,
               sum(CASE WHEN l.direction = 'credit' THEN l.amount_fils ELSE -l.amount_fils END) AS net
          FROM txs JOIN ledger_entry l ON l.transaction_id = txs.tx
         GROUP BY txs.booking_id
        HAVING sum(CASE WHEN l.direction = 'credit' THEN l.amount_fils ELSE -l.amount_fils END) <> 0`);
      expect(unbalanced).toEqual([]);

      const escrow = await exec(sql`
        SELECT b.id,
               sum(CASE WHEN l.direction = 'credit' THEN l.amount_fils ELSE -l.amount_fils END) AS held
          FROM booking b
          JOIN ledger_entry l
            ON l.transaction_id IN (b.hold_transaction_id, b.settled_transaction_id, b.forfeit_transaction_id)
           AND l.account = 'deposit_held'
         WHERE b.salon_id = ${SALON} AND b.status IN ('cancelled', 'no_show_returned')
         GROUP BY b.id
        HAVING sum(CASE WHEN l.direction = 'credit' THEN l.amount_fils ELSE -l.amount_fils END) <> 0`);
      expect(escrow).toEqual([]);
      expect(
        await num(sql`
          SELECT count(*)::int AS n FROM booking
           WHERE salon_id = ${SALON} AND status IN ('cancelled', 'no_show_returned')`),
      ).toBeGreaterThan(10);
    });

    it('every member of the salon: balance equals the ledger', async () => {
      const drift = await exec(sql`
        SELECT m.id, m.balance_fils,
               coalesce(sum(CASE WHEN l.direction = 'credit' THEN l.amount_fils ELSE -l.amount_fils END), 0) AS ledger
          FROM member m
          LEFT JOIN ledger_entry l ON l.member_id = m.id AND l.account = 'member_wallet'
         WHERE m.salon_id = ${SALON}
         GROUP BY m.id, m.balance_fils
        HAVING m.balance_fils <> coalesce(sum(CASE WHEN l.direction = 'credit' THEN l.amount_fils ELSE -l.amount_fils END), 0)`);
      expect(drift).toEqual([]);
    });

    it('a forfeit never reaches her transaction list — the contract does not know the kind yet', async () => {
      const [row] = await exec(sql`
        SELECT member_id FROM "transaction" WHERE salon_id = ${SALON} AND kind::text = 'deposit_forfeit' LIMIT 1`);
      const m = String(row?.member_id);
      const res = await get('/members/me/transactions', memberBearer[m]!);
      expect(res.statusCode, res.body).toBe(200);
      expect(((res.json() as Json).items as Json[]).some((t) => t.kind === 'deposit_forfeit')).toBe(false);
    });
  });
});
