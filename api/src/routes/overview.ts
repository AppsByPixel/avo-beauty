/**
 *   GET  /v1/salons/{id}/overview/analytics?branch=&period=                perms.dashboard
 *   GET  /v1/salons/{id}/overview/analytics.csv?branch=&period=&section=   perms.dashboard
 *   POST /v1/salons/{id}/overview/analytics/download-url                   perms.dashboard
 *        body { branch?, period?, section? }  → { url, expiresAt }
 *
 * The data behind the Overview's widgets that no existing endpoint already
 * answers. `services/overviewAnalytics.ts` carries every definition, which
 * widgets reuse which existing endpoint instead, and the five blocks that need a
 * second permission on top of this one. `services/overviewExport.ts` carries the
 * file: its columns, its section vocabulary, and why a withheld block is a row.
 *
 * THE SAME THREE CALLS IN THE SAME ORDER AS `GET /salons/{id}/metrics`, ON ALL
 * THREE ROUTES:
 *
 *   1. `requireDashboardPerm(req, 'dashboard')` — non-negotiable #7, and the
 *      surface half: a scanner PIN session is refused even for a frontdesk who
 *      holds `dashboard` on her tablet. That is the export's PIN-session refusal,
 *      exactly as Reports has it.
 *   2. `requireSameSalon` — before any lookup, so a caller who is not this salon's
 *      staff cannot learn from 404-vs-200 whether a branch id exists here.
 *   3. `parsePeriod` (and, for the file, `parseOverviewSection`), then the salon
 *      row, then `resolveBranchFilter` — parsing needs no zone, resolving does. A
 *      branch of another salon is 404 `unknown_branch`.
 *
 * ONE ANSWER, TWO RENDERINGS. The JSON and the CSV both come out of `analyticsFor`
 * below, which is the only caller of `computeOverviewAnalytics` in this file. A
 * second copy of the salon lookup in the CSV handler is how the card and the file
 * would start disagreeing about which salon fields feed the loyalty block.
 *
 * THE FILE ALSO CARRIES THE OVERVIEW'S OTHER THREE WIDGETS (`loadOverviewExport`),
 * each from the service call its own endpoint makes: `computeMetrics` (the KPI
 * row, `GET /salons/{id}/metrics`), and `computeReport` for `sales` (Gross by day)
 * and `earnings-by-branch` (Revenue by branch). THE GATES ARE ALREADY THE SAME.
 * `/metrics` is `requireDashboardPerm('dashboard')` + `requireSameSalon`, and so
 * are both reports (`REPORT_PERMISSION.sales` and `['earnings-by-branch']` are
 * both `dashboard`). The two report sections still read `REPORT_PERMISSION` at
 * export time, so a change to either report's gate moves the file with it. A
 * caller without it gets a `permission: <perm>` withheld row, never the figures.
 *
 * `?compare=` is not accepted, for `/metrics`' reason: nothing here is a
 * two-window statistic. Unknown parameters are dropped by Fastify.
 *
 * THE JSON IS READ-ONLY AND UNAUDITED — a card render is not an export (the
 * report-export ruling). THE FILE IS AUDITED, EVERY TIME, on both paths — see
 * `overviewExportAudit` for why "every" rather than Reports' subset.
 */

import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/client';
import { reportDownload, salon } from '../db/schema/salon';
import type { staffUser } from '../db/schema/staff';
import {
  permsOf,
  requireDashboardPerm,
  requireSameSalon,
  type StaffPerms,
} from '../auth/principal';
import { hashWalletToken, mintWalletTokenValue } from '../auth/tokens';
import { notFound } from '../http/errors';
import { salonWallClock } from '../time/zone';
import { writeAudit } from '../services/audit';
import { resolveBranchFilter, type BranchFilter } from '../services/branchFilter';
import { computeMetrics } from '../services/metrics';
import {
  parsePeriod,
  periodToken,
  resolveWindow,
  type Period,
  type PeriodWindow,
} from '../services/period';
import { computeOverviewAnalytics, type OverviewAnalytics } from '../services/overviewAnalytics';
import {
  isAnalyticsSection,
  overviewCsv,
  overviewDownloadKind,
  overviewExportAudit,
  overviewFilename,
  overviewRows,
  parseOverviewSection,
  salesTrendPeriod,
  sectionsOf,
  type OverviewExportInput,
  type OverviewSection,
  type ReportBlock,
} from '../services/overviewExport';
import { computeReport, REPORT_PERMISSION, type ReportKind } from '../services/reports';

interface OverviewQuery {
  period?: unknown;
  branch?: unknown;
  section?: unknown;
}

type SalonRow = {
  id: string;
  timezone: string;
  loyaltyMode: (typeof salon.$inferSelect)['loyaltyMode'];
  stampTarget: (typeof salon.$inferSelect)['stampTarget'];
  tiers: (typeof salon.$inferSelect)['tiers'];
  moduleBooking: boolean;
  moduleShop: boolean;
};

/** The salon row every Overview read starts from. Callers have already gated. */
async function salonRow(salonId: string): Promise<SalonRow> {
  const rows = await db
    .select({
      id: salon.id,
      timezone: salon.timezone,
      loyaltyMode: salon.loyaltyMode,
      stampTarget: salon.stampTarget,
      tiers: salon.tiers,
      moduleBooking: salon.moduleBooking,
      moduleShop: salon.moduleShop,
    })
    .from(salon)
    .where(eq(salon.id, salonId))
    .limit(1);
  const s = rows[0];
  if (!s) throw notFound('unknown_salon', 'No such salon.');
  return s;
}

/**
 * THE ONE PLACE THE ANALYTICS ARE COMPUTED — for the card, the file, and the
 * one-time link's redemption.
 *
 * `perms` is passed in rather than read here, because the redemption has no
 * request principal: it passes the staff row's permissions AS THEY ARE NOW, which
 * is how the section gates keep answering to the permission table for the sixty
 * seconds a link lives.
 */
function analyticsFor(
  s: SalonRow,
  period: Period,
  branch: BranchFilter | null,
  perms: StaffPerms,
  now: Date,
): Promise<OverviewAnalytics> {
  return computeOverviewAnalytics(db, {
    salon: {
      id: s.id,
      timezone: s.timezone,
      loyaltyMode: s.loyaltyMode,
      stampTarget: s.stampTarget,
      tierNames: s.tiers ? s.tiers.map((t) => t.name) : null,
      moduleBooking: s.moduleBooking,
      moduleShop: s.moduleShop,
    },
    period,
    branch,
    /**
     * READ OFF THE PRINCIPAL (or, for a link, the live staff row) — never from a
     * claim or the query. The five section-gated blocks are decided from exactly
     * the flags `requirePerm` reads.
     */
    perms,
    now,
  });
}

/** The JSON card's read: the salon lookup, the branch resolution, the aggregate. */
async function loadOverview(input: {
  salonId: string;
  period: Period;
  branch: unknown;
  perms: StaffPerms;
}): Promise<{ analytics: OverviewAnalytics }> {
  const s = await salonRow(input.salonId);
  const branch = await resolveBranchFilter(db, s.id, input.branch);
  return { analytics: await analyticsFor(s, input.period, branch, input.perms, new Date()) };
}

/**
 * A Reports aggregate for one of the file's widget sections, behind that
 * report's OWN permission, read from `REPORT_PERMISSION` as `routes/reports.ts`
 * reads it. Today both kinds are `dashboard`, which every caller here already
 * holds, so the withheld branch is a guard against the gates drifting apart. It
 * is not a state the Overview reaches.
 */
async function reportBlock(
  kind: Extract<ReportKind, 'sales' | 'earnings-by-branch'>,
  s: SalonRow,
  scope: { branchId: string | null; period: Period },
  perms: StaffPerms,
  now: Date,
): Promise<ReportBlock> {
  const perm = REPORT_PERMISSION[kind];
  if (!perms[perm]) return { status: 'withheld', reason: 'permission', permission: perm };
  return {
    status: 'ok',
    report: await computeReport(db, {
      kind,
      salonId: s.id,
      branchId: scope.branchId,
      period: scope.period,
      timezone: s.timezone,
      now,
    }),
  };
}

/**
 * THE FILE'S READ. One salon lookup and one branch resolution, then ONLY the
 * aggregates the requested sections need, all against ONE `now`. Each comes from
 * the service call its own endpoint makes, with the same arguments that endpoint
 * passes:
 *
 *   analytics         `computeOverviewAnalytics(period, branch)`  — as the JSON above
 *   kpis              `computeMetrics(period, branch)`            — as `/metrics`
 *   salesTrend        `computeReport('sales', ALL branches, the 14-day window)`
 *                     — as the Gross by day card asks `reports/sales`
 *   revenueByBranch   `computeReport('earnings-by-branch', branch, period)`
 *                     — as the Revenue by branch card asks it
 */
async function loadOverviewExport(input: {
  salonId: string;
  period: Period;
  branch: unknown;
  perms: StaffPerms;
  section: OverviewSection | null;
}): Promise<{ data: OverviewExportInput; branch: BranchFilter | null; window: PeriodWindow }> {
  const now = new Date();
  const s = await salonRow(input.salonId);
  const branch = await resolveBranchFilter(db, s.id, input.branch);
  const wanted = sectionsOf(input.section);
  const data: OverviewExportInput = {};

  if (wanted.some(isAnalyticsSection)) {
    data.analytics = await analyticsFor(s, input.period, branch, input.perms, now);
  }
  if (wanted.includes('kpis')) {
    data.kpis = {
      metrics: await computeMetrics(db, { id: s.id, timezone: s.timezone }, input.period, now, branch),
      today: salonWallClock(now, s.timezone).date,
      window: resolveWindow(input.period, s.timezone, now),
      timezone: s.timezone,
    };
  }
  if (wanted.includes('salesTrend')) {
    data.salesTrend = {
      block: await reportBlock(
        'sales',
        s,
        { branchId: null, period: salesTrendPeriod(s.timezone, now) },
        input.perms,
        now,
      ),
      branchApplied: branch !== null,
    };
  }
  if (wanted.includes('revenueByBranch')) {
    data.revenueByBranch = await reportBlock(
      'earnings-by-branch',
      s,
      { branchId: branch?.id ?? null, period: input.period },
      input.perms,
      now,
    );
  }
  // The export's own window, for the audit row: the period it was asked for.
  return { data, branch, window: resolveWindow(input.period, s.timezone, now) };
}

/**
 * A link's redemption, called from `GET /report-downloads/:token` once that route
 * has SPENT the token and confirmed the staff row is live and of this salon.
 *
 * THE PERMISSION IS RE-CHECKED HERE, from the row as it is now — Reports' rule:
 * `dashboard` revoked between click and navigation stops the file. Returns null
 * for a refusal so the caller answers with its one uniform `invalid_download`.
 */
export async function redeemOverviewDownload(
  row: typeof reportDownload.$inferSelect,
  section: OverviewSection | null,
  staff: typeof staffUser.$inferSelect,
): Promise<{ filename: string; csv: string; rowCount: number; window: string } | null> {
  if (!staff.permDashboard) return null;

  // Parsed back out of the stored token, as Reports does — not cast to a Period.
  const period = parsePeriod(row.period);
  const { data, branch, window } = await loadOverviewExport({
    salonId: row.salonId,
    period,
    branch: row.branchId,
    perms: permsOf(staff),
    section,
  });
  const rows = overviewRows(data, section);

  // Awaited before the bytes leave: an untraced export must not be reachable.
  await writeAudit(
    db,
    { kind: 'staff', id: staff.id, name: staff.name, role: staff.role },
    overviewExportAudit({
      salonId: row.salonId,
      section,
      branchId: branch?.id ?? null,
      window,
      rowCount: rows.length,
      via: 'download-link',
    }),
  );

  return {
    filename: overviewFilename(branch?.name ?? null, period, section),
    csv: overviewCsv(rows),
    rowCount: rows.length,
    window: window.token,
  };
}

export async function registerOverviewRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The file. Registered before the JSON route for Reports' reason — the two paths
   * overlap by design and the specific one is written first to say so.
   */
  app.get<{ Params: { id: string }; Querystring: OverviewQuery }>(
    '/v1/salons/:id/overview/analytics.csv',
    async (req, reply) => {
      const p = requireDashboardPerm(req, 'dashboard');
      requireSameSalon(p, req.params.id);

      const query = (req.query ?? {}) as OverviewQuery;
      const period = parsePeriod(query.period);
      const section = parseOverviewSection(query.section);

      const { data, branch, window } = await loadOverviewExport({
        salonId: req.params.id,
        period,
        branch: query.branch,
        perms: p.perms,
        section,
      });
      const rows = overviewRows(data, section);

      /**
       * AUDITED BEFORE THE BYTES LEAVE, and awaited — Reports' `.csv` argument. If
       * the audit write fails the export fails; "the file of customer names went
       * out and nothing recorded it" must not be a reachable outcome.
       */
      await writeAudit(
        db,
        p,
        overviewExportAudit({
          salonId: req.params.id,
          section,
          branchId: branch?.id ?? null,
          window,
          rowCount: rows.length,
          via: 'csv',
        }),
      );

      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header(
          'content-disposition',
          `attachment; filename="${overviewFilename(branch?.name ?? null, period, section)}"`,
        )
        // Per-salon, and it can carry customer names — never in a shared cache.
        .header('cache-control', 'no-store')
        .send(overviewCsv(rows));
    },
  );

  /**
   * `POST …/overview/analytics/download-url` — Reports' one-time link, for the
   * same defect: an `<a href>` cannot carry a bearer token. Same table, same
   * token grain (16 bytes CSPRNG, sha256-stored, 60 s, single-use), same
   * redemption route — `GET /report-downloads/:token` — which dispatches on
   * `report_download.kind`.
   *
   * THE FILTER IS IN THE BODY, `{ branch?, period?, section? }`. Reports' mint
   * takes the same fields as a QUERY STRING; this one accepts either, so a client
   * helper written for Reports works unchanged. A JSON object body wins outright
   * when one is sent — the two are not merged, so there is never a question of
   * which half of a request a field came from.
   *
   * THE MINT IS THE GATE, AND IT VALIDATES EVERYTHING the file will need: the
   * period, the section and the branch are all parsed here, so a bad value is a
   * 400/404 now rather than a dead link in sixty seconds.
   */
  app.post<{ Params: { id: string }; Querystring: OverviewQuery; Body: unknown }>(
    '/v1/salons/:id/overview/analytics/download-url',
    async (req, reply) => {
      const p = requireDashboardPerm(req, 'dashboard');
      requireSameSalon(p, req.params.id);

      const body = req.body;
      const src: OverviewQuery =
        body !== null && typeof body === 'object' && !Array.isArray(body)
          ? (body as OverviewQuery)
          : ((req.query ?? {}) as OverviewQuery);

      const period = parsePeriod(src.period);
      const section = parseOverviewSection(src.section);
      const br = await resolveBranchFilter(db, req.params.id, src.branch);

      const token = mintWalletTokenValue();
      const expiresAt = new Date(Date.now() + 60_000);

      await db.insert(reportDownload).values({
        staffId: p.id,
        salonId: req.params.id,
        /** `overview` or `overview:<section>` — `services/overviewExport.ts` § download kind. */
        kind: overviewDownloadKind(section),
        branchId: br?.id ?? null,
        period: periodToken(period),
        tokenHash: hashWalletToken(token),
        expiresAt,
      });

      return reply.header('cache-control', 'no-store').send({
        url: `/report-downloads/${token}`,
        expiresAt: expiresAt.toISOString(),
      });
    },
  );

  app.get<{ Params: { id: string }; Querystring: OverviewQuery }>(
    '/v1/salons/:id/overview/analytics',
    async (req, reply) => {
      const p = requireDashboardPerm(req, 'dashboard');
      requireSameSalon(p, req.params.id);

      const period = parsePeriod(req.query?.period);
      const { analytics } = await loadOverview({
        salonId: req.params.id,
        period,
        branch: req.query?.branch,
        perms: p.perms,
      });
      return reply.send(analytics);
    },
  );
}
