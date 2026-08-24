/**
 * The salon's name and initial on the PIN screen.
 *
 * WHAT CHANGED, AND WHY THE OLD REASONING ONLY GOT HALFWAY
 * =======================================================
 * This file used to take the name from `EXPO_PUBLIC_AVO_SALON_NAME` at bundle
 * time and argue that it had to, because design/AVO Staff Scanner.dc.html:75-77
 * renders the salon name above the PIN pad and `GET /salons/{id}` needs a
 * principal the PIN screen does not have.
 *
 * The constraint is real. The conclusion was not: it treated the salon as a
 * property of the BUILD, and for this app it is not one. Enrolment types the
 * salon id in on the device (`state/device.ts`) because `POST /staff/session`
 * cannot verify a PIN without it, so one generic scanner build gets bound to a
 * salon at provisioning time and the id is available pre-auth from storage. A
 * per-salon scanner build has nothing to key off — and ADR-0001 § White-label
 * model rejects that shape anyway.
 *
 * So the name now comes from `state/salonIdentity.ts`: cached from the
 * `GET /salons/{id}` the app already makes at sign-in, keyed to the bound salon
 * id, adopted at boot. It is a name the server gave us for this device's own
 * salon — sourced, not fabricated.
 *
 * THE BUILD DEFAULT STAYS, AS A PRE-ENROLMENT FALLBACK, AND THAT IS DELIBERATE
 * ==========================================================================
 * A device that has never completed a sign-in has no cached name, and there is
 * nothing else to show: the id alone cannot be turned into a name without
 * asking the server, and guessing one would put the wrong salon's name over a
 * PIN pad with complete confidence. So the environment default remains, with
 * `Amara` — the design's own default (`P.salonName || 'Amara'`, :581) — behind
 * it. That is the honest value for the one state where nothing better exists.
 *
 * Closing even that needs an unauthenticated salon-identity read (name, brand
 * hex, logo). Precedent exists — `/v1/platform/policies` is "unauthenticated by
 * necessity (a signup screen renders it before there is a session)" — and the
 * customer wallet needs the same endpoint for its own first launch. Reported to
 * Lane A; one endpoint, two surfaces.
 *
 * THE BRAND COLOUR IS NO LONGER OWED. It is applied at boot from the same cached
 * record — see `src/theme/brand.ts`, which routes it through `deriveBrandSet()`
 * and refuses a hex that cannot carry white at 4.5:1 (non-negotiable #9).
 */

/** The pre-enrolment fallback, and only that. */
const BUILD_DEFAULT = process.env['EXPO_PUBLIC_AVO_SALON_NAME'] ?? 'Amara';

let salonName = BUILD_DEFAULT;

/**
 * Adopt a name the server gave us. Called at boot from the cache and again after
 * each successful salon read, so a rename in the dashboard shows up without
 * waiting for a relaunch — unlike the colour, which is frozen into the
 * stylesheets (see `src/theme/sealed.ts`).
 *
 * A blank is ignored rather than stored: `''` would paint an empty heading and an
 * empty initial, which is the failure the API's own CHECK constraint on `nameAr`
 * exists to prevent.
 */
export function adoptSalonName(name: string | null | undefined): void {
  if (typeof name !== 'string' || name.trim() === '') return;
  salonName = name;
}

/** Test seam. Restores the pre-enrolment state without reloading the module. */
export function resetSalonNameToBuildDefault(): void {
  salonName = BUILD_DEFAULT;
}

/**
 * Read at RENDER time, not at module scope — which is why the name, unlike the
 * palette, can change while the app is running. `PinScreen` and `HomeScreen`
 * interpolate `brand.salonName` and `brand.initial` straight into JSX.
 */
export const brand = {
  get salonName(): string {
    return salonName;
  },
  /** design:766 — `salonName.trim().charAt(0).toUpperCase()`. */
  get initial(): string {
    return salonName.trim().charAt(0).toUpperCase();
  },
};
