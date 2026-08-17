/**
 * Top-ups — `POST /topups` and the authoritative `GET /topups/{id}`.
 *
 * The flow, api-contract.md § TopUpIntent:
 *
 *   POST /topups → open `redirectUrl` → gateway returns to
 *   avo://topup/return?intent={id} → GET /topups/{id}
 *
 * This file is thin on purpose: the machine, the money and the transaction
 * boundaries are in services/topup.ts, and the processor is behind
 * gateway/. What lives here is the HTTP contract — who may call, what the body
 * must be, and the idempotency replay.
 *
 * THE CLIENT RULES, MADE TRUE SERVER-SIDE
 * ---------------------------------------
 * 1. "The return URL is a hint, not a result." Nothing about this handler pair
 *    can be talked into a credit by a client arriving at
 *    `avo://topup/return?intent=TI-1&status=paid`. The only thing that credits
 *    a wallet is `gateway.fetchPayment` — a read this server performs — or a
 *    callback with a valid signature.
 * 2. `pending` is a real state and is returned as `pending`, never collapsed
 *    into success or failure.
 * 3. `POST /topups` requires an Idempotency-Key. Same key + same body replays;
 *    same key + DIFFERENT body is 422 (api-contract.md § Addendum), which the
 *    shared idempotency service enforces.
 *
 * Three earlier Lane D findings stay closed here: `amountFils` is validated at
 * the boundary so a fraction is a 400 rather than a 500; the bonus, the credit
 * and the fee are computed server-side and a client-supplied one is ignored
 * outright; and `GET /topups/{id}` reads the intent that was actually asked
 * for, scoped to its owner, 404ing on one that does not exist.
 *
 * THE COMMISSION IS ON NEITHER ENDPOINT
 * -------------------------------------
 * Both handlers answer the customer shape — `TopUpIntentPublicSchema`, which is
 * `TopUpIntentSchema` without `feeFils`. The rule is api-contract.md
 * § Commission and its addendum, confirmed by the product owner: the split is
 * configured at MyFatoorah and "the customer doesn't see this of course, they
 * just see the price". The omission is structural, not a deleted line —
 * services/topup.ts projects onto the contract's own key list.
 *
 * `POST /topups` IS AS CUSTOMER-FACING AS THE GET, which is why it moved: the
 * wallet is what calls it. It previously answered the full shape because Lane
 * D's `money.test.ts` asserted `feeFils` on this exact response, so the two
 * endpoints could not move independently. Those specs now read the commission
 * off `topup_intent.fee_fils` instead — both where the number lives, and the
 * stronger assertion, because it proves the fee was RECORDED rather than merely
 * reported. With the blocker gone, the write side matches the read side.
 *
 * THE REPLAY IS COVERED BY THE SAME PROJECTION, not a second one. `createTopUp`
 * stores the public body in the idempotency record, so the `stored.body` replay
 * below cannot carry a fee the original response did not.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { db } from '../db/client';
import { env } from '../env';
import { hasScenario, requireMember } from '../auth/principal';
import { parseAmountFils } from '../money/validate';
import { isGatewayOutcome } from '../gateway/sandbox';
import type { GatewayOutcome } from '../gateway/types';
import {
  awaitCommittedKey,
  hashRequestBody,
  isUniqueViolation,
  principalScope,
  readIdempotencyKey,
} from '../services/idempotency';
import { createTopUp, parseMethod, readTopUp } from '../services/topup';

/**
 * The sandbox's outcome switch, read off `x-avo-scenario`.
 *
 * Lanes B and D need all five outcomes without a real card. The hint is passed
 * to the driver, which WRITES it to its stored payment and then reports it — so
 * the status the client receives is still a real read of gateway state. It is
 * only ever offered when the sandbox driver is configured, and env.ts refuses
 * that driver in production.
 */
function simulationHint(req: FastifyRequest): GatewayOutcome | undefined {
  if (env.gatewayDriver !== 'sandbox') return undefined;
  for (const name of ['declined', 'cancelled', 'pending', 'gateway_error'] as const) {
    if (hasScenario(req, name) && isGatewayOutcome(name)) return name;
  }
  return undefined;
}

export async function registerTopupRoutes(app: FastifyInstance): Promise<void> {
  app.post('/topups', async (req, reply) => {
    const p = requireMember(req);
    const key = readIdempotencyKey(req);

    const body = (req.body ?? {}) as Record<string, unknown>;
    const amountFils = parseAmountFils(body.amountFils);
    const method = parseMethod(body.method);

    // Only the fields the server acts on are fingerprinted. A client that
    // resends its ignored `bonusFils` on a retry still gets a replay rather
    // than a 422 about a field that was never read.
    const idem = {
      scope: principalScope(p),
      endpoint: 'POST /topups',
      key,
      requestHash: hashRequestBody({ amountFils, method }),
    };

    try {
      const intent = await createTopUp(
        db,
        { amountFils, method },
        {
          principal: p,
          idempotency: idem,
          failCreate: env.gatewayDriver === 'sandbox' && hasScenario(req, 'gateway_create_error'),
        },
      );
      return reply.send(intent);
    } catch (err) {
      // Lost the unique-index race: the winner's answer is the answer.
      if (!isUniqueViolation(err)) throw err;
      const stored = await awaitCommittedKey(db, idem);
      if (stored) return reply.code(stored.status).send(stored.body);
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>('/topups/:id', async (req, reply) => {
    const p = requireMember(req);
    const intent = await readTopUp(db, p, req.params.id, simulationHint(req));
    return reply.send(intent);
  });
}
