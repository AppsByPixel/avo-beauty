/**
 * The arithmetic behind the charge footer — and only the arithmetic that is
 * safe to do on a client.
 *
 * What this computes: the sum of the selected services' prices, the portion of
 * a held deposit that applies to it, and the difference. All three are shown
 * to the artist BEFORE she taps Charge, so they have to exist locally; there is
 * no endpoint that quotes a basket.
 *
 * What this does NOT compute, ever:
 *   - whether the balance is sufficient. The server answers that, and its 402
 *     carries the exact shortfall (non-negotiable #2). A client-side
 *     `total > balance` would race a top-up happening on the customer's phone
 *     at the same counter.
 *   - the new balance after the charge. That comes back on the result.
 *   - any earning multiplier. `isHappyHourLive` gates a banner, never a charge.
 *
 * Every value is `Fils` from @avo/types, so a float cannot get in — the branded
 * type refuses a bare number at compile time (non-negotiable #1).
 */

import { add, fils, subtract, type Fils } from '@avo/types';
import type { ScanService } from '../api/scans';

export interface ChargeTotals {
  /** The services, added up. */
  totalFils: Fils;
  /** The part of the held deposit this charge consumes. Never more than the total. */
  creditFils: Fils;
  /** total − credit. What the wallet is asked for. */
  chargedFils: Fils;
  /** Whether anything is selected at all. */
  hasSelection: boolean;
}

/**
 * design/AVO Staff Scanner.dc.html:632-633 — `credit = min(deposit, total)`,
 * `charged = total - credit`. A deposit larger than the bill does not produce a
 * negative charge, and the remainder is not refunded here: a booking deposit
 * that outruns the services is a booking concern, and bookings are deferred
 * (design/README.md § Known gaps).
 */
export function chargeTotals(
  services: ScanService[],
  selectedIds: ReadonlySet<string>,
  heldDepositFils: Fils,
): ChargeTotals {
  const chosen = services.filter((s) => selectedIds.has(s.id));
  const totalFils = chosen.reduce<Fils>((sum, s) => add(sum, fils(s.priceFils)), fils(0));
  const creditFils = heldDepositFils < totalFils ? heldDepositFils : totalFils;
  return {
    totalFils,
    creditFils,
    chargedFils: subtract(totalFils, creditFils),
    hasSelection: chosen.length > 0,
  };
}
