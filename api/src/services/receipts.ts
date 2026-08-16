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

import { receiptJob } from '../db/schema/receipt';
import type { Executor } from './audit';

/** Everything the queue needs to know about the customer being receipted. */
export interface ReceiptRecipient {
  id: string;
  email: string | null;
  emailVerified: boolean;
}

export async function queueReceipts(
  tx: Executor,
  recipient: ReceiptRecipient,
  transactionId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const rows: (typeof receiptJob.$inferInsert)[] = [
    { transactionId, memberId: recipient.id, channel: 'whatsapp', payload },
  ];

  /**
   * Email only when there is a verified address to send it to.
   *
   * The alternative — queue unconditionally and let the worker discover there
   * is no address — buys nothing and costs something: a row that can never
   * succeed, retried on the worker's backoff schedule until it exhausts its
   * attempts, sitting in the failed queue where a real provider outage should
   * be visible. `member.email` is nullable by design (Reem in the fixtures has
   * none), so this is a normal case, not an edge one.
   *
   * `emailVerified` and not merely `email`: an unverified address is one the
   * customer typed, and it might be someone else's. A receipt names what she
   * bought, what it cost and what her wallet balance is now. That is not
   * something to send to an address nobody has proven she controls.
   */
  if (recipient.email && recipient.emailVerified) {
    rows.push({ transactionId, memberId: recipient.id, channel: 'email', payload });
  }

  await tx.insert(receiptJob).values(rows);
}
