/**
 * What to do with a URL the OS hands the scanner.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * A URL IS NOT A SCAN, AND CONFLATING THE TWO ACCUSED THE CUSTOMER.
 *
 * `ScanScreen` fed `Linking.getInitialURL()` straight into `accept`:
 *
 *     void Linking.getInitialURL().then((url) => { if (url) accept(url); });
 *
 * `getInitialURL()` is the URL that LAUNCHED the app. `accept` parses, fails,
 * and sets `unreadable` — so the screen said "That isn't an AVO wallet code."
 * with the camera off and nothing ever scanned. Driven on a simulator: the
 * message was already on screen, under the "Allow camera access" button.
 *
 * Under Expo Go it happens every time, because the launch URL is always
 * `exp://…`. A standalone build opened from the home screen gets null and shows
 * nothing — but any launch through a link that is not a payment code (a
 * universal link, a notification tap, an `avo://` route added later) puts a
 * false accusation in front of a staff member holding a customer's phone.
 *
 * THE DISTINCTION. A scan that did not parse deserves the message: somebody
 * pointed the camera at something and it was not a wallet code. A URL that was
 * never a scan deserves silence.
 *
 * THIS FILTERS, IT DOES NOT FORK. Both `Linking` paths still call the SAME
 * `accept` the camera calls, so there is one code path into a charge and no
 * test-only branch beside it — the property `ScanScreen`'s own comment argues
 * for. What changes is that a URL has to look like a payment code before it is
 * treated as one.
 *
 * A pure module rather than an `if` in the effect because the scanner's vitest
 * config is deliberately node-only ("Component and end-to-end testing is lane
 * D's column"), so a rule left inside a `useEffect` is a rule no test in this
 * package can reach — which is how the original shipped.
 *
 * ENVIRONMENT NOTE, so nobody concludes the deep-link path is broken:
 * `avo://pay?…` delivered with `simctl openurl` does NOT route into a project
 * loaded in Expo Go. iOS hands the custom scheme to a standalone shell which
 * then has no JS bundle ("No script URL provided"). Exercising the deep-link
 * charge needs a dev-client or a standalone build. That is the environment, not
 * a defect in this path.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { parsePaymentCode, type PaymentCode } from './paymentCode';

export type LinkAction =
  /** It really is `avo://pay?m=…&t=…`. Charge it, exactly as a scan would. */
  | { kind: 'charge'; code: PaymentCode }
  /** Anything else. Silence — NOT "that isn't an AVO wallet code". */
  | { kind: 'ignore' };

export function deepLinkAction(url: string | null | undefined): LinkAction {
  if (!url) return { kind: 'ignore' };
  const code = parsePaymentCode(url);
  return code ? { kind: 'charge', code } : { kind: 'ignore' };
}
