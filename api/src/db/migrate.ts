/**
 * Run migrations. `pnpm --dir=/abs/path/to/api run db:migrate` — absolute, and never
 * `pnpm --filter`, which resolves from cwd and can run another worktree's package
 * against the URL this one exported. See db/seed.ts and LANES.md.
 *
 * Uses DATABASE_URL — the owner role — because migrations run DDL and grant
 * privileges to the application role. The application itself never uses this
 * connection; see client.ts.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { env } from '../env';

const connection = postgres(env.databaseUrl, { max: 1 });

try {
  await migrate(drizzle(connection), { migrationsFolder: new URL('../../drizzle', import.meta.url).pathname });
  console.log('migrations applied');
} finally {
  await connection.end();
}
