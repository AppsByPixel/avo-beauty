/**
 * A branch's hours, resolved — migration 0063. One function, because two
 * surfaces serve them (`salon.branches` and an order's `pickupBranch`) and a
 * pickup sheet that disagreed with the salon screen about when the same counter
 * opens would be two answers to one question.
 *
 *   branch.business_hours set   → those, `businessHoursSource: 'branch'`
 *   branch.business_hours NULL  → the salon's, `businessHoursSource: 'salon'`
 *
 * THE HOURS ARE NAIVE WALL CLOCK, like every hours field in this schema. They
 * mean nothing without `salon.timezone`, which is why every surface that serves
 * these serves the zone beside them (`GET /salons/{id}` at the top level, a
 * pickup branch inline). "Open now" is decided by the CLIENT for display, in the
 * SALON's zone and never the device's — this machine runs PKT, two hours ahead
 * of Kuwait, and `services/metrics.ts` records a charge that landed on the wrong
 * day for exactly that reason. The server decides nothing from it: pickup is not
 * refused out of hours, so this is copy, not a control.
 *
 * ONE DAY, REPEATED. `BusinessHours` has no weekday dimension, so a branch
 * closed on Fridays cannot say so. Reported; not built here.
 */

import type { BusinessHours } from '../db/schema/salon';

export type BusinessHoursSource = 'branch' | 'salon';

export interface ResolvedHours {
  businessHours: BusinessHours;
  businessHoursSource: BusinessHoursSource;
}

export function resolveBranchHours(
  branchHours: BusinessHours | null,
  salonHours: BusinessHours,
): ResolvedHours {
  return branchHours
    ? { businessHours: branchHours, businessHoursSource: 'branch' }
    : { businessHours: salonHours, businessHoursSource: 'salon' };
}
