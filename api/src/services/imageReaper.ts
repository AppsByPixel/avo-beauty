/**
 * The orphaned-blob story, written down instead of left to grow.
 *
 * ============================================================================
 * WHY THERE IS AN ORPHAN AT ALL
 * ============================================================================
 * services/imageAttachment.ts § RULE 2 writes the BYTES BEFORE THE ROW, because
 * of the two possible crash windows only one is survivable: a row pointing at
 * bytes that are not there is a lie in the database and a broken tile on a
 * customer's screen, while bytes with no row are storage nobody is paying
 * attention to. That choice is only defensible if something collects the second
 * one, and this file is that something.
 *
 * Three ways an image stops being needed, and all three end in the same state:
 *
 *   REPLACED   the merchant uploads a new photo over an old one
 *   DETACHED   she removes the photo (`DELETE .../image`)
 *   STRANDED   `imageStore.put` succeeded and the transaction after it did not
 *
 * The first two mark `image.detached_at`. The third leaves no row at all, and it
 * is NOT collected here — see § WHAT THIS DOES NOT COLLECT.
 *
 * ============================================================================
 * WHY A GRACE WINDOW AND NOT AN INLINE DELETE
 * ============================================================================
 * Deleting inline, inside the request, buys nothing and costs three things:
 * a filesystem or S3 round trip added to a request a merchant is waiting on; a
 * failure mode where the delete fails after the transaction committed and
 * nothing remembers to retry; and an unrecoverable mis-click. Twenty-four hours
 * (`IMAGE_DETACHED_GRACE_HOURS`) is the difference between an undo and a
 * re-shoot, and it is also what makes this job safe to run twice: an image
 * detached and re-attached inside the window is cleared back to NULL by
 * `attachImage` and this pass never sees it.
 *
 * ============================================================================
 * THE ORDER OF THE TWO DELETES, WHICH IS THE ONE THING THAT MATTERS HERE
 * ============================================================================
 * BYTES FIRST, ROW SECOND — the mirror of the write path, for the mirror of the
 * reason. Crash between them and the state is "a row whose bytes are gone",
 * which sounds worse than the alternative and is not, because the row is
 * `detached_at`-marked and unreferenced: nothing serves it, nothing can attach
 * it, and the next pass removes it. The other order leaves an unreferenced blob
 * with no row naming it — genuinely unrecoverable garbage, because the only
 * record of its storage key has just been deleted.
 *
 * THE ATTACHMENT CHECK IS RE-STATED IN THE `DELETE`'s OWN `WHERE`. It was
 * already true when `detached_at` was set. It is checked again because "already
 * true" is a statement about a moment, and between the moment and this pass a
 * dedupe hit could have re-attached the row. `attachImage` clears the mark in
 * that case, so this is the second of two independent guards on the same fact —
 * and the `ON DELETE RESTRICT` on `image_attachment.image_id` is the third, in
 * the database, which is the one that cannot be forgotten.
 */

import { and, eq, isNotNull, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { image } from '../db/schema/image';
import { env } from '../env';
import { imageStore } from '../images';

export interface ImageReapResult {
  /** Rows that were eligible when the pass started. */
  candidates: number;
  /** Rows whose bytes and row are both gone now. */
  reaped: number;
  /**
   * Rows skipped because something re-attached them between the scan and the
   * delete. Not an error — it is the race the conditional WHERE exists for.
   */
  reattached: number;
  /** Rows whose bytes the store refused to remove. Retried next pass. */
  storeFailures: number;
  reapedIds: string[];
}

/**
 * One pass. Bounded, because an unbounded pass on a store having a bad day is a
 * job that never finishes and holds a connection while it does not.
 */
export async function runImageReapOnce(db: Db, batchSize = 200): Promise<ImageReapResult> {
  const cutoff = new Date(Date.now() - env.imageDetachedGraceHours * 3_600_000);

  const candidates = await db
    .select({ id: image.id, storageKey: image.storageKey })
    .from(image)
    .where(and(isNotNull(image.detachedAt), lt(image.detachedAt, cutoff)))
    .orderBy(image.detachedAt)
    .limit(batchSize);

  const result: ImageReapResult = {
    candidates: candidates.length,
    reaped: 0,
    reattached: 0,
    storeFailures: 0,
    reapedIds: [],
  };

  for (const row of candidates) {
    try {
      // BYTES FIRST. `remove` is idempotent by contract (images/types.ts), so a
      // key already gone from a half-finished earlier pass is a success.
      await imageStore.remove(row.storageKey);
    } catch {
      // Left marked, left whole, retried next pass. NOT rethrown: one unreadable
      // key must not stop the other 199.
      result.storeFailures += 1;
      continue;
    }

    const deleted = await db
      .delete(image)
      .where(
        and(
          eq(image.id, row.id),
          isNotNull(image.detachedAt),
          sql`NOT EXISTS (SELECT 1 FROM image_attachment ia WHERE ia.image_id = ${row.id})`,
        ),
      )
      .returning({ id: image.id });

    if (deleted.length > 0) {
      result.reaped += 1;
      result.reapedIds.push(row.id);
    } else {
      /**
       * Re-attached between the scan and here. The bytes were already removed —
       * which is the cost of doing bytes first, and it is bounded: `attachImage`
       * re-`put`s the bytes on a dedupe hit BEFORE it clears the mark, so the
       * winner of this race has already rewritten the object it needs.
       */
      result.reattached += 1;
    }
  }

  return result;
}

/**
 * ============================================================================
 * WHAT THIS DOES NOT COLLECT, SAID OUT LOUD
 * ============================================================================
 * STRANDED BYTES WITH NO ROW. `imageStore.put` succeeds, the transaction after
 * it fails, and the object sits under a key nothing in the database names. This
 * pass cannot find it — it scans `image`, and there is no row.
 *
 * It is not collected because collecting it means LISTING THE STORE and
 * diffing against the table, which needs a `list()` on `ImageStore` that only a
 * real object store can implement cheaply and which would be a fifth method on
 * a seam whose whole value is being four. It is bounded in practice: the window
 * is one failed transaction wide, and the key is deterministic — a retry of the
 * same upload lands on the SAME key (dedupe by checksum, mintStorageKey is a
 * pure function of salon + image id) only when the image row also survived, so
 * a genuine stranding leaves exactly one object per failed attempt.
 *
 * THE RIGHT FIX WHEN A REAL DRIVER LANDS is the store's own lifecycle rule: S3,
 * GCS and R2 all expire objects by prefix and age, and an "unreferenced after N
 * days" rule at the bucket is cheaper and more reliable than anything this
 * process could do. That is also where the RETENTION SCHEDULE lands — CLAUDE.md
 * § Escalate lists it as the client's decision, next to residency, and it is the
 * same conversation.
 */
