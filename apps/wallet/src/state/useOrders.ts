/**
 * Her orders, and which of the three statuses each is in.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * A SEPARATE READ FROM THE ACTIVITY FEED, AND NOT A DUPLICATE OF IT.
 *
 * `GET /members/me/transactions` already carries what she PAID for an order.
 * This reads `shop_order`, which is where it IS: the fulfilment she chose, one
 * of `preparing → ready → closed`, and the address snapshot. The transaction
 * does not carry any of the three. Without this read the lifecycle is invisible
 * to the person waiting for the bottle, which would make `preparing → ready →
 * closed` a merchant's private bookkeeping rather than the thing it is for.
 *
 * It is deliberately its own hook rather than a field on `useWalletHome`. Home
 * is read once in `App.tsx` and handed down because the BALANCE must have one
 * owner (#2); an order list has no such constraint, is only looked at when she
 * opens it, and folding it into the home snapshot would make every wallet
 * refresh fetch a list nothing on Home draws.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * `truncated` IS READ, NOT DROPPED.
 *
 * The route caps the page at 200 and reports the cap as a flag rather than
 * hardcoding `nextCursor: null` — a defect lane A fixed in this area once
 * already, because a list that silently ends at its cap claims to be complete.
 * A customer with 200 shop orders is not a case this app will meet, and the flag
 * being carried through to state is what makes that a measurement rather than an
 * assumption. Nothing renders a "there are more" line today; the field exists so
 * that the day one is needed the data is already here.
 *
 * NO WRITES. `preparing → ready → closed` is the MERCHANT's transition — the
 * fulfilment board's, behind `perms.shop` — and there is no customer endpoint
 * that advances a status or cancels an order. `OrderResult.voidable` is a
 * literal `false` and `performVoid` refuses anything that is not a charge. So
 * this hook reads and retries, and has no action that changes anything.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ShopOrder } from '@avo/types';
import { getMyOrders } from '../api/shop';
import { toLoadFailure, type LoadFailure } from '../domain/loadFailure';
import { sortedOrders } from '../domain/shopOrders';
import {
  addressStatusForFailure,
  type AddressBookStatus as ListStatus,
} from './useAddresses';

/**
 * The same five values the address book uses, and the same rule behind them:
 * a refresh that fails over a list already on screen keeps the list with a
 * banner rather than blanking it, and `forbidden` is a cold failure in both
 * cases. Aliased rather than re-declared so the two cannot drift into
 * almost-the-same union.
 */
export type OrdersStatus = ListStatus;

export interface OrdersState {
  status: OrdersStatus;
  /** Null until the first successful read; never `[]` standing in for it. */
  orders: ShopOrder[] | null;
  /** True when the server capped the page. See the header. */
  truncated: boolean;
  failure: LoadFailure | null;
  fetchedAt: number | null;
}

export interface OrdersController extends OrdersState {
  retry: () => void;
}

/**
 * @param active Whether the list is on screen. `false` does not fetch.
 *
 * The sheet is mounted by `ShopScreen` and closed most of the time, and a hook
 * that fetched on mount would read her orders on every visit to the Shop tab.
 * `Sheet` returns null when closed, so a hook owned by the sheet's own component
 * would unmount and refetch on every open — this one is owned by the screen and
 * gated instead, so opening it twice in a row does not read twice.
 */
export function useOrders(active: boolean): OrdersController {
  const [status, setStatus] = useState<OrdersStatus>('loading');
  const [orders, setOrders] = useState<ShopOrder[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [failure, setFailure] = useState<LoadFailure | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [reload, setReload] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  const aliveRef = useRef(true);
  const listRef = useRef<ShopOrder[] | null>(null);
  listRef.current = orders;

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus((prev) => (listRef.current === null ? 'loading' : prev));

    getMyOrders(controller.signal)
      .then((page) => {
        if (!aliveRef.current) return;
        setOrders(page.items);
        setTruncated(page.truncated);
        setFailure(null);
        setFetchedAt(Date.now());
        setStatus('ready');
      })
      .catch((err: unknown) => {
        if (!aliveRef.current || controller.signal.aborted) return;
        const next = toLoadFailure(err);
        setFailure(next);
        setStatus(addressStatusForFailure(next.kind, listRef.current !== null));
      });
  }, [active, reload]);

  /*
    Sorted here rather than in the component: open orders first, newest first
    within each — `domain/shopOrders.ts` § `sortedOrders`, which takes a copy
    because `sort` mutates and this array is compared by reference by React.
  */
  const sorted = useMemo(() => (orders === null ? null : sortedOrders(orders)), [orders]);

  return {
    status,
    orders: sorted,
    truncated,
    failure,
    fetchedAt,
    retry: useCallback(() => setReload((n) => n + 1), []),
  };
}
