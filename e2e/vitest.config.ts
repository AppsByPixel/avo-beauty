/**
 * HOW TO RUN
 *
 *   cd e2e && ../node_modules/.bin/vitest run
 *
 * The suite boots its own copy of packages/mock on a free port, so nothing has
 * to be running first. It does need the workspace installed and @avo/types
 * built, because the mock imports the built package:
 *
 *   pnpm install && pnpm --filter @avo/types build
 *
 * To drive an API that is already up — `pnpm mock`, or lane A's real one:
 *
 *   E2E_BASE_URL=http://localhost:4000 ../node_modules/.bin/vitest run
 *
 * `e2e` is in `pnpm-workspace.yaml`, so `pnpm --filter @avo/e2e test` and
 * `pnpm check` both pick this package up.
 *
 * `pnpm check` DOES NOT RE-RUN THIS SUITE ONCE IT HAS PASSED
 * ----------------------------------------------------------
 * `turbo.json` gives the `test` task no `cache: false` and no `inputs`, so turbo
 * caches the result against the package's file hashes. Turbo does not cache
 * failures, which is why a flaky suite appears to re-run every time — each red
 * run genuinely re-executed. The moment it goes green, every later `pnpm check`
 * on the same tree is a log replay: five consecutive runs here reported
 * `>>> FULL TURBO` in nine milliseconds and printed byte-identical output,
 * including a `[lane D] provisioning …` line naming a database that had been
 * dropped an hour earlier.
 *
 * That matters more here than anywhere else in the workspace, because this
 * package's real inputs are a running Postgres, a booted API and the wall clock,
 * and not one of them is in the hash. A cached green from this suite is a green
 * from an arbitrary moment in the past.
 *
 * So a run that is meant to be EVIDENCE has to defeat the cache:
 *
 *   TURBO_FORCE=true pnpm check
 *
 * `turbo.json` is trunk-owned; `"cache": false` on the `test` task is the real
 * fix and is in the lane report.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['*.test.ts'],
    globalSetup: ['./support/global-setup.ts'],
    /**
     * One shared API process holds the idempotency map and the live wallet tokens.
     * Files run one at a time so a failure is reproducible rather than a race
     * between two workers hitting the same in-memory state.
     *
     * AND IT IS NOT THE WHOLE STORY, WHICH IS WORTH SAYING HERE BECAUSE THIS LINE
     * LOOKS LIKE IT SHOULD BE. This setting has been on since the suite was
     * written, and the suite was still nondeterministic under `pnpm check` — 7, 4,
     * 1 and 3 failures on one unchanged tree. Serial FILES say nothing about
     * serial PROCESSES, and the collision was between whole runs: two checkouts
     * of this repository, each resolving the database name to the constant
     * `avo_qa`, driving the same seeded member through the same container. See
     * `support/global-setup.ts` for the fix, which is that a run's database is now
     * named the way its port is — minted, unguessable, and given back afterwards.
     */
    fileParallelism: false,
    testTimeout: 20_000,
    /** Booting the API (tsx cold start) is the slow part, not the tests. */
    hookTimeout: 60_000,
    reporters: ['verbose'],
  },
});
