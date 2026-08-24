import { useEffect } from 'react';
import {
  useInfiniteQuery,
  type InfiniteData,
  type UseInfiniteQueryResult,
} from '@tanstack/react-query';
import { authedRequest } from '../auth/authedRequest.js';

/**
 * `GET /v1/platform/salons` — the owner console's Salons list.
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
 * TWO FIELDS THE DESIGN DRAWS AND THE WIRE DOES NOT CARRY
 * =========================================================================
 * Both were refused by the API on purpose, and the screen follows the refusal
 * rather than overriding it from the design — the same discipline `Analytics.tsx`
 * applies to the "Salons live" tile:
 *
 *   `live` / `suspended`   The design draws a Live toggle per row ("flip it off
 *                          to instantly suspend it") and `salon` has NO SUCH
 *                          COLUMN. There is nothing to read and nothing to write,
 *                          so the column is absent here rather than pinned to
 *                          `true` — a list that says five salons are live when the
 *                          product cannot suspend one is worse than a list that
 *                          does not raise the question.
 *   `city`                 No city column either. `branchCount` is served in its
 *                          place, which is a real fact about a salon, and the
 *                          column is relabelled rather than a branch name dressed
 *                          up as a city.
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
      return {
        id: str(s.id, `salons.items[${i}].id`),
        name: str(s.name, `salons.items[${i}].name`),
        nameAr: s.nameAr,
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
