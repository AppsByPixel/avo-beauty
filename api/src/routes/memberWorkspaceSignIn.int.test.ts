/**
 * One wallet app, and the account decides the workspace — proved against a real
 * database and the real handlers.
 *
 * `POST /auth/member/session` and `POST /auth/member/password-reset/request`
 * without a `salonId` (routes/auth.ts § SIGN-IN WITHOUT A SALON). Everything here
 * is an assertion about rows or about two responses being the SAME, which is why
 * it is not a pure spec:
 *
 *   - the salon-scoped path is byte-for-byte what it was;
 *   - a single-wallet phone signs straight in, and the session row is the one a
 *     salon-scoped sign-in writes;
 *   - several wallets the password opens → 409 `choose_workspace` naming ONLY
 *     those, and no session;
 *   - a miss is the unknown-phone 401, same body and (measured) same cost;
 *   - the phone-wide budget, and its independence from the salon-scoped one;
 *   - erased members are never candidates;
 *   - the reset request answers one body whatever it found.
 *
 * NO SEEDED ACCOUNT'S BUCKET IS SPENT beyond one attempt, for
 * `signInLimit.int.test.ts`'s reason: `avo_app` cannot DELETE `sign_in_attempt`
 * (migration 0039), so a suite that spent Dana's budget would leave it spent for
 * the next run inside the hour. Every other phone is minted here. Reset requests
 * each arrive from a fresh address for the same reason — that budget is keyed on
 * the caller, three per fifteen minutes.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const AMARA = 'SAL-AMARA';
const FOREST = 'SAL-FOREST';
const LUMIERE = 'SAL-LUMIERE';

/**
 * The seed's own development credentials (db/seed.ts `MEMBER_PASSWORD`,
 * `FOREST_MEMBER_PASSWORD`). Development fixtures, not secrets: the seed prints
 * them on every reset.
 */
const DANA = { id: '8842', phone: '+96599124408', password: 'dana-dev-password' };
const MAHA = { id: '8850', phone: '+96599124450', password: 'maha-dev-password' };

const PASSWORD_A = 'the-shared-password-one';
const PASSWORD_B = 'a-different-password-two';

suite('member sign-in without a salon', () => {
  let app: FastifyInstance;
  let db: typeof import('../db/client')['db'];
  let member: typeof import('../db/schema/member')['member'];
  let memberPasswordReset: typeof import('../db/schema/member')['memberPasswordReset'];
  let session: typeof import('../db/schema/session')['session'];
  let signInAttempt: typeof import('../db/schema/session')['signInAttempt'];
  let salon: typeof import('../db/schema/salon')['salon'];
  let auditLog: typeof import('../db/schema/audit')['auditLog'];
  let hashSecret: typeof import('../auth/password')['hashSecret'];
  let limits: typeof import('../services/signInLimit');
  let orm: typeof import('drizzle-orm');

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    ({ member, memberPasswordReset } = await import('../db/schema/member'));
    ({ session, signInAttempt } = await import('../db/schema/session'));
    salon = (await import('../db/schema/salon')).salon;
    auditLog = (await import('../db/schema/audit')).auditLog;
    hashSecret = (await import('../auth/password')).hashSecret;
    limits = await import('../services/signInLimit');
    orm = await import('drizzle-orm');
    app = await (await import('../app')).buildApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  // ------------------------------------------------------------- fixtures --

  function freePhone(): string {
    return `+9656${Math.floor(Math.random() * 10_000_000).toString().padStart(7, '0')}`;
  }

  /** A fresh caller address, so each reset request has its own budget. */
  function freeAddress(): string {
    const o = () => Math.floor(Math.random() * 254) + 1;
    return `10.${o()}.${o()}.${o()}`;
  }

  async function wallet(
    salonId: string,
    phone: string,
    password: string,
    extra: Partial<typeof member.$inferInsert> = {},
  ): Promise<string> {
    const id = `INT-WS-${randomUUID().slice(0, 8)}`;
    await db.insert(member).values({
      id,
      salonId,
      name: `Int Workspace ${id}`,
      phone,
      passwordHash: await hashSecret(password),
      policyVersion: 1,
      ...extra,
    });
    return id;
  }

  const signIn = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/auth/member/session', payload });

  const resetRequest = (payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/auth/member/password-reset/request',
      payload,
      remoteAddress: freeAddress(),
    });

  async function sessionsFor(memberId: string) {
    return db.select().from(session).where(orm.eq(session.memberId, memberId));
  }

  async function attemptsIn(salonId: string | null, phone: string): Promise<number> {
    const [row] = await db
      .select({ n: orm.sql<number>`count(*)::int` })
      .from(signInAttempt)
      .where(
        orm.eq(signInAttempt.identityKey, limits.signInIdentityKey('member', salonId, phone)),
      );
    return row?.n ?? 0;
  }

  // ------------------------------------------------- the salon-scoped path --

  describe('with a salonId: unchanged', () => {
    it('signs in, answers the same four keys, and charges only the (salon, phone) bucket', async () => {
      const phone = freePhone();
      const id = await wallet(AMARA, phone, PASSWORD_A);

      const res = await signIn({ salonId: AMARA, phone, password: PASSWORD_A, deviceId: 'dev-1' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Object.keys(body).sort()).toEqual(['accessToken', 'expiresAt', 'member', 'refreshToken']);
      expect(body.member.id).toBe(id);
      expect(body.member.salonId).toBe(AMARA);
      expect(JSON.stringify(body)).not.toContain('passwordHash');

      const [s] = await sessionsFor(id);
      expect(s).toMatchObject({ principalKind: 'member', salonId: AMARA, scope: 'wallet', deviceId: 'dev-1' });

      expect(await attemptsIn(AMARA, phone)).toBe(1);
      expect(await attemptsIn(null, phone)).toBe(0);
    });

    it('a wrong password and an unknown phone are the same 401 as ever', async () => {
      const phone = freePhone();
      await wallet(AMARA, phone, PASSWORD_A);

      const wrong = await signIn({ salonId: AMARA, phone, password: PASSWORD_B });
      const unknown = await signIn({ salonId: AMARA, phone: freePhone(), password: PASSWORD_B });
      expect(wrong.statusCode).toBe(401);
      expect(unknown.statusCode).toBe(401);
      expect(wrong.body).toBe(unknown.body);
      expect(wrong.json().error).toBe('invalid_credentials');
    });

    it('a blank salonId is still a 400, not a salon-less sign-in', async () => {
      const res = await signIn({ salonId: '', phone: DANA.phone, password: 'x' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_request');
    });
  });

  // ------------------------------------------------- one wallet, no salon --

  describe('without a salonId, a single-wallet phone signs straight in', () => {
    it.each([
      ['Maha at SAL-FOREST', MAHA, FOREST],
      ['Dana at SAL-AMARA', DANA, AMARA],
    ])('%s', async (_label, who, salonId) => {
      const before = (await sessionsFor(who.id)).length;
      const res = await signIn({ phone: who.phone, password: who.password, deviceId: 'dev-ws' });
      expect(res.statusCode, res.body).toBe(200);

      const body = res.json();
      expect(Object.keys(body).sort()).toEqual(['accessToken', 'expiresAt', 'member', 'refreshToken']);
      expect(body.member.id).toBe(who.id);
      expect(body.member.salonId).toBe(salonId);

      // The session row a salon-scoped sign-in writes: same kind, salon, scope, device.
      const rows = await sessionsFor(who.id);
      expect(rows.length).toBe(before + 1);
      const newest = rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
      expect(newest).toMatchObject({ principalKind: 'member', salonId, scope: 'wallet', deviceId: 'dev-ws' });

      // The session works: it reads her own wallet.
      const me = await app.inject({
        method: 'GET',
        url: '/members/me',
        headers: { authorization: `Bearer ${body.accessToken}` },
      });
      expect(me.statusCode).toBe(200);
      expect(me.json().salonId).toBe(salonId);
    });
  });

  // ------------------------------------------------ several wallets, no salon --

  describe('without a salonId, a phone at several salons', () => {
    it('the same password at two salons → 409 choose_workspace naming both, and no session', async () => {
      const phone = freePhone();
      const amaraId = await wallet(AMARA, phone, PASSWORD_A);
      const forestId = await wallet(FOREST, phone, PASSWORD_A);
      // A THIRD wallet whose password is different — it must not be named.
      const lumiereId = await wallet(LUMIERE, phone, PASSWORD_B);

      const res = await signIn({ phone, password: PASSWORD_A });
      expect(res.statusCode, res.body).toBe(409);
      const body = res.json();
      expect(body.error).toBe('choose_workspace');
      expect(Object.keys(body).sort()).toEqual(['error', 'message', 'workspaces']);

      const salons = await db.select().from(salon);
      const expected = [AMARA, FOREST].map((id) => {
        const s = salons.find((x) => x.id === id)!;
        return { salonId: s.id, name: s.name, nameAr: s.nameAr, brandColor: s.brandColor };
      });
      expect(body.workspaces).toEqual(expected);
      for (const w of body.workspaces) {
        expect(Object.keys(w).sort()).toEqual(['brandColor', 'name', 'nameAr', 'salonId']);
      }
      expect(res.body).not.toContain(LUMIERE);
      expect(res.body).not.toContain('Lumiere');

      for (const id of [amaraId, forestId, lumiereId]) expect(await sessionsFor(id)).toHaveLength(0);

      // The client re-posts with the salon she picked: an ordinary salon-scoped sign-in.
      const picked = await signIn({ salonId: FOREST, phone, password: PASSWORD_A });
      expect(picked.statusCode).toBe(200);
      expect(picked.json().member.id).toBe(forestId);
      expect(await sessionsFor(forestId)).toHaveLength(1);
      expect(await sessionsFor(amaraId)).toHaveLength(0);
    });

    it('a password that opens only one of them signs straight into that one', async () => {
      const phone = freePhone();
      await wallet(AMARA, phone, PASSWORD_A);
      const forestId = await wallet(FOREST, phone, PASSWORD_B);

      const res = await signIn({ phone, password: PASSWORD_B });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().member.id).toBe(forestId);
      expect(res.json().member.salonId).toBe(FOREST);
      expect(res.body).not.toContain(AMARA);
    });
  });

  // ---------------------------------------------------------------- misses --

  describe('no match is the unknown-phone 401', () => {
    it('same status, same body — for an unknown phone, a one-wallet miss and a two-wallet miss', async () => {
      const one = freePhone();
      await wallet(AMARA, one, PASSWORD_A);
      const two = freePhone();
      await wallet(AMARA, two, PASSWORD_A);
      await wallet(FOREST, two, PASSWORD_A);

      const unknown = await signIn({ phone: freePhone(), password: PASSWORD_B });
      const missOne = await signIn({ phone: one, password: PASSWORD_B });
      const missTwo = await signIn({ phone: two, password: PASSWORD_B });
      const scopedUnknown = await signIn({ salonId: AMARA, phone: freePhone(), password: PASSWORD_B });

      for (const r of [unknown, missOne, missTwo, scopedUnknown]) {
        expect(r.statusCode).toBe(401);
        expect(r.body).toBe(unknown.body);
      }
      expect(unknown.json()).toEqual({
        error: 'invalid_credentials',
        message: 'Those details do not match. Try again.',
      });
    });

    it('and costs the same: every salon-less attempt runs the full verify bound', async () => {
      /**
       * Interleaved rounds, medians, a band. Without the padding an unknown phone
       * costs ONE verify and a two-wallet miss TWO; with request overhead that
       * measured 16.4ms vs 24.1ms (ratio 1.47) when the padding was deleted, and
       * 38.9 / 37.9 / 40.4ms (worst ratio 1.07) with it. A band of 1.25 separates
       * the two with room for noise — and it DID go red with the padding removed.
       */
      const one = freePhone();
      await wallet(AMARA, one, PASSWORD_A);
      const two = freePhone();
      await wallet(AMARA, two, PASSWORD_A);
      await wallet(FOREST, two, PASSWORD_A);

      const time = async (phone: string) => {
        const t = performance.now();
        const r = await signIn({ phone, password: PASSWORD_B });
        const ms = performance.now() - t;
        expect(r.statusCode).toBe(401);
        return ms;
      };
      const unknownMs: number[] = [];
      const oneMs: number[] = [];
      const twoMs: number[] = [];
      for (let i = 0; i < 9; i++) {
        unknownMs.push(await time(freePhone()));
        oneMs.push(await time(one));
        twoMs.push(await time(two));
      }
      const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
      const u = median(unknownMs);
      const o = median(oneMs);
      const w = median(twoMs);
      // Printed so the report can quote the measurement, not just the verdict.
      console.log(
        `[timing] salon-less 401 medians over 9 rounds: unknown ${u.toFixed(1)}ms · ` +
          `one-wallet miss ${o.toFixed(1)}ms · two-wallet miss ${w.toFixed(1)}ms`,
      );
      expect(o / u).toBeLessThan(1.25);
      expect(u / o).toBeLessThan(1.25);
      expect(w / u).toBeLessThan(1.25);
      expect(u / w).toBeLessThan(1.25);
    });
  });

  // ---------------------------------------------------------------- budget --

  describe('the phone-wide budget', () => {
    it('throttles salon-less attempts on one phone whichever salon answers, and leaves the per-salon buckets alone', async () => {
      const phone = freePhone();
      const amaraId = await wallet(AMARA, phone, PASSWORD_A);
      const forestId = await wallet(FOREST, phone, PASSWORD_B);

      // Ten attempts that land on DIFFERENT salons' wallets — five open Amara,
      // five open Forest. One bucket counts all ten.
      for (let i = 0; i < limits.SIGN_IN_MAX_PER_WINDOW; i++) {
        const password = i % 2 === 0 ? PASSWORD_A : PASSWORD_B;
        const r = await signIn({ phone, password });
        expect(r.statusCode, `attempt ${i + 1}: ${r.body}`).toBe(200);
        expect(r.json().member.id).toBe(i % 2 === 0 ? amaraId : forestId);
      }
      expect(await attemptsIn(null, phone)).toBe(limits.SIGN_IN_MAX_PER_WINDOW);

      // The eleventh is refused — even with a correct password, and before any lookup.
      const over = await signIn({ phone, password: PASSWORD_A });
      expect(over.statusCode).toBe(429);
      expect(over.json().error).toBe(limits.SIGN_IN_RATE_LIMITED);
      // A refused attempt does not extend the window.
      expect(await attemptsIn(null, phone)).toBe(limits.SIGN_IN_MAX_PER_WINDOW);

      // The same refusal for a phone nobody holds, once its bucket is spent: no oracle.
      const ghost = freePhone();
      const key = limits.signInIdentityKey('member', null, ghost);
      await db.insert(signInAttempt).values(
        Array.from({ length: limits.SIGN_IN_MAX_PER_WINDOW }, () => ({
          surface: 'member',
          identityKey: key,
          salonId: null,
        })),
      );
      const ghostOver = await signIn({ phone: ghost, password: PASSWORD_A });
      expect(ghostOver.statusCode).toBe(429);
      expect(ghostOver.body).toBe(over.body);

      // Independent of the salon-scoped buckets: untouched, and still open.
      expect(await attemptsIn(AMARA, phone)).toBe(0);
      expect(await attemptsIn(FOREST, phone)).toBe(0);
      const scoped = await signIn({ salonId: AMARA, phone, password: PASSWORD_A });
      expect(scoped.statusCode).toBe(200);
    });

    it('a spent salon-scoped bucket does not spend the phone-wide one', async () => {
      const phone = freePhone();
      const id = await wallet(AMARA, phone, PASSWORD_A);
      const key = limits.signInIdentityKey('member', AMARA, phone);
      await db.insert(signInAttempt).values(
        Array.from({ length: limits.SIGN_IN_MAX_PER_WINDOW }, () => ({
          surface: 'member',
          identityKey: key,
          salonId: AMARA,
        })),
      );
      const scoped = await signIn({ salonId: AMARA, phone, password: PASSWORD_A });
      expect(scoped.statusCode).toBe(429);

      const salonLess = await signIn({ phone, password: PASSWORD_A });
      expect(salonLess.statusCode).toBe(200);
      expect(salonLess.json().member.id).toBe(id);
    });
  });

  // ---------------------------------------------------------------- erased --

  describe('erased members are never candidates', () => {
    const erased = () => {
      const requested = new Date(Date.now() - 40 * 86_400_000);
      return {
        deletionRequestedAt: requested,
        deletionDueAt: new Date(requested.getTime() + 30 * 86_400_000),
        erasedAt: new Date(Date.now() - 86_400_000),
      };
    };

    it('an erased wallet sharing the phone and password is neither signed into nor listed', async () => {
      const phone = freePhone();
      const liveId = await wallet(AMARA, phone, PASSWORD_A);
      const erasedId = await wallet(FOREST, phone, PASSWORD_A, erased());

      const res = await signIn({ phone, password: PASSWORD_A });
      expect(res.statusCode, res.body).toBe(200); // not 409: the erased row is not a candidate
      expect(res.json().member.id).toBe(liveId);
      expect(await sessionsFor(erasedId)).toHaveLength(0);
    });

    it('a phone whose only wallet is erased is the unknown-phone 401', async () => {
      const phone = freePhone();
      await wallet(FOREST, phone, PASSWORD_A, erased());
      const res = await signIn({ phone, password: PASSWORD_A });
      const unknown = await signIn({ phone: freePhone(), password: PASSWORD_A });
      expect(res.statusCode).toBe(401);
      expect(res.body).toBe(unknown.body);
    });
  });

  // ----------------------------------------------------------------- reset --

  describe('the reset request without a salon discloses nothing', () => {
    async function linksFor(memberId: string) {
      return db
        .select()
        .from(memberPasswordReset)
        .where(orm.eq(memberPasswordReset.memberId, memberId));
    }

    async function resetAuditFor(memberId: string) {
      return db
        .select()
        .from(auditLog)
        .where(
          orm.and(
            orm.eq(auditLog.subjectId, memberId),
            orm.eq(auditLog.action, 'Password reset link requested'),
          ),
        );
    }

    it('unknown, one wallet, several wallets and salon-scoped all answer one body', async () => {
      const one = freePhone();
      const oneId = await wallet(FOREST, one, PASSWORD_A);
      const several = freePhone();
      const aId = await wallet(AMARA, several, PASSWORD_A);
      const fId = await wallet(FOREST, several, PASSWORD_B);
      const erasedId = await wallet(LUMIERE, several, PASSWORD_A, {
        deletionRequestedAt: new Date(Date.now() - 40 * 86_400_000),
        deletionDueAt: new Date(Date.now() - 10 * 86_400_000),
        erasedAt: new Date(Date.now() - 86_400_000),
      });

      const unknown = await resetRequest({ phone: freePhone() });
      const single = await resetRequest({ phone: one });
      const multi = await resetRequest({ phone: several });
      const scoped = await resetRequest({ salonId: AMARA, phone: several });
      const nullSalon = await resetRequest({ salonId: null, phone: freePhone() });

      for (const r of [unknown, single, multi, scoped, nullSalon]) {
        expect(r.statusCode, r.body).toBe(202);
        expect(r.body).toBe(unknown.body);
      }
      expect(unknown.json()).toEqual({ accepted: true });
      for (const r of [single, multi]) {
        for (const name of ['Amara', 'Forest', 'Lumiere', AMARA, FOREST, LUMIERE]) {
          expect(r.body).not.toContain(name);
        }
      }

      // One wallet → one link. Several → one link EACH, bound to its own row.
      expect(await linksFor(oneId)).toHaveLength(1);
      const aLinks = await linksFor(aId);
      const fLinks = await linksFor(fId);
      expect(fLinks).toHaveLength(1);
      // Amara was asked twice (salon-less, then scoped): the second spent the first.
      expect(aLinks).toHaveLength(2);
      expect(aLinks.filter((l) => l.usedAt === null)).toHaveLength(1);
      expect(new Set([...aLinks, ...fLinks].map((l) => l.tokenHash)).size).toBe(3);
      // The erased wallet got nothing.
      expect(await linksFor(erasedId)).toHaveLength(0);

      // Audit rows: one per wallet per request, each in its own salon's log.
      const [aAudit, fAudit] = [await resetAuditFor(aId), await resetAuditFor(fId)];
      expect(aAudit).toHaveLength(2);
      expect(fAudit).toHaveLength(1);
      expect(aAudit.every((r) => r.salonId === AMARA)).toBe(true);
      expect(fAudit[0]!.salonId).toBe(FOREST);
    });

    it('a blank salonId is still a 400', async () => {
      const r = await resetRequest({ salonId: '', phone: freePhone() });
      expect(r.statusCode).toBe(400);
    });
  });
});
