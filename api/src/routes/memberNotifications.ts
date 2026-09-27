/**
 * THE CUSTOMER BELL — the two doors. Client ask 4 (wallet list).
 *
 *   GET  /members/me/notifications/feed   the feed, the badge, and the filter
 *   POST /members/me/notifications/read   mark read — named ids, or all
 *
 * `services/memberNotifications.ts` carries the decisions — what a customer
 * notification is, why it is read from the outbound records rather than copied,
 * how #8 and #12 shape it. This file is the wiring, and the shapes follow the
 * merchant bell's (`routes/merchantNotifications.ts`) on purpose: one read that
 * carries the badge, one write for both "these" and "all", the same refusals.
 *
 * WHY UNDER `/members/me/notifications/`. That path is already the PREFERENCES —
 * `GET/PATCH /members/me/notifications`, pinned by `e2e/contract.test.ts` as a
 * settings shape. The feed does not replace it and does not change its body; it
 * sits beside it, because "manage them" is these two doors plus that one. A feed
 * at a new top-level name would put the switches and the thing they govern in two
 * places a reader has to know to connect.
 *
 * NOT AUDITED, for the merchant bell's reason: it is ambient chrome that the
 * wallet will poll, and a read of one's own notifications is not a deliberate act
 * on anyone else's record. Mark-read moves no money and grants no authority.
 *
 * NO IDEMPOTENCY KEY, AND IDEMPOTENT ANYWAY — non-negotiable #4 is about
 * money-moving POSTs, and this moves none; a second mark matches no unread row and
 * returns `marked: 0` with the same `unreadCount`.
 */

import type { FastifyInstance } from 'fastify';
import { db } from '../db/client';
import { requireMember } from '../auth/principal';
import { badRequest } from '../http/errors';
import {
  BELL_RANKS,
  MEMBER_MARK_READ_MAX_IDS,
  markMemberNotificationsRead,
  readMemberFeed,
} from '../services/memberNotifications';
import { parseCursor } from '../services/streamCursor';

export async function registerMemberNotificationRoutes(app: FastifyInstance): Promise<void> {
  // --------------------------------------- GET /members/me/notifications/feed --
  /**
   * SCOPED BY THE CREDENTIAL. `p.id` is the only member id this handler reads; there
   * is no id in the URL, so another customer's bell is not addressable at all.
   */
  app.get<{ Querystring: { cursor?: string } }>(
    '/members/me/notifications/feed',
    async (req, reply) => {
      const p = requireMember(req);
      const cursor = parseCursor(req.query?.cursor, BELL_RANKS);
      return reply.send(await readMemberFeed(db, p.id, cursor));
    },
  );

  // -------------------------------------- POST /members/me/notifications/read --
  /**
   * `{ ids: [...] }` for what the panel showed, `{ all: true }` for "mark all read".
   * Exactly one — the merchant bell's refusal and its reasons, word for word: `{}`
   * marking nothing is a silent no-op the client reads as success, and both at once
   * is two intentions.
   *
   * AN ID THAT MATCHES NOTHING IS NOT AN ERROR. Another customer's transaction id
   * answers exactly as an already-read one does — `marked: 0` — because a 404 would
   * tell her the id is real.
   */
  app.post<{ Body: { ids?: unknown; all?: unknown } }>(
    '/members/me/notifications/read',
    async (req, reply) => {
      const p = requireMember(req);

      const body = (req.body ?? {}) as { ids?: unknown; all?: unknown };
      const all = body.all === true;
      const hasIds = body.ids !== undefined;
      if (all === hasIds) {
        throw badRequest(
          'selection_required',
          'Send either { ids: [...] } or { all: true }, and not both.',
        );
      }

      if (all) return reply.send(await markMemberNotificationsRead(db, p.id, { all: true }));

      if (!Array.isArray(body.ids) || body.ids.some((v) => typeof v !== 'string' || v === '')) {
        throw badRequest('invalid_ids', 'ids must be an array of notification ids.');
      }
      const ids = [...new Set(body.ids as string[])];
      if (ids.length === 0) {
        throw badRequest('invalid_ids', 'ids must name at least one notification.');
      }
      if (ids.length > MEMBER_MARK_READ_MAX_IDS) {
        throw badRequest(
          'too_many_ids',
          `ids may name at most ${MEMBER_MARK_READ_MAX_IDS} notifications. Use { all: true }.`,
        );
      }
      return reply.send(await markMemberNotificationsRead(db, p.id, { ids }));
    },
  );
}
