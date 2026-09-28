/**
 * THE OVERVIEW ANALYTICS — `GET /v1/salons/{id}/overview/analytics`, lane A's
 * `7fc27fc` — AGAINST THE API THAT OWNS THE DATA.
 *
 * HOW TO RUN
 *
 *   pnpm install
 *   pnpm --dir ./api run db:up
 *   cd e2e && ../node_modules/.bin/vitest run overview-analytics.test.ts
 *
 * TWO QUESTIONS, AND NEITHER LEDGER CAN ASK EITHER
 * ------------------------------------------------
 * 1. THE FIVE SECOND-PERMISSION BLOCKS. The route is gated `dashboard` at the door,
 *    and `permission-census.test.ts` pins exactly that one line. But five blocks
 *    inside the 200 need a second permission, and are decided in the service, not
 *    by a guard the census can read:
 *
 *        topServices, upcoming.next   appointments
 *        artists                      team
 *        shop                         shop
 *        campaigns                    marketing
 *
 *    A withheld block is `{status:'withheld', reason:'permission', permission}`. A
 *    service that served `artists` — every artist's earnings — to a reader without
 *    `team` would leave every ledger in this directory green, because the 200 is the
 *    right status and the census line is byte-identical. Non-negotiable #7 says the
 *    permission is enforced server-side and needs a test that calls it with the
 *    permission OFF; for a block, "off" is a real principal missing exactly that
 *    one, and the control is the same principal with it back.
 *
 * 2. THE NUMBERS AGREE WITH THE REPORTS PAGE. The service header says a merchant
 *    comparing a widget with her Reports page "gets the same numbers", and names the
 *    two it means: `wallet.spentFils` is the `sales` report's gross, and each
 *    artist's `revenueFils` is `artist-performance`'s Earned column. Lane A's int
 *    spec reconciles both inside one rolled-back transaction by calling the two
 *    services directly. This file asks the same question of the SERVED routes, over
 *    HTTP, with the real period parser and the real window on each side — the half
 *    of the claim a merchant actually meets.
 *
 * THE PRINCIPAL IS NOURA, ST-001 — the seed's manager, who holds all nine. Not a
 * probe account holding nothing, because the question is "does this ONE permission
 * withhold this ONE block", and that needs a principal holding everything else.
 * `reports.test.ts` toggles her the same way and for the same reason; each spec
 * restores her in `finally`, and `afterAll` restores her again in case a spec was
 * killed between the two.
 *
 * THE REVENUE FIXTURE IS THIS FILE'S OWN AND IS GIVEN BACK. The seed settles no
 * booking at salon A, so `artists[].revenueFils` is zero for every artist and a
 * reconciliation of zeros against zeros proves nothing. So one completed booking,
 * settled by one charge two days ago, on Shaikha (AR-004) — written in SQL, for the
 * reason `contract.test.ts` gives its order fixtures: the value under test is the
 * READ, and driving a real booking-and-charge would put a money path inside a
 * fixture for a spec about aggregation. It is a `transaction` row and not a ledger
 * pair — `transaction_revenue` reads `transaction` — so the wallet census has nothing
 * to forgive, and her member row is at zero. All of it is deleted in `afterAll`,
 * because `reports.test.ts` runs after this file and its gross figures are hand sums.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { precondition } from './support/known-bug.js';
import {
  A_BRANCH,
  A_SERVICE,
  A_STAFF_FULL,
  B_STAFF_HANDLE,
  SALON_A,
  SALON_B,
  psql,
  scalar,
  signInDashboard,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

/** Noura, ST-001. `api/src/db/seed.ts`. */
const A_STAFF_HANDLE = 'noura';

/** The fixture. See the header. Every id is this file's and nothing else names it. */
const OV_MEMBER = 'QA-OV-0001';
const OV_MEMBER_PHONE = '+96599777501';
const OV_ARTIST = 'AR-004';
const OV_HOLD = 'TX-QAOV-HOLD';
const OV_CHARGE = 'TX-QAOV-CHARGE';
const OV_BOOKING = 'BK-QAOV-0001';
const OV_CHARGE_FILS = 8_000;
const OV_DEPOSIT_FILS = 2_000;

/**
 * The five blocks, by the permission that unlocks them. `appointments` gates two,
 * so revoking it must withhold BOTH and nothing else.
 */
const SECOND_PERMISSION = {
  appointments: ['topServices', 'upcoming.next'],
  team: ['artists'],
  shop: ['shop'],
  marketing: ['campaigns'],
} as const;
type Gated = keyof typeof SECOND_PERMISSION;
const ALL_GATED_BLOCKS = Object.values(SECOND_PERMISSION).flat();

const column = (perm: Gated) => `perm_${perm}`;

let web = '';

function at(body: unknown, path: string): any {
  return path.split('.').reduce<any>((acc, k) => (acc == null ? acc : acc[k]), body);
}

async function analytics(query = '', token = web) {
  return treq<any>('GET', `/v1/salons/${SALON_A}/overview/analytics${query}`, { token });
}

function restoreNoura(): void {
  psql(`
    UPDATE staff_user SET perm_appointments = true, perm_team = true,
                          perm_shop = true, perm_marketing = true
     WHERE id = '${A_STAFF_FULL}';
  `);
}

function removeFixture(): void {
  // booking → both transactions (`settled_transaction_id`, `hold_transaction_id` are
  // restrict) → the member.
  psql(`
    DELETE FROM booking WHERE id = '${OV_BOOKING}';
    DELETE FROM "transaction" WHERE id IN ('${OV_CHARGE}', '${OV_HOLD}');
    DELETE FROM member WHERE id = '${OV_MEMBER}';
  `);
}

beforeAll(async () => {
  await startTenancyApi();
  restoreNoura();
  web = await signInDashboard(SALON_A, A_STAFF_HANDLE);

  // An interrupted run's rows first, so the INSERTs below are the only ones.
  removeFixture();
  /**
   * Two days ago, inside every rolling window this file asks about (7d and 30d), on
   * an odd minute so `booking_artist_slot_no_overlap` — which covers `completed` —
   * does not meet another file's booking on AR-004. The password hash is copied off
   * `staff_user`, as `contract.test.ts § seedPinMember` does; nobody signs in as her.
   */
  psql(`
    INSERT INTO member (id, salon_id, name, phone, email, email_verified, password_hash,
                        balance_fils, visits, tier, stamps, policy_version)
    SELECT '${OV_MEMBER}', '${SALON_A}', 'Overview probe', '${OV_MEMBER_PHONE}', NULL, false,
           s.password_hash, 0, 1, 'bronze', NULL, 3
      FROM staff_user s WHERE s.id = '${A_STAFF_FULL}';

    INSERT INTO "transaction" (id, member_id, salon_id, branch_id, branch_assumed, kind,
                               amount_fils, method, status, created_at, settled_at)
    VALUES
      ('${OV_HOLD}', '${OV_MEMBER}', '${SALON_A}', '${A_BRANCH}', false, 'deposit_hold',
       -${OV_DEPOSIT_FILS}, 'wallet', 'settled',
       now() - interval '9 days', now() - interval '9 days'),
      ('${OV_CHARGE}', '${OV_MEMBER}', '${SALON_A}', '${A_BRANCH}', false, 'charge',
       -${OV_CHARGE_FILS}, 'wallet', 'settled',
       now() - interval '2 days', now() - interval '2 days');

    INSERT INTO booking (id, salon_id, branch_id, member_id, artist_id, service_id,
                         starts_at, ends_at, duration_min, deposit_fils, status,
                         hold_transaction_id, settled_transaction_id,
                         no_show_return_due_at, completed_at)
    VALUES ('${OV_BOOKING}', '${SALON_A}', '${A_BRANCH}', '${OV_MEMBER}', '${OV_ARTIST}', '${A_SERVICE}',
            date_trunc('minute', now()) - interval '2 days 3 hours 7 minutes',
            date_trunc('minute', now()) - interval '2 days 2 hours 37 minutes',
            30, ${OV_DEPOSIT_FILS}, 'completed', '${OV_HOLD}', '${OV_CHARGE}',
            date_trunc('minute', now()) - interval '2 days 2 hours', now() - interval '2 days');
  `);
}, 180_000);

afterAll(async () => {
  restoreNoura();
  removeFixture();
  await stopTenancyApi();
});

// ===========================================================================

describe('the principal is worth toggling at all', () => {
  it('Noura holds dashboard and all four second permissions, so every block is ok before any revoke', async () => {
    const held = scalar(
      `select concat_ws(',', perm_dashboard, perm_appointments, perm_team, perm_shop, perm_marketing)
         from staff_user where id = '${A_STAFF_FULL}'`,
    ).trim();
    expect(held, `${A_STAFF_FULL} does not hold what this file assumes`).toBe('t,t,t,t,t');

    const res = await analytics();
    expect(res.status, res.raw).toBe(200);
    for (const block of ALL_GATED_BLOCKS) {
      expect(at(res.body, block)?.status, `${block} with every permission held: ${res.raw.slice(0, 600)}`).toBe('ok');
    }
  });
});

describe('the five second-permission blocks — withheld with the permission off, ok with it on', () => {
  for (const [perm, blocks] of Object.entries(SECOND_PERMISSION) as Array<[Gated, readonly string[]]>) {
    it(`perms.${perm} off withholds ${blocks.join(' and ')} — naming ${perm} — and nothing else; back on, ${blocks.join(' and ')} answer`, async () => {
      try {
        psql(`UPDATE staff_user SET ${column(perm)} = false WHERE id = '${A_STAFF_FULL}';`);
        precondition(
          scalar(`select ${column(perm)} from staff_user where id = '${A_STAFF_FULL}'`).trim() === 'f',
          'the revoke did not take',
        );

        const off = await analytics();
        expect(
          off.status,
          `the whole read answered ${off.status} with only ${perm} off — a block is withheld, the endpoint is not: ${off.raw}`,
        ).toBe(200);
        for (const block of blocks) {
          expect(
            at(off.body, block),
            `perms.${perm} is off and ${block} was served anyway — non-negotiable #7, inside a 200`,
          ).toEqual({ status: 'withheld', reason: 'permission', permission: perm });
        }
        // And ONLY those: a revoke that withheld a neighbour would be a blanket gate
        // wearing a per-block label, and the neighbour's permission is still held.
        for (const other of ALL_GATED_BLOCKS.filter((b) => !blocks.includes(b))) {
          expect(at(off.body, other)?.status, `revoking ${perm} also withheld ${other}`).toBe('ok');
        }

        restoreNoura();
        const on = await analytics();
        expect(on.status, on.raw).toBe(200);
        for (const block of blocks) {
          expect(
            at(on.body, block)?.status,
            `${block} still withheld with perms.${perm} back — the refusal was not the permission's`,
          ).toBe('ok');
        }
      } finally {
        restoreNoura();
      }
    }, 60_000);
  }

  it('the withheld reasons stay distinct: module_off outranks a permission she holds (salon B sells nothing)', async () => {
    /**
     * `shop` is checked for the MODULE before the permission. Layla (ST-B01) holds
     * all nine, and salon B's `module_shop` is off in `seedSalonB()` — so a block
     * withheld as `permission` here would be the service consulting the wrong fact.
     */
    precondition(
      scalar(`select module_shop from salon where id = '${SALON_B}'`).trim() === 'f',
      'salon B sells through AVO now, so this spec is not asking about module_off',
    );
    const layla = await signInDashboard(SALON_B, B_STAFF_HANDLE);
    const res = await treq<any>('GET', `/v1/salons/${SALON_B}/overview/analytics`, { token: layla });
    expect(res.status, res.raw).toBe(200);
    expect(res.body.modules.shop).toBe(false);
    expect(res.body.shop).toEqual({ status: 'withheld', reason: 'module_off', permission: null });
  });
});

describe('the numbers are the Reports page’s numbers, over HTTP', () => {
  const report = (kind: string, period: string) =>
    treq<any>('GET', `/salons/${SALON_A}/reports/${kind}?period=${period}`, { token: web });

  for (const period of ['7d', '30d']) {
    it(`period=${period}: wallet.spentFils is the sales report's gross`, async () => {
      const [ov, sales] = [await analytics(`?period=${period}`), await report('sales', period)];
      expect(ov.status, ov.raw).toBe(200);
      expect(sales.status, sales.raw).toBe(200);
      expect(ov.body.wallet.status).toBe('ok');
      // Not zeros against zeros: this file's own charge is inside the window.
      expect(ov.body.wallet.spentFils, 'wallet.spentFils is 0, so this reconciliation proves nothing').toBeGreaterThanOrEqual(
        OV_CHARGE_FILS,
      );
      expect(
        ov.body.wallet.spentFils,
        `the Overview says ${ov.body.wallet.spentFils} left wallets in ${period} and the sales report ` +
          `says ${sales.body.stat.value}. One of them has a definition the other does not.`,
      ).toBe(sales.body.stat.value);
    });

    it(`period=${period}: every artist's revenueFils is artist-performance's Earned, artist by artist`, async () => {
      const [ov, perf] = [await analytics(`?period=${period}`), await report('artist-performance', period)];
      expect(ov.status, ov.raw).toBe(200);
      expect(perf.status, perf.raw).toBe(200);
      expect(ov.body.artists.status).toBe('ok');

      const items = ov.body.artists.items as Array<{ artistId: string; name: string; revenueFils: number }>;
      const fixture = items.find((a) => a.artistId === OV_ARTIST);
      expect(fixture, `${OV_ARTIST} is not in the artists block`).toBeDefined();
      expect(
        fixture!.revenueFils,
        `${OV_ARTIST} earned nothing in the window, so the settled booking this file wrote was not attributed`,
      ).toBeGreaterThanOrEqual(OV_CHARGE_FILS);

      const earned = new Map(
        (perf.body.rows as Array<{ attributedTo: string; earnedFils: number }>).map((r) => [
          r.attributedTo,
          r.earnedFils,
        ]),
      );
      const disagree = items
        .filter((a) => earned.get(a.name) !== a.revenueFils)
        .map((a) => `${a.name}: overview ${a.revenueFils}, artist-performance ${earned.get(a.name)}`);
      expect(disagree, `the two surfaces disagree about what an artist earned in ${period}`).toEqual([]);
    });
  }
});
