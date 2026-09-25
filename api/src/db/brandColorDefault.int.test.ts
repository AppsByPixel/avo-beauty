/**
 * MIGRATION 0055 REWRITES THE OLD DEFAULT BRAND COLOUR, AND NOTHING ELSE.
 *
 *   old default   #6E7F6C   the sage the product shipped with
 *   new default   #459A3C   the vivid green `packages/tokens` now ships
 *
 * The decision the migration encodes is narrow and the narrowness is the whole
 * value: a salon sitting on `#6E7F6C` never chose a colour, so it moves; a salon
 * that picked its own hex owns it, so it does not. `SAL-LUMIERE` is `#7A5C8E`
 * and that purple is the live case a careless `UPDATE salon SET brand_color`
 * would destroy — which is why the untouched-row assertion below uses a real
 * purple rather than a second green.
 *
 * WHY THIS FILE RUNS THE MIGRATION'S OWN SQL RATHER THAN A COPY OF IT
 * ------------------------------------------------------------------
 * There is no precedent in `api/` for testing a DATA migration — 0044 and 0051
 * both carry an `UPDATE` and neither has a spec — so the shape is chosen here.
 * A spec that re-typed the statement would assert that a `WHERE` clause in THIS
 * file behaves correctly, which is a fact about this file. `api/README.md`'s
 * § "a spec that restates the token file cannot notice the token file changing"
 * is the same failure one level up. So the statement is READ FROM THE .sql ON
 * DISK: widen the `WHERE` in the migration and the purple assertion here goes
 * red, which is the only arrangement that makes this file worth running.
 *
 * WHY IT RUNS INSIDE A TRANSACTION THAT IS ALWAYS ROLLED BACK
 * ----------------------------------------------------------
 * The migration's `UPDATE` is deliberately unscoped — it is supposed to reach
 * every salon in the database. Run for real against a lane database it would
 * also move the seeded `SAL-AMARA`, and `e2e/whitelabel.test.ts` pins that row
 * at `#6E7F6C` ("salon A's seed"). A spec that leaves the shared seed rewritten
 * would hand Lane D a red it did not cause. Rolling back also makes the file
 * re-runnable on the same database for free, which `api/README.md` requires and
 * which the `artistDayVoid` fixture had to be rebuilt to achieve.
 *
 * THE THIRD FIXTURE IS LOWER CASE, AND IT IS NOT A FLOURISH.
 * `services/brandColor.ts` § parseBrandColor returns the merchant's hex VERBATIM
 * rather than upper-casing it, and `salon_brand_color_is_hex` admits `[0-9A-Fa-f]`.
 * So `#6e7f6c` is a storable row. An exact-match `WHERE` would walk past it and
 * strand that salon on the old sage — the quietest possible way for this
 * migration to half-work.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const INT_URL = process.env.AVO_INT_DATABASE_URL;

/**
 * SKIP RATHER THAN CONNECT. With the variable unset this file imports nothing —
 * not `db/client.ts` — so it cannot reach a database it was not pointed at.
 * `LANES.md` § "Every lane isolates its own resources".
 */
const suite = INT_URL ? describe : describe.skip;

const MIGRATION = '0055_the_default_sage_was_never_a_choice';

const OLD_DEFAULT = '#6E7F6C';
const NEW_DEFAULT = '#459A3C';
/** SAL-LUMIERE's real hex. A chosen colour, and the one with the most to lose. */
const CHOSEN = '#7A5C8E';

/**
 * The migration's statements, comments stripped. Drizzle separates them with
 * `--> statement-breakpoint`; 0055 has one statement, and the split is here so
 * that a second statement added to the file is executed rather than silently
 * ignored.
 */
function migrationStatements(): string[] {
  const sqlText = readFileSync(
    join(__dirname, '..', '..', 'drizzle', `${MIGRATION}.sql`),
    'utf8',
  );
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

/**
 * The only surface `read` needs, so it takes the transaction and the database
 * alike. `db` and a `tx` are deliberately NOT the same type — a transaction has
 * no `$client` — and casting one to the other to share a helper would be
 * asserting something false to save a line.
 */
interface Executor {
  execute(query: SQL): Promise<unknown>;
}

interface Row {
  id: string;
  brand_color: string;
  updated_at: string;
}

suite('migration 0055 — only the rows still holding the old default move', () => {
  // Bound in beforeAll. Imported there rather than at the top of the file so an
  // unset AVO_INT_DATABASE_URL skips without `env.ts` throwing at module load.
  let db: typeof import('./client')['db'];
  let orm: typeof import('drizzle-orm');

  /** Unique per run, so two runs against one database never collide on the key. */
  const run = randomUUID().slice(0, 8).toUpperCase();
  const UPPER = `SAL-T55U-${run}`;
  const LOWER = `SAL-T55L-${run}`;
  const OWN = `SAL-T55P-${run}`;

  const statements = migrationStatements();

  async function seedSalon(id: string, hex: string): Promise<void> {
    await db.execute(
      orm.sql`INSERT INTO salon
                (id, name, brand_color, loyalty_mode, stamp_target, stamp_reward,
                 deposit_fils, business_hours)
              VALUES (${id}, ${`0055 fixture ${id}`}, ${hex}, 'stamps', 6,
                      'free blow-dry', 5000, '{}'::jsonb)`,
    );
  }

  async function read(exec: Executor, ids: string[]): Promise<Record<string, Row>> {
    const rows = (await exec.execute(
      orm.sql`SELECT id, brand_color, updated_at::text AS updated_at
                FROM salon WHERE id IN ${orm.sql.raw(`(${ids.map((i) => `'${i}'`).join(',')})`)}`,
    )) as unknown as Row[];
    return Object.fromEntries(rows.map((r) => [r.id, r]));
  }

  beforeAll(async () => {
    db = (await import('./client')).db;
    orm = await import('drizzle-orm');

    // The fixtures are committed; only the migration's own UPDATE is rolled back.
    await seedSalon(UPPER, OLD_DEFAULT);
    await seedSalon(LOWER, OLD_DEFAULT.toLowerCase());
    await seedSalon(OWN, CHOSEN);
  });

  afterAll(async () => {
    if (!db) return;
    await db.execute(
      orm.sql`DELETE FROM salon WHERE id IN (${UPPER}, ${LOWER}, ${OWN})`,
    );
  });

  it('reads exactly one statement out of the migration file', () => {
    expect(statements).toHaveLength(1);
    // The narrowness under test. A blanket `UPDATE salon SET brand_color` — the
    // statement this migration deliberately is not — has no WHERE at all.
    expect(statements[0]).toMatch(/WHERE/i);
    expect(statements[0]).toContain(NEW_DEFAULT);
  });

  it('moves the old default, leaves a chosen hex alone, and is a no-op twice', async () => {
    const ids = [UPPER, LOWER, OWN];

    /**
     * ROLLBACK IS THE POINT, not an afterthought — see the header. `db.transaction`
     * rolls back when its callback throws, so the assertions run inside and the
     * sentinel unwinds it afterwards.
     */
    class Rollback extends Error {}
    const ROLLBACK = new Rollback('intentional');

    let first: Record<string, Row> = {};
    let second: Record<string, Row> = {};
    let strandedAfter = -1;

    try {
      await db.transaction(async (tx) => {
        for (const statement of statements) await tx.execute(orm.sql.raw(statement));
        first = await read(tx, ids);

        // Nothing anywhere in the database is still on the old default. The
        // lower-case fixture is the row this would catch if the match were exact.
        const stranded = (await tx.execute(
          orm.sql`SELECT count(*)::int AS n FROM salon WHERE upper(brand_color) = ${OLD_DEFAULT}`,
        )) as unknown as Array<{ n: number }>;
        strandedAfter = stranded[0]?.n ?? -1;

        // Second application, same transaction: idempotent IN EFFECT.
        for (const statement of statements) await tx.execute(orm.sql.raw(statement));
        second = await read(tx, ids);

        throw ROLLBACK;
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }

    // 1. A salon on the old default moves to the new one.
    expect(first[UPPER]?.brand_color).toBe(NEW_DEFAULT);

    // 2. ...including one stored lower case, which parseBrandColor permits.
    expect(first[LOWER]?.brand_color).toBe(NEW_DEFAULT);

    // 3. A salon on its own hex is UNTOUCHED — not vivified, not normalised.
    //    This is the assertion a blanket UPDATE fails.
    expect(first[OWN]?.brand_color).toBe(CHOSEN);
    expect(first[OWN]?.updated_at).toBe(second[OWN]?.updated_at);

    expect(strandedAfter).toBe(0);

    // 4. Running it twice changes nothing the second time. `updated_at` is
    //    compared, not just the colour: a statement that re-stamped every salon
    //    on each re-run would pass a colour-only assertion while making a
    //    re-migrated database indistinguishable from a merchant edit.
    expect(second).toStrictEqual(first);
  });

  it('leaves the row untouched when no row holds the old default', async () => {
    /**
     * Idempotent in effect on a database that never had the old default at all —
     * the same `WHERE`, stated as its own case because this is what a second
     * environment (a demo, a fresh tenant) actually looks like.
     */
    class Rollback extends Error {}
    const ROLLBACK = new Rollback('intentional');
    let after: Record<string, Row> = {};

    const before = await read(db, [OWN]);

    try {
      await db.transaction(async (tx) => {
        await tx.execute(orm.sql`UPDATE salon SET brand_color = ${CHOSEN}
                                  WHERE upper(brand_color) = ${OLD_DEFAULT}`);
        for (const statement of statements) await tx.execute(orm.sql.raw(statement));
        after = await read(tx, [OWN]);
        throw ROLLBACK;
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }

    expect(after[OWN]?.brand_color).toBe(CHOSEN);
    expect(after[OWN]?.updated_at).toBe(before[OWN]?.updated_at);
  });
});
