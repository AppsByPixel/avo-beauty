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

/**
 * The most members a FULL run may leave drifting from their wallet ledger.
 *
 * 13 on 2026-09-11, measured twice: `9001`, both `QA-ADJ-000n`, the four
 * `QA-CMP-000n`, `QA-DEP-0001`, `QA-GW-0001`, `QA-NSW-0001`, `QA-ORD-0001` and
 * both `QA-RES-000n`. Every one has a named cause in the block below.
 *
 * THIS NUMBER ONLY EVER GOES DOWN, one file at a time, as fixtures adopt
 * `reconcileWalletLedger` — `reports.test.ts` and `account.test.ts` are the two
 * that already did, and they are why it is 13 and not 15. Raising it is not
 * forbidden and is sometimes right, but it is a decision that needs a sentence
 * saying which member was added and why its balance cannot come from a real
 * ledger pair. Lowering it when a file adopts the pattern is the whole point.
 */
const MAX_DRIFTING_MEMBERS = 13;

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
 * WHY IT WAS A CENSUS AND NOT AN ASSERTION, AND WHY IT IS NOW A CAPPED CENSUS.
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
 * WHAT IT MEASURED WHEN IT LANDED, over the full 38-file suite:
 *
 *     7 of 24 members reconcile to their wallet ledger
 *
 * WHAT IT MEASURES NOW, over the full 41-file suite, twice on 2026-09-11:
 *
 *     11 of 24 members reconcile to their wallet ledger
 *
 * THE COUNT WENT UP BY FOUR AND THIS BLOCK WENT STALE BEHIND IT, which is worth
 * recording as plainly as the number: the paragraphs below described the drift
 * set as it was the day the census landed and named two members as drifting that
 * had since been fixed BY THE VERY MECHANISM those paragraphs recommend. Nobody
 * noticed, because a printed line with nothing asserting it is read once — see
 * the cap at the bottom of this block, which is the answer to that.
 *
 * Every drifter is a fixture member whose balance was INSERTed or UPDATEd by
 * SQL, and the SIGN tells you which kind:
 *
 *   POSITIVE — the balance is ahead of the ledger. An opening balance with no
 *       originating entry: the harness's own `9001`, and one per file that
 *       clones a member with a balance (`QA-RES-000{1,2}` 200.000 each,
 *       `QA-DEP-0001`, `QA-NSW-0001`, `QA-ORD-0001`, the four `QA-CMP-000n`).
 *       The standing convention in this directory, and a real gap:
 *       `api/src/db/seed.ts` § "the opening balances" settled that an opening
 *       balance is a real credit and gets a real pair, and the convention here
 *       never caught up.
 *   NEGATIVE — the LEDGER is ahead of the balance, and this is the shape worth
 *       looking at twice. It means wallet legs exist that the balance does not
 *       reflect, which is either a fixture that reset `balance_fils` after the
 *       API had moved it, or a real cached-aggregate defect. Exactly ONE member
 *       is negative today — `QA-GW-0001` by −239.000 — and it has a named cause:
 *       she is `QA_MEMBER`, reset by this harness's own `seedQaMember()`, which
 *       runs once per FILE, so every charge an earlier file drove through her is
 *       still in the ledger with the balance wound back. A negative drift on a
 *       member NOBODY re-fixtures would be the other thing, and is what this
 *       census is for. There is no such member today.
 *   `adjustments.test.ts`'s two, whatever it last funded. LEGITIMATE, per above.
 *
 * TWO MEMBERS LEFT THIS LIST AND THE CORRECTION IS THE POINT OF THE INSTRUMENT.
 * `QA-RPT-0001` was listed above as a positive drifter and `QA-ACC-0001` as a
 * negative one, and this block used to end "`reports-applied-deposit.test.ts` is
 * the one file here whose member does NOT drift". All three statements are false
 * now. `reports.test.ts` § `afterAll` calls `reconcileWalletLedger` for both its
 * members (and `account.test.ts` § `afterAll` for both of its own, for the
 * `setBalance` reason the NEGATIVE note used to carry) — so the pattern this
 * block recommends is being adopted one file at a time, exactly as predicted,
 * and the count is how anyone would know it was working. It worked; nothing
 * said so for four members.
 */
async function reportWalletDrift(): Promise<void> {
  if (!process.env.AVO_QA_DB) return;
  try {
    const { psql } = await import('./tenancy-harness.js');
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
    if (!line) return;
    // eslint-disable-next-line no-console
    console.log(`[lane D] wallet census (db:verify invariant 5) — ${line}`);

    /*
     * `11 of 24 members reconcile …; drifting: a by N fils, b by M fils`.
     * The drifters are the comma-separated list after the colon; no colon means
     * none drifted. Counted off the printed line rather than re-queried, so the
     * number the gate acts on is provably the number a reader was just shown.
     */
    const listed = line.split('; drifting: ')[1];
    const drifting = listed ? listed.split(', ').length : 0;
    if (drifting > MAX_DRIFTING_MEMBERS) {
      censusVerdict =
        `wallet census: ${drifting} members drift from their wallet ledger, and the cap is ` +
        `${MAX_DRIFTING_MEMBERS}.\n  ${listed}\n\n` +
        'A fixture wrote `balance_fils` by SQL without the ledger pair that accounts for it — ' +
        'a balance with no originating entry, per api/src/db/seed.ts § "the opening balances". ' +
        'Member ids map to files by convention (QA-RPT-… → reports.test.ts), and the fix is a ' +
        '`reconcileWalletLedger(member, branch, tag)` in that file\'s afterAll, the way ' +
        'reports.test.ts and account.test.ts do it. If the new drifter is deliberate and its ' +
        'balance genuinely cannot come from a real ledger pair, raise MAX_DRIFTING_MEMBERS in ' +
        'support/global-setup.ts and say which member and why.';
    }
  } catch {
    /* nothing here is worth failing a run over — see dropRunDatabaseIfOurs */
  }
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
