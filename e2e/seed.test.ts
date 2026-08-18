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
  RUN_DB_PREFIX,
  createEmptyDatabase,
  dropDatabase,
  dropRunDatabase,
  isOwnRunDatabaseName,
  migrateDatabase,
  newRunDatabaseName,
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

/**
 * Does a named database exist? Asked through the maintenance database, so it needs
 * no connection to the database being asked about — which matters, because the
 * guard under test is meant to decide on the NAME, before anything is opened.
 */
const dbExists = (name: string): boolean =>
  scalarOnDatabase(
    'postgres',
    `select count(*) from pg_database where datname='${name}'`,
  ).trim() === '1';

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
    /**
     * ORDERED BY `seq`, AND THE FIRST VERSION OF THIS ORDERED BY `id`.
     *
     * `ledger_entry.id` is `uuid DEFAULT gen_random_uuid()`, so `order by id desc`
     * is not "the newest entry", it is an arbitrary one — and Dana has more than one
     * wallet entry carrying a `balance_after_fils`. This spec has therefore been
     * passing BY LUCK, on whichever UUID happened to sort last, and it finally drew
     * the other one and reported that the seed's ledger does not reconcile.
     *
     * The honest reading of that failure was "the seed is broken"; the truth was
     * that the spec had no ordering at all. `seq` is the monotonic column, and
     * `ledger_entry_member_seq_idx` on `(member_id, seq)` exists precisely for this
     * question — the schema was already telling me which column answers it.
     */
    const reconciliation = scalarOnDatabase(
      SCRATCH,
      `select coalesce((
         select balance_after_fils::text from ledger_entry
          where member_id='8842' and account='member_wallet' and balance_after_fils is not null
          order by seq desc limit 1
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


// ===========================================================================
// The teardown drop, which had one guard where it needed two.
// ===========================================================================

/**
 * WHY THIS IS IN THIS FILE AND NOT A COMMENT
 *
 * `dropRunDatabase()` runs in `global-setup.ts`'s teardown and issues
 * `DROP DATABASE … WITH (FORCE)`. Its only guard was `ownsItsDatabase()`, which
 * reads `POSTGRES_DB` and nothing else — so an `AVO_QA_DB` supplied from outside
 * satisfied it, even though `global-setup.ts` skips minting whenever it sees that
 * variable and the run therefore does not own the database at all.
 *
 *     AVO_QA_DB=avo_lane_d ../node_modules/.bin/vitest run
 *
 * would have dropped a trunk-owned lane database at teardown. Silently, because
 * `dropDatabase` swallows its own errors — the same "a misleading success line is
 * the same defect as a green typecheck bought with a cast" failure LANES.md
 * describes, arriving as a missing database rather than as a message.
 *
 * `sweepStaleRunDatabases` has always carried the prefix check. This is the rule
 * on the other drop path, and it is a spec rather than a comment because a comment
 * is what the first version had.
 *
 * NO DATABASE IS CREATED HERE. The refusal happens on the name, before any
 * connection, which is the whole point: the guard cannot depend on the thing it is
 * protecting still being there to be inspected.
 */
describe('dropRunDatabase refuses a database this run did not mint', () => {
  const savedQaDb = process.env.AVO_QA_DB;
  const savedPgDb = process.env.POSTGRES_DB;

  afterAll(() => {
    if (savedQaDb === undefined) delete process.env.AVO_QA_DB;
    else process.env.AVO_QA_DB = savedQaDb;
    if (savedPgDb === undefined) delete process.env.POSTGRES_DB;
    else process.env.POSTGRES_DB = savedPgDb;
  });

  /**
   * END TO END, ON THE DATABASE THIS FILE ALREADY OWNS.
   *
   * `SCRATCH` is `avo_seedprobe_<pid>`: real, connectable, created by the specs
   * above, carrying no `RUN_DB_PREFIX`, and dropped in `afterAll` regardless. So
   * it is exactly the shape of the hazard — a database this run did not mint — and
   * it is the one database on the container that can stand in for `avo_lane_d`
   * without the proof costing anything if the guard is ever wrong.
   *
   * THAT SUBSTITUTION IS THE POINT. Aiming this spec at `avo_lane_d` and then
   * checking it by removing the guard would mean deliberately dropping a
   * trunk-owned database to find out whether the spec noticed — the check would be
   * the incident. Here, flipping `isOwnRunDatabaseName` to `true` really does drop
   * `SCRATCH` and this spec really does go red, which is the proof, and the cost is
   * a database that was about to be destroyed anyway.
   *
   * The assertion is on the RETURN VALUE first — `undefined` for a refusal, the
   * name for a drop — so it says "the function declined" rather than only "the
   * database is still there". A drop of a database that never existed would leave
   * nothing behind either.
   */
  it('a database it did not mint is declined by name, and survives', () => {
    delete process.env.POSTGRES_DB;
    process.env.AVO_QA_DB = SCRATCH;

    // The tripwire. A spec that passed because the name was fictional would prove
    // nothing: `DROP DATABASE IF EXISTS` is a no-op on a name that resolves to
    // nothing, so "it still does not exist" is not evidence of a refusal.
    precondition(dbExists(SCRATCH), `${SCRATCH} does not exist, so nothing here is at stake`);

    const dropped = dropRunDatabase();

    expect(
      dropped,
      `dropRunDatabase returned "${dropped}", which means it dropped a database this run did ` +
        'not mint. Pointed at AVO_QA_DB=avo_lane_d that is a trunk-owned database gone.',
    ).toBeUndefined();

    // The consequence, checked separately from the refusal so neither can stand in
    // for the other.
    expect(dbExists(SCRATCH), `${SCRATCH} was dropped`).toBe(true);
  });

  /**
   * AND THE NAME THE REAL HAZARD USES, checked through the predicate because the
   * function cannot be asked twice — see the control below for why.
   *
   * `avo_lane_d` is trunk-owned and pre-created; LANES.md says to ask trunk rather
   * than create one. This is the assertion that ties the guard to the database it
   * exists to protect, and it is safe because the refusal happens on the name,
   * before any connection is opened.
   */
  it('and the trunk-owned lane databases are exactly what it refuses', () => {
    precondition(
      dbExists('avo_lane_d'),
      'avo_lane_d does not exist, so this spec is not about anything real',
    );
    for (const trunkOwned of ['avo', 'avo_ci', 'avo_lane_a', 'avo_lane_b', 'avo_lane_c', 'avo_lane_d']) {
      expect(
        isOwnRunDatabaseName(trunkOwned),
        `${trunkOwned} would have been dropped at teardown under AVO_QA_DB=${trunkOwned}`,
      ).toBe(false);
    }
    expect(dbExists('avo_lane_d'), 'avo_lane_d was dropped').toBe(true);
  });

  /**
   * THE CONTROL, and without it the spec above is satisfied by a `dropRunDatabase`
   * that had simply been broken shut — which would leak a database per run for
   * ever, quietly, and pass.
   *
   * IT GOES THROUGH THE PREDICATE RATHER THAN THE FUNCTION, and the reason is
   * worth knowing before writing the obvious version. `pgDb()` caches its
   * resolution on first call, so the spec above has already fixed this worker's
   * answer to `avo_lane_d`; a second `dropRunDatabase()` under a fresh
   * `AVO_QA_DB` re-reads nothing and refuses for the wrong reason. The first draft
   * of this spec did exactly that and failed with
   * "declined a name it had minted itself" — the guard was fine and the spec was
   * measuring the cache.
   */
  it('but a name this file minted is still accepted — the guard is a filter, not an off switch', () => {
    const minted = newRunDatabaseName();
    expect(minted.startsWith(RUN_DB_PREFIX)).toBe(true);
    expect(
      isOwnRunDatabaseName(minted),
      'the guard declined a name this file had just minted, so every run leaks its database',
    ).toBe(true);

    // And it discriminates, rather than answering true to everything.
    for (const foreign of ['avo', 'avo_ci', 'avo_lane_a', 'avo_lane_d', 'postgres']) {
      expect(isOwnRunDatabaseName(foreign), `${foreign} was treated as ours`).toBe(false);
    }
  });

  /**
   * THE OTHER GUARD IS NOT TESTED HERE, AND SAYING WHY IS THE USEFUL PART.
   *
   * `ownsItsDatabase()` closes over `EXPLICIT_DB`, which is `process.env.POSTGRES_DB`
   * read once at module load. Nothing a spec does to `process.env` afterwards can
   * change it, so a spec that set `POSTGRES_DB` here and asserted a refusal would
   * be asserting the PREFIX guard while appearing to assert the `POSTGRES_DB` one —
   * and it would keep passing if `ownsItsDatabase()` were deleted outright.
   *
   * That is the "assertion satisfied by the guard next door" shape, so it is
   * recorded rather than written. Reaching it needs a separate worker started with
   * the variable already set, which is a `vitest.config.ts` change and worth doing
   * only if that guard is ever suspected.
   */
});
