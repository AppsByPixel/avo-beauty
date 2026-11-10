/**
 * The four decisions the setup screens delegate to `./pairing`:
 * is this a pairing code, is this a mobile number, did the two PINs match,
 * and what does this failure say.
 *
 * DECISIONS.md § "Staff phone pairing, phone sign-in, and a truthful receipt
 * line — Aftab, 2026-11-10"; contract in packages/types § staff pairing.
 */

import { describe, expect, it } from 'vitest';
import { STAFF_PAIRING_URL, StaffPairRequestSchema, walletTokenUri } from '@avo/types';
import { ApiError } from '../api/client';
import { copy } from '../copy/en';
import { parsePaymentCode } from './paymentCode';
import {
  PIN_CHOICE_START,
  chosenPin,
  isPairingDigits,
  normaliseStaffPhone,
  pairingRefusal,
  parsePairingLink,
  pinChoiceStage,
  refusalEndsPairing,
  stepPinChoice,
  type PinChoice,
  type PinChoiceInput,
} from './pairing';

/** 43 characters — the shape of a 32-byte base64url token. */
const TOKEN = 'pX3v9Qk2LmN8rT5wYz1aB4cD6eF7gH0iJ-kL_mNoPqR';

// ------------------------------------------------------------------- QR ---

describe('a pairing code, scanned or opened', () => {
  it('is read from the exact payload the contract names', () => {
    expect(STAFF_PAIRING_URL).toBe('avostaff://pair');
    expect(parsePairingLink(`${STAFF_PAIRING_URL}?t=${TOKEN}`)).toBe(TOKEN);
  });

  it('survives the forms a camera or the OS hands over', () => {
    expect(parsePairingLink(`  ${STAFF_PAIRING_URL}?t=${TOKEN}\n`)).toBe(TOKEN);
    // Scheme and host are case-insensitive in a URI; the token is not.
    expect(parsePairingLink(`AVOSTAFF://PAIR?t=${TOKEN}`)).toBe(TOKEN);
    expect(parsePairingLink(`${STAFF_PAIRING_URL}?t=${encodeURIComponent(TOKEN)}`)).toBe(TOKEN);
    // An unrelated parameter is not a reason to refuse a valid token.
    expect(parsePairingLink(`${STAFF_PAIRING_URL}?v=1&t=${TOKEN}`)).toBe(TOKEN);
  });

  it('hands over a token the pair request will accept', () => {
    const token = parsePairingLink(`${STAFF_PAIRING_URL}?t=${TOKEN}`);
    expect(token).not.toBeNull();
    expect(StaffPairRequestSchema.safeParse({ token, pin: '4826' }).success).toBe(true);
  });
});

describe('anything else in front of the camera', () => {
  /**
   * THE ONE THAT MATTERS. A customer's wallet code is the QR this camera sees
   * most, it is our scheme, and it carries a `t` parameter too. It must never
   * be taken for a pairing token.
   */
  it("ignores a customer's wallet code", () => {
    const wallet = walletTokenUri('8842', 'wt_9f2c41aa0b7e4d3c8f1e2a9b6c5d4e3f2a1b0c9d');
    expect(parsePaymentCode(wallet)).not.toBeNull(); // it really is a wallet code
    expect(parsePairingLink(wallet)).toBeNull();
    expect(parsePairingLink(`avostaff://pay?m=8842&t=${TOKEN}`)).toBeNull();
  });

  it('ignores every other shape, silently (null, never a throw)', () => {
    const notCodes: (string | null | undefined)[] = [
      null,
      undefined,
      '',
      '   ',
      'exp://127.0.0.1:8199',
      'https://avorewards.com/staff/pair?t=' + TOKEN,
      'avostaff://pair', // our path, no credential
      'avostaff://pair?', // still none
      `avostaff://pair?token=${TOKEN}`, // not the contract's parameter
      `avostaff://pairing?t=${TOKEN}`, // a longer path is not this path
      `avostaff://pair/x?t=${TOKEN}`,
      `avo://pair?t=${TOKEN}`, // the customer app's scheme
      'avostaff://pair?t=short', // under the contract's 32-character floor
      `avostaff://pair?t=${TOKEN.slice(0, 31)}`,
      `avostaff://pair?t=${TOKEN}%20x`, // whitespace inside a token
      `avostaff://pair?t=${TOKEN}&t=${TOKEN}`, // two tokens: trust neither
      'avostaff://pair?t=%E0%A4%A', // a malformed escape
      '0123456789012', // a product barcode
    ];
    for (const raw of notCodes) {
      expect(parsePairingLink(raw), String(raw)).toBeNull();
    }
  });

  it('keeps the 32-character floor in step with the contract, not a local number', () => {
    const at = (n: number) => parsePairingLink(`${STAFF_PAIRING_URL}?t=${'a'.repeat(n)}`);
    expect(at(31)).toBeNull();
    expect(at(32)).toBe('a'.repeat(32));
  });
});

// --------------------------------------------------------------- phone ---

describe('the mobile number', () => {
  it('reads an 8-digit number as Kuwait', () => {
    expect(normaliseStaffPhone('99124408')).toBe('+96599124408');
    expect(normaliseStaffPhone('5512 3456')).toBe('+96555123456');
    expect(normaliseStaffPhone(' 6555-0101 ')).toBe('+96565550101');
  });

  it('takes a full international number as it is, minus the typing', () => {
    expect(normaliseStaffPhone('+96599124408')).toBe('+96599124408');
    expect(normaliseStaffPhone('+965 9912 4408')).toBe('+96599124408');
    expect(normaliseStaffPhone('+44 (7700) 900-123')).toBe('+447700900123');
    expect(normaliseStaffPhone('+971.50.123.4567')).toBe('+971501234567');
  });

  it('refuses a form it would have to guess at', () => {
    for (const raw of [
      '',
      '   ',
      '9912440', // seven digits
      '991244081', // nine
      '96599124408', // country code without its plus
      '0096599124408', // international prefix instead of +
      '+0965991244', // E.164 never starts with 0
      '+96599124408123456', // longer than E.164 allows
      '+', // a plus alone
      '9912440a',
      '++96599124408',
    ]) {
      expect(normaliseStaffPhone(raw), raw).toBeNull();
    }
  });

  it('only ever produces what the contract accepts', () => {
    for (const raw of ['99124408', '+96599124408', '+44 7700 900123']) {
      const phone = normaliseStaffPhone(raw);
      expect(
        StaffPairRequestSchema.safeParse({ phone, code: '123456', pin: '4826' }).success,
        raw,
      ).toBe(true);
    }
  });
});

describe('the six digits', () => {
  it('are exactly six digits', () => {
    expect(isPairingDigits('048213')).toBe(true);
    for (const raw of ['', '04821', '0482139', '04821a', ' 048213', '048 213']) {
      expect(isPairingDigits(raw), raw).toBe(false);
    }
  });
});

// ------------------------------------------------------------------ PIN ---

function run(inputs: PinChoiceInput[], from: PinChoice = PIN_CHOICE_START): PinChoice {
  return inputs.reduce(stepPinChoice, from);
}
const digits = (s: string): PinChoiceInput[] => [...s].map((digit) => ({ type: 'digit', digit }));

describe('choosing a PIN twice', () => {
  it('asks for the PIN, then for it again', () => {
    expect(pinChoiceStage(PIN_CHOICE_START)).toBe('choose');
    const half = run(digits('4826'));
    expect(half).toEqual({ first: '4826', entry: '', mismatch: false });
    expect(pinChoiceStage(half)).toBe('confirm');
    expect(chosenPin(half)).toBeNull();
  });

  it('yields the PIN only when the second entry matches the first', () => {
    const done = run(digits('48264826'));
    expect(chosenPin(done)).toBe('4826');
    expect(done.mismatch).toBe(false);
  });

  it('never yields a PIN part-way through the second entry', () => {
    for (let n = 0; n < 4; n += 1) {
      expect(chosenPin(run(digits('4826' + '4826'.slice(0, n))))).toBeNull();
    }
  });

  it('on a mismatch, says so and starts again from the first entry', () => {
    const wrong = run(digits('48264827'));
    expect(wrong).toEqual({ first: null, entry: '', mismatch: true });
    expect(pinChoiceStage(wrong)).toBe('choose');
    expect(chosenPin(wrong)).toBeNull();
  });

  it('clears the mismatch message on the next key, and still works after it', () => {
    const wrong = run(digits('48264827'));
    expect(run(digits('1'), wrong).mismatch).toBe(false);
    expect(run([{ type: 'delete' }], wrong).mismatch).toBe(false);
    expect(chosenPin(run(digits('11221122'), wrong))).toBe('1122');
  });

  it('deletes within the current entry only', () => {
    const s = run([...digits('48'), { type: 'delete' }, ...digits('9')]);
    expect(s.entry).toBe('49');
    // Delete on the confirm stage never reaches back into the first entry.
    const confirm = run([...digits('4826'), { type: 'delete' }, { type: 'delete' }]);
    expect(confirm).toEqual({ first: '4826', entry: '', mismatch: false });
  });

  it('ignores anything that is not one digit, and a fifth digit', () => {
    const s = run([
      { type: 'digit', digit: 'a' },
      { type: 'digit', digit: '12' },
      { type: 'digit', digit: '' },
      ...digits('482'),
    ]);
    expect(s.entry).toBe('482');
    const full = run(digits('48264826'));
    expect(run(digits('9'), full)).toBe(full);
  });

  it('takes the hardware keyboard field whole, as the PIN screen does', () => {
    const s = run([{ type: 'replace', value: '48a2' }]);
    expect(s.entry).toBe('482');
    const done = run([
      { type: 'replace', value: '4826' },
      { type: 'replace', value: '48269' }, // a fifth key is cut, not appended
    ]);
    expect(chosenPin(done)).toBe('4826');
  });

  it('restarts to nothing held', () => {
    expect(run([...digits('4826'), { type: 'restart' }])).toEqual(PIN_CHOICE_START);
  });

  it('only ever yields what the contract accepts as a PIN', () => {
    const pin = chosenPin(run(digits('00000000')));
    expect(pin).toBe('0000');
    expect(StaffPairRequestSchema.safeParse({ token: 'a'.repeat(32), pin }).success).toBe(true);
  });
});

// ------------------------------------------------------------- failures ---

const apiError = (init: ConstructorParameters<typeof ApiError>[0]) => new ApiError(init);

describe('what a refused pairing says', () => {
  /**
   * The fixed body every lane builds against. The server's own message reads
   * "did not"; the scanner says the brief's sentence, client-held.
   */
  it('one sentence for every refusal, and it ends the attempt', () => {
    const r = pairingRefusal(
      apiError({
        kind: 'refused',
        status: 400,
        code: 'pairing_refused',
        message: 'That code did not work. Ask a manager for a new one.',
        reference: 'SCN-1000-2000',
      }),
    );
    expect(r).toEqual({ kind: 'refused', message: "That code didn't work. Ask a manager for a new one." });
    expect(r.message).toBe(copy.pairingRefused);
    expect(refusalEndsPairing(r)).toBe(true);
  });

  it('a 429 reuses the existing too-many-attempts copy, and ends the attempt', () => {
    const r = pairingRefusal(
      apiError({
        kind: 'refused',
        status: 429,
        code: 'too_many_attempts',
        message: 'Slow down.',
        reference: 'SCN-1000-2001',
      }),
    );
    expect(r).toEqual({ kind: 'throttled', title: copy.pinTooManyTitle, message: copy.pinTooMany });
    expect(refusalEndsPairing(r)).toBe(true);
  });

  it('no connection is the PIN screen’s offline handling, and keeps her on the pad', () => {
    const r = pairingRefusal(apiError({ kind: 'offline', message: 'No connection.', reference: 'SCN-1-2' }));
    expect(r).toEqual({ kind: 'offline', message: copy.offlineTitle });
    expect(refusalEndsPairing(r)).toBe(false);
    // A 503/504 classifies as offline too (api/client.ts), and must not be
    // mistaken for a dead code.
    const gateway = pairingRefusal(
      apiError({ kind: 'offline', status: 504, message: 'Gateway timeout', reference: 'SCN-1-3' }),
    );
    expect(gateway.kind).toBe('offline');
  });

  it('a bad PIN format shows the server’s sentence and keeps her on the pad', () => {
    const r = pairingRefusal(
      apiError({
        kind: 'refused',
        status: 400,
        code: 'invalid_pin_format',
        message: 'A PIN is four digits.',
        reference: 'SCN-1-4',
      }),
    );
    expect(r).toEqual({ kind: 'badPin', message: 'A PIN is four digits.' });
    expect(refusalEndsPairing(r)).toBe(false);
  });

  /**
   * NOT "That code didn't work". An API without the route answers 404, and a
   * 500 is ours: both would send her to a manager for a new code that was
   * fine. They get the server's sentence and the reference instead.
   */
  it('anything else is a server failure with its reference, never a dead code', () => {
    for (const [status, kind] of [
      [404, 'refused'],
      [400, 'refused'],
      [500, 'server'],
    ] as const) {
      const r = pairingRefusal(
        apiError({ kind, status, code: 'not_found', message: 'Not found.', reference: 'SCN-5502-9917' }),
      );
      expect(r, String(status)).toEqual({ kind: 'server', message: 'Not found.', reference: 'SCN-5502-9917' });
      expect(refusalEndsPairing(r)).toBe(false);
    }
  });

  it('a failure that is not an API error does not pretend to have a reference', () => {
    expect(pairingRefusal(new Error('storage'))).toEqual({
      kind: 'server',
      message: copy.errorTitle,
      reference: null,
    });
  });

  it('every sentence it can return exists in the dictionary', () => {
    for (const s of [copy.pairingRefused, copy.pinTooMany, copy.pinTooManyTitle, copy.offlineTitle, copy.errorTitle]) {
      expect(typeof s === 'string' && s.trim() !== '').toBe(true);
    }
  });
});
