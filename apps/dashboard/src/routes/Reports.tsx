import { useState } from 'react';
import { fils, formatFils } from '@avo/types';
import { Button, Card, ErrorState, InfoBanner, InlineError, Money, Segmented, Skeleton } from '@avo/ui';
import {
  downloadReportCsv,
  PERIOD_CAPTION,
  PERIOD_SEGMENT_LABEL,
  REPORT_DESC,
  REPORT_FULL_TABLE,
  REPORT_KINDS,
  REPORT_PERIODS,
  REPORT_SKELETON,
  useReport,
  type Report,
  type ReportColumn,
  type ReportFilters,
  type ReportKind,
  type ReportPeriod,
} from '../api/reports.js';
import { useSalon } from '../api/salon.js';
import { useSalonId } from '../auth/AuthProvider.js';
import { ALL_BRANCHES, useBranchScope } from '../shell/BranchScope.js';
import { ApiError } from '../api/client.js';
import { isForbidden, SectionError } from './sectionState.js';

/**
 * Merchant → Reports. Five cards off `GET /salons/{id}/reports/{kind}`, each with
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
  const [period, setPeriod] = useState<ReportPeriod>('30d');

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
  const filters: ReportFilters = { branch, period };

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
        <Segmented
          label="Period"
          value={period}
          onChange={setPeriod}
          options={REPORT_PERIODS.map((p) => ({ value: p, label: PERIOD_SEGMENT_LABEL[p] }))}
        />
      </div>

      <div className="reports__grid">
        {REPORT_KINDS.map((kind) => (
          <ReportCard key={kind} kind={kind} salonId={salonId} filters={filters} />
        ))}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------- card -- */

function ReportCard({
  kind,
  salonId,
  filters,
}: {
  kind: ReportKind;
  salonId: string;
  filters: ReportFilters;
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
        {isForbidden(report.error) ? (
          /*
           * THE LEDGER RENDERING — explain, no retry (interaction-spec.md §4).
           * The server's sentence names the permission's own section and who can
           * grant it, so it is rendered rather than paraphrased. The card stays,
           * titled: a card that vanishes reads as "this report does not exist"
           * rather than "you are not allowed this one".
           */
          <ErrorState
            title="You don't have access to this report"
            body={report.error instanceof Error ? report.error.message : ''}
          />
        ) : (
          <ErrorState
            title="Couldn't load this report"
            body="The workspace didn't answer. The other cards are unaffected."
            onRetry={() => void report.refetch()}
            retrying={report.isFetching}
          />
        )}
      </Card>
    );
  }

  const r = report.data;

  async function onExport() {
    setExporting(true);
    setExportError(null);
    try {
      await downloadReportCsv(salonId, kind, filters);
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

      <div className="reports__table">
        {report.isPending || !r ? (
          <>
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
          </>
        ) : (
          <>
            <div className="reports__cols">
              {r.columns.map((c) => (
                /*
                 * `data-numeric` ON THE HEADER AS WELL AS THE CELL, so the wide
                 * card's right-alignment comes from the COLUMN TYPE on both rows
                 * rather than from a `nth-child` guess about which positions hold
                 * figures. A reordered or extra column then cannot leave a header
                 * left-aligned over a right-aligned column of money.
                 */
                <span className="reports__col" key={c.key} data-numeric={c.type !== 'text' || undefined}>
                  {c.header}
                </span>
              ))}
            </div>
            {REPORT_FULL_TABLE.has(kind) ? (
              <AttributedRows report={r} />
            ) : r.rows.length === 0 ? (
              /*
               * A REAL EMPTY, named with the filter. The stat above reads a true 0
               * from the wire — the same distinction the Analytics chart drew:
               * a zero the API answered is information; a zero before data is a lie.
               */
              <p className="reports__none">
                Nothing here for {PERIOD_CAPTION[r.period].toLowerCase()}
                {r.branchId === 'all' ? '' : ' at this branch'}.
              </p>
            ) : (
              r.rows.slice(0, 3).map((row, i) => (
                <div className="reports__row" key={i}>
                  {r.columns.map((c) => (
                    <span className="reports__cell" key={c.key}>
                      {cellText(row[c.key] ?? null, c.type, c.key)}
                    </span>
                  ))}
                </div>
              ))
            )}
          </>
        )}
      </div>

      {r && REPORT_FULL_TABLE.has(kind) ? <AttributionNote report={r} /> : null}

      <div className="reports__foot">
        <span className="reports__rowcount">
          {report.isPending || !r ? (
            <Skeleton width={110} height={11} />
          ) : (
            `${r.rowCount} row${r.rowCount === 1 ? '' : 's'} · ${PERIOD_CAPTION[r.period]}`
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
        artists.map((row, i) => <AttributedRow key={i} row={row} columns={report.columns} />)
      )}

      <p className="reports__group">
        Revenue with no artist behind it — not part of the ranking
      </p>
      {unattributed.map((row, i) => (
        <AttributedRow key={i} row={row} columns={report.columns} unattributed />
      ))}
    </>
  );
}

/**
 * One row. `data-unattributed` is what the stylesheet quiets, so the two bucket
 * rows read as a different KIND of row rather than as two more competitors — and
 * it is set from the group they were partitioned into, never from their text.
 */
function AttributedRow({
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
          Nothing was charged {PERIOD_CAPTION[report.period].toLowerCase()}
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

/* ------------------------------------------------------------------ helpers -- */

/**
 * The title while the wire has not answered (loading, refused). The same strings
 * the server's `REPORT_TITLE` carries — used only when there is no response to
 * read them from, so a refused card can still say what it is refusing.
 */
function fallbackTitle(kind: ReportKind): string {
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
