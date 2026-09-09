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

import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { add, fils, subtract, type Fils, type Transaction } from '@avo/types';
import type { Db } from '../db/client';
import { booking } from '../db/schema/booking';
import { member } from '../db/schema/member';
import { salon } from '../db/schema/salon';
import { service } from '../db/schema/service';
import { transaction } from '../db/schema/transaction';
import { ledgerEntry } from '../db/schema/ledger';
import {
  depositAppliedPosting,
  depositReleasedPosting,
  merchantFundedCreditPosting,
  walletSpendPosting,
} from '../money/ledger';
import { loyaltyEvent } from '../db/schema/loyaltyEvent';
import type { StaffPrincipal } from '../auth/principal';
import { badRequest, conflict, insufficientBalance, notFound } from '../http/errors';
import { serialiseTransactionForCustomer } from '../http/serialise';
import { findApplicableHold } from './booking';
import { resolveBranch } from './branch';
import { applyStamps, applyVisits, type LoyaltyOutcome } from './loyalty';
import { decideEarning, loadPromotionInputs, NO_PROMOTION } from './promotions';
import { consumeToken, peekToken, TokenOutsideSalonError } from './walletToken';
import { claimKey, completeKey, hashRequestBody } from './idempotency';
import { queueReceipts } from './receipts';
import { writeAudit } from './audit';

/** Voidable for 15 minutes — api-contract.md § StaffUser, "reverse within 15 min". */
export const VOID_WINDOW_MINUTES = 15;

/**
 * The near-duplicate window. DECISIONS.md § "Five calls made without asking", item 3.
 *
 * "120s because a genuine repeat is a separate visit." Two identical services back to
 * back is legitimate — so this costs one extra tap in a rare case to prevent a double
 * debit in a case already traced end to end, which is the double-tapped scanner.
 *
 * WHY A REFUSAL AND NOT A WARNING, in the decision's own words: "A flag-after-the-fact
 * cannot work, because the triggering condition is a response the client could not
 * read." A warning arrives after the money moved.
 */
export const NEAR_DUPLICATE_WINDOW_SECONDS = 120;

/**
 * The canonical basket, hashed. SORTED, so `[SV-01, SV-02]` and `[SV-02, SV-01]` are
 * one basket — they are one basket to the person holding the scanner.
 *
 * Sorting is the whole of the canonicalisation because duplicates cannot reach here:
 * `routes/charges.ts` refuses a repeated service id by name. That refusal is not
 * merely tidiness — see its comment for the money it protects.
 */
export function basketHashFor(serviceIds: readonly string[]): string {
  return hashRequestBody({ basket: [...serviceIds].sort() });
}

export interface ChargeInput {
  memberId: string;
  serviceIds: string[];
  token?: string | undefined;
  /**
   * NO `branchId`, AND THE FIELD IS GONE RATHER THAN LEFT UNSET.
   *
   * It was here, optional, and no caller has ever set it — `routes/charges.ts`
   * builds this object from `{ memberId, serviceIds, token, confirmDuplicate }`
   * and deliberately reads no branch from the body. So it was a door that was
   * closed only by everybody remembering not to open it, on the one field that
   * decides a customer's earning multiplier (services/branch.ts § THE FIX THAT
   * MUST NOT BE TAKEN).
   *
   * The branch now comes from `ctx.principal.enrolledBranchId` — a
   * `device_enrolment` row the server holds, keyed on the till's device id. See
   * § 5 below. There is no longer a field for a caller to fill.
   */
  /**
   * "Yes, charge her again for the same thing" — the explicit confirm the
   * near-duplicate guard requires. See `NEAR_DUPLICATE_WINDOW_SECONDS`.
   *
   * NOT PART OF THE IDEMPOTENCY REQUEST HASH, deliberately: it is a decision about
   * how to handle a refusal, not part of what is being charged. Including it would
   * make the confirmed retry a DIFFERENT request under the same key and earn a 422
   * `idempotency_key_reused`, when it is the same attempt being allowed to proceed.
   */
  confirmDuplicate?: boolean | undefined;
}

export interface ChargeContext {
  principal: StaffPrincipal;
  idempotency: { scope: string; endpoint: string; key: string; requestHash: string };
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface ChargeResult {
  /**
   * `Transaction` FROM @avo/types, NOT A HAND-WRITTEN FIELD LIST.
   *
   * This used to be the eleven fields spelled out inline, which is how it came to
   * be missing `voidedAt` and `reversedByTransactionId` — both declared
   * `.nullable()` on `TransactionSchema`, so both required on the wire. The client
   * could not parse the reply to the most important POST in the product: a charge
   * that had already succeeded server-side came back unparseable.
   *
   * It is the same defect that was fixed in `serialiseTransactionForCustomer` one
   * endpoint over, and the same lesson as `heldDepositFils`: an explicit field list
   * is a promise to remember, and two hand-assembled copies of one shape drift. The
   * type now comes from the schema, so tsc names the next added field instead of a
   * contract test finding it later.
   */
  transaction: Transaction;
  balanceAfterFils: number;
  /** What the held deposit took off this charge. The scanner's credit line. */
  depositAppliedFils: number;
  /**
   * What was handed BACK because the deposit was bigger than the visit, and the
   * booking it came from. Both always present, both null/0 when there was no
   * booking — a scanner has to be able to tell "no deposit was held" from "this
   * API is too old to say", the same reasoning `happyHour` carries below.
   */
  depositReturnedFils: number;
  bookingId: string | null;
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
      /**
       * ON `tx`, NOT ON `db`, AND THAT IS NOT A TIDY-UP.
       *
       * `db/client.ts` opens `postgres(url, { max: 10 })` and a `db.transaction()`
       * RESERVES one of those ten for its whole life. `peekToken(db, …)` here asked
       * the SAME pool for a SECOND connection while holding one, so ten concurrent
       * charges held all ten and each waited for an eleventh that cannot exist.
       * Postgres never sees the cycle — it runs through a JavaScript pool, which is
       * invisible to it — so `deadlock_timeout` never fires and nothing times out.
       * It wedged the PROCESS, not the endpoint: a plain
       * `GET /members/me/wallet-token` was measured hanging twelve seconds after
       * the burst was over.
       *
       * `scannerLimit.ts` § "WHERE THE CHECK SITS" is the long version of the same
       * mechanism, and the limiter was moved OUT of this transaction for it. The
       * limiter had to move because its counter row must survive a rollback. A peek
       * is a plain SELECT that must not, so it moves the other way: onto `tx`.
       *
       * DO NOT "FIX" A RECURRENCE BY RAISING `max`. With `max: N`, N concurrent
       * requests still deadlock — it moves the cliff, it does not remove it.
       *
       * `e2e/connection-pool.test.ts` fires twelve charges each carrying its own
       * token and fails if any goes unanswered. `scannerLimit.int.test.ts`'s burst
       * CANNOT see this: it sends no `token`, so it never enters this branch.
       */
      let peeked;
      try {
        peeked = await peekToken(tx, input.token, { salonId: ctx.principal.salonId });
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

    /**
     * ------------------------------------------ 3a. THE NEAR-DUPLICATE GUARD --
     *
     * DECISIONS.md item 3, and it is a REFUSAL rather than a warning for the reason
     * recorded there: "A flag-after-the-fact cannot work, because the triggering
     * condition is a response the client could not read." A warning arrives after
     * the money moved.
     *
     * HERE, AFTER THE BASKET IS VALIDATED AND BEFORE THE DEBIT. After, because a
     * basket containing an unknown service should be told that rather than told it
     * looks like a duplicate — the more specific refusal wins. Before, because the
     * whole point is that nothing moves.
     *
     * IT THROWS, SO THE IDEMPOTENCY KEY VANISHES WITH THE TRANSACTION, and that is
     * what makes the confirm workable rather than a dead end: the scanner retries
     * the SAME attempt with `confirmDuplicate: true`, and because the first attempt
     * rolled back there is no committed key row to collide with. The request hash
     * deliberately excludes the flag (see `ChargeInput.confirmDuplicate`), so the
     * retry is the same request finally allowed to proceed.
     *
     * A VOIDED EARLIER CHARGE IS NOT A DUPLICATE, and this is the case that would
     * have made the guard actively wrong. A void refunds the customer, so charging
     * the same basket again is the correct next action — it is what a staff member
     * does after voiding a mistake. Without the `NOT EXISTS` below, the guard would
     * refuse exactly the charge the void was performed in order to redo, and the
     * scanner would be stuck for two minutes with no way forward but a flag it had
     * no reason to think it needed.
     *
     * MATCHED ON A NON-NULL HASH. Every charge written before migration 0031 has
     * none, and treating null as a wildcard would refuse legitimate charges against
     * history nobody recorded.
     */
    const basketHash = basketHashFor(input.serviceIds);
    if (!input.confirmDuplicate) {
      const since = new Date(Date.now() - NEAR_DUPLICATE_WINDOW_SECONDS * 1000);
      const [earlier] = await tx
        .select({ t: transaction })
        .from(transaction)
        .where(
          and(
            eq(transaction.memberId, m.id),
            eq(transaction.kind, 'charge'),
            eq(transaction.basketHash, basketHash),
            gte(transaction.createdAt, since),
            /**
             * Not voided. See above — a refunded charge is a reason to charge again,
             * not a reason to refuse.
             *
             * A correlated NOT EXISTS with an explicit alias rather than
             * `alias(transaction, …)`: this is a self-reference inside a `sql`
             * fragment, and naming the alias in the SQL is clearer than threading a
             * table object through a template. `reverses_transaction_id` is uniquely
             * indexed, so this matches at most one row.
             */
            sql`NOT EXISTS (
                  SELECT 1 FROM ${transaction} AS void_row
                   WHERE void_row.reverses_transaction_id = ${transaction.id}
                )`,
          ),
        )
        .orderBy(desc(transaction.createdAt))
        .limit(1);

      if (earlier) {
        const secondsAgo = Math.max(
          0,
          Math.round((Date.now() - earlier.t.createdAt.getTime()) / 1000),
        );
        /**
         * The earlier transaction travels WITH the refusal, so the scanner can show
         * the staff member what it thinks she already did — "8.000 KD, 34 seconds
         * ago" — rather than a bare "are you sure?". A confirmation dialogue that
         * cannot name what it is warning about trains people to tap through it.
         */
        throw conflict(
          'possible_duplicate',
          `This customer was charged ${(Math.abs(earlier.t.amountFils) / 1000).toFixed(3)} KD ` +
            `for the same services ${secondsAgo} second(s) ago. Charge her again only if ` +
            `that is genuinely a second visit.`,
          {
            secondsAgo,
            windowSeconds: NEAR_DUPLICATE_WINDOW_SECONDS,
            /** What the client must send to proceed. Named, so it is not guesswork. */
            confirmWith: 'confirmDuplicate',
            transaction: serialiseTransactionForCustomer(
              {
                id: earlier.t.id,
                memberId: earlier.t.memberId,
                branchId: earlier.t.branchId,
                kind: 'charge',
                amountFils: earlier.t.amountFils,
                bonusFils: earlier.t.bonusFils,
                feeFils: earlier.t.feeFils,
                method: earlier.t.method,
                status: earlier.t.status,
                reference: earlier.t.reference,
                createdAt: earlier.t.createdAt,
              },
              // The query already established it has no reversal, which is why it
              // matched at all. `null` here is that fact, not a default.
              null,
            ),
          },
        );
      }
    }

    // ------------------------------------------------- 4. apply held deposit --
    /**
     * THE CREDIT LINE, FINALLY REACHABLE.
     *
     * This was `fils(0)` with a comment saying bookings did not exist. Lane D
     * carried the consequence as a standing todo: the scanner's "deposit applied"
     * line renders money and had never been exercised with a non-zero value, and
     * `POST /scans` had the same hardcoded zero.
     *
     * The design's worked example is the case this has to produce:
     * `8.000 service − 5.000 deposit = 3.000 charged`
     * — AVO-Beauty-Product-Description-v2.md § 4, README § Scan.
     *
     * WHICH booking, and why not simply her earliest held one, is
     * services/booking.ts § findApplicableHold: a customer with an appointment
     * next Tuesday who walks in today for a blow-dry must not have Tuesday's
     * deposit spent on it.
     *
     * `forUpdate`, because the row is about to be marked `completed` and the
     * no-show job may be looking at exactly this row at exactly this moment. The
     * lock order is member (step 1) then booking, and every other caller follows
     * it — see the header of `returnDeposit`.
     */
    const [salonForDeposit] = await tx
      .select({ noShowReturnMinutes: salon.noShowReturnMinutes })
      .from(salon)
      .where(eq(salon.id, ctx.principal.salonId))
      .limit(1);
    const held = await findApplicableHold(
      tx,
      {
        memberId: m.id,
        salonId: ctx.principal.salonId,
        now: new Date(),
        noShowReturnMinutes: salonForDeposit?.noShowReturnMinutes ?? 60,
      },
      { forUpdate: true },
    );

    /**
     * CAPPED AT THE BASKET, and the remainder goes back to her wallet.
     *
     * A 3.000 service against a 5.000 held deposit is a real case: the salon's
     * deposit is flat, 1 to 10 KD, and nothing ties it to what she actually
     * books. Applying the whole hold would make `due` negative, and a negative
     * `due` reaches the ledger as a negative `amount_fils`, which the
     * `ledger_entry_amount_positive` CHECK refuses — a 500 at the counter for a
     * cheap blow-dry.
     *
     * So `applied = min(gross, held)`, and whatever is left over is written as
     * its own `deposit_return` at step 7a. That is the only answer consistent
     * with non-negotiable #5: the money is hers, it never became salon revenue,
     * and it lands in her wallet as a line she can see rather than being netted
     * invisibly into a charge.
     */
    const heldTotal = held ? fils(held.depositFils) : fils(0);
    const heldDeposit = heldTotal > gross ? gross : heldTotal;
    const depositRemainder = subtract(heldTotal, heldDeposit);
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
    /**
     * Two answers, not one, and keeping them apart is the whole point.
     *
     * `branchId` attributes the row — the column is NOT NULL and something has
     * to go in it. `established` says whether that value is a fact or a
     * fallback, and it is what every earning decision below is gated on. See
     * services/branch.ts for the charge that doubled a customer's visits because
     * these two used to be the same answer.
     *
     * THE TILL NOW ANSWERS THE SECOND QUESTION.  (DECISIONS.md #82)
     *
     * `enrolledBranchId` is the branch `device_enrolment` binds this scanner's
     * device to, resolved in `auth/principal.ts` from a row the SERVER holds. It
     * arrives as `resolveBranch`'s `supplied`, which verifies it against the
     * salon anyway and returns `established: true`. That is what finally makes
     * this file's own long-standing caveat below — "a multi-branch salon's
     * boosts are stored, served to both clients, applied by neither" — untrue.
     *
     * A null (dashboard session, unenrolled till, test principal) passes no
     * `supplied` at all, so the fallback is exactly the behaviour that shipped
     * before: one open branch is established, several are assumed.
     */
    const branch = await resolveBranch(tx, ctx.principal.salonId, ctx.principal.enrolledBranchId);
    const branchId = branch.branchId;
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
      // The row says of itself whether its branch was known. See migration 0012.
      branchAssumed: !branch.established,
      kind: 'charge',
      amountFils: fils(-due),
      method: 'wallet',
      status: 'settled',
      reference: `AVO-CHG-${txId.slice(3)}`,
      // What this charge was for, canonically. The next charge two minutes from now
      // compares against it — see step 3a.
      basketHash,
      createdByStaffId: ctx.principal.id,
      createdAt: now,
      settledAt: now,
    });

    // ------------------------------------------------------------- 7. ledger --
    // Double entry, balanced per transaction. The DEFERRABLE constraint trigger
    // from migration 0001 checks the pair at COMMIT, so a debit without its
    // matching credit does not commit.
    if (due > 0) {
      await tx.insert(ledgerEntry).values(
        walletSpendPosting({
          transactionId: txId,
          salonId: ctx.principal.salonId,
          memberId: m.id,
          amountFils: due,
          balanceAfterFils: balanceAfter,
        }),
      );
    }
    if (heldDeposit > 0) {
      await tx.insert(ledgerEntry).values(
        // NO `memberId` — the escrow leg names nobody, like every other
        // non-wallet leg. This call passed `m.id` until DECISIONS.md #64; it
        // double-counted the deposit against her in any per-member ledger net,
        // because her balance moved when the deposit was HELD, not here. The
        // builder no longer accepts the field, so this cannot regress silently.
        depositAppliedPosting({
          transactionId: txId,
          salonId: ctx.principal.salonId,
          amountFils: heldDeposit,
        }),
      );
    }

    /**
     * ------------------------------------------- 7a. the booking is settled --
     *
     * `deposit_held → completed`, naming THIS charge as what resolved the money.
     * The `booking_settlement_matches_status` CHECK refuses a completed booking
     * with no settling transaction, so forgetting this line does not commit — it
     * is not a convention this handler keeps, it is a constraint it satisfies.
     *
     * Inside the money transaction, like everything else here. A booking marked
     * completed by a charge that rolled back is an appointment nobody can find the
     * payment for, and a charge that applied a deposit without closing the booking
     * leaves the no-show job free to return money the salon has already earned.
     */
    let depositReturnedFils = fils(0);
    if (held) {
      await tx
        .update(booking)
        .set({
          status: 'completed',
          settledTransactionId: txId,
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(booking.id, held.id));

      /**
       * THE REMAINDER, when the deposit was larger than the basket.
       *
       * Its own `deposit_return` transaction and its own ledger pair, for the
       * reason step 9b gives for a happy-hour credit: netting a credit inside the
       * charge row that triggered it leaves the activity feed unable to show the
       * customer either number. She held 5.000, spent 3.000, and 2.000 came back —
       * three figures, and she is entitled to see all three.
       *
       * Written AFTER the debit, against the balance the debit left, so
       * `member.balance_fils >= 0` is never satisfied only because a credit
       * happened to be applied first.
       */
      if (depositRemainder > 0) {
        const returnId = transactionId();
        const balanceWithRemainder = add(balanceAfter, depositRemainder);
        depositReturnedFils = depositRemainder;

        await tx
          .update(member)
          .set({ balanceFils: balanceWithRemainder, updatedAt: now })
          .where(eq(member.id, m.id));

        await tx.insert(transaction).values({
          id: returnId,
          memberId: m.id,
          salonId: ctx.principal.salonId,
          branchId,
          branchAssumed: !branch.established,
          kind: 'deposit_return',
          amountFils: depositRemainder,
          method: 'wallet',
          status: 'settled',
          reference: `AVO-DPR-${returnId.slice(3)}`,
          note: 'Deposit larger than the visit',
          createdByStaffId: ctx.principal.id,
          createdAt: now,
          settledAt: now,
        });

        await tx.insert(ledgerEntry).values(
          depositReleasedPosting({
            transactionId: returnId,
            salonId: ctx.principal.salonId,
            memberId: m.id,
            amountFils: depositRemainder,
            balanceAfterFils: balanceWithRemainder,
          }),
        );
      }
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
     * THE ESTABLISHED BRANCH, NOT THE ATTRIBUTED ONE. These differ exactly when
     * the branch was a guess, and paying out on a guess is the defect this
     * whole seam exists for.
     *
     * `branchId` on the row above may be `ORDER BY id LIMIT 1` talking.
     * Deciding a customer's earning rate from that pays her Kuwait City's 2x
     * because 'BR-KWC' sorts before 'BR-SAL' — which is not a hypothetical, it
     * is what the first live charge did. `null` here means "not known", and
     * services/promotions.ts § PromotionInputs matches it against no boost and
     * no branch-scoped window.
     *
     * A SINGLE-BRANCH SALON IS NOW ESTABLISHED, which is a real behaviour
     * change and a correction rather than a relaxation. There is no sort order
     * to be at the mercy of and nowhere else the charge could have happened, so
     * its boost applies — where before, every salon's branch was treated as
     * unknown and a one-branch salon's boost never paid either.
     *
     * A MULTI-BRANCH SALON IS ESTABLISHED WHEN THE TILL IS ENROLLED, AND ONLY
     * THEN.  (DECISIONS.md #82, migration 0043)
     *
     * This paragraph used to end "until then a multi-branch salon's boosts are
     * stored, served to both clients, applied by neither, and every row they
     * could have touched carries `branch_assumed = true`." That was true for the
     * life of the file and is now the state of an UNENROLLED till only.
     *
     * `POST /charges` still takes `{ memberId, serviceIds[], token }` and still
     * reads no branch from the body — that has not changed and must not: a client
     * naming its own branch is a client choosing its own multiplier,
     * non-negotiable #2 with extra steps. What changed is that the branch now
     * arrives from something the SERVER established. `StaffPrincipal` still
     * carries branch ACCESS, which is a permission and not a location; alongside
     * it, `enrolledBranchId` is the location, read from `device_enrolment` on the
     * scanner's own device id.
     *
     * SO A MULTI-BRANCH SALON HAS TWO STATES NOW, and the merchant can tell them
     * apart: an enrolled till earns its branch's boost and writes
     * `branch_assumed = false`; a till nobody has set up still earns nothing and
     * still says so on the row.
     */
    const promoInputs = await loadPromotionInputs(
      tx,
      ctx.principal.salonId,
      branch.established ? branchId : null,
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
    // Starts from the balance AFTER the deposit remainder was returned at 7a, not
    // from the post-debit balance: two credits on one charge would otherwise
    // overwrite each other and the second would report a wallet the first had
    // already changed.
    let balanceFinal = add(balanceAfter, depositReturnedFils);
    if (earning.creditFils > 0 && earning.happyHourId) {
      const creditId = transactionId();
      // `balanceFinal`, not `balanceAfter`: it already carries any deposit
      // remainder returned at 7a. Recomputing from `balanceAfter` here would
      // silently undo that credit — the two paths can both fire on one charge.
      balanceFinal = add(balanceFinal, fils(earning.creditFils));

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

      // The merchant funds her own promotion, exactly as she funds a tier bonus
      // on a top-up — `merchantFundedCreditPosting` is the same account both
      // times, so the two are one budget line in a report and `promotion_id` is
      // what separates them.
      await tx.insert(ledgerEntry).values(
        merchantFundedCreditPosting({
          transactionId: creditId,
          salonId: ctx.principal.salonId,
          memberId: m.id,
          amountFils: fils(earning.creditFils),
          balanceAfterFils: balanceFinal,
        }),
      );
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
      transaction: serialiseTransactionForCustomer(
        {
          id: txId,
          memberId: m.id,
          branchId,
          kind: 'charge',
          amountFils: -due,
          bonusFils: 0,
          // Not emitted by the serialiser — merchant-visible, customer-never — and
          // 0 is what was written to the row: a charge carries no commission.
          feeFils: 0,
          method: 'wallet',
          status: 'settled',
          reference: `AVO-CHG-${txId.slice(3)}`,
          createdAt: now,
        },
        /**
         * NO REVERSAL, and stated rather than defaulted. This charge was created
         * moments ago inside this very transaction, so nothing can have reversed it
         * yet — `voidedAt: null` here is a fact, not an absence of information. The
         * parameter is required precisely so that a caller which COULD have a
         * reversal cannot forget to look for one.
         */
        null,
      ),
      balanceAfterFils: balanceFinal,
      depositAppliedFils: heldDeposit,
      depositReturnedFils,
      bookingId: held?.id ?? null,
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

/**
 * `defaultBranchId` USED TO LIVE HERE, and its twin lived in services/topup.ts.
 * Both were `SELECT id FROM branch WHERE salon_id = $1 ORDER BY id LIMIT 1`,
 * both returned a bare string, and neither said that the string was a guess.
 * They are now one function that returns the guess and the fact separately —
 * services/branch.ts, which carries the reasoning and the incident.
 */
