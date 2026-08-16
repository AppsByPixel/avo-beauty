/**
 * The sandbox PSP's hosted page. Registered ONLY when GATEWAY_DRIVER=sandbox,
 * which env.ts refuses in production.
 *
 * This is the page `redirectUrl` points at — the thing a customer's browser
 * opens after `POST /topups`. It stands in for the processor's own checkout, so
 * the full round trip can be walked end to end without a card:
 *
 *   GET  /_gateway/:ref            the "checkout page". Marks the intent
 *                                  `redirected`, because this fetch is the one
 *                                  moment we genuinely know she arrived.
 *   POST /_gateway/:ref            "she pressed a button". Sets the outcome and
 *                                  optionally fires the signed callback, so
 *                                  callback-before-return and
 *                                  callback-after-return are both reproducible
 *                                  on demand.
 *
 * The callback it fires goes over real HTTP to `POST /webhooks/sandbox` with a
 * real HMAC. It does not call the settle service directly, because the point of
 * having a sandbox at all is to exercise the path the real PSP will take —
 * signature verification included.
 */

import type { FastifyInstance } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client';
import { topUpIntent } from '../db/schema/topup';
import { env } from '../env';
import { sandboxGateway } from '../gateway';
import { SIGNATURE_HEADER, isGatewayOutcome, signGatewayPayload } from '../gateway/sandbox';
import { badRequest, notFound } from '../http/errors';

export async function registerSandboxGatewayRoutes(app: FastifyInstance): Promise<void> {
  const sandbox = sandboxGateway();
  if (!sandbox) return;

  app.get<{ Params: { ref: string }; Querystring: { return?: string } }>(
    '/_gateway/:ref',
    async (req, reply) => {
      const payment = await sandbox.readPayment(req.params.ref);
      if (!payment) throw notFound('unknown_payment', 'No such payment.');

      // created → redirected. The customer really is on the hosted page; this
      // is the only signal in the whole flow that says so.
      await db
        .update(topUpIntent)
        .set({ status: 'redirected', updatedAt: new Date() })
        .where(and(eq(topUpIntent.id, payment.intentId), inArray(topUpIntent.status, ['created'])));

      const returnUrl = req.query.return ?? env.topupReturnUrl;
      return reply.type('text/html').send(
        `<!doctype html><meta charset="utf-8"><title>Sandbox checkout</title>
<h1>Sandbox checkout</h1>
<p>Payment <code>${payment.pspReference}</code> — ${(payment.amountFils / 1000).toFixed(3)} KD</p>
<p>Current outcome: <b>${payment.outcome}</b></p>
<p>Drive it with <code>POST /_gateway/${payment.pspReference}</code>
   <code>{"outcome":"succeeded|declined|cancelled|pending|gateway_error","notify":true}</code></p>
<p>Return URL: <a href="${returnUrl}">${returnUrl}</a></p>`,
      );
    },
  );

  app.post<{ Params: { ref: string } }>('/_gateway/:ref', async (req, reply) => {
    const payment = await sandbox.readPayment(req.params.ref);
    if (!payment) throw notFound('unknown_payment', 'No such payment.');

    const body = (req.body ?? {}) as Record<string, unknown>;
    const outcome = body.outcome;
    if (!isGatewayOutcome(outcome)) {
      throw badRequest(
        'invalid_outcome',
        'outcome must be succeeded, declined, cancelled, pending or gateway_error.',
      );
    }

    await sandbox.setOutcome(payment.pspReference, outcome);

    let delivery: { status: number; body: unknown } | null = null;
    if (body.notify !== false) {
      delivery = await deliverCallback({
        pspReference: payment.pspReference,
        outcome,
        amountFils: payment.amountFils,
        // The PSP's id for this DELIVERY. A caller can pin it to re-deliver the
        // SAME event (the duplicate case) or vary it to deliver a new one.
        eventId:
          typeof body.eventId === 'string' && body.eventId !== ''
            ? body.eventId
            : `EVT-${payment.pspReference}-${outcome}-${Date.now()}`,
      });
    }

    return reply.send({
      pspReference: payment.pspReference,
      outcome,
      returnUrl: `${env.topupReturnUrl}?intent=${encodeURIComponent(payment.intentId)}`,
      callback: delivery,
    });
  });
}

/** Fire a signed callback at our own webhook, exactly as a processor would. */
async function deliverCallback(params: {
  pspReference: string;
  outcome: string;
  amountFils: number;
  eventId: string;
}): Promise<{ status: number; body: unknown }> {
  const raw = JSON.stringify({
    eventId: params.eventId,
    pspReference: params.pspReference,
    status: params.outcome,
    amountFils: params.amountFils,
  });

  const res = await fetch(`${env.publicBaseUrl}/webhooks/sandbox`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [SIGNATURE_HEADER]: signGatewayPayload(raw, Math.floor(Date.now() / 1000)),
    },
    body: raw,
  });

  return { status: res.status, body: await res.json().catch(() => null) };
}
