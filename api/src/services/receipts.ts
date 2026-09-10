/**
 * Queueing the receipts for a settled payment.
 *
 * ONE PLACE THAT DECIDES WHICH CHANNELS A PAYMENT QUEUES
 * ------------------------------------------------------
 * Two money paths settle a payment — the charge at the counter and the top-up
 * confirmed by the gateway — and both owe the customer the same receipts.
 * build-plan.md phase 2: "a receipt email AND a WhatsApp receipt arrive for
 * every settled payment". Written out twice, that stays true only until someone
 * edits one of them; written here, the two paths cannot drift.
 *
 * TWO ROWS, NOT ONE WITH TWO DESTINATIONS
 * ---------------------------------------
 * `receipt_job` is keyed on (transaction_id, channel), so each channel is its
 * own job with its own status, its own attempt counter and its own backoff. The
 * worker claims them separately. A WhatsApp provider outage therefore delays
 * exactly one row, and the email that would have sent fine still sends —
 * whatsapp-templates.md's "a failed WhatsApp send must never roll back the
 * transaction that triggered it", applied one level out, between channels.
 *
 * STILL INSIDE THE CALLER'S TRANSACTION
 * -------------------------------------
 * This takes `tx`, never `db`. The rows are written in the same transaction as
 * the debit, which is what makes "the receipts are queued if and only if the
 * money moved" true, and it is why nothing here talks to a network. See
 * db/schema/receipt.ts for the outbox reasoning.
 */

import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { receiptJob } from '../db/schema/receipt';
import { salon } from '../db/schema/salon';
import type { Executor } from './audit';

/** Everything the queue needs to know about the customer being receipted. */
export interface ReceiptRecipient {
  id: string;
  /**
   * HER SALON, because the merchant's channel preference lives on it and every
   * caller already has a member row that carries it.
   *
   * Added rather than threading a resolved preference through five call sites:
   * `services/booking.ts § returnDeposit` — the no-show refund — has NO salon row
   * in scope, so four of the five callers could have passed a preference and the
   * fifth would have needed an extra query or a signature change. The recipient
   * always has `salonId`; the policy is read here, once, inside the caller's
   * transaction.
   */
  salonId: string;
  email: string | null;
  emailVerified: boolean;
}

/** What the merchant chose, as the salon row stores it. */
export interface ReceiptChannelPreference {
  whatsappEnabled: boolean;
  emailEnabled: boolean;
}

export type ReceiptChannel = 'whatsapp' | 'email';

/** Why a channel was queued that the merchant did not ask for. */
export type ReceiptFallbackReason = 'email_unavailable';

export interface ReceiptChannelDecision {
  channels: ReceiptChannel[];
  /** NULL when every queued channel was the merchant's own choice. */
  fallbackReason: ReceiptFallbackReason | null;
}

/**
 * =========================================================================
 * WHICH CHANNELS THIS PAYMENT QUEUES — a pure function of three booleans
 * =========================================================================
 * Extracted so the decision is testable with no database, which matters because
 * the interesting cases are the combinations rather than the rows: three merchant
 * states times two customer capabilities is six answers, and one of them is the
 * only one that could ever produce silence.
 *
 * THE MERCHANT'S CHOICE (DECISIONS.md #88). `salon.whatsapp_enabled` was stored,
 * merchant-editable, served to both clients and consulted by nothing — this
 * function is where it finally is. `salon.email_enabled` is its twin, and
 * `salon_receipt_channel_floor` makes both-off unstorable, so `channels` can
 * never be empty because of a preference.
 *
 * THE CUSTOMER'S CAPABILITY IS NOT A PREFERENCE, AND THE ASYMMETRY IS THE WHOLE
 * DESIGN. `member.phone` is NOT NULL, so WhatsApp is possible for every
 * customer. `member.email` is nullable and `email_verified` defaults false, so
 * email is conditional — and `emailVerified` rather than merely `email` because
 * "an unverified address is one the customer typed, and it might be someone
 * else's. A receipt names what she bought, what it cost and what her wallet
 * balance is now."
 *
 * THAT PRECONDITION IS PRESERVED EXACTLY. A merchant chooses a PREFERENCE; she
 * does not get to override a safety rule about where a customer's balance may be
 * sent. `emailEnabled` can only ever REMOVE the email job, never add one to an
 * address nobody has proven she controls.
 *
 * SO EXACTLY ONE COMBINATION IS DANGEROUS: email-only, and no verified address.
 * `design/README.md` § Known gaps 7 makes a receipt "a record-keeping
 * obligation, not marketing", so silence is not an acceptable answer — and the
 * floor is WhatsApp, which falls out of `member.phone` being NOT NULL rather
 * than being picked. When it fires the row says so, because a merchant reading
 * "sent by WhatsApp" on a salon she set to email-only deserves the reason rather
 * than a mystery.
 */
export function decideReceiptChannels(
  salon: ReceiptChannelPreference,
  recipient: Pick<ReceiptRecipient, 'email' | 'emailVerified'>,
): ReceiptChannelDecision {
  const emailPossible = Boolean(recipient.email) && recipient.emailVerified;

  const channels: ReceiptChannel[] = [];
  if (salon.whatsappEnabled) channels.push('whatsapp');
  if (salon.emailEnabled && emailPossible) channels.push('email');

  if (channels.length > 0) return { channels, fallbackReason: null };

  /**
   * THE FLOOR. Reachable through exactly one door — `whatsappEnabled` false and
   * email impossible — because the CHECK makes both-off unstorable, so
   * `emailEnabled` must be true here and the only missing piece is her address.
   * Hence the single reason: it is the only one that exists.
   */
  return { channels: ['whatsapp'], fallbackReason: 'email_unavailable' };
}

/**
 * =========================================================================
 * WHAT A RECEIPT OWES THE CUSTOMER, AS A TYPE RATHER THAN A HOPE
 * =========================================================================
 * This parameter was `Record<string, unknown>`, and that is exactly how the shop
 * receipt came to say `pickup: true` on a delivery order and stay that way for a
 * whole slice: `services/order.ts` resolves the fulfilment three lines above the
 * queue call, the queue call hardcoded the opposite, and nothing in between was
 * able to object. AN UNTYPED PAYLOAD IS NOT A LOOSE SCHEMA, IT IS THE ABSENCE OF
 * ONE — `Record<string, unknown>` accepts a misspelled field, a dropped field and
 * a field that contradicts the row written beside it, all silently. The
 * discriminated union below is what makes the next such drift a compile error
 * rather than a persisted lie.
 *
 * WHY IT LIVES HERE AND NOT IN `packages/types`. Nothing outside `api/` reads
 * `receipt_job.payload`: the worker claims the row (`services/receiptWorker.ts`),
 * hands it to a driver (`receipts/types.ts`), and the driver renders it. No
 * client, no dashboard, no shared rule and no wire schema consults it — so
 * hoisting this into a trunk-owned package would turn a field only this directory
 * writes and reads into a four-way rebase (CLAUDE.md § Shared packages).
 *
 * IT STAYS `Record<string, unknown>` AT THE DRIVER BOUNDARY, deliberately. A
 * driver's job is to render what it was handed, and narrowing `ReceiptDelivery`
 * would make every driver exhaustive over five kinds it has no reason to
 * distinguish. This type constrains the WRITE, which is the side that drifted.
 *
 * THE FIELDS ARE NOT INVENTED HERE. They are what the five money paths already
 * pass; `design/whatsapp-templates.md` § 3 is the document a renderer will have
 * to satisfy, and it is deliberately not yet satisfied by anything.
 */
interface ReceiptPayloadCommon {
  transactionId: string;
  amountFils: number;
  balanceAfterFils: number;
}

/** `POST /charges` — services rendered at the counter. `services/charge.ts`. */
export interface ChargeReceiptPayload extends ReceiptPayloadCommon {
  kind: 'charge';
  services: Array<{ id: string; name: string; priceFils: number }>;
}

/**
 * `POST /orders` — a wallet purchase from the shop. `services/order.ts`.
 *
 * `fulfilment` RATHER THAN A `pickup` BOOLEAN, and rather than nothing. The
 * column is an enum (`db/schema/delivery.ts` § orderFulfilment), the wire field
 * the merchant board reads is an enum (`routes/orders.ts` § serialiseShopOrder),
 * and a boolean beside two enums is a third vocabulary for one fact — which is
 * how a hardcoded `true` survived review. One word, spelled the same in the row,
 * on the wire, and here.
 *
 * WHAT THIS FIELD DOES NOT DO IS PROMISE A SENTENCE. The design bundle has no
 * delivery receipt copy — `whatsapp-templates.md` § 3's payment receipt has no
 * pickup or delivery variable at all, and `AVO Merchant Dashboard.dc.html:299`
 * still reads "no delivery (phase 2)" — so this carries the FACT truthfully and
 * leaves what a receipt says about it to whoever writes that copy. Inventing a
 * customer-facing delivery line here would be adding a feature (CLAUDE.md § How
 * to work, and § Keep the copy verbatim).
 */
export interface ShopReceiptPayload extends ReceiptPayloadCommon {
  kind: 'shop';
  /** With quantities — a total that came from a multiplication is not reconcilable without them. */
  items: Array<{
    productId: string;
    name: string;
    qty: number;
    unitPriceFils: number;
    lineTotalFils: number;
  }>;
  fulfilment: 'pickup' | 'delivery';
}

/** `POST /bookings` — a deposit taken. `services/booking.ts`. */
export interface DepositHoldReceiptPayload extends ReceiptPayloadCommon {
  kind: 'deposit_hold';
  bookingId: string;
  artistName: string;
  serviceName: string;
  /** ISO 8601. */
  startsAt: string;
}

/** A deposit given back — cancelled by her, or returned by the no-show job. */
export interface DepositReturnReceiptPayload extends ReceiptPayloadCommon {
  kind: 'deposit_return';
  bookingId: string;
  reason: 'cancelled' | 'no_show';
}

/** A settled top-up. `services/topup.ts`. */
export interface TopupReceiptPayload extends ReceiptPayloadCommon {
  kind: 'topup';
  intentId: string;
  bonusFils: number;
  creditFils: number;
  method: 'knet' | 'card' | 'applepay' | 'wallet';
  reference: string;
}

export type ReceiptPayload =
  | ChargeReceiptPayload
  | ShopReceiptPayload
  | DepositHoldReceiptPayload
  | DepositReturnReceiptPayload
  | TopupReceiptPayload;

export async function queueReceipts(
  tx: Executor,
  recipient: ReceiptRecipient,
  transactionId: string,
  payload: ReceiptPayload,
): Promise<void> {
  /**
   * The preference, read in the CALLER'S TRANSACTION so a merchant who flips a
   * channel mid-charge cannot have this row decided by a different world than
   * the debit beside it.
   */
  const [s] = await (tx as unknown as Db)
    .select({ whatsappEnabled: salon.whatsappEnabled, emailEnabled: salon.emailEnabled })
    .from(salon)
    .where(eq(salon.id, recipient.salonId))
    .limit(1);

  /**
   * A MISSING SALON IS NOT A REASON TO SEND NOTHING. Every caller has just
   * written a money row whose `salon_id` is an FK to this table, so it cannot be
   * absent — and if it somehow were, the obligation to receipt the payment does
   * not go away. Defaults to the floor rather than to no rows at all.
   */
  const preference: ReceiptChannelPreference = s ?? {
    whatsappEnabled: true,
    emailEnabled: false,
  };

  const decision = decideReceiptChannels(preference, recipient);

  await tx.insert(receiptJob).values(
    decision.channels.map((channel) => ({
      transactionId,
      memberId: recipient.id,
      channel,
      payload,
      /**
       * On every row of a fallback send, not only the first: `receipt_job` is
       * keyed on (transaction_id, channel) and the worker claims rows
       * independently, so a row that cannot say why it exists is a row somebody
       * reads in isolation.
       */
      fallbackReason: decision.fallbackReason,
    })),
  );
}
