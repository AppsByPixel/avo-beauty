import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { SalonMetricsSchema, type Salon, type SalonMetrics } from '@avo/types';
import { authedRequest } from '../auth/authedRequest.js';
import { useSalonId } from '../auth/AuthProvider.js';

/**
 * `GET /salons/{id}/metrics`.
 *
 * THE SHAPE IS `SalonMetricsSchema` FROM `packages/types` — entities.ts:429. A
 * comment here used to say "there is no `SalonMetricsSchema`, so this is a
 * hand-written mirror", and a 22-line local interface sat under it. That was true
 * when it was written and had been false since the schema landed; the fourth
 * stale absence-claim this project has caught, and the same shape as the header
 * this very file asked for — "it belongs in `packages/types/src/entities.ts`
 * (trunk-owned), not here". Trunk agreed, landed it, and the mirror outlived its
 * excuse. Deleted, not kept-but-deprecated: two definitions of "repeat rate" is
 * how two surfaces start disagreeing about one number.
 *
 * `SalonMetrics` is re-exported below so the callers' import site — the hook's
 * own module — keeps working; the TYPE now has one home.
 *
 * `nextAppointmentAt`: required-but-nullable. It landed `.optional()` as a
 * declared stage ahead of the API serving it, and the tightening happened at
 * `845dae4` the same day the serving did — this note was updated in the SAME
 * session that wrote "tolerates the field today", precisely so it would not
 * become the fifth stale claim of this build. The parse now REQUIRES the key, so
 * a server that forgot the field fails loudly instead of hiding behind optional.
 * The Upcoming tile's "next at 4:30 PM" sub-label remains a routed follow-up;
 * nothing renders the value yet.
 */
export type { SalonMetrics } from '@avo/types';

/*
 * THE SALON ID IS NOT A PARAMETER OF THESE HOOKS.
 *
 * It used to be, and every caller then had to find one to pass — which is how a
 * `FALLBACK_SALON_ID ?? ` crept into three call sites. Reading it from the
 * session inside the hook removes the opportunity: there is no argument to get
 * wrong, and no screen can address a salon other than the one it is signed in
 * to. `useSalonId()` in auth/AuthProvider.tsx is the single accessor.
 *
 * The id is still in the query KEY, because the cache must not serve one
 * salon's figures to the next session on a shared front-desk machine.
 */
export const salonKeys = {
  all: ['salon'] as const,
  detail: (salonId: string) => [...salonKeys.all, salonId] as const,
  /*
   * THE BRANCH IS IN THE KEY, and leaving it out would be a cache bug with the
   * exact shape of the label bug this change exists to fix: pick Salmiya, get
   * the salon-wide figures back out of the cache, and read them under a control
   * that says Salmiya. `'all'` is a key segment like any other, so the
   * unfiltered read is one entry rather than the absence of one.
   *
   * Still built on `detail(salonId)`, so `settings.ts`' and `loyalty.ts`'
   * `invalidateQueries({ queryKey: salonKeys.detail(salonId) })` prefix-match
   * every branch's entry — a renamed branch does not leave one stale variant
   * behind.
   */
  metrics: (salonId: string, branch: string) =>
    [...salonKeys.detail(salonId), 'metrics', branch] as const,
  /*
   * `activity`, not `charges`. The key is renamed with the endpoint rather than
   * left behind: a cache key that names the wrong resource is how the next
   * reader concludes this panel reads charges, which is the belief that kept the
   * bug below alive.
   */
  activity: (salonId: string) => [...salonKeys.detail(salonId), 'activity'] as const,
};

/**
 * `enabled` exists so a shell rendering without a session — the tick between
 * sign-out and the redirect landing — does not fire an unauthenticated request
 * on its way out.
 */
export function useSalon(enabled = true): UseQueryResult<Salon> {
  const salonId = useSalonId();
  return useQuery({
    queryKey: salonKeys.detail(salonId),
    queryFn: ({ signal }) => authedRequest<Salon>('merchant', `/salons/${salonId}`, { signal }),
    enabled,
    /*
     * No `retry` here, and the measurement that used to justify one is now the
     * global default. It is worth keeping the number: on TanStack's built-in
     * three-retries-with-backoff, Settings took about five seconds to show its
     * error while every other section took about two, and five seconds of an
     * apparently-working settings screen is how a merchant concludes a toggle
     * saved. api/retryPolicy.ts keeps that budget AND the 401/403 short-circuit
     * that the bare `retry: 1` here silently threw away.
     */
  });
}

/**
 * What the SERVER says it scoped the figures to. `branchId: null` is the
 * salon-wide answer; a string is the branch it applied, and `branchName` is the
 * name to print for it.
 */
/**
 * `GET /salons/{id}/metrics`, PARSED WITH THE SHARED SCHEMA AND NOTHING ELSE.
 *
 * ===========================================================================
 * THIS USED TO READ THE BRANCH ECHO OFF THE RAW BODY, AND THE REASON EXPIRED
 * ===========================================================================
 * When the selector was built, `branchId`/`branchName` were not on
 * `SalonMetricsSchema` — `packages/types` is trunk-owned and lane C does not
 * widen it — and **Zod strips undeclared keys**. So a client reading the echo
 * through the schema would have got `undefined` whether the server sent the
 * fields or not, and could not have told an API that IGNORED `?branch=` from one
 * that honoured it. A hand-written read of the raw body sat beside the parse for
 * exactly that window, with a third `applied: undefined` state for "no echo at
 * all".
 *
 * Trunk landed the widening at `74ffacf`, REQUIRED-but-nullable, because both
 * halves are now on `dev` and there is no deploy window in which a conforming
 * server omits them. That deletes the reason and therefore the code: a server
 * that forgets the keys now fails loudly at the schema, which is what
 * required-not-optional is FOR, and is a better answer than the fold it
 * replaces. Keeping a bespoke second parser next to a schema that declares the
 * same fields is how two definitions of one shape start disagreeing — the thing
 * this file's own header is about.
 *
 * So there is no `ScopedSalonMetrics` wrapper any more either. The echo is two
 * fields on `SalonMetrics`, where the contract puts them.
 */
export function parseMetricsResponse(raw: unknown): SalonMetrics {
  return SalonMetricsSchema.parse(raw);
}

/**
 * The `?branch=` suffix for one selection — `''` for salon-wide.
 *
 * =========================================================================
 * THE SUFFIX IS EXTRACTED AND THE PATH IS NOT, AND THAT IS NOT A STYLE CHOICE
 * =========================================================================
 * The obvious refactor is a `metricsPath(salonId, branch)` helper returning the
 * whole path, so a test can assert the URL without a session, a query client and
 * a server. It was written that way first, and it silently removed
 * `GET /salons/{id}/metrics` from `merchantScopeGates.test.ts`'s sweep: that
 * scan reads PATH LITERALS out of `authedRequest(…)` call sites, so a path built
 * behind a function call is a call the sweep cannot see. The suite went from 44
 * merchant-call cases to 43 and nothing turned red — the file's own stated
 * failure mode ("a parser returning nothing reports a clean sweep") arriving
 * through a client refactor rather than through a regex.
 *
 * So the path literal stays AT the call site where the scanner can read it, and
 * only the query suffix — which `normalisePath` drops anyway, because `?…` is
 * not part of a registered route — moves into a function. That keeps both
 * properties: the endpoint is covered by the surface sweep, and "what does
 * `'all'` put on the wire" is answerable by a unit test.
 *
 * The contract accepts omitted, `''` and `'all'` identically; this sends
 * OMITTED, which is byte-for-byte the request that existed before branch scoping
 * — so the default path cannot regress against an API that has not shipped the
 * parameter yet.
 */
export function branchQuery(branch: string): string {
  return branch === 'all' ? '' : `?branch=${encodeURIComponent(branch)}`;
}

/**
 * Overview's four KPI tiles, scoped to `branch`.
 *
 * `branch` is `'all'` or a branch id — `BranchScope.tsx`'s vocabulary, which is
 * `routes/Reports.tsx`' vocabulary, which is `?branch=`'s vocabulary. `'all'`
 * OMITS the parameter rather than sending the sentinel: the contract accepts
 * omitted, `''` and `'all'` identically, and omitting is byte-for-byte the
 * request this hook made before branch scoping existed.
 *
 * WHAT COMES BACK IS NOT THE SAME SHAPE PER BRANCH, and the caller must not
 * treat it as one. `loadedTodayFils` and `knetSharePercent` are **null whenever
 * `branchId` is non-null** — a top-up happens on a phone and has no branch to
 * attribute, so the server SKIPS those queries under a filter rather than
 * running them and handing a two-branch salon its whole day's takings under one
 * branch and 0.000 KD under the other. `services/metrics.ts` § "A TOP-UP HAS NO
 * BRANCH" is the argument. `??  0` at the render site would reinstate exactly
 * the false zero the API was restructured to prevent.
 */
export function useSalonMetrics(branch: string): UseQueryResult<SalonMetrics> {
  const salonId = useSalonId();
  return useQuery({
    queryKey: salonKeys.metrics(salonId, branch),
    /*
     * PARSED with the shared schema, not cast. The blind `authedRequest<SalonMetrics>`
     * this replaces asserted a shape the wire never proved — the `PATCH /v1/salons/{id}`
     * lesson. Every consumer of these figures is a KPI tile, where a null arriving
     * as a promised number renders "NaN" under a KD unit.
     */
    queryFn: async ({ signal }) =>
      parseMetricsResponse(
        await authedRequest<unknown>(
          'merchant',
          `/salons/${salonId}/metrics${branchQuery(branch)}`,
          { signal },
        ),
      ),
    /*
     * Stale-not-blank (interaction-spec.md §4). A failed refresh must keep the
     * last-known figures on screen behind a timestamped banner, so the cached
     * value survives the error — TanStack does that on its own — and the retry
     * budget stays small enough that the banner appears promptly. The budget is
     * the shared one now; only `refetchInterval` is this hook's own.
     */
    refetchInterval: 60_000,
  });
}

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * One line of the Overview feed, as the API sends it.
 *
 * THIS IS NOT A `Transaction`, AND THE DIFFERENCE IS THE POINT. The hook below
 * used to declare `Paginated<Transaction>` over a stream that is two sources
 * merged — `transaction` and `loyalty_event` — with no shared key between them.
 * `Transaction` has `reference` and `createdAt`; this has `what` and `at`, plus
 * `who` and a `stream` discriminator, and its `amountFils` is nullable because a
 * tier climb moves no money. A cast would have compiled against every one of
 * those mismatches.
 *
 * THE SENTENCE IS COMPOSED SERVER-SIDE, ON PURPOSE. `what` arrives as
 * "topped up 25.000 via KNET", not as a kind this client switches on. That is
 * `api/src/services/activityFeed.ts`'s decision and it carries a live defect as
 * its reason: a top-up's `amount_fils` is what LANDED, bonus included, so the
 * obvious client-side rendering tells a merchant her customer paid five dinars
 * she did not. The console's feed reads the same helper. Two copies of that
 * sentence is two chances to get it wrong, so this client renders the string.
 *
 * The design agrees: `AVO Merchant Dashboard.dc.html` § Overview draws the row
 * as `{{ f.who }} {{ f.what }} {{ f.when }}` and nothing else.
 */
export interface ActivityItem {
  id: string;
  /** Which source the line came from. `audit` is console-only. */
  stream: 'transaction' | 'loyalty' | 'audit';
  /** ISO instant. */
  at: string;
  /** The bolded name — a member, or "System" for an automatic deposit return. */
  who: string;
  memberId: string | null;
  salonId: string | null;
  /** The predicate the design renders after the name, already phrased. */
  what: string;
  /** Transaction kind or loyalty kind, whichever stream this is. */
  kind: string;
  /** Signed fils as stored. Null on a line that moved no money. */
  amountFils: number | null;
}

/*
 * PARSE HELPERS, LOCAL TO THIS FILE — the same shape `platformConsole.ts` keeps
 * for `parsePlatformMetrics` and `platformSalons.ts` for `str`. Small enough
 * that a shared module would buy less than the import costs.
 */
function str(v: unknown, where: string): string {
  if (typeof v !== 'string') throw new Error(`${where} was not a string.`);
  return v;
}

function nullableNum(v: unknown, where: string): number | null {
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`${where} was not a number or null.`);
  }
  return v;
}

/**
 * PARSED, NOT CAST, and this hook is the reason the rule exists.
 *
 * `authedRequest<Paginated<Transaction>>` asserted a shape the wire never
 * proved, and the assertion was wrong in every field that mattered. A cast
 * cannot fail, so nothing here could notice — the same lesson `useSalonMetrics`
 * above records, and the `PATCH /v1/salons/{id}` crash before it.
 *
 * A SCHEMA NARROWER THAN THE WIRE SILENTLY STRIPS FIELDS in this codebase, so
 * this reads every key the endpoint documents rather than the subset the screen
 * happens to render today. `memberId`, `salonId`, `kind` and `amountFils` are
 * not drawn by the Overview row; they are parsed anyway, because the next reader
 * of this feed should find the record whole rather than discover a hole.
 */
/**
 * `where` NAMES THE CALLER, because there are two and they fail differently.
 *
 * `GET /v1/platform/activity` serves the SAME `FeedItem` — one server interface
 * in `api/src/services/activityFeed.ts`, imported by both routes, and that file
 * exists precisely so the merchant's feed and the console's cannot answer the
 * same question two ways. A second parser here would be the client-side version
 * of the duplication it was written to prevent, and the sentence it renders
 * (`what`) is the thing that would drift.
 *
 * What is NOT shared is the endpoint in the message. A parse failure that names
 * `/salons/{id}/activity` while the console was reading `/v1/platform/activity`
 * sends the next reader to the wrong handler, so the path is a parameter and
 * defaults to the caller that had this file first.
 */
export function parseActivityFeed(
  raw: unknown,
  where = 'GET /salons/{id}/activity',
): Paginated<ActivityItem> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${where} did not answer an object.`);
  }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.items)) throw new Error('activity.items was not an array.');

  return {
    items: r.items.map((row, i) => {
      if (typeof row !== 'object' || row === null) {
        throw new Error(`activity.items[${i}] was not an object.`);
      }
      const it = row as Record<string, unknown>;
      const stream = str(it.stream, `activity.items[${i}].stream`);
      if (stream !== 'transaction' && stream !== 'loyalty' && stream !== 'audit') {
        throw new Error(`activity.items[${i}].stream was "${stream}".`);
      }
      return {
        id: str(it.id, `activity.items[${i}].id`),
        stream,
        at: str(it.at, `activity.items[${i}].at`),
        who: str(it.who, `activity.items[${i}].who`),
        memberId: it.memberId === null ? null : str(it.memberId, `activity.items[${i}].memberId`),
        salonId: it.salonId === null ? null : str(it.salonId, `activity.items[${i}].salonId`),
        what: str(it.what, `activity.items[${i}].what`),
        kind: str(it.kind, `activity.items[${i}].kind`),
        amountFils: nullableNum(it.amountFils, `activity.items[${i}].amountFils`),
      };
    }),
    /*
     * ALWAYS `null` FROM THE MERCHANT'S READ, AND A REAL STRING FROM THE
     * CONSOLE'S — which is why it was read rather than assumed here.
     *
     * `routes/activity.ts` has no cursor on purpose: the Overview draws five
     * lines and no "load more", and a cursor over a MERGED stream needs a
     * composite position. `GET /v1/platform/activity` is the other case — a
     * whole section whose job is looking backwards — so it pays for that
     * composite key and sends `"<instant>|<rank>|<id>"`, one opaque string.
     *
     * Both are `string | null` on the wire and neither is interpreted here; the
     * console's hook hands it straight back as `?cursor=`. Parsing it would be
     * this client claiming to know a format `services/streamCursor.ts` owns.
     */
    nextCursor: r.nextCursor === undefined || r.nextCursor === null
      ? null
      : str(r.nextCursor, 'activity.nextCursor'),
  };
}

/**
 * Recent activity — Merchant → Overview.
 *
 * IT USED TO REQUEST `GET /charges`, AND WAS REFUSED ON EVERY LOAD.
 *
 * This is the first screen a salon owner sees after signing in. `GET /charges`
 * is `requireScannerPerm(req, 'charges')` (charges.ts:226) — a SCANNER-surface
 * guard. The dashboard holds a web session, so the refusal had nothing to do
 * with authority: Noura holds all nine permissions including `charges` and got a
 * 403 every time, because the surface check runs before the permission check and
 * no grant can satisfy it. Proven on the running API with one owner session:
 *
 *   GET /charges                    → 403
 *   GET /salons/SAL-AMARA/activity  → 200
 *
 * The panel rendered that 403 as "You don't have access to this", under a
 * heading reading "Recent activity". It has presumably never worked.
 *
 * WHAT MADE IT INVISIBLE. The comment that stood here said the feed was charges
 * "because `GET /charges` is the only salon-scoped transaction stream in the
 * contract", and that a web principal being refused it was "by design". The
 * second half is true of `GET /charges` and is not a reason for this panel to
 * read it; the first half had expired. `GET /salons/{id}/activity` was built FOR
 * this panel — its header opens "Recent activity — design/AVO Merchant
 * Dashboard.dc.html § Overview" and argues at length against sourcing it from
 * charges — and the client simply never pointed at it. Two "not built" claims
 * outliving the thing they described, in one dashboard, in one week.
 *
 * `merchantScopeGates.test.ts` now derives every route's surface guard from
 * `api/src/routes/` and fails on any merchant-scope call that lands on a scanner
 * one, so the class cannot come back quietly.
 *
 * AND THE FEED IS NOW THE DESIGNED FEED, not a smaller version of it. Charges
 * alone showed money leaving wallets and never arriving; the merged stream adds
 * top-ups, deposit returns, shop purchases and tier climbs, which is the five
 * lines the design draws.
 *
 * THE SALON ID IS IN THE PATH AGAIN, and that is not a step backwards. This
 * endpoint scopes its queries from `principal.salonId` and calls
 * `requireSameSalon` on the path id — so a client naming another salon is
 * refused rather than served. The id comes from `useSalonId()`, the single
 * accessor, exactly as every other salon-scoped hook in this file takes it.
 */
export function useRecentActivity(): UseQueryResult<Paginated<ActivityItem>> {
  const salonId = useSalonId();
  return useQuery({
    queryKey: salonKeys.activity(salonId),
    queryFn: async ({ signal }) =>
      parseActivityFeed(
        await authedRequest<unknown>('merchant', `/salons/${salonId}/activity`, { signal }),
      ),
    /*
     * No `retry` override. The old one was justified by "a web principal reading
     * `GET /charges` gets a 403 by design, so the refusal is the NORMAL answer
     * here" — an argument for not retrying a request that should never have been
     * made. A refusal is no longer normal on this panel: `perms.dashboard` is the
     * gate, and a staff member without it does not reach the Overview at all.
     * The shared budget in `retryPolicy.ts` keeps the 401/403 short-circuit that
     * a bare `retry: 1` threw away.
     */
  });
}
