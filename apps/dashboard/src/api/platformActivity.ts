import {
  useInfiniteQuery,
  type InfiniteData,
  type UseInfiniteQueryResult,
} from '@tanstack/react-query';
import { authedRequest } from '../auth/authedRequest.js';
import { parseActivityFeed, type ActivityItem, type Paginated } from './salon.js';

/**
 * `GET /v1/platform/activity` — the console's Activity section, `requirePlatform(req,
 * 'activity')` (`api/src/routes/platformConsole.ts:848`).
 *
 * =========================================================================
 * THE SAME FEED VOCABULARY AS THE MERCHANT'S OVERVIEW, DELIBERATELY
 * =========================================================================
 * `ActivityItem` and `parseActivityFeed` are imported from `api/salon.ts` rather
 * than restated, for the reason the SERVER states in
 * `api/src/services/activityFeed.ts`: the two reads share one `FeedItem`
 * interface and one set of describe-functions because "a `kind` chip that means
 * something slightly different on the console than on the dashboard… turns
 * 'these two screens disagree' into a question about the record itself."
 *
 * That file also carries the concrete reason. `describeTransaction` had a defect
 * that was found and fixed once — a top-up's `amount_fils` is what LANDED, bonus
 * included, so rendering the column reads "topped up 30.000 · +5.000 bonus" and
 * tells the reader the customer paid five dinars she did not. The sentence is
 * composed server-side so there is one copy of it; a second parser on this side
 * would be a second chance to get the same thing wrong, in the one place where
 * the reader is AVO and cannot check it against a receipt.
 *
 * `Audit.tsx` reached the same conclusion for the audit log and shares
 * `AUDIT_KINDS`, `KIND_LABEL`, `KIND_TONE` and `whenLabel` across both screens.
 * This is that pattern pointed at the feed.
 *
 * =========================================================================
 * WHAT IS DIFFERENT — AND IT IS NOT "THE SALON FEED WITHOUT THE PREDICATE"
 * =========================================================================
 * The console's feed reads THREE streams where the merchant's reads two. Both
 * read `transaction` and `loyalty_event`; only this one also reads `audit_log`,
 * restricted to kinds `rules` / `access` / `risk`. So the console sees rows the
 * merchant's read cannot produce at all — a permission change, a rule change, a
 * password reset — which is what the design's own banner means by "account
 * actions".
 *
 * `kind: 'money'` audit rows are EXCLUDED server-side, and that is a duplicate
 * removal rather than a privacy dodge: every money audit action has a
 * transaction behind it that this feed already reads, and the transaction is the
 * better of the pair because it names the MEMBER as the actor where the audit row
 * says "System".
 *
 * THIS IS A STRICT SUBSET OF THE AUDIT SECTION AND THE SERVER SAYS SO — an admin
 * holding `activity` and not `audit` can see rules/access/risk rows in feed form.
 * The design intends it. The two reads are not equivalent: `audit` additionally
 * gets the search box, the four kind filters, `?salon=platform`, `total`,
 * `subjectType`/`subjectId`, the `ipAddress`-backed metadata and the money rows.
 *
 * =========================================================================
 * THE CURSOR IS A STRING HERE, NOT A NUMBER
 * =========================================================================
 * `GET /v1/platform/audit` pages on a numeric `seq`. This pages on a COMPOSITE
 * key — `(at, stream, id)` — because a merged stream has no single monotonic
 * column: a charge writes a `transaction`, a `loyalty_event` and an `audit_log`
 * row inside ONE transaction, so all three share `created_at` to the microsecond
 * and only the stream rank and the id separate them.
 *
 * It is carried back opaquely. `services/streamCursor.ts` owns the format, and a
 * client that split it on `|` would be claiming to know a shape that file is free
 * to change. It is also why the instant is rendered by Postgres and not from the
 * wire's own `at`: `timestamptz` stores microseconds and `Date.toISOString()`
 * emits milliseconds, so a cursor rebuilt client-side would truncate and silently
 * END the walk on any group of rows sharing a millisecond — which, per the above,
 * is every charge.
 *
 * NO `?salon=` PARAMETER IS SENT, THOUGH THE ENDPOINT TAKES ONE. The design's
 * Activity section draws a banner and a feed and no filter of any kind, so
 * surfacing one would be inventing product. It is reported as available-and-not-
 * drawn rather than quietly added — see the lane report.
 *
 * NO COURTESY GATE. The read is section-gated server-side, the refusal arrives on
 * its own carrying the server's sentence, and there is no write on this screen.
 */

/** The wire's default is 20 and its ceiling is 100 (`parseFeedLimit`). */
const PAGE_SIZE = 30;

export const platformActivityKeys = {
  feed: () => ['platform', 'activity'] as const,
};

export function usePlatformActivity(): UseInfiniteQueryResult<
  InfiniteData<Paginated<ActivityItem>>
> {
  return useInfiniteQuery({
    queryKey: platformActivityKeys.feed(),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (pageParam !== null) params.set('cursor', pageParam);
      const raw = await authedRequest<unknown>(
        'owner',
        `/v1/platform/activity?${params.toString()}`,
        { signal },
      );
      // PARSED, NOT CAST. `authedRequest<Paginated<ActivityItem>>` would assert a
      // shape the wire never proved and could not fail if it were wrong — the
      // mistake `useRecentActivity` records in api/salon.ts.
      return parseActivityFeed(raw, 'GET /v1/platform/activity');
    },
    getNextPageParam: (last) => last.nextCursor,
  });
}
