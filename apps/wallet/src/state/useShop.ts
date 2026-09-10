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
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE KEY IS KEYED ON THE CART, AND DELIVERY MUST NOT CHANGE THAT.
 *
 * This is the one correctness decision the delivery slice added here, and it
 * goes against the obvious reading of the API's own comment, so it is written
 * down at length.
 *
 * `routes/orders.ts` hashes `{items, fulfilment, addressId}` and says: "FULFILMENT
 * IS IN THE HASH. Two different destinations under one key is a 422 rather than a
 * replay of the first — a client that retried a pickup as a delivery meant
 * something different, and replaying the pickup would hand her a 'delivered'
 * order that is sitting on a counter." That is right, and it describes the
 * SERVER's job.
 *
 * The tempting client move is to mirror it: put the fulfilment into
 * `cartSignature` so a changed destination mints a fresh key. THAT IS A DOUBLE
 * CHARGE. Walk the case the states brief names — she taps Pay as a pickup, the
 * response never arrives (offline, timeout), she switches to delivery and taps
 * again:
 *
 *   fulfilment NOT in the signature — SAME key.
 *       the first attempt COMMITTED  → 422 `idempotency_key_reused`. She is told
 *           the order was already placed. ONE debit. Correct.
 *       the first attempt ROLLED BACK → the key was never persisted, so it is
 *           not burned; the delivery order is placed at 201. ONE debit. Correct.
 *
 *   fulfilment IN the signature — NEW key.
 *       the first attempt COMMITTED  → a second, unrelated key, a second order,
 *           A SECOND DEBIT. Her cart was never emptied because she never saw the
 *           first response, so she is charged twice for one basket.
 *
 * So the signature stays `productId:qty` only. The 422 is not a defect to be
 * engineered around — it is the guard reporting a genuinely ambiguous retry, and
 * `orderRefusal` classifies it as `alreadyPlaced` precisely so the sheet can say
 * "your order was placed" instead of "nothing was charged".
 *
 * The re-mint on a CART change is unaffected and still load-bearing for its one
 * case: after an order settles the cart is emptied, she adds something else, and
 * that new cart must not arrive under the key the settled order burned.
 *
 * `fulfilmentBody(choice)` is therefore read at CALL TIME rather than folded into
 * the key, and pickup contributes no keys at all — see `domain/fulfilment.ts`.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type Fils } from '@avo/types';
import { ApiError, newIdempotencyKey, type FailureKind } from '../api/client';
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
import {
  checkoutBlock,
  fulfilmentBody,
  PICKUP,
  reconcileChoice,
  type CheckoutBlock,
  type Fulfilment,
  type FulfilmentChoice,
} from '../domain/fulfilment';

/**
 * Re-exported so the screen and the sheet keep importing it from here.
 *
 * It is DECLARED in `domain/orderRefusal.ts` beside the function that produces
 * it: a domain module must not import from `state/`, and the classifier is what
 * defines the union.
 */
export type { CheckoutRefusal };

/**
 * Why the catalogue is or is not on screen. `off` is the module, not a failure.
 *
 * `stale` AND `offline` ARE NEW, AND THEY ARE THE FOUR-STATE RULE THIS HOOK WAS
 * MISSING. The catch below set `failed` unconditionally, and `ShopScreen`
 * renders a full-page `FailureScreen` for `failed` — so a refresh that failed
 * over a catalogue already on screen would REPLACE it, which is one of the four
 * failures interaction-spec.md §4 names outright: "Network failure keeps the
 * last-known data visible with a stale banner rather than blanking."
 *
 * It was latent rather than live — `retry` is only reachable FROM the failure
 * screen, so there was no path to a refresh over data. That is not a reason to
 * leave it: the next slice that adds pull-to-refresh, a focus refetch or a
 * post-order reload makes it reachable, and nothing would fail when it did.
 * `useWalletHome` and `useAccount` have had `statusForFailure(kind, hasData)`
 * from the start; this is the same function for the same reason.
 */
export type ShopStatus = 'loading' | 'ready' | 'off' | 'stale' | 'offline' | 'failed';

/**
 * Which status a failure produces, given whether anything is already on screen.
 *
 * Exported and pure so it has a spec — the two hooks that got this right keep it
 * private, and the one that got it wrong is the one nothing could test.
 *
 *   no data  → `failed`, the cold failure screen; there is nothing to keep.
 *   data     → `stale` / `offline`, the catalogue plus a banner saying so.
 *
 * `forbidden` is `failed` in BOTH cases, deliberately, and it is the one place
 * this differs from a plain "keep what we have". A 403 means she may not see
 * this catalogue; continuing to render rows she has just been refused — priced,
 * tappable, addable to a cart — would be the UI overriding the server's answer.
 * Non-negotiable #7 makes the server the control, and the honest screen for a
 * refusal is the refusal.
 */
export function shopStatusForFailure(kind: FailureKind, hasData: boolean): ShopStatus {
  if (kind === 'forbidden') return 'failed';
  if (!hasData) return 'failed';
  return kind === 'offline' ? 'offline' : 'stale';
}

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
  /** Epoch ms the catalogue on screen was read. Null before the first success. */
  fetchedAt: number | null;
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
  /**
   * Collect or deliver, and the address a delivery names.
   *
   * IT IS NOT DERIVED FROM THE ADDRESS BOOK. A customer with one saved address
   * is not thereby choosing delivery — pickup is a live fork and the default —
   * and auto-selecting delivery because she happens to have an address would
   * decide the thing this control exists to ask.
   */
  fulfilment: FulfilmentChoice;
  /**
   * Why Pay cannot be tapped yet, or null. Today the only value is `noAddress`.
   * A COURTESY, not a control: the server refuses the same case by name and #7
   * makes that the authority.
   */
  block: CheckoutBlock | null;
}

export interface ShopActions {
  retry: () => void;
  add: (productId: string) => void;
  remove: (productId: string) => void;
  clearRefusal: () => void;
  /**
   * Switch between collecting and delivering.
   *
   * Switching to PICKUP KEEPS the chosen address in state rather than clearing
   * it, so flipping back does not lose her selection — and it is safe because
   * `fulfilmentBody` drops the address on the pickup path by construction, which
   * is what stops `address_not_for_pickup` reaching the wire.
   */
  setFulfilment: (mode: Fulfilment) => void;
  /** Choose which saved address a delivery goes to. */
  chooseAddress: (addressId: string) => void;
  /**
   * Re-resolve the selection against the ids that still exist, after the
   * address book has been read or written. See `reconcileChoice` — a selection
   * pointing at a deleted row loses the selection and NEVER falls back to
   * another address.
   */
  reconcileAddresses: (addressIds: readonly string[]) => void;
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
  const [fulfilment, setChoice] = useState<FulfilmentChoice>(PICKUP);
  const [reload, setReload] = useState(0);
  /** When the catalogue on screen was read, for the stale banner's stamp. */
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);

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
        setFetchedAt(Date.now());
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
        const failure = toLoadFailure(err);
        setFailure(failure);
        // Stale, not blank — see `shopStatusForFailure`. `products` is read from
        // the closure the same way the `loading` guard above reads it.
        setStatus(shopStatusForFailure(failure.kind, products !== null));
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

  // ------------------------------------------------------------ fulfilment --
  const setFulfilment = useCallback((mode: Fulfilment) => {
    // The address is KEPT across a switch to pickup — see `ShopActions`.
    setChoice((c) => ({ mode, addressId: c.addressId }));
    setRefusal(null);
  }, []);

  const chooseAddress = useCallback((addressId: string) => {
    /*
      Choosing an address IMPLIES delivery, and this is the one place a mode is
      set as a side effect. It is not the auto-selection the state interface
      warns against: that would be inferring her intent from the mere EXISTENCE
      of a saved address. Here she has tapped a specific address inside the
      delivery section, which is an act of choosing, and leaving the mode on
      pickup would drop what she just did.
    */
    setChoice({ mode: 'delivery', addressId });
    setRefusal(null);
  }, []);

  const reconcileAddresses = useCallback((addressIds: readonly string[]) => {
    setChoice((c) => {
      const next = reconcileChoice(c, addressIds);
      // Identity is preserved when nothing changed, so this never re-renders on
      // every refetch of an unchanged book.
      return next.addressId === c.addressId && next.mode === c.mode ? c : next;
    });
  }, []);

  // -------------------------------------------------------------- checkout --
  const checkout = useCallback(async (): Promise<OrderResult | null> => {
    if (busy) return null;
    const items = toOrderLines(cart, products ?? []);
    if (items.length === 0) return null;
    /*
      Delivery with no address is not submittable. The sheet disables the button
      on the same predicate, and this is the second gate rather than the first —
      `checkout` is reachable from a caller that did not read `block`, and the
      honest failure of an unsubmittable form is not sending it.

      It sets the refusal the SERVER would have set, so the sentence she reads is
      the same either way.
    */
    if (checkoutBlock(fulfilment) === 'noAddress') {
      setRefusal({ kind: 'noAddress' });
      return null;
    }

    setBusy(true);
    setRefusal(null);
    try {
      /*
        The key comes from the cart signature ONLY. `fulfilmentBody` is read here,
        at call time, and deliberately does not feed the key — see the header §
        THE KEY IS KEYED ON THE CART, which walks the double-charge this prevents.
      */
      const result = await placeOrder(items, keyRef.current.key, fulfilmentBody(fulfilment));
      /*
        The cart is emptied on success and the wallet re-reads. `balanceAfterFils`
        is deliberately not stored — #2: the balance on screen is the server's
        answer to `GET /members/me`, never a figure this app carried across.
      */
      setCart({});
      /*
        THE FULFILMENT CHOICE IS RESET WITH THE CART. Her next order is a new
        decision, and leaving `delivery` selected would carry a destination across
        a purchase boundary — so the next cart would open already committed to an
        address she chose for a different basket.

        The cart and the choice are cleared TOGETHER for the idempotency key's
        sake as well: the key is re-minted on the cart signature change, and a
        cleared cart with a retained delivery choice would be a fresh key over a
        stale destination.
      */
      setChoice(PICKUP);
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
    /*
      THE CART IS NOT CLEARED ON A REFUSAL, and that is the states brief's "a
      failed order leaving her cart intact". It falls out of the structure —
      `setCart({})` is inside the success path only — but it is asserted in
      `useShop.test.ts` rather than left to the reading, because it is one
      misplaced line from being wrong and the cost is a customer who has to
      rebuild her basket after a network blip.
    */
  }, [busy, cart, products, fulfilment, onPaid]);

  return {
    status,
    products,
    failure,
    fetchedAt,
    cart,
    lines,
    total,
    count,
    stale,
    canAfford,
    shortfall,
    busy,
    refusal,
    fulfilment,
    block: checkoutBlock(fulfilment),
    retry: useCallback(() => setReload((n) => n + 1), []),
    add,
    remove,
    clearRefusal,
    setFulfilment,
    chooseAddress,
    reconcileAddresses,
    checkout,
  };
}
