/**
 * The serverless entry point. `server.ts` is NOT this file and is unchanged.
 *
 * =========================================================================
 * WHY THIS IS A SECOND ENTRY POINT AND NOT A FLAG IN THE FIRST
 * =========================================================================
 * `server.ts` says why `buildApp()` does not start the background workers:
 *
 *     "The receipt worker starts HERE and not in `buildApp()`, because
 *      `buildApp()` is what the tests construct and a background loop attached to
 *      it would send receipts inside every test run."
 *
 * That split was made for test isolation and it happens to be exactly the split a
 * serverless runtime needs: a function invocation is a process that serves ONE
 * request and may be frozen the instant it replies, so a `setInterval` attached to
 * it either never fires or fires inside a frozen instance. `buildApp()` is already
 * "the app without the loops". This file uses it and adds nothing.
 *
 * The consequence is stated rather than discovered: ON THIS ENTRY POINT THE FIVE
 * BACKGROUND JOBS DO NOT RUN AT ALL. The receipt worker, the no-show sweep and the
 * top-up reaper are `server.ts`'s, and `src/jobs/*-once.ts` are one-shot scripts a
 * scheduler has to invoke. Nothing here schedules them and nothing here exposes
 * them over HTTP — adding routes for them would be adding endpoints, which is a
 * product decision (CLAUDE.md: "Do not add features"). See `README.md` § "Two
 * entry points" for what each one's absence costs.
 *
 * =========================================================================
 * HOW A FASTIFY APP BECOMES A NODE HANDLER
 * =========================================================================
 * Fastify owns a real `http.Server` internally; it just never gets `listen()`ed
 * here. `app.ready()` finishes plugin registration and route compilation, and
 * emitting `'request'` on that server hands the platform's `req`/`res` pair to
 * Fastify's own router. No adapter, no re-implementation of routing, and — the
 * point — the SAME `buildApp()` the tests construct and `server.ts` serves.
 *
 * THE APP IS BUILT ONCE PER WARM INSTANCE, not once per request. A cached promise
 * rather than a cached instance, so two invocations that arrive before the first
 * build finishes both await the same build instead of racing two of them.
 *
 * A FAILED BUILD IS NOT CACHED. Without the reset below, one boot failure — a
 * database URL that was briefly wrong, say — would poison every later invocation
 * on that instance with the same rejected promise, and the instance can live for
 * minutes. Clearing it makes the next request retry.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app';

let booting: Promise<FastifyInstance> | null = null;

function readyApp(): Promise<FastifyInstance> {
  booting ??= buildApp()
    .then(async (app) => {
      await app.ready();
      return app;
    })
    .catch((err: unknown) => {
      booting = null;
      throw err;
    });
  return booting;
}

/**
 * The default export is what a Vercel Node function is required to be. It is also
 * an ordinary `http.createServer` handler, which is how `serverless.test.ts` drives
 * real requests through it without a platform.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let app: FastifyInstance;
  try {
    app = await readyApp();
  } catch (err) {
    /**
     * A boot failure has no Fastify to render it, so this is the one place in the
     * API that writes an error body by hand. It says nothing about the cause on
     * purpose — a misconfigured connection string must not be echoed to a caller —
     * and the cause goes to the platform log instead, which is where it is read.
     */
    console.error('serverless: buildApp() failed', err);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'server_error', message: 'Something went wrong on our side.' }));
    return;
  }
  app.server.emit('request', req, res);
}

/** Exported for the spec, which must be able to assert a cold build per case. */
export function resetForTests(): void {
  booting = null;
}
