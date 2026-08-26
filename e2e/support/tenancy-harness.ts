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
import { createHmac, randomBytes } from 'node:crypto';
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
/**
 * A branch at salon A. `api/src/db/seed.ts` — `BR-SAL`, Salmiya.
 *
 * Only ever used as the `{bid}` in a cross-salon probe, where the point is that
 * `requireSameSalon` refuses BEFORE the branch is looked up. A made-up id would
 * make a 404-instead-of-403 indistinguishable from the tenancy check running too
 * late, which is the thing those specs are for.
 */
export const A_BRANCH = 'BR-SAL';
/** Salon A's seeded happy hour — `api/src/db/seed.ts`. All branches, x2visit, ON. */
export const A_HAPPY_HOUR = 'HH-01';

/** The second salon, seeded by this file and by nothing else. */
export const SALON_B = 'SAL-LUMIERE';
export const B_MEMBER = '9001';
export const B_MEMBER_PHONE = '+96599555001';
export const B_STAFF = 'ST-B01';
export const B_STAFF_HANDLE = 'layla';
export const B_BRANCH = 'BR-LUM-HAW';
/** Salon B's second branch. What makes `resolveBranch` ambiguous. */
export const B_BRANCH_SECOND = 'BR-LUM-JAB';
/**
 * A branch that exists to be renamed and closed by the specs that prove those
 * routes, and re-opened by this seed on the next run.
 *
 * THE SAME ROLE `B_HAPPY_HOUR_DISPOSABLE` PLAYS, AND FOR A SHARPER REASON. Lane
 * A's branch writes are real now: `PATCH` renames, and `DELETE` sets `closed_at`.
 * Pointed at `B_BRANCH` or `B_BRANCH_SECOND` — which is what the tenancy ledger's
 * control call would do by default — the rename breaks `branch_salon_name_uq` on
 * the next run and the close drops salon B to one open branch, which flips
 * `resolveBranch` from "assumed" to "established" and silently rewrites what the
 * promotions suite is measuring.
 *
 * THE ID SORTS AFTER BOTH FIXTURES ON PURPOSE. `resolveBranch` picks the
 * alphabetically first OPEN branch when there is more than one, so an id
 * beginning `BR-LUM-D…` would quietly become the branch every salon B charge is
 * attributed to. `ZZ` keeps it last, and keeps this fixture invisible to every
 * suite that does not name it.
 */
export const B_BRANCH_DISPOSABLE = 'BR-LUM-ZZDISP';
export const B_SERVICE = 'SV-B01';
export const B_SERVICE_PRICE_FILS = 7_000;
/**
 * Salon B's SECOND service — 'Cut', 14.000. Seeded since the scanner fixtures
 * landed and until now never exported, so nothing could name it.
 *
 * EXPORTED FOR THE NEAR-DUPLICATE GUARD, which is a claim about a BASKET and
 * therefore untestable with one service in the salon. Two are the minimum to ask
 * the three questions that matter: that a different basket is not a duplicate,
 * that `[SV-B01, SV-B02]` and `[SV-B02, SV-B01]` are the SAME basket (the hash is
 * sorted before it is taken), and that the guard keys on the basket rather than
 * simply on "this member was charged recently".
 *
 * DELIBERATELY A DIFFERENT PRICE from `B_SERVICE`. If both cost 7.000 a spec that
 * confused the two baskets would still see the balance it expected, and the
 * distinguishing assertion would be satisfied by an accident.
 */
export const B_SERVICE_SECOND = 'SV-B02';
export const B_SERVICE_SECOND_PRICE_FILS = 14_000;
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

/**
 * THE LOOKUP-BUDGET ROWS. See the seed below for why they exist: the per-staff
 * hourly ceiling on `GET /members?q=` means a spec that spends 30 lookups has to
 * spend them under an id nothing else uses, and `audit_log` cannot be trimmed to
 * give the budget back.
 */
export const B_STAFF_BURST = 'ST-B06';
export const B_STAFF_BURST_HANDLE = 'budgetburst';
export const B_BURST_DEVICE = 'DEV-SCANNER-B-BURST';

export const B_STAFF_COUNTER = 'ST-B07';
export const B_STAFF_COUNTER_HANDLE = 'budgetcounter';
export const B_COUNTER_DEVICE = 'DEV-SCANNER-B-COUNTER';

/**
 * The third budget row, for the CROSS-DOOR spec. The hourly ceiling counts
 * searches AND resolves against one shared allowance, so proving that needs a
 * staff member whose whole hour can be spent on one action and then probed with
 * the other — which means she can be used by exactly one spec.
 */
/**
 * TWO BRANCH-SCOPED ROWS FOR THE CLOSURE-PREVIEW IDENTITY SPEC.
 *
 * That spec compares what closing a branch WOULD do against what it then DID, and
 * on a freshly created branch every impact field is empty — so the comparison was
 * vacuous and a deliberate break to the preview's own money field did not fail it.
 * Real impact needs staff actually scoped to the branch being closed.
 *
 * `SURVIVOR` keeps another branch and so appears only in `staffRescoped`;
 * `STRANDED` is scoped to the closing branch alone and so appears in
 * `staffLeftWithNoBranch` as well — which is the field the merchant most needs to
 * see, and the one a vacuous spec was least able to protect. Dedicated rows because
 * the spec rewrites their access: `ST-B02` is another file's Accounts target.
 */
/**
 * THE TWO AUTHORITY PROBES, one per surface, and they exist because
 * non-negotiable #7 needs a principal that HOLDS NOTHING.
 *
 * Every other staff fixture in this file holds something on purpose, so a ledger
 * built on them can only probe the permissions they happen to lack. These two are
 * seeded with all nine OFF, and `authority.test.ts` grants exactly one at a time to
 * take its control reading. Two rows because the surface check runs BEFORE the
 * permission check: a dashboard endpoint refuses a PIN session as the wrong KIND of
 * credential, which is a different refusal from an under-privileged one, and a
 * ledger that conflated them would report a gate that is not there.
 */
export const B_STAFF_AUTH_WEB = 'ST-B11';
export const B_STAFF_AUTH_WEB_HANDLE = 'authweb';
export const B_STAFF_AUTH_PIN = 'ST-B12';
export const B_STAFF_AUTH_PIN_HANDLE = 'authpin';
export const B_AUTH_PIN_DEVICE = 'DEV-SCANNER-B-AUTH';

export const B_STAFF_BRANCH_SURVIVOR = 'ST-B09';
export const B_STAFF_BRANCH_STRANDED = 'ST-B10';

export const B_STAFF_CROSSDOOR = 'ST-B08';
export const B_STAFF_CROSSDOOR_HANDLE = 'budgetcrossdoor';
export const B_CROSSDOOR_DEVICE = 'DEV-SCANNER-B-CROSSDOOR';

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
// ------------------------------------------------ the owner console's principals --

/**
 * Lane A's seeded platform admins — `api/src/db/seed.ts`. Three, and the spread of
 * their nine section permissions is the whole reason there are three:
 *
 *   PLT-001  yousef    owner    every section. The control for every refusal.
 *   PLT-002  mariam.k  analyst  analytics + activity ONLY. approvals and policies
 *                               are OFF, so she is a genuinely restricted console
 *                               principal — which is what non-negotiable #7 needs, and
 *                               what an owner-only fixture could never provide.
 *   PLT-003  salem.a   admin    every section, non-owner. The second full-authority
 *                               credential, for anything needing two reviewers.
 *
 * `platform_admin.handle` is GLOBALLY unique, unlike `staff_user.handle` which is
 * unique per salon — there is one platform, so there is one "yousef". That is also why
 * console sign-in takes no salon field where merchant sign-in does.
 */
export const PLATFORM_OWNER = 'PLT-001';
export const PLATFORM_OWNER_HANDLE = 'yousef';
/**
 * `decided_by` is set to the ADMIN'S NAME, not her id — `routes/campaigns.ts` sets
 * `decidedBy: p.name`. So a spec asserting who decided a campaign asserts on this
 * string, and it is 'Yousef' exactly: `api/src/db/seed.ts:194`.
 */
export const PLATFORM_OWNER_NAME = 'Yousef';
/** approvals OFF, policies OFF. The restricted console principal. */
export const PLATFORM_ANALYST = 'PLT-002';
export const PLATFORM_ANALYST_HANDLE = 'mariam.k';
export const PLATFORM_ADMIN2 = 'PLT-003';
export const PLATFORM_ADMIN2_HANDLE = 'salem.a';

/** `PLATFORM_PASSWORD` in `api/src/db/seed.ts`. All three admins share it. */
export const PLATFORM_PASSWORD = 'yousef-dev-password';

/**
 * `platform_messaging_policy` defaults, from migration 0028 and api-contract.md:
 * requireApproval ON, 2 per customer per week, 8 per salon per month, quiet
 * 22:00-09:00. Written out so a spec can restore them after changing them.
 */
export const POLICY_WEEKLY_CAP_PER_CUSTOMER = 2;
export const POLICY_MONTHLY_CAP_PER_SALON = 8;
export const POLICY_QUIET_FROM = '22:00';
export const POLICY_QUIET_TO = '09:00';

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

// -------------------------------------------------------------- the no-show --

/**
 * THE NO-SHOW WORKER IS OFF UNDER TEST, AND THIS IS A BUG FIX RATHER THAN A
 * PREFERENCE. It is the opposite call to `RECEIPT_WORKER_ENABLED` above, so the
 * difference is worth spelling out.
 *
 * WHAT IT COST. `deposit.test.ts` § "two no-show passes racing on one deposit
 * still return it once" failed in one gate run and passed in the next, on an
 * identical tree, an identical build and a freshly seeded database. Both of the
 * spec's spawned passes reported `{candidates: 1, returned: 0, alreadySettled: 1}`
 * while the member's balance and her `deposit_return` count had each moved by
 * exactly one. Nothing was lost and nothing was double-paid — the deposit came
 * back once, correctly. It was simply returned by somebody the spec had not
 * launched, so the spec's last assertion, `returned === 1 between them`, read 0.
 *
 * WHO. `api/src/server.ts` starts `startNoShowWorker` whenever
 * `NO_SHOW_WORKER_ENABLED` is on, and `api/src/env.ts` defaults it to `'1'`,
 * polling every `NO_SHOW_POLL_MS` (30s). This harness boots `src/server.ts` — not
 * `buildApp()` — against this run's database, and never set the variable. So every
 * deposit spec in the suite has been running against a third, invisible worker on
 * a timer that no test chose.
 *
 * AND IT IS NOT ONE SPEC'S PROBLEM, WHICH IS WHY THE PIN IS AT THE HARNESS RATHER
 * THAN A GUARD IN ONE FILE. Turned up to `NO_SHOW_POLL_MS=1000` so the timer wins
 * reliably, FOUR of `deposit.test.ts`'s twenty specs go red, every run:
 *
 *   a charge consumes exactly ONE hold, the earliest, …
 *       precondition failed: the two bookings added 5000 to the held account,
 *       not two deposits
 *   returns a held deposit whose grace period has expired, in full, to her wallet
 *       the job saw 0 candidate(s) and returned 0
 *   and running it AGAIN returns nothing further …
 *       precondition failed: the first pass returned nothing, so this spec cannot
 *       tell idempotence from inaction
 *   two no-show passes racing on one deposit …
 *       expected 200000 to be 205000
 *
 * Three of those four fail LOUDLY, on a precondition or a candidate count that
 * names what is missing. The racing spec is the one that fails quietly — its money
 * assertions still pass, because the deposit really did come back exactly once —
 * and quiet is why it was the one that reached a gate as a mystery rather than as
 * a diagnosis.
 *
 * WHY THIS AND NOT ISOLATION. A private member or a private booking fixes nothing:
 * the worker's scan is `status = 'deposit_held' AND no_show_return_due_at <= now()`
 * across the WHOLE database, so it finds any due booking belonging to anyone.
 * `fileParallelism: false` does not help either — the interference is not between
 * two test files, it is between the suite and the server the suite booted. Turning
 * the loop off is the only thing that removes it.
 *
 * WHY NOTHING IS LOST BY TURNING IT OFF. No spec in this directory waits for the
 * timer. Every `no_show_returned` assertion in the suite follows an explicit
 * `runNoShowJob()`, which runs `api/src/jobs/no-show-once.ts` — the one-shot script
 * lane A wrote for exactly this, whose own docstring says "a claim about a
 * background loop that can only be exercised by waiting for a timer is a claim
 * nobody checks". The behaviour stays covered; only the unscheduled copy goes away.
 *
 * `noShowWorker.ts` already states the principle and this restores it: "NOT STARTED
 * BY `buildApp()`. A background loop attached to the app factory would return
 * deposits inside every test run, at a moment no test chose." Booting `server.ts`
 * put that loop back into every test run through the other door.
 *
 * Overridable, so an operator can prove the timer end to end on purpose:
 *
 *     NO_SHOW_WORKER_ENABLED=1 NO_SHOW_POLL_MS=1000 ../node_modules/.bin/vitest run deposit
 *
 * which is also how the failure above was reproduced on demand.
 */
export const NO_SHOW_WORKER_ENABLED = (process.env.NO_SHOW_WORKER_ENABLED ?? '0') === '1';

/**
 * ...AND ONE FILE TURNS IT BACK ON, DELIBERATELY. This is the other half of the
 * pin above, and it exists so that "off by default" does not quietly become
 * "never exercised".
 *
 * WHAT THE PIN LEFT UNTESTED. Every `no_show_returned` assertion in this suite
 * now follows an explicit `api/src/jobs/no-show-once.ts`, which calls
 * `runNoShowReturnsOnce` — the LOGIC. Nothing calls `startNoShowWorker`, which is
 * the PLUMBING around it: the self-rescheduling `setTimeout`, the reschedule that
 * happens after a pass rather than on a fixed interval, and `stop()` awaiting an
 * in-flight pass before the server closes. That plumbing was untested before the
 * pin too — the loop ran in every file and no file ever asserted anything about
 * it, which is exactly how it managed to break the racing spec unnoticed. The pin
 * did not create the gap, it made it visible.
 *
 * WHY AN EXPLICIT CALL AND NOT AN ENVIRONMENT VARIABLE. `startTenancyApi()` boots
 * one API per file, and the module-level const above is read once when the worker
 * process loads the harness — before any `beforeAll` runs. A file that set
 * `process.env.NO_SHOW_WORKER_ENABLED` in its own `beforeAll` would get an API
 * with the worker on while the exported const still read `false`, so the racing
 * spec's precondition would be asking one thing and the server doing another. The
 * override is therefore state this harness holds, read at BOOT time, and the const
 * keeps meaning what it has always meant.
 *
 * WHY IT IS SAFE FOR THE REST OF THE SUITE. `vitest.config.ts` sets
 * `fileParallelism: false`, so only one file's API is alive at a time and
 * `stopTenancyApi()` kills the process group on the way out. The worker opted in
 * here therefore cannot reach a deposit belonging to a file that is not running.
 * Nothing about the default changes: every other file still boots with `'0'`.
 *
 * Call it BEFORE `startTenancyApi()` — see the guard.
 */
let noShowWorkerOverride: { pollMs: number } | undefined;

/**
 * Boot THIS FILE'S API with the no-show worker running, polling every `pollMs`.
 *
 * `pollMs` is the whole reason this takes an argument: `api/src/env.ts` defaults
 * `NO_SHOW_POLL_MS` to 30_000, and a spec that waited half a minute for a timer is
 * a spec somebody deletes. A few hundred milliseconds turns the same proof into a
 * one-second wait.
 */
export function bootWithNoShowWorker(pollMs: number): void {
  if (base !== '') {
    throw new Error(
      'bootWithNoShowWorker() must be called BEFORE startTenancyApi(). The boot env is read ' +
        'once, when the API process is spawned, so an override set afterwards would leave this ' +
        'file asserting against a server that never got it.',
    );
  }
  noShowWorkerOverride = { pollMs };
}

/**
 * Whether the API this file booted is running its own no-show worker.
 *
 * The const above answers "did the operator ask for one"; this answers "is there
 * one", which is what a precondition about interference actually wants to know.
 */
export function noShowWorkerIsRunning(): boolean {
  return noShowWorkerOverride !== undefined || NO_SHOW_WORKER_ENABLED;
}

/**
 * The attempt budget the API under test runs with, PINNED HERE rather than left to
 * `env.ts`'s default of 6.
 *
 * A spec about the dead letter has to park a row AT the budget, so it has to know
 * what the budget is. Reading it from lane A's default would make the literal a
 * restatement of the implementation — and a spec that computes its own fixture from
 * the value it is testing against passes whatever that value becomes, including
 * zero. Three is also cheaper to drive than six.
 */
export const RECEIPT_MAX_ATTEMPTS = 3;

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
 * AND `--filter` IS A SECOND WAY THAT SEED REACHES THE WRONG DATABASE, worse than
 * the first because it does not need another lane to be careless. `pnpm --filter
 * @avo/api run db:seed` resolves the filter against whatever workspace the shell's
 * cwd belongs to, and FOUR worktrees of this repository each contain a package
 * called `@avo/api`. Lane A ran it from inside its own worktree and hit
 * `~/dev/avo-wallet/api` against `avo_lane_b`; the output looked entirely normal.
 * For lane D that is not a wasted run, it is a seed truncating another lane's
 * fixtures — the 401 mechanism above, arriving from a command that appeared to be
 * scoped.
 *
 * So the advice printed by this suite now says `pnpm --dir ./api run db:seed`,
 * which is unambiguous because it names a path instead of a package name. NOTHING
 * HERE EXECUTES EITHER FORM: `runApiDbScriptResult` invokes lane A's scripts
 * directly with `cwd: join(repoRoot, 'api')`, and `repoRoot` is derived from
 * `import.meta.url`, so it is always THIS worktree no matter where the runner was
 * started. The hazard only ever lives in a command a human copies out of an error
 * message, which is why the error messages were the thing to fix.
 *
 * AND IT IS ONE DATABASE PER RUN, NOT ONE DATABASE CALLED `avo_qa`.
 * ------------------------------------------------------------------
 * The paragraphs above were right about the hazard and wrong about the scope of
 * the fix, and the difference cost two days of "dev is green" that was not.
 *
 * `avo_qa` was a CONSTANT. Every git worktree on this machine carries a copy of
 * this file, every copy resolved that constant to the same eleven characters, and
 * they all shell out to the same `avo-postgres` container. So "lane D's own
 * database" was lane D's own database only in the sense that no other lane's
 * *seed script* wrote to it — any other CHECKOUT running this same suite landed
 * in it, on the same fixtures, at the same time. Two suites a few seconds out of
 * phase produce exactly the reported signature: a balance short by 11 000 fils
 * (one 10.000 KD top-up plus the silver 10%), visits ahead by one or two, and a
 * balance that has snapped back to `QA_MEMBER_BALANCE_FILS` because the other
 * run's `seedQaMember()` reset the row mid-file. Reproduced deliberately: two
 * copies of this suite started twenty seconds apart failed 7 and 4 specs, which
 * are two of the four counts that started this investigation.
 *
 * A leaked API process is the same problem in time rather than in space. A run
 * that is SIGKILLed leaves `api/src/server.ts` detached and alive — one was found
 * two and a half hours old, still polling `receipt_job` in `avo_qa` — so the next
 * run shared its fixtures with a ghost of the last one.
 *
 * Both disappear if the database name cannot be guessed by anybody else. The name
 * is minted once per run in `support/global-setup.ts`, handed to the workers in
 * `AVO_QA_DB`, and dropped in that file's teardown. Nothing else on the machine
 * can name it, so nothing else can write to it — including this suite's own
 * previous run.
 *
 * SETTING IT UP — see `ensureDatabase()` below, which does it automatically and
 * says what it did.
 */

/**
 * Run databases are named so a sweep can recognise and age them out. Anything
 * outside this prefix is somebody's deliberate database and is never touched.
 */
export const RUN_DB_PREFIX = 'avo_qa_run_';

/** A name nothing else on this machine will mint: clock, pid and entropy. */
export function newRunDatabaseName(): string {
  const stamp = Math.floor(Date.now() / 1000);
  return `${RUN_DB_PREFIX}${stamp}_${process.pid}_${randomBytes(3).toString('hex')}`;
}

/**
 * POSTGRES_DB is the deliberate opt-out: a named, long-lived database that this
 * suite does not own. It is never created from empty and never dropped.
 */
const EXPLICIT_DB = process.env.POSTGRES_DB;

/** True when this run minted its database and is therefore allowed to drop it. */
export const ownsItsDatabase = (): boolean => EXPLICIT_DB === undefined;

let resolvedDb: string | undefined;

/**
 * The database every helper in this file talks to.
 *
 * Resolved lazily and cached, NOT captured at import time. `global-setup.ts` sets
 * `AVO_QA_DB` and this module has to see that value however the import order
 * happens to fall — a `const` read at module load is precisely the kind of
 * ordering trap this whole change exists to remove.
 */
export function pgDb(): string {
  if (resolvedDb) return resolvedDb;
  const fromSetup = process.env.AVO_QA_DB;
  if (!EXPLICIT_DB && !fromSetup) {
    // Only reachable if this module is imported outside a vitest run, since the
    // global setup that mints the name is wired into vitest.config.ts. Mint one
    // rather than throw, and say so — an unexpected database is easier to explain
    // than an unexplained crash.
    const minted = newRunDatabaseName();
    // eslint-disable-next-line no-console
    console.warn(
      `[lane D] AVO_QA_DB is not set, so support/global-setup.ts did not run. ` +
        `Minting "${minted}" for this process; it will not be dropped automatically.`,
    );
    resolvedDb = minted;
    return resolvedDb;
  }
  resolvedDb = EXPLICIT_DB ?? fromSetup!;
  return resolvedDb;
}

/** The maintenance database, for CREATE DATABASE and the existence probe. */
const PG_MAINTENANCE_DB = 'postgres';

/**
 * HOW LONG A `docker exec psql` IS ALLOWED TO TAKE, AND WHY THERE IS A LIMIT.
 *
 * Every database read in this directory is a fresh `docker exec` — hundreds per
 * run — and `execFileSync` blocks the worker thread with no deadline. When one of
 * them stalls, vitest cannot interrupt it: the spec simply stops for as long as
 * Docker takes, and if that outlasts `testTimeout` the report says "Test timed
 * out in 20000ms" about a spec whose own work takes 900 milliseconds.
 *
 * That happened once in eight full `pnpm check` runs, on
 * `integration.test.ts > KNET is 150 fils flat` — 21 593ms against a median of
 * 900ms, with every neighbouring spec normal. A stall, not a slow query.
 *
 * The deadline does not stop the stall. What it does is make the next one say
 * what it was: "docker exec did not answer in 10s" names Docker, and lets a
 * read-only query be attempted a second time. Both beat a mute 20-second gap.
 *
 * THE REAL FIX is not this. It is to stop shelling out at all: Postgres is
 * published on 127.0.0.1:5433, `connectionEnv()` already builds the URL, and a
 * client library would remove several hundred process spawns per run along with
 * this entire class. That is a large change to a 1 300-line harness and it is in
 * the lane report rather than in this commit.
 */
const DOCKER_EXEC_TIMEOUT_MS = 10_000;

function isTimeoutKill(err: unknown): boolean {
  // execFileSync reports a `timeout` kill as SIGTERM on the error object.
  const e = err as { signal?: string | null; killed?: boolean };
  return e?.killed === true || e?.signal === 'SIGTERM';
}

/**
 * Run SQL as the database owner and return stdout.
 *
 * `-v ON_ERROR_STOP=1` matters: without it psql exits 0 after a failed statement
 * and a broken seed reads as a passing suite.
 *
 * NOT RETRIED, unlike `scalar()` below. This one carries writes — a seed, a
 * fixture reset, a PIN counter — and a statement that may or may not have
 * committed before the client gave up is not something to run twice on a hunch.
 */
export function psql(sql: string): string {
  try {
    return execFileSync(
      'docker',
      ['exec', '-i', PG_CONTAINER, 'psql', '-U', PG_USER, '-d', pgDb(), '-v', 'ON_ERROR_STOP=1'],
      {
        input: sql,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: DOCKER_EXEC_TIMEOUT_MS,
      },
    );
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message?: string };
    const why = isTimeoutKill(err)
      ? `docker exec did not answer in ${DOCKER_EXEC_TIMEOUT_MS / 1000}s — the container is ` +
        'wedged or the daemon is stalling, and this is NOT a SQL failure.\n'
      : '';
    throw new Error(
      `psql failed against container "${PG_CONTAINER}".\n` +
        why +
        'Is lane A\'s Postgres up?  pnpm --dir ./api run db:up\n' +
        `--- sql ---\n${sql.trim()}\n--- stderr ---\n${String(e.stderr ?? e.message ?? '')}`,
    );
  }
}

/**
 * One scalar. Empty string when the query returns no row.
 *
 * ATTEMPTED TWICE, AND ONLY EVER ON A STALL. A SQL error, a bad column, a
 * connection refused — every failure that carries a message from psql — is
 * re-thrown on the first attempt, because retrying those would be hiding a
 * defect. The second attempt exists for one condition: the process was killed by
 * the deadline above without saying anything, which is a property of Docker's
 * scheduling and not of the query. It says so out loud when it happens, so a
 * suite that starts needing the retry regularly cannot do it quietly.
 */
export function scalar(sql: string): string {
  return scalarOn(pgDb(), sql);
}

/**
 * Give back branches a suite created, without lying about the money that landed
 * on them.
 *
 * WHY THIS IS NOT `DELETE FROM branch`. It was, and it failed on the first run
 * with a foreign key: `transaction_branch_id_branch_id_fk`, because a branch
 * created MID-FILE immediately becomes what `resolveBranch` attributes to. Lane A
 * mints ids as `BR-` plus random base36, so a probe branch beats `BR-LUM-HAW`
 * alphabetically about three times in five, and every later charge in that file
 * is recorded against a row the teardown was planning to remove. Deleting it
 * would have meant deleting or re-pointing real transactions, which is a suite
 * rewriting money history to tidy up after itself.
 *
 * So: CLOSE everything named, which is the product's own retirement and is
 * exactly what `resolveBranch` filters on — a closed branch cannot win another
 * tie-break or change another salon's open-branch count. Then delete only the
 * rows nothing points at, so the common case still leaves no trace.
 *
 * `boost` is cleared first and unconditionally: `PUT …/promotions/boosts` writes
 * a row per open branch, those rows are configuration rather than history, and
 * they are re-derived from the salon's branches on the next publish.
 */
export function retireBranches(salonId: string, ids: string[]): void {
  if (ids.length === 0) return;
  const list = ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');
  psql(`
    UPDATE branch SET closed_at = now()
     WHERE salon_id = '${salonId}' AND id IN (${list}) AND closed_at IS NULL;

    DELETE FROM boost WHERE salon_id = '${salonId}' AND branch_id IN (${list});

    DELETE FROM branch b
     WHERE b.salon_id = '${salonId}' AND b.id IN (${list})
       AND NOT EXISTS (SELECT 1 FROM transaction  t WHERE t.branch_id  = b.id)
       AND NOT EXISTS (SELECT 1 FROM topup_intent i WHERE i.branch_id  = b.id)
       AND NOT EXISTS (SELECT 1 FROM happy_hour   h WHERE h.branch_id  = b.id)
       AND NOT EXISTS (SELECT 1 FROM booking      k WHERE k.branch_id  = b.id);
  `);
}

/** The ids of a salon's branches whose name starts with `prefix`. */
export function branchIdsNamed(salonId: string, prefix: string): string[] {
  const rows = scalar(
    `select id from branch where salon_id='${salonId}' and name like '${prefix.replace(/'/g, "''")}%'`,
  );
  return rows === '' ? [] : rows.split('\n').map((s) => s.trim());
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

/** One scalar against a NAMED database. Used before `pgDb()` is known to exist. */
function scalarOn(database: string, sql: string): string {
  for (let attempt = 1; ; attempt++) {
    try {
      return execFileSync(
        'docker',
        ['exec', '-i', PG_CONTAINER, 'psql', '-U', PG_USER, '-d', database, '-tAc', sql],
        { encoding: 'utf8', timeout: DOCKER_EXEC_TIMEOUT_MS },
      ).trim();
    } catch (err) {
      if (attempt === 1 && isTimeoutKill(err)) {
        // eslint-disable-next-line no-console
        console.warn(
          `[lane D] a read against "${database}" was killed after ` +
            `${DOCKER_EXEC_TIMEOUT_MS / 1000}s with no output from psql — docker exec stalled. ` +
            'Reading once more. If this line is showing up often, the harness needs a Postgres ' +
            'client rather than several hundred process spawns a run.\n' +
            `--- sql ---\n${sql.trim()}`,
        );
        continue;
      }
      const e = err as { stderr?: Buffer | string; message?: string };
      throw new Error(
        `A read against "${database}" on container "${PG_CONTAINER}" failed` +
          (isTimeoutKill(err)
            ? ` twice, each time killed after ${DOCKER_EXEC_TIMEOUT_MS / 1000}s with nothing on ` +
              'stderr. That is Docker, not SQL.'
            : '.') +
          `\n--- sql ---\n${sql.trim()}\n--- stderr ---\n${String(e.stderr ?? e.message ?? '')}`,
      );
    }
  }
}

// ------------------------------------------------------------ the bootstrap --

/**
 * Create this run's database if it is not there, and leave it migrated and seeded.
 *
 * Idempotent and cheap after the first call: one `SELECT` against `pg_database`.
 *
 * IT MIGRATES AND SEEDS FROM EMPTY — THE `pg_dump` CLONE IS GONE
 * --------------------------------------------------------------
 * It used to clone the shared `avo` database with `pg_dump`, because
 * `api/src/db/seed.ts` inserted `artist` rows referencing `staff_user_id = 'ST-002'`
 * before it inserted `staff_user`, and so died on the foreign key against any
 * database that had never been seeded:
 *
 *     ERROR 23503  Key (staff_user_id)=(ST-002) is not present in table "staff_user"
 *
 * Lane A has since moved the `staff_user` inserts above the `artist` insert, and
 * `seed.test.ts` in this directory is the standing proof: it creates an empty
 * database, migrates it, seeds it and checks the fixtures, on every run.
 *
 * Keeping the clone after that would have been worse than redundant. It meant
 * lane D's database was built by a path NOTHING ELSE USES — not CI, not a laptop
 * running `db:up && db:migrate && db:seed`, not staging. A harness that
 * provisions itself differently from production stops being able to tell you
 * anything about production, and it does it quietly: the clone would have carried
 * a hand-made column or a missing grant straight into the suite and the suite
 * would have gone green on it. The very defect the clone was invented to route
 * around is the defect it would have hidden next time.
 *
 * So: `CREATE DATABASE`, then lane A's own migrator, then lane A's own seed. The
 * same three steps a new environment gets, run about five seconds slower than a
 * clone and worth every one of them.
 */
function ensureDatabase(): void {
  const db = pgDb();
  const exists =
    scalarOn(PG_MAINTENANCE_DB, `select 1 from pg_database where datname='${db}'`) === '1';
  if (exists) return;

  // eslint-disable-next-line no-console
  console.log(`[lane D] provisioning "${db}" — migrate and seed from empty, lane A's own scripts.`);

  try {
    execFileSync(
      'docker',
      [
        'exec', '-i', PG_CONTAINER, 'psql', '-U', PG_USER, '-d', PG_MAINTENANCE_DB,
        '-v', 'ON_ERROR_STOP=1',
        '-c', `CREATE DATABASE ${db} OWNER ${PG_USER}`,
        // `avo_app` is a CLUSTER-level role, so it already exists; only the
        // per-database CONNECT privilege has to be granted for the new database.
        '-c', `GRANT CONNECT ON DATABASE ${db} TO avo_app`,
      ],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message?: string };
    throw new Error(
      `Could not create "${db}" on container "${PG_CONTAINER}".\n` +
        'Is lane A\'s Postgres up?  pnpm --dir ./api run db:up\n' +
        `--- stderr ---\n${String(e.stderr ?? e.message ?? '')}`,
    );
  }

  const migrated = migrateDatabase(db);
  if (!migrated.ok) {
    throw new Error(
      `api/src/db/migrate.ts failed against the empty database "${db}", so no environment can ` +
        `be provisioned at all — see seed.test.ts, which asserts this same path.\n` +
        `--- stderr ---\n${migrated.stderr}`,
    );
  }

  const seeded = seedDatabase(db);
  if (!seeded.ok) {
    throw new Error(
      `api/src/db/seed.ts failed against the freshly migrated database "${db}". This is the ` +
        'foreign-key ordering class of defect: the seed passes on any database that has been ' +
        'seeded before, because the rows its foreign keys need are already there.\n' +
        `--- stderr ---\n${seeded.stderr}`,
    );
  }

  // eslint-disable-next-line no-console
  console.log(`[lane D] "${db}" is ready — lane A's schema, lane A's seed, nobody else's writes.`);
}

/**
 * Run lane A's seed against lane D's database.
 *
 * Exported because it is the recovery move when a fixture has been mangled, and
 * because it is now SAFE to run at any time — the whole point of the isolated
 * database is that this cannot take another lane's session down.
 */
export function reseed(): void {
  runApiDbScript('src/db/seed.ts', pgDb());
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

/**
 * The same script, run WITHOUT blocking — so two passes can be in flight at once.
 *
 * `runApiDbScriptResult` uses `execFileSync`, which makes two sequential runs easy
 * and two SIMULTANEOUS runs impossible. That matters for the no-show job: its
 * candidate scan is unlocked and its status re-check under the row lock exists
 * purely for the window between them, so a race is the only thing that can exercise
 * it. Two sequential passes are protected by the scan predicate instead, and prove
 * something different — which is worth knowing rather than conflating.
 */
export function runApiDbScriptAsync(script: string, database: string): Promise<ApiScriptResult> {
  return new Promise((resolve) => {
    const child = spawn(apiTsx(), [script], {
      cwd: join(repoRoot, 'api'),
      env: { ...process.env, ...connectionEnv(database) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr?.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('close', (code) => resolve({ ok: code === 0, stdout, stderr }));
    child.on('error', (err) => resolve({ ok: false, stdout, stderr: String(err) }));
  });
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

// ----------------------------------------------- the run database's lifetime --

/**
 * Drop the run databases that earlier runs did not get to drop themselves.
 *
 * A run that is Ctrl-C'd or SIGKILLed never reaches `global-setup.ts`'s teardown,
 * so its database survives. One is invisible; a fortnight of them is a Postgres
 * data directory nobody understands. This sweeps them on the way in.
 *
 * TWO GUARDS, AND BOTH ARE LOAD-BEARING. Only names carrying `RUN_DB_PREFIX` are
 * considered — `avo`, `avo_qa`, and anything a person named deliberately are
 * untouchable. And only names whose embedded timestamp is older than
 * `maxAgeSeconds` are dropped, so a suite running RIGHT NOW in another checkout
 * cannot have its database pulled out from under it. Dropping a live one would be
 * this whole class of bug all over again, with a worse failure mode.
 *
 * Best-effort by design: it runs before anything needs Postgres, and a machine
 * with no container should still be able to run the mock-backed suites.
 */
export function sweepStaleRunDatabases(maxAgeSeconds = 2 * 60 * 60): string[] {
  let names: string[];
  try {
    names = scalarOn(
      PG_MAINTENANCE_DB,
      `select datname from pg_database where datname like '${RUN_DB_PREFIX}%'`,
    )
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return []; // no container, no sweep, no complaint
  }

  const cutoff = Math.floor(Date.now() / 1000) - maxAgeSeconds;
  const dropped: string[] = [];
  for (const name of names) {
    const stamp = Number(name.slice(RUN_DB_PREFIX.length).split('_')[0]);
    if (!Number.isFinite(stamp) || stamp >= cutoff) continue;
    // `dropDatabase` uses WITH (FORCE), which is what makes this work at all: a
    // leaked API process from a killed run holds its connection pool open
    // indefinitely, and a plain DROP would fail on it forever.
    dropDatabase(name);
    dropped.push(name);
  }
  return dropped;
}

/**
 * Drop this run's database, if this run is the one that minted it.
 *
 * Refuses when `POSTGRES_DB` named the database: that is somebody's long-lived
 * environment and dropping it would be a considerably worse bug than the one this
 * file exists to fix.
 *
 * AND IT REFUSES ANY NAME THIS FILE DID NOT MINT, which `ownsItsDatabase()` alone
 * does not cover. That check reads `POSTGRES_DB` and nothing else, so an
 * externally supplied `AVO_QA_DB` used to satisfy it: `global-setup.ts` skips
 * minting when it sees that variable — the run therefore does NOT own the
 * database — and teardown would nonetheless call `DROP DATABASE … WITH (FORCE)`
 * on whatever it named.
 *
 *     AVO_QA_DB=avo_lane_d ../node_modules/.bin/vitest run
 *
 * is a plausible thing for a lane to type — LANES.md points at `lane-db.sh d` for
 * ad-hoc driving and tells you to keep `POSTGRES_DB` unset, which is precisely the
 * combination — and it would have destroyed a trunk-owned database at teardown,
 * silently, because `dropDatabase` swallows its own errors.
 *
 * `sweepStaleRunDatabases` has carried the equivalent guard since it was written
 * ("only names carrying `RUN_DB_PREFIX` are considered"). This is the same rule on
 * the other drop path, which did not have it.
 */
export function dropRunDatabase(): string | undefined {
  if (!ownsItsDatabase()) return undefined;
  const db = pgDb();
  if (!isOwnRunDatabaseName(db)) {
    // eslint-disable-next-line no-console
    console.log(
      `[lane D] not dropping "${db}": it does not carry ${RUN_DB_PREFIX}, so this run did not ` +
        'mint it. Set AVO_QA_DB only to a database you are willing to lose, or leave it unset.',
    );
    return undefined;
  }
  dropDatabase(db);
  return db;
}

/**
 * Is this a name `newRunDatabaseName()` produced? The prefix is the proof of
 * authorship: nothing else in this repository emits it, so a name without it came
 * from somewhere else and is not ours to drop.
 *
 * EXPORTED SO IT CAN BE TESTED, and that is not incidental. `pgDb()` caches
 * `resolvedDb` on its first call, deliberately — see its own comment — so a spec
 * cannot exercise `dropRunDatabase()` twice with two different names in one
 * worker: the second `AVO_QA_DB` is never read. The decision therefore has to be
 * reachable on its own, or the accept half of it is untestable and only the refuse
 * half ever gets a spec. That asymmetry is exactly how a guard ends up broken shut
 * with a green suite behind it.
 */
export function isOwnRunDatabaseName(database: string): boolean {
  return database.startsWith(RUN_DB_PREFIX);
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
        '  pnpm --dir ./api run db:up',
    );
  }

  if (!existsSync(apiTsx())) {
    throw new Error(
      'The API\'s dependencies are not installed, so it cannot be started.\n  pnpm install',
    );
  }

  // Creates and seeds `pgDb()` the first time, then returns immediately.
  ensureDatabase();

  /**
   * MIGRATE ON EVERY FILE, NOT ONLY AT CREATION.
   *
   * Redundant for the normal path now that the database is minted per run and
   * `ensureDatabase()` migrates it from empty — and kept anyway, because the
   * `POSTGRES_DB` opt-out points this suite at a long-lived database that nobody
   * migrates on its behalf. This suite went red on
   * `relation "happy_hour" does not exist` the day lane A landed promotions, which
   * is a stale-schema problem wearing a missing-feature costume.
   *
   * `migrate()` is idempotent and skips applied migrations, so this costs a
   * `SELECT` against the journal and removes the whole class.
   */
  const migrated = migrateDatabase(pgDb());
  if (!migrated.ok) {
    throw new Error(
      `Could not bring "${pgDb()}" up to date with lane A's migrations.\n` +
        `--- stderr ---\n${migrated.stderr}`,
    );
  }

  const tables = scalar(
    "select count(*) from information_schema.tables where table_schema='public' and table_name in ('salon','staff_user','member','wallet_token','idempotency_key')",
  );
  if (tables !== '5') {
    throw new Error(
      `The schema in "${pgDb()}" is not migrated — this suite reads and writes real rows.\n` +
        `  DATABASE_URL=postgres://avo:avo_dev_password@127.0.0.1:5433/${pgDb()} ` +
        'pnpm --dir ./api run db:migrate',
    );
  }

  const seeded = scalar(
    `select count(*) from staff_user where id='${A_STAFF_FULL}' and salon_id='${SALON_A}'`,
  );
  if (seeded !== '1') {
    throw new Error(
      `Salon A is not seeded in "${pgDb()}" — ${A_STAFF_FULL} is missing, and salon B copies ` +
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
ON CONFLICT (id) DO UPDATE SET
  -- TIMEZONE ONLY, and it is reset every run on purpose. promotions.test.ts moves
  -- salon B to a midday zone for the length of that file -- a salon clock near
  -- midnight cannot express a happy hour window at all, see its header -- and
  -- restores it in afterAll. A crash between those two points would otherwise
  -- leave the next run's availability and business-hours assertions measured
  -- against Honolulu, so the seed puts it back rather than trusting a teardown.
  --
  -- Nothing else is overwritten here: the names, hours and loyalty config stay
  -- DO NOTHING, because a suite that changed one has changed a merchant's
  -- configuration and a seed that silently reverted it would hide that.
  timezone = 'Asia/Kuwait';

-- The two fixture branches. Their NAMES are left alone on conflict: a suite that
-- renamed one has changed a merchant's configuration, and a seed that silently
-- put it back would hide that. closed_at is the exception, and it is reset every
-- run — a branch this seed left open must not start the next run closed, because
-- an open-branch count of one is a different product (see services/branch.ts)
-- and nothing in the fixture would say which suite closed it.
INSERT INTO branch (id, salon_id, name)
VALUES ('${B_BRANCH}', '${SALON_B}', 'Hawally'),
       ('${B_BRANCH_SECOND}', '${SALON_B}', 'Jabriya')
ON CONFLICT (id) DO UPDATE SET closed_at = NULL;

-- The disposable one. Name AND closed_at both reset, because the specs that use
-- it rename it and close it on purpose. See the constant's own comment.
INSERT INTO branch (id, salon_id, name)
VALUES ('${B_BRANCH_DISPOSABLE}', '${SALON_B}', 'Salmiya (disposable)')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, closed_at = NULL;

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

-- TWO STAFF ROWS THAT EXIST ONLY TO HAVE THEIR OWN LOOKUP BUDGET.
--
-- GET /members?q= now has a SECOND rate-limit tier: 60 per rolling hour keyed on
-- the staff member alone, with no session and no device in the predicate. That tier
-- is right — a session was never scarce, so a per-session limit was resettable by
-- signing out and back in — and it makes one thing about this suite wrong.
--
-- scanner.test.ts spends most of an hour's budget under ONE staff id: the shared
-- scanner session's row is also the row the 30-lookup burst spec and the
-- 29-lookup "counter is the log" spec sign in as. Measured against lane A's branch
-- before the merge, that reached the ceiling and "THE COUNTER IS THE LOG" failed on
-- its 19th lookup with lookup_hourly_limit, passing in isolation.
--
-- The fix is staff spread, NOT a weakened limit. A suite that needs a production
-- control turned down is the suite that is wrong, and a ceiling of 60 an hour that
-- the test suite cannot live inside is worth knowing about precisely because a busy
-- front desk has the same problem.
--
-- So: one row per heavy spec, named for the budget rather than for a person,
-- because that is what they are for. audit_log cannot be trimmed by anybody, so a
-- spec that spends a budget spends it for the whole run — which is exactly why each
-- of these belongs to one spec and no other.
INSERT INTO staff_user (id, salon_id, name, handle, role, branch_access_all, branch_access_ids,
                        password_hash, pin_hash, pin_device_id, perm_scanner)
SELECT '${B_STAFF_BURST}', '${SALON_B}', 'Budget Burst', '${B_STAFF_BURST_HANDLE}', 'frontdesk',
       true, '{}', s.password_hash, s.pin_hash, '${B_BURST_DEVICE}', true
FROM staff_user s WHERE s.id = '${A_STAFF_FULL}'
ON CONFLICT (id) DO UPDATE SET
  pin_hash = EXCLUDED.pin_hash, pin_device_id = '${B_BURST_DEVICE}', perm_scanner = true;

INSERT INTO staff_user (id, salon_id, name, handle, role, branch_access_all, branch_access_ids,
                        password_hash, pin_hash, pin_device_id, perm_scanner)
SELECT '${B_STAFF_COUNTER}', '${SALON_B}', 'Budget Counter', '${B_STAFF_COUNTER_HANDLE}',
       'frontdesk', true, '{}', s.password_hash, s.pin_hash, '${B_COUNTER_DEVICE}', true
FROM staff_user s WHERE s.id = '${A_STAFF_FULL}'
ON CONFLICT (id) DO UPDATE SET
  pin_hash = EXCLUDED.pin_hash, pin_device_id = '${B_COUNTER_DEVICE}', perm_scanner = true;

INSERT INTO staff_user (id, salon_id, name, handle, role, branch_access_all, branch_access_ids,
                        password_hash, pin_hash, pin_device_id, perm_scanner)
SELECT '${B_STAFF_CROSSDOOR}', '${SALON_B}', 'Budget Crossdoor',
       '${B_STAFF_CROSSDOOR_HANDLE}', 'frontdesk', true, '{}', s.password_hash, s.pin_hash,
       '${B_CROSSDOOR_DEVICE}', true
FROM staff_user s WHERE s.id = '${A_STAFF_FULL}'
ON CONFLICT (id) DO UPDATE SET
  pin_hash = EXCLUDED.pin_hash, pin_device_id = '${B_CROSSDOOR_DEVICE}', perm_scanner = true;

-- The two branch-scoped rows the closure-preview identity spec re-scopes. Seeded
-- against the salon's real branch so they start valid; the spec adds the branch it
-- is about to close and restores them afterwards.
--
-- branch_access_all = false with a non-empty id list is what
-- staff_user_branch_access_exclusive requires, and it is also what makes them
-- visible to branchClosureImpact at all: the impact query matches on
-- = ANY(branch_access_ids), which never finds an all-branch principal.
INSERT INTO staff_user (id, salon_id, name, handle, role, branch_access_all, branch_access_ids,
                        password_hash, perm_scanner)
SELECT '${B_STAFF_BRANCH_SURVIVOR}', '${SALON_B}', 'Branch Survivor', 'branchsurvivor',
       'frontdesk', false, ARRAY['${B_BRANCH}'], s.password_hash, true
FROM staff_user s WHERE s.id = '${A_STAFF_FULL}'
ON CONFLICT (id) DO UPDATE SET
  branch_access_all = false, branch_access_ids = ARRAY['${B_BRANCH}'];

INSERT INTO staff_user (id, salon_id, name, handle, role, branch_access_all, branch_access_ids,
                        password_hash, perm_scanner)
SELECT '${B_STAFF_BRANCH_STRANDED}', '${SALON_B}', 'Branch Stranded', 'branchstranded',
       'frontdesk', false, ARRAY['${B_BRANCH}'], s.password_hash, true
FROM staff_user s WHERE s.id = '${A_STAFF_FULL}'
ON CONFLICT (id) DO UPDATE SET
  branch_access_all = false, branch_access_ids = ARRAY['${B_BRANCH}'];

-- The two authority probes: every permission OFF. authority.test.ts grants one at
-- a time and restores them, so their seeded state has to be the empty one.
INSERT INTO staff_user (id, salon_id, name, handle, role, branch_access_all, branch_access_ids,
                        password_hash, pin_hash, pin_device_id,
                        perm_dashboard, perm_appointments, perm_shop, perm_loyalty, perm_team,
                        perm_scanner, perm_charges, perm_void, perm_marketing)
-- NO pin_hash: staff_user_pin_is_device_scoped requires a device alongside one,
-- and this probe is the WEB principal. A PIN here would also make it the wrong
-- fixture — the point of two rows is that each holds exactly one kind of credential.
SELECT '${B_STAFF_AUTH_WEB}', '${SALON_B}', 'Authority Web', '${B_STAFF_AUTH_WEB_HANDLE}',
       'frontdesk', true, '{}', s.password_hash, NULL, NULL,
       false, false, false, false, false, false, false, false, false
FROM staff_user s WHERE s.id = '${A_STAFF_FULL}'
ON CONFLICT (id) DO UPDATE SET
  perm_dashboard = false, perm_appointments = false, perm_shop = false, perm_loyalty = false,
  perm_team = false, perm_scanner = false, perm_charges = false, perm_void = false,
  perm_marketing = false;

INSERT INTO staff_user (id, salon_id, name, handle, role, branch_access_all, branch_access_ids,
                        password_hash, pin_hash, pin_device_id,
                        perm_dashboard, perm_appointments, perm_shop, perm_loyalty, perm_team,
                        perm_scanner, perm_charges, perm_void, perm_marketing)
SELECT '${B_STAFF_AUTH_PIN}', '${SALON_B}', 'Authority Pin', '${B_STAFF_AUTH_PIN_HANDLE}',
       'frontdesk', true, '{}', s.password_hash, s.pin_hash, '${B_AUTH_PIN_DEVICE}',
       false, false, false, false, false, false, false, false, false
FROM staff_user s WHERE s.id = '${A_STAFF_FULL}'
ON CONFLICT (id) DO UPDATE SET
  pin_hash = EXCLUDED.pin_hash, pin_device_id = '${B_AUTH_PIN_DEVICE}',
  perm_dashboard = false, perm_appointments = false, perm_shop = false, perm_loyalty = false,
  perm_team = false, perm_scanner = false, perm_charges = false, perm_void = false,
  perm_marketing = false;

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

/**
 * Read `apiExit` through a call, so the compiler cannot narrow it away.
 *
 * `bootApiOnce` sets `apiExit = undefined` before spawning, and the value is then
 * written by the child's `exit` handler — asynchronously, which control-flow
 * analysis cannot see. Reading the variable directly after that assignment narrows
 * it to `undefined` and then to `never` inside the guard, so `.code` stops
 * compiling. A function return carries the declared type instead.
 */
function apiExitStatus(): { code: number | null; signal: string | null } | undefined {
  return apiExit;
}

/**
 * The tail of the API's own stdout/stderr.
 *
 * The harness has always captured this and only ever shown it when a BOOT failed,
 * so a 500 from a request mid-run surfaced as `{"error":"server_error"}` and
 * nothing else — the stack existed, four lines away, and no spec could reach it.
 * Seven promotions specs were diagnosed by adding this; it should have been here
 * from the start.
 */
export function apiLogTail(lines = 40): string {
  const all = apiOutput.split('\n');
  return all.slice(Math.max(0, all.length - lines)).join('\n');
}

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

/**
 * How many times a boot may lose the port race before it is treated as a real
 * failure. Three retries, because the race is between this process and the OS's
 * ephemeral allocator and losing it twice in a row is already improbable.
 */
const API_BOOT_ATTEMPTS = 4;

/**
 * Start lane A's API, retrying if the port was taken between choosing it and
 * binding it.
 *
 * WHY A RETRY IS THE RIGHT SHAPE HERE, AND WHAT IT IS NOT
 * ------------------------------------------------------
 * `freePort()` asks the OS for an ephemeral port, CLOSES the probe socket, and
 * only then does the child bind. That gap is unavoidable — the child is a separate
 * process and cannot inherit the listener — and it is a genuine race, not a leak:
 *
 *     Error: listen EADDRINUSE: address already in use 0.0.0.0:52437
 *
 * That was a real full-suite failure. It took contract.test.ts's whole `beforeAll`
 * with it, so 81 specs reported as SKIPPED rather than failed, and the run before
 * it had been green on the same tree. A `ps` sweep and a port scan immediately
 * afterwards were both empty, which is what rules out the leaked-process
 * explanation LANES.md warns about: nothing was holding the port by then, because
 * the collision was with an allocation this run had just released.
 *
 * Fourteen files each boot an API, so this is drawn fourteen times a run.
 *
 * IT IS NOT A RETRY OVER FAILURE IN GENERAL. Only `EADDRINUSE` is retried. A boot
 * that dies for any other reason — a bad migration, a missing env, a syntax error —
 * still fails on the first attempt with its output attached, because retrying those
 * would turn a five-second diagnosis into a twenty-second one and say "flaky" about
 * something that is not.
 */
export async function startTenancyApi(): Promise<void> {
  preflight();
  seedSalonB();
  seedQaMember();

  for (let attempt = 1; attempt <= API_BOOT_ATTEMPTS; attempt++) {
    if (await bootApiOnce()) return;
    // eslint-disable-next-line no-console
    console.log(
      `[lane D] the API lost the port race on attempt ${attempt}/${API_BOOT_ATTEMPTS}; ` +
        'retrying on a fresh port.',
    );
  }

  throw new Error(
    `Lane A's API could not bind a free port in ${API_BOOT_ATTEMPTS} attempts, every one of ` +
      'them EADDRINUSE. That is no longer a race: something on this machine is taking ' +
      'ephemeral ports as fast as they are offered, or a previous run leaked a server. Check ' +
      'with a port scan and a `ps` sweep before treating it as a suite failure.',
  );
}

/**
 * One boot attempt. `true` if the API came up healthy, `false` if — and ONLY if —
 * it died because the port was already taken.
 *
 * Throws for every other failure, with the server's output, exactly as before.
 */
async function bootApiOnce(): Promise<boolean> {
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
      /**
       * THE API UNDER TEST TALKS TO THE DATABASE THIS HARNESS TALKS TO. ALWAYS.
       *
       * These two used to be `process.env.DATABASE_URL ?? …`, which meant an
       * ambient `DATABASE_URL` silently won — and CI sets one at job level,
       * pointing at the shared `avo`. The harness would then read fixtures out of
       * one database with `psql` while the server it booted wrote them to another,
       * so every delta assertion in this directory would be comparing two
       * unrelated wallets. An inherited connection string is not a configuration
       * knob here, it is a way for the suite to test something it is not looking
       * at. `POSTGRES_DB` remains the one supported way to redirect this suite,
       * and it goes through `pgDb()` like everything else.
       */
      DATABASE_URL: `postgres://avo:avo_dev_password@127.0.0.1:5433/${pgDb()}`,
      APP_DATABASE_URL: `postgres://avo_app:avo_app_dev_password@127.0.0.1:5433/${pgDb()}`,
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
      // Pinned, not defaulted — see RECEIPT_MAX_ATTEMPTS above.
      RECEIPT_MAX_ATTEMPTS: String(RECEIPT_MAX_ATTEMPTS),

      // ----------------------------------------------------- the no-show --
      // OFF, and unlike the receipt worker that is not a preference. See the
      // long note beside NO_SHOW_WORKER_ENABLED above: this loop returns
      // deposits on a 30s timer that no spec chose, which is what made
      // deposit.test.ts's racing spec fail once in two identical gate runs.
      //
      // READ HERE, AT BOOT, rather than baked into the module-level const, so
      // that `bootWithNoShowWorker()` can turn it on for ONE file — see the note
      // beside it. Every file that does not call it still boots with '0'.
      NO_SHOW_WORKER_ENABLED: noShowWorkerIsRunning() ? '1' : '0',
      /**
       * The poll interval, pinned for the same reason as RECEIPT_POLL_MS: env.ts
       * defaults it to 30_000, and a spec that proves the timer has to wait for
       * one. Inert while the worker is off.
       *
       * An ambient `NO_SHOW_POLL_MS` still wins over the default, because the note
       * above documents `NO_SHOW_WORKER_ENABLED=1 NO_SHOW_POLL_MS=1000 vitest run
       * deposit` as the way the original failure is reproduced on demand, and a
       * recipe the harness overrides is a recipe that stops working.
       */
      NO_SHOW_POLL_MS: String(
        noShowWorkerOverride?.pollMs ?? process.env.NO_SHOW_POLL_MS ?? 30_000,
      ),
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
    if (child && child.exitCode === null) signalApiGroup('SIGKILL');
  };
  process.once('exit', reap);
  process.once('SIGINT', reap);
  process.once('SIGTERM', reap);

  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await fetch(`${base}/_health`);
      if (res.ok && ((await res.json()) as { ok?: boolean }).ok === true) return true;
    } catch {
      /* not up yet */
    }

    /**
     * THE CHILD IS ALREADY DEAD — stop waiting for it.
     *
     * Without this the loop sat out the full sixty seconds polling a port nothing
     * was listening on, which is where the failing run's extra 59 seconds went
     * (323s against a 264s baseline). A process that has exited is not going to
     * become healthy, and the sooner that is said the sooner its output is read.
     */
    const exited = apiExitStatus();
    if (exited !== undefined) {
      const portTaken = /EADDRINUSE/.test(apiOutput);
      signalApiGroup('SIGKILL');
      if (portTaken) return false;
      throw new Error(
        `Lane A's API exited before becoming healthy at ${base}/_health ` +
          `(code ${exited.code}, signal ${exited.signal}).\n` +
          `--- server output ---\n${apiOutput || '(nothing on stdout/stderr)'}\n---------------------`,
      );
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

/**
 * Signal the API's whole process group, not just the process we hold a handle to.
 *
 * `apiTsx()` is the tsx CLI, which spawns the real server as a GRANDCHILD.
 * `child.kill()` reaches the CLI and nothing else, so a CLI that exits without
 * forwarding the signal leaves the server running — detached, re-parented to
 * init, and still connected to the database. One was found on this machine two
 * and a half hours after the run that made it, still polling `receipt_job`.
 *
 * `detached: true` above made the child a group leader, which is what makes the
 * negative pid legal here and what makes it reach the grandchild.
 */
function signalApiGroup(signal: NodeJS.Signals): void {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal); // the group is already gone; try the process itself
    } catch {
      /* already reaped */
    }
  }
}

export async function stopTenancyApi(): Promise<void> {
  if (!child) return;
  signalApiGroup('SIGTERM');
  const exited = new Promise<void>((r) => child?.once('exit', () => r()));
  await Promise.race([exited, new Promise((r) => setTimeout(r, 3_000))]);
  if (child.exitCode === null) signalApiGroup('SIGKILL');
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
    /**
     * A DEADLINE, FOR THE SAME REASON THE `docker exec` CALLS HAVE ONE.
     *
     * `fetch` waits for ever by default. An API that accepts the connection and
     * then stops answering — a lock it will never get, a promise nobody settles —
     * spends the spec's entire 20-second budget in silence and reports as "Test
     * timed out", which names the test and not the server. Twelve seconds is well
     * clear of the slowest legitimate request in this directory (the migration
     * chain, at about four) and comfortably inside `testTimeout`, so the message
     * below is what the reader sees instead.
     */
    res = await fetch(`${tenancyBaseUrl()}${path}`, {
      method,
      headers,
      signal: AbortSignal.timeout(12_000),
      ...(payload === undefined ? {} : { body: payload }),
    });
  } catch (err) {
    const stalled = (err as Error)?.name === 'TimeoutError';
    // An ECONNREFUSED here is almost always the API having died earlier, not a
    // networking problem. Say which, and say what it printed on the way out.
    throw new Error(
      (stalled
        ? `${method} ${path} was ACCEPTED by the API and then never answered — 12s with the ` +
          'connection open. That is the server hanging, not the test being slow.\n'
        : `${method} ${path} could not reach the API at ${tenancyBaseUrl()}.\n`) +
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
        'pnpm --dir ./api run db:seed.',
    );
  }
  return res.body.accessToken;
}

/**
 * `POST /auth/platform/session` — the owner console's front door, `platform` scope.
 *
 * THE THIRD PRINCIPAL, AND THE FIRST THAT IS NOT SALON-SCOPED. Migration 0028 made
 * `session.salon_id` nullable precisely so a platform admin can have no salon, and the
 * CHECK requires that in both directions. So this returns a token that
 * `requireSameSalon` cannot even be called with — `PlatformPrincipal` has no `salonId`
 * field, which is a compile-time boundary rather than a runtime one.
 *
 * PASSWORD FROM THE SEED, and unlike salon B's staff there is no hash-copying trick
 * here: `PLT-001`, `PLT-002` and `PLT-003` are lane A's own seeded rows and all three
 * carry `hashSecret(PLATFORM_PASSWORD)`. If this throws, the seed's constant moved.
 */
export async function signInPlatform(handle: string): Promise<string> {
  const res = await treq<SessionResponse>('POST', '/auth/platform/session', {
    token: null,
    body: { username: handle, password: PLATFORM_PASSWORD },
  });
  if (res.status !== 200 || !res.body.accessToken) {
    throw new Error(
      `Console sign-in failed for ${handle}: ${res.status} ${res.raw}\n` +
        'PLATFORM_PASSWORD in this file must match PLATFORM_PASSWORD in ' +
        'api/src/db/seed.ts. Re-run pnpm --dir ./api run db:seed if the seed moved.',
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
