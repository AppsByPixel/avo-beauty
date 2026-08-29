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
import { platformSalonDetailKey, platformSalonKeys } from './platformSalonKeys.js';
import { salonKeys } from './salon.js';

/**
 * `GET /salons/{id}/loyalty` and `PUT /salons/{id}/loyalty` — ONE endpoint pair,
 * TWO principals, and the authority behind them is no longer the same.
 *
 *   GET  merchant `perms.loyalty` + same-salon · console `sections.salons`
 *   PUT  console `sections.salons` ONLY — a merchant gets 403 `loyalty_read_only`
 *
 * ==========================================================================
 * LOYALTY AUTHORITY MOVED FROM THE MERCHANT TO AVO. A REVERSAL, NOT A GAP.
 * ==========================================================================
 * Aftab, verbatim: *"Owner console will control the loyalty part not the
 * merchant (it will be read only for merchant)."* `design/README.md:136` records
 * the decision being reversed in the past tense of something finished —
 * "(This closes the phase-2 open item — merchants now edit their own tier
 * rules.)" — and line 283 lists "merchant-editable tier rules" among the items
 * CLOSED in an earlier revision.
 *
 * So `usePublishLoyalty` — the merchant's publish mutation, which used to sit in
 * this file with a long note about never painting a ladder the server has not
 * accepted — IS GONE rather than left unreachable. It was built correctly and is
 * withdrawn. Dead machinery that still looks live is this project's most-recorded
 * defect, and a mutation nothing calls is the version of it a typecheck cannot
 * see: `apps/dashboard` compiles green with an exported hook no screen imports.
 *
 * BOTH SIDES OF THE PAIR LIVE HERE, one file per server route file, and the
 * console's half is spelled with `authedRequest('owner', …)` against the SAME
 * path. There is no `/v1/platform/salons/{id}/loyalty`; `routes/loyalty.ts` says
 * why at length, and its short version is that a second console-spelled pair
 * would be a second transaction writing `salon.tiers` with nobody watching it.
 * The authority is resolved from the PRINCIPAL, so the URL does not change.
 */

/**
 * The ladder is fixed at four rungs in this order, and the API refuses anything
 * else ("The ladder is fixed: bronze → silver → gold → black"). It is declared
 * here so no editor can render five cards or reorder them.
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
  /** The console admin's name, from the server. "Yousef", not "AVO". */
  publishedBy: string;
  /** "Tier rules published — customers see them now." Server-authored. */
  message: string;
  /**
   * `next_visit`. Stated on the wire because it is the one thing about this
   * operation somebody can get wrong: nobody is promoted or demoted at publish
   * time, and no existing balance is touched.
   */
  appliesAt: 'next_visit';
}

/** What the console may publish. There is no merchant body — see the header. */
export interface LoyaltyPublish {
  loyaltyMode: 'tiers' | 'stamps';
  tiers?: Tier[];
  stampTarget?: number;
}

export const loyaltyKeys = {
  detail: (salonId: string) => ['loyalty', salonId] as const,
};

/* ------------------------------------------------------------- the merchant */

/**
 * Merchant → Loyalty. READ ONLY, and that is now the whole surface.
 *
 * `perms.loyalty` still gates it, and it is no longer "the same permission as
 * the write" — it is the permission to SEE the screen. `routes/loyalty.ts` keeps
 * the gate anyway because non-negotiable #7 does not permit an ungated dashboard
 * endpoint on a whim, and notes that there is nothing secret behind it: the
 * ladder is already public to every customer of the salon through
 * `GET /salons/{id}`.
 */
export function useLoyalty(): UseQueryResult<LoyaltyConfig> {
  const salonId = useSalonId();
  return useQuery({
    queryKey: loyaltyKeys.detail(salonId),
    queryFn: ({ signal }) =>
      authedRequest<LoyaltyConfig>('merchant', `/salons/${salonId}/loyalty`, { signal }),
    // Retry policy is global — api/retryPolicy.ts. `perms.loyalty` gates this
    // endpoint, so the 403 short-circuit that override used to defeat matters here.
  });
}

/* -------------------------------------------------------------- the console */

/**
 * The console reading one salon's ladder, on `sections.salons`.
 *
 * A SECOND QUERY KEY RATHER THAN A SHARED ONE, and it is not tidiness. The
 * merchant's key is `['loyalty', salonId]` and so is this one's shape — but the
 * two are fetched with different credentials against different authority, and a
 * console admin can hold ten salons in cache at once where a merchant session
 * only ever has hers. Keying them apart is what stops a console read of
 * SAL-LUMIERE answering a merchant screen that may not see it. The scope is in
 * the key for the same reason it is in `authedRequest`'s first argument.
 */
export const platformLoyaltyKeys = {
  detail: (salonId: string) => ['platform', 'loyalty', salonId] as const,
};

export function usePlatformLoyalty(salonId: string): UseQueryResult<LoyaltyConfig> {
  return useQuery({
    queryKey: platformLoyaltyKeys.detail(salonId),
    queryFn: ({ signal }) =>
      authedRequest<LoyaltyConfig>(
        'owner',
        `/salons/${encodeURIComponent(salonId)}/loyalty`,
        { signal },
      ),
  });
}

/**
 * Publish. The console's, and nobody else's.
 *
 * THERE IS NO OPTIMISTIC UPDATE, AND ON THIS SURFACE IT IS A HARDER REQUIREMENT
 * THAN IT WAS ON THE MERCHANT'S.
 *
 * build-plan.md phase 4 calls a half-published ladder a money bug: a member who
 * tops up against a ladder that never existed is credited a bonus nobody set. The
 * API makes the write atomic — one jsonb column, one UPDATE, one transaction
 * carrying its own audit row — but atomic on the server is only half the promise.
 * If the client paints the new ladder before the server accepts it, a rejected
 * publish leaves somebody reading rungs that are not live.
 *
 * The merchant's version of that sentence ended "…and telling customers about
 * them". The console's ends worse: an AVO admin who believes a publish landed
 * tells a SALON that its terms changed, and the salon tells its customers. The
 * cache is therefore only ever written from the server's response, and the screen
 * reports the publish with the server's `publishedAt` / `publishedBy` rather than
 * with a local success flag.
 *
 * `setQueryData` rather than `invalidateQueries` for the ladder itself: the PUT
 * response IS the new authoritative config, recomputed preview included, so
 * refetching it would be a second round trip to learn what we were just told.
 *
 * THE THREE INVALIDATIONS ARE NOT DECORATION. `loyaltyMode`, `tiers` and
 * `stampTarget` are all fields of the console's salon reads, and `GET
 * /salons/{id}` serves the same ladder again to the merchant shell and the
 * wallet:
 *
 *   platformSalonDetailKey(id)   the editor this publish is rendered inside
 *   platformSalonKeys.list       the Salons list, which draws a Tiers/Stamps cell
 *   salonKeys.detail(id)         the merchant-scoped salon read
 *
 * Leaving the list alone was the interesting one: a mechanic switch published
 * here would send the admin back to a list still labelling the salon "Tiers", on
 * the same screen, with no error anywhere.
 */
export function usePublishPlatformLoyalty(
  salonId: string,
): UseMutationResult<PublishedLoyalty, unknown, LoyaltyPublish> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body) =>
      authedRequest<PublishedLoyalty>('owner', `/salons/${encodeURIComponent(salonId)}/loyalty`, {
        method: 'PUT',
        body,
      }),
    onSuccess: (published) => {
      queryClient.setQueryData<LoyaltyConfig>(platformLoyaltyKeys.detail(salonId), {
        loyaltyMode: published.loyaltyMode,
        tiers: published.tiers,
        stampTarget: published.stampTarget,
        stampReward: published.stampReward,
        stampRewardAr: published.stampRewardAr,
        preview: published.preview,
      });
      void queryClient.invalidateQueries({ queryKey: platformSalonDetailKey(salonId) });
      void queryClient.invalidateQueries({ queryKey: platformSalonKeys.list });
      void queryClient.invalidateQueries({ queryKey: salonKeys.detail(salonId) });
    },
  });
}

export { type Tier, type TierName };
