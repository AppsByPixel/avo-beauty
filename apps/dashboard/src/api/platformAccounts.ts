import {
  useInfiniteQuery,
  useMutation,
  type InfiniteData,
  type UseInfiniteQueryResult,
  type UseMutationResult,
} from '@tanstack/react-query';
import { authedRequest } from '../auth/authedRequest.js';
import type { Paginated } from './salon.js';

/**
 * `GET /v1/platform/accounts` — the console's Accounts list, and the reset-link
 * write drawn on its rows.
 *
 * =========================================================================
 * THE WIDEST READ IN THE PRODUCT, AND THE GATE IS THE WHOLE SAFETY ARGUMENT
 * =========================================================================
 * `api/src/routes/accounts.ts` opens by saying it plainly: every other read of
 * `member` and `staff_user` in this API goes through `requireSameSalon`, and this
 * one has NO salon predicate at all. It crosses every tenant by design, because
 * the design's Accounts section is the platform-wide directory.
 *
 * So the control is `requirePlatform(req, 'accounts')`, which refuses on the
 * CREDENTIAL KIND before it refuses on authority — a merchant token, a scanner
 * PIN and a member token all fail with "This endpoint is the AVO owner console,
 * not the salon dashboard", because a merchant reaching this would turn one
 * salon's front desk into a platform-wide customer directory.
 *
 * WHAT THAT MEANS FOR THIS FILE: there is no courtesy gate to write, and no
 * client-side narrowing to add. The refusal arrives on its own with the server's
 * own sentence, which `SectionError` renders verbatim. Driven, as the analyst
 * `mariam.k` (`activity: true, accounts: false`):
 *
 *   GET  /v1/platform/activity        -> 200
 *   GET  /v1/platform/accounts        -> 403 "Your console account cannot open
 *                                             Accounts. The platform owner can
 *                                             grant it."
 *   POST /accounts/8842/reset-link    -> 403  (the same sentence — the WRITE is
 *                                             gated independently, not by the
 *                                             list having refused first)
 *
 * =========================================================================
 * NON-NEGOTIABLE #6 — AND THE SHAPE OF IT ON THIS SCREEN
 * =========================================================================
 * "Passwords are never stored in plaintext, never returned by an endpoint, never
 * shown in a UI." The design draws that sentence on this very screen.
 *
 * `passwordSet` is a BOOLEAN COMPUTED IN SQL. The endpoint deliberately never
 * selects `password_hash`, `pin_hash` or any reset token — the comparison happens
 * in the database and only the boolean crosses the boundary, so the hash never
 * enters the API process, let alone this one. There is nothing on this wire for
 * a client to leak, and this parser reads no such field because none is sent.
 *
 * The reset write is the same half of #6 from the other side: it answers 202 with
 * an expiry and NEVER the token, because "a link that returns through the
 * issuer's browser is a credential in the wrong hands." `SendResetResult` below
 * has no token field because the response has none.
 *
 * =========================================================================
 * NO CUSTOMER PHONE OR EMAIL, AND `handle` IS NULL FOR A CUSTOMER
 * =========================================================================
 * A DEPARTURE FROM THE DESIGN, made by the API and reported rather than papered
 * over here. `AVO Owner Console.dc.html` renders a handle on every row —
 * `@latifa.a` for a customer — and no such column exists on `member`; her login
 * identity is the PHONE. Deriving a handle would be inventing data, and serving
 * the phone would put every customer's number in the product's widest list.
 *
 * So `handle` is the staff member's real one and `null` for a customer, and the
 * screen renders nothing rather than a placeholder. It is parsed as nullable
 * because that is what the wire says, not because the screen happens to cope.
 *
 * =========================================================================
 * `total` IS NOT SERVED, AND THE DESIGN DOES NOT ASK FOR ONE
 * =========================================================================
 * Unlike `GET /v1/platform/audit`, this endpoint sends no `total`: counting it
 * means two more `count(*)` scans on every page, and the sum of two counts is not
 * the count of the merged list. The design's own count line reads "{{ acctCount }}
 * shown" — SHOWN, not "total" — so the screen renders the number of rows it is
 * actually holding and promises nothing it cannot count. No `?? 0` reaches a
 * caption while pending; there is no total to fabricate.
 */

/* ------------------------------------------------------------------ the row -- */

/**
 * The four filter chips the design draws: All, Customers, Staff, Owners.
 *
 * `owner` is a `staff_user` whose `role` is `owner`, not a third table — the
 * server's `ROLE_FILTERS`, and `POST /accounts/{id}/reset-link` reasons the same
 * way: "A salon owner is a staff_user, so the design's third role is
 * `kind: 'staff'`." `staff` means every staff row INCLUDING owners, because a
 * list that hid the owner from the Staff chip would hide the one person a console
 * admin is most likely looking for.
 *
 * Mirrored from the server's exported list rather than invented: it refuses
 * anything else with `invalid_role`, so a drift is caught loudly on the first
 * request rather than silently filtering nothing.
 */
export const ACCOUNT_ROLE_FILTERS = ['all', 'customer', 'staff', 'owner'] as const;
export type AccountRoleFilter = (typeof ACCOUNT_ROLE_FILTERS)[number];

/**
 * ONE STATE RATHER THAN THREE NULLABLE TIMESTAMPS, resolved server-side.
 *
 * The two tables spell "not usable any more" differently and the PRECEDENCE is
 * the part that matters: `member_erased_requires_request` makes both `erasedAt`
 * and `deletionRequestedAt` true on a tombstone, and only the first is the useful
 * answer. The endpoint resolves it so "the console's disabled states cannot
 * disagree with what the write door will do" — which is exactly what this screen
 * relies on when it disables the reset button on `erased`.
 */
export type AccountStatus = 'active' | 'deletion_requested' | 'erased' | 'deactivated';

export interface PlatformAccount {
  id: string;
  /** The field `POST /accounts/{id}/reset-link` REQUIRES in its body. */
  kind: 'customer' | 'staff';
  name: string;
  /** The staff member's real login handle. `null` for a customer — see the header. */
  handle: string | null;
  /** `'customer'`, or one of `staffRole`: owner / manager / frontdesk / artist / scanner. */
  role: string;
  salonId: string;
  /** The salon pill the design draws on every row, already a NAME on the wire. */
  salon: string;
  /** NON-NEGOTIABLE #6. A boolean computed in SQL, never the hash. */
  passwordSet: boolean;
  status: AccountStatus;
  createdAt: string;
}

/* --------------------------------------------------------------- the parser -- */

/*
 * PARSE HELPERS, LOCAL TO THIS FILE — the shape `platformConsole.ts` keeps for
 * `parsePlatformMetrics`, `platformSalons.ts` for `str` and `salon.ts` for the
 * activity feed. Small enough that a shared module would buy less than the import.
 */
function str(v: unknown, where: string): string {
  if (typeof v !== 'string') throw new Error(`${where} was not a string.`);
  return v;
}

function bool(v: unknown, where: string): boolean {
  if (typeof v !== 'boolean') throw new Error(`${where} was not a boolean.`);
  return v;
}

const STATUSES: readonly string[] = ['active', 'deletion_requested', 'erased', 'deactivated'];

/**
 * PARSED FIELD BY FIELD AGAINST THE REAL RESPONSE, not against an assumption.
 *
 * A SCHEMA NARROWER THAN THE WIRE SILENTLY STRIPS FIELDS in this codebase — this
 * build has found seven such drifts, and the Overview's response turned out never
 * to be the shape its own code claimed. So every key the endpoint documents is
 * read here, including the ones this screen does not currently draw:
 *
 *   `salonId`   the row renders `salon` (a NAME, already resolved server-side by
 *               a LEFT JOIN). The id is parsed anyway — it is what any per-salon
 *               narrowing would key on, and the next reader should find the
 *               record whole rather than discover a hole.
 *   `createdAt` not drawn. It is the CURSOR's own ordering column and the field a
 *               "joined" column would use.
 *   `handle`    drawn only for staff, because it is null for everyone else.
 *
 * The shape was verified against a live response from this endpoint before the
 * parser was written, rather than transcribed from the interface — see the lane
 * report for the captured payload.
 */
export function parsePlatformAccounts(raw: unknown): Paginated<PlatformAccount> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('GET /v1/platform/accounts did not answer an object.');
  }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.items)) throw new Error('accounts.items was not an array.');

  return {
    items: r.items.map((row, i) => {
      if (typeof row !== 'object' || row === null) {
        throw new Error(`accounts.items[${i}] was not an object.`);
      }
      const it = row as Record<string, unknown>;

      const kind = str(it.kind, `accounts.items[${i}].kind`);
      if (kind !== 'customer' && kind !== 'staff') {
        // Not tolerated as a passthrough: `kind` is the field the reset write
        // REQUIRES, and a third value would be a row whose action this screen
        // cannot send correctly.
        throw new Error(`accounts.items[${i}].kind was "${kind}".`);
      }

      const status = str(it.status, `accounts.items[${i}].status`);
      if (!STATUSES.includes(status)) {
        // A status this client does not know would silently render as "active"
        // in a `?:` chain — including, in the worst case, on a tombstone.
        throw new Error(`accounts.items[${i}].status was "${status}".`);
      }

      return {
        id: str(it.id, `accounts.items[${i}].id`),
        kind,
        name: str(it.name, `accounts.items[${i}].name`),
        handle: it.handle === null ? null : str(it.handle, `accounts.items[${i}].handle`),
        role: str(it.role, `accounts.items[${i}].role`),
        salonId: str(it.salonId, `accounts.items[${i}].salonId`),
        salon: str(it.salon, `accounts.items[${i}].salon`),
        passwordSet: bool(it.passwordSet, `accounts.items[${i}].passwordSet`),
        status: status as AccountStatus,
        createdAt: str(it.createdAt, `accounts.items[${i}].createdAt`),
      };
    }),
    /*
     * The composite `(at, rank, id)` cursor again — two tables merged, so no
     * single monotonic column. Carried back opaquely; `services/streamCursor.ts`
     * owns the format.
     */
    nextCursor:
      r.nextCursor === undefined || r.nextCursor === null
        ? null
        : str(r.nextCursor, 'accounts.nextCursor'),
  };
}

/* ----------------------------------------------------------------- the read -- */

export interface AccountFilters {
  /** Matched SERVER-SIDE across name, salon name and (for staff) handle. */
  q: string;
  role: AccountRoleFilter;
}

export const platformAccountKeys = {
  all: ['platform', 'accounts'] as const,
  list: (filters: AccountFilters) => ['platform', 'accounts', filters] as const,
};

/**
 * FILTERING AND SEARCH ARE THE SERVER'S JOB, NOT A CLIENT ARRAY FILTER.
 *
 * The design filters an in-memory list of seven rows. The real list is every
 * customer and every staff member on the platform, paged 50 at a time, so a
 * client-side filter would search the current page and confidently report "no
 * accounts match" about a directory it has never seen. `q` and `role` go to the
 * API.
 *
 * `q` IS SENT UNTHROTTLED BY THIS HOOK AND DEBOUNCED BY THE SCREEN, for the
 * reason `Audit.tsx` debounces: the `ILIKE` runs across every tenant's rows.
 *
 * THERE IS NO MINIMUM QUERY LENGTH, and the difference from
 * `services/memberSearch.ts` is deliberate rather than an oversight on either
 * side. That box needs a two-character floor because it is STAFF-facing and a
 * short query is how a salon's front desk walks the customer name space from a
 * tablet. A console admin holding `accounts` is entitled to the unfiltered list
 * and gets it by sending no query at all, so a floor here would restrict nothing
 * and would only break "search for everyone called A".
 *
 * WHICH MEANS THIS SCREEN MUST NOT FIGHT THE RATE LIMITER BEHIND THAT OTHER BOX.
 * It does not touch it: `memberSearch.ts`'s two tiers are counted off `audit_log`
 * rows written by `GET /members`, the SCANNER-scoped search behind `perms.scanner`.
 * This is a different endpoint, on a different gate, and it writes no audit row
 * per lookup at all. The debounce is here to spare the database the `ILIKE`, not
 * to dodge a limiter that is not watching this door.
 */
export function usePlatformAccounts(
  filters: AccountFilters,
): UseInfiniteQueryResult<InfiniteData<Paginated<PlatformAccount>>> {
  return useInfiniteQuery({
    queryKey: platformAccountKeys.list(filters),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const params = new URLSearchParams();
      if (filters.q.trim() !== '') params.set('q', filters.q.trim());
      if (filters.role !== 'all') params.set('role', filters.role);
      if (pageParam !== null) params.set('cursor', pageParam);
      const query = params.toString();
      const raw = await authedRequest<unknown>(
        'owner',
        `/v1/platform/accounts${query ? `?${query}` : ''}`,
        { signal },
      );
      return parsePlatformAccounts(raw);
    },
    getNextPageParam: (last) => last.nextCursor,
  });
}

/* ---------------------------------------------------------------- the write -- */

/**
 * `POST /accounts/{id}/reset-link`, 202. The design's "Send reset link" button.
 *
 * NOT A FOURTH RESET FLOW — a fourth ISSUER DOOR into the two that exist. Same
 * tables, same token mint and sha256 storage, same 60-minute TTL, and the same
 * redeem endpoints the staff member and the customer already use. Nothing new to
 * redeem and nothing new to leak.
 *
 * `kind` IS SENT EXPLICITLY AND IS NOT INFERRED SERVER-SIDE, at the server's
 * insistence: "Ids are opaque by contract, so nothing guarantees the two id
 * spaces stay disjoint… The console's list knows the role of every row it
 * renders; making it say so costs one field and removes a class of wrong-account
 * resets." This is the list that knows, so the row's own `kind` is passed
 * through unchanged — never re-derived from `role`, which would put "owner"
 * through a second mapping that could disagree.
 *
 * NO IDEMPOTENCY KEY, and that is correct rather than an omission of
 * non-negotiable #4. #4 covers money-moving POSTs — top-ups, charges, orders,
 * voids. This moves no money. It is also idempotent in the way that matters
 * anyway: issuing spends any outstanding link for the same account in the same
 * transaction, so a double-click yields one live token, not two.
 *
 * NO PASSWORD IS EVER SENT. The endpoint refuses `password` and
 * `temporaryPassword` BY NAME — "The console never sets a password. The account
 * holder receives a reset link and sets her own" — and this client has no field
 * to put one in.
 */
export interface SendResetInput {
  id: string;
  kind: 'customer' | 'staff';
}

export interface SendResetResult {
  accountId: string;
  kind: 'customer' | 'staff';
  /** ISO instant, 60 minutes out. */
  expiresAt: string;
  /**
   * HONESTLY FALSE TODAY. The sender is unwired across all four issuers, so the
   * row is minted and nothing is delivered. The screen says "Link sent" per the
   * design; this field is what a later slice would use to stop it saying so.
   */
  delivered: boolean;
  /** Staff only: the link will re-activate a deactivated account on redemption. */
  reactivating?: boolean;
}

/*
 * NO `onSuccess` INVALIDATION, AND THE ABSENCE IS THE DECISION.
 *
 * Issuing a link changes no field this list serves — not `passwordSet` (the hash
 * is untouched until she redeems it), not `status` (a deactivated staff member
 * stays deactivated until redemption). Refetching every tenant's accounts to
 * redraw one button would re-run the widest read in the product for nothing.
 *
 * So the "Link sent" state is the SCREEN's own, exactly as the design models it:
 * there is no server field recording that a link is outstanding, and inventing
 * one here would be a client claiming to know something the record does not say.
 */
export function useSendResetLink(): UseMutationResult<SendResetResult, unknown, SendResetInput> {
  return useMutation({
    mutationFn: async ({ id, kind }: SendResetInput) => {
      const raw = await authedRequest<unknown>('owner', `/accounts/${id}/reset-link`, {
        method: 'POST',
        body: { kind },
      });
      if (typeof raw !== 'object' || raw === null) {
        throw new Error('POST /accounts/{id}/reset-link did not answer an object.');
      }
      const r = raw as Record<string, unknown>;
      const answered = str(r.kind, 'reset.kind');
      if (answered !== 'customer' && answered !== 'staff') {
        throw new Error(`reset.kind was "${answered}".`);
      }
      return {
        accountId: str(r.accountId, 'reset.accountId'),
        kind: answered,
        expiresAt: str(r.expiresAt, 'reset.expiresAt'),
        delivered: bool(r.delivered, 'reset.delivered'),
        ...(r.reactivating === undefined
          ? {}
          : { reactivating: bool(r.reactivating, 'reset.reactivating') }),
      };
    },
  });
}
