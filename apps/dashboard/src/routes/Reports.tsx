import { useState } from 'react';
import { fils, formatFils } from '@avo/types';
import { Button, Card, ErrorState, InfoBanner, InlineError, Money, Segmented, Skeleton } from '@avo/ui';
import {
  downloadReportCsv,
  PERIOD_CAPTION,
  PERIOD_SEGMENT_LABEL,
  REPORT_DESC,
  REPORT_KINDS,
  REPORT_PERIODS,
  useReport,
  type Report,
  type ReportFilters,
  type ReportKind,
  type ReportPeriod,
} from '../api/reports.js';
import { useSalon } from '../api/salon.js';
import { useSalonId } from '../auth/AuthProvider.js';
import { ApiError } from '../api/client.js';
import { isForbidden, SectionError } from './sectionState.js';

/**
 * Merchant → Reports. Four cards off `GET /salons/{id}/reports/{kind}`, each with
 * its CSV export — `AVO Merchant Dashboard.dc.html:416` § REPORTS, built to the
 * contract addendum rather than the drawn export where the two differ (the seven
 * departures are the contract now).
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

  const [branch, setBranch] = useState('all');
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
              { value: 'all', label: 'All branches' },
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
      <Card className="reports__card" data-refused={isForbidden(report.error) || undefined}>
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
    <Card className="reports__card">
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
            <div className="reports__cols" aria-hidden="true">
              {[0, 1, 2, 3].map((c) => (
                <span className="reports__col" key={c}>
                  <Skeleton width="70%" height={10} />
                </span>
              ))}
            </div>
            {[0, 1, 2].map((n) => (
              <div className="reports__row" key={n} aria-hidden="true">
                {[0, 1, 2, 3].map((c) => (
                  <span className="reports__cell" key={c}>
                    <Skeleton width={`${80 - c * 10}%`} height={12} />
                  </span>
                ))}
              </div>
            ))}
          </>
        ) : (
          <>
            <div className="reports__cols">
              {r.columns.map((c) => (
                <span className="reports__col" key={c.key}>
                  {c.header}
                </span>
              ))}
            </div>
            {r.rows.length === 0 ? (
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
                      {cellText(row[c.key] ?? null, c.type)}
                    </span>
                  ))}
                </div>
              ))
            )}
          </>
        )}
      </div>

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
  }
}

/**
 * One cell. Money arrives as integer fils and is formatted HERE and nowhere
 * else on the screen (#1); a null money cell renders an em dash rather than
 * 0.000, because "no value" and "zero dinars" are different claims.
 *
 * The tier's capitalisation is the one presentation decision the addendum left
 * to this client (departure #6: the wire says `silver`). Applied to the value,
 * not keyed to a column name — any single-word lowercase text cell is a domain
 * value by the addendum's own convention, and today that is exactly the tier.
 */
function cellText(value: string | number | null, type: 'text' | 'int' | 'money'): string {
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
  if (/^[a-z]+$/.test(text)) return text.charAt(0).toUpperCase() + text.slice(1);
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
