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
 */

import { and, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/client';
import { member } from '../db/schema/member';
import { loyaltyEvent } from '../db/schema/loyaltyEvent';
import { transaction } from '../db/schema/transaction';
import { requireDashboardPerm, requireSameSalon } from '../auth/principal';
import { badRequest } from '../http/errors';

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

/**
 * The kinds that belong in a merchant's feed.
 *
 * `deposit_hold` is excluded deliberately. It is the money moving from the
 * customer's spendable balance into escrow at the moment she books — the
 * merchant already sees the booking in Appointments, and the feed would report
 * the same event twice, once as an appointment and once as a debit that is not a
 * sale. Its counterpart `deposit_return` IS included, because that one is the
 * salon giving money back and the design shows it by name.
 */
const FEED_KINDS = ['topup', 'charge', 'deposit_return', 'shop', 'adjustment'] as const;

const TIER_LABEL: Record<string, string> = {
  bronze: 'Bronze',
  silver: 'Silver',
  gold: 'Gold',
  black: 'Black',
};

const METHOD_LABEL: Record<string, string> = {
  knet: 'KNET',
  card: 'card',
  applepay: 'Apple Pay',
  wallet: 'wallet',
};

export interface FeedItem {
  id: string;
  /** 'transaction' | 'loyalty' — which stream this line came from. */
  stream: 'transaction' | 'loyalty';
  at: string;
  who: string;
  memberId: string | null;
  /** The predicate the design renders after the bolded name. */
  what: string;
  kind: string;
  /** Signed fils, as stored. Null on a line that moved no money. */
  amountFils: number | null;
}

function parseLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LIMIT;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    throw badRequest('invalid_limit', `limit must be a whole number between 1 and ${MAX_LIMIT}.`);
  }
  return n;
}

/** "12.000". The display boundary is the client's, but the feed's copy is prose. */
function kd(amountFils: number): string {
  return (Math.abs(amountFils) / 1000).toFixed(3);
}

/**
 * The design's own phrasing, per kind:
 *   "topped up 25.000 via KNET" · "paid 12.000 · Cut & style"
 *   "returned 5.000 deposit · Aisha M. no-show" · "bought Repair serum · 9.500"
 *
 * Composed server-side so both languages resolve from one place later, and so
 * `note` — the void reason, the adjustment reason — reaches the merchant without
 * a client having to know which kinds carry one.
 */
function describeTransaction(row: typeof transaction.$inferSelect): string {
  const amount = kd(row.amountFils);
  switch (row.kind) {
    case 'topup': {
      /**
       * "topped up 25.000 via KNET" — the amount she PAID, which is not what
       * `amount_fils` holds. That column is "what actually landed, bonus
       * included" (services/topup.ts), so a 25.000 KNET top-up at Gold stores
       * 30000 with 5000 in `bonus_fils`. Printing the column would read
       * "topped up 30.000 · +5.000 bonus", which counts the bonus twice and
       * tells a merchant her customer paid five dinars she did not.
       */
      const paid = row.amountFils - row.bonusFils;
      const via = row.method ? ` via ${METHOD_LABEL[row.method] ?? row.method}` : '';
      const bonus = row.bonusFils > 0 ? ` · +${kd(row.bonusFils)} bonus` : '';
      return `topped up ${kd(paid)}${via}${bonus}`;
    }
    case 'charge':
      return `paid ${amount}`;
    case 'deposit_return':
      return `deposit returned ${amount}${row.note ? ` · ${row.note}` : ''}`;
    case 'shop':
      return `bought from the shop · ${amount}`;
    case 'adjustment':
      /**
       * A void arrives here as a compensating `adjustment` pointing back at the
       * charge it reverses — routes/charges.ts § POST /voids. Named as the
       * reversal it is, because "adjusted 12.000" in a feed is the one line a
       * merchant will stop and ask about.
       */
      return row.reversesTransactionId
        ? `charge voided · ${amount} returned${row.note ? ` · ${row.note}` : ''}`
        : `wallet adjusted ${row.amountFils > 0 ? '+' : '−'}${amount}${row.note ? ` · ${row.note}` : ''}`;
    default:
      return `${row.kind} ${amount}`;
  }
}

function describeLoyalty(row: typeof loyaltyEvent.$inferSelect): string {
  if (row.kind === 'tier_climb') {
    const to = TIER_LABEL[row.toTier ?? ''] ?? row.toTier ?? '';
    /**
     * A republished ladder can move a member DOWN — see services/charge.ts. The
     * row carries both ends so the feed can say which happened rather than
     * announcing "reached Bronze" to someone who was demoted.
     */
    const from = row.fromTier ? TIER_LABEL[row.fromTier] ?? row.fromTier : null;
    const order = ['bronze', 'silver', 'gold', 'black'];
    const descended =
      row.fromTier !== null &&
      row.toTier !== null &&
      order.indexOf(row.toTier) < order.indexOf(row.fromTier);
    if (descended) return `moved to ${to} tier${from ? ` from ${from}` : ''}`;
    return `reached ${to} tier`;
  }
  return `filled the stamp card · ${row.stampsAfter ?? 0} of ${row.stampTarget ?? 0}`;
}

export async function registerActivityRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/salons/:id/activity',
    async (req, reply) => {
      // perms.dashboard — this is the Overview panel, behind the permission that
      // opens the dashboard. NOT perms.charges: see the file header.
      const p = requireDashboardPerm(req, 'dashboard');
      requireSameSalon(p, req.params.id);

      const limit = parseLimit(req.query.limit);

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
           */
          who:
            t.kind === 'deposit_return' && t.createdByStaffId === null
              ? 'System'
              : (names.get(t.memberId) ?? t.memberId),
          memberId: t.memberId,
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
