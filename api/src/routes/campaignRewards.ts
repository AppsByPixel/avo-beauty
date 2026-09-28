/**
 * A reward the salon wrote — the custom options on "Attach a reward".
 * Migration 0064.
 *
 *   GET    /v1/salons/{id}/campaign-rewards              perms.marketing  her saved options
 *   POST   /v1/salons/{id}/campaign-rewards              perms.marketing  save one { label }
 *   DELETE /v1/salons/{id}/campaign-rewards/{rewardId}   perms.marketing  remove (archives)
 *
 * The client asked for merchants to be able to add a custom option to the
 * "Attach a reward" dropdown on Marketing → Campaigns. `POST …/campaigns` then
 * takes `reward: 'custom'` with a `customRewardId` from this list, and the
 * server copies the label onto the campaign (routes/campaigns.ts).
 *
 * A LABEL, NOT AN EFFECT. A campaign's reward has never been applied to
 * anything — happy hours apply theirs through `rewardEffect()`, campaigns do
 * not — and a custom one is a free-text perk the salon honours itself. Nothing
 * here moves money, and no charge, top-up or `rewardEffect` reads this table.
 * Happy hours keep their fixed `REWARD_KEYS` and are untouched.
 *
 * `perms.marketing` ON ALL THREE, because the list exists only to feed the
 * campaign form, and a staff member who cannot submit a campaign has no use for
 * its options — the argument `GET …/messaging-policy` makes for the same gate.
 *
 * `/v1/`, beside `/v1/salons/{id}/campaigns`, which is the resource it serves.
 *
 * NO IDEMPOTENCY KEY. None of these moves money (non-negotiable #4 is
 * money-moving POSTs), and a replayed save meets `duplicate_reward` — the same
 * words cannot be saved twice — so a retry cannot create a second row.
 */

import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { db } from '../db/client';
import {
  campaignReward,
  CAMPAIGN_REWARD_LABEL_MAX,
  CAMPAIGN_REWARD_LIMIT,
  type CampaignRewardRow,
} from '../db/schema/campaign';
import { requireDashboardPerm, requireSameSalon } from '../auth/principal';
import { badRequest, conflict, notFound } from '../http/errors';
import { writeAudit } from '../services/audit';
import { campaignRewardId } from '../services/ids';
import { violatedConstraint } from '../services/idempotency';

/**
 * `CampaignRewardSchema` on the wire — four fields. `createdBy` and
 * `archivedAt` stay in the database: the dropdown needs the words and the id,
 * and only active rows are ever served.
 */
export function serialiseCampaignReward(row: CampaignRewardRow) {
  return {
    id: row.id,
    salonId: row.salonId,
    label: row.label,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Trimmed, 1..60 characters, or 400 `invalid_label`.
 *
 * COUNTED IN CODE POINTS, not UTF-16 units, because that is what
 * `campaign_reward_label_length` counts (`char_length`). `.length` would call a
 * 58-character label with two emoji 60 and one with three 61, and refuse a
 * label the column would have stored.
 */
function parseLabel(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw badRequest('invalid_label', 'Write the reward, up to 60 characters.');
  }
  const label = raw.trim();
  const n = [...label].length;
  if (n === 0) {
    throw badRequest('invalid_label', 'Write the reward, up to 60 characters.');
  }
  if (n > CAMPAIGN_REWARD_LABEL_MAX) {
    throw badRequest(
      'invalid_label',
      `A reward can be up to ${CAMPAIGN_REWARD_LABEL_MAX} characters. This one is ${n}.`,
    );
  }
  return label;
}

const clientMeta = (req: FastifyRequest) => ({
  ipAddress: req.ip ?? null,
  userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
});

const duplicate = () =>
  conflict('duplicate_reward', 'You already have a reward with that name.');

export async function registerCampaignRewardRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Her saved options, active only, OLDEST FIRST — the order she added them,
   * which is the order the dropdown lists them under the fixed rewards.
   * Salon-scoped in the WHERE.
   *
   * `nextCursor: null` IS THE TRUTH HERE, not a capped list claiming it has no
   * more pages (the `GET /salons/{id}/bookings` lesson in routes/salons.ts).
   * There is no LIMIT on this read: the cap is on SAVES — twenty active, held
   * under the advisory lock in the POST below — so every active row is on this
   * one page and there is never a second. It is sent so the reply is the shared
   * `paginated()` envelope every other list answers; without it the contract
   * probe fails `nextCursor: Required`.
   */
  app.get<{ Params: { id: string } }>(
    '/v1/salons/:id/campaign-rewards',
    async (req, reply) => {
      const p = requireDashboardPerm(req, 'marketing');
      requireSameSalon(p, req.params.id);

      const rows = await db
        .select()
        .from(campaignReward)
        .where(and(eq(campaignReward.salonId, p.salonId), isNull(campaignReward.archivedAt)))
        .orderBy(asc(campaignReward.createdAt), asc(campaignReward.id));

      return reply.send({ items: rows.map(serialiseCampaignReward), nextCursor: null });
    },
  );

  /**
   * Save one. `{ label }`, and nothing else is read.
   *
   * THE CAP AND THE DUPLICATE ARE ANSWERED UNDER ONE LOCK. Both are "count what
   * is there, then insert", and two tabs pressing Save at once would each count
   * nineteen and each insert. `pg_advisory_xact_lock` on the salon serialises
   * saves for ONE salon and nothing else; it is not a row lock on `salon`,
   * because charges read that row `FOR SHARE` and must never wait behind a
   * marketing form. The partial unique index is still the last word on a
   * duplicate — the 23505 below is mapped by constraint NAME, not by code, the
   * `violatedConstraint` lesson.
   *
   * DUPLICATE BEFORE CAP: a merchant at twenty retyping one she already has is
   * told it exists, which is the more useful sentence.
   */
  app.post<{ Params: { id: string } }>(
    '/v1/salons/:id/campaign-rewards',
    async (req, reply) => {
      const p = requireDashboardPerm(req, 'marketing');
      requireSameSalon(p, req.params.id);

      const body = (req.body ?? {}) as Record<string, unknown>;
      const label = parseLabel(body.label);

      let row: CampaignRewardRow;
      try {
        row = await db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${`campaign_reward:${p.salonId}`}, 0))`,
          );

          const active = await tx
            .select({ id: campaignReward.id })
            .from(campaignReward)
            .where(and(eq(campaignReward.salonId, p.salonId), isNull(campaignReward.archivedAt)));

          const [same] = await tx
            .select({ id: campaignReward.id })
            .from(campaignReward)
            .where(
              and(
                eq(campaignReward.salonId, p.salonId),
                isNull(campaignReward.archivedAt),
                sql`lower(${campaignReward.label}) = lower(${label})`,
              ),
            )
            .limit(1);
          if (same) throw duplicate();

          if (active.length >= CAMPAIGN_REWARD_LIMIT) {
            throw conflict(
              'reward_limit',
              `You can save up to ${CAMPAIGN_REWARD_LIMIT} rewards. Remove one to add another.`,
              { limit: CAMPAIGN_REWARD_LIMIT },
            );
          }

          const [inserted] = await tx
            .insert(campaignReward)
            .values({ id: campaignRewardId, salonId: p.salonId, label, createdBy: p.name })
            .returning();
          if (!inserted) {
            throw conflict('reward_not_created', 'That reward could not be saved. Try again.');
          }

          // `rules`, not `money`: a label moved nothing.
          await writeAudit(tx, p, {
            salonId: p.salonId,
            kind: 'rules',
            action: 'Campaign reward added',
            detail: `"${label}" added to the campaign rewards`,
            source: 'merchant',
            subjectType: 'campaign_reward',
            subjectId: inserted.id,
            metadata: { label },
            ...clientMeta(req),
          });
          return inserted;
        });
      } catch (err) {
        if (violatedConstraint(err) === 'campaign_reward_active_label_uq') throw duplicate();
        throw err;
      }

      return reply.code(201).send(serialiseCampaignReward(row));
    },
  );

  /**
   * Remove one from the list. ARCHIVES, never deletes: a campaign that used it
   * still names the row (`campaign_custom_reward_same_salon_fk` is `restrict`),
   * and still reads its own snapshot label, so a pending campaign is unchanged.
   *
   * 404 for another salon's id and for one already removed — scoped in the
   * WHERE, so another salon's reward is not confirmable to exist, and a second
   * remove of the same one is told the truth rather than a 204.
   */
  app.delete<{ Params: { id: string; rewardId: string } }>(
    '/v1/salons/:id/campaign-rewards/:rewardId',
    async (req, reply) => {
      const p = requireDashboardPerm(req, 'marketing');
      requireSameSalon(p, req.params.id);

      await db.transaction(async (tx) => {
        const [archived] = await tx
          .update(campaignReward)
          .set({ archivedAt: new Date() })
          .where(
            and(
              eq(campaignReward.id, req.params.rewardId),
              eq(campaignReward.salonId, p.salonId),
              isNull(campaignReward.archivedAt),
            ),
          )
          .returning();
        if (!archived) throw notFound('unknown_reward', 'No such reward.');

        await writeAudit(tx, p, {
          salonId: p.salonId,
          kind: 'rules',
          action: 'Campaign reward removed',
          detail: `"${archived.label}" removed from the campaign rewards · campaigns that used it keep it`,
          source: 'merchant',
          subjectType: 'campaign_reward',
          subjectId: archived.id,
          metadata: { label: archived.label },
          ...clientMeta(req),
        });
      });

      return reply.code(204).send();
    },
  );
}
