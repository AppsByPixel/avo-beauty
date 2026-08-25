/**
 * The Pay tab, and the one thing it must never do.
 *
 * design:627 draws a fourth bottom-nav button bound to `openQr` — the same
 * handler as the wallet card's payment-code panel (design:254). Building it
 * means building a SECOND way to put a 246pt QR in front of a cashier, and
 * `interaction-spec.md` §4 is explicit that there are states where no QR may be
 * on the screen at all: "a stale token will fail at the counter and that failure
 * looks like the salon's fault".
 *
 * So the assertion that matters here is a biconditional, not a list of cases:
 * the tab enlarges IF AND ONLY IF `paymentCodeView` says the code may be
 * enlarged. Anything weaker leaves room for the two to drift apart, and the
 * drift would only show up on a phone with no signal at a salon counter.
 */

import { describe, expect, it } from 'vitest';
import type { WalletToken } from '@avo/types';
import { paymentCodeView } from './paymentCode';
import { payTabAction } from './payTab';

/** The shape `GET /members/me/wallet-token` actually answers with. */
const TOKEN: WalletToken = {
  memberId: '8842',
  token: 'wt_9f2c41',
  expiresAt: '2026-08-25T12:00:45.000Z',
  uri: 'avo://pay?m=8842&t=wt_9f2c41',
};

describe('payTabAction', () => {
  it('enlarges the code the server issued', () => {
    expect(payTabAction(paymentCodeView({ token: TOKEN, unavailable: null }))).toBe('enlarge');
  });

  it('does NOT enlarge offline — §4 takes the QR off the screen', () => {
    expect(payTabAction(paymentCodeView({ token: null, unavailable: 'offline' }))).toBe('home');
  });

  it('does NOT enlarge offline even with a token from before the drop still in hand', () => {
    // The sharp case. `useWalletToken` clears on the drop, so this should not
    // arise — but the tab is reachable from Shop and Book, where nothing else
    // on screen would tell her the code is stale.
    expect(payTabAction(paymentCodeView({ token: TOKEN, unavailable: 'offline' }))).toBe('home');
  });

  it('does NOT enlarge when the mint failed', () => {
    expect(payTabAction(paymentCodeView({ token: null, unavailable: 'failed' }))).toBe('home');
  });

  it('does NOT enlarge while the token is still in flight', () => {
    // Reached by tapping Pay the instant Home mounts, and every time the tab is
    // pressed from Shop or Book before the first mint lands.
    expect(payTabAction(paymentCodeView({ token: null, unavailable: null }))).toBe('home');
  });

  it('enlarges if and only if the payment-code rule allows it', () => {
    // The invariant, over every shape `PaymentCodeView` can take, rather than
    // over the five cases above staying exhaustive. This is the guard: the Pay
    // tab cannot acquire an opinion of its own about when a QR may be shown.
    for (const token of [TOKEN, null]) {
      for (const unavailable of ['offline', 'failed', null] as const) {
        const view = paymentCodeView({ token, unavailable });
        expect(
          payTabAction(view) === 'enlarge',
          `token=${token ? 'held' : 'none'} unavailable=${String(unavailable)}`,
        ).toBe(view.canEnlarge);
      }
    }
  });

  it('falls back to Home rather than to nothing, so the reason is on screen', () => {
    // Home is the only screen carrying qrOfflineTitle/qrFailedTitle. A dead tap
    // would leave a customer at a counter with no explanation for a button the
    // design draws as always available.
    for (const unavailable of ['offline', 'failed'] as const) {
      expect(payTabAction(paymentCodeView({ token: null, unavailable }))).toBe('home');
    }
  });
});
