import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { Campaign, HappyHour, PromotionSet, RewardKey } from '@avo/types';
import { authedRequest } from '../auth/authedRequest.js';
import { useSalonId } from '../auth/AuthProvider.js';

/**
 * Marketing — the shared platform state.
 *
 * `GET /v1/salons/{id}/promotions` is ONE object read by the wallet, the scanner
 * and this dashboard. api-contract.md § Promotion set: "Never duplicate boost or
 * happy-hour values in a client — the wallet's chips and the dashboard's
 * steppers are two views of `boosts`." So nothing here caches a derived copy,
 * and nothing here stores whether a window is live.
 *
 * THERE IS NO `live` FLAG AND THIS FILE DOES NOT ADD ONE. The predicate lives in
 * `@avo/types` (`isHappyHourLive`, `minutesRemaining`, `minutesUntilNext`) and is
 * imported by the API, the wallet and this screen. Three implementations of "is
 * this window open" is three answers, and the one that prices a charge is the
 * server's.
 */

export const promotionKeys = {
  set: (salonId: string) => ['promotions', salonId] as const,
  campaigns: (salonId: string) => ['campaigns', salonId] as const,
};

export function usePromotions(): UseQueryResult<PromotionSet> {
  const salonId = useSalonId();
  return useQuery({
    queryKey: promotionKeys.set(salonId),
    queryFn: ({ signal }) =>
      authedRequest<PromotionSet>('merchant', `/v1/salons/${salonId}/promotions`, { signal }),
    /*
     * See api/bookings.ts — `networkMode` restated so an unreachable API fails
     * into the designed offline state instead of pausing at `status: 'pending'`,
     * which this screen would render as skeletons forever.
     *
     * `retry` is left to the default function in main.tsx, which refuses to
     * retry a 403. Marketing is gated on `perms.marketing`, so this is the
     * section where getting that wrong is most visible.
     */
    networkMode: 'always',
  });
}

// ---------------------------------------------------------------- boosts ---

export interface BoostValues {
  visit: number;
  topup: number;
  stamp: number;
}

/** The neutral row. A branch with no boost earns exactly the salon's base rate. */
export const NEUTRAL_BOOST: BoostValues = { visit: 1, topup: 0, stamp: 1 };

/** Bounds enforced by the API and by a CHECK. Restated so the stepper stops first. */
export const BOOST_BOUNDS = {
  visit: { min: 1, max: 3, step: 1 },
  topup: { min: 0, max: 30, step: 5 },
  stamp: { min: 1, max: 3, step: 1 },
} as const;

/**
 * Publish the whole grid.
 *
 * A PUT of the SET, not a PATCH of a branch, because the screen is the whole
 * grid: the API resets any branch absent from the body to neutral, so sending a
 * partial map would silently clear the branches the merchant did not touch.
 * Every branch the salon has goes in the body, every time.
 *
 * No optimistic update, for the reason the loyalty publish gives: the cache is
 * written only from the server's response, so a rejected publish leaves the
 * merchant's draft in the editor and the live values on screen, correctly
 * labelled as different things.
 */
export function usePublishBoosts(): UseMutationResult<
  PromotionSet,
  unknown,
  Record<string, BoostValues>
> {
  const salonId = useSalonId();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (boosts) =>
      authedRequest<PromotionSet>('merchant', `/v1/salons/${salonId}/promotions/boosts`, {
        method: 'PUT',
        body: { boosts },
      }),
    onSuccess: (set) => queryClient.setQueryData(promotionKeys.set(salonId), set),
  });
}

// ----------------------------------------------------------- happy hours ---

export interface HappyHourDraft {
  branchId: string;
  days: number[];
  from: string;
  to: string;
  reward: RewardKey;
  on: boolean;
  notify: boolean;
}

export function useAddHappyHour(): UseMutationResult<HappyHour, unknown, HappyHourDraft> {
  const salonId = useSalonId();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (draft) =>
      authedRequest<HappyHour>('merchant', `/v1/salons/${salonId}/promotions/happy-hours`, {
        method: 'POST',
        body: draft,
      }),
    // The POST returns the one window; the SET is what every reader holds.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: promotionKeys.set(salonId) }),
  });
}

export function useUpdateHappyHour(): UseMutationResult<
  HappyHour,
  unknown,
  { id: string; patch: Partial<HappyHourDraft> }
> {
  const salonId = useSalonId();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, patch }) =>
      authedRequest<HappyHour>('merchant', `/v1/salons/${salonId}/promotions/happy-hours/${id}`, {
        method: 'PATCH',
        body: patch,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: promotionKeys.set(salonId) }),
  });
}

/**
 * Remove a window.
 *
 * The API refuses with a 409 (`happy_hour_in_use`) once a window has priced a
 * charge, and names the alternative in its message: "Switch it off instead."
 * That sentence is rendered verbatim — a paraphrase would drop the fix.
 */
export function useRemoveHappyHour(): UseMutationResult<void, unknown, string> {
  const salonId = useSalonId();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id) =>
      authedRequest<void>('merchant', `/v1/salons/${salonId}/promotions/happy-hours/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: promotionKeys.set(salonId) }),
  });
}

// -------------------------------------------------------------- campaigns --

export interface CampaignDraft {
  title: string;
  body: string;
  channel: Campaign['channel'];
  audience: Campaign['audience'];
  branchId: string;
  reward: RewardKey | 'none';
  when: 'now' | 'later';
  scheduledAt: string;
}

/**
 * SUBMIT. NOT SEND. Non-negotiable #8.
 *
 * `POST /v1/salons/{id}/campaigns` only ever creates `status: "pending"` — the
 * status is hardcoded in the handler, not derived from anything a client sends.
 * Delivery is queued by `POST /v1/platform/campaigns/{cid}/decision` in the owner
 * console, and the caps and quiet hours are enforced AGAIN at send time.
 *
 * Nothing in this module can move a campaign to `sent`, and no return value from
 * here should ever be phrased to a merchant as though it had been.
 */
export function useSubmitCampaign(): UseMutationResult<Campaign, unknown, CampaignDraft> {
  const salonId = useSalonId();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (draft) =>
      authedRequest<Campaign>('merchant', `/v1/salons/${salonId}/campaigns`, {
        method: 'POST',
        body: draft,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: promotionKeys.campaigns(salonId) }),
  });
}

export interface CampaignList {
  items: Campaign[];
  /** api-contract.md § PlatformMessagingPolicy — `monthlyCapPerSalon`, counted server-side. */
  monthlyCap?: number;
  capUsed?: number;
}

/**
 * The queue below the composer.
 *
 * `GET /v1/salons/{id}/campaigns` DOES NOT EXIST YET — it 404s today, and the
 * `POST` above does not persist the row it returns either. So this hook asks for
 * the real endpoint and the screen renders a plain "not listed yet" state when
 * it is absent, rather than replaying the submitted campaign out of the mutation
 * cache. A queue that shows a campaign until the page reloads and then loses it
 * is worse than one that says it cannot show the queue: the merchant's question
 * is "did AVO get it", and a row that vanishes answers it wrongly.
 *
 * Withdraw (`DELETE .../campaigns/{cid}`) and the monthly cap have the same
 * problem and the same treatment. All three are in the lane report.
 */
export function useCampaigns(): UseQueryResult<CampaignList> {
  const salonId = useSalonId();
  return useQuery({
    queryKey: promotionKeys.campaigns(salonId),
    queryFn: ({ signal }) =>
      authedRequest<CampaignList>('merchant', `/v1/salons/${salonId}/campaigns`, { signal }),
    networkMode: 'always',
    retry: false,
  });
}

// ------------------------------------------------------------------ copy ---

/** The reward names, verbatim from the design's `rewardLabel`. */
export const REWARD_LABEL: Record<RewardKey, string> = {
  x2stamp: 'Double stamps',
  x3stamp: 'Triple stamps',
  x2visit: '2× visit value',
  topup10: '+10% top-up bonus',
  topup20: '+20% top-up bonus',
  credit3: '3 KD credit',
};

/** Happy-hour rewards, in the design's select order. */
export const HAPPY_REWARDS: RewardKey[] = [
  'x2stamp',
  'x3stamp',
  'topup10',
  'topup20',
  'x2visit',
];

/** Campaign rewards. A campaign can attach no reward; a happy hour cannot. */
export const CAMPAIGN_REWARDS: Array<{ value: RewardKey | 'none'; label: string }> = [
  { value: 'none', label: 'No reward — message only' },
  { value: 'x2stamp', label: 'Double stamps on the next visit' },
  { value: 'topup10', label: '+10% on the next top-up' },
  { value: 'credit3', label: '3 KD credit into the wallet' },
];

export const AUDIENCES: Array<{ value: Campaign['audience']; label: string }> = [
  { value: 'all', label: 'Everyone' },
  { value: 'lapsed', label: 'Not seen in 60 days' },
  { value: 'lowbal', label: 'Wallet under 5 KD' },
  { value: 'gold', label: 'Gold & Platinum' },
  { value: 'new', label: 'Joined this month' },
];

export const CHANNELS: Array<{ value: Campaign['channel']; label: string }> = [
  { value: 'push', label: 'App push' },
  { value: 'wa', label: 'WhatsApp' },
  { value: 'both', label: 'Both' },
];

/** The four states the queue shows. `pending` reads as "Awaiting AVO". */
export const CAMPAIGN_STATUS_LABEL: Record<Campaign['status'], string> = {
  pending: 'Awaiting AVO',
  approved: 'Approved',
  sent: 'Sent',
  rejected: 'Rejected',
};

export const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** "Sun–Wed" when contiguous and longer than two, "Thu, Sat" otherwise. */
export function daysLabel(days: number[]): string {
  const d = [...days].sort((a, b) => a - b);
  if (d.length === 0) return 'No days';
  const contiguous = d.every((v, i) => i === 0 || v === (d[i - 1] as number) + 1);
  return contiguous && d.length > 2
    ? `${DAY_SHORT[d[0] as number]}–${DAY_SHORT[d[d.length - 1] as number]}`
    : d.map((v) => DAY_SHORT[v]).join(', ');
}
