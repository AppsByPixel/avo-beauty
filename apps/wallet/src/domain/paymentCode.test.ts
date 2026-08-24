/**
 * The payment code's three renderings, and the one that is a security question.
 *
 * `canEnlarge` is the whole point of this file. The overlay renders the token
 * BIG, at 246pt, which is the rendering a cashier actually scans — so every path
 * that must not produce a scannable code must also not produce an overlay.
 * Offline is the sharp one: `interaction-spec.md` §4 removes the QR from the
 * screen entirely rather than showing a stale one, and an overlay reachable
 * offline would put it straight back, full-screen.
 */

import { describe, expect, it } from 'vitest';
import type { WalletToken } from '@avo/types';
import { paymentCodeView } from './paymentCode';

/** The shape `GET /members/me/wallet-token` actually answers with. */
const TOKEN: WalletToken = {
  memberId: '8842',
  token: 'wt_9f2c41',
  expiresAt: '2026-08-25T12:00:45.000Z',
  uri: 'avo://pay?m=8842&t=wt_9f2c41',
};

describe('paymentCodeView', () => {
  it('is ready, and only then enlargeable, when the server has issued a token', () => {
    const view = paymentCodeView({ token: TOKEN, unavailable: null });
    expect(view.kind).toBe('ready');
    expect(view.canEnlarge).toBe(true);
    // The overlay renders the SERVER's token. It never re-derives the uri.
    expect(view.kind === 'ready' && view.token).toBe(TOKEN);
  });

  it('cannot be enlarged offline — the QR is not on the screen to enlarge', () => {
    const view = paymentCodeView({ token: null, unavailable: 'offline' });
    expect(view).toEqual({
      kind: 'unavailable',
      reason: 'offline',
      canEnlarge: false,
      canRetry: false,
    });
  });

  it('cannot be enlarged offline even while a token from before the drop is in hand', () => {
    // The regression this guards: `useWalletToken` clears its token when the
    // screen goes offline, so this state should not arise — but "should not
    // arise" is not a control. A token still in memory must not become a
    // full-screen code a cashier scans and the server refuses.
    const view = paymentCodeView({ token: TOKEN, unavailable: 'offline' });
    expect(view.kind).toBe('unavailable');
    expect(view.canEnlarge).toBe(false);
  });

  it('cannot be enlarged when the token mint failed, but offers the retry its copy promises', () => {
    // `qrFailedBody` reads "Try again to show a valid code at the salon." — so
    // there has to be something to tap. `qrOfflineBody` says "Reconnect", which
    // is deliberately not a retry: a token fetch on a dead connection just fails
    // again, and Home already carries the screen-level Try again.
    const view = paymentCodeView({ token: null, unavailable: 'failed' });
    expect(view.kind).toBe('unavailable');
    expect(view.canEnlarge).toBe(false);
    expect(view.kind === 'unavailable' && view.canRetry).toBe(true);
  });

  it('cannot be enlarged while the token is still in flight', () => {
    const view = paymentCodeView({ token: null, unavailable: null });
    expect(view.kind).toBe('pending');
    expect(view.canEnlarge).toBe(false);
  });

  it('never reports canEnlarge without a token to show', () => {
    // The invariant stated once, over every input combination, rather than
    // relying on the five cases above staying exhaustive.
    for (const token of [TOKEN, null]) {
      for (const unavailable of ['offline', 'failed', null] as const) {
        const view = paymentCodeView({ token, unavailable });
        if (view.canEnlarge) {
          expect(view.kind).toBe('ready');
          expect(unavailable).toBeNull();
          expect(token).not.toBeNull();
        }
      }
    }
  });
});
