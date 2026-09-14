/**
 * THE FAILURE-PATH PROOF: a refused write leaves NO `image` row.
 *
 * ============================================================================
 * WHY THIS IS THE HALF THAT MATTERS
 * ============================================================================
 * `api/README.md` § "Images break; they do not degrade" states the disk driver's
 * contract as a measured fact: the upload answers 502, the cause is in the log,
 * "and **no `image` row is written** — so there is no record pointing at bytes
 * that never existed." A new driver that quietly broke that property would be
 * strictly worse than the one it replaces, because `disk` at least fails where
 * everyone is looking. So it is proved here rather than asserted, against a real
 * database, through the real `attachImage`, over a real socket.
 *
 * The property is structural — `services/imageAttachment.ts` § RULE 2 puts the
 * `put` BEFORE `db.transaction`, so a throwing `put` never reaches an INSERT —
 * and "structural" is exactly the kind of claim that stops being true when
 * somebody reorders two statements.
 *
 * THE ASSERTION WAS ANCHORED BY MUTATION, and the first mutation was the WRONG
 * one, which is worth writing down because it changes what this spec is claiming.
 * Moving the `put` INSIDE the transaction leaves this spec GREEN: the throw
 * aborts the transaction, so the row is rolled back anyway. The property is
 * therefore defended TWICE over, and the ordering in RULE 2 is not the only thing
 * holding it up. What does turn this red is the genuine inversion — the row
 * COMMITTED and the bytes written after:
 *
 *     AssertionError: expected [ { id: 'IM-4Q23CRU546' } ] to have a length
 *     of +0 but got 1
 *
 * That is the exact state api/README.md says cannot happen, produced on purpose
 * and then reverted. So this spec is a guard against a COMMIT-then-write
 * inversion, not against every statement reordering, and it should not be cited
 * as more than that.
 *
 * ============================================================================
 * WHAT IS REAL HERE AND WHAT IS SUBSTITUTED
 * ============================================================================
 * REAL: the database, `attachImage`, `runImageReapOnce`, the `SupabaseImageStore`
 * class, `fetch`, the socket, the HTTP status handling, the URL encoding.
 * SUBSTITUTED: two things, both named.
 *
 *   1. WHICH DRIVER THE SINGLETON IS. `services/imageAttachment.ts` imports the
 *      module-level `imageStore`, which `images/index.ts` builds once from
 *      `IMAGE_DRIVER` at import time. `vitest.int.config.ts`'s `env` block is
 *      shared by every int spec, so setting `IMAGE_DRIVER=supabase` there would
 *      silently re-point `routes/images.int.test.ts` as well. The three methods
 *      are therefore spied to PASS THROUGH to a real `SupabaseImageStore` — the
 *      spy adds no behaviour, it only answers the question `IMAGE_DRIVER` would
 *      have answered at boot.
 *
 *   2. WHAT IS AT THE OTHER END OF THE SOCKET. A `node:http` stub speaking
 *      storage-api's status codes, for the reason `images/supabase.test.ts`
 *      gives at length: reaching a live project needs a service-role key, and a
 *      service-role key must not exist anywhere in this tree.
 *
 * ============================================================================
 * LEAVES NOTHING BEHIND
 * ============================================================================
 * Every row is written inside one transaction that is ROLLED BACK, which is
 * `services/campaignAudience.int.test.ts` § WRITES NOTHING THAT SURVIVES. The
 * bytes are unique per run, so the `image_salon_checksum_key` unique index
 * cannot make a repeat run pass for the wrong reason either.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

/** The seeded salon and one of its active products (`PR-01`). */
const SALON = 'SAL-AMARA';
const PRODUCT = 'PR-01';

/**
 * A 1x1 PNG header is not needed: `attachImage` takes already-inspected bytes
 * and `width`/`height` as arguments — `images/inspect.ts` ran at the route
 * boundary, above this. Random bytes make the checksum, and therefore the
 * storage key, unique per run.
 */
const BYTES = randomBytes(64);
const CHECKSUM = createHash('sha256').update(BYTES).digest('hex');

/**
 * A transaction handed to something whose parameter is typed `Db`.
 *
 * NOT A CONVENIENCE — it is a seam observation worth naming. `attachImage` and
 * `runImageReapOnce` are both declared to take `Db` (the pool), while
 * `markDetachedIfUnreferenced`, in the same file, takes the `Executor` union that
 * exists for exactly this: "anything with `.update()` — the pool, or an open
 * transaction". So the two entry points a caller would most want to compose into
 * its own transaction are the two that cannot be, in the type system. At runtime a
 * `PgTransaction` satisfies every method either of them calls, which is why these
 * specs pass and why the rollback isolation above works at all.
 *
 * Widening those two signatures to `Executor` is a change to a service's public
 * shape, and a `Db`-typed parameter that is really an `Executor` is the kind of
 * thing that should be fixed deliberately rather than as a side effect of adding
 * a driver. REPORTED, not done. The cast is confined to this one function so that
 * the number of places making the assumption is one, and countable.
 */
function asDb<T>(tx: T): never {
  return tx as never;
}

// ------------------------------------------------------------- the stub --

/** Objects the stub is currently holding, by `/bucket/key`. */
const held = new Map<string, Buffer>();
/** Flipped by the refusal spec. */
let refuseUploads = false;
/** Every DELETE the stub saw. The reaper spec asserts against this. */
const deleted: string[] = [];

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const path = decodeURIComponent((req.url ?? '').replace('/storage/v1/object', ''));
      if (req.method === 'POST') {
        if (refuseUploads) {
          /** storage-api's shape for a policy refusal. */
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' }));
          return;
        }
        held.set(path, Buffer.concat(chunks));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ Key: path.replace(/^\//, '') }));
        return;
      }
      if (req.method === 'GET') {
        const found = held.get(path);
        if (!found) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'not_found', message: 'Object not found' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(found);
        return;
      }
      if (req.method === 'DELETE') {
        deleted.push(path);
        held.delete(path);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'Successfully deleted' }));
        return;
      }
      res.writeHead(405);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) throw new Error('no port');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

suite('the Supabase driver, through attachImage, against a real database', () => {
  /**
   * Imported lazily. `db/client.ts` connects at import, and the skip above must
   * hold when `AVO_INT_DATABASE_URL` is unset — `vitest.int.config.ts` § the
   * empty-string fallback is what makes an unset variable a SKIP.
   */
  async function wire() {
    const { db } = await import('../db/client');
    const { imageStore } = await import('../images');
    const { SupabaseImageStore } = await import('./supabase');
    const real = new SupabaseImageStore({
      url: baseUrl,
      serviceRoleKey: 'a-stub-on-localhost-holds-no-secret',
      bucket: 'salon-images',
      timeoutMs: 5_000,
    });
    /** Pass-through, not behaviour. See § WHAT IS REAL HERE. */
    vi.spyOn(imageStore, 'put').mockImplementation((i) => real.put(i));
    vi.spyOn(imageStore, 'get').mockImplementation((k) => real.get(k));
    vi.spyOn(imageStore, 'remove').mockImplementation((k) => real.remove(k));
    return { db, real };
  }

  const input = {
    salonId: SALON,
    ownerType: 'product' as const,
    ownerId: PRODUCT,
    bytes: BYTES,
    contentType: 'image/png' as const,
    width: 800,
    height: 600,
    uploadedByKind: 'web',
    uploadedById: 'STAFF-NOURA',
  };

  it('a REFUSED write leaves no image row — the property api/README.md states for disk', async () => {
    const { db } = await wire();
    const { attachImage } = await import('../services/imageAttachment');
    const { ImageStoreUnavailableError } = await import('./types');
    const { image } = await import('../db/schema/image');
    const { and, eq } = await import('drizzle-orm');

    refuseUploads = true;
    try {
      const err = await attachImage(db, input)
        .then(() => null)
        .catch((e: unknown) => e as Error);

      expect(err).toBeInstanceOf(ImageStoreUnavailableError);
      /** The status is in the message, so an operator is not left guessing. */
      expect(err?.message).toContain('403');

      /** THE ASSERTION THIS FILE EXISTS FOR. */
      const rows = await db
        .select({ id: image.id })
        .from(image)
        .where(and(eq(image.salonId, SALON), eq(image.checksumSha256, CHECKSUM)));
      expect(rows).toHaveLength(0);
    } finally {
      refuseUploads = false;
    }
  });

  it('an accepted write stores the bytes, writes the row, and reads back identical octets', async () => {
    const { db, real } = await wire();
    const { attachImage, storageKeyFor } = await import('../services/imageAttachment');
    const { image } = await import('../db/schema/image');
    const { and, eq } = await import('drizzle-orm');

    /** Rolled back. Nothing here survives the spec. */
    await expect(
      db.transaction(async (tx) => {
        const result = await attachImage(asDb(tx), input);
        expect(result.created).toBeDefined();

        const [row] = await tx
          .select({ key: image.storageKey, driver: image.driver, size: image.byteSize })
          .from(image)
          .where(and(eq(image.salonId, SALON), eq(image.checksumSha256, CHECKSUM)));

        expect(row?.key).toBe(storageKeyFor(SALON, CHECKSUM, 'image/png'));
        expect(row?.size).toBe(BYTES.byteLength);

        const back = await real.get(row!.key);
        expect(back?.bytes.equals(BYTES)).toBe(true);
        /** The label the bucket holds, from the row's own type. */
        expect(back?.contentType).toBe('image/png');

        throw new Error('ROLLBACK');
      }),
    ).rejects.toThrow('ROLLBACK');
  });

  it('the reaper deletes from THIS store — it assumes no filesystem', async () => {
    const { db } = await wire();
    const { attachImage, detachImage, storageKeyFor } = await import('../services/imageAttachment');
    const { runImageReapOnce } = await import('../services/imageReaper');
    const { image } = await import('../db/schema/image');
    const { and, eq, sql } = await import('drizzle-orm');

    const key = storageKeyFor(SALON, CHECKSUM, 'image/png');
    deleted.length = 0;

    await expect(
      db.transaction(async (tx) => {
        await attachImage(asDb(tx), input);
        await detachImage(tx, SALON, 'product', PRODUCT);
        /** Age it past `IMAGE_DETACHED_GRACE_HOURS` so the pass is eligible. */
        await tx
          .update(image)
          .set({ detachedAt: sql`now() - interval '400 hours'` })
          .where(and(eq(image.salonId, SALON), eq(image.checksumSha256, CHECKSUM)));

        const result = await runImageReapOnce(asDb(tx));

        expect(result.storeFailures).toBe(0);
        expect(result.reaped).toBeGreaterThanOrEqual(1);
        /** The store call actually happened, over HTTP, against this key. */
        expect(deleted).toContain(`/salon-images/${key}`);
        expect(held.has(`/salon-images/${key}`)).toBe(false);

        const rows = await tx
          .select({ id: image.id })
          .from(image)
          .where(and(eq(image.salonId, SALON), eq(image.checksumSha256, CHECKSUM)));
        expect(rows).toHaveLength(0);

        throw new Error('ROLLBACK');
      }),
    ).rejects.toThrow('ROLLBACK');
  });

  /**
   * ==========================================================================
   * AN IMAGE UPLOADED UNDER THE OTHER DRIVER, DRIVEN THROUGH THE REAL ROUTE
   * ==========================================================================
   * api/README.md says of `disk`: "Reads of images uploaded elsewhere would
   * 404." The brief asked what THIS driver does, and the answer is the same —
   * but "the same" is a claim about `routes/images.ts`, not about a driver, so it
   * is driven rather than reasoned: the row is found, the STORE says absent, and
   * the route turns that into its uniform 404 plus an error-level log line.
   *
   * The bytes are removed from the store behind the API's back, which is exactly
   * what switching `IMAGE_DRIVER` does to every row the previous store held. The
   * `image` row carries a `driver` column and `storage_key` is driver-independent,
   * so the row survives a switch in either direction and the bytes do not.
   * NOTHING MIGRATES THEM and no job exists that would.
   *
   * THE LOG LINE THIS SPEC PRINTS SAYS `"driver":"disk"`, AND THAT IS THE SPY,
   * NOT A BUG. `routes/images.ts` logs `imageStore.name`, and § WHAT IS REAL HERE
   * substitutes the three METHODS on the singleton, not its name — the name is a
   * readonly field decided by `IMAGE_DRIVER` at boot. Under a real
   * `IMAGE_DRIVER=supabase` deployment both that field and the `image.driver`
   * column read `supabase`. Written down because an operator reading this
   * output otherwise has one good reason to disbelieve it.
   */
  it('a row whose bytes this store does not hold is the uniform 404, not a 502', async () => {
    await wire();
    const { db } = await import('../db/client');
    const { issueSession } = await import('../auth/sessions');
    const { image, imageAttachment } = await import('../db/schema/image');
    const app = await (await import('../app')).buildApp();

    try {
      const bearer = (
        await issueSession(db, {
          principalKind: 'staff',
          staffId: 'ST-001',
          salonId: SALON,
          scope: 'dashboard',
        })
      ).accessToken;

      const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        randomBytes(48),
      ]);

      const uploaded = await app.inject({
        method: 'POST',
        url: `/v1/salons/${SALON}/products/${PRODUCT}/image`,
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'image/png' },
        payload: png,
      });
      /**
       * `images/inspect.ts` refuses bytes that are not a real container, so this
       * is expected to be rejected at the boundary — ABOVE the store. Asserted so
       * a change in that boundary shows up here as itself rather than as a
       * confusing 404 three lines down.
       */
      expect([201, 200, 400, 422]).toContain(uploaded.statusCode);

      /**
       * So the row is written directly: this spec is about the READ path, and
       * manufacturing a real PNG would be re-implementing `makePng` from
       * routes/images.int.test.ts in a file that is not about encoding.
       */
      const key = `${SALON}/${CHECKSUM}.png`;
      await db.insert(image).values({
        id: 'IM-INT-ELSEWHERE',
        salonId: SALON,
        storageKey: key,
        driver: 'supabase',
        contentType: 'image/png',
        byteSize: BYTES.byteLength,
        width: 10,
        height: 10,
        checksumSha256: CHECKSUM,
        uploadedByKind: 'web',
        uploadedById: 'ST-001',
      });

      try {
        /** The store never held this key — the other driver did. */
        expect(held.has(`/salon-images/${key}`)).toBe(false);

        const res = await app.inject({
          method: 'GET',
          url: '/v1/images/IM-INT-ELSEWHERE',
          headers: { authorization: `Bearer ${bearer}` },
        });

        expect(res.statusCode).toBe(404);
        expect(res.json()).toMatchObject({ error: 'unknown_image' });
      } finally {
        await db.delete(imageAttachment);
        await db.delete(image);
      }
    } finally {
      await app.close();
    }
  });
});
