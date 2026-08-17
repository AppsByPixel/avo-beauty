/**
 * Environment. Parsed once, at startup, so a missing connection string is a
 * boot failure with a name attached rather than an undefined halfway through a
 * charge.
 *
 * Two connection strings, on purpose:
 *
 *   DATABASE_URL      owner / migrator. Runs DDL. Not used to serve requests.
 *   APP_DATABASE_URL  the `avo_app` role. Serves every request. NOT the table
 *                     owner, which is the only reason the REVOKE on audit_log
 *                     in migration 0001 means anything — an owner can always
 *                     update its own tables.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Owner connection. Migrations only. */
  DATABASE_URL: z.string().url(),
  /** Application connection. Falls back to DATABASE_URL only outside production. */
  APP_DATABASE_URL: z.string().url().optional(),

  PORT: z.coerce.number().int().positive().default(3000),

  /**
   * HS256 signing key for access tokens. Access tokens live minutes and are not
   * stored, so rotating this key signs out the access tier globally — refresh
   * tokens survive it, because they are database rows rather than signatures.
   */
  JWT_SECRET: z.string().min(32).optional(),

  /** Minutes. Short by design: perms are re-read per request, but scope is not. */
  ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  /** Days. The refresh row is revocable, so this can be generous. */
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  /** Failed PINs before the account locks. api-contract.md: "lock after N failures". */
  PIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  /** Minutes the account stays locked once N is hit. */
  PIN_LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15),
  /** Attempts allowed from one device+salon inside the window, whoever they target. */
  PIN_DEVICE_ATTEMPTS_PER_WINDOW: z.coerce.number().int().positive().default(10),
  PIN_DEVICE_WINDOW_MINUTES: z.coerce.number().int().positive().default(5),

  /**
   * TEST AFFORDANCE — off unless explicitly set, and refused outright in
   * production (see the assertion below).
   *
   * Lane D's e2e suite selects its principal with an `x-avo-scenario` header and
   * sends no credentials, because it was written against packages/mock. With
   * this flag on, an unauthenticated request resolves to a seeded principal so
   * those specs can drive this API unchanged. It is a harness shim, NOT an auth
   * bypass that ships: every gate below it — permissions, scopes, the money
   * rules — runs exactly as it does for a real session.
   */
  AVO_TEST_PRINCIPALS: z
    .enum(['0', '1'])
    .default('0')
    .transform((v) => v === '1'),

  // ------------------------------------------------------------- gateway --
  //
  // PSP selection is a client decision that has not been made (CLAUDE.md
  // § Escalate, don't guess). The gateway sits behind an interface with a
  // sandbox driver; choosing the real one later is this variable plus one
  // adapter in src/gateway/. `sandbox` is refused in production below.
  GATEWAY_DRIVER: z.enum(['sandbox']).default('sandbox'),

  /**
   * HMAC-SHA256 key the PSP signs its callbacks with.
   *
   * A webhook that trusts its payload is an unauthenticated credit endpoint, so
   * this is not optional in production. Outside production a missing key is
   * generated per boot — the sandbox driver signs and verifies with the same
   * process, so the round trip still works, and a developer who forgets to set
   * one gets callbacks that stop verifying at restart rather than a well-known
   * default that reaches an environment where it matters.
   */
  GATEWAY_WEBHOOK_SECRET: z.string().min(16).optional(),
  /** Seconds a signed callback stays acceptable. Replay window, keep it small. */
  GATEWAY_WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().positive().default(300),
  /** Milliseconds. A gateway that has not answered by now has not answered. */
  GATEWAY_TIMEOUT_MS: z.coerce.number().int().positive().default(8_000),

  /** Where the PSP's hosted page lives, for the sandbox. Absolute. */
  PUBLIC_BASE_URL: z.string().url().optional(),
  /** api-contract.md § TopUpIntent: the gateway returns the customer here. */
  TOPUP_RETURN_URL: z.string().default('avo://topup/return'),

  // ------------------------------------------------------------ receipts --
  //
  // Neither channel can be wired yet and neither is waiting on us:
  // design/whatsapp-templates.md says the four templates are unapproved
  // ("approval is not instant"), and CLAUDE.md § Escalate lists "whether
  // receipts send from AVO's domain or per-salon subdomains" as an open client
  // decision — which is what decides the sending domain's SPF/DKIM records. So
  // the only driver is `logging`, behind the same seam as the gateway.
  RECEIPT_DRIVER: z.enum(['logging']).default('logging'),

  /**
   * THE WORKER IS ON BY DEFAULT. It was off, and the reason was coordination
   * rather than caution; the coordination has happened.
   *
   * WHAT THE OLD ASSERTION SAID, AND WHY IT BLOCKED THIS
   * ----------------------------------------------------
   * Lane D's gateway suite used to end a spec with:
   *
   *     expect(scalar(`select status from receipt_job ...`),
   *       'the receipt was marked sent inside the money transaction —
   *        the worker has not run').toBe('queued')
   *
   * Running the worker against the same database flips `queued` to `sent` a poll
   * interval later and fails that — for the OPPOSITE reason to the one it was
   * testing. Turning the flag on was therefore a change to another lane's spec,
   * which CLAUDE.md does not allow from inside this one. So the worker was
   * built, exercised and switchable, and left off.
   *
   * WHY IT NO LONGER DOES
   * ---------------------
   * Lane D restated it, and the correction is worth keeping: "the worker has not
   * run" was never the invariant. It was an assumption about the environment
   * that happened to hold. The invariant db/schema/receipt.ts exists for is that
   * THE MONEY TRANSACTION QUEUES THE RECEIPT AND DOES NOT SEND IT — because an
   * HTTP call inside the charge transaction holds row locks for the length of a
   * third party's timeout, and turns a WhatsApp outage into a
   * card-declined-at-the-counter outage.
   *
   * That is now asserted as the one state a queued send can never reach: `sent`
   * with `attempts = 0`. `attempts` is incremented in exactly one place in this
   * system — `claimJobs()` in services/receiptWorker.ts — so a `sent` row that
   * was never claimed is the signature of a send that bypassed the queue. True
   * whether the worker runs or not, which is what the old literal could not say.
   * (`processJob` hands an attempt back for a channel its driver does not
   * handle, and sets the row to `queued` when it does, never `sent` — so that
   * path cannot forge the signature either.)
   *
   * A process that serves requests should drain its own outbox; leaving this off
   * meant a production deploy queued receipts nobody sent. `server.ts` starts
   * the worker, `buildApp()` does not, so a test that constructs handlers still
   * gets a still outbox. Set `RECEIPT_WORKER_ENABLED=0` to hold one deliberately.
   */
  RECEIPT_WORKER_ENABLED: z
    .enum(['0', '1'])
    .default('1')
    .transform((v) => v === '1'),

  /** Milliseconds between passes, measured from the END of the previous one. */
  RECEIPT_POLL_MS: z.coerce.number().int().positive().default(2_000),
  /** Jobs claimed per pass. This is the concurrency control — see the worker. */
  RECEIPT_BATCH_SIZE: z.coerce.number().int().positive().max(500).default(20),
  /** Tries before a job is parked as a dead letter and audited. */
  RECEIPT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(6),
  /** First backoff step. Doubles per attempt, then full-jittered. */
  RECEIPT_BACKOFF_BASE_MS: z.coerce.number().int().positive().default(5_000),
  RECEIPT_BACKOFF_MAX_MS: z.coerce.number().int().positive().default(15 * 60_000),
  /**
   * How long a claimed job stays claimed. A worker that dies mid-send leaves the
   * row in `sending`; once this elapses the claim query takes it back. Long
   * enough to exceed any sane provider timeout, short enough that a crash does
   * not delay a receipt by more than a couple of minutes.
   */
  RECEIPT_LEASE_MS: z.coerce.number().int().positive().default(120_000),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment:\n${issues}`);
}

const raw = parsed.data;

if (raw.NODE_ENV === 'production' && !raw.APP_DATABASE_URL) {
  throw new Error(
    'APP_DATABASE_URL is required in production. Serving requests as the table owner ' +
      'would silently undo the append-only guarantee on audit_log.',
  );
}

if (raw.NODE_ENV === 'production' && raw.AVO_TEST_PRINCIPALS) {
  throw new Error(
    'AVO_TEST_PRINCIPALS resolves unauthenticated requests to a seeded principal. ' +
      'It is a test harness shim and must never be set in production.',
  );
}

if (raw.NODE_ENV === 'production' && !raw.JWT_SECRET) {
  throw new Error('JWT_SECRET is required in production.');
}

if (raw.NODE_ENV === 'production' && raw.GATEWAY_DRIVER === 'sandbox') {
  throw new Error(
    'GATEWAY_DRIVER=sandbox settles payments nobody paid for. Select a real ' +
      'processor before production — see CLAUDE.md § Escalate, don\'t guess.',
  );
}

if (raw.NODE_ENV === 'production' && !raw.GATEWAY_WEBHOOK_SECRET) {
  throw new Error(
    'GATEWAY_WEBHOOK_SECRET is required in production. Without it the webhook ' +
      'cannot verify a signature, and an unverified webhook is an ' +
      'unauthenticated credit endpoint.',
  );
}

/**
 * Outside production a missing secret is generated per boot. That is deliberate:
 * a developer who forgets to set one gets tokens that stop working at restart,
 * rather than a well-known default that quietly reaches an environment where it
 * matters.
 */
const jwtSecret =
  raw.JWT_SECRET ??
  (raw.NODE_ENV === 'production' ? '' : randomUUID() + randomUUID());

/** Same reasoning as `jwtSecret`: generated per boot outside production. */
const gatewayWebhookSecret =
  raw.GATEWAY_WEBHOOK_SECRET ??
  (raw.NODE_ENV === 'production' ? '' : randomUUID() + randomUUID());

export const env = {
  nodeEnv: raw.NODE_ENV,
  databaseUrl: raw.DATABASE_URL,
  appDatabaseUrl: raw.APP_DATABASE_URL ?? raw.DATABASE_URL,
  port: raw.PORT,
  jwtSecret,
  accessTokenTtlMinutes: raw.ACCESS_TOKEN_TTL_MINUTES,
  refreshTokenTtlDays: raw.REFRESH_TOKEN_TTL_DAYS,
  pinMaxAttempts: raw.PIN_MAX_ATTEMPTS,
  pinLockoutMinutes: raw.PIN_LOCKOUT_MINUTES,
  pinDeviceAttemptsPerWindow: raw.PIN_DEVICE_ATTEMPTS_PER_WINDOW,
  pinDeviceWindowMinutes: raw.PIN_DEVICE_WINDOW_MINUTES,
  testPrincipals: raw.AVO_TEST_PRINCIPALS,
  gatewayDriver: raw.GATEWAY_DRIVER,
  gatewayWebhookSecret,
  gatewayWebhookToleranceSeconds: raw.GATEWAY_WEBHOOK_TOLERANCE_SECONDS,
  gatewayTimeoutMs: raw.GATEWAY_TIMEOUT_MS,
  publicBaseUrl: raw.PUBLIC_BASE_URL ?? `http://localhost:${raw.PORT}`,
  topupReturnUrl: raw.TOPUP_RETURN_URL,
  receiptDriver: raw.RECEIPT_DRIVER,
  receiptWorkerEnabled: raw.RECEIPT_WORKER_ENABLED,
  receiptPollMs: raw.RECEIPT_POLL_MS,
  receiptBatchSize: raw.RECEIPT_BATCH_SIZE,
  receiptMaxAttempts: raw.RECEIPT_MAX_ATTEMPTS,
  receiptBackoffBaseMs: raw.RECEIPT_BACKOFF_BASE_MS,
  receiptBackoffMaxMs: raw.RECEIPT_BACKOFF_MAX_MS,
  receiptLeaseMs: raw.RECEIPT_LEASE_MS,
} as const;
