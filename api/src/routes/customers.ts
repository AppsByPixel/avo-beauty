/**
 * THE MERCHANT'S CUSTOMER BOOK — design/AVO Merchant Dashboard.dc.html § Accounts,
 * Customers tab. Aftab's item 2: "Customer accounts list and they can check their
 * history and stuff."
 *
 *   GET /salons/{id}/customers                          perms.team   the list
 *   GET /salons/{id}/customers/{memberId}               perms.team   the card
 *   GET /salons/{id}/customers/{memberId}/activity      perms.team   the history
 *
 * `services/customerDirectory.ts` carries the permission argument and what became
 * of the scanner's four controls. This file is the wiring, the shapes, and the two
 * decisions that are about ROUTES rather than about the directory.
 *
 * =========================================================================
 * WHY THREE ENDPOINTS AND NOT ONE
 * =========================================================================
 * The split is on what GROWS. A member row does not grow, so the card is one
 * request that returns the whole of it. Her activity grows for as long as she is a
 * customer, so it pages — and folding an unbounded list into the card would either
 * truncate it silently or make the card's cost depend on how long she has been a
 * member. `GET /members/me/transactions` already shows the failure mode from the
 * customer side: `.limit(50)` and `nextCursor: null`, which is a feed that stops
 * and says it has not.
 *
 * The list is separate for the ordinary reason, and its page is FIXED rather than
 * client-chosen — see `CUSTOMER_PAGE_SIZE`.
 *
 * =========================================================================
 * WHAT THE DESIGN DRAWS THAT IS DELIBERATELY NOT HERE
 * =========================================================================
 * The customer detail card in the design has six parts. Four are served. Two are
 * not, and both are refused for the SAME rule rather than for effort:
 * `services/reports.ts` § `artist-performance` establishes that when a read joins
 * two sections, it must resolve to the STRICTEST of their permissions.
 *
 *   NEXT BOOKING ("Root touch-up with Rana · Thu 3:00pm · 5.000 deposit") is the
 *       Appointments section's data, gated `appointments`. `team` and
 *       `appointments` are NOT ordered — the seeded frontdesk `ST-002` holds
 *       `appointments` and not `team`, and a manager may hold `team` and not
 *       `appointments` — so the strictest resolution of that join is BOTH, and
 *       serving it here would either leak appointment data to a `team`-only
 *       holder or force the whole profile read behind a second permission for the
 *       sake of one card. Reported to trunk: it wants its own
 *       `appointments`-gated read, or a decision to gate the card on both.
 *
 *   PURCHASES (the item/date/price list) is the same join one step further —
 *       services are `appointments`, products are `shop`. Same reason, twice.
 *
 *   THE ACTIVITY LIST IS NOT SUCH A JOIN, and it is worth saying why rather than
 *       treating the difference as obvious. It reads `transaction` and
 *       `loyalty_event`, which `REPORT_PERMISSION` maps to `dashboard` via `sales`.
 *       `team` and `dashboard` ARE ordered — reports.ts: "`dashboard` is the wider
 *       grant" — so `max(team, dashboard)` is `team`, and the strictest resolution
 *       of this join is the permission the endpoint already has. No hole.
 *
 *   `handle` (`@latifa.a`) AND `birthday` do not exist as columns. The username was
 *       ruled on already — a customer's sign-in identity is her PHONE, DECISIONS.md,
 *       and `services/reports.ts` serves `Phone` in the CSV for exactly that reason,
 *       citing this very tab as the place the UI shows the same thing. There is no
 *       date-of-birth column on `member` at all. Both reported, neither invented.
 *
 * GIFT AND REIMBURSE are the card's two buttons and are NOT in this slice. They
 * move money, so they need idempotency keys and the adjustment path —
 * `routes/adjustments.ts § POST /members/{id}/adjustments` already exists and is
 * gated differently. A read slice does not grow a write.
 */

import { and, asc, desc, eq, getTableColumns, inArray, lt, gte } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { db } from '../db/client';
import { member } from '../db/schema/member';
import { loyaltyEvent } from '../db/schema/loyaltyEvent';
import { salon } from '../db/schema/salon';
import { transaction } from '../db/schema/transaction';
import {
  requireDashboardPerm,
  requireSameSalon,
  requireStaff,
  type StaffPrincipal,
} from '../auth/principal';
import { notFound } from '../http/errors';
import { writeAudit } from '../services/audit';
import {
  describeLoyalty,
  describeTransaction,
  FEED_KINDS,
  kd,
  parseFeedLimit,
  type FeedItem,
} from '../services/activityFeed';
import { DIRECTORY_REFUSED_ACTION } from '../services/memberSearch';
import {
  CUSTOMER_HISTORY_ACTION,
  CUSTOMER_LIST_ACTION,
  CUSTOMER_OPEN_ACTION,
  CUSTOMER_PAGE_SIZE,
  customerSearchPredicate,
  enforceCustomerDirectoryLimit,
  normaliseCustomerQuery,
  serialiseCustomerDetail,
  serialiseCustomerListItem,
} from '../services/customerDirectory';
import { parseCalendarRange, resolveWindow, type PeriodWindow } from '../services/period';
import {
  afterCursor,
  cursorInstant,
  encodeCursor,
  mergePage,
  parseCursor,
  type Keyed,
} from '../services/streamCursor';

/**
 * The history's two streams, ranked in the order a simultaneous group reads: the
 * money happened, then the tier it moved. `services/streamCursor.ts` says why the
 * rank is load-bearing rather than tidy — a charge writes its `transaction` and its
 * `loyalty_event` inside ONE database transaction, so both carry the same
 * `created_at` to the microsecond, every time.
 *
 * THE AUDIT STREAM IS ABSENT, unlike the console's feed. `routes/platformConsole.ts`
 * reads `audit_log` because the console's Activity section draws authority changes;
 * this is a CUSTOMER'S history, and an audit row is a record of what STAFF did. The
 * merchant's own Overview feed makes the same choice for the same reason.
 */
const HISTORY_RANK = { transaction: 0, loyalty: 1 } as const;
const HISTORY_RANKS = Object.values(HISTORY_RANK);

/** The list's single stream. Its own rank set, so a history cursor cannot address it. */
const LIST_RANKS = [0];

function clientMeta(req: FastifyRequest) {
  return {
    ipAddress: req.ip ?? null,
    userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
  };
}

/**
 * THE GATE, AND THE REFUSAL IT RECORDS.
 *
 * `requireDashboardPerm(req, 'team')` alone would be a correct gate and a silent
 * one. `routes/members.ts § requireDirectoryScanner` established that a REFUSED
 * customer-directory read is itself worth keeping: "authenticated, identified and
 * refused is a fact worth keeping. Unidentified noise is not." The shape of an
 * insider probing her own limits is a run of refusals naming one actor, and a gate
 * that only throws produces no such run.
 *
 * The same line is drawn here, IN THE SAME PLACE, which is why the surface is
 * checked as `'either'` and then narrowed rather than demanded up front. A 401 and
 * a MEMBER token both throw out of `requireStaff` unlogged — neither identifies
 * anybody worth a row. Every STAFF principal who gets past that and is then refused
 * is named, and there are two ways to be refused:
 *
 *   WRONG SURFACE   a device-bound PIN session reaching the back office. Demanding
 *                   `'dashboard'` here would refuse her at the wall with no row,
 *                   and that is exactly the case `requireDirectoryScanner` logs in
 *                   the other direction ("Attempted a customer lookup from a
 *                   ${p.scope} session"). One question, asked from two doors; the
 *                   log should answer it the same way at both.
 *   NO PERMISSION   a web session without `team`.
 *
 * Both write the row; `metadata.scope` and `metadata.hasPermission` are what tell
 * a reader which happened.
 *
 * IT REUSES `DIRECTORY_REFUSED_ACTION` RATHER THAN MINTING A SECOND NAME. "Who
 * tried to reach the customer directory without the authority to" is one question
 * and should answer to one filter; the metadata already carries `permission` and
 * `scope`, which is what tells the till apart from the back office. Note that the
 * action is NOT in `CUSTOMER_DIRECTORY_ACTIONS`, so a refused read consumes no
 * budget and cannot be used to exhaust somebody else's.
 *
 * NOT THROTTLED, deliberately, for memberSearch's reason: a retry loop could append
 * rows, but every one of them names the actor, so a flood is itself the signal.
 *
 * The refusal itself is thrown by the canonical guard rather than rebuilt here, so
 * the copy the merchant reads stays in one place — and so the permission census,
 * which asserts that copy, keeps reading this route as `→ team`.
 */
async function requireCustomerDirectory(req: FastifyRequest): Promise<StaffPrincipal> {
  // 401 and the member-token case both throw out of here, unlogged.
  const p = requireStaff(req, 'either');

  if (p.scope === 'dashboard' && p.perms.team) return p;

  await writeAudit(db, p, {
    salonId: p.salonId,
    kind: 'risk',
    action: DIRECTORY_REFUSED_ACTION,
    detail:
      p.scope === 'dashboard'
        ? 'Attempted to open the customer book without team authority'
        : `Attempted to open the customer book from a ${p.scope} session`,
    source: 'merchant',
    subjectType: 'member_search',
    subjectId: null,
    metadata: {
      permission: 'team',
      scope: p.scope,
      hasPermission: p.perms.team,
      sessionId: p.sessionId,
    },
    ...clientMeta(req),
  });

  /**
   * Throws the canonical refusal — the surface wall or the permission copy,
   * whichever applies — rather than rebuilding either here, so the sentence the
   * merchant reads stays in one place and the permission census keeps reading this
   * route as `→ team`.
   */
  return requireDashboardPerm(req, 'team');
}

export async function registerCustomerRoutes(app: FastifyInstance): Promise<void> {
  // ------------------------------------------- GET /salons/:id/customers --
  /**
   * THE LIST. Unfiltered it is the salon's customer book, newest member first;
   * `?q=` narrows it by name, phone digits or exact member id.
   *
   * ORDERED `joined_at DESC, id ASC`, WHICH IS A REUSE DECISION. The design does
   * not state an order. `services/streamCursor.ts` pages an INSTANT-keyed stream
   * and nothing else, so an alphabetical directory would need a second cursor
   * grammar — a `(name, id)` keyset with its own parse, its own escape and its own
   * total-order argument — minted for a list that already has a search box in front
   * of it. Newest-member-first is a defensible default, it is the order the existing
   * cursor serves exactly, and `id ASC` breaks the tie two members registered in the
   * same microsecond would otherwise leave open. If a merchant ever needs A–Z, that
   * is a cursor grammar worth building then and not now.
   *
   * NO INDEX WAS ADDED. `member_salon_idx` is `(salon_id)`, so this is an index
   * scan of one salon's members and a sort. A salon holds hundreds to low thousands
   * of members — `services/metrics.ts` records a real one at 1,284 registrations —
   * so the sort is trivial and a `(salon_id, joined_at DESC)` migration would be
   * weight bought against a cost nobody has measured. Recorded so the next reader
   * knows it was considered.
   *
   * THE AUDIT ROW RECORDS THE QUERY AND THE COUNT, NEVER THE MATCHES. That split is
   * `services/memberSearch.ts`' and it is carried whole; the header there explains
   * why copying matched customers into an append-only seven-year log would build a
   * second customer list inside the audit trail.
   */
  app.get<{ Params: { id: string }; Querystring: { q?: string; cursor?: string } }>(
    '/salons/:id/customers',
    async (req, reply) => {
      const p = await requireCustomerDirectory(req);
      requireSameSalon(p, req.params.id);
      await enforceCustomerDirectoryLimit(db, p);

      const q = normaliseCustomerQuery(req.query?.q);
      const cursor = parseCursor(req.query?.cursor, LIST_RANKS);
      const take = CUSTOMER_PAGE_SIZE + 1;

      const rows = await db
        .select({ ...getTableColumns(member), cursorAt: cursorInstant(member.joinedAt) })
        .from(member)
        .where(
          and(
            /**
             * Scoped from the PRINCIPAL, not the path — the doubling
             * `routes/activity.ts` and `routes/audit.ts` practise. `requireSameSalon`
             * above has already established the two are equal; if that guard were
             * ever loosened, this predicate would still be right and no row from
             * another salon would be read.
             */
            eq(member.salonId, p.salonId),
            customerSearchPredicate(q),
            afterCursor(cursor, 0, member.joinedAt, member.id),
          ),
        )
        .orderBy(desc(member.joinedAt), asc(member.id))
        .limit(take);

      const hasMore = rows.length > CUSTOMER_PAGE_SIZE;
      const page = rows.slice(0, CUSTOMER_PAGE_SIZE);
      const last = page[page.length - 1];

      /**
       * WRITTEN WHETHER OR NOT ANYTHING MATCHED, and awaited before the send. A
       * search that found nothing still happened, and "who did she look for" is the
       * question the log is kept for. Awaited for `routes/reports.ts`' reason: an
       * untraced read of the customer book must not be a reachable outcome.
       */
      await writeAudit(db, p, {
        salonId: p.salonId,
        kind: 'access',
        action: CUSTOMER_LIST_ACTION,
        detail: q === '' ? 'Listed the customer book' : `Filtered customers by "${q}"`,
        source: 'merchant',
        subjectType: 'member_search',
        subjectId: null,
        // `results` is a COUNT. No member id appears on this row, by design.
        metadata: {
          query: q,
          results: page.length,
          paged: cursor !== null,
          sessionId: p.sessionId,
        },
        ...clientMeta(req),
      });

      return reply.send({
        items: page.map(serialiseCustomerListItem),
        nextCursor:
          hasMore && last ? encodeCursor({ at: last.cursorAt, rank: 0, id: last.id }) : null,
      });
    },
  );

  // --------------------------------- GET /salons/:id/customers/:memberId --
  /**
   * ONE CUSTOMER'S CARD.
   *
   * THE TENANT PREDICATE IS IN THE `WHERE` AND THE REFUSAL IS `404 unknown_member`,
   * byte-identical to a member who does not exist. `services/memberSearch.ts §
   * resolveMember` argues it: "a distinct 403 would confirm that the id is real,
   * which turns this endpoint into an oracle for 'is 8842 a customer somewhere in
   * AVO' even when it refuses to say more."
   *
   * THAT IS NOT IN TENSION WITH `requireSameSalon` ABOVE, which fires on the SALON
   * in the path and answers 403 "That salon is not yours." Those are two different
   * questions: whether this workspace is hers, and whether that customer is in it.
   * A manager of salon A asking about salon B's id is refused at the first; a
   * manager of salon A asking her own salon about a member id that lives in salon B
   * is refused at the second, and learns nothing.
   *
   * THE AUDIT ROW NAMES HER — unlike the list's, which records only a count. This
   * is the read that actually disclosed one specific customer's wallet and contact
   * details, so this is where her id belongs. And it is WRITTEN BEFORE THE 404: an
   * attempt on an id that is not in this salon is, in memberSearch's words, "the
   * single most interesting line in this log — it is what a directory walk looks
   * like from the inside", and a log that recorded only successful reads would omit
   * exactly the evidence.
   */
  app.get<{ Params: { id: string; memberId: string } }>(
    '/salons/:id/customers/:memberId',
    async (req, reply) => {
      const p = await requireCustomerDirectory(req);
      requireSameSalon(p, req.params.id);
      await enforceCustomerDirectoryLimit(db, p);

      const m = await loadCustomer(p.salonId, req.params.memberId);

      await writeAudit(db, p, {
        salonId: p.salonId,
        kind: 'access',
        action: CUSTOMER_OPEN_ACTION,
        detail: m ? `Opened ${m.name}` : `Attempted an id not in this salon: ${req.params.memberId}`,
        source: 'merchant',
        subjectType: 'member',
        subjectId: m?.id ?? null,
        metadata: {
          requestedId: req.params.memberId,
          found: Boolean(m),
          sessionId: p.sessionId,
        },
        ...clientMeta(req),
      });

      if (!m) throw notFound('unknown_member', 'No such member.');
      return reply.send(serialiseCustomerDetail(m));
    },
  );

  // ------------------------ GET /salons/:id/customers/:memberId/activity --
  /**
   * HER HISTORY — "Paid 45.000 · Keratin treatment", "Reached Gold tier", "Joined
   * AVO". The design's Activity list inside the customer card.
   *
   * THE SENTENCES COME FROM `services/activityFeed.ts` AND ARE NOT WRITTEN HERE.
   * That file exists because `describeTransaction` "already carries a defect that
   * was found and fixed once — a top-up's `amount_fils` is 'what actually landed,
   * bonus included', so printing the column reads 'topped up 30.000 · +5.000 bonus'
   * and tells a merchant her customer paid five dinars she did not". A third copy
   * of that function is a third chance to get it wrong. This is the same vocabulary
   * the Overview feed and the console's feed use, narrowed to one member.
   *
   * `feeFils` IS NOT ON THESE ROWS, inherited rather than decided: `FeedItem`'s own
   * note is that commission "belongs on the settlement report where it can be
   * totalled", and `http/serialise.ts` owns the one place that decides otherwise.
   * `serialiseTransactionForMerchant` is the shape that carries it, and this is not
   * that shape.
   *
   * MONEY IS INTEGER FILS ON THE WIRE. `amountFils` is the stored column, signed as
   * stored so a client never infers direction from the kind. `kd()` appears only
   * inside the rendered sentence, which is the display boundary — non-negotiable #1,
   * and `services/reports.ts` draws the same line for the same reason.
   *
   * ?from= AND ?to= ARE THE OBVIOUS THING AND ARE HERE. "Check their history" over a
   * period is the question the screen asks, and the grammar already exists:
   * `parseCalendarRange` returns the same calendar `Period` that
   * `?period=2026-03-01_2026-03-31` returns, `resolveWindow` resolves it in the
   * SALON'S zone, and `GET /salons/{id}/bookings` reuses both. Salon-local calendar
   * dates rather than instants, for that endpoint's reason: "8 March" at a Kuwait
   * salon begins at 21:00Z on 7 March, and a client turning a month into instants
   * against a stale copy of the zone moves both ends three hours. The interval is
   * half-open `[from 00:00, to+1 00:00)`, so a 23:59 charge on `to` is in and the
   * next day's 00:00 is not.
   *
   * ABSENT IS UNCHANGED AND PROVABLY SO: `parseCalendarRange` returns `null`, no
   * predicate is built, AND THE SALON ROW IS NOT READ — so a request without them
   * issues exactly the query it would have issued before the parameter existed.
   *
   * PARSED BEFORE THE SALON IS READ, RESOLVED AFTER. Parsing answers "what did she
   * ask for" and needs no zone; resolving answers "which instants is that" and
   * cannot be done until the salon row is in hand.
   */
  app.get<{
    Params: { id: string; memberId: string };
    Querystring: { cursor?: string; limit?: string; from?: string; to?: string };
  }>('/salons/:id/customers/:memberId/activity', async (req, reply) => {
    const p = await requireCustomerDirectory(req);
    requireSameSalon(p, req.params.id);
    await enforceCustomerDirectoryLimit(db, p);

    const limit = parseFeedLimit(req.query?.limit);
    const cursor = parseCursor(req.query?.cursor, HISTORY_RANKS);
    const range = parseCalendarRange(req.query?.from, req.query?.to);

    /**
     * THE MEMBER IS RESOLVED FIRST, and her absence is the same `404
     * unknown_member` the card gives — not an empty feed. An empty list for a
     * member who is not in this salon would answer "she has no history" to a
     * question about somebody who is not hers, which is a different and softer
     * lie than the card's refusal, told from the same door.
     */
    const m = await loadCustomer(p.salonId, req.params.memberId);

    let dateWindow: PeriodWindow | null = null;
    if (range && m) {
      const [s] = await db
        .select({ timezone: salon.timezone })
        .from(salon)
        .where(eq(salon.id, p.salonId))
        .limit(1);
      if (!s) throw notFound('unknown_salon', 'No such salon.');
      /**
       * `new Date()` is unread for a calendar window — `resolveWindow` only
       * consults `now` on the rolling branch — and is passed rather than faked
       * because the signature is the shared one and a sentinel would be a lie a
       * future rolling caller could trip over.
       */
      dateWindow = resolveWindow(range, s.timezone, new Date());
    }

    const take = limit + 1;
    const [txRows, loyaltyRows] = m
      ? await Promise.all([
          db
            .select({
              ...getTableColumns(transaction),
              cursorAt: cursorInstant(transaction.createdAt),
            })
            .from(transaction)
            .where(
              and(
                eq(transaction.memberId, m.id),
                /**
                 * HER SALON TOO, not only her id. A member belongs to one salon, so
                 * this is redundant today — and it is the redundancy that survives
                 * a future where she does not. The row carries `salon_id`; reading
                 * it is free, and a predicate that cannot be wrong is worth more
                 * than one that is merely right now.
                 */
                eq(transaction.salonId, p.salonId),
                inArray(transaction.kind, [...FEED_KINDS]),
                /**
                 * Settled only. A `pending` top-up is a customer staring at a
                 * gateway page, and api-contract.md § TopUpIntent is explicit that
                 * pending is "never a failure, never a success". The Overview feed
                 * and the console's feed both draw this line here.
                 */
                eq(transaction.status, 'settled'),
                dateWindow ? gte(transaction.createdAt, dateWindow.fromInstant) : undefined,
                dateWindow ? lt(transaction.createdAt, dateWindow.toInstant) : undefined,
                afterCursor(cursor, HISTORY_RANK.transaction, transaction.createdAt, transaction.id),
              ),
            )
            .orderBy(desc(transaction.createdAt), asc(transaction.id))
            .limit(take),
          db
            .select({
              ...getTableColumns(loyaltyEvent),
              cursorAt: cursorInstant(loyaltyEvent.createdAt),
            })
            .from(loyaltyEvent)
            .where(
              and(
                eq(loyaltyEvent.memberId, m.id),
                eq(loyaltyEvent.salonId, p.salonId),
                dateWindow ? gte(loyaltyEvent.createdAt, dateWindow.fromInstant) : undefined,
                dateWindow ? lt(loyaltyEvent.createdAt, dateWindow.toInstant) : undefined,
                afterCursor(cursor, HISTORY_RANK.loyalty, loyaltyEvent.createdAt, loyaltyEvent.id),
              ),
            )
            .orderBy(desc(loyaltyEvent.createdAt), asc(loyaltyEvent.id))
            .limit(take),
        ])
      : [[], []];

    /**
     * ONE NAME, NOT A JOIN PER STREAM — `routes/activity.ts`' reasoning, collapsed
     * to a constant because every row on this page belongs to the same member. If
     * she is erased it is `TOMBSTONE_NAME`, which is a display-safe string every
     * surface renders as-is; her PHONE is not on these rows at all, so the `+990`
     * tombstone has no way out through this endpoint.
     */
    const who = m?.name ?? '';

    const keyed: Keyed<FeedItem>[] = [
      ...txRows.map<Keyed<FeedItem>>((t) => ({
        rank: HISTORY_RANK.transaction,
        at: t.cursorAt,
        id: t.id,
        item: {
          id: t.id,
          stream: 'transaction',
          at: t.createdAt.toISOString(),
          /**
           * An automatic deposit return has no staff behind it and the design
           * attributes it to "System". The predicate reads "nobody at this salon
           * did it"; `routes/activity.ts` explains why that is not identical to
           * "automatic" and why the customer's own cancel still lands here.
           */
          who: t.kind === 'deposit_return' && t.createdByStaffId === null ? 'System' : who,
          memberId: t.memberId,
          salonId: t.salonId,
          what:
            t.kind === 'deposit_return' && t.createdByStaffId === null
              ? `returned ${kd(t.amountFils)} deposit · ${who}`
              : describeTransaction(t),
          kind: t.kind,
          /** Signed as stored. Integer fils; `feeFils` is not here — see the header. */
          amountFils: t.amountFils,
        },
      })),
      ...loyaltyRows.map<Keyed<FeedItem>>((l) => ({
        rank: HISTORY_RANK.loyalty,
        at: l.cursorAt,
        id: l.id,
        item: {
          id: l.id,
          stream: 'loyalty',
          at: l.createdAt.toISOString(),
          who,
          memberId: l.memberId,
          salonId: l.salonId,
          what: describeLoyalty(l),
          kind: l.kind,
          amountFils: null,
        },
      })),
    ];

    const { items, nextCursor } = mergePage(keyed, limit);

    /**
     * WRITTEN BEFORE THE REFUSAL, exactly as the card's is, and for that reason.
     * A separate action from `CUSTOMER_OPEN_ACTION` because it is a different
     * disclosure: opening her card shows who she is, reading this shows what she
     * spent. Both fire when the screen opens, which is two rows for one screen and
     * is correct — they answer different questions to whoever reads the log.
     */
    await writeAudit(db, p, {
      salonId: p.salonId,
      kind: 'access',
      action: CUSTOMER_HISTORY_ACTION,
      detail: m
        ? `Read ${m.name}'s activity${dateWindow ? ` for ${dateWindow.fromDate} to ${dateWindow.toDate}` : ''}`
        : `Attempted an id not in this salon: ${req.params.memberId}`,
      source: 'merchant',
      subjectType: 'member',
      subjectId: m?.id ?? null,
      metadata: {
        requestedId: req.params.memberId,
        found: Boolean(m),
        from: dateWindow?.fromDate ?? null,
        to: dateWindow?.toDate ?? null,
        results: items.length,
        sessionId: p.sessionId,
      },
      ...clientMeta(req),
    });

    if (!m) throw notFound('unknown_member', 'No such member.');
    return reply.send({ items, nextCursor });
  });
}

/**
 * The tenant-scoped read, in one place so the card and the history cannot disagree
 * about who is reachable. Both terms in the `WHERE`: a member outside this salon is
 * never read, so no later mistake in a mapping can serve her.
 */
async function loadCustomer(salonId: string, memberId: string) {
  const id = memberId.trim();
  if (id === '') return undefined;
  const [m] = await db
    .select()
    .from(member)
    .where(and(eq(member.id, id), eq(member.salonId, salonId)))
    .limit(1);
  return m;
}
