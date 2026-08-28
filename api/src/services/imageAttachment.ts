/**
 * Attaching, detaching and serialising an image. The tenancy and lifecycle core
 * of the capability; routes/images.ts is the HTTP shell around it.
 *
 * ============================================================================
 * THE FIVE RULES, EACH ONE HAVING A REASON THAT IS NOT "IT IS TIDIER"
 * ============================================================================
 *
 * 1. THE OWNER IS RESOLVED INSIDE THE SALON SCOPE, IN THE `WHERE`.
 *    `routes/salons.ts` § PATCH products already argues this: "Scoped to her own
 *    salon IN THE WHERE, not checked after the read: another salon's product id
 *    must not be editable, and it must not be CONFIRMABLE TO EXIST either." An
 *    image endpoint is the same shape with a worse payload — a 404-vs-403
 *    difference on a product id is an enumeration oracle over another tenant's
 *    catalog, and the thing being attached is a file the merchant chose.
 *
 * 2. THE WHOLE ATTACH IS ONE TRANSACTION, and the bytes are written BEFORE it.
 *    Order matters and both orders lose something:
 *      bytes first, row second  -> a crash leaves an orphan blob. Costs storage.
 *      row first, bytes second  -> a crash leaves a row pointing at nothing.
 *                                  Costs a broken image on a customer's screen
 *                                  and a checksum that can never be verified.
 *    The first failure is money; the second is a lie in the database. So: bytes
 *    first, and the reaper (services/imageReaper.ts) is what makes the orphan
 *    temporary. That is the same trade `receipt_job` makes — queue the durable
 *    fact, let a worker reconcile — and the same reason it is a QUEUE and not an
 *    HTTP call inside the money transaction.
 *
 * 3. BYTES ARE DEDUPLICATED BY CHECKSUM WITHIN ONE SALON, NEVER ACROSS.
 *    db/schema/image.ts carries the argument. The consequence here is that
 *    `attachImage` may return an EXISTING image id, and that a re-upload of the
 *    same file is idempotent by content without needing an Idempotency-Key.
 *    (It is not a money-moving POST, so non-negotiable #4 does not apply — but
 *    getting the same id back for the same bytes is the property that header
 *    would have bought, at no cost.)
 *
 * 4. REPLACEMENT NEVER MUTATES BYTES. The old attachment is deleted, the new one
 *    inserted, and the old image is marked `detached_at` IF AND ONLY IF nothing
 *    else still points at it. Same transaction, so a shop tile is never briefly
 *    pictureless and never briefly double-attached — the partial unique index
 *    `image_attachment_one_primary_key` would refuse the second insert anyway,
 *    which is the point of having it.
 *
 * 5. DETACH DOES NOT DELETE. `detached_at` is a mark, the reaper is the delete,
 *    and `IMAGE_DETACHED_GRACE_HOURS` is the undo window. An inline delete would
 *    put a filesystem or network call inside the request that a merchant is
 *    waiting on, and would make a mis-click unrecoverable.
 */

import { createHash, randomBytes } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { image, imageAttachment } from '../db/schema/image';
import { product } from '../db/schema/product';
import { service } from '../db/schema/service';
import { env } from '../env';
import { imageStore } from '../images';
import type { AcceptedImageType } from '../images/inspect';
import { conflict, notFound } from '../http/errors';

/** The owner kinds this slice registers. Mirrors the CHECK in migration 0041. */
export type ImageOwnerType = 'product' | 'service';

/**
 * What a client gets. The proposed `ImageRef` in `packages/types` — see the
 * report; trunk owns that file and this shape is the request.
 */
export interface ImageRef {
  id: string;
  /**
   * ABSOLUTE, from `PUBLIC_BASE_URL`. The wallet runs on a phone and cannot
   * resolve a path against an origin it was never told; gateway/sandbox.ts makes
   * the identical argument for its hosted page. The dashboard shares an origin
   * and does not care either way.
   */
  url: string;
  contentType: AcceptedImageType;
  width: number;
  height: number;
  byteSize: number;
}

/** Row shape the serialiser needs. Kept narrow so callers select only these. */
export interface ImageRow {
  id: string;
  contentType: string;
  width: number;
  height: number;
  byteSize: number;
}

export function imageUrl(id: string): string {
  return `${env.publicBaseUrl}/v1/images/${id}`;
}

export function serialiseImage(row: ImageRow | null | undefined): ImageRef | null {
  if (!row) return null;
  return {
    id: row.id,
    url: imageUrl(row.id),
    contentType: row.contentType as AcceptedImageType,
    width: row.width,
    height: row.height,
    byteSize: row.byteSize,
  };
}

/**
 * `IM-` plus ten base32-ish characters from a CSPRNG.
 *
 * NOT `Math.random().toString(36)`, which is what `routes/salons.ts` mints a
 * product id with. That is defensible for a product id — it is only ever seen by
 * someone who already holds the catalog — and it is not defensible here. An image
 * id is the ONLY thing in `GET /v1/images/{id}`'s path, so it is the identifier
 * an attacker would iterate; guessability should not be the reason the tenancy
 * check never gets tested. 50 bits of CSPRNG, and the tenancy check is still
 * there and still the control.
 */
export function mintImageId(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const raw = randomBytes(10);
  let out = '';
  for (let i = 0; i < 10; i += 1) out += alphabet[(raw[i] as number) % alphabet.length];
  return `IM-${out}`;
}

export function mintAttachmentId(): string {
  return `IA-${randomBytes(8).toString('hex').toUpperCase()}`;
}

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The storage key, and it is CONTENT-ADDRESSED rather than id-addressed.
 *
 * `<salonId>/<sha256>.<ext>` — salon first, so a bucket listing is legible and a
 * per-tenant lifecycle rule (retention, CLAUDE.md § Escalate) is expressible as a
 * prefix. Never parsed above images/; the extension is for a human and for
 * whatever serves the object directly.
 *
 * IT WAS `<salonId>/<imageId>.<ext>` AND THAT WAS A RACE. Two uploads of the same
 * file into the same salon at the same instant — a merchant double-clicking Save —
 * both find no existing row, both mint a DIFFERENT id, both write bytes under
 * their own key, and then the second `INSERT` hits `image_salon_checksum_key` and
 * loses. The loser's object is then referenced by nothing: a stranded blob the
 * reaper cannot collect, because the reaper scans `image` and there is no row.
 *
 * Deriving the key from the bytes closes it completely. Both racers compute the
 * SAME key, both write the SAME bytes to it — which `images/types.ts` § put
 * declares safe on purpose — and whichever row wins names the object that is
 * already there. Nothing is stranded, and a retried upload after a timeout lands
 * on the object it already wrote instead of making a second copy.
 *
 * The salon prefix is what keeps this from becoming cross-tenant deduplication by
 * accident: two salons holding the same stock photo compute the same digest and
 * still get two keys, two objects and two rows. db/schema/image.ts § DEDUPE says
 * why that separation is worth the duplicated bytes.
 */
const EXTENSION: Record<AcceptedImageType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

export function storageKeyFor(
  salonId: string,
  checksumSha256: string,
  contentType: AcceptedImageType,
): string {
  return `${salonId}/${checksumSha256}.${EXTENSION[contentType]}`;
}

/**
 * The owner row, read inside the salon scope, or a 404 that says nothing about
 * whether it exists elsewhere.
 *
 * `active` IS IN THE PREDICATE for both kinds, and for the reason `routes/salons.ts`
 * gives on the product PATCH: "a retired product is not repriced back into the
 * catalog by a PATCH". A retired product cannot be sold and a retired service
 * cannot be charged, so neither can be dressed up with a new photo — and an image
 * attached to something the catalog no longer lists is a byte nobody will ever
 * see and the reaper will never collect, because it is attached.
 */
export async function requireOwnerInSalon(
  db: Db,
  ownerType: ImageOwnerType,
  ownerId: string,
  salonId: string,
): Promise<{ id: string; name: string }> {
  if (ownerType === 'product') {
    const [row] = await db
      .select({ id: product.id, name: product.name })
      .from(product)
      .where(and(eq(product.id, ownerId), eq(product.salonId, salonId), eq(product.active, true)))
      .limit(1);
    if (!row) throw notFound('unknown_product', 'No such product.');
    return row;
  }
  const [row] = await db
    .select({ id: service.id, name: service.name })
    .from(service)
    .where(and(eq(service.id, ownerId), eq(service.salonId, salonId), eq(service.active, true)))
    .limit(1);
  if (!row) throw notFound('unknown_service', 'No such service.');
  return row;
}

export interface AttachInput {
  salonId: string;
  ownerType: ImageOwnerType;
  ownerId: string;
  bytes: Buffer;
  contentType: AcceptedImageType;
  width: number;
  height: number;
  uploadedByKind: string;
  uploadedById: string;
}

export interface AttachResult {
  ref: ImageRef;
  /** True when this upload took a slot that was empty; false when it replaced. */
  created: boolean;
  /** The image that was displaced, if any. For the audit line. */
  replacedImageId: string | null;
  /** True when the bytes were already held for this salon. For the audit line. */
  deduplicated: boolean;
}

export async function attachImage(db: Db, input: AttachInput): Promise<AttachResult> {
  const checksum = sha256Hex(input.bytes);
  const storageKey = storageKeyFor(input.salonId, checksum, input.contentType);
  const mintedId = mintImageId();

  /**
   * RULE 2, THE WRITE ORDER: bytes first, row second. The key is derived from the
   * bytes (see `storageKeyFor`), so this is idempotent in every direction — a
   * retry, a duplicate upload and a concurrent racer all write the same octets to
   * the same key, and none of them can leave an object no row names.
   */
  await imageStore.put({ key: storageKey, bytes: input.bytes, contentType: input.contentType });

  return db.transaction(async (tx) => {
    /**
     * INSERT-OR-IGNORE, THEN READ THE WINNER. Not select-then-insert.
     *
     * A pre-read decides on a snapshot and acts on it, which is the exact shape
     * `markDetachedIfUnreferenced` refuses lower down and the shape
     * services/socialLinks.ts needs `FOR UPDATE` to survive. Here the database
     * already holds the invariant — `image_salon_checksum_key` — so the cheaper
     * and stronger move is to let the unique index arbitrate and then ask who won.
     * Two racers with the same bytes both end up on one row instead of one of them
     * getting a 500 from a constraint the caller cannot see.
     */
    await tx
      .insert(image)
      .values({
        id: mintedId,
        salonId: input.salonId,
        storageKey,
        driver: imageStore.name,
        contentType: input.contentType,
        byteSize: input.bytes.byteLength,
        width: input.width,
        height: input.height,
        checksumSha256: checksum,
        uploadedByKind: input.uploadedByKind,
        uploadedById: input.uploadedById,
      })
      .onConflictDoNothing({ target: [image.salonId, image.checksumSha256] });

    const [row] = await tx
      .select({
        id: image.id,
        contentType: image.contentType,
        width: image.width,
        height: image.height,
        byteSize: image.byteSize,
        detachedAt: image.detachedAt,
      })
      .from(image)
      .where(and(eq(image.salonId, input.salonId), eq(image.checksumSha256, checksum)))
      .limit(1);
    if (!row) throw conflict('image_not_saved', 'That image could not be saved. Try again.');

    const imageId = row.id;
    const deduplicated = imageId !== mintedId;

    /**
     * A DEDUPE HIT ON A DETACHED ROW RESURRECTS IT, and this is the case that
     * would otherwise be a silent data loss: a merchant removes a photo, the
     * reaper has not run, she re-uploads the same file. Without this clear, the
     * row stays marked and the reaper deletes the bytes out from under a LIVE
     * attachment some hours later. Every read after that is a 404 and nothing in
     * any log says why.
     */
    if (row.detachedAt) {
      await tx.update(image).set({ detachedAt: null }).where(eq(image.id, imageId));
    }

    /**
     * RULE 4. Take the slot: remove whatever held it, then insert. `returning`
     * tells us what was displaced so it can be marked and audited — a plain
     * DELETE would leave the caller unable to say what changed.
     */
    const displaced = await tx
      .delete(imageAttachment)
      .where(
        and(
          eq(imageAttachment.ownerType, input.ownerType),
          eq(imageAttachment.ownerId, input.ownerId),
          eq(imageAttachment.role, 'primary'),
          eq(imageAttachment.salonId, input.salonId),
        ),
      )
      .returning({ imageId: imageAttachment.imageId });

    await tx.insert(imageAttachment).values({
      id: mintAttachmentId(),
      imageId,
      salonId: input.salonId,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      role: 'primary',
      position: 0,
    });

    const replacedImageId = displaced[0]?.imageId ?? null;
    if (replacedImageId && replacedImageId !== imageId) {
      await markDetachedIfUnreferenced(tx, replacedImageId);
    }

    return {
      ref: serialiseImage(row) as ImageRef,
      created: replacedImageId === null,
      replacedImageId: replacedImageId && replacedImageId !== imageId ? replacedImageId : null,
      deduplicated,
    };
  });
}

/** Anything with `.update()` — the pool, or an open transaction. Audit's shape. */
type Executor = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Mark an image detached IF nothing points at it any more.
 *
 * The condition is a CORRELATED SUBQUERY IN THE UPDATE rather than a count read
 * and then a write. Two managers detaching two products that share one
 * deduplicated image would both read "one attachment left" and neither would
 * mark it — a leaked blob, and one that no later pass would ever notice because
 * nothing would be marked. Deciding inside the statement makes the read and the
 * write one operation, which is the same argument `SELECT … FOR UPDATE` carries
 * in services/socialLinks.ts, reached without a lock because there is nothing to
 * read back.
 */
export async function markDetachedIfUnreferenced(exec: Executor, imageId: string): Promise<void> {
  await exec
    .update(image)
    .set({ detachedAt: new Date() })
    .where(
      and(
        eq(image.id, imageId),
        isNull(image.detachedAt),
        sql`NOT EXISTS (SELECT 1 FROM image_attachment ia WHERE ia.image_id = ${imageId})`,
      ),
    );
}

export interface DetachResult {
  imageId: string;
}

/**
 * Remove the primary image from an owner. 404 when there was none — a true
 * statement, and the same reasoning `DELETE .../products/{pid}` records: "a
 * second DELETE finds no active row and answers 404… rather than a 204 implying
 * it removed something."
 */
export async function detachImage(
  db: Db,
  salonId: string,
  ownerType: ImageOwnerType,
  ownerId: string,
): Promise<DetachResult> {
  return db.transaction(async (tx) => {
    const removed = await tx
      .delete(imageAttachment)
      .where(
        and(
          eq(imageAttachment.salonId, salonId),
          eq(imageAttachment.ownerType, ownerType),
          eq(imageAttachment.ownerId, ownerId),
          eq(imageAttachment.role, 'primary'),
        ),
      )
      .returning({ imageId: imageAttachment.imageId });

    const removedId = removed[0]?.imageId;
    if (!removedId) throw notFound('no_image', 'There is no image on that yet.');

    await markDetachedIfUnreferenced(tx, removedId);
    return { imageId: removedId };
  });
}

/**
 * The primary image of many owners at once, for a list route.
 *
 * ONE QUERY FOR THE WHOLE PAGE, not one per row: `GET /salons/{id}/products`
 * returns the catalog, and a per-row lookup would make a shop with forty
 * products forty-one round trips. Keyed by owner id, and SCOPED BY SALON in the
 * predicate even though the ids came from rows already scoped by salon — the
 * second check costs nothing and means a future caller that passes ids from
 * somewhere else cannot turn this into a cross-tenant read.
 */
export async function primaryImagesFor(
  db: Db,
  salonId: string,
  ownerType: ImageOwnerType,
  ownerIds: readonly string[],
): Promise<Map<string, ImageRef>> {
  const out = new Map<string, ImageRef>();
  if (ownerIds.length === 0) return out;

  const rows = await db
    .select({
      ownerId: imageAttachment.ownerId,
      id: image.id,
      contentType: image.contentType,
      width: image.width,
      height: image.height,
      byteSize: image.byteSize,
    })
    .from(imageAttachment)
    .innerJoin(image, eq(image.id, imageAttachment.imageId))
    .where(
      and(
        eq(imageAttachment.salonId, salonId),
        eq(imageAttachment.ownerType, ownerType),
        eq(imageAttachment.role, 'primary'),
        inArray(imageAttachment.ownerId, [...ownerIds]),
      ),
    );

  for (const r of rows) {
    const ref = serialiseImage(r);
    if (ref) out.set(r.ownerId, ref);
  }
  return out;
}
