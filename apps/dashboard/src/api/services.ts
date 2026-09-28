import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { ServiceSchema, type Fils, type Service } from '@avo/types';
import { authedRequest } from '../auth/authedRequest.js';
import { useSalonId } from '../auth/AuthProvider.js';
import type { Paginated } from './salon.js';

/**
 * The salon's services — the list the appointment form books from, and since
 * the client's M7 ("a Services tab where they can add the services, price it,
 * then assign them") the list Merchant → Services edits.
 *
 *   GET    /salons/{id}/services                 requireSalonScoped — no dashboard perm
 *   POST   /salons/{id}/services                 perms.loyalty   add        (201)
 *   PATCH  /salons/{id}/services/{sid}           perms.loyalty   rename / reprice
 *   DELETE /salons/{id}/services/{sid}           perms.loyalty   RETIRE     (204)
 *   PUT    /salons/{id}/services/{sid}/artists   perms.team      who does it
 *
 * All BARE paths, like the products beside them. `api/src/routes/services.ts`
 * is the record of what the API does; this header only states what this client
 * sends and how it reads the answers.
 *
 * TWO PERMISSIONS, AND THIS FILE DOES NOT CHOOSE BETWEEN THEM. Price is salon
 * configuration (`loyalty`, the deposit's gate); assignment is roster
 * administration (`team`). The screen hides each control from a reader without
 * its own permission as a courtesy — the server refuses each write
 * independently, and a refusal reaches the screen as the server's own sentence.
 *
 * THE READ. `requireSalonScoped`, not a dashboard permission: it is the list the
 * scanner prices a counter sale from and the wallet books from. Already filtered
 * to `active`, server-side, and ordered by id so a re-read does not reshuffle
 * the tab. `nextCursor` is always null — the salon's whole menu in one page — so
 * there is no cursor walk.
 *
 * EVERY BODY IS PARSED, THROUGH `ServiceSchema` BARE. `serialiseServices` emits
 * exactly its eight fields (`id`, `salonId`, `name`, `nameAr`, `priceFils`,
 * `active`, `image`, `artistIds` — `ServiceView` in the route), checked against
 * the serialiser rather than inferred from the name. The cast this file used to
 * carry (`authedRequest<Paginated<Service>>`) is gone with it.
 *
 * `networkMode: 'always'` on the read for `api/bookings.ts § useSalonBookings`'
 * reason: TanStack's default PAUSES a fetch offline, and a paused query sits
 * `pending` for ever — the form would render a permanently disabled service
 * field, and this tab a permanent skeleton, instead of saying why.
 */
export const serviceKeys = {
  all: ['services'] as const,
  list: (salonId: string) => [...serviceKeys.all, salonId] as const,
};

/** `ServiceSchema` bare — see the header. Exported for the parse specs. */
export function parseService(raw: unknown): Service {
  return ServiceSchema.parse(raw);
}

/**
 * The list envelope, hand-checked: `packages/types` owns the item and not the
 * page, and `@avo/types` does not re-export `z` (`api/staff.ts § parseStaffPage`
 * is the same helper for the same reason). The index names the row, so a
 * twelve-service menu's one bad row is findable.
 */
export function parseServicePage(raw: unknown): Paginated<Service> {
  const where = 'GET /salons/{id}/services';
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${where} was not an object.`);
  }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.items)) throw new Error(`${where}.items was not an array.`);
  if (r.nextCursor !== null && typeof r.nextCursor !== 'string') {
    throw new Error(`${where}.nextCursor was neither a string nor null.`);
  }
  return {
    items: r.items.map((row, i) => {
      try {
        return parseService(row);
      } catch (cause) {
        throw new Error(`${where}.items[${i}] was not a service: ${String(cause)}`);
      }
    }),
    nextCursor: r.nextCursor,
  };
}

export function useSalonServices(enabled = true): UseQueryResult<Paginated<Service>> {
  const salonId = useSalonId();
  return useQuery({
    queryKey: serviceKeys.list(salonId),
    queryFn: async ({ signal }) =>
      parseServicePage(
        await authedRequest<unknown>('merchant', `/salons/${salonId}/services`, { signal }),
      ),
    enabled,
    networkMode: 'always',
  });
}

/* ------------------------------------------------------------------- writes
 *
 * A WRITE'S BODY IS PARSED, AND AN UNREADABLE ONE IS NOT A FAILED WRITE.
 *
 * Every one of these answers AFTER its transaction commits. A `.parse` thrown
 * inside `mutationFn` would turn an unreadable 201 into a rejected mutation, and
 * the screen would draw "No service was added." over a service the server had
 * just created — the false failure `api/settings.ts § useAddBranch` records, and
 * the action it invites is a second POST and a duplicate on the menu.
 *
 * So: `safeParse`. A readable body is written into the cache (the row settles on
 * what the server STORED, not what was typed); an unreadable one returns `null`
 * and the list is invalidated, so the truth comes from a fresh read — through
 * `parseServicePage`, which DOES throw, because a read that cannot be read is an
 * ordinary failed read.
 *
 * NO IDEMPOTENCY KEY, and that is not a lapse of non-negotiable #4: none of these
 * moves money. A service is a menu row; a doubled create is a duplicate she can
 * see and retire. The handlers take no `Idempotency-Key` either.
 */

function settle(
  queryClient: QueryClient,
  salonId: string,
  raw: unknown,
  apply: (items: Service[], service: Service) => Service[],
): Service | null {
  const parsed = ServiceSchema.safeParse(raw);
  if (!parsed.success) {
    void queryClient.invalidateQueries({ queryKey: serviceKeys.list(salonId) });
    return null;
  }
  queryClient.setQueryData<Paginated<Service>>(serviceKeys.list(salonId), (current) =>
    current ? { ...current, items: apply(current.items, parsed.data) } : current,
  );
  return parsed.data;
}

const replaceRow = (items: Service[], s: Service) => items.map((x) => (x.id === s.id ? s : x));

/**
 * `POST /salons/{id}/services` — `{ name, nameAr?, priceFils }`, perms.loyalty.
 *
 * `priceFils` IS ALREADY `Fils` BY THE TIME IT GETS HERE — the type is the
 * guard. The KD text is converted once, on the screen, through `readPriceInput`
 * (`@avo/types § parseKwdInput`), and a bare number does not type-check here.
 *
 * `nameAr` is sent only when she typed one. Blank is the server's `null`
 * anyway (`parseNameAr`), and omitting it keeps the body to what she said.
 *
 * THE NEW SERVICE ARRIVES WITH `artistIds: []` — chargeable at the counter,
 * bookable by nobody. The screen says so on the row.
 */
export interface CreateServiceInput {
  name: string;
  nameAr?: string;
  priceFils: Fils;
}

export function useCreateService(): UseMutationResult<Service | null, unknown, CreateServiceInput> {
  const salonId = useSalonId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input) =>
      settle(
        queryClient,
        salonId,
        await authedRequest<unknown>('merchant', `/salons/${salonId}/services`, {
          method: 'POST',
          body: input,
        }),
        // Appended: the list is id-ordered and `SV-` ids come off a sequence, so
        // the newest service is the last one the next read returns as well.
        (items, s) => [...items, s],
      ),
  });
}

/**
 * `PATCH /salons/{id}/services/{sid}` — any of `name`, `nameAr`, `priceFils`,
 * perms.loyalty. `nameAr: null` clears the Arabic name back to the English
 * fallback. `active` and `artistIds` are not editable here, by the server's
 * design (`not_editable`), so this type does not offer them.
 */
export interface ServicePatch {
  name?: string;
  nameAr?: string | null;
  priceFils?: Fils;
}

export function useUpdateService(): UseMutationResult<
  Service | null,
  unknown,
  { serviceId: string; patch: ServicePatch }
> {
  const salonId = useSalonId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ serviceId, patch }) =>
      settle(
        queryClient,
        salonId,
        await authedRequest<unknown>('merchant', `/salons/${salonId}/services/${serviceId}`, {
          method: 'PATCH',
          body: patch,
        }),
        replaceRow,
      ),
  });
}

/**
 * `DELETE /salons/{id}/services/{sid}` → 204, and it RETIRES (`active = false`).
 * The row leaves this list because the server stops listing it. A second DELETE
 * answers 404 `unknown_service` — there is no such service on the menu — which
 * the screen renders as the server's sentence.
 */
export function useRetireService(): UseMutationResult<void, unknown, { serviceId: string }> {
  const salonId = useSalonId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ serviceId }) => {
      await authedRequest<unknown>('merchant', `/salons/${salonId}/services/${serviceId}`, {
        method: 'DELETE',
      });
    },
    onSuccess: (_void, { serviceId }) => {
      queryClient.setQueryData<Paginated<Service>>(serviceKeys.list(salonId), (current) =>
        current ? { ...current, items: current.items.filter((s) => s.id !== serviceId) } : current,
      );
    },
  });
}

/**
 * `PUT /salons/{id}/services/{sid}/artists` — `{ artistIds }`, perms.team.
 *
 * A REPLACEMENT OF THE WHOLE SET, not a merge; `[]` means nobody. The screen
 * sends every id it was served for this service plus or minus her ticks —
 * including ids the roster no longer shows as active, because the server serves
 * retired artists' assignments so that a save round-trips them rather than
 * silently dropping them (`serialiseServices` § ALL ASSIGNED ARTISTS).
 */
export function useAssignServiceArtists(): UseMutationResult<
  Service | null,
  unknown,
  { serviceId: string; artistIds: string[] }
> {
  const salonId = useSalonId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ serviceId, artistIds }) =>
      settle(
        queryClient,
        salonId,
        await authedRequest<unknown>(
          'merchant',
          `/salons/${salonId}/services/${serviceId}/artists`,
          { method: 'PUT', body: { artistIds } },
        ),
        replaceRow,
      ),
  });
}
