import { fils, type Transaction } from '@avo/types';
import { Card, EmptyState, ErrorState, Money, Skeleton, StatCard, StaleBanner } from '@avo/ui';
import { ApiError } from '../api/client.js';
import { useRecentActivity, useSalonMetrics, type SalonMetrics } from '../api/salon.js';
import { useSession } from '../auth/AuthProvider.js';
import { FALLBACK_SALON_ID } from '../config.js';

export function Overview() {
  const session = useSession('merchant');
  const salonId = session.salonId ?? FALLBACK_SALON_ID;
  const metrics = useSalonMetrics(salonId, session.token);
  const activity = useRecentActivity(salonId, session.token);

  // Stale-not-blank: cached figures outrank a failed refresh.
  const showStale = metrics.isError && metrics.data !== undefined;

  if (metrics.isError && metrics.data === undefined) {
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
    const denied = error instanceof ApiError && error.isDenied;
    return (
      <div className="overview__feed-state">
        {denied ? (
          // "You can't do that" explains; it does not offer a retry.
          <ErrorState
            title="You don't have access to this"
            body={
              error instanceof ApiError
                ? error.message
                : 'A manager can grant you permission to see salon activity.'
            }
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
  if (error instanceof ApiError && error.isDenied) {
    return (
      <ErrorState
        title="You don't have access to the overview"
        body={error.message || 'A manager can grant you the dashboard permission.'}
      />
    );
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
