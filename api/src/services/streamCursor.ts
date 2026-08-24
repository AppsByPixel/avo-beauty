/**
 * Keyset pagination over one or more tables that have no shared sequence.
 *
 * `services/auditRead.ts` gets a cursor for free: `audit_log.seq` is a bigserial, so
 * `seq < cursor` is a total order with no ties to break, and its own comment
 * explains why that matters. Three reads in this API cannot have that:
 *
 *     GET /v1/support/tickets       one table, no serial
 *     GET /v1/platform/activity     transaction + loyalty_event + audit_log
 *     GET /v1/platform/accounts     member + staff_user
 *
 * They had two copies of this logic between them before the third arrived, which is
 * the two-doors defect `routes/salons.ts` records against the tier ladder — and the
 * copy that drifts is the one nobody is reading. It is worse than usual here,
 * because a cursor that drifts does not throw: it silently skips rows, and the
 * reader sees a shorter list rather than an error.
 *
 * ================= THE KEY: `(at, stream, id)` =================
 *
 * `at DESC`, then `stream ASC`, then `id ASC`. Newest first, which is what every
 * one of these screens draws, with two tiebreaks that between them make the order
 * TOTAL — the property `parseAuditCursor` names as the whole point of using `seq`.
 *
 * THE STREAM RANK IS LOAD-BEARING, NOT TIDINESS. A charge writes a `transaction`, a
 * `loyalty_event` and an `audit_log` row inside ONE database transaction, and
 * `now()` is the transaction timestamp — so all three carry the SAME `created_at`
 * to the microsecond, every time. Without a stable rank between them a page
 * boundary can fall inside that group and either repeat a line or lose one.
 *
 * THE ID BREAKS THE LAST TIE, within one stream at one instant. Arbitrary but
 * stable is all a cursor needs.
 *
 * ================= WHY POSTGRES RENDERS THE INSTANT =================
 *
 * `timestamptz` stores MICROSECONDS. `Date.prototype.toISOString()` emits
 * MILLISECONDS. So a cursor built from the `at` field a handler already serialises
 * onto the wire truncates — and this is not a rounding nicety, it ENDS THE WALK.
 * It was found by driving `GET /v1/support/tickets`:
 *
 *   four tickets shared `16:00:00.123456`. The first was delivered and the cursor
 *   became `…16:00:00.123Z`. The next page asked for `created_at < .123`, which
 *   `.123456` does not satisfy — and neither does it satisfy `= .123` — so the page
 *   came back EMPTY, `hasMore` went false, `nextCursor` went null, and three rows
 *   were simply gone. A ten-row queue paged eight rows while reporting `total: 10`.
 *
 * `to_char(… 'US')` is six fractional digits and round-trips through `::timestamptz`
 * exactly. The COMPARISON is still against the raw column, so the `created_at DESC`
 * indexes stay usable — which `date_trunc('milliseconds', created_at)` would have
 * cost, on top of multiplying the ties it was meant to resolve.
 *
 * The instant is carried as TEXT end to end and never parsed into a `Date`, because
 * a `Date` is the truncation itself and going through one would reintroduce the bug
 * with an exact cursor arriving.
 */

import { and, or, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { badRequest } from '../http/errors';

/**
 * A single character that cannot occur in any part: an instant is digits, `-`, `:`,
 * `.`, `T` and `Z`; a rank is one digit; and no id in this schema contains it
 * (`SUP-48263`, `TX-9021`, a uuid). Nothing needs encoding, so a cursor stays
 * readable in a log.
 */
export const CURSOR_SEP = '|';

/** Exactly what `cursorInstant` emits, and the only thing the cast is ever handed. */
const INSTANT_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export interface StreamCursor {
  /** Microsecond-exact, as text. Never a `Date` — see the header. */
  at: string;
  rank: number;
  id: string;
}

/** Select this beside the row to get a key the cursor can carry back exactly. */
export function cursorInstant(column: PgColumn) {
  return sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/**
 * Build the string a client echoes. One value, whatever the stream count — the cost
 * `routes/activity.ts` declined to pay for five lines on an Overview, kept to its
 * minimum for the screens that do pay it.
 */
export function encodeCursor(key: { at: string; rank: number; id: string }): string {
  return `${key.at}${CURSOR_SEP}${key.rank}${CURSOR_SEP}${key.id}`;
}

/**
 * Parse one, or refuse it by name. `ranks` is the caller's own rank set, so a cursor
 * minted by a two-stream endpoint cannot address a third stream on another.
 */
export function parseCursor(value: unknown, ranks: readonly number[]): StreamCursor | null {
  if (value === undefined) return null;
  const raw = String(value).trim();
  if (raw === '') return null;

  const first = raw.indexOf(CURSOR_SEP);
  const second = first === -1 ? -1 : raw.indexOf(CURSOR_SEP, first + 1);
  const at = first === -1 ? '' : raw.slice(0, first);
  const rank = second === -1 ? Number.NaN : Number(raw.slice(first + 1, second));
  const id = second === -1 ? '' : raw.slice(second + 1);

  if (!INSTANT_SHAPE.test(at) || !ranks.includes(rank) || id === '') {
    throw badRequest('invalid_cursor', 'cursor must be the value returned as nextCursor.');
  }
  return { at, rank, id };
}

/**
 * "Strictly after the cursor row", for a source whose rank is FIXED — so the rank
 * comparison collapses to a constant here rather than becoming SQL:
 *
 *   rank <  cursor's   ->  at < cursorAt
 *   rank == cursor's   ->  at < cursorAt OR (at = cursorAt AND id > cursorId)
 *   rank >  cursor's   ->  at <= cursorAt
 *
 * `::text` on the id because `audit_log.id` and `loyalty_event.id` are `uuid` while
 * the others are `text`; one comparison for all of them, and it is only ever
 * reached on rows already pinned to a single microsecond by the equality beside it.
 *
 * Returns `undefined` for a first page, which is what Drizzle reads as "no
 * condition" — stated because a `WHERE` that vanishes is usually a bug.
 */
export function afterCursor(
  cursor: StreamCursor | null,
  rank: number,
  atColumn: PgColumn,
  idColumn: PgColumn,
): SQL | undefined {
  if (cursor === null) return undefined;
  const stamp = sql`${cursor.at}::timestamptz`;
  if (rank < cursor.rank) return sql`${atColumn} < ${stamp}`;
  if (rank > cursor.rank) return sql`${atColumn} <= ${stamp}`;
  return or(
    sql`${atColumn} < ${stamp}`,
    and(sql`${atColumn} = ${stamp}`, sql`${idColumn}::text > ${cursor.id}`),
  )!;
}

/**
 * Merge what the sources returned into the one order above.
 *
 * THE MERGE IS BOUNDED, which is what makes reading n sources sound: taking
 * `limit + 1` from each is enough, because a row NOT fetched from a source is older
 * than every row that was, so it cannot reach the first `limit` of the merge.
 * Reading n×(limit+1) rows to serve `limit` is a fixed cost, not one that grows
 * with the platform — `routes/activity.ts`'s argument, widened.
 *
 * `keyed.length > limit` is therefore exactly "there is another row": if it is not
 * greater, every source returned fewer than `limit + 1` rows and so was exhausted.
 */
export interface Keyed<T> {
  item: T;
  rank: number;
  /** From `cursorInstant`, not from a `Date`. */
  at: string;
  id: string;
}

export function mergePage<T>(
  keyed: Keyed<T>[],
  limit: number,
): { items: T[]; nextCursor: string | null } {
  keyed.sort(
    (a, b) =>
      (a.at < b.at ? 1 : a.at > b.at ? -1 : 0) ||
      a.rank - b.rank ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  const page = keyed.slice(0, limit);
  const hasMore = keyed.length > limit;
  const last = page[page.length - 1];

  return {
    items: page.map((k) => k.item),
    nextCursor: hasMore && last ? encodeCursor(last) : null,
  };
}
