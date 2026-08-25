/**
 * The DATABASE-BACKED specs in `@avo/api`, which the default config cannot run.
 *
 * `vitest.config.ts` points `DATABASE_URL` at port 1 on purpose — "deliberately
 * unreachable… If a spec ever does connect, it fails loudly here rather than
 * quietly succeeding against whatever database the developer happened to have
 * exported" — and that is the right default for a unit suite. It also means a
 * spec that has to prove something about a ROW cannot live under it.
 *
 * WHY THERE ARE ROWS TO PROVE THINGS ABOUT. The rate limiters added in
 * services/scannerLimit.ts and services/topupLimit.ts carry one claim that no
 * pure spec can support: A REFUSED REQUEST MOVED NO MONEY. That is an assertion
 * about `member.balance_fils` and about the absence of a `transaction` row, and
 * it is the assertion most worth having, because a limiter that fires after the
 * debit is worse than no limiter at all — it refuses the customer AND charges her.
 *
 * ------------------------------------------------------------------------
 * THIS SUITE DOES NOT RUN IN `pnpm check`, AND THAT IS A KNOWN GAP.
 * ------------------------------------------------------------------------
 * It is not in `api`'s `test` script and turbo therefore never runs it. Two
 * reasons, one good and one procedural:
 *
 *   It needs a live Postgres with this lane's schema and seed. The workspace
 *   package that already owns that problem is `e2e/`, which mints an unguessable
 *   per-run database in `support/global-setup.ts` and boots the API against it.
 *   Duplicating that provisioning here would be a second harness that can drift
 *   from the first.
 *
 *   `e2e/` is Lane D's column (`CLAUDE.md` § Lanes), and Lane A may not write to
 *   it. So the durable home for these assertions is a Lane D file, and this
 *   config is what let Lane A prove the behaviour before handing it over.
 *
 * RUN IT AGAINST YOUR OWN LANE DATABASE, NEVER A SHARED ONE:
 *
 *   ./scripts/lane-db.sh a
 *   export AVO_INT_DATABASE_URL="postgres://avo_app:avo_app_dev_password@localhost:5433/avo_lane_a"
 *   pnpm --dir "$PWD/api" run test:int
 *
 * With `AVO_INT_DATABASE_URL` unset every spec in here SKIPS with a printed
 * reason rather than connecting to something it was not pointed at. That is the
 * `LANES.md` rule about cross-lane resources expressed as a default: a suite that
 * silently falls back to whatever `DATABASE_URL` happens to be exported is how one
 * worktree's server came to be running against another worktree's database.
 */

import { defineConfig } from 'vitest/config';

const url = process.env.AVO_INT_DATABASE_URL;

export default defineConfig({
  test: {
    include: ['src/**/*.int.test.ts'],
    /**
     * One process, one file at a time. These specs seed and count rows in shared
     * tables (`scanner_attempt`, `topup_intent`) keyed on the seeded salon, so two
     * workers would be two tills spending one budget — `e2e/vitest.config.ts`
     * carries the longer version of this argument.
     */
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    reporters: ['verbose'],
    env: {
      /**
       * Both point at the lane database. `db/client.ts` connects as
       * `APP_DATABASE_URL` (the `avo_app` role, which cannot UPDATE or DELETE
       * `scanner_attempt` — migration 0038), and that is the role the assertions
       * should run against: a limiter proved under the owner role is a limiter
       * proved against privileges production does not have.
       *
       * The empty-string fallback is what makes an unset variable a SKIP: `env.ts`
       * would refuse it, so the specs check the variable themselves and never
       * import the app at all.
       */
      DATABASE_URL: url ?? '',
      APP_DATABASE_URL: url ?? '',
      /** 32+ characters, which `env.ts` requires. Nothing here signs a real token. */
      JWT_SECRET: 'int-test-jwt-secret-not-a-real-one-0123456789',
      /**
       * OFF. These specs mint REAL sessions with real device ids and call with real
       * bearer tokens, because the device is the rate-limit key and the test-principal
       * shim has no session row to carry one. A suite that ran under the shim would
       * be proving the null-device bucket and calling it the till.
       */
      AVO_TEST_PRINCIPALS: '0',
    },
  },
});
