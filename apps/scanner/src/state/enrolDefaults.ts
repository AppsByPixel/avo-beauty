/**
 * What the manual setup form ("Set up manually") is pre-filled with.
 *
 * DECISIONS.md § "Staff phone pairing, phone sign-in, and a truthful receipt
 * line — Aftab, 2026-11-10": the old typed form stays only as a muted path for
 * the seeded pilot, "with its pre-filled defaults kept under `__DEV__` only".
 *
 * WHY THE DEFAULTS HAD TO LEAVE A RELEASE BUILD. `SAL-AMARA` / `DEV-SCANNER-01`
 * are api/src/db/seed.ts fixtures. On a development build they make the pilot
 * phone usable in one tap. On a release build they were a salon id and a device
 * id belonging to the demo salon, typed into a form a real salon's phone could
 * reach — a binding to someone else's tenant one "Save" away. Not a credential
 * (the PIN is), but not something to hand every install either.
 *
 * A separate module with NO imports, rather than a line in `./device`, because
 * `./device` imports AsyncStorage (React Native) and the scanner's vitest is
 * node-only: the rule is tested here, and `./device` only passes `__DEV__` in.
 */

/** The same shape as `DeviceBinding` in `./device`, restated to keep this import-free. */
export interface EnrolDefaults {
  salonId: string;
  handle: string;
  deviceId: string;
}

/** api/src/db/seed.ts — SALON_ID 'SAL-AMARA', SCANNER_DEVICE 'DEV-SCANNER-01'. */
export const SEEDED_PILOT: EnrolDefaults = {
  salonId: 'SAL-AMARA',
  handle: '',
  deviceId: 'DEV-SCANNER-01',
};

const BLANK: EnrolDefaults = { salonId: '', handle: '', deviceId: '' };

/** The seeded pilot on a development build; three empty fields on a release one. */
export function enrolDefaults(isDev: boolean): EnrolDefaults {
  return isDev ? { ...SEEDED_PILOT } : { ...BLANK };
}
