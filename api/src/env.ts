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
import { resolve } from 'node:path';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Owner connection. Migrations only. */
  DATABASE_URL: z.string().url(),
  /** Application connection. Falls back to DATABASE_URL only outside production. */
  APP_DATABASE_URL: z.string().url().optional(),

  /**
   * How `db/client.ts` pools. `default` is `{ max: 10 }` — today's behaviour,
   * unchanged, and what local dev, CI and both test suites run.
   *
   * `serverless` is `{ max: 1, prepare: false }` and is ONLY correct against a
   * TRANSACTION-mode pooler (Supabase's port 6543). Set it together with an
   * APP_DATABASE_URL on that port, never separately: `prepare: false` on a
   * session-mode pooler is merely slower, but leaving it on against 6543 fails
   * intermittently with `prepared statement "…" does not exist`.
   *
   * There is no assertion tying the two together, and that is deliberate — the
   * port is not a reliable signal (a self-hosted PgBouncer is on 5432), so a
   * guess here would refuse valid deployments. `db/poolOptions.ts` carries the
   * whole argument.
   */
  DB_POOL_MODE: z.enum(['default', 'serverless']).default('default'),

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
  // TWO CHANNELS, AND THEY ARE NO LONGER BLOCKED BY THE SAME THING. This block
  // said "neither channel can be wired yet"; that has been half true for a
  // while and the half that changed is worth stating rather than deleting.
  //
  //   whatsapp  STILL BLOCKED, and not on us. design/whatsapp-templates.md:
  //             the four templates are unapproved and "approval is not
  //             instant". There is no template id to send against, so there is
  //             no WhatsApp driver.
  //
  //   email     NO LONGER BLOCKED ON COPY. design/AVO Receipt Email.html is a
  //             finished, send-ready template and design/README.md lists
  //             "email receipts" among the gaps it has CLOSED. What is open is
  //             the SENDING DOMAIN — CLAUDE.md § Escalate, "whether receipts
  //             send from AVO's domain or per-salon subdomains" — which is what
  //             decides where SPF and DKIM records go.
  //
  //             That is an OPERATOR'S VARIABLE, not a code decision, so it is
  //             RECEIPT_EMAIL_FROM_ADDRESS with no default and both answers
  //             expressible in it. See src/receipts/email/index.ts.
  // -------------------------------------------------------------- images --
  //
  // The FIRST image capability in this product. Where the bytes live is a client
  // decision that has not been made — CLAUDE.md § Escalate lists data residency
  // ("leaning Kuwait, undecided") and the retention schedule — so the provider
  // sits behind a seam, exactly as the PSP does. See src/images/types.ts.
  //
  // `disk` is the only driver and it BOOTS ANYWHERE, unlike GATEWAY_DRIVER=sandbox.
  // What it refuses is a WRITE in production, from inside the driver, with a 503
  // naming the missing decision. The argument for that split is in images/disk.ts:
  // a sandbox gateway fabricates a payment, a local disk fabricates nothing and
  // simply cannot KEEP what it was given — so refusing to boot the whole API,
  // including charges and sign-in, over a product-photo capability would be the
  // wrong trade, and letting it accept uploads it will silently lose would be the
  // other wrong trade.
  //
  // `supabase` is the second driver and it is NOT the default. It exists because
  // the deployed demo has no filesystem, so `disk` answers 502 there and no image
  // works. Selecting it is an OPERATOR'S ACT in one environment, and it settles
  // nothing about where bytes are allowed to live in production — the demo
  // project sits in eu-central-1, which is exactly why it is a demo-only
  // configuration. Data residency is still the client's open question
  // (CLAUDE.md § Escalate, don't guess) and src/images/supabase.ts says so at
  // length. `disk`'s production write refusal is unchanged.
  IMAGE_DRIVER: z.enum(['disk', 'supabase']).default('disk'),

  /**
   * ------------------------------------------------------------- supabase --
   *
   * NO DEFAULTS ON ANY OF THE THREE, which is the MyFatoorah block's rule and
   * src/images/index.ts restates it: "a bucket name baked in as a fallback is how
   * somebody else's bucket ends up holding a client's customer photos." The
   * assertion below names whichever is missing.
   *
   * NO VALUE FOR ANY OF THESE IS COMMITTED ANYWHERE IN THIS REPOSITORY — not
   * here, not in api/.env.example, not in a test fixture. `SUPABASE_SERVICE_ROLE_KEY`
   * bypasses every row-level policy in the project; it belongs in a secret
   * manager, and `.env.*` is gitignored by repo policy for this reason.
   */
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  /** The bucket. Must be PRIVATE — src/images/supabase.ts § THE BUCKET MUST BE PRIVATE. */
  SUPABASE_STORAGE_BUCKET: z.string().min(1).optional(),
  /**
   * A ceiling on one storage call. Defaulted, unlike the three above, because it
   * is a tuning number rather than a credential or a destination — nothing is
   * misdirected by getting it wrong, a request just waits longer before the 502.
   */
  SUPABASE_STORAGE_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  /**
   * Where `disk` keeps them. Relative paths resolve against the api/ package, so
   * a developer's store is `api/.image-store` and is gitignored.
   */
  IMAGE_STORE_PATH: z.string().default('.image-store'),

  /**
   * The size ceiling, in bytes. 2 MiB.
   *
   * A shop tile and a service row are at most a few hundred pixels on a phone;
   * 2 MiB is a generous 2000px JPEG and still a bounded thing to hold in memory
   * per concurrent upload. The route ALSO sets a Fastify body limit at twice
   * this — that one is the DoS backstop and produces a blunt 413; this one is
   * the product rule and produces a named error with the limit in it.
   */
  IMAGE_MAX_BYTES: z.coerce.number().int().positive().default(2 * 1024 * 1024),

  /**
   * The longest side, in pixels. Read out of the container header, never by
   * decoding — see images/inspect.ts.
   */
  IMAGE_MAX_DIMENSION: z.coerce.number().int().positive().default(4096),

  /**
   * The pixel ceiling, and it is the decompression-bomb control.
   *
   * Bytes and dimensions do not bound each other: a 30 KB PNG can legally
   * declare 30000x30000 and expand to 3.6 GB in whatever decodes it. THIS API
   * NEVER DECODES, so the bomb is harmless here — but the wallet on a customer's
   * phone does decode, and a merchant must not be able to upload a picture that
   * kills the app of everyone who opens her shop.
   *
   * TWELVE MEGAPIXELS, AND THE NUMBER WAS WRONG BEFORE IT WAS THIS ONE.
   * It was `16 * 1024 * 1024` — 16,777,216 — which is EXACTLY 4096 x 4096, and
   * `IMAGE_MAX_DIMENSION` is 4096. So the largest shape the dimension ceiling
   * admitted was the largest shape this ceiling admitted, the `>` could never be
   * true, and the check was unreachable code wearing the costume of a control.
   * Found by writing the test for it and watching a 201 come back, not by
   * reading the two lines — which is the argument for driving a limit rather
   * than declaring one.
   *
   * 12,000,000 is one photo straight off a phone's main camera and no more. It
   * leaves both ceilings live and independently meaningful: 4096x2929 is a wide
   * banner and passes, 4096x4096 is 16.8 MP and does not, 30000x30000 fails the
   * dimension check first.
   */
  IMAGE_MAX_PIXELS: z.coerce.number().int().positive().default(12_000_000),

  /**
   * Hours a detached image keeps its bytes before the reaper removes them.
   *
   * Not zero, and not because deleting is hard. A replacement is a mis-click
   * away, and 24 hours of "the old one is still there" is the difference between
   * an undo and a re-shoot. It is also what makes the reaper safe to re-run: a
   * row detached and re-attached inside the window never loses anything.
   */
  IMAGE_DETACHED_GRACE_HOURS: z.coerce.number().int().nonnegative().default(24),

  /**
   * `logging` stays the default, and the default is the whole point of it.
   *
   * It is not a stub: every test run, every developer's API and every
   * environment that has not been given a mail credential drains its own outbox
   * against a driver that cannot fail, which is how the worker, the claim, the
   * backoff and the transient/permanent split got exercised long before a
   * provider existed.
   *
   * NO PRODUCTION REFUSAL ON `logging`, deliberately, and the argument is
   * images/disk.ts's rather than GATEWAY_DRIVER=sandbox's. A sandbox gateway
   * FABRICATES a payment nobody made; a logging receipt fabricates nothing and
   * simply does not send. Refusing to boot the whole API — charges, sign-in,
   * the scanner — over a receipt capability would be the wrong trade, and it
   * would be a SEVENTH production assertion added on this file's judgement.
   * What the absence costs is written down instead: api/README.md § "What the
   * absent background jobs cost", and go-live-checklist.md owns the tick.
   */
  RECEIPT_DRIVER: z.enum(['logging', 'email']).default('logging'),

  /**
   * ---------------------------------------------------------- email ---------
   *
   * WHICH POSTMAN, under RECEIPT_DRIVER=email. One value today, for exactly the
   * reason RECEIPT_DRIVER had one value yesterday — and the enum exists so the
   * second one is a file and a case rather than an edit to anything that knows
   * what a receipt says. src/receipts/email/transport.ts carries the argument
   * for HTTP over SMTP and its cost.
   */
  RECEIPT_EMAIL_TRANSPORT: z.enum(['resend']).default('resend'),

  /**
   * THE SENDING IDENTITY. NO DEFAULT, and this one is not only the credential
   * rule — it is the open client decision.
   *
   * CLAUDE.md § Escalate: "Whether receipts send from AVO's domain or per-salon
   * subdomains" belongs to the client and has not been answered. Written plainly
   * ("receipts@avo.beauty") this is the one-domain answer; written with the
   * token `{salon}` ("receipts@{salon}.avo.beauty") it is the per-salon answer,
   * substituted from the salon id. Both without touching code, which is what
   * leaving a decision open has to mean.
   *
   * A DEFAULT HERE WOULD ANSWER IT BY ACCIDENT, which is the MyFatoorah block's
   * rule ("a credential baked into a driver is how the live one gets committed")
   * arriving as a product decision instead of a security one. The display name
   * is NOT configurable: it is the salon's, per whatsapp-templates.md.
   */
  RECEIPT_EMAIL_FROM_ADDRESS: z.string().email().or(z.string().includes('{salon}')).optional(),

  /**
   * The transport credential. NO DEFAULT, NO VALUE ANYWHERE IN THIS REPOSITORY
   * — not here, not in api/.env.example, not in a fixture, not in a comment.
   * `.env.*` is gitignored by repo policy and this belongs in a secret manager.
   * A mail API key sends mail AS the verified domain, which is the whole of the
   * company's sending reputation.
   */
  RECEIPT_EMAIL_API_KEY: z.string().min(1).optional(),

  /**
   * The provider's endpoint. Optional and defaulted BY THE ADAPTER rather than
   * here, because it is a published destination rather than a credential —
   * overridable so a relay, a proxy or a regional endpoint is a variable.
   */
  RECEIPT_EMAIL_API_BASE_URL: z.string().url().optional(),

  /**
   * A ceiling on one send. Defaulted, like SUPABASE_STORAGE_TIMEOUT_MS and for
   * the same reason: nothing is misdirected by getting it wrong. A timeout is a
   * TRANSIENT failure, so the job comes back with its backoff intact.
   */
  RECEIPT_EMAIL_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

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

/**
 * The Supabase image driver refuses to boot half-configured, naming the variable.
 *
 * NOT PRODUCTION-ONLY, and for the reason the MyFatoorah assertion above gives:
 * selecting this driver at all means intending to talk to a real bucket, and a
 * driver that boots with no key sends `Bearer undefined`, gets a 401 from
 * storage-api, and the operator then debugs Supabase instead of their own
 * environment. Fail here, where the cause has a name.
 *
 * THIS IS NOT A SEVENTH PRODUCTION ASSERTION, and deliberately not. The obvious
 * candidate — refuse to boot in production on `IMAGE_DRIVER=disk` — is exactly
 * what src/images/disk.ts § WHY A WRITE REFUSAL AND NOT A BOOT REFUSAL argues
 * against: it would stop charges, top-ups and sign-in over a product-photo
 * capability nobody has to use. The disk driver's per-write 503 stays the answer
 * and is untouched by this file.
 */
if (raw.IMAGE_DRIVER === 'supabase') {
  const missing = (
    [
      ['SUPABASE_URL', raw.SUPABASE_URL],
      ['SUPABASE_SERVICE_ROLE_KEY', raw.SUPABASE_SERVICE_ROLE_KEY],
      ['SUPABASE_STORAGE_BUCKET', raw.SUPABASE_STORAGE_BUCKET],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      `IMAGE_DRIVER=supabase requires ${missing.join(', ')}. ` +
        'None of the three has a default and no value for any of them is committed in ' +
        'this repository — SUPABASE_SERVICE_ROLE_KEY bypasses every row-level policy in ' +
        'the project, so it lives in a secret manager. See api/.env.example.',
    );
  }
}

/**
 * The email receipt driver refuses to boot half-configured, naming the variable.
 *
 * NOT PRODUCTION-ONLY, for the third time and the third identical reason:
 * selecting this driver at all means intending to send real mail to a real
 * customer, and a driver that boots with no key sends `Bearer undefined`, gets a
 * 401, and — because `transport.ts` classifies a non-throttling 4xx as
 * PERMANENT — parks every receipt in the queue and writes a `risk` audit row per
 * charge. That is the most expensive way this could fail, and it is the way it
 * fails without this check: the operator debugs Resend instead of their own
 * environment while the audit log fills with real customers who were not told.
 *
 * `RECEIPT_EMAIL_FROM_ADDRESS` is asserted beside the credential even though it
 * is not one. It is the open client decision (CLAUDE.md § Escalate), and there
 * is no safe value to fall back to: an address on an unverified domain is a
 * permanent failure at the provider, and an address on somebody else's is worse.
 */
if (raw.RECEIPT_DRIVER === 'email') {
  const missing = (
    [
      ['RECEIPT_EMAIL_FROM_ADDRESS', raw.RECEIPT_EMAIL_FROM_ADDRESS],
      ['RECEIPT_EMAIL_API_KEY', raw.RECEIPT_EMAIL_API_KEY],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      `RECEIPT_DRIVER=email requires ${missing.join(', ')}. ` +
        'Neither RECEIPT_EMAIL_FROM_ADDRESS nor RECEIPT_EMAIL_API_KEY has a default, and ' +
        'no value for either is committed in this repository. ' +
        'RECEIPT_EMAIL_FROM_ADDRESS is the open client decision — CLAUDE.md § Escalate, ' +
        '"whether receipts send from AVO\'s domain or per-salon subdomains" — and there is ' +
        'no safe address to guess. See api/.env.example.',
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
  dbPoolMode: raw.DB_POOL_MODE,
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
  imageDriver: raw.IMAGE_DRIVER,
  supabaseUrl: raw.SUPABASE_URL,
  supabaseServiceRoleKey: raw.SUPABASE_SERVICE_ROLE_KEY,
  supabaseStorageBucket: raw.SUPABASE_STORAGE_BUCKET,
  supabaseStorageTimeoutMs: raw.SUPABASE_STORAGE_TIMEOUT_MS,
  /**
   * Absolute, resolved once. A relative default that each caller resolved
   * against its own cwd would put a lane's bytes wherever the process happened
   * to start — the ninth shared-resource vector in LANES.md, wearing a
   * filesystem costume.
   */
  imageStorePath: resolve(
    new URL('..', import.meta.url).pathname,
    raw.IMAGE_STORE_PATH,
  ),
  imageMaxBytes: raw.IMAGE_MAX_BYTES,
  imageMaxDimension: raw.IMAGE_MAX_DIMENSION,
  imageMaxPixels: raw.IMAGE_MAX_PIXELS,
  imageDetachedGraceHours: raw.IMAGE_DETACHED_GRACE_HOURS,
  receiptDriver: raw.RECEIPT_DRIVER,
  receiptEmailTransport: raw.RECEIPT_EMAIL_TRANSPORT,
  receiptEmailFromAddress: raw.RECEIPT_EMAIL_FROM_ADDRESS,
  receiptEmailApiKey: raw.RECEIPT_EMAIL_API_KEY,
  receiptEmailApiBaseUrl: raw.RECEIPT_EMAIL_API_BASE_URL,
  receiptEmailTimeoutMs: raw.RECEIPT_EMAIL_TIMEOUT_MS,
  receiptWorkerEnabled: raw.RECEIPT_WORKER_ENABLED,
  receiptPollMs: raw.RECEIPT_POLL_MS,
  receiptBatchSize: raw.RECEIPT_BATCH_SIZE,
  receiptMaxAttempts: raw.RECEIPT_MAX_ATTEMPTS,
  receiptBackoffBaseMs: raw.RECEIPT_BACKOFF_BASE_MS,
  receiptBackoffMaxMs: raw.RECEIPT_BACKOFF_MAX_MS,
  receiptLeaseMs: raw.RECEIPT_LEASE_MS,
} as const;
