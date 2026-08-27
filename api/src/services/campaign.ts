/**
 * Campaigns: the audience, the decision, and the send-time enforcement that
 * non-negotiable #8 asks for and nothing implemented.
 *
 * =========================================================================
 * WHAT WAS MISSING, MEASURED
 * =========================================================================
 * Trunk counted the occurrences in `api/src`: `requireApproval` 0,
 * `weeklyCapPerCustomer` 0, `monthlyCapPerSalon` 0, `quietFrom` 0.
 * `PlatformMessagingPolicySchema` was typed in `packages/types` and
 * `isInQuietHours` was written in `rules.ts`, and nothing called either.
 *
 * That is the shape this build keeps finding: a capability that exists and goes
 * unused. `e2e/support/api.ts` could already target the real API while three
 * suites drove fixtures; `api/src/jobs/no-show-once.ts` was built FOR evidence
 * and never run. #8's second sentence — "caps and quiet hours are enforced again
 * at send time" — was the criterion with nothing behind it.
 *
 * =========================================================================
 * THE PREDICATE IS IMPORTED, NOT REIMPLEMENTED
 * =========================================================================
 * `isInQuietHours` comes from `packages/types/src/rules.ts`. Not one line of it
 * is restated here, for exactly the reason `services/promotions.ts` gives about
 * `isHappyHourLive`: it is shared so a client and this server cannot disagree,
 * and a second implementation — however carefully copied — is a second thing to
 * keep in step.
 *
 * It takes `offsetMinutes`, so `offsetFor(salon, now)` supplies the salon's zone
 * offset at that instant, the same bridge `promotions.ts` builds.
 *
 * QUIET HOURS ARE RESOLVED IN THE SALON'S ZONE, NOT THE PLATFORM'S. The policy is
 * platform-wide — "22:00–09:00" is one pair of strings for every salon — and the
 * hour it names is the hour where the CUSTOMER is. A Kuwaiti customer at 23:30
 * local is inside quiet hours whatever clock the server keeps. `salon.timezone`
 * is the only zone available (a member has none), and every member of a salon is
 * that salon's customer, so it is the right one; a salon with customers in
 * another zone would be a different product.
 *
 * =========================================================================
 * WHAT HOLDS THE CAMPAIGN AND WHAT HOLDS A RECIPIENT
 * =========================================================================
 * The two caps are not the same kind of rule and treating them alike would be
 * wrong in one direction or the other:
 *
 *   QUIET HOURS and `monthlyCapPerSalon` are properties of the CAMPAIGN. Either
 *   this whole send is happening now or it is not. So the campaign is HELD —
 *   `held_reason` + `held_at`, status stays `approved` — and the merchant is told
 *   through a `merchant_notification` and an audit row. Held, reported, never
 *   silently dropped.
 *
 *   `weeklyCapPerCustomer` is a property of the CUSTOMER: "a hard cap across ALL
 *   salons". Holding the whole campaign because twelve people out of six hundred
 *   have already had two messages this week would punish the 588 who have not,
 *   and would make a merchant's campaign undeliverable for reasons she cannot see
 *   or fix. So those twelve are SKIPPED, the rest receive it, and `result` records
 *   what actually happened — which is the number the design's Decided list
 *   renders ("612 reached · 148 booked").
 *
 * =========================================================================
 * ONE TRANSACTION, AND WHY DELIVERY IS NOT A MONEY PATH BUT IS TREATED LIKE ONE
 * =========================================================================
 * The policy is read INSIDE the transaction that writes the sends, for the same
 * reason `loadPromotionInputs` is: an owner who tightens a cap while a release is
 * in flight must not have the old cap applied, and a pre-read cap is the old cap.
 * `campaign_send`'s primary key then makes a double-fired scheduler harmless at
 * the database rather than in the worker's intentions.
 */

import { and, count, eq, gte, inArray, lt, notExists, sql } from 'drizzle-orm';
import { fils, isInQuietHours } from '@avo/types';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import type { Db } from '../db/client';
import {
  campaign,
  campaignSend,
  platformMessagingPolicy,
  type CampaignRow,
} from '../db/schema/campaign';
import { member } from '../db/schema/member';
import { salon } from '../db/schema/salon';
import { transaction } from '../db/schema/transaction';
import { offsetFor } from '../time/zone';
import { conflict, notFound } from '../http/errors';
import { grantedMarketingConsent } from './consent';
import { raiseMerchantNotification, resolveMerchantNotification } from './notifications';
import { writeAudit, type Executor } from './audit';
import type { PlatformPrincipal } from '../auth/principal';

/** "Not seen in 60 days" — the design's own words on the audience select. */
const LAPSED_DAYS = 60;
/**
 * "Wallet under 5 KD".
 *
 * `fils(5000)`, NOT `5000`. `member.balance_fils` is typed `Fils` — branded — so
 * `lt(member.balanceFils, 5000)` does not compile. Non-negotiable #1 working on a
 * comparison rather than on an arithmetic operation, which is the case it is
 * easiest to forget it covers.
 */
const LOW_BALANCE_FILS = fils(5000);
/** `gold` on the select is labelled "Gold & Platinum": gold and everything above. */
const GOLD_AND_ABOVE = ['gold', 'black'] as const;

export interface MessagingPolicy {
  requireApproval: boolean;
  weeklyCapPerCustomer: number;
  monthlyCapPerSalon: number;
  quietFrom: string;
  quietTo: string;
}

/**
 * The one row. A MISSING ROW IS A REFUSAL, NOT A DEFAULT.
 *
 * Migration 0028 inserts it, so absence means an incomplete deployment. Inventing
 * fallbacks here is how `TRUST_PROXY` came to have two silent defaults that were
 * both wrong — and the fallbacks would be worse: "no policy" would read as "no
 * limits", so a deployment that failed to seed would send unrestricted messages
 * to customers and look healthy doing it.
 *
 * 409 AND NOT 503, changed in the sweep `routes/support.ts` describes.
 * `services/policy.ts` settled the doctrine for `policies_not_published` and it
 * was then applied one code at a time; this is a configuration state by its own
 * paragraph above — "an incomplete deployment" — so 503's promise of "try again
 * later and it may work" is false, and 503 is what puts it in a client's offline
 * bucket. Nothing consumes the code yet, so the change costs nothing and stops the
 * next client having to special-case it.
 */
export async function readMessagingPolicy(exec: Executor): Promise<MessagingPolicy> {
  const [row] = await exec.select().from(platformMessagingPolicy).limit(1);
  if (!row) {
    throw conflict(
      'messaging_policy_missing',
      'The platform messaging policy has not been configured.',
    );
  }
  return {
    requireApproval: row.requireApproval,
    weeklyCapPerCustomer: row.weeklyCapPerCustomer,
    monthlyCapPerSalon: row.monthlyCapPerSalon,
    quietFrom: row.quietFrom,
    quietTo: row.quietTo,
  };
}

/**
 * WHO A CAMPAIGN WOULD REACH — the definitions, in one place, next to the query.
 *
 * The design's own labels are the specification:
 *   all     "Everyone"
 *   lapsed  "Not seen in 60 days"
 *   lowbal  "Wallet under 5 KD"
 *   gold    "Gold & Platinum"       -> gold and black, the top two rungs
 *   new     "Joined this month"
 *
 * MARKETING CONSENT IS APPLIED ON TOP, AND IT IS NOT A COLUMN.
 *
 * My first attempt filtered on `notification_preference.offers`, which does not
 * exist. `member`'s four notification booleans are `push / remind / wa / receipt`
 * and its own comment says so in as many words: "`offers` is NOT among them".
 * Marketing consent is DERIVED from `member_consent_event`, append-only, newest
 * event wins, and — the half that matters — NO EVENT AT ALL MEANS NO CONSENT.
 * `services/consent.ts` says why: "a member who predates this table has never been
 * asked, and inferring a grant from silence is the one answer that cannot be
 * defended afterwards."
 *
 * A LEFT JOIN with `granted IS NOT FALSE` would have inverted exactly that, and it
 * is the obvious batch implementation. `grantedMarketingConsent` is written in
 * `services/consent.ts` beside the singular version instead of here, because that
 * file's own header warns against this definition existing twice — "which is
 * exactly how a customer who turned offers off keeps receiving them."
 *
 * IT IS APPLIED IN THE AUDIENCE, NOT IN THE DELIVERY LOOP. `reach` is the number a
 * reviewer approves a campaign against, so a reach counting people who can never
 * receive it is a number that lies to her.
 *
 * EXPORTED FOR ONE REASON, and it is worth the widened surface: the `lapsed` 500
 * below was a BOUND PARAMETER the driver could not encode, and that is a property
 * of the compiled predicate — renderable with `toSQL()`, no database, no
 * connection. So `campaignAudience.test.ts` can assert it for every member of
 * `CAMPAIGN_AUDIENCES` inside `pnpm check`, which the `.int` suite is not run by.
 * Nothing outside this file and that spec calls it.
 */
export function audiencePredicate(salonId: string, audience: CampaignRow['audience'], now: Date) {
  const base = eq(member.salonId, salonId);

  switch (audience) {
    case 'lapsed': {
      const cutoff = new Date(now.getTime() - LAPSED_DAYS * 86_400_000);
      /**
       * "NOT SEEN" IS HER LAST CHARGE, NOT HER LAST SIGN-IN, and there is no
       * `last_visit_at` column to read — `member` carries `visits` (a count) and
       * `joined_at`, and neither answers "when". So it is the newest settled
       * `charge` or `shop` transaction of hers, which is what a salon means by
       * having seen somebody: she came in and paid for something.
       *
       * NO SUCH TRANSACTION IS LAPSED, and that is the deliberate half. A customer
       * who signed up and never came is the strongest case in a "we miss you"
       * audience, not an edge to exclude — so the NOT EXISTS is over the window
       * rather than a comparison against a max that would be NULL.
       *
       * ---------------------------------------------------------------------
       * BUILT WITH THE HELPERS, NOT AS A RAW `sql` TEMPLATE, AND THAT IS THE FIX
       * FOR A 500 THIS BRANCH SERVED FOR ITS WHOLE LIFE.
       *
       * The reasoning above was right and the query never ran. It was written as
       * a raw `sql` template ending `AND t.created_at >= ${cutoff}` with `cutoff`
       * a `Date`, and every `audience: "lapsed"` campaign — the first one a salon
       * asks for — answered 500 `server_error`, at create AND on release, while the
       * other four audiences worked. The other four were built from `lt` /
       * `inArray` / `gte`. That was the whole difference.
       *
       * WHY A BARE `Date` IN A RAW TEMPLATE CANNOT BIND HERE, precisely, because
       * "postgres.js cannot take a Date" is the wrong lesson and would send the
       * next person looking in the driver:
       *
       *   `drizzle()` REPLACES the driver's own date serializer on construction.
       *   `drizzle-orm/postgres-js/driver.js` sets
       *   `client.options.serializers[1184] = (val) => val` (also 1082/1083/1114),
       *   because Drizzle intends to encode dates itself from the column type.
       *   Verified on this branch: the same raw `unsafe(q, [id, new Date()])`
       *   succeeds before `drizzle(client)` and throws after it.
       *
       *   So a parameter Drizzle did NOT encode arrives at `Bind` as a live `Date`,
       *   the identity serializer hands it straight to `Buffer.byteLength`, and the
       *   driver throws `ERR_INVALID_ARG_TYPE: … Received an instance of Date`.
       *   A raw template gives Drizzle no column to encode against, so it does not.
       *
       * `services/metrics.ts` and `services/platformMetrics.ts` hit the same wall
       * and answered it with `at()` — an ISO string plus an explicit `::timestamptz`
       * cast. That is the right answer THERE: those are raw aggregates with no
       * Drizzle column on either side. Here there IS a column,
       * `transaction.created_at`, so the better answer is to let Drizzle encode
       * against it: `gte(transaction.createdAt, cutoff)` cannot be written wrong the
       * way an interpolation can, which is what stops the sixth person
       * reintroducing this.
       *
       * `QueryBuilder` and not `exec.select(…)`: the subquery must never execute,
       * only render, and it is correlated on the OUTER `member.id` — a builder with
       * no connection makes both facts structural rather than intended.
       */
      return and(
        base,
        notExists(
          new QueryBuilder()
            .select({ one: sql`1` })
            .from(transaction)
            .where(
              and(
                eq(transaction.memberId, member.id),
                inArray(transaction.kind, ['charge', 'shop']),
                eq(transaction.status, 'settled'),
                gte(transaction.createdAt, cutoff),
              ),
            ),
        ),
      );
    }
    case 'lowbal':
      return and(base, lt(member.balanceFils, LOW_BALANCE_FILS));
    case 'gold':
      return and(base, inArray(member.tier, [...GOLD_AND_ABOVE]));
    case 'new': {
      /**
       * "Joined this month" — `joined_at`, not `created_at`. They agree today
       * because the seed and the signup path set both, and they are different
       * questions: `created_at` is when the ROW appeared, which a migration or an
       * import can move, and `joined_at` is when she became a customer. The design
       * is asking the second one.
       *
       * The month boundary is UTC here and REPORTED as such: it is a question about
       * a clock, the salon's zone is Asia/Kuwait (UTC+3, no DST), so this is up to
       * three hours out at the very start of a month. Fixing it properly means
       * passing the salon's offset into the predicate, which every other branch has
       * no use for; it is not a money path and the audience is advisory. Named
       * rather than left to be discovered.
       */
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      return and(base, gte(member.joinedAt, monthStart));
    }
    case 'all':
    default:
      return base;
  }
}

/** The audience, as ids. Used for `reach` at submission and for delivery. */
export async function resolveAudience(
  exec: Executor,
  params: { salonId: string; audience: CampaignRow['audience']; now: Date },
): Promise<string[]> {
  const rows = await exec
    .select({ id: member.id })
    .from(member)
    .where(audiencePredicate(params.salonId, params.audience, params.now));

  // Consent last, over the segment rather than over every member of the salon.
  const allowed = await grantedMarketingConsent(exec as Db, rows.map((r) => r.id));
  return rows.filter((r) => allowed.has(r.id)).map((r) => r.id);
}

/**
 * `reach`, computed server-side at submission. api-contract.md marks this field
 * "server-computed, never trusted from the client" on the field itself.
 */
export async function computeReach(
  exec: Executor,
  params: { salonId: string; audience: CampaignRow['audience']; now: Date },
): Promise<number> {
  return (await resolveAudience(exec, params)).length;
}

// ------------------------------------------------------------- the decision --

export interface DeliveryOutcome {
  status: 'sent' | 'held';
  /** Recipients written to `campaign_send`. 0 on a hold. */
  sent: number;
  /** Audience members skipped because they were over the weekly cap. */
  cappedOut: number;
  /** Set when `status` is 'held'. The sentence the merchant is shown. */
  heldReason: string | null;
  /** `campaign.result`, when it sent. */
  result: string | null;
}

/**
 * Deliver an approved campaign, or hold it.
 *
 * Takes the caller's transaction, so the policy read, the cap counts, the send
 * rows and the campaign's own status all commit together or not at all. A hold
 * that committed without its notification would be a campaign that silently did
 * not send, which is the one outcome #8 names as unacceptable.
 */
export async function deliverCampaign(
  tx: Executor,
  row: CampaignRow,
  ctx: { actor: PlatformPrincipal | null; now: Date },
): Promise<DeliveryOutcome> {
  const policy = await readMessagingPolicy(tx);

  const [s] = await tx
    .select({ id: salon.id, name: salon.name, timezone: salon.timezone })
    .from(salon)
    .where(eq(salon.id, row.salonId))
    .limit(1);
  if (!s) throw notFound('unknown_salon', 'No such salon.');

  const offset = offsetFor(s, ctx.now);

  // ------------------------------------------------------- 1. quiet hours --
  /**
   * THE SHARED PREDICATE, in the salon's zone. "Quiet hours 22:00–09:00 —
   * nothing sends, approved or not", which the design prints under the throttle
   * card in as many words.
   */
  if (isInQuietHours(ctx.now, policy.quietFrom, policy.quietTo, offset)) {
    return holdCampaign(
      tx,
      row,
      s,
      `Quiet hours ${policy.quietFrom}–${policy.quietTo}. Held until ${policy.quietTo}.`,
      ctx,
    );
  }

  // -------------------------------------------- 2. the monthly cap per salon --
  /**
   * "counts approved + sent" — api-contract.md, and it is counted that way rather
   * than as "sent" alone for a reason worth stating: an approved-but-held campaign
   * is still one the salon is going to send, so excluding it would let a salon
   * queue thirty campaigns inside quiet hours and have all thirty released at
   * 09:00 past a cap of eight.
   *
   * THIS CAMPAIGN IS EXCLUDED FROM ITS OWN COUNT — it is already `approved` by the
   * time delivery runs, so counting it would make a cap of 8 behave as 7.
   */
  const monthStart = new Date(
    Date.UTC(ctx.now.getUTCFullYear(), ctx.now.getUTCMonth(), 1) - offset * 60_000,
  );
  const [{ used = 0 } = { used: 0 }] = await tx
    .select({ used: count() })
    .from(campaign)
    .where(
      and(
        eq(campaign.salonId, row.salonId),
        inArray(campaign.status, ['approved', 'sent']),
        gte(campaign.decidedAt, monthStart),
        sql`${campaign.id} <> ${row.id}`,
      ),
    );

  if (used >= policy.monthlyCapPerSalon) {
    return holdCampaign(
      tx,
      row,
      s,
      `This salon has reached the platform limit of ${policy.monthlyCapPerSalon} campaigns this month (${used} already released). Held.`,
      ctx,
    );
  }

  // ----------------------------------------- 3. the weekly cap per customer --
  const audience = await resolveAudience(tx, {
    salonId: row.salonId,
    audience: row.audience,
    now: ctx.now,
  });

  /**
   * ACROSS ALL SALONS, which is why this counts `campaign_send` and not
   * `campaign`: the table has no salon column, deliberately. A customer with
   * wallets at two salons is one customer to this cap.
   */
  const weekStart = new Date(ctx.now.getTime() - 7 * 86_400_000);
  const recent =
    audience.length === 0
      ? []
      : await tx
          .select({ memberId: campaignSend.memberId, n: count() })
          .from(campaignSend)
          .where(
            and(inArray(campaignSend.memberId, audience), gte(campaignSend.sentAt, weekStart)),
          )
          .groupBy(campaignSend.memberId);

  const alreadyHad = new Map(recent.map((r) => [r.memberId, Number(r.n)]));
  const recipients = audience.filter(
    (id) => (alreadyHad.get(id) ?? 0) < policy.weeklyCapPerCustomer,
  );
  const cappedOut = audience.length - recipients.length;

  /**
   * AN AUDIENCE THAT IS ENTIRELY CAPPED OUT IS A HOLD, NOT AN EMPTY SEND.
   *
   * Zero recipients out of six hundred is not "delivered to nobody" — it is the
   * cap refusing the whole campaign, and `result: "0 reached"` would report that
   * as a successful send of nothing. An audience that is legitimately empty is a
   * different fact and also a hold, with its own sentence: the merchant needs to
   * know her `lapsed` segment has no one in it rather than reading "sent".
   */
  if (recipients.length === 0) {
    return holdCampaign(
      tx,
      row,
      s,
      audience.length === 0
        ? 'Nobody is in this audience right now. Held rather than sent to nobody.'
        : `Every one of the ${audience.length} customers in this audience has already had ${policy.weeklyCapPerCustomer} message(s) this week. Held.`,
      ctx,
    );
  }

  // -------------------------------------------------------------- 4. send --
  /**
   * ROWS, NOT NETWORK CALLS — the same separation `queueReceipts` makes and for
   * the same reason: an awaited push or WhatsApp call inside an open transaction
   * turns a provider outage into a failed release. `campaign_send` IS the record
   * that she was contacted, and it is what the cap counts; actual dispatch is the
   * delivery driver's job, behind the same logging stub receipts sit behind until
   * WhatsApp template approval lands.
   *
   * REPORTED: nothing yet reads `campaign_send` to dispatch. So a released
   * campaign is recorded as delivered and no push leaves the building — exactly
   * the state receipts are in, and it is named here rather than implied.
   */
  await tx.insert(campaignSend).values(
    recipients.map((id) => ({
      campaignId: row.id,
      memberId: id,
      channel: row.channel,
      sentAt: ctx.now,
    })),
  );

  /**
   * `result` — the design's Decided list renders it verbatim. "148 booked" is the
   * second half of its example and is NOT produced here: attributing a booking to
   * a campaign needs a campaign id on the booking, which no table carries and no
   * client sends. Writing a made-up number beside a real one would make the real
   * one unbelievable, so this reports reach and says what was held back.
   */
  const result =
    cappedOut > 0
      ? `${recipients.length} reached · ${cappedOut} over the weekly cap`
      : `${recipients.length} reached`;

  await tx
    .update(campaign)
    .set({ status: 'sent', result, heldReason: null, heldAt: null, updatedAt: ctx.now })
    .where(eq(campaign.id, row.id));

  await writeAudit(tx, ctx.actor, {
    salonId: row.salonId,
    kind: 'rules',
    action: 'Campaign released',
    detail: `"${row.title}" sent · ${result}`,
    source: 'owner_console',
    subjectType: 'campaign',
    subjectId: row.id,
    metadata: {
      recipients: recipients.length,
      cappedOut,
      audience: row.audience,
      audienceSize: audience.length,
      weeklyCapPerCustomer: policy.weeklyCapPerCustomer,
      monthlyCapPerSalon: policy.monthlyCapPerSalon,
    },
  });

  return { status: 'sent', sent: recipients.length, cappedOut, heldReason: null, result };
}

/**
 * HELD, AND REPORTED. The half of #8 that must not be a silent drop.
 *
 * Three records, all in the caller's transaction:
 *
 *   1. `held_reason` + `held_at` on the campaign, status unchanged at `approved`.
 *      AVO did release it; the platform did not send it; both are true.
 *   2. A `merchant_notification`, which is how this product tells a salon
 *      something happened to her without her asking. Already the mechanism for a
 *      disconnected calendar and an auto-returned deposit.
 *   3. An audit row, so the platform's own log carries the decision and its
 *      reason.
 *
 * The notification is deduped on `(salon, kind, subject_type, subject_id) WHERE
 * resolved_at IS NULL`, so a scheduler retrying a held campaign every ten minutes
 * produces ONE bell rather than a hundred and forty — and the row resolves when
 * the campaign eventually sends, which frees the index for a later hold.
 */
async function holdCampaign(
  tx: Executor,
  row: CampaignRow,
  s: { id: string; name: string },
  reason: string,
  ctx: { actor: PlatformPrincipal | null; now: Date },
): Promise<DeliveryOutcome> {
  await tx
    .update(campaign)
    .set({ heldReason: reason, heldAt: ctx.now, updatedAt: ctx.now })
    .where(eq(campaign.id, row.id));

  await raiseMerchantNotification(tx, {
    salonId: row.salonId,
    kind: 'campaign_held',
    severity: 'warning',
    title: 'Campaign approved but not sent yet',
    body: `"${row.title}" — ${reason}`,
    subjectType: 'campaign',
    subjectId: row.id,
    deepLink: '/marketing/campaigns',
    metadata: { reason },
  });

  await writeAudit(tx, ctx.actor, {
    salonId: row.salonId,
    kind: 'rules',
    action: 'Campaign held',
    detail: `"${row.title}" approved but not sent · ${reason}`,
    source: 'owner_console',
    subjectType: 'campaign',
    subjectId: row.id,
    metadata: { reason },
  });

  return { status: 'held', sent: 0, cappedOut: 0, heldReason: reason, result: null };
}

/**
 * Retry every held campaign. The scheduler's entry point, and the reason a hold
 * is a reason rather than a rejection: quiet hours end.
 *
 * NOT WIRED TO A TIMER YET, and that is deliberate rather than forgotten. The
 * no-show worker is the precedent in both directions: it has a timer AND a
 * one-shot runner (`jobs/no-show-once.ts`) written specifically so "a claim about
 * a background loop that can only be exercised by waiting for a timer is a claim
 * nobody checks". STATUS.md then records that the one-shot runner was never once
 * executed by a spec. So this ships as a plain function a spec can call and a
 * scheduler can call, and the timer is a separate decision with a separate test.
 */
export async function releaseHeldCampaigns(
  db: Db,
  now: Date,
  actor: PlatformPrincipal | null = null,
): Promise<DeliveryOutcome[]> {
  const held = await db
    .select()
    .from(campaign)
    .where(and(eq(campaign.status, 'approved'), sql`${campaign.heldReason} IS NOT NULL`))
    .orderBy(campaign.decidedAt);

  const outcomes: DeliveryOutcome[] = [];
  for (const row of held) {
    // One transaction per campaign: a cap breach on the fourth must not roll back
    // the three that legitimately went out.
    outcomes.push(
      await db.transaction(async (tx) => {
        const outcome = await deliverCampaign(tx, row, { actor, now });
        if (outcome.status === 'sent') {
          // The bell clears when the condition does — services/notifications.ts:
          // "a notification that never clears trains a merchant to ignore the
          // bell". It also frees the partial unique index, so a LATER hold on the
          // same campaign raises a new row instead of being deduped against a
          // stale fact.
          await resolveMerchantNotification(tx, {
            salonId: row.salonId,
            kind: 'campaign_held',
            subjectType: 'campaign',
            subjectId: row.id,
          });
        }
        return outcome;
      }),
    );
  }
  return outcomes;
}

/** A campaign the merchant may still withdraw, or a refusal naming why not. */
export function requireWithdrawable(row: CampaignRow): void {
  if (row.status !== 'pending') {
    throw conflict(
      'campaign_not_pending',
      row.status === 'rejected'
        ? 'That campaign was already rejected. There is nothing to withdraw.'
        : 'AVO has already decided on that campaign. It can no longer be withdrawn.',
    );
  }
}

