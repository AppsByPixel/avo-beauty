/**
 * Staff phone pairing — the pure parts. Aftab, 2026-11-10 (DECISIONS.md § Staff
 * phone pairing, phone sign-in, and a truthful receipt line).
 *
 * The routes themselves are proved against real rows in
 * `staffPairing.int.test.ts`. What lives here is what can be wrong without a
 * database: what counts as a staff member's mobile number, the shape of the
 * secrets a pairing code hands out, and the rate-limit key derivation that keeps
 * a phone number out of the counter table.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  STAFF_PAIRING_URL,
  StaffPairingCodeSchema,
  StaffPairingDigitsSchema,
} from '@avo/types';
import { ApiError } from '../http/errors';
import { E164, normaliseStaffPhone, parseStaffPhone } from '../http/fields';
import {
  hashPairingToken,
  mintPairedDeviceId,
  mintPairingDigits,
  mintPairingToken,
} from '../auth/tokens';
import { pairIdentityKey } from '../services/pairLimit';
import { signInIdentityKey } from '../services/signInLimit';

describe('a staff mobile number', () => {
  it('reads eight digits as a Kuwait number', () => {
    expect(normaliseStaffPhone('99124408')).toBe('+96599124408');
    expect(parseStaffPhone('99124408')).toBe('+96599124408');
  });

  it('accepts E.164 with the spaces and dashes a person types', () => {
    expect(normaliseStaffPhone('+965 9912 4408')).toBe('+96599124408');
    expect(normaliseStaffPhone('+965-9912-4408')).toBe('+96599124408');
    expect(normaliseStaffPhone('9912 4408')).toBe('+96599124408');
    expect(normaliseStaffPhone('+447700900123')).toBe('+447700900123');
  });

  it('does not guess a country for a longer number without a plus', () => {
    // "which country did you mean" is not a question a parser answers silently.
    expect(normaliseStaffPhone('96599124408')).toBeNull();
    expect(normaliseStaffPhone('9912440')).toBeNull();
    expect(normaliseStaffPhone('991244080')).toBeNull();
  });

  it('is never a handle', () => {
    for (const handle of ['noura', 'hessa.m', 'ST-001', 'a_b', '']) {
      expect(normaliseStaffPhone(handle)).toBeNull();
    }
    expect(normaliseStaffPhone(undefined)).toBeNull();
    expect(normaliseStaffPhone(99124408)).toBeNull();
  });

  it('only ever produces what staff_user_phone_is_e164 accepts', () => {
    for (const v of ['99124408', '+965 5000 0001', '+12025550123']) {
      const out = normaliseStaffPhone(v);
      expect(out).not.toBeNull();
      expect(E164.test(out!)).toBe(true);
    }
  });

  it('refuses a malformed number at the write door with invalid_phone', () => {
    let err: unknown;
    try {
      parseStaffPhone('call me');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).statusCode).toBe(400);
    expect((err as ApiError).code).toBe('invalid_phone');
  });
});

describe('the secrets a pairing code hands out', () => {
  it('mints a token the contract accepts and the QR can carry unescaped', () => {
    const token = mintPairingToken();
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(token).toMatch(/^pair_[A-Za-z0-9_-]+$/);
    const url = `${STAFF_PAIRING_URL}?t=${token}`;
    expect(new URL(url).searchParams.get('t')).toBe(token);
  });

  it('mints six digits, keeping leading zeros, across the whole range', () => {
    const seen = new Set<string>();
    let leadingZero = false;
    for (let i = 0; i < 2000; i++) {
      const d = mintPairingDigits();
      expect(StaffPairingDigitsSchema.safeParse(d).success).toBe(true);
      if (d.startsWith('0')) leadingZero = true;
      seen.add(d);
    }
    // 2000 draws from a million: a repeat-heavy generator would show here.
    expect(seen.size).toBeGreaterThan(1990);
    // P(no leading zero in 2000 draws) = 0.9^2000 — effectively never.
    expect(leadingZero).toBe(true);
  });

  it('stores the token as a sha256 hex the migration CHECK accepts', () => {
    const token = mintPairingToken();
    const h = hashPairingToken(token);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(createHash('sha256').update(token).digest('hex'));
    expect(h).not.toContain(token);
  });

  it('issues distinct, unguessable device ids', () => {
    const a = mintPairedDeviceId();
    const b = mintPairedDeviceId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^PH-[A-Za-z0-9_-]{22}$/);
  });

  it('round-trips the issue response through the shared schema', () => {
    const body = {
      staffId: 'ST-001',
      token: mintPairingToken(),
      code: mintPairingDigits(),
      expiresAt: new Date().toISOString(),
      branchId: null,
    };
    expect(StaffPairingCodeSchema.safeParse(body).success).toBe(true);
  });
});

describe('the redeem budget keys', () => {
  it('never contains the phone number', () => {
    const key = pairIdentityKey('phone', '+96599124408');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain('99124408');
  });

  it('separates the address tier from the phone tier', () => {
    expect(pairIdentityKey('ip', '10.0.0.1')).not.toBe(pairIdentityKey('phone', '10.0.0.1'));
  });

  it('cannot collide with a password sign-in bucket for the same string', () => {
    const phone = '+96599124408';
    expect(pairIdentityKey('phone', phone)).not.toBe(signInIdentityKey('web', null, phone));
    expect(pairIdentityKey('phone', phone)).not.toBe(signInIdentityKey('member', null, phone));
  });
});
