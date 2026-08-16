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
import * as schema from './schema/index';

export const sql = postgres(env.appDatabaseUrl, { max: 10 });

export const db = drizzle(sql, { schema });

export type Db = typeof db;
export { schema };
