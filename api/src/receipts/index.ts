/**
 * Driver selection. One switch, resolved once at boot — gateway/index.ts, with
 * the names changed.
 *
 * Adding WhatsApp is: a new file next to logging.ts implementing
 * `ReceiptSender`, one case here, and `RECEIPT_DRIVER=whatsapp` in the
 * environment. Nothing in services/receiptWorker.ts changes, because nothing
 * there has ever seen a provider's field names.
 *
 * THAT CLAIM HAS NOW BEEN TESTED ONCE, BY `email`, AND IT WAS ALMOST TRUE.
 * The driver, the transport and the composition are all new files and one case,
 * exactly as advertised. What the seam could NOT express was WHO THE RECEIPT IS
 * GOING TO: `ReceiptDelivery` carried a `memberId` and logging.ts assumed "the
 * driver would look it up", which would put a database connection inside every
 * adapter. So the worker resolves the addressing and the interface grew
 * `ReceiptAddressing` — a change to receipts/types.ts and to processJob, not
 * only to this directory. Recorded here because the next driver will want to
 * know what the first one cost.
 */

import { env } from '../env';
import { buildEmailReceiptSender } from './email';
import { LoggingReceiptSender } from './logging';
import type { ReceiptSender } from './types';

function build(): ReceiptSender {
  switch (env.receiptDriver) {
    case 'logging':
      return new LoggingReceiptSender();
    /**
     * The second driver, and the first that sends anything. It handles ONLY the
     * email channel, so selecting it leaves every `whatsapp` row queued for a
     * driver that does not exist yet — see `email/index.ts` and `processJob`'s
     * give-back branch, which this is the first configuration to execute.
     */
    case 'email':
      return buildEmailReceiptSender();
    default: {
      // Exhaustive: adding a driver to the env enum without wiring it here is a
      // type error, not a runtime surprise on the first receipt.
      const never: never = env.receiptDriver;
      throw new Error(`Unknown RECEIPT_DRIVER: ${String(never)}`);
    }
  }
}

export const receiptSender: ReceiptSender = build();

export * from './types';
