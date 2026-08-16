/**
 * Top-ups. The gateway leg is a sandbox adapter — CBK/PSP selection is a client
 * decision (CLAUDE.md § Escalate, don't guess), so nothing here commits to a
 * provider's API shape beyond the redirect-and-read-back flow the contract
 * specifies.
 *
 * Three Lane D findings are closed here:
 *
 *   - `amountFils` is validated at the boundary, so a fractional or negative
 *     amount is a 400 the client can act on rather than a 500 carrying the money
 *     helper's internal message. A negative top-up is not a typo; it is a drain
 *     path dressed as a credit.
 *   - the bonus and the fee are computed SERVER-SIDE. A client-supplied
 *     `bonusFils` or `creditFils` is ignored outright — non-negotiable #2, or a
 *     patched client tops up 1.000 KD and credits itself 1000.000.
 *   - `GET /topups/{id}` reads the intent that was actually asked for, and 404s
 *     on one that does not exist. The mock returned whichever intent was first
 *     in memory, so two customers topping up at once read each other's amounts,
 *     and a fabricated id was told the money landed.
 *
 * The credit itself lands on the PSP callback, not here: `POST /topups` creates
 * an intent, and the wallet balance moves when the gateway confirms. The webhook
 * is not built yet — see the report; Lane D has it as `LANE A OWES`.
 */

import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { add, commissionFor, percentOf, type PaymentMethod } from '@avo/types';
import { db } from '../db/client';
import { member } from '../db/schema/member';
import { salon } from '../db/schema/salon';
import { requireMember, hasScenario } from '../auth/principal';
import { badRequest, notFound } from '../http/errors';
import { parseAmountFils } from '../money/validate';
import {
  awaitCommittedKey,
  claimKey,
  completeKey,
  hashRequestBody,
  isUniqueViolation,
  principalScope,
  readIdempotencyKey,
} from '../services/idempotency';

const METHODS: PaymentMethod[] = ['knet', 'card', 'applepay'];

function intentId(): string {
  return `TI-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

export async function registerTopupRoutes(app: FastifyInstance): Promise<void> {
  app.post('/topups', async (req, reply) => {
    const p = requireMember(req);
    const key = readIdempotencyKey(req);

    const body = (req.body ?? {}) as Record<string, unknown>;
    const amount = parseAmountFils(body.amountFils);
    const method = (body.method ?? 'knet') as PaymentMethod;
    if (!METHODS.includes(method)) {
      throw badRequest('invalid_method', 'method must be knet, card or applepay.');
    }

    const idem = {
      scope: principalScope(p),
      endpoint: 'POST /topups',
      key,
      requestHash: hashRequestBody({ amountFils: amount, method }),
    };

    try {
      const result = await db.transaction(async (tx) => {
        const keyId = await claimKey(tx, idem);

        const memberRows = await tx.select().from(member).where(eq(member.id, p.id)).limit(1);
        const m = memberRows[0];
        if (!m) throw notFound('unknown_member', 'No such member.');

        const salonRows = await tx.select().from(salon).where(eq(salon.id, m.salonId)).limit(1);
        const s = salonRows[0];
        if (!s) throw notFound('unknown_salon', 'No such salon.');

        // The tier bonus is a SERVER computation and does not exist in stamps mode.
        const bonusPercent =
          s.loyaltyMode === 'stamps'
            ? 0
            : (s.tiers?.find((t) => t.name === m.tier)?.bonusPercent ?? 0);
        const bonus = percentOf(amount, bonusPercent);

        const id = intentId();
        const intent = {
          id,
          memberId: m.id,
          amountFils: amount,
          bonusFils: bonus,
          // What lands in the wallet. The commission is NOT deducted from it.
          creditFils: add(amount, bonus),
          method,
          // Merchant-visible, customer-never. The wallet must not render it.
          feeFils: commissionFor(amount, method),
          status: 'created' as const,
          failureReason: null,
          redirectUrl: `/_gateway/${id}`,
          reference: `KNET-${Math.floor(Math.random() * 9e7 + 1e7)}`,
        };

        await completeKey(tx, keyId, { status: 200, body: intent });
        return intent;
      });

      return reply.send(result);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const stored = await awaitCommittedKey(db, idem);
      if (stored) return reply.code(stored.status).send(stored.body);
      throw err;
    }
  });

  /**
   * The authoritative status read. api-contract.md § TopUpIntent client rule 1:
   * "The return URL is a hint, not a result."
   *
   * The intent is recovered from the idempotency row that created it, which is
   * where the response body was stored. That keeps the read honest — it can only
   * report an intent that was really created, so a fabricated id 404s instead of
   * being told the money landed.
   */
  app.get<{ Params: { id: string } }>('/topups/:id', async (req, reply) => {
    const p = requireMember(req);

    const { idempotencyKey } = await import('../db/schema/idempotency');
    const { and, eq: eqOp, sql } = await import('drizzle-orm');

    const rows = await db
      .select({ body: idempotencyKey.responseBody })
      .from(idempotencyKey)
      .where(
        and(
          eqOp(idempotencyKey.scope, principalScope(p)),
          eqOp(idempotencyKey.endpoint, 'POST /topups'),
          sql`${idempotencyKey.responseBody}->>'id' = ${req.params.id}`,
        ),
      )
      .limit(1);

    const intent = rows[0]?.body as Record<string, unknown> | undefined;
    if (!intent) throw notFound('unknown_topup', 'No such top-up.');

    // Sandbox outcomes, for the four screens the wallet has to build.
    if (hasScenario(req, 'declined')) {
      return reply.send({ ...intent, status: 'failed', failureReason: 'declined' });
    }
    if (hasScenario(req, 'cancelled')) {
      return reply.send({ ...intent, status: 'cancelled', failureReason: 'cancelled_by_user' });
    }
    // `pending` is its own screen — never collapsed into success or failure.
    if (hasScenario(req, 'pending')) {
      return reply.send({ ...intent, status: 'pending', failureReason: null });
    }
    return reply.send({ ...intent, status: 'succeeded', failureReason: null });
  });
}
