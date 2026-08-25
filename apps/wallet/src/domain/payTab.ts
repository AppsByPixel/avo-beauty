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

/**
 * Whether the enlarged code is ACTUALLY on the screen — the value handed to
 * `QrOverlay`'s `open` prop, and the last word on the subject.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THIS EXISTS BECAUSE `payTabAction` ALONE IS A GUARD ON TRUST, and trunk proved
 * it with a mutation I had not run: change the Pay handler's
 * `if (payTabAction(codeView) === 'enlarge')` to `if (true)` and all 434 tests
 * stayed green. The rule was tested to the hilt; nothing tested that the button
 * asks it. Someone could inline or delete the call and the suite would applaud —
 * and the resulting defect is the exact one §4 exists to prevent, a stale code
 * held up at a counter where it "looks like the salon's fault".
 *
 * This workspace has no renderer (see `domain/names.ts`), so the honest fix is
 * not a test of the call site — it is to make the call site unable to cause the
 * harm. `open` is DERIVED rather than stored:
 *
 *     open  =  she asked for it   AND   there is a code to show
 *
 * The second conjunct is not the component's to skip. Mutate the handler to
 * `if (true)` now and the request flag flips, but `enlargedCodeIsOpen(true,
 * offlineView)` is still false and no QR renders. What breaks instead is the
 * fallback to Home — visible, recoverable, and not somebody's money.
 *
 * IT ALSO REMOVES A FRAME, and only a frame — the claim is worth stating
 * exactly. The rule used to be enforced by an effect,
 * `useEffect(() => { if (!canEnlarge) setEnlarged(false) })`, which closes a
 * live overlay one render AFTER the code went stale. Driven: a code enlarged
 * over the Shop tab closed 13s after the mint began failing — but those 13s are
 * the wait for the SERVER's expiry to lapse and the retry to fail, and
 * derivation does not shorten them. What it removes is the render in between,
 * where a code the app had ALREADY judged dead was still 246pt on the screen.
 * That frame is the one a scanner samples in.
 * ═════════════════════════════════════════════════════════════════════════════
 */
export function enlargedCodeIsOpen(requested: boolean, view: PaymentCodeView): boolean {
  return requested && view.canEnlarge;
}
