/**
 * The salon, read once after sign-in.
 *
 * The scanner needs three things from it, and all three are display concerns the
 * member row cannot answer on its own:
 *
 *   loyaltyMode   whether to draw stamp dots or a tier pill
 *   stampTarget   the denominator in "4 / 8"
 *   name          the heading over the PIN pad and on Home
 *
 * `Member` carries `stamps` and `tier`, but not the target the stamps count
 * towards — that belongs to the salon's loyalty configuration, and the schema
 * CHECK `salon_loyalty_config_complete` guarantees the half that matters is
 * present for whichever mode is set.
 *
 * `GET /salons/{id}` requires a principal and the caller's own salon
 * (api/src/routes/salons.ts:48-49), so this is only callable once signed in.
 *
 * WHICH IS WHY IT WRITES TO THE CACHE AS WELL AS RETURNING.
 * The PIN screen renders the salon's name and colour BEFORE there is a principal,
 * so the only way it can show anything true is to remember what this call learned
 * last time. This is the one place in the app that sees a salon's name and brand
 * hex, so it is the one place that records them — `state/salonIdentity.ts` carries
 * the argument, and `Boot.tsx` reads them back at launch. Writing them here rather
 * than at the call site means a second caller cannot forget to.
 */

import { SalonSchema } from '@avo/types';
import { getJson } from './client';
import { writeSalonIdentity } from '../state/salonIdentity';

export interface SalonLoyalty {
  mode: 'tiers' | 'stamps';
  /** Null at a tiers salon. */
  stampTarget: number | null;
  name: string;
  /** The white-label hex. Applied at the NEXT launch — see src/theme/sealed.ts. */
  brandColor: string;
}

export async function fetchSalonLoyalty(
  salonId: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<SalonLoyalty> {
  const salon = await getJson(`/salons/${encodeURIComponent(salonId)}`, SalonSchema, accessToken, signal);
  /*
    Fire-and-forget: the caller is rendering a member card and a cache write must
    never be in that path. `salonId` is stored with the record so a phone
    re-enrolled to a different salon cannot be shown the previous one's name.
  */
  void writeSalonIdentity({ salonId, name: salon.name, brandColor: salon.brandColor });
  return {
    mode: salon.loyaltyMode,
    stampTarget: salon.loyaltyMode === 'stamps' ? (salon.stampTarget ?? null) : null,
    name: salon.name,
    brandColor: salon.brandColor,
  };
}
