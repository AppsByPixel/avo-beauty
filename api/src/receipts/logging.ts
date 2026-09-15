/**
 * The logging driver — the receipt sender you use when there is nothing to send
 * with yet.
 *
 * It implements `ReceiptSender` exactly as the WhatsApp and email adapters will,
 * and it is the only file that knows logging is what happens. The point is not
 * the log line; it is that everything upstream — the worker, the claim query,
 * the backoff schedule, the transient/permanent split, the audit of a receipt
 * that could not be sent — runs today against a driver, so the morning a real
 * provider is connected is a new file in this directory and one environment
 * variable, not the first time any of it executes.
 *
 * THAT MORNING CAME FOR EMAIL, AND THE PREDICTION WAS NEARLY RIGHT.
 * `email/` is a directory of new files, one case in `index.ts`, and variables in
 * `env.ts`. The worker's claim, backoff, retry and audit all ran unchanged and
 * first time. What the prediction missed is in this file, below: see WHO THE
 * RECEIPT IS FOR.
 *
 * THIS DRIVER REMAINS THE DEFAULT AND IS NOT DEPRECATED BY IT. It is what every
 * test run, every developer's API and every environment without a mail
 * credential uses, and WhatsApp is still blocked on template approval, so a
 * driver that handles both channels is still the only one that leaves nothing
 * queued.
 *
 * WHY IT IS NOT ALLOWED TO PRETEND HARDER
 * ---------------------------------------
 * A tempting version of this renders the approved WhatsApp template into the log
 * so the output "looks real". design/whatsapp-templates.md is explicit that the
 * four templates are unapproved and that variables are positional (`{{1}}`,
 * `{{2}}`), which is WhatsApp's format and depends on the exact template body
 * that gets approved. Rendering against a body nobody has approved produces a
 * message that will need rewriting and, worse, an artefact that reads as done.
 *
 * So it logs the payload it was handed and names the channel. It does not
 * compose customer-facing copy, in either language, because that copy is
 * downstream of an approval that has not happened.
 *
 * IT NEVER FAILS
 * --------------
 * There is no simulated flakiness here. The sandbox gateway simulates outcomes
 * because a client genuinely needs to reach a declined top-up to build its
 * screens; nothing in the product renders a failed receipt to a customer, so a
 * driver that randomly failed would only make the worker's own tests
 * nondeterministic. The retry path is exercised by pointing the worker at a
 * driver that throws — see the failure-injection run in the commit message —
 * not by making the default driver unreliable.
 */

import type {
  ReceiptChannel,
  ReceiptDelivery,
  ReceiptResult,
  ReceiptSender,
} from './types';

export class LoggingReceiptSender implements ReceiptSender {
  readonly provider = 'logging';

  /**
   * Both, because the queue's shape has to be exercised for both. `handles` is
   * not decoration: a real deployment will run a WhatsApp driver that returns
   * false for `email`, and the worker has to already do something sensible with
   * that (leave the row queued rather than fail it) before the day it matters.
   */
  handles(_channel: ReceiptChannel): boolean {
    return true;
  }

  /**
   * WHO THE RECEIPT IS FOR — a correction to this file's own prediction.
   *
   * The comment on the payload below says "The customer's phone number is NOT
   * here: the driver would look it up." Building the email driver established
   * that a driver must NOT look it up. A driver that opens a database connection
   * is not a driver: it makes every adapter depend on Drizzle, and it makes
   * `receiptSender` — a singleton built at boot — reach for a `Db` the worker is
   * already holding and already passing through `processJob`.
   *
   * So `ReceiptDelivery` gained `ReceiptAddressing` and the WORKER resolves it.
   * This driver ignores it, on purpose and for the reason the phone number was
   * kept out in the first place: a log line is not where a mailbox goes.
   */

  async send(delivery: ReceiptDelivery): Promise<ReceiptResult> {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        at: new Date().toISOString(),
        event: 'receipt.send',
        driver: this.provider,
        channel: delivery.channel,
        jobId: delivery.jobId,
        transactionId: delivery.transactionId,
        memberId: delivery.memberId,
        attempt: delivery.attempt,
        /**
         * Logged whole rather than summarised. It is what a real provider would
         * be handed, and when the WhatsApp templates come back approved the
         * question "did we have the fields the template needs?" is answerable
         * from these lines instead of from a guess.
         *
         * It carries no credential and no PII beyond what the customer is about
         * to be sent anyway — an amount, a service list and a balance. The
         * customer's phone number is NOT here: the driver would look it up, and
         * a log line is not the place for it.
         */
        payload: delivery.payload,
      }),
    );

    return { providerReference: `LOG-${delivery.jobId}` };
  }
}
