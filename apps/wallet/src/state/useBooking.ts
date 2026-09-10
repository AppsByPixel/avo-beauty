/**
 * The Book flow's state machine.
 *
 * Five steps, expressed as a discriminated union for the same reason
 * `useTopUp` is: "which step am I on" and "what has been chosen by now" cannot
 * drift apart. There is no path to the review step without a service, an artist
 * and a slot, and the compiler is what says so.
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
  ALL_BRANCHES,
  branchChoices,
  branchQuery,
  sameChoice,
  type BranchChoice,
  type RosterSplit,
} from '../domain/branchPicker';

export type StepName = 'service' | 'artist' | 'day' | 'review' | 'confirmed';

/** The four numbered steps of the design's progress bar. `confirmed` is past it. */
export const TOTAL_STEPS = 4;

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
  /** 1-4 for the progress bar. `confirmed` reports 4, the bar being complete. */
  stepIndex: number;

  services: LoadState<BookableService[]>;
  artists: LoadState<BookableArtist[]>;
  availability: LoadState<Availability>;

  /**
   * THE BRANCH SWITCH -- step 2's filter strip, not a fifth step.
   *
   * `branchOptions` is EMPTY when there should be no strip at all, which is the
   * common case: a single-branch salon, or a salon whose artists are all
   * unassigned. `domain/branchPicker.ts` owns that rule and argues it at
   * length. The one thing to know here is that a branch is never sent to
   * `POST /bookings` -- it filters the roster, and the booking's branch is
   * derived server-side from the artist she picks.
   */
  branchOptions: BranchChoice[];
  branchChoice: BranchChoice;
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

  const [step, setStep] = useState<StepName>(rescheduling ? 'day' : 'service');
  const [services, setServices] = useState<LoadState<BookableService[]>>({ status: 'loading' });
  const [artists, setArtists] = useState<LoadState<BookableArtist[]>>({ status: 'loading' });
  const [availability, setAvailability] = useState<LoadState<Availability>>({ status: 'loading' });

  const [serviceId, setServiceId] = useState<string | null>(reschedule?.serviceId ?? null);
  const [artistId, setArtistId] = useState<string | null>(reschedule?.artistId ?? null);
  const [selectedSlot, setSelectedSlot] = useState<AvailabilitySlotWire | null>(null);
  const [shortfallFils, setShortfallFils] = useState<number | null>(null);
  const [confirmFailure, setConfirmFailure] = useState<LoadFailure | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<
    { booking: BookingView; balanceAfterFils: number | null } | null
  >(null);
  const [reloadToken, setReloadToken] = useState(0);

  /**
   * The selected filter, and the unfiltered roster's split.
   *
   * `ALL_BRANCHES` is the default, and `branchQuery` maps it to no parameter at
   * all -- so a salon with no strip issues exactly the request this app issued
   * before the picker existed.
   */
  const [branchChoice, setBranchChoice] = useState<BranchChoice>(ALL_BRANCHES);
  const [rosterSplit, setRosterSplit] = useState<RosterSplit | null>(null);

  /**
   * MORE THAN ONE OPEN BRANCH IS THE ONLY REASON TO ASK THE SECOND QUESTION.
   *
   * `salon.branches` carries only OPEN branches. Below two there is no strip
   * whatever the roster looks like, so the `?branch=unassigned` read below is
   * not made at all and a single-branch salon's network traffic is unchanged.
   */
  const multiBranch = salon.branches.length >= 2;

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
    setArtists({ status: 'loading' });
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
      .then((data) => setArtists({ status: 'ready', data }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setArtists({ status: 'failed', failure: toFailure(err) });
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
   * A FAILURE HERE IS NOT A FAILED SCREEN. If the split cannot be read, the
   * strip stays absent and step 2 renders exactly as it does today -- the
   * roster is what she needs, and losing a filter is not worth losing the
   * booking flow over. The failure of the read that matters is already surfaced
   * by the effect above.
   */
  useEffect(() => {
    if (!multiBranch) {
      setRosterSplit(null);
      return;
    }
    const controller = new AbortController();
    setRosterSplit(null);
    Promise.all([
      getArtists(salon.id, undefined, controller.signal),
      getArtists(salon.id, 'unassigned', controller.signal),
    ])
      .then(([all, unassigned]) =>
        setRosterSplit({ total: all.length, unassigned: unassigned.length }),
      )
      .catch(() => {
        if (controller.signal.aborted) return;
        setRosterSplit(null);
      });
    return () => controller.abort();
  }, [salon.id, reloadToken, multiBranch]);

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

  const selectedService =
    services.status === 'ready' ? (services.data.find((s) => s.id === serviceId) ?? null) : null;
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

  const pickService = useCallback((service: BookableService) => {
    setServiceId(service.id);
    setConfirmFailure(null);
  }, []);

  /**
   * Narrow the roster to a location -- or to the artists who have none.
   *
   * IT CLEARS THE ARTIST AND THE SLOT, for the same reason `pickArtist` clears
   * the slot: the artist she had picked may not be in the list she is about to
   * see, and a selection that survives out of view is a Continue button that
   * looks enabled for a row nobody can point at. `selectedArtist` is derived
   * from the visible list, so it would already read null -- clearing `artistId`
   * as well means there is no hidden second answer to "who is booked" waiting
   * to reappear if she taps back to All.
   *
   * The strip does NOT re-render itself out of existence on a filter change:
   * `rosterSplit` is keyed off the unfiltered read, so it does not move here.
   */
  const pickBranch = useCallback((choice: BranchChoice) => {
    setBranchChoice((current) => (sameChoice(current, choice) ? current : choice));
    setArtistId(null);
    setSelectedSlot(null);
    setConfirmFailure(null);
  }, []);

  const pickArtist = useCallback((artist: BookableArtist) => {
    setArtistId(artist.id);
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

  const next = useCallback(() => {
    setStep((s) => (s === 'service' ? 'artist' : s === 'artist' ? 'day' : s === 'day' ? 'review' : s));
  }, []);

  const back = useCallback(() => {
    setStep((s) => {
      if (s === 'review') return 'day';
      // A reschedule starts at the grid, so stepping back out of it leaves the
      // flow rather than walking into an artist picker she never saw.
      if (s === 'day') return rescheduling ? 'day' : 'artist';
      if (s === 'artist') return 'service';
      return s;
    });
  }, [rescheduling]);

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
   * The chips, or an empty array meaning "no strip". `branches` is passed
   * straight through -- the salons route serves only OPEN branches, which is
   * the same reading `resolveBranch` takes when it decides whether a branch was
   * established.
   */
  const branchOptions = useMemo(
    () => branchChoices({ branches: salon.branches, split: rosterSplit }),
    [salon.branches, rosterSplit],
  );

  const stepIndex = step === 'service' ? 1 : step === 'artist' ? 2 : step === 'day' ? 3 : 4;

  return {
    step,
    stepIndex,
    services,
    artists,
    availability,
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
export function useUpcoming(options: { enabled: boolean; onChanged: () => void }): UpcomingState {
  const { enabled, onChanged } = options;
  const [status, setStatus] = useState<UpcomingState['status']>('loading');
  const [bookings, setBookings] = useState<BookingView[]>([]);
  const [failure, setFailure] = useState<LoadFailure | null>(null);
  const [actionFailure, setActionFailure] = useState<LoadFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setStatus('loading');
    getBookings('deposit_held', controller.signal)
      .then((items) => {
        setBookings(items);
        setFailure(null);
        setStatus('ready');
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setFailure(toFailure(err));
        setStatus('failed');
      });
    return () => controller.abort();
  }, [enabled, token]);

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
