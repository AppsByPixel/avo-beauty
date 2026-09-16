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

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * DRIFT (8) — THE SAME TRAP, ONE FIELD LATER
 * ═════════════════════════════════════════════════════════════════════════════
 * `GET /artists/me/bookings` now also sends `voidReason` — `'wrong' | 'dupe' |
 * 'cust' | null`, the code the till recorded for the reversal (migration 0050,
 * `transaction.void_reason_code`). The schema above is still a plain zod object,
 * so until it NAMES the key, `strip` deletes it between the socket and the
 * screen exactly as it deleted `chargeVoided`, and nothing throws.
 *
 * THE FIXTURE IS NOT TRANSCRIBED FROM A COMMENT. It is the body this lane pulled
 * off `http://localhost:4700/artists/me/bookings` on `avo_lane_b` after driving
 * the real path: Dana books Hessa, the till charges her against the held
 * deposit, a manager voids with `reasonCode: 'cust'`, and Hessa signs in on the
 * scanner. That matters here more than usual — this repo's standing failure is a
 * fixture that agrees with the prose rather than with the wire.
 */
const CUST_WIRE = {
  id: 'BK-4551443',
  memberId: '8842',
  artistId: 'AR-003',
  branchId: 'BR-KWC',
  serviceId: 'SV-01',
  startsAt: '2026-09-16T10:19:19.523Z',
  endsAt: '2026-09-16T10:49:19.523Z',
  durationMin: 30,
  depositFils: 5000,
  status: 'cancelled',
  source: 'app',
  noShowReturnDueAt: '2026-09-16T11:49:19.523Z',
  changeableUntil: '2026-09-16T09:19:19.523Z',
  rescheduledCount: 0,
  calendarSyncState: 'not_applicable',
  memberName: 'Dana Al-Sabah',
  memberErased: false,
  memberPhone: '+96599124408',
  memberTier: 'silver',
  serviceName: 'Blow-dry',
  chargeVoided: true,
  voidReason: 'cust',
};

describe('voidReason survives the parse', () => {
  /**
   * THE REGRESSION. Before the schema named it this read `undefined`, and the
   * only screen an artist can open would have gone on saying "Payment voided"
   * and nothing else while the server was already telling it which of three
   * things had been said about her work.
   */
  it('arrives as the code the till recorded, and is not stripped', () => {
    const parsed = ArtistBookingSchema.parse(CUST_WIRE);
    console.log('parsed keys:', Object.keys(parsed).join(','));
    console.log('voidReason  :', JSON.stringify(parsed.voidReason));
    expect(parsed).toHaveProperty('voidReason');
    expect(parsed.voidReason).toBe('cust');
  });

  /**
   * The negative control, and it is the one that matters most here. `.default(null)`
   * below means an absent key ALSO reads null, so an assertion that only ever
   * sees `null` proves nothing about whether the schema is reading the wire.
   * These two bodies differ in one key, and the live route emits `voidReason` on
   * EVERY row — the `null` here is transcribed from the same socket, on the same
   * booking, before it was voided.
   */
  it('arrives as null on a booking whose void recorded no code', () => {
    expect(ArtistBookingSchema.parse({ ...CUST_WIRE, voidReason: null }).voidReason).toBeNull();
  });

  it('carries the other two codes verbatim', () => {
    expect(ArtistBookingSchema.parse({ ...CUST_WIRE, voidReason: 'wrong' }).voidReason).toBe('wrong');
    expect(ArtistBookingSchema.parse({ ...CUST_WIRE, voidReason: 'dupe' }).voidReason).toBe('dupe');
  });

  /**
   * A FOURTH VALUE IS REFUSED RATHER THAN RENDERED.
   *
   * `POST /voids` used to accept any non-empty string as a reason, and
   * `reasonCode: 'she_is_lazy'` returned 200 and moved the money; Lane A closed
   * that with a handler check AND `transaction_void_reason_code_valid`, so
   * exactly three values can reach this wire. The enum here is the third lock,
   * and it is not redundant: it is the one that stops a code this client cannot
   * translate from reaching `copy.voidReasons.find(...)`, missing, and falling
   * through to render the RAW CODE on her card. "she_is_lazy" must never be a
   * string this app is capable of drawing.
   *
   * It fails the whole parse rather than degrading to null, which is the correct
   * direction for a value that is meant to be closed: a null would say "no
   * reason recorded", which is a different and false statement.
   */
  it('refuses a code outside the three, rather than drawing it', () => {
    const bad = ArtistBookingSchema.safeParse({ ...CUST_WIRE, voidReason: 'she_is_lazy' });
    console.log('she_is_lazy parse:', bad.success ? 'ACCEPTED' : 'refused');
    expect(bad.success).toBe(false);
  });

  /**
   * WHY `.default(null)` RATHER THAN A REQUIRED FIELD — argued, not inherited.
   *
   * A required `z.enum([...]).nullable()` throws inside `fetchMyBookings` the
   * moment it meets a body without the key, and `fetchMyBookings` has no
   * per-field recovery: her ENTIRE DAY fails to load. The key is absent on
   * exactly one kind of server — one rolled back behind migration 0050 — and
   * trading her whole screen for a distinction is the trade `memberErased` and
   * `chargeVoided` both already refused above.
   *
   * WHAT IT COSTS, stated rather than waved past: `.default(null)` collapses
   * "this void recorded no code" into "this API is too old to say". The endpoint
   * comment insists on that distinction and it is real on the wire.
   *
   * `.optional()` would have preserved it — `undefined` for absent, `null` for
   * recorded-nothing — at the same safety, and it was the alternative considered.
   * It is NOT taken because the two silences render identically and always will:
   * the screen's answer to both is to say nothing (see `BookingsScreen` §
   * `voidReasonLine`), the artist cannot see which she is looking at, and there
   * is nothing she could do differently if she could. A third state in the type
   * that no reader may act on differently is not information — it is an
   * invitation to write the sentence "no reason was recorded", which would be
   * false on a rolled-back server.
   */
  it('reads a body that omits it as no-code, rather than failing her whole day', () => {
    const { voidReason, ...older } = CUST_WIRE;
    void voidReason;
    const parsed = ArtistBookingSchema.safeParse(older);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.voidReason).toBeNull();
  });

  /**
   * THE IMPLICATION ONLY RUNS ONE WAY, and the parse must not invent the other.
   * `voidReason` non-null implies `chargeVoided`; `chargeVoided` emphatically
   * does not imply `voidReason` (api/src/routes/bookings.ts § voidReason). A
   * voided booking with no code is the ordinary shape of every void taken before
   * migration 0050, and it must parse.
   */
  it('accepts a reversal that carries no code at all', () => {
    const parsed = ArtistBookingSchema.parse({ ...CUST_WIRE, voidReason: null });
    expect(parsed.chargeVoided).toBe(true);
    expect(parsed.voidReason).toBeNull();
  });
});
