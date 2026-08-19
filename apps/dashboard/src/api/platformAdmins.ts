import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { authedRequest } from '../auth/authedRequest.js';
import {
  PLATFORM_SECTIONS,
  parsePlatformAdmin,
  type PlatformAdmin,
  type PlatformRole,
  type PlatformSection,
  type PlatformSections,
} from '../auth/platformAdmin.js';

/**
 * The owner console's Admins section — its own file because it is its own route
 * file on the server (`api/src/routes/platformAdmins.ts`) and its own section
 * permission.
 *
 * EVERY ROUTE HERE IS `requirePlatform(req, 'admins')`. Checked against the
 * handlers, not against the name that sounds right — all four name the same
 * section, so there is no finer split to mirror and no read that is ungated:
 *
 *   GET    /v1/platform/admins        admins   platformAdmins.ts:117
 *   POST   /v1/platform/admins        admins   platformAdmins.ts:123
 *   PATCH  /v1/platform/admins/{id}   admins   platformAdmins.ts:201
 *   DELETE /v1/platform/admins/{id}   admins   platformAdmins.ts:307
 *
 * NO CLIENT COURTESY GATE IS NEEDED, and that is a decision rather than an
 * oversight — the shape `sectionState.tsx` § THE COURTESY-GATE LEDGER says to
 * check for. A gate is needed only where the READ is ungated and the WRITES are
 * not; here the read is gated too, so an admin without the section gets a 403 on
 * load and `SectionError` renders the server's own sentence ("Your console
 * account cannot manage admins. The platform owner can grant it."). A second
 * check on the client would duplicate the server and drift from it.
 *
 * The shell's sidebar still marks the item, which is a courtesy and not a
 * control — non-negotiable #7.
 */

export const adminKeys = {
  all: ['platform', 'admins'] as const,
};

/**
 * `{ items, nextCursor }`, like every list on this API. `nextCursor` is always
 * null here — the handler has no pagination and the console's admin list is a
 * short roster of named people — so it is read and discarded rather than
 * pretended into a paging control that could never advance.
 */
function parseAdminList(raw: unknown): PlatformAdmin[] {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { items?: unknown }).items)) {
    throw new Error('GET /v1/platform/admins did not return an { items: [] } envelope.');
  }
  return (raw as { items: unknown[] }).items.map((item, i) => {
    const parsed = parsePlatformAdmin(item);
    /*
     * A ROW THAT DOES NOT PARSE FAILS THE WHOLE LIST rather than being skipped.
     * `parsePlatformAdmin` returns null instead of throwing because its first
     * caller is sign-in, where an unreadable account has to become an
     * authentication failure with a sentence. Here the honest answer is the
     * opposite: silently dropping an admin from the roster would hide someone who
     * holds access, and this is the screen whose entire job is showing who does.
     */
    if (!parsed) {
      throw new Error(
        `GET /v1/platform/admins returned an admin this client cannot read (item ${i}). ` +
          'The console shape is hand-kept in auth/platformAdmin.ts — see its header.',
      );
    }
    return parsed;
  });
}

export function usePlatformAdmins(): UseQueryResult<PlatformAdmin[]> {
  return useQuery({
    queryKey: adminKeys.all,
    queryFn: async ({ signal }) => {
      const raw = await authedRequest<unknown>('owner', '/v1/platform/admins', { signal });
      return parseAdminList(raw);
    },
  });
}

/**
 * THE INVITE. `name` + `username` + `role`, AND NOTHING ELSE.
 *
 * NON-NEGOTIABLE #6 IS WHY THIS INTERFACE HAS THREE FIELDS. The design draws a
 * fourth — "Temporary password", placeholder "At least 6 characters" — and it is
 * not modelled here, not sent, and not drawn on the screen. The API refuses
 * `password` and `temporaryPassword` BY NAME with `password_not_accepted` rather
 * than ignoring them, precisely so a console that sent one cannot believe it set
 * a credential. Typing this field would be the first step toward doing that.
 *
 * `role` cannot be `owner`. The API answers 403 "There is one platform owner and
 * the role cannot be assigned" in either direction, so it is excluded from the
 * type as well as from the select — an endpoint that could grant `owner` could
 * grant every section to anybody, including the `admins` section being edited.
 */
export type AssignableRole = Exclude<PlatformRole, 'owner'>;

export interface InviteAdminInput {
  name: string;
  /** Sent without the '@'; the API strips one anyway and lowercases. */
  username: string;
  role: AssignableRole;
}

export function useInviteAdmin(): UseMutationResult<PlatformAdmin, unknown, InviteAdminInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input) => {
      const raw = await authedRequest<unknown>('owner', '/v1/platform/admins', {
        method: 'POST',
        body: { name: input.name, username: input.username, role: input.role },
      });
      const parsed = parsePlatformAdmin(raw);
      if (!parsed) throw new Error('POST /v1/platform/admins returned an admin this client cannot read.');
      return parsed;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.all });
    },
  });
}

/**
 * ROLE AND SECTIONS, in one PATCH.
 *
 * A ROLE CHANGE RESETS THE CHIPS TO THAT ROLE'S PRESET — the server does this,
 * the design does this (`onRole` replaces `perms` wholesale with
 * `adminPresets[r]`), and the client therefore must NOT send the old sections
 * alongside a new role or it would immediately undo the preset it asked for.
 * The API applies `role` first and `sections` on top, in that order, so the
 * outcome does not depend on key order — but sending both when only the role
 * changed is still the wrong request, so the screen sends one or the other.
 *
 * `sections` is a PARTIAL patch: the API validates each key against
 * `PLATFORM_SECTIONS` and each value as a boolean, and merges over what exists.
 * Sending the whole object back would overwrite a concurrent editor's other
 * chips — the same reasoning `useUpdateMessagingPolicy` carries.
 */
export interface UpdateAdminInput {
  id: string;
  role?: AssignableRole;
  sections?: Partial<PlatformSections>;
}

export function useUpdateAdmin(): UseMutationResult<PlatformAdmin, unknown, UpdateAdminInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, role, sections }) => {
      const raw = await authedRequest<unknown>(
        'owner',
        `/v1/platform/admins/${encodeURIComponent(id)}`,
        {
          method: 'PATCH',
          body: { ...(role ? { role } : {}), ...(sections ? { sections } : {}) },
        },
      );
      const parsed = parsePlatformAdmin(raw);
      if (!parsed) {
        throw new Error('PATCH /v1/platform/admins returned an admin this client cannot read.');
      }
      return parsed;
    },
    onSuccess: (admin) => {
      /*
       * The row is replaced from the RESPONSE rather than from the request. The
       * server may have done more than was asked — a role change resets nine
       * chips — and `PATCH /v1/salons/{id}` is the standing lesson about trusting
       * a write's own reply: it answered a shape no consumer could read and took
       * the whole Settings section to its error boundary. This one serialises
       * through `serialisePlatformAdmin`, the same function `GET` uses, which is
       * what makes caching it safe.
       */
      queryClient.setQueryData<PlatformAdmin[]>(adminKeys.all, (prev) =>
        prev ? prev.map((a) => (a.id === admin.id ? admin : a)) : prev,
      );
    },
  });
}

/**
 * THE ✕. Deactivates; it does not delete.
 *
 * 204, so there is no body to parse and the list is refetched. Three refusals the
 * server owns and the screen should not duplicate as logic, only as courtesy:
 * the owner cannot be removed, you cannot remove yourself, and an
 * already-inactive admin reads as absent.
 */
export function useDeactivateAdmin(): UseMutationResult<void, unknown, { id: string }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }) => {
      await authedRequest<void>('owner', `/v1/platform/admins/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.all });
    },
  });
}

/* ------------------------------------------------------------------ labels -- */

/**
 * The design's role copy, verbatim, in both the lengths it draws.
 *
 * `AVO Owner Console.dc.html` § ADMINS uses long labels on the invite form's
 * select and short ones on a row's select. Both are kept because both are drawn;
 * paraphrasing either would be a copy change, and CLAUDE.md settles copy.
 *
 * `owner` IS ABSENT FROM BOTH. It is not assignable, so it never appears in a
 * select — the owner's row renders the design's static "Owner · full access"
 * instead.
 */
export const ROLE_LABEL_LONG: Record<AssignableRole, string> = {
  admin: 'Full admin — everything',
  analyst: 'Analyst — read-only metrics',
  support: 'Support — accounts & salons',
};

export const ROLE_LABEL_SHORT: Record<AssignableRole, string> = {
  admin: 'Full admin',
  analyst: 'Analyst',
  support: 'Support',
};

/** Every role, including the one that cannot be assigned — for rendering a row. */
export const ROLE_LABEL: Record<PlatformRole, string> = {
  owner: 'Owner',
  ...ROLE_LABEL_SHORT,
};

export const ASSIGNABLE_ROLES: readonly AssignableRole[] = ['admin', 'analyst', 'support'];

/**
 * The nine section chips, in the server's order, with the design's labels.
 *
 * SIX ARE THE DESIGN'S `adminPermDefs`, VERBATIM. Three — approvals, policies,
 * audit — are not drawn by the design at all, and are here because the API gates
 * real endpoints on them: `requirePlatform(req, 'approvals')` decides campaigns,
 * `'policies'` publishes the legal set, `'audit'` reads the platform log.
 *
 * RENDERING ONLY THE DESIGN'S SIX WOULD BE THE DEFECT, not the faithful choice.
 * The two console sections this lane has already built are gated on `approvals`
 * and `policies`; a screen that cannot grant them leaves the only way to give a
 * new admin access to Approvals a hand-written UPDATE against `platform_admin`.
 * Over-gating is also a defect. Their labels match the nav items they unlock, so
 * they read as the sections they are.
 */
export const SECTION_LABEL: Record<PlatformSection, string> = {
  analytics: 'Analytics',
  activity: 'Activity',
  salons: 'Salons',
  accounts: 'Accounts',
  admins: 'Admins',
  controls: 'Controls',
  approvals: 'Approvals',
  policies: 'Policies',
  audit: 'Audit log',
};

/** The chips, in the order the server lists the sections. */
export const SECTION_ORDER: readonly PlatformSection[] = PLATFORM_SECTIONS;
