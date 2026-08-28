/**
 * Driver selection. One switch, resolved once at boot — gateway/index.ts and
 * receipts/index.ts, with the names changed.
 *
 * Adding a real store is: a new file next to disk.ts implementing `ImageStore`,
 * one case here, and `IMAGE_DRIVER=…` in the environment. Nothing in
 * routes/images.ts or services/imageAttachment.ts changes, because nothing there
 * has ever seen a provider's field names — the route asks for bytes by
 * `storage_key` and gets bytes, or asks for a URL and gets one or undefined.
 *
 * The credentials a real driver needs go in env.ts beside the MyFatoorah block,
 * with the same rule: NO DEFAULTS, and a boot assertion naming each missing
 * variable. A store that works unconfigured is a store nobody notices is
 * unconfigured, and a bucket name baked in as a fallback is how somebody else's
 * bucket ends up holding a client's customer photos.
 */

import { env } from '../env';
import { DiskImageStore } from './disk';
import type { ImageStore } from './types';

function build(): ImageStore {
  switch (env.imageDriver) {
    case 'disk':
      return new DiskImageStore(env.imageStorePath, env.nodeEnv === 'production');
    default: {
      // Exhaustive: adding a driver to the env enum without wiring it here is a
      // type error, not a runtime surprise on the first upload.
      const never: never = env.imageDriver;
      throw new Error(`Unknown IMAGE_DRIVER: ${String(never)}`);
    }
  }
}

export const imageStore: ImageStore = build();

export * from './types';
export * from './inspect';
