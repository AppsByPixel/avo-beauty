/**
 * The transport seam — a seam UNDER the driver seam, and the reason for it.
 *
 * `receipts/types.ts` already puts a provider behind an interface, so why a
 * second one? Because the two questions have different answers and different
 * lifetimes:
 *
 *   ReceiptSender     WHICH CHANNEL. A WhatsApp driver and an email driver are
 *                     different products with different regulators, different
 *                     approval regimes and different `handles()`.
 *
 *   EmailTransport    WHICH POSTMAN. Resend, Postmark, SES, a customer's own
 *                     Microsoft 365 relay. The receipt is identical in all four;
 *                     only the wire shape and the error codes differ.
 *
 * Collapsing them means the day the client picks a different postman is a day
 * somebody edits the file that knows what a receipt says. Split, that day is one
 * new file beside `resend.ts` and one enum value — which is the whole ask.
 *
 * THE VOCABULARY STAYS OURS, one level down. `receipts/types.ts` says no caller
 * should ever see `131047`; the same rule applies here, so an adapter maps its
 * provider's status codes onto `ReceiptTransientError` / `ReceiptPermanentError`
 * and nothing outside this directory learns the provider's name for a bounce.
 * Those two classes are REUSED rather than redeclared: a third error vocabulary
 * between the transport and the driver would have to be translated by the driver
 * into the two the worker already understands, which is a mapping with no
 * information in it.
 *
 * WHY HTTP AND NOT SMTP — the decision, with its cost.
 *
 * SMTP is the genuinely vendor-neutral answer: every provider speaks it, so does
 * a self-hosted relay, so does the client's own tenant. It was rejected on two
 * counts and neither is aesthetic.
 *
 *   A DEPENDENCY OR A HAND-ROLLED PROTOCOL, and both are bad. Node ships no SMTP
 *   client. `nodemailer` is a new entry in the workspace-root `pnpm-lock.yaml`,
 *   which is outside this lane's column (CLAUDE.md § Lanes) — the same wall
 *   `images/supabase.ts` hit and refused. The alternative is ~200 lines of
 *   ESMTP over `node:tls` — EHLO, STARTTLS, AUTH LOGIN, dot-stuffing, MIME
 *   encoding — hand-written, in the path that carries a customer's money record.
 *   The HTTP adapter beside this file is forty lines over the runtime's own
 *   `fetch` and adds nothing to any lockfile.
 *
 *   OUTBOUND SMTP IS THE WRONG SHAPE FOR WHERE THIS RUNS. The demo is a Vercel
 *   function (`api/scripts/build-function.mjs`, `api/README.md § DB_POOL_MODE`).
 *   Serverless runtimes hold raw TCP badly and commonly have 25/465/587 blocked
 *   outright; an HTTPS POST is the one egress every one of them allows.
 *
 * THE COST OF THE CHOICE, stated rather than left to be discovered: an HTTP
 * adapter is per-vendor, so swapping vendors is writing one. That is the price of
 * not hand-rolling a protocol, and this seam is what keeps the price at one file.
 */

import { ReceiptPermanentError, ReceiptTransientError } from '../types';

/** A mailbox. `name` is a display name and is never the address. */
export interface Mailbox {
  name: string;
  address: string;
}

/**
 * One message, in the only vocabulary this project uses for one.
 *
 * TEXT ONLY, and `compose.ts` carries why: the designed HTML receipt needs ten
 * fields `receipt_job.payload` does not freeze, and a gutted copy of a final
 * design is worse than plain text. An `html` field is deliberately absent rather
 * than optional — an optional one invites a driver to fill it with something
 * nobody designed.
 */
export interface EmailMessage {
  from: Mailbox;
  to: Mailbox;
  subject: string;
  text: string;
}

export interface EmailTransport {
  /** Matches the configured transport name. Appears in the driver's log line. */
  readonly name: string;

  /**
   * Hand the message to the provider, or throw one of the two receipt errors.
   *
   * Returning normally means ACCEPTED FOR DELIVERY — not delivered, and
   * certainly not read. A mailbox that bounces afterwards does so on the
   * provider's webhook, which `receipts/types.ts § send` deliberately does not
   * model here.
   */
  send(message: EmailMessage): Promise<{ providerReference: string }>;
}

/**
 * The status-code rule, in one place, because every provider's is the same rule.
 *
 *   2xx            accepted.
 *   408, 429, 5xx  the provider is unreachable, throttling us, or broken.
 *                  TRANSIENT — this is what the queue's backoff exists for.
 *   other 4xx      we sent something the provider will refuse every time: a
 *                  malformed address, an unverified sending domain, a revoked
 *                  key. PERMANENT. Retrying burns six attempts and a quarter of
 *                  an hour to arrive at the same answer, and — per
 *                  `receipts/types.ts` — hides a real outage inside a queue full
 *                  of rows that cannot succeed.
 *
 * AN UNVERIFIED SENDING DOMAIN IS THE 4xx THIS PRODUCT WILL ACTUALLY MEET, and
 * classing it permanent is correct even though an operator could fix it in ten
 * minutes: the fix is a DNS record, not a retry, and the `risk` audit row
 * `markFailed` writes is how anyone finds out it is needed.
 */
export function classifyHttpStatus(status: number, detail: string): Error {
  if (status === 408 || status === 429 || status >= 500) {
    return new ReceiptTransientError(detail);
  }
  return new ReceiptPermanentError(detail);
}
