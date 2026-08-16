/**
 * Salon reads and edits. Four of the nine permission gates live here.
 *
 *   GET   /salons/{id}/metrics   perms.dashboard
 *   GET   /salons/{id}/products  perms.shop
 *   GET   /salons/{id}/bookings  perms.appointments
 *   PATCH /salons/{id}           perms.loyalty
 *
 * PATCH is the one that matters most. The loyalty editor writes through it, and
 * build-plan.md calls a half-published tier ladder a money bug — a member who
 * tops up between two writes gets a bonus from a ladder that does not exist yet.
 * The ladder is one jsonb column precisely so a publish is a single row update
 * and cannot half-write; the gate here is what stops someone without loyalty
 * authority reaching it at all.
 *
 * `GET /salons/{id}` itself is not gated: the customer wallet renders the salon
 * name, brand colour, business hours and social links, so it is readable by any
 * authenticated principal of that salon and serialised without anything
 * merchant-only in it.
 */

import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/client';
import { branch, salon } from '../db/schema/salon';
import { service } from '../db/schema/service';
import { requireDashboardPerm, requirePrincipal, requireSameSalon } from '../auth/principal';
import { badRequest, notFound } from '../http/errors';
import { writeAudit } from '../services/audit';

/** Fields a merchant may edit. Anything else in the body is refused, not ignored. */
const EDITABLE = new Set([
  'name',
  'brandColor',
  'loyaltyMode',
  'tiers',
  'stampTarget',
  'stampReward',
  'depositFils',
  'noShowReturnMinutes',
  'businessHours',
  'social',
  'whatsappEnabled',
]);

export async function registerSalonRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>('/salons/:id', async (req, reply) => {
    const p = requirePrincipal(req);
    requireSameSalon(p, req.params.id);

    const rows = await db.select().from(salon).where(eq(salon.id, req.params.id)).limit(1);
    const s = rows[0];
    if (!s) throw notFound('unknown_salon', 'No such salon.');

    const branches = await db.select().from(branch).where(eq(branch.salonId, s.id));

    return reply.send({
      id: s.id,
      name: s.name,
      plan: s.plan,
      brandColor: s.brandColor,
      modules: { booking: s.moduleBooking, shop: s.moduleShop },
      loyaltyMode: s.loyaltyMode,
      tiers: s.tiers,
      stampTarget: s.stampTarget,
      stampReward: s.stampReward,
      depositFils: s.depositFils,
      noShowReturnMinutes: s.noShowReturnMinutes,
      businessHours: s.businessHours,
      branches: branches.map((b) => ({ id: b.id, salonId: b.salonId, name: b.name })),
      social: s.social,
      whatsappEnabled: s.whatsappEnabled,
    });
  });

  /** perms.loyalty — the loyalty editor writes through here. */
  app.patch<{ Params: { id: string } }>('/salons/:id', async (req, reply) => {
    const p = requireDashboardPerm(req, 'loyalty');
    requireSameSalon(p, req.params.id);

    const body = (req.body ?? {}) as Record<string, unknown>;
    const keys = Object.keys(body);
    if (keys.length === 0) throw badRequest('invalid_request', 'Nothing to change.');

    const rejected = keys.filter((k) => !EDITABLE.has(k));
    if (rejected.length > 0) {
      throw badRequest('not_editable', `These fields cannot be edited here: ${rejected.join(', ')}.`);
    }

    const rows = await db.select().from(salon).where(eq(salon.id, req.params.id)).limit(1);
    const before = rows[0];
    if (!before) throw notFound('unknown_salon', 'No such salon.');

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of keys) patch[k] = body[k];

    const [after] = await db
      .update(salon)
      .set(patch)
      .where(eq(salon.id, req.params.id))
      .returning();

    await writeAudit(db, p, {
      salonId: p.salonId,
      kind: 'rules',
      action: 'Salon settings changed',
      detail: `Changed: ${keys.join(', ')}`,
      source: 'merchant',
      subjectType: 'salon',
      subjectId: req.params.id,
      metadata: { changed: keys },
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    });

    return reply.send(after);
  });

  /** perms.dashboard */
  app.get<{ Params: { id: string } }>('/salons/:id/metrics', async (req, reply) => {
    const p = requireDashboardPerm(req, 'dashboard');
    requireSameSalon(p, req.params.id);

    // Real aggregation is phase 2 of build-plan.md; the gate is what this task
    // owes, and the shape matches packages/mock so lane C is not blocked.
    return reply.send({
      activeMembers: 0,
      activeMembersDelta: 0,
      loadedTodayFils: 0,
      knetSharePercent: 0,
      repeatRatePercent: 0,
      upcomingAppointments: 0,
    });
  });

  /** perms.shop */
  app.get<{ Params: { id: string } }>('/salons/:id/products', async (req, reply) => {
    const p = requireDashboardPerm(req, 'shop');
    requireSameSalon(p, req.params.id);
    return reply.send({ items: [], nextCursor: null });
  });

  /**
   * perms.appointments. Bookings are not implemented — the route exists so the
   * ninth permission has a server-side gate rather than an unguarded 404 that
   * looks like a gate and is not.
   */
  app.get<{ Params: { id: string } }>('/salons/:id/bookings', async (req, reply) => {
    const p = requireDashboardPerm(req, 'appointments');
    requireSameSalon(p, req.params.id);
    return reply.send({ items: [], nextCursor: null });
  });

  /** The scanner's service list. Readable by anyone who may scan. */
  app.get<{ Params: { id: string } }>('/salons/:id/services', async (req, reply) => {
    const p = requirePrincipal(req);
    requireSameSalon(p, req.params.id);
    const rows = await db
      .select({ id: service.id, name: service.name, priceFils: service.priceFils })
      .from(service)
      .where(and(eq(service.salonId, req.params.id), eq(service.active, true)));
    return reply.send({ items: rows, nextCursor: null });
  });
}
