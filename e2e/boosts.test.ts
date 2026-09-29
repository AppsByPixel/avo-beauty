/**
 * A BRANCH BOOST THAT ENDS, ONE THAT HAS NOT STARTED, AND ONE THAT IS STOPPED —
 * decided by the server at the charge, end to end.   (migration 0067, lane A `edc4238`)
 *
 * HOW TO RUN
 *
 *   cd e2e && AVO_QA_DB=avo_lane_d ../node_modules/.bin/vitest run boosts.test.ts
 *
 * WHAT IS UNDER TEST
 * ------------------
 *   PUT  /v1/salons/{id}/promotions/boosts                    perms.marketing. Each branch
 *        may carry `startsAt` / `endsAt`; a CHANGED branch whose `endsAt` has passed is
 *        400 `boost_already_ended`.
 *   POST /v1/salons/{id}/promotions/boosts/{branchId}/stop    perms.marketing. The branch
 *        goes back to 1/0/1 with no window, and records who stopped it and when.
 *   POST /charges                                            reads the boost inside its own
 *        transaction and applies it only while `startsAt <= now < endsAt` —
 *        `services/promotions.ts § isBoostLive`, the same predicate as
 *        `@avo/types § isBoostLive`. There is no `live` column; nothing flips when a
 *        boost expires. So the only way to prove "an expired boost pays nothing" is a
 *        charge after `endsAt`.
 *
 * THE MEASURE IS THE VISIT THE CHARGE RECORDED
 * --------------------------------------------
 * A 2x-visit boost earns `visitsEarned: 2`, an unboosted charge `1`. Read from the
 * charge reply AND from `transaction.loyalty_visits_earned` (migration 0065), so a reply
 * that said one thing while the row said another fails by name. Each spec that asserts
 * `+1` is paired with the SAME boost earning `+2` once its window admits the charge —
 * otherwise a `+1` would prove nothing more than a publish that never happened.
 *
 * NEVER THE WALL CLOCK
 * --------------------
 * Every window this file publishes is at least a day from its nearest edge, so no time of
 * day and no slow machine can put a charge on the wrong side of it. The two states the
 * API refuses to be published into — a window that has already ended, a start that has
 * already passed on a boost published as scheduled — are reached by moving the stored
 * bounds with SQL, the way `booking-policy.test.ts` moves a booking's clock columns. No
 * value column (`visit`, `topup`, `stamp`) is ever written in SQL, and no money column.
 *
 * ITS OWN SALON, MINTED PER RUN
 * -----------------------------
 * Salon A's `BR-KWC` carries a seeded 2x and `HH-01` is live six hours a week, so a
 * charge there is 1 or 2 by the calendar. This salon is created here under ids carrying
 * the run's stamp, with ONE open branch (so its boost pays at an unenrolled till — see
 * `loyalty-reversal.test.ts`), no happy hour (a tripwire checks), and a tier ladder whose
 * second rung is out of reach, so a climb cannot change what a charge reports.
 *
 * WHAT IS LEFT BEHIND. Charges write append-only ledger and audit rows, so the salon
 * stays. Its boost is reset to the identity after every spec and PROVED at the identity
 * in `afterAll`. The member's opening balance is given a real ledger pair up front.
 *
 * NOT HERE, DELIBERATELY: the top-up half of a boost. Lane A is removing the boost
 * top-up bonus in parallel (migration 0068, a 400 on a non-zero `topup`); trunk sends
 * those specs after it merges. Every body below sends `topup: 0`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PromotionSetSchema, isBoostLive } from '../packages/types/dist/index.js';
import { precondition } from './support/known-bug.js';
import {
  A_STAFF_FULL,
  B_MEMBER,
  apiLogTail,
  mintWalletTokenFor,
  psql,
  reconcileWalletLedger,
  scalar,
  signInDashboard,
  signInMember,
  signInScanner,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

// ------------------------------------------------------------------ fixtures --

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`.toUpperCase();
const SALON = `SAL-QA-BST-${RUN}`;
const BRANCH = `BR-QA-BST-${RUN}`;
const SERVICE = `SV-QA-BST-${RUN}`;
/** Every permission, a PIN on `DEVICE`. Publishes, stops, charges. */
const STAFF = `ST-QA-BST-${RUN}`;
const STAFF_HANDLE = `bst-${RUN.toLowerCase()}`;
/** Everything EXCEPT `marketing`. The refusal specs. */
const STAFF_NOMKT = `ST-QA-BST-${RUN}-N`;
const STAFF_NOMKT_HANDLE = `bst-n-${RUN.toLowerCase()}`;
const DEVICE = `DEV-QA-BST-${RUN}`;
const MEMBER = `QA-BST-${RUN}-M`;
const PHONE = '+96599662001';

const PRICE_FILS = 5_000;
const OPENING_FILS = 500_000;
const DAY_MS = 86_400_000;
const MARKETING_COPY = "You don't have permission to submit a campaign. A manager can grant it.";

function seed(): void {
  const staffRow = (id: string, handle: string, marketing: boolean) => `
    INSERT INTO staff_user (id, salon_id, name, handle, role, branch_access_all, branch_access_ids,
                            password_hash, pin_hash, pin_device_id,
                            perm_dashboard, perm_appointments, perm_shop, perm_loyalty, perm_team,
                            perm_scanner, perm_charges, perm_void, perm_marketing)
    SELECT '${id}', '${SALON}', 'QA Boost ${marketing ? 'Manager' : 'Reception'}', '${handle}', 'manager',
           true, '{}', s.password_hash, s.pin_hash, '${DEVICE}',
           true, true, true, true, true, true, true, true, ${marketing}
      FROM staff_user s WHERE s.id = '${A_STAFF_FULL}';`;

  psql(`
BEGIN;
INSERT INTO salon (id, name, plan, brand_color, module_booking, module_shop, loyalty_mode,
                   tiers, stamp_target, stamp_reward, deposit_fils, no_show_return_minutes,
                   business_hours, social, whatsapp_enabled, timezone)
VALUES ('${SALON}', 'QA Boost Window ${RUN}', 'starter', '#7A5C8E', false, false, 'tiers',
        '[{"name":"bronze","minVisits":0,"bonusPercent":0},{"name":"silver","minVisits":100000,"bonusPercent":5}]'::jsonb,
        NULL, NULL, 5000, 60,
        '{"morning":["10:00","13:00"],"evening":["16:00","21:00"]}'::jsonb, '[]'::jsonb, false, 'Asia/Kuwait');
INSERT INTO branch (id, salon_id, name) VALUES ('${BRANCH}', '${SALON}', 'QA boost branch');
INSERT INTO service (id, salon_id, name, price_fils) VALUES ('${SERVICE}', '${SALON}', 'QA boost blow-dry', ${PRICE_FILS});
${staffRow(STAFF, STAFF_HANDLE, true)}
${staffRow(STAFF_NOMKT, STAFF_NOMKT_HANDLE, false)}
INSERT INTO member (id, salon_id, name, phone, email, email_verified, password_hash,
                    balance_fils, visits, tier, stamps, policy_version)
SELECT '${MEMBER}', '${SALON}', 'QA Boost Customer', '${PHONE}', NULL, false,
       s.password_hash, ${OPENING_FILS}, 0, 'bronze', NULL,
       (SELECT policy_version FROM member WHERE id = '${B_MEMBER}')
  FROM staff_user s WHERE s.id = '${A_STAFF_FULL}';
COMMIT;
`);
  // Her opening balance is a real credit with a real ledger pair, so the wallet census is
  // about what the API did here and not about how the fixture was funded.
  reconcileWalletLedger(MEMBER, 'QABST');
}

// ---------------------------------------------------------------- principals --

let manager = '';
let reception = '';
let scanner = '';
let wallet = '';
let n = 0;
const key = (label: string) => `bst-${label}-${RUN}-${Date.now()}-${n++}`;

beforeAll(async () => {
  await startTenancyApi();
  seed();
  manager = await signInDashboard(SALON, STAFF_HANDLE);
  reception = await signInDashboard(SALON, STAFF_NOMKT_HANDLE);
  scanner = await signInScanner(SALON, STAFF_HANDLE, DEVICE);
  wallet = await signInMember(SALON, PHONE);
}, 120_000);

afterEach(async () => {
  // A 2x left behind would make the next spec's "+1" a statement about this one.
  if (manager) await publish({ visit: 1 });
});

afterAll(async () => {
  try {
    if (manager) await publish({ visit: 1 });
    expect(
      scalar(
        `select count(*) from boost
          where salon_id = '${SALON}'
            and (visit <> 1 or stamp <> 1 or topup <> 0 or starts_at is not null or ends_at is not null)`,
      ),
      'a boost this file published is still standing after it finished',
    ).toBe('0');
  } finally {
    await stopTenancyApi();
  }
});

// --------------------------------------------------------------------- reads --

interface BoostRow {
  visit: number;
  stamp: number;
  topup: number;
  startsAt: string | null;
  endsAt: string | null;
  stoppedAt: string | null;
  stoppedBy: string | null;
  stoppedByStaffId: string | null;
}

/** The stored row, straight from Postgres — never the API's own account of it. */
function boostRow(): BoostRow {
  const raw = scalar(
    `select concat_ws('|', visit, stamp, topup,
                      coalesce(to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), ''),
                      coalesce(to_char(ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), ''),
                      coalesce(stopped_at::text, ''), coalesce(stopped_by, ''), coalesce(stopped_by_staff_id, ''))
       from boost where salon_id = '${SALON}' and branch_id = '${BRANCH}'`,
  );
  precondition(raw !== '', `${BRANCH} has no boost row at all`);
  const [visit, stamp, topup, startsAt, endsAt, stoppedAt, stoppedBy, stoppedByStaffId] = raw.split('|');
  return {
    visit: Number(visit),
    stamp: Number(stamp),
    topup: Number(topup),
    startsAt: startsAt || null,
    endsAt: endsAt || null,
    stoppedAt: stoppedAt || null,
    stoppedBy: stoppedBy || null,
    stoppedByStaffId: stoppedByStaffId || null,
  };
}

/** The promotion set, parsed by the contract's own schema, and this branch's boost out of it. */
async function servedBoost() {
  const res = await treq<any>('GET', `/v1/salons/${SALON}/promotions`, { token: manager });
  expect(res.status, res.raw).toBe(200);
  const parsed = PromotionSetSchema.safeParse(res.body);
  expect(parsed.success, `the promotion set does not parse: ${JSON.stringify(parsed.error?.issues)}\n${res.raw}`).toBe(
    true,
  );
  const b = parsed.data!.boosts[BRANCH];
  expect(b, `the promotion set carries no boost for ${BRANCH}\n${res.raw}`).toBeDefined();
  return b!;
}

// ------------------------------------------------------------------- writes --

interface BoostBody {
  visit: number;
  stamp?: number;
  startsAt?: string | null;
  endsAt?: string | null;
}

const putBoosts = (b: BoostBody, token = manager) =>
  treq<any>('PUT', `/v1/salons/${SALON}/promotions/boosts`, {
    token,
    body: { boosts: { [BRANCH]: { topup: 0, stamp: 1, ...b } } },
  });

async function publish(b: BoostBody): Promise<void> {
  const res = await putBoosts(b);
  precondition(res.status === 200, `could not publish the boost at ${SALON}: ${res.status} ${res.raw}`);
  precondition(
    boostRow().visit === b.visit,
    'the boost endpoint answered 200 but the stored row does not carry the published visit multiplier',
  );
}

const stop = (token = manager) =>
  treq<any>('POST', `/v1/salons/${SALON}/promotions/boosts/${BRANCH}/stop`, { token });

const inDays = (d: number) => new Date(Date.now() + d * DAY_MS).toISOString();

/**
 * One charge through the real till: a PIN session on a bound device, a QR minted by the
 * customer's own session. Returns what the reply AND the row say it earned.
 */
async function charge(label: string): Promise<{ earned: number; row: number; id: string }> {
  const token = await mintWalletTokenFor(wallet, MEMBER);
  const res = await treq<any>('POST', '/charges', {
    token: scanner,
    idempotencyKey: key(label),
    // One customer, one service, several times inside two minutes — scanner.test.ts's reason.
    body: { memberId: MEMBER, serviceIds: [SERVICE], token, confirmDuplicate: true },
  });
  precondition(
    res.status === 200,
    `POST /charges at ${SALON} answered ${res.status} ${res.raw}` +
      (res.status >= 500 ? `\n--- API log ---\n${apiLogTail()}` : ''),
  );
  const id = res.body.transaction.id as string;
  const row = Number(scalar(`select coalesce(loyalty_visits_earned, -1) from transaction where id = '${id}'`));
  expect(res.body.loyalty?.mode).toBe('tiers');
  return { earned: res.body.loyalty.visitsEarned as number, row, id };
}

/** Assert a charge earned `visits`, in the reply and on the row. */
async function expectCharge(label: string, visits: 1 | 2, why: string): Promise<void> {
  const c = await charge(label);
  expect(c.earned, `${why} (the charge reply)`).toBe(visits);
  expect(c.row, `${why} (transaction.loyalty_visits_earned on ${c.id})`).toBe(visits);
}

// ================================================================= tripwires --

describe('the fixture cannot multiply on its own', () => {
  it('one open branch, no happy hour, and nothing boosted yet', async () => {
    expect(scalar(`select count(*) from branch where salon_id='${SALON}' and closed_at is null`)).toBe('1');
    expect(
      scalar(`select count(*) from happy_hour where salon_id='${SALON}'`),
      'a happy hour here would make a "+2" the wall clock instead of the boost',
    ).toBe('0');
    expect(
      scalar(`select count(*) from boost where salon_id='${SALON}' and (visit <> 1 or stamp <> 1)`),
    ).toBe('0');
    await expectCharge('control', 1, 'an unboosted charge at this salon did not earn exactly one visit');
  });
});

// ================================================================= the window --

describe('a boost applies while startsAt <= now < endsAt — at the charge, on the server', () => {
  it('RUNNING — a 2x ending tomorrow is served with its end, reads live, and earns +2', async () => {
    const endsAt = inDays(1);
    await publish({ visit: 2, endsAt });

    const served = await servedBoost();
    expect(served).toMatchObject({ visit: 2, topup: 0, stamp: 1, startsAt: null, stoppedAt: null, stoppedBy: null });
    expect(Date.parse(served.endsAt!), 'the served endsAt is not the one published').toBe(Date.parse(endsAt));
    expect(Date.parse(boostRow().endsAt!), 'boost.ends_at is not the one published').toBe(Date.parse(endsAt));
    expect(isBoostLive(served, new Date()), 'the shared predicate calls a running boost not live').toBe(true);

    await expectCharge('running', 2, 'a running 2x boost did not double the visit');
  });

  it('EXPIRED — the same boost once its endsAt has passed earns +1, and nothing had to flip', async () => {
    await publish({ visit: 2, endsAt: inDays(1) });
    await expectCharge('before-expiry', 2, 'the boost did not pay while its window was open');

    // Its end moves into the past. The values stay 2x — there is no `live` column to
    // clear, so the only thing standing between her and a doubled visit is the predicate.
    psql(`UPDATE boost SET ends_at = now() - interval '1 minute'
           WHERE salon_id = '${SALON}' AND branch_id = '${BRANCH}';`);
    expect(boostRow()).toMatchObject({ visit: 2, stoppedAt: null });

    const served = await servedBoost();
    expect(served.visit, 'the set stopped serving the values; the window alone must end it').toBe(2);
    expect(isBoostLive(served, new Date()), 'the shared predicate calls an ended boost live').toBe(false);

    await expectCharge(
      'expired',
      1,
      'a boost whose endsAt has passed still doubled the visit — the charge is not running isBoostLive',
    );
  });

  it('an endsAt already in the past is refused at publish, and the stored boost is untouched', async () => {
    await publish({ visit: 2, endsAt: inDays(1) });
    const before = boostRow();

    const res = await putBoosts({ visit: 3, endsAt: new Date(Date.now() - 60_000).toISOString() });
    expect(res.status, res.raw).toBe(400);
    expect(res.body.error).toBe('boost_already_ended');
    expect(boostRow(), 'a refused publish wrote something').toEqual(before);
  });

  it('SCHEDULED — a 2x starting tomorrow earns +1 today, and +2 once its start has passed', async () => {
    const startsAt = inDays(1);
    const endsAt = inDays(2);
    await publish({ visit: 2, startsAt, endsAt });

    const served = await servedBoost();
    expect(served.visit).toBe(2);
    expect(Date.parse(served.startsAt!)).toBe(Date.parse(startsAt));
    expect(Date.parse(served.endsAt!)).toBe(Date.parse(endsAt));
    expect(isBoostLive(served, new Date()), 'the shared predicate calls a scheduled boost live').toBe(false);

    await expectCharge('scheduled', 1, 'a boost that has not started yet already doubled the visit');

    // The same row, its start moved behind now and its end left a day away: the +1
    // above was the window, not a publish that never took.
    psql(`UPDATE boost SET starts_at = now() - interval '1 minute'
           WHERE salon_id = '${SALON}' AND branch_id = '${BRANCH}';`);
    await expectCharge('started', 2, 'the scheduled boost did not pay once its start had passed');
  });
});

// ======================================================================= stop --

describe('a stop ends the boost on the very next charge', () => {
  it('+2, stop, +1 — and the row is neutral, windowless, and says who stopped it', async () => {
    await publish({ visit: 2, endsAt: inDays(7) });
    await expectCharge('pre-stop', 2, 'the boost did not pay before it was stopped');

    const res = await stop();
    expect(res.status, res.raw).toBe(200);
    const parsed = PromotionSetSchema.safeParse(res.body);
    expect(parsed.success, `the stop reply does not parse: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    const served = parsed.data!.boosts[BRANCH]!;
    expect(served).toMatchObject({ visit: 1, topup: 0, stamp: 1, startsAt: null, endsAt: null, stoppedBy: 'QA Boost Manager' });
    expect(served.stoppedAt, 'the stop reply carries no stoppedAt').not.toBeNull();

    // The row, not the reply: neutral (`boost_stopped_is_neutral`) and whole
    // (`boost_stop_is_whole`), attributed to the staff member who stopped it.
    expect(boostRow()).toMatchObject({
      visit: 1,
      stamp: 1,
      topup: 0,
      startsAt: null,
      endsAt: null,
      stoppedBy: 'QA Boost Manager',
      stoppedByStaffId: STAFF,
    });
    expect(
      scalar(
        `select count(*) from audit_log where salon_id = '${SALON}' and action = 'Boost stopped'
            and metadata->>'branchId' = '${BRANCH}'`,
      ),
      'the stop wrote no audit row',
    ).toBe('1');

    await expectCharge('post-stop', 1, 'the charge right after the stop still doubled the visit');
  });

  it('a second stop is refused by name, and nothing is written', async () => {
    await publish({ visit: 2, endsAt: inDays(7) });
    expect((await stop()).status).toBe(200);
    const after = boostRow();

    const again = await stop();
    expect(again.status, again.raw).toBe(409);
    expect(again.body.error).toBe('boost_already_stopped');
    expect(boostRow()).toEqual(after);
  });

  it('an EXPIRED boost cannot be stopped — it has already ended', async () => {
    await publish({ visit: 2, endsAt: inDays(1) });
    psql(`UPDATE boost SET ends_at = now() - interval '1 minute'
           WHERE salon_id = '${SALON}' AND branch_id = '${BRANCH}';`);
    const res = await stop();
    expect(res.status, res.raw).toBe(409);
    expect(res.body.error).toBe('boost_already_ended');
    expect(boostRow().stoppedAt, 'a refused stop recorded a stop').toBeNull();
  });
});

// ================================================================ permission --

describe('perms.marketing, enforced on the server, on both doors', () => {
  it('PUT with marketing off is 403 and publishes nothing', async () => {
    const before = boostRow();
    const res = await putBoosts({ visit: 2, endsAt: inDays(1) }, reception);
    expect(res.status, res.raw).toBe(403);
    expect(res.body.message).toBe(MARKETING_COPY);
    expect(boostRow(), 'a refused publish changed the stored boost').toEqual(before);
    await expectCharge('put-refused', 1, 'a refused publish left a multiplier the till applied');
  });

  it('STOP with marketing off is 403, the boost keeps running, and the manager can still stop it', async () => {
    await publish({ visit: 2, endsAt: inDays(1) });
    const before = boostRow();

    const res = await stop(reception);
    expect(res.status, res.raw).toBe(403);
    expect(res.body.message).toBe(MARKETING_COPY);
    expect(boostRow(), 'a refused stop changed the stored boost').toEqual(before);
    await expectCharge('stop-refused', 2, 'a refused stop ended the boost anyway');

    // The mirror: the same call with the permission is not refused, so the 403 was the gate.
    const granted = await stop(manager);
    expect(granted.status, granted.raw).toBe(200);
  });
});
