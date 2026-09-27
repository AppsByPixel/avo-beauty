/**
 * Deposit health.
 *
 *   GET /salons/{id}/deposits     perms.appointments
 *
 * The client, verbatim and last on his numbered list: *"what if they dont have
 * enough payment (sometimes they dont have money but lock the booking and they
 * dont come) deposit health option for merchants"*.
 *
 * `services/depositHealth.ts` is the whole specification — what each figure
 * counts, why `awaiting_arrival`, `return_overdue` and `unclosed` are three
 * states and not one, and why every count and the instant that qualifies it come
 * out of a single SELECT. This file is the gate, the parameters and nothing
 * else.
 *
 * =========================================================================
 * WHY `perms.appointments`, ARGUED HERE RATHER THAN INHERITED SILENTLY
 * =========================================================================
 * `routes/salons.ts § GET /salons/:id/bookings` is `appointments`, and that
 * endpoint serves EVERY booking this one serves plus the resolved ones, with the
 * same member name, phone, artist, slot and `depositFils` on each row. So this
 * is a NARROWER read of a set `appointments` already opens, presented
 * differently. A stricter gate in front of it would be theatre of the kind
 * `services/reports.ts § earnings-by-branch` refused — "a gate somebody can walk
 * around one card to the left is worse than no gate, because it reads as a
 * control" — because the holder simply opens the appointment board and adds up.
 *
 * AND IT IS NOT `void`, WHICH IS THE GATE THE NEIGHBOURING WRITE USES.
 * `POST /salons/{id}/bookings/{id}/no-show` requires `void` because marking a
 * no-show RETURNS A CUSTOMER'S DEPOSIT: it moves money, mints a transaction and
 * flips a live appointment to a terminal state. This endpoint records nothing
 * and moves nothing. Gating a read behind the permission for the write it might
 * inform would mean a front desk could not see which of this morning's chairs
 * are still open — and the front desk is precisely who the client asked for. The
 * seed makes that concrete: Hessa (`ST-002`) holds `appointments` and not
 * `void`, which is the shape of a real salon.
 *
 * NOT `dashboard` EITHER, although the figures are tile-shaped.
 * `services/customerDirectory.ts` spends a page on the same choice and lands on
 * the same rule: the permission follows THE DATA, not the shape of the screen it
 * is drawn on. `dashboard` is the wide grant that opens Overview to anybody who
 * needs to see how the business is doing; this serves named customers, their
 * phone numbers and how late each one is, which is the appointment book.
 *
 * =========================================================================
 * `?branch=` YES, `?period=` NO
 * =========================================================================
 * `?branch=` is the same parameter Reports and `/metrics` take, through the same
 * `services/branchFilter.ts`, with the same three answers: absent, empty or
 * `all` is every branch; not a string is 400 `invalid_branch`; a branch that
 * does not exist or belongs to another salon is 404 `unknown_branch`,
 * indistinguishable from each other on purpose.
 *
 * `?period=` IS DELIBERATELY NOT ACCEPTED, and the reason is not that it was
 * awkward. Every figure here is a STOCK and not a FLOW: "how much of my
 * customers' money is held RIGHT NOW", "which slots never resolved", "how long
 * has that deposit been owed". A window has nothing to select. Accepting
 * `?period=2026-03-01_2026-03-31` and filtering `starts_at` into it would serve
 * "deposits held today for bookings whose slot was in March" under a label that
 * reads as "March's deposit health", which is a different figure and a false
 * one. `services/metrics.ts § the day` already draws this line for the two TODAY
 * tiles that a range reaches and stops at; this endpoint is entirely on that
 * side of it.
 *
 * Unknown query parameters are dropped by Fastify, so `?period=` here is inert
 * rather than refused — the same wider hole `routes/salons.ts § /metrics`
 * reports against `?compare=`, and it is trunk's to close for all of them at
 * once rather than one route's to patch.
 */

import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/client';
import { salon } from '../db/schema/salon';
import { requireDashboardPerm, requireSameSalon } from '../auth/principal';
import { notFound } from '../http/errors';
import { resolveBranchFilter } from '../services/branchFilter';
import { computeDepositHealth } from '../services/depositHealth';

export async function registerDepositRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string }; Querystring: { branch?: unknown } }>(
    '/salons/:id/deposits',
    async (req, reply) => {
      const p = requireDashboardPerm(req, 'appointments');
      requireSameSalon(p, req.params.id);

      /**
       * THE SALON ROW IS READ EVEN THOUGH NO FIGURE HERE NEEDS A TIMEZONE, and
       * that is a deliberate difference from `/metrics`, which needs one for its
       * midnight bounds. Nothing in `computeDepositHealth` has a day boundary:
       * every bound is `now` against a stored instant, so the PKT/Kuwait
       * host-clock trap `metrics.ts` documents cannot reach it.
       *
       * The lookup exists so an unknown salon id answers 404 `unknown_salon`
       * rather than an empty, cheerful report about a salon that does not exist
       * — which is what `WHERE salon_id = <nonsense>` returns, and it is
       * indistinguishable from a healthy salon with no held deposits.
       */
      const rows = await db
        .select({ id: salon.id })
        .from(salon)
        .where(eq(salon.id, req.params.id))
        .limit(1);
      const s = rows[0];
      if (!s) throw notFound('unknown_salon', 'No such salon.');

      /**
       * AFTER `requireSameSalon`, never before. The tenancy assertion on the
       * PATH has to land first, or a caller who is not this salon's staff would
       * learn from a 404-vs-200 whether a branch id exists here — the permission
       * check turned into an oracle by an input validated too early.
       * `routes/reports.ts § build` and `/metrics` order the same three calls
       * the same way and say why.
       */
      const br = await resolveBranchFilter(db, s.id, req.query?.branch);

      return reply.send(await computeDepositHealth(db, s.id, new Date(), br));
    },
  );
}
