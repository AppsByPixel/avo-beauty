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
import { receiptJob } from '../db/schema/receipt';
import type { StaffPrincipal } from '../auth/principal';
import { badRequest, conflict, insufficientBalance, notFound } from '../http/errors';
import { applyStamps, applyVisits, type LoyaltyOutcome } from './loyalty';
import { consumeToken, peekToken } from './walletToken';
import { claimKey, completeKey } from './idempotency';
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
      const peeked = await peekToken(db, input.token);
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
      await consumeToken(tx, input.token, {
        staffId: ctx.principal.id,
        transactionId: txId,
      });
    }

    // ------------------------------------------------------ 9. loyalty + tier --
    const salonRows = await tx
      .select()
      .from(salon)
      .where(eq(salon.id, ctx.principal.salonId))
      .limit(1);
    const s = salonRows[0];
    if (!s) throw notFound('unknown_salon', 'No such salon.');

    let loyalty: LoyaltyOutcome;
    if (s.loyaltyMode === 'stamps') {
      loyalty = applyStamps(s.stampTarget ?? 0, m.stamps ?? 0, 1);
      await tx.update(member).set({ stamps: loyalty.stamps }).where(eq(member.id, m.id));
    } else {
      loyalty = applyVisits(s.tiers ?? [], m.visits, m.tier ?? null, 1);
      await tx
        .update(member)
        .set({ visits: loyalty.visits, tier: loyalty.tier })
        .where(eq(member.id, m.id));
    }

    // ------------------------------------------------ 10. queue the receipt --
    // A row, not a network call. The worker sends it after this commits.
    await tx.insert(receiptJob).values({
      transactionId: txId,
      memberId: m.id,
      channel: 'whatsapp',
      payload: {
        transactionId: txId,
        amountFils: due,
        services: rows.map((r) => ({ id: r.id, name: r.name, priceFils: r.priceFils })),
        balanceAfterFils: balanceAfter,
      },
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
      metadata: { serviceIds: input.serviceIds, tokenUsed: Boolean(input.token) },
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
      balanceAfterFils: balanceAfter,
      depositAppliedFils: heldDeposit,
      loyalty,
      voidableUntil: new Date(now.getTime() + VOID_WINDOW_MINUTES * 60_000).toISOString(),
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
