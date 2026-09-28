/**
 * A REWARD THE SALON WROTE — custom options on "Attach a reward".   (migration 0064)
 *
 * WHAT THIS PROVES
 *   - perms.marketing off (the seed's ST-002, Hessa) → 403 with the marketing copy
 *     on GET, POST and DELETE of campaign-rewards and on POST campaigns with a
 *     custom reward, and nothing was written; the same GET with the permission on
 *     (ST-001, Noura) answers 200, so the 403 was the gate and not a missing route;
 *     and a till's PIN session is refused on all three whatever its holder may do;
 *   - a saved reward is trimmed, served in exactly four fields, listed oldest
 *     first, and audited;
 *   - the list answers the shared `paginated()` envelope, `{ items, nextCursor:
 *     null }`, and a salon at the cap gets all twenty on that one page — the null
 *     is true because the cap is on saves, not on the read;
 *   - empty, blank and 61-character labels are 400 `invalid_label`, 60 code points
 *     is fine even when `.length` would say 61;
 *   - a case-insensitive duplicate of an active one is 409 `duplicate_reward`,
 *     including two saves racing, and an archived label may be saved again;
 *   - the twenty-first active reward is 409 `reward_limit`;
 *   - DELETE archives, and another salon's id or an already-archived one is 404;
 *   - `reward: 'custom'` takes the LABEL FROM THE SAVED ROW — a label the client
 *     sends is ignored — and refuses another salon's, an archived, or a missing
 *     id with 400 `invalid_custom_reward`, and a customRewardId on a non-custom
 *     reward with 400;
 *   - the snapshot survives archiving, on the merchant list, the console queue and
 *     the decision response; every other campaign carries `customReward: null`;
 *   - the column refuses a custom campaign with no label, stray words on a
 *     non-custom one, and a campaign naming another salon's reward.
 *
 * Its own salons (`CR-…-<run>`) for everything that writes, so the cap and the
 * list are counted from zero and no spec here fills SAL-AMARA's list under
 * another suite. SAL-AMARA is touched only by the 403 probes, which must use the
 * seed's own restricted account, and they clean up the one row they need.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const id = (tag: string) => `CR-${tag}-${RUN}`;

const SALON = id('SALON');
const CAP_SALON = id('CAP');
const OTHER_SALON = id('OTHER');
const SEED_SALON = 'SAL-AMARA';

const MARKETING_COPY = "You don't have permission to submit a campaign. A manager can grant it.";

type Res = { status: number; body: Record<string, any> };

suite('a reward the salon wrote', () => {
  let app: FastifyInstance;
  let db: (typeof import('../db/client'))['db'];
  let sql: (typeof import('drizzle-orm'))['sql'];
  let issue: (typeof import('../auth/sessions'))['issueSession'];
  let manager = '';
  let capManager = '';
  let otherManager = '';
  let noura = '';
  let hessa = '';
  let console_ = '';

  const exec = async (q: unknown) =>
    (await db.execute(q as never)) as unknown as Array<Record<string, unknown>>;

  async function staff(sid: string, salonId: string): Promise<string> {
    await exec(sql`
      INSERT INTO staff_user
        (id, salon_id, name, handle, role, branch_access_all, branch_access_ids,
         password_hash, perm_dashboard, perm_appointments, perm_shop, perm_loyalty,
         perm_team, perm_scanner, perm_charges, perm_void, perm_marketing)
      VALUES (${sid}, ${salonId}, ${`CR ${sid}`}, ${sid.toLowerCase()},
              'manager', true, '{}', 'x', true, true, true, true, true, true, true, true, true)`);
    return (await issue(db, { principalKind: 'staff', staffId: sid, salonId, scope: 'dashboard' }))
      .accessToken;
  }

  const call = async (
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    bearer: string,
    payload?: unknown,
  ): Promise<Res> => {
    const res = await app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${bearer}` },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    return { status: res.statusCode, body: JSON.parse(res.body || '{}') as Record<string, any> };
  };

  const rewardsUrl = (salonId: string) => `/v1/salons/${salonId}/campaign-rewards`;
  const campaignsUrl = (salonId: string) => `/v1/salons/${salonId}/campaigns`;
  const save = (label: unknown, bearer = manager, salonId = SALON) =>
    call('POST', rewardsUrl(salonId), bearer, { label });
  const remove = (rid: string, bearer = manager, salonId = SALON) =>
    call('DELETE', `${rewardsUrl(salonId)}/${rid}`, bearer);
  const list = async (bearer = manager, salonId = SALON) => {
    const res = await call('GET', rewardsUrl(salonId), bearer);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.items as Array<Record<string, any>>;
  };
  const submit = (extra: Record<string, unknown>, bearer = manager, salonId = SALON) =>
    call('POST', campaignsUrl(salonId), bearer, {
      title: `CR campaign ${randomUUID().slice(0, 6)}`,
      body: 'Come in this week.',
      channel: 'push',
      audience: 'all',
      when: 'now',
      ...extra,
    });
  const campaignRow = async (cid: string) =>
    (await exec(sql`
      SELECT reward, custom_reward_id, custom_reward_label FROM campaign WHERE id = ${cid}`))[0];
  const rewardCount = async (salonId: string) =>
    Number((await exec(sql`SELECT count(*)::int AS n FROM campaign_reward WHERE salon_id = ${salonId}`))[0]?.n);
  const campaignCount = async (salonId: string) =>
    Number((await exec(sql`SELECT count(*)::int AS n FROM campaign WHERE salon_id = ${salonId}`))[0]?.n);

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    sql = (await import('drizzle-orm')).sql;
    issue = (await import('../auth/sessions')).issueSession;
    app = await (await import('../app')).buildApp();

    for (const [sid, name] of [
      [SALON, 'CR Salon'],
      [CAP_SALON, 'CR Cap'],
      [OTHER_SALON, 'CR Other'],
    ] as const) {
      await exec(sql`
        INSERT INTO salon (id, name, brand_color, loyalty_mode, stamp_target, stamp_reward,
                           deposit_fils, business_hours)
        VALUES (${sid}, ${`${name} ${RUN}`}, '#7A5C8E', 'stamps', 6, 'free blow-dry', 5000,
                ${JSON.stringify({ morning: ['10:00', '13:00'], evening: ['16:00', '22:00'] })}::jsonb)`);
    }
    manager = await staff(id('ST-MGR'), SALON);
    capManager = await staff(id('ST-CAP'), CAP_SALON);
    otherManager = await staff(id('ST-OTHER'), OTHER_SALON);

    // The seed's own accounts: Noura holds every permission, Hessa has marketing off.
    noura = (
      await issue(db, { principalKind: 'staff', staffId: 'ST-001', salonId: SEED_SALON, scope: 'dashboard' })
    ).accessToken;
    hessa = (
      await issue(db, { principalKind: 'staff', staffId: 'ST-002', salonId: SEED_SALON, scope: 'dashboard' })
    ).accessToken;
    console_ = (
      await issue(db, { principalKind: 'platform_admin', platformAdminId: 'PLT-001', salonId: null, scope: 'platform' })
    ).accessToken;

    const [h] = await exec(sql`SELECT perm_marketing FROM staff_user WHERE id = 'ST-002'`);
    expect(h?.perm_marketing, 'the seed must keep ST-002 with perms.marketing off').toBe(false);
  });

  afterAll(async () => {
    await app?.close();
  });

  // ------------------------------------------------------------- #7 --

  describe('perms.marketing off — the seed’s ST-002, called directly', () => {
    let seedReward = '';

    beforeAll(async () => {
      const made = await save(`CR probe ${RUN}`, noura, SEED_SALON);
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      seedReward = made.body.id;
    });

    afterAll(async () => {
      // Leave SAL-AMARA's list as it was found. Archived rather than deleted —
      // the route's own verb, and the row is inert once archived.
      if (seedReward) await remove(seedReward, noura, SEED_SALON);
    });

    const refused = (res: Res) => {
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error).toBe('forbidden');
      expect(res.body.message).toBe(MARKETING_COPY);
    };

    it('GET campaign-rewards is 403, and the same call with the permission on is 200', async () => {
      refused(await call('GET', rewardsUrl(SEED_SALON), hessa));
      const mirror = await call('GET', rewardsUrl(SEED_SALON), noura);
      expect(mirror.status).toBe(200);
      expect(mirror.body.items.map((r: any) => r.id)).toContain(seedReward);
    });

    it('POST campaign-rewards is 403 and saves nothing', async () => {
      const before = await rewardCount(SEED_SALON);
      refused(await save(`CR hessa ${RUN}`, hessa, SEED_SALON));
      expect(await rewardCount(SEED_SALON)).toBe(before);
    });

    it('DELETE campaign-rewards is 403 and the reward stays on the list', async () => {
      refused(await remove(seedReward, hessa, SEED_SALON));
      const [row] = await exec(sql`SELECT archived_at FROM campaign_reward WHERE id = ${seedReward}`);
      expect(row?.archived_at).toBeNull();
    });

    it('a PIN session is refused on all three, even for a manager holding perms.marketing', async () => {
      // `requireDashboardPerm` checks the SURFACE before the permission: a till's
      // PIN session never reaches a dashboard endpoint, whatever its holder may do.
      const till = (
        await issue(db, {
          principalKind: 'staff',
          staffId: id('ST-MGR'),
          salonId: SALON,
          scope: 'scanner',
          deviceId: `DEV-CR-${RUN}`,
        })
      ).accessToken;
      const before = await rewardCount(SALON);
      const own = await save(`CR till probe ${RUN}`);
      expect(own.status).toBe(201);
      expect((await call('GET', rewardsUrl(SALON), till)).status).toBe(403);
      expect((await save(`CR till ${RUN}`, till)).status).toBe(403);
      expect((await remove(own.body.id, till)).status).toBe(403);
      expect(await rewardCount(SALON)).toBe(before + 1);
      const [row] = await exec(sql`SELECT archived_at FROM campaign_reward WHERE id = ${own.body.id}`);
      expect(row?.archived_at).toBeNull();
      expect((await remove(own.body.id)).status).toBe(204);
    });

    it('POST campaigns with a custom reward is 403 and submits nothing', async () => {
      const before = await campaignCount(SEED_SALON);
      refused(await submit({ reward: 'custom', customRewardId: seedReward }, hessa, SEED_SALON));
      expect(await campaignCount(SEED_SALON)).toBe(before);
    });
  });

  // ----------------------------------------------------------- the list --

  it('saves a trimmed label, answers exactly four fields, and audits it', async () => {
    const res = await save('   Free hair mask with any blow-dry   ');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(['createdAt', 'id', 'label', 'salonId']);
    expect(res.body).toMatchObject({ salonId: SALON, label: 'Free hair mask with any blow-dry' });
    expect(res.body.id).toMatch(/^CRW-\d+$/);
    expect(Number.isNaN(Date.parse(res.body.createdAt))).toBe(false);

    const [audit] = await exec(sql`
      SELECT action, kind, source, metadata FROM audit_log
       WHERE subject_type = 'campaign_reward' AND subject_id = ${res.body.id}`);
    expect(audit).toMatchObject({ action: 'Campaign reward added', kind: 'rules', source: 'merchant' });
    expect((audit?.metadata as any).label).toBe('Free hair mask with any blow-dry');
  });

  it('lists active rewards only, oldest first, and only this salon’s', async () => {
    const a = await save(`Order A ${RUN}`);
    const b = await save(`Order B ${RUN}`);
    const gone = await save(`Order gone ${RUN}`);
    await save(`Not mine ${RUN}`, otherManager, OTHER_SALON);
    expect((await remove(gone.body.id)).status).toBe(204);

    const items = await list();
    const ids = items.map((r) => r.id);
    expect(ids).toContain(a.body.id);
    expect(ids.indexOf(a.body.id)).toBeLessThan(ids.indexOf(b.body.id));
    expect(ids).not.toContain(gone.body.id);
    expect(items.every((r) => r.salonId === SALON)).toBe(true);
    const created = items.map((r) => Date.parse(r.createdAt));
    expect(created).toEqual([...created].sort((x, y) => x - y));
  });

  it('answers the paginated envelope — items and nextCursor: null, nothing else', async () => {
    await save(`Envelope ${RUN}`);
    const res = await call('GET', rewardsUrl(SALON), manager);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['items', 'nextCursor']);
    expect(res.body.nextCursor).toBeNull();
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  it('refuses empty, blank, non-string and 61-character labels with invalid_label', async () => {
    for (const bad of ['', '    ', 42, null, 'x'.repeat(61), ` ${'y'.repeat(61)} `]) {
      const res = await save(bad);
      expect(res.status, `${JSON.stringify(bad)} → ${JSON.stringify(res.body)}`).toBe(400);
      expect(res.body.error).toBe('invalid_label');
    }
    const missing = await call('POST', rewardsUrl(SALON), manager, {});
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe('invalid_label');
  });

  it('takes 60 characters, counted as the column counts them', async () => {
    const sixty = await save(`${RUN}`.padEnd(60, 'z'));
    expect(sixty.status, JSON.stringify(sixty.body)).toBe(201);
    // 59 letters and one emoji: 60 code points, 61 UTF-16 units.
    const emoji = `${'q'.repeat(59)}💆`;
    expect(emoji.length).toBe(61);
    const res = await save(emoji);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.label).toBe(emoji);
  });

  it('refuses a case-insensitive duplicate of an active one, and allows it again once archived', async () => {
    const first = await save(`Free Nail Art ${RUN}`);
    expect(first.status).toBe(201);
    const dup = await save(`  free nail ART ${RUN} `);
    expect(dup.status, JSON.stringify(dup.body)).toBe(409);
    expect(dup.body.error).toBe('duplicate_reward');

    // Another salon's list is its own.
    expect((await save(`Free Nail Art ${RUN}`, otherManager, OTHER_SALON)).status).toBe(201);

    expect((await remove(first.body.id)).status).toBe(204);
    const again = await save(`FREE NAIL ART ${RUN}`);
    expect(again.status, JSON.stringify(again.body)).toBe(201);
  });

  it('two saves of the same words at once: one row, one 409', async () => {
    const label = `Race ${RUN}`;
    const results = await Promise.all([save(label), save(label.toUpperCase()), save(label)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.error === 'duplicate_reward')).toBe(true);
    const [row] = await exec(sql`
      SELECT count(*)::int AS n FROM campaign_reward
       WHERE salon_id = ${SALON} AND lower(label) = lower(${label}) AND archived_at IS NULL`);
    expect(row?.n).toBe(1);
  });

  it('caps a salon at twenty active rewards with reward_limit, counting only active ones', async () => {
    const made: string[] = [];
    for (let i = 1; i <= 20; i++) {
      const res = await save(`Cap ${i}`, capManager, CAP_SALON);
      expect(res.status, `reward ${i}: ${JSON.stringify(res.body)}`).toBe(201);
      made.push(res.body.id);
    }
    const over = await save('Cap 21', capManager, CAP_SALON);
    expect(over.status, JSON.stringify(over.body)).toBe(409);
    expect(over.body.error).toBe('reward_limit');
    expect(await rewardCount(CAP_SALON)).toBe(20);

    // Racing past the cap does not work either.
    expect((await remove(made[0]!, capManager, CAP_SALON)).status).toBe(204);
    const race = await Promise.all(
      ['Cap 21', 'Cap 22', 'Cap 23'].map((l) => save(l, capManager, CAP_SALON)),
    );
    expect(race.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(race.filter((r) => r.status === 409).every((r) => r.body.error === 'reward_limit')).toBe(true);
    const [active] = await exec(sql`
      SELECT count(*)::int AS n FROM campaign_reward WHERE salon_id = ${CAP_SALON} AND archived_at IS NULL`);
    expect(active?.n).toBe(20);

    // At the cap the list is still one page: all twenty, and no cursor to follow.
    const full = await call('GET', rewardsUrl(CAP_SALON), capManager);
    expect(full.status, JSON.stringify(full.body)).toBe(200);
    expect(full.body.items).toHaveLength(20);
    expect(full.body.nextCursor).toBeNull();
  });

  it('DELETE archives, audits, and is 404 for another salon’s id, an archived one, or none', async () => {
    const mine = await save(`To remove ${RUN}`);
    const theirs = await save(`Theirs ${RUN}`, otherManager, OTHER_SALON);

    const foreign = await remove(theirs.body.id);
    expect(foreign.status, JSON.stringify(foreign.body)).toBe(404);
    expect(foreign.body.error).toBe('unknown_reward');
    const [t] = await exec(sql`SELECT archived_at FROM campaign_reward WHERE id = ${theirs.body.id}`);
    expect(t?.archived_at).toBeNull();

    // Under their path with my session is the tenancy wall, not a lookup.
    expect((await remove(theirs.body.id, manager, OTHER_SALON)).status).toBe(403);

    expect((await remove(mine.body.id)).status).toBe(204);
    const [m] = await exec(sql`SELECT archived_at FROM campaign_reward WHERE id = ${mine.body.id}`);
    expect(m?.archived_at).not.toBeNull();
    const [audit] = await exec(sql`
      SELECT action FROM audit_log
       WHERE subject_type = 'campaign_reward' AND subject_id = ${mine.body.id}
       ORDER BY seq DESC LIMIT 1`);
    expect(audit?.action).toBe('Campaign reward removed');

    const twice = await remove(mine.body.id);
    expect(twice.status).toBe(404);
    expect((await remove('CRW-0')).status).toBe(404);
  });

  // --------------------------------------------------------- campaigns --

  describe('a campaign with a custom reward', () => {
    let reward = '';
    const LABEL = `Free scalp massage ${RUN}`;

    beforeAll(async () => {
      const res = await save(LABEL);
      expect(res.status).toBe(201);
      reward = res.body.id;
    });

    it('takes the label from the saved row and ignores any label the client sends', async () => {
      const res = await submit({
        reward: 'custom',
        customRewardId: reward,
        customReward: 'A free car',
        customRewardLabel: 'A free car',
        label: 'A free car',
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject({ reward: 'custom', customReward: LABEL, status: 'pending' });
      expect(await campaignRow(res.body.id)).toEqual({
        reward: 'custom',
        custom_reward_id: reward,
        custom_reward_label: LABEL,
      });
      const [audit] = await exec(sql`
        SELECT metadata FROM audit_log WHERE subject_type = 'campaign' AND subject_id = ${res.body.id}`);
      expect(audit?.metadata).toMatchObject({ reward: 'custom', customRewardId: reward, customReward: LABEL });
    });

    it('refuses another salon’s reward id with invalid_custom_reward, and submits nothing', async () => {
      const theirs = await save(`Their perk ${RUN}`, otherManager, OTHER_SALON);
      const before = await campaignCount(SALON);
      const res = await submit({ reward: 'custom', customRewardId: theirs.body.id });
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body.error).toBe('invalid_custom_reward');
      expect(await campaignCount(SALON)).toBe(before);
    });

    it('refuses a missing, blank, unknown or archived id with invalid_custom_reward', async () => {
      const archived = await save(`Archived perk ${RUN}`);
      await remove(archived.body.id);
      for (const customRewardId of [undefined, null, '', '   ', 7, 'CRW-0', archived.body.id]) {
        const res = await submit({ reward: 'custom', customRewardId });
        expect(res.status, `${JSON.stringify(customRewardId)} → ${JSON.stringify(res.body)}`).toBe(400);
        expect(res.body.error).toBe('invalid_custom_reward');
      }
    });

    it('refuses a customRewardId on a reward that is not custom', async () => {
      for (const r of ['none', 'x2stamp']) {
        const res = await submit({ reward: r, customRewardId: reward });
        expect(res.status, JSON.stringify(res.body)).toBe(400);
        expect(res.body.error).toBe('custom_reward_not_allowed');
      }
    });

    it('carries customReward: null on every campaign that is not custom', async () => {
      for (const r of ['none', 'x2stamp']) {
        const res = await submit({ reward: r });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect(res.body).toHaveProperty('customReward', null);
        expect(await campaignRow(res.body.id)).toMatchObject({ custom_reward_id: null, custom_reward_label: null });
      }
      const noReward = await submit({});
      expect(noReward.body).toMatchObject({ reward: 'none', customReward: null });

      const mine = await call('GET', campaignsUrl(SALON), manager);
      expect(mine.status).toBe(200);
      for (const c of mine.body.items) expect(c).toHaveProperty('customReward');
      expect(mine.body.items.filter((c: any) => c.reward !== 'custom').every((c: any) => c.customReward === null)).toBe(true);
    });

    it('keeps its snapshot after the reward is removed — merchant list, console queue, decision', async () => {
      const own = await save(`Snapshot perk ${RUN}`);
      const sent = await submit({ reward: 'custom', customRewardId: own.body.id });
      expect(sent.status).toBe(201);
      const cid = sent.body.id as string;

      expect((await remove(own.body.id)).status).toBe(204);
      expect((await list()).map((r) => r.id)).not.toContain(own.body.id);

      const mine = await call('GET', campaignsUrl(SALON), manager);
      expect(mine.body.items.find((c: any) => c.id === cid)).toMatchObject({
        reward: 'custom',
        customReward: `Snapshot perk ${RUN}`,
        status: 'pending',
      });

      const queue = await call('GET', '/v1/platform/campaigns', console_);
      expect(queue.status, JSON.stringify(queue.body)).toBe(200);
      for (const c of queue.body.items) expect(c).toHaveProperty('customReward');
      expect(queue.body.items.find((c: any) => c.id === cid)).toMatchObject({
        customReward: `Snapshot perk ${RUN}`,
      });

      const decided = await call('POST', `/v1/platform/campaigns/${cid}/decision`, console_, {
        status: 'rejected',
        note: 'CR spec — rejected to read the decision response.',
      });
      expect(decided.status, JSON.stringify(decided.body)).toBe(200);
      expect(decided.body.campaign).toMatchObject({
        id: cid,
        status: 'rejected',
        reward: 'custom',
        customReward: `Snapshot perk ${RUN}`,
      });
    });
  });

  // ------------------------------------------------------------ the column --

  describe('the column, with no route in the way', () => {
    const rawInsert = (cid: string, reward: string, rewardId: string | null, label: string | null, salonId = SALON) =>
      exec(sql`
        INSERT INTO campaign (id, salon_id, title, body, channel, audience, reward,
                              custom_reward_id, custom_reward_label, send_when, status, submitted_by)
        VALUES (${cid}, ${salonId}, 'CR raw', 'CR raw', 'push', 'all', ${reward},
                ${rewardId}, ${label}, 'now', 'pending', 'CR spec')`);
    const refusal = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (err) {
        const e = err as { code?: string; constraint_name?: string; message?: string; cause?: any };
        return {
          code: e.code ?? e.cause?.code,
          constraint: e.constraint_name ?? e.cause?.constraint_name,
          message: e.message,
        };
      }
      return null;
    };

    it('refuses a custom campaign with no label', async () => {
      const own = await save(`Raw perk ${RUN}`);
      const r = await refusal(rawInsert(id('CMP-NOLABEL'), 'custom', own.body.id, null));
      expect(r, 'the insert was accepted').not.toBeNull();
      expect(r).toMatchObject({ code: '23514', constraint: 'campaign_custom_reward_is_labelled' });
    });

    it('refuses words on a campaign that is not custom, and an id without custom', async () => {
      const own = await save(`Raw perk two ${RUN}`);
      expect(await refusal(rawInsert(id('CMP-STRAY'), 'none', null, 'Stray words'))).toMatchObject({
        code: '23514',
        constraint: 'campaign_custom_reward_is_labelled',
      });
      expect(await refusal(rawInsert(id('CMP-IDONLY'), 'none', own.body.id, null))).toMatchObject({
        code: '23514',
        constraint: 'campaign_custom_reward_id_requires_custom',
      });
    });

    it('refuses a campaign naming another salon’s reward', async () => {
      const theirs = await save(`Raw foreign ${RUN}`, otherManager, OTHER_SALON);
      expect(
        await refusal(rawInsert(id('CMP-FOREIGN'), 'custom', theirs.body.id, 'Raw foreign')),
      ).toMatchObject({ code: '23503', constraint: 'campaign_custom_reward_same_salon_fk' });
    });

    it('refuses an untrimmed or over-long label on the list itself', async () => {
      const ins = (rid: string, label: string) =>
        exec(sql`
          INSERT INTO campaign_reward (id, salon_id, label, created_by)
          VALUES (${rid}, ${SALON}, ${label}, 'CR spec')`);
      expect(await refusal(ins(id('CRW-PAD'), ' padded '))).toMatchObject({
        constraint: 'campaign_reward_label_is_trimmed',
      });
      expect(await refusal(ins(id('CRW-LONG'), 'l'.repeat(61)))).toMatchObject({
        constraint: 'campaign_reward_label_length',
      });
      expect(await refusal(ins(id('CRW-EMPTY'), ''))).toMatchObject({
        constraint: 'campaign_reward_label_length',
      });
    });
  });
});
