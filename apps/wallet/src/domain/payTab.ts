/**
 * What the Pay tab does — design/AVO Wallet Home.dc.html:627.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE PAY TAB IS NOT A DESTINATION, AND IT IS NOT A SECOND QR PATH.
 *
 * design:627 binds it to `openQr`, which is the SAME handler the wallet card's
 * payment-code panel is bound to (design:254). It sets one flag — `qrOpen` — and
 * does not touch `screen`, which is why design:1897 renders the tab inactive
 * unconditionally: there is no screen for it to be "on".
 *
 * So this module decides nothing about tokens. Non-negotiable #2: the client
 * never mints one. It answers a single question — may the tab open the enlarged
 * code right now? — and it answers it from `paymentCodeView`, the rule that
 * already governs the panel and the overlay.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THAT SHARING IS THE WHOLE POINT.
 *
 * `interaction-spec.md` §4: "The QR must be hidden offline — a stale token will
 * fail at the counter and that failure looks like the salon's fault."
 *
 * A Pay tab with its own idea of when a code may be shown would put that code
 * straight back — at 246pt, from the Shop tab, on a phone with no signal. The
 * suppression that takes the QR off Home has to govern the tab too, and the only
 * way to be sure of that is for both to read one value. `payTabAction` is
 * therefore defined over `PaymentCodeView` rather than over statuses of its own,
 * and `payTab.test.ts` asserts the biconditional over every shape that type can
 * take: the tab enlarges IF AND ONLY IF `canEnlarge`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT DOES INSTEAD, AND WHAT IS NOT SETTLED.
 *
 * §4 says the QR is hidden. It does not say what a top-level Pay affordance
 * should do while it is hidden, and neither does the design — its prototype has
 * no offline state at all. Rather than invent a disabled treatment the design
 * does not draw, or a toast whose words nobody wrote, the tab falls back to the
 * OTHER rendering of the same thing: the payment-code panel on Home, which
 * already carries the reason in the design's own copy (`qrOfflineTitle` /
 * `qrOfflineBody` when the wallet is offline, `qrFailedTitle` / `qrFailedBody`
 * when the mint failed, a placeholder while it is still in flight).
 *
 * One rule, said once: Pay shows the payment code. `enlarge` is the big
 * rendering; `home` is the small one plus the sentence explaining itself. This
 * is the minimum honest answer and it is FLAGGED for a DECISIONS.md entry, not
 * claimed as settled.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import type { PaymentCodeView } from './paymentCode';

export type PayTabAction =
  /** There is a server-issued code. Open it over the screen she is on. */
  | 'enlarge'
  /**
   * There is no code to enlarge. Go to Home, where the panel says why.
   * Never a QR — see the header and `interaction-spec.md` §4.
   */
  | 'home';

export function payTabAction(view: PaymentCodeView): PayTabAction {
  return view.canEnlarge ? 'enlarge' : 'home';
}
