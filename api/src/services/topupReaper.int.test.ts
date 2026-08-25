/**
 * The abandoned top-up reaper, proved against a real database, the real
 * `POST /topups` handler and the real sandbox gateway. DECISIONS.md #27.
 *
 * `vitest.int.config.ts` carries why this suite is separate and why it is not in
 * `pnpm check`. `topupLimit.int.test.ts` carries the shared house rules — deltas
 * rather than absolute counts, no cleanup of `topup_intent`, and the
 * `AVO_INT_DATABASE_URL` skip. All three apply here.
 *
 * ======================================================================
 * THE CLAIM WORTH HAVING: A REAPED INTENT CREDITS NOTHING
 * ======================================================================
 * The reaper writes a TERMINAL state on a row that sits on the path money enters
 * by, and `failed` has no arrow out of it. So the assertion that matters is not
 * "the status changed" — it is that nothing else did. Every reap spec below
 * checks four things together, which is the same standard the rate limiters were
 * held to and for the same reason:
 *
 *   member.balance_fils        unchanged, to the fils
 *   transaction                no new row for her
 *   ledger_entry               no new pair
 *   topup_intent.transaction_id / settled_at   still null
 *
 * The last one is not redundant. `topup_intent_succeeded_has_transaction` ties
 * those columns to `succeeded`, so a reap that somehow set them would fail the
 * CHECK rather than commit — asserting them is what proves the CHECK was never
 * the thing doing the work.
 *
 * ======================================================================
 * WHY IT DRIVES THE REAL ENDPOINT AND THEN BACKDATES ONE COLUMN
 * ======================================================================
 * `topup_intent` has a dozen NOT NULL columns, a gateway reference, a matching
 * `sandbox_gateway_payment` row and four CHECK constraints tying them together.
 * A hand-forged fixture would be a guess about the shape of the rows the reaper
 * is supposed to meet; `POST /topups` writes the real ones. That is the same
 * choice `topupLimit.int.test.ts` makes and it proves more.
 *
 * What the endpoint cannot produce is AGE. So each spec updates `created_at` on
 * the single intent it just created, to one hour past the window. Two notes on
 * why that is legitimate where truncating the table would not be:
 *
 *   - it touches exactly one row, which this spec created seconds earlier, and
 *     changes a column no invariant depends on. Migration 0004's trigger
 *     policies `status` transitions and returns early when the status is
 *     unchanged, so nothing is being routed around.
 *   - it is the honest simulation. `nowOverride` exists on `runTopUpReapOnce`
 *     and moving the clock a week forward would make EVERY open intent in the
 *     database a candidate — including the hundred `topupLimit.int.test.ts`
 *     leaves behind — which is a spec about the whole table rather than about
 *     its own effect on it. Backdating one row is the narrow version.
 *
 * MEMBER 8842, NOT 8843. `topupLimit.int.test.ts` spends 8843's whole hourly
 * top-up allowance by design, and `enforceTopUpLimits` is per member. Two suites
 * on one member is two tills spending one budget.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const SALON = 'SAL-AMARA';
/** Dana. Deliberately NOT the member the top-up limiter suite spends. */
const MEMBER = '8842';

suite('the abandoned top-up reaper', () => {
  let app: FastifyInstance;

  let db: typeof import('../db/client')['db'];
  let member: typeof import('../db/schema/member')['member'];
  let topUpIntent: typeof import('../db/schema/topup')['topUpIntent'];
  let transaction: typeof import('../db/schema/transaction')['transaction'];
  let ledgerEntry: typeof import('../db/schema/ledger')['ledgerEntry'];
  let sandboxGatewayPayment: typeof import('../db/schema/sandboxGateway')['sandboxGatewayPayment'];
  let reaper: typeof import('./topupReaper');
  let topup: typeof import('./topup');
  let sandbox: NonNullable<ReturnType<typeof import('../gateway')['sandboxGateway']>>;
  let orm: typeof import('drizzle-orm');
  let issueSession: typeof import('../auth/sessions')['issueSession'];

  let bearer = '';

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    member = (await import('../db/schema/member')).member;
    topUpIntent = (await import('../db/schema/topup')).topUpIntent;
    transaction = (await import('../db/schema/transaction')).transaction;
    ledgerEntry = (await import('../db/schema/ledger')).ledgerEntry;
    sandboxGatewayPayment = (await import('../db/schema/sandboxGateway')).sandboxGatewayPayment;
    reaper = await import('./topupReaper');
    topup = await import('./topup');
    orm = await import('drizzle-orm');
    issueSession = (await import('../auth/sessions')).issueSession;

    const gw = (await import('../gateway')).sandboxGateway();
    if (!gw) throw new Error('this suite requires GATEWAY_DRIVER=sandbox');
    sandbox = gw;

    app = await (await import('../app')).buildApp();

    const s = await issueSession(db, {
      principalKind: 'member',
      memberId: MEMBER,
      salonId: SALON,
      scope: 'wallet',
    });
    bearer = s.accessToken;
  });

  afterAll(async () => {
    await app?.close();
  });

  // ------------------------------------------------------------- helpers --

  /** A real intent through the real handler, with a real sandbox payment behind it. */
  async function startTopUp(amountFils = 5000): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/topups',
      headers: {
        authorization: `Bearer ${bearer}`,
        'idempotency-key': `int-reap-${randomUUID()}`,
      },
      payload: { amountFils, method: 'knet' },
    });
    expect(res.statusCode, res.body).toBe(200);
    return JSON.parse(res.body).id as string;
  }

  async function intentRow(id: string) {
    const [row] = await db.select().from(topUpIntent).where(orm.eq(topUpIntent.id, id)).limit(1);
    if (!row) throw new Error(`no intent ${id}`);
    return row;
  }

  /** One hour past the window, on one row. See the header. */
  async function backdatePastWindow(id: string): Promise<void> {
    const age = (reaper.TOPUP_REAP_AFTER_HOURS + 1) * 60 * 60_000;
    await db
      .update(topUpIntent)
      .set({ createdAt: new Date(Date.now() - age) })
      .where(orm.eq(topUpIntent.id, id));
  }

  /**
   * Everything a reap must not move, read at one instant. Three separate queries
   * a moment apart could each be right about a different database.
   */
  async function moneyState(): Promise<{
    balanceFils: number;
    transactions: number;
    ledgerEntries: number;
  }> {
    const [bal] = await db
      .select({ balanceFils: member.balanceFils })
      .from(member)
      .where(orm.eq(member.id, MEMBER));
    const [txs] = await db
      .select({ n: orm.sql<number>`count(*)::int` })
      .from(transaction)
      .where(orm.eq(transaction.memberId, MEMBER));
    const [led] = await db
      .select({ n: orm.sql<number>`count(*)::int` })
      .from(ledgerEntry)
      .where(orm.eq(ledgerEntry.memberId, MEMBER));
    return {
      balanceFils: bal?.balanceFils ?? -1,
      transactions: txs?.n ?? -1,
      ledgerEntries: led?.n ?? -1,
    };
  }

  /**
   * `limit` is generous on purpose. Candidates come back oldest-first and every
   * spec here backdates its intent a week, so a small batch would still reach
   * them — but two specs deliberately LEAVE an intent open and backdated
   * (the paid one and the unreachable one), so the standing candidate set grows
   * by one per run of this file. A batch that could not span it would start
   * skipping the newest spec's row after enough runs.
   */
  function reap() {
    return reaper.runTopUpReapOnce(db, { limit: 500 });
  }

  // --------------------------------------------------------------- specs --

  it('reaps a stale intent the processor still calls open — and credits nothing', async () => {
    const id = await startTopUp();
    const before = await intentRow(id);
    expect(before.status).toBe('redirected');
    expect(before.pspReference).toBeTruthy();

    /**
     * `pending` is what an abandoned MyFatoorah invoice reports for ever
     * (gateway/myfatoorah.ts § outcomeFor), so this is the real-world shape of
     * the row this job exists for — and the ONE arm where the window rather than
     * the gateway's answer carries the safety.
     */
    await sandbox.setOutcome(before.pspReference as string, 'pending');
    await backdatePastWindow(id);

    const money = await moneyState();
    const result = await reap();

    expect(result.expired).toBeGreaterThanOrEqual(1);
    expect(result.expiredStillOpenAtGateway).toBeGreaterThanOrEqual(1);

    const after = await intentRow(id);
    expect(after.status).toBe('failed');
    // The reason the schema declared and nothing had ever written.
    expect(after.failureReason).toBe('expired');

    // ---- THE CLAIM: a reaped intent credits nothing and moves no balance ----
    expect(after.transactionId).toBeNull();
    expect(after.settledAt).toBeNull();
    expect(await moneyState()).toEqual(money);
  });

  it('leaves an intent inside the window entirely alone', async () => {
    const id = await startTopUp();
    await sandbox.setOutcome((await intentRow(id)).pspReference as string, 'pending');
    // NOT backdated. Seconds old, which is the state of every intent belonging
    // to a customer who is on the hosted page right now.

    const money = await moneyState();
    await reap();

    const after = await intentRow(id);
    expect(after.status).toBe('redirected');
    expect(after.failureReason).toBeNull();
    expect(await moneyState()).toEqual(money);
  });

  it('never reaps an intent the processor says was PAID — it reports it instead', async () => {
    const id = await startTopUp();
    const row = await intentRow(id);
    // The sandbox's own default, and the shape of a lost webhook: the processor
    // took her money and this system has not credited her.
    await sandbox.setOutcome(row.pspReference as string, 'succeeded');
    await backdatePastWindow(id);

    const money = await moneyState();
    const result = await reap();

    const after = await intentRow(id);
    /**
     * UNTOUCHED and still OPEN, so the next `GET /topups/{id}` or a re-delivered
     * webhook can still settle it through the path built for that — and NOT
     * credited here either. Asserted before the report below on purpose: if the
     * `succeeded` veto is ever removed, the row falls straight through to
     * `settleFromGatewayRead` and the money assertion is the one that should be
     * seen failing, because it is the one that matters.
     */
    expect(after.status).toBe('redirected');
    expect(after.failureReason).toBeNull();
    expect(after.transactionId).toBeNull();
    expect(await moneyState()).toEqual(money);

    // And then: reported, so the customer owed money is visible to an operator.
    expect(result.awaitingCreditIds).toContain(id);
  });

  it('writes the processor’s own reason, not a guessed one, when it has one', async () => {
    const id = await startTopUp();
    await sandbox.setOutcome((await intentRow(id)).pspReference as string, 'declined');
    await backdatePastWindow(id);

    const money = await moneyState();
    const result = await reap();

    expect(result.settledFromGateway).toBeGreaterThanOrEqual(1);

    const after = await intentRow(id);
    expect(after.status).toBe('failed');
    // `declined` and NOT `expired`. A customer's failure screen should say what
    // actually happened; `expired` is the last resort, not the default.
    expect(after.failureReason).toBe('declined');
    expect(after.transactionId).toBeNull();
    expect(await moneyState()).toEqual(money);
  });

  it('never touches an intent that has already settled', async () => {
    const id = await startTopUp();
    const row = await intentRow(id);
    await sandbox.setOutcome(row.pspReference as string, 'succeeded');

    // Settle it the way the product does — an authoritative gateway read.
    const settled = await topup.settleFromGatewayRead(
      db,
      row as unknown as import('./topup').TopUpIntentRow,
      'succeeded',
      row.amountFils,
    );
    expect(settled.kind).toBe('applied');

    const afterSettle = await intentRow(id);
    expect(afterSettle.status).toBe('succeeded');
    expect(afterSettle.transactionId).toBeTruthy();

    // Now age it past the window. A settled intent is old too, eventually.
    await backdatePastWindow(id);

    const money = await moneyState();
    const result = await reap();

    /**
     * NOT EVEN CONSIDERED. The candidate scan filters on `OPEN_STATUSES`, so a
     * settled intent is never read, never asked about and never written. This is
     * the assertion that pins that filter: without it the row would be picked
     * up, the gateway would answer `succeeded`, and it would surface here as a
     * customer awaiting a credit she has already been paid.
     */
    expect(result.awaitingCreditIds).not.toContain(id);

    const after = await intentRow(id);
    expect(after.status).toBe('succeeded');
    expect(after.failureReason).toBeNull();
    // The credit is intact — not re-applied, not walked back.
    expect(after.transactionId).toBe(afterSettle.transactionId);
    expect(after.settledAt?.getTime()).toBe(afterSettle.settledAt?.getTime());
    expect(await moneyState()).toEqual(money);
  });

  it('reaps nothing when the processor cannot be asked', async () => {
    const id = await startTopUp();
    const row = await intentRow(id);

    /**
     * Delete the gateway's own record. `SandboxGateway.fetchPayment` raises
     * `GatewayUnavailableError` for a reference it does not know, exactly as a
     * real processor 404s one it never issued — and the seam cannot tell that
     * apart from a processor that is down. Both must be a veto: writing a
     * terminal state because a third party did not answer is how one outage
     * becomes a hundred stranded top-ups.
     */
    await db
      .delete(sandboxGatewayPayment)
      .where(orm.eq(sandboxGatewayPayment.pspReference, row.pspReference as string));
    await backdatePastWindow(id);

    const money = await moneyState();
    const result = await reap();

    expect(result.gatewayUnreachable).toBeGreaterThanOrEqual(1);

    const after = await intentRow(id);
    expect(after.status).toBe('redirected');
    expect(after.failureReason).toBeNull();
    expect(await moneyState()).toEqual(money);
  });

  it('running it twice reaps the same intent once', async () => {
    const id = await startTopUp();
    await sandbox.setOutcome((await intentRow(id)).pspReference as string, 'pending');
    await backdatePastWindow(id);

    const first = await reap();
    const afterFirst = await intentRow(id);
    expect(afterFirst.status).toBe('failed');
    expect(afterFirst.failureReason).toBe('expired');

    const money = await moneyState();
    const second = await reap();

    /**
     * The second pass does not see it at all — it is no longer in
     * `OPEN_STATUSES`, so the candidate scan skips it rather than the re-check
     * catching it. `alreadyResolved` covers the narrower race (a webhook landing
     * between the scan and the write); this covers the ordinary re-run.
     */
    expect(second.expired).toBe(first.expired - 1);

    const afterSecond = await intentRow(id);
    expect(afterSecond.status).toBe('failed');
    expect(afterSecond.failureReason).toBe('expired');
    expect(afterSecond.updatedAt.getTime()).toBe(afterFirst.updatedAt.getTime());
    expect(await moneyState()).toEqual(money);
  });
});
