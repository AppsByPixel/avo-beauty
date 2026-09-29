/**
 * A wallet token is stamped by ONE clock — the database's — at mint, at peek and
 * at consume. Proved against a real database, through the real handlers.
 *
 * WHY THIS EXISTS. Trunk's full gate on `e55bf7f` failed five specs in
 * `e2e/loyalty-reversal.test.ts` with a 500:
 *
 *   new row for relation "wallet_token" violates check constraint
 *   "wallet_token_consumed_after_issue"
 *   … issued_at 08:20:54.685605+00 … consumed_at 08:20:54.681+00
 *
 * `consumed_at` 4 ms BEFORE `issued_at`. `issued_at` was `defaultNow()` — the
 * DATABASE's clock — and `consumeToken` wrote `consumedAt: new Date()` — the API
 * PROCESS's clock. The CHECK `consumed_at >= issued_at` was comparing two clocks,
 * and locally Postgres runs in a Docker VM a few milliseconds ahead of the host.
 * A spec that mints and charges immediately lands inside the skew; run alone it
 * passed, which is why it read as a flake. In production a Vercel instance and
 * Supabase are two machines too. A charge must never fail because of the gap
 * between them — the customer is standing at the counter with a good code.
 *
 * HOW THE SKEW IS REPRODUCED. The API's `Date` is faked and frozen a few
 * milliseconds BEHIND the database's `clock_timestamp()`, read immediately
 * before. Everything the test then does happens later in real time, so every
 * instant the database stamps is after the frozen one: the API is behind the
 * database for the whole test, by at least the stub, deterministically. Frozen
 * rather than ticking because a red/green spec must be red every time, and a
 * frozen clock is simply the limiting case of a slow one.
 *
 * Only `Date` is faked. Real timers keep running, so the postgres driver and
 * Fastify behave normally.
 *
 * WHAT IS ASSERTED
 *
 *   THE CHARGE SUCCEEDS. 200, the balance moved by the price, the token row is
 *   consumed by the transaction the charge created. Against the old line
 *   (`consumedAt: new Date()`) this is a 500 and nothing moves.
 *
 *   ONE CLOCK AT MINT. `expires_at - issued_at` is EXACTLY the TTL. With
 *   `expires_at` computed from the API clock and `issued_at` from the database's,
 *   the difference is the TTL plus the skew — and the `wallet_token_expiry_is_short`
 *   CHECK becomes a function of how far apart two machines are.
 *
 *   `consumed_at >= issued_at` in the row, which is the CHECK restated as data.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const INT_URL = process.env.AVO_INT_DATABASE_URL;

/** Skip rather than connect — see `scannerLimit.int.test.ts` and `vitest.int.config.ts`. */
const suite = INT_URL ? describe : describe.skip;

/**
 * A salon, a till and a customer of this file's own, per run. The seeded 8842 is
 * spent by the rest of the suite (`scannerLimit`'s twelve-charge burst alone
 * drains her), so a spec that needs a charge to SUCCEED cannot borrow her
 * balance. Inert afterwards, `CK-`-prefixed, like `chargeLoyaltyRecord`'s.
 */
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const SALON = `CK-S-${RUN}`;
const BRANCH = `${SALON}-BR`;
const STAFF = `${SALON}-ST`;
/** 5.000 KD, typed at the till, so the salon needs no service menu. */
const PRICE_FILS = 5000;

/**
 * How far the API's clock is set behind the database's. "A few milliseconds" is
 * the measured failure; the trunk row showed 4 ms. Nothing here depends on the
 * size beyond it being positive.
 */
const API_BEHIND_DB_MS = 5;

suite('a wallet token is stamped by one clock — the database is ahead of the API', () => {
  let app: FastifyInstance;
  let db: typeof import('../db/client')['db'];
  let member: typeof import('../db/schema/member')['member'];
  let walletToken: typeof import('../db/schema/walletToken')['walletToken'];
  let orm: typeof import('drizzle-orm');
  let issueSession: typeof import('../auth/sessions')['issueSession'];
  let hashWalletToken: typeof import('../auth/tokens')['hashWalletToken'];
  let TOKEN_TTL_SECONDS: number;

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    member = (await import('../db/schema/member')).member;
    walletToken = (await import('../db/schema/walletToken')).walletToken;
    orm = await import('drizzle-orm');
    issueSession = (await import('../auth/sessions')).issueSession;
    hashWalletToken = (await import('../auth/tokens')).hashWalletToken;
    TOKEN_TTL_SECONDS = (await import('./walletToken')).TOKEN_TTL_SECONDS;
    app = await (await import('../app')).buildApp();

    const { sql } = orm;
    const hours = JSON.stringify({ morning: ['10:00', '13:00'], evening: ['16:00', '22:00'] });
    await db.execute(sql`
      INSERT INTO salon (id, name, brand_color, loyalty_mode, tiers, deposit_fils, business_hours,
                         module_booking, module_shop, timezone)
      VALUES (${SALON}, ${`CK ${SALON}`}, '#7A5C8E', 'tiers',
              (SELECT tiers FROM salon WHERE id = 'SAL-AMARA'), 2000, ${hours}::jsonb,
              false, false, 'Asia/Kuwait')`);
    await db.execute(sql`INSERT INTO branch (id, salon_id, name) VALUES (${BRANCH}, ${SALON}, 'CK Branch')`);
    await db.execute(sql`
      INSERT INTO staff_user
        (id, salon_id, name, handle, role, branch_access_all, branch_access_ids, password_hash,
         perm_dashboard, perm_appointments, perm_shop, perm_loyalty, perm_team, perm_scanner,
         perm_charges, perm_void, perm_marketing)
      VALUES (${STAFF}, ${SALON}, 'CK Manager', ${`ck-${RUN}`},
              'manager', true, '{}', 'x', true, true, true, true, true, true, true, true, true)`);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    if (db && orm) {
      // Sessions go; the salon, its staff, the member and her money stay
      // (append-only ledger, restrict FKs). Inert, per-run, `CK-`.
      await db.execute(orm.sql`DELETE FROM session WHERE salon_id = ${SALON}`);
    }
    await app?.close();
  });

  /** A customer of this salon with 500.000 KD, so no charge here is refused for money. */
  async function customer(): Promise<string> {
    const id = `CK-M-${randomUUID().slice(0, 12)}`;
    await db.execute(orm.sql`
      INSERT INTO member (id, salon_id, name, phone, password_hash, balance_fils, visits, tier,
                          policy_version)
      VALUES (${id}, ${SALON}, 'CK Customer',
              ${`+9656${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`}, 'x', 500000,
              0, 'bronze', 1)`);
    return id;
  }

  /** Freeze the API's `Date` `API_BEHIND_DB_MS` behind the database's clock, now. */
  async function putTheApiBehindTheDatabase(): Promise<void> {
    const [row] = (await db.execute(
      orm.sql`SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS ms`,
    )) as unknown as Array<{ ms: number }>;
    if (!row) throw new Error('no clock_timestamp()');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Math.floor(Number(row.ms)) - API_BEHIND_DB_MS));
  }

  async function balanceOf(id: string): Promise<number> {
    const [row] = await db
      .select({ balanceFils: member.balanceFils })
      .from(member)
      .where(orm.eq(member.id, id));
    return Number(row?.balanceFils);
  }

  it('mints, then charges the token immediately, and the charge settles', async () => {
    const MEMBER = await customer();
    await putTheApiBehindTheDatabase();

    // Sessions are issued AFTER the clock moves, so their `iat` is on the API's
    // clock and nothing about authentication depends on the skew under test.
    const wallet = await issueSession(db, {
      principalKind: 'member',
      memberId: MEMBER,
      salonId: SALON,
      scope: 'wallet',
      deviceId: `DEV-INT-${randomUUID()}`,
    });
    const till = await issueSession(db, {
      principalKind: 'staff',
      staffId: STAFF,
      salonId: SALON,
      scope: 'scanner',
      deviceId: `DEV-INT-${randomUUID()}`,
    });

    // Mint through the endpoint the wallet calls.
    const minted = await app.inject({
      method: 'GET',
      url: '/members/me/wallet-token',
      headers: { authorization: `Bearer ${wallet.accessToken}` },
    });
    expect(minted.statusCode).toBe(200);
    const { token } = JSON.parse(minted.body) as { token: string };

    const before = await balanceOf(MEMBER);

    // …and charge it at once — the e2e spec's shape, and the window the skew lives in.
    const res = await app.inject({
      method: 'POST',
      url: '/charges',
      headers: {
        authorization: `Bearer ${till.accessToken}`,
        'idempotency-key': `int-clock-${randomUUID()}`,
      },
      payload: { memberId: MEMBER, amountFils: PRICE_FILS, reason: 'CK clock spec', token },
    });

    expect(res.statusCode, res.body).toBe(200);
    // Integer fils. The price, and nothing else, left the wallet.
    expect(await balanceOf(MEMBER)).toBe(before - PRICE_FILS);

    const [row] = await db
      .select({
        issuedAt: walletToken.issuedAt,
        expiresAt: walletToken.expiresAt,
        consumedAt: walletToken.consumedAt,
        consumedByTransactionId: walletToken.consumedByTransactionId,
        // Microsecond-exact, from the database itself — a JS Date drops the µs.
        ttlSeconds: orm.sql<string>`extract(epoch FROM ${walletToken.expiresAt} - ${walletToken.issuedAt})::text`,
        consumedNotBeforeIssue: orm.sql<boolean>`${walletToken.consumedAt} >= ${walletToken.issuedAt}`,
      })
      .from(walletToken)
      .where(orm.eq(walletToken.tokenHash, hashWalletToken(token)));

    expect(row?.consumedAt).not.toBeNull();
    expect(row?.consumedByTransactionId).toBeTruthy();
    expect(row?.consumedNotBeforeIssue).toBe(true);
    // One clock at mint: the life of a token is the TTL, not the TTL plus a skew.
    expect(Number(row?.ttlSeconds)).toBe(TOKEN_TTL_SECONDS);
  });

  it('a token the API clock still thinks is live but the database has expired is refused as expired, not charged', async () => {
    /**
     * The other half of "one clock". `peekToken` compared `expires_at` with
     * `Date.now()` and `consumeToken` with the database's `now()`; with the API
     * behind, a dead token passed the peek and was refused by the consume as
     * "already used or unknown" — the wrong copy, sending the customer to the
     * wrong action. Both now ask the database.
     */
    const MEMBER = await customer();

    const raw = `int-expired-${randomUUID()}`;
    // Issued 60 s ago and expired 15 s ago — by the database's clock.
    await db.execute(orm.sql`
      INSERT INTO wallet_token (member_id, token_hash, issued_at, expires_at)
      VALUES (${MEMBER}, ${hashWalletToken(raw)}, now() - interval '60 seconds', now() - interval '15 seconds')`);

    // The API is 30 s behind: by its clock the token has 15 s left.
    const [row] = (await db.execute(
      orm.sql`SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS ms`,
    )) as unknown as Array<{ ms: number }>;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Math.floor(Number(row?.ms)) - 30_000));

    const till = await issueSession(db, {
      principalKind: 'staff',
      staffId: STAFF,
      salonId: SALON,
      scope: 'scanner',
      deviceId: `DEV-INT-${randomUUID()}`,
    });

    const before = await balanceOf(MEMBER);
    const res = await app.inject({
      method: 'POST',
      url: '/charges',
      headers: {
        authorization: `Bearer ${till.accessToken}`,
        'idempotency-key': `int-clock-${randomUUID()}`,
      },
      payload: { memberId: MEMBER, amountFils: PRICE_FILS, reason: 'CK clock spec', token: raw },
    });

    expect(res.statusCode).toBe(410);
    expect(JSON.parse(res.body).error).toBe('token_expired');
    expect(await balanceOf(MEMBER)).toBe(before);
  });
});
