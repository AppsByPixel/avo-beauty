/**
 * `salon.walletCard` AGAINST REAL ROWS — migration 0069.        (Aftab, 2026-09-29)
 *
 * Whether the wallet's main card wears her tier metal (`tier`, the default) or
 * the salon's own colour (`brand`). The unit specs prove the translator; this
 * proves the doors:
 *
 *   SERVED, AND DEFAULTED. A salon created without naming it reads back `tier`
 *     from `GET /salons/{id}` — to her wallet as well as the dashboard — because
 *     the column default, not a client fallback, says so.
 *
 *   THE SAME GATE AS `brandColor`. `PATCH /salons/{id}` takes it with
 *     `perms.loyalty` and refuses it without (403, called directly — the UI
 *     hiding the control is a courtesy). Salon B's manager, holding every
 *     permission, cannot change salon A. The console's superset takes it under
 *     `salons`, and an analyst without that section is refused.
 *
 *   A VALUE OUTSIDE THE TWO is 400 `invalid_wallet_card` on both doors, and the
 *     CHECK refuses it under a write that bypasses the route.
 *
 *   AUDITED like a brand change: one "Salon settings changed" row naming it.
 *
 * Every refusal is anchored in SQL against the row, not in the API's reply.
 * Own salons, `SAL-INT-WC-` namespace, per-run suffix: nothing seeded is touched.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const TAG = randomUUID().slice(0, 8);
const A = `SAL-INT-WC-A-${TAG}`;
const B = `SAL-INT-WC-B-${TAG}`;
const A_MANAGER = `ST-INT-WC-AM-${TAG}`;
const A_DESK = `ST-INT-WC-AD-${TAG}`;
const B_MANAGER = `ST-INT-WC-BM-${TAG}`;
const A_MEMBER = `MB-INT-WC-${TAG}`;

suite('a workspace can keep its own colour on the wallet card (0069)', () => {
  let app: FastifyInstance;
  let db: (typeof import('../db/client'))['db'];
  let sql: (typeof import('drizzle-orm'))['sql'];
  const tokens: Record<string, string> = {};

  const exec = async (q: unknown) =>
    (await db.execute(q as never)) as unknown as Array<Record<string, unknown>>;
  const stored = async (id: string) =>
    String((await exec(sql`SELECT wallet_card FROM salon WHERE id = ${id}`))[0]?.wallet_card);

  const call = (method: 'GET' | 'PATCH', url: string, who: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${tokens[who]}` },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    sql = (await import('drizzle-orm')).sql;
    const issue = (await import('../auth/sessions')).issueSession;
    const { salon, branch } = await import('../db/schema/salon');
    const { staffUser } = await import('../db/schema/staff');
    const { member } = await import('../db/schema/member');
    app = await (await import('../app')).buildApp();

    for (const id of [A, B]) {
      // `walletCard` DELIBERATELY UNNAMED: the default is what is under test.
      await db.insert(salon).values({
        id,
        name: `Int WC ${id.slice(-10)}`,
        plan: 'starter',
        brandColor: '#1F5A36',
        loyaltyMode: 'tiers',
        tiers: [{ name: 'bronze', minVisits: 0, bonusPercent: 0 }],
        depositFils: 5000 as never,
        businessHours: { morning: ['10:00', '13:00'], evening: ['16:00', '21:00'] },
        social: [],
      });
      await db.insert(branch).values({ id: `BR-${id}`, salonId: id, name: 'Main' });
    }

    const every = {
      permDashboard: true,
      permAppointments: true,
      permShop: true,
      permLoyalty: true,
      permTeam: true,
      permScanner: true,
      permCharges: true,
      permVoid: true,
      permMarketing: true,
    };
    const staff = [
      { id: A_MANAGER, salonId: A, perms: every },
      // Everything BUT `loyalty` — the gate under test, and nothing else missing.
      { id: A_DESK, salonId: A, perms: { ...every, permLoyalty: false } },
      { id: B_MANAGER, salonId: B, perms: every },
    ];
    for (const s of staff) {
      await db.insert(staffUser).values({
        id: s.id,
        salonId: s.salonId,
        name: s.id,
        handle: s.id.toLowerCase(),
        role: 'manager',
        branchAccessAll: true,
        passwordHash: '$argon2id$fake-not-a-credential',
        ...s.perms,
      });
      tokens[s.id] = (
        await issue(db, { principalKind: 'staff', staffId: s.id, salonId: s.salonId, scope: 'dashboard' })
      ).accessToken;
    }

    await db.insert(member).values({
      id: A_MEMBER,
      salonId: A,
      name: 'Int WC Member',
      phone: `+9657${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`,
      passwordHash: '$argon2id$fake-not-a-credential',
      balanceFils: 0 as never,
      visits: 0,
      tier: 'gold',
      policyVersion: 3,
    });
    tokens[A_MEMBER] = (
      await issue(db, { principalKind: 'member', memberId: A_MEMBER, salonId: A, scope: 'wallet' })
    ).accessToken;

    tokens.owner = (
      await issue(db, { principalKind: 'platform_admin', platformAdminId: 'PLT-001', salonId: null, scope: 'platform' })
    ).accessToken;
    tokens.analyst = (
      await issue(db, { principalKind: 'platform_admin', platformAdminId: 'PLT-002', salonId: null, scope: 'platform' })
    ).accessToken;
  });

  afterAll(async () => {
    if (db) {
      await db.execute(
        sql`DELETE FROM session WHERE staff_id IN (${A_MANAGER}, ${A_DESK}, ${B_MANAGER}) OR member_id = ${A_MEMBER}`,
      );
    }
    await app?.close();
  });

  it('is served, and a salon that never chose reads `tier` — to her wallet and to the dashboard', async () => {
    expect(await stored(A)).toBe('tier');

    const toHer = await call('GET', `/salons/${A}`, A_MEMBER);
    expect(toHer.statusCode, toHer.body).toBe(200);
    expect(toHer.json()).toMatchObject({ id: A, walletCard: 'tier', brandColor: '#1F5A36' });

    const toStaff = await call('GET', `/salons/${A}`, A_MANAGER);
    expect(toStaff.statusCode, toStaff.body).toBe(200);
    expect(toStaff.json().walletCard).toBe('tier');
  });

  it('PATCH to `brand` works with perms.loyalty, and is audited like a brand change', async () => {
    const res = await call('PATCH', `/salons/${A}`, A_MANAGER, { walletCard: 'brand' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().walletCard).toBe('brand');
    expect(await stored(A)).toBe('brand');

    // Her wallet sees the change on its next read.
    expect((await call('GET', `/salons/${A}`, A_MEMBER)).json().walletCard).toBe('brand');

    const audit = await exec(sql`
      SELECT action, detail, source, actor_id, metadata
        FROM audit_log
       WHERE salon_id = ${A} AND subject_id = ${A} AND action = 'Salon settings changed'`);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      detail: 'Changed: walletCard',
      source: 'merchant',
      actor_id: A_MANAGER,
      metadata: { changed: ['walletCard'] },
    });

    // And back, so the next spec starts from a known value.
    expect((await call('PATCH', `/salons/${A}`, A_MANAGER, { walletCard: 'tier' })).statusCode).toBe(200);
    expect(await stored(A)).toBe('tier');
  });

  it('is refused 403 without perms.loyalty, called directly, and the row does not move', async () => {
    const res = await call('PATCH', `/salons/${A}`, A_DESK, { walletCard: 'brand' });
    expect(res.statusCode, res.body).toBe(403);
    expect(await stored(A)).toBe('tier');
  });

  it("salon B's manager, holding every permission, cannot change salon A", async () => {
    const res = await call('PATCH', `/salons/${A}`, B_MANAGER, { walletCard: 'brand' });
    expect(res.statusCode, res.body).toBe(403);
    expect(await stored(A)).toBe('tier');

    // Her own salon, same body, same token: the refusal was about the tenant.
    const own = await call('PATCH', `/salons/${B}`, B_MANAGER, { walletCard: 'brand' });
    expect(own.statusCode, own.body).toBe(200);
    expect(await stored(B)).toBe('brand');
    expect(await stored(A)).toBe('tier');
  });

  it.each([['Brand'], ['gold'], [''], [null], [1], [true]])(
    'refuses %j with 400 invalid_wallet_card, and stores nothing',
    async (bad) => {
      const res = await call('PATCH', `/salons/${A}`, A_MANAGER, { walletCard: bad });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error).toBe('invalid_wallet_card');
      expect(await stored(A)).toBe('tier');
    },
  );

  it('the CHECK refuses a value that bypasses the route', async () => {
    await expect(
      db.execute(sql`UPDATE salon SET wallet_card = 'gold' WHERE id = ${A}`),
    ).rejects.toThrow(/salon_wallet_card_known/);
    expect(await stored(A)).toBe('tier');
  });

  it('the console reads it and edits it under `salons`; an analyst without it is refused', async () => {
    const read = await call('GET', `/v1/platform/salons/${A}`, 'owner');
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().salon.walletCard).toBe('tier');

    const denied = await call('PATCH', `/v1/platform/salons/${A}`, 'analyst', { walletCard: 'brand' });
    expect(denied.statusCode, denied.body).toBe(403);
    expect(await stored(A)).toBe('tier');

    const bad = await call('PATCH', `/v1/platform/salons/${A}`, 'owner', { walletCard: 'forest' });
    expect(bad.statusCode, bad.body).toBe(400);
    expect(bad.json().error).toBe('invalid_wallet_card');

    const ok = await call('PATCH', `/v1/platform/salons/${A}`, 'owner', { walletCard: 'brand' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().salon.walletCard).toBe('brand');
    expect(await stored(A)).toBe('brand');

    const [row] = await exec(sql`
      SELECT detail, source FROM audit_log
       WHERE salon_id = ${A} AND source = 'owner_console' AND action = 'Salon settings changed'`);
    expect(row).toMatchObject({ detail: 'Changed by AVO: walletCard', source: 'owner_console' });
  });

  /**
   * THE DEMO WORKSPACE, as `db:seed` and `db:demo-forest` both leave it
   * (db/forestFixture.ts). Maha is GOLD, so a `tier` salon would give her a gold
   * card — and hers is forest green because her salon says `brand`. Read as HER,
   * because her wallet is the surface that paints it.
   */
  it('seeded SAL-FOREST serves `brand` and #1F5A36 to its gold member', async () => {
    const issue = (await import('../auth/sessions')).issueSession;
    const { FOREST } = await import('../db/forestFixture');
    const maha = (
      await issue(db, { principalKind: 'member', memberId: FOREST.memberId, salonId: FOREST.salonId, scope: 'wallet' })
    ).accessToken;
    try {
      const salonRes = await app.inject({
        method: 'GET',
        url: `/salons/${FOREST.salonId}`,
        headers: { authorization: `Bearer ${maha}` },
      });
      expect(salonRes.statusCode, salonRes.body).toBe(200);
      expect(salonRes.json()).toMatchObject({ walletCard: 'brand', brandColor: '#1F5A36', loyaltyMode: 'tiers' });

      const me = await app.inject({
        method: 'GET',
        url: '/members/me',
        headers: { authorization: `Bearer ${maha}` },
      });
      expect(me.statusCode, me.body).toBe(200);
      expect(me.json()).toMatchObject({ id: FOREST.memberId, tier: 'gold' });
    } finally {
      await db.execute(sql`DELETE FROM session WHERE member_id = ${FOREST.memberId}`);
    }
  });
});
