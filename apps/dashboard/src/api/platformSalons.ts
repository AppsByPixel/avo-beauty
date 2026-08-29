import { useEffect } from 'react';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type UseInfiniteQueryResult,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { Branch, Tier } from '@avo/types';
import { authedRequest } from '../auth/authedRequest.js';
import { TIER_LADDER } from './loyalty.js';
/*
 * MOVED OUT, AND RE-EXPORTED SO EVERY EXISTING IMPORT STILL RESOLVES HERE.
 * `platformSalonKeys.ts` says why it is its own file: `loyalty.ts` has to
 * invalidate these rows after a console publish, and this module already imports
 * `loyalty.ts`.
 */
import { platformSalonDetailKey, platformSalonKeys } from './platformSalonKeys.js';

export { platformSalonDetailKey, platformSalonKeys };

/**
 * The owner console's Salons section: `GET /v1/platform/salons` (the list) and
 * `POST /v1/platform/salons` (the onboarding wizard's write, at the bottom).
 *
 * ONE CLIENT FILE PER SERVER ROUTE FILE is the house rule, and this endpoint
 * lives in `api/src/routes/platformConsole.ts` beside metrics/settings/audit. It
 * gets its own file anyway, for the reason that rule exists in the first place:
 * the thing a consumer most needs to get right here is the GATE. Burying that
 * four hundred lines down `platformConsole.ts` is how it gets missed.
 *
 * =========================================================================
 * THE GATE IS `salons`, AND THIS FILE ARGUED THE OPPOSITE FOR EIGHT WEEKS
 * =========================================================================
 * Checked in the handler, not inferred from the name (platformConsole.ts:243):
 *
 *     requirePlatform(req, 'salons');
 *
 * This header used to carry forty lines proving the gate was `analytics`, with a
 * driven 403 and a preset table, under the heading "THE GATE IS `analytics`, NOT
 * `salons` — AND THAT LOCKS OUT `support`". All of it was true when written.
 * Commit 4cc03c5 regated the route and every word of it inverted at once: the
 * gate, the locked-out preset, and the advice it gave `consoleNavItems.tsx`.
 *
 * THE COMPLAINT WAS ANSWERED, WHICH IS WHY IT IS GONE RATHER THAN AMENDED. The
 * old note reported the mismatch to trunk and said "the gate is in `api/` and is
 * not this lane's to move". It was moved, in the direction this file asked for.
 * `support` — the preset the design labels "Support — accounts & salons" — now
 * holds `salons` and can read the salon list, which is what that label always
 * implied. `PLATFORM_ROLE_PRESETS`, `api/src/db/schema/platformAdmin.ts:166`:
 *
 *     support: { analytics: false, activity: true, salons: true, accounts: true, … }
 *
 * WHAT THE CONSOLE DOES ABOUT IT: `consoleNavItems.tsx` marks the Salons item
 * `section: 'salons'`, because the courtesy gate has to name the section the
 * SERVER checks or it stops being a courtesy and becomes a second, wrong answer.
 * It named `analytics` for the whole eight weeks — correct prose, obsolete fact,
 * and it mis-filtered the sidebar in both directions the entire time.
 *
 * SO THE GATE IS NO LONGER MERELY DOCUMENTED HERE, IT IS ASSERTED.
 * `shell/consoleNavGates.test.ts` parses `api/src/routes/` and fails if the
 * sidebar's section is not the one the server enforces. If this paragraph and
 * that test ever disagree, THE TEST IS RIGHT — it re-reads the server on every
 * run, and this paragraph was last read by a human on the day it was written.
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
 * `ownerPhone` IS NOT ON THIS LIST, AND IT IS NO LONGER UNREADABLE ANYWHERE. This
 * paragraph used to end "no endpoint serves it — deliberately, per the migration,
 * because members can read a salon. So the console cannot show an admin the number
 * she just typed." The REASONING still holds; the CONCLUSION expired at 4cc03c5.
 * `GET /v1/platform/salons/:id` serves it in an ENVELOPE beside the salon rather
 * than on it, which is how both facts are true at once: it stays outside
 * `SalonSchema`, so the member-readable `GET /salons/{id}` still cannot carry it,
 * and the console still gets it. See `usePlatformSalon` at the bottom of this file.
 *
 * It stays off the LIST because the list serialises through `serialiseSalon` and
 * the envelope belongs to the detail route alone — not because it is unreadable.
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
 * THE CREATE'S GATE IS `salons` — AND SO IS THE LIST'S, NOW
 * =========================================================================
 * This block used to open "THE CREATE'S GATE IS `salons`. THE LIST'S IS
 * `analytics`. THEY ARE DIFFERENT AUTHORITIES AND THE SCREEN HAS TO SAY SO", and
 * proved it by driving both calls as the seeded analyst `mariam.k`
 * (`analytics: true, salons: false`): the GET answered 200 and the POST 403.
 *
 * Commit 4cc03c5 regated the list to `salons`, so that same analyst is now
 * refused BOTH — and the divergence this section was written to explain is gone.
 * The two routes are still separate gates that could diverge again; they simply
 * name the same section today.
 *
 * The create's own reasoning is unchanged and still worth carrying: the design
 * calls an analyst "read-only metrics", and gating creation on `analytics` would
 * hand every analyst the power to mint a tenant, an owner credential and an
 * invite to a phone number.
 *
 * `Salons.tsx` still courtesy-gates the "+ Onboard a salon" button on
 * `sections.salons`. On a rendered Salons screen that is now always true, since
 * the list read demands the same section — kept because it names ITS OWN
 * endpoint's gate, which is the only form of courtesy that survives a regating.
 * #7 intact either way: the button is a courtesy and the 403 is the control.
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

/* ================================================ ONE SALON — the editor == */

/**
 * `GET` and `PATCH /v1/platform/salons/:id`, both `requirePlatform(req, 'salons')`
 * (platformConsole.ts:340, :351). The per-salon editor's two calls.
 *
 * =========================================================================
 * THE BLOCKER THESE REPLACE, AND WHY IT IS WORTH NAMING
 * =========================================================================
 * Three files in this lane carried a driven 404 on `GET /v1/platform/salons/:id`
 * as evidence that a console admin could not read or write one salon, and the
 * editor was not drawn on the strength of it. Commit 4cc03c5 built both routes.
 * The evidence was real, it was cited with a line number, and it expired without
 * anything noticing — the same failure `consoleNavGates.test.ts` was written for
 * one field over. An absence claim is the one kind of comment that cannot be
 * checked by rereading the file it sits in.
 *
 * =========================================================================
 * NOT IDEMPOTENCY-KEYED, AND THAT IS THE HANDLER'S DECISION NOT AN OMISSION
 * =========================================================================
 * `POST /v1/platform/salons` next door REQUIRES `Idempotency-Key` and 400s
 * without one. This PATCH deliberately takes none, and platformConsole.ts:330-338
 * gives the distinction — the same one `PATCH /v1/platform/settings` carries:
 *
 *   the POST   mints a tenant, a credential and an invite. A retry that lands
 *              twice sends one client two sign-ins for two salons.
 *   this PATCH sets fields to ABSOLUTE values. A replay produces the same row,
 *              so there is no second application to prevent.
 *
 * What a retry CAN do here is overwrite a concurrent edit by another admin — a
 * lost update, not a double-spend, and the same exposure the merchant's own
 * `PATCH /salons/{id}` has always had. The screen answers it the way `Controls`
 * does: the draft is rebuilt from the server whenever the server's row changes
 * underneath it, so a stale local edit is never displayed as if it had saved.
 * `SalonEditor.tsx` § the draft.
 *
 * =========================================================================
 * WHAT THIS CLIENT SENDS, AND WHY IT IS NARROWER THAN THE SERVER ACCEPTS
 * =========================================================================
 * `PLATFORM_EDITABLE` (routes/salons.ts:144) is the MERCHANT set plus `city` and
 * `ownerPhone` — sixteen fields. `PlatformSalonPatch` below declares five. The
 * gap is not an oversight and it is not a limitation to route around: the design's
 * editor draws modules, deposit and loyalty structure, and nothing else. Sending a
 * field no control edits would mean this screen could change a salon's timezone or
 * business hours through a form that never showed them.
 *
 * `plan` IS IN NEITHER SET, on the server's side. The design puts per-salon plan
 * and fee in BILLING, Billing has no API at all, and the handler's comment is
 * explicit: "Adding a plan write here would be inventing the cheap half of a
 * subscription model." So the editor header renders the plan and cannot change it.
 */

/**
 * The salon as the detail route serialises it, narrowed to what the editor reads.
 *
 * PARSED, NOT `SalonSchema.parse`, AND THE SHARED SCHEMA IS THE REASON RATHER THAN
 * A CONVENIENCE — MEASURED, NOT REASONED. `SalonSchema` spells the dormant loyalty
 * fields `.optional()`, which admits `undefined` and REFUSES `null`. The columns
 * are nullable and `salon_loyalty_config_complete` only guarantees the ACTIVE side
 * is set, so `serialiseSalon` emits nulls for the other one. Run against the real
 * body of `GET /v1/platform/salons/SAL-LUMIERE` on `avo_lane_c`:
 *
 *     SalonSchema.safeParse(body.salon)
 *       → REFUSED  stampTarget: Expected number, received null
 *                  stampReward: Expected string, received null
 *
 * `stampReward` is in that list and was NOT in this note's first draft, which
 * named `tiers` and `stampTarget` from reading the schema. Reading found two
 * fields and driving found a different two — the reason this paragraph now quotes
 * an actual refusal. (`tiers: z.array(TierSchema).optional()` has the same shape
 * and the same hazard; neither seeded salon has a null ladder, so it is named as
 * unexercised rather than claimed as proven.)
 *
 * Nothing has caught this because nothing parses that endpoint: `useSalon` casts
 * (`authedRequest<Salon>`) and a cast cannot fail. REPORTED TO TRUNK —
 * `packages/types` is trunk-owned and `.nullable()` there is a four-surface change,
 * not a lane C edit. Until it lands this file owns a parser that admits the nulls
 * the API actually sends.
 *
 * The narrow field set is the second reason: `businessHours`, `social` and
 * `timezone` all carry their own validated shapes in `packages/types`, and
 * re-deriving them here to read fields no control edits would be the duplicate
 * spelling `MERCHANT_EDITABLE`'s § modules comment refuses.
 */
export interface PlatformSalonRecord {
  id: string;
  name: string;
  /** Null where the salon has no Arabic name. Not drawn; carried for the header. */
  nameAr: string | null;
  /** Null for every salon created before migration 0037. */
  city: string | null;
  plan: SalonPlan;
  modules: { booking: boolean; shop: boolean };
  loyaltyMode: LoyaltyMode;
  /** NULL on a stamps salon. See the parser note above. */
  tiers: Tier[] | null;
  /** NULL on a tiers salon. Same. */
  stampTarget: number | null;
  /** Integer fils. Non-negotiable #1 — no float, ever, on the way in or out. */
  depositFils: number;
  /** OPEN branches only — `openBranchesOf` excludes `closed_at IS NOT NULL`. */
  branches: Branch[];
}

/**
 * `{ salon, ownerPhone }` — an envelope, for the reason the handler gives:
 * `ownerPhone` is not part of `serialiseSalon` because `GET /salons/{id}` is
 * readable by any principal of the salon, members included, and a Zod parse
 * through `SalonSchema` would silently strip a top-level extra key anyway.
 *
 * `ownerPhone` IS PARSED AND IS NOT DRAWN. The design's editor header is
 * "{city} · {plan} plan · {n} members" and has no phone in it, so nothing renders
 * this — "do not add features". It is parsed rather than ignored because the
 * envelope has exactly two keys and a server that stopped sending one should fail
 * here rather than at whichever screen wants it first.
 *
 * IT IS NULLABLE, AND THIS FIELD WAS TYPED `string` UNTIL THE ENDPOINT WAS DRIVEN.
 * `owner_phone` is a nullable column (db/schema/salon.ts:86, with a CHECK that
 * reads `IS NULL OR …E.164`) added by migration 0037 for the onboarding wizard —
 * so it is null for every salon that predates the wizard, which on a fresh seed is
 * ALL of them:
 *
 *     GET /v1/platform/salons/SAL-AMARA  →  {"salon":{…},"ownerPhone":null}
 *
 * A required `string` here made the parser throw on that body, which would have
 * failed the editor's read on every seeded salon and rendered it as a server
 * error. Exactly the shape of `city`, one field over, whose nullability this file
 * already documents at length — and it was still got wrong, because it was
 * inferred from the endpoint's purpose rather than read off the wire. Driving the
 * endpoint is what caught it; the types compiled cleanly either way.
 */
export interface PlatformSalonDetail {
  salon: PlatformSalonRecord;
  /** Null for every salon created before migration 0037. Not drawn. */
  ownerPhone: string | null;
}

function bool(v: unknown, where: string): boolean {
  if (typeof v !== 'boolean') throw new Error(`${where} was not a boolean.`);
  return v;
}

/**
 * The tier ladder as STORED, which is not always the ladder the API will accept.
 *
 * =========================================================================
 * IT DOES NOT REQUIRE FOUR RUNGS, AND IT DID UNTIL THE ENDPOINT WAS DRIVEN
 * =========================================================================
 * `parseTiers` in `services/loyaltyRules.ts` refuses anything but four —
 * "A ladder has all four tiers — Bronze, Silver, Gold, Black. Got 2." — so the
 * first version of this function mirrored that and threw on a short ladder. Then
 * `GET /v1/platform/salons/SAL-LUMIERE` came back off a plain seed:
 *
 *     "loyaltyMode": "tiers",
 *     "tiers": [ {"name":"bronze",…}, {"name":"silver",…} ]      ← TWO rungs, live
 *
 * confirmed in SQL rather than from the reply — `jsonb_array_length(tiers)` is 2
 * on `avo_lane_c`. A four-rung requirement here would have thrown on the parse and
 * failed the editor's READ for that salon, reporting a legacy row as a broken
 * server.
 *
 * THE SERVER ALREADY DREW THIS DISTINCTION AND SAID WHY. `parseLoyaltyConfig`
 * validates a stored ladder only when a request PUTS IT INTO EFFECT, after lane
 * D's suite found the strict version answering
 * "A ladder has all four tiers … Got 2" to a request that never mentioned tiers —
 * "not a guard, a salon locked out of editing anything until it republishes a
 * ladder it did not ask to change". Reading is not putting into effect, so reading
 * is permissive here too. `SalonLoyalty.tsx` holds the other half: a short ladder
 * is shown and is not sent — and after the loyalty authority reversal it cannot be
 * repaired from anywhere, which that file escalates rather than papers over.
 *
 * WHAT IS STILL REFUSED is a ladder this screen could not RENDER: an unknown rung
 * name, or rungs out of ladder order. The editor maps them positionally against
 * `TIER_LADDER` — imported rather than restated, because a second local copy of
 * "bronze → silver → gold → black" is how a client comes to draw five rows against
 * a server that accepts four.
 */
function parseTiers(v: unknown, where: string): Tier[] {
  if (!Array.isArray(v)) throw new Error(`${where} was not an array.`);
  if (v.length > TIER_LADDER.length) {
    throw new Error(`${where} had ${v.length} rungs, more than the ladder's ${TIER_LADDER.length}.`);
  }

  let previous = -1;
  return v.map((row, i) => {
    if (typeof row !== 'object' || row === null) {
      throw new Error(`${where}[${i}] was not an object.`);
    }
    const t = row as Record<string, unknown>;
    const name = str(t.name, `${where}[${i}].name`);
    const rung = (TIER_LADDER as readonly string[]).indexOf(name);
    if (rung === -1) throw new Error(`${where}[${i}].name was "${name}", not a ladder tier.`);
    /*
     * ORDER IS REQUIRED EVEN THOUGH COMPLETENESS IS NOT. A ladder is a sequence of
     * thresholds, each above the one below; rendered out of order it would read as
     * a valid ladder that is not one, and the editor's own "must be more visits
     * than the rung below" check would then flag the wrong row.
     */
    if (rung <= previous) {
      throw new Error(`${where}[${i}] ("${name}") was not above the rung before it.`);
    }
    previous = rung;
    return {
      name: name as Tier['name'],
      minVisits: count(t.minVisits, `${where}[${i}].minVisits`),
      bonusPercent: count(t.bonusPercent, `${where}[${i}].bonusPercent`),
    };
  });
}

/**
 * Whether a stored ladder is one the API would accept back.
 *
 * The client half of `services/loyaltyRules.ts` § parseTiers. A ladder that is not
 * exactly the four rungs cannot be SENT — not because this client refuses it, but
 * because the endpoint does — so the editor shows it and withholds the write
 * rather than offering a Save that can only 400.
 */
export function isCompleteLadder(tiers: Tier[] | null): tiers is Tier[] {
  return tiers !== null && tiers.length === TIER_LADDER.length;
}

function parseBranches(v: unknown, where: string): Branch[] {
  if (!Array.isArray(v)) throw new Error(`${where} was not an array.`);
  return v.map((row, i) => {
    if (typeof row !== 'object' || row === null) {
      throw new Error(`${where}[${i}] was not an object.`);
    }
    const b = row as Record<string, unknown>;
    if (b.nameAr !== null && typeof b.nameAr !== 'string') {
      throw new Error(`${where}[${i}].nameAr was neither a string nor null.`);
    }
    return {
      id: str(b.id, `${where}[${i}].id`),
      salonId: str(b.salonId, `${where}[${i}].salonId`),
      name: str(b.name, `${where}[${i}].name`),
      nameAr: b.nameAr,
    };
  });
}

export function parsePlatformSalonDetail(raw: unknown): PlatformSalonDetail {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('GET /v1/platform/salons/:id was not an object.');
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.salon !== 'object' || r.salon === null || Array.isArray(r.salon)) {
    throw new Error('The salon envelope carried no salon.');
  }
  const s = r.salon as Record<string, unknown>;

  const plan = str(s.plan, 'salon.plan');
  if (!(SALON_PLANS as readonly string[]).includes(plan)) {
    throw new Error(`salon.plan was "${plan}", not a known plan.`);
  }
  const mode = str(s.loyaltyMode, 'salon.loyaltyMode');
  if (!(LOYALTY_MODES as readonly string[]).includes(mode)) {
    throw new Error(`salon.loyaltyMode was "${mode}", not a known mode.`);
  }
  if (s.nameAr !== null && typeof s.nameAr !== 'string') {
    throw new Error('salon.nameAr was neither a string nor null.');
  }
  if (!('city' in s)) throw new Error('salon carried no city key.');
  if (s.city !== null && typeof s.city !== 'string') {
    throw new Error('salon.city was neither a string nor null.');
  }
  if (typeof s.modules !== 'object' || s.modules === null) {
    throw new Error('salon.modules was not an object.');
  }
  const m = s.modules as Record<string, unknown>;

  /*
   * THE ACTIVE SIDE IS REQUIRED, THE DORMANT SIDE MAY BE NULL — the client half of
   * `salon_loyalty_config_complete`. A tiers salon whose ladder came back null
   * would otherwise reach the editor and render four rungs of `undefined` with
   * working steppers, which is a screen that invites somebody to publish a ladder
   * built from nothing. The dormant side is KEPT rather than dropped: the server
   * preserves a stamp card across a spell in tiers mode, so the editor must be able
   * to show it again on the way back.
   */
  const tiers = s.tiers === null || s.tiers === undefined ? null : parseTiers(s.tiers, 'salon.tiers');
  const stampTarget =
    s.stampTarget === null || s.stampTarget === undefined
      ? null
      : count(s.stampTarget, 'salon.stampTarget');
  if (mode === 'tiers' && tiers === null) {
    throw new Error('salon.loyaltyMode was "tiers" but no tier ladder came with it.');
  }
  if (mode === 'stamps' && stampTarget === null) {
    throw new Error('salon.loyaltyMode was "stamps" but no stamp target came with it.');
  }

  /*
   * PRESENT-BUT-NULL AND ABSENT ARE DIFFERENT FACTS, the distinction the list
   * parser draws for `city`. A missing key means this client is talking to an API
   * from before the envelope existed, and defaulting that to null would silently
   * downgrade rather than report.
   */
  if (!('ownerPhone' in r)) throw new Error('The salon envelope carried no ownerPhone key.');
  if (r.ownerPhone !== null && typeof r.ownerPhone !== 'string') {
    throw new Error('ownerPhone was neither a string nor null.');
  }

  return {
    ownerPhone: r.ownerPhone,
    salon: {
      id: str(s.id, 'salon.id'),
      name: str(s.name, 'salon.name'),
      nameAr: s.nameAr,
      city: s.city,
      plan: plan as SalonPlan,
      modules: {
        booking: bool(m.booking, 'salon.modules.booking'),
        shop: bool(m.shop, 'salon.modules.shop'),
      },
      loyaltyMode: mode as LoyaltyMode,
      tiers,
      stampTarget,
      /*
       * `count` and not a cast: `depositFils` is money, and the one thing that
       * must never arrive here is a float. `salon_deposit_in_range` and
       * `parseDepositFils` both hold the server side; this holds the client's.
       */
      depositFils: count(s.depositFils, 'salon.depositFils'),
      branches: parseBranches(s.branches, 'salon.branches'),
    },
  };
}


export function usePlatformSalon(id: string): UseQueryResult<PlatformSalonDetail> {
  return useQuery({
    queryKey: platformSalonDetailKey(id),
    queryFn: async ({ signal }) =>
      parsePlatformSalonDetail(
        await authedRequest<unknown>('owner', `/v1/platform/salons/${encodeURIComponent(id)}`, {
          signal,
        }),
      ),
  });
}

/**
 * What the editor may send. See § WHAT THIS CLIENT SENDS above for why this is
 * five fields and not sixteen.
 *
 * `depositFils` is a plain `number` rather than `Fils` because that is the shape
 * `authedRequest` puts on the wire either way, and the branding is enforced where
 * it matters — the control formats through `fils()` at the display boundary. No
 * arithmetic happens on this value in this file.
 */
/**
 * THE THREE LOYALTY FIELDS LEFT THIS PATCH, AND THE ROUTE STILL ACCEPTS THEM.
 *
 * `PATCH /v1/platform/salons/{id}` takes `loyaltyMode`, `tiers`, `stampTarget`
 * and the two stamp-reward strings — they moved from `MERCHANT_EDITABLE` into
 * `PLATFORM_ONLY_EDITABLE` when loyalty authority moved to AVO, so the console
 * genuinely may write them here. Driven, on this lane's own database:
 *
 *     PATCH /v1/platform/salons/SAL-AMARA {"tiers":[…4 rungs…]}   →  200
 *
 * They are gone from this type anyway, because the console now has `PUT
 * /salons/{id}/loyalty` and two doors into `salon.tiers` is the defect that
 * endpoint's own header spends a paragraph on — "the console's copy is the one
 * nobody would be watching". The difference is not cosmetic:
 *
 *   PATCH writes the audit row `Changed by AVO: tiers`. PUT writes
 *   `Tier rules published`, which is the string a MERCHANT's audit log renders
 *   and the one `routes/audit.ts` promises her ("AVO platform staff actions on
 *   your salon appear here too, marked Owner console"). Publishing through PATCH
 *   would file the ladder change under a different sentence in the log the salon
 *   reads to find out why Gold moved.
 *
 *   PATCH answers with the salon row. PUT answers with `publishedBy`,
 *   `publishedAt`, `appliesAt: 'next_visit'` and the server's own confirmation
 *   sentence — the difference between a save that returned 200 and a publish that
 *   can be shown to have taken effect. On someone else's live commercial terms
 *   that is the whole point.
 *
 * So this patch is modules and deposit. `api/loyalty.ts` owns the rest.
 */
export interface PlatformSalonPatch {
  modules?: { booking: boolean; shop: boolean };
  depositFils?: number;
}

/**
 * The write.
 *
 * `setQueryData` FROM THE RESPONSE, not `invalidateQueries` — and this is the one
 * place the console PATCH differs from the merchant one it shares a translator
 * with. `PATCH /salons/{id}` ends on `reply.send(after)` with the raw Drizzle row,
 * which is why `useUpdateSalon` in `settings.ts` types its response `unknown` and
 * refetches instead (writing that row into the cache took the whole dashboard to
 * its error boundary). This route ends on
 * `serialiseSalon(after, await openBranchesOf(after.id))` — the SAME shape the GET
 * answers — so the response is authoritative and a refetch would be a second round
 * trip to learn what we were just told.
 *
 * It is parsed on the way in regardless. A response trusted because a comment says
 * it is serialised is exactly the assumption that crashed the other screen.
 *
 * THE LIST IS INVALIDATED TOO. `loyaltyMode` is a column on the list, so an editor
 * save that changes the mechanic leaves the list behind it showing "Tiers" for a
 * salon now on stamps.
 */
export function useUpdatePlatformSalon(
  id: string,
): UseMutationResult<PlatformSalonDetail, unknown, PlatformSalonPatch> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (patch) =>
      parsePlatformSalonDetail(
        await authedRequest<unknown>('owner', `/v1/platform/salons/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: patch,
        }),
      ),
    onSuccess: (detail) => {
      queryClient.setQueryData<PlatformSalonDetail>(platformSalonDetailKey(id), detail);
      void queryClient.invalidateQueries({ queryKey: platformSalonKeys.list });
    },
  });
}
