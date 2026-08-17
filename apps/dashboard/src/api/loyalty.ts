import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { Tier, TierName } from '@avo/types';
import { authedRequest } from '../auth/authedRequest.js';
import { useSalonId } from '../auth/AuthProvider.js';
import { salonKeys } from './salon.js';

/**
 * `GET`/`PUT /salons/{id}/loyalty` — both `perms.loyalty`.
 *
 * The ladder is fixed at four rungs in this order, and the API refuses anything
 * else ("The ladder is fixed: bronze → silver → gold → black"). It is declared
 * here so the editor cannot render five cards or reorder them.
 */
export const TIER_LADDER = ['bronze', 'silver', 'gold', 'black'] as const;
export type LadderTierName = (typeof TIER_LADDER)[number];

export const TIER_LABEL: Record<LadderTierName, string> = {
  bronze: 'Bronze',
  silver: 'Silver',
  gold: 'Gold',
  black: 'Black',
};

/**
 * The server's own preview of what a 10.000 KD top-up credits at each rung.
 *
 * `topUpFils` is stated rather than assumed — the API's comment is explicit that
 * a client must not hardcode 10000 — and every figure is integer fils.
 */
export interface TierPreview {
  name: LadderTierName;
  minVisits: number;
  bonusPercent: number;
  topUpFils: number;
  creditFils: number;
  bonusFils: number;
}

export interface LoyaltyConfig {
  loyaltyMode: 'tiers' | 'stamps';
  tiers: Tier[] | null;
  stampTarget: number | null;
  stampReward: string | null;
  stampRewardAr: string | null;
  /** Null in stamps mode — there is no top-up bonus to preview. */
  preview: TierPreview[] | null;
}

/** What `PUT` adds on top of the config it echoes back. */
export interface PublishedLoyalty extends LoyaltyConfig {
  publishedAt: string;
  publishedBy: string;
  /** "Tier rules published — customers see them now." Server-authored. */
  message: string;
  appliesAt: 'next_visit';
}

export const loyaltyKeys = {
  detail: (salonId: string) => ['loyalty', salonId] as const,
};

export function useLoyalty(): UseQueryResult<LoyaltyConfig> {
  const salonId = useSalonId();
  return useQuery({
    queryKey: loyaltyKeys.detail(salonId),
    queryFn: ({ signal }) =>
      authedRequest<LoyaltyConfig>('merchant', `/salons/${salonId}/loyalty`, { signal }),
    retry: 1,
  });
}

/**
 * Publish.
 *
 * THERE IS NO OPTIMISTIC UPDATE HERE, AND THAT IS THE REQUIREMENT.
 *
 * build-plan.md phase 4 calls a half-published ladder a money bug: a member who
 * tops up against a ladder that never existed is credited a bonus nobody set.
 * The API makes the write atomic — one jsonb column, one UPDATE, one transaction
 * with its audit row — but atomic on the server is only half the promise. If the
 * client paints the new ladder before the server accepts it, a rejected publish
 * leaves a merchant reading rungs that are not live and telling customers about
 * them.
 *
 * So the cache is only ever written from the server's response. A failed publish
 * leaves `useLoyalty().data` holding exactly what is still live, the editor keeps
 * the draft the merchant typed, and the status line says which is which.
 *
 * `setQueryData` rather than `invalidateQueries`: the PUT response IS the new
 * authoritative config, including the recomputed preview, so refetching it would
 * be a second round trip to learn what we were just told.
 */
export function usePublishLoyalty(): UseMutationResult<
  PublishedLoyalty,
  unknown,
  { mode: 'tiers' | 'stamps'; tiers?: Tier[]; stampTarget?: number; stampReward?: string }
> {
  const salonId = useSalonId();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body) =>
      authedRequest<PublishedLoyalty>('merchant', `/salons/${salonId}/loyalty`, {
        method: 'PUT',
        body,
      }),
    onSuccess: (published) => {
      queryClient.setQueryData<LoyaltyConfig>(loyaltyKeys.detail(salonId), {
        loyaltyMode: published.loyaltyMode,
        tiers: published.tiers,
        stampTarget: published.stampTarget,
        stampReward: published.stampReward,
        stampRewardAr: published.stampRewardAr,
        preview: published.preview,
      });
      /*
       * `GET /salons/{id}` serves the same ladder to the shell and to the wallet.
       * Leaving it cached would let a stale ladder reappear on the next screen
       * that reads the salon.
       */
      void queryClient.invalidateQueries({ queryKey: salonKeys.detail(salonId) });
    },
  });
}

export { type Tier, type TierName };
