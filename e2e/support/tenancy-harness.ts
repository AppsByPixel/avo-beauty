/**
 * The two-salon harness.
 *
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------
 * The other three suites drive `packages/mock`, which knows about exactly one
 * salon: every `/salons/:id` handler in it ignores the `:id` and answers with
 * Amara. Pointed at the mock, a tenancy suite would be all red and would prove
 * nothing about the product. Tenancy is a property of lane A's API and of the
 * database underneath it, so this suite boots THAT and nothing else.
 *
 * It therefore does not use `support/api.ts` or the shared global setup. It
 * starts its own `api/src/server.ts` on its own port, seeds a second salon
 * straight into lane A's docker Postgres, and talks to the API with real Bearer
 * sessions minted by real sign-ins.
 *
 * HOW SALON B IS SEEDED, AND WHY IT IS SQL
 * ----------------------------------------
 * `api/src/db/seed.ts` seeds one salon and is lane A's file — lane D may not
 * edit it. So salon B is inserted here with `psql`, run inside the compose
 * container from `api/docker-compose.yml`:
 *
 *     docker exec -i avo-postgres psql -U avo -d avo
 *
 * That is the OWNER connection, deliberately: the seed needs to write rows the
 * application role is not allowed to write, and using the owner here is the same
 * decision `api/src/db/seed.ts` documents for the same reason.
 *
 * The salon B credentials are not invented. `password_hash` and `pin_hash` are
 * COPIED from salon A's ST-001 row, so Layla's web password and PIN are Noura's
 * — `noura-dev-password` and `2468` from `api/src/db/seed.ts`. Hashing argon2id
 * here would mean importing lane A's password module into a package that does not
 * depend on it; copying a hash needs nothing and cannot drift, because if lane A
 * changes the seed password both salons change together and the sign-in below
 * still works. If it ever does not, `preflight()` says so by name.
 *
 * WHAT IS AUTHENTIC HERE AND WHAT IS A SHIM
 * -----------------------------------------
 * Every salon B request carries a real `Authorization: Bearer` token from a real
 * `POST /auth/web/session` or `POST /staff/session`. Nothing about salon B goes
 * through `AVO_TEST_PRINCIPALS`.
 *
 * The flag is still on, for one reason: minting a wallet token for salon A's
 * member 8842 needs a member session, and her seeded password is not something
 * this file can know. With the flag on, an UNAUTHENTICATED request to
 * `/members/me/wallet-token` resolves to member 8842 and mints a genuine token —
 * a real row in `wallet_token`, hashed, 45 seconds, single use. The token is
 * real; only the way its owner signed in is a shim.
 *
 * The trap that creates: a salon B request that forgets its bearer header does
 * not fail, it silently becomes salon A's ST-001 and gets a 200. `treq()` refuses
 * to send an authenticated-looking request with no token, and the first specs in
 * tenancy.test.ts assert who each token actually resolves to.
 */

import { execFileSync } from 'node:child_process';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
/** e2e/support → e2e → repo root */
export const repoRoot = join(here, '..', '..');

// ------------------------------------------------------------------ fixtures --

/** Lane A's seeded salon. `api/src/db/seed.ts`. */
export const SALON_A = 'SAL-AMARA';
export const A_MEMBER = '8842';
export const A_MEMBER_NAME = 'Dana Al-Sabah';
export const A_MEMBER_PHONE = '+96599124408';
export const A_STAFF_FULL = 'ST-001';
export const A_STAFF_RESTRICTED = 'ST-002';
export const A_SERVICE = 'SV-01';

/** The second salon, seeded by this file and by nothing else. */
export const SALON_B = 'SAL-LUMIERE';
export const B_MEMBER = '9001';
export const B_MEMBER_PHONE = '+96599555001';
export const B_STAFF = 'ST-B01';
export const B_STAFF_HANDLE = 'layla';
export const B_BRANCH = 'BR-LUM-HAW';
export const B_SERVICE = 'SV-B01';
export const B_SERVICE_PRICE_FILS = 7_000;
export const B_MEMBER_BALANCE_FILS = 30_000;
export const B_SCANNER_DEVICE = 'DEV-SCANNER-B';

/** From `api/src/db/seed.ts`. Copied hashes mean salon B shares them. */
const STAFF_PASSWORD = 'noura-dev-password';
const STAFF_PIN = '2468';

/** A salon id that has never existed. The control for the existence-oracle specs. */
export const SALON_NOWHERE = 'SAL-DOES-NOT-EXIST';
export const STAFF_NOWHERE = 'ST-DOES-NOT-EXIST';

// ------------------------------------------------------- the isolated member --

/**
 * A MEMBER THAT BELONGS TO THE SUITE, RESET ON EVERY RUN.
 *
 * WHY SHE EXISTS
 * --------------
 * The gateway suite first ran against lane A's seeded member 8842 and went red
 * on its second run. She is shared: `money.test.ts`, `concurrency.test.ts` and
 * `permissions.test.ts` all charge her, `applyVisits` moves her up the tier
 * ladder as they do, and nothing resets her. Over accumulated runs she went
 * Silver → Gold → Black, her bonus went 10% → 20% → 30%, and her balance drifted
 * from 24.500 KD to over 300 KD. Any spec holding a figure about her decays into
 * a test of how many earlier runs happened.
 *
 * That is not a bug in one spec; it is the absence of isolation, and it ends
 * with a suite that is entirely red and that everyone has stopped reading. So
 * the suites that CAN own their fixture do:
 *
 *   Dana 8842            lane A's seed. Shared, drifting. Read, never pinned.
 *   Fatima 9001          salon B. Reset by `seedSalonB()` on every run.
 *   Rania QA-GW-0001     this one. Reset by `seedQaMember()` on every run.
 *
 * WHY SHE IS IN SALON A AND NOT SALON B
 * -------------------------------------
 * Two properties the gateway suite needs that salon B does not have:
 * `whatsapp_enabled` is true at Amara, and she carries a VERIFIED email address,
 * so a settled payment owes her both receipt channels.
 *
 * She is an ADDITION to salon A, never an edit of it. Nothing here touches Dana,
 * Reem, the staff rows or the salon itself. If a spec ever moves one of those,
 * that is the bug the spec was looking for.
 *
 * WHY `tier` IS WRITTEN AND NOT DERIVED
 * -------------------------------------
 * `createTopUp` reads `member.tier`, so pinning the tier is exactly what turns
 * the expected bonus back into a literal. `visits` is set consistent with it so
 * the row is not self-contradictory for anything that later recomputes it.
 *
 * FOR THE SUITES THAT CANNOT USE HER: `money.test.ts`, `concurrency.test.ts` and
 * `permissions.test.ts` run against `packages/mock` by default and must keep
 * working with no Postgres and no docker, so they cannot seed anything. They
 * assert RELATIVELY instead — read the balance and the tier first, then assert
 * the delta and the rate. Same goal, different mechanism.
 */
export const QA_MEMBER = 'QA-GW-0001';
export const QA_MEMBER_NAME = 'Rania Al-Otaibi';
export const QA_MEMBER_PHONE = '+96599777001';
export const QA_MEMBER_EMAIL = 'qa-gateway@example.invalid';
/** Reset to this on every run, so a balance delta is the only thing a spec reads. */
export const QA_MEMBER_BALANCE_FILS = 50_000;
/** Pinned. Salon A's ladder: bronze 0%, silver 10% ≥4 visits, gold 20% ≥10, black 30% ≥20. */
export const QA_MEMBER_TIER = 'silver';
export const QA_MEMBER_BONUS_PERCENT = 10;
export const QA_MEMBER_VISITS = 6;

// ------------------------------------------------------------ the gateway --

/**
 * The HMAC key the API is booted with, so this suite can sign a callback the
 * way the processor does.
 *
 * `api/src/env.ts` GENERATES a random secret per boot when the variable is
 * unset. That is a good default for a developer and useless for a test: a suite
 * that cannot compute a valid signature can only ever prove that bad ones are
 * refused, which is the half that passes when the endpoint is broken shut.
 * Pinning it here buys the control — a correctly signed callback that settles —
 * which is what makes every 401 below mean "the signature was wrong" rather than
 * "the webhook never works".
 */
export const GATEWAY_WEBHOOK_SECRET = 'tenancy-suite-gateway-hmac-key-not-a-secret-0123456789';

/** `env.gatewayWebhookToleranceSeconds`'s default. The replay window. */
export const GATEWAY_WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * `x-avo-signature: t=<unix seconds>,v1=<hex hmac>`.
 *
 * Computed here from the documented construction — HMAC-SHA256 over
 * `${t}.${rawBody}` — and NOT by importing `signGatewayPayload` from
 * `api/src/gateway/sandbox.ts`. Signing with the implementation's own function
 * would verify that the code agrees with itself; a test that does that cannot
 * catch the day someone changes what goes into the MAC.
 *
 * The timestamp is INSIDE the MAC on purpose, and this helper is what proves it:
 * `signCallback(body, staleT)` produces a signature that is valid for `staleT`
 * and for no other `t`, so a captured callback cannot be replayed with a fresh
 * header.
 */
export function signCallback(
  rawBody: string,
  timestampSeconds: number,
  secret: string = GATEWAY_WEBHOOK_SECRET,
): string {
  const mac = createHmac('sha256', secret).update(`${timestampSeconds}.${rawBody}`).digest('hex');
  return `t=${timestampSeconds},v1=${mac}`;
}

export const SIGNATURE_HEADER = 'x-avo-signature';

/** Unix seconds, the unit the signature header carries. */
export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

// ----------------------------------------------------------------- postgres --

const PG_CONTAINER = process.env.AVO_PG_CONTAINER ?? 'avo-postgres';
const PG_USER = process.env.POSTGRES_USER ?? 'avo';
const PG_DB = process.env.POSTGRES_DB ?? 'avo';

/**
 * Run SQL as the database owner and return stdout.
 *
 * `-v ON_ERROR_STOP=1` matters: without it psql exits 0 after a failed statement
 * and a broken seed reads as a passing suite.
 */
export function psql(sql: string): string {
  try {
    return execFileSync(
      'docker',
      ['exec', '-i', PG_CONTAINER, 'psql', '-U', PG_USER, '-d', PG_DB, '-v', 'ON_ERROR_STOP=1'],
      { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message?: string };
    throw new Error(
      `psql failed against container "${PG_CONTAINER}".\n` +
        'Is lane A\'s Postgres up?  pnpm --filter @avo/api run db:up\n' +
        `--- sql ---\n${sql.trim()}\n--- stderr ---\n${String(e.stderr ?? e.message ?? '')}`,
    );
  }
}

/** One scalar. Empty string when the query returns no row. */
export function scalar(sql: string): string {
  return execFileSync(
    'docker',
    ['exec', '-i', PG_CONTAINER, 'psql', '-U', PG_USER, '-d', PG_DB, '-tAc', sql],
    { encoding: 'utf8' },
  ).trim();
}

// ----------------------------------------------------------------- preflight --

function preflight(): void {
  try {
    execFileSync('docker', ['inspect', '--format', '{{.State.Running}}', PG_CONTAINER], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error(
      `The tenancy suite needs lane A's Postgres. Container "${PG_CONTAINER}" is not there.\n` +
        '  pnpm --filter @avo/api run db:up',
    );
  }

  const tables = scalar(
    "select count(*) from information_schema.tables where table_schema='public' and table_name in ('salon','staff_user','member','wallet_token','idempotency_key')",
  );
  if (tables !== '5') {
    throw new Error(
      'The schema is not migrated — the tenancy suite reads and writes real rows.\n' +
        '  pnpm --filter @avo/api run db:migrate',
    );
  }

  const seeded = scalar(
    `select count(*) from staff_user where id='${A_STAFF_FULL}' and salon_id='${SALON_A}'`,
  );
  if (seeded !== '1') {
    throw new Error(
      `Salon A is not seeded — ${A_STAFF_FULL} is missing, and salon B copies its password hash.\n` +
        '  pnpm --filter @avo/api run db:seed',
    );
  }

  if (!existsSync(apiTsx())) {
    throw new Error(
      'The API\'s dependencies are not installed, so it cannot be started.\n  pnpm install',
    );
  }
}

function apiTsx(): string {
  const candidates = [
    join(repoRoot, 'api', 'node_modules', '.bin', 'tsx'),
    join(repoRoot, 'node_modules', '.bin', 'tsx'),
  ];
  return candidates.find((c) => existsSync(c)) ?? candidates[0]!;
}

// --------------------------------------------------------------- salon B seed --

/**
 * Idempotent. Re-running resets salon B's member balance so a second suite run
 * starts from the same money, exactly as lane A's seed does for Dana.
 *
 * Nothing here touches salon A. If a spec below ever mutates salon A, that is the
 * bug the spec was looking for.
 */
function seedSalonB(): void {
  psql(`
BEGIN;

INSERT INTO salon (id, name, plan, brand_color, module_booking, module_shop, loyalty_mode,
                   tiers, stamp_target, stamp_reward, deposit_fils, no_show_return_minutes,
                   business_hours, social, whatsapp_enabled)
VALUES ('${SALON_B}', 'Lumiere', 'starter', '#7A5C8E', false, false, 'tiers',
        '[{"name":"bronze","minVisits":0,"bonusPercent":0},{"name":"silver","minVisits":4,"bonusPercent":10}]'::jsonb,
        NULL, NULL, 5000, 60,
        '{"morning":["10:00","13:00"],"evening":["16:00","21:00"]}'::jsonb, '[]'::jsonb, false)
ON CONFLICT (id) DO NOTHING;

INSERT INTO branch (id, salon_id, name)
VALUES ('${B_BRANCH}', '${SALON_B}', 'Hawally'),
       ('BR-LUM-JAB', '${SALON_B}', 'Jabriya')
ON CONFLICT (id) DO NOTHING;

INSERT INTO service (id, salon_id, name, price_fils)
VALUES ('${B_SERVICE}', '${SALON_B}', 'Blow-dry', ${B_SERVICE_PRICE_FILS}),
       ('SV-B02', '${SALON_B}', 'Cut', 14000)
ON CONFLICT (id) DO NOTHING;

-- Layla is a MANAGER holding all nine permissions. That is the point: every 403
-- this suite asserts has to come from the salon boundary, never from a missing
-- permission. A restricted principal would make the whole suite pass for the
-- wrong reason.
INSERT INTO staff_user (id, salon_id, name, handle, role, branch_access_all, branch_access_ids,
                        password_hash, pin_hash, pin_device_id,
                        perm_dashboard, perm_appointments, perm_shop, perm_loyalty, perm_team,
                        perm_scanner, perm_charges, perm_void, perm_marketing)
SELECT '${B_STAFF}', '${SALON_B}', 'Layla', '${B_STAFF_HANDLE}', 'manager', true, '{}',
       s.password_hash, s.pin_hash, '${B_SCANNER_DEVICE}',
       true, true, true, true, true, true, true, true, true
FROM staff_user s WHERE s.id = '${A_STAFF_FULL}'
ON CONFLICT (id) DO UPDATE SET
  perm_dashboard = true, perm_appointments = true, perm_shop = true, perm_loyalty = true,
  perm_team = true, perm_scanner = true, perm_charges = true, perm_void = true,
  perm_marketing = true, pin_failed_attempts = 0, pin_locked_until = NULL;

-- Fatima's password hash is copied from the STAFF row, not from salon A's member:
-- hashSecret() is one function for both, so the hash is portable, and salon A's
-- member password is not something this file can know. That gives salon B a
-- member principal that can really sign in — needed for the top-up specs, which
-- prove key scoping and intent scoping without moving anyone's money.
INSERT INTO member (id, salon_id, name, phone, email, email_verified, password_hash,
                    balance_fils, visits, tier, stamps, policy_version)
SELECT '${B_MEMBER}', '${SALON_B}', 'Fatima Al-Rashed', '${B_MEMBER_PHONE}', NULL, false,
       s.password_hash, ${B_MEMBER_BALANCE_FILS}, 2, 'bronze', NULL, 3
FROM staff_user s WHERE s.id = '${A_STAFF_FULL}'
ON CONFLICT (id) DO UPDATE SET
  password_hash = EXCLUDED.password_hash,
  balance_fils = ${B_MEMBER_BALANCE_FILS}, visits = 2, tier = 'bronze', stamps = NULL;

-- A second staff row at salon B with team:false. Used to prove the roster read
-- is salon-scoped and as the TARGET of the escalation specs.
--
-- The conflict branch is not decoration. Those specs assert that a refused
-- PATCH /staff/{id} wrote nothing, which is only a real assertion if the row
-- starts from a known value — and the row survives between runs. It was
-- ON CONFLICT DO NOTHING, and a run against a deliberately broken build (a
-- mutation test removing the surface gate) escalated Mariam for real and left her that
-- way, so the next run's "wrote nothing" spec would have compared a granted
-- permission against a granted permission and passed. Reset the authority
-- columns every time.
INSERT INTO staff_user (id, salon_id, name, handle, role, branch_access_all, branch_access_ids,
                        password_hash, perm_scanner)
SELECT 'ST-B02', '${SALON_B}', 'Mariam', 'mariam', 'frontdesk', false, ARRAY['${B_BRANCH}'],
       s.password_hash, true
FROM staff_user s WHERE s.id = '${A_STAFF_FULL}'
ON CONFLICT (id) DO UPDATE SET
  perm_dashboard = false, perm_appointments = false, perm_shop = false, perm_loyalty = false,
  perm_team = false, perm_scanner = true, perm_charges = false, perm_void = false,
  perm_marketing = false;

-- PIN attempts are rate limited per device+salon. A previous run that failed a
-- sign-in would otherwise lock this suite out of the scanner session.
DELETE FROM pin_attempt WHERE salon_id = '${SALON_B}';
UPDATE staff_user SET pin_failed_attempts = 0, pin_locked_until = NULL WHERE salon_id = '${SALON_B}';

COMMIT;
`);
}

// -------------------------------------------------------------- the API boot --

let child: ChildProcess | undefined;
let base = '';

export function tenancyBaseUrl(): string {
  if (!base) throw new Error('startTenancyApi() has not run.');
  return base;
}

/**
 * The suite's own member at salon A, restored to a known state on every run.
 *
 * Idempotent, and the UPDATE branch is the load-bearing half: the row survives
 * between runs, so what matters is that balance, tier, visits and stamps are put
 * back exactly where the last run found them. Everything the gateway suite
 * asserts is a delta from these numbers.
 *
 * Her password hash is copied from salon A's ST-001 for the reason the salon B
 * seed documents: `hashSecret()` is one function for staff and members, so the
 * hash is portable, and copying it cannot drift out of step with the seed the
 * way a pasted constant would.
 *
 * Old rows are NOT deleted between runs — `transaction`, `ledger_entry`,
 * `receipt_job` and `topup_intent` reference her and are append-only by design.
 * Deleting them would be lying about history to make a test tidy. Every spec
 * scopes its reads to the intent or transaction it just created.
 */
function seedQaMember(): void {
  psql(`
BEGIN;

INSERT INTO member (id, salon_id, name, phone, email, email_verified, password_hash,
                    balance_fils, visits, tier, stamps, policy_version)
SELECT '${QA_MEMBER}', '${SALON_A}', '${QA_MEMBER_NAME}', '${QA_MEMBER_PHONE}',
       '${QA_MEMBER_EMAIL}', true, s.password_hash,
       ${QA_MEMBER_BALANCE_FILS}, ${QA_MEMBER_VISITS}, '${QA_MEMBER_TIER}', NULL, 3
FROM staff_user s WHERE s.id = '${A_STAFF_FULL}'
ON CONFLICT (id) DO UPDATE SET
  password_hash  = EXCLUDED.password_hash,
  email          = EXCLUDED.email,
  email_verified = true,
  balance_fils   = ${QA_MEMBER_BALANCE_FILS},
  visits         = ${QA_MEMBER_VISITS},
  tier           = '${QA_MEMBER_TIER}',
  stamps         = NULL;

COMMIT;
`);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

export async function startTenancyApi(): Promise<void> {
  preflight();
  seedSalonB();
  seedQaMember();

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  let output = '';

  child = spawn(apiTsx(), ['src/server.ts'], {
    cwd: join(repoRoot, 'api'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      DATABASE_URL:
        process.env.DATABASE_URL ?? `postgres://avo:avo_dev_password@127.0.0.1:5433/${PG_DB}`,
      APP_DATABASE_URL:
        process.env.APP_DATABASE_URL ??
        `postgres://avo_app:avo_app_dev_password@127.0.0.1:5433/${PG_DB}`,
      // Fixed so a restart inside one run does not invalidate a token mid-suite.
      JWT_SECRET: process.env.JWT_SECRET ?? 'tenancy-suite-signing-key-not-a-secret-0123456789',
      // Only so salon A's member can mint a wallet token without her password.
      // See the file header — every salon B request is a real session.
      AVO_TEST_PRINCIPALS: '1',
      // Pinned so the suite can produce a VALID signature as well as bad ones.
      // env.ts would otherwise generate one per boot. See GATEWAY_WEBHOOK_SECRET.
      GATEWAY_WEBHOOK_SECRET,
      GATEWAY_WEBHOOK_TOLERANCE_SECONDS: String(GATEWAY_WEBHOOK_TOLERANCE_SECONDS),
      // The sandbox's hosted page fires its callback at this base URL from
      // inside the API process. Pinned to the ephemeral port this boot chose,
      // rather than left to env.ts's `http://localhost:${PORT}` default.
      PUBLIC_BASE_URL: base,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (c: Buffer) => (output += c.toString()));
  child.stderr?.on('data', (c: Buffer) => (output += c.toString()));

  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await fetch(`${base}/_health`);
      if (res.ok && ((await res.json()) as { ok?: boolean }).ok === true) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() >= deadline) {
      child.kill('SIGKILL');
      throw new Error(
        `Lane A's API never became healthy at ${base}/_health.\n` +
          `--- server output ---\n${output || '(nothing on stdout/stderr)'}\n---------------------`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

export async function stopTenancyApi(): Promise<void> {
  if (!child) return;
  child.kill('SIGTERM');
  const exited = new Promise<void>((r) => child?.once('exit', () => r()));
  await Promise.race([exited, new Promise((r) => setTimeout(r, 3_000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
  child = undefined;
}

// ------------------------------------------------------------- the HTTP call --

export interface TenancyResponse<T = any> {
  status: number;
  body: T;
  raw: string;
}

export interface TenancyRequest {
  /** A real access token. `null` is only for the deliberately anonymous specs. */
  token?: string | null;
  body?: unknown;
  idempotencyKey?: string;
  /** `x-avo-scenario`. Drives the sandbox gateway's outcome and the test shim. */
  scenario?: string;
  /** Anything else. Used for `x-avo-signature`. */
  headers?: Record<string, string>;
  /**
   * Send this EXACT string as the request body.
   *
   * Not a convenience. `api/src/routes/webhooks.ts` verifies the MAC against the
   * raw bytes it received, which is the only construction that means anything —
   * re-encoding JSON before hashing is how a verification passes while verifying
   * a different document than the one that was signed. A `body` that this client
   * stringifies could differ from the string the test signed by a space, and the
   * tampering spec below could then pass for the wrong reason.
   */
  rawBody?: string;
}

export async function treq<T = any>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  options: TenancyRequest = {},
): Promise<TenancyResponse<T>> {
  if (options.token === undefined) {
    // The trap this guards: with AVO_TEST_PRINCIPALS on, a request with no
    // Authorization header is not anonymous — it resolves to salon A's ST-001.
    // A salon B spec that forgot its token would quietly test salon A against
    // itself and pass. Anonymity has to be asked for.
    throw new Error(
      `treq(${method} ${path}) was given no token. Pass a real one, or token: null to be anonymous.`,
    );
  }

  if (options.body !== undefined && options.rawBody !== undefined) {
    throw new Error(`treq(${method} ${path}) was given both body and rawBody. Pick one.`);
  }

  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
  if (options.scenario) headers['x-avo-scenario'] = options.scenario;
  if (options.body !== undefined || options.rawBody !== undefined) {
    headers['content-type'] = 'application/json';
  }
  Object.assign(headers, options.headers ?? {});

  const payload =
    options.rawBody !== undefined
      ? options.rawBody
      : options.body === undefined
        ? undefined
        : JSON.stringify(options.body);

  const res = await fetch(`${tenancyBaseUrl()}${path}`, {
    method,
    headers,
    ...(payload === undefined ? {} : { body: payload }),
  });

  const raw = await res.text();
  let body: unknown;
  try {
    body = raw === '' ? null : JSON.parse(raw);
  } catch {
    body = raw;
  }
  return { status: res.status, body: body as T, raw };
}

// ------------------------------------------------------------------ sign-ins --

interface SessionResponse {
  accessToken?: string;
  error?: string;
  message?: string;
}

/** `POST /auth/web/session` — username + password, `dashboard` scope. */
export async function signInDashboard(salonId: string, handle: string): Promise<string> {
  const res = await treq<SessionResponse>('POST', '/auth/web/session', {
    token: null,
    body: { salonId, username: handle, password: STAFF_PASSWORD },
  });
  if (res.status !== 200 || !res.body.accessToken) {
    throw new Error(
      `Web sign-in failed for ${handle}@${salonId}: ${res.status} ${res.raw}\n` +
        'Salon B copies salon A\'s password hash, so this means the seed password in ' +
        'api/src/db/seed.ts changed. Update STAFF_PASSWORD in this file, or re-run ' +
        'pnpm --filter @avo/api run db:seed.',
    );
  }
  return res.body.accessToken;
}

/** `POST /staff/session` — device-scoped PIN, `scanner` scope. */
export async function signInScanner(
  salonId: string,
  handle: string,
  deviceId: string,
): Promise<string> {
  const res = await treq<SessionResponse>('POST', '/staff/session', {
    token: null,
    body: { salonId, handle, deviceId, pin: STAFF_PIN },
  });
  if (res.status !== 200 || !res.body.accessToken) {
    throw new Error(
      `PIN sign-in failed for ${handle}@${salonId} on ${deviceId}: ${res.status} ${res.raw}\n` +
        'Salon B copies salon A\'s pin hash; check STAFF_PIN against api/src/db/seed.ts.',
    );
  }
  return res.body.accessToken;
}

/** `POST /auth/member/session` — salon + phone + password, `wallet` scope. */
export async function signInMember(salonId: string, phone: string): Promise<string> {
  const res = await treq<SessionResponse>('POST', '/auth/member/session', {
    token: null,
    body: { salonId, phone, password: STAFF_PASSWORD },
  });
  if (res.status !== 200 || !res.body.accessToken) {
    throw new Error(`Member sign-in failed for ${phone}@${salonId}: ${res.status} ${res.raw}`);
  }
  return res.body.accessToken;
}

/**
 * A genuine, live wallet token for salon A's member.
 *
 * A real row in `wallet_token`: sha256 of the value, 45 second expiry, single
 * use at charge time. Only the sign-in is shimmed — see the file header.
 */
export async function mintSalonAWalletToken(): Promise<string> {
  const res = await treq<{ token?: string; memberId?: string }>(
    'GET',
    '/members/me/wallet-token',
    { token: null },
  );
  if (res.status !== 200 || !res.body.token) {
    throw new Error(`Could not mint salon A's wallet token: ${res.status} ${res.raw}`);
  }
  if (res.body.memberId !== A_MEMBER) {
    throw new Error(
      `The wallet token was minted for ${res.body.memberId}, not salon A's member ${A_MEMBER}.`,
    );
  }
  return res.body.token;
}

// ---------------------------------------------------------- the route scanner --

export interface DiscoveredRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** As registered, e.g. `/v1/salons/:id/campaigns`. */
  path: string;
  file: string;
}

/**
 * Every route lane A registers whose path carries a salon id.
 *
 * This is the mechanism behind the gap ledger. The ledger does not hold a list a
 * human has to remember to extend; it reads `api/src/routes/*.ts` and probes
 * whatever it finds, so a salon-scoped route added next month is tested the day
 * it lands, guarded or not.
 */
export function discoverSalonScopedRoutes(): DiscoveredRoute[] {
  const dir = join(repoRoot, 'api', 'src', 'routes');
  const found: DiscoveredRoute[] = [];
  // `app.get<{ Params: { id: string } }>('/salons/:id', …)` — the generic sits
  // between the method and the paren, and never contains a `(`.
  const re = /app\.(get|post|put|patch|delete)[^(]*\(\s*'([^']+)'/g;

  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const source = readFileSync(join(dir, file), 'utf8');
    for (const m of source.matchAll(re)) {
      const path = m[2]!;
      if (!/\/salons\/:/.test(path)) continue;
      found.push({
        method: m[1]!.toUpperCase() as DiscoveredRoute['method'],
        path,
        file: `api/src/routes/${file}`,
      });
    }
  }
  return found.sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));
}
