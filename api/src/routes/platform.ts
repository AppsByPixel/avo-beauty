/**
 * Shared platform state: promotions, campaigns.
 *
 * `POST /v1/salons/{id}/campaigns` is the ninth permission gate (`perms.marketing`)
 * and the place non-negotiable #8 lives:
 *
 *   "A merchant cannot send a customer message. POST /campaigns only creates
 *    pending. Delivery happens on the platform decision endpoint, and caps and
 *    quiet hours are enforced again at send time."
 *
 * So `status` is hardcoded to `pending` and a client-supplied `status` is
 * ignored — not merged, not validated-then-used. `reach` is likewise
 * server-computed and never trusted from the client (api-contract.md § Campaign).
 *
 * The promotion set is read-only here. It is ONE object that the wallet and the
 * dashboard both read, and it deliberately ships days/from/to with no `live`
 * flag: the predicate resolves on each client every second and on the server at
 * charge time, so a stale banner cannot cause a wrong charge.
 */

import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requireDashboardPerm, requirePrincipal, requireSameSalon } from '../auth/principal';
import { badRequest, conflict, notFound } from '../http/errors';
import { requireString } from '../money/validate';
import { writeAudit } from '../services/audit';
import { db } from '../db/client';
import { branch } from '../db/schema/salon';
import { boost, happyHour, REWARD_KEYS } from '../db/schema/promotion';
import {
  hasBeenApplied,
  readPromotionSet,
  serialiseHappyHour,
} from '../services/promotions';

/** "10:00"..."23:59", plus "24:00" on `to` only — see db/schema/promotion.ts. */
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const HHMM_OR_END_OF_DAY = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;

function happyHourId(): string {
  return `HH-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

/**
 * Every OPEN branch of this salon. `branchId: 'all'` is the wire's sentinel and
 * is handled by the caller.
 *
 * Closed branches are excluded so a new happy hour or a boost cannot be scoped
 * to a location that takes no money — `resolveBranch` will never attribute a
 * charge there, so such a window would be silently dead. The `PUT …/boosts`
 * caller relies on this in a second way: it resets every branch the body omits,
 * and a closed branch has no business being reset to a neutral boost it can
 * never spend.
 */
async function branchIdsOf(salonId: string): Promise<Set<string>> {
  const rows = await db
    .select({ id: branch.id })
    .from(branch)
    .where(and(eq(branch.salonId, salonId), isNull(branch.closedAt)));
  return new Set(rows.map((r) => r.id));
}

interface WindowFields {
  branchId: string | null;
  days: number[];
  from: string;
  to: string;
  reward: string;
  on: boolean;
  notify: boolean;
}

/**
 * Validate a happy-hour window.
 *
 * `partial` is what separates POST from PATCH: a POST must carry a whole window,
 * a PATCH may carry one field. Everything that IS present is validated the same
 * way either way — a PATCH is not a second, laxer door into the same row.
 */
async function parseWindow(
  body: Record<string, unknown>,
  salonId: string,
  current: WindowFields | null,
): Promise<WindowFields> {
  const allowed = new Set(['branchId', 'days', 'from', 'to', 'reward', 'on', 'notify']);
  const rejected = Object.keys(body).filter((k) => !allowed.has(k));
  if (rejected.length > 0) {
    throw badRequest(
      'not_editable',
      `These fields cannot be set on a happy hour: ${rejected.join(', ')}.`,
    );
  }

  const out: WindowFields = current
    ? { ...current }
    : { branchId: null, days: [], from: '', to: '', reward: '', on: true, notify: false };

  if ('branchId' in body) {
    const v = body.branchId;
    if (v === 'all' || v === null) {
      out.branchId = null;
    } else if (typeof v === 'string' && (await branchIdsOf(salonId)).has(v)) {
      out.branchId = v;
    } else {
      // Refused rather than coerced to "all". A window the merchant scoped to
      // Salmiya and that silently became salon-wide is money she did not agree
      // to spend at the other branch.
      throw badRequest(
        'invalid_branch',
        'branchId must be "all" or a branch of this salon.',
      );
    }
  }

  if ('days' in body) {
    const v = body.days;
    if (!Array.isArray(v) || v.length === 0) {
      throw badRequest('invalid_days', 'days must be a non-empty array of 0-6, Sunday first.');
    }
    if (!v.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
      throw badRequest('invalid_days', 'days must contain whole numbers 0-6, 0 being Sunday.');
    }
    // Deduplicated and sorted before storage. `days.includes(now.getDay())` does
    // not care, but a stored `[1,1,1]` would render as three Mondays in the
    // dashboard's day picker.
    out.days = [...new Set(v as number[])].sort((a, b) => a - b);
  }

  if ('from' in body) {
    if (typeof body.from !== 'string' || !HHMM.test(body.from)) {
      throw badRequest('invalid_window', 'from must be a 24-hour time like "16:00".');
    }
    out.from = body.from;
  }
  if ('to' in body) {
    if (typeof body.to !== 'string' || !HHMM_OR_END_OF_DAY.test(body.to)) {
      throw badRequest(
        'invalid_window',
        'to must be a 24-hour time like "18:00", or "24:00" for the end of the day.',
      );
    }
    out.to = body.to;
  }

  if ('reward' in body) {
    if (typeof body.reward !== 'string' || !(REWARD_KEYS as readonly string[]).includes(body.reward)) {
      throw badRequest('invalid_reward', `reward must be one of ${REWARD_KEYS.join(', ')}.`);
    }
    out.reward = body.reward;
  }

  if ('on' in body) {
    if (typeof body.on !== 'boolean') throw badRequest('invalid_request', 'on must be true or false.');
    out.on = body.on;
  }
  if ('notify' in body) {
    if (typeof body.notify !== 'boolean') {
      throw badRequest('invalid_request', 'notify must be true or false.');
    }
    out.notify = body.notify;
  }

  if (out.days.length === 0 || out.from === '' || out.to === '' || out.reward === '') {
    throw badRequest(
      'invalid_request',
      'A happy hour needs days, from, to and reward.',
    );
  }

  /**
   * THE MIDNIGHT RULE, refused at the door as well as in the CHECK.
   *
   * The database would refuse `to <= from` with a constraint violation, which
   * reaches a merchant as a 500. She gets the workaround instead, because it is
   * a real one and it costs her nothing: `isHappyHourLive` — the SHARED
   * predicate both clients import — evaluates `from <= now < to` and is empty
   * when `to <= from`, so a wrapping window stored here would be applied by this
   * server and rendered as dead by every client. That disagreement is exactly
   * what the no-`live`-flag design exists to prevent.
   */
  if (out.to <= out.from) {
    throw badRequest(
      'window_crosses_midnight',
      `A happy hour cannot run from ${out.from} to ${out.to} — it has to end after it starts, on the same day. For a window that crosses midnight, add two: ${out.from}–24:00 on the day it starts, and 00:00–${out.to} on the day after.`,
    );
  }

  return out;
}

export async function registerPlatformRoutes(app: FastifyInstance): Promise<void> {
  /**
   * ONE source of truth — the wallet and the dashboard read this same object.
   *
   * Readable by any authenticated principal of the salon, and that is the point:
   * "the customer wallet and the merchant dashboard read the same object. Never
   * duplicate boost or happy-hour values in a client." The wallet's "2× visits"
   * chip and the dashboard's stepper are two views of one row.
   *
   * There is no `live` flag, no `minutesRemaining`, no `isLive`. The response
   * carries days/from/to and the salon's `timezone`, and every reader resolves
   * the predicate itself, every second, with no push and no poll. See the file
   * header and db/schema/promotion.ts.
   */
  app.get<{ Params: { id: string } }>('/v1/salons/:id/promotions', async (req, reply) => {
    const p = requirePrincipal(req);
    requireSameSalon(p, req.params.id);
    return reply.send(await readPromotionSet(db, req.params.id));
  });

  /**
   * perms.marketing. Boosts publish as a SET, in one transaction.
   *
   * A PUT, not a PATCH, because the dashboard's screen is the whole grid: a
   * merchant who clears Salmiya's boost and saves has sent one branch, and a
   * merge would leave the old value standing. Branches absent from the body are
   * therefore reset to neutral (1/0/1) rather than left alone.
   */
  app.put<{ Params: { id: string } }>('/v1/salons/:id/promotions/boosts', async (req, reply) => {
    const p = requireDashboardPerm(req, 'marketing');
    requireSameSalon(p, req.params.id);

    const body = (req.body ?? {}) as Record<string, unknown>;
    const boosts = body.boosts;
    if (typeof boosts !== 'object' || boosts === null || Array.isArray(boosts)) {
      throw badRequest('invalid_request', 'boosts must be an object keyed by branch id.');
    }

    const known = await branchIdsOf(req.params.id);
    const parsed: Array<{ branchId: string; visit: number; topup: number; stamp: number }> = [];

    for (const [branchId, raw] of Object.entries(boosts as Record<string, unknown>)) {
      if (!known.has(branchId)) {
        throw badRequest('invalid_branch', `${branchId} is not a branch of this salon.`);
      }
      const v = (raw ?? {}) as Record<string, unknown>;
      const visit = v.visit ?? 1;
      const topup = v.topup ?? 0;
      const stamp = v.stamp ?? 1;
      // Bounds enforced here AND by the CHECK. Non-negotiable #7: the stepper
      // stopping at 3 is a courtesy; a hand-rolled PUT of `visit: 50` would
      // multiply a customer's loyalty standing by fifty.
      if (!Number.isInteger(visit) || (visit as number) < 1 || (visit as number) > 3) {
        throw badRequest('invalid_boost', `${branchId}: visit must be a whole number 1-3.`);
      }
      if (!Number.isInteger(topup) || (topup as number) < 0 || (topup as number) > 30) {
        throw badRequest('invalid_boost', `${branchId}: topup must be a whole number 0-30.`);
      }
      if (!Number.isInteger(stamp) || (stamp as number) < 1 || (stamp as number) > 3) {
        throw badRequest('invalid_boost', `${branchId}: stamp must be a whole number 1-3.`);
      }
      parsed.push({
        branchId,
        visit: visit as number,
        topup: topup as number,
        stamp: stamp as number,
      });
    }

    const now = new Date();
    await db.transaction(async (tx) => {
      // Every branch of the salon, so a branch the body omitted is reset rather
      // than left holding a boost the merchant thinks she removed. One
      // `published_at` across the set: it published as a unit.
      for (const branchId of known) {
        const next = parsed.find((x) => x.branchId === branchId) ?? {
          branchId,
          visit: 1,
          topup: 0,
          stamp: 1,
        };
        await tx
          .insert(boost)
          .values({
            salonId: req.params.id,
            branchId,
            visit: next.visit,
            topup: next.topup,
            stamp: next.stamp,
            publishedAt: now,
            publishedBy: p.name,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [boost.salonId, boost.branchId],
            set: {
              visit: next.visit,
              topup: next.topup,
              stamp: next.stamp,
              publishedAt: now,
              publishedBy: p.name,
              updatedAt: now,
            },
          });
      }

      await writeAudit(tx, p, {
        salonId: p.salonId,
        kind: 'rules',
        action: 'Boosts published',
        detail: parsed.length
          ? parsed.map((b) => `${b.branchId}: ${b.visit}× visits, +${b.topup}% top-ups, ${b.stamp}× stamps`).join(' · ')
          : 'All branches reset to no boost',
        source: 'merchant',
        subjectType: 'salon',
        subjectId: req.params.id,
        metadata: { boosts: parsed },
        ipAddress: req.ip ?? null,
        userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      });
    });

    return reply.send(await readPromotionSet(db, req.params.id));
  });

  /** perms.marketing. A new window. */
  app.post<{ Params: { id: string } }>(
    '/v1/salons/:id/promotions/happy-hours',
    async (req, reply) => {
      const p = requireDashboardPerm(req, 'marketing');
      requireSameSalon(p, req.params.id);

      const fields = await parseWindow(
        (req.body ?? {}) as Record<string, unknown>,
        req.params.id,
        null,
      );

      const id = happyHourId();
      const [row] = await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(happyHour)
          .values({ id, salonId: req.params.id, ...fields })
          .returning();

        await writeAudit(tx, p, {
          salonId: p.salonId,
          kind: 'rules',
          action: 'Happy hour added',
          detail: `${fields.from}–${fields.to}, ${fields.reward}, ${fields.branchId ?? 'all branches'}`,
          source: 'merchant',
          subjectType: 'happy_hour',
          subjectId: id,
          metadata: { ...fields },
          ipAddress: req.ip ?? null,
          userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
        });
        return inserted;
      });

      if (!row) throw conflict('happy_hour_not_created', 'That happy hour could not be created.');
      return reply.code(201).send(serialiseHappyHour(row));
    },
  );

  /** perms.marketing. Edit a window — including switching it off. */
  app.patch<{ Params: { id: string; hid: string } }>(
    '/v1/salons/:id/promotions/happy-hours/:hid',
    async (req, reply) => {
      const p = requireDashboardPerm(req, 'marketing');
      requireSameSalon(p, req.params.id);

      const rows = await db
        .select()
        .from(happyHour)
        .where(and(eq(happyHour.id, req.params.hid), eq(happyHour.salonId, req.params.id)))
        .limit(1);
      const current = rows[0];
      if (!current) throw notFound('unknown_happy_hour', 'No such happy hour.');

      const fields = await parseWindow(
        (req.body ?? {}) as Record<string, unknown>,
        req.params.id,
        {
          branchId: current.branchId,
          days: [...current.days],
          from: current.from,
          to: current.to,
          reward: current.reward,
          on: current.on,
          notify: current.notify,
        },
      );

      const [row] = await db.transaction(async (tx) => {
        const updated = await tx
          .update(happyHour)
          .set({ ...fields, updatedAt: new Date() })
          .where(eq(happyHour.id, req.params.hid))
          .returning();

        await writeAudit(tx, p, {
          salonId: p.salonId,
          kind: 'rules',
          action: current.on && !fields.on ? 'Happy hour switched off' : 'Happy hour changed',
          detail: `${fields.from}–${fields.to}, ${fields.reward}, ${fields.branchId ?? 'all branches'}`,
          source: 'merchant',
          subjectType: 'happy_hour',
          subjectId: req.params.hid,
          metadata: { before: { ...current, days: [...current.days] }, after: fields },
          ipAddress: req.ip ?? null,
          userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
        });
        return updated;
      });

      if (!row) throw notFound('unknown_happy_hour', 'No such happy hour.');
      return reply.send(serialiseHappyHour(row));
    },
  );

  /**
   * perms.marketing. Delete a window that has never paid out.
   *
   * A window that HAS paid out is refused, with the alternative named.
   * `transaction.promotion_id` is `ON DELETE restrict`, so the database would
   * refuse anyway — but as a foreign key violation, which reaches the merchant
   * as a 500. Asked first so she gets a sentence. The record of what a promotion
   * paid must outlive the merchant's interest in running it: a reconciliation
   * report with a dangling id in it is worse than a switch left in the off
   * position.
   */
  app.delete<{ Params: { id: string; hid: string } }>(
    '/v1/salons/:id/promotions/happy-hours/:hid',
    async (req, reply) => {
      const p = requireDashboardPerm(req, 'marketing');
      requireSameSalon(p, req.params.id);

      const rows = await db
        .select()
        .from(happyHour)
        .where(and(eq(happyHour.id, req.params.hid), eq(happyHour.salonId, req.params.id)))
        .limit(1);
      const current = rows[0];
      if (!current) throw notFound('unknown_happy_hour', 'No such happy hour.');

      if (await hasBeenApplied(db, current.id)) {
        throw conflict(
          'happy_hour_in_use',
          'This happy hour has already been applied to a charge, so it cannot be deleted — the receipts refer to it. Switch it off instead.',
        );
      }

      await db.transaction(async (tx) => {
        await tx.delete(happyHour).where(eq(happyHour.id, current.id));
        await writeAudit(tx, p, {
          salonId: p.salonId,
          kind: 'rules',
          action: 'Happy hour deleted',
          detail: `${current.from}–${current.to}, ${current.reward}`,
          source: 'merchant',
          subjectType: 'happy_hour',
          subjectId: current.id,
          metadata: { deleted: serialiseHappyHour(current) },
          ipAddress: req.ip ?? null,
          userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
        });
      });

      return reply.code(204).send();
    },
  );

  /** perms.marketing. Creates `pending` and nothing else, ever. */
  app.post<{ Params: { id: string } }>('/v1/salons/:id/campaigns', async (req, reply) => {
    const p = requireDashboardPerm(req, 'marketing');
    requireSameSalon(p, req.params.id);

    const body = (req.body ?? {}) as Record<string, unknown>;
    const title = requireString(body.title, 'title', 200);
    const text = requireString(body.body, 'body', 2000);
    const channel = body.channel ?? 'push';
    if (!['push', 'wa', 'both'].includes(String(channel))) {
      throw badRequest('invalid_channel', 'channel must be push, wa or both.');
    }

    const campaign = {
      id: `CMP-${Math.floor(Math.random() * 900 + 100)}`,
      salonId: p.salonId,
      title,
      body: text,
      channel,
      audience: body.audience ?? 'all',
      branchId: body.branchId ?? 'all',
      reward: body.reward ?? 'none',
      // Server-computed, never trusted from the client.
      reach: 0,
      when: body.when ?? 'now',
      scheduledAt: body.scheduledAt ?? '',
      // Hardcoded. A merchant cannot send — non-negotiable #8.
      status: 'pending' as const,
      submittedBy: p.name,
      submittedAt: new Date().toISOString(),
      decidedBy: null,
      decidedAt: null,
      note: null,
      result: null,
    };

    await writeAudit(db, p, {
      salonId: p.salonId,
      kind: 'rules',
      action: 'Campaign submitted',
      detail: `"${title}" submitted for AVO approval`,
      source: 'merchant',
      subjectType: 'campaign',
      subjectId: campaign.id,
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    });

    return reply.send(campaign);
  });
}
