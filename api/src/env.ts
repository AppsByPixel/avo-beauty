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
   * SIGNUP — bounding an unauthenticated argon2id endpoint.
   *
   * Two tiers on the caller's address, the same shape as the directory-read
   * limiter in services/memberSearch.ts: a burst window and an hourly ceiling,
   * both answered by one query.
   *
   * THE NUMBERS ARE CALIBRATED FOR COST, NOT FOR ENUMERATION, and are generous on
   * purpose. Kuwaiti mobile networks are heavily NAT'd, so one address can be a
   * great many customers, and a salon signing walk-ins up on its own wifi is one
   * address too — a tight limit here refuses real people at a counter, which is a
   * worse outcome than the one it prevents. 100 hashes an hour is on the order of
   * ten seconds of CPU: bounded, which is the whole requirement, while being a
   * number no legitimate address reaches.
   *
   * NEITHER TIER ADDRESSES A DISTRIBUTED FLOOD, and nothing keyed on the caller
   * can. That needs the verification step at signup, which is the escalated
   * product decision — see the route.
   */
  SIGNUP_ATTEMPTS_PER_WINDOW: z.coerce.number().int().positive().default(20),
  SIGNUP_WINDOW_MINUTES: z.coerce.number().int().positive().default(5),
  SIGNUP_ATTEMPTS_PER_HOUR: z.coerce.number().int().positive().default(100),

  /**
   * Whether `X-Forwarded-For` may be believed, and therefore whether `req.ip` is
   * the customer or the load balancer.
   *
   * OFF BY DEFAULT, and the default is the safe one in the direction that matters:
   * trusting the header unconditionally lets any client SET its own address and
   * walk straight past the signup limiter, one forged hop at a time. Off, the worst
   * case is the opposite — every caller behind a proxy shares one bucket.
   *
   * Which means BOTH settings are wrong in production until this names the actual
   * proxy. Fastify accepts an address, a CIDR, a comma-separated list, or a hop
   * count; the value belongs to whoever owns the deployment, so it is configuration
   * here rather than a guess in code. `go-live-checklist.md` is where it needs to
   * land, and it is in the lane report as an escalation.
   */
  TRUST_PROXY: z.string().optional(),

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
  // PSP selection WAS a client decision that had not been made (CLAUDE.md
  // § Escalate, don't guess). It has now been made in one direction: MyFatoorah,
  // beginning with their TEST environment and test cards rather than waiting on
  // live credentials.
  //
  // `sandbox` REMAINS THE DEFAULT, and that is a decision rather than inertia.
  // e2e must stay deterministic and offline — its duplicate and out-of-order
  // callback specs describe orderings no third-party network service can be asked
  // to produce on cue, and an unreliable green is worse than no green. So the real
  // driver is selected explicitly by an operator and exercised deliberately.
  // `sandbox` is still refused in production below.
  GATEWAY_DRIVER: z.enum(['sandbox', 'myfatoorah']).default('sandbox'),

  /**
   * MyFatoorah's endpoint and API key. NO DEFAULTS, on purpose.
   *
   * The Kuwait sandbox token is published in MyFatoorah's own documentation, so
   * defaulting to it would leak nothing. It is still not defaulted, for two
   * reasons that outlast the token: a credential baked into a driver as a
   * fallback is how the LIVE one gets committed three weeks from now, and a
   * driver that works without being configured is a driver nobody notices is
   * unconfigured. Both public test values are in api/.env.example, which is where
   * a developer looks for them.
   *
   * The assertion below refuses to boot with `GATEWAY_DRIVER=myfatoorah` and any
   * of the three missing, naming the variable.
   */
  MYFATOORAH_BASE_URL: z.string().url().optional(),
  MYFATOORAH_API_KEY: z.string().min(20).optional(),

  /**
   * Where MyFatoorah returns the customer's BROWSER — not the app deep link.
   *
   * Verified against the live test environment rather than assumed: `CallBackUrl`
   * must be http(s), and `avo://topup/return?intent=…` is refused outright with
   * "The field CallBackUrl must be a url. Example http://www.example.com". So
   * `TOPUP_RETURN_URL` cannot be given to this processor. This is an https URL
   * AVO owns which forwards to the deep link, carried along in `to=`.
   *
   * Which host serves it is an infrastructure decision and is not invented here.
   * The driver refuses rather than handing the processor a URL that 404s.
   */
  MYFATOORAH_RETURN_URL: z.string().url().optional(),

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
  /**
   * Seconds a signed callback stays acceptable. Replay window, keep it small.
   *
   * SANDBOX DRIVER ONLY, and that is a property of MyFatoorah rather than a gap
   * here. The sandbox signs `${timestamp}.${rawBody}`, so moving `t` forward
   * invalidates the MAC and this window is a real control. MyFatoorah signs an
   * ordered list of IDENTITY fields with no timestamp in it at all, so a captured
   * callback of theirs replays forever and nothing this number could be set to
   * would change that. See gateway/myfatoorah.ts for what carries the weight
   * instead.
   */
  GATEWAY_WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().positive().default(300),
  /** Milliseconds. A gateway that has not answered by now has not answered. */
  GATEWAY_TIMEOUT_MS: z.coerce.number().int().positive().default(8_000),

  /** Where the PSP's hosted page lives, for the sandbox. Absolute. */
  PUBLIC_BASE_URL: z.string().url().optional(),
  /** api-contract.md § TopUpIntent: the gateway returns the customer here. */
  TOPUP_RETURN_URL: z.string().default('avo://topup/return'),

  // ------------------------------------------------------------ calendar --
  //
  // Google Calendar sits behind the same kind of seam as the gateway, for the
  // same reason: OAuth against Google needs a Cloud project, a client id and
  // secret, and a verified consent screen, all of which are issued to a legal
  // entity and are therefore AVO's to create, not a developer's. See
  // src/calendar/types.ts for the full list the client has to provide.
  //
  // NO PRODUCTION REFUSAL, unlike GATEWAY_DRIVER=sandbox. A sandbox gateway in
  // production settles payments nobody made; a stub calendar makes every artist
  // bookable on the salon's own hours and raises a merchant notification saying
  // so. Degraded, honest, and tradeable.
  CALENDAR_DRIVER: z.enum(['stub']).default('stub'),

  /** Where Google returns the browser after consent. Absolute, AVO-owned. */
  CALENDAR_REDIRECT_URL: z.string().optional(),

  // ------------------------------------------------------------- booking --

  /**
   * THE NO-SHOW RETURN JOB. On by default, for the reason the receipt worker is:
   * a process that serves requests should do its own background work, and a
   * deploy that quietly holds every deposit for ever is the failure mode of
   * leaving it off.
   *
   * `buildApp()` does not start it — `server.ts` does — so a test that
   * constructs handlers gets a still queue and can drive `runNoShowReturnsOnce`
   * by hand.
   */
  NO_SHOW_WORKER_ENABLED: z
    .enum(['0', '1'])
    .default('1')
    .transform((v) => v === '1'),
  /** Milliseconds between passes, measured from the END of the previous one. */
  NO_SHOW_POLL_MS: z.coerce.number().int().positive().default(30_000),
  /** Bookings returned per pass. The concurrency control. */
  NO_SHOW_BATCH_SIZE: z.coerce.number().int().positive().max(500).default(50),

  /**
   * How long before a slot a customer may still cancel or reschedule for free.
   *
   * SIXTY, from the design: "Free until an hour before. After that the deposit
   * stays with the salon" — AVO Wallet Home.dc.html, `reschedNote`, EN and AR.
   * Configurable so it is a number with a name rather than a literal buried in a
   * comparison, and NOT per-salon: the deposit rule is the product's, and a
   * merchant able to set her own cancellation window is a policy surface nobody
   * has designed. Reported rather than invented.
   */
  BOOKING_CHANGE_WINDOW_MINUTES: z.coerce.number().int().positive().default(60),

  // ------------------------------------------------------------- top-ups --

  /**
   * THE ABANDONED TOP-UP REAPER. OFF BY DEFAULT — the opposite of the two
   * workers above, deliberately, and services/topupReaper.ts § OFF BY DEFAULT
   * carries the full argument. The two halves of it:
   *
   *   `NO_SHOW_WORKER_ENABLED` defaulting to '1' twenty lines above is the
   *   direct cause of `deposit.test.ts` being flaky for weeks — the e2e harness
   *   boots `src/server.ts`, so a production loop ran inside every test run
   *   settling deposits at a moment no spec chose, and Lane D had to pin it off
   *   in the harness. Defaulting this one off means no harness anywhere has to
   *   remember anything.
   *
   *   And unlike its siblings, leaving this off costs nobody anything: no
   *   receipt goes unsent, no customer's deposit is withheld. The table grows,
   *   which is exactly where this project already is, and
   *   `pnpm --dir=… run job:topup-reap` drains it with the numbers printed.
   *
   * `TOPUP_REAP_AFTER_HOURS` is a CONSTANT in services/topupReaper.ts and not a
   * variable here on purpose: the window is a product decision queued for Aftab,
   * not a per-deployment knob. Flip this default to '1' when he picks the number
   * — and pin `TOPUP_REAPER_ENABLED=0` in the e2e harness in the same commit.
   */
  TOPUP_REAPER_ENABLED: z
    .enum(['0', '1'])
    .default('0')
    .transform((v) => v === '1'),
  /**
   * Milliseconds between passes, measured from the END of the previous one.
   * Fifteen minutes: every candidate costs a gateway round trip and nothing here
   * is urgent — the youngest row a pass can touch is a week old.
   */
  TOPUP_REAPER_POLL_MS: z.coerce.number().int().positive().default(15 * 60_000),

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

/**
 * TRUST_PROXY IS REQUIRED IN PRODUCTION — DECISIONS.md § "Five calls made without
 * asking", item 1, decided and until now not implemented.
 *
 * "`req.ip` became a security control when the signup limiter shipped, and both
 * silent defaults are wrong: unset puts every caller behind a proxy in one bucket,
 * `true` lets any client forge its own. So the API refuses to boot in production
 * with it unset, naming the variable."
 *
 * WHY THIS MATTERED MORE AFTER THIS SLICE THAN BEFORE IT. `req.ip` was already the
 * key for the signup limiter's CPU bound. It is now also what bounds the
 * ENUMERATION ORACLE: `recordSignupAttempt` moved above the duplicate-phone refusal
 * in this branch, so "an attacker walks roughly 100 numbers an hour per address" is
 * a true statement about a real control — and it is true only if the address is
 * real. Behind an untrusted proxy every caller shares one bucket, so twenty probes
 * from anybody lock out signup for everybody; behind a blindly trusted one every
 * caller forges a fresh bucket per request and the bound is nil. The second is a
 * bypass and the first is a denial of service, and neither announces itself.
 *
 * A DEPLOYMENT THAT CANNOT SAY WHAT ITS PROXY IS HAS NOT BEEN CONFIGURED. Finding
 * that out at boot beats finding it out from a rate limiter that never fires, or
 * from one that fires at everybody.
 *
 * `TRUST_PROXY=false` IS AN ACCEPTABLE ANSWER and is not the same as unset. It says
 * "there is no proxy, the socket address is the client" — true for a container
 * talking straight to the internet — and it is a claim somebody made rather than a
 * default nobody chose. Refusing it too would force a lie on the deployments where
 * it is correct.
 *
 * Development keeps defaulting to off, which is the safer wrong when there is no
 * proxy anyway and no attacker.
 */
if (raw.NODE_ENV === 'production' && (raw.TRUST_PROXY === undefined || raw.TRUST_PROXY === '')) {
  throw new Error(
    'TRUST_PROXY is required in production. `req.ip` is a security control — it keys ' +
      'the signup limiter, which bounds both an argon2 denial of service and the ' +
      'enumeration oracle on POST /auth/member/signup. Unset puts every caller in one ' +
      'bucket; `true` lets any client forge its own by sending X-Forwarded-For. Set it ' +
      'to the number of proxies in front of this process, their addresses, or `false` if ' +
      'there is genuinely no proxy. See DECISIONS.md and go-live-checklist.md.',
  );
}

if (raw.NODE_ENV === 'production' && raw.GATEWAY_DRIVER === 'sandbox') {
  throw new Error(
    'GATEWAY_DRIVER=sandbox settles payments nobody paid for. Select a real ' +
      'processor before production — see CLAUDE.md § Escalate, don\'t guess.',
  );
}

/**
 * The real driver refuses to boot half-configured, naming the variable.
 *
 * This is not a production-only assertion, unlike the four above it. The whole
 * point of selecting `myfatoorah` in development is to talk to a real processor,
 * and a driver that boots with no key and sends `Bearer undefined` produces a 401
 * from MyFatoorah — at which point the operator debugs MyFatoorah instead of
 * their own environment. Fail here, where the cause has a name.
 */
if (raw.GATEWAY_DRIVER === 'myfatoorah') {
  const missing = (
    [
      ['MYFATOORAH_BASE_URL', raw.MYFATOORAH_BASE_URL],
      ['MYFATOORAH_API_KEY', raw.MYFATOORAH_API_KEY],
      ['MYFATOORAH_RETURN_URL', raw.MYFATOORAH_RETURN_URL],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      `GATEWAY_DRIVER=myfatoorah requires ${missing.join(', ')}. ` +
        'The public Kuwait test values are documented in api/.env.example — they are ' +
        'deliberately not defaults, because a credential baked into a driver is how the ' +
        'live one gets committed.',
    );
  }
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
  signupAttemptsPerWindow: raw.SIGNUP_ATTEMPTS_PER_WINDOW,
  signupWindowMinutes: raw.SIGNUP_WINDOW_MINUTES,
  signupAttemptsPerHour: raw.SIGNUP_ATTEMPTS_PER_HOUR,
  /**
   * Fastify's own shapes: `true` for "one hop", a number for N hops, or an
   * address / CIDR / comma-separated list. `'true'` is converted to a BOOLEAN
   * because Fastify treats the STRING 'true' as an address to match.
   *
   * `'false'` NEEDED THE SAME TREATMENT AND DID NOT HAVE IT, and it was found by
   * exercising the guard above rather than by reading this expression.
   *
   * `'false'` fell through every branch to the final one and reached Fastify as
   * the STRING "false" — which `proxy-addr` reads as a subnet list containing one
   * entry called "false". That happens to behave like `false`, because nothing
   * matches it, so the symptom was nil and the meaning was wrong: the deployment
   * asked for "there is no proxy" and got "trust this malformed subnet".
   *
   * It matters now in a way it did not before, because the production assertion
   * above TELLS an operator to set `TRUST_PROXY=false` when there is genuinely no
   * proxy. A guard that directs people to a value the parser mangles is worse than
   * no guard: it manufactures the misconfiguration it exists to prevent, and it
   * does it with a documented instruction.
   *
   * The accidental behaviour and the intended one coincide TODAY. They would stop
   * coinciding the moment `proxy-addr` decided an unparseable entry was an error
   * rather than a non-match — and then "no proxy" would start throwing at boot in
   * exactly the deployments that had configured it correctly.
   */
  trustProxy:
    raw.TRUST_PROXY === undefined || raw.TRUST_PROXY === '' || raw.TRUST_PROXY === 'false'
      ? false
      : raw.TRUST_PROXY === 'true'
        ? true
        : /^\d+$/.test(raw.TRUST_PROXY)
          ? Number(raw.TRUST_PROXY)
          : raw.TRUST_PROXY,
  testPrincipals: raw.AVO_TEST_PRINCIPALS,
  gatewayDriver: raw.GATEWAY_DRIVER,
  myfatoorahBaseUrl: raw.MYFATOORAH_BASE_URL,
  myfatoorahApiKey: raw.MYFATOORAH_API_KEY,
  myfatoorahReturnUrl: raw.MYFATOORAH_RETURN_URL,
  gatewayWebhookSecret,
  gatewayWebhookToleranceSeconds: raw.GATEWAY_WEBHOOK_TOLERANCE_SECONDS,
  gatewayTimeoutMs: raw.GATEWAY_TIMEOUT_MS,
  publicBaseUrl: raw.PUBLIC_BASE_URL ?? `http://localhost:${raw.PORT}`,
  topupReturnUrl: raw.TOPUP_RETURN_URL,
  calendarDriver: raw.CALENDAR_DRIVER,
  calendarRedirectUrl:
    raw.CALENDAR_REDIRECT_URL ??
    `${raw.PUBLIC_BASE_URL ?? `http://localhost:${raw.PORT}`}/artists/calendar/callback`,
  noShowWorkerEnabled: raw.NO_SHOW_WORKER_ENABLED,
  noShowPollMs: raw.NO_SHOW_POLL_MS,
  noShowBatchSize: raw.NO_SHOW_BATCH_SIZE,

  topupReaperEnabled: raw.TOPUP_REAPER_ENABLED,
  topupReaperPollMs: raw.TOPUP_REAPER_POLL_MS,
  bookingChangeWindowMinutes: raw.BOOKING_CHANGE_WINDOW_MINUTES,
  receiptDriver: raw.RECEIPT_DRIVER,
  receiptWorkerEnabled: raw.RECEIPT_WORKER_ENABLED,
  receiptPollMs: raw.RECEIPT_POLL_MS,
  receiptBatchSize: raw.RECEIPT_BATCH_SIZE,
  receiptMaxAttempts: raw.RECEIPT_MAX_ATTEMPTS,
  receiptBackoffBaseMs: raw.RECEIPT_BACKOFF_BASE_MS,
  receiptBackoffMaxMs: raw.RECEIPT_BACKOFF_MAX_MS,
  receiptLeaseMs: raw.RECEIPT_LEASE_MS,
} as const;
