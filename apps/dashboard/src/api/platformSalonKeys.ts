/**
 * The console's salon cache keys, on their own, so two modules can invalidate
 * the same rows without importing each other.
 *
 * WHY THIS IS A FILE AND NOT THREE LINES IN `platformSalons.ts`, WHERE IT WAS.
 *
 * `platformSalons.ts` imports `TIER_LADDER` from `loyalty.ts` — "imported rather
 * than restated, because a second local copy of bronze → silver → gold → black is
 * how a client comes to draw five rows against a server that accepts four". The
 * loyalty authority reversal put a write in the other direction: the console's
 * `PUT /salons/{id}/loyalty` changes `loyaltyMode`, `tiers` and `stampTarget`, and
 * all three are fields of `GET /v1/platform/salons` and its detail route. A publish
 * that does not invalidate those leaves the Salons LIST reading "Tiers" for a salon
 * just moved to stamps.
 *
 * So `loyalty.ts` needs these keys and `platformSalons.ts` needs `loyalty.ts`. The
 * alternative to this file is a cycle, or a second literal `['platform','salons']`
 * in the module that publishes — and a cache key spelled in two places is the same
 * drift the `TIER_LADDER` import exists to prevent, with a quieter symptom: nothing
 * fails, a screen is just stale.
 *
 * A leaf. It imports nothing.
 */

export const platformSalonKeys = {
  list: ['platform', 'salons'] as const,
};

/** Keyed under the list, so a salon's row and its editor invalidate together. */
export function platformSalonDetailKey(id: string) {
  return [...platformSalonKeys.list, 'detail', id] as const;
}
