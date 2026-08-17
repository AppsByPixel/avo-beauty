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
/** Salon A's seeded happy hour — `api/src/db/seed.ts`. All branches, x2visit, ON. */
export const A_HAPPY_HOUR = 'HH-01';

/** The second salon, seeded by this file and by nothing else. */
export const SALON_B = 'SAL-LUMIERE';
export const B_MEMBER = '9001';
export const B_MEMBER_PHONE = '+96599555001';
export const B_STAFF = 'ST-B01';
export const B_STAFF_HANDLE = 'layla';
export const B_BRANCH = 'BR-LUM-HAW';
export const B_SERVICE = 'SV-B01';
export const B_SERVICE_PRICE_FILS = 7_000;
/**
 * Salon B's customer, reset to this on every run.
 *
 * DELIBERATELY SEVERAL TIMES WHAT A RUN SPENDS. It was 30.000 — four blow-dries —
 * which was ample while salon B only appeared in tenancy specs that refuse before
 * they ever reach the money. `scanner.test.ts` settles a dozen charges against
 * her, the fifth answered `402 insufficient_balance`, and nine specs then failed
 * on a precondition — none of them about balances.
 *
 * Same shelf-life problem `money.test.ts` documents on `FLOOR_FILS`, same fix.
 * The suites assert DELTAS, so the absolute figure is free; what it must not be
 * is tight enough to run out half way, because that failure is loud, misleading,
 * and lands on whichever spec happens to be next.
 */
export const B_MEMBER_BALANCE_FILS = 500_000;
export const B_SCANNER_DEVICE = 'DEV-SCANNER-B';

// --------------------------------------------------- the scanner's own fixtures --

/**
 * Three more staff rows at salon B, added for `scanner.test.ts`. Each exists
 * because a scanner spec would otherwise have to damage a row another spec needs.
 *
 * B_STAFF_RESTRICTED — Noor. A REAL PIN on a REAL device, `scanner` on,
 *   `charges` and `void` OFF. This is the shape of the locked screen in
 *   design/AVO Staff Scanner.dc.html: someone who can take payment and cannot
 *   review or reverse one. Salon B's existing restricted row (Mariam, ST-B02)
 *   could not do the job — she has no `pin_hash`, so she can never hold a scanner
 *   session, and a 403 you cannot reach is not a 403 you can test.
 *
 * B_STAFF_LOCKOUT — Huda. Exists to be locked out, on her own device. The lockout
 *   spec burns five failures and leaves `pin_locked_until` fifteen minutes in the
 *   future; doing that to Layla would sign the rest of the suite out of the
 *   scanner, and doing it to Noor would break the permission specs.
 *
 * B_STAFF_RATELIMIT — Dalal. Exists so the DEVICE rate limit can be proved
 *   without locking any account. Her device takes ten failures against handles
 *   that do not exist, which walks the per-device counter without touching a
 *   single account's counter — the rotating-handle attack the device limit is
 *   there to stop.
 *
 * All three are reset to a known state on every run, for the reason the ST-B02
 * conflict branch below documents: a spec that asserts "nothing changed" is only
 * a real assertion if the row started somewhere known.
 */
export const B_STAFF_RESTRICTED = 'ST-B03';
export const B_STAFF_RESTRICTED_HANDLE = 'noor';
export const B_RESTRICTED_DEVICE = 'DEV-SCANNER-B-RESTRICTED';

export const B_STAFF_LOCKOUT = 'ST-B04';
export const B_STAFF_LOCKOUT_HANDLE = 'huda';
export const B_LOCKOUT_DEVICE = 'DEV-SCANNER-B-LOCKOUT';

export const B_STAFF_RATELIMIT = 'ST-B05';
export const B_STAFF_RATELIMIT_HANDLE = 'dalal';
export const B_RATELIMIT_DEVICE = 'DEV-SCANNER-B-RATELIMIT';

// -------------------------------------------------- salon B's happy hours --

/**
 * TWO happy hours at salon B, and the second one exists purely to be destroyed.
 *
 * The tenancy ledger drives every salon-scoped route twice: once at salon A's id,
 * where it must 403, and once at salon B's own id, where it must SUCCEED. That
 * control is the half that proves the 403 came from tenancy rather than from a
 * route that is broken shut — and it means the ledger really performs each write.
 *
 * For `PATCH …/happy-hours/{hid}` that needs a window at salon B to edit.
 * For `DELETE …/happy-hours/{hid}` it needs one it may actually delete, and the
 * control genuinely deletes it — so a fixed fixture would work on the first run
 * of the day and 404 on every run after. `B_HAPPY_HOUR_DISPOSABLE` is re-created
 * by this seed on every run for exactly that reason.
 *
 * They are kept OFF (`on: false`). A live happy hour at salon B would silently
 * change what `POST /charges` does in `scanner.test.ts`, which asserts a plain
 * 7.000 debit — a promotion is precisely the sort of thing that turns a money
 * literal into a lie about which fixtures happened to be enabled.
 */
export const B_HAPPY_HOUR = 'HH-B01';
export const B_HAPPY_HOUR_DISPOSABLE = 'HH-B02';

/** The PIN every salon B row shares, copied from salon A's hash. */
export const B_STAFF_PIN = '2468';
/** A four-digit PIN that is not `B_STAFF_PIN`. Used for the failure paths. */
export const B_WRONG_PIN = '1111';

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

// ------------------------------------------------------------------- the PIN --

/**
 * The PIN controls, pinned rather than inherited. See the API boot below for why.
 * api-contract.md § StaffUser: "rate-limit it, lock after N failures".
 */
export const PIN_MAX_ATTEMPTS = 5;
export const PIN_DEVICE_ATTEMPTS_PER_WINDOW = 10;
export const PIN_LOCKOUT_MINUTES = 15;
export const PIN_DEVICE_WINDOW_MINUTES = 5;

// -------------------------------------------------------------- the receipts --

/**
 * The worker's poll interval under test. Short so a spec that waits for a queued
 * job to be sent waits a second rather than the 2s production default times a
 * retry.
 */
export const RECEIPT_POLL_MS = 250;

/** Whether the API under test runs the receipt worker. See the boot env below. */
export const RECEIPT_WORKER_ENABLED = (process.env.RECEIPT_WORKER_ENABLED ?? '1') === '1';

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

/**
 * LANE D'S OWN DATABASE, AND IT IS NOT TIDINESS.
 *
 * This used to be `avo` — the database every lane shares. `api/src/db/seed.ts`
 * clears the transient money-path state to make a run repeatable, and among the
 * tables it clears is `session`:
 *
 *     DELETE FROM receipt_job / ledger_entry / idempotency_key / wallet_token
 *     DELETE FROM gateway_event / topup_intent / transaction
 *     DELETE FROM session          ← this one
 *     DELETE FROM pin_attempt
 *
 * That is correct for a seed and hostile to a suite running beside it. Every file
 * driven by this harness signs in for real in `beforeAll` and holds a bearer token
 * for the length of the run. Another lane running `pnpm --filter @avo/api run
 * db:seed` mid-suite deletes the session row behind that token, and because
 * `resolvePrincipal` checks `sessionIsLive` on every request, the very next call
 * answers 401 while the JWT itself is still minutes from expiry. It cost lane B
 * real time reading that as a client bug, which is exactly what it looks like.
 *
 * The transaction and wallet_token deletes are the same hazard one level quieter:
 * a spec holding a charge id or a live QR token has it removed underneath it.
 *
 * So this suite gets its own database on the same container. Nothing else writes
 * here, no other lane's seed can reach it, and lane D can re-seed whenever it
 * likes without taking anyone down. Override with POSTGRES_DB to point the suite
 * back at a shared database deliberately.
 *
 * SETTING IT UP — see `ensureDatabase()` below, which does it automatically and
 * says what it did.
 */
const PG_DB = process.env.POSTGRES_DB ?? 'avo_qa';

/** The maintenance database, for CREATE DATABASE and the existence probe. */
const PG_MAINTENANCE_DB = 'postgres';

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

/**
 * Put a staff row's PIN counters back to zero and clear its device's history.
 *
 * WHY A SPEC THAT COUNTS FAILURES HAS TO CALL THIS.
 *
 * `pin_failed_attempts` is cumulative across a run, and the specs that merely
 * PROVE a wrong PIN is refused leave it incremented — correctly, that is the
 * feature. So a later spec asserting "the fifth failure locks the account" is
 * really asserting "the fifth failure SINCE WHATEVER RAN BEFORE IT", and the
 * scanner suite went red exactly there: two earlier refusal specs had already put
 * Layla on two, so four more locked her on the fifth and the precondition read
 * `5:true after 4 failures`.
 *
 * Resetting makes each counting spec independent of the order the file happens to
 * run in, which it should be regardless. It resets the DEVICE history too: the
 * per-device rate limit counts rows in `pin_attempt`, so a spec that burns
 * failures against a device poisons the next spec that uses it.
 */
export function resetPinState(staffId: string, deviceId?: string): void {
  psql(`
    UPDATE staff_user SET pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = '${staffId}';
    ${deviceId ? `DELETE FROM pin_attempt WHERE device_id = '${deviceId}';` : ''}
  `);
}

/** One scalar against a NAMED database. Used before `PG_DB` is known to exist. */
function scalarOn(database: string, sql: string): string {
  return execFileSync(
    'docker',
    ['exec', '-i', PG_CONTAINER, 'psql', '-U', PG_USER, '-d', database, '-tAc', sql],
    { encoding: 'utf8' },
  ).trim();
}

// ------------------------------------------------------------ the bootstrap --

/**
 * Create lane D's database if it is not there, and leave it migrated and seeded.
 *
 * Idempotent and cheap: after the first run this is one `SELECT` against
 * `pg_database` and two more against the schema.
 *
 * WHY IT CLONES `avo` INSTEAD OF MIGRATING AND SEEDING FROM EMPTY
 * ---------------------------------------------------------------
 * Because the obvious route does not work, and the reason is a defect worth
 * reporting rather than hiding. `api/src/db/seed.ts` inserts in this order:
 *
 *     salon → branch → service → artist → member → staff_user
 *
 * and `artist.staff_user_id` REFERENCES `staff_user`. AR-003 is wired to ST-002,
 * so against a freshly migrated database the seed dies at the artist insert:
 *
 *     ERROR 23503  Key (staff_user_id)=(ST-002) is not present in table "staff_user"
 *
 * It only appears to work on the shared `avo` database because ST-002 was already
 * there from before migration 0007 added the column. So `db:seed` cannot bootstrap
 * a new environment today — a staging database, a CI job, or this one. Lane D does
 * not edit `api/src/db/seed.ts`; the fix is one move of the `staff_user` insert
 * above the `artist` insert, and it is in the lane report.
 *
 * The workaround is a `pg_dump` of the shared database into the new one, which
 * carries the schema, the grants for `avo_app`, and the rows the seed's ordering
 * assumes already exist. Lane A's own seed then runs on top and resets every
 * fixture to its canonical value, so what this ends up with is lane A's seed
 * state and not a snapshot of whatever the shared database had drifted to.
 */
function ensureDatabase(): void {
  const exists =
    scalarOn(PG_MAINTENANCE_DB, `select 1 from pg_database where datname='${PG_DB}'`) === '1';
  if (exists) return;

  // eslint-disable-next-line no-console
  console.log(`[lane D] creating an isolated database "${PG_DB}" — this happens once.`);

  execFileSync(
    'docker',
    [
      'exec', '-i', PG_CONTAINER, 'psql', '-U', PG_USER, '-d', PG_MAINTENANCE_DB,
      '-v', 'ON_ERROR_STOP=1',
      '-c', `CREATE DATABASE ${PG_DB} OWNER ${PG_USER}`,
      // `avo_app` is a CLUSTER-level role, so it already exists; only the
      // per-database CONNECT privilege has to be granted for the new database.
      '-c', `GRANT CONNECT ON DATABASE ${PG_DB} TO avo_app`,
    ],
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  );

  try {
    // Schema, privileges and rows. `ON_ERROR_STOP=1` on the restore side so a
    // half-copied database is a loud failure and not a suite that fails strangely
    // twenty specs later.
    execFileSync(
      'docker',
      [
        'exec', '-i', PG_CONTAINER, 'sh', '-c',
        `pg_dump -U ${PG_USER} -d avo | psql -U ${PG_USER} -d ${PG_DB} -q -v ON_ERROR_STOP=1`,
      ],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message?: string };
    throw new Error(
      `Could not clone the shared "avo" database into "${PG_DB}".\n` +
        'The shared database has to exist and be migrated first:\n' +
        '  pnpm --filter @avo/api run db:up && pnpm --filter @avo/api run db:migrate\n' +
        `--- stderr ---\n${String(e.stderr ?? e.message ?? '')}`,
    );
  }

  reseed();
  // eslint-disable-next-line no-console
  console.log(`[lane D] "${PG_DB}" is ready — lane A's schema, lane A's seed, nobody else's writes.`);
}

/**
 * Run lane A's seed against lane D's database.
 *
 * Exported because it is the recovery move when a fixture has been mangled, and
 * because it is now SAFE to run at any time — the whole point of the isolated
 * database is that this cannot take another lane's session down.
 */
export function reseed(): void {
  runApiDbScript('src/db/seed.ts', PG_DB);
}

/** The two connection strings `api/src/env.ts` wants, pointed at one database. */
function connectionEnv(database: string): Record<string, string> {
  const url = (role: string, password: string) =>
    `postgres://${role}:${password}@127.0.0.1:5433/${database}`;
  return {
    NODE_ENV: 'test',
    DATABASE_URL: url('avo', 'avo_dev_password'),
    APP_DATABASE_URL: url('avo_app', 'avo_app_dev_password'),
  };
}

export interface ApiScriptResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Run one of lane A's database scripts (`db/migrate.ts`, `db/seed.ts`) against a
 * named database, and REPORT rather than throw.
 *
 * The reporting matters. `seed.test.ts` is a suite ABOUT whether the seed
 * succeeds, so it needs the failure as a value it can assert on — a helper that
 * throws would turn "the seed is broken" into a suite that errored, and the two
 * read very differently in a report.
 */
export function runApiDbScriptResult(script: string, database: string): ApiScriptResult {
  try {
    const stdout = execFileSync(apiTsx(), [script], {
      cwd: join(repoRoot, 'api'),
      env: { ...process.env, ...connectionEnv(database) },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout, stderr: '' };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    return {
      ok: false,
      stdout: String(e.stdout ?? ''),
      stderr: String(e.stderr ?? e.message ?? ''),
    };
  }
}

/** The throwing form, for callers that treat a failure as fatal. */
function runApiDbScript(script: string, database: string): void {
  const res = runApiDbScriptResult(script, database);
  if (res.ok) return;
  throw new Error(
    `\`${script}\` failed against "${database}".\n` +
      `--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}`,
  );
}

// ------------------------------------------------ throwaway databases --------

/**
 * Create an EMPTY database, owned by `avo`, with `avo_app` able to connect.
 *
 * Deliberately empty — no clone, no schema. `seed.test.ts` needs a database in
 * the state a brand-new environment is in, which is the state `ensureDatabase()`
 * above goes out of its way to avoid because lane A's seed could not cope with
 * it. That avoidance is a workaround; this is the spec that says so.
 */
export function createEmptyDatabase(database: string): void {
  execFileSync(
    'docker',
    [
      'exec', '-i', PG_CONTAINER, 'psql', '-U', PG_USER, '-d', PG_MAINTENANCE_DB,
      '-v', 'ON_ERROR_STOP=1',
      '-c', `DROP DATABASE IF EXISTS ${database}`,
      '-c', `CREATE DATABASE ${database} OWNER ${PG_USER}`,
      '-c', `GRANT CONNECT ON DATABASE ${database} TO avo_app`,
    ],
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
}

/** Drop a throwaway database. Never throws — this runs in cleanup. */
export function dropDatabase(database: string): void {
  try {
    execFileSync(
      'docker',
      [
        'exec', '-i', PG_CONTAINER, 'psql', '-U', PG_USER, '-d', PG_MAINTENANCE_DB,
        '-c', `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`,
      ],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
  } catch {
    /* a leaked scratch database is untidy, not a failure worth reporting */
  }
}

/** Migrate a named database with lane A's own migrator. */
export function migrateDatabase(database: string): ApiScriptResult {
  return runApiDbScriptResult('src/db/migrate.ts', database);
}

/** Seed a named database with lane A's own seed. */
export function seedDatabase(database: string): ApiScriptResult {
  return runApiDbScriptResult('src/db/seed.ts', database);
}

/** One scalar against a named database, for the scratch-database specs. */
export function scalarOnDatabase(database: string, sql: string): string {
  return scalarOn(database, sql);
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

  if (!existsSync(apiTsx())) {
    throw new Error(
      'The API\'s dependencies are not installed, so it cannot be started.\n  pnpm install',
    );
  }

  // Creates and seeds `PG_DB` the first time, then returns immediately.
  ensureDatabase();

  /**
   * MIGRATE ON EVERY RUN, NOT ONLY AT CREATION.
   *
   * Lane D's database is its own, which is the point — and the cost of that is
   * that lane A's migrations no longer arrive here by somebody else running
   * `db:migrate` on the shared one. This suite went red on
   * `relation "happy_hour" does not exist` the day lane A landed promotions, which
   * is a stale-schema problem wearing a missing-feature costume.
   *
   * `migrate()` is idempotent and skips applied migrations, so this costs a
   * `SELECT` against the journal on every run and removes the whole class.
   */
  const migrated = migrateDatabase(PG_DB);
  if (!migrated.ok) {
    throw new Error(
      `Could not bring "${PG_DB}" up to date with lane A's migrations.\n` +
        `--- stderr ---\n${migrated.stderr}`,
    );
  }

  const tables = scalar(
    "select count(*) from information_schema.tables where table_schema='public' and table_name in ('salon','staff_user','member','wallet_token','idempotency_key')",
  );
  if (tables !== '5') {
    throw new Error(
      `The schema in "${PG_DB}" is not migrated — this suite reads and writes real rows.\n` +
        `  DATABASE_URL=postgres://avo:avo_dev_password@127.0.0.1:5433/${PG_DB} ` +
        'pnpm --filter @avo/api run db:migrate',
    );
  }

  const seeded = scalar(
    `select count(*) from staff_user where id='${A_STAFF_FULL}' and salon_id='${SALON_A}'`,
  );
  if (seeded !== '1') {
    throw new Error(
      `Salon A is not seeded in "${PG_DB}" — ${A_STAFF_FULL} is missing, and salon B copies ` +
        'its password hash. `reseed()` in this file runs lane A\'s seed against lane D\'s database.',
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

-- The scanner suite's three rows. See the constants at the top of this file for
-- why each exists. All three carry a real pin_hash on a device of their own, so
-- each holds a genuine device-bound PIN session and none can disturb another's
-- device counter.
--
-- Noor: scanner ON, charges and void OFF — the locked screen's principal.
INSERT INTO staff_user (id, salon_id, name, handle, role, branch_access_all, branch_access_ids,
                        password_hash, pin_hash, pin_device_id, perm_scanner)
SELECT '${B_STAFF_RESTRICTED}', '${SALON_B}', 'Noor', '${B_STAFF_RESTRICTED_HANDLE}', 'frontdesk',
       true, '{}', s.password_hash, s.pin_hash, '${B_RESTRICTED_DEVICE}', true
FROM staff_user s WHERE s.id = '${A_STAFF_FULL}'
ON CONFLICT (id) DO UPDATE SET
  pin_hash = EXCLUDED.pin_hash, pin_device_id = '${B_RESTRICTED_DEVICE}',
  perm_dashboard = false, perm_appointments = false, perm_shop = false, perm_loyalty = false,
  perm_team = false, perm_scanner = true, perm_charges = false, perm_void = false,
  perm_marketing = false;

-- Huda: exists to be locked out. Full scanner authority, so that when a spec does
-- sign her in, nothing but the lockout can refuse her.
INSERT INTO staff_user (id, salon_id, name, handle, role, branch_access_all, branch_access_ids,
                        password_hash, pin_hash, pin_device_id,
                        perm_scanner, perm_charges, perm_void)
SELECT '${B_STAFF_LOCKOUT}', '${SALON_B}', 'Huda', '${B_STAFF_LOCKOUT_HANDLE}', 'frontdesk',
       true, '{}', s.password_hash, s.pin_hash, '${B_LOCKOUT_DEVICE}', true, true, true
FROM staff_user s WHERE s.id = '${A_STAFF_FULL}'
ON CONFLICT (id) DO UPDATE SET
  pin_hash = EXCLUDED.pin_hash, pin_device_id = '${B_LOCKOUT_DEVICE}',
  perm_scanner = true, perm_charges = true, perm_void = true;

-- Dalal: exists so the per-device rate limit can be walked to its threshold
-- without locking any account.
INSERT INTO staff_user (id, salon_id, name, handle, role, branch_access_all, branch_access_ids,
                        password_hash, pin_hash, pin_device_id, perm_scanner)
SELECT '${B_STAFF_RATELIMIT}', '${SALON_B}', 'Dalal', '${B_STAFF_RATELIMIT_HANDLE}', 'frontdesk',
       true, '{}', s.password_hash, s.pin_hash, '${B_RATELIMIT_DEVICE}', true
FROM staff_user s WHERE s.id = '${A_STAFF_FULL}'
ON CONFLICT (id) DO UPDATE SET
  pin_hash = EXCLUDED.pin_hash, pin_device_id = '${B_RATELIMIT_DEVICE}', perm_scanner = true;

-- Salon B's happy hours. Both OFF, so no promotion is live during the money
-- specs; see the constants at the top of this file.
--
-- The disposable one is DELETEd and re-inserted rather than upserted, because the
-- tenancy ledger's control call really does delete it and a row that survived
-- would make the second run of the day 404.
INSERT INTO happy_hour (id, salon_id, branch_id, days, "from", "to", reward, "on", notify)
VALUES ('${B_HAPPY_HOUR}', '${SALON_B}', NULL, '{0,1,2}', '16:00', '18:00', 'x2visit', false, false)
ON CONFLICT (id) DO UPDATE SET
  branch_id = NULL, days = '{0,1,2}', "from" = '16:00', "to" = '18:00',
  reward = 'x2visit', "on" = false, notify = false;

DELETE FROM happy_hour WHERE id = '${B_HAPPY_HOUR_DISPOSABLE}';
INSERT INTO happy_hour (id, salon_id, branch_id, days, "from", "to", reward, "on", notify)
VALUES ('${B_HAPPY_HOUR_DISPOSABLE}', '${SALON_B}', NULL, '{4}', '10:00', '13:00', 'topup10', false, false);

-- PIN attempts are rate limited per device+salon. A previous run that failed a
-- sign-in would otherwise lock this suite out of the scanner session. It is also
-- what makes the lockout and rate-limit specs repeatable: they COUNT failures, so
-- the counter has to start at zero.
DELETE FROM pin_attempt WHERE salon_id = '${SALON_B}';
UPDATE staff_user SET pin_failed_attempts = 0, pin_locked_until = NULL WHERE salon_id = '${SALON_B}';

COMMIT;
`);
}

// -------------------------------------------------------------- the API boot --

let child: ChildProcess | undefined;
let base = '';

/**
 * Everything the API has written to stdout and stderr this run, and whether it is
 * still alive.
 *
 * WHY THE SUITE KEEPS THIS AFTER STARTUP.
 * It used to be a local in `startTenancyApi`, used once for the "never became
 * healthy" message and then dropped. When the API died MID-RUN instead — which it
 * did, and which is how this was written — every remaining spec failed with
 * `ECONNREFUSED 127.0.0.1:<ephemeral port>` and nothing else. Twelve red specs, no
 * stack, no reason, and the reason had been printed to a stream nobody was
 * holding on to.
 *
 * A suite that boots its own server owns that server's output. `treq` checks this
 * on a connection failure and reports the crash instead of the symptom.
 */
let apiOutput = '';
let apiExit: { code: number | null; signal: string | null } | undefined;

export function tenancyBaseUrl(): string {
  if (!base) throw new Error('startTenancyApi() has not run.');
  return base;
}

/** The API's own account of why it is not answering. */
function apiPostMortem(): string {
  if (!apiExit) {
    return 'The API process is still running, so this is a connection problem rather than a crash.';
  }
  const how =
    apiExit.signal !== null
      ? `killed by ${apiExit.signal}`
      : `exited with code ${apiExit.code}`;
  return (
    `THE API UNDER TEST IS GONE — it ${how} part-way through the run, so every spec ` +
    'after that point fails on the connection rather than on its own assertion.\n' +
    `--- the API's last output ---\n${apiOutput.slice(-4000) || '(nothing on stdout/stderr)'}\n` +
    '-----------------------------'
  );
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
  apiOutput = '';
  apiExit = undefined;

  child = spawn(apiTsx(), ['src/server.ts'], {
    cwd: join(repoRoot, 'api'),
    /**
     * ITS OWN PROCESS GROUP — this is a fix, not a flourish.
     *
     * Vitest runs each test file in its own forked worker and tears the worker
     * down afterwards. Spawned without `detached`, the API joins that worker's
     * process group, so the teardown's signal reaches it too — and
     * `api/src/server.ts` handles SIGTERM by closing the server and calling
     * `process.exit(0)`.
     *
     * The result was the worst kind of failure: an API that vanished part-way
     * through a multi-file run, cleanly, with exit code 0 and nothing on stderr,
     * taking thirteen specs with it. Running one file at a time it never happened,
     * so it looked like flakiness in whichever suite drew the short straw.
     *
     * `detached: true` makes the child a group leader of its own, out of reach of
     * a signal aimed at the worker. It now lives and dies only by
     * `stopTenancyApi()` below.
     */
    detached: true,
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

      // --------------------------------------------------------- the PIN --
      // Pinned for the same reason as GATEWAY_WEBHOOK_SECRET above: the scanner
      // suite asserts "the FIFTH failure locks the account" and "the ELEVENTH
      // attempt from a device is refused", and those are only literals if the
      // thresholds are. Inherited from env.ts's defaults they are assertions
      // about whatever lane A last chose.
      //
      // The two numbers are deliberately different. Account lockout at 5 fires
      // before the device limit at 10 when an attacker hammers ONE handle; the
      // device limit is what catches the attacker who rotates handles to keep
      // every individual account counter below its threshold. A suite that set
      // them equal could not tell the two controls apart.
      PIN_MAX_ATTEMPTS: String(PIN_MAX_ATTEMPTS),
      PIN_DEVICE_ATTEMPTS_PER_WINDOW: String(PIN_DEVICE_ATTEMPTS_PER_WINDOW),
      PIN_LOCKOUT_MINUTES: String(PIN_LOCKOUT_MINUTES),
      PIN_DEVICE_WINDOW_MINUTES: String(PIN_DEVICE_WINDOW_MINUTES),

      // ---------------------------------------------------- the receipts --
      // ON, and this is the re-pin lane A asked for.
      //
      // env.ts defaults RECEIPT_WORKER_ENABLED to '0' and says why: lane D's
      // gateway suite asserted `receipt_job.status = 'queued'` with the note
      // "the worker has not run", so starting the worker flipped that spec red
      // for the opposite reason to the one it was testing. Lane A built the
      // worker and left it off rather than edit another lane's spec.
      //
      // The assertion has been restated — see gateway.test.ts, "the receipts
      // block" — against what the money transaction actually guarantees rather
      // than against the worker being absent. So the worker runs here, the
      // outbox is drained end to end, and lane A can flip the default in env.ts.
      RECEIPT_WORKER_ENABLED: process.env.RECEIPT_WORKER_ENABLED ?? '1',
      // Fast enough that a spec can wait for a send without a long timeout.
      RECEIPT_POLL_MS: String(RECEIPT_POLL_MS),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (c: Buffer) => (apiOutput += c.toString()));
  child.stderr?.on('data', (c: Buffer) => (apiOutput += c.toString()));
  child.on('exit', (code, signal) => {
    apiExit = { code, signal };
  });

  /**
   * THE OTHER HALF OF `detached`.
   *
   * A detached child outlives its parent, which is the point — and also the risk.
   * If a suite dies before `afterAll` (a crash, a Ctrl-C, a vitest timeout) the
   * API would be left running, holding a database connection and a port, and the
   * next run would find a stranger's server on it. So the worker kills it on the
   * way out, however it goes out.
   */
  const reap = () => {
    if (child && child.exitCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  };
  process.once('exit', reap);
  process.once('SIGINT', reap);
  process.once('SIGTERM', reap);

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
          `--- server output ---\n${apiOutput || '(nothing on stdout/stderr)'}\n---------------------`,
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

  let res: Response;
  try {
    res = await fetch(`${tenancyBaseUrl()}${path}`, {
      method,
      headers,
      ...(payload === undefined ? {} : { body: payload }),
    });
  } catch (err) {
    // An ECONNREFUSED here is almost always the API having died earlier, not a
    // networking problem. Say which, and say what it printed on the way out.
    throw new Error(
      `${method} ${path} could not reach the API at ${tenancyBaseUrl()}.\n` +
        `${apiPostMortem()}\n` +
        `--- the fetch error ---\n${String((err as Error)?.message ?? err)}`,
    );
  }

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

export interface SessionResponse {
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

/**
 * `POST /staff/session` WITHOUT the success expectation — the raw response.
 *
 * `signInScanner` above throws on anything but a 200, which is right for a
 * `beforeAll` and useless for the specs that are ABOUT the refusals. This is the
 * same call with the outcome left to the caller, so a spec can assert the status,
 * the error code and the copy on a wrong PIN, a wrong device, a locked account or
 * a rate-limited device.
 */
export async function attemptScannerSignIn(params: {
  salonId: string;
  handle: string;
  deviceId: string;
  pin: unknown;
}): Promise<TenancyResponse<SessionResponse & { staff?: { id: string } }>> {
  return treq('POST', '/staff/session', {
    token: null,
    body: {
      salonId: params.salonId,
      handle: params.handle,
      deviceId: params.deviceId,
      pin: params.pin,
    },
  });
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

/**
 * A live wallet token for a member who signed in for real.
 *
 * The authentic version of the helper above: no shim anywhere in the path, the
 * customer holds a `wallet`-scope bearer token and asks for her own QR. This is
 * what the scanner suite uses, because a scan is the moment two real principals
 * meet — the customer's token and the staff member's PIN session — and shimming
 * either of them would take the meeting out of the test.
 */
export async function mintWalletTokenFor(
  walletToken: string,
  expectMemberId: string,
): Promise<string> {
  const res = await treq<{ token?: string; memberId?: string }>(
    'GET',
    '/members/me/wallet-token',
    { token: walletToken },
  );
  if (res.status !== 200 || !res.body.token) {
    throw new Error(`Could not mint a wallet token for ${expectMemberId}: ${res.status} ${res.raw}`);
  }
  if (res.body.memberId !== expectMemberId) {
    throw new Error(
      `The wallet token was minted for ${res.body.memberId}, not ${expectMemberId}. ` +
        'That means the session used here belongs to somebody else.',
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
