import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Skeleton, StaleBanner } from '@avo/ui';
import {
  feedScope,
  kindListSentence,
  linkTarget,
  unreadIdsOf,
  useMarkNotificationsRead,
  useNotifications,
  type MarkReadSelection,
  type MerchantNotification,
  type NotificationFeed,
} from '../api/notifications.js';
import { SectionError } from '../routes/sectionState.js';

/**
 * THE NOTIFICATION BELL — Aftab's item 4, "Notification bell on top right".
 *
 * ===========================================================================
 * WHAT THE DESIGN DRAWS (AVO Merchant Dashboard.dc.html:88-115, 1421-1432)
 * ===========================================================================
 * A 36px square button in the header's right rail, between the date and the
 * rule that precedes the salon pill. A bell glyph in `currentColor`; the button
 * tints to `#EEF1EC` while the panel is open. A pill badge at top-right, 16px
 * min-width, `#A0503F` with white 10px bold digits and a 2px canvas-coloured
 * ring, rendered ONLY when there is something unread.
 *
 * The panel is 340px wide, absolutely positioned 46px below, 16px radius, a
 * `0 24px 48px -20px` shadow. A head row: "Notifications" in the display face
 * beside a quiet "Mark all read". A 340px-max scroller of rows — each an 8px
 * dot, a 13.5px title, a 12px body and an 11.5px timestamp, unread rows tinted
 * `#FBFAF8` and read rows transparent with a grey dot. `noAlerts` swaps the
 * scroller for "You're all caught up." A footer rule: "New bookings,
 * cancellations and no-shows also go to WhatsApp."
 *
 * WHAT THE DESIGN HAS THAT THE API DOES NOT. The design's fixture carries five
 * kinds — booking, noshow, cancel, shop, calendar — and `alertHue` gives each a
 * colour. The table has three (`calendar_disconnected`, `booking_no_show`,
 * `campaign_held`) and puts `severity: 'info' | 'warning'` on the wire instead.
 * So the dot is driven by SEVERITY, which is the field that exists, rather than
 * by a kind map transcribed from a fixture that does not match the enum. The
 * `kind: 'calendar'` row at :1139 — "Calendar disconnected · Fatima", "Falling
 * back to salon hours until she reconnects Google Calendar." — is the design's
 * drawing of the one kind both halves agree on, and its copy is the SERVER's to
 * write: `availability.ts` composes the title and body, so this component
 * renders `title` and `body` verbatim and invents no strings per kind.
 *
 * ===========================================================================
 * WHY IT MOUNTS IN `Header.tsx` AND NOT IN A ROUTE
 * ===========================================================================
 * `Header` is the chrome: one instance, rendered by `MerchantShell` above
 * `<Outlet>`, shared by all ten sections. Three things follow, and each is a
 * reason a per-route bell would be wrong:
 *
 *   ONE POLL, NOT TEN. Mounting per section would remount the query on every
 *   navigation and restart the interval, which for an ambient read lane A
 *   deliberately left out of the audit log is exactly the wrong direction.
 *
 *   THE BADGE SURVIVES NAVIGATION. A count that resets while a merchant walks
 *   from Overview to Team is a count she stops trusting.
 *
 *   IT IS BELOW `MerchantShell`'s `!session` EARLY RETURN. `SignedInShell` is
 *   the only thing that renders `Header`, so a signed-out shell mounts no bell
 *   and issues no request — the same property that lets `useSalonId` be
 *   non-optional.
 *
 * `Header` takes it as a `ReactNode` prop, which is the shape that file already
 * settled on for `BranchSelector`: "`ReactNode` is what lets this component stop
 * knowing". The header does not learn about permissions, salons or polling.
 *
 * ===========================================================================
 * THE TWO EMPTIES, WHICH ARE THE POINT OF THE WHOLE FIELD
 * ===========================================================================
 * The feed is FILTERED to the kinds the reader's permissions cover, so an empty
 * `items` is two different sentences and the response carries `visibleKinds` to
 * tell them apart:
 *
 *   full      "You're all caught up."  — the design's own words, and true only
 *             when every kind this client knows about is visible.
 *   narrowed  "Nothing waiting for you." over a sentence naming what she covers.
 *             A NARROWER CLAIM, and it reads as one: nothing is waiting *for
 *             her*, and other kinds are going to other people.
 *   none      the same narrower title with no list, for a reader who holds none
 *             of the three. The API answers 200 and an empty feed rather than
 *             403, because a 403 on chrome makes every screen look broken for
 *             someone whose account is working exactly as configured.
 *
 * The scope note is NOT only an empty state. It renders above a POPULATED
 * narrowed list too, and that is what makes "Mark all read" honest: the button
 * marks everything she could have read and nothing else (the server takes the
 * same filter as the read, so a front desk cannot silence the marketing
 * manager's badge), and the sentence directly above it has already said what
 * "all" covers here. The design's copy is kept verbatim rather than paraphrased
 * into "Mark all mine".
 *
 * ===========================================================================
 * RESOLVED IS NOT READ, AND A RESOLVED ROW DOES NOT VANISH
 * ===========================================================================
 * `resolvedAt` non-null renders the title STRUCK THROUGH with a neutral dot, and
 * does not count toward the badge. It stays in the list. A calendar that
 * reconnects before anyone looks is the case: a merchant who saw a red badge,
 * got pulled away and came back to an empty panel learns nothing and stops
 * trusting the bell. She should find the row, struck, saying what happened and
 * that it is over.
 *
 * The strike is a VISUAL fact, so it is paired with a visually-hidden
 * "Resolved." — `text-decoration` reaches no screen reader, and a row whose
 * whole meaning is "this is over" cannot carry that meaning in a pixel alone.
 */

/* -------------------------------------------------------------------------- */

export interface NotificationBellPanelProps {
  /** `undefined` until the first fetch lands. Never defaulted to an empty feed. */
  feed: NotificationFeed | undefined;
  pending: boolean;
  error: unknown;
  onRetry: () => void;
  retrying: boolean;
  onMarkRead: (selection: MarkReadSelection) => void;
  /** Called with a path this shell serves. See `linkTarget`. */
  onNavigate: (to: string) => void;
  /** When `feed` was last fetched successfully, for the stale banner. */
  updatedAt: number;
}

/**
 * The trigger AND the popover, in one component, exported for the render test.
 *
 * THEY ARE ONE COMPONENT BECAUSE THEY ARE ONE PAYLOAD. The badge draws
 * `unreadCount` and the list draws `items`, and the whole hazard in this feature
 * is those two disagreeing — a badge over an empty panel, or a panel of unread
 * rows under no badge. Splitting them into a `Bell` and a `Panel` would let a
 * test pass on each half while the pair lies. `SocialLinksPanel` is the shape
 * this follows: the presentation takes props, the container below wires hooks.
 */
export function NotificationBellPanel({
  feed,
  pending,
  error,
  onRetry,
  retrying,
  onMarkRead,
  onNavigate,
  updatedAt,
}: NotificationBellPanelProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  /** Ids marked during THIS opening, so a poll landing while open cannot re-send. */
  const markedRef = useRef<Set<string>>(new Set());

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  /*
   * ESC CLOSES, AND A POINTER OUTSIDE CLOSES. interaction-spec.md §2 for the
   * first; the second is what every popover owes a pointer user.
   *
   * NOT A FOCUS TRAP. §2 scopes trapping to "sheets and modals", and this is
   * neither: the page behind it stays live and usable, nothing is inert, and
   * `aria-modal` would be a promise to a screen reader that is simply false
   * here. Focus MOVES IN on open and RETURNS to the trigger on close, which are
   * the two halves that matter for a keyboard user.
   */
  useEffect(() => {
    if (!open) return;
    popRef.current?.focus();

    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') close();
    }
    function onPointerDown(event: PointerEvent) {
      const root = rootRef.current;
      if (root && event.target instanceof Node && !root.contains(event.target)) setOpen(false);
    }

    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, close]);

  /*
   * OPENING MARKS WHAT IT SHOWED — `{ ids }`, never `{ all: true }`.
   *
   * The distinction is the whole reason the API accepts both. The panel draws
   * one page; `{ all: true }` would silence rows further down the stream that
   * nobody has seen, which is the opposite of what opening a panel means. The
   * merchant pressing "Mark all read" is asking for that; opening the panel is
   * not.
   *
   * An EFFECT rather than the click handler, because the feed may still be in
   * flight when she opens it and the rows that arrive a moment later have also
   * been shown. `markedRef` makes it at-most-once per id per opening so the 60s
   * poll landing on an open panel cannot re-send; the server is idempotent
   * anyway (`WHERE read_at IS NULL`), so this is about traffic, not correctness.
   */
  useEffect(() => {
    if (!open) {
      markedRef.current = new Set();
      return;
    }
    if (feed === undefined) return;
    const ids = unreadIdsOf(feed.items).filter((id) => !markedRef.current.has(id));
    if (ids.length === 0) return;
    for (const id of ids) markedRef.current.add(id);
    onMarkRead({ ids });
  }, [open, feed, onMarkRead]);

  /*
   * NO BADGE, AND NO NUMBER IN THE ACCESSIBLE NAME, UNTIL A COUNT EXISTS.
   *
   * `feed?.unreadCount ?? 0` would have been the natural spelling and it is the
   * premature-zero defect `stateCensus.test.ts § the announced rule` was written
   * for — "a pending screen must not announce a zero it is not painting", found
   * last time in an sr-only caption. A bell that announces "0 unread" while it
   * is still asking is making a claim it cannot support.
   *
   * A STALE COUNT IS STILL SHOWN. If a refresh fails, `feed` is the last good
   * payload and the badge keeps its number behind the panel's stale banner —
   * stale-not-blank, §4. A badge that vanishes on a dropped connection reads as
   * "nothing to do".
   */
  const unread = feed?.unreadCount;
  const scope = feed === undefined ? null : feedScope(feed.visibleKinds);
  const scopeSentence =
    scope === 'narrowed' && feed
      ? `You see ${kindListSentence(feed.visibleKinds)} notifications. Others go to the people who can act on them.`
      : scope === 'none'
        ? 'Notifications go to the people who can act on them.'
        : null;

  return (
    <div className="dash-bell" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="dash-bell__button"
        aria-label={
          unread !== undefined && unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="dash-bell-pop"
        data-open={open ? 'true' : undefined}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path
            d="M5.5 8a4.5 4.5 0 1 1 9 0c0 3.2 1 4.4 1.5 5h-12c.5-.6 1.5-1.8 1.5-5Z"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <path
            d="M8.2 15.6a1.9 1.9 0 0 0 3.6 0"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
        {unread !== undefined && unread > 0 ? (
          <span className="dash-bell__badge" aria-hidden="true">
            {unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          id="dash-bell-pop"
          ref={popRef}
          className="dash-bell__pop"
          role="dialog"
          aria-label="Notifications"
          tabIndex={-1}
        >
          <div className="dash-bell__head">
            <span className="dash-bell__heading avo-display">Notifications</span>
            {unread !== undefined && unread > 0 ? (
              <button
                type="button"
                className="dash-bell__markall"
                onClick={() => onMarkRead({ all: true })}
              >
                Mark all read
              </button>
            ) : null}
          </div>

          <div className="dash-bell__list">
            <PanelBody
              feed={feed}
              pending={pending}
              error={error}
              onRetry={onRetry}
              retrying={retrying}
              onNavigate={onNavigate}
              updatedAt={updatedAt}
              scopeSentence={scopeSentence}
            />
          </div>

          {/* Design footer, verbatim. A statement about a different channel. */}
          <div className="dash-bell__foot">
            New bookings, cancellations and no-shows also go to WhatsApp.
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------ the four states */

function PanelBody({
  feed,
  pending,
  error,
  onRetry,
  retrying,
  onNavigate,
  updatedAt,
  scopeSentence,
}: Omit<NotificationBellPanelProps, 'onMarkRead'> & { scopeSentence: string | null }) {
  /*
   * STALE-NOT-BLANK COMES FIRST. A failed refresh over a feed we already have is
   * a banner above the rows she was reading, never a replacement for them — §4,
   * and `StaleBanner` is the shared component that says when. Only a failure
   * with NOTHING behind it becomes the error state.
   */
  if (feed !== undefined) {
    return (
      <>
        {error ? <StaleBanner updatedAt={updatedAt} onRetry={onRetry} retrying={retrying} /> : null}
        {scopeSentence !== null ? <p className="dash-bell__scope">{scopeSentence}</p> : null}
        {feed.items.length === 0 ? (
          <Empty scopeSentence={scopeSentence} />
        ) : (
          <>
            {feed.items.map((n) => (
              <Row key={n.id} notification={n} onNavigate={onNavigate} />
            ))}
            {/*
             * THE PAGE, SAID OUT LOUD. `nextCursor` is a REAL cursor here —
             * unlike `GET …/orders`, where it is always null beside an honest
             * `truncated` and `ShopOrders.tsx` is pinned never to page on it.
             * This panel still shows one page, and a 340px scroller that simply
             * stops is the "capped list reports itself as complete" defect that
             * cost this lane a wrong deposit total once already. So it says so.
             *
             * The badge is NOT page-dependent — lane A made `unreadCount` an
             * aggregate over the whole visible set on purpose — so a merchant
             * with more than a page of unread sees a badge larger than the rows
             * in front of her, and this line is what explains the difference.
             * "Mark all read" covers the whole set and reconciles them.
             */}
            {feed.nextCursor !== null ? (
              <p className="dash-bell__more">Older notifications aren&rsquo;t shown here.</p>
            ) : null}
          </>
        )}
      </>
    );
  }

  if (error) {
    /*
     * ERROR IN CHROME IS ITS OWN PROBLEM: this renders INSIDE the popover, so a
     * bell that cannot load leaves the screen behind it untouched — the panel
     * explains itself and the merchant closes it. `SectionError` carries the
     * whole §4 vocabulary (401 renders nothing and lets the shell redirect, a
     * served 409/503 renders the server's sentence, a connectivity failure
     * becomes "No connection", everything else offers the retry), so the bell
     * speaks the same language as every section rather than inventing a
     * shorter one.
     *
     * `forbiddenTitle` is required and is not reachable: a reader with none of
     * the three permissions gets 200 and an empty feed, not 403. It is filled
     * honestly rather than left as a lie in case the contract ever changes.
     */
    return (
      <div className="dash-bell__state">
        <SectionError
          error={error}
          forbiddenTitle="You don't have access to notifications"
          failedTitle="Couldn't load notifications"
          onRetry={onRetry}
          retrying={retrying}
        />
      </div>
    );
  }

  if (pending) {
    return (
      <div className="dash-bell__loading" aria-hidden="true">
        {/* Four rows: the scroller's own height, per the design's placeholder count. */}
        {[0, 1, 2, 3].map((i) => (
          <div className="dash-bell__row dash-bell__row--skeleton" key={i}>
            <Skeleton width={8} height={8} radius={9} />
            <span className="dash-bell__text">
              <Skeleton width="72%" height={13} />
              <Skeleton width="90%" height={11} />
            </span>
          </div>
        ))}
      </div>
    );
  }

  return null;
}

/**
 * The two empties. `scopeSentence` is non-null exactly when the feed is
 * narrowed, so it is both the discriminator and the explanation — there is no
 * second flag that could disagree with it.
 */
function Empty({ scopeSentence }: { scopeSentence: string | null }) {
  if (scopeSentence === null) {
    // Design copy, verbatim. True only because every kind is visible.
    return <div className="dash-bell__empty">You&rsquo;re all caught up.</div>;
  }
  /*
   * The narrower claim. The sentence naming the kinds is already rendered above
   * this block by `PanelBody`, so it is not repeated — what changes here is the
   * TITLE, from a statement about the salon to a statement about her.
   */
  return <div className="dash-bell__empty">Nothing waiting for you.</div>;
}

/* ------------------------------------------------------------------- one row */

function Row({
  notification,
  onNavigate,
}: {
  notification: MerchantNotification;
  onNavigate: (to: string) => void;
}) {
  const resolved = notification.resolvedAt !== null;
  const unread = notification.readAt === null;
  const to = linkTarget(notification.deepLink);

  const dot = (
    <span
      className="dash-bell__dot"
      // A resolved row demands no attention, whatever severity raised it.
      data-tone={resolved ? 'resolved' : notification.severity}
      aria-hidden="true"
    />
  );

  const text = (
    <span className="dash-bell__text">
      <span className="dash-bell__title" data-resolved={resolved ? 'true' : undefined}>
        {notification.title}
      </span>
      {resolved ? <span className="avo-sr-only">Resolved.</span> : null}
      <span className="dash-bell__body">{notification.body}</span>
      <span className="dash-bell__when">{timeLabel(notification.createdAt)}</span>
    </span>
  );

  /*
   * A ROW THAT GOES NOWHERE IS NOT A BUTTON. `linkTarget` returns null both for
   * the API's own `deepLink: null` and for a link this router does not serve —
   * which today is all three of them (see `api/notifications.ts § linkTarget`).
   * Rendering it as a disabled button would keep it in the tab order promising
   * something; rendering a div is the honest shape for a row that is only ever
   * read.
   */
  if (to === null) {
    return (
      <div className="dash-bell__row" data-unread={unread ? 'true' : undefined}>
        {dot}
        {text}
      </div>
    );
  }

  return (
    <button
      type="button"
      className="dash-bell__row dash-bell__row--link"
      data-unread={unread ? 'true' : undefined}
      onClick={() => onNavigate(to)}
    >
      {dot}
      {text}
    </button>
  );
}

/**
 * `Overview.tsx § timeLabel`, deliberately the same rule: the clock for today,
 * the date and the clock for anything older. The design writes "6 min ago" and
 * "Yesterday", which is a relative format that goes stale in place on a panel
 * that stays open — and the activity feed one card away already settled this
 * question for this surface. Western digits by construction (#12): an `en-GB`
 * locale, never the browser's.
 */
function timeLabel(iso: string): string {
  const when = new Date(iso);
  const sameDay = when.toDateString() === new Date().toDateString();
  const clock = when.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return sameDay
    ? clock
    : `${when.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · ${clock}`;
}

/* ----------------------------------------------------------- the container */

/**
 * What `MerchantShell` mounts. Hooks in, props down — the split that lets the
 * panel above be rendered by a test with a fixture instead of a query client.
 */
export function NotificationBell() {
  const query = useNotifications();
  const markRead = useMarkNotificationsRead();
  const navigate = useNavigate();

  const onMarkRead = useCallback(
    (selection: MarkReadSelection) => {
      // Failure is deliberately not surfaced — api/notifications.ts § onSuccess.
      markRead.mutate(selection);
    },
    [markRead],
  );

  return (
    <NotificationBellPanel
      feed={query.data}
      pending={query.isPending}
      error={query.error}
      onRetry={() => void query.refetch()}
      retrying={query.isRefetching}
      onMarkRead={onMarkRead}
      onNavigate={(to) => void navigate({ to })}
      updatedAt={query.dataUpdatedAt}
    />
  );
}
