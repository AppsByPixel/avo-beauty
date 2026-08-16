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
import { parseLoyaltyConfig } from '../services/loyaltyRules';
import { parseTimeZone } from '../time/zone';
import { loyaltyConfigOf } from './loyalty';

/** Fields a merchant may edit. Anything else in the body is refused, not ignored. */
const EDITABLE = new Set([
  'name',
  // `name` and `stampReward` are editable, so their Arabic twins are too. A
  // field the API serves but nothing can ever set is the same half-implemented
  // state this change exists to close: it would leave the Arabic name settable
  // only by a hand-written UPDATE.
  'nameAr',
  'brandColor',
  'loyaltyMode',
  'tiers',
  'stampTarget',
  'stampReward',
  'stampRewardAr',
  'depositFils',
  'noShowReturnMinutes',
  /**
   * Editable, and validated as an IANA id rather than stored verbatim.
   *
   * It decides what "10:00" means for business hours, artist windows and every
   * happy-hour window, so an unvalidated string here would not fail loudly — it
   * would make `Intl.DateTimeFormat` throw inside a charge, three screens away
   * from the field that was typed wrong. See `parseTimeZone`.
   */
  'timezone',
  'businessHours',
  'social',
  'whatsappEnabled',
]);

/**
 * The nullable Arabic columns, and the only fields on this route where an empty
 * string is not a value.
 *
 * `'' ?? name` is `''` — a blank Arabic name defeats the client's fallback and
 * paints an empty heading, which is why the CHECK constraint refuses it. Coerced
 * here rather than 400'd because clearing a translation is a legitimate thing to
 * want, and "" is how an emptied text input arrives. Without this, clearing the
 * field would surface as a constraint violation, i.e. a 500 on a valid intent.
 */
const NULLABLE_ARABIC = new Set(['nameAr', 'stampRewardAr']);

/**
 * The fields that describe what a visit and a top-up are worth. Touching any of
 * them sends the whole loyalty configuration through the publish validator —
 * see the block comment in the PATCH handler.
 */
const LOYALTY_FIELDS = new Set([
  'loyaltyMode',
  'tiers',
  'stampTarget',
  'stampReward',
  'stampRewardAr',
]);

function normaliseArabic(key: string, value: unknown): unknown {
  if (!NULLABLE_ARABIC.has(key)) return value;
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw badRequest('invalid_request', `${key} must be a string or null.`);
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

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
      // Emitted whether or not it is set, and emitted as JSON `null` when it is
      // not. An OMITTED key and a null are the same thing to `??`, which is
      // exactly why the missing implementation went unnoticed — so the absent
      // case is now a value the client can actually see and a spec can actually
      // assert on. What must never reach a client is the STRING "null".
      nameAr: s.nameAr,
      plan: s.plan,
      brandColor: s.brandColor,
      modules: { booking: s.moduleBooking, shop: s.moduleShop },
      loyaltyMode: s.loyaltyMode,
      tiers: s.tiers,
      stampTarget: s.stampTarget,
      stampReward: s.stampReward,
      stampRewardAr: s.stampRewardAr,
      depositFils: s.depositFils,
      noShowReturnMinutes: s.noShowReturnMinutes,
      /**
       * Emitted to every surface, not just the dashboard. `businessHours` right
       * below it is naive wall clock and means nothing without this — a wallet
       * that renders "Open until 21:00" is rendering a string in a zone it was
       * never told. The clients also need it to resolve `isHappyHourLive`
       * themselves, every second, which is the whole point of there being no
       * `live` flag.
       */
      timezone: s.timezone,
      businessHours: s.businessHours,
      branches: branches.map((b) => ({
        id: b.id,
        salonId: b.salonId,
        name: b.name,
        nameAr: b.nameAr,
      })),
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
    for (const k of keys) patch[k] = normaliseArabic(k, body[k]);

    // Refused here, before the UPDATE, so a typo is a 400 naming the tz database
    // rather than a 500 thrown out of `Intl.DateTimeFormat` inside the next
    // charge that tries to resolve a happy hour.
    if ('timezone' in body) patch.timezone = parseTimeZone(body.timezone);

    /**
     * THE SECOND DOOR INTO THE TIER LADDER, AND WHY IT IS VALIDATED HERE TOO.
     *
     * `tiers`, `loyaltyMode`, `stampTarget` and the stamp reward copy have been
     * in `EDITABLE` since this route was written, and until now nothing checked
     * them. Every rule the publish endpoint enforces — four rungs, Bronze locked
     * at 0/0, each threshold above the one below — could be walked around by
     * sending the same fields one route over, which makes the validation
     * decorative: an invalid ladder published through the unguarded door is not
     * a smaller money bug than one published through the guarded one.
     *
     * So the loyalty fields go through the SAME validator
     * (services/loyaltyRules.ts), and the result replaces them wholesale rather
     * than being merged key by key. The validator returns a COMPLETE
     * configuration — it fills in whatever the request did not mention from the
     * current row — which is what keeps `salon_loyalty_config_complete`
     * satisfiable when a caller flips `loyaltyMode` and nothing else.
     *
     * `PUT /salons/{id}/loyalty` remains the endpoint the editor should use: it
     * returns the preview and writes the "Tier rules published" audit line. This
     * is the guard on the general-purpose door, not a second front entrance.
     */
    const touchesLoyalty = keys.some((k) => LOYALTY_FIELDS.has(k));
    if (touchesLoyalty) {
      const config = parseLoyaltyConfig(body, loyaltyConfigOf(before));
      patch.loyaltyMode = config.mode;
      patch.tiers = config.tiers;
      patch.stampTarget = config.stampTarget;
      patch.stampReward = config.stampReward;
      patch.stampRewardAr = config.stampRewardAr;
    }

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
