/**
 * A PRICE A MANAGER TYPED — proved against a real database and the real handler.
 *
 * The scanner could only ever charge what was on the service menu. Aftab ruled
 * the authority to type a figure to MANAGERS. Two things therefore have to be
 * true, and this file exists because neither can be proved without rows:
 *
 *   THE GATE REFUSES, AND IT REFUSES BECAUSE OF THE PERMISSION. Non-negotiable
 *   #7 is explicit: "Every gated endpoint needs a test that calls it directly
 *   with the permission off." So the refusal is asserted against a REAL frontdesk
 *   PIN session for ST-002 (`perms.void = false`, seeded that way deliberately),
 *   and — the half that makes it evidence rather than a coincidence — the
 *   IDENTICAL body is then sent by ST-001 and must succeed. A suite with only the
 *   refusal passes just as happily against an endpoint that is broken for
 *   everybody.
 *
 *   A REFUSED CUSTOM AMOUNT MOVED NO MONEY. Every refusal here asserts the
 *   balance is untouched and no `transaction` row exists, for the reason
 *   `scannerLimit.int.test.ts` gives: a control that fires after the debit is
 *   worse than no control, because it refuses the customer AND charges her.
 *
 * WHY `perms.void` AND NOT `perms.charges` — the long argument is in
 * `routes/charges.ts`. The short one, and the reason ST-002 is the right fixture:
 * `charges: false, void: false` is a frontdesk, and `charges: true, void: false`
 * is the supervisor shape — trusted to READ the till, not to move money. Both
 * must be refused, and the second is the case a `charges`-based gate would let
 * through. ST-002 proves the first directly; `the supervisor shape` spec below
 * proves the second by granting `charges` and leaving `void` off.
 *
 * A FRESH MEMBER PER TEST, minted here rather than reusing the seeded 8842.
 * These specs debit real balances and write real audit rows; sharing a fixture
 * would make every assertion depend on what ran before it, and the suite already
 * runs `fileParallelism: false` for exactly that class of coupling.
 *
 * NOTHING IS CLEANED UP AND NOTHING NEEDS TO BE. `avo_app` cannot DELETE the
 * append-only tables this touches (`audit_log`, migration 0001), so a suite that
 * tidied would have to connect as the owner and would then be proving the
 * behaviour under privileges production does not have.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const INT_URL = process.env.AVO_INT_DATABASE_URL;

/** Skip rather than connect — `vitest.int.config.ts` § the empty-string fallback. */
const suite = INT_URL ? describe : describe.skip;

const SALON = 'SAL-AMARA';
/** Noura — manager, every permission, `void` included. */
const MANAGER = 'ST-001';
/** Hessa — frontdesk. `charges: false, void: false`, seeded that way on purpose. */
const FRONTDESK = 'ST-002';
/** 8.000 KD, the design's blow-dry. The control for "a menu charge is unchanged". */
const SERVICE = 'SV-01';

suite('POST /charges — a custom amount', () => {
  let app: FastifyInstance;

  let db: typeof import('../db/client')['db'];
  let member: typeof import('../db/schema/member')['member'];
  let transaction: typeof import('../db/schema/transaction')['transaction'];
  let auditLog: typeof import('../db/schema/audit')['auditLog'];
  let staffUser: typeof import('../db/schema/staff')['staffUser'];
  let scannerAttempt: typeof import('../db/schema/session')['scannerAttempt'];
  let charge: typeof import('../services/charge');
  let revenue: typeof import('../money/revenue');
  let orm: typeof import('drizzle-orm');
  let issueSession: typeof import('../auth/sessions')['issueSession'];

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    member = (await import('../db/schema/member')).member;
    transaction = (await import('../db/schema/transaction')).transaction;
    auditLog = (await import('../db/schema/audit')).auditLog;
    staffUser = (await import('../db/schema/staff')).staffUser;
    scannerAttempt = (await import('../db/schema/session')).scannerAttempt;
    charge = await import('../services/charge');
    revenue = await import('../money/revenue');
    orm = await import('drizzle-orm');
    issueSession = (await import('../auth/sessions')).issueSession;
    app = await (await import('../app')).buildApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  /**
   * A real scanner session for a real staff row, on a fresh device.
   *
   * A real session and not an `AVO_TEST_PRINCIPALS` shim: the shim invents a
   * principal, and a permission spec run against an invented principal proves
   * nothing about the `staff_user` row the gate actually reads. `perms` are read
   * from that row on EVERY request (`auth/principal.ts`), so this is the only
   * shape of session that can put the permission under test.
   */
  async function tillFor(staffId: string): Promise<{ bearer: string; deviceId: string }> {
    const deviceId = `DEV-INT-CUSTOM-${randomUUID()}`;
    const s = await issueSession(db, {
      principalKind: 'staff',
      staffId,
      salonId: SALON,
      scope: 'scanner',
      deviceId,
    });
    return { bearer: s.accessToken, deviceId };
  }

  async function sessionFor(staffId: string): Promise<string> {
    return (await tillFor(staffId)).bearer;
  }

  /** A customer with money, belonging to nobody else's assertions. */
  async function customer(balanceFils = 150_000): Promise<string> {
    const id = `MB-CUSTOM-${randomUUID().slice(0, 8)}`;
    await db.insert(member).values({
      id,
      salonId: SALON,
      name: 'Int Custom',
      // Unique per member: `member_phone_uq` is real and a collision here would
      // read as a mysterious insert failure rather than as the fixture's fault.
      phone: `+9659${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`,
      passwordHash: '$argon2id$fake-not-a-credential',
      balanceFils: balanceFils as never,
      visits: 0,
      tier: 'bronze',
      policyVersion: 3,
    });
    return id;
  }

  function post(bearer: string, payload: Record<string, unknown>, key = randomUUID()) {
    return app.inject({
      method: 'POST',
      url: '/charges',
      headers: { authorization: `Bearer ${bearer}`, 'idempotency-key': `int-custom-${key}` },
      payload,
    });
  }

  async function balanceOf(id: string): Promise<number> {
    const [row] = await db
      .select({ b: member.balanceFils })
      .from(member)
      .where(orm.eq(member.id, id))
      .limit(1);
    return row?.b ?? -1;
  }

  async function rowsFor(id: string) {
    return db.select().from(transaction).where(orm.eq(transaction.memberId, id));
  }

  /** Every refusal has to be able to say this, and it is the point of the suite. */
  async function assertNothingMoved(id: string, expected: number): Promise<void> {
    expect(await balanceOf(id)).toBe(expected);
    expect(await rowsFor(id)).toHaveLength(0);
  }

  // ------------------------------------------------------------- the gate ----

  describe('the permission is enforced server-side', () => {
    it('refuses a frontdesk PIN holder — perms.void is off', async () => {
      const bearer = await sessionFor(FRONTDESK);
      const m = await customer();

      const res = await post(bearer, {
        memberId: m,
        amountFils: 25_000,
        reason: 'bridal package',
      });

      expect(res.statusCode).toBe(403);
      /**
       * THE COPY, not only the status. `PERMISSION_COPY.void` is design copy from
       * the scanner's locked state and four surfaces assert on it verbatim; a spec
       * that checked 403 alone would pass against a refusal for the WRONG reason —
       * a surface mismatch, a missing member, an unrelated gate — which is the
       * failure mode `scannerLimit.int.test.ts` § THE CODE, NOT THE STATUS names.
       */
      expect(JSON.parse(res.body).message).toBe(
        "You don't have permission to void a charge. A manager can grant it.",
      );
      await assertNothingMoved(m, 150_000);
    });

    it('refuses the supervisor shape too — charges on, void off', async () => {
      /**
       * THE SPEC THAT RULES OUT `perms.charges` AS THE GATE.
       *
       * `charges` is the "senior permission" and the tempting one to reuse. It is
       * a READ — api-contract.md § StaffUser, "can open Today's charges on the
       * scanner" — and someone trusted to read the till is not thereby trusted to
       * invent a price. Granting `charges` and leaving `void` off is exactly that
       * person, and if the gate ever moves to `charges` this spec goes red.
       *
       * The grant is restored in a `finally`, because ST-002 is a shared seeded
       * fixture that other specs read.
       */
      const restore = async (charges: boolean) => {
        await db
          .update(staffUser)
          .set({ permCharges: charges })
          .where(orm.eq(staffUser.id, FRONTDESK));
      };
      await restore(true);
      try {
        const bearer = await sessionFor(FRONTDESK);
        const m = await customer();

        const res = await post(bearer, { memberId: m, amountFils: 25_000, reason: 'x' });

        expect(res.statusCode).toBe(403);
        await assertNothingMoved(m, 150_000);
      } finally {
        await restore(false);
      }
    });

    it('the control: the identical body from a manager succeeds', async () => {
      /**
       * WITHOUT THIS THE REFUSAL ABOVE IS NOT EVIDENCE. A gate that refuses
       * everybody passes the permission-off spec perfectly. The body is
       * byte-identical; the only thing that differs is whose PIN session it came
       * from, which is the whole claim.
       */
      const bearer = await sessionFor(MANAGER);
      const m = await customer();

      const res = await post(bearer, {
        memberId: m,
        amountFils: 25_000,
        reason: 'bridal package',
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).customAmount).toBe(true);
      expect(await balanceOf(m)).toBe(125_000);
    });

    it('refuses rather than ignores: an unauthorised amountFils never falls back to the menu', async () => {
      /**
       * ===================================================================
       * THE SPEC THIS WHOLE FEATURE IS SHAPED AROUND.
       * ===================================================================
       * The dangerous implementation is not one that forgets the gate. It is one
       * that checks the permission INSIDE the custom branch, so an unauthorised
       * `amountFils` is silently dropped and the basket is priced instead. The
       * staff member types 40.000, the server charges the menu's 8.000, and the
       * response says the charge succeeded — a different number moved and nobody
       * was told. That is the silent money bug api-contract.md's idempotency
       * addendum rules against in a different costume.
       *
       * So the gate is on the PRESENCE of the field. A frontdesk sending both a
       * basket and a figure is refused; her customer is not charged 8.000.
       */
      const bearer = await sessionFor(FRONTDESK);
      const m = await customer();

      const res = await post(bearer, {
        memberId: m,
        serviceIds: [SERVICE],
        amountFils: 40_000,
        reason: 'nope',
      });

      expect(res.statusCode).toBe(403);
      await assertNothingMoved(m, 150_000);
    });

    it('decides authority before it spends the till budget', async () => {
      /**
       * WHERE THE GATE SITS, not only that it exists.
       *
       * `chargeScannerBudget` WRITES — a `scanner_attempt` row, deliberately, so
       * that "a refusal is an attempt" (services/scannerLimit.ts, and
       * `signupLimit.ts`'s finding that forty refused probes left the counter
       * empty and the oracle "was not bounded at all"). That makes its position
       * relative to this gate a real decision rather than a style one: with the
       * permission check BELOW it, a frontdesk who cannot use the feature can
       * still spend the budget her colleagues share by tapping at it, and an
       * authority decided after a write is decided too late for non-negotiable #7.
       *
       * The check is hoisted above it in `routes/charges.ts`. This is what stops
       * it drifting back down, which nothing else in the suite would notice.
       */
      const t = await tillFor(FRONTDESK);
      const m = await customer();

      const res = await post(t.bearer, { memberId: m, amountFils: 25_000, reason: 'r' });
      expect(res.statusCode).toBe(403);

      const [row] = await db
        .select({ n: orm.sql<number>`count(*)::int` })
        .from(scannerAttempt)
        .where(orm.eq(scannerAttempt.deviceId, t.deviceId));
      expect(row?.n).toBe(0);
    });
  });

  // ------------------------------------------------------------- the bounds --

  describe('the bounds', () => {
    it('refuses an amount above the ceiling, and moves nothing', async () => {
      const bearer = await sessionFor(MANAGER);
      const m = await customer(900_000);

      const res = await post(bearer, {
        memberId: m,
        amountFils: charge.CUSTOM_AMOUNT_MAX_FILS + 1,
        reason: 'an extra zero',
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('amount_above_ceiling');
      /**
       * THE BALANCE IS DELIBERATELY LARGE ENOUGH TO PAY IT. The wallet is the
       * other bound on a typed figure, and it is loosest exactly where a typo is
       * most expensive — so a spec run against a customer who could not afford
       * the mistake would pass against no ceiling at all.
       */
      await assertNothingMoved(m, 900_000);
    });

    it('allows the ceiling exactly — it is a maximum, not a strict bound', async () => {
      const bearer = await sessionFor(MANAGER);
      const m = await customer(900_000);

      const res = await post(bearer, {
        memberId: m,
        amountFils: charge.CUSTOM_AMOUNT_MAX_FILS,
        reason: 'the whole bridal party',
      });

      expect(res.statusCode).toBe(200);
    });

    it('refuses a KWD decimal, a zero and a negative', async () => {
      const bearer = await sessionFor(MANAGER);

      for (const amountFils of [18.5, 0, -10_000]) {
        const m = await customer();
        const res = await post(bearer, { memberId: m, amountFils, reason: 'r' });

        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body).error).toBe('invalid_amount');
        await assertNothingMoved(m, 150_000);
      }
    });

    it('refuses a basket and a figure together rather than picking one', async () => {
      const bearer = await sessionFor(MANAGER);
      const m = await customer();

      const res = await post(bearer, {
        memberId: m,
        serviceIds: [SERVICE],
        amountFils: 25_000,
        reason: 'r',
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('ambiguous_pricing');
      await assertNothingMoved(m, 150_000);
    });

    it('refuses a typed price with no reason, and says it is the reason that is missing', async () => {
      /**
       * THE MESSAGE, NOT ONLY THE CODE, AND THIS SPEC IS WHY.
       *
       * Run against the build BEFORE this feature existed, the status and the code
       * assertions alone both PASSED — because a body with no `serviceIds` was
       * refused as `400 invalid_request` for not having a basket. It was the one
       * spec in this file that went green against code that did not implement any
       * of it: a spec that could not go red, which is worth exactly nothing.
       *
       * `requireString` names its field, so pinning the sentence is what makes the
       * refusal provably about the reason.
       */
      const bearer = await sessionFor(MANAGER);
      const m = await customer();

      const res = await post(bearer, { memberId: m, amountFils: 25_000 });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('invalid_request');
      expect(JSON.parse(res.body).message).toBe('reason is required.');
      await assertNothingMoved(m, 150_000);
    });
  });

  // ------------------------------------------------- it is visible afterwards --

  describe('a custom charge is distinguishable from a priced one', () => {
    it('marks the row, carries the reason, and keeps its basket hash', async () => {
      const bearer = await sessionFor(MANAGER);
      const m = await customer();

      const res = await post(bearer, {
        memberId: m,
        amountFils: 32_000,
        reason: 'half colour, half treatment',
      });
      expect(res.statusCode).toBe(200);

      const [row] = await rowsFor(m);
      expect(row?.customAmount).toBe(true);
      expect(row?.note).toBe('half colour, half treatment');
      expect(row?.amountFils).toBe(-32_000);
      /**
       * `transaction_custom_amount_has_basket_hash` is what keeps the
       * near-duplicate guard reachable. Asserted here as well as in `db:verify`
       * because the constraint proves the row cannot COMMIT without one, and this
       * proves the handler actually computes one — a handler could satisfy the
       * CHECK with a constant.
       */
      expect(row?.basketHash).toBe(charge.customAmountHashFor(32_000 as never));
    });

    it('the control: a menu charge is not marked and carries no note', async () => {
      const bearer = await sessionFor(MANAGER);
      const m = await customer();

      expect((await post(bearer, { memberId: m, serviceIds: [SERVICE] })).statusCode).toBe(200);

      const [row] = await rowsFor(m);
      expect(row?.customAmount).toBe(false);
      expect(row?.note).toBeNull();
      // The menu hash, not the amount hash. The two must never collide.
      expect(row?.basketHash).toBe(charge.basketHashFor([SERVICE]));
      expect(row?.basketHash).not.toBe(charge.customAmountHashFor(8000 as never));
    });

    it('writes its own audit action, naming the gross and the reason', async () => {
      const bearer = await sessionFor(MANAGER);
      const m = await customer();

      const res = await post(bearer, {
        memberId: m,
        amountFils: 47_500,
        reason: 'goodwill on a redo',
      });
      const txId = JSON.parse(res.body).transaction.id;

      const [row] = await db
        .select()
        .from(auditLog)
        .where(orm.and(orm.eq(auditLog.subjectType, 'transaction'), orm.eq(auditLog.subjectId, txId)))
        .limit(1);

      /**
       * THE ACTION STRING, because it is what the dashboard's audit log renders.
       * A typed price that read as "Charge taken" would be invisible in the one
       * place a merchant reviewing the month can actually look — `metadata` is not
       * on the face of that screen.
       */
      expect(row?.action).toBe('Custom amount charged');
      expect(row?.detail).toContain('47.500 KD custom amount charged');
      expect(row?.detail).toContain('goodwill on a redo');
      expect((row?.metadata as { customAmount: { amountFils: number } }).customAmount.amountFils).toBe(
        47_500,
      );
      expect(row?.kind).toBe('money');
      expect(row?.source).toBe('scanner');
    });

    it('is revenue like any other charge — transaction_revenue covers it', async () => {
      /**
       * `sales` gross and the artist-performance reconciliation both read
       * `transaction_revenue` (migration 0042). A custom charge silently outside
       * the view would make those two reports disagree, and would understate the
       * month by exactly the typed figures. The view has no `custom_amount`
       * predicate and must never acquire one.
       */
      const bearer = await sessionFor(MANAGER);
      const m = await customer();

      const res = await post(bearer, { memberId: m, amountFils: 19_000, reason: 'r' });
      const txId = JSON.parse(res.body).transaction.id;

      const worth = await revenue.readTransactionRevenue(db, txId);
      expect(worth).not.toBeNull();
      expect(worth?.earnedFils).toBe(19_000);
      expect(worth?.chargedFils).toBe(19_000);
      expect(worth?.depositAppliedFils).toBe(0);
    });

    it('shows on today’s charges as a typed price', async () => {
      const bearer = await sessionFor(MANAGER);
      const m = await customer();

      const res = await post(bearer, { memberId: m, amountFils: 21_000, reason: 'walk-in package' });
      const txId = JSON.parse(res.body).transaction.id;

      const list = await app.inject({
        method: 'GET',
        url: '/charges',
        headers: { authorization: `Bearer ${bearer}` },
      });
      expect(list.statusCode).toBe(200);

      const mine = (JSON.parse(list.body).items as Array<Record<string, unknown>>).find(
        (i) => i.id === txId,
      );
      expect(mine?.customAmount).toBe(true);
      expect(mine?.note).toBe('walk-in package');
    });
  });

  // ----------------------------------------------- the guarantees it inherits --

  describe('it inherits the charge path’s guarantees', () => {
    it('the near-duplicate guard sees a repeated typed figure, and the confirm gets through', async () => {
      /**
       * A DOUBLE-TAPPED CUSTOM AMOUNT IS THE WORST CASE OF THE CASE DECISIONS.md
       * item 3 was written for: the figure is typed, so it is large and arbitrary,
       * and there is no menu to make the repeat look deliberate. The guard is only
       * reachable because `basket_hash` is populated for a typed price —
       * `customAmountHashFor`, and the CHECK behind it.
       */
      const bearer = await sessionFor(MANAGER);
      const m = await customer();

      expect((await post(bearer, { memberId: m, amountFils: 30_000, reason: 'r' })).statusCode).toBe(
        200,
      );

      const second = await post(bearer, { memberId: m, amountFils: 30_000, reason: 'r' });
      expect(second.statusCode).toBe(409);
      expect(JSON.parse(second.body).error).toBe('possible_duplicate');
      // The copy names what was repeated. "the same services" would be false here.
      expect(JSON.parse(second.body).message).toContain('as a custom amount');
      expect(await balanceOf(m)).toBe(120_000);

      const confirmed = await post(bearer, {
        memberId: m,
        amountFils: 30_000,
        reason: 'r',
        confirmDuplicate: true,
      });
      expect(confirmed.statusCode).toBe(200);
      expect(await balanceOf(m)).toBe(90_000);
    });

    it('replays the same key with the same figure, and refuses a different one', async () => {
      /**
       * api-contract.md § "Addendum — idempotency key reused with a different
       * body", in the words of the ruling itself: "a customer who retries a 5 KD
       * top-up as 50 KD would be shown a 5 KD success and never learn the 50 never
       * happened." The typed amount is in the request hash for exactly this.
       */
      const bearer = await sessionFor(MANAGER);
      const m = await customer();
      const key = randomUUID();

      const first = await post(bearer, { memberId: m, amountFils: 12_000, reason: 'r' }, key);
      expect(first.statusCode).toBe(200);

      const replay = await post(bearer, { memberId: m, amountFils: 12_000, reason: 'r' }, key);
      expect(replay.statusCode).toBe(200);
      expect(JSON.parse(replay.body).transaction.id).toBe(JSON.parse(first.body).transaction.id);
      // Replayed, not re-executed: one debit, not two.
      expect(await balanceOf(m)).toBe(138_000);

      const mismatch = await post(bearer, { memberId: m, amountFils: 120_000, reason: 'r' }, key);
      expect(mismatch.statusCode).toBe(422);
      expect(await balanceOf(m)).toBe(138_000);
    });

    it('refuses when the wallet cannot pay, and nothing else happened', async () => {
      const bearer = await sessionFor(MANAGER);
      const m = await customer(5_000);

      const res = await post(bearer, { memberId: m, amountFils: 40_000, reason: 'r' });

      expect(res.statusCode).toBe(402);
      await assertNothingMoved(m, 5_000);
    });
  });
});
