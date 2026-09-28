/**
 * WHAT THE VISIT EARNED — recorded on the charge, sent on the response, served on
 * her activity, and taken back by a void exactly.   (migration 0065)
 *
 * DECISIONS.md § "The fourth list": show what she gained after each scan. That
 * needs the increment, and before 0065 nothing stored it. The void needed it too
 * and did not have it: it took one visit off every charge, so a doubled visit
 * lost one of its two and a stamp card lost a visit it was never given and kept
 * the stamps. Every assertion below is about a ROW — `member.visits`,
 * `member.stamps`, `member.tier`, the charge's own columns — which is why this is
 * an int spec and not a unit one (`services/loyalty.test.ts` has the pure rules).
 *
 * ITS OWN SALONS, NOT AMARA. A doubled visit needs a boost that pays, and at
 * two-branch Amara a boost pays only at an enrolled till, while `HH-01` pays 2x
 * to every charge six hours a week (`devices.int.test.ts` § suppressed tells
 * that story). A SINGLE-branch salon's branch is established (services/branch.ts),
 * so a boost row there pays deterministically, and no happy hour exists at any
 * salon this file creates. So "+2" here is the boost and nothing else, at every
 * hour of the week.
 *
 *   LY-T1  tiers, one branch, no boost          → +1
 *   LY-T2  tiers, one branch, boost visit = 2   → +2
 *   LY-S   stamps (target 3), boost stamp = 2   → +2 stamps
 *
 * IDS ARE `LY-`, for the reason `devices.int.test.ts` gives for `EN-`: other
 * suites clean up by `IT-` prefix, and these members cannot be deleted (their
 * charges wrote append-only ledger rows, `ON DELETE restrict`). Per-run and inert.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const T1 = `LY-T1-${RUN}`;
const T2 = `LY-T2-${RUN}`;
const S = `LY-S-${RUN}`;
const branchOf = (salonId: string) => `${salonId}-BR`;
const staffOf = (salonId: string) => `${salonId}-ST`;

type Json = Record<string, any>;

suite('a charge records what it earned, and a void takes back exactly that', () => {
  let app: FastifyInstance;
  let db: (typeof import('../db/client'))['db'];
  let sql: (typeof import('drizzle-orm'))['sql'];
  let issue: (typeof import('../auth/sessions'))['issueSession'];

  const exec = async (q: unknown) =>
    (await db.execute(q as never)) as unknown as Array<Record<string, unknown>>;

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    sql = (await import('drizzle-orm')).sql;
    issue = (await import('../auth/sessions')).issueSession;
    app = await (await import('../app')).buildApp();

    const hours = JSON.stringify({ morning: ['10:00', '13:00'], evening: ['16:00', '22:00'] });
    for (const id of [T1, T2]) {
      // Amara's ladder, by subselect: bronze 0 · silver 4 · gold 10 · black 20.
      await exec(sql`
        INSERT INTO salon (id, name, brand_color, loyalty_mode, tiers, deposit_fils, business_hours,
                           module_booking, module_shop, timezone)
        VALUES (${id}, ${`LY ${id}`}, '#7A5C8E', 'tiers',
                (SELECT tiers FROM salon WHERE id = 'SAL-AMARA'), 2000, ${hours}::jsonb,
                false, false, 'Asia/Kuwait')`);
    }
    await exec(sql`
      INSERT INTO salon (id, name, brand_color, loyalty_mode, stamp_target, stamp_reward, deposit_fils,
                         business_hours, module_booking, module_shop, timezone)
      VALUES (${S}, ${`LY ${S}`}, '#7A5C8E', 'stamps', 3, 'free blow-dry', 2000,
              ${hours}::jsonb, false, false, 'Asia/Kuwait')`);

    for (const id of [T1, T2, S]) {
      await exec(sql`INSERT INTO branch (id, salon_id, name) VALUES (${branchOf(id)}, ${id}, 'LY Branch')`);
      await exec(sql`
        INSERT INTO staff_user
          (id, salon_id, name, handle, role, branch_access_all, branch_access_ids, password_hash,
           perm_dashboard, perm_appointments, perm_shop, perm_loyalty, perm_team, perm_scanner,
           perm_charges, perm_void, perm_marketing)
        VALUES (${staffOf(id)}, ${id}, 'LY Manager', ${`ly-${RUN}-${id.slice(3, 5).toLowerCase()}`},
                'manager', true, '{}', 'x', true, true, true, true, true, true, true, true, true)`);
    }
    // The two boosts. Single-branch salons, so both are established and both pay.
    await exec(sql`
      INSERT INTO boost (salon_id, branch_id, visit, topup, stamp, published_by)
      VALUES (${T2}, ${branchOf(T2)}, 2, 0, 1, 'LY'), (${S}, ${branchOf(S)}, 1, 0, 2, 'LY')`);
  });

  afterAll(async () => {
    if (db && sql) {
      // Sessions and staff can go; salons, branches, members and their money stay
      // (append-only ledger, restrict FKs). Inert, per-run, `LY-`.
      await exec(sql`DELETE FROM session WHERE salon_id IN (${T1}, ${T2}, ${S})`);
    }
    await app?.close();
  });

  // ------------------------------------------------------------- fixtures --

  async function customer(
    salonId: string,
    start: { visits?: number; tier?: string | null; stamps?: number | null } = {},
  ): Promise<string> {
    const id = `LY-M-${randomUUID().slice(0, 12)}`;
    const stampsMode = salonId === S;
    await exec(sql`
      INSERT INTO member (id, salon_id, name, phone, password_hash, balance_fils, visits, tier,
                          stamps, policy_version)
      VALUES (${id}, ${salonId}, 'LY Customer',
              ${`+9656${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`}, 'x', 500000,
              ${start.visits ?? 0},
              ${stampsMode ? null : (start.tier === undefined ? 'bronze' : start.tier)},
              ${stampsMode ? (start.stamps ?? 0) : null}, 1)`);
    return id;
  }

  /** A fresh device per request, so the till budget is never what a spec measures. */
  async function till(salonId: string): Promise<string> {
    return (
      await issue(db, {
        principalKind: 'staff',
        staffId: staffOf(salonId),
        salonId,
        scope: 'scanner',
        deviceId: `LY-DEV-${randomUUID()}`,
      })
    ).accessToken;
  }

  async function charge(salonId: string, memberId: string): Promise<Json> {
    const res = await app.inject({
      method: 'POST',
      url: '/charges',
      headers: {
        authorization: `Bearer ${await till(salonId)}`,
        'idempotency-key': `ly-charge-${randomUUID()}`,
      },
      // A typed price, so these salons need no service menu. It earns loyalty
      // like any charge (charge.ts § 9 does not branch on pricing source).
      payload: { memberId, amountFils: 5000, reason: 'LY loyalty spec', confirmDuplicate: true },
    });
    expect(res.statusCode, res.body).toBe(200);
    return JSON.parse(res.body) as Json;
  }

  async function voidOf(salonId: string, transactionId: string, key = randomUUID()) {
    const res = await app.inject({
      method: 'POST',
      url: '/voids',
      headers: {
        authorization: `Bearer ${await till(salonId)}`,
        'idempotency-key': `ly-void-${key}`,
      },
      payload: { transactionId, reason: 'Wrong amount or service', reasonCode: 'wrong' },
    });
    return { status: res.statusCode, body: JSON.parse(res.body) as Json };
  }

  async function card(memberId: string) {
    const [r] = await exec(sql`SELECT visits, tier::text AS tier, stamps FROM member WHERE id = ${memberId}`);
    return {
      visits: Number(r?.visits),
      tier: (r?.tier ?? null) as string | null,
      stamps: r?.stamps == null ? null : Number(r.stamps),
    };
  }

  async function recordOf(txId: string) {
    const [r] = await exec(sql`
      SELECT loyalty_mode::text AS mode, loyalty_visits_earned AS v, loyalty_stamps_earned AS s,
             loyalty_tier_after::text AS tier, loyalty_climbed AS climbed,
             loyalty_reward_ready AS ready
        FROM "transaction" WHERE id = ${txId}`);
    return {
      mode: r?.mode ?? null,
      visitsEarned: r?.v == null ? null : Number(r.v),
      stampsEarned: r?.s == null ? null : Number(r.s),
      tierAfter: r?.tier ?? null,
      climbed: r?.climbed ?? null,
      rewardReady: r?.ready ?? null,
    };
  }

  /** What an API from before 0065 wrote: the same charge with no record at all. */
  async function eraseRecord(txId: string) {
    await exec(sql`
      UPDATE "transaction"
         SET loyalty_mode = NULL, loyalty_visits_earned = NULL, loyalty_stamps_earned = NULL,
             loyalty_tier_after = NULL, loyalty_climbed = NULL, loyalty_reward_ready = NULL
       WHERE id = ${txId}`);
  }

  async function feedOf(memberId: string, salonId: string): Promise<Json[]> {
    const bearer = (
      await issue(db, { principalKind: 'member', memberId, salonId, scope: 'wallet' })
    ).accessToken;
    const res = await app.inject({
      method: 'GET',
      url: '/members/me/transactions',
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    return (JSON.parse(res.body) as { items: Json[] }).items;
  }

  // ============================================================ the record ==

  describe('the charge records what it earned, and says so', () => {
    it('a normal charge records +1 — on the row, on the response, on the response’s transaction', async () => {
      const m = await customer(T1, { visits: 1, tier: 'bronze' });
      const out = await charge(T1, m);
      const txId = out.transaction.id as string;

      expect(await recordOf(txId)).toEqual({
        mode: 'tiers',
        visitsEarned: 1,
        stampsEarned: null,
        tierAfter: 'bronze',
        climbed: false,
        rewardReady: false,
      });
      expect(out.loyalty).toMatchObject({ mode: 'tiers', visits: 2, visitsEarned: 1, climbed: false });
      expect(out.loyalty).not.toHaveProperty('stampsEarned');
      expect(out.transaction.loyalty).toEqual({
        mode: 'tiers',
        visitsEarned: 1,
        tierAfter: 'bronze',
        climbed: false,
        rewardReady: false,
      });
      expect((await card(m)).visits).toBe(2);
    });

    it('a branch-boosted charge records +2 — the increment APPLIED, multiplier included', async () => {
      const m = await customer(T2, { visits: 0 });
      const out = await charge(T2, m);

      expect(out.happyHour, 'the boost is the only multiplier in play here').toBeNull();
      expect(out.loyalty.visitsEarned).toBe(2);
      expect((await recordOf(out.transaction.id)).visitsEarned).toBe(2);
      expect((await card(m)).visits).toBe(2);
    });

    it('a stamps-mode charge records its stamps, and no visit', async () => {
      const m = await customer(S, { stamps: 0 });
      const out = await charge(S, m);

      expect(await recordOf(out.transaction.id)).toEqual({
        mode: 'stamps',
        visitsEarned: null,
        stampsEarned: 2,
        tierAfter: null,
        climbed: false,
        rewardReady: false,
      });
      expect(out.loyalty).toEqual({ mode: 'stamps', stamps: 2, target: 3, rewardReady: false, stampsEarned: 2 });
      expect(out.transaction.loyalty).toEqual({
        mode: 'stamps',
        stampsEarned: 2,
        tierAfter: null,
        climbed: false,
        rewardReady: false,
      });
      expect(await card(m)).toEqual({ visits: 0, tier: null, stamps: 2 });

      // The charge that fills the card records it as the response states it.
      const full = await charge(S, m);
      expect(full.loyalty).toMatchObject({ stamps: 4, rewardReady: true, stampsEarned: 2 });
      expect((await recordOf(full.transaction.id)).rewardReady).toBe(true);
    });

    it('a climb is recorded with the rung it reached', async () => {
      const m = await customer(T2, { visits: 3, tier: 'bronze' });
      const out = await charge(T2, m);
      expect(await recordOf(out.transaction.id)).toMatchObject({
        visitsEarned: 2,
        tierAfter: 'silver',
        climbed: true,
      });
      expect(out.transaction.loyalty).toMatchObject({ tierAfter: 'silver', climbed: true });
    });
  });

  // ============================================================== the feed ==

  describe('GET /members/me/transactions carries it', () => {
    it('loyalty on a charge; null on a top-up, on the void, and on a pre-0065 charge', async () => {
      const m = await customer(T2, { visits: 0 });
      const boosted = await charge(T2, m);
      const old = await charge(T2, m);
      await eraseRecord(old.transaction.id);
      const voided = await charge(T2, m);
      const v = await voidOf(T2, voided.transaction.id);
      expect(v.status, JSON.stringify(v.body)).toBe(200);

      // A settled top-up, written as the row a top-up writes. The feed is a read of
      // `transaction`, so the row is the whole of what the serialiser sees.
      const topupId = `LY-TX-${randomUUID().slice(0, 12)}`;
      await exec(sql`
        INSERT INTO "transaction" (id, member_id, salon_id, branch_id, kind, amount_fils, method,
                                   status, reference, created_at, settled_at)
        VALUES (${topupId}, ${m}, ${T2}, ${branchOf(T2)}, 'topup', 10000, 'knet', 'settled',
                ${`AVO-TOP-LY-${RUN}`}, now(), now())`);

      const items = await feedOf(m, T2);
      const byId = new Map(items.map((i) => [i.id as string, i]));

      // Every row carries the key, present — `.nullable()` is required on the wire.
      for (const i of items) expect(i, `row ${i.id}`).toHaveProperty('loyalty');

      expect(byId.get(boosted.transaction.id)?.loyalty).toEqual({
        mode: 'tiers',
        visitsEarned: 2,
        tierAfter: 'bronze',
        climbed: false,
        rewardReady: false,
      });
      expect(byId.get(topupId)?.loyalty).toBeNull();
      expect(byId.get(old.transaction.id)?.loyalty, 'a charge with no record is null, not a guessed +1').toBeNull();
      const reversal = items.find((i) => i.kind === 'adjustment');
      expect(reversal?.loyalty).toBeNull();
      // The voided charge still says what it earned; `voidedAt` says it was undone.
      expect(byId.get(voided.transaction.id)?.loyalty).toMatchObject({ visitsEarned: 2 });
      expect(byId.get(voided.transaction.id)?.voidedAt).not.toBeNull();
    });

    it('GET /charges rows carry it too — the till parses them with TransactionSchema', async () => {
      const m = await customer(T1);
      const out = await charge(T1, m);
      const res = await app.inject({
        method: 'GET',
        url: '/charges',
        headers: { authorization: `Bearer ${await till(T1)}` },
      });
      expect(res.statusCode, res.body).toBe(200);
      const row = (JSON.parse(res.body).items as Json[]).find((i) => i.id === out.transaction.id);
      expect(row?.loyalty).toEqual(out.transaction.loyalty);
    });
  });

  // ============================================================== the void ==

  describe('a void takes back exactly what the charge earned', () => {
    it('a void of the doubled charge removes 2', async () => {
      const m = await customer(T2, { visits: 0 });
      const out = await charge(T2, m);
      expect((await card(m)).visits).toBe(2);

      const v = await voidOf(T2, out.transaction.id);
      expect(v.status, JSON.stringify(v.body)).toBe(200);
      expect((await card(m)).visits).toBe(0);
      expect(v.body.visitRemoved).toBe(true);
      expect(v.body.loyalty).toEqual({ mode: 'tiers', visitsRemoved: 2, tierAfter: 'bronze', recorded: true });
    });

    it('a stamps void removes the stamps and not a visit', async () => {
      const m = await customer(S, { stamps: 1 });
      // A visit count from before the salon ran stamps: the void must not touch it.
      await exec(sql`UPDATE member SET visits = 3 WHERE id = ${m}`);
      const out = await charge(S, m);
      expect(await card(m)).toEqual({ visits: 3, tier: null, stamps: 3 });

      const v = await voidOf(S, out.transaction.id);
      expect(v.status, JSON.stringify(v.body)).toBe(200);
      expect(await card(m)).toEqual({ visits: 3, tier: null, stamps: 1 });
      expect(v.body.visitRemoved).toBe(false);
      expect(v.body.loyalty).toEqual({ mode: 'stamps', stampsRemoved: 2, recorded: true });
    });

    it("a void can't go below zero", async () => {
      const m = await customer(T2, { visits: 0 });
      const out = await charge(T2, m);
      // Something lowered the count in between; the refund must still go through.
      await exec(sql`UPDATE member SET visits = 1 WHERE id = ${m}`);

      const v = await voidOf(T2, out.transaction.id);
      expect(v.status, JSON.stringify(v.body)).toBe(200);
      expect((await card(m)).visits).toBe(0);
      expect(v.body.loyalty.visitsRemoved).toBe(1);
      expect(v.body.refundedFils).toBe(5000);
    });

    it('a pre-0065 charge uses the fallback: one visit in tiers mode', async () => {
      const m = await customer(T2, { visits: 0 });
      const out = await charge(T2, m); // earned 2
      await eraseRecord(out.transaction.id);

      const v = await voidOf(T2, out.transaction.id);
      expect(v.status, JSON.stringify(v.body)).toBe(200);
      expect((await card(m)).visits, 'the old arithmetic, and no more — nothing is guessed').toBe(1);
      expect(v.body.loyalty).toMatchObject({ mode: 'tiers', visitsRemoved: 1, recorded: false });
    });

    it('a pre-0065 charge in stamps mode takes one stamp and no visit', async () => {
      const m = await customer(S, { stamps: 0 });
      await exec(sql`UPDATE member SET visits = 3 WHERE id = ${m}`);
      const out = await charge(S, m); // earned 2
      await eraseRecord(out.transaction.id);

      const v = await voidOf(S, out.transaction.id);
      expect(v.status, JSON.stringify(v.body)).toBe(200);
      expect(await card(m)).toEqual({ visits: 3, tier: null, stamps: 1 });
      expect(v.body.loyalty).toEqual({ mode: 'stamps', stampsRemoved: 1, recorded: false });
    });

    it('a double-submitted void applies once — same key replays, a second key is refused', async () => {
      const m = await customer(T2, { visits: 0 });
      const out = await charge(T2, m);
      const key = randomUUID();

      const [a, b] = await Promise.all([
        voidOf(T2, out.transaction.id, key),
        voidOf(T2, out.transaction.id, key),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(a.body).toEqual(b.body);
      expect((await card(m)).visits).toBe(0);

      const again = await voidOf(T2, out.transaction.id, key);
      expect(again.status).toBe(200);
      expect(again.body).toEqual(a.body);

      const other = await voidOf(T2, out.transaction.id);
      expect(other.status).toBe(409);
      expect(other.body.error).toBe('already_voided');

      expect((await card(m)).visits, 'one reversal, whatever the till did').toBe(0);
      const [n] = await exec(
        sql`SELECT count(*)::int AS n FROM "transaction" WHERE reverses_transaction_id = ${out.transaction.id}`,
      );
      expect(n?.n).toBe(1);
    });

    it('the tier is re-evaluated on the ladder: voiding the climb undoes the climb, and says so', async () => {
      const m = await customer(T2, { visits: 3, tier: 'bronze' });
      const out = await charge(T2, m);
      expect(await card(m)).toMatchObject({ visits: 5, tier: 'silver' });

      const v = await voidOf(T2, out.transaction.id);
      expect(v.status, JSON.stringify(v.body)).toBe(200);
      expect(await card(m)).toMatchObject({ visits: 3, tier: 'bronze' });
      expect(v.body.loyalty).toEqual({ mode: 'tiers', visitsRemoved: 2, tierAfter: 'bronze', recorded: true });

      // The move is recorded like the charge's climb was, attributed to the void.
      const events = await exec(sql`
        SELECT kind::text AS kind, from_tier::text AS "from", to_tier::text AS "to", transaction_id AS tx
          FROM loyalty_event WHERE member_id = ${m} ORDER BY seq`);
      const voidId = (
        await exec(sql`SELECT id FROM "transaction" WHERE reverses_transaction_id = ${out.transaction.id}`)
      )[0]?.id;
      expect(events).toEqual([
        { kind: 'tier_climb', from: 'bronze', to: 'silver', tx: out.transaction.id },
        { kind: 'tier_climb', from: 'silver', to: 'bronze', tx: voidId },
      ]);
    });

    it('a void that crosses no threshold leaves the rung and writes no event', async () => {
      const m = await customer(T1, { visits: 6, tier: 'silver' });
      const out = await charge(T1, m);
      const v = await voidOf(T1, out.transaction.id);
      expect(v.status, JSON.stringify(v.body)).toBe(200);
      expect(await card(m)).toMatchObject({ visits: 6, tier: 'silver' });
      const [n] = await exec(sql`SELECT count(*)::int AS n FROM loyalty_event WHERE member_id = ${m}`);
      expect(n?.n).toBe(0);
    });
  });

  // ========================================================== the database ==

  describe('the record is whole or absent, at the column', () => {
    it('refuses a half-written tiers record and a loyalty record on a non-charge', async () => {
      const m = await customer(T1);
      const out = await charge(T1, m);
      await expect(
        exec(sql`UPDATE "transaction" SET loyalty_stamps_earned = 1 WHERE id = ${out.transaction.id}`),
      ).rejects.toThrow(/transaction_loyalty_is_whole/);
      await expect(
        exec(sql`UPDATE "transaction" SET loyalty_visits_earned = -1 WHERE id = ${out.transaction.id}`),
      ).rejects.toThrow(/transaction_loyalty_earned_non_negative/);
      // The void writes an `adjustment` — a row that must never carry a record.
      const v = await voidOf(T1, out.transaction.id);
      expect(v.status).toBe(200);
      const [adj] = await exec(sql`SELECT id FROM "transaction" WHERE reverses_transaction_id = ${out.transaction.id}`);
      await expect(
        exec(sql`
          UPDATE "transaction"
             SET loyalty_mode = 'tiers', loyalty_visits_earned = 1, loyalty_climbed = false,
                 loyalty_reward_ready = false
           WHERE id = ${adj?.id as string}`),
      ).rejects.toThrow(/transaction_loyalty_is_charge_only/);
    });
  });
});
