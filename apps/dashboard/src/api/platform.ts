import {
  CampaignSchema,
  LegalDocSchema,
  PlatformMessagingPolicySchema,
  type Campaign,
  type LegalDoc,
  type PlatformMessagingPolicy,
} from '@avo/types';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { authedRequest } from '../auth/authedRequest.js';

/**
 * The owner console's reads and writes.
 *
 * EVERY ROUTE HERE IS `requirePlatform(req, <section>)` SERVER-SIDE, and the
 * section is named on each hook so the courtesy gate in the shell can be checked
 * against the real guard rather than against the name that sounds right. From
 * api/src/routes:
 *
 *   GET    /v1/platform/campaigns              approvals   campaigns.ts:367
 *   POST   /v1/platform/campaigns/{cid}/decision approvals campaigns.ts:419
 *   GET    /v1/platform/messaging-policy       approvals   campaigns.ts:554
 *   PATCH  /v1/platform/messaging-policy       approvals   campaigns.ts:606
 *   GET    /v1/platform/policies               (public)    platform.ts:570
 *   GET    /v1/platform/policies/draft         policies    policies.ts:193
 *   POST   /v1/platform/policies/publish       policies    policies.ts:347
 *   POST   /v1/platform/policies/discard       policies    policies.ts:496
 *
 * Note `approvals` covers the throttle as well as the queue: the same permission
 * that decides a campaign sets the caps it is decided against. That is the
 * server's grouping and the console follows it rather than inventing a finer one.
 *
 * SUPPORT IS NOT IN THIS FILE. It renders inside the Policies screen but it is
 * eight endpoints across two guards — `requirePrincipal` on the read and
 * `policies` on the four writes — and it now has its own module, `api/support.ts`,
 * with its own key namespace and its own gate note. Reach for it there.
 */

/*
 * NO HOOK HERE PASSES `retry`. api/retryPolicy.ts is emphatic that it is THE one
 * policy and that a hook restating it is how the 403 short-circuit was lost in
 * seven files — and `main.tsx` already installs it as the default. Passing it
 * locally also widens TanStack's error type from `Error` to `unknown`, so the
 * shortcut does not even typecheck against `UseQueryResult<T>`.
 */
export const platformKeys = {
  campaigns: (status?: string) => ['platform', 'campaigns', status ?? 'all'] as const,
  messagingPolicy: ['platform', 'messaging-policy'] as const,
  publishedPolicies: ['platform', 'policies', 'published'] as const,
  draftPolicies: ['platform', 'policies', 'draft'] as const,
};

/* ------------------------------------------------------------- approvals -- */

/**
 * `items` parsed one at a time with the trunk schema.
 *
 * NOT a zod wrapper object: `@avo/dashboard` does not depend on zod directly —
 * only `@avo/types` does, and it re-exports its schemas rather than the library.
 * `require.resolve('zod')` from this package fails, so importing `z` here would
 * be an undeclared dependency that happens to bundle. The list envelope is two
 * fields; checking them by hand costs less than a lockfile change on a lane
 * branch.
 */
function parseItems<T>(raw: unknown, parse: (item: unknown) => T, where: string): T[] {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { items?: unknown }).items)) {
    throw new Error(`${where} did not return an { items: [] } envelope.`);
  }
  return ((raw as { items: unknown[] }).items).map(parse);
}

/**
 * The queue. `?status=pending` is ordered OLDEST FIRST by the API — the design's
 * "oldest" note in `pendingNote` depends on it, and a newest-first queue would
 * quietly invert what "waiting longest" means.
 */
export function usePlatformCampaigns(status?: string): UseQueryResult<Campaign[]> {
  return useQuery({
    queryKey: platformKeys.campaigns(status),
    queryFn: async ({ signal }) => {
      const raw = await authedRequest<unknown>(
        'owner',
        `/v1/platform/campaigns${status ? `?status=${encodeURIComponent(status)}` : ''}`,
        { signal },
      );
      /*
       * PARSED, not trusted. `CampaignSchema` gained `heldReason` and `heldAt`
       * for #8's hold, and a response that dropped them would render "approved"
       * with no explanation of why nothing was sent — the exact thing those two
       * fields exist to prevent. Widening the schema is trunk's job; failing here
       * is this client's.
       */
      return parseItems(raw, (item) => CampaignSchema.parse(item), 'GET /v1/platform/campaigns');
    },
  });
}

export interface CampaignDecision {
  campaignId: string;
  status: 'approved' | 'rejected';
  /** Required on a rejection. The API refuses it by name, and so does the DB. */
  note?: string;
}

/**
 * IS THIS CAMPAIGN HELD — a question about `heldReason`, never about `status`.
 *
 * A held campaign's status stays `approved`. That is the API's deliberate choice
 * and the right one — "AVO did release it; the platform did not send it; both are
 * true" — but it means `status` alone cannot answer "did this go out", and any
 * screen that reads `status === 'approved'` as "away" is wrong about every held
 * campaign. `campaign_hold_is_complete` (both columns arrive together) and
 * `campaign_hold_requires_approved` (only an approved campaign can carry one) are
 * what make the single non-null test sufficient.
 *
 * Lives here beside the wire shape rather than in the screen that renders it,
 * because it is a fact about the contract and because a second surface needs the
 * same answer: the merchant's own Marketing → Campaigns list is owed this sentence
 * by #8 just as much as the console's queue is.
 */
export function isCampaignHeld(c: Pick<Campaign, 'heldReason'>): boolean {
  return c.heldReason !== null;
}

/**
 * What delivery did, the instant the decision was made.
 *
 * A SIBLING KEY ON THE ENVELOPE, NOT A FIELD ON THE CAMPAIGN. The API says so in
 * as many words at the bottom of its decision handler: "`delivery` is NOT part of
 * `CampaignSchema` — it is a sibling key on the response envelope rather than a
 * field on the campaign, so a client parsing `body.campaign` with the contract's
 * schema gets exactly the contract's shape and nothing is stripped."
 *
 * `null` on a rejection, and on approval of a `later` or `recurring` campaign —
 * nothing was delivered in either case, and #8 has the send-time checks run at
 * the scheduled moment rather than at approval.
 */
export interface CampaignDelivery {
  status: 'sent' | 'held';
  /** Recipients written. 0 on a hold. */
  sent: number;
  /** Audience members skipped for the weekly per-customer cap. */
  cappedOut: number;
  /** Set when held. The server's sentence, rendered verbatim. */
  heldReason: string | null;
  /** `campaign.result` when it sent — "612 reached · 148 over the weekly cap". */
  result: string | null;
}

export interface CampaignDecisionResult {
  campaign: Campaign;
  delivery: CampaignDelivery | null;
}

/**
 * Hand-checked for the reason `parseItems` above is: there is no
 * `CampaignDeliverySchema` in `@avo/types` (the shape is the API's
 * `DeliveryOutcome` interface, not a contract entity) and this package cannot
 * import `zod` directly.
 *
 * A MALFORMED `delivery` IS DROPPED TO NULL RATHER THAN THROWN ON, and that is
 * the opposite of how `heldReason` is treated one field up — deliberately. The
 * campaign IS the decision and must parse or fail loudly; `delivery` is a
 * courtesy sentence about what happened next, and losing the sentence must not
 * turn a decision that committed on the server into an error in the console.
 * That failure mode is exactly what this commit is fixing.
 */
function parseDelivery(value: unknown): CampaignDelivery | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v['status'] !== 'sent' && v['status'] !== 'held') return null;
  return {
    status: v['status'],
    sent: typeof v['sent'] === 'number' ? v['sent'] : 0,
    cappedOut: typeof v['cappedOut'] === 'number' ? v['cappedOut'] : 0,
    heldReason: typeof v['heldReason'] === 'string' ? v['heldReason'] : null,
    result: typeof v['result'] === 'string' ? v['result'] : null,
  };
}

/**
 * The whole response, as a pure function, EXPORTED SO A TEST CAN REACH IT.
 *
 * Extracted out of the `mutationFn` rather than left inline: this package has no
 * DOM test harness, so a parse living inside a hook callback is a parse no
 * assertion can touch — and this is precisely the line that was wrong. A comment
 * saying "parses body.campaign" is not an assertion; `platform.test.ts` feeds it
 * the envelope captured from the driven endpoint instead.
 */
export function parseDecisionResponse(raw: unknown): CampaignDecisionResult {
  const envelope = (raw ?? {}) as Record<string, unknown>;
  return {
    campaign: CampaignSchema.parse(envelope['campaign']),
    delivery: parseDelivery(envelope['delivery']),
  };
}

/**
 * THE DECISION. This is the endpoint non-negotiable #8 names: "Delivery happens
 * on the platform decision endpoint."
 *
 * PARSES `body.campaign`, NOT `body`. It used to do the latter, and the bug was
 * total rather than cosmetic: the response is `{ campaign, delivery }`, so
 * `CampaignSchema.parse(raw)` threw `id: Required | salonId: Required | salon:
 * Required | title: Required` on EVERY decision. The mutation therefore always
 * settled in error and the screen rendered "Nothing was released." — over a
 * decision that had already committed, sent the campaign, and written its audit
 * row. A reviewer told that nothing was released presses Approve again and gets
 * the 409, which reads as a second failure.
 *
 * That is the same defect class the API's own header describes on the other side
 * of this wire — a serialiser and a schema disagreeing, and the parse failing
 * shut — and it is why the parse belongs here rather than a cast: it was found by
 * driving the real endpoint and diffing the shape, not by reading either file.
 *
 * NO IDEMPOTENCY KEY, and that is not an oversight. #4 covers money-moving POSTs;
 * this moves no money. The double-submit protection is the server's, and it is
 * stronger than a key would be: the campaign row is read `FOR UPDATE` inside the
 * transaction and a second decision gets a 409 naming who decided it first. A
 * key would make the second press a silent replay of the first, which is the
 * wrong answer for two reviewers pressing Approve and Reject at the same moment.
 *
 * Invalidates the queue AND the policy: releasing a campaign changes the
 * month's counts, which the throttle panel reads.
 */
export function useDecideCampaign(): UseMutationResult<
  CampaignDecisionResult,
  unknown,
  CampaignDecision
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ campaignId, status, note }) => {
      const raw = await authedRequest<unknown>(
        'owner',
        `/v1/platform/campaigns/${encodeURIComponent(campaignId)}/decision`,
        { method: 'POST', body: { status, ...(note ? { note } : {}) } },
      );
      return parseDecisionResponse(raw);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['platform', 'campaigns'] });
      void queryClient.invalidateQueries({ queryKey: platformKeys.messagingPolicy });
    },
  });
}

export function useMessagingPolicy(): UseQueryResult<PlatformMessagingPolicy> {
  return useQuery({
    queryKey: platformKeys.messagingPolicy,
    queryFn: async ({ signal }) => {
      const raw = await authedRequest<unknown>('owner', '/v1/platform/messaging-policy', { signal });
      return PlatformMessagingPolicySchema.parse(raw);
    },
  });
}

/**
 * The throttle edit.
 *
 * A PATCH of only what changed, because the API refuses unknown fields by name
 * and validates each one's range (`weeklyCapPerCustomer` 1..7,
 * `monthlyCapPerSalon` 1..30). Sending the whole object back would make a
 * read-modify-write out of a single stepper press and would overwrite a
 * concurrent editor's other field.
 */
export function useUpdateMessagingPolicy(): UseMutationResult<
  PlatformMessagingPolicy,
  unknown,
  Partial<PlatformMessagingPolicy>
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (patch) => {
      const raw = await authedRequest<unknown>('owner', '/v1/platform/messaging-policy', {
        method: 'PATCH',
        body: patch,
      });
      return PlatformMessagingPolicySchema.parse(raw);
    },
    onSuccess: (policy) => {
      queryClient.setQueryData(platformKeys.messagingPolicy, policy);
      // The queue's quiet-hours flags are computed against the policy, so a
      // tightened window has to re-flag what is already on screen.
      void queryClient.invalidateQueries({ queryKey: ['platform', 'campaigns'] });
    },
  });
}

/* -------------------------------------------------------------- policies -- */

export interface PublishedSet {
  version: number;
  effectiveFrom: string;
  publishedAt: string;
  publishedBy: string;
  docs: LegalDoc[];
}

export interface PolicyDraft {
  docs: LegalDoc[];
  updatedBy: string | null;
  updatedAt: string | null;
}

/** `LegalDocSchema` is the trunk contract and does the real work per document. */
function parseDocs(value: unknown, where: string): LegalDoc[] {
  if (!Array.isArray(value)) throw new Error(`${where} did not return a docs array.`);
  return value.map((d) => LegalDocSchema.parse(d));
}

function parsePublishedSet(raw: unknown): PublishedSet {
  const v = (raw ?? {}) as Record<string, unknown>;
  const p = (v['published'] ?? {}) as Record<string, unknown>;
  if (typeof p['version'] !== 'number') {
    throw new Error('GET /v1/platform/policies returned no published version.');
  }
  return {
    version: p['version'],
    effectiveFrom: String(p['effectiveFrom'] ?? ''),
    publishedAt: String(p['publishedAt'] ?? ''),
    publishedBy: String(p['publishedBy'] ?? ''),
    docs: parseDocs(p['docs'], 'GET /v1/platform/policies'),
  };
}

function parseDraft(raw: unknown): PolicyDraft {
  const v = (raw ?? {}) as Record<string, unknown>;
  return {
    docs: parseDocs(v['docs'], 'GET /v1/platform/policies/draft'),
    updatedBy: typeof v['updatedBy'] === 'string' ? v['updatedBy'] : null,
    updatedAt: typeof v['updatedAt'] === 'string' ? v['updatedAt'] : null,
  };
}

/**
 * The published set. UNAUTHENTICATED on the server and read here with the console
 * session anyway — it is the same document a customer sees, and reading it beside
 * the draft is the whole point of the Policies screen.
 *
 * A 503 is a real answer: `policies_not_published` means the deployment has no
 * set at all, which the screen must say rather than showing an empty list.
 */
export function usePublishedPolicies(): UseQueryResult<PublishedSet> {
  return useQuery({
    queryKey: platformKeys.publishedPolicies,
    queryFn: async ({ signal }) => {
      const raw = await authedRequest<unknown>('owner', '/v1/platform/policies', { signal });
      return parsePublishedSet(raw);
    },
  });
}

export function usePolicyDraft(): UseQueryResult<PolicyDraft> {
  return useQuery({
    queryKey: platformKeys.draftPolicies,
    queryFn: async ({ signal }) => {
      const raw = await authedRequest<unknown>('owner', '/v1/platform/policies/draft', { signal });
      return parseDraft(raw);
    },
  });
}

/**
 * PUBLISH. Non-negotiable #10's other half: this is what bumps `version`, stamps
 * `publishedBy/At`, writes the platform audit row, and makes the wallet re-prompt
 * on next fetch.
 *
 * `effectiveFrom` is the caller's, not a default. api-contract.md § LegalDocumentSet
 * asks for "at least 30 days out for a material change" and the terms themselves
 * promise that notice — but WHETHER a change is material is a judgement the
 * console cannot make for the admin, so the screen surfaces the 30-day date and
 * lets her choose. The API refuses a date in the past.
 */
export function usePublishPolicies(): UseMutationResult<unknown, unknown, { effectiveFrom: string }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) =>
      authedRequest<unknown>('owner', '/v1/platform/policies/publish', {
        method: 'POST',
        body,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['platform', 'policies'] });
    },
  });
}

export function useDiscardDraft(): UseMutationResult<unknown, unknown, void> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      authedRequest<unknown>('owner', '/v1/platform/policies/discard', { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['platform', 'policies'] });
    },
  });
}
