import { formatFils, type Fils } from '@avo/types';
import { Card, EmptyState, ErrorState, Skeleton } from '@avo/ui';
import { ApiError } from '../api/client.js';
import {
  formatWindowDay,
  useReport,
  rangeToken,
  windowPhrase,
  type Report,
  type ReportFilters,
} from '../api/reports.js';
import { useSalon } from '../api/salon.js';
import { ALL_BRANCHES, useBranchScope } from '../shell/BranchScope.js';
import {
  TREND_DAYS,
  barPermille,
  peakFils,
  seriesFrom,
  totalTransactions,
  trendScope,
  trendWindow,
  type DayPoint,
  type TrendScope,
} from './salesTrendRules.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MERCHANT → OVERVIEW → GROSS BY DAY. NEW WORK; THE DESIGN BUNDLE HAS NO CHART.
 * ═══════════════════════════════════════════════════════════════════════════
 * The disclosure, the window and the scope decision are all argued in
 * `salesTrendRules.ts`, which holds every rule this file renders. Read that first.
 *
 * NO CHART LIBRARY, AND IT WAS CONSIDERED. The whole drawing is one flex row of
 * `<li>`s whose bar is a percentage height — twenty lines of CSS. A charting
 * dependency would buy axes, tooltips and animation, and cost: a bundle this
 * dashboard currently has no runtime dependency of that size in, an SVG text
 * layer that scales with the viewBox instead of staying at the type ramp, its
 * own colour API to keep away from the tokens, and a canvas or `<title>`
 * tooltip a keyboard user never reaches. Percentage-height DOM bars are
 * responsive without arithmetic, keep every label at its real size, take their
 * colour from `--avo-*` like everything else, and are READ BY A SCREEN READER AS
 * A LIST — which is what a series is.
 *
 * COLOUR: bars are `--avo-brand`, which is what that token is FOR — non-negotiable
 * #9 calls it "a *surface* colour: gradients, tints, dots, progress fills" and a
 * bar is a progress fill. No text sits on a bar, so the white-on-brand hazard
 * cannot arise here. The labels are `--avo-text-muted-label` and
 * `--avo-text-muted`, both already audited (`packages/tokens § mutedLabel`: 0.65
 * clears 4.5:1 on the darkest surface a label lands on). Semantic colour is
 * deliberately absent — a day is not "good" or "bad", and painting bars by a
 * threshold nobody set would be this card inventing a judgement.
 *
 * NO PERMISSION GATE HERE, for the reason the file around it gives twice:
 * `sales` is `requireDashboardPerm(req, 'dashboard')` — the same gate as the
 * metrics and the feed — so a refusal arrives on its own and a client check
 * would duplicate the server and drift from it (#7).
 */

/* ---------------------------------------------------------------- the card -- */

/**
 * The shell every state renders inside, so the card's head does not move
 * between a skeleton and a chart. `scope` is null while there is no report to
 * read a scope off — the qualifier is a claim about figures, and there are none
 * yet.
 */
export function TrendCard({
  scope,
  caption,
  children,
}: {
  scope: TrendScope | null;
  caption: string | null;
  children: React.ReactNode;
}) {
  return (
    <Card className="trend-card" flush>
      <h2 className="overview__card-title">
        Gross by day
        {/*
          THE QUALIFIER IS THE FEED'S, VERBATIM AND IN THE SAME SLOT. "Recent
          activity  All branches" is twenty lines above this in `Overview.tsx`
          and means exactly what it means here: a branch is applied to the tiles
          and this panel is wider than they are. A second wording for one fact
          is how a merchant concludes there are two facts.
        */}
        {scope?.kind === 'wider-than-tiles' ? (
          <span className="overview__card-scope">All branches</span>
        ) : null}
      </h2>
      {caption !== null ? <p className="trend-card__caption">{caption}</p> : null}
      {children}
    </Card>
  );
}

/**
 * The Overview's entry point. Owns the WINDOW — which needs the salon's zone —
 * and hands a settled `ReportFilters` to the half that owns the query, because
 * `useReport` cannot be called with a question this card has not finished
 * composing. `Reports.tsx` gates its six cards on `filters === null` for the
 * same reason.
 */
export function SalesTrendCard() {
  const salon = useSalon();
  const zone = salon.data?.timezone ?? null;
  const window = zone === null ? null : trendWindow(zone, new Date());

  if (salon.isPending) {
    return (
      <TrendCard scope={null} caption={null}>
        <TrendSkeleton />
      </TrendCard>
    );
  }

  /*
   * THE SALON LOAD FAILED, SO THERE IS NO ZONE AND THEREFORE NO WINDOW. Not
   * "the chart failed" — nothing has been asked of the reports endpoint yet —
   * and the retry is the salon's. A 403 on `GET /salons/{id}` is
   * `requireSameSalon`, which no button fixes, so it gets no button.
   */
  if (salon.isError) {
    return (
      <TrendCard scope={null} caption={null}>
        <WindowUnknown
          error={salon.error}
          onRetry={() => void salon.refetch()}
          retrying={salon.isFetching}
        />
      </TrendCard>
    );
  }

  /*
   * A ZONE ARRIVED AND `Intl` DOES NOT KNOW IT. Named rather than papered over:
   * see `salesTrendRules.ts § localDate`. There is no retry, because retrying
   * returns the same zone — the fix is in Settings and the sentence says so.
   */
  if (window === null) {
    return (
      <TrendCard scope={null} caption={null}>
        <UnusableZone zone={zone ?? ''} />
      </TrendCard>
    );
  }

  return <SalesTrendBody from={window.from} to={window.to} />;
}

/**
 * The query half. `branch: 'all'` is not a default being left alone — it is the
 * decision argued at `salesTrendRules.ts § trendScope`, and the echo is checked
 * against it below rather than trusted.
 */
export function SalesTrendBody({ from, to }: { from: string; to: string }) {
  const { selected } = useBranchScope();
  const filters: ReportFilters = {
    branch: ALL_BRANCHES,
    period: rangeToken(from, to),
    compare: null,
  };
  const report = useReport('sales', filters);

  /*
   * STALE-NOT-BLANK (§4), and a REFUSAL IS EXCLUDED — the rule `Overview.tsx`
   * applies to the tiles and the feed, applied a third time to the same screen's
   * third panel. A 403 means this staff member may not see these figures, and
   * holding a chart of them on screen behind a retry shows her precisely what
   * she is not allowed to see. The banner §4 asks for is the one the Overview
   * already renders above the KPI row; this card does not draw a second.
   */
  const apiError = report.error instanceof ApiError ? report.error : null;
  const forbidden = apiError?.isForbidden ?? false;
  const keepStale = report.isError && !forbidden && report.data !== undefined;

  if (report.isPending) {
    return (
      <TrendCard scope={null} caption={windowCaption(from, to)}>
        <TrendSkeleton />
      </TrendCard>
    );
  }

  if (report.isError && !keepStale) {
    // 401 — the shell is already redirecting. A refusal here would flash for one
    // frame and tell the merchant she lacks a permission she actually holds.
    if (apiError?.isUnauthenticated) return null;
    return (
      <TrendCard scope={null} caption={windowCaption(from, to)}>
        <TrendUnavailable
          error={report.error}
          onRetry={() => void report.refetch()}
          retrying={report.isFetching}
        />
      </TrendCard>
    );
  }

  if (report.data === undefined) return null;
  return <LoadedTrend report={report.data} selected={selected} />;
}

/**
 * Everything from here down is a function of a `Report` and the held branch
 * selection, so `salesTrendRender.test.tsx` drives it directly — no query
 * client, no session. `earningsByBranchRender.test.tsx` records what goes wrong
 * when the only way to assert a rendering is to read the source.
 */
export function LoadedTrend({ report, selected }: { report: Report; selected: string }) {
  const scope = trendScope(selected, report);
  /*
   * THE CAPTION IS THE SERVER'S MEASURED WINDOW, NOT THE REQUEST. `windowPhrase`
   * is keyed on `basis` and renders "13 Sep 2026 – 26 Sep 2026" for a calendar
   * window — the same sentence Reports prints under its own cards, so the two
   * screens name a window identically.
   */
  const caption = windowPhrase(report.window);
  const series = seriesFrom(report);

  if (!series.ok) {
    /*
     * A PAYLOAD THIS CARD CANNOT DRAW HONESTLY. Neither of these is a merchant
     * situation and neither has a retry that would change anything, so both
     * explain and stop. They are named separately because "the workspace
     * answered with a rolling window" and "a gross figure arrived with a
     * fraction in it" send a reader to two completely different places.
     */
    return (
      <TrendCard scope={scope} caption={caption}>
        <div className="trend-card__state">
          <ErrorState
            title="Couldn't chart these days"
            body={
              series.reason === 'rolling-window'
                ? 'This workspace measured the last few days as a rolling window rather than whole days, so there are no days to draw. The figures above are unaffected.'
                : 'A gross figure came back with a fraction of a fils in it, which money in this system cannot have. Nothing has been drawn rather than drawn wrongly.'
            }
          />
        </div>
      </TrendCard>
    );
  }

  const days = series.days;
  const peak = peakFils(days);

  if (peak <= 0) {
    /*
     * EMPTY, AND IT NAMES THE WINDOW AND THE CAUSE (§4). Keyed on the PEAK and
     * not on `rows.length`, because those are two different empties and only
     * one of them is "nothing happened": a day can carry settled transactions
     * and no gross at all — `Reports.tsx § GROSS IS THE VISIT` records that an
     * appointment a held deposit covered outright settles with a wallet charge
     * of exactly 0.000. Both produce a chart with no bar in it, so both need a
     * sentence, and the transaction count is what tells them apart.
     *
     * NO ACTION BUTTON, AND THE SENTENCE CARRIES IT INSTEAD. §4 asks an empty
     * state to offer "the one action that fills it", and here that action is
     * someone scanning a customer's QR on the salon phone — for the reason the
     * feed's empty gives: nothing on this dashboard writes a settled charge. A
     * `Button` would have to either navigate somewhere that cannot help or do
     * nothing at all, so the remedy is NAMED in the copy and not mimed by a
     * control. `EmptyState`'s `action` is optional for exactly this case.
     */
    const txns = totalTransactions(days);
    return (
      <TrendCard scope={scope} caption={caption}>
        <div className="trend-card__state">
          <EmptyState
            title="No gross in these days"
            body={
              txns > 0
                ? `${txns} ${txns === 1 ? 'visit' : 'visits'} settled between ${formatWindowDay(series.from)} and ${formatWindowDay(series.to)}, and none of them carried gross — a visit a held deposit covered outright settles at 0.000. The chart draws again on the first charge that takes money.`
                : `Nothing settled between ${formatWindowDay(series.from)} and ${formatWindowDay(series.to)}. Days appear here as your team charges customers on the salon phone.`
            }
          />
        </div>
      </TrendCard>
    );
  }

  return (
    <TrendCard scope={scope} caption={caption}>
      <TrendChart days={days} peak={peak} caption={caption} />
      <TrendFoot scope={scope} />
    </TrendCard>
  );
}

/* --------------------------------------------------------------- the states -- */

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FOUR STATES ARE COMPONENTS, NOT TERNARIES INSIDE A HOOK-OWNING FUNCTION
 * ═══════════════════════════════════════════════════════════════════════════
 * They were inline, which typechecked and rendered and left every one of them
 * assertable only by reading the source. `earningsByBranchRender.test.tsx` is
 * this codebase's record of where that ends: the whole defect it exists to stop
 * was a defect of PLACEMENT, invisible in source text and visible only in the
 * tree, and nothing could build the tree because the component needed a query
 * client, a session and a branch scope.
 *
 * All three below take a bare `unknown` error, or a bare string, and nothing
 * else — no hook, no context — so `salesTrendRender.test.tsx` renders each
 * refusal directly. None of them owns a `TrendCard`: the caller does, so the
 * card's head is identical in every state and cannot drift between them.
 */

/**
 * THE SALON READ FAILED, SO THERE IS NO ZONE AND THEREFORE NO WINDOW.
 *
 * NOT "the chart failed", and the distinction is the sentence: nothing has been
 * asked of the reports endpoint yet, and the retry belongs to the salon query.
 * A 403 here is `requireSameSalon` — "that salon is not yours" — which no button
 * fixes, so it gets no button and renders the server's own copy rather than a
 * paraphrase, exactly as `Overview.tsx § MetricsError` does.
 */
export function WindowUnknown({
  error,
  onRetry,
  retrying,
}: {
  error: unknown;
  onRetry: () => void;
  retrying: boolean;
}) {
  const apiError = error instanceof ApiError ? error : null;
  if (apiError?.isForbidden ?? false) {
    return (
      <div className="trend-card__state">
        <ErrorState title="You don't have access to this" body={apiError?.message ?? ''} />
      </div>
    );
  }
  /* OFFLINE IS ITS OWN STATE, not "something went wrong" (§4) — the correction
     the activity feed beside this card already had to make once. */
  const offline = apiError?.isConnectivity ?? false;
  return (
    <div className="trend-card__state">
      <ErrorState
        title={offline ? 'No connection' : "Couldn't load the salon"}
        body={
          offline
            ? "We can't reach the workspace, so we don't know which days to chart. Your figures above are the last we loaded."
            : "The workspace didn't answer, so we don't know which days to chart. Your figures above are unaffected."
        }
        onRetry={onRetry}
        retrying={retrying}
      />
    </div>
  );
}

/**
 * A ZONE ARRIVED AND `Intl` DOES NOT KNOW IT — `salesTrendRules.ts § localDate`.
 *
 * NO RETRY, BECAUSE RETRYING RETURNS THE SAME ZONE. The remedy is a Settings
 * field and the sentence names it, which is the §4 rule about an empty state
 * naming the one action that fills it applied to a refusal. The zone is quoted
 * back so the merchant can see WHICH string is wrong — "your time zone is
 * invalid" sends her looking, and she has one field to look in.
 */
export function UnusableZone({ zone }: { zone: string }) {
  return (
    <div className="trend-card__state">
      <ErrorState
        title="Couldn't work out your salon's days"
        body={`This salon's time zone is set to “${zone}”, which we don't recognise, so we can't tell where one day ends and the next begins. Set it in Settings and this chart will draw.`}
      />
    </div>
  );
}

/**
 * THE REPORT READ FAILED. Three answers, and the third is the plain one.
 *
 * "YOUR FIGURES ABOVE ARE UNAFFECTED" IS THE LOAD-BEARING CLAUSE, borrowed from
 * the activity feed for the reason the feed borrowed it: this card is one panel
 * of four on a screen whose other three are fine, and a merchant who reads a
 * failure here and concludes her KPI tiles are also wrong goes looking for money
 * that never moved.
 */
export function TrendUnavailable({
  error,
  onRetry,
  retrying,
}: {
  error: unknown;
  onRetry: () => void;
  retrying: boolean;
}) {
  const apiError = error instanceof ApiError ? error : null;
  if (apiError?.isForbidden ?? false) {
    return (
      <div className="trend-card__state">
        <ErrorState title="You don't have access to this" body={apiError?.message ?? ''} />
      </div>
    );
  }
  const offline = apiError?.isConnectivity ?? false;
  return (
    <div className="trend-card__state">
      <ErrorState
        title={offline ? 'No connection' : "Couldn't load the chart"}
        body={
          offline
            ? "We can't reach the workspace. Your figures above are the last we loaded."
            : "The workspace didn't answer. Your figures above are unaffected."
        }
        onRetry={onRetry}
        retrying={retrying}
      />
    </div>
  );
}

/* --------------------------------------------------------------- the chart -- */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * `2026-09-13` → `Sun 13 Sep`. Derived from the date STRING at UTC midnight, so
 * the weekday is the one the salon's calendar shows — `formatWindowDay` in
 * `api/reports.ts` argues the same point: these are decided calendar dates, not
 * instants to be re-converted into the browser's zone.
 */
export function dayLabel(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  const weekday = WEEKDAYS[new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()];
  const full = formatWindowDay(ymd);
  /* "Sun 13 Sep 2026" → the year is in the caption; the bar does not repeat it. */
  return `${weekday ?? ''} ${full.replace(/ \d{4}$/, '')}`.trim();
}

/** The number under a bar. The month and year are the caption's job. */
function dayOfMonth(ymd: string): string {
  const m = /^\d{4}-\d{2}-(\d{2})$/.exec(ymd);
  return m ? String(Number(m[1])) : ymd;
}

/**
 * ONE BAR'S ACCESSIBLE NAME, AND IT CARRIES BOTH SERIES.
 *
 * The bars encode GROSS and nothing else — a second encoded series would need a
 * second axis and the card has room for neither. But `transactions` arrives on
 * the same rows and answers the other question a merchant asks of a day ("busy,
 * or one big client?"), so it rides the label: no toggle, no second chart, no
 * state, and it is text rather than a hover, so a keyboard and a screen reader
 * both reach it. The visible caption says the bars are gross, so nothing here
 * claims the count is drawn.
 *
 * `formatFils` is the only money formatter (#1) — three decimals, Western
 * digits, grouped above a thousand.
 */
export function pointLabel(day: DayPoint): string {
  const count = `${day.transactions} ${day.transactions === 1 ? 'transaction' : 'transactions'}`;
  return `${dayLabel(day.date)}: ${formatFils(day.grossFils)} KD, ${count}`;
}

export function TrendChart({
  days,
  peak,
  caption,
}: {
  days: readonly DayPoint[];
  peak: Fils;
  caption: string;
}) {
  return (
    <>
      {/*
        THE SUMMARY A SIGHTED READER GETS FROM THE SHAPE. The axis below is
        `aria-hidden` — two floating numbers read aloud are noise — so the scale
        is stated here in a sentence instead, and then the list walks the series.
      */}
      <p className="avo-sr-only">
        Gross by day for {caption}. The tallest day is {formatFils(peak)} KD. Bars show gross only;
        each day also names its transaction count.
      </p>
      <div className="trend__plot">
        <div className="trend__axis" aria-hidden="true">
          <span className="trend__axis-tick">{formatFils(peak)}</span>
          <span className="trend__axis-tick">0.000</span>
        </div>
        <ul className="trend__days">
          {days.map((day) => (
            <li key={day.date} className="trend__day">
              <span className="trend__track" aria-hidden="true">
                {/*
                  HEIGHT IS AN INTEGER PERMILLE OF THE TALLEST DAY — § barPermille.
                  `data-zero` is not a value: it is the day saying it exists. A
                  day with no gross draws at the same minimum height as a day
                  with almost none, so without it "nothing happened" and "the bar
                  is too short to see" are the same picture. The hairline
                  treatment tells them apart.
                */}
                <span
                  className="trend__bar"
                  style={{ height: `${barPermille(day.grossFils, peak) / 10}%` }}
                  {...(day.grossFils === 0 ? { 'data-zero': 'true' } : {})}
                />
              </span>
              <span className="trend__day-num" aria-hidden="true">
                {dayOfMonth(day.date)}
              </span>
              <span className="avo-sr-only">{pointLabel(day)}</span>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

/**
 * The two sentences the bars cannot say for themselves. Both are conditions of
 * the DATA rather than standing prose, which is `AssumedNote`'s deciding
 * property: the `narrowed` line disappears the moment a workspace honours
 * `?branch=all`, with no code change and nobody remembering to remove it.
 */
export function TrendFoot({ scope }: { scope: TrendScope }) {
  return (
    <div className="trend-card__foot">
      {scope.kind === 'narrowed' ? (
        /*
         * THE ONE CASE WHERE THE HEADING'S QUALIFIER WOULD BE A LIE. This card
         * asked for every branch and the workspace answered with one, so the
         * bars are that branch's. The `.avo-stale` treatment is reused verbatim
         * from `Overview.tsx § ScopeNotice` — same warn tint, same dot, same
         * type — because this product already has a way of saying "the numbers
         * under this are not what you think" and a second one would be a second
         * thing to learn.
         */
        <div className="avo-stale" role="status">
          <span className="avo-stale__dot" aria-hidden="true" />
          <span className="avo-stale__text">
            This workspace narrowed the chart to one branch rather than the whole salon, so these
            bars are not every branch&rsquo;s takings.
          </span>
        </div>
      ) : null}
      <p className="trend-card__note">
        Complete days only — today is still trading, so it is not a bar yet.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------ the skeleton -- */

/**
 * THE SKELETON'S SHAPE IS THE CHART'S SHAPE. `TREND_DAYS` tracks, one axis
 * column, one row of day numbers — the same three parts in the same three
 * places, so the card does not reflow when the bars arrive.
 *
 * `REPORT_SKELETON` in `api/reports.ts` exists because of exactly this lesson
 * ("a skeleton whose shape does not match what replaces it is a worse loading
 * state than none: it promises a layout and then reflows the screen out from
 * under the reader"), and the number here is not a guess the way its row counts
 * are: this card fixes its own window, so fourteen is what fourteen will be.
 *
 * NO BAR IS DRAWN AT A HEIGHT. A skeleton bar at 40% is a figure, and a figure
 * that turns out to be a loading state is the `0.000` hazard in another
 * register. Each track holds one full-height `Skeleton` block instead, which
 * says "a bar goes here" and claims nothing about how tall.
 */
export function TrendSkeleton() {
  return (
    <div aria-hidden="true">
      <div className="trend__plot">
        <div className="trend__axis">
          <Skeleton width={46} height={11} />
          <Skeleton width={46} height={11} />
        </div>
        <ul className="trend__days trend__days--loading">
          {Array.from({ length: TREND_DAYS }, (_, i) => (
            <li key={i} className="trend__day">
              <span className="trend__track">
                <Skeleton width="100%" height="100%" />
              </span>
              <span className="trend__day-num">
                <Skeleton width={12} height={10} />
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** The window as this card asked for it — the head's caption before any echo. */
function windowCaption(from: string, to: string): string {
  return `${formatWindowDay(from)} – ${formatWindowDay(to)}`;
}
