/**
 * The salon's name and initial on the PIN screen — build-time, not fetched.
 *
 * WHY THIS IS NOT AN API CALL
 * ---------------------------
 * design/AVO Staff Scanner.dc.html:75-77 puts the salon logo and name above the
 * PIN pad, i.e. BEFORE anyone is signed in. There is no endpoint that can serve
 * it there: `GET /salons/{id}` requires a principal and the caller's salon to
 * match (api/src/routes/salons.ts:48-49), and a scanner has no principal until
 * a PIN is accepted.
 *
 * That is not a gap — it is the white-label model working as designed.
 * go-live-checklist.md requires "a pipeline producing a per-salon app from one
 * brand token, name, logo and typography pairing with no code change", and
 * ADR-0001 § White-label model rejects branch-per-brand in favour of exactly
 * this. The salon's identity belongs to the BUILD, not to a request.
 *
 * So the name comes from the environment at bundle time. `Amara` is the
 * design's own default (`P.salonName || 'Amara'`, :581), used when nothing is
 * configured.
 *
 * STILL OWED, AND REPORTED: the brand COLOUR is part of the same white-label
 * set, and `deriveBrandSet()` in @avo/tokens exists to validate it
 * (non-negotiable #9 — reject a hex that cannot produce a 4.5:1 fill). Wiring
 * a per-salon hex through this module belongs with the onboarding pipeline that
 * generates these builds, which does not exist yet. Until it does the scanner
 * ships the default sage from the token file, which is already validated.
 */

const SALON_NAME = process.env['EXPO_PUBLIC_AVO_SALON_NAME'] ?? 'Amara';

export const brand = {
  salonName: SALON_NAME,
  /** design:766 — `salonName.trim().charAt(0).toUpperCase()`. */
  initial: SALON_NAME.trim().charAt(0).toUpperCase(),
} as const;
