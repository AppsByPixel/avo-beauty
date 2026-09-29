import type { Campaign } from '@avo/types';
import { localDate } from '../salesTrendRules.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * APPROVALS' "THIS MONTH" — COUNTED FROM THE ONLY READ THERE IS, AND SAYING SO
 * ═══════════════════════════════════════════════════════════════════════════
 * The card was headed "This month" and counted the whole unfiltered read:
 * `GET /v1/platform/campaigns`, which is `LIMIT 200` newest-first with no date
 * parameter, no cursor and no count (`api/src/routes/campaigns.ts`). So it was
 * neither this month (a campaign from May counted) nor complete (the 201st did
 * not).
 *
 * THERE IS NO PROPER READ FOR IT. The endpoint takes `?status=` and nothing
 * else — no `from`/`to`, no aggregate. A monthly count is owed by lane A
 * (`?from=&to=`, or a counts endpoint) and is in the lane report.
 *
 * WHAT CAN BE MADE TRUE WITHOUT ONE. The read is newest-first, so every campaign
 * submitted this month sorts ahead of every older one. Filtering the 200 to this
 * month is therefore EXACT whenever the 200 reach back past the month's start —
 * and when they do not (200 or more this month), the count is a floor, and the
 * card says so rather than printing a number that looks whole.
 *
 * THE MONTH IS THE VIEWER'S. The console spans salons in many zones, and the
 * reader's clock is the one frame they share — `salonTime.ts § viewerZone`, the
 * rule the console's audit log already follows.
 */

/** `LIMIT 200` in `GET /v1/platform/campaigns`. */
export const PLATFORM_CAMPAIGNS_CAP = 200;

export interface MonthCohort {
  items: Campaign[];
  /** True when the read may have stopped inside the month — the counts are floors. */
  truncated: boolean;
}

export function thisMonthCohort(newestFirst: Campaign[], now: Date, zone: string): MonthCohort {
  const month = localDate(now, zone)?.slice(0, 7) ?? null;
  if (month === null) return { items: [], truncated: newestFirst.length > 0 };
  const inMonth = (c: Campaign) => localDate(new Date(c.submittedAt), zone)?.slice(0, 7) === month;
  const items = newestFirst.filter(inMonth);
  const oldest = newestFirst[newestFirst.length - 1];
  const truncated =
    newestFirst.length >= PLATFORM_CAMPAIGNS_CAP && oldest !== undefined && inMonth(oldest);
  return { items, truncated };
}
