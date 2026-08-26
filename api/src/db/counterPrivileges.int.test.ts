/**
 * THE FOUR RATE-LIMIT COUNTERS ARE APPEND-ONLY FOR THE APPLICATION ROLE.
 *
 * `pin_attempt`, `signup_attempt`, `scanner_attempt`, `sign_in_attempt`. One
 * sentence, from migration 0026 and repeated in 0038 and 0039: "a row that can be
 * UPDATEd or DELETEd is a counter that can be reset by whatever gets compromised
 * next, and a limiter whose own rows the application can remove is not a limit."
 *
 * WHY THIS FILE EXISTS RATHER THAN A FOURTH COPY OF ONE SPEC
 * ---------------------------------------------------------
 * `pin_attempt` shipped in migration 0002 and did not get the REVOKE until 0040 —
 * measured, not inferred: `avo_app DELETE FROM pin_attempt` answered `DELETE 0`
 * while the same statement against all three siblings answered `permission
 * denied`. The pattern started at 0026 and never reached back, because each new
 * sibling is written by reading the most recent one and the most recent one is
 * never the oldest one.
 *
 * So the assertion is deliberately over the FAMILY and not over the table that was
 * broken. A fifth counter that forgets the REVOKE fails here on the day it is
 * added, which is the only thing that stops this happening a sixth time. `COUNTERS`
 * below is the list to extend.
 *
 * WHY UPDATE IS ASSERTED AS CAREFULLY AS DELETE, and why `pin_attempt` gets one
 * extra: it is the only sibling with an outcome column (0026 records why the others
 * have none), and `routes/auth.ts` counts its window with
 * `eq(pinAttempt.succeeded, false)`. So `UPDATE pin_attempt SET succeeded = true`
 * empties a device's rate-limit window while deleting nothing — the row count is
 * unchanged and the table still looks full. A DELETE at least leaves a hole.
 *
 * THE ROLE IS THE POINT, so the suite refuses to run as anything else. These
 * assertions are meaningless as the owner — the owner is SUPPOSED to be able to do
 * all of this, and both real cleanup paths (`db/seed.ts` behind `RESET_SESSIONS`,
 * and `e2e/support/tenancy-harness.ts`'s `resetPinState`) are the owner. The
 * `current_user` guard below is what stops a run pointed at the wrong URL from
 * reporting something it did not test. `vitest.int.config.ts` already argues for
 * this: "a limiter proved under the owner role is a limiter proved against
 * privileges production does not have."
 *
 * `WHERE false` ON EVERY REFUSED STATEMENT, on purpose. Postgres checks the
 * privilege before it evaluates the predicate — demonstrated by the measurement
 * above, where `DELETE FROM pin_attempt WHERE false` was permitted and the
 * siblings' were not — so the assertion is unweakened, and a run against a
 * database where the REVOKE is missing destroys nothing while it fails.
 *
 * NO CLEANUP, BY CONSTRUCTION. The INSERT probes leave one counter row each, on
 * randomised keys nothing else looks at, and `avo_app` cannot remove them — which
 * is the property being proved.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const INT_URL = process.env.AVO_INT_DATABASE_URL;

/**
 * SKIP RATHER THAN CONNECT. With the variable unset this file imports nothing —
 * not `db/client.ts` — so it cannot reach a database it was not pointed at.
 * `LANES.md` § "Every lane isolates its own resources".
 */
const suite = INT_URL ? describe : describe.skip;

/** The seeded salon, for the columns that carry a foreign key to it. */
const SALON = 'SAL-AMARA';

interface Counter {
  table: string;
  /** A row the limiter itself would write. `avo_app` must be able to insert it. */
  insert: () => string;
}

/**
 * THE FAMILY. Extend this when a fifth counter is added — that is the whole point
 * of the file. Migration 0040's header explains why the list is safer than four
 * separate specs.
 */
const COUNTERS: Counter[] = [
  {
    table: 'pin_attempt',
    insert: () =>
      `INSERT INTO pin_attempt (salon_id, device_id, staff_id, succeeded)
         VALUES ('${SALON}', 'DEV-PRIV-${randomUUID()}', NULL, false)`,
  },
  {
    table: 'signup_attempt',
    insert: () =>
      `INSERT INTO signup_attempt (salon_id, ip_address)
         VALUES ('${SALON}', '203.0.113.${Math.floor(Math.random() * 254) + 1}')`,
  },
  {
    table: 'scanner_attempt',
    insert: () =>
      `INSERT INTO scanner_attempt (salon_id, device_id, action)
         VALUES ('${SALON}', 'DEV-PRIV-${randomUUID()}', 'scan')`,
  },
  {
    table: 'sign_in_attempt',
    insert: () =>
      `INSERT INTO sign_in_attempt (surface, identity_key, salon_id)
         VALUES ('member', '${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}', '${SALON}')`,
  },
];

suite('the rate-limit counters are append-only for the application role', () => {
  // Bound in beforeAll. Imported there rather than at the top of the file so an
  // unset AVO_INT_DATABASE_URL skips without `env.ts` throwing at module load.
  let db: typeof import('./client')['db'];
  let orm: typeof import('drizzle-orm');

  /** Runs `statement`; returns 'SUCCEEDED' or the error, the shape e2e already uses. */
  async function attempt(statement: string): Promise<string> {
    try {
      await db.execute(orm.sql.raw(statement));
      return 'SUCCEEDED';
    } catch (err) {
      return String(err);
    }
  }

  async function rowCount(table: string): Promise<number> {
    const rows = (await db.execute(
      orm.sql.raw(`SELECT count(*)::int AS n FROM ${table}`),
    )) as unknown as Array<{ n: number }>;
    return rows[0]?.n ?? 0;
  }

  beforeAll(async () => {
    db = (await import('./client')).db;
    orm = await import('drizzle-orm');

    /**
     * THE GUARD THAT MAKES EVERY ASSERTION BELOW MEAN SOMETHING. As the owner these
     * statements are all supposed to succeed, so a run pointed at the owner URL
     * would be reporting on privileges production does not have.
     */
    const who = (await db.execute(
      orm.sql.raw('SELECT current_user AS u'),
    )) as unknown as Array<{ u: string }>;
    expect(
      who[0]?.u,
      'AVO_INT_DATABASE_URL must name the avo_app role — these assertions are ' +
        'vacuous as the owner, which is allowed to do all of this',
    ).toBe('avo_app');
  });

  afterAll(async () => {
    // Nothing to clean up: `avo_app` cannot remove what it inserted, which is the
    // property under test.
  });

  for (const counter of COUNTERS) {
    describe(counter.table, () => {
      it('refuses DELETE', async () => {
        expect(
          await attempt(`DELETE FROM ${counter.table} WHERE false`),
          `the application role can DELETE from ${counter.table}, so the limiter can be ` +
            'reset by whatever compromises the API',
        ).toMatch(/permission denied/i);
      });

      it('refuses UPDATE, so the window cannot be back-dated', async () => {
        expect(
          await attempt(`UPDATE ${counter.table} SET created_at = now() - interval '2 hours' WHERE false`),
          `the application role can back-date rows in ${counter.table}, which expires the ` +
            'window on demand',
        ).toMatch(/permission denied/i);
      });

      it('refuses TRUNCATE', async () => {
        expect(
          await attempt(`TRUNCATE ${counter.table}`),
          `the application role can TRUNCATE ${counter.table}`,
        ).toMatch(/permission denied|must be owner/i);
      });

      it('still allows the INSERT and the SELECT the limiter needs', async () => {
        // Both, or the limiter could not count at all — a REVOKE that took these
        // would be a broken limiter rather than a hardened one.
        const before = await rowCount(counter.table);

        expect(
          await attempt(counter.insert()),
          `the application role cannot INSERT into ${counter.table}, so the limiter cannot count`,
        ).toBe('SUCCEEDED');

        expect(
          await rowCount(counter.table),
          `the application role cannot SELECT ${counter.table}, so the limiter cannot read ` +
            'its own counter',
        ).toBe(before + 1);
      });
    });
  }

  it('refuses the succeeded flip on pin_attempt, which resets a window without deleting a row', async () => {
    /**
     * The one asymmetric case, and the reason the missing UPDATE revoke was worse
     * than the missing DELETE one. `pin_attempt` is the only sibling with an
     * outcome column, and `routes/auth.ts` counts the device window with
     * `eq(pinAttempt.succeeded, false)` — so flipping the flag frees the budget
     * while leaving the row count untouched.
     */
    expect(
      await attempt('UPDATE pin_attempt SET succeeded = true WHERE false'),
      'the application role can mark failed PIN attempts as successful, which empties a ' +
        "device's rate-limit window while deleting nothing",
    ).toMatch(/permission denied/i);
  });

  it('leaves the counters standing after every refused statement', async () => {
    // Each refusal above ran with `WHERE false`, so nothing should have been
    // touched even if a privilege were wrongly held. This is the witness.
    for (const counter of COUNTERS) {
      expect(await rowCount(counter.table), `${counter.table} lost rows`).toBeGreaterThan(0);
    }
  });
});
