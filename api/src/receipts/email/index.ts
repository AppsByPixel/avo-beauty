/**
 * The email receipt driver. `RECEIPT_DRIVER=email`.
 *
 * ============================================================================
 * NAMED FOR THE CHANNEL, NOT FOR THE VENDOR, AND THAT IS LOAD-BEARING
 * ============================================================================
 * The house pattern is one enum naming the thing chosen — `GATEWAY_DRIVER=
 * myfatoorah`, `IMAGE_DRIVER=supabase`. This one is `email`, with the vendor a
 * level down on `RECEIPT_EMAIL_TRANSPORT`, because `ReceiptSender` is keyed on
 * CHANNEL: `handles()` is what the worker asks, WhatsApp is a second driver that
 * is still blocked on template approval, and a deployment will eventually run
 * both.
 *
 * AND SELECTING THIS DRIVER MAKES `handles()` MEAN SOMETHING FOR THE FIRST TIME.
 * `LoggingReceiptSender.handles` returns true for everything — its own comment
 * says it does so because "a real deployment will run a WhatsApp driver that
 * returns false for `email`". This returns FALSE for `whatsapp`, so the branch in
 * `processJob` that gives a row back to the queue — decrements the attempt,
 * re-queues it, re-asserts the claim — finally executes in production rather
 * than only in a spec. The consequence is worth stating plainly: under
 * `RECEIPT_DRIVER=email` every WhatsApp row is re-queued for ever and never
 * sends, which is correct (it is waiting for a driver that can) and is invisible
 * unless somebody looks, because a re-queued row is not a failed one and writes
 * no audit.
 *
 * ============================================================================
 * AN UNVERIFIED OR ABSENT ADDRESS IS A PERMANENT FAILURE, NOT A RETRY
 * ============================================================================
 * `decideReceiptChannels` only ever queues `email` for a member who had a
 * verified address AT CHARGE TIME. This re-checks at SEND time, and the two can
 * genuinely differ: `services/erasure.ts:437` nulls the address and clears the
 * flag when a deletion falls due, and a member can change her address in
 * `routes/members.ts`, which clears `email_verified` until she confirms again.
 *
 * Permanent is the right classification even though the second case might resolve
 * itself in an hour: `RECEIPT_MAX_ATTEMPTS` (6) over `RECEIPT_BACKOFF_MAX_MS`
 * (15 min) cannot outlast a verification email, so retrying spends the budget to
 * reach the same answer. Permanent parks the row AND writes the `risk` audit that
 * `markFailed` exists for — "the money moved and the customer was not told" —
 * which is the only way a salon ever learns it happened.
 *
 * WHAT THIS DOES NOT DO IS FALL BACK TO WHATSAPP. `decideReceiptChannels` owns
 * the floor, it owns `fallback_reason`, and it makes that decision inside the
 * money transaction where the merchant's preference was read. A driver inventing
 * a second, later, un-recorded fallback would produce a WhatsApp receipt whose
 * row says the merchant chose it.
 *
 * ============================================================================
 * THE SENDING DOMAIN IS CONFIGURATION, AND THE CLIENT'S DECISION STAYS OPEN
 * ============================================================================
 * CLAUDE.md § Escalate, don't guess: "Whether receipts send from AVO's domain or
 * per-salon subdomains" is the client's and has not been made. Nothing here
 * decides it.
 *
 *   The DISPLAY NAME is always the salon — whatsapp-templates.md, § Rules that
 *   apply to all four: "The salon name, not 'AVO', is the sender identity."
 *   That half is settled by the design and is not the open question.
 *
 *   The ADDRESS comes from `RECEIPT_EMAIL_FROM_ADDRESS`, which has no default.
 *   Written plainly it is the one-domain answer. Written with the token
 *   `{salon}` it is the per-salon-subdomain answer, substituted from the salon
 *   id. BOTH ARE REACHABLE WITHOUT TOUCHING CODE, which is what "keep the
 *   question open" has to mean if it means anything.
 *
 * THE `{salon}` TOKEN IS A MECHANISM, NOT A PROPOSAL. A salon id is not a mail
 * identity, and a real per-salon scheme probably wants a `salon.mail_label`
 * column with its own uniqueness rule rather than a lowercased primary key. It
 * exists so that the day the answer arrives, the cheap version of it is already
 * expressible and the expensive version is a migration rather than a rewrite.
 * DNS records are the client's either way: neither answer works until SPF and
 * DKIM exist for whatever domain is chosen, and no code in this repository can
 * create those.
 */

import { env } from '../../env';
import {
  ReceiptPermanentError,
  type ReceiptChannel,
  type ReceiptDelivery,
  type ReceiptResult,
  type ReceiptSender,
} from '../types';
import { composeReceiptEmail } from './compose';
import { RESEND_DEFAULT_BASE_URL, ResendEmailTransport } from './resend';
import type { EmailTransport } from './transport';

export interface EmailReceiptSenderConfig {
  /** May contain the `{salon}` token. No default — see `env.ts`. */
  fromAddress: string;
  transport: EmailTransport;
}

/**
 * Turn a salon id into something that may sit in a hostname.
 *
 * Lowercase, non-alphanumerics to a hyphen, runs collapsed, ends trimmed. A
 * result that is empty — or that cannot be a DNS label at all — is refused
 * rather than patched, because the alternative is posting a customer's receipt
 * from an address nobody owns.
 */
export function mailLabelFor(salonId: string): string | null {
  const label = salonId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return label.length > 0 && label.length <= 63 ? label : null;
}

export class EmailReceiptSender implements ReceiptSender {
  /** Matches `RECEIPT_DRIVER`. */
  readonly provider = 'email';

  constructor(private readonly config: EmailReceiptSenderConfig) {}

  handles(channel: ReceiptChannel): boolean {
    return channel === 'email';
  }

  async send(delivery: ReceiptDelivery): Promise<ReceiptResult> {
    /**
     * `processJob` asks `handles()` first, so this is unreachable through the
     * worker. It is here because "unreachable through the current caller" is the
     * assumption `images/supabase.ts § segmentsFor` also declines to rely on, and
     * a WhatsApp payload posted to a mail provider is not a mistake to discover
     * from a customer.
     */
    if (delivery.channel !== 'email') {
      throw new ReceiptPermanentError(
        `the email driver was handed a ${delivery.channel} receipt`,
      );
    }

    const { email, emailVerified, name } = delivery.recipient;
    if (email === null || email.length === 0) {
      throw new ReceiptPermanentError(
        'the member has no email address at send time (erased, or cleared since the charge)',
      );
    }
    if (!emailVerified) {
      throw new ReceiptPermanentError(
        'the member’s email address is not verified at send time — a receipt names ' +
          'what she bought, what it cost and what her balance is now',
      );
    }

    const fromAddress = this.resolveFrom(delivery.salon.id);

    const composed = composeReceiptEmail({
      transactionId: delivery.transactionId,
      payload: delivery.payload,
      recipient: delivery.recipient,
      salon: delivery.salon,
    });

    const result = await this.config.transport.send({
      /** The salon, always. AVO appears once, inside the body, as the design writes it. */
      from: { name: delivery.salon.name, address: fromAddress },
      to: { name, address: email },
      subject: composed.subject,
      text: composed.text,
    });

    /**
     * NO ADDRESS, NO NAME, NO PAYLOAD, NO KEY. `logging.ts` keeps the customer's
     * phone number out of its log line for exactly this reason and logs the
     * payload only because logging IS its output. Here the output is an email;
     * the log is an operational trace, and a trace does not need the mailbox.
     */
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        at: new Date().toISOString(),
        event: 'receipt.send',
        driver: this.provider,
        transport: this.config.transport.name,
        channel: delivery.channel,
        jobId: delivery.jobId,
        transactionId: delivery.transactionId,
        memberId: delivery.memberId,
        attempt: delivery.attempt,
        providerReference: result.providerReference,
      }),
    );

    return result;
  }

  private resolveFrom(salonId: string): string {
    if (!this.config.fromAddress.includes('{salon}')) return this.config.fromAddress;
    const label = mailLabelFor(salonId);
    if (label === null) {
      throw new ReceiptPermanentError(
        `RECEIPT_EMAIL_FROM_ADDRESS uses {salon} and "${salonId}" yields no usable ` +
          'mail label. The sending identity is configuration; this salon has none.',
      );
    }
    return this.config.fromAddress.replace('{salon}', label);
  }
}

/**
 * Build the driver from the environment.
 *
 * The `default` arm is exhaustive over `RECEIPT_EMAIL_TRANSPORT` in the same way
 * `receipts/index.ts` is over `RECEIPT_DRIVER`: adding a value to the enum
 * without a file beside it is a type error at build time, not a surprise on the
 * first receipt of the morning.
 *
 * `env.ts` has already refused to boot if the credentials for the selected
 * transport are missing, so every non-null assertion below is discharged there
 * rather than hoped for here.
 */
export function buildEmailReceiptSender(): EmailReceiptSender {
  let transport: EmailTransport;
  switch (env.receiptEmailTransport) {
    case 'resend':
      transport = new ResendEmailTransport({
        apiKey: env.receiptEmailApiKey ?? '',
        baseUrl: env.receiptEmailApiBaseUrl ?? RESEND_DEFAULT_BASE_URL,
        timeoutMs: env.receiptEmailTimeoutMs,
      });
      break;
    default: {
      const never: never = env.receiptEmailTransport;
      throw new Error(`Unknown RECEIPT_EMAIL_TRANSPORT: ${String(never)}`);
    }
  }

  return new EmailReceiptSender({
    fromAddress: env.receiptEmailFromAddress ?? '',
    transport,
  });
}

export { composeReceiptEmail } from './compose';
export type { EmailMessage, EmailTransport, Mailbox } from './transport';
