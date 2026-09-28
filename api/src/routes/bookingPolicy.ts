/**
 * The salon's own booking policy (migration 0066).
 *
 *   GET /salons/{id}/booking-policy    any principal of the salon — her, or its staff
 *   PUT /salons/{id}/booking-policy    perms.loyalty — publishes version n+1
 *
 * services/bookingPolicy.ts is the specification: what a policy decides, how it is
 * validated, the rounding, the LEGACY behaviour, and the bell each publish writes.
 *
 * =========================================================================
 * `PUT` IS `perms.loyalty`, BECAUSE THAT IS WHAT GATES THE DEPOSIT SETTINGS
 * =========================================================================
 * The deposit amount and the no-show window this replaces are written through
 * `PATCH /salons/{id}` (routes/salons.ts), which is `requireDashboardPerm(req,
 * 'loyalty')` — the Settings screen's gate, whose name that route's own header
 * already reports as narrower than it sounds. The policy is the same screen's
 * next field, so it takes the same gate. A weaker one would let a staff member
 * who cannot change the deposit decide whether the salon keeps it; `void` (the
 * no-show MARK's gate) was considered and rejected — `void` authorises acting on
 * one booking, and this writes the rule every future booking is made under.
 * A tenth permission (`perms.settings`) is the honest name and a four-way break;
 * reported by routes/salons.ts already, not re-reported here.
 *
 * =========================================================================
 * `GET` IS NOT GATED BY A PERMISSION, AND THAT IS ARGUED
 * =========================================================================
 * The policy is SHOWN TO EVERY CUSTOMER before she books — it is the most public
 * thing a salon publishes. A permission in front of the staff read would be the
 * "gate somebody can walk around" routes/deposits.ts refuses: any holder of a
 * customer login reads it here, and `GET /salons/{id}`, which serves the deposit
 * amount itself, is `requireSalonScoped` for the same reason. So it is the same
 * gate as that read: signed in, and this salon's — tenancy is the control.
 * A platform principal is refused by `requireSalonScoped`, as on every salon read.
 *
 * =========================================================================
 * NO IDEMPOTENCY KEY ON THE PUT, AND WHY THAT IS SAFE
 * =========================================================================
 * It moves no money, and it is idempotent by construction: an identical body
 * publishes nothing and returns the current version (`published: false`), so a
 * double-submitted Save cannot mint two versions or two bell notices.
 */

import type { FastifyInstance } from 'fastify';
import { db } from '../db/client';
import { requireDashboardPerm, requireSalonScoped, requireSameSalon } from '../auth/principal';
import { parsePolicyInput, publishPolicy, readPublishedPolicy, serialisePolicy } from '../services/bookingPolicy';

export async function registerBookingPolicyRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>('/salons/:id/booking-policy', async (req, reply) => {
    const p = requireSalonScoped(req);
    requireSameSalon(p, req.params.id);

    const row = await readPublishedPolicy(db, req.params.id);
    /**
     * `{ policy: null }`, not a 404, for a salon that has never published one:
     * "no policy" is a fact the wallet renders (legacy terms apply), not a
     * missing resource, and a 404 here would be indistinguishable from a typo in
     * the path.
     */
    return reply.send({ policy: row ? serialisePolicy(row) : null });
  });

  app.put<{ Params: { id: string } }>('/salons/:id/booking-policy', async (req, reply) => {
    // THE GATE FIRST, before the body is read — an unauthorised caller learns no
    // vocabulary. `routes/adjustments.ts`'s ordering.
    const p = requireDashboardPerm(req, 'loyalty');
    requireSameSalon(p, req.params.id);

    const input = parsePolicyInput(req.body);
    const result = await publishPolicy(db, {
      salonId: req.params.id,
      input,
      principal: p,
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    });
    return reply.send(result);
  });
}
