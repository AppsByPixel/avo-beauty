/**
 * The development driver: bytes on this process's filesystem.
 *
 * gateway/sandbox.ts's counterpart, and it carries the same warning in a
 * different shape.
 *
 * IT REFUSES TO WRITE IN PRODUCTION, AND THAT IS NOT THE GATEWAY'S REASON.
 * ----------------------------------------------------------------------
 * `GATEWAY_DRIVER=sandbox` is refused at BOOT because it fabricates a fact — it
 * settles payments nobody made. This driver fabricates nothing; the bytes it
 * writes are the bytes it was given. What it cannot do is KEEP them: a local
 * directory is gone at the next deploy, invisible to a second process, and
 * located wherever the container happens to run — which is precisely the
 * question (data residency, CLAUDE.md § Escalate) that has not been answered.
 *
 * So the failure mode is not a false record, it is a silent one: the upload
 * returns 201, the row is written, the merchant sees her picture, and some time
 * later every customer gets a 404 with nothing in any log to say when the bytes
 * stopped existing. `CALENDAR_DRIVER=stub` is allowed in production because it
 * is "degraded, honest, and tradeable" — degraded per request, visibly, now.
 * This is degraded retroactively and invisibly, which is the opposite.
 *
 * WHY A WRITE REFUSAL AND NOT A BOOT REFUSAL. A boot refusal would stop the
 * whole API — charges, top-ups, sign-in — over a product-photo capability
 * nobody has to use. http/errors.ts § serviceUnavailable exists for exactly this
 * distinction: "the server is fine, a capability it depends on is not deployed",
 * and it says the message must name what is missing rather than shrugging. READS
 * ARE NOT REFUSED: whatever is already on the disk still serves, because
 * refusing those would break a running deployment to make a point.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { ImageStore, PutInput, StorageKey, StoredBytes } from './types';
import { ImageStoreNotConfiguredError, ImageStoreUnavailableError } from './types';

export class DiskImageStore implements ImageStore {
  readonly name = 'disk';

  constructor(
    private readonly root: string,
    private readonly refuseWrites: boolean,
  ) {}

  /**
   * A key is a path fragment, so it is a path traversal waiting to happen.
   *
   * Keys are minted by services/imageAttachment.ts from an id this API generated
   * and a salon id it read out of a principal, so nothing user-supplied reaches
   * here today. That is an argument about the current callers, and callers
   * change. The resolved path is checked to be UNDER the root, and a key
   * containing a separator or a dot-segment is refused outright — the check
   * belongs next to the filesystem call, not in the caller's head.
   */
  private pathFor(key: StorageKey): string {
    if (key === '' || key.includes('\0') || key.includes('..')) {
      throw new ImageStoreUnavailableError('Refusing a storage key with a path segment in it.');
    }
    // The key is hashed into two shard levels so one directory does not
    // accumulate every blob in the deployment. The key itself survives as the
    // filename with separators flattened, so `SELECT storage_key FROM image` is
    // still enough for a developer to find a row's bytes by eye — which matters
    // now that the key is a digest rather than the id printed in the API's reply.
    const shard = createHash('sha256').update(key).digest('hex').slice(0, 4);
    const safe = key.replace(/[^A-Za-z0-9._-]/g, '_');
    const full = resolve(join(this.root, shard.slice(0, 2), shard.slice(2, 4), safe));
    const rootResolved = resolve(this.root);
    if (full !== rootResolved && !full.startsWith(rootResolved + sep)) {
      throw new ImageStoreUnavailableError('Refusing a storage key that escapes the store root.');
    }
    return full;
  }

  async put(input: PutInput): Promise<void> {
    if (this.refuseWrites) {
      throw new ImageStoreNotConfiguredError(
        'IMAGE_DRIVER=disk keeps uploads on one machine’s filesystem, so they do not ' +
          'survive a deploy and are invisible to every other process. Select a durable ' +
          'image store before production — which needs the data residency decision ' +
          'in CLAUDE.md § Escalate, don’t guess.',
      );
    }
    const target = this.pathFor(input.key);
    try {
      await mkdir(dirname(target), { recursive: true });
      /**
       * Write to a temporary name and rename into place. A crash halfway through
       * a direct write leaves a TRUNCATED file at the real key — bytes that pass
       * every check the row records and decode to nothing. `rename` within one
       * filesystem is atomic, so a reader sees the whole object or no object.
       */
      const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, input.bytes);
      await rename(tmp, target);
    } catch (cause) {
      throw new ImageStoreUnavailableError('The image store could not write.', { cause });
    }
  }

  async get(key: StorageKey): Promise<StoredBytes | null> {
    const target = this.pathFor(key);
    try {
      const bytes = await readFile(target);
      /**
       * The content type comes from the DATABASE ROW, not from here — the caller
       * already holds it and the disk has no place to keep one. Returning the
       * caller's own value would be a fiction; returning octet-stream would make
       * the route choose between two answers. So the field is filled by the
       * caller and this is a byte reader.
       */
      return { bytes, contentType: '' };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw new ImageStoreUnavailableError('The image store could not read.', { cause });
    }
  }

  async remove(key: StorageKey): Promise<void> {
    const target = this.pathFor(key);
    try {
      // `force` makes a missing file a success. The reaper re-runs over rows it
      // may have half-processed, and a second delete must not fail the pass.
      await rm(target, { force: true });
    } catch (cause) {
      throw new ImageStoreUnavailableError('The image store could not delete.', { cause });
    }
  }

  /** No such concept on a filesystem. The route streams instead. See types.ts. */
}
