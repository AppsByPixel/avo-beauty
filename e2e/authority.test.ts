/**
 * NON-NEGOTIABLE #7, AGAINST THE API THAT OWNS THE DATA.
 *
 * HOW TO RUN
 *
 *   pnpm install
 *   pnpm --dir ./api run db:up
 *   cd e2e && ../node_modules/.bin/vitest run authority.test.ts
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS NOT `permissions.test.ts`
 * ------------------------------------------------------------
 * CLAUDE.md #7 says it in terms: *"Permissions are enforced server-side. The UI
 * hiding a button is a courtesy, not a control. Every gated endpoint needs a test
 * that calls it directly with the permission off."*
 *
 * `permissions.test.ts` is named for that rule and runs against `packages/mock` —
 * an in-memory `Map` with no authority layer beyond two hardcoded gates, which its
 * own `knownBug` says out loud: *"packages/mock enforces only charges and void."*
 * So the rule was asserted against a stub. That is not a criticism of that file,
 * which was written before the API existed and was built target-aware on purpose;
 * it is that nothing ever pointed it at the API. Its `charges` and `void` probes
 * are separately and properly covered against the real API in `scanner.test.ts`.
 *
 * This file is the rule itself, driven against Postgres and the real gates.
 *
 * WHAT MAKES A PERMISSION SPEC MEAN SOMETHING
 * -------------------------------------------
 * ASSERT THAT THE SYSTEM REFUSED, NEVER THAT NOTHING CHANGED. A spec asserting
 * "the row did not move" passes when the endpoint is missing, when the id is wrong,
 * when the fixture was empty, and when the request never arrived — four ways to be
 * green while proving nothing. This suite has produced that mistake four times, most
 * expensively as a ledger probe whose `WHERE` matched no rows and which therefore
 * reported that the database allows what it forbids. So every probe here asserts a
 * 403 AND the design's own copy for that permission, and the ledger additionally
 * takes a CONTROL reading with the permission granted — because a 403 from a broken
 * route looks identical to a 403 from a working gate.
 *
 * TWO PRINCIPALS, ONE PER SURFACE, and the reason is the order of the two checks.
 * `requirePerm` tests the SURFACE first and the permission second: a dashboard
 * endpoint refuses a PIN session because it is the wrong KIND of credential, before
 * it ever looks at authority. A single principal would make every scanner probe on a
 * dashboard route pass for the wrong reason, so the web probe drives the dashboard
 * routes and the PIN probe drives the scanner ones.
 *
 * BOTH HOLD NOTHING. Every other staff fixture in this suite holds something
 * deliberately, so a ledger built on one can only probe what it happens to lack —
 * which is exactly the limitation the mock ledger recorded as a todo for
 * `appointments` and `scanner`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { precondition } from './support/known-bug.js';
import {
  B_AUTH_PIN_DEVICE,
  B_BRANCH,
  B_HAPPY_HOUR,
  B_MEMBER,
  B_STAFF_AUTH_PIN,
  B_STAFF_AUTH_PIN_HANDLE,
  B_STAFF_AUTH_WEB,
  B_STAFF_AUTH_WEB_HANDLE,
  SALON_B,
  psql,
  resetPinState,
  scalar,
  signInDashboard,
  signInScanner,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

/** The nine of api-contract.md § StaffUser, in the order `perms` serialises them. */
const NINE = [
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
type Permission = (typeof NINE)[number];

/** The column behind each, so a probe can grant exactly one and no more. */
const COLUMN: Record<Permission, string> = {
  dashboard: 'perm_dashboard',
  appointments: 'perm_appointments',
  shop: 'perm_shop',
  loyalty: 'perm_loyalty',
  team: 'perm_team',
  scanner: 'perm_scanner',
  charges: 'perm_charges',
  void: 'perm_void',
  marketing: 'perm_marketing',
};

/**
 * The copy each refusal must carry — `api/src/auth/principal.ts` § PERMISSION_COPY,
 * taken from design/AVO Staff Scanner.dc.html's locked state.
 *
 * Asserted rather than ignored because a 403 with the wrong sentence is a real
 * defect on this product: the scanner renders it verbatim to a staff member standing
 * in front of a customer, and "forbidden" tells her nothing about who can fix it.
 */
const COPY: Record<Permission, string> = {
  dashboard: "You don't have permission to see the dashboard. A manager can grant it.",
  appointments: "You don't have permission to see appointments. A manager can grant it.",
  shop: "You don't have permission to see the shop. A manager can grant it.",
  loyalty: "You don't have permission to change loyalty settings. A manager can grant it.",
  team: "You don't have permission to manage the team. A manager can grant it.",
  scanner: "You don't have permission to scan and charge. A manager can grant it.",
  charges: "You don't have permission to see today's charges. A manager can grant it.",
  void: "You don't have permission to void a charge. A manager can grant it.",
  marketing: "You don't have permission to submit a campaign. A manager can grant it.",
};

interface Probe {
  perm: Permission;
  /** Which credential this endpoint accepts. Checked before authority. */
  surface: 'dashboard' | 'scanner';
  what: string;
  run: (token: string) => Promise<{ status: number; body: any; raw: string }>;
  /**
   * A control reading is only taken where granting the permission does not write.
   * `marketing`, `void` and `scanner` are writes; granting them to take a 200 would
   * publish a boost, reverse a charge, or consume a token — so their gate is proved
   * by the refusal and by the grant changing the ANSWER, not by a 200 body.
   */
  controlIsRead: boolean;
}

/**
 * ONE REPRESENTATIVE ENDPOINT PER PERMISSION, read off `api/src/routes` — every
 * `requireDashboardPerm` / `requireScannerPerm` call site was enumerated to build
 * this, and all nine are gated somewhere. Read-only endpoints are preferred so the
 * control reading costs nothing.
 */
function probes(): Probe[] {
  return [
    {
      perm: 'dashboard',
      surface: 'dashboard',
      what: `GET /salons/${SALON_B}/metrics`,
      run: (t) => treq('GET', `/salons/${SALON_B}/metrics`, { token: t }),
      controlIsRead: true,
    },
    {
      perm: 'appointments',
      surface: 'dashboard',
      what: `GET /salons/${SALON_B}/bookings`,
      run: (t) => treq('GET', `/salons/${SALON_B}/bookings`, { token: t }),
      controlIsRead: true,
    },
    {
      perm: 'shop',
      surface: 'dashboard',
      what: `GET /salons/${SALON_B}/products`,
      run: (t) => treq('GET', `/salons/${SALON_B}/products`, { token: t }),
      controlIsRead: true,
    },
    {
      perm: 'loyalty',
      surface: 'dashboard',
      what: `GET /salons/${SALON_B}/loyalty`,
      run: (t) => treq('GET', `/salons/${SALON_B}/loyalty`, { token: t }),
      controlIsRead: true,
    },
    {
      perm: 'team',
      surface: 'dashboard',
      what: 'GET /staff',
      run: (t) => treq('GET', '/staff', { token: t }),
      controlIsRead: true,
    },
    {
      perm: 'charges',
      surface: 'scanner',
      what: 'GET /charges',
      run: (t) => treq('GET', '/charges', { token: t }),
      controlIsRead: true,
    },
    {
      /**
       * `POST /scans` with a token that was never minted. With the permission OFF
       * this must answer 403; with it ON it answers 410 for the unknown token. That
       * pair is the assertion — and the 410 is the interesting half, because it
       * proves authority is checked BEFORE the token is resolved. An endpoint that
       * looked the token up first has already told an unauthorised caller whether
       * somebody else's QR exists.
       */
      perm: 'scanner',
      surface: 'scanner',
      what: 'POST /scans (unminted token)',
      run: (t) => treq('POST', '/scans', { token: t, body: { token: 'tok_never_minted' } }),
      controlIsRead: false,
    },
    {
      /**
       * `POST /voids` against a transaction id that does not exist: 403 without the
       * permission, and a not-found rather than a reversal with it. Same argument as
       * `POST /scans` — the gate must run before the lookup.
       */
      perm: 'void',
      surface: 'scanner',
      what: 'POST /voids (unknown transaction)',
      run: (t) =>
        treq('POST', '/voids', {
          token: t,
          idempotencyKey: `authority-void-${Date.now()}`,
          body: { transactionId: 'TX-DOES-NOT-EXIST', reason: 'authority probe' },
        }),
      controlIsRead: false,
    },
    {
      /**
       * `PATCH` a happy hour that exists at salon B. Refused without `marketing`;
       * with it, the write would really happen, so no control 200 is taken — see
       * `controlIsRead`.
       */
      perm: 'marketing',
      surface: 'dashboard',
      what: `PATCH /v1/salons/${SALON_B}/promotions/happy-hours/${B_HAPPY_HOUR}`,
      run: (t) =>
        treq('PATCH', `/v1/salons/${SALON_B}/promotions/happy-hours/${B_HAPPY_HOUR}`, {
          token: t,
          body: { on: false },
        }),
      controlIsRead: false,
    },
  ];
}

let web = '';
let pin = '';

/** Every permission off, on both probes. The state the seed leaves them in. */
function revokeAll(): void {
  const off = Object.values(COLUMN)
    .map((c) => `${c} = false`)
    .join(', ');
  psql(
    `UPDATE staff_user SET ${off} WHERE id IN ('${B_STAFF_AUTH_WEB}', '${B_STAFF_AUTH_PIN}');`,
  );
}

/**
 * Grant exactly one permission, to one probe.
 *
 * `void` also needs `charges`: api-contract.md says "void is meaningless without
 * charges", the database CHECK refuses that combination, and `permsOf` filters
 * `void` through `charges` a second time so an already-stored row cannot produce an
 * effective void without it. So granting `void` alone is not a thing that can exist,
 * and the control for `void` is "charges AND void".
 */
function grant(staffId: string, perm: Permission): void {
  const cols = perm === 'void' ? [COLUMN.charges, COLUMN.void] : [COLUMN[perm]];
  psql(
    `UPDATE staff_user SET ${cols.map((c) => `${c} = true`).join(', ')} WHERE id = '${staffId}';`,
  );
}

const permsOfRow = (staffId: string): string =>
  scalar(
    `select ${Object.values(COLUMN).map((c) => `${c}::text`).join(" || ',' || ")}
       from staff_user where id='${staffId}'`,
  );

beforeAll(async () => {
  await startTenancyApi();
  revokeAll();
  resetPinState(B_STAFF_AUTH_PIN, B_AUTH_PIN_DEVICE);
  web = await signInDashboard(SALON_B, B_STAFF_AUTH_WEB_HANDLE);
  pin = await signInScanner(SALON_B, B_STAFF_AUTH_PIN_HANDLE, B_AUTH_PIN_DEVICE);
}, 180_000);

afterAll(async () => {
  revokeAll();
  await stopTenancyApi();
});

// ===========================================================================

describe('the probes are worth running at all', () => {
  it('covers all nine permissions, each with a real gated endpoint', () => {
    expect(probes().map((p) => p.perm).sort()).toEqual([...NINE].sort());
  });

  it('and both principals genuinely hold NOTHING — otherwise every probe below is vacuous', () => {
    /**
     * The assertion that stops this file becoming decoration. A probe principal
     * that held a permission would answer 200 where this file expects 403, and the
     * honest reading of that is not "the gate is missing" — it is "the fixture is
     * wrong". Checked against the database rather than against `GET /staff/me`,
     * because reading it through the API needs `team`, which is one of the nine.
     */
    for (const id of [B_STAFF_AUTH_WEB, B_STAFF_AUTH_PIN]) {
      expect(
        permsOfRow(id),
        `${id} holds a permission, so the ledger cannot tell a missing gate from a granted one`,
      ).toBe('false,false,false,false,false,false,false,false,false');
    }
  });

  it('a session survives a permission change, because perms are read per request', async () => {
    /**
     * The property the whole file depends on: `auth/principal.ts` reads permissions
     * from `staff_user` on EVERY request and never from a claim inside the token,
     * "so that a manager who revokes `charges` at 14:00 expects it gone at 14:00,
     * not whenever a fifteen-minute token happens to expire".
     *
     * If perms were baked into the token, granting one mid-file would change nothing
     * and every control reading below would report a 403 — a whole ledger of false
     * holes. So it is proved once, here, before anything relies on it.
     */
    const before = await treq('GET', `/salons/${SALON_B}/metrics`, { token: web });
    precondition(before.status === 403, `the probe already had dashboard: ${before.raw}`);

    try {
      grant(B_STAFF_AUTH_WEB, 'dashboard');
      const after = await treq('GET', `/salons/${SALON_B}/metrics`, { token: web });
      expect(
        after.status,
        'granting a permission did not take effect on the SAME session, so permissions are ' +
          'coming from the token rather than from staff_user — and a revocation would not take ' +
          'effect either',
      ).toBe(200);
    } finally {
      revokeAll();
    }
  });
});

// ===========================================================================
// The ledger
// ===========================================================================

describe('every gated endpoint, called directly with the permission OFF (non-negotiable #7)', () => {
  for (const probe of probes()) {
    it(`perms.${probe.perm} — ${probe.what} is refused`, async () => {
      const token = probe.surface === 'dashboard' ? web : pin;
      precondition(
        permsOfRow(probe.surface === 'dashboard' ? B_STAFF_AUTH_WEB : B_STAFF_AUTH_PIN) ===
          'false,false,false,false,false,false,false,false,false',
        'the probe principal is not fully revoked',
      );

      const res = await probe.run(token);

      /**
       * THE SYSTEM REFUSED — asserted as the status AND the sentence, never as
       * "nothing changed". A missing route also changes nothing.
       */
      expect(
        res.status,
        `perms.${probe.perm} is NOT enforced server-side: ${probe.what} answered ${res.status} ` +
          `to a principal holding no permissions at all. Non-negotiable #7: the UI hiding a ` +
          `button is a courtesy, not a control.\n${res.raw}`,
      ).toBe(403);
      expect(res.body.error).toBe('forbidden');
      expect(
        res.body.message,
        `the 403 does not carry the design's copy for perms.${probe.perm}, so the scanner shows a ` +
          'staff member a refusal that does not say who can grant it',
      ).toBe(COPY[probe.perm]);

      // And the refusal is the whole response: no data behind it.
      expect(res.body).not.toHaveProperty('items');
      expect(res.body).not.toHaveProperty('transaction');
    });
  }
});

// ===========================================================================
// The control — a 403 from a broken route looks exactly like a working gate
// ===========================================================================

describe('and the same call is ALLOWED once the permission is granted', () => {
  for (const probe of probes().filter((p) => p.controlIsRead)) {
    it(`perms.${probe.perm} — ${probe.what} answers 200 with it`, async () => {
      const staffId = probe.surface === 'dashboard' ? B_STAFF_AUTH_WEB : B_STAFF_AUTH_PIN;
      const token = probe.surface === 'dashboard' ? web : pin;
      try {
        grant(staffId, probe.perm);
        const res = await probe.run(token);
        expect(
          res.status,
          `${probe.what} still refuses a principal that now HOLDS perms.${probe.perm}, so the ` +
            'refusal in the ledger above proves nothing about the gate — it could be a broken ' +
            `route, a wrong surface, or a missing fixture.\n${res.raw}`,
        ).toBe(200);
      } finally {
        revokeAll();
      }
    });
  }

  /**
   * The three writes, proved by the ANSWER CHANGING rather than by a 200.
   *
   * Granting `scanner`, `void` or `marketing` and then calling the endpoint would
   * consume a token, reverse a charge, or edit a live promotion. So each is called
   * with an argument that cannot succeed — an unminted token, a transaction id that
   * does not exist — and the assertion is that the refusal STOPS BEING A 403 and
   * becomes the endpoint's own answer.
   *
   * That is a stronger statement than a 200 would be, because it also proves the
   * gate runs BEFORE the lookup: a 410 or a 404 arriving only after the permission
   * is granted means the unauthorised caller was never told whether the token or the
   * transaction existed.
   */
  for (const probe of probes().filter((p) => !p.controlIsRead && p.perm !== 'marketing')) {
    it(`perms.${probe.perm} — with it granted, ${probe.what} gets past the gate to its own answer`, async () => {
      const staffId = probe.surface === 'dashboard' ? B_STAFF_AUTH_WEB : B_STAFF_AUTH_PIN;
      const token = probe.surface === 'dashboard' ? web : pin;
      try {
        grant(staffId, probe.perm);
        const res = await probe.run(token);
        expect(
          res.status,
          `${probe.what} still answers 403 with perms.${probe.perm} granted: ${res.raw}`,
        ).not.toBe(403);
        expect(
          [404, 409, 410].includes(res.status),
          `expected the endpoint's own not-found/gone answer once past the gate, got ` +
            `${res.status}: ${res.raw}`,
        ).toBe(true);
      } finally {
        revokeAll();
      }
    });
  }
});

// ===========================================================================
// The surface check, which runs BEFORE authority
// ===========================================================================

describe('the surface is checked before the permission, and refuses the wrong KIND of credential', () => {
  /**
   * A manager holding every permission still cannot reach the dashboard from the
   * salon floor, and cannot charge from a back-office laptop. `api/src/auth/
   * principal.ts` § SURFACE_COPY explains why the second direction matters most: a
   * four-digit PIN is only safe because of what surrounds it — hashed,
   * device-scoped, rate-limited, locked after five failures, scanner scope only —
   * and a web session has none of that. If a web session can charge, every one of
   * those PIN controls is optional.
   *
   * Proved with FULL permissions granted, so the refusal cannot be an authority
   * refusal wearing a surface refusal's clothes.
   */
  it('a PIN session with every permission still cannot reach a dashboard endpoint', async () => {
    try {
      for (const perm of NINE) grant(B_STAFF_AUTH_PIN, perm);
      const res = await treq<any>('GET', '/staff', { token: pin });

      expect(res.status, `a scanner PIN read the team list: ${res.raw}`).toBe(403);
      expect(res.body.message).toBe(
        'A scanner PIN cannot reach the dashboard. Sign in on the web with a username and password.',
      );
      expect(res.body).not.toHaveProperty('items');
    } finally {
      revokeAll();
    }
  });

  it('and a web session with every permission still cannot charge a wallet', async () => {
    try {
      for (const perm of NINE) grant(B_STAFF_AUTH_WEB, perm);
      const res = await treq<any>('POST', '/charges', {
        token: web,
        idempotencyKey: `authority-web-charge-${Date.now()}`,
        body: { memberId: B_MEMBER, serviceIds: [], token: 'tok_never_minted' },
      });

      expect(
        res.status,
        `A WEB SESSION CHARGED A WALLET. This is the bug that made the surface a required ` +
          `parameter rather than a defaulted one, and it has shipped once already.\n${res.raw}`,
      ).toBe(403);
      expect(res.body.message).toBe(
        'Charging happens on the staff scanner, not the dashboard. Open AVO on the salon phone ' +
          'and sign in with your PIN.',
      );
    } finally {
      revokeAll();
    }
  });

  it('and the branch-scoped read still answers, so the fixture is not simply broken', async () => {
    // The control for the two refusals above: with `team` granted on the WEB
    // session, the same team list is served. Without this, a 403 from a route that
    // does not work at all would read as a surface check doing its job.
    try {
      grant(B_STAFF_AUTH_WEB, 'team');
      const res = await treq<any>('GET', '/staff', { token: web });
      expect(res.status, `the web session cannot read the team list either: ${res.raw}`).toBe(200);
      expect(Array.isArray(res.body.items), 'GET /staff returned no items array').toBe(true);
      // And it is salon B's team, not everyone's.
      expect(
        res.body.items.every((s: any) => s.salonId === SALON_B),
        `a foreign salon's staff came back: ${res.raw}`,
      ).toBe(true);
      expect(res.body.items.map((s: any) => s.id)).toContain(B_STAFF_AUTH_WEB);
    } finally {
      revokeAll();
    }
  });

  it('and a branch fixture exists for the salon these probes read', () => {
    // Guards the two salon-scoped probes above from passing on an empty salon.
    expect(
      Number(scalar(`select count(*) from branch where salon_id='${SALON_B}'`)),
      'salon B has no branches, so its metrics and bookings reads prove little',
    ).toBeGreaterThan(0);
    expect(B_BRANCH).toBeTruthy();
  });
});
