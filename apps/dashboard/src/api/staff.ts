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
 * The staff roster and everything that writes to it. Every route here is
 * `perms.team`, checked server-side as the FIRST statement of each handler —
 * before the target row is read and before the body is parsed. Non-negotiable
 * #7: hiding a control in this file is a courtesy, so every mutation below is
 * written to survive a 403 arriving anyway.
 *
 *   GET    /staff                      the roster
 *   POST   /staff                      create        (201)
 *   PATCH  /staff/{id}                 perms, role, branchAccess
 *   DELETE /staff/{id}                 deactivate, NOT delete
 *   POST   /staff/{id}/password-reset  send a link   (202)
 *
 * `PATCH /staff/{id}` is the endpoint that SETS authority, which makes it the
 * most sensitive route in the API — lane A's own header calls it the
 * privilege-escalation route. `pin`, `pinHash`, `password` and `passwordHash`
 * are refused outright on every one of these, and no credential is ever
 * serialised back (non-negotiable #6 — `pinSet` and `passwordSet` are booleans,
 * and that is the whole of what a client ever learns about a credential).
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

/**
 * The five roles of `api-contract.md § StaffUser`, with the design's labels.
 *
 * TWO CORRECTIONS TO THE PROTOTYPE, both of which would 400 as drawn:
 *
 *   - the design's `<option value="stylist">` is `artist` in the enum. A select
 *     that posts "stylist" is rejected by `parseRole`. The design's *label* is
 *     kept ("Stylist") because that is the word a Kuwaiti salon uses; only the
 *     wire value is corrected.
 *   - the design offers four roles and no `owner`. An account that already holds
 *     `owner` still has to render its own role truthfully, so `owner` is a
 *     legal value here but is not offered as a choice — see `roleOptionsFor`.
 */
export const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  manager: 'Manager',
  frontdesk: 'Front desk',
  artist: 'Stylist',
  scanner: 'Scanner only',
};

/** The four the design's selects offer, in its order. */
export const ASSIGNABLE_ROLES = ['manager', 'frontdesk', 'artist', 'scanner'] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

/**
 * `owner` appears only when the account already is one. Promoting somebody to
 * owner is not a thing this screen does, and silently rendering an owner as
 * "Manager" because the option list lacks her role would be worse than either.
 */
export function roleOptionsFor(currentRole: string): ReadonlyArray<{
  value: string;
  label: string;
}> {
  const base = ASSIGNABLE_ROLES.map((value) => ({ value, label: ROLE_LABEL[value] ?? value }));
  if ((ASSIGNABLE_ROLES as readonly string[]).includes(currentRole)) return base;
  return [{ value: currentRole, label: ROLE_LABEL[currentRole] ?? currentRole }, ...base];
}

/**
 * `StaffUser` from `@avo/types` IS the wire shape — there is no local widening.
 *
 * A `TeamAccount extends StaffUser` used to sit here adding `passwordSet`,
 * `active` and `deactivatedAt`, on the belief that `serialiseStaff` sent three
 * fields the shared schema lacked. The schema had all three; this branch was 14
 * commits behind the commit that added them. The local type was therefore a
 * *duplicate* of a shared contract, which is the same drift it was written to
 * work around, pointing the other way — and the more dangerous direction, because
 * a duplicate keeps compiling after the shared type moves.
 *
 * So: one name for this shape, owned by `packages/types`. If a field the screen
 * needs is genuinely missing, widen the schema on trunk rather than re-adding a
 * local mirror here.
 */

export const staffKeys = {
  list: (salonId: string) => ['staff', salonId] as const,
};

/**
 * `enabled` exists for ONE caller and one reason: Settings' branch-close warning
 * needs to know which staff are scoped to a branch, and closing a branch needs
 * only `perms.loyalty` while this route needs `perms.team`. A `loyalty`-only
 * account asking anyway would get a 403 that means nothing to her — she is not
 * being refused the branch close, only the roster behind the warning. So the
 * caller passes `session.perms.team` and shows the consequence without a count
 * instead. Same shape as `useSalonBookings`, and the same reason: do not fire a
 * request whose refusal you would have to explain away.
 */
export function useStaff(enabled = true): UseQueryResult<Paginated<StaffUser>> {
  const salonId = useSalonId();
  return useQuery({
    queryKey: staffKeys.list(salonId),
    queryFn: ({ signal }) => authedRequest<Paginated<StaffUser>>('merchant', '/staff', { signal }),
    enabled,
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

/** `branchAccess` on the wire: the sentinel, or a list of branch IDS. */
export type BranchAccess = 'all' | string[];

/**
 * What `PATCH /staff/{id}` accepts. Any one of the three, or a combination.
 *
 * Sending only what moved is not an optimisation, it is the difference between
 * an audit row that reads `role frontdesk→manager` and one that also claims
 * nine permissions and a branch list were "changed" to their current values.
 * The server diffs against the stored row and only writes what actually moved,
 * so a full echo would be harmless to the data and misleading in the log.
 */
export interface StaffPatch {
  perms?: Partial<StaffPerms>;
  role?: string;
  branchAccess?: BranchAccess;
}

/**
 * ONE MUTATION FOR ALL THREE WRITABLE THIRDS OF A STAFF ROW.
 *
 * This was `useSetPermissions` and sent `{ perms }` only, because the endpoint
 * took `perms` only. It now parses `role` and `branchAccess` too
 * (api/src/routes/staff.ts), which is what turns the design's role and
 * branch-access selects from rendered facts into real controls.
 */
export function useUpdateStaff(): UseMutationResult<
  StaffUser,
  unknown,
  { staffId: string; patch: StaffPatch }
> {
  const salonId = useSalonId();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ staffId, patch }) =>
      authedRequest<StaffUser>('merchant', `/staff/${staffId}`, {
        method: 'PATCH',
        body: patch,
      }),
    /*
     * The response IS the updated staff row through the same `serialiseStaff`
     * the list uses — checked, unlike PATCH /salons/{id}, which returns a raw
     * row and cannot be cached. So the row is patched in place: no refetch, and
     * the chips settle on what the server stored rather than on what was
     * clicked. That difference matters here, because revoking `charges` also
     * revokes `void` server-side and the response is where that shows up.
     */
    onSuccess: (updated) => patchRow(queryClient, salonId, updated),
  });
}

/**
 * `POST /staff` → 201 with the new row.
 *
 * NO PASSWORD FIELD, AND THAT IS A DELIBERATE DEPARTURE FROM THE DESIGN.
 *
 * `AVO Merchant Dashboard.dc.html:503` draws a "Temporary password" input on the
 * new-account form — "At least 6 characters" — and tells the manager "the
 * teammate signs in with this username & password, then sets their own on first
 * login". That cannot be built. Non-negotiable #6: a password is never stored in
 * plaintext, never returned by an endpoint, never shown in a UI, and the console
 * only ever sends a reset link. The endpoint agrees and enforces it —
 * `refuseCredentialFields` 400s on a `password` key — and lane A's comment gives
 * the reason plainly: a password typed here is a plaintext password in a request
 * log, a browser's memory and somebody's clipboard, and "only at onboarding" is
 * how it stays there for ever.
 *
 * So the field is not rendered. A created account comes back `passwordSet:
 * false`, the card shows "Invite pending", and access is established the one way
 * the non-negotiable allows: `sendPasswordReset` below.
 */
export interface CreateStaffInput {
  name: string;
  handle: string;
  role: string;
  branchAccess: BranchAccess;
  perms: Partial<StaffPerms>;
}

export function useCreateStaff(): UseMutationResult<StaffUser, unknown, CreateStaffInput> {
  const salonId = useSalonId();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input) =>
      authedRequest<StaffUser>('merchant', '/staff', { method: 'POST', body: input }),
    /*
     * Appended rather than refetched, for the same reason the patch is applied
     * in place: the 201 body is the serialised row. `invalidateQueries` would
     * work and would also blank the roster for a beat on a slow connection,
     * right after an action whose whole point was that something new appeared.
     */
    onSuccess: (created) => {
      queryClient.setQueryData<Paginated<StaffUser>>(staffKeys.list(salonId), (current) =>
        current ? { ...current, items: [...current.items, created] } : current,
      );
    },
  });
}

/**
 * `DELETE /staff/{id}` → 200 with the deactivated row.
 *
 * A DEACTIVATION, NOT A DELETE, and the UI must not call it deletion. The row
 * survives because `transaction.created_by_staff_id` and `audit_log`'s actor
 * reference it: her row is what makes a two-year-old charge still say who took
 * it. What leaves is the credentials — password and PIN nulled, every session
 * revoked, any live reset link spent — immediately, on both surfaces.
 *
 * Two refusals to expect and render rather than prevent: `cannot_deactivate_self`
 * (409) and the last holder of `perms.team` (the salon would lose its own
 * Accounts screen).
 */
export function useDeactivateStaff(): UseMutationResult<
  StaffUser,
  unknown,
  { staffId: string }
> {
  const salonId = useSalonId();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ staffId }) =>
      authedRequest<StaffUser>('merchant', `/staff/${staffId}`, { method: 'DELETE' }),
    onSuccess: (updated) => patchRow(queryClient, salonId, updated),
  });
}

/**
 * `POST /staff/{id}/password-reset` → 202.
 *
 * NON-NEGOTIABLE #6, the whole of it. The response carries `expiresAt`,
 * `delivered` and `reactivating` — no token, no link, no password. There is
 * nothing here for a UI to leak, and the confirmation the design shows ("Link
 * sent") is the correct amount of information.
 *
 * 202 and not 200 because delivery has NOT happened when this returns: no sender
 * is wired yet (the WhatsApp templates are unapproved and the sending domain is
 * an open client decision), and `staff_password_reset` is the outbox waiting for
 * one. So the UI says a link was sent and when it stops working, and does not
 * claim it has arrived.
 *
 * Issuing a second link SPENDS the first, server-side. Worth knowing before
 * offering a "resend" that silently invalidates the link somebody is already
 * walking to a desk with.
 */
export interface PasswordResetAccepted {
  staffId: string;
  /** ISO instant. The link stops working here. */
  expiresAt: string;
  /** False today — accepted for delivery, not delivered. */
  delivered: boolean;
  /** True when the target is a leaver: this is a re-hire invitation. */
  reactivating: boolean;
}

export function useSendPasswordReset(): UseMutationResult<
  PasswordResetAccepted,
  unknown,
  { staffId: string }
> {
  return useMutation({
    mutationFn: ({ staffId }) =>
      authedRequest<PasswordResetAccepted>('merchant', `/staff/${staffId}/password-reset`, {
        method: 'POST',
      }),
    /*
     * No cache write. A reset link changes nothing on the staff row — the
     * account keeps whatever credential state it had, and a deactivated one
     * stays deactivated until she redeems the link. Patching the roster here
     * would be inventing a state change the server did not make.
     */
  });
}

/** One place that knows how a single row is replaced inside the paginated list. */
function patchRow(
  queryClient: ReturnType<typeof useQueryClient>,
  salonId: string,
  updated: StaffUser,
): void {
  queryClient.setQueryData<Paginated<StaffUser>>(staffKeys.list(salonId), (current) =>
    current
      ? { ...current, items: current.items.map((s) => (s.id === updated.id ? updated : s)) }
      : current,
  );
}
