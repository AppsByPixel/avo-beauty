/**
 * `POST /webhooks/{provider}` — the gateway callback.
 *
 * This is the most dangerous endpoint in the product. It is unauthenticated in
 * the ordinary sense (no session, no token — a stranger's HTTP request), and its
 * job is to add money to a wallet. Everything here follows from that.
 *
 * 1. THE SIGNATURE IS CHECKED BEFORE ANYTHING ELSE IS BELIEVED. A webhook that
 *    trusts its payload is an unauthenticated credit endpoint with a nice name.
 *    The check runs against the RAW body, not the parsed object: re-encoding
 *    JSON before hashing is the classic way a verification passes while
 *    verifying a different document than the one that was signed. That is why
 *    this route is registered in its own encapsulated context with a
 *    content-type parser that keeps the raw string.
 *
 * 2. A DUPLICATE DELIVERY ANSWERS 200. Not 409, not 422. A PSP reads a 4xx as
 *    "not delivered" and retries — for days, in some cases. The correct answer
 *    to "I have already handled this" is success, and the money must not move
 *    a second time to produce it. `UNIQUE (provider, event_id)` on
 *    `gateway_event` and the intent's state machine both guarantee that; see
 *    services/topup.ts.
 *
 * 3. AN UNKNOWN PROVIDER IS A 404. The only callbacks this deployment can
 *    verify are the configured driver's; a signature check against a processor
 *    we do not use has nothing to check with. Answering anything else would be
 *    pretending to have an integration.
 *
 * 4. THE CALLBACK IS A TRIGGER, NOT A RESULT — with one deliberate exception.
 *    A signed callback IS the processor speaking, so it is allowed to settle
 *    directly rather than causing a second read. It is authenticated; a client
 *    returning from a redirect is not. That is the whole distinction the
 *    "return URL is a hint" rule rests on.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { db } from '../db/client';
import { gateway } from '../gateway';
import { GatewayEventMalformedError } from '../gateway/types';
import { badRequest, notFound, unauthorized } from '../http/errors';
import { settleFromWebhook } from '../services/topup';

interface RawBodyRequest extends FastifyRequest {
  rawBody?: string;
}

export async function registerWebhookRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (scoped) => {
    // Encapsulated: only this context keeps the raw body, so the rest of the API
    // is unaffected.
    scoped.addContentTypeParser(
      'application/json',
      { parseAs: 'string' },
      (req, body, done) => {
        (req as RawBodyRequest).rawBody = body as string;
        try {
          done(null, body === '' ? {} : JSON.parse(body as string));
        } catch {
          // A body we cannot parse is still a body we can refuse without
          // handing the sender our parser's opinion of it.
          done(null, {});
        }
      },
    );

    scoped.post<{ Params: { provider: string } }>('/webhooks/:provider', async (req, reply) => {
      if (req.params.provider !== gateway.provider) {
        throw notFound('unknown_provider', 'No such payment provider.');
      }

      const raw = (req as RawBodyRequest).rawBody ?? '';
      if (!gateway.verifySignature(raw, req.headers)) {
        // Deliberately uninformative. "Bad timestamp" versus "bad MAC" is a
        // free oracle for whoever is probing.
        req.log.warn({ provider: req.params.provider }, 'rejected an unsigned gateway callback');
        throw unauthorized('That callback could not be verified.', 'invalid_signature');
      }

      let event;
      try {
        event = gateway.parseEvent(req.body);
      } catch (err) {
        if (err instanceof GatewayEventMalformedError) {
          // Signed but unreadable: a real integration bug on one side or the
          // other. A 400 is right here — retrying it will not help, and it must
          // be visible rather than silently 200'd away.
          throw badRequest('malformed_callback', 'That callback could not be read.');
        }
        throw err;
      }

      const result = await settleFromWebhook(db, {
        provider: gateway.provider,
        eventId: event.eventId,
        pspReference: event.pspReference,
        outcome: event.outcome,
        reportedStatus: event.reportedStatus,
        amountFils: event.amountFils,
        payload: req.body,
      });

      req.log.info(
        { pspReference: event.pspReference, eventId: event.eventId, outcome: result.kind },
        'gateway callback handled',
      );

      // Every branch is a 200. The body says what happened for operators and
      // for Lane D; the status code says "stop retrying", which is the only
      // thing the PSP reads.
      switch (result.kind) {
        case 'applied':
          return reply.send({
            received: true,
            outcome: 'applied',
            intentId: result.intent.id,
            status: result.intent.status,
            credited: result.credited,
          });
        case 'unchanged':
          return reply.send({
            received: true,
            outcome: 'ignored_illegal_transition',
            intentId: result.intent.id,
            status: result.intent.status,
            credited: false,
          });
        case 'amount_mismatch':
          return reply.send({
            received: true,
            outcome: 'ignored_amount_mismatch',
            intentId: result.intent.id,
            status: result.intent.status,
            credited: false,
          });
        case 'unknown_intent':
          return reply.send({ received: true, outcome: 'ignored_unknown_intent', credited: false });
        default:
          return reply.send({ received: true, outcome: 'duplicate', credited: false });
      }
    });
  });
}
