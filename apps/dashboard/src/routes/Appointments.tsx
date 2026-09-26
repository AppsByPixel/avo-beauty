import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { parseFils, type StaffPerms } from '@avo/types';
import { Button, Card, EmptyState, InfoBanner, Money, Pill, Segmented, Select, Skeleton, TextField } from '@avo/ui';
import {
  isSlotTaken,
  useCancelBooking,
  useCompleteBooking,
  useMarkNoShow,
  useReassignArtist,
  useRescheduleBooking,
  useSalonBookings,
  type MerchantBooking,
} from '../api/bookings.js';
import { useBookableArtists } from '../api/artists.js';
import { useSalon } from '../api/salon.js';
import { useSession } from '../auth/AuthProvider.js';
import { AppointmentForm } from './AppointmentForm.js';
import { AppointmentsWeek } from './AppointmentsWeek.js';
import { instantFromSalonLocal, pillFor, salonLocalFields } from './appointmentsWeekRules.js';
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

/* ================================================= the other four controls == */

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CHANGE DATE/TIME · REASSIGN · CANCEL · MARK DONE — WHAT IS DRAWN, AND WHY
 * DRAWING IT IS NOT THE ENFORCEMENT
 * ═══════════════════════════════════════════════════════════════════════════
 * NON-NEGOTIABLE #7 IN ITS OWN WORDS: the UI hiding a button is a courtesy, not
 * a control. Every predicate below is mirrored by a server-side gate that
 * refuses independently, and the refusal is BUILT AND RENDERED — not assumed
 * unreachable. The reachable path is not exotic: `session.perms` is the snapshot
 * taken at sign-in, so a permission revoked in Accounts lands on a board that is
 * already open and still drawing the link.
 *
 * TWO PERMISSIONS, NOT ONE, AND THE SPLIT IS THE SEEDED FRONT DESK.
 * `api/src/routes/bookings.ts § THE PERMISSION IS appointments` argues it at
 * length: create, reschedule, reassign and complete move no money and assert
 * nothing about a customer's conduct, so they sit behind `perms.appointments`;
 * cancel returns a real deposit on an app booking, so it sits behind
 * `perms.void` beside no-show. `db/seed.ts § ST-002` is Hessa, frontdesk —
 * `appointments: true`, `void: false`, `dashboard: false`. She should be able to
 * move a 16:45 and hand it to another artist. She must not be able to return a
 * deposit.
 *
 * ALL FOUR NEED `deposit_held`, WHICH IS THIS ENUM'S WORD FOR "LIVE" AND NOT A
 * STATEMENT ABOUT MONEY. `lockLiveBooking` re-reads the status under `FOR UPDATE`
 * and answers `not_changeable` / `not_cancellable` / `not_completable` by name on
 * anything else, so offering a control on a completed row offers a 409.
 * `packages/types § BookingSchema.status` is the reason that sentence needs
 * saying twice: on a hand-written appointment `deposit_held` means the slot is
 * booked and nothing is held.
 *
 * `canComplete` CARRIES THE ONE EXTRA CONDITION, AND IT IS A CONDITION ABOUT
 * MONEY. `completeBooking` refuses a booking with a hold against it — 409
 * `deposit_completed_at_the_counter` — because completing a deposit-bearing
 * appointment has to name the charge that CONSUMED the hold, and that happens at
 * the scanner through `POST /charges`. `completed` is written in exactly one
 * place in the whole API and it is inside the charge transaction. A second path
 * would mark an appointment done without the bill that made it done.
 *
 * THE CLIENT'S PROXY FOR "HAS A HOLD" IS `depositFils > 0`, AND THE IMPLICATION
 * RUNS THE DIRECTION THE COURTESY NEEDS. The server's condition is
 * `hold_transaction_id IS NOT NULL`, which the board is not served. A row at 0
 * cannot have a hold — there is no transaction that holds nothing — so
 * `depositFils === 0` implies the server will allow it, which is exactly what is
 * required to offer the control honestly. The reverse is the server's business
 * and it has the row.
 */
export function canReschedule(
  booking: Pick<MerchantBooking, 'status'>,
  perms: Pick<StaffPerms, 'appointments'>,
): boolean {
  return perms.appointments && booking.status === 'deposit_held';
}

export function canReassign(
  booking: Pick<MerchantBooking, 'status'>,
  perms: Pick<StaffPerms, 'appointments'>,
): boolean {
  return perms.appointments && booking.status === 'deposit_held';
}

export function canCancel(
  booking: Pick<MerchantBooking, 'status'>,
  perms: Pick<StaffPerms, 'void'>,
): boolean {
  return perms.void && booking.status === 'deposit_held';
}

export function canComplete(
  booking: Pick<MerchantBooking, 'status' | 'depositFils'>,
  perms: Pick<StaffPerms, 'appointments'>,
): boolean {
  if (!perms.appointments) return false;
  if (booking.status !== 'deposit_held') return false;
  return booking.depositFils === 0;
}

/** Which in-row step a row has open. One at a time, across the whole board. */
export type ControlKind = 'reschedule' | 'reassign' | 'cancel' | 'complete';

export interface RowControls {
  can: Record<ControlKind, boolean>;
  /** The step THIS row has open, or `null`. */
  open: ControlKind | null;
  pending: boolean;
  error: unknown;
  /** The roster for the reassign step. Empty while the read is in flight. */
  artists: ReadonlyArray<{ id: string; name: string }>;
  /**
   * The salon's zone, or `null` where it is not known or not usable. The
   * reschedule step is not offered without one — see `RescheduleStep`.
   */
  timezone: string | null;
  onOpen: (kind: ControlKind) => void;
  onDismiss: () => void;
  onReschedule: (startsAt: string) => void;
  onReassign: (artistId: string) => void;
  onCancel: () => void;
  onComplete: () => void;
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
   * THE OTHER FOUR CONTROLS — ONE OPEN STEP ACROSS THE WHOLE BOARD
   * =========================================================================
   * `{ id, kind }` rather than a per-row state, for the armed row's reason and
   * one more. The shared reason: a control's state and the booking it is about
   * must not be able to come apart, so they live in one object and opening
   * anything replaces both. The extra one: a table whose rows shift under a
   * refetch should not be able to have three half-filled forms open in it at
   * once, each one a control a merchant might complete against the wrong row.
   *
   * NO IDEMPOTENCY KEY ON ANY OF THE FOUR, and that is the server's shape rather
   * than an omission here. `api/src/routes/bookings.ts § IDEMPOTENCY` is
   * explicit: these four name ONE resource with ONE live state and rely on
   * `FOR UPDATE` — a second request blocks on the row lock, re-reads a status
   * that is no longer `deposit_held`, and is answered `already_cancelled` /
   * `already_completed` / `not_changeable`. That is stronger than a key, because
   * it holds for two DIFFERENT keys as well as for one repeated. The CREATE is
   * the one that takes a key, and `AppointmentForm.tsx § submissionKey` owns it.
   */
  const [open, setOpen] = useState<{ id: string; kind: ControlKind } | null>(null);
  const [adding, setAdding] = useState(false);

  const reschedule = useRescheduleBooking();
  const reassign = useReassignArtist();
  const cancelBooking = useCancelBooking();
  const complete = useCompleteBooking();

  /*
   * THE ROSTER FOR THE REASSIGN STEP, AND IT IS ONLY ASKED FOR WHEN ONE IS OPEN.
   * A board of 25 rows does not need the team list to draw itself, and firing
   * the request on mount would make every visit to Appointments a second
   * request against an endpoint this screen has no other use for.
   */
  /*
   * THE BOOKABLE ROSTER, NOT THE TEAM ROSTER, AND THAT IS A PERMISSION
   * DIFFERENCE RATHER THAN A FIELD ONE. `GET /salons/{id}/artists` is
   * `perms.team`; this board's own gate is `perms.appointments`, and the seeded
   * front desk (ST-002 Hessa) holds the second and not the first. Reassigning
   * IS hers to do, so the list she picks from has to be one she may read.
   * `api/artists.ts § useBookableArtists` carries it, including the second
   * reason: it serves ACTIVE artists, and `reassignArtist` refuses an inactive
   * one by name (409 `artist_not_bookable`).
   */
  const artists = useBookableArtists(open?.kind === 'reassign');

  const writes = { reschedule, reassign, cancel: cancelBooking, complete } as const;
  const active = open ? writes[open.kind] : null;

  /** Every one of the four resets together: a previous step's failure is not this step's news. */
  const resetWrites = () => {
    reschedule.reset();
    reassign.reset();
    cancelBooking.reset();
    complete.reset();
  };

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
          {/*
            "+ ADD APPOINTMENT" — `Accounts.tsx`'s "+ Add teammate" affordance,
            same shape and same place: a Button beside the list's own controls
            that reveals a bordered card ABOVE the table.

            UP HERE RATHER THAN IN THE GRID, and that is forced rather than
            chosen. `AppointmentsWeek.tsx`'s own header calls the grid body a
            documented read-only zone — the chip is an `<li>` with no handlers,
            because a cell that is sometimes fifteen minutes tall has room for
            neither a control nor a confirmation. Hoisting the affordance to the
            screen is what makes it reachable from BOTH views.

            THE COURTESY GATE IS `perms.appointments`, which is the read gate
            this board already passed, so it hides the button from nobody who can
            see the screen — and it is written anyway rather than omitted,
            because a mid-session revocation is the case #7 is about and the
            permission this endpoint checks is a fact about the endpoint, not an
            inference from the board.

            NOT DRAWN WHILE THE FORM IS OPEN. The card below IS the affordance
            once it exists; a second "Add appointment" above an open Add
            appointment form is a control with nothing left to do.
          */}
          {session.perms.appointments && !adding ? (
            <Button
              variant="secondary"
              onClick={() => setAdding(true)}
              disabled={salon.isPending}
            >
              + Add appointment
            </Button>
          ) : null}
        </div>
      )}

      {/*
        THE FORM NEEDS THE SALON'S ZONE AND WILL NOT GUESS ONE. A merchant types
        a wall clock; the endpoint takes an instant; `instantFromSalonLocal` is
        the only honest bridge and it needs an IANA id. `salon.isSuccess` is what
        guarantees there is one — and the error and pending answers for that read
        are already `SectionError` and the skeleton above, so there is no third
        state to invent here.
      */}
      {adding && salon.isSuccess && bookingOn ? (
        <AppointmentForm
          timezone={salon.data.timezone}
          canSearchDirectory={session.perms.team}
          onClose={() => setAdding(false)}
          onCreated={() => setAdding(false)}
        />
      ) : null}

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
                      controls={{
                        can: {
                          reschedule: canReschedule(booking, session.perms),
                          reassign: canReassign(booking, session.perms),
                          cancel: canCancel(booking, session.perms),
                          complete: canComplete(booking, session.perms),
                        },
                        open: open?.id === booking.id ? open.kind : null,
                        pending: open?.id === booking.id && (active?.isPending ?? false),
                        /*
                          SCOPED TO THE OPEN ROW, for the armed row's reason: one
                          mutation of each kind serves the whole board, so an
                          unscoped error would draw the last failure under every
                          row — including rows the merchant never touched.
                        */
                        error: open?.id === booking.id ? (active?.error ?? null) : null,
                        artists: artists.data?.items ?? [],
                        timezone: salon.data?.timezone ?? null,
                        onOpen: (kind) => {
                          mark.reset();
                          resetWrites();
                          setArmed(null);
                          setOpen({ id: booking.id, kind });
                        },
                        onDismiss: () => {
                          resetWrites();
                          setOpen(null);
                        },
                        /*
                          CLEARED ON SUCCESS ONLY, all four. A failure keeps the
                          step open with what the merchant typed still in it —
                          which is the whole difference between a retry and a
                          re-entry, and `slot_taken` is a refusal she is meant to
                          act on by changing one field and pressing again.
                        */
                        onReschedule: (startsAt) =>
                          reschedule.mutate(
                            { bookingId: booking.id, startsAt },
                            { onSuccess: () => setOpen(null) },
                          ),
                        onReassign: (artistId) =>
                          reassign.mutate(
                            { bookingId: booking.id, artistId },
                            { onSuccess: () => setOpen(null) },
                          ),
                        onCancel: () =>
                          cancelBooking.mutate(
                            { bookingId: booking.id },
                            { onSuccess: () => setOpen(null) },
                          ),
                        onComplete: () =>
                          complete.mutate(
                            { bookingId: booking.id },
                            { onSuccess: () => setOpen(null) },
                          ),
                      }}
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
                        // …and neither is another row's open step. One at a time.
                        resetWrites();
                        setOpen(null);
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
  controls,
  canMark,
  armed,
  marking,
  markError,
  onArm,
  onCancel,
  onConfirm,
}: {
  booking: MerchantBooking;
  controls: RowControls;
  canMark: boolean;
  armed: boolean;
  marking: boolean;
  markError: unknown;
  onArm: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  /**
   * ═════════════════════════════════════════════════════════════════════════
   * `pillFor`, NOT `STATUS_PILL[status]` — AND THE DIFFERENCE IS A CLAIM ABOUT
   * A CUSTOMER'S MONEY
   * ═════════════════════════════════════════════════════════════════════════
   * Two of the four status values name a money event that a hand-written
   * appointment never had. At `depositFils === 0` the labels are "Booked" and
   * "No-show"; `appointmentsWeekRules.ts § pillFor` carries the full argument
   * and the reason the words are lane B's rather than a third vocabulary.
   *
   * A DEPOSIT-BEARING ROW IS UNCHANGED, byte for byte. `pillFor` returns
   * `STATUS_PILL[status]` untouched above zero, which is the property
   * `zeroDepositRender.test.tsx` pins in both directions.
   */
  const pill = pillFor(booking);

  /**
   * THE ROW'S DEPOSIT, ASKED ONCE. Every sentence in this cell that mentions a
   * deposit has to agree with it, and the way they drift apart is each one
   * re-deriving the condition. #1 keeps it an integer comparison and never a
   * formatted string.
   */
  const held = booking.depositFils > 0;

  /**
   * A WALK-IN. `GET /salons/{id}/bookings` serves the front desk's own
   * `guest_name` AS `memberName` — one field, one meaning, "who is this
   * appointment for" — so the name is already drawn and this adds only the fact
   * that there is no account behind it.
   *
   * WHICH THE FRONT DESK NEEDS AND CANNOT OTHERWISE SEE. A member can be looked
   * up, messaged, and has a wallet and a tier; a walk-in has a line in a diary
   * and a phone number that was typed in. Telling them apart is the difference
   * between "open her card" and "there is no card".
   *
   * `memberId === null` IS THE TEST, NOT `source === 'merchant'`.
   * `booking_identity_exactly_one` makes the first exact — `guest_name` is
   * non-null exactly when `member_id` is null. The second is a fact about who
   * typed it: a merchant may write an appointment down for an EXISTING member,
   * and that row has an account and must not be marked as having none.
   */
  const walkIn = booking.memberId === null;

  return (
    <tr>
      <td>
        <div className="appts__customer">{booking.memberName}</div>
        {walkIn ? <div className="appts__assumed">Walk-in · no account</div> : null}
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
          {/*
            AND `held` RATHER THAN THE STATUS ALONE, WHICH IS THE PILL'S FIX
            APPLIED TO THE SENTENCE UNDERNEATH IT.

            This line said "Returns <date> if missed" on every `deposit_held`
            row, including a hand-written one where nothing is held and nothing
            returns. It is the same false claim the pill made, one line lower and
            with a DATE on it — so it does not merely mislabel a state, it
            promises a merchant a specific moment at which a customer's money
            will move. `noShowReturnDueAt` is still served on those rows (the
            server computes it for every booking), which is exactly why the
            status was not a sufficient condition: there is a real timestamp
            sitting there, and it is about nothing.
          */}
          {booking.status === 'deposit_held' && held ? (
            <span className="appts__due">
              Returns{' '}
              <time dateTime={booking.noShowReturnDueAt}>
                {whenLabel(booking.noShowReturnDueAt)}
              </time>{' '}
              if missed
            </span>
          ) : null}

          {/*
            ═══════════════════════════════════════════════════════════════
            THE FOUR CONTROLS — IN THE SAME SLOT, IN THE SAME REGISTER
            ═══════════════════════════════════════════════════════════════
            NOT A SEVENTH COLUMN. The design draws six and
            `interaction-spec.md §1` says a data table scrolls rather than
            dropping one; adding a column would push the board past its
            `min-width` on every screen to hold controls that are blank on most
            rows. The status cell is already "what state is this in", and what
            you may do about it is the same question.

            THE SHAPE IS THE NO-SHOW LINK'S, WHICH THIS FILE ALREADY ARGUED:
            a 12px link-styled `<button>`, and the link SWAPS for a short step in
            the same slot rather than opening a modal. That decision is recorded
            at § the armed row and it holds for all five controls — an overlay,
            a focus trap and a title this design draws nowhere, for a form with
            one or two fields.

            ONE STEP AT A TIME ACROSS THE BOARD, so the links disappear while any
            step is open on this row. Four half-filled steps in a table whose
            rows shift under a refetch is four chances to complete a control
            against the wrong appointment.

            EVERY ONE OF THESE IS A COURTESY (#7). The predicates above mirror
            server gates that refuse independently, and the refusal is rendered
            below rather than assumed unreachable.
          */}
          {controls.open === null && !armed ? (
            <span className="appts__acts">
              {controls.can.reschedule && controls.timezone !== null ? (
                <button
                  type="button"
                  className="appts__mark"
                  aria-label={`Change the date or time for ${booking.memberName}`}
                  onClick={() => controls.onOpen('reschedule')}
                >
                  Change time
                </button>
              ) : null}
              {controls.can.reassign ? (
                <button
                  type="button"
                  className="appts__mark"
                  aria-label={`Reassign ${booking.memberName} to another artist`}
                  onClick={() => controls.onOpen('reassign')}
                >
                  Reassign
                </button>
              ) : null}
              {/*
                "MARK DONE" AND NOT "COMPLETE", and the divergence is the
                scanner's own argument run the other way. `completed` is the
                merchant's neutral word for a column that also holds "Cancelled"
                — which is why the PILL says "Completed" — but the CONTROL is an
                imperative a receptionist presses, and "Mark done" sits beside
                "Mark no-show" as the pair it actually is.
              */}
              {controls.can.complete ? (
                <button
                  type="button"
                  className="appts__mark"
                  aria-label={`Mark ${booking.memberName}'s appointment as done`}
                  onClick={() => controls.onOpen('complete')}
                >
                  Mark done
                </button>
              ) : null}
              {controls.can.cancel ? (
                <button
                  type="button"
                  className="appts__mark"
                  aria-label={`Cancel ${booking.memberName}'s appointment`}
                  onClick={() => controls.onOpen('cancel')}
                >
                  Cancel appointment
                </button>
              ) : null}
            </span>
          ) : null}

          {controls.open === 'reschedule' && controls.timezone !== null ? (
            <RescheduleStep
              booking={booking}
              timezone={controls.timezone}
              pending={controls.pending}
              onSubmit={controls.onReschedule}
              onDismiss={controls.onDismiss}
            />
          ) : null}

          {controls.open === 'reassign' ? (
            <ReassignStep
              booking={booking}
              artists={controls.artists}
              pending={controls.pending}
              onSubmit={controls.onReassign}
              onDismiss={controls.onDismiss}
            />
          ) : null}

          {/*
            CANCEL AND MARK DONE ARE ARM-THEN-CONFIRM, for the no-show's reasons
            minus one. Neither can be undone — there is no un-cancel and no
            un-complete route — and cancel RELEASES THE SLOT, so the artist's
            hour is bookable from the wallet the instant it commits.

            CANCEL STATES THE MONEY AND "MARK DONE" DOES NOT, because there is a
            deposit to state on one and there is provably none on the other:
            `canComplete` is false above zero. The cancel question therefore
            branches on `held` — "Cancel and return 5.000 KD to Dana?" on an app
            booking, and a sentence with no money in it on a hand-written one,
            where "return" would name a refund that does not exist.
          */}
          {controls.open === 'cancel' ? (
            <ConfirmStep
              question={
                held ? (
                  <>
                    Cancel this appointment and return{' '}
                    <Money amount={parseFils(booking.depositFils)} withUnit /> to{' '}
                    {booking.memberName}?
                  </>
                ) : (
                  <>Cancel this appointment for {booking.memberName}? No deposit was taken.</>
                )
              }
              confirmLabel="Yes, cancel"
              pendingLabel="Cancelling…"
              confirmAria={`Yes, cancel ${booking.memberName}'s appointment`}
              pending={controls.pending}
              onConfirm={controls.onCancel}
              onDismiss={controls.onDismiss}
            />
          ) : null}

          {controls.open === 'complete' ? (
            <ConfirmStep
              question={<>Mark {booking.memberName}&rsquo;s appointment as done?</>}
              confirmLabel="Yes, mark done"
              pendingLabel="Marking…"
              confirmAria={`Yes, mark ${booking.memberName}'s appointment as done`}
              pending={controls.pending}
              onConfirm={controls.onComplete}
              onDismiss={controls.onDismiss}
            />
          ) : null}

          {/*
            THE FOUR CONTROLS' OWN REFUSAL, IN THE ROW IT FAILED ON.

            `slot_taken` IS SINGLED OUT AND IS NOT AN ERROR TOAST. The exclusion
            constraint spans hand-written and app bookings deliberately, so this
            is the ordinary answer when a customer took that hour from her phone
            while the front desk was typing — and it is RECOVERABLE. The server's
            sentence states the fact and names no remedy; the remedy differs by
            control, so this screen supplies it: a reschedule's way out is a
            different time, a reassign's is a different artist. The step stays
            open with what she typed still in it.

            EVERYTHING ELSE GOES THROUGH `WriteError`, which renders the server's
            own sentence verbatim for a 400, a 409 and a 403 — `not_changeable`,
            `already_cancelled`, `deposit_completed_at_the_counter` and the
            permission refusal all name what happened and what to do, and a
            paraphrase here would drop the second half.

            THE REASSURANCE BRANCHES ON `held` FOR THE THIRD TIME IN THIS CELL.
            "The deposit is still held" is true on an app booking and a lie on a
            hand-written one; "Nothing has changed" is true of both but says less
            where there is more to say.
          */}
          {controls.error !== null && controls.error !== undefined ? (
            isSlotTaken(controls.error) ? (
              <div className="appts__slot" role="alert">
                <b>That artist already has an appointment then.</b>{' '}
                {controls.open === 'reassign'
                  ? 'Pick a different artist, or move the time first.'
                  : 'Pick another time.'}{' '}
                This appointment has not moved.
              </div>
            ) : (
              <WriteError
                error={controls.error}
                reassurance={held ? 'The deposit is still held.' : 'Nothing has changed.'}
              />
            )
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
          {canMark && !armed && controls.open === null ? (
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

            AND AT ZERO THERE IS NO AMOUNT AND NO RETURN, WHICH THIS SENTENCE
            USED TO ASSERT ANYWAY. Lane A ruled that a no-show is a fact about
            ATTENDANCE rather than about money, so a hand-written appointment is
            markable too — and on that row `<Money>` rendered "0.000 KD" inside
            the word "Return", offering to send a customer nothing and calling it
            a refund. The `markNoShow` response now carries `balanceAfterFils` and
            `transactionId` as `null` on that branch for the same reason, and the
            endpoint's own terminal copy stopped promising a refund.

            THE CONSEQUENCE IS STILL STATED, because it is the half that has not
            gone away: the mark is an assertion about a named customer's conduct,
            written to her record, and it releases the slot. What is withdrawn is
            only the claim about the money.
          */}
          {armed ? (
            <span className="appts__confirm">
              <span className="appts__confirm-q">
                {held ? (
                  <>
                    Return <Money amount={parseFils(booking.depositFils)} withUnit /> to{' '}
                    {booking.memberName} and mark a no-show?
                  </>
                ) : (
                  <>
                    Mark {booking.memberName} as a no-show? No deposit was taken, so nothing
                    comes back.
                  </>
                )}
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

            AND THE REASSURANCE BRANCHES, FOR THE PILL'S REASON ONE LAST TIME.
            "The deposit is still held" was written when a no-show was a money
            transition by definition; on a hand-written appointment it names a
            hold that does not exist, under a failure, which is the worst moment
            to tell a merchant something reassuring and false. "Nothing has
            changed" is true of every refusal on this path either way — the
            single transaction guarantees it — and it is the honest version where
            there is no deposit to be still holding.
          */}
          {markError ? (
            <WriteError
              error={markError}
              reassurance={held ? 'The deposit is still held.' : 'Nothing has changed.'}
            />
          ) : null}
        </div>
      </td>
    </tr>
  );
}

/* =================================================== the three in-row steps == */

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CHANGE DATE/TIME. TWO FIELDS, SEEDED FROM THE HOUR IT IS MOVING FROM.
 * ═══════════════════════════════════════════════════════════════════════════
 * SEEDED, NOT BLANK, and that is not a convenience. "Move it fifteen minutes" is
 * the common case, and a blank date field makes it a two-field transcription
 * with a real chance of getting the DAY wrong — which is an appointment on a
 * different day, not an error. `salonLocalFields` reads the row's own instant
 * back into the salon's wall clock, so what the merchant sees first is the hour
 * that is actually on the board.
 *
 * THE ZONE IS THE SALON'S AND IT IS NAMED ON THE FIELD. `instantFromSalonLocal`
 * carries the argument; the short version is that `new Date('2026-09-20T16:45')`
 * parses in the BROWSER's zone, so a manager in London would move a Kuwait
 * appointment three hours without being told.
 *
 * `same_slot` IS THE SERVER'S ANSWER TO SUBMITTING THE HOUR IT IS ALREADY AT —
 * 400, "That is the time the appointment is already at." Not pre-empted here:
 * it is a sentence, it is correct, and a client-side equality check is one more
 * place for the zone arithmetic to be done twice and disagree once.
 */
function RescheduleStep({
  booking,
  timezone,
  pending,
  onSubmit,
  onDismiss,
}: {
  booking: MerchantBooking;
  timezone: string;
  pending: boolean;
  onSubmit: (startsAt: string) => void;
  onDismiss: () => void;
}) {
  const seed = salonLocalFields(booking.startsAt, timezone);
  const [date, setDate] = useState(seed?.date ?? '');
  const [time, setTime] = useState(seed?.time ?? '');
  const [invalid, setInvalid] = useState(false);

  return (
    <span className="appts__step">
      <span className="appts__step-fields">
        <TextField
          label="New date"
          type="date"
          value={date}
          disabled={pending}
          onChange={(e) => {
            setDate(e.target.value);
            setInvalid(false);
          }}
        />
        <TextField
          label={`New time (${timezone})`}
          type="time"
          value={time}
          disabled={pending}
          onChange={(e) => {
            setTime(e.target.value);
            setInvalid(false);
          }}
        />
      </span>
      {invalid ? (
        <span className="appts__step-error" role="alert">
          That is not a date and time we can read in {timezone}.
        </span>
      ) : null}
      <span className="appts__confirm-acts">
        <button
          type="button"
          className="appts__confirm-yes"
          aria-label={`Move ${booking.memberName}'s appointment`}
          disabled={pending}
          onClick={() => {
            const startsAt = instantFromSalonLocal(date, time, timezone);
            if (startsAt === null) {
              setInvalid(true);
              return;
            }
            onSubmit(startsAt);
          }}
        >
          {pending ? 'Moving…' : 'Move it'}
        </button>
        <button type="button" className="appts__confirm-no" disabled={pending} onClick={onDismiss}>
          Cancel
        </button>
      </span>
    </span>
  );
}

/**
 * REASSIGN. ONE SELECT, AND THE CURRENT ARTIST IS NOT IN IT.
 *
 * `reassignArtist` answers 400 `same_artist` — "That is the artist the
 * appointment is already with." — so offering her is offering a refusal. This is
 * the one pre-emption in this file that removes an option rather than adding a
 * check, which is why it is safe: there is no arithmetic to get wrong, and the
 * server still refuses if the row changes underneath.
 *
 * THE ROSTER IS `perms.team`'s ENDPOINT, NOT THIS BOARD'S. An appointments
 * reader is not guaranteed to hold it, so the list can legitimately come back
 * empty or refused — and an empty select is not a control, it is a dead end. It
 * says so instead, and names the way through.
 */
function ReassignStep({
  booking,
  artists,
  pending,
  onSubmit,
  onDismiss,
}: {
  booking: MerchantBooking;
  artists: ReadonlyArray<{ id: string; name: string }>;
  pending: boolean;
  onSubmit: (artistId: string) => void;
  onDismiss: () => void;
}) {
  const [artistId, setArtistId] = useState('');
  const others = artists.filter((a) => a.id !== booking.artistId);

  return (
    <span className="appts__step">
      {artists.length === 0 ? (
        <span className="appts__step-error">
          We couldn&rsquo;t load the team list. Open Team to check it, then try again.
        </span>
      ) : others.length === 0 ? (
        <span className="appts__step-error">
          {booking.artistName} is the only artist on the roster, so there is nobody to hand this
          to.
        </span>
      ) : (
        <span className="appts__step-fields">
          <Select
            label="Hand it to"
            size="sm"
            value={artistId}
            disabled={pending}
            options={[
              { value: '', label: 'Pick an artist' },
              ...others.map((a) => ({ value: a.id, label: a.name })),
            ]}
            onChange={(e) => setArtistId(e.target.value)}
          />
        </span>
      )}
      <span className="appts__confirm-acts">
        <button
          type="button"
          className="appts__confirm-yes"
          aria-label={`Reassign ${booking.memberName}'s appointment`}
          disabled={pending || artistId === ''}
          onClick={() => onSubmit(artistId)}
        >
          {pending ? 'Reassigning…' : 'Reassign'}
        </button>
        <button type="button" className="appts__confirm-no" disabled={pending} onClick={onDismiss}>
          Cancel
        </button>
      </span>
    </span>
  );
}

/**
 * THE ARM-THEN-CONFIRM STEP, SHARED BY CANCEL AND MARK DONE.
 *
 * It is `§ the armed row`'s shape lifted into a component because there are now
 * three of them and three copies of a confirmation are three places for one to
 * stop disabling its buttons mid-flight. The no-show's own is left where it is:
 * it carries an idempotency key and a money sentence that neither of these has,
 * and folding it in would mean a prop that is only ever set on one caller.
 *
 * THE QUESTION IS A NODE RATHER THAN A STRING, because the cancel's version
 * contains `<Money>` — integer fils through the one formatter, announcing
 * "5.000 Kuwaiti dinars" rather than letting a screen reader read "five
 * thousand" off the digits (#1, interaction-spec.md §2).
 */
function ConfirmStep({
  question,
  confirmLabel,
  pendingLabel,
  confirmAria,
  pending,
  onConfirm,
  onDismiss,
}: {
  question: React.ReactNode;
  confirmLabel: string;
  pendingLabel: string;
  confirmAria: string;
  pending: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  return (
    <span className="appts__confirm">
      <span className="appts__confirm-q">{question}</span>
      <span className="appts__confirm-acts">
        <button
          type="button"
          className="appts__confirm-yes"
          aria-label={confirmAria}
          disabled={pending}
          onClick={onConfirm}
        >
          {pending ? pendingLabel : confirmLabel}
        </button>
        <button type="button" className="appts__confirm-no" disabled={pending} onClick={onDismiss}>
          Keep it
        </button>
      </span>
    </span>
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
