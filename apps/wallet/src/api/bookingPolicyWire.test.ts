/**
 * The booking policy on the wire (migration 0066): the read, the version sent
 * with the booking, the key sent with the cancel, and the cancel's answer.
 *
 * Through `fetch`, so the header and the body the API actually receives are
 * what is asserted — not the arguments of a mocked function.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cancelBooking, createBooking, getBookingPolicy } from './booking';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function stub(respond: (c: Call) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
    const call = {
      url,
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return Promise.resolve(respond(call));
  });
  return calls;
}

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

/** The body `serialiseBooking` sends since 0066 — guest fields absent, as served. */
const BOOKING = {
  id: 'BK-1',
  memberId: 'M-1',
  artistId: 'AR-1',
  branchId: 'BR-1',
  serviceId: 'SV-1',
  startsAt: '2026-10-01T13:00:00.000Z',
  endsAt: '2026-10-01T14:00:00.000Z',
  durationMin: 60,
  depositFils: 5005,
  status: 'cancelled',
  source: 'app',
  changeableUntil: '2026-10-01T12:00:00.000Z',
  noShowReturnDueAt: '2026-10-01T14:00:00.000Z',
  rescheduledCount: 0,
  calendarSyncState: 'not_applicable',
  policy: {
    id: 'BP-3',
    version: 3,
    noShow: 'keep',
    cancellation: [{ hoursBefore: 24, returnPercent: 50 }],
    text: { en: 'Terms.', ar: '' },
  },
  settlement: { returnedFils: 2502, keptFils: 2503 },
  returnCapPercent: null,
};

const POLICY = {
  id: 'BP-3',
  salonId: 'SAL-AMARA',
  version: 3,
  noShow: 'keep',
  cancellation: [{ hoursBefore: 24, returnPercent: 50 }],
  text: { en: 'Terms.', ar: '' },
  publishedAt: '2026-09-28T10:00:00.000Z',
};

describe('GET /salons/{id}/booking-policy', () => {
  it('returns the policy', async () => {
    const calls = stub(() => json({ policy: POLICY }));
    expect(await getBookingPolicy('SAL-AMARA')).toEqual(POLICY);
    expect(new URL(calls[0]!.url).pathname).toBe('/salons/SAL-AMARA/booking-policy');
  });

  it('returns null for a salon that has never published one — a fact, not a 404', async () => {
    stub(() => json({ policy: null }));
    expect(await getBookingPolicy('SAL-AMARA')).toBeNull();
  });
});

describe('POST /bookings carries the version she was shown', () => {
  it('sends policyVersion in the body, beside the key', async () => {
    const calls = stub(() =>
      json({ booking: { ...BOOKING, status: 'deposit_held', settlement: null }, balanceAfterFils: 0, transaction: undefined }, 201),
    );
    await createBooking(
      { artistId: 'AR-1', serviceId: 'SV-1', startsAt: BOOKING.startsAt, policyVersion: 3 },
      'key-1',
    ).catch(() => undefined); // the transaction fixture is not the point here
    expect(calls[0]!.body).toEqual({ artistId: 'AR-1', serviceId: 'SV-1', startsAt: BOOKING.startsAt, policyVersion: 3 });
    expect(calls[0]!.headers['idempotency-key']).toBe('key-1');
  });
});

describe('DELETE /bookings/{id}', () => {
  it('sends the Idempotency-Key the caller minted', async () => {
    const calls = stub(() =>
      json({
        booking: BOOKING,
        refundedFils: 2502,
        keptFils: 2503,
        returnPercent: 50,
        rule: { hoursBefore: 24, returnPercent: 50 },
        balanceAfterFils: 22502,
        transactionId: 'TX-9',
        forfeitTransactionId: 'TX-10',
      }),
    );
    const out = await cancelBooking('BK-1', 'cancel-key-1');
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.headers['idempotency-key']).toBe('cancel-key-1');
    expect(out.refundedFils).toBe(2502);
    expect(out.keptFils).toBe(2503);
    expect(out.booking.settlement).toEqual({ returnedFils: 2502, keptFils: 2503 });
    expect(out.booking.policy?.version).toBe(3);
  });

  it('parses a result whose transactionId is null — nothing came back', async () => {
    stub(() =>
      json({
        booking: { ...BOOKING, settlement: { returnedFils: 0, keptFils: 5005 } },
        refundedFils: 0,
        keptFils: 5005,
        returnPercent: 0,
        rule: null,
        balanceAfterFils: 20000,
        transactionId: null,
        forfeitTransactionId: 'TX-10',
      }),
    );
    const out = await cancelBooking('BK-1', 'cancel-key-2');
    expect(out.transactionId).toBeNull();
    expect(out.refundedFils).toBe(0);
  });

  it('409 appointment_started arrives as its code', async () => {
    stub(() =>
      json(
        { error: 'appointment_started', message: 'That appointment has already started, so it can no longer be cancelled.', startsAt: BOOKING.startsAt },
        409,
      ),
    );
    const err = await cancelBooking('BK-1', 'k').catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe('appointment_started');
  });
});
