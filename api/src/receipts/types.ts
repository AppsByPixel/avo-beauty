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
 *   Email     NO LONGER BLOCKED, and this paragraph used to say it was.
 *             `design/AVO Receipt Email.html` is a finished, send-ready template
 *             and `design/README.md` lists "email receipts" among the gaps it has
 *             CLOSED, so the copy this file assumed was missing has been there
 *             the whole time.
 *
 *             What remains open is what it always was: CLAUDE.md § Escalate,
 *             "whether receipts send from AVO's domain or per-salon subdomains",
 *             which is what decides where SPF and DKIM records go. THAT IS AN
 *             OPERATOR'S VARIABLE RATHER THAN A CODE DECISION — the sender has no
 *             default and both answers are expressible in it — so it blocks a
 *             DEPLOYMENT and does not block a driver. `email/` is that driver.
 *
 * So the driver here logs, and it is still the default: every test run and every
 * environment without a mail credential uses it, and WhatsApp still has no
 * adapter at all.
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

/**
 * WHO A RECEIPT IS GOING TO, RESOLVED AT SEND TIME AND DELIBERATELY NOT FROZEN.
 *
 * `logging.ts` said a driver "would look it up", and that was the wrong half of
 * the seam to put the lookup in. A driver that opens a database connection is
 * not a driver, it is half a service: it makes every adapter depend on Drizzle,
 * and it makes `receiptSender` -- a module-level singleton built at boot --
 * reach for a `Db` the worker is already holding and already passing through
 * `processJob`.
 *
 * SO THE WORKER RESOLVES IT. `services/receiptWorker.ts` does the read, inside
 * `processJob`, immediately before the send.
 *
 * AND IT IS READ AT SEND TIME RATHER THAN FROZEN INTO `payload`, which is the
 * opposite of the rule that governs everything else on this interface.
 * `services/erasure.ts:437` sets `email` to NULL and `email_verified` to false
 * when a member's erasure falls due. A receipt job outlives its transaction by
 * design -- a parked row sits a century out -- so an address copied into
 * `payload` at charge time is an address the erasure job structurally cannot
 * reach, and the first thing a re-enabled worker would do is hand it to a third
 * party. THE MONEY RECORD IS HISTORY AND IS FROZEN; THE DESTINATION IS NOT
 * HISTORY AND IS NOT.
 */
export interface ReceiptAddressing {
  /** The customer. `name` is NOT NULL on the row; `email` is neither. */
  recipient: {
    name: string;
    email: string | null;
    emailVerified: boolean;
  };
  /**
   * THE SENDER IDENTITY IS THE SALON, NOT AVO -- whatsapp-templates.md, the
   * rules that apply to all four templates: "The salon name, not 'AVO', is the
   * sender identity. AVO is invisible to the customer."
   * `design/AVO Receipt Email.html` says it again in its own footer: "Sent by
   * AVO Beauty Technologies on behalf of Amara Salon."
   *
   * Resolved with the recipient and for the same reason: it is addressing, not
   * money. What it is NOT is a licence to read the rest of the salon at send
   * time -- see `email/compose.ts`.
   */
  salon: { id: string; name: string };
}

/** Everything a driver needs to deliver one receipt. */
export interface ReceiptDelivery extends ReceiptAddressing {
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
  /**
   * The provider's id for this message.
   *
   * NOT STORED — decision 74. This said "stored for support to trace", and that
   * was never true: `receipt_job` has no column for it and `markSent` receives
   * the value and drops it. The sentence is corrected rather than the schema
   * because whether support genuinely needs to follow a receipt into the
   * provider's logs is an open product question, and adding a column to make a
   * comment true is answering it the wrong way round.
   *
   * Drivers should keep returning it. It is in the driver's own log line today
   * (`logging.ts`), which is where a trace currently has to start, and the seam
   * should not have to change shape on the day the answer arrives.
   */
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
  /**
   * Matches `RECEIPT_DRIVER`.
   *
   * NOT stored on the job — same correction as `providerReference` above, found
   * while making that one. `receipt_job` has no `provider` column; the only
   * reader of this field is the driver's own log line (`logging.ts`, as
   * `driver`). Which driver sent a given receipt is therefore recoverable from
   * logs and not from the row.
   */
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
