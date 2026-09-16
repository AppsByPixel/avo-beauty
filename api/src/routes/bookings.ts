/**
 * Booking endpoints.
 *
 *   POST   /bookings                  member, idempotency key — holds the deposit
 *   GET    /bookings                  member — her own appointments
 *   GET    /bookings/{id}             member — one of hers
 *   DELETE /bookings/{id}             member — cancel, deposit returns
 *   POST   /bookings/{id}/reschedule  member — deposit carries
 *   GET    /salons/{id}/bookings      perms.appointments (in routes/salons.ts)
 *   GET    /artists/me/bookings       scanner — the artist's own day
 *
 * WHY THE CUSTOMER ROUTES ARE `/bookings` AND NOT `/members/me/bookings`
 * ---------------------------------------------------------------------
 * api-contract.md § Operations names `POST /bookings` and
 * `DELETE /bookings/{id}` — collection at the root, scoped by the credential
 * rather than by the path. Every handler here reads `requireMember(req)` and
 * filters on `principal.id`, so a customer cannot address another customer's
 * appointment at all: there is no id in the URL that would let her try. That is
 * the same property `/members/me/…` has, achieved by scoping the QUERY instead of
 * the path, and it is what the contract asks for.
 *
 * `POST /bookings/{id}/reschedule` IS IN THE CONTRACT, as a contract addition
 * this file proposed and api-contract.md:367 has since adopted. README § Upcoming
 * appointment specified the behaviour — "Reschedule (carries the deposit to a new
 * slot)" — and no endpoint. A sub-resource POST rather than `PATCH /bookings/{id}`
 * because a reschedule is a transition with rules (the one-hour window, the slot
 * re-validation, the deposit carry), not a field assignment, and a PATCH that
 * accepted `startsAt` invites a PATCH that accepts `status` or `depositFils`
 * next. The contract now carries that reasoning and the refusal vocabulary.
 *
 * THE IDEMPOTENCY ASYMMETRY, said out loud: `POST /bookings` requires a key and
 * `DELETE /bookings/{id}` does not. A POST creates a new thing every time it
 * succeeds, so two of them is two deposits. A DELETE names one resource with one
 * live state, and the `deposit_held → cancelled` transition happens under
 * `FOR UPDATE`; a second cancel blocks, re-reads, and is told `already_cancelled`.
 * That is stronger than a key, because it also holds when the client sends two
 * DIFFERENT keys. services/booking.ts § cancelBooking carries the reasoning.
 */

import { and, asc, eq, gte, inArray, isNotNull, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/client';
import { artist } from '../db/schema/artist';
import { booking } from '../db/schema/booking';
import { member } from '../db/schema/member';
import { service } from '../db/schema/service';
import { transaction } from '../db/schema/transaction';
import { requireMember, requireScannerScope } from '../auth/principal';
import { badRequest, conflict, notFound } from '../http/errors';
import { serialiseMemberContact } from '../http/serialise';
import { requireString } from '../money/validate';
import {
  cancelBooking,
  createBooking,
  isExclusionViolation,
  listMemberBookings,
  rescheduleBooking,
  serialiseBooking,
  type BookingRow,
} from '../services/booking';
import {
  awaitCommittedKey,
  hashRequestBody,
  isUniqueViolation,
  principalScope,
  readIdempotencyKey,
} from '../services/idempotency';

const STATUSES = ['deposit_held', 'completed', 'no_show_returned', 'cancelled'] as const;

function parseStatuses(raw: unknown): Array<BookingRow['status']> | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') throw badRequest('invalid_status', 'status must be a string.');
  const wanted = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = wanted.filter((s) => !(STATUSES as readonly string[]).includes(s));
  if (unknown.length > 0) {
    throw badRequest(
      'invalid_status',
      `Unknown booking status: ${unknown.join(', ')}. One of ${STATUSES.join(', ')}.`,
    );
  }
  return wanted as Array<BookingRow['status']>;
}

export async function registerBookingRoutes(app: FastifyInstance): Promise<void> {
  // ------------------------------------------------------------ POST /bookings --
  app.post('/bookings', async (req, reply) => {
    // FIRST, before the body is read. A deposit leaves a wallet here.
    const p = requireMember(req);
    // Then the key — non-negotiable #4, a money-moving POST without one is
    // refused before any work.
    const key = readIdempotencyKey(req);

    const body = (req.body ?? {}) as Record<string, unknown>;
    const artistId = requireString(body.artistId, 'artistId', 100);
    const serviceId = requireString(body.serviceId, 'serviceId', 100);
    const startsAt = requireString(body.startsAt, 'startsAt', 40);

    /**
     * NO `branchId`, AND NONE IS READ. A booking has a branch and the server
     * resolves it — services/branch.ts § "the fix that must not be taken". A
     * field here would be a client choosing its own reporting bucket, and the
     * moment branch-scoped promotions touch bookings, its own multiplier.
     */
    if ('branchId' in body) {
      throw badRequest(
        'branch_not_client_supplied',
        'A booking\'s branch is resolved by the server, not sent by the client.',
      );
    }
    /**
     * NO `depositFils` either. The deposit is `salon.deposit_fils` and nothing
     * else; a client-supplied amount is a client booking for 0.001 KD, which is
     * the same defect as a scanner sending its own service price.
     */
    if ('depositFils' in body) {
      throw badRequest(
        'deposit_not_client_supplied',
        'The deposit is set by the salon, not sent by the client.',
      );
    }

    const idem = {
      scope: principalScope(p),
      endpoint: 'POST /bookings',
      key,
      requestHash: hashRequestBody({ artistId, serviceId, startsAt }),
    };

    try {
      const result = await createBooking(
        db,
        { artistId, serviceId, startsAt },
        {
          principal: p,
          idempotency: idem,
          ipAddress: req.ip ?? null,
          userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
        },
      );
      return reply.code(201).send(result);
    } catch (err) {
      /**
       * TWO CONSTRAINTS CAN FIRE HERE AND THEY MEAN DIFFERENT THINGS, which is
       * the lesson routes/charges.ts learned when a double void was reported as
       * "still being processed".
       *
       * `booking_artist_slot_no_overlap` (exclusion, 23P01) — two customers, one
       * slot, one winner. The loser is told the slot went, which is true and
       * actionable: pick another time. It is NOT an idempotency replay, and
       * searching for a stored response under her key would find nothing and
       * report a transient condition for a permanent one.
       */
      if (isExclusionViolation(err)) {
        throw conflict(
          'slot_taken',
          'That time has just been taken. Pick another one.',
        );
      }
      if (!isUniqueViolation(err)) throw err;

      // Her own key, replayed. Wait for the winner's committed response and
      // return it verbatim rather than computing a second one.
      const stored = await awaitCommittedKey(db, idem);
      if (stored) return reply.code(stored.status).send(stored.body);

      throw conflict(
        'request_in_progress',
        'That request is still being processed. Try again in a moment.',
      );
    }
  });

  // ------------------------------------------------------------- GET /bookings --
  /**
   * Her own appointments. `?status=` filters; no filter returns everything, so
   * the wallet's Upcoming card asks for `deposit_held` and the activity screen
   * asks for the lot.
   */
  app.get('/bookings', async (req, reply) => {
    const p = requireMember(req);
    const statuses = parseStatuses((req.query as Record<string, unknown> | undefined)?.status);
    return reply.send({ items: await listMemberBookings(db, p.id, statuses), nextCursor: null });
  });

  // -------------------------------------------------------- GET /bookings/{id} --
  app.get<{ Params: { id: string } }>('/bookings/:id', async (req, reply) => {
    const p = requireMember(req);
    const [row] = await db
      .select()
      .from(booking)
      .where(and(eq(booking.id, req.params.id), eq(booking.memberId, p.id)))
      .limit(1);
    // Scoped to her own. Another customer's appointment answers 404, not 403 —
    // a 403 would confirm the id names a real booking somewhere.
    if (!row) throw notFound('unknown_booking', 'No such appointment.');
    return reply.send(serialiseBooking(row as BookingRow));
  });

  // ----------------------------------------------------- DELETE /bookings/{id} --
  /** Cancel. The deposit returns to the wallet — non-negotiable #5. */
  app.delete<{ Params: { id: string } }>('/bookings/:id', async (req, reply) => {
    const p = requireMember(req);
    return reply.send(
      await cancelBooking(db, req.params.id, {
        principal: p,
        ipAddress: req.ip ?? null,
        userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      }),
    );
  });

  // ------------------------------------------ POST /bookings/{id}/reschedule --
  /** Move the slot. The deposit carries; no money moves. */
  app.post<{ Params: { id: string } }>('/bookings/:id/reschedule', async (req, reply) => {
    const p = requireMember(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const startsAt = requireString(body.startsAt, 'startsAt', 40);

    try {
      return reply.send(
        await rescheduleBooking(db, req.params.id, startsAt, {
          principal: p,
          ipAddress: req.ip ?? null,
          userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
        }),
      );
    } catch (err) {
      // The same exclusion constraint, on an UPDATE this time. Two customers
      // moving into one slot is the same race as two booking it.
      if (isExclusionViolation(err)) {
        throw conflict('slot_taken', 'That time has just been taken. Pick another one.');
      }
      throw err;
    }
  });

  // -------------------------------------------------- GET /artists/me/bookings --
  /**
   * api-contract.md § Operations: "Staff | Own bookings | GET /artists/me/bookings".
   *
   * Scanner scope, NO permission — the same reasoning `PUT /artists/me/availability`
   * gives. It is her own day, self-scoped by the URL, and gating it on
   * `perms.appointments` would mean an artist needs the merchant's appointment
   * permission to see who is coming to see her.
   *
   * It carries the CUSTOMER's name and phone, which the design asks for
   * explicitly — README § My bookings, "the client's name/tier/phone, one-tap Call
   * and WhatsApp". That is a real disclosure and it is bounded to her own
   * bookings by construction: there is no id in this URL either.
   *
   * EXCEPT WHEN THE CUSTOMER HAS BEEN ERASED, and this is the surface where that
   * mattered most. "One-tap Call and WhatsApp" over a `+990` tombstone is an
   * outbound message to a number that exists only because `member.phone` is
   * `NOT NULL`. `memberPhone` is null and `memberErased` is true for that row —
   * DECISIONS.md #100, argued in full at `http/serialise.ts § serialiseMemberContact`.
   */
  app.get('/artists/me/bookings', async (req, reply) => {
    const p = requireScannerScope(req);

    const [a] = await db
      .select()
      .from(artist)
      .where(and(eq(artist.staffUserId, p.id), eq(artist.salonId, p.salonId)))
      .limit(1);
    /**
     * A staff account with no artist row — a receptionist, a scanner terminal —
     * is not bookable and has no day to show. 404 rather than 403: nothing was
     * refused on authority, there is simply no calendar here. Same as
     * `PUT /artists/me/availability`.
     */
    if (!a) {
      throw notFound(
        'not_an_artist',
        'This account is not set up as a bookable artist, so it has no bookings.',
      );
    }

    /**
     * A ROLLING 24 HOURS, not "from the start of today".
     *
     * That is what this line has always computed, and the comment above it said
     * the other thing for the whole life of the endpoint — so at 09:00 the screen
     * shows yesterday morning, which is a different screen from the one the
     * sentence described. Lane B reported the mismatch; it is corrected here
     * rather than left as the eleventh confident sentence in this repo that no
     * code beneath it backs.
     *
     * THE ROLLING WINDOW IS KEPT, and the comment moved to it, deliberately. A
     * midnight boundary would empty an artist's screen mid-shift for any salon
     * still open past twelve, and `salon.timezone` — not the server's — is the
     * only clock that could honestly define "today" here. That is a bigger change
     * than a comment fix and nobody has asked for it.
     */
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const rows = await db
      /**
       * `erasedAt` IS SELECTED HERE FOR A SHARPER REASON THAN ON THE OTHER TWO
       * BOARDS. The scanner renders this list's `memberPhone` as a `tel:` AND a
       * `https://wa.me/<digits>` button, so on an erased member this surface did
       * not merely display an unreachable number — it offered to message it.
       * `http/serialise.ts § serialiseMemberContact` carries the argument.
       */
      .select({
        b: booking,
        memberName: member.name,
        memberPhone: member.phone,
        memberErasedAt: member.erasedAt,
        memberTier: member.tier,
        serviceName: service.name,
        /**
         * THE DISCRIMINATOR. Null on every row except a cancellation that a VOID
         * produced — see the `where` below for why this is the only honest way to
         * tell the two cancellations apart.
         */
        reversesTransactionId: transaction.reversesTransactionId,
      })
      .from(booking)
      .innerJoin(member, eq(member.id, booking.memberId))
      .innerJoin(service, eq(service.id, booking.serviceId))
      /**
       * LEFT, because `settled_transaction_id` is NULL on precisely the
       * `deposit_held` rows — `booking_settlement_matches_status` makes that an
       * equivalence — and an inner join would silently drop every live
       * appointment from the artist's day. The opposite of the bug being fixed.
       */
      .leftJoin(transaction, eq(transaction.id, booking.settledTransactionId))
      .where(
        and(
          eq(booking.artistId, a.id),
          gte(booking.startsAt, since),
          /**
           * `cancelled` IS ADMITTED, BUT ONLY WHEN IT IS A REVERSAL.
           *
           * The bug: a void sets the booking to `cancelled` (routes/charges.ts
           * § heldBooking) while this filter listed only `deposit_held` and
           * `completed` — so an appointment the artist had just been paid for
           * DISAPPEARED from her screen the moment a manager voided the charge.
           * Not mislabelled. Gone.
           *
           * WHY NOT SIMPLY ADD `'cancelled'` TO THE LIST. Because `cancelled` has
           * two writers that mean opposite things:
           *
           *   services/booking.ts   the CUSTOMER cancelled before the visit. The
           *                         booking was `deposit_held`, was never charged,
           *                         and the slot is free. Nothing happened.
           *   routes/charges.ts     a STAFF MEMBER voided the charge after the
           *                         visit. The booking had been `completed`. The
           *                         work happened and the money went back.
           *
           * Admitting both would put appointments that are not happening onto her
           * day — a behaviour change nobody asked for, inherited from a bug fix
           * rather than chosen. So the customer's cancellation stays OFF her day,
           * and that is a decision rather than an omission: a freed slot is
           * plausibly information she wants, but it needs its own treatment on the
           * card and its own window, not a side effect of this predicate.
           * `artistDayVoid.int.test.ts` spec 5 pins the exclusion so that a later
           * widening has to be deliberate.
           *
           * WHY THIS PREDICATE IS SOUND AND NOT A GUESS. There is no discriminator
           * on the booking row itself: `settled_transaction_id` is set by both
           * paths, `completed_at` is null after both (the void explicitly nulls
           * it), and `cancelled_at` is stamped by both. But there is one exactly
           * one join away, and it is TOTAL:
           *
           *   `booking_settlement_matches_status` guarantees a `cancelled` booking
           *   has a non-null `settled_transaction_id`, so this left join never
           *   misses on the rows that matter; and
           *   `transaction.reverses_transaction_id` has exactly ONE writer in the
           *   whole API — the void at routes/charges.ts — behind the unique index
           *   `transaction_reverses_uq`.
           *
           * So "this cancellation is a reversal" is a committed fact about rows,
           * decided on the server. Non-negotiable #2: nothing here is derived from
           * a timestamp, and no client is trusted to work it out.
           */
          or(
            inArray(booking.status, ['deposit_held', 'completed']),
            and(eq(booking.status, 'cancelled'), isNotNull(transaction.reversesTransactionId)),
          ),
        ),
      )
      .orderBy(asc(booking.startsAt))
      .limit(100);

    return reply.send({
      items: rows.map((r) => ({
        ...serialiseBooking(r.b as BookingRow),
        /**
         * The NAME stays the tombstone — an artist seeing "Deleted account" in
         * her day is the honest rendering, and it is the string the design's
         * My bookings row already draws. Only the two contact buttons lose
         * their target, and `memberErased` is what tells the client to draw
         * something truthful in their place instead of a dead `tel:`.
         */
        memberName: r.memberName,
        ...serialiseMemberContact({ phone: r.memberPhone, erasedAt: r.memberErasedAt }),
        memberTier: r.memberTier,
        serviceName: r.serviceName,
        /**
         * "YOU RANG THIS UP AND IT WAS REVERSED" — the half of the fix that makes
         * the returned row worth returning.
         *
         * `status` alone says `cancelled`, which is true and flat. It does not
         * distinguish an appointment the customer called off from one this artist
         * PERFORMED and was paid for ninety seconds earlier, and on her screen
         * those are opposite facts: one is a free slot, the other is her completed
         * work being undone.
         *
         * WHY THIS IS A FIELD AND NOT A FIFTH `status`. A `voided` status would be
         * the clearer model and it is a four-way break — `BookingSchema` is
         * trunk-owned in `packages/types`, every surface's exhaustive switch on
         * `status` stops compiling, and the enum is a Postgres type behind four
         * CHECK constraints. This endpoint's item is ALREADY `BookingSchema` plus
         * joined fields (`memberName`, `memberPhone`, `memberErased`, `memberTier`,
         * `serviceName`), so one more of the same kind widens nothing shared. The
         * status enum is not the right place to record a fact about the
         * TRANSACTION that settled the booking.
         *
         * ALWAYS PRESENT, never omitted, for the reason `depositReturnedFils` and
         * `happyHour` on the charge response give: a client has to be able to tell
         * "this was not a reversal" from "this API is too old to say".
         */
        chargeVoided: r.reversesTransactionId !== null,
      })),
      nextCursor: null,
    });
  });
}
