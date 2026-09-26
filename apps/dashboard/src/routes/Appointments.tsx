import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { parseFils, type StaffPerms } from '@avo/types';
import { Card, EmptyState, InfoBanner, Money, Pill, Segmented, Skeleton } from '@avo/ui';
import { useMarkNoShow, useSalonBookings, type MerchantBooking } from '../api/bookings.js';
import { useSalon } from '../api/salon.js';
import { useSession } from '../auth/AuthProvider.js';
import { AppointmentsWeek } from './AppointmentsWeek.js';
import { STATUS_PILL } from './appointmentsWeekRules.js';
import { formatReturnWindow } from './noShowWindow.js';
import { SectionError, WriteError } from './sectionState.js';

/**
 * Merchant → Appointments. `GET /salons/{id}/bookings`, `perms.appointments`.
 *
 * ONE COURTESY GATE, AND IT IS NOT THE SECTION'S — IT IS THE LINK'S. The read is
 * `requireDashboardPerm(req, 'appointments')` server-side, so the SECTION still
 * needs no gate: the refusal arrives on its own and `SectionError` explains it.
 * What changed is that the section is no longer read-only. "Mark no-show" is
 * `requireDashboardPerm(req, 'void')`, a DIFFERENT permission from the one that
 * opened the screen, so a merchant who can see this board is not thereby someone
 * who can mark. `api/bookings.ts § useMarkNoShow` argues the gate and names the
 * seeded account it protects; the ledger in sectionState.tsx carries the row.
 *
 * A REAL <table>, for the reason the audit log is one: interaction-spec.md §2,
 * "Data tables: `<table>` with real `<th scope="col">`. Not divs." The design
 * draws six unlabelled grid columns, which read to a screen reader as one
 * run-on sentence per booking.
 *
 * THE TWO EMPTIES ARE THE POINT OF THIS SCREEN'S STATE WORK.
 * `AVO States.dc.html`: "Two different empties: nothing booked yet, versus the
 * Booking module switched off. Never show the same copy for both." They are not
 * two phrasings of one condition — they are different facts with different
 * fixes. "No appointments this week" tells a salon that takes bookings that
 * nobody has booked; shown to a salon with the module off it is a lie, because
 * nobody *can* book. The switched-off empty carries the action that resolves it.
 */

/**
 * THE STATUS PILLS MOVED TO `appointmentsWeekRules.ts`, WITH THEIR ARGUMENT INTACT.
 *
 * They were defined here for as long as this screen was the only view of a
 * booking. The week grid labels the same four statuses, and two views of one
 * board that call `no_show_returned` different things are worse than one view —
 * so the table has one home and both views import it. The colour-deviation note
 * and the `cancelled` disclosure travelled with it; nothing about the pills
 * themselves changed.
 */

/**
 * "Today · 4:30 PM", "Tomorrow · 11:00 AM", "9 Jul · 7:00 PM".
 *
 * The API sends an ISO instant on purpose — the relative phrasing depends on the
 * reader's clock, and non-negotiable #12 makes the Arabic dashboard a real
 * layout rather than a string swap. Appointments look forward as well as back,
 * so this carries "Tomorrow", which the audit log's past-only equivalent does
 * not.
 */
function whenLabel(iso: string): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(at) - midnight(new Date())) / 86_400_000);

  if (days === 0) return `Today · ${time}`;
  if (days === -1) return `Yesterday · ${time}`;
  if (days === 1) return `Tomorrow · ${time}`;
  return `${at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · ${time}`;
}

/**
 * ===========================================================================
 * WHETHER TO DRAW "Mark no-show" — THREE CONDITIONS, NOT THE DESIGN'S ONE
 * ===========================================================================
 * `AVO Merchant Dashboard.dc.html:184` guards the link on `canMark`, and the
 * mock computes that as `st === 'held'`. That is the status condition and only
 * the status condition, which is right for a static mock with one signed-in
 * persona and one frozen clock, and insufficient for the real board:
 *
 *   status  `deposit_held` is the only status the deposit can come back FROM.
 *           `services/booking.ts § returnDeposit` asserts it in the UPDATE's
 *           WHERE clause, and `markNoShow` answers `already_no_show` /
 *           `not_markable` above it. Offering the link on a completed booking
 *           offers a 409.
 *
 *   perms   `perms.void`, NOT `perms.appointments`. The board's own gate does
 *           not imply this one — `api/bookings.ts § useMarkNoShow` has the
 *           argument and the seeded account it is about.
 *
 *   clock   `now >= startsAt`. The server refuses earlier with 409
 *           `appointment_not_started`, because a no-show is a fact about an
 *           appointment that has begun, and marking one that has not yet
 *           started releases a slot the customer is still expected at.
 *
 * ALL THREE ARE COURTESIES AND THE SERVER ENFORCES ALL THREE. #7 — the point of
 * drawing them is that a merchant should not be offered a control that is
 * certain to be refused, not that the refusal would otherwise get through.
 *
 * THE CLOCK CONDITION IS THE ONE WORTH A SECOND LOOK, because this codebase
 * refuses client-side time arithmetic elsewhere: `noShowReturnDueAt` is served
 * rather than computed as `startsAt + 1h`, deliberately, "a client computing
 * that is a client deciding when a deposit is at risk". This is a different
 * thing and the difference is what makes it allowed: nothing here is DISPLAYED
 * as a fact and nothing here decides what happens — it decides whether to draw
 * an affordance, and the server independently re-decides on the request. The
 * cost of the client's clock being wrong is a link that appears a minute early
 * and earns an explained 409, not a wrong number on a screen.
 *
 * `now` IS A PARAMETER rather than a `Date.now()` inside, so the predicate is a
 * pure function of three inputs and the boundary is testable at the second.
 */
export function canMarkNoShow(
  booking: Pick<MerchantBooking, 'status' | 'startsAt'>,
  perms: Pick<StaffPerms, 'void'>,
  now: number,
): boolean {
  if (!perms.void) return false;
  if (booking.status !== 'deposit_held') return false;
  return Date.parse(booking.startsAt) <= now;
}

export function Appointments() {
  const navigate = useNavigate();
  const salon = useSalon();
  const session = useSession('merchant');
  const mark = useMarkNoShow();

  /**
   * =========================================================================
   * THE ARMED ROW — THE CONFIRMATION, AND WHERE THE IDEMPOTENCY KEY IS MINTED
   * =========================================================================
   *
   * THE CONFIRMATION IS A DEPARTURE FROM THE DESIGN AND IT IS ARGUED, NOT
   * ASSUMED. `AVO Merchant Dashboard.dc.html:184` draws a bare `<a href="#2a">`
   * and no dialog. Three facts about the real endpoint that the mock's anchor
   * cannot carry:
   *
   *   IT CANNOT BE UNDONE. There is no un-mark route. `api/src/routes/bookings.ts`
   *   has four booking routes and none of them moves `no_show_returned` back.
   *
   *   IT RELEASES THE SLOT. `booking_artist_slot_no_overlap` excludes
   *   `no_show_returned`, so the artist's hour becomes bookable the instant this
   *   commits and the wallet can take it seconds later. Even the manual remedy —
   *   re-book her — is not guaranteed to be available by the time anyone notices.
   *
   *   IT IS AN ASSERTION ABOUT A NAMED CUSTOMER. `no_show_returned` is a claim
   *   about her conduct, written to her record with the marker's staff id on it.
   *
   * A 12px link sitting in a dense table beside a status pill, on rows that shift
   * under a refetch, is a mis-click waiting to happen, and every one of the three
   * consequences above outlives the mis-click.
   *
   * SO: A CONFIRMATION, BUT NOT A MODAL. The step is IN THE ROW — the link swaps
   * for a short question and two small controls in the same slot, same register,
   * same 12px. A modal would be the larger departure: it introduces an overlay,
   * a focus trap and a title this design does not draw anywhere, on a screen
   * whose caution is already carried in COPY ("Use Mark no-show only for edge
   * cases", the design's own sentence). The in-row step costs one extra click on
   * the path that was intended and costs nothing to the merchant who did not mean
   * it — which is exactly the shape the risk has.
   *
   * THE INVENTED COPY IS NAMED AS INVENTED. The design writes no confirmation, so
   * "Return … and mark a no-show?", "Yes, mark" and "Cancel" are this lane's
   * words, not the product's. They are deliberately mechanical rather than in the
   * product's voice, so that if written copy arrives it replaces them cleanly.
   * Reported to trunk.
   *
   * -------------------------------------------------------------------------
   * AND THE ARMING IS WHERE THE `Idempotency-Key` IS MINTED — ONE OBJECT, SO THE
   * KEY AND THE BOOKING CANNOT COME APART.
   * -------------------------------------------------------------------------
   * Non-negotiable #4. The server hashes `{ salonId, bookingId }` into the claim,
   * so a key that reaches a SECOND booking is 422 `idempotency_key_reused`, and a
   * repeat of the SAME mark under the same key is replayed rather than applied
   * twice.
   *
   * The key is minted ON ARMING, which is `console/Salons.tsx`'s rule ("minted on
   * every ENTRY into the review step") with the same reasoning and an easier job:
   *
   *   NOT PER CLICK on the confirm. A double-tapped "Yes, mark" would then be two
   *   keys, and the second would meet `already_no_show` instead of the replay
   *   that header was written for.
   *
   *   NOT PER ROW-MOUNT, and not in `useMarkNoShow`. A key minted inside the
   *   mutation is minted per CALL, which is the same defect one layer down.
   *
   *   AND NOT SHARED. The key lives in the same object as the booking id it was
   *   minted for, so arming a different row REPLACES both together. There is no
   *   state in which a key outlives the booking that minted it — which is the
   *   sibling of the defect lane B found on the scanner's void sheet, where one
   *   key was minted per SHEET while the reason could still change, so a changed
   *   mind after a failure reused a burnt key and earned a 422.
   *
   * WHY A RETRY KEEPS IT. There is no body here, so nothing about the request can
   * change between attempts — the hash is `{ salonId, bookingId }` and both are
   * fixed by the row. A failed attempt does not burn the key either:
   * `markNoShow` claims it as the first statement INSIDE the transaction that
   * carries the effect, so a 409 or a 403 rolls the claim back with everything
   * else. That is why the armed object survives a failure and only a success or a
   * cancel clears it.
   */
  const [armed, setArmed] = useState<{ id: string; key: string } | null>(null);

  /**
   * =========================================================================
   * LIST OR WEEK — AN INVENTED CONTROL, AND THE LIST IS THE DEFAULT
   * =========================================================================
   * THE CONTROL IS INVENTED. The design draws one view of this screen and no
   * view switch; `appointmentsWeekRules.ts` carries the disclosure that there is no
   * calendar anywhere in the bundle. Named here so nobody goes looking for a
   * segmented control on the Appointments artboard.
   *
   * IT JOINS RATHER THAN REPLACES, because the two views answer different
   * questions with different equipment. The list has the DEPOSIT column and
   * MARK NO-SHOW — a `perms.void` write with a confirmation and an idempotency
   * key — and a grid chip that is sometimes fifteen minutes tall has room for
   * neither. The grid answers "what does this week look like", which the list
   * answers badly: `GET /salons/{id}/bookings` is `starts_at DESC`, so the list
   * opens on the FURTHEST-FUTURE bookings and today is somewhere below.
   *
   * AND THE LIST IS THE DEFAULT, WHICH IS THE PART WORTH ARGUING. The grid can
   * decline to draw — an unusable time zone, or a book so far forward that the
   * cursor walk stops before it reaches this week — and both refusals are
   * correct (`appointmentsWeekRules.ts § THE 200 CAP`). A section whose DEFAULT view
   * can answer "not yet" is a section that sometimes greets a merchant with an
   * explanation instead of her appointments. The list has no preconditions: one
   * request, always something on the screen. So the reliable view is the one the
   * door opens on, the richer view is one labelled click away, and every state
   * the grid cannot draw names the list as the way through.
   */
  const [view, setView] = useState<'list' | 'week'>('list');

  /*
   * The module flag decides WHETHER TO ASK, not just what to draw. A salon with
   * booking off has no bookings by construction; asking would answer with an
   * empty list, which is the other empty's evidence. See useSalonBookings().
   *
   * AND THE VIEW GATES IT TOO. The week reads its own paged query, so a merchant
   * who opens the grid should not also pay for a list she is not looking at —
   * and `AppointmentsWeek` is gated the same way from the other side.
   */
  const bookingOn = salon.data?.modules.booking ?? false;
  const listOn = salon.isSuccess && bookingOn && view === 'list';
  const bookings = useSalonBookings(null, listOn);

  /*
   * The salon read gates the module question, so its failure is this section's
   * failure — a 403 on `GET /salons/{id}` is still "you can't", and rendering
   * the table shell around an unknown module state would be a guess.
   *
   * THE LIST'S FAILURE IS ONLY THIS SECTION'S FAILURE WHILE THE LIST IS SHOWN.
   * A disabled query keeps whatever it last errored with, so an unguarded read
   * of `bookings.isError` would let a failure the merchant already navigated
   * away from replace a grid that is loading perfectly well. The week owns its
   * own `SectionError` for its own read.
   */
  const failed = salon.isError ? salon : view === 'list' && bookings.isError ? bookings : null;
  if (failed) {
    return (
      <SectionError
        error={failed.error}
        forbiddenTitle="You don't have access to appointments"
        failedTitle="Couldn't load Appointments"
        onRetry={() => {
          void salon.refetch();
          void bookings.refetch();
        }}
        retrying={salon.isFetching || bookings.isFetching}
      />
    );
  }

  const loading = salon.isPending || (listOn && bookings.isPending);
  const rows = bookings.data?.items ?? [];

  return (
    <div className="appts">
      {/*
        THE SECOND SENTENCE IS BACK, AND ITS ABSENCE WAS CORRECT UNTIL NOW.
        `AVO Merchant Dashboard.dc.html:169` is one sentence in two halves; this
        file shipped only the first, because the second names a control
        ("Use <b>Mark no-show</b> only for edge cases") and the control did not
        exist. Naming a button that is not on the screen is worse than trimming
        the copy — it sends a merchant looking for something she cannot find.
        The link is drawn now, so the sentence is whole. Verbatim, both halves.

        AND THE HOUR IS THE SALON'S HOUR, NOT THE DESIGN'S.
        The design writes `1 hour` into the markup because the bundle has no
        control that could change it. Settings now has one — the merchant picks
        15 minutes / 30 minutes / 1 hour / 2 hours / 4 hours, the server holds
        `noShowReturnMinutes`, and a salon set to 4 hours was still told "1 hour"
        HERE, on the board where she decides whether to mark a customer. A rule
        stated wrong on the screen where it is acted on is worse than not stated.
        `formatReturnWindow` is the SAME function the Settings sentence and its
        option labels use (`routes/noShowWindow.ts`), so the two screens cannot
        drift apart at any value — including the values no preset offers.

        WHAT SHOWS BEFORE THE SALON LANDS: NOTHING. NOT A DEFAULT, NOT HALF A
        SENTENCE.
        The three candidates, and why this one:
          · `?? 60` — renders "1 hour" for every salon and then corrects itself.
            That is the defect this change exists to remove, kept and given a
            shorter lifetime. A merchant who reads the strip and navigates on has
            read a wrong claim about her customers' money; that it was going to
            be right a moment later is no defence.
          · The sentence with the duration skeletoned — no reflow, but it leaves
            a screen reader with "…returns to the customer's wallet after a
            missed slot", a grammatical sentence stating a DIFFERENT rule, and
            `.avo-skeleton` is `display:block` so it would need an inline variant
            invented for one word.
          · Not rendering until `salon.isSuccess` — this. The strip is standing
            prose, not a data surface: there is no figure to hold a place for,
            and interaction-spec §4's skeleton rule is about the data a screen
            waits on. The reflow objection is real but small here — the table
            below is skeletoned at the same moment, so nothing on the page looks
            settled yet, which is not the case the Overview reflow fix was about
            (a card that grew a row AFTER it appeared finished).
        `salon.isError` never reaches this line: `SectionError` returned above.
      */}
      {salon.isSuccess ? (
        <InfoBanner icon={<ClockGlyph />}>
          Deposits auto-return to the customer&rsquo;s wallet{' '}
          <b>{formatReturnWindow(salon.data.noShowReturnMinutes)}</b> after a missed slot — the
          money never leaves the ecosystem. Use <b>Mark no-show</b> only for edge cases.
        </InfoBanner>
      ) : null}

      {/*
        THE VIEW SWITCH, AND IT IS NOT DRAWN OVER THE SWITCHED-OFF EMPTY.
        A salon with `modules.booking` off has no bookings in either shape, so
        offering a choice of two ways to look at none of them is a control with
        nothing behind it — and it would sit above copy whose whole job is to
        name the ONE action that resolves the state.

        It IS drawn while the salon is still loading, so the row does not appear
        underneath a card that already looks settled — the Overview's reflow
        lesson, applied to a control rather than to a figure.
      */}
      {salon.isSuccess && !bookingOn ? null : (
        <div className="appts__views">
          <Segmented
            label="Appointments view"
            value={view}
            onChange={setView}
            options={[
              { value: 'list', label: 'List' },
              { value: 'week', label: 'Week' },
            ]}
          />
        </div>
      )}

      {/*
        THE SWITCHED-OFF EMPTY. Its own copy, its own tone, and the one action
        that resolves it. It replaces the table rather than sitting inside it:
        an empty table with headers says "we looked and found none", which is
        the other empty's sentence.
      */}
      {salon.isSuccess && !bookingOn ? (
        <Card className="appts__off">
          <EmptyState
            title="Booking is switched off"
            body="Turn it on in Settings and your team's hours become bookable. Nothing changes for existing customers."
            action={{ label: 'Open Settings', onClick: () => void navigate({ to: '/settings' }) }}
          />
        </Card>
      ) : view === 'week' ? (
        /*
          The grid owns its own reads, its own four states and its own refusal to
          draw a week it cannot vouch for. `onShowList` is the way back that
          every one of those refusals offers — the list has no preconditions.
        */
        <AppointmentsWeek onShowList={() => setView('list')} />
      ) : (
        <Card className="appts__card" flush>
          <div className="appts__scroll">
            <table className="appts__table">
              <caption className="avo-sr-only">
                Every booking and its deposit status, newest first.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Customer</th>
                  <th scope="col">Service</th>
                  <th scope="col">Artist</th>
                  <th scope="col">When</th>
                  <th scope="col">Deposit</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  [0, 1, 2, 3, 4, 5].map((n) => (
                    <tr key={n}>
                      {[0, 1, 2, 3, 4, 5].map((c) => (
                        <td key={c}>
                          <Skeleton width={`${80 - c * 7}%`} height={13} />
                        </td>
                      ))}
                    </tr>
                  ))
                ) : rows.length === 0 ? (
                  /*
                    THE NOTHING-BOOKED-YET EMPTY. Reached only when the module is
                    ON and the server genuinely returned no rows.
                  */
                  <tr>
                    <td colSpan={6} className="appts__empty">
                      <EmptyState
                        title="No appointments this week"
                        body="Bookings from the customer app land here as soon as they're made."
                      />
                    </td>
                  </tr>
                ) : (
                  rows.map((booking) => (
                    <BookingRow
                      key={booking.id}
                      booking={booking}
                      canMark={canMarkNoShow(booking, session.perms, Date.now())}
                      armed={armed?.id === booking.id}
                      marking={mark.isPending && armed?.id === booking.id}
                      /*
                        SCOPED TO THE ARMED ROW. One mutation serves the whole
                        board, so an unscoped `mark.error` would draw the last
                        failure under every row — including rows the merchant
                        never touched.
                      */
                      markError={armed?.id === booking.id ? mark.error : null}
                      onArm={() => {
                        // A previous row's failure is not this row's news.
                        mark.reset();
                        setArmed({ id: booking.id, key: crypto.randomUUID() });
                      }}
                      onCancel={() => {
                        mark.reset();
                        setArmed(null);
                      }}
                      onConfirm={() => {
                        if (!armed || armed.id !== booking.id) return;
                        mark.mutate(
                          { bookingId: booking.id, idempotencyKey: armed.key },
                          // Cleared on success ONLY. A failure keeps the row
                          // armed AND keeps its key, so the retry is a retry.
                          { onSuccess: () => setArmed(null) },
                        );
                      }}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

/**
 * EXPORTED FOR THE RENDER TEST, on `ShopOrders.tsx § OrderRow`'s precedent and
 * for its reason: the guarantees below are about what a merchant READS and what
 * a click actually does, and neither survives a source scan.
 *
 * PRESENTATIONAL. It owns one piece of state — nothing; the armed row and the
 * key live in `Appointments` above, because the key is a money concern and a row
 * that minted its own would mint one per mount.
 */
export function BookingRow({
  booking,
  canMark,
  armed,
  marking,
  markError,
  onArm,
  onCancel,
  onConfirm,
}: {
  booking: MerchantBooking;
  canMark: boolean;
  armed: boolean;
  marking: boolean;
  markError: unknown;
  onArm: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const pill = STATUS_PILL[booking.status];

  return (
    <tr>
      <td>
        <div className="appts__customer">{booking.memberName}</div>
        {/*
          `branchAssumed` — the branch was a guess. Same marker a transaction
          carries, surfaced for the same reason: a per-branch count resting on a
          guess should be visible as one.
        */}
        {booking.branchAssumed ? <div className="appts__assumed">Branch assumed</div> : null}
      </td>
      <td className="appts__muted">{booking.serviceName}</td>
      <td className="appts__muted">
        {booking.artistName}
        {/*
          A booking the artist's calendar never received. The salon needs to see
          this one — the artist is not expecting the customer.
        */}
        {booking.calendarSyncState === 'failed' ? (
          <div className="appts__syncfail">Not on their calendar</div>
        ) : null}
      </td>
      <td className="appts__when">
        <time dateTime={booking.startsAt} title={new Date(booking.startsAt).toISOString()}>
          {whenLabel(booking.startsAt)}
        </time>
        {booking.rescheduledCount > 0 ? (
          <div className="appts__moved">
            Moved {booking.rescheduledCount === 1 ? 'once' : `${booking.rescheduledCount} times`}
          </div>
        ) : null}
      </td>
      {/*
        Non-negotiable #1 — integer fils through `formatMoney`, three decimals,
        Western digits. `parseFils` is the branding boundary: the wire number is
        a plain integer until it is asserted to be one.
      */}
      <td className="appts__deposit">
        {/*
          `<Money>` RATHER THAN `formatMoney`, and the visible string is
          unchanged: both render "5.000 KD". What the component adds is the half
          `formatMoney` cannot — `moneyAriaLabel` on the wrapper and
          `aria-hidden` on the glyphs, so this cell announces "5.000 Kuwaiti
          dinars" instead of letting a screen reader read "five thousand" off the
          digits. interaction-spec.md §2 calls that not optional; this cell had
          the formatter and not the label.
        */}
        <Money amount={parseFils(booking.depositFils)} withUnit />
      </td>
      <td>
        <div className="appts__status">
          <Pill tone={pill.tone}>{pill.label}</Pill>
          {/*
            The auto-return rule, stated inline against the booking it applies
            to. The banner states the rule; this states the deadline, and the
            server computed it — a client doing `startsAt + 1h` would be deciding
            for itself when a deposit is at risk.
          */}
          {booking.status === 'deposit_held' ? (
            <span className="appts__due">
              Returns{' '}
              <time dateTime={booking.noShowReturnDueAt}>
                {whenLabel(booking.noShowReturnDueAt)}
              </time>{' '}
              if missed
            </span>
          ) : null}

          {/*
            THE DESIGN'S LINK — AS A `<button>`, WHICH IS THE ONE THING ABOUT IT
            THAT IS NOT THE DESIGN'S.

            `:184` is `<a href="#2a">`, which is what a static mock writes for
            every affordance because it has nowhere to go. This one goes nowhere
            either: it POSTs. An anchor that does not navigate is a control a
            keyboard user reaches with the wrong key, a screen reader announces
            as "link", and a middle-click opens in a tab where nothing happens.
            CLAUDE.md's own rule for this case — follow the platform, note the
            departure. Everything visual stays: 12px, `--avo-text-muted-soft`,
            the exact colour `:184` names, beside the pill in the same slot.

            THE ACCESSIBLE NAME CARRIES THE CUSTOMER. "Mark no-show" repeated
            down a column of rows is a list of identical controls to anyone not
            looking at the row it is in. The visible text is unchanged, so
            "Label in Name" holds: the accessible name still starts with what is
            drawn.
          */}
          {canMark && !armed ? (
            <button
              type="button"
              className="appts__mark"
              aria-label={`Mark no-show for ${booking.memberName}`}
              onClick={onArm}
            >
              Mark no-show
            </button>
          ) : null}

          {/*
            THE ARMED STEP. `Appointments § the armed row` argues why it exists
            and why it is not a modal. The money is `<Money>` — integer fils
            through the one formatter, with the announced string that is not the
            drawn one (#1, interaction-spec.md §2). It states the AMOUNT and the
            CONSEQUENCE, because the two things a merchant can get wrong here are
            "which row" and "how much".
          */}
          {armed ? (
            <span className="appts__confirm">
              <span className="appts__confirm-q">
                Return <Money amount={parseFils(booking.depositFils)} withUnit /> to{' '}
                {booking.memberName} and mark a no-show?
              </span>
              <span className="appts__confirm-acts">
                <button
                  type="button"
                  className="appts__confirm-yes"
                  aria-label={`Yes, mark ${booking.memberName} as a no-show`}
                  onClick={onConfirm}
                  disabled={marking}
                >
                  {marking ? 'Marking…' : 'Yes, mark'}
                </button>
                <button
                  type="button"
                  className="appts__confirm-no"
                  onClick={onCancel}
                  disabled={marking}
                >
                  Cancel
                </button>
              </span>
            </span>
          ) : null}

          {/*
            THE FAILED WRITE, IN THE ROW IT FAILED ON.

            `WriteError` rather than `SectionError`: a refused mark is not a
            refused screen, and the distinction `sectionState.tsx` draws is
            exactly the one a merchant needs here — the board is still correct,
            the deposit is still held, and one action did not happen.

            IN THE CELL AND NOT OVER THE TABLE. A board-level banner saying "that
            didn't work" cannot say WHICH booking, and this is a screen whose
            rows are indistinguishable at a glance.

            THE REASSURANCE IS THE SENTENCE THAT MATTERS. Every refusal on this
            path leaves the deposit exactly where it was — the 403, the two
            409s, the 400, the 422, and a connection that died mid-flight, which
            `markNoShow`'s single transaction guarantees for the last one. So one
            reassurance is honest for all of them.

            AND THE 403 IS BUILT EVEN THOUGH THE LINK IS GATED. #7 in its own
            words: the UI hiding a button is a courtesy, not a control. The
            reachable path is a mid-session revocation — `perms.void` taken away
            in Accounts while this board is open — and the session's copy of
            `perms` is the one that was true at sign-in. `WriteError` renders the
            server's own sentence, which names the permission and who can grant
            it; paraphrasing it here would drop the second half.
          */}
          {markError ? (
            <WriteError error={markError} reassurance="The deposit is still held." />
          ) : null}
        </div>
      </td>
    </tr>
  );
}

function ClockGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M10 6v4l2.5 1.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
