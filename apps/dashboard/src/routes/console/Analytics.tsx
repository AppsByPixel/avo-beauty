import {
  createContext,
  useContext,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { onlineManager } from '@tanstack/react-query';
import { fils, formatMoney } from '@avo/types';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  FilterBar,
  FilterSelect,
  IconButton,
  IconDownload,
  InfoBanner,
  InlineError,
  Money,
  Segmented,
  Skeleton,
  StaleBanner,
  StatCard,
} from '@avo/ui';
import { ApiError } from '../../api/client.js';
import {
  downloadPlatformAnalyticsCsv,
  usePlatformAnalytics,
  type PlatformAnalytics,
  type PlatformAnalyticsSection,
  type PlatformExportScope,
} from '../../api/platformAnalytics.js';
import { useAllPlatformSalons } from '../../api/platformSalons.js';
import { TEXT_PARAM, enumParam, useUrlFilters } from '../listFilters.js';
import { BarList, Figure, WidgetSkeleton, useMasonry } from '../OverviewAnalytics.js';
import { exportErrorMessage, exportLabel, useExportAction, useExportUi } from '../overviewExport.js';
import {
  WEEKDAY_LONG,
  WEEKDAY_SHORT,
  busiestOf,
  formatBp,
  heatGrid,
  hourLabel,
  peakOf,
  plural,
} from '../overviewAnalyticsRules.js';
import { SectionError, badRequestAnswer } from '../sectionState.js';
import {
  DEFAULT_HISTORY,
  HISTORY_WINDOWS,
  METHODS,
  METHOD_LABEL,
  ORDER_STATUSES,
  ORDER_STATUS_LABEL,
  PLANS,
  PLAN_LABEL,
  RANKED_VISIBLE,
  TIERS,
  TIER_LABEL,
  allZero,
  barPx,
  durationLabel,
  isWithheld,
  momentum,
  monthLong,
  monthOf,
  monthOptions,
  monthParam,
  monthShort,
  monthShortYear,
  monthsParam,
  rankLeaderboard,
  resolveAnalyticsSalon,
  salonOptions,
  selectedOf,
  sortValue,
  withheldCopy,
  withheldShort,
  type LeaderboardRow,
  type LeaderboardSort,
  type PlatformBlockKey,
} from './platformAnalyticsRules.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * OWNER CONSOLE → ANALYTICS — "How AVO is performing across every salon".
 * ═══════════════════════════════════════════════════════════════════════════
 * Aftab, 2026-10-05: "The way we added so much graphs and valuable analytics for
 * the merchant dashboard, we need to do similar for the admin console."
 *
 * `AVO Owner Console.dc.html:98` § ANALYTICS draws four KPI tiles, an eight-month
 * bar chart ("Wallet loaded across platform") and a top-five salon list. All
 * three are kept, in the design's own idiom — the tiles are `StatCard`, the bar
 * chart is `.analytics__bars` (`MonthBars` below, now used for every monthly
 * series), and the ranked list is `.analytics__toprow` (`RankedList`). What is
 * NEW is extended from the merchant Overview's analytics grid rather than
 * invented: the masonry (`useMasonry`), the card shell (`.ovw`), bar lists,
 * figures, the weekday × hour heat map and the per-card Export, all imported
 * from `OverviewAnalytics.tsx` / `overviewExport.tsx` / `overviewAnalyticsRules.ts`.
 *
 * ONE READ. `GET /v1/platform/analytics` (`api/platformAnalytics.ts`), eleven
 * blocks, each `ok` or `withheld`. One card per block, in the payload's order.
 *
 * THE FILTERS ARE THE URL — `?salon=`, `?month=`, `?months=` (`listFilters.ts`),
 * so Back undoes a filter and a link shares a view. The scope written over the
 * cards is the SERVER'S ECHO (`month`, `months`, `salonName`), never the
 * request, and the export files are scoped by the same echo.
 *
 * TWO RULES FROM THE PAGE THIS REPLACES, KEPT:
 *
 *   "Salons", NOT "Salons live". `salon` has no active/suspended column, so the
 *   tile counts every salon and says so. (The salons card does say ACTIVE, which
 *   the server defines — a settled transaction in the month — and the card says
 *   that definition in words.)
 *
 *   MONEY IS NEVER ABBREVIATED. The design's tiles read "214.3k KD" via its own
 *   `fmtK`; that is a second money formatter with its own rounding, and on AVO's
 *   revenue tile it hides up to 50 KD. Every figure is `<Money>` / `formatMoney`
 *   over integer fils (#1), and every money skeleton is a bar — never `0.000`
 *   while pending (interaction-spec.md §4).
 *
 * WITHHELD IS NEVER ZERO. A block withheld for a section (`campaigns` without
 * Approvals, `support` without Policies) keeps its card and says which section;
 * a block withheld as `module_off` (bookings or shop at a salon that does not run
 * them) keeps its card and says that salon does not run it. Neither draws a
 * number, and neither offers an Export.
 *
 * NO CHART LIBRARY — `SalesTrend.tsx`' decision. Bars are DOM elements with
 * integer heights; the heat map is a `<table>`; every figure a bar encodes is
 * printed beside it or read out to a screen reader.
 */

/* ------------------------------------------------------------- the host --- */

const ANALYTICS_FILTERS = {
  salon: TEXT_PARAM,
  month: TEXT_PARAM,
  months: enumParam(HISTORY_WINDOWS),
} as const;

export function Analytics() {
  const url = useUrlFilters(ANALYTICS_FILTERS);
  const salonList = useAllPlatformSalons();
  const salon = resolveAnalyticsSalon(url.values.salon, salonList);

  /*
   * THE CURRENT MONTH, IN THE SERVER'S ZONE ONCE IT HAS SAID WHICH
   * (`platformAnalyticsRules.ts § monthOf`). A ref, because the zone is needed to
   * build the request the answer comes back on.
   */
  const zone = useRef<string | null>(null);
  const current = monthOf(new Date(), zone.current);
  const month = monthParam(url.values.month, current);
  const months = monthsParam(url.values.months);

  const query = usePlatformAnalytics({ month, months, salon: salon.salonId }, !salon.waiting);
  if (query.data) zone.current = query.data.timezone;

  const online = useSyncExternalStore(
    (notify) => onlineManager.subscribe(notify),
    () => onlineManager.isOnline(),
    () => true,
  );

  const data = query.data;
  const options = salonOptions(salonList.salons, data);
  const salonCount =
    data && data.leaderboard.status === 'ok' ? plural(data.leaderboard.rows.length, 'salon', 'salons') : null;

  return (
    <div className="analytics">
      <InfoBanner icon={<PulseGlyph />}>
        Every month here is a calendar month in Kuwait time. AVO revenue is the commission actually
        recorded on settled top-ups, not a rate applied to volume.
      </InfoBanner>

      <FilterBar
        label="Filter analytics"
        count={query.isPending ? null : salonCount}
        onClear={url.active ? () => url.clear() : undefined}
      >
        <FilterSelect
          label="Salon"
          value={salon.salonId ?? ''}
          onChange={(next) => url.set({ salon: next })}
          options={[{ value: '', label: 'All salons' }, ...options]}
        />
        <FilterSelect
          label="Month"
          value={month ?? current}
          onChange={(next) => url.set({ month: next === current ? '' : next })}
          options={monthOptions(current).map((m) => ({
            value: m,
            label: m === current ? `${monthLong(m)} (so far)` : monthLong(m),
          }))}
        />
        <FilterSelect
          label="History"
          value={months === null ? DEFAULT_HISTORY : String(months)}
          onChange={(next) => url.set({ months: next === DEFAULT_HISTORY ? '' : next })}
          options={HISTORY_WINDOWS.map((w) => ({ value: w, label: `Last ${w} months` }))}
        />
      </FilterBar>

      <PlatformAnalyticsGrid
        read={{
          data,
          pending: query.isPending,
          error: query.isError ? query.error : null,
          onRetry: () => void query.refetch(),
          retrying: query.isFetching,
        }}
        updatedAt={query.dataUpdatedAt}
        exporter={platformAnalyticsExporter(!online)}
      />
    </div>
  );
}

/* ----------------------------------------------------------- the export --- */

/** One mint per press: the section (null for the whole page) and the echo it covers. */
export interface PlatformAnalyticsExporter {
  run: (section: PlatformAnalyticsSection | null, scope: PlatformExportScope) => Promise<void>;
  /** The browser says it is offline. A connectivity failure on the read is added by the grid. */
  offline: boolean;
}

/** THE WIRING, as a function so the export tests drive exactly what the host mounts. */
export function platformAnalyticsExporter(offline: boolean): PlatformAnalyticsExporter {
  return { offline, run: (section, scope) => downloadPlatformAnalyticsCsv(scope, section) };
}

interface CardExport {
  start: (section: PlatformAnalyticsSection) => Promise<void>;
  offline: boolean;
}

/** Null in a render test that passes no exporter: no controls are drawn. */
const ExportContext = createContext<CardExport | null>(null);

/** The page's "Export": every section this admin may see, for the scope on screen. */
function HeadExport({ run, offline }: { run: (() => Promise<void>) | null; offline: boolean }) {
  const action = useExportAction(run);
  const message = exportErrorMessage(action.error);
  return (
    <>
      <IconButton
        className="ovw-head__export"
        icon={<IconDownload />}
        label={exportLabel(action.pending, offline)}
        aria-label={`${exportLabel(action.pending, offline)} all analytics`}
        disabled={run === null || action.pending || offline}
        onClick={() => void action.start()}
      />
      {message !== null ? (
        <div className="ovw-head__error">
          <InlineError message={message} />
        </div>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------- the grid --- */

export interface ReadState<T> {
  data: T | undefined;
  pending: boolean;
  error: unknown;
  onRetry: () => void;
  retrying: boolean;
}

/**
 * Everything the page draws under its filters, as a function of the one read.
 * Exported so `platformAnalyticsRender.test.tsx` drives it with fixtures parsed
 * through `PlatformAnalyticsSchema` — no query client, no session.
 */
export function PlatformAnalyticsGrid({
  read,
  updatedAt = Date.now(),
  exporter,
}: {
  read: ReadState<PlatformAnalytics>;
  updatedAt?: number;
  /** Absent: no Export controls are drawn. */
  exporter?: PlatformAnalyticsExporter;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  useMasonry(gridRef);

  const data = read.data;
  /*
   * STALE-NOT-BLANK (§4): a refetch that failed keeps the cards and says so once,
   * above them. A REFUSAL IS EXCLUDED — figures she may no longer see are not
   * held on screen behind a retry (`Overview.tsx § STALE-NOT-BLANK`).
   */
  const forbidden = read.error instanceof ApiError && read.error.isForbidden;
  const stale = read.error !== null && data !== undefined && !forbidden;
  const failed = read.error !== null && (data === undefined || forbidden);

  if (failed) {
    return <AnalyticsUnavailable error={read.error} onRetry={read.onRetry} retrying={read.retrying} />;
  }

  /* While pending there is nothing to draw; every card paints its skeleton. */
  const shown = read.pending ? undefined : data;

  const offline =
    (exporter?.offline ?? false) || (read.error instanceof ApiError && read.error.isConnectivity);
  /* THE SERVER'S ECHO, NOT THE REQUEST: the file covers what the cards draw. */
  const scope: PlatformExportScope | null = shown
    ? { month: shown.month, months: shown.months.length, salon: shown.salonId }
    : null;
  const cardExport: CardExport | null =
    exporter && scope ? { offline, start: (section) => exporter.run(section, scope) } : null;

  return (
    <section className="ovw-section pa" aria-labelledby="pa-heading" aria-busy={read.pending || undefined}>
      <div className="ovw-head">
        <h2 className="overview__card-title" id="pa-heading">
          {shown ? (shown.salonName ?? 'All salons') : <Skeleton width={140} height={17} />}
        </h2>
        {shown ? (
          <span className="ovw-head__scope">
            {monthLong(shown.month)}
            {shown.partial ? ' · month to date' : ''} · {plural(shown.months.length, 'month', 'months')} of
            history
          </span>
        ) : null}
        {exporter ? (
          <HeadExport run={scope === null ? null : () => exporter.run(null, scope)} offline={offline} />
        ) : null}
      </div>

      {stale ? <StaleBanner updatedAt={updatedAt} onRetry={read.onRetry} retrying={read.retrying} /> : null}

      <Kpis data={shown} />

      {/*
        The DOM order is the reading order — the payload's block order. `useMasonry`
        moves only where each card is DRAWN.
      */}
      <ExportContext.Provider value={cardExport}>
        <div className="ovw-grid" ref={gridRef}>
          <RevenueCard data={shown} />
          <MoneyCard data={shown} />
          <SalonsCard data={shown} />
          <MembersCard data={shown} />
          <LeaderboardCard data={shown} />
          <PaymentMixCard data={shown} />
          <BookingsCard data={shown} />
          <CampaignsCard data={shown} />
          <SupportCard data={shown} />
          <ShopCard data={shown} />
          <BusiestTimesCard data={shown} />
        </div>
      </ExportContext.Provider>
    </section>
  );
}

/**
 * THE READ FAILED AND THERE IS NOTHING TO DRAW. One answer for the page, not
 * eleven identical ones: every card is the same read.
 *
 * A FILTER THE SERVER REFUSED is its own answer, printed verbatim — a month after
 * the current one (400 `invalid_month`) or a salon id that does not exist (404
 * `unknown_salon`, reachable by a hand-edited link when this admin cannot read
 * the salon list). Retrying returns the same refusal, so there is no retry; the
 * filter bar above, with Clear, is the remedy and the sentence says so.
 */
function AnalyticsUnavailable({
  error,
  onRetry,
  retrying,
}: {
  error: unknown;
  onRetry: () => void;
  retrying: boolean;
}) {
  const refused =
    badRequestAnswer(error) ??
    (error instanceof ApiError && error.status === 404 && error.code !== 'http_error' ? error.message : null);
  if (refused !== null) {
    return (
      <div className="pa__state">
        <ErrorState
          title="Couldn't show these figures"
          body={`${refused} Clear the filters to see every salon this month.`}
        />
      </div>
    );
  }
  return (
    <div className="pa__state">
      <SectionError
        error={error}
        forbiddenTitle="You don't have access to analytics"
        failedTitle="Couldn't load the platform analytics"
        onRetry={onRetry}
        retrying={retrying}
      />
    </div>
  );
}

/* ------------------------------------------------------------- the KPIs --- */

/**
 * The design's four tiles in its order — Salons, Members, Loaded, AVO revenue —
 * drawn while pending too, so the row does not reflow and a money tile shows a
 * bar rather than a zero.
 */
function Kpis({ data }: { data: PlatformAnalytics | undefined }) {
  if (!data) {
    return (
      <div className="analytics__kpis">
        {['Salons', 'Members', 'Loaded', 'AVO revenue'].map((label) => (
          <StatCard key={label} label={label} value={null} loading />
        ))}
      </div>
    );
  }
  const when = data.partial ? 'this month' : `in ${monthShort(data.month)}`;
  const mon = monthShort(data.month);
  const withheld = (label: string, key: PlatformBlockKey) => (
    <StatCard
      key={label}
      label={label}
      value="—"
      note={withheldShort(data[key] as { status: string })}
    />
  );

  const salons = data.salons;
  const members = data.members;
  const money = data.money;
  const revenue = data.revenue;
  const mix = data.paymentMix;

  const newSalons = salons.status === 'ok' ? (selectedOf(salons.months)?.newSalons ?? 0) : 0;
  const newMembers = members.status === 'ok' ? (selectedOf(members.months)?.newMembers ?? 0) : 0;
  const loaded = money.status === 'ok' ? (selectedOf(money.months)?.loadedFils ?? 0) : 0;
  const knet = mix.status === 'ok' ? mix.methods.knet.shareBp : null;
  const mom = revenue.status === 'ok' ? momentum(revenue.thisMonthFils, revenue.priorMonthFils) : null;

  return (
    <div className="analytics__kpis">
      {/* "Salons live" in the design — the schema cannot say live. See the header. */}
      {salons.status === 'ok' ? (
        <StatCard
          label="Salons"
          value={salons.total.toLocaleString('en-US')}
          {...(newSalons > 0 ? { delta: `+${newSalons.toLocaleString('en-US')} ${when}` } : {})}
        />
      ) : (
        withheld('Salons', 'salons')
      )}
      {members.status === 'ok' ? (
        <StatCard
          label="Members"
          value={members.total.toLocaleString('en-US')}
          {...(newMembers > 0 ? { delta: `+${newMembers.toLocaleString('en-US')} ${when}` } : {})}
        />
      ) : (
        withheld('Members', 'members')
      )}
      {/* The design's "Loaded (Jul)", the month taken from the server's echo. */}
      {money.status === 'ok' ? (
        <StatCard
          label={`Loaded (${mon})`}
          value={<Money amount={fils(loaded)} />}
          unit="KD"
          {...(knet !== null && knet > 0 ? { delta: `${formatBp(knet)} via KNET` } : {})}
        />
      ) : (
        withheld(`Loaded (${mon})`, 'money')
      )}
      {revenue.status === 'ok' ? (
        <StatCard
          label="AVO revenue"
          value={<Money amount={fils(revenue.thisMonthFils)} />}
          unit="KD"
          {...(mom !== null ? { delta: mom } : {})}
        />
      ) : (
        withheld('AVO revenue', 'revenue')
      )}
    </div>
  );
}

/* ------------------------------------------------------------ the shell --- */

/**
 * One card — the merchant `Widget`'s shell (`.ovw`, `.ovw__head`, the quiet
 * Export from `useExportUi`) with the console's section as its export target.
 * The head is identical in every state so nothing moves when the answer lands.
 */
function Panel({
  title,
  caption,
  label,
  section,
  exportable,
  children,
}: {
  title: string;
  caption?: string | null;
  /** `data-widget`, for tests and for nobody else. */
  label: string;
  section: PlatformAnalyticsSection;
  /** False while pending and on a withheld block: no control is drawn. */
  exportable: boolean;
  children: ReactNode;
}) {
  const exp = useContext(ExportContext);
  const { control, error } = useExportUi(
    exp !== null && exportable ? () => exp.start(section) : null,
    exp?.offline ?? false,
    title,
  );
  return (
    <Card className="ovw" flush data-widget={label}>
      <div className="ovw__head">
        <h3 className="overview__card-title">{title}</h3>
        {control}
      </div>
      {caption ? <p className="ovw__caption">{caption}</p> : null}
      {error}
      <div className="ovw__body">{children}</div>
    </Card>
  );
}

type OkBlock<K extends PlatformBlockKey> = Extract<PlatformAnalytics[K], { status: 'ok' }>;

/** Pending, withheld, then `render` for the loaded block. */
function body<K extends PlatformBlockKey>(
  data: PlatformAnalytics | undefined,
  key: K,
  render: (block: OkBlock<K>, all: PlatformAnalytics) => ReactNode,
  rows = 4,
): ReactNode {
  if (data === undefined) return <WidgetSkeleton rows={rows} />;
  const block = data[key] as { status: string };
  if (isWithheld(block)) {
    return (
      <p className="ovw__quiet" data-withheld={block.reason}>
        {withheldCopy(key, block, data.salonName)}
      </p>
    );
  }
  return render(block as OkBlock<K>, data);
}

const exportable = (data: PlatformAnalytics | undefined, key: PlatformBlockKey) =>
  data !== undefined && !isWithheld(data[key] as { status: string });

/** "Last 12 months · Nov 2025 – Oct 2026" — the history every chart on the card spans. */
function historyCaption(data: PlatformAnalytics | undefined, unit?: string): string | null {
  if (!data) return null;
  const first = data.months[0] ?? data.month;
  const range = `${monthShortYear(first)} – ${monthShortYear(data.month)}`;
  return [`Last ${plural(data.months.length, 'month', 'months')}`, range, unit].filter(Boolean).join(' · ');
}

const kd = (value: number) => <Money amount={fils(value)} withUnit />;
const kdText = (value: number) => formatMoney(fils(value));

/* ----------------------------------------------------------- the charts --- */

export interface MonthPoint {
  month: string;
  value: number;
  /** What the bar shows on hover — `<Money>` or a count. */
  figure: ReactNode;
  /** The same figure as words, for a screen reader. */
  spoken: string;
}

/**
 * THE DESIGN'S BAR CHART, FOR EVERY MONTHLY SERIES. "Wallet loaded across
 * platform · Last 8 months · KD" (`AVO Owner Console.dc.html:111`): one bar per
 * month, the newest filled solid and the rest the same hue at rest, the month
 * under each. The figure appears on hover and is read out per bar, so the bar
 * is never the only place a number lives.
 *
 * HEIGHTS ARE A SHARE OF THE TALLEST BAR (`barPx`, whole pixels). ALL-ZERO IS A
 * REAL STATE: twelve baselines with the months labelled — "nothing in March" is
 * information. A month-to-date newest bar is drawn paler and outlined, and the
 * sentence under the chart says why; a part month must not read as a slump.
 *
 * Past twelve bars the chart goes dense: tighter gaps, and every third month
 * labelled (always the newest), so twenty-four months stay a shape.
 */
export function MonthBars({
  points,
  partial,
  label,
  empty,
}: {
  points: readonly MonthPoint[];
  partial: boolean;
  label: string;
  /**
   * The sentence for a series that is zero in every month. A row of baselines
   * says the same thing less clearly, and on a card with other figures it is
   * the largest thing on it.
   */
  empty?: string;
}) {
  if (empty !== undefined && allZero(points.map((p) => p.value))) {
    return <p className="ovw__quiet">{empty}</p>;
  }
  const peak = peakOf(points.map((p) => p.value));
  const dense = points.length > 12;
  const last = points.length - 1;
  return (
    <>
      <ul className="analytics__bars pa-bars" aria-label={label} {...(dense ? { 'data-dense': 'true' } : {})}>
        {points.map((p, i) => {
          const latest = i === last;
          const labelled = !dense || (last - i) % 3 === 0;
          return (
            <li className="analytics__barcol" key={p.month}>
              <div
                className="analytics__bar"
                aria-hidden="true"
                {...(latest ? { 'data-latest': 'true' } : {})}
                {...(latest && partial ? { 'data-partial': 'true' } : {})}
                /*
                 * The one inline style a chart needs: a computed height. Every
                 * colour is a token in app.css. `max(…, 2px)` keeps a zero month
                 * visible as a baseline.
                 */
                style={{ height: `${Math.max(barPx(p.value, peak), 2)}px` }}
              />
              <span className="analytics__barmonth" aria-hidden="true">
                {labelled ? monthShort(p.month) : ''}
              </span>
              <span className="analytics__barvalue" aria-hidden="true">
                {p.figure}
              </span>
              <span className="avo-sr-only">
                {monthLong(p.month)}
                {latest && partial ? ' so far' : ''}: {p.spoken}
              </span>
            </li>
          );
        })}
      </ul>
      {partial && points.length > 0 ? (
        <p className="ovw__note">{monthShort(points[last]!.month)} is month to date, so its bar is still filling.</p>
      ) : null}
    </>
  );
}

function moneyPoints<T extends { month: string }>(rows: readonly T[], value: (r: T) => number): MonthPoint[] {
  return rows.map((r) => ({ month: r.month, value: value(r), figure: <Money amount={fils(value(r))} />, spoken: kdText(value(r)) }));
}

function countPoints<T extends { month: string }>(
  rows: readonly T[],
  value: (r: T) => number,
  one: string,
  many: string,
): MonthPoint[] {
  return rows.map((r) => ({
    month: r.month,
    value: value(r),
    figure: value(r).toLocaleString('en-US'),
    spoken: plural(value(r), one, many),
  }));
}

function SeriesControl<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (next: T) => void;
  options: Array<{ value: T; label: string }>;
}) {
  return (
    <div className="ovw__control">
      <Segmented<T> label={label} value={value} onChange={onChange} options={options} />
    </div>
  );
}

/**
 * THE DESIGN'S RANKED LIST — "Top salons this month" (`.analytics__toprow`):
 * rank, name, a secondary line, the figure. Five rows, then the merchant feed's
 * "Show N more" disclosure (`Overview.tsx § ActivityList`), which reveals rows
 * already in hand and fetches nothing.
 */
function RankedList({
  rows,
  noun,
}: {
  rows: ReadonlyArray<{ key: string; name: string; meta: string; figure: ReactNode }>;
  /** "salons" — for the disclosure's accessible name. */
  noun: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);
  const visible = expanded ? rows : rows.slice(0, RANKED_VISIBLE);
  const hidden = rows.length - visible.length;
  return (
    <>
      <ol className="analytics__toplist" ref={listRef} tabIndex={-1}>
        {visible.map((r, i) => (
          <li className="analytics__toprow" key={r.key}>
            <span className="analytics__rank avo-display" aria-hidden="true">
              {i + 1}
            </span>
            <span className="analytics__topwho">
              <span className="analytics__topname">{r.name}</span>
              <span className="analytics__topmeta">{r.meta}</span>
            </span>
            <span className="analytics__topmoney avo-display">{r.figure}</span>
          </li>
        ))}
      </ol>
      {hidden > 0 ? (
        <div className="overview__feed-more">
          <Button
            variant="secondary"
            aria-label={`Show ${hidden} more ${noun}`}
            onClick={() => {
              setExpanded(true);
              listRef.current?.focus();
            }}
          >
            Show {hidden} more
          </Button>
        </div>
      ) : null}
    </>
  );
}

/* ============================================================ 1. revenue == */

export function RevenueCard({ data }: { data: PlatformAnalytics | undefined }) {
  return (
    <Panel
      title="AVO revenue"
      label="revenue"
      section="revenue"
      caption={historyCaption(data, 'KD')}
      exportable={exportable(data, 'revenue')}
    >
      {body(data, 'revenue', (block, all) => {
        if (block.months.every((m) => m.feeFils === 0 && m.topups === 0)) {
          return (
            <EmptyState
              title={`No commission in the last ${plural(block.months.length, 'month', 'months')}`}
              body="AVO revenue appears here as customers top up their wallets at any salon."
            />
          );
        }
        const sel = selectedOf(block.months);
        const mom = momentum(block.thisMonthFils, block.priorMonthFils);
        return (
          <>
            <div className="ovw-figures">
              <Figure
                label={monthLong(all.month)}
                value={kd(block.thisMonthFils)}
                note={
                  mom !== null
                    ? `${mom} against ${monthShortYear(block.priorMonth)} (${kdText(block.priorMonthFils)})`
                    : `Nothing recorded in ${monthShortYear(block.priorMonth)} to compare against`
                }
              />
            </div>
            <MonthBars
              label="AVO revenue by month"
              partial={all.partial}
              points={moneyPoints(block.months, (m) => m.feeFils)}
            />
            {sel ? (
              <>
                <h4 className="ovw__sub">By method, {monthShortYear(sel.month)}</h4>
                <BarList
                  rows={METHODS.map((m) => ({
                    key: m,
                    name: METHOD_LABEL[m],
                    value: sel.byMethod[m].feeFils,
                    figure: kd(sel.byMethod[m].feeFils),
                    spoken: `${METHOD_LABEL[m]}: ${kdText(sel.byMethod[m].feeFils)} from ${plural(sel.byMethod[m].topups, 'top-up', 'top-ups')}`,
                  }))}
                />
                <p className="ovw__note">
                  KNET is the flat fee; card and Apple Pay are both on the card rate. Each fee is the one
                  set when the top-up was made.
                </p>
              </>
            ) : null}
          </>
        );
      })}
    </Panel>
  );
}

/* ============================================================== 2. money == */

type MoneySeries = 'loaded' | 'bonus' | 'spent';

const MONEY_NOTE: Record<MoneySeries, string> = {
  loaded: 'What customers paid on settled top-ups, bonus excluded.',
  bonus: 'Bonus credit added on top of what customers paid.',
  spent: 'Spent from wallets at salons — charges, shop orders and kept deposits.',
};

export function MoneyCard({ data }: { data: PlatformAnalytics | undefined }) {
  const [series, setSeries] = useState<MoneySeries>('loaded');
  return (
    <Panel
      title="Wallet money"
      label="money"
      section="money"
      caption={historyCaption(data, 'KD')}
      exportable={exportable(data, 'money')}
    >
      {body(data, 'money', (block, all) => {
        const empty =
          block.liabilityFils === 0 &&
          block.months.every((m) => m.loadedFils === 0 && m.bonusFils === 0 && m.spentFils === 0);
        if (empty) {
          return (
            <EmptyState
              title="No wallet money yet"
              body="Loaded, spent and owed balances appear here once customers top up at any salon."
            />
          );
        }
        const pick = (m: (typeof block.months)[number]) =>
          series === 'loaded' ? m.loadedFils : series === 'bonus' ? m.bonusFils : m.spentFils;
        const owed = block.liabilityBySalon.filter((s) => s.liabilityFils > 0);
        return (
          <>
            <div className="ovw-figures">
              <Figure
                label="Owed to customers now"
                value={kd(block.liabilityFils)}
                note="Every wallet balance today, whichever month is picked"
              />
            </div>
            <SeriesControl<MoneySeries>
              label="Wallet money series"
              value={series}
              onChange={setSeries}
              options={[
                { value: 'loaded', label: 'Loaded' },
                { value: 'bonus', label: 'Bonus' },
                { value: 'spent', label: 'Spent' },
              ]}
            />
            <MonthBars
              label={`Wallet ${series} by month`}
              partial={all.partial}
              points={moneyPoints(block.months, pick)}
              empty={`Nothing ${series === 'loaded' ? 'loaded' : series === 'bonus' ? 'credited as bonus' : 'spent'} in these months.`}
            />
            <p className="ovw__note">{MONEY_NOTE[series]}</p>
            {owed.length > 1 ? (
              <>
                <h4 className="ovw__sub">Owed, by salon</h4>
                <RankedList
                  noun="salons"
                  rows={owed.map((s) => ({
                    key: s.salonId,
                    name: s.name,
                    meta: 'Wallet balances now',
                    figure: <Money amount={fils(s.liabilityFils)} />,
                  }))}
                />
              </>
            ) : null}
          </>
        );
      })}
    </Panel>
  );
}

/* ============================================================= 3. salons == */

type SalonSeries = 'active' | 'newSalons' | 'dormant';

export function SalonsCard({ data }: { data: PlatformAnalytics | undefined }) {
  const [series, setSeries] = useState<SalonSeries>('active');
  return (
    <Panel
      title="Salons"
      label="salons"
      section="salons"
      caption={historyCaption(data)}
      exportable={exportable(data, 'salons')}
    >
      {body(data, 'salons', (block, all) => {
        if (block.total === 0) {
          return <EmptyState title="No salons yet" body="Salons appear here once they're onboarded from Salons." />;
        }
        const one = series === 'newSalons' ? 'new salon' : series === 'active' ? 'active salon' : 'dormant salon';
        const many = `${one}s`;
        return (
          <>
            <div className="ovw-figures">
              <Figure label="Salons" value={block.total.toLocaleString('en-US')} note="Every salon on AVO, now" />
              <Figure
                label="Branches open"
                value={block.branches.open.toLocaleString('en-US')}
                note={`${plural(block.branches.closed, 'branch', 'branches')} closed`}
              />
            </div>
            <h4 className="ovw__sub">By plan</h4>
            <BarList
              rows={PLANS.map((p) => ({
                key: p,
                name: PLAN_LABEL[p],
                value: block.byPlan[p],
                figure: block.byPlan[p].toLocaleString('en-US'),
                spoken: `${PLAN_LABEL[p]}: ${plural(block.byPlan[p], 'salon', 'salons')}`,
              }))}
            />
            <SeriesControl<SalonSeries>
              label="Salons series"
              value={series}
              onChange={setSeries}
              options={[
                { value: 'active', label: 'Active' },
                { value: 'newSalons', label: 'New' },
                { value: 'dormant', label: 'Dormant' },
              ]}
            />
            <MonthBars
              label={`${many} by month`}
              partial={all.partial}
              points={countPoints(block.months, (m) => m[series], one, many)}
              empty={`No ${many} in these months.`}
            />
            <p className="ovw__note">
              Active means at least one settled transaction in the month; dormant means the salon was on AVO
              and had none.
            </p>
          </>
        );
      })}
    </Panel>
  );
}

/* ============================================================ 4. members == */

type MemberSeries = 'newMembers' | 'activeMembers';

export function MembersCard({ data }: { data: PlatformAnalytics | undefined }) {
  const [series, setSeries] = useState<MemberSeries>('newMembers');
  return (
    <Panel
      title="Members"
      label="members"
      section="members"
      caption={historyCaption(data)}
      exportable={exportable(data, 'members')}
    >
      {body(data, 'members', (block, all) => {
        if (block.total === 0) {
          return (
            <EmptyState
              title="No members yet"
              body="Members are counted the day they register at any salon or in the AVO app."
            />
          );
        }
        const one = series === 'newMembers' ? 'new member' : 'active member';
        const tierRows = [
          ...TIERS.map((t) => ({ key: t, name: TIER_LABEL[t], members: block.tiers[t], tone: t as string })),
          ...(block.tiers.untiered > 0
            ? [{ key: 'untiered', name: 'No tier', members: block.tiers.untiered, tone: 'member' }]
            : []),
        ];
        return (
          <>
            <div className="ovw-figures">
              <Figure label="Members" value={block.total.toLocaleString('en-US')} note="Every wallet on the books, now" />
            </div>
            <SeriesControl<MemberSeries>
              label="Members series"
              value={series}
              onChange={setSeries}
              options={[
                { value: 'newMembers', label: 'New' },
                { value: 'activeMembers', label: 'Active' },
              ]}
            />
            <MonthBars
              label={`${one}s by month`}
              partial={all.partial}
              points={countPoints(block.months, (m) => m[series], one, `${one}s`)}
              empty={`No ${one}s in these months.`}
            />
            {series === 'activeMembers' ? (
              <p className="ovw__note">Active means at least one settled transaction in the month.</p>
            ) : null}
            {block.tiers.salons > 0 ? (
              <>
                <h4 className="ovw__sub">
                  Members by tier, now · {plural(block.tiers.salons, 'salon', 'salons')} on tiers
                </h4>
                <BarList
                  rows={tierRows.map((r) => ({
                    key: r.key,
                    name: r.name,
                    value: r.members,
                    figure: r.members.toLocaleString('en-US'),
                    spoken: `${r.name}: ${plural(r.members, 'member', 'members')}`,
                    tone: r.tone,
                  }))}
                />
              </>
            ) : null}
            {block.stamps.salons > 0 && block.stamps.buckets.length > 0 ? (
              <>
                <h4 className="ovw__sub">
                  Stamp progress, now · {plural(block.stamps.salons, 'salon', 'salons')} on stamp cards
                </h4>
                <BarList
                  rows={block.stamps.buckets.map((b) => ({
                    key: `${b.stampTarget}:${b.stamps}`,
                    name: `${b.stamps} of ${b.stampTarget}`,
                    value: b.members,
                    figure: b.members.toLocaleString('en-US'),
                    spoken: `${b.stamps} of ${b.stampTarget} stamps: ${plural(b.members, 'member', 'members')}`,
                  }))}
                />
              </>
            ) : null}
          </>
        );
      })}
    </Panel>
  );
}

/* ======================================================== 5. leaderboard == */

const RANK_LABEL: Record<LeaderboardSort, string> = {
  loaded: 'Loaded',
  spent: 'Spent',
  revenue: 'AVO revenue',
  members: 'Members',
};

function leaderMeta(r: LeaderboardRow): string {
  const parts = [`${plural(r.members, 'member', 'members')} · ${r.activeMembers.toLocaleString('en-US')} active`];
  if (r.bookings !== null) parts.push(plural(r.bookings, 'booking', 'bookings'));
  if (r.noShowRateBp !== null) parts.push(`${formatBp(r.noShowRateBp)} no-shows`);
  return parts.join(' · ');
}

export function LeaderboardCard({ data }: { data: PlatformAnalytics | undefined }) {
  const [by, setBy] = useState<LeaderboardSort>('loaded');
  return (
    <Panel
      title="Salon leaderboard"
      label="leaderboard"
      section="leaderboard"
      caption={data ? `${monthLong(data.month)}${data.partial ? ' so far' : ''}` : null}
      exportable={exportable(data, 'leaderboard')}
    >
      {body(
        data,
        'leaderboard',
        (block) => {
          if (block.rows.length === 0) {
            return <EmptyState title="No salons yet" body="Salons rank here once they're onboarded from Salons." />;
          }
          const ranked = rankLeaderboard(block.rows, by);
          return (
            <>
              <SeriesControl<LeaderboardSort>
                label="Rank salons by"
                value={by}
                onChange={setBy}
                options={(['loaded', 'spent', 'revenue', 'members'] as const).map((v) => ({ value: v, label: RANK_LABEL[v] }))}
              />
              <RankedList
                noun="salons"
                rows={ranked.map((r) => ({
                  key: r.salonId,
                  name: r.name,
                  meta: leaderMeta(r),
                  figure:
                    by === 'members' ? sortValue(r, by).toLocaleString('en-US') : <Money amount={fils(sortValue(r, by))} />,
                }))}
              />
              {by !== 'members' ? <p className="ovw__note">Figures in KD.</p> : null}
            </>
          );
        },
        5,
      )}
    </Panel>
  );
}

/* ======================================================== 6. payment mix == */

export function PaymentMixCard({ data }: { data: PlatformAnalytics | undefined }) {
  return (
    <Panel
      title="Payment mix"
      label="payment-mix"
      section="paymentMix"
      caption={data ? `Top-ups by method · ${monthLong(data.month)}` : null}
      exportable={exportable(data, 'paymentMix')}
    >
      {body(data, 'paymentMix', (block, all) => {
        if (block.topups === 0) {
          return (
            <EmptyState
              title={`No top-ups in ${monthLong(all.month)}`}
              body="The mix fills in as customers top up their wallets with KNET, card or Apple Pay."
            />
          );
        }
        return (
          <>
            <BarList
              rows={METHODS.map((m) => {
                const x = block.methods[m];
                return {
                  key: m,
                  name: METHOD_LABEL[m],
                  value: x.fils,
                  figure: (
                    <>
                      {kd(x.fils)}
                      {x.shareBp !== null ? <span className="ovw-bars__share"> · {formatBp(x.shareBp)}</span> : null}
                    </>
                  ),
                  spoken: `${METHOD_LABEL[m]}: ${kdText(x.fils)} from ${plural(x.count, 'top-up', 'top-ups')}${
                    x.shareBp !== null ? `, ${formatBp(x.shareBp)} of top-up value` : ''
                  }`,
                };
              })}
            />
            <p className="ovw__note">
              {plural(block.topups, 'top-up', 'top-ups')} · <Money amount={fils(block.loadedFils)} withUnit /> paid.
              Shares are of value, not of count.
            </p>
          </>
        );
      })}
    </Panel>
  );
}

/* =========================================================== 7. bookings == */

export function BookingsCard({ data }: { data: PlatformAnalytics | undefined }) {
  return (
    <Panel
      title="Bookings"
      label="bookings"
      section="bookings"
      caption={historyCaption(data)}
      exportable={exportable(data, 'bookings')}
    >
      {body(data, 'bookings', (block, all) => {
        if (block.salons === 0) {
          return (
            <EmptyState
              title="No salons take bookings yet"
              body="Bookings appear here once a salon turns the booking module on in Salons."
            />
          );
        }
        const sel = selectedOf(block.months);
        const resolved = sel ? sel.completed + sel.noShows : 0;
        return (
          <>
            <div className="ovw-figures">
              {/* NULL IS "NOTHING WAS RESOLVED", NOT 0% — the server's distinction, kept. */}
              <Figure
                label={`No-show rate, ${monthShort(all.month)}`}
                value={sel?.rateBp == null ? '—' : formatBp(sel.rateBp)}
                note={
                  sel?.rateBp == null
                    ? `No appointments were resolved in ${monthLong(all.month)}`
                    : `${sel.noShows} of ${plural(resolved, 'resolved appointment', 'resolved appointments')}`
                }
              />
              <Figure
                label="Deposits held now"
                value={kd(block.depositsHeld.fils)}
                note={`On ${plural(block.depositsHeld.bookings, 'booking', 'bookings')}`}
              />
            </div>
            <MonthBars
              label="Bookings by month"
              partial={all.partial}
              points={countPoints(block.months, (m) => m.bookings, 'booking', 'bookings')}
              empty="No bookings in these months."
            />
            <p className="ovw__note">
              Across {plural(block.salons, 'salon', 'salons')} with the booking module on.
            </p>
          </>
        );
      })}
    </Panel>
  );
}

/* ========================================================== 8. campaigns == */

type CampaignSeries = 'submitted' | 'sent';

export function CampaignsCard({ data }: { data: PlatformAnalytics | undefined }) {
  const [series, setSeries] = useState<CampaignSeries>('submitted');
  return (
    <Panel
      title="Campaign approvals"
      label="campaigns"
      section="campaigns"
      caption={historyCaption(data)}
      exportable={exportable(data, 'campaigns')}
    >
      {body(data, 'campaigns', (block, all) => {
        if (block.pendingNow === 0 && block.months.every((m) => m.submitted === 0 && m.sent === 0)) {
          return (
            <EmptyState
              title="No campaigns submitted yet"
              body="Campaigns appear here as salons submit them from Marketing for AVO to approve."
            />
          );
        }
        const sel = selectedOf(block.months);
        return (
          <>
            <div className="ovw-figures">
              <Figure label="Waiting now" value={block.pendingNow.toLocaleString('en-US')} note="Pending your decision in Approvals" />
              <Figure
                label={`Median decision, ${monthShort(all.month)}`}
                value={sel?.medianDecisionSeconds == null ? '—' : durationLabel(sel.medianDecisionSeconds)}
                note={
                  sel?.p90DecisionSeconds == null
                    ? `Nothing was decided in ${monthLong(all.month)}`
                    : `9 in 10 decided within ${durationLabel(sel.p90DecisionSeconds)}`
                }
              />
            </div>
            {sel ? (
              <BarList
                rows={(
                  [
                    ['submitted', 'Submitted'],
                    ['approved', 'Approved'],
                    ['rejected', 'Rejected'],
                    ['sent', 'Sent'],
                    ['held', 'Held'],
                  ] as const
                ).map(([k, name]) => ({
                  key: k,
                  name,
                  value: sel[k],
                  figure: sel[k].toLocaleString('en-US'),
                  spoken: `${name} in ${monthLong(all.month)}: ${plural(sel[k], 'campaign', 'campaigns')}`,
                }))}
              />
            ) : null}
            <SeriesControl<CampaignSeries>
              label="Campaigns series"
              value={series}
              onChange={setSeries}
              options={[
                { value: 'submitted', label: 'Submitted' },
                { value: 'sent', label: 'Sent' },
              ]}
            />
            <MonthBars
              label={`Campaigns ${series} by month`}
              partial={all.partial}
              points={countPoints(block.months, (m) => m[series], 'campaign', 'campaigns')}
              empty={`No campaigns ${series} in these months.`}
            />
            <p className="ovw__note">Held means approved and currently held back from sending.</p>
          </>
        );
      })}
    </Panel>
  );
}

/* ============================================================ 9. support == */

type SupportSeries = 'opened' | 'resolved';

export function SupportCard({ data }: { data: PlatformAnalytics | undefined }) {
  const [series, setSeries] = useState<SupportSeries>('opened');
  return (
    <Panel
      title="Support tickets"
      label="support"
      section="support"
      caption={historyCaption(data)}
      exportable={exportable(data, 'support')}
    >
      {body(data, 'support', (block, all) => {
        if (block.openNow.total === 0 && block.months.every((m) => m.opened === 0 && m.resolved === 0)) {
          return (
            <EmptyState
              title="No support tickets yet"
              body="Tickets appear here as members and salons contact support from the app."
            />
          );
        }
        return (
          <>
            <div className="ovw-figures">
              <Figure label="Open now" value={block.openNow.total.toLocaleString('en-US')} />
              <Figure label="AVO queue" value={block.openNow.avo.toLocaleString('en-US')} />
              <Figure label="Salon queues" value={block.openNow.salon.toLocaleString('en-US')} />
            </div>
            <SeriesControl<SupportSeries>
              label="Support series"
              value={series}
              onChange={setSeries}
              options={[
                { value: 'opened', label: 'Opened' },
                { value: 'resolved', label: 'Resolved' },
              ]}
            />
            <MonthBars
              label={`Tickets ${series} by month`}
              partial={all.partial}
              points={countPoints(block.months, (m) => m[series], 'ticket', 'tickets')}
              empty={`No tickets ${series} in these months.`}
            />
          </>
        );
      })}
    </Panel>
  );
}

/* =============================================================== 10. shop == */

type ShopSeries = 'gmv' | 'orders';

export function ShopCard({ data }: { data: PlatformAnalytics | undefined }) {
  const [series, setSeries] = useState<ShopSeries>('gmv');
  return (
    <Panel
      title="Shop"
      label="shop"
      section="shop"
      caption={historyCaption(data)}
      exportable={exportable(data, 'shop')}
    >
      {body(data, 'shop', (block, all) => {
        if (block.salons === 0) {
          return (
            <EmptyState
              title="No salons run the shop yet"
              body="Shop orders appear here once a salon turns the shop module on in Salons."
            />
          );
        }
        if (block.months.every((m) => m.orders === 0)) {
          return (
            <>
              <EmptyState
                title={`No shop orders in the last ${plural(block.months.length, 'month', 'months')}`}
                body="Orders appear here as customers buy from a salon's shop in the AVO app."
              />
              <p className="ovw__note">Across {plural(block.salons, 'salon', 'salons')} with the shop on.</p>
            </>
          );
        }
        return (
          <>
            <h4 className="ovw__sub">Orders placed in {monthLong(all.month)}, by where each stands now</h4>
            <div className="ovw-figures">
              {ORDER_STATUSES.map((s) => (
                <Figure key={s} label={ORDER_STATUS_LABEL[s]} value={block.ordersByStatus[s].toLocaleString('en-US')} />
              ))}
            </div>
            <SeriesControl<ShopSeries>
              label="Shop series"
              value={series}
              onChange={setSeries}
              options={[
                { value: 'gmv', label: 'Sales' },
                { value: 'orders', label: 'Orders' },
              ]}
            />
            <MonthBars
              label={series === 'gmv' ? 'Shop sales by month' : 'Shop orders by month'}
              empty={series === 'gmv' ? 'No shop sales in these months.' : 'No shop orders in these months.'}
              partial={all.partial}
              points={
                series === 'gmv'
                  ? moneyPoints(block.months, (m) => m.gmvFils)
                  : countPoints(block.months, (m) => m.orders, 'order', 'orders')
              }
            />
            <p className="ovw__note">Across {plural(block.salons, 'salon', 'salons')} with the shop on.</p>
          </>
        );
      })}
    </Panel>
  );
}

/* ====================================================== 11. busiest times == */

/**
 * WEEKDAY × HOUR, EACH VISIT ON ITS OWN SALON'S CLOCK. The server reads every
 * visit's weekday and hour `AT TIME ZONE` that salon's zone and says so on the
 * wire (`clock: 'salon_local'`), so a 10:00 visit in Kuwait and a 10:00 visit in
 * Dubai share a column. The caption says it in words: across salons there is
 * no single zone to name, and the platform zone would be the wrong one.
 *
 * The merchant grid's `<table>`, legend and rules (`heatGrid`), unchanged.
 */
export function BusiestTimesCard({ data }: { data: PlatformAnalytics | undefined }) {
  return (
    <Panel
      title="Busiest times"
      label="busiest-times"
      section="busiestTimes"
      caption={
        data
          ? `Visits by day and hour in ${monthLong(data.month)}, in each salon's local time`
          : "Visits by day and hour, in each salon's local time"
      }
      exportable={exportable(data, 'busiestTimes')}
    >
      {body(
        data,
        'busiestTimes',
        (block, all) => {
          if (block.totalVisits === 0 || block.cells.length === 0) {
            return (
              <EmptyState
                title={`No visits in ${monthLong(all.month)}`}
                body="The grid fills in as salons charge customers on the salon phone."
              />
            );
          }
          const grid = heatGrid(block.cells);
          const top = busiestOf(block.cells);
          return (
            <>
              {top ? (
                <p className="ovw__lead">
                  Busiest: {WEEKDAY_LONG[top.weekday]} at {hourLabel(top.hour)} · {plural(top.visits, 'visit', 'visits')}
                </p>
              ) : null}
              <div className="ovw-heat">
                <table style={{ '--hours': grid.hours.length } as CSSProperties}>
                  <caption className="avo-sr-only">
                    Visits by weekday and hour, each in its own salon&rsquo;s local time, {monthLong(all.month)}.{' '}
                    {plural(block.totalVisits, 'visit', 'visits')} in all.
                  </caption>
                  <thead>
                    <tr>
                      <td className="ovw-heat__corner" />
                      {grid.hours.map((h, i) => (
                        <th key={h} scope="col">
                          <span aria-hidden="true">{h % 3 === 0 || i === 0 ? String(h) : ''}</span>
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
              <p className="ovw__note">
                {plural(block.totalVisits, 'visit', 'visits')}. Hours are each salon&rsquo;s own clock, so 10:00 is
                10:00 wherever the salon is.
              </p>
            </>
          );
        },
        7,
      )}
    </Panel>
  );
}

function PulseGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true" fill="none">
      <path
        d="M2.5 10h4l2-5 3 10 2-5h4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
