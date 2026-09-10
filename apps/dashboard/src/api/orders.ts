import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { OrderStatus, ShopOrder } from '@avo/types';
import { ApiError } from './client.js';
import { authedRequest } from '../auth/authedRequest.js';
import { useSalonId } from '../auth/AuthProvider.js';

/**
 * The merchant's fulfilment board behind Merchant → Shop → Orders. Two routes,
 * both `perms.shop`, checked server-side as the first statement of each handler.
 *
 *   GET   /v1/salons/{id}/orders                    what is preparing, ready, closed
 *   PATCH /v1/salons/{id}/orders/{transactionId}     move it one step forward
 *
 * `perms.shop` AND NOT `dashboard`, on lane A's reasoning, restated here because
 * it is the fact that shapes this whole screen: the row carries A CUSTOMER'S HOME
 * ADDRESS. `api/src/routes/orders.ts` § the merchant's fulfilment board — "it is
 * deliberately not `appointments` (a different section) and not `dashboard`
 * (which would put a customer's home address behind the Overview permission)".
 *
 * NO MONEY ON THIS PATH, WHICH IS WHY THERE IS NO IDEMPOTENCY KEY BELOW AND THAT
 * IS NOT AN OVERSIGHT OF NON-NEGOTIABLE #4. #4 covers money-moving POSTs. The
 * wallet was debited by `POST /orders` when she ordered, and there is no delivery
 * fee anywhere in the feature (`PRIOR-ART.md` § "There is no delivery fee
 * anywhere" — the most consequential finding of that read, because it keeps the
 * shop entirely off the money path). Closing an order settles, refunds and
 * charges nothing; the PATCH is a plain UPDATE with an audit row.
 *
 * ---------------------------------------------------------------------------
 * FOUR PROPERTIES OF THIS DATA THAT THE SCREEN ABOVE HAS TO AGREE WITH
 *
 * 1. `address` IS A SNAPSHOT, NOT A REFERENCE. It is what she typed when she
 *    ordered, not what her address book says now — editing or deleting an
 *    address does not change a past order, deliberately, so a delivered order
 *    stays answerable. `ShopOrderSchema` in `@avo/types` says so at length. The
 *    consequence for this surface is a *negative* one and it is the easiest to
 *    get wrong: the address must not be presented as a link into her current
 *    address book, and nothing may imply the merchant is looking at live data.
 *    `routes/ShopOrders.tsx` § the snapshot carries how that reads.
 *
 * 2. `address` IS NULL FOR PICKUP, AND PICKUP IS A LIVE PATH. Not a legacy
 *    state, not a migration leftover: `PRIOR-ART.md` § "Pickup is not replaced.
 *    It is a fork." So an order with no address is NORMAL, and rendering it as
 *    an em dash or "No address" would report ordinary data as missing.
 *
 * 3. STATUS MOVES ARE MONOTONIC — `preparing → ready → closed`, forward only,
 *    one step at a time, enforced server-side with the ROW COUNT deciding. Two
 *    managers tapping "Ready" produce one transition and one 409. So the control
 *    offers exactly the next step and never a backwards one, and a FAILED move
 *    must not leave the UI a step ahead of the server — see `useMoveOrder`,
 *    which is deliberately not optimistic.
 *
 * 4. THE BOARD IS A CAP OF 200 REPORTING `truncated: true`. Honest, but NOT a
 *    cursor — `nextCursor` is null and means it. Lane A named that in the code
 *    rather than leaving another believable `nextCursor: null`, and this client
 *    renders it rather than hiding it. See `OrderBoard` below and
 *    `routes/ShopOrders.tsx` § the truncation.
 */

/**
 * THE WIRE SHAPE IS WIDER THAN `ShopOrderSchema`, DELIBERATELY, and the extra
 * fields are the join `perms.shop` is the gate for.
 *
 * `ShopOrderSchema` is the shape the CUSTOMER's half reads (`GET
 * /members/me/orders`), where the member is the principal and needs no name on
 * her own order. The merchant's board joins `member` for the two things a
 * fulfilment row cannot be drawn without — who it is for, and how to reach her
 * when the building number turns out to be wrong.
 *
 * A hand-written MIRROR, not a shared type, for `api/bookings.ts`'s reason:
 * `packages/types` is trunk-owned and `ShopOrderSchema` is what the wallet
 * validates against, so widening it is a trunk change rather than a lane one.
 * Flagged in the lane report — these two belong in a `MerchantShopOrderSchema`
 * beside it, exactly as `MerchantBooking`'s five do.
 */
export interface MerchantShopOrder extends ShopOrder {
  memberName: string;
  /** E.164. The board's one call-her-back affordance; see the `tel:` link. */
  memberPhone: string;
}

/**
 * NOT `Paginated<T>`, AND THE DIFFERENCE IS THE WHOLE POINT OF THIS TYPE.
 *
 * `Paginated<T>` is `{ items, nextCursor }`. Declaring this list as one would
 * drop `truncated` on the floor at the type level, and the screen would then be
 * unable to say the board is incomplete even though the server took the trouble
 * to tell it. That is the `nextCursor: null` defect one layer up: the API stopped
 * lying and the client would have gone on believing the old lie by omission.
 *
 * `nextCursor` is kept and is ALWAYS null. It is in the shape because the server
 * sends it, and it is named here so nobody wires paging to it: there is no
 * cursor behind this endpoint yet. `truncated` is the field with the information.
 */
export interface OrderBoard {
  items: MerchantShopOrder[];
  /** True when the 200-row cap was reached, so the board is INCOMPLETE. */
  truncated: boolean;
  /** Always null. Not a cursor — see above. */
  nextCursor: null;
}

/**
 * The three, in flow order. `OrderStatusSchema` in `@avo/types` is the same
 * enum; this is the display ORDER, which a Zod enum does not carry.
 */
export const ORDER_STATUSES = ['preparing', 'ready', 'closed'] as const;

export const orderKeys = {
  all: ['orders'] as const,
  board: (salonId: string, status: OrderStatus | null) =>
    [...orderKeys.all, salonId, status ?? 'any'] as const,
};

/**
 * `GET /v1/salons/{id}/orders` — `perms.shop`.
 *
 * `?status=` NARROWS SERVER-SIDE, which is why the filter is a query parameter
 * and not an `Array.filter` over a loaded page. On a board at the cap those are
 * different answers: filtering here would filter the 200 rows that survived,
 * while filtering there re-runs the query and can bring back rows the cap had
 * dropped. That makes the filter the actual REMEDY for truncation rather than a
 * convenience, and the truncation notice says so.
 *
 * An unknown status is refused by the server BY NAME (400 `invalid_order_status`)
 * rather than ignored, for `GET /salons/{id}/bookings`'s reason — a board
 * filtered on a typo renders empty and a merchant reads that as "no orders". The
 * only values this hook can send come from `ORDER_STATUSES`, so that refusal is
 * a backstop rather than a path.
 */
export function useOrderBoard(status: OrderStatus | null = null): UseQueryResult<OrderBoard> {
  const salonId = useSalonId();
  return useQuery({
    queryKey: orderKeys.board(salonId, status),
    queryFn: ({ signal }) =>
      authedRequest<OrderBoard>(
        'merchant',
        `/v1/salons/${salonId}/orders${status ? `?status=${encodeURIComponent(status)}` : ''}`,
        { signal },
      ),
    /*
     * `networkMode: 'always'` is why this section can render an error at all, and
     * it is restated rather than inherited for `api/bookings.ts`'s measured
     * reason: TanStack's default `'online'` PAUSES a fetch instead of failing it,
     * and a paused query sits at `status: 'pending'` for ever — which this screen
     * would draw as skeleton rows over a refusal it never showed.
     *
     * `retry` is deliberately absent. `api/retryPolicy.ts` is the only one in the
     * dashboard, and a bare `retry: 1` here would silently re-enable retrying the
     * 403 this endpoint answers for a staff account without `perms.shop` — which
     * on this board is a NORMAL response, not an anomaly.
     */
    networkMode: 'always',
  });
}

/**
 * `PATCH /v1/salons/{id}/orders/{transactionId}` — one step forward.
 *
 * ===========================================================================
 * NOT OPTIMISTIC, AND THAT IS THE REQUIREMENT RATHER THAN A SIMPLIFICATION
 * ===========================================================================
 * "A failed move must not leave the UI a step ahead of the server." An
 * optimistic write is precisely a UI a step ahead of the server, correct only
 * until it is not — and the case where it is wrong is the case that matters: two
 * managers on two laptops both tapping "Mark ready", where the server produces
 * ONE transition and ONE 409. The loser's screen would show "Ready" for the beat
 * before a rollback, and a merchant who looked in that beat has been told the
 * customer can collect.
 *
 * So the pill renders `order.status` from the cache, the cache changes only on a
 * 200, and the button carries the pending state instead. A move that fails
 * leaves the previous status exactly where it was, which is the truth.
 *
 * ON A 409, THE SERVER KNOWS THE REAL STATUS AND SAYS SO. The refusal carries
 * `{ status, attempted }` alongside a sentence written for a merchant ("That
 * order is ready. …an order never goes backwards."). `ApiError.details` keeps
 * those — `api/client.ts` preserves the error body's extra fields for exactly
 * this, "READ IT, NEVER RENDER IT RAW" — so the row is resynced to the status the
 * server reports rather than left showing a stale one. That is not the UI getting
 * ahead: it is the UI catching up to an answer it was just given, and it is the
 * difference between the loser of a race seeing the winner's result and seeing
 * nothing.
 */
export interface MoveOrderInput {
  transactionId: string;
  /** `'ready'` or `'closed'`. Never `'preparing'` — nothing moves backwards. */
  status: Exclude<OrderStatus, 'preparing'>;
}

/**
 * ===========================================================================
 * THE PATCH ANSWERS A NARROWER SHAPE THAN THE GET, AND THIS COST A DEFECT
 * ===========================================================================
 * `PATCH …/orders/{tid}` returns `{ order }` where `order` is
 * `serialiseShopOrder(row)` — the BARE `ShopOrder`. It has NO `memberName` and NO
 * `memberPhone`, because that pair is a JOIN the board's GET does and this
 * handler does not: `serialiseShopOrder` is shared with `GET /members/me/orders`,
 * where the member is the principal and needs no name on her own order.
 *
 * This hook originally declared the response `MerchantShopOrder` and wrote it
 * straight into the cache. It type-checked, it passed every unit test, and IT
 * BLANKED THE CUSTOMER COLUMN on any row a merchant moved — caught in a browser
 * against the real API by pressing "Mark ready" and watching Dana Al-Sabah
 * disappear from her own order while the row beside it kept its name.
 *
 * `authedRequest<T>` is an UNCHECKED ASSERTION over `unknown` JSON, so nothing
 * could have caught this at the type level. It is decision 78's class exactly —
 * a hand-written mirror of a wire shape, right about the fields it kept and wrong
 * about a field the wire never sends — and the same trap `api/salon.ts` records
 * against `Paginated<Transaction>`.
 *
 * SO THE RETURN TYPE IS `ShopOrder`, HONESTLY, and the joined pair is preserved
 * by MERGING onto the row already in the cache rather than replacing it. Reported
 * to lane A as an asymmetry worth naming rather than a bug to fix there: having
 * the PATCH repeat the join would work, but one serialiser for two surfaces is
 * the better shape, and the next consumer of this endpoint should be told rather
 * than left to find it the way this one did.
 */
export function useMoveOrder(
  status: OrderStatus | null = null,
): UseMutationResult<ShopOrder, unknown, MoveOrderInput> {
  const salonId = useSalonId();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ transactionId, status: next }) => {
      const body = await authedRequest<{ order: ShopOrder }>(
        'merchant',
        `/v1/salons/${salonId}/orders/${encodeURIComponent(transactionId)}`,
        { method: 'PATCH', body: { status: next } },
      );
      return body.order;
    },
    /*
     * The 200 body is `{ order }` — the row as STORED, with `readyAt`/`closedAt`
     * stamped by the server's clock. Patched in place rather than invalidated,
     * for `useUpdateProduct`'s reason: the cell settles on what the server wrote
     * instead of on what this client assumed, and a refetch would blank the board
     * for a beat right after an action whose whole point was that one row moved.
     *
     * IT DOES NOT ALWAYS BELONG IN THIS LIST ANY MORE, which is the wrinkle a
     * filtered board adds. Under `?status=preparing`, an order that just became
     * `ready` no longer satisfies the filter — so it is REMOVED rather than
     * patched to a status the list is not showing. Leaving it in would render a
     * "Ready" row under a heading that says these are preparing.
     */
    onSuccess: (updated) => {
      writeRow(queryClient, salonId, status, updated);
    },
    /*
     * THE LOSER OF THE RACE LEARNS THE WINNER'S RESULT. A 409 carries the row's
     * actual status; anything else (a 403, a 500, a dead network) says nothing
     * about the row, so nothing is written and the previous status stands.
     */
    onError: (error, { transactionId }) => {
      const actual = actualStatusFrom(error);
      if (!actual) return;
      queryClient.setQueryData<OrderBoard>(orderKeys.board(salonId, status), (current) =>
        current
          ? {
              ...current,
              items: current.items.map((o) =>
                o.transactionId === transactionId ? { ...o, status: actual } : o,
              ),
            }
          : current,
      );
    },
  });
}

/**
 * The status a 409 `order_status_not_reachable` reports the row actually being.
 *
 * NARROW ON PURPOSE — the code AND the shape are both checked. `details` is
 * `Record<string, unknown>` off the wire, so a `details.status` of `"Ready"` or
 * `"done"` from some future refusal must not become a status this client renders.
 * Anything that is not one of the three is treated as no answer at all, and the
 * previous status stands.
 */
function actualStatusFrom(error: unknown): OrderStatus | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status !== 409) return null;
  const reported = error.details['status'];
  return (ORDER_STATUSES as readonly string[]).includes(reported as string)
    ? (reported as OrderStatus)
    : null;
}

/**
 * Patch the row where it still belongs in this list, drop it where it does not.
 *
 * `status` is the FILTER the board is currently showing, not the row's status —
 * `null` is the unfiltered board, which holds every row whatever it became.
 */
function writeRow(
  queryClient: ReturnType<typeof useQueryClient>,
  salonId: string,
  filter: OrderStatus | null,
  updated: ShopOrder,
): void {
  queryClient.setQueryData<OrderBoard>(orderKeys.board(salonId, filter), (current) => {
    if (!current) return current;
    const stillBelongs = filter === null || filter === updated.status;
    return {
      ...current,
      items: stillBelongs
        ? current.items.map((o) =>
            /*
             * MERGED, NOT REPLACED. `updated` is a bare `ShopOrder` — the PATCH
             * does not repeat the GET's member join (see the hook's header), so
             * spreading it over the existing row keeps `memberName` and
             * `memberPhone` while taking the server's new `status`, `readyAt` and
             * `closedAt`. A straight replace blanked the customer column.
             *
             * The order of the spread matters: `updated` LAST, so the server's
             * values win on every field it actually sent.
             */
            o.transactionId === updated.transactionId ? { ...o, ...updated } : o,
          )
        : current.items.filter((o) => o.transactionId !== updated.transactionId),
    };
  });
  /*
   * THE OTHER THREE VIEWS OF THE SAME ROW ARE NOW STALE. A move changes which
   * filtered board an order belongs to, so every cached board except the one just
   * written is wrong about it — and a merchant flipping to "Ready" right after
   * pressing "Mark ready" would read a cached list that never saw the move.
   *
   * Invalidated rather than hand-patched across four keys: reconstructing where a
   * row belongs in three lists this client is not looking at is the kind of
   * bookkeeping that drifts, and these refetch on their next mount anyway.
   */
  void queryClient.invalidateQueries({
    queryKey: orderKeys.all,
    predicate: (query) => query.queryKey[2] !== (filter ?? 'any'),
  });
}
