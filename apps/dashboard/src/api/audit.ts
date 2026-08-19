import { useInfiniteQuery, type UseInfiniteQueryResult, type InfiniteData } from '@tanstack/react-query';
import { authedRequest } from '../auth/authedRequest.js';
import { useSalonId } from '../auth/AuthProvider.js';

/**
 * `GET /salons/{id}/audit` — `perms.dashboard`.
 *
 * Deliberately NOT `perms.team` or `perms.loyalty`: a manager who can see the
 * salon's numbers can see who changed them, and splitting the log by the
 * permission each row happens to concern would produce a partial history, which
 * is the one thing an audit log must never be.
 *
 * There is no POST and there never will be. Rows are written by the handlers
 * that cause them, inside the same transaction as the effect they describe, and
 * UPDATE/DELETE are revoked from the application role at the database. The
 * `appendOnly` flag on the response says so; the migration enforces it.
 */

export const AUDIT_KINDS = ['money', 'rules', 'access', 'risk'] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

export interface AuditEntry {
  id: string;
  /** bigserial. Strictly monotonic in write order — the cursor and the ordering. */
  seq: number;
  /** ISO instant. The server sends the moment; the phrasing is ours. */
  when: string;
  who: string;
  role: string;
  actorKind: string;
  actorId: string | null;
  kind: AuditKind;
  action: string;
  detail: string;
  /**
   * Null on a platform action belonging to no salon. On the wire for BOTH reads —
   * `serialiseAuditRow` emits one shape on purpose ("emitting it from one
   * serialiser is cheaper than two shapes that drift") — but only the console has
   * a use for it: every row the merchant can see already carries her own salon id
   * by construction.
   */
  salonId: string | null;
  source: string;
  /** "Owner console", "Merchant", "Scanner", "Wallet", "System" — server copy. */
  sourceLabel: string;
  /** True for an AVO platform action on this salon. */
  isPlatformAction: boolean;
  subjectType: string | null;
  subjectId: string | null;
  /** Present on money rows. Integer fils. */
  amountFils: number | null;
}

export interface AuditPage {
  items: AuditEntry[];
  /** How many rows match the filter, not how many are on this page. */
  total: number;
  nextCursor: number | null;
  appendOnly: boolean;
  retentionYears: number;
}

export interface AuditFilters {
  /** Search across who / role / action / detail. Matched server-side. */
  q: string;
  /** null means All — no kind predicate. */
  kind: AuditKind | null;
}

export const auditKeys = {
  list: (salonId: string, filters: AuditFilters) => ['audit', salonId, filters] as const,
};

/**
 * FILTERING AND SEARCH ARE THE SERVER'S JOB, NOT A CLIENT ARRAY FILTER.
 *
 * The design filters an in-memory list because the prototype holds every row.
 * A real salon's log is years deep and paginated 50 at a time, so a client-side
 * filter would search the current page and confidently report "No entries match
 * that search" about a log it has never seen. `q` and `kind` go to the API,
 * which also returns `total` for the matching set rather than for the page.
 */
export function useAuditLog(
  filters: AuditFilters,
): UseInfiniteQueryResult<InfiniteData<AuditPage>> {
  const salonId = useSalonId();

  return useInfiniteQuery({
    queryKey: auditKeys.list(salonId, filters),
    initialPageParam: null as number | null,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams();
      if (filters.q.trim() !== '') params.set('q', filters.q.trim());
      if (filters.kind) params.set('kind', filters.kind);
      if (pageParam !== null) params.set('cursor', String(pageParam));
      const query = params.toString();
      return authedRequest<AuditPage>(
        'merchant',
        `/salons/${salonId}/audit${query ? `?${query}` : ''}`,
        { signal },
      );
    },
    getNextPageParam: (last) => last.nextCursor,
    // Retry policy is global — api/retryPolicy.ts. `perms.dashboard` gates this
    // endpoint, and an infinite query would have paid the wasted round trip on
    // every page fetch, not just the first.
  });
}

/* ------------------------------------------------------------- the console -- */

/**
 * `GET /v1/platform/audit` — section `audit`, `requirePlatform`.
 *
 * THE SAME LOG, SCOPED TO NOTHING. The server's `auditRead.ts` is explicit that
 * the two reads share the filter grammar, the cursor rule, the search escaping
 * and the row shape, and differ ONLY in scoping: the merchant's read filters to
 * her salon, the console's has no tenancy boundary at all and additionally sees
 * the null-salon rows that are the platform's own business. That is why this
 * hook lives in this file rather than a second one — a `kind` chip that meant
 * something slightly different on the console than on the dashboard would turn
 * "these two screens disagree" into a question about the record itself.
 *
 * `AUDIT_KINDS` above is the one client list, used by both screens — the same
 * census discipline the server applies by exporting its own `AUDIT_KINDS` to
 * both routes. The server refuses anything else with `invalid_kind`, so a drift
 * here is caught loudly on the first request rather than silently filtering
 * nothing.
 *
 * `scope` is the one filter the merchant's read can never express:
 *
 *   null         every row — salon-scoped AND the platform's own
 *   'platform'   the `?salon=platform` literal: null-salon rows only, "AVO's own
 *                actions". A literal rather than a magic empty string, so it
 *                cannot be produced by an accidentally blank query parameter.
 *
 * A PER-SALON narrowing (`?salon=SAL-…`) exists server-side and is deliberately
 * not surfaced yet: there is no platform salons-list endpoint (the console's
 * Salons section is not built), so the only honest control would be a free-text
 * id box. Named in the lane report, not faked with a hand-typed list.
 */
export interface PlatformAuditFilters extends AuditFilters {
  scope: 'platform' | null;
}

export const platformAuditKeys = {
  list: (filters: PlatformAuditFilters) => ['platform', 'audit', filters] as const,
};

export function usePlatformAuditLog(
  filters: PlatformAuditFilters,
): UseInfiniteQueryResult<InfiniteData<AuditPage>> {
  return useInfiniteQuery({
    queryKey: platformAuditKeys.list(filters),
    initialPageParam: null as number | null,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams();
      if (filters.q.trim() !== '') params.set('q', filters.q.trim());
      if (filters.kind) params.set('kind', filters.kind);
      if (filters.scope) params.set('salon', filters.scope);
      if (pageParam !== null) params.set('cursor', String(pageParam));
      const query = params.toString();
      return authedRequest<AuditPage>(
        'owner',
        `/v1/platform/audit${query ? `?${query}` : ''}`,
        { signal },
      );
    },
    getNextPageParam: (last) => last.nextCursor,
  });
}
