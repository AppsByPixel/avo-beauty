import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { authedRequest } from '../auth/authedRequest.js';
import { useSalonId } from '../auth/AuthProvider.js';
import { readSession } from '../auth/session.js';
import { API_BASE_URL } from '../config.js';
import { ApiError } from './client.js';

/**
 * `GET /salons/{id}/reports/{kind}` (JSON, the cards) and `{kind}.csv` (the
 * export) — api-contract.md § "Addendum — Reports". One aggregate rendered two
 * ways on the server, so the card and the file cannot disagree; this client
 * therefore computes NOTHING from rows — the stat, the row count and the money
 * formatting all arrive decided, and money arrives as INTEGER FILS in the JSON
 * (the CSV is where the server formats it, once).
 *
 * EACH KIND IS ITS OWN QUERY, not one query for four cards, because each kind is
 * gated on the permission of the section it EXPORTS:
 *
 *   customers → team          sales → dashboard
 *   best-selling-services → appointments        products-sold → shop
 *
 * A front-desk manager may hold `dashboard` and not `team`, so Sales loads while
 * Customers answers 403 ON THE SAME SCREEN. That is not an error state — it is
 * the permission ledger rendering — and it is why a single combined query would
 * be wrong twice: one 403 would take down three cards someone is allowed to see.
 *
 * Reports deliberately has NO permission chip of its own; "who may export
 * customer PII" is queued for the client (DECISIONS.md #9). If the mapping
 * changes, the change arrives through `packages/types`/api — nothing here
 * anticipates it.
 */

export const REPORT_KINDS = [
  'customers',
  'sales',
  'best-selling-services',
  'products-sold',
] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

/** The design's card descriptions, verbatim. Titles arrive on the wire. */
export const REPORT_DESC: Record<ReportKind, string> = {
  customers: 'Profiles, tier and wallet balance',
  sales: 'Transactions and gross by day',
  'best-selling-services': 'Ranked by bookings',
  'products-sold': 'Units and revenue by product',
};

/** `GET /salons/{id}/metrics`' vocabulary, reused by the addendum on purpose. */
export const REPORT_PERIODS = ['7d', '30d', '90d'] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];

/** The design's segment labels and its "N rows · {label}" caption, verbatim. */
export const PERIOD_SEGMENT_LABEL: Record<ReportPeriod, string> = {
  '7d': 'Week',
  '30d': 'Month',
  '90d': 'Quarter',
};
export const PERIOD_CAPTION: Record<ReportPeriod, string> = {
  '7d': 'This week',
  '30d': 'This month',
  '90d': 'This quarter',
};

/* ----------------------------------------------------------------- the wire -- */

export interface ReportColumn {
  /** The header, verbatim from the design's `*Cols` arrays — the server owns it. */
  header: string;
  key: string;
  /** `money` columns carry integer fils in every row. */
  type: 'text' | 'int' | 'money';
}

export interface ReportStat {
  key: string | null;
  /** "customers" / "KD gross" / "bookings" / "units" — the design's statLabel. */
  label: string;
  /** Integer fils when `type` is 'money'; a plain count otherwise. */
  value: number;
  type: 'count' | 'int' | 'money';
}

export interface Report {
  kind: ReportKind;
  title: string;
  period: ReportPeriod;
  /** A branch id, or the wire sentinel 'all'. */
  branchId: string;
  columns: ReportColumn[];
  rows: Array<Record<string, string | number | null>>;
  stat: ReportStat;
  rowCount: number;
}

function fail(where: string): never {
  throw new Error(`${where}: the report shape did not match the addendum.`);
}

/**
 * Parsed, not cast. Money rides these rows, and the rows are RENDERED — a null
 * where a fils integer was promised becomes "NaN KD" on a card a merchant reads
 * for revenue.
 */
export function parseReport(raw: unknown, kind: ReportKind): Report {
  if (typeof raw !== 'object' || raw === null) fail(kind);
  const r = raw as Record<string, unknown>;
  if (r.kind !== kind || typeof r.title !== 'string') fail(kind);
  if (!(REPORT_PERIODS as readonly string[]).includes(String(r.period))) fail(kind);
  if (typeof r.branchId !== 'string') fail(kind);
  if (!Array.isArray(r.columns) || !Array.isArray(r.rows)) fail(kind);
  if (typeof r.rowCount !== 'number') fail(kind);

  const columns = r.columns.map((c) => {
    const col = c as Record<string, unknown>;
    if (
      typeof col.header !== 'string' ||
      typeof col.key !== 'string' ||
      (col.type !== 'text' && col.type !== 'int' && col.type !== 'money')
    ) {
      fail(`${kind}.columns`);
    }
    return { header: col.header, key: col.key, type: col.type as ReportColumn['type'] };
  });

  const s = r.stat as Record<string, unknown>;
  if (
    typeof s !== 'object' ||
    s === null ||
    typeof s.label !== 'string' ||
    typeof s.value !== 'number' ||
    (s.type !== 'count' && s.type !== 'int' && s.type !== 'money')
  ) {
    fail(`${kind}.stat`);
  }

  /*
   * Every cell in a money column must be an integer — checked here so a float
   * cannot reach `fils()` at render, which would throw mid-paint instead of
   * failing the parse with a sentence naming the column.
   */
  for (const col of columns) {
    if (col.type !== 'money' && col.type !== 'int') continue;
    for (const row of r.rows) {
      const v = (row as Record<string, unknown>)[col.key];
      if (v !== null && (typeof v !== 'number' || !Number.isInteger(v))) {
        fail(`${kind}.rows[].${col.key} (non-integer in a ${col.type} column)`);
      }
    }
  }

  return {
    kind,
    title: r.title,
    period: r.period as ReportPeriod,
    branchId: r.branchId,
    columns,
    rows: r.rows as Report['rows'],
    stat: {
      key: (s.key as string | null) ?? null,
      label: s.label,
      value: s.value,
      type: s.type,
    },
    rowCount: r.rowCount,
  };
}

/* --------------------------------------------------------------- the hooks -- */

export interface ReportFilters {
  /** A branch id, or 'all'. The segment renders the NAME; the wire takes the ID. */
  branch: string;
  period: ReportPeriod;
}

export const reportKeys = {
  one: (salonId: string, kind: ReportKind, f: ReportFilters) =>
    ['reports', salonId, kind, f] as const,
};

function reportQuery(f: ReportFilters): string {
  const params = new URLSearchParams();
  if (f.branch !== 'all') params.set('branch', f.branch);
  params.set('period', f.period);
  return params.toString();
}

export function useReport(kind: ReportKind, filters: ReportFilters): UseQueryResult<Report> {
  const salonId = useSalonId();
  return useQuery({
    queryKey: reportKeys.one(salonId, kind, filters),
    queryFn: async ({ signal }) =>
      parseReport(
        await authedRequest<unknown>(
          'merchant',
          `/salons/${salonId}/reports/${kind}?${reportQuery(filters)}`,
          { signal },
        ),
        kind,
      ),
    /*
     * A 403 here is a STANDING ANSWER, not a transient one — the permission
     * ledger. The global retry policy already short-circuits 401/403, so the
     * refused card settles in one round trip. No override needed; noted because
     * this screen is where four different permissions land side by side.
     */
  });
}

/* -------------------------------------------------------------- the export -- */

/**
 * THE DOWNLOAD IS AN AUTHENTICATED FETCH, AND THE BRIEF ASKED FOR A PLAIN
 * NAVIGATION. The conflict is real and was found by driving, not reading:
 *
 *   GET /salons/{id}/reports/sales.csv  (no Authorization)  → 401 unauthorized
 *
 * `resolvePrincipal` reads `req.headers.authorization` and nothing else — no
 * cookie, no query token (principal.ts:407). A bare `<a href>` sends no bearer,
 * so "let the browser do the download" cannot authenticate against the API as
 * merged, and would ship a button that saves a JSON error body named sales.csv.
 * Reported to trunk: the endpoint needs a one-time signed download URL (or a
 * cookie the CSV route accepts) — an `api/` change this lane must not make.
 *
 * Until then, the fetch preserves what the brief was protecting:
 *   - THE SERVER STILL NAMES THE FILE. The filename comes from
 *     `content-disposition` when the browser can read it. Cross-origin that
 *     header is not CORS-safelisted and `{ origin: true }` exposes nothing, so
 *     dev reads null — the fallback rebuilds `{kind}_{period}.csv` and says so.
 *     (`expose: content-disposition` is one line in api/app.ts — also reported.)
 *   - A REFUSED EXPORT REFUSES VISIBLY. A 403 surfaces the server's sentence on
 *     the card instead of downloading an error file — something the plain anchor
 *     could never do.
 *
 * The blob is held only long enough to hand to the browser's download manager,
 * and the object URL is revoked immediately after the click.
 */
export async function downloadReportCsv(
  salonId: string,
  kind: ReportKind,
  filters: ReportFilters,
): Promise<void> {
  const session = readSession('merchant');
  if (!session) throw new ApiError('Sign in to continue.', { status: 401, code: 'unauthorized' });

  const url = `${API_BASE_URL}/salons/${salonId}/reports/${kind}.csv?${reportQuery(filters)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
  } catch {
    throw new ApiError("We can't reach the workspace.", {
      status: 0,
      code: 'offline',
      offline: true,
    });
  }

  if (!response.ok) {
    let code = 'export_failed';
    let message = "Couldn't export the file. Try again.";
    try {
      const body = (await response.json()) as { error?: string; message?: string };
      if (typeof body.error === 'string') code = body.error;
      if (typeof body.message === 'string') message = body.message;
    } catch {
      // A non-JSON error body keeps the generic sentence.
    }
    throw new ApiError(message, { status: response.status, code });
  }

  const disposition = response.headers.get('content-disposition');
  const fromServer = disposition ? /filename="([^"]+)"/.exec(disposition)?.[1] : undefined;
  const filename = fromServer ?? `${kind}_${filters.period}.csv`;

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
