import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { StaffUser } from '@avo/types';
import { authedRequest } from '../auth/authedRequest.js';
import { useSalonId } from '../auth/AuthProvider.js';
import type { Paginated } from './salon.js';

/**
 * `GET /staff` and `PATCH /staff/{id}` — both `perms.team`.
 *
 * `PATCH /staff/{id}` is the endpoint that SETS authority, which makes it the
 * most sensitive route in the API. It takes `perms` and nothing else: `pin`,
 * `pinHash`, `password` and `passwordHash` are refused outright, and no
 * credential is ever serialised back (non-negotiable #6 — `pinSet` is a boolean
 * and that is all a client ever learns about a PIN).
 */

export type PermissionName =
  | 'dashboard'
  | 'appointments'
  | 'shop'
  | 'loyalty'
  | 'team'
  | 'scanner'
  | 'charges'
  | 'void'
  | 'marketing';

/** The nine chips, in the design's order, with the design's labels. */
export const PERMISSIONS: ReadonlyArray<{ key: PermissionName; label: string }> = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'appointments', label: 'Appointments' },
  { key: 'shop', label: 'Shop' },
  { key: 'loyalty', label: 'Loyalty' },
  { key: 'team', label: 'Team & accounts' },
  { key: 'scanner', label: 'Scan & charge' },
  { key: 'charges', label: "See today's charges" },
  { key: 'void', label: 'Void a charge' },
  { key: 'marketing', label: 'Submit campaigns' },
];

export type StaffPerms = Record<PermissionName, boolean>;

export const staffKeys = {
  list: (salonId: string) => ['staff', salonId] as const,
};

export function useStaff(): UseQueryResult<Paginated<StaffUser>> {
  const salonId = useSalonId();
  return useQuery({
    queryKey: staffKeys.list(salonId),
    queryFn: ({ signal }) => authedRequest<Paginated<StaffUser>>('merchant', '/staff', { signal }),
    retry: 1,
  });
}

/**
 * `void` IMPLIES `charges`, BOTH WAYS — and the UI agrees with the server rather
 * than arguing with it.
 *
 * api-contract.md: "void is meaningless without charges." The API enforces both
 * directions, and they are not symmetrical:
 *
 *   - granting `void` while `charges` is off is REJECTED, 400
 *     `void_requires_charges`. A database CHECK would refuse it anyway.
 *   - revoking `charges` REVOKES `void` with it, silently, in the same UPDATE.
 *
 * A UI that sent the raw click would produce a 400 for the first case and a
 * surprise for the second: the merchant unticks "See today's charges", "Void a
 * charge" stays lit for a beat, and then the next refetch quietly puts it out.
 *
 * So the same rule is applied to the click before it becomes a request. Turning
 * `void` on turns `charges` on with it — which is what the merchant meant, since
 * she cannot have one without the other — and turning `charges` off takes `void`
 * with it, visibly and immediately. The server still decides; this only means it
 * is never asked for something it must refuse.
 */
export function applyPermissionRules(
  current: StaffPerms,
  key: PermissionName,
  next: boolean,
): StaffPerms {
  const result: StaffPerms = { ...current, [key]: next };
  if (key === 'void' && next) result.charges = true;
  if (key === 'charges' && !next) result.void = false;
  return result;
}

/** Only the permissions that actually moved. The API takes a partial `perms`. */
export function changedPerms(before: StaffPerms, after: StaffPerms): Partial<StaffPerms> {
  const diff: Partial<StaffPerms> = {};
  for (const { key } of PERMISSIONS) {
    if (before[key] !== after[key]) diff[key] = after[key];
  }
  return diff;
}

export function useSetPermissions(): UseMutationResult<
  StaffUser,
  unknown,
  { staffId: string; perms: Partial<StaffPerms> }
> {
  const salonId = useSalonId();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ staffId, perms }) =>
      authedRequest<StaffUser>('merchant', `/staff/${staffId}`, {
        method: 'PATCH',
        body: { perms },
      }),
    /*
     * The response IS the updated staff row through the same `serialiseStaff`
     * the list uses — checked, unlike PATCH /salons/{id}, which returns a raw
     * row and cannot be cached. So the row is patched in place: no refetch, and
     * the chips settle on what the server stored rather than on what was
     * clicked. That difference matters here, because revoking `charges` also
     * revokes `void` server-side and the response is where that shows up.
     */
    onSuccess: (updated) => {
      queryClient.setQueryData<Paginated<StaffUser>>(staffKeys.list(salonId), (current) =>
        current
          ? { ...current, items: current.items.map((s) => (s.id === updated.id ? updated : s)) }
          : current,
      );
    },
  });
}
