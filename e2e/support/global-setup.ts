/**
 * Boots the API the suites run against, then tears it down.
 *
 * Two modes:
 *
 *   default          starts `packages/mock` on a free ephemeral port, so a suite
 *                    run never collides with a `pnpm mock` already on :4000.
 *   E2E_BASE_URL=…   points every suite at an API that is already running. This
 *                    is how lane A's real API gets driven by the same specs:
 *                        E2E_BASE_URL=http://localhost:3000 pnpm --filter @avo/e2e test
 *
 * Either way the suites never assume a server is up; if one cannot be reached
 * the failure names what to run rather than surfacing 40 ECONNREFUSED lines.
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
      'Run:  pnpm --filter @avo/types build     (or `pnpm build` for the whole workspace)',
  );
}

let child: ChildProcess | undefined;

export async function setup(): Promise<void> {
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
  if (!child) return;
  child.kill('SIGTERM');
  const exited = new Promise<void>((r) => child?.once('exit', () => r()));
  await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
}
