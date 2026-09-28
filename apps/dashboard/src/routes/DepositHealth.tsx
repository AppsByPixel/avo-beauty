import type { Fils } from '@avo/types';
import { Card, EmptyState, Money, Pill, Skeleton, StatCard } from '@avo/ui';
import { useDepositHealth, type DepositHealth as Health, type DepositRow } from '../api/deposits.js';
import { useBranchScope } from '../shell/BranchScope.js';
import { whenLabel } from './appointmentWhen.js';
import {
  DEPOSIT_FRAMING,
  formatElapsed,
  groupByState,
  partyFor,
  type DepositGroup,
} from './depositHealthRules.js';
import { joinClauses } from './Overview.js';
import { SectionError } from './sectionState.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MERCHANT → APPOINTMENTS → DEPOSITS. `GET /salons/{id}/deposits`.
 * ═══════════════════════════════════════════════════════════════════════════
 * The client's last numbered item, verbatim: *"what if they dont have enough
 * payment (sometimes they dont have money but lock the booking and they dont
 * come) deposit health option for merchants"*.
 *
 * NEW SCOPE, NO DESIGNED SCREEN — `depositHealthRules.ts` carries the disclosure
 * and the copy. Built in the established dashboard idiom (tiles, a tinted
 * explanatory strip, real `<table>`s with real `<th scope="col">`) and nothing is
 * restyled.
 *
 * ===========================================================================
 * WHY IT IS A VIEW OF APPOINTMENTS AND NOT A NAV ITEM OR AN OVERVIEW CARD
 * ===========================================================================
 * THE PERMISSION DECIDED IT. `GET /salons/{id}/deposits` is
 * `requireDashboardPerm(req, 'appointments')` — the SAME guard as the board this
 * view sits inside, argued at length in `api/src/routes/deposits.ts`: this is a
 * narrower read of a set `GET /salons/{id}/bookings` already opens, and the seed
 * makes the consequence concrete, because Hessa (`ST-002`) is the front desk and
 * holds `appointments` without `dashboard`.
 *
 *   NOT A CARD ON OVERVIEW. Overview is `perms.dashboard`. A `perms.appointments`
 *   read dropped onto it would 403 for exactly the person the client asked for —
 *   the front desk — and a correct, well-written refusal on the first screen a
 *   merchant sees is how `useRecentActivity` hid a broken panel for a whole
 *   slice (`api/merchantScopeGates.test.ts` is the test that exists because of
 *   it). The `held`/`scheduled` figures are tile-shaped and that is exactly the
 *   trap: `services/customerDirectory.ts` states the rule this codebase follows —
 *   the permission follows THE DATA, not the shape of the screen it is drawn on.
 *   And the data here is named customers, their phone numbers and how late each
 *   one is, which is the appointment book.
 *
 *   NOT ITS OWN NAV ITEM. `router.tsx` derives its routes from `NAV_ITEMS`, so a
 *   new section is a nav row, a route, a census entry and a sidebar the design
 *   does not draw — ten items is the shell's artboard and CLAUDE.md § "Do not
 *   restyle" covers the frame as well as the colours. It would also put a
 *   `perms.appointments` destination in a sidebar whose other rows span five
 *   different permissions, with no refusal until she clicks.
 *
 *   A VIEW OF APPOINTMENTS. The section's subtitle is already "Every booking and
 *   its deposit status", its strip already explains the auto-return window this
 *   view's first section depends on, and its `Segmented` already offers List and
 *   Week. Deposits is the third answer to "what is on this board", the gate is
 *   the one already passed, and a merchant looking at an overdue row is one click
 *   from the List where she can act on it.
 *
 * ===========================================================================
 * WHAT THIS SCREEN REFUSES TO BUILD
 * ===========================================================================
 * The client's framing is about customers who repeatedly lock a slot and do not
 * come, and the easy build is the wrong one. `countMemberNoShows` in
 * `api/src/services/customerDirectory.ts` argues it and this view holds the line:
 *
 *   NO `noShowCount` ANYWHERE IN THIS FILE. It is served on the CUSTOMER DETAIL
 *   and never on a list, because — Lane A's words — a column of counts down a
 *   page of names is a ranking whether or not anything sorts by it. It is drawn
 *   in `Customers.tsx`, beside `visits`, where a merchant is already looking at
 *   one person.
 *
 *   NO SORT CONTROL. The rows arrive `starts_at ASC` — a queue — and there is no
 *   affordance here that reorders them. `depositHealthRules.ts § groupByState`
 *   has the argument for why grouping is not sorting.
 *
 *   NO FLAG, NO SCORE, NO THRESHOLD, NO WARNING GLYPH beside a name. Every row
 *   carries the same weight; the SECTION says whose problem it is, and nothing at
 *   the row level characterises the person in it.
 */

/* ============================================================== the figures */

/**
 * THE THREE STOCKS. Every figure here is "right now" and none of them has a
 * window — `api/src/routes/deposits.ts` declines `?period=` outright, because
 * "deposits held today for bookings whose slot was in March" is a different
 * figure from "March's deposit health" and a false one. So there is no date
 * control on this screen to match.
 *
 * `loading` SKELETONS THE VALUE RATHER THAN PAINTING A ZERO. interaction-spec.md
 * §4, and this is the screen where it matters most: `0.000 KD` under "Held right
 * now" is indistinguishable from a salon holding nothing, on a surface whose
 * entire job is to say how much of her customers' money is in the air.
 */
function DepositTiles({ health, loading }: { health: Health | undefined; loading: boolean }) {
  return (
    <div className="deposits__tiles">
      <DepositTile label="Held right now" loading={loading} bucket={health?.held} />
      <DepositTile label="Slot still to come" loading={loading} bucket={health?.scheduled} />
      {/*
        "Past their slot", not "at risk" and not "problem bookings". The set is
        defined by a clock and nothing else — two thirds of it is either AVO's
        own backlog or the salon's book-keeping — so the tile names the fact and
        leaves the three sections below to say whose problem each part is.
      */}
      <DepositTile label="Past their slot" loading={loading} bucket={health?.overdue} />
    </div>
  );
}

/**
 * ONE TILE. The `note` slot is spread conditionally rather than passed as
 * `undefined`, because `exactOptionalPropertyTypes` is on in this workspace and
 * "absent" and "explicitly undefined" are different types — which is the right
 * strictness here: the count line is genuinely ABSENT while pending, and
 * `StatCard` skeletons it on that basis.
 */
function DepositTile({
  label,
  loading,
  bucket,
}: {
  label: string;
  loading: boolean;
  bucket: { bookings: number; fils: Fils } | undefined;
}) {
  return (
    <StatCard
      label={label}
      loading={loading}
      unit="KD"
      value={bucket ? <Money amount={bucket.fils} /> : null}
      {...(bucket ? { note: bookingsNote(bucket.bookings) } : {})}
    />
  );
}

/** "12 bookings" / "1 booking" / "no bookings" — the count under a money tile. */
export function bookingsNote(bookings: number): string {
  if (bookings === 0) return 'no bookings';
  return `${bookings} ${bookings === 1 ? 'booking' : 'bookings'}`;
}

/**
 * HOW MUCH OF A PER-BRANCH FIGURE IS A GUESS — proportionally, or not at all.
 *
 * FOURTH PLACE FOR THIS SENTENCE, and it is reused rather than reinvented:
 * `Overview.tsx § AssumedNote` and `Reports.tsx § BranchAssumedCaveat` print the
 * same words about the same column, and `joinClauses` is imported from the first
 * of them so the list grammar cannot drift into an Oxford comma on one screen
 * and not the other.
 *
 * NOTHING AT `branch=all`. The API sends `branchAssumed: null` there on purpose —
 * a row attributed to the wrong branch is still inside the salon, so a
 * salon-wide total is exact however many rows are assumed — and a null is not a
 * zero to render as "0 of 12".
 *
 * IT DISAPPEARS ON ITS OWN, which is `AssumedNote`'s deciding property and holds
 * here identically: these are COUNTS, so when branch-bound scanner sessions land
 * they fall to zero, every clause returns null, and the caveat leaves the UI with
 * no code change and nobody remembering to delete it.
 */
export function DepositAssumedNote({ health }: { health: Health | undefined }) {
  if (!health) return null;

  const parts = [
    assumedClause(health.held.branchAssumed, health.held.bookings, 'held'),
    assumedClause(health.overdue.branchAssumed, health.overdue.bookings, 'overdue'),
  ].filter((part): part is string => part !== null);

  if (parts.length === 0) return null;

  return (
    <p className="deposits__note" role="status">
      Branch assumed on {joinClauses(parts)} — treat these branch figures as approximate.
    </p>
  );
}

/** One clause — "2 of 9 overdue". A zero contributes nothing rather than noise. */
function assumedClause(assumed: number | null, total: number, noun: string): string | null {
  if (assumed === null || assumed <= 0 || total <= 0) return null;
  return `${assumed} of ${total} ${noun}`;
}

/* ============================================================= the sections */

/**
 * ONE SECTION PER STATE, WITH ITS OWN HEADING AND ITS OWN SENTENCE.
 *
 * DRAWN ON THE SERVER'S COUNT AND NOT ON `rows.length`. The counts are exact and
 * unbounded; the row list is capped at 200. A section with a positive count and
 * no rows inside the cap is a real state and it says so — the alternative is a
 * section that silently disappears while the tile above it still counts its
 * bookings, which is the two-figures-disagreeing defect the API's single-query
 * aggregate exists to prevent, reintroduced by the client.
 */
function DepositSection({
  group,
  truncated,
  timezone,
}: {
  group: DepositGroup;
  truncated: boolean;
  timezone: string | null;
}) {
  if (group.bookings === 0) return null;

  const framing = DEPOSIT_FRAMING[group.state];
  const hidden = group.bookings - group.rows.length;
  const money = group.state !== 'unclosed';

  return (
    <section className="deposits__section" data-state={group.state}>
      <div className="deposits__section-head">
        <h3 className="deposits__section-title avo-display">{framing.title}</h3>
        <Pill tone="quiet">{bookingsNote(group.bookings)}</Pill>
      </div>
      <p className="deposits__section-body">{framing.body}</p>

      {/*
        THE DISCREPANCY, SAID WHERE SHE CAN SEE BOTH FIGURES. `overdue.bookings`
        is the authority and the count in the pill above is it; this line is what
        stops the shorter list below reading as a correction of it.

        `hidden > 0` IS THE CONDITION, NOT `truncated`. A response can be
        truncated overall while this particular section is complete — the cap
        takes the tail of one ordered list, so a state whose rows all sit early
        in it loses nothing. Reporting a cap on a section that lost no rows would
        be a caveat about the wrong thing. `truncated` still gates it, because a
        difference without the cap behind it would be the API disagreeing with
        itself and is not this line's to explain.
      */}
      {truncated && hidden > 0 ? (
        <p className="deposits__capped" role="status">
          Showing {group.rows.length} of {group.bookings}. The list below is capped at the 200
          oldest overdue bookings across all three sections; the count beside the heading is
          exact.
        </p>
      ) : null}

      {group.rows.length === 0 ? (
        <p className="deposits__capped" role="status">
          All {group.bookings} of these are past the 200-row cap, so none is listed here. The
          count is exact.
        </p>
      ) : (
        <div className="deposits__scroll">
          <table className="deposits__table">
            <caption className="avo-sr-only">{framing.caption}</caption>
            <thead>
              <tr>
                <th scope="col">Customer</th>
                <th scope="col">Service</th>
                <th scope="col">Artist</th>
                <th scope="col">Slot</th>
                {/*
                  NO DEPOSIT COLUMN ON `unclosed`, AND IT IS NOT AN OMISSION.
                  `booking_deposit_matches_hold` makes "no hold" and "zero
                  deposit" the same fact, so every figure in this column would be
                  `0.000 KD` for ever — a money figure that can only be zero can
                  only mislead. The API declines to serve the sum for that reason
                  and the column goes with it, rather than being served as a
                  column of dashes that invites somebody to "fix" it.
                */}
                {money ? <th scope="col">Deposit</th> : null}
                <th scope="col">{framing.elapsedHead}</th>
              </tr>
            </thead>
            <tbody>
              {group.rows.map((row) => (
                <DepositBookingRow key={row.bookingId} row={row} money={money} timezone={timezone} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * EXPORTED FOR THE RENDER TEST, on `Appointments.tsx § BookingRow`'s precedent.
 * What a merchant reads off one of these rows — a name that is not a tombstone,
 * a deposit at the display boundary, and no sentence about her — does not survive
 * a source scan.
 *
 * PRESENTATIONAL AND STATELESS. There is nothing to click: this view reads and
 * does not write. Every control that acts on a booking lives on the List, behind
 * `perms.void` and a confirmation, and duplicating one here would be a second
 * place for the idempotency key to be minted.
 */
export function DepositBookingRow({
  row,
  money,
  timezone,
}: {
  row: DepositRow;
  money: boolean;
  /** The salon's zone — the slot is printed in its clock. See `appointmentWhen.ts`. */
  timezone: string | null;
}) {
  const party = partyFor(row);
  /*
   * `returnOverdueMinutes` IS NULL ON TWO OF THE THREE STATES AND THAT NULL IS
   * MEANINGFUL. An `awaiting_arrival` row has not reached its deadline and an
   * `unclosed` row has no money behind the deadline it passed, so there is
   * nothing due on either — a zero there would read as "due back this instant".
   * The section's own column decides which figure is the right one to show, and
   * the fallback is `overdueMinutes`, which every row has.
   */
  const elapsed =
    row.state === 'return_overdue' && row.returnOverdueMinutes !== null
      ? row.returnOverdueMinutes
      : row.overdueMinutes;

  return (
    <tr>
      <td>
        <div className="deposits__customer">{party.name}</div>
        {/*
          A WALK-IN IS LABELLED AS ONE — she has no account, so a merchant who
          goes looking for her in the customer book should know why she is not
          there. A neutral marker on the identity and not on her conduct.
        */}
        {party.kind === 'guest' ? (
          <Pill tone="quiet" className="deposits__guest">
            Walk-in
          </Pill>
        ) : null}
        <DepositContact party={party} />
      </td>
      <td>{row.serviceName}</td>
      <td className="deposits__muted">{row.artistName}</td>
      <td className="deposits__when">
        {whenLabel(row.startsAt, timezone)}
        <div className="deposits__branch">
          {row.branchName}
          {/*
            Same word the board, the Overview caveat and the branch-closure
            warning already use, fifth place. A row whose branch was inferred
            rather than recorded says so where the branch is printed.
          */}
          {row.branchAssumed ? ' · branch assumed' : ''}
        </div>
      </td>
      {money ? (
        <td className="deposits__deposit">
          {/*
            THE DISPLAY BOUNDARY AND THE ONLY ONE. `depositFils` came off the
            wire as an integer, through `parseFils`, and reaches this line
            untouched — nothing on this screen adds, compares or rounds it, and
            the three tiles above are the SERVER's sums rather than a total of
            the rows in hand. #1.

            A GUEST ROW RENDERS `0.000` HERE AND THAT IS CORRECT RATHER THAN
            EMPTY. `booking_merchant_is_zero_deposit` forbids a merchant-written
            row from carrying money at all, so the zero is a fact about a real
            booking with a real slot — unlike the `unclosed` SUM, which is a
            figure that could never be anything else and is therefore not drawn.
          */}
          <Money amount={row.depositFils} />
        </td>
      ) : null}
      <td className="deposits__elapsed">{formatElapsed(elapsed)}</td>
    </tr>
  );
}

/**
 * HER NUMBER, OR THE REASON THERE ISN'T ONE.
 *
 * ERASURE IS READ OFF THE FLAG, NEVER OFF THE PREFIX. `serialiseMemberContact`
 * keeps the `+990` tombstone off the wire and `memberPhone` is null for an
 * erased member; this renders a sentence rather than an empty cell so a merchant
 * knows the absence is deliberate. DECISIONS #100, and the third merchant surface
 * to get this right after the two that got it wrong.
 *
 * PLAIN TEXT AND NOT A `tel:` LINK. This is a read-only backlog view, not the
 * board she works from, and the one number that must never become a dial is the
 * one that is not a number at all.
 */
function DepositContact({ party }: { party: ReturnType<typeof partyFor> }) {
  if (party.kind === 'erased') {
    return <div className="deposits__contact-erased">Phone no longer held</div>;
  }
  if (party.phone === null) return null;
  return (
    <div className="deposits__phone" dir="ltr">
      {party.phone}
    </div>
  );
}

/* ================================================================ the screen */

/**
 * `timezone` is the salon's, passed down by `Appointments` which already holds
 * the salon read — the rows print a booking's slot in the salon's clock, the
 * same reading the List gives the same booking. `null` while that read is in
 * flight; see `salonTime.ts § clockFrame` for what a row says then.
 */
export function DepositHealth({ timezone }: { timezone: string | null }) {
  /*
   * THE SHELL'S BRANCH SELECTION, not a second control. `?branch=` here is the
   * same parameter, the same vocabulary and the same `branchQuery` the Overview
   * tiles and the Reports cards send — a screen with its own branch picker would
   * be a second answer to a question the header already asks.
   */
  const { selected } = useBranchScope();
  const health = useDepositHealth(selected);

  if (health.isError) {
    return (
      <SectionError
        error={health.error}
        forbiddenTitle="You don't have access to appointments"
        failedTitle="Couldn't load deposit health"
        onRetry={() => void health.refetch()}
        retrying={health.isFetching}
      />
    );
  }

  const data = health.data;
  const loading = health.isPending;

  return (
    <div className="deposits">
      <DepositTiles health={data} loading={loading} />
      <DepositAssumedNote health={data} />
      {loading ? <DepositSkeleton /> : data ? <DepositBody health={data} timezone={timezone} /> : null}
    </div>
  );
}

/**
 * interaction-spec.md §4: a pending screen paints where the data will be, and
 * says nothing it is not painting. No heading, no count, no "0 overdue" — the
 * three tiles above are already skeletoned by `StatCard`, and a section title
 * rendered over a skeleton would announce a state this screen has not read yet.
 */
function DepositSkeleton() {
  return (
    <Card className="deposits__card">
      <Skeleton width="38%" height={18} />
      <Skeleton width="72%" height={13} />
      <Skeleton width="100%" height={13} />
      <Skeleton width="100%" height={13} />
      <Skeleton width="100%" height={13} />
    </Card>
  );
}

/**
 * ===========================================================================
 * THE EMPTY STATE HERE IS A GOOD OUTCOME AND MUST READ AS ONE
 * ===========================================================================
 * Nowhere else in this dashboard does an empty list mean the business is
 * healthy. "No appointments this week" is a salon with nothing booked; "No
 * customers yet" is a salon with no customers. An empty deposit queue is the
 * opposite: every deposit resolved, nobody waiting on a return, nothing left
 * open. Rendering the house empty-state tone over it — an absence, with an action
 * that fills it — would tell a merchant her best day looks like missing data.
 *
 * TWO EMPTIES, NOT ONE, and they are different facts with different meanings —
 * `AVO States.dc.html`'s standing rule, applied to a pair nobody has drawn:
 *
 *   NOTHING HELD AT ALL. No deposits in scope, so there is nothing that COULD be
 *   overdue. True of a quiet salon and of a branch filter that matched nothing,
 *   and it must not claim the second is the first.
 *
 *   HELD, NONE OVERDUE. The healthy one. Money is on hold and every slot behind
 *   it is still in the future — which is exactly what deposits are for, and the
 *   copy says so rather than merely reporting a zero.
 */
export function DepositBody({ health, timezone }: { health: Health; timezone: string | null }) {
  if (health.held.bookings === 0) {
    return (
      <Card className="deposits__card">
        <EmptyState
          title="No deposits on hold"
          body="Nothing is being held for this salon right now. A deposit appears here the moment a customer books a slot."
        />
      </Card>
    );
  }

  if (health.overdue.bookings === 0) {
    return (
      <Card className="deposits__card deposits__card--clear">
        <EmptyState
          title="Nothing overdue — every held deposit is for a slot still to come"
          body="No customer is waiting on a return and no booking has been left open. This is what a healthy deposit book looks like."
        />
      </Card>
    );
  }

  const groups = groupByState(health.rows, {
    awaiting_arrival: health.overdue.awaitingArrival.bookings,
    return_overdue: health.overdue.returnOverdue.bookings,
    unclosed: health.overdue.unclosed.bookings,
  });

  return (
    <>
      {groups.map((group) => (
        <DepositSection
          key={group.state}
          group={group}
          truncated={health.rowsTruncated}
          timezone={timezone}
        />
      ))}
    </>
  );
}
