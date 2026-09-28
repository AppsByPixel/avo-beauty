import { useState, type ReactNode } from 'react';
import { fils, formatMoney, subtract, type OverviewAnalytics } from '@avo/types';
import { Card, EmptyState, ErrorState, Money, Segmented, Skeleton, StaleBanner } from '@avo/ui';
import { ApiError } from '../api/client.js';
import { ANALYTICS_PERIOD, useOverviewAnalytics } from '../api/analytics.js';
import { useReport, windowLabel, windowPhrase, type Report } from '../api/reports.js';
import { useSalon } from '../api/salon.js';
import { useBranchScope } from '../shell/BranchScope.js';
import { AppointmentLink } from './AppointmentLink.js';
import { appointmentHref } from './appointmentHref.js';
import { whenLabel } from './appointmentWhen.js';
import { clockFrame, dayMonth } from './salonTime.js';
import {
  PERMISSION_SECTION,
  SALON_WIDE_REASON,
  WEEKDAY_LONG,
  WEEKDAY_SHORT,
  barWidth,
  busiestOf,
  doubtNote,
  formatBp,
  heatGrid,
  hourLabel,
  isWithheld,
  joinClauses,
  peakOf,
  plural,
  weekLabel,
  type WithheldBlock,
} from './overviewAnalyticsRules.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MERCHANT → OVERVIEW → ANALYTICS. NEW WORK; THE DESIGN BUNDLE DRAWS NONE OF IT.
 * ═══════════════════════════════════════════════════════════════════════════
 * Aftab, 2026-09-29: "dashboard has only one graph widget and it looks so empty
 * otherwise. Fill it with various useful visuals and analytics (at least 10)".
 * Thirteen cards with every module and permission on; fewer without, because a
 * card is only drawn for what this salon runs.
 *
 * TWO READS, NOT THIRTEEN.
 *   `GET /v1/salons/{id}/overview/analytics` — twelve blocks, `perms.dashboard`,
 *       each `ok` or `withheld` with a reason (`api/analytics.ts`).
 *   `GET /salons/{id}/reports/earnings-by-branch` — revenue by branch, which the
 *       analytics endpoint deliberately does not duplicate
 *       (`services/overviewAnalytics.ts § WHAT IS NOT HERE`). Same `?branch=`
 *       and the same `30d` window, so the two agree about what they cover.
 * Each card still owns its own presentation state: skeleton while the read is
 * pending, its own error with its own retry, its own empty — so the thirteen do
 * not collapse into one spinner, and one card's empty never reads as another's.
 *
 * NO CHART LIBRARY — `SalesTrend.tsx`' decision, applied again. Bars are DOM
 * elements with integer-permille widths, the heatmap is a `<table>`, and every
 * figure a bar encodes is also printed beside it or read out to a screen reader,
 * so no chart is the only place a number lives.
 *
 * COLOUR: bars and heat are `--avo-brand` family surfaces with no text on them
 * (#9); tier bars use the `--avo-tier-*-dot` tokens, which is what they are for.
 *
 * THE FOUR WITHHELD ANSWERS, AND WHICH WAY EACH GOES:
 *   `permission`     THE CARD STAYS, with one quiet line — "You don't have
 *                    access to appointments." Omitting it was the other option
 *                    and was rejected: a card that vanishes for one staff
 *                    member and not another reads as a figure that does not
 *                    exist, which is `Reports.tsx`' argument about a refused card.
 *   `module_off`     THE CARD IS NOT DRAWN. A salon that does not sell through
 *                    AVO has no shop to report on; a card saying so is noise.
 *   `not_per_branch` THE CARD STAYS and says the figure is salon-wide only, why,
 *                    and how to see it — the KPI row's "Loaded today" treatment.
 *   booking off      Not a server reason — `modules.booking` rides the payload —
 *                    but the same answer as `module_off`: the four booking cards
 *                    are not drawn, because "no bookings this month" at a salon
 *                    that takes none is the other empty's copy.
 */

/* ------------------------------------------------------------ query states -- */

export interface ReadState<T> {
  data: T | undefined;
  pending: boolean;
  error: unknown;
  onRetry: () => void;
  retrying: boolean;
}

/** The host: two hooks, then everything below is a function of their answers. */
export function AnalyticsSection() {
  const { selected } = useBranchScope();
  const salon = useSalon();
  const analytics = useOverviewAnalytics(selected);
  const earnings = useReport('earnings-by-branch', {
    branch: selected,
    period: ANALYTICS_PERIOD,
    compare: null,
  });

  return (
    <AnalyticsGrid
      analytics={{
        data: analytics.data,
        pending: analytics.isPending,
        error: analytics.isError ? analytics.error : null,
        onRetry: () => void analytics.refetch(),
        retrying: analytics.isFetching,
      }}
      earnings={{
        data: earnings.data,
        pending: earnings.isPending,
        error: earnings.isError ? earnings.error : null,
        onRetry: () => void earnings.refetch(),
        retrying: earnings.isFetching,
      }}
      timezone={salon.data?.timezone ?? null}
      modulesHint={salon.data?.modules ?? null}
      updatedAt={analytics.dataUpdatedAt}
    />
  );
}

/** A refusal: never kept on screen behind a retry. `Overview.tsx § STALE-NOT-BLANK`. */
function forbiddenError(error: unknown): boolean {
  return error instanceof ApiError && error.isForbidden;
}

/**
 * Everything the grid draws, as a function of the two reads. Exported so
 * `overviewAnalyticsRender.test.tsx` can drive it with fixtures parsed through
 * `OverviewAnalyticsSchema` — no query client, no session.
 */
export function AnalyticsGrid({
  analytics,
  earnings,
  timezone,
  modulesHint,
  updatedAt = Date.now(),
}: {
  analytics: ReadState<OverviewAnalytics>;
  earnings: ReadState<Report>;
  timezone: string | null;
  /** The salon's modules, for the pending paint — before the payload says. */
  modulesHint: { booking: boolean; shop: boolean } | null;
  updatedAt?: number;
}) {
  const data = analytics.data;
  /*
   * STALE-NOT-BLANK (§4): a refetch that failed keeps the cards it has and says
   * so once, above them. A REFUSAL IS EXCLUDED — the Overview's rule.
   */
  const stale = analytics.error !== null && data !== undefined && !forbiddenError(analytics.error);
  const failed = analytics.error !== null && (data === undefined || forbiddenError(analytics.error));
  const shown = failed ? undefined : data;

  const booking = shown?.modules.booking ?? modulesHint?.booking ?? true;
  const shop = shown?.modules.shop ?? modulesHint?.shop ?? true;

  const view: CardView = {
    pending: analytics.pending,
    failure: failed ? analytics.error : null,
    onRetry: analytics.onRetry,
    retrying: analytics.retrying,
  };

  const phrase = shown ? windowPhrase(shown.window) : 'in this period';

  return (
    <section className="ovw-section" aria-labelledby="ovw-heading">
      <div className="ovw-head">
        <h2 className="overview__card-title" id="ovw-heading">
          Analytics
        </h2>
        {shown ? (
          <span className="ovw-head__scope">
            {/* The SERVER'S echo, never the request — `Overview.tsx § appliedBranchOf`. */}
            {windowLabel(shown.window)} · {shown.branchName ?? 'All branches'}
          </span>
        ) : null}
      </div>

      {stale ? (
        <StaleBanner
          updatedAt={updatedAt}
          onRetry={analytics.onRetry}
          retrying={analytics.retrying}
        />
      ) : null}

      <div className="ovw-grid">
        <RevenueByBranchCard state={earnings} />
        {booking ? <TopServicesCard view={view} data={shown} phrase={phrase} /> : null}
        {booking ? <ArtistsCard view={view} data={shown} /> : null}
        <BusiestTimesCard view={view} data={shown} phrase={phrase} timezone={timezone} />
        {booking ? <UpcomingCard view={view} data={shown} timezone={timezone} /> : null}
        {booking ? <NoShowsCard view={view} data={shown} phrase={phrase} /> : null}
        <NewMembersCard view={view} data={shown} phrase={phrase} />
        <VisitorsCard view={view} data={shown} phrase={phrase} />
        <LoyaltyCard view={view} data={shown} />
        <WalletCard view={view} data={shown} phrase={phrase} />
        <PaymentMixCard view={view} data={shown} phrase={phrase} />
        {shop && !(shown && shown.shop.status === 'withheld' && shown.shop.reason === 'module_off') ? (
          <ShopCard view={view} data={shown} phrase={phrase} />
        ) : null}
        <CampaignsCard view={view} data={shown} phrase={phrase} timezone={timezone} />
      </div>
    </section>
  );
}

/* ------------------------------------------------------------ the shell ----- */

interface CardView {
  pending: boolean;
  /** The read's failure when there is nothing to draw. Null otherwise. */
  failure: unknown;
  onRetry: () => void;
  retrying: boolean;
}

/**
 * One card. The head is identical in every state — skeleton, error, withheld,
 * empty, loaded — so nothing moves when the answer lands.
 */
export function Widget({
  title,
  caption,
  wide = false,
  label,
  children,
}: {
  title: string;
  caption?: string | null;
  wide?: boolean;
  /** `data-widget`, for tests and for nobody else. */
  label: string;
  children: ReactNode;
}) {
  return (
    <Card className="ovw" flush data-widget={label} {...(wide ? { 'data-wide': 'true' } : {})}>
      <h3 className="overview__card-title">{title}</h3>
      {caption ? <p className="ovw__caption">{caption}</p> : null}
      <div className="ovw__body">{children}</div>
    </Card>
  );
}

/** Pending: bars of no particular length, so no skeleton claims a figure. */
export function WidgetSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="ovw__skeleton" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} width="100%" height={14} />
      ))}
    </div>
  );
}

/**
 * THE READ FAILED AND THERE IS NOTHING TO DRAW. Three answers, the house's
 * three: a refusal explains with no retry, offline says so, anything else is
 * "we failed" with Try again. "Your figures above are unaffected" is the load-
 * bearing clause, borrowed from the activity feed: the KPI tiles are a separate
 * read and did not fail with this one.
 */
export function WidgetError({
  error,
  onRetry,
  retrying,
}: {
  error: unknown;
  onRetry: () => void;
  retrying: boolean;
}) {
  const api = error instanceof ApiError ? error : null;
  if (api?.isUnauthenticated) return null;
  if (api?.isForbidden) {
    return <ErrorState title="You don't have access to this" body={api.message} />;
  }
  const offline = api?.isConnectivity ?? false;
  return (
    <ErrorState
      title={offline ? 'No connection' : "Couldn't load this"}
      body={
        offline
          ? "We can't reach the workspace. Your figures above are the last we loaded."
          : "The workspace didn't answer. Your figures above are unaffected."
      }
      onRetry={onRetry}
      retrying={retrying}
    />
  );
}

/**
 * A WITHHELD BLOCK. `module_off` never reaches here — the grid does not draw
 * that card at all. The other two keep the card and say which it is.
 */
export function WithheldNote({
  block,
  salonWideReason,
}: {
  block: WithheldBlock;
  salonWideReason?: string;
}) {
  if (block.reason === 'permission') {
    const section = PERMISSION_SECTION[block.permission ?? ''] ?? 'this section';
    return <p className="ovw__quiet">You don&rsquo;t have access to {section}.</p>;
  }
  if (block.reason === 'not_per_branch') {
    return (
      <p className="ovw__quiet">
        <b>Salon-wide only.</b> {salonWideReason ?? 'This figure has no per-branch answer'}.
        Choose All branches to see it.
      </p>
    );
  }
  return null;
}

/** "Branch assumed on 2 of 9 visits — …", or nothing. */
function Doubt({ doubt, noun }: { doubt: { assumed: number; total: number } | null; noun: string }) {
  const note = doubtNote(doubt, noun);
  return note === null ? null : (
    <p className="ovw__note" role="status">
      {note}
    </p>
  );
}

/**
 * The four states every analytics card shares, then `render` for the loaded one.
 * Keeps each card below down to what it actually draws.
 */
function body<K extends keyof OverviewAnalytics>(
  view: CardView,
  data: OverviewAnalytics | undefined,
  key: K,
  render: (block: Exclude<OverviewAnalytics[K], WithheldBlock>, all: OverviewAnalytics) => ReactNode,
  options: { rows?: number; salonWideReason?: string } = {},
): ReactNode {
  if (view.pending) return <WidgetSkeleton {...(options.rows ? { rows: options.rows } : {})} />;
  if (view.failure !== null || data === undefined) {
    return <WidgetError error={view.failure} onRetry={view.onRetry} retrying={view.retrying} />;
  }
  const block = data[key] as OverviewAnalytics[K] & { status: string };
  if (isWithheld(block)) {
    return (
      <WithheldNote
        block={block}
        {...(options.salonWideReason ? { salonWideReason: options.salonWideReason } : {})}
      />
    );
  }
  return render(block as Exclude<OverviewAnalytics[K], WithheldBlock>, data);
}

/**
 * A HORIZONTAL BAR LIST. Name, bar, figure; and one sentence per row for a
 * screen reader, because the bar is `aria-hidden` and the visible figure alone
 * does not say what it is a figure of.
 */
function BarList({
  rows,
}: {
  rows: ReadonlyArray<{ key: string; name: string; value: number; figure: ReactNode; spoken: string; tone?: string }>;
}) {
  const peak = peakOf(rows.map((r) => r.value));
  return (
    <ul className="ovw-bars">
      {rows.map((r) => (
        <li key={r.key} className="ovw-bars__row">
          <span className="ovw-bars__name" aria-hidden="true">
            {r.name}
          </span>
          <span className="ovw-bars__track" aria-hidden="true">
            <span
              className="ovw-bars__bar"
              style={{ width: barWidth(r.value, peak) }}
              {...(r.tone ? { 'data-tone': r.tone } : {})}
              {...(r.value === 0 ? { 'data-zero': 'true' } : {})}
            />
          </span>
          <span className="ovw-bars__figure" aria-hidden="true">
            {r.figure}
          </span>
          <span className="avo-sr-only">{r.spoken}</span>
        </li>
      ))}
    </ul>
  );
}

const kd = (value: number) => <Money amount={fils(value)} withUnit />;
/** The same figure as a sentence for a screen reader — `formatMoney`, the display boundary. */
const kdText = (value: number) => formatMoney(fils(value));

/* ================================================ 1. revenue by branch ==== */

/**
 * `earnings-by-branch`, drawn as bars. Its own read, so its own four states.
 *
 * THE CAVEAT IS THE REPORT'S, SHORTENED TO ITS FIRST SENTENCE. `Reports.tsx §
 * BranchAssumedCaveat` prints "Branch assumed on {branches} — treat these branch
 * figures as approximate." and two more paragraphs; the card carries the first,
 * in the same words, and the ordering warning is why the bars are not called a
 * ranking anywhere on it.
 */
export function RevenueByBranchCard({ state }: { state: ReadState<Report> }) {
  const report = state.data;
  const failed = state.error !== null && (report === undefined || forbiddenError(state.error));
  return (
    <Widget
      title="Revenue by branch"
      label="revenue-by-branch"
      caption={report && !failed ? windowLabel(report.window) : null}
    >
      {state.pending ? (
        <WidgetSkeleton rows={2} />
      ) : failed || report === undefined ? (
        <WidgetError error={state.error} onRetry={state.onRetry} retrying={state.retrying} />
      ) : report.stat.value === 0 ? (
        <EmptyState
          title={`No revenue ${windowPhrase(report.window)}`}
          body="Branches fill in as your team charges customers on the salon phone."
        />
      ) : (
        <>
          <BarList
            rows={report.rows.map((row) => {
              const name = String(row['branch'] ?? '');
              const gross = typeof row['grossFils'] === 'number' ? row['grossFils'] : 0;
              const txns = typeof row['transactions'] === 'number' ? row['transactions'] : 0;
              return {
                key: name,
                name,
                value: gross,
                figure: kd(gross),
                spoken: `${name}: ${kdText(gross)} from ${plural(txns, 'transaction', 'transactions')}`,
              };
            })}
          />
          <BranchDoubt report={report} />
        </>
      )}
    </Widget>
  );
}

function BranchDoubt({ report }: { report: Report }) {
  const names = report.rows
    .filter((row) => typeof row['assumedGrossFils'] === 'number' && row['assumedGrossFils'] > 0)
    .map((row) => String(row['branch'] ?? ''))
    .filter((n) => n !== '');
  if (names.length === 0) return null;
  return (
    <p className="ovw__note" role="status">
      Branch assumed on {joinClauses(names)} — treat these branch figures as approximate.
    </p>
  );
}

/* =================================================== 2. top services ===== */

type ServiceSort = 'bookings' | 'revenue';

export function TopServicesCard({
  view,
  data,
  phrase,
}: {
  view: CardView;
  data: OverviewAnalytics | undefined;
  phrase: string;
}) {
  const [sort, setSort] = useState<ServiceSort>('bookings');
  return (
    <Widget title="Top services" label="top-services">
      {body(view, data, 'topServices', (block) => {
        const list = sort === 'bookings' ? block.byBookings : block.byRevenue;
        if (block.byBookings.length === 0) {
          return (
            <EmptyState
              title={`No booked services ${phrase}`}
              body="Services rank here as customers book them in the app or at the front desk."
            />
          );
        }
        return (
          <>
            <div className="ovw__control">
              <Segmented<ServiceSort>
                label="Rank top services by"
                value={sort}
                onChange={setSort}
                options={[
                  { value: 'bookings', label: 'Bookings' },
                  { value: 'revenue', label: 'Revenue' },
                ]}
              />
            </div>
            <BarList
              rows={list.map((s) => ({
                key: s.serviceId,
                name: s.name,
                value: sort === 'bookings' ? s.bookings : s.revenueFils,
                figure: sort === 'bookings' ? plural(s.bookings, 'booking', 'bookings') : kd(s.revenueFils),
                spoken: `${s.name}: ${plural(s.bookings, 'booking', 'bookings')}, ${kdText(s.revenueFils)}`,
              }))}
            />
            <p className="ovw__note">
              Booked services only — a walk-in charge isn&rsquo;t broken down by service.
            </p>
            <Doubt doubt={block.branchAssumed} noun="bookings" />
          </>
        );
      })}
    </Widget>
  );
}

/* ================================================ 3. artist performance == */

export function ArtistsCard({ view, data }: { view: CardView; data: OverviewAnalytics | undefined }) {
  return (
    <Widget title="Artist performance" label="artists">
      {body(view, data, 'artists', (block, all) =>
        block.items.length === 0 ? (
          <EmptyState
            title="No artists yet"
            body="Artists appear here once they're added under Team."
          />
        ) : (
          <>
            {/* A TABLE IS ITS OWN TEXT ALTERNATIVE — three figures per person read as a row. */}
            <div className="ovw-table">
              <table>
                <caption className="avo-sr-only">
                  Bookings, no-shows and revenue by artist, {windowPhrase(all.window)}.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Artist</th>
                    <th scope="col" data-numeric="true">Bookings</th>
                    <th scope="col" data-numeric="true">No-shows</th>
                    <th scope="col" data-numeric="true">Revenue KD</th>
                  </tr>
                </thead>
                <tbody>
                  {block.items.map((a) => (
                    <tr key={a.artistId}>
                      <th scope="row">{a.name}</th>
                      <td data-numeric="true">{a.bookings}</td>
                      <td data-numeric="true">{a.noShows}</td>
                      <td data-numeric="true">
                        <Money amount={fils(a.revenueFils)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Doubt doubt={block.branchAssumed} noun="bookings" />
          </>
        ),
      )}
    </Widget>
  );
}

/* ================================================== 4. busiest times ===== */

/**
 * WEEKDAY × HOUR, IN THE SALON'S CLOCK — which the SERVER already applied, so
 * this card places cells and converts nothing (`overviewAnalyticsRules.ts §
 * heatGrid`). The caption names the zone so a manager reading from abroad knows
 * whose 17:00 the column is.
 *
 * A `<table>`, so the grid IS its own text alternative: row headers are days,
 * column headers are hours, each cell's visit count is read out. The colour is
 * a second encoding of a number a screen reader already has.
 */
export function BusiestTimesCard({
  view,
  data,
  phrase,
  timezone,
}: {
  view: CardView;
  data: OverviewAnalytics | undefined;
  phrase: string;
  timezone: string | null;
}) {
  const zone = data?.window.timezone ?? clockFrame(timezone).zone;
  return (
    <Widget
      title="Busiest times"
      label="busiest-times"
      wide
      caption={`Visits by day and hour, in the salon's time (${zone})`}
    >
      {body(
        view,
        data,
        'busiestTimes',
        (block) => {
          if (block.totalVisits === 0 || block.cells.length === 0) {
            return (
              <EmptyState
                title={`No visits ${phrase}`}
                body="The grid fills in as customers are charged on the salon phone."
              />
            );
          }
          const grid = heatGrid(block.cells);
          const top = busiestOf(block.cells);
          return (
            <>
              {top ? (
                <p className="ovw__lead">
                  Busiest: {WEEKDAY_LONG[top.weekday]} at {hourLabel(top.hour)} ·{' '}
                  {plural(top.visits, 'visit', 'visits')}
                </p>
              ) : null}
              <div className="ovw-heat">
                <table>
                  <caption className="avo-sr-only">
                    Visits by weekday and hour in {zone}, {phrase}. {plural(block.totalVisits, 'visit', 'visits')} in all.
                  </caption>
                  <thead>
                    <tr>
                      <td />
                      {grid.hours.map((h) => (
                        <th key={h} scope="col">
                          <span aria-hidden="true">{h % 3 === 0 ? String(h) : ''}</span>
                          <span className="avo-sr-only">{hourLabel(h)}</span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {grid.rows.map((row) => (
                      <tr key={row.weekday}>
                        <th scope="row">
                          <span aria-hidden="true">{WEEKDAY_SHORT[row.weekday]}</span>
                          <span className="avo-sr-only">{WEEKDAY_LONG[row.weekday]}</span>
                        </th>
                        {row.cells.map((c) => (
                          <td key={c.hour} data-level={c.level}>
                            <span className="avo-sr-only">{plural(c.visits, 'visit', 'visits')}</span>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="ovw-heat__legend" aria-hidden="true">
                Fewer
                {[1, 2, 3, 4].map((l) => (
                  <span key={l} className="ovw-heat__swatch" data-level={l} />
                ))}
                More
              </div>
              <Doubt doubt={block.branchAssumed} noun="visits" />
            </>
          );
        },
        { rows: 7 },
      )}
    </Widget>
  );
}

/* ======================================================= 5. upcoming ====== */

/**
 * NOT THE PERIOD: today and the next seven salon days, whatever window the grid
 * is on — the KPI tile's "Upcoming today" rule. The counts are the Overview's
 * (`dashboard`); the NAMED next five need `appointments`, and without it the
 * card keeps its counts and says why the list is absent.
 *
 * EACH ROW LINKS TO THE BOOKING on Appointments — `appointmentHref.ts`: the
 * board opens filtered to that salon day and marks the row.
 */
export function UpcomingCard({
  view,
  data,
  timezone,
}: {
  view: CardView;
  data: OverviewAnalytics | undefined;
  timezone: string | null;
}) {
  return (
    <Widget title="Upcoming" label="upcoming" caption="Today and the next 7 days, in the salon's clock">
      {body(view, data, 'upcoming', (block) => (
        <>
          <div className="ovw-figures">
            <Figure label="Today" value={String(block.today)} />
            <Figure label="Next 7 days" value={String(block.next7Days)} />
          </div>
          {isWithheld(block.next) ? (
            <p className="ovw__quiet">
              You don&rsquo;t have access to appointments, so the next bookings aren&rsquo;t listed.
            </p>
          ) : block.next.items.length === 0 ? (
            <EmptyState
              title="Nothing booked ahead"
              body="Bookings from the app and the front desk appear here as they're made."
            />
          ) : (
            <ul className="ovw-list">
              {block.next.items.map((b) => (
                <li key={b.bookingId} className="ovw-list__row">
                  <AppointmentLink
                    className="ovw-list__link"
                    href={appointmentHref(b.bookingId, b.startsAt, timezone)}
                  >
                    <span className="ovw-list__main">
                      <b>{b.customerName}</b> · {b.serviceName}
                    </span>
                    <span className="ovw-list__sub">
                      {whenLabel(b.startsAt, timezone)} · {b.artistName} · {b.branchName}
                      {b.branchAssumed ? ' (branch assumed)' : ''}
                    </span>
                  </AppointmentLink>
                </li>
              ))}
            </ul>
          )}
          <Doubt doubt={block.branchAssumed} noun="appointments" />
        </>
      ))}
    </Widget>
  );
}

function Figure({ label, value, note }: { label: string; value: ReactNode; note?: string }) {
  return (
    <div className="ovw-figure">
      <span className="ovw-figure__label">{label}</span>
      <span className="ovw-figure__value">{value}</span>
      {note ? <span className="ovw-figure__note">{note}</span> : null}
    </div>
  );
}

/* ============================================ 6. no-shows and deposits ==== */

export function NoShowsCard({
  view,
  data,
  phrase,
}: {
  view: CardView;
  data: OverviewAnalytics | undefined;
  phrase: string;
}) {
  return (
    <Widget title="No-shows and deposits" label="no-shows">
      {body(view, data, 'noShows', (block) => {
        const resolved = block.completed + block.noShows;
        return (
          <>
            <div className="ovw-figures">
              {/*
                NULL IS "NOTHING WAS RESOLVED", NOT 0%. The server refuses to call
                zero appointments a perfect record, and so does this tile.
              */}
              <Figure
                label="No-show rate"
                value={block.rateBp === null ? '—' : formatBp(block.rateBp)}
                note={
                  block.rateBp === null
                    ? `No appointments were resolved ${phrase}`
                    : `${block.noShows} of ${plural(resolved, 'resolved appointment', 'resolved appointments')}`
                }
              />
              <Figure
                label="Deposits held now"
                value={kd(block.depositsHeld.fils)}
                note={`On ${plural(block.depositsHeld.bookings, 'booking', 'bookings')}`}
              />
            </div>
            <Doubt doubt={block.branchAssumed} noun="appointments" />
          </>
        );
      })}
    </Widget>
  );
}

/* ================================================== 7. new members ======== */

export function NewMembersCard({
  view,
  data,
  phrase,
}: {
  view: CardView;
  data: OverviewAnalytics | undefined;
  phrase: string;
}) {
  return (
    <Widget title="New members" label="new-members">
      {body(
        view,
        data,
        'newMembers',
        (block) => {
          if (block.total === 0) {
            return (
              <EmptyState
                title={`No new members ${phrase}`}
                body="Customers are counted here the day they register — at the till or in the AVO app."
              />
            );
          }
          const peak = peakOf(block.weeks.map((w) => w.count));
          const anyPartial = block.weeks.some((w) => w.partial);
          return (
            <>
              <p className="ovw__lead">{plural(block.total, 'customer joined', 'customers joined')}</p>
              <ul className="ovw-cols">
                {block.weeks.map((w) => (
                  <li key={w.weekStart} className="ovw-cols__col">
                    <span className="ovw-cols__count" aria-hidden="true">
                      {w.count}
                    </span>
                    <span className="ovw-cols__track" aria-hidden="true">
                      <span
                        className="ovw-cols__bar"
                        style={{ height: barWidth(w.count, peak) }}
                        {...(w.partial ? { 'data-partial': 'true' } : {})}
                        {...(w.count === 0 ? { 'data-zero': 'true' } : {})}
                      />
                    </span>
                    <span className="ovw-cols__label" aria-hidden="true">
                      {weekLabel(w.weekStart)}
                    </span>
                    <span className="avo-sr-only">
                      Week of {weekLabel(w.weekStart)}: {plural(w.count, 'new member', 'new members')}
                      {w.partial ? ' (part week)' : ''}
                    </span>
                  </li>
                ))}
              </ul>
              {anyPartial ? (
                <p className="ovw__note">
                  Paler bars are part weeks — the period starts or ends partway through them.
                </p>
              ) : null}
            </>
          );
        },
        { salonWideReason: SALON_WIDE_REASON.newMembers },
      )}
    </Widget>
  );
}

/* ============================================ 8. first visit vs returning == */

export function VisitorsCard({
  view,
  data,
  phrase,
}: {
  view: CardView;
  data: OverviewAnalytics | undefined;
  phrase: string;
}) {
  return (
    <Widget title="First visit vs returning" label="visitors">
      {body(view, data, 'visitors', (block) => {
        if (block.total === 0) {
          return (
            <EmptyState
              title={`No visits ${phrase}`}
              body="Customers are counted here once they're charged on the salon phone."
            />
          );
        }
        return (
          <>
            <div className="ovw-split" aria-hidden="true">
              <span
                className="ovw-split__part"
                data-part="first"
                style={{ width: barWidth(block.firstVisit, block.total) }}
              />
              <span
                className="ovw-split__part"
                data-part="returning"
                style={{ width: barWidth(block.returning, block.total) }}
              />
            </div>
            <ul className="ovw-legend">
              <li>
                <span className="ovw-legend__key" data-part="first" aria-hidden="true" />
                First visit <b>{block.firstVisit}</b>
              </li>
              <li>
                <span className="ovw-legend__key" data-part="returning" aria-hidden="true" />
                Returning <b>{block.returning}</b>
              </li>
            </ul>
            <p className="ovw__note">
              {plural(block.total, 'customer', 'customers')} visited. Returning means she had
              visited this salon before, at any branch.
            </p>
            <Doubt doubt={block.branchAssumed} noun="visitors" />
          </>
        );
      })}
    </Widget>
  );
}

/* ====================================================== 9. loyalty ======== */

const TIER_TONES = new Set(['bronze', 'silver', 'gold', 'black']);

export function LoyaltyCard({ view, data }: { view: CardView; data: OverviewAnalytics | undefined }) {
  const stamps = data?.loyaltyMode === 'stamps';
  return (
    <Widget
      title={stamps ? 'Stamp progress' : 'Members by tier'}
      label="loyalty"
      caption="Current members, now"
    >
      {body(
        view,
        data,
        'loyalty',
        (block) => {
          if (block.mode === 'tiers') {
            const rows = [
              ...block.tiers.map((t) => ({ name: t.tier, members: t.members })),
              ...(block.untiered > 0 ? [{ name: 'No tier', members: block.untiered }] : []),
            ];
            if (rows.every((r) => r.members === 0)) {
              return (
                <EmptyState
                  title="No members yet"
                  body="Tiers fill in as customers register and visit."
                />
              );
            }
            return (
              <BarList
                rows={rows.map((r) => {
                  const tone = r.name.toLowerCase();
                  return {
                    key: r.name,
                    name: r.name,
                    value: r.members,
                    figure: String(r.members),
                    spoken: `${r.name}: ${plural(r.members, 'member', 'members')}`,
                    tone: TIER_TONES.has(tone) ? tone : 'member',
                  };
                })}
              />
            );
          }
          if (block.buckets.every((b) => b.members === 0)) {
            return (
              <EmptyState
                title="No members yet"
                body="The card fills in as customers register and collect stamps."
              />
            );
          }
          const peak = peakOf(block.buckets.map((b) => b.members));
          return (
            <>
              <ul className="ovw-cols">
                {block.buckets.map((b) => (
                  <li key={b.stamps} className="ovw-cols__col">
                    <span className="ovw-cols__count" aria-hidden="true">
                      {b.members}
                    </span>
                    <span className="ovw-cols__track" aria-hidden="true">
                      <span
                        className="ovw-cols__bar"
                        style={{ height: barWidth(b.members, peak) }}
                        {...(b.members === 0 ? { 'data-zero': 'true' } : {})}
                      />
                    </span>
                    <span className="ovw-cols__label" aria-hidden="true">
                      {b.stamps}
                    </span>
                    <span className="avo-sr-only">
                      {plural(b.stamps, 'stamp', 'stamps')}: {plural(b.members, 'member', 'members')}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="ovw__note">
                Members by stamps collected, out of {block.stampTarget}.
              </p>
            </>
          );
        },
        { salonWideReason: SALON_WIDE_REASON.loyalty },
      )}
    </Widget>
  );
}

/* ======================================================= 10. wallet ======= */

/**
 * LOADED IS THE CREDIT, BONUS INCLUDED — so "what customers paid" is a
 * SUBTRACTION OF TWO SERVED INTEGERS (`subtract` from `@avo/types`), never a
 * third figure and never a float. SPENT is gross over charges and shop orders.
 * The OUTSTANDING balance is now, not the period.
 */
export function WalletCard({
  view,
  data,
  phrase,
}: {
  view: CardView;
  data: OverviewAnalytics | undefined;
  phrase: string;
}) {
  return (
    <Widget title="Wallet loaded vs spent" label="wallet">
      {body(
        view,
        data,
        'wallet',
        (block) => {
          const paid = subtract(fils(block.loadedFils), fils(block.bonusFils));
          return (
            <>
              {block.loadedFils === 0 && block.spentFils === 0 ? (
                <p className="ovw__quiet">Nothing was loaded or spent {phrase}.</p>
              ) : (
                <BarList
                  rows={[
                    {
                      key: 'loaded',
                      name: 'Loaded',
                      value: block.loadedFils,
                      figure: kd(block.loadedFils),
                      spoken: `Loaded: ${kdText(block.loadedFils)} across ${plural(block.topups, 'top-up', 'top-ups')}`,
                    },
                    {
                      key: 'spent',
                      name: 'Spent',
                      value: block.spentFils,
                      figure: kd(block.spentFils),
                      spoken: `Spent: ${kdText(block.spentFils)}`,
                    },
                  ]}
                />
              )}
              {block.bonusFils > 0 ? (
                <p className="ovw__note">
                  Loaded includes <Money amount={fils(block.bonusFils)} withUnit /> of bonus, so
                  customers paid <Money amount={paid} withUnit />.
                </p>
              ) : null}
              <div className="ovw-figures">
                <Figure
                  label="Outstanding balance"
                  value={kd(block.liabilityFils)}
                  note="What customers can still spend, now"
                />
              </div>
            </>
          );
        },
        { salonWideReason: SALON_WIDE_REASON.wallet },
      )}
    </Widget>
  );
}

/* ================================================== 11. payment mix ======= */

/**
 * TWO VISUALS, AND NEVER ONE PIE. KNET, card and Apple Pay exist only on
 * TOP-UPS; every charge and every shop order is paid from the wallet. So "how
 * money came in" and "how it went out" are two different flows, and a share
 * across both would add incoming money to outgoing money
 * (`services/overviewAnalytics.ts § PAYMENT MIX`). Each gets its own figure.
 *
 * SHARES ARE BASIS POINTS FROM THE SERVER, divided by 100 only in `formatBp`.
 */
const METHOD_LABEL = { knet: 'KNET', card: 'Card', applepay: 'Apple Pay' } as const;

export function PaymentMixCard({
  view,
  data,
  phrase,
}: {
  view: CardView;
  data: OverviewAnalytics | undefined;
  phrase: string;
}) {
  return (
    <Widget title="Payment mix" label="payment-mix">
      {body(
        view,
        data,
        'paymentMix',
        (block) => {
          const methods = (['knet', 'card', 'applepay'] as const).map((m) => ({ m, ...block.topups[m] }));
          const loadedAny = methods.some((x) => x.fils > 0);
          return (
            <>
              <h4 className="ovw__sub">Top-ups by method</h4>
              {loadedAny ? (
                <BarList
                  rows={methods.map((x) => ({
                    key: x.m,
                    name: METHOD_LABEL[x.m],
                    value: x.fils,
                    figure: (
                      <>
                        {kd(x.fils)}
                        {x.shareBp !== null ? <span className="ovw-bars__share"> · {formatBp(x.shareBp)}</span> : null}
                      </>
                    ),
                    spoken: `${METHOD_LABEL[x.m]}: ${kdText(x.fils)} from ${plural(x.count, 'top-up', 'top-ups')}${
                      x.shareBp !== null ? `, ${formatBp(x.shareBp)} of top-up value` : ''
                    }`,
                  }))}
                />
              ) : (
                <p className="ovw__quiet">No top-ups {phrase}.</p>
              )}
              <h4 className="ovw__sub">Spent from wallets</h4>
              <div className="ovw-figures">
                <Figure
                  label={plural(block.walletSpend.count, 'payment', 'payments')}
                  value={kd(block.walletSpend.fils)}
                  note="Every charge and shop order is paid from the wallet, so spend has no method split"
                />
              </div>
            </>
          );
        },
        { salonWideReason: SALON_WIDE_REASON.paymentMix },
      )}
    </Widget>
  );
}

/* ========================================================= 12. shop ======= */

const ORDER_STATUS_LABEL = { preparing: 'Preparing', ready: 'Ready', closed: 'Closed' } as const;

export function ShopCard({
  view,
  data,
  phrase,
}: {
  view: CardView;
  data: OverviewAnalytics | undefined;
  phrase: string;
}) {
  return (
    <Widget title="Shop orders" label="shop">
      {body(view, data, 'shop', (block) => {
        if (block.orders === 0 && block.topProducts.length === 0) {
          return (
            <EmptyState
              title={`No shop orders ${phrase}`}
              body="Orders appear here as customers buy from your shop in the AVO app."
            />
          );
        }
        return (
          <>
            <div className="ovw-figures">
              {(['preparing', 'ready', 'closed'] as const).map((s) => (
                <Figure key={s} label={ORDER_STATUS_LABEL[s]} value={String(block.ordersByStatus[s])} />
              ))}
            </div>
            <p className="ovw__note">
              {plural(block.orders, 'order', 'orders')} placed, by where each stands now ·{' '}
              <Money amount={fils(block.revenueFils)} withUnit /> settled
            </p>
            {block.topProducts.length > 0 ? (
              <>
                <h4 className="ovw__sub">Top products</h4>
                <BarList
                  rows={block.topProducts.map((p) => ({
                    key: p.productId,
                    name: p.name,
                    value: p.units,
                    figure: (
                      <>
                        {plural(p.units, 'unit', 'units')} · {kd(p.revenueFils)}
                      </>
                    ),
                    spoken: `${p.name}: ${plural(p.units, 'unit', 'units')}, ${kdText(p.revenueFils)}`,
                  }))}
                />
              </>
            ) : null}
            <Doubt doubt={block.branchAssumed} noun="orders" />
          </>
        );
      })}
    </Widget>
  );
}

/* ====================================================== 13. campaigns ===== */

export const CAMPAIGNS_SHOWN = 5;

export function CampaignsCard({
  view,
  data,
  phrase,
  timezone,
}: {
  view: CardView;
  data: OverviewAnalytics | undefined;
  phrase: string;
  timezone: string | null;
}) {
  return (
    <Widget title="Campaigns" label="campaigns">
      {body(
        view,
        data,
        'campaigns',
        (block) => {
          if (block.sent === 0) {
            return (
              <EmptyState
                title={`No campaigns went out ${phrase}`}
                body="Campaigns you send from Marketing appear here once AVO approves and delivers them."
              />
            );
          }
          const frame = clockFrame(timezone);
          const more = block.items.length - CAMPAIGNS_SHOWN;
          return (
            <>
              <div className="ovw-figures">
                <Figure label="Sent" value={String(block.sent)} />
                <Figure label="Reached" value={String(block.reached)} note={`Of ${plural(block.reach, 'customer', 'customers')} targeted`} />
              </div>
              <ul className="ovw-list">
                {block.items.slice(0, CAMPAIGNS_SHOWN).map((c) => (
                  <li key={c.campaignId} className="ovw-list__row">
                    <span className="ovw-list__main">
                      <b>{c.title}</b>
                    </span>
                    <span className="ovw-list__sub">
                      {dayMonth(new Date(c.sentAt), frame)} · reached {c.reached} of {c.reach}
                    </span>
                  </li>
                ))}
              </ul>
              {more > 0 || block.truncated ? (
                <p className="ovw__note">
                  {block.truncated
                    ? `Showing the latest ${CAMPAIGNS_SHOWN}; more went out ${phrase}.`
                    : `And ${plural(more, 'more campaign', 'more campaigns')} ${phrase}.`}
                </p>
              ) : null}
              <p className="ovw__note">
                Opens aren&rsquo;t recorded, so reach is the measure here.
              </p>
            </>
          );
        },
        { salonWideReason: SALON_WIDE_REASON.campaigns },
      )}
    </Widget>
  );
}
