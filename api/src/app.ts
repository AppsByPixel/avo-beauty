/**
 * The Fastify application.
 *
 * Two things happen here that everything else depends on.
 *
 * 1. THE PRINCIPAL IS RESOLVED ONCE PER REQUEST, in an `onRequest` hook, and
 *    hung on the request. Handlers then call `requireScannerPerm(req, 'scanner')`
 *    or `requireDashboardPerm(req, 'team')` as their first statement — the
 *    surface an endpoint belongs to is always named, never inferred.
 *    Resolution is deliberately non-fatal — an anonymous
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
import { registerDeviceRoutes } from './routes/devices';
import { registerTopupRoutes } from './routes/topups';
import { registerSalonRoutes } from './routes/salons';
import { registerArtistRoutes } from './routes/artists';
import { registerBookingRoutes } from './routes/bookings';
import { registerOrderRoutes } from './routes/orders';
import { registerAddressRoutes } from './routes/addresses';
import { registerLoyaltyRoutes } from './routes/loyalty';
import { registerAuditRoutes } from './routes/audit';
import { registerActivityRoutes } from './routes/activity';
import { registerPlatformRoutes } from './routes/platform';
import { registerPlatformAdminRoutes } from './routes/platformAdmins';
import { registerPlatformConsoleRoutes } from './routes/platformConsole';
import { registerCampaignRoutes } from './routes/campaigns';
import { registerPolicyRoutes } from './routes/policies';
import { registerSupportRoutes } from './routes/support';
import { registerReportRoutes } from './routes/reports';
import { registerAdjustmentRoutes } from './routes/adjustments';
import { registerVoucherRoutes } from './routes/vouchers';
import { registerAccountResetRoutes } from './routes/accountResets';
import { registerAccountRoutes } from './routes/accounts';
import { registerImageRoutes } from './routes/images';
import { registerWebhookRoutes } from './routes/webhooks';
import { registerSandboxGatewayRoutes } from './routes/sandboxGateway';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    /**
     * IN TEST, ERRORS ONLY — NOT SILENCE.
     *
     * This was `false`, and that made `http/errors.ts`'s
     * `req.log.error({ err }, 'unhandled error')` — written so that a 5xx is "an
     * incident logged like one" — write NOTHING in the one configuration where
     * 5xxs are actually seen. The e2e harness boots this API with
     * `NODE_ENV=test` and captures its stdout/stderr for `apiLogTail()`, so
     * every "--- the API's own log ---" in a failure message printed
     * "(nothing on stdout/stderr)" and a 500 had to be re-diagnosed by hand.
     *
     * `level: 'error'` and no pino-pretty transport: Fastify's own
     * request/response lines are `info`, so a green run stays exactly as quiet
     * as it was, and the raw JSON goes straight to the harness's capture.
     *
     * AND OUTSIDE TEST, PRETTY ONLY FOR A TTY — which is a fix, not a preference.
     *
     * The `else` branch used to be an unconditional `pino-pretty` transport, and
     * it killed the first working serverless deploy at boot:
     *
     *     Error: unable to determine transport target for "pino-pretty"
     *       at createPinoLogger (.../fastify/lib/logger-pino.js:40:14)
     *       at buildApp (/var/task/api/src/app.ts:60:15)
     *
     * `pino-pretty` IS NOT A DEPENDENCY OF `@avo/api`. It is declared by
     * `packages/mock` alone, and the only reason `pnpm --dir api start` ever
     * printed colour is that the monorepo install happens to leave it somewhere
     * this package can reach. Declaring it here would not have fixed the deploy
     * either: pino names a transport target by STRING and loads it in a worker
     * thread, so Vercel's dependency tracer — which follows imports — ships
     * nothing for it and the resolution fails inside the function regardless.
     *
     * It is also the wrong thing to want there. A pretty transport is a second
     * thread whose job is ANSI colour for a human watching a terminal; a function
     * invocation may be frozen the instant it replies (serverless.ts § HOW A
     * FASTIFY APP BECOMES A NODE HANDLER makes the same argument about the
     * background workers), and Vercel parses pino's plain JSON into structured log
     * rows on its own. Colour there is cost with no reader.
     *
     * `process.stdout.isTTY` is the narrowest predicate that says "a developer is
     * watching this": true for `pnpm --dir api start` in a terminal, which keeps
     * that output byte-for-byte what it was, and false for a function, for CI, and
     * for anything capturing the stream — all of which get pino's JSON, which is
     * what reads those. No new environment variable, because the question is not
     * a configuration choice.
     */
    logger:
      env.nodeEnv === 'test'
        ? { level: 'error', redact: ['req.headers.authorization'] }
        : process.stdout.isTTY
          ? { transport: { target: 'pino-pretty' }, redact: ['req.headers.authorization'] }
          : { redact: ['req.headers.authorization'] },
    // Money bodies are small. A generous limit is just a DoS surface.
    bodyLimit: 256 * 1024,
    /**
     * Whether `req.ip` is the customer or the load balancer.
     *
     * This matters now in a way it did not before: the signup limiter
     * (services/signupLimit.ts) counts attempts per address, so `req.ip` stopped
     * being a field written into an audit row and became a CONTROL. Off by
     * default — see env.ts for why both settings are wrong in production until
     * TRUST_PROXY names the real proxy, and why off is the safer of the two
     * wrongs.
     */
    trustProxy: env.trustProxy,
  });

  await app.register(cors, {
    origin: true,
    /**
     * `content-disposition` is not on the CORS safelist, so a cross-origin
     * fetch of a CSV export read the filename as null and Lane C fell back to
     * client-side naming. The server names the file — the branch tag and
     * period are baked into it — so the header has to be readable.
     */
    exposedHeaders: ['content-disposition'],
  });

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
  await registerDeviceRoutes(app);
  await registerChargeRoutes(app);
  await registerTopupRoutes(app);
  await registerSalonRoutes(app);
  await registerArtistRoutes(app);
  await registerBookingRoutes(app);
  await registerOrderRoutes(app);
  await registerAddressRoutes(app);
  await registerLoyaltyRoutes(app);
  await registerAuditRoutes(app);
  await registerActivityRoutes(app);
  await registerPlatformRoutes(app);
  await registerPlatformAdminRoutes(app);
  await registerPlatformConsoleRoutes(app);
  await registerCampaignRoutes(app);
  await registerPolicyRoutes(app);
  await registerSupportRoutes(app);
  await registerReportRoutes(app);
  await registerAdjustmentRoutes(app);
  await registerVoucherRoutes(app);
  await registerAccountResetRoutes(app);
  await registerAccountRoutes(app);
  await registerImageRoutes(app);

  // The gateway callback. Unauthenticated in the ordinary sense and verified by
  // signature instead — see routes/webhooks.ts.
  await registerWebhookRoutes(app);
  // The sandbox PSP's hosted page. A no-op unless GATEWAY_DRIVER=sandbox, which
  // env.ts refuses in production.
  await registerSandboxGatewayRoutes(app);

  app.get('/_health', async () => ({ ok: true }));

  return app;
}
