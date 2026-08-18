/**
 * The counter envelope, pinned to what the server actually sends — on BOTH doors.
 *
 * Every payload below is transcribed from a live response on `avo_lane_b`, not
 * written from the schema. The two were captured in the same second and compared:
 *
 *   GET  /members/8842   (manual lookup, no QR token)
 *   POST /scans          (the same customer, scanned)
 *   -> IDENTICAL ENVELOPE: True
 *
 * That equality is the property this file defends. Both routes call one builder,
 * api/src/services/counter.ts § counterEnvelope, and the client parses both with
 * one schema. If either half is forked, the held deposit can be right on one path
 * and stale on the other — which has already happened once, and the number the
 * customer was SHOWN differed from the credit the charge APPLIED.
 */

import { describe, expect, it } from 'vitest';
import { CounterEnvelopeSchema } from './counter';
import { ScanResultSchema } from './scans';

/**
 * The wire body, field for field, with a held deposit live.
 *
 * The booking had to be moved INSIDE the no-show grace window to produce this.
 * A booking 2h40m out returned `heldDepositFils: 0` against a real 5.000 hold,
 * because `findApplicableHold` requires `startsAt <= now + noShowReturnMinutes`.
 * That zero looks exactly like a bug and is not one; it has been read as one
 * twice. Both payloads are kept below for that reason.
 */
const WIRE_WITH_DEPOSIT = {
  member: {
    id: '8842',
    salonId: 'SAL-AMARA',
    name: 'Dana Al-Sabah',
    phone: '+96599124408',
    email: 'dana@example.com',
    emailVerified: true,
    balanceFils: 19500,
    visits: 5,
    tier: 'silver',
    stamps: null,
    policyVersion: 3,
    joinedAt: '2026-08-18T10:18:26.053Z',
  },
  heldDepositFils: 5000,
  heldDepositBooking: {
    id: 'BK-6432117',
    startsAt: '2026-08-18T10:19:33.029Z',
    serviceId: 'SV-01',
    artistId: 'AR-001',
  },
  services: [
    { id: 'SV-01', name: 'Blow-dry', priceFils: 8000 },
    { id: 'SV-02', name: 'Cut & style', priceFils: 15000 },
  ],
};

/** The same customer and the same real booking, read 74 seconds earlier. */
const WIRE_OUTSIDE_WINDOW = {
  ...WIRE_WITH_DEPOSIT,
  heldDepositFils: 0,
  heldDepositBooking: null,
};

describe('the counter envelope', () => {
  it('accepts the body the server actually sends', () => {
    expect(CounterEnvelopeSchema.safeParse(WIRE_WITH_DEPOSIT).success).toBe(true);
  });

  it('KEEPS heldDepositBooking instead of stripping it', () => {
    /*
      The regression this file is here for. `ScanResultSchema` declared only
      `{ member, heldDepositFils, services }` while the server had been sending
      `heldDepositBooking` alongside them for as long as bookings have existed.
      Zod does not fail on an undeclared field, it STRIPS it — so the field
      arrived on every scan and was discarded before any screen could read it.

      `heldDepositFils` alone says "5.000 is credited". Only the booking says
      WHICH appointment it came from, which is the question the customer asks at
      the counter.
    */
    const parsed = CounterEnvelopeSchema.parse(WIRE_WITH_DEPOSIT);
    expect(parsed.heldDepositBooking).not.toBeUndefined();
    expect(parsed.heldDepositBooking?.id).toBe('BK-6432117');
    expect(parsed.heldDepositBooking?.artistId).toBe('AR-001');
  });

  it('accepts a null booking, and keeps null distinguishable from absent', () => {
    /*
      The server sends `null` rather than omitting the key, deliberately, so a
      scanner can tell "she has no appointment" from "this API is too old to
      say". Declaring the field OPTIONAL would collapse those two into
      `undefined` and throw the distinction away.
    */
    const parsed = CounterEnvelopeSchema.parse(WIRE_OUTSIDE_WINDOW);
    expect(parsed.heldDepositBooking).toBeNull();
    expect(parsed.heldDepositFils).toBe(0);

    const omitted: Record<string, unknown> = { ...WIRE_WITH_DEPOSIT };
    delete omitted.heldDepositBooking;
    expect(CounterEnvelopeSchema.safeParse(omitted).success).toBe(false);
  });

  it('is the SAME schema the scan path uses, not a copy of it', () => {
    /*
      Identity, not equivalence. Two structurally identical schemas would pass a
      shape comparison today and drift apart the first time one is edited — which
      is precisely how the held deposit came to be `0` on one path and real on the
      other. `scans.ts` re-exports this schema; it must not declare its own.
    */
    expect(ScanResultSchema).toBe(CounterEnvelopeSchema);
  });

  it('requires the member, so a manual card can never render an invented balance', () => {
    /*
      The manual path's whole reason for needing this endpoint. `GET /members?q=`
      returns a directory row with no `balanceFils`; the flow used to fabricate
      one. If `member` ever became optional, that card could render again with a
      made-up figure on the screen where money moves (non-negotiable #2).
    */
    const noMember: Record<string, unknown> = { ...WIRE_WITH_DEPOSIT };
    delete noMember.member;
    expect(CounterEnvelopeSchema.safeParse(noMember).success).toBe(false);
  });

  it('refuses a fractional or negative deposit — money is integer fils', () => {
    // Non-negotiable #1. A float reaching a credit line is a float reaching money.
    expect(
      CounterEnvelopeSchema.safeParse({ ...WIRE_WITH_DEPOSIT, heldDepositFils: 5000.5 }).success,
    ).toBe(false);
    expect(
      CounterEnvelopeSchema.safeParse({ ...WIRE_WITH_DEPOSIT, heldDepositFils: -5000 }).success,
    ).toBe(false);
  });

  it('refuses a fractional service price for the same reason', () => {
    expect(
      CounterEnvelopeSchema.safeParse({
        ...WIRE_WITH_DEPOSIT,
        services: [{ id: 'SV-01', name: 'Blow-dry', priceFils: 8.0005 }],
      }).success,
    ).toBe(false);
  });

  it('accepts an empty service list without inventing one', () => {
    // A salon mid-setup. The card renders no chips rather than failing to open.
    const parsed = CounterEnvelopeSchema.parse({ ...WIRE_WITH_DEPOSIT, services: [] });
    expect(parsed.services).toEqual([]);
  });
});
