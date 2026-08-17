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
import type { Artist, Salon } from '@avo/types';
import { ApiError, newIdempotencyKey, type FailureKind } from '../api/client';
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

export type StepName = 'service' | 'artist' | 'day' | 'review' | 'confirmed';

/** The four numbered steps of the design's progress bar. `confirmed` is past it. */
export const TOTAL_STEPS = 4;

export interface LoadFailure {
  kind: FailureKind;
  message: string;
  reference: string;
  /** The API's `error` field, when it sent one. */
  code: string | null;
}

export type LoadState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'failed'; failure: LoadFailure };

function toFailure(err: unknown): LoadFailure {
  if (err instanceof ApiError) {
    return { kind: err.kind, message: err.message, reference: err.reference, code: err.code };
  }
  return {
    kind: 'server',
    message: 'Something went wrong.',
    reference: 'WLT-0000-0000',
    code: null,
  };
}

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
  artists: LoadState<Artist[]>;
  availability: LoadState<Availability>;

  strip: StripDay[];
  selectedDate: string | null;
  selectedService: BookableService | null;
  selectedArtist: Artist | null;
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
  pickArtist: (artist: Artist) => void;
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
  const [artists, setArtists] = useState<LoadState<Artist[]>>({ status: 'loading' });
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

  useEffect(() => {
    const controller = new AbortController();
    setArtists({ status: 'loading' });
    getArtists(salon.id, controller.signal)
      .then((data) =>
        // Retired artists keep their bookings and stop taking new ones —
        // `ArtistSchema.active`. Offering one would produce a 409
        // `artist_not_bookable` after four taps.
        setArtists({ status: 'ready', data: data.filter((a) => a.active) }),
      )
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setArtists({ status: 'failed', failure: toFailure(err) });
      });
    return () => controller.abort();
  }, [salon.id, reloadToken]);

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

  const pickArtist = useCallback((artist: Artist) => {
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

  const stepIndex = step === 'service' ? 1 : step === 'artist' ? 2 : step === 'day' ? 3 : 4;

  return {
    step,
    stepIndex,
    services,
    artists,
    availability,
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
