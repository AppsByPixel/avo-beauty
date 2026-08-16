/**
 * The payment gateway seam.
 *
 * WHY THIS INTERFACE EXISTS AT ALL
 * --------------------------------
 * "CBK/PSP selection" is on CLAUDE.md's escalate-don't-guess list. It is a
 * client decision that has not been made, and phase 2 cannot wait for it. So
 * nothing above this file knows a processor's name, its field names, its status
 * vocabulary or its signature scheme. Swapping the sandbox for the real
 * processor is `GATEWAY_DRIVER=…` and one new file in this directory.
 *
 * The interface is deliberately four methods and no more, because those four are
 * the only things the top-up flow actually needs of a PSP:
 *
 *   createPayment    ask for a hosted page      (POST /topups)
 *   fetchPayment     ask what really happened   (GET /topups/{id})
 *   verifySignature  is this callback ours      (POST /webhooks/{provider})
 *   parseEvent       what did the callback say  (POST /webhooks/{provider})
 *
 * THE ONE RULE THE SEAM ENCODES
 * -----------------------------
 * `fetchPayment` is the only thing that may cause a credit. api-contract.md
 * § TopUpIntent client rule 1 — "the return URL is a hint, not a result" — is a
 * client rule, but a client rule the server has to make true, because a client
 * that returns to `avo://topup/return?intent=TI-1` has told us nothing except
 * that a browser closed. A webhook is the gateway *pushing* the same read, and
 * it is authenticated by signature for exactly that reason: an unverified
 * webhook is an unauthenticated credit endpoint with a nice name.
 */

import type { Fils, PaymentMethod } from '@avo/types';

/**
 * What a PSP can tell us about a payment. Deliberately OUR vocabulary — each
 * adapter maps its processor's strings into these, so nothing outside this
 * directory ever sees `PAYMENT_CAPTURED` or `RESULT=CANCELED`.
 */
export type GatewayOutcome =
  | 'succeeded'
  | 'declined'
  | 'cancelled'
  /** Real, and terminal-ish: authorised but not settled, or an offline KNET leg. */
  | 'pending'
  /** The processor itself failed the payment. Not the same as us failing to reach it. */
  | 'gateway_error';

export interface CreatePaymentInput {
  /** Our intent id, passed through so a PSP dashboard is reconcilable by eye. */
  intentId: string;
  memberId: string;
  amountFils: Fils;
  method: PaymentMethod;
  /** Where the hosted page sends the customer back to. A hint, never a result. */
  returnUrl: string;
}

export interface CreatedPayment {
  /** The processor's id for this payment. The key a webhook arrives on. */
  pspReference: string;
  /** The hosted page. Absolute — TopUpIntentSchema requires a URL. */
  redirectUrl: string;
}

export interface GatewayPaymentState {
  pspReference: string;
  outcome: GatewayOutcome;
  /** What the processor charged the customer, for the mismatch check. */
  amountFils: Fils;
}

/** A callback delivery, after the adapter has normalised it. */
export interface GatewayEventPayload {
  /** The PSP's id for this DELIVERY. The dedupe key — not our idempotency key. */
  eventId: string;
  pspReference: string;
  outcome: GatewayOutcome;
  amountFils: Fils;
  /** The processor's own status string, stored verbatim for forensics. */
  reportedStatus: string;
}

/**
 * A hint the sandbox driver honours and a real driver ignores.
 *
 * It exists so lanes B and D can reach every outcome without a real card: the
 * sandbox MUTATES its stored payment to this outcome and then reports it, so
 * what comes back is still an honest read of gateway state rather than a status
 * the API invented. That distinction is the whole point — the mock's habit of
 * answering `succeeded` for an id it had never seen is the bug this replaces.
 */
export interface FetchOptions {
  simulate?: GatewayOutcome | undefined;
}

export interface PaymentGateway {
  /** Matches the `{provider}` segment of `POST /webhooks/{provider}`. */
  readonly provider: string;

  createPayment(input: CreatePaymentInput): Promise<CreatedPayment>;

  /** The authoritative read. The ONLY thing entitled to move a balance. */
  fetchPayment(pspReference: string, options?: FetchOptions): Promise<GatewayPaymentState>;

  /**
   * Verify a callback against the RAW body — not the parsed object. Re-encoding
   * JSON before hashing it is the classic way a signature check passes while
   * verifying a different document than the one that was signed.
   */
  verifySignature(rawBody: string, headers: Record<string, string | string[] | undefined>): boolean;

  parseEvent(payload: unknown): GatewayEventPayload;
}

/** The processor could not be reached or answered nonsense. Not a decline. */
export class GatewayUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    // `cause` is Error's own field. Declaring a parameter property of the same
    // name shadows it — TS4115 — and loses whatever the runtime would attach.
    super(message, options);
    this.name = 'GatewayUnavailableError';
  }
}

/** A callback we cannot read. Distinct from one we can read and disbelieve. */
export class GatewayEventMalformedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayEventMalformedError';
  }
}
