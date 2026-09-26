/**
 * THE MERCHANT BELL — the two doors. Aftab's item 4: *"Notification bell on top
 * right"*.
 *
 *   GET  /v1/salons/{id}/notifications        the feed, the badge, and the filter
 *   POST /v1/salons/{id}/notifications/read   mark read — named ids, or all
 *
 * `services/merchantNotifications.ts` carries the two decisions: why the feed is
 * FILTERED to the kinds the reader's permissions cover rather than gated on their
 * union, and what the feed and the count each contain with respect to `read_at`
 * and `resolved_at`. Read that header first; this file is the wiring, the shapes,
 * and the three things that are about ROUTES rather than about the bell.
 *
 * =========================================================================
 * WHY ONE READ ENDPOINT AND NOT TWO
 * =========================================================================
 * The badge needs a count before the panel is ever opened, which is the usual
 * argument for a cheap `GET …/notifications/count` beside the feed. It is declined.
 * A page is twenty rows of short text; the panel in `AVO Merchant Dashboard.dc.html`
 * is a 340px scroller that shows about four. Fetching both from one response costs
 * nothing a second round trip would save, and a second endpoint over the same
 * columns is the two-doors defect `routes/salons.ts` records against the tier
 * ladder — "two doors into one set of columns, and the one nobody is reading is the
 * one that drifts". Here the drift would be silent and specific: a count endpoint
 * whose `resolved_at IS NULL` term went missing shows a badge over a panel that has
 * nothing in it, and nothing in the system disagrees.
 *
 * `unreadCount` IS NOT CURSOR-DEPENDENT. It is an aggregate over the whole visible
 * set and comes back identical on page four. That is deliberate — a badge that
 * counted the current page would be a different number for the same bell.
 *
 * =========================================================================
 * WHY THE READ IS NOT AUDITED, WHEN THE CUSTOMER BOOK'S IS
 * =========================================================================
 * `routes/customers.ts` writes an `audit_log` row per directory read and argues
 * hard for it. The bell does not, and the difference is not effort.
 *
 * A directory read is a DELIBERATE ACT: someone typed a name. The audit row answers
 * "who looked her up", and `enforceCustomerDirectoryLimit` counts those same rows to
 * cap a walk. The bell is AMBIENT — it is chrome on every screen and the dashboard
 * will poll it. Auditing it would write a row per poll per signed-in staff member
 * into a table that is append-only for seven years and that the application role
 * cannot trim, and it would bury the deliberate reads it exists to surface under
 * millions of rows of nobody doing anything. `services/activityFeed.ts` and
 * `GET /salons/:id/activity` make the same choice for the same reason.
 *
 * The bell does carry a member's name inside a `booking_no_show` body, which is why
 * the kind is behind `appointments` — the permission that already opens the booking
 * list that name is on. The gate is the control here; the log is not.
 *
 * MARK-READ IS NOT AUDITED EITHER. It moves no money and grants no authority, and
 * the one thing it could do at someone else's expense — clearing a colleague's
 * badge for a kind you cannot see — is prevented rather than recorded. See the
 * filter on the write below.
 *
 * =========================================================================
 * NO IDEMPOTENCY KEY, AND THE ENDPOINT IS IDEMPOTENT ANYWAY
 * =========================================================================
 * Non-negotiable #4 is about money-moving POSTs. This moves none. But a double
 * submit is the normal case for a panel that marks read on open, so the write is
 * `SET read_at = now() WHERE read_at IS NULL` — a second call matches no rows,
 * changes nothing, and returns `marked: 0` with the same `unreadCount`. The first
 * call's timestamp is never overwritten, so "when was this seen" stays true.
 */

import { and, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/client';
import { merchantNotification } from '../db/schema/notification';
import { requireDashboardScope, requireSameSalon } from '../auth/principal';
import { badRequest } from '../http/errors';
import {
  MARK_READ_MAX_IDS,
  NOTIFICATION_PAGE_SIZE,
  serialiseNotification,
  visibleKinds,
} from '../services/merchantNotifications';
import type { NotificationKind } from '../services/notifications';
import {
  afterCursor,
  cursorInstant,
  encodeCursor,
  parseCursor,
} from '../services/streamCursor';

/** One stream, one table. Its own rank set, so no other endpoint's cursor addresses it. */
const BELL_RANKS = [0];

/**
 * THE VISIBILITY PREDICATE, AND THE EMPTY CASE IS WRITTEN OUT ON PURPOSE.
 *
 * Drizzle renders `inArray(col, [])` as a false constant, which is the right
 * answer — but relying on it means the most security-relevant branch in this file
 * is the one with no code in it, decided inside a dependency. A reader with no
 * relevant permission must see nothing, so that is stated here where it can be
 * read, and it cannot change under a library upgrade.
 */
function visibilityPredicate(kinds: NotificationKind[]) {
  if (kinds.length === 0) return sql`false`;
  return inArray(merchantNotification.kind, kinds);
}

/** The badge: unread AND unresolved, over the visible kinds. See the service header. */
async function unreadCountFor(salonId: string, kinds: NotificationKind[]): Promise<number> {
  if (kinds.length === 0) return 0;
  const [row] = await db
    .select({ n: count() })
    .from(merchantNotification)
    .where(
      and(
        eq(merchantNotification.salonId, salonId),
        visibilityPredicate(kinds),
        isNull(merchantNotification.readAt),
        isNull(merchantNotification.resolvedAt),
      ),
    );
  return Number(row?.n ?? 0);
}

export async function registerMerchantNotificationRoutes(app: FastifyInstance): Promise<void> {
  // ------------------------------------- GET /v1/salons/:id/notifications --
  /**
   * THE FEED. Newest first, every row the reader may see, resolved ones included.
   *
   * ORDERED `created_at DESC, id ASC` and paged on that key. The bell is the one
   * screen where "newest first" needs no defending, and `services/streamCursor.ts`
   * serves an instant-keyed stream exactly. `id ASC` breaks the tie two rows raised
   * inside one transaction would otherwise leave open — `noShowWorker.ts` raises
   * its notification inside the deposit-return transaction, so two no-shows
   * processed in one sweep can share `created_at` to the microsecond.
   *
   * IT PAGES BECAUSE IT GROWS. A resolved row stays in the feed forever (service
   * header, decision 2), so this list has no ceiling — which is precisely the
   * shape `GET /members/me/transactions` gets wrong with a bare `.limit(50)` and a
   * null cursor, "a feed that stops and says it has not".
   *
   * `merchant_notification_salon_created_idx` is `(salon_id, created_at DESC)` and
   * already serves this exactly; the kind filter is a residual over one salon's
   * rows. No migration.
   */
  app.get<{ Params: { id: string }; Querystring: { cursor?: string } }>(
    '/v1/salons/:id/notifications',
    async (req, reply) => {
      const p = requireDashboardScope(req);
      requireSameSalon(p, req.params.id);

      const kinds = visibleKinds(p.perms);
      const cursor = parseCursor(req.query?.cursor, BELL_RANKS);
      const take = NOTIFICATION_PAGE_SIZE + 1;

      const rows = await db
        .select({
          id: merchantNotification.id,
          kind: merchantNotification.kind,
          severity: merchantNotification.severity,
          title: merchantNotification.title,
          body: merchantNotification.body,
          deepLink: merchantNotification.deepLink,
          createdAt: merchantNotification.createdAt,
          readAt: merchantNotification.readAt,
          resolvedAt: merchantNotification.resolvedAt,
          cursorAt: cursorInstant(merchantNotification.createdAt),
        })
        .from(merchantNotification)
        .where(
          and(
            /**
             * Scoped from the PRINCIPAL, not the path — the doubling
             * `routes/customers.ts` and `routes/audit.ts` practise.
             * `requireSameSalon` has already established the two are equal; if
             * that guard were ever loosened this predicate would still be right.
             */
            eq(merchantNotification.salonId, p.salonId),
            visibilityPredicate(kinds),
            afterCursor(cursor, 0, merchantNotification.createdAt, merchantNotification.id),
          ),
        )
        .orderBy(desc(merchantNotification.createdAt), merchantNotification.id)
        .limit(take);

      const hasMore = rows.length > NOTIFICATION_PAGE_SIZE;
      const page = rows.slice(0, NOTIFICATION_PAGE_SIZE);
      const last = page[page.length - 1];

      return reply.send({
        items: page.map(serialiseNotification),
        nextCursor:
          hasMore && last ? encodeCursor({ at: last.cursorAt, rank: 0, id: last.id }) : null,
        /** Unread AND unresolved. Not the length of `items`, and not page-dependent. */
        unreadCount: await unreadCountFor(p.salonId, kinds),
        /**
         * THE FILTER, DECLARED. Without it "You're all caught up." is a sentence
         * the client cannot tell apart from "the things waiting for this salon are
         * all things you may not see". Service header, decision 1.
         */
        visibleKinds: kinds,
      });
    },
  );

  // ------------------------------- POST /v1/salons/:id/notifications/read --
  /**
   * MARK READ. `{ ids: [...] }` for what the panel showed, `{ all: true }` for the
   * design's "Mark all read" button (`AVO Merchant Dashboard.dc.html:99`).
   *
   * ONE ROUTE FOR BOTH, because they are one operation over a different selection.
   * A separate `…/read-all` would be a second writer of `read_at` and would have to
   * repeat the visibility filter — and the copy of a filter that nobody is reading
   * is the one that drifts open.
   *
   * THE WRITE TAKES THE SAME FILTER AS THE READ, and this is the sharp edge of
   * `read_at` being salon-wide rather than per-staff. Without it, a front desk
   * holding `appointments` alone could press "Mark all read" and clear the
   * marketing manager's `campaign_held` badge — a row she cannot see, about work
   * she cannot do. You may only mark read what you could have read.
   *
   * AN ID THAT MATCHES NOTHING IS NOT AN ERROR, and that is a deliberate refusal
   * to build an oracle. `services/memberSearch.ts § resolveMember` argues it for
   * member ids: "a distinct 403 would confirm that the id is real". Here the
   * spread is wider — a 404 on an unmatched id would distinguish *does not exist*
   * from *another salon's* from *a kind you may not see*, and that last one turns
   * this endpoint into a probe for "does this salon have a held campaign" for
   * someone who holds no `marketing`. So every miss looks the same: the row is not
   * in the UPDATE's scope, and `marked` does not count it. `marked: 0` is
   * indistinguishable from an id that was already read, which is the point.
   *
   * `requireSameSalon` still answers 403 on the SALON in the path, because that is
   * a different question — whether this workspace is hers — and it leaks nothing
   * about any row. The same split as the customer card.
   */
  app.post<{ Params: { id: string }; Body: { ids?: unknown; all?: unknown } }>(
    '/v1/salons/:id/notifications/read',
    async (req, reply) => {
      const p = requireDashboardScope(req);
      requireSameSalon(p, req.params.id);

      const body = (req.body ?? {}) as { ids?: unknown; all?: unknown };
      const all = body.all === true;
      const hasIds = body.ids !== undefined;

      /**
       * EXACTLY ONE SELECTION, and both errors are named. `{}` marking nothing
       * would be a silent no-op the client reads as success; `{ all: true, ids:
       * [...] }` is two intentions and guessing which one wins is how a "mark all"
       * that was meant to mark three ends up clearing the salon.
       */
      if (all === hasIds) {
        throw badRequest(
          'selection_required',
          'Send either { ids: [...] } or { all: true }, and not both.',
        );
      }

      let ids: string[] = [];
      if (hasIds) {
        if (!Array.isArray(body.ids) || body.ids.some((v) => typeof v !== 'string' || v === '')) {
          throw badRequest('invalid_ids', 'ids must be an array of notification ids.');
        }
        // Deduplicated before the bound, so a client repeating one id cannot trip it.
        ids = [...new Set(body.ids as string[])];
        if (ids.length === 0) {
          throw badRequest('invalid_ids', 'ids must name at least one notification.');
        }
        if (ids.length > MARK_READ_MAX_IDS) {
          throw badRequest(
            'too_many_ids',
            `ids may name at most ${MARK_READ_MAX_IDS} notifications. Use { all: true }.`,
          );
        }
      }

      const kinds = visibleKinds(p.perms);

      const marked =
        kinds.length === 0
          ? []
          : await db
              .update(merchantNotification)
              .set({ readAt: new Date() })
              .where(
                and(
                  eq(merchantNotification.salonId, p.salonId),
                  visibilityPredicate(kinds),
                  /**
                   * IDEMPOTENCE, AS A PREDICATE. A second call matches no rows and
                   * the first call's timestamp survives, so "when was this seen"
                   * stays true however many times the panel reopens.
                   */
                  isNull(merchantNotification.readAt),
                  hasIds ? inArray(merchantNotification.id, ids) : undefined,
                ),
              )
              .returning({ id: merchantNotification.id });

      return reply.send({
        /** How many rows actually flipped. `0` on the second call, by design. */
        marked: marked.length,
        unreadCount: await unreadCountFor(p.salonId, kinds),
      });
    },
  );
}
