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

import { and, asc, eq, gte, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/client';
import { artist } from '../db/schema/artist';
import { booking } from '../db/schema/booking';
import { member } from '../db/schema/member';
import { service } from '../db/schema/service';
import { requireMember, requireScannerScope } from '../auth/principal';
import { badRequest, conflict, notFound } from '../http/errors';
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

    // From the start of today onward. An artist's screen is her day, not her
    // history; the merchant's Appointments list is where the past lives.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const rows = await db
      .select({ b: booking, memberName: member.name, memberPhone: member.phone, memberTier: member.tier, serviceName: service.name })
      .from(booking)
      .innerJoin(member, eq(member.id, booking.memberId))
      .innerJoin(service, eq(service.id, booking.serviceId))
      .where(
        and(
          eq(booking.artistId, a.id),
          gte(booking.startsAt, since),
          inArray(booking.status, ['deposit_held', 'completed']),
        ),
      )
      .orderBy(asc(booking.startsAt))
      .limit(100);

    return reply.send({
      items: rows.map((r) => ({
        ...serialiseBooking(r.b as BookingRow),
        memberName: r.memberName,
        memberPhone: r.memberPhone,
        memberTier: r.memberTier,
        serviceName: r.serviceName,
      })),
      nextCursor: null,
    });
  });
}
