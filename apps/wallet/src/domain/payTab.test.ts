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
import { enlargedCodeIsOpen, payTabAction } from './payTab';

/** The shape `GET /members/me/wallet-token` actually answers with. */
const TOKEN: WalletToken = {
  memberId: '8842',
  token: 'wt_9f2c41',
  expiresAt: '2026-08-25T12:00:45.000Z',
  uri: 'avostaff://pay?m=8842&t=wt_9f2c41',
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

/**
 * The gate that does not depend on anyone remembering to ask.
 *
 * Trunk mutated the Pay handler's `if (payTabAction(codeView) === 'enlarge')` to
 * `if (true)` and every test above stayed green — the rule was proven and the
 * link to the button was not. `enlargedCodeIsOpen` is the answer to that: it is
 * the value `QrOverlay`'s `open` prop is given, so §4's suppression is applied
 * at the moment of rendering rather than trusted to a handler.
 *
 * `payTabWiring.test.ts` asserts the prop really is this call. These assert what
 * the call is worth once it is there.
 */
describe('enlargedCodeIsOpen', () => {
  it('opens only when she asked AND there is a code', () => {
    expect(enlargedCodeIsOpen(true, paymentCodeView({ token: TOKEN, unavailable: null }))).toBe(true);
  });

  it('stays shut when she has not asked', () => {
    expect(enlargedCodeIsOpen(false, paymentCodeView({ token: TOKEN, unavailable: null }))).toBe(false);
  });

  it('stays shut with the request set but the code suppressed', () => {
    // THE MUTATION CASE. This is what a handler that skipped `payTabAction`
    // produces: the request flag is true and nothing may be shown. No QR.
    for (const unavailable of ['offline', 'failed'] as const) {
      expect(
        enlargedCodeIsOpen(true, paymentCodeView({ token: null, unavailable })),
        `requested while ${unavailable}`,
      ).toBe(false);
    }
    // And with a token still in memory from before the drop, which is the shape
    // `paymentCode.test.ts` guards for the same reason.
    expect(enlargedCodeIsOpen(true, paymentCodeView({ token: TOKEN, unavailable: 'offline' }))).toBe(false);
  });

  it('stays shut while the token is still in flight', () => {
    expect(enlargedCodeIsOpen(true, paymentCodeView({ token: null, unavailable: null }))).toBe(false);
  });

  it('closes a live overlay in the SAME render the code goes stale', () => {
    /*
      BE PRECISE ABOUT WHAT THIS BUYS, because the driven number invites a
      bigger claim than it supports. A code enlarged over the Shop tab was
      observed closing 13s after the mint started failing; those 13s are the
      wait for the SERVER's expiry to lapse and the retry to fail, and nothing
      here shortens them. What changes is what happens once the app knows: the
      old `useEffect(() => { if (!canEnlarge) setEnlarged(false) })` closed the
      overlay one render LATER, so there was a frame in which a code the app had
      already judged dead was still 246pt on the screen. Derivation removes that
      frame. A frame is not 13 seconds, and it is also exactly the window a
      cashier's scanner samples in.
    */
    const requested = true;
    const live = paymentCodeView({ token: TOKEN, unavailable: null });
    const gone = paymentCodeView({ token: null, unavailable: 'failed' });
    expect(enlargedCodeIsOpen(requested, live)).toBe(true);
    expect(enlargedCodeIsOpen(requested, gone)).toBe(false);
  });

  it('never opens where payTabAction would have refused', () => {
    // The two are the same rule seen from two places; they must not diverge.
    for (const token of [TOKEN, null]) {
      for (const unavailable of ['offline', 'failed', null] as const) {
        const view = paymentCodeView({ token, unavailable });
        expect(
          enlargedCodeIsOpen(true, view),
          `token=${token ? 'held' : 'none'} unavailable=${String(unavailable)}`,
        ).toBe(payTabAction(view) === 'enlarge');
      }
    }
  });
});
