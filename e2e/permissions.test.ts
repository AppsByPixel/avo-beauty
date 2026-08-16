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

import { describe, expect, it } from 'vitest';
import { SALON_ID, api, idempotencyKey } from './support/api.js';

const NOPERMS = 'noperms';

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
    expect(serialised).not.toMatch(/pinHash|password|passwordHash/i);
    // `pinSet` is a boolean flag and is fine — it is the hash that must never travel.
    expect((res.body as { pinSet: boolean }).pinSet).toBe(true);
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

    const res = await api<Record<string, unknown>>('POST', '/voids', {
      scenario: NOPERMS,
      idempotencyKey: idempotencyKey('void-noperms-sideeffect'),
      body: { transactionId: 'TX-9021', reason: 'customer changed her mind' },
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
    const target = after.body.items.find((t) => t.id === 'TX-9021');
    expect(target).toBeDefined();
    expect(target?.amountFils).toBe(-8000);
    expect(target?.status).toBe('settled');
    expect(after.body.items.some((t) => String(t.kind).includes('void'))).toBe(false);
  });

  it('the same endpoint succeeds for a principal that holds the permission', async () => {
    const res = await api<{ ok: boolean }>('POST', '/voids', {
      idempotencyKey: idempotencyKey('void-permitted'),
      body: { transactionId: 'TX-9021', reason: 'customer changed her mind' },
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

describe('permission gap ledger', () => {
  it('covers all nine permissions', () => {
    expect(PROBES.map((p) => p.perm).sort()).toEqual([...NINE_PERMISSIONS].sort());
  });

  /**
   * When lane A gates another permission, this spec FAILS. That is the intended
   * signal: delete the corresponding `it.todo` below, write the real 403 spec
   * next to the `charges` and `void` ones, and add the permission here.
   */
  it('exactly `charges` and `void` are enforced server-side right now', async () => {
    const results = await Promise.all(
      PROBES.map(async (p) => ({ ...p, status: await p.run() })),
    );
    const gated = results.filter((r) => r.status === 403).map((r) => r.perm);
    const ungated = results
      .filter((r) => r.status !== 403)
      .map((r) => `  perms.${r.perm}: ${r.what} → HTTP ${r.status}`);

    expect(
      gated.sort(),
      `Permissions with NO server-side gate (each is a hole under non-negotiable #7):\n${ungated.join('\n')}`,
    ).toEqual(['charges', 'void']);
  });
});

/**
 * GAP — no endpoint enforces these seven. Each todo names the endpoint that must
 * carry the check, so the work is a promotion of a todo, not a rediscovery.
 */
describe('GAP: permissions with no endpoint gating them yet', () => {
  it.todo(
    'perms.dashboard — GET /salons/{id}/metrics must 403 for a principal with dashboard:false (currently 200)',
  );
  it.todo(
    'perms.appointments — GET /salons/{id}/bookings and PATCH /bookings/{id} do not exist yet; both must be gated when lane A adds them',
  );
  it.todo(
    'perms.shop — GET /salons/{id}/products and the order endpoints must 403 for shop:false (products currently 200, orders unimplemented)',
  );
  it.todo(
    'perms.loyalty — PATCH /salons/{id} must 403 for loyalty:false; the atomic tier-ladder publish is a money path (currently 200)',
  );
  it.todo(
    'perms.team — GET /staff and PATCH /staff/{id} must 403 for team:false; PATCH /staff/{id} is how perms themselves are set, so it is the privilege-escalation route (GET currently 200, PATCH unimplemented)',
  );
  it.todo(
    'perms.scanner — POST /scans and POST /charges must 403 for scanner:false BEFORE the token is resolved; today POST /scans reaches token lookup (410) and POST /charges debits a wallet with no authority check at all',
  );
  it.todo(
    'perms.marketing — POST /v1/salons/{id}/campaigns must 403 for marketing:false (currently 200 and creates a pending campaign)',
  );

  it.todo(
    'void:true with charges:false must be rejected at PATCH /staff/{id} — api-contract.md: "void is meaningless without charges". Needs the endpoint first.',
  );
  it.todo(
    'owner console section permissions (analytics, activity, reports, salons, accounts, admins, approvals, billing, audit, controls — api-contract.md:400) have no endpoints and no gates yet',
  );
  it.todo(
    'every 403 writes an audit_log row naming principal, endpoint and permission — needs GET /salons/{id}/audit from lane A',
  );
});
