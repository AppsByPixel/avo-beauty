/**
 * Column primitives shared by every table.
 *
 * The only place in the API where a money column is declared. Non-negotiable #1
 * says money is integer fils and no float ever touches it — `filsColumn` is how
 * that becomes structurally impossible rather than a review habit:
 *
 *   - the SQL type is always `bigint`, never numeric/decimal/real/double/money
 *   - the TypeScript type is `Fils` from `@avo/types`, which is branded, so a
 *     bare `number` will not type-check into or out of one of these columns
 *
 * `mode: 'number'` returns a JS number rather than a JS bigint. Every AVO amount
 * is far inside `Number.MAX_SAFE_INTEGER` (9.007e15 fils is ~9 trillion KD), and
 * `Fils` is a branded `number`, so this is what keeps the column type and the
 * shared money helpers the same type.
 */

import { bigint, timestamp } from 'drizzle-orm/pg-core';
import type { Fils } from '@avo/types';

/** A money column. bigint fils. There is no other way to declare money here. */
export function filsColumn(name: string) {
  return bigint(name, { mode: 'number' }).$type<Fils>();
}

/**
 * Timestamps are always `timestamptz`. Kuwait is UTC+3 with no DST, but the
 * salon-local business-hours and happy-hour predicates need a real instant to
 * resolve against — a naive `timestamp` would quietly make those wrong.
 */
export function timestamptz(name: string) {
  return timestamp(name, { withTimezone: true, mode: 'date' });
}
