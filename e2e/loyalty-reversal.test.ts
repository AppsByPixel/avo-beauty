/**
 * WHAT THE VISIT EARNED, AND WHAT THE VOID TAKES BACK — end to end.   (migration 0065)
 *
 * HOW TO RUN
 *
 *   pnpm --dir ./api run db:up
 *   cd e2e && ../node_modules/.bin/vitest run loyalty-reversal.test.ts
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Before 0065 a void took ONE visit off every charge, whatever the charge had
 * given. A doubled visit lost one of its two; a stamp card lost a visit it was
 * never given and kept its stamps. Lane A's `edcb0f0` records the increment on the
 * charge row (`transaction.loyalty_*`) and `POST /voids` now reverses exactly that.
 * `api/src/routes/chargeLoyaltyRecord.int.test.ts` proves the rows with sessions it
 * issues itself. This file proves the same property through the product's real
 * doors: a four-digit PIN on a bound device, a QR minted by a customer who signed
 * in with her phone, a boost published through the merchant's own endpoint, a
 * top-up settled by a signed gateway callback, and her activity read back through
 * `GET /members/me/transactions`.
 *
 * THE DOUBLED VISIT IS A BOOST THIS FILE SETS, NEVER THE WALL CLOCK
 * ----------------------------------------------------------------
 * The seed's `HH-01` is live at salon A Sun/Mon/Tue 16:00–18:00 Kuwait, so any
 * charge there earns 2 visits for six hours a week and 1 otherwise. A spec that
 * relied on that would be green or red by the time of day — the defect lane A
 * reported against `scanner.test.ts`. So:
 *
 *   - Both salons here are this file's own, with ONE open branch each. A
 *     single-branch salon's branch is established (`services/branch.ts`), so its
 *     boost pays at an unenrolled till, deterministically. Salon B has two
 *     branches, which would need a device enrolment as well, and its till is the
 *     one every other scanner spec signs in on.
 *   - Neither salon has a `happy_hour` row, asserted in a tripwire, so the only
 *     thing that can multiply is the boost.
 *   - The boost is published through `PUT /v1/salons/{id}/promotions/boosts`,
 *     reset to the identity after every spec, and checked at the identity in
 *     `afterAll`.
 *
 *   SAL-QA-LR-TIERS   tiers, ladder bronze 0 · silver 3, one branch
 *   SAL-QA-LR-STAMPS  stamps, target 6, one branch
 *
 * NOTHING HERE TOUCHES SALON A OR SALON B.
 *
 * WHAT IS LEFT BEHIND. The members' charges wrote append-only ledger rows
 * (`ON DELETE restrict`) and the charges wrote audit rows that 0023 refuses to
 * delete, so the salons, branches and members stay — the same reasoning
 * `signup.test.ts` gives for `SAL-QA-SIGNUP-STAMPS`. The run database is minted per
 * run and dropped by `global-setup.ts`; under the `POSTGRES_DB` opt-out the upserts
 * in `seedMine()` put every row back to its starting state on the next run.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { precondition } from './support/known-bug.js';
import {
  A_STAFF_FULL,
  B_MEMBER,
  GATEWAY_WEBHOOK_SECRET,
  SIGNATURE_HEADER,
  apiLogTail,
  mintWalletTokenFor,
  nowSeconds,
  psql,
  reconcileWalletLedger,
  scalar,
  signCallback,
  signInDashboard,
  signInMember,
  signInScanner,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

// ------------------------------------------------------------------ fixtures --

interface Fixture {
  salon: string;
  branch: string;
  staff: string;
  handle: string;
  device: string;
  service: string;
  member: string;
  phone: string;
}

const TIERS: Fixture = {
  salon: 'SAL-QA-LR-TIERS',
  branch: 'BR-QA-LR-TIERS',
  staff: 'ST-QA-LR-TIERS',
  handle: 'lr-tiers',
  device: 'DEV-QA-LR-TIERS',
  service: 'SV-QA-LR-TIERS',
  member: 'QA-LR-M-TIERS',
  phone: '+96599660801',
};

const STAMPS: Fixture = {
  salon: 'SAL-QA-LR-STAMPS',
  branch: 'BR-QA-LR-STAMPS',
  staff: 'ST-QA-LR-STAMPS',
  handle: 'lr-stamps',
  device: 'DEV-QA-LR-STAMPS',
  service: 'SV-QA-LR-STAMPS',
  member: 'QA-LR-M-STAMPS',
  phone: '+96599660802',
};

const PRICE_FILS = 5_000;
const OPENING_BALANCE_FILS = 500_000;
/** The tiers salon's ladder. Silver at 3, so a doubled visit from 1 crosses it and a single one does not. */
const SILVER_AT = 3;
const STAMP_TARGET = 6;
const TOPUP_FILS = 10_000;

/**
 * Both salons, idempotently. Hashes are copied from salon A's `ST-001`, exactly as
 * `seedSalonB()` does, so the PIN and the password the harness knows sign in here
 * too — and the member's hash is the staff one for the same reason Fatima's is.
 */
function seedMine(): void {
  const hours = `'{"morning":["10:00","13:00"],"evening":["16:00","21:00"]}'::jsonb`;
  const staffAndMember = (f: Fixture, visits: number, tier: string, stamps: string) => `
    INSERT INTO branch (id, salon_id, name) VALUES ('${f.branch}', '${f.salon}', 'QA LR branch')
    ON CONFLICT (id) DO UPDATE SET closed_at = NULL;

    INSERT INTO service (id, salon_id, name, price_fils)
    VALUES ('${f.service}', '${f.salon}', 'QA LR blow-dry', ${PRICE_FILS})
    ON CONFLICT (id) DO UPDATE SET price_fils = ${PRICE_FILS}, active = true;

    INSERT INTO staff_user (id, salon_id, name, handle, role, branch_access_all, branch_access_ids,
                            password_hash, pin_hash, pin_device_id,
                            perm_dashboard, perm_appointments, perm_shop, perm_loyalty, perm_team,
                            perm_scanner, perm_charges, perm_void, perm_marketing)
    SELECT '${f.staff}', '${f.salon}', 'QA LR Manager', '${f.handle}', 'manager', true, '{}',
           s.password_hash, s.pin_hash, '${f.device}',
           true, true, true, true, true, true, true, true, true
      FROM staff_user s WHERE s.id = '${A_STAFF_FULL}'
    ON CONFLICT (id) DO UPDATE SET
      pin_hash = EXCLUDED.pin_hash, pin_device_id = '${f.device}',
      pin_failed_attempts = 0, pin_locked_until = NULL,
      perm_dashboard = true, perm_scanner = true, perm_charges = true, perm_void = true,
      perm_marketing = true;

    INSERT INTO member (id, salon_id, name, phone, email, email_verified, password_hash,
                        balance_fils, visits, tier, stamps, policy_version)
    SELECT '${f.member}', '${f.salon}', 'QA LR Customer', '${f.phone}', NULL, false,
           s.password_hash, ${OPENING_BALANCE_FILS}, ${visits}, ${tier}, ${stamps},
           (SELECT policy_version FROM member WHERE id = '${B_MEMBER}')
      FROM staff_user s WHERE s.id = '${A_STAFF_FULL}'
    ON CONFLICT (id) DO UPDATE SET
      password_hash = EXCLUDED.password_hash, balance_fils = ${OPENING_BALANCE_FILS},
      visits = ${visits}, tier = ${tier}, stamps = ${stamps};

    DELETE FROM pin_attempt WHERE salon_id = '${f.salon}';
  `;

  psql(`
BEGIN;
INSERT INTO salon (id, name, plan, brand_color, module_booking, module_shop, loyalty_mode,
                   tiers, stamp_target, stamp_reward, deposit_fils, no_show_return_minutes,
                   business_hours, social, whatsapp_enabled, timezone)
VALUES ('${TIERS.salon}', 'QA Loyalty Reversal Tiers', 'starter', '#7A5C8E', false, false, 'tiers',
        '[{"name":"bronze","minVisits":0,"bonusPercent":0},{"name":"silver","minVisits":${SILVER_AT},"bonusPercent":5}]'::jsonb,
        NULL, NULL, 5000, 60, ${hours}, '[]'::jsonb, false, 'Asia/Kuwait')
ON CONFLICT (id) DO UPDATE SET loyalty_mode = 'tiers', tiers = EXCLUDED.tiers,
  stamp_target = NULL, stamp_reward = NULL, timezone = 'Asia/Kuwait';

INSERT INTO salon (id, name, plan, brand_color, module_booking, module_shop, loyalty_mode,
                   tiers, stamp_target, stamp_reward, deposit_fils, no_show_return_minutes,
                   business_hours, social, whatsapp_enabled, timezone)
VALUES ('${STAMPS.salon}', 'QA Loyalty Reversal Stamps', 'starter', '#7A5C8E', false, false, 'stamps',
        NULL, ${STAMP_TARGET}, 'Free blow dry', 5000, 60, ${hours}, '[]'::jsonb, false, 'Asia/Kuwait')
ON CONFLICT (id) DO UPDATE SET loyalty_mode = 'stamps', tiers = NULL,
  stamp_target = ${STAMP_TARGET}, stamp_reward = 'Free blow dry', timezone = 'Asia/Kuwait';

${staffAndMember(TIERS, 1, `'bronze'`, 'NULL')}
${staffAndMember(STAMPS, 5, 'NULL', '1')}
COMMIT;
`);
}

// ---------------------------------------------------------------- principals --

interface Principals {
  scanner: string;
  wallet: string;
  dashboard: string;
}
const who: Record<'tiers' | 'stamps', Principals> = {
  tiers: { scanner: '', wallet: '', dashboard: '' },
  stamps: { scanner: '', wallet: '', dashboard: '' },
};

let n = 0;
const key = (label: string) => `lr-${label}-${Date.now()}-${n++}`;

beforeAll(async () => {
  await startTenancyApi();
  seedMine();
  for (const [name, f] of [['tiers', TIERS], ['stamps', STAMPS]] as const) {
    who[name] = {
      scanner: await signInScanner(f.salon, f.handle, f.device),
      wallet: await signInMember(f.salon, f.phone),
      dashboard: await signInDashboard(f.salon, f.handle),
    };
  }
}, 120_000);

afterEach(async () => {
  // A 2x left behind would make the next spec's "+1 control" a lie.
  await publishBoost(TIERS, { visit: 1, stamp: 1 });
  await publishBoost(STAMPS, { visit: 1, stamp: 1 });
});

afterAll(async () => {
  try {
    await publishBoost(TIERS, { visit: 1, stamp: 1 });
    await publishBoost(STAMPS, { visit: 1, stamp: 1 });
    // Proved, not printed: every boost row at both salons is the identity.
    expect(
      scalar(
        `select count(*) from boost
          where salon_id in ('${TIERS.salon}', '${STAMPS.salon}')
            and (visit <> 1 or stamp <> 1 or topup <> 0)`,
      ),
      'a boost this file published is still multiplying after it finished',
    ).toBe('0');
  } finally {
    /**
     * The opening balance is written in SQL by `seedMine()`, so it has no ledger
     * pair behind it, and the wallet census (db:verify invariant 5) would fail the
     * run in teardown. Reconciled LAST, per `support/wallet-census.ts`: it posts
     * the missing adjustment pair and is a no-op for a member who already agrees
     * with her ledger — so a re-run on a long-lived database converges.
     */
    reconcileWalletLedger(TIERS.member, 'QALRT');
    reconcileWalletLedger(STAMPS.member, 'QALRS');
    await stopTenancyApi();
  }
});

// --------------------------------------------------------------------- reads --

interface MemberState {
  balance: number;
  visits: number;
  tier: string;
  stamps: string;
}

function memberState(f: Fixture): MemberState {
  const [balance, visits, tier, stamps] = scalar(
    `select balance_fils || '|' || visits || '|' || coalesce(tier::text, '<null>')
            || '|' || coalesce(stamps::text, '<null>')
       from member where id = '${f.member}'`,
  ).split('|');
  return { balance: Number(balance), visits: Number(visits), tier: tier!, stamps: stamps! };
}

/** The six 0065 columns on a transaction row, as one string a failure can print. */
const recordOf = (txId: string): string =>
  scalar(
    `select concat_ws('|', coalesce(loyalty_mode::text, '-'), coalesce(loyalty_visits_earned::text, '-'),
                      coalesce(loyalty_stamps_earned::text, '-'), coalesce(loyalty_tier_after::text, '-'),
                      coalesce(loyalty_climbed::text, '-'), coalesce(loyalty_reward_ready::text, '-'))
       from transaction where id = '${txId}'`,
  );

/** Put the customer back where a spec expects her to start. Fixture setup, not an assertion. */
function resetMember(f: Fixture, s: { visits: number; tier: string | null; stamps: number | null }): void {
  psql(`
    UPDATE member SET visits = ${s.visits},
                      tier = ${s.tier === null ? 'NULL' : `'${s.tier}'`},
                      stamps = ${s.stamps === null ? 'NULL' : s.stamps}
     WHERE id = '${f.member}';
  `);
}

// ------------------------------------------------------------------- writes --

async function publishBoost(f: Fixture, b: { visit: number; stamp: number }): Promise<void> {
  const principal = f === TIERS ? who.tiers : who.stamps;
  if (!principal.dashboard) return; // beforeAll never got this far; nothing was published.
  const res = await treq('PUT', `/v1/salons/${f.salon}/promotions/boosts`, {
    token: principal.dashboard,
    body: { boosts: { [f.branch]: { visit: b.visit, topup: 0, stamp: b.stamp } } },
  });
  precondition(res.status === 200, `could not publish the boost at ${f.salon}: ${res.status} ${res.raw}`);
  precondition(
    scalar(`select visit || '|' || stamp from boost where salon_id='${f.salon}' and branch_id='${f.branch}'`) ===
      `${b.visit}|${b.stamp}`,
    'the boost endpoint answered 200 but the stored row is not what was published',
  );
}

type Loyalty =
  | { mode: 'tiers'; visitsEarned: number; tierAfter: string | null; climbed: boolean; rewardReady: boolean }
  | { mode: 'stamps'; stampsEarned: number; tierAfter: null; climbed: boolean; rewardReady: boolean };

interface ChargeResult {
  transaction: { id: string; kind: string; loyalty: Loyalty | null };
  loyalty: { mode: 'tiers'; visitsEarned: number; visits: number; tier: string | null; climbed: boolean }
    | { mode: 'stamps'; stampsEarned: number; stamps: number; rewardReady: boolean };
  happyHour: unknown;
}

async function charge(f: Fixture, label: string): Promise<ChargeResult> {
  const principal = f === TIERS ? who.tiers : who.stamps;
  const token = await mintWalletTokenFor(principal.wallet, f.member);
  const res = await treq<ChargeResult>('POST', '/charges', {
    token: principal.scanner,
    idempotencyKey: key(label),
    // confirmDuplicate for the reason scanner.test.ts's chargeOnce gives: this file
    // charges one customer for one service several times inside two minutes.
    body: { memberId: f.member, serviceIds: [f.service], token, confirmDuplicate: true },
  });
  precondition(
    res.status === 200,
    `POST /charges at ${f.salon} answered ${res.status} ${res.raw}` +
      (res.status >= 500 ? `\n--- API log ---\n${apiLogTail()}` : ''),
  );
  return res.body;
}

interface VoidResult {
  ok: boolean;
  refundedFils: number;
  visitRemoved: boolean;
  loyalty:
    | { mode: 'tiers'; visitsRemoved: number; tierAfter: string | null; recorded: boolean }
    | { mode: 'stamps'; stampsRemoved: number; recorded: boolean };
}

async function voidCharge(f: Fixture, chargeId: string, label: string): Promise<VoidResult> {
  const principal = f === TIERS ? who.tiers : who.stamps;
  const res = await treq<VoidResult>('POST', '/voids', {
    token: principal.scanner,
    idempotencyKey: key(label),
    body: { transactionId: chargeId, reason: 'loyalty reversal spec' },
  });
  precondition(res.status === 200, `POST /voids answered ${res.status} ${res.raw}`);
  return res.body;
}

const voidIdOf = (chargeId: string): string =>
  scalar(`select id from transaction where reverses_transaction_id = '${chargeId}'`);

/**
 * A real top-up: `POST /topups`, then the processor's signed callback over real
 * HTTP, the way `gateway.test.ts` settles one. Returns the settled transaction id.
 */
async function settleTopUp(f: Fixture, label: string): Promise<string> {
  const principal = f === TIERS ? who.tiers : who.stamps;
  const open = await treq<{ id: string }>('POST', '/topups', {
    token: principal.wallet,
    idempotencyKey: key(label),
    body: { amountFils: TOPUP_FILS, method: 'knet' },
  });
  precondition(open.status === 200, `could not open a top-up: ${open.status} ${open.raw}`);
  const pspReference = scalar(`select coalesce(psp_reference, '') from topup_intent where id = '${open.body.id}'`);
  precondition(pspReference !== '', `intent ${open.body.id} has no psp_reference`);

  const rawBody = JSON.stringify({
    eventId: `EVT-lr-${label}-${Date.now()}-${n++}`,
    pspReference,
    status: 'succeeded',
    amountFils: TOPUP_FILS,
  });
  const settled = await treq('POST', '/webhooks/sandbox', {
    token: null,
    rawBody,
    headers: { [SIGNATURE_HEADER]: signCallback(rawBody, nowSeconds(), GATEWAY_WEBHOOK_SECRET) },
  });
  precondition(settled.status === 200, `the settling callback failed: ${settled.status} ${settled.raw}`);
  const txId = scalar(`select coalesce(transaction_id, '') from topup_intent where id = '${open.body.id}'`);
  precondition(txId !== '', `${open.body.id} settled no transaction`);
  return txId;
}

// ================================================================= tripwires --

describe('the fixture cannot multiply on its own', () => {
  it('each salon has exactly one open branch, no happy hour, and an identity boost', () => {
    for (const f of [TIERS, STAMPS]) {
      expect(
        scalar(`select count(*) from branch where salon_id = '${f.salon}' and closed_at is null`),
        `${f.salon} is not single-branch, so its boost would not pay at an unenrolled till`,
      ).toBe('1');
      expect(
        scalar(`select count(*) from happy_hour where salon_id = '${f.salon}'`),
        `${f.salon} has a happy hour, so a "+2" here could be the wall clock instead of the boost`,
      ).toBe('0');
      expect(
        scalar(
          `select count(*) from boost where salon_id = '${f.salon}' and (visit <> 1 or stamp <> 1)`,
        ),
        `${f.salon} starts with a live multiplier`,
      ).toBe('0');
    }
    expect(scalar(`select loyalty_mode::text from salon where id = '${TIERS.salon}'`)).toBe('tiers');
    expect(scalar(`select loyalty_mode::text from salon where id = '${STAMPS.salon}'`)).toBe('stamps');
  });
});

// ================================================================ tiers mode --

describe('tiers — a void takes back exactly the visits the charge recorded', () => {
  it('CONTROL — an unboosted charge records +1, and its void takes back 1', async () => {
    resetMember(TIERS, { visits: 1, tier: 'bronze', stamps: null });
    const before = memberState(TIERS);

    const c = await charge(TIERS, 'plain');
    expect(c.happyHour, 'nothing is live at this salon, and something reported a window').toBeNull();
    expect(c.loyalty.mode).toBe('tiers');
    expect(c.transaction.loyalty).toEqual({
      mode: 'tiers', visitsEarned: 1, tierAfter: 'bronze', climbed: false, rewardReady: false,
    });
    expect(recordOf(c.transaction.id)).toBe('tiers|1|-|bronze|false|false');
    expect(memberState(TIERS).visits).toBe(before.visits + 1);

    const v = await voidCharge(TIERS, c.transaction.id, 'plain');
    expect(v.loyalty).toEqual({ mode: 'tiers', visitsRemoved: 1, tierAfter: 'bronze', recorded: true });
    expect(v.visitRemoved).toBe(true);
    expect(memberState(TIERS)).toEqual(before);
  });

  it('a 2x boost records +2 and climbs her to silver; the void takes back 2 and puts her back on bronze', async () => {
    resetMember(TIERS, { visits: 1, tier: 'bronze', stamps: null });
    const before = memberState(TIERS);
    await publishBoost(TIERS, { visit: 2, stamp: 1 });

    const c = await charge(TIERS, 'boosted');

    // The response, the transaction on it, and the row: one value in three shapes.
    expect(c.loyalty, 'the charge response does not say what the boost earned').toMatchObject({
      mode: 'tiers', visitsEarned: 2, visits: before.visits + 2, tier: 'silver', climbed: true,
    });
    expect(c.transaction.loyalty).toEqual({
      mode: 'tiers', visitsEarned: 2, tierAfter: 'silver', climbed: true, rewardReady: false,
    });
    expect(recordOf(c.transaction.id), 'the charge row does not record the doubled visit').toBe(
      'tiers|2|-|silver|true|false',
    );
    expect(memberState(TIERS)).toMatchObject({ visits: before.visits + 2, tier: 'silver' });

    const v = await voidCharge(TIERS, c.transaction.id, 'boosted');

    expect(
      v.loyalty,
      'the void did not take back the two visits the charge recorded — this is the pre-0065 ' +
        'behaviour, which took one off every charge whatever it had given',
    ).toEqual({ mode: 'tiers', visitsRemoved: 2, tierAfter: 'bronze', recorded: true });
    expect(v.refundedFils).toBe(PRICE_FILS);

    // The row, not only the reply. Visits back, money back, AND the rung
    // re-evaluated: 1 visit does not support silver, so she is not left on it.
    expect(memberState(TIERS), 'the void left her on a count or a rung the charge gave her').toEqual(before);

    // The descent is recorded the way the climb was, against the void's own row.
    const voidId = voidIdOf(c.transaction.id);
    expect(
      scalar(
        `select coalesce(from_tier::text, '-') || '>' || to_tier::text
           from loyalty_event
          where kind = 'tier_climb' and transaction_id = '${voidId}'`,
      ),
      'the void moved her rung and wrote no loyalty event saying so',
    ).toBe('silver>bronze');
  });

  it('SUBTRACT, NEVER RESTORE — a later charge inside the window survives the void of an earlier one', async () => {
    /**
     * The void takes `earned` off whatever the count is NOW. Restoring the
     * pre-charge snapshot would erase the second charge's visit too — which is
     * what a till double-charging her inside fifteen minutes would look like.
     */
    resetMember(TIERS, { visits: 1, tier: 'bronze', stamps: null });
    const start = memberState(TIERS);

    await publishBoost(TIERS, { visit: 2, stamp: 1 });
    const doubled = await charge(TIERS, 'restore-a');
    await publishBoost(TIERS, { visit: 1, stamp: 1 });
    const single = await charge(TIERS, 'restore-b');

    expect(recordOf(doubled.transaction.id)).toBe('tiers|2|-|silver|true|false');
    expect(recordOf(single.transaction.id)).toBe('tiers|1|-|silver|false|false');
    expect(memberState(TIERS)).toMatchObject({ visits: start.visits + 3, tier: 'silver' });

    const v = await voidCharge(TIERS, doubled.transaction.id, 'restore-a');

    expect(v.loyalty).toMatchObject({ mode: 'tiers', visitsRemoved: 2 });
    // 1 + 2 + 1 − 2 = 2, which is under silver's 3. Not 1 (restored), not 3 (−1).
    expect(memberState(TIERS), 'the void restored a snapshot instead of subtracting what it earned').toMatchObject({
      visits: start.visits + 1,
      tier: 'bronze',
      balance: start.balance - PRICE_FILS,
    });
  });
});

// =============================================================== stamps mode --

describe('stamps — a void takes back the stamps, and never a visit', () => {
  it('a 2x stamp boost records +2 stamps and no visit; the void removes the 2 stamps and leaves her visits alone', async () => {
    resetMember(STAMPS, { visits: 5, tier: null, stamps: 1 });
    const before = memberState(STAMPS);
    await publishBoost(STAMPS, { visit: 1, stamp: 2 });

    const c = await charge(STAMPS, 'stamps');

    expect(c.loyalty).toMatchObject({ mode: 'stamps', stampsEarned: 2, stamps: 3, rewardReady: false });
    expect(c.transaction.loyalty).toEqual({
      mode: 'stamps', stampsEarned: 2, tierAfter: null, climbed: false, rewardReady: false,
    });
    expect(recordOf(c.transaction.id)).toBe('stamps|-|2|-|false|false');
    expect(memberState(STAMPS), 'a stamps-salon charge counted a visit').toMatchObject({
      visits: before.visits,
      stamps: '3',
      tier: '<null>',
    });

    const v = await voidCharge(STAMPS, c.transaction.id, 'stamps');

    expect(v.loyalty).toEqual({ mode: 'stamps', stampsRemoved: 2, recorded: true });
    expect(v.visitRemoved, 'a stamps void reported removing a visit').toBe(false);
    expect(
      memberState(STAMPS),
      'the void took a visit she was never given, or kept the stamps she was — the pre-0065 void did both',
    ).toEqual(before);
  });
});

// ============================================================ her activity --

describe('GET /members/me/transactions carries what each charge earned', () => {
  interface FeedRow {
    id: string;
    kind: string;
    voidedAt: string | null;
    loyalty?: Loyalty | null;
  }

  async function feed(f: Fixture): Promise<FeedRow[]> {
    const principal = f === TIERS ? who.tiers : who.stamps;
    const res = await treq<{ items: FeedRow[] }>('GET', '/members/me/transactions', { token: principal.wallet });
    precondition(res.status === 200, `GET /members/me/transactions answered ${res.status} ${res.raw}`);
    return res.body.items;
  }

  const rowOf = (items: FeedRow[], id: string): FeedRow => {
    const row = items.find((t) => t.id === id);
    precondition(row !== undefined, `${id} is not in her activity: ${items.map((t) => t.id).join(', ')}`);
    return row;
  };

  it('a doubled charge carries loyalty, a top-up carries null, and a void keeps the record and adds null', async () => {
    resetMember(TIERS, { visits: 1, tier: 'bronze', stamps: null });
    const topUpId = await settleTopUp(TIERS, 'feed');

    await publishBoost(TIERS, { visit: 2, stamp: 1 });
    const c = await charge(TIERS, 'feed');
    const v = await voidCharge(TIERS, c.transaction.id, 'feed');
    precondition(v.ok, 'the void did not succeed');

    const items = await feed(TIERS);

    const topUp = rowOf(items, topUpId);
    expect(topUp.kind).toBe('topup');
    // REQUIRED on the wire and null — not omitted. A missing key is the drift that
    // `TransactionSchema.loyalty.nullable()` would reject on every client.
    expect(topUp, 'the top-up omits `loyalty` instead of sending null').toHaveProperty('loyalty');
    expect(topUp.loyalty, 'a top-up claims to have earned loyalty').toBeNull();

    const charged = rowOf(items, c.transaction.id);
    expect(charged.kind).toBe('charge');
    expect(charged.loyalty, 'her activity does not say what the doubled visit earned').toEqual({
      mode: 'tiers', visitsEarned: 2, tierAfter: 'silver', climbed: true, rewardReady: false,
    });
    // Voided, and still the record of what it earned — the void undid it, it did
    // not rewrite history.
    expect(charged.voidedAt, 'the voided charge is not marked voided in her activity').not.toBeNull();

    const reversal = rowOf(items, voidIdOf(c.transaction.id));
    expect(reversal.kind).toBe('adjustment');
    expect(reversal).toHaveProperty('loyalty');
    expect(reversal.loyalty, 'the void\'s refund row claims to have earned loyalty').toBeNull();
  });

  it('a stamps charge carries the stamps arm, with no rung', async () => {
    resetMember(STAMPS, { visits: 5, tier: null, stamps: 1 });
    await publishBoost(STAMPS, { visit: 1, stamp: 2 });
    const c = await charge(STAMPS, 'feed');

    const charged = rowOf(await feed(STAMPS), c.transaction.id);
    expect(charged.loyalty).toEqual({
      mode: 'stamps', stampsEarned: 2, tierAfter: null, climbed: false, rewardReady: false,
    });
  });
});
