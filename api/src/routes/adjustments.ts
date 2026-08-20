/**
 * `POST /members/{id}/adjustments` — the owner console's Wallet adjust.
 *
 * api-contract.md § Operations: "| Owner | Wallet adjust | POST /members/{id}/
 * adjustments |". The design draws it in the console's ACCOUNTS section, inside
 * the customer detail card: a whole-KD stepper with "Add" and "Deduct" — one
 * operation, two directions — and the console's own audit mock shows what a row
 * must read like afterwards: "Wallet adjusted · +5.000 KD to Noura S. · service
 * complaint". That last clause is load-bearing: an adjustment WITHOUT a stated
 * reason is an unexplained balance change in a dispute two years later, so
 * `reason` is required, and it lands in both the transaction's `note` and the
 * audit row.
 *
 * THIS IS A MONEY PATH AND IS BUILT AS ONE:
 *
 *   - IDEMPOTENCY-KEY REQUIRED (#4). The key is claimed INSIDE the same
 *     transaction as the effect and completed there too — the charge path's
 *     discipline exactly, so a retry after a lost response replays the stored
 *     body instead of moving money twice.
 *   - ONE TRANSACTION: the member row FOR UPDATE, the `adjustment` transaction
 *     row, the balanced ledger pair, the balance move, the audit row. All or
 *     nothing.
 *   - THE `adjustment` KIND ALREADY EXISTS and is reused, not re-invented: it is
 *     what the void writes, what the happy-hour credit writes, and what the seed
 *     opens balances with. `transaction_amount_sign_matches_kind` already pins
 *     `adjustment <> 0`, so the signed amount is the kind's own shape.
 *
 * THE LEDGER PAIR follows the seed's opening-balance precedent, argued there at
 * length: `member_wallet` against `gateway_clearing`, "so the pair reads the
 * same way a real top-up does. Nothing aggregates ledger accounts for a report;
 * only `transaction.kind` does". `salon_revenue` would be wrong here — that is
 * the VOID's counter-account, for money that had been earned and is being
 * given back; a console adjustment is money entering or leaving the platform's
 * books by fiat, which is exactly what the clearing account already absorbs for
 * the seed. A credit: wallet credit / clearing debit. A debit: wallet debit /
 * clearing credit. `ledger_entries_must_balance` enforces the pairing either
 * way.
 *
 * THE NEGATIVE-BALANCE REFUSAL IS THE DATABASE'S. A deduction below zero
 * violates `member_balance_non_negative` — the same CHECK that makes a charge
 * unable to overdraw — and this handler deliberately does NOT pre-screen for
 * it: the UPDATE runs, the constraint refuses, and the violation is translated
 * into a 409 carrying the server's balance. A pre-check would work today and
 * silently become the only guard the day someone relaxes the transaction
 * boundary; letting the constraint fire keeps the database the control and the
 * handler the translator (the same reasoning as signup's duplicate-phone
 * handling: the SELECT is the friendly half, the constraint is the authority).
 *
 * GATE: `requirePlatform(req, 'accounts')`. Argued rather than defaulted: the
 * design draws this control INSIDE the Accounts section's customer card, and
 * platformAdmin.ts's rule is that an endpoint is gated with the screen it
 * appears on (`approvals` gates the throttle drawn inside Approvals for that
 * reason). `controls` was the plausible alternative — it gates the money
 * SWITCHES — but those are platform RULES (commission rates, flags); this is a
 * money ACT on one named customer, performed from her account card. An analyst
 * with Analytics-only access holds `accounts: false` under every preset, so the
 * strictness the census checks for is real.
 *
 * A TOMBSTONE IS REFUSED. The erasure job scrubs a member to a row that names
 * nobody; adjusting it would move real money into a wallet nobody can spend
 * from and nobody can be told about — there is no one to hold the balance. 409
 * `member_erased`, before any money statement. A member in the DELETION WINDOW
 * is adjustable (she can still sign in, spend, and change her mind), and the
 * adjustment deliberately does NOT touch her deletion clock: a credit she did
 * not ask for is not evidence she wants the account kept — unlike a top-up,
 * which is her own money and her own statement (services/topup.ts § "cancels a
 * pending deletion"). If the credit leaves a balance at the due date, the
 * erasure job's `deferredBalance` guard already refuses to erase a funded
 * wallet, so the interaction is safe by construction and visible in the job's
 * report.
 *
 * WHAT SHE SEES: the row rides `GET /members/me/transactions` as
 * `kind: "adjustment"` with reference `AVO-ADJ-…` — the same honest shape the
 * void and the happy-hour credit already render as. The REASON does not reach
 * her: `serialiseTransactionForCustomer` does not emit `note`, and adding it is
 * a `TransactionSchema` change in trunk-owned packages/types. REPORTED, not
 * taken — whether "service complaint" is copy a customer should read is a
 * product call anyway.
 */

import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { formatMoney, fils } from '@avo/types';
import { db } from '../db/client';
import { member } from '../db/schema/member';
import { ledgerEntry } from '../db/schema/ledger';
import { transaction } from '../db/schema/transaction';
import { requirePlatform } from '../auth/principal';
import { conflict, notFound } from '../http/errors';
import { parseSignedFils, requireString } from '../money/validate';
import {
  awaitCommittedKey,
  claimKey,
  completeKey,
  hashRequestBody,
  isUniqueViolation,
  principalScope,
  readIdempotencyKey,
} from '../services/idempotency';
import { writeAudit } from '../services/audit';
import { serialiseTransactionForMerchant } from '../http/serialise';
import { randomUUID } from 'node:crypto';

/**
 * WHICH CHECK constraint fired — the 23514 sibling of `violatedConstraint`.
 *
 * FOUND BY THE RACE, not by reading: the first version reused
 * `violatedConstraint(err)`, whose contract is UNIQUE violations only (it
 * returns null unless `code === '23505'`), and a CHECK violation is code 23514.
 * The constraint name was sitting in the error the whole time and the helper
 * refused to read it — so the losing half of two concurrent deductions answered
 * 500 instead of the 409 this file promises. Postgres puts the name in
 * `constraint_name` either way; the two helpers differ only in which class of
 * refusal they admit to reading.
 */
const CHECK_VIOLATION = '23514';
function violatedCheck(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  if ((err as { code?: string }).code !== CHECK_VIOLATION) return null;
  return (
    (err as { constraint_name?: string }).constraint_name ??
    (err as { constraint?: string }).constraint ??
    null
  );
}

export async function registerAdjustmentRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string } }>('/members/:id/adjustments', async (req, reply) => {
    // The gate first, before the key is even read — an anonymous caller learns
    // nothing about this endpoint's vocabulary, not even that it wants a key.
    const p = requirePlatform(req, 'accounts');

    const key = readIdempotencyKey(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const amountFils = parseSignedFils(body.amountFils);
    const reason = requireString(body.reason, 'reason', 300);

    const idem = {
      scope: principalScope(p),
      endpoint: 'POST /members/:id/adjustments',
      key,
      requestHash: hashRequestBody({ memberId: req.params.id, amountFils, reason }),
    };

    const run = async () => {
      const adjId = `TX-ADJ-${randomUUID().slice(0, 12)}`;
      const now = new Date();

      return db.transaction(async (tx) => {
        // The claim lives and dies with the effect — a rolled-back adjustment
        // releases its key, a committed one stores its response beside it.
        const keyId = await claimKey(tx, idem);

        const [m] = await tx
          .select()
          .from(member)
          .where(eq(member.id, req.params.id))
          .for('update')
          .limit(1);
        if (!m) throw notFound('unknown_member', 'No such customer.');

        // Nobody holds a tombstone's balance. Refused by name, before any
        // money statement — see the header.
        if (m.erasedAt !== null) {
          throw conflict('member_erased', 'That account has been erased and cannot be adjusted.');
        }

        /**
         * NO PRE-CHECK on the resulting balance — deliberately. The UPDATE
         * carries the arithmetic and `member_balance_non_negative` is the
         * refusal; the catch below translates it. See the header.
         */
        await tx.insert(transaction).values({
          id: adjId,
          memberId: m.id,
          salonId: m.salonId,
          /**
           * The console adjusts a SALON-level wallet; no branch is named by the
           * design's card and inventing one would put fiat money in one
           * branch's till. `branchId` is NOT NULL, so the salon's first branch
           * carries it with `branchAssumed: true` — the same honest flag the
           * charge path uses for a branch the server guessed.
           */
          branchId: (
            await tx.query.branch.findFirst({
              where: (b, { eq: eqB }) => eqB(b.salonId, m.salonId),
              orderBy: (b, { asc }) => asc(b.id),
            })
          )?.id as string,
          branchAssumed: true,
          kind: 'adjustment',
          amountFils,
          method: 'wallet',
          status: 'settled',
          reference: `AVO-ADJ-${adjId.slice(7)}`,
          note: reason,
          createdAt: now,
          settledAt: now,
        });

        const balanceAfter = m.balanceFils + amountFils;
        await tx
          .update(member)
          .set({ balanceFils: fils(balanceAfter), updatedAt: now })
          .where(and(eq(member.id, m.id), isNull(member.erasedAt)));

        await tx.insert(ledgerEntry).values([
          {
            transactionId: adjId,
            salonId: m.salonId,
            memberId: m.id,
            account: 'member_wallet',
            direction: amountFils > 0 ? 'credit' : 'debit',
            amountFils: fils(Math.abs(amountFils)),
            balanceAfterFils: fils(balanceAfter),
          },
          {
            transactionId: adjId,
            salonId: m.salonId,
            memberId: null,
            account: 'gateway_clearing',
            direction: amountFils > 0 ? 'debit' : 'credit',
            amountFils: fils(Math.abs(amountFils)),
          },
        ]);

        await writeAudit(tx, p, {
          salonId: m.salonId,
          kind: 'money',
          action: 'Wallet adjusted',
          // The console's own audit mock, made real: signed amount, who, why.
          detail:
            `${amountFils > 0 ? '+' : '−'}${formatMoney(fils(Math.abs(amountFils)))} ` +
            `${amountFils > 0 ? 'to' : 'from'} ${m.name} · ${reason}`,
          source: 'owner_console',
          subjectType: 'transaction',
          subjectId: adjId,
          amountFils: fils(Math.abs(amountFils)),
          metadata: {
            memberId: m.id,
            direction: amountFils > 0 ? 'credit' : 'debit',
            balanceAfterFils: balanceAfter,
            reason,
            deletionPending: m.deletionRequestedAt !== null,
          },
          ipAddress: req.ip ?? null,
          userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
        });

        const [row] = await tx.select().from(transaction).where(eq(transaction.id, adjId)).limit(1);
        const result = {
          transaction: serialiseTransactionForMerchant(row!, null),
          balanceAfterFils: balanceAfter,
        };

        await completeKey(tx, keyId, { status: 200, body: result }, adjId);
        return result;
      });
    };

    try {
      return reply.send(await run());
    } catch (err) {
      /**
       * THE DATABASE SAID NO. `member_balance_non_negative` fired on the
       * deduction — translated, with the server's own balance, never the
       * client's belief about it.
       */
      if (violatedCheck(err) === 'member_balance_non_negative') {
        const [m] = await db
          .select({ balanceFils: member.balanceFils })
          .from(member)
          .where(eq(member.id, req.params.id))
          .limit(1);
        throw conflict('insufficient_balance', 'That deduction would take the wallet below zero.', {
          balanceFils: m?.balanceFils ?? 0,
          attemptedFils: amountFils,
        });
      }
      if (!isUniqueViolation(err)) throw err;

      // Another request holds this key. Replay its committed response byte for
      // byte, or report the in-flight state — the charge path's shape.
      const stored = await awaitCommittedKey(db, idem);
      if (stored) return reply.code(stored.status).send(stored.body);
      throw conflict('request_in_progress', 'That request is still being processed. Try again in a moment.');
    }
  });
}
