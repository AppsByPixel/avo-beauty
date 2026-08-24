import { useEffect } from 'react';
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
  type UseInfiniteQueryResult,
  type UseMutationResult,
} from '@tanstack/react-query';
import { authedRequest } from '../auth/authedRequest.js';

/**
 * The owner console's Salons section: `GET /v1/platform/salons` (the list) and
 * `POST /v1/platform/salons` (the onboarding wizard's write, at the bottom).
 *
 * ONE CLIENT FILE PER SERVER ROUTE FILE is the house rule, and this endpoint
 * lives in `api/src/routes/platformConsole.ts` beside metrics/settings/audit. It
 * gets its own file anyway, for the reason that rule exists in the first place:
 * the thing a consumer most needs to get right here is the GATE, and this one is
 * not the gate its section name implies. Burying that four hundred lines down
 * `platformConsole.ts` is how it gets missed.
 *
 * =========================================================================
 * THE GATE IS `analytics`, NOT `salons` — AND THAT LOCKS OUT `support`
 * =========================================================================
 * Checked in the handler, not inferred from the name (platformConsole.ts:156):
 *
 *     requirePlatform(req, 'analytics');
 *
 * The route's own comment argues the choice and states the tiebreak as "gating
 * this list the same way widens nothing while unblocking the picker for every
 * preset (each one holds `analytics`)". THE PARENTHESIS IS FALSE, and it is the
 * half the console has to live with. `PLATFORM_ROLE_PRESETS` in
 * `api/src/db/schema/platformAdmin.ts:166`:
 *
 *     support: { analytics: false, activity: true, salons: TRUE, accounts: true, … }
 *
 * So the one preset the design labels "Support — accounts & salons" holds
 * `salons` and does NOT hold `analytics`. Driven against the real API on
 * `avo_lane_c`, with PLT-003 patched to `role: support` through
 * `PATCH /v1/platform/admins/:id`:
 *
 *     GET /v1/platform/salons   403
 *     {"error":"forbidden","message":"Your console account cannot open Analytics.
 *      The platform owner can grant it."}
 *
 * A support admin is refused the salon list, and told she lacks Analytics — a
 * section she is not trying to open. Reported to trunk; the gate is in `api/` and
 * is not this lane's to move.
 *
 * WHAT THE CONSOLE DOES ABOUT IT: `consoleNavItems.tsx` marks the Salons item
 * `section: 'analytics'`, because the courtesy gate has to name the section the
 * SERVER checks or it stops being a courtesy and becomes a second, wrong answer.
 * That is stated at the item rather than left to look like a typo.
 *
 * =========================================================================
 * WHAT THE DESIGN DRAWS AND THE WIRE DOES NOT CARRY
 * =========================================================================
 * Refused by the API on purpose, and the screen follows the refusal rather than
 * overriding it from the design — the same discipline `Analytics.tsx` applies to
 * the "Salons live" tile:
 *
 *   `live` / `suspended`   The design draws a Live toggle per row ("flip it off
 *                          to instantly suspend it") and `salon` has NO SUCH
 *                          COLUMN. There is nothing to read and nothing to write,
 *                          so the column is absent here rather than pinned to
 *                          `true` — a list that says five salons are live when the
 *                          product cannot suspend one is worse than a list that
 *                          does not raise the question.
 *
 * `city` WAS ONE OF THEM AND IS NOT ANY MORE. Migration 0037 added
 * `salon.city` (nullable) for the onboarding wizard's step 1, and the list
 * serialiser now emits it — checked on the wire, not taken from a summary, which
 * matters because the summary said the opposite:
 *
 *     GET /v1/platform/salons  →  {"id":"SAL-AMARA", … "city":null …}
 *                                 {"id":"SAL-GLOWBAR", … "city":"Jabriya" …}
 *
 * So the design's City column is drawn, and it is EMPTY for every salon that
 * predates the column — which is the honest rendering: the seeded two have no
 * city on record, and a dash says exactly that. `branchCount` keeps its column
 * too; it was never a stand-in for the city, it is its own fact.
 *
 * `ownerPhone` IS COLLECTED AND NEVER READ BACK. The wizard posts it, no endpoint
 * serves it — deliberately, per the migration, because members can read a salon.
 * So the console cannot show an admin the number she just typed. Named here so
 * nobody looks for the field.
 *
 * `memberCount` COUNTS TOMBSTONED (erased) MEMBERS, deliberately and per the
 * handler: an erased member's row survives so the books resolve, and this figure
 * is "wallets on the books" — the same number her transactions still roll up
 * into. Verified against SQL on `avo_lane_c` rather than against the endpoint's
 * own reply, because an endpoint agreeing with itself is not evidence.
 */

/** The wire's lowercase enums. `packages/types` § SalonSchema is the source. */
export const SALON_PLANS = ['starter', 'growth', 'pro'] as const;
export type SalonPlan = (typeof SALON_PLANS)[number];

export const LOYALTY_MODES = ['tiers', 'stamps'] as const;
export type LoyaltyMode = (typeof LOYALTY_MODES)[number];

/** `AVO Owner Console.dc.html:1282` § planPillMap — the design's capitalisation. */
export const PLAN_LABEL: Record<SalonPlan, string> = {
  starter: 'Starter',
  growth: 'Growth',
  pro: 'Pro',
};

/** Same file, `loyaltyStr`: `c.loyalty === 'tiers' ? 'Tiers' : 'Stamps'`. */
export const LOYALTY_LABEL: Record<LoyaltyMode, string> = {
  tiers: 'Tiers',
  stamps: 'Stamps',
};

export interface PlatformSalon {
  id: string;
  name: string;
  /** Null where the salon has not been given an Arabic name. Never guessed. */
  nameAr: string | null;
  /** Null for every salon created before migration 0037. See the header. */
  city: string | null;
  plan: SalonPlan;
  loyaltyMode: LoyaltyMode;
  /** Open branches only — the handler excludes `closed_at IS NOT NULL`. */
  branchCount: number;
  /** Includes erased members. See the header. */
  memberCount: number;
  createdAt: string;
}

export interface PlatformSalonPage {
  items: PlatformSalon[];
  /** A salon id, or null on the last page. Keyed by id ASC, not by seq. */
  nextCursor: string | null;
}

function str(v: unknown, where: string): string {
  if (typeof v !== 'string') throw new Error(`${where} was not a string.`);
  return v;
}

function count(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new Error(`${where} was not a whole count.`);
  }
  return v;
}

/**
 * PARSED RATHER THAN CAST, the same reasoning `parsePlatformMetrics` carries.
 *
 * The two enums are validated against the vocabularies above rather than passed
 * through as strings, and that is the load-bearing part: `plan` chooses a badge
 * token and `loyaltyMode` chooses a word, so an unrecognised value would render
 * `undefined` into a cell or paint a badge with no colour. Failing loudly on the
 * first request puts the drift in front of whoever caused it — the alternative is
 * a console that quietly shows a blank column for a fourth plan AVO just sold.
 */
export function parsePlatformSalonPage(raw: unknown): PlatformSalonPage {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('GET /v1/platform/salons was not an object.');
  }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.items)) throw new Error('salons.items was not an array.');
  if (r.nextCursor !== null && typeof r.nextCursor !== 'string') {
    throw new Error('salons.nextCursor was neither a salon id nor null.');
  }

  return {
    nextCursor: r.nextCursor,
    items: r.items.map((row, i) => {
      if (typeof row !== 'object' || row === null) {
        throw new Error(`salons.items[${i}] was not an object.`);
      }
      const s = row as Record<string, unknown>;
      const plan = str(s.plan, `salons.items[${i}].plan`);
      if (!(SALON_PLANS as readonly string[]).includes(plan)) {
        throw new Error(`salons.items[${i}].plan was "${plan}", not a known plan.`);
      }
      const mode = str(s.loyaltyMode, `salons.items[${i}].loyaltyMode`);
      if (!(LOYALTY_MODES as readonly string[]).includes(mode)) {
        throw new Error(`salons.items[${i}].loyaltyMode was "${mode}", not a known mode.`);
      }
      if (s.nameAr !== null && typeof s.nameAr !== 'string') {
        throw new Error(`salons.items[${i}].nameAr was neither a string nor null.`);
      }
      /*
       * `city` MUST be present as a key, and MAY be null. Missing entirely is a
       * different fact from null — it would mean this client is talking to an API
       * from before 0037, and rendering an empty City column for that is a silent
       * downgrade rather than an empty record.
       */
      if (!('city' in s)) throw new Error(`salons.items[${i}] carried no city key.`);
      if (s.city !== null && typeof s.city !== 'string') {
        throw new Error(`salons.items[${i}].city was neither a string nor null.`);
      }
      return {
        id: str(s.id, `salons.items[${i}].id`),
        name: str(s.name, `salons.items[${i}].name`),
        nameAr: s.nameAr,
        city: s.city,
        plan: plan as SalonPlan,
        loyaltyMode: mode as LoyaltyMode,
        branchCount: count(s.branchCount, `salons.items[${i}].branchCount`),
        memberCount: count(s.memberCount, `salons.items[${i}].memberCount`),
        createdAt: str(s.createdAt, `salons.items[${i}].createdAt`),
      };
    }),
  };
}

export const platformSalonKeys = {
  list: ['platform', 'salons'] as const,
};

/**
 * Cursor-paginated, like the audit reads. Two salons on a dev seed and a list
 * endpoint that only works while the table is small is a regression waiting for
 * success — the handler's words, and the client honours the cursor rather than
 * assuming one page.
 */
export function usePlatformSalons(): UseInfiniteQueryResult<InfiniteData<PlatformSalonPage>> {
  return useInfiniteQuery({
    queryKey: platformSalonKeys.list,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const query = pageParam === null ? '' : `?cursor=${encodeURIComponent(pageParam)}`;
      return parsePlatformSalonPage(
        await authedRequest<unknown>('owner', `/v1/platform/salons${query}`, { signal }),
      );
    },
    getNextPageParam: (last) => last.nextCursor,
  });
}

/**
 * Every salon, for a control that must offer ALL of them — the Audit screen's
 * `?salon=` picker.
 *
 * A PICKER SHOWING THE FIRST PAGE IS A LIE OF OMISSION: the reader cannot tell a
 * salon that is missing from the list from a salon that does not exist, and the
 * whole point of the control is to answer "what happened at Glow Bar". So this
 * wrapper walks the cursor to the end instead of rendering a truncated menu.
 *
 * `isPending` stays the FIRST page's pending — a menu that appears with two
 * entries and then grows is fine; a control that never appears is not. `complete`
 * is exposed so a caller that needs the stronger guarantee can wait for it.
 */
export function useAllPlatformSalons(): {
  salons: PlatformSalon[];
  isPending: boolean;
  isError: boolean;
  complete: boolean;
} {
  const query = usePlatformSalons();
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;

  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return {
    salons: (query.data?.pages ?? []).flatMap((p) => p.items),
    isPending: query.isPending,
    isError: query.isError,
    complete: query.isSuccess && !hasNextPage,
  };
}

/* ==================================================== ONBOARD — the write == */

/**
 * `POST /v1/platform/salons`, the four-step wizard's write.
 *
 * =========================================================================
 * THE CREATE'S GATE IS `salons`. THE LIST'S IS `analytics`. THEY ARE DIFFERENT
 * AUTHORITIES AND THE SCREEN HAS TO SAY SO.
 * =========================================================================
 * Driven on `avo_lane_c`, with `mariam.k` — the seeded analyst, `analytics: true,
 * salons: false`:
 *
 *   GET  /v1/platform/salons   200   she reads every salon
 *   POST /v1/platform/salons   403   "Your console account cannot open Salons.
 *                                     The platform owner can grant it."
 *
 * The handler's reasoning is worth carrying: `analytics` is the ONE section every
 * preset holds, and the design calls an analyst "read-only metrics" — gating
 * creation there would hand every analyst the power to mint a tenant, an owner
 * credential and an invite to a phone number.
 *
 * So `Salons.tsx` courtesy-gates the "+ Onboard a salon" button on
 * `sections.salons` while the list stays open to `analytics`. That is the one
 * place in this console where the two facts diverge on a single screen, and #7 is
 * intact either way: the button is a courtesy and the 403 above is the control.
 *
 * =========================================================================
 * IDEMPOTENCY: MINTED ON ENTERING REVIEW, HELD ACROSS RETRIES
 * =========================================================================
 * `Idempotency-Key` is REQUIRED — 400 `idempotency_key_required` without one, and
 * the handler's own note explains why a create is keyed when
 * `PATCH /v1/platform/settings` next door is not: there is no natural key (two
 * clients can share a name), the id is server-minted so a retry cannot be
 * idempotent by id, and a double submit does not merely duplicate a row — it
 * sends one client two sign-ins for two salons, one of them a ghost.
 *
 * Measured, both halves, against the real endpoint:
 *
 *   same key + same body       201 and the SAME salon id back (a replay)
 *   same key + different body  422 `idempotency_key_reused`
 *
 * That second line is what fixes WHERE the key is minted. It cannot be minted per
 * click (a double-tap would make two salons) and it cannot be minted once per
 * wizard (going Back, editing a field and resubmitting would 422 forever). It is
 * minted on every ENTRY into the review step: a double-tapped Confirm replays one
 * key, and an edit-then-resubmit arrives with a fresh one. The key lives in the
 * wizard, not in this hook, because only the wizard knows when review was entered.
 *
 * TWO GLOW BARS EXIST ON THIS LANE'S DATABASE because the first driven create ran
 * twice under two different keys. That is the hazard, reproduced: the endpoint
 * accepted both, minted `SAL-GLOWBAR` and `SAL-GLOWBAR2`, and neither is wrong on
 * its own. The key is the only thing standing between a fat-fingered Confirm and
 * exactly that.
 */
export interface OnboardSalonInput {
  /* step 1 — details & plan */
  name: string;
  nameAr?: string;
  city: string;
  /** E.164. The server refuses anything else by name: `invalid_phone`. */
  ownerPhone: string;
  /** The design's Title-Case label. `parsePlan` case-folds it at the door. */
  plan: string;
  /* step 2 — modules & deposit */
  modules: { booking: boolean; shop: boolean };
  /** INTEGER FILS. Non-negotiable #1 — no float reaches this field. */
  depositFils: number;
  /* step 3 — loyalty & brand */
  loyaltyMode: LoyaltyMode;
  /** Stamps mode only. The server fills the tier ladder from DEFAULT_LOYALTY. */
  stampTarget?: number;
  brandColor: string;
}

/**
 * `{ salon, owner, invite }` — an ENVELOPE, and the handler is explicit that it is
 * deliberately not the entity with extra keys, because `SalonSchema` strips
 * undeclared ones and a top-level `invite` would vanish in exactly the client
 * that validates.
 *
 * `invite.delivered` IS TYPED `false`, not `boolean`. No WhatsApp sender is wired
 * — the standing client escalation — and the server sends the literal. Typing it
 * as the literal means a screen cannot branch on it and accidentally grow a
 * "sent!" path that is unreachable today and wrong tomorrow.
 */
export interface OnboardSalonResult {
  salon: { id: string; name: string; city: string | null; brandColor: string };
  owner: { staffId: string; name: string; handle: string; role: string; passwordSet: false };
  invite: { channel: 'whatsapp'; to: string; expiresAt: string; delivered: false };
}

export function useOnboardSalon(): UseMutationResult<
  OnboardSalonResult,
  unknown,
  { input: OnboardSalonInput; idempotencyKey: string }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ input, idempotencyKey }) =>
      authedRequest<OnboardSalonResult>('owner', '/v1/platform/salons', {
        method: 'POST',
        body: input,
        idempotencyKey,
      }),
    /*
     * INVALIDATED, NOT PUSHED. The response carries the salon but not
     * `branchCount`/`memberCount`, and the list is keyed by id ASC with a cursor —
     * so splicing a row in would put it in the wrong place with two invented
     * zeros. A refetch is one request and the numbers are the server's.
     */
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: platformSalonKeys.list });
    },
  });
}
