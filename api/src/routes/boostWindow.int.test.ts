/**
 * A BRANCH BOOST WITH A DURATION AND A STOP, against a real database and the real
 * charge (migration 0067). Aftab: "Duration and stop option in the branch boost in
 * the marketing on dashboard".
 *
 * THE CLAIM EVERY SPEC HERE SERVES: the server decides whether a boost applies,
 * at the instant of the charge, from the row — never from a client, never from a
 * sweep flipping a flag (non-negotiable #2). So the specs drive `POST /charges`
 * and read what the visit EARNED (`loyalty.visitsEarned`), not what the promotion
 * set says.
 *
 * ITS OWN SALONS, per run (`BW-`), for `chargeLoyaltyRecord.int.test.ts`' reason:
 * a single-branch salon, so every charge's branch is ESTABLISHED and a boost row
 * pays deterministically, and no happy hour exists at either salon, so "+2" is the
 * boost and nothing else. `BW-T` is the tenancy neighbour.
 *
 * EXPIRY IS SIMULATED BY MOVING THE ROW, NOT THE CLOCK. `PUT` refuses a changed
 * boost whose end has already passed (a boost that can never apply is a mistake),
 * so an expired boost is one published with a future end whose `ends_at` is then
 * set a minute into the past — exactly the row time would have produced.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const S = `BW-S-${RUN}`;
const T = `BW-T-${RUN}`;
const branchOf = (salonId: string) => `${salonId}-BR`;
const MGR = `${S}-MGR`;
/** Everything a manager has, except `perms.marketing` — boost publishing's gate. */
const NO_MKT = `${S}-NOM`;
const T_MGR = `${T}-MGR`;

type Json = Record<string, any>;

suite('branch boosts: a duration and a stop, decided by the server (0067)', () => {
  let app: FastifyInstance;
  let db: (typeof import('../db/client'))['db'];
  let sql: (typeof import('drizzle-orm'))['sql'];
  let issue: (typeof import('../auth/sessions'))['issueSession'];
  const bearer: Record<string, string> = {};

  const exec = async (q: unknown) =>
    (await db.execute(q as never)) as unknown as Array<Record<string, unknown>>;

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    sql = (await import('drizzle-orm')).sql;
    issue = (await import('../auth/sessions')).issueSession;
    app = await (await import('../app')).buildApp();

    const hours = JSON.stringify({ morning: ['10:00', '13:00'], evening: ['16:00', '22:00'] });
    for (const id of [S, T]) {
      await exec(sql`
        INSERT INTO salon (id, name, brand_color, loyalty_mode, tiers, deposit_fils, business_hours,
                           module_booking, module_shop, timezone)
        VALUES (${id}, ${`BW ${id}`}, '#7A5C8E', 'tiers',
                (SELECT tiers FROM salon WHERE id = 'SAL-AMARA'), 2000, ${hours}::jsonb,
                false, false, 'Asia/Kuwait')`);
      await exec(sql`INSERT INTO branch (id, salon_id, name) VALUES (${branchOf(id)}, ${id}, 'BW Branch')`);
    }
    const staff = async (sid: string, salonId: string, marketing: boolean) => {
      await exec(sql`
        INSERT INTO staff_user
          (id, salon_id, name, handle, role, branch_access_all, branch_access_ids, password_hash,
           perm_dashboard, perm_appointments, perm_shop, perm_loyalty, perm_team, perm_scanner,
           perm_charges, perm_void, perm_marketing)
        VALUES (${sid}, ${salonId}, ${`BW ${sid.slice(-3)}`}, ${`bw-${RUN}-${sid.slice(-5).toLowerCase()}`},
                'manager', true, '{}', 'x', true, true, true, true, true, true, true, true, ${marketing})`);
      bearer[sid] = (
        await issue(db, { principalKind: 'staff', staffId: sid, salonId, scope: 'dashboard' })
      ).accessToken;
    };
    await staff(MGR, S, true);
    await staff(NO_MKT, S, false);
    await staff(T_MGR, T, true);
  });

  afterAll(async () => {
    if (db && sql) {
      // Sessions go; salons, branches, members and their money stay (append-only
      // ledger, restrict FKs). Inert and per-run, `BW-`.
      await exec(sql`DELETE FROM session WHERE salon_id IN (${S}, ${T})`);
    }
    await app?.close();
  });

  // ------------------------------------------------------------ fixtures --

  async function customer(salonId = S): Promise<string> {
    const id = `BW-M-${randomUUID().slice(0, 12)}`;
    await exec(sql`
      INSERT INTO member (id, salon_id, name, phone, password_hash, balance_fils, visits, tier, policy_version)
      VALUES (${id}, ${salonId}, 'BW Customer',
              ${`+9656${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`}, 'x', 500000, 0,
              'bronze', 1)`);
    return id;
  }

  /** A charge at the till, on a fresh device so the till budget is never what is measured. */
  async function charge(memberId: string): Promise<Json> {
    const till = (
      await issue(db, {
        principalKind: 'staff',
        staffId: MGR,
        salonId: S,
        scope: 'scanner',
        deviceId: `BW-DEV-${randomUUID()}`,
      })
    ).accessToken;
    const res = await app.inject({
      method: 'POST',
      url: '/charges',
      headers: { authorization: `Bearer ${till}`, 'idempotency-key': `bw-charge-${randomUUID()}` },
      payload: { memberId, amountFils: 5000, reason: 'BW boost spec', confirmDuplicate: true },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as Json;
  }

  /** What one charge at salon S earns in visits, right now. */
  const visitsEarned = async () => ((await charge(await customer())).loyalty as Json).visitsEarned as number;

  const put = (boosts: Json, as = bearer[MGR]!, salonId = S) =>
    app.inject({
      method: 'PUT',
      url: `/v1/salons/${salonId}/promotions/boosts`,
      headers: { authorization: `Bearer ${as}` },
      payload: { boosts },
    });

  const stop = (as = bearer[MGR]!, salonId = S, branchId = branchOf(S)) =>
    app.inject({
      method: 'POST',
      url: `/v1/salons/${salonId}/promotions/boosts/${branchId}/stop`,
      headers: { authorization: `Bearer ${as}` },
    });

  const promotions = async (as = bearer[MGR]!): Promise<Json> => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/salons/${S}/promotions`,
      headers: { authorization: `Bearer ${as}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as Json;
  };

  const boostRow = async () =>
    (
      await exec(sql`
        SELECT visit, topup, stamp, starts_at, ends_at, stopped_at, stopped_by, stopped_by_staff_id
          FROM boost WHERE salon_id = ${S} AND branch_id = ${branchOf(S)}`)
    )[0];

  const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

  /**
   * One real top-up at salon S, settled through the sandbox gateway. Returns the
   * transaction's `promo_bonus_fils` and its tier `bonus_fils`, the two columns
   * services/topup.ts keeps apart.
   */
  async function topUpBonuses(): Promise<{ promo: number; tier: number }> {
    const sandbox = (await import('../gateway')).sandboxGateway();
    if (!sandbox) throw new Error('this suite requires GATEWAY_DRIVER=sandbox');
    const topup = await import('../services/topup');
    const { topUpIntent } = await import('../db/schema/topup');
    const { eq } = await import('drizzle-orm');

    const m = await customer();
    const wallet = (await issue(db, { principalKind: 'member', memberId: m, salonId: S, scope: 'wallet' }))
      .accessToken;
    const res = await app.inject({
      method: 'POST',
      url: '/topups',
      headers: { authorization: `Bearer ${wallet}`, 'idempotency-key': `bw-topup-${randomUUID()}` },
      payload: { amountFils: 5000, method: 'knet' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const [row] = await db.select().from(topUpIntent).where(eq(topUpIntent.id, (res.json() as Json).id)).limit(1);
    if (!row) throw new Error('no intent');
    await sandbox.setOutcome(row.pspReference as string, 'succeeded');
    const settled = await topup.settleFromGatewayRead(
      db,
      row as unknown as import('../services/topup').TopUpIntentRow,
      'succeeded',
      row.amountFils,
    );
    expect(settled.kind).toBe('applied');
    const [t] = await exec(sql`
      SELECT promo_bonus_fils::int AS promo, bonus_fils::int AS tier
        FROM "transaction" WHERE member_id = ${m} AND kind = 'topup'`);
    return { promo: Number(t?.promo), tier: Number(t?.tier) };
  }
  const promoOf = async () => (await topUpBonuses()).promo;

  /**
   * Publish 2x visits at S's one branch, with the given window. `topup: 0` because
   * a branch boost carries no top-up bonus since 0068. It was `topup: 20` before,
   * which the PUT now refuses with `boost_topup_removed`.
   */
  async function publish(window: { startsAt?: string | null; endsAt?: string | null } = {}) {
    const res = await put({ [branchOf(S)]: { visit: 2, topup: 0, stamp: 1, ...window } });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as Json;
  }

  // ============================================================ duration ==

  describe('a duration — the boost applies while startsAt <= now < endsAt', () => {
    it('a boost that is still running DOES apply to a charge: +2 visits', async () => {
      const endsAt = inMinutes(120);
      const set = await publish({ endsAt });
      expect(set.boosts[branchOf(S)]).toEqual({
        visit: 2,
        topup: 0,
        stamp: 1,
        startsAt: null,
        endsAt: new Date(endsAt).toISOString(),
        stoppedAt: null,
        stoppedBy: null,
      });
      expect(await visitsEarned()).toBe(2);
    });

    it('the same boost once its endsAt has passed does NOT apply: +1 — and nothing had to flip', async () => {
      await publish({ endsAt: inMinutes(120) });
      await exec(sql`
        UPDATE boost SET ends_at = now() - interval '1 minute' WHERE salon_id = ${S} AND branch_id = ${branchOf(S)}`);
      expect(await visitsEarned()).toBe(1);
      // The read still carries the values and the end; there is no live flag to
      // have been flipped. Every client resolves the predicate for itself.
      const b = (await promotions()).boosts[branchOf(S)] as Json;
      expect(b).toMatchObject({ visit: 2, stoppedAt: null });
      expect(Date.parse(String(b.endsAt))).toBeLessThan(Date.now());
      expect(b).not.toHaveProperty('live');
    });

    it('a boost not yet at its startsAt does not apply', async () => {
      await publish({ startsAt: inMinutes(60), endsAt: inMinutes(180) });
      expect(await visitsEarned()).toBe(1);
      await exec(sql`
        UPDATE boost SET starts_at = now() - interval '1 minute' WHERE salon_id = ${S} AND branch_id = ${branchOf(S)}`);
      expect(await visitsEarned()).toBe(2);
    });

    it('a CHANGED boost ending in the past is refused, and nothing is written', async () => {
      await publish({ endsAt: inMinutes(120) });
      const before = await boostRow();
      const res = await put({ [branchOf(S)]: { visit: 3, topup: 0, stamp: 1, endsAt: inMinutes(-5) } });
      expect(res.statusCode, res.body).toBe(400);
      expect((res.json() as Json).error).toBe('boost_already_ended');
      expect(await boostRow()).toEqual(before);
    });

    it('an end at or before its start is refused', async () => {
      const at = inMinutes(60);
      const res = await put({ [branchOf(S)]: { visit: 2, topup: 0, stamp: 1, startsAt: at, endsAt: at } });
      expect(res.statusCode, res.body).toBe(400);
      expect((res.json() as Json).error).toBe('invalid_boost_window');
    });

    it('a zoneless instant is refused — the server does not guess which clock it was', async () => {
      const res = await put({ [branchOf(S)]: { visit: 2, topup: 0, stamp: 1, endsAt: '2031-01-01T10:00' } });
      expect(res.statusCode, res.body).toBe(400);
      expect((res.json() as Json).error).toBe('invalid_boost_window');
    });

    it('an EXPIRED boost sent back unchanged by the grid is not refused, and still earns nothing', async () => {
      await publish({ endsAt: inMinutes(120) });
      await exec(sql`
        UPDATE boost SET ends_at = now() - interval '1 minute' WHERE salon_id = ${S} AND branch_id = ${branchOf(S)}`);
      const b = (await promotions()).boosts[branchOf(S)] as Json;
      const res = await put({ [branchOf(S)]: b });
      expect(res.statusCode, res.body).toBe(200);
      expect(await visitsEarned()).toBe(1);
    });

    it('a top-up never earns a branch boost, running or expired — a top-up has no branch', async () => {
      // services/topup.ts passes `branchId: null` to loadPromotionInputs, so no
      // branch boost is found for a top-up (branchSource.test.ts pins the call),
      // and since 0068 a boost carries no top-up points anyway. This pins that an
      // expired boost cannot leak into a top-up by some other route.
      await publish({ endsAt: inMinutes(120) });
      await exec(sql`
        UPDATE boost SET ends_at = now() - interval '1 minute' WHERE salon_id = ${S} AND branch_id = ${branchOf(S)}`);
      expect(await promoOf(), 'expired').toBe(0);
      await publish({ endsAt: inMinutes(120) });
      expect(await promoOf(), 'running').toBe(0);
    });
  });

  // ================================================================ stop ==

  describe('a stop — ends the boost now, records who and when, audits it', () => {
    it('stops immediately: the next charge earns +1, the row is neutral and says who stopped it', async () => {
      await publish({ endsAt: inMinutes(240) });
      expect(await visitsEarned()).toBe(2);

      const res = await stop();
      expect(res.statusCode, res.body).toBe(200);
      const b = (res.json() as Json).boosts[branchOf(S)] as Json;
      expect(b).toMatchObject({ visit: 1, topup: 0, stamp: 1, startsAt: null, endsAt: null, stoppedBy: 'BW MGR' });
      expect(Math.abs(Date.parse(String(b.stoppedAt)) - Date.now())).toBeLessThan(60_000);

      expect(await visitsEarned()).toBe(1);
      expect(await boostRow()).toMatchObject({ visit: 1, topup: 0, stamp: 1, stopped_by_staff_id: MGR });

      const [audit] = await exec(sql`
        SELECT action, kind::text AS kind, detail, metadata FROM audit_log
         WHERE salon_id = ${S} AND action = 'Boost stopped' ORDER BY created_at DESC LIMIT 1`);
      expect(audit).toMatchObject({ action: 'Boost stopped', kind: 'rules' });
      // No top-up part since 0068: it could only ever read "+0% top-ups".
      expect(String(audit?.detail)).toContain(`${branchOf(S)}: 2× visits, 1× stamps`);
      expect(String(audit?.detail)).not.toContain('top-ups');
      expect((audit?.metadata as Json).stopped).toMatchObject({ visit: 2, stamp: 1 });
      expect((audit?.metadata as Json).stopped).not.toHaveProperty('topup');
      expect((audit?.metadata as Json).branchId).toBe(branchOf(S));
    });

    it('a second stop is told so by name, and nothing changes', async () => {
      const before = await boostRow();
      const res = await stop();
      expect(res.statusCode, res.body).toBe(409);
      expect((res.json() as Json).error).toBe('boost_already_stopped');
      expect(await boostRow()).toEqual(before);
    });

    it('the grid re-sending the stopped (neutral) branch keeps the stop record; a new boost clears it', async () => {
      const kept = await put({ [branchOf(S)]: { visit: 1, topup: 0, stamp: 1 } });
      expect(kept.statusCode, kept.body).toBe(200);
      expect(((kept.json() as Json).boosts[branchOf(S)] as Json).stoppedBy).toBe('BW MGR');

      const fresh = await publish();
      expect(fresh.boosts[branchOf(S)]).toMatchObject({ visit: 2, stoppedAt: null, stoppedBy: null });
      expect(await visitsEarned()).toBe(2);
    });

    it('a scheduled boost can be stopped before it starts', async () => {
      await publish({ startsAt: inMinutes(60), endsAt: inMinutes(120) });
      const res = await stop();
      expect(res.statusCode, res.body).toBe(200);
      expect(await boostRow()).toMatchObject({ visit: 1, starts_at: null, ends_at: null });
    });

    it('an expired boost cannot be stopped — it already has', async () => {
      await publish({ endsAt: inMinutes(120) });
      await exec(sql`
        UPDATE boost SET ends_at = now() - interval '1 minute' WHERE salon_id = ${S} AND branch_id = ${branchOf(S)}`);
      const res = await stop();
      expect(res.statusCode, res.body).toBe(409);
      expect((res.json() as Json).error).toBe('boost_already_ended');
    });

    it('a branch with no boost has nothing to stop', async () => {
      await put({});
      const res = await stop();
      expect(res.statusCode, res.body).toBe(409);
      expect((res.json() as Json).error).toBe('no_boost_running');
    });
  });

  // ======================================================= #7, tenancy ==

  describe('permissions and tenancy, called directly', () => {
    it('stop with perms.marketing OFF is 403, and the boost keeps paying', async () => {
      await publish();
      const res = await stop(bearer[NO_MKT]!);
      expect(res.statusCode, res.body).toBe(403);
      expect(await boostRow()).toMatchObject({ visit: 2, stopped_at: null });
      expect(await visitsEarned()).toBe(2);
    });

    it('PUT with perms.marketing OFF is 403 too — the gate stop shares', async () => {
      const res = await put({ [branchOf(S)]: { visit: 3, topup: 0, stamp: 3, endsAt: inMinutes(30) } }, bearer[NO_MKT]!);
      expect(res.statusCode, res.body).toBe(403);
      expect(await boostRow()).toMatchObject({ visit: 2, ends_at: null });
    });

    it("salon B cannot stop salon A's boost — neither through A's path nor by naming A's branch under its own", async () => {
      await publish();
      const direct = await stop(bearer[T_MGR]!, S, branchOf(S));
      expect(direct.statusCode, direct.body).toBe(403);
      const guessed = await stop(bearer[T_MGR]!, T, branchOf(S));
      expect(guessed.statusCode, guessed.body).toBe(404);
      expect((guessed.json() as Json).error).toBe('unknown_branch');
      expect(await boostRow()).toMatchObject({ visit: 2, stopped_at: null });
      expect(await visitsEarned()).toBe(2);
    });
  });
  // ============================================ 0068, no top-up on a boost ==

  describe('a branch boost pays no top-up bonus (0068, Aftab: "Remove it from boosts")', () => {
    it('PUT with a non-zero topup is refused 400 boost_topup_removed, and nothing is written', async () => {
      await publish();
      const before = await boostRow();
      const res = await put({ [branchOf(S)]: { visit: 3, topup: 10, stamp: 1 } });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json() as Json).toMatchObject({ error: 'boost_topup_removed', branchId: branchOf(S) });
      expect(await boostRow()).toEqual(before);
    });

    it('topup left out is accepted, and the wire still carries it as 0 so installed apps keep parsing', async () => {
      const res = await put({ [branchOf(S)]: { visit: 2, stamp: 2 } });
      expect(res.statusCode, res.body).toBe(200);
      expect(((res.json() as Json).boosts[branchOf(S)] as Json)).toMatchObject({ visit: 2, topup: 0, stamp: 2 });
      expect(await boostRow()).toMatchObject({ topup: 0 });
    });

    it('a top-up at a branch that has a running boost earns no boost bonus, and the tier bonus is unchanged', async () => {
      await put({});
      const plain = await topUpBonuses();
      await publish({ endsAt: inMinutes(120) });
      const boosted = await topUpBonuses();
      expect(boosted.promo).toBe(0);
      expect(boosted.tier).toBe(plain.tier);
      expect(boosted).toEqual(plain);
    });

    it('the database refuses a non-zero topup even when the API is bypassed', async () => {
      let code: string | undefined;
      try {
        await exec(sql`UPDATE boost SET topup = 10 WHERE salon_id = ${S} AND branch_id = ${branchOf(S)}`);
      } catch (err) {
        code = (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
      }
      expect(code).toBe('23514');
      expect(await boostRow()).toMatchObject({ topup: 0 });
    });
  });
});
