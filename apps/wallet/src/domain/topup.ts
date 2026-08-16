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

export interface MethodOption {
  id: PaymentMethod;
  /** The two- to four-letter mark on the tile. */
  tag: string;
  /** A pill next to the name. Only KNET has one. */
  note: string | null;
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
  { id: 'knet', tag: 'KNET', note: 'Most used in Kuwait' },
  // The design sets the Apple mark as U+F8FF, an Apple private-use glyph that
  // renders as tofu on Android and in the web build. A word is legible everywhere.
  { id: 'applepay', tag: 'PAY', note: null },
  { id: 'card', tag: 'VISA', note: null },
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
