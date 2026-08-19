/**
 * The shop's state: the catalogue, the cart, and one checkout.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE CART IS STATE AND THE BALANCE IS NOT.
 *
 * The balance comes from `useWalletHome`, which is read once in `App.tsx` and
 * handed down — the same reason Book takes it as a prop rather than instantiating
 * its own. Two `useWalletHome()` instances would be two balances and the one on
 * screen would be whichever mounted last. So this hook never fetches a member and
 * never computes a balance: it takes `balanceFils` for the CTA label and calls
 * `onPaid()` after an order so the owner re-reads `GET /members/me`.
 *
 * Non-negotiable #2, precisely: the response to a successful order carries
 * `balanceAfterFils`, and this hook does NOT write it anywhere. It asks the wallet
 * to re-read instead. A client that stored the server's figure would be right
 * today and would be the seam through which a locally-mutated balance arrives
 * later.
 *
 * ONE IDEMPOTENCY KEY PER ATTEMPT, AND ON THIS PATH IT IS THE GUARD.
 * An order has ONE concurrency lock where a charge has two — Lane A removed it and
 * five concurrent orders left the ledger 36000 fils out with every CHECK
 * satisfied. So the key is minted once per cart and reused across retries of the
 * SAME cart: a timed-out POST that actually committed replays instead of debiting
 * twice — driven, and the replay returned the identical transaction with exactly
 * one debit in the table.
 *
 * ⚠️ THIS NOTE PREVIOUSLY MISSTATED WHY THE KEY IS RE-MINTED, and the correction
 * matters because it changes which scenario the re-mint protects. It read: "it is
 * re-minted when the cart CHANGES, because the API answers 422
 * `idempotency_key_reused` for one key with a different body — reusing it would
 * turn a corrected cart into a refusal rather than an order." The 422 is real, but
 * it does NOT apply to a corrected cart after a refusal. Driven, all three cases:
 *
 *   refused, then corrected under the SAME key   → 201. A refusal ROLLS THE
 *       TRANSACTION BACK, so the key was never persisted and is not burned. The
 *       retired-product recovery would have worked without any re-mint.
 *   committed, replayed with the SAME body       → the stored result, one debit.
 *   committed, then a DIFFERENT body             → 422 `idempotency_key_reused`.
 *
 * So the re-mint is load-bearing for the third case only: after an order settles
 * the cart is emptied, she adds something else, and that new cart must not arrive
 * under the key the settled order burned. The mechanism was right; the reason
 * given for it named a scenario that cannot occur. Recorded rather than quietly
 * amended.
 *
 * AND NO RETRY AFFORDANCE ON AN UNKNOWN OUTCOME, for the reason the scanner's
 * charge screen carries at length: a client that could not read the response does
 * not know whether the money moved. `busy` disables the button, the key protects
 * the attempt, and the failure state says what to check rather than offering a tap
 * that could commit a second order.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type Fils } from '@avo/types';
import { ApiError, newIdempotencyKey } from '../api/client';
import { toLoadFailure, type LoadFailure } from '../domain/loadFailure';
// The salon is configuration, not a request — see config/salon.ts.
import { SALON_ID as SALON_FROM_CONFIG } from '../config/salon';
import { getProducts, placeOrder, type OrderResult, type Product } from '../api/shop';
import {
  affordable,
  cartCount,
  cartTotal,
  decrement,
  increment,
  localShortfall,
  pricedLines,
  staleIds,
  toOrderLines,
  type Cart,
  type PricedLine,
} from '../domain/cart';
import { orderRefusal, type CheckoutRefusal } from '../domain/orderRefusal';

/**
 * Re-exported so the screen and the sheet keep importing it from here.
 *
 * It is DECLARED in `domain/orderRefusal.ts` beside the function that produces
 * it: a domain module must not import from `state/`, and the classifier is what
 * defines the union.
 */
export type { CheckoutRefusal };

/** Why the catalogue is not on screen. `off` is the module, not a failure. */
export type ShopStatus = 'loading' | 'ready' | 'off' | 'failed';

export interface ShopState {
  status: ShopStatus;
  /** Null until the catalogue lands. Never an empty array standing in for it. */
  products: Product[] | null;
  /**
   * Populated on a failed load, for the error screen — the KIND included.
   *
   * It used to be the reference alone, and the screen therefore hardcoded
   * `kind="server"`: the one thing the failure screen branches on was the one
   * thing this state threw away. A 403 rendered "We couldn't load your wallet"
   * with a Try again that could only fail again, which is the exact defect
   * `FailureScreen`'s own header warns about. Mirrors `useWalletHome`'s
   * `failure`, which had the shape right from the start.
   */
  failure: LoadFailure | null;
  cart: Cart;
  lines: PricedLine[];
  total: Fils;
  count: number;
  /** Ids in the cart the catalogue no longer has — see `domain/cart.ts`. */
  stale: string[];
  /** LABEL ONLY. The server decides whether she can pay. */
  canAfford: boolean;
  shortfall: Fils;
  busy: boolean;
  refusal: CheckoutRefusal | null;
}

export interface ShopActions {
  retry: () => void;
  add: (productId: string) => void;
  remove: (productId: string) => void;
  clearRefusal: () => void;
  /** Resolves with the order on success, null on any refusal. */
  checkout: () => Promise<OrderResult | null>;
}

/** What the shell owns and the screen renders. */
export type ShopController = ShopState & ShopActions;

export function useShop(balanceFils: number, onPaid: () => void): ShopController {
  const [status, setStatus] = useState<ShopStatus>('loading');
  const [products, setProducts] = useState<Product[] | null>(null);
  const [failure, setFailure] = useState<ShopState['failure']>(null);
  const [cart, setCart] = useState<Cart>({});
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<CheckoutRefusal | null>(null);
  const [reload, setReload] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  // ------------------------------------------------------------- catalogue --
  useEffect(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    /*
      A retry over an existing catalogue must not blank the list. A cold start has
      nothing to keep, so only that goes to `loading`.
    */
    setStatus((prev) => (products === null ? 'loading' : prev));

    getProducts(SALON_FROM_CONFIG, controller.signal)
      .then((items) => {
        if (!aliveRef.current) return;
        setProducts(items);
        setFailure(null);
        setStatus('ready');
      })
      .catch((err: unknown) => {
        if (!aliveRef.current || controller.signal.aborted) return;
        /*
          `shop_not_enabled` is a 409 and is NOT a failure: this salon does not
          sell products, which is a sentence rather than a retry. Everything else
          keeps its reference so the error screen can quote it.
        */
        if (err instanceof ApiError && err.code === 'shop_not_enabled') {
          setStatus('off');
          return;
        }
        /*
          The kind travels with the reference. `forbidden` must reach the screen
          as itself, because that is what suppresses a retry button; flattening
          it to `server` here is what the previous version did.
        */
        setFailure(toLoadFailure(err));
        setStatus('failed');
      });
    // `products` is read only to decide whether to blank; re-running on it would
    // refetch the catalogue every time it arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload]);

  // ------------------------------------------------------------------ cart --
  const lines = useMemo(() => pricedLines(cart, products ?? []), [cart, products]);
  const total = useMemo(() => cartTotal(lines), [lines]);
  const stale = useMemo(() => staleIds(cart, products ?? []), [cart, products]);
  const count = useMemo(() => cartCount(cart), [cart]);
  const canAfford = affordable(total, balanceFils);
  const shortfall = localShortfall(total, balanceFils);

  /**
   * One key per CART. Re-minted whenever the cart changes, because the API answers
   * 422 for one key with a different body — so a key that outlived an edit would
   * refuse the corrected order instead of placing it.
   */
  const cartSignature = useMemo(
    () => toOrderLines(cart, products ?? []).map((l) => `${l.productId}:${l.qty}`).join(','),
    [cart, products],
  );
  const keyRef = useRef<{ signature: string; key: string }>({
    signature: '',
    key: newIdempotencyKey(),
  });
  if (keyRef.current.signature !== cartSignature) {
    keyRef.current = { signature: cartSignature, key: newIdempotencyKey() };
  }

  const add = useCallback((productId: string) => {
    setCart((c) => increment(c, productId));
    setRefusal(null);
  }, []);

  const remove = useCallback((productId: string) => {
    setCart((c) => decrement(c, productId));
    setRefusal(null);
  }, []);

  const clearRefusal = useCallback(() => setRefusal(null), []);

  // -------------------------------------------------------------- checkout --
  const checkout = useCallback(async (): Promise<OrderResult | null> => {
    if (busy) return null;
    const items = toOrderLines(cart, products ?? []);
    if (items.length === 0) return null;

    setBusy(true);
    setRefusal(null);
    try {
      const result = await placeOrder(items, keyRef.current.key);
      /*
        The cart is emptied on success and the wallet re-reads. `balanceAfterFils`
        is deliberately not stored — #2: the balance on screen is the server's
        answer to `GET /members/me`, never a figure this app carried across.
      */
      setCart({});
      onPaid();
      return result;
    } catch (err) {
      /*
        ONE CALL, AND IT USED TO BE FOUR BRANCHES HERE. The classification of a
        refused order — the most consequential mapping in this app after the charge
        — was inline in this catch, where no test could reach it: this workspace
        has no renderer. It is `domain/orderRefusal.ts` now, and the race that
        motivated it is driven and pinned in `orderRefusal.test.ts`.
      */
      setRefusal(orderRefusal(err));
      return null;
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }, [busy, cart, products, onPaid]);

  return {
    status,
    products,
    failure,
    cart,
    lines,
    total,
    count,
    stale,
    canAfford,
    shortfall,
    busy,
    refusal,
    retry: useCallback(() => setReload((n) => n + 1), []),
    add,
    remove,
    clearRefusal,
    checkout,
  };
}
