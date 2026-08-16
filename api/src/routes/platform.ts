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

import type { FastifyInstance } from 'fastify';
import { requireDashboardPerm, requirePrincipal, requireSameSalon } from '../auth/principal';
import { badRequest } from '../http/errors';
import { requireString } from '../money/validate';
import { writeAudit } from '../services/audit';
import { db } from '../db/client';

export async function registerPlatformRoutes(app: FastifyInstance): Promise<void> {
  /**
   * ONE source of truth — the wallet and the dashboard read this same object.
   * There is no `live` flag by design; see the file header.
   */
  app.get<{ Params: { id: string } }>('/v1/salons/:id/promotions', async (req, reply) => {
    const p = requirePrincipal(req);
    requireSameSalon(p, req.params.id);

    // Promotions are not yet persisted — phase 3 of build-plan.md. The shape is
    // served so lanes B and C are not blocked, and it carries the predicate
    // inputs rather than a precomputed boolean.
    return reply.send({
      boosts: {},
      boostsPublishedAt: null,
      boostsPublishedBy: null,
      happy: [],
    });
  });

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
