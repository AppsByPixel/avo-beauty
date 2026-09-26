// @vitest-environment jsdom

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FIVE HAND-WRITTEN-APPOINTMENT WRITES — THE REQUEST EACH ONE SENDS
 * ═══════════════════════════════════════════════════════════════════════════
 * `noShowMark.test.tsx`'s split, for its reason: the RENDER tests mock this
 * module wholesale, which is right for what they assert (the gate, the copy, the
 * key discipline) and leaves the hooks themselves unexercised. This drives them.
 *
 * THE THREE GUARANTEES WORTH THE FILE:
 *
 *   1. THE PATH. This API registers ~30 routes under a literal `/v1/…` and ~70
 *      bare, `app.ts` passes no prefix, and `API_BASE_URL` adds none — so the
 *      prefix is whatever the route file typed. A wrong guess is not a compile
 *      error and not a visible failure in a mocked screen test; it is a 404 in
 *      production. `merchantScopeGates.test.ts § resolves every merchant call to
 *      a registered route` is the load-bearing half (it reads both sides off
 *      disk); this pins the five strings a human can read.
 *
 *   2. THE BODY, AND SPECIFICALLY WHAT IS *NOT* IN IT. `POST /salons/{id}/bookings`
 *      reads `hasMember`/`hasGuest` off key PRESENCE and refuses both-or-neither
 *      by name, and refuses `guestPhone` without a guest with a 400 of its own.
 *      The member case must therefore carry no guest keys at all — which is a
 *      property of an object, invisible to the type system, and exactly the kind
 *      of thing a spread quietly reintroduces.
 *
 *   3. THE REFUSAL SURVIVES THE CLIENT. Non-negotiable #7: a hidden button is a
 *      courtesy, the 403 is the control. Every one of these five is drawn behind
 *      a permission gate on the screen AND refused independently by the server,
 *      and the client has to carry the server's own sentence out to the caller
 *      rather than flattening it — the 403's text names the permission and who
 *      can grant it back.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './client.js';

const authedRequest = vi.fn();
vi.mock('../auth/authedRequest.js', () => ({
  authedRequest: (...args: unknown[]) => authedRequest(...args),
}));
vi.mock('../auth/AuthProvider.js', () => ({ useSalonId: () => 'SAL-AMARA' }));

const {
  createBookingBody,
  isSlotTaken,
  useCancelBooking,
  useCompleteBooking,
  useCreateBooking,
  useReassignArtist,
  useRescheduleBooking,
} = await import('./bookings.js');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const BOOKING_ID = 'BK-9d0c1f6a-2b44-4d1e-9f77-5a2e3c8b1d40';
const STARTS_AT = '2026-09-20T13:45:00.000Z';

/** `serialiseBooking(row)` — the contract's fields plus the five computed. */
const WRITTEN = {
  id: BOOKING_ID,
  memberId: 'MB-1a2b3c4d5e',
  guestName: null,
  guestPhone: null,
  artistId: 'AR-1a2b3c4d5e',
  branchId: 'BR-1a2b3c4d5e',
  serviceId: 'SV-1a2b3c4d5e',
  startsAt: STARTS_AT,
  endsAt: '2026-09-20T14:45:00.000Z',
  durationMin: 60,
  /** INTEGER FILS. A merchant booking is 0 by construction — #1 and #2. */
  depositFils: 0,
  status: 'deposit_held' as const,
  source: 'merchant' as const,
  changeableUntil: '2026-09-20T12:45:00.000Z',
  noShowReturnDueAt: '2026-09-20T15:45:00.000Z',
  rescheduledCount: 0,
  calendarSyncState: 'not_applicable' as const,
};

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

/** The `(scope, path, options)` triple of the one call that was made. */
function sentCall(): { scope: string; path: string; options: Record<string, unknown> } {
  expect(authedRequest).toHaveBeenCalledTimes(1);
  const [scope, path, options] = authedRequest.mock.calls[0] as [
    string,
    string,
    Record<string, unknown>,
  ];
  return { scope, path, options: options ?? {} };
}

/* ====================================================== 1 · the five paths = */

describe('the five endpoints are addressed BARE, not under /v1', () => {
  it('creates at /salons/{id}/bookings', async () => {
    authedRequest.mockResolvedValue({ booking: WRITTEN });
    const { result } = renderHook(() => useCreateBooking(), { wrapper: wrapper() });
    await act(async () => {
      result.current.mutate({
        artistId: 'AR-1a2b3c4d5e',
        serviceId: 'SV-1a2b3c4d5e',
        startsAt: STARTS_AT,
        memberId: 'MB-1a2b3c4d5e',
        guestName: null,
        guestPhone: null,
        idempotencyKey: 'KEY-1',
      });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const call = sentCall();
    expect(call.scope).toBe('merchant');
    expect(call.path).toBe('/salons/SAL-AMARA/bookings');
    expect(call.path.startsWith('/v1/')).toBe(false);
    expect(call.options.method).toBe('POST');
  });

  it('reschedules at /salons/{id}/bookings/{bookingId}/reschedule', async () => {
    authedRequest.mockResolvedValue({ booking: WRITTEN, depositCarriedFils: 0 });
    const { result } = renderHook(() => useRescheduleBooking(), { wrapper: wrapper() });
    await act(async () => {
      result.current.mutate({ bookingId: BOOKING_ID, startsAt: STARTS_AT });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const call = sentCall();
    expect(call.path).toBe(`/salons/SAL-AMARA/bookings/${BOOKING_ID}/reschedule`);
    expect(call.options.method).toBe('POST');
    expect(call.options.body).toEqual({ startsAt: STARTS_AT });
  });

  it('reassigns at /salons/{id}/bookings/{bookingId}/reassign', async () => {
    authedRequest.mockResolvedValue({ booking: WRITTEN });
    const { result } = renderHook(() => useReassignArtist(), { wrapper: wrapper() });
    await act(async () => {
      result.current.mutate({ bookingId: BOOKING_ID, artistId: 'AR-9f8e7d6c5b' });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const call = sentCall();
    expect(call.path).toBe(`/salons/SAL-AMARA/bookings/${BOOKING_ID}/reassign`);
    expect(call.options.body).toEqual({ artistId: 'AR-9f8e7d6c5b' });
  });

  it('cancels at /salons/{id}/bookings/{bookingId}/cancel', async () => {
    authedRequest.mockResolvedValue({
      booking: { ...WRITTEN, status: 'cancelled' },
      refundedFils: 0,
      balanceAfterFils: null,
      transactionId: null,
    });
    const { result } = renderHook(() => useCancelBooking(), { wrapper: wrapper() });
    await act(async () => {
      result.current.mutate({ bookingId: BOOKING_ID });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(sentCall().path).toBe(`/salons/SAL-AMARA/bookings/${BOOKING_ID}/cancel`);
  });

  it('completes at /salons/{id}/bookings/{bookingId}/complete', async () => {
    authedRequest.mockResolvedValue({ booking: { ...WRITTEN, status: 'completed' } });
    const { result } = renderHook(() => useCompleteBooking(), { wrapper: wrapper() });
    await act(async () => {
      result.current.mutate({ bookingId: BOOKING_ID });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(sentCall().path).toBe(`/salons/SAL-AMARA/bookings/${BOOKING_ID}/complete`);
  });

  /**
   * THE FOUR TRANSITIONS TAKE NO KEY, AND THAT IS THE SERVER'S SHAPE.
   * `api/src/routes/bookings.ts § IDEMPOTENCY` — they name ONE resource with ONE
   * live state and rely on `FOR UPDATE`, which holds for two DIFFERENT keys as
   * well as for one repeated. Pinned as a NEGATIVE because "add a key to be
   * safe" is exactly the well-meant change that would reach an endpoint that
   * does not read one.
   */
  it('sends an Idempotency-Key on the create and on none of the other four', async () => {
    authedRequest.mockResolvedValue({ booking: WRITTEN });
    const create = renderHook(() => useCreateBooking(), { wrapper: wrapper() });
    await act(async () => {
      create.result.current.mutate({
        artistId: 'AR-1a2b3c4d5e',
        serviceId: 'SV-1a2b3c4d5e',
        startsAt: STARTS_AT,
        memberId: null,
        guestName: 'Walk-in',
        guestPhone: null,
        idempotencyKey: 'KEY-CREATE',
      });
    });
    await waitFor(() => expect(create.result.current.isSuccess).toBe(true));
    expect(sentCall().options.idempotencyKey).toBe('KEY-CREATE');

    for (const [hook, vars] of [
      [useRescheduleBooking, { bookingId: BOOKING_ID, startsAt: STARTS_AT }],
      [useReassignArtist, { bookingId: BOOKING_ID, artistId: 'AR-9f8e7d6c5b' }],
      [useCancelBooking, { bookingId: BOOKING_ID }],
      [useCompleteBooking, { bookingId: BOOKING_ID }],
    ] as const) {
      authedRequest.mockClear();
      authedRequest.mockResolvedValue({
        booking: WRITTEN,
        depositCarriedFils: 0,
        refundedFils: 0,
        balanceAfterFils: null,
        transactionId: null,
      });
      const h = renderHook(() => (hook as () => { mutate: (v: unknown) => void })(), {
        wrapper: wrapper(),
      });
      await act(async () => {
        h.result.current.mutate(vars);
      });
      await waitFor(() => expect(authedRequest).toHaveBeenCalled());
      expect(sentCall().options.idempotencyKey).toBeUndefined();
    }
  });
});

/* ============================================ 2 · the body, and its absences */

describe('the create body carries exactly one identity', () => {
  it('sends memberId and NO guest keys for an existing customer', async () => {
    authedRequest.mockResolvedValue({ booking: WRITTEN });
    const { result } = renderHook(() => useCreateBooking(), { wrapper: wrapper() });
    await act(async () => {
      result.current.mutate({
        artistId: 'AR-1a2b3c4d5e',
        serviceId: 'SV-1a2b3c4d5e',
        startsAt: STARTS_AT,
        memberId: 'MB-1a2b3c4d5e',
        // The form leaves these at null in the member branch; they must not travel.
        guestName: null,
        guestPhone: null,
        idempotencyKey: 'KEY-M',
      });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const body = sentCall().options.body as Record<string, unknown>;
    expect(body).toEqual({
      artistId: 'AR-1a2b3c4d5e',
      serviceId: 'SV-1a2b3c4d5e',
      startsAt: STARTS_AT,
      memberId: 'MB-1a2b3c4d5e',
    });
    /*
     * PRESENCE, NOT VALUE. `toEqual` above already says it, and these say WHY it
     * matters: the route reads `body.guestName !== undefined`, so a `null` here
     * is `hasGuest === true` beside `hasMember === true` and earns 400
     * `identity_required` — "Name an existing customer or a walk-in, not both."
     */
    expect('guestName' in body).toBe(false);
    expect('guestPhone' in body).toBe(false);
  });

  it('sends guestName and guestPhone for a walk-in, and no memberId', async () => {
    authedRequest.mockResolvedValue({ booking: { ...WRITTEN, memberId: null, guestName: 'Mariam' } });
    const { result } = renderHook(() => useCreateBooking(), { wrapper: wrapper() });
    await act(async () => {
      result.current.mutate({
        artistId: 'AR-1a2b3c4d5e',
        serviceId: 'SV-1a2b3c4d5e',
        startsAt: STARTS_AT,
        memberId: null,
        guestName: 'Mariam',
        guestPhone: '+96599124408',
        idempotencyKey: 'KEY-G',
      });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const body = sentCall().options.body as Record<string, unknown>;
    expect(body).toEqual({
      artistId: 'AR-1a2b3c4d5e',
      serviceId: 'SV-1a2b3c4d5e',
      startsAt: STARTS_AT,
      guestName: 'Mariam',
      guestPhone: '+96599124408',
    });
    expect('memberId' in body).toBe(false);
  });

  /**
   * A NAME WITH NO NUMBER IS THE ORDINARY CASE, NOT AN EDGE.
   * `BookingSchema.guestPhone`: "a front desk that has a name and no number must
   * still be able to hold the slot, and a required field here would be filled
   * with `0000000` within a week." An empty string must not reach `parseE164`.
   */
  it('omits guestPhone entirely when the front desk has no number', () => {
    const body = createBookingBody({
      artistId: 'AR-1a2b3c4d5e',
      serviceId: 'SV-1a2b3c4d5e',
      startsAt: STARTS_AT,
      memberId: null,
      guestName: 'Mariam',
      guestPhone: '',
      idempotencyKey: 'KEY-G',
    });
    expect('guestPhone' in body).toBe(false);
    expect(body.guestName).toBe('Mariam');
  });

  /**
   * THE KEY ORDER IS FIXED ON BOTH BRANCHES, which is what makes
   * `AppointmentForm.tsx § submissionKey` allowed to compare two bodies with
   * `JSON.stringify`. If this ever stopped holding, two identical requests would
   * serialise differently, the held key would be re-minted on a retry, and the
   * replay the `Idempotency-Key` exists for would be lost — silently.
   */
  it('writes its keys in one stable order, which the key rule depends on', () => {
    const base = {
      artistId: 'AR-1a2b3c4d5e',
      serviceId: 'SV-1a2b3c4d5e',
      startsAt: STARTS_AT,
      idempotencyKey: 'x',
    };
    expect(
      Object.keys(createBookingBody({ ...base, memberId: 'MB-1', guestName: null, guestPhone: null })),
    ).toEqual(['artistId', 'serviceId', 'startsAt', 'memberId']);
    expect(
      Object.keys(createBookingBody({ ...base, memberId: null, guestName: 'M', guestPhone: '+9651' })),
    ).toEqual(['artistId', 'serviceId', 'startsAt', 'guestName', 'guestPhone']);
  });
});

/* ================================================ 3 · the server's refusals = */

describe('the server refuses independently, and the client carries its sentence', () => {
  /**
   * #7 IN ITS OWN WORDS: the UI hiding a button is a courtesy, not a control.
   * Each of these calls the hook WITH THE PERMISSION OFF — which is what a
   * mid-session revocation looks like from the client's side, since `perms` is
   * the snapshot taken at sign-in — and asserts the refusal reaches the caller
   * with the server's own text intact. `WriteError` renders that text verbatim;
   * a client that flattened it to "Something went wrong" would drop the half
   * that says who can grant the permission back.
   */
  const FORBIDDEN = new ApiError(
    'You need the Void permission for this. A manager can grant it in Accounts.',
    { status: 403, code: 'forbidden' },
  );

  it.each([
    ['create', useCreateBooking, { artistId: 'A', serviceId: 'S', startsAt: STARTS_AT, memberId: 'M', guestName: null, guestPhone: null, idempotencyKey: 'K' }],
    ['reschedule', useRescheduleBooking, { bookingId: BOOKING_ID, startsAt: STARTS_AT }],
    ['reassign', useReassignArtist, { bookingId: BOOKING_ID, artistId: 'AR-9f8e7d6c5b' }],
    ['cancel', useCancelBooking, { bookingId: BOOKING_ID }],
    ['complete', useCompleteBooking, { bookingId: BOOKING_ID }],
  ])('%s surfaces a 403 with the server\'s own sentence', async (_name, hook, vars) => {
    authedRequest.mockRejectedValue(FORBIDDEN);
    const { result } = renderHook(() => (hook as () => { mutate: (v: unknown) => void; error: unknown })(), {
      wrapper: wrapper(),
    });
    await act(async () => {
      result.current.mutate(vars);
    });
    await waitFor(() => expect(result.current.error).toBeTruthy());

    const err = result.current.error as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(403);
    expect(err.message).toBe(
      'You need the Void permission for this. A manager can grant it in Accounts.',
    );
  });

  /**
   * `slot_taken` IS TOLD APART FROM EVERY OTHER 409, because the screen answers
   * it differently: it is recoverable, and the way out is a different time or a
   * different artist. `not_changeable` is a 409 too and must NOT take that
   * branch — the appointment is terminal and there is nothing to retry.
   */
  it('recognises slot_taken and only slot_taken', () => {
    expect(
      isSlotTaken(
        new ApiError('That artist already has an appointment then.', {
          status: 409,
          code: 'slot_taken',
        }),
      ),
    ).toBe(true);

    expect(
      isSlotTaken(
        new ApiError('That appointment can no longer be changed.', {
          status: 409,
          code: 'not_changeable',
        }),
      ),
    ).toBe(false);
    expect(isSlotTaken(new Error('offline'))).toBe(false);
    expect(isSlotTaken(null)).toBe(false);
  });
});
