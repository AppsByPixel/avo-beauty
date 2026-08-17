/**
 * Entry point. `pnpm --filter @avo/api run dev`
 *
 * The receipt worker starts HERE and not in `buildApp()`, because `buildApp()`
 * is what the tests construct and a background loop attached to it would send
 * receipts inside every test run. A process that serves requests runs the
 * worker; a process that is exercising handlers does not.
 */

import { buildApp } from './app';
import { db } from './db/client';
import { env } from './env';
import { startReceiptWorker } from './services/receiptWorker';

const app = await buildApp();

await app.listen({ port: env.port, host: '0.0.0.0' });
app.log.info(`AVO API on http://localhost:${env.port}`);

const worker = env.receiptWorkerEnabled
  ? startReceiptWorker(db, (o) => app.log.info(o))
  : null;

app.log.info(
  worker
    ? `receipt worker on, driver=${env.receiptDriver}`
    : 'receipt worker OFF — RECEIPT_WORKER_ENABLED=0 was set deliberately, since ' +
      'the default is on. Receipts will queue and nothing will send them.',
);

/**
 * Stop the worker before the server, so a pass in flight finishes rather than
 * stranding a claimed row in `sending` to wait out its whole lease.
 */
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void (async () => {
      await worker?.stop();
      await app.close();
      process.exit(0);
    })();
  });
}
