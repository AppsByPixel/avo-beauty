/**
 * TWO BRANCHES PER WORKSPACE AND AN ARTIST AT EACH, ON A DATABASE THAT MUST NOT
 * BE SEEDED.
 *
 *   DATABASE_URL='…owner…' pnpm --dir=/abs/path/to/api run db:demo-roster
 *
 * The layout and every rule are in db/rosterFixture.ts, shared with `db:seed`
 * so the demo's roster and a lane's are the same rows. This file is the
 * hosted-safe caller: it ADDS AND ASSIGNS ONLY.
 *
 *   - It deletes nothing and disables no trigger.
 *   - It never reads or writes a member, a balance, a transaction or a ledger
 *     entry, and reads bookings only to count them and to REFUSE a move that
 *     would leave a live booking at a branch its artist no longer works at
 *     (rosterFixture.ts § MOVING AN ARTIST WHO HAS APPOINTMENTS).
 *   - An existing artist's hours, an existing service and an existing branch
 *     are left exactly as they are. Only a missing row is created, and only
 *     `artist.branch_id` is ever changed on an existing one.
 *   - It switches `module_booking` ON at a roster salon where it is off,
 *     because an artist in a salon that takes no bookings is not bookable. It
 *     says so when it does.
 *   - SAL-FOREST missing is a skipped line, not a failure: `db:demo-forest`
 *     creates it, and this can be run again afterwards.
 *
 * RE-RUNNING IS SAFE. A second run finds everything in place and prints
 * `unchanged` for every artist.
 *
 * ONE TRANSACTION. A refusal is a line, not an error, so the rest still lands;
 * anything unexpected rolls every write back.
 *
 * PROOF IT TOUCHED NO MONEY: the counts of members, bookings, transactions and
 * ledger entries are printed before and after, and the script fails loudly if
 * any of them moved.
 *
 * IT DOES NOT READ `api/.env` — the npm script has no `--env-file`, for the
 * reason db/demoForest.ts gives. No `DATABASE_URL` is a refusal. Owner
 * connection; on Supabase use the SESSION pooler (5432), as for `db:migrate`.
 */

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { applyHostedRoster } from './rosterFixture';

function fail(message: string): never {
  console.error(`db:demo-roster: ${message}`);
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) fail('DATABASE_URL is not set. Point it at the owner role of the target database.');

const connection = postgres(databaseUrl, { max: 1, onnotice: () => {} });
const db = drizzle(connection);

type Counts = Record<'members' | 'bookings' | 'transactions' | 'ledger_entries', number>;

async function counts(): Promise<Counts> {
  const [row] = (await db.execute(sql`
    SELECT (SELECT count(*) FROM member)::int        AS members,
           (SELECT count(*) FROM booking)::int       AS bookings,
           (SELECT count(*) FROM "transaction")::int AS transactions,
           (SELECT count(*) FROM ledger_entry)::int  AS ledger_entries`)) as unknown as Counts[];
  return row!;
}

async function run(): Promise<void> {
  const [target] = (await db.execute(
    sql`SELECT current_database() AS name`,
  )) as unknown as Array<{ name: string }>;

  // The two schema facts this writes against, checked with a sentence rather
  // than left to fail as a missing-relation error halfway through.
  const [schema] = (await db.execute(sql`
    SELECT (SELECT count(*) FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'artist' AND column_name = 'branch_id')::int AS "branchColumn",
           (SELECT count(*) FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'artist_service')::int AS "pairTable"`)) as unknown as Array<{
    branchColumn: number;
    pairTable: number;
  }>;
  if (!schema || schema.branchColumn === 0) fail(`${target?.name}: artist.branch_id is missing. Run db:migrate (0044) first.`);
  if (schema.pairTable === 0) fail(`${target?.name}: artist_service is missing. Run db:migrate (0061) first.`);

  const before = await counts();
  const report = await db.transaction((tx) => applyHostedRoster(tx));
  const after = await counts();

  console.log(`db:demo-roster → ${target?.name}`);
  for (const line of report.lines) console.log(line);
  console.log(
    `  ${report.created} created · ${report.assigned} assigned · ${report.refused} refused · ${report.skipped} skipped`,
  );

  console.log('  untouched:');
  const moved: string[] = [];
  for (const k of Object.keys(before) as Array<keyof Counts>) {
    console.log(`    ${k.padEnd(15)} ${before[k]} → ${after[k]}`);
    if (before[k] !== after[k]) moved.push(k);
  }
  // Another writer can move these on a live database while this runs, so this
  // is a loud report rather than a rollback — the roster writes above touched
  // none of these tables, and the transaction has already committed.
  if (moved.length > 0) {
    fail(`${moved.join(', ')} changed while this ran. Nothing here writes them; check for concurrent traffic.`);
  }

  if (report.refused > 0) {
    console.log('  Some artists were REFUSED; see the lines above. Everything else is in place.');
  }
}

try {
  await run();
} finally {
  await connection.end();
}
