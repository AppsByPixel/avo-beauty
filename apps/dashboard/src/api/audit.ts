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
