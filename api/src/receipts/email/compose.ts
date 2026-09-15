/**
 * What a receipt email SAYS. No network, no database, no provider.
 *
 * ============================================================================
 * THIS IS NOT `design/AVO Receipt Email.html`, AND SAYING SO IS THE POINT
 * ============================================================================
 * The design bundle contains a FINISHED receipt email — 600px, table-based,
 * dark-mode aware, with a salon-branded header, itemised lines, a totals block,
 * a wallet/loyalty panel, a "View in the app" button, the dispute paragraph and
 * a three-line legal footer. It is final (CLAUDE.md: "The designs in `design/`
 * are **final**"), and `design/README.md` lists "email receipts — send-ready
 * template" among the gaps it has CLOSED.
 *
 * It cannot be rendered from `receipt_job.payload`. Counted against
 * `services/receipts.ts § ReceiptPayload`, the designed email needs ten facts
 * the payload does not carry:
 *
 *   the salon's postal address and phone      the branch line and the footer
 *   the salon's brand hex and logo            the header block
 *   the human receipt reference (AVO-24817)   `transaction.reference`, not `.id`
 *   the settled timestamp                     "Tuesday 4 August 2026 at 14:38"
 *   the staff member and the device           "Hessa M. · Terminal SAL-02"
 *   the per-line artist and duration          "with Hessa M. · 60 min"
 *   the deposit already applied               the "-2.000" line
 *   the balance BEFORE                        "was 52.750 KD"
 *   the loyalty counter                       "7 of 10"
 *   the happy-hour note                       "Happy hour · counted twice"
 *
 * Rendering the design's markup with two thirds of its rows deleted would be a
 * REDESIGN of a settled design (CLAUDE.md § Do not restyle) wearing the design's
 * own styling, which is the failure `logging.ts` refuses in its own words: "an
 * artefact that reads as done". So this composes PLAIN TEXT. Nobody mistakes a
 * text receipt for the finished template; everybody would mistake a gutted copy
 * of it.
 *
 * The copy that IS here is verbatim from that file — the dispute paragraph, the
 * wallet-credit disclosure, the account-record sentence and the "on behalf of"
 * line — because those are true of a receipt regardless of how it is laid out,
 * and CLAUDE.md § Keep the copy verbatim applies to them.
 *
 * WHAT CLOSES THE GAP is a wider `ReceiptPayload` frozen at charge time by the
 * five callers of `queueReceipts`, plus the salon's brand kit. That is a slice,
 * it is entirely inside `api/`, and it is named in the report rather than
 * half-done here.
 *
 * ============================================================================
 * ENGLISH ONLY, AND THAT IS A GAP RATHER THAN A DECISION
 * ============================================================================
 * Non-negotiable #12 makes Arabic first-class, and whatsapp-templates.md says of
 * the four customer messages: "All go to the **customer**, so all need **EN +
 * AR** — this is the one place Arabic is required outside the customer app."
 *
 * There is no Arabic receipt email in the design bundle (`AVO Receipt Email.html`
 * is `lang="en"` throughout) and `member` has NO LOCALE COLUMN — grep the schema;
 * there is nothing to select a language on. Composing Arabic here would be
 * inventing product copy AND inventing the column that chooses it. Reported.
 *
 * ============================================================================
 * WHAT IS DELIBERATELY NOT IN A RECEIPT
 * ============================================================================
 *   `feeFils`             the processor's cut. `db/schema/transaction.ts` calls
 *                         it "merchant-visible, customer-never". It is not in
 *                         `ReceiptPayload` and must never be added to it.
 *
 *   `transaction.note`    DECISIONS.md 107. One internal column carries void
 *                         reasons, "Deposit larger than the visit", "No-show ·
 *                         deposit returned automatically" and an owner's
 *                         free-text adjustment reason. It is a merchant-route
 *                         key, kept off the customer's wire by a single ternary,
 *                         and a receipt is exactly the second serialiser that
 *                         decision warns about.
 *
 *                         THE ONE EXCEPTION IS ALREADY DECIDED AND IS NOT THIS
 *                         FILE'S TO MAKE. `ChargeReceiptPayload.custom.reason`
 *                         is the note of a TYPED price, and 107 is explicit that
 *                         that case is customer-visible on purpose — "a charge
 *                         whose price a staff member invented is precisely the
 *                         charge a customer has cause to query". The payload
 *                         union carries `custom` and carries nothing else from
 *                         `note`, so the boundary is enforced by the type rather
 *                         than by this comment.
 *
 *   the balance, in any   whatsapp-templates.md: "Never include a balance in a
 *   message but this one   message that could be read over someone's shoulder in
 *                         a group. Balance goes in the receipt only." This IS the
 *                         receipt, it is addressed to one verified mailbox, and
 *                         the design puts the balance in it. So it is here.
 *
 *   anything about AVO    the salon is the sender identity. AVO appears once, in
 *   as a brand            the footer line the design itself writes.
 *
 * ============================================================================
 * THE PAYLOAD IS READ DEFENSIVELY, AND NOT OUT OF POLITENESS
 * ============================================================================
 * `payload` is a `jsonb` column and `ReceiptDelivery` types it
 * `Record<string, unknown>` on purpose (`services/receipts.ts`: the discriminated
 * union "constrains the WRITE"). A parked job sits a century out, so a row this
 * function reads may have been written by an older shape of that union. Every
 * field is therefore narrowed, and an unrecognised `kind` still produces a
 * truthful receipt — amount, balance, reference — instead of throwing. Throwing
 * would make a real charge a permanent failure and buy nothing: the money moved
 * and the customer is owed a record of it either way.
 */

import { fils, formatMoney } from '@avo/types';
import type { ReceiptAddressing } from '../types';

export interface ComposedEmail {
  subject: string;
  /** `text/plain`. There is no HTML part — see this file's header. */
  text: string;
}

export interface ComposeInput extends ReceiptAddressing {
  transactionId: string;
  payload: Record<string, unknown>;
}

// --------------------------------------------------------------- narrowing --

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * A money field, or null.
 *
 * `fils()` refuses a non-integer, which is non-negotiable #1 doing its job one
 * layer further out than usual: if a float ever reached the payload this is
 * where it stops, and the receipt drops the line rather than printing a number
 * nobody can reconcile.
 */
function money(v: unknown): string | null {
  if (typeof v !== 'number' || !Number.isInteger(v) || !Number.isSafeInteger(v)) return null;
  return formatMoney(fils(v), 'en');
}

function rows(v: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(v)) return [];
  return v.filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null);
}

/** Right-aligns the amount column so a receipt reads as a receipt in a monospaced client. */
function line(label: string, amount: string | null): string {
  return amount === null ? label : `${label}\n    ${amount}`;
}

// ------------------------------------------------------------------- lines --

/**
 * The itemised block, per payload kind.
 *
 * Returns the lines and nothing else: the header, the total, the balance and the
 * footer are the same for every kind and are assembled once below. A kind this
 * function does not know returns no lines, which is the "truthful minimum"
 * described in the header rather than an error.
 */
function itemsFor(payload: Record<string, unknown>): string[] {
  const kind = str(payload.kind);

  if (kind === 'charge') {
    const services = rows(payload.services)
      .map((s) => {
        const name = str(s.name);
        return name === null ? null : line(name, money(s.priceFils));
      })
      .filter((s): s is string => s !== null);

    /**
     * A TYPED PRICE HAS NO CATALOGUE ROWS, and `services` is empty by
     * construction when it happens — `services/charge.ts` says so at the call
     * site. The reason the manager gave is then the only description of what the
     * money was for, and `ChargeReceiptPayload.custom` exists to carry it.
     *
     * It is quoted rather than made into a sentence. The field's own docblock
     * refuses to "promise a sentence" because `whatsapp-templates.md` § 3 has no
     * custom-amount variable and the design email has no line for one, so
     * wording it would be inventing copy. Quoting is carrying the fact.
     */
    const custom = payload.custom;
    if (typeof custom === 'object' && custom !== null) {
      const reason = str((custom as Record<string, unknown>).reason);
      if (reason !== null) services.push(line(`"${reason}"`, money(payload.amountFils)));
    }
    return services;
  }

  if (kind === 'shop') {
    return rows(payload.items)
      .map((i) => {
        const name = str(i.name);
        if (name === null) return null;
        const qty = typeof i.qty === 'number' && Number.isInteger(i.qty) ? i.qty : null;
        const unit = money(i.unitPriceFils);
        /**
         * "1 × 14.500" is the design's own subline for a shop item, and the
         * quantity is not decoration: `ShopReceiptPayload.items` carries it
         * because "a total that came from a multiplication is not reconcilable
         * without them".
         */
        const label = qty !== null && unit !== null ? `${name}\n    ${qty} x ${unit}` : name;
        return line(label, money(i.lineTotalFils));
      })
      .filter((i): i is string => i !== null);
  }

  if (kind === 'deposit_hold') {
    const service = str(payload.serviceName);
    const artist = str(payload.artistName);
    const startsAt = str(payload.startsAt);
    const what = service !== null && artist !== null ? `${service} with ${artist}` : service;
    const out: string[] = [];
    if (what !== null) out.push(what);
    /**
     * The ISO string as it was frozen, NOT reformatted. The design renders
     * "Tuesday 4 August 2026 at 14:38" and whatsapp-templates.md § Rules demands
     * "12-hour with AM/PM in EN" — both of which need the salon's timezone, and
     * nothing in this payload carries one. A date rendered in the server's zone
     * would be wrong by hours for the customer reading it, which is worse than a
     * timestamp that is obviously machine-shaped.
     */
    if (startsAt !== null) out.push(startsAt);
    out.push(line('Deposit held', money(payload.amountFils)));
    return out;
  }

  if (kind === 'deposit_return') {
    const reason = str(payload.reason);
    return [
      line(
        reason === 'no_show' ? 'Deposit returned' : 'Deposit returned after cancellation',
        money(payload.amountFils),
      ),
    ];
  }

  if (kind === 'topup') {
    const out = [line('Top-up', money(payload.amountFils))];
    const bonus = typeof payload.bonusFils === 'number' ? payload.bonusFils : 0;
    if (bonus > 0) out.push(line('Bonus credit', money(bonus)));
    const credit = money(payload.creditFils);
    if (credit !== null) out.push(line('Credited to your wallet', credit));
    return out;
  }

  return [];
}

/** The one-line summary that also becomes the subject's second half. */
function headlineFor(payload: Record<string, unknown>): string {
  const kind = str(payload.kind);
  if (kind === 'topup') return 'Added to your wallet';
  if (kind === 'deposit_return') return 'Returned to your wallet';
  if (kind === 'deposit_hold') return 'Deposit held from your wallet';
  /** The design's own label, above the amount. */
  return 'Paid from your wallet';
}

// ----------------------------------------------------------------- compose --

export function composeReceiptEmail(input: ComposeInput): ComposedEmail {
  const { payload, salon, transactionId } = input;

  const headline = headlineFor(payload);
  const amount = money(payload.amountFils);
  const balance = money(payload.balanceAfterFils);
  const items = itemsFor(payload);

  const body: string[] = [
    `${salon.name} — receipt`,
    `Reference: ${transactionId}`,
    '',
    amount === null ? headline : `${headline}: ${amount}`,
  ];

  if (items.length > 0) body.push('', ...items);

  if (balance !== null) body.push('', line('Wallet balance', balance));

  body.push(
    '',
    /**
     * VERBATIM from `design/AVO Receipt Email.html`, with the design's literal
     * `AVO-24817` replaced by this transaction's own reference. Nothing else in
     * the sentence moves — it states the 15-minute reversal window, the salon's
     * own reimbursement route, non-negotiable #5 ("Refunds are wallet credit")
     * and the 30-day query window, and all four are product rules rather than
     * layout.
     */
    'Wrong amount? Salon staff can reverse a charge for 15 minutes, and the salon ' +
      'can reimburse you from their dashboard after that. Refunds are returned as ' +
      `wallet credit. Queries within 30 days, please — quote ${transactionId}.`,
    '',
    '—',
    `Paid with wallet credit held for ${salon.name}. Wallet credit is not a bank ` +
      'deposit and is not covered by deposit insurance. Card and KNET payments are ' +
      'processed by a payment provider licensed by the Central Bank of Kuwait.',
    'Receipts are sent for every transaction and are part of your account record.',
    `Sent by AVO Beauty Technologies on behalf of ${salon.name}.`,
  );

  return {
    /** The design's own `<title>`: "Your receipt from Amara". */
    subject: `Your receipt from ${salon.name}`,
    text: body.join('\n'),
  };
}
