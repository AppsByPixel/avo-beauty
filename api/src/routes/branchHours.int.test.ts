/**
 * A BRANCH KEEPS ITS OWN HOURS — when it has any.            (migration 0063)
 *
 * "Please collect during the branch's official working hours." The hours a
 * pickup is collected in are the BRANCH's override when it has one, and the
 * salon's Settings hours when it does not, and every surface that tells her
 * where to collect also tells her when — in the salon's zone.
 *
 * WHAT THIS PROVES
 *   - override NULL → the salon's hours are served, `businessHoursSource: 'salon'`,
 *     and they FOLLOW a later edit of the salon's hours;
 *   - override set → served as `'branch'`, on `salon.branches`, on `pickupBranch`
 *     in the order response, her order list and the merchant board, with
 *     `timezone` beside them;
 *   - `null` clears it back;
 *   - invalid hours are refused with the salon's own validator, and the column
 *     refuses a malformed document even when no route checks;
 *   - `perms.loyalty` off → 403 and nothing changed; another salon's branch is a
 *     404 under your path and a 403 under theirs.
 *
 * Its own salons (`BH-…-<run>`), so no spec here moves SAL-AMARA's hours under
 * another suite's feet.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const id = (tag: string) => `BH-${tag}-${RUN}`;

const SALON = id('SALON');
const FOLLOWS = id('BR-A'); // never given an override
const OWN = id('BR-B'); // given one
const OTHER_SALON = id('OTHER');
const FOREIGN = id('BR-Y');
const PRODUCT = id('PR');

const SALON_HOURS = { morning: ['10:00', '13:00'], evening: ['16:00', '22:00'] };
const OWN_HOURS = { morning: ['09:00', '12:30'], evening: ['17:00', '24:00'] };

suite('a branch keeps its own hours', () => {
  let app: FastifyInstance;
  let db: (typeof import('../db/client'))['db'];
  let sql: (typeof import('drizzle-orm'))['sql'];
  let issue: (typeof import('../auth/sessions'))['issueSession'];
  let manager = '';
  let noLoyalty = '';
  let otherManager = '';
  let memberId = '';
  let memberToken = '';

  const exec = async (q: unknown) =>
    (await db.execute(q as never)) as unknown as Array<Record<string, unknown>>;

  async function staff(sid: string, salonId: string, loyalty: boolean): Promise<string> {
    await exec(sql`
      INSERT INTO staff_user
        (id, salon_id, name, handle, role, branch_access_all, branch_access_ids,
         password_hash, perm_dashboard, perm_appointments, perm_shop, perm_loyalty,
         perm_team, perm_scanner, perm_charges, perm_void, perm_marketing)
      VALUES (${sid}, ${salonId}, ${`BH ${sid}`}, ${sid.toLowerCase()},
              'manager', true, '{}', 'x', true, true, true, ${loyalty}, true, true, true, true, true)`);
    return (await issue(db, { principalKind: 'staff', staffId: sid, salonId, scope: 'dashboard' }))
      .accessToken;
  }

  const call = async (method: 'GET' | 'POST' | 'PATCH', url: string, bearer: string, payload?: unknown) => {
    const res = await app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${bearer}`,
        ...(method === 'POST' ? { 'idempotency-key': `bh-${randomUUID()}` } : {}),
      },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    return { status: res.statusCode, body: JSON.parse(res.body || '{}') as Record<string, any> };
  };

  const branchesOf = async (bearer = memberToken) => {
    const res = await call('GET', `/salons/${SALON}`, bearer);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as { timezone: string; businessHours: unknown; branches: Array<Record<string, any>> };
  };
  const branchIn = (s: { branches: Array<Record<string, any>> }, bid: string) =>
    s.branches.find((b) => b.id === bid);
  const stored = async (bid: string) =>
    (await exec(sql`SELECT business_hours FROM branch WHERE id = ${bid}`))[0]?.business_hours ?? null;
  const setHours = (bid: string, businessHours: unknown, bearer = manager, salonId = SALON) =>
    call('PATCH', `/salons/${salonId}/branches/${bid}`, bearer, { businessHours });

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    sql = (await import('drizzle-orm')).sql;
    issue = (await import('../auth/sessions')).issueSession;
    app = await (await import('../app')).buildApp();

    for (const [sid, name] of [
      [SALON, 'BH Salon'],
      [OTHER_SALON, 'BH Other'],
    ] as const) {
      await exec(sql`
        INSERT INTO salon (id, name, brand_color, loyalty_mode, stamp_target, stamp_reward,
                           deposit_fils, business_hours, module_shop)
        VALUES (${sid}, ${`${name} ${RUN}`}, '#7A5C8E', 'stamps', 6, 'free blow-dry', 5000,
                ${JSON.stringify(SALON_HOURS)}::jsonb, true)`);
    }
    await exec(sql`
      INSERT INTO branch (id, salon_id, name) VALUES
        (${FOLLOWS}, ${SALON}, 'BH Follows'), (${OWN}, ${SALON}, 'BH Own'),
        (${FOREIGN}, ${OTHER_SALON}, 'BH Foreign')`);
    await exec(sql`
      INSERT INTO product (id, salon_id, name, price_fils, active)
      VALUES (${PRODUCT}, ${SALON}, ${`BH Serum ${RUN}`}, 2000, true)`);

    manager = await staff(id('ST-MGR'), SALON, true);
    noLoyalty = await staff(id('ST-NOLOY'), SALON, false);
    otherManager = await staff(id('ST-OTHER'), OTHER_SALON, true);

    memberId = id('M');
    await exec(sql`
      INSERT INTO member (id, salon_id, name, phone, password_hash, balance_fils, tier, visits, policy_version)
      VALUES (${memberId}, ${SALON}, 'BH Member',
              ${`+9656${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`},
              '$argon2id$fake-not-a-credential', 90000, 'bronze', 0, 3)`);
    memberToken = (
      await issue(db, { principalKind: 'member', memberId, salonId: SALON, scope: 'wallet' })
    ).accessToken;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('with no override, every branch serves the SALON’s hours, says so, and the zone is served', async () => {
    const s = await branchesOf();
    expect(s.timezone).toBe('Asia/Kuwait');
    for (const bid of [FOLLOWS, OWN]) {
      expect(branchIn(s, bid)).toMatchObject({ businessHours: SALON_HOURS, businessHoursSource: 'salon' });
    }
    expect(await stored(FOLLOWS)).toBeNull();
  });

  it('an override is stored and served as the branch’s own, beside a branch that still follows', async () => {
    const res = await setHours(OWN, OWN_HOURS);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ id: OWN, businessHours: OWN_HOURS, businessHoursSource: 'branch' });
    expect(await stored(OWN)).toEqual(OWN_HOURS);

    const s = await branchesOf();
    expect(branchIn(s, OWN)).toMatchObject({ businessHours: OWN_HOURS, businessHoursSource: 'branch' });
    expect(branchIn(s, FOLLOWS)).toMatchObject({ businessHours: SALON_HOURS, businessHoursSource: 'salon' });

    const [audit] = await exec(sql`
      SELECT action, metadata FROM audit_log
       WHERE subject_type = 'branch' AND subject_id = ${OWN} ORDER BY id DESC LIMIT 1`);
    expect(audit?.action).toBe('Branch hours changed');
    expect((audit?.metadata as any).hoursBefore).toBeNull();
    expect((audit?.metadata as any).hoursAfter).toEqual(OWN_HOURS);
  });

  it('a branch with no override FOLLOWS a later edit of the salon’s hours; the override does not', async () => {
    const later = { morning: ['11:00', '14:00'], evening: ['18:00', '23:00'] };
    const res = await call('PATCH', `/salons/${SALON}`, manager, { businessHours: later });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // The PATCH's own response already resolves against the new hours.
    expect(branchIn(res.body as any, FOLLOWS)).toMatchObject({ businessHours: later, businessHoursSource: 'salon' });

    const s = await branchesOf();
    expect(branchIn(s, FOLLOWS)?.businessHours).toEqual(later);
    expect(branchIn(s, OWN)?.businessHours).toEqual(OWN_HOURS);

    await call('PATCH', `/salons/${SALON}`, manager, { businessHours: SALON_HOURS });
  });

  it('pickupBranch carries the resolved hours and the zone — on the order, her list, and the board', async () => {
    const own = await call('POST', '/orders', memberToken, {
      items: [{ productId: PRODUCT, qty: 1 }],
      fulfilment: 'pickup',
      pickupBranchId: OWN,
    });
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    expect(own.body.pickupBranch).toEqual({
      id: OWN,
      name: 'BH Own',
      nameAr: null,
      closed: false,
      businessHours: OWN_HOURS,
      businessHoursSource: 'branch',
      timezone: 'Asia/Kuwait',
    });
    const ownTx = own.body.transaction.id as string;

    const follows = await call('POST', '/orders', memberToken, {
      items: [{ productId: PRODUCT, qty: 1 }],
      fulfilment: 'pickup',
      pickupBranchId: FOLLOWS,
    });
    expect(follows.status, JSON.stringify(follows.body)).toBe(201);
    expect(follows.body.pickupBranch).toMatchObject({
      businessHours: SALON_HOURS,
      businessHoursSource: 'salon',
      timezone: 'Asia/Kuwait',
    });

    const mine = await call('GET', '/members/me/orders', memberToken);
    expect(mine.status).toBe(200);
    const listed = (mine.body.items as any[]).find((o) => o.transactionId === ownTx);
    expect(listed?.pickupBranch).toMatchObject({ businessHours: OWN_HOURS, businessHoursSource: 'branch', timezone: 'Asia/Kuwait' });

    const board = await call('GET', `/v1/salons/${SALON}/orders`, manager);
    expect(board.status).toBe(200);
    const onBoard = (board.body.items as any[]).find((o) => o.transactionId === ownTx);
    expect(onBoard?.pickupBranch).toMatchObject({ businessHours: OWN_HOURS, businessHoursSource: 'branch' });

    const moved = await call('PATCH', `/v1/salons/${SALON}/orders/${ownTx}`, manager, { status: 'ready' });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.order.pickupBranch).toMatchObject({ businessHours: OWN_HOURS, businessHoursSource: 'branch' });
  });

  it('null CLEARS the override: the salon’s hours come back in the same response', async () => {
    const res = await setHours(OWN, null);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ businessHours: SALON_HOURS, businessHoursSource: 'salon' });
    expect(await stored(OWN)).toBeNull();
  });

  it('refuses invalid hours with the salon’s own validator, and stores nothing', async () => {
    await setHours(OWN, OWN_HOURS);
    for (const bad of [
      'banana',
      { morning: ['10:00', '13:00'] },
      { morning: ['banana', '13:00'], evening: ['16:00', '22:00'] },
      { morning: ['24:00', '13:00'], evening: ['16:00', '22:00'] },
      { morning: ['10:00', '25:00'], evening: ['16:00', '22:00'] },
      { morning: ['10:00'], evening: ['16:00', '22:00'] },
      ['10:00', '22:00'],
    ]) {
      const res = await setHours(OWN, bad);
      expect(res.status, `${JSON.stringify(bad)} → ${JSON.stringify(res.body)}`).toBe(400);
      expect(res.body.error).toBe('invalid_business_hours');
    }
    expect(await stored(OWN)).toEqual(OWN_HOURS);
  });

  it('THE COLUMN refuses a malformed document even when no route checks', async () => {
    await expect(
      exec(sql`UPDATE branch SET business_hours = '{"morning": ["10:00","13:00"]}'::jsonb WHERE id = ${OWN}`),
    ).rejects.toThrow(/branch_business_hours_shape/);
    await expect(
      exec(sql`UPDATE branch SET business_hours = '"10:00-22:00"'::jsonb WHERE id = ${OWN}`),
    ).rejects.toThrow(/branch_business_hours_shape/);
    expect(await stored(OWN)).toEqual(OWN_HOURS);
  });

  it('perms.loyalty OFF → 403 with its copy, the override unchanged, no audit row', async () => {
    const before = await exec(sql`SELECT count(*)::int AS n FROM audit_log WHERE subject_id = ${OWN}`);
    const res = await setHours(OWN, SALON_HOURS, noLoyalty);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: 'forbidden',
      message: "You don't have permission to change loyalty settings. A manager can grant it.",
    });
    const cleared = await setHours(OWN, null, noLoyalty);
    expect(cleared.status).toBe(403);
    expect(await stored(OWN)).toEqual(OWN_HOURS);
    const after = await exec(sql`SELECT count(*)::int AS n FROM audit_log WHERE subject_id = ${OWN}`);
    expect(after[0]?.n).toBe(before[0]?.n);
  });

  it('tenancy: another salon’s branch is 404 under your path and 403 under theirs, and untouched', async () => {
    const underMine = await setHours(FOREIGN, OWN_HOURS, manager, SALON);
    expect(underMine.status).toBe(404);
    expect(underMine.body.error).toBe('unknown_branch');

    const underTheirs = await setHours(FOREIGN, OWN_HOURS, manager, OTHER_SALON);
    expect(underTheirs.status).toBe(403);

    const theirsAtMine = await setHours(OWN, null, otherManager, SALON);
    expect(theirsAtMine.status).toBe(403);

    expect(await stored(FOREIGN)).toBeNull();
    expect(await stored(OWN)).toEqual(OWN_HOURS);
  });

  it('a rename still audits as "Branch renamed", byte for byte', async () => {
    const res = await call('PATCH', `/salons/${SALON}/branches/${FOLLOWS}`, manager, { nameAr: 'فرع' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [audit] = await exec(sql`
      SELECT action FROM audit_log WHERE subject_type = 'branch' AND subject_id = ${FOLLOWS}
       ORDER BY id DESC LIMIT 1`);
    expect(audit?.action).toBe('Branch renamed');
  });
});
