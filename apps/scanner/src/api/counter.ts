/**
 * What the counter needs to serve one customer — the client half of the
 * envelope, and like the server's, there is exactly ONE of it.
 *
 * WHY THIS FILE EXISTS RATHER THAN A SCHEMA IN EACH CALLER
 * -------------------------------------------------------
 * A staff member reaches a customer two ways: she scans her code
 * (`POST /scans`), or her phone is flat and the artist looks her up and opens
 * her (`GET /members/{id}`). Both routes return the same body, because both call
 * one builder — api/src/services/counter.ts § counterEnvelope, which says in its
 * own header why it is one function and not two handlers: built twice they
 * drift, and the last time they drifted the held deposit was `0` on one path and
 * real on the other, so the credit line the customer was SHOWN and the credit the
 * charge APPLIED were different numbers.
 *
 * A client that parsed the same body with two schemas would reintroduce that
 * from the other end. So the schema is here, once, and `scans.ts` and
 * `members.ts` both import it.
 *
 * WIDENED, NOT NARROWED — `heldDepositBooking`
 * --------------------------------------------
 * `ScanResultSchema` used to declare `{ member, heldDepositFils, services }` and
 * the server has been sending `heldDepositBooking` alongside them. Zod does not
 * fail on an undeclared field, it STRIPS it, so the field arrived and was thrown
 * away silently — the sixth instance of the drift this project keeps finding
 * (STATUS.md § "The trap that keeps reappearing"). Declared here, so it survives.
 *
 * It is not decoration. `heldDepositFils` alone says "5.000 is credited"; the
 * booking says WHICH appointment it came from, which is the question the customer
 * asks at the counter and the one the artist currently cannot answer.
 */

import { z } from 'zod';
import { DateTimeSchema, FilsSchema, IdSchema, MemberSchema } from '@avo/types';

export const CounterServiceSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  priceFils: FilsSchema.nonnegative(),
});

/**
 * The booking a held deposit came from.
 *
 * Nullable rather than optional: the server sends `null` when nothing is held
 * rather than omitting the key, deliberately, so "no deposit" is a fact the
 * client reads instead of an absence it has to interpret. Kept nullable here for
 * the same reason — `undefined` would make "this API is too old to say"
 * indistinguishable from "she has no appointment".
 */
export const HeldDepositBookingSchema = z.object({
  id: IdSchema,
  startsAt: DateTimeSchema,
  serviceId: IdSchema,
  artistId: IdSchema,
});

export const CounterEnvelopeSchema = z.object({
  member: MemberSchema,
  /**
   * A deposit already held against a booking, applied automatically as a credit
   * line on the charge — design/AVO Staff Scanner.dc.html:354, and §Charging in
   * api-contract.md.
   *
   * The server recomputes this inside the charge transaction through the SAME
   * `findApplicableHold`, so this number is what the counter shows and not what
   * the charge promises. A booking the no-show job returns in the second between
   * the two shows a credit line the charge then declines to apply — correct, and
   * the reason the charge recomputes rather than trusting this.
   */
  heldDepositFils: FilsSchema.nonnegative(),
  heldDepositBooking: HeldDepositBookingSchema.nullable(),
  services: z.array(CounterServiceSchema),
});

export type CounterService = z.infer<typeof CounterServiceSchema>;
export type HeldDepositBooking = z.infer<typeof HeldDepositBookingSchema>;
export type CounterEnvelope = z.infer<typeof CounterEnvelopeSchema>;
