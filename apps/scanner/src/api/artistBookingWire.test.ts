/**
 * THE FIELD ARRIVES. That is the whole claim, and no render test can make it.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * DRIFT (7) — A SCHEMA NARROWER THAN THE WIRE IS LOSSY, SILENTLY
 * ═════════════════════════════════════════════════════════════════════════════
 * `ArtistBookingSchema` is a plain zod object, so zod's default `strip` applies:
 * a key the schema does not name is DELETED on arrival and nothing anywhere
 * throws. `GET /artists/me/bookings` began sending `chargeVoided` — the server's
 * own answer to "is this cancellation a reversal?", decided from
 * `transaction.reverses_transaction_id`, which has exactly one writer in the
 * whole API behind a unique index — and the parse was eating it.
 *
 * A card test cannot catch that. Feed `BookingCard` a fixture object directly
 * and the field is there, because nothing stripped it; the loss happens between
 * the socket and the component, at the one line no component test crosses. So
 * this file parses WIRE BODIES and asserts on the parse result, never on a
 * rendered tree.
 *
 * Every fixture below is transcribed from `api/src/routes/bookings.ts`'s own
 * `reply.send` — `serialiseBooking(...)` spread, then the five joined member and
 * service fields, then `chargeVoided`. Nothing on the server can reach an
 * assertion in this file; what is proved is the SCHEMA's behaviour given a
 * payload.
 */

import { describe, expect, it } from 'vitest';
import { ArtistBookingSchema } from './artist';

/**
 * A voided appointment exactly as the route serves it: `status: 'cancelled'`
 * because the void wrote that (api/src/routes/charges.ts § heldBooking), and
 * `chargeVoided: true` because the settling transaction carries
 * `reverses_transaction_id`.
 *
 * The route admits a `cancelled` row to her day ONLY when that id is non-null
 * (api/src/routes/bookings.ts § where), so this pairing is the only shape of
 * `cancelled` that can reach this parse today.
 */
const VOIDED_WIRE = {
  id: 'BK-VOID',
  memberId: 'M-1',
  artistId: 'AR-003',
  branchId: 'BR-1',
  serviceId: 'SV-1',
  startsAt: '2026-09-16T08:00:00.000Z',
  endsAt: '2026-09-16T09:00:00.000Z',
  durationMin: 60,
  depositFils: 5000,
  status: 'cancelled',
  source: 'app',
  changeableUntil: '2026-09-16T06:00:00.000Z',
  noShowReturnDueAt: '2026-09-16T11:00:00.000Z',
  rescheduledCount: 0,
  calendarSyncState: 'synced',
  memberName: 'Dana Al-Fahad',
  memberPhone: '+965 9912 4408',
  memberErased: false,
  memberTier: 'gold',
  serviceName: 'Balayage',
  chargeVoided: true,
};

/** The same route, the ordinary case: settled and NOT reversed. */
const PAID_WIRE = { ...VOIDED_WIRE, id: 'BK-PAID', status: 'completed', chargeVoided: false };

describe('chargeVoided survives the parse', () => {
  /**
   * THE REGRESSION. Before the schema named it, this assertion read
   * `undefined` — the key was deleted between the socket and the screen, and
   * the appointment rendered as an ordinary cancellation.
   */
  it('arrives as true and is not stripped', () => {
    const parsed = ArtistBookingSchema.parse(VOIDED_WIRE);
    console.log('parsed keys:', Object.keys(parsed).join(','));
    expect(parsed).toHaveProperty('chargeVoided');
    expect(parsed.chargeVoided).toBe(true);
  });

  /**
   * The negative control, and it is not decoration. `.default(false)` below
   * means "absent" also reads false, so an assertion that only ever sees `true`
   * proves nothing about whether the schema is READING the wire or merely
   * filling a default. These two bodies differ in one key.
   */
  it('arrives as false on a charge that was not reversed', () => {
    expect(ArtistBookingSchema.parse(PAID_WIRE).chargeVoided).toBe(false);
  });

  /**
   * WHY `.default(false)` RATHER THAN A REQUIRED `z.boolean()`, and what it
   * costs — the same trade `memberErased` above it makes, argued again because
   * the situation is not identical.
   *
   * Lane A's route comment commits to sending this field ALWAYS, "never
   * omitted", so that a client can tell "this was not a reversal" from "this API
   * is too old to say". A `.default(false)` collapses those two into one, which
   * is a real loss on the wire — and it has no consumer HERE, because the two
   * halves of Lane A's fix shipped together: an API too old to send
   * `chargeVoided` is also too old to admit a `cancelled` row to her day at all,
   * so the default can only ever land on rows where false is the truth.
   *
   * What it buys is the failure mode that matters. A required boolean against a
   * rolled-back API throws inside `fetchMyBookings` and her ENTIRE DAY fails to
   * load — a schema-shaped outage traded for a wire-level distinction nothing
   * reads. Same reasoning `memberPhone`'s `.nullable()` records, one field up.
   */
  it('reads a body that omits it as not-a-reversal, rather than failing her whole day', () => {
    const { chargeVoided, ...older } = VOIDED_WIRE;
    void chargeVoided;
    const parsed = ArtistBookingSchema.safeParse({ ...older, status: 'completed' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.chargeVoided).toBe(false);
  });

  /** A string `"true"` is not a boolean. The default must not paper over a type. */
  it('refuses a non-boolean rather than defaulting past it', () => {
    expect(ArtistBookingSchema.safeParse({ ...VOIDED_WIRE, chargeVoided: 'true' }).success).toBe(
      false,
    );
  });
});
