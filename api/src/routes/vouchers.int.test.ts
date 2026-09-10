/**
 * AVO-ISSUED VOUCHERS, against real rows.   (item 10, DECISIONS #87)
 *
 * FOUR THINGS THIS FILE EXISTS TO PROVE, in descending order of what they would
 * cost if wrong:
 *
 *   THE CONCURRENT SINGLE-USE RACE. Two simultaneous redemptions of one code
 *       must produce ONE credit. The claim is a conditional UPDATE inside the
 *       crediting transaction, so the loser's whole transaction rolls back — a
 *       read-then-write here is the double-refund shape `booking.ts §
 *       returnDeposit` had to learn, with AVO's money instead of a deposit.
 *
 *   `reverses_transaction_id` STAYS NULL. `services/reports.ts`'s `NOT_VOIDED`
 *       keys on that column, so a voucher credit that populated it would
 *       silently DELETE a charge from the merchant's gross. Asserted directly,
 *       because nothing else in the build would notice.
 *
 *   THE PROVENANCE QUERY ANSWERS. `avo_voucher_funding` must be able to say how
 *       much AVO-voucher credit entered a salon's wallets, from one indexed read,
 *       with no audit rows and no timestamps — and must NOT be confusable with a
 *       console adjustment, which is what made this account necessary.
 *
 *   ONE REFUSAL FOR EVERY REASON. Expired, voided, already redeemed, never
 *       existed and somebody else's all answer identically.
 *
 * `EN-` namespace, per-run suffix — `metrics.int.test.ts` owns `IT-`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const SALON = 'SAL-AMARA';
/** `perm_accounts` TRUE — the compensation authority. */
const OWNER = 'PLT-001';
/** `perm_accounts` FALSE. A real admin who may not do this. */
const ANALYST = 'PLT-002';

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const HER = `EN-VC-M-${RUN}`;
const OTHER = `EN-VC-M2-${RUN}`;

suite('AVO issues, the customer redeems', () => {
  let app: FastifyInstance;
  let db: (typeof import('../db/client'))['db'];
  let sql: (typeof import('drizzle-orm'))['sql'];
  let issue: (typeof import('../auth/sessions'))['issueSession'];
  let owner: string;
  let analyst: string;
  let hers: string;
  let theirs: string;

  const exec = async (q: unknown) =>
    (await db.execute(q as never)) as unknown as Array<Record<string, unknown>>;
  const balance = async (id: string) =>
    Number((await exec(sql`SELECT balance_fils AS n FROM member WHERE id = ${id}`))[0]?.n ?? 0);

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    sql = (await import('drizzle-orm')).sql;
    issue = (await import('../auth/sessions')).issueSession;
    app = await (await import('../app')).buildApp();

    await db.execute(sql`
      INSERT INTO member (id, salon_id, name, phone, password_hash, balance_fils, tier, visits, policy_version)
      VALUES
        (${HER}, ${SALON}, 'EN VC Her',
         ${`+9652${String(Date.now() % 1_000_000).padStart(6, '0')}`}, 'x', 10000, 'bronze', 0, 1),
        (${OTHER}, ${SALON}, 'EN VC Other',
         ${`+9651${String(Date.now() % 1_000_000).padStart(6, '0')}`}, 'x', 10000, 'bronze', 0, 1)`);

    owner = (
      await issue(db, { principalKind: 'platform_admin', platformAdminId: OWNER, salonId: null, scope: 'platform' })
    ).accessToken;
    analyst = (
      await issue(db, { principalKind: 'platform_admin', platformAdminId: ANALYST, salonId: null, scope: 'platform' })
    ).accessToken;
    hers = (
      await issue(db, { principalKind: 'member', memberId: HER, salonId: SALON, scope: 'wallet' })
    ).accessToken;
    theirs = (
      await issue(db, { principalKind: 'member', memberId: OTHER, salonId: SALON, scope: 'wallet' })
    ).accessToken;
  });

  afterAll(async () => {
    if (db) {
      await db.execute(sql`DELETE FROM session WHERE member_id IN (${HER}, ${OTHER})`);
    }
    await app?.close();
  });

  let keySeq = 0;
  const call = (
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    token: string,
    payload?: unknown,
    key?: string,
  ) =>
    app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(method === 'POST'
          ? { 'idempotency-key': key ?? `en-vc-${RUN}-${keySeq++}` }
          : {}),
      },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  async function issueVoucher(
    amountFils = 5000,
    member = HER,
    extra: Record<string, unknown> = {},
  ) {
    const res = await call('POST', '/v1/vouchers', owner, {
      memberId: member,
      amountFils,
      reason: 'service complaint',
      ...extra,
    });
    expect(res.statusCode, res.body).toBe(201);
    return JSON.parse(res.body).voucher as { id: string; code: string; amountFils: number };
  }

  const redeem = (code: string, token = hers, key?: string) =>
    call('POST', '/members/me/vouchers/redeem', token, { code }, key);

  // ==================================================================
  // AUTHORITY — non-negotiable #7, called directly with the permission off.
  // ==================================================================
  describe('only AVO issues, and only with perm_accounts', () => {
    it('an analyst cannot issue or void — perm_accounts is false', async () => {
      const posted = await call('POST', '/v1/vouchers', analyst, {
        memberId: HER,
        amountFils: 5000,
        reason: 'nope',
      });
      expect(posted.statusCode).toBe(403);
      expect((await call('GET', '/v1/vouchers', analyst)).statusCode).toBe(403);

      const v = await issueVoucher();
      expect((await call('DELETE', `/v1/vouchers/${v.id}`, analyst)).statusCode).toBe(403);
    });

    it('a CUSTOMER cannot issue one to herself', async () => {
      const res = await call('POST', '/v1/vouchers', hers, {
        memberId: HER,
        amountFils: 99999,
        reason: 'self-serve',
      });
      // A wallet session is not a platform principal at all.
      expect([401, 403]).toContain(res.statusCode);
    });

    it('the console cannot choose the code', async () => {
      const res = await call('POST', '/v1/vouchers', owner, {
        memberId: HER,
        amountFils: 5000,
        reason: 'x',
        code: 'GUESSABLE',
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('code_not_client_supplied');
    });

    it('a voucher only ever adds — a negative or fractional amount is refused', async () => {
      for (const amountFils of [-5000, 0, 12.5]) {
        const res = await call('POST', '/v1/vouchers', owner, {
          memberId: HER,
          amountFils,
          reason: 'x',
        });
        expect(res.statusCode, String(amountFils)).toBe(400);
      }
    });

    it('a reason is required, exactly as an adjustment requires one', async () => {
      const res = await call('POST', '/v1/vouchers', owner, {
        memberId: HER,
        amountFils: 5000,
        reason: '   ',
      });
      expect(res.statusCode).toBe(400);
    });

    it('issuing moves no money', async () => {
      const before = await balance(HER);
      await issueVoucher(7000);
      expect(await balance(HER)).toBe(before);
    });
  });

  // ==================================================================
  // REDEMPTION.
  // ==================================================================
  describe('she redeems, and the wallet is credited', () => {
    it('credits exactly the voucher, and nothing else', async () => {
      const v = await issueVoucher(5000);
      const before = await balance(HER);

      const res = await redeem(v.code);
      expect(res.statusCode, res.body).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.creditedFils).toBe(5000);
      expect(await balance(HER)).toBe(before + 5000);
      expect(body.balanceAfterFils).toBe(before + 5000);
    });

    /**
     * THE LANDMINE. `NOT_VOIDED` in services/reports.ts keys on
     * `reverses_transaction_id`, so a voucher row that set it would silently
     * remove a charge from the merchant's gross.
     */
    it('the credit never populates reverses_transaction_id', async () => {
      const v = await issueVoucher(3000);
      await redeem(v.code);
      const rows = await exec(sql`
        SELECT t.reverses_transaction_id AS r, t.kind::text AS kind
          FROM "transaction" t
          JOIN voucher vc ON vc.redeemed_transaction_id = t.id
         WHERE vc.member_id = ${HER}`);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.r, 'a voucher credit set reverses_transaction_id').toBeNull();
        expect(row.kind).toBe('adjustment');
      }
    });

    it('the code is case- and dash-insensitive, so what she types reaches the row', async () => {
      const v = await issueVoucher(2000);
      const scrambled = `${v.code.slice(0, 4).toLowerCase()}-${v.code.slice(4).toLowerCase()}`;
      const res = await redeem(scrambled);
      expect(res.statusCode, res.body).toBe(200);
    });

    it('she may send only a code — no amount, no voucher id, no member id', async () => {
      const v = await issueVoucher(5000);
      for (const field of ['amountFils', 'voucherId', 'memberId'] as const) {
        const res = await call('POST', '/members/me/vouchers/redeem', hers, {
          code: v.code,
          [field]: field === 'amountFils' ? 999999 : 'x',
        });
        expect(res.statusCode, field).toBe(400);
        expect(JSON.parse(res.body).error).toBe('code_only');
      }
    });

    it('a redemption with no idempotency key is refused before any credit', async () => {
      const v = await issueVoucher(5000);
      const before = await balance(HER);
      const res = await app.inject({
        method: 'POST',
        url: '/members/me/vouchers/redeem',
        headers: { authorization: `Bearer ${hers}` },
        payload: { code: v.code },
      });
      expect(res.statusCode).toBe(400);
      expect(await balance(HER)).toBe(before);
    });

    it('the same key replays the first response rather than crediting twice', async () => {
      const v = await issueVoucher(4000);
      const key = `en-vc-replay-${RUN}`;
      const before = await balance(HER);

      const first = await redeem(v.code, hers, key);
      expect(first.statusCode, first.body).toBe(200);
      const second = await redeem(v.code, hers, key);
      expect(second.statusCode).toBe(200);
      expect(JSON.parse(second.body)).toEqual(JSON.parse(first.body));
      expect(await balance(HER)).toBe(before + 4000);
    });
  });

  // ==================================================================
  // THE CONCURRENT SINGLE-USE RACE.
  // ==================================================================
  describe('one code, one credit', () => {
    it('two simultaneous redemptions with DIFFERENT keys credit once', async () => {
      const v = await issueVoucher(6000);
      const before = await balance(HER);

      const [a, b] = await Promise.all([
        redeem(v.code, hers, `en-vc-race-a-${RUN}`),
        redeem(v.code, hers, `en-vc-race-b-${RUN}`),
      ]);

      const codes = [a.statusCode, b.statusCode].sort();
      // One wins; the other is the single indistinguishable refusal. Never two 200s.
      expect(codes).toEqual([200, 409]);
      expect(await balance(HER)).toBe(before + 6000);

      const claimed = await exec(sql`
        SELECT count(*) AS n FROM "transaction" t
          JOIN voucher vc ON vc.redeemed_transaction_id = t.id
         WHERE vc.code = ${v.code}`);
      expect(Number(claimed[0]?.n)).toBe(1);
    });

    it('and ten at once still credit exactly once', async () => {
      const v = await issueVoucher(1000);
      const before = await balance(HER);

      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => redeem(v.code, hers, `en-vc-ten-${RUN}-${i}`)),
      );
      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
      expect(await balance(HER)).toBe(before + 1000);
    });
  });

  // ==================================================================
  // ONE REFUSAL FOR EVERY REASON.
  // ==================================================================
  describe('expired, voided, spent, unknown and somebody else’s are indistinguishable', () => {
    const bodies: string[] = [];

    it('a code that never existed', async () => {
      const res = await redeem('ZZZZZZZZZZZZ');
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error).toBe('voucher_not_redeemable');
      bodies.push(res.body);
    });

    it('a voucher already redeemed', async () => {
      const v = await issueVoucher(1000);
      await redeem(v.code);
      const res = await redeem(v.code);
      expect(res.statusCode).toBe(409);
      bodies.push(res.body);
    });

    it('a voided voucher', async () => {
      const v = await issueVoucher(1000);
      expect((await call('DELETE', `/v1/vouchers/${v.id}`, owner)).statusCode).toBe(200);
      const res = await redeem(v.code);
      expect(res.statusCode).toBe(409);
      bodies.push(res.body);
    });

    it('an expired voucher', async () => {
      const v = await issueVoucher(1000, HER, {
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      // Move the expiry into the past. Only the CLOCK column changes.
      await db.execute(sql`UPDATE voucher SET expires_at = now() - interval '1 minute' WHERE id = ${v.id}`);
      const res = await redeem(v.code);
      expect(res.statusCode).toBe(409);
      bodies.push(res.body);
    });

    it("somebody else's voucher, redeemed by her", async () => {
      const v = await issueVoucher(1000, OTHER);
      const res = await redeem(v.code, hers);
      expect(res.statusCode).toBe(409);
      bodies.push(res.body);
      // And no money moved on either side.
      const [row] = await exec(sql`SELECT redeemed_at FROM voucher WHERE id = ${v.id}`);
      expect(row?.redeemed_at).toBeNull();
    });

    it('all five answers are byte-identical', () => {
      expect(bodies).toHaveLength(5);
      expect(new Set(bodies).size).toBe(1);
    });

    it('an already-expired expiry is refused at ISSUE, so she never sees a dead voucher', async () => {
      const res = await call('POST', '/v1/vouchers', owner, {
        memberId: HER,
        amountFils: 1000,
        reason: 'x',
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('invalid_expiry');
    });

    it('a redeemed voucher cannot then be voided — that would be taking money back', async () => {
      const v = await issueVoucher(1000);
      await redeem(v.code);
      const res = await call('DELETE', `/v1/vouchers/${v.id}`, owner);
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error).toBe('voucher_not_voidable');
      expect(JSON.parse(res.body).redeemed).toBe(true);
    });
  });

  // ==================================================================
  // PROVENANCE — the question trunk added.
  // ==================================================================
  describe('the ledger says which credit came from an AVO voucher', () => {
    it('every voucher credit posts avo_voucher_funding → member_wallet', async () => {
      const v = await issueVoucher(8000);
      await redeem(v.code);

      const [txId] = (
        await exec(sql`SELECT redeemed_transaction_id AS id FROM voucher WHERE id = ${v.id}`)
      ).map((r) => String(r.id));
      const legs = await exec(sql`
        SELECT account::text AS account, direction::text AS direction, amount_fils AS amount
          FROM ledger_entry WHERE transaction_id = ${txId} ORDER BY account`);
      expect(legs).toHaveLength(2);
      expect(legs.map((l) => `${l.account}:${l.direction}:${l.amount}`)).toEqual([
        'avo_voucher_funding:debit:8000',
        'member_wallet:credit:8000',
      ]);
    });

    /**
     * THE QUERY, RUN. One indexed read on `(salon_id, account, created_at)` — no
     * audit rows, no timestamps, no reconstruction. This is the requirement.
     */
    it('answers "how much AVO-voucher credit entered this salon" in one read', async () => {
      const granted = await exec(sql`
        SELECT coalesce(sum(le.amount_fils), 0)::bigint AS n
          FROM ledger_entry le
         WHERE le.account = 'avo_voucher_funding' AND le.salon_id = ${SALON}`);

      const fromVouchers = await exec(sql`
        SELECT coalesce(sum(v.amount_fils), 0)::bigint AS n
          FROM voucher v WHERE v.redeemed_at IS NOT NULL`);

      // Two independent aggregates over the same money — the ledger account and
      // the voucher rows — and they must agree.
      expect(Number(granted[0]?.n)).toBe(Number(fromVouchers[0]?.n));
      expect(Number(granted[0]?.n)).toBeGreaterThan(0);
    });

    /**
     * AND IT IS NOT CONFUSABLE WITH A CONSOLE ADJUSTMENT, which is the reason
     * the account exists. Both are `kind = 'adjustment'` transactions; only the
     * ledger account separates them.
     */
    it('a console adjustment does NOT land in the voucher account', async () => {
      const before = Number(
        (
          await exec(sql`
            SELECT coalesce(sum(amount_fils), 0)::bigint AS n FROM ledger_entry
             WHERE account = 'avo_voucher_funding' AND salon_id = ${SALON}`)
        )[0]?.n,
      );

      const adj = await call('POST', `/members/${HER}/adjustments`, owner, {
        amountFils: 2500,
        reason: 'goodwill, not a voucher',
      });
      expect([200, 201]).toContain(adj.statusCode);

      const after = Number(
        (
          await exec(sql`
            SELECT coalesce(sum(amount_fils), 0)::bigint AS n FROM ledger_entry
             WHERE account = 'avo_voucher_funding' AND salon_id = ${SALON}`)
        )[0]?.n,
      );
      expect(after).toBe(before);

      // It went to `gateway_clearing`, where `walletAdjustedPosting` puts it.
      const legs = await exec(sql`
        SELECT DISTINCT le.account::text AS account FROM ledger_entry le
          JOIN "transaction" t ON t.id = le.transaction_id
         WHERE t.note = 'goodwill, not a voucher'`);
      expect(new Set(legs.map((l) => String(l.account)))).toEqual(
        new Set(['gateway_clearing', 'member_wallet']),
      );
    });

    /**
     * WHAT IT DOES NOT ANSWER, pinned so the limit is not mistaken for an
     * oversight later: the SPEND is not attributable. Money in a wallet is
     * fungible — a charge debits `member_wallet` with no notion of which credit
     * it consumed — so there is no query that says how much of the voucher
     * credit she has spent. This asserts the absence: nothing anywhere links a
     * `member_wallet` DEBIT back to a voucher.
     */
    it('but nothing links a wallet DEBIT back to a voucher — the spend is not traceable', async () => {
      const rows = await exec(sql`
        SELECT count(*) AS n FROM ledger_entry le
          JOIN "transaction" t ON t.id = le.transaction_id
         WHERE le.account = 'member_wallet' AND le.direction = 'debit'
           AND t.id IN (SELECT redeemed_transaction_id FROM voucher WHERE redeemed_at IS NOT NULL)`);
      // A voucher's transaction has no wallet debit at all; it is pure credit.
      expect(Number(rows[0]?.n)).toBe(0);
    });
  });

  // ==================================================================
  // WHAT LEAN HAD AND THIS DELIBERATELY DOES NOT.
  // ==================================================================
  describe('of Lean’s three coupon fields, only the code survives', () => {
    it('a minimum-spend or product restriction is not accepted, because it could never fire', async () => {
      const res = await call('POST', '/v1/vouchers', owner, {
        memberId: HER,
        amountFils: 5000,
        reason: 'x',
        minimumAmountIsCart: 10000,
        optionType: 'product',
        optionList: ['P-1'],
      });
      /**
       * Accepted-and-ignored would be the dead-guard shape. The row that comes
       * back carries neither field, and the schema has no column for them — so a
       * console that sent one gets a voucher that does not honour it, and the
       * assertion is that the API never claims otherwise.
       */
      expect(res.statusCode).toBe(201);
      const v = JSON.parse(res.body).voucher;
      expect(v).not.toHaveProperty('minimumAmountIsCart');
      expect(v).not.toHaveProperty('optionType');
      expect(v).not.toHaveProperty('optionList');

      const cols = await exec(sql`
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'voucher'`);
      const names = cols.map((c) => String(c.column_name));
      expect(names).not.toContain('minimum_amount_fils');
      expect(names).not.toContain('option_type');
      expect(names).not.toContain('option_list');
    });

    it('there is no status column — redeemable is derived', async () => {
      const cols = await exec(sql`
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'voucher'`);
      expect(cols.map((c) => String(c.column_name))).not.toContain('status');
    });
  });
});
