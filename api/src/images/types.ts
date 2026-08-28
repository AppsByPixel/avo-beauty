/**
 * The image-store seam.
 *
 * WHY THIS INTERFACE EXISTS AT ALL
 * --------------------------------
 * Exactly the reason gateway/types.ts exists, with a different open question
 * behind it. CLAUDE.md § Escalate lists "Data residency (leaning Kuwait,
 * undecided) and the retention schedule" as the client's, and it is the decision
 * that picks the bucket. So nothing above this file knows a provider's name, its
 * SDK, its URL grammar or its error vocabulary. Swapping the local store for the
 * real one is `IMAGE_DRIVER=…` and one new file in this directory.
 *
 * The interface is four methods because those four are all the flow needs:
 *
 *   put            take these bytes, keep them        (POST .../image)
 *   get            give them back                     (GET /v1/images/{id})
 *   remove         they are unreferenced, drop them   (the reaper)
 *   presignedUrl   optional; see below
 *
 * `presignedUrl` IS THE PLUG FOR EVERY OBJECT STORE, and it is optional because
 * a local disk has no such concept. A driver that returns a URL makes
 * `GET /v1/images/{id}` authorise the read and then 302 to it, so the bytes
 * never pass through Node and a CDN can cache them — which is how S3, GCS, R2
 * and Azure Blob all want to be used. A driver that returns undefined has its
 * bytes streamed by the API. The ROUTE IS THE SAME EITHER WAY: the authority
 * check happens before the branch, so a presigning driver does not quietly turn
 * a tenant-scoped read into a public one.
 *
 * WHAT A DRIVER MUST NOT DO
 * -------------------------
 * It must not interpret the bytes. Validation happened at the boundary
 * (images/inspect.ts) and re-deciding here would be a second opinion that can
 * disagree with the row already written. A driver is a key-value store for
 * opaque octets that happens to be told a content type so it can label the
 * object for whatever serves it.
 *
 * It must not invent keys. `storage_key` is minted once, written to the `image`
 * row inside the same transaction as everything else, and handed to the driver.
 * A driver that returned its own key would make the database's copy a guess.
 */

/**
 * The store's own address for one blob. Opaque above this directory: nothing
 * outside parses it, and its shape is a driver's business.
 */
export type StorageKey = string;

export interface PutInput {
  key: StorageKey;
  bytes: Buffer;
  /** From images/inspect.ts, never from the request header. */
  contentType: string;
}

export interface StoredBytes {
  bytes: Buffer;
  contentType: string;
}

export interface ImageStore {
  /** A name for logs and for the boot line. Not a decision input. */
  readonly name: string;

  /**
   * Write, and OVERWRITE-SAFE BY CONTRACT: the same key with the same bytes may
   * be written twice. Uploads are deduplicated by checksum inside one salon, so
   * a retried request lands on the key it already wrote.
   */
  put(input: PutInput): Promise<void>;

  /** Read. `null` when the key is not there — never a throw for absence. */
  get(key: StorageKey): Promise<StoredBytes | null>;

  /**
   * Delete. Idempotent: removing a key that is already gone is a success, because
   * the reaper's second pass over a partially completed first pass must not fail.
   */
  remove(key: StorageKey): Promise<void>;

  /**
   * A short-lived URL the caller may be redirected to, or undefined when the
   * driver has no such thing. See the header.
   */
  presignedUrl?(key: StorageKey): Promise<string | undefined>;
}

/**
 * The store is not available for WRITES in this deployment.
 *
 * Distinct from a bug and from a refusal: nothing is broken and the merchant did
 * nothing wrong — the deployment has not been told where bytes are allowed to
 * live. Carried as its own class so routes/images.ts can turn it into the 503
 * that http/errors.ts § serviceUnavailable was written for.
 */
export class ImageStoreNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageStoreNotConfiguredError';
  }
}

/** The store was reachable and failed anyway. A 502-shaped fact. */
export class ImageStoreUnavailableError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = 'ImageStoreUnavailableError';
  }
}
