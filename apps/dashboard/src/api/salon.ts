import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { Salon, Transaction } from '@avo/types';
import { authedRequest } from '../auth/authedRequest.js';
import { useSalonId } from '../auth/AuthProvider.js';

/**
 * `GET /salons/{id}/metrics`.
 *
 * NOTE — this shape is not in `packages/types`. The API serves it, the contract
 * documents it, but there is no `SalonMetricsSchema`, so this is a hand-written
 * mirror rather than a shared type. Flagged in the lane report: it belongs in
 * `packages/types/src/entities.ts` (trunk-owned), not here.
 */
export interface SalonMetrics {
  activeMembers: number;
  activeMembersDelta: number;
  /** Integer fils. Non-negotiable #1 — cast through `fils()` at the display boundary. */
  loadedTodayFils: number;
  knetSharePercent: number;
  repeatRatePercent: number;
  upcomingAppointments: number;
}

/*
 * THE SALON ID IS NOT A PARAMETER OF THESE HOOKS.
 *
 * It used to be, and every caller then had to find one to pass — which is how a
 * `FALLBACK_SALON_ID ?? ` crept into three call sites. Reading it from the
 * session inside the hook removes the opportunity: there is no argument to get
 * wrong, and no screen can address a salon other than the one it is signed in
 * to. `useSalonId()` in auth/AuthProvider.tsx is the single accessor.
 *
 * The id is still in the query KEY, because the cache must not serve one
 * salon's figures to the next session on a shared front-desk machine.
 */
export const salonKeys = {
  all: ['salon'] as const,
  detail: (salonId: string) => [...salonKeys.all, salonId] as const,
  metrics: (salonId: string) => [...salonKeys.detail(salonId), 'metrics'] as const,
  charges: (salonId: string) => [...salonKeys.detail(salonId), 'charges'] as const,
};

/**
 * `enabled` exists so a shell rendering without a session — the tick between
 * sign-out and the redirect landing — does not fire an unauthenticated request
 * on its way out.
 */
export function useSalon(enabled = true): UseQueryResult<Salon> {
  const salonId = useSalonId();
  return useQuery({
    queryKey: salonKeys.detail(salonId),
    queryFn: ({ signal }) => authedRequest<Salon>('merchant', `/salons/${salonId}`, { signal }),
    enabled,
    /*
     * No `retry` here, and the measurement that used to justify one is now the
     * global default. It is worth keeping the number: on TanStack's built-in
     * three-retries-with-backoff, Settings took about five seconds to show its
     * error while every other section took about two, and five seconds of an
     * apparently-working settings screen is how a merchant concludes a toggle
     * saved. api/retryPolicy.ts keeps that budget AND the 401/403 short-circuit
     * that the bare `retry: 1` here silently threw away.
     */
  });
}

export function useSalonMetrics(): UseQueryResult<SalonMetrics> {
  const salonId = useSalonId();
  return useQuery({
    queryKey: salonKeys.metrics(salonId),
    queryFn: ({ signal }) =>
      authedRequest<SalonMetrics>('merchant', `/salons/${salonId}/metrics`, { signal }),
    /*
     * Stale-not-blank (interaction-spec.md §4). A failed refresh must keep the
     * last-known figures on screen behind a timestamped banner, so the cached
     * value survives the error — TanStack does that on its own — and the retry
     * budget stays small enough that the banner appears promptly. The budget is
     * the shared one now; only `refetchInterval` is this hook's own.
     */
    refetchInterval: 60_000,
  });
}

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Recent activity.
 *
 * `GET /charges` is the only salon-scoped transaction stream in the contract, so
 * the feed is charges only. The designed feed mixes top-ups, deposit returns,
 * tier changes and shop purchases — that needs an endpoint that does not exist.
 * Flagged in the lane report rather than faked here.
 *
 * The path carries no salon id: the API scopes it to `principal.salonId` server
 * side. That is the shape every salon-scoped endpoint should have, and it is why
 * a client-named salon was never the real exposure here.
 */
export function useRecentActivity(): UseQueryResult<Paginated<Transaction>> {
  const salonId = useSalonId();
  return useQuery({
    queryKey: salonKeys.charges(salonId),
    queryFn: ({ signal }) =>
      authedRequest<Paginated<Transaction>>('merchant', '/charges', { signal }),
    /*
     * No `retry`. This is the hook where the old override cost the most: a web
     * principal reading `GET /charges` gets a 403 by design — charging happens on
     * the scanner — so the refusal is the NORMAL answer here, and `retry: 1` made
     * every Overview load pay for a second request that could only be refused
     * again before the explain state appeared.
     */
  });
}
