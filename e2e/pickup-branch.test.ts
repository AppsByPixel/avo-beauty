/**
 * SHE CHOOSES WHERE TO COLLECT — migration 0060, driven from outside.
 *
 * HOW TO RUN
 *
 *   cd e2e && ../node_modules/.bin/vitest run pickup-branch.test.ts
 *
 * WHAT CHANGED
 * ------------
 * The client: "on the cart page, Collect it is good, but from which branch if they
 * have multiple". Lane A (f653748) added `pickupBranchId` to `POST /orders` and
 * `POST /orders/payments`, pickup only, validated server-side as an OPEN branch of
 * HER salon, and required at a multi-branch salon. And it moved the money's
 * ATTRIBUTION: a pickup order's `transaction.branch_id` is now the branch she
 * collects from, `branch_assumed = false`. Before 0060 every shop order at a
 * multi-branch salon was booked to the LOWEST open branch id (`BR-KWC` at
 * SAL-AMARA) with `branch_assumed = true` — one branch's column inheriting
 * another's shop takings wholesale.
 *
 * `api/src/routes/pickupBranch.int.test.ts` is lane A's claim about lane A's code,
 * driven in-process. This file is the independent restatement: a real API on a
 * real port, this run's own Postgres, every claim about a row read back in SQL,
 * and the attribution read off the merchant's own report rather than the column.
 *
 * WHY LETTING HER CHOOSE IS SAFE — AND THE SPEC THAT KEEPS IT SAFE
 * ---------------------------------------------------------------
 * `services/branch.ts`: a client choosing the branch is a client choosing its own
 * multiplier. That is about EARNING, and a shop order earns nothing per branch —
 * one flat visit, no boost, no happy hour. So choosing `BR-KWC` (seeded 2x visit
 * and +10 point top-up boost) must buy her nothing on a shop order. § "the boosted
 * branch" pins that at the e2e level, on both doors. The day somebody wires the
 * promotion engine into orders, that spec is what goes red, and the pickup branch
 * must stop being the attribution branch.
 *
 * FIXTURES
 * --------
 * Members `QA-PB-*` are this file's own, start at zero, and are funded ONLY through
 * the gateway — so they reconcile to their ledger by construction and the last
 * describe asserts it without posting a reconciliation (see `order-payment.test.ts`
 * for why calling `reconcileWalletLedger` here would hide the drift it should see).
 *
 * The one branch this file creates, `CLOSED_BRANCH`, is at SAL-AMARA because the
 * closed-branch refusal is a refusal of HER salon's branch. It takes no
 * transaction (every order against it is refused), so `retireBranches` deletes it
 * outright in `afterAll`, and its `ZZ` id sorts after `BR-KWC` so that while it is
 * briefly open it cannot become the branch `resolveBranch` attributes a delivery
 * to. Nothing is written at SAL-LUMIERE: its branch is only NAMED, as the foreign
 * id to be refused.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { precondition } from './support/known-bug.js';
import {
  A_BRANCH,
  B_BRANCH,
  SALON_A,
  apiLogTail,
  psql,
  retireBranches,
  scalar,
  signInDashboard,
  signInMember,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

const CLONE_SOURCE = 'QA-GW-0001';

/** One member per concern, so no spec's delta can be moved by another spec's write. */
const M = {
  refusals: { id: 'QA-PB-0001', phone: '+96555960001' },
  attribution: { id: 'QA-PB-0002', phone: '+96555960002' },
  boost: { id: 'QA-PB-0003', phone: '+96555960003' },
} as const;
type Who = keyof typeof M;

/** 3.000 KD, this file's own, so no literal elsewhere moves under it. */
const PRODUCT = 'PR-QAPB-01';
const PRODUCT_FILS = 3_000;

/** The seeded boosted branch — `api/src/db/seed.ts`: visit 2, topup 10, stamp 1. */
const KWC = 'BR-KWC';
/** Created, then closed through the merchant's own verb. See the header. */
const CLOSED_BRANCH = 'BR-ZZQA-PB-CLOSED';

const token: Partial<Record<Who, string>> = {};
let web = '';

let n = 0;
const key = (label: string) => `qapb-${label}-${Date.now()}-${n++}`;

// ------------------------------------------------------------------- reads --

interface Money {
  balance: number;
  walletLedger: number;
  shops: number;
  orders: number;
  intents: number;
  visits: number;
}

function money(who: Who): Money {
  const id = M[who].id;
  const [balance, walletLedger, shops, orders, intents, visits] = scalar(`
    SELECT concat_ws('|',
      (SELECT balance_fils FROM member WHERE id = '${id}'),
      (SELECT coalesce(sum(CASE direction WHEN 'credit' THEN amount_fils ELSE -amount_fils END), 0)
         FROM ledger_entry WHERE member_id = '${id}' AND account = 'member_wallet'),
      (SELECT count(*) FROM "transaction" WHERE member_id = '${id}' AND kind = 'shop'),
      (SELECT count(*) FROM shop_order WHERE member_id = '${id}'),
      (SELECT count(*) FROM topup_intent WHERE member_id = '${id}'),
      (SELECT visits FROM member WHERE id = '${id}'))`)
    .trim()
    .split('|')
    .map(Number);
  return { balance, walletLedger, shops, orders, intents, visits } as Money;
}

function delta(before: Money, after: Money): Money {
  const out = {} as Money;
  for (const k of Object.keys(before) as Array<keyof Money>) out[k] = after[k] - before[k];
  return out;
}

const NOTHING_MOVED: Money = { balance: 0, walletLedger: 0, shops: 0, orders: 0, intents: 0, visits: 0 };

/** Where the revenue of one shop transaction was booked, from the row itself. */
function attributionOf(txId: string): { branch: string; assumed: boolean } {
  const [branch, assumed] = scalar(
    `select concat_ws('|', branch_id, branch_assumed::text) from "transaction" where id='${txId}'`,
  )
    .trim()
    .split('|');
  precondition(!!branch, `no transaction row ${txId}`);
  return { branch: branch!, assumed: assumed === 'true' };
}

/** The branch `resolveBranch` falls back to at SAL-AMARA: the lowest OPEN id. */
function serverDefaultBranch(): string {
  return scalar(
    `select id from branch where salon_id='${SALON_A}' and closed_at is null order by id limit 1`,
  ).trim();
}

const branchName = (id: string): string =>
  scalar(`select name from branch where id='${id}'`).trim();

/** One row of the merchant's per-branch revenue card, by branch name. */
interface BranchEarnings {
  transactions: number;
  grossFils: number;
  assumedGrossFils: number;
  assumedTransactions: number;
}

async function earningsByBranch(): Promise<Map<string, BranchEarnings>> {
  const res = await treq<any>('GET', `/salons/${SALON_A}/reports/earnings-by-branch?period=7d`, {
    token: web,
  });
  precondition(res.status === 200, `earnings-by-branch answered ${res.status}: ${res.raw}`);
  const out = new Map<string, BranchEarnings>();
  for (const r of res.body.rows as Array<Record<string, any>>) {
    out.set(r.branch, {
      transactions: r.transactions,
      grossFils: r.grossFils,
      assumedGrossFils: r.assumedGrossFils,
      assumedTransactions: r.assumedTransactions,
    });
  }
  return out;
}

function earningsDelta(
  before: Map<string, BranchEarnings>,
  after: Map<string, BranchEarnings>,
  name: string,
): BranchEarnings {
  const b = before.get(name);
  const a = after.get(name);
  precondition(!!b && !!a, `earnings-by-branch has no row for "${name}"`);
  return {
    transactions: a!.transactions - b!.transactions,
    grossFils: a!.grossFils - b!.grossFils,
    assumedGrossFils: a!.assumedGrossFils - b!.assumedGrossFils,
    assumedTransactions: a!.assumedTransactions - b!.assumedTransactions,
  };
}

const UNMOVED: BranchEarnings = {
  transactions: 0,
  grossFils: 0,
  assumedGrossFils: 0,
  assumedTransactions: 0,
};

// ------------------------------------------------------------------ writes --

type Body = Record<string, unknown>;
const basket = (extra: Body = {}): Body => ({ items: [{ productId: PRODUCT, qty: 1 }], ...extra });

const walletOrder = (who: Who, body: Body, idemKey = key(`${who}-order`)) =>
  treq<any>('POST', '/orders', { token: token[who]!, idempotencyKey: idemKey, body });

const cardOrder = (who: Who, body: Body, idemKey = key(`${who}-card`)) =>
  treq<any>('POST', '/orders/payments', {
    token: token[who]!,
    idempotencyKey: idemKey,
    body: { ...body, method: 'knet' },
  });

async function payHostedPage(redirectUrl: string): Promise<void> {
  const ref = /\/_gateway\/([^/?#]+)/.exec(redirectUrl ?? '')?.[1];
  precondition(!!ref, `no sandbox gateway ref in ${redirectUrl}`);
  const paid = await treq<any>('POST', `/_gateway/${ref}`, {
    token: null,
    body: { outcome: 'succeeded', notify: true },
  });
  precondition(paid.status === 200, `the hosted page did not pay: ${paid.status} ${paid.raw}`);
}

async function fundByTopUp(who: Who, amountFils: number): Promise<void> {
  const t = await treq<any>('POST', '/topups', {
    token: token[who]!,
    idempotencyKey: key(`${who}-fund`),
    body: { amountFils, method: 'knet' },
  });
  precondition(t.status === 200, `funding top-up for ${who}: ${t.status} ${t.raw}`);
  await payHostedPage(t.body.redirectUrl);
  precondition(
    scalar(`select status from topup_intent where id='${t.body.id}'`).trim() === 'succeeded',
    `the funding top-up for ${who} did not settle`,
  );
}

async function ownAddress(who: Who): Promise<string> {
  const made = await treq<any>('POST', '/members/me/addresses', {
    token: token[who]!,
    body: { label: 'Home', block: '4', street: 'Salem Al Mubarak St', building: '12', area: 'Salmiya' },
  });
  precondition(made.status === 201, `could not make an address: ${made.status} ${made.raw}`);
  return made.body.address.id as string;
}

// ---------------------------------------------------------------- fixtures --

beforeAll(async () => {
  await startTenancyApi();

  for (const who of Object.keys(M) as Who[]) {
    const { id, phone } = M[who];
    psql(`
      INSERT INTO member (id, salon_id, name, phone, email, email_verified, password_hash,
                          balance_fils, visits, tier, stamps, policy_version, notify_wa)
      SELECT '${id}', salon_id, 'Pickup branch QA ${who}', '${phone}', NULL, false,
             password_hash, 0, 0, 'silver', NULL, policy_version, false
        FROM member WHERE id = '${CLONE_SOURCE}'
      ON CONFLICT (id) DO UPDATE SET tier = 'silver';
    `);
    precondition(
      scalar(`select count(*) from member where id='${id}'`).trim() === '1',
      `the clone source ${CLONE_SOURCE} is missing, so ${who} has no member row`,
    );
  }

  psql(`
    INSERT INTO product (id, salon_id, name, price_fils, active)
    VALUES ('${PRODUCT}', '${SALON_A}', 'QA pickup-branch balm', ${PRODUCT_FILS}, true)
    ON CONFLICT (id) DO UPDATE SET active = true, price_fils = EXCLUDED.price_fils;
  `);

  // The fixtures every claim below leans on, asserted rather than assumed.
  precondition(
    scalar(`select module_shop from salon where id='${SALON_A}'`).trim() === 't',
    `${SALON_A} has the shop module off, so every order here would be shop_not_enabled`,
  );
  precondition(
    scalar(`select loyalty_mode from salon where id='${SALON_A}'`).trim() === 'tiers',
    `${SALON_A} is not a tiers salon, so "one visit" below is not the unit it earns in`,
  );
  precondition(
    Number(scalar(`select count(*) from branch where salon_id='${SALON_A}' and closed_at is null`)) >= 2,
    `${SALON_A} has fewer than two open branches, so a pickup branch is not required and nothing here discriminates`,
  );
  precondition(
    scalar(`select concat_ws('|', visit, topup) from boost where salon_id='${SALON_A}' and branch_id='${KWC}'`).trim() ===
      '2|10',
    `${KWC} is no longer the seeded 2x-visit, +10 top-up boost, so "the boosted branch buys nothing" proves nothing`,
  );
  precondition(
    scalar(`select salon_id from branch where id='${B_BRANCH}'`).trim() !== SALON_A,
    `${B_BRANCH} is not another salon's branch, so the tenancy spec is not a tenancy spec`,
  );

  for (const who of Object.keys(M) as Who[]) {
    token[who] = await signInMember(SALON_A, M[who].phone);
  }
  web = await signInDashboard(SALON_A, 'noura');

  // Enough for every wallet order below, through the gateway — never in SQL.
  await fundByTopUp('refusals', 20_000);
  await fundByTopUp('attribution', 20_000);
  await fundByTopUp('boost', 20_000);
}, 180_000);

afterAll(async () => {
  retireBranches(SALON_A, [CLOSED_BRANCH]);
  // Retired, not deleted — order lines reference it, and the ledger is append-only.
  psql(`UPDATE product SET active = false WHERE id = '${PRODUCT}';`);
  await stopTenancyApi();
});

// ===========================================================================

describe('the control — a pickup at the branch she names is placed there', () => {
  it('names A_BRANCH: 201, the fulfilment row says so, and so does her receipt', async () => {
    const before = money('refusals');
    const res = await walletOrder('refusals', basket({ pickupBranchId: A_BRANCH }));
    expect(res.status, `${res.raw}\n${res.status >= 500 ? apiLogTail() : ''}`).toBe(201);
    expect(res.body.pickupBranch?.id, res.raw).toBe(A_BRANCH);
    expect(res.body.pickupBranch?.closed).toBe(false);
    expect(
      scalar(`select pickup_branch_id from shop_order where transaction_id='${res.body.transaction.id}'`).trim(),
    ).toBe(A_BRANCH);
    expect(delta(before, money('refusals'))).toEqual({
      ...NOTHING_MOVED,
      balance: -PRODUCT_FILS,
      walletLedger: -PRODUCT_FILS,
      shops: 1,
      orders: 1,
      visits: 1,
    });
  });

  it('names none at a two-branch salon: refused, and the server does not pick one for her', async () => {
    const before = money('refusals');
    const wallet = await walletOrder('refusals', basket());
    expect(wallet.status, wallet.raw).toBe(400);
    expect(wallet.body.error).toBe('pickup_branch_required');
    const card = await cardOrder('refusals', basket());
    expect(card.status, card.raw).toBe(400);
    expect(card.body.error).toBe('pickup_branch_required');
    expect(delta(before, money('refusals')), 'a pickup with no branch moved money').toEqual(NOTHING_MOVED);
  });
});

// ===========================================================================

describe("tenancy — she cannot collect from another salon's branch, and cannot tell it exists", () => {
  /**
   * `resolvePickupBranch` scopes the lookup to HER salon in the query, so salon B's
   * real branch and an id that never existed are the same 404. A 403, or a
   * different message, would be an oracle for "this id is a real branch somewhere".
   * Compared byte for byte, on both doors, and nothing may move on either.
   */
  for (const door of ['POST /orders', 'POST /orders/payments'] as const) {
    it(`${door}: salon B's REAL branch is byte-identical to a made-up id, and nothing moves`, async () => {
      const send = door === 'POST /orders' ? walletOrder : cardOrder;
      const before = money('refusals');

      const foreign = await send('refusals', basket({ pickupBranchId: B_BRANCH }));
      const madeUp = await send('refusals', basket({ pickupBranchId: `BR-QAPB-NO-SUCH-${Date.now()}` }));

      expect(foreign.status, `${foreign.raw}\n${foreign.status >= 500 ? apiLogTail() : ''}`).toBe(404);
      expect(foreign.body.error).toBe('unknown_pickup_branch');
      expect(
        foreign.raw,
        "another salon's branch answers differently from a branch that does not exist — the " +
          'difference tells her the id is real',
      ).toBe(madeUp.raw);

      expect(delta(before, money('refusals')), `${door} moved money on a foreign branch`).toEqual(NOTHING_MOVED);
      expect(
        Number(scalar(`select count(*) from shop_order where pickup_branch_id='${B_BRANCH}' and salon_id='${SALON_A}'`)),
      ).toBe(0);
    });
  }
});

// ===========================================================================

describe('a closed branch of her own salon is refused as closed', () => {
  beforeAll(async () => {
    psql(`
      INSERT INTO branch (id, salon_id, name)
      VALUES ('${CLOSED_BRANCH}', '${SALON_A}', 'QA pickup-branch closed counter')
      ON CONFLICT (id) DO UPDATE SET closed_at = NULL;
    `);
    // Closed through the merchant's own verb, so "closed" is the product's state.
    const closed = await treq<any>('DELETE', `/salons/${SALON_A}/branches/${CLOSED_BRANCH}`, { token: web });
    precondition(closed.status === 200, `could not close ${CLOSED_BRANCH}: ${closed.status} ${closed.raw}`);
    precondition(
      scalar(`select closed_at is not null from branch where id='${CLOSED_BRANCH}'`).trim() === 't',
      'the close answered 200 and the branch is still open',
    );
  });

  it('POST /orders: 409 pickup_branch_closed, naming the branch, and nothing moves', async () => {
    const before = money('refusals');
    const k = key('closed-wallet');
    const res = await walletOrder('refusals', basket({ pickupBranchId: CLOSED_BRANCH }), k);
    expect(res.status, `${res.raw}\n${res.status >= 500 ? apiLogTail() : ''}`).toBe(409);
    expect(res.body.error).toBe('pickup_branch_closed');
    expect(res.body.pickupBranchId).toBe(CLOSED_BRANCH);
    expect(delta(before, money('refusals')), 'an order at a closed branch moved money').toEqual(NOTHING_MOVED);
    expect(Number(scalar(`select count(*) from shop_order where pickup_branch_id='${CLOSED_BRANCH}'`))).toBe(0);
    // A refusal, not a spent attempt: the key is still hers to retry with.
    expect(scalar(`select count(*) from idempotency_key where key='${k}'`).trim()).toBe('0');
  });

  it('POST /orders/payments: refused BEFORE the gateway — no intent, no card charged', async () => {
    const before = money('refusals');
    const res = await cardOrder('refusals', basket({ pickupBranchId: CLOSED_BRANCH }));
    expect(res.status, res.raw).toBe(409);
    expect(res.body.error).toBe('pickup_branch_closed');
    expect(delta(before, money('refusals')), 'a closed branch opened a card payment').toEqual(NOTHING_MOVED);
  });
  // The branch that closes WHILE she is on the hosted page is
  // `order-payment.test.ts` § the race, which has the settlement machinery.
});

// ===========================================================================

describe('a delivery that names a pickup branch is refused, not ignored', () => {
  /**
   * A client that sent both an address and a pickup branch believed one of them.
   * Honouring either quietly is the wrong answer that reads as working. The
   * address is HER OWN and real, so the pickup branch is the only fault.
   */
  it('on both doors: 400 pickup_branch_not_for_delivery, and nothing moves', async () => {
    const addressId = await ownAddress('refusals');
    const body = basket({ fulfilment: 'delivery', addressId, pickupBranchId: A_BRANCH });
    const before = money('refusals');

    const wallet = await walletOrder('refusals', body);
    expect(wallet.status, `${wallet.raw}\n${wallet.status >= 500 ? apiLogTail() : ''}`).toBe(400);
    expect(wallet.body.error).toBe('pickup_branch_not_for_delivery');

    const card = await cardOrder('refusals', body);
    expect(card.status, card.raw).toBe(400);
    expect(card.body.error).toBe('pickup_branch_not_for_delivery');

    expect(delta(before, money('refusals')), 'a delivery with a pickup branch moved money').toEqual(NOTHING_MOVED);

    // THE CONTROL: the same delivery without the branch goes through, so the refusal
    // above was about the branch and not about the address.
    const ok = await walletOrder('refusals', basket({ fulfilment: 'delivery', addressId }));
    expect(ok.status, ok.raw).toBe(201);
    expect(ok.body.pickupBranch).toBeNull();
  });
});

// ===========================================================================

describe("attribution — a pickup's revenue lands at the branch she collects from; a delivery's does not move", () => {
  /**
   * THE CHANGE IN THE MERCHANT'S NUMBERS, read off her own per-branch revenue card
   * (`earnings-by-branch`) as a DELTA, so every other file's rows at these two
   * branches cancel out.
   *
   * The pickup is placed at `A_BRANCH` (BR-SAL), which is deliberately NOT the
   * server's fallback (`BR-KWC`, the lowest open id): under the pre-0060 code this
   * order is booked to BR-KWC as assumed and BR-SAL's row does not move, so the
   * old behaviour and the new cannot both pass. A delivery still has no branch she
   * can name, so it keeps the server's resolution — the fallback, `assumed` — and
   * that is pinned too, so "attribution moved" cannot be read as "attribution now
   * follows whatever the client sends".
   */
  let fallback = '';
  beforeAll(() => {
    fallback = serverDefaultBranch();
    precondition(
      fallback !== '' && fallback !== A_BRANCH,
      `the server's fallback branch is ${fallback || 'nothing'}, so a pickup at ${A_BRANCH} does not discriminate`,
    );
  });

  it('a pickup at A_BRANCH: booked to A_BRANCH, established, and the fallback branch does not move', async () => {
    const before = await earningsByBranch();
    const res = await walletOrder('attribution', basket({ pickupBranchId: A_BRANCH }));
    expect(res.status, `${res.raw}\n${res.status >= 500 ? apiLogTail() : ''}`).toBe(201);

    // The merchant's figure FIRST — it is the claim; the column below is its cause.
    const after = await earningsByBranch();
    expect(earningsDelta(before, after, branchName(A_BRANCH)), 'the pickup branch did not earn the order').toEqual({
      transactions: 1,
      grossFils: PRODUCT_FILS,
      assumedGrossFils: 0,
      assumedTransactions: 0,
    });
    expect(
      earningsDelta(before, after, branchName(fallback)),
      `${fallback} took a pickup that was collected at ${A_BRANCH}`,
    ).toEqual(UNMOVED);

    expect(
      attributionOf(res.body.transaction.id),
      `a pickup at ${A_BRANCH} was booked elsewhere — this is the pre-0060 alphabetical attribution`,
    ).toEqual({ branch: A_BRANCH, assumed: false });
  });

  it("a delivery: the server's fallback branch, marked assumed — and A_BRANCH does not move", async () => {
    const addressId = await ownAddress('attribution');
    const before = await earningsByBranch();
    const res = await walletOrder('attribution', basket({ fulfilment: 'delivery', addressId }));
    expect(res.status, `${res.raw}\n${res.status >= 500 ? apiLogTail() : ''}`).toBe(201);

    expect(attributionOf(res.body.transaction.id)).toEqual({ branch: fallback, assumed: true });

    const after = await earningsByBranch();
    expect(earningsDelta(before, after, branchName(fallback))).toEqual({
      transactions: 1,
      grossFils: PRODUCT_FILS,
      assumedGrossFils: PRODUCT_FILS,
      assumedTransactions: 1,
    });
    expect(earningsDelta(before, after, branchName(A_BRANCH)), 'a delivery moved the pickup branch').toEqual(UNMOVED);
  });

  it('a card-paid pickup is attributed the same way — the settlement places it where she chose', async () => {
    const before = await earningsByBranch();
    const opened = await cardOrder('attribution', basket({ pickupBranchId: A_BRANCH }));
    expect(opened.status, opened.raw).toBe(201);
    await payHostedPage(opened.body.intent.redirectUrl);
    const back = await treq<any>('GET', `/orders/payments/${opened.body.intent.id}`, { token: token.attribution! });
    expect(back.body.order?.status, back.raw).toBe('placed');

    expect(attributionOf(back.body.order.transactionId)).toEqual({ branch: A_BRANCH, assumed: false });
    const after = await earningsByBranch();
    expect(earningsDelta(before, after, branchName(A_BRANCH)).grossFils).toBe(PRODUCT_FILS);
    expect(earningsDelta(before, after, branchName(fallback))).toEqual(UNMOVED);
  });
});

// ===========================================================================

describe('the boosted branch buys her nothing on a shop order — the reason choosing is safe', () => {
  /**
   * `BR-KWC` carries the seeded 2x visit and +10 point top-up boost (asserted in
   * `beforeAll`). A charge there earns two visits. A shop order must earn ONE,
   * wherever she collects, and a card-paid one must carry exactly the tier bonus
   * with no promotion bonus. If either spec goes red, the pickup branch has become
   * a multiplier she can pick, and it can no longer be the attribution branch.
   */
  it('a wallet order collected at BR-KWC earns one visit, exactly as one at A_BRANCH does', async () => {
    const atKwcBefore = money('boost');
    const kwc = await walletOrder('boost', basket({ pickupBranchId: KWC }));
    expect(kwc.status, `${kwc.raw}\n${kwc.status >= 500 ? apiLogTail() : ''}`).toBe(201);
    expect(attributionOf(kwc.body.transaction.id)).toEqual({ branch: KWC, assumed: false });
    expect(delta(atKwcBefore, money('boost')).visits, "BR-KWC's 2x visit boost paid out on a shop order").toBe(1);

    const atSalBefore = money('boost');
    const sal = await walletOrder('boost', basket({ pickupBranchId: A_BRANCH }));
    expect(sal.status, sal.raw).toBe(201);
    expect(delta(atSalBefore, money('boost')).visits, 'the control branch earned something other than one visit').toBe(1);
  });

  it('a card-paid order collected at BR-KWC carries the tier bonus and no promotion bonus — the same as at A_BRANCH', async () => {
    const kwc = await cardOrder('boost', basket({ pickupBranchId: KWC }));
    const sal = await cardOrder('boost', basket({ pickupBranchId: A_BRANCH }));
    expect(kwc.status, kwc.raw).toBe(201);
    expect(sal.status, sal.raw).toBe(201);

    const row = (id: string) =>
      scalar(`select concat_ws('|', amount_fils, bonus_fils, promo_bonus_fils, credit_fils) from topup_intent where id='${id}'`)
        .trim()
        .split('|')
        .map(Number);
    const [amount, bonus, promo, credit] = row(kwc.body.intent.id) as [number, number, number, number];
    // Her tier's percentage, read from the salon's own ladder rather than typed.
    const pct = Number(
      scalar(
        `select coalesce((select (t->>'bonusPercent')::int from salon s, jsonb_array_elements(s.tiers) t
           where s.id='${SALON_A}' and t->>'name' = (select tier::text from member where id='${M.boost.id}')), 0)`,
      ),
    );
    expect(amount).toBe(PRODUCT_FILS);
    expect(bonus, 'the card-paid bonus at BR-KWC is not her tier percentage').toBe((PRODUCT_FILS * pct) / 100);
    expect(promo, "BR-KWC's +10 point top-up boost was paid on a card order collected there").toBe(0);
    expect(credit).toBe(amount + bonus);
    expect(row(sal.body.intent.id), 'the two branches priced the same basket differently').toEqual([
      amount,
      bonus,
      promo,
      credit,
    ]);

    // Paid, so neither is left open — and the placed order at BR-KWC is still one visit.
    const before = money('boost');
    await payHostedPage(kwc.body.intent.redirectUrl);
    await payHostedPage(sal.body.intent.redirectUrl);
    for (const id of [kwc.body.intent.id, sal.body.intent.id]) {
      const back = await treq<any>('GET', `/orders/payments/${id}`, { token: token.boost! });
      expect(back.body.order?.status, back.raw).toBe('placed');
    }
    expect(delta(before, money('boost')).visits, 'two card-paid shop orders earned other than two visits').toBe(2);
  });
});

// ------------------------------------------------------ the wallet census --

describe('every member this file touched reconciles — invariant 5, before teardown measures it', () => {
  it('balance equals the member_wallet ledger for each, with no reconciliation posted', () => {
    const drifting = (Object.keys(M) as Who[])
      .map((who) => ({ who, ...money(who) }))
      .filter((m) => m.balance !== m.walletLedger)
      .map((m) => `${M[m.who].id} (${m.who}): balance ${m.balance}, ledger ${m.walletLedger}`);
    expect(drifting, 'a pickup order left a balance the ledger cannot explain').toEqual([]);
    expect(
      Number(scalar(`select count(*) from "transaction" where reference like 'AVO-RECONCILE-QA-PB-%'`)),
    ).toBe(0);
  });
});
