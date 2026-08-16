/**
 * The Fastify application.
 *
 * Two things happen here that everything else depends on.
 *
 * 1. THE PRINCIPAL IS RESOLVED ONCE PER REQUEST, in an `onRequest` hook, and
 *    hung on the request. Handlers then call `requirePerm(req, 'scanner')` as
 *    their first statement. Resolution is deliberately non-fatal — an anonymous
 *    request gets `principal: undefined` rather than a 401 here — because the
 *    sign-in routes are anonymous by definition and a global reject would have
 *    to carve out exceptions, which is how an endpoint ends up accidentally
 *    public.
 *
 * 2. SCENARIOS. Lane D's suite and lanes B/C drive states with `x-avo-scenario`.
 *    Only the transport-level ones live here (loading / error / offline); the
 *    data-level ones are handled by the routes that own that data. All of it is
 *    behind AVO_TEST_PRINCIPALS, which env.ts refuses to accept in production.
 */

import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { db } from './db/client';
import { env } from './env';
import { hasScenario, resolvePrincipal } from './auth/principal';
import { registerErrorHandler } from './http/errors';
import { registerAuthRoutes } from './routes/auth';
import { registerMemberRoutes } from './routes/members';
import { registerStaffRoutes } from './routes/staff';
import { registerChargeRoutes } from './routes/charges';
import { registerTopupRoutes } from './routes/topups';
import { registerSalonRoutes } from './routes/salons';
import { registerPlatformRoutes } from './routes/platform';
import { registerWebhookRoutes } from './routes/webhooks';
import { registerSandboxGatewayRoutes } from './routes/sandboxGateway';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      env.nodeEnv === 'test'
        ? false
        : { transport: { target: 'pino-pretty' }, redact: ['req.headers.authorization'] },
    // Money bodies are small. A generous limit is just a DoS surface.
    bodyLimit: 256 * 1024,
  });

  await app.register(cors, { origin: true });

  registerErrorHandler(app);

  /** Transport-level scenarios. Test builds only. */
  if (env.testPrincipals) {
    app.addHook('onRequest', async (req, reply) => {
      if (hasScenario(req, 'loading')) await sleep(3000);
      if (hasScenario(req, 'error')) {
        await reply
          .code(500)
          .send({ error: 'server_error', message: 'Something went wrong on our side.' });
        return reply;
      }
      if (hasScenario(req, 'offline')) {
        await reply
          .code(503)
          .send({ error: 'unavailable', message: 'No connection. Showing your last update.' });
        return reply;
      }
      return undefined;
    });
  }

  /**
   * Resolve who is calling. A bad or revoked token leaves `principal` undefined
   * and the request continues as anonymous — the guards produce the 401.
   */
  app.addHook('onRequest', async (req) => {
    req.principal = (await resolvePrincipal(db, req)) ?? undefined;
  });

  await registerAuthRoutes(app);
  await registerMemberRoutes(app);
  await registerStaffRoutes(app);
  await registerChargeRoutes(app);
  await registerTopupRoutes(app);
  await registerSalonRoutes(app);
  await registerPlatformRoutes(app);

  // The gateway callback. Unauthenticated in the ordinary sense and verified by
  // signature instead — see routes/webhooks.ts.
  await registerWebhookRoutes(app);
  // The sandbox PSP's hosted page. A no-op unless GATEWAY_DRIVER=sandbox, which
  // env.ts refuses in production.
  await registerSandboxGatewayRoutes(app);

  app.get('/_health', async () => ({ ok: true }));

  return app;
}
