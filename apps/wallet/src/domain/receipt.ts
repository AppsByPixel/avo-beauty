/**
 * A Transaction expanded into the receipt the detail sheet shows.
 *
 * WHAT IS AND IS NOT HERE — read this before adding a row.
 *
 * design/AVO Wallet Home.dc.html's detail sheet shows, across its four sample
 * transactions: Artist, Visit credit, Balance after, Original booking, Pickup,
 * Item, and a masked card number. **None of those are fields on
 * api-contract.md's Transaction**, which is exactly:
 *
 *   id · memberId · branchId · kind · amountFils · bonusFils · method · status
 *   · reference · createdAt
 *
 * They are not built, and they are not faked. A running balance in particular is
 * derivable — current balance minus everything newer — and it is left underived
 * on purpose: non-negotiable #2 puts the balance on the server, the transaction
 * list is paginated, and a "Balance after" that silently disagrees with the
 * ledger by one missing row is a support call and possibly a dispute.
 *
 * CONTRACT GAP (reported, not filled): Transaction needs `balanceAfterFils`, the
 * artist and the visit/stamp credit if the designed receipt is to be built. That
 * is a shared-package change and belongs on trunk.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO OF THOSE SIX ARRIVE AT ONE MOMENT, AND `ReceiptDetail` IS THAT MOMENT.
 * ═══════════════════════════════════════════════════════════════════════════
 * Everything above is true OF A `Transaction`. It is not true of a CHECKOUT
 * RESPONSE, which is a different object: `POST /orders` answers with
 * `items[]`, `balanceAfterFils`, `totalFils`, `loyalty` and `voidable`
 * alongside the transaction. So while she is still looking at the screen she
 * paid on, the app holds the itemisation and the SERVER'S OWN balance-after —
 * two of the six rows listed above — and it holds them without deriving
 * anything.
 *
 * `ReceiptDetail` is optional and ADDITIVE. Called without it this function is
 * byte-for-byte what it was, which is what makes one builder safe rather than
 * merely tidy: the activity feed opens the same sheet for the same transaction
 * and its rows do not move because an invoice exists. There is no second
 * builder, because a second one is "one payload built in three places" — and
 * the third place is already real (`api/src/receipts/email/compose.ts`).
 *
 * WHAT STILL IS NOT HERE, AND WHY IT IS NOT DERIVED:
 *
 *   Pickup / Visit credit   `OrderResult.loyalty` carries the RUNNING TOTAL
 *                           (`visits`, or `stamps` of `target`). The design's
 *                           row is a DELTA — "+1 visit" (design:1574). The
 *                           delta is not on the wire. It is 1 today because
 *                           `services/order.ts` passes a literal 1 to
 *                           `applyVisits`/`applyStamps`, and that same file
 *                           reserves the right to change it ("If AVO decides
 *                           otherwise, the change is `loadPromotionInputs` +
 *                           `decideEarning` in step 8"). A client constant
 *                           transcribed from a server literal is exactly the
 *                           receipt figure that goes quietly wrong. Reported.
 *
 *                           Pickup is not on the response at all; it is on
 *                           `ShopOrder`, a different read.
 *
 *   `feeFils`, `note`       merchant-visible-customer-never, and DECISIONS 107.
 *                           Neither is a field on `ReceiptDetail`, so neither
 *                           has a route to a row.
 *
 * The one row the design shows that is deliberately dropped rather than missing
 * is "Processing fee 0.150 KD". That is the AVO commission. api-contract.md
 * § Commission: merchant-visible, customer-never.
 */

import {
  fils,
  formatFils,
  formatMoney,
  moneyAriaLabel,
  type Language,
  type Transaction,
} from '@avo/types';
import type { Copy } from '../copy/types';
import { dateLocale } from './activity';
import { branchName, type Named } from './names';

export interface ReceiptRow {
  label: string;
  value: string;
  /** So a screen reader says "dinars" rather than "thousands". */
  valueLabel?: string;
  /** Money rows are set in the display face; text rows are not. */
  emphasis?: boolean;
}

/**
 * One priced line, as the SERVER priced it.
 *
 * STRUCTURAL ON PURPOSE, rather than importing `OrderLine` from `api/shop.ts`.
 * A `domain/` module that reached into the API client would invert this app's
 * one dependency rule, and the structural shape still fails to compile at the
 * call site if lane A renames a field — `OrderLineSchema` is what types the
 * object being handed in.
 *
 * `productId` and `unitPriceFils` are deliberately absent. The unit price is
 * reconstructible from the line and the quantity and is not a row the wallet's
 * receipt draws; the product id is not something a customer reads. Narrowing
 * here is what keeps `feeFils` and `note` unable to arrive by accident.
 */
export interface ReceiptLine {
  name: string;
  qty: number;
  lineTotalFils: number;
}

/**
 * The facts a CHECKOUT RESPONSE carries and a `Transaction` does not.
 *
 * Every field is the server's own number, passed through and formatted. Nothing
 * here is computed, summed or reconciled by this module — see the header.
 */
export interface ReceiptDetail {
  /** `OrderResult.items`. Absent for kinds that have no itemisation. */
  items?: readonly ReceiptLine[];
  /**
   * `OrderResult.balanceAfterFils` — non-negotiable #2 in one field. It is
   * OPTIONAL and never defaulted: a missing balance means no row, and a zero
   * balance means a row saying 0.000, which is a real outcome and the one a
   * truthiness check would drop.
   */
  balanceAfterFils?: number;
}

export interface Receipt {
  title: string;
  /** "Wallet top-up", "Service", … — the line under the amount. */
  subtitle: string;
  /** The signed headline figure, already formatted. */
  amount: string;
  amountLabel: string;
  positive: boolean;
  /** The status pill. Carries its meaning as text, never as colour alone. */
  status: string;
  statusTone: 'good' | 'warn' | 'bad';
  rows: ReceiptRow[];
  reference: string;
}

const KUWAIT_TIME_ZONE = 'Asia/Kuwait';

function fullWhen(iso: string, lang: Language): string {
  return new Intl.DateTimeFormat(dateLocale(lang), {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: KUWAIT_TIME_ZONE,
  }).format(new Date(iso));
}

function statusTone(status: Transaction['status']): Receipt['statusTone'] {
  if (status === 'settled') return 'good';
  if (status === 'pending') return 'warn';
  return 'bad';
}

function money(amount: number, lang: Language): { value: string; valueLabel: string } {
  const f = fils(amount);
  return { value: formatMoney(f, lang), valueLabel: moneyAriaLabel(f, lang) };
}

export function buildReceipt(
  tx: Transaction,
  branches: (Named & { id: string })[],
  lang: Language,
  copy: Copy,
  /**
   * Present only where the caller holds a checkout response. Omitted everywhere
   * else, including the activity feed, which has a `Transaction` and nothing
   * more.
   */
  detail?: ReceiptDetail,
): Receipt {
  // `nameAr ?? name` — the design's Arabic receipt names the branch in Arabic
  // ("الفرع · أمارا السالمية", AVO Wallet Home.dc.html:1582). See `branchName`.
  const found = branches.find((b) => b.id === tx.branchId);
  const branch = found ? branchName(found, lang) : null;
  const bonus = fils(tx.bonusFils);
  /**
   * What the transaction moved. For a top-up that is the CREDIT — `amountFils`
   * is written as `intent.creditFils` by `services/topup.ts`, bonuses already
   * inside it.
   *
   * ═════════════════════════════════════════════════════════════════════════
   * THIS WAS `add(paid, bonus)` AND IT OVERSTATED EVERY TOP-UP BY ITS BONUS.
   * Driven on avo_lane_b: a 10.000 top-up on Silver moved the balance from
   * 24.500 to 35.500 — eleven thousand fils — and this sheet's headline said
   * 12.000, with a "Landed in wallet" row saying 12.000 underneath it. See
   * `domain/activity.ts` § creditedAmount for the whole account; the list row
   * and this sheet held the same wrong identity and agreed with each other,
   * which is why neither looked wrong next to the other.
   * ═════════════════════════════════════════════════════════════════════════
   */
  const credited = fils(tx.amountFils);
  /**
   * What she handed the gateway: the credit less the tier bonus the salon
   * funded.
   *
   * ⚠️ REPORTED, NOT SOLVED — TRUNK OWNS THE FIX. This is exact only while the
   * tier bonus is the ONLY bonus. A branch top-up boost lands in
   * `promoBonusFils`, which is a column on the transaction and is NOT emitted by
   * `serialiseTransactionForCustomer` (it emits twelve keys and that is not one
   * of them). So on a boosted top-up this row reads high by the promo amount.
   *
   * The two honest options are both outside this lane's column: put
   * `promoBonusFils` on the customer `Transaction`, or put a `paidFils` there so
   * no client subtracts anything. Deriving it here is the least-wrong reading of
   * the data the entity actually carries, and the three rows below at least sum:
   * paid + bonus = landed = the balance movement. The previous arithmetic did
   * not sum to anything.
   */
  const paid = fils(credited - bonus);
  const headline = credited;
  const positive = headline > 0;
  const abs = fils(Math.abs(headline));
  /**
   * A ZERO HEADLINE TAKES NO SIGN, AND THIS IS A REAL TRANSACTION, NOT AN EDGE.
   *
   * `POST /charges` applies a held deposit capped at the basket — `heldDeposit =
   * min(gross, held)` — so when the hold covers the whole visit `due` is 0 and the
   * row is written `amountFils: 0`. Driven on avo_lane_b: a 6.000 Manicure against
   * a 6.000 held deposit answered `amountFils: 0`, `depositAppliedFils: 6000`,
   * balance unchanged at 6500.
   *
   * `positive` is `headline > 0`, so a zero fell to the negative branch and this
   * sheet rendered `−0.000` — announced to a screen reader as "minus 0.000 Kuwaiti
   * dinars", in both languages. The minus asserts a direction that did not happen:
   * nothing left her wallet, and the deposit she had already paid covered the
   * visit.
   *
   * THE FIGURE IS NOT RECOMPUTED — trunk's call on this frame is "leave the figure,
   * fix the frame", and putting the 6.000 gross here would be the client inventing
   * a debit the server never made (#2). Only the sign goes, which needs no new copy
   * in either language and therefore adds nothing to AR_GAPS.
   *
   * ⚠️ WHAT THIS DOES NOT FIX, AND IT NEEDS TRUNK: the sheet still cannot say WHY
   * it was zero. `depositAppliedFils` is on the CHARGE RESPONSE, not on the
   * `Transaction` entity this is built from, so the receipt reads "Service ·
   * 0.000 · Amount 0.000" with nothing reconciling it. The scanner solved the same
   * frame by showing its applied row, but it has the charge response in hand and
   * this does not. Naming the gap rather than deriving a figure from two numbers
   * the entity does not carry.
   */
  const signed = headline === 0 ? '' : positive ? '+' : '−';

  const rows: ReceiptRow[] = [];

  /*
    THE LINES COME FIRST, which is where design:1574 puts `['Item', 'Repair serum
    × 1']` — above "Paid from" and above "Balance after".

    WHAT MOVED, AND IT IS THE ONE ADAPTATION IN THIS SLICE. The design draws a
    SINGLE-item order, so it can afford the label "Item" and put the product in
    the value column with no money beside it — the headline is the whole price.
    A three-line order cannot: three rows all labelled "Item" reads as a fault,
    and each line's own total has to land somewhere or a total that came from a
    multiplication is unreconcilable. So the design's item STRING becomes the
    label and the server's `lineTotalFils` becomes the value.

    That is not an invention; it is the other designed receipt's layout. `design/
    AVO Receipt Email.html` § Line items renders exactly this — the product name
    with "1 × 14.500" beneath it and the line total right-aligned — and
    `api/src/receipts/email/compose.ts` already follows it. Two documents of one
    purchase agreeing on their line block is the point; see
    `receiptEmailParity.test.ts`, which pins it across the process boundary.

    `copy.qtyValue` decides the script: Eastern in Arabic because a quantity is a
    count (design:1587 writes 'سيروم إصلاح × ١'), while the money beside it stays
    Western in both languages (#12). One row, two numbering systems, both correct.
  */
  for (const line of detail?.items ?? []) {
    rows.push({
      label: `${line.name} × ${copy.qtyValue(line.qty)}`,
      ...money(line.lineTotalFils, lang),
      emphasis: true,
    });
  }

  if (tx.kind === 'topup') {
    if (tx.method) rows.push({ label: copy.txPaidWith, value: copy.txMethod[tx.method] });
    rows.push({ label: copy.txYouPaid, ...money(paid, lang), emphasis: true });
    // Non-negotiable: the bonus is the server's number. It is read off the
    // transaction, never recomputed from a tier percentage — and in stamps mode
    // it is 0 and the row does not exist at all.
    if (bonus > 0) {
      const m = money(bonus, lang);
      rows.push({
        // null: a Transaction does not record which tier funded the bonus, so
        // the neutral wording is used rather than the member's current tier.
        label: copy.txTierBonus(null),
        value: `+${m.value}`,
        valueLabel: copy.plus(m.valueLabel),
        emphasis: true,
      });
    }
    rows.push({ label: copy.txLanded, ...money(credited, lang), emphasis: true });
    rows.push({ label: copy.txBranch, value: branch ?? copy.txBranchOnline });
  } else if (tx.kind === 'adjustment') {
    /*
      AN ADJUSTMENT GETS THE AMOUNT AND NOTHING ELSE, AND THE TWO OMISSIONS ARE
      THE POINT. It arrives with `method: 'wallet'` and a real `branchId`, and
      rendering either would state something untrue:

        "Paid from · Wallet balance"  — nothing was paid from anywhere. The
          console added or removed credit; `method` is the column's default for a
          movement with no payment route, not a route. On a CREDIT adjustment the
          row is precisely backwards.

        "Branch · <name>"  — `api/src/routes/adjustments.ts` writes the salon's
          FIRST branch with `branchAssumed: true`, because "the console adjusts a
          SALON-level wallet; no branch is named by the design's card and
          inventing one would put fiat money in one branch's till". The flag is
          not on the wire (`serialiseTransactionForCustomer` emits twelve keys and
          that is not one), so the kind is the only thing that can tell us the
          branch is a placeholder — and for this kind it always is.

      THE REASON IS ABSENT AND STAYS ABSENT. The console requires one and it is
      stored as `note`; the customer serialiser does not emit it, deliberately,
      and whether a customer should read "service complaint" is a product
      question rather than a lane's. So this sheet says WHAT changed, BY HOW
      MUCH, WHEN, and under which reference — and does not imply an explanation
      exists that she could tap into. An adjustment she cannot explain is a
      support call; an adjustment the screen pretends to explain is worse.
    */
    rows.push({ label: copy.txAmountRow, ...money(abs, lang), emphasis: true });
    /*
      AND ON A CREDIT, WHERE IT WENT — the one row this branch was missing.

      `deposit_return` two branches down already says "Returned to · Wallet
      balance", for exactly this reason: money that arrived without her paying
      has to name its destination or the sheet is a figure with no sentence. A
      credit adjustment is the same event — a redeemed voucher, a console
      compensation, a voided charge coming back — and said nothing at all.

      It is also non-negotiable #5 stated as a FACT rather than a promise. The
      value landed in wallet balance; naming that closes the cash and card-reversal
      readings without the sheet having to mention either.

      THE DEBIT SIDE GETS NOTHING, deliberately. "Taken from · Wallet balance" is
      equally true and reads as an accusation on a row she cannot dispute from
      here; and `txPaidFrom · Wallet balance` is the row the branch above already
      refuses by name, because "nothing was paid from anywhere".
    */
    if (headline > 0) {
      rows.push({ label: copy.txAddedTo, value: copy.txWalletBalance });
    }
  } else {
    rows.push({ label: copy.txAmountRow, ...money(abs, lang), emphasis: true });
    if (tx.kind === 'deposit_return') {
      rows.push({ label: copy.txReturnedTo, value: copy.txWalletBalance });
    } else if (tx.method) {
      rows.push({ label: copy.txPaidFrom, value: copy.txMethod[tx.method] });
    }
    if (branch) rows.push({ label: copy.txBranch, value: branch });
  }

  /*
    AND THE BALANCE LAST — design:1574 `['Balance after', '48.500 KD']`,
    design:1587 `['الرصيد بعدها', '48.500 د.ك']`.

    `!== undefined`, NOT A TRUTHINESS CHECK. She can spend her wallet to exactly
    nothing, and `balanceAfterFils: 0` is the single value a falsy test would
    drop — removing the balance row on the one occasion she most needs to read
    it. The same class of bug as the `−0.000` headline this file already carries
    a monument to.

    THE REFUSAL AT THE TOP OF THIS FILE IS INTACT. This is not a running balance
    derived from the current balance minus everything newer; it is the figure the
    server put in the response to the request that moved the money.
  */
  if (detail?.balanceAfterFils !== undefined) {
    rows.push({
      label: copy.txBalanceAfter,
      ...money(detail.balanceAfterFils, lang),
      emphasis: true,
    });
  }

  const spoken = moneyAriaLabel(abs, lang);

  return {
    /*
      THE SAME TITLE THE LIST ROW USES, and that identity is the point rather
      than a tidy-up. `domain/activity.ts § title` carries the argument for
      "Credit" on a positive adjustment and for why it is not "Voucher"; what
      matters here is that the two must not answer differently.

      The repo has already paid for that once: the `−0.000` fix landed in this
      file and not in the list row, so tapping a zero-fils charge CHANGED THE
      ANSWER — `−0.000` in the feed, `0.000` in the sheet, on one transaction.
      A sheet that said "Adjustment" under a row that said "Credit" is the same
      defect with better arithmetic.
    */
    title:
      tx.kind === 'topup' && tx.method
        ? `${copy.txKind.topup} · ${copy.txMethod[tx.method]}`
        : tx.kind === 'adjustment' && headline > 0
          ? copy.txAdjustCredit
          : copy.txKind[tx.kind],
    subtitle: fullWhen(tx.createdAt, lang),
    // U+2212 MINUS, not a hyphen — the character the design sets.
    // MONEY: Western digits in both languages, per non-negotiable #12 and the
    // design's own Arabic receipt (AVO Wallet Home.dc.html:1579 renders
    // '25.000 د.ك' with Latin numerals inside an otherwise Eastern-digit sheet).
    amount: `${signed}${formatFils(abs)}`,
    // The bare spoken amount on a zero — `copy.minus(spoken)` would say "minus
    // 0.000", which is the same false direction the glyph asserted.
    amountLabel: headline === 0 ? spoken : positive ? copy.plus(spoken) : copy.minus(spoken),
    positive,
    status: copy.txStatus[tx.status],
    statusTone: statusTone(tx.status),
    rows,
    reference: tx.reference,
  };
}
