/**
 * TENANCY — can salon B reach salon A?
 *
 * HOW TO RUN
 *
 *   pnpm install
 *   pnpm --dir ./api run db:up
 *   pnpm --dir ./api run db:migrate
 *   pnpm --dir ./api run db:seed
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
  A_HAPPY_HOUR,
  A_STAFF_FULL,
  A_STAFF_RESTRICTED,
  A_BRANCH,
  B_BRANCH,
  B_BRANCH_DISPOSABLE,
  B_HAPPY_HOUR,
  B_HAPPY_HOUR_DISPOSABLE,
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
  branchIdsNamed,
  mintSalonAWalletToken,
  retireBranches,
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
  /**
   * THE BRANCH THE POST CONTROL CREATED, RETIRED.
   *
   * The gap ledger's control half performs its write for real, so the moment
   * `POST /salons/{id}/branches` started working this file began adding a branch
   * to salon B on every run and leaving it there. An extra open branch changes
   * what `services/branch.ts` decides and, because lane A mints ids as `BR-` plus
   * random base36, it wins `resolveBranch`'s alphabetical tie-break about three
   * times in five — a suite that fails differently on Tuesday.
   *
   * `retireBranches` and not a DELETE, and the reason is the same tie-break one
   * level deeper: this file charges after the ledger runs, so those charges are
   * attributed to the probe branch and the row cannot be removed without
   * rewriting money history. Closing it is enough — a closed branch wins no
   * tie-breaks and counts toward nobody's open-branch total. See the helper.
   *
   * Scoped by name prefix and salon, so it can only ever match rows this file
   * made.
   */
  retireBranches(SALON_B, branchIdsNamed(SALON_B, PROBE_BRANCH_PREFIX));
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
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /**
   * `{id}` is substituted with the salon under test.
   *
   * `{hid}` is substituted with a happy hour BELONGING TO THAT SALON — salon A's
   * seeded window when probing salon A, salon B's own when running the control. A
   * single hard-coded id cannot serve both: salon A's `HH-01` does not exist at
   * salon B, so the control would 404 and the ledger would report a tenancy hole
   * that is really a missing fixture.
   *
   * `{bid}` is the same arrangement for a branch, with one extra constraint: the
   * salon B substitution must be the DISPOSABLE branch, because the control call
   * really renames and really closes it. See `branchFor`.
   */
  template: string;
  body?: unknown;
  /** The same call against salon B's own id must succeed. */
  controlBody?: unknown;
  /**
   * What the control call answers on success. Defaults to 200.
   *
   * Not every write returns one — `POST …/happy-hours` is a 201 and
   * `DELETE …/happy-hours/{hid}` is a 204. Asserting 200 across the board turns a
   * correctly implemented route into a red ledger entry.
   */
  controlStatus?: number;
}

/**
 * The branch the POST control creates, named so `afterAll` can find it and so no
 * two runs against one database can collide on `branch_salon_name_uq`.
 *
 * Declared above the table because the table uses it. A `const` below would be
 * in its temporal dead zone at module evaluation, which is a crash and not a
 * lint.
 */
const PROBE_BRANCH_PREFIX = 'Tenancy probe branch';
const PROBE_BRANCH_NAME = `${PROBE_BRANCH_PREFIX} ${Date.now()}`;

/**
 * Every route that carries a salon id in the path, as registered in
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
  // Added by trunk when lane A's five new routes merged. The ledger fired
  // correctly on the merge — that is what it is for. Its sibling assertion,
  // which drives every AUTO-DISCOVERED route, already passed against all five,
  // so tenancy was proven before this list was updated; only the hand-written
  // half was stale.
  { method: 'GET', template: '/salons/{id}/artists' },
  // Lane A's customer-facing roster. Same story a third time: the auto-discovering
  // sibling passed on it the moment it landed, and lane A independently confirmed a
  // member on another salon's `/artists/bookable` gets 403. Only this half was stale.
  { method: 'GET', template: '/salons/{id}/artists/bookable' },
  { method: 'GET', template: '/salons/{id}/audit' },
  { method: 'GET', template: '/salons/{id}/activity' },
  { method: 'GET', template: '/salons/{id}/loyalty' },
  {
    method: 'PUT',
    template: '/salons/{id}/loyalty',
    body: {
      tiers: [
        { name: 'bronze', minVisits: 0, bonusPercent: 0 },
        { name: 'silver', minVisits: 4, bonusPercent: 10 },
        { name: 'gold', minVisits: 10, bonusPercent: 20 },
        { name: 'black', minVisits: 20, bonusPercent: 30 },
      ],
    },
  },

  /**
   * LANE A'S FOUR PROMOTION WRITES.
   *
   * These are the first entries in this table that need real fixtures rather than
   * only a valid body, and the difference is worth stating because adding them
   * from outside the suite is what broke: the control half — "against salon B's
   * own id succeeds" — genuinely performs the write, so
   *
   *   - `PATCH` and `DELETE` need a happy hour that EXISTS AT SALON B. `{hid}` is
   *     substituted per salon for that reason; salon A's `HH-01` is not salon B's.
   *   - `DELETE`'s control really deletes it, so its fixture is re-created by
   *     `seedSalonB()` on every run. A stable id would pass once and 404 for ever.
   *   - `POST` answers 201 and `DELETE` answers 204, hence `controlStatus`.
   *
   * The bodies below are deliberately valid AND harmless. Every boost is 1x/0/1x
   * and every window is created `on: false`, because the control call writes them
   * to salon B for real and a live 2x-visit promotion would change what
   * `scanner.test.ts` observes a charge doing.
   */
  {
    method: 'PUT',
    template: '/v1/salons/{id}/promotions/boosts',
    // The identity boost — no multiplier anywhere. Proves the route runs without
    // making any other suite's money literals depend on this one having run.
    body: { boosts: { [B_BRANCH]: { visit: 1, topup: 0, stamp: 1 } } },
  },
  {
    method: 'POST',
    template: '/v1/salons/{id}/promotions/happy-hours',
    body: {
      branchId: 'all',
      days: [3],
      from: '09:00',
      to: '10:00',
      reward: 'x2visit',
      on: false,
      notify: false,
    },
    controlStatus: 201,
  },
  {
    method: 'PATCH',
    template: '/v1/salons/{id}/promotions/happy-hours/{hid}',
    body: { on: false },
  },
  {
    method: 'DELETE',
    template: '/v1/salons/{id}/promotions/happy-hours/{hid}',
    controlStatus: 204,
  },

  /**
   * LANE A'S THREE BRANCH WRITES.
   *
   * The ledger fired on the merge, correctly — its auto-discovering sibling had
   * already proved all three refuse a principal from another salon, so tenancy
   * was never in doubt; only this hand-written half was stale.
   *
   * These are the most destructive control calls in the table, and a branch is
   * not a promotion. The open-branch COUNT of a salon is what `services/branch.ts`
   * decides on, so a control call that closes the wrong row rewrites what
   * `promotions.test.ts` measures three files later. Hence:
   *
   *   - `POST` creates a REAL branch at salon B. Its name is unique per run —
   *     `branch_salon_name_uq` spans CLOSED branches, so a fixed name would 409
   *     against any database this suite ran on twice — and `afterAll` removes it.
   *     That leak, uncleaned, is what took `dev` to fifteen failures.
   *   - `PATCH` and `DELETE` point at `B_BRANCH_DISPOSABLE`, never at a fixture.
   *     A rename would collide on the unique index next run, and a close would
   *     drop salon B to one open branch, flipping every charge in the suite from
   *     "assumed" to "established".
   *   - `DELETE` answers 200 carrying the closed branch, not 204. A close is a
   *     state the merchant has to be shown, not a disappearance — so the default
   *     `controlStatus` is right and saying so here is the point.
   */
  {
    method: 'POST',
    template: '/salons/{id}/branches',
    body: { name: PROBE_BRANCH_NAME },
    controlStatus: 201,
  },
  {
    method: 'PATCH',
    template: '/salons/{id}/branches/{bid}',
    // `nameAr` rather than `name`: the Arabic twin is nullable and unconstrained,
    // so the control call cannot collide with `branch_salon_name_uq` however many
    // times this suite has run.
    body: { nameAr: 'فرع الاختبار' },
  },
  {
    method: 'DELETE',
    template: '/salons/{id}/branches/{bid}',
  },
  /**
   * The closure PREVIEW, and it is listed after the DELETE for a reason worth
   * keeping: on salon B the control calls run in order, so by the time this one
   * fires the disposable branch has already been closed by the entry above. The
   * preview answers 200 for a closed branch — `closable: false` with
   * `blockedReason: 'already_closed'` — so the control still succeeds, and the
   * ordering is harmless rather than merely lucky.
   *
   * A READ that answers what a WRITE would do, which is exactly the shape that
   * needs the cross-salon check as much as the write does: the impact report names
   * this salon's staff and counts her customers' held deposits. Leaking it would
   * leak the roster and the money without changing anything, and a route that only
   * looks is the one most easily assumed to be safe.
   */
  {
    method: 'GET',
    template: '/salons/{id}/branches/{bid}/closure-preview',
  },
];

/**
 * A branch that belongs to the salon being addressed.
 *
 * Salon B always gets the disposable one — the PATCH renames it and the DELETE
 * closes it, and `seedSalonB()` restores both on the next run. Salon A gets a
 * real seeded branch for the same reason the happy hour does: the cross-salon
 * probe must be refused by `requireSameSalon` BEFORE the branch is read, and an
 * id that does not exist anywhere would make a 404-instead-of-403 impossible to
 * tell from the tenancy check running too late.
 */
const branchFor = (salonId: string): string =>
  salonId === SALON_B ? B_BRANCH_DISPOSABLE : A_BRANCH;

/**
 * A happy hour that belongs to the salon being addressed.
 *
 * The DELETE route gets the disposable one at salon B — the control deletes it,
 * and `seedSalonB()` puts it back on the next run. Everything else gets the
 * stable window.
 *
 * At salon A this only ever has to be an id the handler would recognise: the
 * cross-salon probes must be refused by `requireSameSalon` BEFORE the happy hour
 * is looked up, and a 404 in place of a 403 would mean the tenancy check ran too
 * late — which the ledger's own assertions would then catch, correctly.
 */
function happyHourFor(route: SalonRoute, salonId: string): string {
  if (salonId !== SALON_B) return A_HAPPY_HOUR;
  return route.method === 'DELETE' ? B_HAPPY_HOUR_DISPOSABLE : B_HAPPY_HOUR;
}

const url = (r: SalonRoute, salonId: string) =>
  r.template
    .replace('{id}', salonId)
    .replace('{hid}', happyHourFor(r, salonId))
    .replace('{bid}', branchFor(salonId));

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
      expect(res.status, `the control call answered ${res.status}: ${res.raw}`).toBe(
        route.controlStatus ?? 200,
      );
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
    precondition(target !== '', 'salon A has no charge to try to void — run pnpm --dir ./api run db:seed');

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
    /**
     * Every route known today. More is fine — fewer means the scan broke.
     *
     * KEPT IN STEP WITH THE TABLE ON PURPOSE. This list was left at the original
     * eight while nine more routes landed, which quietly weakened the tripwire to
     * the point where the regex could have lost every write route and still
     * passed. The whole job of this spec is to fail when the scanner stops seeing
     * things, and a scanner that only has to see the 2024 routes cannot do it.
     *
     * The four DELETE/PATCH/PUT/POST promotion writes matter most here: they carry
     * the awkward shapes — a second path parameter, and a generic between the
     * method and the paren — that a naive regex misses first.
     */
    for (const known of [
      'GET /salons/:id',
      'PATCH /salons/:id',
      'GET /salons/:id/metrics',
      'GET /salons/:id/products',
      'GET /salons/:id/bookings',
      'GET /salons/:id/services',
      'GET /salons/:id/artists',
      'GET /salons/:id/artists/bookable',
      'GET /salons/:id/audit',
      'GET /salons/:id/activity',
      'GET /salons/:id/loyalty',
      'PUT /salons/:id/loyalty',
      'GET /v1/salons/:id/promotions',
      'PUT /v1/salons/:id/promotions/boosts',
      'POST /v1/salons/:id/promotions/happy-hours',
      'PATCH /v1/salons/:id/promotions/happy-hours/:hid',
      'DELETE /v1/salons/:id/promotions/happy-hours/:hid',
      'POST /v1/salons/:id/campaigns',
      // Lane A's phase-4 branch writes. These are what closed the phase-4
      // criterion — a salon can open, rename and close a location without an
      // engineer — so a scan that stops seeing them is a scan that would let the
      // most destructive salon-scoped routes in the API go unprobed.
      'POST /salons/:id/branches',
      'PATCH /salons/:id/branches/:bid',
      'DELETE /salons/:id/branches/:bid',
    ]) {
      expect(paths, `the route scan lost ${known}`).toContain(known);
    }
  });

  it('the hand-written table above covers every route the scanner finds', () => {
    // `{id}` → `:id`, `{hid}` → `:hid`, `{bid}` → `:bid`: the table writes path
    // parameters in braces so `url()` can substitute them, the route scanner
    // reads them as fastify registers them. EVERY placeholder has to be
    // translated or a route that IS in the table reads as missing — and the
    // failure lands as "add it to SALON_ROUTES" against an entry already there,
    // which is a confusing hour for whoever adds the next parameterised route.
    const probed = new Set(
      SALON_ROUTES.map(
        (r) =>
          `${r.method} ${r.template
            .replace('{id}', ':id')
            .replace('{hid}', ':hid')
            .replace('{bid}', ':bid')}`,
      ),
    );
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
  /**
   * CORRECTED — this said bookings and held deposits are "unimplemented". They
   * are: `api/drizzle/0013_booking.sql`, `api/src/services/booking.ts`, and the
   * hold is applied inside `api/src/services/charge.ts`. So the case is no longer
   * blocked on lane A; it is simply unwritten, and it is now writable.
   */
  /**
   * COVERED — `e2e/deposit.test.ts` asserts both walls: salon B's scanner cannot
   * reach a salon A member at all (404, and the refusal does not leak her name),
   * and no booking of hers is recorded against salon B. The inner wall is
   * `findApplicableHold`'s salonId predicate; the outer is the route's own tenancy
   * check, and a spec proving only the outer would go quiet the day a route stopped
   * enforcing it.
   */
  it.todo(
    'the PSP callback has no endpoint yet; a gateway reference must resolve to the salon that created the intent, or one salon confirms another salon top-up',
  );
  it.todo(
    'receipt_job rows carry member data to WhatsApp; the worker does not exist, and when it does it needs a test that a salon B job can never select a salon A member',
  );
});
