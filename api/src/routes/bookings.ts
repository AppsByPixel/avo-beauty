/**
 * Booking endpoints.
 *
 *   POST   /bookings                  member, idempotency key — holds the deposit
 *   GET    /bookings                  member — her own appointments
 *   GET    /bookings/{id}             member — one of hers
 *   DELETE /bookings/{id}             member — cancel, deposit returns
 *   POST   /bookings/{id}/reschedule  member — deposit carries
 *   GET    /salons/{id}/bookings      perms.appointments (in routes/salons.ts)
 *   POST   /salons/{id}/bookings      perms.appointments, idempotency key —
 *                                     the front desk writes one down, for an
 *                                     existing member OR a walk-in guest
 *   POST   /salons/{id}/bookings/{bookingId}/reschedule   perms.appointments
 *   POST   /salons/{id}/bookings/{bookingId}/reassign     perms.appointments
 *   POST   /salons/{id}/bookings/{bookingId}/cancel       perms.void
 *   POST   /salons/{id}/bookings/{bookingId}/complete     perms.appointments,
 *                                     zero-deposit only
 *   POST   /salons/{id}/bookings/{bookingId}/no-show
 *                                     dashboard + perms.void, idempotency key —
 *                                     the merchant marks a missed slot by hand
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
import {
  requireDashboardPerm,
  requireMember,
  requireSameSalon,
  requireScannerScope,
} from '../auth/principal';
import { badRequest, conflict, notFound } from '../http/errors';
import { serialiseMemberContact } from '../http/serialise';
import { parseE164 } from '../http/fields';
import { requireString } from '../money/validate';
import {
  cancelBooking,
  cancelByMerchant,
  completeBooking,
  createBooking,
  createMerchantBooking,
  isExclusionViolation,
  listMemberBookings,
  markNoShow,
  reassignArtist,
  rescheduleBooking,
  rescheduleByMerchant,
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

  // ------------------- POST /salons/{id}/bookings/{bookingId}/no-show --
  /**
   * "Mark no-show" — `design/AVO Merchant Dashboard.dc.html:184`, the understated
   * link beside the status pill on every held appointment.
   *
   * THE PATH IS UNDER `/salons/{id}` BECAUSE THE BOARD IS. The control is drawn on
   * `GET /salons/{id}/bookings` (routes/salons.ts), and the tenant segment is what
   * `requireSameSalon` needs: without it a merchant would address another salon's
   * appointment by bare id and be refused only by a lookup, which is a 404 doing a
   * tenancy boundary's job. The handler lives HERE, with the rest of the booking
   * lifecycle, so the four exits in `services/booking.ts` have their four routes in
   * one file.
   *
   * =======================================================================
   * THE PERMISSION IS `void`, AND IT IS ARGUED RATHER THAN INHERITED
   * =======================================================================
   * The obvious answer was `perms.appointments`, because that is what the board
   * next door uses. It is the wrong one, and the seed says why out loud.
   *
   *   `perms.appointments` IS A READ GATE. It grants the Appointments screen and
   *   the customer name, tier and phone joined onto it. Hanging a money-moving
   *   write off it SILENTLY WIDENS WHAT EVERY EXISTING HOLDER CAN DO — which is
   *   precisely the test DECISIONS.md 109 applied to `perms.void` and a typed
   *   price, and it fails here for the same reason.
   *
   *   AND THE HOLDERS ARE NOT HYPOTHETICAL. `db/seed.ts § ST-002` is Hessa,
   *   frontdesk: `perm_appointments = true` with `perm_dashboard`, `perm_charges`
   *   and `perm_void` all false. Under the inherited gate she could return a
   *   customer's deposit and stamp a no-show against her while remaining unable to
   *   open the dashboard or even SEE today's charges.
   *
   * `perms.void` IS THE NEAREST AUTHORITY THAT ALREADY EXISTS, on both axes this
   * endpoint has:
   *
   *   THE MONEY. Both return money to a customer and neither can send it anywhere
   *   else — #5. This one is the weaker of the two: it is bounded to one booking's
   *   published deposit, an amount nobody typed, on a hold the salon was already
   *   contractually going to release. Anyone trusted to reverse a settled charge is
   *   by construction trusted to release a hold.
   *
   *   THE RECORD. `no_show_returned` is an assertion about a named customer's
   *   conduct. The authority to record that kind of assertion already lives behind
   *   `void`: `VOID_REASON_CODES` includes `cust`, "Customer did not receive
   *   service", written against her by a `perms.void` holder today.
   *
   * AND IT IS SENIOR BY CONSTRUCTION. `permsOf` filters `void` through `charges`
   * and a database CHECK refuses the pair apart, so `void` cannot be held alone.
   * The design's own banner — "Use Mark no-show only for edge cases" — describes an
   * exceptional control, and an exceptional control belongs behind the senior
   * permission rather than the one the front desk holds to see the screen.
   *
   * THE COST OF BEING WRONG IS ASYMMETRIC, which settles it. If the front desk
   * cannot mark, she waits for the automatic return or asks a manager. If she can,
   * a customer who is sitting in the chair gets a no-show on her record and loses
   * her slot to the exclusion constraint. The first is an inconvenience; the second
   * is not reversible by a refund.
   *
   * NOT A TENTH PERMISSION. `perms.noShow` would be the most honest gate and it is
   * a four-way break — a `staff_user` column, `StaffPermsSchema` in trunk-owned
   * `packages/types`, the Accounts → Team chips, and lane D's census all move
   * together. DECISIONS.md 109 established that is not a lane's to make. Reported.
   *
   * NOT `requireDashboardPerm(req, 'appointments')` AS WELL. Composing the screen
   * gate with the authority gate was tempting and is wrong twice: non-negotiable #7
   * says in its own words that the UI hiding a button is a courtesy and not a
   * control, so folding the SCREEN permission into the server gate conflates the
   * two; and a conjunctive pair breaks `e2e/permission-census.test.ts`'s granted
   * mirror, which grants exactly one permission and requires the refusal to stop.
   *
   * ONE TRANSACTION — #3's spirit. The key claim, the balance, the ledger pair, the
   * status transition and the audit row commit together or not at all;
   * `services/booking.ts § markNoShow` is where that is written.
   */
  app.post<{ Params: { id: string; bookingId: string } }>(
    '/salons/:id/bookings/:bookingId/no-show',
    async (req, reply) => {
      /**
       * THE GATE FIRST, before the key is even read — `routes/adjustments.ts`'s
       * ordering and `requirePerm`'s own argument: an unauthorised caller should
       * not learn this endpoint's vocabulary, not even that it wants a key.
       */
      const p = requireDashboardPerm(req, 'void');
      requireSameSalon(p, req.params.id);

      const key = readIdempotencyKey(req);
      const idem = {
        scope: principalScope(p),
        endpoint: 'POST /salons/:id/bookings/:bookingId/no-show',
        key,
        /**
         * The booking is the whole request — there is no body. Hashing it is what
         * makes one key name one booking, so a client that reuses a key across two
         * appointments is refused rather than replayed the wrong one.
         */
        requestHash: hashRequestBody({ salonId: req.params.id, bookingId: req.params.bookingId }),
      };

      try {
        return reply.send(
          await markNoShow(
            db,
            { salonId: req.params.id, bookingId: req.params.bookingId, idempotency: idem },
            {
              principal: p,
              ipAddress: req.ip ?? null,
              userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
            },
          ),
        );
      } catch (err) {
        /**
         * ONLY the key's own index. `returnDeposit` can raise nothing else unique
         * on this path — its guarantee is a conditional UPDATE's row count, which
         * throws a 409 rather than a constraint — so any other unique violation is
         * a genuine surprise and must not be laundered into "request in progress",
         * which is the defect `services/idempotency.ts § violatedConstraint`
         * records against the void.
         */
        if (!isUniqueViolation(err)) throw err;

        const stored = await awaitCommittedKey(db, idem);
        if (stored) return reply.code(stored.status).send(stored.body);
        throw conflict(
          'request_in_progress',
          'That request is still being processed. Try again in a moment.',
        );
      }
    },
  );


  // ==================================================================
  // THE MERCHANT'S OWN APPOINTMENTS — client asks 5 and 6
  // ==================================================================
  /**
   *   POST /salons/{id}/bookings                     perms.appointments, key
   *   POST /salons/{id}/bookings/{id}/reschedule     perms.appointments
   *   POST /salons/{id}/bookings/{id}/reassign       perms.appointments
   *   POST /salons/{id}/bookings/{id}/cancel         perms.void
   *   POST /salons/{id}/bookings/{id}/complete       perms.appointments
   *
   * ALL UNDER `/salons/{id}` for the reason the no-show route above argues at
   * length: the board these controls are drawn on is `GET /salons/{id}/bookings`,
   * and the tenant segment is what `requireSameSalon` needs. Without it a merchant
   * would address another salon's appointment by bare id and be refused only by a
   * lookup, which is a 404 doing a tenancy boundary's job.
   *
   * =====================================================================
   * THE PERMISSION IS `appointments`, WHICH IS THE INVERSE OF THE ARGUMENT
   * THE NO-SHOW ROUTE MAKES — SO IT IS MADE HERE RATHER THAN ASSUMED
   * =====================================================================
   * No-show sits behind `perms.void` because of two things it does: it MOVES
   * MONEY (a real deposit returns to a real wallet) and it RECORDS AN ASSERTION
   * ABOUT A CUSTOMER'S CONDUCT (`no_show_returned` says she did not turn up).
   * That route's own header says the trap is "hanging a money-moving write off a
   * READ gate silently widens what every existing holder can do".
   *
   * CREATE, RESCHEDULE AND REASSIGN DO NEITHER, and the absence is structural
   * rather than incidental:
   *
   *   A merchant-created booking moves no money BY CONSTRUCTION. Non-negotiable
   *   #2 and `booking_merchant_is_zero_deposit` mean `deposit_fils = 0` with no
   *   hold — there is no wallet for this endpoint to reach into, on a member's
   *   booking or a guest's.
   *
   *   A reschedule CARRIES a deposit rather than spending it. No transaction, no
   *   ledger entry; the same hold still holds the same money against the same
   *   row. `rescheduleBooking` — the CUSTOMER's version of this endpoint — writes
   *   a `rules` audit row rather than a `money` one for exactly that reason.
   *
   *   A reassign changes who performs the service. The hold keeps the branch it
   *   was taken at; nothing about the money is touched.
   *
   *   And none of the three asserts anything about a customer. "You have an
   *   appointment at 17:15 with Shaikha" is not a claim about her conduct.
   *
   * AND BOOKING APPOINTMENTS IS LITERALLY THE FRONT DESK'S JOB. `db/seed.ts
   * § ST-002` is Hessa, frontdesk: `perm_appointments = true` with
   * `perm_dashboard`, `perm_charges` and `perm_void` all false. She is precisely
   * who should be able to write down a walk-in, move a 16:45 and hand it to
   * another artist, and she is precisely who must NOT be able to return a
   * deposit. The two gates are opposite because the two acts are.
   *
   * THE COST OF BEING WRONG IS ALSO INVERTED, which is what settles it. If the
   * front desk cannot write an appointment down, the feature the client asked for
   * does not exist for the person it was asked for. If she can, an artist's diary
   * gains a row a manager can move or cancel — recoverable in one click, against
   * a customer who never lost money.
   *
   * CANCEL IS `void`, AND IT DOES NOT VARY BY AMOUNT. Cancelling an APP booking
   * returns a real deposit to a real wallet, so it is a money-moving write by the
   * same definition no-show is. A gate that read `perms.appointments` for a
   * zero-deposit row and `perms.void` for a deposit-bearing one would be horrible
   * to reason about AND would break `e2e/permission-census.test.ts`'s granted
   * mirror, which grants exactly one permission and requires the refusal to stop:
   * a conditional gate has no single permission to grant. So `void` for all
   * cancels, consistent with no-show, and `services/booking.ts § cancelByMerchant`
   * carries the longer version.
   *
   * COMPLETE IS `appointments` AND ONLY ON A ZERO-DEPOSIT BOOKING. Completing a
   * deposit-bearing booking has to name the charge that consumed the hold, and
   * that happens at the scanner through `POST /charges`. There is deliberately no
   * second path to it — see `completeBooking`.
   *
   * NOT `requireDashboardPerm(req, 'appointments')` AS WELL ON THE CANCEL. The
   * no-show route's argument applies unchanged: folding the SCREEN permission into
   * the authority gate conflates a courtesy with a control (#7), and a conjunctive
   * pair breaks the permission census.
   *
   * =====================================================================
   * IDEMPOTENCY — REQUIRED ON THE CREATE, DELIBERATELY ABSENT ON THE OTHER FOUR
   * =====================================================================
   * Non-negotiable #4 asks for a key on every MONEY-MOVING post, and a merchant
   * create moves no money. It takes one anyway, and the reason is not the money:
   *
   *   A POST that succeeds twice creates two appointments, which is two hours of
   *   one artist's day and one customer. The exclusion constraint DOES refuse the
   *   second — and answers `slot_taken`, which is a confusing and slightly
   *   alarming thing to show someone who pressed the button once. With a key the
   *   double submit replays the first response and the front desk sees the
   *   appointment it just made.
   *
   *   So the key here buys a correct ANSWER rather than a correct effect. The
   *   effect was already safe; the constraint saw to that. Worth saying, because
   *   it is the one place in this API where a key is not load-bearing for money,
   *   and a future reader should not conclude money is moving here.
   *
   * THE OTHER FOUR NAME ONE RESOURCE WITH ONE LIVE STATE, and rely on
   * `FOR UPDATE` the way `cancelBooking` argues: a second request blocks on the
   * row lock, re-reads a status that is no longer `deposit_held`, and is answered
   * `already_cancelled` / `already_completed` / `not_changeable`. That is stronger
   * than a key, because it holds for two DIFFERENT keys as well as for one
   * repeated.
   */

  // ------------------------------------------- POST /salons/{id}/bookings --
  app.post<{ Params: { id: string } }>('/salons/:id/bookings', async (req, reply) => {
    // The gate first, before the key is even read — `routes/adjustments.ts`'s
    // ordering: an unauthorised caller should not learn this endpoint's
    // vocabulary, not even that it wants a key.
    const p = requireDashboardPerm(req, 'appointments');
    requireSameSalon(p, req.params.id);
    const key = readIdempotencyKey(req);

    const body = (req.body ?? {}) as Record<string, unknown>;
    const artistId = requireString(body.artistId, 'artistId', 100);
    const serviceId = requireString(body.serviceId, 'serviceId', 100);
    const startsAt = requireString(body.startsAt, 'startsAt', 40);

    /**
     * NEITHER `branchId` NOR `depositFils`, and both are refused by name rather
     * than ignored — `POST /bookings` established the shape. A branch is resolved
     * from the artist; a deposit on a merchant booking is 0 and is not a field.
     */
    if ('branchId' in body) {
      throw badRequest(
        'branch_not_client_supplied',
        "A booking's branch is resolved by the server, not sent by the client.",
      );
    }
    if ('depositFils' in body) {
      throw badRequest(
        'deposit_not_client_supplied',
        'A merchant-created appointment never takes a deposit, so it has no amount to send.',
      );
    }

    /**
     * EXACTLY ONE OF `memberId` AND `guestName`, refused here rather than left to
     * `booking_identity_exactly_one` — a constraint violation is a 500 wearing the
     * wrong message, and "which of the two did you mean" is a question the form
     * can answer.
     */
    const hasMember = body.memberId !== undefined && body.memberId !== null;
    const hasGuest = body.guestName !== undefined && body.guestName !== null;
    if (hasMember === hasGuest) {
      throw badRequest(
        'identity_required',
        hasMember
          ? 'Name an existing customer or a walk-in, not both.'
          : 'Name an existing customer with memberId, or a walk-in with guestName.',
      );
    }

    const memberId = hasMember ? requireString(body.memberId, 'memberId', 100) : null;
    const guestName = hasGuest ? requireString(body.guestName, 'guestName', 120) : null;
    /**
     * THE PHONE IS OPTIONAL AND ONLY MEANS ANYTHING ON A GUEST. Through
     * `parseE164`, which is the same function `member.phone` goes through and the
     * same shape `member_phone_is_e164` enforces — so the board's one-tap Call
     * does not have to guess whether a guest's number is dialable, and a salon's
     * database holds one kind of phone number rather than two.
     *
     * NOT SEARCHABLE. There is no index on it and no endpoint looks a guest up by
     * digits. `services/memberSearch.ts` has a reported bug where a phone-digit
     * `LIKE '%78%'` also matches a member id; the fix for that is not to add a
     * second search with the same shape.
     */
    let guestPhone: string | null = null;
    if (body.guestPhone !== undefined && body.guestPhone !== null && body.guestPhone !== '') {
      if (!hasGuest) {
        throw badRequest(
          'guest_phone_without_guest',
          "An existing customer's number is on her account, not on the appointment.",
        );
      }
      guestPhone = parseE164(body.guestPhone);
    }

    const idem = {
      scope: principalScope(p),
      endpoint: 'POST /salons/:id/bookings',
      key,
      requestHash: hashRequestBody({
        salonId: req.params.id,
        artistId,
        serviceId,
        startsAt,
        memberId,
        guestName,
        guestPhone,
      }),
    };

    try {
      const result = await createMerchantBooking(
        db,
        {
          salonId: req.params.id,
          artistId,
          serviceId,
          startsAt,
          memberId,
          guestName,
          guestPhone,
          idempotency: idem,
        },
        {
          principal: p,
          ipAddress: req.ip ?? null,
          userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
        },
      );
      return reply.code(201).send(result);
    } catch (err) {
      /**
       * THE EXCLUSION CONSTRAINT, SPANNING BOTH KINDS OF APPOINTMENT. This is the
       * whole reason a hand-written appointment lives in `booking` rather than in
       * a table of its own — see db/schema/booking.ts. A merchant create that
       * overlaps an APP booking lands here, and so does the reverse.
       *
       * CHECKED BEFORE the unique violation, for `POST /bookings`'s reason: an
       * exclusion violation is not an idempotency replay, and searching for a
       * stored response under this key would find nothing and report a transient
       * condition for a permanent one.
       */
      if (isExclusionViolation(err)) {
        throw conflict('slot_taken', 'That artist already has an appointment then.');
      }
      if (!isUniqueViolation(err)) throw err;

      const stored = await awaitCommittedKey(db, idem);
      if (stored) return reply.code(stored.status).send(stored.body);
      throw conflict(
        'request_in_progress',
        'That request is still being processed. Try again in a moment.',
      );
    }
  });

  // -------------------------- POST /salons/{id}/bookings/{id}/reschedule --
  app.post<{ Params: { id: string; bookingId: string } }>(
    '/salons/:id/bookings/:bookingId/reschedule',
    async (req, reply) => {
      const p = requireDashboardPerm(req, 'appointments');
      requireSameSalon(p, req.params.id);

      const body = (req.body ?? {}) as Record<string, unknown>;
      const startsAt = requireString(body.startsAt, 'startsAt', 40);

      try {
        return reply.send(
          await rescheduleByMerchant(
            db,
            { salonId: req.params.id, bookingId: req.params.bookingId, startsAt },
            {
              principal: p,
              ipAddress: req.ip ?? null,
              userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
            },
          ),
        );
      } catch (err) {
        // The same constraint, on an UPDATE. Moving into a taken slot is the same
        // race as booking one.
        if (isExclusionViolation(err)) {
          throw conflict('slot_taken', 'That artist already has an appointment then.');
        }
        throw err;
      }
    },
  );

  // ---------------------------- POST /salons/{id}/bookings/{id}/reassign --
  app.post<{ Params: { id: string; bookingId: string } }>(
    '/salons/:id/bookings/:bookingId/reassign',
    async (req, reply) => {
      const p = requireDashboardPerm(req, 'appointments');
      requireSameSalon(p, req.params.id);

      const body = (req.body ?? {}) as Record<string, unknown>;
      const artistId = requireString(body.artistId, 'artistId', 100);

      try {
        return reply.send(
          await reassignArtist(
            db,
            { salonId: req.params.id, bookingId: req.params.bookingId, artistId },
            {
              principal: p,
              ipAddress: req.ip ?? null,
              userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
            },
          ),
        );
      } catch (err) {
        /**
         * THE SAME CONSTRAINT AGAIN, and this is the direction most worth naming:
         * handing a 16:45 to an artist who already has a 16:45 is a double-book
         * that no status check and no availability read would catch, because
         * nothing about the booking being MOVED has changed. Only the index knows.
         */
        if (isExclusionViolation(err)) {
          throw conflict('slot_taken', 'That artist already has an appointment then.');
        }
        throw err;
      }
    },
  );

  // ------------------------------ POST /salons/{id}/bookings/{id}/cancel --
  /** `perms.void` — an app booking's deposit comes back. See the header. */
  app.post<{ Params: { id: string; bookingId: string } }>(
    '/salons/:id/bookings/:bookingId/cancel',
    async (req, reply) => {
      const p = requireDashboardPerm(req, 'void');
      requireSameSalon(p, req.params.id);

      return reply.send(
        await cancelByMerchant(
          db,
          { salonId: req.params.id, bookingId: req.params.bookingId },
          {
            principal: p,
            ipAddress: req.ip ?? null,
            userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
          },
        ),
      );
    },
  );

  // ---------------------------- POST /salons/{id}/bookings/{id}/complete --
  app.post<{ Params: { id: string; bookingId: string } }>(
    '/salons/:id/bookings/:bookingId/complete',
    async (req, reply) => {
      const p = requireDashboardPerm(req, 'appointments');
      requireSameSalon(p, req.params.id);

      return reply.send(
        await completeBooking(
          db,
          { salonId: req.params.id, bookingId: req.params.bookingId },
          {
            principal: p,
            ipAddress: req.ip ?? null,
            userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
          },
        ),
      );
    },
  );

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
        /**
         * WHY, when there is a why. On the SAME ROW the discriminator above
         * comes from — no second join, no audit-log read. The column is on the
         * reversal (migration 0050) and the reversal is what this left join
         * already reaches through `settled_transaction_id`.
         */
        voidReasonCode: transaction.voidReasonCode,
      })
      .from(booking)
      /**
       * LEFT, AND THIS ONE WAS AN `innerJoin` UNTIL MIGRATION 0056 MADE IT A BUG.
       *
       * `booking.member_id` is nullable now: a hand-written appointment for a
       * walk-in names a guest instead. An inner join on a nullable column drops
       * every one of those rows, so an artist's own day would silently lose every
       * appointment the front desk booked for somebody without an account — the
       * screen the feature exists for, missing exactly the appointments the
       * feature created. Not mislabelled. Gone. The same shape as the void bug
       * this endpoint's `where` clause already records.
       */
      .leftJoin(member, eq(member.id, booking.memberId))
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
        /**
         * THE GUEST'S NAME IS WHAT `memberName` SERVES FOR A GUEST ROW.
         *
         * The field is what every client already draws at the top of the card, and
         * on a guest row the honest answer to "who is this appointment for" is the
         * name the front desk wrote down. Falling back keeps one field meaning one
         * thing — "who is coming" — rather than adding a second the scanner would
         * have to learn about before it could render a row it is already sent.
         *
         * THE TOMBSTONE CONTRACT IS UNTOUCHED FOR A REAL MEMBER: `r.memberName` is
         * "Deleted account" on an erased row and the `??` never fires, because an
         * erased member still HAS a name. The fallback can only be reached when
         * `member_id` is null, and `booking_identity_exactly_one` guarantees
         * `guest_name` is non-null exactly then.
         */
        memberName: r.memberName ?? r.b.guestName,
        /**
         * AND THE CONTACT CONTRACT IS UNTOUCHED TOO. `serialiseMemberContact` is
         * still the only thing that decides whether a number may be dialled, and it
         * still answers on `erased_at`. A guest has no member row, so `erasedAt` is
         * null and her own number — the one she just gave the front desk — is what
         * `guest_phone` holds. `memberErased: false` is the truth about a guest:
         * there is no account, so there is no erased account.
         */
        ...serialiseMemberContact({
          phone: r.memberPhone ?? r.b.guestPhone,
          erasedAt: r.memberErasedAt,
        }),
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
        /**
         * ============================================================
         * "AND THIS IS WHY" — the field lane B asked for, as a CODE.
         * ============================================================
         * Three reasons mean opposite things to the artist reading this row.
         * "Wrong amount or service" is a correction, "Duplicate charge" is
         * housekeeping, and "Customer did not receive service" is an assertion
         * that she did not do the job. She has `permDashboard: false`, so she can
         * open neither the audit log nor `GET /charges`: this is the ONLY surface
         * on which she could learn which of the three was said about her work.
         *
         * WHY A CODE AND NOT THE STORED WORDS. `transaction.note` on this same
         * row already holds the reason, and serving it was the cheap option.
         * Rejected twice over. `POST /voids` accepts any string — today's scanner
         * sends one of three written labels by choice, not by constraint — so the
         * column would put an arbitrary client's free text on a named artist's
         * screen. And DECISIONS.md 107 establishes that the column carries four
         * unrelated meanings; a field that means four things is not a field. The
         * code is validated against `VOID_REASON_CODES` in the handler AND by
         * `transaction_void_reason_code_valid` at the database, so exactly three
         * values can ever arrive here.
         *
         * THE WORDS STAY THE CLIENT'S, and that is the point rather than a
         * concession — it is what lane B asked for when it asked for an enum.
         * Non-negotiable #12 makes Arabic a first-class layout, and there is no
         * locale on `staff_user` for a server-composed sentence to select on.
         *
         * NULL IS NOT A FOURTH REASON. It means this void recorded no code —
         * true of every void taken before migration 0050, and of any client that
         * does not send one. `chargeVoided` is the separate, older fact and stays
         * authoritative: `voidReason` non-null implies `chargeVoided`, and
         * `chargeVoided` emphatically does not imply `voidReason`. A row with
         * `chargeVoided: true, voidReason: null` is "voided, reason not
         * recorded", which is exactly what lane B renders today.
         *
         * ALWAYS PRESENT, never omitted, for the reason `chargeVoided` gives
         * above it: a client must be able to tell "no reason was recorded" from
         * "this API is too old to say".
         *
         * WHAT IT DOES NOT DISCLOSE. Not the actor — `created_by_staff_id` is on
         * this row too and is deliberately not selected. Lane B scoped its ask to
         * the code for that reason and the scoping is kept: who voided a charge is
         * a different disclosure from why, and it belongs to a surface with an
         * appeal attached to it, not to a pill on a day view.
         */
        voidReason: r.voidReasonCode,
      })),
      nextCursor: null,
    });
  });
}
