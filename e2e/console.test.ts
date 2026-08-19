/**
 * THE OWNER CONSOLE'S PLATFORM ROUTES, GATED SERVER-SIDE — non-negotiable #7.
 *
 * "Permissions are enforced server-side. The UI hiding a button is a courtesy, not a
 * control. Every gated endpoint needs a test that calls it directly with the permission
 * off." Before this file, `e2e/` had NO coverage of any of these eight endpoints. The
 * census in `contract.test.ts` named three of them the hour lane A's `platformConsole.ts`
 * merged — `GET /v1/platform/metrics`, `GET`/`PATCH /v1/platform/settings`,
 * `GET /v1/platform/audit` — and nothing in 673 specs had noticed them arrive. The
 * `/v1/platform/admins` set had never been named at all.
 *
 * The console screens that drive them (`Approvals.tsx`, `Policies.tsx`) are on `dev`, and
 * a screen that hides a section from an analyst is the courtesy. This file is the control.
 *
 * HOW EACH GATE IS PROVED, AND WHY ONE ASSERTION IS NOT ENOUGH
 * -----------------------------------------------------------
 * Every handler's first statement is `requirePlatform(req, <section>)`, which throws
 * `forbidden` — 403, code `forbidden` — when the section bit is false. A single "call it
 * with the permission off, get a 403" would pass against an endpoint that 403s for a
 * completely unrelated reason, or against one that does not exist and is caught by a
 * catch-all. This build has already paid for assertions satisfied by accident.
 *
 * So each endpoint is driven TWICE with the same credential, same path, same body, and
 * only the section bit changed in Postgres between the two:
 *
 *   section revoked -> 403, error `forbidden`, and the resource is untouched
 *   section granted -> anything BUT 403
 *
 * The pair is what makes it a gate rather than a coincidence. The granted call is
 * deliberately not asserted to be 200: `POST /admins` with an empty body is a 400 and
 * `PATCH`/`DELETE /admins/:id` on an id that does not exist is a 404, and both prove
 * exactly what is needed — the gate let the request through to the handler — without
 * creating or deactivating an admin as a side effect.
 *
 * THE SUBJECT IS PLT-003 / salem.a, not the seeded analyst. Mariam (PLT-002) already
 * lacks six of the nine sections, so she gives the 403 half for free — but she cannot
 * give the granted half, and a spec that only ever refuses her proves the bit is read,
 * not that it is the thing deciding. Salem is a real, signable, non-owner account that
 * holds everything, so each bit can be revoked and restored one at a time. That is also
 * why the seed created her: `api/src/db/seed.ts` says she exists "to make a guard
 * reachable".
 *
 * THE PERMISSION IS READ PER REQUEST, NOT CARRIED IN THE TOKEN.
 * `auth/principal.ts:loadPlatformPrincipal` selects the row on every request, so a
 * revocation lands on a session that is already signed in. That is asserted below rather
 * than assumed — if sections were a token claim, every 403 in this file would be
 * measuring the sign-in that happened in `beforeAll` instead of the bit it just flipped,
 * and the whole file would be theatre.
 *
 * SCOPE. `POST /v1/platform/admins/{id}/reset` and the console Admins SCREEN are being
 * built by lanes A and C and are NOT on `dev` at the time of writing — deliberately not
 * covered here. A spec written against unmerged code is the failure mode that produced a
 * flapping schema-pinned spec once.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { precondition } from './support/known-bug.js';
import {
  PLATFORM_ADMIN2,
  PLATFORM_ADMIN2_HANDLE,
  PLATFORM_ANALYST,
  PLATFORM_ANALYST_HANDLE,
  PLATFORM_OWNER,
  PLATFORM_OWNER_HANDLE,
  SALON_A,
  psql,
  scalar,
  signInDashboard,
  signInPlatform,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

/** `auth/principal.ts`. Nine sections, and the column for each on `platform_admin`. */
const SECTION_COLUMN = {
  analytics: 'perm_analytics',
  activity: 'perm_activity',
  salons: 'perm_salons',
  accounts: 'perm_accounts',
  admins: 'perm_admins',
  controls: 'perm_controls',
  approvals: 'perm_approvals',
  policies: 'perm_policies',
  audit: 'perm_audit',
} as const;

type Section = keyof typeof SECTION_COLUMN;

/**
 * `ST-001` at salon A, and she is a MANAGER — `api/src/db/seed.ts`, confirmed in SQL.
 * Deliberately the strongest merchant credential the fixtures hold: if the surface wall
 * leaked, it would leak for the most privileged salon account first, and a spec that
 * used a frontdesk token could be passing on her lack of merchant permissions rather
 * than on the scope check. Defined here because the harness exports the staff ID but no
 * handle constant, which is what `integration.test.ts` does too.
 */
const A_STAFF_HANDLE = 'noura';

let salem = '';
let analyst = '';
let owner = '';
let merchant = '';

const grant = (adminId: string, section: Section, on: boolean): void => {
  psql(
    `UPDATE platform_admin SET ${SECTION_COLUMN[section]} = ${on} WHERE id = '${adminId}';`,
  );
};

const sectionOf = (adminId: string, section: Section): string =>
  scalar(
    `select ${SECTION_COLUMN[section]} from platform_admin where id='${adminId}'`,
  ).trim();

/**
 * EVERY GATED ROUTE ON `dev`, with the section its first statement names. Read out of
 * `routes/platformConsole.ts` and `routes/platformAdmins.ts` rather than out of the
 * design, because the gate is whatever the handler calls — the design's sidebar has ten
 * sections and the table has nine, and it is the handler that refuses.
 *
 * `body` is chosen so the GRANTED call reaches the handler and then stops on its own
 * merits. `MISSING_ADMIN` is an id no seed creates, so the granted PATCH and DELETE 404
 * instead of editing a real console account.
 */
const MISSING_ADMIN = 'PLT-NO-SUCH-ADMIN';

const GATED = [
  { method: 'GET', path: '/v1/platform/metrics', section: 'analytics' },
  { method: 'GET', path: '/v1/platform/settings', section: 'controls' },
  { method: 'PATCH', path: '/v1/platform/settings', section: 'controls', body: {} },
  { method: 'GET', path: '/v1/platform/audit', section: 'audit' },
  { method: 'GET', path: '/v1/platform/admins', section: 'admins' },
  { method: 'POST', path: '/v1/platform/admins', section: 'admins', body: {} },
  { method: 'PATCH', path: `/v1/platform/admins/${MISSING_ADMIN}`, section: 'admins', body: {} },
  { method: 'DELETE', path: `/v1/platform/admins/${MISSING_ADMIN}`, section: 'admins' },
] as const;

beforeAll(async () => {
  await startTenancyApi();

  salem = await signInPlatform(PLATFORM_ADMIN2_HANDLE);
  analyst = await signInPlatform(PLATFORM_ANALYST_HANDLE);
  owner = await signInPlatform(PLATFORM_OWNER_HANDLE);
  merchant = await signInDashboard(SALON_A, A_STAFF_HANDLE);

  /**
   * The fixture every case below depends on, asserted rather than assumed. If Salem
   * arrived without `admins` the "granted" half of four cases would be measuring a 403
   * and reporting it as a gate that opened.
   */
  for (const section of Object.keys(SECTION_COLUMN) as Section[]) {
    precondition(
      sectionOf(PLATFORM_ADMIN2, section) === 't',
      `${PLATFORM_ADMIN2} arrived without ${section}, so its granted half proves nothing`,
    );
  }
  precondition(
    scalar(`select owner from platform_admin where id='${PLATFORM_ADMIN2}'`).trim() === 'f',
    `${PLATFORM_ADMIN2} is the owner, so platform_admin_owner_holds_everything blocks every revoke`,
  );
}, 120_000);

/**
 * RESTORED AFTER EVERY TEST, not at the end of the file. A revoke that leaked past a
 * failing assertion would make every later case in this file fail for the wrong reason,
 * and the report would name eight broken gates instead of one broken spec.
 */
afterEach(() => {
  psql(`
    UPDATE platform_admin
       SET perm_analytics = true, perm_activity = true, perm_salons = true,
           perm_accounts = true, perm_admins = true, perm_controls = true,
           perm_approvals = true, perm_policies = true, perm_audit = true,
           active = true
     WHERE id = '${PLATFORM_ADMIN2}';
  `);
});

afterAll(async () => {
  await stopTenancyApi();
});

// ===========================================================================

describe('every platform console endpoint is gated server-side, called directly', () => {
  for (const route of GATED) {
    const label = `${route.method} ${route.path}`;
    const body = 'body' in route ? (route.body as unknown) : undefined;

    it(`${label} answers 403 with \`${route.section}\` off`, async () => {
      grant(PLATFORM_ADMIN2, route.section, false);
      precondition(
        sectionOf(PLATFORM_ADMIN2, route.section) === 'f',
        `the revoke did not take, so this case would pass with the permission ON`,
      );

      const refused = await treq<any>(route.method, route.path, { token: salem, body });

      expect(
        refused.status,
        `${label} with ${route.section} revoked answered ${refused.status}: ${refused.raw}. ` +
          'Non-negotiable #7: the UI hiding this section is a courtesy, not a control.',
      ).toBe(403);
      expect(refused.body.error).toBe('forbidden');

      /**
       * THE PAIR. Same credential, same path, same body — only the bit changed. Not
       * asserted to be 200: an empty `POST` body is a 400 and a missing id is a 404, and
       * either one proves the request reached the handler, which is the whole claim.
       */
      grant(PLATFORM_ADMIN2, route.section, true);
      const allowed = await treq<any>(route.method, route.path, { token: salem, body });

      expect(
        allowed.status,
        `${label} still answered 403 with ${route.section} GRANTED: ${allowed.raw}. ` +
          'Then the 403 above was not this gate, and this spec was measuring nothing.',
      ).not.toBe(403);
    }, 60_000);
  }
});

// ===========================================================================

describe('and the refusal is the section bit, not the session', () => {
  /**
   * `loadPlatformPrincipal` selects the row on every request. If it did not — if
   * `sections` rode in the JWT — every 403 in the sweep above would be an artefact of
   * the sign-in in `beforeAll`, and revoking a bit mid-session would change nothing
   * until the admin signed in again. That is the difference between a permission system
   * and a permission-shaped cache, and it decides whether revoking someone's access
   * during an incident actually does anything.
   */
  it('a revoke lands on a session that is already signed in, with no re-login', async () => {
    const before = await treq<any>('GET', '/v1/platform/settings', { token: salem });
    precondition(before.status === 200, `salem cannot read settings to begin with: ${before.raw}`);

    grant(PLATFORM_ADMIN2, 'controls', false);

    const after = await treq<any>('GET', '/v1/platform/settings', { token: salem });
    expect(
      after.status,
      `the SAME token answered ${after.status} after controls was revoked: ${after.raw}. ` +
        'A section carried in the token cannot be taken away.',
    ).toBe(403);
    expect(after.body.error).toBe('forbidden');
  }, 60_000);

  /**
   * And deactivation is stronger than a revoke: `loadPlatformPrincipal` returns null for
   * an inactive row, so there is no principal at all rather than one missing a section.
   * 401, not 403 — and the distinction is the one `DELETE /admins/:id` relies on when it
   * cascades a removed admin's sessions away.
   */
  it('and deactivating the admin ends the session outright — 401, not 403', async () => {
    psql(`UPDATE platform_admin SET active = false WHERE id = '${PLATFORM_ADMIN2}';`);

    const res = await treq<any>('GET', '/v1/platform/settings', { token: salem });
    expect(
      res.status,
      `a deactivated console admin answered ${res.status}: ${res.raw}`,
    ).toBe(401);
  }, 60_000);
});

// ===========================================================================

describe('a merchant credential cannot reach an owner console route', () => {
  /**
   * THE INVERSE TEST `auth/principal.ts` NAMES AS OWED TO LANE D, verbatim: "when it
   * lands, every one of its endpoints needs the inverse test — a merchant credential
   * must not reach an owner route". `requirePlatformScope` refuses on `kind`, one line
   * before any section is consulted, so a salon's own manager — with every merchant
   * permission her salon can grant — reaches none of these.
   *
   * Swept across all eight rather than spot-checked on one, because the gate is
   * per-handler: a new console endpoint that called `requirePlatform` on a merchant
   * principal would be caught here and nowhere else.
   */
  for (const route of GATED) {
    const label = `${route.method} ${route.path}`;
    const body = 'body' in route ? (route.body as unknown) : undefined;

    it(`${label} refuses a salon dashboard token`, async () => {
      const res = await treq<any>(route.method, route.path, { token: merchant, body });
      expect(
        res.status,
        `${label} answered ${res.status} to a merchant credential: ${res.raw}`,
      ).toBe(403);
      expect(res.body.error).toBe('forbidden');
    }, 60_000);

    /**
     * A FORGED TOKEN, NOT A MISSING ONE, AND THE DIFFERENCE IS A TRAP WORTH RECORDING.
     *
     * `token: null` does NOT test anonymity on this prefix. The suite runs the API with
     * `AVO_TEST_PRINCIPALS=1`, and `auth/principal.ts:testPrincipalFor` resolves a
     * header-less request to `/v1/platform/*` to **PLT-001, the owner, holding every
     * section** — so a no-credential sweep answers 200/400/404 and reads exactly like an
     * authentication bypass. It is not one; it is the affordance the mock-era specs need,
     * and `env.ts` refuses to start with it set under `NODE_ENV=production`.
     *
     * This spec was written the wrong way first and produced eight red cases claiming
     * unauthenticated callers were reaching handlers. Recorded here because the next lane
     * to sweep these routes will reach for `token: null` for the same reason I did.
     *
     * `resolvePrincipal` consults the shim ONLY when there is no bearer at all, so a
     * syntactically-present, cryptographically-invalid token takes the real path:
     * `verifyAccessToken` returns null, no principal is attached, `requirePrincipal`
     * throws 401. That is the assertion that means something.
     */
    it(`${label} refuses a forged bearer token`, async () => {
      const res = await treq<any>(route.method, route.path, {
        token: 'not.a.real.token',
        body,
      });
      expect(
        res.status,
        `${label} answered ${res.status} to an invalid credential: ${res.raw}`,
      ).toBe(401);
    }, 60_000);
  }
});

// ===========================================================================

describe('the seeded analyst is refused the six sections she does not hold', () => {
  /**
   * The same claim as the sweep, made against an account NOBODY EDITED. Every 403 above
   * follows a `psql` write by this file, so all of them share one failure mode: if the
   * revoke and the refusal were both artefacts of the test's own SQL, the sweep would
   * still be green. Mariam is seeded without these bits, so her refusals are the
   * product's own state — this is the control on the controls.
   */
  const HERS = ['analytics', 'activity'] as const;

  it('holds analytics and activity, and nothing else — the fixture, from SQL', () => {
    for (const section of Object.keys(SECTION_COLUMN) as Section[]) {
      const expected = (HERS as readonly string[]).includes(section) ? 't' : 'f';
      expect(
        sectionOf(PLATFORM_ANALYST, section),
        `${PLATFORM_ANALYST}.${SECTION_COLUMN[section]} is not ${expected}`,
      ).toBe(expected);
    }
  });

  it('reads metrics — the one console route her analytics bit opens', async () => {
    const res = await treq<any>('GET', '/v1/platform/metrics', { token: analyst });
    expect(res.status, `the analyst cannot read metrics: ${res.raw}`).toBe(200);
  }, 60_000);

  for (const route of GATED.filter((r) => r.section !== 'analytics')) {
    const label = `${route.method} ${route.path}`;
    const body = 'body' in route ? (route.body as unknown) : undefined;

    it(`but not ${label} — she has no \`${route.section}\``, async () => {
      const res = await treq<any>(route.method, route.path, { token: analyst, body });
      expect(res.status, `${label} answered ${res.status} to the analyst: ${res.raw}`).toBe(403);
      expect(res.body.error).toBe('forbidden');
    }, 60_000);
  }
});

// ===========================================================================

describe('PATCH /v1/platform/settings is a money path, and the gate holds the money', () => {
  /**
   * WHY THIS ENDPOINT GETS ITS OWN DESCRIBE. `services/topup.ts` reads
   * `platform_settings` INSIDE the top-up transaction, so `knetFlatFils` written here
   * prices every subsequent top-up — the handler's own docstring says so. A 403 that
   * refuses the response while letting the row change would be a permission check that
   * moves AVO's commission for everyone, and no status assertion anywhere would see it.
   *
   * So this asserts the DATABASE, not the reply.
   */
  const knetFlat = (): string => scalar(`select knet_flat_fils from platform_settings`).trim();

  it('a refused PATCH does not move the commission', async () => {
    const before = knetFlat();
    precondition(before !== '', 'platform_settings has no row, so there is nothing to protect');

    grant(PLATFORM_ADMIN2, 'controls', false);
    const res = await treq<any>('PATCH', '/v1/platform/settings', {
      token: salem,
      body: { knetFlatFils: Number(before) + 77 },
    });

    expect(res.status, `a controls-revoked PATCH answered ${res.status}: ${res.raw}`).toBe(403);
    expect(res.body.error).toBe('forbidden');
    expect(
      knetFlat(),
      'the commission that prices every top-up moved on a request that was refused 403',
    ).toBe(before);
  }, 60_000);

  it('and a merchant credential cannot move it either', async () => {
    const before = knetFlat();

    const res = await treq<any>('PATCH', '/v1/platform/settings', {
      token: merchant,
      body: { knetFlatFils: Number(before) + 88 },
    });

    expect(res.status, `a merchant PATCH answered ${res.status}: ${res.raw}`).toBe(403);
    expect(knetFlat(), 'a salon manager moved AVO\'s commission').toBe(before);
  }, 60_000);

  /**
   * THE PAIR, and it is restored immediately. Without it the two refusals above are
   * consistent with an endpoint that cannot write at all, in which case they are not
   * evidence about a gate.
   */
  it('while the owner, with controls, does move it — the pair', async () => {
    const before = Number(knetFlat());
    const target = before + 5;

    const res = await treq<any>('PATCH', '/v1/platform/settings', {
      token: owner,
      body: { knetFlatFils: target },
    });
    precondition(res.status === 200, `the owner could not PATCH settings: ${res.raw}`);

    expect(
      knetFlat(),
      'the owner got 200 and the commission did not change, so the 403s above prove nothing',
    ).toBe(String(target));

    // Put it back. A later suite pricing a top-up against a commission this file moved
    // would fail for a reason that has nothing to do with it.
    const restore = await treq<any>('PATCH', '/v1/platform/settings', {
      token: owner,
      body: { knetFlatFils: before },
    });
    expect(restore.status).toBe(200);
    expect(knetFlat()).toBe(String(before));
  }, 60_000);
});

// ===========================================================================

describe('and the owner row cannot be partially de-granted at all', () => {
  /**
   * `platform_admin_owner_holds_everything` — a CHECK constraint, not application code.
   * The owner is the only route back into the `admins` section, so an owner row missing
   * a bit is a product with a section nobody can reach. This is the one gate in the file
   * that is enforced by Postgres, which is the right place for it: it holds against a
   * buggy handler, a migration, and a console admin with a psql prompt equally.
   *
   * Asserted by attempting it and reading the refusal, not by reading the DDL.
   */
  it('Postgres refuses an owner row with a section switched off', () => {
    let refused = '';
    try {
      psql(`UPDATE platform_admin SET perm_audit = false WHERE id = '${PLATFORM_OWNER}';`);
    } catch (err) {
      refused = err instanceof Error ? err.message : String(err);
    }

    expect(
      refused,
      'revoking a section from the platform owner succeeded, so the owner can be locked out',
    ).toMatch(/platform_admin_owner_holds_everything/);
    expect(
      sectionOf(PLATFORM_OWNER, 'audit'),
      'the owner lost a section despite the constraint',
    ).toBe('t');
  });
});
