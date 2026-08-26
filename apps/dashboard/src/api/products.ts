import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { formatFils, parseKwdInput, type Fils, type Product } from '@avo/types';
import { authedRequest } from '../auth/authedRequest.js';
import { useSalonId } from '../auth/AuthProvider.js';
import type { Paginated } from './salon.js';

/**
 * The product catalog behind Merchant → Shop. Four routes, all `perms.shop`,
 * checked server-side as the first statement of every handler.
 *
 *   GET    /salons/{id}/products        the catalog — ACTIVE rows only
 *   POST   /salons/{id}/products        create        (201, the new row)
 *   PATCH  /salons/{id}/products/{pid}  name, priceFils, either or both
 *   DELETE /salons/{id}/products/{pid}  RETIRE        (204, no body)
 *
 * Per the rule `routes/Accounts.tsx` had to learn the hard way: this comment
 * states what this screen does and lets `api/src/routes/salons.ts` be the record
 * of what the API has. Nothing here claims an endpoint is missing.
 *
 * THREE PROPERTIES OF THE SERVER THAT THE SCREEN ABOVE HAS TO AGREE WITH, and
 * all three are things a UI gets wrong by default:
 *
 * 1. `DELETE` RETIRES. It is `active = false`, not a row removal —
 *    `shop_order_line.product_id` is `ON DELETE restrict`, so a product that has
 *    ever been sold cannot be deleted, and an order line naming a product that
 *    no longer exists is a receipt with a dangling id in it. The design's ✕
 *    carries `title="Delete product"`; the word is corrected on this surface
 *    because the server does something else. See `Shop.tsx` § the ✕.
 *
 * 2. A RETIRED PRODUCT IS GONE FROM THIS SCREEN AND CANNOT COME BACK THROUGH IT.
 *    `GET` filters on `active = true`, and `PATCH` carries `active = true` in its
 *    WHERE — so a retired product is neither listed nor repriced back into the
 *    catalog, and there is no un-retire endpoint. It survives only where it has
 *    to: in the order lines and receipts that already name it. That is why the
 *    confirmation says so rather than implying an undo exists.
 *
 * 3. `active` IS NOT ON THE WIRE. `ProductSchema` declares exactly `id`,
 *    `salonId`, `name`, `priceFils`, and Zod STRIPS anything else — so there is
 *    no flag here to render a retired row from, and adding one is a trunk
 *    operation on `packages/types`. The absence is the contract, not an omission.
 *
 * NO IDEMPOTENCY KEY, AND THAT IS NOT AN OVERSIGHT OF #4. Non-negotiable #4 is
 * about money-moving POSTs — top-ups, charges, orders, voids. Creating a product
 * moves nothing; the handler takes no `Idempotency-Key` and has no idempotency
 * table behind it. A double-submitted create makes a duplicate row the merchant
 * can see and retire, which is the ordinary catalog-editing case rather than a
 * money one.
 */

/** `Product` from `@avo/types` IS the wire shape. No local widening — see `staff.ts`. */
export type { Product } from '@avo/types';

export const productKeys = {
  list: (salonId: string) => ['products', salonId] as const,
};

export function useProducts(): UseQueryResult<Paginated<Product>> {
  const salonId = useSalonId();
  return useQuery({
    queryKey: productKeys.list(salonId),
    queryFn: ({ signal }) =>
      authedRequest<Paginated<Product>>('merchant', `/salons/${salonId}/products`, { signal }),
  });
}

/* ------------------------------------------------------------------ the price
 *
 * NON-NEGOTIABLE #1, AT THE ONE PLACE OPERATOR TEXT BECOMES MONEY.
 *
 * The design's price cell is a free-text input with a `0.000` placeholder and a
 * KD suffix, so a merchant types KWD and the wire takes integer fils. That
 * conversion happens HERE, once, through `parseKwdInput` from `@avo/types` —
 * never a local `Number(x) * 1000`, which is the float this non-negotiable
 * exists to keep away from money (`8.7 * 1000` is `8699.999999999999`).
 *
 * `parseKwdInput` THROWS, deliberately, and this wrapper turns the throw into a
 * value the row can render. A price cell needs three answers, not two: valid,
 * "not a number I can read", and empty-while-typing — and empty is not an error,
 * it is a merchant who has selected the field and started again. A screen that
 * treated it as an error would shout at every backspace.
 */

export type PriceInput =
  | { kind: 'empty' }
  | { kind: 'invalid'; message: string }
  | { kind: 'ok'; priceFils: Fils };

/**
 * The server's own two refusals, pre-empted with the same sentences the merchant
 * would otherwise collect as a 400 round-trip:
 *
 *   parseAmountFils   "8.5" is fine, "8.5001" is not — 3 decimals is the whole
 *                     of KWD, and `parseKwdInput` says so by name.
 *   product_price_positive  a CHECK constraint. `0.000` is not a free product,
 *                     it is a rounding argument at the counter — the same reason
 *                     `service_price_positive` exists.
 */
export function readPriceInput(raw: string): PriceInput {
  const trimmed = raw.trim();
  if (trimmed === '') return { kind: 'empty' };

  let parsed: Fils;
  try {
    parsed = parseKwdInput(trimmed);
  } catch {
    return {
      kind: 'invalid',
      message: `“${trimmed}” isn’t a price. Use up to 3 decimals, like 8.500.`,
    };
  }

  if (parsed <= 0) {
    return { kind: 'invalid', message: 'A price has to be more than zero.' };
  }
  return { kind: 'ok', priceFils: parsed };
}

/**
 * The saved price, as the input should show it when nobody is typing in it.
 *
 * `formatFils` and not `toFixed` — the display boundary has one implementation
 * in `@avo/types` and this is a call to it, not a second copy of the rule. The
 * trailing zeroes are the point: `8.5` and `8.500` are the same number and
 * different amounts of money.
 */
export function priceInputValue(priceFils: Fils): string {
  return formatFils(priceFils);
}

/* ------------------------------------------------------------------- writes */

export interface CreateProductInput {
  name: string;
  priceFils: Fils;
}

export function useCreateProduct(): UseMutationResult<Product, unknown, CreateProductInput> {
  const salonId = useSalonId();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input) =>
      authedRequest<Product>('merchant', `/salons/${salonId}/products`, {
        method: 'POST',
        body: input,
      }),
    /*
     * Appended rather than invalidated, for `useCreateStaff`'s reason: the 201
     * body is the serialised row, and a refetch would blank the catalog for a
     * beat right after an action whose whole point was that a row appeared.
     *
     * `orderBy(product.id)` server-side means the list is id-ordered and a new
     * `PR-` id sorts arbitrarily within it. Appending puts the new row at the
     * bottom, where the merchant was just typing, and the next real fetch moves
     * it to wherever the server keeps it. Sorting locally to match would be
     * guessing at a rule that is only "ascending id" by default.
     */
    onSuccess: (created) => {
      queryClient.setQueryData<Paginated<Product>>(productKeys.list(salonId), (current) =>
        current ? { ...current, items: [...current.items, created] } : current,
      );
    },
  });
}

/**
 * `PATCH /salons/{id}/products/{pid}` — the design's "changes save as you type".
 *
 * ONE FIELD PER CALL, NOT A CATALOG PUT, and the endpoint is built that way for
 * a reason worth restating on this side of the wire: a bulk write would make one
 * keystroke in one row a rewrite of every product the salon sells, so two
 * managers editing different rows would silently overwrite each other and the
 * loser's product would come back at the old price with nothing recording that
 * it had moved.
 *
 * The endpoint refuses any key that is not `name` or `priceFils` — 400
 * `invalid_field`, by name — so this type is the whole of what it accepts.
 * `active` is deliberately not among them: retiring is the DELETE, which writes
 * a different audit line ("Product removed"), and "Product edited" is the wrong
 * sentence for "withdrawn from sale".
 */
export interface ProductPatch {
  name?: string;
  priceFils?: Fils;
}

export function useUpdateProduct(): UseMutationResult<
  Product,
  unknown,
  { productId: string; patch: ProductPatch }
> {
  const salonId = useSalonId();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ productId, patch }) =>
      authedRequest<Product>('merchant', `/salons/${salonId}/products/${productId}`, {
        method: 'PATCH',
        body: patch,
      }),
    /*
     * The 200 body is the updated row through the same four fields the list
     * selects, so the row is patched in place and the cell settles on what the
     * server STORED rather than on what was typed. That difference is the whole
     * value of doing it this way: a price the server rounded, trimmed or refused
     * shows up here.
     */
    onSuccess: (updated) => patchRow(queryClient, salonId, updated),
  });
}

/**
 * `DELETE /salons/{id}/products/{pid}` → 204, and it RETIRES.
 *
 * The row leaves this list because the server stops listing it, and it is
 * removed from the cache here for the same reason — not because it was deleted.
 * Every past order keeps its line.
 *
 * A SECOND DELETE ANSWERS 404, not 204: the predicate finds no ACTIVE row. That
 * is a true statement ("there is no such product on sale") rather than a 204
 * implying something was removed, and it is what a dashboard that lost the first
 * response needs to hear. It reaches the screen as `unknown_product` and renders
 * through `WriteError`, which is correct — nothing further is owed.
 */
export function useRetireProduct(): UseMutationResult<void, unknown, { productId: string }> {
  const salonId = useSalonId();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ productId }) =>
      authedRequest<void>('merchant', `/salons/${salonId}/products/${productId}`, {
        method: 'DELETE',
      }),
    onSuccess: (_void, { productId }) => {
      queryClient.setQueryData<Paginated<Product>>(productKeys.list(salonId), (current) =>
        current ? { ...current, items: current.items.filter((p) => p.id !== productId) } : current,
      );
    },
  });
}

function patchRow(
  queryClient: ReturnType<typeof useQueryClient>,
  salonId: string,
  updated: Product,
): void {
  queryClient.setQueryData<Paginated<Product>>(productKeys.list(salonId), (current) =>
    current
      ? { ...current, items: current.items.map((p) => (p.id === updated.id ? updated : p)) }
      : current,
  );
}
