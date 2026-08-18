/**
 * Campaigns, the platform messaging policy, and the per-recipient send log.
 *
 * NON-NEGOTIABLE #8 LIVES HERE: "A merchant cannot send a customer message.
 * `POST /campaigns` only creates `pending`. Delivery happens on the platform
 * decision endpoint, and caps and quiet hours are enforced again at send time."
 *
 * WHAT WAS THERE BEFORE THIS TABLE: NOTHING
 * ----------------------------------------
 * `POST /v1/salons/{id}/campaigns` built an object literal, wrote an audit row,
 * and returned the literal. It persisted no campaign at all. The `status:
 * 'pending'` hardcoding it was so careful about was therefore true of a value
 * that existed for the duration of one HTTP response — so #8's first half held
 * only because there was no second half: nothing could send, because nothing was
 * stored. `DELETE .../campaigns/{cid}` (merchant withdraw) and
 * `GET /v1/platform/campaigns` had nothing to address, and the platform decision
 * endpoint had nothing to decide about.
 *
 * THE FOUR STATUSES ARE THE CONTRACT'S FOUR, AND "HELD" IS NOT ONE
 * ---------------------------------------------------------------
 * `CampaignSchema` declares `pending | approved | rejected | sent`. The
 * build-plan says an approved campaign that would breach a cap is "held, not
 * dropped, and reported back to the salon" — which is a state, and it is NOT a
 * fifth status. It is `approved` with `held_reason` set: AVO did release it, and
 * the platform did not send it, and both of those are true at once. Inventing
 * `held` would put a value on the wire that every client's `.parse()` would
 * reject, which is the trap STATUS.md names.
 *
 * `held_reason` IS NOT ON THE WIRE EITHER, and that is a reported gap rather
 * than a decision I am happy with. `CampaignSchema` has no field for it, and Zod
 * STRIPS an undeclared key, so emitting one would be a field the contract
 * silently deletes in transit. The merchant is told through
 * `merchant_notification` — the existing mechanism for exactly this, already used
 * for a disconnected calendar and a no-show — plus an audit row. So the hold is
 * reported, never silently dropped. But the Campaigns screen cannot render it
 * inline until `CampaignSchema` carries it, and widening that is trunk's.
 *
 * WHY `campaign_send` EXISTS
 * -------------------------
 * `weeklyCapPerCustomer` is "a hard cap across ALL salons". That is not
 * answerable from the campaign table: it asks how many campaign messages THIS
 * CUSTOMER has received in the last seven days, from anyone. So delivery writes
 * one row per recipient, and the cap is a COUNT over a window — the same shape
 * as `signup_attempt` and `pin_attempt`, and for the same reason those are tables
 * rather than counters (see migration 0026: "a counter in one Node process is a
 * limit per replica that resets on every deploy").
 *
 * It also makes the cap behave correctly rather than crudely. A per-customer cap
 * is a property of the customer, so it holds back INDIVIDUAL RECIPIENTS and does
 * not hold the whole campaign: 600 people get the message, 12 who have already
 * had two this week do not, and `result` records what actually happened. Quiet
 * hours and the per-salon monthly cap are properties of the campaign, so those
 * hold the whole thing.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { timestamptz } from './_shared';
import { member } from './member';
import { branch, salon } from './salon';

/** `CampaignSchema.status`. Four, and no more. */
export const CAMPAIGN_STATUSES = ['pending', 'approved', 'rejected', 'sent'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/** `CampaignSchema.audience`. Definitions live in services/campaign.ts. */
export const CAMPAIGN_AUDIENCES = ['all', 'lapsed', 'lowbal', 'gold', 'new'] as const;
export type CampaignAudience = (typeof CAMPAIGN_AUDIENCES)[number];

export const CAMPAIGN_CHANNELS = ['push', 'wa', 'both'] as const;
export const CAMPAIGN_WHENS = ['now', 'later', 'recurring'] as const;

export const campaign = pgTable(
  'campaign',
  {
    /** 'CMP-4193'. Quoted back to the merchant, so not a uuid. */
    id: text('id').primaryKey(),
    salonId: text('salon_id')
      .notNull()
      .references(() => salon.id, { onDelete: 'restrict' }),

    title: text('title').notNull(),
    body: text('body').notNull(),
    channel: text('channel').notNull(),
    audience: text('audience').$type<CampaignAudience>().notNull(),
    /**
     * NULL means every branch. The wire spells it `"all"`, exactly as
     * `happy_hour.branch_id` does — one sentinel convention, not two.
     */
    branchId: text('branch_id').references(() => branch.id, { onDelete: 'restrict' }),
    /** A `RewardKey` or the literal 'none'. Validated at the boundary. */
    reward: text('reward').notNull().default('none'),

    /**
     * SERVER-COMPUTED, NEVER TRUSTED FROM THE CLIENT — api-contract.md says so
     * on this field specifically. It is the audience size at SUBMISSION time,
     * which is what the owner console shows while deciding ("612 people"), and
     * it is deliberately not recomputed on read: the number a reviewer approved
     * against should not change under her while she reads the queue.
     *
     * What actually went out is `result`, computed at delivery.
     */
    reach: integer('reach').notNull().default(0),

    /**
     * `when` is a reserved word in SQL, so the column is `send_when`. The wire
     * field stays `when`, because `CampaignSchema` says so.
     */
    sendWhen: text('send_when').notNull().default('now'),
    /** NULL for `now` and `recurring`; the wire spells NULL as `""`. */
    scheduledAt: timestamptz('scheduled_at'),

    status: text('status').$type<CampaignStatus>().notNull().default('pending'),

    submittedBy: text('submitted_by').notNull(),
    submittedAt: timestamptz('submitted_at').notNull().defaultNow(),

    /** The platform admin's display name. Snapshot, like `audit_log`'s actor. */
    decidedBy: text('decided_by'),
    decidedAt: timestamptz('decided_at'),
    /**
     * "note is shown verbatim to the merchant" — api-contract.md. A REJECTION
     * MUST CARRY ONE, which is the CHECK below: "Rejections must carry a note —
     * the merchant sees it under the campaign in Marketing → Campaigns."
     */
    note: text('note'),
    /** "612 reached · 148 booked". Written at delivery, never before. */
    result: text('result'),

    /**
     * Why the platform did not send an approved campaign. See the header: this is
     * the "held, not dropped" state, and it is not a status.
     */
    heldReason: text('held_reason'),
    heldAt: timestamptz('held_at'),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('campaign_salon_submitted_idx').on(t.salonId, t.submittedAt.desc()),
    /** The console's queue: `GET /v1/platform/campaigns?status=pending`, oldest first. */
    index('campaign_status_submitted_idx').on(t.status, t.submittedAt),

    check('campaign_status_is_known', sql`${t.status} IN ('pending', 'approved', 'rejected', 'sent')`),
    check('campaign_channel_is_known', sql`${t.channel} IN ('push', 'wa', 'both')`),
    check(
      'campaign_audience_is_known',
      sql`${t.audience} IN ('all', 'lapsed', 'lowbal', 'gold', 'new')`,
    ),
    check('campaign_when_is_known', sql`${t.sendWhen} IN ('now', 'later', 'recurring')`),
    check('campaign_title_not_blank', sql`length(btrim(${t.title})) > 0`),
    check('campaign_body_not_blank', sql`length(btrim(${t.body})) > 0`),
    check('campaign_reach_non_negative', sql`${t.reach} >= 0`),

    /**
     * A REJECTION CARRIES A REASON, IN THE DATABASE.
     *
     * The contract says a rejection must carry a note and the merchant sees it
     * verbatim. Left to the handler, that is a promise; here it is a fact, and a
     * future second decision path cannot forget it. `approved` may also carry a
     * note — the design's fixture has a standing approval whose note explains the
     * trigger — so this is one-directional.
     */
    check(
      'campaign_rejection_has_note',
      sql`${t.status} <> 'rejected' OR (${t.note} IS NOT NULL AND length(btrim(${t.note})) > 0)`,
    ),
    /**
     * A DECIDED CAMPAIGN NAMES ITS DECIDER AND ITS MOMENT, and a pending one
     * claims neither. Written as an equivalence so it bites both ways — the
     * lesson `topup_intent_succeeded_has_settled_at` records: a one-directional
     * version lets a `pending` row carry a `decidedBy`, which reads to a merchant
     * as "somebody looked at this and did nothing".
     *
     * `sent` is decided too: nothing reaches `sent` except through a decision.
     */
    check(
      'campaign_decision_is_attributed',
      sql`(${t.status} IN ('approved', 'rejected', 'sent'))
          = (${t.decidedBy} IS NOT NULL AND ${t.decidedAt} IS NOT NULL)`,
    ),
    /** A hold has a reason and a moment, or it is not a hold. */
    check(
      'campaign_hold_is_complete',
      sql`(${t.heldReason} IS NOT NULL) = (${t.heldAt} IS NOT NULL)`,
    ),
    /**
     * ONLY AN APPROVED CAMPAIGN CAN BE HELD. A pending one has not been released,
     * a rejected one is not going anywhere, and a `sent` one already went — a
     * hold on any of those three is a state nobody can act on.
     */
    check(
      'campaign_hold_requires_approved',
      sql`${t.heldReason} IS NULL OR ${t.status} = 'approved'`,
    ),
    /** `result` is what went out. Nothing that has not sent has one. */
    check('campaign_result_requires_sent', sql`${t.result} IS NULL OR ${t.status} = 'sent'`),
    /**
     * A `later` campaign has a moment; `now` and `recurring` do not. The design's
     * quiet-hours flag reads `scheduledAt` only for `later`, and a `now` campaign
     * carrying one would make that flag lie.
     */
    check(
      'campaign_scheduled_at_matches_when',
      sql`(${t.sendWhen} = 'later') = (${t.scheduledAt} IS NOT NULL)`,
    ),
  ],
);

/**
 * The platform messaging policy — api-contract.md § PlatformMessagingPolicy.
 * ONE ROW, and the singleton CHECK is the structural half of "a merchant can
 * never read or raise these values": there is no salon column to scope it by, so
 * there is nothing for a merchant-scoped route to select.
 *
 * `PlatformMessagingPolicySchema` in `packages/types` has carried this shape the
 * whole time and nothing read it. Trunk counted the occurrences in `api/src`:
 * `requireApproval` 0, `weeklyCapPerCustomer` 0, `monthlyCapPerSalon` 0,
 * `quietFrom` 0. This is the storage; `services/campaign.ts` is the enforcement.
 */
export const platformMessagingPolicy = pgTable(
  'platform_messaging_policy',
  {
    id: text('id').primaryKey().default('avo'),
    /** "off = salons send unreviewed; default ON". */
    requireApproval: boolean('require_approval').notNull().default(true),
    /** 1..7. Across ALL salons. */
    weeklyCapPerCustomer: integer('weekly_cap_per_customer').notNull().default(2),
    /** 1..30. "counts approved + sent". */
    monthlyCapPerSalon: integer('monthly_cap_per_salon').notNull().default(8),
    quietFrom: text('quiet_from').notNull().default('22:00'),
    quietTo: text('quiet_to').notNull().default('09:00'),

    updatedBy: text('updated_by'),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('platform_messaging_policy_is_singleton', sql`${t.id} = 'avo'`),
    // The contract's own ranges, so a PATCH cannot store a cap the design's
    // stepper could never have produced.
    check(
      'platform_messaging_policy_weekly_cap_in_range',
      sql`${t.weeklyCapPerCustomer} BETWEEN 1 AND 7`,
    ),
    check(
      'platform_messaging_policy_monthly_cap_in_range',
      sql`${t.monthlyCapPerSalon} BETWEEN 1 AND 30`,
    ),
    check(
      'platform_messaging_policy_quiet_hours_are_hhmm',
      sql`${t.quietFrom} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
          AND ${t.quietTo} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`,
    ),
  ],
);

/**
 * One row per customer per campaign actually delivered to her.
 *
 * THIS IS WHAT MAKES THE WEEKLY CAP REAL. "A hard cap across ALL salons" is a
 * question about the customer, not about any campaign, and it can only be
 * answered by a log of what she has already received. Nothing else in the schema
 * records a message reaching a person.
 *
 * APPEND-ONLY for the application role, like `ledger_entry` and
 * `shop_order_line`: a cap whose own rows the application can delete is not a
 * cap. That is migration 0026's reasoning about `signup_attempt`, and it applies
 * more strongly here, because these rows are also the evidence that a customer
 * was contacted.
 */
export const campaignSend = pgTable(
  'campaign_send',
  {
    campaignId: text('campaign_id')
      .notNull()
      .references(() => campaign.id, { onDelete: 'restrict' }),
    memberId: text('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'restrict' }),
    /**
     * Denormalised off the campaign so the weekly count is one index scan over
     * this table rather than a join through `campaign` for every recipient of
     * every send. The cap is checked per candidate recipient, so this is the hot
     * path.
     */
    sentAt: timestamptz('sent_at').notNull().defaultNow(),
    channel: text('channel').notNull(),
  },
  (t) => [
    /**
     * One send per customer per campaign. A re-run of delivery — a retry, a
     * scheduler firing twice — cannot double-count her against the cap or
     * double-message her, and the database is what says so.
     */
    primaryKey({ columns: [t.campaignId, t.memberId], name: 'campaign_send_pk' }),
    /** THE CAP'S ONLY QUERY: "how many in the last seven days, for this member". */
    index('campaign_send_member_sent_idx').on(t.memberId, t.sentAt.desc()),
    check('campaign_send_channel_is_known', sql`${t.channel} IN ('push', 'wa', 'both')`),
  ],
);

export type CampaignRow = typeof campaign.$inferSelect;
export type PlatformMessagingPolicyRow = typeof platformMessagingPolicy.$inferSelect;
