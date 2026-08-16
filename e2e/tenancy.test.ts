/**
 * TENANCY — can salon B reach salon A?
 *
 * HOW TO RUN
 *
 *   pnpm install
 *   pnpm --filter @avo/api run db:up
 *   pnpm --filter @avo/api run db:migrate
 *   pnpm --filter @avo/api run db:seed
 *   cd e2e && ../node_modules/.bin/vitest run tenancy.test.ts
 *
 * This file does NOT use `support/api.ts` and is not affected by `E2E_BASE_URL`.
 * It boots lane A's real API on its own port and seeds a second salon straight
 * into lane A's docker Postgres — `support/tenancy-harness.ts` explains why and
 * exactly how. `packages/mock` has one salon and ignores the `:id` on every
 * `/salons/:id` route, so a tenancy suite pointed at it would be all red and
 * would prove nothing about the product.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The claim under audit was: "all eight salon-scoped routes call
 * `requireSameSalon`, so the hole is closed." That is a claim from reading code.
 * Nobody had ever watched a principal from salon B be refused salon A's data.
 * A multi-tenant wallet where one salon can read another's members is the worst
 * failure this product can have, so the claim needed evidence rather than
 * agreement.
 *
 * THE SHAPE OF THE EVIDENCE
 * -------------------------
 * Salon B's principal is Layla — a MANAGER at Lumière holding all nine
 * permissions, signed in for real. That matters: every 403 asserted here has to
 * come from the salon boundary. A restricted principal would produce the same
 * 403 for the wrong reason and the suite would prove nothing.
 *
 * Every refusal spec is paired with a control that performs the same call
 * against salon B's own id and expects it to succeed. A 403 from a mis-typed
 * path is not tenancy enforcement, it is a typo.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { precondition } from './support/known-bug.js';
import {
  A_MEMBER,
  A_MEMBER_NAME,
  A_MEMBER_PHONE,
  A_SERVICE,
  A_STAFF_FULL,
  A_STAFF_RESTRICTED,
  B_MEMBER,
  B_MEMBER_PHONE,
  B_SERVICE,
  B_SCANNER_DEVICE,
  B_STAFF,
  B_STAFF_HANDLE,
  SALON_A,
  SALON_B,
  SALON_NOWHERE,
  STAFF_NOWHERE,
  discoverSalonScopedRoutes,
  mintSalonAWalletToken,
  scalar,
  signInDashboard,
  signInMember,
  signInScanner,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

/** Salon B, dashboard scope — the merchant console credential. */
let bDashboard = '';
/** Salon B, scanner scope — a real device-bound PIN session. */
let bScanner = '';
/** Salon B's own customer, wallet scope. */
let bMember = '';

/** A fresh idempotency key. Never reused across specs; the server remembers. */
let n = 0;
const key = (label: string) => `tenancy-${label}-${Date.now()}-${n++}`;

beforeAll(async () => {
  await startTenancyApi();
  bDashboard = await signInDashboard(SALON_B, B_STAFF_HANDLE);
  bScanner = await signInScanner(SALON_B, B_STAFF_HANDLE, B_SCANNER_DEVICE);
  bMember = await signInMember(SALON_B, B_MEMBER_PHONE);
}, 120_000);

afterAll(async () => {
  await stopTenancyApi();
});

/**
 * Salon A strings that must never appear in a response to salon B. Checked as
 * raw text, so a leak nested three objects deep in an error body is still caught.
 */
const SALON_A_TELLTALES = [
  SALON_A,
  A_MEMBER_NAME,
  A_MEMBER_PHONE,
  'dana@example.com',
  'Amara',
  'Noura',
  'Hessa',
  'Salmiya',
  'Kuwait City',
];

function expectNoSalonALeak(raw: string, what: string): void {
  const leaked = SALON_A_TELLTALES.filter((t) => raw.includes(t));
  expect(leaked, `${what} leaked salon A data in its body: ${leaked.join(', ')}\n${raw}`).toEqual(
    [],
  );
}

// ---------------------------------------------------------------- tripwires --

/**
 * If any of these four fail, every 403 below is meaningless — either the token
 * is not salon B's, or the principal is under-privileged, or the harness is
 * quietly talking to salon A through the test-principal shim.
 */
describe('tripwires — the principals are who this suite thinks they are', () => {
  it("salon B's dashboard token is a manager at salon B, not salon A's seeded staff", async () => {
    const res = await treq<{ id: string; salonId: string; perms: Record<string, boolean> }>(
      'GET',
      '/staff/me',
      { token: bDashboard },
    );
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(B_STAFF);
    expect(res.body.salonId).toBe(SALON_B);
    expect(res.body.id).not.toBe(A_STAFF_FULL);
  });

  it('that manager holds all nine permissions, so no 403 here can be a permission 403', async () => {
    const res = await treq<{ perms: Record<string, boolean> }>('GET', '/staff/me', {
      token: bDashboard,
    });
    const off = Object.entries(res.body.perms)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    expect(off, `these permissions are off, so a 403 would be ambiguous: ${off.join(', ')}`).toEqual(
      [],
    );
  });

  it("salon B's scanner token is a real PIN session, scoped scanner not dashboard", async () => {
    // A PIN must never reach a dashboard endpoint — api-contract.md § StaffUser.
    // Proving the scope here is what makes the scanner-side specs below honest.
    const res = await treq<{ id: string; error: string; message: string }>('GET', '/staff', {
      token: bScanner,
    });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/scanner PIN cannot reach the dashboard/i);
  });

  it('an unauthenticated request is NOT anonymous under the test shim — it is salon A', async () => {
    // This is the trap `treq()` guards against, asserted rather than assumed. If
    // this ever returns 401 the shim is off, and the wallet-token mint below
    // needs salon A's member password instead.
    const res = await treq<{ id: string; salonId: string }>('GET', '/staff/me', { token: null });
    expect(res.status).toBe(200);
    expect(res.body.salonId).toBe(SALON_A);
  });
});

// ------------------------------------------------- every salon-scoped route --

interface SalonRoute {
  method: 'GET' | 'POST' | 'PATCH';
  /** `{id}` is substituted with the salon under test. */
  template: string;
  body?: unknown;
  /** The same call against salon B's own id must succeed. */
  controlBody?: unknown;
}

/**
 * The eight routes that carry a salon id in the path, as registered in
 * `api/src/routes/salons.ts` and `api/src/routes/platform.ts`.
 *
 * Bodies are the minimum the handler would accept if it got that far. They are
 * deliberately valid: a 400 from a rejected body would mask whether the tenancy
 * gate ran at all.
 */
const SALON_ROUTES: SalonRoute[] = [
  { method: 'GET', template: '/salons/{id}' },
  { method: 'GET', template: '/salons/{id}/metrics' },
  { method: 'GET', template: '/salons/{id}/products' },
  { method: 'GET', template: '/salons/{id}/bookings' },
  { method: 'GET', template: '/salons/{id}/services' },
  { method: 'GET', template: '/v1/salons/{id}/promotions' },
  {
    method: 'PATCH',
    template: '/salons/{id}',
    body: { stampTarget: 99 },
    controlBody: { stampTarget: 8 },
  },
  {
    method: 'POST',
    template: '/v1/salons/{id}/campaigns',
    body: { title: 'tenancy probe', body: 'tenancy probe', channel: 'push' },
  },
];

const url = (r: SalonRoute, salonId: string) => r.template.replace('{id}', salonId);

describe("salon-scoped routes — salon B's manager calling salon A's URL", () => {
  for (const route of SALON_ROUTES) {
    const label = `${route.method} ${route.template}`;

    it(`${label} → 403, and the body is the refusal and nothing else`, async () => {
      const res = await treq<{ error: string; message: string }>(
        route.method,
        url(route, SALON_A),
        { token: bDashboard, ...(route.body === undefined ? {} : { body: route.body }) },
      );

      expect(res.status, `${label} answered ${res.status}: ${res.raw}`).toBe(403);
      expect(res.body.error).toBe('forbidden');
      expect(res.body.message).toBe('That salon is not yours.');
      // Two keys, no third. A refusal that also carries `items: []` has told the
      // caller the route exists and the shape of what it serves.
      expect(Object.keys(res.body).sort()).toEqual(['error', 'message']);
      expectNoSalonALeak(res.raw, label);
    });

    it(`${label} against salon B's own id succeeds — the 403 was tenancy, not a broken route`, async () => {
      const body = route.controlBody ?? route.body;
      const res = await treq(route.method, url(route, SALON_B), {
        token: bDashboard,
        ...(body === undefined ? {} : { body }),
      });
      expect(res.status, `the control call answered ${res.status}: ${res.raw}`).toBe(200);
    });
  }
});

// ------------------------------------------- PATCH /staff — the escalation route --

describe('PATCH /staff/{id} — a manager at B cannot grant herself authority at A', () => {
  it("refuses to touch salon A's staff row", async () => {
    const res = await treq<{ error: string; message: string }>('PATCH', `/staff/${A_STAFF_FULL}`, {
      token: bDashboard,
      body: { perms: { team: true, marketing: true } },
    });

    // 404, not 403, and that is the stronger answer: see the existence specs
    // below. Either way it must not be a 200.
    expect(res.status).not.toBe(200);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('unknown_staff');
    expectNoSalonALeak(res.raw, 'PATCH /staff/{A}');
  });

  it("changed nothing — salon A's restricted staff row still has charges and void off", async () => {
    // The row lane D uses everywhere as the restricted principal. If a cross-salon
    // PATCH could reach it, every permission spec in permissions.test.ts becomes
    // a fiction.
    const before = scalar(
      `select perm_charges::text || ',' || perm_void::text || ',' || perm_team::text from staff_user where id='${A_STAFF_RESTRICTED}'`,
    );
    precondition(before === 'false,false,false', `${A_STAFF_RESTRICTED} is not the restricted row: ${before}`);

    const res = await treq('PATCH', `/staff/${A_STAFF_RESTRICTED}`, {
      token: bDashboard,
      body: { perms: { charges: true, void: true, team: true } },
    });
    expect(res.status).toBe(404);

    const after = scalar(
      `select perm_charges::text || ',' || perm_void::text || ',' || perm_team::text from staff_user where id='${A_STAFF_RESTRICTED}'`,
    );
    expect(after, 'a cross-salon PATCH granted permissions at salon A').toBe('false,false,false');
  });

  it("writes no audit row against salon A — a refusal is not an event in A's log", async () => {
    const before = scalar(
      `select count(*) from audit_log where salon_id='${SALON_A}' and kind='access'`,
    );
    await treq('PATCH', `/staff/${A_STAFF_FULL}`, {
      token: bDashboard,
      body: { perms: { team: true } },
    });
    const after = scalar(
      `select count(*) from audit_log where salon_id='${SALON_A}' and kind='access'`,
    );
    expect(after).toBe(before);
  });

  it("the same call against salon B's own staff succeeds — the 404 was tenancy", async () => {
    const res = await treq<{ id: string; perms: Record<string, boolean> }>('PATCH', '/staff/ST-B02', {
      token: bDashboard,
      body: { perms: { marketing: true } },
    });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('ST-B02');
    expect(res.body.perms.marketing).toBe(true);

    // Put it back, so a re-run starts where this one did.
    await treq('PATCH', '/staff/ST-B02', {
      token: bDashboard,
      body: { perms: { marketing: false } },
    });
  });
});

// ------------------------------------------------- 404 vs 403 as an oracle --

/**
 * The subtle one. "That salon is not yours" and "no such salon" must be the same
 * answer, or the API is a directory: point it at ids until one answers
 * differently and you have enumerated every tenant on the platform.
 */
describe('existence is not disclosed — a salon that is not yours reads like one that never was', () => {
  it('GET /salons/{A} and GET /salons/{never existed} are byte-identical', async () => {
    const real = await treq('GET', `/salons/${SALON_A}`, { token: bDashboard });
    const fake = await treq('GET', `/salons/${SALON_NOWHERE}`, { token: bDashboard });

    expect(real.status).toBe(fake.status);
    expect(real.raw).toBe(fake.raw);
    expect(real.status).toBe(403);
  });

  it('PATCH /staff/{A staff} and PATCH /staff/{never existed} are byte-identical', async () => {
    const real = await treq('PATCH', `/staff/${A_STAFF_FULL}`, {
      token: bDashboard,
      body: { perms: { team: true } },
    });
    const fake = await treq('PATCH', `/staff/${STAFF_NOWHERE}`, {
      token: bDashboard,
      body: { perms: { team: true } },
    });

    expect(real.status).toBe(fake.status);
    expect(real.raw).toBe(fake.raw);
    expect(real.status).toBe(404);
  });

  it('every salon-scoped route answers a real foreign id exactly as it answers an invented one', async () => {
    const differing: string[] = [];
    for (const route of SALON_ROUTES) {
      const opts = { token: bDashboard, ...(route.body === undefined ? {} : { body: route.body }) };
      const real = await treq(route.method, url(route, SALON_A), opts);
      const fake = await treq(route.method, url(route, SALON_NOWHERE), opts);
      if (real.status !== fake.status || real.raw !== fake.raw) {
        differing.push(
          `${route.method} ${route.template}: real ${real.status} ${real.raw} / invented ${fake.status} ${fake.raw}`,
        );
      }
    }
    expect(differing, `these routes distinguish an existing salon from an invented one:\n${differing.join('\n')}`).toEqual([]);
  });
});

// ------------------------------------------------------ the wallet token --

/**
 * A wallet token is a bearer credential. If it is not salon-scoped at the point
 * it is consumed, one salon's scanner can act on another salon's customer.
 */
describe('the wallet token — a bearer credential minted for salon A', () => {
  /**
   * PROMOTED — this was a `knownBug()`. It found the leak, lane A closed it, the
   * helper flipped to "appears to be FIXED", and it is a plain `it()` now so the
   * behaviour stays locked in.
   *
   * The leak: `peekToken` resolved a token by its hash alone and `POST /scans`
   * fetched the member by id with no tenant predicate, so a scanner at ANY salon
   * on a legitimate device-bound PIN session could submit a QR minted for
   * another salon's customer and be handed her name, phone, email, balance, tier
   * and visit count. The service list two lines below WAS salon-scoped, which is
   * what made the response look correct.
   *
   * The fix is structural rather than a check added to this handler:
   * `peekToken` and `consumeToken` now take a REQUIRED `TokenScope`, so a future
   * call site cannot resolve a token without saying whose salon it is resolving
   * it in — there is no overload that omits it. That is why this spec asserts
   * the refusal rather than merely a non-200: the shape is the contract, and a
   * regression that answered 500 would otherwise read as green.
   */
  it("POST /scans refuses salon A's wallet token from salon B's scanner", async () => {
    const token = await mintSalonAWalletToken();

    const res = await treq<{ error: string; message: string; member?: unknown }>('POST', '/scans', {
      token: bScanner,
      body: { token },
    });

    // 404, and 404 SPECIFICALLY — see the paired spec below for why this route
    // says something different from POST /charges.
    expect(res.status, `POST /scans answered ${res.status}: ${res.raw}`).toBe(404);
    expect(res.body.error).toBe('unknown_member');
    expect(res.body.message).toBe('No such member.');
    // Nothing about the card came back with the refusal.
    expect(res.body).not.toHaveProperty('member');
    expect(res.body).not.toHaveProperty('services');
    expect(res.body).not.toHaveProperty('heldDepositFils');
    expectNoSalonALeak(res.raw, 'POST /scans with a foreign wallet token');
  });

  /**
   * SPEC CORRECTED — the first version of this asserted the wrong equivalence,
   * and the API was right.
   *
   * It expected a foreign token and a token that was never minted anywhere to be
   * byte-identical, by analogy with the salon-existence specs above. They are
   * not: a foreign token is `404 unknown_member`, a token nobody ever minted is
   * `410 token_consumed_or_unknown`. That is deliberate, and the reasoning is
   * recorded in `api/src/services/walletToken.ts`:
   *
   *   The property that has to hold is that a FOREIGN MEMBER and an ABSENT
   *   MEMBER are indistinguishable — otherwise the 404 becomes a directory of
   *   other salons' customers, which is enumerable and worth having. Folding the
   *   foreign case into the 410 would hide one further bit (whether a token
   *   string is live somewhere on the platform) at the cost of that property.
   *   A wallet token is a 45-second, 128-bit random: nobody guesses one, so the
   *   only person who can learn that bit is someone already holding the code,
   *   who learns nothing they did not have.
   *
   * The distinction is asserted rather than the equivalence, so the trade stays a
   * decision. Collapsing these two into one answer should fail here and be
   * argued, not merged.
   */
  it('a foreign token and a token nobody ever minted answer differently — the recorded trade', async () => {
    const foreign = await mintSalonAWalletToken();
    const fromAnotherSalon = await treq<{ error: string; message: string }>('POST', '/scans', {
      token: bScanner,
      body: { token: foreign },
    });
    const neverMinted = await treq<{ error: string }>('POST', '/scans', {
      token: bScanner,
      body: { token: 'wt_this_value_was_never_minted_by_anyone' },
    });

    expect([fromAnotherSalon.status, fromAnotherSalon.body.error]).toEqual([404, 'unknown_member']);
    expect([neverMinted.status, neverMinted.body.error]).toEqual([
      410,
      'token_consumed_or_unknown',
    ]);

    // THE equivalence that does have to hold: the foreign token's refusal is the
    // same answer a member id that never existed gets, verbatim.
    const absentMember = await treq<{ error: string; message: string }>('POST', '/charges', {
      token: bScanner,
      idempotencyKey: key('absent-member-body'),
      body: { memberId: 'MEMBER-DOES-NOT-EXIST', serviceIds: [B_SERVICE] },
    });
    expect(absentMember.status).toBe(404);
    expect(
      fromAnotherSalon.body,
      "another salon's customer is distinguishable from a member who does not exist",
    ).toEqual(absentMember.body);
  });

  /**
   * TWO REFUSALS, DELIBERATELY DIFFERENT — lane A's judgement call, asserted so
   * it is a decision rather than an accident.
   *
   *   POST /scans    404 unknown_member         the token is the caller's ONLY
   *                                             identifier, so "no such member"
   *                                             is simply true, and it is the
   *                                             same answer a member that never
   *                                             existed gives.
   *
   *   POST /charges  409 token_member_mismatch  the caller already NAMED a
   *                                             member of its own salon. 404
   *                                             there would be a lie about the
   *                                             customer standing at the
   *                                             counter, and it would send the
   *                                             scanner to the wrong copy.
   *
   * Different information available, different refusal. The pair is asserted in
   * one spec so that a future change which collapses them into one code fails
   * here with the reason attached, instead of quietly making one of the two
   * endpoints less honest.
   */
  it('the two refusals differ because the two callers know different things', async () => {
    const scanToken = await mintSalonAWalletToken();
    const scan = await treq<{ error: string }>('POST', '/scans', {
      token: bScanner,
      body: { token: scanToken },
    });

    const chargeToken = await mintSalonAWalletToken();
    const charge = await treq<{ error: string }>('POST', '/charges', {
      token: bScanner,
      idempotencyKey: key('refusal-shapes'),
      // A member of salon B's OWN salon, paired with salon A's code.
      body: { memberId: B_MEMBER, serviceIds: [B_SERVICE], token: chargeToken },
    });

    expect([scan.status, scan.body.error]).toEqual([404, 'unknown_member']);
    expect([charge.status, charge.body.error]).toEqual([409, 'token_member_mismatch']);
    // Stated as an inequality too, so "both became 404" cannot pass by having
    // updated only one of the two lines above.
    expect(scan.status).not.toBe(charge.status);
  });

  it("salon B's scanner cannot spend salon A's token — the charge refuses", async () => {
    const token = await mintSalonAWalletToken();
    const res = await treq<{ error: string }>('POST', '/charges', {
      token: bScanner,
      idempotencyKey: key('spend-foreign-token'),
      body: { memberId: A_MEMBER, serviceIds: [B_SERVICE], token },
    });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('unknown_member');
    expectNoSalonALeak(res.raw, 'POST /charges with a foreign token');
  });

  it("and does not burn it — the refused charge leaves salon A's code unconsumed", async () => {
    // Non-negotiable #3: if the debit fails, nothing else happened. A foreign
    // scanner that could consume a token would be a denial-of-service on another
    // salon's customers even without taking a fil.
    const token = await mintSalonAWalletToken();
    const hashedRowsBefore = scalar(
      `select count(*) from wallet_token where member_id='${A_MEMBER}' and consumed_at is null`,
    );

    const res = await treq('POST', '/charges', {
      token: bScanner,
      idempotencyKey: key('burn-foreign-token'),
      body: { memberId: A_MEMBER, serviceIds: [B_SERVICE], token },
    });
    expect(res.status).toBe(404);

    const hashedRowsAfter = scalar(
      `select count(*) from wallet_token where member_id='${A_MEMBER}' and consumed_at is null`,
    );
    expect(hashedRowsAfter, 'a cross-salon charge consumed a wallet token').toBe(hashedRowsBefore);
  });

  it("salon B cannot charge its own member with salon A's token either", async () => {
    // The token is the authority for whose wallet this is. Pairing a foreign code
    // with a local member id is the other half of the same attack.
    const token = await mintSalonAWalletToken();
    const res = await treq<{ error: string }>('POST', '/charges', {
      token: bScanner,
      idempotencyKey: key('foreign-token-local-member'),
      body: { memberId: B_MEMBER, serviceIds: [B_SERVICE], token },
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('token_member_mismatch');
  });
});

// ------------------------------------------------------------------- scope --

/**
 * SCOPE IS NOT PERMISSION, AND BOTH DIRECTIONS HAVE TO BE CHECKED.
 *
 * The tripwires at the top of this file prove one direction: a scanner PIN
 * cannot reach `GET /staff`. This section is the inverse, and until lane A
 * landed `requireScannerPerm` it was open — `POST /charges` and `POST /scans`
 * checked the PERMISSION and never looked at `principal.scope`. Layla holds
 * every permission, so her WEB session debited a wallet.
 *
 * That matters because the two credentials are hardened differently on purpose.
 * The PIN is a four-digit shift credential: hashed, bound to a device, rate
 * limited per device and salon, locked after five failures — precisely BECAUSE
 * it can move money. A dashboard session has none of that. It is long-lived,
 * browser-based, bound to no device, refreshable for thirty days, and it is the
 * one a manager leaves signed in on a laptop in the back office. If it can
 * charge, every PIN control is optional, because the easier door is open.
 *
 * PROMOTED — both specs below were `knownBug()` and both flipped in one run when
 * the fix landed. While they were red they printed the damage: Layla's web
 * session debited member 9001 by 7.000 fils and was handed her card and phone.
 *
 * THIS SECTION IS THE ONE THAT HAD TO BYPASS THE TEST SHIM, and that is the
 * general lesson rather than a detail. `AVO_TEST_PRINCIPALS` assigns scanner
 * scope BY URL — `/scans`, `/charges` and `/voids` get a scanner principal
 * automatically. Every shim-driven spec in the other three suites was therefore
 * blind to this hole by construction: it could not present a dashboard
 * credential to a scanner route even if it tried. The bug was live, the suite
 * was green, and when it was fixed not one existing spec moved.
 *
 * These use a real `POST /auth/web/session` and a real Bearer token. Anything
 * that turns on WHICH KIND of credential is presented has to be tested with
 * credentials; whatever the shim decides for you, your suite cannot see.
 */
describe('scope — a dashboard credential must not reach the scanner surface', () => {
  it('POST /charges refuses a dashboard-scope session with 403, and debits nothing', async () => {
    const before = scalar(`select balance_fils from member where id='${B_MEMBER}'`);

    const res = await treq<{ error: string; message: string }>('POST', '/charges', {
      token: bDashboard,
      idempotencyKey: key('dashboard-charge'),
      body: { memberId: B_MEMBER, serviceIds: [B_SERVICE] },
    });

    expect(
      res.status,
      `a web session must not debit a wallet, whatever permissions it holds: ${res.raw}`,
    ).toBe(403);
    expect(res.body.error).toBe('forbidden');
    // The copy names the surface the action lives on: a manager who hits this is
    // confused, not attacking.
    expect(res.body.message).toMatch(/Charging happens on the staff scanner/i);
    expect(res.body).not.toHaveProperty('transaction');
    expect(res.body).not.toHaveProperty('balanceAfterFils');

    const after = scalar(`select balance_fils from member where id='${B_MEMBER}'`);
    expect(after, 'a dashboard-scope charge moved money').toBe(before);
  });

  it('POST /scans refuses a dashboard-scope session with 403, and discloses no card', async () => {
    // Salon B's own customer, salon B's own manager, all nine permissions held.
    // The only thing wrong is the KIND of credential.
    const minted = await treq<{ token: string }>('GET', '/members/me/wallet-token', {
      token: bMember,
    });
    precondition(minted.status === 200, `could not mint salon B's wallet token: ${minted.raw}`);

    const res = await treq<{ error: string; message: string }>('POST', '/scans', {
      token: bDashboard,
      body: { token: minted.body.token },
    });

    expect(res.status, `a web session must not resolve a wallet QR: ${res.raw}`).toBe(403);
    expect(res.body.message).toMatch(/Charging happens on the staff scanner/i);
    expect(res.body).not.toHaveProperty('member');
    expect(res.body).not.toHaveProperty('services');
    // And the refusal came BEFORE the token was resolved. A 410 here would mean
    // an unauthorised caller had already been told whether that code is live.
    expect(res.status).not.toBe(410);
  });

  it('the token a refused scan carried is still live — a wrong-surface call burns nothing', async () => {
    const minted = await treq<{ token: string }>('GET', '/members/me/wallet-token', {
      token: bMember,
    });
    precondition(minted.status === 200, `could not mint salon B's wallet token: ${minted.raw}`);

    const refused = await treq('POST', '/scans', {
      token: bDashboard,
      body: { token: minted.body.token },
    });
    expect(refused.status).toBe(403);

    const rightSurface = await treq<{ member: { id: string } }>('POST', '/scans', {
      token: bScanner,
      body: { token: minted.body.token },
    });
    expect(rightSurface.status, rightSurface.raw).toBe(200);
    expect(rightSurface.body.member.id).toBe(B_MEMBER);
  });

  it("the same two calls from salon B's SCANNER session succeed — the 403 is about scope, not the route", async () => {
    // The control. Without it, a 403 from a broken body or a missing permission
    // would have promoted the two specs above for the wrong reason.
    const minted = await treq<{ token: string }>('GET', '/members/me/wallet-token', {
      token: bMember,
    });
    precondition(minted.status === 200, `could not mint salon B's wallet token: ${minted.raw}`);

    const scan = await treq<{ member: { id: string } }>('POST', '/scans', {
      token: bScanner,
      body: { token: minted.body.token },
    });
    expect(scan.status, scan.raw).toBe(200);
    expect(scan.body.member.id).toBe(B_MEMBER);

    const charge = await treq<{ transaction: { id: string } }>('POST', '/charges', {
      token: bScanner,
      idempotencyKey: key('scanner-charge-control'),
      body: { memberId: B_MEMBER, serviceIds: [B_SERVICE] },
    });
    expect(charge.status, charge.raw).toBe(200);
    expect(charge.body.transaction.id).toMatch(/^TX-/);
  });
});

// -------------------------------------------------------- money across salons --

describe('money — salon B cannot move salon A money', () => {
  it("POST /charges on salon A's member by id 404s and debits nothing", async () => {
    const before = scalar(`select balance_fils from member where id='${A_MEMBER}'`);

    const res = await treq<{ error: string }>('POST', '/charges', {
      token: bScanner,
      idempotencyKey: key('manual-lookup'),
      body: { memberId: A_MEMBER, serviceIds: [B_SERVICE] },
    });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('unknown_member');
    // Same body as a member id that never existed — no enumeration of another
    // salon's customer list.
    expectNoSalonALeak(res.raw, 'POST /charges by member id');

    const after = scalar(`select balance_fils from member where id='${A_MEMBER}'`);
    expect(after, "salon B's charge moved salon A's balance").toBe(before);
  });

  it('a member id that never existed answers identically', async () => {
    const real = await treq('POST', '/charges', {
      token: bScanner,
      idempotencyKey: key('enum-real'),
      body: { memberId: A_MEMBER, serviceIds: [B_SERVICE] },
    });
    const fake = await treq('POST', '/charges', {
      token: bScanner,
      idempotencyKey: key('enum-fake'),
      body: { memberId: 'MEMBER-DOES-NOT-EXIST', serviceIds: [B_SERVICE] },
    });
    expect(real.status).toBe(fake.status);
    expect(real.raw).toBe(fake.raw);
  });

  it("salon A's service ids cannot be priced or charged from salon B", async () => {
    const res = await treq<{ error: string; unknown: string[] }>('POST', '/charges', {
      token: bScanner,
      idempotencyKey: key('foreign-service'),
      body: { memberId: B_MEMBER, serviceIds: [A_SERVICE] },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_services');
    expect(res.body.unknown).toEqual([A_SERVICE]);
  });

  it("POST /voids on salon A's transaction 404s and reverses nothing", async () => {
    const target = scalar(
      `select id from transaction where salon_id='${SALON_A}' and kind='charge' order by created_at desc limit 1`,
    );
    precondition(target !== '', 'salon A has no charge to try to void — run pnpm --filter @avo/api run db:seed');

    const reversalsBefore = scalar(
      `select count(*) from transaction where reverses_transaction_id='${target}'`,
    );

    const res = await treq<{ error: string }>('POST', '/voids', {
      token: bScanner,
      idempotencyKey: key('foreign-void'),
      body: { transactionId: target, reason: 'tenancy probe' },
    });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('unknown_transaction');

    const reversalsAfter = scalar(
      `select count(*) from transaction where reverses_transaction_id='${target}'`,
    );
    expect(reversalsAfter, "salon B voided salon A's charge").toBe(reversalsBefore);
  });

  it("GET /charges shows salon B's charges only", async () => {
    // The control: salon B really can charge, so the empty cross-salon reads
    // above are not a dead scanner.
    const charge = await treq<{ transaction: { id: string } }>('POST', '/charges', {
      token: bScanner,
      idempotencyKey: key('own-charge'),
      body: { memberId: B_MEMBER, serviceIds: [B_SERVICE] },
    });
    expect(charge.status, charge.raw).toBe(200);
    expect(charge.body.transaction.id).toMatch(/^TX-/);

    const list = await treq<{ items: Array<{ id: string; memberId: string }> }>('GET', '/charges', {
      token: bScanner,
    });
    expect(list.status).toBe(200);
    expect(list.body.items.some((t) => t.id === charge.body.transaction.id)).toBe(true);
    expect(list.body.items.every((t) => t.memberId === B_MEMBER)).toBe(true);
    expectNoSalonALeak(list.raw, 'GET /charges');
  });

  it("GET /staff shows salon B's roster only", async () => {
    const res = await treq<{ items: Array<{ id: string; salonId: string }> }>('GET', '/staff', {
      token: bDashboard,
    });
    expect(res.status).toBe(200);
    expect(res.body.items.every((s) => s.salonId === SALON_B)).toBe(true);
    expect(res.body.items.some((s) => s.id === A_STAFF_FULL)).toBe(false);
    expectNoSalonALeak(res.raw, 'GET /staff');
  });
});

// --------------------------------------------------------------- idempotency --

/**
 * Lane A scoped the key `(scope, endpoint, key)`. The question is what `scope`
 * contains. `principalScope()` returns `kind:id` — `member:8842`, `staff:ST-001`
 * — which is NOT the salon id, so the guarantee is not "keys are salon-scoped".
 * It is stronger in one direction and worth stating precisely: a key is scoped
 * to ONE PRINCIPAL, and since a principal belongs to exactly one salon, no key
 * can cross a salon boundary. Two salons choosing "1" on the same day is the
 * ordinary case and it must not collide.
 *
 * These specs use `POST /topups`, which creates an intent and moves no balance —
 * so the proof costs nobody a fil.
 */
describe('idempotency keys do not collide across salons', () => {
  it('the same key from salon A and salon B produces two independent results', async () => {
    const shared = `shared-key-${Date.now()}`;

    // Salon A's member, via the test shim (see the harness header).
    const a = await treq<{ id: string; memberId: string }>('POST', '/topups', {
      token: null,
      idempotencyKey: shared,
      body: { amountFils: 10_000, method: 'knet' },
    });
    // Salon B's member, a real wallet session.
    const b = await treq<{ id: string; memberId: string }>('POST', '/topups', {
      token: bMember,
      idempotencyKey: shared,
      body: { amountFils: 10_000, method: 'knet' },
    });

    expect(a.status, a.raw).toBe(200);
    expect(b.status, b.raw).toBe(200);
    expect(a.body.memberId).toBe(A_MEMBER);
    expect(b.body.memberId).toBe(B_MEMBER);
    // The failure this catches: B is handed A's stored response and shown A's
    // top-up as its own.
    expect(b.body.id).not.toBe(a.body.id);
  });

  it('and stores them under two different scopes, neither of which is a bare key', async () => {
    const shared = `shared-scope-${Date.now()}`;
    await treq('POST', '/topups', {
      token: null,
      idempotencyKey: shared,
      body: { amountFils: 5_000, method: 'knet' },
    });
    await treq('POST', '/topups', {
      token: bMember,
      idempotencyKey: shared,
      body: { amountFils: 5_000, method: 'knet' },
    });

    const scopes = scalar(
      `select string_agg(scope, ',' order by scope) from idempotency_key where key='${shared}'`,
    );
    expect(scopes).toBe(`member:${A_MEMBER},member:${B_MEMBER}`);
  });

  it('the unique index is on (scope, endpoint, key), not on the key alone', async () => {
    // The structural half. Two principals colliding is prevented by the index,
    // not by a handler remembering to include the scope in a lookup.
    const index = scalar(
      "select indexdef from pg_indexes where tablename='idempotency_key' and indexdef ilike '%UNIQUE%'",
    );
    expect(index).toMatch(/\(scope, endpoint, key\)|\(scope, ?endpoint, ?key\)/i);
  });

  it("salon B's member cannot read salon A's top-up intent by id", async () => {
    const a = await treq<{ id: string }>('POST', '/topups', {
      token: null,
      idempotencyKey: key('a-intent'),
      body: { amountFils: 15_000, method: 'card' },
    });
    precondition(a.status === 200, `could not create salon A's intent: ${a.raw}`);

    const read = await treq<{ error: string }>('GET', `/topups/${a.body.id}`, { token: bMember });
    expect(read.status).toBe(404);
    expect(read.body.error).toBe('unknown_topup');
    expectNoSalonALeak(read.raw, 'GET /topups/{A intent}');
  });

  it('the same key with a DIFFERENT body is a 422, not a replay of the first result', async () => {
    // design/api-contract.md § Addendum. Replaying would tell a client that
    // retried 5 KD as 50 KD that the 50 succeeded, and it never happened.
    const k = key('mutated-body');
    const first = await treq<{ id: string; amountFils: number }>('POST', '/topups', {
      token: bMember,
      idempotencyKey: k,
      body: { amountFils: 10_000, method: 'knet' },
    });
    expect(first.status).toBe(200);

    const second = await treq<{ error: string; message: string }>('POST', '/topups', {
      token: bMember,
      idempotencyKey: k,
      body: { amountFils: 250_000, method: 'card' },
    });
    expect(second.status).toBe(422);
    expect(second.body.error).toBe('idempotency_key_reused');
  });
});

// -------------------------------------------------------------- the gap ledger --

/**
 * THE LEDGER.
 *
 * The list above is a list a human maintains, and a list a human maintains is a
 * list that is one merge behind. This block does not hold a list: it reads
 * `api/src/routes/*.ts`, finds every route whose path carries a salon id, and
 * probes each one as salon B against salon A.
 *
 * A salon-scoped route added in week three is therefore tested the day it lands,
 * guarded or not — and if it is not guarded, this fails and names it.
 *
 * The probes send no body deliberately. Every handler in `api/src/routes` calls
 * its authority guard as the first statement, before the body is parsed, so an
 * empty body still reaches the tenancy check. A route that answers 400 here has
 * validated a body before deciding whether the caller may touch that salon at
 * all, and that ordering is itself the finding — it tells an outsider which
 * fields the route takes.
 */
describe('gap ledger — every salon-scoped route lane A registers', () => {
  const discovered = discoverSalonScopedRoutes();

  it('the scanner actually finds routes (a broken regex must not pass silently)', () => {
    const paths = discovered.map((r) => `${r.method} ${r.path}`);
    // The eight known today. More is fine — fewer means the scan broke.
    for (const known of [
      'GET /salons/:id',
      'PATCH /salons/:id',
      'GET /salons/:id/metrics',
      'GET /salons/:id/products',
      'GET /salons/:id/bookings',
      'GET /salons/:id/services',
      'GET /v1/salons/:id/promotions',
      'POST /v1/salons/:id/campaigns',
    ]) {
      expect(paths, `the route scan lost ${known}`).toContain(known);
    }
  });

  it('the hand-written table above covers every route the scanner finds', () => {
    const probed = new Set(SALON_ROUTES.map((r) => `${r.method} ${r.template.replace('{id}', ':id')}`));
    const missing = discovered
      .map((r) => `${r.method} ${r.path}`)
      .filter((s) => !probed.has(s));
    expect(
      missing,
      `a salon-scoped route exists with no spec of its own. Add it to SALON_ROUTES:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('EVERY discovered route refuses salon B with 403 and no salon A data', async () => {
    const failures: string[] = [];

    for (const route of discovered) {
      const path = route.path.replace(/:id/, SALON_A);
      const res = await treq(route.method, path, { token: bDashboard });

      if (res.status !== 403) {
        failures.push(
          `${route.method} ${route.path} (${route.file}) → HTTP ${res.status}\n      ${res.raw.slice(0, 300)}`,
        );
        continue;
      }
      const leaked = SALON_A_TELLTALES.filter((t) => res.raw.includes(t));
      if (leaked.length > 0) {
        failures.push(`${route.method} ${route.path} → 403 but leaked ${leaked.join(', ')}`);
      }
    }

    expect(
      failures,
      'TENANCY HOLE — these salon-scoped routes did not refuse a principal from another salon:\n    ' +
        failures.join('\n    '),
    ).toEqual([]);
  });
});

/**
 * GAP — tenancy questions this suite cannot answer yet, each naming what has to
 * exist first. A todo here is a promotion waiting to happen, not a rediscovery.
 */
describe('GAP: tenancy surface not reachable yet', () => {
  it.todo(
    'GET /salons/{id}/audit — the audit log is the most sensitive salon-scoped read there is and the endpoint does not exist yet (lane A)',
  );
  it.todo(
    'the owner console scope reads across salons by design; when it lands, every one of its endpoints needs the inverse test — a merchant credential must not reach an owner route',
  );
  it.todo(
    'POST /orders and the shop endpoints do not exist; when they do, a product id from another salon must not be priceable (the POST /charges service-id spec above is the pattern)',
  );
  it.todo(
    'bookings and held deposits are unimplemented; a deposit held at salon A must not be applicable to a charge at salon B',
  );
  it.todo(
    'the PSP callback has no endpoint yet; a gateway reference must resolve to the salon that created the intent, or one salon confirms another salon top-up',
  );
  it.todo(
    'receipt_job rows carry member data to WhatsApp; the worker does not exist, and when it does it needs a test that a salon B job can never select a salon A member',
  );
});
