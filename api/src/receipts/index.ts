/**
 * Driver selection. One switch, resolved once at boot — gateway/index.ts, with
 * the names changed.
 *
 * Adding WhatsApp is: a new file next to logging.ts implementing
 * `ReceiptSender`, one case here, and `RECEIPT_DRIVER=whatsapp` in the
 * environment. Nothing in services/receiptWorker.ts changes, because nothing
 * there has ever seen a provider's field names.
 */

import { env } from '../env';
import { LoggingReceiptSender } from './logging';
import type { ReceiptSender } from './types';

function build(): ReceiptSender {
  switch (env.receiptDriver) {
    case 'logging':
      return new LoggingReceiptSender();
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
