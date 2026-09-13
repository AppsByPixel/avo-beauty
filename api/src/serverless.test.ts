/**
 * The serverless entry point, driven rather than described.
 *
 * WHAT IT PROVES, AND WHY A REAL SOCKET. The handler's whole claim is that
 * `app.server.emit('request', req, res)` makes an un-`listen`ed Fastify instance
 * serve a platform's `req`/`res` pair. A mock pair would prove that the function
 * calls `emit`; it would not prove that Fastify's router, its `onRequest` hooks and
 * its serialiser actually run and produce a response. So this spec puts the
 * handler behind `http.createServer` — which is the exact shape Vercel's Node
 * runtime invokes it with — and makes ordinary HTTP requests against it.
 *
 * NO DATABASE. `/_health` touches none, and `auth/principal.ts` returns `null` for
 * a request with no `Authorization` header before it reaches `db` (and
 * AVO_TEST_PRINCIPALS is unset here), so the unreachable URL in
 * `vitest.config.ts` is never dialled. That is the same property that lets every
 * other unit spec in this package construct `buildApp()`.
 *
 * WHAT IT DELIBERATELY DOES NOT PROVE: that Vercel is configured correctly. That
 * lives in `vercel.json` and in an account this repository does not have. What is
 * testable here is the seam — and the seam is the part that could be wrong in a
 * way nobody notices until a deploy.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import handler, { resetForTests } from './serverless';

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const server: Server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

afterEach(() => {
  resetForTests();
});

describe('the serverless handler', () => {
  it('serves a route through an un-listened Fastify instance', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/_health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });
  });

  it('produces the API own 404 shape, so Fastify is routing rather than Node', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/definitely-not-a-route`);
      expect(res.status).toBe(404);
      // Fastify's own not-found body. A bare Node server would have hung or
      // answered nothing at all.
      expect(res.headers.get('content-type')).toContain('application/json');
    });
  });

  it('rejects an unauthenticated call to a guarded endpoint with 401, not 500', async () => {
    // The `onRequest` principal hook runs on this path: no bearer means
    // `principal: undefined` and the route guard produces the 401 itself. A 500
    // here would mean the hook had thrown, which is how a serverless port that
    // half-built the app would look.
    await withServer(async (base) => {
      const res = await fetch(`${base}/members/me`);
      expect(res.status).toBe(401);
    });
  });

  /**
   * COLD START, CONCURRENTLY. The build is cached as a PROMISE rather than as an
   * instance precisely for this case: a warm instance can be handed several
   * invocations before the first `buildApp()` has resolved. Caching the instance
   * would have started a second build for each of them, and a second build means
   * a second `postgres()` pool — which is the one thing `max: 1` exists to prevent.
   * Five simultaneous requests against a cold handler all answering is what says
   * the shared promise is doing its job.
   */
  it('a cold start under concurrency answers every invocation', async () => {
    await withServer(async (base) => {
      const results = await Promise.all(
        Array.from({ length: 5 }, () => fetch(`${base}/_health`).then((r) => r.status)),
      );
      expect(results).toEqual([200, 200, 200, 200, 200]);
    });
  });
});
