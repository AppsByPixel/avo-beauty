/**
 * Which of the payment code's three renderings is on screen — and, the reason
 * this is a module rather than three ternaries inside `PaymentCode.tsx`,
 * whether the enlarged overlay may open.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY `canEnlarge` IS A DECISION AND NOT A BOOLEAN PROP.
 *
 * The overlay renders the code at 246pt. That is the rendering a cashier
 * actually scans, so every rule about when a code may be shown applies to it —
 * with more force, not less, than to the 92pt panel inside the card.
 *
 * `interaction-spec.md` §4 removes the QR from the screen entirely when the
 * wallet is offline rather than showing a stale one, because "a code that will
 * not scan is worse than no code: the customer finds out at the counter and it
 * looks like the salon's fault". An overlay reachable from an offline screen
 * would put that code straight back, full-screen — the exact failure, made
 * bigger.
 *
 * This workspace has no renderer (see `domain/names.ts` for the whole argument),
 * so a rule left inline in a component is a rule no test can reach. Here, it is
 * six lines and `paymentCode.test.ts` asserts the invariant over every input
 * combination rather than over a list of cases someone has to keep exhaustive.
 *
 * Non-negotiable #2 is upstream of all of this: nothing in this file mints,
 * extends or re-derives a token. `token` is whatever the server last answered
 * with, and `uri` — the string the QR encodes — is the server's too.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import type { WalletToken } from '@avo/types';

/** Why there is no code to show. Mirrors `useWalletHome`'s failure kinds. */
export type CodeUnavailable = 'offline' | 'failed';

export interface PaymentCodeInput {
  token: WalletToken | null;
  unavailable: CodeUnavailable | null;
}

export type PaymentCodeView =
  | {
      kind: 'unavailable';
      reason: CodeUnavailable;
      canEnlarge: false;
      /**
       * Whether the panel carries a retry control.
       *
       * `failed` does and `offline` does not, and the difference is already
       * written into the copy: `qrFailedBody` is "Try again to show a valid code
       * at the salon" — so there has to be something to tap — while
       * `qrOfflineBody` is "Reconnect to show a valid code at the salon", which
       * is not an instruction to tap anything. A token fetch on a dead
       * connection just fails again, and Home already carries the screen-level
       * "Try again" for the offline case.
       */
      canRetry: boolean;
    }
  | { kind: 'pending'; canEnlarge: false }
  | { kind: 'ready'; token: WalletToken; canEnlarge: true };

/**
 * ORDER MATTERS: `unavailable` is checked before `token`.
 *
 * `useWalletToken` clears its token when the screen goes offline, so a token in
 * hand alongside `unavailable: 'offline'` should not arise. "Should not arise"
 * is not a control — a token still sitting in memory must not be able to become
 * a full-screen code that the server then refuses at the counter.
 */
export function paymentCodeView({ token, unavailable }: PaymentCodeInput): PaymentCodeView {
  if (unavailable) {
    return {
      kind: 'unavailable',
      reason: unavailable,
      canEnlarge: false,
      canRetry: unavailable === 'failed',
    };
  }
  if (!token) return { kind: 'pending', canEnlarge: false };
  return { kind: 'ready', token, canEnlarge: true };
}
