/**
 * Non-negotiable #7 — permissions are enforced server-side.
 *
 *   "The UI hiding a button is a courtesy, not a control. Every gated endpoint
 *    needs a test that calls it directly with the permission off."
 *
 * Every spec here talks to the endpoint over HTTP with no UI in the loop, as a
 * principal whose permission is off, and asserts two things: the 403, and that
 * nothing happened. A 403 that still performed the write is the failure mode
 * this file exists to catch.
 *
 * The restricted principal is the mock's `noperms` scenario — Hessa, ST-002,
 * frontdesk, `scanner:true, charges:false, void:false`
 * (packages/mock/src/fixtures.ts). Against lane A's API the same specs run with
 * a real PIN session for a staff row with those permissions; only the way the
 * principal is selected changes.
 */

/**
 * READ THIS FIRST: THIS FILE RUNS AGAINST `packages/mock`, NOT AGAINST THE API.
 *
 * `support/api.js` resolves `E2E_BASE_URL`, and `support/global-setup.ts` always
 * points that at `packages/mock` — an in-memory `Map` with no Postgres and no
 * authority layer beyond two hardcoded gates. The `knownBug` at the bottom of this
 * file has been saying so all along: "packages/mock enforces only charges and void".
 *
 * SO NON-NEGOTIABLE #7 IS NOT PROVED HERE. It is proved in `authority.test.ts`,
 * which drives all nine permissions against the real API and real Postgres, with a
 * principal that holds nothing, a control reading with each permission granted, and
 * the design's own refusal copy asserted per permission. That file exists because of
 * what this one could not do, and it found nothing wrong — every gate was already
 * there.
 *
 * WHAT THIS FILE IS STILL FOR, and it is not nothing: the UI lanes build against
 * this mock, so "does the mock refuse the way the API refuses" is a real question
 * for them. A mock that answered 200 where the API answers 403 would have the
 * dashboard rendering a section the product forbids. That is a shape check on a
 * stub, which is worth having and is a smaller claim than the file's name suggests.
 *
 * The `charges` and `void` probes below are separately proved against the real API
 * in `scanner.test.ts` — with a genuinely restricted PIN session, not a scenario
 * header — so nothing here is the only evidence for either.
 */

import { describe, expect, it } from 'vitest';
import {
  MEMBER_ID,
  SALON_ID,
  SERVICE,
  api,
  ensureBalanceAtLeast,
  idempotencyKey,
  targetKind,
} from './support/api.js';
import { knownBug } from './support/known-bug.js';

const NOPERMS = 'noperms';

/**
 * Which server these specs are driving. The 403 specs below hold against both;
 * the gap ledger at the bottom does not, and says so rather than pretending.
 */
const TARGET = await targetKind();

/**
 * The nine permissions on `StaffPermsSchema` (packages/types/src/entities.ts:224).
 * Kept as a literal list on purpose — if the schema grows a tenth permission the
 * "schema has exactly these nine" spec below fails, and whoever added it has to
 * decide here which endpoint enforces it.
 */
const NINE_PERMISSIONS = [
  'dashboard',
  'appointments',
  'shop',
  'loyalty',
  'team',
  'scanner',
  'charges',
  'void',
  'marketing',
] as const;
type PermissionName = (typeof NINE_PERMISSIONS)[number];

// -------------------------------------------------------------- the principal --

describe('the restricted principal', () => {
  /**
   * If `noperms` ever stopped returning a restricted staff member, every 403
   * spec below would go green for the wrong reason. This is the tripwire.
   */
  it('GET /staff/me under `noperms` is a staff member with charges and void off', async () => {
    const res = await api<{ id: string; role: string; perms: Record<string, boolean> }>(
      'GET',
      '/staff/me',
      { scenario: NOPERMS },
    );

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('ST-002');
    expect(res.body.role).toBe('frontdesk');
    expect(res.body.perms.charges).toBe(false);
    expect(res.body.perms.void).toBe(false);
    // Scanner stays ON — this member can take payment, she just cannot review or
    // reverse one. That is the whole point of the fixture.
    expect(res.body.perms.scanner).toBe(true);
  });

  it('perms carries exactly the nine permissions in StaffPermsSchema', async () => {
    const res = await api<{ perms: Record<string, boolean> }>('GET', '/staff/me', {
      scenario: NOPERMS,
    });
    expect(Object.keys(res.body.perms).sort()).toEqual([...NINE_PERMISSIONS].sort());
  });

  it('never returns a PIN, a PIN hash or a password (non-negotiable #6)', async () => {
    const res = await api('GET', '/staff/me', { scenario: NOPERMS });
    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toMatch(/"pin"\s*:/i);

    /**
     * MATCHED ON THE CREDENTIAL FORMS, NOT ON THE SUBSTRING `password`.
     *
     * This read `/pinHash|password|passwordHash/i` and went red the moment
     * `passwordSet` arrived on the staff row — which is a BOOLEAN FLAG, and the
     * exact counterpart of the `pinSet` the line below has always blessed. The
     * Accounts screen renders it precisely so it can show WHETHER a password is
     * set without holding one, which is non-negotiable #6 being obeyed rather
     * than broken.
     *
     * So this spec was one report away from being read as "the API leaked a
     * password" when what it had actually found was the API refusing to. A false
     * positive on a credential check is expensive in both directions: it spends a
     * security investigation now, and it teaches the next reader to relax the
     * pattern instead of looking. The forms below are the ones that would be a
     * real leak.
     */
    expect(serialised).not.toMatch(/pinHash|passwordHash|"password"\s*:|\$argon2/i);
    // `pinSet` and `passwordSet` are boolean flags and are fine — it is the hash
    // that must never travel.
    expect((res.body as { pinSet: boolean }).pinSet).toBe(true);
    expect(
      (res.body as { passwordSet?: boolean }).passwordSet,
      'passwordSet is what the Accounts screen shows instead of the password it must never hold, ' +
        'so it has to be a boolean and not a string that happens to look like one',
    ).toBe(true);
  });
});

// ----------------------------------------------------------- perms.charges ----

describe('perms.charges — GET /charges', () => {
  it('403s when called directly with the permission off', async () => {
    const res = await api<{ error: string; message: string }>('GET', '/charges?date=today', {
      scenario: NOPERMS,
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
    // The 403 names who can grant it — design/AVO Staff Scanner.dc.html, locked state.
    expect(res.body.message).toMatch(/manager can grant it/i);
  });

  it('leaks no charge data in the 403 body — the refusal is the whole response', async () => {
    const res = await api<Record<string, unknown>>('GET', '/charges?date=today', {
      scenario: NOPERMS,
    });

    expect(res.status).toBe(403);
    // "No side effect" for a read is: nothing was disclosed. Not one row, not a count.
    expect(res.body).not.toHaveProperty('items');
    expect(res.body).not.toHaveProperty('nextCursor');
    expect(JSON.stringify(res.body)).not.toMatch(/AVO-CHG|TX-\d+|amountFils/);
  });

  it('the same endpoint returns data for a principal that holds the permission', async () => {
    // Proves the 403 above came from the permission and not from the route being
    // broken, mis-pathed or unimplemented.
    const res = await api<{ items: Array<{ kind: string }> }>('GET', '/charges?date=today');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.items.every((t) => t.kind === 'charge')).toBe(true);
  });
});

// -------------------------------------------------------------- perms.void ----

describe('perms.void — POST /voids', () => {
  it('403s when called directly with the permission off', async () => {
    const res = await api<{ error: string; message: string }>('POST', '/voids', {
      scenario: NOPERMS,
      idempotencyKey: idempotencyKey('void-noperms'),
      body: { transactionId: 'TX-9021', reason: 'customer changed her mind' },
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
    expect(res.body.message).toMatch(/manager can grant it/i);
  });

  it('moves no money — the refused void returns no refund and changes no transaction', async () => {
    const before = await api<{ items: Array<Record<string, unknown>> }>(
      'GET',
      '/members/me/transactions',
    );
    expect(before.status).toBe(200);

    /**
     * The target is taken FROM the feed rather than named as `TX-9021`.
     *
     * The seeded charge is real and the id was correct, but the feed is the fifty
     * most recent rows and every run of these suites pushes new ones onto it. On
     * a database that had been run against a few times TX-9021 had simply fallen
     * off the page, and `expect(target).toBeDefined()` failed — a spec about a 403
     * writing nothing, reporting a pagination boundary.
     *
     * Any charge on the first page does the job: the assertion is that the refused
     * void changed it, and a row this spec can see is a row it can check.
     */
    const target = before.body.items.find((t) => t.kind === 'charge');
    expect(
      target,
      'the activity feed contains no charge to attempt a void against',
    ).toBeDefined();
    const targetId = String(target!.id);

    const res = await api<Record<string, unknown>>('POST', '/voids', {
      scenario: NOPERMS,
      idempotencyKey: idempotencyKey('void-noperms-sideeffect'),
      body: { transactionId: targetId, reason: 'customer changed her mind' },
    });
    expect(res.status).toBe(403);

    // Not a refund figure, not an `ok`, not a hint that the void was queued.
    expect(res.body).not.toHaveProperty('refundedFils');
    expect(res.body).not.toHaveProperty('ok');
    expect(res.body).not.toHaveProperty('visitRemoved');

    const after = await api<{ items: Array<Record<string, unknown>> }>(
      'GET',
      '/members/me/transactions',
    );
    // No reversal row appeared and the target charge is untouched. Against the
    // mock this list is static, so today this mostly guards the shape; against
    // lane A's API it is the assertion that a 403 wrote nothing.
    expect(after.body.items).toEqual(before.body.items);
    const stillThere = after.body.items.find((t) => t.id === targetId);
    expect(stillThere, `${targetId} left the feed after a refused void`).toBeDefined();
    expect(stillThere?.status).toBe('settled');
    expect(stillThere?.amountFils).toBe(target!.amountFils);
    expect(after.body.items.some((t) => String(t.kind).includes('void'))).toBe(false);
  });

  /**
   * THE CONTROL — without it the 403 above could be an endpoint that is simply
   * broken shut.
   *
   * It used to void the seeded `TX-9021`, and that is a ONE-SHOT fixture: the
   * first run voids it, and every run afterwards gets `409 already_voided`. That
   * went unnoticed for as long as nobody ran the suite twice against one seeded
   * database, and it surfaced the moment the database was actually re-seeded and
   * re-run. A suite that only passes on its first execution is a suite with a
   * shelf life, the same way an accumulating fixture is.
   *
   * So it makes its own target: a charge settled seconds ago, by this spec, which
   * is inside the fifteen-minute void window by construction and has never been
   * voided. `packages/mock` ignores the transaction id on `POST /voids` entirely,
   * so the same code drives both servers.
   */
  it('the same endpoint succeeds for a principal that holds the permission', async () => {
    await ensureBalanceAtLeast(SERVICE.blowDry.priceFils * 2, 'void-control');

    const charged = await api<{ transaction: { id: string } }>('POST', '/charges', {
      idempotencyKey: idempotencyKey('void-target'),
      body: { memberId: MEMBER_ID, serviceIds: [SERVICE.blowDry.id] },
    });
    expect(charged.status, `could not create a charge to void: ${JSON.stringify(charged.body)}`).toBe(200);

    const res = await api<{ ok: boolean }>('POST', '/voids', {
      idempotencyKey: idempotencyKey('void-permitted'),
      body: { transactionId: charged.body.transaction.id, reason: 'customer changed her mind' },
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('a permitted void still refuses without a reason', async () => {
    // Authority is not the only gate on a reversal. Every void carries a reason
    // into the audit log — api-contract.md § Operations.
    const res = await api<{ error: string }>('POST', '/voids', {
      idempotencyKey: idempotencyKey('void-noreason'),
      body: { transactionId: 'TX-9021' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('reason_required');
  });
});

// ------------------------------------------------------------- the gap ledger --

/**
 * Two of nine permissions are enforced by an endpoint today. This block is the
 * evidence for that claim, and it is executable so the claim cannot go stale.
 */
interface Probe {
  perm: PermissionName;
  what: string;
  run: () => Promise<number>;
}

const PROBES: Probe[] = [
  {
    perm: 'dashboard',
    what: 'GET /salons/{id}/metrics',
    run: async () => (await api('GET', `/salons/${SALON_ID}/metrics`, { scenario: NOPERMS })).status,
  },
  {
    perm: 'appointments',
    what: 'GET /salons/{id}/bookings (route does not exist in the mock)',
    run: async () => (await api('GET', `/salons/${SALON_ID}/bookings`, { scenario: NOPERMS })).status,
  },
  {
    perm: 'shop',
    what: 'GET /salons/{id}/products',
    run: async () =>
      (await api('GET', `/salons/${SALON_ID}/products`, { scenario: NOPERMS })).status,
  },
  {
    perm: 'loyalty',
    what: 'PATCH /salons/{id} — the loyalty editor writes through here',
    run: async () =>
      (
        await api('PATCH', `/salons/${SALON_ID}`, {
          scenario: NOPERMS,
          body: { stampTarget: 9 },
        })
      ).status,
  },
  {
    perm: 'team',
    what: 'GET /staff',
    run: async () => (await api('GET', '/staff', { scenario: NOPERMS })).status,
  },
  {
    perm: 'scanner',
    what: 'POST /scans — 410 means the token was resolved before authority was checked',
    run: async () =>
      (await api('POST', '/scans', { scenario: NOPERMS, body: { token: 'tok_definitely_not_real' } }))
        .status,
  },
  {
    perm: 'charges',
    what: 'GET /charges',
    run: async () => (await api('GET', '/charges?date=today', { scenario: NOPERMS })).status,
  },
  {
    perm: 'void',
    what: 'POST /voids',
    run: async () =>
      (
        await api('POST', '/voids', {
          scenario: NOPERMS,
          idempotencyKey: idempotencyKey('ledger-void'),
          body: { transactionId: 'TX-9021', reason: 'ledger probe' },
        })
      ).status,
  },
  {
    perm: 'marketing',
    what: 'POST /v1/salons/{id}/campaigns',
    run: async () =>
      (
        await api('POST', `/v1/salons/${SALON_ID}/campaigns`, {
          scenario: NOPERMS,
          body: { title: 'ledger probe', body: 'ledger probe', channel: 'both' },
        })
      ).status,
  },
];

/**
 * WHAT THIS LEDGER MEASURES, AND THE BUG IT HAD
 * ---------------------------------------------
 * A probe can only detect a missing gate for a permission the probing principal
 * DOES NOT HOLD. Point it at a principal who holds `appointments` and the
 * bookings probe answers 200 whether the route is gated or not — and the ledger
 * calls that a hole.
 *
 * It used to assert a hardcoded `['charges', 'void']`, which was true of the one
 * principal it had: `packages/mock`'s restricted staff member, who holds almost
 * nothing. Against lane A's real seed the same header selects ST-002 (Hessa), a
 * frontdesk row that legitimately holds `appointments` and `scanner`. So the
 * ledger reported two holes that are not holes — and, much worse, it would have
 * gone on reporting exactly those two if lane A had genuinely DELETED the
 * bookings or scans gate. A ledger that cannot tell "ungated" from "the probe
 * was authorised" is not evidence of anything.
 *
 * So the expectation is derived, not written down: read who the probe principal
 * actually is, and require a 403 for every permission she lacks. Permissions she
 * holds are reported as unprobed rather than counted either way. That statement
 * means the same thing against the mock and against lane A's API, and it tightens
 * by itself as the fixture gets more restricted.
 */
interface RestrictedPrincipal {
  id: string;
  perms: Record<string, boolean>;
}

async function restrictedPrincipal(): Promise<RestrictedPrincipal> {
  const res = await api<RestrictedPrincipal>('GET', '/staff/me', { scenario: NOPERMS });
  if (res.status !== 200 || !res.body?.perms) {
    throw new Error(
      `The ledger cannot read its own probe principal: GET /staff/me (scenario=${NOPERMS}) ` +
        `answered ${res.status} ${JSON.stringify(res.body)}.\n` +
        'Without it the ledger cannot tell an ungated endpoint from an authorised one.',
    );
  }
  return res.body;
}

describe('permission gap ledger', () => {
  it('covers all nine permissions', () => {
    expect(PROBES.map((p) => p.perm).sort()).toEqual([...NINE_PERMISSIONS].sort());
  });

  it('the probe principal is restricted enough to be worth probing', async () => {
    const who = await restrictedPrincipal();
    const lacks = NINE_PERMISSIONS.filter((p) => !who.perms[p]);
    // Not nine — the fixture is a real frontdesk row, not a null principal. But a
    // fixture that held everything would turn this whole block into a no-op, and
    // that has to be loud rather than green.
    expect(
      lacks.length,
      `${who.id} holds every permission, so no probe below can detect a missing gate. ` +
        'The ledger needs a restricted fixture.',
    ).toBeGreaterThan(0);
  });

  /**
   * When lane A removes a gate this FAILS and names the permission and the
   * endpoint. When lane A ADDS a gate for a permission the fixture lacks it keeps
   * passing, which is correct — a new gate is not a regression.
   *
   * REGISTERED BY TARGET. Non-negotiable #7 is a property of the API that owns
   * the data; `packages/mock` has no authority layer at all beyond the two gates
   * it happens to implement, so asserting the rule against it is asserting that a
   * stub is a product. Against the mock the same probe runs and the same holes are
   * listed, as a `knownBug()` that names the mock as the owner — so the gap stays
   * visible and stops being a permanent red on `pnpm check`.
   */
  const everyLackedPermissionIsRefused = async () => {
    const who = await restrictedPrincipal();
    const results = await Promise.all(
      PROBES.map(async (p) => ({ ...p, status: await p.run(), held: who.perms[p.perm] === true })),
    );

    const holes = results
      .filter((r) => !r.held && r.status !== 403)
      .map((r) => `  perms.${r.perm}: ${r.what} → HTTP ${r.status} (expected 403)`);
    const unprobed = results
      .filter((r) => r.held)
      .map((r) => `  perms.${r.perm}: ${r.what} → HTTP ${r.status}`);

    expect(
      holes,
      'Permissions with NO server-side gate (each is a hole under non-negotiable #7):\n' +
        `${holes.join('\n')}\n` +
        `NOT PROBED — ${who.id} legitimately holds these, so their gate is untested here:\n` +
        `${unprobed.join('\n') || '  (none)'}`,
    ).toEqual([]);
  };

  if (TARGET === 'api') {
    it('every permission the probe principal LACKS is refused server-side', everyLackedPermissionIsRefused);
  } else {
    knownBug(
      'packages/mock enforces only charges and void — the other gates exist in api/src/routes, not here',
      everyLackedPermissionIsRefused,
    );
  }

  /**
   * The half the derived ledger cannot reach. `appointments` and `scanner` are
   * held by lane A's restricted fixture, so nothing above proves their gates
   * exist — and both ARE real gates in `api/src/routes`. Stated as a todo so the
   * coverage hole is a fact in the report rather than an invisible exemption.
   */
  it.todo(
    "perms.appointments and perms.scanner are UNPROBED against lane A's seed — ST-002 holds both. Needs a seeded staff row with all nine permissions off, or a PATCH /staff/{id} this suite may use to strip them",
  );
});

/**
 * GAP — what is still not covered.
 *
 * The seven "no endpoint enforces this" todos that used to live here are GONE,
 * and that is the delta worth recording: every one of the nine permissions now
 * has a gate in `api/src/routes` (`requireDashboardPerm` / `requireScannerPerm`),
 * and the ledger above proves the seven that lane A's restricted fixture lacks.
 * What is left is coverage this suite cannot reach, not endpoints that do not
 * exist.
 */
describe('GAP: permission coverage this suite cannot reach', () => {
  it.todo(
    'PATCH /staff/{id} with void:true and charges:false must be refused — api-contract.md: "void is meaningless without charges". The endpoint exists and is gated on perms.team; the combination check is untested here because this suite has no principal holding team',
  );
  it.todo(
    'owner console section permissions (analytics, activity, reports, salons, accounts, admins, approvals, billing, audit, controls — api-contract.md:400) have no endpoints and no gates yet',
  );
  it.todo(
    'every 403 writes an audit_log row naming principal, endpoint and permission — needs GET /salons/{id}/audit from lane A',
  );
});
