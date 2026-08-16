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
 * So: `EnrolScreen` runs once and is never seen again, and the designed PIN
 * screen is untouched.
 *
 * REPORTED, NOT DECIDED HERE: real enrolment is a provisioning flow — a manager
 * signs in on the dashboard, generates a pairing code, the phone redeems it and
 * receives its device binding. That needs an endpoint that does not exist, and
 * inventing one is a lane-A decision. Until it does, enrolment is typed in
 * once on the device, which is fine for a pilot on hardware the salon owns and
 * is NOT fine for general release. See the report.
 *
 * The PIN itself is never stored here. Only the access token is, and it is
 * scoped to `scanner` (non-negotiable #6).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'avo.scanner.device.v1';

export interface DeviceBinding {
  salonId: string;
  /** The staff handle this phone is enrolled for. */
  handle: string;
  /**
   * The device id the PIN is bound to. It must match `staff_user.pin_device_id`
   * on the server, so it is not generated randomly here — it is entered at
   * enrolment to match what the salon provisioned.
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
 * The seeded pilot device, offered as the enrolment default.
 *
 * api/src/db/seed.ts — SALON_ID 'SAL-AMARA', SCANNER_DEVICE 'DEV-SCANNER-01'.
 * These are development fixtures, not credentials: the PIN is the credential
 * and it is not here. Prefilling them is what makes the pilot phone usable
 * without a provisioning flow that does not exist yet.
 */
export const ENROL_DEFAULTS: DeviceBinding = {
  salonId: 'SAL-AMARA',
  handle: '',
  deviceId: 'DEV-SCANNER-01',
};
