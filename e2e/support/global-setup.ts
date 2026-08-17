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
import { existsSync } from 'node:fs';
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
  child.stdout?.on('data', (c: Buffer) => (output += c.toString()));
  child.stderr?.on('data', (c: Buffer) => (output += c.toString()));
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) output += `\n[mock exited with code ${code}]`;
  });

  try {
    await waitForHealth(baseUrl, () => output);
  } catch (err) {
    child.kill('SIGKILL');
    throw err;
  }

  // globalSetup runs before the test workers are forked, so they inherit this.
  process.env.E2E_BASE_URL = baseUrl;
}

export async function teardown(): Promise<void> {
  await dropRunDatabaseIfOurs();

  if (!child) return;
  child.kill('SIGTERM');
  const exited = new Promise<void>((r) => child?.once('exit', () => r()));
  await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

/**
 * Give the run's database back.
 *
 * Runs FIRST in teardown and never throws. A failure to drop is a few megabytes
 * on a dev container — the sweep in `setup` will get it — and turning that into a
 * red run would be reporting a housekeeping problem as a test result, which is
 * the habit this whole change is about breaking.
 */
async function dropRunDatabaseIfOurs(): Promise<void> {
  if (!process.env.AVO_QA_DB) return;
  try {
    const { dropRunDatabase } = await import('./tenancy-harness.js');
    dropRunDatabase();
  } catch {
    /* nothing here is worth failing a run over */
  }
}
