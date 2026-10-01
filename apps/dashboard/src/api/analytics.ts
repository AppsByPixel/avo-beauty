import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { OverviewAnalyticsSchema, type OverviewAnalytics } from '@avo/types';
import { authedRequest } from '../auth/authedRequest.js';
import { useSalonId } from '../auth/AuthProvider.js';
import { mintAndFollow } from './download.js';

/**
 * `GET /v1/salons/{id}/overview/analytics?branch=&period=` — `perms.dashboard`.
 *
 * ONE READ FOR THE WHOLE ANALYTICS GRID. Twelve blocks come back together, and
 * each is either `{ status: 'ok', … }` or `{ status: 'withheld', reason }` — the
 * server decides what this staff member may see, block by block, and does not
 * run the query behind a block she may not (`services/overviewAnalytics.ts §
 * FIVE BLOCKS THAT NEED MORE THAN THAT`). So the grid has one pending, one error
 * and one success, and every card reads its own block out of the success.
 *
 * PARSED THROUGH `OverviewAnalyticsSchema`, NOT CAST. It is the schema lane A's
 * own int specs `.parse()` every response through, `.strict()` on every object,
 * so the serialiser, the contract and this client cannot drift apart silently:
 * a payload that grew a key or lost one fails here, loudly, as an ordinary failed
 * read ("Couldn't load this") rather than as a card drawing `undefined`.
 *
 * THE BRANCH IS IN THE KEY, `salonKeys.metrics`' reason: pick Salmiya, get the
 * salon-wide blocks out of the cache, and read them under a selector that says
 * Salmiya. The PERIOD is in it too, although today only one is ever sent.
 *
 * `'all'` OMITS `?branch=`, byte-for-byte the metrics convention
 * (`api/salon.ts § branchQuery`).
 */
export const ANALYTICS_PERIOD = '30d';

export const analyticsKeys = {
  all: ['overview-analytics'] as const,
  one: (salonId: string, branch: string, period: string) =>
    [...analyticsKeys.all, salonId, branch, period] as const,
};

/**
 * The query suffix, `?branch=…&period=…`. A SUFFIX GLUED TO THE PATH LITERAL at
 * the call site rather than a whole path built here, so
 * `merchantScopeGates.test.ts` can still read the route this hook requests.
 */
export function analyticsQuery(branch: string, period: string): string {
  const params = new URLSearchParams();
  if (branch !== 'all') params.set('branch', branch);
  params.set('period', period);
  return `?${params.toString()}`;
}

export function parseOverviewAnalytics(raw: unknown): OverviewAnalytics {
  return OverviewAnalyticsSchema.parse(raw);
}

export function useOverviewAnalytics(
  branch: string,
  period: string = ANALYTICS_PERIOD,
): UseQueryResult<OverviewAnalytics> {
  const salonId = useSalonId();
  return useQuery({
    queryKey: analyticsKeys.one(salonId, branch, period),
    queryFn: async ({ signal }) =>
      parseOverviewAnalytics(
        await authedRequest<unknown>(
          'merchant',
          `/v1/salons/${salonId}/overview/analytics${analyticsQuery(branch, period)}`,
          { signal },
        ),
      ),
    /*
     * `networkMode: 'always'` for `api/bookings.ts`' measured reason: the default
     * PAUSES an offline fetch rather than failing it, and a paused query sits
     * pending for ever — which this grid would paint as skeletons over an answer
     * it never showed. No `retry` here: `api/retryPolicy.ts` is the only one.
     */
    networkMode: 'always',
  });
}

export type { OverviewAnalytics };

/* -------------------------------------------------------------- the export -- */

/**
 * THE `?section=` VOCABULARY — lane A's `OVERVIEW_SECTIONS`
 * (`api/src/services/overviewExport.ts`), in two halves.
 *
 * THE TWELVE BLOCK KEYS are checked against the payload type, so a block renamed
 * in `packages/types` fails to compile here rather than minting a section the
 * server no longer has.
 *
 * THE THREE PANELS THAT ARE NOT BLOCKS — the KPI row, Gross by day and Revenue
 * by branch — each read an endpoint of their own, so they have no key on the
 * analytics payload to check against. Trunk, 2026-10-02: lane A's next slice
 * adds `kpis`, `salesTrend` and `revenueByBranch` to the export. Until those
 * keys are on `dev` a mint for one answers `400 invalid_section`, and the
 * control prints that sentence verbatim like any other refusal.
 */
export const ANALYTICS_BLOCK_SECTIONS = [
  'topServices',
  'artists',
  'busiestTimes',
  'upcoming',
  'noShows',
  'newMembers',
  'visitors',
  'loyalty',
  'wallet',
  'paymentMix',
  'shop',
  'campaigns',
] as const satisfies ReadonlyArray<keyof OverviewAnalytics>;
export type AnalyticsBlockKey = (typeof ANALYTICS_BLOCK_SECTIONS)[number];

export const OVERVIEW_PANEL_SECTIONS = ['kpis', 'salesTrend', 'revenueByBranch'] as const;
export type OverviewPanelKey = (typeof OVERVIEW_PANEL_SECTIONS)[number];

export const ANALYTICS_SECTIONS = [...OVERVIEW_PANEL_SECTIONS, ...ANALYTICS_BLOCK_SECTIONS] as const;
export type AnalyticsSectionKey = AnalyticsBlockKey | OverviewPanelKey;

export interface AnalyticsExportRequest {
  /** A branch id, or 'all' — the server's `resolveBranchFilter` reads both. */
  branch: string;
  /** The window token the grid is showing, e.g. `30d`. */
  period: string;
  /** One section, or absent for every section this staff member may see. */
  section?: AnalyticsSectionKey;
}

/**
 * `POST /v1/salons/{id}/overview/analytics/download-url` → `{ url, expiresAt }`,
 * then follow it — the Reports mint's shape (`api/download.ts § mintAndFollow`).
 * The url is `/report-downloads/{token}`: lane A's mint writes the same
 * `report_download` row Reports' does, and the one redemption route dispatches
 * on its kind. Single-use, sixty seconds.
 *
 * `perms.dashboard` on the mint, the Overview's own gate; the per-block gates
 * are the SERVER'S, applied inside the file (a withheld block is a row naming
 * the reason). Nothing here filters sections by what this client believes she
 * may see.
 *
 * `section` IS OMITTED, NOT SENT AS NULL, for the whole file — "absent means
 * all" is the contract's wording.
 */
export async function downloadAnalyticsCsv(
  salonId: string,
  request: AnalyticsExportRequest,
): Promise<void> {
  await mintAndFollow(`/v1/salons/${salonId}/overview/analytics/download-url`, {
    branch: request.branch,
    period: request.period,
    ...(request.section ? { section: request.section } : {}),
  });
}
