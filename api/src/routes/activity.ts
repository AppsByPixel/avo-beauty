/**
 * Recent activity — design/AVO Merchant Dashboard.dc.html § Overview.
 *
 *   GET /salons/{id}/activity   perms.dashboard
 *
 * WHAT WAS WRONG WITH READING THIS OFF `GET /charges`
 * ---------------------------------------------------
 * Lane C reported `GET /charges` as the only salon-scoped transaction stream, so
 * the Overview feed was going to be charges and nothing else. The design's feed
 * is five lines and only one of them is a charge:
 *
 *     Latifa A.  topped up 25.000 via KNET       transaction, kind=topup
 *     Mona K.    paid 12.000 · Cut & style       transaction, kind=charge
 *     System     returned 5.000 deposit …        transaction, kind=deposit_return
 *     Reem S.    reached Gold tier               loyalty_event
 *     Noura F.   bought Repair serum · 9.500     transaction, kind=shop
 *
 * A charges-only feed is not a smaller version of that, it is a different claim:
 * a merchant watching it would see money leaving wallets and never see it
 * arriving, and would conclude her salon had a quiet morning on a day when
 * everyone topped up.
 *
 * `GET /charges` is also the wrong endpoint to widen. It is SCANNER-scoped and
 * behind `perms.charges` — api-contract.md calls that "a senior permission" and
 * spells out the surface, "can open Today's charges ON THE SCANNER". This is a
 * dashboard panel behind `perms.dashboard`. Two different questions, two
 * different authorities, two endpoints.
 *
 * TWO SOURCES, MERGED, AND WHY NOT IN SQL
 * ---------------------------------------
 * `transaction` and `loyalty_event` have no common key and no shared sequence.
 * A `UNION ALL` over projected columns would work and would need every future
 * column added to both halves in the same shape — the same duplication
 * http/serialise.ts exists to prevent one level down. Instead each source is
 * read with its own `ORDER BY created_at DESC LIMIT n` — both index-backed — and
 * merged in memory.
 *
 * That is sound because the merge is bounded: to return `limit` rows newest
 * first, it is enough to take `limit` from each source, since no source can
 * contribute more than `limit` rows to the answer. Reading 2×50 rows to serve 50
 * is the cost, and it is a fixed cost, not one that grows with the salon.
 *
 * NO CURSOR, ON PURPOSE
 * ---------------------
 * The design draws five lines on the Overview and no "load more". A cursor over
 * a merged stream needs a composite position — one offset per source — and every
 * client that got one would have to carry it correctly. The endpoint that pages
 * is `GET /salons/{id}/audit`, which has a single monotonic `seq` and is the
 * screen built for looking backwards.
 *
 * THE CONSOLE'S FEED DOES PAGE, and the paragraph above is still the reason this
 * one does not. `GET /v1/platform/activity` in `routes/platformConsole.ts` is a
 * whole screen rather than five lines on an Overview, so it pays for the composite
 * cursor described above and carries it as one opaque string. Same vocabulary,
 * different screen — the vocabulary is now `services/activityFeed.ts`.
 *
 * THE PHRASING MOVED OUT OF THIS FILE. `FEED_KINDS`, `FeedItem`,
 * `describeTransaction` and `describeLoyalty` are in `services/activityFeed.ts`
 * because a second read of the same streams appeared, and the top-up sentence is
 * exactly the kind of thing that must not be written twice: `amount_fils` is
 * "what actually landed, bonus included", so the obvious version of that line
 * tells a merchant her customer paid five dinars she did not. That header carries
 * the argument; `services/auditRead.ts` is the precedent.
 */

import { and, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/client';
import { member } from '../db/schema/member';
import { loyaltyEvent } from '../db/schema/loyaltyEvent';
import { transaction } from '../db/schema/transaction';
import { requireDashboardPerm, requireSameSalon } from '../auth/principal';
import {
  describeLoyalty,
  describeTransaction,
  FEED_KINDS,
  kd,
  parseFeedLimit,
  type FeedItem,
} from '../services/activityFeed';

export async function registerActivityRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/salons/:id/activity',
    async (req, reply) => {
      // perms.dashboard — this is the Overview panel, behind the permission that
      // opens the dashboard. NOT perms.charges: see the file header.
      const p = requireDashboardPerm(req, 'dashboard');
      requireSameSalon(p, req.params.id);

      const limit = parseFeedLimit(req.query.limit);

      /**
       * Scoped from the principal, not the path — the same doubling as
       * routes/audit.ts, and for the same reason: if the `requireSameSalon`
       * above were ever loosened, these queries would still be right.
       */
      const [txRows, loyaltyRows] = await Promise.all([
        db
          .select()
          .from(transaction)
          .where(
            and(
              eq(transaction.salonId, p.salonId),
              inArray(transaction.kind, [...FEED_KINDS]),
              /**
               * Settled only. A `pending` top-up is a customer staring at a
               * gateway page — reporting it as activity would put money in the
               * merchant's feed that may yet decline, and api-contract.md
               * § TopUpIntent is explicit that pending is "never a failure,
               * never a success".
               */
              eq(transaction.status, 'settled'),
            ),
          )
          .orderBy(desc(transaction.createdAt))
          .limit(limit),
        db
          .select()
          .from(loyaltyEvent)
          .where(eq(loyaltyEvent.salonId, p.salonId))
          .orderBy(desc(loyaltyEvent.seq))
          .limit(limit),
      ]);

      /**
       * One lookup for every name the page will print, rather than a join on
       * each stream. Two queries would each have to join `member` and both would
       * have to remember to scope it; one map is read once and used by both.
       */
      const memberIds = [
        ...new Set([...txRows.map((t) => t.memberId), ...loyaltyRows.map((l) => l.memberId)]),
      ];
      const names = new Map<string, string>();
      if (memberIds.length > 0) {
        const rows = await db
          .select({ id: member.id, name: member.name })
          .from(member)
          .where(and(eq(member.salonId, p.salonId), inArray(member.id, memberIds)));
        for (const r of rows) names.set(r.id, r.name);
      }

      const items: FeedItem[] = [
        ...txRows.map<FeedItem>((t) => ({
          id: t.id,
          stream: 'transaction',
          at: t.createdAt.toISOString(),
          /**
           * An automatic deposit return has no staff behind it and the design
           * attributes it to "System" — the same actor `writeAudit` records for
           * a principal-less write.
           *
           * THE PREDICATE READS "NOBODY AT THIS SALON DID IT", not "a job did
           * it", and the two were the same sentence only while the job was the
           * only way a deposit came back. `services/booking.ts § returnDeposit`
           * now writes the staff id for a hand-marked no-show, so this branch
           * correctly stops claiming those — but it still covers the CUSTOMER'S
           * OWN CANCEL, whose actor is a `MemberPrincipal` and therefore not a
           * `staff_user.id`. For a merchant's Overview that reads true: no one
           * on her team returned it. Separating "a rule did it" from "the
           * customer did it" would need a fact on the row that nothing records
           * today, and `GET /salons/{id}/audit` already carries the actor.
           */
          who:
            t.kind === 'deposit_return' && t.createdByStaffId === null
              ? 'System'
              : (names.get(t.memberId) ?? t.memberId),
          memberId: t.memberId,
          /** Always her own salon. `FeedItem` carries it for the console's pill. */
          salonId: p.salonId,
          what:
            t.kind === 'deposit_return' && t.createdByStaffId === null
              ? `returned ${kd(t.amountFils)} deposit · ${names.get(t.memberId) ?? t.memberId}`
              : describeTransaction(t),
          kind: t.kind,
          /**
           * Signed as stored, so a client never has to infer direction from the
           * kind. `feeFils` is NOT here — merchant-visible it may be, but this
           * feed is a list of what happened, and the commission belongs on the
           * settlement report where it can be totalled. http/serialise.ts owns
           * the one place that decides otherwise.
           */
          amountFils: t.amountFils,
        })),
        ...loyaltyRows.map<FeedItem>((l) => ({
          id: l.id,
          stream: 'loyalty',
          at: l.createdAt.toISOString(),
          who: names.get(l.memberId) ?? l.memberId,
          memberId: l.memberId,
          salonId: p.salonId,
          what: describeLoyalty(l),
          kind: l.kind,
          amountFils: null,
        })),
      ]
        .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
        .slice(0, limit);

      return reply.send({ items, nextCursor: null });
    },
  );
}
