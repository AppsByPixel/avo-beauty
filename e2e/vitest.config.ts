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
 * TRUNK TODO (not lane D's to change — `pnpm-workspace.yaml` is trunk-owned):
 * add `- "e2e"` to pnpm-workspace.yaml so `pnpm --filter @avo/e2e test` and
 * `pnpm check` pick this package up. Until then the path above is the way in.
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
     */
    fileParallelism: false,
    testTimeout: 20_000,
    /** Booting the API (tsx cold start) is the slow part, not the tests. */
    hookTimeout: 60_000,
    reporters: ['verbose'],
  },
});
