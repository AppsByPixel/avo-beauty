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
/*                             parsed, not cast                               */
/* ========================================================================== */

/**
 * WHY THE BELL PARSES ITS OWN RESPONSE, AND WHAT IT TOOK DOWN BEFORE IT DID.
 *
 * `authedRequest<NotificationFeed>` was a CAST. `api/client.ts` ends in
 * `await response.json() as T`, and an assertion cannot fail — so `visibleKinds`
 * was typed as present and nothing at runtime checked that it was. Measured
 * against a 200 body of `{ items: [], nextCursor: null, unreadCount: 0 }`:
 *
 *     feedScope        → TypeError: Cannot read properties of undefined (reading 'length')
 *     kindListSentence → TypeError: Cannot read properties of undefined (reading 'includes')
 *
 * TWO SITES, NOT ONE. Guarding only the first moves the crash to the second,
 * because the panel calls `kindListSentence` the moment `feedScope` answers
 * anything other than 'full'.
 *
 * AND THE BLAST RADIUS IS THE PRODUCT, NOT THE BELL. `NotificationBell` renders
 * in `Header`, which `MerchantShell` renders ONCE above `<Outlet>` — one poll and
 * one badge for all ten sections, which is the right shape and is also why a
 * throw here takes every screen into the CatchBoundary. That is the exact outcome
 * the feed's own comment above promises against: "the bell is chrome on every
 * screen and must not explode for anyone."
 *
 * ---------------------------------------------------------------------------
 * `?? []` AT THE CALL SITES IS THE CHEAP FIX, AND IT REPLACES A CRASH WITH A LIE
 * ---------------------------------------------------------------------------
 * `feedScope` answering 'none' has a specific, load-bearing meaning — the reader
 * holds none of the three permissions — and the panel then tells her
 * "Notifications go to the people who can act on them." That is a confident,
 * permanent-sounding sentence about her own authority. Rendering it because a
 * proxy mangled a response would be precisely the silent failure `visibleKinds`
 * was put on the wire to prevent, wearing the costume of a fix.
 *
 * A FEED WHOSE SHAPE WE CANNOT TRUST IS NOT A QUIET FEED AND NOT A NARROWED ONE.
 * It is a feed we did not get, which is a third thing, and the panel already has
 * words for it: the failed-read state, or — over a feed we already hold — the
 * stale banner. Both arrive on their own once this throws, because a parse
 * failure is a rejected query like any other. Nothing in `NotificationBell.tsx`
 * changed to get them.
 *
 * SO THE READERS BELOW ARE LEFT ALONE, AND THAT IS THE DECISION RATHER THAN AN
 * OMISSION. `feedScope(visibleKinds: readonly NotificationKind[])` is already
 * TOTAL over its declared domain; it only ever crashed because the cast handed it
 * a value its signature forbids. Widening the domain with `?? []` would make it
 * accept that value and then invent an answer for it — the lie above, at a
 * different address. The type was right; the cast was the thing that lied. This
 * parse is what makes the type true again.
 *
 * ---------------------------------------------------------------------------
 * A SHAPE PARSE, DELIBERATELY NOT AN ENUM PARSE
 * ---------------------------------------------------------------------------
 * `kind` and `severity` are checked to be STRINGS and are NOT narrowed to the
 * unions above. `customers.ts § tier` set the rule and gave the reason — "a parse
 * that threw on a fifth tier would take the whole book down over a label" — and
 * it binds harder here, because this read is chrome: a fourth value added to the
 * pg enum would darken every screen in the dashboard rather than one section.
 *
 * Nothing is lost by admitting one. `kind` is not rendered at all (the dot is
 * driven by `severity`), an unrecognised `severity` lands on `data-tone` and
 * falls back in CSS, and both readers below iterate `KNOWN_KINDS` rather than
 * `visibleKinds` — so an unknown kind is inert in each, and `KIND_LABEL` can
 * never be indexed with one. The single thing an unknown kind still does is make
 * a narrowed reader look 'full', which is the gap `feedScope` already documents
 * and reports to lane A. That gap is unchanged here on purpose: turning it into a
 * hard failure would be this file choosing a dark screen over a sentence that is
 * one notch too confident.
 *
 * A PARSE FAILURE KEEPS THE GLOBAL RETRY BUDGET (`api/retryPolicy.ts`: two
 * retries for anything that is not a 403/404/400). Stated rather than special-
 * cased — a body mangled in transit is exactly the failure a second attempt can
 * fix, and a deterministically wrong body costs two extra requests on chrome
 * before the panel says so.
 *
 * THE STYLE IS `customers.ts`', not a sixth one: the same one-line assertions and
 * the same `where` strings, so a failure names the endpoint and the field instead
 * of "cannot read properties of undefined".
 */

function obj(v: unknown, where: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error(`${where} was not an object.`);
  }
  return v as Record<string, unknown>;
}

function str(v: unknown, where: string): string {
  if (typeof v !== 'string') throw new Error(`${where} was not a string.`);
  return v;
}

function nullableStr(v: unknown, where: string): string | null {
  return v === null ? null : str(v, where);
}

function int(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new Error(`${where} was not a whole number.`);
  }
  return v;
}

function arr(v: unknown, where: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`${where} was not an array.`);
  return v;
}

/**
 * ONE ROW. Every key `NotificationView` documents is read, including the ones no
 * component draws today — `kind` is the one, and reading it here is what makes
 * "the wire carries this" checkable rather than remembered.
 */
export function parseNotification(raw: unknown, where: string): MerchantNotification {
  const n = obj(raw, where);
  return {
    id: str(n.id, `${where}.id`),
    // Verified STRING, narrowed on the way out. See § a shape parse above: the
    // assertion is about the label, never about the shape, and no reader can
    // index `KIND_LABEL` with a value that did not come from `KNOWN_KINDS`.
    kind: str(n.kind, `${where}.kind`) as NotificationKind,
    severity: str(n.severity, `${where}.severity`) as NotificationSeverity,
    title: str(n.title, `${where}.title`),
    body: str(n.body, `${where}.body`),
    deepLink: nullableStr(n.deepLink, `${where}.deepLink`),
    createdAt: str(n.createdAt, `${where}.createdAt`),
    readAt: nullableStr(n.readAt, `${where}.readAt`),
    resolvedAt: nullableStr(n.resolvedAt, `${where}.resolvedAt`),
  };
}

export function parseNotificationFeed(raw: unknown): NotificationFeed {
  const where = 'GET /v1/salons/{id}/notifications';
  const f = obj(raw, where);
  return {
    items: arr(f.items, `${where}.items`).map((row, i) =>
      parseNotification(row, `${where}.items[${i}]`),
    ),
    nextCursor: nullableStr(f.nextCursor, `${where}.nextCursor`),
    unreadCount: int(f.unreadCount, `${where}.unreadCount`),
    visibleKinds: arr(f.visibleKinds, `${where}.visibleKinds`).map(
      (k, i) => str(k, `${where}.visibleKinds[${i}]`) as NotificationKind,
    ),
  };
}

/**
 * THE MARK-READ ANSWER, PARSED FOR A DIFFERENT REASON THAN THE FEED.
 *
 * `authedRequest<MarkReadResult>` was the same cast, and a missing `unreadCount`
 * does NOT crash — `onSuccess` writes it straight into the cache, the panel reads
 * `unread !== undefined && unread > 0`, and the badge simply DISAPPEARS. Which is
 * the lie the badge's own comment names from the other direction: "a badge that
 * vanishes on a dropped connection reads as 'nothing to do'." Silent, and about
 * the one number the bell exists to show.
 *
 * `marked` is read although nothing renders it, for `customers.ts`' reason: the
 * next reader should find the record whole rather than discover a hole.
 *
 * WHAT A FAILURE HERE DOES, AND WHY IT NEEDS NO NEW HANDLING. The throw happens
 * inside `mutationFn`, so `onSuccess` never runs, the cache keeps the server's
 * last good count, and the deliberate swallow below is already the right answer —
 * the mark is ambient, it repeats on the next open, and the 60s poll reconciles.
 * A banner about it would be noise about a thing the merchant did not ask for.
 */
export function parseMarkReadResult(raw: unknown): MarkReadResult {
  const where = 'POST /v1/salons/{id}/notifications/read';
  const r = obj(raw, where);
  return {
    marked: int(r.marked, `${where}.marked`),
    unreadCount: int(r.unreadCount, `${where}.unreadCount`),
  };
}

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

/*
 * TOTAL OVER ITS DECLARED DOMAIN, AND NOT DEFENDED BEYOND IT. There is no
 * `?? []` here and there must not be one: the signature says "an array", the
 * parse above is what makes that true of the wire, and a guard here would widen
 * the domain to include `undefined` and then answer 'none' for it — a sentence
 * about the reader's authority, invented from a mangled response. See
 * § parsed, not cast.
 */
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
    queryFn: async ({ signal }) =>
      parseNotificationFeed(
        await authedRequest<unknown>('merchant', `/v1/salons/${salonId}/notifications`, {
          signal,
        }),
      ),
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
    mutationFn: async (selection) =>
      parseMarkReadResult(
        await authedRequest<unknown>('merchant', `/v1/salons/${salonId}/notifications/read`, {
          method: 'POST',
          body: selection,
        }),
      ),
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
