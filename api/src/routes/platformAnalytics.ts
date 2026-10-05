/**
 *   GET  /v1/platform/analytics?month=&months=&salon=                  analytics
 *   GET  /v1/platform/analytics.csv?month=&months=&salon=&section=     analytics
 *   POST /v1/platform/analytics/download-url                           analytics
 *        body { month?, months?, salon?, section? }  → { url, expiresAt }
 *
 * The owner console's analytics, and its export — the Overview's three routes
 * (`routes/overview.ts`) for the console. `services/platformAnalytics.ts` carries
 * every definition and the two blocks gated on a second section;
 * `services/platformAnalyticsExport.ts` carries the file.
 *
 * THE SAME ORDER ON ALL THREE ROUTES:
 *
 *   1. `requirePlatform(req, 'analytics')` — first statement, non-negotiable #7.
 *      A merchant or staff session is refused by `requirePlatformScope` inside it
 *      ("This endpoint is the AVO owner console, not the salon dashboard."), and
 *      a console admin without `analytics` by the section check.
 *   2. Parse `month`, `months` (and `section` for the file) — a bad value is 400
 *      before anything is read.
 *   3. Resolve `salon` — an unknown id is 404 `unknown_salon`, the console's
 *      Activity/Audit refusal by name: "nothing at this salon" and "you typed the
 *      wrong id" must not look the same.
 *
 * WHO REACHES THIS, BY PRESET (`PLATFORM_ROLE_PRESETS`):
 *   owner, admin   everything.
 *   analyst        `analytics` without `approvals` or `policies` — so the JSON
 *                  with `campaigns` and `support` withheld, and the same two rows
 *                  in the file.
 *   support        NO `analytics` — 403 on all three routes. The support preset is
 *                  "accounts & salons" in the design's own words, and the support
 *                  QUEUE's console gate is `policies`, which this preset does not
 *                  hold either. So there is no preset for which the support block
 *                  is the reason to open this screen; it is served to whoever holds
 *                  both `analytics` and `policies`.
 *
 * ONE ANSWER, TWO RENDERINGS. Both the JSON and the CSV come out of `analyticsFor`,
 * the only caller of `computePlatformAnalytics`, so the card and the file cannot
 * disagree about which salon fields feed a block.
 *
 * THE JSON IS READ-ONLY AND UNAUDITED — a card render is not an export, the
 * report-export ruling. THE FILE IS AUDITED, EVERY TIME, on both paths, in the
 * platform log (`platformExportAudit`).
 */

import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/client';
import { reportDownload, salon } from '../db/schema/salon';
import { platformAdmin } from '../db/schema/platformAdmin';
import { requirePlatform, type PlatformSection } from '../auth/principal';
import { hashWalletToken, mintWalletTokenValue } from '../auth/tokens';
import { badRequest, notFound } from '../http/errors';
import { writeAudit } from '../services/audit';
import {
  computePlatformAnalytics,
  monthKey,
  parseHistoryMonths,
  parseMonth,
  type CalendarMonth,
  type PlatformAnalytics,
  type PlatformAnalyticsSalon,
} from '../services/platformAnalytics';
import {
  parsePlatformPeriodToken,
  parsePlatformSection,
  platformCsv,
  platformDownloadKind,
  platformExportAudit,
  platformFilename,
  platformPeriodToken,
  platformRows,
  type PlatformAnalyticsSection,
} from '../services/platformAnalyticsExport';

interface PlatformAnalyticsQuery {
  month?: unknown;
  months?: unknown;
  salon?: unknown;
  section?: unknown;
}

/**
 * `?salon=`. Absent or empty is every salon. A string is looked up and an unknown
 * one is 404; anything else (a repeated `?salon=a&salon=b`, which arrives as an
 * array) is 400 rather than a quiet "every salon".
 */
async function resolveSalon(value: unknown): Promise<PlatformAnalyticsSalon | null> {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw badRequest('invalid_salon', 'salon must be one salon id.');
  const [row] = await db
    .select({
      id: salon.id,
      name: salon.name,
      moduleBooking: salon.moduleBooking,
      moduleShop: salon.moduleShop,
    })
    .from(salon)
    .where(eq(salon.id, value.trim()))
    .limit(1);
  if (!row) throw notFound('unknown_salon', 'No such salon.');
  return row;
}

/**
 * THE ONE PLACE THE CONSOLE'S ANALYTICS ARE COMPUTED — for the card, the file and
 * the link. `sections` is passed in because the link has no request principal: it
 * passes the admin row's sections AS THEY ARE NOW.
 */
function analyticsFor(input: {
  month: CalendarMonth;
  months: number;
  salon: PlatformAnalyticsSalon | null;
  sections: Record<PlatformSection, boolean>;
  now: Date;
}): Promise<PlatformAnalytics> {
  return computePlatformAnalytics(db, input);
}

/** A platform admin row's sections. `auth/principal.ts § loadPlatformPrincipal`'s mapping. */
function sectionsOf(row: typeof platformAdmin.$inferSelect): Record<PlatformSection, boolean> {
  return {
    analytics: row.permAnalytics,
    activity: row.permActivity,
    salons: row.permSalons,
    accounts: row.permAccounts,
    admins: row.permAdmins,
    controls: row.permControls,
    approvals: row.permApprovals,
    policies: row.permPolicies,
    audit: row.permAudit,
  };
}

/**
 * A console link's redemption, called from `GET /report-downloads/:token` once
 * that route has SPENT the token and confirmed the row is a console row
 * (`platform_admin_id` set, `staff_id` NULL).
 *
 * THE ADMIN IS RE-READ HERE, as she is now — the Reports rule: deactivated, or
 * `analytics` revoked, between click and navigation stops the file; `approvals`
 * or `policies` revoked withholds those two blocks. The salon scope is re-read
 * too: a salon cannot vanish (its FK restricts), but its modules can change, and
 * the file answers as the JSON would now. Returns null for a refusal so the
 * caller answers with its one uniform `invalid_download`.
 */
export async function redeemPlatformAnalyticsDownload(
  row: typeof reportDownload.$inferSelect & { platformAdminId: string },
  section: PlatformAnalyticsSection | null,
): Promise<{ filename: string; csv: string; rowCount: number; window: string } | null> {
  const [admin] = await db
    .select()
    .from(platformAdmin)
    .where(eq(platformAdmin.id, row.platformAdminId))
    .limit(1);
  if (!admin || !admin.active || !admin.permAnalytics) return null;

  const now = new Date();
  let month: CalendarMonth;
  let months: number;
  try {
    // Parsed back out of the stored token, then through the mint's own parsers, so
    // a row carrying anything the mint would have refused is refused here too.
    const window = parsePlatformPeriodToken(row.period);
    month = parseMonth(window.month, now);
    months = parseHistoryMonths(window.months);
  } catch {
    return null;
  }
  const scoped = row.salonId === null ? null : await resolveSalon(row.salonId);

  const analytics = await analyticsFor({ month, months, salon: scoped, sections: sectionsOf(admin), now });
  const rows = platformRows(analytics, section);

  // Awaited before the bytes leave: an untraced export must not be reachable.
  await writeAudit(
    db,
    { kind: 'platform_admin', id: admin.id, name: admin.name, role: admin.role },
    platformExportAudit({
      salonId: scoped?.id ?? null,
      section,
      month: analytics.month,
      months,
      rowCount: rows.length,
      via: 'download-link',
    }),
  );

  return {
    filename: platformFilename(scoped?.name ?? null, analytics.month, months, section),
    csv: platformCsv(rows),
    rowCount: rows.length,
    window: platformPeriodToken(analytics.month, months),
  };
}

export async function registerPlatformAnalyticsRoutes(app: FastifyInstance): Promise<void> {
  /** The file. Registered before the JSON route, the Overview's order. */
  app.get<{ Querystring: PlatformAnalyticsQuery }>('/v1/platform/analytics.csv', async (req, reply) => {
    const p = requirePlatform(req, 'analytics');

    const query = (req.query ?? {}) as PlatformAnalyticsQuery;
    const now = new Date();
    const month = parseMonth(query.month, now);
    const months = parseHistoryMonths(query.months);
    const section = parsePlatformSection(query.section);
    const scoped = await resolveSalon(query.salon);

    const analytics = await analyticsFor({ month, months, salon: scoped, sections: p.sections, now });
    const rows = platformRows(analytics, section);

    /**
     * AUDITED BEFORE THE BYTES LEAVE, and awaited — if the audit write fails the
     * export fails.
     */
    await writeAudit(
      db,
      p,
      platformExportAudit({
        salonId: scoped?.id ?? null,
        section,
        month: monthKey(month),
        months,
        rowCount: rows.length,
        via: 'csv',
      }),
    );

    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header(
        'content-disposition',
        `attachment; filename="${platformFilename(scoped?.name ?? null, monthKey(month), months, section)}"`,
      )
      .header('cache-control', 'no-store')
      .send(platformCsv(rows));
  });

  /**
   * `POST /v1/platform/analytics/download-url` — the Overview's one-time link: same
   * table, same token grain (16 bytes CSPRNG, sha256-stored, 60 s, single-use),
   * same redemption route, which dispatches on `kind`. The row is a CONSOLE row
   * (migration 0071): `platform_admin_id` is the minting admin, `staff_id` NULL,
   * `salon_id` the scope or NULL.
   *
   * The filter is in the body, `{ month?, months?, salon?, section? }`, or the
   * query string — a JSON object body wins outright, never merged. THE MINT IS THE
   * GATE AND VALIDATES EVERYTHING the file will need, so a bad value is a 400/404
   * now rather than a dead link in sixty seconds.
   *
   * Not idempotency-keyed: it moves no money and a replay mints a second
   * sixty-second capability for the same caller, which is what a second click does.
   */
  app.post<{ Querystring: PlatformAnalyticsQuery; Body: unknown }>(
    '/v1/platform/analytics/download-url',
    async (req, reply) => {
      const p = requirePlatform(req, 'analytics');

      const body = req.body;
      const src: PlatformAnalyticsQuery =
        body !== null && typeof body === 'object' && !Array.isArray(body)
          ? (body as PlatformAnalyticsQuery)
          : ((req.query ?? {}) as PlatformAnalyticsQuery);

      const month = parseMonth(src.month, new Date());
      const months = parseHistoryMonths(src.months);
      const section = parsePlatformSection(src.section);
      const scoped = await resolveSalon(src.salon);

      const token = mintWalletTokenValue();
      const expiresAt = new Date(Date.now() + 60_000);

      await db.insert(reportDownload).values({
        staffId: null,
        platformAdminId: p.id,
        salonId: scoped?.id ?? null,
        kind: platformDownloadKind(section),
        branchId: null,
        period: platformPeriodToken(monthKey(month), months),
        tokenHash: hashWalletToken(token),
        expiresAt,
      });

      return reply.header('cache-control', 'no-store').send({
        url: `/report-downloads/${token}`,
        expiresAt: expiresAt.toISOString(),
      });
    },
  );

  app.get<{ Querystring: PlatformAnalyticsQuery }>('/v1/platform/analytics', async (req, reply) => {
    const p = requirePlatform(req, 'analytics');

    const now = new Date();
    const month = parseMonth(req.query?.month, now);
    const months = parseHistoryMonths(req.query?.months);
    const scoped = await resolveSalon(req.query?.salon);

    return reply.send(await analyticsFor({ month, months, salon: scoped, sections: p.sections, now }));
  });
}
