/**
 * `?branch=` — the READ-SIDE branch filter, shared by Reports and Overview.
 *
 * TWO FUNCTIONS NAMED `resolveBranch` WOULD HAVE BEEN A TRAP, so this one is not
 * called that. `services/branch.ts` already exports `resolveBranch`, and it
 * answers a different question on the WRITE side: "where did this money move,
 * and do we actually know?" It returns a branch for a NOT NULL column plus an
 * `established` flag, and it will happily hand back a guess.
 *
 * This one answers a question about a QUERY: "the caller asked to see one
 * branch — which, and is she allowed to?" It returns `null` for "every branch"
 * and throws rather than guessing. Same noun, opposite disposition: the write
 * side must always produce a value, the read side must never invent one.
 *
 * EXTRACTED FROM routes/reports.ts, where it was a private helper, because
 * `GET /salons/{id}/metrics` now takes the same parameter and a second copy is a
 * second place for the tenancy scope below to be dropped. The two surfaces have
 * to agree about what `?branch=` means down to the status code: the Overview
 * tiles and the Reports card sit behind the same branch selector in the
 * dashboard shell, so a branch that 404s on one and empties on the other would
 * read to the merchant as "that branch had no sales".
 *
 * A BRANCH ID, NOT THE NAME THE SEGMENT RENDERS. `branch_salon_name_uq` is
 * unique per SALON, so two salons may each have a "Salmiya" and a name would
 * have to be resolved against the caller's salon anyway.
 * `GET /salons/{id}/branches` already hands the dashboard the ids. `all` is
 * accepted as an explicit spelling of "every branch" because routes/campaigns.ts
 * established that sentinel on the wire.
 *
 * AN UNKNOWN OR FOREIGN BRANCH IS A 404, NOT AN EMPTY RESULT. Filtering on
 * another salon's branch id would return zero rows, and zero rows reads as "no
 * sales at that branch" — a confident false answer about a branch that is not
 * hers. The lookup is scoped to the caller's salon in ONE query, so a branch that
 * does not exist and a branch belonging to somebody else are indistinguishable
 * from the outside, which is the property that stops this being a
 * branch-enumeration oracle. It is `and(eq(branch.id, raw), eq(branch.salonId,
 * salonId))` and not a lookup followed by a comparison, because the second shape
 * has a window in it where the row is in hand and the check has not happened yet.
 *
 * A CLOSED BRANCH STILL RESOLVES. `closed_at IS NULL` belongs on the write side —
 * `services/branch.ts` uses it to stop a closed branch collecting new money — and
 * would be wrong here: last quarter's takings at a branch that shut in March are
 * exactly what a merchant opens a report to see. Reporting on a closed branch is
 * the point, not an oversight.
 */

import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { branch } from '../db/schema/salon';
import { badRequest, notFound } from '../http/errors';

/** What `?branch=` resolved to. `null` is "every branch" — the default. */
export interface BranchFilter {
  id: string;
  name: string;
}

/**
 * @param raw The query-string value, unvalidated. `undefined`, `null`, `''` and
 *            the literal `'all'` all mean every branch.
 * @throws 400 `invalid_branch` when it is present but not a string — a repeated
 *         `?branch=a&branch=b` arrives as an array, and an array silently
 *         stringified to `"a,b"` would 404 with a message about a branch nobody
 *         named.
 * @throws 404 `unknown_branch` when no branch with that id belongs to this salon.
 */
export async function resolveBranchFilter(
  db: Db,
  salonId: string,
  raw: unknown,
): Promise<BranchFilter | null> {
  if (raw === undefined || raw === null || raw === '' || raw === 'all') return null;
  if (typeof raw !== 'string') throw badRequest('invalid_branch', 'branch must be a branch id.');

  const rows = await db
    .select({ id: branch.id, name: branch.name })
    .from(branch)
    .where(and(eq(branch.id, raw), eq(branch.salonId, salonId)))
    .limit(1);
  const found = rows[0];
  if (!found) throw notFound('unknown_branch', 'No such branch.');
  return found;
}
