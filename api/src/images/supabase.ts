/**
 * A durable image store: Supabase Storage. `IMAGE_DRIVER=supabase`.
 *
 * ============================================================================
 * WHAT THIS DOES AND DOES NOT SETTLE — READ THIS BEFORE THE CODE
 * ============================================================================
 * `disk.ts` refuses to write in production because a local directory cannot KEEP
 * what it was given, and it names the reason: a durable store "needs the data
 * residency decision" that CLAUDE.md § Escalate, don't guess still lists as the
 * client's and still lists as UNDECIDED ("leaning Kuwait, undecided").
 *
 * THAT DECISION IS NOT MADE BY THIS FILE, AND THIS FILE MUST NOT BE READ AS
 * HAVING MADE IT. What exists here is a driver that is SELECTED BY AN
 * ENVIRONMENT VARIABLE and is selected in exactly one place today: the deployed
 * demo, whose Supabase project (`avo-demo`) lives in **eu-central-1** — Germany.
 * That region is not a proposal for where a Kuwaiti salon's customer photographs
 * should live; it is the region a demo project happens to sit in, and it is
 * precisely the fact that makes this a DEMO-ONLY CONFIGURATION. Pointing this
 * driver at a production bucket is a separate act that requires the residency
 * answer first, and nothing here shortens that conversation.
 *
 * `disk` remains the default (`env.ts`), and its production write refusal is
 * untouched: a deployment that configures neither driver still fails loudly
 * rather than losing bytes quietly.
 *
 * ============================================================================
 * NO SDK. THE REST API, OVER THE `fetch` THAT IS ALREADY IN THE RUNTIME.
 * ============================================================================
 * `@supabase/supabase-js` would mean a new entry in `pnpm-lock.yaml` AT THE
 * REPOSITORY ROOT, which is outside `api/` — this lane's whole column
 * (CLAUDE.md § Lanes). `routes/images.ts` already refused multipart for exactly
 * that reason, and the same answer applies for the same reason: "a slice that
 * cannot be built inside its column is a slice that should be reported."
 *
 * It did not need reporting, because Storage's REST surface is three verbs on
 * one URL grammar and the SDK is a thin wrapper over them:
 *
 *   POST   /storage/v1/object/{bucket}/{key}   upload (with `x-upsert: true`)
 *   GET    /storage/v1/object/{bucket}/{key}   download
 *   DELETE /storage/v1/object/{bucket}/{key}   delete
 *
 * The cost of not taking the SDK is that its retry, its resumable upload and its
 * typed error union are not here. None is needed: uploads are bounded at
 * `IMAGE_MAX_BYTES` (2 MiB), a retry belongs to the caller that holds the
 * idempotency, and the error union this seam wants is two classes wide.
 *
 * ============================================================================
 * THE SHAPES BELOW WERE NOT VERIFIED AGAINST A LIVE PROJECT, AND THAT IS SAID
 * RATHER THAN HIDDEN
 * ============================================================================
 * `gateway/myfatoorah.ts` could say "verified against the live test environment
 * rather than read off a summary" because a public sandbox key exists for it.
 * There is no such thing here: reaching a Supabase project needs a service-role
 * key, and a service-role key must not exist in this tree in any form — not in
 * a fixture, not in a comment, not in `.env.example` (which is committed).
 *
 * So the driver is written to accept BOTH shapes storage-api has used for a
 * missing object across versions: a bare `404`, and a `400` whose JSON body
 * carries `"statusCode": "404"`. `supabase.test.ts` asserts both, and asserts
 * that a 400 which is NOT a not-found still throws — because collapsing every
 * 400 into "absent" would turn a misconfigured bucket into an endless stream of
 * 404s that look like an empty catalogue.
 *
 * ============================================================================
 * THE ONE THING THIS SEAM CANNOT EXPRESS: `presignedUrl` WITHOUT LOSING HEADERS
 * ============================================================================
 * `ImageStore.presignedUrl` is the seam's CDN plug, and Supabase has the
 * matching call (`POST /storage/v1/object/sign/{bucket}/{key}`). IT IS
 * DELIBERATELY NOT IMPLEMENTED, and the reason is a property of the seam rather
 * than of Supabase.
 *
 * `routes/images.ts` sets five response headers on the streaming branch and
 * documents four of them as load-bearing: `x-content-type-options: nosniff`
 * ("the single most important header here"), `content-security-policy:
 * default-src 'none'; sandbox` ("defence in depth"), `cache-control: … private`
 * ("the response is tenant-scoped and a shared cache must not hold it"), and the
 * stored `content-type` from the ROW rather than from the uploader. A `302` to
 * storage carries NONE of them: the object is then served by Supabase under
 * Supabase's headers, and the row's content type — the one the API decided was
 * true — stops being what the browser is told.
 *
 * The seam can express "redirect there". It cannot express "redirect there AND
 * keep these guarantees", because once the bytes leave this process the headers
 * are the object store's to set. Closing that gap is a real decision with a
 * named cost (the bytes stream through the function, so a Vercel invocation
 * carries up to 2 MiB per image, per request, uncached by any CDN), and it is
 * not one to make silently inside a driver. REPORTED, not smuggled in. Until it
 * is decided, `GET /v1/images/{id}` streams, exactly as it does under `disk`.
 *
 * ============================================================================
 * THE BUCKET MUST BE PRIVATE, AND NOTHING HERE CAN MAKE IT SO
 * ============================================================================
 * Every read in this product is tenant-scoped: `GET /v1/images/{id}` resolves the
 * row inside the caller's salon and 404s otherwise. A PUBLIC bucket would make
 * that check decorative — the object would be fetchable by URL with no principal
 * at all, and the storage key is a salon id and a checksum, which is unguessable
 * but is not a permission. This driver authenticates every call with the
 * service-role key, which reads a private bucket happily, so a private bucket is
 * the configuration this code assumes and `api/.env.example` says so. It is NOT
 * asserted at boot: that would be a network call in the boot path, which would
 * make the API's ability to start depend on a product-photo capability — the
 * exact trade `disk.ts` § WHY A WRITE REFUSAL AND NOT A BOOT REFUSAL rejects.
 */

import type { ImageStore, PutInput, StorageKey, StoredBytes } from './types';
import { ImageStoreUnavailableError } from './types';

export interface SupabaseImageStoreConfig {
  /** The project origin, e.g. `https://<ref>.supabase.co`. No trailing path. */
  url: string;
  /**
   * The service-role key. Held in memory only, sent only as a bearer token, and
   * never placed in an error message or a log line — see `failure()`.
   */
  serviceRoleKey: string;
  bucket: string;
  timeoutMs: number;
}

/**
 * A key is a URL path fragment, so it is a path traversal in a second grammar.
 *
 * `disk.ts` makes the same argument about the filesystem and reaches the same
 * conclusion: keys are minted by `services/imageAttachment.ts` from an id this
 * API generated and a salon id it read out of a principal, so nothing
 * user-supplied reaches here TODAY — and that is an argument about the current
 * callers, and callers change. A key with an empty segment, a dot segment, a NUL
 * or a leading/trailing slash is refused outright rather than normalised,
 * because normalising means guessing what the caller meant.
 */
function segmentsFor(key: StorageKey): string[] {
  if (key === '' || key.includes('\0') || key.includes('..')) {
    throw new ImageStoreUnavailableError('Refusing a storage key with a path segment in it.');
  }
  const segments = key.split('/');
  if (segments.some((s) => s === '')) {
    throw new ImageStoreUnavailableError('Refusing a storage key with an empty path segment.');
  }
  return segments;
}

/** storage-api's error envelope, as far as anything here reads it. */
interface StorageError {
  statusCode?: string;
  error?: string;
  message?: string;
}

function parseError(text: string): StorageError | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as StorageError) : null;
  } catch {
    return null;
  }
}

/**
 * Did storage-api mean "there is no such object"?
 *
 * `404` on its own is the modern answer. The `400` + `"statusCode": "404"` form
 * is what older storage-api returned, and it is accepted because a driver that
 * threw on it would make every read of a reaped image a 502 instead of a 404.
 * A 400 that says anything else is NOT absence and must keep throwing.
 */
function isAbsent(status: number, text: string): boolean {
  if (status === 404) return true;
  if (status !== 400) return false;
  const body = parseError(text);
  return body?.statusCode === '404' || body?.error === 'not_found';
}

export class SupabaseImageStore implements ImageStore {
  readonly name = 'supabase';

  constructor(private readonly config: SupabaseImageStoreConfig) {}

  private urlFor(key: StorageKey): string {
    const path = segmentsFor(key).map(encodeURIComponent).join('/');
    const base = this.config.url.replace(/\/+$/, '');
    return `${base}/storage/v1/object/${encodeURIComponent(this.config.bucket)}/${path}`;
  }

  /**
   * One error constructor, so there is one place that decides what an error is
   * allowed to contain. THE BODY IS TRUNCATED and the key is never interpolated
   * from anywhere but the caller's own argument: `gateway/myfatoorah.ts` learned
   * the same lesson as "the whole thing in a log line is how an API key ends up
   * in a log line". The service-role key is never a member of any string built
   * here, and `supabase.test.ts` asserts that for a 500 body.
   */
  private failure(what: string, status: number, text: string): ImageStoreUnavailableError {
    return new ImageStoreUnavailableError(
      `supabase storage: ${what} answered ${status} — ${text.slice(0, 300)}`,
    );
  }

  private async call(
    method: 'POST' | 'GET' | 'DELETE',
    key: StorageKey,
    init: { body?: Buffer; contentType?: string } = {},
  ): Promise<Response> {
    const url = this.urlFor(key);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.serviceRoleKey}`,
    };
    if (init.contentType) headers['Content-Type'] = init.contentType;
    /**
     * `x-upsert`. images/types.ts makes overwrite-safety part of the contract —
     * "the same key with the same bytes may be written twice" — and it is the
     * ORDINARY case here, not the edge one, because the key IS the checksum: a
     * deduplicated upload, a retry and the reaper's `reattached` race all land on
     * a key that already holds exactly these octets. Without this header
     * storage-api answers 409 Duplicate and every one of those becomes a 502.
     */
    if (method === 'POST') headers['x-upsert'] = 'true';

    const request: RequestInit = {
      method,
      headers,
      /** Without an abort the socket stays open behind a timed-out caller. */
      signal: AbortSignal.timeout(this.config.timeoutMs),
    };
    /**
     * Assigned only when there IS one. `exactOptionalPropertyTypes` is on in this
     * package's tsconfig, so `body: undefined` is not the same as no body.
     */
    if (init.body) request.body = new Uint8Array(init.body);

    try {
      return await fetch(url, request);
    } catch (cause) {
      throw new ImageStoreUnavailableError(
        `supabase storage: ${method} could not be reached`,
        { cause },
      );
    }
  }

  async put(input: PutInput): Promise<void> {
    const res = await this.call('POST', input.key, {
      body: input.bytes,
      /**
       * From `images/inspect.ts` via the caller, never from the request header —
       * images/types.ts § WHAT A DRIVER MUST NOT DO. It is sent so the object is
       * LABELLED correctly in the bucket for whatever serves it; it is not what
       * `GET /v1/images/{id}` answers with, which comes from the row.
       */
      contentType: input.contentType,
    });
    if (!res.ok) throw this.failure('upload', res.status, await res.text());
  }

  async get(key: StorageKey): Promise<StoredBytes | null> {
    const res = await this.call('GET', key);
    if (!res.ok) {
      const text = await res.text();
      if (isAbsent(res.status, text)) return null;
      throw this.failure('download', res.status, text);
    }
    return {
      bytes: Buffer.from(await res.arrayBuffer()),
      /**
       * INFORMATIONAL. `routes/images.ts` answers with `row.contentType` and
       * never reads this field — the row is the API's own decision about what the
       * bytes are, and the store's label is a copy of it that can drift if the
       * bucket is ever touched by anything else. Reported honestly rather than
       * blanked (as `disk.ts` must, having nowhere to keep one), so that a drift
       * is visible to anything that ever does compare them.
       */
      contentType: res.headers.get('content-type') ?? '',
    };
  }

  async remove(key: StorageKey): Promise<void> {
    const res = await this.call('DELETE', key);
    if (res.ok) return;
    const text = await res.text();
    /**
     * Idempotent by contract (images/types.ts): "removing a key that is already
     * gone is a success, because the reaper's second pass over a partially
     * completed first pass must not fail."
     */
    if (isAbsent(res.status, text)) return;
    throw this.failure('delete', res.status, text);
  }

  /** `presignedUrl` is deliberately absent. See the header. */
}
