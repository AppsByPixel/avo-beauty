import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { RewardKeySchema } from '@avo/types';
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
 * What a branch's boost row MEANS, in the design's own plain language.
 *
 * IT LIVED IN `routes/marketing/Boosts.tsx` AND NOW LIVES HERE, because a second
 * screen needed the same sentence. `routes/Tills.tsx` shows the earning
 * consequence of the branch a till stands at — that is the whole reason that
 * panel is not a device-management screen — and the honest way to say "this till
 * pays double visits" is the sentence the merchant already read on the Boosts
 * screen when she set the rate.
 *
 * MOVED RATHER THAN COPIED, deliberately. `PromotionSetSchema`'s own header says
 * "ONE source of truth. The wallet and the dashboard read this same object —
 * never duplicate boost or happy-hour values in a client", and a second
 * `summarise` beside this one is how two screens start describing one boost row
 * differently. This module already owns `BoostValues`, `NEUTRAL_BOOST` and
 * `BOOST_BOUNDS`, so it is where the vocabulary belongs.
 *
 * The caller passes the branch name because the two screens frame it
 * differently — Boosts says "A visit at Salmiya…", the till panel says "A visit
 * on this till…" — and the subject is the only part that differs.
 */
export function summariseBoost(subject: string, v: BoostValues): string {
  const parts: string[] = [];
  if (v.visit > 1) parts.push(`counts as ${v.visit} visits`);
  if (v.topup > 0) parts.push(`adds ${v.topup}% to every top-up`);
  if (v.stamp > 1) parts.push(`earns ${v.stamp} stamps`);
  if (parts.length === 0) return `A visit at ${subject} earns the salon's base rate.`;
  const last = parts.pop() as string;
  return `A visit at ${subject} ${parts.length ? `${parts.join(', ')} and ${last}` : last}.`;
}

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
    /*
     * `retry: false` used to sit here, and removing it is a deliberate BEHAVIOUR
     * CHANGE rather than a tidy-up, so it is called out.
     *
     * Nothing in the reasoning above argued for zero retries — it is about
     * caching, and the conclusion it reaches is that "we cannot show the queue"
     * beats a row that vanishes, because the merchant's question is "did AVO get
     * it". One retry on a dropped connection serves that goal better than none:
     * it makes the queue MORE likely to render the answer she came for. And the
     * case `retry: false` was really guarding — a refusal asked twice — is now
     * handled by status in api/retryPolicy.ts rather than by declining to retry
     * anything at all.
     */
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

/**
 * Campaign reward copy — ONE LINE PER KEY THE CONTRACT DEFINES.
 *
 * `Record<RewardKey, string>` rather than an array of literals, so the compiler
 * is the thing that notices a new reward. Add a seventh key to
 * `RewardKeySchema` and this object stops compiling until it has been given a
 * sentence; it cannot be added and silently left unofferable.
 *
 * =========================================================================
 * THE DEFECT THIS REPLACES
 * =========================================================================
 * `CAMPAIGN_REWARDS` was four hand-written literals — `none`, `x2stamp`,
 * `topup10`, `credit3` — transcribed from the four `<option>` tags in
 * `design/AVO Merchant Dashboard.dc.html:768`. The contract defines SIX,
 * `rewardEffect()` implements all six with real effects, and
 * `api/src/routes/campaigns.ts:182` validates against the full enum and would
 * have accepted any of them. So `x3stamp`, `x2visit` and `topup20` were
 * implemented end to end and unreachable from the only screen that offers a
 * reward — including `x2visit`, which the design's OWN seed campaign `c-1004`
 * uses ("every visit counts double"). The design file could show a campaign the
 * design file's select could not create.
 *
 * NOTHING WENT RED, AND THAT IS THE POINT. Every spec that touched this control
 * asked questions ABOUT the list; a spec that only ever consults the list cannot
 * notice the list disagreeing with its source. Same shape as the
 * `BRAND_SWATCHES` sage and the `PRESET_HEXES` retired hex, and closed the same
 * way: derive, do not transcribe.
 *
 * =========================================================================
 * THE WORDING IS READ OFF `rewardEffect()`, NOT OFF THE KEY NAME
 * =========================================================================
 * `x2visit` is the one that punishes guessing. The name reads "two visits";
 * what `rewardEffect` returns is `visitMultiplier: 2`, which `charge.ts` passes
 * to `applyVisits` as the visit INCREMENT, and only on the tiers branch. It buys
 * tier progress, not a second appointment, so the line says so rather than
 * promising a visit that never happens.
 *
 * `x3stamp` is `stampMultiplier: 3` — three stamps for the one visit, not a
 * third stamp added — so it is "Triple stamps", parallel to the x2 line above
 * it. `topup20` is `topupBonusPercent: 20`, the same effect as `topup10` at a
 * different rate, so it is the same sentence at a different number.
 *
 * `credit3` is `creditFils: 3000` — integer fils, non-negotiable #1 — and the
 * shipped line already reads "3 KD", which is that value at the display
 * boundary. It is left exactly as written.
 */
const CAMPAIGN_REWARD_LABEL: Record<RewardKey, string> = {
  x2stamp: 'Double stamps on the next visit',
  x3stamp: 'Triple stamps on the next visit',
  x2visit: 'Double visit credit toward the next tier',
  topup10: '+10% on the next top-up',
  topup20: '+20% on the next top-up',
  credit3: '3 KD credit into the wallet',
};

/**
 * `none` IS NOT A REWARD KEY, AND IT IS KEPT WHERE IT CANNOT BECOME ONE.
 *
 * The contract already draws this line: `CampaignSchema.reward` is
 * `z.union([RewardKeySchema, z.literal('none')])`. A campaign can attach no
 * reward and a happy hour cannot, which is a fact about campaigns — not a
 * seventh thing a salon can grant. Folding it into `CAMPAIGN_REWARD_LABEL`
 * would put it inside every `RewardKey` iteration in this file and hand it to
 * `rewardEffect()`, which has no case for it and would return `undefined`
 * through a function typed to return an effect.
 *
 * So it is a separate export, the way `BRAND_DEFAULT` is separate from
 * `BRAND_SWATCHES`: the list is derived from the enum, the absence sits beside
 * it, and the offered list below is the only place the two are joined.
 */
export const CAMPAIGN_NO_REWARD: { value: 'none'; label: string } = {
  value: 'none',
  label: 'No reward — message only',
};

/**
 * What the select offers: the absence, then every key the contract defines.
 *
 * ORDER IS `RewardKeySchema`'S ORDER, chosen rather than defaulted to. The enum
 * is already grouped by effect and ascending inside each group — stamps (x2,
 * x3), visits (x2), top-ups (+10%, +20%), credit — so any grouping worth
 * writing by hand is the one it already has, and re-stating it here would
 * re-introduce the second copy this change exists to delete.
 *
 * It also costs nothing on a screen that is already signed off: `none, x2stamp,
 * topup10, credit3` is a SUBSEQUENCE of the enum, so every option Aftab has
 * seen keeps its position and the three new ones land between them.
 */
export const CAMPAIGN_REWARDS: ReadonlyArray<{ value: RewardKey | 'none'; label: string }> = [
  CAMPAIGN_NO_REWARD,
  ...RewardKeySchema.options.map((value) => ({ value, label: CAMPAIGN_REWARD_LABEL[value] })),
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
