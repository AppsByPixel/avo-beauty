/**
 * Campaigns — both ends of non-negotiable #8.
 *
 *   POST   /v1/salons/{id}/campaigns              perms.marketing — creates `pending`
 *   GET    /v1/salons/{id}/campaigns              perms.marketing — her own, with notes
 *   DELETE /v1/salons/{id}/campaigns/{cid}        perms.marketing — withdraw, pending only
 *   GET    /v1/platform/campaigns?status=          console, `approvals`
 *   POST   /v1/platform/campaigns/{cid}/decision  console, `approvals` — release or reject
 *   GET    /v1/platform/messaging-policy          console, `approvals`
 *   PATCH  /v1/platform/messaging-policy          console, `approvals`
 *
 * "A merchant cannot send a customer message. `POST /campaigns` only creates
 * `pending`. Delivery happens on the platform decision endpoint, and caps and
 * quiet hours are enforced again at send time."
 *
 * MOVED OUT OF routes/platform.ts, which was 807 lines of promotions, policies,
 * support and one campaign handler that did not persist anything. The campaign
 * half is now most of a phase on its own.
 *
 * THE THROTTLE LIVES UNDER `approvals`, NOT `controls`, and that is the design's
 * layout rather than a guess: `AVO Owner Console.dc.html` draws the "Platform
 * throttle" card INSIDE the Approvals screen, beside the queue it governs. A
 * reviewer deciding a campaign needs to see the cap she is deciding against.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/client';
import {
  campaign,
  platformMessagingPolicy,
  CAMPAIGN_AUDIENCES,
  CAMPAIGN_CHANNELS,
  CAMPAIGN_STATUSES,
  CAMPAIGN_WHENS,
  type CampaignRow,
  type CampaignStatus,
} from '../db/schema/campaign';
import { REWARD_KEYS } from '../db/schema/promotion';
import { branch, salon } from '../db/schema/salon';
import { requireDashboardPerm, requirePlatform, requireSameSalon } from '../auth/principal';
import { badRequest, conflict, notFound } from '../http/errors';
import { requireString } from '../money/validate';
import { writeAudit } from '../services/audit';
import {
  computeReach,
  deliverCampaign,
  readMessagingPolicy,
  requireWithdrawable,
} from '../services/campaign';

/**
 * `CampaignSchema` on the wire — TWENTY-ONE FIELDS, INCLUDING THE HOLD.
 *
 * THIS COMMENT USED TO SAY THE OPPOSITE, AND THAT IS THE FINDING.
 *
 * It read "`heldReason` IS NOT ON IT … emitting one would be a field the contract
 * silently deletes in transit", and it was true when written: `CampaignSchema` had
 * no such field, Zod strips what it does not declare, and the merchant learned of a
 * hold from the `campaign_held` notification instead. The paragraph ended by
 * reporting the gap upward, because widening a trunk-owned schema is not this
 * lane's to do.
 *
 * Trunk then widened it — `96fef6b`, "a held campaign carries its reason, because #8
 * owes the merchant a sentence" — and the serialiser was not changed with it. So the
 * premise evaporated and the conclusion stayed, and for a while this file carried a
 * written, confident justification for NOT doing the thing the contract now requires.
 * That is worse than an out-of-date comment: a reader checking whether the omission
 * was deliberate would have found a paragraph saying yes.
 *
 * The consequence was live. `serialiseCampaign` returned nineteen fields against a
 * twenty-one-field schema, `CampaignSchema.parse()` failed on two required-and-
 * nullable keys, and `GET /v1/platform/campaigns` — the owner console's HOME SCREEN
 * — rendered its error state. Lane C refused to default them to null and was right
 * to: `heldReason: null` on a campaign that IS held renders it as sent, which is
 * exactly the outcome non-negotiable #8 exists to prevent. It reported a
 * money-adjacent safety property rather than papering over it.
 *
 * BOTH FIELDS ARE REQUIRED AND NULLABLE, which is the same shape as `voidedAt` on a
 * transaction and carries the same meaning: `null` is a POSITIVE statement — this
 * campaign was never held — rather than an absence of information. A client can tell
 * "not held" from "this API is too old to say". Omitting them is what broke the
 * parse; sending null when a hold exists is what would break the merchant.
 *
 * `salon` is the salon NAME — the contract carries it beside `salonId` so the
 * console's queue can render a salon rather than an id. `branchId` spells NULL as
 * `"all"`, the same sentinel `serialiseHappyHour` uses. `scheduledAt` spells NULL
 * as `""`, which is what the contract's `z.string()` on that field means.
 */
function serialiseCampaign(row: CampaignRow, salonName: string) {
  return {
    id: row.id,
    salonId: row.salonId,
    salon: salonName,
    title: row.title,
    body: row.body,
    channel: row.channel,
    audience: row.audience,
    branchId: row.branchId ?? 'all',
    reward: row.reward,
    reach: row.reach,
    when: row.sendWhen,
    scheduledAt: row.scheduledAt ? row.scheduledAt.toISOString() : '',
    status: row.status,
    /**
     * The hold. `services/campaign.ts` writes both, `campaign_hold_is_complete`
     * enforces that they arrive together, and `campaign_hold_requires_approved`
     * enforces that only an approved campaign can carry one — so a non-null pair
     * here always means "AVO released it and the platform has not sent it", which
     * is the sentence #8 owes the merchant.
     */
    heldReason: row.heldReason,
    heldAt: row.heldAt ? row.heldAt.toISOString() : null,
    submittedBy: row.submittedBy,
    submittedAt: row.submittedAt.toISOString(),
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    note: row.note,
    result: row.result,
  };
}

/**
 * 'CMP-10000'. FROM A SEQUENCE, NOT `Math.random()` — migration 0051 carries the
 * whole argument, and the short version is that this used to be
 * `CMP-${Math.floor(Math.random() * 9000 + 1000)}`, which is a PRIMARY KEY drawn
 * from 9000 values with no uniqueness check and no retry. A duplicate is an
 * unhandled 23505 that the merchant reads as a 500 `server_error`, and over 9000
 * values the chance of one passes 50% at 112 campaigns — a full `e2e/` run found
 * it, intermittently, which is the worst way to find it.
 *
 * SQL RATHER THAN A JS ROUND TRIP, so the id is minted inside the INSERT that uses
 * it. A `SELECT nextval` followed by an `INSERT` is two statements a reader has to
 * be told are safe to separate; this is one that cannot be got wrong. The caller
 * reads the id back off `.returning()` rather than holding a copy.
 *
 * EXPORTED FOR `mintedIds.int.test.ts`, which mints a thousand of these against
 * the real primary key. That spec imports this expression rather than retyping
 * it — a copy would stay green on the day this line went back to `random()`.
 */
export const campaignId = sql`'CMP-' || nextval('campaign_number_seq')::text`;

function parseStatuses(raw: unknown): CampaignStatus[] | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') throw badRequest('invalid_status', 'status must be a string.');
  const wanted = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = wanted.filter((s) => !(CAMPAIGN_STATUSES as readonly string[]).includes(s));
  if (unknown.length > 0) {
    throw badRequest(
      'invalid_status',
      `Unknown campaign status: ${unknown.join(', ')}. One of ${CAMPAIGN_STATUSES.join(', ')}.`,
    );
  }
  return wanted as CampaignStatus[];
}

export async function registerCampaignRoutes(app: FastifyInstance): Promise<void> {
  // ============================================================ the merchant ==

  /**
   * perms.marketing. Creates `pending` and nothing else, ever — AND NOW ACTUALLY
   * PERSISTS IT.
   *
   * The previous version built an object literal, wrote an audit row, and returned
   * the literal. So the `status: 'pending'` it hardcoded so carefully was true of a
   * value that lived for one HTTP response: #8's first half held only because
   * there was no second half, since nothing could send what was never stored.
   *
   * `status` AND `reach` ARE STILL IGNORED RATHER THAN REFUSED, which the previous
   * version got right and this keeps. Neither is the client's to have an opinion
   * about, so there is nothing to negotiate over — the same treatment
   * `POST /v1/support/tickets` gives a client-supplied `route`. A PRICE would be
   * refused by name (see `POST /orders`); the difference is that a client sending a
   * price believed it was setting something it might act on, and a client sending
   * `status: 'sent'` is simply confused about whose decision that is.
   */
  app.post<{ Params: { id: string } }>('/v1/salons/:id/campaigns', async (req, reply) => {
    const p = requireDashboardPerm(req, 'marketing');
    requireSameSalon(p, req.params.id);

    const body = (req.body ?? {}) as Record<string, unknown>;
    const title = requireString(body.title, 'title', 200);
    const text = requireString(body.body, 'body', 2000);

    const channel = String(body.channel ?? 'push');
    if (!(CAMPAIGN_CHANNELS as readonly string[]).includes(channel)) {
      throw badRequest('invalid_channel', `channel must be one of ${CAMPAIGN_CHANNELS.join(', ')}.`);
    }
    const audience = String(body.audience ?? 'all');
    if (!(CAMPAIGN_AUDIENCES as readonly string[]).includes(audience)) {
      throw badRequest(
        'invalid_audience',
        `audience must be one of ${CAMPAIGN_AUDIENCES.join(', ')}.`,
      );
    }
    const sendWhen = String(body.when ?? 'now');
    if (!(CAMPAIGN_WHENS as readonly string[]).includes(sendWhen)) {
      throw badRequest('invalid_when', `when must be one of ${CAMPAIGN_WHENS.join(', ')}.`);
    }
    const reward = String(body.reward ?? 'none');
    if (reward !== 'none' && !(REWARD_KEYS as readonly string[]).includes(reward)) {
      throw badRequest(
        'invalid_reward',
        `reward must be none or one of ${REWARD_KEYS.join(', ')}.`,
      );
    }

    /**
     * `branchId: "all"` is the wire's sentinel for NULL and the only value that is
     * not a real id. Anything else is CHECKED AGAINST THIS SALON — a campaign
     * scoped to another salon's branch would be a tenancy leak wearing a marketing
     * form, and the foreign key alone would answer with a 500.
     */
    const rawBranch = body.branchId ?? 'all';
    let branchId: string | null = null;
    if (rawBranch !== 'all') {
      const wanted = requireString(rawBranch, 'branchId', 100);
      const [own] = await db
        .select({ id: branch.id })
        .from(branch)
        .where(and(eq(branch.id, wanted), eq(branch.salonId, p.salonId)))
        .limit(1);
      // 404 rather than 403: a 403 would confirm the id names a real branch
      // somewhere else, which is the tenancy leak in miniature.
      if (!own) throw notFound('unknown_branch', 'No such branch.');
      branchId = own.id;
    }

    /**
     * `later` NEEDS A MOMENT AND THE OTHER TWO MUST NOT CARRY ONE —
     * `campaign_scheduled_at_matches_when` says so as an equivalence, so the
     * boundary says it too rather than letting a constraint violation reach a
     * merchant as a 500. The design's quiet-hours flag reads `scheduledAt` only for
     * `later`, and a `now` campaign carrying one would make that flag lie.
     */
    let scheduledAt: Date | null = null;
    if (sendWhen === 'later') {
      const raw = requireString(body.scheduledAt, 'scheduledAt', 40);
      const parsed = new Date(raw);
      if (Number.isNaN(parsed.getTime())) {
        throw badRequest('invalid_scheduled_at', 'scheduledAt must be an ISO 8601 instant.');
      }
      scheduledAt = parsed;
    } else if (body.scheduledAt !== undefined && body.scheduledAt !== '') {
      throw badRequest(
        'scheduled_at_not_allowed',
        'Only a "later" campaign carries a scheduledAt.',
      );
    }

    const now = new Date();
    /**
     * SERVER-COMPUTED, and the contract marks this field so on the field itself.
     * Computed at SUBMISSION and never recomputed on read: the number a reviewer
     * approves against must not change under her while she reads the queue.
     */
    const reach = await computeReach(db, { salonId: p.salonId, audience: audience as never, now });

    const [row] = await db
      .insert(campaign)
      .values({
        id: campaignId,
        salonId: p.salonId,
        title,
        body: text,
        channel,
        audience: audience as never,
        branchId,
        reward,
        reach,
        sendWhen,
        scheduledAt,
        // Hardcoded. A merchant cannot send — non-negotiable #8. It is also the
        // column default, and both are deliberate: a future insert path that
        // forgets the field gets `pending` rather than whatever it meant to say.
        status: 'pending',
        submittedBy: p.name,
        submittedAt: now,
      })
      .returning();
    if (!row) throw conflict('campaign_not_created', 'That campaign could not be saved. Try again.');

    await writeAudit(db, p, {
      salonId: p.salonId,
      kind: 'rules',
      action: 'Campaign submitted',
      detail: `"${title}" submitted for AVO approval · ${audience} · ${reach} people`,
      source: 'merchant',
      subjectType: 'campaign',
      subjectId: row.id,
      metadata: { audience, reach, channel, when: sendWhen, reward },
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    });

    const [s] = await db
      .select({ name: salon.name })
      .from(salon)
      .where(eq(salon.id, p.salonId))
      .limit(1);
    return reply.code(201).send(serialiseCampaign(row, s?.name ?? ''));
  });

  /**
   * Her own campaigns, with AVO's notes. Marketing → Campaigns renders the list
   * and, under a rejected one, the reason verbatim.
   *
   * SALON-SCOPED IN THE WHERE. A merchant reads her own and cannot address anybody
   * else's — there is no id in this path that would let her try.
   */
  app.get<{ Params: { id: string }; Querystring: { status?: string } }>(
    '/v1/salons/:id/campaigns',
    async (req, reply) => {
      const p = requireDashboardPerm(req, 'marketing');
      requireSameSalon(p, req.params.id);

      const wanted = parseStatuses(req.query?.status);
      const rows = await db
        .select()
        .from(campaign)
        .where(
          wanted
            ? and(eq(campaign.salonId, p.salonId), inArray(campaign.status, wanted))
            : eq(campaign.salonId, p.salonId),
        )
        .orderBy(desc(campaign.submittedAt))
        .limit(200);

      const [s] = await db
        .select({ name: salon.name })
        .from(salon)
        .where(eq(salon.id, p.salonId))
        .limit(1);

      return reply.send({
        items: rows.map((r) => serialiseCampaign(r, s?.name ?? '')),
        nextCursor: null,
      });
    },
  );

  /**
   * Withdraw. "Merchant withdraw, pending only" — api-contract.md, and "Withdraw
   * is allowed while pending and nowhere else."
   *
   * A WITHDRAWN CAMPAIGN IS DELETED, not moved to a status, and that is the one
   * place this file removes a row. `CampaignSchema` has four statuses and none of
   * them is "withdrawn", so there is nothing to move it to; and a pending campaign
   * has never been decided, never reached a customer, and has no `campaign_send`
   * rows referencing it. The audit row is what survives — "Campaign withdrawn",
   * with the title — which is the record that matters, since the thing being
   * removed is a draft AVO never saw.
   *
   * NO IDEMPOTENCY KEY, for the reason `DELETE /bookings/{id}` has none: a DELETE
   * names one resource with one live state. A second withdraw of the same campaign
   * finds no pending row and answers 404, which is true.
   */
  app.delete<{ Params: { id: string; cid: string } }>(
    '/v1/salons/:id/campaigns/:cid',
    async (req, reply) => {
      const p = requireDashboardPerm(req, 'marketing');
      requireSameSalon(p, req.params.id);

      // Scoped in the WHERE, so another salon's campaign is not confirmable to
      // exist and cannot be withdrawn.
      const [row] = await db
        .select()
        .from(campaign)
        .where(and(eq(campaign.id, req.params.cid), eq(campaign.salonId, p.salonId)))
        .limit(1);
      if (!row) throw notFound('unknown_campaign', 'No such campaign.');
      // Names WHY, rather than a flat 409: "AVO already decided" and "already
      // rejected" send the merchant to two different places.
      requireWithdrawable(row);

      await db.delete(campaign).where(eq(campaign.id, row.id));

      await writeAudit(db, p, {
        salonId: p.salonId,
        kind: 'rules',
        action: 'Campaign withdrawn',
        detail: `"${row.title}" withdrawn before AVO decided`,
        source: 'merchant',
        subjectType: 'campaign',
        subjectId: row.id,
        metadata: { title: row.title, audience: row.audience, reach: row.reach },
        ipAddress: req.ip ?? null,
        userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      });

      return reply.code(204).send();
    },
  );

  // ============================================================ the console ==

  /**
   * The queue. `GET /v1/platform/campaigns?status=pending` — the console's
   * Approvals screen, and the only endpoint lane C could point at a mock for.
   *
   * ACROSS EVERY SALON, with no `requireSameSalon` anywhere, which is the whole
   * reason the platform principal exists. The salon NAME is joined in because the
   * queue renders a salon per card and `CampaignSchema` carries `salon` beside
   * `salonId` for exactly that.
   *
   * OLDEST FIRST when filtering to pending — the design prints "N waiting · oldest
   * 6 hr ago", so the oldest is the one it names, and a queue is worked from the
   * front. Newest first otherwise, because the Decided list is history.
   */
  app.get<{ Querystring: { status?: string } }>('/v1/platform/campaigns', async (req, reply) => {
    requirePlatform(req, 'approvals');

    const wanted = parseStatuses(req.query?.status);
    const onlyPending = wanted?.length === 1 && wanted[0] === 'pending';

    const rows = await db
      .select({ c: campaign, salonName: salon.name })
      .from(campaign)
      .innerJoin(salon, eq(salon.id, campaign.salonId))
      .where(wanted ? inArray(campaign.status, wanted) : undefined)
      .orderBy(onlyPending ? campaign.submittedAt : desc(campaign.submittedAt))
      .limit(200);

    return reply.send({
      items: rows.map((r) => serialiseCampaign(r.c, r.salonName)),
      nextCursor: null,
    });
  });

  /**
   * THE DECISION ENDPOINT. `POST /v1/platform/campaigns/{cid}/decision
   * { status, note }`.
   *
   * This is where #8's second half lives: "Delivery happens on the platform
   * decision endpoint, and caps and quiet hours are enforced again at send time."
   *
   * ONE TRANSACTION. The decision, the send rows, the campaign's status and the
   * audit row commit together, so there is no state in which AVO released a
   * campaign and the platform has no record of what it did with it. The policy is
   * read INSIDE it, so an owner who tightens a cap while a release is in flight
   * has the new cap applied — the same reasoning `loadPromotionInputs` carries.
   *
   * A REJECTION MUST CARRY A NOTE. Refused here by name, and refused again by
   * `campaign_rejection_has_note` in the database, so a future second decision path
   * cannot forget it. "The merchant sees this" is what the design's textarea
   * placeholder says, and a rejection with no reason is a merchant with no next
   * move.
   *
   * A CAMPAIGN CAN ONLY BE DECIDED ONCE, and the read is inside the transaction
   * `FOR UPDATE` so two reviewers pressing Approve and Reject at the same moment
   * cannot both win. The loser is told the campaign was already decided and by
   * whom — the `already_voided` lesson from routes/charges.ts: a permanent state
   * reported as transient invites a third attempt and hides what happened.
   *
   * `later` AND `recurring` DO NOT SEND NOW. Approving a scheduled campaign
   * releases it; delivery happens at its moment, through `releaseHeldCampaigns`.
   * The design says the same on its own release note — "Releases automatically at
   * Sun 10:00" versus "Queued for delivery within a minute of approval".
   */
  app.post<{ Params: { cid: string } }>(
    '/v1/platform/campaigns/:cid/decision',
    async (req, reply) => {
      const p = requirePlatform(req, 'approvals');

      const body = (req.body ?? {}) as Record<string, unknown>;
      const status = body.status;
      if (status !== 'approved' && status !== 'rejected') {
        throw badRequest(
          'invalid_decision',
          'status must be approved or rejected. Only the platform sends, and only after a decision.',
        );
      }
      const note =
        typeof body.note === 'string' && body.note.trim() !== '' ? body.note.trim() : null;
      if (status === 'rejected' && !note) {
        throw badRequest(
          'note_required',
          'A rejection carries a reason. The merchant sees it verbatim under the campaign.',
        );
      }

      const now = new Date();

      const result = await db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(campaign)
          .where(eq(campaign.id, req.params.cid))
          .for('update')
          .limit(1);
        if (!row) throw notFound('unknown_campaign', 'No such campaign.');

        if (row.status !== 'pending') {
          throw conflict(
            'campaign_already_decided',
            `That campaign was already ${row.status}${row.decidedBy ? ` by ${row.decidedBy}` : ''}.`,
          );
        }

        const [decided] = await tx
          .update(campaign)
          .set({ status, note, decidedBy: p.name, decidedAt: now, updatedAt: now })
          .where(eq(campaign.id, row.id))
          .returning();
        if (!decided) throw conflict('campaign_not_decided', 'That decision could not be saved.');

        if (status === 'rejected') {
          await writeAudit(tx, p, {
            salonId: row.salonId,
            kind: 'rules',
            action: 'Campaign rejected',
            detail: `"${row.title}" rejected · ${note}`,
            source: 'owner_console',
            subjectType: 'campaign',
            subjectId: row.id,
            metadata: { note },
          });
          return { campaign: decided, delivery: null };
        }

        /**
         * APPROVED. A `now` campaign is being released this second, so this IS
         * send time and the caps apply here. A `later` or `recurring` one is
         * released to be delivered later, so its send-time check happens then —
         * and it is checked THEN rather than now, which is the whole point of #8's
         * "again at send time": a cap that was clear at approval can be full by
         * the scheduled hour.
         */
        if (row.sendWhen !== 'now') {
          await writeAudit(tx, p, {
            salonId: row.salonId,
            kind: 'rules',
            action: 'Campaign approved',
            detail:
              `"${row.title}" approved · ` +
              (row.sendWhen === 'later'
                ? `releases at ${row.scheduledAt?.toISOString() ?? 'its scheduled time'}`
                : 'releases on its recurring trigger') +
              ' · caps and quiet hours are checked again at send',
            source: 'owner_console',
            subjectType: 'campaign',
            subjectId: row.id,
            metadata: { note, when: row.sendWhen },
          });
          return { campaign: decided, delivery: null };
        }

        const delivery = await deliverCampaign(tx, decided, { actor: p, now });
        const [after] = await tx
          .select()
          .from(campaign)
          .where(eq(campaign.id, row.id))
          .limit(1);
        return { campaign: after ?? decided, delivery };
      });

      const [s] = await db
        .select({ name: salon.name })
        .from(salon)
        .where(eq(salon.id, result.campaign.salonId))
        .limit(1);

      /**
       * The campaign, plus what delivery did. `delivery` is NOT part of
       * `CampaignSchema` — it is a sibling key on the response envelope rather than
       * a field on the campaign, so a client parsing `body.campaign` with the
       * contract's schema gets exactly the contract's shape and nothing is
       * stripped. The console needs it to say "released · 612 reached" or "approved
       * but held until 09:00" on the row it just acted on.
       */
      return reply.send({
        campaign: serialiseCampaign(result.campaign, s?.name ?? ''),
        delivery: result.delivery,
      });
    },
  );

  // ------------------------------------------------------- the throttle --

  /**
   * `GET` / `PATCH /v1/platform/messaging-policy`.
   *
   * "A merchant can never read or raise these values" — api-contract.md, and it is
   * structural rather than a gate to remember: `platform_messaging_policy` has no
   * salon column, so there is nothing a salon-scoped route could select, and both
   * verbs are behind `requirePlatform`.
   *
   * NOT IN api-contract.md AS AN ENDPOINT — the entity is declared and no route is.
   * `PATCH /v1/platform/messaging-policy` is lane C's own naming from its blocking
   * list, adopted rather than invented, so the console and the API agree without a
   * round trip. Reported as a contract addition.
   *
   * THE RANGES ARE CHECKED HERE AND IN THE DATABASE. The design's steppers clamp to
   * 1..7 and 1..30; the CHECKs refuse anything else; and this refuses it by name so
   * a console bug gets a sentence instead of a 500.
   */
  app.get('/v1/platform/messaging-policy', async (req, reply) => {
    requirePlatform(req, 'approvals');
    return reply.send(await readMessagingPolicy(db));
  });

  /**
   * THE MERCHANT'S READ-ONLY VIEW OF THE SAME POLICY — and it resolves a genuine
   * deadlock rather than relaxing a rule.
   *
   * `AVO Merchant Dashboard.dc.html:1929` tells the merchant, verbatim:
   *
   *   "Quiet hours are respected — nothing leaves between 22:00 and 09:00. A
   *    person gets at most two marketing messages a week."
   *
   * Three numbers, printed as fact, on a screen a merchant acts on. And
   * api-contract.md § PlatformMessagingPolicy says "A merchant can never read or
   * raise these values." Both cannot hold: settled copy may not be paraphrased
   * (CLAUDE.md), and a hardcoded 22:00 in a dashboard is a number that silently
   * becomes a lie the first time the console changes it. Lane C found the conflict
   * and correctly refused to resolve it alone.
   *
   * TRUNK'S DECISION, IMPLEMENTED HERE: a merchant may READ the effective policy.
   * Quiet hours and caps are constraints she is SUBJECT TO, not secrets; telling a
   * salon when her messages will not send helps her comply, and a number she cannot
   * verify is worse than one she can.
   *
   * THE WRITE STAYS PLATFORM-ONLY, which is what #8 actually protects — "a merchant
   * cannot RAISE its own limits" is the sentence with teeth, and the PATCH above is
   * behind `requirePlatform`. Reading a ceiling is not raising it.
   *
   * SAME SHAPE, SAME SOURCE, ONE FUNCTION. `readMessagingPolicy` serves both, so
   * the merchant's screen and the console's stepper cannot disagree — the rule
   * `readPromotionSet` exists for, one object read by two surfaces.
   *
   * `requireApproval` IS ON IT, and that is deliberate: with approval off her
   * campaign goes out unreviewed, which changes what she should expect after
   * pressing submit. It is a fact about her own workflow, not an internal control.
   *
   * REPORTED: api-contract.md still says a merchant may never read these. Updating
   * it is trunk's — `design/` is outside this lane's column.
   */
  app.get<{ Params: { id: string } }>(
    '/v1/salons/:id/messaging-policy',
    async (req, reply) => {
      // `marketing` — the permission that owns campaigns. A staff member who
      // cannot submit one has no use for the ceiling it is subject to.
      const p = requireDashboardPerm(req, 'marketing');
      requireSameSalon(p, req.params.id);
      return reply.send(await readMessagingPolicy(db));
    },
  );

  app.patch('/v1/platform/messaging-policy', async (req, reply) => {
    const p = requirePlatform(req, 'approvals');

    const body = (req.body ?? {}) as Record<string, unknown>;
    const editable = ['requireApproval', 'weeklyCapPerCustomer', 'monthlyCapPerSalon', 'quietFrom', 'quietTo'];
    const unknown = Object.keys(body).filter((k) => !editable.includes(k));
    if (unknown.length > 0) {
      throw badRequest('invalid_field', `Not editable: ${unknown.join(', ')}.`);
    }

    const patch: Record<string, unknown> = {};

    if ('requireApproval' in body) {
      if (typeof body.requireApproval !== 'boolean') {
        throw badRequest('invalid_require_approval', 'requireApproval must be true or false.');
      }
      patch.requireApproval = body.requireApproval;
    }
    for (const [field, max] of [
      ['weeklyCapPerCustomer', 7],
      ['monthlyCapPerSalon', 30],
    ] as const) {
      if (field in body) {
        const v = body[field];
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > max) {
          throw badRequest('invalid_cap', `${field} must be a whole number from 1 to ${max}.`);
        }
        patch[field] = v;
      }
    }
    for (const field of ['quietFrom', 'quietTo'] as const) {
      if (field in body) {
        const v = requireString(body[field], field, 5);
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) {
          throw badRequest('invalid_quiet_hours', `${field} must be HH:mm, 00:00 to 23:59.`);
        }
        patch[field] = v;
      }
    }
    if (Object.keys(patch).length === 0) {
      throw badRequest('invalid_request', 'Send at least one field to change.');
    }

    const [row] = await db
      .update(platformMessagingPolicy)
      .set({ ...patch, updatedBy: p.name, updatedAt: new Date() })
      .where(eq(platformMessagingPolicy.id, 'avo'))
      .returning();
    if (!row) {
      throw notFound('messaging_policy_missing', 'The platform messaging policy is not configured.');
    }

    /**
     * `salonId: null` — a platform-wide rules change, invisible to every merchant
     * because the audit read's `salon_id = $1` predicate excludes null without
     * anybody having to remember to. The seed's "Commission rates changed" fixture
     * is the same shape.
     *
     * "A merchant can never READ these values", so a row naming the new caps must
     * not land in her log.
     */
    await writeAudit(db, p, {
      salonId: null,
      kind: 'rules',
      action: 'Messaging policy changed',
      detail: Object.entries(patch)
        .map(([k, v]) => `${k} → ${String(v)}`)
        .join(' · '),
      source: 'owner_console',
      subjectType: 'platform',
      subjectId: 'messaging_policy',
      metadata: { changed: patch },
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    });

    return reply.send(await readMessagingPolicy(db));
  });
}
