import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { PlatformAnalyticsSchema, type PlatformAnalyticsWire } from '@avo/types';
import { authedRequest } from '../auth/authedRequest.js';
import { mintAndFollow } from './download.js';

/**
 * `GET /v1/platform/analytics?month=&months=&salon=` — the owner console's
 * Analytics, `requirePlatform('analytics')` (`api/src/routes/platformAnalytics.ts`).
 *
 * ONE READ FOR THE WHOLE PAGE, the merchant Overview's shape (`api/analytics.ts`):
 * eleven blocks come back together, each `{ status: 'ok', … }` or
 * `{ status: 'withheld', reason }`. The server decides what this admin may see —
 * `campaigns` needs `approvals`, `support` needs `policies` — and does not run the
 * query behind a block she may not. So the page has one pending, one error and
 * one success, and every card reads its own block out of the success.
 *
 * PARSED THROUGH `PlatformAnalyticsSchema`, NOT CAST — the schema lane A's own int
 * specs `.parse()` every response through, `.strict()` on every object, so a
 * payload that grew or lost a key fails here as an ordinary failed read rather
 * than as a card drawing `undefined`.
 *
 * EVERY FILTER IS IN THE KEY: pick a salon or a month and read the previous
 * answer out of the cache under a label that says otherwise is the defect
 * `salonKeys.metrics` records. `null` / `null` / `null` is the server's own
 * default (the current platform month, twelve months, every salon) and is sent as
 * no parameter at all, so the default URL is the bare path.
 */

export type PlatformAnalytics = PlatformAnalyticsWire;

export interface PlatformAnalyticsFilters {
  /** `YYYY-MM`, or null for the server's current platform month. */
  month: string | null;
  /** 1–24, or null for the server's default (12). */
  months: number | null;
  /** A salon id, or null for every salon. */
  salon: string | null;
}

export const platformAnalyticsKeys = {
  all: ['platform', 'analytics'] as const,
  one: (f: PlatformAnalyticsFilters) =>
    [...platformAnalyticsKeys.all, f.month ?? 'current', f.months ?? 'default', f.salon ?? 'all'] as const,
};

/** `?month=…&months=…&salon=…`, omitting every null. Empty string for none. */
export function platformAnalyticsQuery(f: PlatformAnalyticsFilters): string {
  const params = new URLSearchParams();
  if (f.month !== null) params.set('month', f.month);
  if (f.months !== null) params.set('months', String(f.months));
  if (f.salon !== null) params.set('salon', f.salon);
  const q = params.toString();
  return q === '' ? '' : `?${q}`;
}

export function parsePlatformAnalytics(raw: unknown): PlatformAnalytics {
  return PlatformAnalyticsSchema.parse(raw);
}

export function usePlatformAnalytics(
  filters: PlatformAnalyticsFilters,
  enabled = true,
): UseQueryResult<PlatformAnalytics> {
  return useQuery({
    enabled,
    queryKey: platformAnalyticsKeys.one(filters),
    queryFn: async ({ signal }) =>
      parsePlatformAnalytics(
        await authedRequest<unknown>(
          'owner',
          `/v1/platform/analytics${platformAnalyticsQuery(filters)}`,
          { signal },
        ),
      ),
    /*
     * `networkMode: 'always'` for `api/analytics.ts`' measured reason: the default
     * PAUSES an offline fetch rather than failing it, and a paused query sits
     * pending for ever — skeletons over an answer the page never showed.
     */
    networkMode: 'always',
  });
}

/* -------------------------------------------------------------- the export -- */

/**
 * THE `?section=` VOCABULARY — lane A's `PLATFORM_ANALYTICS_SECTIONS`
 * (`api/src/services/platformAnalyticsExport.ts`), which is the eleven block keys
 * of the JSON verbatim. Checked against the payload type, so a block renamed in
 * `packages/types` fails to compile here rather than minting a section the server
 * no longer has.
 */
export const PLATFORM_ANALYTICS_SECTIONS = [
  'revenue',
  'money',
  'salons',
  'members',
  'leaderboard',
  'paymentMix',
  'bookings',
  'campaigns',
  'support',
  'shop',
  'busiestTimes',
] as const satisfies ReadonlyArray<keyof PlatformAnalytics>;
export type PlatformAnalyticsSection = (typeof PLATFORM_ANALYTICS_SECTIONS)[number];

export interface PlatformExportScope {
  month: string;
  months: number;
  /** A salon id, or null for every salon. */
  salon: string | null;
}

/**
 * `POST /v1/platform/analytics/download-url` → `{ url, expiresAt }`, then follow
 * it — `api/download.ts § mintAndFollow`, on the OWNER session. The link is the
 * Overview's: `/report-downloads/{token}`, sixty seconds, single use, and the
 * redemption re-reads the admin as she is then. The file is audited server-side
 * on every redemption; nothing here records anything.
 *
 * `salon` and `section` ARE OMITTED, NOT SENT AS NULL, for every salon and every
 * section — "absent means all" is the route's wording. Month and months are
 * always sent: they are the server's echo of what is on screen, so the file
 * covers exactly the months the cards draw even if "the current month" ticks
 * over between the read and the click.
 */
export async function downloadPlatformAnalyticsCsv(
  scope: PlatformExportScope,
  section: PlatformAnalyticsSection | null,
): Promise<void> {
  await mintAndFollow(
    '/v1/platform/analytics/download-url',
    {
      month: scope.month,
      months: scope.months,
      ...(scope.salon !== null ? { salon: scope.salon } : {}),
      ...(section !== null ? { section } : {}),
    },
    'owner',
  );
}
