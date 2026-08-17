/**
 * The money endpoints on the scanner: charge, today's charges, void.
 *
 * `POST /charges` had NO authority check at all in the mock — it debited a
 * wallet unconditionally. It now requires `perms.scanner`, checked as the first
 * statement of the handler, before the body is parsed and before the token is
 * resolved.
 *
 * `POST /voids` moves money back into a wallet, so non-negotiable #4 applies to
 * it as much as to a charge: a retried void with no key is a double refund.
 *
 * THE REPLAY WRAPPER
 * ------------------
 * `withIdempotency` is the pattern every money-moving POST here uses:
 *
 *     try { …one transaction that claims the key and does the work… }
 *     catch (unique violation) { …read the winner's stored response, replay it… }
 *
 * The claim happens INSIDE the transaction, so the database — not a Map, not an
 * `if` — resolves two simultaneous requests. The loser does not compute a second
 * result and does not guess; it waits for the winner's committed response and
 * returns it verbatim. See services/idempotency.ts for why the check-then-act
 * version passes Lane D's suite on the mock and would not survive here.
 */

import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { fils } from '@avo/types';
import { db } from '../db/client';
import { booking } from '../db/schema/booking';
import { member } from '../db/schema/member';
import { ledgerEntry } from '../db/schema/ledger';
import { transaction } from '../db/schema/transaction';
import { requireScannerPerm, hasScenario } from '../auth/principal';
import { env } from '../env';
import { badRequest, conflict, notFound } from '../http/errors';
import { requireString, requireStringArray } from '../money/validate';
import {
  awaitCommittedKey,
  claimKey,
  completeKey,
  hashRequestBody,
  isUniqueViolation,
  principalScope,
  readIdempotencyKey,
  violatedConstraint,
} from '../services/idempotency';
import { performCharge, VOID_WINDOW_MINUTES } from '../services/charge';
import { writeAudit } from '../services/audit';
import type { StaffPrincipal } from '../auth/principal';

/**
 * Lane D pins the low-balance case with `x-avo-scenario: lowbal`, which the mock
 * served by substituting a hardcoded balance. A real API cannot fabricate a
 * balance without lying about the money, so under the test flag the scenario
 * selects a SEEDED low-balance member instead. The handler then runs completely
 * unmodified — the 402 it produces is a real shortfall against a real row.
 */
const LOWBAL_MEMBER_ID = '8843';

function resolveMemberId(req: FastifyRequest, requested: string): string {
  if (env.testPrincipals && hasScenario(req, 'lowbal')) return LOWBAL_MEMBER_ID;
  return requested;
}

/** Claim-inside-the-transaction, replay-on-duplicate. */
async function withIdempotency<T>(
  params: { scope: string; endpoint: string; key: string; requestHash: string },
  run: () => Promise<T>,
): Promise<{ status: number; body: unknown }> {
  try {
    const result = await run();
    return { status: 200, body: result };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;

    /**
     * NOT EVERY UNIQUE VIOLATION IS AN IDEMPOTENCY-KEY COLLISION, and assuming
     * so is what made a double void answer "still being processed".
     *
     * Two voids of one charge under two DIFFERENT keys race; one wins; the loser
     * violates `transaction_reverses_uq`, not the key index. Falling through to
     * the replay below would search for a committed response under a key that
     * never collided, find nothing, and report a transient condition for a state
     * that is permanent. `performVoid` catches the ordinary sequential case with
     * a read; this is the same truth told for the race.
     */
    if (violatedConstraint(err) === 'transaction_reverses_uq') {
      throw conflict(
        'already_voided',
        'That charge has already been voided. The customer was refunded to her wallet.',
      );
    }

    // Another request holds this key. Wait for its committed response and
    // replay it byte for byte rather than computing a second one.
    const stored = await awaitCommittedKey(db, params);
    if (stored) return stored;

    throw conflict(
      'request_in_progress',
      'That request is still being processed. Try again in a moment.',
    );
  }
}

export async function registerChargeRoutes(app: FastifyInstance): Promise<void> {
  // ------------------------------------------------------------- POST /charges --
  app.post('/charges', async (req, reply) => {
    // FIRST. A wallet is not debited by a principal with no scanner authority —
    // and not from a browser tab, whatever authority it holds.
    const p = requireScannerPerm(req, 'scanner');

    // Then the key — a money-moving POST without one is refused before any work.
    const key = readIdempotencyKey(req);

    const body = (req.body ?? {}) as Record<string, unknown>;
    const memberId = resolveMemberId(req, requireString(body.memberId, 'memberId', 100));
    const serviceIds = requireStringArray(body.serviceIds, 'serviceIds');
    const token = typeof body.token === 'string' && body.token.trim() !== '' ? body.token.trim() : undefined;

    const idem = {
      scope: principalScope(p),
      endpoint: 'POST /charges',
      key,
      requestHash: hashRequestBody({ memberId, serviceIds, token: token ?? null }),
    };

    const { status, body: out } = await withIdempotency(idem, () =>
      performCharge(
        db,
        { memberId, serviceIds, token },
        {
          principal: p,
          idempotency: idem,
          ipAddress: req.ip ?? null,
          userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
        },
      ),
    );

    return reply.code(status).send(out);
  });

  // -------------------------------------------------------------- GET /charges --
  /**
   * perms.charges — "senior permission", api-contract.md § StaffUser, which
   * spells the surface out too: "can open Today's charges ON THE SCANNER". The
   * merchant dashboard has no today's-charges screen; its only mention of
   * `charges` and `void` is the Accounts → Team permission editor, where they
   * are labels on a checkbox, not actions.
   *
   * So this is scanner-scoped like the charge itself. The list names every
   * customer charged today with amounts — reading it from an unattended browser
   * tab is a smaller harm than debiting from one, but it is the same door.
   */
  app.get('/charges', async (req, reply) => {
    const p = requireScannerPerm(req, 'charges');

    const since = new Date();
    since.setHours(0, 0, 0, 0);

    /**
     * THE VOID IS A SEPARATE ROW, so the list has to go and look for it.
     *
     * A void is a compensating `adjustment` pointing back at the charge through
     * `reverses_transaction_id` — the charge itself is never edited. That is
     * right for the ledger and wrong for this screen, which was rendering a
     * refunded charge identically to a live one and offering "Void this charge"
     * a second time. The staff member then tapped it in front of the customer
     * and got an error for doing what the screen invited.
     *
     * A self-join rather than a second query, so the flag cannot disagree with
     * the row it is attached to. `reverses_transaction_id` is uniquely indexed,
     * so this matches at most one reversal per charge and the join cannot
     * duplicate a row.
     */
    const reversal = alias(transaction, 'reversal');

    const rows = await db
      .select({ charge: transaction, reversal })
      .from(transaction)
      .leftJoin(reversal, eq(reversal.reversesTransactionId, transaction.id))
      .where(
        and(
          eq(transaction.salonId, p.salonId),
          eq(transaction.kind, 'charge'),
          gte(transaction.createdAt, since),
        ),
      )
      .orderBy(desc(transaction.createdAt))
      .limit(200);

    return reply.send({
      items: rows.map(({ charge: t, reversal: v }) => ({
        id: t.id,
        memberId: t.memberId,
        branchId: t.branchId,
        kind: t.kind,
        amountFils: t.amountFils,
        bonusFils: t.bonusFils,
        method: t.method,
        status: t.status,
        reference: t.reference,
        createdAt: t.createdAt.toISOString(),
        /**
         * Both, and deliberately not one.
         *
         * `voidedAt` is what the list renders — "Voided 14:32" is the sentence a
         * human reads. `reversedByTransactionId` is what makes it auditable: it
         * names the refund row, so "where did the money go" is answerable from
         * the screen the question is asked on rather than from a ledger export.
         * Null on a live charge, and null is a positive statement here — not
         * voided — which is why the fields are always present rather than
         * omitted when absent.
         */
        voidedAt: v ? v.createdAt.toISOString() : null,
        reversedByTransactionId: v ? v.id : null,
      })),
      nextCursor: null,
    });
  });

  // --------------------------------------------------------------- POST /voids --
  /**
   * A void is a compensating `adjustment` row pointing back at the charge, not
   * an edit of it — the ledger and the transaction table are both append-only in
   * spirit and the unique index on `reverses_transaction_id` makes "void once" a
   * database fact rather than a handler's good intentions.
   *
   * Refunds are wallet credit. Non-negotiable #5: no cash, no card reversal, on
   * any surface, ever.
   *
   * Scanner-scoped. A void moves money back into a wallet inside a 15-minute
   * window — it is the undo of something that just happened at the counter, in
   * front of the customer, and the design puts it there: `Void` appears
   * throughout AVO Staff Scanner.dc.html and nowhere in the dashboard but the
   * permission editor. If the window has closed, the merchant reimburses; there
   * is no dashboard path back into a wallet, by design.
   */
  app.post('/voids', async (req, reply) => {
    const p = requireScannerPerm(req, 'void');
    const key = readIdempotencyKey(req);

    const body = (req.body ?? {}) as Record<string, unknown>;
    const transactionId = requireString(body.transactionId, 'transactionId', 100);
    // Every void carries a reason into the audit log — api-contract.md § Operations.
    if (typeof body.reason !== 'string' || body.reason.trim() === '') {
      throw badRequest('reason_required', 'A void needs a reason.');
    }
    const reason = body.reason.trim();

    const idem = {
      scope: principalScope(p),
      endpoint: 'POST /voids',
      key,
      requestHash: hashRequestBody({ transactionId, reason }),
    };

    const { status, body: out } = await withIdempotency(idem, () =>
      performVoid(transactionId, reason, p, req, idem),
    );

    return reply.code(status).send(out);
  });
}

/** The void, as one transaction. Same shape of guarantee as the charge. */
async function performVoid(
  targetId: string,
  reason: string,
  principal: StaffPrincipal,
  req: FastifyRequest,
  idem: { scope: string; endpoint: string; key: string; requestHash: string },
) {
  return db.transaction(async (tx) => {
    const keyId = await claimKey(tx, idem);

    const rows = await tx
      .select()
      .from(transaction)
      .where(and(eq(transaction.id, targetId), eq(transaction.salonId, principal.salonId)))
      .limit(1);
    const target = rows[0];
    if (!target) throw notFound('unknown_transaction', 'No such charge.');
    if (target.kind !== 'charge') {
      throw badRequest('not_voidable', 'Only a charge can be voided.');
    }

    /**
     * ALREADY VOIDED IS ITS OWN ANSWER, not a retryable one.
     *
     * Without this the second void reached the insert, violated
     * `transaction_reverses_uq`, and `withIdempotency` — which assumed every
     * unique violation was an idempotency-key collision — answered `409
     * request_in_progress`. The scanner then told the staff member "that request
     * is still being processed, try again in a moment", in front of the
     * customer: wrong, an invitation to try a third time, and concealing the
     * actual state, which is that the charge was already refunded.
     *
     * The money was never at risk — the unique index held, and still does. This
     * is about telling the truth. `already_voided` is a different sentence and a
     * different screen.
     *
     * The read is inside the money transaction, so it cannot go stale between
     * check and insert; the index below is still what makes "void once" true
     * under a genuine race, and the catch in the caller translates that case to
     * the same error rather than letting it read as transient.
     */
    const existingReversal = await tx
      .select({ id: transaction.id })
      .from(transaction)
      .where(eq(transaction.reversesTransactionId, target.id))
      .limit(1);
    if (existingReversal[0]) {
      throw conflict(
        'already_voided',
        'That charge has already been voided. The customer was refunded to her wallet.',
      );
    }

    // The 15-minute window. Past it, the merchant reimburses instead.
    const age = Date.now() - target.createdAt.getTime();
    if (age > VOID_WINDOW_MINUTES * 60_000) {
      throw conflict(
        'void_window_closed',
        `A charge can only be voided within ${VOID_WINDOW_MINUTES} minutes. Reimburse the customer instead.`,
      );
    }

    const memberRows = await tx
      .select()
      .from(member)
      .where(eq(member.id, target.memberId))
      .for('update')
      .limit(1);
    const m = memberRows[0];
    if (!m) throw notFound('unknown_member', 'No such member.');

    /**
     * THE REFUND INCLUDES THE HELD DEPOSIT THIS CHARGE CONSUMED.
     *
     * `abs(target.amountFils)` alone was right while deposits did not exist and
     * became a silent under-refund the moment they did. The charge row records
     * what was debited AFTER the deposit was applied — 3.000, on the design's
     * 8.000 service with a 5.000 deposit — so refunding only that hands back
     * three of the eight the customer actually paid, and the other five stays
     * with the salon for a visit that has just been declared not to have
     * happened.
     *
     * Read from the LEDGER rather than from the booking, and that is deliberate:
     * the `deposit_held` debit on this transaction is exactly what was applied,
     * already net of any remainder that was handed straight back at charge time
     * (services/charge.ts § 7a). Reading `booking.deposit_fils` instead would
     * refund a remainder she has already received.
     */
    const [applied] = await tx
      .select({ amountFils: ledgerEntry.amountFils })
      .from(ledgerEntry)
      .where(
        and(
          eq(ledgerEntry.transactionId, target.id),
          eq(ledgerEntry.account, 'deposit_held'),
          eq(ledgerEntry.direction, 'debit'),
        ),
      )
      .limit(1);
    const depositApplied = fils(applied?.amountFils ?? 0);

    const refund = fils(Math.abs(target.amountFils) + depositApplied);
    const balanceAfter = fils(m.balanceFils + refund);
    const now = new Date();
    const voidId = `TX-${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;

    /**
     * The booking the deposit came from, if there was one. Its money is going
     * back to the customer, so it cannot stay `completed` — that status asserts
     * the salon earned the deposit. It becomes `cancelled`, settled by the void,
     * which is the closest true statement: the appointment's money returned to
     * her wallet.
     *
     * It does NOT become `deposit_held` again. The deposit is not held any more;
     * it is spendable balance, and a booking claiming a hold that no ledger entry
     * backs is the kind of disagreement the whole state machine exists to prevent.
     * A customer who still wants the appointment rebooks, and holds again.
     */
    const [heldBooking] = depositApplied
      ? await tx
          .select({ id: booking.id })
          .from(booking)
          .where(eq(booking.settledTransactionId, target.id))
          .for('update')
          .limit(1)
      : [undefined];

    await tx
      .update(member)
      .set({ balanceFils: balanceAfter, visits: Math.max(0, m.visits - 1), updatedAt: now })
      .where(eq(member.id, m.id));

    // A compensating row. The unique index on reverses_transaction_id is what
    // makes a second void of the same charge impossible, whatever two concurrent
    // scanner taps believe.
    await tx.insert(transaction).values({
      id: voidId,
      memberId: m.id,
      salonId: principal.salonId,
      branchId: target.branchId,
      // Inherited with the branch, not re-derived. A reversal is attributed
      // exactly as confidently as the charge it undoes — claiming `false` here
      // would launder a guessed branch into an established one on the way back.
      branchAssumed: target.branchAssumed,
      kind: 'adjustment',
      amountFils: refund,
      method: 'wallet',
      status: 'settled',
      reference: `AVO-VOID-${voidId.slice(3)}`,
      note: reason,
      reversesTransactionId: target.id,
      createdByStaffId: principal.id,
      createdAt: now,
      settledAt: now,
    });

    await tx.insert(ledgerEntry).values([
      {
        transactionId: voidId,
        salonId: principal.salonId,
        memberId: m.id,
        account: 'member_wallet',
        direction: 'credit',
        amountFils: refund,
        balanceAfterFils: balanceAfter,
      },
      {
        transactionId: voidId,
        salonId: principal.salonId,
        memberId: null,
        account: 'salon_revenue',
        direction: 'debit',
        amountFils: refund,
      },
    ]);

    /**
     * The whole refund comes out of `salon_revenue`, INCLUDING the deposit
     * portion, and that is correct rather than a shortcut: the deposit stopped
     * being a `deposit_held` liability the moment the charge discharged it into
     * revenue (services/charge.ts § 7). Crediting `deposit_held` back here would
     * reopen a liability nobody holds and leave that account permanently out.
     */
    if (heldBooking) {
      await tx
        .update(booking)
        .set({
          status: 'cancelled',
          settledTransactionId: voidId,
          completedAt: null,
          cancelledAt: now,
          updatedAt: now,
        })
        .where(eq(booking.id, heldBooking.id));
    }

    await writeAudit(tx, principal, {
      salonId: principal.salonId,
      kind: 'money',
      action: 'Charge voided',
      detail:
        `${(refund / 1000).toFixed(3)} KD returned to ${m.name} · ${reason}` +
        (depositApplied > 0
          ? ` · includes ${(depositApplied / 1000).toFixed(3)} KD of held deposit`
          : ''),
      source: 'scanner',
      subjectType: 'transaction',
      subjectId: target.id,
      amountFils: refund,
      metadata: {
        reason,
        voidTransactionId: voidId,
        chargedFils: Math.abs(target.amountFils),
        depositReturnedFils: depositApplied,
        bookingId: heldBooking?.id ?? null,
      },
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    });

    const result = {
      ok: true,
      refundedFils: refund,
      /**
       * Broken out, because "8.000 was returned" on a charge whose row says
       * −3.000 is a number the staff member cannot reconcile in front of the
       * customer without being told where the other five came from.
       */
      depositReturnedFils: depositApplied,
      bookingId: heldBooking?.id ?? null,
      visitRemoved: true,
    };
    await completeKey(tx, keyId, { status: 200, body: result }, voidId);
    return result;
  });
}

export { sql };
