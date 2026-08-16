import { defineConfig } from 'drizzle-kit';

/**
 * Migrations are generated as SQL and committed. `drizzle-kit push` is never
 * used against anything but a scratch database: the CHECK constraints and the
 * REVOKEs in this schema are the product's money guarantees, and they have to
 * arrive through a reviewed file, not a diff a tool decided on at deploy time.
 */
export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://avo:avo_dev_password@localhost:5433/avo',
  },
  strict: true,
  verbose: true,
});
