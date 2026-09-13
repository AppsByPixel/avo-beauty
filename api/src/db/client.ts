/**
 * The application's database handle.
 *
 * Connects as `avo_app` (APP_DATABASE_URL), never as the owner. That is what
 * makes `REVOKE UPDATE, DELETE ON audit_log` a control rather than a comment.
 *
 * int8 comes off the wire as a string (postgres.js will not silently lose
 * precision) and Drizzle's `bigint({ mode: 'number' })` maps it to a JS number,
 * which is what `Fils` is. No custom type parser sits in the money path.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../env';
import { poolOptionsFor } from './poolOptions';
import * as schema from './schema/index';

/**
 * POOLING IS THE ONLY THING THAT VARIES HERE, and it varies by an explicit
 * environment setting whose default is the `{ max: 10 }` this line has always
 * been. `db/poolOptions.ts` is the argument; `DB_POOL_MODE` in `env.ts` is the
 * switch. The role, the URL and the absence of a money-path type parser — the
 * three things this file's header promises — are not configurable.
 */
export const sql = postgres(env.appDatabaseUrl, poolOptionsFor(env.dbPoolMode));

export const db = drizzle(sql, { schema });

export type Db = typeof db;
export { schema };
