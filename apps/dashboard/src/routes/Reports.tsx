import { useState } from 'react';
import { fils, formatFils } from '@avo/types';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  InfoBanner,
  InlineError,
  Money,
  Segmented,
  Skeleton,
  TextField,
} from '@avo/ui';
import {
  downloadReportCsv,
  PERIOD_SEGMENT_LABEL,
  rangeToken,
  REPORT_DESC,
  REPORT_FULL_TABLE,
  REPORT_KINDS,
  REPORT_PERIODS,
  REPORT_SKELETON,
  useReport,
  windowLabel,
  windowPhrase,
  type Report,
  type ReportColumn,
  type ReportComparison,
  type ReportFilters,
  type ReportKind,
  type ReportPeriod,
  type ReportWindow,
} from '../api/reports.js';
import { useSalon } from '../api/salon.js';
/*
 * ONE LIST GRAMMAR FOR ONE SENTENCE. `BranchAssumedCaveat` below prints the
 * wording `AssumedNote` already prints on the Overview, so it joins its clauses
 * with the same function rather than a second one. See `Overview.tsx §
 * joinClauses`.
 */
import { joinClauses } from './Overview.js';
import { useSalonId } from '../auth/AuthProvider.js';
import { ALL_BRANCHES, useBranchScope } from '../shell/BranchScope.js';
import { ApiError } from '../api/client.js';
import { badRequestAnswer, isForbidden, SectionError } from './sectionState.js';

/**
 * Merchant → Reports. Six cards off `GET /salons/{id}/reports/{kind}`, each with
 * its CSV export — `AVO Merchant Dashboard.dc.html:416` § REPORTS, built to the
 * contract addendum rather than the drawn export where the two differ (the seven
 * departures are the contract now).
 *
 * THE FIFTH CARD IS NOT DRAWN IN THE BUNDLE. `artist-performance` is Aftab's
 * request for staff statistics — "how many customer dealt, most earning, etc" —
 * and there is no artboard for it, so it is built to the four that are: same
 * card, same head, same stat corner, same foot, same export button, same 403
 * treatment. The two places it departs are both forced by its data rather than
 * chosen, and each is argued where it happens: it renders EVERY row instead of a
 * three-row preview (§ data-wide), and it draws its rows in TWO GROUPS because two
 * of them are not people (§ AttributedRows).
 *
 * =========================================================================
 * A 403 CARD IS THE PERMISSION LEDGER RENDERING, NOT AN ERROR STATE
 * =========================================================================
 * Each kind is gated on the permission of the section it exports (customers→team,
 * sales→dashboard, best-selling-services→appointments, products-sold→shop), so a
 * front-desk manager may watch Sales load while Customers refuses BESIDE it. Each
 * card is its own query for exactly that reason, and a refused card renders the
 * server's own sentence in place — the screen does not treat one refusal as a
 * failure of the section, and it does not hide the card, because a card that
 * silently vanishes reads as "this report does not exist" rather than "you are
 * not allowed this one". No client courtesy gate: every read is server-gated, so
 * a second check here would duplicate the gate and drift from it (#7).
 *
 * =========================================================================
 * NOTHING ON THIS SCREEN IS COMPUTED FROM ROWS
 * =========================================================================
 * The stat, the row count and the aggregate all arrive decided; the addendum's
 * whole design is one aggregate rendered two ways so the card and the file cannot
 * disagree. The one presentation decision the contract explicitly left here is
 * the tier's capitalisation (departure #6: `silver` on the wire), done in
 * `cellText`. Money arrives as integer fils and is formatted only by `<Money>`.
 */
export function Reports() {
  const salonId = useSalonId();
  const salon = useSalon();

  /*
   * ===========================================================================
   * THE BRANCH FILTER IS NO LONGER THIS SCREEN'S OWN STATE — IT IS THE SHELL'S
   * ===========================================================================
   * This was `useState('all')`, and it was the only branch selection in the
   * product. The header now carries one too (`shell/BranchSelector.tsx`), and
   * two independent selections rendered on the same page is a worse bug than
   * the one the header fix removed: the header would say "All branches" while
   * the card beside it said "Salmiya", and neither would be wrong about itself.
   *
   * WHY BIND RATHER THAN DELETE THE SEGMENT BELOW. The design bundle draws this
   * control on this screen (`AVO Merchant Dashboard.dc.html` § REPORTS) and does
   * not draw the header's; deleting a drawn control to make room for an
   * undrawn one would be the restyle CLAUDE.md forbids, and it would also take
   * the branch filter away from the screen where filtering is the entire point.
   * So both render and both are views of ONE value: change either and the other
   * moves. One selection, two places to reach it, no way for them to disagree.
   *
   * The state moved; nothing else here did. `?branch=` still takes the id,
   * `'all'` is still the sentinel, and the options are still built from the
   * salon's own branch list below.
   */
  const { selected: branch, select: setBranch } = useBranchScope();
  /*
   * ONE OBJECT, NOT SIX `useState`s, and it is a value rather than a spread of
   * them so that the two derivations below and the one reducer in
   * `selectPeriodSegment` are PURE FUNCTIONS OF IT — testable without a query
   * client, a router or a session. The controls themselves are
   * `WindowControls`, which takes this value and gives back the next one: the
   * screen owns the state, the component owns the markup, and a test can drive
   * the markup.
   */
  const [selection, setSelection] = useState<WindowSelection>(DEFAULT_WINDOW_SELECTION);

  const periodToken = periodTokenOf(selection);
  const compareToken = compareTokenOf(selection);

  /*
   * The branch segment needs the branch NAMES, and `?branch=` takes the ID
   * (departure #5) — so the salon load gates the controls, and a failure here is
   * a section-level error rather than four healthy cards over a control that
   * cannot render. The cards themselves each carry their own state.
   */
  if (salon.isError) {
    return (
      <SectionError
        error={salon.error}
        forbiddenTitle="You don't have access to reports"
        failedTitle="Couldn't load the salon"
        onRetry={() => void salon.refetch()}
        retrying={salon.isFetching}
      />
    );
  }

  const branches = salon.data?.branches ?? [];
  const branchName = branches.find((b) => b.id === branch)?.name ?? null;
  /*
   * ONE `filters` OBJECT FOR SIX CARDS AND FOR THE EXPORT, so the file and the
   * cards cannot be asking different questions — except for `compare`, which
   * `api/reports.ts` § exportQuery drops on the way to the file and which
   * `ExportNote` says out loud.
   */
  const filters: ReportFilters | null =
    periodToken === null ? null : { branch, period: periodToken, compare: compareToken };

  return (
    <div className="reports">
      <InfoBanner icon={<BarsGlyph />}>
        Pull any list as a CSV — open it in Excel or Google Sheets. Filter by branch and period
        first; the export matches exactly what you see.
      </InfoBanner>

      <div className="reports__controls">
        {salon.isPending ? (
          <Skeleton width={220} height={38} />
        ) : (
          <Segmented
            label="Branch"
            value={branch}
            onChange={setBranch}
            options={[
              { value: ALL_BRANCHES, label: 'All branches' },
              /* The segment renders the name; the value it sends is the id. */
              ...branches.map((b) => ({ value: b.id, label: b.name })),
            ]}
          />
        )}
        {/*
          * THE DRAWN THREE, PLUS A FOURTH. `AVO Merchant Dashboard.dc.html:427`
          * draws Week / Month / Quarter and nothing else; `Dates` is invented.
          * See § THE FOURTH SEGMENT below for why it is a fourth option on this
          * control rather than a separate one.
          */}
        <Segmented<PeriodSegment>
          label="Period"
          value={selection.periodSeg}
          onChange={(next) => setSelection(selectPeriodSegment(selection, next))}
          options={[
            ...REPORT_PERIODS.map((p) => ({ value: p, label: PERIOD_SEGMENT_LABEL[p] })),
            { value: 'custom' as const, label: 'Dates' },
          ]}
        />
      </div>

      <WindowControls value={selection} onChange={setSelection} />

      {filters === null ? (
        /*
         * THE CARDS ARE NOT LOADING AND THEY ARE NOT EMPTY — nothing has been
         * asked yet. A skeleton here would promise an answer that is not coming,
         * and stale cards from the previous window under a half-typed range
         * would be the worse of the two: figures on screen that no longer
         * describe the control above them.
         */
        <EmptyState
          title="Name both days"
          body="Pick a From and a To date and the six reports will load for that window."
        />
      ) : (
        <div className="reports__grid">
          {REPORT_KINDS.map((kind) => (
            <ReportCard
              key={kind}
              kind={kind}
              salonId={salonId}
              filters={filters}
              branchName={branchName}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------- the window controls -- */

/**
 * ===========================================================================
 * § THE FOURTH SEGMENT — NEW WORK. THE DESIGN DRAWS THREE AND NO DATE PICKER.
 * ===========================================================================
 * `AVO Merchant Dashboard.dc.html:427` is three buttons — Week, Month, Quarter
 * — and nothing beside them. Aftab's item 9 is "compare with dates", and dates
 * are not expressible in three words, so a range control is INVENTED. Said
 * plainly, the way the vouchers panel and the no-show return window were, so a
 * later reader does not go looking for it in the bundle. The design's own
 * sentence on this page — "Filter by branch and period first; the export matches
 * exactly what you see" — is what constrains the rest of this file.
 *
 * WHY A FOURTH SEGMENT RATHER THAN A SEPARATE CONTROL. The period is ONE choice
 * — a preset or a range, never both — and `Period` on the server is a
 * discriminated union saying exactly that. Two controls would be two sources for
 * one value and would need a rule about which wins; this screen already paid for
 * that mistake once, when the branch filter existed twice (§ THE BRANCH FILTER
 * IS NO LONGER THIS SCREEN'S OWN STATE). A fourth segment leaves the drawn three
 * untouched and adds only the case they cannot express.
 *
 * WHAT WAS REJECTED
 *   - A CALENDAR POPOVER. A month grid, a range selection model, focus
 *     management and its own keyboard contract — a component with no artboard to
 *     build it against, in a bundle whose interaction spec covers the controls it
 *     drew. `input[type=date]` is the platform's own picker: it brings the
 *     locale's format, the keyboard, and the mobile date wheel for free, and it
 *     is a control every merchant has already used.
 *   - TWO FREE-TEXT `YYYY-MM-DD` FIELDS. They invite precisely the malformed
 *     value the server answers `400 invalid_period` to, and turn a typo into a
 *     round trip. `type=date` constrains the input at the source without this
 *     screen owning a grammar.
 *   - REPLACING THE THREE PRESETS WITH A PICKER. It would delete drawn controls
 *     to make room for an undrawn one — the restyle CLAUDE.md forbids — and
 *     would make "this month" something a merchant has to spell out every time.
 *   - A `?from=`/`?to=` PAIR ON THE WIRE. Not this client's to choose: the
 *     server took a single `period` token so that one value names the window in
 *     the filename, the audit row and the download record. `rangeToken` composes
 *     it; nothing here parses one.
 */

/** The drawn three plus the invented fourth. See § THE FOURTH SEGMENT. */
export type PeriodSegment = ReportPeriod | 'custom';
export type CompareSegment = 'none' | 'previous' | 'dates';

/**
 * Everything the two window controls hold, as ONE value.
 *
 * Six `useState`s would have been the obvious shape and would have put the three
 * rules below — what a half-typed range sends, what `previous` means when the
 * period is a range, and what happens to `previous` when she switches to one —
 * inside a component that cannot be rendered without a session, a query client
 * and a branch scope. As a value with pure functions over it, each rule is a
 * function a test calls directly, and `WindowControls` is a presentational
 * component a test can drive with `fireEvent`.
 */
export interface WindowSelection {
  periodSeg: PeriodSegment;
  /** `YYYY-MM-DD`, or '' for not yet named. */
  periodFrom: string;
  periodTo: string;
  compareSeg: CompareSegment;
  compareFrom: string;
  compareTo: string;
}

/** `30d`, which is what this screen asked for before ranges existed. */
export const DEFAULT_WINDOW_SELECTION: WindowSelection = {
  periodSeg: '30d',
  periodFrom: '',
  periodTo: '',
  compareSeg: 'none',
  compareFrom: '',
  compareTo: '',
};

/**
 * ===========================================================================
 * AN UNFINISHED RANGE IS NOT A REQUEST, AND IT IS THE ONLY THING THIS SCREEN
 * WITHHOLDS
 * ===========================================================================
 * `null` means "she has picked Dates and has not named both days yet".
 *
 * IT IS NOT CLIENT-SIDE VALIDATION OF THE GRAMMAR. Whether the range is the
 * right way round, and whether it is inside 366 days, is the server's to decide;
 * it decides it with a sentence written for a merchant — "period starts after it
 * ends: 2026-03-31 is later than 2026-03-01" — and that sentence renders on the
 * cards (§ THE REFUSED WINDOW). A second opinion in the browser would be
 * `services/period.ts`'s grammar written again in another language, and the
 * first time the two disagreed this screen would refuse a window the server had
 * already measured.
 *
 * What it does withhold is a request the merchant has not finished composing.
 * `?period=2026-03-01_` is not a question she asked, and five refusals while she
 * is still reaching for the second field are noise rather than feedback.
 */
export function periodTokenOf(s: WindowSelection): string | null {
  if (s.periodSeg !== 'custom') return s.periodSeg;
  return s.periodFrom !== '' && s.periodTo !== '' ? rangeToken(s.periodFrom, s.periodTo) : null;
}

/**
 * `compare=previous` IS ONLY DEFINED FOR A ROLLING PERIOD, and the reason is the
 * server's: there is no single "previous" to 1–31 March. February by the name,
 * 29 January – 28 February by the length, and March of last year by the season
 * are three defensible answers, so it refuses rather than picking one.
 *
 * So this returns null for that combination rather than putting a value on the
 * wire that is certain to be refused. The refusal is NOT thereby made
 * unreachable and is not treated as unreachable: `400 invalid_compare` renders
 * the server's own sentence on the card exactly as `invalid_period` does, and
 * `reportsWindow.test.tsx` drives that path directly.
 */
export function compareTokenOf(s: WindowSelection): string | null {
  if (s.compareSeg === 'previous') return s.periodSeg === 'custom' ? null : 'previous';
  if (s.compareSeg !== 'dates') return null;
  return s.compareFrom !== '' && s.compareTo !== '' ? rangeToken(s.compareFrom, s.compareTo) : null;
}

/**
 * Switching the period segment, with the one consequence it has.
 *
 * Moving to a range takes `previous` with it rather than leaving a control
 * selected that the screen is quietly ignoring. A reset that is explained beside
 * the control is better than a selection whose effect silently disappeared — the
 * same judgement `AttributionNote` makes about a zero row.
 */
export function selectPeriodSegment(s: WindowSelection, next: PeriodSegment): WindowSelection {
  if (next === 'custom' && s.compareSeg === 'previous') {
    return { ...s, periodSeg: next, compareSeg: 'none' };
  }
  return { ...s, periodSeg: next };
}

/**
 * The invented controls, as markup only. `Reports` owns the value; this owns how
 * it is asked for. See `Reports` § THE FOURTH SEGMENT for why a fourth segment
 * and not a calendar popover, two text fields, or a replacement for the drawn
 * three.
 */
export function WindowControls({
  value,
  onChange,
}: {
  value: WindowSelection;
  onChange: (next: WindowSelection) => void;
}) {
  const previousAvailable = value.periodSeg !== 'custom';
  const compareIncomplete = value.compareSeg === 'dates' && compareTokenOf(value) === null;

  return (
    <div className="reports__window">
      {value.periodSeg === 'custom' ? (
        <div className="reports__dates">
          <TextField
            label="From"
            type="date"
            value={value.periodFrom}
            onChange={(e) => onChange({ ...value, periodFrom: e.target.value })}
          />
          <TextField
            label="To"
            type="date"
            value={value.periodTo}
            onChange={(e) => onChange({ ...value, periodTo: e.target.value })}
          />
          <p className="reports__hint">
            Both days are included, in your salon&rsquo;s own time. Up to 366 days.
          </p>
        </div>
      ) : (
        /*
         * WHAT A PRESET ACTUALLY MEANS, SAID ONCE — and this is half the answer
         * to "what can a merchant tell about rolling versus calendar from the
         * screen alone". The other half is on every card foot, where the window
         * the SERVER measured is named. This line is about the CONTROL and is
         * derived from the selection; that one is about the DATA and is derived
         * from `window.basis`. If the two ever disagreed the card would be the
         * one telling the truth.
         */
        <p className="reports__hint">
          {PERIOD_SEGMENT_LABEL[value.periodSeg]} is a rolling window — the last{' '}
          {PERIOD_DAYS_WORD[value.periodSeg]} days ending now, not a calendar{' '}
          {PERIOD_CALENDAR_WORD[value.periodSeg]}. Pick <b>Dates</b> for a calendar window.
        </p>
      )}

      <div className="reports__comparerow">
        <Segmented<CompareSegment>
          label="Compare with"
          value={value.compareSeg}
          onChange={(next) => onChange({ ...value, compareSeg: next })}
          options={[
            { value: 'none', label: 'No comparison' },
            /*
             * DISABLED, NOT HIDDEN. `Segmented` keeps a disabled option
             * focusable for exactly this — the reason below it is reachable
             * rather than a control silently vanishing from under the merchant.
             */
            { value: 'previous', label: 'Previous period', disabled: !previousAvailable },
            { value: 'dates', label: 'Other dates' },
          ]}
        />
        {value.compareSeg === 'dates' ? (
          <div className="reports__dates">
            <TextField
              label="Compare from"
              type="date"
              value={value.compareFrom}
              onChange={(e) => onChange({ ...value, compareFrom: e.target.value })}
            />
            <TextField
              label="Compare to"
              type="date"
              value={value.compareTo}
              onChange={(e) => onChange({ ...value, compareTo: e.target.value })}
            />
          </div>
        ) : null}
      </div>

      {previousAvailable ? null : (
        <p className="reports__hint">
          &ldquo;Previous period&rdquo; needs a rolling window. There is no single previous to a
          calendar range — name the second window as dates instead.
        </p>
      )}
      {compareIncomplete ? <p className="reports__hint">Pick both dates to compare.</p> : null}
    </div>
  );
}

const PERIOD_DAYS_WORD: Record<ReportPeriod, string> = { '7d': '7', '30d': '30', '90d': '90' };
const PERIOD_CALENDAR_WORD: Record<ReportPeriod, string> = {
  '7d': 'week',
  '30d': 'month',
  '90d': 'quarter',
};

/**
 * The card's three refusals, in the order they are told apart.
 *
 * Extracted from the card so each is a component a test can render with an
 * `ApiError` and read — `shopRender.test.tsx` § ShopModuleOffNotice set that
 * shape. The card around it (title, description, `data-refused`) does not change
 * between them and is not what any of these assertions are about.
 */
export function ReportCardRefusal({
  error,
  onRetry,
  retrying,
}: {
  error: unknown;
  onRetry: () => void;
  retrying: boolean;
}) {
  if (isForbidden(error)) {
    /*
     * THE LEDGER RENDERING — explain, no retry (interaction-spec.md §4). The
     * server's sentence names the permission's own section and who can grant it,
     * so it is rendered rather than paraphrased. The card stays, titled: a card
     * that vanishes reads as "this report does not exist" rather than "you are
     * not allowed this one".
     */
    return (
      <ErrorState
        title="You don't have access to this report"
        body={error instanceof Error ? error.message : ''}
      />
    );
  }

  const refusedWindow = badRequestAnswer(error);
  if (refusedWindow !== null) {
    /*
     * =====================================================================
     * § THE REFUSED WINDOW — AND IT IS A CARD STATE, NOT A SCREEN STATE
     * =====================================================================
     * `400 invalid_period` / `400 invalid_compare`. Before this branch existed a
     * refused window fell into the generic case below and rendered "Something
     * went wrong on our side" over a server that had answered precisely —
     * "period starts after it ends: 2026-03-31 is later than 2026-03-01", a
     * sentence that names the fix. Merchant READ paths had no 400 until this
     * screen could compose a window; `WriteError` has rendered a 400 verbatim
     * for exactly this reason since it was written.
     *
     * NO RETRY. An identical request produces an identical refusal — the same
     * argument the 403 above makes.
     *
     * WHY IT IS NOT HOISTED TO ONE BANNER OVER THE GRID, even though all six
     * cards will usually carry the same sentence: `build` in
     * `api/src/routes/reports.ts` checks the PERMISSION BEFORE IT PARSES THE
     * PERIOD, deliberately, so a card the merchant may not read answers 403 and
     * never learns whether the window was valid. One card's 400 is therefore not
     * a fact about the screen — a front-desk manager with `dashboard` and not
     * `team` would see a window refusal hoisted over a Customers card that was
     * refused for an entirely different reason. Each card reports the answer it
     * actually got.
     */
    return <ErrorState title="Check the filters above" body={refusedWindow} />;
  }

  return (
    <ErrorState
      title="Couldn't load this report"
      body="The workspace didn't answer. The other cards are unaffected."
      onRetry={onRetry}
      retrying={retrying}
    />
  );
}

/**
 * The design's `{{ r.rowCount }} rows · {{ periodLabel }}`.
 *
 * THE LABEL NAMES THE WINDOW THE SERVER MEASURED, not the token this client
 * asked for. It was `PERIOD_CAPTION[r.period]`, which was a total function over
 * the three presets and became a lookup miss the moment `period` could be a
 * range: the foot would have read "31 rows · undefined". For the three drawn
 * presets this is byte-identical to what it printed before — "This week" /
 * "This month" / "This quarter".
 */
export function reportFootCaption(r: Report): string {
  return `${r.rowCount} row${r.rowCount === 1 ? '' : 's'} · ${windowLabel(r.window)}`;
}

/* --------------------------------------------------------------------- card -- */

function ReportCard({
  kind,
  salonId,
  filters,
  branchName,
}: {
  kind: ReportKind;
  salonId: string;
  filters: ReportFilters;
  /** For the export's fallback filename only — `api/reports.ts` § the export. */
  branchName: string | null;
}) {
  const report = useReport(kind, filters);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<unknown>(null);

  if (report.isError) {
    /*
     * 401 — the session is gone and the shell is redirecting; a refusal here
     * would flash for a frame and claim a missing permission she holds.
     * `Overview.tsx`'s ActivityList set this shape.
     */
    if (report.error instanceof ApiError && report.error.isUnauthenticated) return null;

    return (
      <Card
        className="reports__card"
        data-refused={isForbidden(report.error) || undefined}
        data-wide={REPORT_FULL_TABLE.has(kind) || undefined}
      >
        <div className="reports__head">
          <div>
            <h2 className="reports__title avo-display">{fallbackTitle(kind)}</h2>
            <p className="reports__desc">{REPORT_DESC[kind]}</p>
          </div>
        </div>
        <ReportCardRefusal
          error={report.error}
          onRetry={() => void report.refetch()}
          retrying={report.isFetching}
        />
      </Card>
    );
  }

  const r = report.data;

  async function onExport() {
    setExporting(true);
    setExportError(null);
    try {
      await downloadReportCsv(salonId, kind, filters, branchName);
    } catch (err) {
      setExportError(err);
    } finally {
      setExporting(false);
    }
  }

  return (
    /*
     * `data-wide` SPANS THE GRID, and the reason is arithmetic rather than taste.
     * The other four cards show a THREE-ROW PREVIEW of a file: the card is an
     * invitation to export, and three rows is enough to recognise the shape.
     *
     * This one is a table the merchant reads and decides on, and a slice of three
     * would cut the two unattributed rows off entirely — the rows that exist so the
     * headline is accounted for. It would also truncate the ranking at the third
     * artist, which for a salon of six is the wrong three. So every row renders,
     * and eight columns of it need the full width; at half-width the money columns
     * ellipsise, which on a money table is not a cosmetic loss.
     */
    <Card className="reports__card" data-wide={REPORT_FULL_TABLE.has(kind) || undefined}>
      <div className="reports__head">
        <div>
          {/* The title from the wire — the server names what it returned. */}
          <h2 className="reports__title avo-display">{r ? r.title : fallbackTitle(kind)}</h2>
          <p className="reports__desc">{REPORT_DESC[kind]}</p>
        </div>
        <div className="reports__stat">
          {report.isPending || !r ? (
            /* A money stat skeletons as a bar — never 0.000 before data. */
            <>
              <Skeleton width={64} height={22} />
              <Skeleton width={44} height={11} />
            </>
          ) : (
            <>
              <div className="reports__statvalue avo-display">
                {r.stat.type === 'money' ? <Money amount={fils(r.stat.value)} /> : r.stat.value.toLocaleString('en-US')}
              </div>
              <div className="reports__statlabel">{r.stat.label}</div>
            </>
          )}
        </div>
      </div>

      {r && r.comparison !== null ? (
        <ComparisonStrip period={r.window} comparison={r.comparison} />
      ) : null}

      {report.isPending || !r ? (
        <div className="reports__table">
          {/*
            * THE PLACEHOLDER IS THE SHAPE OF WHAT REPLACES IT. These counts were
            * the literals 4 and 3, correct for the four original kinds and wrong
            * for artist-performance's eight columns and six rows: the card drew a
            * small placeholder and then reflowed into a table twice its size,
            * which is a worse loading state than none because it promises a
            * layout and then moves the screen under the reader.
            * `REPORT_SKELETON` in api/reports.ts carries the per-kind shape and
            * why it is a hint rather than a contract.
            */}
          <div className="reports__cols" aria-hidden="true">
            {Array.from({ length: REPORT_SKELETON[kind].columns }, (_, c) => (
              <span className="reports__col" key={c}>
                <Skeleton width="70%" height={10} />
              </span>
            ))}
          </div>
          {Array.from({ length: REPORT_SKELETON[kind].rows }, (_, n) => (
            <div className="reports__row" key={n} aria-hidden="true">
              {Array.from({ length: REPORT_SKELETON[kind].columns }, (_, c) => (
                <span className="reports__cell" key={c}>
                  <Skeleton width={`${80 - (c % 4) * 10}%`} height={12} />
                </span>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <ReportLoadedBody kind={kind} report={r} />
      )}

      <div className="reports__foot">
        <span className="reports__rowcount">
          {report.isPending || !r ? (
            <Skeleton width={110} height={11} />
          ) : (
            /*
             * The screen's authoritative statement of which window produced the
             * figures above it — see `reportFootCaption`.
             */
            reportFootCaption(r)
          )}
        </span>
        <Button
          disabled={report.isPending || !r || exporting}
          onClick={() => void onExport()}
          className="reports__export"
        >
          <DownloadGlyph />
          {exporting ? 'Exporting…' : 'Export CSV'}
        </Button>
      </div>

      {r && r.comparison !== null ? <ExportNote window={r.window} /> : null}

      {exportError !== null ? (
        <InlineError
          message={
            exportError instanceof Error ? exportError.message : "Couldn't export the file."
          }
        />
      ) : null}
    </Card>
  );
}

/**
 * =========================================================================
 * EVERYTHING BETWEEN THE STAT AND THE FOOT, ONCE THE WIRE HAS ANSWERED — AND
 * IT IS A COMPONENT BECAUSE THE ROUTING IN IT IS WHAT BROKE
 * =========================================================================
 * Three things in card order: the branch-assumed caveat (ABOVE the table), the
 * table, and the kind's footnote (BELOW it). The order is the decision — see
 * `BranchAssumedCaveat` § THE CAVEAT DECISION — and inlined in `ReportCard` it
 * was decided by JSX nobody could render: `ReportCard` needs a query client, a
 * session and a branch scope, so every assertion about which renderer a kind
 * gets, and about where its caveat sits, had to be made by reading the file.
 *
 * That is exactly the hole the defect came through. `REPORT_FULL_TABLE.has(kind)`
 * chose the row renderer while the set had one member and meant two things, and
 * adding a second member sent the branch table through `AttributedRows` — under
 * "Artists, ranked by what they earned", with every branch filed as "Revenue with
 * no artist behind it" and greyed. The source said `REPORT_FULL_TABLE` in both
 * worlds. Only the tree tells them apart, and nothing could build the tree.
 *
 * So the routing is here, it takes a kind and a report and nothing else, and
 * `earningsByBranchRender.test.tsx` renders it directly.
 */
export function ReportLoadedBody({ kind, report }: { kind: ReportKind; report: Report }) {
  return (
    <>
      {/*
        * ABOVE THE TABLE, AND THE PLACEMENT IS THE DECISION.
        * `AttributionNote` sits BELOW its table because its sentences explain
        * figures the reader has already read correctly. This one tells her how to
        * read an order she has not read yet, and a caveat printed under a ranking
        * arrives after the conclusion it was meant to qualify.
        */}
      {kind === 'earnings-by-branch' ? <BranchAssumedCaveat report={report} /> : null}

      <div className="reports__table">
        <div className="reports__cols">
          {report.columns.map((c) => (
            /*
             * `data-numeric` ON THE HEADER AS WELL AS THE CELL, so the wide
             * card's right-alignment comes from the COLUMN TYPE on both rows
             * rather than from a `nth-child` guess about which positions hold
             * figures. A reordered or extra column then cannot leave a header
             * left-aligned over a right-aligned column of money.
             */
            <span
              className="reports__col"
              key={c.key}
              data-numeric={c.type !== 'text' || undefined}
            >
              {c.header}
            </span>
          ))}
        </div>
        {/*
          * THE ROW RENDERER IS KEYED ON THE KIND, NOT ON `REPORT_FULL_TABLE`.
          * While the set had one member the two questions — "show every row" and
          * "group the rows by `attribution`" — had the same answer, so one check
          * served both. `earnings-by-branch` shows every row and has no
          * `attribution` column at all.
          */}
        {kind === 'artist-performance' ? (
          <AttributedRows report={report} />
        ) : kind === 'earnings-by-branch' ? (
          <BranchRows report={report} />
        ) : report.rows.length === 0 ? (
          /*
           * A REAL EMPTY, named with the filter. The stat above reads a true 0
           * from the wire — the same distinction the Analytics chart drew: a zero
           * the API answered is information; a zero before data is a lie.
           *
           * THE PHRASE COMES FROM THE WINDOW THE SERVER MEASURED, not from the
           * token this client asked for — and not through `.toLowerCase()`, which
           * was safe on "This month" and would have printed
           * "1 mar 2026 – 31 mar 2026" over a range. `api/reports.ts` §
           * windowPhrase.
           */
          <p className="reports__none">
            Nothing here for {windowPhrase(report.window)}
            {report.branchId === 'all' ? '' : ' at this branch'}.
          </p>
        ) : (
          report.rows.slice(0, 3).map((row, i) => (
            <div className="reports__row" key={i}>
              {report.columns.map((c) => (
                <span className="reports__cell" key={c.key}>
                  {cellText(row[c.key] ?? null, c.type, c.key)}
                </span>
              ))}
            </div>
          ))
        )}
      </div>

      {kind === 'artist-performance' ? <AttributionNote report={report} /> : null}
      {kind === 'earnings-by-branch' ? <BranchEarningsNote report={report} /> : null}
    </>
  );
}

/* ------------------------------------------------------- the comparison -- */

/**
 * ===========================================================================
 * A DELTA WITHOUT ITS WINDOW IS A NUMBER WITH NO REFERENT
 * ===========================================================================
 * This strip exists because `+240.000` on a card answers nothing. More than
 * what? So the window is in the same sentence as the figure, always, and so is
 * the figure it is a difference FROM — both of which the server sent.
 *
 * WHY A STRIP AND NOT A SECOND STAT COLUMN OR A CHIP
 *   - A SECOND COLUMN in the stat corner puts two large figures side by side
 *     with nothing between them saying which is now and which is then. The
 *     corner is the design's headline slot; two headlines is no headline.
 *   - A CHIP (`▲ 15%`) is the smallest rendering and the least honest one. It
 *     has no room for the window, so the referent moves into a tooltip, and a
 *     `comparable: false` caveat has nowhere to go at all. This screen already
 *     refuses that trade once, in `AttributionNote`: the sentences the numbers
 *     cannot say for themselves get room.
 *   - A FULL SECOND TABLE was rejected by the server before it reached here —
 *     "the card compares the headline; the table shows each window's own rows"
 *     (`services/reports.ts`). The comparison's rows ARE on the wire and are
 *     deliberately not rendered: two arbitrary windows share no days, so the four
 *     kinds whose rows are keyed on a day or a basket produce two tables whose
 *     rows do not correspond, and a reader would line them up anyway. (The count
 *     here read "five of the six" and was an artefact of when it was written:
 *     `artist-performance` and `earnings-by-branch` key their rows on an ARTIST
 *     and a BRANCH, which two windows do share. The decision is unchanged — a
 *     second table doubles the card either way — but the reason does not apply
 *     to those two and should not be cited as though it did.)
 *
 * THE SIGN IS A WORD, NOT A `+`. Prepending "+" to a `<Money>` would put the
 * sign outside the element that owns the `aria-label`: the screen would read
 * "+240.000" and a screen reader would say "240.000 Kuwaiti dinars" — the
 * visible string right and the announced one wrong, which is the exact class
 * this lane's own mutation proof caught in `moneyRender.test.tsx`. "more" and
 * "less" are in the text, so both renderings carry the direction, and `<Money>`
 * formats the magnitude through `formatFils` (#1) with nothing hand-rolled.
 *
 * NOTHING HERE SUBTRACTS. `delta` arrives equal to `stat.value -
 * comparison.stat.value` and carries `stat`'s own `label` and `type`; a second
 * subtraction in the browser is a second answer, and this screen computes
 * nothing from rows for the same reason.
 */
export function ComparisonStrip({
  period,
  comparison,
}: {
  period: ReportWindow;
  comparison: ReportComparison;
}) {
  const { delta, stat, window: other, comparable } = comparison;
  const magnitude = Math.abs(delta.value);
  const figure =
    delta.type === 'money' ? (
      <Money amount={fils(magnitude)} />
    ) : (
      magnitude.toLocaleString('en-US')
    );
  const against =
    stat.type === 'money' ? <Money amount={fils(stat.value)} /> : stat.value.toLocaleString('en-US');

  return (
    <div className="reports__compare" data-direction={deltaDirection(delta.value)}>
      <p className="reports__compare-line">
        <span className="reports__compare-arrow" aria-hidden="true">
          {delta.value > 0 ? '▲' : delta.value < 0 ? '▼' : '—'}
        </span>{' '}
        {delta.value === 0 ? (
          <>
            No change from {against} in {windowPhrase(other)}.
          </>
        ) : (
          <>
            {figure} {delta.value > 0 ? 'more' : 'less'} than {against} in {windowPhrase(other)}.
          </>
        )}
      </p>
      {comparable ? null : (
        /*
         * `comparable` IS THE SERVER'S, AND ONLY THE EXPLANATION IS DERIVED.
         * The boolean decides whether the caveat appears; the two windows'
         * own `basis` and `days` — both already on the wire — say which of the
         * two ways they differ. It exists because two windows can be the same
         * length and still not be the same question, and because calendar June
         * against calendar May is 30 days against 31: a 3% difference in every
         * total before anything about the salon has changed.
         */
        <p className="reports__compare-caveat">{comparabilityCaveat(period, other)}</p>
      )}
    </div>
  );
}

function deltaDirection(value: number): 'up' | 'down' | 'flat' {
  return value > 0 ? 'up' : value < 0 ? 'down' : 'flat';
}

export function comparabilityCaveat(period: ReportWindow, other: ReportWindow): string {
  if (period.basis !== other.basis) {
    return period.basis === 'rolling'
      ? 'Not like for like: a rolling window against a calendar range.'
      : 'Not like for like: a calendar range against a rolling window.';
  }
  if (period.days !== other.days) {
    return `Not like for like: ${period.days} days against ${other.days}.`;
  }
  /* The server said not comparable and neither field says why — report it as it
   * is rather than inventing a reason or, worse, dropping the caveat. */
  return 'Not like for like: these two windows are not the same question.';
}

/**
 * THE OTHER HALF OF `api/reports.ts` § exportQuery.
 *
 * The banner at the top of this screen promises "the export matches exactly what
 * you see", and with a comparison on the card that promise needs saying out
 * loud, because the file cannot keep it: a CSV named for one window cannot
 * contain two, and the server refuses rather than quietly dropping one
 * (`400 compare_not_exportable`). This client drops `compare` from the export
 * URL so the button still works — and then tells her exactly which of the two
 * windows she is about to download, by name.
 *
 * Dropping it silently would have been the same defect the server refused to
 * commit, moved one layer out.
 */
export function ExportNote({ window: w }: { window: ReportWindow }) {
  return (
    <p className="reports__exportnote">
      The file is <b>{windowPhrase(w)}</b> only — a comparison is a figure for this card. Export
      each window on its own and each file keeps its own name.
    </p>
  );
}

/* ------------------------------------------------- the fifth card's table -- */

/**
 * =========================================================================
 * THE ATTRIBUTION COLUMN IS THE PARTITION, AND THE PARTITION IS NOT COSMETIC
 * =========================================================================
 * `artist-performance` answers "who earned the most", and its last two rows are
 * not people. "Walk-in charges" and "Shop orders" are always emitted — even at
 * zero — so that the artist rows can visibly sum to LESS than the headline and the
 * difference is named rather than missing. Rendering all six rows as one list
 * breaks that in a way that looks like a bug in the sort:
 *
 *   Rana Al-Sabah    artist       15.000     <- ranked
 *   Hessa M.         artist        6.000     <- ranked
 *   Dana Yousef      artist        0.000     <- ranked
 *   Shaikha B.       artist        0.000     <- ranked
 *   Walk-in charges  no artist     8.000     <- 8.000 BELOW two zeros
 *   Shop orders      no artist     0.000
 *
 * A merchant reading down that column sees a ranking that stops making sense at
 * row five. Worse, the reading it invites is the one fact #1 forbids: "Walk-in
 * charges" as a competitor in the ranking, or — with the sort read as authority —
 * as the salon's third-best earner.
 *
 * So the two groups are drawn as two groups, each with its own heading, and the
 * server's `attribution` column is what decides which is which. That column exists
 * for exactly this: it is the machine-readable half of "is this row a person", put
 * there so a client does not have to match on a name. Nothing here parses
 * "Walk-in charges".
 *
 * WHAT IS *NOT* DONE HERE, DELIBERATELY
 * -------------------------------------
 *   - NO SORTING. The server already ranks the artist rows by earnings and appends
 *     the two buckets. Re-sorting in the browser would be a second implementation
 *     of the ranking, and the first time the two disagreed the card would
 *     contradict the file exported from the same aggregate.
 *   - NO HIDING OF ZERO ROWS. An artist row of true zeros is the statement "this
 *     artist earned nothing", which is what a bonus decision turns on, and a zero
 *     "Shop orders" row is the statement "every dinar this month had an artist or
 *     a walk-in behind it". Both are findings. Dropping either would make the
 *     table's own arithmetic stop accounting for the headline.
 *   - NO SUBTOTAL. Non-negotiable of this screen: nothing is computed from rows.
 *     An "artists subtotal" line would be a client-side sum sitting next to a
 *     server-side one, and the day they diverge the card argues with itself.
 *     The headline is the server's sum over every row; the rows are all present;
 *     the merchant can check it, which is the property that was asked for.
 */
export function AttributedRows({ report }: { report: Report }) {
  const artists = report.rows.filter((row) => row['attribution'] === 'artist');
  const unattributed = report.rows.filter((row) => row['attribution'] !== 'artist');

  return (
    <>
      <p className="reports__group">
        Artists, ranked by what they earned
      </p>
      {artists.length === 0 ? (
        /*
         * A SALON WITH NO ARTISTS ON THE ROSTER IS NOT AN EMPTY CARD, and this is
         * the state the brief singled out. The two unattributed rows below still
         * carry real money — a salon can take walk-in charges and shop orders with
         * nobody on the roster at all — so blanking the card would hide revenue in
         * order to report an absence. The absence is reported where it is true: in
         * the group that is empty, naming the screen that fixes it.
         *
         * It also cannot be caught by the `rows.length === 0` empty the other four
         * cards use, because this kind always emits the two buckets. Its row count
         * has a floor of two, so that branch is unreachable here — which is why
         * this one is written rather than inherited.
         */
        <p className="reports__none">
          No artists on the roster yet. Add one in Team and her appointments will be
          attributed to her here.
        </p>
      ) : (
        artists.map((row, i) => <FullTableRow key={i} row={row} columns={report.columns} />)
      )}

      <p className="reports__group">
        Revenue with no artist behind it — not part of the ranking
      </p>
      {unattributed.map((row, i) => (
        <FullTableRow key={i} row={row} columns={report.columns} unattributed />
      ))}
    </>
  );
}

/**
 * One row of a FULL TABLE — both kinds that draw one, not just the artist card.
 *
 * It was `AttributedRow`, private to `AttributedRows`, and the rename is the
 * whole of what earnings-by-branch needed from it: `data-numeric` off the column
 * TYPE, every column in the server's order, `cellText` and nothing else touching
 * a figure. Duplicating those eight lines for a second table would have been two
 * places for the money path to drift, which is the one property this row has.
 *
 * `data-unattributed` is what the stylesheet quiets, so the artist card's two
 * bucket rows read as a different KIND of row rather than as two more
 * competitors — and it is set from the group they were partitioned into, never
 * from their text. The branch table has no such partition and never passes it.
 */
function FullTableRow({
  row,
  columns,
  unattributed,
}: {
  row: Record<string, string | number | null>;
  columns: ReportColumn[];
  unattributed?: boolean;
}) {
  return (
    <div className="reports__row" data-unattributed={unattributed || undefined}>
      {columns.map((c) => (
        <span className="reports__cell" key={c.key} data-numeric={c.type !== 'text' || undefined}>
          {cellText(row[c.key] ?? null, c.type, c.key)}
        </span>
      ))}
    </div>
  );
}

/**
 * The two sentences the numbers cannot say for themselves.
 *
 * EARNED IS NOT THE CHARGE ROW, and getting this wrong is not hypothetical: it is
 * the defect that made `sales` under-report by 34.6% (DECISIONS.md 81 and 83). An
 * appointment whose held deposit covered it outright settles with a wallet charge
 * of exactly 0.000, and a report that showed only `Charged KD` and called it
 * earnings would print nothing next to a visit the artist actually performed and
 * was paid for. Three money columns exist so the merchant can see the two halves
 * and their sum; this line says why the sum is the one to read.
 *
 * AND A TOP-UP IS ABSENT ON PURPOSE. It has no row at all, which is the one thing
 * a merchant reconciling this headline against her wallet takings will notice, so
 * it is stated rather than left to be discovered. The reason is that counting it
 * would double-count: the top-up is loaded money, and it becomes revenue on the
 * charge this report is already attributing.
 *
 * THE ZERO-REVENUE PERIOD is named from the SERVER's stat, not from a sum of the
 * rows — the same distinction the rest of this screen keeps. A period where
 * nothing was charged renders as a full table of true zeros, which is correct and
 * also indistinguishable at a glance from a filter mistake; the sentence says
 * which period and which branch produced it. It is added, not substituted: the
 * roster is still worth seeing, and this card is where a merchant learns that
 * every one of her artists earned nothing this week.
 */
export function AttributionNote({ report }: { report: Report }) {
  return (
    <div className="reports__note">
      {report.stat.value === 0 ? (
        <p className="reports__note-empty">
          Nothing was charged {windowPhrase(report.window)}
          {report.branchId === 'all' ? '' : ' at this branch'}, so every row is zero.
        </p>
      ) : null}
      <p>
        <strong>Earned</strong> is what the visit was worth — the wallet charge plus any
        deposit applied — so an appointment a deposit covered outright is not a zero.
      </p>
      <p>
        Top-ups never appear here. Loading a wallet is not revenue in a period; it becomes
        revenue on the charge these rows already attribute.
      </p>
    </div>
  );
}

/* ------------------------------------------- the sixth card's branch table -- */

/**
 * =========================================================================
 * EARNINGS BY BRANCH — EVERY BRANCH, IN THE SERVER'S ORDER, NOTHING GROUPED
 * =========================================================================
 * The aggregate is `FROM branch LEFT JOIN`, so the rows ARE the salon's branch
 * list: a branch that took nothing is a 0.000 row and a branch that closed in
 * March still shows last quarter's money. Both are answers, and an absent row is
 * not — the same argument `AttributedRows` makes about a zero artist, one report
 * over.
 *
 * WHAT IS DELIBERATELY NOT DONE HERE, and each has already been paid for once on
 * this screen:
 *   - NO SLICE. Three rows of a branch list is three branches of however many,
 *     chosen by a sort the reader cannot see. The other four cards preview a
 *     file; this one IS the answer.
 *   - NO RE-SORT. The server orders by gross DESC then name; a second ordering
 *     in the browser is a second ranking, and the day they disagree the card
 *     contradicts the CSV built from the same aggregate.
 *   - NO GROUPING. There is no `attribution` column to partition on and nothing
 *     to partition into. Routing this kind through `AttributedRows` — which is
 *     what `REPORT_FULL_TABLE.has(kind)` did before the card started keying on
 *     the kind — put every branch under "Revenue with no artist behind it".
 *   - NO TOTAL ROW. Nothing on this screen is computed from rows. The headline
 *     is the server's sum over exactly these rows, so the merchant can check it.
 */
export function BranchRows({ report }: { report: Report }) {
  return (
    <>
      {report.rows.map((row, i) => (
        <FullTableRow key={i} row={row} columns={report.columns} />
      ))}
    </>
  );
}

/** A money cell the parse has already guaranteed is an integer, or null. */
function moneyCell(row: Record<string, string | number | null>, key: string): number | null {
  const value = row[key];
  return typeof value === 'number' ? value : null;
}

/**
 * =========================================================================
 * § THE CAVEAT DECISION — AND THE RANKING IS THE PART THAT IS WRONG, NOT THE
 * FIGURES
 * =========================================================================
 * `branch_assumed` does not mean "inferred, and probably right". There is no
 * inference. `api/src/services/branch.ts` is its only writer: with no enrolled
 * till it runs `ORDER BY id LIMIT 2` and takes the first row. So every assumed
 * charge in a salon lands on ONE branch — the lowest id, `BR-KWC` at the seeded
 * salon — and lane A drove it: a real charge on an un-enrolled scanner moved
 * Kuwait City's gross by the whole 7.000 and Salmiya's by nothing.
 *
 * That is directional bias, not noise. It is also why the server put the doubt
 * in TWO COLUMNS rather than a footnote: `Assumed KD` beside `Gross KD` says per
 * branch how much of the figure is an attribution, and it falls to zero on its
 * own as tills are enrolled.
 *
 * WHAT THIS COMPONENT ADDS THAT THE COLUMNS CANNOT. The columns qualify each
 * FIGURE. Nothing in them qualifies the ORDER, and the order is the one
 * rendering this bias destroys: the lowest branch id can sit at the top of the
 * table for want of a scanner, and a merchant reading a league table has no way
 * to see that. `Overview.tsx § AssumedNote` was written for TILES, where four
 * figures sit side by side and the reader is not ranking anything, so its
 * sentence — true, and reused verbatim below — does not cover this. The second
 * paragraph is the part tiles never needed.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO THRESHOLD, WHICH IS THE QUESTION THAT WAS ASKED
 * ---------------------------------------------------------------------------
 * The caveat appears when ANY row has `assumedGrossFils > 0` and never otherwise.
 * No proportion, no cut-off. Three reasons, in the order they decide it:
 *
 *   1. A THRESHOLD ON PROPORTION IS NOT A TEST OF THE THING IN DOUBT. What makes
 *      the order unsafe is the GAP BETWEEN ADJACENT ROWS, not any row's share of
 *      its own gross. 100.000 against 99.000 with 2.000 assumed is 2% and the
 *      order is a coin toss; 100.000 against 3.000 with 50.000 assumed is 50%
 *      and the order is not in doubt at all. A rule that fires on the second and
 *      stays quiet on the first is wrong in both directions at once — it is not
 *      a threshold of anything, it is a decoration.
 *
 *   2. THE TEST THAT WOULD ANSWER IT CANNOT BE BUILT HONESTLY. "Would the order
 *      hold with the assumed money removed" needs a counterfactual table, and
 *      there is none: the assumed dinars are real dinars that happened at SOME
 *      branch. Subtracting them understates the true top branch by exactly what
 *      it overstates the wrong one, and which is which is unknowable here. A
 *      browser-computed "safe ranking" would be a second aggregate, and a wrong
 *      one — on a screen whose standing rule is that nothing is computed from
 *      rows.
 *
 *   3. THE MAGNITUDE QUESTION IS ALREADY ANSWERED, AND NOT BY A CUT-OFF.
 *      `Overview.tsx § assumedClause` faced exactly this and chose the RATIO —
 *      "2 of 2" where the figure is entirely a guess, "1 of 9" where it is
 *      barely one — precisely so that no cut-off had to be invented. Here the
 *      ratio is on the face of the table, per branch, in the two columns the
 *      server added for it. Inventing a percentage cut-off now would be a third
 *      answer to a question this codebase has already answered twice the same
 *      way.
 *
 * SO THE STRENGTHENING IS PLACEMENT AND WORDS, NOT A NUMBER. The note is
 * rendered ABOVE the table rather than under it, because a caveat below a
 * ranking arrives after the reader has formed the conclusion; and it says what
 * the reused sentence does not, which is that the ORDER is not a ranking.
 *
 * NOTHING IS COMPUTED FROM ROWS HERE EITHER. This reads a PREDICATE off each row
 * (`assumedGrossFils > 0`) and a NAME, and prints no figure it derived —
 * `AttributedRows` established that reading rows to make a presentation decision
 * is a different thing from computing a number the wire did not send.
 */
export function BranchAssumedCaveat({ report }: { report: Report }) {
  const doubted = report.rows.filter((row) => (moneyCell(row, 'assumedGrossFils') ?? 0) > 0);
  /*
   * Every dinar on this card was recorded at the branch it says. Say nothing —
   * and say nothing WITHOUT A CODE CHANGE on the day the tills are enrolled,
   * which is `AssumedNote`'s deciding property and holds here for the same
   * reason: the condition is a number that falls to zero, not a flag somebody
   * has to remember to clear.
   */
  if (doubted.length === 0) return null;

  const names = doubted.map((row) => String(row['branch'] ?? '')).filter((n) => n !== '');
  const salonWide = report.branchId === 'all';

  return (
    <div className="reports__assumed" role="status">
      <p>
        {/*
          * VERBATIM FROM `Overview.tsx § AssumedNote`, joined with its own
          * `joinClauses`. Fourth place for this wording — Appointments marks a
          * booking row with it, Settings uses it in the branch-closure warning,
          * the Overview prints it under the KPI tiles. A fourth phrasing of one
          * concept is how a merchant ends up believing there are four concepts.
          */}
        Branch assumed on {joinClauses(names)} — treat these branch figures as approximate.
      </p>
      <p>
        {/*
          * THE SENTENCE TILES NEVER NEEDED. It names the mechanism rather than
          * calling the figures "approximate" a second time, because the merchant
          * can act on the mechanism: enrolling the till is the fix, and it is
          * hers to do.
          */}
        Rows are ordered by gross, and that order is not a ranking: a till that is not enrolled
        to a branch puts its charges on one branch whichever branch they happened at.
      </p>
      <p>
        {salonWide
          ? 'The total above is unaffected — every one of those dinars is inside it, just possibly under the wrong branch.'
          : 'The total above is this branch’s own, so it carries the same assumption.'}
      </p>
    </div>
  );
}

/**
 * The sentences this table cannot say for itself, under it — the counterpart of
 * `AttributionNote`, and the same three jobs.
 *
 * GROSS IS THE VISIT, NOT THE CHARGE ROW. `sales` under-reported by 34.6% by
 * treating the charge as the value of the visit (DECISIONS.md 81 and 83); an
 * appointment a held deposit covered outright settles with a wallet charge of
 * exactly 0.000. This card sums the same `earned_fils` expression, so the
 * definition travels with it.
 *
 * A TOP-UP HAS NO ROW, and this is the card where that will be noticed: a
 * merchant comparing branch gross against the day's wallet takings is doing
 * exactly the reconciliation that discovers it. Counting it would double-count —
 * loaded money becomes revenue on the charge these rows already carry.
 *
 * THE ALL-ZERO PERIOD IS NAMED FROM THE SERVER'S STAT, never from a sum of the
 * rows. A window in which nothing was charged renders as a full table of true
 * zeros, which is correct and at a glance indistinguishable from a filter
 * mistake; the sentence says which window and which branch produced it. Added,
 * not substituted — the branch list is still worth seeing, and a merchant
 * learning that every branch took nothing this week is the point of the card.
 */
export function BranchEarningsNote({ report }: { report: Report }) {
  return (
    <div className="reports__note">
      {report.stat.value === 0 ? (
        <p className="reports__note-empty">
          {/*
            * "EVERY ROW", NOT "EVERY BRANCH". Under a branch filter the table is
            * one row by construction, so "every branch is zero" would be a claim
            * about the salon made from a card showing one branch of it.
            * `AttributionNote` already says "so every row is zero" for the same
            * reason, one report over.
            */}
          Nothing was charged {windowPhrase(report.window)}
          {report.branchId === 'all' ? '' : ' at this branch'}, so every row is zero.
        </p>
      ) : null}
      <p>
        <strong>Gross</strong> is what the visits were worth — the wallet charge plus any deposit
        applied — across charges and shop orders. Top-ups never appear here; loading a wallet is
        not revenue in a period.
      </p>
      <p>
        <strong>Assumed KD</strong> is how much of the gross beside it was attributed rather than
        recorded. It falls as tills are enrolled to their branches.
      </p>
      {/*
        * ONLY AT `branch=all`, because it is a claim about the ROW SET and under
        * a filter the row set is one branch the merchant chose. Telling her
        * "every branch has a row" over a single-row table invites her to count
        * her branches against it and conclude the card has lost two.
        */}
      {report.branchId === 'all' ? (
        <p>
          Every branch has a row, including one that took nothing and one that has since closed —
          a branch that shut in March still earned last quarter&rsquo;s money.
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ helpers -- */

/**
 * The title while the wire has not answered (loading, refused). The same strings
 * the server's `REPORT_TITLE` carries — used only when there is no response to
 * read them from, so a refused card can still say what it is refusing.
 *
 * EXPORTED FOR ITS TEST, and the test is about #7 rather than about copy. A 403
 * card is the permission ledger rendering, and the ONLY thing that names which
 * report was refused is this function — the wire sent no title, because the wire
 * refused. A wrong string here mislabels a refusal; a missing case is a compile
 * error, which is why the switch has no `default`.
 */
export function fallbackTitle(kind: ReportKind): string {
  switch (kind) {
    case 'customers':
      return 'Customer information';
    case 'sales':
      return 'Sales summary';
    case 'best-selling-services':
      return 'Best-selling services';
    case 'products-sold':
      return 'Products sold';
    /**
     * "Artist performance", not "Staff performance", matching the server's own
     * `REPORT_TITLE`. Aftab asked for "staff statistics" and then chose the ARTIST
     * as the person whose earnings these are, and artists and staff accounts are
     * overlapping sets rather than the same set — three of the four seeded artists
     * have no login at all. A card headed "Staff" whose rows are artists would be a
     * label that is not a definition, on the title line.
     */
    case 'artist-performance':
      return 'Artist performance';
    /**
     * "Earnings by branch", the server's own `REPORT_TITLE` — Aftab's words for
     * the request, not the design's, because the design has no card for it.
     *
     * THE COMPILER ASKED FOR THIS LINE AND THAT IS WHY THE SWITCH HAS NO
     * `default`. Adding `earnings-by-branch` to `REPORT_KINDS` turned this
     * function red with TS2366 — "Function lacks ending return statement" —
     * before a single test was written. A `default: return 'Report'` would have
     * accepted the sixth kind silently and shipped a refused card headed
     * "Report", which is the one state where this fallback is the only title the
     * merchant gets.
     */
    case 'earnings-by-branch':
      return 'Earnings by branch';
  }
}

/**
 * The one column whose value this client is allowed to re-case.
 *
 * =========================================================================
 * THIS USED TO BE A HEURISTIC, AND THE FIFTH REPORT BROKE IT
 * =========================================================================
 * The rule was "any single-word lowercase text cell is a domain value", written
 * when the only such cell in the product was the customer tier (`silver` on the
 * wire, departure #6). The comment even said so: "today that is exactly the
 * tier." Artist performance ships two more, and the heuristic mangles both.
 *
 *   `staffAccount` carries a LOGIN HANDLE — `hessa`. Capitalising it prints
 *   `Hessa`, which is not the handle. The whole use of that column is matching a
 *   row to an account in Accounts → Team, and `Hessa` is not a thing to match:
 *   it reads as a person's name, in a column headed "Staff account", beside a
 *   column that already holds her name.
 *
 *   `attribution` carries `artist` and `no artist`. `artist` matches the pattern
 *   and `no artist` does not, so the heuristic capitalises exactly one of two
 *   values from one enum — "Artist" above "no artist" — and the inconsistency
 *   looks like a data defect in the column whose entire job is to be the reliable,
 *   machine-readable half of "is this row a person".
 *
 * So the re-casing is now KEYED to the column it was always about. A new report
 * kind can add lowercase text columns without this renderer deciding, on its own,
 * that they are prose.
 */
const RECASED_COLUMN_KEYS: ReadonlySet<string> = new Set(['tier']);

/**
 * One cell. Money arrives as integer fils and is formatted HERE and nowhere
 * else on the screen (#1); a null money cell renders an em dash rather than
 * 0.000, because "no value" and "zero dinars" are different claims.
 *
 * The tier's capitalisation is the one presentation decision the addendum left
 * to this client (departure #6: the wire says `silver`), and it is applied by
 * COLUMN KEY — see `RECASED_COLUMN_KEYS` for the two columns that proved a
 * value-shape heuristic cannot stand in for that.
 */
export function cellText(
  value: string | number | null,
  type: 'text' | 'int' | 'money',
  key?: string,
): string {
  if (value === null) return '—';
  /*
   * NO COERCION ON THE MONEY PATH. `parseReport` already refused any money or
   * int cell that is not an integer number, so by the time a value reaches this
   * renderer it IS one — and a `Number(value)` here would be a second, silent
   * repair channel that could turn a string the parse should have caught into a
   * plausible figure. A non-number in a money cell renders as the em dash the
   * null case uses, because the honest answer to "the shape lied" is no figure,
   * not a coerced one.
   */
  if (type === 'money') return typeof value === 'number' ? formatFils(fils(value)) : '—';
  if (type === 'int') return typeof value === 'number' ? value.toLocaleString('en-US') : '—';
  const text = String(value);
  if (key !== undefined && RECASED_COLUMN_KEYS.has(key) && /^[a-z]+$/.test(text)) {
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
  /*
   * AN EMPTY STRING IS NOT A MISSING VALUE HERE, so it does not become an em dash.
   * The two unattributed rows of artist-performance carry `staffAccount: ''` on
   * purpose: "Walk-in charges" is not a person, so the question "which staff
   * account" does not apply to it, and an em dash would claim it does and that the
   * answer is unknown. Blank is the honest rendering of a column that does not
   * apply to a row. (An ARTIST with no login is a different claim and the server
   * spells it out: `no staff account`.)
   */
  return text;
}

function BarsGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M3 17V9M8 17V4M13 17v-6M18 17V7"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function DownloadGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M10 3v9m0 0 3.5-3.5M10 12 6.5 8.5M4 15.5h12"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
