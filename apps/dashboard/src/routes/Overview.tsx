import { fils, type Transaction } from '@avo/types';
import { Card, EmptyState, ErrorState, Money, Skeleton, StatCard, StaleBanner } from '@avo/ui';
import { ApiError } from '../api/client.js';
import { useRecentActivity, useSalonMetrics, type SalonMetrics } from '../api/salon.js';

/**
 * Merchant → Overview.
 *
 * NO COURTESY PERMISSION GATE, DELIBERATELY. `GET /salons/{id}/metrics` is
 * `requireDashboardPerm(req, 'dashboard')` server-side, so the refusal arrives on
 * its own and `SectionError` explains it. A client check here would duplicate the
 * server and drift from it. The ledger in sectionState.tsx records why — on
 * Settings the same absence WAS an oversight, and nothing distinguished the two.
 *
 * `GET /charges` behind the activity feed is `requireScannerPerm(req, 'charges')`
 * — a SCANNER-scope guard, not a dashboard one. No web principal satisfies it
 * whatever permissions she holds, so that refusal is the contract rather than a
 * permission anyone can grant.
 */
export function Overview() {
  // No salon id here at all. Both hooks read it from the session.
  const metrics = useSalonMetrics();
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

  return (
    <>
      {showStale ? (
        <StaleBanner
          updatedAt={metrics.dataUpdatedAt}
          onRetry={() => void metrics.refetch()}
          retrying={metrics.isFetching}
        />
      ) : null}

      <KpiRow metrics={metrics.data} loading={metrics.isPending} />

      <div className="overview__grid">
        <Card className="overview__activity" flush>
          <h2 className="overview__card-title">Recent activity</h2>
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
        The design shows "+4 pts vs last month" under Repeat rate and "next at
        4:30 PM" under Upcoming. Neither figure exists on
        GET /salons/{id}/metrics, so neither is rendered. Flagged, not invented.
      */}
      <StatCard label="Repeat rate" value={`${metrics.repeatRatePercent}%`} />
      <StatCard label="Upcoming today" value={String(metrics.upcomingAppointments)} />
    </div>
  );
}

/* ------------------------------------------------------------- activity feed */

interface ActivityListProps {
  items: Transaction[] | undefined;
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

  if (error) {
    // 401 — the session is gone and the shell is already redirecting to
    // sign-in. Rendering a refusal here would flash for one frame and tell the
    // merchant she lacks a permission she actually holds.
    if (error instanceof ApiError && error.isUnauthenticated) return null;

    return (
      <div className="overview__feed-state">
        {error instanceof ApiError && error.isForbidden ? (
          /*
           * 403 — explain, no retry (interaction-spec.md §4). `perms.charges` is
           * the senior permission that gates this feed; the API's message names
           * who can grant it, so it is rendered rather than paraphrased.
           */
          <ErrorState title="You don't have access to this" body={error.message} />
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
    return (
      <div className="overview__feed-state">
        <EmptyState
          title="No activity yet"
          body="Charges, top-ups and deposit returns appear here as your team serves customers today."
        />
      </div>
    );
  }

  return (
    <ul className="overview__feed">
      {items.map((item) => (
        <li key={item.id} className="overview__feed-item">
          <span className="overview__feed-dot" aria-hidden="true" />
          <span className="overview__feed-body">
            <span className="overview__feed-text">
              <b>{describeKind(item.kind)}</b> <Money amount={fils(Math.abs(item.amountFils))} withUnit />
              {' · '}
              {item.reference}
            </span>
            <span className="overview__feed-when">{timeLabel(item.createdAt)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function describeKind(kind: Transaction['kind']): string {
  switch (kind) {
    case 'topup':
      return 'Topped up';
    case 'charge':
      return 'Paid';
    case 'deposit_hold':
      return 'Deposit held';
    case 'deposit_return':
      return 'Deposit returned';
    case 'shop':
      return 'Bought';
    case 'adjustment':
      return 'Adjusted';
    default:
      return 'Activity';
  }
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
