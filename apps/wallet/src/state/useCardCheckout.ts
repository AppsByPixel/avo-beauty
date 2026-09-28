/**
 * Paying for the basket by KNET, card or Apple Pay in ONE step — client ask W2.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT ALREADY EXISTED, AND WHAT THIS ADDS BESIDE IT.
 *
 * The wallet path (`useShop.checkout` → `POST /orders`) is untouched. It already
 * offered a card, but only AFTER a "balance too low" refusal: top up a tile,
 * come back, press Pay again — two payments' worth of taps, and invisible when
 * her balance was enough. This hook is the one-step path lane A built:
 * `POST /orders/payments` opens a payment sized to the order total, and the
 * SERVER places the order when the money lands.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE RULES THAT MAKE IT SAFE, AND WHERE EACH IS ENFORCED.
 *
 *  #4  THE KEY IS DERIVED FROM THE BASKET — `domain/cardCheckout § keyForBasket`.
 *      Held across every retry, double tap and resume of the same basket;
 *      re-minted only for a different basket or after the attempt ENDED.
 *
 *  #2  THE OUTCOME IS `GET /orders/payments/{id}` — after the POST, before any
 *      payment page is opened, and after every return. Never the redirect, never
 *      the POST's body (a replayed POST answers a stale `awaiting_payment`).
 *
 *      AND NO PAYMENT PAGE FOR AN INTENT THE BANK ALREADY HAS. The page is
 *      opened only while the intent is `created` or `redirected`. `pending`
 *      means the bank is deciding: showing the page again invites a second
 *      attempt at a payment already in flight.
 *
 *  ONE OPEN ATTEMPT PER BASKET. While an attempt has not ended (she closed the
 *      browser, or the bank said pending), `openAttempt` is true and the cart
 *      holds BOTH pay buttons — the wallet's too. Paying from the balance beside
 *      a card payment that may still land is the double charge by another door.
 *      "Check the payment" re-reads the same intent; it never opens a new one.
 *
 *  THE RACE. `refused` means PAID AND CREDITED, order not placed. The balance is
 *      re-read (the money landed), the basket is KEPT (she can now pay from the
 *      balance), and the sheet says where the money is and why, from the CODE.
 *
 *  A START THAT FAILED MOVED NO MONEY — unlike a wallet order, where an unread
 *      response might be a settled debit. On this path money moves only on the
 *      bank's page, which she has not seen, so "Nothing was charged" is true and
 *      the retry is safe: same basket, same key, so a POST that did commit
 *      replays its one intent.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PaymentMethod } from '@avo/types';
import { ApiError, newIdempotencyKey } from '../api/client';
import {
  createOrderPayment,
  getOrderPayment,
  type OrderPaymentView,
} from '../api/orderPayments';
import type { CartLine, OrderResult } from '../api/shop';
import { openGateway } from '../platform/gateway';
import { gatewayOpenLog } from '../domain/gateway';
import { toLoadFailure, type LoadFailure } from '../domain/loadFailure';
import { KEY_REUSED, orderRefusal, type CheckoutRefusal } from '../domain/orderRefusal';
import { basketSignature, cardOutcome, keyForBasket, type BasketKey } from '../domain/cardCheckout';
import type { FulfilmentBody } from '../domain/fulfilment';

export type CardMethod = Exclude<PaymentMethod, 'wallet'>;

export type CardStage =
  | { name: 'closed' }
  /** POST in flight. No intent yet. */
  | { name: 'starting'; method: CardMethod }
  /** The POST failed or its answer was lost. Nothing charged; retry is safe. */
  | { name: 'startFailed'; method: CardMethod; failure: LoadFailure }
  /** 422 under the held key: an attempt for this basket is already open. */
  | { name: 'attemptOpen' }
  /** Reading the authoritative GET. */
  | { name: 'checking' }
  /** At the bank. NOT DISMISSIBLE — interaction-spec.md §2, as the top-up's. */
  | { name: 'redirect'; view: OrderPaymentView }
  /** The payment page would not open. The intent is real and unpaid. */
  | { name: 'gatewayFailed'; view: OrderPaymentView }
  /** A terminal outcome that is not `placed`, or `pending`. */
  | { name: 'result'; view: OrderPaymentView; outcome: 'refused' | 'declined' | 'cancelled' | 'pending' };

export interface CardCheckoutController {
  stage: CardStage;
  /** An attempt for this basket has not ended. Both pay buttons are held. */
  openAttempt: boolean;
  pay: (method: CardMethod) => void;
  /** Re-read the open attempt — "Check the payment". Never a new intent. */
  check: () => void;
  retryStart: () => void;
  retryOpen: () => void;
  /** After a decline or a cancel only. A new attempt, so a new key. */
  tryAgain: () => void;
  close: () => void;
}

export interface CardCheckoutOptions {
  /** The basket's `{ productId, qty }` lines — `useShop.orderLines`. */
  lines: CartLine[];
  /**
   * `fulfilmentBody(choice, branches)` — `useShop.orderFulfilment` — read at
   * call time and NOT part of the key. Carries `pickupBranchId` for a pickup at
   * a multi-branch salon (W7); see `domain/cardCheckout` for why a branch
   * changed under a held key is a 422 and not a new key.
   */
  fulfilment: () => FulfilmentBody;
  /** `placed` — the server's receipt, for the invoice. */
  onPlaced: (result: OrderResult | null) => void;
  /** `refused` — the money is in her wallet; re-read the balance. */
  onCredited: () => void;
  /** A pre-flight refusal the cart already has a chip for. */
  onRefused: (refusal: CheckoutRefusal) => void;
  /** Test seam only. */
  timing?: { firstPollMs: number; pollMs: number };
}

const FIRST_POLL_MS = 1500;
const POLL_MS = 2000;
/** The top-up's bounds, for the top-up's reasons (`useTopUp`). */
const MAX_READ_FAILURES = 6;
const MAX_READS_AFTER_RETURN = 30;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The refusals the card PRE-FLIGHT can answer that the cart already has a
 * sentence for. All are made inside `createOrderPayment`'s transaction before
 * the gateway is asked for anything, so nothing was charged and the key is not
 * burned. The three pickup-branch kinds are W7's: `quoteOrder` resolves the
 * branch before the card is charged, so a closed branch is refused HERE rather
 * than after she has paid — and must read as the cart's "that branch has
 * closed", not as "we couldn't start the payment".
 */
const PREFLIGHT_REFUSALS: ReadonlySet<CheckoutRefusal['kind']> = new Set([
  'stale',
  'noAddress',
  'addressGone',
  'pickupRequired',
  'pickupUnknown',
  'pickupClosed',
]);

/** Whether the bank page may be shown for this view. See the header, #2. */
function pageMayOpen(view: OrderPaymentView): boolean {
  return view.intent.status === 'created' || view.intent.status === 'redirected';
}

export function useCardCheckout(options: CardCheckoutOptions): CardCheckoutController {
  const [stage, setStage] = useState<CardStage>({ name: 'closed' });
  const [openIntentId, setOpenIntentId] = useState<string | null>(null);

  const opts = useRef(options);
  opts.current = options;
  const keyRef = useRef<BasketKey | null>(null);
  const attempt = useRef(0);
  const mounted = useRef(true);
  /*
    The stage, readable from a callback. The retry actions below read it here
    rather than inside a `setStage` updater: an updater must be pure (React may
    run it twice), and a payment started from one would be two POSTs.
  */
  const stageRef = useRef(stage);
  stageRef.current = stage;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      attempt.current += 1;
    };
  }, []);

  /** The attempt under the held key is over — the next pay gets a new key. */
  const spend = () => {
    if (keyRef.current) keyRef.current = { ...keyRef.current, spent: true };
    setOpenIntentId(null);
  };

  const finish = useCallback((view: OrderPaymentView) => {
    const outcome = cardOutcome(view);
    if (outcome === 'awaiting') {
      // Not over. The key and the open attempt are HELD.
      setStage({ name: 'result', view, outcome: 'pending' });
      return;
    }
    spend();
    if (outcome === 'placed') {
      setStage({ name: 'closed' });
      opts.current.onPlaced(view.order.result);
      return;
    }
    if (outcome === 'refused') opts.current.onCredited();
    setStage({ name: 'result', view, outcome });
  }, []);

  /**
   * From an intent id to an outcome: READ FIRST, open the page only if the
   * read says it may, then poll the GET until it says something terminal.
   */
  const settle = useCallback(
    async (intentId: string, fallback: OrderPaymentView | null) => {
      const mine = (attempt.current += 1);
      const live = () => mounted.current && mine === attempt.current;
      const timing = opts.current.timing ?? { firstPollMs: FIRST_POLL_MS, pollMs: POLL_MS };
      setStage({ name: 'checking' });

      let view: OrderPaymentView;
      try {
        view = await getOrderPayment(intentId);
      } catch {
        if (!live()) return;
        // We cannot see the answer. That is "we do not know yet" — pending,
        // with no retry that could pay twice — never a failure.
        if (fallback) setStage({ name: 'result', view: fallback, outcome: 'pending' });
        else setStage({ name: 'attemptOpen' });
        return;
      }
      if (!live()) return;
      if (cardOutcome(view) !== 'awaiting' || !pageMayOpen(view)) {
        finish(view);
        return;
      }

      setStage({ name: 'redirect', view });
      const handoff = await openGateway(view.intent.redirectUrl);
      if (!live()) return;
      if (!handoff.opened) {
        // eslint-disable-next-line no-console
        console.warn(gatewayOpenLog(view.intent.id, handoff));
        setStage({ name: 'gatewayFailed', view });
        return;
      }

      const session = handoff.session;
      let hinted = false;
      let failures = 0;
      let afterReturn = 0;
      let delay = timing.firstPollMs;
      try {
        for (;;) {
          if (hinted) await sleep(delay);
          else
            await Promise.race([
              sleep(delay),
              session.returned.then(() => {
                hinted = true;
              }),
            ]);
          if (!live()) return;
          try {
            const fresh = await getOrderPayment(intentId);
            if (!live()) return;
            failures = 0;
            view = fresh;
            if (cardOutcome(fresh) !== 'awaiting') {
              finish(fresh);
              return;
            }
            if (hinted && (afterReturn += 1) >= MAX_READS_AFTER_RETURN) {
              finish(fresh); // still awaiting → pending, attempt held
              return;
            }
          } catch {
            if (!live()) return;
            if ((failures += 1) >= MAX_READ_FAILURES) {
              setStage({ name: 'result', view, outcome: 'pending' });
              return;
            }
          }
          delay = timing.pollMs;
        }
      } finally {
        session.dispose();
      }
    },
    [finish],
  );

  const pay = useCallback(
    (method: CardMethod) => {
      if (openIntentId !== null) {
        void settle(openIntentId, null);
        return;
      }
      const { lines, fulfilment } = opts.current;
      if (lines.length === 0) return;
      keyRef.current = keyForBasket(keyRef.current, basketSignature(lines), newIdempotencyKey);
      const key = keyRef.current.key;
      const mine = (attempt.current += 1);
      setStage({ name: 'starting', method });

      void (async () => {
        let view: OrderPaymentView;
        try {
          view = await createOrderPayment(lines, method, fulfilment(), key);
        } catch (err) {
          if (!mounted.current || mine !== attempt.current) return;
          if (err instanceof ApiError && err.code === KEY_REUSED) {
            setStage({ name: 'attemptOpen' });
            return;
          }
          /*
            A PRE-FLIGHT REFUSAL is the wallet path's own refusal (the same
            parser, the same codes) made BEFORE the bank was asked for anything.
            The cart already has the sentence for each; the key is not burned,
            because a refusal rolls the transaction back.
          */
          const refusal = orderRefusal(err);
          if (PREFLIGHT_REFUSALS.has(refusal.kind)) {
            opts.current.onRefused(refusal);
            setStage({ name: 'closed' });
            return;
          }
          setStage({ name: 'startFailed', method, failure: toLoadFailure(err) });
          return;
        }
        if (!mounted.current || mine !== attempt.current) return;
        setOpenIntentId(view.intent.id);
        void settle(view.intent.id, view);
      })();
    },
    [openIntentId, settle],
  );

  const check = useCallback(() => {
    if (openIntentId !== null) void settle(openIntentId, null);
  }, [openIntentId, settle]);

  const retryStart = useCallback(() => {
    const s = stageRef.current;
    // Same basket, same (unspent) key — a POST that did commit replays.
    if (s.name === 'startFailed') pay(s.method);
  }, [pay]);

  const retryOpen = useCallback(() => {
    const s = stageRef.current;
    // The SAME intent. Nothing was charged, so there is nothing to re-create.
    if (s.name === 'gatewayFailed') void settle(s.view.intent.id, s.view);
  }, [settle]);

  const tryAgain = useCallback(() => {
    const s = stageRef.current;
    if (s.name !== 'result' || (s.outcome !== 'declined' && s.outcome !== 'cancelled')) return;
    // The attempt ENDED, so its key is spent and this is a new attempt.
    pay(s.view.intent.method as CardMethod);
  }, [pay]);

  const close = useCallback(() => {
    setStage((s) => {
      // The bank page is up: closing would strand a live payment.
      if (s.name === 'redirect') return s;
      attempt.current += 1;
      return { name: 'closed' };
    });
  }, []);

  return {
    stage,
    openAttempt: openIntentId !== null,
    pay,
    check,
    retryStart,
    retryOpen,
    tryAgain,
    close,
  };
}
