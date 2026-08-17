/**
 * Which branch did this money move at?
 *
 * THE BUG THIS FILE EXISTS FOR
 * ----------------------------
 * `transaction.branch_id` is NOT NULL, because `TransactionSchema.branchId` is
 * and both clients render it unconditionally. So every money path needed a
 * value, and both of them — `services/charge.ts` and `services/topup.ts` —
 * grew the same private helper:
 *
 *     SELECT id FROM branch WHERE salon_id = $1 ORDER BY id LIMIT 1
 *
 * That is a defensible way to ATTRIBUTE a row for reporting and an indefensible
 * way to decide what a customer EARNS. The first live charge on a two-branch
 * salon doubled a customer's visits, because the salon's branches are `BR-KWC`
 * and `BR-SAL`, `BR-KWC` sorts first, and Kuwait City carried a 2x visit boost.
 * Nobody chose that. Alphabetical order chose it, and it was invisible.
 *
 * WHAT THIS CHANGES, AND WHAT IT DELIBERATELY DOES NOT
 * ----------------------------------------------------
 * It does not invent a better guess — there is no primary-branch concept on
 * `branch` to reach for, and adding one would be picking a different arbitrary
 * winner. It makes the guess VISIBLE, and separates the two questions the old
 * helper had collapsed into one:
 *
 *   - what do we attribute the row to?   Always answerable. A value is required.
 *   - do we know where this happened?    Often not. `established` says so.
 *
 * A caller uses `branchId` for attribution and `established` for anything that
 * moves money or loyalty. `services/promotions.ts § PromotionInputs` takes a
 * nullable branch for exactly this reason: NULL is "not known", not "no branch",
 * and an unknown branch matches no boost and no branch-scoped happy hour.
 *
 * ONE BRANCH IS NOT A GUESS. When a salon has exactly one branch there is no
 * sort order to be at the mercy of and nowhere else the charge could have
 * happened, so it is `established` and its boost applies. That is strictly more
 * correct than what came before, which treated every salon's branch as unknown
 * and so never paid a single-branch salon's boost either.
 *
 * WHY NOT REFUSE THE CHARGE INSTEAD
 * ---------------------------------
 * Failing when the branch is ambiguous was the other option, and it is the wrong
 * trade today: it would refuse every charge at every multi-branch salon until
 * device enrolment ships, taking a working product offline to fix an attribution
 * defect whose money impact is already nil. The money is safe either way — no
 * boost is applied from a guess. What was wrong was that the guess was presented
 * as fact, and `transaction.branch_assumed` is that fixed: the row now says of
 * itself whether its branch was known, so "which of these figures can I trust
 * per branch" is a query rather than an assumption.
 *
 * THE REAL FIX, still owed: a branch-bound scanner session. `StaffPrincipal`
 * carries branch ACCESS (`branchAccessAll` / `branchAccessIds`), which is a
 * permission and not a location, so the server cannot infer where a staff member
 * is standing. That waits on the device-enrolment decision.
 *
 * THE FIX THAT MUST NOT BE TAKEN is letting the client name its branch. A client
 * choosing its branch is a client choosing its own multiplier — non-negotiable
 * #2 with extra steps. `supplied` below exists for a branch the SERVER
 * established from an enrolled device, and is checked against the salon even
 * then; no route reads a branch from a request body, and none may start.
 */

import { sql } from 'drizzle-orm';
import { notFound } from '../http/errors';
import type { Executor } from './audit';

export interface ResolvedBranch {
  /** Always present — `transaction.branch_id` is NOT NULL. */
  branchId: string;
  /**
   * True when this is where the money actually moved, false when it is an
   * attribution chosen so the column had a value.
   *
   * Gate every earning decision on this. Attribute freely; pay nothing on a
   * false.
   */
  established: boolean;
}

/**
 * Resolve the branch for a money row, inside the caller's transaction.
 *
 * @param supplied A branch the SERVER established — an enrolled, branch-bound
 *                 device session. Never a request body field. Verified against
 *                 the salon regardless, because an id that crosses a tenant
 *                 boundary is a tenancy bug whatever established it.
 */
export async function resolveBranch(
  exec: Executor,
  salonId: string,
  supplied?: string | null,
): Promise<ResolvedBranch> {
  if (supplied) {
    const owned = await exec.execute(
      sql`SELECT id FROM branch WHERE id = ${supplied} AND salon_id = ${salonId} LIMIT 1`,
    );
    const row = (owned as unknown as Array<{ id: string }>)[0];
    if (!row) {
      // Not "forbidden" — a 403 would confirm the id names a real branch
      // somewhere else, which is the tenancy leak in miniature.
      throw notFound('unknown_branch', 'No such branch.');
    }
    return { branchId: row.id, established: true };
  }

  // LIMIT 2, not 1: the second row is the entire question. One round trip
  // answers both "which branch do we attribute to" and "is there more than one
  // candidate", and those cannot disagree the way two separate reads could.
  const rows = (await exec.execute(
    sql`SELECT id FROM branch WHERE salon_id = ${salonId} ORDER BY id LIMIT 2`,
  )) as unknown as Array<{ id: string }>;

  const first = rows[0];
  if (!first) throw notFound('no_branch', 'That salon has no branch.');

  // Exactly one branch: unambiguous, so it is established and its boost applies.
  // More than one: `first` is alphabetical order talking, and it is marked as
  // such rather than passed off as knowledge.
  return { branchId: first.id, established: rows.length === 1 };
}
