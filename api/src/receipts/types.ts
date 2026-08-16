/**
 * The receipt-sending seam.
 *
 * Deliberately the same shape as `gateway/types.ts`, because it is the same
 * situation: a third party the client has not selected yet, on the far side of
 * an interface, so that choosing it later is a driver and not a rewrite.
 *
 * WHAT IS ACTUALLY BLOCKED, AND BY WHOM
 * -------------------------------------
 * Neither channel can be wired today, and neither is waiting on this code:
 *
 *   WhatsApp  design/whatsapp-templates.md — "WhatsApp Business requires these
 *             to be pre-approved templates before you can send them outside a
 *             24-hour service window. Submit them early; approval is not
 *             instant." The four templates are written and unapproved. There is
 *             no template id to send against.
 *
 *   Email     CLAUDE.md § Escalate: "Whether receipts send from AVO's domain or
 *             per-salon subdomains" is an open client decision, and it decides
 *             what gets SPF/DKIM records. There is no verified sending domain.
 *
 * So the driver here logs. That is not a stub standing in for work that should
 * have been done — it is the only honest implementation while the two facts a
 * real sender needs do not exist.
 *
 * THE VOCABULARY IS OURS
 * ----------------------
 * Same rule as the gateway: each adapter maps its provider's error codes into
 * the two outcomes below, so nothing outside this directory ever sees
 * `131047` or `Message failed to send because more than 24 hours have passed`.
 *
 * AND THE DISTINCTION THAT MATTERS IS RETRY-OR-NOT
 * ------------------------------------------------
 * The gateway's seam turns on "declined" versus "could not be reached". This
 * one turns on `ReceiptTransientError` versus `ReceiptPermanentError`, and the
 * worker's whole behaviour hangs off it. Retrying a transient failure is the
 * point of a queue; retrying a permanent one — a template WhatsApp has rejected,
 * a mailbox that does not exist — burns the backoff schedule on a row that can
 * never succeed and hides a real outage behind it.
 */

/** The channels `receipt_job` is keyed on. */
export type ReceiptChannel = 'whatsapp' | 'email';

/** Everything a driver needs to deliver one receipt. */
export interface ReceiptDelivery {
  jobId: string;
  channel: ReceiptChannel;
  transactionId: string;
  memberId: string;
  /** Frozen at charge time so a later price edit cannot rewrite history. */
  payload: Record<string, unknown>;
  /** The attempt number this delivery is, 1-based. For the driver's own logs. */
  attempt: number;
}

export interface ReceiptResult {
  /** The provider's id for this message, stored for support to trace. */
  providerReference: string;
}

/**
 * The provider could not be reached, rate-limited us, or failed in a way that
 * may not happen again. WORTH RETRYING.
 */
export class ReceiptTransientError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ReceiptTransientError';
  }
}

/**
 * This message will never send: the template is unapproved, the address is
 * malformed, the customer has blocked the sender. NOT worth retrying.
 *
 * A worker that cannot tell these apart eventually treats every failure as
 * transient, which is the same as having no retry policy — the queue fills with
 * rows that cannot succeed and a genuine outage becomes invisible inside them.
 */
export class ReceiptPermanentError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ReceiptPermanentError';
  }
}

export interface ReceiptSender {
  /** Matches `RECEIPT_DRIVER`, and is stored on the job for forensics. */
  readonly provider: string;

  /** Which channels this driver can actually deliver. */
  handles(channel: ReceiptChannel): boolean;

  /**
   * Deliver one receipt, or throw.
   *
   * Returning normally means the provider ACCEPTED the message — not that it was
   * read, and for WhatsApp not even that it was delivered. Delivery receipts
   * arrive later on a webhook, which is a separate concern from this queue and
   * deliberately not modelled here: a job that stayed `sending` until the
   * customer's phone acknowledged it would hold a queue slot on a handset being
   * charged overnight.
   */
  send(delivery: ReceiptDelivery): Promise<ReceiptResult>;
}
