import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useSalonId } from '../auth/AuthProvider.js';
import { authedRequest } from '../auth/authedRequest.js';
import { NAV_ITEMS } from '../shell/navItems.js';

/**
 * THE MERCHANT BELL — the client half of `api/src/routes/merchantNotifications.ts`.
 *
 *   GET  /v1/salons/{id}/notifications        the feed, the badge, and the filter
 *   POST /v1/salons/{id}/notifications/read   `{ ids }` or `{ all: true }`
 *
 * THE `/v1` IS PART OF THE PATH AND IS NOT A BASE-URL PREFIX. `API_BASE_URL` is
 * a bare origin, and `api/src/app.ts` registers every route file at the root —
 * so the API serves `/salons/:id` and `/v1/salons/:id/social/:linkId` side by
 * side, seventy routes on one convention and thirty on the other. These two are
 * registered `/v1/…` literally, so the client must send `/v1/…` literally.
 * Written from `routes/merchantNotifications.ts` rather than from the endpoint
 * table in the brief, and `merchantScopeGates.test.ts` is what catches a client
 * path that resolves to no registered route — it caught this one.
 *
 * `merchant_notification` has been written to since phase 6 — `availability.ts`
 * raises and resolves `calendar_disconnected`, `noShowWorker.ts` raises
 * `booking_no_show`, `campaign.ts` raises `campaign_held` — and until lane A
 * built those two routes nothing in the product could read a row. This module
 * and `shell/NotificationBell.tsx` are the surface.
 *
 * ===========================================================================
 * THE SHAPES ARE DECLARED HERE AND NOT IN `packages/types`, DELIBERATELY.
 * ===========================================================================
 * `packages/types` is trunk-owned (CLAUDE.md), and the bell's wire shape is
 * `NotificationView` in `api/src/services/merchantNotifications.ts` — which is
 * not in the shared package either. `api/artists.ts § DashboardArtist` set the
 * precedent for the same situation: widen or declare locally, say so, and report
 * it rather than reaching across the column boundary. The fields below are a
 * transcription of that interface and nothing more; `metadata`, `subjectType`
 * and `subjectId` are deliberately NOT on the wire and so are not here.
 */

export type NotificationKind = 'calendar_disconnected' | 'booking_no_show' | 'campaign_held';

export type NotificationSeverity = 'info' | 'warning';

export interface MerchantNotification {
  id: string;
  kind: NotificationKind;
  /** Drives the dot. Nothing else in the row reads it. */
  severity: NotificationSeverity;
  title: string;
  body: string;
  /**
   * Site-relative, or `null`. The API validates it on the way OUT — an absolute
   * URL, a protocol-relative `//host`, a backslash or a control character all
   * serialise as `null` rather than throwing, because "a bell that 500s over one
   * bad link is worse than a bell with one dead row in it". A null link is an
   * unclickable row, not a broken one. See `linkTarget` below for the SECOND
   * reason a row can be unclickable, which is this dashboard's fault and not the
   * API's.
   */
  deepLink: string | null;
  createdAt: string;
  /** Salon-wide, not per-staff: the bell is a shared worklist. */
  readAt: string | null;
  /** The condition cleared on its own. A resolved row STAYS in the feed. */
  resolvedAt: string | null;
}

export interface NotificationFeed {
  items: MerchantNotification[];
  /** A real cursor. See `NotificationBell.tsx § THE PAGE, SAID OUT LOUD`. */
  nextCursor: string | null;
  /**
   * Unread AND unresolved, over the whole visible set — NOT the length of
   * `items` and not page-dependent. A resolved row stops shouting without
   * disappearing, so it is in `items` and not in this number.
   */
  unreadCount: number;
  /**
   * THE FILTER, DECLARED ON THE WIRE. The feed is narrowed to the kinds this
   * reader's permissions cover, so an empty `items` is two different sentences
   * depending on what is in here, and `feedScope` below is the only thing that
   * can tell them apart. Without it the design's "You're all caught up." is
   * indistinguishable from "the things waiting are things you may not see".
   */
  visibleKinds: NotificationKind[];
}

export interface MarkReadResult {
  marked: number;
  unreadCount: number;
}

/** Exactly one selection. The API 400s on `{}` and on both together. */
export type MarkReadSelection = { ids: string[] } | { all: true };

/* ========================================================================== */
/*                          what the reader may see                           */
/* ========================================================================== */

/**
 * The kinds this client knows how to draw, and the word it uses for each.
 *
 * NOT A COPY OF `KIND_PERMISSION`. The server's map from a kind to the
 * permission that gates it is the server's, is enforced there, and is never
 * restated on this surface — what arrives is `visibleKinds`, already resolved.
 * These are display labels and nothing else.
 */
export const KIND_LABEL: Record<NotificationKind, string> = {
  calendar_disconnected: 'calendar',
  booking_no_show: 'no-show',
  campaign_held: 'campaign',
};

const KNOWN_KINDS = Object.keys(KIND_LABEL) as NotificationKind[];

/**
 * IS THE FEED NARROWED, AND BY HOW MUCH.
 *
 * Three answers, because the empty panel says a different sentence for each and
 * getting that wrong is the silent failure `visibleKinds` exists to prevent:
 *
 *   'full'     every kind this client knows about is visible. An empty feed is
 *              genuinely quiet, and "You're all caught up." is true.
 *   'narrowed' some but not all. An empty feed is the NARROWER claim "nothing is
 *              waiting *for you*", and the panel names which kinds it covers.
 *   'none'     the reader holds none of the three permissions. The API answers
 *              200 with an empty feed rather than 403 — the bell is chrome on
 *              every screen and must not explode for anyone — so this is not an
 *              error state, it is a real and permanent emptiness.
 *
 * THE ONE THING THIS CANNOT SEE, stated rather than discovered: `visibleKinds`
 * declares what the reader MAY see and not what the full set IS, so deciding
 * "is this narrowed" requires the client to hold its own list of the kinds that
 * exist. A fourth kind added to the pg enum that this client has not heard of
 * would make a narrowed reader look 'full'. That fails in the quiet direction
 * (one sentence too confident, not a leak) and is reported to lane A rather than
 * worked around, because the honest fix is a field on the response.
 */
export type FeedScope = 'full' | 'narrowed' | 'none';

export function feedScope(visibleKinds: readonly NotificationKind[]): FeedScope {
  if (visibleKinds.length === 0) return 'none';
  return KNOWN_KINDS.every((k) => visibleKinds.includes(k)) ? 'full' : 'narrowed';
}

/** "calendar", "calendar and no-show", "calendar, no-show and campaign". */
export function kindListSentence(visibleKinds: readonly NotificationKind[]): string {
  const words = KNOWN_KINDS.filter((k) => visibleKinds.includes(k)).map((k) => KIND_LABEL[k]);
  if (words.length === 0) return '';
  if (words.length === 1) return words[0] as string;
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1] as string}`;
}

/**
 * The rows the panel is about to show that have never been read.
 *
 * Resolved rows are INCLUDED. They do not count toward the badge, but `read_at`
 * answers "has anybody looked at this" and a row the panel drew has been looked
 * at. Excluding them would leave a permanent set of never-read rows that the
 * badge does not count and nothing ever clears — a column quietly drifting away
 * from what it means.
 */
export function unreadIdsOf(items: readonly MerchantNotification[]): string[] {
  return items.filter((n) => n.readAt === null).map((n) => n.id);
}

/**
 * WHERE A ROW GOES, OR `null` FOR A ROW THAT GOES NOWHERE.
 *
 * ===========================================================================
 * NONE OF THE THREE LINKS THE API MINTS RESOLVES IN THIS ROUTER TODAY.
 * ===========================================================================
 * The raise sites write `/merchant/team/${artistId}`,
 * `/merchant/appointments/${bookingId}` and `/marketing/campaigns`. This shell
 * is a PATHLESS layout route (`router.tsx`: "every section below it is guarded
 * and framed without carrying a prefix in the URL"), so its sections are
 * `/team`, `/appointments`, `/marketing` — no `/merchant` prefix, and no
 * per-id route under any of them.
 *
 * All three pass `safeDeepLink` on the server, because they ARE site-relative
 * paths with one leading slash — the validator's job is to stop an open
 * redirect, not to know this router. So they arrive non-null and look clickable,
 * and following one lands the merchant on the router's not-found.
 *
 * SO THE ROW IS CLICKABLE ONLY WHEN THE PATH IS A SECTION THIS SHELL SERVES,
 * and today that means every bell row renders unclickable. That is deliberately
 * the SAME rendering `deepLink: null` already gets, for the same reason lane A
 * gives for it: a row that cannot be followed is still a row that says what
 * happened, and an unclickable row is better than a 404.
 *
 * WHAT THIS IS NOT: a translation. Mapping `/merchant/team/ART-1` onto `/team`
 * would drop the artist the notification is about and land her on a list, and
 * mapping `/marketing/campaigns` onto `/marketing` would drop the tab — a
 * client-side rewrite of the server's answer that looks like it worked. The
 * mismatch is a contract question for trunk; this column reports it and refuses
 * to guess. Reported, not fixed here.
 *
 * MATCHED AGAINST `NAV_ITEMS` RATHER THAN A LIST OF PATHS, because that is the
 * array `router.tsx` derives its own routes from. A section added there becomes
 * followable here with nothing to remember.
 */
export function linkTarget(deepLink: string | null): string | null {
  if (deepLink === null) return null;
  return NAV_ITEMS.some((item) => item.to === deepLink) ? deepLink : null;
}

/* ========================================================================== */
/*                                  the wire                                  */
/* ========================================================================== */

export const notificationKeys = {
  all: ['notifications'] as const,
  feed: (salonId: string) => [...notificationKeys.all, salonId] as const,
};

/**
 * HOW OFTEN THE BELL ASKS, AND WHY IT IS NOT FASTER.
 *
 * Sixty seconds, which is `api/salon.ts`' interval exactly. Two reasons and one
 * cost:
 *
 * 1. THE EVENTS ARE MINUTE-SCALE, NOT SECOND-SCALE. A calendar disconnects when
 *    a token expires; `noShowWorker.ts` raises on a sweep an hour after a missed
 *    slot; a campaign is held by a cap. Nothing in this table is a fact a
 *    merchant is waiting on with her hand on the mouse, and a bell that polls
 *    every five seconds is answering a question nobody asked.
 *
 * 2. LANE A DELIBERATELY DID NOT AUDIT THIS READ, and said why: the bell is
 *    ambient chrome on every screen, so a row per poll per signed-in staff
 *    member would "bury the deliberate reads the audit log exists to surface".
 *    An aggressive interval here would be spending the budget that decision
 *    bought. This is the client half of that agreement.
 *
 * AND ONE CADENCE RATHER THAN TWO. `useSalon` already polls at 60s, so the
 * dashboard has one polling rhythm and a reviewer has one number to change.
 *
 * THE COST, NAMED: `api/queryRuntime.ts` pins `focusManager` focused, and
 * `queryObserver` gates polling on `refetchIntervalInBackground || isFocused()`
 * — so this poll, like `useSalon`'s, CONTINUES IN A HIDDEN TAB and setting
 * `refetchIntervalInBackground: false` would not stop it. That file accepted one
 * lightweight request per minute per hidden tab; this makes it two. Stated
 * because it is the direct consequence of a decision taken elsewhere, and the
 * next person raising this interval should know it is not free.
 */
export const NOTIFICATION_POLL_MS = 60_000;

export function useNotifications(): UseQueryResult<NotificationFeed> {
  const salonId = useSalonId();
  return useQuery({
    queryKey: notificationKeys.feed(salonId),
    queryFn: ({ signal }) =>
      authedRequest<NotificationFeed>('merchant', `/v1/salons/${salonId}/notifications`, {
        signal,
      }),
    refetchInterval: NOTIFICATION_POLL_MS,
    // Retry policy is global — api/retryPolicy.ts. Never a bare number here.
  });
}

/**
 * MARK READ. `{ ids }` for the rows the panel actually drew, `{ all: true }` for
 * the design's "Mark all read".
 *
 * NO IDEMPOTENCY KEY, and that is the rule rather than an omission:
 * non-negotiable #4 is about money-moving POSTs and this moves none. The write
 * is `SET read_at = now() WHERE read_at IS NULL`, so a double submit marks
 * nothing twice and the first timestamp survives — which matters here because
 * the panel marks on OPEN and a merchant opening it twice is the normal case.
 *
 * THE SERVER'S ANSWER IS WRITTEN STRAIGHT INTO THE CACHE rather than triggering
 * a refetch, and both halves of that are deliberate:
 *
 *   `unreadCount` comes back from the same transaction that did the marking, so
 *   it is the freshest number anybody has. Invalidating instead would put a
 *   round trip between the click and the badge clearing, on chrome, for a number
 *   the response is already holding.
 *
 *   `items` are patched LOCALLY with a timestamp, because the response says how
 *   many rows flipped and not which. That is a rendering fact — the row loses
 *   its unread tint — and the next poll replaces it with the server's own
 *   `read_at` a minute later. It cannot drift into a wrong number because the
 *   count is not derived from it.
 */
export function useMarkNotificationsRead(): UseMutationResult<
  MarkReadResult,
  unknown,
  MarkReadSelection
> {
  const salonId = useSalonId();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (selection) =>
      authedRequest<MarkReadResult>('merchant', `/v1/salons/${salonId}/notifications/read`, {
        method: 'POST',
        body: selection,
      }),
    onSuccess: (result, selection) => {
      const at = new Date().toISOString();
      queryClient.setQueryData<NotificationFeed>(notificationKeys.feed(salonId), (previous) =>
        previous === undefined
          ? previous
          : {
              ...previous,
              unreadCount: result.unreadCount,
              items: previous.items.map((n) =>
                n.readAt !== null || ('ids' in selection && !selection.ids.includes(n.id))
                  ? n
                  : { ...n, readAt: at },
              ),
            },
      );
    },
    /*
     * A FAILED MARK-READ IS SWALLOWED ON PURPOSE, and this is the one place in
     * the bell where that is the right call. The read is ambient and repeats
     * itself: the panel marks again on the next open, and the badge is the
     * server's number either way because nothing here decrements it locally. A
     * banner in the chrome saying "couldn't mark read" is noise about a thing
     * the merchant did not ask for and which fixes itself. The mutation's
     * `isError` is still observable to a caller that wants it; the panel does
     * not draw it. See `NotificationBell.tsx § onMarkRead`.
     */
  });
}
