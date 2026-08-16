/**
 * Handing the customer to the payment gateway, and noticing when she is back.
 *
 * "Back" is a HINT and nothing more. api-contract.md § TopUpIntent, client rule
 * 1: the return URL is not a result. Everything this module can tell you is
 * "it is probably worth re-reading GET /topups/{id} now" — it cannot and does
 * not tell you whether the payment worked, and it deliberately does not parse a
 * single query parameter out of the return URL beyond noticing that one arrived.
 *
 * PLATFORM NOTE (deviation, reported): native opens the gateway with core
 * `Linking.openURL`, which leaves the app. The right production choice is an
 * in-app browser session (`expo-web-browser`'s `openAuthSessionAsync`), which
 * keeps the app mounted and resolves on return. Adding it means a new dependency
 * and therefore a change to the root pnpm-lock.yaml, which is outside this lane's
 * column, so it is reported rather than taken. The polling below is what makes
 * the flow correct in the meantime, and it is what makes it correct afterwards
 * too — an in-app browser would only shorten the wait.
 */

import { AppState, Linking, Platform } from 'react-native';

export interface GatewaySession {
  /**
   * Resolves the first time it looks as though the customer has come back:
   * the gateway tab closed, the app returned to the foreground, or a
   * `avo://topup/return?...` deep link fired. One-shot.
   */
  returned: Promise<void>;
  /** Stop watching. Safe to call more than once. */
  dispose(): void;
}

/** How often the web build checks whether the gateway tab has been closed. */
const TAB_WATCH_MS = 400;

export function openGateway(redirectUrl: string): GatewaySession {
  const teardown: Array<() => void> = [];
  let settle: () => void = () => undefined;
  const returned = new Promise<void>((resolve) => {
    settle = resolve;
  });

  // A deep link back into the app is the strongest hint on either platform.
  const linkSub = Linking.addEventListener('url', () => settle());
  teardown.push(() => linkSub.remove());

  if (Platform.OS === 'web') {
    // A named target rather than a bare _blank so a second Pay in the same
    // attempt reuses the tab instead of stacking gateway windows.
    const tab =
      typeof window === 'undefined'
        ? null
        : window.open(redirectUrl, 'avo-gateway', 'noopener,noreferrer');

    if (!tab) {
      // Popup blocked, or no window at all. Nothing to watch; the poll in
      // useTopUp is the fallback and it is sufficient on its own.
      void Linking.openURL(redirectUrl).catch(() => undefined);
    } else {
      const timer = setInterval(() => {
        if (tab.closed) settle();
      }, TAB_WATCH_MS);
      teardown.push(() => clearInterval(timer));
    }
  } else {
    void Linking.openURL(redirectUrl).catch(() => undefined);
    const appSub = AppState.addEventListener('change', (next) => {
      if (next === 'active') settle();
    });
    teardown.push(() => appSub.remove());
  }

  return {
    returned,
    dispose() {
      while (teardown.length > 0) teardown.pop()?.();
    },
  };
}
