/**
 * Everything one run of this suite owns, created here and destroyed here.
 *
 * TWO THINGS, AND THEY ARE THE SAME THING TWICE.
 *
 * 1. THE MOCK API, for the suites that drive `packages/mock`:
 *
 *      default          starts `packages/mock` on a free ephemeral port, so a run
 *                       never collides with a `pnpm mock` already on :4000.
 *      E2E_BASE_URL=…   points those suites at an API that is already running:
 *                           E2E_BASE_URL=http://localhost:3000 pnpm --filter @avo/e2e test
 *
 * 2. THE POSTGRES DATABASE, for the suites that drive lane A's real API through
 *    `support/tenancy-harness.ts`. Its name is minted HERE, once, and handed to
 *    the test workers in `AVO_QA_DB`.
 *
 * WHY THE NAME IS MINTED AND NOT WRITTEN DOWN
 * -------------------------------------------
 * It used to be the constant `avo_qa`, and a constant is a name every other
 * checkout of this repository resolves to as well. Four `pnpm check` runs on one
 * unchanged tree reported 7, 4, 1 and 3 failures, and the reason was not this
 * suite racing itself — `fileParallelism: false` has always ruled that out — it
 * was this suite racing a COPY of itself in another worktree, both charging the
 * same seeded member in the same database on the same container. Running two
 * copies deliberately reproduces it exactly: 7 failures and 4.
 *
 * An ephemeral port is how the mock avoids the identical problem, and has been
 * since the first commit of this file. The database now works the same way. A run
 * cannot collide with a run whose name it cannot guess — including its own
 * previous run, whose leaked API process is the version of this bug that travels
 * through time rather than across worktrees.
 *
 * The port is released by the OS; a database is not, so `teardown` drops it and
 * `setup` sweeps whatever an interrupted run left behind.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readCensus } from './wallet-census.js';

const here = dirname(fileURLToPath(import.meta.url));
/** e2e/support → e2e → repo root */
const repoRoot = join(here, '..', '..');

const HEALTH_TIMEOUT_MS = 30_000;

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

async function healthy(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/_health`);
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
}

async function waitForHealth(baseUrl: string, log: () => string): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await healthy(baseUrl)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `The API never became healthy at ${baseUrl}/_health within ${HEALTH_TIMEOUT_MS / 1000}s.\n` +
      `--- server output ---\n${log() || '(nothing on stdout/stderr)'}\n---------------------`,
  );
}

/** Resolve the tsx binary that runs the mock's TypeScript entry point directly. */
function tsxBin(): string {
  const candidates = [
    join(repoRoot, 'packages', 'mock', 'node_modules', '.bin', 'tsx'),
    join(repoRoot, 'node_modules', '.bin', 'tsx'),
  ];
  const found = candidates.find((c) => existsSync(c));
  if (!found) {
    throw new Error(
      'Cannot find the `tsx` binary that runs the mock API.\n' +
        'Run `pnpm install` at the repo root, or start the API yourself and re-run with\n' +
        '  E2E_BASE_URL=http://localhost:4000 pnpm --filter @avo/e2e test',
    );
  }
  return found;
}

/**
 * The mock imports @avo/types from its built `dist`, so an unbuilt workspace
 * makes it exit before it ever listens. Say so up front instead of timing out.
 */
function assertTypesBuilt(): void {
  if (existsSync(join(repoRoot, 'packages', 'types', 'dist', 'index.js'))) return;
  throw new Error(
    'packages/types has not been built, so the mock API cannot start.\n' +
      'Run:  pnpm --filter @avo/types build     (or `pnpm build` for the whole workspace)' +
      uninstalledPackagesNote(),
  );
}

/**
 * A WORKSPACE PACKAGE WITH NO `node_modules` IS NOT A TEST FAILURE, AND IT READS
 * EXACTLY LIKE ONE.
 *
 * Lane A lost time to this today: after a worktree rebase `apps/dashboard` had no
 * `node_modules`, `pnpm check` died in that package's typecheck before a single
 * spec ran, and the output looked like the suite had broken. It had not — the
 * tree was simply not installed.
 *
 * `pnpm install` is the answer every time, and it costs one `existsSync` per
 * package to be able to say so. Deliberately ADVISORY: it appends a line to
 * failures this file already raises and prints a warning at startup, and it never
 * fails a run on its own. An uninstalled package that this suite does not need is
 * somebody else's problem, and turning it into a red e2e run would be reporting a
 * housekeeping problem as a test result — the habit the run-database work was
 * about breaking.
 */
function uninstalledWorkspacePackages(): string[] {
  const candidates = [
    ['packages', 'types'],
    ['packages', 'tokens'],
    ['packages', 'mock'],
    ['apps', 'wallet'],
    ['apps', 'scanner'],
    ['apps', 'dashboard'],
    ['api'],
    ['e2e'],
  ];
  return candidates
    .map((parts) => join(repoRoot, ...parts))
    .filter((dir) => existsSync(join(dir, 'package.json')) && !existsSync(join(dir, 'node_modules')))
    .map((dir) => dir.slice(repoRoot.length + 1));
}

function uninstalledPackagesNote(): string {
  const missing = uninstalledWorkspacePackages();
  if (missing.length === 0) return '';
  return (
    `\n\nAND FIRST: ${missing.join(', ')} ${missing.length === 1 ? 'has' : 'have'} no ` +
    '`node_modules`. That is an uninstalled tree, not a broken suite — a fresh worktree or a ' +
    'rebase that added a package does this, and every task in it fails before any test runs.\n' +
    'Run:  pnpm install'
  );
}

let child: ChildProcess | undefined;

/**
 * WHERE THE MOCK'S OUTPUT IS KEPT, AND WHY IT IS A FILE RATHER THAN A VARIABLE.
 *
 * `support/tenancy-harness.ts` learned this lesson already and wrote it down:
 * "A suite that boots its own server owns that server's output." Its
 * `apiLogTail()` exists because a 500 mid-run "surfaced as `{"error":"server_error"}`
 * and nothing else — the stack existed, four lines away, and no spec could reach
 * it. Seven promotions specs were diagnosed by adding this; it should have been
 * here from the start".
 *
 * The mock had exactly the same hole and it was never closed. `output` below is a
 * local, read once for the "never became healthy" message and then dropped, so a
 * 500 from `packages/mock` — which has no error handler of its own, so any throw
 * in a handler becomes one — was unreadable to `money.test.ts`,
 * `concurrency.test.ts` and `permissions.test.ts`, the three files that drive the
 * charge path hardest. DECISIONS.md #65 is a burst of eight of those, still
 * undiagnosed.
 *
 * A FILE AND NOT A MODULE VARIABLE, because this module runs in the vitest MAIN
 * process and the specs run in forked workers with their own module registry —
 * `tenancy-harness.ts` § "WHY THE CACHE IS ON DISK" makes the same argument about
 * sign-in sessions. The path travels to the workers in the environment, the way
 * `AVO_QA_DB` and `E2E_BASE_URL` already do.
 *
 * Named after the port, so two runs on one machine cannot write to one file — the
 * same reasoning that names the run database. Removed in `teardown`.
 */
function mockLogPath(port: number): string {
  return join(tmpdir(), `avo-e2e-mock-${port}.log`);
}

/**
 * Name this run's database and tell the workers about it.
 *
 * Deliberately does NOT create it. Provisioning needs Docker and Postgres, and
 * the mock-backed suites — money, concurrency, permissions — need neither. A
 * laptop with no container running must still be able to run those, so creation
 * stays in `preflight()`, where it happens the first time a suite actually asks
 * for a real database and where the error message can name `db:up`.
 *
 * `POSTGRES_DB` wins if it is set: that is the deliberate opt-out for pointing
 * this suite at a long-lived database, and such a database is not ours to mint or
 * to drop.
 */
async function nameRunDatabase(): Promise<void> {
  if (process.env.POSTGRES_DB || process.env.AVO_QA_DB) return;
  const { newRunDatabaseName, sweepStaleRunDatabases } = await import('./tenancy-harness.js');
  // globalSetup runs before the test workers are forked, so they inherit this.
  process.env.AVO_QA_DB = newRunDatabaseName();

  const dropped = sweepStaleRunDatabases();
  if (dropped.length > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[lane D] swept ${dropped.length} run database(s) left by interrupted runs: ${dropped.join(', ')}`,
    );
  }
}

export async function setup(): Promise<void> {
  await nameRunDatabase();

  const uninstalled = uninstalledWorkspacePackages();
  if (uninstalled.length > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[lane D] ${uninstalled.join(', ')} ${uninstalled.length === 1 ? 'has' : 'have'} no ` +
        'node_modules. If anything below fails, run `pnpm install` before reading it as a defect.',
    );
  }

  const external = process.env.E2E_BASE_URL;
  if (external) {
    if (!(await healthy(external))) {
      throw new Error(
        `E2E_BASE_URL is set to ${external} but nothing healthy answered ${external}/_health.\n` +
          'Start it (`pnpm mock` for the mock API) or unset E2E_BASE_URL to let the suite boot its own.',
      );
    }
    return;
  }

  assertTypesBuilt();

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let output = '';

  child = spawn(tsxBin(), ['src/server.ts'], {
    cwd: join(repoRoot, 'packages', 'mock'),
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logPath = mockLogPath(port);
  rmSync(logPath, { force: true });
  const keep = (c: Buffer) => {
    const text = c.toString();
    output += text;
    // Never fail a run over a log file. See `removeSessionCache`.
    try {
      appendFileSync(logPath, text);
    } catch {
      /* nothing here is worth failing a run over */
    }
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) output += `\n[mock exited with code ${code}]`;
  });

  try {
    await waitForHealth(baseUrl, () => output);
  } catch (err) {
    child.kill('SIGKILL');
    throw err;
  }

  // globalSetup runs before the test workers are forked, so they inherit these.
  process.env.E2E_BASE_URL = baseUrl;
  process.env.E2E_MOCK_LOG = logPath;
}

export async function teardown(): Promise<void> {
  await reportWalletDrift();
  await dropRunDatabaseIfOurs();
  await removeSessionCache();
  // On the same lifecycle as the process whose output it holds. Never throws,
  // for `dropRunDatabaseIfOurs`'s reason.
  if (process.env.E2E_MOCK_LOG) {
    try {
      rmSync(process.env.E2E_MOCK_LOG, { force: true });
    } catch {
      /* nothing here is worth failing a run over */
    }
  }

  /*
   * WAS `if (!child) return`, AND THE EARLY RETURN IS WHY IT IS NOT ANY MORE.
   * The census verdict is raised at the very bottom of this function, so any
   * path that leaves early is a path where a real regression is silently
   * dropped — and `!child` is the ordinary shape of an `E2E_BASE_URL` run
   * against an API this file did not boot, not an exotic one.
   */
  if (child) {
    child.kill('SIGTERM');
    const exited = new Promise<void>((r) => child?.once('exit', () => r()));
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }

  /*
   * LAST, AFTER EVERY CLEANUP STEP ABOVE HAS RUN. The database is given back,
   * the session cache and log are gone and the mock is down before this throws,
   * so a red census cannot leak a minted database or leave a process behind.
   * See `censusVerdict`.
   */
  if (censusVerdict) throw new Error(censusVerdict);
}

/**
 * Give the run's database back.
 *
 * Runs FIRST in teardown and never throws. A failure to drop is a few megabytes
 * on a dev container — the sweep in `setup` will get it — and turning that into a
 * red run would be reporting a housekeeping problem as a test result, which is
 * the habit this whole change is about breaking.
 */
/**
 * Remove the run's cached sign-in sessions.
 *
 * `tenancy-harness.ts` holds one access token per identity per run in a JSON file
 * named after the run's database, so the three password endpoints are not signed
 * into once per call site — see the note above `SESSION_MIN_REMAINING_MS`. The
 * file is on the same lifecycle as the database whose `session` rows those tokens
 * refer to, so it is given back in the same breath.
 *
 * Never throws, for `dropRunDatabaseIfOurs`'s reason: a stray file in the temp
 * directory is not a test result.
 */
async function removeSessionCache(): Promise<void> {
  if (!process.env.AVO_QA_DB) return;
  try {
    const { sessionCachePath } = await import('./tenancy-harness.js');
    rmSync(sessionCachePath(), { force: true });
  } catch {
    /* nothing here is worth failing a run over */
  }
}

/*
 * THE CAP WAS `MAX_DRIFTING_MEMBERS = 13` AND IT IS NOW A LIST OF NAMES.
 * (A free-standing note, not a docblock: there is no constant here any more,
 * and this must not attach itself to `censusVerdict` below.)
 *
 * `DOCUMENTED_DRIFTERS` in `support/wallet-census.ts`, one entry per member with
 * the sentence saying why its balance cannot come from a real ledger pair. The
 * cap is that object's size, derived and never written down twice — 13 when it
 * landed and 12 since Fatima `9001` was reconciled rather than documented — and
 * there is no digit anyone can edit to make it one larger.
 *
 * WHY IT MOVED, IN ONE SENTENCE, BECAUSE THE FULL REASONING IS IN THAT FILE: a
 * full run measured exactly 13 against a cap of 13, and a ratchet resting on its
 * stop fires on the next lane to add a fixture rather than on whoever set it
 * there — so the gate now fails on the IDENTITY of an undocumented drifter, with
 * a message written for the person it lands on.
 *
 * The bound is still on DRIFTERS and it is still a SUBSET check rather than an
 * equality, for the reason this block has always given: a partial run leaves a
 * subset of a full run's members, and anything that goes red on
 * `vitest run one-file.test.ts` is a gate people learn to disable.
 */

/**
 * Set by `reportWalletDrift` when the cap is exceeded, raised by `teardown` only
 * AFTER every cleanup step has run.
 *
 * NOT THROWN WHERE IT IS DETECTED, AND THE ORDER IS THE REASON. `teardown` calls
 * `reportWalletDrift` FIRST, before `dropRunDatabaseIfOurs`. A throw at the
 * detection site would skip the drop and leak this run's minted database — the
 * exact failure `dropRunDatabaseIfOurs`'s "nothing here is worth failing a run
 * over" exists to prevent, reintroduced by the gate meant to improve things.
 */
let censusVerdict: string | null = null;

/**
 * THE WALLET RECONCILIATION CENSUS — `db:verify` invariant 5, measured over
 * everything this run left behind, and PRINTED EVERY TIME.
 *
 * The invariant is `member.balance_fils = sum(member_wallet credits − debits)`.
 * `api/src/db/seed.ts` § "the opening balances" is where it was first found to be
 * false and made true: an opening fixture balance is a real credit and gets a
 * real ledger pair, because "a balance with no originating entry is a hole in
 * that record, not a fixture convenience".
 *
 * WHY IT IS HERE AND NOT IN A SPEC. It is a property of the WHOLE run, and a
 * spec can only ever see the files that happened to run before it — vitest does
 * not order files alphabetically. `globalSetup`'s teardown is the one hook
 * guaranteed to run after every file and before the database is given back, so
 * this is the only place the question can be asked once about everything.
 *
 * WHY IT WAS A CENSUS AND NOT AN ASSERTION, WHY IT BECAME A CAPPED CENSUS, AND
 * WHY THE CAP IS NOW A NAMED SET RATHER THAN AN INTEGER.
 *
 * THE ORIGINAL DECISION, KEPT VERBATIM BECAUSE IT IS STILL THREE-QUARTERS RIGHT.
 * Drift here is not always a defect. `adjustments.test.ts` § `fund()` sets
 * `balance_fils` with SQL on purpose, because a shortfall spec needs a specific
 * balance and there is no endpoint that produces one; that member will always
 * drift and should. A throw would therefore be permanently red for a legitimate
 * technique, and — worse — it would fail in a run teardown, which cannot name
 * the file that wrote the row and cannot be reproduced by re-running that file
 * alone. It would also turn one lane's fixture debt into every lane's red gate.
 *
 * WHAT CHANGED, AND IT IS EVIDENCE RATHER THAN AN OPINION. That decision rests
 * on "the number is the signal, and a number that grows names the fixture that
 * grew it", which presupposes somebody reads the number. Nobody did. The count
 * moved 7 → 11 and this comment sat four members out of date across every run in
 * between, still naming as broken two members that had been fixed. A signal no
 * one reads is not a signal, and that is the one premise the original decision
 * could not check about itself.
 *
 * SO IT IS A CAP, NOT AN ASSERTION, AND THE DIFFERENCE ANSWERS THE FIRST TWO
 * OBJECTIONS EXACTLY. `MAX_DRIFTING_MEMBERS` bounds HOW MANY members may drift;
 * it says nothing about WHICH. `fund()`'s member keeps drifting and the cap does
 * not care. Nothing is permanently red for a legitimate technique, and there is
 * no hand-kept list of expected drifters to rot the way `DYNAMIC_PERMISSION`
 * did — one integer, changed deliberately, with the reason in the commit.
 *
 * THAT LAST CLAUSE IS NO LONGER TRUE AND IS KEPT SO THE TRADE IS LEGIBLE. There
 * IS a hand-kept list now — `DOCUMENTED_DRIFTERS` in `support/wallet-census.ts`,
 * ONE id with the sentence saying why — and the rot it risks is
 * exactly the rot named above. It was taken on knowingly, for a reason the
 * integer could not answer: a full run measured 13 against a cap of 13, so the
 * cap had ZERO HEADROOM, and at zero headroom nothing in this file made adopting
 * `reconcileWalletLedger` easier than editing one digit. The intended path was
 * the more expensive one. A list of names makes an addition a conscious act with
 * a name and a reason attached, the way `KNOWN_INERT` and `LANGUAGE_PINNED` do
 * in `apps/wallet/src/theme/typeFidelity.test.ts` — and it lets the failure name
 * WHICH member is new, which the integer never knew and which is the one fact
 * the lane it fires on actually needs. The effective cap was unchanged at 13 when
 * this landed; it went to 12 when the list made a wrong entry legible and the
 * member it named was reconciled instead; and it is ONE now, eleven entries
 * lighter, every one of them removed the same way. The list did what it was taken
 * on to do faster than the argument for taking it on expected.
 *
 * AND THE ROT IS BOUNDED, WHICH IS WHY IT WAS ACCEPTABLE AND `DYNAMIC_PERMISSION`
 * WAS NOT. That list rotted by accumulating entries nobody could refute. This one
 * is checked as a SUBSET, not an equality — see the paragraph below, which is the
 * reason an equality is impossible here — so a stale entry cannot fail anything,
 * but it also cannot hide anything: the printed line reports the drifting count
 * AGAINST the list's size, so a full run reading `11 of the documented 12` says
 * on its own face that one entry is now prunable. The mechanism that caught the
 * original staleness was a number that moved; this is that number, pointed at
 * the list instead of at the fixtures.
 *
 * A PARTIAL RUN CANNOT FALSELY TRIP IT, which is why the bound is on DRIFTERS
 * and not on reconcilers. `vitest run one-file.test.ts` leaves a SUBSET of the
 * members a full run leaves, so its drifter count is a subset count and can
 * never exceed the full-run cap. A floor on reconcilers would have gone red on
 * every single-file run, which is the shape that teaches people to disable a
 * gate.
 *
 * THE OTHER TWO OBJECTIONS SURVIVE AND ARE THE PRICE. A teardown failure still
 * cannot be reproduced by re-running one file, and it still lands in the run of
 * whoever comes next rather than whoever wrote the row. The message does what
 * can be done about the first — it names every drifting member and the amount,
 * and member ids map to files by convention (`QA-RPT-…` → `reports.test.ts`) —
 * but the second is real and is accepted knowingly, because the alternative is
 * the state this instrument was actually in: correct, ignored, and stale.
 *
 * AND THE CAP GUARDS THE NUMBER, SO SOMETHING HAS TO GUARD THE INSTRUMENT.
 * A cap on drifters is worth nothing if the census can decline to run and say
 * nothing about it, and until now it could, three ways: `!AVO_QA_DB` returned
 * early, a `psql` failure fell into a bare `catch {}`, and a missing census line
 * returned. All three printed NOTHING, so a run whose census never happened was
 * indistinguishable from a healthy one — and it counts zero drifters, which
 * passes the cap. That was found by accident, running `commit-order.test.ts`
 * alone to test the cap and getting no census line at all.
 *
 * SO THE FUNCTION NOW PRINTS EXACTLY ONE LINE EVERY RUN, whatever happened, and
 * the only question left is which lines are failures. It is settled by asking
 * Postgres whether the database exists, because that is precisely the difference
 * between the benign case and every bad one:
 *
 *   no database          no file in this run needed one — a static-analysis run.
 *                        Printed, not failed. Genuinely nothing to reconcile.
 *   database, no answer  the query broke against a real schema. FAILS.
 *   database, wrong shape the query answered something that is not a census.
 *                        FAILS.
 *   Postgres unreachable announced, NOT failed — the question that would tell
 *                        this apart from "no database needed" is the one that
 *                        just failed. A real mid-run death is already red from
 *                        every database-touching spec. See the branch itself for
 *                        the version of this row that was wrong, and how.
 *
 * THIS OVERRIDES A WRITTEN DECISION AND SAYS SO ON PURPOSE. It was made on
 * Aftab's instruction after the tension above was put to him. If the red gate in
 * other lanes' runs turns out to cost more than the staleness did, the honest
 * revert is to delete the cap and keep this paragraph.
 *
 * A WARNING THAT FIRES EVERY RUN IS NOISE PEOPLE LEARN TO READ PAST — this
 * repository has written that sentence about a stale comment, a cached green and
 * a skipped int spec. So this does not warn. It prints a COUNT and the drifting
 * ids, unconditionally, as a measurement: the number is the signal, and a number
 * that grows names the fixture that grew it. No hand-kept list of expected
 * drifters, because a hand-kept ledger of exceptions is the thing that rotted
 * `DYNAMIC_PERMISSION` in `permission-census.test.ts` within a day.
 *
 * SUPERSEDED IN ITS LAST SENTENCE ONLY, AND THE FIRST HALF IS WHY THE REPLACEMENT
 * IS STILL ONE LINE. There is a hand-kept list now, for the zero-headroom reason
 * above. What did NOT change is that this prints a measurement rather than a
 * warning, every run, in one line — the line simply now says what the count means
 * as well as what it is, because `13 of a documented 13` is the warning and `13`
 * alone was a statistic somebody had to open this file to interpret.
 *
 * WHAT IT MEASURED WHEN IT LANDED, over the full 38-file suite:
 *
 *     7 of 24 members reconcile to their wallet ledger
 *
 * WHAT IT MEASURED NEXT, over the full 41-file suite, twice on 2026-09-11:
 *
 *     11 of 24 members reconcile to their wallet ledger
 *
 * WHAT IT MEASURED OVER THE FULL 42-FILE SUITE ON 2026-09-17:
 *
 *     15 of 28 members reconcile to their wallet ledger
 *
 * THE DRIFTER COUNT DID NOT MOVE — it was the same thirteen ids, checked one by
 * one against that run rather than trusted from this comment. Four members
 * arrived and all four reconciled, which is the direction this is supposed to go
 * and was the first time anything here could say so about a specific set rather
 * than a count. The signs held too: twelve positive, `QA-GW-0001` negative by
 * exactly the −239.000 recorded below.
 *
 * THE COUNT WENT UP BY FOUR AND THIS BLOCK WENT STALE BEHIND IT, which is worth
 * recording as plainly as the number: the paragraphs below described the drift
 * set as it was the day the census landed and named two members as drifting that
 * had since been fixed BY THE VERY MECHANISM those paragraphs recommend. Nobody
 * noticed, because a printed line with nothing asserting it is read once — see
 * the cap at the bottom of this block, which is the answer to that.
 *
 * WHAT IT MEASURES AFTER THIS SLICE, over the full 43-file suite on 2026-09-24:
 *
 *     27 of 28 members reconcile to their wallet ledger; drifting: QA-ADJ-0002 by 10000 fils
 *
 * 27 OF 28, ONE DRIFTER, AND SHE IS THE TOMBSTONE. The 28 members are unchanged
 * from the 2026-09-17 run; what moved is the 15 to 27.
 *
 * ELEVEN OF THE TWELVE DRIFTERS WERE RECONCILED IN ONE PASS, and the gate's claim
 * changed shape with them. It used to be "twelve known drifters, watch for a
 * thirteenth". It is now: ANY MEMBER WHOSE BALANCE DOES NOT RECONCILE TO HER
 * WALLET LEDGER IS A BUG, EXCEPT `QA-ADJ-0002`. The eleven left by the mechanism
 * this block recommends — a `reconcileWalletLedger` call in the `afterAll` of the
 * file that owns the fixture — which is what the count was for and is the first
 * time it has been able to report the pattern working at scale rather than one
 * file at a time.
 *
 * THE POINT OF DOING IT: the common path for a new fixture is now "call the
 * helper", not "argue for an exemption". The ratchet is no longer resting on its
 * stop, because there is no stop left to rest on.
 *
 * Every remaining drifter is a fixture member whose balance was INSERTed or
 * UPDATEd by SQL, and the SIGN tells you which kind:
 *
 *   POSITIVE — the balance is ahead of the ledger. An opening balance with no
 *       originating entry. This was one per file that clones a member with a
 *       balance — `QA-RES-000{1,2}`, `QA-DEP-0001`, `QA-NSW-0001`, `QA-ORD-0001`,
 *       the four `QA-CMP-000n` — and the harness's own `9001` besides. Every one
 *       of them now reconciles in its own file's `afterAll`, so the hole is paid
 *       for where it is opened. The rule this settles under is
 *       `api/src/db/seed.ts` § "the opening balances": an opening balance is a
 *       real credit and gets a real pair. Note what that citation is and is not —
 *       it is where the RULE was settled, for members `8842` and `8843`, which
 *       both get a real pair through the builder. It has never been where a
 *       drifting fixture's balance was written. Reading it as the writer is what
 *       put `9001` on this list with lane A's name against it for six days.
 *   NEGATIVE — the LEDGER is ahead of the balance, and this is the shape worth
 *       looking at twice. It means wallet legs exist that the balance does not
 *       reflect, which is either a fixture that reset `balance_fils` after the
 *       API had moved it, or a real cached-aggregate defect.
 *
 * THERE IS NO LIVE NEGATIVE DRIFTER NOW, AND THE EXPLANATION STAYS ON PURPOSE —
 * deleting it would leave the reader of a future negative line with nothing. The
 * negative was `QA-GW-0001` at −239.000: `QA_MEMBER`, rewound by the harness's own
 * `seedQaMember()` once per FILE, so every charge an earlier file drove through
 * her stayed in the ledger with the balance wound back behind it.
 * `stopTenancyApi()` reconciles her now, beside `9001`.
 *
 * SO WHERE IS THE SIGN LOGIC PROVEN, NOW THAT NO RUN DEMONSTRATES IT? In a spec,
 * which is the stronger place and was available all along:
 * `wallet-census.test.ts` § "the reading is taken off the printed line and
 * nowhere else" drives `readCensus` with a synthetic line carrying `-239000` and
 * asserts ids split off their amounts "signs and all", and the multi-member
 * verdict spec pins `NEW: QA-NEW-0002 by -4500 fils`. Those fail if the parse
 * ever stops handling a minus sign; a live drifter only ever showed that it
 * currently did. Keeping a member's balance unexplained in order to demonstrate
 * what a spec already asserts is paying in the measured quantity for a
 * demonstration.
 *
 * AND A NEGATIVE DRIFT ON A MEMBER NOBODY RE-FIXTURES IS STILL THE THING THIS
 * CENSUS IS FOR. It is easier to see now, not harder: such a member no longer
 * arrives among eleven documented neighbours to be skimmed past. She arrives
 * alone, against a list of one, and the gate names her.
 *
 * MEMBERS LEAVE THIS LIST AND THE CORRECTION IS THE POINT OF THE INSTRUMENT.
 * `QA-RPT-0001` was once listed here as a positive drifter and `QA-ACC-0001` as a
 * negative one, and this block used to end "`reports-applied-deposit.test.ts` is
 * the one file here whose member does NOT drift". All three statements were false
 * within days, and nobody noticed, because a printed line with nothing asserting
 * it is read once. That is what the cap at the bottom of this block answers, and
 * this slice is what the answer produced.
 */
async function reportWalletDrift(): Promise<void> {
  const { psql, pgDb, databaseExists } = await import('./tenancy-harness.js');

  /*
   * WHICH DATABASE, IN BOTH MODES. `pgDb()` resolves the minted `AVO_QA_DB` for
   * an ordinary run and an explicit `POSTGRES_DB` for the discouraged one. The
   * census used to bail on `!AVO_QA_DB`, which meant setting `POSTGRES_DB`
   * silently switched the instrument off — a third way to be quiet. Invariant 5
   * is the invariant in either mode, so it is measured in either mode.
   */
  const db = pgDb();

  /*
   * "NOTHING PROVISIONED A DATABASE" IS NOT "THE CENSUS IS BROKEN", AND
   * TELLING THEM APART IS THE WHOLE OF THIS FUNCTION'S HONESTY.
   *
   * The run database is minted lazily: a file that needs one calls into the
   * harness and it is created then. A run of only static-analysis files —
   * `commit-order.test.ts` is the clean example — never provisions one, so
   * there is genuinely nothing to reconcile and no failure to report.
   *
   * That case used to be indistinguishable from a broken query, because BOTH
   * threw out of `psql` into a bare `catch {}` and printed nothing at all. A
   * missing census line looked exactly like a healthy one that happened not to
   * be there, and the cap added above cannot help: a census that never runs
   * counts zero drifters and passes. Asking Postgres whether the database
   * exists splits the two cleanly, and everything after this point is a
   * database that IS there — where any failure is the instrument, not the run.
   */
  /*
   * POSTGRES UNREACHABLE IS ANNOUNCED AND NOT FAILED, AND THE FIRST VERSION OF
   * THIS BRANCH GOT IT WRONG IN A WAY WORTH KEEPING ON THE RECORD.
   *
   * It failed the run, on the reasoning that "Postgres answered at setup —
   * `sweepStaleRunDatabases` runs there and would have failed the run otherwise
   * — so it became unreachable DURING this run". That reasoning was false when
   * it was written. `sweepStaleRunDatabases` ends in `catch { return []; // no
   * container, no sweep, no complaint }`, so setup is silent about a Postgres
   * that was never up, and the inference had no support at all.
   *
   * IT WAS CAUGHT BY THE OBVIOUS CASE: `docker` not running. Both full runs on
   * the merged base died here and told the reader that Postgres "became
   * unreachable during this run" and that "every money assertion above it talked
   * to the same container" — when nothing had talked to any container, because
   * the daemon was down before vitest started. A census that misdiagnoses is
   * worse than the silence it replaced; it sends someone looking for a
   * mid-run database death that never happened.
   *
   * AND IT REGRESSED A RUN THAT USED TO WORK. `vitest run commit-order.test.ts`
   * needs no database at all. With the daemon off, this branch turned a passing
   * static-analysis run red — exactly the "gate people learn to disable" shape
   * the cap above was careful to avoid.
   *
   * SO: unreachable Postgres cannot be told apart from "no database was needed",
   * because the question that separates them is the one that just failed. It is
   * announced loudly and the run is left alone. NOTHING IS LOST BY THAT — a
   * Postgres that really did die mid-run takes every database-touching spec with
   * it, and those are already red on their own merits. The census does not have
   * to be what catches it, and it is the one thing here that cannot tell.
   */
  let exists: boolean;
  try {
    exists = databaseExists(db);
  } catch (err) {
    announce(
      `could not reach Postgres to ask whether "${db}" exists — ${String(err)}. ` +
        'NOT failing the run: this is what a `docker` daemon that is not running looks like, ' +
        'and a static-analysis-only run legitimately needs no database. If any spec above ' +
        'needed one, it has already failed on its own and says so more precisely than this ' +
        'line can.',
    );
    return;
  }

  if (!exists) {
    announce(
      `no database — "${db}" was never provisioned, so no file in this run needed one. ` +
        'Nothing to reconcile; this is not a failure.',
    );
    return;
  }

  try {
    const out = psql(`
      WITH d AS (
        SELECT m.id,
               m.balance_fils - coalesce(sum(CASE le.direction WHEN 'credit' THEN le.amount_fils
                                                               ELSE -le.amount_fils END), 0) AS diff
          FROM member m
          LEFT JOIN ledger_entry le
                 ON le.member_id = m.id AND le.account = 'member_wallet'
         GROUP BY m.id, m.balance_fils)
      SELECT format('%s of %s members reconcile to their wallet ledger%s',
                    count(*) FILTER (WHERE diff = 0),
                    count(*),
                    CASE WHEN count(*) FILTER (WHERE diff <> 0) = 0 THEN ''
                         ELSE '; drifting: ' || (
                           SELECT string_agg(format('%s by %s fils', id, diff), ', ' ORDER BY id)
                             FROM d WHERE diff <> 0)
                    END) AS census
        FROM d;
    `);
    // The `format()` result is the only interesting line psql prints.
    const line = out
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.includes('reconcile to their wallet ledger'));

    /*
     * THE DATABASE IS THERE AND THE QUERY ANSWERED SOMETHING THAT IS NOT A
     * CENSUS. `psql` ran with `ON_ERROR_STOP=1`, so a broken query throws
     * rather than arriving here — this is the narrower case where it succeeded
     * and the shape changed: someone edited the `format()` string, or the
     * column list moved under it. Silence here would be the original defect
     * wearing a different hat.
     */
    if (!line) {
      announce(`ran against "${db}" and produced no census line — the query's shape changed.`);
      censusVerdict =
        `the wallet census queried "${db}" successfully and got back something that is not a ` +
        'census line. The `format()` string in support/global-setup.ts § reportWalletDrift and ' +
        'the line it is recognised by have diverged. Fix the reader or the query — do not ' +
        'delete the check: a census that cannot be read is the exact silence this branch ' +
        `exists to break.\n\npsql said:\n${out.trim().slice(0, 600)}`;
      return;
    }
    /*
     * `11 of 24 members reconcile …; drifting: a by N fils, b by M fils`.
     * The drifters are the comma-separated list after the colon; no colon means
     * none drifted. Read off the printed line rather than re-queried, so the ids
     * the gate acts on are provably the ids a reader was just shown — and the
     * reading is a pure function of that line, which is the whole reason a spec
     * can drive it (`wallet-census.test.ts`) when this teardown cannot be called.
     *
     * ONE `announce` STILL, EVERY RUN. What changed is that the line now carries
     * what the count MEANS — `all 13 of the documented 13 are drifting` is a
     * warning where `13` was a statistic — so the headroom is visible on the
     * green run instead of being discovered on somebody else's red one.
     */
    const reading = readCensus(line);
    announce(reading.announcement);
    censusVerdict = reading.verdict;
  } catch (err) {
    /*
     * WAS A BARE `catch {}` WITH "nothing here is worth failing a run over".
     * That was right about `dropRunDatabaseIfOurs`, whose job is cleanup, and
     * wrong here: the database EXISTS by this point, so the only way to arrive
     * is a query that broke against a real schema — a renamed `balance_fils`,
     * `ledger_entry.account` or `direction`. Swallowing that removed the one
     * instrument watching invariant 5 and left nothing behind to say so.
     */
    announce(`failed against "${db}" — ${String(err)}`);
    censusVerdict =
      `the wallet census failed against "${db}", which exists: ${String(err)}\n\n` +
      'This query is the only thing measuring `db:verify` invariant 5 across a run. It reads ' +
      '`member.balance_fils`, `ledger_entry.member_id`, `.account`, `.direction` and ' +
      '`.amount_fils`; if one of those was renamed, follow the rename here. Restoring the ' +
      'query is the fix — a census that cannot run must not be a census that says nothing.';
  }
}

/** One line, every run, whatever happened. The property finding 3 was about. */
function announce(what: string): void {
  // eslint-disable-next-line no-console
  console.log(`[lane D] wallet census (db:verify invariant 5) — ${what}`);
}

async function dropRunDatabaseIfOurs(): Promise<void> {
  if (!process.env.AVO_QA_DB) return;
  try {
    const { dropRunDatabase } = await import('./tenancy-harness.js');
    dropRunDatabase();
  } catch {
    /* nothing here is worth failing a run over */
  }
}
