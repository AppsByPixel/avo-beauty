/**
 * What this device knows about its salon before anybody signs in.
 *
 * THE PROBLEM, RESTATED HONESTLY
 * =============================
 * design/AVO Staff Scanner.dc.html:75-77 puts the salon logo and name above the
 * PIN pad — i.e. BEFORE there is a principal. `GET /salons/{id}` needs one, so
 * the old answer was to bake the name into the bundle from
 * `EXPO_PUBLIC_AVO_SALON_NAME`.
 *
 * That answer was half right. The device DOES already know its salon: enrolment
 * writes `{ salonId, handle, deviceId }` to storage (`state/device.ts`) because
 * `POST /staff/session` needs the salon id to verify a PIN at all. So the id is
 * available pre-auth, from local storage rather than from a request.
 *
 * But an id is not a name. Nothing on the device can turn `SAL-AMARA` into
 * "Amara" without asking the server, and inventing one is worse than falling
 * back — a scanner that says the wrong salon's name over the PIN pad is a
 * trust problem at the counter, not a cosmetic one.
 *
 * SO: CACHE WHAT THE APP ALREADY FETCHES
 * ======================================
 * `api/salon.ts` already reads `GET /salons/{id}` on every sign-in and already
 * returns `name` from it (ScannerFlow uses the same call for the loyalty mode).
 * The name is therefore sourced, not fabricated — it came from the server, for
 * this device's own salon id. It is written here on each successful read and read
 * back at boot, so the PIN screen shows the real name from the second launch
 * onwards.
 *
 * `salonId` is stored ALONGSIDE it, and a mismatch drops the record rather than
 * using it. A pilot phone re-enrolled from one salon to another is the exact case
 * where a stale cached name would be shown with total confidence, and the id is
 * the only thing that can catch it.
 *
 * WHAT IS STILL A FALLBACK, AND STAYS ONE
 * ======================================
 * A device that has never had a successful sign-in has no name to show, so
 * `config/brand.ts` keeps `EXPO_PUBLIC_AVO_SALON_NAME ?? 'Amara'` as the
 * PRE-ENROLMENT fallback. That is not a gap being papered over; it is the only
 * honest value available at that point, and the design's own default is the same
 * word (`P.salonName || 'Amara'`, :581).
 *
 * The clean fix is an unauthenticated salon-identity read — name, brand hex,
 * logo — for which there is precedent (`/v1/platform/policies` is
 * "unauthenticated by necessity (a signup screen renders it before there is a
 * session)"). The customer wallet needs the same endpoint for the same reason on
 * its first launch. One endpoint, two surfaces. Reported to Lane A.
 *
 * No credential is stored here. The PIN never touches storage (non-negotiable
 * #6) and neither does the token; a salon name and a public brand colour are
 * things the salon prints on its own door.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'avo.scanner.salon.v1';

/** design/api-contract.md § Salon — "brandColor  string  // hex". */
const HEX = /^#[0-9A-Fa-f]{6}$/;

export interface SalonIdentity {
  salonId: string;
  name: string;
  /** Null when the server sent something that is not a hex. Never coerced. */
  brandColor: string | null;
}

/**
 * The cached identity, or null. `expectSalonId` is the binding's salon id: pass
 * it and a record from a different salon is discarded rather than displayed.
 */
export async function readSalonIdentity(expectSalonId?: string): Promise<SalonIdentity | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as SalonIdentity).salonId !== 'string' ||
      typeof (parsed as SalonIdentity).name !== 'string'
    ) {
      return null;
    }
    const record = parsed as SalonIdentity;
    if (record.name.trim() === '') return null;
    if (expectSalonId !== undefined && record.salonId !== expectSalonId) return null;
    const hex = typeof record.brandColor === 'string' && HEX.test(record.brandColor)
      ? record.brandColor
      : null;
    return { salonId: record.salonId, name: record.name, brandColor: hex };
  } catch {
    // Unreadable storage is the same situation as an unenrolled device, which
    // the app already handles. Not worth failing to launch over.
    return null;
  }
}

/** Called on every successful salon read, so a rename or a recolour is picked up. */
export async function writeSalonIdentity(identity: SalonIdentity): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(identity));
  } catch {
    // A cache write failing must never break a screen that already has its data.
  }
}
