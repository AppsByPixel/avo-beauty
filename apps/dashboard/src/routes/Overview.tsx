import { fils } from '@avo/types';
import { Card, EmptyState, ErrorState, Money, Skeleton, StatCard, StaleBanner } from '@avo/ui';
import { ApiError } from '../api/client.js';
import {
  useRecentActivity,
  useSalonMetrics,
  type ActivityItem,
  type SalonMetrics,
  type ScopedSalonMetrics,
} from '../api/salon.js';
import { useBranchScope } from '../shell/BranchScope.js';

/**
 * Merchant → Overview.
 *
 * NO COURTESY PERMISSION GATE, DELIBERATELY. `GET /salons/{id}/metrics` is
 * `requireDashboardPerm(req, 'dashboard')` server-side, so the refusal arrives on
 * its own and `SectionError` explains it. A client check here would duplicate the
 * server and drift from it. The ledger in sectionState.tsx records why — on
 * Settings the same absence WAS an oversight, and nothing distinguished the two.
 *
 * THE ACTIVITY PANEL USED TO READ `GET /charges`, WHICH THIS SCREEN CAN NEVER
 * REACH. The paragraph that stood here said so and treated it as the contract:
 * "`requireScannerPerm(req, 'charges')` — a SCANNER-scope guard, not a dashboard
 * one. No web principal satisfies it whatever permissions she holds." Every word
 * of that is true, and it described a bug. An endpoint this screen cannot reach
 * is not an endpoint this screen should call. The panel now reads
 * `GET /salons/{id}/activity`, which is `requireDashboardPerm(req, 'dashboard')`
 * — the same gate as the metrics beside it, and the endpoint built for this
 * panel. See `api/salon.ts § useRecentActivity`.
 *
 * SO BOTH HOOKS NOW SHARE ONE GATE, which is why the feed has no permission
 * state of its own: a staff member without `perms.dashboard` is refused the
 * metrics too and never gets past `MetricsError`. The 403 branch below survives
 * for the one refusal that can still reach it alone — `requireSameSalon`.
 */
export function Overview() {
  // No salon id here at all. Both hooks read it from the session.
  const { selected, selectedName } = useBranchScope();
  const metrics = useSalonMetrics(selected);
  const activity = useRecentActivity();

  /*
   * STALE-NOT-BLANK DOES NOT APPLY TO A REFUSAL.
   *
   * interaction-spec.md §4 keeps the last-known figures on screen through a
   * *network* failure, because a merchant who watches her numbers vanish assumes
   * the money did too. A 403 is not that failure. It means this staff member may
   * not see these figures — and holding them on screen behind a "Couldn't
   * refresh · Retry" banner shows her exactly what she is not allowed to see,
   * captioned with a button that will never work.
   *
   * Observed, not theorised: signing Hessa in after Noura on the same browser
   * did this. The API answered 403 to both Overview calls and the banner served
   * Noura's figures underneath it.
   */
  const forbidden = metrics.error instanceof ApiError && metrics.error.isForbidden;
  const showStale = metrics.isError && metrics.data !== undefined && !forbidden;

  if (metrics.isError && (metrics.data === undefined || forbidden)) {
    return <MetricsError error={metrics.error} onRetry={() => void metrics.refetch()} retrying={metrics.isFetching} />;
  }

  /*
   * ===========================================================================
   * WHAT THE FIGURES ACTUALLY COVER — read off the SERVER'S ECHO, never off the
   * request.
   * ===========================================================================
   * The branch selector sends `?branch=`; `GET /salons/{id}/metrics` answers
   * with `branchId`/`branchName` saying what it applied. Those are two different
   * facts and this screen must render the second one, because the first is only
   * a hope. An API that predates the parameter ignores it and answers 200 with
   * salon-wide figures — and if this screen believed its own request, it would
   * put "Salmiya" over both-branch numbers. That is the EXACT defect the branch
   * selector was built to remove; reintroducing it one layer down, silently,
   * would be worse than the label it replaced, because it would look deliberate.
   *
   * `applied === undefined` (no echo at all) collapses to "salon-wide", which is
   * what such a server in fact returned.
   */
  const appliedBranchId = appliedBranchOf(metrics.data);
  const scopeIgnored = scopeWasIgnored(selected, metrics.data);

  return (
    <>
      {showStale ? (
        <StaleBanner
          updatedAt={metrics.dataUpdatedAt}
          onRetry={() => void metrics.refetch()}
          retrying={metrics.isFetching}
        />
      ) : null}

      {scopeIgnored ? (
        <ScopeNotice
          requestedName={selectedName}
          appliedName={metrics.data?.applied?.branchName ?? null}
          appliedBranchId={appliedBranchId}
        />
      ) : null}

      <KpiRow metrics={metrics.data?.metrics} loading={metrics.isPending} />

      <div className="overview__grid">
        <Card className="overview__activity" flush>
          {/*
            THE FEED IS SALON-WIDE AND SAYS SO WHEN THAT MATTERS.
            `GET /salons/{id}/activity` takes no branch parameter — the contract
            this lane was given scopes `metrics` and nothing else — so with a
            branch applied above, these five lines cover more than the tiles do.
            Leaving that unsaid would rebuild the original defect inside the fix:
            a branch named in the chrome, salon-wide rows underneath it. The
            qualifier appears only when the two genuinely differ.
          */}
          <h2 className="overview__card-title">
            Recent activity
            {appliedBranchId !== null ? (
              <span className="overview__card-scope">All branches</span>
            ) : null}
          </h2>
          <ActivityList
            items={activity.data?.items}
            loading={activity.isPending}
            error={activity.isError ? activity.error : null}
            onRetry={() => void activity.refetch()}
            retrying={activity.isFetching}
          />
        </Card>
      </div>
    </>
  );
}

/**
 * The applied scope as a plain `branchId | null`, folding "the response carried
 * no echo" into "salon-wide" — which is what such a response in fact contained.
 * Named and exported so the fold happens exactly once and can be asserted.
 */
export function appliedBranchOf(data: ScopedSalonMetrics | undefined): string | null {
  return data?.applied?.branchId ?? null;
}

/**
 * DID THE WORKSPACE IGNORE THE BRANCH WE ASKED FOR?
 *
 * The single question this screen's honesty rests on, so it is one exported
 * function rather than a conjunction inlined in JSX. Three things have to be
 * true: figures have arrived, a specific branch was requested, and what came
 * back is not that branch. `undefined` data is not a mismatch — nothing is on
 * screen to be wrong about yet.
 */
export function scopeWasIgnored(selected: string, data: ScopedSalonMetrics | undefined): boolean {
  if (data === undefined) return false;
  const requested = selected === 'all' ? null : selected;
  if (requested === null) return false;
  return appliedBranchOf(data) !== requested;
}

/**
 * THE FIGURES ARE NOT THE ONES THAT WERE ASKED FOR, AND THE SCREEN SAYS SO.
 *
 * Reached when the server's echo disagrees with the selection: an API that has
 * not shipped `?branch=` yet (lane A is building it in parallel, and this screen
 * has to be honest before it lands), or one that applied a different branch.
 *
 * IT DOES NOT MOVE THE SELECTOR BACK. A control that silently undoes a click is
 * a second lie — the merchant chose Salmiya and the header should keep showing
 * that she did. What is wrong is not her choice, it is the answer, so the
 * correction sits on the answer.
 *
 * `role="status"`, and the `.avo-stale` treatment reused verbatim rather than a
 * new one invented: the design bundle has no branch switcher and therefore no
 * strip for this, and `@avo/ui`'s stale banner is already this product's way of
 * saying "the numbers under this are not what you think" — same warn tint, same
 * dot, same type. `InfoBanner` was the other candidate and is explicitly wrong
 * here: its own header says it is standing prose that "never changes and is not
 * the result of anything the merchant did", and this is nothing but that.
 */
export function ScopeNotice({
  requestedName,
  appliedName,
  appliedBranchId,
}: {
  requestedName: string | null;
  appliedName: string | null;
  appliedBranchId: string | null;
}) {
  /* The branch she picked, by name where we have one — an id would mean nothing. */
  const asked = requestedName ?? 'the selected branch';

  return (
    <div className="avo-stale" role="status">
      <span className="avo-stale__dot" aria-hidden="true" />
      <span className="avo-stale__text">
        {appliedBranchId === null
          ? `Showing all branches. This workspace didn\u2019t narrow these figures to ${asked}, so everything below covers the whole salon.`
          : `Showing ${appliedName ?? 'another branch'}. This workspace answered with a different branch from the one selected, so these figures are not ${asked}.`}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ KPI row */

function KpiRow({ metrics, loading }: { metrics: SalonMetrics | undefined; loading: boolean }) {
  /*
   * interaction-spec.md §4: money fields skeleton as a bar. Never render
   * `0.000` before data arrives — a zero that turns out to be a loading state
   * generates a phone call.
   */
  if (loading || !metrics) {
    return (
      <div className="overview__kpis">
        {['Active members', 'Loaded today', 'Repeat rate', 'Upcoming today'].map((label) => (
          <StatCard key={label} label={label} value={null} loading />
        ))}
      </div>
    );
  }

  const loadedToday = fils(metrics.loadedTodayFils);

  return (
    <div className="overview__kpis">
      <StatCard
        label="Active members"
        value={metrics.activeMembers.toLocaleString('en-US')}
        {...(metrics.activeMembersDelta > 0
          ? { delta: `+${metrics.activeMembersDelta} this week` }
          : {})}
      />
      <StatCard
        label="Loaded today"
        // formatMoney/formatFils from @avo/types is the only money formatter.
        value={<Money amount={loadedToday} />}
        unit="KD"
        {...(metrics.knetSharePercent > 0
          ? { delta: `${metrics.knetSharePercent}% via KNET` }
          : {})}
      />
      {/*
        The design shows "+4 pts vs last month" under Repeat rate; that figure
        still does not exist on GET /salons/{id}/metrics, so it is still not
        rendered. The Upcoming tile's "next at 4:30 PM" DOES exist now —
        `nextAppointmentAt` landed on SalonMetricsSchema and tightened to
        required at 845dae4 — so half of this comment's old claim expired and
        only half is kept. Flagged-not-invented cuts both ways: rendering stops
        being optional once the field is real.
      */}
      <StatCard label="Repeat rate" value={`${metrics.repeatRatePercent}%`} />
      <StatCard
        label="Upcoming today"
        value={String(metrics.upcomingAppointments)}
        {...(metrics.nextAppointmentAt !== null
          ? { delta: `next at ${nextAtLabel(metrics.nextAppointmentAt)}` }
          : {})}
      />
    </div>
  );
}

/**
 * "next at 4:30 PM" — the Upcoming tile's sub-label, in the design's own words.
 *
 * THE SERVER SENDS AN INSTANT, DELIBERATELY. The schema's comment ties the field
 * to the count's own window and zone; the RENDERING is this client's job, in the
 * salon's clock. The zone is pinned to Asia/Kuwait rather than the browser's:
 * every salon this product ships to is Kuwaiti (`salon.timezone` defaults to it,
 * and the platform's own month boundary is defined in it), and an owner checking
 * the dashboard from abroad should read her salon's 4:30 PM, not her hotel's.
 *
 * `null` never reaches here — the schema guarantees it co-occurs with a count of
 * 0, and the call site hides the sub-label on null, which is the tile's honest
 * empty. Western digits by construction (#12): `toLocaleTimeString` with an
 * en locale renders Latin digits, which is what the money rule requires of the
 * Arabic layout too.
 */
function nextAtLabel(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'soon';
  return at.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'Asia/Kuwait',
  });
}

/* ------------------------------------------------------------- activity feed */

interface ActivityListProps {
  items: ActivityItem[] | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  retrying: boolean;
}

function ActivityList({ items, loading, error, onRetry, retrying }: ActivityListProps) {
  if (loading) {
    return (
      <ul className="overview__feed">
        {[0, 1, 2, 3, 4].map((row) => (
          <li key={row} className="overview__feed-item">
            <span className="overview__feed-dot" aria-hidden="true" />
            <span className="overview__feed-body">
              <Skeleton width={`${70 - row * 6}%`} height={13} />
              <Skeleton width={64} height={11} />
            </span>
          </li>
        ))}
      </ul>
    );
  }

  /** Held as the narrowed type, so the branches below can read the server's copy. */
  const apiError = error instanceof ApiError ? error : null;
  const forbidden = apiError?.isForbidden ?? false;

  /*
   * STALE-NOT-BLANK, AND IT ONLY BECAME REACHABLE WITH THE FIX.
   *
   * §4: "Network failure keeps the last-known data visible with a stale banner
   * rather than blanking." This panel checked `error` before `items` and so
   * would blank a list it was still holding — which never showed, because while
   * the hook read `GET /charges` it was refused on every load and there was
   * never a cached row to lose. Making the request succeed made the hazard real
   * in the same change, so it is fixed in the same change.
   *
   * A REFUSAL IS EXCLUDED, exactly as it is for the metrics above: a 403 means
   * this staff member may not see these lines, and holding them on screen behind
   * a retry shows her precisely what she is not allowed to see. `forbidden`
   * therefore falls through to the explain state even with rows in hand.
   *
   * The banner §4 asks for is the one `Overview` already renders above the KPI
   * row — the whole screen is stale together, so the feed does not draw a second.
   */
  const keepStale = Boolean(error) && !forbidden && items !== undefined && items.length > 0;

  if (error && !keepStale) {
    // 401 — the session is gone and the shell is already redirecting to
    // sign-in. Rendering a refusal here would flash for one frame and tell the
    // merchant she lacks a permission she actually holds.
    if (apiError?.isUnauthenticated) return null;

    const offline = apiError?.isConnectivity ?? false;

    return (
      <div className="overview__feed-state">
        {forbidden ? (
          /*
           * 403 — explain, no retry (interaction-spec.md §4).
           *
           * THIS BRANCH USED TO BE THE NORMAL PATH. It rendered the scanner's
           * refusal of `GET /charges` on every load, which is the bug this file
           * was fixed for. Now that the feed shares `perms.dashboard` with the
           * metrics, the only refusal that reaches here without `MetricsError`
           * taking the whole screen first is `requireSameSalon` — "That salon is
           * not yours." Kept, because a state that is unreachable today is not a
           * state that may be absent; the server's own copy is rendered rather
           * than paraphrased, exactly as `MetricsError` does below.
           */
          <ErrorState title="You don't have access to this" body={apiError?.message ?? ''} />
        ) : offline ? (
          /*
           * OFFLINE IS ITS OWN STATE, not "something went wrong" (§4). The
           * metrics beside this panel distinguish the two and this one did not —
           * a merchant on a dropped salon wifi was told the workspace answered
           * badly, which sends her looking for a fault that is not there. The
           * figures above stay on screen behind their stale banner, so the
           * sentence says so.
           */
          <ErrorState
            title="No connection"
            body="We can't reach the workspace. Your figures above are the last we loaded."
            onRetry={onRetry}
            retrying={retrying}
          />
        ) : (
          <ErrorState
            title="Couldn't load activity"
            body="The workspace didn't answer. Your figures above are unaffected."
            onRetry={onRetry}
            retrying={retrying}
          />
        )}
      </div>
    );
  }

  if (!items || items.length === 0) {
    /*
     * EMPTY, AND IT NOW MEANS WHAT IT SAYS. §4: "every empty state names the
     * thing and offers the one action that fills it."
     *
     * This state was previously unreachable — the request was refused before it
     * could return zero rows, so the panel showed a permission error on a quiet
     * morning exactly as it did on a busy one. The list it names is the list the
     * endpoint actually merges (`FEED_KINDS` plus the loyalty stream), not the
     * charges-only stream the old hook read, so a merchant who reads this and
     * then tops a customer up will see the line she was promised.
     *
     * The action is the scanner, because that is genuinely the only thing that
     * starts a line: nothing on this dashboard writes to the feed.
     */
    return (
      <div className="overview__feed-state">
        <EmptyState
          title="Nothing today yet"
          body="Charges, top-ups, deposit returns and tier changes land here as your team serves customers. The first one appears when someone scans a customer's QR on the salon phone."
        />
      </div>
    );
  }

  /*
   * `who` then `what`, which is the design's own row —
   * `AVO Merchant Dashboard.dc.html` § Overview draws `{{ f.who }} {{ f.what }}
   * {{ f.when }}`.
   *
   * THE AMOUNT IS INSIDE `what` AND IS NOT RENDERED SEPARATELY. It is composed
   * server-side, and `services/activityFeed.ts` explains why in terms of a bug
   * it already fixed once: a top-up's `amountFils` is what LANDED, bonus
   * included, so "topped up" beside that column reads five dinars higher than
   * the customer paid. `amountFils` is carried on the item for a caller that
   * needs to total or colour by it; this row is prose and prints the prose.
   */
  return (
    <ul className="overview__feed">
      {items.map((item) => (
        <li key={item.id} className="overview__feed-item">
          <span className="overview__feed-dot" aria-hidden="true" />
          <span className="overview__feed-body">
            <span className="overview__feed-text">
              <b>{item.who}</b> {item.what}
            </span>
            <span className="overview__feed-when">{timeLabel(item.at)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function timeLabel(iso: string): string {
  const when = new Date(iso);
  const sameDay = when.toDateString() === new Date().toDateString();
  return sameDay
    ? when.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : when.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) +
        ' · ' +
        when.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/* ------------------------------------------------------------------- errors */

function MetricsError({
  error,
  onRetry,
  retrying,
}: {
  error: unknown;
  onRetry: () => void;
  retrying: boolean;
}) {
  // 401: signed out. The shell owns that — it redirects. Show nothing here.
  if (error instanceof ApiError && error.isUnauthenticated) return null;

  /*
   * 403: "not yours". Two different refusals arrive with this status and both
   * are explain-only —
   *   - `perms.dashboard` is off for this staff member, or
   *   - `requireSameSalon` refused: "That salon is not yours."
   * Neither is fixed by pressing a button, so there is no button. The body is
   * the server's own copy, which names who can grant the permission.
   */
  if (error instanceof ApiError && error.isForbidden) {
    return <ErrorState title="You don't have access to the overview" body={error.message} />;
  }

  const offline = error instanceof ApiError && error.isConnectivity;
  return (
    <ErrorState
      title={offline ? 'No connection' : "Couldn't load the overview"}
      body={
        offline
          ? "We can't reach the workspace. Nothing is lost — try again once you're back online."
          : 'Something went wrong on our side. Nothing has changed in your salon.'
      }
      onRetry={onRetry}
      retrying={retrying}
    />
  );
}
