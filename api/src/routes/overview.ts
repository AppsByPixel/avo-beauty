/**
 *   GET /v1/salons/{id}/overview/analytics?branch=&period=     perms.dashboard
 *
 * The data behind the Overview's widgets that no existing endpoint already
 * answers. `services/overviewAnalytics.ts` carries every definition, which
 * widgets reuse which existing endpoint instead, and the five blocks that need a
 * second permission on top of this one.
 *
 * THE SAME THREE CALLS IN THE SAME ORDER AS `GET /salons/{id}/metrics`:
 *
 *   1. `requireDashboardPerm(req, 'dashboard')` — non-negotiable #7, and the
 *      surface half: a scanner PIN session is refused even for a frontdesk who
 *      holds `dashboard` on her tablet.
 *   2. `requireSameSalon` — before any lookup, so a caller who is not this salon's
 *      staff cannot learn from 404-vs-200 whether a branch id exists here.
 *   3. `parsePeriod`, then the salon row, then `resolveBranchFilter` — parsing
 *      needs no zone, resolving does. A branch of another salon is 404
 *      `unknown_branch`, indistinguishable from one that does not exist.
 *
 * `?compare=` is not accepted, for `/metrics`' reason: nothing here is a
 * two-window statistic. Unknown parameters are dropped by Fastify.
 *
 * READ-ONLY. No money moves and nothing is written, so there is no idempotency
 * key and no audit row — the Overview's other reads write none either.
 */

import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/client';
import { salon } from '../db/schema/salon';
import { requireDashboardPerm, requireSameSalon } from '../auth/principal';
import { notFound } from '../http/errors';
import { resolveBranchFilter } from '../services/branchFilter';
import { parsePeriod } from '../services/period';
import { computeOverviewAnalytics } from '../services/overviewAnalytics';

export async function registerOverviewRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string }; Querystring: { period?: string; branch?: unknown } }>(
    '/v1/salons/:id/overview/analytics',
    async (req, reply) => {
      const p = requireDashboardPerm(req, 'dashboard');
      requireSameSalon(p, req.params.id);

      const period = parsePeriod(req.query?.period);

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
        .where(eq(salon.id, req.params.id))
        .limit(1);
      const s = rows[0];
      if (!s) throw notFound('unknown_salon', 'No such salon.');

      const branch = await resolveBranchFilter(db, s.id, req.query?.branch);

      return reply.send(
        await computeOverviewAnalytics(db, {
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
           * READ OFF THE PRINCIPAL, which `resolvePrincipal` read from `staff_user`
           * on this request — never from a claim. The five section-gated blocks
           * are decided from exactly the flags `requirePerm` reads.
           */
          perms: p.perms,
          now: new Date(),
        }),
      );
    },
  );
}
