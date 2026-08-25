/**
 * Handing the customer to the payment gateway — the WEB and default
 * implementation.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THERE ARE TWO OF THESE FILES AND METRO PICKS ONE. READ BOTH BEFORE EDITING.
 *
 *   gateway.ts          this file. Web, and any target without a variant. A
 *                       named `window.open`, watched for the tab closing.
 *   gateway.native.ts   iOS and Android. `expo-web-browser`'s
 *                       `openAuthSessionAsync`, which keeps the app mounted.
 *
 * A platform-suffixed file rather than a `Platform.OS` branch, for the reason
 * `screenBoost.ts` and `appReload.ts` give for the same split: a runtime branch
 * would still pull `expo-web-browser` into the web bundle, for a surface that
 * cannot use it and already has `window.open`.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * "Back" is a HINT and nothing more. api-contract.md § TopUpIntent, client rule
 * 1: the return URL is not a result. Everything this module can tell you is
 * "it is probably worth re-reading GET /topups/{id} now" — it cannot and does
 * not tell you whether the payment worked, and it deliberately does not parse a
 * single query parameter out of the return URL beyond noticing that one arrived.
 *
 * WHAT IT *CAN* TELL YOU, AND USED NOT TO, IS WHETHER THE PAGE OPENED AT ALL.
 * That is a different question from "did she pay", it has a definite answer, and
 * the previous version threw it away with `.catch(() => undefined)`. See
 * `domain/gateway.ts` for what that cost.
 */

import { Linking } from 'react-native';
import { classifyOpenFailure, type GatewayHandoff } from '../domain/gateway';

export type { GatewayHandoff, GatewaySession } from '../domain/gateway';

/** How often the web build checks whether the gateway tab has been closed. */
const TAB_WATCH_MS = 400;

export async function openGateway(redirectUrl: string): Promise<GatewayHandoff> {
  const teardown: Array<() => void> = [];
  let settle: () => void = () => undefined;
  const returned = new Promise<void>((resolve) => {
    settle = resolve;
  });

  // A deep link back into the app is the strongest hint on either platform.
  const linkSub = Linking.addEventListener('url', () => settle());
  teardown.push(() => linkSub.remove());

  const dispose = () => {
    while (teardown.length > 0) teardown.pop()?.();
  };

  // A named target rather than a bare _blank so a second Pay in the same
  // attempt reuses the tab instead of stacking gateway windows.
  const tab =
    typeof window === 'undefined'
      ? null
      : window.open(redirectUrl, 'avo-gateway', 'noopener,noreferrer');

  if (tab) {
    const timer = setInterval(() => {
      if (tab.closed) settle();
    }, TAB_WATCH_MS);
    teardown.push(() => clearInterval(timer));
    return { opened: true, session: { returned, dispose } };
  }

  /*
    Popup blocked, or no window at all — a headless render, a webview, a browser
    that refuses a window not opened from a gesture it recognises.

    THE FALLBACK IS KEPT AND THE SWALLOW IS NOT. `Linking.openURL` on web sets
    the location, which usually works where `window.open` was refused, so trying
    it is right. What was wrong was `.catch(() => undefined)`: when the fallback
    ALSO failed, the caller was handed a session that would never settle over a
    page that was never shown.
  */
  try {
    await Linking.openURL(redirectUrl);
    return { opened: true, session: { returned, dispose } };
  } catch (err) {
    dispose();
    const failure = classifyOpenFailure(err);
    // `window.open` returning null is a blocked popup by definition, whatever
    // the fallback's own message happened to say.
    return { ...failure, reason: failure.reason === 'error' ? 'blocked' : failure.reason };
  }
}
