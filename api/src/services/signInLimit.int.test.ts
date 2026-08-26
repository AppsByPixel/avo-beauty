/**
 * The password sign-in budget, proved against a real database and the real
 * handlers.
 *
 * WHY THIS IS NOT A PURE SPEC. Two of the three claims worth having are about
 * rows and about what a HANDLER did, not about what a function returned:
 *
 *   A REFUSED SIGN-IN MINTED NO SESSION. A limiter that fired after `issueSession`
 *   would be worse than no limiter — it would hand out the credential and then say
 *   no. That is an assertion about the `session` table.
 *
 *   A LOCKED REAL ACCOUNT AND AN ABSENT ONE ANSWER IDENTICALLY. That needs a real
 *   member row to exist and a real phone number to not, and it needs the real
 *   route between them. It is the assertion this whole design is shaped around
 *   (services/signInLimit.ts § THE TRAP), and a spec that only checked "returns
 *   429" would pass against the oracle it exists to prevent.
 *
 * `vitest.int.config.ts` carries the rest, including why this suite is not in
 * `pnpm check` and whose column its permanent home is.
 *
 * NO CLEANUP, BY CONSTRUCTION. Every test mints its own identifier, so each starts
 * with an empty bucket and nothing has to be removed afterwards. That is not only
 * tidiness: `avo_app` — the role `db/client.ts` connects as, and the role
 * production serves with — CANNOT DELETE `sign_in_attempt` (migration 0039), so a
 * suite that needed to truncate would have had to connect as the owner and would
 * then have been proving the limiter under privileges production does not have.
 *
 * NOT ASSERTED HERE: concurrency. Two simultaneous requests can both read a count
 * one below the ceiling and both proceed, by construction — the counter is a
 * SELECT, not a lock. That is an accepted overshoot of at most the number of
 * in-flight requests, it is the property every sibling limiter in this API has,
 * and pinning it needs `e2e/support/race.ts`, which is Lane D's column.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const INT_URL = process.env.AVO_INT_DATABASE_URL;

/**
 * SKIP RATHER THAN CONNECT. With the variable unset this file imports nothing —
 * not the app, not `db/client.ts` — so it cannot reach a database it was not
 * pointed at. `LANES.md` § "Every lane isolates its own resources".
 */
const suite = INT_URL ? describe : describe.skip;

const SALON = 'SAL-AMARA';

/**
 * NO SEEDED ACCOUNT IS USED AS A BUCKET, ANYWHERE IN THIS FILE, and that is not
 * fastidiousness. `avo_app` cannot DELETE `sign_in_attempt` (migration 0039), so a
 * spec that spent `noura`'s budget would leave it spent — and a second run of the
 * suite inside the same hour would find her at the HOURLY ceiling and be told
 * `sign_in_hourly_limit` where it expected `sign_in_rate_limited`. A suite that
 * only passes the first time it is run in an hour is worse than no suite.
 *
 * So every account here is minted by the test that needs it, with a real argon2
 * hash, and every bucket starts empty by construction.
 */
const REAL_PASSWORD = 'a-real-password-for-this-test';

suite('the password sign-in budget', () => {
  let app: FastifyInstance;

  // Bound in beforeAll. Imported there rather than at the top of the file so an
  // unset AVO_INT_DATABASE_URL skips without `env.ts` throwing at module load.
  let db: typeof import('../db/client')['db'];
  let signInAttempt: typeof import('../db/schema/session')['signInAttempt'];
  let session: typeof import('../db/schema/session')['session'];
  let member: typeof import('../db/schema/member')['member'];
  let staffUser: typeof import('../db/schema/staff')['staffUser'];
  let platformAdmin: typeof import('../db/schema/platformAdmin')['platformAdmin'];
  let hashSecret: typeof import('../auth/password')['hashSecret'];
  let limits: typeof import('./signInLimit');
  let orm: typeof import('drizzle-orm');

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    signInAttempt = (await import('../db/schema/session')).signInAttempt;
    session = (await import('../db/schema/session')).session;
    member = (await import('../db/schema/member')).member;
    staffUser = (await import('../db/schema/staff')).staffUser;
    platformAdmin = (await import('../db/schema/platformAdmin')).platformAdmin;
    hashSecret = (await import('../auth/password')).hashSecret;
    limits = await import('./signInLimit');
    orm = await import('drizzle-orm');
    app = await (await import('../app')).buildApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  // ------------------------------------------------------------- fixtures --

  /** A phone number that is valid E.164 and belongs to nobody. */
  function freePhone(): string {
    // 9 random digits behind the Kuwait prefix — `member_phone_is_e164` accepts
    // it, and no seeded row has it.
    return `+9657${Math.floor(Math.random() * 1_000_000_0).toString().padStart(7, '0')}`;
  }

  /** A REAL member, with a real argon2 hash, at the seeded salon. */
  async function realMember(password: string): Promise<{ phone: string; id: string }> {
    const phone = freePhone();
    const id = `INT-${randomUUID().slice(0, 8)}`;
    await db.insert(member).values({
      id,
      salonId: SALON,
      name: 'Int Test Member',
      phone,
      passwordHash: await hashSecret(password),
      policyVersion: 1,
    });
    return { phone, id };
  }

  /** A REAL dashboard account, with a real argon2 hash, at the seeded salon. */
  async function realStaff(password: string): Promise<{ handle: string; id: string }> {
    const handle = `int-${randomUUID().slice(0, 8)}`;
    const id = `INT-ST-${randomUUID().slice(0, 8)}`;
    await db.insert(staffUser).values({
      id,
      salonId: SALON,
      name: 'Int Test Staff',
      handle,
      role: 'frontdesk',
      passwordHash: await hashSecret(password),
      permDashboard: true,
    });
    return { handle, id };
  }

  /** A REAL console account. Not the owner — `platform_admin_owner_holds_everything`. */
  async function realAdmin(password: string): Promise<{ handle: string; id: string }> {
    const handle = `int-${randomUUID().slice(0, 8)}`;
    const id = `INT-PLT-${randomUUID().slice(0, 8)}`;
    await db.insert(platformAdmin).values({
      id,
      name: 'Int Test Admin',
      handle,
      role: 'analyst',
      passwordHash: await hashSecret(password),
    });
    return { handle, id };
  }

  /** Fill one claimed identity's window to exactly `n`. */
  async function preload(
    surface: limits.SignInSurface,
    salonId: string | null,
    identifier: string,
    n: number,
  ): Promise<void> {
    if (n === 0) return;
    const identityKey = limits.signInIdentityKey(surface, salonId, identifier);
    await db
      .insert(signInAttempt)
      .values(Array.from({ length: n }, () => ({ surface, identityKey, salonId })));
  }

  async function countAttempts(
    surface: limits.SignInSurface,
    salonId: string | null,
    identifier: string,
  ): Promise<number> {
    const [row] = await db
      .select({ n: orm.sql<number>`count(*)::int` })
      .from(signInAttempt)
      .where(orm.eq(signInAttempt.identityKey, limits.signInIdentityKey(surface, salonId, identifier)));
    return row?.n ?? 0;
  }

  const memberSignIn = (phone: string, password: string) =>
    app.inject({
      method: 'POST',
      url: '/auth/member/session',
      payload: { salonId: SALON, phone, password },
    });

  const webSignIn = (username: string, password: string) =>
    app.inject({
      method: 'POST',
      url: '/auth/web/session',
      payload: { salonId: SALON, username, password },
    });

  const platformSignIn = (username: string, password: string) =>
    app.inject({
      method: 'POST',
      url: '/auth/platform/session',
      payload: { username, password },
    });

  // ----------------------------------------- the three doors, one by one --

  describe('POST /auth/member/session — the customer wallet', () => {
    it('does not fire one request below the burst threshold', async () => {
      const phone = freePhone();
      await preload('member', SALON, phone, limits.SIGN_IN_MAX_PER_WINDOW - 1);

      const res = await memberSignIn(phone, 'not-her-password');

      // A 401 — the number belongs to nobody — but NOT a 429.
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body).error).toBe('invalid_credentials');
    });

    it('refuses with sign_in_rate_limited at the burst threshold', async () => {
      const phone = freePhone();
      await preload('member', SALON, phone, limits.SIGN_IN_MAX_PER_WINDOW);

      const res = await memberSignIn(phone, 'not-her-password');

      expect(res.statusCode).toBe(429);
      // THE CODE, not the status. `http/errors.ts`: the `error` string is the
      // contract and the clients switch on it. A spec asserting 429 alone would
      // pass against a limiter that told her she lacked authority.
      expect(JSON.parse(res.body).error).toBe(limits.SIGN_IN_RATE_LIMITED);
    });

    it('reports the hourly ceiling ahead of the burst one when both are spent', async () => {
      const phone = freePhone();
      await preload('member', SALON, phone, limits.SIGN_IN_MAX_PER_HOUR);

      const res = await memberSignIn(phone, 'not-her-password');

      expect(res.statusCode).toBe(429);
      expect(JSON.parse(res.body).error).toBe(limits.SIGN_IN_HOURLY_LIMIT);
    });

    it('refuses the CORRECT password once the budget is spent, and mints no session', async () => {
      /**
       * The limiter sits in front of the verify, so a spent bucket refuses a
       * caller who is holding the real password. That is the point — an attacker
       * who guesses right on attempt eleven must not be let in — and the second
       * assertion is the one that matters most: a limiter that fired AFTER
       * `issueSession` would hand out the credential and then say no.
       */
      const her = await realMember(REAL_PASSWORD);
      await preload('member', SALON, her.phone, limits.SIGN_IN_MAX_PER_WINDOW);

      const res = await memberSignIn(her.phone, REAL_PASSWORD);

      expect(res.statusCode).toBe(429);
      expect(JSON.parse(res.body).error).toBe(limits.SIGN_IN_RATE_LIMITED);
      expect(res.body).not.toContain('accessToken');

      const [row] = await db
        .select({ n: orm.sql<number>`count(*)::int` })
        .from(session)
        .where(orm.eq(session.memberId, her.id));
      expect(row?.n).toBe(0);
    });

    it('is keyed on the claimed identity: another number at the same salon is unaffected', async () => {
      const spent = freePhone();
      const fresh = freePhone();
      await preload('member', SALON, spent, limits.SIGN_IN_MAX_PER_WINDOW);

      expect(JSON.parse((await memberSignIn(spent, 'x')).body).error).toBe(
        limits.SIGN_IN_RATE_LIMITED,
      );

      const other = await memberSignIn(fresh, 'x');
      expect(other.statusCode).toBe(401);
      expect(JSON.parse(other.body).error).toBe('invalid_credentials');
    });

    it('records the attempt for a request the handler then refuses', async () => {
      /**
       * `signupLimit.ts`'s property, and the one that had to be FIXED there rather
       * than merely documented: a refusal is an attempt. Forty probes that all
       * answered `409 already_registered` left `signup_attempt` empty, so the
       * oracle "was not bounded at 100 an hour. It was not bounded at all."
       */
      const phone = freePhone();
      expect(await countAttempts('member', SALON, phone)).toBe(0);

      const res = await memberSignIn(phone, 'x');
      expect(res.statusCode).toBe(401);

      expect(await countAttempts('member', SALON, phone)).toBe(1);
    });

    it('never writes the phone number into the counter', async () => {
      /**
       * Migration 0026 refused to store the phone in `signup_attempt` because the
       * table is a list of identities somebody TRIED, which includes people who
       * hold no account. This table has the same problem and the HMAC is the
       * answer; the spec exists so a later "simplification" to a plain column
       * fails here rather than in a data-protection review.
       */
      const phone = freePhone();
      await memberSignIn(phone, 'x');

      const [row] = await db
        .select({ n: orm.sql<number>`count(*)::int` })
        .from(signInAttempt)
        .where(orm.sql`${signInAttempt.identityKey} like ${'%' + phone.slice(1) + '%'}`);
      expect(row?.n).toBe(0);
      // And the key really is a 64-character hex digest.
      expect(limits.signInIdentityKey('member', SALON, phone)).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('POST /auth/web/session — the merchant dashboard', () => {
    it('does not fire one request below the burst threshold', async () => {
      const username = `int-${randomUUID().slice(0, 8)}`;
      await preload('web', SALON, username, limits.SIGN_IN_MAX_PER_WINDOW - 1);

      const res = await webSignIn(username, 'x');

      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body).error).toBe('invalid_credentials');
    });

    it('refuses with sign_in_rate_limited at the burst threshold', async () => {
      const username = `int-${randomUUID().slice(0, 8)}`;
      await preload('web', SALON, username, limits.SIGN_IN_MAX_PER_WINDOW);

      const res = await webSignIn(username, 'x');

      expect(res.statusCode).toBe(429);
      expect(JSON.parse(res.body).error).toBe(limits.SIGN_IN_RATE_LIMITED);
    });

    it('refuses a real manager holding her real password, and mints no session', async () => {
      /**
       * A REAL account with a REAL password, so this is the assertion that the
       * limiter is in front of the verify on this surface too. The bucket is
       * preloaded rather than filled by eleven requests, so the suite spends no
       * argon2 time proving something the count already settles.
       */
      const her = await realStaff(REAL_PASSWORD);
      await preload('web', SALON, her.handle, limits.SIGN_IN_MAX_PER_WINDOW);

      const res = await webSignIn(her.handle, REAL_PASSWORD);

      expect(res.statusCode).toBe(429);
      expect(JSON.parse(res.body).error).toBe(limits.SIGN_IN_RATE_LIMITED);
      expect(res.body).not.toContain('accessToken');
    });

    it('folds case into one bucket, because NOURA and noura are one account', async () => {
      const username = `int-${randomUUID().slice(0, 8)}`;
      await preload('web', SALON, username, limits.SIGN_IN_MAX_PER_WINDOW);

      const res = await webSignIn(username.toUpperCase(), 'x');

      expect(res.statusCode).toBe(429);
      expect(JSON.parse(res.body).error).toBe(limits.SIGN_IN_RATE_LIMITED);
    });
  });

  describe('POST /auth/platform/session — the owner console', () => {
    it('does not fire one request below the burst threshold', async () => {
      const handle = `int-${randomUUID().slice(0, 8)}`;
      await preload('platform', null, handle, limits.SIGN_IN_MAX_PER_WINDOW - 1);

      const res = await platformSignIn(handle, 'x');

      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body).error).toBe('invalid_credentials');
    });

    it('refuses with sign_in_rate_limited at the burst threshold', async () => {
      const handle = `int-${randomUUID().slice(0, 8)}`;
      await preload('platform', null, handle, limits.SIGN_IN_MAX_PER_WINDOW);

      const res = await platformSignIn(handle, 'x');

      expect(res.statusCode).toBe(429);
      expect(JSON.parse(res.body).error).toBe(limits.SIGN_IN_RATE_LIMITED);
    });

    it('refuses a real admin holding his real password', async () => {
      const him = await realAdmin(REAL_PASSWORD);
      await preload('platform', null, him.handle, limits.SIGN_IN_MAX_PER_WINDOW);

      const res = await platformSignIn(him.handle, REAL_PASSWORD);

      expect(res.statusCode).toBe(429);
      expect(JSON.parse(res.body).error).toBe(limits.SIGN_IN_RATE_LIMITED);
      expect(res.body).not.toContain('accessToken');
    });

    it('strips the @ into one bucket, because @yousef and yousef are one person', async () => {
      const handle = `int-${randomUUID().slice(0, 8)}`;
      await preload('platform', null, handle, limits.SIGN_IN_MAX_PER_WINDOW);

      const res = await platformSignIn(`@${handle}`, 'x');

      expect(res.statusCode).toBe(429);
      expect(JSON.parse(res.body).error).toBe(limits.SIGN_IN_RATE_LIMITED);
    });
  });

  // ------------------------------------------------- the enumeration trap --

  describe('a spent bucket is indistinguishable between a real account and an absent one', () => {
    /**
     * THE ASSERTION THE WHOLE DESIGN IS SHAPED AROUND. routes/auth.ts § ENUMERATION:
     * "Every failure path answers with the same body … 'Wrong password' and 'no
     * such phone number' being distinguishable turns a login form into a
     * customer-list oracle." A lockout keyed on the ACCOUNT would hand that back
     * with a far bigger signal than the timing channel `burnVerifyTime` removes —
     * one request per number, a definitive answer, no statistics needed.
     *
     * So the comparison is byte-for-byte on the whole body, not on the code: a
     * `details` field naming the account, or a different message for a real
     * customer, is exactly the leak worth failing on.
     */
    it('answers with the same status and the same body on the wallet', async () => {
      const her = await realMember(REAL_PASSWORD);
      const nobody = freePhone();

      await preload('member', SALON, her.phone, limits.SIGN_IN_MAX_PER_WINDOW);
      await preload('member', SALON, nobody, limits.SIGN_IN_MAX_PER_WINDOW);

      const real = await memberSignIn(her.phone, 'wrong');
      const absent = await memberSignIn(nobody, 'wrong');

      expect(real.statusCode).toBe(429);
      expect(absent.statusCode).toBe(real.statusCode);
      expect(absent.body).toBe(real.body);
    });

    it('answers with the same status and the same body on the dashboard', async () => {
      const her = await realStaff('her-real-password');
      const nobody = `int-${randomUUID().slice(0, 8)}`;

      await preload('web', SALON, her.handle, limits.SIGN_IN_MAX_PER_WINDOW);
      await preload('web', SALON, nobody, limits.SIGN_IN_MAX_PER_WINDOW);

      const real = await webSignIn(her.handle, 'wrong');
      const absent = await webSignIn(nobody, 'wrong');

      expect(real.statusCode).toBe(429);
      expect(absent.statusCode).toBe(real.statusCode);
      expect(absent.body).toBe(real.body);
    });

    it('answers with the same status and the same body on the console', async () => {
      const him = await realAdmin('his-real-password');
      const nobody = `int-${randomUUID().slice(0, 8)}`;

      await preload('platform', null, him.handle, limits.SIGN_IN_MAX_PER_WINDOW);
      await preload('platform', null, nobody, limits.SIGN_IN_MAX_PER_WINDOW);

      const real = await platformSignIn(him.handle, 'wrong');
      const absent = await platformSignIn(nobody, 'wrong');

      expect(real.statusCode).toBe(429);
      expect(absent.statusCode).toBe(real.statusCode);
      expect(absent.body).toBe(real.body);
    });

    it('spends the budget for an absent identity exactly as it does for a real one', async () => {
      /**
       * The other half of the same property, and the one a "skip the counter when
       * there is no account" optimisation would break: if a miss cost nothing, a
       * probe could walk the customer book by watching which numbers ever reach a
       * 429 at all.
       */
      const her = await realMember(REAL_PASSWORD);
      const nobody = freePhone();

      await memberSignIn(her.phone, 'wrong');
      await memberSignIn(nobody, 'wrong');

      expect(await countAttempts('member', SALON, her.phone)).toBe(1);
      expect(await countAttempts('member', SALON, nobody)).toBe(1);
    });
  });

  // ----------------------------------------------------- it is not a latch --

  it('writes nothing to the account row, so a stranger cannot bar her from her wallet', async () => {
    /**
     * services/signInLimit.ts § THE SECOND TRAP. `staff_user.pin_locked_until` is
     * right where it is — a manager is standing in the salon — and nobody is
     * standing next to Dana's phone. This spec fails the moment somebody adds a
     * `locked_until` column to `member` and sets it from here, which is the
     * "obvious" next change.
     *
     * `updated_at` is the witness: every write path in routes/members.ts sets it,
     * so an unchanged stamp is the evidence that the limiter touched nothing.
     */
    const her = await realMember(REAL_PASSWORD);
    const before = await db
      .select({ updatedAt: member.updatedAt })
      .from(member)
      .where(orm.eq(member.id, her.id));

    await preload('member', SALON, her.phone, limits.SIGN_IN_MAX_PER_HOUR);
    const res = await memberSignIn(her.phone, 'wrong');
    expect(res.statusCode).toBe(429);

    const after = await db
      .select({ updatedAt: member.updatedAt })
      .from(member)
      .where(orm.eq(member.id, her.id));
    expect(after[0]?.updatedAt?.getTime()).toBe(before[0]?.updatedAt?.getTime());
  });
});
