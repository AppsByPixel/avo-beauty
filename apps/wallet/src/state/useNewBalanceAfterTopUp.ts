/**
 * "New balance" — the one row on the top-up success screen that is allowed to
 * claim a number is what she has NOW, and the predicate that decides when it may.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * NON-NEGOTIABLE #2 IS THE WHOLE FILE.
 *
 * The number on that row is the server's answer to `GET /members/me`, read
 * AFTER the top-up settled. It is never the balance the screen was already
 * holding plus the intent's `creditFils` — that sum is a client deciding what a
 * customer has, and it is wrong the moment anything else touched the account
 * (a charge at the till, a refund, a second device) between the two reads.
 *
 * So there are exactly three answers, and two of them are the same bar:
 *
 *   no top-up has succeeded on this screen     → null, the row is a bar
 *   one has, and no read has landed since      → null, the row is a bar
 *   one has, and a read landed at or after it  → that read's balance
 *
 * The middle case is the one that costs discipline: the balance IS on screen,
 * it is simply the balance from BEFORE the payment, and labelling it "New
 * balance" would tell her the top-up did nothing. A bar says "not yet", which is
 * true. `interaction-spec.md` §4 forbids the other tempting answer — rendering
 * `0.000` while the number is unknown.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY IT IS A HOOK AND NOT THREE COPIES OF AN INLINE COMPARISON.
 *
 * It was one copy, in `HomeScreen`. `ShopScreen` and `BookScreen` open the same
 * sheet from the cart and from the shortfall banner, and both of them passed a
 * hard-coded `null` with a comment claiming the sheet re-read the member itself.
 * It does not — `TopUpSheet` renders what it is handed — so on those two screens
 * the bar never resolved and the row said nothing, forever. Both screens already
 * TRIGGERED the re-read; neither passed its result through.
 *
 * Three copies of a comparison is how the third one drifts, which is the same
 * reasoning that made `homeScreen` one element in App.tsx. The stamp and the
 * comparison live here, once, and a screen wires two things instead of
 * re-deriving a rule about money.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useRef } from 'react';
import { fils, type Fils } from '@avo/types';

/**
 * The comparison itself, with no React in it.
 *
 * `fetchedAt >= succeededAt` and not `>`: the two stamps are `Date.now()` calls
 * that can land in the same millisecond — `markSucceeded()` fires immediately
 * before the re-read is asked for — and a strict `>` would turn a perfectly
 * good read into a permanent bar on a fast machine.
 *
 * A read that came back OLDER than the success is refused. That is not a
 * hypothetical: `useWalletHome` serves a cached snapshot with the cache's own
 * `fetchedAt` while a refresh is in flight, so the balance sitting in the render
 * after a successful payment is routinely a pre-payment figure.
 */
export function newBalanceAfterTopUp(
  balanceFils: number | null,
  fetchedAt: number | null,
  succeededAt: number | null,
): Fils | null {
  if (succeededAt === null || fetchedAt === null || balanceFils === null) return null;
  if (fetchedAt < succeededAt) return null;
  // `fils()` throws on a float, so a contract violation surfaces here rather
  // than as a wrong figure on the row she reads to check the money arrived.
  return fils(balanceFils);
}

export interface NewBalanceAfterTopUp {
  /**
   * Stamp the moment a top-up settled. Call it inside the `useTopUp`
   * `onSucceeded` callback, beside the re-read the screen already asks for —
   * the order does not matter, the stamp is compared against when the read
   * LANDS, not when it was requested.
   */
  markSucceeded: () => void;
  /** The server's balance since that moment, or `null` — which renders the bar. */
  newBalanceFils: Fils | null;
}

/**
 * @param balanceFils the balance in the member read currently on screen.
 * @param fetchedAt   when that read landed (`useWalletHome`'s `fetchedAt`).
 */
export function useNewBalanceAfterTopUp(
  balanceFils: number | null,
  fetchedAt: number | null,
): NewBalanceAfterTopUp {
  /**
   * A ref, not state: nothing should re-render because a stamp was written.
   * The render that matters is the one the re-read causes, and this value is
   * read during it.
   */
  const succeededAt = useRef<number | null>(null);
  const markSucceeded = useCallback(() => {
    succeededAt.current = Date.now();
  }, []);

  return {
    markSucceeded,
    newBalanceFils: newBalanceAfterTopUp(balanceFils, fetchedAt, succeededAt.current),
  };
}
