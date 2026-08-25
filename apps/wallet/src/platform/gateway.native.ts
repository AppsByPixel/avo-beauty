/**
 * Handing the customer to the payment gateway — iOS and Android.
 *
 * Metro resolves this file over `gateway.ts` on native. See that file's header
 * for why the split is a platform-suffixed module rather than a `Platform.OS`
 * branch, and for the rule that "back" is a hint and never a result.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * `openAuthSessionAsync`, NOT `Linking.openURL`.
 *
 * `Linking.openURL` LEAVES THE APP. It hands the URL to the OS, Safari or Chrome
 * takes over as a separate application, and the wallet is backgrounded mid
 * payment — which on a memory-pressured phone means it can be killed outright
 * while her money is at the bank. The previous version of this file recorded that
 * as a deviation and named this function as the fix; the fix was declined only
 * because it meant a dependency, and that objection expired when trunk landed
 * `expo-brightness` and `expo-updates` in this same app.
 *
 * The second reason is the one that matters more for correctness. `openURL`
 * returns as soon as the OS accepts the URL, so the only way to notice her
 * coming back was to watch `AppState` for a foreground transition and hope the
 * deep link listener fired. `openAuthSessionAsync` RESOLVES WITH A RESULT: the
 * session ends and we are told how. The return leg stops depending on a listener
 * that the OS may swallow.
 *
 * The redirect we hand it is `avo://topup/return`, which is what the API already
 * puts in the intent's `return=` parameter (env.ts § TOPUP_RETURN_URL). Prefix
 * matching means the `?intent=TI-…` the gateway appends still matches. We do NOT
 * read that parameter — client rule 1 — we only note that the session ended.
 *
 * EXPECT A SYSTEM CONSENT ALERT ON iOS. `ASWebAuthenticationSession` asks
 * "«AVO Wallet» Wants to Use «…» to Sign In" before the page appears, because it
 * shares cookies with Safari. It is the OS, not us, and it is the price of
 * getting a result back instead of a guess. Driven on a simulator: the alert
 * appears once per session and the page is behind it.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { Linking } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { classifyOpenFailure, unsupportedScheme, type GatewayHandoff } from '../domain/gateway';

export type { GatewayHandoff, GatewaySession } from '../domain/gateway';

/**
 * The scheme-and-path the gateway returns to. `app.json` § expo.scheme is `avo`;
 * `TOPUP_RETURN_URL` defaults to exactly this string on the API side.
 */
const RETURN_URL = 'avo://topup/return';

/**
 * How long to wait for the session to fail before reporting that it opened.
 *
 * `openAuthSessionAsync` does not resolve until the session ENDS, so there is no
 * "it is now on screen" signal to wait for. What there is, is a prompt failure:
 * a rejection, or a `locked` result, both of which arrive in milliseconds. So we
 * give the failure a moment to show up and otherwise treat the page as open.
 *
 * A human cannot dismiss a sheet inside this window, so a `cancel` that arrives
 * within it is still a real cancel and is treated as a return, not as a failure.
 */
const OPEN_GRACE_MS = 400;

type Settled =
  | { kind: 'result'; result: WebBrowser.WebBrowserAuthSessionResult }
  | { kind: 'threw'; err: unknown }
  | { kind: 'pending' };

export async function openGateway(redirectUrl: string): Promise<GatewayHandoff> {
  const teardown: Array<() => void> = [];
  let settle: () => void = () => undefined;
  const returned = new Promise<void>((resolve) => {
    settle = resolve;
  });

  // The deep link is kept as a SECOND hint rather than replaced by the session
  // result. Android can deliver the intent to the app before the custom tab
  // finishes tearing down, and either one arriving first is fine.
  const linkSub = Linking.addEventListener('url', () => settle());
  teardown.push(() => linkSub.remove());

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    while (teardown.length > 0) teardown.pop()?.();
    // If the sheet is somehow still up — the poll reached a terminal status
    // while she was looking at the bank's "done" page — take it down rather than
    // leaving her tapping Close over a settled payment.
    try {
      WebBrowser.dismissAuthSession();
    } catch {
      // Nothing was presented. Not a failure, and not worth a line.
    }
  };

  /*
    BEFORE THE CALL, NOT AROUND IT. `ASWebAuthenticationSession` raises an
    Objective-C `NSInvalidArgumentException` for a non-http(s) URL, which kills
    the process — a `try` here would never run. See `unsupportedScheme`.
  */
  const refused = unsupportedScheme(redirectUrl);
  if (refused) {
    dispose();
    return refused;
  }

  const session = WebBrowser.openAuthSessionAsync(redirectUrl, RETURN_URL);

  const settled: Settled = await Promise.race([
    session.then(
      (result): Settled => ({ kind: 'result', result }),
      (err): Settled => ({ kind: 'threw', err }),
    ),
    new Promise<Settled>((resolve) => {
      const timer = setTimeout(() => resolve({ kind: 'pending' }), OPEN_GRACE_MS);
      teardown.push(() => clearTimeout(timer));
    }),
  ]);

  if (settled.kind === 'threw') {
    dispose();
    return classifyOpenFailure(settled.err);
  }

  /*
    `locked` is Android's answer when another auth session is already presented.
    It is a FAILED OPEN wearing a success-shaped return value — the one case where
    a resolved promise means the page was never shown — so it is named here rather
    than counted as a return hint.
  */
  if (settled.kind === 'result' && settled.result.type === 'locked') {
    dispose();
    return {
      opened: false,
      reason: 'busy',
      detail: 'expo-web-browser: an auth session is already presented (locked)',
    };
  }

  // Anything else means the page was put in front of her. Either it has already
  // ended (a fast cancel, or a redirect that beat the grace window) or it is
  // still up; both make `session` the return hint.
  if (settled.kind === 'result') settle();
  void session.then(
    () => settle(),
    (err) => {
      // A rejection after we have already reported "opened" cannot un-open the
      // page, so it is not a failure state — but it is not nothing either, and
      // the whole point of this rewrite is that it does not vanish.
      // eslint-disable-next-line no-console
      console.warn('[avo] the gateway session ended in an error', err);
      settle();
    },
  );

  return { opened: true, session: { returned, dispose } };
}
