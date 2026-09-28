/**
 * The Book flow's state machine.
 *
 * Branch → service → artist → time → confirmation, expressed as a union for the
 * same reason `useTopUp` is: "which step am I on" and "what has been chosen by
 * now" cannot drift apart. There is no path to the review step without a
 * service, an artist and a slot, and the compiler is what says so.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS ORDER IS NOT THE PRODUCT SPEC'S, AND IT IS NOT DRIFT
 * ═══════════════════════════════════════════════════════════════════════════
 * `design/AVO-Beauty-Product-Description-v2.md:41` says "service → artist →
 * day (7-day strip) → time slot → confirm" and has no branch step at all. The
 * branch step was added after Aftab tested the app (it sat second, after the
 * service), and he has since fixed its position himself — client ask W1,
 * verbatim: "In book, it should be branch selection then service, then
 * staff". So BRANCH FIRST is the authorised order. A reader comparing this
 * file to the spec is looking at a client decision, not a lane's improvisation.
 *
 * THE BRANCH STEP IS CONDITIONAL AND THE COUNTER IS NOT A CONSTANT. Most salons
 * have one open branch and are never asked, so their flow is four steps long,
 * opens on the service, and says so. `TOTAL_STEPS` is the ceiling;
 * `totalSteps` on the controller is the answer. See § the entry gate.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE THINGS THIS FILE REFUSES TO DECIDE
 * ═══════════════════════════════════════════════════════════════════════════
 * Every one of them belongs to the server, and each has a failure mode that
 * only shows up in front of a customer:
 *
 *   the deposit       `salon.depositFils`, never a number here. The API refuses
 *                     a client-supplied `depositFils` by name.
 *   the branch        resolved server-side. The API refuses a client-supplied
 *                     `branchId` by name.
 *   whether she can   the 402 carries `shortfallFils`. Subtracting the balance
 *   afford it         from the deposit here would be a second opinion about
 *                     money, and non-negotiable #2 says there is only one.
 *   whether a slot    the grid says `available`; a slot that looks free can
 *   is free           still be taken between the tap and the POST, and the
 *                     answer to that is the 409, not a re-check.
 *   whether the       `409 change_window_closed`. The client's clock is not the
 *   window is open    one that counts — see § reschedule below.
 *
 * WHAT IT DOES DECIDE: which step is showing, which day is selected, and when
 * an idempotency key stops being the same attempt.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BookableArtist, Salon } from '@avo/types';
import { ApiError, newIdempotencyKey } from '../api/client';
import {
  cancelBooking,
  createBooking,
  getArtists,
  getAvailability,
  getBookings,
  getServices,
  rescheduleBooking,
  type Availability,
  type AvailabilitySlotWire,
  type BookableService,
  type BookingView,
} from '../api/booking';
import { dayStrip, salonDate, type StripDay } from '../domain/booking';
import {
  branchChoices,
  branchQuery,
  branchStepApplies,
  sameChoice,
  type BranchChoice,
  type RosterSplit,
} from '../domain/branchPicker';
import { assignedArtists, bookableServices, isAssigned } from '../domain/serviceAssignment';

/**
 * `'entry'` IS NOT A NUMBERED STEP. It is "the first step is not known yet" —
 * the few hundred milliseconds at a multi-branch salon between opening Book and
 * the roster split landing, during which step 1 could be either `branch` or
 * `service`. See § the entry gate. Every other member is a step she stands on.
 */
export type StepName = 'entry' | 'branch' | 'service' | 'artist' | 'day' | 'review' | 'confirmed';

/**
 * The numbered steps of the progress bar AT FULL LENGTH. `confirmed` is past it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FIVE IS THE CEILING, NOT THE ANSWER. READ `totalSteps` OFF THE CONTROLLER.
 * ═══════════════════════════════════════════════════════════════════════════
 * Branch → service → artist → time → confirmation is the flow Aftab asked for
 * (W1 — see the header for why that departs from the product spec), and it is
 * five steps at a salon where the branch question can be answered.
 * At every other salon — which today is MOST salons — the branch step is
 * suppressed and the flow is four, so this constant is the wrong number to
 * print. A "Step 2 of 5" naming a step she cannot reach is worse than four
 * steps, so the screen reads `flow.totalSteps`, which is 5 or 4 per salon, and
 * this export survives only as the ceiling the bar is defined against and as
 * the thing a spec can assert the flow's full length against.
 */
export const TOTAL_STEPS = 5;

/**
 * Re-exported from `domain/loadFailure.ts`, which owns the type and the mapping.
 * The private `toFailure` that used to live here was one of three copies of the
 * same reduction, none of them with a spec; see that module's header.
 */
export type { LoadFailure } from '../domain/loadFailure';
import { toLoadFailure as toFailure, type LoadFailure } from '../domain/loadFailure';

export type LoadState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'failed'; failure: LoadFailure };

/**
 * A reschedule reuses this whole machine from step 3 onward.
 *
 * The service and the artist are fixed — they are the ones already booked — and
 * the confirm writes `POST /bookings/{id}/reschedule` instead of a new booking.
 * That is why `mode` is on the controller rather than a second hook: two
 * implementations of the slot grid is two answers to "which times are free",
 * and only one of them would be the one the deposit moves against.
 */
export interface RescheduleTarget {
  booking: BookingView;
  artistId: string;
  serviceId: string;
}

export interface BookingController {
  step: StepName;
  /**
   * 1..`totalSteps` for the progress bar. `confirmed` reports `totalSteps`, the
   * bar being complete. NULL ON `'entry'` — there is no number that is true
   * yet, so the type makes the screen print none rather than a guess.
   */
  stepIndex: number | null;
  /**
   * HOW LONG THIS SALON'S FLOW ACTUALLY IS — 5 with the branch step, 4 without,
   * and NULL while that is not known (`'entry'` only).
   *
   * Not `TOTAL_STEPS`. The constant is the ceiling; this is the number the
   * customer is entitled to be told, and it is the one the counter and the
   * progress bar both read. See § the entry gate for why it is decided once,
   * before it is ever shown, and never moves after.
   */
  totalSteps: number | null;
  /**
   * Whether `'branch'` is on this salon's path at all.
   *
   * Exposed so the screen does not have to re-derive the skip from
   * `branchOptions`, which is the same information wearing a different hat and
   * would be a second place for the rule to be half-applied.
   */
  hasBranchStep: boolean;
  /**
   * The step Back leaves the flow from: `branch` or `service` for a new booking
   * (null on `'entry'`, which Back also leaves), `day` for a reschedule. One
   * field, so the screen's "leave or step back" test cannot disagree with the
   * machine's idea of where the flow starts.
   */
  firstStep: StepName | null;
  /**
   * The entry gate's failure, when the read that decides step 1 failed. The
   * screen renders the failure screen with a retry; see § the entry gate.
   */
  entryFailure: LoadFailure | null;
  /**
   * The split read's failure at ANY point, entry included. After entry it is
   * a re-read (a `retryLoad`), and it fails the branch step's chips -- with a
   * retry -- rather than leaving that step on a skeleton for ever.
   */
  splitFailure: LoadFailure | null;

  /**
   * THE SERVICES SHE CAN BOOK HERE — `domain/serviceAssignment.ts`. Not the
   * salon's whole list: a service nobody is assigned to (`artistIds: []`) is
   * hidden, and so is one nobody on the current roster performs — which, after
   * she picks a branch, is "nobody at this branch". `loading` until BOTH the
   * service list and the roster behind it have landed, so a service cannot
   * appear and then vanish under her finger.
   */
  services: LoadState<BookableService[]>;
  /**
   * THE STAFF STEP'S LIST — the roster narrowed to the artists assigned to her
   * service. The whole roster before a service is chosen, and on a reschedule,
   * whose artist is fixed.
   */
  artists: LoadState<BookableArtist[]>;
  availability: LoadState<Availability>;
  /**
   * `409 artist_not_assigned` on a NEW booking: the merchant took her artist
   * off this service between choosing and confirming. The flow is back on the
   * staff step with her service kept and the artist cleared, and the lists are
   * re-read. True until she picks again. (A reschedule, whose artist is fixed,
   * gets `confirmFailure` with the code instead.)
   */
  artistUnassigned: boolean;

  /**
   * THE BRANCH STEP'S CONTINUE — true only once the roster behind the chosen
   * chip has been read and has somebody in it.
   *
   * `null` while that read is in flight, `false` for a branch with nobody
   * bookable. See § the empty branch, at `next`, for why this gate exists: with
   * the branch first, an empty branch would otherwise be discovered two steps
   * later, after she had chosen a service for it.
   */
  branchHasArtists: boolean | null;

  /**
   * THE BRANCH SWITCH -- step 1's chips, when step 1 is the branch.
   *
   * `branchOptions` is EMPTY when there should be no branch step at all, which
   * is the common case: a single-branch salon, or a salon whose artists are all
   * unassigned. `domain/branchPicker.ts` owns that rule and argues it at
   * length. The one thing to know here is that a branch is never sent to
   * `POST /bookings` -- it filters the roster, and the booking's branch is
   * derived server-side from the artist she picks. Promoting the control from a
   * strip to a step did not change that: there is still no field to send.
   */
  branchOptions: BranchChoice[];
  /**
   * The row she chose, or NULL for none -- which is both "not chosen yet" on
   * the branch step and "there is no branch step". There is no "All branches"
   * choice (Aftab, 2026-09-29), so a salon with a branch step opens it with
   * nothing selected and Continue waiting for her, exactly as the service step
   * does; null reads the roster unfiltered, as the wallet always has.
   */
  branchChoice: BranchChoice | null;
  /**
   * The unfiltered roster's split, or null while it is unknown. Read from the
   * UNFILTERED mount read and never from a filtered one, so tapping a branch
   * with no artists cannot make the strip she needs disappear.
   */
  rosterSplit: RosterSplit | null;
  pickBranch: (choice: BranchChoice) => void;

  strip: StripDay[];
  selectedDate: string | null;
  selectedService: BookableService | null;
  selectedArtist: BookableArtist | null;
  selectedSlot: AvailabilitySlotWire | null;

  /** Set only by a 402 from the server, and cleared by a fresh attempt. */
  shortfallFils: number | null;
  /** A refusal on confirm — `slot_taken`, `booking_not_enabled`, anything else. */
  confirmFailure: LoadFailure | null;
  submitting: boolean;

  /**
   * Present on the confirmed step, and it is the SERVER's booking.
   *
   * `balanceAfterFils` is null after a RESCHEDULE, because a reschedule moves
   * no money: the deposit carries, there is no ledger row and there is no new
   * balance to report. Null rather than the old balance repeated — the
   * confirmed screen shows the deposit that is still held, not a figure that
   * would look like a fresh debit.
   */
  result: { booking: BookingView; balanceAfterFils: number | null } | null;
  /** True while this flow is moving an existing appointment rather than making one. */
  rescheduling: boolean;

  pickService: (service: BookableService) => void;
  pickArtist: (artist: BookableArtist) => void;
  pickDay: (date: string) => void;
  pickSlot: (slot: AvailabilitySlotWire) => void;
  next: () => void;
  back: () => void;
  confirm: () => void;
  retryLoad: () => void;
  /** After a top-up lands, so the next Confirm is not answered from a stale 402. */
  clearShortfall: () => void;
}

export function useBooking(options: {
  salon: Salon;
  /** Now, injected so the strip is testable and so one instant drives one render. */
  now?: Date;
  reschedule?: RescheduleTarget | undefined;
  /** Fired after a successful create or reschedule, so Home re-reads the balance. */
  onBooked: () => void;
}): BookingController {
  const { salon, reschedule, onBooked } = options;
  const rescheduling = reschedule !== undefined;

  /**
   * MORE THAN ONE OPEN BRANCH IS THE ONLY REASON TO ASK THE BRANCH QUESTION.
   *
   * `salon.branches` carries only OPEN branches. Below two there is no step
   * whatever the roster looks like, so the `?branch=unassigned` read below is
   * not made at all, there is no entry gate, and a single-branch salon's first
   * frame and network traffic are exactly what they were before W1.
   *
   * A RESCHEDULE IS EXCLUDED HERE, AND THAT IS WHAT KEEPS IT UNTOUCHED. It
   * enters at the grid with the artist already fixed, so there is no roster to
   * filter and no branch question to ask -- and asking it would print a "Step 4
   * of 5" over a flow whose first three steps do not exist. Gating the split
   * read on it also drops two requests a reschedule was making and never using.
   */
  const multiBranch = !rescheduling && salon.branches.length >= 2;

  /**
   * A reschedule starts at the grid, as it always has. A single-branch salon
   * starts at the service, as it always has. Only a multi-branch new booking
   * starts at `'entry'` — see § the entry gate.
   */
  const [step, setStep] = useState<StepName>(
    rescheduling ? 'day' : multiBranch ? 'entry' : 'service',
  );
  /** The salon's list, UNNARROWED. What the flow offers is `services` below. */
  const [allServices, setServices] = useState<LoadState<BookableService[]>>({ status: 'loading' });
  /** `/artists/bookable` for the branch choice, UNNARROWED. See `artists` below. */
  const [roster, setRoster] = useState<LoadState<BookableArtist[]>>({ status: 'loading' });
  const [availability, setAvailability] = useState<LoadState<Availability>>({ status: 'loading' });

  const [serviceId, setServiceId] = useState<string | null>(reschedule?.serviceId ?? null);
  const [artistId, setArtistId] = useState<string | null>(reschedule?.artistId ?? null);
  const [selectedSlot, setSelectedSlot] = useState<AvailabilitySlotWire | null>(null);
  const [shortfallFils, setShortfallFils] = useState<number | null>(null);
  const [confirmFailure, setConfirmFailure] = useState<LoadFailure | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [artistUnassigned, setArtistUnassigned] = useState(false);
  const [result, setResult] = useState<
    { booking: BookingView; balanceAfterFils: number | null } | null
  >(null);
  const [reloadToken, setReloadToken] = useState(0);

  /**
   * The selected filter, and the unfiltered roster's split.
   *
   * `null` is the default -- nothing chosen -- and `branchQuery` maps it to no
   * parameter at all, so a salon with no branch step (and a reschedule) issues
   * exactly the request this app issued before the picker existed. There is no
   * "All branches" choice to default to any more (Aftab, 2026-09-29).
   */
  const [branchChoice, setBranchChoice] = useState<BranchChoice | null>(null);
  const [split, setSplit] = useState<LoadState<RosterSplit>>({ status: 'loading' });
  const rosterSplit = split.status === 'ready' ? split.data : null;

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * THE ENTRY GATE -- STEP 1 IS DECIDED BY DATA THAT HAS NOT ARRIVED YET
   * ═════════════════════════════════════════════════════════════════════════
   * Whether a multi-branch salon asks the branch question is
   * `branchStepApplies`, and that needs the roster split, which is an async
   * read. With the branch SECOND (the order before W1) the flow could open on
   * `service` while that read was in flight and slot the branch in behind it.
   * With the branch FIRST there is nothing to open on: step 1 is either
   * `branch` or `service`, and which one is exactly what has not loaded.
   *
   * Guessing is ruled out in both directions. Open on `service` and move her to
   * `branch` when the split lands, and the screen changes under her finger --
   * possibly after she has tapped a service. Open on `branch` and skip past it
   * when the split says nothing is assigned, and a salon that has never
   * assigned anyone (most multi-branch salons today, migration 0044) flashes a
   * branch step it does not have.
   *
   * So a multi-branch new booking opens on `'entry'`: header, back button, an
   * empty progress track, NO COUNTER, and a row skeleton. In the render in
   * which the split lands, `hasBranchStep` is set and `'entry'` moves to the
   * right first step before anything commits (see the block after the split
   * effect) -- so there is no painted frame in which the step and the count
   * disagree.
   *
   * HOW LONG IT IS. One network round trip: the two `GET /artists/bookable`
   * reads (unfiltered, and `?branch=unassigned`) go out in parallel at mount,
   * alongside the service list, with no dependency between them. So it is the
   * same order of wait step 1's skeleton always had -- the service list was one
   * round trip too -- but gated on the slower of the two ROSTER reads rather
   * than on the service list. (When it opens on the service, that list went
   * out at the same instant and has usually landed already; if not, the
   * service step shows its own skeleton, as it always did.) Not measured on a
   * device in this slice.
   * Its ceiling is the client's `REQUEST_TIMEOUT_MS` (15 s), after which the
   * read fails as `offline`.
   *
   * WHEN IT FAILS. Before W1 a failed split read was swallowed: the strip
   * stayed absent and step 2 rendered as it always had. That no longer
   * works, because the gate IS the first thing she sees -- swallowing the
   * failure would either hold her on a skeleton for ever or quietly decide
   * "four steps" on the strength of a network blip, and a later retry that
   * succeeded would then have to add a step to a flow she was already
   * counting. So a failure at entry is a real failure screen (`entryFailure`)
   * with the ordinary retry: offline gets the offline copy, a 5xx gets ours,
   * and `retryLoad` puts her back on the skeleton and re-reads. It is
   * recoverable in place; nothing she chose is lost, because she has chosen
   * nothing yet.
   *
   * ═════════════════════════════════════════════════════════════════════════
   * THE COUNTER -- THE OLD INVARIANT IS REPLACED, NOT RE-ARGUED
   * ═════════════════════════════════════════════════════════════════════════
   * Before W1 the count was LATCHED and "only ever rose": it printed four
   * while the split loaded and went to five when the split proved the step
   * answerable. That was tolerable only because the branch was step 2 -- the
   * 4 → 5 rise happened while she stood on step 1, and "Step 1 of 4" becoming
   * "Step 1 of 5" was the understatement it accepted.
   *
   * With the branch first, the same rise would be "Step 1 of 4" on a service
   * list becoming "Step 1 of 5" on a branch step -- a different screen AND a
   * different count. A monotone count cannot fix that. So the rule is now:
   *
   *   THE COUNT IS DECIDED ONCE, BEFORE IT IS FIRST SHOWN, AND NEVER MOVES.
   *
   * `totalSteps` is `null` on `'entry'` (the type makes the screen print no
   * number), and fixed at 4 or 5 from the first numbered step to the end of
   * the mount. A single-branch salon and a reschedule are decided at mount,
   * synchronously, so they never see `'entry'` at all.
   *
   * IT DOES NOT RE-DECIDE ON A RETRY. `retryLoad` re-reads the split, and a
   * re-read after entry updates the CHIPS (`branchOptions`) and nothing else:
   * the step exists or it does not from the moment she first saw a number.
   * A merchant assigning her first artist while a customer is mid-flow does
   * not insert a step 1 behind a customer already on step 3.
   */
  const [hasBranchStep, setHasBranchStep] = useState(false);

  /**
   * The chips, or an empty array meaning "no branch step". `branches` is passed
   * straight through -- the salons route serves only OPEN branches, which is
   * the same reading `resolveBranch` takes when it decides whether a branch was
   * established.
   *
   * Gated on `hasBranchStep` as well, so the chips and the step cannot
   * disagree even after a re-read changes the split: a flow decided at four
   * steps has no chips, whatever the roster says later.
   */
  const branchOptions = useMemo(
    () =>
      multiBranch && hasBranchStep
        ? branchChoices({ branches: salon.branches, split: rosterSplit })
        : [],
    [multiBranch, hasBranchStep, salon.branches, rosterSplit],
  );

  /**
   * The strip is computed ONCE per mount from one instant.
   *
   * Recomputing it on every render would let the strip shift under the
   * customer's finger at midnight — the day she tapped becoming the second chip
   * rather than the first — and it would do it silently.
   */
  const now = useMemo(() => options.now ?? new Date(), [options.now]);
  const strip = useMemo(() => dayStrip(now, salon.timezone), [now, salon.timezone]);
  const [selectedDate, setSelectedDate] = useState<string | null>(
    () => strip[0]?.date ?? salonDate(now, salon.timezone),
  );

  // ------------------------------------------------------------- the loads --

  useEffect(() => {
    const controller = new AbortController();
    setServices({ status: 'loading' });
    getServices(salon.id, controller.signal)
      .then((data) => setServices({ status: 'ready', data }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setServices({ status: 'failed', failure: toFailure(err) });
      });
    return () => controller.abort();
  }, [salon.id, reloadToken]);

  /**
   * The roster she is looking at -- re-read when the branch filter changes.
   *
   * ONE EFFECT FOR BOTH the unfiltered mount read and every filtered re-read,
   * because they are the same question asked with a different parameter. Two
   * effects would be two loading states and two ways to leave one of them set.
   *
   * The 400 an unrecognised `?branch=` earns (`invalid_branch_filter`) arrives
   * here as an ordinary failure and renders the failure screen. That is right:
   * the strip cannot produce such a value, so one appearing is a bug in this
   * app, and the API refusing it by name rather than ignoring it is what makes
   * the bug visible instead of silently showing the whole roster.
   */
  useEffect(() => {
    const controller = new AbortController();
    setRoster({ status: 'loading' });
    getArtists(salon.id, branchQuery(branchChoice), controller.signal)
      // NO CLIENT-SIDE `active` FILTER, AND ITS ABSENCE IS THE POINT.
      //
      // This used to be `data.filter((a) => a.active)` against the merchant
      // roster, which lists everyone because reception has to be able to see and
      // reactivate a retired artist. `/artists/bookable` filters on `active`
      // server-side — "bookable" is the filter, not a hint — and therefore does
      // not emit the field at all, since it would read `true` on every row.
      //
      // Re-deriving it here is impossible and re-declaring it would be worse: a
      // second opinion on who may be booked, held by the client, is how a retired
      // artist gets offered and the charge handler answers with a 409
      // `artist_not_bookable` after four taps.
      .then((data) => setRoster({ status: 'ready', data }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setRoster({ status: 'failed', failure: toFailure(err) });
      });
    return () => controller.abort();
  }, [salon.id, reloadToken, branchChoice]);

  /**
   * HOW MANY ARTISTS HAVE NO BRANCH -- the strip's whole visibility rule.
   *
   * A separate read, and it has to be one: `GET /artists/bookable` serves five
   * fields and `branchId` is not among them, so the split is not derivable from
   * the roster this screen already holds. `?branch=unassigned` is the API's own
   * first-class filter value for exactly this question.
   *
   * KEYED ON `[salon.id, reloadToken]` AND NOT ON THE FILTER, deliberately.
   * This is the UNFILTERED split; recomputing it per selection would let a
   * branch chip with no artists report `total: 0`, conclude nothing is
   * assigned, and remove the strip the customer is standing in.
   *
   * `total` COMES FROM ITS OWN UNFILTERED READ rather than from `artists`
   * above, which by then may hold a filtered list. Two reads, one instant, no
   * ordering assumption between them.
   *
   * A FAILURE HERE IS NOW A FAILED SCREEN, where before W1 it was swallowed.
   * This read decides step 1, so it is the first thing she waits on; see
   * § the entry gate for why a silent fallback to four steps is no longer
   * available. After entry, a failed RE-read fails the branch step's chips
   * (with a retry) and touches nothing else.
   *
   * Step 1 is decided from what this stores; see the block below it.
   */
  useEffect(() => {
    if (!multiBranch) return;
    const controller = new AbortController();
    setSplit({ status: 'loading' });
    Promise.all([
      getArtists(salon.id, undefined, controller.signal),
      getArtists(salon.id, 'unassigned', controller.signal),
    ])
      .then(([all, unassigned]) => {
        if (controller.signal.aborted) return;
        setSplit({ status: 'ready', data: { total: all.length, unassigned: unassigned.length } });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setSplit({ status: 'failed', failure: toFailure(err) });
      });
    return () => controller.abort();
  }, [salon.id, reloadToken, multiBranch]);

  /**
   * LEAVING `'entry'`: decided in the render in which the split first reads
   * `ready`, before that render commits.
   *
   * State set during render, guarded, is React's own pattern for state derived
   * from other state -- React discards the in-progress render and re-runs it
   * with the new values before anything is painted, so there is no committed
   * frame holding a ready split and an undecided step. `step === 'entry'` is
   * the whole "decided once" guard: nothing ever sets `'entry'` again, so a
   * re-read after entry cannot reach this block.
   */
  if (step === 'entry' && split.status === 'ready') {
    const asks = branchStepApplies({ branches: salon.branches, split: split.data });
    setHasBranchStep(asks);
    setStep(asks ? 'branch' : 'service');
  }

  /**
   * The grid, re-read whenever the artist or the day changes.
   *
   * NOT CACHED PER DAY, DELIBERATELY. Availability is the one thing on this
   * screen that another customer can change while it is on screen, and a cached
   * Tuesday shown after a walk back through step 2 is a grid offering a slot
   * that went ten minutes ago.
   */
  useEffect(() => {
    if (!artistId || !selectedDate) return;
    const controller = new AbortController();
    setAvailability({ status: 'loading' });
    getAvailability(artistId, selectedDate, controller.signal)
      .then((data) => setAvailability({ status: 'ready', data }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setAvailability({ status: 'failed', failure: toFailure(err) });
      });
    return () => controller.abort();
  }, [artistId, selectedDate, reloadToken]);

  // --------------------------------------------------------- the selection --

  /**
   * THE SERVICE SHE CHOSE, found in the salon's WHOLE list rather than the
   * narrowed one — so a reschedule of a service whose assignments have since
   * changed still names it on the review and confirmed screens.
   */
  const selectedService =
    allServices.status === 'ready'
      ? (allServices.data.find((s) => s.id === serviceId) ?? null)
      : null;

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * WHO DOES WHICH SERVICE — `domain/serviceAssignment.ts` (migration 0061)
   * ═════════════════════════════════════════════════════════════════════════
   * The service list is the salon's, intersected with the roster behind her
   * branch choice; the staff list is that roster, narrowed to her service. No
   * request per service — both lists were already being read.
   *
   * THE SERVICE LIST WAITS FOR THE ROSTER. Both go out at mount, in parallel,
   * so this adds no round trip; what it prevents is a service drawn from the
   * unnarrowed list and then removed when the roster lands. A FAILED roster
   * does not fail the service step — it narrows by `artistIds: []` alone, and
   * the staff step shows the roster's own failure with its retry.
   *
   * A RESCHEDULE IS NOT NARROWED. Its artist and service are fixed; narrowing
   * would only be able to lose the name of the artist she is already booked
   * with. The server still refuses an unassigned pair (`409
   * artist_not_assigned`), rendered at review.
   */
  const services: LoadState<BookableService[]> = useMemo(() => {
    if (allServices.status !== 'ready') return allServices;
    if (roster.status === 'loading') return { status: 'loading' };
    return {
      status: 'ready',
      data: bookableServices(allServices.data, roster.status === 'ready' ? roster.data : null),
    };
  }, [allServices, roster]);

  const artists: LoadState<BookableArtist[]> = useMemo(() => {
    if (roster.status !== 'ready' || rescheduling || serviceId === null) return roster;
    // Her service is chosen but its list is being re-read (after a 409): hold
    // the staff step on its skeleton rather than flash the unnarrowed roster.
    if (allServices.status === 'loading') return { status: 'loading' };
    if (selectedService === null) return roster;
    return { status: 'ready', data: assignedArtists(roster.data, selectedService) };
  }, [roster, rescheduling, serviceId, allServices.status, selectedService]);

  const selectedArtist =
    artists.status === 'ready' ? (artists.data.find((a) => a.id === artistId) ?? null) : null;

  /**
   * One idempotency key per ATTEMPT, and an attempt is one (artist, service,
   * slot) triple.
   *
   * Reusing the key while the same triple is being retried is what makes a
   * timed-out POST that actually succeeded replay its stored response instead
   * of holding a second deposit. Minting a new one when the triple changes is
   * what stops the API answering a genuinely different booking with a 422 — it
   * treats the same key with a different body as a conflict, not a replay.
   */
  const attemptKey = `${artistId ?? ''}|${serviceId ?? ''}|${selectedSlot?.startsAt ?? ''}`;
  const keyRef = useRef<{ attempt: string; key: string } | null>(null);
  if (keyRef.current?.attempt !== attemptKey) {
    keyRef.current = { attempt: attemptKey, key: newIdempotencyKey() };
  }

  /**
   * A different service can have different staff. An artist she chose for the
   * last one who does not do this one is CLEARED, with her slot — the same
   * reason `pickBranch` clears them: a selection that survives out of view is a
   * Continue that looks enabled for a row nobody can point at.
   */
  const pickService = useCallback(
    (service: BookableService) => {
      setServiceId(service.id);
      if (artistId !== null && !isAssigned(service, artistId)) {
        setArtistId(null);
        setSelectedSlot(null);
      }
      setConfirmFailure(null);
      setArtistUnassigned(false);
    },
    [artistId],
  );

  /**
   * Narrow the roster to a location -- or to the artists who have none.
   *
   * IT CLEARS THE ARTIST AND THE SLOT, for the same reason `pickArtist` clears
   * the slot: the artist she had picked may not be in the list she is about to
   * see, and a selection that survives out of view is a Continue button that
   * looks enabled for a row nobody can point at. `selectedArtist` is derived
   * from the visible list, so it would already read null -- clearing `artistId`
   * as well means there is no hidden second answer to "who is booked" waiting
   * to reappear if she taps back to the branch she had first.
   *
   * The strip does NOT re-render itself out of existence on a filter change:
   * `rosterSplit` is keyed off the unfiltered read, so it does not move here.
   */
  const pickBranch = useCallback((choice: BranchChoice) => {
    setBranchChoice((current) => (sameChoice(current, choice) ? current : choice));
    setArtistId(null);
    setSelectedSlot(null);
    setConfirmFailure(null);
    setArtistUnassigned(false);
  }, []);

  const pickArtist = useCallback((artist: BookableArtist) => {
    setArtistId(artist.id);
    setArtistUnassigned(false);
    // Her grid is a different grid. Keeping the slot would carry a 16:45 from
    // Rana's Tuesday onto Dana's, which the server would then refuse as
    // `not_a_slot` after two more taps.
    setSelectedSlot(null);
    setConfirmFailure(null);
  }, []);

  const pickDay = useCallback((date: string) => {
    setSelectedDate(date);
    setSelectedSlot(null);
    setConfirmFailure(null);
  }, []);

  const pickSlot = useCallback((slot: AvailabilitySlotWire) => {
    // A struck-through slot is rendered but not tappable; this is the second
    // gate, so a keyboard user cannot reach one either.
    if (!slot.available) return;
    setSelectedSlot(slot);
    setConfirmFailure(null);
    setShortfallFils(null);
  }, []);

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * THE EMPTY BRANCH -- CAUGHT ON THE STEP SHE CAN FIX IT FROM
   * ═════════════════════════════════════════════════════════════════════════
   * With the service first, an empty staff step could only follow a branch she
   * had just chosen, one tap back. With the branch first, the same empty staff
   * step would arrive AFTER she had also chosen a service -- two steps from the
   * chips that caused it, and reading as "nobody does this service here".
   *
   * ⚠️ THIS PARAGRAPH USED TO SAY THE SERVICE WAS NEVER THE REASON, and it was
   * true when written: there was no artist-to-service relation, so every artist
   * could be booked for every service. Migration 0061 added one
   * (`Service.artistIds`), `POST /bookings` now refuses an unassigned pair
   * (`409 artist_not_assigned`), and the lists are narrowed by it — see
   * § WHO DOES WHICH SERVICE below. What survives is the shape of the argument:
   * an empty staff step must be caught where she can fix it.
   *
   * So "nobody" now means NOBODY WHO DOES ANY SERVICE, and that is knowable on
   * the branch step: choosing a chip re-reads the roster for it
   * immediately (the artists effect is keyed on `branchChoice`). `next` from
   * `branch` therefore refuses until that read has landed with somebody in
   * it, and the screen shows the empty panel under the chips, where "try
   * another branch" is one tap away. This is the second gate -- the disabled
   * Continue is the first -- for the same reason `pickSlot` has one.
   *
   * `'unassigned'` can never be empty here: its row appears only when that
   * group is. The read is waited on anyway rather than special-cased, so the
   * gate has one rule.
   *
   * NOTHING CHOSEN IS `null`, NOT `true`. With no "All branches" default the
   * step opens with no row selected; the roster behind it is the unfiltered
   * one and is non-empty, but it is not a branch she chose, so Continue waits
   * for a tap -- the same rule as every other step.
   */
  /*
    SINCE 0061 "SOMEBODY" MEANS SOMEBODY WHO DOES A SERVICE. A branch whose
    artists are assigned to nothing would pass a bare `length > 0` and then
    open an empty service step — the two-steps-late discovery this gate exists
    to prevent. So it waits for the service list too (both go out at mount),
    and a FAILED service list falls back to the roster alone, so she reaches
    the service step's own failure and its retry rather than a held Continue.
  */
  const branchHasArtists: boolean | null =
    branchChoice === null || roster.status !== 'ready'
      ? null
      : allServices.status === 'loading'
        ? null
        : allServices.status === 'failed'
          ? roster.data.length > 0
          : bookableServices(allServices.data, roster.data).length > 0;

  const next = useCallback(() => {
    setStep((s) => {
      if (s === 'branch') return branchHasArtists === true ? 'service' : s;
      if (s === 'service') return 'artist';
      if (s === 'artist') return 'day';
      if (s === 'day') return 'review';
      return s;
    });
  }, [branchHasArtists]);

  /**
   * Back, for the new order. Stepping back FROM the first step is not the
   * machine's to do -- the screen leaves the flow when `step === firstStep`
   * (or on `'entry'`), so here the first step simply stays put.
   */
  const back = useCallback(() => {
    setStep((s) => {
      if (s === 'review') return 'day';
      // A reschedule starts at the grid, so stepping back out of it leaves the
      // flow rather than walking into an artist picker she never saw.
      if (s === 'day') return rescheduling ? 'day' : 'artist';
      if (s === 'artist') return 'service';
      // The skip is honoured in BOTH directions. Walking back into a branch
      // step a salon does not have would be a dead screen with one chip on it,
      // and it would do it after the counter had already said there were four.
      // Without one, `service` is the first step and Back leaves the flow.
      if (s === 'service') return hasBranchStep ? 'branch' : 'service';
      return s;
    });
  }, [rescheduling, hasBranchStep]);

  const confirm = useCallback(() => {
    if (!artistId || !serviceId || !selectedSlot || submitting) return;
    const key = keyRef.current?.key ?? newIdempotencyKey();

    setSubmitting(true);
    setConfirmFailure(null);
    setShortfallFils(null);

    const run = async () => {
      try {
        if (reschedule) {
          const moved = await rescheduleBooking(reschedule.booking.id, selectedSlot.startsAt, key);
          setResult({ booking: moved, balanceAfterFils: null });
          setStep('confirmed');
          onBooked();
          return;
        }
        const created = await createBooking(
          { artistId, serviceId, startsAt: selectedSlot.startsAt },
          key,
        );
        setResult({ booking: created.booking, balanceAfterFils: created.balanceAfterFils });
        setStep('confirmed');
        onBooked();
      } catch (err) {
        const failure = toFailure(err);
        /**
         * THE 402 IS NOT AN ERROR SCREEN, IT IS AN INLINE BANNER AND A BUTTON.
         *
         * The shortfall is read off the response — never `deposit − balance`
         * computed here — because the server is the only thing that knows what
         * her balance was at the instant it refused. And the API rolls the
         * transaction back on this path, so the key vanishes with it and the
         * same attempt can be retried after a top-up rather than replaying a
         * cached 402 for ever.
         */
        if (err instanceof ApiError && err.status === 402 && err.shortfallFils !== null) {
          setShortfallFils(err.shortfallFils);
          return;
        }
        /**
         * `409 artist_not_assigned` — THE MERCHANT CHANGED WHO DOES WHAT WHILE
         * SHE WAS BOOKING. Recoverable, and she keeps her place: back to the
         * staff step with her SERVICE KEPT, the artist and slot cleared (the
         * slot was that artist's grid), and both lists re-read so the step
         * shows who does it now. A new artist is a new attempt, so the key
         * re-mints on its own. Nothing was held: the refusal is before the
         * deposit moves.
         *
         * A RESCHEDULE CANNOT GO BACK TO A STAFF STEP — its artist is the one
         * already booked — so it falls through to `confirmFailure`, rendered
         * from the code: her appointment did not move.
         */
        if (failure.code === 'artist_not_assigned' && !reschedule) {
          setArtistId(null);
          setSelectedSlot(null);
          setArtistUnassigned(true);
          setStep('artist');
          setReloadToken((t) => t + 1);
          return;
        }
        setConfirmFailure(failure);
      } finally {
        setSubmitting(false);
      }
    };
    void run();
  }, [artistId, serviceId, selectedSlot, submitting, reschedule, onBooked]);

  const retryLoad = useCallback(() => setReloadToken((t) => t + 1), []);
  const clearShortfall = useCallback(() => setShortfallFils(null), []);

  /**
   * THE COUNTER, AND THE ONE RULE IT HAS TO KEEP: every number it prints names
   * a step she can actually stand on.
   *
   * `confirmed` reports `totalSteps` rather than a number of its own -- the bar
   * is complete, and the design draws it full behind the confirmation.
   *
   * `'entry'` reports NULL for both, and that is the rule § the entry gate
   * argues: the count is decided before it is first shown and never moves, so
   * before it is decided there is no count to show. Everything after the
   * branch is one place later when the branch step exists.
   */
  const entering = step === 'entry';
  const offset = hasBranchStep ? 1 : 0;
  const totalSteps = entering ? null : 4 + offset;
  const stepIndex = entering
    ? null
    : step === 'branch'
      ? 1
      : step === 'service'
        ? 1 + offset
        : step === 'artist'
          ? 2 + offset
          : step === 'day'
            ? 3 + offset
            : totalSteps;

  const firstStep: StepName | null = rescheduling
    ? 'day'
    : entering
      ? null
      : hasBranchStep
        ? 'branch'
        : 'service';

  const splitFailure = split.status === 'failed' ? split.failure : null;
  const entryFailure = entering ? splitFailure : null;

  return {
    step,
    stepIndex,
    totalSteps,
    hasBranchStep,
    firstStep,
    entryFailure,
    splitFailure,
    branchHasArtists,
    services,
    artists,
    availability,
    artistUnassigned,
    branchOptions,
    branchChoice,
    rosterSplit,
    strip,
    selectedDate,
    selectedService,
    selectedArtist,
    selectedSlot,
    shortfallFils,
    confirmFailure,
    submitting,
    result,
    rescheduling,
    pickBranch,
    pickService,
    pickArtist,
    pickDay,
    pickSlot,
    next,
    back,
    confirm,
    retryLoad,
    clearShortfall,
  };
}

// ═══════════════════════════════════════════════ the upcoming appointment ══

export interface UpcomingState {
  status: 'loading' | 'ready' | 'failed';
  bookings: BookingView[];
  failure: LoadFailure | null;
  /** Set by a refused cancel — `409 change_window_closed` is the one that matters. */
  actionFailure: LoadFailure | null;
  busy: boolean;
  reload: () => void;
  /** Cancel. Returns the refunded amount so the toast can name it. */
  cancel: (id: string) => Promise<number | null>;
  clearActionFailure: () => void;
}

/**
 * Her held appointments, for the Upcoming card.
 *
 * `?status=deposit_held` rather than the whole list: the card is about money
 * that is currently out of her wallet, and a cancelled booking's deposit is
 * already back in it.
 */
export function useUpcoming(options: {
  enabled: boolean;
  onChanged: () => void;
  /**
   * Re-reads the list when it changes. Home passes `useWalletRefresh`'s
   * `generation`, so the card is re-read when the payment code closes, when the
   * app comes back to the foreground, and on pull-to-refresh — a charge that
   * applied her deposit takes the booking out of `deposit_held`.
   */
  refreshKey?: unknown;
}): UpcomingState {
  const { enabled, onChanged, refreshKey } = options;
  const [status, setStatus] = useState<UpcomingState['status']>('loading');
  const [bookings, setBookings] = useState<BookingView[]>([]);
  const [failure, setFailure] = useState<LoadFailure | null>(null);
  const [actionFailure, setActionFailure] = useState<LoadFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState(0);
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    /*
      A RE-READ OVER A LIST ON SCREEN IS QUIET. `refreshKey` fires this on every
      foreground, so going to 'loading' here would flash the skeleton over her
      appointment each time she opens the app, and a background re-read that
      failed would swap a booking she can see for the failure card. Stale, not
      blank: over a READY list the card stays as it is while the read is out and
      after it fails; Home's own stale or offline banner is what says so. From
      'loading' or 'failed' (the first read, and the failure card's own Try
      again) nothing changed.
    */
    const quiet = statusRef.current === 'ready';
    if (!quiet) setStatus('loading');
    getBookings('deposit_held', controller.signal)
      .then((items) => {
        setBookings(items);
        setFailure(null);
        setStatus('ready');
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || quiet) return;
        setFailure(toFailure(err));
        setStatus('failed');
      });
    return () => controller.abort();
  }, [enabled, token, refreshKey]);

  const reload = useCallback(() => setToken((t) => t + 1), []);

  const cancel = useCallback(
    async (id: string): Promise<number | null> => {
      setBusy(true);
      setActionFailure(null);
      try {
        const outcome = await cancelBooking(id);
        setBookings((prev) => prev.filter((b) => b.id !== id));
        // The balance changed, so Home has to re-read it. Non-negotiable #2:
        // the new balance is the server's answer, never the old one plus the
        // refund — `balanceAfterFils` is in the response and is still not added
        // to anything here.
        onChanged();
        return outcome.refundedFils;
      } catch (err) {
        /**
         * `409 change_window_closed` arrives here and is SURFACED, not
         * pre-empted. The buttons were never disabled on a client-side clock
         * comparison — a phone four minutes fast would have hidden a cancel the
         * salon would still have honoured, and a phone four minutes slow would
         * have offered one it would not.
         */
        setActionFailure(toFailure(err));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [onChanged],
  );

  return {
    status,
    bookings,
    failure,
    actionFailure,
    busy,
    reload,
    cancel,
    clearActionFailure: useCallback(() => setActionFailure(null), []),
  };
}
