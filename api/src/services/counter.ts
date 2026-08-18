/**
 * What the counter needs to serve one customer — the envelope behind both ways
 * of getting there.
 *
 * WHY THIS IS ONE FUNCTION AND NOT TWO HANDLERS
 * --------------------------------------------
 * A staff member reaches a customer by scanning her QR (`POST /scans`) or, when
 * her phone is flat, by looking her up and opening her (`GET /members/{id}`).
 * Those are two doors onto ONE screen: the same name, the same balance, the same
 * held deposit, the same service list to charge against.
 *
 * Built twice, they drift, and this codebase already knows what that costs — the
 * held deposit was hardcoded to `0` on the scan path while the charge path read
 * it for real, so the credit line the customer was shown and the credit the
 * charge applied were two different answers. The rule that came out of that is
 * written in `POST /scans`: two implementations of "does she have a deposit with
 * us right now" is two answers, and the one on the screen is the one the customer
 * is told. A second handler assembling this envelope by hand would reintroduce
 * exactly that, one field at a time.
 *
 * The member is passed in ALREADY SERIALISED and already salon-predicated. This
 * function does not read the member row and cannot widen the tenant boundary: the
 * caller has done that read inside its own salon, which keeps the authorisation
 * decision at the door where the principal is known.
 */

import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { salon } from '../db/schema/salon';
import { service } from '../db/schema/service';
import { findApplicableHold } from './booking';
import type { MemberView } from '../routes/auth';

/** Default when a salon has no explicit no-show window, matching `POST /scans`. */
const DEFAULT_NO_SHOW_RETURN_MINUTES = 60;

export interface CounterEnvelope {
  member: MemberView;
  heldDepositFils: number;
  heldDepositBooking: {
    id: string;
    startsAt: string;
    serviceId: string;
    artistId: string;
  } | null;
  services: Array<{ id: string; name: string; priceFils: number }>;
}

export async function counterEnvelope(
  db: Db,
  member: MemberView,
  salonId: string,
): Promise<CounterEnvelope> {
  const services = await db
    .select({ id: service.id, name: service.name, priceFils: service.priceFils })
    .from(service)
    .where(and(eq(service.salonId, salonId), eq(service.active, true)));

  const [s] = await db
    .select({ noShowReturnMinutes: salon.noShowReturnMinutes })
    .from(salon)
    .where(eq(salon.id, salonId))
    .limit(1);

  /**
   * The SAME function `performCharge` uses — services/booking.ts
   * § findApplicableHold — so what the counter shows before the charge and what
   * the charge actually applies cannot disagree.
   *
   * Unlocked, because this is a read and the charge is the authority. A booking
   * the no-show job returns in the second between this read and that charge shows
   * a credit line the charge then declines to apply — which is correct, and is why
   * the number is recomputed there rather than passed forward from here.
   */
  const held = await findApplicableHold(db, {
    memberId: member.id,
    salonId,
    now: new Date(),
    noShowReturnMinutes: s?.noShowReturnMinutes ?? DEFAULT_NO_SHOW_RETURN_MINUTES,
  });

  return {
    member,
    heldDepositFils: held?.depositFils ?? 0,
    /**
     * Null when nothing is held, rather than omitted, so "no deposit" is a fact
     * the client can read instead of an absence it has to interpret. The staff
     * member has to be able to say WHICH appointment when the customer asks.
     */
    heldDepositBooking: held
      ? {
          id: held.id,
          startsAt: held.startsAt.toISOString(),
          serviceId: held.serviceId,
          artistId: held.artistId,
        }
      : null,
    services,
  };
}
