/**
 * CAN A NEW ENVIRONMENT BE BUILT FROM NOTHING?
 *
 * HOW TO RUN
 *
 *   pnpm --dir ./api run db:up
 *   cd e2e && ../node_modules/.bin/vitest run seed.test.ts
 *
 * This file boots no API and holds no session. It creates an EMPTY database, runs
 * `api/src/db/migrate.ts` and then `api/src/db/seed.ts` against it exactly the way
 * `pnpm --dir ./api run db:migrate && … db:seed` would, and asks whether the
 * result is a working environment. Then it drops the database.
 *
 * WHY THIS IS A SPEC AND NOT A CHORE
 * ----------------------------------
 * Every other suite in this directory runs against a database that already
 * exists. That is the normal case and it is the one that hides this class of
 * defect completely.
 *
 * The seed inserted `artist` rows referencing `staff_user_id = 'ST-002'` a
 * hundred and thirty lines before it inserted `staff_user`. Against any database
 * that had EVER been seeded, ST-002 was already there and the foreign key was
 * satisfied by a row left over from a previous run — so the seed passed, locally,
 * for everyone, indefinitely. Against a genuinely empty database it died:
 *
 *     ERROR 23503  insert or update on table "artist" violates foreign key
 *                  constraint "artist_staff_user_id_staff_user_id_fk"
 *                  Key (staff_user_id)=(ST-002) is not present in table "staff_user".
 *
 * Lane D hit it while building its own isolated database and had to work around
 * it with a `pg_dump` clone. That workaround is in `support/tenancy-harness.ts`
 * and it is honest about being one. This is the spec that means nobody has to
 * discover the underlying problem the same way twice.
 *
 * WHAT IT ACTUALLY PROTECTS
 * -------------------------
 * A seed that only works on a warm database is a seed that lies about what it
 * did. The cost is not felt in development, where every machine is warm; it is
 * felt the first time somebody provisions staging, or a CI job starts from a
 * clean volume, or a new engineer runs `db:up` on a laptop — which is to say, it
 * is felt by whoever has the least context to debug it.
 *
 * It is also a live constraint on the seed's shape: the insert order has to
 * respect the foreign keys, and the only thing that can check that is an empty
 * database.
 *
 * THIS SUITE IS SLOW BY NATURE — it runs a full migration chain and a full seed.
 * That is the price of the only check that can catch this, and it runs in about
 * the time one gateway spec takes.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { precondition } from './support/known-bug.js';
import {
  createEmptyDatabase,
  dropDatabase,
  migrateDatabase,
  scalarOnDatabase,
  seedDatabase,
} from './support/tenancy-harness.js';

/**
 * A database name nobody else uses, unique to this process.
 *
 * Not a fixed name: two lanes running their suites at once would otherwise drop
 * each other's scratch database mid-migration, which is precisely the class of
 * cross-lane interference the isolated database exists to end.
 */
const SCRATCH = `avo_seedprobe_${process.pid}`;

afterAll(() => {
  dropDatabase(SCRATCH);
});

describe('a new environment can be built from an empty database', () => {
  /**
   * MIGRATION FIRST, AND ON ITS OWN.
   *
   * Separated from the seed deliberately. If both ran in one spec, a failure
   * would not say which half broke — and "the migration chain does not apply
   * cleanly from zero" and "the seed cannot populate a clean schema" are
   * different defects with different owners inside lane A.
   */
  it('the migration chain applies from zero', () => {
    createEmptyDatabase(SCRATCH);

    // Genuinely empty before we start, or this proves nothing.
    const before = scalarOnDatabase(
      SCRATCH,
      "select count(*) from information_schema.tables where table_schema='public'",
    );
    precondition(before === '0', `${SCRATCH} was not empty: ${before} tables`);

    const migrated = migrateDatabase(SCRATCH);
    expect(
      migrated.ok,
      'api/src/db/migrate.ts failed against an empty database, so no new environment can be ' +
        `provisioned at all:\n--- stderr ---\n${migrated.stderr}`,
    ).toBe(true);

    // The tables the whole product is built on. A migration that "succeeded"
    // without creating them would pass on the exit code alone.
    for (const table of [
      'salon',
      'branch',
      'service',
      'artist',
      'staff_user',
      'member',
      'transaction',
      'ledger_entry',
      'wallet_token',
      'idempotency_key',
      'receipt_job',
      'topup_intent',
      'audit_log',
      'session',
    ]) {
      expect(
        scalarOnDatabase(
          SCRATCH,
          `select count(*) from information_schema.tables where table_schema='public' and table_name='${table}'`,
        ),
        `the migration chain left no "${table}" table`,
      ).toBe('1');
    }
  }, 120_000);

  /**
   * THE SEED, AGAINST THE SCHEMA THE SPEC ABOVE JUST BUILT.
   *
   * PROMOTED. This was written as a `knownBug()` because it failed — the seed
   * inserted `artist` rows referencing ST-002 before `staff_user` existed — and it
   * flipped to "this bug appears to be FIXED" the moment lane A moved the
   * `staff_user` inserts above the `artist` insert. That is the helper doing its
   * job, and this is the promotion it asked for.
   *
   * A plain `it()` from here on, and the value is almost entirely forward-looking:
   * the bug it was written for is gone, and what it now guards is the next person
   * who adds a table with a foreign key and inserts it in the wrong order. They
   * find out here, in seconds, rather than six weeks later from whoever is
   * provisioning staging at the time.
   */
  it('lane A\'s seed populates an empty database', () => {
    const seeded = seedDatabase(SCRATCH);

    expect(
      seeded.ok,
      'api/src/db/seed.ts failed against a freshly migrated database. It passes on any database ' +
        'that has been seeded before, because the rows its foreign keys need are already there — ' +
        'so this is invisible everywhere except a genuinely new environment:\n' +
        `--- stderr ---\n${seeded.stderr}`,
    ).toBe(true);
  }, 120_000);

  /**
   * WHAT A SUCCESSFUL SEED HAS TO HAVE PRODUCED.
   *
   * Guards the failure mode where the seed exits zero having half run. It is
   * skipped rather than failed when the seed did not succeed, because the spec
   * above already reports that and two red specs for one defect is noise.
   */
  it('and the environment it produces is the one every other suite assumes', () => {
    const seedWorked =
      scalarOnDatabase(
        SCRATCH,
        "select count(*) from information_schema.tables where table_schema='public' and table_name='staff_user'",
      ) === '1' &&
      scalarOnDatabase(SCRATCH, "select count(*) from staff_user where id='ST-001'") === '1';

    if (!seedWorked) {
      // The spec above owns this failure. Two red specs for one defect is noise.
      return;
    }

    // The named fixtures the rest of this directory is written against —
    // api/src/db/seed.ts's own header says it mirrors packages/mock/src/fixtures.ts
    // "because Lane D's e2e suite asserts against those exact values".
    const checks: Array<[what: string, sql: string, expected: string]> = [
      ['salon SAL-AMARA', "select count(*) from salon where id='SAL-AMARA'", '1'],
      ['member 8842 at 24.500 KD', "select balance_fils::text from member where id='8842'", '24500'],
      ['member 8843, the lowbal fixture', "select balance_fils::text from member where id='8843'", '2500'],
      ['ST-001 with every permission', "select (perm_team and perm_charges and perm_void)::text from staff_user where id='ST-001'", 'true'],
      ['ST-002 with charges and void off', "select (perm_charges or perm_void)::text from staff_user where id='ST-002'", 'false'],
      ['AR-003 wired to ST-002', "select coalesce(staff_user_id,'-') from artist where id='AR-003'", 'ST-002'],
      ['the TX-9021 charge', "select count(*) from transaction where id='TX-9021'", '1'],
    ];

    const wrong = checks
      .map(([what, sql, expected]) => ({ what, expected, got: scalarOnDatabase(SCRATCH, sql) }))
      .filter((c) => c.got !== c.expected)
      .map((c) => `  ${c.what}: expected ${c.expected}, got "${c.got}"`);

    expect(
      wrong,
      'the seed exited successfully but did not produce the fixtures the suite is written ' +
        `against:\n${wrong.join('\n')}`,
    ).toEqual([]);

    /**
     * AND THE LEDGER RECONCILES TO THE BALANCE.
     *
     * The seed's own comment says TX-9021 is written "the way the API would have
     * written it", with a balanced pair of entries — a seed that inserted the
     * transaction and skipped the ledger would satisfy every check above and leave
     * the environment lying about its money.
     *
     * ASSERTED VIA `balance_after_fils`, NOT BY SUMMING FROM ZERO. The first draft
     * summed every wallet movement and expected 24.500; it got −8.000, and the
     * seed was right. Dana is INSERTED at 32.500 and the charge then moves her to
     * 24.500, so the ledger holds the movement (−8.000) and not an opening entry —
     * it is a record of what happened, not a from-nothing reconstruction of an
     * account that existed before the row did.
     *
     * `balance_after_fils` is the column that carries the reconciliation, and the
     * invariant that actually matters is that the newest entry agrees with the
     * member row. If they ever disagree, the ledger and the wallet are telling two
     * different stories about the same money.
     */
    const reconciliation = scalarOnDatabase(
      SCRATCH,
      `select coalesce((
         select balance_after_fils::text from ledger_entry
          where member_id='8842' and account='member_wallet' and balance_after_fils is not null
          order by id desc limit 1
       ), 'no wallet ledger entry at all')`,
    );
    const balance = scalarOnDatabase(SCRATCH, "select balance_fils::text from member where id='8842'");

    expect(
      reconciliation,
      "member 8842's wallet ledger does not reconcile to her balance — the seed wrote a " +
        'transaction with no balanced entries behind it',
    ).toBe(balance);
    // And it is the fixture figure the rest of the suite is written against.
    expect(balance).toBe('24500');
  }, 60_000);
});
