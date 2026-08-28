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

import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { db } from '../db/client';
import { branch, reportDownload, salon } from '../db/schema/salon';
import { staffUser } from '../db/schema/staff';
import { requireDashboardPerm, requireDashboardScope, requireSameSalon } from '../auth/principal';
import { hashWalletToken, mintWalletTokenValue } from '../auth/tokens';
import { notFound, unauthorized } from '../http/errors';
import { resolveBranchFilter } from '../services/branchFilter';
import { parsePeriod, type Period } from '../services/metrics';
import {
  computeReport,
  parseReportKind,
  reportFilename,
  toCsv,
  REPORT_PERMISSION,
  type ReportKind,
  type ReportShape,
} from '../services/reports';

interface ReportQuery {
  branch?: unknown;
  period?: unknown;
}

/**
 * `?branch=` USED TO BE PARSED HERE, in a private `resolveBranch` this file owned.
 * It now lives in `services/branchFilter.ts` because `GET /salons/{id}/metrics`
 * takes the same parameter, and the tenancy scope in that lookup is the kind of
 * thing that gets dropped by the second copy rather than the first. Same
 * behaviour, same two error codes — that module's header carries the argument for
 * each of them, including why a CLOSED branch still resolves here.
 */

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

  const br = await resolveBranchFilter(db, s.id, query.branch);

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
   * `POST /salons/:id/reports/:kind/download-url` — mint a one-time link the
   * browser can follow WITHOUT a header.
   *
   * THE DEFECT (Lane C, driven): `resolvePrincipal` reads `authorization` and
   * nothing else, so the natural download — a plain anchor to `…/sales.csv` —
   * saved a JSON 401 named `sales.csv`. A download is a navigation, and a
   * navigation cannot carry a bearer token; the fetch-and-objectURL workaround
   * works but re-buffers the file and loses the server's filename cross-origin.
   *
   * THE SHAPE IS THE CODEBASE'S OWN TOKEN GRAIN, argued against the alternative:
   * a signed URL (HMAC over the params) would be stateless — and therefore
   * NEITHER single-use NOR revocable, exactly the trade `auth/tokens.ts` refuses
   * for refresh tokens ("a JWT is only revocable by keeping a list, at which
   * point the JWT is doing nothing"). So: 16 bytes of CSPRNG, sha256-stored,
   * SIXTY SECONDS (minted by the click handler immediately before the anchor
   * navigates — the same reasoning as the QR token's 45s), SINGLE-USE under the
   * conditional-spend UPDATE.
   *
   * THE MINT IS THE GATE: same surface check, same per-kind permission, same
   * tenancy assertion as the report itself, via the same `build`-order calls. The
   * row stores WHAT was minted — kind, salon, branch, period, and WHO — so the
   * redemption serves exactly the filter state the user was looking at rather
   * than trusting the query string on an unauthenticated GET.
   */
  app.post<{ Params: { id: string; kind: string }; Querystring: ReportQuery }>(
    '/salons/:id/reports/:kind/download-url',
    async (req, reply) => {
      requireDashboardScope(req);
      const kind = parseReportKind(req.params.kind);
      const p = requireDashboardPerm(req, REPORT_PERMISSION[kind]);
      requireSameSalon(p, req.params.id);

      const query = (req.query ?? {}) as ReportQuery;
      const period = parsePeriod(query.period);
      const br = await resolveBranchFilter(db, req.params.id, query.branch);

      // The wallet token's mint and hash, reused: same entropy class (an opaque
      // bearer capability with a sub-minute life), same storage discipline.
      const token = mintWalletTokenValue();
      const expiresAt = new Date(Date.now() + 60_000);

      await db.insert(reportDownload).values({
        staffId: p.id,
        salonId: req.params.id,
        kind,
        branchId: br?.id ?? null,
        period,
        tokenHash: hashWalletToken(token),
        expiresAt,
      });

      return reply.send({
        /**
         * Relative, so the dashboard prefixes its own API origin. A STANDALONE
         * PATH carrying only the token — see `GET /report-downloads/:token`
         * below for why the kind and salon are deliberately not in it.
         */
        url: `/report-downloads/${token}`,
        expiresAt: expiresAt.toISOString(),
      });
    },
  );

  /**
   * `GET /report-downloads/:token` — the anchor's half of the mint above.
   *
   * ITS OWN ROUTE, AND THE CENSUS IS THE REASON. This began as a `?dl=` branch
   * inside the `.csv` handler, and `e2e/support/perm-census.ts` recorded that
   * route as `requireDashboardPerm` — true of the header path and blind to the
   * token path, so an endpoint reachable with NO header read as gated. The
   * census's `ANONYMOUS` ledger is exactly where a token-authenticated endpoint
   * should have to justify itself, and a route can only land there by having no
   * guard of its own. Splitting it makes the security shape visible to the tool
   * built to see it, instead of hiding a capability behind a conditional.
   *
   * IT ALSO DELETED A WHOLE CLASS OF BUG. With the kind and salon in the path,
   * the handler had to check that the token's row MATCHED them — a token minted
   * for `sales` must not fetch `customers`. Carrying only the token removes the
   * input that could disagree: everything is derived from the stored row, so
   * there is nothing to mismatch and no check to get wrong.
   *
   * THE LEDGER LINE THIS WANTS (Lane D's column, reported not written): the
   * token IS the credential — 16 bytes of CSPRNG, sha256-stored, sixty seconds,
   * single-use — and the AUTHORITY behind it is re-read at redemption, so it is
   * a capability that still answers to the permission table.
   *
   * THE PERMISSION IS RE-CHECKED HERE, FROM THE STAFF ROW AS IT IS NOW. A mint
   * -time-only check would let the URL outlive the authority: `team` revoked
   * between click and navigation must stop the customer book, and sixty seconds
   * is not a grace period #7 grants. Same argument `auth/tokens.ts` makes for
   * reading perms per request instead of baking them into the JWT. Deactivation
   * and a salon move are checked on the same row for the same reason.
   *
   * ONE UNIFORM `invalid_download` for unknown, expired, spent, and
   * since-revoked — the caller's remedy is identical in all four: export again.
   */
  app.get<{ Params: { token: string } }>(
    '/report-downloads/:token',
    /**
     * `logLevel: 'silent'` — AND THIS IS A SECURITY OPTION, not a noise setting.
     *
     * The token rides in the URL PATH, because an `<a href>` cannot send a
     * header, and Fastify logs `req.url` on every request. So the raw credential
     * was being written to the server log — defeating the exact protection
     * `app.ts`'s `redact: ['req.headers.authorization']` exists to give: the
     * codebase deliberately keeps credentials out of its logs, and moving one
     * into the path walked straight past it. FOUND BY SWEEPING THE SERVER LOG
     * for `tok_` after driving the download, which is the third time that habit
     * has caught this class.
     *
     * Silencing the automatic request line is the surgical fix — a pino `req`
     * serializer would have worked too, but adding one flips Fastify's own
     * overload resolution to its HTTP/2 instance types and breaks the build, so
     * the cost of the general fix is a type fight for a one-route problem. What
     * the log actually wants from this route is not the URL anyway; the
     * `app.log.info` below records who redeemed what, which is the useful half
     * and carries no secret.
     */
    { logLevel: 'silent' },
    async (req, reply) => {
    const REFUSED = () =>
      unauthorized('That download link has expired. Export again from Reports.', 'invalid_download');

    const [row] = await db
      .select()
      .from(reportDownload)
      .where(eq(reportDownload.tokenHash, hashWalletToken(req.params.token)))
      .limit(1);
    if (!row || row.expiresAt.getTime() <= Date.now()) throw REFUSED();

    /**
     * SPEND FIRST, then decide. Any presentation of a live token burns it —
     * including one that goes on to fail the permission re-check. A capability
     * that has been shown to a door it may not open should not survive the
     * visit, and sixty-second tokens are cheap to re-mint. (The first version
     * validated before spending, which quietly meant a refused attempt left the
     * link live; caught by driving it.)
     */
    const spent = await db
      .update(reportDownload)
      .set({ usedAt: new Date() })
      .where(and(eq(reportDownload.id, row.id), isNull(reportDownload.usedAt)))
      .returning({ id: reportDownload.id });
    if (spent.length === 0) throw REFUSED();

    const kind = row.kind as ReportKind;
    const [staff] = await db.select().from(staffUser).where(eq(staffUser.id, row.staffId)).limit(1);
    /** The column behind each report's permission — the same map, read live. */
    const HOLDS: Record<ReportKind, (s: typeof staffUser.$inferSelect) => boolean> = {
      customers: (x) => x.permTeam,
      sales: (x) => x.permDashboard,
      'best-selling-services': (x) => x.permAppointments,
      'products-sold': (x) => x.permShop,
    };
    if (
      !staff ||
      staff.deactivatedAt !== null ||
      staff.salonId !== row.salonId ||
      !HOLDS[kind](staff)
    ) {
      throw REFUSED();
    }

    const [s] = await db
      .select({ id: salon.id, timezone: salon.timezone })
      .from(salon)
      .where(eq(salon.id, row.salonId))
      .limit(1);
    if (!s) throw REFUSED();

    const branchName = row.branchId
      ? (await db.select({ name: branch.name }).from(branch).where(eq(branch.id, row.branchId)).limit(1))[0]
          ?.name ?? null
      : null;

    const shape = await computeReport(db, {
      kind,
      salonId: s.id,
      branchId: row.branchId,
      period: row.period as Period,
      timezone: s.timezone,
    });

    /**
     * What the silenced request line would have said, minus the secret: who
     * redeemed which report for which salon. `app.log`, not `req.log` — the
     * route's own logger is the thing that was silenced.
     */
    app.log.info(
      { event: 'report.download', kind, salonId: row.salonId, staffId: row.staffId, rows: shape.rows.length },
      'report download redeemed',
    );

    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header(
        'content-disposition',
        `attachment; filename="${reportFilename(kind, branchName, row.period as Period)}"`,
      )
      .header('cache-control', 'no-store')
      .send(toCsv(shape));
    },
  );

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
