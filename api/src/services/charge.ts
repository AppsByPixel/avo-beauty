/**
 * POST /charges — the one flow to get exactly right.
 *
 * api-contract.md § Charging, as ONE transaction:
 *
 *   1. validate and consume the QR token (single use)
 *   2. apply any held deposit as a credit line
 *   3. debit the wallet — rejecting if the remainder exceeds balance
 *   4. increment visits or stamps per salon.loyaltyMode
 *   5. evaluate a tier climb / stamp-target reward
 *   6. queue the WhatsApp receipt
 *
 * "Partial application is not acceptable. If step 3 fails, nothing else
 * happened."
 *
 * TWO ORDERING DECISIONS, BOTH DELIBERATE
 * ---------------------------------------
 * The contract lists token consumption first. This implementation VALIDATES it
 * first and CONSUMES it last, after the debit has succeeded. That is not a
 * deviation from the contract's outcome — it is the only ordering that delivers
 * it. Lane D found the mock consuming before the balance check, so a 402 burned
 * the customer's QR: she tops up at the counter, the artist rescans, and the
 * same code is dead. "Nothing else happened" has to include the token.
 *
 * The receipt is the mirror image: it is QUEUED inside the transaction (a row in
 * `receipt_job`) and SENT outside it. An awaited WhatsApp call inside an open
 * transaction holds the member row lock for the length of a third party's
 * timeout, and turns a provider outage into a declined charge at the counter.
 * See db/schema/receipt.ts.
 *
 * WHY THE FAILURE PATHS THROW
 * ---------------------------
 * Every refusal — 402, 410, 409 — throws out of the transaction callback, which
 * rolls back. That is what makes the guarantees free rather than carefully
 * maintained: the debit, the loyalty tick, the receipt row, the audit row AND
 * the idempotency key all vanish together. In particular the key vanishing is
 * what lets the scanner retry the same attempt after a top-up, instead of being
 * answered with a cached 402 forever.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { add, fils, subtract, type Fils } from '@avo/types';
import type { Db } from '../db/client';
import { member } from '../db/schema/member';
import { salon } from '../db/schema/salon';
import { service } from '../db/schema/service';
import { transaction } from '../db/schema/transaction';
import { ledgerEntry } from '../db/schema/ledger';
import { loyaltyEvent } from '../db/schema/loyaltyEvent';
import type { StaffPrincipal } from '../auth/principal';
import { badRequest, conflict, insufficientBalance, notFound } from '../http/errors';
import { applyStamps, applyVisits, type LoyaltyOutcome } from './loyalty';
import { decideEarning, loadPromotionInputs, NO_PROMOTION } from './promotions';
import { consumeToken, peekToken, TokenOutsideSalonError } from './walletToken';
import { claimKey, completeKey } from './idempotency';
import { queueReceipts } from './receipts';
import { writeAudit } from './audit';

/** Voidable for 15 minutes — api-contract.md § StaffUser, "reverse within 15 min". */
export const VOID_WINDOW_MINUTES = 15;

export interface ChargeInput {
  memberId: string;
  serviceIds: string[];
  token?: string | undefined;
  branchId?: string | undefined;
}

export interface ChargeContext {
  principal: StaffPrincipal;
  idempotency: { scope: string; endpoint: string; key: string; requestHash: string };
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface ChargeResult {
  transaction: {
    id: string;
    memberId: string;
    branchId: string;
    kind: 'charge';
    amountFils: number;
    bonusFils: number;
    method: 'wallet';
    status: 'settled';
    reference: string;
    createdAt: string;
  };
  balanceAfterFils: number;
  depositAppliedFils: number;
  loyalty: LoyaltyOutcome;
  voidableUntil: string;
  /**
   * What the promotion set decided for THIS charge, at ONE instant, on the
   * server. Null when nothing was live — never omitted, so a scanner can tell
   * "no promotion applied" from "this API is too old to say".
   *
   * The scanner renders it and the receipt quotes it. It is an OUTCOME, not an
   * input: `POST /charges` reads no promotion field from its body at all, so a
   * client claiming a boost that is not live is not refused, it is simply not
   * consulted. Non-negotiable #2.
   */
  happyHour: {
    id: string | null;
    visitMultiplier: number;
    stampMultiplier: number;
    creditFils: number;
    minutesRemaining: number;
  } | null;
}

function transactionId(): string {
  return `TX-${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;
}

export async function performCharge(
  db: Db,
  input: ChargeInput,
  ctx: ChargeContext,
): Promise<ChargeResult> {
  return db.transaction(async (tx) => {
    // ---------------------------------------------------------------- 0. key --
    // Claimed FIRST, inside the transaction. A duplicate raises a unique
    // violation here rather than after money has moved, and the caller catches
    // it to replay the winner's stored response.
    const keyId = await claimKey(tx, ctx.idempotency);

    // ------------------------------------------------------------- 1. member --
    // FOR UPDATE serialises concurrent charges against the same wallet, so the
    // balance this transaction reads is the balance it debits.
    const memberRows = await tx
      .select()
      .from(member)
      .where(eq(member.id, input.memberId))
      .for('update')
      .limit(1);

    const m = memberRows[0];
    if (!m) throw notFound('unknown_member', 'No such member.');
    if (m.salonId !== ctx.principal.salonId) {
      // A staff member charging another salon's customer.
      throw notFound('unknown_member', 'No such member.');
    }

    // -------------------------------------------------- 2. validate the token --
    // Validated, NOT consumed. Consumption is step 8, after the debit.
    if (input.token) {
      // A token from another salon does not resolve at all (the tenant boundary
      // lives in peekToken). Here it is reported as the mismatch it is: this
      // handler has already established that `m` is a real member of the
      // caller's own salon, so "no such member" would be false, and the artist
      // needs to be told the CODE is wrong, not the customer.
      let peeked;
      try {
        peeked = await peekToken(db, input.token, { salonId: ctx.principal.salonId });
      } catch (err) {
        if (err instanceof TokenOutsideSalonError) {
          throw conflict(
            'token_member_mismatch',
            'That code belongs to a different customer. Ask for a fresh one.',
          );
        }
        throw err;
      }

      // The token is the authority for whose wallet this is. Without this check
      // the handler trusts `body.memberId`, and one customer's QR could be
      // charged against another customer's balance.
      if (peeked.memberId !== m.id) {
        throw conflict(
          'token_member_mismatch',
          'That code belongs to a different customer. Ask for a fresh one.',
        );
      }
    }

    // ------------------------------------------------------------- 3. basket --
    const rows = await tx
      .select({ id: service.id, name: service.name, priceFils: service.priceFils })
      .from(service)
      .where(
        and(
          inArray(service.id, input.serviceIds),
          eq(service.salonId, ctx.principal.salonId),
          eq(service.active, true),
        ),
      );

    // An unknown id must not silently price at 0 and settle a real transaction
    // with a voidable window for work that does not exist — Lane D's finding.
    const found = new Set(rows.map((r) => r.id));
    const unknown = input.serviceIds.filter((id) => !found.has(id));
    if (unknown.length > 0) {
      throw badRequest('invalid_services', `Unknown service: ${unknown.join(', ')}.`, { unknown });
    }

    // Priced from the database. A price in the request body is a scanner that
    // can charge 0.000 for a colour — non-negotiable #2.
    const gross = rows.reduce<Fils>((sum, r) => add(sum, fils(r.priceFils)), fils(0));

    // ------------------------------------------------- 4. apply held deposit --
    // Bookings are not built yet, so this is always 0 today. It is computed
    // rather than hardcoded so the deposit line exists in the ledger the moment
    // deposits do.
    const heldDeposit = fils(0);
    const due = subtract(gross, heldDeposit);

    // -------------------------------------------------------------- 5. debit --
    const balance = fils(m.balanceFils);
    if (due > balance) {
      // Nothing else happened: this throw rolls the transaction back, so the
      // idempotency key, and above all the wallet token, are untouched.
      throw insufficientBalance(due, balance);
    }
    const balanceAfter = subtract(balance, due);

    const txId = transactionId();
    const branchId = input.branchId ?? (await defaultBranchId(tx, ctx.principal.salonId));
    const now = new Date();

    await tx
      .update(member)
      .set({ balanceFils: balanceAfter, updatedAt: now })
      .where(eq(member.id, m.id));

    // ------------------------------------------------- 6. transaction record --
    await tx.insert(transaction).values({
      id: txId,
      memberId: m.id,
      salonId: ctx.principal.salonId,
      branchId,
      kind: 'charge',
      amountFils: fils(-due),
      method: 'wallet',
      status: 'settled',
      reference: `AVO-CHG-${txId.slice(3)}`,
      createdByStaffId: ctx.principal.id,
      createdAt: now,
      settledAt: now,
    });

    // ------------------------------------------------------------- 7. ledger --
    // Double entry, balanced per transaction. The DEFERRABLE constraint trigger
    // from migration 0001 checks the pair at COMMIT, so a debit without its
    // matching credit does not commit.
    if (due > 0) {
      await tx.insert(ledgerEntry).values([
        {
          transactionId: txId,
          salonId: ctx.principal.salonId,
          memberId: m.id,
          account: 'member_wallet',
          direction: 'debit',
          amountFils: due,
          balanceAfterFils: balanceAfter,
        },
        {
          transactionId: txId,
          salonId: ctx.principal.salonId,
          memberId: null,
          account: 'salon_revenue',
          direction: 'credit',
          amountFils: due,
        },
      ]);
    }
    if (heldDeposit > 0) {
      await tx.insert(ledgerEntry).values([
        {
          transactionId: txId,
          salonId: ctx.principal.salonId,
          memberId: m.id,
          account: 'deposit_held',
          direction: 'debit',
          amountFils: heldDeposit,
        },
        {
          transactionId: txId,
          salonId: ctx.principal.salonId,
          memberId: null,
          account: 'salon_revenue',
          direction: 'credit',
          amountFils: heldDeposit,
        },
      ]);
    }

    // ------------------------------------------------- 8. consume the token --
    // The debit has succeeded, so the code is spent. A conditional UPDATE whose
    // row count decides the outcome: zero rows means another scanner won the
    // race, and the 410 it throws rolls this whole transaction back.
    if (input.token) {
      await consumeToken(
        tx,
        input.token,
        { staffId: ctx.principal.id, transactionId: txId },
        { salonId: ctx.principal.salonId },
      );
    }

    // ------------------------------------------------------ 9. loyalty + tier --
    const salonRows = await tx
      .select()
      .from(salon)
      .where(eq(salon.id, ctx.principal.salonId))
      .limit(1);
    const s = salonRows[0];
    if (!s) throw notFound('unknown_salon', 'No such salon.');

    /**
     * ------------------------------------------- 9a. the earning multiplier --
     *
     * THE SERVER DECIDES, HERE, ONCE.
     *
     * Read inside the money transaction, not before it: a merchant who switches
     * a window off while this charge is in flight must not still fund it. And
     * evaluated at ONE instant — `now`, taken at step 5 — so a charge submitted
     * at 17:59:59 and committed at 18:00:01 resolves against a single moment
     * rather than once per read. That single moment is what `completeKey` stores
     * below, which is what makes an idempotent replay return the SAME reward
     * instead of re-evaluating against the replay clock. Re-evaluating is the
     * boundary bug that pays twice.
     *
     * Nothing about the client reaches this. `ChargeInput` has no promotion
     * field to read; a scanner that believes a boost is live and is wrong earns
     * the ordinary rate, silently and correctly. Non-negotiable #2.
     */
    /**
     * `input.branchId`, NOT the `branchId` the row was attributed with.
     *
     * They differ whenever the branch was not established, in which case
     * `branchId` above is `defaultBranchId()` — the salon's first branch by id,
     * chosen so the NOT NULL column has a value. Deciding a customer's earning
     * rate from that would pay her Kuwait City's boost because 'BR-KWC' sorts
     * before 'BR-SAL'. See services/promotions.ts § PromotionInputs.
     *
     * TODAY IT IS ALWAYS NULL, AND THAT IS THE CORRECT STATE RATHER THAN A GAP.
     * `POST /charges` takes `{ memberId, serviceIds[], token }` — the contract's
     * body, which has no branch in it — and routes/charges.ts does not read one.
     * It must not start: a client naming its own branch is a client choosing its
     * own multiplier, which is non-negotiable #2 with extra steps. The branch has
     * to arrive from something the server established, and `StaffPrincipal`
     * carries branch ACCESS rather than a current location, so that is a
     * branch-bound scanner session — flagged, not guessed at. Until then branch
     * boosts are stored, served to both clients, and applied by neither.
     */
    const promoInputs = await loadPromotionInputs(
      tx,
      ctx.principal.salonId,
      input.branchId ?? null,
    );
    const earning = promoInputs
      ? decideEarning(promoInputs, now)
      : { ...NO_PROMOTION, decidedAt: now };

    // Attribution on the charge row itself, so "why did this visit count twice"
    // is answerable from the transaction a customer is looking at.
    if (earning.happyHourId) {
      await tx
        .update(transaction)
        .set({ promotionId: earning.happyHourId })
        .where(eq(transaction.id, txId));
    }

    let loyalty: LoyaltyOutcome;
    if (s.loyaltyMode === 'stamps') {
      const wasReady = (m.stamps ?? 0) >= (s.stampTarget ?? 0);
      loyalty = applyStamps(s.stampTarget ?? 0, m.stamps ?? 0, earning.stampMultiplier);
      await tx.update(member).set({ stamps: loyalty.stamps }).where(eq(member.id, m.id));

      // Only the charge that FILLS the card. Without `wasReady`, every further
      // visit on an already-full card would announce the same reward again.
      if (loyalty.rewardReady && !wasReady) {
        await tx.insert(loyaltyEvent).values({
          salonId: ctx.principal.salonId,
          memberId: m.id,
          transactionId: txId,
          kind: 'stamp_reward_ready',
          stampsAfter: loyalty.stamps,
          stampTarget: loyalty.target,
        });
      }
    } else {
      loyalty = applyVisits(s.tiers ?? [], m.visits, m.tier ?? null, earning.visitMultiplier);
      await tx
        .update(member)
        .set({ visits: loyalty.visits, tier: loyalty.tier })
        .where(eq(member.id, m.id));

      /**
       * "Reem S. reached Gold tier" — the one line of the Overview feed that is
       * not a transaction row. `climbed` is computed just above and was
       * previously discarded, so the moment a member's standing changed was not
       * recoverable from anything stored: `member.tier` holds the current rung
       * and nothing held the move. See db/schema/loyaltyEvent.ts.
       *
       * Written inside this transaction like everything else in this function. A
       * climb recorded but rolled back, or applied but unrecorded, is a feed
       * that disagrees with the wallet.
       *
       * `climbed` is any CHANGE of rung, which after a republished ladder could
       * in principle be a descent. Nothing here assumes a direction — the row
       * carries `from_tier` and `to_tier` and lets the reader see which it was.
       */
      if (loyalty.climbed && loyalty.tier !== null) {
        await tx.insert(loyaltyEvent).values({
          salonId: ctx.principal.salonId,
          memberId: m.id,
          transactionId: txId,
          kind: 'tier_climb',
          fromTier: m.tier ?? null,
          toTier: loyalty.tier,
        });
      }
    }

    /**
     * ------------------------------------------ 9b. a flat promotion credit --
     *
     * `credit3` — 3.000 KD into the wallet, granted by a live window.
     *
     * ITS OWN TRANSACTION ROW, and that is the answer to the schema obstacle
     * that was flagged before this was built. `transaction.bonus_fils` is
     * constrained to top-ups, so the question was whether to relax the
     * constraint. It should not be relaxed: this is not a top-up bonus, it is a
     * credit, and burying it inside the charge row would net a 3.000 credit
     * against a 15.000 debit and leave the activity feed unable to show the
     * customer either number. As an `adjustment` it is a line she can see, the
     * sign CHECK already permits it, and the ledger already balances it.
     *
     * Written AFTER the debit deliberately, against the balance the debit left,
     * so `member.balance_fils >= 0` is never satisfied only because a credit
     * happened to be applied first.
     */
    let balanceFinal = balanceAfter;
    if (earning.creditFils > 0 && earning.happyHourId) {
      const creditId = transactionId();
      balanceFinal = add(balanceAfter, fils(earning.creditFils));

      await tx.update(member).set({ balanceFils: balanceFinal, updatedAt: now }).where(eq(member.id, m.id));

      await tx.insert(transaction).values({
        id: creditId,
        memberId: m.id,
        salonId: ctx.principal.salonId,
        branchId,
        kind: 'adjustment',
        amountFils: fils(earning.creditFils),
        method: 'wallet',
        status: 'settled',
        reference: `AVO-PRO-${creditId.slice(3)}`,
        note: 'Happy hour credit',
        promotionId: earning.happyHourId,
        createdByStaffId: ctx.principal.id,
        createdAt: now,
        settledAt: now,
      });

      await tx.insert(ledgerEntry).values([
        {
          transactionId: creditId,
          salonId: ctx.principal.salonId,
          memberId: null,
          // The merchant funds her own promotion, exactly as she funds a tier
          // bonus on a top-up. Same account, so the two are one budget line in
          // a report and `promotion_id` is what separates them.
          account: 'merchant_bonus_funding',
          direction: 'debit',
          amountFils: fils(earning.creditFils),
        },
        {
          transactionId: creditId,
          salonId: ctx.principal.salonId,
          memberId: m.id,
          account: 'member_wallet',
          direction: 'credit',
          amountFils: fils(earning.creditFils),
          balanceAfterFils: balanceFinal,
        },
      ]);
    }

    // ----------------------------------------------- 10. queue the receipts --
    // Rows, not network calls. The worker sends them after this commits, one
    // channel at a time and independently — see services/receipts.ts.
    await queueReceipts(tx, m, txId, {
      kind: 'charge',
      transactionId: txId,
      amountFils: due,
      services: rows.map((r) => ({ id: r.id, name: r.name, priceFils: r.priceFils })),
      balanceAfterFils: balanceFinal,
    });

    // ------------------------------------------------------------ 11. audit --
    await writeAudit(tx, ctx.principal, {
      salonId: ctx.principal.salonId,
      kind: 'money',
      action: 'Charge taken',
      detail: `${(due / 1000).toFixed(3)} KD charged to ${m.name}`,
      source: 'scanner',
      subjectType: 'transaction',
      subjectId: txId,
      amountFils: -due,
      metadata: {
        serviceIds: input.serviceIds,
        tokenUsed: Boolean(input.token),
        // The promotion decision, stamped into the audit line. A merchant asking
        // "why did this charge count double" gets the window id and the instant
        // it was evaluated at, not a re-derivation from today's clock.
        promotion: earning.happyHourId
          ? {
              happyHourId: earning.happyHourId,
              visitMultiplier: earning.visitMultiplier,
              stampMultiplier: earning.stampMultiplier,
              creditFils: earning.creditFils,
              decidedAt: earning.decidedAt.toISOString(),
            }
          : null,
      },
      ipAddress: ctx.ipAddress ?? null,
      userAgent: ctx.userAgent ?? null,
    });

    const result: ChargeResult = {
      transaction: {
        id: txId,
        memberId: m.id,
        branchId,
        kind: 'charge',
        amountFils: -due,
        bonusFils: 0,
        method: 'wallet',
        status: 'settled',
        reference: `AVO-CHG-${txId.slice(3)}`,
        createdAt: now.toISOString(),
      },
      balanceAfterFils: balanceFinal,
      depositAppliedFils: heldDeposit,
      loyalty,
      voidableUntil: new Date(now.getTime() + VOID_WINDOW_MINUTES * 60_000).toISOString(),
      happyHour: earning.happyHourId
        ? {
            id: earning.happyHourId,
            visitMultiplier: earning.visitMultiplier,
            stampMultiplier: earning.stampMultiplier,
            creditFils: earning.creditFils,
            minutesRemaining: earning.minutesRemaining,
          }
        : null,
    };

    // ------------------------------------------------- 12. store the response --
    // Same transaction, so the key and its answer commit with the money.
    await completeKey(tx, keyId, { status: 200, body: result }, txId);

    return result;
  });
}

/** A wallet-originated charge is attributed to the salon's first branch. */
async function defaultBranchId(
  tx: Parameters<Parameters<Db['transaction']>[0]>[0],
  salonId: string,
): Promise<string> {
  const rows = await tx.execute(
    sql`SELECT id FROM branch WHERE salon_id = ${salonId} ORDER BY id LIMIT 1`,
  );
  const first = (rows as unknown as Array<{ id: string }>)[0];
  if (!first) throw notFound('no_branch', 'That salon has no branch.');
  return first.id;
}
