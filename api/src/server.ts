/**
 * Entry point. `pnpm --dir=/abs/path/to/api run dev`
 *
 * The receipt worker starts HERE and not in `buildApp()`, because `buildApp()`
 * is what the tests construct and a background loop attached to it would send
 * receipts inside every test run. A process that serves requests runs the
 * worker; a process that is exercising handlers does not.
 */

import { buildApp } from './app';
import { db } from './db/client';
import { env } from './env';
import { startNoShowWorker } from './services/noShowWorker';
import { startReceiptWorker } from './services/receiptWorker';
import { TOPUP_REAP_AFTER_HOURS, startTopUpReaper } from './services/topupReaper';

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
 * The no-show return job. Same split as the receipt worker and for the same
 * reason: `buildApp()` is what the tests construct, and a loop attached to it
 * would return deposits inside every test run at a moment no test chose.
 */
const noShow = env.noShowWorkerEnabled ? startNoShowWorker(db, (o) => app.log.info(o)) : null;

app.log.info(
  noShow
    ? `no-show worker on, every ${env.noShowPollMs}ms`
    : 'no-show worker OFF — NO_SHOW_WORKER_ENABLED=0 was set deliberately, since ' +
      'the default is on. Missed appointments will hold their deposits for ever.',
);

/**
 * The abandoned top-up reaper — DECISIONS.md #27.
 *
 * OFF BY DEFAULT, and it is the only background loop here that is. The two above
 * default on because leaving them off is a product failure; leaving this one off
 * costs nobody anything, and `NO_SHOW_WORKER_ENABLED` defaulting on is what made
 * `deposit.test.ts` flaky for weeks — this file is what the e2e harness boots.
 * services/topupReaper.ts § OFF BY DEFAULT carries the argument, including how a
 * test pins it (it does not have to).
 */
const topupReaper = env.topupReaperEnabled
  ? startTopUpReaper(db, env.topupReaperPollMs, (o) => app.log.info(o))
  : null;

app.log.info(
  topupReaper
    ? `top-up reaper ON — TOPUP_REAPER_ENABLED=1 was set deliberately, since the ` +
        `default is off. Unsettled intents older than ${TOPUP_REAP_AFTER_HOURS}h will be ` +
        `moved terminal every ${env.topupReaperPollMs}ms.`
    : 'top-up reaper off (the default). Abandoned top-up intents accumulate; ' +
      'drain them deliberately with `pnpm run job:topup-reap`.',
);

/**
 * Stop the workers before the server, so a pass in flight finishes rather than
 * stranding a claimed row in `sending` to wait out its whole lease.
 */
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void (async () => {
      await Promise.all([worker?.stop(), noShow?.stop(), topupReaper?.stop()]);
      await app.close();
      process.exit(0);
    })();
  });
}
