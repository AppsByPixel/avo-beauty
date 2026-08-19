/**
 * The audit log, as the merchant dashboard reads it.
 *
 *   GET /salons/{id}/audit   perms.dashboard
 *
 * design/AVO Merchant Dashboard.dc.html § Audit log: "Every charge, void,
 * reimbursement, rule change and permission change in this salon — who did it
 * and from where. Append-only: nothing here can be edited or deleted."
 *
 * THIS ENDPOINT ONLY READS
 * -----------------------
 * There is no POST here and there will not be one. Rows are written by the
 * handlers that cause them, inside the same transaction as the effect they
 * describe (services/audit.ts), which is what makes the log a record rather than
 * a report. An endpoint that let a client append would let a client append a
 * lie, and `UPDATE`/`DELETE` are revoked from `avo_app` in migration 0001
 * precisely so nobody can tidy one away afterwards.
 *
 * SALON SCOPING IS TWO PREDICATES, NOT ONE
 * ----------------------------------------
 *   1. `requireSameSalon` refuses the request outright if the path names another
 *      salon. A merchant probing `/salons/SAL-LUMIERE/audit` gets a 403 and no
 *      information about whether that salon exists.
 *   2. The query filters on `p.salonId` — the principal's own salon from the
 *      verified session — and NOT on `req.params.id`.
 *
 * The second is what actually protects the data, and it is written from the
 * principal on purpose: if a future refactor loosened the first check, the query
 * would still be scoped. routes/staff.ts § POST /scans has the same doubling,
 * and the reason there was a real cross-tenant read that got through because one
 * of two lookups was scoped and the other was not.
 *
 * PLATFORM ROWS ARE INCLUDED, AND MARKED
 * --------------------------------------
 * "AVO platform staff actions on your salon appear here too, marked **Owner
 * console**." An owner-console action against this salon carries this salon's
 * `salon_id`, so it arrives through the same predicate. It is `source =
 * 'owner_console'`, which is the distinction the merchant is entitled to see —
 * AVO adjusting a customer's wallet from support is something the salon must be
 * able to find, not something to filter out of its own log.
 *
 * Platform actions belonging to NO salon have a null `salon_id` and are
 * therefore invisible here, which is correct: they are the owner console's own
 * business, and `salon_id = $1` excludes null without anyone having to remember
 * to.
 */

import { and, desc, eq, inArray, lt, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/client';
import { auditLog } from '../db/schema/audit';
import { requireDashboardPerm, requireSameSalon } from '../auth/principal';
import {
  auditSearchPredicate,
  auditTotal,
  parseAuditCursor,
  parseAuditKinds,
  parseAuditLimit,
  serialiseAuditRow,
} from '../services/auditRead';

/**
 * THE FILTER GRAMMAR, THE CURSOR RULE AND THE ROW SHAPE NOW LIVE IN
 * `services/auditRead.ts`, shared with the owner console's
 * `GET /v1/platform/audit`.
 *
 * They were defined here, which was correct while this was the only audit screen
 * and became a hazard the moment there were two. An audit log is read years later
 * by somebody reconciling a dispute, and the two screens WILL be compared: a
 * `kind` chip that means something slightly different on the console, or a cursor
 * that pages differently, turns "these screens disagree" into a question about the
 * record itself. One function, two surfaces — the rule `readMessagingPolicy`
 * follows.
 *
 * WHAT STAYS HERE IS THE ONLY REAL DIFFERENCE: the scoping. That is the part that
 * must NOT be shared, because it is the tenancy boundary.
 */

export async function registerAuditRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Params: { id: string };
    Querystring: { q?: string; kind?: string; limit?: string; cursor?: string };
  }>('/salons/:id/audit', async (req, reply) => {
    /**
     * perms.dashboard. FIRST STATEMENT.
     *
     * The audit log is the dashboard's own screen — it sits in the same sidebar
     * as Overview, behind the permission that opens the dashboard at all. It is
     * deliberately NOT gated on `perms.team` or `perms.loyalty`: a manager who
     * can see the salon's numbers should be able to see who changed them, and
     * splitting the log by the permission each row happens to concern would
     * produce a partial history, which is the one thing an audit log must never
     * be.
     */
    const p = requireDashboardPerm(req, 'dashboard');
    requireSameSalon(p, req.params.id);

    const limit = parseAuditLimit(req.query.limit);
    const cursor = parseAuditCursor(req.query.cursor);
    const kinds = parseAuditKinds(req.query.kind);
    const q = (req.query.q ?? '').trim();

    // Scoped from the PRINCIPAL, not from the path. See the file header.
    const filters: (SQL | undefined)[] = [eq(auditLog.salonId, p.salonId)];
    if (kinds) filters.push(inArray(auditLog.kind, kinds));
    if (q !== '') filters.push(auditSearchPredicate(q));

    const where = and(...filters.filter((f): f is SQL => f !== undefined));
    // The cursor narrows the page but must not change the count the header shows.
    const pageWhere = cursor === null ? where : and(where, lt(auditLog.seq, cursor));

    const rows = await db
      .select()
      .from(auditLog)
      .where(pageWhere)
      // Newest first, and `seq` is the only tiebreak-free ordering. See parseCursor.
      .orderBy(desc(auditLog.seq))
      // One extra row, to answer "is there another page?" without a second count.
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;

    /**
     * The count beside the filter chips. Run against `where` rather than
     * `pageWhere` so it answers "how many entries match this search", which is
     * what the design's `mAuditCount` reads, and does not shrink as the merchant
     * pages through.
     */
    const [counted] = await db
      .select({ total: auditTotal })
      .from(auditLog)
      .where(where);

    return reply.send({
      items: page.map(serialiseAuditRow),
      total: counted?.total ?? 0,
      /** The `seq` to send back as `cursor`. Null when this is the last page. */
      nextCursor: hasMore ? (page[page.length - 1]?.seq ?? null) : null,
      /**
       * Stated on the wire because the design states it on the screen, and
       * because it is the property that makes the rest of the response worth
       * reading. Enforced in migration 0001, not by this claim.
       */
      appendOnly: true,
      retentionYears: 7,
    });
  });
}
