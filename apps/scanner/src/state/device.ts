/**
 * Device identity — the half of "PIN scoped to a device+salon" that lives on
 * the device.
 *
 * WHY THIS FILE EXISTS, AND WHAT WAS ESCALATED
 * ============================================
 * The design's PIN screen is a salon logo, four dots and a keypad
 * (AVO Staff Scanner.dc.html:72-88). Nothing on it identifies the salon, the
 * device, or which staff member is signing in — the prototype's staff picker
 * (:61-63) sits OUTSIDE the phone frame, in the design-doc's own control panel,
 * so it is scaffolding rather than product.
 *
 * `POST /staff/session` requires four fields:
 *
 *     { salonId, deviceId, handle, pin }
 *
 * (api/src/routes/auth.ts § staffPinSession). Three of them are not on the
 * designed screen, and they cannot be dropped: the PIN is bound to a device
 * (`pinDeviceId`), the rate limit is keyed on device+salon, and `handle` is how
 * the server knows whose PIN to verify.
 *
 * The resolution — and it is the one the contract implies rather than an
 * invention — is that these three are **enrolment**, not sign-in. A salon
 * hands a phone to a stylist once; the phone remembers which salon it belongs
 * to and whose PIN it carries; from then on the screen is the one that was
 * designed, four digits and nothing else. That is what "scoped to a device"
 * means, and it is why `pinDeviceId` is a column on the staff row rather than
 * something the client sends freely.
 *
 * So: setup runs once and is never seen again, and the designed PIN screen is
 * untouched.
 *
 * THE PROVISIONING FLOW THIS FILE ONCE REPORTED AS MISSING NOW EXISTS
 * (DECISIONS.md § "Staff phone pairing, phone sign-in, and a truthful receipt
 * line — Aftab, 2026-11-10"). A manager issues a single-use pairing code from
 * the staff card; the phone redeems it with `POST /staff/pair`, the staff
 * member chooses her PIN on the phone, and the SERVER issues the device id.
 * The binding written here is then `{ salonId, deviceId, handle: staff.handle }`
 * off that response (src/screens/SetupFlow.tsx). The typed form (EnrolScreen)
 * survives only as "Set up manually" for the seeded pilot.
 *
 * The PIN itself is never stored here. Only the access token is, and it is
 * scoped to `scanner` (non-negotiable #6).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { enrolDefaults } from './enrolDefaults';

const KEY = 'avo.scanner.device.v1';

export interface DeviceBinding {
  salonId: string;
  /** The staff handle this phone is enrolled for. */
  handle: string;
  /**
   * The device id the PIN is bound to. It must match `staff_user.pin_device_id`
   * on the server, so it is never generated here: a paired phone takes the one
   * `POST /staff/pair` issued, and the manual form types the one the seed
   * provisioned.
   */
  deviceId: string;
}

export async function readDeviceBinding(): Promise<DeviceBinding | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as DeviceBinding).salonId === 'string' &&
      typeof (parsed as DeviceBinding).handle === 'string' &&
      typeof (parsed as DeviceBinding).deviceId === 'string'
    ) {
      return parsed as DeviceBinding;
    }
    return null;
  } catch {
    // Unreadable storage means an unenrolled device, which is a state the app
    // already handles. It is not worth failing to launch over.
    return null;
  }
}

export async function writeDeviceBinding(binding: DeviceBinding): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(binding));
}

export async function clearDeviceBinding(): Promise<void> {
  await AsyncStorage.removeItem(KEY);
}

/**
 * The manual form's pre-fill: the seeded pilot device on a DEVELOPMENT build,
 * empty fields on a release one.
 *
 * api/src/db/seed.ts — SALON_ID 'SAL-AMARA', SCANNER_DEVICE 'DEV-SCANNER-01'.
 * These are development fixtures, not credentials: the PIN is the credential
 * and it is not here. Since the pairing ruling (DECISIONS.md § Staff phone
 * pairing, Aftab 2026-11-10) a phone is set up by redeeming a pairing code, and
 * the typed form survives only as "Set up manually" for the seeded pilot — so
 * the pilot's ids are offered under `__DEV__` only. See `./enrolDefaults`.
 */
export const ENROL_DEFAULTS: DeviceBinding = enrolDefaults(__DEV__);
