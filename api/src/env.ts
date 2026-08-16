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
} as const;
