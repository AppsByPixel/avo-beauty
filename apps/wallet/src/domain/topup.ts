/**
 * The rules of the top-up screen that are not state and not layout.
 *
 * Two of them are product decisions rather than presentation, so they live here
 * where they can be read in one place instead of being implied by the order of
 * some JSX.
 */

import { fils, type Fils, type PaymentMethod, type TopUpIntent } from '@avo/types';

/**
 * design/AVO Wallet Home.dc.html — the four amounts, in fils.
 *
 * These are the salon's offered denominations, not a free-entry field. A custom
 * amount is not in the design and is not in the contract; if it is wanted it is a
 * product decision, not something to add here.
 */
export const TOP_UP_AMOUNTS: Fils[] = [fils(5000), fils(10000), fils(25000), fils(50000)];

/** The amount selected when the card first renders. */
export const DEFAULT_TOP_UP_AMOUNT: Fils = fils(10000);

/**
 * Which tile a "Top up to continue" hand-off should open the sheet on.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THE CALLER CANNOT JUST PASS THE SHORTFALL.
 *
 * `useTopUp.open()` QUOTES IMMEDIATELY. There is no tile picker inside the
 * sheet — the amount it is opened with is the amount `POST /topups` is asked
 * for. So whatever a caller passes is a committed choice, not a suggestion, and
 * the exact shortfall is the wrong committed choice for three separate reasons:
 *
 *   1. It is not an offered denomination. `TOP_UP_AMOUNTS` above is "the salon's
 *      offered denominations, not a free-entry field", and a custom amount is
 *      "a product decision, not something to add here". Quoting 3.250 because
 *      that is what she happens to be short by invents the free-entry field by
 *      the back door.
 *   2. It leaves her at exactly zero. She clears this cart and the next screen
 *      she sees has an empty wallet.
 *   3. It is the one figure that earns nothing. The tier bonus and any live
 *      `topup10`/`topup20` window are what make a tile worth more than its face
 *      value — see `domain/topupPreview.ts`.
 *
 * Points 2 and 3 are `BookScreen`'s argument, already in this codebase, for
 * opening its booking-deposit shortfall on `DEFAULT_TOP_UP_AMOUNT`. This
 * function does not contradict it; it generalises it, and returns exactly the
 * default for every shortfall the default already covers.
 *
 * WHY THE BARE DEFAULT IS NOT ENOUGH HERE EITHER. A booking deposit is
 * `salon.depositFils` — one salon-set figure, so its shortfall is bounded and
 * small, and 10.000 covers it. A CART IS UNBOUNDED. Short by 30.000, the bare
 * default sends her through a full gateway round trip and returns her to a cart
 * she still cannot pay for: the same dead end this hand-off exists to close,
 * one screen later and after a real payment. So: the smallest offered tile that
 * covers the shortfall, floored at the default so a small shortfall still
 * leaves a cushion, and capped at the largest tile when nothing covers it —
 * which is not a dead end, because each such top-up strictly reduces what is
 * left and the next hand-off is smaller.
 *
 * NON-NEGOTIABLE #2 IS INTACT. This picks WHICH published denomination to ask
 * the server to quote. It does not compute credit, does not add anything to a
 * balance, and does not decide what lands in the wallet: `POST /topups` returns
 * the intent, `TopUpSheet` renders the server's `creditFils` before she commits,
 * and `pay()` fires only from the `ready` stage. The `shortfall` handed in is
 * itself the server's `shortfallFils` whenever a 402 has arrived — `useShop`
 * replaces its local figure with the server's the moment one does.
 */
export function topUpAmountForShortfall(shortfallFils: Fils): Fils {
  const target = Math.max(shortfallFils, DEFAULT_TOP_UP_AMOUNT);
  const covering = TOP_UP_AMOUNTS.find((tile) => tile >= target);
  // Nothing covers it: the largest tile is the most progress one tap can make.
  return covering ?? TOP_UP_AMOUNTS[TOP_UP_AMOUNTS.length - 1]!;
}

export interface MethodOption {
  id: PaymentMethod;
  /**
   * The two- to four-letter mark on the tile. A brand mark, not copy — "KNET",
   * "VISA" and "PAY" are the same in both languages, and the design keeps them
   * Latin in its Arabic build too (AVO Wallet Home.dc.html:1406-1408).
   */
  tag: string;
  /**
   * Whether a pill sits next to the name. Only KNET has one.
   *
   * A BOOLEAN AND NOT THE STRING. It was `note: string | null` holding the
   * literal 'Most used in Kuwait', which rendered in English inside the Arabic
   * sheet — a lane screenshot caught it. The wording lives in `copy.mostUsed`,
   * where the Arabic that the design already wrote (design:1405) can reach it.
   */
  mostUsed: boolean;
}

/**
 * KNET FIRST, AND DEFAULT. This ordering is a product decision, not a layout
 * preference — KNET is how Kuwait pays, and putting a card rail above it costs
 * the salon conversions on the surface that funds every other flow in the app.
 * Do not reorder to match a template, an A/B habit, or an iOS design review.
 *
 * NOTHING IN THIS LIST CARRIES A FEE LINE. api-contract.md § Commission is
 * explicit that the commission is "merchant-visible, customer-never", and
 * TopUpIntent.feeFils is annotated the same way. The mock returns feeFils on the
 * intent so the dashboard lane can build its commission column; the wallet must
 * never render it, and the customer pays the amount she chose and nothing else.
 *
 * DESIGN CONFLICT (deliberate, reported): AVO Wallet Home.dc.html carries
 * `knetFee: '150 fils fee'` and `cardFee: '2.5% + 50 fils'` under the method
 * names, and shows a 'Processing fee 0.150 KD' row in the transaction detail.
 * Those are the commission rates verbatim. The contract wins over the prototype:
 * the fee lines and the fee row are not built.
 */
export const PAYMENT_METHODS: MethodOption[] = [
  { id: 'knet', tag: 'KNET', mostUsed: true },
  // The design sets the Apple mark as U+F8FF, an Apple private-use glyph that
  // renders as tofu on Android and in the web build. A word is legible everywhere.
  { id: 'applepay', tag: 'PAY', mostUsed: false },
  { id: 'card', tag: 'VISA', mostUsed: false },
];

export const DEFAULT_PAYMENT_METHOD: PaymentMethod = 'knet';

/**
 * The four outcomes. Each is its own screen with its own copy — a shared
 * "something went wrong" screen would tell a customer whose bank declined her
 * the same thing as a customer who tapped cancel, and would tell a customer
 * whose money is in flight that it failed.
 */
export type TopUpOutcome = 'success' | 'declined' | 'cancelled' | 'pending';

/** Statuses that mean the gateway round trip is over, one way or another. */
export function isTerminal(status: TopUpIntent['status']): boolean {
  return status !== 'created' && status !== 'redirected';
}

/**
 * Contract status → screen.
 *
 * `pending` is its own outcome and never collapses into either neighbour: it is
 * not a failure (the money may well have moved) and not a success (it may not
 * have). api-contract.md client rule 2.
 */
export function outcomeOf(status: TopUpIntent['status']): TopUpOutcome {
  switch (status) {
    case 'succeeded':
      return 'success';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
      return 'declined';
    default:
      // 'pending', and defensively 'created'/'redirected' — a non-terminal status
      // arriving where a terminal one was expected means we do not know yet, and
      // "we do not know yet" is exactly the pending screen.
      return 'pending';
  }
}

/**
 * Whether the outcome may offer a retry.
 *
 * FALSE FOR PENDING, and that is the whole point of the function. A retry button
 * on a payment that may already have gone through is how a customer is charged
 * twice, so the rule is encoded once, here, rather than being an omission in a
 * JSX branch that a later edit can quietly restore.
 */
export function canRetry(outcome: TopUpOutcome): boolean {
  return outcome === 'declined' || outcome === 'cancelled';
}
