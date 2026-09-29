/**
 * SAL-FOREST, ON A DATABASE THAT MUST NOT BE SEEDED.
 *
 *   FOREST_STAFF_PASSWORD='…' FOREST_MEMBER_PASSWORD='…' \
 *   DATABASE_URL='…owner…' pnpm --dir=/abs/path/to/api run db:demo-forest
 *
 * The hosted demo database already holds the fixture world, and `db:seed` cannot
 * be re-run there to add one workspace: under its default `SEED_RESET=1` it
 * DELETES the ledger, every transaction and every booking, with the immutability
 * triggers switched off to do it. Whatever the demo accumulated would go with it.
 *
 * So this script does one thing. It upserts SAL-FOREST — the salon, its branch,
 * two services, the manager `forest` and the member Maha — through the same
 * module `db:seed` uses (db/forestFixture.ts), so the demo's forest and a lane's
 * forest are the same rows. It deletes nothing, disables no trigger, and touches
 * no row outside that workspace except to read the published policy version.
 *
 * THE PASSWORDS COME FROM THE OPERATOR, never from this repository. Both env
 * vars are required and must meet the API's own minimum (`MIN_PASSWORD_LENGTH`,
 * the same `isAcceptablePassword` every sign-up and reset uses); the script
 * refuses before it connects otherwise. Nothing prints either one.
 *
 * RE-RUNNING IS SAFE, AND IT IS HOW A PASSWORD IS ROTATED. The workspace rows
 * are reasserted (colour, card choice, ladder, the manager's permissions and
 * hash). Maha's hash is reset; HER MONEY IS NOT. Her balance, visits and tier
 * are written once, when her row is created, together with the opening ledger
 * entry that explains the balance. After that they belong to whatever the demo
 * did — a charge taken during a walkthrough is real ledger history, and
 * rewriting the balance underneath it would break `member.balance_fils =
 * sum(ledger_entry)`, the reconciliation `db:verify` § 5 asserts.
 *
 * ONE TRANSACTION. A half-created workspace — a member with a balance and no
 * opening entry — is the one outcome worse than not running.
 *
 * NEEDS MIGRATION 0069 (`salon.wallet_card`). Checked first, with a sentence,
 * rather than left to fail as a missing-column error halfway through.
 *
 * IT DOES NOT READ `api/.env`, unlike `db:seed` — the npm script has no
 * `--env-file`. A script aimed at the hosted demo that fell back to a local file
 * when the operator forgot to export the URL would write to whichever database
 * that file names. Here, no `DATABASE_URL` is a refusal.
 *
 * Owner connection (`DATABASE_URL`), like the seed and the migrator: the ledger
 * is insert-only for `avo_app` too, but the salon and staff rows are platform
 * setup, not a request. On Supabase use the SESSION pooler (5432), for the
 * reason DEPLOY-DEMO.md gives for `db:migrate`.
 */

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { fils, formatMoney } from '@avo/types';
import { hashSecret, isAcceptablePassword, MIN_PASSWORD_LENGTH } from '../auth/password';
import {
  FOREST,
  forestMemberValues,
  upsertForestWorkspace,
  writeForestOpeningBalance,
} from './forestFixture';
import { member } from './schema/member';

function fail(message: string): never {
  console.error(`db:demo-forest: ${message}`);
  process.exit(1);
}

function requirePassword(name: 'FOREST_STAFF_PASSWORD' | 'FOREST_MEMBER_PASSWORD'): string {
  const value = process.env[name];
  if (value === undefined || value === '') fail(`${name} is not set. Choose one and export it.`);
  if (!isAcceptablePassword(value)) {
    fail(`${name} is shorter than the API's minimum of ${MIN_PASSWORD_LENGTH} characters.`);
  }
  return value;
}

// Every refusal before any connection is opened.
const staffPassword = requirePassword('FOREST_STAFF_PASSWORD');
const memberPassword = requirePassword('FOREST_MEMBER_PASSWORD');
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) fail('DATABASE_URL is not set. Point it at the owner role of the target database.');

const connection = postgres(databaseUrl, { max: 1 });
const db = drizzle(connection);

async function run(): Promise<void> {
  const [target] = (await db.execute(
    sql`SELECT current_database() AS name`,
  )) as unknown as Array<{ name: string }>;

  const [{ hasColumn } = { hasColumn: 0 }] = (await db.execute(sql`
    SELECT count(*)::int AS "hasColumn" FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'salon' AND column_name = 'wallet_card'`)) as unknown as Array<{
    hasColumn: number;
  }>;
  if (hasColumn === 0) {
    fail(`${target?.name}: salon.wallet_card is missing. Run db:migrate (0069) first.`);
  }

  const [{ version } = { version: null }] = (await db.execute(
    sql`SELECT max(version)::int AS version FROM legal_document_set`,
  )) as unknown as Array<{ version: number | null }>;
  if (version === null) {
    fail(`${target?.name}: no policy set is published, so Maha has no version to stamp.`);
  }

  const [staffHash, memberHash] = await Promise.all([
    hashSecret(staffPassword),
    hashSecret(memberPassword),
  ]);

  const memberOutcome = await db.transaction(async (tx) => {
    await upsertForestWorkspace(tx, { staffHash });

    const existing = await tx
      .select({ id: member.id })
      .from(member)
      .where(sql`${member.id} = ${FOREST.memberId}`)
      .for('update');

    if (existing.length > 0) {
      await tx
        .update(member)
        .set({ passwordHash: memberHash, updatedAt: new Date() })
        .where(sql`${member.id} = ${FOREST.memberId}`);
      return 'updated (password reset; balance, visits and tier left alone)';
    }

    await tx.insert(member).values(forestMemberValues(memberHash, version));
    await writeForestOpeningBalance(tx);
    return `created with ${formatMoney(fils(FOREST.openingFils))} and its opening ledger entry`;
  });

  const [row] = (await db.execute(sql`
    SELECT s.wallet_card, s.brand_color, m.balance_fils::bigint AS balance, m.visits, m.tier::text AS tier
      FROM salon s JOIN member m ON m.salon_id = s.id
     WHERE s.id = ${FOREST.salonId} AND m.id = ${FOREST.memberId}`)) as unknown as Array<{
    wallet_card: string;
    brand_color: string;
    balance: string | number;
    visits: number;
    tier: string;
  }>;

  console.log(`db:demo-forest → ${target?.name}`);
  console.log(`  salon    ${FOREST.salonId} "${FOREST.salonName}"  walletCard ${row?.wallet_card} · brandColor ${row?.brand_color}`);
  console.log(`  branch   ${FOREST.branchId}`);
  console.log(`  services SV-FOR-01, SV-FOR-02`);
  console.log(`  manager  ${FOREST.staffId}  handle "${FOREST.staffHandle}"  (password: FOREST_STAFF_PASSWORD, as exported)`);
  console.log(`  member   ${FOREST.memberId}  ${FOREST.memberPhone}  ${memberOutcome}`);
  console.log(
    `           now ${formatMoney(fils(Number(row?.balance ?? 0)))} · ${row?.tier} · ${row?.visits} visits  (password: FOREST_MEMBER_PASSWORD, as exported)`,
  );
  console.log(`  sign in with salonId "${FOREST.salonId}".`);
}

try {
  await run();
} finally {
  await connection.end();
}
