/**
 * The Supabase Storage driver's HTTP behaviour, against a stub that speaks the
 * status codes and bodies storage-api speaks.
 *
 * ============================================================================
 * OFFLINE, AND NOT BECAUSE OFFLINE IS EASIER
 * ============================================================================
 * `gateway/myfatoorah.test.ts` reaches no network either, and says why: what
 * belongs in a suite that gates CI is the part that must not drift. The same
 * applies here with one difference that must be stated rather than glossed —
 * THE LIVE SHAPES BELOW WERE NOT VERIFIED AGAINST A LIVE SUPABASE PROJECT.
 * MyFatoorah's fixtures are verbatim captures; these are not, because verifying
 * them needs a service-role key, and a service-role key must not exist in this
 * tree in any form (CLAUDE.md § lanes/secrets, api/.env.example § no defaults).
 *
 * So the driver is written to accept BOTH shapes storage-api has returned for a
 * missing object across its versions — a bare `404`, and a `400` whose body
 * carries `{"statusCode":"404"}` — and both are asserted here. That is not
 * belt-and-braces for its own sake: `get` returning `null` rather than throwing
 * is the difference between `GET /v1/images/{id}` answering the documented 404
 * and answering 502, and getting it wrong in the direction of "throw" turns a
 * reaped image into an outage.
 *
 * ============================================================================
 * A STUB SERVER, NOT A MOCKED `fetch`
 * ============================================================================
 * The driver takes no injected transport. A `vi.fn()` standing in for `fetch`
 * would prove that the driver calls something with arguments the test already
 * decided on; this proves that a real `fetch` against a real socket, with the
 * real header set, the real URL encoding and the real body handling, produces
 * the errors the route turns into status codes. The stub is `node:http`, which
 * is built in — this driver adds no dependency and neither does its suite.
 */

import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SupabaseImageStore } from './supabase';
import type { ImageStore } from './types';
import { ImageStoreUnavailableError } from './types';

// --------------------------------------------------------------- the stub --

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/** What the next request should be answered with. Set per test. */
let reply: (seen: Seen) => { status: number; body?: Buffer | string; headers?: Record<string, string> };
/** Every request the driver actually made. Asserted on, not just inspected. */
let seenAll: Seen[] = [];

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const seen: Seen = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks),
      };
      seenAll.push(seen);
      const out = reply(seen);
      res.writeHead(out.status, out.headers ?? {});
      res.end(out.body ?? '');
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

beforeEach(() => {
  seenAll = [];
  reply = () => ({ status: 200, body: '{}' });
});

const SECRET = 'not-a-real-service-role-key-for-a-stub-on-localhost';

function store(overrides: Partial<ConstructorParameters<typeof SupabaseImageStore>[0]> = {}) {
  return new SupabaseImageStore({
    url: baseUrl,
    serviceRoleKey: SECRET,
    bucket: 'salon-images',
    timeoutMs: 5_000,
    ...overrides,
  });
}

/** The real shape: `storageKeyFor(salonId, checksum, contentType)`. */
/** `seenAll[n]` under `noUncheckedIndexedAccess`, failing loudly on a miss. */
function request(n: number): Seen {
  const seen = seenAll[n];
  if (!seen) throw new Error(`expected at least ${n + 1} request(s), saw ${seenAll.length}`);
  return seen;
}

const KEY = 'SAL-AMARA/6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b.png';
const BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ------------------------------------------------------------------- put --

describe('SupabaseImageStore.put', () => {
  it('POSTs the bytes to the bucket, upserting, with the type it was given', async () => {
    reply = () => ({ status: 200, body: JSON.stringify({ Key: `salon-images/${KEY}` }) });

    await store().put({ key: KEY, bytes: BYTES, contentType: 'image/png' });

    expect(seenAll).toHaveLength(1);
    const seen = request(0);
    expect(seen.method).toBe('POST');
    expect(seen.url).toBe(
      '/storage/v1/object/salon-images/SAL-AMARA/6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b.png',
    );
    expect(seen.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(seen.headers['content-type']).toBe('image/png');
    /**
     * `x-upsert`. images/types.ts: "OVERWRITE-SAFE BY CONTRACT: the same key with
     * the same bytes may be written twice." Without this header storage-api
     * answers 409 Duplicate, and the second write of a deduplicated upload — the
     * ORDINARY case, since the key is the checksum — would fail.
     */
    expect(seen.headers['x-upsert']).toBe('true');
    expect(seen.body.equals(BYTES)).toBe(true);
  });

  it('a duplicate key still succeeds — the upsert path is asserted, not assumed', async () => {
    reply = () => ({ status: 200, body: '{}' });
    await store().put({ key: KEY, bytes: BYTES, contentType: 'image/png' });
    await store().put({ key: KEY, bytes: BYTES, contentType: 'image/png' });
    expect(seenAll).toHaveLength(2);
  });

  it('a refused write is ImageStoreUnavailableError, carrying the status', async () => {
    reply = () => ({
      status: 403,
      body: JSON.stringify({ statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' }),
    });

    await expect(store().put({ key: KEY, bytes: BYTES, contentType: 'image/png' })).rejects.toThrow(
      ImageStoreUnavailableError,
    );
    await expect(store().put({ key: KEY, bytes: BYTES, contentType: 'image/png' })).rejects.toThrow(
      /403/,
    );
  });

  it('never puts the service-role key in the error it throws', async () => {
    reply = () => ({ status: 500, body: 'upstream exploded' });
    const err = await store()
      .put({ key: KEY, bytes: BYTES, contentType: 'image/png' })
      .then(() => null)
      .catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(ImageStoreUnavailableError);
    expect(err?.message).not.toContain(SECRET);
    expect(JSON.stringify(err)).not.toContain(SECRET);
  });

  it('an unreachable host is ImageStoreUnavailableError with the cause attached', async () => {
    /** Port 1 — `vitest.config.ts` uses the same address for the same reason. */
    const dead = new SupabaseImageStore({
      url: 'http://127.0.0.1:1',
      serviceRoleKey: SECRET,
      bucket: 'salon-images',
      timeoutMs: 2_000,
    });
    const err = await dead
      .put({ key: KEY, bytes: BYTES, contentType: 'image/png' })
      .then(() => null)
      .catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(ImageStoreUnavailableError);
    expect((err as Error & { cause?: unknown }).cause).toBeDefined();
  });
});

// ------------------------------------------------------------------- get --

describe('SupabaseImageStore.get', () => {
  it('returns the bytes', async () => {
    reply = () => ({ status: 200, body: BYTES, headers: { 'content-type': 'image/png' } });
    const got = await store().get(KEY);
    expect(got?.bytes.equals(BYTES)).toBe(true);
    expect(request(0).method).toBe('GET');
  });

  it('a bare 404 is absence, not a failure', async () => {
    reply = () => ({ status: 404, body: JSON.stringify({ error: 'not_found', message: 'Object not found' }) });
    await expect(store().get(KEY)).resolves.toBeNull();
  });

  it('a 400 carrying statusCode 404 is absence too — the older storage-api shape', async () => {
    reply = () => ({
      status: 400,
      body: JSON.stringify({ statusCode: '404', error: 'not_found', message: 'Object not found' }),
      headers: { 'content-type': 'application/json' },
    });
    await expect(store().get(KEY)).resolves.toBeNull();
  });

  it('a 400 that is NOT a not-found still throws — absence must not swallow a real fault', async () => {
    reply = () => ({
      status: 400,
      body: JSON.stringify({ statusCode: '400', error: 'InvalidRequest', message: 'bucket name is required' }),
      headers: { 'content-type': 'application/json' },
    });
    await expect(store().get(KEY)).rejects.toThrow(ImageStoreUnavailableError);
  });

  it('a 500 throws', async () => {
    reply = () => ({ status: 500, body: 'nope' });
    await expect(store().get(KEY)).rejects.toThrow(ImageStoreUnavailableError);
  });
});

// ---------------------------------------------------------------- remove --

describe('SupabaseImageStore.remove', () => {
  it('DELETEs the object', async () => {
    reply = () => ({ status: 200, body: JSON.stringify({ message: 'Successfully deleted' }) });
    await store().remove(KEY);
    expect(request(0).method).toBe('DELETE');
    expect(request(0).url).toContain('/storage/v1/object/salon-images/SAL-AMARA/');
  });

  it('a key that is already gone is a SUCCESS — the reaper re-runs over its own half-passes', async () => {
    reply = () => ({ status: 404, body: JSON.stringify({ error: 'not_found' }) });
    await expect(store().remove(KEY)).resolves.toBeUndefined();
  });

  it('a real delete failure throws, so the reaper counts it and retries', async () => {
    reply = () => ({ status: 500, body: 'nope' });
    await expect(store().remove(KEY)).rejects.toThrow(ImageStoreUnavailableError);
  });
});

// ------------------------------------------------------------------ keys --

describe('SupabaseImageStore refuses a key it cannot safely put in a URL', () => {
  /** disk.ts guards the same class of key against the filesystem. A URL path is
   *  the same problem in a different grammar, and the guard belongs next to the
   *  call rather than in the caller's head. */
  for (const bad of ['', '..', 'a/../../b', 'a\0b', '/leading', 'trailing/', 'a//b']) {
    it(`refuses ${JSON.stringify(bad)} without making a request`, async () => {
      await expect(store().put({ key: bad, bytes: BYTES, contentType: 'image/png' })).rejects.toThrow(
        ImageStoreUnavailableError,
      );
      expect(seenAll).toHaveLength(0);
    });
  }

  it('percent-encodes a segment rather than trusting it', async () => {
    reply = () => ({ status: 200, body: '{}' });
    await store().put({ key: 'SAL-A B/c d.png', bytes: BYTES, contentType: 'image/png' });
    expect(request(0).url).toBe('/storage/v1/object/salon-images/SAL-A%20B/c%20d.png');
  });
});

// ------------------------------------------------------------ the CDN seam --

describe('the presigned-URL branch', () => {
  it('is NOT implemented, so GET /v1/images/{id} keeps streaming and keeps its headers', () => {
    /**
     * Deliberate, and the reasoning is in supabase.ts § THE ONE THING THIS SEAM
     * CANNOT EXPRESS. A 302 to storage drops `x-content-type-options: nosniff`,
     * the `default-src 'none'; sandbox` CSP, `cache-control: private` and the
     * stored `content-type` that routes/images.ts sets — every one of which that
     * route documents as load-bearing. Trading them for CDN caching is a decision
     * with a named cost, and it is not this slice's to make silently.
     *
     * Asserted rather than left as prose: `routes/images.ts` calls
     * `imageStore.presignedUrl?.(…)` and redirects on any truthy answer, so a
     * later edit that adds the method turns this spec red and makes whoever added
     * it read the paragraph above.
     */
    const asSeam: ImageStore = store();
    expect(asSeam.presignedUrl).toBeUndefined();
  });
});
