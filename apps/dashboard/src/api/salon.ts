import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { Salon, Transaction } from '@avo/types';
import { request } from './client.js';

/**
 * `GET /salons/{id}/metrics`.
 *
 * NOTE — this shape is not in `packages/types`. The mock serves it, the contract
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
export function useSalon(
  salonId: string,
  token: string | null,
  enabled = true,
): UseQueryResult<Salon> {
  return useQuery({
    queryKey: salonKeys.detail(salonId),
    queryFn: ({ signal }) => request<Salon>(`/salons/${salonId}`, { signal, token }),
    enabled,
  });
}

export function useSalonMetrics(
  salonId: string,
  token: string | null,
): UseQueryResult<SalonMetrics> {
  return useQuery({
    queryKey: salonKeys.metrics(salonId),
    queryFn: ({ signal }) => request<SalonMetrics>(`/salons/${salonId}/metrics`, { signal, token }),
    /*
     * Stale-not-blank (interaction-spec.md §4). A failed refresh must keep the
     * last-known figures on screen behind a timestamped banner, so the cached
     * value survives the error and the retry budget stays small enough that the
     * banner appears promptly rather than after four silent attempts.
     */
    retry: 1,
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
 */
export function useRecentActivity(
  salonId: string,
  token: string | null,
): UseQueryResult<Paginated<Transaction>> {
  return useQuery({
    queryKey: salonKeys.charges(salonId),
    queryFn: ({ signal }) => request<Paginated<Transaction>>('/charges', { signal, token }),
    retry: 1,
  });
}
