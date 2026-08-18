/**
 * Vitest config for `@avo/api`'s UNIT specs, and it exists to fix a failing gate.
 *
 * =========================================================================
 * WHAT WAS FAILING, AND IT IS NOT WHAT WAS REPORTED
 * =========================================================================
 * `src/gateway/myfatoorah.test.ts` failed at import on a clean checkout:
 *
 *     FAIL  src/gateway/myfatoorah.test.ts [ src/gateway/myfatoorah.test.ts ]
 *     Error: Invalid environment:
 *       DATABASE_URL: Required
 *      ❯ src/env.ts:309:9
 *      ❯ src/gateway/myfatoorah.test.ts:2:31
 *
 * It was reported as the MyFatoorah variables being absent. THEY ARE NOT THE
 * CAUSE, and checking mattered: `MYFATOORAH_BASE_URL`, `MYFATOORAH_API_KEY` and
 * `MYFATOORAH_RETURN_URL` are all `.optional()` in `env.ts` — deliberately, since
 * the sandbox driver is the default and CI carries no third-party token — so
 * supplying them would have changed nothing and the suite would still have failed.
 * The validator names exactly one missing variable and `DATABASE_URL` is the only
 * one in the whole schema with neither `.optional()` nor a `.default()`.
 *
 * It passed locally only because a developer's shell had `DATABASE_URL` exported,
 * or `api/.env` was present. Neither is true in CI or in a fresh clone, which is
 * the state this config exists to make work.
 *
 * =========================================================================
 * WHY THE FIX IS HERE AND NOT IN THE SPEC
 * =========================================================================
 * The spec imports `env` for one value, `env.gatewayWebhookSecret`, and uses it
 * four times — to SIGN a fixture and then to verify it through
 * `MyFatoorahGateway.verifySignature`, which reads the same value. The secret's
 * content is irrelevant to what is being tested; what matters is that signer and
 * verifier agree.
 *
 * Today that value is `randomUUID() + randomUUID()` outside production, so the
 * suite signs with a DIFFERENT secret on every run. Pinning it here is therefore
 * not merely a workaround — it makes a signature spec deterministic, which is
 * what a signature spec should be.
 *
 * =========================================================================
 * THE DEEPER PROBLEM, REPORTED AND NOT FIXED HERE
 * =========================================================================
 * `env.ts` parses and THROWS at module load, so any module that imports it cannot
 * be loaded without a full environment — including modules whose content is pure.
 * This build has already paid for that once and worked around it rather than
 * fixing it: `services/promotions.ts` uses a TYPE-ONLY import of `db/client` and
 * says why in its own header — "importing the value would make this module — whose
 * core is a pure function of some rows and an instant — refuse to load without a
 * DATABASE_URL. The predicate is the thing most worth testing and it must be
 * testable with no database, no docker and no env file."
 *
 * That is the same sentence, one file over. The durable fix is a memoised, lazily
 * parsed `env` plus an explicit `assertEnvValid()` called as the first statement of
 * `server.ts` and each job entry point.
 *
 * IT IS NOT DONE HERE ON PURPOSE. `TRUST_PROXY` fails fast in production when
 * unset, by a recorded decision (DECISIONS.md § "Five calls made without asking"),
 * and that fail-fast is currently a side effect of importing `env`. Making the
 * parse lazy moves it from boot to first use unless every entry point is changed
 * with it — turning a structural guarantee into a promise four files have to keep.
 * Changing when a production deployment discovers it is misconfigured is a trunk
 * decision, not something to slip into a config file fixing a red suite.
 *
 * =========================================================================
 * WHAT THIS FILE DOES NOT SET
 * =========================================================================
 * NO `MYFATOORAH_*` VARIABLES, and that is the constraint the fix was given: the
 * gate must pass with none set anywhere, because that is CI's state and a fresh
 * clone's. `GATEWAY_PROVIDER` is likewise unset, so the sandbox driver stays the
 * default and `MyFatoorahGateway`'s pure halves are exercised as a class rather
 * than as the configured provider.
 *
 * `NODE_ENV` is unset too, so it defaults to development. Setting it to
 * `production` here would trip the four production-only requirements in `env.ts`
 * and buy nothing — and it would silently test a different configuration from the
 * one these specs are about.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * The environment a UNIT spec in this package may assume, and nothing more.
     *
     * These are values, not connections. `db/client.ts` builds a `postgres()`
     * client at module load but postgres-js connects lazily on the first query, so
     * a spec that runs no query touches no database — which is why a syntactically
     * valid URL pointing at nothing is the right value here. A spec that needs a
     * real database belongs in `e2e/`, against a per-run database, which is what
     * `e2e/support/tenancy-harness.ts` already provides.
     */
    env: {
      /**
       * Deliberately unreachable: port 1, a database name that says what it is. If
       * a unit spec ever does connect, it fails loudly here rather than quietly
       * succeeding against whatever database the developer happened to have
       * exported — which is the failure mode LANES.md § "Every lane isolates its own
       * resources" is entirely about.
       */
      DATABASE_URL: 'postgres://avo:unit-tests-do-not-connect@127.0.0.1:1/avo_unit_never',
      APP_DATABASE_URL: 'postgres://avo_app:unit-tests-do-not-connect@127.0.0.1:1/avo_unit_never',
      /** 32+ characters, which `env.ts` requires. Not a secret; nothing signs a real token. */
      JWT_SECRET: 'unit-test-jwt-secret-not-a-real-one-0123456789',
      /**
       * FIXED, and this is the improvement rather than the workaround.
       * `myfatoorah.test.ts` signs a fixture with this and verifies it through the
       * gateway, which reads the same value — so only agreement matters. Outside
       * production `env.ts` defaults it to `randomUUID() + randomUUID()`, so the
       * suite has been signing with a different secret every run. A signature spec
       * with a random key is a signature spec that cannot be reasoned about.
       */
      GATEWAY_WEBHOOK_SECRET: 'unit-test-gateway-webhook-secret',
    },
  },
});
