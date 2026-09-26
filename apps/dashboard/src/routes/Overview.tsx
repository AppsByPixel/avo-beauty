import { useRef, useState } from 'react';
import { fils } from '@avo/types';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Money,
  Skeleton,
  StatCard,
  StaleBanner,
} from '@avo/ui';
import { ApiError } from '../api/client.js';
import {
  useRecentActivity,
  useSalonMetrics,
  type ActivityItem,
  type SalonMetrics,
} from '../api/salon.js';
import { useBranchScope } from '../shell/BranchScope.js';
import { SalesTrendCard } from './SalesTrend.js';

/**
 * Merchant → Overview.
 *
 * NO COURTESY PERMISSION GATE, DELIBERATELY. `GET /salons/{id}/metrics` is
 * `requireDashboardPerm(req, 'dashboard')` server-side, so the refusal arrives on
 * its own and `SectionError` explains it. A client check here would duplicate the
 * server and drift from it. The ledger in sectionState.tsx records why — on
 * Settings the same absence WAS an oversight, and nothing distinguished the two.
 *
 * THE ACTIVITY PANEL USED TO READ `GET /charges`, WHICH THIS SCREEN CAN NEVER
 * REACH. The paragraph that stood here said so and treated it as the contract:
 * "`requireScannerPerm(req, 'charges')` — a SCANNER-scope guard, not a dashboard
 * one. No web principal satisfies it whatever permissions she holds." Every word
 * of that is true, and it described a bug. An endpoint this screen cannot reach
 * is not an endpoint this screen should call. The panel now reads
 * `GET /salons/{id}/activity`, which is `requireDashboardPerm(req, 'dashboard')`
 * — the same gate as the metrics beside it, and the endpoint built for this
 * panel. See `api/salon.ts § useRecentActivity`.
 *
 * SO BOTH HOOKS NOW SHARE ONE GATE, which is why the feed has no permission
 * state of its own: a staff member without `perms.dashboard` is refused the
 * metrics too and never gets past `MetricsError`. The 403 branch below survives
 * for the one refusal that can still reach it alone — `requireSameSalon`.
 */
export function Overview() {
  // No salon id here at all. Both hooks read it from the session.
  const { selected, selectedName } = useBranchScope();
  const metrics = useSalonMetrics(selected);
  const activity = useRecentActivity();

  /*
   * STALE-NOT-BLANK DOES NOT APPLY TO A REFUSAL.
   *
   * interaction-spec.md §4 keeps the last-known figures on screen through a
   * *network* failure, because a merchant who watches her numbers vanish assumes
   * the money did too. A 403 is not that failure. It means this staff member may
   * not see these figures — and holding them on screen behind a "Couldn't
   * refresh · Retry" banner shows her exactly what she is not allowed to see,
   * captioned with a button that will never work.
   *
   * Observed, not theorised: signing Hessa in after Noura on the same browser
   * did this. The API answered 403 to both Overview calls and the banner served
   * Noura's figures underneath it.
   */
  const forbidden = metrics.error instanceof ApiError && metrics.error.isForbidden;
  const showStale = metrics.isError && metrics.data !== undefined && !forbidden;

  if (metrics.isError && (metrics.data === undefined || forbidden)) {
    return <MetricsError error={metrics.error} onRetry={() => void metrics.refetch()} retrying={metrics.isFetching} />;
  }

  /*
   * ===========================================================================
   * WHAT THE FIGURES ACTUALLY COVER — read off the SERVER'S ECHO, never off the
   * request.
   * ===========================================================================
   * The branch selector sends `?branch=`; `GET /salons/{id}/metrics` answers
   * with `branchId`/`branchName` saying what it applied. Those are two different
   * facts and this screen must render the second one, because the first is only
   * a hope. An API that predates the parameter ignores it and answers 200 with
   * salon-wide figures — and if this screen believed its own request, it would
   * put "Salmiya" over both-branch numbers. That is the EXACT defect the branch
   * selector was built to remove; reintroducing it one layer down, silently,
   * would be worse than the label it replaced, because it would look deliberate.
   *
   * The `branchId`/`branchName` fields are now REQUIRED-but-nullable on
   * `SalonMetricsSchema` (trunk, 74ffacf), so a server that omits them fails at
   * the parse rather than reaching this line. What survives here is the
   * comparison itself, which is the property that makes the screen structurally
   * unable to claim a scope it was not given.
   */
  const appliedBranchId = appliedBranchOf(metrics.data);
  const scopeIgnored = scopeWasIgnored(selected, metrics.data);

  return (
    <>
      {showStale ? (
        <StaleBanner
          updatedAt={metrics.dataUpdatedAt}
          onRetry={() => void metrics.refetch()}
          retrying={metrics.isFetching}
        />
      ) : null}

      {scopeIgnored ? (
        <ScopeNotice
          requestedName={selectedName}
          appliedName={metrics.data?.branchName ?? null}
          appliedBranchId={appliedBranchId}
        />
      ) : null}

      <KpiRow metrics={metrics.data} loading={metrics.isPending} />

      {/*
        HOW MUCH OF THE PER-BRANCH ANSWER IS A GUESS — proportionally, or not at
        all. See `AssumedNote`.
      */}
      <AssumedNote metrics={metrics.data} />

      {/*
        ===========================================================================
        TWO PANELS, NOT ONE — AND THE FEED READING AS "HUGE" WAS A LAYOUT FACT
        ===========================================================================
        This grid had exactly one child: the activity card, at full width. Under
        four tiles and the assumed-note it was the only thing on the page, so five
        short rows owned the entire lower half of the Overview. That is not a
        row-count problem and shortening the feed would not have fixed it — the
        feed is already disclosed at five (§ FEED_VISIBLE). It needed something
        beside it.

        THE CHART TAKES THE WIDER COLUMN because fourteen bars need width to be a
        shape and five `who what when` lines do not. It is FIRST IN THE DOM so
        that the stacked narrow and tablet layouts put the trend above the feed
        rather than below it — the complaint was that the feed dominates, and
        reading order is half of dominating.
      */}
      <div className="overview__grid">
        <SalesTrendCard />

        <Card className="overview__activity" flush>
          {/*
            THE FEED IS SALON-WIDE AND SAYS SO WHEN THAT MATTERS.
            `GET /salons/{id}/activity` takes no branch parameter — the contract
            this lane was given scopes `metrics` and nothing else — so with a
            branch applied above, these five lines cover more than the tiles do.
            Leaving that unsaid would rebuild the original defect inside the fix:
            a branch named in the chrome, salon-wide rows underneath it. The
            qualifier appears only when the two genuinely differ.
          */}
          <h2 className="overview__card-title">
            Recent activity
            {appliedBranchId !== null ? (
              <span className="overview__card-scope">All branches</span>
            ) : null}
          </h2>
          <ActivityList
            items={activity.data?.items}
            loading={activity.isPending}
            error={activity.isError ? activity.error : null}
            onRetry={() => void activity.refetch()}
            retrying={activity.isFetching}
          />
        </Card>
      </div>
    </>
  );
}

/**
 * The applied scope, straight off the echo. A one-line accessor rather than an
 * inline read, so every claim on this screen goes through one named place and
 * `scopeWasIgnored` below cannot drift from what the tiles are drawn against.
 */
export function appliedBranchOf(data: SalonMetrics | undefined): string | null {
  return data?.branchId ?? null;
}

/**
 * DID THE WORKSPACE IGNORE THE BRANCH WE ASKED FOR?
 *
 * The single question this screen's honesty rests on, so it is one exported
 * function rather than a conjunction inlined in JSX. Three things have to be
 * true: figures have arrived, a specific branch was requested, and what came
 * back is not that branch. `undefined` data is not a mismatch — nothing is on
 * screen to be wrong about yet.
 */
export function scopeWasIgnored(selected: string, data: SalonMetrics | undefined): boolean {
  if (data === undefined) return false;
  const requested = selected === 'all' ? null : selected;
  if (requested === null) return false;
  return appliedBranchOf(data) !== requested;
}

/**
 * THE FIGURES ARE NOT THE ONES THAT WERE ASKED FOR, AND THE SCREEN SAYS SO.
 *
 * Reached when the server's echo disagrees with the selection: an API that has
 * not shipped `?branch=` yet (lane A is building it in parallel, and this screen
 * has to be honest before it lands), or one that applied a different branch.
 *
 * IT DOES NOT MOVE THE SELECTOR BACK. A control that silently undoes a click is
 * a second lie — the merchant chose Salmiya and the header should keep showing
 * that she did. What is wrong is not her choice, it is the answer, so the
 * correction sits on the answer.
 *
 * `role="status"`, and the `.avo-stale` treatment reused verbatim rather than a
 * new one invented: the design bundle has no branch switcher and therefore no
 * strip for this, and `@avo/ui`'s stale banner is already this product's way of
 * saying "the numbers under this are not what you think" — same warn tint, same
 * dot, same type. `InfoBanner` was the other candidate and is explicitly wrong
 * here: its own header says it is standing prose that "never changes and is not
 * the result of anything the merchant did", and this is nothing but that.
 */
export function ScopeNotice({
  requestedName,
  appliedName,
  appliedBranchId,
}: {
  requestedName: string | null;
  appliedName: string | null;
  appliedBranchId: string | null;
}) {
  /* The branch she picked, by name where we have one — an id would mean nothing. */
  const asked = requestedName ?? 'the selected branch';

  return (
    <div className="avo-stale" role="status">
      <span className="avo-stale__dot" aria-hidden="true" />
      <span className="avo-stale__text">
        {appliedBranchId === null
          ? `Showing all branches. This workspace didn\u2019t narrow these figures to ${asked}, so everything below covers the whole salon.`
          : `Showing ${appliedName ?? 'another branch'}. This workspace answered with a different branch from the one selected, so these figures are not ${asked}.`}
      </span>
    </div>
  );
}

/* ------------------------------------------------- how much of it is a guess */

/**
 * One clause of the caveat — "2 of 2 members". Returned only when the doubt is
 * real, so a zero contributes nothing rather than contributing "0 of 5", which
 * is noise dressed as precision.
 */
function assumedClause(assumed: number, total: number, noun: string): string | null {
  if (assumed <= 0 || total <= 0) return null;
  return `${assumed} of ${total} ${noun}`;
}

/**
 * "a", "a and b", "a, b and c" — an Oxford-comma-free list, as the copy elsewhere
 * sets.
 *
 * EXPORTED FOR `Reports.tsx` § BranchAssumedCaveat, which carries the SAME
 * SENTENCE about the same column ("Branch assumed on {…} — treat these branch
 * figures as approximate") over a different set of figures. The sentence is
 * reused rather than reinvented, so its list grammar is too: a second
 * implementation would drift into an Oxford comma on one screen and not the
 * other, which is the kind of divergence nobody notices and everybody reads.
 */
export function joinClauses(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * THE SIZE OF THE DOUBT BEHIND A PER-BRANCH FIGURE — proportionally, or not at
 * all.
 *
 * ===========================================================================
 * WHY THIS IS A COUNT AND NOT AN ASTERISK
 * ===========================================================================
 * `activeMembers`, `repeatRatePercent` and `upcomingAppointments` CAN be scoped
 * to a branch, but not exactly: a charge and a booking happen somewhere, and
 * whether the row RECORDS where is what `transaction.branch_assumed` says.
 * Today, at a multi-branch salon, the server cannot tell which branch a staff
 * member is standing in until branch-bound scanner sessions ship, so it includes
 * the inferred rows in the figure and reports how many they were —
 * `services/metrics.ts` § "REPORT SEPARATELY".
 *
 * The client half of that decision is this component, and its whole value is
 * that it **disappears on its own**. `branchAssumed` is a count, so when those
 * sessions land the counts fall to zero, every clause below returns `null`, and
 * the caveat leaves the UI with no code change and no one remembering to remove
 * it. A boolean — or a fixed "figures may be approximate" line — would have to be
 * deleted by hand on the day the world improves, and a rule that must be
 * revisited to stay true is one this project has already shipped stale twice.
 *
 * SO: nothing at `branch=all` (`branchAssumed` is null there — a row attributed
 * to the wrong branch is still inside the salon, so a salon-wide total is exact
 * however many rows are assumed), nothing when every count is zero, and
 * otherwise the ratios, which say "2 of 2" where the figure is entirely a guess
 * and "1 of 9" where it is barely one. The reader does not need prose to tell
 * those apart.
 *
 * "Branch assumed" is not new wording. `routes/Appointments.tsx` already marks a
 * booking row with it and `routes/Settings.tsx` already says "has an assumed
 * branch, so treat the count as approximate" in the branch-closure warning. Same
 * concept, same words, third place.
 */
export function AssumedNote({ metrics }: { metrics: SalonMetrics | undefined }) {
  const doubt = metrics?.branchAssumed;
  if (!metrics || !doubt) return null;

  const parts = [
    assumedClause(doubt.activeMembers, metrics.activeMembers, 'members'),
    assumedClause(doubt.visits, doubt.visitsTotal, 'visits'),
    assumedClause(doubt.upcomingAppointments, metrics.upcomingAppointments, 'appointments'),
  ].filter((part): part is string => part !== null);

  // Every figure behind this branch was recorded, not inferred. Say nothing.
  if (parts.length === 0) return null;

  return (
    <p className="overview__kpi-note" role="status">
      Branch assumed on {joinClauses(parts)} — treat these branch figures as approximate.
    </p>
  );
}

/* ------------------------------------------------------------------ KPI row */

/**
 * Exported for `shell/branchScope.test.tsx`, which renders it directly. The four
 * tiles are where a null figure would become a false zero, and only rendering
 * can prove it does not — a source scan sees the branch, not the pixels.
 */
export function KpiRow({
  metrics,
  loading,
}: {
  metrics: SalonMetrics | undefined;
  loading: boolean;
}) {
  /*
   * interaction-spec.md §4: money fields skeleton as a bar. Never render
   * `0.000` before data arrives — a zero that turns out to be a loading state
   * generates a phone call.
   */
  if (loading || !metrics) {
    return (
      <div className="overview__kpis">
        {['Active members', 'Loaded today', 'Repeat rate', 'Upcoming today'].map((label) => (
          <StatCard key={label} label={label} value={null} loading />
        ))}
      </div>
    );
  }

  /*
   * =========================================================================
   * "LOADED TODAY" HAS NO PER-BRANCH ANSWER, AND `?? 0` WOULD BE A LIE
   * =========================================================================
   * `loadedTodayFils` and `knetSharePercent` are `null` whenever a branch is
   * applied — the invariant is `loadedTodayFils === null` iff `branchId !== null`
   * — because a top-up happens in the customer's app and has no branch to
   * attribute. Not an unknown branch: NO branch. `services/topup.ts` writes every
   * such row `branch_assumed = true` unconditionally and nothing on the roadmap
   * changes that, so the metrics service skips the query under a filter instead
   * of running it and handing a two-branch salon its whole day's takings under
   * one branch and 0.000 KD under the other.
   *
   * The tempting fix at this line is `fils(metrics.loadedTodayFils ?? 0)`. It
   * typechecks, it renders, and it puts **0.000 KD** under "Loaded today" for a
   * merchant who selected Salmiya — reinstating, at the very last layer, the
   * precise false zero the API was restructured to prevent, and adding a
   * fifteenth confident-number-that-is-not-true to this project's ledger. The
   * null is the answer. It gets a rendering, not a default.
   *
   * WHAT IT RENDERS: an em dash in the value slot and the reason in the note
   * slot beneath it. The dash rather than a sentence because the slot is a 32px
   * display numeral and a sentence there breaks the KPI grid; the note rather
   * than a `delta` because the delta line is `--avo-positive` green, which is
   * the register of "+48 this week" and reads as good news about an absence
   * (`@avo/ui` StatCard § `note`). The tile is NOT hidden: a tile that vanishes
   * when a branch is picked reads as "this figure does not exist", which is the
   * argument `Reports.tsx` already makes about a refused card.
   */
  /*
   * Held as locals so the null check below narrows the VALUE rather than a
   * boolean alias — and so no `?? 0` is needed anywhere to satisfy the
   * compiler. There is deliberately not one in this file: a reader who finds a
   * `?? 0` next to money should treat it as a bug, and leaving a dead one here
   * to appease narrowing would teach the opposite.
   */
  const loaded = metrics.loadedTodayFils;
  const knetShare = metrics.knetSharePercent;

  return (
    <div className="overview__kpis">
      <StatCard
        label="Active members"
        value={metrics.activeMembers.toLocaleString('en-US')}
        {...(metrics.activeMembersDelta > 0
          ? { delta: `+${metrics.activeMembersDelta} this week` }
          : {})}
      />
      {loaded === null ? (
        <StatCard
          label="Loaded today"
          value="—"
          note="Top-ups happen in the app, not at a branch"
        />
      ) : (
        <StatCard
          label="Loaded today"
          // formatMoney/formatFils from @avo/types is the only money formatter.
          value={<Money amount={fils(loaded)} />}
          unit="KD"
          {...(knetShare !== null && knetShare > 0
            ? { delta: `${knetShare}% via KNET` }
            : {})}
        />
      )}
      {/*
        The design shows "+4 pts vs last month" under Repeat rate; that figure
        still does not exist on GET /salons/{id}/metrics, so it is still not
        rendered. The Upcoming tile's "next at 4:30 PM" DOES exist now —
        `nextAppointmentAt` landed on SalonMetricsSchema and tightened to
        required at 845dae4 — so half of this comment's old claim expired and
        only half is kept. Flagged-not-invented cuts both ways: rendering stops
        being optional once the field is real.
      */}
      <StatCard label="Repeat rate" value={`${metrics.repeatRatePercent}%`} />
      <StatCard
        label="Upcoming today"
        value={String(metrics.upcomingAppointments)}
        {...(metrics.nextAppointmentAt !== null
          ? { delta: `next at ${nextAtLabel(metrics.nextAppointmentAt)}` }
          : {})}
      />
    </div>
  );
}

/**
 * "next at 4:30 PM" — the Upcoming tile's sub-label, in the design's own words.
 *
 * THE SERVER SENDS AN INSTANT, DELIBERATELY. The schema's comment ties the field
 * to the count's own window and zone; the RENDERING is this client's job, in the
 * salon's clock. The zone is pinned to Asia/Kuwait rather than the browser's:
 * every salon this product ships to is Kuwaiti (`salon.timezone` defaults to it,
 * and the platform's own month boundary is defined in it), and an owner checking
 * the dashboard from abroad should read her salon's 4:30 PM, not her hotel's.
 *
 * `null` never reaches here — the schema guarantees it co-occurs with a count of
 * 0, and the call site hides the sub-label on null, which is the tile's honest
 * empty. Western digits by construction (#12): `toLocaleTimeString` with an
 * en locale renders Latin digits, which is what the money rule requires of the
 * Arabic layout too.
 */
function nextAtLabel(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'soon';
  return at.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'Asia/Kuwait',
  });
}

/* ------------------------------------------------ five, then the rest ---- */

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW MANY LINES THE PANEL DRAWS BEFORE IT ASKS — AND WHY IT IS DISCLOSURE
 * ═══════════════════════════════════════════════════════════════════════════
 * NEW WORK. The design bundle draws no control here: `AVO Merchant Dashboard
 * .dc.html:153` is a bare `<sc-for list="{{ feed }}" …>` whose only statement
 * about length is `hint-placeholder-count="5"`. So the NUMBER is the designer's
 * and the CONTROL is invented — said plainly rather than implied, because a
 * later reader should not go looking for a button in the bundle.
 *
 * FIVE, and it is not a taste call. Three things already say five and this file
 * was the only one that stopped agreeing:
 *   - the design's placeholder count, above;
 *   - the loading skeleton twenty lines below, which draws rows 0..4;
 *   - `routes/activity.ts`'s own header, which lists the five lines by name and
 *     titles the endpoint after them.
 * `FEED_DEFAULT_LIMIT` is 20 (`api/src/services/activityFeed.ts:33`) and
 * `useRecentActivity` sends no `limit`, so twenty rows were drawn in a card
 * beside the KPI tiles under a design that draws five. That is the complaint.
 *
 * THE SKELETON AND THE VISIBLE COUNT NOW AGREE, which they did not before, and
 * that was a second and smaller version of the same defect: five skeleton rows
 * resolved into a twenty-row card, so the Overview reflowed on every load. The
 * skeleton is therefore left at five deliberately, not left alone by accident.
 *
 * DISCLOSURE, NOT PAGING, AND THE ENDPOINT DECIDES IT RATHER THAN TASTE.
 * `Activity.tsx` and `Audit.tsx` say "Show older" and fetch another page; those
 * are screens "whose job is looking backwards" and their endpoints carry a
 * cursor. This one cannot: `GET /salons/{id}/activity` ends
 * `return reply.send({ items, nextCursor: null })` — unconditionally, with no
 * cursor parameter to send back — and its header says why ("NO CURSOR, ON
 * PURPOSE"). A `useInfiniteQuery` here would give `hasNextPage === false` on
 * every load, so the paging control those two screens use would never once
 * appear. Paging is not the wrong choice here; it is not a choice.
 *
 * SO THE BUTTON REVEALS ROWS ALREADY IN HAND AND FETCHES NOTHING. It cannot
 * reach a twenty-first row, and it does not claim to — see the label.
 */
export const FEED_VISIBLE = 5;

export interface FeedDisclosure {
  /** The rows to render. */
  visible: ActivityItem[];
  /**
   * How many rows the control would reveal. ZERO MEANS NO CONTROL — which is
   * what keeps this one branch rather than two: a four-row morning and an
   * already-expanded twenty-row one both report 0 and both draw nothing.
   */
  hidden: number;
}

/**
 * Five rows, then a control that reveals the rest.
 *
 * A NAMED RULE RATHER THAN A `slice(0, 5)` IN THE JSX, for the boundary's sake.
 * At exactly five there is nothing beneath the fifth, so the control must not
 * appear — a control that reveals nothing reads as broken — and `hidden > 0` is
 * the single expression that decides it. A `slice` here and a `length > 5` at
 * the call site would be two statements of one rule, and the boundary is
 * precisely where they would disagree.
 *
 * THE GUARD'S OWN `<=` IS NOT THE BOUNDARY, and this comment said it was until a
 * mutation proved otherwise. `apps/wallet § discloseActivity` warns that "the
 * boundary is `>` and not `>=`, and it is the whole near-empty case", so the
 * same warning was written here — but it does not transfer to this shape.
 * Flipping `<=` to `<` changes nothing for any length: at exactly five the early
 * return gives `hidden: 0`, and falling through instead gives
 * `5 - FEED_VISIBLE`, which is also 0. Measured for n = 0,1,3,4,5,6,20,21; every
 * pair identical, and a test asserting the boundary stayed green on the mutant.
 *
 * WHICH MEANS THE SUBTRACTION IS THE RULE. `items.length - FEED_VISIBLE` cannot
 * be positive while the list is short, so the near-empty case is structural
 * rather than guarded. The early return is kept for the identity it gives
 * `visible` and for reading as one statement of intent — not because the
 * comparison is load-bearing. A later reader tempted to "tighten" it should know
 * it is already inert.
 *
 * IT DISCLOSES ONCE AND DOES NOT RE-COLLAPSE. `hidden` is 0 afterwards, so the
 * control withdraws itself. That matches `apps/wallet § discloseActivity`, which
 * decided the same thing for the same panel on the other surface and argued that
 * inventing a second string to undo the first is the worse trade. The panel
 * remounts on every return to Overview and opens at five again.
 */
export function discloseFeed(
  items: readonly ActivityItem[],
  expanded: boolean,
): FeedDisclosure {
  if (expanded || items.length <= FEED_VISIBLE) return { visible: [...items], hidden: 0 };
  return { visible: items.slice(0, FEED_VISIBLE), hidden: items.length - FEED_VISIBLE };
}

/* ------------------------------------------------------------- activity feed */

interface ActivityListProps {
  items: ActivityItem[] | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  retrying: boolean;
}

export function ActivityList({ items, loading, error, onRetry, retrying }: ActivityListProps) {
  /*
   * VIEW STATE, AND IT LIVES HERE. It is not a preference, it is not persisted,
   * and it does not belong on `useRecentActivity`: nothing about it reaches the
   * server, and the panel unmounts when the merchant leaves the Overview, which
   * is the behaviour a disclosure should have.
   *
   * Declared before the early returns because hooks must be — the four states
   * below all return without reading it.
   */
  const [expanded, setExpanded] = useState(false);
  /*
   * WHERE FOCUS GOES WHEN THE BUTTON REMOVES ITSELF.
   *
   * Pressing it reveals fifteen rows and withdraws the control, so the element
   * the keyboard was on leaves the document — and focus falls to <body>, which
   * puts the merchant back at the top of the dashboard having just asked to see
   * MORE of something further down. The list is given `tabIndex={-1}` (never
   * reachable by Tab, reachable by `.focus()`) and takes focus instead, so a
   * reader lands on the list it just grew and announces its new length.
   *
   * `MerchantShell`'s drawer is the precedent for the technique. The ring is the
   * token `:focus-visible` one, so a mouse press draws no outline and a keyboard
   * press does.
   */
  const listRef = useRef<HTMLUListElement>(null);

  if (loading) {
    return (
      <ul className="overview__feed">
        {[0, 1, 2, 3, 4].map((row) => (
          <li key={row} className="overview__feed-item">
            <span className="overview__feed-dot" aria-hidden="true" />
            <span className="overview__feed-body">
              <Skeleton width={`${70 - row * 6}%`} height={13} />
              <Skeleton width={64} height={11} />
            </span>
          </li>
        ))}
      </ul>
    );
  }

  /** Held as the narrowed type, so the branches below can read the server's copy. */
  const apiError = error instanceof ApiError ? error : null;
  const forbidden = apiError?.isForbidden ?? false;

  /*
   * STALE-NOT-BLANK, AND IT ONLY BECAME REACHABLE WITH THE FIX.
   *
   * §4: "Network failure keeps the last-known data visible with a stale banner
   * rather than blanking." This panel checked `error` before `items` and so
   * would blank a list it was still holding — which never showed, because while
   * the hook read `GET /charges` it was refused on every load and there was
   * never a cached row to lose. Making the request succeed made the hazard real
   * in the same change, so it is fixed in the same change.
   *
   * A REFUSAL IS EXCLUDED, exactly as it is for the metrics above: a 403 means
   * this staff member may not see these lines, and holding them on screen behind
   * a retry shows her precisely what she is not allowed to see. `forbidden`
   * therefore falls through to the explain state even with rows in hand.
   *
   * The banner §4 asks for is the one `Overview` already renders above the KPI
   * row — the whole screen is stale together, so the feed does not draw a second.
   */
  const keepStale = Boolean(error) && !forbidden && items !== undefined && items.length > 0;

  if (error && !keepStale) {
    // 401 — the session is gone and the shell is already redirecting to
    // sign-in. Rendering a refusal here would flash for one frame and tell the
    // merchant she lacks a permission she actually holds.
    if (apiError?.isUnauthenticated) return null;

    const offline = apiError?.isConnectivity ?? false;

    return (
      <div className="overview__feed-state">
        {forbidden ? (
          /*
           * 403 — explain, no retry (interaction-spec.md §4).
           *
           * THIS BRANCH USED TO BE THE NORMAL PATH. It rendered the scanner's
           * refusal of `GET /charges` on every load, which is the bug this file
           * was fixed for. Now that the feed shares `perms.dashboard` with the
           * metrics, the only refusal that reaches here without `MetricsError`
           * taking the whole screen first is `requireSameSalon` — "That salon is
           * not yours." Kept, because a state that is unreachable today is not a
           * state that may be absent; the server's own copy is rendered rather
           * than paraphrased, exactly as `MetricsError` does below.
           */
          <ErrorState title="You don't have access to this" body={apiError?.message ?? ''} />
        ) : offline ? (
          /*
           * OFFLINE IS ITS OWN STATE, not "something went wrong" (§4). The
           * metrics beside this panel distinguish the two and this one did not —
           * a merchant on a dropped salon wifi was told the workspace answered
           * badly, which sends her looking for a fault that is not there. The
           * figures above stay on screen behind their stale banner, so the
           * sentence says so.
           */
          <ErrorState
            title="No connection"
            body="We can't reach the workspace. Your figures above are the last we loaded."
            onRetry={onRetry}
            retrying={retrying}
          />
        ) : (
          <ErrorState
            title="Couldn't load activity"
            body="The workspace didn't answer. Your figures above are unaffected."
            onRetry={onRetry}
            retrying={retrying}
          />
        )}
      </div>
    );
  }

  if (!items || items.length === 0) {
    /*
     * EMPTY, AND IT NOW MEANS WHAT IT SAYS. §4: "every empty state names the
     * thing and offers the one action that fills it."
     *
     * This state was previously unreachable — the request was refused before it
     * could return zero rows, so the panel showed a permission error on a quiet
     * morning exactly as it did on a busy one. The list it names is the list the
     * endpoint actually merges (`FEED_KINDS` plus the loyalty stream), not the
     * charges-only stream the old hook read, so a merchant who reads this and
     * then tops a customer up will see the line she was promised.
     *
     * The action is the scanner, because that is genuinely the only thing that
     * starts a line: nothing on this dashboard writes to the feed.
     */
    return (
      <div className="overview__feed-state">
        <EmptyState
          title="Nothing today yet"
          body="Charges, top-ups, deposit returns and tier changes land here as your team serves customers. The first one appears when someone scans a customer's QR on the salon phone."
        />
      </div>
    );
  }

  /*
   * `who` then `what`, which is the design's own row —
   * `AVO Merchant Dashboard.dc.html` § Overview draws `{{ f.who }} {{ f.what }}
   * {{ f.when }}`.
   *
   * THE AMOUNT IS INSIDE `what` AND IS NOT RENDERED SEPARATELY. It is composed
   * server-side, and `services/activityFeed.ts` explains why in terms of a bug
   * it already fixed once: a top-up's `amountFils` is what LANDED, bonus
   * included, so "topped up" beside that column reads five dinars higher than
   * the customer paid. `amountFils` is carried on the item for a caller that
   * needs to total or colour by it; this row is prose and prints the prose.
   */
  /*
   * THE SUCCESS PATH, AND THE ONLY PATH THE CONTROL IS ON.
   *
   * Every state above returns before this line, so the disclosure cannot appear
   * under a skeleton, an empty state or a refusal. The one state it DOES share a
   * screen with is `keepStale` — rows held behind the KPI row's stale banner —
   * and that is correct: those rows are in hand, the button reveals what is in
   * hand, and it fetches nothing that could fail again.
   */
  const { visible, hidden } = discloseFeed(items, expanded);

  return (
    <>
      <ul className="overview__feed" ref={listRef} tabIndex={-1}>
        {visible.map((item) => (
          <li key={item.id} className="overview__feed-item">
            <span className="overview__feed-dot" aria-hidden="true" />
            <span className="overview__feed-body">
              <span className="overview__feed-text">
                <b>{item.who}</b> {item.what}
              </span>
              <span className="overview__feed-when">{timeLabel(item.at)}</span>
            </span>
          </li>
        ))}
      </ul>

      {hidden > 0 ? (
        /*
         * THE AFFORDANCE IS THE ONE THE LOG SCREENS ALREADY ESTABLISHED — a
         * secondary `Button` beneath the rows, with the count in the label —
         * because a second shape for "there is more below" would be a second
         * thing to learn. THE WORD IS NOT. `Audit.tsx`, `AuditLog.tsx` and
         * `Activity.tsx` all say "Show older", and there it means "ask the
         * server for another page", an unbounded walk backwards. Here it means
         * "reveal the rest of what already arrived", and then there is no more.
         * Borrowing their label for a different mechanism is exactly the "two
         * screens disagree about the same word" hazard `services/activityFeed.ts`
         * exists to prevent, one layer up.
         *
         * THE COUNT IS THE DELTA, NOT A TOTAL, and it is a count this panel can
         * actually stand behind: `hidden` is rows it is holding. The endpoint
         * sends no `total` — and could not, since the sum of two streams' counts
         * is not the length of the merged list — so nothing here claims one.
         *
         * THE ACCESSIBLE NAME NAMES THE THING. "Show 15 more" out of context
         * says nothing about what fifteen of; the label extends it rather than
         * replacing it, so the visible text is still contained in the accessible
         * name (WCAG 2.5.3). Singular at exactly one.
         */
        <div className="overview__feed-more">
          <Button
            variant="secondary"
            aria-label={`Show ${hidden} more activity ${hidden === 1 ? 'row' : 'rows'}`}
            onClick={() => {
              setExpanded(true);
              listRef.current?.focus();
            }}
          >
            Show {hidden} more
          </Button>
        </div>
      ) : null}
    </>
  );
}

function timeLabel(iso: string): string {
  const when = new Date(iso);
  const sameDay = when.toDateString() === new Date().toDateString();
  return sameDay
    ? when.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : when.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) +
        ' · ' +
        when.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/* ------------------------------------------------------------------- errors */

function MetricsError({
  error,
  onRetry,
  retrying,
}: {
  error: unknown;
  onRetry: () => void;
  retrying: boolean;
}) {
  // 401: signed out. The shell owns that — it redirects. Show nothing here.
  if (error instanceof ApiError && error.isUnauthenticated) return null;

  /*
   * 403: "not yours". Two different refusals arrive with this status and both
   * are explain-only —
   *   - `perms.dashboard` is off for this staff member, or
   *   - `requireSameSalon` refused: "That salon is not yours."
   * Neither is fixed by pressing a button, so there is no button. The body is
   * the server's own copy, which names who can grant the permission.
   */
  if (error instanceof ApiError && error.isForbidden) {
    return <ErrorState title="You don't have access to the overview" body={error.message} />;
  }

  const offline = error instanceof ApiError && error.isConnectivity;
  return (
    <ErrorState
      title={offline ? 'No connection' : "Couldn't load the overview"}
      body={
        offline
          ? "We can't reach the workspace. Nothing is lost — try again once you're back online."
          : 'Something went wrong on our side. Nothing has changed in your salon.'
      }
      onRetry={onRetry}
      retrying={retrying}
    />
  );
}
