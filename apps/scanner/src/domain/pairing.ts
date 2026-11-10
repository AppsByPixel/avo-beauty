/**
 * Pairing a phone to one staff member — the pure half.
 *
 * DECISIONS.md § "Staff phone pairing, phone sign-in, and a truthful receipt
 * line — Aftab, 2026-11-10". The contract is trunk's, in packages/types
 * § staff pairing; nothing here restates a rule that lives there:
 *
 *   - the QR carries `${STAFF_PAIRING_URL}?t=<token>`, and a token is whatever
 *     `StaffPairingCodeSchema.shape.token` accepts;
 *   - the typed path sends a `PhoneSchema` number and `StaffPairingDigitsSchema`
 *     digits;
 *   - the PIN is `StaffPinSchema`.
 *
 * WHY A MODULE AND NOT FOUR `if`s IN THE SCREENS. The scanner's vitest config is
 * node-only — "Component and end-to-end testing is lane D's column" — so a rule
 * left inside a component is a rule no test in this package can reach. That is
 * how `ScanScreen` once shipped a launch URL as an "unreadable scan"
 * (domain/deepLink.ts). The four things the setup screens decide — is this QR a
 * pairing code, is this a mobile number, did the two PINs match, what does this
 * failure say — are here, and the screens only render the answers.
 */

import {
  PhoneSchema,
  STAFF_PAIRING_URL,
  StaffPairingCodeSchema,
  StaffPairingDigitsSchema,
  StaffPinSchema,
} from '@avo/types';
import { ApiError } from '../api/client';
import { copy } from '../copy/en';

// ----------------------------------------------------------- the QR / link --

/**
 * The pairing token in a scanned QR or an opened link, or null.
 *
 * STRICT, and silent about it. The camera on the setup screen is pointed at a
 * manager's dashboard, but it is the same camera that reads customers' wallet
 * codes, receipts and product barcodes; each of those returns null here and the
 * screen keeps looking without saying anything (the brief: "quietly ignoring
 * anything else"). A wallet code in particular — `avostaff://pay?m=…&t=…` — has
 * a `t` parameter too, which is exactly why the PATH is matched in full rather
 * than the prefix of the scheme: `avostaff://pa` is a prefix of both.
 *
 * The same function reads a deep link (`avostaff://pair?t=…` opened by the
 * system camera or a message), so there is one definition of "a pairing code"
 * whichever way it arrives.
 *
 * Hand-parsed for the reason `parsePaymentCode` gives: React Native's URL
 * polyfill does not reliably expose `searchParams` for a custom scheme.
 */
export function parsePairingLink(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  const prefix = `${STAFF_PAIRING_URL}?`;
  // Scheme and host are case-insensitive in a URI; the token is not.
  if (value.slice(0, prefix.length).toLowerCase() !== prefix) return null;

  let token: string | null = null;
  for (const pair of value.slice(prefix.length).split('&')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    let key: string;
    let val: string;
    try {
      key = decodeURIComponent(pair.slice(0, eq));
      val = decodeURIComponent(pair.slice(eq + 1));
    } catch {
      // A malformed escape is a code we cannot read, not a crash.
      return null;
    }
    if (key !== 't') continue;
    // Two tokens in one link is not a pairing code; it is a question about
    // which one to trust, and the answer is neither.
    if (token !== null) return null;
    token = val;
  }
  if (token === null || /\s/.test(token)) return null;
  return StaffPairingCodeSchema.shape.token.safeParse(token).success ? token : null;
}

// -------------------------------------------------------- the mobile number --

/**
 * A staff member's mobile number, as typed, in E.164 — or null.
 *
 * Two forms only, the two the ruling names: an 8-digit Kuwait number, read as
 * `+965` (the same reading the API gives one on `POST /staff/session`), or a
 * full international number with its `+`. Spaces, dashes, dots and brackets
 * are typing, not content, and are dropped first — the API's own `parseE164`
 * drops spaces and dashes the same way.
 *
 * Deliberately NOT accepted: `00965…`, `965…` without the plus, a leading
 * trunk `0`. Each is a guess about intent, and a wrong guess here is a
 * pairing refusal that reads exactly like a wrong code (the server answers
 * every refusal the same way, on purpose), so a typist would never find out
 * the number was the problem. Refusing the form up front, with the hint on the
 * field, is the honest version.
 */
export function normaliseStaffPhone(raw: string): string | null {
  const compact = raw.trim().replace(/[\s\-().]/g, '');
  if (/^\d{8}$/.test(compact)) return `+965${compact}`;
  if (compact.startsWith('+') && PhoneSchema.safeParse(compact).success) return compact;
  return null;
}

/** The six digits typed with the number. */
export function isPairingDigits(raw: string): boolean {
  return StaffPairingDigitsSchema.safeParse(raw).success;
}

// -------------------------------------------------------- choosing the PIN --

export const PIN_LENGTH = 4;

/**
 * Choose a PIN, then enter it again.
 *
 * The PIN screen's own rule holds here (non-negotiable #6): the digits live in
 * component state and nowhere else, are sent once, and are dropped. `first` is
 * held only until the second entry is compared with it.
 */
export interface PinChoice {
  /** The first entry, once complete. Null while choosing. */
  first: string | null;
  /** The digits on the pad now. */
  entry: string;
  /** The last confirmation did not match; cleared by the next key. */
  mismatch: boolean;
}

export const PIN_CHOICE_START: PinChoice = { first: null, entry: '', mismatch: false };

export type PinChoiceInput =
  | { type: 'digit'; digit: string }
  | { type: 'delete' }
  /** The hidden hardware-keyboard field reports its whole value, as on PinScreen. */
  | { type: 'replace'; value: string }
  | { type: 'restart' };

export function stepPinChoice(state: PinChoice, input: PinChoiceInput): PinChoice {
  switch (input.type) {
    case 'restart':
      return PIN_CHOICE_START;
    case 'delete':
      return { ...state, entry: state.entry.slice(0, -1), mismatch: false };
    case 'digit':
      if (!/^\d$/.test(input.digit) || state.entry.length >= PIN_LENGTH) return state;
      return settle(state, state.entry + input.digit);
    case 'replace':
      return settle(state, input.value.replace(/\D/g, '').slice(0, PIN_LENGTH));
  }
}

function settle(state: PinChoice, entry: string): PinChoice {
  if (entry.length < PIN_LENGTH) return { ...state, entry, mismatch: false };
  if (state.first === null) return { first: entry, entry: '', mismatch: false };
  if (entry === state.first) return { first: state.first, entry, mismatch: false };
  // Start over from the first entry, not just the second: a mismatch means one
  // of the two was mistyped and nobody can say which.
  return { first: null, entry: '', mismatch: true };
}

/** Which prompt the pad shows. */
export function pinChoiceStage(state: PinChoice): 'choose' | 'confirm' {
  return state.first === null ? 'choose' : 'confirm';
}

/** The PIN to send, once both entries agree — and only then. */
export function chosenPin(state: PinChoice): string | null {
  if (state.first === null || state.entry !== state.first) return null;
  return StaffPinSchema.safeParse(state.entry).success ? state.entry : null;
}

// ------------------------------------------------------------ the failures --

/**
 * What a failed `POST /staff/pair` says, and where it leaves her.
 *
 * THE SERVER ANSWERS EVERY REFUSAL THE SAME WAY — unknown, used, expired or
 * voided token, wrong digits, unknown phone, deactivated staff: one status, one
 * body, `pairing_refused`. So this screen has one sentence for all of them and
 * does not try to be more helpful than the server chose to be (the same stance
 * PinScreen takes on `invalid_credentials`).
 *
 *   refused    `pairing_refused`. The code is dead or was never right — back to
 *              setup, because no PIN will make it work.
 *   throttled  any 429. The existing too-many-attempts copy, and back to setup:
 *              the budget is per IP and per phone, so retrying from the PIN pad
 *              would only spend more of it.
 *   badPin     `invalid_pin_format`. Cannot happen from this pad, which only
 *              produces four digits; the server's sentence is shown if it does.
 *   offline    no connection, or a 503/504 (api/client.ts `classify`). The
 *              PIN screen's offline handling: "No connection", and she stays on
 *              the pad with her code intact to try again.
 *   server     anything else, with the request reference. A 4xx that is not
 *              one of the above lands here too, deliberately — a 404 from an
 *              API without the route would otherwise read "That code didn't
 *              work" and send her to a manager for a code that was fine.
 */
export type PairingRefusal =
  | { kind: 'refused'; message: string }
  | { kind: 'throttled'; title: string; message: string }
  | { kind: 'badPin'; message: string }
  | { kind: 'offline'; message: string }
  | { kind: 'server'; message: string; reference: string | null };

export function pairingRefusal(err: unknown): PairingRefusal {
  if (!(err instanceof ApiError)) {
    return { kind: 'server', message: copy.errorTitle, reference: null };
  }
  if (err.code === 'pairing_refused') return { kind: 'refused', message: copy.pairingRefused };
  if (err.status === 429) {
    return { kind: 'throttled', title: copy.pinTooManyTitle, message: copy.pinTooMany };
  }
  if (err.kind === 'offline') return { kind: 'offline', message: copy.offlineTitle };
  if (err.code === 'invalid_pin_format') return { kind: 'badPin', message: err.message };
  return { kind: 'server', message: err.message, reference: err.reference };
}

/** The two refusals no PIN can fix. */
export type EndedPairing = Extract<PairingRefusal, { kind: 'refused' | 'throttled' }>;

/** A refusal no PIN can fix sends her back to the setup screen. */
export function refusalEndsPairing(refusal: PairingRefusal): refusal is EndedPairing {
  return refusal.kind === 'refused' || refusal.kind === 'throttled';
}
