/**
 * What closing a branch would do — computed once, for the preview and the close.
 *
 * WHY A PREVIEW EXISTS AT ALL
 * ---------------------------
 * `DELETE /salons/{id}/branches/{bid}` is gated on `perms.loyalty` and returns
 * `staffRescoped`, `staffLeftWithNoBranch` and `depositHeldBookings` — but it
 * computed them INSIDE the transaction that performs the close, so the three facts
 * a merchant needs BEFORE deciding were only available afterwards.
 *
 * Lane C found the consequence: with no preview route, those facts had to be
 * derived client-side from the roster and the appointment list, and those reads need
 * `perms.team` and `perms.appointments`. So a `loyalty`-only account could close a
 * branch it was not allowed to be warned about. Lane C handled it honestly — the
 * warning degraded to categories without counts, "You don't have permission to see
 * the team, so this can't be counted here" — which is true either way and never an
 * invented number, but it is a mitigation and not a fix.
 *
 * The fix is that the warning is computed SERVER-SIDE on the same permission as the
 * act. Whoever may close a branch may be told what closing it does; no second
 * permission stands between a destructive button and its own consequences.
 *
 * ONE IMPLEMENTATION, TWO CALLERS, and that is the point rather than tidiness. A
 * preview whose numbers are computed differently from the close is a preview that
 * can lie at exactly the moment it matters — the same failure as `heldDepositFils`
 * reading `0` on the scan path while the charge path read it for real. The staff
 * predicate below is character-for-character the `WHERE` the close's `UPDATE` uses.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { booking } from '../db/schema/booking';
import { deviceEnrolment } from '../db/schema/deviceEnrolment';
import { staffUser } from '../db/schema/staff';
import type { Executor } from './audit';

export interface BranchClosureImpact {
  /** Staff whose branch list names this branch, and what they would have left. */
  staffRescoped: Array<{ id: string; name: string; remaining: number }>;
  /** The ids of those who would be left with no branch access at all. */
  staffLeftWithNoBranch: string[];
  /** Appointments still holding a customer's deposit at this branch. */
  depositHeldBookings: number;
  /**
   * HOW MANY OF THOSE ARE AN INFERENCE RATHER THAN A RECORD.
   *
   * Lane C's point, and it is about money rather than precision: an artist has no
   * branch column, so the server RESOLVES a booking's branch and records whether it
   * had to assume one (`booking.branch_assumed`, migration 0012). A count in a
   * warning about deposits already taken from customers must not read as a fact
   * when part of it is a guess.
   *
   * Carried as a sibling number rather than folded into the total, so a client can
   * say "3 appointments, 2 of them inferred" and neither number needs a footnote.
   */
  depositHeldBookingsBranchAssumed: number;
  /**
   * TILLS THAT WOULD BE UNENROLLED BY THE CLOSE.  (DECISIONS.md #91)
   *
   * A till enrolled to a branch that then closes is a DEAD COUNTER, not a
   * degraded one: `enrolledBranchId` is read live per request with no
   * `closed_at` check, flows into `resolveBranch` as `supplied`, and that lookup
   * requires `closed_at IS NULL` and otherwise throws. Lane C drove it — enrol,
   * close, charge → `404 unknown_branch` — and `routes/devices.ts` already
   * refuses to ENROL into a closed branch on exactly that reasoning, so the same
   * state was reachable through the other door.
   *
   * The close CASCADES a revoke, so this list is what will be unenrolled rather
   * than what is broken. Reported here because the cascade costs the merchant
   * something real: those tills keep charging, and silently stop earning their
   * branch's boost, which is decision 82's original defect arriving through the
   * back door. Naming them before she confirms is what makes it not silent.
   *
   * LABELS, NOT DEVICE IDS. Same choice `staffRescoped` makes one field up: this
   * is read on a confirmation sheet, and `label` is what the merchant typed.
   */
  tillsUnenrolled: Array<{ deviceId: string; label: string }>;
}

export async function branchClosureImpact(
  exec: Db | Executor,
  salonId: string,
  branchId: string,
): Promise<BranchClosureImpact> {
  /**
   * The SAME predicate the close's `UPDATE ... array_remove` runs on.
   *
   * `branch_access_all` staff are not matched, and cannot be: the
   * `staff_user_branch_access_exclusive` CHECK keeps their id list empty, so
   * `= ANY(…)` never finds them. That is why an emptied list can only mean somebody
   * who was scoped to branches and now has none — the same reasoning the close
   * relies on to identify who it stranded.
   */
  const scoped = await (exec as Db)
    .select({
      id: staffUser.id,
      name: staffUser.name,
      branchAccessIds: staffUser.branchAccessIds,
    })
    .from(staffUser)
    .where(
      and(
        eq(staffUser.salonId, salonId),
        sql`${branchId} = ANY(${staffUser.branchAccessIds})`,
      ),
    )
    .orderBy(staffUser.id);

  const staffRescoped = scoped.map((s) => ({
    id: s.id,
    name: s.name,
    // What is left AFTER this branch is removed. The close reports the same number
    // from its RETURNING, by which time the removal has happened.
    remaining: s.branchAccessIds.filter((b) => b !== branchId).length,
  }));

  const [counts] = await (exec as Db)
    .select({
      total: sql<number>`count(*)::int`,
      assumed: sql<number>`count(*) filter (where ${booking.branchAssumed})::int`,
    })
    .from(booking)
    .where(and(eq(booking.branchId, branchId), eq(booking.status, 'deposit_held')));

  /**
   * LIVE ENROLMENTS ONLY — `revoked_at IS NULL`. A previously revoked row
   * pointing at this branch is history and would be a phantom warning.
   */
  const tills = await (exec as Db)
    .select({ deviceId: deviceEnrolment.deviceId, label: deviceEnrolment.label })
    .from(deviceEnrolment)
    .where(
      and(
        eq(deviceEnrolment.salonId, salonId),
        eq(deviceEnrolment.branchId, branchId),
        isNull(deviceEnrolment.revokedAt),
      ),
    )
    .orderBy(deviceEnrolment.deviceId);

  return {
    staffRescoped,
    tillsUnenrolled: tills,
    staffLeftWithNoBranch: staffRescoped.filter((s) => s.remaining === 0).map((s) => s.id),
    depositHeldBookings: counts?.total ?? 0,
    depositHeldBookingsBranchAssumed: counts?.assumed ?? 0,
  };
}
