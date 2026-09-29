/**
 * Tap a control, and let whatever the tap sets off (a mocked read, a refused
 * request, the re-read that follows it) answer INSIDE `act`.
 *
 * Test-only. Nothing in the app imports it.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY A WAIT FOR "ENABLED" IS NOT ENOUGH BEFORE THE NEXT TAP
 * ═════════════════════════════════════════════════════════════════════════════
 * react-native-web's `Pressable` hands its `disabled` and `onPress` to a
 * PressResponder in a PASSIVE effect — `usePressEvents` calls
 * `pressResponder.configure(config)` inside `useEffect`. The DOM attribute and
 * the handler therefore change at two different moments:
 *
 *   commit             `aria-disabled` goes away       ← `waitFor` sees this
 *   passive effects    the responder learns `disabled: false`
 *
 * When a mocked read answers OUTSIDE `act`, React schedules that commit on its
 * own scheduler, and the passive effects come in a LATER scheduler task. Quiet,
 * both land in one 5ms slice and nobody can tell them apart. Under load the
 * slice runs out between them: `waitFor` resolves on the commit, Testing
 * Library's drain (one `setTimeout(0)`) fires before the scheduler's next task,
 * and the test's next `fireEvent.click` reaches a responder still holding
 * `disabled: true`. The tap is dropped. Nothing is retried, so the flow never
 * advances and the next wait fails.
 *
 * That is what trunk's gate hit twice on 2026-09-29 — bookBranchRowsRender
 * ("book-service-SV-1" never appeared) and bookEntryRender ("اختاري الخدمة"
 * never appeared) — and lane B reproduced it under 36 `yes` processes. The DOM
 * dump at failure was the same every time: the branch chosen, Continue ENABLED,
 * the counter still on step 1 — five seconds after the tap. A longer
 * `asyncUtilTimeout` does not help: the tap is lost, not late.
 * `redeemVoucherRender`'s retry specs carry the same race's history (CI,
 * 2026-09-16), fixed then by waiting for `aria-disabled` — which narrowed it
 * and could not close it, for the reason above.
 *
 * WHAT THIS DOES. `await act(async () => …)` keeps React's act queue open until
 * it is empty: the tap renders, its effect starts the read, the mocked read
 * answers in microtasks before act's next hop, and the resulting commit AND its
 * passive effects are flushed before `act` resolves. By the time the test's
 * next line runs, the button's DOM and its responder agree. It is the same
 * pattern this suite already uses where a tap starts a read
 * (`upcomingPolicyRender`, `bellRender`, `cardCheckoutRender`).
 *
 * It removes no assertion. Every `waitFor(() => … enabled …)` after a
 * `tapAndSettle` stays — it now passes on its first check instead of racing.
 *
 * WHEN NOT TO USE IT. Where the test asserts the IN-BETWEEN state the tap
 * causes (a skeleton while a read is held open), keep `fireEvent.click`: a read
 * held on an unresolved promise stays held through `act`, but a read that
 * answers at once would be flushed straight past the state being asserted.
 */

import { act, fireEvent } from '@testing-library/react';

export async function tapAndSettle(target: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(target);
  });
}
