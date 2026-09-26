import {
  useInfiniteQuery,
  useQuery,
  type InfiniteData,
  type UseInfiniteQueryResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { authedRequest } from '../auth/authedRequest.js';
import { useSalonId } from '../auth/AuthProvider.js';
import { parseActivityFeed, type ActivityItem, type Paginated } from './salon.js';

/**
 * THE MERCHANT'S CUSTOMER BOOK. Accounts → Customers.
 *
 *   GET /salons/{id}/customers                        perms.team   the list
 *   GET /salons/{id}/customers/{memberId}             perms.team   the card
 *   GET /salons/{id}/customers/{memberId}/activity    perms.team   the history
 *
 * All three are `requireCustomerDirectory` in `api/src/routes/customers.ts`,
 * which resolves to `requireDashboardPerm(req, 'team')` — the same permission
 * `services/reports.ts` assigns the customers CSV, so the authority to export the
 * book and the authority to read it on screen are one grant rather than two that
 * can disagree.
 *
 * =========================================================================
 * THREE ENDPOINTS, THREE QUERIES, AND NOT ONE COMBINED HOOK
 * =========================================================================
 * The route file's split is on what GROWS — a member row does not, her activity
 * does — and the client half of that is that opening a card must not re-fetch the
 * book, and paging the history must not re-fetch the card. Three cache entries,
 * three independent failures, and the screen answers for each where it can
 * actually say something useful about it.
 *
 * =========================================================================
 * WHAT THE WIRE CARRIES THAT THIS FILE DOES NOT RE-DERIVE
 * =========================================================================
 * `memberErased` / `memberPhone` ARE THE SERVER'S NAMES, KEPT. `serialiseMemberContact`
 * in `api/src/http/serialise.ts` is the one place that decides what an erased
 * member's contact details look like on a wire, and `customerDirectory.ts` names
 * the pair to match `MemberContactWire` EXACTLY — deliberately, so the render this
 * lane already wrote for `api/orders.ts § MerchantShopOrder` and
 * `api/bookings.ts § MerchantBooking` transfers rather than being invented a third
 * time. It is the same contract and it keeps the same names here.
 *
 * `erasure.ts` mints `+990` + 12 random digits for a phone it cannot null at rest,
 * an UNASSIGNED country code, so the number is a tombstone by construction. The
 * fulfilment board shipped that tombstone as a working `tel:` link once
 * (DECISIONS.md #100) and the wallet's bookings surface turned it into a `tel:`
 * AND a `wa.me` button. This is the fourth merchant read to join `member` for a
 * phone; it reads the FLAG, never the prefix.
 *
 * `balanceFils` IS INTEGER FILS AND STAYS THAT WAY THROUGH THIS FILE.
 * Non-negotiable #1 — `fils()` is applied at the `<Money>` call and nowhere
 * earlier, and nothing here adds, compares or rounds it.
 *
 * `tier` IS `string | null` AND IS NOT NARROWED TO THE ENUM. The column is
 * `TierName`, but a parse that threw on a fifth tier would take the whole book
 * down over a label. `console/Accounts.tsx § ROLE_LABEL` set the precedent: map
 * the known values, print an unrecognised one raw, and let the next reader find
 * out that way rather than through a blank screen.
 *
 * =========================================================================
 * PARSED, NOT CAST
 * =========================================================================
 * `api/salon.ts § parseActivityFeed` carries the reason at length:
 * `authedRequest<Paginated<Transaction>>` once asserted a shape the wire never
 * proved and was wrong in every field that mattered, and a cast cannot fail. Every
 * key these endpoints document is read here, including the ones no component draws
 * today (`salonId`, `emailVerified`, `visits`), because the next reader of this
 * book should find the record whole rather than discover a hole.
 *
 * THE HISTORY IS NOT PARSED HERE AT ALL, and that is the point. It is
 * `activityFeed.ts § FeedItem` — the identical interface the Overview feed and the
 * console feed read — so it goes through `parseActivityFeed` with its `where`
 * naming this endpoint. A second parser would be the client-side copy of exactly
 * the duplication that file exists to prevent, and `what` — the composed sentence
 * that already carries a fixed top-up-bonus defect — is the field that would drift.
 */

/* ------------------------------------------------------------------ shapes -- */

/** One row of the book. `api/src/services/customerDirectory.ts § CustomerListItem`. */
export interface CustomerListItem {
  id: string;
  /** `TOMBSTONE_NAME` ("Deleted account") when erased — display-safe, rendered as-is. */
  name: string;
  /** Non-null `erased_at` on the server. The only tell, and this client's to act on. */
  memberErased: boolean;
  /** Null for an erased member — never the `+990` tombstone. */
  memberPhone: string | null;
  tier: string | null;
  /** INTEGER FILS. Formatted at the `<Money>` boundary, never here. */
  balanceFils: number;
  visits: number;
  joinedAt: string;
}

/** The card. The list row plus what only a per-member read serves. */
export interface CustomerDetail extends CustomerListItem {
  salonId: string;
  /**
   * Erasure NULLS this at rest — the column is nullable, unlike the phone — so
   * there is no tombstone to keep off the wire and it needs no serialiser. The
   * asymmetry is `customerDirectory.ts`' and is worth knowing before someone
   * "fixes" the missing guard.
   */
  email: string | null;
  emailVerified: boolean;
  /** A count at a stamps salon, null at a tiers salon. Never defaulted to 0. */
  stamps: number | null;
}

/* ------------------------------------------------------------------ parsing -- */

/*
 * Local, in the shape `salon.ts` and `platformSalons.ts` both keep: small enough
 * that a shared module would buy less than the import costs, and the `where`
 * strings are what make a parse failure name the endpoint that produced it.
 */
function str(v: unknown, where: string): string {
  if (typeof v !== 'string') throw new Error(`${where} was not a string.`);
  return v;
}

function nullableStr(v: unknown, where: string): string | null {
  return v === null ? null : str(v, where);
}

function int(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new Error(`${where} was not a whole number.`);
  }
  return v;
}

function nullableInt(v: unknown, where: string): number | null {
  return v === null ? null : int(v, where);
}

function bool(v: unknown, where: string): boolean {
  if (typeof v !== 'boolean') throw new Error(`${where} was not a boolean.`);
  return v;
}

function obj(v: unknown, where: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error(`${where} was not an object.`);
  }
  return v as Record<string, unknown>;
}

/**
 * `balanceFils` IS READ WITH `int` AND NOT WITH A PLAIN NUMBER CHECK.
 *
 * Non-negotiable #1 says no float touches money. The server cannot send one — the
 * column is `bigint` and `Fils` is branded — so this assertion can only fail if
 * something upstream has already broken the rule, which is precisely when a
 * merchant should see a parse error naming the field rather than a wallet reading
 * `24.500999`.
 */
export function parseCustomerListItem(raw: unknown, where: string): CustomerListItem {
  const c = obj(raw, where);
  return {
    id: str(c.id, `${where}.id`),
    name: str(c.name, `${where}.name`),
    memberErased: bool(c.memberErased, `${where}.memberErased`),
    memberPhone: nullableStr(c.memberPhone, `${where}.memberPhone`),
    tier: nullableStr(c.tier, `${where}.tier`),
    balanceFils: int(c.balanceFils, `${where}.balanceFils`),
    visits: int(c.visits, `${where}.visits`),
    joinedAt: str(c.joinedAt, `${where}.joinedAt`),
  };
}

export function parseCustomerBook(raw: unknown): Paginated<CustomerListItem> {
  const where = 'GET /salons/{id}/customers';
  const r = obj(raw, where);
  if (!Array.isArray(r.items)) throw new Error(`${where}.items was not an array.`);
  return {
    items: r.items.map((row, i) => parseCustomerListItem(row, `${where}.items[${i}]`)),
    nextCursor: nullableStr(r.nextCursor, `${where}.nextCursor`),
  };
}

export function parseCustomerDetail(raw: unknown): CustomerDetail {
  const where = 'GET /salons/{id}/customers/{memberId}';
  const c = obj(raw, where);
  return {
    ...parseCustomerListItem(raw, where),
    salonId: str(c.salonId, `${where}.salonId`),
    email: nullableStr(c.email, `${where}.email`),
    emailVerified: bool(c.emailVerified, `${where}.emailVerified`),
    stamps: nullableInt(c.stamps, `${where}.stamps`),
  };
}

/* -------------------------------------------------------------------- keys -- */

export const customerKeys = {
  all: ['customers'] as const,
  /**
   * The book, keyed by the query it was fetched with. A shared key across queries
   * would make "what does the book contain" depend on which search ran last.
   */
  book: (salonId: string, q: string) => [...customerKeys.all, salonId, 'book', q] as const,
  card: (salonId: string, memberId: string) =>
    [...customerKeys.all, salonId, 'card', memberId] as const,
  history: (salonId: string, memberId: string) =>
    [...customerKeys.all, salonId, 'history', memberId] as const,
};

/* -------------------------------------------------------------------- reads */

/**
 * THE BOOK. `?q=` narrows it; the cursor pages it.
 *
 * THERE IS NO `?limit=`, AND THIS HOOK DOES NOT INVENT ONE. `CUSTOMER_PAGE_SIZE`
 * is a fixed 25 server-side and `routes/customers.ts` states why the knob is
 * absent: a parameter that only ever widens disclosure of a salon's customer book
 * is one the API chose not to offer. Paging is the cursor, and the screen's "Show
 * more" is `fetchNextPage`.
 *
 * ORDERED `joined_at DESC, id ASC` — NEWEST MEMBER FIRST, NOT ALPHABETICAL. The
 * server's reason is that `streamCursor` pages instant-keyed streams and nothing
 * else, so an A–Z book would need a second cursor grammar minted for a list that
 * has a search box in front of it. What that means HERE is that the screen must
 * not describe the book as sorted by name and must not offer a sort control it
 * cannot ask for.
 *
 * SEARCH IS THE SERVER'S. `customerSearchPredicate` matches name, phone digits and
 * exact member id across the whole salon; a client-side filter would search the 25
 * rows in hand and then confidently report "no customer matches" about a book it
 * has never seen. That is the same defect `platformAccounts.ts` records, and the
 * empty state below is the half of it that lies.
 *
 * DEBOUNCED BY THE SCREEN, NOT HERE — `console/Accounts.tsx`' split, so the hook
 * stays a function of the query it is given and the timing lives with the input
 * that produces it.
 *
 * `networkMode: 'always'`. TanStack's default PAUSES a fetch offline rather than
 * failing it, and a paused query sits at `status: 'pending'` forever — which this
 * screen would paint as skeleton rows for as long as the network is down, instead
 * of the offline answer `SectionError` exists to give. `api/bookings.ts` records
 * the same trap being hit against a real 403.
 */
export function useCustomerBook(
  q: string,
): UseInfiniteQueryResult<InfiniteData<Paginated<CustomerListItem>>> {
  const salonId = useSalonId();
  const query = q.trim();
  return useInfiniteQuery({
    queryKey: customerKeys.book(salonId, query),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const params = new URLSearchParams();
      if (query !== '') params.set('q', query);
      if (pageParam !== null) params.set('cursor', pageParam);
      const search = params.toString();
      const raw = await authedRequest<unknown>(
        'merchant',
        `/salons/${salonId}/customers${search ? `?${search}` : ''}`,
        { signal },
      );
      return parseCustomerBook(raw);
    },
    getNextPageParam: (last) => last.nextCursor,
    networkMode: 'always',
  });
}

/**
 * ONE CUSTOMER'S CARD.
 *
 * `enabled` IS THE CLOSED-CARD STATE AND NOT A GUESS. With no member open there is
 * nothing to ask for, and firing the request anyway would need a placeholder id —
 * which `routes/customers.ts` answers `404 unknown_member`, deliberately
 * byte-identical to a member in another salon, and which would ALSO write an audit
 * row reading "Attempted an id not in this salon". That log line is, in
 * `memberSearch.ts`' words, "what a directory walk looks like from the inside"; a
 * client manufacturing one every time the tab opens would be poisoning the one
 * signal the salon has.
 *
 * NOT SEEDED FROM THE BOOK'S ROW, although eight of its twelve fields are already
 * in hand. `initialData` would paint `email`, `emailVerified` and `stamps` as
 * absent on a card that has not loaded them — and `stamps: null` is MEANINGFUL
 * (a tiers salon), so the placeholder would be indistinguishable from an answer.
 * The card's skeleton is honest; a half-filled card is not.
 */
export function useCustomer(memberId: string | null): UseQueryResult<CustomerDetail> {
  const salonId = useSalonId();
  return useQuery({
    queryKey: customerKeys.card(salonId, memberId ?? ''),
    queryFn: async ({ signal }) => {
      const raw = await authedRequest<unknown>(
        'merchant',
        `/salons/${salonId}/customers/${memberId}`,
        { signal },
      );
      return parseCustomerDetail(raw);
    },
    enabled: memberId !== null,
    networkMode: 'always',
  });
}

/**
 * HER HISTORY. The design's "Recent activity" list inside the card.
 *
 * SAME `FeedItem` AS THE OVERVIEW, SAME PARSER — see the file header. `what`
 * arrives composed ("topped up 25.000 via KNET", "Reached Gold tier"), and this
 * client renders the string rather than switching on `kind`, because the obvious
 * client-side rendering of a top-up prints the bonus as money the customer paid.
 *
 * `?from=` / `?to=` EXIST ON THIS ENDPOINT AND ARE NOT SENT, WHICH IS A DECISION.
 * Lane A serves the same salon-local calendar range the bookings list takes, and
 * this lane already has the reasoning for salon-local windows in the sales chart
 * and the week grid. The design's customer card draws NO date control — it draws
 * one "Recent activity" list — and CLAUDE.md § How to work is explicit that a lane
 * does not add features the design does not have. So the range is unsent rather
 * than half-built behind a parameter nobody passes: `parseCalendarRange` returns
 * `null` for an absent pair and the server then issues exactly the query it would
 * have issued before the parameter existed. Reported to trunk as available and
 * unused, so the decision is asked for rather than rediscovered.
 *
 * NO `?limit=` EITHER, for a different reason from the book's: the server's
 * `FEED_DEFAULT_LIMIT` is 20, which is four times what the design's panel draws,
 * and "Show more" pages past it. A limit here would be a number this screen
 * invented over one the API already chose.
 */
export function useCustomerHistory(
  memberId: string | null,
): UseInfiniteQueryResult<InfiniteData<Paginated<ActivityItem>>> {
  const salonId = useSalonId();
  return useInfiniteQuery({
    queryKey: customerKeys.history(salonId, memberId ?? ''),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const params = new URLSearchParams();
      if (pageParam !== null) params.set('cursor', pageParam);
      const search = params.toString();
      const raw = await authedRequest<unknown>(
        'merchant',
        `/salons/${salonId}/customers/${memberId}/activity${search ? `?${search}` : ''}`,
        { signal },
      );
      return parseActivityFeed(raw, 'GET /salons/{id}/customers/{memberId}/activity');
    },
    /*
     * `mergePage` sends `"<instant>|<rank>|<id>"` — one opaque string over a
     * MERGED stream, which is why the composite is the server's to build and this
     * is a pass-through rather than anything derived.
     *
     * OMITTING THIS DOES NOT FAIL TO COMPILE AND DOES NOT FAIL QUIETLY EITHER: it
     * throws `options.getNextPageParam is not a function` from inside
     * `hasNextPage`, on the render AFTER the first page lands — so the card renders
     * its skeleton, the request succeeds, and then the whole subtree dies. It
     * shipped that way here for exactly as long as it took the render test to open
     * a card, which is the argument for the render test.
     */
    getNextPageParam: (last) => last.nextCursor,
    enabled: memberId !== null,
    networkMode: 'always',
  });
}
