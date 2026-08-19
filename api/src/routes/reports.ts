/**
 * Reports — the merchant's CSV exports.
 *
 *   GET /salons/{id}/reports/{kind}       → JSON, for the card the design draws
 *   GET /salons/{id}/reports/{kind}.csv   → the file
 *
 * api-contract.md § Operations declares only the second one:
 *
 *     | Merchant | Reports | GET /salons/{id}/reports/{kind}.csv?branch=&period= |
 *
 * THE JSON SIBLING IS A CONTRACT ADDITION, reported rather than assumed. The reason
 * it exists: the design's card renders a column list, a three-row preview, a row
 * count and a headline stat BEFORE anything is exported, and the only other way for
 * the dashboard to fill that in is to fetch the CSV and parse it in the browser. A
 * client that parses a display format to recover numbers is a client that will
 * eventually read `"1,820.000"` as 1.82 — so the JSON carries INTEGER FILS and the
 * CSV does the formatting, once, on the server. One aggregate, two renderings, one
 * permission.
 *
 * What the four kinds MEAN, why each is gated on a different permission, and which
 * two columns the design asks for that cannot exist as data: services/reports.ts.
 *
 * THE TWO GUARDS, IN THIS ORDER, ON BOTH ROUTES
 * ---------------------------------------------
 * 1. `requireDashboardPerm(req, REPORT_PERMISSION[kind])` — non-negotiable #7. The
 *    SURFACE half of that guard is what stops a scanner PIN session reaching a
 *    back-office export: a `frontdesk` holds `dashboard` legitimately on her tablet,
 *    so gating on the permission alone would let a PIN session download the day's
 *    revenue. `requireDashboardPerm` demands a web session too.
 * 2. `requireSameSalon(p, id)` — the tenancy boundary. Without it the salon id in
 *    the path is a parameter a merchant edits to read a competitor's revenue,
 *    customer list and phone numbers. This build has already found that exact class
 *    of leak twice, so it is asserted here rather than left implied by the fact that
 *    the queries filter on `salon_id`.
 *
 * THE KIND IS VALIDATED BEFORE THE PERMISSION IS CHOSEN, because the permission is
 * SELECTED BY the kind. An unknown kind cannot resolve to a permission at all, so it
 * 400s before any lookup — rather than defaulting to one and letting the choice of
 * default decide what an unrecognised path may read.
 */

import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { db } from '../db/client';
import { branch, salon } from '../db/schema/salon';
import { requireDashboardPerm, requireDashboardScope, requireSameSalon } from '../auth/principal';
import { badRequest, notFound } from '../http/errors';
import { parsePeriod, type Period } from '../services/metrics';
import {
  computeReport,
  parseReportKind,
  reportFilename,
  toCsv,
  REPORT_PERMISSION,
  type ReportShape,
} from '../services/reports';

interface ReportQuery {
  branch?: unknown;
  period?: unknown;
}

/**
 * `?branch=` is a BRANCH ID, or absent, or the literal `all`.
 *
 * An id rather than the name the design's segment renders, because a name is not a
 * key: `branch_salon_name_uq` is unique per SALON, so two salons may each have a
 * "Salmiya" and a name would have to be resolved against the caller's salon anyway.
 * `GET /salons/{id}/branches` already hands the dashboard the ids. `all` is accepted
 * as an explicit spelling of "every branch" because routes/campaigns.ts established
 * that sentinel on the wire.
 *
 * AN UNKNOWN OR FOREIGN BRANCH IS A 404, NOT AN EMPTY REPORT. Filtering on another
 * salon's branch id would return zero rows, and zero rows reads as "no sales at that
 * branch" — a confident false answer about a branch that is not hers. The lookup is
 * scoped to the caller's salon in ONE query, so a branch that does not exist and a
 * branch belonging to somebody else are indistinguishable from the outside, which is
 * the property that stops this being a branch-enumeration oracle.
 */
async function resolveBranch(
  salonId: string,
  raw: unknown,
): Promise<{ id: string; name: string } | null> {
  if (raw === undefined || raw === null || raw === '' || raw === 'all') return null;
  if (typeof raw !== 'string') throw badRequest('invalid_branch', 'branch must be a branch id.');

  const rows = await db
    .select({ id: branch.id, name: branch.name })
    .from(branch)
    .where(and(eq(branch.id, raw), eq(branch.salonId, salonId)))
    .limit(1);
  const found = rows[0];
  if (!found) throw notFound('unknown_branch', 'No such branch.');
  return found;
}

interface Built {
  shape: ReportShape;
  branchId: string | null;
  branchName: string | null;
  period: Period;
}

/**
 * Shared by both routes so the JSON and the CSV can never diverge — one aggregate,
 * two renderings. Were these two handlers, the day somebody corrected a definition in
 * one of them is the day the card and the file started disagreeing about the same
 * salon.
 */
async function build(req: FastifyRequest, kindRaw: string, salonId: string): Promise<Built> {
  /**
   * THE SURFACE IS CHECKED BEFORE THE KIND IS EVEN PARSED, so an anonymous caller
   * gets 401 for every path under this route rather than a 400 that quietly confirms
   * the `{kind}` vocabulary to somebody who is not signed in.
   *
   * It was the other way round first, and the ordering was found by running it: an
   * unauthenticated `GET .../reports/bogus` answered `invalid_report_kind` while
   * `GET .../reports/sales` answered `unauthorized`. Nothing sensitive leaks either
   * way — the vocabulary is in api-contract.md — but "validate the input, then decide
   * who is asking" is the shape that grows into a real leak the first time the
   * validation touches a row instead of a constant. auth/principal.ts makes the same
   * argument about `POST /scans` answering 410 before checking authority.
   */
  requireDashboardScope(req);

  const kind = parseReportKind(kindRaw);

  // Then #7, with the permission governing the section this kind exports, and still
  // before any lookup: an endpoint that reads the salon first has already told an
  // unauthorised caller whether that salon exists.
  const p = requireDashboardPerm(req, REPORT_PERMISSION[kind]);
  requireSameSalon(p, salonId);

  const query = (req.query ?? {}) as ReportQuery;
  const period = parsePeriod(query.period);

  const rows = await db
    .select({ id: salon.id, timezone: salon.timezone })
    .from(salon)
    .where(eq(salon.id, salonId))
    .limit(1);
  const s = rows[0];
  if (!s) throw notFound('unknown_salon', 'No such salon.');

  const br = await resolveBranch(s.id, query.branch);

  const shape = await computeReport(db, {
    kind,
    salonId: s.id,
    branchId: br?.id ?? null,
    period,
    // The salon's own zone. `sales` groups by the salon's calendar day, not the
    // process's — services/reports.ts § sales.
    timezone: s.timezone,
  });

  return { shape, branchId: br?.id ?? null, branchName: br?.name ?? null, period };
}

export async function registerReportRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The CSV. Registered before the bare `:kind` route: find-my-way matches the
   * longer, more specific pattern regardless of order, but `{kind}.csv` and `{kind}`
   * are two routes whose paths overlap by design, and writing the specific one first
   * states the intent instead of relying on the router to infer it.
   */
  app.get<{ Params: { id: string; kind: string }; Querystring: ReportQuery }>(
    '/salons/:id/reports/:kind.csv',
    async (req, reply) => {
      const { shape, branchName, period } = await build(req, req.params.kind, req.params.id);
      const filename = reportFilename(shape.kind, branchName, period);

      /**
       * `attachment` with a filename, so the browser saves rather than renders.
       * `charset=utf-8` names the encoding the BOM also declares — belt and braces,
       * because a merchant's Excel decides how to read an Arabic service name on
       * whichever of the two it notices first.
       *
       * The filename embeds a branch name a SALON chose, so it goes through
       * `reportFilename`, which strips everything outside `[a-z0-9-]`. That is also
       * what closes header injection: a branch called `x"; rm -rf` cannot break out
       * of the quoted parameter, because the quote and the semicolon are gone before
       * they reach the header.
       */
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${filename}"`)
        /**
         * A report is a snapshot of a moving aggregate, and it is per-salon. A copy
         * held in any shared cache is one merchant's customer list waiting to be
         * served to another — the tenancy boundary leaking through a header rather
         * than through a query.
         */
        .header('cache-control', 'no-store')
        .send(toCsv(shape));
    },
  );

  /** The same aggregate as JSON, for the card. Money is integer fils — see header. */
  app.get<{ Params: { id: string; kind: string }; Querystring: ReportQuery }>(
    '/salons/:id/reports/:kind',
    async (req, reply) => {
      const { shape, branchId, period } = await build(req, req.params.kind, req.params.id);

      return reply.header('cache-control', 'no-store').send({
        kind: shape.kind,
        title: shape.title,
        period,
        /** `all` rather than null, matching routes/campaigns.ts's wire sentinel. */
        branchId: branchId ?? 'all',
        columns: shape.columns,
        rows: shape.rows,
        stat: shape.stat,
        /** What the card prints as "{{ r.rowCount }} rows · {{ periodLabel }}". */
        rowCount: shape.rows.length,
      });
    },
  );
}
