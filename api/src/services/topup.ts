/**
 * The top-up round trip. The other half of the money core.
 *
 * api-contract.md § TopUpIntent:
 *   POST /topups → open `redirectUrl` → gateway returns to
 *   avo://topup/return?intent={id} → GET /topups/{id} for the authoritative
 *   status.
 *
 * FOUR THINGS MOVE A TOP-UP, IN ANY ORDER, MORE THAN ONCE
 * -------------------------------------------------------
 * the client starting it, the hosted page, the PSP's webhook, and our own read
 * on the customer's return. That is the whole difficulty, and it is why this
 * file is a state machine rather than a handler that sets `status`.
 *
 *   created ─┬─→ redirected ─┬─→ pending ─┬─→ succeeded  (terminal)
 *            │               │            ├─→ failed     (terminal)
 *            └───────────────┴────────────┴─→ cancelled  (terminal)
 *
 * Every arrow is forward. There is no arrow out of a terminal state, so:
 *
 *   - a duplicate `succeeded` callback cannot credit twice — the second one is
 *     succeeded → succeeded, which is not an arrow;
 *   - an out-of-order `pending` arriving after a `succeeded` cannot walk a
 *     settled top-up back into flight;
 *   - a callback that lands BEFORE the customer's browser comes back settles
 *     the intent, and the client's `GET /topups/{id}` then reads what already
 *     happened instead of racing it.
 *
 * The transition is applied as a conditional UPDATE whose row count decides the
 * outcome — the same mechanism services/walletToken.ts uses for single-use
 * consumption, and for the same reason: it is a property of the statement, not
 * of how fast two requests happened to arrive. Migration 0004 puts the same
 * rules in a trigger, so a future handler, a job, or a psql session cannot get
 * it wrong either.
 *
 * WHAT CREDITS THE WALLET
 * -----------------------
 * A server-side read of gateway state, and nothing else. Never a client
 * returning with a success-looking URL: `avo://topup/return?intent=TI-1` tells
 * us a browser closed. `settleFromGatewayRead` is reached only after
 * `gateway.fetchPayment`, and `settleFromWebhook` only after a verified
 * signature.
 *
 * The credit itself is ONE transaction — non-negotiable #3's discipline applied
 * to the other direction of the money: balance, `transaction` row, ledger pair,
 * receipt job, audit row and the intent's own status either all commit or none
 * of them do.
 */

import { and, eq, inArray } from 'drizzle-orm';
import {
  add,
  commissionFor,
  percentOf,
  fils,
  TopUpIntentPublicSchema,
  type Fils,
  type PaymentMethod,
  type TopUpIntentPublic,
} from '@avo/types';
import type { Db } from '../db/client';
import { member } from '../db/schema/member';
import { salon } from '../db/schema/salon';
import { transaction } from '../db/schema/transaction';
import { ledgerEntry } from '../db/schema/ledger';
import { gatewayEvent, topUpIntent } from '../db/schema/topup';
import { queueReceipts } from './receipts';
import type { MemberPrincipal } from '../auth/principal';
import { ApiError, badRequest, conflict, notFound } from '../http/errors';
import { gateway, withGatewayTimeout, type GatewayOutcome } from '../gateway';
import { GatewayUnavailableError } from '../gateway/types';
import { env } from '../env';
import { claimKey, completeKey, isUniqueViolation } from './idempotency';
import { decideEarning, loadPromotionInputs } from './promotions';
import { writeAudit, type Executor } from './audit';
import { resolveBranch } from './branch';

// ------------------------------------------------------------ the machine --

export type TopUpStatus =
  | 'created'
  | 'redirected'
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type TopUpFailureReason = 'declined' | 'expired' | 'cancelled_by_user' | 'gateway_error';

/**
 * Every legal arrow, declared once. A status not listed as a successor cannot
 * be reached from that state — including a state reaching itself, which is what
 * makes a re-delivered `succeeded` a no-op rather than a second credit.
 */
export const LEGAL_TRANSITIONS: Record<TopUpStatus, readonly TopUpStatus[]> = {
  created: ['redirected', 'pending', 'succeeded', 'failed', 'cancelled'],
  redirected: ['pending', 'succeeded', 'failed', 'cancelled'],
  pending: ['succeeded', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
} as const;

export function canTransition(from: TopUpStatus, to: TopUpStatus): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

/** The states that can still move. The reconciliation job's definition of open. */
export const OPEN_STATUSES: TopUpStatus[] = ['created', 'redirected', 'pending'];

/** Every state from which `to` is reachable — the WHERE of the conditional UPDATE. */
function predecessorsOf(to: TopUpStatus): TopUpStatus[] {
  return (Object.keys(LEGAL_TRANSITIONS) as TopUpStatus[]).filter((from) =>
    canTransition(from, to),
  );
}

/** What the gateway said → what the intent becomes. The only mapping there is. */
export function statusForOutcome(outcome: GatewayOutcome): {
  status: TopUpStatus;
  failureReason: TopUpFailureReason | null;
} {
  switch (outcome) {
    case 'succeeded':
      return { status: 'succeeded', failureReason: null };
    // `pending` is a real state, not a failure and not a success. The wallet
    // gets its own screen and offers no retry — a retry from pending is how
    // double charges happen (api-contract.md § TopUpIntent, client rule 2).
    case 'pending':
      return { status: 'pending', failureReason: null };
    case 'declined':
      return { status: 'failed', failureReason: 'declined' };
    case 'cancelled':
      return { status: 'cancelled', failureReason: 'cancelled_by_user' };
    case 'gateway_error':
      return { status: 'failed', failureReason: 'gateway_error' };
  }
}

// ----------------------------------------------------------------- shapes --

export interface TopUpIntentRow {
  id: string;
  memberId: string;
  salonId: string;
  branchId: string;
  amountFils: Fils;
  bonusFils: Fils;
  promoBonusFils: Fils;
  promotionId: string | null;
  creditFils: Fils;
  feeFils: Fils;
  method: 'knet' | 'card' | 'applepay' | 'wallet';
  status: TopUpStatus;
  failureReason: TopUpFailureReason | null;
  redirectUrl: string;
  reference: string;
  provider: string;
  pspReference: string | null;
  transactionId: string | null;
}

/**
 * The FULL wire shape, exactly api-contract.md § TopUpIntent, commission
 * included. MERCHANT AND PLATFORM VIEWS ONLY.
 *
 * No customer-facing endpoint returns this. `GET /topups/{id}` and `POST
 * /topups` both project through `serialiseIntentForCustomer` below, so the
 * commission reaches a merchant surface and nothing else.
 *
 * The tension this comment used to flag is resolved on both sides now. The
 * read side went first; the write side was blocked because Lane D's
 * `money.test.ts` asserted `feeFils` on the `POST /topups` response. Those five
 * specs have been restated against `topup_intent.fee_fils` — the column, where
 * the number actually lives and where a serialiser cannot move it — so the two
 * endpoints no longer have to move separately, and both have moved.
 */
export interface TopUpIntentView {
  id: string;
  memberId: string;
  amountFils: number;
  bonusFils: number;
  creditFils: number;
  method: PaymentMethod;
  feeFils: number;
  status: TopUpStatus;
  failureReason: TopUpFailureReason | null;
  redirectUrl: string;
  reference: string;
}

export function serialiseIntent(row: TopUpIntentRow): TopUpIntentView {
  return {
    id: row.id,
    memberId: row.memberId,
    amountFils: row.amountFils,
    /**
     * THE TOTAL MERCHANT-FUNDED BONUS — tier plus promotion.
     *
     * `TopUpIntentSchema` has exactly one bonus field, and the contract's
     * invariant `creditFils = amountFils + bonusFils` is one Lane D pins
     * directly. Emitting only the tier portion would break that invariant on the
     * wire and hand the customer a credit she cannot account for; emitting a
     * second field is a `packages/types` change, which is trunk's to make and
     * not lane A's.
     *
     * So the wire keeps one number, which is what the contract describes, and
     * the SPLIT lives in the database where reconciliation actually happens —
     * `bonus_fils` and `promo_bonus_fils`. Reported: if the dashboard ever needs
     * to show a merchant which half of a bonus a campaign cost her, that is the
     * `packages/types` field, and the columns behind it already exist.
     */
    bonusFils: (row.bonusFils + row.promoBonusFils) as Fils,
    creditFils: row.creditFils,
    method: row.method as PaymentMethod,
    feeFils: row.feeFils,
    status: row.status,
    failureReason: row.failureReason,
    redirectUrl: row.redirectUrl,
    reference: row.reference,
  };
}

/**
 * The keys the customer-facing shape is allowed to carry, taken FROM THE
 * CONTRACT rather than written out here.
 *
 * `TopUpIntentPublicSchema` is `TopUpIntentSchema.omit({ feeFils: true })`, so
 * this list cannot drift from it: a field trunk adds to the public shape is
 * emitted the day it lands, and `feeFils` cannot be emitted no matter what
 * `serialiseIntent` above is later edited to return.
 */
const PUBLIC_INTENT_KEYS: readonly string[] = Object.keys(TopUpIntentPublicSchema.shape);

/**
 * A top-up intent as the CUSTOMER sees it. `GET /topups/{id}` is the wallet's
 * authoritative status read, and the commission is merchant-visible,
 * customer-never — api-contract.md § Commission, its addendum, and the product
 * owner directly: "The customer doesn't see this of course, they just see the
 * price."
 *
 * WHY THIS PROJECTS ONTO A KEY SET INSTEAD OF DELETING A LINE
 * -----------------------------------------------------------
 * Deleting `feeFils` from a serialiser is a rule held by whoever edits it next.
 * Lane D found what that is worth: `GET /members/me/transactions` hand-mapped
 * its rows instead of going through `http/serialise.ts`, so a rule enforced in
 * the shared serialiser was already only half enforced — enforced on the path
 * that called it, silently absent on the path that did not.
 *
 * Projecting onto the contract's own key list makes the omission structural. A
 * field that is not in `TopUpIntentPublicSchema` cannot reach a customer through
 * this function even if someone adds it to `TopUpIntentView`, and the failure
 * mode of getting it wrong is a missing field in a test, not a leaked one in
 * production.
 *
 * It projects rather than `.parse()`s deliberately: a stored intent that somehow
 * violated the schema would make `parse` throw, turning a readable status into a
 * 500 for a customer who only wanted to know whether her payment went through.
 * Stripping cannot fail; validating can.
 */
export function serialiseIntentForCustomer(row: TopUpIntentRow): TopUpIntentPublic {
  const full = serialiseIntent(row) as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of PUBLIC_INTENT_KEYS) out[k] = full[k];
  return out as unknown as TopUpIntentPublic;
}

function intentId(): string {
  return `TI-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function transactionId(): string {
  return `TX-${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;
}

/**
 * `defaultBranchId` USED TO LIVE HERE, identical to the copy in
 * services/charge.ts. Both are now services/branch.ts § resolveBranch, which
 * returns the attribution and whether it is a fact as two separate answers.
 */

// ------------------------------------------------------------ POST /topups --

export interface CreateTopUpInput {
  amountFils: Fils;
  method: PaymentMethod;
}

export interface CreateTopUpContext {
  principal: MemberPrincipal;
  idempotency: { scope: string; endpoint: string; key: string; requestHash: string };
  /** Sandbox only: make the gateway's create leg fail, to exercise the 502. */
  failCreate?: boolean;
}

/**
 * Create the intent and the gateway's hosted payment, as ONE transaction.
 *
 * The gateway call sits INSIDE the transaction, which is the opposite of what
 * services/charge.ts does with the WhatsApp receipt, and the difference is
 * deliberate. The receipt is deferred because an awaited third party inside the
 * charge transaction holds the member row lock for the length of someone else's
 * timeout. This transaction locks nothing contended: it inserts an idempotency
 * row and an intent row and reads the member without `FOR UPDATE`. What it buys
 * in exchange is the property the charge path already established —
 *
 *   A TOP-UP WHOSE GATEWAY LEG FAILED DOES NOT BURN ITS IDEMPOTENCY KEY.
 *
 * The throw rolls back the key, the intent and everything else, so the client
 * retries the same attempt with the same key, exactly as api-contract.md
 * § TopUpIntent client rule 3 tells it to. Splitting this in two would leave a
 * committed key with no answer behind it and a retry that could only wait.
 *
 * `withGatewayTimeout` is what makes holding the transaction across the call
 * defensible: the third party has a hard ceiling, not a hope.
 */
export async function createTopUp(
  db: Db,
  input: CreateTopUpInput,
  ctx: CreateTopUpContext,
): Promise<TopUpIntentPublic> {
  return db.transaction(async (tx) => {
    const keyId = await claimKey(tx, ctx.idempotency);

    const memberRows = await tx
      .select()
      .from(member)
      .where(eq(member.id, ctx.principal.id))
      .limit(1);
    const m = memberRows[0];
    if (!m) throw notFound('unknown_member', 'No such member.');

    const salonRows = await tx.select().from(salon).where(eq(salon.id, m.salonId)).limit(1);
    const s = salonRows[0];
    if (!s) throw notFound('unknown_salon', 'No such salon.');

    // ---------------------------------------------------- money, all server --
    // Non-negotiable #2. A client-supplied bonusFils / creditFils / feeFils is
    // not read anywhere in this function; a patched client that sends
    // `creditFils: 999999` tops up exactly what it paid for.
    //
    // The tier bonus DOES NOT EXIST in stamps mode: a stamps salon has no tier
    // ladder to read a percentage off, and inventing one would hand out credit
    // the merchant never agreed to fund.
    const bonusPercent =
      s.loyaltyMode === 'stamps'
        ? 0
        : (s.tiers?.find((t) => t.name === m.tier)?.bonusPercent ?? 0);

    const bonus = percentOf(input.amountFils, bonusPercent);

    const id = ctx.failCreate ? `${intentId()}-GWFAIL` : intentId();
    /**
     * A TOP-UP HAS NO BRANCH TO ESTABLISH — it happens on a phone. So this is an
     * attribution and never anything more, and `branch.established` is ignored
     * here rather than consulted: even a one-branch salon did not host this
     * top-up, it merely has only one candidate to name.
     *
     * The promotion read below passes `null` for the same reason, and the
     * settled transaction is written `branch_assumed = true` in every case. That
     * is the honest reading and it costs the customer nothing: the branch
     * boost's `topup` points were already skipped on this path before this
     * change, deliberately, so nothing she earns moves.
     */
    const branch = await resolveBranch(tx, s.id);
    const branchId = branch.branchId;

    /**
     * ------------------------------- the promotion bonus, decided server-side --
     *
     * A live `topup10` / `topup20` window adds percentage points ON TOP OF the
     * tier bonus — packages/types/src/rules.ts says so in as many words, and
     * that is why they are two columns rather than one: both are merchant-funded
     * but one is owed to the customer's standing and the other to a campaign,
     * and a single `bonus_fils` could never be split back apart at
     * reconciliation. That was the second schema obstacle flagged before this
     * was built, and this is it resolved.
     *
     * LOCKED AT CREATION, not at settlement. The customer tapped Pay against the
     * number she was shown; a top-up settles minutes later and possibly after
     * the window has closed, and re-deciding at settlement would take back an
     * offer she acted on. The tier bonus was already locked here for the same
     * reason, and settlement credits `creditFils` verbatim.
     *
     * BRANCH: `null`, not `branchId`, and unconditionally — this is the one
     * place that does NOT consult `branch.established`. A wallet top-up happens
     * on a phone, not at a branch, so there is nothing to establish; the
     * resolver above names a branch purely so the NOT NULL column has an
     * attribution. Paying a per-branch percentage on that basis would make a
     * customer's bonus depend on branch-id sort order. So the branch boost's
     * `topup` points and any branch-scoped window are skipped; an `all`-scoped
     * happy hour has no ambiguity to resolve and applies. services/promotions.ts
     * § PromotionInputs carries the reasoning and the flag.
     */
    const promoInputs = await loadPromotionInputs(tx, s.id, null);
    const promoPercent =
      promoInputs && s.loyaltyMode !== 'stamps'
        ? decideEarning(promoInputs, new Date())
        : null;

    const promoBonus = promoPercent
      ? percentOf(input.amountFils, promoPercent.topupBonusPercent)
      : fils(0);
    const credit = add(add(input.amountFils, bonus), promoBonus);

    // AVO's cut. Recorded on the intent and later on the transaction; never
    // deducted from what lands in the wallet.
    const fee = commissionFor(input.amountFils, input.method);

    await tx.insert(topUpIntent).values({
      id,
      memberId: m.id,
      salonId: s.id,
      branchId,
      amountFils: input.amountFils,
      bonusFils: bonus,
      promoBonusFils: promoBonus,
      promotionId: promoBonus > 0 ? promoPercent?.happyHourId ?? null : null,
      creditFils: credit,
      feeFils: fee,
      method: input.method,
      status: 'created',
      failureReason: null,
      redirectUrl: '',
      reference: `AVO-TOP-${id.slice(3)}`,
      provider: gateway.provider,
      pspReference: null,
    });

    let created;
    try {
      created = await withGatewayTimeout(`${gateway.provider}.createPayment`, () =>
        gateway.createPayment({
          intentId: id,
          memberId: m.id,
          amountFils: input.amountFils,
          method: input.method,
          returnUrl: `${env.topupReturnUrl}?intent=${encodeURIComponent(id)}`,
        }),
      );
    } catch (err) {
      if (err instanceof GatewayUnavailableError) {
        // Rolls the key back with everything else. The client retries the same
        // attempt with the same key rather than being answered with a cached
        // failure forever.
        throw new ApiError(
          502,
          'gateway_unavailable',
          'We could not reach the payment provider. Try again in a moment.',
        );
      }
      throw err;
    }

    // created → redirected. She is being handed the hosted page.
    const [row] = await tx
      .update(topUpIntent)
      .set({
        pspReference: created.pspReference,
        redirectUrl: created.redirectUrl,
        status: 'redirected',
        updatedAt: new Date(),
      })
      .where(and(eq(topUpIntent.id, id), inArray(topUpIntent.status, predecessorsOf('redirected'))))
      .returning();

    if (!row) throw conflict('topup_not_open', 'That top-up is no longer open.');

    /**
     * THE CUSTOMER SHAPE — AND THE STORED REPLAY BODY IS THE SAME OBJECT.
     *
     * Projecting only at the `return` would have left the commission in the
     * idempotency record, and `routes/topups.ts` answers a lost unique-index
     * race by replaying `stored.body` verbatim. The leak would then be absent on
     * the first call and present on every retry — the worst version of it,
     * because a retry is the path nobody re-reads.
     *
     * So the projection happens once, above the store, and the response and its
     * replay are `TopUpIntentPublicSchema` by construction rather than by two
     * call sites agreeing.
     */
    const view = serialiseIntentForCustomer(row as TopUpIntentRow);
    await completeKey(tx, keyId, { status: 200, body: view });
    return view;
  });
}

// --------------------------------------------------------------- settling --

export type SettleSource = 'gateway_read' | 'webhook';

/** A verified callback, normalised by the adapter. */
export interface SettleEvent {
  provider: string;
  eventId: string;
  reportedStatus: string;
  payload: unknown;
}

export type SettleResult =
  | { kind: 'applied'; intent: TopUpIntentRow; credited: boolean }
  | { kind: 'unchanged'; intent: TopUpIntentRow; reason: 'illegal_transition' }
  | { kind: 'amount_mismatch'; intent: TopUpIntentRow }
  | { kind: 'duplicate_event' }
  | { kind: 'unknown_intent' };

interface ApplyInput {
  /** Exactly one of these two. */
  intentId?: string;
  pspReference?: string;
  outcome: GatewayOutcome;
  /** What the gateway says it took, for the mismatch check. */
  reportedAmountFils: Fils;
  source: SettleSource;
  event?: SettleEvent;
}

/**
 * Apply a gateway outcome to an intent. ONE transaction, whatever the outcome.
 *
 * Order inside it is load-bearing:
 *
 *   1. lock the intent (`FOR UPDATE`) — two deliveries of the same settlement
 *      serialise here rather than both reading `pending` and both crediting;
 *   2. decide the transition against the machine — an illegal one changes
 *      nothing and is still RECORDED, because a reconciliation that cannot see
 *      what the PSP said is guesswork;
 *   3. move the money, if the transition is `succeeded`;
 *   4. write the event row LAST, where `UNIQUE (provider, event_id)` turns a
 *      duplicate delivery into a rollback of everything above it.
 *
 * Step 4 and step 1 are two independent guards on the same failure. Either one
 * alone makes a duplicate callback credit once; both together mean it still
 * credits once when the PSP re-delivers under a NEW event id, which the event
 * index alone would not catch.
 */
async function applyOutcome(db: Db, input: ApplyInput): Promise<SettleResult> {
  return db.transaction(async (tx) => {
    const where = input.intentId
      ? eq(topUpIntent.id, input.intentId)
      : eq(topUpIntent.pspReference, input.pspReference ?? '');

    const rows = await tx.select().from(topUpIntent).where(where).for('update').limit(1);
    const intent = rows[0] as TopUpIntentRow | undefined;

    if (!intent) {
      if (input.event) {
        await tx.insert(gatewayEvent).values({
          provider: input.event.provider,
          eventId: input.event.eventId,
          pspReference: input.pspReference ?? '',
          intentId: null,
          reportedStatus: input.event.reportedStatus,
          outcome: 'ignored_unknown_intent',
          payload: input.event.payload as Record<string, unknown>,
        });
      }
      return { kind: 'unknown_intent' };
    }

    const target = statusForOutcome(input.outcome);

    // A processor reporting an amount we never asked for is not a settlement,
    // it is an incident. Crediting "whatever arrived" is how a 5 KD top-up
    // becomes a 500 KD one.
    if (input.outcome === 'succeeded' && input.reportedAmountFils !== intent.amountFils) {
      if (input.event) {
        await tx.insert(gatewayEvent).values({
          provider: input.event.provider,
          eventId: input.event.eventId,
          pspReference: intent.pspReference ?? '',
          intentId: intent.id,
          reportedStatus: input.event.reportedStatus,
          outcome: 'ignored_amount_mismatch',
          payload: input.event.payload as Record<string, unknown>,
        });
      }
      await writeAudit(tx, null, {
        salonId: intent.salonId,
        kind: 'risk',
        action: 'Top-up amount mismatch',
        detail:
          `${gateway.provider} reported ${input.reportedAmountFils} fils for ${intent.id}, ` +
          `which was created for ${intent.amountFils}. Not credited.`,
        source: 'system',
        subjectType: 'topup_intent',
        subjectId: intent.id,
        metadata: { reportedAmountFils: input.reportedAmountFils, source: input.source },
      });
      return { kind: 'amount_mismatch', intent };
    }

    // ------------------------------------------------------ the transition --
    if (!canTransition(intent.status, target.status)) {
      if (input.event) {
        await tx.insert(gatewayEvent).values({
          provider: input.event.provider,
          eventId: input.event.eventId,
          pspReference: intent.pspReference ?? '',
          intentId: intent.id,
          reportedStatus: input.event.reportedStatus,
          outcome: 'ignored_illegal_transition',
          payload: input.event.payload as Record<string, unknown>,
        });
      }
      return { kind: 'unchanged', intent, reason: 'illegal_transition' };
    }

    const now = new Date();
    let updated: TopUpIntentRow;
    let credited = false;

    if (target.status !== 'succeeded') {
      const [next] = await tx
        .update(topUpIntent)
        .set({ status: target.status, failureReason: target.failureReason, updatedAt: now })
        .where(
          and(eq(topUpIntent.id, intent.id), inArray(topUpIntent.status, predecessorsOf(target.status))),
        )
        .returning();
      if (!next) throw conflict('topup_transition_lost', 'That top-up moved on.');
      updated = next as TopUpIntentRow;
    } else {
      updated = await creditWallet(tx, intent, input.source, now);
      credited = true;
    }

    // ------------------------------------------------ the event row, last --
    // The unique index is the duplicate guard. It is written here so that a
    // second delivery rolls the credit above it back rather than committing a
    // credit and then discovering it was a repeat.
    if (input.event) {
      await tx.insert(gatewayEvent).values({
        provider: input.event.provider,
        eventId: input.event.eventId,
        pspReference: intent.pspReference ?? '',
        intentId: intent.id,
        reportedStatus: input.event.reportedStatus,
        outcome: 'applied',
        payload: input.event.payload as Record<string, unknown>,
      });
    }

    return { kind: 'applied', intent: updated, credited };
  });
}

/**
 * The credit, inside the caller's transaction. Non-negotiable #3's discipline,
 * pointed the other way: balance, transaction row, ledger pair, receipt job,
 * audit row and the intent's own status all commit together or not at all.
 */
async function creditWallet(
  tx: Parameters<Parameters<Db['transaction']>[0]>[0],
  intent: TopUpIntentRow,
  source: SettleSource,
  now: Date,
): Promise<TopUpIntentRow> {
  // FOR UPDATE: a top-up settling while a charge debits the same wallet must
  // not read a balance the charge is about to change.
  const memberRows = await tx
    .select()
    .from(member)
    .where(eq(member.id, intent.memberId))
    .for('update')
    .limit(1);
  const m = memberRows[0];
  if (!m) throw notFound('unknown_member', 'No such member.');

  const balanceAfter = add(fils(m.balanceFils), intent.creditFils);
  const txId = transactionId();
  const reference = intent.reference;

  await tx.update(member).set({ balanceFils: balanceAfter, updatedAt: now }).where(eq(member.id, m.id));

  await tx.insert(transaction).values({
    id: txId,
    memberId: m.id,
    salonId: intent.salonId,
    branchId: intent.branchId,
    /**
     * ALWAYS TRUE for a top-up. The branch on the intent is an attribution for a
     * NOT NULL column, not a place the money moved — she paid on her phone. See
     * migration 0012; a per-branch total that counts wallet top-ups as footfall
     * at whichever branch sorts first is exactly what the column exists to make
     * visible.
     */
    branchAssumed: true,
    kind: 'topup',
    // Signed, credit positive: what actually landed, both bonuses included.
    amountFils: intent.creditFils,
    // Carried across as the SPLIT the intent locked, not as the wire's single
    // number. This row is what a reconciliation report reads.
    bonusFils: intent.bonusFils,
    promoBonusFils: intent.promoBonusFils,
    promotionId: intent.promotionId,
    // Commission, recorded PER TRANSACTION — build-plan.md phase 2. The
    // customer serializer in http/serialise.ts does not emit it.
    feeFils: intent.feeFils,
    method: intent.method,
    status: 'settled',
    reference,
    createdByStaffId: null,
    createdAt: now,
    settledAt: now,
  });

  // ------------------------------------------------------------- ledger ---
  // Balanced, and checked at COMMIT by the constraint trigger from migration
  // 0001. Reading down the debits: the money the PSP is holding for us, the
  // merchant's own funding of the bonus it advertised, and the merchant's
  // commission to AVO. Credits: the customer's wallet, and AVO's income.
  const entries: Array<typeof ledgerEntry.$inferInsert> = [
    {
      transactionId: txId,
      salonId: intent.salonId,
      memberId: null,
      account: 'gateway_clearing',
      direction: 'debit',
      amountFils: intent.amountFils,
    },
    {
      transactionId: txId,
      salonId: intent.salonId,
      memberId: m.id,
      account: 'member_wallet',
      direction: 'credit',
      amountFils: intent.creditFils,
      balanceAfterFils: balanceAfter,
    },
  ];

  // One debit for both merchant-funded bonuses: they come out of the same
  // pocket, and `promotion_id` on the transaction is what separates a campaign's
  // cost from a tier's in a report. Splitting the LEDGER too would add an
  // account nobody reconciles against.
  const merchantFunded = add(intent.bonusFils, intent.promoBonusFils);
  if (merchantFunded > 0) {
    entries.push({
      transactionId: txId,
      salonId: intent.salonId,
      memberId: null,
      account: 'merchant_bonus_funding',
      direction: 'debit',
      amountFils: merchantFunded,
    });
  }

  if (intent.feeFils > 0) {
    entries.push(
      {
        transactionId: txId,
        salonId: intent.salonId,
        memberId: null,
        account: 'salon_revenue',
        direction: 'debit',
        amountFils: intent.feeFils,
      },
      {
        transactionId: txId,
        salonId: intent.salonId,
        memberId: null,
        account: 'avo_commission',
        direction: 'credit',
        amountFils: intent.feeFils,
      },
    );
  }

  await tx.insert(ledgerEntry).values(entries);

  // ----------------------------------------------------------- receipts ---
  // Rows, not network calls — the transactional outbox, same as the charge
  // path. `UNIQUE (transaction_id, channel)` means one receipt per credit PER
  // CHANNEL even if this code is reached twice: a replay collides on both
  // columns and is refused, while the two channels stay independent of each
  // other.
  await queueReceipts(tx, m, txId, {
    kind: 'topup',
    transactionId: txId,
    intentId: intent.id,
    amountFils: intent.amountFils,
    bonusFils: intent.bonusFils,
    creditFils: intent.creditFils,
    method: intent.method,
    reference,
    balanceAfterFils: balanceAfter,
  });

  // -------------------------------------------------------------- audit ---
  // Actor `null` → system. The money was moved by the processor confirming a
  // payment, not by whoever's request happened to observe it; recording the
  // customer as the actor of her own credit would be a fiction that a dispute
  // would have to unpick.
  await writeAudit(tx, null, {
    salonId: intent.salonId,
    kind: 'money',
    action: 'Top-up settled',
    detail: `${(intent.creditFils / 1000).toFixed(3)} KD credited to ${m.name}`,
    source: 'system',
    subjectType: 'topup_intent',
    subjectId: intent.id,
    amountFils: intent.creditFils,
    metadata: {
      transactionId: txId,
      method: intent.method,
      feeFils: intent.feeFils,
      bonusFils: intent.bonusFils,
      promoBonusFils: intent.promoBonusFils,
      promotionId: intent.promotionId,
      observedVia: source,
      provider: intent.provider,
      pspReference: intent.pspReference,
    },
  });

  // The intent's own move, conditional on it still being open. Zero rows here
  // means another transaction settled it first, and the throw rolls this credit
  // back — the last line of defence behind the row lock and the event index.
  const [next] = await tx
    .update(topUpIntent)
    .set({
      status: 'succeeded',
      failureReason: null,
      transactionId: txId,
      settledAt: now,
      updatedAt: now,
    })
    .where(and(eq(topUpIntent.id, intent.id), inArray(topUpIntent.status, predecessorsOf('succeeded'))))
    .returning();

  if (!next) throw conflict('topup_already_settled', 'That top-up has already settled.');
  return next as TopUpIntentRow;
}

// ------------------------------------------------------- the two entry points --

/**
 * Settle from OUR read of gateway state. This is what `GET /topups/{id}` uses,
 * and it is the only thing the customer's return from the hosted page causes:
 * she comes back with a URL, we go and ask the processor.
 */
export async function settleFromGatewayRead(
  db: Db,
  intent: TopUpIntentRow,
  outcome: GatewayOutcome,
  reportedAmountFils: Fils,
): Promise<SettleResult> {
  return applyOutcome(db, {
    intentId: intent.id,
    outcome,
    reportedAmountFils,
    source: 'gateway_read',
  });
}

/**
 * Settle from a callback whose signature has already been verified.
 *
 * The unique violation on `(provider, event_id)` is caught HERE rather than
 * left to the route, because a duplicate delivery is not an error — it is the
 * answer. The second delivery's whole transaction rolls back, nothing is
 * credited, and the route turns `duplicate_event` into a 200. A 4xx would make
 * the PSP retry the same delivery for days.
 */
export async function settleFromWebhook(
  db: Db,
  params: {
    provider: string;
    eventId: string;
    pspReference: string;
    outcome: GatewayOutcome;
    reportedStatus: string;
    amountFils: Fils;
    payload: unknown;
  },
): Promise<SettleResult> {
  try {
    return await applyOutcome(db, {
      pspReference: params.pspReference,
      outcome: params.outcome,
      reportedAmountFils: params.amountFils,
      source: 'webhook',
      event: {
        provider: params.provider,
        eventId: params.eventId,
        reportedStatus: params.reportedStatus,
        payload: params.payload,
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { kind: 'duplicate_event' };
    throw err;
  }
}

// ---------------------------------------------------------- GET /topups/{id} --

/**
 * The authoritative status read — api-contract.md § TopUpIntent client rule 1.
 *
 * If the intent is still open, ASK THE GATEWAY, then apply whatever it says
 * through the machine. If it is terminal, report what happened; a terminal
 * intent is not re-read, because there is no answer a processor could give that
 * we would act on, and asking would only invite a regression.
 *
 * A gateway that cannot be reached does not change anything. The stored status
 * is returned as-is: we report what we know, never what the client hoped.
 *
 * Answers the CUSTOMER shape — no `feeFils`, on any of the five return paths
 * below. This is a wallet endpoint; the commission belongs to the merchant and
 * platform views.
 */
export async function readTopUp(
  db: Db,
  principal: MemberPrincipal,
  id: string,
  simulate?: GatewayOutcome | undefined,
): Promise<TopUpIntentPublic> {
  const rows = await db.select().from(topUpIntent).where(eq(topUpIntent.id, id)).limit(1);
  const intent = rows[0] as TopUpIntentRow | undefined;

  // Scoped to the caller. Another customer's intent is not "forbidden", it does
  // not exist — a 403 would confirm the id is real.
  if (!intent || intent.memberId !== principal.id) {
    throw notFound('unknown_topup', 'No such top-up.');
  }

  if (!OPEN_STATUSES.includes(intent.status) || !intent.pspReference) {
    return serialiseIntentForCustomer(intent);
  }

  let state;
  try {
    state = await withGatewayTimeout(`${gateway.provider}.fetchPayment`, () =>
      gateway.fetchPayment(intent.pspReference as string, { simulate }),
    );
  } catch {
    // Unreachable processor: report the intent unchanged. Never invent a status.
    return serialiseIntentForCustomer(intent);
  }

  const result = await settleFromGatewayRead(db, intent, state.outcome, state.amountFils);
  if (result.kind === 'applied' || result.kind === 'unchanged') {
    return serialiseIntentForCustomer(result.intent);
  }
  if (result.kind === 'amount_mismatch') return serialiseIntentForCustomer(result.intent);
  return serialiseIntentForCustomer(intent);
}

/** `POST /topups` input validation lives in the route; this is the method list. */
export const TOPUP_METHODS: PaymentMethod[] = ['knet', 'card', 'applepay'];

export function parseMethod(value: unknown): PaymentMethod {
  const method = (value ?? 'knet') as PaymentMethod;
  if (!TOPUP_METHODS.includes(method)) {
    throw badRequest('invalid_method', 'method must be knet, card or applepay.');
  }
  return method;
}
