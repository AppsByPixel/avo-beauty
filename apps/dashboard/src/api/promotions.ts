import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { CampaignRewardSchema, isBoostLive, RewardKeySchema } from '@avo/types';
import type { Boost, Campaign, CampaignReward, HappyHour, PromotionSet, RewardKey } from '@avo/types';
import { authedRequest } from '../auth/authedRequest.js';
import { ApiError } from './client.js';
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
  /** The salon's own saved campaign rewards. Salon-scoped like every key here. */
  campaignRewards: (salonId: string) => ['campaign-rewards', salonId] as const,
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

/**
 * What a branch boost changes: visits and stamps, and nothing else.
 *
 * `topup` IS GONE FROM THIS SHAPE, ON PURPOSE. Aftab ruled 2026-09-29 (DECISIONS,
 * "Branch boosts lose the top-up bonus"): a top-up happens in the app and has no
 * branch, so `decideEarning` never found a branch boost for one and the server
 * never paid the "Top-up bonus" this screen let a merchant set. The wire field
 * stays, always 0, so installed apps keep parsing — `publishBody` writes that 0
 * itself, and no screen holds a value it could send instead.
 */
export interface BoostValues {
  visit: number;
  stamp: number;
}

/** The neutral row. A branch with no boost earns exactly the salon's base rate. */
export const NEUTRAL_BOOST: BoostValues = { visit: 1, stamp: 1 };

/** Bounds enforced by the API and by a CHECK. Restated so the stepper stops first. */
export const BOOST_BOUNDS = {
  visit: { min: 1, max: 3, step: 1 },
  stamp: { min: 1, max: 3, step: 1 },
} as const;

/**
 * WHAT A CHARGE AT THIS BRANCH EARNS AT `now` — the published row read through
 * `isBoostLive`, so a boost that has ended, has not started, or was stopped
 * earns the base rate. The till panel's "what a charge through it earns" is a
 * sentence about now; a boost scheduled for Friday does not make it true today.
 * The server decides the charge with the same predicate (#2); this only says it.
 */
export function earningNow(boost: Boost | undefined, now: Date): BoostValues {
  if (!boost || boost.stoppedAt !== null || !isBoostLive(boost, now)) return NEUTRAL_BOOST;
  return { visit: boost.visit, stamp: boost.stamp };
}

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
 *
 * NO TOP-UP CLAUSE. It said "adds 10% to every top-up", which the server never
 * paid — see `BoostValues`.
 */
export function summariseBoost(subject: string, v: BoostValues): string {
  const parts: string[] = [];
  if (v.visit > 1) parts.push(`counts as ${v.visit} visits`);
  if (v.stamp > 1) parts.push(`earns ${v.stamp} stamps`);
  if (parts.length === 0) return `A visit at ${subject} earns the salon's base rate.`;
  const last = parts.pop() as string;
  return `A visit at ${subject} ${parts.length ? `${parts.join(', ')} and ${last}` : last}.`;
}

/** One branch as the screen hands it over: the values, and its window. */
export interface BoostPublishRow extends BoostValues {
  /** ISO with a zone (`…Z`), or `null` for no bound. */
  startsAt: string | null;
  endsAt: string | null;
}

export interface BoostWireRow {
  visit: number;
  topup: 0;
  stamp: number;
  startsAt: string | null;
  endsAt: string | null;
}

/**
 * The PUT's `boosts` object.
 *
 * `topup: 0`, ALWAYS, written here rather than carried in from the screen. The
 * API refuses a non-zero value; nothing on the dashboard can hold one.
 *
 * A NEUTRAL ROW GOES WITHOUT A WINDOW. The server drops a window on "no boost"
 * anyway (`parseBoost`), so sending one would only make a branch read as changed
 * — and a changed branch loses its stop record.
 */
export function publishBody(rows: Record<string, BoostPublishRow>): Record<string, BoostWireRow> {
  return Object.fromEntries(
    Object.entries(rows).map(([branchId, r]) => {
      const neutral = r.visit === NEUTRAL_BOOST.visit && r.stamp === NEUTRAL_BOOST.stamp;
      const row: BoostWireRow = {
        visit: r.visit,
        topup: 0,
        stamp: r.stamp,
        startsAt: neutral ? null : r.startsAt,
        endsAt: neutral ? null : r.endsAt,
      };
      return [branchId, row];
    }),
  );
}

/**
 * Publish the whole grid.
 *
 * A PUT of the SET, not a PATCH of a branch, because the screen is the whole
 * grid: the API resets any branch absent from the body to neutral, so sending a
 * partial map would silently clear the branches the merchant did not touch.
 * Every branch the salon has goes in the body, every time — AND ITS WINDOW WITH
 * IT, because a branch sent without its window loses it (lane A, 6d102c5). A
 * branch sent back exactly as published keeps its stop record on the server.
 *
 * No optimistic update, for the reason the loyalty publish gives: the cache is
 * written only from the server's response, so a rejected publish leaves the
 * merchant's draft in the editor and the live values on screen, correctly
 * labelled as different things.
 */
export function usePublishBoosts(): UseMutationResult<
  PromotionSet,
  unknown,
  Record<string, BoostPublishRow>
> {
  const salonId = useSalonId();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (rows) =>
      authedRequest<PromotionSet>('merchant', `/v1/salons/${salonId}/promotions/boosts`, {
        method: 'PUT',
        body: { boosts: publishBody(rows) },
      }),
    onSuccess: (set) => queryClient.setQueryData(promotionKeys.set(salonId), set),
  });
}

/**
 * STOP ONE BRANCH'S BOOST, NOW — `POST …/promotions/boosts/{branchId}/stop`,
 * `perms.marketing` (the publish's gate, enforced server-side).
 *
 * The server writes that branch neutral with no window and records who stopped
 * it and when; every other branch is untouched. A boost scheduled for later can
 * be stopped too, which cancels it before it starts. It answers with the set.
 *
 * THE CACHE IS RESEEDED FROM THE RESPONSE, and it has to be: a stop does NOT
 * bump `boostsPublishedAt`, the set's publish identity, so anything keyed on
 * that alone would never notice. `Boosts.tsx` reseeds a branch's draft from the
 * row's own fingerprint for the same reason.
 *
 * A 409 (`no_boost_running`, `boost_already_stopped`, `boost_already_ended`)
 * means the screen's picture of that branch was stale — a colleague stopped it,
 * or it ran out while the confirm was open. The set is re-read so the row shows
 * what is true; the refusal itself is the row's to render.
 *
 * No Idempotency-Key: it moves no money (#4 is money-moving POSTs), and a
 * repeated stop is told `boost_already_stopped` by name.
 */
export function useStopBoost(): UseMutationResult<PromotionSet, unknown, string> {
  const salonId = useSalonId();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (branchId) =>
      authedRequest<PromotionSet>(
        'merchant',
        `/v1/salons/${salonId}/promotions/boosts/${encodeURIComponent(branchId)}/stop`,
        { method: 'POST' },
      ),
    onSuccess: (set) => queryClient.setQueryData(promotionKeys.set(salonId), set),
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        void queryClient.invalidateQueries({ queryKey: promotionKeys.set(salonId) });
      }
    },
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
  reward: RewardKey | 'none' | 'custom';
  /**
   * ONLY ON `reward: 'custom'`, AND IT IS AN ID, NEVER WORDS.
   *
   * The server resolves the label from the id and snapshots it onto the
   * campaign (api/src/routes/campaigns.ts). There is deliberately no field on
   * this draft that could carry a label: the words a reviewer approves are the
   * words the salon SAVED, not whatever a request said. And it is absent rather
   * than empty on every other reward, because the API refuses a `customRewardId`
   * beside a preset (`custom_reward_not_allowed`).
   */
  customRewardId?: string;
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

// ------------------------------------------------------ campaign rewards --

/** api/src/routes/campaignRewards.ts — `CAMPAIGN_REWARD_LABEL_MAX`. */
export const CAMPAIGN_REWARD_LABEL_MAX = 60;

function parseCampaignRewards(raw: unknown): CampaignReward[] {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { items?: unknown }).items)) {
    throw new Error('GET /v1/salons/{id}/campaign-rewards did not return an { items: [] } envelope.');
  }
  return (raw as { items: unknown[] }).items.map((item) => CampaignRewardSchema.parse(item));
}

/**
 * The salon's own rewards — the ones she wrote — for "Attach a reward".
 *
 * A LABEL AND NOTHING ELSE. A saved reward moves no money and applies no
 * earning effect; the salon honours it at the counter. So nothing here feeds
 * `rewardEffect()`, and happy hours never see this list.
 *
 * Active only, oldest first — the order she added them, which is the order the
 * select lists them. PARSED, not trusted, as `usePlatformCampaigns` is.
 */
export function useCampaignRewards(): UseQueryResult<CampaignReward[]> {
  const salonId = useSalonId();
  return useQuery({
    queryKey: promotionKeys.campaignRewards(salonId),
    queryFn: async ({ signal }) =>
      parseCampaignRewards(
        await authedRequest<unknown>('merchant', `/v1/salons/${salonId}/campaign-rewards`, {
          signal,
        }),
      ),
    networkMode: 'always',
  });
}

/**
 * Save one. The label is trimmed here only so the empty check and the server
 * agree; the server trims again and owns every rule (60 characters, a
 * case-insensitive duplicate, 20 active). Its refusal is rendered verbatim.
 *
 * The cache is written from the server's row, never from what she typed, so the
 * option she sees selected is the one the server stored.
 */
export function useAddCampaignReward(): UseMutationResult<CampaignReward, unknown, string> {
  const salonId = useSalonId();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (label) =>
      CampaignRewardSchema.parse(
        await authedRequest<unknown>('merchant', `/v1/salons/${salonId}/campaign-rewards`, {
          method: 'POST',
          body: { label: label.trim() },
        }),
      ),
    onSuccess: (row) => {
      queryClient.setQueryData<CampaignReward[]>(promotionKeys.campaignRewards(salonId), (prev) =>
        prev ? [...prev.filter((r) => r.id !== row.id), row] : [row],
      );
      void queryClient.invalidateQueries({ queryKey: promotionKeys.campaignRewards(salonId) });
    },
  });
}

/**
 * Take one off her list. A campaign already submitted with it keeps its own
 * snapshot of the words (`customReward`), so this touches nothing in the queue.
 *
 * A 404 `unknown_reward` IS THE OUTCOME SHE ASKED FOR — a colleague removed it a
 * moment earlier — so it settles as a success rather than telling her something
 * went wrong on our side about a reward that is, correctly, gone.
 */
export function useRemoveCampaignReward(): UseMutationResult<void, unknown, string> {
  const salonId = useSalonId();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (rewardId) => {
      try {
        await authedRequest<void>(
          'merchant',
          `/v1/salons/${salonId}/campaign-rewards/${encodeURIComponent(rewardId)}`,
          { method: 'DELETE' },
        );
      } catch (error) {
        if (error instanceof ApiError && error.status === 404 && error.code === 'unknown_reward') {
          return;
        }
        throw error;
      }
    },
    onSuccess: (_done, rewardId) => {
      queryClient.setQueryData<CampaignReward[]>(promotionKeys.campaignRewards(salonId), (prev) =>
        prev?.filter((r) => r.id !== rewardId),
      );
      void queryClient.invalidateQueries({ queryKey: promotionKeys.campaignRewards(salonId) });
    },
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
export function useCampaigns(status: Campaign['status'] | null = null): UseQueryResult<CampaignList> {
  const salonId = useSalonId();
  return useQuery({
    /*
     * `?status=` NARROWS SERVER-SIDE. The route caps the queue at 200 rows
     * newest-first (`LIMIT 200`, api/src/routes/campaigns.ts) and says nothing
     * when it does, so a status chip that trimmed the loaded 200 would hide an
     * older rejected campaign behind newer sends. The key keeps the status under
     * `campaigns(salonId)`, so the submit's prefix invalidation still reaches
     * every filtered queue.
     */
    queryKey: [...promotionKeys.campaigns(salonId), status ?? 'any'] as const,
    queryFn: ({ signal }) =>
      authedRequest<CampaignList>(
        'merchant',
        `/v1/salons/${salonId}/campaigns${status ? `?status=${encodeURIComponent(status)}` : ''}`,
        { signal },
      ),
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

/** The last option in "Attach a reward". Not a reward: it opens the field that writes one. */
export const CAMPAIGN_ADD_CUSTOM_LABEL = '+ Add a custom reward…';

/**
 * A campaign's reward as words, wherever the dashboard names it — the merchant's
 * queue and the owner console's approval card.
 *
 * `custom` is the server's snapshot, VERBATIM: the salon wrote it, and AVO's
 * reviewer approves exactly those words. A preset reads as it did in the select
 * she picked it from. `null` for no reward, and for a `custom` that somehow
 * arrived without its words — the caller then renders nothing rather than a
 * sentence this client made up about a reward it cannot name.
 */
export function campaignRewardLabel(c: Pick<Campaign, 'reward' | 'customReward'>): string | null {
  if (c.reward === 'none') return null;
  if (c.reward === 'custom') return c.customReward;
  return CAMPAIGN_REWARD_LABEL[c.reward];
}

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
