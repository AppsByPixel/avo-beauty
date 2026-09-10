/**
 * AVO-ISSUED VOUCHERS.                (item 10, DECISIONS #87, migration 0046)
 *
 * =========================================================================
 * WHAT WAS ALREADY BUILT, AND WHAT IS ACTUALLY NEW
 * =========================================================================
 * Compensation exists: `POST /members/{id}/adjustments`, a complete money path
 * with a required `reason`, gated `requirePlatform(req,'accounts')` so only AVO
 * can do it and a merchant cannot compensate her own customer at all. The new
 * thing is the OBJECT — a code the customer redeems when she chooses, rather
 * than a credit an admin pushes into her wallet.
 *
 * So this file is deliberately thin: issuing writes a row and moves no money;
 * redeeming reuses the adjustment path's exact shape. Authority stays with the
 * platform, consistent with loyalty (#79) and campaign release (#8).
 *
 * =========================================================================
 * THE RULING: REDEMPTION CREDITS THE WALLET, IT DOES NOT DISCOUNT A CHARGE
 * =========================================================================
 * Which keeps the whole feature off `POST /charges` — the most sensitive
 * transaction in the product — for a feature whose purpose is goodwill. It also
 * matches non-negotiable #5's semantics: value arrives as wallet credit and
 * nothing else.
 *
 * AND IT IS WHY TWO OF LEAN'S THREE COUPON FIELDS DO NOT EXIST HERE.
 * `minimumAmountIsCart` and the `optionType`/`optionList` product restriction
 * both presuppose a BASKET, and a credit is not a purchase. Omitted rather than
 * accepted and ignored, because a rule that can never fire is a dead guard.
 *
 * Lean enforces its coupon entirely CLIENT-SIDE — `applyDiscount` finds the code
 * in the app, compares the cart total in the app, filters products in the app. So
 * a price decision is made in a process a modified app controls. Here the code is
 * resolved server-side, eligibility is evaluated server-side, and the client
 * submits a CODE — never an amount, never a discount.
 *
 * =========================================================================
 * THE REFUSAL IS ONE ANSWER FOR EVERY REASON, AND THAT IS THE CHOICE MADE
 * =========================================================================
 * Expired, never existed, already redeemed, voided, or issued to somebody else
 * all answer `voucher_not_redeemable` with one message. Trunk named the tension:
 * the states must be distinguishable to HER and indistinguishable to an ATTACKER
 * enumerating codes, and those conflict.
 *
 * RESOLVED TOWARD THE ATTACKER, because her recovery path is identical in every
 * case — she contacts support, who CAN tell them apart from the row. The
 * precedent is in this build already: `unknown_artist` answers 404 rather than
 * 403 because "another salon's roster is not something this caller gets to
 * probe".
 *
 * IT COSTS ALMOST NOTHING HERE, and that is the second half of the argument: a
 * voucher is BOUND TO A MEMBER, so enumeration needs her session AND her code.
 * A bearer code would make this trade much more expensive, which is one reason
 * bearer is a separate decision rather than a nullable column.
 */

import { and, desc, eq, gt, isNull, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { fils, formatMoney } from '@avo/types';
import { db } from '../db/client';
import { member } from '../db/schema/member';
import { transaction } from '../db/schema/transaction';
import { ledgerEntry } from '../db/schema/ledger';
import { voucher } from '../db/schema/voucher';
import { voucherRedeemedPosting } from '../money/ledger';
import { requireMember, requirePlatform } from '../auth/principal';
import { badRequest, conflict, notFound } from '../http/errors';
import { requireString } from '../money/validate';
import {
  claimKey,
  completeKey,
  hashRequestBody,
  isUniqueViolation,
  principalScope,
  readIdempotencyKey,
  awaitCommittedKey,
} from '../services/idempotency';
import { writeAudit } from '../services/audit';

/** Integer fils, non-negotiable #1, and a voucher only ever adds. */
function parseAmountFils(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw badRequest(
      'invalid_amount',
      'amountFils must be a positive whole number of fils. A voucher only adds.',
    );
  }
  return value;
}

/**
 * The code, as it is stored and compared. Upper-cased and stripped of spaces and
 * dashes, so what she types on a phone keyboard reaches the same row whatever
 * her autocapitalise did — and stored normalised so `voucher_code_uq` is a real
 * uniqueness guarantee rather than one that "AVO-123" and "avo123" slip past.
 */
function normaliseCode(raw: string): string {
  return raw.replace(/[\s-]+/g, '').toUpperCase();
}

/**
 * A generated code. Crockford-ish alphabet: no `I`, `O`, `1` or `0`, because
 * these are read off a screen and typed by a person.
 */
function mintCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomUUID().replace(/-/g, '');
  let out = '';
  for (let i = 0; i < 12; i++) {
    out += alphabet[parseInt(bytes.slice(i * 2, i * 2 + 2), 16) % alphabet.length];
  }
  return out;
}

/**
 * Redeemable is DERIVED, never stored. There is no `status` column: a stored one
 * would be a second place for what these three timestamps already determine, and
 * a second thing to disagree with them (decision 81's argument, for a smaller
 * quantity).
 */
const REDEEMABLE = (now: Date) =>
  and(
    isNull(voucher.redeemedAt),
    isNull(voucher.voidedAt),
    /**
     * `gt(...)`, NOT a raw `sql` template. `routes/salons.ts` already carries
     * this defect and its fix: "the template binds `closedAt` as a Date straight
     * to postgres.js, which refuses it, while the builder maps it through the
     * column's own `timestamptz` codec." Written first as
     * `sql\`${voucher.expiresAt} > ${now}\``, this made every redemption a 500
     * with `ERR_INVALID_ARG_TYPE` — the answer was already in the codebase.
     */
    or(isNull(voucher.expiresAt), gt(voucher.expiresAt, now)),
  );

function serialiseVoucher(row: typeof voucher.$inferSelect) {
  return {
    id: row.id,
    code: row.code,
    memberId: row.memberId,
    amountFils: row.amountFils,
    reason: row.reason,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    redeemedAt: row.redeemedAt?.toISOString() ?? null,
    redeemedTransactionId: row.redeemedTransactionId,
    voidedAt: row.voidedAt?.toISOString() ?? null,
    /**
     * DERIVED HERE TOO, from the same three facts, so the console does not
     * reimplement the predicate and cannot disagree with the redeem endpoint
     * about whether a row is live.
     */
    redeemable:
      row.redeemedAt === null &&
      row.voidedAt === null &&
      (row.expiresAt === null || row.expiresAt.getTime() > Date.now()),
  };
}

export async function registerVoucherRoutes(app: FastifyInstance): Promise<void> {
  // ------------------------------------------------------------ AVO issues --
  /**
   * `requirePlatform(req, 'accounts')` — the SAME gate as
   * `POST /members/{id}/adjustments`, and that is the argument rather than a
   * coincidence: a voucher is a compensation instrument, and `accounts` is the
   * console section where a customer's wallet is already adjusted. A merchant
   * cannot reach this at all, which is the authority decision Aftab made.
   *
   * NO IDEMPOTENCY KEY. Non-negotiable #4 covers money-moving POSTs, and issuing
   * moves NONE — it writes a row. The money moves when she redeems, and that
   * endpoint takes a key. Adding one here would be cargo-culting the rule onto
   * the half of the flow it does not apply to.
   */
  app.post('/v1/vouchers', async (req, reply) => {
    const p = requirePlatform(req, 'accounts');

    const body = (req.body ?? {}) as Record<string, unknown>;
    const memberId = requireString(body.memberId, 'memberId', 100);
    const amountFils = parseAmountFils(body.amountFils);
    const reason = requireString(body.reason, 'reason', 300).trim();
    if (reason === '') throw badRequest('reason_required', 'A voucher needs a reason.');

    /**
     * NO CLIENT-SUPPLIED CODE, refused by name. A console that chose the code
     * could choose a guessable one, and it could collide with a live voucher and
     * discover that fact from a unique-violation 500. The server mints it.
     */
    if ('code' in body) {
      throw badRequest(
        'code_not_client_supplied',
        'A voucher code is generated by the server, not sent by the console.',
      );
    }

    let expiresAt: Date | null = null;
    if (body.expiresAt !== undefined && body.expiresAt !== null) {
      const parsed = new Date(String(body.expiresAt));
      if (Number.isNaN(parsed.getTime())) {
        throw badRequest('invalid_expiry', 'expiresAt must be an ISO instant, or omitted.');
      }
      if (parsed.getTime() <= Date.now()) {
        // A voucher that is already expired at issue is a voucher nobody can
        // redeem, and it would sit in her list looking like an apology.
        throw badRequest('invalid_expiry', 'expiresAt must be in the future.');
      }
      expiresAt = parsed;
    }

    const [m] = await db.select().from(member).where(eq(member.id, memberId)).limit(1);
    if (!m) throw notFound('unknown_member', 'No such customer.');
    if (m.erasedAt !== null) {
      // Nobody holds a tombstone's balance — `routes/adjustments.ts`'s refusal,
      // applied one step earlier so an unredeemable voucher is never created.
      throw conflict('member_erased', 'That account has been erased.');
    }

    const row = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(voucher)
        .values({
          id: `VCH-${randomUUID().slice(0, 12)}`,
          code: mintCode(),
          memberId: m.id,
          amountFils,
          reason,
          expiresAt,
          issuedByAdminId: p.id,
        })
        .returning();

      await writeAudit(tx, p, {
        salonId: m.salonId,
        kind: 'money',
        action: 'Voucher issued',
        detail: `${formatMoney(fils(amountFils))} voucher for ${m.name} · ${reason}`,
        source: 'owner_console',
        subjectType: 'voucher',
        subjectId: created!.id,
        amountFils: fils(amountFils),
        metadata: { memberId: m.id, reason, expiresAt: expiresAt?.toISOString() ?? null },
        ipAddress: req.ip ?? null,
        userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      });

      return created!;
    });

    return reply.code(201).send({ voucher: serialiseVoucher(row) });
  });

  /** The console's list. `?memberId=` narrows it; otherwise the newest first. */
  app.get<{ Querystring: { memberId?: string } }>('/v1/vouchers', async (req, reply) => {
    const p = requirePlatform(req, 'accounts');
    void p;
    const wanted = req.query?.memberId;
    const rows = await db
      .select()
      .from(voucher)
      .where(wanted ? eq(voucher.memberId, wanted) : undefined)
      .orderBy(desc(voucher.createdAt))
      .limit(200);
    return reply.send({
      items: rows.map(serialiseVoucher),
      /** A cap, said out loud rather than a `nextCursor: null` that lies. */
      truncated: rows.length === 200,
      nextCursor: null,
    });
  });

  // ------------------------------------------------------------- AVO voids --
  /**
   * Void one before it is redeemed.
   *
   * THE TRANSITION IS THE WHERE CLAUSE and the row count decides, so two admins
   * clicking Void produce one void and one refusal, and a REDEEMED voucher can
   * never be voided — `voucher_is_not_both_redeemed_and_voided` is the schema's
   * half of that, and this predicate is the handler's. Voiding after redemption
   * would be AVO taking money back out of her wallet, which is a refund problem
   * wearing a voucher's clothes.
   */
  app.delete<{ Params: { id: string } }>('/v1/vouchers/:id', async (req, reply) => {
    const p = requirePlatform(req, 'accounts');
    const now = new Date();

    const voided = await db
      .update(voucher)
      .set({ voidedAt: now, voidedByAdminId: p.id, updatedAt: now })
      .where(
        and(eq(voucher.id, req.params.id), isNull(voucher.voidedAt), isNull(voucher.redeemedAt)),
      )
      .returning();

    const row = voided[0];
    if (!row) {
      const [current] = await db
        .select()
        .from(voucher)
        .where(eq(voucher.id, req.params.id))
        .limit(1);
      if (!current) throw notFound('unknown_voucher', 'No such voucher.');
      throw conflict(
        'voucher_not_voidable',
        current.redeemedAt !== null
          ? 'That voucher has been redeemed. Its credit is in the customer’s wallet and cannot be taken back here.'
          : 'That voucher is already void.',
        { redeemed: current.redeemedAt !== null },
      );
    }

    const [m] = await db.select().from(member).where(eq(member.id, row.memberId)).limit(1);
    await writeAudit(db, p, {
      salonId: m?.salonId ?? '',
      kind: 'money',
      action: 'Voucher voided',
      detail: `${formatMoney(fils(row.amountFils))} voucher ${row.code} voided`,
      source: 'owner_console',
      subjectType: 'voucher',
      subjectId: row.id,
      amountFils: fils(row.amountFils),
      metadata: { memberId: row.memberId, reason: row.reason },
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    });

    return reply.send({ voucher: serialiseVoucher(row) });
  });

  // ------------------------------------------------ the customer redeems --
  /**
   * `POST /members/me/vouchers/redeem` — she sends a CODE.
   *
   * ONE TRANSACTION (non-negotiable #3): the claim, the credit, the balance, the
   * ledger pair and the audit row commit together or none of them do. An
   * IDEMPOTENCY KEY (non-negotiable #4), because this one moves money.
   *
   * THE CLAIM IS A CONDITIONAL UPDATE AND THE ROW COUNT DECIDES — the
   * `walletToken` pattern from this same column. Two simultaneous redemptions of
   * one code produce one credit and one refusal, without this handler comparing
   * anything; the loser's transaction rolls back whole. A read-then-write would
   * be the double-refund shape `services/booking.ts § returnDeposit` had to
   * learn.
   *
   * `reverses_transaction_id` IS NEVER SET on the credit, and this is a landmine
   * rather than a nicety: `services/reports.ts`'s `NOT_VOIDED` keys on that
   * column, so a voucher row that populated it would silently DELETE a charge
   * from the merchant's gross. There is no code path here that touches it, and
   * `voucher.int.test.ts` asserts the column stays null.
   */
  app.post('/members/me/vouchers/redeem', async (req, reply) => {
    const p = requireMember(req);
    const key = readIdempotencyKey(req);

    const body = (req.body ?? {}) as Record<string, unknown>;
    /**
     * A CODE, AND NOTHING ELSE. No amount, no voucher id — she cannot name what
     * the voucher is worth, which is the server-side-eligibility half of not
     * copying Lean's trust boundary.
     */
    for (const field of ['amountFils', 'voucherId', 'memberId'] as const) {
      if (field in body) {
        throw badRequest(
          'code_only',
          `Send only the code. A voucher's value and owner are resolved by the server, not by ${field}.`,
        );
      }
    }
    const code = normaliseCode(requireString(body.code, 'code', 64));
    if (code === '') throw badRequest('invalid_code', 'A code is required.');

    const idem = {
      scope: principalScope(p),
      endpoint: 'POST /members/me/vouchers/redeem',
      key,
      requestHash: hashRequestBody({ code }),
    };

    /** One refusal for every reason. See the file header. */
    const refuse = () =>
      conflict(
        'voucher_not_redeemable',
        'That code cannot be redeemed. Check it and try again, or contact support.',
      );

    const run = () =>
      db.transaction(async (tx) => {
        const keyId = await claimKey(tx, idem);
        const now = new Date();
        const txId = `TX-VCH-${randomUUID().slice(0, 12)}`;

        /**
         * READ FIRST, THEN CLAIM — AND THE ORDER IS FORCED BY A FOREIGN KEY, NOT
         * A PREFERENCE.
         *
         * `voucher.redeemed_transaction_id` references `transaction(id)` and
         * `voucher_redemption_is_whole` requires it to be set in the same
         * statement as `redeemed_at`. So the voucher cannot be claimed before the
         * transaction row it names exists. Written the other way round first,
         * every redemption failed on
         * `voucher_redeemed_transaction_id_transaction_id_fk`.
         *
         * THIS READ IS ADVISORY AND THE UPDATE BELOW IS STILL THE ARBITER, which
         * is the part that matters. It is not a read-then-write race: the
         * conditional UPDATE re-checks liveness and ownership, and a loser's
         * whole transaction — including the `transaction` row inserted between
         * them — rolls back. The read exists only to learn the amount, because a
         * transaction row needs one.
         */
        const [seen] = await tx
          .select()
          .from(voucher)
          .where(and(eq(voucher.code, code), eq(voucher.memberId, p.id), REDEEMABLE(now)))
          .limit(1);
        if (!seen) throw refuse();

        const [m] = await tx
          .select()
          .from(member)
          .where(eq(member.id, p.id))
          .for('update')
          .limit(1);
        if (!m) throw notFound('unknown_member', 'No such customer.');
        if (m.erasedAt !== null) throw refuse();

        await tx.insert(transaction).values({
          id: txId,
          memberId: m.id,
          salonId: m.salonId,
          /**
           * The salon's first branch with `branchAssumed: true`, exactly as a
           * console adjustment does: a voucher is a SALON-level credit and no
           * branch took it, so inventing one would put AVO's money in one
           * branch's till.
           */
          branchId: (
            await tx.query.branch.findFirst({
              where: (b, { eq: eqB }) => eqB(b.salonId, m.salonId),
              orderBy: (b, { asc }) => asc(b.id),
            })
          )?.id as string,
          branchAssumed: true,
          kind: 'adjustment',
          // Positive; `transaction_amount_sign_matches_kind` allows either sign for
          // an `adjustment`, and a voucher only ever credits.
          amountFils: fils(seen.amountFils),
          method: 'wallet',
          status: 'settled',
          reference: `AVO-VCH-${txId.slice(7)}`,
          note: seen.reason,
          /**
           * `reversesTransactionId` IS DELIBERATELY ABSENT. See the handler
           * comment: `NOT_VOIDED` keys on it, so setting it here would remove a
           * charge from the merchant's gross.
           */
          createdAt: now,
          settledAt: now,
        });

        /**
         * THE ATOMIC CLAIM, and the row count decides — the `walletToken`
         * pattern. Two simultaneous redemptions of one code produce one credit
         * and one refusal without this handler comparing anything.
         *
         * Scoped to HER member id as well as the code, so another customer's
         * voucher is the same refusal as a code that never existed: the ownership
         * check and the liveness check are one statement.
         */
        const claimed = await tx
          .update(voucher)
          .set({ redeemedAt: now, redeemedTransactionId: txId, updatedAt: now })
          .where(and(eq(voucher.code, code), eq(voucher.memberId, p.id), REDEEMABLE(now)))
          .returning();
        const v = claimed[0];
        if (!v) throw refuse();

        const balanceAfter = fils(m.balanceFils + v.amountFils);

        await tx
          .update(member)
          .set({ balanceFils: balanceAfter, updatedAt: now })
          .where(and(eq(member.id, m.id), isNull(member.erasedAt)));

        await tx.insert(ledgerEntry).values(
          voucherRedeemedPosting({
            transactionId: txId,
            salonId: m.salonId,
            memberId: m.id,
            amountFils: fils(v.amountFils),
            balanceAfterFils: balanceAfter,
          }),
        );

        await writeAudit(tx, p, {
          salonId: m.salonId,
          kind: 'money',
          action: 'Voucher redeemed',
          detail: `${formatMoney(fils(v.amountFils))} voucher ${v.code} redeemed · ${v.reason}`,
          source: 'wallet',
          subjectType: 'voucher',
          subjectId: v.id,
          amountFils: fils(v.amountFils),
          metadata: {
            memberId: m.id,
            voucherId: v.id,
            transactionId: txId,
            balanceAfterFils: balanceAfter,
          },
          ipAddress: req.ip ?? null,
          userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
        });

        const result = {
          voucher: serialiseVoucher({ ...v, redeemedAt: now, redeemedTransactionId: txId }),
          creditedFils: v.amountFils,
          balanceAfterFils: balanceAfter,
        };
        await completeKey(tx, keyId, { status: 200, body: result }, txId);
        return result;
      });

    try {
      return reply.send(await run());
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      /**
       * Her own key, replayed — the double-tapped Redeem button. The loser waits
       * for the winner's committed response and returns it verbatim rather than
       * computing a second one, which would be a second credit. The adjustment
       * path's exact shape, including reporting the in-flight state rather than
       * guessing at one.
       */
      const stored = await awaitCommittedKey(db, idem);
      if (stored) return reply.code(stored.status).send(stored.body);
      throw conflict(
        'request_in_progress',
        'That request is still being processed. Try again in a moment.',
      );
    }
  });
}
