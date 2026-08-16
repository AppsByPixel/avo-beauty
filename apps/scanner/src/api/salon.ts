/**
 * The salon, read once after sign-in.
 *
 * The scanner needs exactly two things from it, and both are display concerns
 * the member row cannot answer on its own:
 *
 *   loyaltyMode   whether to draw stamp dots or a tier pill
 *   stampTarget   the denominator in "4 / 8"
 *
 * `Member` carries `stamps` and `tier`, but not the target the stamps count
 * towards — that belongs to the salon's loyalty configuration, and the schema
 * CHECK `salon_loyalty_config_complete` guarantees the half that matters is
 * present for whichever mode is set.
 *
 * `GET /salons/{id}` requires a principal and the caller's own salon
 * (api/src/routes/salons.ts:48-49), so this is only callable once signed in —
 * which is why the PIN screen's branding comes from the build instead
 * (src/config/brand.ts).
 */

import { SalonSchema } from '@avo/types';
import { getJson } from './client';

export interface SalonLoyalty {
  mode: 'tiers' | 'stamps';
  /** Null at a tiers salon. */
  stampTarget: number | null;
  name: string;
}

export async function fetchSalonLoyalty(
  salonId: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<SalonLoyalty> {
  const salon = await getJson(`/salons/${encodeURIComponent(salonId)}`, SalonSchema, accessToken, signal);
  return {
    mode: salon.loyaltyMode,
    stampTarget: salon.loyaltyMode === 'stamps' ? (salon.stampTarget ?? null) : null,
    name: salon.name,
  };
}
