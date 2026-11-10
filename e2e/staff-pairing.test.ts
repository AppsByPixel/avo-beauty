/**
 * STAFF PHONE PAIRING, PHONE SIGN-IN, AND StaffUser.phone — adversarially, from the
 * contract and nothing else.
 *
 * HOW TO RUN
 *
 *   cd e2e && AVO_QA_DB=avo_lane_d ../node_modules/.bin/vitest run staff-pairing.test.ts
 *
 * THE SPEC, AND WHAT THIS FILE WAS WRITTEN FROM
 * --------------------------------------------
 * DECISIONS.md § "Staff phone pairing, phone sign-in, and a truthful receipt line — Aftab,
 * 2026-11-10", and the trunk contract in `packages/types/src/entities.ts` § staff pairing
 * (`81312b8`): `StaffPairingCodeSchema`, `StaffPairRequestSchema`, `StaffPairResponseSchema`,
 * `STAFF_PAIRING_URL`, `STAFF_PAIRING_TTL_MINUTES`, and `StaffUserSchema.phone`. Plus the
 * fixed names trunk handed every lane: the two routes, the refusal bodies, `phone_taken`,
 * `staff_deactivated`, and the phone form of the two sign-in doors.
 *
 * WRITTEN BLIND TO LANE A, ON PURPOSE. Lane A built the endpoints in parallel and this file
 * was finished before any of that code was readable here. Every expectation below is a
 * sentence from the decision or a field of the contract, so where the two disagree it is a
 * disagreement worth a conversation rather than a test that agrees with whatever shipped.
 * The places where the contract does not decide and this file had to read it are named at
 * the spec, not hidden: the success status (200 OR 201 accepted for both endpoints), a
 * client-sent `deviceId` (refused OR ignored, never obeyed), and the same mobile number at
 * two salons (the spec asserts the digits decide — see its note).
 *
 *   POST /staff/:id/pairing-code      perms.team; with `branchId` also perms.dashboard.
 *   POST /staff/pair                  unauthenticated. `{ token, pin }` or
 *                                     `{ phone, code, pin }`. Single-use, ten minutes, one
 *                                     refusal body for every cause, five wrong digits burn
 *                                     the code, a per-address and per-phone budget in front.
 *   POST /staff, PATCH /staff/:id     take `phone`; an 8-digit number is +965; unique among
 *                                     a salon's ACTIVE staff (409 phone_taken).
 *   POST /staff/session               `{ salonId, deviceId, phone, pin }` as well as handle.
 *   POST /auth/web/session            a mobile number in `username`.
 *
 * ITS OWN TWO SALONS, MINTED PER RUN — `boosts.test.ts`'s pattern, for its reason. Pairing
 * writes PINs, devices, sessions and phones onto staff rows, and every one of those is a
 * fixture some other file depends on at salon A or B. Here they belong to nobody else. The
 * second salon is the "somewhere else": a staff id, a branch and a phone owned by a
 * different tenant. Salon two branches at the first salon, so an un-enrolled till's charge
 * is ASSUMED and an enrolled one's is ESTABLISHED — the contrast that makes "the till is
 * enrolled" observable at the money rather than only in `device_enrolment`.
 *
 * EVERY REQUEST TO /staff/pair NAMES ITS CLIENT ADDRESS. The decision puts a per-IP budget
 * in front of the endpoint "on the existing sign-in-limit pattern" (ten in fifteen minutes),
 * and every request this harness sends is 127.0.0.1 — so the file would spend that budget by
 * its eleventh redeem and every later spec would fail as a 429 about nothing. The API is
 * booted behind a trusted loopback proxy (`bootTrustingLoopbackProxy`) and each redeem
 * carries its own `X-Forwarded-For`; `beforeAll` proves in SQL that the forwarded address is
 * the one the API records before any spec relies on it. Addresses are drawn from a random
 * 10/8 block per run, so a rerun inside the hour does not inherit a spent bucket.
 *
 * Every claim about what was WRITTEN is read back from Postgres. Rows of the new table are
 * found by the staff id appearing in the row (`to_jsonb`), not by a guessed column name:
 * the decision names `staff_pairing_code`, `expires_at` and `used_at`, and nothing else
 * about its shape is this file's business.
 */

import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  STAFF_PAIRING_TTL_MINUTES,
  STAFF_PAIRING_URL,
  StaffPairResponseSchema,
  StaffPairingCodeSchema,
  StaffUserSchema,
} from '../packages/types/dist/index.js';
import { precondition } from './support/known-bug.js';
import { assertRaced, timed, valuesOf, withRowLockHeld } from './support/race.js';
import {
  A_STAFF_FULL,
  B_MEMBER,
  STAFF_PASSWORD,
  bootTrustingLoopbackProxy,
  mintWalletTokenFor,
  psql,
  reconcileWalletLedger,
  resetPinState,
  scalar,
  signInDashboard,
  signInDashboardFresh,
  signInMember,
  signInScanner,
  startTenancyApi,
  stopTenancyApi,
  treq,
  type TenancyResponse,
} from './support/tenancy-harness.js';

// ------------------------------------------------------------------ the run --

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`.toUpperCase();
const run = RUN.toLowerCase();

const SALON = `SAL-QA-PAIR-${RUN}`;
const SALON_2 = `SAL-QA-PAIR2-${RUN}`;
/** Sorts first, so it is the branch an UN-enrolled till's charge is assumed at. */
const BRANCH_1 = `BR-QA-PAIR-${RUN}-1`;
/** The branch a code enrols its phone at. Sorts second, so "established" cannot be luck. */
const BRANCH_2 = `BR-QA-PAIR-${RUN}-2`;
const BRANCH_ELSEWHERE = `BR-QA-PAIR2-${RUN}-1`;
const SERVICE = `SV-QA-PAIR-${RUN}`;
const PRICE_FILS = 5_000;
const OPENING_FILS = 500_000;
const MEMBER = `QA-PAIR-${RUN}-M`;
const MEMBER_PHONE = `+9659${String(1_000_000 + Math.floor(Math.random() * 8_999_999)).slice(0, 7)}`;

const MGR = `ST-QA-PR-${RUN}-MGR`;
const MGR_HANDLE = `pr-${run}-mgr`;
/** perms.dashboard and NOT perms.team. */
const NOTEAM = `ST-QA-PR-${RUN}-NOTEAM`;
const NOTEAM_HANDLE = `pr-${run}-noteam`;
/** perms.team and NOT perms.dashboard. */
const NODASH = `ST-QA-PR-${RUN}-NODASH`;
const NODASH_HANDLE = `pr-${run}-nodash`;
const MGR_2 = `ST-QA-PR2-${RUN}-MGR`;
const MGR_2_HANDLE = `pr2-${run}-mgr`;

/** `api/src/db/seed.ts` — the PIN behind ST-001's hash, which the fixtures copy. */
const SEEDED_PIN = '2468';
/** What a staff member chooses on the phone. Not the seeded PIN, so the two can be told apart. */
const PAIR_PIN = '7391';

/** The fixed names. Every refusal of `POST /staff/pair`, whatever the cause. */
const REFUSAL = {
  error: 'pairing_refused',
  message: 'That code did not work. Ask a manager for a new one.',
};
/** `routes/auth.ts § BAD_CREDENTIALS` — the existing wrong-PIN / wrong-password body. */
const BAD_CREDENTIALS = {
  error: 'invalid_credentials',
  message: 'Those details do not match. Try again.',
};
/** `auth/principal.ts § PERMISSION_COPY`, as `permission-census.test.ts` pins it. */
const TEAM_COPY = "You don't have permission to manage the team. A manager can grant it.";
const DASHBOARD_COPY = "You don't have permission to see the dashboard. A manager can grant it.";

const PERMS = [
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
type Perm = (typeof PERMS)[number];

// ------------------------------------------------------------- generators --

/** One block of 10/8 per run: a rerun inside the budget's hour does not share a bucket. */
const IP_B = Math.floor(Math.random() * 256);
const IP_C = Math.floor(Math.random() * 256);
let ipN = 0;
function nextIp(): string {
  const k = ipN++;
  return `10.${IP_B}.${(IP_C + Math.floor(k / 250)) % 256}.${(k % 250) + 1}`;
}

/** Kuwait mobiles, eight digits starting 6, unique within the run. */
const PHONE_BASE = 1_000_000 + Math.floor(Math.random() * 8_000_000);
let phoneN = 0;
function nextPhone(): { local: string; e164: string } {
  const local = `6${String(PHONE_BASE + phoneN++).padStart(7, '0')}`;
  return { local, e164: `+965${local}` };
}

let deviceN = 0;
const nextDevice = (label: string) => `DEV-QA-PR-${RUN}-${label}-${deviceN++}`;

/** Six digits that are not `code`. */
const wrongDigits = (code: string, k = 1): string =>
  String((Number(code) + k) % 1_000_000).padStart(6, '0');

/** A token-shaped string nobody issued. */
const ghostToken = (): string => `qa_${randomBytes(32).toString('base64url')}`;

// --------------------------------------------------------------- fixtures --

interface StaffSeed {
  id: string;
  salon: string;
  handle: string;
  name: string;
  role: 'owner' | 'manager' | 'frontdesk' | 'artist' | 'scanner';
  password: boolean;
  /** Copy ST-001's PIN hash onto this device, or leave the row with no PIN. */
  pinDevice: string | null;
  perms: Partial<Record<Perm, boolean>>;
}

/**
 * One staff row. Credentials are COPIED from salon A's ST-001, for the reason the harness
 * header gives for salon B: a copied hash cannot drift from the seed, and hashing argon2id
 * here would mean importing lane A's password module into a package that does not depend
 * on it. `phone` is NEVER written here — that column is the feature under test, and the
 * only door onto it is the API.
 */
function staffSql(s: StaffSeed): string {
  const p = (k: Perm) => (s.perms[k] ? 'true' : 'false');
  return `
    INSERT INTO staff_user (id, salon_id, name, handle, role, branch_access_all, branch_access_ids,
                            password_hash, pin_hash, pin_device_id,
                            perm_dashboard, perm_appointments, perm_shop, perm_loyalty, perm_team,
                            perm_scanner, perm_charges, perm_void, perm_marketing)
    SELECT '${s.id}', '${s.salon}', '${s.name}', '${s.handle}', '${s.role}', true, '{}',
           ${s.password ? 's.password_hash' : 'NULL'},
           ${s.pinDevice ? 's.pin_hash' : 'NULL'},
           ${s.pinDevice ? `'${s.pinDevice}'` : 'NULL'},
           ${PERMS.map(p).join(', ')}
      FROM staff_user s WHERE s.id = '${A_STAFF_FULL}';`;
}

const ALL_PERMS: Partial<Record<Perm, boolean>> = Object.fromEntries(PERMS.map((p) => [p, true]));

function seed(): void {
  const salonSql = (id: string, name: string) => `
    INSERT INTO salon (id, name, plan, brand_color, module_booking, module_shop, loyalty_mode,
                       tiers, stamp_target, stamp_reward, deposit_fils, no_show_return_minutes,
                       business_hours, social, whatsapp_enabled, timezone)
    VALUES ('${id}', '${name}', 'starter', '#7A5C8E', false, false, 'tiers',
            '[{"name":"bronze","minVisits":0,"bonusPercent":0},{"name":"silver","minVisits":100000,"bonusPercent":5}]'::jsonb,
            NULL, NULL, 5000, 60,
            '{"morning":["10:00","13:00"],"evening":["16:00","21:00"]}'::jsonb, '[]'::jsonb, false,
            'Asia/Kuwait');`;

  psql(`
BEGIN;
${salonSql(SALON, `QA Pairing ${RUN}`)}
${salonSql(SALON_2, `QA Pairing Elsewhere ${RUN}`)}
INSERT INTO branch (id, salon_id, name) VALUES
  ('${BRANCH_1}', '${SALON}', 'QA pairing branch one'),
  ('${BRANCH_2}', '${SALON}', 'QA pairing branch two'),
  ('${BRANCH_ELSEWHERE}', '${SALON_2}', 'QA pairing elsewhere');
INSERT INTO service (id, salon_id, name, price_fils)
  VALUES ('${SERVICE}', '${SALON}', 'QA pairing blow-dry', ${PRICE_FILS});
${staffSql({ id: MGR, salon: SALON, handle: MGR_HANDLE, name: 'QA Pairing Manager', role: 'manager', password: true, pinDevice: null, perms: ALL_PERMS })}
${staffSql({ id: NOTEAM, salon: SALON, handle: NOTEAM_HANDLE, name: 'QA Pairing No Team', role: 'manager', password: true, pinDevice: null, perms: { dashboard: true } })}
${staffSql({ id: NODASH, salon: SALON, handle: NODASH_HANDLE, name: 'QA Pairing No Dashboard', role: 'manager', password: true, pinDevice: null, perms: { team: true } })}
${staffSql({ id: MGR_2, salon: SALON_2, handle: MGR_2_HANDLE, name: 'QA Pairing Manager Two', role: 'manager', password: true, pinDevice: null, perms: ALL_PERMS })}
INSERT INTO member (id, salon_id, name, phone, email, email_verified, password_hash,
                    balance_fils, visits, tier, stamps, policy_version)
SELECT '${MEMBER}', '${SALON}', 'QA Pairing Customer', '${MEMBER_PHONE}', NULL, false,
       s.password_hash, ${OPENING_FILS}, 0, 'bronze', NULL,
       (SELECT policy_version FROM member WHERE id = '${B_MEMBER}')
  FROM staff_user s WHERE s.id = '${A_STAFF_FULL}';
COMMIT;
`);
  // Her opening balance is a real credit with a real ledger pair — boosts.test.ts's reason.
  reconcileWalletLedger(MEMBER, 'QAPR');
}

let targetN = 0;
interface Target {
  id: string;
  handle: string;
}

/**
 * A fresh staff member to pair: an artist with `scanner` and `charges`, so a session from
 * the paired phone can reach a scanner read and take a charge. One per spec, so no spec's
 * outcome is another's precondition.
 */
function newTarget(opts: { salon?: string; password?: boolean; pinDevice?: string } = {}): Target {
  const n = String(++targetN).padStart(2, '0');
  const salon = opts.salon ?? SALON;
  const id = `${salon === SALON ? `ST-QA-PR-${RUN}` : `ST-QA-PR2-${RUN}`}-T${n}`;
  const handle = `${salon === SALON ? 'pr' : 'pr2'}-${run}-t${n}`;
  psql(
    staffSql({
      id,
      salon,
      handle,
      name: `QA Pairing Target ${n}`,
      role: 'artist',
      password: opts.password ?? false,
      pinDevice: opts.pinDevice ?? null,
      perms: { scanner: true, charges: true },
    }),
  );
  return { id, handle };
}

// --------------------------------------------------------------- principals --

let mgr = '';
let mgr2 = '';
let noTeam = '';
let noDash = '';
let wallet = '';
/** The forwarded address the manager signed in from — the proof the proxy override took. */
const MGR_IP = nextIp();

beforeAll(async () => {
  bootTrustingLoopbackProxy();
  await startTenancyApi();
  seed();

  /**
   * THE PRECONDITION EVERY PER-ADDRESS SPEC RESTS ON. Signed in by hand rather than through
   * `signInDashboard` so the request can carry a forwarded address, then read back from
   * `session.ip_address` — written by `issueSession(..., clientMeta(req))` from `req.ip`,
   * which is the value any address-keyed budget in this API reads too. If this does not
   * hold, every redeem in this file is 127.0.0.1 and the budget specs prove nothing.
   */
  const signIn = await treq<{ accessToken?: string }>('POST', '/auth/web/session', {
    token: null,
    body: { salonId: SALON, username: MGR_HANDLE, password: STAFF_PASSWORD },
    headers: { 'x-forwarded-for': MGR_IP },
  });
  precondition(
    signIn.status === 200 && !!signIn.body.accessToken,
    `the fixture manager could not sign in: ${signIn.status} ${signIn.raw}`,
  );
  mgr = signIn.body.accessToken!;
  const recorded = scalar(
    `select ip_address from session where staff_id = '${MGR}' order by created_at desc limit 1`,
  );
  precondition(
    recorded === MGR_IP,
    `the API recorded the manager's sign-in from "${recorded}", not the forwarded ${MGR_IP}. ` +
      'TRUST_PROXY=loopback did not reach the API this file booted, so every request here ' +
      'shares one address and the per-address budget specs would measure 127.0.0.1.',
  );

  mgr2 = await signInDashboard(SALON_2, MGR_2_HANDLE);
  noTeam = await signInDashboard(SALON, NOTEAM_HANDLE);
  noDash = await signInDashboard(SALON, NODASH_HANDLE);
  wallet = await signInMember(SALON, MEMBER_PHONE);
}, 180_000);

afterAll(async () => {
  await stopTenancyApi();
});

// ----------------------------------------------------------------- requests --

const succeeded = (status: number) => status === 200 || status === 201;

/** Structural, so this file needs no `zod` import of its own — the schemas come built. */
interface ContractSchema {
  parse: (v: unknown) => unknown;
  safeParse: (v: unknown) => {
    success: boolean;
    data?: unknown;
    error?: { issues: Array<{ path: Array<string | number>; message: string }> };
  };
}

function parsed<S extends ContractSchema>(schema: S, body: unknown, what: string): ReturnType<S['parse']> {
  const r = schema.safeParse(body);
  if (!r.success) {
    throw new Error(
      `${what} does not parse as the contract says it must:\n` +
        (r.error?.issues ?? []).map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n') +
        `\n--- body ---\n${JSON.stringify(body).slice(0, 800)}`,
    );
  }
  return r.data as ReturnType<S['parse']>;
}

async function issue(
  staffId: string,
  body: Record<string, unknown> = {},
  token = mgr,
): Promise<TenancyResponse<any>> {
  return treq<any>('POST', `/staff/${staffId}/pairing-code`, { token, body });
}

async function issueOk(staffId: string, body: Record<string, unknown> = {}, token = mgr) {
  const res = await issue(staffId, body, token);
  expect(
    succeeded(res.status),
    `POST /staff/${staffId}/pairing-code answered ${res.status}, not a code: ${res.raw}`,
  ).toBe(true);
  return parsed(StaffPairingCodeSchema, res.body, `POST /staff/${staffId}/pairing-code`);
}

async function pair(body: Record<string, unknown>, ip = nextIp()): Promise<TenancyResponse<any>> {
  return treq<any>('POST', '/staff/pair', {
    token: null,
    body,
    headers: { 'x-forwarded-for': ip },
  });
}

async function pairOk(body: Record<string, unknown>, ip?: string) {
  const res = await pair(body, ip);
  expect(succeeded(res.status), `POST /staff/pair answered ${res.status}, not a pairing: ${res.raw}`).toBe(
    true,
  );
  return parsed(StaffPairResponseSchema, res.body, 'POST /staff/pair');
}

function expectRefused(res: TenancyResponse<any>, cause: string): void {
  expect(
    res.status,
    `${cause}: POST /staff/pair answered ${res.status} where the uniform refusal is 400: ${res.raw}`,
  ).toBe(400);
  expect(res.body, `${cause}: the refusal is not the one body every cause shares`).toEqual(REFUSAL);
}

async function setPhone(staffId: string, phone: string, token = mgr): Promise<any> {
  const res = await treq<any>('PATCH', `/staff/${staffId}`, { token, body: { phone } });
  expect(
    res.status,
    `PATCH /staff/${staffId} { phone: "${phone}" } answered ${res.status}: ${res.raw}`,
  ).toBe(200);
  return res.body;
}

async function deactivate(staffId: string, token = mgr): Promise<void> {
  const res = await treq<any>('DELETE', `/staff/${staffId}`, { token });
  precondition(res.status === 200, `DELETE /staff/${staffId} answered ${res.status}: ${res.raw}`);
}

async function staffSession(body: Record<string, unknown>): Promise<TenancyResponse<any>> {
  return treq<any>('POST', '/staff/session', { token: null, body });
}

async function webSession(username: string, password = STAFF_PASSWORD) {
  return treq<any>('POST', '/auth/web/session', {
    token: null,
    body: { salonId: SALON, username, password },
  });
}

async function me(token: string): Promise<TenancyResponse<any>> {
  return treq<any>('GET', '/staff/me', { token });
}

// --------------------------------------------------------------- SQL reads --

/** `'"<value>"'` — a JSON string value, so `T01` never matches inside `T010`. */
const quoted = (v: string) => `'"${v}"'`;

/** Rows of `table` whose JSON image names `value` as a whole string. */
function rowsNaming(table: string, value: string, where = 'true'): number {
  return Number(
    scalar(`select count(*) from ${table} t where ${where} and strpos(to_jsonb(t)::text, ${quoted(value)}) > 0`),
  );
}

const codeRowsOf = (staffId: string) => rowsNaming('staff_pairing_code', staffId);

/** Every pairing-code row for a staff member, as JSON text. */
const codeRowText = (staffId: string): string =>
  scalar(
    `select coalesce(string_agg(to_jsonb(t)::text, E'\\n'), '') from staff_pairing_code t
      where strpos(to_jsonb(t)::text, ${quoted(staffId)}) > 0`,
  );

/**
 * Move a staff member's codes past their expiry, the way `booking-policy.test.ts` moves a
 * booking's clock: the stored bound, not the wall clock. `created_at` moves with it if the
 * table has one, so a CHECK that expiry follows creation cannot refuse the edit.
 */
function expireCodesOf(staffId: string): void {
  const cols = scalar(
    `select coalesce(string_agg(column_name, ','), '') from information_schema.columns
      where table_schema = 'public' and table_name = 'staff_pairing_code'`,
  ).split(',');
  precondition(
    cols.includes('expires_at'),
    `staff_pairing_code has no expires_at column (it has: ${cols.join(', ') || 'no table'}). ` +
      'The decision names it; this spec cannot expire a code without it.',
  );
  const created = cols.includes('created_at') ? `, created_at = now() - interval '11 minutes'` : '';
  const out = psql(`
    UPDATE staff_pairing_code t SET expires_at = now() - interval '1 minute'${created}
     WHERE strpos(to_jsonb(t)::text, ${quoted(staffId)}) > 0;
  `);
  precondition(/UPDATE [1-9]/.test(out), `no pairing-code row for ${staffId} to expire: ${out}`);
}

const staffCol = (staffId: string, col: string) =>
  scalar(`select coalesce(${col}::text, '') from staff_user where id = '${staffId}'`);

const liveScannerSessions = (staffId: string) =>
  Number(
    scalar(
      `select count(*) from session where staff_id = '${staffId}' and scope = 'scanner' and revoked_at is null`,
    ),
  );

const auditRowsNaming = (staffId: string) => rowsNaming('audit_log', staffId, `t.salon_id = '${SALON}'`);

// ===========================================================================

describe('issuing a code — POST /staff/:id/pairing-code', () => {
  it('perms.team off → 403, called directly, nothing written — and granting team is what lets the same call through', async () => {
    const t = newTarget();
    const res = await issue(t.id, {}, noTeam);
    expect(res.status, `a caller without perms.team was answered ${res.status}: ${res.raw}`).toBe(403);
    expect(res.body).toEqual({ error: 'forbidden', message: TEAM_COPY });
    expect(codeRowsOf(t.id), 'a refused issuance wrote a pairing-code row').toBe(0);

    // The mirror: the 403 came from the gate, not from a route broken shut.
    psql(`UPDATE staff_user SET perm_team = true WHERE id = '${NOTEAM}';`);
    try {
      const granted = await issueOk(t.id, {}, noTeam);
      expect(granted.staffId).toBe(t.id);
    } finally {
      psql(`UPDATE staff_user SET perm_team = false WHERE id = '${NOTEAM}';`);
    }
  });

  it('with a branchId, perms.dashboard off → 403 with the dashboard copy; the same caller without one is let through', async () => {
    const t = newTarget();
    const res = await issue(t.id, { branchId: BRANCH_2 }, noDash);
    expect(
      res.status,
      `a branchId enrols a till, which needs perms.dashboard; a team-only caller got ${res.status}: ${res.raw}`,
    ).toBe(403);
    expect(res.body).toEqual({ error: 'forbidden', message: DASHBOARD_COPY });
    expect(codeRowsOf(t.id), 'a refused issuance wrote a pairing-code row').toBe(0);

    const withoutBranch = await issueOk(t.id, {}, noDash);
    expect(withoutBranch.branchId).toBeNull();
  });

  it("another salon's staffId → the existing 404, identical to a staff id that does not exist", async () => {
    const elsewhere = newTarget({ salon: SALON_2 });
    const res = await issue(elsewhere.id);
    const ghost = await issue(`ST-QA-PR-${RUN}-NOBODY`);
    expect(res.status, `another salon's staff member answered ${res.status}: ${res.raw}`).toBe(404);
    expect(res.body).toEqual({ error: 'unknown_staff', message: 'No such staff member.' });
    expect(ghost.body, 'the other salon\'s roster is distinguishable from nobody').toEqual(res.body);
    expect(codeRowsOf(elsewhere.id)).toBe(0);
  });

  it('a deactivated staff member → 409 staff_deactivated, and no code', async () => {
    const t = newTarget();
    await deactivate(t.id);
    const res = await issue(t.id);
    expect(res.status, `a leaver was answered ${res.status}: ${res.raw}`).toBe(409);
    expect(res.body.error).toBe('staff_deactivated');
    expect(codeRowsOf(t.id)).toBe(0);
  });

  it('a branchId outside the salon → the existing 404 unknown_branch, identical to one that does not exist', async () => {
    const t = newTarget();
    const res = await issue(t.id, { branchId: BRANCH_ELSEWHERE });
    const ghost = await issue(t.id, { branchId: `BR-QA-PAIR-${RUN}-NOWHERE` });
    expect(res.status, `another salon's branch answered ${res.status}: ${res.raw}`).toBe(404);
    expect(res.body.error).toBe('unknown_branch');
    expect(ghost.body, "another salon's branch is distinguishable from no branch").toEqual(res.body);
    expect(codeRowsOf(t.id), 'a refused issuance wrote a pairing-code row').toBe(0);
  });

  it(`the response is StaffPairingCodeSchema: her id, a QR-safe token, six digits, ${STAFF_PAIRING_TTL_MINUTES} minutes, the branch asked for`, async () => {
    const t = newTarget();
    const before = Date.now();
    const code = await issueOk(t.id);
    const after = Date.now();

    expect(code.staffId).toBe(t.id);
    expect(code.branchId, 'no branchId was sent, so nothing will be enrolled').toBeNull();
    expect(code.code).toMatch(/^\d{6}$/);
    /**
     * The QR encodes `${STAFF_PAIRING_URL}?t=${token}` RAW. A `+`, `/` or `=` in the token
     * is mangled by a query string — `+` becomes a space — so a standard-base64 token
     * would scan as a different token on some phones and as the right one on others.
     */
    expect(code.token, 'the token needs escaping to sit in the QR URL').toMatch(/^[A-Za-z0-9_-]+$/);
    expect(new URL(`${STAFF_PAIRING_URL}?t=${code.token}`).searchParams.get('t')).toBe(code.token);

    const ttlMs = STAFF_PAIRING_TTL_MINUTES * 60_000;
    const expiresAt = Date.parse(code.expiresAt);
    expect(expiresAt, `expiresAt ${code.expiresAt} is not ~${STAFF_PAIRING_TTL_MINUTES} minutes out`).toBeGreaterThanOrEqual(
      before + ttlMs - 5_000,
    );
    expect(expiresAt).toBeLessThanOrEqual(after + ttlMs + 5_000);

    const withBranch = await issueOk(t.id, { branchId: BRANCH_2 });
    expect(withBranch.branchId).toBe(BRANCH_2);
    expect(withBranch.token).not.toBe(code.token);
  });

  it('issuing again voids the earlier unused code — by its token and by its digits — and the new one pairs', async () => {
    const t = newTarget();
    const phone = nextPhone();
    await setPhone(t.id, phone.local);

    const first = await issueOk(t.id);
    const second = await issueOk(t.id);

    expectRefused(await pair({ token: first.token, pin: PAIR_PIN }), 'the voided code, by its token');
    if (first.code !== second.code) {
      expectRefused(
        await pair({ phone: phone.e164, code: first.code, pin: PAIR_PIN }),
        'the voided code, by its digits',
      );
    }
    const ok = await pairOk({ token: second.token, pin: PAIR_PIN });
    expect(ok.staff.id).toBe(t.id);
  });
});

// ===========================================================================

describe('redeeming — POST /staff/pair', () => {
  it('by token: pairs her, signed in, and the same token is refused the second time', async () => {
    const t = newTarget();
    const code = await issueOk(t.id);
    const ok = await pairOk({ token: code.token, pin: PAIR_PIN });

    expect(ok.staff.id).toBe(t.id);
    expect(ok.salonId).toBe(SALON);
    expect(ok.staff.pinSet, 'pairing set her PIN, and the serialised row says it did not').toBe(true);
    expect(staffCol(t.id, 'pin_device_id'), 'the PIN is not bound to the device the reply names').toBe(
      ok.deviceId,
    );

    expectRefused(await pair({ token: code.token, pin: PAIR_PIN }), 'a used token');
    expect(staffCol(t.id, 'pin_device_id'), 'the refused second redeem moved her device').toBe(ok.deviceId);
  });

  it('by mobile number and the six digits — and that one code is then spent at both doors', async () => {
    const t = newTarget();
    const phone = nextPhone();
    await setPhone(t.id, phone.local);
    const code = await issueOk(t.id);

    const ok = await pairOk({ phone: phone.e164, code: code.code, pin: PAIR_PIN });
    expect(ok.staff.id).toBe(t.id);
    expect(ok.staff.phone).toBe(phone.e164);

    expectRefused(await pair({ phone: phone.e164, code: code.code, pin: PAIR_PIN }), 'used digits');
    expectRefused(await pair({ token: code.token, pin: PAIR_PIN }), "the used code's QR token");
  });

  it('two concurrent redeems of one token: exactly one pairs', async () => {
    const t = newTarget();
    const code = await issueOk(t.id);

    const fired = await Promise.all([
      timed(() => pair({ token: code.token, pin: PAIR_PIN })),
      timed(() => pair({ token: code.token, pin: '5820' })),
    ]);
    assertRaced(fired, 'two redeems of one pairing token');
    const [a, b] = valuesOf(fired);

    const wins = [a, b].filter((r) => succeeded(r.status));
    expect(
      wins.length,
      `two racing redeems of one code — ${a.status} ${a.raw.slice(0, 200)} | ${b.status} ${b.raw.slice(0, 200)}`,
    ).toBe(1);
    const loser = succeeded(a.status) ? b : a;
    expectRefused(loser, 'the losing racer');

    const winner = parsed(StaffPairResponseSchema, wins[0]!.body, 'the winning redeem');
    expect(staffCol(t.id, 'pin_device_id')).toBe(winner.deviceId);
    expect(liveScannerSessions(t.id), 'both racers came away with a scanner session').toBe(1);
  }, 60_000);

  it('…and when the race is ARRANGED — both held on her staff row until both are inside the transaction — still exactly one', async () => {
    /**
     * The decision: "In one transaction: claim the code (`used_at IS NULL` guard, so two
     * racing redeems cannot both win) ... set `pin_hash` ...". Setting `pin_hash` writes her
     * `staff_user` row, so holding that row `FOR UPDATE` parks every redeem INSIDE its
     * transaction, after whatever it read and before anything commits — `support/race.ts`
     * § withRowLockHeld. A pair that reads `used_at`, decides in JavaScript and then writes
     * unguarded passes the Promise.all race above on most runs and fails this one on every
     * run. If THIS spec fails on the receipt ("only N of 2 contenders ever blocked"), the
     * claim and the PIN write are not one transaction, which the decision also forbids.
     */
    const t = newTarget();
    const code = await issueOk(t.id);

    const [a, b] = await withRowLockHeld({ table: 'staff_user', id: t.id }, 2, () =>
      Promise.all([pair({ token: code.token, pin: PAIR_PIN }), pair({ token: code.token, pin: '5820' })]),
    );
    const wins = [a, b].filter((r) => succeeded(r.status));
    expect(wins.length, `${a.status} ${a.raw.slice(0, 200)} | ${b.status} ${b.raw.slice(0, 200)}`).toBe(1);
    expectRefused(succeeded(a.status) ? b : a, 'the arranged loser');
    expect(liveScannerSessions(t.id)).toBe(1);
  }, 60_000);

  it('an expired code is refused, by token and by digits', async () => {
    const t = newTarget();
    const phone = nextPhone();
    await setPhone(t.id, phone.local);
    const code = await issueOk(t.id);
    expireCodesOf(t.id);

    expectRefused(await pair({ token: code.token, pin: PAIR_PIN }), 'an expired token');
    expectRefused(await pair({ phone: phone.e164, code: code.code, pin: PAIR_PIN }), 'expired digits');
    expect(staffCol(t.id, 'pin_hash'), 'an expired code set a PIN').toBe('');
  });

  it('four wrong digits do not burn the code — the right digits still pair (the boundary)', async () => {
    const t = newTarget();
    const phone = nextPhone();
    await setPhone(t.id, phone.local);
    const code = await issueOk(t.id);

    for (let k = 1; k <= 4; k++) {
      expectRefused(
        await pair({ phone: phone.e164, code: wrongDigits(code.code, k), pin: PAIR_PIN }),
        `wrong digits #${k}`,
      );
    }
    const ok = await pairOk({ phone: phone.e164, code: code.code, pin: PAIR_PIN });
    expect(ok.staff.id).toBe(t.id);
  }, 60_000);

  it('five wrong digits burn the code — the right digits then fail, and so does its QR token', async () => {
    const t = newTarget();
    const phone = nextPhone();
    await setPhone(t.id, phone.local);
    const code = await issueOk(t.id);

    for (let k = 1; k <= 5; k++) {
      expectRefused(
        await pair({ phone: phone.e164, code: wrongDigits(code.code, k), pin: PAIR_PIN }),
        `wrong digits #${k}`,
      );
    }
    expectRefused(
      await pair({ phone: phone.e164, code: code.code, pin: PAIR_PIN }),
      'the RIGHT digits after five wrong ones',
    );
    expectRefused(await pair({ token: code.token, pin: PAIR_PIN }), "the burned code's QR token");
    expect(staffCol(t.id, 'pin_hash'), 'a burned code set a PIN').toBe('');
  }, 60_000);

  it('a malformed PIN is 400 invalid_pin_format, and does not spend the code', async () => {
    const t = newTarget();
    const code = await issueOk(t.id);
    for (const pin of ['12', '12345', 'abcd', '']) {
      const res = await pair({ token: code.token, pin });
      expect(res.status, `pin "${pin}" answered ${res.status}: ${res.raw}`).toBe(400);
      expect(res.body.error, `pin "${pin}"`).toBe('invalid_pin_format');
    }
    // A typo on the phone must not cost the staff member a trip back to the manager.
    const ok = await pairOk({ token: code.token, pin: PAIR_PIN });
    expect(ok.staff.id).toBe(t.id);
  });

  it('a code issued before she was deactivated is refused, and sets nothing', async () => {
    const t = newTarget();
    const phone = nextPhone();
    await setPhone(t.id, phone.local);
    const code = await issueOk(t.id);
    await deactivate(t.id);

    expectRefused(await pair({ token: code.token, pin: PAIR_PIN }), "a leaver's token");
    expectRefused(await pair({ phone: phone.e164, code: code.code, pin: PAIR_PIN }), "a leaver's digits");
    expect(staffCol(t.id, 'pin_hash')).toBe('');
    expect(staffCol(t.id, 'deactivated_at'), 'a refused pair re-activated her').not.toBe('');
  });

  it('a deviceId in the body is never the device her PIN is bound to', async () => {
    const t = newTarget();
    const code = await issueOk(t.id);
    const chosen = `QA-CLIENT-CHOSEN-${RUN}`;

    const res = await pair({ token: code.token, pin: PAIR_PIN, deviceId: chosen });
    if (succeeded(res.status)) {
      const ok = parsed(StaffPairResponseSchema, res.body, 'POST /staff/pair with a deviceId');
      expect(ok.deviceId, 'the server took the client\'s device id').not.toBe(chosen);
      expect(staffCol(t.id, 'pin_device_id')).toBe(ok.deviceId);
    } else {
      // Refusing the stray field is also a reading of the contract — but not by spending the code.
      expect(res.status, res.raw).toBeLessThan(500);
      const ok = await pairOk({ token: code.token, pin: PAIR_PIN });
      expect(ok.deviceId).not.toBe(chosen);
    }
  });

  it('the same mobile at two salons: the digits decide, and the other salon\'s staff member is never paired', async () => {
    /**
     * `staff_user.phone` is unique per SALON, so one person working at two salons holds the
     * same number at both; `{ phone, code, pin }` carries no salon. So the six digits are
     * what tell the two codes apart. This file's reading — say so if lane A's differs: the
     * digits that verify win, and the other salon's code is untouched.
     */
    const here = newTarget();
    const there = newTarget({ salon: SALON_2 });
    const phone = nextPhone();
    await setPhone(here.id, phone.local);
    await setPhone(there.id, phone.local, mgr2);
    const codeHere = await issueOk(here.id);
    const codeThere = await issueOk(there.id, {}, mgr2);
    precondition(codeHere.code !== codeThere.code, 'the two codes collided (one in a million) — rerun');

    const ok = await pairOk({ phone: phone.e164, code: codeThere.code, pin: PAIR_PIN });
    expect(ok.staff.id, 'the digits issued at salon two paired somebody else').toBe(there.id);
    expect(ok.salonId).toBe(SALON_2);
    expect(staffCol(here.id, 'pin_hash'), "salon one's staff member was paired too").toBe('');

    const stillThere = await pairOk({ token: codeHere.token, pin: PAIR_PIN });
    expect(stillThere.staff.id).toBe(here.id);
  });

  it('every cause of refusal is one status and one body, byte for byte', async () => {
    const used = newTarget();
    const usedCode = await issueOk(used.id);
    await pairOk({ token: usedCode.token, pin: PAIR_PIN });

    const voided = newTarget();
    const voidedCode = await issueOk(voided.id);
    await issueOk(voided.id);

    const expired = newTarget();
    const expiredCode = await issueOk(expired.id);
    expireCodesOf(expired.id);

    const wrong = newTarget();
    const wrongPhone = nextPhone();
    await setPhone(wrong.id, wrongPhone.local);
    const wrongCode = await issueOk(wrong.id);

    const leaver = newTarget();
    const leaverCode = await issueOk(leaver.id);
    await deactivate(leaver.id);

    const causes: Array<[string, Record<string, unknown>]> = [
      ['an unknown token', { token: ghostToken(), pin: PAIR_PIN }],
      ['a used token', { token: usedCode.token, pin: PAIR_PIN }],
      ['a voided token', { token: voidedCode.token, pin: PAIR_PIN }],
      ['an expired token', { token: expiredCode.token, pin: PAIR_PIN }],
      ['wrong digits', { phone: wrongPhone.e164, code: wrongDigits(wrongCode.code), pin: PAIR_PIN }],
      ['an unknown phone', { phone: nextPhone().e164, code: '000000', pin: PAIR_PIN }],
      ['a deactivated staff member', { token: leaverCode.token, pin: PAIR_PIN }],
    ];

    const seen: Array<{ cause: string; status: number; raw: string }> = [];
    for (const [cause, body] of causes) {
      const res = await pair(body);
      expectRefused(res, cause);
      seen.push({ cause, status: res.status, raw: res.raw });
    }
    expect(
      new Set(seen.map((s) => `${s.status} ${s.raw}`)).size,
      'two causes are distinguishable on the wire:\n' +
        seen.map((s) => `  ${s.cause}: ${s.status} ${s.raw}`).join('\n'),
    ).toBe(1);
  }, 60_000);
});

// ===========================================================================

describe('after pairing — the session, the PIN, the device, and what was revoked', () => {
  interface Paired {
    t: Target;
    phone: { local: string; e164: string };
    oldDevice: string;
    oldScanner: string;
    oldDashboard: string;
    res: ReturnType<typeof StaffPairResponseSchema.parse>;
    /** Read straight after the pair, before any spec below spends a failure. */
    failuresAfter: string;
    lockedUntilAfter: string;
    oldSessionRevokedAt: string;
  }

  let once: Promise<Paired> | undefined;

  /**
   * One staff member who ALREADY had a PIN on an old tablet, a live scanner session there,
   * a live dashboard session, and three failures plus a lock against her — then re-paired
   * onto a new phone. Built once, lazily, so a failure here is every claim's failure with
   * the same message rather than a `beforeAll` error.
   */
  const fixture = (): Promise<Paired> =>
    (once ??= (async () => {
      const oldDevice = nextDevice('OLD');
      const t = newTarget({ password: true, pinDevice: oldDevice });
      const phone = nextPhone();
      await setPhone(t.id, phone.local);

      const oldScanner = await signInScanner(SALON, t.handle, oldDevice);
      const oldDashboard = await signInDashboardFresh(SALON, t.handle);
      precondition((await me(oldScanner)).status === 200, 'her old scanner session never worked');

      psql(
        `UPDATE staff_user SET pin_failed_attempts = 3, pin_locked_until = now() + interval '15 minutes' WHERE id = '${t.id}';`,
      );

      const code = await issueOk(t.id);
      const res = await pairOk({ token: code.token, pin: PAIR_PIN });

      return {
        t,
        phone,
        oldDevice,
        oldScanner,
        oldDashboard,
        res,
        failuresAfter: staffCol(t.id, 'pin_failed_attempts'),
        lockedUntilAfter: staffCol(t.id, 'pin_locked_until'),
        oldSessionRevokedAt: scalar(
          `select coalesce(revoked_at::text, '') from session
            where staff_id = '${t.id}' and scope = 'scanner' and device_id = '${oldDevice}'
            order by created_at desc limit 1`,
        ),
      };
    })());

  it('the reply names her, at her salon, on a device id the SERVER issued', async () => {
    const f = await fixture();
    expect(f.res.staff.id).toBe(f.t.id);
    expect(f.res.salonId).toBe(SALON);
    expect(f.res.staff.handle).toBe(f.t.handle);
    expect(f.res.deviceId, 'the new binding is her old tablet').not.toBe(f.oldDevice);
    expect(staffCol(f.t.id, 'pin_device_id')).toBe(f.res.deviceId);
  });

  it('its session works on a scanner route', async () => {
    const f = await fixture();
    const charges = await treq<any>('GET', '/charges', { token: f.res.accessToken });
    expect(charges.status, `GET /charges with the paired session: ${charges.raw}`).toBe(200);
    const who = await me(f.res.accessToken);
    expect(who.status).toBe(200);
    expect(who.body.id).toBe(f.t.id);
    expect(
      scalar(`select scope::text || '|' || device_id from session where staff_id = '${f.t.id}' and revoked_at is null and device_id = '${f.res.deviceId}' limit 1`),
      'the paired session is not a scanner session on the server-issued device',
    ).toBe(`scanner|${f.res.deviceId}`);
  });

  it('the new PIN signs in from the server-issued device — by handle, by phone, and by the 8-digit number', async () => {
    const f = await fixture();
    for (const who of [{ handle: f.t.handle }, { phone: f.phone.e164 }, { phone: f.phone.local }]) {
      const res = await staffSession({ salonId: SALON, deviceId: f.res.deviceId, pin: PAIR_PIN, ...who });
      expect(res.status, `${JSON.stringify(who)}: ${res.raw}`).toBe(200);
      expect(res.body.staff.id).toBe(f.t.id);
    }
  });

  it('the new PIN is refused from her old tablet, and her old PIN from the new phone — as a wrong PIN', async () => {
    const f = await fixture();
    const newPinOldDevice = await staffSession({
      salonId: SALON,
      deviceId: f.oldDevice,
      handle: f.t.handle,
      pin: PAIR_PIN,
    });
    const oldPinNewDevice = await staffSession({
      salonId: SALON,
      deviceId: f.res.deviceId,
      handle: f.t.handle,
      pin: SEEDED_PIN,
    });
    resetPinState(f.t.id);
    expect(newPinOldDevice.status, newPinOldDevice.raw).toBe(401);
    expect(newPinOldDevice.body).toEqual(BAD_CREDENTIALS);
    expect(oldPinNewDevice.status, oldPinNewDevice.raw).toBe(401);
    expect(oldPinNewDevice.body).toEqual(BAD_CREDENTIALS);
  });

  it('her earlier scanner session is revoked — and her dashboard session is not', async () => {
    const f = await fixture();
    expect(f.oldSessionRevokedAt, 'the old scanner session row was not revoked').not.toBe('');
    const old = await me(f.oldScanner);
    expect(old.status, `the old tablet's session still answers: ${old.raw}`).toBe(401);
    /**
     * "revoke the staff member's live SCANNER sessions". A manager pairing her own phone
     * from the dashboard is the primary flow — revoking every session would sign her out
     * of the screen she is pairing from.
     */
    const web = await me(f.oldDashboard);
    expect(web.status, `pairing signed her out of the dashboard: ${web.raw}`).toBe(200);
  });

  it('her PIN failures and lock were cleared by the pair', async () => {
    const f = await fixture();
    expect(f.failuresAfter, 'pin_failed_attempts survived the pair').toBe('0');
    expect(f.lockedUntilAfter, 'pin_locked_until survived the pair').toBe('');
  });

  it('with a branchId, the phone is enrolled as a till at that branch, and its charge is ESTABLISHED there', async () => {
    const t = newTarget();
    const code = await issueOk(t.id, { branchId: BRANCH_2 });
    expect(code.branchId).toBe(BRANCH_2);
    const ok = await pairOk({ token: code.token, pin: PAIR_PIN });

    expect(
      scalar(
        `select coalesce(string_agg(branch_id, ','), '') from device_enrolment
          where salon_id = '${SALON}' and device_id = '${ok.deviceId}' and revoked_at is null`,
      ),
      'no live device_enrolment row binds the paired phone to the branch on the code',
    ).toBe(BRANCH_2);

    const token = await mintWalletTokenFor(wallet, MEMBER);
    const charge = await treq<any>('POST', '/charges', {
      token: ok.accessToken,
      idempotencyKey: `qa-pair-${RUN}-enrolled`,
      body: { memberId: MEMBER, serviceIds: [SERVICE], token, confirmDuplicate: true },
    });
    expect(charge.status, `a charge from the paired till: ${charge.raw}`).toBe(200);
    expect(
      scalar(`select branch_id || '|' || branch_assumed::text from transaction where id = '${charge.body.transaction.id}'`),
      'the charge from an enrolled till was not established at its branch',
    ).toBe(`${BRANCH_2}|false`);
  }, 60_000);

  it('without one, nothing is enrolled — and the same charge is ASSUMED at the first branch (the control)', async () => {
    const t = newTarget();
    const ok = await pairOk({ token: (await issueOk(t.id)).token, pin: PAIR_PIN });
    expect(
      Number(scalar(`select count(*) from device_enrolment where salon_id = '${SALON}' and device_id = '${ok.deviceId}'`)),
      'a code with no branch enrolled the phone anyway',
    ).toBe(0);

    const token = await mintWalletTokenFor(wallet, MEMBER);
    const charge = await treq<any>('POST', '/charges', {
      token: ok.accessToken,
      idempotencyKey: `qa-pair-${RUN}-unenrolled`,
      body: { memberId: MEMBER, serviceIds: [SERVICE], token, confirmDuplicate: true },
    });
    expect(charge.status, `a charge from the un-enrolled phone: ${charge.raw}`).toBe(200);
    expect(
      scalar(`select branch_id || '|' || branch_assumed::text from transaction where id = '${charge.body.transaction.id}'`),
    ).toBe(`${BRANCH_1}|true`);
  }, 60_000);
});

// ===========================================================================

describe('StaffUser.phone — POST and PATCH /staff', () => {
  it('POST /staff with an 8-digit number stores +965…, and the reply carries it', async () => {
    const phone = nextPhone();
    const handle = `pr-${run}-hire-${phoneN}`;
    const res = await treq<any>('POST', '/staff', {
      token: mgr,
      body: { name: 'QA Pairing Hire', handle, role: 'artist', phone: phone.local },
    });
    expect(res.status, `POST /staff with a phone: ${res.raw}`).toBe(201);
    expect(res.body.phone).toBe(phone.e164);
    parsed(StaffUserSchema, res.body, 'POST /staff');
    expect(scalar(`select phone from staff_user where salon_id = '${SALON}' and handle = '${handle}'`)).toBe(
      phone.e164,
    );
  });

  it('PATCH /staff/:id sets it the same way, from either form', async () => {
    const t = newTarget();
    const local = nextPhone();
    expect((await setPhone(t.id, local.local)).phone).toBe(local.e164);
    expect(staffCol(t.id, 'phone')).toBe(local.e164);

    const e164 = nextPhone();
    expect((await setPhone(t.id, e164.e164)).phone).toBe(e164.e164);
    expect(staffCol(t.id, 'phone')).toBe(e164.e164);
  });

  it('a malformed number is refused 400 invalid_phone, and nothing is stored', async () => {
    const t = newTarget();
    const res = await treq<any>('PATCH', `/staff/${t.id}`, { token: mgr, body: { phone: '12345' } });
    expect(res.status, res.raw).toBe(400);
    /**
     * `invalid_phone` is `parseE164`'s code (`api/src/http/fields.ts`), which the decision
     * names as the validator. Pinned so a 400 for a DIFFERENT reason — `not_settable_here`,
     * which is what a PATCH that does not know the field answers — cannot pass this.
     */
    expect(res.body.error).toBe('invalid_phone');
    expect(staffCol(t.id, 'phone')).toBe('');
  });

  it('a number held by another ACTIVE staff member → 409 phone_taken, on POST and on PATCH, in either form', async () => {
    const holder = newTarget();
    const phone = nextPhone();
    await setPhone(holder.id, phone.local);

    const handle = `pr-${run}-dup-${phoneN}`;
    const hire = await treq<any>('POST', '/staff', {
      token: mgr,
      body: { name: 'QA Pairing Duplicate', handle, role: 'artist', phone: phone.e164 },
    });
    expect(hire.status, `POST /staff with a taken number: ${hire.raw}`).toBe(409);
    expect(hire.body.error).toBe('phone_taken');
    expect(Number(scalar(`select count(*) from staff_user where salon_id = '${SALON}' and handle = '${handle}'`))).toBe(0);

    const other = newTarget();
    const edit = await treq<any>('PATCH', `/staff/${other.id}`, { token: mgr, body: { phone: phone.local } });
    expect(edit.status, `PATCH /staff with a taken number (8-digit form): ${edit.raw}`).toBe(409);
    expect(edit.body.error).toBe('phone_taken');
    expect(staffCol(other.id, 'phone')).toBe('');
  });

  it('…and is free again once the holder is deactivated', async () => {
    const holder = newTarget();
    const phone = nextPhone();
    await setPhone(holder.id, phone.local);
    await deactivate(holder.id);

    const next = newTarget();
    expect((await setPhone(next.id, phone.e164)).phone).toBe(phone.e164);
  });

  it('the same number at another salon is not taken', async () => {
    const here = newTarget();
    const there = newTarget({ salon: SALON_2 });
    const phone = nextPhone();
    await setPhone(here.id, phone.local);
    expect((await setPhone(there.id, phone.local, mgr2)).phone).toBe(phone.e164);
  });

  it('every serialised StaffUser carries the key — the roster, /staff/me, PATCH, and both sign-in bodies', async () => {
    const device = nextDevice('SER');
    const t = newTarget({ password: true, pinDevice: device });
    const phone = nextPhone();
    const patched = await setPhone(t.id, phone.local);
    expect('phone' in patched, 'PATCH /staff/:id').toBe(true);

    const roster = await treq<any>('GET', '/staff', { token: mgr });
    expect(roster.status).toBe(200);
    const missing = roster.body.items.filter((s: any) => !('phone' in s)).map((s: any) => s.id);
    expect(missing, 'roster rows without a phone KEY — nullable is required on the wire').toEqual([]);
    for (const s of roster.body.items) parsed(StaffUserSchema, s, `GET /staff → ${s.id}`);
    expect(roster.body.items.find((s: any) => s.id === t.id)?.phone).toBe(phone.e164);
    expect(roster.body.items.find((s: any) => s.id === MGR)?.phone, 'a staff member with no number').toBeNull();

    const self = await me(mgr);
    expect('phone' in self.body, 'GET /staff/me').toBe(true);

    const scanner = await staffSession({ salonId: SALON, deviceId: device, handle: t.handle, pin: SEEDED_PIN });
    expect(scanner.status, scanner.raw).toBe(200);
    expect(scanner.body.staff.phone, 'POST /staff/session body').toBe(phone.e164);

    const web = await webSession(t.handle);
    expect(web.status, web.raw).toBe(200);
    expect(web.body.staff.phone, 'POST /auth/web/session body').toBe(phone.e164);
  });
});

// ===========================================================================

describe('signing in by mobile number', () => {
  it('POST /staff/session takes { salonId, deviceId, phone, pin } — E.164 and the 8-digit number', async () => {
    const device = nextDevice('PH');
    const t = newTarget({ pinDevice: device });
    const phone = nextPhone();
    await setPhone(t.id, phone.local);
    for (const p of [phone.e164, phone.local]) {
      const res = await staffSession({ salonId: SALON, deviceId: device, phone: p, pin: SEEDED_PIN });
      expect(res.status, `phone "${p}": ${res.raw}`).toBe(200);
      expect(res.body.staff.id).toBe(t.id);
    }
  });

  it('handle and phone together is refused 400 — exactly one of them', async () => {
    const device = nextDevice('BOTH');
    const t = newTarget({ pinDevice: device });
    const phone = nextPhone();
    await setPhone(t.id, phone.local);
    const res = await staffSession({
      salonId: SALON,
      deviceId: device,
      handle: t.handle,
      phone: phone.e164,
      pin: SEEDED_PIN,
    });
    expect(res.status, `both identifiers answered ${res.status}: ${res.raw}`).toBe(400);
  });

  it('an unknown phone answers exactly as a wrong PIN, a wrong device and a wrong handle — status and body', async () => {
    const device = nextDevice('ENUM');
    const t = newTarget({ pinDevice: device });
    const phone = nextPhone();
    await setPhone(t.id, phone.local);

    const attempts: Array<[string, Record<string, unknown>]> = [
      ['unknown phone', { phone: nextPhone().e164 }],
      ['known phone, wrong PIN', { phone: phone.e164, pin: '0000' }],
      ['known phone, wrong device', { phone: phone.e164, deviceId: nextDevice('ELSEWHERE') }],
      ['known handle, wrong PIN', { handle: t.handle, pin: '0000' }],
    ];
    const seen: string[] = [];
    for (const [label, extra] of attempts) {
      const res = await staffSession({ salonId: SALON, deviceId: device, pin: SEEDED_PIN, ...extra });
      expect(res.status, `${label}: ${res.raw}`).toBe(401);
      expect(res.body, label).toEqual(BAD_CREDENTIALS);
      seen.push(res.raw);
    }
    resetPinState(t.id, device);
    expect(new Set(seen).size, `distinguishable on the wire:\n${seen.join('\n')}`).toBe(1);
  });

  it('…and does not answer faster — an unknown number pays for a hash too (coarse: median, interleaved)', async () => {
    const device = nextDevice('TIME');
    const t = newTarget({ pinDevice: device });
    const phone = nextPhone();
    await setPhone(t.id, phone.local);

    const ms = { unknown: [] as number[], wrong: [] as number[] };
    for (let i = 0; i < 6; i++) {
      // Counters back to zero before every pair, so neither the lock (5) nor the device
      // window (10) turns a sample into a different code path.
      resetPinState(t.id, device);
      const order: Array<'unknown' | 'wrong'> = i % 2 ? ['unknown', 'wrong'] : ['wrong', 'unknown'];
      for (const kind of order) {
        const body =
          kind === 'unknown'
            ? { salonId: SALON, deviceId: device, phone: nextPhone().e164, pin: SEEDED_PIN }
            : { salonId: SALON, deviceId: device, phone: phone.e164, pin: '0000' };
        const start = performance.now();
        const res = await staffSession(body);
        ms[kind].push(performance.now() - start);
        expect(res.status, `${kind}: ${res.raw}`).toBe(401);
      }
    }
    resetPinState(t.id, device);
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    /**
     * A wrong PIN is one argon2id verify (19 MiB, t=2: tens of milliseconds); an unknown
     * number that skipped `burnVerifyTime` would be a couple of index reads. A third is far
     * below the first and far above the second, so load moves both without crossing it.
     */
    expect(
      median(ms.unknown),
      `unknown ${ms.unknown.map((x) => x.toFixed(0)).join(',')}ms vs wrong PIN ` +
        `${ms.wrong.map((x) => x.toFixed(0)).join(',')}ms — an unknown number is answered without a hash`,
    ).toBeGreaterThan(median(ms.wrong) / 3);
  }, 60_000);

  it('a number handed on after a deactivation signs in the NEW holder, not the leaver', async () => {
    const leaver = newTarget();
    const phone = nextPhone();
    await setPhone(leaver.id, phone.local);
    await deactivate(leaver.id);

    const device = nextDevice('HEIR');
    const heir = newTarget({ password: true, pinDevice: device });
    await setPhone(heir.id, phone.local);

    const scanner = await staffSession({ salonId: SALON, deviceId: device, phone: phone.e164, pin: SEEDED_PIN });
    expect(scanner.status, `the new holder by phone: ${scanner.raw}`).toBe(200);
    expect(scanner.body.staff.id, 'the phone resolved to the leaver').toBe(heir.id);

    const web = await webSession(phone.local);
    expect(web.status, `the new holder on the web by phone: ${web.raw}`).toBe(200);
    expect(web.body.staff.id).toBe(heir.id);
  });

  it('POST /auth/web/session accepts the mobile number as the username — 8-digit and E.164', async () => {
    const t = newTarget({ password: true });
    const phone = nextPhone();
    await setPhone(t.id, phone.local);
    for (const username of [phone.local, phone.e164]) {
      const res = await webSession(username);
      expect(res.status, `username "${username}": ${res.raw}`).toBe(200);
      expect(res.body.staff.id).toBe(t.id);
      parsed(StaffUserSchema, res.body.staff, `POST /auth/web/session as ${username}`);
    }
  });

  it('an unknown mobile answers the web door exactly as a wrong password', async () => {
    const t = newTarget({ password: true });
    const phone = nextPhone();
    await setPhone(t.id, phone.local);
    const unknown = await webSession(nextPhone().local);
    const wrong = await webSession(phone.local, 'not-the-password');
    expect(unknown.status, unknown.raw).toBe(401);
    expect(unknown.body).toEqual(BAD_CREDENTIALS);
    expect(wrong.status, wrong.raw).toBe(401);
    expect(unknown.raw, 'an unknown mobile is distinguishable from a wrong password').toBe(wrong.raw);
  });
});

// ===========================================================================

describe('what is written — audit rows, and never the code', () => {
  it('issuing and pairing each write an audit row about her', async () => {
    const t = newTarget();
    const before = auditRowsNaming(t.id);
    const code = await issueOk(t.id);
    const afterIssue = auditRowsNaming(t.id);
    expect(afterIssue, 'issuing a pairing code wrote no audit row naming her').toBeGreaterThan(before);

    await pairOk({ token: code.token, pin: PAIR_PIN });
    expect(auditRowsNaming(t.id), 'pairing her phone wrote no audit row naming her').toBeGreaterThan(afterIssue);
  });

  it('the token and the six digits are nowhere in plain text — code rows, audit, staff, sessions, devices', async () => {
    const t = newTarget();
    const since = scalar('select now()::text');
    const code = await issueOk(t.id, { branchId: BRANCH_2 });
    const ok = await pairOk({ token: code.token, pin: PAIR_PIN });
    precondition(codeRowsOf(t.id) > 0, 'no pairing-code row names her, so the scan below is vacuous');

    const digits = `'(^|[^0-9])${code.code}([^0-9]|$)'`;
    const tables: Array<[string, string]> = [
      ['staff_pairing_code', 'true'],
      ['audit_log', `t.created_at >= '${since}'`],
      ['staff_user', `t.id = '${t.id}'`],
      ['session', `t.staff_id = '${t.id}'`],
      ['device_enrolment', `t.salon_id = '${SALON}'`],
    ];
    for (const [table, where] of tables) {
      expect(
        Number(scalar(`select count(*) from ${table} t where ${where} and strpos(to_jsonb(t)::text, '${code.token}') > 0`)),
        `the pairing TOKEN is stored in plain text in ${table}`,
      ).toBe(0);
      expect(
        Number(scalar(`select count(*) from ${table} t where ${where} and to_jsonb(t)::text ~ ${digits}`)),
        `the six DIGITS ${code.code} appear as a value in ${table}`,
      ).toBe(0);
    }
    // The PIN she chose, likewise — non-negotiable #6.
    expect(
      Number(scalar(`select count(*) from staff_user t where t.id = '${t.id}' and to_jsonb(t)::text ~ '(^|[^0-9])${PAIR_PIN}([^0-9]|$)'`)),
      'her PIN is stored as a value',
    ).toBe(0);
    expect(ok.staff.id).toBe(t.id);
  });

  it('the digits are kept through argon2id, never a fast digest — and the token as its sha256', async () => {
    /**
     * The decision, verbatim in intent: "the six digits through hashSecret (argon2id — six
     * digits are brute-forceable from a leaked sha256)". A million sha256 preimages is a
     * laptop-second, so a fast digest of the code is the code. Checked as encodings of each
     * fast digest NOT appearing, and an argon2id string appearing.
     */
    const t = newTarget();
    const code = await issueOk(t.id);
    const row = codeRowText(t.id);
    precondition(row !== '', 'no pairing-code row names her');

    const encodings = (algo: string, input: string) => {
      const d = createHash(algo).update(input).digest();
      return [d.toString('hex'), d.toString('base64'), d.toString('base64url')];
    };
    for (const algo of ['sha256', 'sha1', 'md5', 'sha512']) {
      for (const e of encodings(algo, code.code)) {
        expect(row.includes(e), `the six digits are stored as a ${algo} digest (${e})`).toBe(false);
      }
    }
    expect(row, 'no argon2id hash in the code row — the digits are not kept through hashSecret').toContain(
      '$argon2id$',
    );
    expect(
      encodings('sha256', code.token).some((e) => row.includes(e)),
      'the token is not stored as its sha256 (hex, base64 or base64url)',
    ).toBe(true);
  });
});

// ===========================================================================

describe('the budget in front of POST /staff/pair', () => {
  /** Generous against "the existing sign-in-limit pattern" (10 per 15 minutes). */
  const CAP = 40;

  it('one address hammering unknown tokens gets 429 too_many_attempts — and a REAL code from it is refused but not spent', async () => {
    const ip = nextIp();
    let tripped = 0;
    let last: TenancyResponse<any> | undefined;
    for (let i = 1; i <= CAP; i++) {
      last = await pair({ token: ghostToken(), pin: PAIR_PIN }, ip);
      if (last.status === 429) {
        tripped = i;
        break;
      }
      expectRefused(last, `unknown token #${i} from one address`);
    }
    expect(tripped, `${CAP} unknown tokens from ${ip} and no 429 — there is no per-address budget`).toBeGreaterThan(0);
    expect(last!.body.error).toBe('too_many_attempts');

    // The budget sits IN FRONT: a valid code from the spent address is refused before it
    // is looked at, so it is not claimed, and the same code pairs from somewhere else.
    const t = newTarget();
    const code = await issueOk(t.id);
    const blocked = await pair({ token: code.token, pin: PAIR_PIN }, ip);
    expect(blocked.status, `a real code from a spent address: ${blocked.raw}`).toBe(429);
    expect(blocked.body.error).toBe('too_many_attempts');
    expect(staffCol(t.id, 'pin_hash'), 'the over-budget redeem paired her anyway').toBe('');

    const ok = await pairOk({ token: code.token, pin: PAIR_PIN });
    expect(ok.staff.id, 'the over-budget attempt spent the code').toBe(t.id);
  }, 120_000);

  it('one phone hammered from many addresses gets 429 too_many_attempts', async () => {
    const t = newTarget();
    const phone = nextPhone();
    await setPhone(t.id, phone.local);
    const code = await issueOk(t.id);

    let tripped = 0;
    let last: TenancyResponse<any> | undefined;
    for (let i = 1; i <= CAP; i++) {
      last = await pair({ phone: phone.e164, code: wrongDigits(code.code, i), pin: PAIR_PIN }, nextIp());
      if (last.status === 429) {
        tripped = i;
        break;
      }
      expectRefused(last, `wrong digits #${i} for one phone`);
    }
    expect(
      tripped,
      `${CAP} attempts at one phone from ${CAP} addresses and no 429 — there is no per-phone budget, ` +
        'so rotating addresses walks a number without limit',
    ).toBeGreaterThan(0);
    expect(last!.body.error).toBe('too_many_attempts');
  }, 120_000);
});
