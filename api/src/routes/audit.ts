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

import { and, desc, eq, ilike, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/client';
import { auditLog } from '../db/schema/audit';
import { requireDashboardPerm, requireSameSalon } from '../auth/principal';
import { badRequest } from '../http/errors';

/** The four filter chips, plus the "All" that means no filter. */
const KINDS = ['money', 'rules', 'access', 'risk'] as const;
type AuditKind = (typeof KINDS)[number];

/**
 * The Source column, as the design writes it. The database stores a machine
 * value; the dashboard renders "Owner console", capital O, lower c.
 *
 * Mapped here rather than in the client for the same reason the 403 copy is:
 * one place decides what the product calls a thing, and the audit log is read
 * seven years later by someone reconciling a dispute.
 */
const SOURCE_LABEL: Record<string, string> = {
  merchant: 'Merchant',
  scanner: 'Scanner',
  wallet: 'Wallet',
  owner_console: 'Owner console',
  system: 'System',
};

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

function parseLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LIMIT;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    throw badRequest('invalid_limit', `limit must be a whole number between 1 and ${MAX_LIMIT}.`);
  }
  return n;
}

/**
 * The cursor is the `seq` of the last row already delivered.
 *
 * `seq` and not `created_at`: it is a bigserial, so it is strictly monotonic in
 * write order and unique, which makes `seq < cursor` a total order with no ties
 * to break. Two audit rows written in the same millisecond — a charge and its
 * loyalty line — would otherwise be able to straddle a page boundary and either
 * repeat or vanish.
 */
function parseCursor(value: unknown): number | null {
  if (value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw badRequest('invalid_cursor', 'cursor must be the seq of the last row you received.');
  }
  return n;
}

function parseKinds(value: unknown): AuditKind[] | null {
  if (value === undefined || value === '' || value === 'all') return null;
  const raw = String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = raw.filter((k) => !(KINDS as readonly string[]).includes(k));
  if (bad.length > 0) {
    throw badRequest('invalid_kind', `Unknown filter: ${bad.join(', ')}. Use ${KINDS.join(', ')} or all.`);
  }
  return raw.length > 0 ? (raw as AuditKind[]) : null;
}

/**
 * The search box: "Search staff, customer or action".
 *
 * Matched against the four columns the design's own filter reads —
 * `who + action + detail + role`. `%` and `_` are escaped so a merchant typing a
 * literal underscore (they appear in `subject_type` values and in staff handles)
 * searches for that character rather than for any character.
 */
function searchPredicate(q: string): SQL | undefined {
  const escaped = q.replace(/[\\%_]/g, (c) => `\\${c}`);
  const like = `%${escaped}%`;
  return or(
    ilike(auditLog.actorName, like),
    ilike(auditLog.actorRole, like),
    ilike(auditLog.action, like),
    ilike(auditLog.detail, like),
  );
}

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

    const limit = parseLimit(req.query.limit);
    const cursor = parseCursor(req.query.cursor);
    const kinds = parseKinds(req.query.kind);
    const q = (req.query.q ?? '').trim();

    // Scoped from the PRINCIPAL, not from the path. See the file header.
    const filters: (SQL | undefined)[] = [eq(auditLog.salonId, p.salonId)];
    if (kinds) filters.push(inArray(auditLog.kind, kinds));
    if (q !== '') filters.push(searchPredicate(q));

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
      .select({ total: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(where);

    return reply.send({
      items: page.map((r) => ({
        id: r.id,
        seq: r.seq,
        /**
         * ISO, not "Today · 6:42 PM". The design's relative phrasing is a
         * rendering decision that depends on the reader's clock and language —
         * and non-negotiable #12 makes the Arabic dashboard a first-class
         * layout, not a string swap. The server sends the instant.
         */
        when: r.createdAt.toISOString(),
        who: r.actorName,
        role: r.actorRole,
        actorKind: r.actorKind,
        /** Soft reference. Null for a system action — see db/schema/audit.ts. */
        actorId: r.actorId,
        /** The pill colour: money / rules / access / risk. */
        kind: r.kind,
        action: r.action,
        detail: r.detail,
        source: r.source,
        /** "Owner console" — the label the design's Source column renders. */
        sourceLabel: SOURCE_LABEL[r.source] ?? r.source,
        /**
         * True for an AVO platform action on this salon. The dashboard's footnote
         * calls these out specifically, and a boolean is a cheaper thing for a
         * client to style on than a string comparison it has to keep in sync.
         */
        isPlatformAction: r.source === 'owner_console',
        subjectType: r.subjectType,
        subjectId: r.subjectId,
        /** Present on money rows — the CHECK guarantees it. Integer fils. */
        amountFils: r.amountFils,
      })),
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
