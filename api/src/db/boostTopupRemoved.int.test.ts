/**
 * MIGRATION 0068 ZEROES EVERY BRANCH BOOST'S TOP-UP BONUS, AND THEN HOLDS IT AT 0.
 *
 * Aftab, 2026-09-29: "Remove it from boosts". The bonus was never paid (a top-up
 * has no branch), so the migration rewrites a merchant's setting that never moved
 * a fil. This file proves the rewrite does exactly that and nothing more:
 *
 *   - a non-zero `topup` goes to 0
 *   - a row the zeroing leaves NEUTRAL (1/0/1) loses its window, so a neutral
 *     branch stays one shape (`parseBoost` drops the window on "no boost")
 *   - a row still boosting visits or stamps KEEPS its window
 *   - a row already at 0 is untouched, `updated_at` included
 *   - `boost_topup_removed` then refuses a non-zero value
 *
 * THE MIGRATION'S OWN SQL, READ FROM DISK — `brandColorDefault.int.test.ts`'s
 * argument. A spec that re-typed the UPDATE would be testing itself.
 *
 * AGAINST A TEMP `boost`, BECAUSE THE REAL ONE ALREADY HOLDS THE CHECK. On a
 * migrated database no non-zero row can exist to be zeroed, and this suite runs
 * as `avo_app`, which cannot drop a constraint it does not own. So the
 * transaction creates `pg_temp.boost` LIKE the real table WITHOUT its CHECKs,
 * fills it with the rows a deployed 0067 database can hold, and runs the
 * migration verbatim. `pg_temp` is first on the search path for relations, so the
 * unqualified `"boost"` in the migration resolves to the copy. The transaction is
 * always rolled back, and the copy goes with it.
 *
 * The last spec is about the REAL table: the constraint is there after a
 * migrate, and the database refuses a non-zero value whatever the API does.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const MIGRATION = '0068_a_branch_boost_pays_no_top_up';

function migrationStatements(): string[] {
  const sqlText = readFileSync(join(__dirname, '..', '..', 'drizzle', `${MIGRATION}.sql`), 'utf8');
  return sqlText
    .split('--> statement-breakpoint')
    .map((chunk) =>
      chunk
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((chunk) => chunk.length > 0);
}

interface Row {
  branch_id: string;
  visit: number;
  topup: number;
  stamp: number;
  starts_at: string | null;
  ends_at: string | null;
  updated_at: string;
}

suite('migration 0068 — every boost top-up goes to 0, and stays there', () => {
  let db: (typeof import('./client'))['db'];
  let orm: typeof import('drizzle-orm');

  const statements = migrationStatements();

  beforeAll(async () => {
    db = (await import('./client')).db;
    orm = await import('drizzle-orm');
  });

  afterAll(async () => {
    // Nothing to clean: every fixture lives in a rolled-back temp table.
  });

  it('reads the UPDATE and the CHECK out of the file, in that order', () => {
    expect(statements).toHaveLength(3);
    expect(statements[0]).toMatch(/^SET lock_timeout/);
    expect(statements[1]).toMatch(/^UPDATE "boost"/);
    // Scoped, so a row already at 0 is not re-stamped.
    expect(statements[1]).toMatch(/WHERE "topup" <> 0/);
    expect(statements[2]).toMatch(/ADD CONSTRAINT "boost_topup_removed" CHECK \("topup" = 0\)/);
  });

  it('zeroes the top-up, clears a window left on nothing, keeps a real boost\'s window, and leaves 0 alone', async () => {
    class Rollback extends Error {}
    const ROLLBACK = new Rollback('intentional');

    const START = '2031-01-01T09:00:00+00:00';
    const END = '2031-01-02T09:00:00+00:00';
    const OLD = '2026-01-01T00:00:00+00:00';

    let after: Record<string, Row> = {};
    let constraintOnCopy = -1;
    let refusedAfter: string | null = null;

    try {
      await db.transaction(async (tx) => {
        await tx.execute(
          orm.sql.raw(`CREATE TEMP TABLE boost (LIKE public.boost INCLUDING DEFAULTS) ON COMMIT DROP`),
        );
        await tx.execute(orm.sql`
          INSERT INTO boost (salon_id, branch_id, visit, topup, stamp, starts_at, ends_at,
                             published_by, updated_at)
          VALUES
            -- top-up only, with a window: becomes neutral, and the window goes
            ('S', 'ONLY-TOPUP', 1, 10, 1, ${START}::timestamptz, ${END}::timestamptz, 'x', ${OLD}::timestamptz),
            -- a real visit boost with a top-up, and a window: keeps the window
            ('S', 'VISIT-AND-TOPUP', 2, 20, 1, ${START}::timestamptz, ${END}::timestamptz, 'x', ${OLD}::timestamptz),
            -- a stamp boost with a top-up and no window
            ('S', 'STAMP-AND-TOPUP', 1, 30, 3, NULL, NULL, 'x', ${OLD}::timestamptz),
            -- already 0: untouched, updated_at included
            ('S', 'NO-TOPUP', 2, 0, 1, ${START}::timestamptz, ${END}::timestamptz, 'x', ${OLD}::timestamptz)
        `);

        for (const statement of statements) await tx.execute(orm.sql.raw(statement));

        const rows = (await tx.execute(orm.sql`
          SELECT branch_id, visit, topup, stamp,
                 starts_at::text AS starts_at, ends_at::text AS ends_at, updated_at::text AS updated_at
            FROM pg_temp.boost`)) as unknown as Row[];
        after = Object.fromEntries(rows.map((r) => [r.branch_id, r]));

        const c = (await tx.execute(orm.sql`
          SELECT count(*)::int AS n FROM pg_constraint
           WHERE conrelid = 'pg_temp.boost'::regclass AND conname = 'boost_topup_removed'`)) as unknown as Array<{ n: number }>;
        constraintOnCopy = c[0]?.n ?? -1;

        // The CHECK the migration just added refuses a non-zero value on the copy.
        try {
          await tx.transaction(async (sp) => {
            await sp.execute(orm.sql`UPDATE pg_temp.boost SET topup = 5 WHERE branch_id = 'NO-TOPUP'`);
          });
        } catch (err) {
          refusedAfter = (err as { code?: string; cause?: { code?: string } }).code
            ?? (err as { cause?: { code?: string } }).cause?.code
            ?? 'unknown';
        }

        throw ROLLBACK;
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }

    expect(Object.values(after).map((r) => r.topup)).toEqual([0, 0, 0, 0]);

    expect(after['ONLY-TOPUP']).toMatchObject({ visit: 1, stamp: 1, starts_at: null, ends_at: null });
    expect(after['ONLY-TOPUP']?.updated_at).not.toBe(after['NO-TOPUP']?.updated_at);

    expect(after['VISIT-AND-TOPUP']).toMatchObject({ visit: 2, stamp: 1 });
    expect(Date.parse(String(after['VISIT-AND-TOPUP']?.starts_at))).toBe(Date.parse(START));
    expect(Date.parse(String(after['VISIT-AND-TOPUP']?.ends_at))).toBe(Date.parse(END));

    expect(after['STAMP-AND-TOPUP']).toMatchObject({ visit: 1, stamp: 3, starts_at: null, ends_at: null });

    // Already 0: the WHERE skipped it, so its updated_at is the fixture's.
    expect(Date.parse(String(after['NO-TOPUP']?.updated_at))).toBe(Date.parse(OLD));

    expect(constraintOnCopy).toBe(1);
    expect(refusedAfter).toBe('23514');
  });

  it('the real table carries the CHECK after a migrate, and refuses a non-zero top-up', async () => {
    const c = (await db.execute(orm.sql`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid = 'public.boost'::regclass AND conname = 'boost_topup_removed'`)) as unknown as Array<{ def: string }>;
    expect(c[0]?.def).toBe('CHECK ((topup = 0))');

    const nonZero = (await db.execute(
      orm.sql`SELECT count(*)::int AS n FROM public.boost WHERE topup <> 0`,
    )) as unknown as Array<{ n: number }>;
    expect(nonZero[0]?.n).toBe(0);

    let code: string | null = null;
    try {
      await db.execute(orm.sql`
        UPDATE public.boost SET topup = 10
         WHERE salon_id = 'SAL-AMARA' AND branch_id = 'BR-KWC'`);
    } catch (err) {
      code = (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code ?? 'unknown';
    }
    expect(code).toBe('23514');
  });
});
