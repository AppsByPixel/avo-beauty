import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type UseInfiniteQueryResult,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import {
  OrderBoardSchema,
  ShopOrderSchema,
  type MerchantShopOrder,
  type OrderBoard,
  type OrderStatus,
  type ShopOrder,
} from '@avo/types';
import { ApiError } from './client.js';
import { memberQuery } from './bookings.js';
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
 * 2. `address` IS NULL IN TWO DIFFERENT SITUATIONS, AND `fulfilment` IS WHAT
 *    TELLS THEM APART. Neither is a legacy state or a migration leftover, so an
 *    order with no address is NORMAL either way and rendering it as an em dash
 *    or "No address" would report ordinary data as missing.
 *
 *      `fulfilment: 'pickup'`    she is collecting. `PRIOR-ART.md` § "Pickup is
 *                                not replaced. It is a fork."
 *      `fulfilment: 'delivery'`  the snapshot was ERASED (DECISIONS.md #97,
 *                                migration 0048). The order remains; the
 *                                household it named does not.
 *
 *    THE PAIR CANNOT MEAN ANYTHING ELSE, and that is a database guarantee rather
 *    than an assumption this client is making: migration 0048's CHECK requires a
 *    live delivery to carry block, street and building, so a delivery with a null
 *    address cannot arise from a forgotten snapshot.
 *
 *    THERE IS NO ERASURE DATE ON THE WIRE AND THERE MUST NOT BE ONE. Lane A left
 *    `address_erased_at` out of `serialiseShopOrder` deliberately — it would tell
 *    a salon when a customer asked to be erased, a fact about her rather than
 *    about her order. If a field like it ever appears, this screen still must not
 *    print it. `routes/ShopOrders.tsx` § the erased delivery carries the copy.
 *
 * 3. STATUS MOVES ARE MONOTONIC — `preparing → ready → closed`, forward only,
 *    one step at a time, enforced server-side with the ROW COUNT deciding. Two
 *    managers tapping "Ready" produce one transition and one 409. So the control
 *    offers exactly the next step and never a backwards one, and a FAILED move
 *    must not leave the UI a step ahead of the server — see `useMoveOrder`,
 *    which is deliberately not optimistic.
 *
 * 4. THE BOARD PAGES 200 AT A TIME WITH A REAL CURSOR NOW. `truncated` still
 *    means "there is another page" and `nextCursor` is that page's cursor, a
 *    string, or null when there is none (lane A, 72d79f7). The BOARD screen
 *    still renders the first page and its truncation notice rather than paging
 *    — `routes/ShopOrders.tsx` § the truncation — and the customer card's
 *    Purchases panel is the first reader that follows the cursor
 *    (`useMemberOrders` below).
 */

/**
 * THE WIRE SHAPE IS WIDER THAN `ShopOrderSchema`, AND IT IS NOW TRUNK'S.
 *
 * `MerchantShopOrderSchema` and `OrderBoardSchema` landed in `@avo/types`
 * (8769f4c) with the serialiser that sends them: `ShopOrderSchema` plus the
 * member join `perms.shop` is the gate for (`memberName`, `memberPhone`,
 * `memberErased`) plus what was bought — `lines` (the checkout snapshot: name
 * and unit price as she paid them) and `totalFils` (the order's own wallet
 * debit, not a re-sum of the lines). This file used to carry a hand-written
 * mirror of the first three and check them by hand beside a bare
 * `ShopOrderSchema` run, because the schema did not exist yet. It does, so the
 * mirror is gone and the types are re-exported from the one place both the API's
 * specs and this client read.
 *
 * `memberPhone` IS NULL WHEN `memberErased` — the `+990` tombstone is withheld
 * server-side (DECISIONS.md #100). `ShopOrders.tsx` still reads the null phone
 * as a second, independent arm so no payload can produce `tel:null`.
 */
export type { MerchantShopOrder, OrderBoard };

/**
 * ===========================================================================
 * THE BOARD, PARSED THROUGH `OrderBoardSchema` — AND A BAD ROW FAILS IT ALL
 * ===========================================================================
 * `pickupBranch` is why this stopped being a cast (0060): the Where cell FORKS
 * on it, and a payload whose `closed` arrived as `"true"` would pick an arm
 * silently. The schema is `.strict()` on the row, so a row that grew an
 * undeclared key fails here too rather than being stripped in transit.
 *
 * A BAD ROW FAILS THE WHOLE BOARD rather than being dropped — `api/staff.ts §
 * parseStaffPage`'s rule, for a sharper reason here. A dropped row is an order
 * that silently leaves the one screen that prepares it, and the customer arrives
 * for it anyway. "Couldn't load orders" is loud and retryable; a board that is
 * one order short is neither. The index of the first bad row is kept in the
 * message, because it is what makes one bad row in two hundred findable.
 *
 * `nextCursor` IS A REAL CURSOR NOW — a string, or null when there is no next
 * page — and the schema says so. The old parse REFUSED a string, which was right
 * while the server's null meant "not a cursor" and would now refuse every page
 * but the last.
 */
export function parseOrderBoard(raw: unknown): OrderBoard {
  const where = 'GET /v1/salons/{id}/orders';
  const parsed = OrderBoardSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const path = issue ? issue.path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${p}`)).join('') : '';
  throw new Error(`${where}${path} did not match the board: ${issue?.message ?? 'invalid'}`);
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
  /**
   * One customer's orders, for the card's Purchases panel. `'member'` cannot
   * collide with a `board` key — the third element there is a status or
   * `'any'`, and the server refuses any other status by name — and it sits
   * under `all`, so a status move's `invalidateQueries({ queryKey: all })`
   * reaches her card too.
   */
  member: (salonId: string, memberId: string) =>
    [...orderKeys.all, salonId, 'member', memberId] as const,
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
    /*
     * PARSED, AND A PARSE FAILURE IS AN ORDINARY FAILED READ — `SectionError`
     * draws "Couldn't load orders" with Try again. See `parseOrderBoard`.
     */
    queryFn: async ({ signal }) =>
      parseOrderBoard(
        await authedRequest<unknown>(
          'merchant',
          `/v1/salons/${salonId}/orders${status ? `?status=${encodeURIComponent(status)}` : ''}`,
          { signal },
        ),
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
 * `serialiseShopOrder(row)` — the BARE `ShopOrder`. It has NO `memberName`, NO
 * `memberPhone` and NO `memberErased`, because those three are a JOIN the board's
 * GET does and this handler does not: `serialiseShopOrder` is shared with
 * `GET /members/me/orders`, where the member is the principal and needs no name
 * on her own order.
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
/**
 * ===========================================================================
 * THE MOVED ROW, READ RATHER THAN ASSERTED — AND `null` IS NOT AN ERROR
 * ===========================================================================
 * `authedRequest<{ order: ShopOrder }>` is an unchecked assertion over
 * `unknown` JSON, and this hook dereferenced it twice on the far side of a
 * committed PATCH: `body.order` in the `mutationFn`, and then `updated.status`
 * and `updated.transactionId` inside `writeRow`, from `onSuccess`.
 *
 * NEITHER POSITION IS SAFE TO THROW FROM, and that is not obvious about the
 * first one. A throw in `mutationFn` is the ordinary way a write reports
 * failure — but by the time this body is being read the UPDATE has already
 * committed, the audit row is written, and the order really is `ready`. A throw
 * in `onSuccess` is no better: `Mutation#execute` catches it, runs `onError`
 * and dispatches `{ type: 'error' }`, so it arrives at the screen as the same
 * failure. Either way `ShopOrders.tsx` draws, verbatim:
 *
 *     "Something went wrong on our side. The status shown is still the real one."
 *
 * The second sentence is exactly backwards: the pill is showing `preparing`
 * BECAUSE this hook is not optimistic, and the server has it at `ready`. The
 * screen would be telling a merchant that a stale pill is the truth, and the
 * control beside it still offers the move she has already made.
 *
 * SO THE PARSE NEVER THROWS AND `TData` IS HONEST: `ShopOrder | null`, where
 * `null` reads "the move committed and we could not read what came back". The
 * caller's `onSuccess` invalidates instead of patching; nothing renders an
 * error. `api/bookings.ts § parseWrittenBooking` is the same decision for the
 * three booking writes, argued at length there.
 *
 * `ShopOrderSchema` IS RUN BARE, checked against the serialiser rather than
 * assumed: `serialiseShopOrder` (api/src/routes/orders.ts:84) emits exactly the
 * schema's seven keys — `transactionId`, `fulfilment`, `status`, the nullable
 * `address` snapshot, `createdAt`, and the nullable `readyAt`/`closedAt`. Zod
 * strips unknown keys, so a server that adds one is not refused by this; a
 * server that DROPS one is, which is what a required field is for.
 *
 * AND THE JOIN IS DELIBERATELY NOT IN THIS SHAPE. The PATCH answers a bare
 * `ShopOrder` with no `memberName`, `memberPhone` or `memberErased` — the
 * asymmetry the header above records as having cost a defect — so `writeRow`
 * MERGES rather than replaces. Parsing against `MerchantShopOrder` would refuse
 * every correct response this endpoint has ever sent.
 */
export function parseMovedOrder(response: unknown): ShopOrder | null {
  /*
   * A 200 with a body of `null` is the case that makes `response.order` throw
   * before any schema is consulted, so `typeof null === 'object'` is excluded
   * by name.
   */
  if (typeof response !== 'object' || response === null) return null;
  const parsed = ShopOrderSchema.safeParse((response as { order?: unknown }).order);
  return parsed.success ? parsed.data : null;
}

export function useMoveOrder(
  status: OrderStatus | null = null,
): UseMutationResult<ShopOrder | null, unknown, MoveOrderInput> {
  const salonId = useSalonId();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ transactionId, status: next }) =>
      parseMovedOrder(
        await authedRequest<unknown>(
          'merchant',
          `/v1/salons/${salonId}/orders/${encodeURIComponent(transactionId)}`,
          { method: 'PATCH', body: { status: next } },
        ),
      ),
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
      if (updated === null) {
        /*
         * THE MOVE COMMITTED AND THE ANSWER WAS UNREADABLE. There is no row to
         * patch and no basis to guess which board this order now belongs to, so
         * EVERY board is invalidated — including the one being looked at, which
         * `writeRow`'s predicate deliberately excludes when there IS a row.
         * A refetch of four cached lists is the price of not inventing a status.
         */
        void queryClient.invalidateQueries({ queryKey: orderKeys.all });
        return;
      }
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
             * spreading it over the existing row keeps `memberName`,
             * `memberPhone` AND `memberErased` while taking the server's new
             * `status`, `readyAt` and `closedAt`. A straight replace blanked the
             * customer column.
             *
             * `memberErased` IS IN THAT LIST FOR A QUIETER REASON THAN THE OTHER
             * TWO. Losing the name blanks a cell and somebody sees it. Losing
             * the FLAG changes which arm the Customer cell takes, and the row
             * still renders — so the failure is a merchant being offered a
             * contact again on an order she just marked "Ready", with nothing on
             * screen to say the state changed. It survives here for free
             * (`updated` does not carry the key, so the spread cannot clobber
             * it), and `ShopOrders.tsx` reads the null phone as a second,
             * independent arm so this is belt and braces rather than the only
             * thing holding #100 shut.
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

/**
 * ===========================================================================
 * `GET /v1/salons/{id}/orders?memberId=` — ONE CUSTOMER'S ORDERS, PAGED.
 * ===========================================================================
 * The customer card's Purchases panel. The gate is the BOARD'S (`perms.shop`),
 * not the card's (`team`): the board already serves every one of these rows,
 * delivery addresses included, to a `shop` holder, and `team` alone would hand a
 * customer's address to somebody the Shop section never trusted (lane A,
 * 72d79f7; DECISIONS.md, the fourth list). So the panel needs BOTH — `team` to
 * open the card, `shop` to fill it — and a `team`-only manager is answered 403
 * here, which the panel renders as "no access", not as a failure.
 *
 * A member who is not this salon's is `404 unknown_member`, never an empty page.
 *
 * WALKED WITH THE BOARD'S REAL CURSOR, newest order first. `networkMode:
 * 'always'` for `useOrderBoard`'s reason; `enabled` so a card that already
 * answered 404 does not ask a second time.
 */
export function useMemberOrders(
  memberId: string,
  enabled = true,
): UseInfiniteQueryResult<InfiniteData<OrderBoard>> {
  const salonId = useSalonId();
  return useInfiniteQuery({
    queryKey: orderKeys.member(salonId, memberId),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) =>
      parseOrderBoard(
        await authedRequest<unknown>(
          'merchant',
          `/v1/salons/${salonId}/orders${memberQuery(memberId, pageParam)}`,
          { signal },
        ),
      ),
    getNextPageParam: (last) => last.nextCursor,
    enabled,
    networkMode: 'always',
  });
}
